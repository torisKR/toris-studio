//! License-cleared stock photos for production scenes: Openverse (Flickr, StockSnap, Wikimedia
//! Commons and other open-licence sources) and the Wikimedia Commons API.
//!
//! Only CC0, Public Domain Mark and CC BY are accepted. Share-alike, non-commercial and
//! no-derivatives licences are rejected, and so are broadcaster or news-agency images even when
//! a mirror labels them openly licensed. The planner only supplies English search words; every
//! request, host, size limit and licence decision is made here. Each accepted file keeps its
//! creator, source page, licence and SHA-256 so the job can credit it in provenance and the post.
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{path::Path, time::Duration};

pub const OPENVERSE: &str = "https://api.openverse.org/v1/images/";
pub const COMMONS: &str = "https://commons.wikimedia.org/w/api.php";
const USER_AGENT: &str = "TorisStudio/0.6 (+https://github.com/torisKR/toris-studio)";
/// Hosts a candidate image may be downloaded from. Anything else is dropped before download.
pub const IMAGE_HOSTS: [&str; 5] = [
    "live.staticflickr.com",
    "upload.wikimedia.org",
    "cdn.stocksnap.io",
    "images.rawpixel.com",
    "images.nasa.gov",
];
const MAX_BYTES: usize = 25 * 1024 * 1024;
const MIN_SHORT_SIDE: u32 = 480;
/// Words that mark broadcaster, news-agency or press photos (Korean public broadcasters included).
const BLOCKED_WORDS: [&str; 28] = [
    "kbs",
    "mbc",
    "sbs",
    "ebs",
    "jtbc",
    "ytn",
    "mbn",
    "tv chosun",
    "yonhap",
    "연합뉴스",
    "뉴스",
    "방송",
    "news",
    "reuters",
    "associated press",
    "afp",
    "getty",
    "bbc",
    "cnn",
    "nhk",
    "broadcast",
    "press photo",
    "screenshot",
    "screen capture",
    "television",
    "editorial",
    "shutterstock",
    "alamy",
];

/// Licences the app accepts for commercial video. Attribution is kept for every one of them.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum License {
    Cc0,
    PublicDomain,
    CcBy,
}

impl License {
    pub fn label(self, version: &str) -> String {
        match self {
            Self::Cc0 => "CC0 1.0".into(),
            Self::PublicDomain => "Public Domain".into(),
            Self::CcBy if version.is_empty() => "CC BY".into(),
            Self::CcBy => format!("CC BY {version}"),
        }
    }
    pub fn attribution_required(self) -> bool {
        self == Self::CcBy
    }
}

/// Openverse licence codes. Only the three commercial, derivative-friendly codes pass.
pub fn openverse_license(code: &str) -> Option<License> {
    match code.trim().to_ascii_lowercase().as_str() {
        "cc0" => Some(License::Cc0),
        "pdm" => Some(License::PublicDomain),
        "by" => Some(License::CcBy),
        _ => None,
    }
}

/// Commons LicenseShortName values such as "CC BY 4.0", "CC0", "Public domain", "CC BY-SA 2.0".
pub fn commons_license(short: &str) -> Option<License> {
    let s = short.trim().to_ascii_lowercase().replace('_', " ");
    if s.contains("-sa")
        || s.contains(" sa ")
        || s.contains("nc")
        || s.contains("-nd")
        || s.contains("gfdl")
        || s.contains("fair use")
    {
        return None;
    }
    if s == "cc0" || s.starts_with("cc0 ") || s.starts_with("cc-zero") {
        return Some(License::Cc0);
    }
    if s.starts_with("public domain") || s == "pd" || s.starts_with("pd-") || s.starts_with("pdm") {
        return Some(License::PublicDomain);
    }
    let by = s
        .strip_prefix("cc by")
        .or_else(|| s.strip_prefix("cc-by"))?;
    let version = by.trim_start_matches(['-', ' ']);
    if version.is_empty() || version.chars().next().is_some_and(|c| c.is_ascii_digit()) {
        Some(License::CcBy)
    } else {
        None
    }
}

