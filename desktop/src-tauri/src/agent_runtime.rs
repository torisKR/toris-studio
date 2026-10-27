//! Host for the bundled LangGraph agent runtime (Node, JSONL over stdio).
//! Rust owns the process, the OS-vault API keys and the only bridge to the UI.
//! The runtime never opens a network port; the UI never talks to it directly.
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    process::Stdio,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
    time::Duration,
};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, Command},
    sync::{oneshot, Mutex},
};

const KEY_SERVICE: &str = "kr.toris.studio.agent.v1";
pub const KEY_PROVIDERS: [&str; 4] = ["anthropic", "openai", "google", "openrouter"];
pub const CHROMA_URL: &str = "http://127.0.0.1:18765";
const READY_TIMEOUT: Duration = Duration::from_secs(20);
const MAX_LINE: usize = 4 * 1024 * 1024;
/// Methods the UI may call. Anything else (e.g. `configure`) is host-only.
pub const UI_METHODS: [&str; 14] = [
    "status",
    "models.list",
    "projects.list",
    "index.status",
    "index.build",
    "index.cancel",
    "search",
    "run.start",
    "run.resume",
    "run.cancel",
    "run.list",
    "run.get",
    "complete",
    "image",
];

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ModelChoice {
    pub provider: String,
    #[serde(default)]
    pub model: String,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentSettings {
    pub projects_root: String,
    pub ollama_url: String,
    pub agent_model: Option<ModelChoice>,
    pub content_model: Option<ModelChoice>,
    pub image: Option<ModelChoice>,
    pub embedding: ModelChoice,
}
impl Default for AgentSettings {
    fn default() -> Self {
        Self {
            projects_root: dirs::home_dir()
                .unwrap_or_default()
                .join("projects")
                .to_string_lossy()
                .into_owned(),
            ollama_url: "http://127.0.0.1:11434".into(),
            agent_model: None,
            content_model: None,
            image: None,
            embedding: ModelChoice {
                provider: "local".into(),
                model: String::new(),
            },
        }
    }
}

fn settings_path() -> PathBuf {
    crate::config::config_path()
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_default()
        .join("agent-settings.json")
}
pub fn load_settings() -> Result<AgentSettings, String> {
    match std::fs::read(settings_path()) {
        Ok(bytes) => serde_json::from_slice(&bytes)
            .map_err(|_| "Agent 설정 파일 형식이 올바르지 않습니다.".to_string()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(AgentSettings::default()),
        Err(_) => Err("Agent 설정을 읽지 못했습니다.".into()),
    }
}
pub fn validate_settings(settings: &AgentSettings) -> Result<(), String> {
    if !Path::new(&settings.projects_root).is_absolute() {
        return Err("프로젝트 폴더는 절대 경로여야 합니다.".into());
    }
    let url = url::Url::parse(&settings.ollama_url).map_err(|_| "Ollama 주소를 확인하세요.")?;
    if url.scheme() != "http" || !matches!(url.host_str(), Some("127.0.0.1" | "localhost")) {
        return Err("Ollama는 http://127.0.0.1 주소만 사용할 수 있습니다.".into());
    }
    for choice in [
        &settings.agent_model,
        &settings.content_model,
        &settings.image,
    ]
    .into_iter()
    .flatten()
    .chain(std::iter::once(&settings.embedding))
    {
        if choice.provider.len() > 40 || choice.model.len() > 200 || choice.model.contains('\n') {
            return Err("모델 설정을 확인하세요.".into());
        }
    }
    Ok(())
}
pub fn save_settings(settings: &AgentSettings) -> Result<(), String> {
    validate_settings(settings)?;
    crate::config::prepare_portable_data()?;
    let path = settings_path();
    let temp = path.with_extension("json.tmp");
    std::fs::write(
        &temp,
        serde_json::to_vec_pretty(settings).map_err(|e| e.to_string())?,
    )
    .map_err(|_| "Agent 설정 저장 실패")?;
    std::fs::rename(&temp, &path).map_err(|_| "Agent 설정 저장 실패".to_string())
}

fn key_account(provider: &str) -> Result<&'static str, String> {
    KEY_PROVIDERS
        .into_iter()
        .find(|p| *p == provider)
        .ok_or_else(|| "API 키 공급자를 확인하세요.".to_string())
}
pub fn read_key(provider: &str) -> Result<Option<String>, String> {
    let account = key_account(provider)?;
    // Agent keys are separate Keychain items, never entries in the shared app
    // envelope: older/newer app builds reject envelope slots they do not know.
    match keyring::Entry::new(KEY_SERVICE, account).and_then(|e| e.get_password()) {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(_) => Err(crate::vault::error()),
    }
}
pub fn write_key(provider: &str, value: Option<&str>) -> Result<(), String> {
    let account = key_account(provider)?;
    if let Some(value) = value {
        if value.len() > 1000 || value.chars().any(char::is_control) {
            return Err("API 키 형식을 확인하세요.".into());
        }
    }
    {
        let entry = keyring::Entry::new(KEY_SERVICE, account).map_err(|_| crate::vault::error())?;
        match value {
            Some(value) => entry.set_password(value).map_err(|_| crate::vault::error()),
            None => match entry.delete_credential() {
                Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
                Err(_) => Err(crate::vault::error()),
            },
        }
    }
}
/// What the UI may see: which providers have a key (never the key itself), and the
/// key-store error when it is locked, so the model settings still load without it.
pub fn settings_view(settings: &AgentSettings, keys: Result<HashMap<&'static str, String>, String>) -> Value {
    let (saved, key_store) = match keys {
        Ok(keys) => (KEY_PROVIDERS.iter().map(|p| (*p, keys.contains_key(p))).collect::<HashMap<_, _>>(), None),
        Err(error) => (KEY_PROVIDERS.iter().map(|p| (*p, false)).collect(), Some(error)),
    };
    json!({"settings": settings, "keys": saved, "chromaUrl": CHROMA_URL, "keyStore": key_store})
}
pub fn keys() -> Result<HashMap<&'static str, String>, String> {
    let mut out = HashMap::new();
    for provider in KEY_PROVIDERS {
        if let Some(value) = read_key(provider)?.filter(|v| !v.is_empty()) {
            out.insert(provider, value);
        }
    }
    Ok(out)
}

