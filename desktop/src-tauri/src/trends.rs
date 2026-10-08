use crate::config::AppConfig;
use crate::models::{SocialTrend, TrendDetails};
use chrono::{DateTime, Duration as ChronoDuration, NaiveDate, SecondsFormat, Utc};
use futures_util::StreamExt;
use quick_xml::{events::Event, Reader};
use reqwest::{Client, RequestBuilder};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::time::Duration;
use url::Url;

const MAX_RESPONSE_BYTES: usize = 2_000_000;
const MAX_PREVIEW_CHARS: usize = 1_200;
const SOURCE_ERROR: &str = "트렌드 제공처의 응답을 읽을 수 없습니다.";

pub struct TrendCollection {
    pub trends: Vec<SocialTrend>,
    pub warnings: Vec<String>,
}

fn http_client() -> Result<Client, String> {
    Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(3))
        .timeout(Duration::from_secs(12))
        .user_agent("TorisStudioDesktop/0.1")
        .no_proxy()
        .build()
        .map_err(|_| SOURCE_ERROR.into())
}

// One bounded attempt per source. Repeated polling is controlled by the caller's cooldown;
// automatic retries would silently spend official API quota and duplicate observations.
async fn bounded_response(request: RequestBuilder) -> Result<String, String> {
    let response = request.send().await.map_err(|_| SOURCE_ERROR.to_string())?;
    if !response.status().is_success()
        || response
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
    if bytes.is_empty() {
        return Err(SOURCE_ERROR.into());
    }
    String::from_utf8(bytes).map_err(|_| SOURCE_ERROR.into())
}

fn short(value: &str, max: usize) -> String {
    value
        .trim()
        .chars()
        .filter(|c| *c != '\0')
        .take(max)
        .collect()
}
fn text(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(value)) => value.clone(),
        Some(Value::Number(value)) => value.to_string(),
        _ => String::new(),
    }
}
fn time(raw: &str) -> Option<String> {
    DateTime::parse_from_rfc3339(raw)
        .or_else(|_| DateTime::parse_from_rfc2822(raw))
        .ok()
        .map(|time| {
            time.with_timezone(&Utc)
                .to_rfc3339_opts(SecondsFormat::Millis, true)
        })
}
pub fn stable_trend_id(source: &str, url: &str, keyword: &str) -> String {
    let digest = Sha256::digest(format!("{source}\n{url}\n{keyword}").as_bytes());
    format!("{digest:x}").chars().take(40).collect()
}

fn google_field(stack: &[String]) -> Option<&str> {
    if stack.get(1).map(String::as_str) != Some("channel")
        || stack.get(2).map(String::as_str) != Some("item")
    {
        return None;
    }
    match stack.len() {
        4 if matches!(
            stack[3].as_str(),
            "title" | "pubDate" | "ht:approx_traffic" | "description"
        ) =>
        {
            Some(&stack[3])
        }
        5 if stack[3] == "ht:news_item"
            && matches!(
                stack[4].as_str(),
                "ht:news_item_title" | "ht:news_item_snippet"
            ) =>
        {
            Some(&stack[4])
        }
        _ => None,
    }
}

fn append_google_field(fields: &mut HashMap<String, String>, stack: &[String], value: &str) {
    if let Some(name) = google_field(stack) {
        fields.entry(name.into()).or_default().push_str(value);
    }
}

fn google_description(fields: &HashMap<String, String>) -> Option<String> {
    ["description", "ht:news_item_snippet"]
        .iter()
        .find_map(|field| fields.get(*field).and_then(|raw| html_preview(raw)))
        .or_else(|| {
            // The current feed often supplies empty summaries. Its related-news titles
            // remain useful context, but must not be presented as an article summary.
            fields
                .get("ht:news_item_title")
                .and_then(|raw| html_preview(raw))
                .and_then(|titles| preview_text(&format!("관련 뉴스: {titles}")))
        })
}

