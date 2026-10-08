//! Native project persistence, trusted motion/slide rendering and local speech generation.
//! Existing editor fields are retained even when the native slide renderer does
//! not interpret their animation/layout metadata.
use crate::motion::{LayerGeometry, LayerRole, MotionSpec};
use fontdue::{Font, FontSettings};
use futures_util::StreamExt;
use serde_json::{json, Value};
use std::{
    fs,
    io::Write,
    path::{Component, Path, PathBuf},
    process::Stdio,
    sync::Mutex,
    time::Duration,
};
use tokio::{io::AsyncReadExt, process::Command};
use uuid::Uuid;

const STORE_LIMIT: u64 = 16 * 1024 * 1024;
const AUDIO_LIMIT: usize = 32 * 1024 * 1024;
const TTS_BASE: &str = "http://127.0.0.1:50010";
static PROJECT_LOCK: Mutex<()> = Mutex::new(());
static RENDER_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
static VOICE_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// One native video job at a time. Research generation shares the renderer's
/// gate so it cannot silently race another job in the editor.
pub(crate) fn lock_for_video_activity() -> Result<tokio::sync::MutexGuard<'static, ()>, String> {
    RENDER_LOCK
        .try_lock()
        .map_err(|_| "다른 영상 작업을 마친 뒤 다시 실행하세요.".into())
}

fn data_dir() -> Result<PathBuf, String> {
    crate::config::config_path()
        .parent()
        .map(Path::to_path_buf)
        .ok_or_else(|| "프로젝트 저장 경로를 확인하세요.".into())
}

fn public_dir() -> Result<PathBuf, String> {
    Ok(data_dir()?.join("media"))
}

fn read_store_at(path: &Path) -> Result<Value, String> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(json!({"projects": []}));
        }
        Err(_) => return Err("프로젝트 파일을 읽을 수 없습니다.".into()),
    };
    if !metadata.is_file() || metadata.len() > STORE_LIMIT {
        return Err("프로젝트 파일 형식 또는 크기를 확인하세요.".into());
    }
    let bytes = fs::read(path).map_err(|_| "프로젝트 파일을 읽을 수 없습니다.")?;
    let store: Value = serde_json::from_slice(&bytes)
        .map_err(|_| "프로젝트 JSON이 손상되었습니다. 원본 파일을 확인하세요.")?;
    if !store.is_object() || !store.get("projects").is_some_and(Value::is_array) {
        return Err("프로젝트 JSON의 projects 배열을 확인하세요.".into());
    }
    Ok(store)
}

fn write_private(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let directory = path.parent().ok_or("저장 경로 오류")?;
    fs::create_dir_all(directory).map_err(|_| "저장 폴더를 만들 수 없습니다.")?;
    if fs::symlink_metadata(path).is_ok_and(|metadata| metadata.file_type().is_symlink()) {
        return Err("심볼릭 링크에는 저장할 수 없습니다.".into());
    }
    let mut temporary = tempfile::NamedTempFile::new_in(directory)
        .map_err(|_| "임시 저장 파일을 만들 수 없습니다.")?;
    temporary
        .write_all(bytes)
        .and_then(|_| temporary.as_file().sync_all())
        .map_err(|_| "파일을 저장할 수 없습니다.")?;
    temporary
        .persist(path)
        .map_err(|_| "파일을 저장할 수 없습니다.")?;
    Ok(())
}

pub fn list_projects() -> Result<Value, String> {
    let _guard = PROJECT_LOCK
        .lock()
        .map_err(|_| "프로젝트 저장소가 사용 중입니다.")?;
    let store = read_store_at(&data_dir()?.join("projects.json"))?;
    let mut projects = store["projects"]
        .as_array()
        .ok_or("프로젝트 형식 오류")?
        .clone();
    projects.sort_by(|a, b| {
        b.get("updatedAt")
            .and_then(Value::as_str)
            .unwrap_or("")
            .cmp(a.get("updatedAt").and_then(Value::as_str).unwrap_or(""))
    });
    Ok(Value::Array(projects))
}

fn valid_part(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
}

fn text_field<'a>(value: &'a Value, key: &str, max: usize) -> Result<&'a str, String> {
    let text = value
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| format!("{key} 문자열을 확인하세요."))?;
    if text.chars().count() > max
        || text
            .chars()
            .any(|c| c.is_control() && c != '\n' && c != '\t')
    {
        return Err(format!("{key} 길이 또는 문자를 확인하세요."));
    }
    Ok(text)
}

fn enum_field(value: &Value, key: &str, allowed: &[&str]) -> Result<(), String> {
    if value
        .get(key)
        .and_then(Value::as_str)
        .is_some_and(|s| allowed.contains(&s))
    {
        Ok(())
    } else {
        Err(format!("{key} 값을 확인하세요."))
    }
}

/// Parse virtual public/media references without allowing URL schemes, encoded
/// traversal, platform-specific drive paths, or symlink escapes.
fn relative_asset(reference: &str) -> Result<&Path, String> {
    if reference.is_empty()
        || reference.len() > 2048
        || reference.contains(['\\', ':', '%', '?', '#'])
        || reference.chars().any(char::is_control)
        || reference.starts_with("//")
    {
        return Err("미디어는 public 폴더 안의 로컬 경로만 사용할 수 있습니다.".into());
    }
    let relative = Path::new(reference.trim_start_matches('/'));
    if relative
        .components()
        .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err("미디어 경로에 상위 폴더 이동을 사용할 수 없습니다.".into());
    }
    if relative.as_os_str().is_empty() {
        return Err("미디어 파일 경로가 비어 있습니다.".into());
    }
    Ok(relative)
}

fn resolve_asset_at(base: &Path, reference: &str) -> Result<PathBuf, String> {
    let relative = relative_asset(reference)?;
    let base = base
        .canonicalize()
        .map_err(|_| "로컬 미디어 폴더가 없습니다.")?;
    let resolved = base
        .join(relative)
        .canonicalize()
        .map_err(|_| "프로젝트의 로컬 미디어 파일이 없습니다.")?;
    if !resolved.starts_with(&base) || !resolved.is_file() {
        return Err("미디어 파일은 로컬 public 폴더 안에 있어야 합니다.".into());
    }
    if fs::metadata(&resolved)
        .map_err(|_| "미디어 파일을 읽을 수 없습니다.")?
        .len()
        > 2 * 1024 * 1024 * 1024
    {
        return Err("미디어 파일은 2GB 이하만 사용할 수 있습니다.".into());
    }
    Ok(resolved)
}

