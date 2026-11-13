//! Starts and stops `reason network serve claude|codex` for a folder the user
//! picked in the OS dialog, so Claude and Codex appear as Reason Network peers.
//!
//! A served agent edits files in that folder without asking (serve runs Claude
//! with acceptEdits and Codex in its workspace-write sandbox), so a launch is
//! bound to one explicit pick + confirmation: the folder never comes from the
//! webview, a model, or a network message. `--full-access` is never passed.
//! Output is discarded because it carries sender names and message excerpts.
//! Nothing is restarted automatically. If Studio crashes, sessions it started
//! keep running until stopped from a terminal.
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::Mutex,
    time::Duration,
};

pub const MAX_SESSIONS: usize = 4;
const MAX_MACHINE: usize = 18;
const MAX_SLUG: usize = 17;
// Folders an agent with unprompted write access must never be given.
const SYSTEM_ROOTS: &[&str] = &[
    "/etc",
    "/usr",
    "/bin",
    "/sbin",
    "/dev",
    "/System",
    "/Library",
    "/Applications",
    "/private/etc",
    "/private/var/root",
];
#[cfg(unix)]
use std::time::Instant;

const STOP_GRACE: Duration = Duration::from_secs(3);

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AgentKind {
    Claude,
    Codex,
}
impl AgentKind {
    /// Both the `serve` argument and the agent's own executable name.
    fn command(self) -> &'static str {
        match self {
            AgentKind::Claude => "claude",
            AgentKind::Codex => "codex",
        }
    }
    fn label(self) -> &'static str {
        match self {
            AgentKind::Claude => "Claude Code",
            AgentKind::Codex => "Codex",
        }
    }
}

/// What the user is asked to confirm before anything runs.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Draft {
    pub kind: AgentKind,
    pub folder: String,
    pub branch: Option<String>,
    pub name: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSession {
    pub id: String,
    pub kind: AgentKind,
    pub name: String,
    pub folder: String,
    pub branch: Option<String>,
    pub running: bool,
    pub exit_code: Option<i32>,
}

struct Owned {
    info: AgentSession,
    child: Child,
}
#[derive(Default)]
struct Inner {
    pending: Option<Draft>,
    sessions: Vec<Owned>,
}

#[derive(Default)]
pub struct ReasonAgents {
    cli: Option<PathBuf>,
    path: Option<Vec<PathBuf>>,
    inner: Mutex<Inner>,
}

fn slug(text: &str, limit: usize) -> String {
    let mut out = String::new();
    for c in text.chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c.to_ascii_lowercase());
        } else if !out.is_empty() && !out.ends_with('-') {
            out.push('-');
        }
    }
    out.truncate(limit);
    out.trim_end_matches('-').to_string()
}

/// `{machine}-{kind}-{folder}-{hash}` in `[a-z0-9-]`: distinct per machine as
/// Reason recommends, and per folder so two `app` folders never share an address.
pub fn session_name(machine: &str, kind: AgentKind, folder: &Path) -> String {
    let or = |value: String, fallback: &str| {
        if value.is_empty() {
            fallback.to_string()
        } else {
            value
        }
    };
    let machine = or(slug(machine, MAX_MACHINE), "studio");
    let name = folder
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("");
    let hash = format!(
        "{:x}",
        Sha256::digest(folder.as_os_str().as_encoded_bytes())
    );
    format!(
        "{machine}-{}-{}-{}",
        kind.command(),
        or(slug(name, MAX_SLUG), "project"),
        &hash[..4]
    )
}

fn branch(folder: &Path) -> Option<String> {
    let path = folder.join(".git/HEAD");
    // A regular small file only: never follow a link or block on a device.
    fs::symlink_metadata(&path)
        .ok()
        .filter(|meta| meta.is_file() && meta.len() <= 512)?;
    let head = fs::read_to_string(path).ok()?;
    let name = head.trim().strip_prefix("ref: refs/heads/")?;
    (!name.is_empty() && name.len() <= 200 && !name.chars().any(char::is_control))
        .then(|| name.to_string())
}

impl ReasonAgents {
    /// Dependency injection for native contract tests. Never exposed over IPC.
    #[doc(hidden)]
    pub fn with_cli(cli: PathBuf, path: Vec<PathBuf>) -> Self {
        Self {
            cli: Some(cli),
            path: Some(path),
            inner: Mutex::default(),
        }
    }

