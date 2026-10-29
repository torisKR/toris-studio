//! AI video production jobs: topic → storyboard → AI scenes → narration → subtitles → edit → QA.
//!
//! Every job is a folder with job.json that is rewritten atomically after each state change,
//! so an app restart resumes from the last finished unit. Scene videos and voices are cached
//! by a hash of their inputs; regenerating one scene invalidates only what depends on it.
//! The model only writes the storyboard (validated data). Paths, commands and filters are
//! decided here.
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{Arc, Mutex as StdMutex},
};
use tokio::sync::watch;
use uuid::Uuid;

pub const DURATIONS: [u32; 3] = [15, 30, 60];
pub const ASPECTS: [&str; 3] = ["9:16", "16:9", "1:1"];
pub const STYLES: [&str; 4] = ["realistic", "cinematic", "animation", "documentary"];
pub const QUALITIES: [&str; 3] = ["preview", "standard", "high"];
pub const SUBTITLES: [&str; 3] = ["shorts-bold", "clean-bottom", "none"];
pub const BGMS: [&str; 3] = ["none", "ambient", "pulse"];
/// Scene source: licence-cleared stock photo with motion graphics, or a local Wan2.1 clip.
pub const VISUALS: [&str; 2] = ["stock", "ai"];
/// "card": fixed two-line title on top, media in the middle, captions and credit (shorts style).
pub const LAYOUTS: [&str; 2] = ["card", "full"];
pub const CAMERAS: [&str; 5] = ["zoom-in", "zoom-out", "pan-left", "pan-right", "pan-up"];
/// Stock photos per scene the user can choose from.
pub const CANDIDATES: usize = 3;
pub const STAGES: [&str; 7] = [
    "plan",
    "storyboard",
    "scenes",
    "voice",
    "subtitles",
    "edit",
    "qa",
];
const MAX_JOBS: usize = 50;

/// What the user asked for. Closed values only.
#[derive(Clone, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Settings {
    pub topic: String,
    pub duration_sec: u32,
    pub aspect: String,
    pub style: String,
    pub narration: bool,
    #[serde(default = "default_speaker")]
    pub speaker: String,
    pub subtitle_style: String,
    pub bgm: String,
    pub quality: String,
    pub engine: String,
    /// Jobs saved before 0.6 have neither field; they were AI clips composed full-frame.
    #[serde(default = "default_visual")]
    pub visual: String,
    #[serde(default = "default_layout")]
    pub layout: String,
}
fn default_speaker() -> String {
    "Sohee".into()
}
fn default_visual() -> String {
    "ai".into()
}
fn default_layout() -> String {
    "full".into()
}

pub fn parse_settings(input: &Value) -> Result<Settings, String> {
    let settings: Settings = serde_json::from_value(input.clone())
        .map_err(|e| format!("제작 설정을 확인하세요. ({e})"))?;
    let topic = settings.topic.trim();
    if topic.is_empty()
        || topic.chars().count() > 300
        || topic.chars().any(|c| c.is_control() && c != '\n')
    {
        return Err("영상 주제는 1~300자로 입력하세요.".into());
    }
    if !(10..=120).contains(&settings.duration_sec) {
        return Err("영상 길이는 10~120초입니다.".into());
    }
    let check = |value: &str, allowed: &[&str], what: &str| {
        if allowed.contains(&value) {
            Ok(())
        } else {
            Err(format!("{what} 값을 확인하세요."))
        }
    };
    check(&settings.aspect, &ASPECTS, "화면 비율")?;
    check(&settings.style, &STYLES, "영상 스타일")?;
    check(&settings.quality, &QUALITIES, "품질")?;
    check(&settings.subtitle_style, &SUBTITLES, "자막 스타일")?;
    check(&settings.bgm, &BGMS, "배경음악")?;
    check(&settings.speaker, crate::tts_runtime::SPEAKERS, "화자")?;
    check(&settings.visual, &VISUALS, "장면 소스")?;
    check(&settings.layout, &LAYOUTS, "화면 구성")?;
    // Stock-photo jobs never run the video engine; an empty choice means the default engine.
    let engine = if settings.engine.is_empty() && settings.visual == "stock" {
        crate::video_runtime::DEFAULT_ENGINE.to_owned()
    } else {
        settings.engine.clone()
    };
    crate::video_runtime::engine(&engine)?;
    Ok(Settings {
        topic: topic.into(),
        engine,
        ..settings
    })
}

/// Final output size per aspect; generation size is lower and shown separately.
pub fn output_size(aspect: &str) -> (u32, u32) {
    match aspect {
        "16:9" => (1920, 1080),
        "1:1" => (1080, 1080),
        _ => (1080, 1920),
    }
}

/// Stock photo cuts are shorter (about 3.5 s, like shorts); AI clips stay about 5 s.
pub fn scene_count(duration: u32, visual: &str) -> usize {
    let each = if visual == "stock" { 3.5 } else { 5.0 };
    ((duration as f64 / each).ceil() as usize).clamp(if visual == "stock" { 3 } else { 2 }, 12)
}

fn bad_text(text: &str) -> bool {
    let lower = text.to_ascii_lowercase();
    text.chars().any(|c| c.is_control() && c != '\n')
        || lower.contains("http://")
        || lower.contains("https://")
        || lower.contains("file:")
        || text.contains("```")
        || text.contains("../")
        || text.contains("<script")
        || lower.contains("$(")
        || text.starts_with('/')
}

/// The storyboard is model output: accept only the fields and ranges the editor understands.
pub fn validate_storyboard(raw: &Value, settings: &Settings) -> Result<Value, String> {
    let object = raw
        .as_object()
        .ok_or("스토리보드는 JSON 객체여야 합니다.")?;
    for key in object.keys() {
        if ![
            "title", "story", "style", "scenes", "template", "provider", "model", "headline",
        ]
        .contains(&key.as_str())
        {
            return Err(format!("스토리보드에 지원하지 않는 필드가 있습니다: {key}"));
        }
    }
    let text = |value: &Value, key: &str, max: usize, required: bool| -> Result<String, String> {
        let raw = value
            .get(key)
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .to_owned();
        if (required && raw.is_empty()) || raw.chars().count() > max || bad_text(&raw) {
            return Err(format!("스토리보드 {key} 값을 확인하세요."));
        }
        Ok(raw)
    };
    let title = text(raw, "title", 120, true)?;
    // Two fixed title lines shown above the media in the card layout (white, then yellow).
    let headline = raw.get("headline").cloned().unwrap_or(json!({}));
    if !headline.is_object() {
        return Err("스토리보드 headline 형식을 확인하세요.".into());
    }
    let headline = json!({"top": text(&headline, "top", 18, false)?, "bottom": text(&headline, "bottom", 18, false)?});
    let story = text(raw, "story", 1200, false)?;
    let style = raw.get("style").cloned().unwrap_or(json!({}));
    let style = json!({"look": text(&style, "look", 300, false)?, "palette": text(&style, "palette", 200, false)?, "consistency": text(&style, "consistency", 400, false)?});
    let scenes = raw["scenes"].as_array().ok_or("장면 목록이 없습니다.")?;
    if !(2..=12).contains(&scenes.len()) {
        return Err("장면은 2~12개여야 합니다.".into());
    }
    let mut ids = std::collections::HashSet::new();
    let mut total = 0.0;
    let mut out = Vec::new();
    for (index, scene) in scenes.iter().enumerate() {
        let keys = scene.as_object().ok_or("장면 형식 오류")?;
        for key in keys.keys() {
            if ![
                "id",
                "order",
                "durationSec",
                "script",
                "narration",
                "caption",
                "prompt",
                "negativePrompt",
                "transition",
                "search",
                "emphasis",
                "camera",
                "stat",
                "imageId",
            ]
            .contains(&key.as_str())
            {
                return Err(format!("장면에 지원하지 않는 필드가 있습니다: {key}"));
            }
        }
        let id = scene["id"].as_str().unwrap_or("").to_owned();
        if id.is_empty()
            || id.len() > 40
            || !id
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
            || !ids.insert(id.clone())
        {
            return Err("장면 ID는 중복 없는 영문·숫자·-·_이어야 합니다.".into());
        }
        let duration = scene["durationSec"]
            .as_f64()
            .filter(|d| d.is_finite() && (2.0..=12.0).contains(d))
            .ok_or("장면 길이는 2~12초여야 합니다.")?;
        total += duration;
        let transition = scene
            .get("transition")
            .and_then(Value::as_str)
            .unwrap_or("cut");
        if !["cut", "fade", "dip"].contains(&transition) {
            return Err("장면 전환은 cut, fade, dip 중 하나입니다.".into());
        }
        let narration = text(scene, "narration", 400, false)?;
        let search = text(scene, "search", 80, false)?;
        let search = if search.is_empty() {
            String::new()
        } else {
            crate::stock_media::clean_query(&search)
                .ok_or(format!("{}번 장면의 사진 검색어를 확인하세요.", index + 1))?
        };
        let emphasis: Vec<String> = match scene.get("emphasis") {
            None | Some(Value::Null) => vec![],
            Some(Value::Array(words)) if words.len() <= 3 => words
                .iter()
                .map(|w| {
                    w.as_str()
                        .map(str::trim)
                        .filter(|w| !w.is_empty() && w.chars().count() <= 12 && !bad_text(w))
                        .map(str::to_owned)
                })
                .collect::<Option<Vec<_>>>()
                .ok_or(format!(
                    "{}번 장면의 강조 단어는 12자 이하 3개까지입니다.",
                    index + 1
                ))?,
            _ => {
                return Err(format!(
                    "{}번 장면의 강조 단어는 12자 이하 3개까지입니다.",
                    index + 1
                ))
            }
        };
        let camera = scene
            .get("camera")
            .and_then(Value::as_str)
            .unwrap_or("zoom-in");
        if !CAMERAS.contains(&camera) {
            return Err(format!(
                "{}번 장면의 카메라 움직임을 확인하세요.",
                index + 1
            ));
        }
        let stat = match scene.get("stat") {
            None | Some(Value::Null) => Value::Null,
            Some(stat) if stat.is_object() => {
                let value = text(stat, "value", 12, true)
                    .map_err(|_| format!("{}번 장면 숫자 카드는 12자 이하입니다.", index + 1))?;
                json!({"value": value, "label": text(stat, "label", 24, false)?})
            }
            _ => return Err(format!("{}번 장면 숫자 카드 형식을 확인하세요.", index + 1)),
        };
        let image_id = scene.get("imageId").and_then(Value::as_str).unwrap_or("");
        if image_id.len() > 80
            || !image_id
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
        {
            return Err(format!("{}번 장면에서 고른 사진을 확인하세요.", index + 1));
        }
        if settings.narration && narration.is_empty() {
            return Err(format!("{}번 장면의 나레이션이 비어 있습니다.", index + 1));
        }
        out.push(json!({"id": id, "order": index + 1, "durationSec": (duration * 10.0).round() / 10.0,
            "script": text(scene, "script", 600, false)?, "narration": narration, "caption": text(scene, "caption", 160, false)?,
            "prompt": text(scene, "prompt", 600, settings.visual == "ai")?, "negativePrompt": text(scene, "negativePrompt", 300, false)?, "transition": transition,
            "search": search, "emphasis": emphasis, "camera": camera, "stat": stat, "imageId": image_id}));
    }
    if (total - settings.duration_sec as f64).abs() > settings.duration_sec as f64 * 0.25 + 1.0 {
        return Err(format!(
            "장면 길이 합계 {total:.0}초가 목표 {}초와 크게 다릅니다.",
            settings.duration_sec
        ));
    }
    Ok(
        json!({"title": title, "headline": headline, "story": story, "style": style, "scenes": out, "template": raw["template"] == true,
              "provider": raw["provider"].as_str().unwrap_or(""), "model": raw["model"].as_str().unwrap_or("")}),
    )
}

/// Visual prompt the engine receives: scene prompt + the shared style so scenes look consistent.
pub fn scene_prompt(storyboard: &Value, scene: &Value, settings: &Settings) -> String {
    let style = match settings.style.as_str() {
        "realistic" => "photorealistic, natural light, realistic textures",
        "animation" => "high quality 3D animation style, soft shading, vibrant",
        "documentary" => "documentary footage, handheld camera, natural colors",
        _ => "cinematic, dramatic lighting, shallow depth of field, film grain",
    };
    let consistency = storyboard["style"]["consistency"].as_str().unwrap_or("");
    let palette = storyboard["style"]["palette"].as_str().unwrap_or("");
    let prompt = format!(
        "{}. {style}. {consistency} {palette}",
        scene["prompt"].as_str().unwrap_or("").trim_end_matches('.')
    );
    prompt
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(1100)
        .collect()
}

pub fn cache_key(value: &Value) -> String {
    format!("{:x}", Sha256::digest(value.to_string().as_bytes()))[..16].to_owned()
}

pub fn video_key(
    engine: &str,
    prompt: &str,
    negative: &str,
    size: &str,
    frames: u32,
    steps: u32,
    seed: u32,
) -> String {
    let revision = crate::video_runtime::engine(engine)
        .map(|e| e.revision)
        .unwrap_or("");
    cache_key(
        &json!({"engine": engine, "revision": revision, "prompt": prompt, "negative": negative, "size": size, "frames": frames, "steps": steps, "seed": seed}),
    )
}

pub fn voice_key(settings: &Settings, narration: &str) -> String {
    cache_key(
        &json!({"model": "qwen3-tts-1.7b-customvoice-8bit", "speaker": settings.speaker, "style": "natural", "quality": "stable", "narration": narration}),
    )
}

/// Korean-aware caption split: sentence ends first, then commas, then length.
pub fn split_caption(text: &str, max: usize) -> Vec<String> {
    let mut parts: Vec<String> = Vec::new();
    let mut current = String::new();
    for ch in text.chars() {
        current.push(ch);
        let end = matches!(ch, '.' | '!' | '?' | '。' | '…')
            || (ch == ',' && current.chars().count() >= max / 2);
        if end || current.chars().count() >= max {
            let trimmed = current.trim().to_owned();
            if !trimmed.is_empty() {
                parts.push(trimmed);
            }
            current.clear();
        }
    }
    if !current.trim().is_empty() {
        parts.push(current.trim().to_owned());
    }
    parts
}

/// Cues spread over the measured voice length by character count; never past the scene end.
pub fn caption_cues(text: &str, voice_sec: f64, scene_sec: f64) -> Vec<(f64, f64, String)> {
    let parts = split_caption(&crate::production::spoken(text), 22);
    let total: usize = parts
        .iter()
        .map(|p| p.chars().count())
        .sum::<usize>()
        .max(1);
    let span = voice_sec.min(scene_sec).max(0.5);
    let mut at = 0.0;
    parts
        .into_iter()
        .map(|p| {
            let length = span * p.chars().count() as f64 / total as f64;
            let cue = (at, (at + length).min(scene_sec), p);
            at += length;
            cue
        })
        .collect()
}