fn validate_project(project: &Value) -> Result<(), String> {
    if !project.is_object()
        || serde_json::to_vec(project)
            .map_err(|_| "프로젝트 형식 오류")?
            .len()
            > 2 * 1024 * 1024
    {
        return Err("프로젝트 형식 또는 크기를 확인하세요.".into());
    }
    if let Some(id) = project.get("id") {
        Uuid::parse_str(id.as_str().ok_or("프로젝트 ID 형식 오류")?)
            .map_err(|_| "프로젝트 UUID를 확인하세요.")?;
    }
    if text_field(project, "title", 300)?.trim().is_empty() {
        return Err("프로젝트 제목을 입력하세요.".into());
    }
    enum_field(
        project,
        "format",
        &["youtube-landscape", "vertical", "shorts"],
    )?;
    enum_field(
        project,
        "template",
        &["reference-briefing", "adaptive-promo"],
    )?;
    enum_field(project, "language", &["ko", "ja", "zh", "en"])?;
    let scenes = project
        .get("scenes")
        .and_then(Value::as_array)
        .ok_or("장면 목록을 확인하세요.")?;
    if scenes.is_empty() || scenes.len() > 120 {
        return Err("장면은 1~120개여야 합니다.".into());
    }
    let mut ids = std::collections::HashSet::new();
    let mut total = 0.0;
    for scene in scenes {
        let id = text_field(scene, "id", 128)?;
        if !valid_part(id) || !ids.insert(id) {
            return Err("장면 ID는 중복 없는 영문, 숫자, - 또는 _여야 합니다.".into());
        }
        for field in ["headline", "body", "narration"] {
            text_field(scene, field, 10000)?;
        }
        MotionSpec::from_scene(scene)?;
        let duration = scene
            .get("durationSec")
            .and_then(Value::as_f64)
            .ok_or("장면 길이를 확인하세요.")?;
        if !duration.is_finite() || duration <= 0.0 || duration > 600.0 {
            return Err("장면 길이는 0초 초과, 600초 이하여야 합니다.".into());
        }
        total += duration;
        if let Some(reference) = scene.get("audioPath") {
            let reference = reference.as_str().ok_or("음성 파일 경로를 확인하세요.")?;
            if !reference.is_empty() {
                relative_asset(reference)?;
            }
        }
        if scene.get("mediaType").is_some() {
            enum_field(scene, "mediaType", &["none", "image", "video", "screen"])?;
        }
    }
    if total > 7200.0 {
        return Err("프로젝트 전체 길이는 2시간 이하여야 합니다.".into());
    }
    Ok(())
}

fn save_project_at(path: &Path, mut project: Value) -> Result<Value, String> {
    validate_project(&project)?;
    let mut store = read_store_at(path)?;
    let projects = store["projects"]
        .as_array_mut()
        .ok_or("프로젝트 목록 형식 오류")?;
    let id = project
        .get("id")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .unwrap_or_else(|| Uuid::new_v4().to_string());
    let previous = projects
        .iter()
        .position(|item| item.get("id").and_then(Value::as_str) == Some(&id));
    // Retain legacy/unknown fields when an editor only submits supported fields.
    if let Some(index) = previous {
        let mut merged = projects[index].clone();
        if let (Some(old), Some(new)) = (merged.as_object_mut(), project.as_object()) {
            old.extend(new.clone());
            project = merged;
        }
    }
    let now = chrono::Utc::now().to_rfc3339();
    let created = previous
        .and_then(|index| projects[index].get("createdAt").and_then(Value::as_str))
        .map(str::to_owned)
        .or_else(|| {
            project
                .get("createdAt")
                .and_then(Value::as_str)
                .map(str::to_owned)
        })
        .unwrap_or_else(|| now.clone());
    project["id"] = json!(id);
    project["createdAt"] = json!(created);
    project["updatedAt"] = json!(now);
    if let Some(index) = previous {
        projects[index] = project.clone();
    } else {
        projects.push(project.clone());
    }
    let bytes = serde_json::to_vec_pretty(&store).map_err(|_| "프로젝트 직렬화 오류")?;
    if bytes.len() as u64 > STORE_LIMIT {
        return Err("프로젝트 저장소가 16MB를 초과했습니다.".into());
    }
    write_private(path, &bytes)?;
    Ok(project)
}

pub fn save_project(input: Value) -> Result<Value, String> {
    let _guard = PROJECT_LOCK
        .lock()
        .map_err(|_| "프로젝트 저장소가 사용 중입니다.")?;
    save_project_at(&data_dir()?.join("projects.json"), input)
}

fn font_path() -> Option<PathBuf> {
    #[cfg(target_os = "macos")]
    let candidates = ["/System/Library/Fonts/AppleSDGothicNeo.ttc"];
    #[cfg(target_os = "windows")]
    let candidates = ["C:\\Windows\\Fonts\\malgun.ttf"];
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let candidates = [
        "/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc",
        "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
    ];
    candidates
        .iter()
        .map(PathBuf::from)
        .find(|path| path.is_file())
}

fn load_font() -> Result<Font, String> {
    let path = font_path().ok_or("OS 글꼴이 없습니다. 한국어 시스템 글꼴을 설치하세요.")?;
    Font::from_bytes(
        fs::read(path).map_err(|_| "OS 글꼴을 읽을 수 없습니다.")?,
        FontSettings::default(),
    )
    .map_err(|_| "OS 글꼴을 해석할 수 없습니다.".into())
}

fn wrap_text(font: &Font, text: &str, size: f32, width: f32) -> Vec<String> {
    let mut lines = Vec::new();
    let mut line = String::new();
    let mut advance = 0.0;
    for character in text.chars() {
        if character == '\n' {
            lines.push(std::mem::take(&mut line));
            advance = 0.0;
            continue;
        }
        let character = if character == '\t' { ' ' } else { character };
        let next = font.metrics(character, size).advance_width;
        if advance + next > width && !line.is_empty() {
            lines.push(std::mem::take(&mut line));
            advance = 0.0;
        }
        line.push(character);
        advance += next;
    }
    if !line.is_empty() {
        lines.push(line);
    }
    lines
}

fn fitting_text(
    font: &Font,
    text: &str,
    width: f32,
    height: f32,
    preferred: u32,
    minimum: u32,
) -> Result<(Vec<String>, f32), String> {
    for size in (minimum..=preferred).rev() {
        let lines = wrap_text(font, text, size as f32, width);
        if lines.len() as f32 * size as f32 * 1.45 <= height {
            return Ok((lines, size as f32));
        }
    }
    Err("장면 제목/본문이 슬라이드 영역을 초과합니다. 텍스트를 여러 장면으로 나누세요.".into())
}

