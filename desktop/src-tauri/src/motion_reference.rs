//! Motion references: the closed "feel" of a motion graphic — colours, two type sizes, a
//! composition, an animation vocabulary and a rhythm. No text, logo, image, pixel or file path
//! is stored. A reference only steers deterministic layout code (motion_scene.rs) and, as data,
//! the Motion Studio model request (motion_ai.rs).
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::{Path, PathBuf};

pub const DEFAULT_ID: &str = "builtin-midnight-data";
pub const MAX_SAVED: usize = 50;
/// BT.601 luma floor: the production QA counts frames below luma 24 as black.
pub const MIN_BACKGROUND_LUMA: f64 = 32.0;
pub const MIN_TEXT_CONTRAST: f64 = 4.5;
/// Large numbers and decor in the accent colour (WCAG large-text contrast).
pub const MIN_ACCENT_CONTRAST: f64 = 3.0;
pub const MAX_IMAGE_BYTES: u64 = 32 * 1024 * 1024;
pub const MAX_VIDEO_BYTES: u64 = 1024 * 1024 * 1024;
pub const MAX_VIDEO_SEC: f64 = 600.0;
pub const MAX_MEDIA_SIDE: u32 = 8192;
/// Sampled video frames, each scaled to SAMPLE_SIDE² RGB pixels (fits run_command's 64 KiB output).
pub const VIDEO_SAMPLES: u32 = 40;
pub const SAMPLE_SIDE: u32 = 20;
/// Shown on every media reference so measured colours are never mistaken for measured motion.
pub const UNMEASURED_NOTE: &str = "속도와 배치는 재지 않았고 기준 레퍼런스 값을 씁니다.";

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Origin {
    Builtin,
    Project,
    Media,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum MediaKind {
    Image,
    Video,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Composition {
    Center,
    LeftRail,
    Panel,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Enter {
    Fade,
    Rise,
    Slide,
    Zoom,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum AccentMotion {
    Draw,
    Fade,
    Zoom,
    None,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Exit {
    None,
    FadeOut,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Decor {
    None,
    Underline,
    Ring,
    Block,
}

#[derive(Clone, Debug, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Source {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_hash: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sha256: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<MediaKind>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub width: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub height: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration_sec: Option<f64>,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Palette {
    pub background: String,
    pub surface: String,
    pub text: String,
    pub accent: String,
    pub accent2: String,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TypeScale {
    /// Design pixels on the 1080-pixel short side, so one value fits 9:16 and 16:9.
    pub headline: u32,
    pub body: u32,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Motion {
    pub enter: Enter,
    pub accent: AccentMotion,
    pub exit: Exit,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Rhythm {
    pub first_delay: f64,
    pub stagger: f64,
    pub scene_sec: f64,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Reference {
    pub version: u8,
    pub id: String,
    pub name: String,
    pub origin: Origin,
    #[serde(default)]
    pub source: Option<Source>,
    pub palette: Palette,
    #[serde(rename = "type")]
    pub typography: TypeScale,
    pub composition: Composition,
    pub motion: Motion,
    pub decor: Decor,
    pub rhythm: Rhythm,
    #[serde(default)]
    pub notes: Vec<String>,
}

// ---------------------------------------------------------------- colour math

pub(crate) type Rgb = [u8; 3];

pub fn rgb(hex: &str) -> Result<Rgb, String> {
    crate::graphics::color(hex)
}
pub fn hex(c: Rgb) -> String {
    format!("#{:02X}{:02X}{:02X}", c[0], c[1], c[2])
}
/// BT.601 luma, the measure FFmpeg's blackframe filter uses on the Y plane.
pub fn luma(c: Rgb) -> f64 {
    0.299 * c[0] as f64 + 0.587 * c[1] as f64 + 0.114 * c[2] as f64
}
fn relative(c: Rgb) -> f64 {
    let lin = |v: u8| {
        let v = v as f64 / 255.0;
        if v <= 0.04045 {
            v / 12.92
        } else {
            ((v + 0.055) / 1.055).powf(2.4)
        }
    };
    0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2])
}
/// WCAG contrast ratio.
pub fn contrast(a: Rgb, b: Rgb) -> f64 {
    let (x, y) = (relative(a), relative(b));
    (x.max(y) + 0.05) / (x.min(y) + 0.05)
}

// ---------------------------------------------------------------- validation

fn plain(text: &str, max: usize) -> bool {
    let lower = text.to_ascii_lowercase();
    !text.trim().is_empty()
        && text.chars().count() <= max
        && !text.chars().any(char::is_control)
        && !lower.contains("://")
        && !lower.contains("file:")
        && !text.contains("```")
        && !text.contains("../")
        && !text.contains('<')
        && !text.starts_with('/')
}
fn valid_id(id: &str, origin: Origin) -> bool {
    match origin {
        Origin::Builtin => {
            id.starts_with("builtin-")
                && id.len() <= 40
                && id
                    .bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        }
        _ => uuid::Uuid::parse_str(id).is_ok_and(|u| u.hyphenated().to_string() == id),
    }
}
fn in_range(v: f64, min: f64, max: f64) -> bool {
    v.is_finite() && (min..=max).contains(&v)
}
fn is_sha256(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| b.is_ascii_hexdigit())
}

pub fn validate(r: &Reference) -> Result<(), String> {
    if r.version != 1 || !valid_id(&r.id, r.origin) {
        return Err("레퍼런스 버전 또는 ID를 확인하세요.".into());
    }
    if !plain(&r.name, 40) {
        return Err("레퍼런스 이름은 1~40자의 일반 문자여야 합니다.".into());
    }
    let p = &r.palette;
    let (bg, surface, text, accent) = (
        rgb(&p.background)?,
        rgb(&p.surface)?,
        rgb(&p.text)?,
        rgb(&p.accent)?,
    );
    rgb(&p.accent2)?;
    if luma(bg) < MIN_BACKGROUND_LUMA {
        return Err("배경색이 너무 어두워 품질 검사에서 검은 화면으로 판정됩니다.".into());
    }
    if contrast(text, bg) < MIN_TEXT_CONTRAST || contrast(text, surface) < MIN_TEXT_CONTRAST {
        return Err("글자색과 배경·패널색의 대비는 4.5:1 이상이어야 합니다.".into());
    }
    if contrast(accent, bg) < MIN_ACCENT_CONTRAST {
        return Err("강조색과 배경색의 대비는 3:1 이상이어야 합니다.".into());
    }
    let t = &r.typography;
    if !(56..=160).contains(&t.headline) || !(24..=72).contains(&t.body) || t.body >= t.headline {
        return Err("글자 크기는 제목 56~160, 본문 24~72(제목보다 작게)입니다.".into());
    }
    let h = &r.rhythm;
    if !in_range(h.first_delay, 0.0, 1.0)
        || !in_range(h.stagger, 0.1, 1.0)
        || !in_range(h.scene_sec, 2.5, 8.0)
    {
        return Err("리듬은 첫 등장 0~1초, 간격 0.1~1초, 장면 2.5~8초입니다.".into());
    }
    if r.notes.len() > 6 || r.notes.iter().any(|n| !plain(n, 120)) {
        return Err("레퍼런스 메모는 120자 이하 6개까지입니다.".into());
    }
    match (r.origin, &r.source) {
        (Origin::Builtin, None) => {}
        (Origin::Project, Some(s))
            if s.project_hash.as_deref().is_some_and(is_sha256)
                && s.sha256.is_none()
                && s.kind.is_none() => {}
        (Origin::Media, Some(s))
            if s.sha256.as_deref().is_some_and(is_sha256)
                && s.project_hash.is_none()
                && s.kind.is_some()
                && s.width.is_some_and(|w| (1..=MAX_MEDIA_SIDE).contains(&w))
                && s.height.is_some_and(|h| (1..=MAX_MEDIA_SIDE).contains(&h))
                && s.duration_sec
                    .is_none_or(|d| in_range(d, 0.0, MAX_VIDEO_SEC)) => {}
        _ => return Err("레퍼런스 출처 기록이 종류와 맞지 않습니다.".into()),
    }
    Ok(())
}

pub fn parse(value: &Value) -> Result<Reference, String> {
    let r: Reference = serde_json::from_value(value.clone())
        .map_err(|_| "레퍼런스 구조를 확인하세요. 정해진 필드와 값만 쓸 수 있습니다.")?;
    validate(&r)?;
    Ok(r)
}

/// The tokens a model may see: no id, name, source or notes (free text stays local).
pub fn model_tokens(r: &Reference) -> Value {
    serde_json::json!({"palette": r.palette, "type": r.typography, "composition": r.composition,
        "motion": r.motion, "decor": r.decor, "rhythm": r.rhythm})
}

// ---------------------------------------------------------------- built-in references

#[allow(clippy::too_many_arguments)]
fn builtin(
    id: &str,
    name: &str,
    colors: [&str; 5],
    (headline, body): (u32, u32),
    composition: Composition,
    (enter, accent, exit): (Enter, AccentMotion, Exit),
    decor: Decor,
    (first_delay, stagger, scene_sec): (f64, f64, f64),
) -> Reference {
    Reference {
        version: 1,
        id: id.into(),
        name: name.into(),
        origin: Origin::Builtin,
        source: None,
        palette: Palette {
            background: colors[0].into(),
            surface: colors[1].into(),
            text: colors[2].into(),
            accent: colors[3].into(),
            accent2: colors[4].into(),
        },
        typography: TypeScale { headline, body },
        composition,
        motion: Motion {
            enter,
            accent,
            exit,
        },
        decor,
        rhythm: Rhythm {
            first_delay,
            stagger,
            scene_sec,
        },
        notes: vec![],
    }
}

/// Six original looks. Names describe the look, never a brand or a channel.
pub fn builtins() -> Vec<Reference> {
    use AccentMotion as A;
    vec![
        builtin(
            DEFAULT_ID,
            "한밤 데이터",
            ["#172A45", "#22395C", "#F4F7FB", "#5EEAD4", "#F2B84B"],
            (96, 44),
            Composition::Center,
            (Enter::Rise, A::Draw, Exit::None),
            Decor::Underline,
            (0.3, 0.35, 4.0),
        ),
        builtin(
            "builtin-paper-editorial",
            "종이 에디토리얼",
            ["#F5F0E6", "#E9E1D2", "#1C1C1C", "#B3261E", "#8A817C"],
            (88, 40),
            Composition::LeftRail,
            (Enter::Fade, A::Draw, Exit::None),
            Decor::None,
            (0.2, 0.45, 4.5),
        ),
        builtin(
            "builtin-pop-contrast",
            "강한 대비 팝",
            ["#232323", "#333333", "#FFFFFF", "#FF3DA5", "#22D3EE"],
            (120, 48),
            Composition::Center,
            (Enter::Zoom, A::Zoom, Exit::FadeOut),
            Decor::Ring,
            (0.1, 0.15, 3.0),
        ),
        builtin(
            "builtin-calm-pastel",
            "차분한 파스텔",
            ["#EAF2F8", "#FFFFFF", "#24324A", "#3F5E96", "#F4B6C2"],
            (84, 40),
            Composition::Panel,
            (Enter::Fade, A::Fade, Exit::None),
            Decor::None,
            (0.4, 0.6, 6.0),
        ),
        builtin(
            "builtin-bold-block",
            "굵은 색 블록",
            ["#F7F7F2", "#FFFFFF", "#111111", "#D62839", "#FFD60A"],
            (112, 46),
            Composition::LeftRail,
            (Enter::Slide, A::Zoom, Exit::None),
            Decor::Block,
            (0.15, 0.25, 3.5),
        ),
        builtin(
            "builtin-mono-minimal",
            "흑백 미니멀",
            ["#FAFAFA", "#F0F0F0", "#111111", "#111111", "#9A9A9A"],
            (76, 36),
            Composition::Center,
            (Enter::Fade, A::None, Exit::FadeOut),
            Decor::None,
            (0.5, 0.5, 5.0),
        ),
    ]
}

// ---------------------------------------------------------------- normalisation

pub(crate) fn mix(a: Rgb, b: Rgb, t: f64) -> Rgb {
    let m = |x: u8, y: u8| {
        (x as f64 + (y as f64 - x as f64) * t)
            .round()
            .clamp(0.0, 255.0) as u8
    };
    [m(a[0], b[0]), m(a[1], b[1]), m(a[2], b[2])]
}
pub(crate) fn saturation(c: Rgb) -> u8 {
    c.iter().max().unwrap_or(&0) - c.iter().min().unwrap_or(&0)
}
pub(crate) const WHITE: Rgb = [255, 255, 255];
const INK: Rgb = [17, 17, 17];
const BLACK: Rgb = [0, 0, 0];

fn note(r: &mut Reference, text: &str) {
    if r.notes.len() < 6 && !r.notes.iter().any(|n| n == text) {
        r.notes.push(text.into());
    }
}
pub(crate) fn readable_on(bg: Rgb) -> Rgb {
    [WHITE, INK, BLACK]
        .into_iter()
        .find(|c| contrast(*c, bg) >= MIN_TEXT_CONTRAST)
        .unwrap_or(if contrast(WHITE, bg) >= contrast(BLACK, bg) {
            WHITE
        } else {
            BLACK
        })
}

/// Makes measured values safe for rendering and QA. Every change is recorded in notes.
pub fn normalize(r: &mut Reference) -> Result<(), String> {
    let original = rgb(&r.palette.background)?;
    let mut bg = original;
    let mut step = 0.0;
    while luma(bg) < MIN_BACKGROUND_LUMA && step < 1.0 {
        step += 0.02;
        bg = mix(original, WHITE, step);
    }
    if bg != original {
        r.palette.background = hex(bg);
        note(r, "배경이 품질 검사 기준보다 어두워 조금 밝혔습니다.");
    }
    let mut text = rgb(&r.palette.text)?;
    if contrast(text, bg) < MIN_TEXT_CONTRAST {
        text = readable_on(bg);
        r.palette.text = hex(text);
        note(r, "글자색을 배경과 대비가 충분한 색으로 바꿨습니다.");
    }
    let surface = rgb(&r.palette.surface)?;
    if contrast(text, surface) < MIN_TEXT_CONTRAST {
        let softer = mix(bg, text, 0.08);
        r.palette.surface = hex(if contrast(text, softer) >= MIN_TEXT_CONTRAST {
            softer
        } else {
            bg
        });
        note(r, "패널색을 글자가 읽히는 색으로 바꿨습니다.");
    }
    if contrast(rgb(&r.palette.accent)?, bg) < MIN_ACCENT_CONTRAST {
        r.palette.accent = hex(text);
        note(r, "강조색이 배경과 비슷해 글자색으로 바꿨습니다.");
    }
    rgb(&r.palette.accent2)?;
    let t = &mut r.typography;
    let (headline, body) = (t.headline.clamp(56, 160), t.body.clamp(24, 72));
    let body = body.min(headline - 8);
    if (headline, body) != (t.headline, t.body) {
        t.headline = headline;
        t.body = body;
        note(r, "글자 크기를 허용 범위로 맞췄습니다.");
    }
    let h = &mut r.rhythm;
    let rounded = |v: f64, min: f64, max: f64| ((v.clamp(min, max)) * 100.0).round() / 100.0;
    h.first_delay = rounded(h.first_delay, 0.0, 1.0);
    h.stagger = rounded(h.stagger, 0.1, 1.0);
    h.scene_sec = rounded(h.scene_sec, 2.5, 8.0);
    r.notes.truncate(6);
    validate(r)
}

// ---------------------------------------------------------------- extraction

/// Pixel palettes for image/video references (motion_reference_media.rs).
pub use crate::motion_reference_media::{dominant_colors, from_pixels};

fn median(values: &mut [f64]) -> Option<f64> {
    if values.is_empty() {
        return None;
    }
    values.sort_by(|a, b| a.total_cmp(b));
    let n = values.len();
    Some(if n % 2 == 1 {
        values[n / 2]
    } else {
        (values[n / 2 - 1] + values[n / 2]) / 2.0
    })
}
fn mode<T: Ord + Clone>(values: impl IntoIterator<Item = T>) -> Option<T> {
    let mut counts: std::collections::BTreeMap<T, usize> = Default::default();
    let mut order = Vec::new();
    for v in values {
        let count = counts.entry(v.clone()).or_insert(0);
        if *count == 0 {
            order.push(v);
        }
        *count += 1;
    }
    // Most frequent; ties go to the first seen so the result follows the project order.
    let best = counts.values().copied().max()?;
    order.into_iter().find(|v| counts[v] == best)
}

/// Deterministic extraction from a saved Motion Studio project: colours, sizes, alignment,
/// animation and timing only. Text, image ids and table values are never read into the result.
pub fn from_project(project: &Value, name: &str) -> Result<Reference, String> {
    use crate::graphics::{Animation, Kind};
    crate::media::validate_project(project)?;
    if project.get("motionGraphics").is_none() {
        return Err("모션 그래픽 프로젝트만 레퍼런스로 저장할 수 있습니다.".into());
    }
    let (w, h) = crate::graphics::dimensions(project);
    let (w, h) = (w as f64, h as f64);
    let count = project["scenes"].as_array().map(Vec::len).unwrap_or(0);
    let mut backgrounds = Vec::new();
    let mut text_colors = Vec::new();
    let mut shape_colors = Vec::new();
    let mut largest = Vec::new();
    let mut others = Vec::new();
    let mut enters = Vec::new();
    let mut accents = Vec::new();
    let mut first = Vec::new();
    let mut gaps = Vec::new();
    let mut durations = Vec::new();
    let (mut centered, mut texts_total, mut panel) = (0usize, 0usize, false);
    let (mut lines, mut rings, mut blocks, mut fade_out) = (0, 0, 0, false);
    for index in 0..count {
        let g = crate::graphics::scene(project, index)?;
        backgrounds.push(g.background.to_ascii_uppercase());
        durations.push(
            project["scenes"][index]["durationSec"]
                .as_f64()
                .unwrap_or(4.0),
        );
        let texts: Vec<_> = g.elements.iter().filter(|e| e.kind == Kind::Text).collect();
        let mut sizes: Vec<f64> = texts.iter().filter_map(|e| e.font_size).collect();
        sizes.sort_by(|a, b| b.total_cmp(a));
        if let Some((top, rest)) = sizes.split_first() {
            largest.push(*top);
            others.extend_from_slice(rest);
        }
        let mut starts: Vec<f64> = texts.iter().map(|e| e.start).collect();
        starts.sort_by(|a, b| a.total_cmp(b));
        starts.dedup_by(|a, b| (*a - *b).abs() < 1e-6);
        if let Some(s) = starts.first() {
            first.push(*s);
        }
        gaps.extend(starts.windows(2).map(|p| p[1] - p[0]));
        for e in &g.elements {
            if e.animation == Animation::FadeOut {
                fade_out = true;
            }
            match e.kind {
                Kind::Text => {
                    texts_total += 1;
                    text_colors.push(e.color.to_ascii_uppercase());
                    let cx = e.x + e.width / 2.0;
                    if (cx - w / 2.0).abs() < w * 0.06 && e.width <= w * 0.7 {
                        centered += 1;
                    }
                    enters.push(match e.animation {
                        Animation::Rise => Enter::Rise,
                        Animation::Slide => Enter::Slide,
                        Animation::Zoom => Enter::Zoom,
                        _ => Enter::Fade,
                    });
                }
                Kind::Image => {}
                kind => {
                    shape_colors.push(e.color.to_ascii_uppercase());
                    accents.push(match e.animation {
                        Animation::Draw => AccentMotion::Draw,
                        Animation::Zoom => AccentMotion::Zoom,
                        Animation::None => AccentMotion::None,
                        _ => AccentMotion::Fade,
                    });
                    match kind {
                        Kind::Rectangle if e.width * e.height >= w * h * 0.25 => panel = true,
                        Kind::Rectangle if e.height <= 24.0 || e.width <= 24.0 => lines += 1,
                        Kind::Rectangle => blocks += 1,
                        Kind::Line => lines += 1,
                        Kind::Circle => rings += 1,
                        _ => {}
                    }
                }
            }
        }
    }
    if texts_total == 0 {
        return Err("글자 요소가 있는 모션 프로젝트만 레퍼런스로 저장할 수 있습니다.".into());
    }
    let background = mode(backgrounds).ok_or("장면이 없습니다.")?;
    let text = mode(text_colors).unwrap_or_else(|| "#FFFFFF".into());
    let mut shapes = shape_colors.clone();
    shapes.retain(|c| *c != background);
    let accent = mode(shapes.clone()).unwrap_or_else(|| text.clone());
    shapes.retain(|c| *c != accent);
    let accent2 = mode(shapes).unwrap_or_else(|| accent.clone());
    let headline = median(&mut largest).unwrap_or(96.0);
    let body = median(&mut others).unwrap_or(headline * 0.45);
    let decor = if rings > 0 {
        Decor::Ring
    } else if lines > 0 {
        Decor::Underline
    } else if blocks > 0 {
        Decor::Block
    } else {
        Decor::None
    };
    let composition = if panel {
        Composition::Panel
    } else if centered * 2 > texts_total {
        Composition::Center
    } else {
        Composition::LeftRail
    };
    let bg = rgb(&background)?;
    let mut r = Reference {
        version: 1,
        id: uuid::Uuid::new_v4().to_string(),
        name: name.trim().into(),
        origin: Origin::Project,
        source: Some(Source {
            project_hash: Some(crate::graphics::hash(project)),
            ..Source::default()
        }),
        palette: Palette {
            surface: hex(mix(bg, rgb(&text)?, 0.08)),
            background,
            text,
            accent,
            accent2,
        },
        typography: TypeScale {
            headline: headline.round() as u32,
            body: body.round() as u32,
        },
        composition,
        motion: Motion {
            enter: mode(enters).unwrap_or(Enter::Fade),
            accent: mode(accents).unwrap_or(AccentMotion::Fade),
            exit: if fade_out { Exit::FadeOut } else { Exit::None },
        },
        decor,
        rhythm: Rhythm {
            first_delay: median(&mut first).unwrap_or(0.3),
            stagger: median(&mut gaps).unwrap_or(0.35),
            scene_sec: median(&mut durations).unwrap_or(4.0),
        },
        notes: vec![],
    };
    normalize(&mut r)?;
    Ok(r)
}

// ---------------------------------------------------------------- media files

/// Colour reference from a local image or video (motion_reference_media.rs).
pub use crate::motion_reference_media::from_media;

// ---------------------------------------------------------------- store

pub fn root_dir() -> Result<PathBuf, String> {
    Ok(crate::media::data_dir()?.join("motion-references"))
}
fn file_for(root: &Path, id: &str) -> Result<PathBuf, String> {
    if !valid_id(id, Origin::Media) {
        return Err("레퍼런스 ID 형식 오류".into());
    }
    Ok(root.join(format!("{id}.json")))
}
fn read_file(path: &Path) -> Result<Reference, String> {
    let meta = std::fs::symlink_metadata(path).map_err(|_| "레퍼런스를 찾을 수 없습니다.")?;
    if !meta.is_file() || meta.file_type().is_symlink() || meta.len() > 64 * 1024 {
        return Err("레퍼런스 파일 형식 오류".into());
    }
    let value: Value =
        serde_json::from_slice(&std::fs::read(path).map_err(|_| "레퍼런스를 읽을 수 없습니다.")?)
            .map_err(|_| "레퍼런스 파일이 손상되었습니다.")?;
    parse(&value)
}

/// Built-ins first, then saved references by name. Unreadable files are counted, not hidden.
pub fn list_at(root: &Path) -> Result<(Vec<Reference>, usize), String> {
    let mut saved = Vec::new();
    let mut skipped = 0;
    match std::fs::read_dir(root) {
        Ok(entries) => {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.extension().is_none_or(|e| e != "json") {
                    continue;
                }
                match read_file(&path) {
                    Ok(r) if r.origin != Origin::Builtin => saved.push(r),
                    _ => skipped += 1,
                }
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(_) => return Err("레퍼런스 폴더를 읽을 수 없습니다.".into()),
    }
    saved.sort_by(|a, b| a.name.cmp(&b.name).then(a.id.cmp(&b.id)));
    let mut all = builtins();
    all.extend(saved);
    Ok((all, skipped))
}
pub fn get_at(root: &Path, id: &str) -> Result<Reference, String> {
    if let Some(r) = builtins().into_iter().find(|r| r.id == id) {
        return Ok(r);
    }
    read_file(&file_for(root, id)?)
}
pub fn save_at(root: &Path, r: &Reference) -> Result<(), String> {
    validate(r)?;
    if r.origin == Origin::Builtin {
        return Err("기본 레퍼런스는 저장하지 않습니다.".into());
    }
    let path = file_for(root, &r.id)?;
    std::fs::create_dir_all(root).map_err(|_| "레퍼런스 폴더를 만들 수 없습니다.")?;
    if !path.exists() && list_at(root)?.0.len() - builtins().len() >= MAX_SAVED {
        return Err(format!(
            "레퍼런스는 {MAX_SAVED}개까지 저장합니다. 안 쓰는 것을 지우세요."
        ));
    }
    let mut temporary = tempfile::NamedTempFile::new_in(root).map_err(|_| "레퍼런스 저장 실패")?;
    serde_json::to_writer_pretty(&mut temporary, r).map_err(|_| "레퍼런스 저장 실패")?;
    temporary
        .as_file()
        .sync_all()
        .map_err(|_| "레퍼런스 저장 실패")?;
    temporary.persist(&path).map_err(|_| "레퍼런스 저장 실패")?;
    Ok(())
}
pub fn delete_at(root: &Path, id: &str) -> Result<(), String> {
    if builtins().iter().any(|r| r.id == id) {
        return Err("기본 레퍼런스는 지울 수 없습니다.".into());
    }
    let path = file_for(root, id)?;
    read_file(&path)?;
    std::fs::remove_file(path).map_err(|_| "레퍼런스를 지우지 못했습니다.".into())
}

#[cfg(test)]
#[path = "motion_reference_tests.rs"]
mod tests;
