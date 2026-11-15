//! Project chat for the paired phone: a read-only, sanitized view of the
//! conversations the Mac opened to a device, and one narrow write — a follow-up
//! message that runs exactly like a desktop-sent one in the thread's current
//! mode. The phone never sees tool calls, tool output, thinking, raw errors,
//! absolute paths, handoff codes or hosted prompts, and cannot change mode,
//! approve commits, link worktrees, attach files or run a shell.
use crate::project_chat::{self, Item, ItemKind, Project, ProjectChat, RunOutcome, Thread};
use crate::reason_pipeline::plain_text;
use serde_json::{json, Value};
use std::{path::PathBuf, sync::Arc};

pub const PAGE_SIZE: usize = 20;
pub const MAX_MESSAGES: usize = 40;
const MAX_MESSAGE_CHARS: usize = 2000;
const MAX_PREVIEW_CHARS: usize = 120;
pub const MAX_REPLY_CHARS: usize = 2000;
/// Keeps a reply inside the 8 KiB request line together with its JSON fields.
pub const MAX_REPLY_BYTES: usize = 6000;
const HIDDEN_PATH: &str = "‹경로›";
const HIDDEN_SECRET: &str = "‹비밀값 숨김›";
pub const RUNNING: &str = "이 대화는 이미 답하는 중입니다.";
pub const NOT_VISIBLE: &str = "이 기기에 공개되지 않은 대화입니다.";

/// The thread's state as the phone shows it.
/// `needs_input` is a rule, not a model guess: the planner answered after the
/// user's last message, or the finished turn's last answer ends in a question.
pub fn status(thread: &Thread, items: &[Item]) -> &'static str {
    if thread.running {
        return "running";
    }
    let last = items.iter().rev().find(|item| {
        matches!(
            item.kind,
            ItemKind::User
                | ItemKind::Assistant
                | ItemKind::PeerRequest
                | ItemKind::PeerReply
                | ItemKind::HostedRequest
                | ItemKind::Error
        )
    });
    if last.is_some_and(|item| item.kind == ItemKind::PeerReply) {
        return "needs_input";
    }
    match thread.last_run.as_ref().map(|run| run.outcome) {
        Some(RunOutcome::Failed) => "failed",
        Some(RunOutcome::Done)
            if last.is_some_and(|item| {
                item.kind == ItemKind::Assistant && item.text.trim_end().ends_with(['?', '？'])
            }) =>
        {
            "needs_input"
        }
        Some(_) => "done",
        None => "idle",
    }
}

fn last_activity(thread: &Thread, items: &[Item]) -> Option<String> {
    let parse = |text: &str| chrono::DateTime::parse_from_rfc3339(text).ok();
    [
        Some(thread.updated_at.as_str()),
        items.last().map(|item| item.at.as_str()),
        thread.last_run.as_ref().map(|run| run.finished_at.as_str()),
    ]
    .into_iter()
    .flatten()
    .filter_map(parse)
    .max()
    .map(|at| at.with_timezone(&chrono::Utc).to_rfc3339())
}

fn timestamp(text: &str) -> Option<String> {
    chrono::DateTime::parse_from_rfc3339(text)
        .ok()
        .map(|at| at.with_timezone(&chrono::Utc).to_rfc3339())
}

pub fn conversation(project: &Project, thread: &Thread, items: &[Item]) -> Value {
    let preview = items
        .iter()
        .rev()
        .find(|item| {
            matches!(
                item.kind,
                ItemKind::User | ItemKind::Assistant | ItemKind::PeerReply
            )
        })
        .map(|item| one_line(&safe_text(&item.text, MAX_PREVIEW_CHARS)));
    json!({
        "threadId": thread.id,
        "projectName": one_line(&safe_text(&project.name, 60)),
        "title": one_line(&safe_text(&thread.title, 60)),
        "agent": thread.agent,
        "mode": thread.mode,
        "status": status(thread, items),
        "lastActivity": last_activity(thread, items),
        "preview": preview,
    })
}

