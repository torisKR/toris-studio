use crate::config::AppConfig;
use crate::models::*;
use chrono::{DateTime, SecondsFormat, Utc};
use serde::Deserialize;
use serde_json::Value;
use std::sync::{Arc, OnceLock};
use std::time::Duration;
use tokio::sync::{OwnedSemaphorePermit, Semaphore};
use tokio_postgres::{Client, NoTls, Row};
use url::Url;
use uuid::Uuid;

const DB_ERROR: &str = "로컬 PostgreSQL에 연결하거나 저장할 수 없습니다. OrbStack의 DB 컨테이너와 로컬 설정을 확인하세요.";
const VALIDATION_ERROR: &str =
    "입력 형식이 올바르지 않습니다. 플랫폼, 필드 이름과 글자 수를 확인하세요.";
static DB_CONNECTIONS: OnceLock<Arc<Semaphore>> = OnceLock::new();

pub(crate) struct DbSession {
    pub(crate) client: Client,
    connection: tokio::task::JoinHandle<()>,
    _permit: OwnedSemaphorePermit,
}

impl Drop for DbSession {
    fn drop(&mut self) {
        self.connection.abort();
    }
}

pub(crate) async fn database(config: &AppConfig) -> Result<DbSession, String> {
    let raw = config
        .database_url
        .as_deref()
        .ok_or_else(|| DB_ERROR.to_string())?;
    let url = Url::parse(raw).map_err(|_| DB_ERROR.to_string())?;
    // Passwords remain in native memory. Remote databases and privileged accounts are rejected.
    if !matches!(url.scheme(), "postgres" | "postgresql")
        || !matches!(
            url.host_str(),
            Some("localhost" | "127.0.0.1" | "[::1]" | "::1")
        )
        || url.username() != "toris_app"
        || url.password().map_or(true, str::is_empty)
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(DB_ERROR.into());
    }
    let permit = tokio::time::timeout(
        Duration::from_secs(3),
        DB_CONNECTIONS
            .get_or_init(|| Arc::new(Semaphore::new(8)))
            .clone()
            .acquire_owned(),
    )
    .await
    .map_err(|_| DB_ERROR.to_string())?
    .map_err(|_| DB_ERROR.to_string())?;
    let mut pg: tokio_postgres::Config = raw.parse().map_err(|_| DB_ERROR.to_string())?;
    pg.application_name("toris-studio-rust");
    pg.connect_timeout(Duration::from_secs(3));
    pg.options("-c statement_timeout=5000 -c lock_timeout=2000 -c idle_in_transaction_session_timeout=10000");
    let (client, connection) = tokio::time::timeout(Duration::from_secs(3), pg.connect(NoTls))
        .await
        .map_err(|_| DB_ERROR.to_string())?
        .map_err(|_| DB_ERROR.to_string())?;
    let connection = tokio::spawn(async move {
        if connection.await.is_err() {
            eprintln!("{{\"event\":\"social.database.connection_error\",\"code\":\"DATABASE_UNAVAILABLE\"}}");
        }
    });
    Ok(DbSession {
        client,
        connection,
        _permit: permit,
    })
}

fn timestamp(value: DateTime<Utc>) -> String {
    value.to_rfc3339_opts(SecondsFormat::Millis, true)
}
fn db_result<T>(result: Result<T, tokio_postgres::Error>) -> Result<T, String> {
    result.map_err(|_| DB_ERROR.to_string())
}

fn channel(row: &Row) -> Result<SocialChannel, String> {
    Ok(SocialChannel {
        id: db_result(row.try_get::<_, Uuid>("id"))?.to_string(),
        platform: db_result(row.try_get("platform"))?,
        name: db_result(row.try_get("name"))?,
        handle: db_result(row.try_get("handle"))?,
        url: db_result(row.try_get("url"))?,
        created_at: timestamp(db_result(row.try_get("created_at"))?),
    })
}

