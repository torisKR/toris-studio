//! Native organic analytics adapters. Provider field names and definitions are never merged.
use super::Observation;
use chrono::{DateTime, Duration, NaiveDate, Utc};
use futures_util::StreamExt;
use reqwest::{Client, Method, StatusCode};
use serde_json::{json, Value};
use std::time::{Duration as StdDuration, Instant};
use url::Url;
const META: &str = "v26.0";
const REACH_TYPE: &str = "channel_reach_basic_a1";
const MAX_PAGES: usize = 3;
const MAX_REQUESTS: usize = 45;
const MAX_RESPONSE: usize = 8 * 1024 * 1024;
#[derive(Debug)]
pub(crate) struct Failure {
    pub status: String,
    pub message: String,
    pub retry_after_secs: i64,
}
impl Failure {
    fn new(status: &str, message: &str, retry: i64) -> Self {
        Self {
            status: status.into(),
            message: message.into(),
            retry_after_secs: retry,
        }
    }
    pub(crate) fn permission() -> Self {
        Self::new(
            "permission_required",
            "이 계정의 분석 읽기 권한을 별도로 승인하거나 다시 연결하세요.",
            21600,
        )
    }
    fn malformed() -> Self {
        Self::new(
            "error",
            "공급자 응답 형식이 예상과 다릅니다. 기존 자료는 보존됩니다.",
            21600,
        )
    }
    fn network() -> Self {
        Self::new(
            "error",
            "분석 API에 연결할 수 없습니다. 기존 자료는 보존되며 나중에 다시 시도합니다.",
            900,
        )
    }
}
pub(crate) struct Batch {
    pub observations: Vec<Observation>,
    pub cursor: Value,
    pub coverage: Value,
    pub status: String,
    pub message: String,
    pub api_version: String,
    pub next_sync_secs: i64,
}
pub(crate) fn supported(p: &str) -> bool {
    ["youtube", "instagram", "facebook", "threads", "tiktok"].contains(&p)
}
pub(crate) fn required_scopes(p: &str) -> &'static [&'static str] {
    match p {
        "youtube" => &[
            "https://www.googleapis.com/auth/youtube.readonly",
            "https://www.googleapis.com/auth/yt-analytics.readonly",
        ],
        "instagram" => &["instagram_business_manage_insights"],
        "facebook" => &["read_insights", "pages_read_engagement"],
        "threads" => &["threads_manage_insights"],
        "tiktok" => &["user.info.stats", "video.list"],
        _ => &[],
    }
}
pub(crate) fn capabilities() -> Value {
    json!([
     {"platform":"youtube","apiVersion":"Data v3 / Analytics v2 / Reporting v1","accountRequirement":"연결한 소유 채널","requiredScopes":required_scopes("youtube"),"metrics":["viewCount","subscriberCount","videoCount","views","estimatedMinutesWatched","averageViewDuration","likes","comments","shares","subscribersGained","subscribersLost","viewerPercentage","audienceWatchRatio","relativeRetentionPerformance","video_thumbnail_impressions","video_thumbnail_impressions_ctr"],"history":"Analytics: 최근 90일 실제 반환 일별/영상별 기간 자료. Data: 수집 시점 누적 관측. CTR: Reporting 생성 완료 보고서만.","latency":"Analytics 지연은 지표마다 다름. Reporting 첫 파일은 비동기 생성(통상 24~48시간).","limitations":["썸네일 CTR은 Reporting 별도 작업; 조회수로 추정하지 않음","YouTube 일자는 America/Los_Angeles","숨김 구독자는 null","수익·광고 지표 제외"],"manualOnly":false},
     {"platform":"instagram","apiVersion":META,"accountRequirement":"Instagram Login의 Business/Creator 전문 계정","requiredScopes":required_scopes("instagram"),"metrics":["views","reach","total_interactions","likes","comments","shares","saved","follower_demographics","engaged_audience_demographics","ig_reels_avg_watch_time","ig_reels_video_view_total_time"],"history":"최근 90일 구간 합계 및 최근 미디어 실제 누적 관측","latency":"계정/지표에 따라 지연·억제·제한 발생","limitations":["개인 계정 미지원","공급자가 반환하지 않은 값은 null","API 버전/계정/미디어 유형별 지표 지원 차이"],"manualOnly":false},
     {"platform":"facebook","apiVersion":META,"accountRequirement":"ANALYZE 작업 권한을 가진 Facebook Page 및 Page 토큰","requiredScopes":required_scopes("facebook"),"metrics":["page_media_view","page_total_media_view_unique","page_follows","post_media_view","post_total_media_view_unique","post_video_avg_time_watched","post_video_view_time"],"history":"최근 90일 반환된 Page 일별 기간 및 게시물 누적 관측","latency":"일별 집계 지연/추정/억제 가능","limitations":["폐기된 page_impressions/page_fans 요청 안 함","Page 조회수와 고유 조회는 서로 다른 원본 지표","광고 관리 및 수익 제외; 원본 지표의 paid 포함 여부는 정의에 표시"],"manualOnly":false},
     {"platform":"threads","apiVersion":"v1.0","accountRequirement":"연결한 Threads 프로필","requiredScopes":required_scopes("threads"),"metrics":["views","likes","replies","reposts","quotes","followers_count","follower_demographics"],"history":"최근 90일 실제 반환 기간 및 최근 게시물 누적 관측","latency":"최신 기간 지연 가능; 일부 이력/인구통계 제한","limitations":["followers_count는 현재값이며 과거 기간을 만들지 않음","비어 있는 날짜를 0으로 채우지 않음"],"manualOnly":false},
     {"platform":"tiktok","apiVersion":"Display API v2","accountRequirement":"Display API 승인 및 연결한 공개 동영상 소유 계정","requiredScopes":required_scopes("tiktok"),"metrics":["follower_count","following_count","likes_count","video_count","view_count","like_count","comment_count","share_count"],"history":"수집 시점의 계정/공개 동영상 누적값만","latency":"최신 공개값; 게시물 목록은 create_time 역순","limitations":["Display API는 기간별 조회수·도달·시청시간·CTR을 제공하지 않음","최대 3페이지/60개 공개 영상씩 이어 수집","과거 일별 실적을 역산하지 않음"],"manualOnly":false},
     {"platform":"naver_blog","apiVersion":"manual-report-v1","accountRequirement":"사용자가 보유한 보고서","requiredScopes":[],"metrics":[],"history":"가져온 실제 보고서 기간만","latency":"보고서 기준","limitations":["분석 API 수집 없음"],"manualOnly":true},
     {"platform":"naver_clip","apiVersion":"manual-report-v1","accountRequirement":"사용자가 보유한 보고서","requiredScopes":[],"metrics":[],"history":"가져온 실제 보고서 기간만","latency":"보고서 기준","limitations":["분석 API 수집 없음"],"manualOnly":true},
     {"platform":"x","apiVersion":"manual-report-v1","accountRequirement":"사용자가 보유한 보고서","requiredScopes":[],"metrics":[],"history":"가져온 실제 보고서 기간만","latency":"보고서 기준","limitations":["X OAuth 및 유료 API 호출 없음"],"manualOnly":true}
    ])
}
struct Transport {
    client: Client,
    token: String,
    requests: usize,
    started: Instant,
    #[cfg(test)]
    fixture_origin: Option<String>,
}
impl Transport {
    fn new(token: &str) -> Result<Self, Failure> {
        Ok(Self {
            client: Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .connect_timeout(StdDuration::from_secs(5))
                .timeout(StdDuration::from_secs(15))
                .user_agent("TorisStudio/analytics")
                .build()
                .map_err(|_| Failure::network())?,
            token: token.into(),
            requests: 0,
            started: Instant::now(),
            #[cfg(test)]
            fixture_origin: None,
        })
    }
    async fn bytes(
        &mut self,
        method: Method,
        endpoint: &str,
        params: &[(&str, String)],
        body: Option<Value>,
    ) -> Result<Vec<u8>, Failure> {
        let mut url = Url::parse(endpoint).map_err(|_| Failure::malformed())?;
        if url.scheme() != "https"
            || !matches!(
                url.host_str(),
                Some(
                    "www.googleapis.com"
                        | "youtubeanalytics.googleapis.com"
                        | "youtubereporting.googleapis.com"
                        | "graph.instagram.com"
                        | "graph.facebook.com"
                        | "graph.threads.net"
                        | "graph.threads.com"
                        | "open.tiktokapis.com"
                )
            )
            || url.username() != ""
            || url.password().is_some()
        {
            return Err(Failure::malformed());
        }
        url.query_pairs_mut()
            .extend_pairs(params.iter().map(|(k, v)| (*k, v)));
        let retry_allowed = method == Method::GET
            || endpoint.starts_with("https://open.tiktokapis.com/v2/video/list/");
        #[cfg(test)]
        if let Some(origin) = &self.fixture_origin {
            let mut fixture = Url::parse(origin).map_err(|_| Failure::malformed())?;
            fixture.set_path(url.path());
            fixture.set_query(url.query());
            url = fixture;
        }
        for attempt in 0..3 {
            if super::SYNC_PAUSED.load(std::sync::atomic::Ordering::SeqCst) {
                return Err(Failure::new(
                    "paused",
                    "수집을 일시 정지했습니다. 저장한 자료와 이어받기 정보는 유지됩니다.",
                    21600,
                ));
            }
            if self.requests >= MAX_REQUESTS || self.started.elapsed() > StdDuration::from_secs(180)
            {
                return Err(Failure::new(
                    "partial",
                    "한 번의 수집 한도에 도달했습니다. 다음 수집에서 이어집니다.",
                    900,
                ));
            }
            self.requests += 1;
            tokio::time::sleep(StdDuration::from_millis(220)).await;
            let mut request = self
                .client
                .request(method.clone(), url.clone())
                .bearer_auth(&self.token);
            if let Some(body) = &body {
                request = request.json(body);
            }
            let response = match request.send().await {
                Ok(r) => r,
                Err(_) => {
                    if attempt < 2 && retry_allowed {
                        tokio::time::sleep(StdDuration::from_millis(300 * (attempt + 1))).await;
                        continue;
                    }
                    return Err(Failure::network());
                }
            };
            let status = response.status();
            let retry = retry_after(
                response
                    .headers()
                    .get("retry-after")
                    .and_then(|v| v.to_str().ok()),
                Utc::now(),
            );
            if status == StatusCode::TOO_MANY_REQUESTS {
                return Err(Failure::new(
                    "rate_limited",
                    "공급자 요청 한도에 도달했습니다. Retry-After 이후 다시 수집합니다.",
                    retry,
                ));
            }
            if status.is_server_error() && response.headers().get("retry-after").is_some() {
                return Err(Failure::new(
                    "rate_limited",
                    "공급자가 일시 중단과 재시도 시점을 알렸습니다. Retry-After 이후 이어갑니다.",
                    retry,
                ));
            }
            if status.is_server_error() && attempt < 2 && retry_allowed {
                tokio::time::sleep(StdDuration::from_millis(400 * (attempt + 1))).await;
                continue;
            }
            if response
                .content_length()
                .is_some_and(|v| v > MAX_RESPONSE as u64)
            {
                return Err(Failure::new("partial","공급자 응답 크기 제한을 초과했습니다. 기간을 줄여 가져오기 보고서를 이용하세요.",21600));
            }
            let mut bytes = Vec::new();
            let mut stream = response.bytes_stream();
            while let Some(chunk) = stream.next().await {
                let chunk = chunk.map_err(|_| Failure::network())?;
                if bytes.len() + chunk.len() > MAX_RESPONSE {
                    return Err(Failure::malformed());
                }
                bytes.extend_from_slice(&chunk);
            }
            if !status.is_success() {
                let value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
                return Err(classify(status, &value, retry));
            }
            return Ok(bytes);
        }
        Err(Failure::network())
    }
    async fn get(&mut self, endpoint: &str, params: &[(&str, String)]) -> Result<Value, Failure> {
        self.json(Method::GET, endpoint, params, None).await
    }
    async fn json(
        &mut self,
        method: Method,
        endpoint: &str,
        params: &[(&str, String)],
        body: Option<Value>,
    ) -> Result<Value, Failure> {
        let bytes = self.bytes(method, endpoint, params, body).await?;
        let value: Value = serde_json::from_slice(&bytes).map_err(|_| Failure::malformed())?;
        if value["error"].is_object() {
            let code = value["error"]["code"].as_str().unwrap_or("");
            if !code.is_empty() && code != "ok" || value["error"]["code"].is_number() {
                return Err(classify(StatusCode::BAD_REQUEST, &value, 900));
            }
        }
        Ok(value)
    }
}
fn retry_after(value: Option<&str>, now: DateTime<Utc>) -> i64 {
    value
        .and_then(|v| {
            v.parse::<i64>().ok().or_else(|| {
                DateTime::parse_from_rfc2822(v)
                    .ok()
                    .map(|t| (t.with_timezone(&Utc) - now).num_seconds())
            })
        })
        .unwrap_or(900)
        .clamp(60, 86400)
}
fn classify(status: StatusCode, value: &Value, retry: i64) -> Failure {
    let code = &value["error"]["code"];
    let google = value["error"]["errors"][0]["reason"].as_str().unwrap_or("");
    if status == StatusCode::TOO_MANY_REQUESTS
        || [4, 17, 32, 613].iter().any(|n| code.as_i64() == Some(*n))
        || matches!(
            google,
            "quotaExceeded" | "rateLimitExceeded" | "userRateLimitExceeded"
        )
        || code == "rate_limit_exceeded"
    {
        Failure::new(
            "rate_limited",
            "공급자 요청 한도에 도달했습니다. 저장한 재시도 시점 이후 다시 수집합니다.",
            retry,
        )
    } else if status == StatusCode::UNAUTHORIZED
        || code.as_i64() == Some(190)
        || code == "access_token_invalid"
    {
        Failure::new(
            "reconnect_required",
            "이 계정의 인증이 만료되거나 취소되었습니다. 다시 연결하세요.",
            21600,
        )
    } else if status == StatusCode::FORBIDDEN
        || [10, 200].iter().any(|n| code.as_i64() == Some(*n))
        || code == "scope_not_authorized"
    {
        Failure::permission()
    } else if code.as_i64() == Some(100) {
        Failure::new("partial","이 계정·API 버전에서 요청 지표가 지원되지 않습니다. 다른 지표의 수집 결과는 보존됩니다.",21600)
    } else {
        Failure::new(
            "error",
            "분석 API 요청이 거절되었습니다. 계정 유형·권한·API 설정을 확인하세요.",
            900,
        )
    }
}
fn account_id(raw: &str) -> Result<&str, Failure> {
    if raw.is_empty()
        || raw.len() > 256
        || !raw
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-'))
    {
        Err(Failure::malformed())
    } else {
        Ok(raw)
    }
}
fn number(v: &Value) -> Option<f64> {
    v.as_f64()
        .or_else(|| v.as_str().and_then(|s| s.parse().ok()))
        .filter(|n| n.is_finite())
}
fn definition(platform: &str, metric: &str) -> (&'static str, &'static str) {
    match (platform,metric){
 ("youtube","viewerPercentage")=>("특정 연령·성별 집단의 시청자 비율. 분류별 분모를 유지하며 서로 다른 차원을 합산하지 않음.","percent"),
 ("youtube","audienceWatchRatio")=>("해당 영상 진행 구간이 시청된 비율. 반복 시청으로 1을 넘을 수 있음.","ratio"),
 ("youtube","relativeRetentionPerformance")=>("길이가 비슷한 YouTube 영상 대비 상대 유지 성과(0~1 공급자 원본).","ratio"),
 ("instagram","ig_reels_avg_watch_time")=>("Instagram Reel 평균 시청 시간(밀리초). 재생·반복 재생의 공급자 정의를 유지.","milliseconds"),
 ("instagram","ig_reels_video_view_total_time")=>("Instagram Reel의 총 시청 시간(밀리초). 재생·반복 재생의 공급자 정의를 유지.","milliseconds"),
 ("facebook","post_video_avg_time_watched")=>("Facebook 게시물 영상 평균 시청 시간(밀리초). 콘텐츠/API 버전에 따른 원본 정의를 유지.","milliseconds"),
 ("facebook","post_video_view_time")=>("Facebook 게시물 영상 총 시청 시간(밀리초). 공급자 원본 집계 범위를 유지.","milliseconds"),
 (_,"follower_demographics")=>("공급자의 팔로워 인구통계 집단별 원본 값. 개인정보 임계값·상위 항목 제한을 유지.","count"),
 (_,"engaged_audience_demographics")=>("Instagram 참여 계정 인구통계 집단별 원본 값. 개인정보 임계값·상위 항목 제한을 유지.","count"),
 ("youtube","viewCount")=>("YouTube Data API의 채널/영상 누적 조회수. Shorts는 2025-03-31 이후 재생 시작/반복을 포함.","count"),
 ("youtube","subscriberCount")=>("YouTube Data API 채널 구독자 수(세 자리 유효숫자로 내림, 숨김이면 미반환).","count"),
 ("youtube","videoCount")=>("YouTube Data API 채널의 공개 동영상 수.","count"),
 ("youtube","estimatedMinutesWatched")=>("해당 기간 동안 콘텐츠를 시청한 추정 시간(분).","minutes"),
 ("youtube","averageViewDuration")=>("해당 기간의 평균 재생 시간(초); 공급자 정의의 반복 클립 제외.","seconds"),
 ("youtube","subscribersGained")=>("해당 기간 채널 구독 획득 수. 영상 필터에서는 그 영상 시청 페이지에서의 획득만 포함.","count"),
 ("youtube","subscribersLost")=>("해당 기간 채널 구독 취소 수.","count"),
 ("youtube","views")=>("YouTube Analytics API가 기간/차원별로 반환한 조회수. Data 누적 관측과 별도.","count"),
 ("youtube","video_thumbnail_impressions")=>("썸네일이 1초 넘게 50% 이상 표시된 횟수(YouTube Reporting 원본).","count"),
 ("youtube","video_thumbnail_impressions_ctr")=>("썸네일 노출 중 클릭하여 시청으로 이어진 비율. Reporting 원본 퍼센트; 단순 조회수/노출수로 재계산하지 않음.","percent"),
 ("facebook","page_media_view")=>("Page 미디어가 재생되거나 표시된 횟수. 원본 집계는 유료/자연 노출을 포함할 수 있음.","count"),
 ("facebook","page_total_media_view_unique")=>("Page 미디어의 총 고유 조회자 수(공급자 추정). 유료/자연을 포함할 수 있음.","count"),
 ("facebook","post_media_view")=>("Page 게시물 미디어가 표시되거나 재생된 누적 횟수. 유료/자연을 포함할 수 있음.","count"),
 ("facebook","post_total_media_view_unique")=>("Page 게시물 미디어의 고유 누적 조회자 수(공급자 추정).","count"),
 ("facebook","page_follows")=>("Facebook Page를 팔로우한 계정의 공급자 원본 집계.","count"),
 ("instagram","reach")=>("콘텐츠를 최소 한 번 본 고유 계정 수(추정); 원본 지표는 광고를 포함할 수 있음. 합산하지 않음.","count"),
 ("instagram","views")=>("Instagram 콘텐츠가 재생되거나 화면에 표시된 횟수. API 버전/콘텐츠 종류에 따른 원본 정의.","count"),
 ("instagram","total_interactions")=>("Instagram 콘텐츠에서 발생한 공급자 정의의 총 상호작용 수.","count"),
 ("threads","views")=>("Threads 콘텐츠 조회 횟수; 반복 조회 포함 가능. 계정/게시물 차원을 유지.","count"),
 ("threads","followers_count")=>("수집 시점 Threads 프로필의 총 팔로워 수. 과거 기간을 지원하지 않음.","count"),
 ("tiktok","follower_count")=>("TikTok Display API 사용자 현재 팔로워 수.","count"),
 ("tiktok","following_count")=>("TikTok Display API 사용자가 현재 팔로우하는 계정 수.","count"),
 ("tiktok","likes_count")=>("TikTok Display API 사용자의 전체 영상에서 받은 총 좋아요 수.","count"),
 ("tiktok","video_count")=>("TikTok Display API 사용자의 공개 영상 수.","count"),
 ("tiktok","view_count")=>("공개 TikTok 영상의 현재 누적 조회수. Display API는 일별 기간값을 제공하지 않음.","count"),
 (_,"likes"|"like_count")=>("이 플랫폼과 콘텐츠/기간에 대해 공급자가 반환한 좋아요 수.","count"),
 (_,"comments"|"comment_count")=>("이 플랫폼과 콘텐츠/기간에 대해 공급자가 반환한 댓글 수.","count"),
 (_,"shares"|"share_count")=>("이 플랫폼과 콘텐츠/기간에 대해 공급자가 반환한 공유 수.","count"),
 (_,"saved")=>("공급자가 반환한 Instagram 미디어 저장 수.","count"),
 (_,"replies")=>("Threads 답글 수. 루트 게시물/직접 답글의 공급자 정의를 유지.","count"),
 (_,"reposts")=>("공급자가 반환한 Threads 재게시 수.","count"),
 (_,"quotes")=>("공급자가 반환한 Threads 인용 게시 수.","count"),
 _=>("공급자의 원본 지표 정의. 다른 플랫폼 지표와 합산하지 않음.","count")}
}
fn observation(
    platform: &str,
    account: &str,
    metric: &str,
    value: Option<f64>,
    aggregation: &str,
    start: &str,
    end: &str,
    timezone: &str,
    content: &str,
    version: &str,
    endpoint: &str,
) -> Observation {
    let (definition, unit) = definition(platform, metric);
    Observation {
        platform: platform.into(),
        account_id: account.into(),
        connection_id: None,
        source_kind: "api".into(),
        metric: metric.into(),
        definition: definition.into(),
        unit: unit.into(),
        aggregation: aggregation.into(),
        period_start: start.into(),
        period_end: end.into(),
        timezone: timezone.into(),
        content_id: content.into(),
        dimensions: json!({}),
        value,
        status: if value.is_some() {
            "available"
        } else {
            "not_returned"
        }
        .into(),
        observed_at: Utc::now().to_rfc3339(),
        api_version: version.into(),
        provenance: json!({"endpoint":endpoint,"retrievedAt":Utc::now().to_rfc3339()}),
    }
}
fn snapshot(
    platform: &str,
    account: &str,
    metric: &str,
    value: Option<f64>,
    content: &str,
    version: &str,
    endpoint: &str,
) -> Observation {
    let day = Utc::now().date_naive().to_string();
    observation(
        platform, account, metric, value, "snapshot", &day, &day, "UTC", content, version, endpoint,
    )
}
fn batch(version: &str, cursor: Value) -> Batch {
    Batch {
        observations: vec![],
        cursor,
        coverage: json!({"actualReturnedOnly":true,"noInterpolation":true}),
        status: "ready".into(),
        message: "반환된 원본 값만 저장했습니다. 빈 날짜는 0으로 채우지 않습니다.".into(),
        api_version: version.into(),
        next_sync_secs: 21600,
    }
}
fn partial(b: &mut Batch, failure: Failure, key: &str) {
    let retry = failure.retry_after_secs.clamp(60, 86400);
    if failure.status == "rate_limited" {
        b.next_sync_secs = retry;
        b.status = "rate_limited".into();
    } else if b.status != "rate_limited" {
        b.next_sync_secs = b.next_sync_secs.min(retry);
        b.status = "partial".into();
    }
    b.message = failure.message;
    b.coverage[key] = json!({"status":failure.status,"retryAfterSeconds":retry});
}

