//! Public YouTube reads using a locally stored Data API key. No OAuth or mutation endpoints.
//! Contract: https://developers.google.com/youtube/v3/docs/channels/list
//! https://developers.google.com/youtube/v3/docs/playlistItems/list
//! https://developers.google.com/youtube/v3/docs/videos/list
use crate::{config::AppConfig, trends::parse_iso_duration};
use chrono::{DateTime, SecondsFormat, Utc};
use futures_util::StreamExt;
use reqwest::{header::HeaderValue, Client, RequestBuilder, StatusCode};
use serde::Serialize;
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    time::Duration,
};
use url::Url;

const MAX_RESPONSE_BYTES: usize = 2_000_000;
const MAX_VIDEOS: usize = 25;
const MAX_SAFE_COUNT: u64 = 9_007_199_254_740_991;
const INPUT_ERROR: &str =
    "youtube_invalid_query: @핸들, UC 채널 ID 또는 YouTube 채널 주소를 입력하세요.";
const SOURCE_ERROR: &str =
    "youtube_invalid_response: YouTube 응답을 읽을 수 없습니다. 잠시 후 다시 시도하세요.";
const KEY_MISSING: &str = "youtube_key_missing: 설정에서 YouTube Data API 키를 등록하세요.";
const KEY_REJECTED: &str =
    "youtube_key_rejected: YouTube Data API 키와 Google Cloud의 API 제한 설정을 확인하세요.";
