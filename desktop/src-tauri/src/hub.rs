//! Operations-hub workflows (weekly content drafts, ops triage) run in the agent runtime,
//! which has no database. This host side gathers each workflow's input from the local DB
//! and performs the single write a user approves. The webview never supplies the input or
//! the payload: both come from the DB and from the runtime's own pending approval.
use chrono::{Duration, Utc};
use serde_json::{json, Value};

pub const WORKFLOWS: [&str; 2] = ["weekly-content", "ops-triage"];

/// Hub workflows take their input from the local DB and save on approval, so only the host
/// (hub_native) may start or resume them. Through agent_call the webview may start code workflows only.
pub fn ui_params_allowed(method: &str, params: &Value) -> Result<(), String> {
    if params.get("host").is_some() || params.get("input").is_some() {
        return Err("허용되지 않은 에이전트 요청입니다.".into());
    }
    if method == "run.start"
        && !matches!(
            params.get("workflow").and_then(Value::as_str),
            None | Some("coding")
        )
    {
        return Err("이 워크플로는 해당 화면에서 시작하세요.".into());
    }
    Ok(())
}

/// What an approved `save_draft` writes. Anything else in the runtime's approval is ignored.
#[derive(Debug, PartialEq)]
pub enum Write {
    Content(Value),
    OpsTask {
        product: String,
        source: String,
        notes: String,
    },
}

/// Finds the approval the user decided in the runtime's view of the run.
/// `Ok(None)` means it is not a save (a code workflow's file or command approval).
pub fn pending_write(run: &Value, action_id: &str) -> Result<Option<Write>, String> {
    let approval = run["approvals"]
        .as_array()
        .and_then(|list| list.iter().find(|a| a["id"] == action_id))
        .ok_or("승인할 작업이 바뀌었습니다. 화면을 새로고침하세요.")?;
    if approval["kind"] != "save_draft" {
        return Ok(None);
    }
    let payload = &approval["payload"];
    match approval["target"].as_str() {
        Some("social_content") => {
            // Drafts only: an agent can never schedule or mark something published.
            if payload["status"] != "draft" || !payload.is_object() {
                return Err("에이전트 초안은 초안 상태로만 저장할 수 있습니다.".into());
            }
            Ok(Some(Write::Content(payload.clone())))
        }
        Some("ops_task") => Ok(Some(Write::OpsTask {
            product: payload["product"].as_str().unwrap_or_default().to_owned(),
            source: payload["source"].as_str().unwrap_or_default().to_owned(),
            notes: payload["notes"]
                .as_str()
                .unwrap_or_default()
                .chars()
                .take(2000)
                .collect(),
        })),
        _ => Err("저장 대상을 확인할 수 없습니다.".into()),
    }
}

/// Input for weekly-content: channels, existing titles, trends and the coming week.
pub async fn content_input(config: &crate::config::AppConfig) -> Result<Value, String> {
    let dashboard = crate::social::dashboard(config).await?;
    if !dashboard.database.connected {
        return Err(dashboard.database.message);
    }
    let db = crate::social::database(config).await?;
    let now = Utc::now();
    let week = crate::planner::today(&db.client, now, now + Duration::days(7)).await?;
    Ok(json!({
        "now": now.to_rfc3339(),
        "channels": dashboard.channels.iter().map(|c| json!({"id": c.id, "platform": c.platform, "name": c.name})).collect::<Vec<_>>(),
        "content": dashboard.content.iter().take(40).map(|c| json!({"title": c.title})).collect::<Vec<_>>(),
        "trends": dashboard.trends.iter().take(30).map(|t| json!({"keyword": t.keyword, "title": t.title, "url": t.url, "source": t.source, "metric": t.metric})).collect::<Vec<_>>(),
        "events": week["events"].as_array().map(|list| list.iter().take(30).map(|e| json!({"startsAt": e["startsAt"], "title": e["title"]})).collect::<Vec<_>>()),
        "work": week["work"].as_array().map(|list| list.iter().take(30).map(|w| json!({"dueAt": w["dueAt"], "title": w["title"]})).collect::<Vec<_>>()),
    }))
}

