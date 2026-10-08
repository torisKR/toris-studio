//! Local, evidence-labelled keyword/content exploration. No AI/browser session bridge.
use crate::{config::AppConfig, models::SocialTrend, social, trends};
use chrono::{DateTime, SecondsFormat, Utc};
use futures_util::StreamExt;
use reqwest::{Client, RequestBuilder};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    net::IpAddr,
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex as StdMutex,
    },
    time::Duration,
};
use tokio::sync::{watch, Mutex};
use unicode_normalization::UnicodeNormalization;
use url::Url;
use uuid::Uuid;

pub const INDEX_LIMIT: usize = 5_000;
const PAGE_LIMIT: usize = 50;
const MAX_HTTP_BYTES: usize = 2_000_000;
const MAX_DOCUMENT_CHARS: usize = 50_000;
const DATABASE_ERROR: &str =
    "키워드 탐색 DB를 읽거나 저장할 수 없습니다. 연결 설정에서 로컬 DB 시작·갱신을 실행하세요.";
const CANCELLED: &str = "키워드 탐색을 취소했습니다. 이미 저장된 데이터는 유지됩니다.";
static RUN_GATE: Mutex<()> = Mutex::const_new(());
static CANCELLATION: StdMutex<Option<watch::Sender<bool>>> = StdMutex::new(None);
static PERSISTING: AtomicBool = AtomicBool::new(false);

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SearchInput {
    pub query: String,
    #[serde(default = "local_mode")]
    pub mode: String,
    #[serde(default = "all_sources")]
    pub source: String,
    pub limit: Option<usize>,
    pub offset: Option<usize>,
}
fn local_mode() -> String {
    "local".into()
}
fn all_sources() -> String {
    "all".into()
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ContentInput {
    pub trend_id: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CrawlInput {
    pub trend_id: String,
    pub engine: String,
}
#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct MatchEvidence {
    pub field: String,
    pub terms: Vec<String>,
}
#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ObservedKeyword {
    pub keyword: String,
    pub source: String,
    pub observed_at: String,
    pub rank: u16,
}
#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ExtractedKeyword {
    pub keyword: String,
    pub score: f64,
    pub occurrences: usize,
}
#[derive(Clone, Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct KeywordItem {
    pub trend: SocialTrend,
    pub matches: Vec<MatchEvidence>,
    pub observed_keywords: Vec<ObservedKeyword>,
    pub extracted_keywords: Vec<ExtractedKeyword>,
    pub original_keyword: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResult {
    pub query: String,
    pub mode: String,
    pub items: Vec<KeywordItem>,
    pub total: usize,
    pub library_count: i64,
    pub index_limit: usize,
    pub truncated: bool,
    pub searched_at: String,
    pub run_id: Option<String>,
    pub warnings: Vec<String>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContentResult {
    #[serde(flatten)]
    pub item: KeywordItem,
    pub library_count: i64,
    pub body: String,
    pub crawled_at: Option<String>,
    pub crawl_engine: Option<String>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchEntry {
    pub url: String,
    pub title: String,
    pub source: String,
    pub rank: u16,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchRun {
    pub id: String,
    pub query: String,
    pub source: String,
    pub searched_at: String,
    pub result_count: usize,
    pub results: Vec<SearchEntry>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CrawlResult {
    pub trend_id: String,
    pub engine: String,
    pub url: String,
    pub title: String,
    pub text: String,
    pub extracted_keywords: Vec<ExtractedKeyword>,
    pub observed_at: String,
    pub warnings: Vec<String>,
}
struct IndexedDocument {
    trend: SocialTrend,
    body: String,
}
struct Library {
    records: Vec<IndexedDocument>,
    total: i64,
}

fn now() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}
fn timestamp(raw: DateTime<Utc>) -> String {
    raw.to_rfc3339_opts(SecondsFormat::Millis, true)
}
fn database_result<T>(raw: Result<T, tokio_postgres::Error>) -> Result<T, String> {
    raw.map_err(|_| DATABASE_ERROR.into())
}
fn normalized(raw: &str) -> String {
    raw.nfkc().flat_map(char::to_lowercase).collect()
}
fn clean_text(raw: &str, maximum: usize) -> String {
    raw.chars().filter(|ch| (!ch.is_control() || ch.is_whitespace()) && !matches!(*ch, '\u{200b}'|'\u{202a}'..='\u{202e}'|'\u{2066}'..='\u{2069}'|'\u{feff}')).take(maximum).collect::<String>().split_whitespace().collect::<Vec<_>>().join(" ")
}
fn validate_input(input: &SearchInput) -> Result<SearchInput, String> {
    if !matches!(input.mode.as_str(), "local" | "official")
        || !matches!(
            input.source.as_str(),
            "all" | "youtube" | "naver_blog" | "google_trends"
        )
        || input.query.chars().count() > 100
        || input.query.chars().any(char::is_control)
        || input.limit.is_some_and(|v| !(1..=PAGE_LIMIT).contains(&v))
        || input.offset.is_some_and(|v| v >= INDEX_LIMIT)
    {
        return Err("검색어는 100자 이내, 결과는 1~50개로 입력하세요.".into());
    }
    let query = clean_text(&input.query, 100);
    if input.mode == "official" && query.is_empty() {
        return Err("공식 검색을 실행할 키워드를 입력하세요.".into());
    }
    Ok(SearchInput {
        query,
        ..input.clone()
    })
}
fn valid_id(raw: &str) -> Result<(), String> {
    if raw.len() != 40 || !raw.bytes().all(|ch| ch.is_ascii_hexdigit()) {
        return Err("저장된 콘텐츠를 선택하세요.".into());
    }
    Ok(())
}

async fn library(config: &AppConfig) -> Result<Library, String> {
    let db = social::database(config).await?;
    let total = database_result(
        db.client
            .query_one("SELECT count(*)::bigint AS total FROM social_trends", &[])
            .await,
    )?
    .get::<_, i64>("total");
    let rows=database_result(db.client.query("SELECT t.*,coalesce(d.body,'') AS body FROM social_trends t LEFT JOIN LATERAL (SELECT left(body,3000) AS body FROM keyword_documents WHERE url=t.url ORDER BY observed_at DESC,id DESC LIMIT 1) d ON true ORDER BY t.fetched_at DESC,t.id LIMIT 5000", &[]).await)?;
    let mut records = Vec::with_capacity(rows.len());
    for row in rows {
        let details: Value = database_result(row.try_get("details"))?;
        records.push(IndexedDocument {
            trend: SocialTrend {
                id: database_result(row.try_get("id"))?,
                source: database_result(row.try_get("source"))?,
                keyword: database_result(row.try_get("keyword"))?,
                title: database_result(row.try_get("title"))?,
                url: database_result(row.try_get("url"))?,
                metric: database_result(row.try_get("metric"))?,
                region: "KR".into(),
                published_at: database_result(
                    row.try_get::<_, Option<DateTime<Utc>>>("published_at"),
                )?
                .map(timestamp),
                fetched_at: timestamp(database_result(row.try_get("fetched_at"))?),
                details: serde_json::from_value(details).ok(),
            },
            body: database_result(row.try_get("body"))?,
        });
    }
    Ok(Library { records, total })
}

fn terms(raw: &str) -> Vec<String> {
    normalized(raw)
        .split(|ch: char| !ch.is_alphanumeric())
        .filter(|term| {
            let length = term.chars().count();
            (2..=40).contains(&length)
                && !term.chars().all(char::is_numeric)
                && !matches!(
                    *term,
                    "그리고"
                        | "하지만"
                        | "대한"
                        | "위해"
                        | "하는"
                        | "있는"
                        | "있습니다"
                        | "합니다"
                        | "같은"
                        | "통해"
                        | "the"
                        | "and"
                        | "for"
                        | "with"
                        | "this"
                        | "that"
                        | "https"
                        | "http"
                        | "com"
                        | "www"
                )
        })
        .take(25_000)
        .map(str::to_owned)
        .collect()
}
fn counts(document: &IndexedDocument) -> BTreeMap<String, usize> {
    let mut counts = BTreeMap::new();
    // Preserve Korean eojeol boundaries. This is a deterministic lexical signal,
    // not a morphological model, traffic measurement or predicted search rank.
    for raw in [
        document.trend.title.as_str(),
        document
            .trend
            .details
            .as_ref()
            .and_then(|d| d.description.as_deref())
            .unwrap_or(""),
        document.body.as_str(),
    ] {
        for term in terms(raw) {
            *counts.entry(term).or_default() += 1;
        }
    }
    counts
}
fn document_frequency(records: &[IndexedDocument]) -> (HashMap<String, usize>, usize) {
    let mut frequencies = HashMap::new();
    let mut seen = HashSet::new();
    for doc in records {
        if !seen.insert((doc.trend.source.clone(), doc.trend.url.clone())) {
            continue;
        }
        for term in counts(doc).into_keys() {
            *frequencies.entry(term).or_default() += 1;
        }
    }
    (frequencies, seen.len())
}
fn extract(
    document: &IndexedDocument,
    frequencies: &HashMap<String, usize>,
    documents: usize,
) -> Vec<ExtractedKeyword> {
    let mut title_counts = HashMap::<String, usize>::new();
    for term in terms(&document.trend.title) {
        *title_counts.entry(term).or_default() += 1;
    }
    let mut values = counts(document)
        .into_iter()
        .map(|(keyword, count)| {
            let df = *frequencies.get(&keyword).unwrap_or(&0);
            let weighted = count + title_counts.get(&keyword).copied().unwrap_or(0);
            let score = (1.0 + (weighted as f64).ln())
                * (1.0 + ((1.0 + documents as f64) / (1.0 + df as f64)).ln().max(0.0));
            ExtractedKeyword {
                keyword,
                score: (score * 1_000.0).round() / 1_000.0,
                occurrences: count,
            }
        })
        .collect::<Vec<_>>();
    values.sort_by(|a, b| b.score.total_cmp(&a.score).then(a.keyword.cmp(&b.keyword)));
    values.truncate(12);
    values
}
fn matches(
    document: &IndexedDocument,
    query: &str,
    observed: &[ObservedKeyword],
) -> Vec<MatchEvidence> {
    if query.is_empty() {
        return vec![];
    }
    let query_terms = normalized(query)
        .split_whitespace()
        .map(str::to_string)
        .collect::<Vec<_>>();
    let description = document
        .trend
        .details
        .as_ref()
        .and_then(|d| d.description.as_deref())
        .unwrap_or("");
    let observed_text = observed
        .iter()
        .map(|item| item.keyword.as_str())
        .collect::<Vec<_>>()
        .join(" ");
    let mut result = vec![];
    for (field, value) in [
        ("title", document.trend.title.as_str()),
        ("description", description),
        ("source_topic", document.trend.keyword.as_str()),
        ("body", document.body.as_str()),
        ("observed_query", observed_text.as_str()),
    ] {
        let value = normalized(value);
        let found = query_terms
            .iter()
            .filter(|term| value.contains(term.as_str()))
            .cloned()
            .collect::<Vec<_>>();
        if !found.is_empty() {
            result.push(MatchEvidence {
                field: field.into(),
                terms: found,
            });
        }
    }
    result
}
fn complete_match(evidence: &[MatchEvidence], query: &str) -> bool {
    normalized(query).split_whitespace().all(|term| {
        evidence
            .iter()
            .any(|item| item.terms.iter().any(|found| found == term))
    })
}
async fn observations(
    config: &AppConfig,
    urls: &[String],
) -> Result<HashMap<String, Vec<ObservedKeyword>>, String> {
    if urls.is_empty() {
        return Ok(HashMap::new());
    }
    let db = social::database(config).await?;
    // Bounded per-URL histories, including queries no longer present in current trend rows.
    let rows=database_result(db.client.query("SELECT url,query,source,observed_at,position FROM (SELECT url,query,source,observed_at,position,row_number() OVER (PARTITION BY url ORDER BY observed_at DESC,run_id,position) AS n FROM keyword_search_observations WHERE url=ANY($1)) x WHERE n<=20", &[&urls]).await)?;
    let mut result: HashMap<String, Vec<ObservedKeyword>> = HashMap::new();
    for row in rows {
        result
            .entry(database_result(row.try_get("url"))?)
            .or_default()
            .push(ObservedKeyword {
                keyword: database_result(row.try_get("query"))?,
                source: database_result(row.try_get("source"))?,
                observed_at: timestamp(database_result(row.try_get("observed_at"))?),
                rank: database_result(row.try_get::<_, i16>("position"))? as u16,
            });
    }
    Ok(result)
}
fn keyword_item(
    document: &IndexedDocument,
    query: &str,
    observed: Vec<ObservedKeyword>,
    frequencies: &HashMap<String, usize>,
    total: usize,
) -> KeywordItem {
    KeywordItem {
        trend: document.trend.clone(),
        original_keyword: document.trend.keyword.clone(),
        matches: matches(document, query, &observed),
        observed_keywords: observed,
        extracted_keywords: extract(document, frequencies, total),
    }
}

struct ActiveRun;
impl Drop for ActiveRun {
    fn drop(&mut self) {
        *CANCELLATION.lock().unwrap_or_else(|e| e.into_inner()) = None;
        PERSISTING.store(false, Ordering::SeqCst);
    }
}
fn active_run() -> (ActiveRun, watch::Receiver<bool>) {
    let (sender, receiver) = watch::channel(false);
    *CANCELLATION.lock().unwrap_or_else(|e| e.into_inner()) = Some(sender);
    (ActiveRun, receiver)
}
pub fn cancel() -> Result<(), String> {
    let guard = CANCELLATION.lock().unwrap_or_else(|e| e.into_inner());
    let completed = || "키워드 탐색이 이미 완료되었습니다. 결과를 확인하세요.".to_string();
    let sender = guard.as_ref().ok_or_else(completed)?;
    if PERSISTING.load(Ordering::SeqCst) {
        return Err("현재 결과를 DB에 저장하고 있습니다. 저장이 끝날 때까지 기다려 주세요.".into());
    }
    sender.send(true).map_err(|_| completed())
}
fn seal_persistence(cancelled: &watch::Receiver<bool>) -> Result<(), String> {
    // cancel() checks and acknowledges cancellation under this same lock. Either
    // the cancellation wins, or persistence seals first and cancellation is denied.
    let _guard = CANCELLATION.lock().unwrap_or_else(|e| e.into_inner());
    if *cancelled.borrow() {
        return Err(CANCELLED.into());
    }
    PERSISTING.store(true, Ordering::SeqCst);
    Ok(())
}
pub fn running() -> bool {
    CANCELLATION
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .is_some()
}
pub fn lock_for_update() -> Result<tokio::sync::MutexGuard<'static, ()>, String> {
    RUN_GATE
        .try_lock()
        .map_err(|_| "키워드 탐색 또는 저장을 마친 뒤 업데이트를 설치하세요.".into())
}

async fn save_run(
    config: &AppConfig,
    input: &SearchInput,
    records: &mut [SocialTrend],
    searched_at: &str,
) -> Result<String, String> {
    let mut positions: HashMap<&str, u16> = HashMap::new();
    let entries = records
        .iter()
        .take(100)
        .map(|record| {
            let rank = positions.entry(&record.source).or_default();
            *rank += 1;
            SearchEntry {
                url: record.url.clone(),
                title: record.title.clone(),
                source: record.source.clone(),
                rank: *rank,
            }
        })
        .collect::<Vec<_>>();
    let id = Uuid::new_v4();
    let stamp = DateTime::parse_from_rfc3339(searched_at)
        .map_err(|_| DATABASE_ERROR)?
        .with_timezone(&Utc);
    let results = serde_json::to_value(&entries).map_err(|_| DATABASE_ERROR)?;
    let count = entries.len() as i32;
    let mut db = social::database(config).await?;
    let tx = database_result(db.client.transaction().await)?;
    social::save_trends_in_transaction(&tx, records).await?;
    database_result(tx.execute("INSERT INTO keyword_search_runs (id,query,source,searched_at,result_count,results) VALUES($1,$2,$3,$4,$5,$6)", &[&id,&input.query,&input.source,&stamp,&count,&results]).await)?;
    for entry in entries
        .iter()
        .filter(|entry| matches!(entry.source.as_str(), "youtube" | "naver_blog"))
    {
        database_result(tx.execute("INSERT INTO keyword_search_observations(run_id,query,source,url,title,position,observed_at) VALUES($1,$2,$3,$4,$5,$6,$7)", &[&id,&input.query,&entry.source,&entry.url,&entry.title,&(entry.rank as i16),&stamp]).await)?;
    }
    database_result(tx.commit().await)?;
    Ok(id.to_string())
}

pub async fn search(config: &AppConfig, input: SearchInput) -> Result<SearchResult, String> {
    let input = validate_input(&input)?;
    let searched_at = now();
    let mut warnings = vec![];
    let mut run_id = None;
    let mut fresh = None;
    let _permit = RUN_GATE
        .try_lock()
        .map_err(|_| "이미 키워드 탐색 또는 업데이트 설치를 진행하고 있습니다.".to_string())?;
    let (_active, mut cancelled) = active_run();
    if input.mode == "official" {
        let mut collection = tokio::select! { biased;
            _=cancelled.changed()=>return Err(CANCELLED.into()),
            result=trends::collect_selected(config,Some(&input.query),&input.source)=>result?,
        };
        warnings.append(&mut collection.warnings);
        // Once persistence begins it is allowed to finish; cancellation is no longer
        // acknowledged as successful while a transaction could commit behind it.
        if collection.trends.is_empty() && !warnings.is_empty() {
            warnings.push("수집 가능한 공식 검색 결과가 없어 이번 실행을 저장하지 않았습니다. API 설정과 수집 경고를 확인하세요.".into());
        } else {
            seal_persistence(&cancelled)?;
            run_id = Some(save_run(config, &input, &mut collection.trends, &searched_at).await?);
        }
        fresh = Some(
            collection
                .trends
                .into_iter()
                .map(|trend| IndexedDocument {
                    trend,
                    body: String::new(),
                })
                .collect::<Vec<_>>(),
        );
    }
    let library = library(config).await?;
    let records = fresh.as_deref().unwrap_or(&library.records);
    let urls = records
        .iter()
        .map(|record| record.trend.url.clone())
        .collect::<Vec<_>>();
    let observed = observations(config, &urls).await?;
    let (frequencies, document_count) = document_frequency(&library.records);
    let mut items = records
        .iter()
        .filter(|document| input.source == "all" || document.trend.source == input.source)
        .map(|document| {
            keyword_item(
                document,
                &input.query,
                observed
                    .get(&document.trend.url)
                    .cloned()
                    .unwrap_or_default(),
                &frequencies,
                document_count,
            )
        })
        .filter(|item| {
            input.mode == "official"
                || input.query.is_empty()
                || complete_match(&item.matches, &input.query)
        })
        .collect::<Vec<_>>();
    if input.mode == "local" && !input.query.is_empty() {
        // Lexical relevance only. Newest observation breaks ties; no popularity claim.
        items.sort_by(|a, b| {
            let score = |item: &KeywordItem| {
                item.matches
                    .iter()
                    .map(|matched| match matched.field.as_str() {
                        "title" => 4,
                        "observed_query" => 3,
                        "description" => 2,
                        _ => 1,
                    })
                    .sum::<usize>()
            };
            score(b)
                .cmp(&score(a))
                .then(b.trend.fetched_at.cmp(&a.trend.fetched_at))
                .then(a.trend.id.cmp(&b.trend.id))
        });
    }
    let total = items.len();
    let offset = input.offset.unwrap_or(0);
    let limit = input.limit.unwrap_or(PAGE_LIMIT);
    let items = items
        .into_iter()
        .skip(offset)
        .take(limit)
        .collect::<Vec<_>>();
    if library.total > INDEX_LIMIT as i64 {
        warnings.push(format!(
            "전체 {}건 중 최근 {INDEX_LIMIT}건을 로컬 분석합니다.",
            library.total
        ));
    }
    warnings.push("로컬 목록 검색은 저장된 본문의 앞 3,000자까지 분석합니다. 선택한 콘텐츠 상세에서 전체 수집 본문을 볼 수 있습니다.".into());
    if input.source == "google_trends" || (input.mode == "official" && input.source == "all") {
        warnings.push("Google Trends는 공개 인기 RSS의 주제 필터입니다. 일반 Google 검색 결과와 SEO 순위를 제공하지 않습니다.".into());
    }
    Ok(SearchResult {
        query: input.query,
        mode: input.mode,
        total,
        library_count: library.total,
        index_limit: INDEX_LIMIT,
        truncated: library.total > INDEX_LIMIT as i64 || offset.saturating_add(items.len()) < total,
        items,
        searched_at,
        run_id,
        warnings,
    })
}

pub async fn content(config: &AppConfig, input: ContentInput) -> Result<ContentResult, String> {
    valid_id(&input.trend_id)?;
    let library = library(config).await?;
    let document = library
        .records
        .iter()
        .find(|document| document.trend.id == input.trend_id)
        .ok_or("선택한 콘텐츠가 최근 분석 범위에 없습니다.")?;
    let observations = observations(config, std::slice::from_ref(&document.trend.url)).await?;
    let (frequencies, document_count) = document_frequency(&library.records);
    let db = social::database(config).await?;
    let saved = database_result(db.client.query_opt(
        "SELECT body,engine,observed_at FROM keyword_documents WHERE url=$1 ORDER BY observed_at DESC,id DESC LIMIT 1",
        &[&document.trend.url]
    ).await)?;
    let (body, crawled_at, crawl_engine) = if let Some(row) = saved {
        (
            database_result(row.try_get::<_, String>("body"))?,
            Some(timestamp(database_result(row.try_get("observed_at"))?)),
            Some(database_result(row.try_get::<_, String>("engine"))?),
        )
    } else {
        (String::new(), None, None)
    };
    let full_document = IndexedDocument {
        trend: document.trend.clone(),
        body: body.clone(),
    };
    Ok(ContentResult {
        item: keyword_item(
            &full_document,
            "",
            observations
                .get(&document.trend.url)
                .cloned()
                .unwrap_or_default(),
            &frequencies,
            document_count,
        ),
        library_count: library.total,
        body,
        crawled_at,
        crawl_engine,
    })
}
pub async fn runs(config: &AppConfig) -> Result<Vec<SearchRun>, String> {
    let db = social::database(config).await?;
    let rows = database_result(
        db.client
            .query(
                "SELECT * FROM keyword_search_runs ORDER BY searched_at DESC,id LIMIT 30",
                &[],
            )
            .await,
    )?;
    rows.into_iter()
        .map(|row| {
            Ok(SearchRun {
                id: database_result(row.try_get::<_, Uuid>("id"))?.to_string(),
                query: database_result(row.try_get("query"))?,
                source: database_result(row.try_get("source"))?,
                searched_at: timestamp(database_result(row.try_get("searched_at"))?),
                result_count: database_result(row.try_get::<_, i32>("result_count"))? as usize,
                results: serde_json::from_value(database_result(
                    row.try_get::<_, Value>("results"),
                )?)
                .map_err(|_| DATABASE_ERROR)?,
            })
        })
        .collect()
}

fn http_client() -> Result<Client, String> {
    Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .no_proxy()
        .connect_timeout(Duration::from_secs(3))
        .timeout(Duration::from_secs(85))
        .user_agent("TorisStudioDesktop/keyword-explorer")
        .build()
        .map_err(|_| "로컬 수집 연결을 준비하지 못했습니다.".into())
}
async fn bounded_json(request: RequestBuilder) -> Result<Value, String> {
    let response = request
        .send()
        .await
        .map_err(|_| "로컬 수집기가 응답하지 않습니다. 수집 컨테이너 상태를 확인하세요.")?;
    if !response.status().is_success()
        || response
            .content_length()
            .is_some_and(|size| size > MAX_HTTP_BYTES as u64)
    {
        return Err("로컬 수집 응답이 실패했거나 허용 크기를 초과했습니다.".into());
    }
    let mut stream = response.bytes_stream();
    let mut body = vec![];
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| "로컬 수집 응답을 읽을 수 없습니다.")?;
        if body.len().saturating_add(chunk.len()) > MAX_HTTP_BYTES {
            return Err("로컬 수집 응답이 허용 크기를 초과했습니다.".into());
        }
        body.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&body).map_err(|_| "로컬 수집 응답 형식이 올바르지 않습니다.".into())
}