/// True when any visible metadata names a broadcaster, news agency or press source.
pub fn blocked_source(texts: &[&str]) -> bool {
    texts.iter().any(|text| {
        let lower = text.to_lowercase();
        BLOCKED_WORDS.iter().any(|word| contains_word(&lower, word))
    })
}

fn contains_word(text: &str, word: &str) -> bool {
    // Short Latin acronyms must stand alone ("kbs" but not "kbsomething"); Hangul matches anywhere.
    if !word.is_ascii() || word.len() > 4 {
        return text.contains(word);
    }
    text.match_indices(word).any(|(at, _)| {
        let before = text[..at]
            .chars()
            .next_back()
            .is_none_or(|c| !c.is_alphanumeric());
        let after = text[at + word.len()..]
            .chars()
            .next()
            .is_none_or(|c| !c.is_alphanumeric());
        before && after
    })
}

/// Planner search words: lower-case ASCII letters, digits, spaces and hyphens, 2-80 chars.
pub fn clean_query(raw: &str) -> Option<String> {
    let query: String = raw
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' {
                c.to_ascii_lowercase()
            } else {
                ' '
            }
        })
        .collect::<String>()
        .split_whitespace()
        .take(8)
        .collect::<Vec<_>>()
        .join(" ");
    (2..=80).contains(&query.len()).then_some(query)
}

/// The image URL must be https on a known image host with no credentials or odd ports.
pub fn allowed_image_url(raw: &str) -> Option<url::Url> {
    let parsed = url::Url::parse(raw).ok()?;
    let host = parsed.host_str()?.to_ascii_lowercase();
    (parsed.scheme() == "https"
        && parsed.username().is_empty()
        && parsed.password().is_none()
        && parsed.port().is_none()
        && IMAGE_HOSTS.contains(&host.as_str()))
    .then_some(parsed)
}

fn plain(text: &str, max: usize) -> String {
    let mut out = String::new();
    let mut in_tag = false;
    for c in text.chars() {
        match c {
            '<' => in_tag = true,
            '>' => in_tag = false,
            c if !in_tag && !c.is_control() => out.push(c),
            _ => {}
        }
    }
    let decoded = out
        .replace("&amp;", "&")
        .replace("&quot;", "\"")
        .replace("&#039;", "'")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&nbsp;", " ");
    decoded
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(max)
        .collect()
}

fn page_url(raw: &str) -> String {
    url::Url::parse(raw)
        .ok()
        .filter(|u| u.scheme() == "https" || u.scheme() == "http")
        .map(|u| u.to_string())
        .unwrap_or_default()
}

/// Openverse result → candidate, or None when licence, host, size or source fails.
pub fn openverse_candidate(item: &Value) -> Option<Value> {
    let license = openverse_license(item["license"].as_str()?)?;
    let version = item["license_version"].as_str().unwrap_or("");
    let url = allowed_image_url(item["url"].as_str()?)?;
    let (width, height) = (
        item["width"].as_u64().unwrap_or(0) as u32,
        item["height"].as_u64().unwrap_or(0) as u32,
    );
    if width.min(height) < MIN_SHORT_SIDE {
        return None;
    }
    let title = plain(item["title"].as_str().unwrap_or(""), 140);
    let creator = plain(item["creator"].as_str().unwrap_or(""), 100);
    let source = plain(item["source"].as_str().unwrap_or(""), 40);
    let tags: Vec<String> = item["tags"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|t| t["name"].as_str())
        .map(|t| plain(t, 40))
        .take(12)
        .collect();
    let tag_text = tags.join(" ");
    if item["mature"] == true
        || blocked_source(&[
            &title,
            &creator,
            &tag_text,
            item["foreign_landing_url"].as_str().unwrap_or(""),
        ])
    {
        return None;
    }
    Some(json!({
        "id": format!("ov-{}", plain(item["id"].as_str().unwrap_or(""), 60)),
        "provider": "openverse", "source": source, "licenseCode": item["license"].as_str().unwrap_or("").to_ascii_lowercase(), "title": title, "creator": if creator.is_empty() { "작성자 미상".to_owned() } else { creator },
        "license": license.label(version), "licenseUrl": page_url(item["license_url"].as_str().unwrap_or("")),
        "attributionRequired": license.attribution_required(), "page": page_url(item["foreign_landing_url"].as_str().unwrap_or("")),
        "url": url.to_string(), "width": width, "height": height,
    }))
}