/// Directories searched for node and subscription CLIs (Finder/Explorer launches lack shell PATH).
pub fn search_path() -> Vec<PathBuf> {
    let home = dirs::home_dir().unwrap_or_default();
    let mut dirs = vec![
        home.join(".local/bin"),
        home.join(".npm-global/bin"),
        home.join(".volta/bin"),
        home.join(".bun/bin"),
        home.join(".cargo/bin"),
        PathBuf::from("/opt/homebrew/bin"),
        PathBuf::from("/usr/local/bin"),
    ];
    if let Some(appdata) = std::env::var_os("APPDATA") {
        dirs.push(PathBuf::from(appdata).join("npm"));
    }
    if let Some(path) = std::env::var_os("PATH") {
        dirs.extend(std::env::split_paths(&path));
    }
    dirs.into_iter().filter(|d| d.is_absolute()).collect()
}

fn exe_dir() -> Option<PathBuf> {
    std::env::current_exe()
        .ok()?
        .parent()
        .map(Path::to_path_buf)
}
pub fn bundle_path() -> Option<PathBuf> {
    let dir = exe_dir()?;
    let mut candidates = vec![
        dir.join("../Resources/agent-runtime/agent.mjs"),
        dir.join("agent-runtime/agent.mjs"),
    ];
    if cfg!(debug_assertions) {
        candidates.push(
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/agent-runtime/agent.mjs"),
        );
    }
    candidates.into_iter().find(|p| p.is_file())
}
/// Prefer the app's bundled Node (shipped for the Studio browser), then a user install.
pub fn node_path() -> Option<PathBuf> {
    let name = if cfg!(windows) { "node.exe" } else { "node" };
    let dir = exe_dir()?;
    let bundled = if cfg!(target_os = "macos") {
        dir.join("../Helpers/studio-browser").join(name)
    } else {
        dir.join("studio-browser").join(name)
    };
    std::iter::once(bundled)
        .chain(search_path().into_iter().map(|d| d.join(name)))
        .find(|p| p.is_file())
}

