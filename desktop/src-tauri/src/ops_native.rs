//! Ops dashboard IPC: products, read-only status refresh, secrets (write-only) and follow-up tasks.
use serde_json::{json, Value};
use std::sync::Arc;
use tauri::State;

/// One refresh at a time, whether started by the timer or the user.
static REFRESH_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

async fn session(state: &crate::AppState) -> Result<crate::social::DbSession, String> {
    crate::social::database(&state.config_snapshot().await).await
}

#[tauri::command]
pub async fn ops_overview(
    window: tauri::WebviewWindow,
    state: State<'_, Arc<crate::AppState>>,
) -> Result<Value, String> {
    crate::updater::authorize(&window)?;
    let db = session(&state).await?;
    let secrets = tauri::async_runtime::spawn_blocking(crate::ops_status::secret_flags)
        .await
        .map_err(|_| "자격 증명 상태를 읽지 못했습니다.".to_string())?;
    crate::ops_status::overview(&db.client, secrets).await
}

#[tauri::command]
pub async fn ops_save_product(
    window: tauri::WebviewWindow,
    state: State<'_, Arc<crate::AppState>>,
    input: Value,
) -> Result<Value, String> {
    crate::updater::authorize(&window)?;
    let db = session(&state).await?;
    crate::ops_status::save_product(&db.client, &input).await
}

#[tauri::command]
pub async fn ops_delete_product(
    window: tauri::WebviewWindow,
    state: State<'_, Arc<crate::AppState>>,
    id: String,
) -> Result<(), String> {
    crate::updater::authorize(&window)?;
    let db = session(&state).await?;
    crate::ops_status::delete_product(&db.client, &id).await
}

#[tauri::command]
pub async fn ops_refresh(
    window: tauri::WebviewWindow,
    state: State<'_, Arc<crate::AppState>>,
) -> Result<Value, String> {
    crate::updater::authorize(&window)?;
    refresh_once(&state).await
}

#[tauri::command]
pub async fn ops_open_task(
    window: tauri::WebviewWindow,
    state: State<'_, Arc<crate::AppState>>,
    product: String,
    source: String,
) -> Result<Value, String> {
    crate::updater::authorize(&window)?;
    let db = session(&state).await?;
    crate::ops_status::open_task(&db.client, &product, &source).await
}

/// Saves or clears one ops credential. The value is never returned to the webview.
#[tauri::command]
pub async fn ops_save_secret(
    window: tauri::WebviewWindow,
    kind: String,
    value: Option<String>,
) -> Result<Value, String> {
    crate::updater::authorize(&window)?;
    let value = value.map(|v| v.trim().to_owned()).filter(|v| !v.is_empty());
    tauri::async_runtime::spawn_blocking(move || {
        crate::ops_status::write_secret(&kind, value.as_deref())
    })
    .await
    .map_err(|_| "자격 증명 저장 작업이 중단되었습니다.".to_string())??;
    Ok(crate::ops_status::secret_flags())
}

/// Runs one refresh across all products. A busy refresh is reported, not queued.
pub async fn refresh_once(state: &crate::AppState) -> Result<Value, String> {
    let _guard = REFRESH_LOCK
        .try_lock()
        .map_err(|_| "운영 상태를 이미 확인하고 있습니다.")?;
    let db = session(state).await?;
    let secrets = tauri::async_runtime::spawn_blocking(crate::ops_status::Secrets::load)
        .await
        .map_err(|_| "자격 증명을 읽지 못했습니다.".to_string())?;
    let written = crate::ops_status::refresh(&db.client, &secrets).await?;
    Ok(json!({"snapshots": written}))
}