fn public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => {
            !ip.is_private()
                && !ip.is_loopback()
                && !ip.is_link_local()
                && !ip.is_unspecified()
                && !ip.is_multicast()
                && !ip.is_broadcast()
                && !ip.is_documentation()
                && ip.octets()[0] != 0
                && ip.octets()[0] < 224
                && !(ip.octets()[0] == 100 && (64..=127).contains(&ip.octets()[1]))
                && !(ip.octets()[0] == 198 && matches!(ip.octets()[1], 18 | 19))
                && !(ip.octets()[0] == 192 && ip.octets()[1] == 0 && ip.octets()[2] == 0)
        }
        IpAddr::V6(ip) => {
            ip.to_ipv4_mapped()
                .is_some_and(|ip| public_ip(IpAddr::V4(ip)))
                || (ip.segments()[0] & 0xe000 == 0x2000
                    && !ip.is_loopback()
                    && !ip.is_unspecified()
                    && !ip.is_multicast()
                    && !(ip.segments()[0] == 0x2001 && ip.segments()[1] == 0xdb8)
                    && ip.segments()[0] != 0x2002
                    && !(ip.segments()[0] == 0x2001 && ip.segments()[1] == 0))
        }
    }
}
fn public_url(raw: &str) -> Result<Url, String> {
    let url = Url::parse(raw).map_err(|_| "올바른 공개 HTTPS 콘텐츠 주소가 필요합니다.")?;
    let host = url.host_str().ok_or("콘텐츠 도메인이 없습니다.")?;
    if raw.len() > 2048
        || url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
        || url.fragment().is_some()
        || !host.contains('.')
        || host.ends_with(".localhost")
        || host.ends_with(".local")
        || host.ends_with(".internal")
        || !matches!(url.host(), Some(url::Host::Domain(_)))
    {
        return Err("인증정보·IP·내부 주소가 없는 공개 HTTPS 콘텐츠만 수집할 수 있습니다.".into());
    }
    for (name, _) in url.query_pairs() {
        let name = name.to_ascii_lowercase();
        if matches!(
            name.as_str(),
            "token"
                | "access_token"
                | "refresh_token"
                | "authorization"
                | "api_key"
                | "apikey"
                | "password"
                | "secret"
                | "code"
                | "state"
        ) {
            return Err("인증정보가 포함된 콘텐츠 주소는 수집하지 않습니다.".into());
        }
    }
    Ok(url)
}
async fn preflight(raw: &str) -> Result<Url, String> {
    let url = public_url(raw)?;
    let host = url.host_str().ok_or("콘텐츠 도메인이 없습니다.")?;
    let addresses =
        tokio::time::timeout(Duration::from_secs(3), tokio::net::lookup_host((host, 443)))
            .await
            .map_err(|_| "콘텐츠 DNS 확인 시간이 초과되었습니다.")?
            .map_err(|_| "콘텐츠 도메인을 확인할 수 없습니다.")?
            .map(|socket| socket.ip())
            .collect::<Vec<_>>();
    if addresses.is_empty() || addresses.iter().any(|ip| !public_ip(*ip)) {
        return Err("내부·예약 IP로 연결되는 콘텐츠는 수집하지 않습니다.".into());
    }
    Ok(url)
}
fn endpoint(engine: &str) -> Result<&'static str, String> {
    match engine {
        "crawl4ai" => Ok("http://127.0.0.1:11235"),
        "firecrawl" => Ok("http://127.0.0.1:3002"),
        _ => Err("지원하는 로컬 수집기를 선택하세요.".into()),
    }
}
pub(crate) fn crawler_token() -> Result<String, String> {
    let path = crate::config::config_path()
        .parent()
        .ok_or("수집 설정 경로를 확인할 수 없습니다.")?
        .join("crawler-stack/.env.crawler.local");
    let metadata =
        std::fs::symlink_metadata(&path).map_err(|_| "로컬 수집기를 먼저 시작하세요.")?;
    if !metadata.is_file() || metadata.len() > 4096 {
        return Err("로컬 수집 인증 파일의 형식이 올바르지 않습니다.".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o077 != 0 {
            return Err("로컬 수집 인증 파일의 접근 권한을 제한하세요.".into());
        }
    }
    let raw = std::fs::read_to_string(&path).map_err(|_| "로컬 수집 인증을 읽을 수 없습니다.")?;
    parse_crawler_token(&raw)
}
fn parse_crawler_token(raw: &str) -> Result<String, String> {
    // Literal parsing prevents environment expansion from importing another secret.
    let lines = raw
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && !line.starts_with('#'))
        .collect::<Vec<_>>();
    let token = lines
        .first()
        .and_then(|line| line.strip_prefix("CRAWL4AI_API_TOKEN="));
    if lines.len() != 1
        || !token.is_some_and(|token| {
            token.len() == 64 && token.bytes().all(|byte| byte.is_ascii_hexdigit())
        })
    {
        return Err("로컬 수집 인증 형식이 올바르지 않습니다.".into());
    }
    Ok(token.unwrap_or_default().into())
}
fn crawler_authorization(token: &str) -> Result<reqwest::header::HeaderValue, String> {
    let mut header = reqwest::header::HeaderValue::from_str(&format!("Bearer {token}"))
        .map_err(|_| "로컬 수집 인증 형식이 올바르지 않습니다.")?;
    header.set_sensitive(true);
    Ok(header)
}
fn verified_health(value: &Value) -> bool {
    value.get("version").and_then(Value::as_str) == Some("0.9.4")
        && matches!(
            value.get("status").and_then(Value::as_str),
            Some("healthy" | "ok")
        )
}
async fn verified_crawler(client: &Client) -> Result<reqwest::header::HeaderValue, String> {
    let header = crawler_authorization(&crawler_token()?)?;
    let response = tokio::time::timeout(
        Duration::from_secs(3),
        bounded_json(
            client
                .get("http://127.0.0.1:11235/health")
                .header(reqwest::header::AUTHORIZATION, header.clone()),
        ),
    )
    .await
    .map_err(|_| "로컬 수집기 상태 확인 시간이 초과되었습니다.")??;
    if !verified_health(&response) {
        return Err("보안 설정을 검증한 Crawl4AI 0.9.4 수집기만 실행할 수 있습니다. 로컬 수집기를 시작·갱신하세요.".into());
    }
    Ok(header)
}
pub(crate) async fn check_crawler() -> Result<(), String> {
    verified_crawler(&http_client()?).await.map(|_| ())
}
// Protocol parsing is deliberately independent of HTTP so malformed HTML, missing
// original/final URLs and body bounds are tested without touching user accounts.
fn parse_document(engine: &str, value: &Value, expected: &Url) -> Result<(String, String), String> {
    let (title, text, url) = match engine {
        "crawl4ai" => {
            let record = value
                .get("results")
                .and_then(Value::as_array)
                .filter(|items| items.len() == 1)
                .and_then(|items| items.first())
                .ok_or("Crawl4AI 결과 형식이 올바르지 않습니다.")?;
            if record.get("success") != Some(&Value::Bool(true)) {
                return Err("Crawl4AI가 콘텐츠를 수집하지 못했습니다.".into());
            }
            let url = record
                .get("url")
                .and_then(Value::as_str)
                .ok_or("수집한 원본 주소가 없습니다.")?;
            let markdown = record
                .get("markdown")
                .and_then(|v| {
                    v.as_str()
                        .or_else(|| v.get("raw_markdown").and_then(Value::as_str))
                })
                .ok_or("수집한 본문이 없습니다.")?;
            (
                record
                    .pointer("/metadata/title")
                    .and_then(Value::as_str)
                    .unwrap_or(""),
                markdown,
                url,
            )
        }
        "firecrawl" => {
            if value.get("success") != Some(&Value::Bool(true)) {
                return Err("Firecrawl이 콘텐츠를 수집하지 못했습니다.".into());
            }
            let record = value
                .get("data")
                .ok_or("Firecrawl 결과 형식이 올바르지 않습니다.")?;
            (
                record
                    .pointer("/metadata/title")
                    .and_then(Value::as_str)
                    .unwrap_or(""),
                record
                    .get("markdown")
                    .and_then(Value::as_str)
                    .ok_or("수집한 본문이 없습니다.")?,
                record
                    .pointer("/metadata/sourceURL")
                    .and_then(Value::as_str)
                    .ok_or("수집한 원본 주소가 없습니다.")?,
            )
        }
        _ => return Err("지원하지 않는 수집기입니다.".into()),
    };
    if public_url(url)?.as_str() != expected.as_str() {
        return Err("수집 응답의 원본 주소가 요청과 다릅니다.".into());
    }
    let final_url = value
        .pointer("/results/0/redirected_url")
        .or_else(|| value.pointer("/data/metadata/url"))
        .and_then(Value::as_str);
    if let Some(url) = final_url {
        public_url(url)?;
    }
    let status = value
        .pointer("/results/0/redirected_status_code")
        .and_then(Value::as_u64)
        .or_else(|| {
            value
                .pointer("/results/0/status_code")
                .and_then(Value::as_u64)
        })
        .or_else(|| {
            value
                .pointer("/data/metadata/statusCode")
                .and_then(Value::as_u64)
        });
    if !status.is_some_and(|code| (200..=299).contains(&code)) {
        return Err("콘텐츠 제공처가 정상 본문을 반환하지 않았습니다. 로그인이나 차단 페이지는 저장하지 않습니다.".into());
    }
    if text.chars().count() > MAX_DOCUMENT_CHARS {
        return Err("본문이 50,000자를 초과했습니다. 더 짧은 콘텐츠를 선택하세요.".into());
    }
    let text = clean_text(text, MAX_DOCUMENT_CHARS);
    if text.is_empty() {
        return Err("수집한 본문이 비어 있습니다.".into());
    }
    Ok((clean_text(title, 300), text))
}