const NOT_FOUND: &str = "youtube_channel_not_found: 공개 YouTube 채널을 찾지 못했습니다. 핸들 또는 채널 ID를 확인하세요.";

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Channel {
    id: String,
    title: String,
    description: String,
    url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    custom_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    thumbnail_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    subscriber_count: Option<u64>,
    hidden_subscriber_count: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    video_count: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    view_count: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    uploads_playlist_id: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Video {
    id: String,
    title: String,
    url: String,
    published_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    thumbnail_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    view_count: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    like_count: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    comment_count: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    duration_seconds: Option<f64>,
}

#[derive(Debug, PartialEq, Eq)]
enum ChannelQuery {
    Id(String),
    Handle(String),
    Username(String),
}

impl ChannelQuery {
    fn parameter(&self) -> (&'static str, &str) {
        match self {
            Self::Id(value) => ("id", value),
            Self::Handle(value) => ("forHandle", value),
            Self::Username(value) => ("forUsername", value),
        }
    }
}

fn channel_id(raw: &str) -> bool {
    raw.len() == 24 && raw.starts_with("UC") && identifier(raw)
}
fn identifier(raw: &str) -> bool {
    !raw.is_empty()
        && raw
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-'))
}
fn valid_handle(raw: &str) -> bool {
    !raw.is_empty()
        && raw.chars().count() <= 100
        && raw.len() <= 400
        && !raw
            .chars()
            .any(|c| c.is_control() || c.is_whitespace() || "/\\?#%:@&=\"'<>".contains(c))
}
fn decode_segment(raw: &str) -> Result<String, String> {
    let mut result = Vec::with_capacity(raw.len());
    let bytes = raw.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            let pair = bytes.get(index + 1..index + 3).ok_or(INPUT_ERROR)?;
            let hex = std::str::from_utf8(pair).map_err(|_| INPUT_ERROR)?;
            result.push(u8::from_str_radix(hex, 16).map_err(|_| INPUT_ERROR)?);
            index += 3;
        } else {
            result.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(result).map_err(|_| INPUT_ERROR.into())
}

fn parse_query(raw: &str) -> Result<ChannelQuery, String> {
    let raw = raw.trim();
    if raw.is_empty() || raw.len() > 2048 || raw.chars().any(char::is_control) {
        return Err(INPUT_ERROR.into());
    }
    if channel_id(raw) {
        return Ok(ChannelQuery::Id(raw.into()));
    }
    if let Some(handle) = raw.strip_prefix('@') {
        return if valid_handle(handle) {
            Ok(ChannelQuery::Handle(format!("@{handle}")))
        } else {
            Err(INPUT_ERROR.into())
        };
    }
    // Saved channel handles may omit '@'. Plain text is always an exact handle, never search.
    if !raw.contains("://") && !raw.contains('/') && valid_handle(raw) {
        return Ok(ChannelQuery::Handle(format!("@{raw}")));
    }
    let normalized = if raw.starts_with("youtube.com/")
        || raw.starts_with("www.youtube.com/")
        || raw.starts_with("m.youtube.com/")
    {
        format!("https://{raw}")
    } else {
        raw.to_owned()
    };
    let url = Url::parse(&normalized).map_err(|_| INPUT_ERROR)?;
    if !["https", "http"].contains(&url.scheme())
        || !["youtube.com", "www.youtube.com", "m.youtube.com"]
            .contains(&url.host_str().unwrap_or(""))
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
    {
        return Err(INPUT_ERROR.into());
    }
    let path = url.path().trim_matches('/');
    let segments: Vec<String> = path
        .split('/')
        .map(decode_segment)
        .collect::<Result<_, _>>()?;
    let tab = |value: &str| {
        [
            "featured",
            "videos",
            "shorts",
            "streams",
            "playlists",
            "community",
            "about",
        ]
        .contains(&value)
    };
    // Tracking query strings are ignored: this URL is parsed locally and never requested.
    match segments.as_slice() {
        [handle] | [handle, _]
            if handle.starts_with('@') && (segments.len() == 1 || tab(&segments[1])) =>
        {
            let handle = handle.strip_prefix('@').ok_or(INPUT_ERROR)?;
            if valid_handle(handle) {
                Ok(ChannelQuery::Handle(format!("@{handle}")))
            } else {
                Err(INPUT_ERROR.into())
            }
        }
        [kind, id] | [kind, id, _]
            if kind == "channel"
                && channel_id(id)
                && (segments.len() == 2 || tab(&segments[2])) =>
        {
            Ok(ChannelQuery::Id(id.clone()))
        }
        [kind, user] | [kind, user, _]
            if kind == "user"
                && valid_handle(user)
                && user.is_ascii()
                && (segments.len() == 2 || tab(&segments[2])) =>
        {
            Ok(ChannelQuery::Username(user.clone()))
        }
        _ => Err(INPUT_ERROR.into()),
    }
}

fn api_key(config: &AppConfig) -> Result<HeaderValue, String> {
    let raw = config
        .youtube_api_key
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .ok_or(KEY_MISSING)?;
    if raw.len() > 256 || !identifier(raw) {
        return Err(KEY_REJECTED.into());
    }
    let mut value = HeaderValue::from_str(raw).map_err(|_| KEY_REJECTED)?;
    value.set_sensitive(true);
    Ok(value)
}
fn http_client() -> Result<Client, String> {
    Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(3))
        .timeout(Duration::from_secs(12))
        .user_agent("TorisStudioDesktop/0.1")
        .no_proxy()
        .build()
        .map_err(|_| "youtube_connection_failed: YouTube 연결을 준비할 수 없습니다.".into())
}

enum Resource {
    Channels,
    PlaylistItems,
    Videos,
}
fn request(
    client: &Client,
    key: &HeaderValue,
    resource: Resource,
    parameters: &[(&str, &str)],
) -> RequestBuilder {
    let endpoint = match resource {
        Resource::Channels => "https://www.googleapis.com/youtube/v3/channels",
        Resource::PlaylistItems => "https://www.googleapis.com/youtube/v3/playlistItems",
        Resource::Videos => "https://www.googleapis.com/youtube/v3/videos",
    };
    // A sensitive Google standard API-key header avoids putting credentials in URLs.
    // https://docs.cloud.google.com/docs/authentication/api-keys-use#using_an_api_key_with_rest
    client
        .get(endpoint)
        .header("x-goog-api-key", key.clone())
        .query(parameters)
}

