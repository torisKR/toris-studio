//! Closed mobile protocol. SSH authentication is performed before constructing
//! a Device identity; enrollment identities can never invoke factory methods.
use crate::{
    agent_runtime::AgentRuntime,
    factory,
    mobile_pairing::{EnrollmentStatus, PairingGate},
    mobile_registry::MobileRegistry,
};
use base64::{engine::general_purpose::STANDARD_NO_PAD, Engine};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    sync::{Arc, Mutex as StdMutex},
    time::{Duration, Instant},
};
use tokio::sync::Mutex;
use uuid::Uuid;

const MAX_MESSAGE: usize = 8192;
const JOB_IDS: &[&str] = &[
    "spec-approved",
    "scaffold-project",
    "game-design",
    "app-design",
    "character-base",
    "sprite-atlas",
    "vfx-export",
    "model-export",
    "gameplay-core",
    "screen-core",
    "level-content",
    "asset-integration",
    "lint-and-import",
    "headless-tests",
    "android-debug-build",
    "adb-smoke-test",
    "release-review",
];
const PHASES: &[&str] = &[
    "queued",
    "thinking",
    "reading",
    "coding",
    "testing",
    "reviewing",
    "awaiting_approval",
    "waiting",
    "done",
    "failed",
    "cancelled",
];

#[derive(Clone, Copy)]
pub enum Identity {
    Enrollment(Uuid),
    Device(Uuid),
}

#[derive(Deserialize)]
#[serde(tag = "method", deny_unknown_fields)]
pub enum Request {
    #[serde(rename = "enroll.begin")]
    EnrollBegin {
        token: String,
        name: String,
        #[serde(rename = "publicKey")]
        public_key: String,
    },
    #[serde(rename = "enroll.poll")]
    EnrollPoll,
    #[serde(rename = "projects.list")]
    Projects,
    #[serde(rename = "factory.list")]
    List { offset: usize },
    #[serde(rename = "factory.preview")]
    Preview {
        #[serde(rename = "projectId")]
        project_id: Uuid,
        input: FactoryInput,
    },
    #[serde(rename = "factory.start")]
    Start {
        #[serde(rename = "projectId")]
        project_id: Uuid,
        #[serde(rename = "requestId")]
        request_id: Uuid,
        input: FactoryInput,
    },
    #[serde(rename = "factory.recover")]
    Recover {
        #[serde(rename = "requestId")]
        request_id: Uuid,
    },
    #[serde(rename = "factory.status")]
    Status {
        #[serde(rename = "runId")]
        run_id: Uuid,
    },
    #[serde(rename = "factory.cancel")]
    Cancel {
        #[serde(rename = "runId")]
        run_id: Uuid,
    },
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FactoryInput {
    #[serde(skip_serializing_if = "Option::is_none")]
    brief: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    kind: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    view: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    orientation: Option<String>,
}

pub struct Reply {
    pub value: Value,
    pub close: bool,
}
impl Reply {
    fn value(value: Value) -> Self {
        Self {
            value,
            close: false,
        }
    }
}

pub struct MobileService {
    pub gate: Mutex<PairingGate>,
    pub registry: Mutex<MobileRegistry>,
    runtime: Arc<AgentRuntime>,
    starts: Mutex<()>,
    watching: StdMutex<HashSet<(Uuid, Uuid)>>,
}

impl MobileService {
    pub fn new(registry: MobileRegistry, runtime: Arc<AgentRuntime>) -> Self {
        Self {
            gate: Mutex::new(PairingGate::default()),
            registry: Mutex::new(registry),
            runtime,
            starts: Mutex::new(()),
            watching: StdMutex::new(HashSet::new()),
        }
    }