struct Canvas {
    width: u32,
    height: u32,
    pixels: Vec<u8>,
}
impl Canvas {
    fn new(width: u32, height: u32) -> Self {
        let mut pixels = Vec::with_capacity((width * height * 4) as usize);
        for _ in 0..width * height {
            pixels.extend_from_slice(&[15, 23, 42, 255]);
        }
        Self {
            width,
            height,
            pixels,
        }
    }
    fn transparent(width: u32, height: u32) -> Self {
        Self {
            width,
            height,
            pixels: vec![0; (width * height * 4) as usize],
        }
    }
    fn blend(&mut self, x: u32, y: u32, color: [u8; 3], alpha: u32) {
        let offset = ((y * self.width + x) * 4) as usize;
        let previous_alpha = self.pixels[offset + 3] as u32;
        let remaining = previous_alpha * (255 - alpha) / 255;
        let combined = alpha + remaining;
        if combined == 0 {
            return;
        }
        for (channel, foreground) in color.iter().enumerate() {
            self.pixels[offset + channel] = ((*foreground as u32 * alpha
                + self.pixels[offset + channel] as u32 * remaining)
                / combined) as u8;
        }
        self.pixels[offset + 3] = combined as u8;
    }
    fn rounded_card(&mut self, radius: u32, color: [u8; 3], alpha: u32) {
        let radius = radius.min(self.width / 2).min(self.height / 2) as i32;
        for y in 0..self.height {
            for x in 0..self.width {
                let dx = (radius - x as i32)
                    .max(0)
                    .max(x as i32 - (self.width as i32 - 1 - radius));
                let dy = (radius - y as i32)
                    .max(0)
                    .max(y as i32 - (self.height as i32 - 1 - radius));
                if dx * dx + dy * dy <= radius * radius {
                    self.blend(x, y, color, alpha);
                }
            }
        }
    }
    fn motion_background(&mut self) {
        for y in 0..self.height {
            for x in 0..self.width {
                let dx = x as f64 / self.width as f64;
                let dy = y as f64 / self.height as f64;
                let glow = (1.0 - ((dx - 0.88).powi(2) + (dy - 0.08).powi(2)) * 1.9).max(0.0);
                let offset = ((y * self.width + x) * 4) as usize;
                self.pixels[offset] = (9.0 + 13.0 * glow) as u8;
                self.pixels[offset + 1] = (16.0 + 17.0 * glow) as u8;
                self.pixels[offset + 2] = (27.0 + 33.0 * glow) as u8;
            }
        }
    }
    fn text(&mut self, font: &Font, lines: &[String], size: f32, x: f32, y: f32, color: [u8; 3]) {
        let ascent = font
            .horizontal_line_metrics(size)
            .map(|metrics| metrics.ascent)
            .unwrap_or(size);
        for (row, line) in lines.iter().enumerate() {
            let baseline = y + ascent + row as f32 * size * 1.45;
            let mut pen = x;
            for character in line.chars() {
                let (metrics, bitmap) = font.rasterize(character, size);
                let left = pen as i32 + metrics.xmin;
                let top = baseline as i32 - metrics.height as i32 - metrics.ymin;
                for py in 0..metrics.height {
                    for px in 0..metrics.width {
                        let target_x = left + px as i32;
                        let target_y = top + py as i32;
                        if target_x < 0
                            || target_y < 0
                            || target_x >= self.width as i32
                            || target_y >= self.height as i32
                        {
                            continue;
                        }
                        let alpha = bitmap[py * metrics.width + px] as u32;
                        self.blend(target_x as u32, target_y as u32, color, alpha);
                    }
                }
                pen += metrics.advance_width;
            }
        }
    }
    fn save(&self, path: &Path) -> Result<(), String> {
        let file = fs::File::create(path).map_err(|_| "슬라이드 이미지를 만들 수 없습니다.")?;
        let mut encoder = png::Encoder::new(file, self.width, self.height);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder
            .write_header()
            .map_err(|_| "슬라이드 PNG 형식 오류")?;
        writer
            .write_image_data(&self.pixels)
            .map_err(|_| "슬라이드 이미지를 저장할 수 없습니다.".into())
    }
}

fn slide_png(
    font: &Font,
    project: &Value,
    scene: &Value,
    index: usize,
    dimensions: (u32, u32),
    has_media: bool,
    path: &Path,
) -> Result<(), String> {
    let (width, height) = dimensions;
    let mut canvas = Canvas::new(width, height);
    let vertical = height > width;
    let margin = if vertical { 44.0 } else { 64.0 };
    let available = width as f32 - margin * 2.0;
    let headline_y = if vertical { 128.0 } else { 108.0 };
    let headline_height = if vertical { 245.0 } else { 180.0 };
    let headline = text_field(scene, "headline", 10000)?;
    let (lines, size) = fitting_text(
        font,
        headline,
        available,
        headline_height,
        if vertical { 54 } else { 60 },
        24,
    )?;
    canvas.text(font, &lines, size, margin, headline_y, [241, 245, 249]);
    let body_y = if vertical { 405.0 } else { 320.0 };
    let body_height = if has_media {
        if vertical {
            240.0
        } else {
            135.0
        }
    } else {
        height as f32 - body_y - 80.0
    };
    let (lines, size) = fitting_text(
        font,
        text_field(scene, "body", 10000)?,
        available,
        body_height,
        if vertical { 34 } else { 36 },
        18,
    )?;
    canvas.text(font, &lines, size, margin, body_y, [189, 204, 220]);
    let eyebrow = scene
        .get("eyebrow")
        .and_then(Value::as_str)
        .unwrap_or("TORIS STUDIO");
    let (label, size) = fitting_text(font, eyebrow, available, 44.0, 24, 14)?;
    canvas.text(font, &label, size, margin, 40.0, [94, 234, 212]);
    let count = project["scenes"].as_array().map(Vec::len).unwrap_or(1);
    canvas.text(
        font,
        &[format!("{:02} / {:02} · TORIS STUDIO", index + 1, count)],
        18.0,
        margin,
        height as f32 - 48.0,
        [100, 116, 139],
    );
    canvas.save(path)
}

struct MotionAssets {
    files: Vec<String>,
    layers: Vec<LayerGeometry>,
}

fn motion_body_sections(text: &str, single_card: bool) -> Vec<String> {
    let text = text.trim();
    if text.is_empty() {
        return Vec::new();
    }
    if single_card {
        return vec![text.to_owned()];
    }
    let characters: Vec<_> = text.chars().collect();
    let mut sentences = Vec::new();
    let mut current = String::new();
    for (index, character) in characters.iter().enumerate() {
        current.push(*character);
        let boundary = *character == '\n'
            || (matches!(character, '.' | '!' | '?' | '。' | '！' | '？')
                && characters
                    .get(index + 1)
                    .is_none_or(|next| next.is_whitespace()));
        if boundary && !current.trim().is_empty() {
            sentences.push(current.trim().to_owned());
            current.clear();
        }
    }
    if !current.trim().is_empty() {
        sentences.push(current.trim().to_owned());
    }
    let chunk = sentences.len().div_ceil(3).max(1);
    sentences.chunks(chunk).map(|part| part.join(" ")).collect()
}

fn motion_body_layout(
    font: &Font,
    sections: &[String],
    width: f32,
    height: f32,
    preferred: u32,
) -> Result<(Vec<Vec<String>>, f32), String> {
    for size in (18..=preferred).rev() {
        let lines: Vec<_> = sections
            .iter()
            .map(|text| wrap_text(font, text, size as f32, width))
            .collect();
        let total = lines
            .iter()
            .map(|part| (part.len() as f32 * size as f32 * 1.45).ceil() + 26.0)
            .sum::<f32>();
        if total <= height {
            return Ok((lines, size as f32));
        }
    }
    Err("장면 본문이 모션 영역을 초과합니다. 텍스트를 여러 장면으로 나누세요.".into())
}