fn content(row: &Row) -> Result<SocialContent, String> {
    Ok(SocialContent {
        id: db_result(row.try_get::<_, Uuid>("id"))?.to_string(),
        platform: db_result(row.try_get("platform"))?,
        channel_id: db_result(row.try_get::<_, Option<Uuid>>("channel_id"))?
            .map(|id| id.to_string()),
        title: db_result(row.try_get("title"))?,
        body: db_result(row.try_get("body"))?,
        status: db_result(row.try_get("status"))?,
        scheduled_at: db_result(row.try_get::<_, Option<DateTime<Utc>>>("scheduled_at"))?
            .map(timestamp),
        url: db_result(row.try_get("url"))?,
        created_at: timestamp(db_result(row.try_get("created_at"))?),
        updated_at: timestamp(db_result(row.try_get("updated_at"))?),
    })
}

fn trend(row: &Row) -> Result<SocialTrend, String> {
    let details: Value = db_result(row.try_get("details"))?;
    Ok(SocialTrend {
        id: db_result(row.try_get("id"))?,
        source: db_result(row.try_get("source"))?,
        keyword: db_result(row.try_get("keyword"))?,
        title: db_result(row.try_get("title"))?,
        url: db_result(row.try_get("url"))?,
        metric: db_result(row.try_get("metric"))?,
        region: "KR".into(),
        published_at: db_result(row.try_get::<_, Option<DateTime<Utc>>>("published_at"))?
            .map(timestamp),
        fetched_at: timestamp(db_result(row.try_get("fetched_at"))?),
        details: serde_json::from_value(details).ok(),
    })
}

fn integration(
    id: &str,
    name: &str,
    status: &str,
    message: &str,
    capabilities: &[&str],
) -> SocialIntegration {
    SocialIntegration {
        id: id.into(),
        name: name.into(),
        status: status.into(),
        message: message.into(),
        capabilities: capabilities.iter().map(|item| (*item).into()).collect(),
    }
}

fn integrations(config: &AppConfig) -> Vec<SocialIntegration> {
    let youtube = config
        .youtube_api_key
        .as_deref()
        .is_some_and(|v| !v.is_empty());
    let naver = config
        .naver_client_id
        .as_deref()
        .is_some_and(|v| !v.is_empty())
        && config
            .naver_client_secret
            .as_deref()
            .is_some_and(|v| !v.is_empty());
    vec![
        integration("google_trends", "Google Trends 한국", "ready",
            "공개 RSS의 실제 검색 추정치를 Rust로 수집합니다. 현재 인기 키워드를 제공합니다.", &["인기 키워드 RSS"]),
        integration("youtube", "YouTube", if youtube { "ready" } else { "unconfigured" },
            if youtube { "한국 인기 영상과 최근 60일 키워드 검색을 실제 조회수로 정렬합니다. 180초 이하 영상은 Shorts 후보이며 형식이 확정되지 않습니다." }
            else { "채널·초안 관리를 지원합니다. 인기 영상·키워드 검색에는 로컬 YOUTUBE_DATA_API_KEY 설정이 필요합니다." },
            &["채널 관리", "콘텐츠 계획", "인기 영상", "키워드 검색 TOP 10", "일별 실제 조회수 관측"]),
        integration("naver_blog", "네이버 블로그", if naver { "ready" } else { "unconfigured" },
            if naver { "검색어로 최신 블로그 글을 조회합니다. 검색 결과에는 조회수나 인기도 순위가 없습니다." }
            else { "채널·초안 관리를 지원합니다. 검색에는 로컬 NAVER_CLIENT_ID와 NAVER_CLIENT_SECRET 설정이 필요합니다." },
            &["채널 관리", "콘텐츠 계획", "블로그 검색"]),
        integration("threads", "Threads", "manual", "로컬 초안·예약 계획·게시 URL 기록을 지원합니다. 자동 게시는 연결되어 있지 않습니다.",
            &["채널 관리", "콘텐츠 계획", "게시 URL 기록"]),
        integration("tiktok", "TikTok", "manual", "로컬 초안·예약 계획·게시 URL 기록을 지원합니다. 자동 게시·인기 순위 API는 연결되어 있지 않습니다.",
            &["채널 관리", "콘텐츠 계획", "게시 URL 기록"]),
        integration("instagram", "Instagram", "manual", "로컬 초안·예약 계획·게시 URL 기록을 지원합니다. 자동 게시·인기 순위 API는 연결되어 있지 않습니다.",
            &["채널 관리", "콘텐츠 계획", "게시 URL 기록"]),
    ]
}