/// Waiters are tagged with the process generation they were sent to, so a
/// process that dies only fails its own requests, never its successor's.
type Pending = Arc<Mutex<HashMap<String, (u64, oneshot::Sender<Result<Value, String>>)>>>;
pub type Emitter = Arc<dyn Fn(Value) + Send + Sync>;

struct Process {
    child: Child,
    stdin: ChildStdin,
}

type ConfigSource = Box<dyn Fn() -> Result<Value, String> + Send + Sync>;

pub struct AgentRuntime {
    /// Test hook: program and args to launch instead of the bundled Node runtime.
    launcher: Option<(PathBuf, Vec<String>)>,
    config: ConfigSource,
    starting: Mutex<()>,
    process: Mutex<Option<Process>>,
    pending: Pending,
    next_id: AtomicU64,
    generation: AtomicU64,
    emitter: std::sync::RwLock<Option<Emitter>>,
}
impl Default for AgentRuntime {
    fn default() -> Self {
        Self {
            launcher: None,
            config: Box::new(|| runtime_config(&load_settings()?)),
            starting: Mutex::new(()),
            process: Mutex::new(None),
            pending: Arc::new(Mutex::new(HashMap::new())),
            next_id: AtomicU64::new(1),
            generation: AtomicU64::new(0),
            emitter: std::sync::RwLock::new(None),
        }
    }
}
pub fn shared() -> Arc<AgentRuntime> {
    Arc::new(AgentRuntime::default())
}

/// Generated image formats accepted into the asset library, by magic bytes.
pub fn image_extension(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("png")
    } else if bytes.starts_with(&[255, 216, 255]) {
        Some("jpeg")
    } else if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP") {
        Some("webp")
    } else {
        None
    }
}

/// Full configuration including secrets; sent only over the child's stdin.
pub fn runtime_config(settings: &AgentSettings) -> Result<Value, String> {
    Ok(runtime_config_from(settings, keys()))
}
/// A locked key store must not block CLI models: API models then report a missing key.
pub fn runtime_config_from(settings: &AgentSettings, keys: Result<HashMap<&'static str, String>, String>) -> Value {
    runtime_config_with(settings, &keys.unwrap_or_default())
}
pub fn runtime_config_with(
    settings: &AgentSettings,
    keys: &HashMap<&'static str, String>,
) -> Value {
    let image = settings.image.as_ref().filter(|c| !c.provider.is_empty());
    json!({
        "projectsRoot": settings.projects_root,
        "chromaUrl": CHROMA_URL,
        "searchPath": search_path(),
        "keys": keys,
        "ollamaUrl": settings.ollama_url,
        "agentModel": settings.agent_model.as_ref().filter(|c| !c.provider.is_empty()),
        "contentModel": settings.content_model.as_ref().filter(|c| !c.provider.is_empty()),
        "image": image,
        "embedding": settings.embedding,
    })
}

impl AgentRuntime {
    pub fn with_launcher(program: PathBuf, args: Vec<String>, config: ConfigSource) -> Self {
        Self {
            launcher: Some((program, args)),
            config,
            ..Self::default()
        }
    }
    pub fn set_emitter(&self, emitter: Emitter) {
        if let Ok(mut slot) = self.emitter.write() {
            *slot = Some(emitter);
        }
    }
    fn emit(&self, value: Value) {
        if let Some(emitter) = self.emitter.read().ok().and_then(|e| e.clone()) {
            emitter(value);
        }
    }

    pub async fn running(&self) -> bool {
        let mut guard = self.process.lock().await;
        match guard.as_mut() {
            Some(p) => matches!(p.child.try_wait(), Ok(None)),
            None => false,
        }
    }

