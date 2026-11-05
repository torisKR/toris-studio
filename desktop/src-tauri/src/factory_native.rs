//! IPC for the app and game factory. The runtime receives only the fields
//! `factory::parse_request` kept. Signing and store submission stay inside the runtime.
use serde_json::{json, Value};
use std::sync::Arc;
use tauri::State;

fn workflow_of(run: &Value) -> bool {
    matches!(run["workflow"].as_str(), Some("game-factory" | "app-factory"))
}

async fn factory_run(runtime: &Arc<crate::agent_runtime::AgentRuntime>, run_id: &str) -> Result<Value, String> {
    let run = runtime.call("run.get", json!({ "runId": run_id })).await?;
    if !workflow_of(&run) {
        return Err("이 화면에서 다룰 수 있는 작업이 아닙니다.".into());
    }
    Ok(run)
}

#[tauri::command]
pub async fn factory_preview(
    window: tauri::WebviewWindow,
    runtime: State<'_, Arc<crate::agent_runtime::AgentRuntime>>,
    input: Value,
) -> Result<Value, String> {
    crate::updater::authorize(&window)?;
    let request = crate::factory::parse_request(&input)?;
    runtime.call("factory.preview", request["input"].clone()).await
}

#[tauri::command]
pub async fn factory_start(
    window: tauri::WebviewWindow,
    runtime: State<'_, Arc<crate::agent_runtime::AgentRuntime>>,
    input: Value,
) -> Result<Value, String> {
    crate::updater::authorize(&window)?;
    let request = crate::factory::parse_request(&input)?;
    runtime
        .call(
            "run.start",
            json!({
                "project": "",
                "task": request["task"],
                "workflow": request["workflow"],
                "host": true,
                "input": request["input"],
            }),
        )
        .await
}

#[tauri::command]
pub async fn factory_status(
    window: tauri::WebviewWindow,
    runtime: State<'_, Arc<crate::agent_runtime::AgentRuntime>>,
    run_id: String,
) -> Result<Value, String> {
    crate::updater::authorize(&window)?;
    factory_run(runtime.inner(), &run_id).await
}

#[tauri::command]
pub async fn factory_decide(
    window: tauri::WebviewWindow,
    runtime: State<'_, Arc<crate::agent_runtime::AgentRuntime>>,
    run_id: String,
    action_id: String,
    decision: String,
    feedback: Option<String>,
) -> Result<Value, String> {
    crate::updater::authorize(&window)?;
    if decision != "approve" && decision != "reject" {
        return Err("승인 또는 거절을 선택하세요.".into());
    }
    factory_run(runtime.inner(), &run_id).await?;
    runtime
        .call(
            "run.resume",
            json!({
                "runId": run_id,
                "actionId": action_id,
                "decision": decision,
                "feedback": feedback.unwrap_or_default(),
                "host": true,
            }),
        )
        .await
}

#[tauri::command]
pub async fn factory_cancel(
    window: tauri::WebviewWindow,
    runtime: State<'_, Arc<crate::agent_runtime::AgentRuntime>>,
    run_id: String,
) -> Result<Value, String> {
    crate::updater::authorize(&window)?;
    factory_run(runtime.inner(), &run_id).await?;
    runtime.call("run.cancel", json!({ "runId": run_id })).await
}

#[tauri::command]
pub async fn factory_jobs(
    window: tauri::WebviewWindow,
    runtime: State<'_, Arc<crate::agent_runtime::AgentRuntime>>,
) -> Result<Value, String> {
    crate::updater::authorize(&window)?;
    runtime.call("factory.jobs", json!({})).await
}