/// Commons imageinfo page → candidate (thumbnail at 1600px when the original is larger).
pub fn commons_candidate(page: &Value) -> Option<Value> {
    let info = page["imageinfo"].as_array()?.first()?;
    let meta = &info["extmetadata"];
    let field = |key: &str| meta[key]["value"].as_str().unwrap_or("");
    let license = commons_license(field("LicenseShortName"))?;
    if !field("Restrictions").trim().is_empty() {
        return None;
    }
    let mime = info["mime"].as_str().unwrap_or("");
    if !["image/jpeg", "image/png", "image/webp"].contains(&mime) {
        return None;
    }
    let link = info["thumburl"].as_str().or(info["url"].as_str())?;
    let url = allowed_image_url(link)?;
    // Commons reports the requested thumbnail size even when the original is smaller and the
    // "thumbnail" is the original file, so the real size is the smaller of the two.
    let pick = |thumb: &str, original: &str| {
        let original = info[original].as_u64().unwrap_or(0);
        info[thumb].as_u64().map_or(original, |t| t.min(original)) as u32
    };
    let (width, height) = (pick("thumbwidth", "width"), pick("thumbheight", "height"));
    if width.min(height) < MIN_SHORT_SIDE {
        return None;
    }
    let title = plain(field("ObjectName"), 140);
    let creator = plain(field("Artist"), 100);
    let credit = plain(field("Credit"), 140);
    if blocked_source(&[
        &title,
        &creator,
        &credit,
        page["title"].as_str().unwrap_or(""),
    ]) {
        return None;
    }
    let version = field("LicenseShortName")
        .split_whitespace()
        .last()
        .filter(|v| v.chars().next().is_some_and(|c| c.is_ascii_digit()))
        .unwrap_or("");
    Some(json!({
        "id": format!("wm-{}", page["pageid"].as_u64().unwrap_or(0)),
        "provider": "wikimedia", "source": "wikimedia", "licenseCode": match license { License::Cc0 => "cc0", License::PublicDomain => "pdm", License::CcBy => "by" }, "title": if title.is_empty() { plain(page["title"].as_str().unwrap_or(""), 140) } else { title },
        "creator": if creator.is_empty() { "작성자 미상".to_owned() } else { creator },
        "license": license.label(version), "licenseUrl": page_url(field("LicenseUrl")),
        "attributionRequired": license.attribution_required(), "page": page_url(info["descriptionurl"].as_str().unwrap_or("")),
        "url": url.to_string(), "width": width, "height": height,
    }))
}

/// Licence code recorded on a candidate passes the same gate again (provenance re-checks it).
pub fn cleared(candidate: &Value) -> bool {
    candidate["licenseCode"]
        .as_str()
        .and_then(openverse_license)
        .is_some()
        && allowed_image_url(candidate["url"].as_str().unwrap_or("")).is_some()
        && !candidate["creator"].as_str().unwrap_or("").is_empty()
}

/// One credit line for the post description and provenance.
pub fn credit_line(candidate: &Value) -> String {
    let title = candidate["title"].as_str().unwrap_or("");
    let creator = candidate["creator"].as_str().unwrap_or("작성자 미상");
    let source = match candidate["source"].as_str().unwrap_or("") {
        "flickr" => "Flickr",
        "wikimedia" => "Wikimedia Commons",
        "stocksnap" => "StockSnap",
        "rawpixel" => "Rawpixel",
        "nasa" => "NASA",
        other => other,
    };
    let license = candidate["license"].as_str().unwrap_or("");
    let page = candidate["page"].as_str().unwrap_or("");
    let named = if title.is_empty() {
        String::new()
    } else {
        format!("\"{title}\" ")
    };
    format!(
        "{named}by {creator} ({source}), {license}{}",
        if page.is_empty() {
            String::new()
        } else {
            format!(" · {page}")
        }
    )
}

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::limited(3))
        .https_only(true)
        .connect_timeout(Duration::from_secs(8))
        .timeout(Duration::from_secs(40))
        .user_agent(USER_AGENT)
        .build()
        .map_err(|_| "이미지 검색 연결을 준비하지 못했습니다.".into())
}