pub async fn dashboard(config: &AppConfig) -> Result<SocialDashboard, String> {
    let mut result = SocialDashboard {
        channels: vec![],
        content: vec![],
        trends: vec![],
        integrations: integrations(config),
        database: DatabaseState {
            connected: false,
            message: DB_ERROR.into(),
        },
    };
    let records = async {
        let db = database(config).await?;
        let (channels, contents, trends) = tokio::try_join!(
            db.client.query(
                "SELECT * FROM social_channels ORDER BY created_at DESC LIMIT 200",
                &[]
            ),
            db.client.query(
                "SELECT * FROM social_content ORDER BY updated_at DESC LIMIT 200",
                &[]
            ),
            db.client.query(
                "SELECT * FROM social_trends ORDER BY fetched_at DESC, keyword ASC LIMIT 100",
                &[]
            ),
        )
        .map_err(|_| DB_ERROR.to_string())?;
        Ok::<_, String>((
            channels
                .iter()
                .map(channel)
                .collect::<Result<Vec<_>, _>>()?,
            contents
                .iter()
                .map(content)
                .collect::<Result<Vec<_>, _>>()?,
            trends.iter().map(trend).collect::<Result<Vec<_>, _>>()?,
        ))
    }
    .await;
    if let Ok((channels, content, trends)) = records {
        result.channels = channels;
        result.content = content;
        result.trends = trends;
        result.database = DatabaseState {
            connected: true,
            message: "로컬 PostgreSQL에 저장됩니다. 처리와 DB 접근은 Rust에서 실행됩니다.".into(),
        };
    }
    Ok(result)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ChannelInput {
    platform: String,
    name: String,
    #[serde(default)]
    handle: String,
    url: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ContentInput {
    platform: String,
    channel_id: Option<String>,
    title: String,
    body: String,
    status: String,
    scheduled_at: Option<String>,
    url: Option<String>,
}

fn bounded_text(value: &str, max: usize, required: bool, trim: bool) -> Result<String, String> {
    let value = if trim { value.trim() } else { value };
    if (required && value.is_empty()) || value.chars().count() > max || value.contains('\0') {
        return Err(VALIDATION_ERROR.into());
    }
    Ok(value.into())
}

pub fn validate_platform_url(platform: &str, value: &str) -> Result<String, String> {
    let value = bounded_text(value, 2048, true, true)?;
    let url =
        Url::parse(&value).map_err(|_| "올바른 HTTPS 플랫폼 주소를 입력하세요.".to_string())?;
    let hosts: &[&str] = match platform {
        "youtube" => &[
            "youtube.com",
            "www.youtube.com",
            "m.youtube.com",
            "youtu.be",
        ],
        "threads" => &[
            "threads.net",
            "www.threads.net",
            "threads.com",
            "www.threads.com",
        ],
        "naver_blog" => &["blog.naver.com", "m.blog.naver.com"],
        "tiktok" => &[
            "tiktok.com",
            "www.tiktok.com",
            "m.tiktok.com",
            "vm.tiktok.com",
            "vt.tiktok.com",
        ],
        "instagram" => &["instagram.com", "www.instagram.com", "m.instagram.com"],
        _ => return Err(VALIDATION_ERROR.into()),
    };
    if url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some_and(|port| port != 443)
        || !url.host_str().is_some_and(|host| hosts.contains(&host))
        || url.as_str().len() > 2048
    {
        return Err("플랫폼과 일치하는 공식 HTTPS 주소를 입력하세요. 인증 정보와 임의 포트는 허용되지 않습니다.".into());
    }
    Ok(url.into())
}

fn validate_channel(input: &Value) -> Result<ChannelInput, String> {
    let mut data: ChannelInput =
        serde_json::from_value(input.clone()).map_err(|_| VALIDATION_ERROR.to_string())?;
    if !SOCIAL_PLATFORMS.contains(&data.platform.as_str()) {
        return Err(VALIDATION_ERROR.into());
    }
    data.name = bounded_text(&data.name, 120, true, true)?;
    data.handle = bounded_text(&data.handle, 200, false, true)?;
    data.url = validate_platform_url(&data.platform, &data.url)?;
    Ok(data)
}

fn validate_content(input: &Value) -> Result<ContentInput, String> {
    let mut data: ContentInput =
        serde_json::from_value(input.clone()).map_err(|_| VALIDATION_ERROR.to_string())?;
    if !SOCIAL_PLATFORMS.contains(&data.platform.as_str())
        || !CONTENT_STATUSES.contains(&data.status.as_str())
    {
        return Err(VALIDATION_ERROR.into());
    }
    data.title = bounded_text(&data.title, 300, true, true)?;
    data.body = bounded_text(&data.body, 30000, false, false)?;
    data.channel_id = data.channel_id.filter(|value| !value.is_empty());
    if data
        .channel_id
        .as_deref()
        .is_some_and(|value| Uuid::parse_str(value).is_err())
    {
        return Err(VALIDATION_ERROR.into());
    }
    data.scheduled_at = data.scheduled_at.filter(|value| !value.is_empty());
    if let Some(raw) = &data.scheduled_at {
        DateTime::parse_from_rfc3339(raw)
            .map_err(|_| "예약 시간에는 시간대가 있는 RFC3339 날짜를 입력하세요.".to_string())?;
    }
    data.url = data
        .url
        .filter(|value| !value.trim().is_empty())
        .map(|value| validate_platform_url(&data.platform, &value))
        .transpose()?;
    if data.status == "scheduled" && data.scheduled_at.is_none() {
        return Err("예약 관리에는 시간을 입력하세요.".into());
    }
    if data.status == "published" && data.url.is_none() {
        return Err("게시 완료 기록에는 게시물 URL이 필요합니다.".into());
    }
    Ok(data)
}

pub async fn create_channel(config: &AppConfig, input: &Value) -> Result<SocialChannel, String> {
    let data = validate_channel(input)?;
    let db = database(config).await?;
    let id = Uuid::new_v4();
    let row = db_result(db.client.query_one(
        "INSERT INTO social_channels(id,platform,name,handle,url) VALUES($1,$2,$3,$4,$5) RETURNING *",
        &[&id, &data.platform, &data.name, &data.handle, &data.url]).await)?;
    channel(&row)
}

async fn assert_channel(
    tx: &tokio_postgres::Transaction<'_>,
    id: Option<Uuid>,
    platform: &str,
) -> Result<(), String> {
    if let Some(id) = id {
        if db_result(
            tx.query_opt(
                "SELECT id FROM social_channels WHERE id=$1 AND platform=$2 FOR KEY SHARE",
                &[&id, &platform],
            )
            .await,
        )?
        .is_none()
        {
            return Err("채널과 플랫폼이 일치하지 않습니다.".into());
        }
    }
    Ok(())
}

fn parsed_fields(data: &ContentInput) -> Result<(Option<Uuid>, Option<DateTime<Utc>>), String> {
    let channel_id = data
        .channel_id
        .as_deref()
        .map(Uuid::parse_str)
        .transpose()
        .map_err(|_| VALIDATION_ERROR.to_string())?;
    let scheduled_at = data
        .scheduled_at
        .as_deref()
        .map(DateTime::parse_from_rfc3339)
        .transpose()
        .map_err(|_| VALIDATION_ERROR.to_string())?
        .map(|date| date.with_timezone(&Utc));
    Ok((channel_id, scheduled_at))
}

pub async fn create_content(config: &AppConfig, input: &Value) -> Result<SocialContent, String> {
    let data = validate_content(input)?;
    let (channel_id, scheduled_at) = parsed_fields(&data)?;
    let mut db = database(config).await?;
    let tx = db_result(db.client.transaction().await)?;
    assert_channel(&tx, channel_id, &data.platform).await?;
    let id = Uuid::new_v4();
    let row = db_result(tx.query_one(
        "INSERT INTO social_content(id,platform,channel_id,title,body,status,scheduled_at,url) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *",
        &[&id, &data.platform, &channel_id, &data.title, &data.body, &data.status, &scheduled_at, &data.url]).await)?;
    let result = content(&row)?;
    db_result(tx.commit().await)?;
    Ok(result)
}

pub async fn update_content(
    config: &AppConfig,
    id: &str,
    input: &Value,
) -> Result<SocialContent, String> {
    let id = Uuid::parse_str(id).map_err(|_| VALIDATION_ERROR.to_string())?;
    let patch = input
        .as_object()
        .filter(|object| !object.is_empty())
        .ok_or_else(|| "변경할 필드가 필요합니다.".to_string())?;
    let allowed = [
        "platform",
        "channelId",
        "title",
        "body",
        "status",
        "scheduledAt",
        "url",
    ];
    if patch.keys().any(|key| !allowed.contains(&key.as_str())) {
        return Err(VALIDATION_ERROR.into());
    }
    let mut db = database(config).await?;
    let tx = db_result(db.client.transaction().await)?;
    let current = db_result(
        tx.query_opt(
            "SELECT * FROM social_content WHERE id=$1 FOR UPDATE",
            &[&id],
        )
        .await,
    )?
    .ok_or_else(|| "콘텐츠를 찾을 수 없습니다.".to_string())?;
    let current = content(&current)?;
    let mut merged = serde_json::json!({"platform":current.platform,"channelId":current.channel_id,
        "title":current.title,"body":current.body,"status":current.status,"scheduledAt":current.scheduled_at,"url":current.url});
    let object = merged
        .as_object_mut()
        .ok_or_else(|| VALIDATION_ERROR.to_string())?;
    for (name, value) in patch {
        object.insert(name.clone(), value.clone());
    }
    let data = validate_content(&merged)?;
    let (channel_id, scheduled_at) = parsed_fields(&data)?;
    assert_channel(&tx, channel_id, &data.platform).await?;
    let row = db_result(tx.query_one(
        "UPDATE social_content SET platform=$2,channel_id=$3,title=$4,body=$5,status=$6,scheduled_at=$7,url=$8,updated_at=clock_timestamp() WHERE id=$1 RETURNING *",
        &[&id, &data.platform, &channel_id, &data.title, &data.body, &data.status, &scheduled_at, &data.url]).await)?;
    let result = content(&row)?;
    db_result(tx.commit().await)?;
    Ok(result)
}

pub(crate) async fn save_trends(
    config: &AppConfig,
    trends: &mut [SocialTrend],
) -> Result<(), String> {
    if trends.is_empty() {
        return Ok(());
    }
    let mut db = database(config).await?;
    let tx = db_result(db.client.transaction().await)?;
    for item in trends.iter_mut().take(100) {
        let fetched_at = DateTime::parse_from_rfc3339(&item.fetched_at)
            .map_err(|_| VALIDATION_ERROR.to_string())?
            .with_timezone(&Utc);
        let published_at = item
            .published_at
            .as_deref()
            .map(DateTime::parse_from_rfc3339)
            .transpose()
            .map_err(|_| VALIDATION_ERROR.to_string())?
            .map(|date| date.with_timezone(&Utc));
        let korean_day = fetched_at
            .with_timezone(
                &chrono::FixedOffset::east_opt(9 * 3600)
                    .ok_or_else(|| VALIDATION_ERROR.to_string())?,
            )
            .date_naive();
        if let Some(details) = item.details.as_mut() {
            if let Some(views) = details.view_count {
                let previous = db_result(tx.query_opt(
                    "SELECT observed_at,view_count FROM social_trend_snapshots WHERE source=$1 AND url=$2 AND observed_day<$3 ORDER BY observed_day DESC LIMIT 1",
                    &[&item.source, &item.url, &korean_day]).await)?;
                if let Some(previous) = previous {
                    details.previous_observed_at =
                        Some(timestamp(db_result(previous.try_get("observed_at"))?));
                    details.view_growth =
                        Some(views - db_result(previous.try_get::<_, i64>("view_count"))?);
                }
                db_result(tx.execute(
                    "INSERT INTO social_trend_snapshots(source,url,observed_day,observed_at,view_count) VALUES($1,$2,$3,$4,$5) ON CONFLICT(source,url,observed_day) DO NOTHING",
                    &[&item.source, &item.url, &korean_day, &fetched_at, &views]).await)?;
            }
        }
        let details =
            serde_json::to_value(&item.details).map_err(|_| VALIDATION_ERROR.to_string())?;
        db_result(tx.execute(
            "INSERT INTO social_trends(id,source,keyword,title,url,metric,region,published_at,fetched_at,details) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(source,url,keyword) DO UPDATE SET title=EXCLUDED.title,metric=EXCLUDED.metric,published_at=EXCLUDED.published_at,fetched_at=EXCLUDED.fetched_at,details=EXCLUDED.details",
            &[&item.id, &item.source, &item.keyword, &item.title, &item.url, &item.metric, &item.region, &published_at, &fetched_at, &details]).await)?;
    }
    db_result(tx.commit().await)?;
    Ok(())
}

pub async fn refresh_trends(
    config: &AppConfig,
    keyword: Option<String>,
) -> Result<TrendRefreshResult, String> {
    let keyword = keyword
        .map(|value| bounded_text(&value, 100, true, true))
        .transpose()?;
    let mut collection = crate::trends::collect(config, keyword.as_deref()).await?;
    let collected = collection.trends.len();
    let mut saved = false;
    if collected > 0 {
        match save_trends(config, &mut collection.trends).await {
            Ok(()) => saved = true,
            Err(_) => collection.warnings.push("DB 저장에 실패했습니다. 현재 수집 결과는 이번 화면에만 표시됩니다. 기존 저장 데이터는 유지됩니다.".into()),
        }
    }
    let mut dashboard = dashboard(config).await?;
    if !saved && collected > 0 {
        dashboard.trends = collection.trends;
    }
    Ok(TrendRefreshResult {
        dashboard,
        collected,
        saved,
        warnings: collection.warnings,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn platform_urls_reject_impersonation_credentials_and_cross_platform() {
        for bad in [
            "https://youtube.com.evil.example/@a",
            "https://evil.example/youtube.com",
            "http://www.youtube.com/@a",
            "https://user:secret@www.youtube.com/@a",
            "https://www.youtube.com:8443/@a",
            "https://www.instagram.com/a",
        ] {
            assert!(
                validate_platform_url("youtube", bad).is_err(),
                "accepted {bad}"
            );
        }
        for (platform, url) in [
            ("youtube", "https://www.youtube.com/@a"),
            ("threads", "https://www.threads.com/@a"),
            ("naver_blog", "https://blog.naver.com/a"),
            ("tiktok", "https://www.tiktok.com/@a"),
            ("instagram", "https://www.instagram.com/a"),
        ] {
            assert!(validate_platform_url(platform, url).is_ok());
        }
    }

    #[test]
    fn content_requires_consistent_status_and_bounded_fields() {
        let mut valid = serde_json::json!({"platform":"youtube","title":"테스트","body":"본문","status":"draft"});
        assert!(validate_content(&valid).is_ok());
        valid["status"] = "scheduled".into();
        assert!(validate_content(&valid).is_err());
        valid["scheduledAt"] = "2026-10-09T12:00:00+09:00".into();
        assert!(validate_content(&valid).is_ok());
        valid["scheduledAt"] = "2026-10-09T12:00:00".into();
        assert!(validate_content(&valid).is_err());
        valid["scheduledAt"] = Value::Null;
        valid["status"] = "published".into();
        assert!(validate_content(&valid).is_err());
        valid["url"] = "https://www.youtube.com/watch?v=abcdefghijk".into();
        assert!(validate_content(&valid).is_ok());
        valid["title"] = "가".repeat(301).into();
        assert!(validate_content(&valid).is_err());
        valid["title"] = "테스트".into();
        valid["accessToken"] = "should-never-be-stored".into();
        assert!(validate_content(&valid).is_err());
    }

    #[test]
    fn channel_rejects_unknown_token_fields() {
        assert!(validate_channel(&serde_json::json!({"platform":"threads","name":"내 채널","url":"https://www.threads.net/@name","token":"secret"})).is_err());
    }

    #[tokio::test]
    #[ignore = "requires an explicitly configured local PostgreSQL application-role test database"]
    async fn postgres_snapshots_preserve_first_korean_daily_observation_and_atomic_batches(
    ) -> Result<(), String> {
        let database_url = std::env::var("TORIS_STUDIO_TEST_DATABASE_URL")
            .map_err(|_| "Set TORIS_STUDIO_TEST_DATABASE_URL for this opt-in test.".to_string())?;
        let config = AppConfig {
            database_url: Some(database_url),
            ..Default::default()
        };
        config.validate()?;
        let marker = format!("rust-snapshot-contract-{}", Uuid::new_v4());
        let url = format!("https://www.youtube.com/watch?v=abcdefghijk&contract={marker}");
        let mut details = TrendDetails::discovery("youtube_keyword");
        details.view_count = Some(100);
        let mut first = SocialTrend {
            id: crate::trends::stable_trend_id("youtube", &url, &marker),
            source: "youtube".into(),
            keyword: marker.clone(),
            title: "Rust DB snapshot contract".into(),
            url: url.clone(),
            metric: Some("100 조회".into()),
            region: "KR".into(),
            published_at: None,
            fetched_at: "2026-10-06T14:59:00.000Z".into(),
            details: Some(details),
        };
        let outcome = async {
            save_trends(&config, std::slice::from_mut(&mut first)).await?;
            let mut repeated = first.clone();
            repeated.fetched_at = "2026-10-06T14:59:30.000Z".into();
            repeated.details.as_mut().ok_or("Missing fixture details")?.view_count = Some(130);
            save_trends(&config, std::slice::from_mut(&mut repeated)).await?;
            if repeated.details.as_ref().and_then(|details| details.view_growth).is_some() {
                return Err("Same-day observations were incorrectly reported as day growth.".into());
            }
            let mut next_day = first.clone();
            next_day.fetched_at = "2026-10-06T15:00:00.000Z".into();
            next_day.details.as_mut().ok_or("Missing fixture details")?.view_count = Some(180);
            save_trends(&config, std::slice::from_mut(&mut next_day)).await?;
            let details = next_day.details.as_ref().ok_or("Missing fixture details")?;
            if details.view_growth != Some(80) || details.previous_observed_at.as_deref() != Some("2026-10-06T14:59:00.000Z") {
                return Err("Korean day boundary or first observed timestamp was incorrect.".into());
            }
            let db = database(&config).await?;
            let snapshot = db_result(db.client.query_one(
                "SELECT count(*)::bigint AS count,min(view_count) AS first_views FROM social_trend_snapshots WHERE source='youtube' AND url=$1", &[&url]).await)?;
            if db_result(snapshot.try_get::<_, i64>("count"))? != 2 || db_result(snapshot.try_get::<_, i64>("first_views"))? != 100 {
                return Err("Daily snapshots replaced the first observation.".into());
            }
            let mut first_in_failed_batch = next_day.clone();
            first_in_failed_batch.title = "must roll back".into();
            let mut invalid = next_day.clone();
            invalid.source = "invalid_source".into();
            if save_trends(&config, &mut [first_in_failed_batch, invalid]).await.is_ok() {
                return Err("Invalid trend batch unexpectedly succeeded.".into());
            }
            let persisted = db_result(db.client.query_one("SELECT title FROM social_trends WHERE id=$1", &[&first.id]).await)?;
            if db_result(persisted.try_get::<_, String>("title"))? != "Rust DB snapshot contract" {
                return Err("Failed batch partially overwrote persisted trends.".into());
            }
            Ok::<_, String>(())
        }.await;
        let db = database(&config).await?;
        db_result(
            db.client
                .execute(
                    "DELETE FROM social_trends WHERE url=$1 AND keyword=$2",
                    &[&url, &marker],
                )
                .await,
        )?;
        db_result(
            db.client
                .execute("DELETE FROM social_trend_snapshots WHERE url=$1", &[&url])
                .await,
        )?;
        outcome
    }
}