pub fn parse_google_trends(xml: &str, fetched_at: &str) -> Result<Vec<SocialTrend>, String> {
    if xml.len() > MAX_RESPONSE_BYTES
        || xml.to_ascii_lowercase().contains("<!doctype")
        || xml.to_ascii_lowercase().contains("<!entity")
    {
        return Err(SOURCE_ERROR.into());
    }
    let mut reader = Reader::from_str(xml);
    reader.config_mut().check_end_names = true;
    let mut stack: Vec<String> = vec![];
    let mut fields: HashMap<String, String> = HashMap::new();
    let mut trends = vec![];
    let mut root_seen = false;
    let mut channel_seen = false;
    loop {
        match reader.read_event().map_err(|_| SOURCE_ERROR.to_string())? {
            Event::Start(start) => {
                let name = String::from_utf8_lossy(start.name().as_ref()).into_owned();
                if stack.is_empty() {
                    if name != "rss" || root_seen {
                        return Err(SOURCE_ERROR.into());
                    }
                    root_seen = true;
                }
                if stack.len() == 1 && name == "channel" {
                    channel_seen = true;
                }
                if stack.len() == 2 && stack[1] == "channel" && name == "item" {
                    fields.clear();
                }
                stack.push(name);
                if stack.len() > 32 {
                    return Err(SOURCE_ERROR.into());
                }
                if let Some(field) = google_field(&stack) {
                    if matches!(field, "ht:news_item_title" | "ht:news_item_snippet") {
                        if let Some(previous) = fields.get_mut(field).filter(|raw| !raw.is_empty())
                        {
                            previous.push_str(" · ");
                        }
                    }
                }
            }
            Event::Text(raw) => {
                let text = raw.decode().map_err(|_| SOURCE_ERROR.to_string())?;
                let decoded =
                    quick_xml::escape::unescape(&text).map_err(|_| SOURCE_ERROR.to_string())?;
                if stack.is_empty() && !decoded.trim().is_empty() {
                    return Err(SOURCE_ERROR.into());
                }
                append_google_field(&mut fields, &stack, &decoded);
            }
            Event::CData(raw) => {
                let decoded =
                    std::str::from_utf8(raw.as_ref()).map_err(|_| SOURCE_ERROR.to_string())?;
                append_google_field(&mut fields, &stack, decoded);
            }
            Event::GeneralRef(raw) => {
                let name = raw.decode().map_err(|_| SOURCE_ERROR.to_string())?;
                let escaped = format!("&{name};");
                let decoded =
                    quick_xml::escape::unescape(&escaped).map_err(|_| SOURCE_ERROR.to_string())?;
                append_google_field(&mut fields, &stack, &decoded);
            }
            Event::End(end) => {
                let name = String::from_utf8_lossy(end.name().as_ref()).into_owned();
                if stack.last().map_or(true, |last| last != &name) {
                    return Err(SOURCE_ERROR.into());
                }
                if stack.len() == 3 && stack[1] == "channel" && name == "item" && trends.len() < 50
                {
                    let keyword = short(fields.get("title").map(String::as_str).unwrap_or(""), 100);
                    if !keyword.is_empty() {
                        let mut link = Url::parse("https://trends.google.com/trends/explore")
                            .map_err(|_| SOURCE_ERROR.to_string())?;
                        link.query_pairs_mut()
                            .append_pair("geo", "KR")
                            .append_pair("q", &keyword);
                        let link = link.to_string();
                        let traffic = short(
                            fields
                                .get("ht:approx_traffic")
                                .map(String::as_str)
                                .unwrap_or(""),
                            80,
                        );
                        let mut details = TrendDetails::discovery("google_trending");
                        details.description = google_description(&fields);
                        trends.push(SocialTrend {
                            id: stable_trend_id("google_trends", &link, &keyword),
                            source: "google_trends".into(),
                            title: keyword.clone(),
                            keyword,
                            url: link,
                            metric: (!traffic.is_empty())
                                .then(|| format!("{traffic} 검색 (Google 추정치)")),
                            region: "KR".into(),
                            published_at: fields.get("pubDate").and_then(|raw| time(raw)),
                            fetched_at: fetched_at.into(),
                            details: Some(details),
                        });
                    }
                }
                stack.pop();
            }
            Event::DocType(_) => return Err(SOURCE_ERROR.into()),
            Event::Empty(empty) => {
                if stack.is_empty() || empty.name().as_ref() == b"channel" {
                    return Err(SOURCE_ERROR.into());
                }
            }
            Event::Eof => break,
            _ => (),
        }
    }
    if !root_seen || !channel_seen || !stack.is_empty() {
        return Err(SOURCE_ERROR.into());
    }
    Ok(trends)
}