fn actual_coverage(b: &mut Batch) {
    let starts = b
        .observations
        .iter()
        .filter(|o| o.value.is_some())
        .map(|o| o.period_start.as_str());
    let ends = b
        .observations
        .iter()
        .filter(|o| o.value.is_some())
        .map(|o| o.period_end.as_str());
    b.coverage["returnedFrom"] = json!(starts.min());
    b.coverage["returnedTo"] = json!(ends.max());
    b.coverage["observations"] = json!(b.observations.len());
    b.coverage["isPartial"] = json!(b.status != "ready");
}
pub(crate) async fn collect(
    platform: &str,
    account: &str,
    token: &str,
    cursor: Value,
) -> Result<Batch, Failure> {
    account_id(account)?;
    let mut transport = Transport::new(token)?;
    let mut result = match platform {
        "youtube" => youtube(&mut transport, account, cursor).await?,
        "instagram" | "facebook" | "threads" => {
            meta(&mut transport, platform, account, cursor).await?
        }
        "tiktok" => tiktok(&mut transport, account, cursor).await?,
        _ => return Err(Failure::malformed()),
    };
    actual_coverage(&mut result);
    Ok(result)
}
fn meta_date(raw: &str) -> String {
    NaiveDate::parse_from_str(raw, "%Y-%m-%d")
        .expect("validated report date")
        .and_hms_opt(0, 0, 0)
        .unwrap()
        .and_utc()
        .timestamp()
        .to_string()
}
fn window() -> (String, String) {
    let end = Utc::now().date_naive() - Duration::days(1);
    ((end - Duration::days(89)).to_string(), end.to_string())
}

