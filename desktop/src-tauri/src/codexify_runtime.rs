//! Bundled Codexify lifecycle. Native Codexify services are observed, never changed.
//! Only this controller's child is stoppable; an existing healthy bridge is reused.
use fs2::FileExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    fs,
    io::Read,
    path::{Path, PathBuf},
    process::Stdio,
    sync::{Arc, Mutex as StdMutex},
    time::Duration,
};
use tokio::{
    io::AsyncReadExt,
    process::{Child, Command},
    sync::Mutex,
};

const MAX_CONFIG: u64 = 2 * 1024 * 1024;
const MAX_COMMAND: usize = 256 * 1024;
const COMMAND_TIMEOUT: Duration = Duration::from_secs(15);
const HEALTH_TIMEOUT: Duration = Duration::from_secs(2);
const DEFAULT_PORT: u16 = 21228;
const STUDIO_TOOLS: [&str; 9] = [
    "studio_connection_check",
    "studio_asset_presets",
    "studio_asset_list",
    "studio_asset_request",
    "studio_asset_receive",
    "studio_asset_resize",
    "studio_asset_create_3d",
    "studio_asset_review",
    "studio_asset_job_status",
];

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceStatus {
    pub installed: bool,
    pub running: bool,
    pub enabled: Option<bool>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeStatus {
    pub binary_available: bool,
    pub bundled: bool,
    pub version: Option<String>,
    pub config_path: String,
    pub source_root: String,
    pub port: u16,
    pub running: bool,
    pub managed: bool,
    pub pid: Option<u32>,
    pub service: Option<ServiceStatus>,
    pub message: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConfigureInput {
    pub source_root: String,
    pub port: u16,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DoctorCheck {
    pub id: String,
    pub status: String,
    pub label: String,
    pub message: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DoctorReport {
    pub checks: Vec<DoctorCheck>,
    pub failures: usize,
    pub bridge_healthy: bool,
    pub message: String,
}

struct Settings {
    path: PathBuf,
    source: PathBuf,
    port: u16,
    document: Value,
}
struct ManagedChild {
    child: Child,
    config: PathBuf,
    source: PathBuf,
    port: u16,
}
#[derive(Default)]
struct Inner {
    child: Option<ManagedChild>,
    version: Option<String>,
    version_checked: bool,
}

pub struct RuntimeController {
    home: PathBuf,
    binary: PathBuf,
    bundled: bool,
    studio_exe: PathBuf,
    isolated: bool,
    inner: StdMutex<Inner>,
    mutation: Mutex<()>,
}

pub fn shared() -> Arc<RuntimeController> {
    Arc::new(RuntimeController::new())
}

impl Default for RuntimeController {
    fn default() -> Self {
        Self::new()
    }
}
impl RuntimeController {
    pub fn new() -> Self {
        let home = dirs::home_dir().unwrap_or_default();
        let studio_exe = std::env::current_exe().unwrap_or_default();
        let name = if cfg!(windows) {
            "codexify.exe"
        } else {
            "codexify"
        };
        let bundled_path = studio_exe.parent().unwrap_or(Path::new("")).join(name);
        let bundled = regular_file(&bundled_path);
        let binary = if bundled {
            bundled_path
        } else if cfg!(debug_assertions) {
            home.join(".codexify/bin").join(name)
        } else {
            bundled_path
        };
        let bundled_version = if bundled {
            serde_json::from_str::<Value>(include_str!("../resources/codexify/manifest.json"))
                .ok()
                .and_then(|manifest| safe_version(&manifest))
        } else {
            None
        };
        let version_checked = bundled_version.is_some();
        Self {
            home,
            binary,
            bundled,
            studio_exe,
            isolated: false,
            inner: StdMutex::new(Inner {
                version: bundled_version,
                version_checked,
                child: None,
            }),
            mutation: Mutex::new(()),
        }
    }

    fn settings(&self) -> Result<Settings, String> {
        let directory = self.home.join(".codexify");
        safe_parent(&directory)?;
        let preferred = directory.join("codexify.external.json");
        let path =
            match fs::symlink_metadata(&preferred) {
                Ok(_) => preferred,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    directory.join("toris-studio.json")
                }
                Err(_) => return Err(
                    "기존 Codexify 설정 파일에 접근하지 못했습니다. 사용자 폴더 권한을 확인하세요."
                        .into(),
                ),
            };
        let new_document =
            match fs::symlink_metadata(&path) {
                Ok(_) => false,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => true,
                Err(_) => return Err(
                    "Codexify 앱 설정 파일에 접근하지 못했습니다. 사용자 폴더 권한을 확인하세요."
                        .into(),
                ),
            };
        let document = if !new_document {
            read_document(&path)?
        } else {
            default_document(&self.home.join("projects"), &self.studio_exe)
        };
        let source = document
            .get("workDir")
            .and_then(Value::as_str)
            .map(PathBuf::from)
            .unwrap_or_else(|| self.home.join("projects"));
        // A first install may have no ~/projects yet. Status remains read-only and
        // lets the user choose an existing folder; explicit Start creates this default.
        let source = if new_document && source == self.home.join("projects") && !source.exists() {
            source
        } else {
            validate_source(&source)?
        };
        let port = match document.get("port") {
            None | Some(Value::Null) => DEFAULT_PORT,
            Some(value) => value
                .as_u64()
                .and_then(|v| u16::try_from(v).ok())
                .filter(|v| *v > 0)
                .ok_or("Codexify 포트 설정을 확인하세요.")?,
        };
        validate_port(&document, port)?;
        Ok(Settings {
            path,
            source,
            port,
            document,
        })
    }

    async fn child_snapshot(&self) -> Result<(bool, Option<u32>), String> {
        let mut inner = self
            .inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(managed) = inner.child.as_mut() {
            match managed
                .child
                .try_wait()
                .map_err(|_| "Codexify 실행 상태를 확인하지 못했습니다.")?
            {
                Some(_) => {
                    inner.child = None;
                }
                None => return Ok((true, managed.child.id())),
            }
        }
        Ok((false, None))
    }

    fn owned_matches(&self, settings: &Settings, source: &Path, port: u16) -> bool {
        self.inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .child
            .as_ref()
            .is_none_or(|owned| {
                owned.config == settings.path && owned.source == source && owned.port == port
            })
    }

    async fn observe(&self, settings: &Settings) -> Result<RuntimeStatus, String> {
        let (managed, pid) = self.child_snapshot().await?;
        let binary_available = regular_file(&self.binary);
        let (running, service) = tokio::join!(healthy(settings.port), self.service_status());
        let should_probe_version = {
            let mut inner = self
                .inner
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if binary_available && !inner.version_checked {
                inner.version_checked = true;
                true
            } else {
                false
            }
        };
        if should_probe_version {
            if let Ok(document) = self
                .command_json(&[
                    "--config",
                    &settings.path.to_string_lossy(),
                    "--port",
                    &settings.port.to_string(),
                    "doctor",
                    "--json",
                ])
                .await
            {
                self.inner
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .version = safe_version(&document);
            }
        }
        let version = self
            .inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .version
            .clone();
        let message = if !binary_available {
            "앱에 포함된 Codexify 실행 파일을 찾지 못했습니다. 최신 설치 파일로 다시 설치하세요."
        } else if managed && running {
            "앱에서 Codexify를 실행 중입니다. 앱을 종료하면 이 연결도 종료됩니다."
        } else if managed {
            "앱에서 실행한 Codexify가 연결을 준비 중입니다."
        } else if running {
            "기존 Codexify 연결을 사용 중입니다. 앱의 중지 버튼은 기존 프로세스를 종료하지 않습니다."
        } else {
            "Codexify가 중지되어 있습니다. 시작하면 이 앱이 로컬 연결을 실행합니다."
        };
        Ok(RuntimeStatus {
            binary_available,
            bundled: self.bundled,
            version,
            config_path: settings.path.to_string_lossy().into_owned(),
            source_root: settings.source.to_string_lossy().into_owned(),
            port: settings.port,
            running,
            managed,
            pid,
            service,
            message: message.into(),
        })
    }

    pub async fn status(&self) -> Result<RuntimeStatus, String> {
        self.observe(&self.settings()?).await
    }

    pub async fn configure(&self, input: ConfigureInput) -> Result<RuntimeStatus, String> {
        let _mutation = self.mutation.lock().await;
        let mut settings = self.settings()?;
        let source = expand_source(input.source_root.trim(), &self.home)?;
        let source = validate_source(&source)?;
        validate_port(&settings.document, input.port)?;
        let changed = settings.source != source || settings.port != input.port;
        let (managed, _) = self.child_snapshot().await?;
        if !self.owned_matches(&settings, &source, input.port)
            || (changed && (managed || healthy(settings.port).await))
        {
            return Err("Codexify가 실행 중입니다. 현재 연결을 종료한 뒤 Source와 포트를 변경하세요. 기존 외부 연결은 이 앱에서 종료하지 않습니다.".into());
        }
        // Do not steal a newly selected port from any process, healthy or otherwise.
        if changed && settings.port != input.port && occupied(input.port).await {
            return Err("선택한 포트가 사용 중입니다. 다른 포트를 선택하세요.".into());
        }
        let lock = config_lock(&settings.path)?;
        let mut document = if settings.path.exists() {
            read_document(&settings.path)?
        } else {
            settings.document.clone()
        };
        // Recheck under the file lock; a cooperating writer must not overwrite our merge.
        validate_port(&document, input.port)?;
        let object = document
            .as_object_mut()
            .ok_or("Codexify 설정 형식을 확인하세요.")?;
        object.insert(
            "workDir".into(),
            Value::String(source.to_string_lossy().into_owned()),
        );
        object.insert("port".into(), json!(input.port));
        write_document(&settings.path, &document)?;
        drop(lock);
        settings.document = document;
        settings.source = source;
        settings.port = input.port;
        self.observe(&settings).await
    }

    pub async fn start(&self) -> Result<RuntimeStatus, String> {
        let _mutation = self.mutation.lock().await;
        let settings = self.settings()?;
        let (managed, _) = self.child_snapshot().await?;
        if !self.owned_matches(&settings, &settings.source, settings.port) {
            return Err("실행 중인 Codexify의 설정 파일이 변경되었습니다. 앱에서 중지한 뒤 다시 시작하세요.".into());
        }
        if managed || healthy(settings.port).await {
            return self.observe(&settings).await;
        }
        if !regular_file(&self.binary) {
            return Err("앱에 포함된 Codexify 실행 파일을 찾지 못했습니다.".into());
        }
        if occupied(settings.port).await {
            return Err("Codexify 포트를 다른 프로세스가 사용 중입니다. 기존 프로세스를 확인하거나 포트를 변경하세요.".into());
        }
        if let Some(owner_port) = owner_port(&settings.document) {
            if occupied(owner_port).await {
                return Err(
                    "대화 연결 포트가 사용 중입니다. 기존 Codexify 연결을 확인하세요.".into(),
                );
            }
        }
        if !settings.path.exists()
            && settings.source == self.home.join("projects")
            && !settings.source.exists()
        {
            safe_parent(&self.home)?;
            fs::create_dir(&settings.source).map_err(|_| {
                "기본 projects 폴더를 만들지 못했습니다. 기존 프로젝트 폴더를 선택하세요."
            })?;
            validate_source(&settings.source)?;
        }
        if !settings.path.exists() {
            let lock = config_lock(&settings.path)?;
            if !settings.path.exists() {
                write_document(&settings.path, &settings.document)?;
            }
            drop(lock);
        }
        let mut command = self.command();
        command
            .arg("--config")
            .arg(&settings.path)
            .arg("--port")
            .arg(settings.port.to_string())
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        let child = command
            .spawn()
            .map_err(|_| "Codexify를 시작하지 못했습니다. 설치 파일을 확인하세요.")?;
        self.inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .child = Some(ManagedChild {
            child,
            config: settings.path.clone(),
            source: settings.source.clone(),
            port: settings.port,
        });
        for attempt in 0..18 {
            if healthy(settings.port).await {
                return self.observe(&settings).await;
            }
            if !self.child_snapshot().await?.0 {
                return Err(
                    "Codexify가 시작 중 종료되었습니다. 설정과 포트 충돌을 확인하세요.".into(),
                );
            }
            tokio::time::sleep(Duration::from_millis(150 + attempt * 25)).await;
        }
        self.observe(&settings).await
    }

    pub async fn stop(&self) -> Result<RuntimeStatus, String> {
        let _mutation = self.mutation.lock().await;
        self.child_snapshot().await?;
        let child = self
            .inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .child
            .take();
        if let Some(mut managed) = child {
            managed
                .child
                .start_kill()
                .map_err(|_| "앱에서 실행한 Codexify를 종료하지 못했습니다.")?;
            let _ = tokio::time::timeout(Duration::from_secs(5), managed.child.wait()).await;
        }
        self.status().await
    }

    /// Only the owned child is killed. Other Codexify services and tunnels survive app exit.
    pub fn shutdown(&self) {
        let mut inner = self
            .inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(mut managed) = inner.child.take() {
            let _ = managed.child.start_kill();
        }
    }

    async fn service_status(&self) -> Option<ServiceStatus> {
        if !regular_file(&self.binary) {
            return None;
        }
        let json = self
            .command_json(&["service", "status", "--json"])
            .await
            .ok()?;
        Some(ServiceStatus {
            installed: json.get("installed")?.as_bool()?,
            running: json.get("running")?.as_bool()?,
            enabled: json.get("enabled").and_then(Value::as_bool),
        })
    }

    async fn command_json(&self, arguments: &[&str]) -> Result<Value, String> {
        let mut command = self.command();
        command.args(arguments);
        bounded_json_command(command, COMMAND_TIMEOUT, MAX_COMMAND).await
    }

    fn command(&self) -> Command {
        let mut command = fixed_command(&self.binary);
        if self.isolated {
            command.env("HOME", &self.home);
        }
        command
    }

    pub async fn doctor(&self) -> Result<DoctorReport, String> {
        let settings = self.settings()?;
        let bridge_healthy = healthy(settings.port).await;
        let mut checks = vec![
            check(
                "runtime",
                if regular_file(&self.binary) {
                    "pass"
                } else {
                    "failure"
                },
                "Codexify 실행 파일",
                if regular_file(&self.binary) {
                    "고정된 로컬 실행 파일을 사용할 수 있습니다."
                } else {
                    "실행 파일이 없습니다. 최신 앱 설치 파일을 확인하세요."
                },
            ),
            check(
                "selected_bridge",
                if bridge_healthy { "pass" } else { "failure" },
                "앱에서 선택한 연결",
                if bridge_healthy {
                    "선택한 포트의 Codexify가 정상 응답합니다."
                } else {
                    "선택한 연결이 응답하지 않습니다. 앱에서 시작하거나 기존 연결을 확인하세요."
                },
            ),
        ];
        if regular_file(&self.binary) {
            match self
                .command_json(&[
                    "--config",
                    &settings.path.to_string_lossy(),
                    "--port",
                    &settings.port.to_string(),
                    "doctor",
                    "--json",
                ])
                .await
            {
                Ok(document) => {
                    self.inner
                        .lock()
                        .unwrap_or_else(|poisoned| poisoned.into_inner())
                        .version = safe_version(&document);
                    checks.extend(sanitized_checks(&document, bridge_healthy));
                }
                Err(_) => checks.push(check(
                    "cli_diagnostics",
                    "failure",
                    "Codexify 진단",
                    "진단을 완료하지 못했습니다. 설정 파일이나 실행 파일을 확인하세요.",
                )),
            }
        }
        let failures = checks.iter().filter(|v| v.status == "failure").count();
        Ok(DoctorReport {
            checks,
            failures,
            bridge_healthy,
            message: if failures == 0 {
                "선택한 연결이 정상입니다. OS 백그라운드 서비스는 별도로 표시합니다."
            } else {
                "진단 결과를 확인하세요. 다른 Codexify 서비스는 변경하지 않았습니다."
            }
            .into(),
        })
    }
}

/// CLI-only integration probe. Its paths/ports are generated internally and never accepted by IPC.
/// No current bridge, native service, tunnel, or real user configuration is modified.
pub async fn isolated_check() -> Result<Value, String> {
    let temporary = tempfile::tempdir().map_err(|_| "격리 테스트 폴더를 만들지 못했습니다.")?;
    let isolated_home = fs::canonicalize(temporary.path())
        .map_err(|_| "격리 테스트 폴더를 확인하지 못했습니다.")?;
    fs::create_dir(isolated_home.join("projects"))
        .map_err(|_| "격리 Source를 만들지 못했습니다.")?;
    let mut runtime = RuntimeController::new();
    runtime.home = isolated_home.clone();
    runtime.isolated = true;
    let bind_port = || -> Result<u16, String> {
        std::net::TcpListener::bind(("127.0.0.1", 0))
            .and_then(|listener| listener.local_addr())
            .map(|address| address.port())
            .map_err(|_| "격리 테스트 포트를 확보하지 못했습니다.".into())
    };
    let port = bind_port()?;
    let owner = loop {
        let candidate = bind_port()?;
        if candidate != port {
            break candidate;
        }
    };
    let path = isolated_home.join(".codexify/toris-studio.json");
    let mut document = default_document(&isolated_home.join("projects"), &runtime.studio_exe);
    document["port"] = json!(port);
    document["agentChat"]["port"] = json!(owner);
    document["mcpServers"] = json!({});
    let lock = config_lock(&path)?;
    write_document(&path, &document)?;
    drop(lock);
    let started = runtime.start().await?;
    let pid = started.pid;
    let stopped = runtime.stop().await?;
    Ok(
        json!({"isolated":true,"binaryAvailable":started.binary_available,"version":started.version,
        "startHealthy":started.running,"startManaged":started.managed,"ownedPidCreated":pid.is_some(),
        "stopHealthy":stopped.running,"stopManaged":stopped.managed,"unchangedUserConfig":true}),
    )
}

fn fixed_command(binary: &Path) -> Command {
    let mut command = Command::new(binary);
    #[cfg(windows)]
    {
        command.creation_flags(0x08000000);
    }
    command
        .env("NO_COLOR", "1")
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .stdout(Stdio::piped())
        .kill_on_drop(true);
    command
}

async fn bounded_json_command(
    mut command: Command,
    timeout: Duration,
    limit: usize,
) -> Result<Value, String> {
    let mut child = command
        .spawn()
        .map_err(|_| "Codexify 진단을 실행하지 못했습니다.")?;
    let output = child
        .stdout
        .take()
        .ok_or("Codexify 진단 출력을 읽지 못했습니다.")?;
    let operation = async {
        let mut bytes = Vec::new();
        output
            .take(limit as u64 + 1)
            .read_to_end(&mut bytes)
            .await
            .map_err(|_| "Codexify 진단 출력을 읽지 못했습니다.")?;
        if bytes.len() > limit {
            return Err("Codexify 진단 출력이 허용 크기를 초과했습니다.".to_owned());
        }
        let status = child
            .wait()
            .await
            .map_err(|_| "Codexify 진단을 완료하지 못했습니다.")?;
        // Doctor failures and installed/stopped service states still carry valid JSON.
        if !matches!(status.code(), Some(0 | 1 | 3 | 4)) {
            return Err("Codexify 진단이 비정상적으로 종료되었습니다.".into());
        }
        serde_json::from_slice(&bytes).map_err(|_| "Codexify 진단 형식이 올바르지 않습니다.".into())
    };
    let result = tokio::time::timeout(timeout, operation)
        .await
        .map_err(|_| "Codexify 진단 시간이 초과되었습니다.")?;
    if result.is_err() {
        let _ = child.start_kill();
    }
    result
}

fn safe_version(document: &Value) -> Option<String> {
    let raw = document.get("version")?.as_str()?;
    if raw.len() > 64 {
        return None;
    }
    semver::Version::parse(raw)
        .ok()
        .map(|v| format!("{}.{}.{}", v.major, v.minor, v.patch))
}
fn check(id: &str, status: &str, label: &str, message: &str) -> DoctorCheck {
    DoctorCheck {
        id: id.into(),
        status: status.into(),
        label: label.into(),
        message: message.into(),
    }
}
fn sanitized_checks(document: &Value, bridge_healthy: bool) -> Vec<DoctorCheck> {
    let known = [
        ("configuration", "설정", "Codexify 설정을 확인하세요."),
        ("git", "Git", "Git 실행 파일을 확인하세요."),
        ("rg", "파일 검색", "ripgrep 설치와 실행 경로를 확인하세요."),
        (
            "gh",
            "GitHub CLI",
            "GitHub CLI 설치와 실행 경로를 확인하세요.",
        ),
        (
            "codex_cli",
            "Codex CLI",
            "Codex CLI 도구 검색 상태를 확인하세요.",
        ),
        (
            "shell",
            "명령 실행 환경",
            "운영체제의 명령 실행 환경을 확인하세요.",
        ),
        (
            "mcp_stdio",
            "연결 도구",
            "연결한 MCP 도구의 실행 파일을 확인하세요.",
        ),
        (
            "self_update",
            "업데이트 상태",
            "기존 업데이트 작업 상태를 확인하세요.",
        ),
        (
            "updates",
            "최신 버전 확인",
            "GitHub 연결 상태를 확인하세요.",
        ),
        (
            "openai_tunnel_credential",
            "OpenAI 터널 설정",
            "로컬 터널 인증 설정을 확인하세요.",
        ),
        (
            "openai_tunnel_runtime",
            "OpenAI 터널 실행",
            "로컬 터널 실행 상태를 확인하세요.",
        ),
    ];
    let mut result = Vec::new();
    for item in document
        .get("checks")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let Some(id) = item.get("id").and_then(Value::as_str) else {
            continue;
        };
        if id == "service" {
            // This is the user's one global Codexify service, often a different config/port.
            result.push(check("native_service", "skipped", "OS 백그라운드 서비스", "OS 서비스는 별도 Codexify 설정을 사용할 수 있습니다. 앱 연결 상태와 구분하며 이 앱에서는 변경하지 않습니다."));
            continue;
        }
        if id == "health" {
            continue;
        } // Our bounded selected-port probe is authoritative here.
        let Some((_, label, failure_message)) = known.iter().find(|(known, _, _)| *known == id)
        else {
            continue;
        };
        let state = match item.get("status").and_then(Value::as_str) {
            Some("pass") => "pass",
            Some("failure") => "failure",
            _ => "skipped",
        };
        result.push(check(
            id,
            state,
            label,
            match state {
                "pass" => "정상입니다.",
                "failure" => failure_message,
                _ => "사용하지 않거나 현재 확인할 수 없는 항목입니다.",
            },
        ));
    }
    // A global-service health failure is irrelevant when our chosen bridge is healthy.
    let _ = bridge_healthy;
    result
}

fn regular_file(path: &Path) -> bool {
    fs::symlink_metadata(path)
        .is_ok_and(|metadata| metadata.is_file() && !metadata.file_type().is_symlink())
}
fn safe_parent(path: &Path) -> Result<(), String> {
    for ancestor in path.ancestors() {
        if let Ok(metadata) = fs::symlink_metadata(ancestor) {
            if metadata.file_type().is_symlink() || !metadata.is_dir() {
                return Err(
                    "Codexify 설정 폴더는 심볼릭 링크가 아닌 사용자 폴더여야 합니다.".into(),
                );
            }
        }
    }
    Ok(())
}
fn validate_source(path: &Path) -> Result<PathBuf, String> {
    let raw = path.to_string_lossy();
    if raw.is_empty()
        || raw.len() > 4096
        || raw.chars().any(char::is_control)
        || !path.is_absolute()
        || path.components().any(|v| {
            matches!(
                v,
                std::path::Component::ParentDir | std::path::Component::CurDir
            )
        })
    {
        return Err("Source에 존재하는 프로젝트 폴더의 전체 경로를 입력하세요.".into());
    }
    let actual = fs::canonicalize(path).map_err(|_| "Source 폴더를 찾지 못했습니다.")?;
    if !actual.is_dir() || actual.parent().is_none() {
        return Err("파일이나 시스템 루트 대신 프로젝트 폴더를 선택하세요.".into());
    }
    // Keep the user's normal path, including Windows non-verbatim paths, in JSON/UI.
    Ok(path.to_path_buf())
}
fn expand_source(raw: &str, home: &Path) -> Result<PathBuf, String> {
    if raw == "~" {
        return Ok(home.to_path_buf());
    }
    if let Some(suffix) = raw.strip_prefix("~/") {
        return Ok(home.join(suffix));
    }
    if raw.starts_with('~') || raw.contains('$') || raw.contains('`') {
        return Err(
            "Source에는 폴더 경로만 입력하세요. ~/projects 형태를 사용할 수 있습니다.".into(),
        );
    }
    Ok(PathBuf::from(raw))
}
fn owner_port(document: &Value) -> Option<u16> {
    let agent = document.get("agentChat")?;
    if agent.get("enabled").and_then(Value::as_bool) != Some(true) {
        return None;
    }
    match agent.get("port") {
        Some(Value::Null) => None,
        None => Some(3120),
        Some(v) => v.as_u64().and_then(|n| u16::try_from(n).ok()),
    }
}
fn validate_port(document: &Value, port: u16) -> Result<(), String> {
    if port == 0 || owner_port(document) == Some(port) {
        return Err("1~65535 범위에서 대화 연결 포트와 다른 포트를 선택하세요.".into());
    }
    Ok(())
}
fn read_document(path: &Path) -> Result<Value, String> {
    safe_parent(path.parent().ok_or("Codexify 설정 폴더를 확인하세요.")?)?;
    let metadata =
        fs::symlink_metadata(path).map_err(|_| "Codexify 설정 파일을 읽지 못했습니다.")?;
    if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > MAX_CONFIG {
        return Err("Codexify 설정 파일의 형식과 크기를 확인하세요.".into());
    }
    let mut bytes = Vec::new();
    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(target_os = "macos")]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    #[cfg(target_os = "linux")]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(0o400000);
    }
    options
        .open(path)
        .map_err(|_| "Codexify 설정 파일을 읽지 못했습니다.")?
        .take(MAX_CONFIG + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "Codexify 설정 파일을 읽지 못했습니다.")?;
    if bytes.len() as u64 > MAX_CONFIG {
        return Err("Codexify 설정 파일이 너무 큽니다.".into());
    }
    let value: Value =
        serde_json::from_slice(&bytes).map_err(|_| "Codexify 설정 형식이 올바르지 않습니다.")?;
    if !value.is_object() {
        return Err("Codexify 설정은 JSON 객체여야 합니다.".into());
    }
    Ok(value)
}
fn default_document(source: &Path, studio_exe: &Path) -> Value {
    json!({"workDir":source,"multiProject":true,"port":DEFAULT_PORT,"agentChat":{"enabled":true,"port":3120,"maxWaitMs":55000},
        "mcpServers":{"studio":{"command":studio_exe,"args":["--studio-mcp"],"mode":"direct","tools":STUDIO_TOOLS,"startupTimeoutSec":30,"toolTimeoutSec":180}}})
}
fn config_lock(path: &Path) -> Result<fs::File, String> {
    let parent = path.parent().ok_or("Codexify 설정 폴더를 확인하세요.")?;
    safe_parent(parent)?;
    fs::create_dir_all(parent).map_err(|_| "Codexify 설정 폴더를 만들지 못했습니다.")?;
    safe_parent(parent)?;
    let lock_path = path.with_extension("json.studio.lock");
    if fs::symlink_metadata(&lock_path).is_ok_and(|m| !m.is_file() || m.file_type().is_symlink()) {
        return Err("Codexify 설정 잠금 파일을 확인하세요.".into());
    }
    let mut options = fs::OpenOptions::new();
    options.create(true).truncate(false).read(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    #[cfg(target_os = "macos")]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    #[cfg(target_os = "linux")]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(0o400000);
    }
    let file = options
        .open(lock_path)
        .map_err(|_| "Codexify 설정을 잠그지 못했습니다.")?;
    file.try_lock_exclusive()
        .map_err(|_| "다른 작업에서 Codexify 설정을 저장 중입니다. 잠시 후 다시 시도하세요.")?;
    Ok(file)
}
fn write_document(path: &Path, value: &Value) -> Result<(), String> {
    let parent = path.parent().ok_or("Codexify 설정 폴더를 확인하세요.")?;
    safe_parent(parent)?;
    if fs::symlink_metadata(path).is_ok_and(|m| !m.is_file() || m.file_type().is_symlink()) {
        return Err("Codexify 설정 파일은 일반 파일이어야 합니다.".into());
    }
    let bytes =
        serde_json::to_vec_pretty(value).map_err(|_| "Codexify 설정을 만들지 못했습니다.")?;
    if bytes.len() as u64 > MAX_CONFIG {
        return Err("Codexify 설정 파일이 너무 큽니다.".into());
    }
    let mut temporary = tempfile::NamedTempFile::new_in(parent)
        .map_err(|_| "Codexify 설정 임시 파일을 만들지 못했습니다.")?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        temporary
            .as_file()
            .set_permissions(fs::Permissions::from_mode(0o600))
            .map_err(|_| "Codexify 설정 권한을 제한하지 못했습니다.")?;
    }
    std::io::Write::write_all(&mut temporary, &bytes)
        .map_err(|_| "Codexify 설정을 저장하지 못했습니다.")?;
    temporary
        .as_file()
        .sync_all()
        .map_err(|_| "Codexify 설정을 저장하지 못했습니다.")?;
    // Revalidate immediately before atomic replacement, including an intervening symlink.
    safe_parent(parent)?;
    if fs::symlink_metadata(path).is_ok_and(|m| !m.is_file() || m.file_type().is_symlink()) {
        return Err("Codexify 설정 파일이 변경되었습니다. 다시 시도하세요.".into());
    }
    temporary
        .persist(path)
        .map_err(|_| "Codexify 설정을 교체하지 못했습니다.")?;
    Ok(())
}
async fn occupied(port: u16) -> bool {
    tokio::time::timeout(
        HEALTH_TIMEOUT,
        tokio::net::TcpStream::connect(("127.0.0.1", port)),
    )
    .await
    .is_ok_and(|r| r.is_ok())
}
async fn healthy(port: u16) -> bool {
    let Ok(client) = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(HEALTH_TIMEOUT)
        .build()
    else {
        return false;
    };
    let Ok(response) = client
        .get(format!("http://127.0.0.1:{port}/health"))
        .send()
        .await
    else {
        return false;
    };
    if !response.status().is_success() || response.content_length().is_some_and(|n| n > 16_384) {
        return false;
    }
    use futures_util::StreamExt;
    let mut stream = response.bytes_stream();
    let mut bytes = Vec::new();
    while let Some(chunk) = stream.next().await {
        let Ok(chunk) = chunk else {
            return false;
        };
        if bytes.len() + chunk.len() > 16_384 {
            return false;
        }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice::<Value>(&bytes).is_ok_and(|value| {
        value.get("status").and_then(Value::as_str) == Some("ok")
            && value.get("tools").and_then(Value::as_u64).is_some()
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_home() -> tempfile::TempDir {
        tempfile::tempdir().unwrap()
    }
    fn test_runtime(home: &Path) -> RuntimeController {
        RuntimeController {
            home: fs::canonicalize(home).unwrap(),
            binary: home.join("absent-runtime"),
            bundled: false,
            studio_exe: home.join("toris-studio-desktop"),
            isolated: true,
            inner: StdMutex::new(Inner::default()),
            mutation: Mutex::new(()),
        }
    }
    fn fixture(runtime: &RuntimeController, port: u16) -> PathBuf {
        fs::create_dir_all(runtime.home.join("projects")).unwrap();
        let path = runtime.home.join(".codexify/codexify.external.json");
        let mut document = default_document(&runtime.home.join("projects"), &runtime.studio_exe);
        document["port"] = json!(port);
        document["agentChat"]["enabled"] = json!(false);
        let lock = config_lock(&path).unwrap();
        write_document(&path, &document).unwrap();
        drop(lock);
        path
    }
    async fn test_server() -> (u16, tokio::task::JoinHandle<()>) {
        use tokio::io::AsyncWriteExt;
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let port = listener.local_addr().unwrap().port();
        let task = tokio::spawn(async move {
            loop {
                let Ok((mut stream, _)) = listener.accept().await else {
                    break;
                };
                tokio::spawn(async move {
                    let mut buffer = [0u8; 4096];
                    let _ = stream.read(&mut buffer).await;
                    let body = br#"{"status":"ok","tools":64}"#;
                    let response = format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len());
                    let _ = stream.write_all(response.as_bytes()).await;
                    let _ = stream.write_all(body).await;
                });
            }
        });
        (port, task)
    }

    #[test]
    fn default_config_uses_local_source_and_studio_direct_contract() {
        let home = test_home();
        let runtime = test_runtime(home.path());
        fs::create_dir(runtime.home.join("projects")).unwrap();
        let settings = runtime.settings().unwrap();
        assert_eq!(settings.port, 21228);
        assert_eq!(settings.document["multiProject"], true);
        assert_eq!(settings.document["mcpServers"]["studio"]["mode"], "direct");
        assert_eq!(
            settings.document["mcpServers"]["studio"]["tools"]
                .as_array()
                .unwrap()
                .len(),
            9
        );
        assert!(!settings.path.exists());
    }
    #[test]
    fn first_install_status_does_not_require_or_create_default_source() {
        let home = test_home();
        let runtime = test_runtime(home.path());
        let settings = runtime.settings().unwrap();
        assert_eq!(settings.source, runtime.home.join("projects"));
        assert!(!settings.source.exists());
        assert!(!settings.path.exists());
    }
    #[test]
    fn source_rejects_root_relative_traversal_files_and_missing_paths() {
        let home = test_home();
        for path in [
            Path::new("/"),
            Path::new("../projects"),
            Path::new("/tmp/../projects"),
            Path::new("/definitely-absent-toris-folder"),
        ] {
            assert!(validate_source(path).is_err());
        }
        let file = home.path().join("file");
        fs::write(&file, b"x").unwrap();
        assert!(validate_source(&file).is_err());
    }
    #[test]
    fn source_expands_only_literal_home_prefix() {
        let home = Path::new("/users/owner");
        assert_eq!(
            expand_source("~/projects", home).unwrap(),
            home.join("projects")
        );
        assert_eq!(expand_source("~", home).unwrap(), home);
        for raw in [
            "~someone/projects",
            "$HOME/projects",
            "`pwd`",
            "$(echo test)",
        ] {
            assert!(expand_source(raw, home).is_err());
        }
    }
    #[test]
    fn port_rejects_zero_and_owner_listener_collision() {
        let config = json!({"agentChat":{"enabled":true,"port":3120}});
        assert!(validate_port(&config, 0).is_err());
        assert!(validate_port(&config, 3120).is_err());
        assert!(validate_port(&config, 21228).is_ok());
        assert!(validate_port(&json!({"agentChat":{"enabled":true,"port":null}}), 3120).is_ok());
    }
    #[tokio::test]
    async fn configure_preserves_auth_mcp_unknown_fields_and_restricts_file_permissions() {
        let home = test_home();
        let runtime = test_runtime(home.path());
        let path = fixture(&runtime, 65419);
        let mut document = read_document(&path).unwrap();
        document["apiKey"] = json!("dummy-preserved-auth");
        document["unknownFutureField"] = json!({"nested":[1,2]});
        document["mcpServers"]["other"] = json!({"env":{"SAMPLE":"dummy"},"command":"other"});
        document["multiProject"] = json!(false);
        write_document(&path, &document).unwrap();
        let configured = runtime
            .configure(ConfigureInput {
                source_root: "~/projects".into(),
                port: 65419,
            })
            .await
            .unwrap();
        assert_eq!(
            configured.source_root,
            runtime.home.join("projects").to_string_lossy()
        );
        assert_eq!(read_document(&path).unwrap(), document);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
    }
    #[tokio::test]
    async fn healthy_external_bridge_is_reused_and_stop_cannot_terminate_it() {
        let (port, server) = test_server().await;
        let home = test_home();
        let runtime = test_runtime(home.path());
        fixture(&runtime, port);
        let started = runtime.start().await.unwrap();
        assert!(started.running);
        assert!(!started.managed);
        assert_eq!(started.pid, None);
        let stopped = runtime.stop().await.unwrap();
        assert!(stopped.running);
        assert!(!stopped.managed);
        assert!(healthy(port).await);
        server.abort();
    }
    #[tokio::test]
    async fn configure_refuses_active_external_changes_but_allows_same_settings() {
        let (port, server) = test_server().await;
        let home = test_home();
        let runtime = test_runtime(home.path());
        let path = fixture(&runtime, port);
        let before = fs::read(&path).unwrap();
        fs::create_dir(runtime.home.join("other-projects")).unwrap();
        assert!(runtime
            .configure(ConfigureInput {
                source_root: runtime
                    .home
                    .join("other-projects")
                    .to_string_lossy()
                    .into_owned(),
                port
            })
            .await
            .is_err());
        assert_eq!(fs::read(&path).unwrap(), before);
        assert!(runtime
            .configure(ConfigureInput {
                source_root: "~/projects".into(),
                port
            })
            .await
            .is_ok());
        server.abort();
    }
    #[tokio::test]
    async fn unrelated_unhealthy_listener_cannot_be_replaced_by_start() {
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let port = listener.local_addr().unwrap().port();
        let home = test_home();
        let mut runtime = test_runtime(home.path());
        runtime.binary = std::env::current_exe().unwrap();
        fixture(&runtime, port);
        assert!(runtime.start().await.is_err());
        assert!(!runtime.child_snapshot().await.unwrap().0);
        assert!(occupied(port).await);
    }
    #[cfg(unix)]
    #[test]
    fn symlink_config_and_parent_are_refused_without_following() {
        use std::os::unix::fs::symlink;
        let home = test_home();
        let runtime = test_runtime(home.path());
        let path = fixture(&runtime, 65419);
        let outside = runtime.home.join("outside.json");
        fs::write(&outside, b"{\"private\":true}").unwrap();
        fs::remove_file(&path).unwrap();
        symlink(&outside, &path).unwrap();
        assert!(read_document(&path).is_err());
        assert!(write_document(&path, &json!({})).is_err());
        assert_eq!(fs::read(&outside).unwrap(), b"{\"private\":true}");
        fs::remove_file(&path).unwrap();
        fs::remove_dir_all(runtime.home.join(".codexify")).unwrap();
        let actual = runtime.home.join("actual-config");
        fs::create_dir(&actual).unwrap();
        symlink(actual, runtime.home.join(".codexify")).unwrap();
        assert!(runtime.settings().is_err());
    }
    #[test]
    fn doctor_whitelists_checks_and_never_returns_details_secrets_or_global_health_failure() {
        let report = json!({"checks":[
            {"id":"configuration","status":"pass","detail":"dummy-secret-config"},
            {"id":"service","status":"failure","detail":"dummy-owner-token"},
            {"id":"health","status":"failure","detail":"dummy-secret-health"},
            {"id":"mcp_stdio","status":"failure","detail":"dummy-secret-env","remediation":"dummy-secret"},
            {"id":"unknown-secret","status":"failure","detail":"dummy-secret"}]});
        let output = serde_json::to_string(&sanitized_checks(&report, true)).unwrap();
        assert!(!output.contains("dummy-"));
        assert!(!output.contains("unknown-secret"));
        assert!(!output.contains("\"health\""));
        assert!(output.contains("native_service"));
        assert_eq!(
            safe_version(&json!({"version":"1.7.0+dummy-secret"})).as_deref(),
            Some("1.7.0")
        );
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn owned_process_is_stopped_and_exit_cleanup_has_same_ownership_guard() {
        let home = test_home();
        let runtime = test_runtime(home.path());
        fixture(&runtime, 65419);
        let child = Command::new("/bin/sleep")
            .arg("60")
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        runtime.inner.lock().unwrap().child = Some(ManagedChild {
            child,
            config: runtime.home.join(".codexify/codexify.external.json"),
            source: runtime.home.join("projects"),
            port: 65419,
        });
        assert!(runtime.child_snapshot().await.unwrap().0);
        runtime.stop().await.unwrap();
        assert!(!runtime.child_snapshot().await.unwrap().0);
        let child = Command::new("/bin/sleep")
            .arg("60")
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        runtime.inner.lock().unwrap().child = Some(ManagedChild {
            child,
            config: PathBuf::new(),
            source: PathBuf::new(),
            port: 65419,
        });
        runtime.shutdown();
        assert!(!runtime.child_snapshot().await.unwrap().0);
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn diagnostic_failure_exit_keeps_json_and_output_and_time_are_bounded() {
        let mut failure = Command::new("/bin/sh");
        failure
            .args(["-c", "printf '{\"ok\":false}'; exit 1"])
            .stdout(Stdio::piped())
            .kill_on_drop(true);
        assert_eq!(
            bounded_json_command(failure, Duration::from_secs(1), 1024)
                .await
                .unwrap()["ok"],
            false
        );
        let mut oversized = Command::new("/bin/sh");
        oversized
            .args(["-c", "printf '01234567890123456789'"])
            .stdout(Stdio::piped())
            .kill_on_drop(true);
        assert!(bounded_json_command(oversized, Duration::from_secs(1), 8)
            .await
            .is_err());
        let mut hung = Command::new("/bin/sleep");
        hung.arg("60").stdout(Stdio::piped()).kill_on_drop(true);
        let start = std::time::Instant::now();
        assert!(bounded_json_command(hung, Duration::from_millis(80), 1024)
            .await
            .is_err());
        assert!(start.elapsed() < Duration::from_secs(2));
    }
}