fn provider_error(status: StatusCode, payload: Option<&Value>) -> String {
    let mut reasons = Vec::new();
    if let Some(error) = payload.and_then(|v| v.get("error")) {
        for field in ["errors", "details"] {
            if let Some(items) = error.get(field).and_then(Value::as_array) {
                reasons.extend(
                    items
                        .iter()
                        .filter_map(|item| item.get("reason").and_then(Value::as_str)),
                );
            }
        }
    }
    if status == StatusCode::TOO_MANY_REQUESTS || reasons.iter().any(|r| ["quotaExceeded", "dailyLimitExceeded", "dailyLimitExceededUnreg", "userRateLimitExceeded", "rateLimitExceeded"].contains(r)) {
        "youtube_quota_exceeded: YouTube API 사용량을 초과했습니다. Google Cloud 할당량을 확인하고 나중에 다시 시도하세요."
    } else if status == StatusCode::UNAUTHORIZED || reasons.iter().any(|r| ["keyInvalid", "apiKeyInvalid", "ipRefererBlocked", "API_KEY_INVALID", "API_KEY_SERVICE_BLOCKED", "API_KEY_HTTP_REFERRER_BLOCKED", "API_KEY_IP_ADDRESS_BLOCKED"].contains(r)) {
        KEY_REJECTED
    } else if reasons.iter().any(|r| ["accessNotConfigured", "SERVICE_DISABLED"].contains(r)) {
        "youtube_api_disabled: Google Cloud 프로젝트에서 YouTube Data API v3를 활성화하세요."
    } else if status == StatusCode::NOT_FOUND {
        NOT_FOUND
    } else if status == StatusCode::FORBIDDEN {
        "youtube_access_denied: YouTube 공개 데이터 접근이 거부되었습니다. API 키 제한과 API 활성화를 확인하세요."
    } else {
        "youtube_request_failed: YouTube 요청을 처리하지 못했습니다. 잠시 후 다시 시도하세요."
    }.into()
}

async fn fetch_json(request: RequestBuilder) -> Result<Value, String> {
    // No automatic retries: each refresh has predictable quota usage.
    let response = request.send().await.map_err(|error| {
        if error.is_timeout() {
            "youtube_timeout: YouTube 응답 시간이 초과되었습니다. 다시 시도하세요.".to_string()
        } else {
            "youtube_connection_failed: YouTube에 연결할 수 없습니다. 네트워크를 확인하세요."
                .to_string()
        }
    })?;
    let status = response.status();
    if response
        .content_length()
        .is_some_and(|n| n > MAX_RESPONSE_BYTES as u64)
    {
        return Err(SOURCE_ERROR.into());
    }
    let mut stream = response.bytes_stream();
    let mut bytes = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| SOURCE_ERROR.to_string())?;
        if bytes.len().saturating_add(chunk.len()) > MAX_RESPONSE_BYTES {
            return Err(SOURCE_ERROR.into());
        }
        bytes.extend_from_slice(&chunk);
    }
    let payload = serde_json::from_slice::<Value>(&bytes);
    if !status.is_success() {
        return Err(provider_error(status, payload.as_ref().ok()));
    }
    payload.map_err(|_| SOURCE_ERROR.into())
}