/// Text a viewer hears (narration tags and stress markers removed), same rule as lib/video/voice-options.ts.
pub fn spoken(text: &str) -> String {
    text.lines()
        .map(|line| {
            let mut line = line.trim();
            while let Some(rest) = line.strip_prefix('[') {
                let Some(end) = rest.find(']') else { break };
                let token = &rest[..end];
                let known = crate::tts_runtime::SPEAKERS
                    .iter()
                    .any(|s| s.eq_ignore_ascii_case(token))
                    || [
                        "자연스럽게",
                        "차분한 다큐",
                        "IT 뉴스",
                        "활기찬 쇼츠",
                        "감성 스토리",
                        "광고·제품 소개",
                        "강조",
                        "속삭이듯",
                    ]
                    .contains(&token)
                    || token
                        .strip_prefix("쉼:")
                        .is_some_and(|n| n.trim().chars().all(|c| c.is_ascii_digit()));
                if !known {
                    break;
                }
                line = rest[end + 1..].trim_start();
            }
            line.replace("**", "")
        })
        .filter(|l| !l.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}

fn srt_time(seconds: f64) -> String {
    let ms = (seconds * 1000.0).round().max(0.0) as u64;
    format!(
        "{:02}:{:02}:{:02},{:03}",
        ms / 3_600_000,
        ms / 60_000 % 60,
        ms / 1000 % 60,
        ms % 1000
    )
}

pub fn srt(cues: &[(f64, f64, String)]) -> String {
    cues.iter()
        .enumerate()
        .map(|(i, (start, end, text))| {
            format!(
                "{}\n{} --> {}\n{}\n",
                i + 1,
                srt_time(*start),
                srt_time(*end),
                text
            )
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// Deterministic BGM as raw PCM16 mono 48kHz: soft chord pad or a gentle pulse. No third-party audio.
pub fn synth_bgm(kind: &str, seconds: f64) -> Vec<u8> {
    let rate = 48_000.0;
    let total = (seconds * rate) as usize;
    let chords: [[f64; 3]; 4] = [
        [220.0, 277.18, 329.63],
        [196.0, 246.94, 293.66],
        [174.61, 220.0, 261.63],
        [196.0, 246.94, 311.13],
    ];
    let mut out = Vec::with_capacity(total * 2);
    for n in 0..total {
        let t = n as f64 / rate;
        let chord = chords[((t / 4.0) as usize) % 4];
        let mut sample: f64 = chord
            .iter()
            .enumerate()
            .map(|(i, f)| (2.0 * std::f64::consts::PI * f * t + i as f64).sin())
            .sum::<f64>()
            / 3.0;
        if kind == "pulse" {
            let beat = (t * 2.0).fract();
            sample = sample * 0.6
                + (2.0 * std::f64::consts::PI * 55.0 * t).sin() * (-beat * 8.0).exp() * 0.8;
        }
        let fade = (t / 2.0).min(1.0).min(((seconds - t) / 2.0).max(0.0));
        let value = (sample * 0.18 * fade * i16::MAX as f64) as i16;
        out.extend_from_slice(&value.to_le_bytes());
    }
    out
}

pub fn wav(pcm: &[u8], rate: u32) -> Vec<u8> {
    let mut out = Vec::with_capacity(44 + pcm.len());
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&(36 + pcm.len() as u32).to_le_bytes());
    out.extend_from_slice(b"WAVEfmt ");
    out.extend_from_slice(&16u32.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes());
    out.extend_from_slice(&rate.to_le_bytes());
    out.extend_from_slice(&(rate * 2).to_le_bytes());
    out.extend_from_slice(&2u16.to_le_bytes());
    out.extend_from_slice(&16u16.to_le_bytes());
    out.extend_from_slice(b"data");
    out.extend_from_slice(&(pcm.len() as u32).to_le_bytes());
    out.extend_from_slice(pcm);
    out
}

// ---------------------------------------------------------------- job store

pub fn root() -> Result<PathBuf, String> {
    Ok(crate::media::data_dir()?.join("productions"))
}
/// Media the renderer may read lives under the public media folder.
pub fn media_root() -> Result<PathBuf, String> {
    Ok(crate::media::public_dir()?.join("productions"))
}

fn job_dir(root: &Path, id: &str) -> Result<PathBuf, String> {
    Uuid::parse_str(id).map_err(|_| "작업 ID 형식 오류")?;
    Ok(root.join(id))
}

pub fn write_json(path: &Path, value: &Value) -> Result<(), String> {
    let dir = path.parent().ok_or("저장 경로 오류")?;
    std::fs::create_dir_all(dir).map_err(|_| "작업 폴더를 만들 수 없습니다.")?;
    let mut temp = tempfile::NamedTempFile::new_in(dir).map_err(|_| "임시 파일 오류")?;
    use std::io::Write;
    temp.write_all(&serde_json::to_vec_pretty(value).map_err(|_| "JSON 오류")?)
        .and_then(|_| temp.as_file().sync_all())
        .map_err(|_| "작업 저장 실패")?;
    temp.persist(path).map_err(|_| "작업 저장 실패")?;
    Ok(())
}

pub fn read_job(root: &Path, id: &str) -> Result<Value, String> {
    let path = job_dir(root, id)?.join("job.json");
    serde_json::from_slice(&std::fs::read(path).map_err(|_| "작업을 찾을 수 없습니다.")?)
        .map_err(|_| "작업 파일이 손상되었습니다.".into())
}

pub fn list_jobs(root: &Path) -> Vec<Value> {
    let mut jobs: Vec<Value> = std::fs::read_dir(root).into_iter().flatten().flatten()
        .filter_map(|entry| read_job(root, &entry.file_name().to_string_lossy()).ok())
        .map(|job| json!({"id": job["id"], "title": job["storyboard"]["title"].as_str().unwrap_or(job["settings"]["topic"].as_str().unwrap_or("")),
            "status": job["status"], "stage": job["stage"], "createdAt": job["createdAt"], "updatedAt": job["updatedAt"], "settings": job["settings"]}))
        .collect();
    jobs.sort_by(|a, b| b["createdAt"].as_str().cmp(&a["createdAt"].as_str()));
    jobs.truncate(MAX_JOBS);
    jobs
}

fn now() -> String {
    chrono::Utc::now().to_rfc3339()
}

pub fn new_job(settings: &Settings) -> Value {
    let id = Uuid::new_v4().to_string();
    let stages: serde_json::Map<String, Value> = STAGES
        .iter()
        .map(|s| {
            (
                (*s).to_owned(),
                json!({"status": "pending", "done": 0, "total": 0}),
            )
        })
        .collect();
    let (gen, frames, steps) =
        crate::video_runtime::generation_size(&settings.aspect, &settings.quality)
            .unwrap_or(("832x480", 49, 30));
    let (w, h) = output_size(&settings.aspect);
    json!({"version": 1, "id": id, "settings": settings, "status": "planning", "stage": "plan", "stages": stages,
        "generation": {"size": gen, "frames": frames, "steps": steps, "fps": 16, "output": format!("{w}x{h}")},
        "storyboard": null, "scenes": [], "outputs": {}, "qa": null, "provenance": null, "errors": [], "metrics": [],
        "createdAt": now(), "updatedAt": now()})
}

/// After a restart nothing is running: a stage that was running goes back to pending so
/// resume() picks it up from its cached files. A job waiting for approval keeps waiting.
pub fn recover(job: &mut Value) -> bool {
    let mut changed = false;
    if job["status"] == "running" || job["status"] == "planning" {
        job["status"] = json!("paused");
        changed = true;
    }
    if let Some(stages) = job["stages"].as_object_mut() {
        for stage in stages.values_mut() {
            if stage["status"] == "running" {
                stage["status"] = json!("pending");
                changed = true;
            }
        }
    }
    if let Some(scenes) = job["scenes"].as_array_mut() {
        for scene in scenes {
            for part in ["video", "voice"] {
                if scene[part]["status"] == "running" {
                    scene[part]["status"] = json!("pending");
                    changed = true;
                }
            }
        }
    }
    changed
}

/// Marks a stage and everything after it as needing work again.
pub fn invalidate_from(job: &mut Value, stage: &str) {
    let Some(start) = STAGES.iter().position(|s| *s == stage) else {
        return;
    };
    for later in &STAGES[start..] {
        job["stages"][*later]["status"] = json!("pending");
        job["stages"][*later]["done"] = json!(0);
    }
    if start <= STAGES.iter().position(|s| *s == "edit").unwrap() {
        job["outputs"] = json!({});
        job["qa"] = Value::Null;
    }
}

/// Builds scene entries from an approved storyboard, keeping cached results whose keys still match.
/// Who planned the storyboard comes from the planner's own draft. The window sends only the edited
/// content, so it can neither drop nor forge the AI/template origin recorded in provenance.
pub fn with_plan_origin(mut storyboard: Value, draft: &Value) -> Value {
    if let Some(board) = storyboard.as_object_mut() {
        for key in ["template", "provider", "model"] {
            match draft.get(key) {
                Some(value) if !value.is_null() => board.insert(key.into(), value.clone()),
                _ => board.remove(key),
            };
        }
    }
    storyboard
}

pub fn apply_storyboard(job: &mut Value, storyboard: Value) -> Result<(), String> {
    let settings: Settings =
        serde_json::from_value(job["settings"].clone()).map_err(|_| "작업 설정 오류")?;
    let storyboard = validate_storyboard(&storyboard, &settings)?;
    let previous: HashMap<String, Value> = job["scenes"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|s| s["id"].as_str().map(|id| (id.to_owned(), s.clone())))
        .collect();
    let generation = job["generation"].clone();
    let mut scenes = Vec::new();
    for (index, scene) in storyboard["scenes"].as_array().unwrap().iter().enumerate() {
        let id = scene["id"].as_str().unwrap().to_owned();
        let narration = scene["narration"].as_str().unwrap_or("").to_owned();
        let akey = voice_key(&settings, &narration);
        let old = previous.get(&id);
        let keep = |part: &str, key: &str| {
            old.filter(|o| o[part]["key"] == key && o[part]["status"] == "done")
                .map(|o| o[part].clone())
        };
        let voice = if settings.narration && !narration.is_empty() {
            keep("voice", &akey).unwrap_or_else(|| json!({"status": "pending", "key": akey}))
        } else {
            json!({"status": "skipped", "key": akey})
        };
        if settings.visual == "stock" {
            let chosen = chosen_candidate(job, &id, scene["imageId"].as_str().unwrap_or(""));
            let video = stock_entry(chosen.as_ref(), &id);
            let key = video["key"].as_str().unwrap_or("").to_owned();
            let video = keep("video", &key).unwrap_or(video);
            scenes.push(json!({"id": id, "order": index + 1, "durationSec": scene["durationSec"], "video": video, "voice": voice}));
            continue;
        }
        let prompt = scene_prompt(&storyboard, scene, &settings);
        let negative = scene["negativePrompt"]
            .as_str()
            .filter(|s| !s.is_empty())
            .unwrap_or("Text, watermarks, blurry image, JPEG artifacts, distorted faces")
            .to_owned();
        let seed = (u32::from_str_radix(&cache_key(&json!([job["id"], id]))[..8], 16).unwrap_or(0))
            % 2_000_000_000;
        let vkey = video_key(
            &settings.engine,
            &prompt,
            &negative,
            generation["size"].as_str().unwrap_or(""),
            generation["frames"].as_u64().unwrap_or(49) as u32,
            generation["steps"].as_u64().unwrap_or(30) as u32,
            seed,
        );
        let video = keep("video", &vkey).unwrap_or_else(|| json!({"status": "pending", "key": vkey, "seed": seed, "prompt": prompt, "negative": negative}));
        scenes.push(json!({"id": id, "order": index + 1, "durationSec": scene["durationSec"], "video": video, "voice": voice}));
    }
    job["storyboard"] = storyboard;
    job["scenes"] = json!(scenes);
    job["stages"]["storyboard"]["status"] = json!("done");
    let total = job["scenes"].as_array().map(Vec::len).unwrap_or(0);
    job["stages"]["scenes"]["total"] = json!(total);
    job["stages"]["voice"]["total"] = json!(job["scenes"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|s| s["voice"]["status"] != "skipped")
        .count());
    invalidate_from(job, "subtitles");
    for (stage, part) in [("scenes", "video"), ("voice", "voice")] {
        let done = job["scenes"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|s| s[part]["status"] == "done")
            .count();
        job["stages"][stage]["done"] = json!(done);
        let all = job["scenes"]
            .as_array()
            .unwrap()
            .iter()
            .all(|s| ["done", "skipped"].contains(&s[part]["status"].as_str().unwrap_or("")));
        job["stages"][stage]["status"] = json!(if all { "done" } else { "pending" });
    }
    Ok(())
}

/// Searches licence-cleared photos for one scene and saves each as a local JPEG the window can
/// preview. Candidates that fail to download or decode are dropped, so every one shown is usable.
pub async fn find_candidates(
    job_id: &str,
    scene: &str,
    query: &str,
    aspect: &str,
    taken: &std::collections::HashSet<String>,
) -> Result<Vec<Value>, String> {
    Uuid::parse_str(job_id).map_err(|_| "작업 ID 형식 오류")?;
    if scene.is_empty()
        || !scene
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err("장면 ID 형식 오류".into());
    }
    // Ask for extra results so photos already used by other scenes can be skipped;
    // repeats are used only when nothing new came back.
    let found =
        crate::stock_media::search(query, aspect, CANDIDATES + 2 + taken.len().min(12)).await?;
    let fresh: Vec<Value> = found
        .iter()
        .filter(|c| !taken.contains(c["url"].as_str().unwrap_or("")))
        .cloned()
        .collect();
    let found = if fresh.is_empty() { found } else { fresh };
    let dir = media_root()?.join(job_id).join("candidates").join(scene);
    let mut kept = Vec::new();
    for mut candidate in found {
        if kept.len() == CANDIDATES {
            break;
        }
        let id = candidate["id"].as_str().unwrap_or("").to_owned();
        if id.is_empty()
            || !id
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
        {
            continue;
        }
        let file = dir.join(format!("{id}.jpg"));
        if let Ok(saved) = crate::stock_media::download(&candidate, &file).await {
            candidate["preview"] =
                json!(format!("/productions/{job_id}/candidates/{scene}/{id}.jpg"));
            candidate["sha256"] = saved["sha256"].clone();
            candidate["sourceSha256"] = saved["sourceSha256"].clone();
            candidate["query"] = json!(query);
            kept.push(candidate);
        }
    }
    if kept.is_empty() {
        return Err(format!(
            "\"{query}\"로 내려받을 수 있는 사진이 없습니다. 검색어를 바꿔 보세요."
        ));
    }
    Ok(kept)
}

/// The candidate the user picked for a scene, else the first one found. None = no photo found.
fn chosen_candidate(job: &Value, scene: &str, image_id: &str) -> Option<Value> {
    let list = job["candidates"][scene].as_array()?;
    list.iter()
        .find(|c| !image_id.is_empty() && c["id"] == image_id)
        .or_else(|| list.first())
        .cloned()
}

/// Scene video entry for a stock photo (or a drawn graphic background when no photo was found).
fn stock_entry(candidate: Option<&Value>, scene: &str) -> Value {
    match candidate {
        Some(c) => json!({"status": "pending", "kind": "stock", "candidate": c,
            "key": cache_key(&json!({"image": c["id"], "sha256": c["sha256"], "url": c["url"]}))}),
        None => {
            json!({"status": "pending", "kind": "graphic", "key": cache_key(&json!({"graphic": scene}))})
        }
    }
}

/// Regenerating one scene: new seed (or same, for a retry), invalidates subtitles→qa only.
pub fn mark_retry(job: &mut Value, scene_id: Option<&str>, stage: &str) -> Result<(), String> {
    match (stage, scene_id) {
        ("scenes" | "voice", Some(id)) => {
            let part = if stage == "scenes" { "video" } else { "voice" };
            let candidates = job["candidates"].as_object().cloned().unwrap_or_default();
            let scene = job["scenes"]
                .as_array_mut()
                .ok_or("장면이 없습니다.")?
                .iter_mut()
                .find(|s| s["id"] == id)
                .ok_or("장면을 찾을 수 없습니다.")?;
            if scene[part]["status"] == "skipped" {
                return Err("나레이션이 없는 장면입니다.".into());
            }
            if part == "video"
                && (scene["video"]["kind"] == "stock" || scene["video"]["kind"] == "graphic")
            {
                // "다른 사진으로": the next candidate in the list (wrapping), or keep the graphic.
                let current = scene["video"]["candidate"]["id"].clone();
                let list = candidates
                    .get(id)
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default();
                let next = list
                    .iter()
                    .position(|c| c["id"] == current)
                    .map(|at| list[(at + 1) % list.len()].clone())
                    .or_else(|| list.first().cloned());
                scene["video"] = stock_entry(next.as_ref(), id);
            } else if part == "video" && scene["video"]["status"] == "done" {
                let seed = (scene["video"]["seed"].as_u64().unwrap_or(0) as u32)
                    .wrapping_mul(1_103_515_245)
                    .wrapping_add(12_345)
                    % 2_000_000_000;
                scene["video"]["seed"] = json!(seed);
            }
            scene[part]["status"] = json!("pending");
            scene[part]["error"] = Value::Null;
            job["stages"][stage]["status"] = json!("pending");
            invalidate_from(job, "subtitles");
        }
        (stage, _) if STAGES.contains(&stage) && stage != "plan" && stage != "storyboard" => {
            invalidate_from(job, stage)
        }
        _ => return Err("다시 실행할 단계를 확인하세요.".into()),
    }
    if job["status"] == "done" || job["status"] == "failed" {
        job["status"] = json!("paused");
    }
    Ok(())
}

/// Next unit of work, in order. None = everything done.
#[derive(Debug, PartialEq)]
pub enum Work {
    Scene(String),
    Voice(String),
    Subtitles,
    Edit,
    Qa,
}

pub fn next_work(job: &Value) -> Option<Work> {
    let scenes = job["scenes"].as_array()?;
    if let Some(s) = scenes.iter().find(|s| s["video"]["status"] != "done") {
        return Some(Work::Scene(s["id"].as_str()?.into()));
    }
    if let Some(s) = scenes
        .iter()
        .find(|s| !["done", "skipped"].contains(&s["voice"]["status"].as_str().unwrap_or("")))
    {
        return Some(Work::Voice(s["id"].as_str()?.into()));
    }
    for (stage, work) in [
        ("subtitles", Work::Subtitles),
        ("edit", Work::Edit),
        ("qa", Work::Qa),
    ] {
        if job["stages"][stage]["status"] != "done" {
            return Some(work);
        }
    }
    None
}

// ---------------------------------------------------------------- runner

/// Live jobs: one runner at a time on this machine (the GPU slot is the real limit).
pub struct Productions {
    running: StdMutex<Option<(String, watch::Sender<bool>)>>,
    emitter: StdMutex<Option<Arc<dyn Fn(Value) + Send + Sync>>>,
    /// Serialises job.json read-modify-write between the runner and IPC edits.
    store: tokio::sync::Mutex<()>,
}

pub fn shared() -> Arc<Productions> {
    Arc::new(Productions {
        running: StdMutex::new(None),
        emitter: StdMutex::new(None),
        store: tokio::sync::Mutex::new(()),
    })
}

impl Productions {
    pub fn set_emitter(&self, emit: Arc<dyn Fn(Value) + Send + Sync>) {
        if let Ok(mut slot) = self.emitter.lock() {
            *slot = Some(emit);
        }
    }
    fn emit(&self, value: Value) {
        if let Some(emit) = self.emitter.lock().ok().and_then(|e| e.clone()) {
            emit(value);
        }
    }
    pub fn running_id(&self) -> Option<String> {
        self.running
            .lock()
            .ok()
            .and_then(|r| r.as_ref().map(|(id, _)| id.clone()))
    }

    /// Called on startup: jobs the app closed on become paused and resumable.
    pub fn recover_all(&self) {
        let Ok(root) = root() else { return };
        for entry in std::fs::read_dir(&root).into_iter().flatten().flatten() {
            let id = entry.file_name().to_string_lossy().into_owned();
            if let Ok(mut job) = read_job(&root, &id) {
                if recover(&mut job) {
                    job["updatedAt"] = json!(now());
                    push_log(&mut job, "app", "앱이 꺼져 작업이 멈췄습니다. 이어서 진행을 누르면 끝난 부분부터 계속합니다.");
                    let _ = write_json(&job_dir(&root, &id).unwrap().join("job.json"), &job);
                }
            }
        }
    }

    pub async fn update<F: FnOnce(&mut Value) -> Result<(), String>>(
        &self,
        id: &str,
        change: F,
    ) -> Result<Value, String> {
        let _guard = self.store.lock().await;
        let root = root()?;
        let mut job = read_job(&root, id)?;
        change(&mut job)?;
        job["updatedAt"] = json!(now());
        write_json(&job_dir(&root, id)?.join("job.json"), &job)?;
        self.emit(
            json!({"jobId": id, "kind": "state", "stage": job["stage"], "status": job["status"]}),
        );
        Ok(job)
    }

    pub fn cancel(&self, id: &str) -> bool {
        if let Ok(running) = self.running.lock() {
            if let Some((current, stop)) = running.as_ref() {
                if current == id {
                    let _ = stop.send(true);
                    return true;
                }
            }
        }
        false
    }

    /// Starts (or continues) the runner for a job. Returns at once.
    pub fn spawn(
        self: &Arc<Self>,
        id: String,
        video: Arc<crate::video_runtime::VideoRuntime>,
        tts: Arc<crate::tts_runtime::TtsRuntime>,
    ) -> Result<(), String> {
        let (tx, rx) = watch::channel(false);
        {
            let mut running = self.running.lock().map_err(|_| "작업 상태 오류")?;
            if let Some((current, _)) = running.as_ref() {
                return Err(if *current == id {
                    "이미 진행 중입니다.".into()
                } else {
                    "다른 영상 제작이 진행 중입니다. 끝나거나 일시 중지한 뒤 시작하세요.".into()
                });
            }
            *running = Some((id.clone(), tx));
        }
        let this = Arc::clone(self);
        tokio::spawn(async move {
            let result = this.run(&id, &video, &tts, rx.clone()).await;
            let stopped = *rx.borrow();
            let _ = this
                .update(&id, |job| {
                    match &result {
                        Ok(true) => {
                            job["status"] = json!("done");
                            job["stage"] = json!("done");
                        }
                        Ok(false) => {}
                        Err(error) if stopped => {
                            job["status"] = json!(if job["status"] == "cancelled" {
                                "cancelled"
                            } else {
                                "paused"
                            });
                            push_log(job, "runner", error);
                        }
                        Err(error) => {
                            job["status"] = json!("failed");
                            push_error(job, error);
                        }
                    }
                    Ok(())
                })
                .await;
            if let Ok(mut running) = this.running.lock() {
                *running = None;
            }
        });
        Ok(())
    }

    /// One unit at a time; job.json is saved after each, so a crash loses at most the unit in flight.
    async fn run(
        &self,
        id: &str,
        video: &crate::video_runtime::VideoRuntime,
        tts: &crate::tts_runtime::TtsRuntime,
        stop: watch::Receiver<bool>,
    ) -> Result<bool, String> {
        self.update(id, |job| {
            job["status"] = json!("running");
            Ok(())
        })
        .await?;
        let mut restart_tts = false;
        let result = async {
            loop {
                if *stop.borrow() {
                    return Err("일시 중지했습니다.".to_string());
                }
                let job = read_job(&root()?, id)?;
                let Some(work) = next_work(&job) else {
                    return Ok(true);
                };
                let started = std::time::Instant::now();
                let label = match &work {
                    Work::Scene(_) => "scenes",
                    Work::Voice(_) => "voice",
                    Work::Subtitles => "subtitles",
                    Work::Edit => "edit",
                    Work::Qa => "qa",
                };
                match work {
                    Work::Scene(scene) if job["settings"]["visual"] == "stock" => {
                        self.stock_scene(id, &scene).await?
                    }
                    Work::Scene(scene) => {
                        // Video and TTS models compete for the same 24GB: stop the TTS server the app owns.
                        // A server started outside the app is left running; the worker gets a lower cap instead.
                        let shared = if tts.owned_running().await {
                            tts.stop().await.ok();
                            restart_tts = true;
                            false
                        } else {
                            tts.healthy().await
                        };
                        self.scene(id, &scene, video, stop.clone(), shared).await?
                    }
                    Work::Voice(scene) => {
                        if !tts.healthy().await {
                            tts.start().await.map_err(|e| {
                                format!("나레이션을 만들려면 로컬 음성이 필요합니다. {e}")
                            })?;
                            tts.wait_ready(std::time::Duration::from_secs(180)).await?;
                        }
                        self.voice(id, &scene).await?
                    }
                    Work::Subtitles => self.subtitles(id).await?,
                    Work::Edit => self.edit(id).await?,
                    Work::Qa => {
                        if !self.qa(id).await? {
                            return Ok(false);
                        }
                    }
                }
                let seconds = started.elapsed().as_secs_f64();
                self.update(id, |job| {
                    push_metric(job, label, seconds);
                    Ok(())
                })
                .await?;
            }
        }
        .await;
        if restart_tts {
            let _ = tts.start().await;
        }
        result
    }
}

fn push_log(job: &mut Value, stage: &str, message: &str) {
    if let Some(list) = job["errors"].as_array_mut() {
        list.push(json!({"at": now(), "stage": stage, "message": message.chars().take(600).collect::<String>(), "kind": "log"}));
        let overflow = list.len().saturating_sub(60);
        list.drain(..overflow);
    }
}
fn push_error(job: &mut Value, message: &str) {
    let stage = job["stage"].as_str().unwrap_or("").to_owned();
    if let Some(list) = job["errors"].as_array_mut() {
        list.push(json!({"at": now(), "stage": stage, "message": message.chars().take(600).collect::<String>(), "kind": "error"}));
    }
}
fn push_metric(job: &mut Value, stage: &str, seconds: f64) {
    if let Some(list) = job["metrics"].as_array_mut() {
        list.push(json!({"stage": stage, "seconds": (seconds * 10.0).round() / 10.0, "at": now()}));
        let overflow = list.len().saturating_sub(200);
        list.drain(..overflow);
    }
}

fn scene_mut<'a>(job: &'a mut Value, scene: &str) -> Result<&'a mut Value, String> {
    job["scenes"]
        .as_array_mut()
        .ok_or("장면이 없습니다.")?
        .iter_mut()
        .find(|s| s["id"] == scene)
        .ok_or_else(|| "장면을 찾을 수 없습니다.".into())
}

