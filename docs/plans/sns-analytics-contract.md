# Native analytics dispatch contract

IPC command: `analytics_dispatch({input})`; backend `analytics::dispatch(&AppConfig, Value)` returns JSON or a sanitized string error. `analytics::sync_due(&AppConfig)` is safe for startup/resume/6h timers: it only processes configured due connections after schema exists. Credentials never cross IPC.

All fields camelCase. Actions:

- `{action:"status"}` => `{schemaReady:boolean,migrationRequired:boolean,paused:boolean,jobs:Job[],capabilities:Capability[],limits:{maxBytes,maxRows,maxColumns}}`. Schema is **not** auto-applied. `{action:"applySchema"}` explicitly applies additive migration 010 to the configured local app database.
- `{action:"query",platform?,accountId?,connectionId?,sourceKind?:"api"|"import",sourceId?,metric?,from?:"YYYY-MM-DD",to?:"YYYY-MM-DD",limit?:number,offset?:number}` => `{observations:Observation[],hasMore:boolean,coverage:Job[],totalIsNotComputed:true}`. Limit max 1000. Date filters select overlapping periods; no totals or interpolated history.
- `{action:"sources",platform?,accountId?,sourceKind?}` => `{sources:Source[]}`.
- `{action:"sync",connectionId?}` => `{jobs:Job[],paused:boolean}`. Without a connection processes all due jobs. Explicit connection requests one manual refresh (unless globally paused). Jobs are discovered only from verified OAuth connections, never inferred from channel names.
- `{action:"pause",paused:boolean}` => status response. Pause survives restart.
- `{action:"importPreview",filename:"report.csv"|"report.tsv"|"report.xlsx",text?:string,bytesBase64?:string,platform:"youtube"|"instagram"|"facebook"|"threads"|"tiktok"|"naver_blog"|"naver_clip"|"x",accountId:string,label?:string,timezone:"Asia/Seoul",aggregation:"period"|"cumulative"|"snapshot",periodStart?:"YYYY-MM-DD",periodEnd?:"YYYY-MM-DD",mapping?:Mapping,definitions?:{[metric]:{definition:string,unit:string}}}` => `{previewId:string,headers:string[],sample:string[][],rowCount:number,observationCount:number,observations:Observation[],errors:string[],warnings:string[],canCommit:boolean,expiresAt:string}`. Send **either** text or bytesBase64, never paths. CSV/TSV/table pasted as text; XLSX as base64. First call may omit mapping to inspect headers; call again with original bytes/text plus mapping.
- `Mapping = {date?:columnName,endDate?:columnName,contentId?:columnName,metric?:columnName,value?:columnName,metrics?:{[columnName]:metricName},dimensions?:{[dimensionName]:columnName}}`. Supply either long form `metric+value` or wide `metrics`. A date column gives each row its actual period; otherwise explicit periodStart/periodEnd are mandatory. Empty values become `not_returned` + null, zero remains available zero. Definitions preserve platform report wording; missing definitions are labelled as user-mapped report columns, never API-equivalent.
- `{action:"importCommit",previewId:string,replaceImportId?:string}` => `{source:Source,idempotent:boolean,replacedSourceId:string|null}`. Same normalized data + metadata is idempotent. Overlapping different imports require explicit `replaceImportId`; only import data of the same platform/account/timezone can be replaced. API observations cannot be overwritten. Preview expires in 24h.
- `{action:"importHistory",platform?,accountId?}` => `{imports:Source[]}` (includes removed/replaced audit entries).
- `{action:"importRemove",sourceId:string}` => `{removed:boolean,sourceId:string}`. Only imported observations are deleted; audit metadata remains. Idempotent.

`Observation = {id?:string,sourceId?:string,platform:string,accountId:string,connectionId?:string|null,sourceKind:"api"|"import",metric:string,definition:string,unit:string,aggregation:"period"|"cumulative"|"snapshot",periodStart:string,periodEnd:string,timezone:string,contentId:string,dimensions:object,value:number|null,status:"available"|"not_returned"|"unavailable",observedAt:string,apiVersion:string,provenance:object}`.

`Source = {id,sourceKind,platform,accountId,connectionId,label,filename,digest,status:"active"|"replaced"|"removed",metadata,createdAt,removedAt}`.

`Job = {connectionId,platform,accountId,status:"pending"|"running"|"ready"|"partial"|"permission_required"|"reconnect_required"|"rate_limited"|"error"|"awaiting_report",lastSyncAt,nextSyncAt,cursor:object,coverage:object,message:string}`. Coverage contains actual returned period/snapshot information and partial collection boundaries; empty responses do not manufacture zero days. `cursor` contains only provider IDs/page markers, never access tokens or signed download URLs.

`Capability = {platform,apiVersion,accountRequirement,requiredScopes:string[],metrics:string[],history:string,latency:string,limitations:string[],manualOnly:boolean}`. X/Naver Blog/Naver Clip manualOnly true. No composite performance score or revenue/advertising metrics.

## Fixed native report queries

`{action:"reportQuery",connectionId,platform,accountId,report,range:"7d"|"28d"|"90d"|"custom",from?,to?,contentId?,breakdown?:"age"|"gender"|"country"|"city",audienceMetric?:"follower_demographics"|"engaged_audience_demographics"}` => `{sourceId,observations:Observation[],coverage,status,message,nextCursor}`. An optional `cursor:{startIndex:number}` continues bounded YouTube reports (maximum 10,000). The result is persisted in the API source, with original dimension values; selecting a date filter never prorates a period total. `custom` requires ISO from/to. One request is at most 366 days; Instagram at most 90 days. For Instagram audience, the API supports rolling 7/30/90-day timeframes. Demographic results remain collection-time snapshots with the exact provider timeframe in provenance; no custom history is claimed.