/// Input for ops-triage: the latest stored status per product source (no new network calls).
pub async fn ops_input(client: &tokio_postgres::Client) -> Result<Value, String> {
    let overview = crate::ops_status::overview(client, json!({})).await?;
    Ok(json!({"products": overview["products"]}))
}

/// Performs an approved write. Returns a short receipt for the run log.
pub async fn apply(config: &crate::config::AppConfig, write: &Write) -> Result<Value, String> {
    match write {
        Write::Content(payload) => {
            let saved = crate::social::create_content(config, payload).await?;
            Ok(json!({"contentId": saved.id}))
        }
        Write::OpsTask {
            product,
            source,
            notes,
        } => {
            let db = crate::social::database(config).await?;
            let task = crate::ops_status::open_task(&db.client, product, source).await?;
            if !notes.is_empty() {
                if let Some(id) = task["id"]
                    .as_str()
                    .and_then(|raw| uuid::Uuid::parse_str(raw).ok())
                {
                    let _ = db
                        .client
                        .execute(
                            "UPDATE work_items SET notes=$2 WHERE id=$1 AND notes=''",
                            &[&id, notes],
                        )
                        .await;
                }
            }
            Ok(task)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(approval: Value) -> Value {
        json!({"approvals": [approval]})
    }

    #[test]
    fn the_webview_cannot_start_or_feed_hub_workflows_directly() {
        assert!(ui_params_allowed("run.start", &json!({"project": "demo", "task": "x"})).is_ok());
        assert!(ui_params_allowed("run.start", &json!({"workflow": "coding"})).is_ok());
        assert!(ui_params_allowed("run.start", &json!({"workflow": "weekly-content"})).is_err());
        assert!(
            ui_params_allowed("run.start", &json!({"workflow": "coding", "input": {}})).is_err()
        );
        assert!(
            ui_params_allowed("run.resume", &json!({"runId": "r", "host": true})).is_err(),
            "only hub_native may mark a call as host"
        );
        assert!(ui_params_allowed("run.resume", &json!({"runId": "r", "actionId": "a"})).is_ok());
    }

    #[test]
    fn only_the_runtime_approval_decides_what_is_written() {
        let content = run(
            json!({"id": "a1", "kind": "save_draft", "target": "social_content", "payload": {"platform": "threads", "title": "t", "body": "b", "status": "draft", "channelId": null, "scheduledAt": null, "url": null}}),
        );
        assert!(matches!(
            pending_write(&content, "a1"),
            Ok(Some(Write::Content(_)))
        ));
        assert!(
            pending_write(&content, "other").is_err(),
            "an id that is not pending is refused"
        );
        let published = run(
            json!({"id": "a1", "kind": "save_draft", "target": "social_content", "payload": {"status": "published"}}),
        );
        assert!(
            pending_write(&published, "a1").is_err(),
            "an agent draft can never be saved as published"
        );
        let task = run(
            json!({"id": "a2", "kind": "save_draft", "target": "ops_task", "payload": {"product": "p", "source": "http", "notes": "확인"}}),
        );
        assert_eq!(
            pending_write(&task, "a2").unwrap(),
            Some(Write::OpsTask {
                product: "p".into(),
                source: "http".into(),
                notes: "확인".into()
            })
        );
        let file = run(json!({"id": "a3", "kind": "write_file", "path": "x"}));
        assert_eq!(
            pending_write(&file, "a3").unwrap(),
            None,
            "code approvals are not database writes"
        );
        let unknown =
            run(json!({"id": "a4", "kind": "save_draft", "target": "users", "payload": {}}));
        assert!(pending_write(&unknown, "a4").is_err());
    }
}
