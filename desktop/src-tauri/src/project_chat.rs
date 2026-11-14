//! Orca-style project chat: add an app folder, open threads in it and talk to
//! Claude Code or Codex there, one turn at a time, with their streamed output
//! shown as chat items. Planners on Reason Network (Muse, OpenAI Dots) can be
//! asked from the same thread; their replies land in it.
//!
//! A folder becomes a project only through the same checks the Reason agents
//! use, and the native layer asks for an OS confirmation before it is added.
//! Each turn is one CLI process in its own process group, started with the
//! text the user typed on stdin. Claude runs with `acceptEdits` (or `plan`) and
//! Codex in its `workspace-write` (or `read-only`) sandbox; neither is ever
//! given full access. Agent output is untrusted data: it is normalized into
//! capped text items, stored and shown, never executed or interpreted.
use crate::reason_network::Message;
use crate::reason_pipeline::{plain_text, same_sender};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
#[cfg(unix)]
use std::process::Stdio;
use std::{
    collections::HashMap,
    fs,
    io::Write,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};
#[cfg(unix)]
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};

pub const MAX_PROJECTS: usize = 50;
pub const MAX_THREADS: usize = 200;
pub const MAX_PROMPT_BYTES: usize = 32 * 1024;
pub const MAX_ITEMS: usize = 2_000;
pub const MAX_RUNNING: usize = 4;
const MAX_ITEM_BYTES: usize = 16 * 1024;
const MAX_TOOL_OUTPUT_BYTES: usize = 4 * 1024;
const MAX_SUMMARY_BYTES: usize = 600;
const MAX_TITLE_CHARS: usize = 60;
const MAX_DIFF_BYTES: usize = 400 * 1024;
pub const CLAUDE_MODEL: &str = "claude-opus-5-5";
pub const CLAUDE_EFFORT: &str = "medium";
const TRUNCATED: &str = "…(잘림)";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ChatAgent {
    Claude,
    Codex,
}

/// `Plan` reads and answers only; `Edit` may change files in the project.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ChatMode {
    Plan,
    Edit,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: String,
    pub name: String,
    pub folder: String,
    pub added_at: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Thread {
    pub id: String,
    pub project_id: String,
    pub title: String,
    pub agent: ChatAgent,
    pub mode: ChatMode,
    /// The CLI's own conversation ID, so the next turn resumes it.
    #[serde(default)]
    pub provider_session: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    #[serde(default)]
    pub running: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ItemKind {
    User,
    Assistant,
    Thinking,
    Tool,
    ToolResult,
    Notice,
    Error,
    Result,
    PeerRequest,
    PeerReply,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Item {
    pub id: String,
    pub kind: ItemKind,
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_id: Option<String>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub is_error: bool,
    /// Reason Network address of the planner asked or answering.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub peer: Option<String>,
    /// Network message ID: the request sent, or the reply received.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message_id: Option<String>,
    pub at: String,
}

impl Item {
    pub fn new(kind: ItemKind, text: impl Into<String>) -> Self {
        Self {
            id: uuid::Uuid::new_v4().to_string(),
            kind,
            text: text.into(),
            tool: None,
            tool_id: None,
            is_error: false,
            peer: None,
            message_id: None,
            at: now(),
        }
    }
    fn tool(mut self, name: &str, id: Option<&str>) -> Self {
        self.tool = Some(cut(name, 80));
        self.tool_id = id.map(|id| cut(id, 120));
        self
    }
    fn error(mut self, is_error: bool) -> Self {
        self.is_error = is_error;
        self
    }
}

#[derive(Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Store {
    #[serde(default)]
    projects: Vec<Project>,
    #[serde(default)]
    threads: Vec<Thread>,
}

pub fn now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

/// Caps text at a char boundary and strips characters a reader cannot see.
pub fn cut(text: &str, limit: usize) -> String {
    let text = plain_text(text);
    if text.len() <= limit {
        return text;
    }
    let mut end = limit;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}{TRUNCATED}", &text[..end])
}

fn valid_id(id: &str) -> Result<(), String> {
    (id.len() <= 64 && !id.is_empty() && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-'))
        .then_some(())
        .ok_or_else(|| "잘못된 ID입니다.".into())
}

/// A thread title from its first message: one line, at most 60 characters.
pub fn title_from(prompt: &str) -> String {
    let line = plain_text(prompt)
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .unwrap_or("새 대화")
        .to_string();
    let mut title: String = line.chars().take(MAX_TITLE_CHARS).collect();
    if line.chars().count() > MAX_TITLE_CHARS {
        title.push('…');
    }
    title
}

// ---------------------------------------------------------------------------
// Normalizing CLI output

fn s<'a>(value: &'a Value, key: &str) -> &'a str {
    value.get(key).and_then(Value::as_str).unwrap_or("")
}

