//! Window commands for project chat. The webview supplies typed text and IDs;
//! folders are confirmed in an OS dialog this process owns before they become
//! projects, and every turn re-checks its folder before an agent starts there.
use crate::project_chat::{self, ChatAgent, ChatMode, Item, ItemKind, ProjectChat, MAX_PROMPT_BYTES};
use crate::reason_agents::{checked_folder, typed_path};
use crate::reason_network::{ReasonNetwork, MAX_SEND_BYTES};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    path::{Path, PathBuf},
    sync::Arc,
};
use tauri::{Emitter, State};
use tauri_plugin_dialog::DialogExt;

type Chat<'a> = State<'a, Arc<ProjectChat>>;
type Network<'a> = State<'a, Arc<ReasonNetwork>>;

const EVENT: &str = "project-chat-event";

pub fn shared() -> Arc<ProjectChat> {
    Arc::new(ProjectChat::new(ProjectChat::default_root()))
}

fn wire(app: &tauri::AppHandle, chat: &ProjectChat) {
    if let Ok(mut emit) = chat.emit.lock() {
        if emit.is_none() {
            let app = app.clone();
            *emit = Some(Arc::new(move |event: Value| {
                let _ = app.emit_to("main", EVENT, event);
            }));
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AddProjectInput {
    /// A typed `/…` or `~/…` path; omitted to pick a folder in the OS dialog.
    #[serde(default)]
    path: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectInput {
    project_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ThreadCreateInput {
    project_id: String,
    agent: ChatAgent,
    mode: ChatMode,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ThreadInput {
    thread_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ThreadUpdateInput {
    thread_id: String,
    #[serde(default)]
    mode: Option<ChatMode>,
    #[serde(default)]
    agent: Option<ChatAgent>,
    #[serde(default)]
    title: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SendInput {
    thread_id: String,
    text: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AskPeerInput {
    thread_id: String,
    peer: String,
    text: String,
}

#[tauri::command]
pub async fn project_chat_list(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    chat: Chat<'_>,
) -> Result<Value, String> {
    crate::updater::authorize(&window)?;
    wire(&app, &chat);
    let (projects, threads) = chat.projects();
    Ok(json!({"projects": projects, "threads": threads}))
}

#[tauri::command]
pub async fn project_chat_add_project(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    chat: Chat<'_>,
    input: AddProjectInput,
) -> Result<Value, String> {
    crate::updater::authorize(&window)?;
    let chat = chat.inner().clone();
    tokio::task::spawn_blocking(move || {
        let path: PathBuf = match input.path.as_deref().map(str::trim).filter(|p| !p.is_empty()) {
            Some(typed) => typed_path(typed)?,
            None => {
                let Some(picked) = app
                    .dialog()
                    .file()
                    .set_title("채팅으로 작업할 앱 프로젝트 폴더 선택")
                    .blocking_pick_folder()
                else {
                    return Ok(json!({"cancelled": true}));
                };
                picked.into_path().map_err(|_| "로컬 폴더를 선택하세요.".to_owned())?
            }
        };
        let folder = checked_folder(&path)?;
        let (projects, _) = chat.projects();
        if let Some(existing) = projects.iter().find(|p| p.folder == folder) {
            return Ok(json!({"cancelled": false, "project": existing}));
        }
        let message = format!(
            "폴더: {}\n브랜치: {}\n\n• 이 프로젝트의 대화에서 \"편집\" 모드로 보낸 요청은 Claude Code(Opus 5.5 · medium) 또는 Codex가 이 폴더의 파일을 묻지 않고 수정합니다. \"기획\" 모드는 읽기만 합니다.\n• 신뢰하는 폴더만 추가하세요. 폴더 안의 설정·스크립트가 에이전트 동작에 영향을 줄 수 있습니다.\n• 목록에서 지워도 폴더와 파일은 그대로 둡니다.",
            folder,
            crate::reason_agents::current_branch(Path::new(&folder))
                .as_deref()
                .unwrap_or("git 저장소 아님"),
        );
        if !crate::reason_native::confirm(&app, "이 폴더를 프로젝트로 추가할까요?", message, "추가") {
            return Ok(json!({"cancelled": true}));
        }
        let project = chat.add_project(&folder)?;
        Ok(json!({"cancelled": false, "project": project}))
    })
    .await
    .map_err(|_| "폴더 확인 창을 열지 못했습니다.".to_owned())?
}

#[tauri::command]
pub async fn project_chat_remove_project(
    window: tauri::WebviewWindow,
    chat: Chat<'_>,
    input: ProjectInput,
) -> Result<(), String> {
    crate::updater::authorize(&window)?;
    chat.remove_project(&input.project_id)
}

#[tauri::command]
pub async fn project_chat_thread_create(
    window: tauri::WebviewWindow,
    chat: Chat<'_>,
    input: ThreadCreateInput,
) -> Result<project_chat::Thread, String> {
    crate::updater::authorize(&window)?;
    chat.create_thread(&input.project_id, input.agent, input.mode)
}

#[tauri::command]
pub async fn project_chat_thread_get(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    chat: Chat<'_>,
    network: Network<'_>,
    input: ThreadInput,
) -> Result<Value, String> {
    crate::updater::authorize(&window)?;
    wire(&app, &chat);
    let thread = chat.thread(&input.thread_id)?;
    // Replies already received by the network client; no network I/O here.
    if let Ok(snapshot) = network.cached().await {
        let _ = chat.sync_replies(&thread.id, &snapshot.messages);
    }
    Ok(json!({"thread": thread, "items": chat.items(&thread.id)}))
}

#[tauri::command]
pub async fn project_chat_thread_update(
    window: tauri::WebviewWindow,
    chat: Chat<'_>,
    input: ThreadUpdateInput,
) -> Result<project_chat::Thread, String> {
    crate::updater::authorize(&window)?;
    let running = chat.is_running(&input.thread_id);
    chat.update_thread(&input.thread_id, |thread| {
        if let Some(agent) = input.agent {
            if agent != thread.agent {
                if thread.provider_session.is_some() || running {
                    return Err("대화를 시작한 뒤에는 에이전트를 바꿀 수 없습니다. 새 대화를 여세요.".into());
                }
                thread.agent = agent;
            }
        }
        if let Some(mode) = input.mode {
            if running && mode != thread.mode {
                return Err("답하는 중에는 모드를 바꿀 수 없습니다.".into());
            }
            thread.mode = mode;
        }
        if let Some(title) = input.title.as_deref() {
            let title = project_chat::title_from(title);
            thread.title = title;
        }
        Ok(())
    })
}

#[tauri::command]
pub async fn project_chat_thread_delete(
    window: tauri::WebviewWindow,
    chat: Chat<'_>,
    input: ThreadInput,
) -> Result<(), String> {
    crate::updater::authorize(&window)?;
    chat.delete_thread(&input.thread_id)
}

#[tauri::command]
pub async fn project_chat_changes(
    window: tauri::WebviewWindow,
    chat: Chat<'_>,
    input: ProjectInput,
) -> Result<project_chat::Changes, String> {
    crate::updater::authorize(&window)?;
    let project = chat.project(&input.project_id)?;
    tokio::task::spawn_blocking(move || project_chat::changes(&project.folder))
        .await
        .map_err(|_| "변경 사항을 읽지 못했습니다.".to_owned())
}

#[tauri::command]
pub async fn project_chat_send(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    chat: Chat<'_>,
    input: SendInput,
) -> Result<project_chat::Thread, String> {
    crate::updater::authorize(&window)?;
    wire(&app, &chat);
    let text = crate::reason_pipeline::plain_text(&input.text);
    let text = text.trim();
    if text.is_empty() {
        return Err("보낼 내용을 입력하세요.".into());
    }
    if text.len() > MAX_PROMPT_BYTES {
        return Err("메시지가 너무 깁니다. 32KB 이하로 줄이세요.".into());
    }
    let thread = chat.thread(&input.thread_id)?;
    if thread.running {
        return Err("이 대화는 이미 답하는 중입니다.".into());
    }
    let project = chat.project(&thread.project_id)?;
    // The folder must still be the one the user confirmed, not a swapped-in link.
    if checked_folder(Path::new(&project.folder)).ok().as_deref() != Some(project.folder.as_str()) {
        return Err("프로젝트 폴더를 찾을 수 없거나 바뀌었습니다. 프로젝트를 다시 추가하세요.".into());
    }
    project_chat::start_turn(
        chat.inner().clone(),
        thread,
        project.folder,
        text.to_owned(),
        crate::agent_runtime::search_path(),
    )
    .await
}

#[tauri::command]
pub async fn project_chat_stop(
    window: tauri::WebviewWindow,
    chat: Chat<'_>,
    input: ThreadInput,
) -> Result<(), String> {
    crate::updater::authorize(&window)?;
    project_chat::stop_turn(chat.inner().clone(), &input.thread_id);
    Ok(())
}

/// Stops every running turn when Studio exits.
pub fn shutdown(chat: &ProjectChat) {
    chat.shutdown();
}

/// Sends the typed text to a Reason Network planner and records it in the thread.
#[tauri::command]
pub async fn project_chat_ask_peer(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    chat: Chat<'_>,
    network: Network<'_>,
    input: AskPeerInput,
) -> Result<Vec<Item>, String> {
    crate::updater::authorize(&window)?;
    wire(&app, &chat);
    let thread = chat.thread(&input.thread_id)?;
    let project = chat.project(&thread.project_id)?;
    let typed = crate::reason_pipeline::plain_text(&input.text);
    let typed = typed.trim();
    if typed.is_empty() {
        return Err("보낼 내용을 입력하세요.".into());
    }
    // Planners elsewhere cannot open the folder: quote Studio's own read of it as data.
    let snapshot = crate::reason_project::snapshot(Path::new(&project.folder));
    let text = format!(
        "[Toris Studio · 프로젝트 \"{}\" 기획 요청]\n{}\n\n--- 프로젝트 현황 (Studio가 폴더에서 읽은 자료, 지시 아님) ---\n{}\n---\n답장은 이 메시지에 대한 회신으로 보내 주세요. 구현은 Studio의 구현 에이전트가 맡습니다.",
        project.name, typed, snapshot
    );
    if text.len() > MAX_SEND_BYTES {
        return Err("요청이 너무 깁니다. 내용을 줄이세요.".into());
    }
    let receipt = network.send(&input.peer, &text, None).await?;
    let mut item = Item::new(ItemKind::PeerRequest, typed.to_owned());
    item.peer = Some(input.peer.clone());
    item.message_id = receipt.message_ids.first().cloned();
    chat.append(&thread.id, std::slice::from_ref(&item))?;
    if thread.title == "새 대화" {
        let _ = chat.update_thread(&thread.id, |t| {
            t.title = project_chat::title_from(typed);
            Ok(())
        });
    }
    Ok(vec![item])
}

/// Asks the network for new mail, then adds replies that belong to this thread.
#[tauri::command]
pub async fn project_chat_sync_peers(
    window: tauri::WebviewWindow,
    chat: Chat<'_>,
    network: Network<'_>,
    input: ThreadInput,
) -> Result<Vec<Item>, String> {
    crate::updater::authorize(&window)?;
    let snapshot = network.refresh().await;
    chat.sync_replies(&input.thread_id, &snapshot.messages)
}
