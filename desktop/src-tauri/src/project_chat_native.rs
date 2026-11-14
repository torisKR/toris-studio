//! Window commands for project chat. The webview supplies typed text and IDs;
//! folders are confirmed in an OS dialog this process owns before they become
//! projects, and every turn re-checks its folder before an agent starts there.
use crate::project_chat::{
    self, ChatAgent, ChatMode, HostedAssistant, Item, ItemKind, ProjectChat, MAX_PROMPT_BYTES,
};
use crate::project_worktrees;
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
pub struct ChangesInput {
    project_id: String,
    /// Read the folder this thread works in (its linked worktree, if any).
    #[serde(default)]
    thread_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LinkWorktreeInput {
    thread_id: String,
    /// A typed `/…` or `~/…` path; omitted to pick a folder in the OS dialog.
    #[serde(default)]
    path: Option<String>,
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
    /// Answer a planner reply in this thread (how a hosted assistant gets an answer).
    #[serde(default)]
    reply_to: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LinkInput {
    thread_id: String,
    message_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HostedInput {
    thread_id: String,
    assistant: HostedAssistant,
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
                    return Err(
                        "대화를 시작한 뒤에는 에이전트를 바꿀 수 없습니다. 새 대화를 여세요."
                            .into(),
                    );
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

/// The folder a thread works in, re-checked with git off the async runtime.
async fn work_folder(
    project: project_chat::Project,
    thread: project_chat::Thread,
) -> Result<String, String> {
    tokio::task::spawn_blocking(move || project_chat::work_folder(&project, &thread))
        .await
        .map_err(|_| "작업 폴더를 확인하지 못했습니다.".to_owned())?
}

/// Links an existing git worktree of the project to a thread that has not
/// started, after an OS confirmation that names both folders. The folder comes
/// from the OS dialog (or a typed path) and is checked here, never trusted.
#[tauri::command]
pub async fn project_chat_link_worktree(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    chat: Chat<'_>,
    input: LinkWorktreeInput,
) -> Result<Value, String> {
    crate::updater::authorize(&window)?;
    let chat = chat.inner().clone();
    tokio::task::spawn_blocking(move || {
        let thread = chat.thread(&input.thread_id)?;
        let project = chat.project(&thread.project_id)?;
        let path: PathBuf = match input.path.as_deref().map(str::trim).filter(|p| !p.is_empty()) {
            Some(typed) => typed_path(typed)?,
            None => {
                let mut dialog = app
                    .dialog()
                    .file()
                    .set_title("이 대화가 작업할 Git worktree 폴더 선택");
                if let Some(parent) = Path::new(&project.folder).parent() {
                    dialog = dialog.set_directory(parent);
                }
                let Some(picked) = dialog.blocking_pick_folder() else {
                    return Ok(json!({"cancelled": true}));
                };
                picked.into_path().map_err(|_| "로컬 폴더를 선택하세요.".to_owned())?
            }
        };
        let folder = checked_folder(&path)?;
        let worktree = project_chat::verify_worktree(&project.folder, &folder)?;
        let message = format!(
            "원본 프로젝트: {}\n작업 폴더(worktree): {}\n브랜치: {}\n기준 커밋: {}\n\n• 이 대화의 Claude Code·Codex 실행, 기획 요청의 프로젝트 현황, 변경 사항은 모두 이 worktree에서 읽고 씁니다. \"편집\" 모드는 이 폴더의 파일을 묻지 않고 수정합니다.\n• 원본 프로젝트 폴더의 파일과 변경은 건드리지 않습니다.\n• 첫 메시지를 보낸 뒤에는 작업 폴더를 바꿀 수 없습니다.\n• 대화를 지워도 worktree 폴더와 파일은 그대로 둡니다.",
            project.folder,
            worktree.path,
            worktree.branch.as_deref().unwrap_or("(분리된 HEAD)"),
            &worktree.base[..12],
        );
        if !crate::reason_native::confirm(&app, "이 worktree를 대화의 작업 폴더로 연결할까요?", message, "연결") {
            return Ok(json!({"cancelled": true}));
        }
        let thread = chat.link_worktree(&thread.id, &folder)?;
        Ok(json!({"cancelled": false, "thread": thread}))
    })
    .await
    .map_err(|_| "폴더 확인 창을 열지 못했습니다.".to_owned())?
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorktreeRecordInput {
    record_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorktreeResumeInput {
    record_id: String,
    thread_id: String,
}

/// The folder, branch and base commit Studio would create for an unstarted
/// thread. Read-only; names come from the thread ID, never from the window.
#[tauri::command]
pub async fn project_chat_worktree_plan(
    window: tauri::WebviewWindow,
    chat: Chat<'_>,
    input: ThreadInput,
) -> Result<project_worktrees::WorktreePlan, String> {
    crate::updater::authorize(&window)?;
    let chat = chat.inner().clone();
    tokio::task::spawn_blocking(move || project_worktrees::plan(&chat, &input.thread_id))
        .await
        .map_err(|_| "worktree 계획을 만들지 못했습니다.".to_owned())?
}

/// Creates a new branch and worktree from the committed HEAD for an unstarted
/// thread after an OS confirmation that names them, then links it.
#[tauri::command]
pub async fn project_chat_create_worktree(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    chat: Chat<'_>,
    input: ThreadInput,
) -> Result<Value, String> {
    crate::updater::authorize(&window)?;
    let chat = chat.inner().clone();
    tokio::task::spawn_blocking(move || {
        let created = project_worktrees::create(&chat, &input.thread_id, |plan| {
            crate::reason_native::confirm(
                &app,
                "이 대화용 새 브랜치와 worktree를 만들까요?",
                project_worktrees::confirm_message(plan),
                "만들기",
            )
        })?;
        Ok(match created {
            Some(thread) => json!({"cancelled": false, "thread": thread}),
            None => json!({"cancelled": true}),
        })
    })
    .await
    .map_err(|_| "worktree를 만들지 못했습니다.".to_owned())?
}

/// Creations that did not finish, with what is on disk and what to do.
#[tauri::command]
pub async fn project_chat_worktree_pending(
    window: tauri::WebviewWindow,
    chat: Chat<'_>,
) -> Result<Vec<project_worktrees::PendingWorktree>, String> {
    crate::updater::authorize(&window)?;
    let chat = chat.inner().clone();
    tokio::task::spawn_blocking(move || project_worktrees::pending(&chat))
        .await
        .map_err(|_| "worktree 생성 기록을 읽지 못했습니다.".to_owned())
}

/// Links a worktree Studio created but did not save to an unstarted thread,
/// after an OS confirmation.
#[tauri::command]
pub async fn project_chat_worktree_resume(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    chat: Chat<'_>,
    input: WorktreeResumeInput,
) -> Result<Value, String> {
    crate::updater::authorize(&window)?;
    let chat = chat.inner().clone();
    tokio::task::spawn_blocking(move || {
        let record = project_worktrees::pending(&chat)
            .into_iter()
            .find(|r| r.id == input.record_id)
            .ok_or("그 생성 기록을 찾지 못했습니다. 목록을 새로고침하세요.")?;
        let message = format!(
            "작업 폴더(worktree): {}\n브랜치: {}\n\n앞서 Studio가 만들었지만 대화에 저장하지 못한 worktree입니다. 이 대화의 작업 폴더로 연결합니다. 첫 메시지를 보낸 뒤에는 바꿀 수 없습니다.",
            record.path, record.branch
        );
        if !crate::reason_native::confirm(&app, "남은 worktree를 이 대화에 연결할까요?", message, "연결") {
            return Ok(json!({"cancelled": true}));
        }
        let thread = project_worktrees::resume(&chat, &record.id, &input.thread_id)?;
        Ok(json!({"cancelled": false, "thread": thread}))
    })
    .await
    .map_err(|_| "worktree를 연결하지 못했습니다.".to_owned())?
}

/// Drops a pending creation record; the folder and branch are left alone.
#[tauri::command]
pub async fn project_chat_worktree_forget(
    window: tauri::WebviewWindow,
    chat: Chat<'_>,
    input: WorktreeRecordInput,
) -> Result<(), String> {
    crate::updater::authorize(&window)?;
    project_worktrees::forget(&chat, &input.record_id)
}

#[tauri::command]
pub async fn project_chat_changes(
    window: tauri::WebviewWindow,
    chat: Chat<'_>,
    input: ChangesInput,
) -> Result<project_chat::Changes, String> {
    crate::updater::authorize(&window)?;
    let project = chat.project(&input.project_id)?;
    let folder = match input.thread_id.as_deref() {
        Some(id) => {
            let thread = chat.thread(id)?;
            if thread.project_id != project.id {
                return Err("이 프로젝트의 대화가 아닙니다.".into());
            }
            work_folder(project, thread).await?
        }
        None => project.folder,
    };
    tokio::task::spawn_blocking(move || project_chat::changes(&folder))
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
    // The folder must still be the one the user confirmed, not a swapped-in link:
    // the project folder, or the thread's worktree of the same repository.
    let folder = work_folder(project, thread.clone()).await?;
    project_chat::start_turn(
        chat.inner().clone(),
        thread,
        folder,
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
    if let Some(reply_to) = input.reply_to.as_deref() {
        return answer_reply(&chat, &network, &thread, reply_to, &input.peer, typed).await;
    }
    // Planners elsewhere cannot open the folder: quote Studio's own read of it as data.
    let folder = work_folder(project.clone(), thread.clone()).await?;
    let snapshot = crate::reason_project::snapshot(Path::new(&folder));
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

/// Sends an answer to a planner reply this thread holds, as a reply to that
/// message, so a hosted assistant sees it with check_inbox. Only the sender of
/// that reply can be answered this way.
async fn answer_reply(
    chat: &ProjectChat,
    network: &ReasonNetwork,
    thread: &project_chat::Thread,
    reply_to: &str,
    peer: &str,
    typed: &str,
) -> Result<Vec<Item>, String> {
    let reply = chat
        .reply_item(&thread.id, reply_to)
        .ok_or("이 대화에 없는 기획에는 답장할 수 없습니다.")?;
    if reply.peer.as_deref() != Some(peer) {
        return Err("답장은 그 기획을 보낸 쪽에게만 보낼 수 있습니다.".into());
    }
    if typed.len() > MAX_SEND_BYTES {
        return Err("답장이 너무 깁니다. 내용을 줄이세요.".into());
    }
    let receipt = network.send(peer, typed, Some(reply_to)).await?;
    let mut item = Item::new(ItemKind::PeerRequest, typed.to_owned());
    item.peer = Some(peer.to_owned());
    item.peer_name = reply.peer_name.clone();
    item.message_id = receipt.message_ids.first().cloned();
    chat.append(&thread.id, std::slice::from_ref(&item))?;
    Ok(vec![item])
}

/// Records a request for a hosted assistant and returns it with the prompt to
/// copy. Nothing is sent: the user pastes the prompt into Muse, Dots or Grok.
#[tauri::command]
pub async fn project_chat_hosted_request(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    chat: Chat<'_>,
    network: Network<'_>,
    input: HostedInput,
) -> Result<Vec<Item>, String> {
    crate::updater::authorize(&window)?;
    wire(&app, &chat);
    let thread = chat.thread(&input.thread_id)?;
    let project = chat.project(&thread.project_id)?;
    let typed = crate::reason_pipeline::plain_text(&input.text);
    let typed = typed.trim();
    if typed.is_empty() {
        return Err("기획 요청을 입력하세요.".into());
    }
    if typed.len() > MAX_SEND_BYTES / 2 {
        return Err("요청이 너무 깁니다. 내용을 줄이세요.".into());
    }
    let snapshot = network.refresh().await;
    let studio = snapshot
        .self_id
        .filter(|_| snapshot.state == "connected")
        .ok_or("Reason Network에 연결된 뒤에 요청을 만들 수 있습니다. Agent → Reason Network에서 연결을 확인하세요.")?;
    let code = project_chat::handoff_code();
    let folder = work_folder(project.clone(), thread.clone()).await?;
    let folder = crate::reason_project::snapshot(Path::new(&folder));
    let prompt = project_chat::hosted_prompt(
        input.assistant,
        &project.name,
        typed,
        &folder,
        &studio,
        &code,
    );
    let mut item = Item::new(ItemKind::HostedRequest, typed.to_owned());
    item.peer_name = Some(input.assistant.label().to_owned());
    item.code = Some(code);
    item.prompt = Some(prompt);
    chat.append(&thread.id, std::slice::from_ref(&item))?;
    if thread.title == "새 대화" {
        let _ = chat.update_thread(&thread.id, |t| {
            t.title = project_chat::title_from(typed);
            Ok(())
        });
    }
    Ok(vec![item])
}

/// Files a message from Studio's inbox in a thread as a planner reply. Only
/// the IDs come from the window; sender and text are read from the inbox.
#[tauri::command]
pub async fn project_chat_link_message(
    window: tauri::WebviewWindow,
    chat: Chat<'_>,
    network: Network<'_>,
    input: LinkInput,
) -> Result<Vec<Item>, String> {
    crate::updater::authorize(&window)?;
    let thread = chat.thread(&input.thread_id)?;
    let snapshot = network.refresh().await;
    let message = snapshot
        .messages
        .iter()
        .find(|m| m.id == input.message_id)
        .ok_or("받은 메시지함에서 그 메시지를 찾지 못했습니다. 새로고침한 뒤 다시 고르세요.")?;
    Ok(chat
        .link_message(&thread.id, message)?
        .into_iter()
        .collect())
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

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PreviewInput {
    thread_id: String,
    url: String,
}

/// Stores (or clears, with an empty URL) the user-typed loopback preview
/// address of one thread. Nothing is opened, fetched or started here.
#[tauri::command]
pub async fn project_chat_thread_preview(
    window: tauri::WebviewWindow,
    chat: Chat<'_>,
    input: PreviewInput,
) -> Result<project_chat::Thread, String> {
    crate::updater::authorize(&window)?;
    let url = project_chat::preview_url(&input.url)?;
    chat.update_thread(&input.thread_id, |thread| {
        thread.preview_url = url;
        Ok(())
    })
}