fn relative(folder: &str, path: &str) -> String {
    path.strip_prefix(folder)
        .map(|rest| rest.trim_start_matches('/'))
        .filter(|rest| !rest.is_empty())
        .unwrap_or(path)
        .to_string()
}

/// One line describing what a tool call does, for the collapsed row.
pub fn tool_summary(name: &str, input: &Value, folder: &str) -> String {
    let pick = |keys: &[&str]| {
        keys.iter()
            .map(|key| s(input, key))
            .find(|value| !value.is_empty())
            .map(str::to_owned)
    };
    let text = match name {
        "Bash" => pick(&["command"]),
        "Read" | "Write" | "Edit" | "MultiEdit" | "NotebookEdit" => {
            pick(&["file_path", "notebook_path"]).map(|path| relative(folder, &path))
        }
        "Grep" | "Glob" => pick(&["pattern"]),
        "Task" | "Agent" => pick(&["description", "prompt"]),
        "WebFetch" => pick(&["url"]),
        "WebSearch" => pick(&["query"]),
        "TodoWrite" => input.get("todos").and_then(Value::as_array).map(|todos| {
            todos
                .iter()
                .map(|todo| {
                    let mark = match s(todo, "status") {
                        "completed" => "[x]",
                        "in_progress" => "[~]",
                        _ => "[ ]",
                    };
                    format!("{mark} {}", s(todo, "content"))
                })
                .collect::<Vec<_>>()
                .join("\n")
        }),
        _ => None,
    };
    cut(
        &text.unwrap_or_else(|| {
            if input.is_null() || input.as_object().is_some_and(|map| map.is_empty()) {
                String::new()
            } else {
                input.to_string()
            }
        }),
        MAX_SUMMARY_BYTES,
    )
}

