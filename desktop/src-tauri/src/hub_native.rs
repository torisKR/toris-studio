//! IPC for operations-hub workflows. Input comes from the local DB and approved saves are
//! written here, before the runtime is told to continue.
use serde_json::{json, Value};
use std::sync::Arc;
use tauri::State;

#[tauri::command]
pub async fn hub_start(
    window: tauri::WebviewWindow,
    state: State<'_, Arc<crate::AppState>>,
    runtime: State<'_, Arc<crate::agent_runtime::AgentRuntime>>,
    workflow: String,
    task: Option<String>,
) -> Result<Value, String> {
    crate::updater::authorize(&window)?;
    if !crate::hub::WORKFLOWS.contains(&workflow.as_str()) {
        return Err("지원하지 않는 워크플로입니다.".into());
    }
    let task: String = task.unwrap_or_default().chars().take(2000).collect();
    let config = state.config_snapshot().await;
    let input = if workflow == "weekly-content" {
        crate::hub::content_input(&config).await?
    } else {
        let db = crate::social::database(&config).await?;
        crate::hub::ops_input(&db.client).await?
    };
    runtime
        .call("run.start", json!({"project": "", "task": task, "workflow": workflow, "input": input, "host": true}))
        .await
}

#[tauri::command]
pub async fn hub_decide(
    window: tauri::WebviewWindow,
    state: State<'_, Arc<crate::AppState>>,
    runtime: State<'_, Arc<crate::agent_runtime::AgentRuntime>>,
    run_id: String,
    action_id: String,
    decision: String,
    feedback: Option<String>,
) -> Result<Value, String> {
    crate::updater::authorize(&window)?;
    let approve = match decision.as_str() {
        "approve" => true,
        "reject" => false,
        _ => return Err("승인 또는 거절을 선택하세요.".into()),
    };
    let run = runtime.call("run.get", json!({"runId": run_id})).await?;
    let write = crate::hub::pending_write(&run, &action_id)?;
    if approve {
        if let Some(write) = &write {
            let config = state.config_snapshot().await;
            crate::hub::apply(&config, write).await?;
        }
    }
    runtime
        .call("run.resume", json!({"runId": run_id, "actionId": action_id, "decision": decision, "feedback": feedback.unwrap_or_default(), "host": true}))
        .await
}