    fn search_path(&self) -> Vec<PathBuf> {
        self.path
            .clone()
            .unwrap_or_else(crate::agent_runtime::search_path)
    }
    fn inner(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Records the one folder the user just picked. `picked` must come from the
    /// native folder dialog; it is resolved and checked before it is remembered.
    pub fn offer(&self, picked: &Path, kind: AgentKind, machine: &str) -> Result<Draft, String> {
        let folder = picked
            .canonicalize()
            .map_err(|_| "선택한 폴더를 열 수 없습니다.")?;
        if !folder.is_dir() {
            return Err("프로젝트 폴더를 선택하세요.".into());
        }
        let home = dirs::home_dir().and_then(|home| home.canonicalize().ok());
        if folder.parent().is_none() || home.as_ref().is_some_and(|home| home.starts_with(&folder))
        {
            return Err(
                "홈 폴더나 그 상위 폴더 전체는 맡길 수 없습니다. 프로젝트 폴더를 선택하세요."
                    .into(),
            );
        }
        // Settings, keys and app data: ~/.ssh, ~/.aws, ~/Library and the like.
        let private = home
            .as_ref()
            .and_then(|home| folder.strip_prefix(home).ok())
            .is_some_and(|inside| {
                inside.components().next().is_some_and(|first| {
                    let first = first.as_os_str().to_string_lossy();
                    first.starts_with('.') || first == "Library"
                })
            });
        if private || SYSTEM_ROOTS.iter().any(|root| folder.starts_with(root)) {
            return Err("시스템·설정 폴더는 맡길 수 없습니다. 프로젝트 폴더를 선택하세요.".into());
        }
        let text = folder
            .to_str()
            .filter(|text| !text.chars().any(char::is_control));
        let text = text.ok_or("폴더 경로에 사용할 수 없는 문자가 있습니다.")?;
        let draft = Draft {
            kind,
            folder: text.to_string(),
            branch: branch(&folder),
            name: session_name(machine, kind, &folder),
        };
        self.inner().pending = Some(draft.clone());
        Ok(draft)
    }

    /// Starts the session the user confirmed. One confirmation starts at most one session.
    pub fn start(&self, kind: AgentKind, folder: &str) -> Result<Vec<AgentSession>, String> {
        let mut inner = self.inner();
        let draft = inner
            .pending
            .take()
            .filter(|draft| draft.kind == kind && draft.folder == folder)
            .ok_or("방금 선택하고 확인한 폴더만 실행할 수 있습니다. 폴더를 다시 선택하세요.")?;
        // The folder must still be the one that was shown, not something swapped in since.
        if Path::new(&draft.folder).canonicalize().ok().as_deref() != Some(Path::new(&draft.folder))
        {
            return Err("선택한 폴더가 바뀌었습니다. 폴더를 다시 선택하세요.".into());
        }
        let path = self.search_path();
        let cli = self
            .cli
            .clone()
            .or_else(|| {
                path.iter()
                    .map(|dir| dir.join("reason"))
                    .find(|file| file.is_file())
            })
            .filter(|file| file.is_file())
            .ok_or("Reason CLI를 찾지 못했습니다. Reason을 설치한 뒤 다시 시도하세요.")?;
        if !path.iter().any(|dir| dir.join(kind.command()).is_file()) {
            return Err(format!(
                "{} CLI를 찾지 못했습니다. 설치·로그인한 뒤 다시 시도하세요.",
                kind.label()
            ));
        }
        refresh(&mut inner.sessions);
        let running = |s: &&Owned| s.info.running;
        if inner
            .sessions
            .iter()
            .filter(running)
            .any(|s| s.info.kind == kind && s.info.folder == draft.folder)
        {
            return Err("이 폴더에는 같은 에이전트가 이미 실행 중입니다.".into());
        }
        if inner.sessions.len() >= MAX_SESSIONS {
            return Err(format!("개발 에이전트는 {MAX_SESSIONS}개까지 둘 수 있습니다. 끝난 세션을 닫거나 중지하세요."));
        }
        let child = spawn(&cli, &path, &draft)?;
        inner.sessions.push(Owned {
            info: AgentSession {
                id: uuid::Uuid::new_v4().to_string(),
                kind,
                name: draft.name,
                folder: draft.folder,
                branch: draft.branch,
                running: true,
                exit_code: None,
            },
            child,
        });
        Ok(inner.sessions.iter().map(|s| s.info.clone()).collect())
    }

    /// Process truth only: whether each session is still running, and its exit code.
    pub fn list(&self) -> Vec<AgentSession> {
        let mut inner = self.inner();
        refresh(&mut inner.sessions);
        inner.sessions.iter().map(|s| s.info.clone()).collect()
    }

    /// Stops a running session, or dismisses one that already exited.
    pub fn stop(&self, id: &str) -> Result<Vec<AgentSession>, String> {
        let session = {
            let mut inner = self.inner();
            let index = inner
                .sessions
                .iter()
                .position(|s| s.info.id == id)
                .ok_or("실행 기록에서 이 세션을 찾지 못했습니다.")?;
            inner.sessions.remove(index)
        };
        terminate(vec![session], STOP_GRACE);
        Ok(self.list())
    }

    pub fn shutdown(&self) {
        let sessions = std::mem::take(&mut self.inner().sessions);
        terminate(sessions, STOP_GRACE);
    }
}
impl Drop for ReasonAgents {
    fn drop(&mut self) {
        self.shutdown();
    }
}

/// An exited leader is deliberately left unreaped until the session is stopped
/// or dismissed: while it is a zombie its process-group ID cannot be reused, so
/// workers it left behind can still be signalled safely.
fn refresh(sessions: &mut [Owned]) {
    for session in sessions.iter_mut().filter(|s| s.info.running) {
        if let Some(code) = exit_state(&mut session.child) {
            session.info.running = false;
            session.info.exit_code = code;
        }
    }
}

/// `None` while running; `Some(code)` once exited (`None` code when killed by a signal).
#[cfg(unix)]
fn exit_state(child: &mut Child) -> Option<Option<i32>> {
    let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
    let flags = libc::WEXITED | libc::WNOHANG | libc::WNOWAIT;
    if unsafe { libc::waitid(libc::P_PID, child.id() as libc::id_t, &mut info, flags) } != 0 {
        return Some(None);
    }
    if unsafe { info.si_pid() } == 0 {
        return None;
    }
    Some((info.si_code == libc::CLD_EXITED).then(|| unsafe { info.si_status() }))
}
#[cfg(not(unix))]
fn exit_state(child: &mut Child) -> Option<Option<i32>> {
    child.try_wait().ok().flatten().map(|status| status.code())
}

#[cfg(unix)]
fn spawn(cli: &Path, path: &[PathBuf], draft: &Draft) -> Result<Child, String> {
    use std::os::unix::process::CommandExt;
    let mut command = Command::new(cli);
    command
        .args([
            "network",
            "serve",
            draft.kind.command(),
            "--name",
            &draft.name,
            "--cwd",
            &draft.folder,
        ])
        .args(["--non-interactive", "--no-color"])
        .current_dir(&draft.folder)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        // Own group: stopping reaches the workers serve starts, not only the wrapper.
        .process_group(0);
    // The agent keeps HOME and its login; only another agent's session markers are dropped.
    for key in crate::reason_network::AGENT_ENV {
        command.env_remove(key);
    }
    // Apps opened from Finder get a minimal PATH that lacks the agent CLIs.
    if let Ok(joined) = std::env::join_paths(path) {
        command.env("PATH", joined);
    }
    command.env("NO_COLOR", "1");
    command
        .spawn()
        .map_err(|_| "Reason 개발 에이전트를 시작하지 못했습니다.".into())
}
#[cfg(not(unix))]
fn spawn(_cli: &Path, _path: &[PathBuf], _draft: &Draft) -> Result<Child, String> {
    Err(
        "이 운영체제에서는 Studio에서 개발 에이전트를 실행할 수 없습니다. 터미널에서 실행하세요."
            .into(),
    )
}

#[cfg(unix)]
fn signal_group(child: &Child, signal: libc::c_int) {
    // The child leads its own process group, so its PID is the group ID.
    unsafe { libc::kill(-(child.id() as libc::pid_t), signal) };
}

/// TERM lets serve deregister from the network; KILL then clears whatever is
/// left in the group, including workers that outlived a crashed leader.
#[cfg(unix)]
fn terminate(mut sessions: Vec<Owned>, grace: Duration) {
    sessions
        .iter()
        .for_each(|s| signal_group(&s.child, libc::SIGTERM));
    let deadline = Instant::now() + grace;
    while sessions
        .iter_mut()
        .any(|s| exit_state(&mut s.child).is_none())
        && Instant::now() < deadline
    {
        std::thread::sleep(Duration::from_millis(25));
    }
    for session in &mut sessions {
        signal_group(&session.child, libc::SIGKILL);
        // Also kill the leader directly so reaping below can never block app exit.
        let _ = session.child.kill();
        let _ = session.child.wait();
    }
}
#[cfg(not(unix))]
fn terminate(mut sessions: Vec<Owned>, _grace: Duration) {
    for session in &mut sessions {
        let _ = session.child.kill();
        let _ = session.child.wait();
    }
}