fn count_done(job: &mut Value, stage: &str, part: &str) {
    let scenes = job["scenes"].as_array().cloned().unwrap_or_default();
    let done = scenes
        .iter()
        .filter(|s| s[part]["status"] == "done")
        .count();
    job["stages"][stage]["done"] = json!(done);
    if scenes
        .iter()
        .all(|s| ["done", "skipped"].contains(&s[part]["status"].as_str().unwrap_or("")))
    {
        job["stages"][stage]["status"] = json!("done");
    }
}

impl Productions {
    async fn scene(
        &self,
        id: &str,
        scene: &str,
        video: &crate::video_runtime::VideoRuntime,
        stop: watch::Receiver<bool>,
        shared_memory: bool,
    ) -> Result<(), String> {
        let job = self
            .update(id, |job| {
                job["stage"] = json!("scenes");
                job["stages"]["scenes"]["status"] = json!("running");
                let s = scene_mut(job, scene)?;
                s["video"]["status"] = json!("running");
                s["video"]["error"] = Value::Null;
                Ok(())
            })
            .await?;
        let settings: Settings =
            serde_json::from_value(job["settings"].clone()).map_err(|_| "작업 설정 오류")?;
        let entry = job["scenes"]
            .as_array()
            .unwrap()
            .iter()
            .find(|s| s["id"] == scene)
            .cloned()
            .unwrap();
        let generation = &job["generation"];
        let prompt = entry["video"]["prompt"].as_str().unwrap_or("").to_owned();
        let negative = entry["video"]["negative"].as_str().unwrap_or("").to_owned();
        let seed = entry["video"]["seed"].as_u64().unwrap_or(0) as u32;
        let size = generation["size"].as_str().unwrap_or("832x480");
        let size: &'static str = ["832x480", "480x832", "640x368", "368x640", "480x480"]
            .into_iter()
            .find(|s| *s == size)
            .ok_or("생성 해상도 오류")?;
        let (frames, steps) = (
            generation["frames"].as_u64().unwrap_or(49) as u32,
            generation["steps"].as_u64().unwrap_or(30) as u32,
        );
        let key = video_key(
            &settings.engine,
            &prompt,
            &negative,
            size,
            frames,
            steps,
            seed,
        );
        let dir = media_root()?.join(id).join("scenes").join(scene);
        std::fs::create_dir_all(&dir).map_err(|_| "장면 폴더를 만들 수 없습니다.")?;
        let output = dir.join(format!("{key}.mp4"));
        let reference = format!("/productions/{id}/scenes/{scene}/{key}.mp4");
        if !std::fs::metadata(&output).is_ok_and(|m| m.len() > 0) {
            if shared_memory {
                self.update(id, |job| {
                    let notice = "앱 밖에서 켠 로컬 음성 서버가 실행 중이라 메모리 상한을 16GB로 낮춰 생성합니다. 실패하면 그 서버를 끄고 다시 시도하세요.";
                    push_log(job, "scenes", notice);
                    job["stages"]["scenes"]["message"] = json!(notice);
                    Ok(())
                })
                .await?;
            }
            let memory_limit_gb = crate::video_runtime::memory_limit_gb(shared_memory);
            let job_spec = crate::video_runtime::SceneJob {
                prompt,
                negative,
                size,
                frames,
                steps,
                seed,
                quantize: 0,
                output: output.clone(),
                memory_limit_gb,
            };
            let emit_id = id.to_owned();
            let emit_scene = scene.to_owned();
            let emitter = self.emitter.lock().ok().and_then(|e| e.clone());
            // Share the editor's export gate: an MP4 export and a scene render must not overlap in 24GB.
            let _render = crate::media::lock_for_video_activity()?;
            let result = video.generate(&settings.engine, &job_spec, move |event| {
                if let Some(emit) = &emitter {
                    match event {
                        crate::video_runtime::SceneEvent::Step { done, total } => emit(json!({"jobId": emit_id, "kind": "progress", "stage": "scenes", "sceneId": emit_scene, "done": done, "total": total})),
                        crate::video_runtime::SceneEvent::Stage(stage) => emit(json!({"jobId": emit_id, "kind": "progress", "stage": "scenes", "sceneId": emit_scene, "step": stage})),
                    }
                }
            }, stop).await;
            if let Err(error) = result {
                self.update(id, |job| {
                    let s = scene_mut(job, scene)?;
                    s["video"]["status"] = json!("failed");
                    s["video"]["error"] = json!(error);
                    Ok(())
                })
                .await?;
                return Err(format!("{scene} 장면: {error}"));
            }
        }
        // Any failure from here marks the scene failed (not stuck "running"); the cached file is kept for the retry.
        let inspected = async {
            let probe = crate::media::probe(&output).await?;
            if !probe["streams"]
                .as_array()
                .is_some_and(|l| l.iter().any(|st| st["codec_type"] == "video"))
            {
                return Err("생성한 장면에 영상 스트림이 없습니다.".to_string());
            }
            let duration = probe["format"]["duration"]
                .as_str()
                .and_then(|d| d.parse::<f64>().ok())
                .unwrap_or(0.0);
            Ok::<_, String>((duration, sha256_path(&output)?))
        }
        .await;
        let (duration, hash) = match inspected {
            Ok(value) => value,
            Err(error) => {
                self.update(id, |job| {
                    let s = scene_mut(job, scene)?;
                    s["video"]["status"] = json!("failed");
                    s["video"]["error"] = json!(error);
                    Ok(())
                })
                .await?;
                return Err(format!("{scene} 장면 확인: {error}"));
            }
        };
        self.update(id, |job| {
            let s = scene_mut(job, scene)?;
            s["video"] = json!({"status": "done", "key": key, "seed": seed, "prompt": s["video"]["prompt"], "negative": s["video"]["negative"],
                "path": reference, "file": output, "durationSec": duration, "size": size, "frames": frames, "steps": steps, "sha256": hash, "source": "ai-inference"});
            count_done(job, "scenes", "video");
            Ok(())
        }).await?;
        Ok(())
    }

    /// Stock scene: the picked photo, else the scene's other candidates, else a drawn card. One bad
    /// download never stops the job; what was skipped is logged on the job.
    async fn stock_scene(&self, id: &str, scene: &str) -> Result<(), String> {
        let job = self
            .update(id, |job| {
                job["stage"] = json!("scenes");
                job["stages"]["scenes"]["status"] = json!("running");
                let s = scene_mut(job, scene)?;
                s["video"]["status"] = json!("running");
                s["video"]["error"] = Value::Null;
                Ok(())
            })
            .await?;
        let settings: Settings =
            serde_json::from_value(job["settings"].clone()).map_err(|_| "작업 설정 오류")?;
        let entry = job["scenes"]
            .as_array()
            .and_then(|l| l.iter().find(|s| s["id"] == scene))
            .cloned()
            .ok_or("장면을 찾을 수 없습니다.")?;
        let dir = media_root()?.join(id).join("scenes").join(scene);
        let mut chain: Vec<Value> = Vec::new();
        if entry["video"]["kind"] == "stock" {
            chain.push(entry["video"]["candidate"].clone());
            chain.extend(
                job["candidates"][scene]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter(|c| c["id"] != entry["video"]["candidate"]["id"])
                    .cloned(),
            );
        }
        let mut skipped = Vec::new();
        let mut done = None;
        for candidate in &chain {
            match stock_file(id, scene, &dir, candidate).await {
                Ok(value) => {
                    done = Some(value);
                    break;
                }
                Err(error) => skipped.push(format!(
                    "{} ({error})",
                    candidate["id"].as_str().unwrap_or("?")
                )),
            }
        }
        let done = match done {
            Some(value) => Ok(value),
            None => {
                let caption = job["storyboard"]["scenes"]
                    .as_array()
                    .and_then(|l| l.iter().find(|s| s["id"] == scene))
                    .and_then(|s| s["caption"].as_str())
                    .unwrap_or("")
                    .to_owned();
                graphic_file(
                    id,
                    scene,
                    &dir,
                    &caption,
                    frame_layout(&settings.aspect, &settings.layout),
                )
            }
        };
        match done {
            Ok(done) => self
                .update(id, |job| {
                    if !skipped.is_empty() {
                        let fallback = if done["kind"] == "graphic" {
                            "그래픽 장면으로 바꿨습니다"
                        } else {
                            "다른 후보 사진을 썼습니다"
                        };
                        push_log(
                            job,
                            "scenes",
                            &format!(
                                "{scene}: 고른 사진을 쓰지 못해 {fallback}. {}",
                                skipped.join(" · ")
                            ),
                        );
                    }
                    let s = scene_mut(job, scene)?;
                    s["video"] = done.clone();
                    s["video"]["status"] = json!("done");
                    count_done(job, "scenes", "video");
                    Ok(())
                })
                .await
                .map(|_| ()),
            Err(error) => {
                self.update(id, |job| {
                    let s = scene_mut(job, scene)?;
                    s["video"]["status"] = json!("failed");
                    s["video"]["error"] = json!(error);
                    Ok(())
                })
                .await?;
                Err(format!("{scene} 장면: {error}"))
            }
        }
    }