async fn youtube(t: &mut Transport, account: &str, cursor: Value) -> Result<Batch, Failure> {
    let mut b = batch("Data v3 / Analytics v2 / Reporting v1", cursor);
    let data = t
        .get(
            "https://www.googleapis.com/youtube/v3/channels",
            &[("part", "statistics".into()), ("id", account.into())],
        )
        .await?;
    let item = data["items"]
        .as_array()
        .and_then(|v| v.iter().find(|v| v["id"] == account))
        .ok_or_else(Failure::malformed)?;
    for metric in ["viewCount", "subscriberCount", "videoCount"] {
        let value =
            if metric == "subscriberCount" && item["statistics"]["hiddenSubscriberCount"] == true {
                None
            } else {
                number(&item["statistics"][metric])
            };
        let mut o = snapshot(
            "youtube",
            account,
            metric,
            value,
            "",
            "v3",
            "channels.statistics",
        );
        o.provenance["originalValue"] = item["statistics"][metric].clone();
        if metric == "subscriberCount" && item["statistics"]["hiddenSubscriberCount"] == true {
            o.provenance["availability"] = json!("hidden_by_owner");
        }
        b.observations.push(o);
    }
    let end = (Utc::now()
        .with_timezone(&chrono_tz::America::Los_Angeles)
        .date_naive()
        - Duration::days(1))
    .to_string();
    let start =
        (NaiveDate::parse_from_str(&end, "%Y-%m-%d").unwrap() - Duration::days(89)).to_string();
    let metrics="views,estimatedMinutesWatched,averageViewDuration,likes,comments,shares,subscribersGained,subscribersLost";
    for dimensions in ["day", "video"] {
        let mut params = vec![
            ("ids", format!("channel=={account}")),
            ("startDate", start.clone()),
            ("endDate", end.clone()),
            ("metrics", metrics.into()),
            ("dimensions", dimensions.into()),
            ("maxResults", "200".into()),
        ];
        if dimensions == "video" {
            params.push(("sort", "-views".into()));
        }
        match t
            .get(
                "https://youtubeanalytics.googleapis.com/v2/reports",
                &params,
            )
            .await
        {
            Ok(v) => match decode_youtube_analytics(account, &v, &start, &end) {
                Ok(items) => {
                    let count = v["rows"].as_array().map_or(0, Vec::len);
                    b.coverage[format!("analytics_{dimensions}")] = json!({"requestedFrom":start,"requestedTo":end,"returnedRows":count,"limit":200,"possiblyTruncated":count>=200,"timezone":"America/Los_Angeles"});
                    if count >= 200 {
                        b.status = "partial".into();
                    }
                    b.observations.extend(items);
                }
                Err(f) => partial(&mut b, f, dimensions),
            },
            Err(f) => partial(&mut b, f, dimensions),
        }
    }
    for report_type in ["summary", "traffic", "country", "device", "demographics"] {
        let request = ReportRequest {
            report: report_type.into(),
            start: start.clone(),
            end: end.clone(),
            content: String::new(),
            breakdown: "country".into(),
            audience_metric: "follower_demographics".into(),
            start_index: b.cursor["reportPagination"][report_type]["startIndex"]
                .as_i64()
                .unwrap_or(1),
        };
        match youtube_report(t, account, &request).await {
            Ok(mut report) => {
                for o in &mut report.observations {
                    o.dimensions["report"] = json!(report_type);
                }
                b.observations.extend(report.observations);
                b.coverage[report_type] = report.coverage;
                if !b.cursor["reportPagination"].is_object() {
                    b.cursor["reportPagination"] = json!({});
                }
                b.cursor["reportPagination"][report_type] = report.cursor;
                if report.status != "ready" {
                    b.status = "partial".into();
                }
            }
            Err(failure) => partial(&mut b, failure, report_type),
        }
    }
    match youtube_reach(t, account, &mut b.cursor).await {
        Ok((items, state)) => {
            b.observations.extend(items);
            b.coverage["reporting"] = state.clone();
            if state["awaitingReport"] == true && b.status == "ready" {
                b.status = "awaiting_report".into();
                b.message="기본 통계가 저장되었습니다. 썸네일 CTR 보고서는 비동기 생성 완료 후 가져옵니다.".into();
            }
        }
        Err(f) => partial(&mut b, f, "reporting"),
    }
    Ok(b)
}
fn decode_youtube_analytics(
    account: &str,
    v: &Value,
    start: &str,
    end: &str,
) -> Result<Vec<Observation>, Failure> {
    let headers = v["columnHeaders"]
        .as_array()
        .ok_or_else(Failure::malformed)?;
    let names = headers
        .iter()
        .map(|h| h["name"].as_str().ok_or_else(Failure::malformed))
        .collect::<Result<Vec<_>, _>>()?;
    let mut result = vec![];
    for row in v["rows"].as_array().into_iter().flatten() {
        let cells = row.as_array().ok_or_else(Failure::malformed)?;
        if cells.len() != names.len() {
            return Err(Failure::malformed());
        }
        let day = names
            .iter()
            .position(|n| *n == "day")
            .and_then(|i| cells[i].as_str());
        if day.is_some_and(|d| NaiveDate::parse_from_str(d, "%Y-%m-%d").is_err()) {
            return Err(Failure::malformed());
        }
        let content = names
            .iter()
            .position(|n| *n == "video")
            .and_then(|i| cells[i].as_str())
            .unwrap_or("");
        for (i, name) in names.iter().enumerate() {
            if headers[i]["columnType"] != "METRIC" {
                continue;
            }
            if super::excluded_metric(name) {
                continue;
            }
            let mut o = observation(
                "youtube",
                account,
                name,
                number(&cells[i]),
                "period",
                day.unwrap_or(start),
                day.unwrap_or(end),
                "America/Los_Angeles",
                content,
                "v2",
                "reports.query",
            );
            o.dimensions = json!({});
            for (dimension_index, dimension_name) in names.iter().enumerate() {
                if headers[dimension_index]["columnType"] == "DIMENSION" {
                    o.dimensions[*dimension_name] = cells[dimension_index].clone();
                }
            }
            o.provenance["originalValue"] = cells[i].clone();
            result.push(o);
        }
    }
    Ok(result)
}
async fn youtube_reach(
    t: &mut Transport,
    account: &str,
    cursor: &mut Value,
) -> Result<(Vec<Observation>, Value), Failure> {
    if !cursor.is_object() {
        *cursor = json!({});
    }
    let mut id = cursor["reportingJobId"].as_str().map(str::to_string);
    if id.is_none() {
        let jobs = t
            .get(
                "https://youtubereporting.googleapis.com/v1/jobs",
                &[("pageSize", "100".into())],
            )
            .await?;
        id = jobs["jobs"]
            .as_array()
            .into_iter()
            .flatten()
            .find(|j| j["reportTypeId"] == REACH_TYPE && j["name"] == "Toris Studio reach")
            .and_then(|j| j["id"].as_str())
            .map(str::to_string);
        if id.is_none() {
            let created = t
                .json(
                    Method::POST,
                    "https://youtubereporting.googleapis.com/v1/jobs",
                    &[],
                    Some(json!({"reportTypeId":REACH_TYPE,"name":"Toris Studio reach"})),
                )
                .await?;
            id = created["id"].as_str().map(str::to_string);
        }
        cursor["reportingJobId"] = json!(id);
    }
    let id = id.ok_or_else(Failure::malformed)?;
    account_id(&id)?;
    let endpoint = format!("https://youtubereporting.googleapis.com/v1/jobs/{id}/reports");
    let mut page = cursor["reportingPageToken"].as_str().map(str::to_string);
    let mut downloaded = 0;
    let mut observations = vec![];
    let mut more = false;
    // CreatedAfter advances only when every report in the page was downloaded. IDs retained for crash replay.
    let mut seen = cursor["reportIds"].as_array().cloned().unwrap_or_default();
    let since = cursor["reportCreatedAfter"].as_str().map(str::to_string);
    let mut newest = since.clone();
    for _ in 0..MAX_PAGES {
        let mut params = vec![("pageSize", "5".into())];
        if let Some(p) = &page {
            params.push(("pageToken", p.clone()));
        }
        if let Some(s) = &since {
            params.push(("createdAfter", s.clone()));
        }
        let list = t.get(&endpoint, &params).await?;
        for report in list["reports"].as_array().into_iter().flatten().take(5) {
            let report_id = report["id"].as_str().ok_or_else(Failure::malformed)?;
            if seen.iter().any(|v| v == report_id) {
                continue;
            }
            let url = report["downloadUrl"]
                .as_str()
                .ok_or_else(Failure::malformed)?;
            let parsed = Url::parse(url).map_err(|_| Failure::malformed())?;
            if parsed.host_str() != Some("youtubereporting.googleapis.com")
                || !parsed.path().starts_with("/v1/media/")
            {
                return Err(Failure::malformed());
            }
            let bytes = t.bytes(Method::GET, url, &[], None).await?;
            let items = decode_reach_csv(account, &bytes, report_id)?;
            observations.extend(items);
            seen.push(json!(report_id));
            downloaded += 1;
            if let Some(created) = report["createTime"].as_str() {
                if newest.as_deref().is_none_or(|n| n < created) {
                    newest = Some(created.into());
                }
            }
        }
        page = list["nextPageToken"].as_str().map(str::to_string);
        more = page.is_some();
        if !more {
            break;
        }
    }
    cursor["reportingPageToken"] = json!(page);
    if !more {
        cursor["reportCreatedAfter"] = json!(newest);
        if seen.len() > 200 {
            seen.drain(0..seen.len() - 200);
        }
    }
    cursor["reportIds"] = json!(seen);
    Ok((
        observations,
        json!({"reportTypeId":REACH_TYPE,"downloadedReports":downloaded,"awaitingReport":downloaded==0&&since.is_none(),"moreReports":more,"timezone":"America/Los_Angeles","history":"provider-generated reports only"}),
    ))
}
fn decode_reach_csv(
    account: &str,
    bytes: &[u8],
    report: &str,
) -> Result<Vec<Observation>, Failure> {
    let mut reader = csv::ReaderBuilder::new().from_reader(bytes);
    let headers = reader.headers().map_err(|_| Failure::malformed())?.clone();
    let index = |name: &str| {
        headers
            .iter()
            .position(|v| v == name)
            .ok_or_else(Failure::malformed)
    };
    let date = index("date")?;
    let channel = index("channel_id")?;
    let video = index("video_id")?;
    let impression = index("video_thumbnail_impressions")?;
    let ctr = index("video_thumbnail_impressions_ctr")?;
    let mut result = vec![];
    for (i, row) in reader.records().enumerate() {
        if i >= 10_000 {
            return Err(Failure::new(
                "partial",
                "Reporting 보고서가 로컬 행 한도를 초과했습니다. 원본 보고서에서 범위를 줄이세요.",
                21600,
            ));
        }
        let row = row.map_err(|_| Failure::malformed())?;
        if row.get(channel) != Some(account) {
            return Err(Failure::new(
                "error",
                "Reporting 보고서의 채널이 승인된 대상과 다릅니다.",
                21600,
            ));
        }
        let day = row.get(date).ok_or_else(Failure::malformed)?;
        let day = NaiveDate::parse_from_str(day, "%Y%m%d")
            .or_else(|_| NaiveDate::parse_from_str(day, "%Y-%m-%d"))
            .map_err(|_| Failure::malformed())?
            .to_string();
        for (metric, index) in [
            ("video_thumbnail_impressions", impression),
            ("video_thumbnail_impressions_ctr", ctr),
        ] {
            let raw = row.get(index).ok_or_else(Failure::malformed)?;
            let value = if raw.is_empty() {
                None
            } else {
                Some(raw.parse::<f64>().map_err(|_| Failure::malformed())?)
            };
            if value.is_some_and(|n| !n.is_finite()) {
                return Err(Failure::malformed());
            }
            let mut o = observation(
                "youtube",
                account,
                metric,
                value,
                "period",
                &day,
                &day,
                "America/Los_Angeles",
                row.get(video).unwrap_or(""),
                "Reporting v1 / channel_reach_basic_a1",
                "jobs.reports.download",
            );
            o.provenance["reportId"] = json!(report);
            o.provenance["originalValue"] = json!(raw);
            result.push(o);
        }
    }
    Ok(result)
}