fn motion_assets(
    font: &Font,
    project: &Value,
    scene: &Value,
    index: usize,
    dimensions: (u32, u32),
    has_media: bool,
    directory: &Path,
) -> Result<MotionAssets, String> {
    let (width, height) = dimensions;
    let vertical = height > width;
    let margin = if vertical { 44 } else { 64 };
    // The motion layout deliberately reserves breathing space around text.
    let available = width - margin * 2;
    let mut background = Canvas::new(width, height);
    background.motion_background();
    let background_name = format!("motion-{index:03}-background.png");
    background.save(&directory.join(&background_name))?;
    let mut assets = MotionAssets {
        files: vec![background_name],
        layers: Vec::new(),
    };
    let mut add = |canvas: Canvas, x: i32, y: i32, role: LayerRole| -> Result<(), String> {
        let input = assets.files.len();
        let name = format!("motion-{index:03}-{input:02}.png");
        let geometry = LayerGeometry {
            input,
            x,
            y,
            width: canvas.width,
            height: canvas.height,
            role,
        };
        canvas.save(&directory.join(&name))?;
        assets.files.push(name);
        assets.layers.push(geometry);
        Ok(())
    };
    // Small offset cards are entirely ornamental, never source screenshots or
    // AI-generated claims. They sit behind the editorial text and media.
    for (card, color) in [[91, 222, 202], [144, 124, 238], [68, 135, 210]]
        .iter()
        .enumerate()
    {
        let size = 64 + card as u32 * 10;
        let mut canvas = Canvas::transparent(size, size);
        canvas.rounded_card(18, *color, 80);
        add(
            canvas,
            width as i32 - margin as i32 - 190 + card as i32 * 52,
            height as i32 - 146 + card as i32 * 5,
            LayerRole::Accent(card as u8),
        )?;
    }
    let eyebrow = scene
        .get("eyebrow")
        .and_then(Value::as_str)
        .unwrap_or("TORIS STUDIO");
    let (label, size) = fitting_text(font, eyebrow, available as f32, 44.0, 22, 14)?;
    let mut label_canvas = Canvas::transparent(available, 44);
    label_canvas.text(font, &label, size, 0.0, 0.0, [105, 239, 214]);
    add(label_canvas, margin as i32, 46, LayerRole::Eyebrow)?;

    let headline_y = if vertical { 138 } else { 115 };
    let headline_height = if vertical { 235.0 } else { 174.0 };
    let (headline, headline_size) = fitting_text(
        font,
        text_field(scene, "headline", 10000)?,
        available as f32,
        headline_height,
        if vertical { 54 } else { 60 },
        24,
    )?;
    let line_height = (headline_size * 1.45).ceil() as u32;
    for (row, line) in headline.iter().enumerate() {
        let mut canvas = Canvas::transparent(available, line_height);
        canvas.text(
            font,
            std::slice::from_ref(line),
            headline_size,
            0.0,
            0.0,
            [245, 248, 255],
        );
        add(
            canvas,
            margin as i32,
            headline_y + row as i32 * line_height as i32,
            LayerRole::Headline(row as u8),
        )?;
    }
    let body_y = if vertical { 418 } else { 321 };
    let body_height = if has_media {
        if vertical {
            250.0
        } else {
            137.0
        }
    } else {
        height as f32 - body_y as f32 - 196.0
    };
    let sections = motion_body_sections(text_field(scene, "body", 10000)?, has_media);
    let (body, body_size) = motion_body_layout(
        font,
        &sections,
        (available - 36) as f32,
        body_height,
        if vertical { 33 } else { 34 },
    )?;
    // At most three body cards; their PNG sizes are text-sized rather than full
    // video frames. This bounds decoder memory and avoids per-frame rasterizing.
    let mut y = body_y;
    for (row, lines) in body.iter().enumerate() {
        let card_height = (lines.len() as f32 * body_size * 1.45).ceil() as u32 + 24;
        let mut canvas = Canvas::transparent(available, card_height);
        canvas.rounded_card(16, [24, 37, 54], 235);
        canvas.text(font, lines, body_size, 18.0, 12.0, [197, 214, 231]);
        add(canvas, margin as i32, y, LayerRole::Body(row as u8))?;
        y += card_height as i32 + 2;
    }
    let count = project["scenes"].as_array().map(Vec::len).unwrap_or(1);
    let mut footer = Canvas::transparent(available, 30);
    footer.text(
        font,
        &[format!("{:02} / {:02} · TORIS STUDIO", index + 1, count)],
        18.0,
        0.0,
        0.0,
        [111, 137, 157],
    );
    add(footer, margin as i32, height as i32 - 53, LayerRole::Footer)?;
    Ok(assets)
}

async fn run_command(
    program: &str,
    arguments: &[String],
    directory: Option<&Path>,
    seconds: u64,
) -> Result<Vec<u8>, String> {
    let mut command = Command::new(tool_path(program));
    command
        .args(arguments)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    if let Some(directory) = directory {
        command.current_dir(directory);
    }
    #[cfg(target_os = "windows")]
    command.creation_flags(0x08000000); // CREATE_NO_WINDOW
    let mut child = command
        .spawn()
        .map_err(|_| format!("{program} 실행 파일이 없습니다. 설치 후 앱을 다시 실행하세요."))?;
    let stdout = child.stdout.take().ok_or("프로세스 출력 오류")?;
    let stderr = child.stderr.take().ok_or("프로세스 출력 오류")?;
    let output_task = tokio::spawn(async move {
        let mut bytes = Vec::new();
        stdout
            .take(65537)
            .read_to_end(&mut bytes)
            .await
            .map(|_| bytes)
    });
    let error_task = tokio::spawn(async move {
        let mut bytes = Vec::new();
        stderr
            .take(65537)
            .read_to_end(&mut bytes)
            .await
            .map(|_| bytes)
    });
    let status = tokio::time::timeout(Duration::from_secs(seconds), child.wait()).await;
    if status.is_err() {
        let _ = child.kill().await;
        let _ = child.wait().await;
        output_task.abort();
        error_task.abort();
        return Err(format!("{program} 처리 제한 시간을 초과했습니다."));
    }
    let status = status
        .map_err(|_| "프로세스 시간 초과")?
        .map_err(|_| "프로세스 상태 확인 오류")?;
    let output = output_task
        .await
        .map_err(|_| "프로세스 출력 오류")?
        .map_err(|_| "프로세스 출력 오류")?;
    let _errors = error_task
        .await
        .map_err(|_| "프로세스 출력 오류")?
        .map_err(|_| "프로세스 출력 오류")?;
    // Tool stderr may contain local names or untrusted metadata. Keep it private.
    if !status.success() {
        return Err(format!(
            "{program} 처리에 실패했습니다. 파일 형식과 설치된 코덱을 확인하세요."
        ));
    }
    if output.len() > 65536 {
        return Err("미디어 도구 응답이 너무 큽니다.".into());
    }
    Ok(output)
}

fn args(values: &[&str]) -> Vec<String> {
    values.iter().map(|value| (*value).to_string()).collect()
}

fn tool_path(program: &str) -> PathBuf {
    // Finder launches do not usually inherit Homebrew's PATH.
    #[cfg(target_os = "macos")]
    for base in ["/opt/homebrew/bin", "/usr/local/bin"] {
        let path = Path::new(base).join(program);
        if path.is_file() {
            return path;
        }
    }
    PathBuf::from(program)
}

async fn probe(path: &Path) -> Result<Value, String> {
    let mut arguments = args(&[
        "-v",
        "error",
        "-protocol_whitelist",
        "file,pipe",
        "-format_whitelist",
        "mov,matroska,webm,wav,mp3,png_pipe,jpeg_pipe,webp_pipe,image2",
        "-show_entries",
        "format=duration,format_name:stream=codec_type,width,height",
        "-of",
        "json",
    ]);
    arguments.push(path.to_string_lossy().into_owned());
    let bytes = run_command("ffprobe", &arguments, None, 20).await?;
    serde_json::from_slice(&bytes).map_err(|_| "미디어 검사 결과 형식 오류".into())
}

fn media_kind(path: &Path, declared: &str) -> Result<&'static str, String> {
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    match (declared, extension.as_str()) {
        ("image", "png" | "jpg" | "jpeg" | "webp") => Ok("image"),
        ("video" | "screen", "mp4" | "mov" | "webm" | "mkv") => Ok("video"),
        _ => {
            Err("렌더링 미디어는 PNG/JPG/WebP 또는 MP4/MOV/WebM/MKV 로컬 파일이어야 합니다.".into())
        }
    }
}

pub async fn render_project(project: Value) -> Result<Value, String> {
    // The updater acquires this same barrier immediately before installing.
    // Keep the order identical to research creation: update gate, video gate.
    let _update_guard = crate::keyword::lock_for_update()
        .map_err(|_| "키워드 탐색 또는 업데이트 작업이 끝난 뒤 영상을 출력하세요.")?;
    let _permit = lock_for_video_activity()?;
    render_project_at(project, &data_dir()?.join("renders"), &public_dir()?).await
}

