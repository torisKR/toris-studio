//! Typed Reason Network SNS planning handoff (`toris-studio.sns.v1`).
//! Messages are untrusted data, never commands.
//!
//! Peers send one JSON object as the message body. Hosted assistants (Muse,
//! OpenAI Dots, Grok Bot) reach Studio only through Reason MCP `send_message`,
//! so their messages are accepted only when the first line carries a handoff
//! code Studio issued (the project-chat pattern). A code binds to the first
//! sender that uses it.
//!
//! This module does not post, schedule an executable job, send a message or
//! touch credentials. It validates requests, builds editable draft inputs for
//! the existing SNS content and publication modules, and keeps import markers
//! so a repeated delivery or a second click cannot create duplicate drafts.
use crate::project_chat::{self, HostedAssistant};
use chrono::{DateTime, Duration as ChronoDuration, FixedOffset, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use uuid::Uuid;

pub const SNS_REQUEST_SCHEMA: &str = "toris-studio.sns.v1";
pub const SNS_RESULT_SCHEMA: &str = "toris-studio.sns-result.v1";
pub const MAX_REQUEST_BYTES: usize = 32 * 1024;
pub const MAX_POSTS: usize = 8;
pub const MAX_HASHTAGS: usize = 30;
pub const MAX_HASHTAG_CHARS: usize = 50;
pub const MAX_TITLE_CHARS: usize = 120;
pub const MAX_POST_TITLE_CHARS: usize = 100;
pub const MAX_BRIEF_CHARS: usize = 4000;
pub const MAX_HANDOFFS: usize = 50;
pub const MAX_IMPORTS: usize = 500;
const HANDOFF_DAYS: i64 = 30;
const MAX_SCHEDULE_DAYS: i64 = 365;
const MAX_STORE_BYTES: u64 = 2 * 1024 * 1024;

/// Platforms Studio already supports, with the post-text limit (text plus
/// `#tag` suffixes, in characters) used for the received plan.
pub const PLATFORMS: [(&str, &str, usize); 8] = [
    ("youtube", "YouTube", 5000),
    ("instagram", "Instagram", 2200),
    ("facebook", "Facebook", 5000),
    ("threads", "Threads", 500),
    ("tiktok", "TikTok", 2200),
    ("naver_blog", "네이버 블로그", 20000),
    ("naver_clip", "네이버 클립", 1000),
    ("x", "X", 280),
];
/// Posting to these stays a manual handoff in the publication module.
pub const MANUAL_PLATFORMS: [&str; 3] = ["naver_blog", "naver_clip", "x"];
/// Platforms whose publication drafts can carry plain text without a video.
const TEXT_PLATFORMS: [&str; 3] = ["facebook", "threads", "x"];

fn platform(name: &str) -> Option<(&'static str, &'static str, usize)> {
    PLATFORMS.iter().copied().find(|(id, _, _)| *id == name)
}
pub fn platform_label(name: &str) -> &'static str {
    platform(name).map_or("SNS", |(_, label, _)| label)
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SnsRequest {
    pub schema: String,
    pub request_id: String,
    pub title: String,
    pub posts: Vec<SnsPost>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub media: Option<MediaRef>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub schedule_at: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SnsPost {
    pub platform: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    pub text: String,
    #[serde(default)]
    pub hashtags: Vec<String>,
}

/// A reference to something already in Studio, never a path or URL.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MediaRef {
    pub kind: MediaKind,
    pub id: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MediaKind {
    /// A Studio video production job; its finished MP4 is copied into publication media.
    VideoJob,
    /// An item already in the publication media store (video or image).
    Media,
}

fn validate_request_id(id: &str) -> Result<(), String> {
    if id.is_empty()
        || id.len() > 80
        || !id
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
    {
        return Err("SNS 요청 ID는 영문·숫자·밑줄·하이픈 1~80자여야 합니다.".into());
    }
    Ok(())
}

/// Line breaks become `\n`, invisible characters are removed; any other control
/// character is rejected so nothing hidden reaches a draft.
fn clean_text(raw: &str, label: &str, max: usize, multiline: bool) -> Result<String, String> {
    let text = crate::reason_pipeline::plain_text(raw);
    let text = text.trim();
    if text.is_empty() || text.chars().count() > max {
        return Err(format!("{label}은(는) 1~{max}자로 작성하세요."));
    }
    if text
        .chars()
        .any(|c| c.is_control() && !(multiline && (c == '\n' || c == '\t')))
    {
        return Err(format!("{label}에 허용되지 않는 제어 문자가 있습니다."));
    }
    Ok(text.to_owned())
}

/// Hashtags are stored without `#`, the publication module's format.
pub fn clean_hashtag(raw: &str) -> Result<String, String> {
    let tag = crate::reason_pipeline::plain_text(raw);
    let tag = tag.trim().trim_start_matches('#');
    if tag.is_empty()
        || tag.chars().count() > MAX_HASHTAG_CHARS
        || !tag.chars().all(|c| c.is_alphanumeric() || c == '_')
    {
        return Err(format!(
            "해시태그는 # 없이 글자·숫자·밑줄 1~{MAX_HASHTAG_CHARS}자로 작성하세요."
        ));
    }
    Ok(tag.to_owned())
}

fn clean_hashtags(raw: &[String]) -> Result<Vec<String>, String> {
    if raw.len() > MAX_HASHTAGS {
        return Err(format!(
            "해시태그는 플랫폼마다 {MAX_HASHTAGS}개까지 넣을 수 있습니다."
        ));
    }
    let mut seen = std::collections::HashSet::new();
    let mut tags = Vec::with_capacity(raw.len());
    for tag in raw {
        let tag = clean_hashtag(tag)?;
        if !seen.insert(tag.to_lowercase()) {
            return Err(format!("해시태그 #{tag}이(가) 중복되었습니다."));
        }
        tags.push(tag);
    }
    Ok(tags)
}

/// Text plus the `#tag` suffix Studio appends must fit the platform limit.
fn post_length(text: &str, hashtags: &[String]) -> usize {
    text.chars().count()
        + hashtags
            .iter()
            .map(|tag| tag.chars().count() + 2)
            .sum::<usize>()
}

pub fn clean_post(post: &SnsPost) -> Result<SnsPost, String> {
    let (id, label, limit) =
        platform(&post.platform).ok_or("지원하지 않는 SNS 플랫폼입니다. Studio가 지원하는 플랫폼(youtube, instagram, facebook, threads, tiktok, naver_blog, naver_clip, x)만 사용하세요.")?;
    let text = clean_text(&post.text, &format!("{label} 본문"), limit, true)?;
    let hashtags = clean_hashtags(&post.hashtags)?;
    if post_length(&text, &hashtags) > limit {
        return Err(format!(
            "{label} 본문과 해시태그를 합쳐 {limit}자 이하로 줄이세요."
        ));
    }
    let title = post
        .title
        .as_deref()
        .map(|title| clean_text(title, &format!("{label} 제목"), MAX_POST_TITLE_CHARS, false))
        .transpose()?;
    Ok(SnsPost {
        platform: id.to_owned(),
        title,
        text,
        hashtags,
    })
}

fn clean_posts(posts: &[SnsPost]) -> Result<Vec<SnsPost>, String> {
    if posts.is_empty() || posts.len() > MAX_POSTS {
        return Err(format!(
            "posts에는 플랫폼별 게시글 1~{MAX_POSTS}개를 넣으세요."
        ));
    }
    let mut seen = std::collections::HashSet::new();
    posts
        .iter()
        .map(|post| {
            let post = clean_post(post)?;
            if !seen.insert(post.platform.clone()) {
                return Err("같은 플랫폼의 게시글이 두 번 들어 있습니다.".to_string());
            }
            Ok(post)
        })
        .collect()
}

/// RFC 3339 with an explicit offset. The future/range check happens at import time.
pub fn parse_schedule(raw: &str) -> Result<DateTime<FixedOffset>, String> {
    if raw.len() > 40 {
        return Err("예약 희망 시간은 시간대가 포함된 RFC 3339 날짜여야 합니다.".into());
    }
    DateTime::parse_from_rfc3339(raw)
        .map_err(|_| "예약 희망 시간은 시간대가 포함된 RFC 3339 날짜여야 합니다.".into())
}

/// Validates and normalizes every field. Errors are readable Korean messages.
pub fn normalize(request: &SnsRequest) -> Result<SnsRequest, String> {
    if request.schema != SNS_REQUEST_SCHEMA {
        return Err("지원하지 않는 SNS 요청 버전입니다. toris-studio.sns.v1을 사용하세요.".into());
    }
    validate_request_id(&request.request_id)?;
    let title = clean_text(&request.title, "SNS 기획 제목", MAX_TITLE_CHARS, false)?;
    let posts = clean_posts(&request.posts)?;
    if let Some(media) = &request.media {
        Uuid::parse_str(&media.id)
            .map_err(|_| "media.id는 Studio의 영상 작업 또는 게시 미디어 UUID여야 합니다.")?;
    }
    let schedule_at = request
        .schedule_at
        .as_deref()
        .map(str::trim)
        .filter(|raw| !raw.is_empty())
        .map(|raw| parse_schedule(raw).map(|_| raw.to_owned()))
        .transpose()?;
    Ok(SnsRequest {
        schema: SNS_REQUEST_SCHEMA.into(),
        request_id: request.request_id.clone(),
        title,
        posts,
        media: request.media.clone().map(|media| MediaRef {
            kind: media.kind,
            id: media.id.to_ascii_lowercase(),
        }),
        schedule_at,
    })
}

/// Ordinary chat and unrelated JSON are not SNS requests. A recognized request
/// is one complete JSON object with no fences, extra text or unknown fields.
pub fn parse_sns_request(text: &str) -> Result<Option<SnsRequest>, String> {
    let body = text.trim();
    if !body.starts_with('{') {
        if body.contains(SNS_REQUEST_SCHEMA) && (body.starts_with('[') || body.starts_with("```")) {
            return Err("SNS 요청은 코드 블록이나 배열 없이 JSON 객체 하나로 보내세요.".into());
        }
        return Ok(None);
    }
    if body.len() > MAX_REQUEST_BYTES {
        return Err("SNS 요청 JSON은 32 KiB 이하여야 합니다.".into());
    }
    let value: Value = serde_json::from_str(body)
        .map_err(|_| "SNS 요청 JSON을 읽지 못했습니다. 완전한 JSON 객체 하나를 보내세요.")?;
    let schema = value.get("schema").and_then(Value::as_str).unwrap_or("");
    if schema != SNS_REQUEST_SCHEMA {
        if schema.starts_with("toris-studio.sns.") {
            return Err(
                "지원하지 않는 SNS 요청 버전입니다. toris-studio.sns.v1을 사용하세요.".into(),
            );
        }
        return Ok(None);
    }
    // Deserialize the ORIGINAL text, not Value: this also rejects duplicate keys.
    let request: SnsRequest = serde_json::from_str(body).map_err(|_| {
        "SNS 요청의 필드와 자료형을 확인하세요. schema, requestId, title, posts와 선택 사항인 media, scheduleAt만 허용됩니다."
    })?;
    normalize(&request).map(Some)
}

// ---------------------------------------------------------------------------
// Hosted-assistant handoff codes

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Handoff {
    pub code: String,
    pub assistant: HostedAssistant,
    pub created_at: String,
    /// The first sender that used this code; later senders are refused.
    #[serde(default)]
    pub from: Option<String>,
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct HandoffFile {
    version: u32,
    handoffs: Vec<Handoff>,
}

fn valid_code(code: &str) -> bool {
    code.len() == 13
        && code.starts_with("TS-")
        && code[3..]
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'A'..=b'F').contains(&c))
}

pub fn handoff_path(root: &Path) -> PathBuf {
    root.join("sns-handoffs.json")
}

fn read_store<T: serde::de::DeserializeOwned + Default>(path: &Path) -> Result<T, String> {
    match std::fs::symlink_metadata(path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(T::default()),
        Err(_) => return Err("SNS 요청 기록을 확인하지 못했습니다.".into()),
        Ok(meta) if !meta.is_file() => {
            return Err("SNS 요청 기록 파일 형식이 잘못되었습니다.".into())
        }
        Ok(_) => {}
    }
    crate::reason_network::read_file(path, MAX_STORE_BYTES)
        .map_err(|_| "SNS 요청 기록이 손상되었거나 너무 큽니다.".into())
}

fn write_store<T: Serialize>(root: &Path, path: &Path, value: &T) -> Result<(), String> {
    std::fs::create_dir_all(root).map_err(|_| "SNS 요청 기록 폴더를 만들지 못했습니다.")?;
    crate::reason_network::atomic_json(root, path, value)
        .map_err(|_| "SNS 요청 기록을 저장하지 못했습니다.".into())
}

pub fn load_handoffs(root: &Path) -> Result<Vec<Handoff>, String> {
    let file: HandoffFile = read_store(&handoff_path(root))?;
    if file.version > 1 || file.handoffs.len() > MAX_HANDOFFS * 2 {
        return Err("SNS 전달문 기록의 버전 또는 크기를 확인하지 못했습니다.".into());
    }
    Ok(file
        .handoffs
        .into_iter()
        .filter(|h| valid_code(&h.code))
        .collect())
}

fn save_handoffs(root: &Path, handoffs: &[Handoff]) -> Result<(), String> {
    write_store(
        root,
        &handoff_path(root),
        &HandoffFile {
            version: 1,
            handoffs: handoffs.to_vec(),
        },
    )
}

fn expired(handoff: &Handoff, now: DateTime<Utc>) -> bool {
    DateTime::parse_from_rfc3339(&handoff.created_at).map_or(true, |t| {
        now - t.with_timezone(&Utc) > ChronoDuration::days(HANDOFF_DAYS)
    })
}

/// Issues a fresh code, keeping the newest `MAX_HANDOFFS` unexpired codes.
pub fn issue_handoff(
    root: &Path,
    assistant: HostedAssistant,
    now: DateTime<Utc>,
) -> Result<Handoff, String> {
    let mut handoffs = load_handoffs(root)?;
    handoffs.retain(|h| !expired(h, now));
    let handoff = Handoff {
        code: project_chat::handoff_code(),
        assistant,
        created_at: now.to_rfc3339(),
        from: None,
    };
    handoffs.push(handoff.clone());
    let excess = handoffs.len().saturating_sub(MAX_HANDOFFS);
    handoffs.drain(..excess);
    save_handoffs(root, &handoffs)?;
    Ok(handoff)
}

/// The handoff prompt the user pastes into Muse, OpenAI Dots or Grok Bot.
pub fn handoff_prompt(
    assistant: HostedAssistant,
    brief: &str,
    platforms: &[String],
    studio: &str,
    code: &str,
) -> String {
    let targets = platforms
        .iter()
        .map(|p| format!("{p}({})", platform_label(p)))
        .collect::<Vec<_>>()
        .join(", ");
    let example = json!({
        "schema": SNS_REQUEST_SCHEMA,
        "requestId": "sns-새-ID-001",
        "title": "게시 기획 제목",
        "posts": platforms.iter().map(|p| json!({
            "platform": p, "text": format!("{} 게시글 본문", platform_label(p)), "hashtags": ["해시태그"]
        })).collect::<Vec<_>>(),
        "scheduleAt": "2026-01-01T19:00:00+09:00"
    });
    format!(
        "[Toris Studio SNS 기획 요청 · {code}]\n\
{name}, 아래 내용으로 SNS 게시글을 플랫폼별로 기획해 주세요. 실제 게시는 Toris Studio에서 사용자가 검토·승인한 뒤에만 합니다.\n\n\
요청:\n{brief}\n\n\
대상 플랫폼: {targets}\n\n\
기획을 마치면 Reason Network의 send_message 도구로 `{studio}`에게 보내 주세요.\n\
- 메시지 첫 줄은 정확히 `[{code}]` 만 적어야 Studio가 받습니다.\n\
- 둘째 줄부터는 설명이나 코드 블록 없이 아래 형식의 JSON 객체 하나만 보내 주세요.\n\
- requestId는 영문·숫자·밑줄·하이픈 1~80자이며, 기획을 고쳐 다시 보낼 때마다 새 값을 씁니다.\n\
- 본문과 해시태그(# 없이)를 합친 길이: X 280자, Threads 500자, Instagram·TikTok 2,200자, 네이버 클립 1,000자, YouTube·Facebook 5,000자, 네이버 블로그 20,000자 이하. 해시태그는 플랫폼마다 30개까지.\n\
- 예약 희망 시간(scheduleAt)은 선택이며 시간대가 있는 날짜로 씁니다. 게시 명령, 파일 경로, URL로 된 미디어는 넣지 마세요.\n\n\
{example}\n\n\
Studio가 가져오기 결과를 답장하면 check_inbox로 확인할 수 있습니다.",
        name = assistant.label(),
        example = serde_json::to_string_pretty(&example).unwrap_or_default(),
    )
}

/// How one received message relates to SNS planning.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Classified {
    pub request: Option<SnsRequest>,
    /// Hosted assistant whose code the message carried.
    pub via: Option<HostedAssistant>,
    pub code: Option<String>,
    pub error: Option<String>,
}

