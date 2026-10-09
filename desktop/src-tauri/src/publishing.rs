//! Native YouTube QA upload. Credentials never cross IPC; exact draft + immutable
//! selected bytes are bound to a short-lived, single-use confirmation ticket.
use chrono::Utc;
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    fs,
    io::Read,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, OnceLock},
    time::{Duration, Instant},
};
use uuid::Uuid;
const MAX_VIDEO: usize = 64 * 1024 * 1024;
static UPLOAD_GATE: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Draft {
    platform: String,
    channel_id: String,
    file_id: String,
    title: String,
    #[serde(default)]
    description: String,
    privacy: String,
    #[serde(default)]
    confirm_public: bool,
    made_for_kids: bool,
}
pub fn validate_draft(value: Value) -> Result<Draft, String> {
    let mut d: Draft = serde_json::from_value(value)
        .map_err(|_| "게시 대상·영상·공개 범위·아동용 여부를 확인하세요.")?;
    d.title = d.title.trim().into();
    if d.platform != "youtube" {
        return Err("현재 실제 게시 QA는 YouTube 영상 업로드만 지원합니다.".into());
    }
    if !d.channel_id.starts_with("UC")
        || d.channel_id.len() != 24
        || !d
            .channel_id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    {
        return Err("인증된 YouTube 채널을 선택하세요.".into());
    }
    Uuid::parse_str(&d.file_id).map_err(|_| "선택 창에서 테스트 영상을 먼저 지정하세요.")?;
    if d.title.is_empty()
        || d.title.chars().count() > 100
        || d.title.contains(['<', '>'])
        || d.title.chars().any(char::is_control)
        || d.description.len() > 5000
        || d.description.contains(['<', '>'])
    {
        return Err(
            "제목은 1~100자, 설명은 5,000바이트 이하이며 꺾쇠 문자는 사용할 수 없습니다.".into(),
        );
    }
    if !["private", "unlisted", "public"].contains(&d.privacy.as_str())
        || (d.privacy != "private" && !d.confirm_public)
    {
        return Err("일부 공개·공개 게시는 외부 노출 확인에 동의해야 합니다.".into());
    }
    Ok(d)
}
#[derive(Clone)]
struct Selected {
    id: String,
    name: String,
    sha256: String,
    bytes: Arc<Vec<u8>>,
}
struct Pending {
    draft: Draft,
    file: Selected,
    channel_title: String,
    expires: Instant,
}
#[derive(Default)]
struct Cache {
    selected: Option<Selected>,
    pending: HashMap<String, Pending>,
}
fn cache() -> &'static Mutex<Cache> {
    static CACHE: OnceLock<Mutex<Cache>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(Cache::default()))
}
fn data_dir() -> Result<PathBuf, String> {
    Ok(crate::config::config_path()
        .parent()
        .ok_or("QA 저장 경로 오류")?
        .join("publishing-qa"))
}
fn history_path() -> Result<PathBuf, String> {
    Ok(data_dir()?.join("last-attempt.json"))
}
fn write_attempt(value: &Value) -> Result<(), String> {
    let root = data_dir()?;
    fs::create_dir_all(&root).map_err(|_| "게시 확인 기록을 저장할 수 없습니다.")?;
    let mut temp = tempfile::NamedTempFile::new_in(&root)
        .map_err(|_| "게시 확인 기록을 저장할 수 없습니다.")?;
    serde_json::to_writer(&mut temp, value).map_err(|_| "게시 확인 기록을 저장할 수 없습니다.")?;
    temp.as_file()
        .sync_all()
        .map_err(|_| "게시 확인 기록을 저장할 수 없습니다.")?;
    temp.persist(history_path()?)
        .map_err(|_| "게시 확인 기록을 저장할 수 없습니다.")?;
    Ok(())
}
pub fn last_attempt() -> Result<Value, String> {
    match fs::read(history_path()?) {
        Ok(bytes) if bytes.len() <= 16384 => serde_json::from_slice(&bytes)
            .map_err(|_| "게시 기록이 손상되었습니다. 원본 기록을 확인하세요.".into()),
        Ok(_) => Err("게시 기록 크기가 잘못되었습니다.".into()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Value::Null),
        Err(_) => Err("게시 기록을 읽지 못했습니다.".into()),
    }
}
pub fn select_file(path: &Path) -> Result<Value, String> {
    if fs::symlink_metadata(path)
        .map_err(|_| "영상 파일을 읽지 못했습니다.")?
        .file_type()
        .is_symlink()
        || !path
            .extension()
            .and_then(|s| s.to_str())
            .is_some_and(|s| s.eq_ignore_ascii_case("mp4"))
    {
        return Err("심볼릭 링크가 아닌 MP4 파일을 선택하세요.".into());
    }
    let file = fs::File::open(path).map_err(|_| "영상 파일을 열지 못했습니다.")?;
    let meta = file
        .metadata()
        .map_err(|_| "파일 정보를 읽지 못했습니다.")?;
    if !meta.is_file() || meta.len() > MAX_VIDEO as u64 || meta.len() < 12 {
        return Err("게시 QA에는 64 MiB 이하의 실제 MP4를 사용하세요.".into());
    }
    let mut bytes = Vec::new();
    file.take((MAX_VIDEO + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|_| "영상 읽기가 중단되었습니다.")?;
    if bytes.len() > MAX_VIDEO || bytes.get(4..8) != Some(b"ftyp") {
        return Err("MP4 파일 헤더와 64 MiB 제한을 확인하세요.".into());
    }
    let selected = Selected {
        id: Uuid::new_v4().to_string(),
        name: path
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .into_owned(),
        sha256: format!("{:x}", Sha256::digest(&bytes)),
        bytes: Arc::new(bytes),
    };
    let public = json!({"fileId":selected.id,"fileName":selected.name,"bytes":selected.bytes.len(),"sha256":selected.sha256});
    let mut c = cache().lock().map_err(|_| "영상 선택 상태 오류")?;
    c.pending.clear();
    c.selected = Some(selected);
    Ok(public)
}
fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(240))
        .build()
        .map_err(|_| "YouTube 연결 준비 실패".into())
}
async fn json_response(response: reqwest::Response) -> Result<Value, String> {
    let status = response.status();
    if !status.is_success() {
        return Err(match status.as_u16() {
            401 => "YouTube 로그인을 다시 진행하세요.",
            403 => "YouTube 업로드 권한·API 활성화·할당량을 확인하세요.",
            _ => "YouTube 요청에 실패했습니다. 계정의 Studio에서 업로드 여부를 확인하세요.",
        }
        .into());
    }
    if response.content_length().is_some_and(|n| n > 262144) {
        return Err("YouTube 응답이 너무 큽니다.".into());
    }
    let mut bytes = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(part) = stream.next().await {
        let part = part.map_err(|_| "YouTube 응답 수신 실패")?;
        if bytes.len() + part.len() > 262144 {
            return Err("YouTube 응답이 너무 큽니다.".into());
        }
        bytes.extend_from_slice(&part);
    }
    serde_json::from_slice(&bytes).map_err(|_| "YouTube 응답을 확인하지 못했습니다.".into())
}
async fn channels_with(token: &str) -> Result<Value, String> {
    let response = client()?
        .get("https://www.googleapis.com/youtube/v3/channels")
        .query(&[("part", "snippet"), ("mine", "true"), ("maxResults", "50")])
        .bearer_auth(token)
        .send()
        .await
        .map_err(|_| "YouTube 채널 조회 연결 실패")?;
    let value = json_response(response).await?;
    let items = value["items"]
        .as_array()
        .ok_or("YouTube 채널 목록이 올바르지 않습니다.")?;
    Ok(
        json!({"channels":items.iter().filter_map(|v|Some(json!({"id":v["id"].as_str()?,"title":v["snippet"]["title"].as_str()?}))).collect::<Vec<_>>(),"checkedAt":Utc::now().to_rfc3339()}),
    )
}
pub async fn channels() -> Result<Value, String> {
    channels_with(&crate::oauth::youtube_upload_access().await?).await
}
pub async fn prepare(input: Value) -> Result<Value, String> {
    let draft = validate_draft(input)?;
    let selected = cache()
        .lock()
        .map_err(|_| "영상 선택 상태 오류")?
        .selected
        .clone()
        .filter(|f| f.id == draft.file_id)
        .ok_or("영상 파일을 다시 선택하세요.")?;
    let previous = last_attempt()?;
    if ["sending", "uncertain"]
        .iter()
        .any(|s| previous["status"] == *s)
        && previous["sha256"] == selected.sha256
        && previous["channelId"] == draft.channel_id
    {
        return Err("이 영상의 이전 전송 결과가 불명확합니다. YouTube Studio에서 확인한 뒤 ‘전송 결과 확인 완료’를 눌러주세요. 자동 재전송하지 않습니다.".into());
    }
    let channels = channels().await?;
    let channel_title = channels["channels"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["id"] == draft.channel_id)
        .and_then(|c| c["title"].as_str())
        .ok_or("선택한 채널은 현재 인증된 업로드 계정의 채널이 아닙니다.")?
        .to_string();
    let ticket = Uuid::new_v4().to_string();
    let output = json!({"ticketId":ticket,"channelTitle":channel_title,"channelId":draft.channel_id,"title":draft.title,"description":draft.description,"privacy":draft.privacy,"madeForKids":draft.made_for_kids,"fileName":selected.name,"bytes":selected.bytes.len(),"sha256":selected.sha256,"expiresInSeconds":600});
    let mut c = cache().lock().map_err(|_| "게시 확인 상태 오류")?;
    c.pending.clear();
    c.pending.insert(
        ticket,
        Pending {
            draft,
            file: selected,
            channel_title,
            expires: Instant::now() + Duration::from_secs(600),
        },
    );
    Ok(output)
}
pub fn trusted_upload_url(raw: &str) -> bool {
    url::Url::parse(raw).is_ok_and(|u| {
        u.scheme() == "https"
            && u.host_str() == Some("www.googleapis.com")
            && u.username().is_empty()
            && u.password().is_none()
            && u.port_or_known_default() == Some(443)
            && u.path() == "/upload/youtube/v3/videos"
            && u.fragment().is_none()
    })
}
fn acquire_upload_lock() -> Result<fs::File, String> {
    use fs2::FileExt;
    let directory = data_dir()?;
    fs::create_dir_all(&directory).map_err(|_| "게시 기록 폴더를 만들 수 없습니다.")?;
    let lock = fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(directory.join("upload.lock"))
        .map_err(|_| "게시 잠금을 만들 수 없습니다.")?;
    lock.try_lock_exclusive()
        .map_err(|_| "다른 Studio에서 게시가 진행 중입니다.")?;
    Ok(lock)
}
pub fn acknowledge(attempt_id: &str) -> Result<Value, String> {
    let _gate = UPLOAD_GATE
        .try_lock()
        .map_err(|_| "전송 중에는 결과 확인을 완료할 수 없습니다.")?;
    let _lock = acquire_upload_lock()?;
    let mut record = last_attempt()?;
    if record["attemptId"] != attempt_id
        || !["sending", "uncertain"]
            .iter()
            .any(|s| record["status"] == *s)
    {
        return Err("확인할 미확정 전송 기록이 없습니다.".into());
    }
    record["status"] = json!("acknowledged");
    record["acknowledgedAt"] = json!(Utc::now().to_rfc3339());
    write_attempt(&record)?;
    Ok(record)
}
pub async fn upload(ticket_id: String, confirmed: bool) -> Result<Value, String> {
    if !confirmed {
        return Err("표시된 채널·영상·공개 범위를 확인한 뒤 전송을 승인하세요.".into());
    }
    let _gate = UPLOAD_GATE
        .try_lock()
        .map_err(|_| "다른 영상 전송이 진행 중입니다.")?;
    let _lock = acquire_upload_lock()?;
    let pending = cache()
        .lock()
        .map_err(|_| "게시 확인 상태 오류")?
        .pending
        .remove(&ticket_id)
        .ok_or("전송 확인이 만료되었거나 이미 사용되었습니다. 다시 게시 준비를 진행하세요.")?;
    if pending.expires < Instant::now() {
        return Err("전송 확인이 만료되었습니다.".into());
    }
    let previous = last_attempt()?;
    if ["sending", "uncertain"]
        .iter()
        .any(|s| previous["status"] == *s)
        && previous["sha256"] == pending.file.sha256
        && previous["channelId"] == pending.draft.channel_id
    {
        return Err("이 영상의 이전 전송 결과를 YouTube Studio에서 먼저 확인하세요. 중복 전송하지 않았습니다.".into());
    }
    let token = crate::oauth::youtube_upload_access().await?;
    let current = channels_with(&token).await?;
    if !current["channels"]
        .as_array()
        .unwrap()
        .iter()
        .any(|c| c["id"] == pending.draft.channel_id)
    {
        return Err("로그인 계정이 바뀌었습니다. 게시 대상을 다시 확인하세요.".into());
    }
    let d = &pending.draft;
    let mut record = json!({"attemptId":ticket_id,"status":"sending","channelId":d.channel_id,"channelTitle":pending.channel_title,"title":d.title,"requestedPrivacy":d.privacy,"sha256":pending.file.sha256,"fileName":pending.file.name,"startedAt":Utc::now().to_rfc3339(),"videoId":null,"actualPrivacy":null});
    write_attempt(&record)?;
    let operation=async {
        let http=client()?;
        let init=http.post("https://www.googleapis.com/upload/youtube/v3/videos").query(&[("uploadType","resumable"),("part","snippet,status"),("notifySubscribers","false")]).bearer_auth(&token).header("X-Upload-Content-Type","video/mp4").header("X-Upload-Content-Length",pending.file.bytes.len()).json(&json!({"snippet":{"title":d.title,"description":d.description,"categoryId":"28"},"status":{"privacyStatus":d.privacy,"selfDeclaredMadeForKids":d.made_for_kids}})).send().await.map_err(|_|"YouTube 업로드 준비 연결 실패")?;
        if !init.status().is_success(){json_response(init).await?;return Err("YouTube 전송 준비가 실패했습니다.".to_string());}
        let session=init.headers().get(reqwest::header::LOCATION).and_then(|h|h.to_str().ok()).filter(|s|trusted_upload_url(s)).ok_or("YouTube 전송 주소 검증 실패")?.to_string();
        let response=http.put(session).bearer_auth(&token).header("Content-Type","video/mp4").body((*pending.file.bytes).clone()).send().await.map_err(|_|"전송 결과가 불명확합니다. YouTube Studio에서 확인하세요. 자동 재전송하지 않습니다.")?;
        let result=json_response(response).await?;
        validate_receipt(&result, &d.channel_id)
    }.await;
    match operation {
        Ok((id, privacy)) => {
            record["status"] = json!("uploaded");
            record["videoId"] = json!(id);
            record["actualPrivacy"] = json!(privacy);
            record["publicPostConfirmed"] = json!(privacy == "public");
            record["url"] = json!(format!("https://www.youtube.com/watch?v={id}"));
            record["completedAt"] = json!(Utc::now().to_rfc3339());
            write_attempt(&record)?;
            Ok(record)
        }
        Err(error) => {
            record["status"] = json!("uncertain");
            record["error"] = json!(error);
            write_attempt(&record)?;
            Err(error)
        }
    }
}
pub fn validate_receipt(result: &Value, channel_id: &str) -> Result<(String, String), String> {
    if result["snippet"]["channelId"] != channel_id {
        return Err(
            "YouTube 응답의 게시 채널이 확인한 채널과 다릅니다. Studio에서 확인하세요.".into(),
        );
    }
    let id = result["id"]
        .as_str()
        .filter(|s| {
            s.len() == 11
                && s.bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
        })
        .ok_or("YouTube 영상 ID를 확인하지 못했습니다. Studio에서 확인하세요.")?;
    let privacy = result["status"]["privacyStatus"]
        .as_str()
        .filter(|s| ["private", "unlisted", "public"].contains(s))
        .ok_or("YouTube 실제 공개 범위를 확인하지 못했습니다. Studio에서 확인하세요.")?;
    Ok((id.to_owned(), privacy.to_owned()))
}
pub fn sample_project() -> Value {
    json!({"id":Uuid::new_v4().to_string(),"title":"Toris Studio QA","format":"youtube-landscape","template":"reference-briefing","language":"ko","scenes":[{"id":"qa","headline":"Toris Studio QA","body":"업로드 연결 검증용 영상입니다.\n실제 서비스 콘텐츠가 아닙니다.","narration":"","durationSec":3.0,"mediaType":"none"}]})
}
pub async fn make_sample() -> Result<Value, String> {
    let rendered = crate::media::render_project(sample_project()).await?;
    select_file(Path::new(
        rendered["path"]
            .as_str()
            .ok_or("테스트 영상 경로가 없습니다.")?,
    ))
}