    async fn voice(&self, id: &str, scene: &str) -> Result<(), String> {
        let job = self
            .update(id, |job| {
                job["stage"] = json!("voice");
                job["stages"]["voice"]["status"] = json!("running");
                scene_mut(job, scene)?["voice"]["status"] = json!("running");
                Ok(())
            })
            .await?;
        let settings: Settings =
            serde_json::from_value(job["settings"].clone()).map_err(|_| "작업 설정 오류")?;
        let narration = job["storyboard"]["scenes"]
            .as_array()
            .and_then(|l| l.iter().find(|s| s["id"] == scene))
            .and_then(|s| s["narration"].as_str())
            .unwrap_or("")
            .to_owned();
        let result = crate::media::generate_voice(json!({"projectId": id, "sceneId": scene, "text": narration, "language": "ko", "voice": {"speaker": settings.speaker}})).await;
        match result {
            Ok(voice) => self.update(id, |job| {
                let key = voice_key(&settings, &narration);
                let duration = voice["durationSec"].as_f64().unwrap_or(0.0);
                let s = scene_mut(job, scene)?;
                s["voice"] = json!({"status": "done", "key": key, "path": voice["audioPath"], "durationSec": duration, "speaker": voice["speaker"], "source": "qwen3-tts-mlx"});
                // A scene is at least as long as its narration plus a short breath.
                let needed = ((duration + 0.4) * 10.0).ceil() / 10.0;
                if s["durationSec"].as_f64().unwrap_or(0.0) < needed { s["durationSec"] = json!(needed); }
                count_done(job, "voice", "voice");
                Ok(())
            }).await.map(|_| ()),
            Err(error) => {
                self.update(id, |job| { let s = scene_mut(job, scene)?; s["voice"]["status"] = json!("failed"); s["voice"]["error"] = json!(error); Ok(()) }).await?;
                Err(format!("{scene} 나레이션: {error}"))
            }
        }
    }

    async fn subtitles(&self, id: &str) -> Result<(), String> {
        self.update(id, |job| {
            job["stage"] = json!("subtitles");
            let settings: Settings = serde_json::from_value(job["settings"].clone()).map_err(|_| "작업 설정 오류")?;
            let mut all = Vec::new();
            let mut offset = 0.0;
            let board = job["storyboard"]["scenes"].as_array().cloned().unwrap_or_default();
            for scene in job["scenes"].as_array_mut().ok_or("장면이 없습니다.")? {
                let story = board.iter().find(|s| s["id"] == scene["id"]).cloned().unwrap_or(Value::Null);
                let duration = scene["durationSec"].as_f64().unwrap_or(5.0);
                let text = if settings.narration { story["narration"].as_str().unwrap_or("") } else { story["caption"].as_str().unwrap_or("") };
                let voice = scene["voice"]["durationSec"].as_f64().unwrap_or(duration);
                // Photo shorts keep a scene's line whole (3~4 s cuts, word-wrapped box) so no word is split across cues.
                let cues = if settings.subtitle_style == "none" || text.is_empty() {
                    vec![]
                } else if settings.visual == "stock" {
                    vec![(0.0, voice.min(duration).max(0.5).max(duration - 0.05).min(duration), spoken(text))]
                } else {
                    caption_cues(text, voice, duration)
                };
                scene["captionCues"] = json!(cues.iter().map(|(s, e, t)| json!({"startSec": (s * 1000.0).round() / 1000.0, "endSec": (e * 1000.0).round() / 1000.0, "text": t})).collect::<Vec<_>>());
                all.extend(cues.into_iter().map(|(s, e, t)| (s + offset, e + offset, t)));
                offset += duration;
            }
            let dir = job_dir(&root()?, id)?;
            std::fs::write(dir.join("subtitles.srt"), srt(&all)).map_err(|_| "자막 파일을 저장할 수 없습니다.")?;
            job["outputs"]["subtitles"] = json!(dir.join("subtitles.srt"));
            job["stages"]["subtitles"] = json!({"status": "done", "done": all.len(), "total": all.len()});
            Ok(())
        }).await.map(|_| ())
    }

    /// Composes the AI clips full-frame at the output size with narration, captions, fades and BGM.
    /// Shares the renderer's job gate so it never runs alongside an editor MP4 export or an update.
    async fn edit(&self, id: &str) -> Result<(), String> {
        let job = self
            .update(id, |job| {
                job["stage"] = json!("edit");
                job["stages"]["edit"]["status"] = json!("running");
                Ok(())
            })
            .await?;
        let settings: Settings =
            serde_json::from_value(job["settings"].clone()).map_err(|_| "작업 설정 오류")?;
        let _update = crate::keyword::lock_for_update()
            .map_err(|_| "키워드 탐색 또는 업데이트가 끝난 뒤 편집합니다.")?;
        let _render = crate::media::lock_for_video_activity()?;
        let dir = job_dir(&root()?, id)?;
        let working =
            tempfile::tempdir_in(&dir).map_err(|_| "편집 작업 폴더를 만들 수 없습니다.")?;
        let final_path = dir.join("final.mp4");
        let total = if settings.visual == "stock" || settings.layout == "card" {
            compose_shorts(&job, &settings, working.path(), &final_path).await?
        } else {
            compose(&job, &settings, working.path(), &final_path).await?
        };
        write_json(
            &dir.join("edit-project.json"),
            &editor_project(&job, &settings)?,
        )?;
        self.update(id, |job| {
            job["outputs"]["final"] = json!(final_path);
            job["outputs"]["editProject"] = json!(dir.join("edit-project.json"));
            job["outputs"]["durationSec"] = json!(total);
            job["stages"]["edit"] = json!({"status": "done", "done": 1, "total": 1});
            Ok(())
        })
        .await
        .map(|_| ())
    }

    /// FFprobe + black-frame check. A failure invalidates only the stage that produced the problem.
    async fn qa(&self, id: &str) -> Result<bool, String> {
        let job = self
            .update(id, |job| {
                job["stage"] = json!("qa");
                job["stages"]["qa"]["status"] = json!("running");
                Ok(())
            })
            .await?;
        let settings: Settings =
            serde_json::from_value(job["settings"].clone()).map_err(|_| "작업 설정 오류")?;
        let final_path = PathBuf::from(
            job["outputs"]["final"]
                .as_str()
                .ok_or("최종 영상이 없습니다.")?,
        );
        let probe = crate::media::probe(&final_path).await.ok();
        let black = black_ratio(&final_path).await.unwrap_or(1.0);
        let (checks, failed_stage) = qa_checks(
            &job,
            &settings,
            probe.as_ref(),
            black,
            std::fs::metadata(&final_path).map(|m| m.len()).unwrap_or(0),
        );
        let passed = failed_stage.is_none();
        let provenance = if passed {
            Some(provenance(&job, &settings, &final_path)?)
        } else {
            None
        };
        self.update(id, |job| {
            job["qa"] = json!({"passed": passed, "checks": checks, "blackRatio": black, "at": now()});
            if let Some(stage) = &failed_stage {
                push_error(job, &format!("품질 검사 실패: {stage} 단계를 다시 실행합니다."));
                let retries = job["qaRetries"].as_u64().unwrap_or(0);
                job["qaRetries"] = json!(retries + 1);
                if retries >= 1 { job["stages"]["qa"]["status"] = json!("failed"); return Err("품질 검사를 두 번 통과하지 못했습니다. 검사 항목을 확인하세요.".into()); }
                invalidate_from(job, stage);
                return Ok(());
            }
            job["stages"]["qa"] = json!({"status": "done", "done": checks.as_array().map(Vec::len).unwrap_or(0), "total": checks.as_array().map(Vec::len).unwrap_or(0)});
            let dir = job_dir(&root()?, id)?;
            write_json(&dir.join("storyboard.json"), &job["storyboard"])?;
            let metadata = json!({"title": job["storyboard"]["title"], "topic": job["settings"]["topic"], "settings": job["settings"], "generation": job["generation"],
                "output": {"path": final_path, "size": job["generation"]["output"], "durationSec": job["outputs"]["durationSec"]}, "scenes": job["scenes"], "qa": job["qa"], "metrics": job["metrics"], "createdAt": job["createdAt"], "finishedAt": now()});
            write_json(&dir.join("metadata.json"), &metadata)?;
            write_json(&dir.join("provenance.json"), provenance.as_ref().unwrap())?;
            job["provenance"] = provenance.clone().unwrap();
            job["outputs"]["storyboard"] = json!(dir.join("storyboard.json"));
            job["outputs"]["metadata"] = json!(dir.join("metadata.json"));
            job["outputs"]["provenance"] = json!(dir.join("provenance.json"));
            Ok(())
        }).await?;
        Ok(passed)
    }
}

/// Saves one cleared photo for a scene (copied from its validated preview, else downloaded again).
async fn stock_file(id: &str, scene: &str, dir: &Path, candidate: &Value) -> Result<Value, String> {
    if !crate::stock_media::cleared(candidate) {
        return Err("사진 라이선스 기록이 올바르지 않습니다.".into());
    }
    let mut entry = stock_entry(Some(candidate), scene);
    let key = entry["key"].as_str().unwrap_or("").to_owned();
    let file = dir.join(format!("{key}.jpg"));
    if !std::fs::metadata(&file).is_ok_and(|m| m.len() > 0) {
        let preview = candidate["preview"].as_str().and_then(|p| {
            crate::media::resolve_asset_at(&crate::media::public_dir().ok()?, p).ok()
        });
        match preview {
            Some(path) if sha256_path(&path).ok().as_deref() == candidate["sha256"].as_str() => {
                std::fs::create_dir_all(dir).map_err(|_| "장면 폴더를 만들 수 없습니다.")?;
                std::fs::copy(&path, &file).map_err(|_| "사진을 장면 폴더로 옮기지 못했습니다.")?;
            }
            _ => {
                crate::stock_media::download(candidate, &file).await?;
            }
        }
    }
    entry["path"] = json!(format!("/productions/{id}/scenes/{scene}/{key}.jpg"));
    entry["file"] = json!(file);
    entry["sha256"] = json!(sha256_path(&file)?);
    entry["source"] = json!("stock-photo");
    Ok(entry)
}

/// Drawn card for a scene with no usable photo.
fn graphic_file(
    id: &str,
    scene: &str,
    dir: &Path,
    caption: &str,
    frame: Frame,
) -> Result<Value, String> {
    let mut entry = stock_entry(None, scene);
    let key = entry["key"].as_str().unwrap_or("").to_owned();
    let file = dir.join(format!("{key}.png"));
    std::fs::create_dir_all(dir).map_err(|_| "장면 폴더를 만들 수 없습니다.")?;
    graphic_png(&crate::media::load_font()?, caption, frame, &file)?;
    entry["path"] = json!(format!("/productions/{id}/scenes/{scene}/{key}.png"));
    entry["file"] = json!(file);
    entry["sha256"] = json!(sha256_path(&file)?);
    entry["source"] = json!("app-graphic");
    Ok(entry)
}

fn sha256_path(path: &Path) -> Result<String, String> {
    sha256_path_impl(path)
}

// ---------------------------------------------------------------- full-frame composer

/// Caption overlay PNG for one cue, drawn by the app (no FFmpeg drawtext, no user text in filters).
fn caption_png(
    font: &fontdue::Font,
    text: &str,
    width: u32,
    style: &str,
    path: &Path,
) -> Result<u32, String> {
    let bold = style == "shorts-bold";
    let available = width - width / 8;
    let (lines, size) = crate::media::fitting_text(
        font,
        text,
        (available - 48) as f32,
        if bold { 220.0 } else { 150.0 },
        if bold {
            (width / 15).max(28)
        } else {
            (width / 24).max(22)
        },
        16,
    )?;
    let height = (lines.len() as f32 * size * 1.45 + 36.0).ceil() as u32;
    let mut canvas = crate::media::Canvas::transparent(available, height);
    canvas.rounded_card(
        18,
        if bold { [8, 10, 16] } else { [10, 14, 22] },
        if bold { 205 } else { 170 },
    );
    canvas.text(
        font,
        &lines,
        size,
        24.0,
        18.0,
        if bold {
            [255, 236, 140]
        } else {
            [245, 248, 255]
        },
    );
    canvas.save(path)?;
    Ok(height)
}

/// One segment per scene: AI clip scaled to cover the output frame (looped if shorter than the scene),
/// narration under optional captions, then fixed fades. Concatenated by stream copy.
pub async fn compose(
    job: &Value,
    settings: &Settings,
    working: &Path,
    output: &Path,
) -> Result<f64, String> {
    let (width, height) = output_size(&settings.aspect);
    let font = crate::media::load_font()?;
    let media = crate::media::public_dir()?;
    let board = job["storyboard"]["scenes"]
        .as_array()
        .ok_or("스토리보드가 없습니다.")?;
    let mut list = String::new();
    let mut total = 0.0;
    for (index, scene) in job["scenes"]
        .as_array()
        .ok_or("장면이 없습니다.")?
        .iter()
        .enumerate()
    {
        let story = board
            .iter()
            .find(|s| s["id"] == scene["id"])
            .cloned()
            .unwrap_or(Value::Null);
        let duration = (scene["durationSec"].as_f64().unwrap_or(5.0) * 24.0).ceil() / 24.0;
        total += duration;
        let clip = crate::media::resolve_asset_at(
            &media,
            scene["video"]["path"]
                .as_str()
                .ok_or("장면 영상이 없습니다.")?,
        )?;
        let audio = scene["voice"]["path"]
            .as_str()
            .map(|p| crate::media::resolve_asset_at(&media, p))
            .transpose()?;
        let mut arguments: Vec<String> = [
            "-hide_banner",
            "-loglevel",
            "error",
            "-nostdin",
            "-y",
            "-threads",
            "2",
            "-protocol_whitelist",
            "file,pipe",
            "-format_whitelist",
            "mov",
            "-stream_loop",
            "-1",
            "-i",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect();
        arguments.push(clip.to_string_lossy().into_owned());
        let mut inputs = 1;
        let audio_index = inputs;
        if let Some(path) = &audio {
            arguments.extend(
                [
                    "-protocol_whitelist",
                    "file,pipe",
                    "-format_whitelist",
                    "wav",
                    "-i",
                ]
                .iter()
                .map(|s| s.to_string()),
            );
            arguments.push(path.to_string_lossy().into_owned());
        } else {
            arguments.extend(
                ["-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo"]
                    .iter()
                    .map(|s| s.to_string()),
            );
        }
        inputs += 1;
        let mut filter = format!("[0:v]scale={width}:{height}:force_original_aspect_ratio=increase,crop={width}:{height},setsar=1,fps=24[base]");
        let mut last = "[base]".to_owned();
        if settings.subtitle_style != "none" {
            for (cue_index, cue) in scene["captionCues"]
                .as_array()
                .cloned()
                .unwrap_or_default()
                .iter()
                .enumerate()
            {
                let name = format!("cap-{index:02}-{cue_index:02}.png");
                let cue_height = caption_png(
                    &font,
                    cue["text"].as_str().unwrap_or(""),
                    width,
                    &settings.subtitle_style,
                    &working.join(&name),
                )?;
                arguments.extend(
                    ["-loop", "1", "-framerate", "24", "-i"]
                        .iter()
                        .map(|s| s.to_string()),
                );
                arguments.push(name);
                let (start, end) = (
                    cue["startSec"].as_f64().unwrap_or(0.0),
                    cue["endSec"].as_f64().unwrap_or(0.0),
                );
                let y = if settings.subtitle_style == "shorts-bold" {
                    height * 62 / 100
                } else {
                    height - cue_height - height / 12
                };
                filter.push_str(&format!(";{last}[{inputs}:v]overlay=x=(W-w)/2:y={y}:enable='between(t,{start:.3},{end:.3})'[c{cue_index}]"));
                last = format!("[c{cue_index}]");
                inputs += 1;
            }
        }
        let transition = crate::motion::Transition::from_scene(
            &json!({"transition": story["transition"].as_str().unwrap_or("cut")}),
        )?;
        match transition.filter(duration) {
            Some(fades) => filter.push_str(&format!(";{last}{fades},format=yuv420p[v]")),
            None => filter.push_str(&format!(";{last}format=yuv420p[v]")),
        }
        let segment = format!("segment-{index:03}.mp4");
        arguments.extend(
            ["-filter_complex_threads", "1", "-filter_complex"]
                .iter()
                .map(|s| s.to_string()),
        );
        arguments.push(filter);
        arguments.extend(["-map", "[v]", "-map"].iter().map(|s| s.to_string()));
        arguments.push(format!("{audio_index}:a:0"));
        arguments.extend(
            ["-af", "apad,aresample=48000", "-ac", "2", "-t"]
                .iter()
                .map(|s| s.to_string()),
        );
        arguments.push(format!("{duration:.6}"));
        arguments.extend(
            [
                "-r",
                "24",
                "-c:v",
                "libx264",
                "-preset",
                "medium",
                "-crf",
                "19",
                "-pix_fmt",
                "yuv420p",
                "-c:a",
                "aac",
                "-b:a",
                "192k",
                "-movflags",
                "+faststart",
            ]
            .iter()
            .map(|s| s.to_string()),
        );
        arguments.push(segment.clone());
        crate::media::run_command(
            "ffmpeg",
            &arguments,
            Some(working),
            (duration as u64 * 20 + 120).min(1200),
        )
        .await?;
        list.push_str(&format!("file '{segment}'\n"));
    }
    finish_segments(working, &list, total, settings, output).await?;
    Ok(total)
}

// ---------------------------------------------------------------- shorts composer (0.6)

/// Where each element sits on the output frame. "card" follows the reference shorts: a fixed
/// two-line title on top, the media in the middle, captions over the media, a credit line below.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Frame {
    pub width: u32,
    pub height: u32,
    /// x, y, width, height of the media window (even numbers for yuv420p).
    pub media: (u32, u32, u32, u32),
    /// y and height of the title band.
    pub title: (u32, u32),
    /// Captions sit with their bottom edge here.
    pub caption_bottom: u32,
    pub credit_y: u32,
    pub bar_y: u32,
    pub card: bool,
}

