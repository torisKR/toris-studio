//! Persistent, approval-bound per-target publishing queue. A process-held file
//! lock elects one scheduler across app instances; SQL claims and unique jobs
//! prevent repeated publication of a successful target.
use crate::config::AppConfig;
use chrono::{DateTime, Utc};
use fs2::FileExt;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::Write,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, OnceLock,
    },
};
use tokio_postgres::{Row, Transaction};
use uuid::Uuid;

const DB_ERROR: &str =
    "일괄 게시 저장소를 사용할 수 없습니다. 로컬 DB를 시작하고 스키마를 갱신하세요.";
static EXECUTION: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
static RUNNING: AtomicBool = AtomicBool::new(false);
static RECOVERED: AtomicBool = AtomicBool::new(false);
static SHUTTING_DOWN: AtomicBool = AtomicBool::new(false);
static PAUSE_WAS_ACTIVE: AtomicBool = AtomicBool::new(false);
static RUNTIME: OnceLock<Mutex<Option<fs::File>>> = OnceLock::new();
static LAST_TICK: OnceLock<Mutex<Option<DateTime<Utc>>>> = OnceLock::new();
static LAST_PULSE: OnceLock<Mutex<Option<DateTime<Utc>>>> = OnceLock::new();
static SLEEP_GAP: AtomicBool = AtomicBool::new(false);
static LEASES: OnceLock<
    Mutex<
        std::collections::HashMap<Uuid, (std::time::Instant, crate::publication_media::MediaLease)>,
    >,
