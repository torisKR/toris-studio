//! Persisted social analytics. API and imported data retain independent provenance.
use crate::{config::AppConfig, social};
use chrono::{DateTime, NaiveDate, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::sync::atomic::{AtomicBool, Ordering};
use tokio_postgres::{Client, Row};
use uuid::Uuid;
pub(crate) static SYNC_PAUSED: AtomicBool = AtomicBool::new(false);
#[path = "analytics_import.rs"]
mod import;
#[path = "analytics_providers.rs"]
mod providers;
pub(crate) const MAX_BYTES: usize = 5 * 1024 * 1024;
pub(crate) const MAX_ROWS: usize = 10_000;
pub(crate) const MAX_COLUMNS: usize = 100;
const DB_ERROR: &str =
    "분석 저장소를 읽거나 저장할 수 없습니다. 로컬 PostgreSQL과 분석 스키마를 확인하세요.";
const SCHEMA_ERROR: &str =
    "분석 저장소가 아직 준비되지 않았습니다. 설정에서 분석 스키마를 명시적으로 적용하세요.";
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Observation {
    pub platform: String,
    pub account_id: String,
    pub connection_id: Option<String>,
    pub source_kind: String,
    pub metric: String,
    pub definition: String,
    pub unit: String,
    pub aggregation: String,
    pub period_start: String,
    pub period_end: String,
    pub timezone: String,
    pub content_id: String,
    pub dimensions: Value,
    pub value: Option<f64>,
    pub status: String,
    pub observed_at: String,
    pub api_version: String,
    pub provenance: Value,
}
fn db<T>(r: Result<T, tokio_postgres::Error>) -> Result<T, String> {
    r.map_err(|_| DB_ERROR.into())
}
pub(crate) fn required(v: &Value, key: &str, max: usize) -> Result<String, String> {
    let s = v[key]
        .as_str()
        .ok_or_else(|| format!("{key} 값이 필요합니다."))?
        .trim();
    if s.is_empty() || s.len() > max || s.chars().any(char::is_control) {
        return Err(format!("{key} 형식 오류"));
    }
    Ok(s.into())
}
pub(crate) fn platform(v: &Value) -> Result<String, String> {
    let p = required(v, "platform", 32)?;
    if ![
        "youtube",
        "instagram",
        "facebook",
        "threads",
        "tiktok",
        "naver_blog",
        "naver_clip",
        "x",
    ]
    .contains(&p.as_str())
    {
        return Err("지원하지 않는 분석 플랫폼입니다.".into());
    }
    Ok(p)
}
pub(crate) fn excluded_metric(metric: &str) -> bool {
    let m = metric.to_lowercase();
    [
        "revenue",
        "monetiz",
        "cpm",
        "ad_impression",
        "adspend",
        "ad_spend",
        "advertis",
        "수익",
        "광고비",
        "매출",
    ]
    .iter()
    .any(|s| m.contains(s))
}
fn digest(v: &Value) -> String {
    format!("{:x}", Sha256::digest(v.to_string().as_bytes()))
}
fn observation_key(o: &Observation) -> String {
    digest(&json!([
        o.metric,
        o.aggregation,
        o.period_start,
        o.period_end,
        o.timezone,
        o.content_id,
        o.dimensions,
        if o.aggregation == "snapshot" {
            &o.observed_at
        } else {
            ""
        }
    ]))
}
async fn schema_ready(client: &Client) -> Result<bool, String> {
    let row=db(client.query_one("SELECT to_regclass('analytics_sources') IS NOT NULL AND to_regclass('analytics_jobs') IS NOT NULL AND to_regclass('analytics_previews') IS NOT NULL AND to_regclass('analytics_settings') IS NOT NULL AS ready",&[]).await)?;
    Ok(row.get("ready"))
}
async fn ensure(client: &Client) -> Result<(), String> {
    if schema_ready(client).await? {
        Ok(())
    } else {
        Err(SCHEMA_ERROR.into())
    }
}
fn source(row: &Row) -> Value {
    json!({"id":row.get::<_,Uuid>("id").to_string(),"sourceKind":row.get::<_,String>("source_kind"),"platform":row.get::<_,String>("platform"),"accountId":row.get::<_,String>("account_id"),"connectionId":row.get::<_,Option<String>>("connection_id"),"label":row.get::<_,String>("label"),"filename":row.get::<_,Option<String>>("filename"),"digest":row.get::<_,String>("digest"),"status":row.get::<_,String>("status"),"metadata":row.get::<_,Value>("metadata"),"createdAt":row.get::<_,DateTime<Utc>>("created_at").to_rfc3339(),"removedAt":row.get::<_,Option<DateTime<Utc>>>("removed_at").map(|t|t.to_rfc3339())})
}
fn job(row: &Row) -> Value {
    json!({"connectionId":row.get::<_,String>("connection_id"),"platform":row.get::<_,String>("platform"),"accountId":row.get::<_,String>("account_id"),"status":row.get::<_,String>("status"),"lastSyncAt":row.get::<_,Option<DateTime<Utc>>>("last_sync_at").map(|t|t.to_rfc3339()),"nextSyncAt":row.get::<_,DateTime<Utc>>("next_sync_at").to_rfc3339(),"cursor":row.get::<_,Value>("cursor"),"coverage":row.get::<_,Value>("coverage"),"message":row.get::<_,String>("message")})
}
async fn jobs(client: &Client) -> Result<Vec<Value>, String> {
    Ok(db(client
        .query(
            "SELECT * FROM analytics_jobs ORDER BY platform,account_id LIMIT 500",
            &[],
        )
        .await)?
    .iter()
    .map(job)
    .collect())
}
async fn paused(client: &Client) -> Result<bool, String> {
    Ok(db(client
        .query_one("SELECT paused FROM analytics_settings WHERE singleton", &[])
        .await)?
    .get(0))
}
async fn status(config: &AppConfig) -> Result<Value, String> {
    let session = social::database(config).await?;
    let ready = schema_ready(&session.client).await?;
    Ok(
        json!({"schemaReady":ready,"migrationRequired":!ready,"paused":if ready{paused(&session.client).await?}else{false},"jobs":if ready{jobs(&session.client).await?}else{vec![]},"capabilities":providers::capabilities(),"limits":{"maxBytes":MAX_BYTES,"maxRows":MAX_ROWS,"maxColumns":MAX_COLUMNS}}),
    )
}
async fn sources(config: &AppConfig, input: &Value, history: bool) -> Result<Value, String> {
    let session = social::database(config).await?;
    ensure(&session.client).await?;
    let p = input["platform"].as_str();
    let a = input["accountId"].as_str();
    let kind = if history {
        Some("import")
    } else {
        input["sourceKind"].as_str()
    };
    let rows=db(session.client.query("SELECT * FROM analytics_sources WHERE ($1::text IS NULL OR platform=$1) AND ($2::text IS NULL OR account_id=$2) AND ($3::text IS NULL OR source_kind=$3) AND ($4 OR status='active') ORDER BY created_at DESC LIMIT 500",&[&p,&a,&kind,&history]).await)?;
    Ok(if history {
        json!({"imports":rows.iter().map(source).collect::<Vec<_>>()})
    } else {
        json!({"sources":rows.iter().map(source).collect::<Vec<_>>()})
    })
}
async fn query(config: &AppConfig, input: &Value) -> Result<Value, String> {
    let session = social::database(config).await?;
    ensure(&session.client).await?;
    let p = input["platform"].as_str();
    let a = input["accountId"].as_str();
    let c = input["connectionId"].as_str();
    let k = input["sourceKind"].as_str();
    let s = input["sourceId"]
        .as_str()
        .map(Uuid::parse_str)
        .transpose()
        .map_err(|_| "출처 ID 오류")?;
    let m = input["metric"].as_str();
    let date = |key: &str| {
        input[key]
            .as_str()
            .map(|d| NaiveDate::parse_from_str(d, "%Y-%m-%d"))
            .transpose()
            .map_err(|_| "날짜 필터 오류")
    };
    let from = date("from")?;
    let to = date("to")?;
    if from.zip(to).is_some_and(|(a, b)| a > b) {
        return Err("날짜 범위 오류".into());
    }
    let limit = input["limit"].as_i64().unwrap_or(300).clamp(1, 1000);
    let offset = input["offset"].as_i64().unwrap_or(0).clamp(0, 1_000_000);
    let rows=db(session.client.query("SELECT o.id,o.source_id,o.payload FROM analytics_observations o JOIN analytics_sources s ON s.id=o.source_id WHERE s.status='active' AND ($1::text IS NULL OR s.platform=$1) AND ($2::text IS NULL OR s.account_id=$2) AND ($3::text IS NULL OR s.connection_id=$3) AND ($4::text IS NULL OR s.source_kind=$4) AND ($5::uuid IS NULL OR s.id=$5) AND ($6::text IS NULL OR o.metric=$6) AND ($7::date IS NULL OR o.period_end >= $7) AND ($8::date IS NULL OR o.period_start <= $8) ORDER BY o.period_start DESC,o.updated_at DESC,o.id LIMIT $9 OFFSET $10",&[&p,&a,&c,&k,&s,&m,&from,&to,&(limit+1),&offset]).await)?;
    let observations = rows
        .iter()
        .take(limit as usize)
        .map(|r| {
            let mut v = r.get::<_, Value>("payload");
            v["id"] = json!(r.get::<_, Uuid>("id").to_string());
            v["sourceId"] = json!(r.get::<_, Uuid>("source_id").to_string());
            v
        })
        .collect::<Vec<_>>();
    let coverage = jobs(&session.client)
        .await?
        .into_iter()
        .filter(|j| {
            p.is_none_or(|v| j["platform"] == v)
                && a.is_none_or(|v| j["accountId"] == v)
                && c.is_none_or(|v| j["connectionId"] == v)
        })
        .collect::<Vec<_>>();
    Ok(
        json!({"observations":observations,"hasMore":rows.len()>limit as usize,"coverage":coverage,"totalIsNotComputed":true}),
    )
}
async fn import_preview(config: &AppConfig, input: &Value) -> Result<Value, String> {
    let preview = import::preview(input)?;
    let can_commit = !preview.observations.is_empty() && preview.errors.is_empty();
    let id = Uuid::new_v4();
    let expires = Utc::now() + chrono::Duration::hours(24);
    let metadata = json!({"timezone":input["timezone"],"aggregation":input["aggregation"],"mapping":input["mapping"],"definitions":input["definitions"],"rowCount":preview.row_count,"observationCount":preview.observations.len()});
    let mut normalized =
        serde_json::to_value(&preview.observations).map_err(|_| "미리보기 변환 실패")?;
    if let Some(rows) = normalized.as_array_mut() {
        for row in rows.iter_mut() {
            row.as_object_mut().unwrap().remove("observedAt");
        }
        rows.sort_by_key(Value::to_string);
    }
    let hash = digest(
        &json!({"platform":input["platform"],"accountId":input["accountId"],"metadata":metadata,"observations":normalized}),
    );
    let payload = json!({"platform":input["platform"],"accountId":input["accountId"],"label":input["label"].as_str().unwrap_or("가져온 보고서"),"filename":input["filename"],"metadata":metadata,"observations":preview.observations});
    let session = social::database(config).await?;
    ensure(&session.client).await?;
    db(session
        .client
        .execute(
            "DELETE FROM analytics_previews WHERE expires_at < now()",
            &[],
        )
        .await)?;
    db(session.client.execute("INSERT INTO analytics_previews(id,payload,digest,can_commit,expires_at) VALUES($1,$2,$3,$4,$5)",&[&id,&payload,&hash,&can_commit,&expires]).await)?;
    Ok(
        json!({"previewId":id.to_string(),"headers":preview.headers,"sample":preview.sample,"rowCount":preview.row_count,"observationCount":preview.observations.len(),"observations":preview.observations.iter().take(50).collect::<Vec<_>>(),"errors":preview.errors,"warnings":preview.warnings,"canCommit":can_commit,"expiresAt":expires.to_rfc3339()}),
    )
}
async fn insert_observation(
    tx: &tokio_postgres::Transaction<'_>,
    source_id: &Uuid,
    o: &Observation,
) -> Result<(), String> {
    let id = Uuid::new_v4();
    let key = observation_key(o);
    let start =
        NaiveDate::parse_from_str(&o.period_start, "%Y-%m-%d").map_err(|_| "관측 시작일 오류")?;
    let end =
        NaiveDate::parse_from_str(&o.period_end, "%Y-%m-%d").map_err(|_| "관측 종료일 오류")?;
    let payload = serde_json::to_value(o).map_err(|_| "관측 변환 오류")?;
    db(tx.execute("INSERT INTO analytics_observations(id,source_id,record_key,metric,period_start,period_end,payload) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(source_id,record_key) DO UPDATE SET payload=EXCLUDED.payload,updated_at=now()",&[&id,source_id,&key,&o.metric,&start,&end,&payload]).await)?;
    Ok(())
}
async fn import_commit(config: &AppConfig, input: &Value) -> Result<Value, String> {
    let id = Uuid::parse_str(&required(input, "previewId", 36)?).map_err(|_| "미리보기 ID 오류")?;
    let replacement = input["replaceImportId"]
        .as_str()
        .map(Uuid::parse_str)
        .transpose()
        .map_err(|_| "교체 출처 ID 오류")?;
    let mut session = social::database(config).await?;
    ensure(&session.client).await?;
    let tx = db(session.client.transaction().await)?;
    let row = db(tx
        .query_opt(
            "SELECT * FROM analytics_previews WHERE id=$1 AND expires_at>now() FOR UPDATE",
            &[&id],
        )
        .await)?
    .ok_or("미리보기가 없거나 만료되었습니다. 다시 확인하세요.")?;
    if !row.get::<_, bool>("can_commit") {
        return Err("오류가 없는 매핑 미리보기를 먼저 확인하세요.".into());
    }
    let payload = row.get::<_, Value>("payload");
    let hash = row.get::<_, String>("digest");
    let p = required(&payload, "platform", 32)?;
    let a = required(&payload, "accountId", 256)?;
    db(tx
        .query_one(
            "SELECT pg_advisory_xact_lock(hashtext($1))",
            &[&format!("analytics-import:{p}:{a}")],
        )
        .await)?;
    if let Some(existing)=db(tx.query_opt("SELECT * FROM analytics_sources WHERE source_kind='import' AND platform=$1 AND account_id=$2 AND digest=$3",&[&p,&a,&hash]).await)?{return Ok(json!({"source":source(&existing),"idempotent":true,"replacedSourceId":Value::Null}));}
    let observations: Vec<Observation> = serde_json::from_value(payload["observations"].clone())
        .map_err(|_| "미리보기 데이터 오류")?;
    let overlaps=db(tx.query("SELECT DISTINCT s.id FROM analytics_sources s JOIN analytics_observations o ON o.source_id=s.id CROSS JOIN jsonb_array_elements($3::jsonb) n WHERE s.source_kind='import' AND s.status='active' AND s.platform=$1 AND s.account_id=$2 AND o.metric=n->>'metric' AND o.period_start <= (n->>'periodEnd')::date AND o.period_end >= (n->>'periodStart')::date AND o.payload->>'timezone'=n->>'timezone' AND o.payload->>'contentId'=n->>'contentId' AND o.payload->'dimensions'=n->'dimensions'",&[&p,&a,&payload["observations"]]).await)?;
    if overlaps
        .iter()
        .any(|r| Some(r.get::<_, Uuid>(0)) != replacement)
    {
        return Err("기존 가져오기와 겹칩니다. 기존 출처를 명시적으로 선택해 교체하세요.".into());
    }
    if let Some(old) = replacement {
        let old_row=db(tx.query_opt("SELECT * FROM analytics_sources WHERE id=$1 AND source_kind='import' AND status='active' AND platform=$2 AND account_id=$3 FOR UPDATE",&[&old,&p,&a]).await)?.ok_or("교체할 활성 수동 보고서가 없습니다.")?;
        let meta = old_row.get::<_, Value>("metadata");
        if meta["timezone"] != payload["metadata"]["timezone"] {
            return Err("다른 시간대의 보고서는 교체할 수 없습니다.".into());
        }
        db(tx
            .execute(
                "UPDATE analytics_sources SET status='replaced',removed_at=now() WHERE id=$1",
                &[&old],
            )
            .await)?;
    }
    let source_id = Uuid::new_v4();
    let label = required(&payload, "label", 256)?;
    let filename = required(&payload, "filename", 256)?;
    db(tx.execute("INSERT INTO analytics_sources(id,source_kind,platform,account_id,label,filename,digest,metadata) VALUES($1,'import',$2,$3,$4,$5,$6,$7)",&[&source_id,&p,&a,&label,&filename,&hash,&payload["metadata"]]).await)?;
    for o in &observations {
        insert_observation(&tx, &source_id, o).await?;
    }
    let record = source(&db(tx
        .query_one("SELECT * FROM analytics_sources WHERE id=$1", &[&source_id])
        .await)?);
    db(tx.commit().await)?;
    Ok(
        json!({"source":record,"idempotent":false,"replacedSourceId":replacement.map(|id|id.to_string())}),
    )
}
async fn remove_import(config: &AppConfig, input: &Value) -> Result<Value, String> {
    let id = Uuid::parse_str(&required(input, "sourceId", 36)?).map_err(|_| "출처 ID 오류")?;
    let mut session = social::database(config).await?;
    ensure(&session.client).await?;
    let tx = db(session.client.transaction().await)?;
    let row = db(tx
        .query_opt(
            "SELECT source_kind FROM analytics_sources WHERE id=$1 FOR UPDATE",
            &[&id],
        )
        .await)?
    .ok_or("출처를 찾을 수 없습니다.")?;
    if row.get::<_, String>(0) != "import" {
        return Err("API 수집 자료는 가져오기 삭제로 제거할 수 없습니다.".into());
    }
    db(tx
        .execute(
            "DELETE FROM analytics_observations WHERE source_id=$1",
            &[&id],
        )
        .await)?;
    db(tx.execute("UPDATE analytics_sources SET status='removed',removed_at=COALESCE(removed_at,now()) WHERE id=$1",&[&id]).await)?;
    db(tx.commit().await)?;
    Ok(json!({"removed":true,"sourceId":id.to_string()}))
}

pub async fn dispatch(config: &AppConfig, input: Value) -> Result<Value, String> {
    match input["action"].as_str().unwrap_or("") {
        "status" => status(config).await,
        "applySchema" => {
            crate::ops::migrate_configured_publications(config).await?;
            status(config).await
        }
        "query" => query(config, &input).await,
        "reportQuery" => report_query(config, &input).await,
        "sources" => sources(config, &input, false).await,
        "importHistory" => sources(config, &input, true).await,
        "importPreview" => import_preview(config, &input).await,
        "importCommit" => import_commit(config, &input).await,
        "importRemove" => remove_import(config, &input).await,
        "pause" => {
            let paused = input["paused"].as_bool().ok_or("paused 값이 필요합니다.")?;
            let session = social::database(config).await?;
            ensure(&session.client).await?;
            db(session
                .client
                .execute(
                    "UPDATE analytics_settings SET paused=$1 WHERE singleton",
                    &[&paused],
                )
                .await)?;
            SYNC_PAUSED.store(paused, Ordering::SeqCst);
            drop(session);
            status(config).await
        }
        "sync" => sync(config, input["connectionId"].as_str()).await,
        "deleteApiCache" => {
            let connection = required(&input, "connectionId", 128)?;
            let account = input["accountId"].as_str();
            let mut session = social::database(config).await?;
            ensure(&session.client).await?;
            let tx = db(session.client.transaction().await)?;
            // Lock/delete the job before its source so a concurrent finished collector cannot recreate a cache after this transaction.
            db(tx.execute("DELETE FROM analytics_jobs WHERE connection_id=$1 AND ($2::text IS NULL OR account_id=$2)",&[&connection,&account]).await)?;
            let count=db(tx.execute("DELETE FROM analytics_sources WHERE source_kind='api' AND connection_id=$1 AND ($2::text IS NULL OR account_id=$2)",&[&connection,&account]).await)?;
            db(tx.commit().await)?;
            Ok(json!({"deletedSources":count}))
        }
        _ => Err("지원하지 않는 분석 작업입니다.".into()),
    }
}

/// Call at launch, resume, and every six hours while running. Never creates schema or an OAuth session.
pub async fn sync_due(config: &AppConfig) -> Result<Value, String> {
    sync(config, None).await
}
async fn sync(config: &AppConfig, manual: Option<&str>) -> Result<Value, String> {
    let mut session = social::database(config).await?;
    ensure(&session.client).await?;
    let is_paused = paused(&session.client).await?;
    SYNC_PAUSED.store(is_paused, Ordering::SeqCst);
    if is_paused {
        return Ok(json!({"jobs":jobs(&session.client).await?,"paused":true}));
    }
    let connections = crate::oauth::connections().await?;
    for c in connections["connections"]
        .as_array()
        .into_iter()
        .flatten()
        .take(100)
    {
        if !c["identityVerified"].as_bool().unwrap_or(false) {
            continue;
        }
        let (Some(id), Some(p), Some(a)) = (
            c["connectionId"].as_str(),
            c["platform"].as_str(),
            c["accountId"].as_str(),
        ) else {
            continue;
        };
        if !providers::supported(p) || manual.is_some_and(|m| m != id) {
            continue;
        }
        if !c["connected"].as_bool().unwrap_or(false)
            && !c["refreshable"].as_bool().unwrap_or(false)
        {
            db(session.client.execute("UPDATE analytics_jobs SET status='reconnect_required',message='이 계정을 다시 연결하세요. 저장된 분석 자료는 유지됩니다.',updated_at=now() WHERE connection_id=$1 AND platform=$2 AND account_id=$3",&[&id,&p,&a]).await)?;
            continue;
        }
        db(session.client.execute("INSERT INTO analytics_jobs(connection_id,platform,account_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",&[&id,&p,&a]).await)?;
        let lease = Uuid::new_v4();
        let claimed=db(session.client.query_opt("UPDATE analytics_jobs SET status='running',lease_token=$5,lease_until=now()+interval '10 minutes',updated_at=now() WHERE connection_id=$1 AND platform=$2 AND account_id=$3 AND (lease_until IS NULL OR lease_until<now()) AND (next_sync_at<=now() OR ($4 AND status<>'rate_limited')) RETURNING *",&[&id,&p,&a,&manual.is_some(),&lease]).await)?;
        let Some(row) = claimed else {
            continue;
        };
        // Scoped access validates the exact verified account and scopes; failure never falls back to another token.
        let access = crate::oauth::scoped_access(id, p, a, providers::required_scopes(p)).await;
        let outcome = match access {
            Ok(access) => providers::collect(p, a, &access.token, row.get("cursor")).await,
            Err(_) => Err(providers::Failure::permission()),
        };
        match outcome {
            Ok(batch) => {
                let tx = db(session.client.transaction().await)?;
                if db(tx.query_opt("SELECT 1 FROM analytics_jobs WHERE connection_id=$1 AND platform=$2 AND account_id=$3 AND lease_token=$4 AND lease_until>now() FOR UPDATE",&[&id,&p,&a,&lease]).await)?.is_none(){continue;}
                let source_id = Uuid::new_v4();
                let hash = format!("api:{id}:{p}:{a}");
                let metadata = json!({"apiVersion":batch.api_version,"coverage":batch.coverage});
                let source_row=db(tx.query_one("INSERT INTO analytics_sources(id,source_kind,platform,account_id,connection_id,label,digest,metadata) VALUES($1,'api',$2,$3,$4,$5,$6,$7) ON CONFLICT(source_kind,platform,account_id,digest) DO UPDATE SET metadata=EXCLUDED.metadata,status='active' RETURNING id",&[&source_id,&p,&a,&id,&format!("{p} API"),&hash,&metadata]).await)?;
                let actual: Uuid = source_row.get(0);
                for mut o in batch.observations {
                    o.connection_id = Some(id.into());
                    insert_observation(&tx, &actual, &o).await?;
                }
                db(tx.execute("UPDATE analytics_jobs SET status=$4,last_sync_at=now(),next_sync_at=now()+($8::bigint*interval '1 second'),cursor=$5,coverage=$6,message=$7,lease_until=NULL,lease_token=NULL,updated_at=now() WHERE connection_id=$1 AND platform=$2 AND account_id=$3",&[&id,&p,&a,&batch.status,&batch.cursor,&batch.coverage,&batch.message,&batch.next_sync_secs]).await)?;
                db(tx.commit().await)?;
            }
            Err(failure) => {
                let wait = failure.retry_after_secs.clamp(60, 86400);
                db(session.client.execute("UPDATE analytics_jobs SET status=$4,next_sync_at=now()+($5::bigint*interval '1 second'),message=$6,lease_until=NULL,lease_token=NULL,updated_at=now() WHERE connection_id=$1 AND platform=$2 AND account_id=$3 AND lease_token=$7",&[&id,&p,&a,&failure.status,&wait,&failure.message,&lease]).await)?;
            }
        }
        if paused(&session.client).await? {
            break;
        }
    }
    Ok(json!({"jobs":jobs(&session.client).await?,"paused":paused(&session.client).await?}))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn metric_exclusions_do_not_block_organic_impressions() {
        assert!(excluded_metric("estimatedRevenue"));
        assert!(excluded_metric("ad_impressions"));
        assert!(!excluded_metric("video_thumbnail_impressions"));
    }
    #[test]
    fn snapshot_keys_preserve_only_actual_observations() {
        let mut o = Observation {
            platform: "tiktok".into(),
            account_id: "a".into(),
            connection_id: None,
            source_kind: "api".into(),
            metric: "view_count".into(),
            definition: "d".into(),
            unit: "count".into(),
            aggregation: "snapshot".into(),
            period_start: "2026-10-01".into(),
            period_end: "2026-10-01".into(),
            timezone: "UTC".into(),
            content_id: "v".into(),
            dimensions: json!({}),
            value: Some(0.),
            status: "available".into(),
            observed_at: "2026-10-01T00:00:00Z".into(),
            api_version: "v2".into(),
            provenance: json!({}),
        };
        let first = observation_key(&o);
        o.observed_at = "2026-10-01T06:00:00Z".into();
        assert_ne!(first, observation_key(&o));
        o.aggregation = "period".into();
        let first = observation_key(&o);
        o.observed_at = "2026-10-01T12:00:00Z".into();
        assert_eq!(first, observation_key(&o));
    }
}

async fn report_query(config: &AppConfig, input: &Value) -> Result<Value, String> {
    let connection = required(input, "connectionId", 128)?;
    let p = platform(input)?;
    let account = required(input, "accountId", 256)?;
    if !providers::supported(&p) {
        return Err("이 플랫폼의 분석은 수동 보고서 가져오기를 이용하세요.".into());
    }
    providers::validate_report(&p, input).map_err(|failure| failure.message)?;
    let mut session = social::database(config).await?;
    ensure(&session.client).await?;
    if paused(&session.client).await? {
        return Err("분석 수집이 일시 정지되었습니다. 다시 시작한 뒤 요청하세요.".into());
    }
    SYNC_PAUSED.store(false, Ordering::SeqCst);
    db(session.client.execute("INSERT INTO analytics_jobs(connection_id,platform,account_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",&[&connection,&p,&account]).await)?;
    let lease = Uuid::new_v4();
    let claimed=db(session.client.query_opt("UPDATE analytics_jobs SET lease_token=$4,lease_until=now()+interval '10 minutes',updated_at=now() WHERE connection_id=$1 AND platform=$2 AND account_id=$3 AND (lease_until IS NULL OR lease_until<now()) AND (status<>'rate_limited' OR next_sync_at<=now()) RETURNING connection_id",&[&connection,&p,&account,&lease]).await)?;
    if claimed.is_none() {
        return Err("이 계정의 수집이 진행 중이거나 공급자 재시도 대기 중입니다. 표시된 다음 시점을 확인하세요.".into());
    }
    let outcome = match crate::oauth::scoped_access(
        &connection,
        &p,
        &account,
        providers::required_scopes(&p),
    )
    .await
    {
        Ok(access) => providers::report(&p, &account, &access.token, input).await,
        Err(_) => Err(providers::Failure::permission()),
    };
    let mut batch = match outcome {
        Ok(batch) => batch,
        Err(failure) => {
            db(session.client.execute("UPDATE analytics_jobs SET status=$5,message=$6,next_sync_at=now()+($7::bigint*interval '1 second'),lease_until=NULL,lease_token=NULL,updated_at=now() WHERE connection_id=$1 AND platform=$2 AND account_id=$3 AND lease_token=$4",&[&connection,&p,&account,&lease,&failure.status,&failure.message,&failure.retry_after_secs]).await)?;
            return Err(failure.message);
        }
    };
    let tx = db(session.client.transaction().await)?;
    if db(tx.query_opt("SELECT 1 FROM analytics_jobs WHERE connection_id=$1 AND platform=$2 AND account_id=$3 AND lease_token=$4 AND lease_until>now() FOR UPDATE",&[&connection,&p,&account,&lease]).await)?.is_none(){return Err("수집 작업이 취소되거나 캐시가 삭제되었습니다. 결과를 다시 저장하지 않았습니다.".into());}
    let source_id = Uuid::new_v4();
    let hash = format!("api:{connection}:{p}:{account}");
    let metadata = json!({"apiVersion":batch.api_version,"coverage":batch.coverage});
    let row=db(tx.query_one("INSERT INTO analytics_sources(id,source_kind,platform,account_id,connection_id,label,digest,metadata) VALUES($1,'api',$2,$3,$4,$5,$6,$7) ON CONFLICT(source_kind,platform,account_id,digest) DO UPDATE SET metadata=EXCLUDED.metadata RETURNING id",&[&source_id,&p,&account,&connection,&format!("{p} API"),&hash,&metadata]).await)?;
    let actual: Uuid = row.get(0);
    for o in &mut batch.observations {
        o.connection_id = Some(connection.clone());
        insert_observation(&tx, &actual, o).await?;
    }
    db(tx.execute("UPDATE analytics_jobs SET status=$5,last_sync_at=now(),next_sync_at=now()+($6::bigint*interval '1 second'),coverage=coverage||jsonb_build_object('lastReport',$7::jsonb),cursor=cursor||jsonb_build_object('manualReport',$8::jsonb),message=$9,lease_until=NULL,lease_token=NULL,updated_at=now() WHERE connection_id=$1 AND platform=$2 AND account_id=$3 AND lease_token=$4",&[&connection,&p,&account,&lease,&batch.status,&batch.next_sync_secs,&batch.coverage,&batch.cursor,&batch.message]).await)?;
    db(tx.commit().await)?;
    Ok(
        json!({"sourceId":actual.to_string(),"observations":batch.observations,"coverage":batch.coverage,"status":batch.status,"message":batch.message,"nextCursor":batch.cursor}),
    )
}