    pub fn parse(bytes: &[u8]) -> Result<Request, String> {
        if bytes.is_empty() || bytes.len() > MAX_MESSAGE {
            return Err("요청 크기를 확인하세요.".into());
        }
        // Serde's internally tagged unit variants otherwise ignore extra fields.
        let value: Value =
            serde_json::from_slice(bytes).map_err(|_| "지원하지 않는 요청입니다.")?;
        let object = value.as_object().ok_or("지원하지 않는 요청입니다.")?;
        let fields: &[&str] = match object.get("method").and_then(Value::as_str) {
            Some("enroll.begin") => &["method", "token", "name", "publicKey"],
            Some("enroll.poll" | "projects.list") => &["method"],
            Some("factory.list") => &["method", "offset"],
            Some("factory.preview") => &["method", "projectId", "input"],
            Some("factory.start") => &["method", "projectId", "requestId", "input"],
            Some("factory.recover") => &["method", "requestId"],
            Some("factory.status" | "factory.cancel") => &["method", "runId"],
            _ => return Err("지원하지 않는 요청입니다.".into()),
        };
        if object.len() != fields.len() || object.keys().any(|key| !fields.contains(&key.as_str()))
        {
            return Err("지원하지 않는 요청입니다.".into());
        }
        serde_json::from_slice(bytes).map_err(|_| "지원하지 않는 요청입니다.".into())
    }