fn count(value: Option<&Value>) -> Option<i64> {
    let raw = text(value);
    if raw.is_empty() || !raw.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    raw.parse::<i64>()
        .ok()
        .filter(|count| *count <= 9_007_199_254_740_991)
}

pub fn parse_iso_duration(raw: &str) -> Option<f64> {
    if !raw.starts_with('P') {
        return None;
    }
    let mut total = 0.0;
    let mut number = String::new();
    let mut in_time = false;
    let mut seen_number = false;
    let mut last_order = 0;
    for ch in raw[1..].chars() {
        if ch == 'T' && !in_time && number.is_empty() {
            in_time = true;
            continue;
        }
        if ch.is_ascii_digit() || ch == '.' {
            number.push(ch);
            continue;
        }
        let (multiplier, order) = match (in_time, ch) {
            (false, 'D') => (86400.0, 1),
            (true, 'H') => (3600.0, 2),
            (true, 'M') => (60.0, 3),
            (true, 'S') => (1.0, 4),
            _ => return None,
        };
        if number.is_empty() || order <= last_order || (ch != 'S' && number.contains('.')) {
            return None;
        }
        let value = number.parse::<f64>().ok()?;
        if !value.is_finite() || value < 0.0 {
            return None;
        }
        total += value * multiplier;
        last_order = order;
        seen_number = true;
        number.clear();
    }
    (number.is_empty() && seen_number && total.is_finite()).then_some(total)
}

fn video_id(raw: &str) -> bool {
    raw.len() == 11
        && raw
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
}

pub fn parse_youtube_videos(
    payload: &Value,
    fetched_at: &str,
    keyword: Option<&str>,
    channels: Option<&Value>,
) -> Result<Vec<SocialTrend>, String> {
    let items = payload
        .get("items")
        .and_then(Value::as_array)
        .ok_or_else(|| SOURCE_ERROR.to_string())?;
    let mut subscribers = HashMap::new();
    if let Some(channels) = channels
        .and_then(|value| value.get("items"))
        .and_then(Value::as_array)
    {
        for channel in channels {
            let stats = &channel["statistics"];
            if stats["hiddenSubscriberCount"] != Value::Bool(true) {
                if let Some(total) = count(stats.get("subscriberCount")) {
                    subscribers.insert(text(channel.get("id")), total);
                }
            }
        }
    }
    let mut trends = vec![];
    let mut seen = HashSet::new();
    for item in items.iter().take(50) {
        let id = text(item.get("id"));
        let title = short(&text(item["snippet"].get("title")), 300);
        if !video_id(&id) || title.is_empty() || !seen.insert(id.clone()) {
            continue;
        }
        let link = format!("https://www.youtube.com/watch?v={id}");
        let key = short(keyword.unwrap_or(&title), 100);
        let views = count(item["statistics"].get("viewCount"));
        let mut details = TrendDetails::discovery(if keyword.is_some() {
            "youtube_keyword"
        } else {
            "youtube_popular"
        });
        details.description = preview_text(&text(item["snippet"].get("description")));
        details.view_count = views;
        details.subscriber_count = subscribers
            .get(&text(item["snippet"].get("channelId")))
            .copied();
        details.duration_seconds =
            parse_iso_duration(&text(item["contentDetails"].get("duration")));
        details.channel_title = Some(short(&text(item["snippet"].get("channelTitle")), 200))
            .filter(|value| !value.is_empty());
        trends.push(SocialTrend {
            id: stable_trend_id("youtube", &link, &key),
            source: "youtube".into(),
            keyword: key,
            title,
            url: link,
            metric: views.map(|views| format!("{} 조회", grouped_number(views))),
            region: "KR".into(),
            published_at: time(&text(item["snippet"].get("publishedAt"))),
            fetched_at: fetched_at.into(),
            details: Some(details),
        });
    }
    trends.sort_by_key(|trend| {
        std::cmp::Reverse(
            trend
                .details
                .as_ref()
                .and_then(|details| details.view_count)
                .unwrap_or(-1),
        )
    });
    trends.truncate(10);
    Ok(trends)
}