fn short(raw: &str, limit: usize) -> String {
    raw.chars()
        .filter(|c| !c.is_control() || matches!(c, '\n' | '\t'))
        .take(limit)
        .collect::<String>()
        .trim()
        .into()
}
fn count(value: &Value) -> Option<u64> {
    let count = match value {
        Value::String(raw) if !raw.is_empty() && raw.bytes().all(|b| b.is_ascii_digit()) => {
            raw.parse::<u64>().ok()
        }
        Value::Number(raw) => raw.as_u64(),
        _ => None,
    }?;
    (count <= MAX_SAFE_COUNT).then_some(count)
}
fn thumbnails(snippet: &Value) -> Option<String> {
    for size in ["maxres", "high", "standard", "medium", "default"] {
        let Some(raw) = snippet["thumbnails"][size]["url"].as_str() else {
            continue;
        };
        let Ok(url) = Url::parse(raw) else {
            continue;
        };
        if raw.len() <= 2048
            && url.scheme() == "https"
            && url.username().is_empty()
            && url.password().is_none()
            && url.port().is_none()
            && [
                "i.ytimg.com",
                "yt3.ggpht.com",
                "yt3.googleusercontent.com",
                "lh3.googleusercontent.com",
            ]
            .contains(&url.host_str().unwrap_or(""))
        {
            return Some(url.into());
        }
    }
    None
}
fn items(payload: &Value) -> Result<&[Value], String> {
    payload
        .get("items")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .ok_or_else(|| SOURCE_ERROR.into())
}
fn parse_channel(payload: &Value) -> Result<Channel, String> {
    let item = items(payload)?.first().ok_or(NOT_FOUND)?;
    let id = item["id"]
        .as_str()
        .filter(|id| channel_id(id))
        .ok_or(SOURCE_ERROR)?
        .to_owned();
    let title = short(item["snippet"]["title"].as_str().ok_or(SOURCE_ERROR)?, 300);
    if title.is_empty() {
        return Err(SOURCE_ERROR.into());
    }
    let hidden = item["statistics"]["hiddenSubscriberCount"]
        .as_bool()
        .unwrap_or(true);
    Ok(Channel {
        url: format!("https://www.youtube.com/channel/{id}"),
        id,
        title,
        description: short(item["snippet"]["description"].as_str().unwrap_or(""), 5000),
        custom_url: item["snippet"]["customUrl"]
            .as_str()
            .map(|s| short(s, 150))
            .filter(|s| !s.is_empty()),
        thumbnail_url: thumbnails(&item["snippet"]),
        subscriber_count: (!hidden)
            .then(|| count(&item["statistics"]["subscriberCount"]))
            .flatten(),
        hidden_subscriber_count: hidden,
        video_count: count(&item["statistics"]["videoCount"]),
        view_count: count(&item["statistics"]["viewCount"]),
        uploads_playlist_id: item["contentDetails"]["relatedPlaylists"]["uploads"]
            .as_str()
            .filter(|raw| raw.len() <= 100 && identifier(raw))
            .map(str::to_owned),
    })
}
fn upload_ids(payload: &Value) -> Result<Vec<String>, String> {
    let mut seen = HashSet::new();
    let mut ids = Vec::new();
    for item in items(payload)?.iter().take(MAX_VIDEOS) {
        let Some(id) = item["contentDetails"]["videoId"].as_str() else {
            continue;
        };
        if id.len() == 11 && identifier(id) && seen.insert(id) {
            ids.push(id.to_owned());
        }
    }
    Ok(ids)
}
fn parse_videos(payload: &Value, channel_id: &str, order: &[String]) -> Result<Vec<Video>, String> {
    let mut videos = HashMap::new();
    for item in items(payload)?.iter().take(MAX_VIDEOS) {
        let Some(id) = item["id"]
            .as_str()
            .filter(|id| id.len() == 11 && identifier(id))
        else {
            continue;
        };
        if item["snippet"]["channelId"].as_str() != Some(channel_id) {
            continue;
        }
        let title = short(item["snippet"]["title"].as_str().unwrap_or(""), 300);
        let Some(published_at) = item["snippet"]["publishedAt"]
            .as_str()
            .and_then(|raw| DateTime::parse_from_rfc3339(raw).ok())
            .map(|date| {
                date.with_timezone(&Utc)
                    .to_rfc3339_opts(SecondsFormat::Millis, true)
            })
        else {
            continue;
        };
        if title.is_empty() {
            continue;
        }
        videos.insert(
            id.to_owned(),
            Video {
                id: id.into(),
                title,
                url: format!("https://www.youtube.com/watch?v={id}"),
                published_at,
                thumbnail_url: thumbnails(&item["snippet"]),
                view_count: count(&item["statistics"]["viewCount"]),
                like_count: count(&item["statistics"]["likeCount"]),
                comment_count: count(&item["statistics"]["commentCount"]),
                duration_seconds: item["contentDetails"]["duration"]
                    .as_str()
                    .and_then(parse_iso_duration),
            },
        );
    }
    // Keep upload-playlist order even when videos.list returns a different order.
    Ok(order
        .iter()
        .take(MAX_VIDEOS)
        .filter_map(|id| videos.remove(id))
        .collect())
}