fn one_line(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Short display name for a planner; never its network address.
fn planner(item: &Item) -> Option<String> {
    let name = item.peer_name.as_deref()?;
    let lower = name.to_lowercase();
    Some(if lower.contains("muse") {
        "Muse".into()
    } else if lower.contains("dots") {
        "OpenAI Dots".into()
    } else if lower.contains("grok") {
        "Grok Bot".into()
    } else {
        one_line(&safe_text(name, 40))
    })
}

fn message(item: &Item, items_after: &[Item]) -> Option<Value> {
    let (kind, text) = match item.kind {
        ItemKind::User => ("user", safe_text(&item.text, MAX_MESSAGE_CHARS)),
        ItemKind::Assistant => ("assistant", safe_text(&item.text, MAX_MESSAGE_CHARS)),
        ItemKind::PeerRequest => ("planner_request", safe_text(&item.text, MAX_MESSAGE_CHARS)),
        ItemKind::PeerReply => ("planner_reply", safe_text(&item.text, MAX_MESSAGE_CHARS)),
        // Only what the user typed; the hosted prompt quotes files and the code.
        ItemKind::HostedRequest => ("hosted_request", safe_text(&item.text, MAX_MESSAGE_CHARS)),
        ItemKind::Notice => ("notice", safe_text(&item.text, 300)),
        ItemKind::Result => ("result", safe_text(&item.text, 120)),
        // Error items can carry CLI stderr: the phone gets a fixed line only.
        ItemKind::Error => (
            "error",
            "이번 턴이 실패했습니다. 자세한 내용은 Mac에서 확인하세요.".to_owned(),
        ),
        ItemKind::Thinking | ItemKind::Tool | ItemKind::ToolResult => return None,
    };
    let answered = (item.kind == ItemKind::HostedRequest)
        .then(|| items_after.iter().any(|i| i.kind == ItemKind::PeerReply));
    let planner = match item.kind {
        ItemKind::PeerRequest | ItemKind::PeerReply | ItemKind::HostedRequest => planner(item),
        _ => None,
    };
    Some(json!({
        "id": one_line(&safe_text(&item.id, 64)),
        "kind": kind,
        "text": text,
        "planner": planner,
        "at": timestamp(&item.at),
        "answered": answered,
    }))
}

/// The thread with its project, when one of the device's chat projects holds
/// it. A missing thread and a hidden one get the same answer.
pub fn visible(
    chat: &ProjectChat,
    allowed: &[String],
    thread_id: &str,
) -> Result<(Project, Thread), String> {
    let thread = chat.thread(thread_id).map_err(|_| NOT_VISIBLE)?;
    if !allowed.contains(&thread.project_id) {
        return Err(NOT_VISIBLE.into());
    }
    let project = chat.project(&thread.project_id).map_err(|_| NOT_VISIBLE)?;
    Ok((project, thread))
}

pub fn list(
    chat: &ProjectChat,
    allowed: &[String],
    offset: usize,
    needs_input: bool,
) -> Result<Value, String> {
    if offset > project_chat::MAX_THREADS {
        return Err("대화 목록 위치를 확인하세요.".into());
    }
    let (projects, threads) = chat.projects();
    let mut all: Vec<(Option<String>, Value)> = threads
        .iter()
        .filter(|thread| allowed.contains(&thread.project_id))
        .filter_map(|thread| {
            let project = projects.iter().find(|p| p.id == thread.project_id)?;
            let items = chat.items(&thread.id);
            Some((
                last_activity(thread, &items),
                conversation(project, thread, &items),
            ))
        })
        .collect();
    // RFC3339 in UTC sorts by time; undated threads go last.
    all.sort_by(|a, b| b.0.cmp(&a.0));
    let running = all.iter().filter(|(_, c)| c["status"] == "running").count();
    let waiting = all
        .iter()
        .filter(|(_, c)| c["status"] == "needs_input")
        .count();
    let mut page: Vec<Value> = all
        .into_iter()
        .map(|(_, c)| c)
        .filter(|c| !needs_input || c["status"] == "needs_input")
        .skip(offset)
        .take(PAGE_SIZE + 1)
        .collect();
    let next = (page.len() > PAGE_SIZE).then(|| {
        page.pop();
        offset + PAGE_SIZE
    });
    Ok(json!({
        "conversations": page,
        "nextOffset": next,
        "counts": {"running": running, "needsInput": waiting},
    }))
}

pub fn detail(chat: &ProjectChat, allowed: &[String], thread_id: &str) -> Result<Value, String> {
    let (project, thread) = visible(chat, allowed, thread_id)?;
    let items = chat.items(&thread.id);
    let shown: Vec<usize> = items
        .iter()
        .enumerate()
        .filter(|(_, item)| {
            !matches!(
                item.kind,
                ItemKind::Thinking | ItemKind::Tool | ItemKind::ToolResult
            )
        })
        .map(|(index, _)| index)
        .collect();
    let start = shown.len().saturating_sub(MAX_MESSAGES);
    let messages: Vec<Value> = shown[start..]
        .iter()
        .filter_map(|&index| message(&items[index], &items[index + 1..]))
        .collect();
    Ok(json!({
        "conversation": conversation(&project, &thread, &items),
        "messages": messages,
        "truncated": start > 0,
    }))
}

/// The reply text the phone may send: plain, trimmed, bounded.
pub fn clean_reply(text: &str) -> Result<String, String> {
    let text = plain_text(text);
    let text = text.trim();
    if text.is_empty() {
        return Err("보낼 내용을 입력하세요.".into());
    }
    if text.chars().count() > MAX_REPLY_CHARS || text.len() > MAX_REPLY_BYTES {
        return Err("답장은 2,000자(6KB) 이하로 줄이세요.".into());
    }
    Ok(text.to_owned())
}

/// Starts one turn with `text` in the thread's current agent and mode, the way
/// the desktop composer does (without attachments, which the phone cannot add).
pub async fn reply(
    chat: Arc<ProjectChat>,
    project: Project,
    thread: Thread,
    text: String,
    path: Vec<PathBuf>,
) -> Result<Thread, String> {
    if thread.running || chat.is_running(&thread.id) {
        return Err(RUNNING.into());
    }
    let folder = {
        let (project, thread) = (project.clone(), thread.clone());
        tokio::task::spawn_blocking(move || project_chat::work_folder(&project, &thread))
            .await
            .map_err(|_| "작업 폴더를 확인하지 못했습니다.".to_owned())?
            .map_err(|error| safe_text(&error, 300))?
    };
    let turn = project_chat::Turn {
        shown: text.clone(),
        prompt: text,
        attachments: vec![],
    };
    project_chat::start_turn_with(chat, thread, folder, turn, path)
        .await
        .map_err(|error| safe_text(&error, 300))
}

// ---------------------------------------------------------------------------
// Sanitizing text for the phone

/// Plain text with absolute paths and credential-looking tokens replaced,
/// capped at `limit` characters. Relative names (`src/main.rs`) stay readable.
pub fn safe_text(text: &str, limit: usize) -> String {
    let plain = plain_text(text);
    if plain.contains("PRIVATE KEY") || plain.contains("-----BEGIN") {
        return format!("{HIDDEN_SECRET} 비밀값으로 보이는 내용이 있어 Mac에서만 볼 수 있습니다.");
    }
    let mut out = String::with_capacity(plain.len().min(limit * 4));
    for (index, line) in plain.split('\n').enumerate() {
        if index > 0 {
            out.push('\n');
        }
        for piece in line.split_inclusive(char::is_whitespace) {
            let body = piece.trim_end_matches(char::is_whitespace);
            out.push_str(&safe_token(body));
            out.push_str(&piece[body.len()..]);
        }
    }
    if out.chars().count() <= limit {
        return out;
    }
    let mut cut: String = out.chars().take(limit).collect();
    cut.push_str("…(잘림)");
    cut
}

const OPEN: &[char] = &['"', '\'', '(', '[', '<', '`', '{', '“', '‘', '「'];
const CLOSE: &[char] = &[
    '"', '\'', ')', ']', '>', '`', '}', ',', '.', ';', ':', '!', '?', '”', '’', '」',
];

fn safe_token(token: &str) -> String {
    let core = token.trim_start_matches(OPEN);
    let lead = &token[..token.len() - core.len()];
    let core_end = core.trim_end_matches(CLOSE);
    let trail = &core[core_end.len()..];
    let core = core_end;
    if core.is_empty() {
        return token.to_owned();
    }
    let replaced = if is_secret(core) {
        HIDDEN_SECRET.to_owned()
    } else if is_path(core) {
        HIDDEN_PATH.to_owned()
    } else if let Some(at) = core.find('?').filter(|_| core.contains("://")) {
        // URL query strings often carry tokens; keep the address only.
        format!("{}?…", &core[..at])
    } else {
        core.to_owned()
    };
    format!("{lead}{replaced}{trail}")
}

fn is_path(core: &str) -> bool {
    let value = core.rsplit_once('=').map_or(core, |(_, v)| v);
    let bytes = value.as_bytes();
    (value.starts_with('/') && value.len() > 1 && !value.starts_with("//"))
        || value.starts_with("~/")
        || value.starts_with("file:")
        || (bytes.len() > 2
            && bytes[0].is_ascii_alphabetic()
            && bytes[1] == b':'
            && (bytes[2] == b'\\' || bytes[2] == b'/'))
        || core.contains("/Users/")
        || core.contains("/home/")
        || core.contains("/private/")
        || core.contains("\\Users\\")
}

fn is_secret(core: &str) -> bool {
    let lower = core.to_ascii_lowercase();
    if let Some((key, value)) = lower.split_once(['=', ':']) {
        if !value.is_empty()
            && [
                "password", "passwd", "secret", "token", "api_key", "apikey", "auth",
            ]
            .iter()
            .any(|word| key.contains(word))
        {
            return true;
        }
    }
    let value = lower.rsplit(['=', ':']).next().unwrap_or(&lower);
    if [
        "sk-",
        "ghp_",
        "gho_",
        "ghs_",
        "ghu_",
        "github_pat_",
        "xoxb-",
        "xoxp-",
        "xoxa-",
        "glpat-",
        "akia",
        "aiza",
        "hf_",
        "npm_",
        "eyj",
    ]
    .iter()
    .any(|prefix| value.starts_with(prefix) && value.len() >= 12)
    {
        return true;
    }
    // Long opaque runs (keys, signed URLs, hashes) are not useful on a phone.
    let opaque = |c: char| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '+' | '/' | '=');
    core.len() >= 32
        && core.chars().all(opaque)
        && core.chars().any(|c| c.is_ascii_digit())
        && core.chars().any(|c| c.is_ascii_alphabetic())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::project_chat::{ChatAgent, ChatMode, LastRun};

    fn thread(running: bool, outcome: Option<RunOutcome>) -> Thread {
        Thread {
            id: "t-1".into(),
            project_id: "p-1".into(),
            title: "새 대화".into(),
            agent: ChatAgent::Claude,
            mode: ChatMode::Plan,
            provider_session: None,
            created_at: project_chat::now(),
            updated_at: project_chat::now(),
            running,
            preview_url: None,
            worktree: None,
            last_run: outcome.map(|outcome| LastRun {
                outcome,
                started_at: project_chat::now(),
                finished_at: project_chat::now(),
            }),
        }
    }

    #[test]
    fn status_rules_cover_running_input_done_failed_and_idle() {
        let said = Item::new(ItemKind::User, "로그인 화면 만들어줘");
        let answered = Item::new(ItemKind::Assistant, "만들었습니다.");
        let asked = Item::new(ItemKind::Assistant, "다크 모드도 넣을까요?");
        let mut plan = Item::new(ItemKind::PeerReply, "기획: 화면 3개");
        plan.peer_name = Some("Muse".into());
        assert_eq!(
            status(&thread(true, None), std::slice::from_ref(&said)),
            "running"
        );
        assert_eq!(status(&thread(false, None), &[]), "idle");
        assert_eq!(
            status(
                &thread(false, Some(RunOutcome::Done)),
                &[said.clone(), answered.clone()]
            ),
            "done"
        );
        assert_eq!(
            status(
                &thread(false, Some(RunOutcome::Done)),
                &[said.clone(), asked]
            ),
            "needs_input"
        );
        assert_eq!(
            status(
                &thread(false, Some(RunOutcome::Failed)),
                std::slice::from_ref(&said)
            ),
            "failed"
        );
        // A planner answered after the user's last message: the user decides next.
        assert_eq!(
            status(
                &thread(false, Some(RunOutcome::Done)),
                &[said, answered, plan]
            ),
            "needs_input"
        );
    }

    #[test]
    fn phone_text_hides_absolute_paths_and_credentials_but_keeps_prose() {
        let text = "파일 /Users/toris/projects/app/src/main.rs 와 ~/secret.txt, C:\\Users\\x 를 고쳤습니다.\n\
            src/main.rs 는 그대로. 키 sk-ant-api03-abcdefghijklmnop 와 TOKEN=abc123 그리고 \
            ghp_ABCDEFGHIJKLMNOPQRSTUVWX 및 https://example.com/cb?code=zzz 참고. (\"/private/var/log\")";
        let safe = safe_text(text, 2000);
        for leaked in [
            "/Users/", "~/secret", "C:\\", "sk-ant", "abc123", "ghp_", "code=zzz", "/private",
        ] {
            assert!(!safe.contains(leaked), "{leaked} in {safe}");
        }
        assert!(safe.contains("src/main.rs"));
        assert!(safe.contains("https://example.com/cb?…"));
        assert!(safe.contains("‹경로›"));
        assert!(safe.contains("‹비밀값 숨김›"));
        assert!(
            safe_text("-----BEGIN OPENSSH PRIVATE KEY-----\nabc", 100).starts_with(HIDDEN_SECRET)
        );
        let long = "가".repeat(3000);
        assert_eq!(
            safe_text(&long, 2000).chars().count(),
            2000 + "…(잘림)".chars().count()
        );
    }

    #[test]
    fn reply_text_is_bounded_for_the_request_line() {
        assert!(clean_reply("  \n ").is_err());
        assert_eq!(
            clean_reply(" 계속 진행해줘 \u{200b}").unwrap(),
            "계속 진행해줘"
        );
        assert!(clean_reply(&"가".repeat(2000)).is_ok());
        assert!(clean_reply(&"가".repeat(2001)).is_err());
        assert!(clean_reply(&"😀".repeat(1600)).is_err());
    }

    #[test]
    fn detail_keeps_conversation_and_planner_cards_and_drops_raw_work() {
        let dir = tempfile::tempdir().unwrap();
        let folder = dir.path().join("app");
        std::fs::create_dir_all(&folder).unwrap();
        let folder = std::fs::canonicalize(folder).unwrap();
        let chat = ProjectChat::new(dir.path().join("chat"));
        let project = chat.add_project(folder.to_str().unwrap()).unwrap();
        let hidden_project = {
            let other = dir.path().join("other");
            std::fs::create_dir_all(&other).unwrap();
            chat.add_project(std::fs::canonicalize(other).unwrap().to_str().unwrap())
                .unwrap()
        };
        let thread = chat
            .create_thread(&project.id, ChatAgent::Claude, ChatMode::Edit)
            .unwrap();
        let hidden = chat
            .create_thread(&hidden_project.id, ChatAgent::Codex, ChatMode::Plan)
            .unwrap();
        let mut hosted = Item::new(ItemKind::HostedRequest, "랜딩 기획해줘");
        hosted.peer_name = Some("Grok Bot".into());
        hosted.code = Some("TS-ABCDEF1234".into());
        hosted.prompt = Some(format!("{}/README.md 내용", folder.display()));
        let mut tool = Item::new(ItemKind::ToolResult, "cat /Users/toris/.env");
        tool.tool = Some("Bash".into());
        let mut error = Item::new(ItemKind::Error, "Claude Code 오류:\n/Users/toris/x panic");
        error.is_error = true;
        let mut plan = Item::new(ItemKind::PeerReply, "[TS-ABCDEF1234] 화면 3개");
        plan.peer = Some("reason:agent/muse-123".into());
        plan.peer_name = Some("muse (hosted)".into());
        chat.append(
            &thread.id,
            &[
                Item::new(ItemKind::User, "시작"),
                Item::new(ItemKind::Thinking, "생각 중"),
                tool,
                error,
                hosted,
                plan,
            ],
        )
        .unwrap();
        let allowed = vec![project.id.clone()];
        let value = detail(&chat, &allowed, &thread.id).unwrap();
        let text = value.to_string();
        for leaked in [
            "/Users",
            "TS-ABCDEF1234\"",
            "README",
            "생각 중",
            ".env",
            "panic",
            "reason:agent",
        ] {
            assert!(!text.contains(leaked), "{leaked} in {text}");
        }
        let kinds: Vec<&str> = value["messages"]
            .as_array()
            .unwrap()
            .iter()
            .map(|m| m["kind"].as_str().unwrap())
            .collect();
        assert_eq!(kinds, ["user", "error", "hosted_request", "planner_reply"]);
        assert_eq!(value["messages"][2]["planner"], "Grok Bot");
        assert_eq!(value["messages"][2]["answered"], true);
        assert_eq!(value["messages"][3]["planner"], "Muse");
        assert_eq!(value["conversation"]["status"], "needs_input");
        assert_eq!(value["conversation"]["mode"], "edit");
        assert_eq!(
            detail(&chat, &allowed, &hidden.id).unwrap_err(),
            NOT_VISIBLE
        );
        assert_eq!(detail(&chat, &allowed, "missing").unwrap_err(), NOT_VISIBLE);
        let page = list(&chat, &allowed, 0, false).unwrap();
        assert_eq!(page["conversations"].as_array().unwrap().len(), 1);
        assert_eq!(page["counts"]["needsInput"], 1);
        assert_eq!(
            list(&chat, &allowed, 0, true).unwrap()["conversations"][0]["threadId"],
            thread.id
        );
        assert!(list(&chat, &[], 0, false).unwrap()["conversations"]
            .as_array()
            .unwrap()
            .is_empty());
    }
}