    pub async fn handle(
        self: &Arc<Self>,
        identity: Identity,
        request: Request,
    ) -> Result<Reply, String> {
        match (identity, request) {
            (
                Identity::Enrollment(session),
                Request::EnrollBegin {
                    token,
                    name,
                    public_key,
                },
            ) => {
                if public_key.len() > 1024 {
                    return Err("기기 공개키를 확인하세요.".into());
                }
                let key = STANDARD_NO_PAD
                    .decode(public_key)
                    .map_err(|_| "기기 공개키를 확인하세요.")?;
                let view =
                    self.gate
                        .lock()
                        .await
                        .begin(session, &token, &name, &key, Instant::now())?;
                Ok(Reply::value(
                    json!({ "state": "waiting", "confirmationCode": view.confirmation_code, "fingerprint": view.fingerprint }),
                ))
            }
            (Identity::Enrollment(session), Request::EnrollPoll) => {
                match self.gate.lock().await.poll(session, Instant::now()) {
                    EnrollmentStatus::Waiting => Ok(Reply::value(json!({"state":"waiting"}))),
                    EnrollmentStatus::Approved => Ok(Reply {
                        value: json!({"state":"approved"}),
                        close: true,
                    }),
                    EnrollmentStatus::Unavailable => {
                        Err("등록 요청이 만료되었거나 취소되었습니다.".into())
                    }
                }
            }
            (Identity::Device(device), Request::Projects) => {
                let projects = self.registry.lock().await.projects(device)?;
                Ok(Reply::value(json!({"projects": projects})))
            }
            (Identity::Device(device), Request::List { offset }) => {
                let page = self
                    .registry
                    .lock()
                    .await
                    .visible_runs_page(device, offset)?;
                let result = self.runtime.call("run.list", json!({})).await.ok();
                let available = result
                    .as_ref()
                    .and_then(|value| value["runs"].as_array())
                    .map(Vec::as_slice)
                    .unwrap_or(&[]);
                let mut runs = Vec::with_capacity(page.runs.len());
                let mut snapshots = Vec::new();
                let mut returned_ids = Vec::new();
                for visible in page.runs {
                    self.registry
                        .lock()
                        .await
                        .authorize_run(device, visible.run_id)?;
                    returned_ids.push(visible.run_id);
                    let id = visible.run_id.to_string();
                    let run = available.iter().find(|item| {
                        item["runId"] == id
                            && matches!(
                                item["workflow"].as_str(),
                                Some("game-factory" | "app-factory")
                            )
                    });
                    let mut live = run.map(safe_run);
                    // run.list omits event bodies; keep the previously sanitized
                    // activity until a detailed status fetch replaces it.
                    if let (Some(current), Some(previous)) =
                        (live.as_mut(), visible.safe_snapshot.as_ref())
                    {
                        if current["activity"].as_array().is_some_and(Vec::is_empty)
                            && previous["activity"].is_array()
                        {
                            current["activity"] = previous["activity"].clone();
                        }
                    }
                    if let Some(snapshot) = live.as_ref() {
                        snapshots.push((visible.run_id, snapshot.clone()));
                    }
                    let stale = live.is_none();
                    let mut value = live.or(visible.safe_snapshot).unwrap_or_else(|| {
                        json!({
                            "runId": visible.run_id, "phase": "unavailable", "sequence": 0,
                            "approvals": [], "gates": [], "jobs": []
                        })
                    });
                    value["stale"] = json!(stale);
                    value["projectName"] = json!(visible.project_name);
                    runs.push(value);
                }
                // Recheck the device after the runtime call, including an empty page.
                let mut registry = self.registry.lock().await;
                if !registry.is_authorized(device) {
                    return Err("등록되지 않은 기기입니다.".into());
                }
                for id in returned_ids {
                    registry.authorize_run(device, id)?;
                }
                registry.cache_snapshots(device, &snapshots)?;
                for value in &mut runs {
                    let Some(id) = value["runId"]
                        .as_str()
                        .and_then(|id| Uuid::parse_str(id).ok())
                    else {
                        continue;
                    };
                    if let Some(mut cached) = registry.cached_snapshot(device, id)? {
                        if cached["sequence"].as_u64().unwrap_or(0)
                            > value["sequence"].as_u64().unwrap_or(0)
                        {
                            cached["projectName"] = value["projectName"].clone();
                            *value = cached;
                        }
                    }
                }
                Ok(Reply::value(
                    json!({"runs":runs,"nextOffset":page.next_offset}),
                ))
            }
            (Identity::Device(device), Request::Preview { project_id, input }) => {
                let clean = self.clean_input(device, project_id, input).await?;
                let result = factory::preview(&self.runtime, &clean)
                    .await
                    .map_err(|_| "미리보기를 만들지 못했습니다. Mac에서 확인하세요.")?;
                self.registry
                    .lock()
                    .await
                    .project_scope(device, project_id)?;
                Ok(Reply::value(safe_preview(&result)))
            }
            (
                Identity::Device(device),
                Request::Start {
                    project_id,
                    request_id,
                    input,
                },
            ) => {
                let _start = self.starts.lock().await;
                let clean = self.clean_input(device, project_id, input).await?;
                let hash = format!(
                    "{:x}",
                    Sha256::digest(serde_json::to_vec(&clean).map_err(|_| "요청을 확인하세요.")?)
                );
                let reservation = self
                    .registry
                    .lock()
                    .await
                    .reserve(device, project_id, request_id, &hash)?;
                if reservation.existing {
                    let reply = self.fetch_run(device, reservation.run_id).await?;
                    if reply.value["stale"] != true
                        && !matches!(
                            reply.value["phase"].as_str(),
                            Some("done" | "failed" | "cancelled")
                        )
                    {
                        self.watch_run(device, reservation.run_id, Duration::from_secs(3));
                    }
                    return Ok(reply);
                }
                let result =
                    factory::start_with_id(&self.runtime, &clean, Some(reservation.run_id)).await;
                let run = match result {
                    Ok(run) if run["runId"] == reservation.run_id.to_string() => run,
                    // The runtime may have started before a lost response. Never start it twice.
                    _ => {
                        let reply = self.fetch_run(device, reservation.run_id).await?;
                        if reply.value["stale"] != true {
                            self.watch_run(device, reservation.run_id, Duration::from_secs(3));
                        }
                        return Ok(reply);
                    }
                };
                self.registry
                    .lock()
                    .await
                    .mark_started(device, reservation.run_id)?;
                let safe = safe_run(&run);
                self.registry
                    .lock()
                    .await
                    .cache_snapshots(device, &[(reservation.run_id, safe.clone())])?;
                self.watch_run(device, reservation.run_id, Duration::from_secs(3));
                Ok(Reply::value(safe))
            }
            (Identity::Device(device), Request::Recover { request_id }) => {
                let reservation = self
                    .registry
                    .lock()
                    .await
                    .lookup_request(device, request_id)?;
                self.fetch_run(device, reservation.run_id).await
            }
            (Identity::Device(device), Request::Status { run_id }) => {
                self.fetch_run(device, run_id).await
            }
            (Identity::Device(device), Request::Cancel { run_id }) => {
                self.registry.lock().await.authorize_run(device, run_id)?;
                let run = factory::cancel(&self.runtime, &run_id.to_string())
                    .await
                    .map_err(|_| "작업을 취소하지 못했습니다. Mac에서 확인하세요.")?;
                let safe = safe_run(&run);
                self.registry
                    .lock()
                    .await
                    .cache_snapshots(device, &[(run_id, safe.clone())])?;
                Ok(Reply::value(safe))
            }
            _ => Err("이 연결에서 허용되지 않은 요청입니다.".into()),
        }
    }