async fn tiktok(t: &mut Transport, account: &str, cursor: Value) -> Result<Batch, Failure> {
    let mut b = batch("Display API v2", cursor);
    let info = t
        .get(
            "https://open.tiktokapis.com/v2/user/info/",
            &[(
                "fields",
                "open_id,follower_count,following_count,likes_count,video_count".into(),
            )],
        )
        .await?;
    let user = &info["data"]["user"];
    if user["open_id"] != account {
        return Err(Failure::new(
            "reconnect_required",
            "TikTok 계정 응답이 승인된 계정과 다릅니다.",
            21600,
        ));
    }
    for metric in [
        "follower_count",
        "following_count",
        "likes_count",
        "video_count",
    ] {
        let mut o = snapshot(
            "tiktok",
            account,
            metric,
            number(&user[metric]),
            "",
            "Display v2",
            "user.info",
        );
        o.provenance["originalValue"] = user[metric].clone();
        b.observations.push(o);
    }
    let mut next = b.cursor["videoCursor"].as_i64();
    let mut more = false;
    let mut collected = 0;
    for _ in 0..MAX_PAGES {
        let mut body = json!({"max_count":20});
        if let Some(cursor) = next {
            body["cursor"] = json!(cursor);
        }
        let page = match t
            .json(
                Method::POST,
                "https://open.tiktokapis.com/v2/video/list/",
                &[(
                    "fields",
                    "id,create_time,title,view_count,like_count,comment_count,share_count".into(),
                )],
                Some(body),
            )
            .await
        {
            Ok(v) => v,
            Err(f) => {
                partial(&mut b, f, "videos");
                break;
            }
        };
        for video in page["data"]["videos"]
            .as_array()
            .into_iter()
            .flatten()
            .take(20)
        {
            let id = video["id"].as_str().ok_or_else(Failure::malformed)?;
            for metric in ["view_count", "like_count", "comment_count", "share_count"] {
                let mut o = snapshot(
                    "tiktok",
                    account,
                    metric,
                    number(&video[metric]),
                    id,
                    "Display v2",
                    "video.list",
                );
                o.provenance["publishedAtUnix"] = video["create_time"].clone();
                o.provenance["originalValue"] = video[metric].clone();
                b.observations.push(o);
            }
            collected += 1;
        }
        more = page["data"]["has_more"].as_bool().unwrap_or(false);
        let returned = page["data"]["cursor"].as_i64();
        if more && (returned.is_none() || returned == next) {
            return Err(Failure::malformed());
        }
        next = if more { returned } else { None };
        if !more {
            break;
        }
    }
    b.cursor["videoCursor"] = json!(next);
    b.coverage["videos"] =
        json!({"collected":collected,"more":more,"snapshotOnly":true,"maxPages":MAX_PAGES});
    if more && b.status == "ready" {
        b.status = "partial".into();
        b.message =
            "일부 공개 영상의 현재 누적값을 저장했습니다. 저장된 커서부터 다음 수집을 이어갑니다."
                .into();
    }
    Ok(b)
}