pub async fn lookup_channel(config: &AppConfig, input: Value) -> Result<Value, String> {
    let object = input
        .as_object()
        .filter(|o| o.len() == 1)
        .ok_or(INPUT_ERROR)?;
    let query = parse_query(
        object
            .get("query")
            .and_then(Value::as_str)
            .ok_or(INPUT_ERROR)?,
    )?;
    let key = api_key(config)?;
    let client = http_client()?;
    let payload = fetch_json(request(
        &client,
        &key,
        Resource::Channels,
        &[
            ("part", "snippet,statistics,contentDetails"),
            query.parameter(),
            ("maxResults", "1"),
        ],
    ))
    .await?;
    serde_json::to_value(parse_channel(&payload)?).map_err(|_| SOURCE_ERROR.into())
}

pub async fn channel_videos(config: &AppConfig, id: String) -> Result<Value, String> {
    if !channel_id(&id) {
        return Err(INPUT_ERROR.into());
    }
    let key = api_key(config)?;
    let client = http_client()?;
    let payload = fetch_json(request(
        &client,
        &key,
        Resource::Channels,
        &[
            ("part", "snippet,statistics,contentDetails"),
            ("id", &id),
            ("maxResults", "1"),
        ],
    ))
    .await?;
    let channel = parse_channel(&payload)?;
    if channel.id != id {
        return Err(SOURCE_ERROR.into());
    }
    let mut videos = Vec::new();
    if let Some(playlist) = &channel.uploads_playlist_id {
        let uploads = fetch_json(request(
            &client,
            &key,
            Resource::PlaylistItems,
            &[
                ("part", "contentDetails"),
                ("playlistId", playlist),
                ("maxResults", "25"),
            ],
        ))
        .await?;
        let ids = upload_ids(&uploads)?;
        if !ids.is_empty() {
            let joined = ids.join(",");
            let payload = fetch_json(request(
                &client,
                &key,
                Resource::Videos,
                &[
                    ("part", "snippet,statistics,contentDetails"),
                    ("id", &joined),
                ],
            ))
            .await?;
            videos = parse_videos(&payload, &id, &ids)?;
        }
    }
    Ok(
        json!({"channel":channel,"videos":videos,"fetchedAt":Utc::now().to_rfc3339_opts(SecondsFormat::Millis,true)}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    const CHANNEL: &str = "UCabcdefghijklmnopqrstuv";

    // Only tests can supply a loopback transport; production endpoints stay fixed above.
    async fn local_response(raw: Vec<u8>) -> RequestBuilder {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut incoming = [0u8; 4096];
            let _ = socket.read(&mut incoming).await;
            let _ = socket.write_all(&raw).await;
        });
        http_client().unwrap().get(format!("http://{address}"))
    }

    #[test]
    fn channel_query_uses_exact_api_filters_and_accepts_real_channel_links() {
        assert_eq!(
            parse_query(CHANNEL).unwrap(),
            ChannelQuery::Id(CHANNEL.into())
        );
        assert_eq!(
            parse_query("@toris").unwrap().parameter(),
            ("forHandle", "@toris")
        );
        assert_eq!(
            parse_query("toris").unwrap(),
            ChannelQuery::Handle("@toris".into())
        );
        assert_eq!(
            parse_query("https://www.youtube.com/@%ED%86%A0%EB%A6%AC%EC%8A%A4/videos?si=copy")
                .unwrap(),
            ChannelQuery::Handle("@토리스".into())
        );
        assert_eq!(
            parse_query(&format!("https://m.youtube.com/channel/{CHANNEL}")).unwrap(),
            ChannelQuery::Id(CHANNEL.into())
        );
        assert_eq!(
            parse_query("youtube.com/user/legacy_name/about")
                .unwrap()
                .parameter(),
            ("forUsername", "legacy_name")
        );
    }

    #[test]
    fn channel_query_rejects_arbitrary_destinations_and_non_channel_paths() {
        for raw in [
            "",
            "https://evil.example/@toris",
            "https://youtube.com.evil.example/@toris",
            "https://user@youtube.com/@toris",
            "https://www.youtube.com:8888/@toris",
            "https://www.youtube.com/watch?v=abcdefghijk",
            "https://www.youtube.com/c/custom",
            "https://www.youtube.com/@toris/not-a-tab",
            "https://www.youtube.com/channel/UCbad",
            "https://www.youtube.com/@%2Fsecret",
            "https://www.youtube.com/@%00secret",
            "@@toris",
            "two words",
        ] {
            assert!(parse_query(raw).is_err(), "accepted invalid input: {raw}");
        }
    }

    #[test]
    fn channel_fixture_keeps_hidden_statistics_unknown_and_canonicalizes_urls() {
        let payload = json!({"items":[{"id":CHANNEL,"snippet":{"title":"Toris","description":"Real description","customUrl":"@toris","thumbnails":{"high":{"url":"https://yt3.ggpht.com/channel-photo"}}},"statistics":{"subscriberCount":"12400","hiddenSubscriberCount":false,"videoCount":"42","viewCount":"987654"},"contentDetails":{"relatedPlaylists":{"uploads":"UUabcdefghijklmnopqrstuv"}}}]});
        let channel = serde_json::to_value(parse_channel(&payload).unwrap()).unwrap();
        assert_eq!(channel["subscriberCount"], 12400);
        assert_eq!(channel["videoCount"], 42);
        assert_eq!(
            channel["url"],
            format!("https://www.youtube.com/channel/{CHANNEL}")
        );
        assert_eq!(channel["uploadsPlaylistId"], "UUabcdefghijklmnopqrstuv");
        let mut hidden = payload.clone();
        hidden["items"][0]["statistics"]["hiddenSubscriberCount"] = json!(true);
        let hidden = serde_json::to_value(parse_channel(&hidden).unwrap()).unwrap();
        assert_eq!(hidden["hiddenSubscriberCount"], true);
        assert!(hidden.get("subscriberCount").is_none());
        assert_eq!(parse_channel(&json!({"items":[]})).unwrap_err(), NOT_FOUND);
        assert!(parse_channel(&json!({"items":[{"id":"bad"}]})).is_err());
    }

    #[test]
    fn recent_video_fixtures_preserve_upload_order_real_counts_and_missing_metrics() {
        let first = json!({"id":"abcdefghijk","snippet":{"title":"First","channelId":CHANNEL,"publishedAt":"2026-10-08T12:00:00+09:00","thumbnails":{"high":{"url":"https://i.ytimg.com/vi/abcdefghijk/hqdefault.jpg"}}},"statistics":{"viewCount":"12345","likeCount":"67","commentCount":"0"},"contentDetails":{"duration":"PT2M3S"}});
        let second = json!({"id":"lmnopqrstuv","snippet":{"title":"Second","channelId":CHANNEL,"publishedAt":"2026-10-07T03:00:00Z"},"statistics":{},"contentDetails":{"duration":"PT15S"}});
        let mut foreign = first.clone();
        foreign["id"] = json!("zabcdefghij");
        foreign["snippet"]["channelId"] = json!("UCzyxwvutsrqponmlkjihgfe");
        let uploads = json!({"items":[{"contentDetails":{"videoId":"abcdefghijk"}},{"contentDetails":{"videoId":"lmnopqrstuv"}},{"contentDetails":{"videoId":"abcdefghijk"}},{"contentDetails":{"videoId":"deleted-invalid"}},{"contentDetails":{"videoId":"zabcdefghij"}}]});
        let ids = upload_ids(&uploads).unwrap();
        assert_eq!(ids.len(), 3);
        let videos = serde_json::to_value(
            parse_videos(&json!({"items":[second,first,foreign]}), CHANNEL, &ids).unwrap(),
        )
        .unwrap();
        assert_eq!(videos.as_array().unwrap().len(), 2);
        assert_eq!(videos[0]["id"], "abcdefghijk");
        assert_eq!(videos[0]["publishedAt"], "2026-10-08T03:00:00.000Z");
        assert_eq!(videos[0]["viewCount"], 12345);
        assert_eq!(videos[0]["commentCount"], 0);
        assert_eq!(videos[0]["durationSeconds"], 123.0);
        assert!(videos[1].get("viewCount").is_none());
        assert!(videos[1].get("likeCount").is_none());
        assert!(count(&json!("9007199254740992")).is_none());
        assert!(count(&json!("-1")).is_none());
        assert!(count(&json!(1.5)).is_none());
    }

    #[test]
    fn key_stays_in_sensitive_header_and_provider_errors_are_redacted() {
        let config = AppConfig {
            youtube_api_key: Some("fixture-private-value".into()),
            ..Default::default()
        };
        let key = api_key(&config).unwrap();
        let built = request(
            &http_client().unwrap(),
            &key,
            Resource::Channels,
            &[("part", "snippet"), ("forHandle", "@toris")],
        )
        .build()
        .unwrap();
        assert_eq!(built.url().host_str(), Some("www.googleapis.com"));
        assert!(!built.url().as_str().contains("fixture-private-value"));
        assert!(built.headers()["x-goog-api-key"].is_sensitive());
        assert!(!format!("{built:?}").contains("fixture-private-value"));
        let payload = json!({"error":{"message":"fixture-private-value https://leak.example/?key=private","errors":[{"reason":"quotaExceeded","message":"private"}]}});
        let error = provider_error(StatusCode::FORBIDDEN, Some(&payload));
        assert!(error.starts_with("youtube_quota_exceeded:"));
        assert!(!error.contains("private"));
        let rejected = json!({"error":{"details":[{"reason":"API_KEY_INVALID"}]}});
        assert_eq!(
            provider_error(StatusCode::BAD_REQUEST, Some(&rejected)),
            KEY_REJECTED
        );
        let thumbnail = thumbnails(
            &json!({"thumbnails":{"high":{"url":"https://evil.example/tracker"},"default":{"url":"http://i.ytimg.com/image"}}}),
        );
        assert!(thumbnail.is_none());
    }

    #[tokio::test]
    async fn missing_key_and_bad_input_stop_before_any_network_call() {
        let config = AppConfig::default();
        assert_eq!(
            lookup_channel(&config, json!({"query":"@toris"}))
                .await
                .unwrap_err(),
            KEY_MISSING
        );
        assert_eq!(
            channel_videos(&config, CHANNEL.into()).await.unwrap_err(),
            KEY_MISSING
        );
        assert_eq!(
            lookup_channel(
                &config,
                json!({"query":"@toris","endpoint":"https://evil.example"})
            )
            .await
            .unwrap_err(),
            INPUT_ERROR
        );
        assert_eq!(
            channel_videos(&config, "not-a-channel-id".into())
                .await
                .unwrap_err(),
            INPUT_ERROR
        );
    }

    #[tokio::test]
    async fn transport_limits_both_declared_and_streamed_response_sizes() {
        let declared = format!(
            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            MAX_RESPONSE_BYTES + 1
        );
        assert_eq!(
            fetch_json(local_response(declared.into_bytes()).await)
                .await
                .unwrap_err(),
            SOURCE_ERROR
        );
        let mut chunked = format!(
            "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n{:x}\r\n",
            MAX_RESPONSE_BYTES + 1
        )
        .into_bytes();
        chunked.resize(chunked.len() + MAX_RESPONSE_BYTES + 1, b'a');
        chunked.extend_from_slice(b"\r\n0\r\n\r\n");
        assert_eq!(
            fetch_json(local_response(chunked).await).await.unwrap_err(),
            SOURCE_ERROR
        );
    }

    #[tokio::test]
    async fn transport_does_not_follow_redirects_or_return_provider_body() {
        let target = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let redirect = format!("HTTP/1.1 302 Found\r\nLocation: http://{}/leak\r\nContent-Length: 0\r\nConnection: close\r\n\r\n", target.local_addr().unwrap());
        let error = fetch_json(local_response(redirect.into_bytes()).await)
            .await
            .unwrap_err();
        assert!(error.starts_with("youtube_request_failed:"));
        assert!(
            tokio::time::timeout(Duration::from_millis(50), target.accept())
                .await
                .is_err()
        );
        let body = json!({"error":{"message":"fixture-private-value","errors":[{"reason":"quotaExceeded"}]}}).to_string();
        let raw = format!("HTTP/1.1 403 Forbidden\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
        let error = fetch_json(local_response(raw.into_bytes()).await)
            .await
            .unwrap_err();
        assert!(error.starts_with("youtube_quota_exceeded:"));
        assert!(!error.contains("fixture-private-value"));
    }
}
