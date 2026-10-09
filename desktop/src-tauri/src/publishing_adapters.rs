//! Official publishing APIs. Credentials remain native; provider errors and URLs
//! containing upload credentials never cross IPC. Every remote handle is persisted
//! before the next irreversible step, and ambiguous responses never auto-retry.
use futures_util::StreamExt;
use serde_json::{json, Value};
use std::{
    future::Future,
    path::{Path, PathBuf},
    pin::Pin,
    sync::Arc,
    time::Duration,
};
use tokio::io::{AsyncReadExt, AsyncSeekExt};
use url::Url;

const META: &str = "https://graph.facebook.com/v25.0";
const IG: &str = "https://graph.instagram.com/v25.0";
const THREADS: &str = "https://graph.threads.net/v1.0";
const TIKTOK: &str = "https://open.tiktokapis.com/v2";
const PLATFORMS: [&str; 5] = ["youtube", "instagram", "facebook", "threads", "tiktok"];
const MAX_RESPONSE: usize = 1024 * 1024;
// Native OAuth client stores an explicit user audit declaration. It is labelled
// separately from real API validation and is never read from a renderer job flag.

pub type Checkpoint =
    Arc<dyn Fn(Value) -> Pin<Box<dyn Future<Output = Result<(), String>> + Send>> + Send + Sync>;
#[derive(Clone, Debug)]
pub struct AdapterError {
    pub message: String,
    pub retryable: bool,
    pub uncertain: bool,
    pub remote: Option<Value>,
}
impl AdapterError {
    fn before(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            retryable: true,
            uncertain: false,
            remote: None,
        }
    }
    fn invalid(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            retryable: false,
            uncertain: false,
            remote: None,
        }
    }
    fn uncertain(remote: Option<Value>) -> Self {
        Self {
            message:
                "전송 결과가 불명확합니다. 결과 재확인 후 진행하세요. 자동 재전송하지 않습니다."
                    .into(),
            retryable: false,
            uncertain: true,
            remote,
        }
    }
    fn with_remote(mut self, remote: &Value) -> Self {
        self.remote = Some(remote.clone());
        self
    }
}

