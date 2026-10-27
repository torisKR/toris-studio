//! Planner IPC: today's view, events, work items and the Google Calendar sync.
use chrono::{DateTime, Duration, Utc};
use serde_json::{json, Value};
use std::sync::Arc;
use tauri::State;

/// One sync at a time, whether started by the timer or the user.
static SYNC_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

async fn session(state: &crate::AppState) -> Result<crate::social::DbSession, String> {
    crate::social::database(&state.config_snapshot().await).await
}

fn range(input: &Value) -> Result<(DateTime<Utc>, DateTime<Utc>), String> {
    let parse = |key: &str| {
        input
            .get(key)
            .and_then(Value::as_str)
            .map(|raw| {
                DateTime::parse_from_rfc3339(raw)
                    .map(|t| t.with_timezone(&Utc))
                    .map_err(|_| "조회 기간 형식 오류".to_string())
            })
            .transpose()
    };
    let from = parse("from")?.unwrap_or_else(|| Utc::now() - Duration::days(1));
    let to = parse("to")?.unwrap_or(from + Duration::days(8));
    if to <= from || to - from > Duration::days(93) {
        return Err("조회 기간은 93일 이하여야 합니다.".into());
    }
    Ok((from, to))
}

#[tauri::command]
pub async fn planner_today(
    window: tauri::WebviewWindow,
    state: State<'_, Arc<crate::AppState>>,
    input: Value,
) -> Result<Value, String> {
    crate::updater::authorize(&window)?;
    let (from, to) = range(&input)?;
    let db = session(&state).await?;
    crate::planner::today(&db.client, from, to).await
}

#[tauri::command]
pub async fn planner_save_event(
    window: tauri::WebviewWindow,
    state: State<'_, Arc<crate::AppState>>,
    input: Value,
) -> Result<Value, String> {
    crate::updater::authorize(&window)?;
    let db = session(&state).await?;
    crate::planner::save_event(&db.client, &input).await
}

#[tauri::command]
pub async fn planner_delete_event(
    window: tauri::WebviewWindow,
    state: State<'_, Arc<crate::AppState>>,
    id: String,
) -> Result<(), String> {
    crate::updater::authorize(&window)?;
    let db = session(&state).await?;
    crate::planner::delete_event(&db.client, &id).await
}

#[tauri::command]
pub async fn planner_save_work_item(
    window: tauri::WebviewWindow,
    state: State<'_, Arc<crate::AppState>>,
    input: Value,
) -> Result<Value, String> {
    crate::updater::authorize(&window)?;
    let db = session(&state).await?;
    crate::planner::save_work_item(&db.client, &input).await
}

#[tauri::command]
pub async fn planner_conflicts(
    window: tauri::WebviewWindow,
    state: State<'_, Arc<crate::AppState>>,
) -> Result<Value, String> {
    crate::updater::authorize(&window)?;
    let db = session(&state).await?;
    crate::planner::conflicts(&db.client).await
}

#[tauri::command]
pub async fn planner_resolve_conflict(
    window: tauri::WebviewWindow,
    state: State<'_, Arc<crate::AppState>>,
    id: String,
) -> Result<(), String> {
    crate::updater::authorize(&window)?;
    let db = session(&state).await?;
    crate::planner::resolve_conflict(&db.client, &id).await
}

#[tauri::command]
pub async fn planner_sync_calendar(
    window: tauri::WebviewWindow,
    state: State<'_, Arc<crate::AppState>>,
) -> Result<Value, String> {
    crate::updater::authorize(&window)?;
    sync_once(&state).await
}

/// Runs one sync. A missing Google connection is reported, not retried in a loop.
pub async fn sync_once(state: &crate::AppState) -> Result<Value, String> {
    let _guard = SYNC_LOCK
        .try_lock()
        .map_err(|_| "캘린더 동기화가 이미 진행 중입니다.")?;
    let db = session(state).await?;
    crate::planner::mirror_publications(&db.client).await?;
    let token = match crate::oauth::calendar_access().await {
        Ok(token) => token,
        Err(error) => {
            crate::planner::record_sync_error(&db.client, &error).await;
            return Err(error);
        }
    };
    let api = crate::planner::GoogleCalendar::new(token)?;
    let mut store = crate::planner::DbStore { client: &db.client };
    match crate::planner::sync(&api, &mut store, Utc::now()).await {
        Ok(report) => Ok(json!(report)),
        Err(error) => {
            crate::planner::record_sync_error(&db.client, &error).await;
            Err(error)
        }
    }
}