fn tool_result_text(content: &Value) -> String {
    match content {
        Value::String(text) => text.clone(),
        Value::Array(parts) => parts
            .iter()
            .filter_map(|part| part.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

/// What one CLI output line means for the chat.
#[derive(Debug, Default, PartialEq)]
pub struct Normalized {
    pub items: Vec<Item>,
    pub session: Option<String>,
}

/// One `claude -p --output-format stream-json --verbose` line.
pub fn normalize_claude(line: &Value, folder: &str) -> Normalized {
    let mut out = Normalized::default();
    match s(line, "type") {
        "system" => match s(line, "subtype") {
            "init" => {
                out.session = Some(s(line, "session_id").to_owned()).filter(|id| !id.is_empty());
            }
            "permission_denied" => out.items.push(
                Item::new(
                    ItemKind::Notice,
                    format!(
                        "{} 실행이 거부되었습니다: {}",
                        s(line, "tool_name"),
                        s(line, "message")
                    ),
                )
                .error(true),
            ),
            _ => {}
        },
        "assistant" => {
            let parts = line
                .pointer("/message/content")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            for part in &parts {
                match s(part, "type") {
                    "text" if !s(part, "text").trim().is_empty() => out.items.push(Item::new(
                        ItemKind::Assistant,
                        cut(s(part, "text"), MAX_ITEM_BYTES),
                    )),
                    "thinking" if !s(part, "thinking").trim().is_empty() => out.items.push(
                        Item::new(ItemKind::Thinking, cut(s(part, "thinking"), MAX_ITEM_BYTES)),
                    ),
                    "tool_use" => {
                        let name = s(part, "name");
                        let input = part.get("input").cloned().unwrap_or(Value::Null);
                        out.items.push(
                            Item::new(ItemKind::Tool, tool_summary(name, &input, folder))
                                .tool(name, Some(s(part, "id"))),
                        );
                    }
                    _ => {}
                }
            }
        }
        "user" => {
            let parts = line
                .pointer("/message/content")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            for part in parts.iter().filter(|p| s(p, "type") == "tool_result") {
                let text = tool_result_text(part.get("content").unwrap_or(&Value::Null));
                let mut item = Item::new(ItemKind::ToolResult, cut(&text, MAX_TOOL_OUTPUT_BYTES))
                    .error(part.get("is_error").and_then(Value::as_bool) == Some(true));
                item.tool_id = Some(cut(s(part, "tool_use_id"), 120)).filter(|id| !id.is_empty());
                out.items.push(item);
            }
        }
        "result" => {
            let failed = line.get("is_error").and_then(Value::as_bool) == Some(true)
                || s(line, "subtype").starts_with("error");
            let seconds = line
                .get("duration_ms")
                .and_then(Value::as_f64)
                .map(|ms| format!("{:.0}초", ms / 1000.0));
            let cost = line
                .get("total_cost_usd")
                .and_then(Value::as_f64)
                .map(|usd| format!("${usd:.2}"));
            if failed {
                let reason = Some(s(line, "result"))
                    .filter(|text| !text.is_empty())
                    .unwrap_or(s(line, "subtype"));
                out.items.push(
                    Item::new(
                        ItemKind::Error,
                        cut(&format!("실패: {reason}"), MAX_ITEM_BYTES),
                    )
                    .error(true),
                );
            } else {
                let parts: Vec<String> = ["완료".to_string()]
                    .into_iter()
                    .chain(seconds)
                    .chain(cost)
                    .collect();
                out.items
                    .push(Item::new(ItemKind::Result, parts.join(" · ")));
            }
            if out.session.is_none() {
                out.session = Some(s(line, "session_id").to_owned()).filter(|id| !id.is_empty());
            }
        }
        _ => {}
    }
    out
}

/// One `codex exec --json` line.
pub fn normalize_codex(line: &Value, folder: &str) -> Normalized {
    let mut out = Normalized::default();
    let item = line.get("item").cloned().unwrap_or(Value::Null);
    let id = s(&item, "id");
    match (s(line, "type"), s(&item, "type")) {
        ("thread.started", _) => {
            out.session = Some(s(line, "thread_id").to_owned()).filter(|id| !id.is_empty());
        }
        ("item.started", "command_execution") => out.items.push(
            Item::new(ItemKind::Tool, cut(s(&item, "command"), MAX_SUMMARY_BYTES))
                .tool("Bash", Some(id)),
        ),
        ("item.completed", "command_execution") => {
            let code = item.get("exit_code").and_then(Value::as_i64);
            let mut text = s(&item, "aggregated_output").trim_end().to_owned();
            if let Some(code) = code.filter(|code| *code != 0) {
                text.push_str(&format!("\n(종료 코드 {code})"));
            }
            let mut result = Item::new(
                ItemKind::ToolResult,
                cut(text.trim(), MAX_TOOL_OUTPUT_BYTES),
            )
            .error(code.is_some_and(|code| code != 0));
            result.tool_id = Some(cut(id, 120)).filter(|id| !id.is_empty());
            out.items.push(result);
        }
        ("item.completed", "agent_message") if !s(&item, "text").trim().is_empty() => {
            out.items.push(Item::new(
                ItemKind::Assistant,
                cut(s(&item, "text"), MAX_ITEM_BYTES),
            ))
        }
        ("item.completed", "reasoning") if !s(&item, "text").trim().is_empty() => out.items.push(
            Item::new(ItemKind::Thinking, cut(s(&item, "text"), MAX_ITEM_BYTES)),
        ),
        ("item.completed", "file_change") => {
            let changes = item
                .get("changes")
                .and_then(Value::as_array)
                .map(|changes| {
                    changes
                        .iter()
                        .map(|change| {
                            format!(
                                "{} {}",
                                s(change, "kind"),
                                relative(folder, s(change, "path"))
                            )
                        })
                        .collect::<Vec<_>>()
                        .join("\n")
                })
                .unwrap_or_default();
            out.items.push(
                Item::new(ItemKind::Tool, cut(&changes, MAX_SUMMARY_BYTES)).tool("Edit", Some(id)),
            );
        }
        ("item.completed", "mcp_tool_call") => out.items.push(
            Item::new(
                ItemKind::Tool,
                cut(
                    &format!("{}.{}", s(&item, "server"), s(&item, "tool")),
                    MAX_SUMMARY_BYTES,
                ),
            )
            .tool("MCP", Some(id)),
        ),
        ("item.completed", "web_search") => out.items.push(
            Item::new(ItemKind::Tool, cut(s(&item, "query"), MAX_SUMMARY_BYTES))
                .tool("WebSearch", Some(id)),
        ),
        ("item.completed", "todo_list") => {
            let todos = item
                .get("items")
                .and_then(Value::as_array)
                .map(|todos| {
                    todos
                        .iter()
                        .map(|todo| {
                            let done = todo.get("completed").and_then(Value::as_bool) == Some(true);
                            format!("{} {}", if done { "[x]" } else { "[ ]" }, s(todo, "text"))
                        })
                        .collect::<Vec<_>>()
                        .join("\n")
                })
                .unwrap_or_default();
            out.items.push(
                Item::new(ItemKind::Tool, cut(&todos, MAX_SUMMARY_BYTES))
                    .tool("TodoWrite", Some(id)),
            );
        }
        ("turn.completed", _) => {
            let tokens = line
                .pointer("/usage/output_tokens")
                .and_then(Value::as_i64)
                .map(|n| format!(" · 출력 {n} 토큰"))
                .unwrap_or_default();
            out.items
                .push(Item::new(ItemKind::Result, format!("완료{tokens}")));
        }
        ("turn.failed", _) | ("error", _) => {
            let message = line
                .pointer("/error/message")
                .and_then(Value::as_str)
                .unwrap_or(s(line, "message"));
            out.items.push(
                Item::new(
                    ItemKind::Error,
                    cut(&format!("실패: {message}"), MAX_ITEM_BYTES),
                )
                .error(true),
            );
        }
        _ => {}
    }
    out
}

// ---------------------------------------------------------------------------
// Turn commands

/// Program, arguments and extra environment for one turn. The prompt is
/// written to stdin, never placed on the command line.
#[derive(Debug, PartialEq)]
pub struct TurnCommand {
    pub program: &'static str,
    pub args: Vec<String>,
    pub env: Vec<(&'static str, String)>,
}

pub fn turn_command(thread: &Thread) -> TurnCommand {
    let resume = thread.provider_session.clone();
    match thread.agent {
        ChatAgent::Claude => {
            let mut args: Vec<String> = [
                "-p",
                "--output-format",
                "stream-json",
                "--verbose",
                "--input-format",
                "text",
                "--model",
                CLAUDE_MODEL,
                "--permission-mode",
                match thread.mode {
                    ChatMode::Plan => "plan",
                    ChatMode::Edit => "acceptEdits",
                },
            ]
            .map(str::to_owned)
            .to_vec();
            if let Some(id) = resume {
                args.extend(["--resume".to_owned(), id]);
            }
            TurnCommand {
                program: "claude",
                args,
                env: vec![
                    ("ANTHROPIC_MODEL", CLAUDE_MODEL.to_owned()),
                    ("CLAUDE_CODE_EFFORT_LEVEL", CLAUDE_EFFORT.to_owned()),
                ],
            }
        }
        ChatAgent::Codex => {
            let sandbox = match thread.mode {
                ChatMode::Plan => "sandbox_mode=\"read-only\"",
                ChatMode::Edit => "sandbox_mode=\"workspace-write\"",
            };
            let mut args: Vec<String> = vec!["exec".into()];
            if resume.is_some() {
                args.push("resume".into());
            }
            args.extend(
                [
                    "--json",
                    "--skip-git-repo-check",
                    "-c",
                    sandbox,
                    "-c",
                    "approval_policy=\"never\"",
                ]
                .map(str::to_owned),
            );
            if let Some(id) = resume {
                args.push(id);
            }
            args.push("-".into());
            TurnCommand {
                program: "codex",
                args,
                env: vec![],
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Storage

pub type Emit = Arc<dyn Fn(Value) + Send + Sync>;

pub struct ProjectChat {
    root: PathBuf,
    store: Mutex<()>,
    running: Mutex<HashMap<String, u32>>,
    stopping: Mutex<std::collections::HashSet<String>>,
    pub emit: Mutex<Option<Emit>>,
}

impl ProjectChat {
    pub fn new(root: PathBuf) -> Self {
        Self {
            root,
            store: Mutex::new(()),
            running: Mutex::default(),
            stopping: Mutex::default(),
            emit: Mutex::new(None),
        }
    }

    pub fn default_root() -> PathBuf {
        crate::config::config_path()
            .parent()
            .map(Path::to_path_buf)
            .unwrap_or_else(|| PathBuf::from("."))
            .join("project-chat")
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, ()> {
        self.store.lock().unwrap_or_else(|p| p.into_inner())
    }

    fn read(&self) -> Store {
        fs::read(self.root.join("projects.json"))
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default()
    }

    fn write(&self, store: &Store) -> Result<(), String> {
        fs::create_dir_all(&self.root).map_err(|_| "대화 저장 폴더를 만들지 못했습니다.")?;
        let path = self.root.join("projects.json");
        let tmp = self.root.join("projects.json.tmp");
        let bytes = serde_json::to_vec_pretty(store).map_err(|e| e.to_string())?;
        fs::write(&tmp, bytes)
            .and_then(|_| fs::rename(&tmp, &path))
            .map_err(|_| "프로젝트 목록을 저장하지 못했습니다.".into())
    }

    fn items_path(&self, thread: &str) -> PathBuf {
        self.root.join("threads").join(format!("{thread}.jsonl"))
    }

    pub fn is_running(&self, thread: &str) -> bool {
        self.running
            .lock()
            .map(|r| r.contains_key(thread))
            .unwrap_or(false)
    }

    fn with_running(&self, mut thread: Thread) -> Thread {
        thread.running = self.is_running(&thread.id);
        thread
    }

    pub fn projects(&self) -> (Vec<Project>, Vec<Thread>) {
        let _guard = self.lock();
        let store = self.read();
        let threads = store
            .threads
            .into_iter()
            .map(|t| self.with_running(t))
            .collect();
        (store.projects, threads)
    }

    pub fn project(&self, id: &str) -> Result<Project, String> {
        valid_id(id)?;
        let _guard = self.lock();
        self.read()
            .projects
            .into_iter()
            .find(|p| p.id == id)
            .ok_or_else(|| "프로젝트를 찾지 못했습니다.".into())
    }

    /// `folder` must already have passed `reason_agents::checked_folder`.
    pub fn add_project(&self, folder: &str) -> Result<Project, String> {
        let _guard = self.lock();
        let mut store = self.read();
        if let Some(existing) = store.projects.iter().find(|p| p.folder == folder) {
            return Ok(existing.clone());
        }
        if store.projects.len() >= MAX_PROJECTS {
            return Err(format!(
                "프로젝트는 {MAX_PROJECTS}개까지 추가할 수 있습니다."
            ));
        }
        let project = Project {
            id: uuid::Uuid::new_v4().to_string(),
            name: Path::new(folder)
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("project")
                .to_string(),
            folder: folder.to_string(),
            added_at: now(),
        };
        store.projects.push(project.clone());
        self.write(&store)?;
        Ok(project)
    }

    /// Forgets the project and its threads. The folder itself is untouched.
    pub fn remove_project(&self, id: &str) -> Result<(), String> {
        valid_id(id)?;
        let _guard = self.lock();
        let mut store = self.read();
        if store
            .threads
            .iter()
            .any(|t| t.project_id == id && self.is_running(&t.id))
        {
            return Err("실행 중인 대화를 먼저 중지하세요.".into());
        }
        let removed: Vec<String> = store
            .threads
            .iter()
            .filter(|t| t.project_id == id)
            .map(|t| t.id.clone())
            .collect();
        store.projects.retain(|p| p.id != id);
        store.threads.retain(|t| t.project_id != id);
        self.write(&store)?;
        for thread in removed {
            let _ = fs::remove_file(self.items_path(&thread));
        }
        Ok(())
    }

    pub fn create_thread(
        &self,
        project_id: &str,
        agent: ChatAgent,
        mode: ChatMode,
    ) -> Result<Thread, String> {
        valid_id(project_id)?;
        let _guard = self.lock();
        let mut store = self.read();
        if !store.projects.iter().any(|p| p.id == project_id) {
            return Err("프로젝트를 찾지 못했습니다.".into());
        }
        if store.threads.len() >= MAX_THREADS {
            return Err(format!(
                "대화는 {MAX_THREADS}개까지 저장됩니다. 오래된 대화를 지우세요."
            ));
        }
        let at = now();
        let thread = Thread {
            id: uuid::Uuid::new_v4().to_string(),
            project_id: project_id.to_string(),
            title: "새 대화".into(),
            agent,
            mode,
            provider_session: None,
            created_at: at.clone(),
            updated_at: at,
            running: false,
        };
        store.threads.push(thread.clone());
        self.write(&store)?;
        Ok(thread)
    }

    pub fn thread(&self, id: &str) -> Result<Thread, String> {
        valid_id(id)?;
        let _guard = self.lock();
        self.read()
            .threads
            .into_iter()
            .find(|t| t.id == id)
            .map(|t| self.with_running(t))
            .ok_or_else(|| "대화를 찾지 못했습니다.".into())
    }

    pub fn update_thread(
        &self,
        id: &str,
        change: impl FnOnce(&mut Thread) -> Result<(), String>,
    ) -> Result<Thread, String> {
        valid_id(id)?;
        let _guard = self.lock();
        let mut store = self.read();
        let thread = store
            .threads
            .iter_mut()
            .find(|t| t.id == id)
            .ok_or("대화를 찾지 못했습니다.")?;
        change(thread)?;
        thread.updated_at = now();
        let updated = thread.clone();
        self.write(&store)?;
        Ok(self.with_running(updated))
    }

    pub fn delete_thread(&self, id: &str) -> Result<(), String> {
        valid_id(id)?;
        if self.is_running(id) {
            return Err("실행 중인 대화는 지울 수 없습니다. 먼저 중지하세요.".into());
        }
        let _guard = self.lock();
        let mut store = self.read();
        store.threads.retain(|t| t.id != id);
        self.write(&store)?;
        let _ = fs::remove_file(self.items_path(id));
        Ok(())
    }

    pub fn items(&self, thread: &str) -> Vec<Item> {
        if valid_id(thread).is_err() {
            return vec![];
        }
        let text = fs::read_to_string(self.items_path(thread)).unwrap_or_default();
        let items: Vec<Item> = text
            .lines()
            .filter_map(|line| serde_json::from_str(line).ok())
            .collect();
        let skip = items.len().saturating_sub(MAX_ITEMS);
        items.into_iter().skip(skip).collect()
    }

    /// Stores items and tells the window about them.
    pub fn append(&self, thread: &str, items: &[Item]) -> Result<(), String> {
        if items.is_empty() {
            return Ok(());
        }
        valid_id(thread)?;
        let path = self.items_path(thread);
        fs::create_dir_all(path.parent().expect("threads dir"))
            .map_err(|_| "대화 기록 폴더를 만들지 못했습니다.")?;
        let mut file = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
            .map_err(|_| "대화 기록을 저장하지 못했습니다.")?;
        for item in items {
            let line = serde_json::to_string(item).map_err(|e| e.to_string())?;
            writeln!(file, "{line}").map_err(|_| "대화 기록을 저장하지 못했습니다.")?;
        }
        self.notify(json!({"threadId": thread, "kind": "items", "items": items}));
        Ok(())
    }

    pub fn notify(&self, event: Value) {
        let emit = self.emit.lock().ok().and_then(|e| e.clone());
        if let Some(emit) = emit {
            emit(event);
        }
    }

    /// Marks a thread busy. Fails if it already runs or too many turns run.
    pub fn claim(&self, thread: &str, pid: u32) -> Result<(), String> {
        let mut running = self.running.lock().map_err(|_| "상태 오류")?;
        if running.contains_key(thread) {
            return Err("이 대화는 이미 답하는 중입니다. 끝나거나 중지한 뒤 보내세요.".into());
        }
        if running.len() >= MAX_RUNNING {
            return Err(format!(
                "동시에 {MAX_RUNNING}개 대화까지 실행할 수 있습니다. 다른 대화를 먼저 끝내세요."
            ));
        }
        running.insert(thread.to_string(), pid);
        Ok(())
    }

    pub fn release(&self, thread: &str) {
        if let Ok(mut running) = self.running.lock() {
            running.remove(thread);
        }
        self.notify(json!({"threadId": thread, "kind": "state", "running": false}));
    }

    pub fn running_pid(&self, thread: &str) -> Option<u32> {
        self.running.lock().ok()?.get(thread).copied()
    }

    /// `mark`: records a stop request. Otherwise takes (clears) it and says whether it was set.
    pub fn stopped(&self, thread: &str, mark: bool) -> bool {
        let mut stopping = self.stopping.lock().unwrap_or_else(|p| p.into_inner());
        if mark {
            stopping.insert(thread.to_string())
        } else {
            stopping.remove(thread)
        }
    }

    /// Ends every running turn's process group (Studio is exiting).
    pub fn shutdown(&self) {
        #[cfg(unix)]
        for pid in self.running_pids() {
            signal(pid, libc::SIGTERM);
        }
    }

    pub fn running_pids(&self) -> Vec<u32> {
        self.running
            .lock()
            .map(|r| r.values().copied().collect())
            .unwrap_or_default()
    }

    /// Adds replies addressed to this thread's planner requests that it does not hold yet.
    pub fn sync_replies(&self, thread: &str, messages: &[Message]) -> Result<Vec<Item>, String> {
        let items = self.items(thread);
        let requests: Vec<(&str, &str)> = items
            .iter()
            .filter(|i| i.kind == ItemKind::PeerRequest)
            .filter_map(|i| Some((i.message_id.as_deref()?, i.peer.as_deref()?)))
            .collect();
        let known: Vec<&str> = items
            .iter()
            .filter(|i| i.kind == ItemKind::PeerReply)
            .filter_map(|i| i.message_id.as_deref())
            .collect();
        let fresh: Vec<Item> = messages
            .iter()
            .filter(|m| !known.contains(&m.id.as_str()))
            .filter(|m| {
                requests.iter().any(|(sent, peer)| {
                    m.reply_to.as_deref() == Some(*sent) && same_sender(&m.from, peer)
                })
            })
            .map(|m| {
                let mut item = Item::new(ItemKind::PeerReply, cut(&m.text, MAX_ITEM_BYTES));
                item.peer = Some(m.from_name.clone().unwrap_or_else(|| m.from.clone()));
                item.message_id = Some(m.id.clone());
                item
            })
            .collect();
        self.append(thread, &fresh)?;
        Ok(fresh)
    }
}

// ---------------------------------------------------------------------------
// Running turns

#[cfg(unix)]
const STDERR_TAIL: usize = 2 * 1024;

pub fn find_cli(program: &str, path: &[PathBuf]) -> Option<PathBuf> {
    path.iter()
        .map(|dir| dir.join(program))
        .find(|candidate| candidate.is_file())
}

/// Starts one turn: the CLI runs in `folder` in its own process group with the
/// prompt on stdin; its output becomes items as it streams. Returns at once.
#[cfg(unix)]
pub async fn start_turn(
    chat: Arc<ProjectChat>,
    thread: Thread,
    folder: String,
    prompt: String,
    path: Vec<PathBuf>,
) -> Result<Thread, String> {
    let spec = turn_command(&thread);
    let label = match thread.agent {
        ChatAgent::Claude => "Claude Code",
        ChatAgent::Codex => "Codex",
    };
    let cli = find_cli(spec.program, &path)
        .ok_or_else(|| format!("{label} CLI를 찾지 못했습니다. 설치한 뒤 다시 시도하세요."))?;
    let mut command = tokio::process::Command::new(cli);
    command
        .args(&spec.args)
        .current_dir(&folder)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .process_group(0);
    for key in crate::reason_network::AGENT_ENV {
        command.env_remove(key);
    }
    if let Ok(joined) = std::env::join_paths(&path) {
        command.env("PATH", joined);
    }
    command.env("NO_COLOR", "1");
    for (key, value) in &spec.env {
        command.env(key, value);
    }
    let mut child = command
        .spawn()
        .map_err(|_| format!("{label}을(를) 시작하지 못했습니다."))?;
    let pid = child.id().unwrap_or(0);
    if let Err(error) = chat.claim(&thread.id, pid) {
        let _ = child.start_kill();
        return Err(error);
    }
    chat.stopped(&thread.id, false);
    let first = chat.items(&thread.id).is_empty();
    let updated = chat.update_thread(&thread.id, |t| {
        if first || t.title == "새 대화" {
            t.title = title_from(&prompt);
        }
        Ok(())
    })?;
    let _ = chat.append(&thread.id, &[Item::new(ItemKind::User, prompt.clone())]);
    chat.notify(
        json!({"threadId": thread.id, "kind": "state", "running": true, "thread": updated}),
    );

    let mut stdin = child.stdin.take();
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let id = thread.id.clone();
    let agent = thread.agent;
    let worker = chat.clone();
    tokio::spawn(async move {
        let chat = worker;
        if let Some(mut stdin) = stdin.take() {
            let _ = stdin.write_all(prompt.as_bytes()).await;
            let _ = stdin.shutdown().await;
        }
        let tail = tokio::spawn(async move {
            let mut buf = Vec::new();
            if let Some(mut err) = stderr {
                let _ = err.read_to_end(&mut buf).await;
            }
            let text = String::from_utf8_lossy(&buf).into_owned();
            let start = text.len().saturating_sub(STDERR_TAIL);
            let start = (start..=text.len())
                .find(|i| text.is_char_boundary(*i))
                .unwrap_or(0);
            text[start..].to_owned()
        });
        let mut finished = false;
        if let Some(stdout) = stdout {
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let Ok(value) = serde_json::from_str::<Value>(&line) else {
                    continue;
                };
                let Normalized { items, session } = match agent {
                    ChatAgent::Claude => normalize_claude(&value, &folder),
                    ChatAgent::Codex => normalize_codex(&value, &folder),
                };
                if let Some(session) = session {
                    let _ = chat.update_thread(&id, |t| {
                        t.provider_session = Some(cut(&session, 200));
                        Ok(())
                    });
                }
                finished |= items
                    .iter()
                    .any(|i| matches!(i.kind, ItemKind::Result | ItemKind::Error));
                let _ = chat.append(&id, &items);
            }
        }
        let status = child.wait().await.ok();
        let err = tail.await.unwrap_or_default();
        let was_stopped = chat.stopped(&id, false);
        if was_stopped {
            let _ = chat.append(
                &id,
                &[Item::new(ItemKind::Notice, "사용자가 중지했습니다.")],
            );
        } else if !finished {
            let _ = status;
            let reason = if err.trim().is_empty() {
                format!("{label}이(가) 응답 없이 종료되었습니다.")
            } else {
                format!("{label} 오류:\n{}", err.trim())
            };
            let mut item = Item::new(ItemKind::Error, cut(&reason, 4096));
            item.is_error = true;
            let _ = chat.append(&id, &[item]);
        }
        chat.release(&id);
    });
    Ok(chat.thread(&thread.id).unwrap_or(updated))
}

#[cfg(not(unix))]
pub async fn start_turn(
    _chat: Arc<ProjectChat>,
    _thread: Thread,
    _folder: String,
    _prompt: String,
    _path: Vec<PathBuf>,
) -> Result<Thread, String> {
    Err("이 운영체제에서는 프로젝트 채팅을 실행할 수 없습니다.".into())
}

#[cfg(unix)]
fn signal(pid: u32, signal: libc::c_int) {
    if pid > 1 {
        // Each turn leads its own process group, so its PID is the group ID.
        unsafe { libc::kill(-(pid as libc::pid_t), signal) };
    }
}

/// Asks a running turn to stop: TERM to its group, KILL after three seconds.
pub fn stop_turn(chat: Arc<ProjectChat>, thread: &str) {
    let Some(pid) = chat.running_pid(thread) else {
        return;
    };
    chat.stopped(thread, true);
    #[cfg(unix)]
    {
        signal(pid, libc::SIGTERM);
        let id = thread.to_string();
        tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_secs(3)).await;
            if chat.running_pid(&id) == Some(pid) {
                signal(pid, libc::SIGKILL);
            }
        });
    }
    #[cfg(not(unix))]
    let _ = pid;
}

// ---------------------------------------------------------------------------
// Git review

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Changes {
    pub is_repo: bool,
    pub branch: Option<String>,
    /// `git status --porcelain` lines: two status letters, a space, the path.
    pub files: Vec<String>,
    pub diff: String,
    pub truncated: bool,
}

fn git(folder: &str, args: &[&str]) -> Option<String> {
    let output = std::process::Command::new("git")
        .args(["-c", "core.quotepath=off", "--no-optional-locks"])
        .args(args)
        .current_dir(folder)
        .env("GIT_PAGER", "cat")
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdin(std::process::Stdio::null())
        .output()
        .ok()?;
    output
        .status
        .success()
        .then(|| String::from_utf8_lossy(&output.stdout).into_owned())
}

/// Working-tree changes against HEAD, read-only. Untracked files are listed, not diffed.
pub fn changes(folder: &str) -> Changes {
    let Some(status) = git(
        folder,
        &["status", "--porcelain=v1", "--untracked-files=all"],
    ) else {
        return Changes {
            is_repo: false,
            branch: None,
            files: vec![],
            diff: String::new(),
            truncated: false,
        };
    };
    let diff = git(folder, &["diff", "HEAD", "--no-color", "--no-ext-diff"])
        .or_else(|| git(folder, &["diff", "--no-color", "--no-ext-diff"]))
        .unwrap_or_default();
    let truncated = diff.len() > MAX_DIFF_BYTES;
    Changes {
        is_repo: true,
        branch: crate::reason_agents::current_branch(Path::new(folder)),
        files: status.lines().take(500).map(|l| plain_text(l)).collect(),
        diff: if truncated {
            cut(&diff, MAX_DIFF_BYTES)
        } else {
            plain_text(&diff)
        },
        truncated,
    }
}