// The renderer accepts directories only from the privileged core. This narrow
// helper also permits real FFmpeg diagnostics without touching user projects.
async fn render_project_at(
    project: Value,
    render_dir: &Path,
    assets: &Path,
) -> Result<Value, String> {
    validate_project(&project)?;
    let format = project["format"].as_str().ok_or("영상 비율 오류")?;
    let (width, height) = if format == "youtube-landscape" {
        (1280, 720)
    } else {
        (720, 1280)
    };
    let font = load_font()?;
    fs::create_dir_all(render_dir).map_err(|_| "렌더링 폴더를 만들 수 없습니다.")?;
    let temporary =
        tempfile::tempdir_in(render_dir).map_err(|_| "렌더링 작업 폴더를 만들 수 없습니다.")?;
    let working = temporary.path();
    let scenes = project["scenes"].as_array().ok_or("장면 목록 오류")?;
    let mut total_frames = 0_u64;
    let mut concat = String::new();
    let has_motion = scenes.iter().any(|scene| scene.get("motion").is_some());
    for (index, scene) in scenes.iter().enumerate() {
        let duration = scene["durationSec"].as_f64().ok_or("장면 길이 오류")?;
        let frames = (duration * 24.0).ceil().max(1.0) as u64;
        total_frames += frames;
        let duration = frames as f64 / 24.0;
        let declared = scene
            .get("mediaType")
            .and_then(Value::as_str)
            .unwrap_or("none");
        let media = if declared != "none" {
            let reference = scene
                .get("mediaUrl")
                .and_then(Value::as_str)
                .ok_or("장면 미디어 파일을 연결하세요.")?;
            let path = resolve_asset_at(assets, reference)?;
            let kind = media_kind(&path, declared)?;
            let inspected = probe(&path).await?;
            if !inspected["streams"]
                .as_array()
                .is_some_and(|streams| streams.iter().any(|stream| stream["codec_type"] == "video"))
            {
                return Err("장면 미디어에 영상 또는 이미지 스트림이 없습니다.".into());
            }
            Some((path, kind))
        } else {
            None
        };
        let audio = scene
            .get("audioPath")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .map(|reference| resolve_asset_at(assets, reference))
            .transpose()?;
        if let Some(path) = &audio {
            if !matches!(
                path.extension()
                    .and_then(|value| value.to_str())
                    .map(str::to_ascii_lowercase)
                    .as_deref(),
                Some("wav" | "mp3" | "m4a")
            ) {
                return Err("장면 음성은 WAV/MP3/M4A 로컬 파일이어야 합니다.".into());
            }
            let inspected = probe(path).await?;
            let audio_duration = inspected["format"]["duration"]
                .as_str()
                .and_then(|value| value.parse::<f64>().ok())
                .ok_or("음성 길이를 확인할 수 없습니다.")?;
            if !audio_duration.is_finite() || audio_duration <= 0.0 {
                return Err("음성 길이를 확인할 수 없습니다.".into());
            }
            if audio_duration > duration + 0.05 {
                return Err(
                    "음성이 장면보다 깁니다. 장면 길이를 음성 길이 이상으로 조정하세요.".into(),
                );
            }
            if !inspected["streams"]
                .as_array()
                .is_some_and(|streams| streams.iter().any(|stream| stream["codec_type"] == "audio"))
            {
                return Err("음성 파일에 오디오 스트림이 없습니다.".into());
            }
        }
        let motion = MotionSpec::from_scene(scene)?;
        let motion_assets = motion
            .map(|_| {
                motion_assets(
                    &font,
                    &project,
                    scene,
                    index,
                    (width, height),
                    media.is_some(),
                    working,
                )
            })
            .transpose()?;
        let slide_name = if let Some(assets) = &motion_assets {
            assets.files[0].clone()
        } else {
            let slide_name = format!("slide-{index:03}.png");
            slide_png(
                &font,
                &project,
                scene,
                index,
                (width, height),
                media.is_some(),
                &working.join(&slide_name),
            )?;
            slide_name
        };
        let mut arguments = args(&[
            "-hide_banner",
            "-loglevel",
            "error",
            "-nostdin",
            "-y",
            "-threads",
            "2",
            "-protocol_whitelist",
            "file,pipe",
            "-loop",
            "1",
            "-framerate",
            "24",
            "-i",
        ]);
        arguments.push(slide_name);
        let mut input_count = 1;
        if let Some(assets) = &motion_assets {
            for name in assets.files.iter().skip(1) {
                arguments.extend(args(&[
                    "-threads",
                    "1",
                    "-protocol_whitelist",
                    "file,pipe",
                    "-loop",
                    "1",
                    "-framerate",
                    "24",
                    "-i",
                ]));
                arguments.push(name.clone());
                input_count += 1;
            }
        }
        let media_index = input_count;
        if let Some((path, kind)) = &media {
            arguments.extend(args(&[
                "-protocol_whitelist",
                "file,pipe",
                "-format_whitelist",
                "mov,matroska,webm,png_pipe,jpeg_pipe,webp_pipe,image2",
            ]));
            if *kind == "image" {
                arguments.extend(args(&["-loop", "1", "-framerate", "24"]));
            } else {
                arguments.extend(args(&["-stream_loop", "-1"]));
            }
            arguments.push("-i".into());
            arguments.push(path.to_string_lossy().into_owned());
            input_count += 1;
        }
        let audio_index = input_count;
        if let Some(path) = &audio {
            arguments.extend(args(&[
                "-protocol_whitelist",
                "file,pipe",
                "-format_whitelist",
                "mov,wav,mp3",
                "-i",
            ]));
            arguments.push(path.to_string_lossy().into_owned());
        } else {
            arguments.extend(args(&["-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo"]));
        }
        let (base_filter, base_video) = if let (Some(spec), Some(assets)) = (motion, &motion_assets)
        {
            (
                format!(
                    "{};",
                    crate::motion::filter_graph(spec, &assets.layers, duration)
                ),
                "[motionvideo]",
            )
        } else {
            (String::new(), "[0:v]")
        };
        let video_filter = if media.is_some() {
            let (x, y, media_width, media_height) = if height > width {
                (44, 710, 632, 470)
            } else {
                (64, 477, 1152, 180)
            };
            let cover = scene.get("mediaFit").and_then(Value::as_str) == Some("cover");
            let scaling = if cover {
                format!("scale={media_width}:{media_height}:force_original_aspect_ratio=increase,crop={media_width}:{media_height}")
            } else {
                format!("scale={media_width}:{media_height}:force_original_aspect_ratio=decrease,pad={media_width}:{media_height}:(ow-iw)/2:(oh-ih)/2:color=0x0f172a")
            };
            format!("{base_filter}[{media_index}:v]{scaling},setsar=1,fps=24[media];{base_video}[media]overlay={x}:{y}:shortest=1,format=yuv420p[v]")
        } else {
            format!("{base_filter}{base_video}format=yuv420p[v]")
        };
        let segment_name = format!("segment-{index:03}.mp4");
        arguments.extend(args(&["-filter_complex_threads", "1", "-filter_complex"]));
        arguments.push(video_filter);
        arguments.extend(args(&["-map", "[v]", "-map"]));
        arguments.push(format!("{audio_index}:a:0"));
        arguments.extend(args(&["-af", "apad,aresample=48000", "-ac", "2", "-t"]));
        arguments.push(format!("{duration:.6}"));
        arguments.extend(args(&[
            "-r",
            "24",
            "-c:v",
            "libx264",
            "-preset",
            "veryfast",
            "-crf",
            "20",
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "aac",
            "-b:a",
            "160k",
            "-movflags",
            "+faststart",
        ]));
        arguments.push(segment_name.clone());
        run_command(
            "ffmpeg",
            &arguments,
            Some(working),
            (duration as u64 * 8 + 60).min(900),
        )
        .await?;
        concat.push_str(&format!("file '{segment_name}'\n"));
    }
    fs::write(working.join("segments.txt"), concat).map_err(|_| "렌더링 장면 목록 저장 오류")?;
    let output_name = format!("{}.mp4", Uuid::new_v4());
    let mut arguments = args(&[
        "-hide_banner",
        "-loglevel",
        "error",
        "-nostdin",
        "-y",
        "-protocol_whitelist",
        "file,pipe",
        "-f",
        "concat",
        "-safe",
        "1",
        "-i",
        "segments.txt",
        "-c",
        "copy",
        "-movflags",
        "+faststart",
    ]);
    arguments.push(output_name.clone());
    run_command("ffmpeg", &arguments, Some(working), 120).await?;
    let output = render_dir.join(output_name);
    fs::rename(
        working.join(output.file_name().ok_or("출력 파일 경로 오류")?),
        &output,
    )
    .map_err(|_| "완성 영상을 저장할 수 없습니다.")?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&output, fs::Permissions::from_mode(0o600))
            .map_err(|_| "완성 영상의 로컬 접근 권한을 설정할 수 없습니다.")?;
    }
    Ok(
        json!({"path": output.to_string_lossy(), "durationSec": total_frames as f64 / 24.0, "format":format, "renderer":if has_motion {"rust-ffmpeg-motion"} else {"rust-ffmpeg-slides"}, "width":width, "height":height, "fps":24}),
    )
}

