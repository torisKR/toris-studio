//! Native Reason Network adapter for the installed 0.12.17 engine.
//!
//! Identity and sending use its public stdio MCP server. Roster/inbox metadata
//! use the engine's versioned local JSON-lines API because MCP renders them as
//! prose (and check_inbox acknowledges before returning). Only Team/Who, our own
//! Inbox { peek: true }, and Delivered for IDs already saved locally are used.
//! The nonsecret team ID scopes cached requests; a team switch fails closed.
//! No install, join, credential access, shared terminal mailbox, or automatic send.
//!
//! Source contracts:
//! https://github.com/reason-machines/reason-network/blob/v0.12.17/src/mcp.rs
//! https://github.com/reason-machines/reason-network/blob/v0.12.17/src/proto.rs
//! https://github.com/reason-machines/reason-network/blob/v0.12.17/src/paths.rs
//! https://github.com/reason-machines/reason-network/blob/v0.12.17/src/daemon/mail.rs
//!
//! This is at-least-once transport: peek -> atomic cache write/fsync -> ack.
//! A crash after saving but before ack can redeliver; IDs are deduplicated.
//! Only the newest 200 received messages are retained. Video job idempotency
//! lives separately in reason_video and is not a claim of exactly-once delivery.
use crate::reason_video::{self, VideoRequest};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::HashSet,
    fs::{self, File, OpenOptions},
    future::Future,
    io::{Read, Write},
    path::{Path, PathBuf},
    process::Stdio,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, OnceLock,
    },
    time::Duration,
};
use tokio::{
    io::{AsyncBufRead, AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, ChildStdout, Command},
    sync::{Mutex, Notify},
};
use uuid::Uuid;