    async fn clean_input(
        &self,
        device: Uuid,
        project: Uuid,
        input: FactoryInput,
    ) -> Result<Value, String> {
        let scope = self.registry.lock().await.project_scope(device, project)?;
        let mut value = serde_json::to_value(input).map_err(|_| "요청을 확인하세요.")?;
        if let Some(slug) = scope {
            value["resumeProject"] = json!(slug);
        }
        let parsed = factory::parse_request(&value)?;
        Ok(parsed["input"].clone())
    }

    /// Capture safe status locally even after the phone leaves the foreground.
    /// No SSH connection or remote approval remains open for this task.
    fn watch_run(self: &Arc<Self>, device: Uuid, run_id: Uuid, interval: Duration) {
        let Ok(mut watching) = self.watching.lock() else {
            return;
        };
        if watching.len() >= 8 || !watching.insert((device, run_id)) {
            return;
        }
        drop(watching);
        let service = Arc::clone(self);
        tokio::spawn(async move {
            let mut failures = 0;
            for _ in 0..28_800 {
                tokio::time::sleep(interval).await;
                if service
                    .registry
                    .lock()
                    .await
                    .authorize_run(device, run_id)
                    .is_err()
                {
                    break;
                }
                match factory::status(&service.runtime, &run_id.to_string()).await {
                    Ok(run) => {
                        failures = 0;
                        let terminal =
                            matches!(run["phase"].as_str(), Some("done" | "failed" | "cancelled"));
                        if service
                            .registry
                            .lock()
                            .await
                            .cache_snapshots(device, &[(run_id, safe_run(&run))])
                            .is_err()
                            || terminal
                        {
                            break;
                        }
                    }
                    Err(_) => {
                        failures += 1;
                        if failures >= 10 {
                            break;
                        }
                    }
                }
            }
            if let Ok(mut watching) = service.watching.lock() {
                watching.remove(&(device, run_id));
            };
        });
    }