pub fn frame_layout(aspect: &str, layout: &str) -> Frame {
    let (w, h) = output_size(aspect);
    if layout != "card" {
        return Frame {
            width: w,
            height: h,
            media: (0, 0, w, h),
            title: (h * 7 / 100, h * 16 / 100),
            caption_bottom: h * 80 / 100,
            credit_y: h - h / 24,
            bar_y: h - 10,
            card: false,
        };
    }
    match aspect {
        "16:9" => Frame {
            width: w,
            height: h,
            media: (0, 240, w, 770),
            title: (34, 190),
            caption_bottom: 240 + 770 - 48,
            credit_y: 1022,
            bar_y: 1004,
            card: true,
        },
        "1:1" => Frame {
            width: w,
            height: h,
            media: (0, 262, w, 700),
            title: (40, 200),
            caption_bottom: 262 + 700 - 44,
            credit_y: 974,
            bar_y: 956,
            card: true,
        },
        _ => Frame {
            width: w,
            height: h,
            media: (0, 470, w, 1060),
            title: (150, 290),
            caption_bottom: 470 + 1060 - 64,
            credit_y: 1556,
            bar_y: 1522,
            card: true,
        },
    }
}

/// Ken Burns move over a still image. The camera is a closed enum; numbers come from the frame.
pub fn camera_filter(camera: &str, width: u32, height: u32, frames: u32) -> String {
    let n = frames.max(1);
    // Smoothstep so the move starts and settles softly.
    let p = format!("(min(on/{n},1)*min(on/{n},1)*(3-2*min(on/{n},1)))");
    let centre_x = "iw/2-(iw/zoom/2)".to_string();
    let centre_y = "ih/2-(ih/zoom/2)".to_string();
    let (z, x, y) = match camera {
        "zoom-out" => (format!("1.16-0.16*{p}"), centre_x, centre_y),
        "pan-left" => (
            "1.16".to_string(),
            format!("(iw-iw/zoom)*(1-{p})"),
            centre_y,
        ),
        "pan-right" => ("1.16".to_string(), format!("(iw-iw/zoom)*{p}"), centre_y),
        "pan-up" => (
            "1.16".to_string(),
            centre_x,
            format!("(ih-ih/zoom)*(1-{p})"),
        ),
        _ => (format!("1+0.16*{p}"), centre_x, centre_y),
    };
    format!(
        "scale={w2}:{h2}:force_original_aspect_ratio=increase,crop={w2}:{h2},setsar=1,zoompan=z='{z}':x='{x}':y='{y}':d=1:s={width}x{height}:fps=24",
        w2 = width * 2,
        h2 = height * 2
    )
}

/// Splits one caption line into plain and highlighted runs (longest emphasis word wins).
pub fn emphasis_runs(line: &str, words: &[String]) -> Vec<(String, bool)> {
    let mut words: Vec<&str> = words
        .iter()
        .map(String::as_str)
        .filter(|w| !w.is_empty())
        .collect();
    words.sort_by_key(|w| std::cmp::Reverse(w.chars().count()));
    let mut runs: Vec<(String, bool)> = Vec::new();
    let mut rest = line;
    while !rest.is_empty() {
        if let Some(word) = words.iter().find(|w| rest.starts_with(**w)) {
            runs.push(((*word).to_owned(), true));
            rest = &rest[word.len()..];
            continue;
        }
        let ch = rest.chars().next().unwrap();
        match runs.last_mut() {
            Some((text, false)) => text.push(ch),
            _ => runs.push((ch.to_string(), false)),
        }
        rest = &rest[ch.len_utf8()..];
    }
    runs
}

fn line_width(font: &fontdue::Font, text: &str, size: f32) -> f32 {
    text.chars()
        .map(|c| font.metrics(c, size).advance_width)
        .sum()
}

/// Caption lines broken at spaces with balanced widths (a long unspaced word still splits by width).
fn caption_lines(font: &fontdue::Font, text: &str, size: f32, width: f32) -> Vec<String> {
    let words: Vec<&str> = text.split_whitespace().collect();
    let space = line_width(font, " ", size);
    let total: f32 = words.iter().map(|w| line_width(font, w, size)).sum::<f32>()
        + space * words.len().saturating_sub(1) as f32;
    let rows = (total / width).ceil().max(1.0);
    let target = (total / rows).min(width);
    let mut lines: Vec<String> = Vec::new();
    let mut line = String::new();
    for word in words {
        let next = if line.is_empty() {
            word.to_owned()
        } else {
            format!("{line} {word}")
        };
        if !line.is_empty()
            && (line_width(font, &next, size) > width || line_width(font, &line, size) >= target)
        {
            lines.push(std::mem::take(&mut line));
            line = word.to_owned();
        } else {
            line = next;
        }
        while line_width(font, &line, size) > width && line.chars().count() > 1 {
            let mut head = String::new();
            for ch in line.chars() {
                if line_width(font, &format!("{head}{ch}"), size) > width {
                    break;
                }
                head.push(ch);
            }
            let rest: String = line.chars().skip(head.chars().count().max(1)).collect();
            lines.push(head);
            line = rest;
        }
    }
    if !line.is_empty() {
        lines.push(line);
    }
    lines
}

const YELLOW: [u8; 3] = [255, 214, 10];
const WHITE: [u8; 3] = [255, 255, 255];

/// Two-line title: white top line, yellow bottom line, sized to fit the band.
fn title_png(
    font: &fontdue::Font,
    top: &str,
    bottom: &str,
    frame: Frame,
    path: &Path,
) -> Result<(u32, u32), String> {
    let width = frame.width - frame.width / 14;
    let band = frame.title.1;
    let lines: Vec<&str> = [top, bottom]
        .into_iter()
        .filter(|l| !l.trim().is_empty())
        .collect();
    let rows = lines.len().max(1) as f32;
    let mut size = (band as f32 / (rows * 1.22)).floor();
    while size > 24.0
        && lines
            .iter()
            .any(|l| line_width(font, l, size) > (width - 24) as f32)
    {
        size -= 2.0;
    }
    let mut canvas = crate::media::Canvas::transparent(width, band);
    if !frame.card {
        canvas.rounded_card(22, [6, 8, 12], 170);
    }
    let block = rows * size * 1.22;
    let start = (band as f32 - block) / 2.0;
    for (row, line) in lines.iter().enumerate() {
        let x = (width as f32 - line_width(font, line, size)) / 2.0;
        let color = if row == 0 && lines.len() > 1 {
            WHITE
        } else {
            YELLOW
        };
        canvas.text_runs(
            font,
            &[(line.to_string(), color)],
            size,
            x,
            start + row as f32 * size * 1.22,
            true,
        );
    }
    canvas.save(path)?;
    Ok((width, band))
}

/// Caption box with highlighted words (shorts-bold) or a quieter strip (clean-bottom).
fn emphasis_caption_png(
    font: &fontdue::Font,
    text: &str,
    emphasis: &[String],
    frame: Frame,
    style: &str,
    path: &Path,
) -> Result<(u32, u32), String> {
    let bold = style == "shorts-bold";
    let unit = frame.width.min(frame.height) as f32;
    let preferred = if bold { unit / 17.0 } else { unit / 24.0 } as u32;
    let max = (frame.media.2 - frame.media.2 / 9) as f32;
    let pad = (preferred as f32 * 0.42).round();
    // Largest size up to the preferred one that fits in at most three word-wrapped lines.
    let inner = max - pad * 2.0;
    let mut size = preferred as f32;
    let mut lines = caption_lines(font, text, size, inner);
    while size > 20.0 && lines.len() > 3 {
        size -= 2.0;
        lines = caption_lines(font, text, size, inner);
    }
    let widest = lines
        .iter()
        .map(|l| line_width(font, l, size))
        .fold(0.0, f32::max);
    let width = (widest + pad * 2.0 + 4.0).ceil() as u32;
    let height = (lines.len() as f32 * size * 1.32 + pad * 1.4).ceil() as u32;
    let mut canvas = crate::media::Canvas::transparent(width, height);
    canvas.rounded_card(
        if bold { 10 } else { 14 },
        [0, 0, 0],
        if bold { 236 } else { 170 },
    );
    for (row, line) in lines.iter().enumerate() {
        let runs: Vec<(String, [u8; 3])> = emphasis_runs(line, emphasis)
            .into_iter()
            .map(|(t, hot)| (t, if hot && bold { YELLOW } else { WHITE }))
            .collect();
        let x = (width as f32 - line_width(font, line, size)) / 2.0;
        canvas.text_runs(
            font,
            &runs,
            size,
            x,
            pad * 0.7 + row as f32 * size * 1.32,
            bold,
        );
    }
    canvas.save(path)?;
    Ok((width, height))
}

/// Big number card ("415m", "1977년") with an optional label.
fn stat_png(
    font: &fontdue::Font,
    value: &str,
    label: &str,
    frame: Frame,
    path: &Path,
) -> Result<(u32, u32), String> {
    let unit = frame.width.min(frame.height) as f32;
    let mut size = unit / 6.0;
    let max = (frame.media.2 - frame.media.2 / 6) as f32;
    while size > 40.0 && line_width(font, value, size) > max {
        size -= 4.0;
    }
    let label_size = (size * 0.3).max(24.0);
    let mut label = label.to_owned();
    while !label.is_empty() && line_width(font, &label, label_size) > max {
        label.pop();
    }
    let pad = size * 0.28;
    let width = (line_width(font, value, size).max(line_width(font, &label, label_size))
        + pad * 2.0)
        .ceil() as u32;
    let height = (size * 1.2
        + if label.is_empty() {
            0.0
        } else {
            label_size * 1.5
        }
        + pad)
        .ceil() as u32;
    let mut canvas = crate::media::Canvas::transparent(width, height);
    canvas.rounded_card(24, [0, 0, 0], 150);
    canvas.text_runs(
        font,
        &[(value.to_owned(), YELLOW)],
        size,
        (width as f32 - line_width(font, value, size)) / 2.0,
        pad * 0.5,
        true,
    );
    if !label.is_empty() {
        canvas.text_runs(
            font,
            &[(label.clone(), WHITE)],
            label_size,
            (width as f32 - line_width(font, &label, label_size)) / 2.0,
            pad * 0.5 + size * 1.18,
            false,
        );
    }
    canvas.save(path)?;
    Ok((width, height))
}

/// Small grey credit line under the media ("출처: … · CC BY 2.0").
fn credit_png(
    font: &fontdue::Font,
    text: &str,
    frame: Frame,
    path: &Path,
) -> Result<(u32, u32), String> {
    let size = (frame.width.min(frame.height) as f32 / 40.0).max(18.0);
    let max = (frame.width - frame.width / 10) as f32;
    let mut text = text.to_owned();
    if line_width(font, &text, size) > max {
        while !text.is_empty() && line_width(font, &format!("{text}…"), size) > max {
            text.pop();
        }
        text.push('…');
    }
    let width = (line_width(font, &text, size) + 8.0).ceil().max(8.0) as u32;
    let height = (size * 1.5).ceil() as u32;
    let mut canvas = crate::media::Canvas::transparent(width, height);
    if !frame.card {
        canvas.rounded_card(8, [0, 0, 0], 120);
    }
    canvas.text(font, &[text], size, 4.0, size * 0.1, [190, 190, 190]);
    canvas.save(path)?;
    Ok((width, height))
}

/// Media for a scene with no usable photo: a dark gradient with the scene caption set large.
pub fn graphic_png(
    font: &fontdue::Font,
    caption: &str,
    frame: Frame,
    path: &Path,
) -> Result<(), String> {
    let (_, _, width, height) = frame.media;
    let mut canvas = crate::media::Canvas::transparent(width, height);
    canvas.vertical_gradient([28, 44, 82], [6, 8, 14]);
    canvas.fill_rect(
        width / 12,
        height / 2 - height / 5,
        width / 60 + 4,
        height / 6,
        YELLOW,
        255,
    );
    let caption = caption.trim();
    if !caption.is_empty() {
        let size = (width.min(height) / 11).max(32);
        if let Ok((lines, size)) = crate::media::fitting_text(
            font,
            caption,
            (width - width / 4) as f32,
            height as f32 * 0.5,
            size,
            24,
        ) {
            let block = lines.len() as f32 * size * 1.45;
            let y = (height as f32 - block) / 2.0;
            for (row, line) in lines.iter().enumerate() {
                canvas.text_runs(
                    font,
                    &[(line.clone(), WHITE)],
                    size,
                    (width / 8) as f32,
                    y + row as f32 * size * 1.45,
                    true,
                );
            }
        }
    }
    canvas.save(path)
}

/// Title lines for the card layout: the planner's headline, else the title split in two.
pub fn headline_lines(storyboard: &Value) -> (String, String) {
    let top = storyboard["headline"]["top"]
        .as_str()
        .unwrap_or("")
        .trim()
        .to_owned();
    let bottom = storyboard["headline"]["bottom"]
        .as_str()
        .unwrap_or("")
        .trim()
        .to_owned();
    if !top.is_empty() || !bottom.is_empty() {
        return (top, bottom);
    }
    let title = storyboard["title"]
        .as_str()
        .unwrap_or("")
        .trim()
        .trim_start_matches("[템플릿]")
        .trim()
        .to_owned();
    let words: Vec<&str> = title.split_whitespace().collect();
    if words.len() < 2 || title.chars().count() <= 12 {
        return (String::new(), title);
    }
    let half = title.chars().count() / 2;
    let mut count = 0;
    let mut split = 1;
    for (i, word) in words.iter().enumerate() {
        count += word.chars().count() + 1;
        if count >= half {
            split = i + 1;
            break;
        }
    }
    let split = split.clamp(1, words.len() - 1);
    (words[..split].join(" "), words[split..].join(" "))
}

/// On-screen credit for a scene's media.
pub fn scene_credit(scene: &Value) -> String {
    match scene["video"]["kind"].as_str() {
        Some("stock") => {
            let c = &scene["video"]["candidate"];
            let source = match c["source"].as_str().unwrap_or("") {
                "flickr" => "Flickr",
                "wikimedia" => "Wikimedia Commons",
                "stocksnap" => "StockSnap",
                "rawpixel" => "Rawpixel",
                "nasa" => "NASA",
                other => other,
            };
            format!(
                "출처: {} · {} · {}",
                c["creator"].as_str().unwrap_or("작성자 미상"),
                source,
                c["license"].as_str().unwrap_or("")
            )
        }
        Some("graphic") => String::new(),
        _ => "AI 생성 장면 · Wan2.1".into(),
    }
}

fn png_input(arguments: &mut Vec<String>, name: &str) {
    arguments.extend(
        ["-loop", "1", "-framerate", "24", "-i"]
            .iter()
            .map(|s| s.to_string()),
    );
    arguments.push(name.to_owned());
}