/// Openverse occasionally drops a connection; one retry after a short pause.
async fn search_openverse(
    client: &reqwest::Client,
    query: &str,
    aspect: &str,
    limit: usize,
) -> Result<Vec<Value>, String> {
    match search_openverse_once(client, query, aspect, limit).await {
        Err(error) if !error.contains("한도") => {
            tokio::time::sleep(Duration::from_millis(1500)).await;
            search_openverse_once(client, query, aspect, limit)
                .await
                .map_err(|_| error)
        }
        other => other,
    }
}

async fn search_openverse_once(
    client: &reqwest::Client,
    query: &str,
    aspect: &str,
    limit: usize,
) -> Result<Vec<Value>, String> {
    let mut url = url::Url::parse(OPENVERSE).map_err(|_| "검색 주소 오류")?;
    url.query_pairs_mut()
        .append_pair("q", query)
        .append_pair("license", "cc0,pdm,by")
        .append_pair("mature", "false")
        .append_pair("page_size", "20")
        .append_pair("source", "flickr,stocksnap,wikimedia,rawpixel,nasa");
    if aspect == "9:16" {
        url.query_pairs_mut().append_pair("aspect_ratio", "tall");
    }
    let response = client
        .get(url)
        .send()
        .await
        .map_err(|_| "Openverse에 연결하지 못했습니다.")?;
    if response.status().as_u16() == 429 {
        return Err("Openverse 검색 한도(분당 20회)에 걸렸습니다. 잠시 뒤 다시 시도하세요.".into());
    }
    if !response.status().is_success() {
        return Err(format!(
            "Openverse 검색 실패 ({})",
            response.status().as_u16()
        ));
    }
    let body: Value = response
        .json()
        .await
        .map_err(|_| "Openverse 응답 형식 오류")?;
    Ok(body["results"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(openverse_candidate)
        .take(limit)
        .collect())
}

async fn search_commons(
    client: &reqwest::Client,
    query: &str,
    limit: usize,
) -> Result<Vec<Value>, String> {
    let mut url = url::Url::parse(COMMONS).map_err(|_| "검색 주소 오류")?;
    url.query_pairs_mut()
        .append_pair("action", "query")
        .append_pair("format", "json")
        .append_pair("generator", "search")
        .append_pair("gsrnamespace", "6")
        .append_pair("gsrsearch", &format!("{query} filetype:bitmap"))
        .append_pair("gsrlimit", "20")
        .append_pair("prop", "imageinfo")
        .append_pair("iiprop", "url|size|mime|extmetadata")
        .append_pair("iiurlwidth", "1600")
        .append_pair(
            "iiextmetadatafilter",
            "LicenseShortName|LicenseUrl|Artist|Credit|Restrictions|ObjectName",
        );
    let response = client
        .get(url)
        .send()
        .await
        .map_err(|_| "Wikimedia Commons에 연결하지 못했습니다.")?;
    if !response.status().is_success() {
        return Err(format!(
            "Wikimedia Commons 검색 실패 ({})",
            response.status().as_u16()
        ));
    }
    let body: Value = response
        .json()
        .await
        .map_err(|_| "Wikimedia Commons 응답 형식 오류")?;
    let mut pages: Vec<Value> = body["query"]["pages"]
        .as_object()
        .map(|p| p.values().cloned().collect())
        .unwrap_or_default();
    pages.sort_by_key(|p| p["index"].as_u64().unwrap_or(u64::MAX));
    Ok(pages
        .iter()
        .filter_map(commons_candidate)
        .take(limit)
        .collect())
}

/// Narrower searches return nothing more often than broader ones, so a scene tries its full words,
/// then the first two, then the last two (deduplicated).
pub fn fallback_queries(query: &str) -> Vec<String> {
    let words: Vec<&str> = query.split_whitespace().collect();
    let mut list = vec![query.to_owned()];
    if words.len() > 2 {
        list.push(words[..2].join(" "));
        list.push(words[words.len() - 2..].join(" "));
    }
    let mut seen = std::collections::HashSet::new();
    list.retain(|q| seen.insert(q.clone()));
    list
}

/// Up to `limit` candidates for one scene: Openverse first, Commons to fill, then broader words.
/// How many search words appear in a candidate's title.
pub fn relevance(candidate: &Value, words: &[&str]) -> usize {
    let title = candidate["title"].as_str().unwrap_or("").to_lowercase();
    words.iter().filter(|w| title.contains(**w)).count()
}

pub async fn search(query: &str, aspect: &str, limit: usize) -> Result<Vec<Value>, String> {
    let query = clean_query(query).ok_or("이미지 검색어는 영어 단어 2~80자로 정하세요.")?;
    let client = client()?;
    let mut found: Vec<Value> = Vec::new();
    let mut errors = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for words in fallback_queries(&query) {
        let add = |found: &mut Vec<Value>,
                   seen: &mut std::collections::HashSet<String>,
                   list: Vec<Value>| {
            for c in list {
                if seen.insert(c["url"].as_str().unwrap_or("").to_owned()) {
                    found.push(c);
                }
            }
        };
        match search_openverse(&client, &words, aspect, limit).await {
            Ok(list) => add(&mut found, &mut seen, list),
            Err(error) => errors.push(error),
        }
        if found.len() < limit {
            match search_commons(&client, &words, limit).await {
                Ok(list) => add(&mut found, &mut seen, list),
                Err(error) => errors.push(error),
            }
        }
        if found.len() >= limit {
            break;
        }
    }
    errors.dedup();
    // Photos whose title shares more of the search words come first (stable for ties).
    let words: Vec<&str> = query.split_whitespace().filter(|w| w.len() > 2).collect();
    found.sort_by_key(|c| std::cmp::Reverse(relevance(c, &words)));
    found.truncate(limit);
    if found.is_empty() {
        return Err(if errors.is_empty() {
            format!(
                "\"{query}\"로 상업적 이용 가능한 이미지를 찾지 못했습니다. 검색어를 바꿔 보세요."
            )
        } else {
            errors.join(" · ")
        });
    }
    Ok(found)
}

/// Downloads a candidate, checks it decodes as a real image of a usable size, and writes a JPEG.
/// The candidate must have passed the licence gate; the URL is re-checked here.
pub async fn download(candidate: &Value, target: &Path) -> Result<Value, String> {
    let url = allowed_image_url(candidate["url"].as_str().ok_or("이미지 주소가 없습니다.")?)
        .ok_or("허용하지 않은 이미지 주소입니다.")?;
    let response = client()?
        .get(url)
        .send()
        .await
        .map_err(|_| "이미지를 내려받지 못했습니다.")?;
    if !response.status().is_success() {
        return Err(format!(
            "이미지를 내려받지 못했습니다 ({}).",
            response.status().as_u16()
        ));
    }
    // Redirects must stay on an image host too.
    if allowed_image_url(response.url().as_str()).is_none() {
        return Err("이미지가 허용하지 않은 주소로 이동했습니다.".into());
    }
    if response
        .content_length()
        .is_some_and(|n| n as usize > MAX_BYTES)
    {
        return Err("이미지 파일이 25MB를 넘습니다.".into());
    }
    let mut bytes = Vec::new();
    let mut stream = response.bytes_stream();
    use futures_util::StreamExt;
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| "이미지를 끝까지 받지 못했습니다.")?;
        if bytes.len() + chunk.len() > MAX_BYTES {
            return Err("이미지 파일이 25MB를 넘습니다.".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    let image = decode_bounded(&bytes)?;
    let (width, height) = (image.width(), image.height());
    if width.min(height) < MIN_SHORT_SIDE {
        return Err("이미지 해상도가 너무 낮습니다.".into());
    }
    let mut encoded = Vec::new();
    image::DynamicImage::ImageRgb8(image.to_rgb8())
        .write_to(
            &mut std::io::Cursor::new(&mut encoded),
            image::ImageFormat::Jpeg,
        )
        .map_err(|_| "이미지를 저장 형식으로 바꾸지 못했습니다.")?;
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent).map_err(|_| "이미지 폴더를 만들 수 없습니다.")?;
    }
    let temporary = target.with_extension("part");
    std::fs::write(&temporary, &encoded).map_err(|_| "이미지를 저장할 수 없습니다.")?;
    std::fs::rename(&temporary, target).map_err(|_| "이미지를 저장할 수 없습니다.")?;
    Ok(
        json!({"width": width, "height": height, "sha256": format!("{:x}", Sha256::digest(&encoded)), "sourceSha256": format!("{:x}", Sha256::digest(&bytes))}),
    )
}