    async fn fetch_run(&self, device: Uuid, run_id: Uuid) -> Result<Reply, String> {
        self.registry.lock().await.authorize_run(device, run_id)?;
        let run = match factory::status(&self.runtime, &run_id.to_string()).await {
            Ok(run) => run,
            Err(_) => {
                let mut saved = self
                    .registry
                    .lock()
                    .await
                    .cached_snapshot(device, run_id)?
                    .ok_or("작업 상태를 확인하지 못했습니다. Mac에서 확인한 뒤 다시 연결하세요.")?;
                saved["stale"] = json!(true);
                return Ok(Reply::value(saved));
            }
        };
        let safe = safe_run(&run);
        self.registry
            .lock()
            .await
            .cache_snapshots(device, &[(run_id, safe.clone())])?;
        Ok(Reply::value(safe))
    }
}

fn allowed(value: &Value, values: &[&str]) -> Value {
    value
        .as_str()
        .filter(|text| values.contains(text))
        .map_or(Value::Null, |text| json!(text))
}

/// A short display title is useful in a multi-run list, but it must never carry
/// paths, URLs, commands, common credential prefixes or control characters.
fn safe_title(value: &Value) -> Option<String> {
    let text = value.as_str()?.trim();
    if text.is_empty()
        || text.chars().count() > 40
        || !text
            .chars()
            .all(|ch| ch.is_alphanumeric() || ch == ' ' || ch == '-' || ch == '_')
    {
        return None;
    }
    let lower = text.to_lowercase();
    if [
        "sk-",
        "ghp_",
        "github_pat_",
        "aiza",
        "password",
        "secret",
        "token",
        "비밀번호",
    ]
    .iter()
    .any(|word| lower.contains(word))
    {
        return None;
    }
    if lower.split_whitespace().any(|word| {
        matches!(
            word,
            "rm" | "sudo" | "curl" | "bash" | "sh" | "powershell" | "cmd" | "chmod"
        )
    }) {
        return None;
    }
    Some(text.to_owned())
}

fn safe_preview(report: &Value) -> Value {
    let spec = &report["spec"];
    let features: Vec<Value> = spec["features"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|feature| {
            allowed(
                feature,
                &[
                    "combat",
                    "dodge",
                    "xp",
                    "game-over",
                    "npc-dialogue",
                    "quest",
                    "inventory",
                    "save-load",
                    "tutorial",
                    "settings",
                    "list",
                    "form",
                ],
            )
        })
        .filter(|v| !v.is_null())
        .take(8)
        .collect();
    json!({
        "template": true,
        "kind": allowed(&spec["kind"], &["game", "app"]),
        "view": allowed(&spec["target"]["view"], &["2d", "3d", "ui"]),
        "orientation": allowed(&spec["design"]["orientation"], &["landscape", "portrait"]),
        "genre": allowed(&spec["design"]["genre"], &["action-rpg", "defense", "strategy", "fishing", "horror", "utility", "productivity"]),
        "features": features,
        "maxApiCostUsd": spec["limits"]["maxApiCostUsd"].as_f64().filter(|value| (0.0..=25.0).contains(value)),
    })
}

fn safe_run(run: &Value) -> Value {
    let phase = allowed(&run["phase"], PHASES);
    let approvals: Vec<Value> = run["approvals"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|approval| {
            if approval["kind"] != "factory_gate" {
                return None;
            }
            let message = match approval["gate"].as_str()? {
                "paid_api" => "유료 API 사용은 Mac에서 승인해야 합니다.",
                "device" => "기기 설치는 Mac에서 승인해야 합니다.",
                "release" => "릴리스 관련 작업은 Mac에서 승인해야 합니다.",
                _ => return None,
            };
            Some(json!(message))
        })
        .take(8)
        .collect();
    let report = run["summary"]
        .as_str()
        .and_then(|summary| serde_json::from_str::<Value>(summary).ok())
        .unwrap_or(Value::Null);
    let gates: Vec<Value> = report["gates"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|gate| {
            let name = allowed(
                &gate["name"],
                &[
                    "plan", "code", "asset", "model3d", "gameplay", "android", "release",
                ],
            );
            let status = allowed(&gate["status"], &["passed", "failed", "blocked", "not_run"]);
            if name.is_null() || status.is_null() {
                None
            } else {
                Some(json!({"name":name,"status":status,"required":gate["required"] == true}))
            }
        })
        .take(7)
        .collect();
    let jobs: Vec<Value> = report["jobs"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|job| {
            let id = allowed(&job["taskId"], JOB_IDS);
            let status = allowed(
                &job["status"],
                &[
                    "queued",
                    "running",
                    "waiting_approval",
                    "passed",
                    "failed",
                    "cancelled",
                    "blocked",
                    "interrupted",
                ],
            );
            let message = job["message"].as_str().unwrap_or("");
            let reason = if job["status"] == "blocked"
                && message.starts_with("도구를 실행하지 않았습니다:")
            {
                Some("tool_not_run")
            } else if job["status"] == "blocked" && message.contains("단계가") {
                Some("dependency")
            } else if job["status"] == "waiting_approval" {
                Some("mac_approval")
            } else {
                None
            };
            if id.is_null() || status.is_null() {
                None
            } else {
                Some(json!({"id":id,"status":status,"reason":reason}))
            }
        })
        .take(17)
        .collect();
    let timestamp = |value: &Value| {
        value
            .as_str()
            .and_then(|text| chrono::DateTime::parse_from_rfc3339(text).ok())
            .map(|date| date.to_rfc3339())
    };
    let events: Vec<Value> = run["events"].as_array().into_iter().flatten().rev().filter_map(|event| {
        let seq = event["seq"].as_u64()?;
        let event_phase = allowed(&event["phase"], PHASES);
        if event_phase.is_null() { return None; }
        let stages = event["message"].as_str().and_then(|message| message.strip_suffix(" 작업을 진행합니다."))
            .map(|names| names.split(", ").filter(|name| JOB_IDS.contains(name)).take(5).collect::<Vec<_>>())
            .unwrap_or_default();
        Some(json!({"sequence":seq,"phase":event_phase,"at":timestamp(&event["at"]),"stages":stages}))
    }).take(20).collect();
    json!({
        "runId": run["runId"].as_str().and_then(|id| Uuid::parse_str(id).ok()),
        "phase": phase,
        "sequence": run["events"].as_array().and_then(|events| events.last()).and_then(|event| event["seq"].as_u64()).or_else(|| run["lastSeq"].as_u64()).unwrap_or(0),
        "approvals": approvals,
        "verdict": allowed(&report["verdict"], &["pass", "fail", "incomplete"]),
        "template": report["template"].as_bool(),
        "gates": gates,
        "jobs": jobs,
        "activity": events,
        "kind": allowed(&report["spec"]["kind"], &["game", "app"]),
        "title": safe_title(&report["spec"]["title"]).or_else(|| safe_title(&run["task"])),
        "genre": allowed(&report["spec"]["design"]["genre"], &["action-rpg", "defense", "strategy", "fishing", "horror", "utility", "productivity"]),
        "view": allowed(&report["spec"]["target"]["view"], &["2d", "3d", "ui"]),
        "orientation": allowed(&report["spec"]["design"]["orientation"], &["landscape", "portrait"]),
        "costUsd": report["costUsd"].as_f64().filter(|value| (0.0..=25.0).contains(value)),
        "createdAt": timestamp(&run["createdAt"]),
        "updatedAt": timestamp(&run["updatedAt"]),
        "stale": false,
        "interrupted": run["interrupted"] == true,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mobile_registry::Scope;
    use rand::rngs::OsRng;
    use russh::keys::{Algorithm, EcdsaCurve, PrivateKey};

    #[test]
    fn protocol_rejects_shell_approval_and_path_injection() {
        for request in [
            json!({"method":"exec", "command":"whoami"}),
            json!({"method":"factory.approve", "runId":Uuid::new_v4()}),
            json!({"method":"factory.start", "projectId":Uuid::new_v4(), "requestId":Uuid::new_v4(), "input":{"brief":"게임", "resumeProject":"../x"}}),
            json!({"method":"projects.list", "host":true}),
            json!({"method":"factory.list", "offset":0, "host":true}),
        ] {
            assert!(
                MobileService::parse(&serde_json::to_vec(&request).unwrap()).is_err(),
                "{request}"
            );
        }
    }

    #[test]
    fn display_titles_do_not_expose_paths_commands_or_credential_prefixes() {
        assert_eq!(
            safe_title(&json!("픽셀 낚시 게임을 만들어줘")).as_deref(),
            Some("픽셀 낚시 게임을 만들어줘")
        );
        for text in [
            "../../private/file",
            "https://example.com",
            "$(whoami)",
            "rm -rf home",
            "sk-ant-secret",
            "비밀번호 1234",
        ] {
            assert_eq!(safe_title(&json!(text)), None);
        }
    }

    #[test]
    fn snapshots_only_return_safe_status_and_closed_gate_labels() {
        let id = Uuid::new_v4();
        let run = json!({"runId":id, "phase":"awaiting_approval", "interrupted":true, "events":[{"seq":5,"detail":"/secret/path"}],
            "approvals":[{"kind":"factory_gate","gate":"device","reason":"/private/file"}],
            "summary":json!({"verdict":"incomplete","template":true,"project":"/private/project","gates":[{"name":"android","status":"blocked","detail":"/private/log","required":true}],"jobs":[{"taskId":"sprite-atlas","status":"blocked","message":"도구를 실행하지 않았습니다: /private/log"}]}).to_string()});
        let safe = safe_run(&run);
        assert_eq!(safe["runId"], id.to_string());
        assert_eq!(safe["sequence"], 5);
        assert_eq!(safe["interrupted"], true);
        assert_eq!(safe["gates"][0]["status"], "blocked");
        assert_eq!(safe["approvals"][0], "기기 설치는 Mac에서 승인해야 합니다.");
        assert_eq!(safe["jobs"][0]["id"], "sprite-atlas");
        assert_eq!(safe["jobs"][0]["reason"], "tool_not_run");
        assert!(!safe.to_string().contains("/private"));
        assert!(!safe.to_string().contains("/secret"));
    }

    #[tokio::test]
    async fn pruned_mobile_history_remains_visible_as_an_explicitly_stale_safe_snapshot() {
        let dir = tempfile::tempdir().unwrap();
        let mut registry = MobileRegistry::open(dir.path().join("devices.json")).unwrap();
        let key = PrivateKey::random(
            &mut OsRng,
            Algorithm::Ecdsa {
                curve: EcdsaCurve::NistP256,
            },
        )
        .unwrap()
        .public_key()
        .to_bytes()
        .unwrap();
        let owner = registry
            .register(
                "기기",
                &key,
                &[Scope {
                    name: "새 프로젝트 만들기".into(),
                    slug: None,
                }],
            )
            .unwrap();
        let project = registry.projects(owner).unwrap()[0].id;
        let run_id = registry
            .reserve(owner, project, Uuid::new_v4(), &"a".repeat(64))
            .unwrap()
            .run_id;
        let snapshot = safe_run(&json!({"runId":run_id,"phase":"done","lastSeq":7,"summary":""}));
        registry
            .cache_snapshots(owner, &[(run_id, snapshot)])
            .unwrap();
        let script = r#"const rl=require('node:readline').createInterface({input:process.stdin});
console.log(JSON.stringify({event:'ready',version:'test'}));
rl.on('line',l=>{const m=JSON.parse(l);console.log(JSON.stringify(m.method==='run.list'?{id:m.id,ok:true,result:{runs:[]}}:{id:m.id,ok:false,error:'missing'}));});"#;
        let runtime = Arc::new(AgentRuntime::with_launcher(
            crate::agent_runtime::node_path().unwrap(),
            vec!["-e".into(), script.into()],
            Box::new(|| Ok(json!({}))),
        ));
        let service = Arc::new(MobileService::new(registry, runtime.clone()));
        let list = service
            .handle(Identity::Device(owner), Request::List { offset: 0 })
            .await
            .unwrap()
            .value;
        assert_eq!(list["runs"][0]["runId"], run_id.to_string());
        assert_eq!(list["runs"][0]["stale"], true);
        let detail = service
            .handle(Identity::Device(owner), Request::Status { run_id })
            .await
            .unwrap()
            .value;
        assert_eq!(detail["sequence"], 7);
        assert_eq!(detail["stale"], true);
        runtime.stop().await;
    }

    #[tokio::test]
    async fn completed_work_is_cached_even_after_the_phone_disconnects() {
        let dir = tempfile::tempdir().unwrap();
        let mut registry = MobileRegistry::open(dir.path().join("devices.json")).unwrap();
        let key = PrivateKey::random(
            &mut OsRng,
            Algorithm::Ecdsa {
                curve: EcdsaCurve::NistP256,
            },
        )
        .unwrap()
        .public_key()
        .to_bytes()
        .unwrap();
        let owner = registry
            .register(
                "기기",
                &key,
                &[Scope {
                    name: "새 프로젝트 만들기".into(),
                    slug: None,
                }],
            )
            .unwrap();
        let project = registry.projects(owner).unwrap()[0].id;
        let run_id = registry
            .reserve(owner, project, Uuid::new_v4(), &"b".repeat(64))
            .unwrap()
            .run_id;
        let script = r#"const rl=require('node:readline').createInterface({input:process.stdin});
console.log(JSON.stringify({event:'ready',version:'test'}));
rl.on('line',l=>{const m=JSON.parse(l);console.log(JSON.stringify({id:m.id,ok:true,result:{runId:m.params.runId,workflow:'game-factory',phase:'done',lastSeq:9,summary:''}}));});"#;
        let runtime = Arc::new(AgentRuntime::with_launcher(
            crate::agent_runtime::node_path().unwrap(),
            vec!["-e".into(), script.into()],
            Box::new(|| Ok(json!({}))),
        ));
        let service = Arc::new(MobileService::new(registry, runtime.clone()));
        service.watch_run(owner, run_id, Duration::from_millis(10));
        let saved = tokio::time::timeout(Duration::from_secs(3), async {
            loop {
                if let Some(value) = service
                    .registry
                    .lock()
                    .await
                    .cached_snapshot(owner, run_id)
                    .unwrap()
                {
                    break value;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        assert_eq!(saved["phase"], "done");
        assert_eq!(saved["sequence"], 9);
        runtime.stop().await;
    }

    #[tokio::test]
    async fn starts_are_idempotent_and_only_the_owning_authorized_device_can_read_or_cancel() {
        let dir = tempfile::tempdir().unwrap();
        let mut registry = MobileRegistry::open(dir.path().join("mobile/devices.json")).unwrap();
        let key = || {
            PrivateKey::random(
                &mut OsRng,
                Algorithm::Ecdsa {
                    curve: EcdsaCurve::NistP256,
                },
            )
            .unwrap()
            .public_key()
            .to_bytes()
            .unwrap()
        };
        let scope = Scope {
            name: "새 프로젝트 만들기".into(),
            slug: None,
        };
        let owner = registry
            .register("기기 1", &key(), &[scope.clone()])
            .unwrap();
        let other = registry.register("기기 2", &key(), &[scope]).unwrap();
        let project = registry.projects(owner).unwrap()[0].id;
        let script = r#"const rl=require('node:readline').createInterface({input:process.stdin});
const runs=new Map(); console.log(JSON.stringify({event:'ready',version:'test'}));
rl.on('line',l=>{const m=JSON.parse(l);let result={};
 if(m.method==='run.start'){result={runId:m.params.runId,workflow:m.params.workflow,phase:'queued',events:[{seq:1}],approvals:[],summary:''};runs.set(result.runId,result);}
 if(m.method==='run.get'||m.method==='run.cancel'){result=runs.get(m.params.runId);if(!result){console.log(JSON.stringify({id:m.id,ok:false,error:'missing'}));return;}if(m.method==='run.cancel')result.phase='cancelled';}
 if(m.method==='run.list')result={runs:[...runs.values()]};
 console.log(JSON.stringify({id:m.id,ok:true,result}));});"#;
        let runtime = Arc::new(AgentRuntime::with_launcher(
            crate::agent_runtime::node_path().unwrap(),
            vec!["-e".into(), script.into()],
            Box::new(|| Ok(json!({}))),
        ));
        let service = Arc::new(MobileService::new(registry, runtime.clone()));
        assert!(service
            .handle(Identity::Enrollment(Uuid::new_v4()), Request::Projects)
            .await
            .is_err());
        let request_id = Uuid::new_v4();
        let body = json!({"method":"factory.start","projectId":project,"requestId":request_id,"input":{"brief":"픽셀 낚시 게임","kind":"game"}});
        let first_service = Arc::clone(&service);
        let first_body = serde_json::to_vec(&body).unwrap();
        let first = tokio::spawn(async move {
            first_service
                .handle(
                    Identity::Device(owner),
                    MobileService::parse(&first_body).unwrap(),
                )
                .await
                .unwrap()
                .value
        });
        let second_service = Arc::clone(&service);
        let second_body = serde_json::to_vec(&body).unwrap();
        let second = tokio::spawn(async move {
            second_service
                .handle(
                    Identity::Device(owner),
                    MobileService::parse(&second_body).unwrap(),
                )
                .await
                .unwrap()
                .value
        });
        let first = first.await.unwrap();
        let second = second.await.unwrap();
        assert_eq!(first["runId"], second["runId"]);
        let run_id = Uuid::parse_str(first["runId"].as_str().unwrap()).unwrap();
        let listed = service
            .handle(Identity::Device(owner), Request::List { offset: 0 })
            .await
            .unwrap()
            .value;
        assert_eq!(listed["runs"][0]["runId"], run_id.to_string());
        assert!(service
            .handle(
                Identity::Enrollment(Uuid::new_v4()),
                Request::List { offset: 0 }
            )
            .await
            .is_err());
        assert!(service
            .handle(Identity::Device(other), Request::List { offset: 0 })
            .await
            .unwrap()
            .value["runs"]
            .as_array()
            .unwrap()
            .is_empty());
        assert!(service
            .handle(Identity::Device(other), Request::Status { run_id })
            .await
            .is_err());
        assert!(service
            .handle(Identity::Device(other), Request::Cancel { run_id })
            .await
            .is_err());
        assert_eq!(
            service
                .handle(Identity::Device(owner), Request::Recover { request_id })
                .await
                .unwrap()
                .value["runId"],
            run_id.to_string()
        );
        assert_eq!(
            service
                .handle(Identity::Device(owner), Request::Cancel { run_id })
                .await
                .unwrap()
                .value["phase"],
            "cancelled"
        );
        service.registry.lock().await.revoke(owner).unwrap();
        assert!(service
            .handle(Identity::Device(owner), Request::Status { run_id })
            .await
            .is_err());
        runtime.stop().await;
    }
}