pub const SUPPORTED_ENGINE_VERSION: &str = "0.12.17";
pub const MAX_MESSAGES: usize = 200;
pub const MAX_SEND_BYTES: usize = 32 * 1024;
const MAX_MESSAGE_BYTES: usize = 64 * 1024;
const MAX_WIRE_BYTES: usize = 16 * 1024 * 1024;
const MAX_CACHE_BYTES: u64 = 24 * 1024 * 1024;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(12);
const STOPPED: &str = "Reason Network 연결이 종료되었습니다.";

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub state: String,
    pub version: Option<String>,
    pub self_id: Option<String>,
    pub peers: Vec<Peer>,
    pub messages: Vec<Message>,
    pub error: Option<String>,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Peer {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub machine: Option<String>,
    pub cwd: Option<String>,
    pub branch: Option<String>,
    pub busy: bool,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Message {
    pub id: String,
    pub from: String,
    pub from_name: Option<String>,
    pub text: String,
    pub created_at: Option<String>,
    pub reply_to: Option<String>,
    #[serde(default)]
    pub video: Option<VideoRequest>,
    #[serde(default)]
    pub request_error: Option<String>,
    #[serde(default)]
    pub job_id: Option<String>,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Receipt {
    pub message_ids: Vec<String>,
}

/// `uncertain`: the request was dispatched but no receipt came back.
#[derive(Debug)]
pub struct SendFailure {
    pub message: String,
    pub uncertain: bool,
}

#[derive(Debug)]
struct Failure {
    state: &'static str,
    message: String,
}
impl Failure {
    fn setup(message: impl Into<String>) -> Self {
        Self {
            state: "setup_required",
            message: message.into(),
        }
    }
}
impl From<String> for Failure {
    fn from(message: String) -> Self {
        Self {
            state: "error",
            message,
        }
    }
}

struct Options {
    storage: PathBuf,
    engine: Option<PathBuf>,
    network_home: Option<PathBuf>,
    timeout: Duration,
}
struct Store {
    root: PathBuf,
    session: String,
    team_id: Option<String>,
    _lock: File,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct IdentityFile {
    version: u32,
    session: String,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct CacheFile {
    version: u32,
    session: String,
    #[serde(default)]
    team_id: Option<String>,
    messages: Vec<Message>,
}
#[derive(Default)]
struct NetworkState {
    store: Option<Store>,
    connection: Option<Mcp>,
    version: Option<String>,
    self_id: Option<String>,
    own_address: Option<String>,
    peers: Vec<Peer>,
    messages: Vec<Message>,
}

pub struct ReasonNetwork {
    options: Options,
    inner: Mutex<NetworkState>,
    stopped: AtomicBool,
    stopping: Notify,
}

static SHARED: OnceLock<Arc<ReasonNetwork>> = OnceLock::new();
pub fn shared() -> Arc<ReasonNetwork> {
    SHARED
        .get_or_init(|| Arc::new(ReasonNetwork::new()))
        .clone()
}
impl Default for ReasonNetwork {
    fn default() -> Self {
        Self::new()
    }
}
impl ReasonNetwork {
    pub fn new() -> Self {
        let parent = crate::config::config_path()
            .parent()
            .map(Path::to_path_buf)
            .unwrap_or_else(|| PathBuf::from("."));
        Self::from_options(Options {
            storage: parent.join("reason-network"),
            engine: None,
            network_home: None,
            timeout: REQUEST_TIMEOUT,
        })
    }

    /// Dependency injection for native contract tests. Never exposed over IPC.
    #[doc(hidden)]
    pub fn with_paths(
        storage: PathBuf,
        engine: PathBuf,
        network_home: PathBuf,
        timeout: Duration,
    ) -> Self {
        Self::from_options(Options {
            storage,
            engine: Some(engine),
            network_home: Some(network_home),
            timeout,
        })
    }

    fn from_options(options: Options) -> Self {
        Self {
            options,
            inner: Mutex::new(NetworkState::default()),
            stopped: AtomicBool::new(false),
            stopping: Notify::new(),
        }
    }

    async fn bounded<T>(
        &self,
        operation: impl Future<Output = Result<T, Failure>>,
    ) -> Result<T, Failure> {
        // Register before the check so shutdown cannot be lost between them.
        let stopping = self.stopping.notified();
        tokio::pin!(stopping);
        stopping.as_mut().enable();
        if self.stopped.load(Ordering::Acquire) {
            return Err(STOPPED.to_string().into());
        }
        tokio::select! {
            _ = &mut stopping => Err(STOPPED.to_string().into()),
            result = tokio::time::timeout(self.options.timeout, operation) =>
                result.unwrap_or_else(|_| Err("Reason Network 응답 시간이 초과되었습니다. 연결을 닫았습니다. 상태를 확인한 뒤 새로고침하세요.".to_string().into())),
        }
    }

    pub async fn identity(&self) -> Result<String, String> {
        let mut state = self.inner.lock().await;
        self.load_store(&mut state)?;
        let store = state.store.as_ref().expect("loaded");
        let team = store
            .team_id
            .as_deref()
            .ok_or("먼저 Reason Network 연결을 새로고침하여 네트워크를 확인하세요.")?;
        Ok(format!("reason-network:{team}:agent:{}", store.session))
    }

    pub async fn message(&self, id: &str) -> Result<Message, String> {
        validate_id(id)?;
        let mut state = self.inner.lock().await;
        self.load_store(&mut state)?;
        state
            .messages
            .iter()
            .find(|m| m.id == id)
            .cloned()
            .ok_or_else(|| "받은 메시지를 찾지 못했습니다. 받은 편지함을 새로고침하세요.".into())
    }

    pub async fn refresh(&self) -> Snapshot {
        self.refresh_mode(true).await
    }

    /// Connection/roster/own-inbox diagnostic; never sends or acknowledges mail.
    /// It still creates this app's local identity and registers its own MCP session.
    pub async fn probe(&self) -> Snapshot {
        self.refresh_mode(false).await
    }

    async fn refresh_mode(&self, acknowledge: bool) -> Snapshot {
        let mut state = self.inner.lock().await;
        let result = self
            .bounded(async {
                self.load_store(&mut state).map_err(Failure::from)?;
                self.ensure_connection(&mut state).await?;
                self.roster(&mut state).await?;
                self.receive(&mut state, acknowledge).await?;
                Ok(())
            })
            .await;
        match result {
            Ok(()) => snapshot(&state, "connected", None),
            Err(error) => {
                // Dropping an owned MCP child kills it; a later explicit refresh may reconnect.
                state.connection.take();
                state.peers.clear();
                snapshot(&state, error.state, Some(error.message))
            }
        }
    }

    pub async fn send(
        &self,
        target: &str,
        text: &str,
        reply_to: Option<&str>,
    ) -> Result<Receipt, String> {
        self.send_keyed(target, text, reply_to, &Uuid::new_v4().to_string())
            .await
            .map_err(|failure| failure.message)
    }

    /// Last known address, roster and received mail. No network I/O.
    pub async fn cached(&self) -> Result<Snapshot, String> {
        let mut state = self.inner.lock().await;
        self.load_store(&mut state)?;
        Ok(snapshot(&state, "cached", None))
    }

    /// Folder holding this Studio's Reason records, guarded by `studio.lock` once loaded.
    pub fn storage(&self) -> &Path {
        &self.options.storage
    }

    /// `key` is the engine's idempotency key. A caller that gets `uncertain`
    /// may only resend, with the same key, after the user approves it again.
    pub async fn send_keyed(
        &self,
        target: &str,
        text: &str,
        reply_to: Option<&str>,
        key: &str,
    ) -> Result<Receipt, SendFailure> {
        let refused = |message: String| SendFailure {
            message,
            uncertain: false,
        };
        validate_address(target).map_err(refused)?;
        if text.trim().is_empty() || text.len() > MAX_SEND_BYTES || text.contains('\0') {
            return Err(refused(
                "메시지는 비어 있지 않은 32 KiB 이하 텍스트여야 합니다.".into(),
            ));
        }
        if let Some(id) = reply_to {
            validate_id(id).map_err(refused)?;
        }
        validate_id(key).map_err(refused)?;
        let mut state = self.inner.lock().await;
        let mut dispatched = false;
        let result = self
            .bounded(async {
                self.load_store(&mut state).map_err(Failure::from)?;
                self.ensure_connection(&mut state).await?;
                self.roster(&mut state).await?;
                validate_recipient(&state.peers, &state.messages, target, reply_to)
                    .map_err(Failure::from)?;
                let mut args = json!({
                    "to": target, "message": text, "notify": false,
                    "idempotency_key": key
                });
                if let Some(id) = reply_to {
                    args["reply_to"] = json!(id);
                }
                let socket = state.connection.as_ref().expect("connected").socket.clone();
                self.verify_team(&mut state, &socket).await?;
                dispatched = true;
                let response = state
                    .connection
                    .as_mut()
                    .expect("connected")
                    .tool("send_message", args)
                    .await
                    .map_err(Failure::from)?;
                parse_receipt(&response).map_err(Failure::from)
            })
            .await;
        match result {
            Ok(receipt) => Ok(receipt),
            Err(error) => {
                state.connection.take();
                state.peers.clear();
                if dispatched {
                    // A lost response does not prove a failed send. Never automatically retry.
                    Err(SendFailure {
                        message: format!(
                            "{} 전송 여부가 불확실할 수 있으므로 자동 재전송하지 않았습니다.",
                            error.message
                        ),
                        uncertain: true,
                    })
                } else {
                    Err(SendFailure {
                        message: error.message,
                        uncertain: false,
                    })
                }
            }
        }
    }

    pub fn shutdown(&self) {
        self.stopped.store(true, Ordering::Release);
        self.stopping.notify_waiters();
        if let Ok(mut state) = self.inner.try_lock() {
            state.connection.take();
        }
    }

    fn load_store(&self, state: &mut NetworkState) -> Result<(), String> {
        if state.store.is_some() {
            return Ok(());
        }
        let (store, messages) = Store::open(&self.options.storage)?;
        state.messages = messages;
        state.store = Some(store);
        Ok(())
    }

    fn network_home(&self) -> Result<PathBuf, String> {
        if let Some(path) = &self.options.network_home {
            return Ok(path.clone());
        }
        if let Some(path) =
            std::env::var_os("REASON_NETWORK_HOME").or_else(|| std::env::var_os("TINCAN_HOME"))
        {
            let path = PathBuf::from(path);
            if !path.is_absolute() {
                return Err("Reason Network 저장 폴더는 절대 경로여야 합니다.".into());
            }
            return Ok(path);
        }
        let home = dirs::home_dir().ok_or("사용자 홈 폴더를 찾지 못했습니다.")?;
        let current = home.join(".reason/network");
        let legacy = home.join(".tincan");
        if !has_database(&current) && has_database(&legacy) {
            Ok(legacy)
        } else {
            Ok(current)
        }
    }

    async fn ensure_connection(&self, state: &mut NetworkState) -> Result<(), Failure> {
        if state.connection.is_some() {
            return Ok(());
        }
        if !cfg!(unix) {
            return Err("이 버전의 Reason 연결은 macOS·Linux 로컬 소켓을 지원합니다. Windows 전송 계층은 아직 지원하지 않습니다.".to_string().into());
        }
        let engine = self.options.engine.clone().filter(|p| p.is_file()).or_else(|| {
            if self.options.engine.is_some() { None } else { discover_engine() }
        }).ok_or_else(|| Failure {
            state: "missing", message: "Reason Network 실행 파일을 찾지 못했습니다. Reason에서 Network 설정을 완료한 뒤 새로고침하세요.".into(),
        })?;
        let home = self.network_home().map_err(Failure::from)?;
        if !has_database(&home) {
            return Err(Failure::setup(
                "Reason Network가 아직 설정되지 않았습니다. Reason에서 네트워크 연결을 완료하세요.",
            ));
        }
        let socket = socket_path(&home).map_err(Failure::from)?;
        // Team is a cheap, read-only preflight on an already running daemon.
        // Avoid repeated Who scans: process/git discovery can be slow on busy machines.
        self.verify_team(state, &socket).await?;
        let store = state.store.as_ref().expect("loaded");
        let mut command = Command::new(engine);
        command
            .arg("mcp")
            .current_dir(&store.root)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        for key in AGENT_ENV {
            command.env_remove(key);
        }
        command
            .env("REASON_NETWORK_SESSION", &store.session)
            .env("REASON_NETWORK_HOME", &home)
            .env("NO_COLOR", "1");
        let child = command.spawn().map_err(|_| {
            Failure::from("Reason Network 실행 파일을 시작하지 못했습니다.".to_string())
        })?;
        let mut mcp = Mcp::new(child)?;
        let result = mcp
            .call(
                "initialize",
                json!({
                    "protocolVersion":"2025-11-25", "capabilities":{},
                    "clientInfo":{"name":"toris-studio","version":env!("CARGO_PKG_VERSION")}
                }),
            )
            .await
            .map_err(Failure::from)?;
        let version = result
            .pointer("/serverInfo/version")
            .and_then(Value::as_str)
            .filter(|v| {
                v.len() < 40
                    && v.bytes()
                        .all(|c| c.is_ascii_alphanumeric() || b".-+".contains(&c))
            })
            .ok_or_else(|| {
                Failure::from("Reason Network 엔진 버전을 확인하지 못했습니다.".to_string())
            })?;
        state.version = Some(version.to_string());
        if version != SUPPORTED_ENGINE_VERSION {
            return Err(format!("Reason Network 엔진 {version}의 로컬 규약은 아직 검증되지 않았습니다. 이 연결은 {SUPPORTED_ENGINE_VERSION}에서 검증되었습니다.").into());
        }
        let protocol = result["protocolVersion"].as_str().unwrap_or("");
        if !["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"].contains(&protocol) {
            return Err("Reason Network의 MCP 규약 버전을 지원하지 않습니다."
                .to_string()
                .into());
        }
        mcp.notify("notifications/initialized", json!({}))
            .await
            .map_err(Failure::from)?;
        let tools = mcp
            .call("tools/list", json!({}))
            .await
            .map_err(Failure::from)?;
        for required in ["message_status", "send_message"] {
            if !tools["tools"]
                .as_array()
                .is_some_and(|tools| tools.iter().any(|t| t["name"] == required))
            {
                return Err("Reason Network MCP 도구 구성이 예상과 다릅니다."
                    .to_string()
                    .into());
            }
        }
        // An empty status query registers agent:<our persisted UUID> without
        // sending, consuming mail, or performing another expensive roster scan.
        mcp.tool("message_status", json!({"ids":[]}))
            .await
            .map_err(Failure::from)?;
        mcp.socket = socket;
        state.connection = Some(mcp);
        Ok(())
    }

    async fn roster(&self, state: &mut NetworkState) -> Result<(), Failure> {
        let session = format!("agent:{}", state.store.as_ref().expect("loaded").session);
        let socket = state.connection.as_ref().expect("connected").socket.clone();
        self.verify_team(state, &socket).await?;
        let directory: RawDirectory =
            decode(daemon_call(&socket, json!({"op":"who","me":session,"all":false})).await?)?;
        if directory.team.as_deref().is_none_or(str::is_empty) {
            return Err(Failure::setup("Reason Network 팀 연결이 해제되었습니다."));
        }
        let (own_address, self_id, peers) = normalize_roster(directory).map_err(Failure::from)?;
        state.own_address = Some(own_address);
        state.self_id = Some(self_id);
        state.peers = peers;
        Ok(())
    }

    async fn verify_team(&self, state: &mut NetworkState, socket: &Path) -> Result<(), Failure> {
        let team: RawTeam = decode(daemon_call(socket, json!({"op":"team"})).await?)?;
        if team.team_id.len() != 32 || !team.team_id.bytes().all(|c| c.is_ascii_hexdigit()) {
            return Err("Reason 네트워크의 고유 식별자를 확인하지 못했습니다."
                .to_string()
                .into());
        }
        let store = state.store.as_mut().expect("loaded");
        match store.team_id.as_deref() {
            Some(id) if id != team.team_id => return Err(Failure::setup("Reason 네트워크가 변경되었습니다. 기존 수신 기록과 영상 요청을 섞지 않도록 연결을 중단했습니다.")),
            Some(_) => {},
            None if !state.messages.is_empty() => return Err(Failure::setup("기존 Reason 수신 기록의 네트워크를 확인할 수 없어 연결을 중단했습니다.")),
            None => {
                store.team_id = Some(team.team_id);
                store.save(&state.messages).map_err(Failure::from)?;
            }
        }
        Ok(())
    }

    async fn receive(&self, state: &mut NetworkState, acknowledge: bool) -> Result<(), Failure> {
        let store = state.store.as_ref().expect("loaded");
        // Validate a complete atomic cache write BEFORE reading the mailbox.
        store.save(&state.messages).map_err(Failure::from)?;
        let session = format!("agent:{}", store.session);
        let socket = state.connection.as_ref().expect("connected").socket.clone();
        let inbox: RawInbox = decode(
            daemon_call(
                &socket,
                json!({"op":"inbox","key":session,"wait_secs":0,"peek":true}),
            )
            .await?,
        )?;
        // Membership may change while a slow roster/inbox request is in flight.
        // Do not attach newly received data to the previous team namespace.
        self.verify_team(state, &socket).await?;
        let store = state.store.as_ref().expect("loaded");
        let own = state.own_address.as_deref().expect("roster");
        let mut received = Vec::new();
        // Leave the rest unread for a later explicit refresh.
        for raw in inbox.messages.into_iter().take(MAX_MESSAGES) {
            received.push(normalize_message(raw, own, &state.peers).map_err(Failure::from)?);
        }
        let ids: Vec<String> = received.iter().map(|m| m.id.clone()).collect();
        for message in received {
            if let Some(existing) = state.messages.iter().find(|m| m.id == message.id) {
                if existing.from != message.from
                    || existing.text != message.text
                    || existing.reply_to != message.reply_to
                {
                    return Err(
                        "같은 Reason 메시지 ID에 다른 내용이 도착했습니다. 수신을 중단했습니다."
                            .to_string()
                            .into(),
                    );
                }
            } else {
                state.messages.push(message);
            }
        }
        if state.messages.len() > MAX_MESSAGES {
            state.messages.drain(..state.messages.len() - MAX_MESSAGES);
        }
        // If this fails, retain the newly received messages in memory and leave ALL IDs unread.
        store.save(&state.messages).map_err(Failure::from)?;
        if acknowledge && !ids.is_empty() {
            self.verify_team(state, &socket).await?;
            daemon_call(&socket, json!({"op":"delivered","key":session,"ids":ids})).await?;
        }
        Ok(())
    }
}
impl Drop for ReasonNetwork {
    fn drop(&mut self) {
        self.inner.get_mut().connection.take();
    }
}

fn snapshot(state: &NetworkState, status: &str, error: Option<String>) -> Snapshot {
    Snapshot {
        state: status.into(),
        version: state.version.clone(),
        self_id: state.self_id.clone(),
        peers: state.peers.clone(),
        messages: state.messages.iter().rev().cloned().collect(),
        error,
    }
}
fn discover_engine() -> Option<PathBuf> {
    let name = if cfg!(windows) {
        "reason-network.exe"
    } else {
        "reason-network"
    };
    let installed = dirs::home_dir()?.join(".reason/bin").join(name);
    std::iter::once(installed)
        .chain(
            crate::agent_runtime::search_path()
                .into_iter()
                .map(|p| p.join(name)),
        )
        .find(|path| path.is_file())
}
fn has_database(home: &Path) -> bool {
    home.join("network.db").is_file() || home.join("tincan.db").is_file()
}
fn socket_path(home: &Path) -> Result<PathBuf, String> {
    let stem = if !home.join("network.db").exists() && home.join("tincan.db").exists() {
        "tincan"
    } else {
        "network"
    };
    let path = home.join(format!("{stem}.sock"));
    if path.as_os_str().as_encoded_bytes().len() >= 100 {
        // The engine hashes long Unix paths into a uid-specific directory. Do not
        // guess the UID/transport; require a supported short state path instead.
        return Err(
            "Reason Network 소켓 경로가 너무 깁니다. 100바이트 미만의 상태 폴더 경로가 필요합니다."
                .into(),
        );
    }
    Ok(path)
}

// These inherited flags would attach Studio to somebody else's agent/mailbox.
pub(crate) const AGENT_ENV: &[&str] = &[
    "REASON_NETWORK_AGENT",
    "TINCAN_AGENT",
    "REASON_NETWORK_SESSION",
    "TINCAN_SESSION",
    "CLAUDECODE",
    "CLAUDE_CODE_SESSION_ID",
    "CLAUDE_CODE_ENTRYPOINT",
    "CLAUDE_PID",
    "CLAUDE_PROJECT_DIR",
    "CLAUDE_CODE_MESSAGING_SOCKET",
    "CLAUDE_CODE_MESSAGING_TOKEN",
    "CODEX_THREAD_ID",
    "CODEX_SESSION_ID",
    "GROK_SESSION_ID",
    "GROK_WORKSPACE_ROOT",
    "GEMINI_CLI",
    "GEMINI_SESSION_ID",
    "CURSOR_AGENT",
    "OPENCODE",
    "OPENCODE_SESSION_ID",
    "COPILOT_CLI",
    "COPILOT_AGENT_SESSION_ID",
];

struct Mcp {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
    next_id: u64,
    socket: PathBuf,
}
impl Mcp {
    fn new(mut child: Child) -> Result<Self, Failure> {
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| Failure::from("Reason MCP 입력을 열지 못했습니다.".to_string()))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| Failure::from("Reason MCP 출력을 열지 못했습니다.".to_string()))?;
        Ok(Self {
            child,
            stdin,
            stdout: BufReader::new(stdout),
            next_id: 1,
            socket: PathBuf::new(),
        })
    }
    async fn write(&mut self, value: Value) -> Result<(), String> {
        let mut bytes =
            serde_json::to_vec(&value).map_err(|_| "Reason MCP 요청을 만들지 못했습니다.")?;
        if bytes.len() > 256 * 1024 {
            return Err("Reason MCP 요청이 너무 큽니다.".into());
        }
        bytes.push(b'\n');
        self.stdin
            .write_all(&bytes)
            .await
            .map_err(|_| "Reason MCP 연결에 쓰지 못했습니다.")?;
        self.stdin
            .flush()
            .await
            .map_err(|_| "Reason MCP 요청을 전송하지 못했습니다.".into())
    }
    async fn notify(&mut self, method: &str, params: Value) -> Result<(), String> {
        self.write(json!({"jsonrpc":"2.0","method":method,"params":params}))
            .await
    }
    async fn call(&mut self, method: &str, params: Value) -> Result<Value, String> {
        let id = self.next_id;
        self.next_id += 1;
        self.write(json!({"jsonrpc":"2.0","id":id,"method":method,"params":params}))
            .await?;
        let mut total = 0;
        for _ in 0..64 {
            let (response, size) = read_json_line(&mut self.stdout).await?;
            total += size;
            if total > MAX_WIRE_BYTES * 2 {
                return Err("Reason MCP 응답 한도를 초과했습니다.".into());
            }
            if response["id"].as_u64() != Some(id) {
                if response.get("method").is_some() && response.get("id").is_none() {
                    continue;
                }
                return Err("Reason MCP 응답 식별자가 일치하지 않습니다.".into());
            }
            if response.get("error").is_some() {
                return Err(
                    "Reason MCP 요청이 거절되었습니다. Reason의 네트워크 설정을 확인하세요.".into(),
                );
            }
            return response
                .get("result")
                .cloned()
                .ok_or_else(|| "Reason MCP 응답 형식이 예상과 다릅니다.".into());
        }
        Err("Reason MCP 알림 한도를 초과했습니다.".into())
    }
    async fn tool(&mut self, name: &str, arguments: Value) -> Result<String, String> {
        let result = self
            .call("tools/call", json!({"name":name,"arguments":arguments}))
            .await?;
        if result["isError"].as_bool() == Some(true) {
            // Server errors may contain account/path data; never pass raw stderr or errors to the UI.
            return Err("Reason Network 도구를 실행하지 못했습니다. Reason의 네트워크·폴더 설정을 확인하세요.".into());
        }
        let content = result["content"]
            .as_array()
            .ok_or("Reason MCP 도구 응답을 읽지 못했습니다.")?;
        let mut text = String::new();
        for item in content {
            if item["type"] != "text" {
                continue;
            }
            let part = item["text"]
                .as_str()
                .ok_or("Reason MCP 텍스트 응답이 잘못되었습니다.")?;
            text.push_str(part);
            text.push('\n');
        }
        if text.is_empty() {
            return Err("Reason MCP 도구 응답이 비어 있습니다.".into());
        }
        Ok(text)
    }
}
impl Drop for Mcp {
    fn drop(&mut self) {
        let _ = self.child.start_kill();
    }
}

async fn read_json_line<R: AsyncBufRead + Unpin>(reader: &mut R) -> Result<(Value, usize), String> {
    let mut bytes = Vec::new();
    loop {
        let part = reader
            .fill_buf()
            .await
            .map_err(|_| "Reason 연결에서 응답을 읽지 못했습니다.")?;
        if part.is_empty() {
            return Err("Reason 연결이 응답 전에 닫혔습니다.".into());
        }
        let end = part.iter().position(|b| *b == b'\n');
        let count = end.map_or(part.len(), |i| i + 1);
        if bytes.len() + count > MAX_WIRE_BYTES {
            return Err("Reason 응답 크기가 안전한 처리 한도를 초과했습니다.".into());
        }
        bytes.extend_from_slice(&part[..count]);
        reader.consume(count);
        if end.is_some() {
            break;
        }
    }
    let size = bytes.len();
    serde_json::from_slice(&bytes)
        .map(|v| (v, size))
        .map_err(|_| "Reason 응답 JSON 형식이 잘못되었습니다.".into())
}

#[cfg(unix)]
async fn daemon_call(socket: &Path, mut request: Value) -> Result<Value, Failure> {
    use std::os::unix::fs::FileTypeExt;
    if !fs::metadata(socket).is_ok_and(|m| m.file_type().is_socket()) {
        return Err(Failure::setup("Reason Network 백그라운드 연결을 찾지 못했습니다. Reason에서 Network를 실행한 뒤 새로고침하세요."));
    }
    let stream = tokio::net::UnixStream::connect(socket).await
        .map_err(|_| Failure::setup("Reason Network 백그라운드 연결에 접속하지 못했습니다. Reason에서 Network 상태를 확인하세요."))?;
    let (read, mut write) = stream.into_split();
    request["id"] = json!(1);
    let mut bytes = serde_json::to_vec(&request)
        .map_err(|_| Failure::from("Reason 로컬 요청을 만들지 못했습니다.".to_string()))?;
    bytes.push(b'\n');
    write
        .write_all(&bytes)
        .await
        .map_err(|_| Failure::from("Reason 로컬 연결에 쓰지 못했습니다.".to_string()))?;
    let (reply, _) = read_json_line(&mut BufReader::new(read))
        .await
        .map_err(Failure::from)?;
    if reply["id"].as_u64() != Some(1) || reply["ok"].as_bool() != Some(true) {
        if reply["error"]
            .as_str()
            .is_some_and(|e| e.contains("not in a team"))
        {
            return Err(Failure::setup("Reason Network 팀에 연결되어 있지 않습니다. Reason에서 네트워크 설정을 완료하세요."));
        }
        return Err(
            "Reason 로컬 요청이 거절되었거나 응답 형식이 변경되었습니다."
                .to_string()
                .into(),
        );
    }
    reply
        .get("result")
        .cloned()
        .ok_or_else(|| "Reason 로컬 응답에 결과가 없습니다.".to_string().into())
}
#[cfg(not(unix))]
async fn daemon_call(_socket: &Path, _request: Value) -> Result<Value, Failure> {
    Err(
        "이 운영체제에서는 Reason 로컬 전송 계층을 아직 지원하지 않습니다."
            .to_string()
            .into(),
    )
}
fn decode<T: serde::de::DeserializeOwned>(value: Value) -> Result<T, Failure> {
    serde_json::from_value(value).map_err(|_| {
        "Reason Network 0.12.17의 로컬 응답 규약과 일치하지 않습니다."
            .to_string()
            .into()
    })
}

#[derive(Deserialize)]
struct RawTeam {
    team_id: String,
}
#[derive(Deserialize)]
struct RawDirectory {
    team: Option<String>,
    sessions: Vec<RawPeer>,
}
#[derive(Deserialize)]
struct RawPeer {
    address: String,
    name: String,
    agent: String,
    machine: String,
    cwd: String,
    branch: Option<String>,
    status: String,
    tier: String,
    is_me: bool,
}
#[derive(Deserialize)]
struct RawInbox {
    messages: Vec<RawMessage>,
}
#[derive(Deserialize)]
struct RawMessage {
    id: String,
    from: String,
    to: String,
    body: String,
    reply_to: Option<String>,
    sent_at: i64,
}
fn normalize_roster(directory: RawDirectory) -> Result<(String, String, Vec<Peer>), String> {
    if directory.sessions.len() > 2000 {
        return Err("Reason 세션 목록이 처리 한도를 초과했습니다.".into());
    }
    let mut own = None;
    let mut peers = Vec::new();
    let mut seen = HashSet::new();
    for row in directory.sessions {
        if row.tier == "none" || row.status == "offline" {
            continue;
        }
        validate_address(&row.address)?;
        validate_component(&row.machine)?;
        // The tier is a closed enum in the engine. The status is free-form there
        // (0.12.17 also reports `shell` and `stuck` beyond its documented values)
        // and only drives a display hint, so an unfamiliar one must not hide the roster.
        if !["push", "turn", "pull"].contains(&row.tier.as_str())
            || row.status.is_empty()
            || row.status.len() > 32
            || !row
                .status
                .bytes()
                .all(|c| c.is_ascii_lowercase() || c == b'_' || c == b'-')
        {
            return Err("Reason 세션 상태 형식이 변경되었습니다.".into());
        }
        if row.name.len() > 512
            || row.agent.len() > 128
            || row.cwd.len() > 4096
            || row.branch.as_ref().is_some_and(|s| s.len() > 1024)
        {
            return Err("Reason 세션 정보가 처리 한도를 초과했습니다.".into());
        }
        // The official resolver accepts @machine; qualify to avoid same-name sessions on two machines.
        let address = format!("{}@{}", row.address, row.machine);
        validate_address(&address)?;
        if !seen.insert(address.clone()) {
            return Err("Reason 세션 주소가 중복되었습니다.".into());
        }
        if row.is_me {
            if own.is_some() {
                return Err("Toris Studio의 Reason 세션을 하나로 식별하지 못했습니다.".into());
            }
            own = Some((row.address, address));
        } else {
            peers.push(Peer {
                id: address,
                name: row.name,
                kind: row.agent,
                machine: Some(row.machine),
                cwd: (!row.cwd.is_empty()).then_some(row.cwd),
                branch: row.branch,
                // Only a status known to mean "free" is shown as waiting.
                busy: !["idle", "live"].contains(&row.status.as_str()),
            });
        }
    }
    let (raw, qualified) =
        own.ok_or("Toris Studio 전용 Reason 세션 등록을 확인하지 못했습니다.")?;
    Ok((raw, qualified, peers))
}
fn normalize_message(raw: RawMessage, own: &str, peers: &[Peer]) -> Result<Message, String> {
    validate_id(&raw.id)?;
    validate_address(&raw.from)?;
    if raw.to != own {
        return Err("다른 Reason 세션의 메시지가 반환되어 수신을 중단했습니다.".into());
    }
    if let Some(id) = &raw.reply_to {
        validate_id(id)?;
    }
    if raw.body.len() > MAX_MESSAGE_BYTES {
        return Err("받은 Reason 메시지가 64 KiB 처리 한도를 초과했습니다.".into());
    }
    let created_at = chrono::DateTime::from_timestamp_millis(raw.sent_at)
        .map(|t| t.to_rfc3339_opts(chrono::SecondsFormat::Millis, true));
    // Normal agents arrive as person/session in engine 0.12.17; only terminal
    // messages reliably include @machine. Resolve a display name only when the
    // base address is unique, and never rewrite the sender used for replies.
    let from_name = peers
        .iter()
        .find(|p| p.id == raw.from)
        .or_else(|| {
            if raw.from.contains('@') {
                return None;
            }
            let mut matches = peers.iter().filter(|peer| {
                peer.id
                    .split_once('@')
                    .map_or(peer.id.as_str(), |(base, _)| base)
                    == raw.from
            });
            let first = matches.next()?;
            matches.next().is_none().then_some(first)
        })
        .map(|p| p.name.clone());
    let mut message = Message {
        id: raw.id,
        from: raw.from,
        from_name,
        text: raw.body,
        created_at,
        reply_to: raw.reply_to,
        video: None,
        request_error: None,
        job_id: None,
    };
    classify(&mut message);
    Ok(message)
}
fn classify(message: &mut Message) {
    match reason_video::parse_video_request(&message.text) {
        Ok(video) => {
            message.video = video;
            message.request_error = None;
        }
        Err(error) => {
            message.video = None;
            message.request_error = Some(error);
        }
    }
}
fn validate_component(part: &str) -> Result<(), String> {
    if part.is_empty()
        || part.len() > 256
        || part.starts_with('-')
        || !part
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"._-".contains(&c))
    {
        return Err("Reason 주소의 이름 형식이 올바르지 않습니다.".into());
    }
    Ok(())
}
pub(crate) fn validate_address(address: &str) -> Result<(), String> {
    if address.len() > 512 {
        return Err("Reason 주소가 너무 깁니다.".into());
    }
    let (base, machine) = address
        .split_once('@')
        .map_or((address, None), |(a, m)| (a, Some(m)));
    if let Some(machine) = machine {
        validate_component(machine)?;
    }
    let (person, session) = base
        .split_once('/')
        .ok_or("정확한 Reason 세션 주소가 필요합니다.")?;
    validate_component(person)?;
    validate_component(session)
}
pub(crate) fn validate_id(id: &str) -> Result<(), String> {
    if id.is_empty()
        || id.len() > 128
        || !id
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"_-".contains(&c))
    {
        return Err("Reason 메시지 식별자가 올바르지 않습니다.".into());
    }
    Ok(())
}
fn validate_recipient(
    peers: &[Peer],
    messages: &[Message],
    target: &str,
    reply: Option<&str>,
) -> Result<(), String> {
    if let Some(id) = reply {
        if messages.iter().any(|m| m.id == id && m.from == target) {
            return Ok(());
        }
        return Err("답장은 받은 메시지의 원래 발신자에게만 보낼 수 있습니다.".into());
    }
    if peers.iter().any(|p| p.id == target) {
        Ok(())
    } else {
        Err("현재 Reason 세션 목록에서 정확한 받는 사람을 선택하세요.".into())
    }
}
fn parse_receipt(text: &str) -> Result<Receipt, String> {
    let ids: Vec<&str> = text
        .lines()
        .filter_map(|line| line.strip_prefix("message id "))
        .collect();
    let recipients = text.lines().filter(|line| line.starts_with("→ ")).count();
    if ids.len() != 1 || recipients != 1 {
        return Err("Reason의 단일 수신자 전송 영수증을 확인하지 못했습니다.".into());
    }
    validate_id(ids[0])?;
    Ok(Receipt {
        message_ids: vec![ids[0].to_string()],
    })
}