async fn meta(
    t: &mut Transport,
    platform: &str,
    account: &str,
    cursor: Value,
) -> Result<Batch, Failure> {
    let version = if platform == "threads" { "v1.0" } else { META };
    let host = match platform {
        "instagram" => "https://graph.instagram.com",
        "threads" => "https://graph.threads.net",
        _ => "https://graph.facebook.com",
    };
    let mut b = batch(version, cursor);
    let (start, end) = window();
    let end_exclusive =
        (NaiveDate::parse_from_str(&end, "%Y-%m-%d").unwrap() + Duration::days(1)).to_string();
    let account_endpoint = format!(
        "{host}/{version}/{account}/{}",
        if platform == "threads" {
            "threads_insights"
        } else {
            "insights"
        }
    );
    let account_metrics: &[&str] = match platform {
        "instagram" => &["views", "reach", "total_interactions"],
        "facebook" => &[
            "page_media_view",
            "page_total_media_view_unique",
            "page_follows",
        ],
        _ => &["views", "likes", "replies", "reposts", "quotes"],
    };
    let mut returned = 0;
    // Individual requests keep one unsupported metric from discarding supported ones.
    for metric in account_metrics {
        let mut params = vec![
            ("metric", metric.to_string()),
            ("since", meta_date(&start)),
            ("until", meta_date(&end_exclusive)),
        ];
        if platform != "threads" {
            params.push(("period", "day".into()));
        }
        if platform == "instagram" {
            params.push(("metric_type", "total_value".into()));
        }
        match t.get(&account_endpoint, &params).await {
            Ok(v) => {
                let items = decode_meta(
                    platform, account, &v, metric, "", &start, &end, version, false,
                )?;
                returned += items.iter().filter(|o| o.value.is_some()).count();
                b.observations.extend(items);
            }
            Err(f) => {
                b.observations.push(unavailable_meta(
                    platform, account, metric, "", &start, &end, version, &f,
                ));
                let stop = f.status == "rate_limited" || f.status == "reconnect_required";
                partial(&mut b, f, metric);
                if stop {
                    break;
                }
            }
        }
    }
    if platform == "threads" {
        let endpoint = format!("{host}/{version}/{account}/threads_insights");
        match t
            .get(&endpoint, &[("metric", "followers_count".into())])
            .await
        {
            Ok(v) => b.observations.extend(decode_meta(
                platform,
                account,
                &v,
                "followers_count",
                "",
                &start,
                &end,
                version,
                true,
            )?),
            Err(f) => partial(&mut b, f, "followers_count"),
        }
    }
    let edge = match platform {
        "instagram" => "media",
        "facebook" => "published_posts",
        _ => "threads",
    };
    let endpoint = format!("{host}/{version}/{account}/{edge}");
    let mut after = b.cursor["contentAfter"].as_str().map(str::to_string);
    let mut more = false;
    let mut content_count = 0;
    let mut halted = false;
    for _ in 0..MAX_PAGES {
        let fields = match platform {
            "instagram" => "id,media_type,timestamp",
            "facebook" => "id,created_time",
            _ => "id,timestamp",
        };
        let mut params = vec![("fields", fields.into()), ("limit", "5".into())];
        if let Some(a) = &after {
            params.push(("after", a.clone()));
        }
        let list = match t.get(&endpoint, &params).await {
            Ok(v) => v,
            Err(f) => {
                partial(&mut b, f, "contentList");
                break;
            }
        };
        for content in list["data"].as_array().into_iter().flatten().take(5) {
            let id = content["id"].as_str().ok_or_else(Failure::malformed)?;
            account_id(id)?;
            let metrics = match platform {
                "instagram" => "views,reach,likes,comments,shares,saved,total_interactions",
                "facebook" => "post_media_view,post_total_media_view_unique",
                _ => "views,likes,replies,reposts,quotes",
            };
            let media_endpoint = format!("{host}/{version}/{id}/insights");
            match t.get(&media_endpoint, &[("metric", metrics.into())]).await {
                Ok(v) => {
                    for metric in metrics.split(',') {
                        b.observations.extend(decode_meta(
                            platform, account, &v, metric, id, &start, &end, version, true,
                        )?);
                    }
                }
                Err(f) => {
                    for metric in metrics.split(',') {
                        b.observations.push(unavailable_meta(
                            platform, account, metric, id, &start, &end, version, &f,
                        ));
                    }
                    let stop = f.status == "rate_limited" || f.status == "reconnect_required";
                    partial(&mut b, f, "contentInsights");
                    if stop {
                        halted = true;
                        break;
                    }
                }
            }
            content_count += 1;
        }
        if halted {
            more = true;
            break;
        }
        // Do not follow paging.next: Meta can embed tokens in URLs. Only opaque after cursor is persisted.
        more = list["paging"]["next"].is_string();
        let next = list["paging"]["cursors"]["after"]
            .as_str()
            .map(str::to_string);
        if more && (next.is_none() || next == after) {
            return Err(Failure::malformed());
        }
        after = if more { next } else { None };
        if !more || b.status == "rate_limited" {
            break;
        }
    }
    b.cursor["contentAfter"] = json!(after);
    b.coverage["account"] = json!({"requestedFrom":start,"requestedTo":end,"returnedObservations":returned,"timezone":"provider_response_offset"});
    b.coverage["content"] =
        json!({"collected":content_count,"more":more,"snapshotOnly":true,"maxPages":MAX_PAGES});
    if more && b.status == "ready" {
        b.status = "partial".into();
    }
    Ok(b)
}
fn unavailable_meta(
    platform: &str,
    account: &str,
    metric: &str,
    content: &str,
    start: &str,
    end: &str,
    version: &str,
    failure: &Failure,
) -> Observation {
    let mut o = if content.is_empty() {
        observation(
            platform,
            account,
            metric,
            None,
            "period",
            start,
            end,
            "provider_unspecified",
            content,
            version,
            "insights",
        )
    } else {
        snapshot(
            platform, account, metric, None, content, version, "insights",
        )
    };
    o.status = "unavailable".into();
    o.provenance["unavailableReason"] = json!(failure.status);
    o
}
fn decode_meta(
    platform: &str,
    account: &str,
    v: &Value,
    requested: &str,
    content: &str,
    start: &str,
    end: &str,
    version: &str,
    snapshot_only: bool,
) -> Result<Vec<Observation>, Failure> {
    let data = v["data"].as_array().ok_or_else(Failure::malformed)?;
    let Some(metric) = data.iter().find(|d| d["name"] == requested) else {
        let mut o = if snapshot_only {
            snapshot(
                platform, account, requested, None, content, version, "insights",
            )
        } else {
            observation(
                platform,
                account,
                requested,
                None,
                "period",
                start,
                end,
                "provider_unspecified",
                content,
                version,
                "insights",
            )
        };
        o.provenance["availability"] = json!("requested_metric_not_returned");
        return Ok(vec![o]);
    };
    let description = metric["description"].as_str();
    let values = metric["values"].as_array();
    let total = metric["total_value"]["value"].as_f64();
    let mut observations = vec![];
    if total.is_some() || metric["total_value"].is_object() {
        let mut o = if snapshot_only {
            snapshot(
                platform,
                account,
                requested,
                number(&metric["total_value"]["value"]),
                content,
                version,
                "insights",
            )
        } else {
            observation(
                platform,
                account,
                requested,
                number(&metric["total_value"]["value"]),
                "period",
                start,
                end,
                "provider_unspecified",
                content,
                version,
                "insights",
            )
        };
        o.dimensions = json!({"metricType":"total_value","providerPeriod":metric["period"]});
        o.provenance["originalValue"] = metric["total_value"]["value"].clone();
        observations.push(o);
    } else if let Some(values) = values {
        for value in values {
            let mut o = if snapshot_only || metric["period"] == "lifetime" {
                snapshot(
                    platform,
                    account,
                    requested,
                    number(&value["value"]),
                    content,
                    version,
                    "insights",
                )
            } else {
                let raw = value["end_time"].as_str().ok_or_else(Failure::malformed)?;
                let time = DateTime::parse_from_rfc3339(raw)
                    .or_else(|_| DateTime::parse_from_str(raw, "%Y-%m-%dT%H:%M:%S%z"))
                    .map_err(|_| Failure::malformed())?;
                let end_day = time.date_naive();
                let days = match metric["period"].as_str() {
                    Some("day") => 1,
                    Some("week") => 7,
                    Some("days_28") => 28,
                    _ => return Err(Failure::malformed()),
                };
                let start_day = end_day - Duration::days(days);
                let last = end_day - Duration::days(1);
                let mut o = observation(
                    platform,
                    account,
                    requested,
                    number(&value["value"]),
                    "period",
                    &start_day.to_string(),
                    &last.to_string(),
                    &format!("UTC{}", time.offset()),
                    content,
                    version,
                    "insights",
                );
                o.provenance["providerEndTime"] = json!(raw);
                o
            };
            o.dimensions = json!({"providerPeriod":metric["period"]});
            o.provenance["originalValue"] = value["value"].clone();
            observations.push(o);
        }
    }
    if observations.is_empty() {
        let o = if snapshot_only {
            snapshot(
                platform, account, requested, None, content, version, "insights",
            )
        } else {
            observation(
                platform,
                account,
                requested,
                None,
                "period",
                start,
                end,
                "provider_unspecified",
                content,
                version,
                "insights",
            )
        };
        observations.push(o);
    }
    for o in &mut observations {
        if let Some(description) = description {
            if !description.is_empty() && description.len() < 4096 {
                o.provenance["providerDefinition"] = json!(description);
                o.definition = description.into();
            }
        }
        if let Some(id) = metric["id"].as_str() {
            o.provenance["providerMetricId"] = json!(id);
        }
        o.provenance["providerPeriod"] = metric["period"].clone();
    }
    Ok(observations)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn retry_after_obeys_seconds_and_http_date() {
        let now = DateTime::parse_from_rfc3339("2026-10-21T00:00:00Z")
            .unwrap()
            .with_timezone(&Utc);
        assert_eq!(retry_after(Some("120"), now), 120);
        assert_eq!(retry_after(Some("Wed, 21 Oct 2026 00:03:00 GMT"), now), 180);
        assert_eq!(retry_after(Some("-1"), now), 60);
    }
    #[test]
    fn permission_quota_and_revocation_are_distinct() {
        assert_eq!(
            classify(
                StatusCode::FORBIDDEN,
                &json!({"error":{"errors":[{"reason":"quotaExceeded"}]}}),
                300
            )
            .status,
            "rate_limited"
        );
        assert_eq!(
            classify(StatusCode::BAD_REQUEST, &json!({"error":{"code":190}}), 300).status,
            "reconnect_required"
        );
        assert_eq!(
            classify(StatusCode::FORBIDDEN, &Value::Null, 300).status,
            "permission_required"
        );
    }
    #[test]
    fn youtube_missing_dates_are_not_invented() {
        let v = json!({"columnHeaders":[{"name":"day","columnType":"DIMENSION"},{"name":"views","columnType":"METRIC"}],"rows":[["2026-10-01",0],["2026-10-03",5]]});
        let o = decode_youtube_analytics("a", &v, "2026-10-01", "2026-10-03").unwrap();
        assert_eq!(o.len(), 2);
        assert_eq!(o[0].value, Some(0.));
        assert_eq!(o[1].period_start, "2026-10-03");
        assert_eq!(o[0].timezone, "America/Los_Angeles");
    }
    #[test]
    fn reporting_ctr_is_original_and_account_bound() {
        let csv=b"date,channel_id,video_id,video_thumbnail_impressions,video_thumbnail_impressions_ctr\n20261001,a,v,1000,5.25\n";
        let o = decode_reach_csv("a", csv, "report1").unwrap();
        assert_eq!(o[1].value, Some(5.25));
        assert_eq!(o[1].unit, "percent");
        assert!(decode_reach_csv("other", csv, "r").is_err());
    }
    #[test]
    fn meta_total_value_is_one_period_not_fake_daily_history() {
        let v = json!({"data":[{"name":"reach","period":"day","total_value":{"value":12},"description":"Unique accounts reached"}]});
        let o = decode_meta(
            "instagram",
            "a",
            &v,
            "reach",
            "",
            "2026-10-01",
            "2026-10-20",
            META,
            false,
        )
        .unwrap();
        assert_eq!(o.len(), 1);
        assert_eq!(o[0].period_end, "2026-10-20");
        assert_eq!(o[0].aggregation, "period");
        assert_eq!(o[0].definition, "Unique accounts reached");
    }
    #[test]
    fn missing_meta_metric_is_null_not_zero() {
        let o = decode_meta(
            "instagram",
            "a",
            &json!({"data":[]}),
            "views",
            "",
            "2026-10-01",
            "2026-10-20",
            META,
            false,
        )
        .unwrap();
        assert_eq!(o[0].value, None);
        assert_eq!(o[0].status, "not_returned");
    }
    #[test]
    fn lifetime_metrics_remain_snapshot() {
        let v = json!({"data":[{"name":"views","period":"lifetime","values":[{"value":0}]}]});
        let o = decode_meta(
            "threads",
            "a",
            &v,
            "views",
            "v",
            "2026-10-01",
            "2026-10-20",
            "v1.0",
            true,
        )
        .unwrap();
        assert_eq!(o[0].aggregation, "snapshot");
        assert_eq!(o[0].value, Some(0.));
    }
    #[test]
    fn facebook_daily_end_time_is_exclusive_and_offset_preserved() {
        let v = json!({"data":[{"name":"page_media_view","period":"day","values":[{"value":1,"end_time":"2026-10-02T07:00:00+0000"}]}]});
        let o = decode_meta(
            "facebook",
            "a",
            &v,
            "page_media_view",
            "",
            "2026-10-01",
            "2026-10-20",
            META,
            false,
        )
        .unwrap();
        assert_eq!(o[0].period_start, "2026-10-01");
        assert_eq!(
            o[0].provenance["providerEndTime"],
            "2026-10-02T07:00:00+0000"
        );
    }
    #[test]
    fn manual_providers_cannot_schedule_api_requests() {
        for p in ["x", "naver_blog", "naver_clip"] {
            assert!(!supported(p));
            assert!(required_scopes(p).is_empty());
        }
    }
}