/// Shorts composer: stock photos with Ken Burns moves (or AI clips), the fixed title, highlighted
/// captions that pop in, number cards, credit lines and a progress bar. Every filter value is a
/// number or closed enum from Rust; user and model text only reaches the frame as app-drawn PNGs.
pub async fn compose_shorts(
    job: &Value,
    settings: &Settings,
    working: &Path,
    output: &Path,
) -> Result<f64, String> {
    let frame = frame_layout(&settings.aspect, &settings.layout);
    let font = crate::media::load_font()?;
    let media = crate::media::public_dir()?;
    let board = job["storyboard"]["scenes"]
        .as_array()
        .ok_or("스토리보드가 없습니다.")?;
    let scenes = job["scenes"].as_array().ok_or("장면이 없습니다.")?;
    let durations: Vec<f64> = scenes
        .iter()
        .map(|s| (s["durationSec"].as_f64().unwrap_or(3.5) * 24.0).ceil() / 24.0)
        .collect();
    let total: f64 = durations.iter().sum();
    let (top, bottom) = headline_lines(&job["storyboard"]);
    let has_title = !(top.is_empty() && bottom.is_empty());
    let (title_w, _) = if has_title {
        title_png(&font, &top, &bottom, frame, &working.join("title.png"))?
    } else {
        (0, 0)
    };
    let (fw, fh) = (frame.width, frame.height);
    let (mx, my, mw, mh) = frame.media;
    let mut list = String::new();
    let mut offset = 0.0;
    for (index, scene) in scenes.iter().enumerate() {
        let story = board
            .iter()
            .find(|s| s["id"] == scene["id"])
            .cloned()
            .unwrap_or(Value::Null);
        let duration = durations[index];
        let frames = (duration * 24.0).round() as u32;
        let kind = scene["video"]["kind"].as_str().unwrap_or("ai");
        let clip = crate::media::resolve_asset_at(
            &media,
            scene["video"]["path"]
                .as_str()
                .ok_or("장면 미디어가 없습니다.")?,
        )?;
        let audio = scene["voice"]["path"]
            .as_str()
            .map(|p| crate::media::resolve_asset_at(&media, p))
            .transpose()?;
        let mut arguments: Vec<String> = [
            "-hide_banner",
            "-loglevel",
            "error",
            "-nostdin",
            "-y",
            "-threads",
            "2",
            "-f",
            "lavfi",
            "-i",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect();
        arguments.push(format!("color=c=0x000000:s={fw}x{fh}:r=24"));
        arguments.extend(
            ["-protocol_whitelist", "file,pipe", "-format_whitelist"]
                .iter()
                .map(|s| s.to_string()),
        );
        if kind == "ai" {
            arguments.extend(
                ["mov", "-stream_loop", "-1", "-i"]
                    .iter()
                    .map(|s| s.to_string()),
            );
        } else {
            arguments.extend(
                [
                    "image2,png_pipe,jpeg_pipe",
                    "-loop",
                    "1",
                    "-framerate",
                    "24",
                    "-i",
                ]
                .iter()
                .map(|s| s.to_string()),
            );
        }
        arguments.push(clip.to_string_lossy().into_owned());
        if let Some(path) = &audio {
            arguments.extend(
                [
                    "-protocol_whitelist",
                    "file,pipe",
                    "-format_whitelist",
                    "wav",
                    "-i",
                ]
                .iter()
                .map(|s| s.to_string()),
            );
            arguments.push(path.to_string_lossy().into_owned());
        } else {
            arguments.extend(
                ["-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo"]
                    .iter()
                    .map(|s| s.to_string()),
            );
        }
        let mut inputs = 3;
        let media_chain = if kind == "ai" {
            format!("scale={mw}:{mh}:force_original_aspect_ratio=increase,crop={mw}:{mh},setsar=1,fps=24")
        } else {
            camera_filter(
                story["camera"].as_str().unwrap_or("zoom-in"),
                mw,
                mh,
                frames,
            )
        };
        let transition = crate::motion::Transition::from_scene(
            &json!({"transition": story["transition"].as_str().unwrap_or("cut")}),
        )?;
        let fades = transition
            .filter(duration)
            .map(|f| format!(",{f}"))
            .unwrap_or_default();
        let mut filter = format!("[1:v]{media_chain}{fades}[m];[0:v][m]overlay=x={mx}:y={my}[b0]");
        let mut last = "[b0]".to_owned();
        let mut step = 0;
        let mut add = |filter: &mut String, last: &mut String, chain: String| {
            step += 1;
            filter.push_str(&format!(";{last}{chain}[b{step}]"));
            *last = format!("[b{step}]");
        };
        if has_title && (frame.card || index == 0) {
            png_input(&mut arguments, "title.png");
            let x = (fw - title_w) / 2;
            let enter = if frame.card {
                String::new()
            } else {
                ",fade=t=in:st=0:d=0.35:alpha=1".into()
            };
            filter.push_str(&format!(";[{inputs}:v]format=rgba{enter}[title]"));
            add(
                &mut filter,
                &mut last,
                format!("[title]overlay=x={x}:y={}", frame.title.0),
            );
            inputs += 1;
        }
        let credit = scene_credit(scene);
        if !credit.is_empty() {
            let name = format!("credit-{index:03}.png");
            let (_, ch) = credit_png(&font, &credit, frame, &working.join(&name))?;
            png_input(&mut arguments, &name);
            let y = if frame.card {
                frame.credit_y
            } else {
                fh - ch - fh / 60
            };
            filter.push_str(&format!(";[{inputs}:v]format=rgba[cr]"));
            add(
                &mut filter,
                &mut last,
                format!("[cr]overlay=x={}:y={y}", fw / 20),
            );
            inputs += 1;
        }
        if let (Some(value), label) = (
            story["stat"]["value"].as_str().filter(|v| !v.is_empty()),
            story["stat"]["label"].as_str().unwrap_or(""),
        ) {
            let name = format!("stat-{index:03}.png");
            let (_, sh) = stat_png(&font, value, label, frame, &working.join(&name))?;
            png_input(&mut arguments, &name);
            let y = my + mh * 30 / 100 - sh / 2;
            filter.push_str(&format!(
                ";[{inputs}:v]format=rgba,fade=t=in:st=0.2:d=0.25:alpha=1[st]"
            ));
            add(
                &mut filter,
                &mut last,
                format!("[st]overlay=x=(W-w)/2:y='{y}+36*(1-min(1,max(0,(t-0.2)/0.3)))'"),
            );
            inputs += 1;
        }
        if settings.subtitle_style != "none" {
            let emphasis: Vec<String> = story["emphasis"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|w| w.as_str().map(str::to_owned))
                .collect();
            for (cue_index, cue) in scene["captionCues"]
                .as_array()
                .cloned()
                .unwrap_or_default()
                .iter()
                .enumerate()
            {
                let name = format!("cap-{index:03}-{cue_index:02}.png");
                let (_, ch) = emphasis_caption_png(
                    &font,
                    cue["text"].as_str().unwrap_or(""),
                    &emphasis,
                    frame,
                    &settings.subtitle_style,
                    &working.join(&name),
                )?;
                png_input(&mut arguments, &name);
                let (start, end) = (
                    cue["startSec"].as_f64().unwrap_or(0.0),
                    cue["endSec"].as_f64().unwrap_or(0.0),
                );
                let y = if settings.subtitle_style == "clean-bottom" && !frame.card {
                    fh - ch - fh / 12
                } else {
                    frame.caption_bottom.saturating_sub(ch)
                };
                filter.push_str(&format!(";[{inputs}:v]format=rgba,fade=t=in:st={start:.3}:d=0.12:alpha=1[cap{cue_index}]"));
                add(&mut filter, &mut last, format!("[cap{cue_index}]overlay=x=(W-w)/2:y='{y}+18*(1-min(1,max(0,(t-{start:.3})/0.16)))':enable='between(t,{start:.3},{end:.3})'"));
                inputs += 1;
            }
        }
        add(
            &mut filter,
            &mut last,
            format!(
                "drawbox=x=0:y={}:w='iw*({offset:.4}+t)/{total:.4}':h=8:color=0xFFD60A@0.95:t=fill",
                frame.bar_y
            ),
        );
        filter.push_str(&format!(";{last}format=yuv420p[v]"));
        let segment = format!("segment-{index:03}.mp4");
        arguments.extend(
            ["-filter_complex_threads", "1", "-filter_complex"]
                .iter()
                .map(|s| s.to_string()),
        );
        arguments.push(filter);
        arguments.extend(
            [
                "-map",
                "[v]",
                "-map",
                "2:a:0",
                "-af",
                "apad,aresample=48000",
                "-ac",
                "2",
                "-t",
            ]
            .iter()
            .map(|s| s.to_string()),
        );
        arguments.push(format!("{duration:.6}"));
        arguments.extend(
            [
                "-r",
                "24",
                "-c:v",
                "libx264",
                "-preset",
                "medium",
                "-crf",
                "19",
                "-pix_fmt",
                "yuv420p",
                "-c:a",
                "aac",
                "-b:a",
                "192k",
                "-movflags",
                "+faststart",
            ]
            .iter()
            .map(|s| s.to_string()),
        );
        arguments.push(segment.clone());
        crate::media::run_command(
            "ffmpeg",
            &arguments,
            Some(working),
            (duration as u64 * 30 + 120).min(1200),
        )
        .await?;
        list.push_str(&format!("file '{segment}'\n"));
        offset += duration;
    }
    finish_segments(working, &list, total, settings, output).await?;
    Ok(total)
}

/// Joins the per-scene segments by stream copy and mixes the synthesized BGM under the narration.
async fn finish_segments(
    working: &Path,
    list: &str,
    total: f64,
    settings: &Settings,
    output: &Path,
) -> Result<(), String> {
    std::fs::write(working.join("segments.txt"), list).map_err(|_| "장면 목록 저장 오류")?;
    let joined = working.join("joined.mp4");
    let concat: Vec<String> = [
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
        "joined.mp4",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect();
    crate::media::run_command("ffmpeg", &concat, Some(working), 300).await?;
    if settings.bgm != "none" {
        std::fs::write(
            working.join("bgm.wav"),
            wav(&synth_bgm(&settings.bgm, total), 48_000),
        )
        .map_err(|_| "배경음악을 만들 수 없습니다.")?;
        let mix: Vec<String> = ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-protocol_whitelist", "file,pipe", "-i", "joined.mp4", "-protocol_whitelist", "file,pipe", "-i", "bgm.wav",
            "-filter_complex", "[1:a]volume=0.2,aresample=48000,aformat=channel_layouts=stereo[m];[0:a][m]amix=inputs=2:duration=first:normalize=0[a]",
            "-map", "0:v", "-map", "[a]", "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", "mixed.mp4"].iter().map(|s| s.to_string()).collect();
        crate::media::run_command("ffmpeg", &mix, Some(working), 600).await?;
        std::fs::rename(working.join("mixed.mp4"), output)
            .map_err(|_| "최종 영상을 저장할 수 없습니다.")?;
    } else {
        std::fs::rename(&joined, output).map_err(|_| "최종 영상을 저장할 수 없습니다.")?;
    }
    Ok(())
}

fn sha256_path_impl(path: &Path) -> Result<String, String> {
    use std::io::Read;
    let mut file = std::fs::File::open(path).map_err(|_| "파일을 열 수 없습니다.")?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; 1 << 20];
    loop {
        let n = file.read(&mut buffer).map_err(|_| "파일 읽기 실패")?;
        if n == 0 {
            break;
        }
        hasher.update(&buffer[..n]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

/// The editor project the existing renderer understands: AI clip as full-frame scene media.
/// A draft for the SNS screen: title, description and hashtags from the storyboard. No targets,
/// no schedule: the user picks channels and approves in the existing publication flow.
pub fn publication_payload(job: &Value, media_id: &str) -> Value {
    let title: String = job["storyboard"]["title"]
        .as_str()
        .unwrap_or("AI 영상")
        .chars()
        .take(100)
        .collect();
    let story = job["storyboard"]["story"].as_str().unwrap_or("");
    let topic = job["settings"]["topic"].as_str().unwrap_or("");
    let mut tags: Vec<String> = topic
        .split(|c: char| !c.is_alphanumeric())
        .filter(|w| w.chars().count() >= 2)
        .take(5)
        .map(|w| w.to_owned())
        .collect();
    for extra in [
        if job["settings"]["visual"] == "stock" {
            "쇼츠영상"
        } else {
            "AI영상"
        },
        "쇼츠",
    ] {
        if !tags.iter().any(|t| t == extra) {
            tags.push(extra.into());
        }
    }
    let credits: Vec<String> = job["provenance"]["credits"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|c| c.as_str().map(str::to_owned))
        .collect();
    let made = if job["settings"]["visual"] == "stock" {
        "이 영상은 Toris Studio에서 상업적 이용 가능한 사진과 로컬 음성 모델(Qwen3-TTS)로 만들었습니다."
    } else {
        "이 영상은 Toris Studio에서 로컬 AI 모델(Wan2.1·Qwen3-TTS)로 만들었습니다."
    };
    let description = if credits.is_empty() {
        format!("{story}\n\n{made}")
    } else {
        let list = credits
            .iter()
            .map(|c| format!("- {c}"))
            .collect::<Vec<_>>()
            .join("\n");
        format!("{story}\n\n사진 출처\n{list}\n\n{made}")
    };
    json!({"title": title, "description": description.trim(), "tags": tags, "hashtags": tags.iter().map(|t| format!("#{t}")).collect::<Vec<_>>(),
           "contentKind": "video", "videoMediaId": media_id, "targets": []})
}

/// The shape the window reads (desktop/src/production/production-client.ts). job.json stays the source of truth.
pub fn job_view(job: &Value, running: bool) -> Value {
    let mut view = job.clone();
    let parse = |s: &str| -> Option<(u32, u32)> {
        let (w, h) = s.split_once('x')?;
        Some((w.parse().ok()?, h.parse().ok()?))
    };
    if let Some((w, h)) = job["generation"]["size"].as_str().and_then(parse) {
        view["generation"]["width"] = json!(w);
        view["generation"]["height"] = json!(h);
    }
    if let Some((w, h)) = job["generation"]["output"].as_str().and_then(parse) {
        view["output"] = json!({"width": w, "height": h});
    }
    if job["status"] == "awaiting_approval" {
        view["stages"]["storyboard"]["status"] = json!("waiting");
    }
    if job["storyboard"].is_null() && !job["draft"].is_null() {
        view["storyboard"] = job["draft"].clone();
    }
    let media = media_root().ok();
    if let Some(scenes) = view["scenes"].as_array_mut() {
        for scene in scenes {
            for part in ["video", "voice"] {
                let path = scene[part]["path"].as_str().map(str::to_owned);
                if let (Some(path), Some(media)) = (path, &media) {
                    let file = media
                        .parent()
                        .map(|public| public.join(path.trim_start_matches('/')));
                    if let Some(file) = file {
                        scene[part]["path"] = json!(file);
                    }
                }
            }
        }
    }
    if let (Some(lists), Some(public)) = (
        view["candidates"].as_object_mut(),
        media.as_ref().and_then(|m| m.parent()),
    ) {
        for list in lists.values_mut() {
            for candidate in list.as_array_mut().into_iter().flatten() {
                if let Some(preview) = candidate["preview"].as_str().map(str::to_owned) {
                    candidate["preview"] = json!(public.join(preview.trim_start_matches('/')));
                }
                if let Some(obj) = candidate.as_object_mut() {
                    obj.remove("url");
                    obj.remove("sourceSha256");
                }
            }
        }
    }
    if let Some(path) = job["outputs"]["final"].as_str() {
        view["final"] = json!({"path": path, "durationSec": job["outputs"]["durationSec"], "width": view["output"]["width"], "height": view["output"]["height"],
            "sizeBytes": std::fs::metadata(path).map(|m| m.len()).unwrap_or(0)});
    } else {
        view["final"] = Value::Null;
    }
    // The editor reads the same VideoProject the compositor validated (media paths stay public-relative).
    view["editProject"] = job["outputs"]["editProject"]
        .as_str()
        .filter(|_| job["status"] == "done")
        .and_then(|path| std::fs::read(path).ok())
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
        .unwrap_or(Value::Null);
    view["qa"] = job["qa"]["checks"].clone();
    if let Some(record) = job["provenance"].as_object() {
        let components = record
            .get("components")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        view["provenance"] = json!({"commercialUse": record.get("commercialUse") == Some(&json!(true)), "narrationRights": record.get("narrationRights"),
            "engine": components.iter().find(|c| c["role"] == "video").and_then(|c| c["name"].as_str()), "revision": components.iter().find(|c| c["role"] == "video").and_then(|c| c["revision"].as_str()),
            "licenses": components.iter().filter(|c| c["role"] != "photo").filter_map(|c| { let name = c["name"].as_str()?; let license = c["weightsLicense"].as_str().or(c["license"].as_str()).unwrap_or("기록 없음"); Some(json!({"name": name, "license": license})) }).collect::<Vec<_>>(),
            "planner": components.iter().find(|c| c["role"] == "storyboard").and_then(|c| c["name"].as_str()),
            "credits": record.get("credits").cloned().unwrap_or(json!([])),
            "notes": components.iter().filter_map(|c| c["note"].as_str()).chain(record.get("commercialUseNote").and_then(Value::as_str)).collect::<Vec<_>>()});
    }
    view["error"] = job["errors"]
        .as_array()
        .and_then(|list| list.iter().rev().find(|e| e["kind"] == "error"))
        .map(|e| json!({"stage": e["stage"], "message": e["message"]}))
        .filter(|_| job["status"] == "failed")
        .unwrap_or(Value::Null);
    view["running"] = json!(running);
    view
}

/// Files the preview may read: this job's scenes, voices and final video only.
pub fn preview_files(job: &Value) -> Vec<PathBuf> {
    let mut files = Vec::new();
    let view = job_view(job, false);
    for scene in view["scenes"].as_array().into_iter().flatten() {
        for part in ["video", "voice"] {
            if let Some(path) = scene[part]["path"].as_str() {
                files.push(PathBuf::from(path));
            }
        }
    }
    if let Some(path) = view["final"]["path"].as_str() {
        files.push(PathBuf::from(path));
    }
    for list in view["candidates"]
        .as_object()
        .into_iter()
        .flat_map(|m| m.values())
    {
        for candidate in list.as_array().into_iter().flatten() {
            if let Some(path) = candidate["preview"].as_str() {
                files.push(PathBuf::from(path));
            }
        }
    }
    files.into_iter().filter(|p| p.is_file()).collect()
}

pub fn editor_project(job: &Value, settings: &Settings) -> Result<Value, String> {
    let board = job["storyboard"]["scenes"]
        .as_array()
        .ok_or("스토리보드가 없습니다.")?;
    let format = match settings.aspect.as_str() {
        "16:9" => "youtube-landscape",
        _ => "shorts",
    };
    let scenes: Vec<Value> = job["scenes"].as_array().ok_or("장면이 없습니다.")?.iter().map(|scene| {
        let story = board.iter().find(|s| s["id"] == scene["id"]).cloned().unwrap_or(Value::Null);
        let mut out = json!({"id": scene["id"], "headline": "", "body": "", "eyebrow": "",
            "narration": story["narration"], "durationSec": scene["durationSec"], "mediaType": "video", "mediaUrl": scene["video"]["path"], "mediaFit": "cover",
            "layout": "media-focus", "transition": story["transition"], "captionCues": scene["captionCues"], "burnCaptions": settings.subtitle_style != "none"});
        if let Some(audio) = scene["voice"]["path"].as_str() { out["audioPath"] = json!(audio); }
        out
    }).collect();
    Ok(
        json!({"id": job["id"], "title": job["storyboard"]["title"], "format": format, "template": "adaptive-promo", "language": "ko", "editingPreset": "project-explainer-still",
              "scenes": scenes, "production": {"jobId": job["id"], "aspect": settings.aspect}}),
    )
}

async fn black_ratio(path: &Path) -> Result<f64, String> {
    let mut arguments: Vec<String> = [
        "-hide_banner",
        "-nostdin",
        "-protocol_whitelist",
        "file,pipe",
        "-i",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect();
    arguments.push(path.to_string_lossy().into_owned());
    arguments.extend(
        [
            "-vf",
            "fps=2,blackframe=amount=98:threshold=24,metadata=print:file=-",
            "-an",
            "-f",
            "null",
            "-",
        ]
        .iter()
        .map(|s| s.to_string()),
    );
    let output = crate::media::run_command("ffmpeg", &arguments, None, 300).await?;
    let text = String::from_utf8_lossy(&output);
    let black = text.matches("lavfi.blackframe.pblack").count();
    let probe = crate::media::probe(path).await?;
    let duration = probe["format"]["duration"]
        .as_str()
        .and_then(|d| d.parse::<f64>().ok())
        .unwrap_or(1.0)
        .max(0.5);
    Ok((black as f64 / (duration * 2.0)).min(1.0))
}

/// Returns the check list and, on failure, the earliest stage to redo.
pub fn qa_checks(
    job: &Value,
    settings: &Settings,
    probe: Option<&Value>,
    black: f64,
    bytes: u64,
) -> (Value, Option<&'static str>) {
    let (w, h) = output_size(&settings.aspect);
    let streams = probe
        .and_then(|p| p["streams"].as_array())
        .cloned()
        .unwrap_or_default();
    let video = streams.iter().find(|s| s["codec_type"] == "video");
    let audio = streams.iter().any(|s| s["codec_type"] == "audio");
    let duration = probe
        .and_then(|p| p["format"]["duration"].as_str())
        .and_then(|d| d.parse::<f64>().ok())
        .unwrap_or(0.0);
    let expected = job["outputs"]["durationSec"].as_f64().unwrap_or(0.0);
    let scenes = job["scenes"].as_array().cloned().unwrap_or_default();
    let missing = scenes
        .iter()
        .filter(|s| s["video"]["status"] != "done")
        .count();
    let voice_over = scenes
        .iter()
        .filter(|s| {
            s["voice"]["durationSec"].as_f64().unwrap_or(0.0)
                > s["durationSec"].as_f64().unwrap_or(0.0) + 0.05
        })
        .count();
    let bad_cues = scenes
        .iter()
        .flat_map(|s| {
            s["captionCues"]
                .as_array()
                .cloned()
                .unwrap_or_default()
                .into_iter()
                .map(move |c| (c, s["durationSec"].as_f64().unwrap_or(0.0)))
        })
        .filter(|(c, d)| {
            let (a, b) = (
                c["startSec"].as_f64().unwrap_or(-1.0),
                c["endSec"].as_f64().unwrap_or(-1.0),
            );
            a < 0.0 || b <= a || b > d + 0.05
        })
        .count();
    let mut checks = Vec::new();
    let mut fail: Option<&'static str> = None;
    let mut add = |id: &str, label: &str, passed: bool, detail: String, stage: &'static str| {
        if !passed && fail.is_none() {
            fail = Some(stage);
        }
        checks.push(json!({"id": id, "label": label, "passed": passed, "detail": detail}));
    };
    add(
        "file",
        "MP4 파일",
        bytes > 0 && probe.is_some(),
        format!("{} bytes", bytes),
        "edit",
    );
    add(
        "playable",
        "재생 가능한 H.264 영상",
        video.is_some(),
        if video.is_some() {
            "영상 스트림 있음".into()
        } else {
            "영상 스트림 없음".into()
        },
        "edit",
    );
    add(
        "resolution",
        "출력 해상도",
        video.is_some_and(|v| v["width"] == w && v["height"] == h),
        format!(
            "{}x{} (목표 {w}x{h})",
            video.map(|v| v["width"].clone()).unwrap_or(Value::Null),
            video.map(|v| v["height"].clone()).unwrap_or(Value::Null)
        ),
        "edit",
    );
    add(
        "duration",
        "영상 길이",
        expected > 0.0 && (duration - expected).abs() <= 0.5,
        format!("{duration:.1}초 (편집 {expected:.1}초)"),
        "edit",
    );
    add(
        "audio",
        "오디오 트랙",
        audio,
        if audio {
            "있음".into()
        } else {
            "없음".into()
        },
        "edit",
    );
    add(
        "scenes",
        "장면 누락",
        missing == 0,
        format!("누락 {missing}개"),
        "scenes",
    );
    add(
        "sync",
        "나레이션이 장면 안에 끝남",
        voice_over == 0,
        format!("넘침 {voice_over}개"),
        "voice",
    );
    add(
        "captions",
        "자막 타이밍",
        bad_cues == 0,
        format!("오류 {bad_cues}개"),
        "subtitles",
    );
    add(
        "black",
        "검은 화면",
        black < 0.2,
        format!("{:.0}%", black * 100.0),
        "scenes",
    );
    (json!(checks), fail)
}

pub fn provenance(job: &Value, settings: &Settings, final_path: &Path) -> Result<Value, String> {
    let engine = crate::video_runtime::engine(&settings.engine)?;
    let llm_provider = job["storyboard"]["provider"].as_str().unwrap_or("");
    let template = job["storyboard"]["template"] == true;
    let narration_used = job["scenes"]
        .as_array()
        .into_iter()
        .flatten()
        .any(|s| s["voice"]["status"] == "done");
    let engine_commercial = engine.blocked.is_none()
        && engine.weights_license == "Apache-2.0"
        && engine.code_license == "MIT";
    let scenes_list = job["scenes"].as_array().cloned().unwrap_or_default();
    // An AI job is credited to its engine; a stock job only if some scene really ran inference.
    let ai_used = settings.visual != "stock"
        || scenes_list
            .iter()
            .any(|s| s["video"]["source"] == "ai-inference");
    let photos: Vec<&Value> = scenes_list
        .iter()
        .filter(|s| s["video"]["kind"] == "stock")
        .map(|s| &s["video"]["candidate"])
        .collect();
    let photos_cleared = photos.iter().all(|c| crate::stock_media::cleared(c));
    let video_commercial = (!ai_used || engine_commercial) && photos_cleared;
    let mut components = Vec::new();
    if ai_used {
        components.push(json!({"role": "video", "name": engine.label, "repo": engine.repo, "revision": engine.revision, "weightsLicense": engine.weights_license, "code": format!("ml-explore/mlx-examples@{}", crate::video_runtime::MLX_EXAMPLES_COMMIT), "codeLicense": engine.code_license, "commercialUse": engine_commercial}));
    }
    let mut seen = std::collections::HashSet::new();
    for photo in &photos {
        if seen.insert(photo["id"].as_str().unwrap_or("").to_owned()) {
            components.push(json!({"role": "photo", "name": photo["title"], "creator": photo["creator"], "source": photo["source"], "license": photo["license"],
                "licenseUrl": photo["licenseUrl"], "page": photo["page"], "attributionRequired": photo["attributionRequired"], "sha256": photo["sha256"],
                "commercialUse": crate::stock_media::cleared(photo), "credit": crate::stock_media::credit_line(photo)}));
        }
    }
    components.extend([
        json!({"role": "editor", "name": "Toris Studio Rust renderer + FFmpeg 9.0.2 (GPL build, separate process)", "license": "app + GPL-2.0-or-later ffmpeg", "commercialUse": true}),
        json!({"role": "bgm", "name": if settings.bgm == "none" { "없음" } else { "코드 합성 (외부 음원 없음)" }, "license": "앱 생성물", "commercialUse": true}),
    ]);
    if narration_used {
        components.push(json!({"role": "narration", "name": "Qwen3-TTS-12Hz-1.7B-CustomVoice-8bit", "repo": "mlx-community/Qwen3-TTS-12Hz-1.7B-CustomVoice-8bit", "speaker": settings.speaker, "weightsLicense": "Apache-2.0", "runtime": "mlx-audio (MIT)", "commercialUse": "conditional",
            "note": "내장 화자의 원 화자 권리 범위는 Qwen이 공개하지 않았습니다."}));
    }
    let model = job["storyboard"]["model"].as_str().unwrap_or("");
    let (planner, note) = if template {
        ("템플릿 (AI 미사용)".to_owned(), "앱 템플릿")
    } else if llm_provider.is_empty() {
        (
            "사용자 입력 (AI 미사용)".to_owned(),
            "사용자가 직접 쓴 스토리보드",
        )
    } else {
        (
            format!("{llm_provider} {model}").trim().to_owned(),
            "사용자 계정의 모델 공급자 약관을 따릅니다.",
        )
    };
    components.push(
        json!({"role": "storyboard", "name": planner, "commercialUse": Value::Null, "note": note}),
    );
    let scenes: Vec<Value> = job["scenes"].as_array().into_iter().flatten().map(|s| json!({"id": s["id"], "video": {"sha256": s["video"]["sha256"], "seed": s["video"]["seed"], "prompt": s["video"]["prompt"], "size": s["video"]["size"], "frames": s["video"]["frames"], "steps": s["video"]["steps"], "source": s["video"]["source"], "photo": s["video"]["candidate"]["id"]}, "voice": {"path": s["voice"]["path"], "speaker": s["voice"]["speaker"]}})).collect();
    Ok(
        json!({"version": 1, "jobId": job["id"], "createdAt": now(), "final": {"sha256": sha256_path(final_path)?, "size": job["generation"]["output"], "generationSize": job["generation"]["size"]},
        "commercialUse": video_commercial,
        "credits": photos.iter().map(|c| crate::stock_media::credit_line(c)).collect::<std::collections::BTreeSet<_>>().into_iter().collect::<Vec<_>>(),
        "commercialUseNote": if !photos.is_empty() {
            "사진은 CC0·퍼블릭 도메인·CC BY만 썼고 CC BY 사진은 영상과 게시글에 출처를 표시합니다. 사진 속 인물·상표·건축물의 권리는 별도로 확인하세요. 나레이션 내장 화자의 원 화자 권리는 Qwen이 밝히지 않아 조건부입니다. 법률 자문이 아닙니다."
        } else if narration_used {
            "영상 모델·편집 도구는 상업적 이용을 허용합니다. 나레이션 모델도 Apache-2.0이지만 내장 화자의 원 화자 권리는 Qwen이 밝히지 않아 조건부입니다(docs/COMMERCIAL_LICENSES.md). 프롬프트·인물·상표 등 결과물 내용의 권리는 사용자가 확인해야 합니다. 법률 자문이 아닙니다."
        } else {
            "영상 모델·편집 도구는 상업적 이용을 허용하는 라이선스입니다. 프롬프트·인물·상표 등 결과물 내용의 권리는 사용자가 확인해야 합니다. 법률 자문이 아닙니다."
        },
        "narrationRights": if narration_used { "conditional" } else { "none" },
        "components": components, "scenes": scenes}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn settings() -> Settings {
        parse_settings(&json!({"topic": "2050년 미래 서울을 보여주는 30초 시네마틱 쇼츠", "durationSec": 30, "aspect": "9:16", "style": "cinematic", "narration": true,
            "subtitleStyle": "shorts-bold", "bgm": "ambient", "quality": "preview", "engine": "wan2.1-t2v-1.3b"})).unwrap()
    }
    fn board(n: usize, each: f64) -> Value {
        json!({"title": "2050 서울", "story": "미래 도시", "style": {"look": "neon", "palette": "teal and amber", "consistency": "same skyline"},
            "scenes": (0..n).map(|i| json!({"id": format!("s{}", i + 1), "order": i + 1, "durationSec": each, "script": "장면", "narration": "서울의 하늘을 나는 차들.", "caption": "하늘길", "prompt": "flying cars over Seoul at dusk", "transition": "fade"})).collect::<Vec<_>>()})
    }

    #[test]
    fn one_line_request_creates_a_planning_job_with_low_generation_and_full_output() {
        let s = settings();
        let job = new_job(&s);
        assert_eq!(job["status"], "planning");
        assert_eq!(job["generation"]["size"], "368x640");
        assert_eq!(job["generation"]["output"], "1080x1920");
        assert_eq!(scene_count(30, "ai"), 6);
        assert_eq!(scene_count(15, "ai"), 3);
        assert_eq!(scene_count(120, "ai"), 12);
        assert_eq!(
            scene_count(15, "stock"),
            5,
            "stock cuts are about 3.5s like the reference shorts"
        );
        assert_eq!(scene_count(30, "stock"), 9);
        for bad in [
            json!({"topic": ""}),
            json!({"topic": "a", "durationSec": 5}),
            json!({"topic": "a", "durationSec": 30, "aspect": "4:3"}),
        ] {
            let mut input = serde_json::to_value(&s).unwrap();
            for (k, v) in bad.as_object().unwrap() {
                input[k] = v.clone();
            }
            assert!(parse_settings(&input).is_err(), "{bad}");
        }
        let mut extra = serde_json::to_value(&s).unwrap();
        extra["command"] = json!("rm -rf /");
        assert!(
            parse_settings(&extra).is_err(),
            "unknown fields are refused"
        );
    }

    #[test]
    fn storyboard_accepts_only_known_fields_and_safe_text() {
        let s = settings();
        assert!(validate_storyboard(&board(6, 5.0), &s).is_ok());
        let mut extra = board(6, 5.0);
        extra["scenes"][0]["shell"] = json!("ls");
        assert!(validate_storyboard(&extra, &s)
            .unwrap_err()
            .contains("shell"));
        for (field, value) in [
            ("prompt", "see https://evil.test"),
            ("prompt", "../../etc/passwd"),
            ("narration", "```rm```"),
            ("caption", "$(whoami)"),
        ] {
            let mut bad = board(6, 5.0);
            bad["scenes"][1][field] = json!(value);
            assert!(validate_storyboard(&bad, &s).is_err(), "{field}={value}");
        }
        assert!(
            validate_storyboard(&board(1, 30.0), &s).is_err(),
            "too few scenes"
        );
        assert!(
            validate_storyboard(&board(6, 12.0), &s).is_err(),
            "72s is far from 30s"
        );
        let mut silent = board(6, 5.0);
        silent["scenes"][2]["narration"] = json!("");
        assert!(
            validate_storyboard(&silent, &s).is_err(),
            "narration on means every scene speaks"
        );
    }

    #[test]
    fn cached_scenes_survive_reapproval_and_a_changed_scene_invalidates_only_dependents() {
        let s = settings();
        let mut job = new_job(&s);
        apply_storyboard(&mut job, board(6, 5.0)).unwrap();
        assert_eq!(next_work(&job), Some(Work::Scene("s1".into())));
        for scene in job["scenes"].as_array_mut().unwrap() {
            scene["video"]["status"] = json!("done");
            scene["voice"]["status"] = json!("done");
        }
        for stage in ["scenes", "voice", "subtitles", "edit", "qa"] {
            job["stages"][stage]["status"] = json!("done");
        }
        assert_eq!(next_work(&job), None);
        let mut changed = board(6, 5.0);
        changed["scenes"][3]["prompt"] = json!("a different shot of Han river");
        apply_storyboard(&mut job, changed).unwrap();
        let pending: Vec<_> = job["scenes"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|s| s["video"]["status"] != "done")
            .map(|s| s["id"].as_str().unwrap().to_owned())
            .collect();
        assert_eq!(pending, ["s4"], "only the edited scene regenerates");
        assert!(
            job["scenes"]
                .as_array()
                .unwrap()
                .iter()
                .all(|s| s["voice"]["status"] == "done"),
            "same narration keeps cached voice"
        );
        assert_eq!(job["stages"]["subtitles"]["status"], "pending");
        assert_eq!(job["stages"]["edit"]["status"], "pending");
    }

    #[test]
    fn restart_turns_running_work_into_resumable_pending_work() {
        let mut job = new_job(&settings());
        apply_storyboard(&mut job, board(6, 5.0)).unwrap();
        job["status"] = json!("running");
        job["scenes"][0]["video"]["status"] = json!("done");
        job["scenes"][1]["video"]["status"] = json!("running");
        job["stages"]["scenes"]["status"] = json!("running");
        assert!(recover(&mut job));
        assert_eq!(job["status"], "paused");
        assert_eq!(job["scenes"][1]["video"]["status"], "pending");
        assert_eq!(
            job["scenes"][0]["video"]["status"], "done",
            "finished scenes are kept"
        );
        assert_eq!(next_work(&job), Some(Work::Scene("s2".into())));
        let mut waiting = new_job(&settings());
        waiting["status"] = json!("awaiting_approval");
        assert!(
            !recover(&mut waiting),
            "a job waiting for approval keeps waiting"
        );
    }

    #[test]
    fn retry_touches_only_the_chosen_scene_and_later_stages() {
        let mut job = new_job(&settings());
        apply_storyboard(&mut job, board(6, 5.0)).unwrap();
        for scene in job["scenes"].as_array_mut().unwrap() {
            scene["video"]["status"] = json!("done");
            scene["voice"]["status"] = json!("done");
        }
        for stage in ["scenes", "voice", "subtitles", "edit", "qa"] {
            job["stages"][stage]["status"] = json!("done");
        }
        job["status"] = json!("done");
        let seed = job["scenes"][2]["video"]["seed"].clone();
        mark_retry(&mut job, Some("s3"), "scenes").unwrap();
        assert_eq!(job["scenes"][2]["video"]["status"], "pending");
        assert_ne!(
            job["scenes"][2]["video"]["seed"], seed,
            "regeneration uses a new seed"
        );
        assert_eq!(job["scenes"][1]["video"]["status"], "done");
        assert_eq!(job["stages"]["voice"]["status"], "done");
        assert_eq!(job["status"], "paused");
        mark_retry(&mut job, Some("s5"), "voice").unwrap();
        assert_eq!(job["scenes"][4]["voice"]["status"], "pending");
        assert_eq!(job["scenes"][4]["video"]["status"], "done");
        assert!(mark_retry(&mut job, Some("nope"), "scenes").is_err());
        assert!(mark_retry(&mut job, None, "plan").is_err());
    }

    #[test]
    fn captions_follow_measured_voice_and_never_pass_the_scene() {
        assert_eq!(
            spoken("[IT 뉴스][Ryan] **새 기능**을 봅니다.\n[쉼:400] 끝."),
            "새 기능을 봅니다. 끝."
        );
        let cues = caption_cues("첫 문장입니다. 두 번째 문장은 조금 더 깁니다.", 3.0, 5.0);
        assert_eq!(cues.len(), 2);
        assert!(cues.windows(2).all(|w| w[0].1 <= w[1].0 + 1e-9));
        assert!(
            cues.last().unwrap().1 <= 3.0 + 1e-9,
            "captions end with the voice"
        );
        let long = caption_cues(&"가".repeat(80), 9.0, 4.0);
        assert!(
            long.iter().all(|c| c.1 <= 4.0 + 1e-9),
            "never past the scene"
        );
        let text = srt(&[(0.0, 1.5, "안녕".into()), (61.25, 62.0, "끝".into())]);
        assert!(text.starts_with("1\n00:00:00,000 --> 00:00:01,500\n안녕\n"));
        assert!(text.contains("00:01:01,250 --> 00:01:02,000"));
    }

    #[test]
    fn qa_failure_names_the_stage_to_redo() {
        let s = settings();
        let mut job = new_job(&s);
        apply_storyboard(&mut job, board(6, 5.0)).unwrap();
        for scene in job["scenes"].as_array_mut().unwrap() {
            scene["video"]["status"] = json!("done");
            scene["voice"]["durationSec"] = json!(3.0);
        }
        job["outputs"]["durationSec"] = json!(30.0);
        let good = json!({"format": {"duration": "30.0"}, "streams": [{"codec_type": "video", "width": 1080, "height": 1920}, {"codec_type": "audio"}]});
        let (checks, fail) = qa_checks(&job, &s, Some(&good), 0.0, 1000);
        assert_eq!(fail, None, "{checks}");
        let small = json!({"format": {"duration": "30.0"}, "streams": [{"codec_type": "video", "width": 720, "height": 1280}, {"codec_type": "audio"}]});
        assert_eq!(
            qa_checks(&job, &s, Some(&small), 0.0, 1000).1,
            Some("edit"),
            "wrong size is an edit problem"
        );
        assert_eq!(
            qa_checks(&job, &s, Some(&good), 0.6, 1000).1,
            Some("scenes"),
            "black output points at scene generation"
        );
        job["scenes"][0]["voice"]["durationSec"] = json!(9.0);
        assert_eq!(qa_checks(&job, &s, Some(&good), 0.0, 1000).1, Some("voice"));
        assert_eq!(
            qa_checks(&job, &s, None, 0.0, 0).1,
            Some("edit"),
            "a missing or unreadable file fails"
        );
    }

    #[test]
    fn bgm_is_synthesized_and_wav_is_valid_pcm() {
        let pcm = synth_bgm("ambient", 1.0);
        assert_eq!(pcm.len(), 48_000 * 2);
        assert!(pcm.chunks_exact(2).any(|c| c != [0, 0]));
        let file = wav(&pcm, 48_000);
        assert_eq!(&file[0..4], b"RIFF");
        assert_eq!(
            u32::from_le_bytes(file[40..44].try_into().unwrap()) as usize,
            pcm.len()
        );
        assert_ne!(synth_bgm("pulse", 1.0), pcm);
    }

    #[test]
    fn commercial_flag_comes_only_from_licensed_engines() {
        let s = settings();
        let mut job = new_job(&s);
        apply_storyboard(&mut job, board(6, 5.0)).unwrap();
        let file = tempfile::NamedTempFile::new().unwrap();
        std::fs::write(file.path(), b"mp4").unwrap();
        let record = provenance(&job, &s, file.path()).unwrap();
        assert_eq!(record["commercialUse"], true);
        assert_eq!(
            record["components"][0]["revision"],
            "37ec512624d61f7aa208f7ea8140a131f93afc9a"
        );
        assert_eq!(record["final"]["sha256"].as_str().unwrap().len(), 64);
        let mut blocked = s.clone();
        blocked.engine = "wan2.1-i2v-14b".into();
        assert_eq!(
            provenance(&job, &blocked, file.path()).unwrap()["commercialUse"],
            false,
            "a blocked engine never yields a commercial claim"
        );
    }

    #[test]
    fn publication_draft_has_no_targets_or_schedule() {
        let mut job = new_job(&settings());
        apply_storyboard(&mut job, board(6, 5.0)).unwrap();
        let draft = publication_payload(&job, "8f0f2b4e-6a1d-4c7e-9d1b-2f6a0c3e5b7a");
        assert_eq!(draft["targets"], json!([]));
        assert!(draft.get("scheduledAt").is_none());
        assert_eq!(draft["contentKind"], "video");
    }

    #[test]
    fn edited_approval_keeps_the_planner_recorded_in_the_draft() {
        let s = settings();
        let mut draft = board(6, 5.0);
        draft["provider"] = json!("kiro-cli");
        draft["model"] = json!("claude-opus-5.5");
        draft["template"] = json!(false);
        let mut edited = board(6, 5.0);
        edited["title"] = json!("고친 제목");
        edited["provider"] = json!("forged");
        let mut job = new_job(&s);
        apply_storyboard(&mut job, with_plan_origin(edited, &draft)).unwrap();
        assert_eq!(job["storyboard"]["title"], "고친 제목");
        assert_eq!(job["storyboard"]["provider"], "kiro-cli");
        assert_eq!(job["storyboard"]["model"], "claude-opus-5.5");
        let template = with_plan_origin(board(6, 5.0), &json!({"template": true}));
        assert_eq!(template["template"], true);
        assert!(template.get("provider").is_none());
    }

    fn stock_settings() -> Settings {
        parse_settings(&json!({"topic": "법의 허점을 노린 천재 건축가의 아파트", "durationSec": 15, "aspect": "9:16", "style": "documentary", "narration": true,
            "subtitleStyle": "shorts-bold", "bgm": "pulse", "quality": "preview", "engine": "", "visual": "stock", "layout": "card"})).unwrap()
    }
    fn photo(id: &str, license: &str) -> Value {
        json!({"id": id, "provider": "openverse", "source": "flickr", "title": "Vancouver House", "creator": "Haatu", "license": "CC BY 2.0", "licenseCode": license,
            "attributionRequired": license == "by", "page": "https://www.flickr.com/photos/x/1", "url": "https://live.staticflickr.com/1/2_b.jpg", "width": 1024, "height": 1365,
            "sha256": format!("sha-{id}"), "preview": format!("/productions/j/candidates/s1/{id}.jpg")})
    }
    fn stock_board(n: usize) -> Value {
        json!({"title": "법의 허점을 노린 천재 건축가의 아파트", "headline": {"top": "법의 허점(?)을 노린", "bottom": "천재 건축가의 아파트"}, "story": "",
            "style": {"look": "", "palette": "", "consistency": ""},
            "scenes": (0..n).map(|i| json!({"id": format!("s{}", i + 1), "order": i + 1, "durationSec": 3.0, "script": "", "narration": "다리에서 30m 떨어져야 했다.",
                "caption": "최소 30m", "prompt": "", "transition": "cut", "search": "vancouver house tower", "emphasis": ["30m"], "camera": "pan-up",
                "stat": if i == 1 { json!({"value": "30m", "label": "다리와의 거리"}) } else { Value::Null }})).collect::<Vec<_>>()})
    }

    #[test]
    fn stock_jobs_need_no_ai_prompt_and_keep_layout_fields() {
        let s = stock_settings();
        assert_eq!(
            s.engine,
            crate::video_runtime::DEFAULT_ENGINE,
            "an empty engine choice is fine for stock photos"
        );
        let board = validate_storyboard(&stock_board(5), &s).unwrap();
        assert_eq!(board["headline"]["bottom"], "천재 건축가의 아파트");
        assert_eq!(board["scenes"][1]["stat"]["value"], "30m");
        assert_eq!(board["scenes"][0]["camera"], "pan-up");
        let mut bad = stock_board(5);
        bad["scenes"][0]["camera"] = json!("spin");
        assert!(
            validate_storyboard(&bad, &s).is_err(),
            "camera moves are a closed list"
        );
        let mut bad = stock_board(5);
        bad["scenes"][0]["emphasis"] = json!(["a", "b", "c", "d"]);
        assert!(
            validate_storyboard(&bad, &s).is_err(),
            "at most three highlighted words"
        );
        let mut bad = stock_board(5);
        bad["headline"]["top"] = json!("https://evil.example");
        assert!(validate_storyboard(&bad, &s).is_err());
        let mut legacy = settings();
        legacy.visual = default_visual();
        assert_eq!(
            (legacy.visual.as_str(), default_layout().as_str()),
            ("ai", "full"),
            "pre-0.6 jobs keep the AI full-frame path"
        );
    }

    #[test]
    fn stock_scenes_use_the_picked_photo_and_retry_moves_to_the_next_one() {
        let s = stock_settings();
        let mut job = new_job(&s);
        job["candidates"] =
            json!({"s1": [photo("ov-a", "by"), photo("ov-b", "cc0"), photo("ov-c", "pdm")]});
        let mut board = stock_board(5);
        board["scenes"][0]["imageId"] = json!("ov-b");
        apply_storyboard(&mut job, board.clone()).unwrap();
        assert_eq!(job["scenes"][0]["video"]["candidate"]["id"], "ov-b");
        assert_eq!(
            job["scenes"][1]["video"]["kind"], "graphic",
            "a scene with no photo gets a drawn card"
        );
        assert_eq!(next_work(&job), Some(Work::Scene("s1".into())));
        job["scenes"][0]["video"]["status"] = json!("done");
        mark_retry(&mut job, Some("s1"), "scenes").unwrap();
        assert_eq!(
            job["scenes"][0]["video"]["candidate"]["id"], "ov-c",
            "다른 사진으로 picks the next candidate"
        );
        assert_eq!(job["scenes"][0]["video"]["status"], "pending");
        job["scenes"][0]["video"]["status"] = json!("done");
        let kept = job["scenes"][0]["video"].clone();
        let mut again = board;
        again["scenes"][0]["imageId"] = json!("ov-c");
        apply_storyboard(&mut job, again).unwrap();
        assert_eq!(
            job["scenes"][0]["video"], kept,
            "re-approving with the same photo keeps the finished file"
        );
    }

    #[test]
    fn provenance_credits_every_photo_and_refuses_uncleared_ones() {
        let s = stock_settings();
        let mut job = new_job(&s);
        job["candidates"] = json!({"s1": [photo("ov-a", "by")], "s2": [photo("ov-b", "cc0")]});
        apply_storyboard(&mut job, stock_board(5)).unwrap();
        let dir = tempfile::tempdir().unwrap();
        let final_path = dir.path().join("final.mp4");
        std::fs::write(&final_path, b"x").unwrap();
        let record = provenance(&job, &s, &final_path).unwrap();
        assert_eq!(record["commercialUse"], true);
        assert_eq!(
            record["credits"].as_array().unwrap().len(),
            1,
            "same title/creator/licence credit is listed once"
        );
        assert!(
            record["components"]
                .as_array()
                .unwrap()
                .iter()
                .all(|c| c["role"] != "video"),
            "no AI engine is credited when none ran"
        );
        job["scenes"][0]["video"]["candidate"]["licenseCode"] = json!("by-sa");
        assert_eq!(
            provenance(&job, &s, &final_path).unwrap()["commercialUse"],
            false,
            "a tampered licence fails the commercial flag"
        );
        job["provenance"] = record;
        let post = publication_payload(&job, "m1");
        assert!(post["description"]
            .as_str()
            .unwrap()
            .contains("사진 출처\n- \"Vancouver House\" by Haatu (Flickr), CC BY 2.0"));
    }

    #[test]
    fn captions_break_between_words() {
        let Ok(font) = crate::media::load_font() else {
            return;
        };
        let lines = caption_lines(&font, "다리에서 30m 떨어져 지어야 했거든요.", 52.0, 760.0);
        assert!(lines.len() >= 2);
        assert!(lines
            .iter()
            .all(|l| !l.starts_with(' ') && !l.ends_with(' ')));
        assert_eq!(
            lines.join(" "),
            "다리에서 30m 떨어져 지어야 했거든요.",
            "no word is cut in the middle"
        );
        assert!(
            caption_lines(&font, &"가".repeat(60), 52.0, 400.0).len() > 1,
            "an unspaced run still wraps by width"
        );
    }

    #[test]
    fn card_layout_and_motion_values_stay_in_the_frame() {
        let card = frame_layout("9:16", "card");
        assert_eq!((card.width, card.height), (1080, 1920));
        let (x, y, w, h) = card.media;
        assert!(
            y >= card.title.0 + card.title.1
                && y + h <= card.credit_y
                && x + w <= card.width
                && w % 2 == 0
                && h % 2 == 0
        );
        assert!(card.caption_bottom < y + h && card.bar_y < card.height);
        for aspect in ["16:9", "1:1"] {
            let f = frame_layout(aspect, "card");
            assert!(
                f.media.1 + f.media.3 <= f.credit_y && f.credit_y < f.height,
                "{aspect}"
            );
        }
        assert!(camera_filter("pan-up", 1080, 1060, 84).contains("s=1080x1060"));
        assert!(
            camera_filter("unknown", 1080, 1060, 84).contains("1+0.16*"),
            "an unknown camera falls back to zoom-in"
        );
        assert_eq!(
            emphasis_runs("최소 30m 떨어져야", &["30m".into()]),
            vec![
                ("최소 ".into(), false),
                ("30m".into(), true),
                (" 떨어져야".into(), false)
            ]
        );
        assert_eq!(
            headline_lines(&json!({"title": "법의 허점을 노린 천재 건축가의 아파트"})),
            ("법의 허점을 노린".into(), "천재 건축가의 아파트".into())
        );
    }

    #[test]
    fn editor_project_is_a_valid_existing_video_project() {
        let s = settings();
        let mut job = new_job(&s);
        apply_storyboard(&mut job, board(6, 5.0)).unwrap();
        for (i, scene) in job["scenes"].as_array_mut().unwrap().iter_mut().enumerate() {
            scene["video"]["path"] = json!(format!("/productions/x/scenes/s{}/k.mp4", i + 1));
            scene["captionCues"] = json!([{"startSec": 0.0, "endSec": 1.0, "text": "하늘길"}]);
        }
        let project = editor_project(&job, &s).unwrap();
        crate::media::validate_project(&project).unwrap();
        assert_eq!(project["scenes"][0]["mediaType"], "video");
    }
}