/// Takes the store lock, waiting a moment for a previous holder to let go.
/// A process this app spawns from another thread can briefly keep a copy of
/// the lock between fork and exec, so a store that was just closed may still
/// look held for a few milliseconds. A real second window keeps holding it
/// and is still refused.
fn lock_briefly(lock: &File) -> std::io::Result<()> {
    let mut tries = 0;
    loop {
        match fs2::FileExt::try_lock_exclusive(lock) {
            Ok(()) => return Ok(()),
            Err(error) if tries >= 10 => return Err(error),
            Err(_) => {
                tries += 1;
                std::thread::sleep(std::time::Duration::from_millis(25));
            }
        }
    }
}

impl Store {
    fn open(root: &Path) -> Result<(Self, Vec<Message>), String> {
        reject_symlink(root)?;
        fs::create_dir_all(root).map_err(|_| "Reason 수신 기록 폴더를 만들지 못했습니다.")?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(root, fs::Permissions::from_mode(0o700))
                .map_err(|_| "Reason 수신 기록 폴더 권한을 설정하지 못했습니다.")?;
        }
        let lock_path = root.join("studio.lock");
        reject_symlink(&lock_path)?;
        let mut options = OpenOptions::new();
        options.create(true).read(true).write(true).truncate(false);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let lock = options
            .open(lock_path)
            .map_err(|_| "Reason 수신 기록 잠금 파일을 열지 못했습니다.")?;
        lock_briefly(&lock)
            .map_err(|_| "다른 Toris Studio 창이 Reason 수신 기록을 사용 중입니다.")?;
        let identity_path = root.join("identity.json");
        let cache_path = root.join("messages.json");
        let identity: IdentityFile = if identity_path.exists() {
            read_file(&identity_path, 1024)?
        } else {
            if cache_path.exists() {
                return Err(
                    "Reason 세션 식별자가 없어 기존 수신 기록을 안전하게 연결할 수 없습니다."
                        .into(),
                );
            }
            let identity = IdentityFile {
                version: 1,
                session: Uuid::new_v4().to_string(),
            };
            atomic_json(root, &identity_path, &identity)?;
            identity
        };
        if identity.version != 1 || Uuid::parse_str(&identity.session).is_err() {
            return Err("저장된 Reason 세션 식별자 형식이 잘못되었습니다.".into());
        }
        let mut store = Self {
            root: root.to_path_buf(),
            session: identity.session,
            team_id: None,
            _lock: lock,
        };
        let mut messages = if cache_path.exists() {
            let cache: CacheFile = read_file(&cache_path, MAX_CACHE_BYTES)?;
            if cache.version != 1
                || cache.session != store.session
                || cache.messages.len() > MAX_MESSAGES
            {
                return Err("Reason 수신 기록의 세션 또는 버전을 확인하지 못했습니다.".into());
            }
            if cache
                .team_id
                .as_ref()
                .is_some_and(|id| id.len() != 32 || !id.bytes().all(|c| c.is_ascii_hexdigit()))
            {
                return Err("저장된 Reason 네트워크 식별자가 잘못되었습니다.".into());
            }
            store.team_id = cache.team_id;
            cache.messages
        } else {
            Vec::new()
        };
        let mut seen = HashSet::new();
        for message in &mut messages {
            validate_id(&message.id)?;
            validate_address(&message.from)?;
            if let Some(id) = &message.reply_to {
                validate_id(id)?;
            }
            if message.text.len() > MAX_MESSAGE_BYTES || !seen.insert(message.id.clone()) {
                return Err("저장된 Reason 수신 기록의 크기 또는 식별자가 잘못되었습니다.".into());
            }
            classify(message);
        }
        store.save(&messages)?;
        Ok((store, messages))
    }
    fn save(&self, messages: &[Message]) -> Result<(), String> {
        atomic_json(
            &self.root,
            &self.root.join("messages.json"),
            &CacheFile {
                version: 1,
                session: self.session.clone(),
                team_id: self.team_id.clone(),
                messages: messages.to_vec(),
            },
        )
    }
}
fn reject_symlink(path: &Path) -> Result<(), String> {
    if fs::symlink_metadata(path).is_ok_and(|m| m.file_type().is_symlink()) {
        return Err("Reason 수신 기록에는 심볼릭 링크를 사용할 수 없습니다.".into());
    }
    Ok(())
}
pub(crate) fn read_file<T: serde::de::DeserializeOwned>(
    path: &Path,
    limit: u64,
) -> Result<T, String> {
    reject_symlink(path)?;
    let file = File::open(path).map_err(|_| "Reason 수신 기록을 열지 못했습니다.")?;
    if file
        .metadata()
        .map_err(|_| "Reason 수신 기록 크기를 확인하지 못했습니다.")?
        .len()
        > limit
    {
        return Err("Reason 수신 기록 크기가 처리 한도를 초과했습니다.".into());
    }
    let mut data = Vec::new();
    file.take(limit + 1)
        .read_to_end(&mut data)
        .map_err(|_| "Reason 수신 기록을 읽지 못했습니다.")?;
    if data.len() as u64 > limit {
        return Err("Reason 수신 기록 크기가 처리 한도를 초과했습니다.".into());
    }
    serde_json::from_slice(&data).map_err(|_| "Reason 수신 기록 형식이 잘못되었습니다.".into())
}
pub(crate) fn atomic_json<T: Serialize>(root: &Path, path: &Path, value: &T) -> Result<(), String> {
    reject_symlink(path)?;
    let bytes = serde_json::to_vec(value).map_err(|_| "Reason 수신 기록을 만들지 못했습니다.")?;
    if bytes.len() as u64 > MAX_CACHE_BYTES {
        return Err("Reason 수신 기록 크기가 처리 한도를 초과했습니다.".into());
    }
    let mut temp = tempfile::NamedTempFile::new_in(root)
        .map_err(|_| "Reason 수신 기록을 저장할 임시 파일을 만들지 못했습니다.")?;
    temp.write_all(&bytes)
        .map_err(|_| "Reason 수신 기록을 쓰지 못했습니다. 메시지는 확인 처리하지 않았습니다.")?;
    temp.as_file().sync_all().map_err(|_| {
        "Reason 수신 기록을 디스크에 저장하지 못했습니다. 메시지는 확인 처리하지 않았습니다."
    })?;
    temp.persist(path).map_err(|_| {
        "Reason 수신 기록을 교체하지 못했습니다. 메시지는 확인 처리하지 않았습니다."
    })?;
    #[cfg(unix)]
    File::open(root).and_then(|d| d.sync_all()).map_err(|_| {
        "Reason 수신 기록 폴더를 디스크에 저장하지 못했습니다. 메시지는 확인 처리하지 않았습니다."
    })?;
    Ok(())
}
