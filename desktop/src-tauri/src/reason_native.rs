//! Reason Network is a message transport. Only an explicit local-window action
//! can turn a validated request into a video plan or send a reply to its sender.
use crate::reason_agents::{AgentKind, AgentSession, ReasonAgents};
use crate::reason_network::{Message, ReasonNetwork, Receipt, Snapshot};
use crate::reason_pipeline::{self, Action, PipelineView, Stage};
use crate::reason_project;
use crate::reason_video::{self, VideoRequest};
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::Arc;
use tauri::State;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

type Network<'a> = State<'a, Arc<ReasonNetwork>>;
type Jobs<'a> = State<'a, Arc<crate::production::Productions>>;
type Agent<'a> = State<'a, Arc<crate::agent_runtime::AgentRuntime>>;
type Agents<'a> = State<'a, Arc<ReasonAgents>>;

// Serializes lookup + initial atomic job write. Two clicks (or webview retries)
// cannot both create a plan for the same sender/request ID.
static ACCEPT_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MessageInput {
    message_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SendInput {
    target: String,
    text: String,
    #[serde(default)]
    reply_to: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PipelineCreateInput {
    brief: String,
    assignees: Vec<Option<String>>,
    /// A running Studio-started session; its folder is read natively, never sent by the window.
    #[serde(default)]
    project_session_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectStartInput {
    path: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PipelineUpdateInput {
    pipeline_id: String,
    action: Action,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PipelineSendInput {
    pipeline_id: String,
    stage: Stage,
    digest: String,
    #[serde(default)]
    deploy_approved: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentLaunchInput {
    kind: AgentKind,
}

/// A confirmation the webview cannot answer for the user: an OS dialog owned by this process.
fn confirm(app: &tauri::AppHandle, title: &str, message: String, action: &str) -> bool {
    app.dialog()
        .message(message)
        .title(title)
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom(
            action.into(),
            "취소".into(),
        ))
        .blocking_show()
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentStopInput {
    id: String,
}

async fn video_request(
    network: &ReasonNetwork,
    message_id: &str,
) -> Result<(Message, VideoRequest, String), String> {
    let message = network.message(message_id).await?;
    let request = reason_video::parse_video_request(&message.text)?
        .ok_or("이 메시지는 Toris Studio 영상 제작 요청이 아닙니다.")?;
    let identity = network.identity().await?;
    let key = reason_video::request_key(&identity, &message.from, &request.request_id);
    Ok((message, request, key))
}

async fn linked_job(
    network: &ReasonNetwork,
    message_id: &str,
) -> Result<(Message, VideoRequest, Value), String> {
    let (message, request, key) = video_request(network, message_id).await?;
    let root = crate::production::root()?;
    let job = reason_video::find_existing_request(&root, &key, &request)?
        .ok_or("먼저 이 요청을 영상 제작으로 가져오세요.")?;
    Ok((message, request, job))
}

#[tauri::command]
pub async fn reason_network_refresh(
    window: tauri::WebviewWindow,
    network: Network<'_>,
) -> Result<Snapshot, String> {
    crate::updater::authorize(&window)?;
    let mut snapshot = network.refresh().await;
    // Preserve the transport's error/missing state. Old received requests can
    // still open their local jobs while a remote peer is offline.
    if let Ok(identity) = network.identity().await {
        if let Ok(root) = crate::production::root() {
            for message in &mut snapshot.messages {
                message.job_id = None;
                if let Some(request) = &message.video {
                    message.request_error = None;
                    let key =
                        reason_video::request_key(&identity, &message.from, &request.request_id);
                    match reason_video::find_existing_request(&root, &key, request) {
                        Ok(Some(job)) => {
                            message.job_id = job["id"].as_str().map(str::to_owned);
                        }
                        Ok(None) => {}
                        Err(error) => message.request_error = Some(error),
                    }
                }
            }
        }
    }
    Ok(snapshot)
}

#[tauri::command]
pub async fn reason_network_send(
    window: tauri::WebviewWindow,
    network: Network<'_>,
    input: SendInput,
) -> Result<Receipt, String> {
    crate::updater::authorize(&window)?;
    if let Some(reply_to) = &input.reply_to {
        let original = network.message(reply_to).await?;
        if original.from != input.target {
            return Err("답장은 받은 메시지의 발신자에게만 보낼 수 있습니다.".into());
        }
    }
    network
        .send(&input.target, &input.text, input.reply_to.as_deref())
        .await
}

#[tauri::command]
pub async fn reason_network_accept_video(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    network: Network<'_>,
    jobs: Jobs<'_>,
    agent: Agent<'_>,
    input: MessageInput,
) -> Result<Value, String> {
    crate::updater::authorize(&window)?;
    let _accept = ACCEPT_LOCK.lock().await;
    let (message, request, key) = video_request(&network, &input.message_id).await?;
    let root = crate::production::root()?;
    if let Some(job) = reason_video::find_existing_request(&root, &key, &request)? {
        return Ok(json!({"jobId": job["id"], "reused": true}));
    }
    let mut job = crate::production::new_job(&request.settings);
    reason_video::attach_request(&mut job, &key, &message.from, &message.id, &request)?;
    let job = crate::production_native::start_planning(
        &app,
        jobs.inner().clone(),
        agent.inner().clone(),
        job,
        reason_video::imported_storyboard(&request)?,
    )?;
    Ok(json!({"jobId": job["id"], "reused": false}))
}

#[tauri::command]
pub async fn reason_network_video_result(
    window: tauri::WebviewWindow,
    network: Network<'_>,
    input: MessageInput,
) -> Result<Value, String> {
    crate::updater::authorize(&window)?;
    let (_, _, job) = linked_job(&network, &input.message_id).await?;
    reason_video::video_result(&job)
}

#[tauri::command]
pub async fn reason_network_send_result(
    window: tauri::WebviewWindow,
    network: Network<'_>,
    input: MessageInput,
) -> Result<Receipt, String> {
    crate::updater::authorize(&window)?;
    let (message, request, job) = linked_job(&network, &input.message_id).await?;
    let result = reason_video::video_result(&job)?;
    let body = json!({
        "schema": "toris-studio.video-result.v1",
        "requestId": request.request_id,
        "result": result,
    })
    .to_string();
    // The destination and reply ID come from received metadata, never from the
    // model-written payload. A result contains no local output path or raw log.
    network.send(&message.from, &body, Some(&message.id)).await
}

// Stage pipeline: the request text, recipient and order are decided natively.
// The window only names a pipeline, a closed action, and the digest it showed.

#[tauri::command]
pub async fn reason_pipeline_list(
    window: tauri::WebviewWindow,
    network: Network<'_>,
) -> Result<Vec<PipelineView>, String> {
    crate::updater::authorize(&window)?;
    reason_pipeline::list(&network).await
}

#[tauri::command]
pub async fn reason_pipeline_create(
    window: tauri::WebviewWindow,
    network: Network<'_>,
    agents: Agents<'_>,
    input: PipelineCreateInput,
) -> Result<PipelineView, String> {
    crate::updater::authorize(&window)?;
    let project = match input.project_session_id.as_deref() {
        Some(id) => {
            let session = agents
                .running(id)
                .filter(|session| session.kind == AgentKind::Claude)
                .ok_or("실행 중인 구현 에이전트를 찾지 못했습니다. 프로젝트를 다시 열어 주세요.")?;
            Some(
                tokio::task::spawn_blocking(move || {
                    reason_project::describe(
                        &session.folder,
                        session.branch,
                        &session.name,
                        session.model,
                    )
                })
                .await
                .map_err(|_| "프로젝트 폴더를 읽지 못했습니다.".to_owned())?,
            )
        }
        None => None,
    };
    reason_pipeline::create(&network, &input.brief, &input.assignees, project).await
}

#[tauri::command]
pub async fn reason_pipeline_update(
    window: tauri::WebviewWindow,
    network: Network<'_>,
    input: PipelineUpdateInput,
) -> Result<PipelineView, String> {
    crate::updater::authorize(&window)?;
    reason_pipeline::update(&network, &input.pipeline_id, &input.action).await
}

#[tauri::command]
pub async fn reason_pipeline_send(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    network: Network<'_>,
    input: PipelineSendInput,
) -> Result<PipelineView, String> {
    crate::updater::authorize(&window)?;
    let mut deploy_approved = false;
    if input.stage == Stage::Deploy {
        // The window's checkbox is only a hint; deployment is approved here, natively.
        let views = reason_pipeline::list(&network).await?;
        let next = views
            .iter()
            .find(|view| view.pipeline.id == input.pipeline_id)
            .and_then(|view| view.next.as_ref())
            .filter(|next| next.stage == Stage::Deploy && input.deploy_approved)
            .ok_or("배포 단계는 배포 승인을 체크한 뒤 보낼 수 있습니다.")?;
        let message = format!(
            "배포 단계 요청을 {} 에게 보냅니다.\n\n이 에이전트가 브리프 범위 안에서 배포를 진행합니다. 요청 전문은 Studio 화면에서 확인한 내용과 같을 때만 전송됩니다.",
            next.assignee
        );
        deploy_approved = tokio::task::spawn_blocking(move || {
            confirm(&app, "배포 승인", message, "배포 요청 보내기")
        })
        .await
        .map_err(|_| "배포 승인 창을 열지 못했습니다.".to_owned())?;
        if !deploy_approved {
            return Err("배포 요청을 보내지 않았습니다.".into());
        }
    }
    reason_pipeline::send(
        &network,
        &input.pipeline_id,
        input.stage,
        &input.digest,
        deploy_approved,
    )
    .await
}

// Development agents: the folder comes only from the OS dialog opened here, and
// the launch is confirmed in a second OS dialog. The window supplies the agent
// kind and nothing else, so no page content can choose or approve a folder.

#[tauri::command]
pub async fn reason_agent_launch(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    network: Network<'_>,
    agents: Agents<'_>,
    input: AgentLaunchInput,
) -> Result<Value, String> {
    crate::updater::authorize(&window)?;
    let self_id = network.cached().await?.self_id;
    let machine = self_id
        .as_deref()
        .and_then(|id| id.split_once('@'))
        .map(|(_, machine)| machine.to_owned())
        .ok_or("먼저 Reason Network 연결을 확인하세요.")?;
    let agents = agents.inner().clone();
    tokio::task::spawn_blocking(move || {
        let selected = app
            .dialog()
            .file()
            .set_title("개발 에이전트에게 맡길 프로젝트 폴더 선택")
            .blocking_pick_folder();
        let Some(selected) = selected else {
            return Ok(json!({"cancelled": true}));
        };
        let path = selected.into_path().map_err(|_| "로컬 폴더를 선택하세요.".to_owned())?;
        let draft = agents.offer(&path, input.kind, &machine)?;
        let message = format!(
            "폴더: {}\n브랜치: {}\n세션 이름: {}\n모델: {}\n\n• 이 에이전트는 받은 요청에 따라 이 폴더의 파일을 묻지 않고 수정합니다.\n• 신뢰하는 프로젝트 폴더만 맡기세요. 폴더 안의 설정과 스크립트가 에이전트 동작에 영향을 줄 수 있습니다.\n• 같은 이름으로 답하지 못한 이전 요청이 있으면 실행 직후 그 작업부터 시작합니다.\n• Studio를 종료하면 함께 중지됩니다.",
            draft.folder,
            draft.branch.as_deref().unwrap_or("확인되지 않음"),
            draft.name,
            draft.model.as_deref().unwrap_or("에이전트 기본 설정")
        );
        let title = match input.kind {
            AgentKind::Claude => "Claude Code를 이 폴더에서 실행할까요?",
            AgentKind::Codex => "Codex를 이 폴더에서 실행할까요?",
        };
        if !confirm(&app, title, message, "실행") {
            return Ok(json!({"cancelled": true}));
        }
        let sessions = agents.start(input.kind, &draft.folder)?;
        Ok(json!({"cancelled": false, "sessions": sessions}))
    })
    .await
    .map_err(|_| "폴더 선택 창을 열지 못했습니다.".to_owned())?
}

/// Opens a project by the path the user typed: the host resolves and checks the
/// folder, shows it with the fixed implementation model in an OS confirmation,
/// and only then starts Claude Code there. A project already served by a
/// Studio-started Claude session is reused without a second launch.
#[tauri::command]
pub async fn reason_project_start(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    network: Network<'_>,
    agents: Agents<'_>,
    input: ProjectStartInput,
) -> Result<Value, String> {
    crate::updater::authorize(&window)?;
    let self_id = network.cached().await?.self_id;
    let machine = self_id
        .as_deref()
        .and_then(|id| id.split_once('@'))
        .map(|(_, machine)| machine.to_owned())
        .ok_or("먼저 Reason Network 연결을 확인하세요.")?;
    let agents = agents.inner().clone();
    tokio::task::spawn_blocking(move || {
        let draft = agents.offer_path(&input.path, AgentKind::Claude, &machine)?;
        if let Some(session) = agents.serving(AgentKind::Claude, &draft.folder) {
            return Ok(json!({"cancelled": false, "reused": true, "session": session, "sessions": agents.list()}));
        }
        let message = format!(
            "폴더: {}\n브랜치: {}\n세션 이름: {}\n모델: {}\n\n• 기획(Muse·OpenAI Dots)과 디자인 답장을 받은 뒤, 개발 단계 요청을 승인하면 이 에이전트가 이 폴더의 파일을 묻지 않고 수정합니다.\n• 기획 요청에는 이 폴더의 최상위 항목·package.json 요약·README 앞부분이 들어가며, 보내기 전에 전문을 확인합니다.\n• 신뢰하는 프로젝트 폴더만 맡기세요. Studio를 종료하면 함께 중지됩니다.",
            draft.folder,
            draft.branch.as_deref().unwrap_or("확인되지 않음"),
            draft.name,
            draft.model.as_deref().unwrap_or("기본값"),
        );
        if !confirm(&app, "이 프로젝트에서 구현 에이전트를 실행할까요?", message, "실행") {
            return Ok(json!({"cancelled": true}));
        }
        let sessions = agents.start(AgentKind::Claude, &draft.folder)?;
        let session = agents.serving(AgentKind::Claude, &draft.folder);
        Ok(json!({"cancelled": false, "reused": false, "session": session, "sessions": sessions}))
    })
    .await
    .map_err(|_| "프로젝트 확인 창을 열지 못했습니다.".to_owned())?
}

#[tauri::command]
pub async fn reason_agent_stop(
    window: tauri::WebviewWindow,
    agents: Agents<'_>,
    input: AgentStopInput,
) -> Result<Vec<AgentSession>, String> {
    crate::updater::authorize(&window)?;
    let agents = agents.inner().clone();
    // Stopping waits for the session to leave the network.
    tokio::task::spawn_blocking(move || agents.stop(&input.id))
        .await
        .map_err(|_| "세션을 중지하지 못했습니다.".to_owned())?
}

#[tauri::command]
pub async fn reason_agent_list(
    window: tauri::WebviewWindow,
    agents: Agents<'_>,
) -> Result<Vec<AgentSession>, String> {
    crate::updater::authorize(&window)?;
    Ok(agents.list())
}