/// Explicit report types select fixed official endpoints/fields. Never accept arbitrary URLs or raw filters.
#[derive(Debug)]
struct ReportRequest {
    report: String,
    start: String,
    end: String,
    content: String,
    breakdown: String,
    audience_metric: String,
    start_index: i64,
}
fn report_request(platform: &str, input: &Value) -> Result<ReportRequest, Failure> {
    let report = input["report"].as_str().unwrap_or("summary");
    let allowed: &[&str] = match platform {
        "youtube" => &[
            "summary",
            "daily",
            "content",
            "traffic",
            "country",
            "device",
            "demographics",
            "retention",
        ],
        "instagram" => &["summary", "audience", "reels"],
        "facebook" => &["summary", "video"],
        "threads" => &["summary", "audience"],
        "tiktok" => &["snapshot"],
        _ => &[],
    };
    if !allowed.contains(&report) {
        return Err(Failure::new(
            "unavailable",
            "이 플랫폼에서 지원하지 않는 보고서 유형입니다.",
            21600,
        ));
    }
    let today = if platform == "youtube" {
        Utc::now()
            .with_timezone(&chrono_tz::America::Los_Angeles)
            .date_naive()
    } else {
        Utc::now().date_naive()
    };
    let last = today - Duration::days(1);
    let (start, end) = match input["range"].as_str().unwrap_or("28d") {
        "7d" => (last - Duration::days(6), last),
        "28d" => (last - Duration::days(27), last),
        "90d" => (last - Duration::days(89), last),
        "custom" => {
            let parse = |key: &str| {
                input[key]
                    .as_str()
                    .and_then(|d| NaiveDate::parse_from_str(d, "%Y-%m-%d").ok())
                    .ok_or_else(Failure::malformed)
            };
            (parse("from")?, parse("to")?)
        }
        _ => return Err(Failure::malformed()),
    };
    if start > end
        || end > today
        || (end - start).num_days() > 365
        || (platform == "instagram" && (end - start).num_days() > 89)
    {
        return Err(Failure::new(
            "unavailable",
            "날짜 범위를 확인하세요. 한 요청은 최대 366일, Instagram은 최대 90일입니다.",
            21600,
        ));
    }
    let content = input["contentId"].as_str().unwrap_or("");
    if !content.is_empty() {
        account_id(content)?;
    }
    if ["retention", "reels", "video"].contains(&report) && content.is_empty() {
        return Err(Failure::new(
            "unavailable",
            "이 보고서는 확인할 콘텐츠 ID가 필요합니다.",
            21600,
        ));
    }
    let breakdown = input["breakdown"].as_str().unwrap_or("country");
    if !["age", "gender", "country", "city"].contains(&breakdown) {
        return Err(Failure::malformed());
    }
    let audience_metric = input["audienceMetric"]
        .as_str()
        .unwrap_or("follower_demographics");
    if !["follower_demographics", "engaged_audience_demographics"].contains(&audience_metric) {
        return Err(Failure::malformed());
    }
    Ok(ReportRequest {
        report: report.into(),
        start: start.to_string(),
        end: end.to_string(),
        content: content.into(),
        breakdown: breakdown.into(),
        audience_metric: audience_metric.into(),
        start_index: input["cursor"]["startIndex"]
            .as_i64()
            .unwrap_or(1)
            .clamp(1, 10_000),
    })
}
pub(crate) fn validate_report(platform: &str, input: &Value) -> Result<(), Failure> {
    report_request(platform, input).map(|_| ())
}
pub(crate) async fn report(
    platform: &str,
    account: &str,
    token: &str,
    input: &Value,
) -> Result<Batch, Failure> {
    account_id(account)?;
    let request = report_request(platform, input)?;
    let mut t = Transport::new(token)?;
    let mut b = match platform {
        "youtube" => youtube_report(&mut t, account, &request).await?,
        "instagram" | "facebook" | "threads" => {
            meta_report(&mut t, platform, account, &request).await?
        }
        "tiktok" => tiktok(&mut t, account, json!({})).await?,
        _ => return Err(Failure::malformed()),
    };
    b.coverage["report"] = json!(request.report);
    b.coverage["requestedFrom"] = json!(request.start);
    b.coverage["requestedTo"] = json!(request.end);
    for o in &mut b.observations {
        o.dimensions["report"] = json!(request.report);
        o.provenance["requestedRange"] = json!({"from":request.start,"to":request.end});
    }
    actual_coverage(&mut b);
    Ok(b)
}
async fn youtube_report(
    t: &mut Transport,
    account: &str,
    r: &ReportRequest,
) -> Result<Batch, Failure> {
    let (dimensions,metrics)=match r.report.as_str(){"summary"=>("","views,estimatedMinutesWatched,averageViewDuration,likes,comments,shares,subscribersGained,subscribersLost"),"daily"=>("day","views,estimatedMinutesWatched,averageViewDuration,likes,comments,shares,subscribersGained,subscribersLost"),"content"=>("video","views,estimatedMinutesWatched,averageViewDuration,likes,comments,shares,subscribersGained,subscribersLost"),"traffic"=>("insightTrafficSourceType","views,estimatedMinutesWatched"),"country"=>("country","views,estimatedMinutesWatched"),"device"=>("deviceType,operatingSystem","views,estimatedMinutesWatched"),"demographics"=>("ageGroup,gender","viewerPercentage"),"retention"=>("elapsedVideoTimeRatio","audienceWatchRatio,relativeRetentionPerformance"),_=>return Err(Failure::malformed())};
    let mut b = batch("YouTube Analytics v2", json!({}));
    let mut page = r.start_index;
    let mut more = false;
    for _ in 0..MAX_PAGES {
        let mut params = vec![
            ("ids", format!("channel=={account}")),
            ("startDate", r.start.clone()),
            ("endDate", r.end.clone()),
            ("metrics", metrics.into()),
            ("maxResults", "200".into()),
            ("startIndex", page.to_string()),
        ];
        if !dimensions.is_empty() {
            params.push(("dimensions", dimensions.into()));
        }
        if r.report == "content" {
            params.push(("sort", "-views".into()));
        }
        if !r.content.is_empty() {
            params.push(("filters", format!("video=={}", r.content)));
        }
        match t
            .get(
                "https://youtubeanalytics.googleapis.com/v2/reports",
                &params,
            )
            .await
        {
            Ok(v) => {
                let items = decode_youtube_analytics(account, &v, &r.start, &r.end)?;
                let rows = v["rows"].as_array().map_or(0, Vec::len);
                b.observations.extend(items);
                more = rows == 200;
                if !more {
                    break;
                }
                page += 200;
            }
            Err(f) => {
                for metric in metrics.split(',') {
                    let mut o = observation(
                        "youtube",
                        account,
                        metric,
                        None,
                        "period",
                        &r.start,
                        &r.end,
                        "America/Los_Angeles",
                        &r.content,
                        "v2",
                        "reports.query",
                    );
                    o.status = "unavailable".into();
                    o.provenance["unavailableReason"] = json!(f.status);
                    b.observations.push(o);
                }
                partial(&mut b, f, "report");
                break;
            }
        }
    }
    if b.observations.is_empty() {
        for metric in metrics.split(',') {
            let mut o = observation(
                "youtube",
                account,
                metric,
                None,
                "period",
                &r.start,
                &r.end,
                "America/Los_Angeles",
                &r.content,
                "v2",
                "reports.query",
            );
            o.provenance["availability"] = json!("empty_or_privacy_threshold_or_not_yet_processed");
            b.observations.push(o);
        }
        b.status = "partial".into();
        b.message="반환된 데이터가 없습니다. 개인정보 임계값·지연·실제 데이터 없음 중 원인은 공급자가 구분하지 않았습니다.".into();
    }
    if more {
        b.status = "partial".into();
        b.cursor = json!({"startIndex":page});
    }
    b.coverage["more"] = json!(more);
    b.coverage["dimensions"] = json!(dimensions
        .split(',')
        .filter(|d| !d.is_empty())
        .collect::<Vec<_>>());
    b.coverage["timezone"] = json!("America/Los_Angeles");
    Ok(b)
}
async fn meta_report(
    t: &mut Transport,
    platform: &str,
    account: &str,
    r: &ReportRequest,
) -> Result<Batch, Failure> {
    let version = if platform == "threads" { "v1.0" } else { META };
    let host = match platform {
        "instagram" => "https://graph.instagram.com",
        "threads" => "https://graph.threads.net",
        _ => "https://graph.facebook.com",
    };
    let target = if r.content.is_empty() {
        account
    } else {
        &r.content
    };
    // For media reports prove ownership before fetching any insights, using the exact pinned account's collection.
    if !r.content.is_empty() {
        let fields = if platform == "instagram" {
            "id,owner{id},media_type"
        } else {
            "id,from{id}"
        };
        let identity = t
            .get(
                &format!("{host}/{version}/{target}"),
                &[("fields", fields.into())],
            )
            .await?;
        let owner = if platform == "instagram" {
            identity["owner"]["id"].as_str()
        } else {
            identity["from"]["id"].as_str()
        };
        if owner != Some(account) {
            return Err(Failure::new(
                "permission_required",
                "콘텐츠의 소유 계정이 승인된 계정과 일치하는지 확인할 수 없습니다.",
                21600,
            ));
        }
    }
    let metrics: Vec<&str> = match (platform, r.report.as_str()) {
        ("instagram", "summary") => vec![
            "views",
            "reach",
            "total_interactions",
            "likes",
            "comments",
            "shares",
            "saves",
        ],
        ("instagram", "reels") => vec![
            "views",
            "reach",
            "likes",
            "comments",
            "shares",
            "saved",
            "total_interactions",
            "ig_reels_avg_watch_time",
            "ig_reels_video_view_total_time",
        ],
        ("instagram", "audience") => vec![&r.audience_metric],
        ("facebook", "summary") => vec![
            "page_media_view",
            "page_total_media_view_unique",
            "page_follows",
        ],
        ("facebook", "video") => vec![
            "post_media_view",
            "post_total_media_view_unique",
            "post_video_avg_time_watched",
            "post_video_view_time",
        ],
        ("threads", "summary") => vec!["views", "likes", "replies", "reposts", "quotes"],
        ("threads", "audience") => vec!["follower_demographics"],
        _ => return Err(Failure::malformed()),
    };
    let mut b = batch(version, json!({}));
    let edge = if platform == "threads" && r.content.is_empty() {
        "threads_insights"
    } else {
        "insights"
    };
    let endpoint = format!("{host}/{version}/{target}/{edge}");
    for metric in metrics {
        let mut params = vec![("metric", metric.to_string())];
        let audience = r.report == "audience";
        let snapshot_only = !r.content.is_empty() || (platform == "threads" && audience);
        if audience {
            if platform == "instagram" {
                params.extend([
                    ("period", "lifetime".into()),
                    ("metric_type", "total_value".into()),
                    (
                        "timeframe",
                        match (NaiveDate::parse_from_str(&r.end, "%Y-%m-%d").unwrap()
                            - NaiveDate::parse_from_str(&r.start, "%Y-%m-%d").unwrap())
                        .num_days()
                        {
                            0..=6 => "last_7_days",
                            7..=29 => "last_30_days",
                            _ => "last_90_days",
                        }
                        .into(),
                    ),
                    ("breakdown", r.breakdown.clone()),
                ]);
            } else {
                params.push(("breakdown", r.breakdown.clone()));
            }
        } else if r.content.is_empty() {
            params.extend([
                ("since", meta_date(&r.start)),
                (
                    "until",
                    meta_date(
                        &(NaiveDate::parse_from_str(&r.end, "%Y-%m-%d").unwrap()
                            + Duration::days(1))
                        .to_string(),
                    ),
                ),
            ]);
            if platform != "threads" {
                params.push(("period", "day".into()));
            }
            if platform == "instagram" {
                params.push(("metric_type", "total_value".into()));
            }
        }
        match t.get(&endpoint, &params).await {
            Ok(v) => {
                let mut items = if audience {
                    decode_audience(
                        platform,
                        account,
                        &v,
                        metric,
                        &r.breakdown,
                        &r.start,
                        &r.end,
                        version,
                    )?
                } else {
                    decode_meta(
                        platform,
                        account,
                        &v,
                        metric,
                        &r.content,
                        &r.start,
                        &r.end,
                        version,
                        snapshot_only,
                    )?
                };
                for item in &mut items {
                    if audience {
                        item.provenance["timeframeParameters"] = json!(params
                            .iter()
                            .filter(|(k, _)| ["timeframe", "breakdown", "breakdowns"].contains(k))
                            .map(|(k, v)| (*k, v))
                            .collect::<std::collections::BTreeMap<_, _>>());
                    }
                }
                b.observations.extend(items);
            }
            Err(f) => {
                b.observations.push(unavailable_meta(
                    platform, account, metric, &r.content, &r.start, &r.end, version, &f,
                ));
                partial(&mut b, f, metric);
            }
        }
    }
    Ok(b)
}
fn decode_audience(
    platform: &str,
    account: &str,
    v: &Value,
    metric: &str,
    breakdown: &str,
    start: &str,
    end: &str,
    version: &str,
) -> Result<Vec<Observation>, Failure> {
    let entry = v["data"]
        .as_array()
        .and_then(|a| a.iter().find(|d| d["name"] == metric))
        .ok_or_else(Failure::malformed);
    let mut result = vec![];
    if let Ok(entry) = entry {
        for group in entry["total_value"]["breakdowns"]
            .as_array()
            .into_iter()
            .flatten()
        {
            let keys = group["dimension_keys"]
                .as_array()
                .cloned()
                .unwrap_or_else(|| vec![json!(breakdown)]);
            for row in group["results"].as_array().into_iter().flatten() {
                let values = row["dimension_values"]
                    .as_array()
                    .ok_or_else(Failure::malformed)?;
                let mut o = snapshot(
                    platform,
                    account,
                    metric,
                    number(&row["value"]),
                    "",
                    version,
                    "insights.demographics",
                );
                o.provenance["requestedRange"] = json!({"from":start,"to":end});
                o.provenance["historyCoverage"] = json!("provider_defined_timeframe_snapshot");
                o.dimensions = json!({});
                for (i, value) in values.iter().enumerate() {
                    let key = keys.get(i).and_then(Value::as_str).unwrap_or(breakdown);
                    o.dimensions[key] = value.clone();
                }
                o.provenance["providerPeriod"] = entry["period"].clone();
                o.provenance["originalValue"] = row["value"].clone();
                if let Some(desc) = entry["description"].as_str() {
                    o.definition = desc.into();
                }
                result.push(o);
            }
        }
    }
    if result.is_empty() {
        let mut o = observation(
            platform,
            account,
            metric,
            None,
            "period",
            start,
            end,
            "provider_unspecified",
            "",
            version,
            "insights.demographics",
        );
        o.dimensions = json!({"breakdown":breakdown});
        o.provenance["availability"] = json!("not_returned_or_privacy_threshold");
        result.push(o);
    }
    Ok(result)
}