fn grouped_number(value: i64) -> String {
    let raw = value.to_string();
    raw.chars()
        .enumerate()
        .flat_map(|(index, ch)| {
            let comma = index > 0 && (raw.len() - index) % 3 == 0;
            comma.then_some(',').into_iter().chain(std::iter::once(ch))
        })
        .collect()
}

fn decode_preview_entities(raw: &str) -> String {
    let mut decoded = String::new();
    let mut remaining = raw;
    while let Some(start) = remaining.find('&') {
        decoded.push_str(&remaining[..start]);
        remaining = &remaining[start..];
        let Some(end) = remaining.find(';').filter(|end| *end <= 32) else {
            decoded.push_str(remaining);
            return decoded;
        };
        let entity = &remaining[..=end];
        if entity == "&nbsp;" {
            decoded.push(' ');
        } else if let Ok(value) = quick_xml::escape::unescape(entity) {
            decoded.push_str(&value);
        } else {
            decoded.push_str(entity);
        }
        remaining = &remaining[end + 1..];
    }
    decoded.push_str(remaining);
    decoded
}

fn strip_markup(raw: &str) -> String {
    let decoded = decode_preview_entities(raw);
    let mut in_tag = false;
    let mut tag = String::new();
    let mut clean = String::new();
    for ch in decoded.chars() {
        match ch {
            '<' => {
                in_tag = true;
                tag.clear();
            }
            '>' if in_tag => {
                in_tag = false;
                let tag_name = tag
                    .trim_start_matches('/')
                    .split_whitespace()
                    .next()
                    .unwrap_or("")
                    .trim_end_matches('/')
                    .to_ascii_lowercase();
                if matches!(tag_name.as_str(), "br" | "p" | "div" | "li" | "ul" | "ol") {
                    clean.push(' ');
                }
            }
            _ if !in_tag => clean.push(ch),
            _ => tag.push(ch),
        }
    }
    clean
}

fn preview_text(raw: &str) -> Option<String> {
    let clean: String = raw
        .chars()
        .take(20_000)
        .filter(|ch| {
            (!ch.is_control() || ch.is_whitespace())
                && !matches!(*ch, '\u{200b}' | '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}' | '\u{feff}')
        })
        .collect();
    let normalized = clean.split_whitespace().collect::<Vec<_>>().join(" ");
    let preview: String = normalized.chars().take(MAX_PREVIEW_CHARS).collect();
    (!preview.is_empty()).then_some(preview)
}

fn html_preview(raw: &str) -> Option<String> {
    // Source excerpts are plain text in JSON and rendered as escaped text in the UI.
    let bounded: String = raw.chars().take(20_000).collect();
    preview_text(&strip_markup(&bounded))
}

fn external_https(raw: &str) -> Option<String> {
    let url = Url::parse(raw).ok()?;
    if url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.as_str().len() > 2048
        || url.port().is_some()
    {
        return None;
    }
    let host = url.host_str()?;
    if !host.contains('.')
        || matches!(host, "localhost" | "127.0.0.1")
        || host.ends_with(".localhost")
        || host.parse::<std::net::IpAddr>().is_ok()
    {
        return None;
    }
    Some(url.into())
}