/// `known_peer`: the sender matched a roster entry when the message arrived.
/// Code-tagged messages are accepted from the code's bound sender (or the first
/// sender, which then binds it). Raw JSON is accepted only from a known peer.
pub fn classify(
    text: &str,
    from: &str,
    known_peer: bool,
    handoffs: &[Handoff],
    now: DateTime<Utc>,
) -> Classified {
    for handoff in handoffs {
        let Some(rest) = project_chat::strip_code(text, &handoff.code) else {
            continue;
        };
        let mut out = Classified {
            via: Some(handoff.assistant),
            code: Some(handoff.code.clone()),
            ..Classified::default()
        };
        if expired(handoff, now) {
            out.error = Some(
                "만료된 SNS 전달문 코드입니다. Studio에서 새 전달문을 만들어 다시 요청하세요."
                    .into(),
            );
        } else if handoff.from.as_deref().is_some_and(|bound| bound != from) {
            out.error = Some("이 SNS 전달문 코드는 다른 발신자가 이미 사용했습니다. 새 전달문을 만들어 요청하세요.".into());
        } else {
            match parse_sns_request(&rest) {
                Ok(Some(request)) => out.request = Some(request),
                Ok(None) => out.error = Some("전달문 코드가 있지만 SNS 기획 JSON(toris-studio.sns.v1)이 아닙니다. 코드 다음 줄에 JSON 객체 하나만 보내 달라고 요청하세요.".into()),
                Err(error) => out.error = Some(error),
            }
        }
        return out;
    }
    match parse_sns_request(text) {
        Ok(Some(_)) if !known_peer => Classified {
            error: Some("연결된 에이전트 목록에 없는 발신자의 SNS 기획입니다. Muse·OpenAI Dots·Grok Bot은 Studio의 SNS 전달문 코드를 첫 줄에 넣어 보내야 합니다.".into()),
            ..Classified::default()
        },
        Ok(request) => Classified {
            request,
            ..Classified::default()
        },
        Err(error) => Classified {
            error: Some(error),
            ..Classified::default()
        },
    }
}