#[cfg(test)]
mod report_tests {
    use super::*;
    #[test]
    fn report_types_and_ranges_are_fixed() {
        assert!(report_request("x", &json!({"report":"summary"})).is_err());
        assert!(report_request(
            "youtube",
            &json!({"report":"arbitrary","endpoint":"https://example.invalid"})
        )
        .is_err());
        assert!(report_request("youtube", &json!({"report":"retention"})).is_err());
        assert!(report_request(
            "youtube",
            &json!({"report":"retention","contentId":"video-1","range":"7d"})
        )
        .is_ok());
        assert!(report_request(
            "instagram",
            &json!({"report":"summary","range":"custom","from":"2024-01-01","to":"2026-01-01"})
        )
        .is_err());
    }
    #[test]
    fn all_youtube_dimensions_survive_decoding() {
        for (dimension, value) in [
            ("country", json!("KR")),
            ("insightTrafficSourceType", json!("YT_SEARCH")),
            ("elapsedVideoTimeRatio", json!(0.5)),
            ("deviceType", json!("MOBILE")),
            ("ageGroup", json!("age25-34")),
        ] {
            let response = json!({"columnHeaders":[{"name":dimension,"columnType":"DIMENSION"},{"name":"views","columnType":"METRIC"}],"rows":[[value,3]]});
            let rows =
                decode_youtube_analytics("channel", &response, "2026-10-01", "2026-10-07").unwrap();
            assert_eq!(rows[0].dimensions[dimension], value);
        }
    }
    #[test]
    fn audience_breakdown_is_current_provider_timeframe_not_fake_daily_history() {
        let response = json!({"data":[{"name":"follower_demographics","period":"lifetime","total_value":{"breakdowns":[{"dimension_keys":["country"],"results":[{"dimension_values":["KR"],"value":123},{"dimension_values":["US"],"value":10}]}]}}]});
        let rows = decode_audience(
            "instagram",
            "account",
            &response,
            "follower_demographics",
            "country",
            "2026-10-01",
            "2026-10-07",
            META,
        )
        .unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].dimensions["country"], "KR");
        assert_eq!(rows[0].aggregation, "snapshot");
        assert_eq!(
            rows[0].provenance["historyCoverage"],
            "provider_defined_timeframe_snapshot"
        );
    }
    #[test]
    fn audience_privacy_threshold_stays_missing() {
        let rows = decode_audience(
            "threads",
            "account",
            &json!({"data":[]}),
            "follower_demographics",
            "age",
            "2026-10-01",
            "2026-10-07",
            "v1.0",
        )
        .unwrap();
        assert_eq!(rows[0].value, None);
        assert_eq!(
            rows[0].provenance["availability"],
            "not_returned_or_privacy_threshold"
        );
    }
    #[test]
    fn platform_watch_time_units_are_not_merged() {
        assert_eq!(
            definition("youtube", "estimatedMinutesWatched").1,
            "minutes"
        );
        assert_eq!(definition("youtube", "averageViewDuration").1, "seconds");
        assert_eq!(
            definition("instagram", "ig_reels_avg_watch_time").1,
            "milliseconds"
        );
        assert_eq!(
            definition("facebook", "post_video_avg_time_watched").1,
            "milliseconds"
        );
    }
}