| Platform | report | metrics / dimensions | Label / unit |
| --- | --- | --- | --- |
| YouTube | summary, daily, content | views, estimatedMinutesWatched, averageViewDuration, likes, comments, shares, subscribersGained, subscribersLost; none/day/video | 조회수(횟수), 시청 시간(분), 평균 시청 시간(초), 좋아요·댓글·공유·구독 획득·구독 취소(횟수) |
| YouTube | traffic | insightTrafficSourceType; views, estimatedMinutesWatched | 유입 경로 / 원본 분류 코드 |
| YouTube | country | country; views, estimatedMinutesWatched | 국가 / ISO 코드 |
| YouTube | device | deviceType, operatingSystem; views, estimatedMinutesWatched | 기기·운영체제 / 원본 분류 |
| YouTube | demographics | ageGroup, gender; viewerPercentage | 연령·성별 시청자 비율 / percent |
| YouTube | retention (contentId required) | elapsedVideoTimeRatio; audienceWatchRatio, relativeRetentionPerformance | 영상 진행 비율별 시청 유지율·상대 유지 성과 / ratio (원본값) |
| Instagram | summary | views, reach, total_interactions, likes, comments, shares, saves | 조회·고유 도달·상호작용·좋아요·댓글·공유·저장 / count |
| Instagram | audience | follower_demographics or engaged_audience_demographics; chosen breakdown | 팔로워 또는 참여 계정 인구통계 / count, 공급자의 상위 항목·개인정보 임계값 유지 |
| Instagram | reels (contentId required) | views, reach, likes, comments, shares, saved, total_interactions, ig_reels_avg_watch_time, ig_reels_video_view_total_time | Reel 평균 시청 시간·총 시청 시간 / milliseconds; 나머지 count |
| Facebook | summary | page_media_view, page_total_media_view_unique, page_follows | Page 미디어 조회·고유 조회자·팔로우 / count; 폐기된 impressions/fans 대체 지표 |
| Facebook | video (contentId required) | post_media_view, post_total_media_view_unique, post_video_avg_time_watched, post_video_view_time | 게시물 영상 조회·고유 조회자(count), 평균·총 시청 시간(milliseconds); 버전별 미지원은 unavailable |
| Threads | summary | views, likes, replies, reposts, quotes | 조회·좋아요·답글·재게시·인용 / count |
| Threads | audience | follower_demographics; chosen breakdown | 현재 팔로워 인구통계 / count; 최소 팔로워 수·개인정보 임계값 적용 |
| TikTok | snapshot | Display API profile/video original fields | 현재 누적 관측만 제공; 기간별 조회·CTR·시청 시간 미지원 |

No raw metric names, URLs or provider filter expressions are accepted in this action. Video/Reel queries verify the returned owner against the pinned account before requesting insight fields. A provider error for one metric/report yields an unavailable observation and keeps other report results. Empty demographic/retention responses are `not_returned`, with `availability` identifying that privacy threshold, latency and genuine absence cannot be distinguished unless the provider specifies the cause.

Default background sync requests a 90-day available history window. YouTube also persists traffic/country/device/demographic reports. Snapshot-only platforms still store only collection-time observations. A bounded page/request cap records partial coverage and a cursor; no all-history completeness is implied.

`{action:"deleteApiCache",connectionId,accountId?}` => `{deletedSources:number}` deletes only API observations/jobs for that exact connection, never imports or user-authored content. In-flight jobs are fenced by a lease token so a deleted job cannot recreate its cache after deletion. Pause is persisted and checked before each new HTTP request.

Provider references checked for this implementation (2026-10-21):

- [YouTube channel report combinations](https://developers.google.com/youtube/analytics/channel_reports), [query response schema](https://developers.google.com/youtube/analytics/reference/reports/query), [sample dimensions/retention queries](https://developers.google.com/youtube/analytics/sample-requests).
- [YouTube Reporting reach reports](https://developers.google.com/youtube/reporting/v1/reports/channel_reports), [metrics](https://developers.google.com/youtube/reporting/v1/reports/metrics), [Pacific reporting dates](https://developers.google.com/youtube/reporting/v1/reports/dimensions), [asynchronous jobs](https://developers.google.com/youtube/reporting/v1/reference/rest/v1/jobs/create), [report list](https://developers.google.com/youtube/reporting/v1/reference/rest/v1/jobs.reports/list).
- [Meta v25 metric replacement announcement](https://developers.facebook.com/docs/graph-api/changelog/version25.0/?_fb_noscript=1) (the replacements remain the selected v26 fields), [Threads insights and privacy threshold](https://developers.facebook.com/docs/threads/insights/?_fb_noscript=1), [Meta's own Threads insights implementation](https://github.com/MetaThreads/meta-threads-mcp/blob/main/src/meta_threads_mcp/tools/insights.py).
- [Instagram insights reference](https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/insights/), [Page insights reference](https://developers.facebook.com/docs/graph-api/reference/page/insights/). These two references were rate limited/incomplete in the documentation fetch; exact account/version support is intentionally surfaced through native metric-level unavailable status. It has not been certified against a real connected account.
- [TikTok user fields/scopes](https://developers.tiktok.com/docs/en/tiktok-api-v2-get-user-info), [list cursor/20-video limit](https://developers.tiktok.com/docs/en/tiktok-api-v2-video-list).

Fixture and temporary PostgreSQL tests do not establish provider approval, granted account permissions, or real provider execution. No real account analytics request was made in implementation verification.