struct WavInfo {
    duration: f64,
    sample_rate: u32,
    nonzero: bool,
}
fn pcm16_wav(bytes: &[u8]) -> Result<WavInfo, String> {
    let invalid = || "음성 서버의 WAV 데이터 형식이 올바르지 않습니다.".to_string();
    if bytes.len() < 12 || &bytes[..4] != b"RIFF" || &bytes[8..12] != b"WAVE" {
        return Err(invalid());
    }
    let u16_at = |offset: usize| u16::from_le_bytes([bytes[offset], bytes[offset + 1]]);
    let u32_at = |offset: usize| {
        u32::from_le_bytes([
            bytes[offset],
            bytes[offset + 1],
            bytes[offset + 2],
            bytes[offset + 3],
        ])
    };
    if u32_at(4) as usize + 8 != bytes.len() {
        return Err(invalid());
    }
    let mut format = None;
    let mut data = None;
    let mut offset = 12;
    while offset < bytes.len() {
        if offset + 8 > bytes.len() {
            return Err(invalid());
        }
        let length = u32_at(offset + 4) as usize;
        let start = offset + 8;
        let end = start.checked_add(length).ok_or_else(invalid)?;
        let padded = end.checked_add(length % 2).ok_or_else(invalid)?;
        if padded > bytes.len() {
            return Err(invalid());
        }
        match &bytes[offset..offset + 4] {
            b"fmt " => {
                if format.is_some() || length < 16 || u16_at(start) != 1 || u16_at(start + 14) != 16
                {
                    return Err(invalid());
                }
                let channels = u16_at(start + 2);
                let sample_rate = u32_at(start + 4);
                let byte_rate = u32_at(start + 8);
                let align = u16_at(start + 12);
                if !(1..=2).contains(&channels)
                    || !(8000..=192000).contains(&sample_rate)
                    || align != channels * 2
                    || byte_rate != sample_rate * align as u32
                {
                    return Err(invalid());
                }
                format = Some((sample_rate, align));
            }
            b"data" => {
                if data.is_some() {
                    return Err(invalid());
                }
                data = Some((start, length));
            }
            _ => {}
        }
        offset = padded;
    }
    let (sample_rate, align) = format.ok_or_else(invalid)?;
    let (start, length) = data.ok_or_else(invalid)?;
    if length == 0 || length % align as usize != 0 {
        return Err(invalid());
    }
    let duration = length as f64 / align as f64 / sample_rate as f64;
    if duration > 600.0 {
        return Err("생성 음성이 10분을 초과했습니다.".into());
    }
    Ok(WavInfo {
        duration,
        sample_rate,
        nonzero: bytes[start..start + length]
            .chunks_exact(2)
            .any(|sample| sample != [0, 0]),
    })
}

