//! Typed Reason Network video handoff. Messages are data, never commands.
//!
//! This module does not run a model, render, publish, send a message or unlock credentials.
//! Callers persist the request marker together with a newly created job BEFORE planning,
//! and serialize lookup/create/write so repeated deliveries cannot create duplicate work.
use crate::production::{self, Settings};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{fs, path::Path};
use uuid::Uuid;

pub const VIDEO_REQUEST_SCHEMA: &str = "toris-studio.video.v1";
pub const MAX_REQUEST_BYTES: usize = 32 * 1024;
const MAX_JOB_BYTES: u64 = 4 * 1024 * 1024;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VideoRequest {
    pub schema: String,
    pub request_id: String,
    pub settings: Settings,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub storyboard: Option<ExternalStoryboard>,
}

/// The remote author supplies content, never model attribution, asset IDs or actions.
/// Closed structs also reject duplicate keys when parsing the original JSON message.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExternalStoryboard {
    pub title: String,
    #[serde(default)]
    pub story: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub headline: Option<ExternalHeadline>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub style: Option<ExternalStyle>,
    pub scenes: Vec<ExternalScene>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ExternalHeadline {
    #[serde(default)]
    pub top: String,
    #[serde(default)]
    pub bottom: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ExternalStyle {
    #[serde(default)]
    pub look: String,
    #[serde(default)]
    pub palette: String,
    #[serde(default)]
    pub consistency: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExternalScene {
    pub id: String,
    pub duration_sec: f64,
    #[serde(default)]
    pub script: String,
    #[serde(default)]
    pub narration: String,
    #[serde(default)]
    pub caption: String,
    #[serde(default)]
    pub prompt: String,
    #[serde(default)]
    pub negative_prompt: String,
    #[serde(default = "default_transition")]
    pub transition: String,
    #[serde(default)]
    pub search: String,
    #[serde(default)]
    pub emphasis: Vec<String>,
    #[serde(default = "default_camera")]
    pub camera: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stat: Option<ExternalStat>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ExternalStat {
    pub value: String,
    #[serde(default)]
    pub label: String,
}

fn default_transition() -> String {
    "cut".into()
}
fn default_camera() -> String {
    "zoom-in".into()
}

fn validate_request_id(id: &str) -> Result<(), String> {
    if id.is_empty()
        || id.len() > 80
        || !id
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
    {
        return Err("영상 요청 ID는 영문·숫자·밑줄·하이픈 1~80자여야 합니다.".into());
    }
    Ok(())
}

fn normalized_settings(request: &VideoRequest) -> Result<Settings, String> {
    if request.schema != VIDEO_REQUEST_SCHEMA {
        return Err(
            "지원하지 않는 영상 요청 버전입니다. toris-studio.video.v1을 사용하세요.".into(),
        );
    }
    validate_request_id(&request.request_id)?;
    let value =
        serde_json::to_value(&request.settings).map_err(|_| "영상 요청 설정을 읽지 못했습니다.")?;
    production::parse_settings(&value)
}

/// Ordinary chat and unrelated JSON are not jobs. Recognized video requests must be
/// one complete JSON object, with no Markdown fences, extra text or unknown fields.
pub fn parse_video_request(text: &str) -> Result<Option<VideoRequest>, String> {
    let body = text.trim();
    if !body.starts_with('{') {
        if body.contains(VIDEO_REQUEST_SCHEMA) && (body.starts_with('[') || body.starts_with("```"))
        {
            return Err("영상 요청은 코드 블록이나 배열 없이 JSON 객체 하나로 보내세요.".into());
        }
        return Ok(None);
    }
    if body.len() > MAX_REQUEST_BYTES {
        return Err("영상 요청 JSON은 32 KiB 이하여야 합니다.".into());
    }
    let value: Value = serde_json::from_str(body)
        .map_err(|_| "영상 요청 JSON을 읽지 못했습니다. 완전한 JSON 객체 하나를 보내세요.")?;
    let schema = value.get("schema").and_then(Value::as_str).unwrap_or("");
    if schema != VIDEO_REQUEST_SCHEMA {
        if schema.starts_with("toris-studio.video.") {
            return Err(
                "지원하지 않는 영상 요청 버전입니다. toris-studio.video.v1을 사용하세요.".into(),
            );
        }
        return Ok(None);
    }
    // Deserialize the ORIGINAL text, not Value: this also rejects duplicate keys.
    let mut request: VideoRequest = serde_json::from_str(body).map_err(|_| {
        "영상 요청의 필드와 자료형을 확인하세요. schema, requestId, settings와 선택 사항인 storyboard만 허용됩니다."
    })?;
    request.settings = normalized_settings(&request)?;
    let _ = imported_storyboard(&request)?;
    Ok(Some(request))
}

/// Stable origin-bound identity. Length prefixes prevent ambiguous concatenation.
/// Settings are deliberately excluded: a changed payload under this key is rejected.
pub fn request_key(network_session: &str, from: &str, request_id: &str) -> String {
    let mut digest = Sha256::new();
    digest.update(b"TorisStudioReasonVideoRequest:v1\0");
    for part in [network_session, from, request_id] {
        digest.update((part.len() as u64).to_be_bytes());
        digest.update(part.as_bytes());
    }
    format!("{:x}", digest.finalize())
}

/// Validate external content with the same bounded contract as the local editor.
/// Attribution records the transport only; a sender cannot claim a model ran in Studio.
pub fn imported_storyboard(request: &VideoRequest) -> Result<Option<Value>, String> {
    let settings = normalized_settings(request)?;
    request
        .storyboard
        .as_ref()
        .map(|storyboard| {
            let raw = serde_json::to_value(storyboard)
                .map_err(|_| "받은 스토리보드를 읽지 못했습니다.")?;
            let mut draft = production::validate_storyboard(&raw, &settings)?;
            draft["template"] = json!(false);
            draft["provider"] = json!("reason-network");
            draft["model"] = json!("");
            Ok(draft)
        })
        .transpose()
}

/// Hash all normalized creative input. Keep the original settings-only hash for
/// legacy requests, so an app update cannot make an existing request incompatible.
pub fn settings_hash(request: &VideoRequest) -> Result<String, String> {
    let settings = normalized_settings(request)?;
    let bytes = match imported_storyboard(request)? {
        Some(storyboard) => serde_json::to_vec(&json!({
            "settings": settings, "storyboard": storyboard
        })),
        None => serde_json::to_vec(&settings),
    }
    .map_err(|_| "영상 요청 설정을 확인하지 못했습니다.")?;
    Ok(format!("{:x}", Sha256::digest(bytes)))
}

fn validate_key(key: &str) -> Result<(), String> {
    if key.len() != 64
        || !key
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
    {
        return Err("영상 요청 연결 식별자가 올바르지 않습니다.".into());
    }
    Ok(())
}

fn matches_request(marker: &Value, key: &str, request: &VideoRequest) -> Result<(), String> {
    if marker["key"] != key
        || marker["schema"] != request.schema
        || marker["requestId"] != request.request_id
        || marker["settingsHash"] != settings_hash(request)?
    {
        return Err("같은 영상 요청 ID의 내용이 변경되었습니다. 새 requestId로 보내세요.".into());
    }
    Ok(())
}

/// Attach to a fresh production::new_job result before the caller atomically saves it.
/// Repeated identical requests retain the first delivery's provenance.
pub fn attach_request(
    job: &mut Value,
    key: &str,
    from: &str,
    message_id: &str,
    request: &VideoRequest,
) -> Result<(), String> {
    validate_key(key)?;
    let hash = settings_hash(request)?;
    if from.trim().is_empty()
        || from.len() > 512
        || from.chars().any(char::is_control)
        || message_id.len() > 512
        || message_id.chars().any(char::is_control)
    {
        return Err("영상 요청의 발신자·메시지 식별자를 확인하세요.".into());
    }
    if !job.is_object() {
        return Err("영상 작업 기록 형식이 올바르지 않습니다.".into());
    }
    if !job["reasonRequest"].is_null() {
        matches_request(&job["reasonRequest"], key, request)?;
        if job["reasonRequest"]["from"] != from {
            return Err("기존 영상 요청의 발신자가 다릅니다.".into());
        }
        return Ok(());
    }
    if let Some(storyboard) = imported_storyboard(request)? {
        // The first atomic job write contains the received draft. Candidate lookup
        // may continue asynchronously, but it cannot discard or replace this script.
        job["draft"] = storyboard;
    }
    job["reasonRequest"] = json!({
        "key": key,
        "schema": request.schema,
        "requestId": request.request_id,
        "from": from,
        "messageId": message_id,
        "settingsHash": hash
    });
    Ok(())
}

/// Read durable markers, including jobs older than the UI's recent-job limit.
/// This does not mutate jobs or resume work. The caller must lock lookup/create/write.
pub fn find_existing_request(
    root: &Path,
    key: &str,
    request: &VideoRequest,
) -> Result<Option<Value>, String> {
    validate_key(key)?;
    let _ = settings_hash(request)?;
    let entries = match fs::read_dir(root) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("저장된 영상 요청 목록을 읽지 못했습니다.".into()),
    };
    let mut found = None;
    for entry in entries {
        let entry = entry.map_err(|_| "저장된 영상 요청을 확인하지 못했습니다.")?;
        if !entry
            .file_type()
            .map_err(|_| "영상 작업 폴더를 확인하지 못했습니다.")?
            .is_dir()
        {
            continue;
        }
        let name = entry.file_name();
        let Some(id) = name.to_str().and_then(|name| Uuid::parse_str(name).ok()) else {
            continue;
        };
        let file = entry.path().join("job.json");
        let metadata = match fs::symlink_metadata(&file) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(_) => return Err("저장된 영상 작업을 확인하지 못했습니다.".into()),
        };
        if !metadata.file_type().is_file() || metadata.len() > MAX_JOB_BYTES {
            return Err("저장된 영상 작업 파일의 형식·크기를 확인하세요.".into());
        }
        let bytes = fs::read(&file).map_err(|_| "저장된 영상 작업을 읽지 못했습니다.")?;
        let job: Value = serde_json::from_slice(&bytes)
            .map_err(|_| "저장된 영상 작업 기록이 손상되었습니다.")?;
        if job["reasonRequest"]["key"] != key {
            continue;
        }
        matches_request(&job["reasonRequest"], key, request)?;
        if job["id"].as_str().and_then(|id| Uuid::parse_str(id).ok()) != Some(id) {
            return Err("영상 요청과 저장된 작업의 식별자가 다릅니다.".into());
        }
        if found.is_some() {
            return Err(
                "같은 영상 요청에 여러 작업이 연결되어 있습니다. Studio에서 확인하세요.".into(),
            );
        }
        found = Some(job);
    }
    Ok(found)
}

fn safe_title(job: &Value) -> String {
    let title = job["storyboard"]["title"]
        .as_str()
        .or_else(|| job["draft"]["title"].as_str())
        .or_else(|| job["settings"]["topic"].as_str())
        .unwrap_or("영상 제작")
        .trim();
    let lower = title.to_ascii_lowercase();
    let sensitive = [
        "bearer ",
        "sk-",
        "api_key",
        "access_token",
        "refresh_token",
        "client_secret",
        "password=",
        "token=",
        "secret=",
        "-----begin",
    ];
    if title.is_empty()
        || title.chars().any(char::is_control)
        || title.contains('/')
        || title.contains('\\')
        || title.contains("://")
        || sensitive.iter().any(|part| lower.contains(part))
    {
        return "영상 제작".into();
    }
    title.chars().take(120).collect()
}

/// Minimal shareable result from RAW job.json, not the window's normalized view.
/// hasVideo reports persisted completion evidence, not a fresh filesystem/media audit.
/// requiresApproval is true for storyboard review or a completed job's publication.
pub fn video_result(job: &Value) -> Result<Value, String> {
    let id = job["id"]
        .as_str()
        .and_then(|id| Uuid::parse_str(id).ok())
        .ok_or("영상 작업 ID를 확인하세요.")?
        .to_string();
    let status = job["status"].as_str().ok_or("영상 작업 상태가 없습니다.")?;
    if ![
        "planning",
        "awaiting_approval",
        "running",
        "paused",
        "failed",
        "cancelled",
        "done",
    ]
    .contains(&status)
    {
        return Err("알 수 없는 영상 작업 상태입니다.".into());
    }
    let stage = job["stage"].as_str().ok_or("영상 작업 단계가 없습니다.")?;
    if ![
        "plan",
        "storyboard",
        "scenes",
        "voice",
        "subtitles",
        "edit",
        "qa",
        "done",
    ]
    .contains(&stage)
    {
        return Err("알 수 없는 영상 작업 단계입니다.".into());
    }
    let has_video = status == "done"
        && stage == "done"
        && job["outputs"]["final"]
            .as_str()
            .is_some_and(|path| !path.trim().is_empty())
        && job["outputs"]["durationSec"]
            .as_f64()
            .is_some_and(|seconds| seconds.is_finite() && seconds > 0.0)
        && job["qa"]["passed"] == true;
    let requires_approval = status == "awaiting_approval" || status == "done";
    let summary = match status {
        "planning" => "영상 기획을 준비하고 있습니다.",
        "awaiting_approval" => "스토리보드 검토를 기다리고 있습니다. Studio에서 확인한 뒤 제작을 시작하세요.",
        "running" => "영상 제작을 진행하고 있습니다.",
        "paused" => "영상 제작이 일시 정지되어 있습니다. Studio에서 작업 상태를 확인하세요.",
        "failed" => "영상 제작에 실패했습니다. Studio에서 실패 단계를 확인하세요.",
        "cancelled" => "영상 제작이 취소되었습니다.",
        "done" if has_video => "영상 제작과 품질 검사가 완료된 기록이 있습니다. 실제 게시는 Studio에서 별도로 승인해야 합니다.",
        "done" => "완료 기록의 영상·품질 검사 정보가 충분하지 않습니다. Studio에서 다시 확인하세요.",
        _ => unreachable!("status checked above"),
    };
    Ok(json!({
        "jobId": id,
        "status": status,
        "stage": stage,
        "title": safe_title(job),
        "hasVideo": has_video,
        "requiresApproval": requires_approval,
        "summary": summary
    }))
}