pub async fn status(config: &AppConfig) -> Value {
    let database=async {let db=social::database(config).await?;let row=database_result(db.client.query_one("SELECT count(*)::bigint AS total,to_regclass('public.keyword_search_runs') IS NOT NULL AS ready FROM social_trends",&[]).await)?;Ok::<_,String>((row.get::<_,i64>("total"),row.get::<_,bool>("ready")))}.await;
    let (database_connected, library_count) = database
        .map(|(count, ready)| (ready, count))
        .unwrap_or((false, 0));
    let mut engines = vec![];
    if let Ok(client) = http_client() {
        let available = verified_crawler(&client).await.is_ok();
        engines.push(json!({"id":"crawl4ai","name":"Crawl4AI","endpoint":endpoint("crawl4ai").unwrap_or(""),"available":available}));
        engines.push(json!({"id":"firecrawl","name":"Firecrawl (보안 검증 후 사용)","endpoint":endpoint("firecrawl").unwrap_or(""),"available":false}));
    }
    json!({"databaseConnected":database_connected,"libraryCount":library_count,"indexLimit":INDEX_LIMIT,"sources":[{"id":"youtube","name":"YouTube Data API","configured":config.youtube_api_key.as_deref().is_some_and(|key| !key.is_empty())},{"id":"naver_blog","name":"네이버 블로그 검색 API","configured":config.naver_client_id.as_deref().is_some_and(|key| !key.is_empty())&&config.naver_client_secret.as_deref().is_some_and(|key| !key.is_empty())},{"id":"google_trends","name":"Google Trends RSS 주제 필터","configured":true}],"engines":engines,"running":running()})
}