enum Body {
    Empty,
    Json(Value),
    Form(Vec<(String, String)>),
    File(PathBuf, u64, u64),
    Thumbnail(PathBuf, bool),
}
struct Request {
    method: reqwest::Method,
    url: String,
    token: Option<String>,
    oauth_header: bool,
    body: Body,
    headers: Vec<(String, String)>,
}
struct Reply {
    status: u16,
    headers: reqwest::header::HeaderMap,
    body: Value,
}
type ResponseFuture<'a> = Pin<Box<dyn Future<Output = Result<Reply, AdapterError>> + Send + 'a>>;
trait Transport: Send + Sync {
    fn send(&self, request: Request, irreversible: bool) -> ResponseFuture<'_>;
}
struct Official;
impl Transport for Official {
    fn send(&self, request: Request, irreversible: bool) -> ResponseFuture<'_> {
        Box::pin(async move {
            if !trusted_endpoint(&request.url) {
                return Err(AdapterError::invalid(
                    "게시 API 전송 주소 검증에 실패했습니다.",
                ));
            }
            let http = reqwest::Client::builder()
                .no_proxy()
                .redirect(reqwest::redirect::Policy::none())
                .connect_timeout(Duration::from_secs(15))
                .timeout(Duration::from_secs(600))
                .build()
                .map_err(|_| AdapterError::before("게시 연결을 준비하지 못했습니다."))?;
            let mut builder = http
                .request(request.method, &request.url)
                .header("Accept", "application/json")
                .header("Cache-Control", "no-store");
            if let Some(token) = request.token {
                builder = if request.oauth_header {
                    builder.header("Authorization", format!("OAuth {token}"))
                } else {
                    builder.bearer_auth(token)
                };
            }
            for (key, value) in request.headers {
                builder = builder.header(&key, value);
            }
            builder = match request.body {
                Body::Empty => builder,
                Body::Json(value) => builder.json(&value),
                Body::Form(values) => builder.form(&values),
                Body::File(path, offset, length) => {
                    let mut file = tokio::fs::File::open(path)
                        .await
                        .map_err(|_| AdapterError::before("승인한 영상 파일을 열 수 없습니다."))?;
                    file.seek(std::io::SeekFrom::Start(offset))
                        .await
                        .map_err(|_| {
                            AdapterError::before("영상 파일 읽기를 준비하지 못했습니다.")
                        })?;
                    let stream = futures_util::stream::try_unfold(
                        (file, length),
                        |(mut file, left)| async move {
                            if left == 0 {
                                return Ok::<_, std::io::Error>(None);
                            }
                            let mut bytes = vec![0; left.min(256 * 1024) as usize];
                            let n = file.read(&mut bytes).await?;
                            if n == 0 {
                                return Err(std::io::Error::new(
                                    std::io::ErrorKind::UnexpectedEof,
                                    "approved media truncated",
                                ));
                            }
                            bytes.truncate(n);
                            Ok(Some((bytes, (file, left - n as u64))))
                        },
                    );
                    builder
                        .header("Content-Length", length)
                        .body(reqwest::Body::wrap_stream(stream))
                }
                Body::Thumbnail(path, facebook) => {
                    let meta = tokio::fs::metadata(&path)
                        .await
                        .map_err(|_| AdapterError::before("썸네일 파일을 열 수 없습니다."))?;
                    let maximum = if facebook { 2 } else { 50 } * 1024 * 1024;
                    if meta.len() > maximum {
                        return Err(AdapterError::invalid(if facebook {
                            "Facebook 커버는 2 MiB 이하 PNG 또는 JPEG를 사용하세요."
                        } else {
                            "YouTube 썸네일은 50 MiB 이하 PNG 또는 JPEG를 사용하세요."
                        }));
                    }
                    let bytes = tokio::fs::read(path)
                        .await
                        .map_err(|_| AdapterError::before("썸네일 파일을 읽을 수 없습니다."))?;
                    let mime = thumbnail_mime(&bytes)?;
                    if facebook {
                        let part = reqwest::multipart::Part::bytes(bytes)
                            .file_name(if mime == "image/png" {
                                "cover.png"
                            } else {
                                "cover.jpg"
                            })
                            .mime_str(mime)
                            .map_err(|_| AdapterError::invalid("썸네일 형식을 확인하세요."))?;
                        builder.multipart(
                            reqwest::multipart::Form::new()
                                .part("source", part)
                                .text("is_preferred", "true"),
                        )
                    } else {
                        builder.header("Content-Type", mime).body(bytes)
                    }
                }
            };
            let response = builder.send().await.map_err(|_| {
                if irreversible {
                    AdapterError::uncertain(None)
                } else {
                    AdapterError::before("SNS API에 연결하지 못했습니다.")
                }
            })?;
            let status = response.status().as_u16();
            let headers = response.headers().clone();
            let mut bytes = Vec::new();
            let mut stream = response.bytes_stream();
            while let Some(chunk) = stream.next().await {
                let chunk = chunk.map_err(|_| {
                    if irreversible {
                        AdapterError::uncertain(None)
                    } else {
                        AdapterError::before("SNS 응답을 받지 못했습니다.")
                    }
                })?;
                if bytes.len() + chunk.len() > MAX_RESPONSE {
                    return Err(if irreversible {
                        AdapterError::uncertain(None)
                    } else {
                        AdapterError::invalid("SNS 응답 크기를 확인할 수 없습니다.")
                    });
                }
                bytes.extend_from_slice(&chunk);
            }
            let body = if bytes.is_empty() {
                Value::Null
            } else {
                serde_json::from_slice(&bytes).map_err(|_| {
                    if irreversible {
                        AdapterError::uncertain(None)
                    } else {
                        AdapterError::invalid("SNS 응답 형식을 확인할 수 없습니다.")
                    }
                })?
            };
            if !(200..300).contains(&status) && status != 308 {
                return Err(response_error(status, irreversible));
            }
            if body.get("error").is_some_and(|v| {
                !v.is_null() && v.get("code").and_then(Value::as_str) != Some("ok")
            }) {
                let code = body["error"]["code"].as_str().unwrap_or("");
                if code.starts_with("unaudited_client") {
                    return Err(AdapterError::invalid("needs_audit: TikTok 공개 게시 앱 심사가 승인되지 않았습니다. 비공개 Direct Post 또는 초안 전송을 선택하세요."));
                }
                return Err(if status >= 500 && irreversible {
                    AdapterError::uncertain(None)
                } else {
                    AdapterError::invalid(
                        "SNS가 요청을 거절했습니다. 게시 권한·콘텐츠 조건·일일 한도를 확인하세요.",
                    )
                });
            }
            Ok(Reply {
                status,
                headers,
                body,
            })
        })
    }
}
fn response_error(status: u16, irreversible: bool) -> AdapterError {
    if status >= 500 && irreversible {
        return AdapterError::uncertain(None);
    }
    match status {
        401 => AdapterError::invalid("SNS 인증이 만료되었습니다. 게시 계정을 다시 연결하세요."),
        403 => AdapterError::invalid("게시 권한·앱 심사·할당량·계정 조건을 확인하세요."),
        429 => AdapterError::before("SNS 요청 한도에 도달했습니다. 잠시 후 다시 시도하세요."),
        500..=599 => AdapterError::before("SNS 서버가 응답하지 않습니다. 잠시 후 다시 시도하세요."),
        _ => AdapterError::invalid("SNS 요청이 거절되었습니다. 콘텐츠와 게시 설정을 확인하세요."),
    }
}
fn trusted_endpoint(raw: &str) -> bool {
    Url::parse(raw).is_ok_and(|url| {
        url.scheme() == "https"
            && url.username().is_empty()
            && url.password().is_none()
            && url.fragment().is_none()
            && url.port_or_known_default() == Some(443)
            && matches!(
                url.host_str(),
                Some(
                    "www.googleapis.com"
                        | "graph.instagram.com"
                        | "graph.facebook.com"
                        | "graph.threads.net"
                        | "open.tiktokapis.com"
                        | "open-upload.tiktokapis.com"
                        | "upload.us.tiktokapis.com"
                        | "rupload.facebook.com"
                )
            )
    })
}
pub fn trusted_upload_url(platform: &str, raw: &str) -> bool {
    if !trusted_endpoint(raw) {
        return false;
    }
    let Ok(url) = Url::parse(raw) else {
        return false;
    };
    match platform {
        "youtube" => {
            url.host_str() == Some("www.googleapis.com")
                && url.path() == "/upload/youtube/v3/videos"
        }
        "instagram" | "facebook" => {
            url.host_str() == Some("rupload.facebook.com") && url.path().starts_with('/')
        }
        "tiktok" => {
            ["open-upload.tiktokapis.com", "upload.us.tiktokapis.com"]
                .contains(&url.host_str().unwrap_or(""))
                && ["/video/", "/upload/"].contains(&url.path())
        }
        _ => false,
    }
}
fn thumbnail_mime(bytes: &[u8]) -> Result<&'static str, AdapterError> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Ok("image/png")
    } else if bytes.starts_with(b"\xff\xd8\xff") {
        Ok("image/jpeg")
    } else {
        Err(AdapterError::invalid(
            "썸네일은 PNG 또는 JPEG를 사용하세요.",
        ))
    }
}
fn request(method: reqwest::Method, url: String, token: &str, body: Body) -> Request {
    Request {
        method,
        url,
        token: Some(token.into()),
        oauth_header: false,
        body,
        headers: vec![],
    }
}
async fn get(transport: &dyn Transport, url: String, token: &str) -> Result<Value, AdapterError> {
    Ok(transport
        .send(
            request(reqwest::Method::GET, url, token, Body::Empty),
            false,
        )
        .await?
        .body)
}
async fn post(
    transport: &dyn Transport,
    url: String,
    token: &str,
    body: Body,
) -> Result<Value, AdapterError> {
    Ok(transport
        .send(request(reqwest::Method::POST, url, token, body), true)
        .await?
        .body)
}
fn endpoint(base: &str, path: &str, query: &[(&str, &str)]) -> String {
    let mut url = Url::parse(&format!("{base}/{path}")).expect("fixed API base");
    url.query_pairs_mut().extend_pairs(query.iter().copied());
    url.into()
}
fn remote_id(value: &Value, key: &str) -> Result<String, AdapterError> {
    value
        .get(key)
        .and_then(Value::as_str)
        .filter(|v| {
            !v.is_empty()
                && v.len() <= 128
                && v.bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"_-.~".contains(&b))
        })
        .map(str::to_owned)
        .ok_or_else(|| AdapterError::uncertain(None))
}
fn graph_id(raw: &str) -> bool {
    !raw.is_empty() && raw.len() <= 64 && raw.bytes().all(|b| b.is_ascii_digit())
}
fn capabilities(platform: &str) -> Value {
    json!({"video":true,"title":matches!(platform,"youtube"|"facebook"),"description":true,"tags":platform=="youtube","hashtags":true,"thumbnail":matches!(platform,"youtube"|"instagram"|"facebook"),"thumbnailFrame":matches!(platform,"instagram"|"tiktok"),"draft":platform=="tiktok","direct":true,"directPublicSupported":platform!="tiktok"})
}
// Facebook Page access tokens live only in native memory and never enter account JSON.
struct Account {
    public: Value,
    token: String,
}
fn account(platform: &str, id: &str, name: &str, token: &str) -> Account {
    Account {
        public: json!({"platform":platform,"accountId":id,"name":name,"publishingAuthorized":true,"capabilities":capabilities(platform)}),
        token: token.into(),
    }
}
fn safe_name(value: &Value, key: &str) -> String {
    value[key]
        .as_str()
        .unwrap_or("SNS 계정")
        .chars()
        .take(200)
        .collect()
}
async fn accounts_with(
    transport: &dyn Transport,
    platform: &str,
    access: &crate::oauth::PublishingAccess,
) -> Result<Vec<Account>, AdapterError> {
    let token = &access.token;
    match platform {
        "youtube" => {
            let value = get(
                transport,
                endpoint(
                    "https://www.googleapis.com/youtube/v3",
                    "channels",
                    &[("part", "snippet"), ("mine", "true"), ("maxResults", "50")],
                ),
                token,
            )
            .await?;
            Ok(value["items"]
                .as_array()
                .ok_or_else(|| AdapterError::invalid("YouTube 채널 응답을 확인하세요."))?
                .iter()
                .filter_map(|v| {
                    let id = v["id"].as_str()?;
                    if id.len() != 24
                        || !id.starts_with("UC")
                        || !id
                            .bytes()
                            .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
                    {
                        return None;
                    }
                    Some(account(
                        platform,
                        id,
                        &safe_name(&v["snippet"], "title"),
                        token,
                    ))
                })
                .collect())
        }
        "facebook" => {
            let value = get(
                transport,
                endpoint(
                    META,
                    "me/accounts",
                    &[("fields", "id,name,access_token,tasks"), ("limit", "100")],
                ),
                token,
            )
            .await?;
            Ok(value["data"]
                .as_array()
                .ok_or_else(|| AdapterError::invalid("Facebook Page 목록 응답을 확인하세요."))?
                .iter()
                .filter_map(|v| {
                    let id = v["id"].as_str()?;
                    let page_token = v["access_token"].as_str()?;
                    if !graph_id(id)
                        || page_token.is_empty()
                        || page_token.len() > 16384
                        || page_token.chars().any(char::is_control)
                    {
                        return None;
                    }
                    let tasks = v["tasks"].as_array()?;
                    if !tasks
                        .iter()
                        .any(|task| matches!(task.as_str(), Some("CREATE_CONTENT" | "MANAGE")))
                    {
                        return None;
                    }
                    Some(account(platform, id, &safe_name(v, "name"), page_token))
                })
                .collect())
        }
        "instagram" => {
            let value = get(
                transport,
                endpoint(IG, "me", &[("fields", "user_id,username,account_type")]),
                token,
            )
            .await?;
            if !matches!(
                value["account_type"]
                    .as_str()
                    .unwrap_or("")
                    .to_ascii_uppercase()
                    .as_str(),
                "BUSINESS" | "MEDIA_CREATOR" | "CREATOR"
            ) {
                return Err(AdapterError::invalid(
                    "Instagram Business 또는 Creator 계정만 Reel 게시를 지원합니다.",
                ));
            }
            let id = value["user_id"]
                .as_str()
                .or(value["id"].as_str())
                .filter(|id| graph_id(id))
                .ok_or_else(|| {
                    AdapterError::invalid("Instagram 전문 계정 ID를 확인할 수 없습니다.")
                })?;
            Ok(vec![account(
                platform,
                id,
                &safe_name(&value, "username"),
                token,
            )])
        }
        "threads" => {
            let value = get(
                transport,
                endpoint(THREADS, "me", &[("fields", "id,username")]),
                token,
            )
            .await?;
            let id = value["id"]
                .as_str()
                .filter(|id| graph_id(id))
                .ok_or_else(|| AdapterError::invalid("Threads 계정 ID를 확인할 수 없습니다."))?;
            Ok(vec![account(
                platform,
                id,
                &safe_name(&value, "username"),
                token,
            )])
        }
        "tiktok" => {
            let value = get(
                transport,
                endpoint(TIKTOK, "user/info/", &[("fields", "open_id,display_name")]),
                token,
            )
            .await?;
            let user = &value["data"]["user"];
            let id = remote_id(user, "open_id")?;
            let mut result = account(platform, &id, &safe_name(user, "display_name"), token);
            result.public["capabilities"]["directPublicSupported"] = json!(
                access.tiktok_audit_declared
                    && access.scopes.iter().any(|scope| scope == "video.publish")
            );
            result.public["auditStatus"] = json!(if access.tiktok_audit_declared {
                "user_declared"
            } else {
                "not_declared"
            });
            result.public["apiAuditVerified"] = json!(false);
            result.public["capabilities"]["direct"] =
                json!(access.scopes.iter().any(|scope| scope == "video.publish"));
            result.public["capabilities"]["draft"] =
                json!(access.scopes.iter().any(|scope| scope == "video.upload"));
            if access.scopes.iter().any(|scope| scope == "video.publish") {
                let info = creator_info_with(transport, token).await?;
                result.public["creatorInfo"] = info;
            }
            Ok(vec![result])
        }
        _ => Err(AdapterError::invalid("지원하지 않는 게시 플랫폼입니다.")),
    }
}
async fn creator_info_with(transport: &dyn Transport, token: &str) -> Result<Value, AdapterError> {
    let value = transport
        .send(
            request(
                reqwest::Method::POST,
                format!("{TIKTOK}/post/publish/creator_info/query/"),
                token,
                Body::Json(json!({})),
            ),
            false,
        )
        .await?
        .body;
    let data = &value["data"];
    let privacy = data["privacy_level_options"]
        .as_array()
        .filter(|list| !list.is_empty())
        .ok_or_else(|| AdapterError::invalid("TikTok 공개 범위 정보를 새로 조회하세요."))?;
    Ok(
        json!({"username":safe_name(data,"creator_username"),"nickname":safe_name(data,"creator_nickname"),"privacyLevelOptions":privacy,"commentDisabled":data["comment_disabled"].as_bool().unwrap_or(true),"duetDisabled":data["duet_disabled"].as_bool().unwrap_or(true),"stitchDisabled":data["stitch_disabled"].as_bool().unwrap_or(true),"maxVideoPostDurationSec":data["max_video_post_duration_sec"].as_u64().unwrap_or(0),"checkedAt":chrono::Utc::now().to_rfc3339()}),
    )
}
pub async fn accounts(platform: Option<&str>) -> Result<Value, String> {
    if platform.is_some_and(|p| !PLATFORMS.contains(&p)) {
        return Err("지원하지 않는 게시 플랫폼입니다.".into());
    }
    let mut accounts = Vec::new();
    let mut warnings = Vec::new();
    for platform in PLATFORMS
        .into_iter()
        .filter(|p| platform.map_or(true, |requested| requested == *p))
    {
        let result = async {
            let access = crate::oauth::publishing_access(platform)
                .await
                .map_err(AdapterError::before)?;
            accounts_with(&Official, platform, &access).await
        }
        .await;
        match result {
            Ok(items) => accounts.extend(items.into_iter().map(|item| item.public)),
            Err(error) => warnings.push(json!({"platform":platform,"message":error.message})),
        }
    }
    Ok(json!({"accounts":accounts,"warnings":warnings,"checkedAt":chrono::Utc::now().to_rfc3339()}))
}
fn validate_plan(plan: &Value) -> Result<(&str, &str), AdapterError> {
    let platform = plan["platform"]
        .as_str()
        .filter(|p| PLATFORMS.contains(p))
        .ok_or_else(|| AdapterError::invalid("게시 플랫폼을 선택하세요."))?;
    let id = plan["accountId"]
        .as_str()
        .filter(|id| {
            !id.is_empty()
                && id.len() <= 128
                && id
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"_-.~".contains(&b))
        })
        .ok_or_else(|| AdapterError::invalid("인증된 게시 계정을 선택하세요."))?;
    let title = plan["title"].as_str().unwrap_or("");
    let description = plan["description"].as_str().unwrap_or("");
    if title.chars().any(char::is_control) || title.len() > 1000 || description.len() > 10000 {
        return Err(AdapterError::invalid(
            "제목 또는 설명 길이와 형식을 확인하세요.",
        ));
    }
    for key in ["tags", "hashtags"] {
        if plan.get(key).is_some_and(|v| {
            !v.is_array()
                || v.as_array().is_some_and(|a| {
                    a.len() > 100
                        || a.iter().any(|tag| {
                            tag.as_str().map_or(true, |tag| {
                                tag.len() > 100 || tag.chars().any(char::is_control)
                            })
                        })
                })
        }) {
            return Err(AdapterError::invalid("태그와 해시태그 형식을 확인하세요."));
        }
    }
    let mode = posting_mode(plan);
    if !["direct", "draft"].contains(&mode) || (mode == "draft" && platform != "tiktok") {
        return Err(AdapterError::invalid("이 플랫폼의 게시 방식을 확인하세요."));
    }
    let options = &plan["options"];
    match platform {
        "youtube" => {
            let description = youtube_description(plan);
            if title.trim().is_empty()
                || title.chars().count() > 100
                || title.contains(['<', '>'])
                || description.len() > 5000
                || description.contains(['<', '>'])
            {
                return Err(AdapterError::invalid("YouTube 제목은 1~100자, 설명은 5,000바이트 이하이며 꺾쇠 문자는 사용할 수 없습니다."));
            }
            let privacy = options["privacy"]
                .as_str()
                .ok_or_else(|| AdapterError::invalid("YouTube 공개 범위를 직접 선택하세요."))?;
            if !["private", "unlisted", "public"].contains(&privacy)
                || options["madeForKids"].as_bool().is_none()
            {
                return Err(AdapterError::invalid(
                    "YouTube 공개 범위와 아동용 여부를 선택하세요.",
                ));
            }
            if privacy != "private" && options["confirmPublic"] != true {
                return Err(AdapterError::invalid(
                    "공개 또는 일부 공개 노출을 확인하세요.",
                ));
            }
            let tags = plan["tags"]
                .as_array()
                .map(|items| {
                    items
                        .iter()
                        .filter_map(Value::as_str)
                        .map(str::len)
                        .sum::<usize>()
                        + items.len().saturating_sub(1)
                })
                .unwrap_or(0);
            if tags > 500 {
                return Err(AdapterError::invalid(
                    "YouTube 태그 합계는 500바이트 이하로 입력하세요.",
                ));
            }
        }
        "instagram" if caption(plan).chars().count() > 2200 => {
            return Err(AdapterError::invalid(
                "Instagram 본문과 해시태그는 총 2,200자 이하로 입력하세요.",
            ))
        }
        "threads" if caption(plan).chars().count() > 500 => {
            return Err(AdapterError::invalid(
                "Threads 본문과 해시태그는 총 500자 이하로 입력하세요.",
            ))
        }
        "facebook" | "threads" | "instagram" if options["confirmPublic"] != true => {
            return Err(AdapterError::invalid(
                "이 채널에 게시할 콘텐츠와 외부 노출을 확인하세요.",
            ))
        }
        "tiktok" => {
            if mode == "direct" {
                if caption(plan).encode_utf16().count() > 2200 {
                    return Err(AdapterError::invalid(
                        "TikTok 본문은 2,200 UTF-16 문자 이하로 입력하세요.",
                    ));
                }
                if options["privacy"].as_str().is_none()
                    || options["musicConsent"] != true
                    || options["publishConsent"] != true
                {
                    return Err(AdapterError::invalid(
                        "TikTok 공개 범위 선택과 음악·게시 동의를 완료하세요.",
                    ));
                }
                if options["commercialContent"] == true
                    && options["brandOrganic"] != true
                    && options["brandContent"] != true
                {
                    return Err(AdapterError::invalid(
                        "TikTok 상업 콘텐츠는 내 브랜드 또는 협찬 여부를 선택하세요.",
                    ));
                }
                if options["brandContent"] == true && options["privacy"] == "SELF_ONLY" {
                    return Err(AdapterError::invalid("TikTok 협찬 콘텐츠는 비공개로 게시할 수 없습니다. 앱 심사 후 공개 Direct Post를 이용하세요."));
                }
            }
        }
        _ => {}
    }
    validate_thumbnail(plan)?;
    validate_cover_offset(plan)?;
    Ok((platform, id))
}
fn validate_thumbnail(plan: &Value) -> Result<(), AdapterError> {
    let thumbnail = &plan["thumbnail"];
    if thumbnail.is_null() {
        return Ok(());
    }
    match plan["platform"].as_str().unwrap_or("") {
        "youtube" => {
            if !matches!(thumbnail["mime"].as_str(), Some("image/jpeg" | "image/png"))
                || !thumbnail["bytes"]
                    .as_u64()
                    .is_some_and(|size| size > 0 && size <= 50 * 1024 * 1024)
            {
                return Err(AdapterError::invalid("YouTube 썸네일은 50 MiB 이하 PNG 또는 JPEG를 선택하세요. WebP는 먼저 변환하세요."));
            }
        }
        "instagram" => {
            if thumbnail["mime"] != "image/jpeg"
                || !thumbnail["bytes"]
                    .as_u64()
                    .is_some_and(|size| size > 0 && size <= 8 * 1024 * 1024)
            {
                return Err(AdapterError::invalid("Instagram Reel 커버는 8 MiB 이하 JPEG를 선택하세요. PNG·WebP는 먼저 변환하세요."));
            }
        }
        _ => {}
    }
    Ok(())
}
fn validate_cover_offset(plan: &Value) -> Result<(), AdapterError> {
    let platform = plan["platform"].as_str().unwrap_or("");
    if !matches!(platform, "instagram" | "tiktok")
        || (platform == "tiktok" && posting_mode(plan) == "draft")
    {
        return Ok(());
    }
    if let Some(value) = plan["options"].get("coverOffsetMs") {
        let offset = value.as_u64().ok_or_else(|| {
            AdapterError::invalid("커버 프레임은 0 이상인 정수 밀리초로 입력하세요.")
        })?;
        let duration = plan["video"]["probe"]["durationSeconds"]
            .as_f64()
            .filter(|value| value.is_finite() && *value > 0.)
            .ok_or_else(|| {
                AdapterError::invalid("커버 프레임을 선택하려면 영상 길이를 먼저 검사하세요.")
            })?;
        if offset > i32::MAX as u64 || offset as f64 >= duration * 1000. {
            return Err(AdapterError::invalid(
                "커버 프레임은 영상 재생 시간 안에서 선택하세요.",
            ));
        }
    }
    Ok(())
}
fn youtube_description(plan: &Value) -> String {
    let mut description = plan["description"].as_str().unwrap_or("").to_string();
    if let Some(tags) = plan["hashtags"].as_array() {
        let tags = tags
            .iter()
            .filter_map(Value::as_str)
            .map(|value| format!("#{}", value.trim_start_matches('#')))
            .collect::<Vec<_>>()
            .join(" ");
        if !tags.is_empty() {
            description.push_str(&format!("\n\n{tags}"));
        }
    }
    description
}
fn posting_mode(plan: &Value) -> &str {
    if plan["mode"] == "tiktok_inbox" {
        "draft"
    } else if let Some(mode) = plan["options"]["mode"].as_str() {
        mode
    } else if plan["mode"] == "draft" {
        "draft"
    } else {
        "direct"
    }
}
fn caption(plan: &Value) -> String {
    let mut parts = Vec::new();
    let title = plan["title"].as_str().unwrap_or("");
    let body = plan["description"].as_str().unwrap_or("");
    if !title.trim().is_empty() {
        parts.push(title.trim().to_string());
    }
    if !body.trim().is_empty() {
        parts.push(body.trim().to_string());
    }
    if let Some(tags) = plan["hashtags"].as_array() {
        let tags = tags
            .iter()
            .filter_map(Value::as_str)
            .filter(|v| !v.trim().is_empty())
            .map(|v| format!("#{}", v.trim().trim_start_matches('#')))
            .collect::<Vec<_>>()
            .join(" ");
        if !tags.is_empty() {
            parts.push(tags);
        }
    }
    parts.join("\n\n")
}
fn validate_tiktok_options(plan: &Value, account: &Value) -> Result<(), AdapterError> {
    let mode = posting_mode(plan);
    if account["capabilities"][mode] != true {
        return Err(AdapterError::invalid(
            "TikTok에서 이 전송 방식의 게시 권한을 승인하세요.",
        ));
    }
    if mode == "draft" {
        return Ok(());
    }
    if plan["options"]["privacy"] != "SELF_ONLY"
        && account["capabilities"]["directPublicSupported"] != true
    {
        return Err(AdapterError::invalid("TikTok 공개 Direct Post 심사 승인을 개발자 콘솔에서 확인하고 OAuth 연결 설정에 기록하세요. 현재 비공개 Direct Post 또는 초안 전송을 사용할 수 있습니다."));
    }
    let options = &plan["options"];
    let info = &account["creatorInfo"];
    if !info["privacyLevelOptions"]
        .as_array()
        .is_some_and(|list| list.contains(&options["privacy"]))
    {
        return Err(AdapterError::invalid(
            "TikTok 계정의 최신 공개 범위를 직접 다시 선택하세요.",
        ));
    }
    for (allow, disabled) in [
        ("allowComments", "commentDisabled"),
        ("allowDuet", "duetDisabled"),
        ("allowStitch", "stitchDisabled"),
    ] {
        if options[allow] == true && info[disabled] != false {
            return Err(AdapterError::invalid(
                "TikTok 계정에서 허용하지 않는 댓글·Duet·Stitch 옵션을 해제하세요.",
            ));
        }
    }
    Ok(())
}
async fn selected_account(
    transport: &dyn Transport,
    plan: &Value,
    access: &crate::oauth::PublishingAccess,
) -> Result<Account, AdapterError> {
    let selected = authenticated_account(transport, plan, access).await?;
    validate_media_probe(plan, &selected.public)?;
    if plan["platform"] == "tiktok" {
        validate_tiktok_options(plan, &selected.public)?;
    }
    Ok(selected)
}
async fn authenticated_account(
    transport: &dyn Transport,
    plan: &Value,
    access: &crate::oauth::PublishingAccess,
) -> Result<Account, AdapterError> {
    let (platform, id) = validate_plan(plan)?;
    let selected = accounts_with(transport, platform, access)
        .await?
        .into_iter()
        .find(|account| account.public["accountId"] == id)
        .ok_or_else(|| {
            AdapterError::invalid(
                "현재 로그인한 계정과 승인한 게시 대상이 다릅니다. 채널을 다시 선택하세요.",
            )
        })?;
    Ok(selected)
}
fn validate_media_probe(plan: &Value, account: &Value) -> Result<(), AdapterError> {
    let platform = plan["platform"].as_str().unwrap_or("");
    if !matches!(platform, "tiktok" | "instagram") {
        return Ok(());
    }
    let probe = &plan["video"]["probe"];
    let duration = probe["durationSeconds"]
        .as_f64()
        .filter(|n| n.is_finite() && *n > 0.)
        .ok_or_else(|| AdapterError::invalid("영상 재생 시간과 규격을 검사한 뒤 게시하세요."))?;
    let width = probe["width"].as_u64().unwrap_or(0);
    let height = probe["height"].as_u64().unwrap_or(0);
    if platform == "tiktok" {
        let max = if posting_mode(plan) == "draft" {
            600
        } else {
            account["creatorInfo"]["maxVideoPostDurationSec"]
                .as_u64()
                .unwrap_or(0)
        };
        if max == 0
            || duration > max as f64
            || !(360..=4096).contains(&width)
            || !(360..=4096).contains(&height)
        {
            return Err(AdapterError::invalid(
                "TikTok 계정의 최대 영상 길이 또는 360~4,096px 영상 크기 조건을 확인하세요.",
            ));
        }
    } else if !(3.0..=900.0).contains(&duration) || width == 0 || width > 1920 || height == 0 {
        return Err(AdapterError::invalid(
            "Instagram Reel은 3초~15분, 가로 최대 1,920px 영상이 필요합니다.",
        ));
    }
    Ok(())
}
pub async fn preflight(plan: &Value) -> Result<Value, String> {
    let (platform, _) = validate_plan(plan).map_err(|error| error.message)?;
    let access = crate::oauth::publishing_access(platform).await?;
    let account = selected_account(&Official, plan, &access)
        .await
        .map_err(|error| error.message)?;
    Ok(
        json!({"ready":true,"account":account.public,"warnings":field_warnings(plan),"checkedAt":chrono::Utc::now().to_rfc3339()}),
    )
}
fn field_warnings(plan: &Value) -> Vec<String> {
    let mut warnings = Vec::new();
    let platform = plan["platform"].as_str().unwrap_or("");
    if platform != "youtube" && plan["tags"].as_array().is_some_and(|v| !v.is_empty()) {
        warnings.push(
            "이 플랫폼은 별도 태그 필드를 지원하지 않습니다. 해시태그는 본문에 적용됩니다.".into(),
        );
    }
    if platform == "threads" {
        warnings.push("Threads 영상에는 별도 썸네일을 적용하지 않습니다.".into());
    }
    if platform == "tiktok" && posting_mode(plan) == "draft" {
        warnings.push("TikTok 초안 전송은 게시 완료가 아닙니다. TikTok 받은 편지함에서 문구와 설정을 적용하고 최종 게시하세요.".into());
    }
    warnings
}
fn result(
    plan: &Value,
    id: &str,
    status: &str,
    url: Option<String>,
    remote: &Value,
    thumbnail_status: &str,
) -> Value {
    json!({"externalId":id,"status":status,"url":url,"remote":remote,"warnings":field_warnings(plan),"thumbnailStatus":thumbnail_status})
}
async fn checkpoint(checkpoint: &Checkpoint, remote: &Value) -> Result<(), AdapterError> {
    checkpoint(remote.clone())
        .await
        .map_err(|_| AdapterError::uncertain(Some(remote.clone())))
}
async fn media_length(path: &Path, platform: &str) -> Result<u64, AdapterError> {
    let meta = tokio::fs::symlink_metadata(path)
        .await
        .map_err(|_| AdapterError::before("승인한 영상 파일을 읽지 못했습니다."))?;
    if !meta.is_file() || meta.file_type().is_symlink() || meta.len() < 12 {
        return Err(AdapterError::invalid("일반 MP4 영상 파일을 선택하세요."));
    }
    let max = match platform {
        "instagram" => 1024 * 1024 * 1024,
        "tiktok" => 4 * 1024 * 1024 * 1024_u64,
        _ => 256 * 1024 * 1024 * 1024_u64,
    };
    if meta.len() > max {
        return Err(AdapterError::invalid(
            "영상 파일이 플랫폼 업로드 크기 제한을 초과합니다.",
        ));
    }
    let mut file = tokio::fs::File::open(path)
        .await
        .map_err(|_| AdapterError::before("영상 파일을 열 수 없습니다."))?;
    let mut header = [0; 12];
    file.read_exact(&mut header)
        .await
        .map_err(|_| AdapterError::before("영상 헤더를 읽지 못했습니다."))?;
    if &header[4..8] != b"ftyp" {
        return Err(AdapterError::invalid("실제 MP4 영상 파일을 선택하세요."));
    }
    Ok(meta.len())
}
pub async fn publish(
    plan: Value,
    media_path: &Path,
    thumbnail_path: Option<&Path>,
    public_media_url: Option<&str>,
    public_thumbnail_url: Option<&str>,
) -> Result<Value, AdapterError> {
    let noop: Checkpoint = Arc::new(|_| Box::pin(async { Ok(()) }));
    publish_with_checkpoint(
        plan,
        media_path,
        thumbnail_path,
        public_media_url,
        public_thumbnail_url,
        noop,
    )
    .await
}
pub async fn publish_with_checkpoint(
    plan: Value,
    media_path: &Path,
    thumbnail_path: Option<&Path>,
    public_media_url: Option<&str>,
    public_thumbnail_url: Option<&str>,
    checkpoint_fn: Checkpoint,
) -> Result<Value, AdapterError> {
    let (platform, _) = validate_plan(&plan)?;
    let length = media_length(media_path, platform).await?;
    let access = crate::oauth::publishing_access(platform)
        .await
        .map_err(AdapterError::before)?;
    let account = selected_account(&Official, &plan, &access).await?;
    publish_with(
        &Official,
        &plan,
        &account,
        media_path,
        length,
        thumbnail_path,
        public_media_url,
        public_thumbnail_url,
        &checkpoint_fn,
    )
    .await
}
async fn publish_with(
    transport: &dyn Transport,
    plan: &Value,
    account: &Account,
    path: &Path,
    length: u64,
    thumbnail: Option<&Path>,
    media_url: Option<&str>,
    thumbnail_url: Option<&str>,
    persist: &Checkpoint,
) -> Result<Value, AdapterError> {
    let (platform, id) = validate_plan(plan)?;
    let token = &account.token;
    match platform {
        "youtube" => {
            youtube_publish(transport, plan, token, path, length, thumbnail, persist).await
        }
        "instagram" => {
            let mut form = vec![
                ("media_type".into(), "REELS".into()),
                ("upload_type".into(), "resumable".into()),
                ("caption".into(), caption(plan)),
                (
                    "share_to_feed".into(),
                    plan["options"]["shareToFeed"]
                        .as_bool()
                        .unwrap_or(false)
                        .to_string(),
                ),
            ];
            if let Some(url) = thumbnail_url {
                validate_public_url(url)?;
                form.push(("cover_url".into(), url.into()));
            } else if let Some(offset) = plan["options"]["coverOffsetMs"].as_u64() {
                form.push(("thumb_offset".into(), offset.to_string()));
            }
            let init = post(
                transport,
                format!("{IG}/{id}/media"),
                token,
                Body::Form(form),
            )
            .await?;
            let container = remote_id(&init, "id")?;
            let remote = json!({"platform":platform,"accountId":id,"containerId":container,"stage":"container_created","thumbnailStatus":if thumbnail_url.is_some(){"requested"}else{"video_frame"}});
            checkpoint(persist, &remote).await?;
            let url = init["uri"]
                .as_str()
                .filter(|url| trusted_upload_url(platform, url))
                .ok_or_else(|| AdapterError::uncertain(Some(remote.clone())))?;
            let mut req = request(
                reqwest::Method::POST,
                url.into(),
                token,
                Body::File(path.into(), 0, length),
            );
            req.oauth_header = true;
            req.headers = vec![
                ("offset".into(), "0".into()),
                ("file_size".into(), length.to_string()),
                ("Content-Type".into(), "application/octet-stream".into()),
            ];
            transport
                .send(req, true)
                .await
                .map_err(|error| error.with_remote(&remote))?;
            let mut remote = remote;
            remote["stage"] = json!("uploaded");
            checkpoint(persist, &remote).await?;
            reconcile_with(transport, plan, account, &remote, persist).await
        }
        "facebook" => {
            let init = post(
                transport,
                format!("{META}/{id}/video_reels"),
                token,
                Body::Form(vec![("upload_phase".into(), "start".into())]),
            )
            .await?;
            let video = remote_id(&init, "video_id")?;
            let mut remote = json!({"platform":platform,"accountId":id,"videoId":video,"stage":"initialized","thumbnailStatus":if thumbnail.is_some(){"pending"}else{"video_frame"}});
            checkpoint(persist, &remote).await?;
            let url = init["upload_url"]
                .as_str()
                .filter(|url| trusted_upload_url(platform, url))
                .ok_or_else(|| AdapterError::uncertain(Some(remote.clone())))?;
            let mut req = request(
                reqwest::Method::POST,
                url.into(),
                token,
                Body::File(path.into(), 0, length),
            );
            req.oauth_header = true;
            req.headers = vec![
                ("offset".into(), "0".into()),
                ("file_size".into(), length.to_string()),
                ("Content-Type".into(), "application/octet-stream".into()),
            ];
            transport
                .send(req, true)
                .await
                .map_err(|error| error.with_remote(&remote))?;
            if let Some(path) = thumbnail {
                let response = transport
                    .send(
                        request(
                            reqwest::Method::POST,
                            format!("{META}/{video}/thumbnails"),
                            token,
                            Body::Thumbnail(path.into(), true),
                        ),
                        true,
                    )
                    .await;
                remote["thumbnailStatus"] = json!(if response
                    .is_ok_and(|reply| reply.body["success"] == true)
                {
                    "applied"
                } else {
                    "failed"
                });
            }
            remote["stage"] = json!("commit_started");
            checkpoint(persist, &remote).await?;
            let finish = post(
                transport,
                format!("{META}/{id}/video_reels"),
                token,
                Body::Form(vec![
                    ("upload_phase".into(), "finish".into()),
                    ("video_id".into(), video.clone()),
                    ("video_state".into(), "PUBLISHED".into()),
                    ("title".into(), plan["title"].as_str().unwrap_or("").into()),
                    ("description".into(), caption(plan)),
                ]),
            )
            .await
            .map_err(|error| error.with_remote(&remote))?;
            if finish["success"] != true {
                return Err(AdapterError::uncertain(Some(remote)));
            }
            remote["stage"] = json!("commit_accepted");
            checkpoint(persist, &remote).await?;
            Ok(result(
                plan,
                &video,
                "processing",
                None,
                &remote,
                remote["thumbnailStatus"].as_str().unwrap_or("video_frame"),
            ))
        }
        "threads" => {
            let url = media_url.ok_or_else(|| {
                AdapterError::before("Threads 영상 전송을 위한 임시 미디어 주소를 준비하세요.")
            })?;
            validate_public_url(url)?;
            let init = post(
                transport,
                format!("{THREADS}/{id}/threads"),
                token,
                Body::Form(vec![
                    ("media_type".into(), "VIDEO".into()),
                    ("video_url".into(), url.into()),
                    ("text".into(), caption(plan)),
                ]),
            )
            .await?;
            let container = remote_id(&init, "id")?;
            let remote = json!({"platform":platform,"accountId":id,"containerId":container,"stage":"uploaded","thumbnailStatus":"unsupported"});
            checkpoint(persist, &remote).await?;
            reconcile_with(transport, plan, account, &remote, persist).await
        }
        "tiktok" => tiktok_publish(transport, plan, account, path, length, persist).await,
        _ => Err(AdapterError::invalid("지원하지 않는 게시 플랫폼입니다.")),
    }
}
fn validate_public_url(raw: &str) -> Result<(), AdapterError> {
    let url =
        Url::parse(raw).map_err(|_| AdapterError::invalid("임시 미디어 URL 형식을 확인하세요."))?;
    if url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
        || url.port_or_known_default() != Some(443)
        || matches!(
            url.host_str(),
            None | Some("localhost" | "127.0.0.1" | "[::1]")
        )
    {
        return Err(AdapterError::invalid(
            "공개 HTTPS 미디어 URL만 사용할 수 있습니다.",
        ));
    }
    Ok(())
}
async fn youtube_publish(
    transport: &dyn Transport,
    plan: &Value,
    token: &str,
    path: &Path,
    length: u64,
    thumbnail: Option<&Path>,
    persist: &Checkpoint,
) -> Result<Value, AdapterError> {
    let description = youtube_description(plan);
    let metadata = json!({"snippet":{"title":plan["title"],"description":description,"tags":plan.get("tags").cloned().unwrap_or(json!([])),"categoryId":plan["options"]["categoryId"].as_str().unwrap_or("22")},"status":{"privacyStatus":plan["options"]["privacy"],"selfDeclaredMadeForKids":plan["options"]["madeForKids"]}});
    let mut init = request(
        reqwest::Method::POST,
        endpoint(
            "https://www.googleapis.com/upload/youtube/v3",
            "videos",
            &[
                ("uploadType", "resumable"),
                ("part", "snippet,status"),
                ("notifySubscribers", "false"),
            ],
        ),
        token,
        Body::Json(metadata),
    );
    init.headers = vec![
        ("X-Upload-Content-Type".into(), "video/mp4".into()),
        ("X-Upload-Content-Length".into(), length.to_string()),
    ];
    let response = transport.send(init, true).await?;
    let url = response
        .headers
        .get(reqwest::header::LOCATION)
        .and_then(|v| v.to_str().ok())
        .filter(|url| trusted_upload_url("youtube", url))
        .ok_or_else(|| AdapterError::uncertain(None))?
        .to_string();
    // Resumable URLs contain bearer-like upload credentials: store only a random
    // native handle, never the URL in job JSON/IPC/logs.
    let session_handle = store_upload_session(&url)?;
    let mut remote = json!({"platform":"youtube","accountId":plan["accountId"],"sessionHandle":session_handle,"size":length,"stage":"initialized","thumbnailStatus":if thumbnail.is_some(){"pending"}else{"video_frame"}});
    checkpoint(persist, &remote).await?;
    let mut upload = request(
        reqwest::Method::PUT,
        url,
        token,
        Body::File(path.into(), 0, length),
    );
    upload.headers = vec![
        ("Content-Type".into(), "video/mp4".into()),
        (
            "Content-Range".into(),
            format!("bytes 0-{}/{length}", length - 1),
        ),
    ];
    let value = transport
        .send(upload, true)
        .await
        .map_err(|error| error.with_remote(&remote))?
        .body;
    let video = remote_id(&value, "id").map_err(|error| error.with_remote(&remote))?;
    if value["snippet"]["channelId"] != plan["accountId"] {
        return Err(AdapterError::uncertain(Some(remote)));
    }
    remote["videoId"] = json!(video);
    remote["stage"] = json!("uploaded");
    checkpoint(persist, &remote).await?;
    remove_upload_session(&session_handle);
    let mut receipt = result(
        plan,
        &video,
        "processing",
        Some(format!("https://www.youtube.com/watch?v={video}")),
        &remote,
        "video_frame",
    );
    if let Some(path) = thumbnail {
        let response = transport
            .send(
                request(
                    reqwest::Method::POST,
                    endpoint(
                        "https://www.googleapis.com/upload/youtube/v3",
                        "thumbnails/set",
                        &[("videoId", &video), ("uploadType", "media")],
                    ),
                    token,
                    Body::Thumbnail(path.into(), false),
                ),
                true,
            )
            .await;
        receipt["thumbnailStatus"] = json!(if response.is_ok() {
            "applied"
        } else {
            "failed"
        });
        remote["thumbnailStatus"] = receipt["thumbnailStatus"].clone();
        checkpoint(persist, &remote).await?;
        receipt["remote"] = remote;
    }
    if value["status"]["privacyStatus"] != plan["options"]["privacy"] {
        receipt["warnings"].as_array_mut().unwrap().push(json!(
            "YouTube가 요청한 공개 범위와 다른 범위로 저장했습니다. 채널 Studio에서 확인하세요."
        ));
    }
    Ok(receipt)
}
fn upload_session_dir() -> Result<PathBuf, AdapterError> {
    #[cfg(test)]
    {
        static DIRECTORY: std::sync::OnceLock<tempfile::TempDir> = std::sync::OnceLock::new();
        return Ok(DIRECTORY
            .get_or_init(|| tempfile::tempdir().expect("fixture upload sessions"))
            .path()
            .into());
    }
    #[cfg(not(test))]
    crate::config::config_path()
        .parent()
        .map(|p| p.join("publishing-upload-sessions"))
        .ok_or_else(|| AdapterError::before("게시 세션 저장 경로를 확인할 수 없습니다."))
}
fn store_upload_session(url: &str) -> Result<String, AdapterError> {
    let dir = upload_session_dir()?;
    std::fs::create_dir_all(&dir).map_err(|_| AdapterError::uncertain(None))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700))
            .map_err(|_| AdapterError::uncertain(None))?;
    }
    let id = uuid::Uuid::new_v4().to_string();
    let mut file =
        tempfile::NamedTempFile::new_in(&dir).map_err(|_| AdapterError::uncertain(None))?;
    use std::io::Write;
    file.write_all(url.as_bytes())
        .map_err(|_| AdapterError::uncertain(None))?;
    file.as_file()
        .sync_all()
        .map_err(|_| AdapterError::uncertain(None))?;
    file.persist(dir.join(&id))
        .map_err(|_| AdapterError::uncertain(None))?;
    Ok(id)
}
fn read_upload_session(handle: &str) -> Result<String, AdapterError> {
    uuid::Uuid::parse_str(handle)
        .map_err(|_| AdapterError::invalid("게시 세션 식별자를 확인하세요."))?;
    let path = upload_session_dir()?.join(handle);
    let meta = std::fs::symlink_metadata(&path).map_err(|_| AdapterError::uncertain(None))?;
    if !meta.is_file() || meta.file_type().is_symlink() || meta.len() > 8192 {
        return Err(AdapterError::uncertain(None));
    }
    let url = std::fs::read_to_string(path).map_err(|_| AdapterError::uncertain(None))?;
    if !trusted_upload_url("youtube", &url) {
        return Err(AdapterError::invalid("게시 세션 전송 주소 검증 실패"));
    }
    Ok(url)
}
fn remove_upload_session(handle: &str) {
    if uuid::Uuid::parse_str(handle).is_ok() {
        if let Ok(directory) = upload_session_dir() {
            let _ = std::fs::remove_file(directory.join(handle));
        }
    }
}
fn tiktok_chunks(length: u64) -> (u64, u64) {
    let chunk = 10 * 1024 * 1024_u64;
    if length <= chunk {
        (length, 1)
    } else {
        (chunk, length / chunk)
    }
}
async fn tiktok_publish(
    transport: &dyn Transport,
    plan: &Value,
    account: &Account,
    path: &Path,
    length: u64,
    persist: &Checkpoint,
) -> Result<Value, AdapterError> {
    validate_tiktok_options(plan, &account.public)?;
    let draft = posting_mode(plan) == "draft";
    let token = &account.token;
    let options = &plan["options"];
    let (chunk, count) = tiktok_chunks(length);
    let mut input = json!({"source_info":{"source":"FILE_UPLOAD","video_size":length,"chunk_size":chunk,"total_chunk_count":count}});
    if !draft {
        input["post_info"] = json!({"title":caption(plan),"privacy_level":options["privacy"],"disable_comment":!options["allowComments"].as_bool().unwrap_or(false),"disable_duet":!options["allowDuet"].as_bool().unwrap_or(false),"disable_stitch":!options["allowStitch"].as_bool().unwrap_or(false),"video_cover_timestamp_ms":options["coverOffsetMs"].as_u64().unwrap_or(0),"brand_organic_toggle":options["brandOrganic"].as_bool().unwrap_or(false),"brand_content_toggle":options["brandContent"].as_bool().unwrap_or(false)});
    }
    let suffix = if draft {
        "inbox/video/init/"
    } else {
        "video/init/"
    };
    let init = post(
        transport,
        format!("{TIKTOK}/post/publish/{suffix}"),
        token,
        Body::Json(input),
    )
    .await?;
    let publish_id = remote_id(&init["data"], "publish_id")?;
    let mut remote = json!({"platform":"tiktok","accountId":plan["accountId"],"publishId":publish_id,"draft":draft,"stage":"initialized","thumbnailStatus":if draft{"unsupported"}else{"video_frame"},"auditStatus":if !draft && options["privacy"]!="SELF_ONLY"{"api_accepted"}else{"not_public"}});
    checkpoint(persist, &remote).await?;
    let upload_url = init["data"]["upload_url"]
        .as_str()
        .filter(|url| trusted_upload_url("tiktok", url))
        .ok_or_else(|| AdapterError::uncertain(Some(remote.clone())))?;
    for index in 0..count {
        let offset = index * chunk;
        let size = if index + 1 == count {
            length - offset
        } else {
            chunk
        };
        let req = Request {
            method: reqwest::Method::PUT,
            url: upload_url.into(),
            token: None,
            oauth_header: false,
            body: Body::File(path.into(), offset, size),
            headers: vec![
                ("Content-Type".into(), "video/mp4".into()),
                (
                    "Content-Range".into(),
                    format!("bytes {offset}-{}/{length}", offset + size - 1),
                ),
            ],
        };
        transport
            .send(req, true)
            .await
            .map_err(|error| error.with_remote(&remote))?;
    }
    remote["stage"] = json!("uploaded");
    checkpoint(persist, &remote).await?;
    Ok(result(
        plan,
        &publish_id,
        "processing",
        None,
        &remote,
        remote["thumbnailStatus"].as_str().unwrap_or("video_frame"),
    ))
}
pub async fn reconcile(plan: Value) -> Result<Value, AdapterError> {
    let noop: Checkpoint = Arc::new(|_| Box::pin(async { Ok(()) }));
    reconcile_with_checkpoint(plan, noop).await
}
pub async fn reconcile_with_checkpoint(
    plan: Value,
    persist: Checkpoint,
) -> Result<Value, AdapterError> {
    let remote = plan
        .get("remote")
        .filter(|r| r.is_object())
        .ok_or_else(|| AdapterError::uncertain(None))?;
    let (platform, _) =
        validate_plan(&plan).map_err(|_| AdapterError::uncertain(Some(remote.clone())))?;
    let access = crate::oauth::publishing_access(platform)
        .await
        .map_err(|_| AdapterError::uncertain(Some(remote.clone())))?;
    // Reading a previously submitted TikTok task must remain possible when its
    // current creator privacy/options differ. This path never starts another post.
    let account = authenticated_account(&Official, &plan, &access)
        .await
        .map_err(|_| AdapterError::uncertain(Some(remote.clone())))?;
    reconcile_with(&Official, &plan, &account, remote, &persist).await
}
async fn reconcile_with(
    transport: &dyn Transport,
    plan: &Value,
    account: &Account,
    remote: &Value,
    persist: &Checkpoint,
) -> Result<Value, AdapterError> {
    let (platform, account_id) = validate_plan(plan)?;
    let token = &account.token;
    if remote["platform"] != platform || remote["accountId"] != account_id {
        return Err(AdapterError::invalid(
            "게시 결과와 승인한 계정이 일치하지 않습니다.",
        ));
    }
    let thumb = remote["thumbnailStatus"].as_str().unwrap_or("video_frame");
    match platform {
        "instagram" | "threads" => {
            let base = if platform == "instagram" { IG } else { THREADS };
            let id = remote_id(remote, "containerId")?;
            if let Some(published) = remote["externalId"].as_str() {
                return published_meta(transport, plan, token, base, published, remote, thumb)
                    .await;
            }
            let fields = if platform == "instagram" {
                "status_code"
            } else {
                "status,error_message"
            };
            let value = get(transport, endpoint(base, &id, &[("fields", fields)]), token)
                .await
                .map_err(|e| e.with_remote(remote))?;
            let status = if platform == "instagram" {
                value["status_code"].as_str()
            } else {
                value["status"].as_str()
            }
            .unwrap_or("");
            if matches!(status, "ERROR" | "EXPIRED") {
                return Err(
                    AdapterError::invalid("SNS 영상 처리가 실패하거나 만료되었습니다.")
                        .with_remote(remote),
                );
            }
            if status == "PUBLISHED" {
                return Err(AdapterError::uncertain(Some(remote.clone())));
            }
            if remote["stage"] == "commit_started" {
                return Err(AdapterError::uncertain(Some(remote.clone())));
            }
            if status != "FINISHED" {
                return Ok(result(plan, &id, "processing", None, remote, thumb));
            }
            let mut updated = remote.clone();
            updated["stage"] = json!("commit_started");
            checkpoint(persist, &updated).await?;
            let suffix = if platform == "instagram" {
                "media_publish"
            } else {
                "threads_publish"
            };
            let published = post(
                transport,
                format!("{base}/{account_id}/{suffix}"),
                token,
                Body::Form(vec![("creation_id".into(), id)]),
            )
            .await
            .map_err(|e| e.with_remote(&updated))?;
            let published_id = remote_id(&published, "id").map_err(|e| e.with_remote(&updated))?;
            updated["externalId"] = json!(published_id);
            updated["stage"] = json!("published");
            checkpoint(persist, &updated).await?;
            published_meta(transport, plan, token, base, &published_id, &updated, thumb).await
        }
        "facebook" => {
            let id = remote_id(remote, "videoId")?;
            let value = get(
                transport,
                endpoint(META, &id, &[("fields", "status,permalink_url")]),
                token,
            )
            .await
            .map_err(|e| e.with_remote(remote))?;
            let published = value["status"]["publishing_phase"]["status"] == "complete";
            if value["status"]["video_status"] == "error"
                || value["status"]["processing_phase"]["status"] == "error"
            {
                return Err(
                    AdapterError::invalid("Facebook 영상 처리가 실패했습니다.").with_remote(remote)
                );
            }
            let url = value["permalink_url"]
                .as_str()
                .and_then(|url| crate::social::validate_platform_url(platform, url).ok());
            if !published && remote["stage"] != "commit_accepted" {
                return Err(AdapterError::uncertain(Some(remote.clone())));
            }
            let mut receipt = result(
                plan,
                &id,
                if published { "published" } else { "processing" },
                url,
                remote,
                thumb,
            );
            if thumb == "failed" {
                receipt["warnings"].as_array_mut().unwrap().push(json!("Facebook Reel의 별도 커버 적용에 실패했습니다. 영상 게시 상태와 별도로 확인하세요."));
            }
            Ok(receipt)
        }
        "tiktok" => {
            let id = remote_id(remote, "publishId")?;
            let value = transport
                .send(
                    request(
                        reqwest::Method::POST,
                        format!("{TIKTOK}/post/publish/status/fetch/"),
                        token,
                        Body::Json(json!({"publish_id":id})),
                    ),
                    false,
                )
                .await
                .map_err(|e| e.with_remote(remote))?
                .body;
            tiktok_status(plan, remote, &value)
        }
        "youtube" => {
            if let Some(id) = remote["videoId"].as_str() {
                let value = get(
                    transport,
                    endpoint(
                        "https://www.googleapis.com/youtube/v3",
                        "videos",
                        &[("part", "snippet,status,processingDetails"), ("id", id)],
                    ),
                    token,
                )
                .await
                .map_err(|e| e.with_remote(remote))?;
                let item = value["items"]
                    .as_array()
                    .and_then(|v| v.first())
                    .ok_or_else(|| AdapterError::uncertain(Some(remote.clone())))?;
                if item["snippet"]["channelId"] != plan["accountId"] {
                    return Err(AdapterError::uncertain(Some(remote.clone())));
                }
                let state = item["status"]["uploadStatus"].as_str().unwrap_or("");
                if matches!(state, "failed" | "rejected" | "deleted") {
                    return Err(AdapterError::invalid(
                        "YouTube 영상 처리 또는 정책 확인에 실패했습니다.",
                    )
                    .with_remote(remote));
                }
                let mut receipt = result(
                    plan,
                    id,
                    if state == "processed" {
                        "published"
                    } else {
                        "processing"
                    },
                    Some(format!("https://www.youtube.com/watch?v={id}")),
                    remote,
                    thumb,
                );
                receipt["actualPrivacy"] = item["status"]["privacyStatus"].clone();
                if item["status"]["privacyStatus"] != plan["options"]["privacy"] {
                    receipt["warnings"].as_array_mut().unwrap().push(json!(
                        "YouTube가 요청한 공개 범위와 다른 범위로 저장했습니다. 채널 Studio에서 확인하세요."
                    ));
                }
                if thumb == "pending" {
                    receipt["warnings"].as_array_mut().unwrap().push(json!(
                        "영상 업로드는 확인했지만 썸네일 적용 결과는 확인하지 못했습니다. YouTube Studio에서 커버를 확인하세요."
                    ));
                }
                return Ok(receipt);
            }
            let handle = remote["sessionHandle"]
                .as_str()
                .ok_or_else(|| AdapterError::uncertain(Some(remote.clone())))?;
            let size = remote["size"]
                .as_u64()
                .ok_or_else(|| AdapterError::uncertain(Some(remote.clone())))?;
            let url = read_upload_session(handle)?;
            let mut req = request(reqwest::Method::PUT, url, token, Body::Empty);
            req.headers = vec![
                ("Content-Length".into(), "0".into()),
                ("Content-Range".into(), format!("bytes */{size}")),
            ];
            let reply = transport
                .send(req, false)
                .await
                .map_err(|e| e.with_remote(remote))?;
            if reply.status == 308 {
                return Err(AdapterError::uncertain(Some(remote.clone())));
            }
            let id = remote_id(&reply.body, "id")?;
            if reply.body["snippet"]["channelId"] != plan["accountId"] {
                return Err(AdapterError::uncertain(Some(remote.clone())));
            }
            let mut updated = remote.clone();
            updated["videoId"] = json!(id);
            updated["stage"] = json!("uploaded");
            checkpoint(persist, &updated).await?;
            Ok(result(
                plan,
                &id,
                "processing",
                Some(format!("https://www.youtube.com/watch?v={id}")),
                &updated,
                thumb,
            ))
        }
        _ => Err(AdapterError::invalid("지원하지 않는 게시 플랫폼입니다.")),
    }
}
async fn published_meta(
    transport: &dyn Transport,
    plan: &Value,
    token: &str,
    base: &str,
    id: &str,
    remote: &Value,
    thumb: &str,
) -> Result<Value, AdapterError> {
    let url = get(
        transport,
        endpoint(base, id, &[("fields", "permalink")]),
        token,
    )
    .await
    .ok()
    .and_then(|v| v["permalink"].as_str().map(str::to_owned))
    .and_then(|url| {
        crate::social::validate_platform_url(plan["platform"].as_str().unwrap_or(""), &url).ok()
    });
    Ok(result(
        plan,
        id,
        "published",
        url,
        remote,
        if thumb == "requested" {
            "requested"
        } else {
            thumb
        },
    ))
}
fn tiktok_status(plan: &Value, remote: &Value, value: &Value) -> Result<Value, AdapterError> {
    let id = remote_id(remote, "publishId")?;
    let state = value["data"]["status"].as_str().unwrap_or("");
    if state == "FAILED" {
        return Err(AdapterError::invalid(
            "TikTok이 콘텐츠 처리를 거절했습니다. 앱 권한·콘텐츠 조건을 확인하세요.",
        )
        .with_remote(remote));
    }
    let draft = remote["draft"] == true;
    let status = if draft && state == "SEND_TO_USER_INBOX" {
        "draft_sent"
    } else if state == "PUBLISH_COMPLETE" {
        "published"
    } else {
        "processing"
    };
    let mut receipt = result(
        plan,
        &id,
        status,
        None,
        remote,
        remote["thumbnailStatus"].as_str().unwrap_or("video_frame"),
    );
    // TikTok exposes IDs only after actual post completion; inbox IDs are not posts.
    if status == "published" {
        receipt["postIds"] = value["data"]["publicaly_available_post_id"].clone();
        if draft {
            receipt["warnings"].as_array_mut().unwrap().push(json!(
                "TikTok에서 사용자가 최종 게시한 결과를 API로 확인했습니다."
            ));
        }
    }
    Ok(receipt)
}

#[cfg(test)]
#[path = "publishing_adapters_tests.rs"]
mod tests;