pub fn parse_naver_blogs(
    payload: &Value,
    keyword: &str,
    fetched_at: &str,
) -> Result<Vec<SocialTrend>, String> {
    let items = payload
        .get("items")
        .and_then(Value::as_array)
        .ok_or_else(|| SOURCE_ERROR.to_string())?;
    let mut trends = vec![];
    for item in items.iter().take(20) {
        let Some(link) = external_https(&text(item.get("link"))) else {
            continue;
        };
        let title = short(
            &html_preview(&text(item.get("title"))).unwrap_or_default(),
            300,
        );
        if title.is_empty() {
            continue;
        }
        let raw_date = text(item.get("postdate"));
        let published_at = NaiveDate::parse_from_str(&raw_date, "%Y%m%d")
            .ok()
            .and_then(|date| time(&format!("{date}T00:00:00+09:00")));
        let mut details = TrendDetails::discovery("naver_search");
        details.description = html_preview(&text(item.get("description")));
        trends.push(SocialTrend {
            id: stable_trend_id("naver_blog", &link, keyword),
            source: "naver_blog".into(),
            keyword: short(keyword, 100),
            title,
            url: link,
            metric: None,
            region: "KR".into(),
            published_at,
            fetched_at: fetched_at.into(),
            details: Some(details),
        });
    }
    Ok(trends)
}

async fn youtube_request(
    client: &Client,
    resource: &str,
    params: &[(&str, String)],
    key: &str,
) -> Result<Value, String> {
    // Resource is selected only by native code; untrusted content cannot choose an endpoint.
    if !matches!(resource, "videos" | "channels" | "search") {
        return Err(SOURCE_ERROR.into());
    }
    let mut api_key = reqwest::header::HeaderValue::from_str(key).map_err(|_| SOURCE_ERROR)?;
    api_key.set_sensitive(true);
    let raw = bounded_response(
        client
            .get(format!("https://www.googleapis.com/youtube/v3/{resource}"))
            .query(params)
            .header("x-goog-api-key", api_key),
    )
    .await?;
    serde_json::from_str(&raw).map_err(|_| SOURCE_ERROR.into())
}

async fn collect_youtube(
    client: &Client,
    key: &str,
    fetched_at: &str,
    keyword: Option<&str>,
) -> Result<Vec<SocialTrend>, String> {
    let params = if let Some(keyword) = keyword {
        let after =
            (Utc::now() - ChronoDuration::days(60)).to_rfc3339_opts(SecondsFormat::Secs, true);
        let search = youtube_request(
            client,
            "search",
            &[
                ("part", "id".into()),
                ("type", "video".into()),
                ("q", keyword.into()),
                ("regionCode", "KR".into()),
                ("relevanceLanguage", "ko".into()),
                ("order", "viewCount".into()),
                ("publishedAfter", after),
                ("maxResults", "25".into()),
            ],
            key,
        )
        .await?;
        let items = search["items"]
            .as_array()
            .ok_or_else(|| SOURCE_ERROR.to_string())?;
        let ids: Vec<String> = items
            .iter()
            .take(25)
            .filter_map(|item| {
                let id = text(item["id"].get("videoId"));
                video_id(&id).then_some(id)
            })
            .collect();
        if ids.is_empty() {
            return Ok(vec![]);
        }
        vec![
            ("part", "snippet,statistics,contentDetails".into()),
            ("id", ids.join(",")),
        ]
    } else {
        vec![
            ("part", "snippet,statistics,contentDetails".into()),
            ("chart", "mostPopular".into()),
            ("regionCode", "KR".into()),
            ("maxResults", "25".into()),
        ]
    };
    let videos = youtube_request(client, "videos", &params, key).await?;
    let ids: Vec<String> = videos["items"]
        .as_array()
        .ok_or_else(|| SOURCE_ERROR.to_string())?
        .iter()
        .filter_map(|item| item["snippet"]["channelId"].as_str())
        .filter(|id| {
            id.len() <= 128
                && id
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
        })
        .map(str::to_string)
        .collect::<HashSet<_>>()
        .into_iter()
        .take(50)
        .collect();
    let channels = if ids.is_empty() {
        None
    } else {
        youtube_request(
            client,
            "channels",
            &[("part", "statistics".into()), ("id", ids.join(","))],
            key,
        )
        .await
        .ok()
    };
    parse_youtube_videos(&videos, fetched_at, keyword, channels.as_ref())
}