> = OnceLock::new();
pub fn shutdown_media() {
    if let Some(leases) = LEASES.get() {
        if let Ok(mut leases) = leases.lock() {
            leases.clear();
        }
    }
}
fn release_media(id: Uuid) {
    if let Some(leases) = LEASES.get() {
        if let Ok(mut leases) = leases.lock() {
            leases.remove(&id);
        }
    }
}
pub fn running() -> bool {
    RUNNING.load(Ordering::SeqCst)
        || LEASES
            .get()
            .is_some_and(|leases| leases.lock().is_ok_and(|leases| !leases.is_empty()))
}
pub fn lock_for_update() -> Result<tokio::sync::MutexGuard<'static, ()>, String> {
    let guard = EXECUTION.try_lock().map_err(|_| {
        "게시 처리 중입니다. 전송 결과가 확인된 뒤 업데이트하거나 종료하세요.".to_string()
    })?;
    if SHUTTING_DOWN.load(Ordering::SeqCst) {
        return Err("앱이 종료 중입니다. 다시 실행한 뒤 작업하세요.".into());
    }
    Ok(guard)
}
pub fn begin_shutdown() -> bool {
    let Ok(_guard) = EXECUTION.try_lock() else {
        return false;
    };
    if running() {
        return false;
    }
    SHUTTING_DOWN.store(true, Ordering::SeqCst);
    true
}
struct Active;
impl Active {
    fn new() -> Self {
        RUNNING.store(true, Ordering::SeqCst);
        Self
    }
}
impl Drop for Active {
    fn drop(&mut self) {
        RUNNING.store(false, Ordering::SeqCst);
    }
}
struct TickCompleted;
impl Drop for TickCompleted {
    fn drop(&mut self) {
        if let Some(last) = LAST_TICK.get() {
            if let Ok(mut last) = last.lock() {
                *last = Some(Utc::now());
            }
        }
    }
}
fn pulse_gap(previous: &mut Option<DateTime<Utc>>, now: DateTime<Utc>) -> bool {
    let gap = previous.is_some_and(|before| (now - before).num_seconds() > 90);
    *previous = Some(now);
    gap
}
/// The desktop calls this from a separate task, so a long SNS request does not
/// hide a genuine suspend/resume gap that occurs while that request is pending.
pub fn heartbeat() {
    if let Ok(mut previous) = LAST_PULSE.get_or_init(|| Mutex::new(None)).lock() {
        if pulse_gap(&mut previous, Utc::now()) {
            SLEEP_GAP.store(true, Ordering::SeqCst);
        }
    }
}
async fn confirm_sleep_gap(client: &tokio_postgres::Client) -> Result<bool, String> {
    heartbeat();
    if !SLEEP_GAP.swap(false, Ordering::SeqCst) {
        return Ok(false);
    }
    let update=client.execute("UPDATE publication_jobs SET status='needs_confirmation',error='절전 또는 중단 중 놓친 예약입니다. 다시 승인하세요.',updated_at=now() WHERE status='scheduled' AND scheduled_at<=now()",&[]).await;
    if update.is_err() {
        SLEEP_GAP.store(true, Ordering::SeqCst);
    }
    db(update)?;
    Ok(true)
}
fn state_path() -> Result<PathBuf, String> {
    Ok(crate::publication_media::root_dir()?
        .parent()
        .ok_or("게시 설정 경로 오류")?
        .join("publication-scheduler.json"))
}
fn paused() -> bool {
    let Ok(path) = state_path() else {
        return true;
    };
    match fs::read(path) {
        Ok(bytes) => serde_json::from_slice::<Value>(&bytes)
            .ok()
            .and_then(|v| v["paused"].as_bool())
            .unwrap_or(true),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => false,
        Err(_) => true,
    }
}
pub fn set_pause(value: bool) -> Result<Value, String> {
    let path = state_path()?;
    let mut file = tempfile::NamedTempFile::new_in(path.parent().ok_or("게시 설정 경로 오류")?)
        .map_err(|_| "예약 설정 파일 생성 실패")?;
    file.write_all(json!({"paused":value}).to_string().as_bytes())
        .and_then(|_| file.as_file().sync_all())
        .map_err(|_| "예약 설정 저장 실패")?;
    file.persist(path).map_err(|_| "예약 설정 저장 실패")?;
    if value {
        PAUSE_WAS_ACTIVE.store(true, Ordering::SeqCst);
    }
    Ok(scheduler_status())
}
pub fn scheduler_status() -> Value {
    let pause = paused();
    let last = LAST_TICK.get().and_then(|m| m.lock().ok().and_then(|v| *v));
    json!({"paused":pause,"running":running(),"lastTickAt":last.map(|v|v.to_rfc3339()),"message":if pause{"예약 게시가 일시정지되었습니다."}else if running(){"승인한 콘텐츠를 처리하고 있습니다."}else{"앱이 실행 중인 동안 승인한 예약을 확인합니다."}})
}
fn scheduler_owner() -> Result<bool, String> {
    let mut holder = RUNTIME
        .get_or_init(|| Mutex::new(None))
        .lock()
        .map_err(|_| "예약 실행 잠금 오류")?;
    if holder.is_some() {
        return Ok(true);
    }
    let path = state_path()?.with_extension("lock");
    if fs::symlink_metadata(&path).is_ok_and(|m| !m.is_file() || m.file_type().is_symlink()) {
        return Err("예약 잠금 파일 형식 오류".into());
    }
    let mut options = fs::OpenOptions::new();
    options.read(true).write(true).create(true).truncate(false);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let file = options
        .open(path)
        .map_err(|_| "예약 실행 잠금 파일 생성 실패")?;
    if file.try_lock_exclusive().is_err() {
        return Ok(false);
    }
    *holder = Some(file);
    Ok(true)
}
fn uuid(value: &str) -> Result<Uuid, String> {
    Uuid::parse_str(value).map_err(|_| "게시 식별자가 올바르지 않습니다.".into())
}
fn db<T>(value: Result<T, tokio_postgres::Error>) -> Result<T, String> {
    value.map_err(|_| DB_ERROR.into())
}
fn text(value: &Value, key: &str, max: usize, required: bool) -> Result<String, String> {
    let raw = value.get(key).and_then(Value::as_str).unwrap_or("").trim();
    if (required && raw.is_empty())
        || raw.chars().count() > max
        || raw
            .chars()
            .any(|c| c.is_control() && c != '\n' && c != '\t')
    {
        return Err(format!("{key} 내용과 길이를 확인하세요."));
    }
    Ok(raw.into())
}
fn words(value: &Value, key: &str) -> Result<Vec<String>, String> {
    let Some(raw) = value.get(key) else {
        return Ok(vec![]);
    };
    let array = raw
        .as_array()
        .filter(|v| v.len() <= 100)
        .ok_or_else(|| format!("{key}는 최대 100개 문자열 목록이어야 합니다."))?;
    array
        .iter()
        .map(|item| {
            let s = item.as_str().ok_or("태그는 문자열이어야 합니다.")?.trim();
            if s.is_empty() || s.chars().count() > 100 || s.chars().any(char::is_control) {
                return Err("태그 길이와 문자를 확인하세요.".into());
            }
            Ok(s.to_string())
        })
        .collect()
}
fn normalize(input: &Value) -> Result<Value, String> {
    if !input.is_object() || input.to_string().len() > 131072 {
        return Err("게시 초안 형식과 크기를 확인하세요.".into());
    }
    let title = text(input, "title", 300, true)?;
    let description = text(input, "description", 30000, false)?;
    let tags = words(input, "tags")?;
    let hashtags = words(input, "hashtags")?;
    let video = input["videoMediaId"].as_str().filter(|s| !s.is_empty());
    let thumbnail = input["thumbnailMediaId"].as_str().filter(|s| !s.is_empty());
    for raw in video.into_iter().chain(thumbnail) {
        uuid(raw)?;
    }
    let targets = input["targets"]
        .as_array()
        .filter(|v| v.len() <= 20)
        .ok_or("게시 대상은 최대 20개 목록이어야 합니다.")?;
    let mut seen = std::collections::HashSet::new();
    let mut accounts_seen = std::collections::HashSet::new();
    let mut normalized = Vec::new();
    for target in targets {
        let target_id = target["id"]
            .as_str()
            .ok_or("게시 대상 식별자를 확인하세요.")?;
        uuid(target_id)?;
        if !seen.insert(target_id) {
            return Err("중복된 게시 대상 식별자입니다.".into());
        }
        let platform = target["platform"]
            .as_str()
            .filter(|s| ["youtube", "instagram", "facebook", "threads", "tiktok"].contains(s))
            .ok_or("일괄 게시 플랫폼을 확인하세요.")?;
        let mode = target["mode"]
            .as_str()
            .filter(|s| ["manual", "scheduled", "tiktok_inbox"].contains(s))
            .ok_or("즉시·예약·TikTok 초안 전송 방식을 확인하세요.")?;
        if mode == "tiktok_inbox" && platform != "tiktok" {
            return Err("초안 전송은 TikTok에서만 지원합니다.".into());
        }
        let scheduled = target["scheduledAt"].as_str().filter(|s| !s.is_empty());
        if mode == "scheduled" {
            DateTime::parse_from_rfc3339(scheduled.ok_or("예약 시간을 선택하세요.")?)
                .map_err(|_| "예약 시간은 시간대가 포함된 날짜여야 합니다.")?;
        }
        let account = text(target, "accountId", 200, false)?;
        if !account.is_empty() && !accounts_seen.insert((platform.to_owned(), account.clone())) {
            return Err("같은 계정에 대한 게시 대상이 중복되었습니다.".into());
        }
        let account_title = text(target, "accountTitle", 200, false)?;
        let overrides = target
            .get("overrides")
            .cloned()
            .unwrap_or_else(|| json!({}));
        let options = target.get("options").cloned().unwrap_or_else(|| json!({}));
        if !overrides.is_object() || !options.is_object() || options.to_string().len() > 8192 {
            return Err("채널별 설정 형식을 확인하세요.".into());
        }
        for field in ["title", "description"] {
            if overrides.get(field).is_some() {
                text(
                    &overrides,
                    field,
                    if field == "title" { 300 } else { 30000 },
                    false,
                )?;
            }
        }
        for field in ["tags", "hashtags"] {
            if overrides.get(field).is_some() {
                words(&overrides, field)?;
            }
        }
        normalized.push(json!({"id":target_id,"platform":platform,"accountId":account,"accountTitle":account_title,"mode":mode,"scheduledAt":scheduled,"overrides":overrides,"options":options}));
    }
    Ok(
        json!({"title":title,"description":description,"tags":tags,"hashtags":hashtags,"videoMediaId":video,"thumbnailMediaId":thumbnail,"targets":normalized}),
    )
}
fn job(row: &Row) -> Value {
    let result: Option<Value> = row.get("result");
    let result = result.unwrap_or(Value::Null);
    let snapshot: Value = row.get("snapshot");
    json!({"id":row.get::<_,Uuid>("id").to_string(),"targetId":row.get::<_,Uuid>("target_id").to_string(),"platform":snapshot["platform"],"accountId":snapshot["accountId"],"accountTitle":snapshot["accountTitle"],"revision":row.get::<_,i32>("revision"),"status":row.get::<_,String>("status"),"mode":row.get::<_,String>("mode"),"scheduledAt":row.get::<_,Option<DateTime<Utc>>>("scheduled_at").map(|v|v.to_rfc3339()),"externalId":result["externalId"],"url":result["url"],"error":row.get::<_,Option<String>>("error"),"warnings":result.get("warnings").cloned().unwrap_or_else(||json!([])),"thumbnailStatus":result["thumbnailStatus"],"retryable":row.get::<_,bool>("retryable"),"updatedAt":row.get::<_,DateTime<Utc>>("updated_at").to_rfc3339()})
}
fn publication(row: &Row, jobs: Vec<Value>) -> Value {
    let mut value: Value = row.get("payload");
    if let Some(obj) = value.as_object_mut() {
        obj.insert("id".into(), json!(row.get::<_, Uuid>("id").to_string()));
        obj.insert("revision".into(), json!(row.get::<_, i32>("revision")));
        obj.insert(
            "createdAt".into(),
            json!(row.get::<_, DateTime<Utc>>("created_at").to_rfc3339()),
        );
        obj.insert(
            "updatedAt".into(),
            json!(row.get::<_, DateTime<Utc>>("updated_at").to_rfc3339()),
        );
        obj.insert("jobs".into(), json!(jobs));
    }
    value
}
pub async fn list(config: &AppConfig) -> Result<Value, String> {
    let dbs = crate::social::database(config).await?;
    let rows = db(dbs
        .client
        .query(
            "SELECT * FROM publications ORDER BY updated_at DESC LIMIT 200",
            &[],
        )
        .await)?;
    let jobs = db(dbs
        .client
        .query(
            "SELECT * FROM publication_jobs ORDER BY updated_at DESC LIMIT 4000",
            &[],
        )
        .await)?;
    let publications = rows
        .iter()
        .map(|row| {
            let id: Uuid = row.get("id");
            publication(
                row,
                jobs.iter()
                    .filter(|j| j.get::<_, Uuid>("publication_id") == id)
                    .map(job)
                    .collect(),
            )
        })
        .collect::<Vec<_>>();
    Ok(
        json!({"publications":publications,"media":crate::publication_media::list()?,"scheduler":scheduler_status()}),
    )
}
pub async fn get(config: &AppConfig, raw: &str) -> Result<Value, String> {
    let id = uuid(raw)?;
    let dbs = crate::social::database(config).await?;
    let row = db(dbs
        .client
        .query_opt("SELECT * FROM publications WHERE id=$1", &[&id])
        .await)?
    .ok_or("게시 초안을 찾을 수 없습니다.")?;
    let jobs = db(dbs
        .client
        .query(
            "SELECT * FROM publication_jobs WHERE publication_id=$1 ORDER BY updated_at DESC",
            &[&id],
        )
        .await)?;
    Ok(publication(&row, jobs.iter().map(job).collect()))
}
pub async fn save(config: &AppConfig, input: Value) -> Result<Value, String> {
    let _guard = lock_for_update()?;
    let payload = normalize(&input)?;
    let expected = input["revision"].as_i64().unwrap_or(0);
    let id = input["id"]
        .as_str()
        .map(uuid)
        .transpose()?
        .unwrap_or_else(Uuid::new_v4);
    let mut dbs = crate::social::database(config).await?;
    let tx = db(dbs.client.transaction().await)?;
    if let Some(row) = db(tx
        .query_opt(
            "SELECT revision FROM publications WHERE id=$1 FOR UPDATE",
            &[&id],
        )
        .await)?
    {
        let current: i32 = row.get("revision");
        if expected != current as i64 {
            return Err("다른 화면에서 초안이 변경되었습니다. 다시 불러오세요.".into());
        }
        if db(tx.query_opt("SELECT id FROM publication_jobs WHERE publication_id=$1 AND status IN ('sending','processing','uncertain') LIMIT 1",&[&id]).await)?.is_some(){return Err("전송 중이거나 결과 확인이 필요한 초안은 수정할 수 없습니다. 결과를 먼저 확인하세요.".into());}
        let revision = current.checked_add(1).ok_or("초안 수정 횟수 제한")?;
        db(tx
            .execute(
                "UPDATE publications SET payload=$2,revision=$3,updated_at=now() WHERE id=$1",
                &[&id, &payload, &revision],
            )
            .await)?;
        db(tx.execute("UPDATE publication_jobs SET status='cancelled',error='초안 수정으로 기존 승인이 취소되었습니다.',updated_at=now() WHERE publication_id=$1 AND status IN ('queued','scheduled','needs_confirmation','failed')",&[&id]).await)?;
    } else {
        if expected != 0 {
            return Err("게시 초안이 없습니다. 다시 불러오세요.".into());
        }
        db(tx
            .execute(
                "INSERT INTO publications(id,payload)VALUES($1,$2)",
                &[&id, &payload],
            )
            .await)?;
    }
    db(tx.commit().await)?;
    get(config, &id.to_string()).await
}
fn selection(publication: &Value, input: &Value) -> Result<Vec<String>, String> {
    let available = publication["targets"]
        .as_array()
        .ok_or("게시 대상 정보 오류")?;
    let chosen = match input.get("targetIds") {
        Some(v) => v
            .as_array()
            .ok_or("게시 대상 목록을 확인하세요.")?
            .iter()
            .map(|v| v.as_str().map(str::to_owned).ok_or("게시 대상 식별자 오류"))
            .collect::<Result<Vec<_>, _>>()?,
        None => available
            .iter()
            .filter_map(|v| v["id"].as_str().map(str::to_owned))
            .collect(),
    };
    if chosen.is_empty() || chosen.len() > 20 {
        return Err("게시할 채널을 선택하세요.".into());
    }
    let mut unique = std::collections::HashSet::new();
    for id in &chosen {
        uuid(id)?;
        if !unique.insert(id) || !available.iter().any(|t| t["id"] == *id) {
            return Err("게시 대상이 중복되거나 초안과 일치하지 않습니다.".into());
        }
    }
    Ok(chosen)
}
fn merged(publication: &Value, target: &Value) -> Value {
    let mut plan = json!({"platform":target["platform"],"accountId":target["accountId"],"accountTitle":target["accountTitle"],"mode":target["mode"],"scheduledAt":target["scheduledAt"],"options":target["options"],"title":publication["title"],"description":publication["description"],"tags":publication["tags"],"hashtags":publication["hashtags"],"videoMediaId":publication["videoMediaId"],"thumbnailMediaId":publication["thumbnailMediaId"]});
    for field in ["title", "description", "tags", "hashtags"] {
        if let Some(value) = target["overrides"].get(field) {
            plan[field] = value.clone();
        }
    }
    plan
}
fn media_for(publication: &Value) -> Result<(Value, Option<Value>), String> {
    let raw = publication["videoMediaId"]
        .as_str()
        .ok_or("MP4 영상을 먼저 가져오세요.")?;
    crate::publication_media::private_path(raw)?;
    let video = crate::publication_media::metadata(raw)?;
    if video["kind"] != "video" {
        return Err("영상 미디어를 선택하세요.".into());
    }
    let thumbnail = publication["thumbnailMediaId"]
        .as_str()
        .map(|raw| -> Result<Value, String> {
            crate::publication_media::private_path(raw)?;
            let m = crate::publication_media::metadata(raw)?;
            if m["kind"] != "thumbnail" {
                return Err("썸네일 미디어를 선택하세요.".into());
            }
            Ok(m)
        })
        .transpose()?;
    Ok((video, thumbnail))
}
fn hash_approval(
    publication: &Value,
    selected: &[String],
    video: &Value,
    thumbnail: &Option<Value>,
) -> String {
    let mut targets = selected.to_vec();
    targets.sort();
    format!("{:x}",Sha256::digest(json!({"publication":publication,"targets":targets,"video":video,"thumbnail":thumbnail}).to_string().as_bytes()))
}
fn approval_publication(publication: &Value) -> Value {
    let mut value = publication.clone();
    if let Some(obj) = value.as_object_mut() {
        for field in ["jobs", "createdAt", "updatedAt"] {
            obj.remove(field);
        }
    }
    value
}
pub async fn preflight(config: &AppConfig, input: Value) -> Result<Value, String> {
    let publication = get(
        config,
        input["publicationId"]
            .as_str()
            .ok_or("게시 초안을 선택하세요.")?,
    )
    .await?;
    if input["revision"] != publication["revision"] {
        return Err("초안이 변경되었습니다. 다시 확인하세요.".into());
    }
    let selected = selection(&publication, &input)?;
    let (video, thumbnail) = media_for(&publication)?;
    let mut checks = Vec::new();
    for target in publication["targets"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|t| selected.iter().any(|id| t["id"] == *id))
    {
        let target_id = target["id"].as_str().unwrap();
        let success = publication["jobs"].as_array().is_some_and(|jobs| {
            jobs.iter().any(|j| {
                (j["targetId"] == target_id
                    || (j["platform"] == target["platform"]
                        && j["accountId"] == target["accountId"]))
                    && [
                        "published",
                        "draft_sent",
                        "sending",
                        "processing",
                        "uncertain",
                    ]
                    .contains(&j["status"].as_str().unwrap_or(""))
            })
        });
        let scheduled = target["mode"] == "scheduled";
        let future = !scheduled
            || target["scheduledAt"]
                .as_str()
                .and_then(|s| DateTime::parse_from_rfc3339(s).ok())
                .is_some_and(|s| s > Utc::now());
        if success || !future || target["accountId"].as_str().unwrap_or("").is_empty() {
            checks.push(json!({"targetId":target_id,"ready":false,"message":if success{"이 채널은 이미 전송되었거나 결과 확인 중입니다."}else if !future{"예약 시간을 현재보다 이후로 선택하세요."}else{"게시 계정을 선택하세요."},"details":{}}));
            continue;
        }
        let mut plan = merged(&publication, target);
        plan["video"] = video.clone();
        plan["thumbnail"] = thumbnail.clone().unwrap_or(Value::Null);
        let checked = crate::publishing_adapters::preflight(&plan).await;
        match checked {
            Ok(value) => {
                let ready = value["ready"].as_bool().unwrap_or(false);
                checks.push(json!({"targetId":target_id,"ready":ready,"message":value.get("message").cloned().unwrap_or_else(||json!(if ready{"게시 계정과 필수 조건을 확인했습니다."}else{"게시 조건을 확인하세요."})),"details":value}));
            }
            Err(message) => checks
                .push(json!({"targetId":target_id,"ready":false,"message":message,"details":{}})),
        }
    }
    Ok(
        json!({"publicationId":publication["id"],"revision":publication["revision"],"approvalHash":hash_approval(&approval_publication(&publication),&selected,&video,&thumbnail),"ready":checks.iter().all(|v|v["ready"]==true),"checks":checks,"media":{"video":video,"thumbnail":thumbnail}}),
    )
}
pub async fn submit(config: &AppConfig, input: Value) -> Result<Value, String> {
    let _guard = lock_for_update()?;
    if scheduler_owner()? {
        recover_locked(config).await?;
    }
    if input["confirmed"] != true {
        return Err("채널별 미리보기와 게시 내용을 확인하고 승인하세요.".into());
    }
    let checked = preflight(config, input.clone()).await?;
    if checked["ready"] != true {
        return Err("게시 사전 검사에 실패했습니다. 각 채널의 안내를 확인하세요.".into());
    }
    if input["approvalHash"] != checked["approvalHash"] {
        return Err("승인한 초안·파일이 변경되었습니다. 미리보기를 다시 확인하세요.".into());
    }
    let publication = get(config, input["publicationId"].as_str().unwrap()).await?;
    let selected = selection(&publication, &input)?;
    let id = uuid(publication["id"].as_str().unwrap())?;
    let revision = publication["revision"].as_i64().unwrap() as i32;
    let mut dbs = crate::social::database(config).await?;
    let tx = db(dbs.client.transaction().await)?;
    let current = db(tx
        .query_one(
            "SELECT revision FROM publications WHERE id=$1 FOR UPDATE",
            &[&id],
        )
        .await)?
    .get::<_, i32>(0);
    if current != revision {
        return Err("초안이 변경되었습니다. 다시 승인하세요.".into());
    }
    for target in publication["targets"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|t| selected.iter().any(|id| t["id"] == *id))
    {
        let target_id = uuid(target["id"].as_str().unwrap())?;
        let mut snapshot = merged(&publication, target);
        snapshot["video"] = checked["media"]["video"].clone();
        snapshot["thumbnail"] = checked["media"]["thumbnail"].clone();
        let mode = target["mode"].as_str().unwrap();
        let scheduled = if mode == "scheduled" {
            Some(
                DateTime::parse_from_rfc3339(target["scheduledAt"].as_str().unwrap())
                    .map_err(|_| "예약 시간 오류")?
                    .with_timezone(&Utc),
            )
        } else {
            None
        };
        let status = if mode == "scheduled" {
            "scheduled"
        } else {
            "queued"
        };
        let hash = checked["approvalHash"].as_str().unwrap();
        let job_id = Uuid::new_v4();
        let exists=db(tx.query_opt("SELECT status FROM publication_jobs WHERE publication_id=$1 AND revision=$2 AND target_id=$3",&[&id,&revision,&target_id]).await)?;
        if let Some(existing) = exists {
            let existing: String = existing.get(0);
            if !["cancelled", "needs_confirmation"].contains(&existing.as_str()) {
                return Err("이미 승인한 게시 대상입니다. 처리 결과를 확인하세요.".into());
            }
            db(tx.execute("UPDATE publication_jobs SET snapshot=$4,approval_hash=$5,status=$6,mode=$7,scheduled_at=$8,error=NULL,retryable=false,updated_at=now() WHERE publication_id=$1 AND revision=$2 AND target_id=$3",&[&id,&revision,&target_id,&snapshot,&hash,&status,&mode,&scheduled]).await)?;
        } else {
            db(tx.execute("INSERT INTO publication_jobs(id,publication_id,revision,target_id,approval_hash,snapshot,mode,scheduled_at,status)VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)",&[&job_id,&id,&revision,&target_id,&hash,&snapshot,&mode,&scheduled,&status]).await)?;
        }
    }
    db(tx.commit().await)?;
    get(config, &id.to_string()).await
}
async fn target_job(
    config: &AppConfig,
    input: &Value,
) -> Result<(Uuid, Value, String, Uuid), String> {
    let id = uuid(input["jobId"].as_str().ok_or("게시 작업을 선택하세요.")?)?;
    let dbs = crate::social::database(config).await?;
    let row = db(dbs
        .client
        .query_opt("SELECT * FROM publication_jobs WHERE id=$1", &[&id])
        .await)?
    .ok_or("게시 작업이 없습니다.")?;
    Ok((
        id,
        row.get("snapshot"),
        row.get("status"),
        row.get("publication_id"),
    ))
}
pub async fn cancel(config: &AppConfig, input: Value) -> Result<Value, String> {
    let (id, _, _, publication) = target_job(config, &input).await?;
    let dbs = crate::social::database(config).await?;
    if db(dbs.client.execute("UPDATE publication_jobs SET status='cancelled',updated_at=now() WHERE id=$1 AND status IN ('queued','scheduled','needs_confirmation','failed')",&[&id]).await)?==0{return Err("이미 전송 중이거나 완료된 작업은 취소할 수 없습니다.".into());}
    get(config, &publication.to_string()).await
}
pub async fn retry(config: &AppConfig, input: Value) -> Result<Value, String> {
    let _guard = lock_for_update()?;
    if scheduler_owner()? {
        recover_locked(config).await?;
    }
    if input["confirmed"] != true {
        return Err("재시도할 내용을 확인하고 승인하세요.".into());
    }
    let (id, _, status, publication) = target_job(config, &input).await?;
    if status != "failed" {
        return Err(
            "실패가 확정된 작업만 재시도할 수 있습니다. 불명확한 결과는 먼저 재확인하세요.".into(),
        );
    }
    let dbs = crate::social::database(config).await?;
    if db(dbs.client.execute("UPDATE publication_jobs j SET status='queued',error=NULL,updated_at=now() FROM publications p WHERE j.id=$1 AND p.id=j.publication_id AND p.revision=j.revision AND j.status='failed' AND j.retryable=true",&[&id]).await)?!=1{return Err("다시 승인해야 하거나 자동 재시도가 허용되지 않는 실패입니다.".into());}
    get(config, &publication.to_string()).await
}
pub async fn reconcile(config: &AppConfig, input: Value) -> Result<Value, String> {
    let _guard = lock_for_update()?;
    let _active = Active::new();
    let (id, mut plan, status, publication) = target_job(config, &input).await?;
    if !["uncertain", "processing"].contains(&status.as_str()) {
        return Err("결과 확인이 필요한 게시 작업만 재확인할 수 있습니다.".into());
    }
    let dbs = crate::social::database(config).await?;
    if let Some(resolution) = input["resolution"].as_str() {
        if status != "uncertain" || input["confirmed"] != true {
            return Err("불명확한 게시 결과를 외부 SNS에서 직접 확인한 뒤 동의하세요.".into());
        }
        match resolution {
            "not_published" => {
                db(dbs.client.execute("UPDATE publication_jobs SET status='needs_confirmation',remote=NULL,result=NULL,retryable=false,error='사용자가 외부 SNS에서 게시되지 않았음을 확인했습니다. 자동 재전송하지 않으며 다시 승인이 필요합니다.',updated_at=now() WHERE id=$1 AND status='uncertain'",&[&id]).await)?;
            }
            "published" => {
                let platform = plan["platform"].as_str().ok_or("게시 플랫폼 오류")?;
                let url = crate::social::validate_platform_url(
                    platform,
                    input["url"]
                        .as_str()
                        .ok_or("외부 SNS에서 확인한 실제 게시 URL을 입력하세요.")?,
                )?;
                let external_id = text(&input, "externalId", 200, false)?;
                let result = json!({"status":"published","url":url,"externalId":if external_id.is_empty(){Value::Null}else{json!(external_id)},"verification":"user_confirmed","warnings":["사용자가 외부 SNS에서 게시를 확인했습니다. API로 검증한 결과가 아닙니다."],"thumbnailStatus":"unknown"});
                db(dbs.client.execute("UPDATE publication_jobs SET status='published',result=$2,retryable=false,error=NULL,updated_at=now() WHERE id=$1 AND status='uncertain'",&[&id,&result]).await)?;
            }
            _ => return Err("게시 결과 확인 방식을 선택하세요.".into()),
        }
        release_media(id);
        return get(config, &publication.to_string()).await;
    }
    let remote: Option<Value> = db(dbs
        .client
        .query_one("SELECT remote FROM publication_jobs WHERE id=$1", &[&id])
        .await)?
    .get(0);
    plan["remote"] = remote.unwrap_or(Value::Null);
    let result =
        crate::publishing_adapters::reconcile_with_checkpoint(plan, checkpoint(config, id)).await;
    finish(config, id, result).await?;
    get(config, &publication.to_string()).await
}
async fn finish(
    config: &AppConfig,
    id: Uuid,
    result: Result<Value, crate::publishing_adapters::AdapterError>,
) -> Result<(), String> {
    let dbs = crate::social::database(config).await?;
    let persisted_remote: Option<Value> = db(dbs
        .client
        .query_one("SELECT remote FROM publication_jobs WHERE id=$1", &[&id])
        .await)?
    .get(0);
    // A reconnect or status-query failure after a durable remote handle must not
    // turn into permission to upload a second copy of the approved content.
    let result = match result {
        Err(mut error) if error.retryable && persisted_remote.is_some() => {
            error.uncertain = true;
            error.retryable = false;
            error.remote = error.remote.or(persisted_remote);
            Err(error)
        }
        other => other,
    };
    let release = match &result {
        Ok(value) => ["published", "draft_sent"].contains(&value["status"].as_str().unwrap_or("")),
        Err(error) => !error.uncertain,
    };
    match result {
        Ok(result) => {
            let status = result["status"]
                .as_str()
                .filter(|s| ["published", "processing", "draft_sent"].contains(s))
                .unwrap_or("uncertain");
            let remote = result.get("remote").cloned();
            db(dbs.client.execute("UPDATE publication_jobs SET status=$2,result=$3,remote=COALESCE($4,remote),error=NULL,retryable=false,updated_at=now() WHERE id=$1",&[&id,&status,&result,&remote]).await)?;
        }
        Err(error) => {
            let status = if error.uncertain {
                "uncertain"
            } else {
                "failed"
            };
            db(dbs.client.execute("UPDATE publication_jobs SET status=$2,error=$3,retryable=$4,remote=COALESCE($5,remote),updated_at=now() WHERE id=$1",&[&id,&status,&error.message,&error.retryable,&error.remote]).await)?;
        }
    }
    if release {
        release_media(id);
    }
    Ok(())
}
async fn recover_locked(config: &AppConfig) -> Result<(), String> {
    if RECOVERED.load(Ordering::SeqCst) {
        return Ok(());
    }
    let dbs = crate::social::database(config).await?;
    db(dbs.client.execute("UPDATE publication_jobs SET status='uncertain',retryable=false,error='앱이 전송 결과를 저장하기 전에 종료되었습니다. 원격 결과를 재확인하세요.',updated_at=now() WHERE status='sending'",&[]).await)?;
    db(dbs.client.execute("UPDATE publication_jobs SET status='needs_confirmation',error='앱 종료 중 놓친 실행입니다. 내용을 확인하고 다시 승인하세요.',updated_at=now() WHERE status='queued' OR (status='scheduled' AND scheduled_at<=now())",&[]).await)?;
    RECOVERED.store(true, Ordering::SeqCst);
    Ok(())
}
pub async fn recover(config: &AppConfig) -> Result<(), String> {
    let _guard = lock_for_update()?;
    if scheduler_owner()? {
        recover_locked(config).await?;
    }
    Ok(())
}
async fn claim(tx: &Transaction<'_>, is_paused: bool) -> Result<Option<Row>, String> {
    db(tx.query_opt("UPDATE publication_jobs SET status='sending',claimed_at=now(),attempts=attempts+1,updated_at=now() WHERE id=(SELECT j.id FROM publication_jobs j JOIN publications p ON p.id=j.publication_id AND p.revision=j.revision WHERE (NOT $1::boolean OR j.mode<>'scheduled') AND (j.status='queued' OR (j.status='scheduled' AND j.scheduled_at<=now())) ORDER BY j.scheduled_at NULLS FIRST,j.created_at FOR UPDATE OF p,j SKIP LOCKED LIMIT 1) RETURNING *",&[&is_paused]).await)
}
pub async fn tick(config: &AppConfig) -> Result<(), String> {
    heartbeat();
    if let Some(leases) = LEASES.get() {
        if let Ok(mut leases) = leases.lock() {
            leases
                .retain(|_, (created, _)| created.elapsed() < std::time::Duration::from_secs(7200));
        }
    }
    let Ok(_guard) = EXECUTION.try_lock() else {
        return Ok(());
    };
    if SHUTTING_DOWN.load(Ordering::SeqCst) {
        return Ok(());
    }
    if !scheduler_owner()? {
        return Ok(());
    }
    recover_locked(config).await?;
    let mut dbs = crate::social::database(config).await?;
    let now = Utc::now();
    {
        let mut last = LAST_TICK
            .get_or_init(|| Mutex::new(None))
            .lock()
            .map_err(|_| "예약 실행 상태 오류")?;
        *last = Some(now);
    }
    let _completed = TickCompleted;
    // Only this process owns scheduling and no upload can run concurrently while
    // this execution guard is held. A sending row left over here is a completion
    // that could not be written during a DB outage; never upload it again.
    db(dbs.client.execute("UPDATE publication_jobs SET status='uncertain',retryable=false,error='전송 후 DB 기록을 완료하지 못했습니다. SNS 결과를 재확인하세요.',updated_at=now() WHERE status='sending'",&[]).await)?;
    confirm_sleep_gap(&dbs.client).await?;
    let is_paused = paused();
    let was_paused = PAUSE_WAS_ACTIVE.swap(is_paused, Ordering::SeqCst);
    if was_paused && !is_paused {
        db(dbs.client.execute("UPDATE publication_jobs SET status='needs_confirmation',error='일시정지 중 놓친 예약입니다. 다시 승인하세요.',updated_at=now() WHERE status='scheduled' AND scheduled_at<=now()",&[]).await)?;
    }
    // Poll an existing remote result before starting a new upload. Reconciliation
    // never creates a replacement upload and may remain processing/uncertain.
    if let Some(row)=db(dbs.client.query_opt("SELECT * FROM publication_jobs WHERE status='processing' AND updated_at<now()-interval '15 seconds' ORDER BY updated_at LIMIT 1",&[]).await)?{let _active=Active::new();let mut plan:Value=row.get("snapshot");let id:Uuid=row.get("id");plan["remote"]=row.get::<_,Option<Value>>("remote").unwrap_or(Value::Null);finish(config,id,crate::publishing_adapters::reconcile_with_checkpoint(plan,checkpoint(config,id)).await).await?;}
    confirm_sleep_gap(&dbs.client).await?;
    let tx = db(dbs.client.transaction().await)?;
    let Some(row) = claim(&tx, paused()).await? else {
        db(tx.commit().await)?;
        return Ok(());
    };
    db(tx.commit().await)?;
    let id: Uuid = row.get("id");
    if confirm_sleep_gap(&dbs.client).await? && row.get::<_, String>("mode") == "scheduled" {
        db(dbs.client.execute("UPDATE publication_jobs SET status='needs_confirmation',error='실행 직전 절전에서 복귀했습니다. 예약 내용을 다시 승인하세요.',updated_at=now() WHERE id=$1 AND status='sending'",&[&id]).await)?;
        return Ok(());
    }
    let _active = Active::new();
    let snapshot: Value = row.get("snapshot");
    let result = execute(config, id, snapshot).await;
    finish(config, id, result).await
}
async fn execute(
    config: &AppConfig,
    id: Uuid,
    plan: Value,
) -> Result<Value, crate::publishing_adapters::AdapterError> {
    let local_error = |message: String| crate::publishing_adapters::AdapterError {
        message,
        retryable: false,
        uncertain: false,
        remote: None,
    };
    let video_id = plan["videoMediaId"]
        .as_str()
        .ok_or_else(|| local_error("승인 영상 식별자가 없습니다.".into()))?;
    let video = crate::publication_media::private_path(video_id).map_err(local_error)?;
    let actual = crate::publication_media::metadata(video_id).map_err(local_error)?;
    if actual["sha256"] != plan["video"]["sha256"] {
        return Err(local_error("승인 영상 파일이 변경되었습니다.".into()));
    }
    let thumbnail_id = plan["thumbnailMediaId"].as_str();
    let thumbnail = thumbnail_id
        .map(crate::publication_media::private_path)
        .transpose()
        .map_err(local_error)?;
    if let Some(raw) = thumbnail_id {
        if crate::publication_media::metadata(raw).map_err(local_error)?["sha256"]
            != plan["thumbnail"]["sha256"]
        {
            return Err(local_error("승인 썸네일이 변경되었습니다.".into()));
        }
    }
    let platform = plan["platform"].as_str().unwrap_or("");
    let needs_tunnel = platform == "threads" || (platform == "instagram" && thumbnail.is_some());
    let lease = if needs_tunnel {
        Some(
            crate::publication_media::lease(video_id, thumbnail_id)
                .await
                .map_err(local_error)?,
        )
    } else {
        None
    };
    let video_url = lease.as_ref().map(|lease| lease.video_url.clone());
    let thumbnail_url = lease.as_ref().and_then(|lease| lease.thumbnail_url.clone());
    if let Some(lease) = lease {
        LEASES
            .get_or_init(|| Mutex::new(std::collections::HashMap::new()))
            .lock()
            .map_err(|_| local_error("미디어 터널 상태 저장 실패".into()))?
            .insert(id, (std::time::Instant::now(), lease));
    }
    let checkpoint = checkpoint(config, id);
    crate::publishing_adapters::publish_with_checkpoint(
        plan,
        &video,
        thumbnail.as_deref(),
        video_url.as_deref(),
        thumbnail_url.as_deref(),
        checkpoint,
    )
    .await
}
fn checkpoint(config: &AppConfig, id: Uuid) -> crate::publishing_adapters::Checkpoint {
    let config = config.clone();
    Arc::new(move |remote: Value| {
        let config = config.clone();
        Box::pin(async move {
            let dbs = crate::social::database(&config).await?;
            let count=db(dbs.client.execute("UPDATE publication_jobs SET remote=$2,updated_at=now() WHERE id=$1 AND status IN ('sending','processing','uncertain')",&[&id,&remote]).await)?;
            if count != 1 {
                return Err("원격 게시 단계 저장이 거절되었습니다.".into());
            }
            Ok(())
        })
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn draft_normalization_is_bounded_and_does_not_authorize() {
        let id = Uuid::new_v4().to_string();
        let value = json!({"title":"제목","description":"설명","tags":["tag"],"hashtags":["#태그"],"targets":[{"id":id,"platform":"youtube","accountId":"","mode":"manual","options":{}}]});
        let parsed = normalize(&value).unwrap();
        assert_eq!(parsed["targets"][0]["accountId"], "");
        assert!(parsed.get("approved").is_none());
        let mut bad = value;
        bad["targets"][0]["mode"] = json!("tiktok_inbox");
        assert!(normalize(&bad).is_err());
    }
    #[test]
    fn target_selection_rejects_duplicates() {
        let id = Uuid::new_v4().to_string();
        let value = json!({"targets":[{"id":id}]});
        assert!(selection(&value, &json!({"targetIds":[id,id]})).is_err());
    }
    #[test]
    fn upload_completion_updates_scheduler_display_time() {
        let last = LAST_TICK.get_or_init(|| Mutex::new(None));
        *last.lock().unwrap() = Some(Utc::now() - chrono::Duration::minutes(5));
        drop(TickCompleted);
        assert!((Utc::now() - last.lock().unwrap().unwrap()).num_seconds() < 2);
    }
    #[test]
    fn independent_pulses_keep_long_uploads_distinct_from_sleep() {
        let start = DateTime::parse_from_rfc3339("2026-10-10T00:00:00Z")
            .unwrap()
            .with_timezone(&Utc);
        let mut previous = None;
        assert!(!pulse_gap(&mut previous, start));
        // A five-minute API request remains awake: its independent heartbeat
        // keeps advancing even though the upload loop has not returned.
        for second in (10..=300).step_by(10) {
            assert!(!pulse_gap(
                &mut previous,
                start + chrono::Duration::seconds(second)
            ));
        }
        assert!(!pulse_gap(
            &mut previous,
            start + chrono::Duration::seconds(305)
        ));
        // Suspending while the same request is pending leaves a real pulse gap.
        assert!(pulse_gap(
            &mut previous,
            start + chrono::Duration::seconds(600)
        ));
        assert!(!pulse_gap(
            &mut previous,
            start + chrono::Duration::seconds(610)
        ));
    }
    #[test]
    fn approval_binds_revision_account_and_media() {
        let p = json!({"id":"a","revision":1,"targets":[{"accountId":"one"}]});
        let selected = vec!["target".into()];
        let v = json!({"sha256":"one"});
        let first = hash_approval(&p, &selected, &v, &None);
        let mut changed = p.clone();
        changed["revision"] = json!(2);
        assert_ne!(first, hash_approval(&changed, &selected, &v, &None));
        assert_ne!(
            first,
            hash_approval(&p, &selected, &json!({"sha256":"two"}), &None)
        );
        changed = p;
        changed["targets"][0]["accountId"] = json!("other");
        assert_ne!(first, hash_approval(&changed, &selected, &v, &None));
    }
    #[tokio::test]
    #[ignore = "Requires TORIS_PUBLICATIONS_TEST_DB pointing to an isolated toris_publications_test_* database"]
    async fn postgres_queue_preserves_revision_and_recovers_without_duplicate_claims() {
        let raw =
            std::env::var("TORIS_PUBLICATIONS_TEST_DB").expect("isolated fixture DB URL required");
        let parsed = url::Url::parse(&raw).unwrap();
        assert!(matches!(parsed.host_str(), Some("127.0.0.1" | "localhost")));
        assert!(
            parsed.path().starts_with("/toris_publications_test_"),
            "production database is forbidden"
        );
        assert_eq!(parsed.username(), "toris_app");
        let config = AppConfig {
            database_url: Some(raw),
            ..AppConfig::default()
        };
        let target = Uuid::new_v4();
        let input = json!({"title":"격리된 DB 테스트","description":"실제 SNS 전송 없음","tags":[],"hashtags":[],"targets":[{"id":target.to_string(),"platform":"youtube","accountId":"fixture","mode":"manual","options":{}}]});
        let first = save(&config, input.clone()).await.unwrap();
        let publication_id = uuid(first["id"].as_str().unwrap()).unwrap();
        let job_id = Uuid::new_v4();
        let dbs = crate::social::database(&config).await.unwrap();
        dbs.client.execute("INSERT INTO publication_jobs(id,publication_id,revision,target_id,approval_hash,snapshot,mode,status)VALUES($1,$2,1,$3,$4,$5,'manual','queued')",&[&job_id,&publication_id,&target,&"0".repeat(64),&json!({})]).await.unwrap();
        let mut edit = input.clone();
        edit["id"] = first["id"].clone();
        edit["revision"] = json!(1);
        edit["title"] = json!("수정된 내용");
        let second = save(&config, edit.clone()).await.unwrap();
        assert_eq!(second["revision"], 2);
        assert_eq!(second["jobs"][0]["status"], "cancelled");
        assert!(
            save(&config, edit).await.is_err(),
            "stale revisions must not overwrite drafts"
        );
        let mut payload = second.clone();
        payload.as_object_mut().unwrap().remove("jobs");
        dbs.client
            .execute(
                "UPDATE publication_jobs SET revision=2,status='queued',snapshot=$2 WHERE id=$1",
                &[&job_id, &payload],
            )
            .await
            .unwrap();
        let mut connection_a = crate::social::database(&config).await.unwrap();
        let mut connection_b = crate::social::database(&config).await.unwrap();
        let tx_a = connection_a.client.transaction().await.unwrap();
        let tx_b = connection_b.client.transaction().await.unwrap();
        assert_eq!(
            claim(&tx_a, false)
                .await
                .unwrap()
                .unwrap()
                .get::<_, Uuid>("id"),
            job_id
        );
        assert!(
            claim(&tx_b, false).await.unwrap().is_none(),
            "a claimed job cannot be claimed by another scheduler"
        );
        tx_a.commit().await.unwrap();
        tx_b.commit().await.unwrap();
        let active = get(&config, &publication_id.to_string()).await.unwrap();
        assert_eq!(active["jobs"][0]["status"], "sending");
        let mut unsafe_edit = input;
        unsafe_edit["id"] = json!(publication_id.to_string());
        unsafe_edit["revision"] = json!(2);
        assert!(
            save(&config, unsafe_edit).await.is_err(),
            "sending snapshot must remain fixed"
        );
        RECOVERED.store(false, Ordering::SeqCst);
        recover_locked(&config).await.unwrap();
        let recovered = get(&config, &publication_id.to_string()).await.unwrap();
        assert_eq!(recovered["jobs"][0]["status"], "uncertain");
        assert!(!recovered["jobs"][0]["retryable"].as_bool().unwrap());
        assert!(reconcile(
            &config,
            json!({"jobId":job_id.to_string(),"resolution":"not_published"})
        )
        .await
        .is_err());
        let user_confirmed = reconcile(
            &config,
            json!({"jobId":job_id.to_string(),"resolution":"not_published","confirmed":true}),
        )
        .await
        .unwrap();
        assert_eq!(user_confirmed["jobs"][0]["status"], "needs_confirmation");
        let past_id = Uuid::new_v4();
        let future_id = Uuid::new_v4();
        let queued_id = Uuid::new_v4();
        for (id, status, mode, scheduled) in [
            (
                past_id,
                "scheduled",
                "scheduled",
                Some(Utc::now() - chrono::Duration::hours(1)),
            ),
            (
                future_id,
                "scheduled",
                "scheduled",
                Some(Utc::now() + chrono::Duration::hours(1)),
            ),
            (queued_id, "queued", "manual", None),
        ] {
            let target = Uuid::new_v4();
            dbs.client.execute("INSERT INTO publication_jobs(id,publication_id,revision,target_id,approval_hash,snapshot,mode,status,scheduled_at)VALUES($1,$2,2,$3,$4,$5,$6,$7,$8)",&[&id,&publication_id,&target,&"0".repeat(64),&json!({}),&mode,&status,&scheduled]).await.unwrap();
        }
        RECOVERED.store(false, Ordering::SeqCst);
        recover_locked(&config).await.unwrap();
        let fixture_client = &dbs.client;
        let status = |raw: Uuid| async move {
            fixture_client
                .query_one("SELECT status FROM publication_jobs WHERE id=$1", &[&raw])
                .await
                .unwrap()
                .get::<_, String>(0)
        };
        assert_eq!(status(past_id).await, "needs_confirmation");
        assert_eq!(status(queued_id).await, "needs_confirmation");
        assert_eq!(status(future_id).await, "scheduled");
        dbs.client
            .execute(
                "UPDATE publication_jobs SET status='processing',remote=$2 WHERE id=$1",
                &[&future_id, &json!({"containerId":"fixture-container"})],
            )
            .await
            .unwrap();
        finish(
            &config,
            future_id,
            Err(crate::publishing_adapters::AdapterError {
                message: "fixture network status query failed".into(),
                retryable: true,
                uncertain: false,
                remote: None,
            }),
        )
        .await
        .unwrap();
        assert_eq!(
            status(future_id).await,
            "uncertain",
            "status reconnect errors cannot authorize a duplicate upload"
        );
        assert!(!dbs
            .client
            .query_one(
                "SELECT retryable FROM publication_jobs WHERE id=$1",
                &[&future_id]
            )
            .await
            .unwrap()
            .get::<_, bool>(0));
        let pause_manual = Uuid::new_v4();
        let pause_scheduled = Uuid::new_v4();
        for (id, mode, status, when) in [
            (pause_manual, "manual", "queued", None),
            (
                pause_scheduled,
                "scheduled",
                "scheduled",
                Some(Utc::now() - chrono::Duration::seconds(10)),
            ),
        ] {
            let target = Uuid::new_v4();
            dbs.client.execute("INSERT INTO publication_jobs(id,publication_id,revision,target_id,approval_hash,snapshot,mode,status,scheduled_at)VALUES($1,$2,2,$3,$4,$5,$6,$7,$8)",&[&id,&publication_id,&target,&"0".repeat(64),&json!({}),&mode,&status,&when]).await.unwrap();
        }
        let paused_tx = connection_a.client.transaction().await.unwrap();
        assert_eq!(
            claim(&paused_tx, true)
                .await
                .unwrap()
                .unwrap()
                .get::<_, Uuid>("id"),
            pause_manual,
            "pause must not block a user-requested immediate post"
        );
        paused_tx.commit().await.unwrap();
        let paused_tx = connection_a.client.transaction().await.unwrap();
        assert!(
            claim(&paused_tx, true).await.unwrap().is_none(),
            "approved scheduled posts must remain paused"
        );
        paused_tx.commit().await.unwrap();
        let resumed_tx = connection_a.client.transaction().await.unwrap();
        assert_eq!(
            claim(&resumed_tx, false)
                .await
                .unwrap()
                .unwrap()
                .get::<_, Uuid>("id"),
            pause_scheduled
        );
        resumed_tx.rollback().await.unwrap();
        SLEEP_GAP.store(true, Ordering::SeqCst);
        assert!(confirm_sleep_gap(&dbs.client).await.unwrap());
        assert_eq!(
            status(pause_scheduled).await,
            "needs_confirmation",
            "a sleep gap invalidates only missed approved reservations"
        );
        assert_eq!(
            status(pause_manual).await,
            "sending",
            "a sleep gap does not rewrite a manually claimed immediate post"
        );
        dbs.client
            .execute("DELETE FROM publications WHERE id=$1", &[&publication_id])
            .await
            .unwrap();
    }
}