    async fn spawn(self: &Arc<Self>) -> Result<(), String> {
        let (program, args) = match &self.launcher {
            Some((program, args)) => (program.clone(), args.clone()),
            None => {
                let node =
                    node_path().ok_or("Node.js를 찾을 수 없습니다. Node 22 이상을 설치하세요.")?;
                let bundle = bundle_path().ok_or("에이전트 런타임 파일이 없습니다. `pnpm agent:build`를 실행하거나 앱을 다시 설치하세요.")?;
                (
                    node,
                    vec![
                        "--disable-warning=ExperimentalWarning".into(),
                        bundle.to_string_lossy().into_owned(),
                    ],
                )
            }
        };
        let mut command = Command::new(&program);
        command
            .args(&args)
            .env_clear()
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        for key in [
            "HOME",
            "USER",
            "LOGNAME",
            "LANG",
            "LC_ALL",
            "TMPDIR",
            "TMP",
            "TEMP",
            "SYSTEMROOT",
            "WINDIR",
            "USERPROFILE",
            "LOCALAPPDATA",
            "APPDATA",
            "PATHEXT",
            "CARGO_HOME",
            "RUSTUP_HOME",
        ] {
            if let Some(value) = std::env::var_os(key) {
                command.env(key, value);
            }
        }
        command.env(
            "PATH",
            std::env::join_paths(search_path()).unwrap_or_default(),
        );
        #[cfg(windows)]
        command.creation_flags(0x0800_0000);
        let mut child = command
            .spawn()
            .map_err(|_| "에이전트 런타임을 시작하지 못했습니다.")?;
        let stdin = child.stdin.take().ok_or("런타임 입력 연결 실패")?;
        let stdout = child.stdout.take().ok_or("런타임 출력 연결 실패")?;
        let (ready_tx, ready_rx) = oneshot::channel::<()>();
        let generation = self.generation.fetch_add(1, Ordering::Relaxed) + 1;
        let this = Arc::clone(self);
        tokio::spawn(async move {
            let mut ready = Some(ready_tx);
            let mut lines = BufReader::with_capacity(64 * 1024, stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                if line.len() > MAX_LINE {
                    continue;
                }
                let Ok(value) = serde_json::from_str::<Value>(&line) else {
                    continue;
                };
                if let Some(id) = value["id"].as_str() {
                    if let Some((_, tx)) = this.pending.lock().await.remove(id) {
                        let result = if value["ok"] == true {
                            Ok(value["result"].clone())
                        } else {
                            Err(value["error"]
                                .as_str()
                                .unwrap_or("에이전트 요청 실패")
                                .to_string())
                        };
                        let _ = tx.send(result);
                    }
                } else if value["event"] == "ready" {
                    if let Some(tx) = ready.take() {
                        let _ = tx.send(());
                    }
                } else if value["event"].is_string() {
                    this.emit(value);
                }
            }
            // Process ended: fail its waiters instead of hanging the UI.
            let mut pending = this.pending.lock().await;
            let ours: Vec<String> = pending
                .iter()
                .filter(|(_, (owner, _))| *owner == generation)
                .map(|(id, _)| id.clone())
                .collect();
            for id in ours {
                if let Some((_, tx)) = pending.remove(&id) {
                    let _ = tx.send(Err(
                        "에이전트 런타임이 종료되었습니다. 다시 시도하세요.".into()
                    ));
                }
            }
            drop(pending);
            this.emit(json!({"event":"runtime","state":"stopped"}));
        });
        tokio::time::timeout(READY_TIMEOUT, ready_rx)
            .await
            .map_err(|_| "에이전트 런타임 시작 시간이 초과되었습니다.")?
            .map_err(|_| "에이전트 런타임이 바로 종료되었습니다. Node 버전을 확인하세요.")?;
        *self.process.lock().await = Some(Process { child, stdin });
        let config = (self.config)()?;
        self.send("configure", config, Duration::from_secs(10))
            .await?;
        self.emit(json!({"event":"runtime","state":"running"}));
        Ok(())
    }

    async fn ensure(self: &Arc<Self>) -> Result<(), String> {
        let _starting = self.starting.lock().await;
        if !self.running().await {
            *self.process.lock().await = None;
            self.spawn().await?;
        }
        Ok(())
    }