pub async fn collect(config: &AppConfig, keyword: Option<&str>) -> Result<TrendCollection, String> {
    let client = http_client()?;
    let now = Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true);
    let google = async {
        let feed =
            bounded_response(client.get("https://trends.google.com/trending/rss?geo=KR")).await?;
        let mut records = parse_google_trends(&feed, &now)?;
        if let Some(keyword) = keyword {
            let lowered = keyword.to_lowercase();
            records.retain(|item| item.keyword.to_lowercase().contains(&lowered));
        }
        Ok::<_, String>(records)
    };
    let youtube = async {
        match config
            .youtube_api_key
            .as_deref()
            .filter(|key| !key.is_empty())
        {
            Some(key) => collect_youtube(&client, key, &now, keyword).await.map(Some),
            None => Ok(None),
        }
    };
    let naver = async {
        match (
            keyword,
            config.naver_client_id.as_deref(),
            config.naver_client_secret.as_deref(),
        ) {
            (Some(keyword), Some(id), Some(secret)) if !id.is_empty() && !secret.is_empty() => {
                let raw = bounded_response(
                    client
                        .get("https://openapi.naver.com/v1/search/blog.json")
                        .query(&[("query", keyword), ("display", "20"), ("sort", "date")])
                        .header("X-Naver-Client-Id", id)
                        .header("X-Naver-Client-Secret", secret),
                )
                .await?;
                let payload: Value =
                    serde_json::from_str(&raw).map_err(|_| SOURCE_ERROR.to_string())?;
                parse_naver_blogs(&payload, keyword, &now).map(Some)
            }
            _ => Ok(None),
        }
    };
    let (google, youtube, naver) = tokio::join!(google, youtube, naver);
    let mut result = TrendCollection {
        trends: vec![],
        warnings: vec![],
    };
    for (name, records) in [
        ("Google Trends 한국 RSS", google.map(Some)),
        ("YouTube Data API", youtube),
        ("네이버 블로그 검색", naver),
    ] {
        match records {
            Ok(Some(records)) => result.trends.extend(records),
            Ok(None) => (),
            Err(_) => result.warnings.push(format!(
                "{name} 수집에 실패했습니다. 기존 관측 데이터는 유지됩니다."
            )),
        }
    }
    if keyword.is_some()
        && config.youtube_api_key.is_none()
        && (config.naver_client_id.is_none() || config.naver_client_secret.is_none())
    {
        result.warnings.push("현재 키워드는 Google 인기 목록에서만 필터링됩니다. YouTube·네이버 검색에는 로컬 API 설정이 필요합니다.".into());
    }
    result.trends.truncate(100);
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    const NOW: &str = "2026-10-08T03:00:00.000Z";

    #[test]
    fn google_rss_preserves_real_metrics_and_rejects_unsafe_or_broken_xml() {
        let xml = "<rss xmlns:ht=\"https://trends.google.com\"><channel><item><title>한글 &amp; 검색</title><ht:approx_traffic>20,000+</ht:approx_traffic><pubDate>Thu, 08 Oct 2026 10:00:00 +0900</pubDate></item></channel></rss>";
        let parsed = parse_google_trends(xml, NOW).unwrap();
        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0].keyword, "한글 & 검색");
        assert_eq!(
            parsed[0].metric.as_deref(),
            Some("20,000+ 검색 (Google 추정치)")
        );
        assert_eq!(
            parsed[0].published_at.as_deref(),
            Some("2026-10-08T01:00:00.000Z")
        );
        assert!(parse_google_trends(
            "<!DOCTYPE rss [<!ENTITY x SYSTEM 'file:///etc/passwd'>]><rss><channel/></rss>",
            NOW
        )
        .is_err());
        assert!(
            parse_google_trends("<rss><channel><item><title>broken</item></rss>", NOW).is_err()
        );
        assert!(parse_google_trends("<rss><channel>", NOW).is_err());
        assert!(parse_google_trends(&" ".repeat(MAX_RESPONSE_BYTES + 1), NOW).is_err());
    }

    #[test]
    fn google_previews_use_supplied_descriptions_or_label_actual_related_news() {
        let xml = r#"<rss xmlns:ht="https://trends.google.com/trending/rss"><channel>
            <item><title>서울 여행</title>
                <description><![CDATA[<p>서울 &amp; 도쿄</p><p>여행 비교 &#39;안내&#39;</p>]]></description>
                <ht:news_item><ht:news_item_title>보조 뉴스 제목</ht:news_item_title></ht:news_item>
            </item>
            <item><title>기술</title><description/>
                <ht:news_item><ht:news_item_title>새로운 &apos;기술&apos; 발표</ht:news_item_title><ht:news_item_snippet/></ht:news_item>
                <ht:news_item><ht:news_item_title><![CDATA[<b>산업</b> 동향]]></ht:news_item_title></ht:news_item>
            </item>
            <item><title>날씨</title><ht:news_item><ht:news_item_title>제목</ht:news_item_title>
                <ht:news_item_snippet>실제 제공된 &amp; 날씨 요약</ht:news_item_snippet></ht:news_item></item>
            <item><title>정보 없음</title><description/></item>
        </channel></rss>"#;
        let rows = parse_google_trends(xml, NOW).unwrap();
        assert_eq!(
            rows[0].details.as_ref().unwrap().description.as_deref(),
            Some("서울 & 도쿄 여행 비교 '안내'")
        );
        assert_eq!(
            rows[1].details.as_ref().unwrap().description.as_deref(),
            Some("관련 뉴스: 새로운 '기술' 발표 · 산업 동향")
        );
        assert_eq!(
            rows[2].details.as_ref().unwrap().description.as_deref(),
            Some("실제 제공된 & 날씨 요약")
        );
        assert!(rows[3].details.as_ref().unwrap().description.is_none());
    }

    #[test]
    fn youtube_uses_actual_views_and_hidden_subscribers_are_omitted() {
        let payload = serde_json::json!({"items":[
            {"id":"abcdefghijk","snippet":{"title":"적은 조회","channelId":"one"},"statistics":{"viewCount":"12"},"contentDetails":{"duration":"PT3M"}},
            {"id":"zyxwvutsrqp","snippet":{"title":"많은 조회","channelId":"two"},"statistics":{"viewCount":"10000"},"contentDetails":{"duration":"PT2M30S"}},
            {"id":"not-valid","snippet":{"title":"제외"},"statistics":{"viewCount":"99999"}}
        ]});
        let channels = serde_json::json!({"items":[{"id":"one","statistics":{"subscriberCount":"100"}},
            {"id":"two","statistics":{"subscriberCount":"900","hiddenSubscriberCount":true}}]});
        let parsed = parse_youtube_videos(&payload, NOW, Some("검색어"), Some(&channels)).unwrap();
        assert_eq!(parsed.len(), 2);
        assert_eq!(parsed[0].metric.as_deref(), Some("10,000 조회"));
        assert_eq!(parsed[0].details.as_ref().unwrap().subscriber_count, None);
        assert_eq!(
            parsed[0].details.as_ref().unwrap().duration_seconds,
            Some(150.0)
        );
        assert_eq!(
            parsed[1].details.as_ref().unwrap().subscriber_count,
            Some(100)
        );
        assert_eq!(
            parsed[0].details.as_ref().unwrap().previous_observed_at,
            None
        );
    }

    #[test]
    fn duration_parser_validates_units_and_order() {
        assert_eq!(parse_iso_duration("P1DT2H3M4.5S"), Some(93784.5));
        assert_eq!(parse_iso_duration("PT0S"), Some(0.0));
        for invalid in [
            "P", "PT", "PT1S2M", "PT1H1H", "PT1.2M", "PT-1S", "P1Y", "PTNaNS",
        ] {
            assert_eq!(parse_iso_duration(invalid), None, "{invalid}");
        }
    }

    #[test]
    fn naver_search_does_not_invent_popularity_and_rejects_local_links() {
        let payload = serde_json::json!({"items":[
            {"title":"<b>실제</b> &amp; 검색 결과","link":"https://blog.naver.com/name/123","postdate":"20261008"},
            {"title":"거부","link":"https://127.0.0.1/secret","postdate":"20261008"},
            {"title":"거부","link":"javascript:alert(1)","postdate":"20261008"}
        ]});
        let parsed = parse_naver_blogs(&payload, "검색어", NOW).unwrap();
        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0].title, "실제 & 검색 결과");
        assert!(parsed[0].metric.is_none());
        assert_eq!(
            parsed[0].published_at.as_deref(),
            Some("2026-10-07T15:00:00.000Z")
        );
    }

    #[test]
    fn source_previews_are_bounded_plain_text_and_keep_absent_fields_compatible() {
        let payload = serde_json::json!({"items":[{
            "title":"<b>검색</b>어 결과", "link":"https://blog.naver.com/name/123",
            "description":"<b>실제</b> &quot;설명&quot;&nbsp; &#xD55C;&#44544;<br>둘째 줄\u{0000}\u{001b}\u{202e}"
        }]});
        let rows = parse_naver_blogs(&payload, "검색어", NOW).unwrap();
        assert_eq!(rows[0].title, "검색어 결과");
        assert_eq!(
            rows[0].details.as_ref().unwrap().description.as_deref(),
            Some("실제 \"설명\" 한글 둘째 줄")
        );
        assert_eq!(
            html_preview("&lt;img src=x onerror=alert(1)&gt;제공 설명").as_deref(),
            Some("제공 설명")
        );
        let long = format!("{}\u{0000}", "가".repeat(5_000));
        assert_eq!(
            preview_text(&long).unwrap().chars().count(),
            MAX_PREVIEW_CHARS
        );
        assert!(html_preview("<b></b> &nbsp;\u{0000}").is_none());
        let old: TrendDetails =
            serde_json::from_value(serde_json::json!({"discovery":"google_trending"})).unwrap();
        assert!(old.description.is_none());
        assert!(serde_json::to_value(&old)
            .unwrap()
            .get("description")
            .is_none());
    }

    #[test]
    fn youtube_preview_is_the_actual_plain_snippet_description() {
        let payload = serde_json::json!({"items":[
            {"id":"abcdefghijk","snippet":{"title":"영상","description":"영상 소개 <3\n두 번째 줄\u{0000}"}},
            {"id":"zyxwvutsrqp","snippet":{"title":"설명 없음"}}
        ]});
        let rows = parse_youtube_videos(&payload, NOW, None, None).unwrap();
        assert_eq!(
            rows[0].details.as_ref().unwrap().description.as_deref(),
            Some("영상 소개 <3 두 번째 줄")
        );
        assert!(rows[1].details.as_ref().unwrap().description.is_none());
    }

    async fn mock_response(response: String) -> String {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut buffer = [0; 4096];
            let _ = socket.read(&mut buffer).await;
            let _ = socket.write_all(response.as_bytes()).await;
            let _ = socket.shutdown().await;
        });
        format!("http://{address}/fixture")
    }

    #[tokio::test]
    async fn http_rejects_redirect_and_oversize_without_exposing_secrets() {
        let client = http_client().unwrap();
        let redirect = mock_response("HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1:1/private?token=secret\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".into()).await;
        let error = bounded_response(client.get(redirect)).await.unwrap_err();
        assert_eq!(error, SOURCE_ERROR);
        assert!(!error.contains("secret"));
        let oversized = mock_response(format!(
            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            MAX_RESPONSE_BYTES + 1
        ))
        .await;
        assert!(bounded_response(client.get(oversized)).await.is_err());
        let okay = mock_response(
            "HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}".into(),
        )
        .await;
        assert_eq!(bounded_response(client.get(okay)).await.unwrap(), "{}");
    }
}