fn decode_bounded(bytes: &[u8]) -> Result<image::DynamicImage, String> {
    let mut reader = image::ImageReader::new(std::io::Cursor::new(bytes))
        .with_guessed_format()
        .map_err(|_| "이미지 형식을 알 수 없습니다.")?;
    if !matches!(
        reader.format(),
        Some(image::ImageFormat::Jpeg | image::ImageFormat::Png | image::ImageFormat::WebP)
    ) {
        return Err("JPEG·PNG·WebP 이미지만 사용할 수 있습니다.".into());
    }
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(12_000);
    limits.max_image_height = Some(12_000);
    limits.max_alloc = Some(512 * 1024 * 1024);
    reader.limits(limits);
    reader
        .decode()
        .map_err(|_| "이미지를 읽을 수 없습니다.".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_commercial_derivative_friendly_licences_pass() {
        for (code, ok) in [
            ("cc0", true),
            ("pdm", true),
            ("by", true),
            ("by-sa", false),
            ("by-nc", false),
            ("by-nd", false),
            ("by-nc-sa", false),
            ("sampling+", false),
            ("", false),
        ] {
            assert_eq!(openverse_license(code).is_some(), ok, "openverse {code}");
        }
        for (short, ok) in [
            ("CC0", true),
            ("Public domain", true),
            ("CC BY 4.0", true),
            ("CC BY 2.0", true),
            ("CC-BY-3.0", true),
            ("CC BY-SA 2.0", false),
            ("CC BY-SA 4.0", false),
            ("CC BY-NC 2.0", false),
            ("CC BY-ND 4.0", false),
            ("GFDL", false),
            ("Fair use", false),
            ("CC BY ND 4.0", false),
            ("Copyrighted", false),
        ] {
            assert_eq!(commons_license(short).is_some(), ok, "commons {short}");
        }
        assert!(License::CcBy.attribution_required() && !License::Cc0.attribution_required());
    }

    #[test]
    fn broadcaster_and_press_images_are_blocked() {
        assert!(blocked_source(&["KBS 뉴스 9 화면"]));
        assert!(blocked_source(&["Photo by Yonhap"]));
        assert!(blocked_source(&["MBC 방송 캡처"]));
        assert!(blocked_source(&["Reuters press photo"]));
        assert!(!blocked_source(&["Seoul skyline at night"]));
        assert!(
            !blocked_source(&["kbstreet market"]),
            "a short acronym must stand alone"
        );
    }

    #[test]
    fn search_words_are_plain_english_and_urls_stay_on_image_hosts() {
        assert_eq!(
            clean_query("Seoul skyline, night!").as_deref(),
            Some("seoul skyline night")
        );
        assert_eq!(
            clean_query("https://evil.example/x?q=1").as_deref(),
            Some("https evil example x q 1")
        );
        assert!(
            clean_query("서울").is_none(),
            "Korean-only words are rejected; the planner writes English"
        );
        assert!(allowed_image_url("https://live.staticflickr.com/1/2_b.jpg").is_some());
        assert!(allowed_image_url("http://live.staticflickr.com/1/2_b.jpg").is_none());
        assert!(allowed_image_url("https://evil.example/a.jpg").is_none());
        assert!(allowed_image_url("https://user:pw@upload.wikimedia.org/a.jpg").is_none());
        assert!(allowed_image_url("https://upload.wikimedia.org:8443/a.jpg").is_none());
    }

    #[test]
    fn openverse_results_keep_credit_and_drop_bad_licences_sizes_and_sources() {
        let item = |license: &str, title: &str, w: u64| {
            json!({"id": "a1", "title": title, "creator": "Payton Chung", "license": license, "license_version": "2.0",
            "license_url": "https://creativecommons.org/licenses/by/2.0/", "url": "https://live.staticflickr.com/3228/2851387909_32e7620e0e_b.jpg",
            "foreign_landing_url": "https://www.flickr.com/photos/x/2851387909", "source": "flickr", "width": w, "height": 768, "mature": false, "tags": [{"name": "city"}]})
        };
        let ok = openverse_candidate(&item("by", "Cambie big box", 1024)).unwrap();
        assert_eq!(ok["license"], "CC BY 2.0");
        assert_eq!(ok["attributionRequired"], true);
        assert_eq!(credit_line(&ok), "\"Cambie big box\" by Payton Chung (Flickr), CC BY 2.0 · https://www.flickr.com/photos/x/2851387909");
        assert!(openverse_candidate(&item("by-sa", "Cambie big box", 1024)).is_none());
        assert!(openverse_candidate(&item("by", "KBS news studio", 1024)).is_none());
        assert!(openverse_candidate(&item("by", "Tiny", 300)).is_none());
    }

    #[test]
    fn commons_pages_need_a_clean_licence_and_no_restrictions() {
        let page = |license: &str, restrictions: &str| {
            json!({"pageid": 7, "title": "File:Vancouver House - 22.jpg", "imageinfo": [{"mime": "image/jpeg",
            "thumburl": "https://upload.wikimedia.org/wikipedia/commons/thumb/4/4b/Vancouver_House_-_22.jpg/1600px-Vancouver_House_-_22.jpg", "thumbwidth": 1600, "thumbheight": 2131, "width": 3448, "height": 4592,
            "descriptionurl": "https://commons.wikimedia.org/wiki/File:Vancouver_House_-_22.jpg",
            "extmetadata": {"LicenseShortName": {"value": license}, "Artist": {"value": "<a href=\"//x\">Haatu</a>"}, "ObjectName": {"value": "Vancouver House - 22"},
                "LicenseUrl": {"value": "https://creativecommons.org/licenses/by/2.0"}, "Restrictions": {"value": restrictions}}}]})
        };
        let ok = commons_candidate(&page("CC BY 2.0", "")).unwrap();
        assert_eq!(
            (ok["creator"].as_str(), ok["license"].as_str()),
            (Some("Haatu"), Some("CC BY 2.0"))
        );
        assert!(commons_candidate(&page("CC BY-SA 4.0", "")).is_none());
        assert!(
            commons_candidate(&page("CC BY 2.0", "personality")).is_none(),
            "personality or trademark restrictions are skipped"
        );
        let mut small = page("CC BY 2.0", "");
        small["imageinfo"][0]["width"] = json!(240);
        small["imageinfo"][0]["height"] = json!(320);
        assert!(
            commons_candidate(&small).is_none(),
            "an upscaled thumbnail of a 240px original is too small"
        );
    }

    #[test]
    fn titles_with_more_search_words_rank_first() {
        let words = ["vancouver", "house", "tower"];
        assert_eq!(
            relevance(&json!({"title": "Vancouver House tower at dusk"}), &words),
            3
        );
        assert_eq!(relevance(&json!({"title": "Joy Gas Station"}), &words), 0);
    }

    #[test]
    fn broader_search_words_follow_the_full_query() {
        assert_eq!(
            fallback_queries("granville bridge vancouver"),
            vec![
                "granville bridge vancouver",
                "granville bridge",
                "bridge vancouver"
            ]
        );
        assert_eq!(fallback_queries("seoul skyline"), vec!["seoul skyline"]);
    }

    #[test]
    fn a_non_image_body_is_rejected_before_saving() {
        assert!(decode_bounded(b"<html>not an image</html>").is_err());
    }
}