    async fn send(&self, method: &str, params: Value, timeout: Duration) -> Result<Value, String> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed).to_string();
        let mut line = serde_json::to_vec(&json!({"id":id,"method":method,"params":params}))
            .map_err(|e| e.to_string())?;
        line.push(b'\n');
        let (tx, rx) = oneshot::channel();
        {
            let mut guard = self.process.lock().await;
            let process = guard
                .as_mut()
                .ok_or("에이전트 런타임이 실행 중이 아닙니다.")?;
            // Registered under the process lock, so the generation is the one we write to.
            let generation = self.generation.load(Ordering::Relaxed);
            self.pending
                .lock()
                .await
                .insert(id.clone(), (generation, tx));
            if process.stdin.write_all(&line).await.is_err() || process.stdin.flush().await.is_err()
            {
                self.pending.lock().await.remove(&id);
                return Err("에이전트 런타임에 요청을 보내지 못했습니다.".into());
            }
        }
        match tokio::time::timeout(timeout, rx).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err("에이전트 응답이 끊겼습니다.".into()),
            Err(_) => {
                self.pending.lock().await.remove(&id);
                Err("에이전트 응답 시간이 초과되었습니다.".into())
            }
        }
    }

    pub async fn call(self: &Arc<Self>, method: &str, params: Value) -> Result<Value, String> {
        if !UI_METHODS.contains(&method) {
            return Err("허용되지 않은 에이전트 요청입니다.".into());
        }
        self.ensure().await?;
        let timeout = match method {
            "complete" | "image" => Duration::from_secs(420),
            "search" | "models.list" | "status" => Duration::from_secs(90),
            _ => Duration::from_secs(60),
        };
        self.send(method, params, timeout).await
    }

    /// Push new settings/keys to a running runtime; a stopped one reads them on start.
    pub async fn reconfigure(self: &Arc<Self>) -> Result<(), String> {
        if self.running().await {
            let config = (self.config)()?;
            self.send("configure", config, Duration::from_secs(10))
                .await?;
        }
        Ok(())
    }

    pub async fn restart(self: &Arc<Self>) -> Result<(), String> {
        let _starting = self.starting.lock().await;
        self.stop().await;
        self.spawn().await
    }

    pub async fn stop(&self) {
        let process = self.process.lock().await.take();
        if let Some(mut process) = process {
            let _ = process
                .stdin
                .write_all(b"{\"id\":\"stop\",\"method\":\"shutdown\"}\n")
                .await;
            if tokio::time::timeout(Duration::from_secs(3), process.child.wait())
                .await
                .is_err()
            {
                let _ = process.child.kill().await;
            }
        }
    }

    /// Synchronous best effort for app exit.
    pub fn shutdown(&self) {
        if let Ok(mut guard) = self.process.try_lock() {
            if let Some(mut process) = guard.take() {
                let _ = process.child.start_kill();
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn settings_view_survives_a_locked_key_store() {
        let settings = AgentSettings::default();
        let view = settings_view(&settings, Err("저장소 보류".into()));
        assert_eq!(view["keyStore"], "저장소 보류");
        assert_eq!(view["keys"]["anthropic"], false);
        assert_eq!(view["settings"]["projectsRoot"], json!(settings.projects_root));
        let mut saved = HashMap::new();
        saved.insert("openai", "sk-secret".to_string());
        let view = settings_view(&settings, Ok(saved));
        assert!(view["keyStore"].is_null());
        assert_eq!(view["keys"]["openai"], true);
        assert_eq!(view["keys"]["anthropic"], false);
        assert!(!view.to_string().contains("sk-secret"), "key values never reach the UI");
    }
    #[test]
    fn settings_reject_relative_roots_and_remote_ollama() {
        let mut settings = AgentSettings::default();
        assert!(validate_settings(&settings).is_ok());
        settings.projects_root = "projects".into();
        assert!(validate_settings(&settings).is_err());
        settings = AgentSettings::default();
        settings.ollama_url = "http://10.0.0.5:11434".into();
        assert!(validate_settings(&settings).is_err());
    }
    #[test]
    fn host_only_methods_are_not_callable_from_the_ui() {
        assert!(!UI_METHODS.contains(&"configure"));
        assert!(!UI_METHODS.contains(&"shutdown"));
        assert!(key_account("aws").is_err());
    }

    #[test]
    fn generated_images_are_identified_by_magic_bytes_only() {
        assert_eq!(image_extension(b"\x89PNG\r\n\x1a\nrest"), Some("png"));
        assert_eq!(image_extension(&[255, 216, 255, 0]), Some("jpeg"));
        assert_eq!(image_extension(b"RIFF\0\0\0\0WEBPVP8 "), Some("webp"));
        assert_eq!(image_extension(b"<svg onload=alert(1)>"), None);
        assert_eq!(image_extension(b"RIFF\0\0\0\0WAVE"), None);
    }

    #[test]
    fn runtime_config_carries_keys_but_drops_unselected_models() {
        let mut settings = AgentSettings::default();
        settings.agent_model = Some(ModelChoice {
            provider: "codex-cli".into(),
            model: String::new(),
        });
        settings.content_model = Some(ModelChoice {
            provider: String::new(),
            model: "x".into(),
        });
        let keys = HashMap::from([("openai", "sk-test".to_string())]);
        let config = runtime_config_with(&settings, &keys);
        assert_eq!(config["agentModel"]["provider"], "codex-cli");
        assert!(config["contentModel"].is_null());
        assert!(config["image"].is_null());
        assert_eq!(config["keys"]["openai"], "sk-test");
        assert_eq!(config["chromaUrl"], CHROMA_URL);
    }

    #[test]
    fn a_locked_key_store_still_configures_cli_models() {
        let mut settings = AgentSettings::default();
        settings.agent_model = Some(ModelChoice { provider: "codex-cli".into(), model: String::new() });
        let config = runtime_config_from(&settings, Err("저장소 보류".into()));
        assert_eq!(config["agentModel"]["provider"], "codex-cli");
        assert_eq!(config["keys"], json!({}));
    }

    fn fake_runtime(script: &str) -> Arc<AgentRuntime> {
        Arc::new(AgentRuntime::with_launcher(
            node_path().expect("node for host tests"),
            vec!["-e".into(), script.into()],
            Box::new(|| Ok(json!({"fake": true}))),
        ))
    }
    const ECHO: &str = r#"const rl=require('node:readline').createInterface({input:process.stdin});
console.log(JSON.stringify({event:'ready',version:'t'}));
rl.on('line',l=>{const m=JSON.parse(l);
 if(m.method==='configure'){console.log(JSON.stringify({id:m.id,ok:true,result:{configured:m.params.fake}}));return;}
 if(m.method==='status'){console.log(JSON.stringify({event:'run',runId:'r',seq:1}));console.log(JSON.stringify({id:m.id,ok:true,result:{echo:m.params}}));return;}
 if(m.method==='search'){console.log(JSON.stringify({id:m.id,ok:false,error:'검색 실패'}));return;}
 if(m.method==='run.list'){process.exit(0);}
});"#;

    #[tokio::test]
    async fn host_round_trips_requests_forwards_events_and_refuses_host_only_methods() {
        let runtime = fake_runtime(ECHO);
        let events = Arc::new(std::sync::Mutex::new(Vec::<Value>::new()));
        let sink = events.clone();
        runtime.set_emitter(Arc::new(move |event| sink.lock().unwrap().push(event)));
        assert_eq!(
            runtime.call("status", json!({"a":1})).await.unwrap(),
            json!({"echo":{"a":1}})
        );
        assert_eq!(
            runtime.call("search", json!({})).await.unwrap_err(),
            "검색 실패"
        );
        assert!(runtime.call("configure", json!({})).await.is_err());
        assert!(events.lock().unwrap().iter().any(|e| e["event"] == "run"));
        // A runtime that dies mid-request fails the waiter instead of hanging the UI.
        let error = runtime.call("run.list", json!({})).await.unwrap_err();
        assert!(error.contains("종료"), "{error}");
        runtime.stop().await;
    }

    #[tokio::test]
    async fn a_request_with_no_running_process_leaves_no_waiter_behind() {
        let runtime = fake_runtime(ECHO);
        assert!(runtime
            .send("status", json!({}), Duration::from_secs(1))
            .await
            .is_err());
        assert!(runtime.pending.lock().await.is_empty());
    }

    #[tokio::test]
    async fn a_dead_process_only_fails_its_own_waiters() {
        let runtime = fake_runtime(ECHO);
        runtime.call("status", json!({})).await.unwrap();
        let generation = runtime.generation.load(Ordering::Relaxed);
        // A waiter that belongs to the next process (e.g. its `configure`).
        let (tx, mut rx) = oneshot::channel();
        runtime
            .pending
            .lock()
            .await
            .insert("next".into(), (generation + 1, tx));
        assert!(runtime.call("run.list", json!({})).await.is_err());
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert!(runtime.pending.lock().await.contains_key("next"));
        assert!(rx.try_recv().is_err(), "the new waiter was not failed");
        runtime.stop().await;
    }
}