/// Binds unbound codes to the first sender that used them, in message order.
/// Returns true when the list changed and must be saved.
pub fn bind_handoffs(handoffs: &mut [Handoff], uses: &[(String, String)]) -> bool {
    let mut changed = false;
    for (code, from) in uses {
        if let Some(handoff) = handoffs
            .iter_mut()
            .find(|h| &h.code == code && h.from.is_none())
        {
            handoff.from = Some(from.clone());
            changed = true;
        }
    }
    changed
}

pub fn store_bindings(root: &Path, uses: &[(String, String)]) -> Result<(), String> {
    if uses.is_empty() {
        return Ok(());
    }
    let mut handoffs = load_handoffs(root)?;
    if bind_handoffs(&mut handoffs, uses) {
        save_handoffs(root, &handoffs)?;
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Import identity and markers

/// Stable origin-bound identity. Length prefixes prevent ambiguous concatenation.
pub fn request_key(network_session: &str, from: &str, request_id: &str) -> String {
    let mut digest = Sha256::new();
    digest.update(b"TorisStudioReasonSnsRequest:v1\0");
    for part in [network_session, from, request_id] {
        digest.update((part.len() as u64).to_be_bytes());
        digest.update(part.as_bytes());
    }
    format!("{:x}", digest.finalize())
}

/// Hash of the normalized received request (not the user's edits).
pub fn content_hash(request: &SnsRequest) -> Result<String, String> {
    let normalized = normalize(request)?;
    let bytes = serde_json::to_vec(&normalized).map_err(|_| "SNS 요청을 확인하지 못했습니다.")?;
    Ok(format!("{:x}", Sha256::digest(bytes)))
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ImportMarker {
    pub key: String,
    pub request_id: String,
    pub from: String,
    pub message_id: String,
    pub content_hash: String,
    /// `pending` is written before the database transaction, `imported` after commit.
    pub state: String,
    pub platforms: Vec<String>,
    pub content_ids: Vec<String>,
    pub publication_ids: Vec<String>,
    #[serde(default)]
    pub media_attached: bool,
    pub updated_at: String,
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct ImportFile {
    version: u32,
    imports: Vec<ImportMarker>,
}

pub fn import_path(root: &Path) -> PathBuf {
    root.join("sns-imports.json")
}

pub fn load_imports(root: &Path) -> Result<Vec<ImportMarker>, String> {
    let file: ImportFile = read_store(&import_path(root))?;
    if file.version > 1 || file.imports.len() > MAX_IMPORTS * 2 {
        return Err("SNS 가져오기 기록의 버전 또는 크기를 확인하지 못했습니다.".into());
    }
    Ok(file.imports)
}

fn save_imports(root: &Path, imports: &[ImportMarker]) -> Result<(), String> {
    write_store(
        root,
        &import_path(root),
        &ImportFile {
            version: 1,
            imports: imports.to_vec(),
        },
    )
}

/// The marker for `key`. A changed request under the same ID is an error.
pub fn find_import(
    imports: &[ImportMarker],
    key: &str,
    request: &SnsRequest,
) -> Result<Option<ImportMarker>, String> {
    let Some(marker) = imports.iter().find(|m| m.key == key) else {
        return Ok(None);
    };
    if marker.content_hash != content_hash(request)? || marker.request_id != request.request_id {
        return Err(
            "같은 SNS 요청 ID의 내용이 변경되었습니다. 새 requestId로 보내 달라고 요청하세요."
                .into(),
        );
    }
    Ok(Some(marker.clone()))
}

/// Inserts or replaces the marker for its key; keeps the newest `MAX_IMPORTS`.
pub fn put_import(root: &Path, marker: ImportMarker) -> Result<(), String> {
    let mut imports = load_imports(root)?;
    imports.retain(|m| m.key != marker.key);
    imports.push(marker);
    let excess = imports.len().saturating_sub(MAX_IMPORTS);
    imports.drain(..excess);
    save_imports(root, &imports)
}

pub fn remove_import(root: &Path, key: &str) -> Result<(), String> {
    let mut imports = load_imports(root)?;
    let before = imports.len();
    imports.retain(|m| m.key != key);
    if imports.len() != before {
        save_imports(root, &imports)?;
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Review edits -> draft inputs

/// What the user confirmed on the review screen. Platforms must come from the request.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ImportEdits {
    pub message_id: String,
    pub title: String,
    pub posts: Vec<SnsPost>,
    #[serde(default)]
    pub schedule_at: Option<String>,
    #[serde(default)]
    pub attach_media: bool,
}

/// Media resolved natively from the request's reference.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct ResolvedMedia {
    pub video: Option<String>,
    pub image: Option<String>,
}

/// Inputs for `social::insert_content` and `publications::insert_draft`.
#[derive(Clone, Debug, PartialEq)]
pub struct DraftPlan {
    pub title: String,
    pub platforms: Vec<String>,
    pub contents: Vec<Value>,
    pub publications: Vec<(Uuid, Value)>,
}

/// Reviewed title, posts and optional schedule.
pub type ValidEdits = (String, Vec<SnsPost>, Option<DateTime<Utc>>);

pub fn validate_edits(
    request: &SnsRequest,
    edits: &ImportEdits,
    now: DateTime<Utc>,
) -> Result<ValidEdits, String> {
    let title = clean_text(&edits.title, "SNS 기획 제목", MAX_TITLE_CHARS, false)?;
    let posts = clean_posts(&edits.posts)?;
    for post in &posts {
        if !request.posts.iter().any(|p| p.platform == post.platform) {
            return Err(
                "받은 기획에 없는 플랫폼은 추가할 수 없습니다. 새 기획을 요청하세요.".into(),
            );
        }
    }
    let schedule = edits
        .schedule_at
        .as_deref()
        .map(str::trim)
        .filter(|raw| !raw.is_empty())
        .map(|raw| -> Result<DateTime<Utc>, String> {
            let at = parse_schedule(raw)?.with_timezone(&Utc);
            if at <= now {
                return Err("예약 희망 시간이 이미 지났습니다. 시간을 바꾸거나 비우세요.".into());
            }
            if at - now > ChronoDuration::days(MAX_SCHEDULE_DAYS) {
                return Err("예약 희망 시간은 1년 이내로 정하세요.".into());
            }
            Ok(at)
        })
        .transpose()?;
    Ok((title, posts, schedule))
}

fn body_with_tags(post: &SnsPost) -> String {
    if post.hashtags.is_empty() {
        return post.text.clone();
    }
    let tags = post
        .hashtags
        .iter()
        .map(|t| format!("#{t}"))
        .collect::<Vec<_>>()
        .join(" ");
    format!("{}\n\n{tags}", post.text)
}

fn target(post: &SnsPost, schedule: Option<DateTime<Utc>>) -> Value {
    let manual = MANUAL_PLATFORMS.contains(&post.platform.as_str());
    let (mode, at) = match (manual, schedule) {
        (true, _) => ("manual_handoff", Value::Null),
        (false, Some(at)) => ("scheduled", json!(at.to_rfc3339())),
        (false, None) => ("manual", Value::Null),
    };
    let mut overrides = json!({"description": post.text, "hashtags": post.hashtags});
    if let Some(title) = &post.title {
        overrides["title"] = json!(title);
    }
    json!({
        "id": Uuid::new_v4().to_string(),
        "platform": post.platform,
        "connectionId": "",
        "accountId": "",
        "accountTitle": "",
        "mode": mode,
        "scheduledAt": at,
        "overrides": overrides,
        "options": {}
    })
}

/// Builds editable drafts. Nothing here is executable: publication targets have
/// no account yet, and posting still needs the publication screen's approval.
/// Naver Blog becomes an article draft; the rest share one video or text draft.
pub fn plan_drafts(
    title: &str,
    posts: &[SnsPost],
    schedule: Option<DateTime<Utc>>,
    media: &ResolvedMedia,
) -> DraftPlan {
    let contents = posts
        .iter()
        .map(|post| {
            json!({
                "platform": post.platform,
                "channelId": null,
                "title": post.title.clone().unwrap_or_else(|| title.to_owned()),
                "body": body_with_tags(post),
                "status": "draft",
                "scheduledAt": schedule.map(|at| at.to_rfc3339()),
                "url": null
            })
        })
        .collect();
    let mut publications = Vec::new();
    let (blog, rest): (Vec<&SnsPost>, Vec<&SnsPost>) =
        posts.iter().partition(|p| p.platform == "naver_blog");
    if !rest.is_empty() {
        let video = media.video.is_some()
            || rest
                .iter()
                .any(|p| !TEXT_PLATFORMS.contains(&p.platform.as_str()));
        publications.push((
            Uuid::new_v4(),
            json!({
                "contentKind": if video { "video" } else { "text" },
                "title": title,
                "description": "",
                "tags": [],
                "hashtags": [],
                "videoMediaId": if video { json!(media.video) } else { Value::Null },
                "thumbnailMediaId": if video { json!(media.image) } else { Value::Null },
                "imageMediaIds": [],
                "targets": rest.iter().map(|p| target(p, schedule)).collect::<Vec<_>>()
            }),
        ));
    }
    if !blog.is_empty() {
        publications.push((
            Uuid::new_v4(),
            json!({
                "contentKind": "article",
                "title": title,
                "description": "",
                "tags": [],
                "hashtags": [],
                "videoMediaId": null,
                "thumbnailMediaId": null,
                "imageMediaIds": media.image.iter().collect::<Vec<_>>(),
                "targets": blog.iter().map(|p| target(p, schedule)).collect::<Vec<_>>()
            }),
        ));
    }
    DraftPlan {
        title: title.to_owned(),
        platforms: posts.iter().map(|p| p.platform.clone()).collect(),
        contents,
        publications,
    }
}

/// Minimal reply for the sender: platforms and counts, no local IDs or paths.
pub fn import_result(request_id: &str, marker: Option<&ImportMarker>) -> Value {
    let result = match marker.filter(|m| m.state == "imported") {
        Some(m) => json!({
            "status": "imported",
            "platforms": m.platforms,
            "contentDrafts": m.content_ids.len(),
            "publicationDrafts": m.publication_ids.len(),
            "mediaAttached": m.media_attached,
            "published": false,
            "summary": "Studio에 SNS 콘텐츠 초안과 발행 계획 초안으로 저장했습니다. 실제 게시는 Studio 발행 화면에서 사용자가 계정을 고르고 승인해야 하며, X·네이버는 수동 게시입니다."
        }),
        None => json!({
            "status": "not_imported",
            "platforms": [],
            "contentDrafts": 0,
            "publicationDrafts": 0,
            "mediaAttached": false,
            "published": false,
            "summary": "Studio에서 아직 이 SNS 기획을 가져오지 않았습니다."
        }),
    };
    json!({"schema": SNS_RESULT_SCHEMA, "requestId": request_id, "result": result})
}