pub async fn generate_voice(input: Value) -> Result<Value, String> {
    let _permit = VOICE_LOCK
        .try_lock()
        .map_err(|_| "이미 음성을 생성하고 있습니다.")?;
    let project_id = text_field(&input, "projectId", 128)?;
    Uuid::parse_str(project_id).map_err(|_| "프로젝트 UUID를 확인하세요.")?;
    let scene_id = text_field(&input, "sceneId", 128)?;
    if !valid_part(scene_id) {
        return Err("장면 ID 형식을 확인하세요.".into());
    }
    let text = text_field(&input, "text", 4000)?.trim();
    if text.is_empty() {
        return Err("음성으로 생성할 텍스트를 입력하세요.".into());
    }
    let language = input
        .get("language")
        .and_then(Value::as_str)
        .unwrap_or("Korean");
    let language = match language {
        "ko" | "Korean" => "Korean",
        "en" | "English" => "English",
        "ja" | "Japanese" => "Japanese",
        "zh" | "Chinese" => "Chinese",
        _ => return Err("음성 언어를 확인하세요.".into()),
    };
    let speaker = input
        .get("speaker")
        .and_then(Value::as_str)
        .unwrap_or("Sohee");
    if speaker.len() > 64 || speaker.is_empty() || speaker.chars().any(char::is_control) {
        return Err("음성 화자 이름을 확인하세요.".into());
    }
    let instruct = input
        .get("instruct")
        .and_then(Value::as_str)
        .unwrap_or("따뜻하고 자연스러운 목소리로 편안하고 또렷하게 읽어 주세요.");
    if instruct.chars().count() > 2000 {
        return Err("음성 지시문은 2000자 이하여야 합니다.".into());
    }
    let client = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(300))
        .build()
        .map_err(|_| "음성 HTTP 설정 오류")?;
    let response = client.post(format!("{TTS_BASE}/synthesize")).json(&json!({"text":text,"speaker":speaker,"language":language,"instruct":instruct,"temperature":0.85,"top_p":0.95,"top_k":50,"repetition_penalty":1.05,"max_tokens":4096}))
        .send().await.map_err(|_| "로컬 Qwen3 음성 서버에 연결할 수 없습니다. 포트 50010의 서버를 실행하세요.")?;
    if !response.status().is_success() {
        return Err(format!(
            "로컬 음성 생성에 실패했습니다 (HTTP {}).",
            response.status().as_u16()
        ));
    }
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    if !["audio/wav", "audio/x-wav", "audio/wave", "audio/vnd.wave"]
        .contains(&content_type.as_str())
    {
        return Err("음성 서버가 WAV가 아닌 응답을 반환했습니다.".into());
    }
    if response
        .content_length()
        .is_some_and(|length| length > AUDIO_LIMIT as u64)
    {
        return Err("생성 음성 파일이 너무 큽니다.".into());
    }
    let mut stream = response.bytes_stream();
    let mut bytes = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| "생성 음성을 읽을 수 없습니다.")?;
        if bytes.len() + chunk.len() > AUDIO_LIMIT {
            return Err("생성 음성 파일이 너무 큽니다.".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    let info = pcm16_wav(&bytes)?;
    if !info.nonzero {
        return Err("음성 서버가 무음 파일을 반환했습니다.".into());
    }
    let filename = format!("{scene_id}-{}.wav", Uuid::new_v4());
    let reference = format!("/generated/{project_id}/{filename}");
    let base = public_dir()?;
    fs::create_dir_all(&base).map_err(|_| "음성 폴더를 만들 수 없습니다.")?;
    let canonical_base = base.canonicalize().map_err(|_| "음성 저장 폴더 오류")?;
    let directory = base.join("generated").join(project_id);
    fs::create_dir_all(&directory).map_err(|_| "음성 폴더를 만들 수 없습니다.")?;
    if !directory
        .canonicalize()
        .map_err(|_| "음성 폴더 오류")?
        .starts_with(canonical_base)
    {
        return Err("음성을 외부 폴더에 저장할 수 없습니다.".into());
    }
    write_private(&directory.join(filename), &bytes)?;
    Ok(
        json!({"audioPath":reference,"durationSec":info.duration,"sampleRate":info.sample_rate,"speaker":speaker,"provider":"qwen3-tts-mlx","processing":"rust-http-wav-validation"}),
    )
}

pub async fn status() -> Result<Value, String> {
    let version_args = args(&["-version"]);
    let (ffmpeg, ffprobe) = tokio::join!(
        run_command("ffmpeg", &version_args, None, 5),
        run_command("ffprobe", &version_args, None, 5)
    );
    let client = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_millis(1800))
        .build()
        .map_err(|_| "음성 상태 확인 설정 오류")?;
    let tts = match client.get(format!("{TTS_BASE}/health")).send().await {
        Ok(response) if response.status().is_success() => {
            let mut stream = response.bytes_stream();
            let mut bytes = Vec::new();
            let mut complete = true;
            while let Some(chunk) = stream.next().await {
                match chunk {
                    Ok(chunk) if bytes.len() + chunk.len() <= 8192 => {
                        bytes.extend_from_slice(&chunk)
                    }
                    _ => {
                        complete = false;
                        break;
                    }
                }
            }
            complete
                && serde_json::from_slice::<Value>(&bytes)
                    .ok()
                    .is_some_and(|value| value["ok"] == true)
        }
        _ => false,
    };
    Ok(
        json!({"ffmpegAvailable":ffmpeg.is_ok(),"ffprobeAvailable":ffprobe.is_ok(),"fontAvailable":font_path().is_some(),"ttsConfigured":tts,"ttsEndpoint":TTS_BASE,"dataPath":data_dir()?.to_string_lossy(),"renderer":"rust-ffmpeg-motion","motionPresets":crate::motion::PRESET_IDS,"note":"Rust 모션·슬라이드·로컬 미디어 합성. 음성 모델 추론은 별도 Qwen3 로컬 서버에서 실행됩니다."}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    fn project() -> Value {
        json!({"id":"00000000-0000-4000-8000-000000000002","title":"Rust 한국어 영상","format":"youtube-landscape","template":"reference-briefing","language":"ko","scenes":[{"id":"first","headline":"첫 번째 장면","body":"로컬 처리와 안전한 저장을 확인합니다.","narration":"","durationSec":0.5},{"id":"second","headline":"두 번째 장면","body":"Rust에서 MP4를 생성합니다.","narration":"","durationSec":0.5}]})
    }
    #[test]
    fn rejects_invalid_duration_and_asset_references() {
        for reference in [
            "/../private.wav",
            "http://127.0.0.1:10100/key",
            "//remote/a.wav",
            "C:\\private.wav",
            "/generated/%2e%2e/private.wav",
            "/generated/a.wav?x=y",
        ] {
            assert!(relative_asset(reference).is_err(), "{reference}");
        }
        assert!(relative_asset("/generated/test/a.wav").is_ok());
        let mut invalid = project();
        invalid["scenes"][0]["durationSec"] = json!(-1);
        assert!(validate_project(&invalid).is_err());
        invalid = project();
        invalid["scenes"][1]["id"] = json!("first");
        assert!(validate_project(&invalid).is_err());
    }
    #[test]
    fn validates_motion_without_rewriting_legacy_scenes() {
        let legacy = project();
        assert!(validate_project(&legacy).is_ok());
        for preset in crate::motion::PRESET_IDS {
            let mut animated = legacy.clone();
            animated["scenes"][0]["motion"] = json!({"preset":preset,"intensity":0.6});
            assert!(validate_project(&animated).is_ok());
            assert_eq!(animated["scenes"][1], legacy["scenes"][1]);
        }
        for motion in [
            json!(null),
            json!({"preset":"movie=/tmp/key","intensity":0.5}),
            json!({"preset":"stagger-rise","intensity":1.01}),
        ] {
            let mut invalid = legacy.clone();
            invalid["scenes"][0]["motion"] = motion;
            assert!(validate_project(&invalid).is_err());
        }
    }
    #[test]
    fn motion_cards_keep_sentence_and_domain_boundaries() {
        assert_eq!(
            motion_body_sections(
                "제목을 보여줍니다. 본문을 소개합니다. 다음으로 넘어갑니다.",
                false
            ),
            vec![
                "제목을 보여줍니다.",
                "본문을 소개합니다.",
                "다음으로 넘어갑니다."
            ]
        );
        assert_eq!(
            motion_body_sections("example.com과 2.5초를 표시합니다. 문장이 끝납니다.", false),
            vec!["example.com과 2.5초를 표시합니다.", "문장이 끝납니다."]
        );
        assert_eq!(
            motion_body_sections("첫째. 둘째. 셋째. 넷째. 다섯째.", false).len(),
            3
        );
        assert_eq!(
            motion_body_sections("첫째. 둘째.", true),
            vec!["첫째. 둘째."]
        );
        assert!(motion_body_sections("   ", false).is_empty());
    }
    #[test]
    fn preserves_legacy_records_and_unknown_fields_atomically() {
        let temporary = tempfile::tempdir().unwrap();
        let file = temporary.path().join("projects.json");
        let original = json!({"legacyVersion":7,"projects":[{"id":"untouched","privateLegacyField":{"keep":true}},project()]});
        fs::write(&file, serde_json::to_vec(&original).unwrap()).unwrap();
        let mut update = project();
        update["customMetadata"] = json!({"preserved":true});
        let saved = save_project_at(&file, update).unwrap();
        assert!(saved["updatedAt"].is_string());
        let stored = read_store_at(&file).unwrap();
        assert_eq!(stored["legacyVersion"], 7);
        assert_eq!(stored["projects"][0], original["projects"][0]);
        let saved = save_project_at(&file, project()).unwrap();
        assert_eq!(saved["customMetadata"]["preserved"], true);
        fs::write(&file, b"broken").unwrap();
        assert!(save_project_at(&file, project()).is_err());
        assert_eq!(fs::read(&file).unwrap(), b"broken");
    }
    #[cfg(unix)]
    #[test]
    fn prevents_symlink_media_escape() {
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::NamedTempFile::new().unwrap();
        std::os::unix::fs::symlink(outside.path(), root.path().join("audio.wav")).unwrap();
        assert!(resolve_asset_at(root.path(), "/audio.wav").is_err());
    }
    fn wav(samples: &[i16]) -> Vec<u8> {
        let size = samples.len() as u32 * 2;
        let mut bytes = b"RIFF".to_vec();
        bytes.extend_from_slice(&(36 + size).to_le_bytes());
        bytes.extend_from_slice(b"WAVEfmt ");
        bytes.extend_from_slice(&16_u32.to_le_bytes());
        bytes.extend_from_slice(&1_u16.to_le_bytes());
        bytes.extend_from_slice(&1_u16.to_le_bytes());
        bytes.extend_from_slice(&24000_u32.to_le_bytes());
        bytes.extend_from_slice(&48000_u32.to_le_bytes());
        bytes.extend_from_slice(&2_u16.to_le_bytes());
        bytes.extend_from_slice(&16_u16.to_le_bytes());
        bytes.extend_from_slice(b"data");
        bytes.extend_from_slice(&size.to_le_bytes());
        for sample in samples {
            bytes.extend_from_slice(&sample.to_le_bytes());
        }
        bytes
    }
    #[test]
    fn validates_complete_pcm_wav_and_detects_silence() {
        let bytes = wav(&[0, 120, -50]);
        let info = pcm16_wav(&bytes).unwrap();
        assert_eq!(info.sample_rate, 24000);
        assert!(info.nonzero);
        assert!(!pcm16_wav(&wav(&[0, 0])).unwrap().nonzero);
        assert!(pcm16_wav(&bytes[..bytes.len() - 1]).is_err());
        let mut invalid = bytes;
        invalid[32] = 4;
        assert!(pcm16_wav(&invalid).is_err());
    }
    #[tokio::test]
    #[ignore = "requires installed FFmpeg, FFprobe and OS font; creates an actual MP4 in a temporary directory"]
    async fn native_two_scene_render() {
        let temporary = tempfile::tempdir().unwrap();
        let output = render_project_at(project(), temporary.path(), temporary.path())
            .await
            .unwrap();
        let path = PathBuf::from(output["path"].as_str().unwrap());
        let result = probe(&path).await.unwrap();
        assert!(fs::metadata(&path).unwrap().len() > 1000);
        assert!(result["streams"]
            .as_array()
            .unwrap()
            .iter()
            .any(|stream| stream["codec_type"] == "video"
                && stream["width"] == 1280
                && stream["height"] == 720));
        let duration = result["format"]["duration"]
            .as_str()
            .unwrap()
            .parse::<f64>()
            .unwrap();
        assert!((duration - 1.0).abs() < 0.1);
        fs::remove_file(path).unwrap();
    }

    #[tokio::test]
    #[ignore = "requires FFmpeg and OS font; verifies synthetic local image and PCM audio with motion"]
    async fn native_motion_preserves_local_media_and_audio() {
        let temporary = tempfile::tempdir().unwrap();
        let mut image = Canvas::new(320, 180);
        image.motion_background();
        image.save(&temporary.path().join("sample.png")).unwrap();
        let samples: Vec<_> = (0..24000)
            .map(|index| {
                ((index as f64 * 440.0 * std::f64::consts::TAU / 24000.0).sin() * 3000.0) as i16
            })
            .collect();
        fs::write(temporary.path().join("sample.wav"), wav(&samples)).unwrap();
        for format in ["shorts", "youtube-landscape"] {
            let mut sample = project();
            sample["format"] = json!(format);
            sample["scenes"] = json!([{"id":"media","headline":"로컬 미디어 합성","body":"이미지와 음성을 보존합니다.","narration":"","durationSec":2.0,"mediaType":"image","mediaUrl":"/sample.png","audioPath":"/sample.wav","motion":{"preset":"focus-pulse","intensity":0.6}}]);
            let output = render_project_at(sample, temporary.path(), temporary.path())
                .await
                .unwrap();
            let path = Path::new(output["path"].as_str().unwrap());
            let inspected = probe(path).await.unwrap();
            assert!(inspected["streams"]
                .as_array()
                .unwrap()
                .iter()
                .any(|stream| stream["codec_type"] == "audio"));
            assert!(inspected["streams"]
                .as_array()
                .unwrap()
                .iter()
                .any(|stream| stream["codec_type"] == "video"
                    && stream["width"] == output["width"]
                    && stream["height"] == output["height"]));
            let mut arguments = args(&["-hide_banner", "-loglevel", "error", "-nostdin", "-i"]);
            arguments.push(path.to_string_lossy().into_owned());
            arguments.extend(args(&[
                "-map", "0:a:0", "-f", "s16le", "-ac", "1", "-ar", "8000", "pipe:1",
            ]));
            let audio = run_command("ffmpeg", &arguments, None, 30).await.unwrap();
            assert!(audio.chunks_exact(2).any(|sample| sample != [0, 0]));
        }
    }

    #[tokio::test]
    #[ignore = "requires FFmpeg and OS font; writes synthetic samples only under a temporary directory"]
    async fn native_six_preset_motion_probe() {
        use sha2::{Digest, Sha256};
        let temporary = tempfile::tempdir().unwrap();
        let destination = std::env::var_os("TORIS_MOTION_PROBE_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| temporary.path().to_path_buf());
        let scenes: Vec<_> = crate::motion::PRESET_IDS.iter().enumerate().map(|(index, preset)| json!({
            "id":format!("motion-{index}"),"eyebrow":"MOTION / EDITORIAL",
            "headline":"하나의 주제, 여섯 가지 움직임",
            "body":"제목은 천천히 자리 잡고, 본문은 순서대로 나타납니다. 읽을 시간과 화면의 여백을 함께 설계합니다.",
            "narration":"","durationSec":2.0,"mediaType":"none",
            "motion":{"preset":preset,"intensity":0.8}
        })).collect();
        let mut observations = Vec::new();
        for format in ["shorts", "youtube-landscape"] {
            let mut sample = project();
            sample["format"] = json!(format);
            sample["scenes"] = json!(scenes);
            let render = render_project_at(sample, &destination, temporary.path())
                .await
                .unwrap();
            let path = Path::new(render["path"].as_str().unwrap());
            let inspected = probe(path).await.unwrap();
            assert!(inspected["streams"]
                .as_array()
                .unwrap()
                .iter()
                .any(|stream| stream["codec_type"] == "video"
                    && stream["width"] == render["width"]
                    && stream["height"] == render["height"]));
            let duration = inspected["format"]["duration"]
                .as_str()
                .unwrap()
                .parse::<f64>()
                .unwrap();
            assert!((duration - 12.0).abs() < 0.1);
            for (index, preset) in crate::motion::PRESET_IDS.iter().enumerate() {
                let mut hashes = Vec::new();
                let mut frames = Vec::new();
                for (moment, offset) in [("entrance", 0.20), ("hold", 1.45)] {
                    let frame = destination.join(format!("{format}-{preset}-{moment}.png"));
                    let mut arguments = args(&[
                        "-hide_banner",
                        "-loglevel",
                        "error",
                        "-nostdin",
                        "-y",
                        "-ss",
                    ]);
                    arguments.push(format!("{:.3}", index as f64 * 2.0 + offset));
                    arguments.extend(args(&["-i"]));
                    arguments.push(path.to_string_lossy().into_owned());
                    arguments.extend(args(&["-frames:v", "1", "-update", "1"]));
                    arguments.push(frame.to_string_lossy().into_owned());
                    run_command("ffmpeg", &arguments, None, 30).await.unwrap();
                    hashes.push(format!("{:x}", Sha256::digest(fs::read(&frame).unwrap())));
                    frames.push(frame.to_string_lossy().into_owned());
                }
                assert_ne!(
                    hashes[0], hashes[1],
                    "{format}/{preset} must visibly animate"
                );
                observations.push(
                    json!({"format":format,"preset":preset,"frameHashes":hashes,"frames":frames}),
                );
            }
            println!("motion_sample={}", render);
        }
        fs::write(destination.join("motion-evidence.json"), serde_json::to_vec_pretty(&json!({"synthetic":true,"userProjectWrites":false,"fps":24,"observations":observations})).unwrap()).unwrap();
        println!("motion_probe_directory={}", destination.display());
    }
}