#[cfg(test)]
mod transport_contract_tests {
    use super::*;
    #[tokio::test]
    async fn no_token_forwarding_to_untrusted_urls() {
        let mut transport = Transport::new("fixture-native-token").unwrap();
        for endpoint in [
            "http://127.0.0.1/private",
            "https://example.invalid/next?access_token=secret",
            "https://www.googleapis.com.example.invalid/api",
            "https://user:pass@www.googleapis.com/api",
        ] {
            let failure = transport.get(endpoint, &[]).await.unwrap_err();
            assert_eq!(transport.requests, 0);
            assert!(!failure.message.contains("fixture-native-token"));
        }
    }
    #[tokio::test]
    async fn request_budget_fails_before_another_network_request() {
        let mut transport = Transport::new("fixture-native-token").unwrap();
        transport.requests = MAX_REQUESTS;
        let failure = transport
            .get("https://www.googleapis.com/youtube/v3/channels", &[])
            .await
            .unwrap_err();
        assert_eq!(failure.status, "partial");
        assert_eq!(transport.requests, MAX_REQUESTS);
    }
    #[test]
    fn long_retry_after_cannot_be_shortened_by_another_report_failure() {
        let mut batch = batch("v26", json!({}));
        partial(&mut batch, Failure::new("rate_limited", "wait", 86400), "a");
        partial(&mut batch, Failure::permission(), "b");
        assert_eq!(batch.next_sync_secs, 86400);
        assert_eq!(batch.status, "rate_limited");
    }
}

#[cfg(test)]
mod wire_fixture_tests {
    use super::*;
    use axum::{
        body::Body,
        extract::State,
        http::{Request, Response},
        routing::any,
        Router,
    };
    use std::sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc,
    };
    #[derive(Clone, Default)]
    struct ServerState {
        calls: Arc<AtomicUsize>,
        ready: Arc<AtomicBool>,
        created: Arc<AtomicUsize>,
    }
    async fn spawn(handler: Router) -> (String, tokio::task::JoinHandle<()>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            axum::serve(listener, handler).await.unwrap();
        });
        (origin, server)
    }
    fn transport(origin: &str) -> Transport {
        let mut t = Transport::new("fixture-token").unwrap();
        t.fixture_origin = Some(origin.into());
        t
    }
    async fn tiktok_route(
        State(state): State<ServerState>,
        request: Request<Body>,
    ) -> Response<Body> {
        assert_eq!(
            request.headers().get("authorization").unwrap(),
            "Bearer fixture-token"
        );
        state.calls.fetch_add(1, Ordering::SeqCst);
        let value = if request.uri().path() == "/v2/user/info/" {
            assert_eq!(request.method(), Method::GET);
            json!({"data":{"user":{"open_id":"owner","follower_count":0,"following_count":2,"likes_count":100,"video_count":2}},"error":{"code":"ok"}})
        } else {
            assert_eq!(request.method(), Method::POST);
            let body = axum::body::to_bytes(request.into_body(), 1024)
                .await
                .unwrap();
            let input: Value = serde_json::from_slice(&body).unwrap();
            assert_eq!(input["max_count"], 20);
            if input["cursor"].is_null() {
                json!({"data":{"videos":[{"id":"video1","view_count":0,"like_count":0,"comment_count":1,"share_count":0}],"has_more":true,"cursor":123},"error":{"code":"ok"}})
            } else {
                assert_eq!(input["cursor"], 123);
                json!({"data":{"videos":[{"id":"video2","view_count":15,"like_count":2,"comment_count":0,"share_count":1}],"has_more":false,"cursor":100},"error":{"code":"ok"}})
            }
        };
        Response::builder()
            .status(200)
            .header("content-type", "application/json")
            .body(Body::from(value.to_string()))
            .unwrap()
    }
    #[tokio::test]
    async fn tiktok_uses_native_bearer_and_bounded_post_cursor_then_persists_only_snapshots() {
        let state = ServerState::default();
        let app = Router::new()
            .route("/{*path}", any(tiktok_route))
            .with_state(state.clone());
        let (origin, server) = spawn(app).await;
        let mut t = transport(&origin);
        let b = tiktok(&mut t, "owner", json!({})).await.unwrap();
        assert_eq!(state.calls.load(Ordering::SeqCst), 3);
        assert_eq!(b.observations.len(), 12);
        assert!(b.observations.iter().all(|o| o.aggregation == "snapshot"));
        assert_eq!(b.cursor["videoCursor"], Value::Null);
        assert_eq!(b.observations[0].value, Some(0.));
        server.abort();
    }
    async fn reporting_route(
        State(state): State<ServerState>,
        request: Request<Body>,
    ) -> Response<Body> {
        let path = request.uri().path();
        let result = if path == "/v1/jobs" && request.method() == Method::GET {
            json!({"jobs":[]}).to_string()
        } else if path == "/v1/jobs" {
            state.created.fetch_add(1, Ordering::SeqCst);
            json!({"id":"job-1","reportTypeId":REACH_TYPE}).to_string()
        } else if path == "/v1/jobs/job-1/reports" {
            if state.ready.load(Ordering::SeqCst) {
                json!({"reports":[{"id":"report-1","createTime":"2026-10-20T10:00:00Z","startTime":"2026-10-19T07:00:00Z","endTime":"2026-10-20T07:00:00Z","downloadUrl":"https://youtubereporting.googleapis.com/v1/media/fixture-data"}]}).to_string()
            } else {
                json!({"reports":[]}).to_string()
            }
        } else {
            assert_eq!(path, "/v1/media/fixture-data");
            "date,channel_id,video_id,video_thumbnail_impressions,video_thumbnail_impressions_ctr\n20261019,owner,video1,1000,4.2\n".into()
        };
        Response::new(Body::from(result))
    }
    #[tokio::test]
    async fn youtube_reporting_job_survives_wait_restart_and_deduplicates_report_ids() {
        let state = ServerState::default();
        let app = Router::new()
            .route("/{*path}", any(reporting_route))
            .with_state(state.clone());
        let (origin, server) = spawn(app).await;
        let mut t = transport(&origin);
        let mut cursor = json!({});
        let (rows, coverage) = youtube_reach(&mut t, "owner", &mut cursor).await.unwrap();
        assert!(rows.is_empty());
        assert_eq!(coverage["awaitingReport"], true);
        assert_eq!(cursor["reportingJobId"], "job-1");
        state.ready.store(true, Ordering::SeqCst);
        let mut reopened = transport(&origin);
        let (rows, _) = youtube_reach(&mut reopened, "owner", &mut cursor)
            .await
            .unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[1].value, Some(4.2));
        assert_eq!(state.created.load(Ordering::SeqCst), 1);
        let (rows, _) = youtube_reach(&mut reopened, "owner", &mut cursor)
            .await
            .unwrap();
        assert!(rows.is_empty());
        server.abort();
    }
    async fn retry_route(State(state): State<ServerState>, _: Request<Body>) -> Response<Body> {
        let attempt = state.calls.fetch_add(1, Ordering::SeqCst);
        Response::builder()
            .status(if attempt < 2 { 503 } else { 200 })
            .body(Body::from("{\"items\":[]}"))
            .unwrap()
    }
    #[tokio::test]
    async fn transient_read_retries_are_bounded_and_job_creation_is_not_retried() {
        let state = ServerState::default();
        let app = Router::new()
            .route("/{*path}", any(retry_route))
            .with_state(state.clone());
        let (origin, server) = spawn(app).await;
        let mut t = transport(&origin);
        assert!(t
            .get("https://www.googleapis.com/youtube/v3/channels", &[])
            .await
            .is_ok());
        assert_eq!(state.calls.load(Ordering::SeqCst), 3);
        state.calls.store(0, Ordering::SeqCst);
        assert!(t
            .json(
                Method::POST,
                "https://youtubereporting.googleapis.com/v1/jobs",
                &[],
                Some(json!({"reportTypeId":REACH_TYPE}))
            )
            .await
            .is_err());
        assert_eq!(state.calls.load(Ordering::SeqCst), 1);
        server.abort();
    }
}