pub async fn crawl(config: &AppConfig, input: CrawlInput) -> Result<CrawlResult, String> {
    valid_id(&input.trend_id)?;
    let base = endpoint(&input.engine)?;
    if input.engine != "crawl4ai" {
        return Err("Firecrawl은 로컬 인증·외부 요청 보안 검증 후 활성화할 수 있습니다. 현재는 Crawl4AI를 선택하세요.".into());
    }
    let _permit = RUN_GATE
        .try_lock()
        .map_err(|_| "이미 키워드 탐색 또는 업데이트 설치를 진행하고 있습니다.")?;
    let (_active, mut cancelled) = active_run();
    let library = library(config).await?;
    let document = library
        .records
        .iter()
        .find(|record| record.trend.id == input.trend_id)
        .ok_or("저장된 콘텐츠를 찾을 수 없습니다.")?;
    let url = preflight(&document.trend.url).await?;
    let client = http_client()?;
    let authorization = verified_crawler(&client).await?;
    // Sidecars are fixed loopback endpoints. Provider keys, OAuth tokens, cookies,
    // headers, JavaScript and a caller-selected proxy never enter the request.
    let request = if input.engine == "crawl4ai" {
        client.post(format!("{base}/crawl")).header(reqwest::header::AUTHORIZATION, authorization).json(&json!({"urls":[url.as_str()],"browser_config":{"type":"BrowserConfig","params":{"headless":true,"text_mode":true,"use_persistent_context":false}},"crawler_config":{"type":"CrawlerRunConfig","params":{"page_timeout":30000,"check_robots_txt":true,"word_count_threshold":1,"exclude_external_links":true,"exclude_external_images":true}}}))
    } else {
        client.post(format!("{base}/v2/scrape")).json(&json!({"url":url.as_str(),"formats":["markdown"],"onlyMainContent":true,"timeout":60000}))
    };
    let value = tokio::select! {biased;_=cancelled.changed()=>return Err(CANCELLED.into()),value=bounded_json(request)=>value?};
    let (title, text) = parse_document(&input.engine, &value, &url)?;
    seal_persistence(&cancelled)?;
    let stamp = Utc::now();
    let id = Uuid::new_v4();
    let title = if title.is_empty() {
        document.trend.title.clone()
    } else {
        title
    };
    let db = social::database(config).await?;
    database_result(db.client.execute("INSERT INTO keyword_documents(id,url,engine,title,body,observed_at) VALUES($1,$2,$3,$4,$5,$6)", &[&id,&url.as_str(),&input.engine,&title,&text,&stamp]).await)?;
    let enriched = IndexedDocument {
        trend: document.trend.clone(),
        body: text.clone(),
    };
    let (frequencies, document_count) = document_frequency(&library.records);
    Ok(CrawlResult {trend_id:input.trend_id,engine:input.engine,url:url.into(),title,text,extracted_keywords:extract(&enriched,&frequencies,document_count),observed_at:timestamp(stamp),warnings:vec!["추출 키워드는 제목·설명·본문의 어절 빈도와 TF-IDF를 분석한 결과입니다. 실제 유입 검색어나 인기도를 뜻하지 않습니다.".into()]})
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::{Ipv4Addr, Ipv6Addr};
    fn document(id: &str, title: &str, description: &str) -> IndexedDocument {
        let mut details = crate::models::TrendDetails::discovery("youtube_popular");
        details.description = Some(description.into());
        IndexedDocument {
            trend: SocialTrend {
                id: id.into(),
                source: "youtube".into(),
                keyword: title.into(),
                title: title.into(),
                url: "https://www.youtube.com/watch?v=abcdefghijk".into(),
                metric: None,
                region: "KR".into(),
                published_at: None,
                fetched_at: "2026-10-08T10:00:00Z".into(),
                details: Some(details),
            },
            body: String::new(),
        }
    }
    #[test]
    fn unicode_korean_search_matches_separate_fields_and_never_invents_observation() {
        let doc = document("a", "AI 활용 수익화", "한국어 블로그 생산성");
        let evidence = matches(&doc, "ＡＩ 블로그", &[]);
        assert!(complete_match(&evidence, "AI 블로그"));
        assert!(evidence.iter().any(|item| item.field == "title"));
        assert!(evidence.iter().any(|item| item.field == "description"));
        assert!(!evidence.iter().any(|item| item.field == "observed_query"));
        assert!(matches(&doc, "한글", &[]).is_empty());
        assert_eq!(normalized("한글"), "한글");
    }
    #[test]
    fn keyword_extraction_is_deterministic_and_keeps_rare_korean_terms() {
        let docs = vec![
            document("a", "콘텐츠 자동화 자동화", "AI 생산성"),
            document("b", "콘텐츠 제작", "기획 방법"),
        ];
        let (frequencies, document_count) = document_frequency(&docs);
        let extracted = extract(&docs[0], &frequencies, document_count);
        assert_eq!(extracted[0].keyword, "자동화");
        assert_eq!(extracted[0].occurrences, 2);
        assert_eq!(document_count, 1); // Identical source/URL is one document in DF and N.
        assert!(extracted.iter().any(|entry| entry.keyword == "생산성"));
        assert!(!terms("www https 123 그리고")
            .iter()
            .any(|entry| entry == "https" || entry == "123"));
    }
    #[test]
    fn search_and_crawl_inputs_are_bounded_and_secret_urls_rejected() {
        let valid = SearchInput {
            query: "한글".into(),
            mode: "local".into(),
            source: "all".into(),
            limit: Some(50),
            offset: None,
        };
        assert!(validate_input(&valid).is_ok());
        for bad in [
            SearchInput {
                query: "a".repeat(101),
                ..valid.clone()
            },
            SearchInput {
                mode: "unknown".into(),
                ..valid.clone()
            },
            SearchInput {
                limit: Some(51),
                ..valid.clone()
            },
            SearchInput {
                offset: Some(INDEX_LIMIT),
                ..valid.clone()
            },
        ] {
            assert!(validate_input(&bad).is_err());
        }
        for url in [
            "http://example.com",
            "https://127.0.0.1/a",
            "https://[::1]/a",
            "https://[::ffff:127.0.0.1]/a",
            "https://[::ffff:8.8.8.8]/a",
            "https://example.local/a",
            "https://me:secret@example.com/a",
            "https://example.com:8443/a",
            "https://example.com/a?access_token=secret",
        ] {
            assert!(public_url(url).is_err(), "{url}");
        }
        assert!(public_url("https://blog.naver.com/name/123").is_ok());
        for ip in [
            Ipv4Addr::LOCALHOST.into(),
            Ipv4Addr::new(10, 0, 0, 1).into(),
            Ipv4Addr::new(169, 254, 169, 254).into(),
            Ipv4Addr::new(100, 64, 0, 1).into(),
            Ipv4Addr::new(198, 18, 0, 1).into(),
            Ipv6Addr::LOCALHOST.into(),
            "::ffff:127.0.0.1".parse().unwrap(),
            "2001:db8::1".parse().unwrap(),
            "fc00::1".parse().unwrap(),
        ] {
            assert!(!public_ip(ip));
        }
        assert!(public_ip("8.8.8.8".parse().unwrap()));
        assert!(public_ip("2606:4700:4700::1111".parse().unwrap()));
    }
    #[test]
    fn sidecar_protocol_requires_exact_original_url_bounded_plain_text_and_success() {
        let expected = Url::parse("https://example.com/article").unwrap();
        let payload = json!({"results":[{"success":true,"url":expected.as_str(),"status_code":200,"markdown":{"raw_markdown":"# 본문\n<script>untrusted</script>"},"metadata":{"title":"기사"}}]});
        let (title, text) = parse_document("crawl4ai", &payload, &expected).unwrap();
        assert_eq!(title, "기사");
        assert!(text.contains("<script>")); // UI escapes this string, never HTML.
        let mut wrong = payload.clone();
        wrong["results"][0]["url"] = json!("https://evil.example/article");
        assert!(parse_document("crawl4ai", &wrong, &expected).is_err());
        wrong = payload.clone();
        wrong["results"][0]["redirected_url"] = json!("https://127.0.0.1/secrets");
        assert!(parse_document("crawl4ai", &wrong, &expected).is_err());
        wrong = payload.clone();
        wrong["results"][0]["markdown"] = json!("x".repeat(MAX_DOCUMENT_CHARS + 1));
        assert!(parse_document("crawl4ai", &wrong, &expected).is_err());
        wrong = payload.clone();
        wrong["results"][0]["status_code"] = json!(404);
        assert!(parse_document("crawl4ai", &wrong, &expected).is_err());
        wrong["results"][0]["status_code"] = json!(302);
        wrong["results"][0]["redirected_status_code"] = json!(200);
        wrong["results"][0]["redirected_url"] = json!("https://example.com/actual-article");
        assert!(parse_document("crawl4ai", &wrong, &expected).is_ok());
        let fire = json!({"success":true,"data":{"markdown":"실제 기사 본문","metadata":{"sourceURL":expected.as_str(),"title":"기사","statusCode":200}}});
        assert!(parse_document("firecrawl", &fire, &expected).is_ok());
        assert!(parse_document("firecrawl", &json!({"success":false}), &expected).is_err());
    }
    #[test]
    fn crawler_credentials_are_literal_private_and_health_version_is_exact() {
        let token = "a".repeat(64);
        assert_eq!(
            parse_crawler_token(&format!("CRAWL4AI_API_TOKEN={token}\n")).unwrap(),
            token
        );
        for bad in [
            "CRAWL4AI_API_TOKEN=${OTHER_SECRET}",
            "CRAWL4AI_API_TOKEN=short",
            "CRAWL4AI_API_TOKEN=\n",
        ] {
            assert!(parse_crawler_token(bad).is_err());
        }
        assert!(parse_crawler_token(&format!(
            "CRAWL4AI_API_TOKEN={token}\nCRAWL4AI_API_TOKEN={token}\n"
        ))
        .is_err());
        assert!(crawler_authorization(&token).unwrap().is_sensitive());
        assert!(verified_health(&json!({"status":"ok","version":"0.9.4"})));
        assert!(!verified_health(&json!({"status":"ok","version":"0.9.3"})));
        assert!(!verified_health(
            &json!({"status":"unhealthy","version":"0.9.4"})
        ));
    }
    #[tokio::test]
    async fn cancellation_and_update_lock_cannot_overlap_active_research() {
        let _permit = RUN_GATE.lock().await;
        let (active, mut receiver) = active_run();
        assert!(running());
        assert!(lock_for_update().is_err());
        cancel().unwrap();
        receiver.changed().await.unwrap();
        assert!(*receiver.borrow());
        assert!(seal_persistence(&receiver).is_err());
        drop(active);
        assert!(!running());
        assert_eq!(
            cancel().unwrap_err(),
            "키워드 탐색이 이미 완료되었습니다. 결과를 확인하세요."
        );
        let (active, receiver) = active_run();
        seal_persistence(&receiver).unwrap();
        assert!(cancel().is_err());
        assert!(!*receiver.borrow());
        drop(active);
        assert!(cancel().is_err());
        // Race the acknowledgement and the commit boundary repeatedly. Exactly one
        // may win; a successful cancellation must never be followed by persistence.
        for _ in 0..64 {
            let (active, receiver) = active_run();
            let barrier = std::sync::Barrier::new(2);
            let (cancelled, sealed) = std::thread::scope(|scope| {
                let cancel = scope.spawn(|| {
                    barrier.wait();
                    cancel().is_ok()
                });
                let seal = scope.spawn(|| {
                    barrier.wait();
                    seal_persistence(&receiver).is_ok()
                });
                (cancel.join().unwrap(), seal.join().unwrap())
            });
            assert_ne!(
                cancelled, sealed,
                "cancellation and persistence cannot both be acknowledged"
            );
            drop(active);
            assert_eq!(
                cancel().unwrap_err(),
                "키워드 탐색이 이미 완료되었습니다. 결과를 확인하세요."
            );
        }
    }
}
