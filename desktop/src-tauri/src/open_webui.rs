//! The desktop owns one authenticated, loopback-only Open WebUI container.
//! No host project files, Docker socket, or renderer-controlled arguments enter it.
use crate::config::AppConfig;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    ffi::OsString,
    io::Write,
    path::PathBuf,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tokio::{io::AsyncReadExt, process::Command, sync::watch};
use url::Url;

pub const VERSION: &str = "0.11.4";
pub const URL: &str = "http://127.0.0.1:43180";
pub const MCP_URL: &str = "http://127.0.0.1:43181/mcp";
pub const IMAGE: &str = "ghcr.io/open-webui/open-webui:v0.11.4-slim@sha256:0487ad4a5a4b986062dedace806c3ef1e88fec38c10d1e64d6a5501c66671e5e";
const CONTAINER: &str = "toris-studio-open-webui";
const VOLUME: &str = "toris-studio-open-webui-data";
const OWNER_LABEL: &str = "kr.toris.studio.managed";
const SCHEMA_LABEL: &str = "kr.toris.studio.open-webui.schema";
const PROVIDER_LABEL: &str = "kr.toris.studio.open-webui.provider";
const MCP_LABEL: &str = "kr.toris.studio.open-webui.mcp";
const MAX_OUTPUT: usize = 32 * 1024;

#[derive(Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Phase {
    Stopped,
    Pulling,
    Starting,
    Ready,
    Error,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenWebUiStatus {
    pub status: Phase,
    pub message: String,
    pub checked_at: String,
    pub version: &'static str,
    pub url: &'static str,
    pub docker_available: bool,
    pub container_running: bool,
    pub setup_required: Option<bool>,
    /// These are the initial connection addresses seeded when this container was created.
    /// Open WebUI's persistent administrator settings can subsequently override them.
    pub provider_url: Option<String>,
    pub mcp_url: Option<String>,
    pub provider_reachable: Option<bool>,
    pub mcp_reachable: Option<bool>,
    pub can_open: bool,
}

#[derive(Clone)]
pub struct OpenWebUiController {
    inner: Arc<Inner>,
}
struct Inner {
    job: Mutex<Job>,
    operation: tokio::sync::Mutex<()>,
    cancellation: watch::Sender<u64>,
    probes: Mutex<Option<ProbeCache>>,
}
struct Job {
    generation: u64,
    active: bool,
    phase: Phase,
    message: String,
}
struct ProbeCache {
    at: Instant,
    container_id: String,
    result: ProbeResult,
}
#[derive(Clone, Default, Deserialize)]
struct ProbeResult {
    provider: Option<bool>,
    mcp: Option<bool>,
}
impl Default for OpenWebUiController {
    fn default() -> Self {
        let (cancellation, _) = watch::channel(0);
        Self {
            inner: Arc::new(Inner {
                job: Mutex::new(Job {
                    generation: 0,
                    active: false,
                    phase: Phase::Stopped,
                    message: "Open WebUI를 시작하면 로컬 AI 작업실이 열립니다.".into(),
                }),
                operation: tokio::sync::Mutex::new(()),
                cancellation,
                probes: Mutex::new(None),
            }),
        }
    }
}

#[derive(Clone)]
struct Settings {
    provider: String,
    container_provider: String,
    key: Option<String>,
    mcp: Option<String>,
    container_mcp: Option<String>,
}

fn local_endpoint(raw: &str, path: &str) -> Result<(String, String), String> {
    let mut url = Url::parse(raw).map_err(|_| "로컬 연결 주소 형식을 확인하세요.")?;
    if url.scheme() != "http"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.path().trim_end_matches('/') != path
        || !matches!(
            url.host_str(),
            Some("localhost" | "127.0.0.1" | "[::1]" | "::1")
        )
    {
        return Err("Open WebUI는 로컬 OpenCodex와 로컬 Codexify 주소만 연결합니다.".into());
    }
    url.set_path(path);
    let local = url.to_string();
    url.set_host(Some("host.docker.internal"))
        .map_err(|_| "컨테이너 연결 주소를 만들 수 없습니다.")?;
    Ok((local, url.to_string()))
}

impl Settings {
    fn from_config(config: &AppConfig) -> Result<Self, String> {
        let (provider, container_provider) = local_endpoint(&config.opencodex_base_url, "/v1")?;
        let key = config
            .opencodex_api_key
            .as_ref()
            .filter(|key| !key.is_empty())
            .cloned();
        if key.as_ref().is_some_and(|key| {
            key.len() > 8192 || key.contains(';') || key.chars().any(|value| value.is_control())
        }) {
            return Err("OpenCodex 키에 줄바꿈·제어 문자·세미콜론을 사용할 수 없습니다.".into());
        }
        // A remote profile remains available to other application features, but is never
        // silently imported into this local coding container.
        let mcp = crate::codexify_connection::load()
            .ok()
            .and_then(|profile| local_endpoint(&profile.mcp_url, "/mcp").ok())
            .and_then(|_| local_endpoint(MCP_URL, "/mcp").ok());
        Ok(Self {
            provider,
            container_provider,
            key,
            mcp: mcp.as_ref().map(|(local, _)| local.clone()),
            container_mcp: mcp.map(|(_, container)| container),
        })
    }

    fn env_file(&self) -> Result<tempfile::NamedTempFile, String> {
        let mut file = tempfile::NamedTempFile::new()
            .map_err(|_| "Open WebUI의 임시 연결 설정을 만들 수 없습니다.")?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            file.as_file()
                .set_permissions(std::fs::Permissions::from_mode(0o600))
                .map_err(|_| "임시 연결 설정의 접근 권한을 제한할 수 없습니다.")?;
        }
        let tools = self.container_mcp.as_ref().map_or_else(
            || json!([]),
            |mcp| {
                let parsed = Url::parse(mcp).expect("validated local MCP URL");
                let port = parsed.port_or_known_default().unwrap_or(80);
                json!([{
                    "type":"mcp", "url":mcp, "path":"", "auth_type":"none", "key":"",
                    "forward_cookies":false, "headers":{"Host":format!("127.0.0.1:{port}"), "X-Toris-WebUI-Chat":"{{CHAT_ID}}", "X-Toris-WebUI-User":"{{USER_ID}}"},
                    "config":{"enable":true,"access_grants":[]},
                    "info":{"id":"toris_codexify","name":"Toris Codexify","description":"Toris Studio coding tools"}
                }])
            },
        );
        let auth = if self.key.is_some() { "bearer" } else { "none" };
        let (provider, _) = local_endpoint(&self.provider, "/v1")?;
        let provider = Url::parse(&provider).map_err(|_| "로컬 제공자 주소를 확인하세요.")?;
        let provider_host = &provider[url::Position::BeforeHost..url::Position::AfterPort];
        let entries = [
            ("WEBUI_AUTH", "True".to_string()),
            ("ENABLE_SIGNUP", "True".to_string()),
            ("ENABLE_LOGIN_FORM", "True".to_string()),
            (
                "WEBUI_SECRET_KEY_FILE",
                "/app/backend/data/.webui_secret_key".to_string(),
            ),
            ("WEBUI_URL", URL.to_string()),
            ("CORS_ALLOW_ORIGIN", URL.to_string()),
            ("ENABLE_OPENAI_API", "True".to_string()),
            ("ENABLE_OLLAMA_API", "False".to_string()),
            ("OPENAI_API_BASE_URL", self.container_provider.clone()),
            ("OPENAI_API_KEY", self.key.clone().unwrap_or_default()),
            (
                "OPENAI_API_CONFIGS",
                json!({"0":{"enable":true,"auth_type":auth,"headers":{"Host":provider_host}}})
                    .to_string(),
            ),
            ("TOOL_SERVER_CONNECTIONS", tools.to_string()),
            ("HF_HUB_OFFLINE", "1".to_string()),
            ("DO_NOT_TRACK", "True".to_string()),
            ("SCARF_NO_ANALYTICS", "True".to_string()),
            ("ANONYMIZED_TELEMETRY", "False".to_string()),
        ];
        for (key, value) in entries {
            if value.chars().any(|character| character.is_control()) {
                return Err("Open WebUI 연결 설정에 제어 문자를 사용할 수 없습니다.".into());
            }
            writeln!(file, "{key}={value}").map_err(|_| "임시 연결 설정을 저장할 수 없습니다.")?;
        }
        file.flush()
            .and_then(|_| file.as_file().sync_all())
            .map_err(|_| "임시 연결 설정을 저장할 수 없습니다.")?;
        Ok(file)
    }
}

#[derive(Clone)]
struct Docker {
    binary: PathBuf,
    context: String,
}

fn docker_binary() -> Option<PathBuf> {
    let name = if cfg!(windows) {
        "docker.exe"
    } else {
        "docker"
    };
    let mut candidates = vec![
        PathBuf::from("/opt/homebrew/bin").join(name),
        PathBuf::from("/usr/local/bin").join(name),
        PathBuf::from("/Applications/Docker.app/Contents/Resources/bin").join(name),
    ];
    if let Some(home) = dirs::home_dir() {
        candidates.push(home.join(".orbstack/bin").join(name));
        candidates.push(home.join(".docker/bin").join(name));
    }
    #[cfg(windows)]
    {
        if let Some(program_files) = std::env::var_os("ProgramFiles") {
            candidates
                .push(PathBuf::from(program_files).join("Docker/Docker/resources/bin/docker.exe"));
        }
    }
    if let Some(paths) = std::env::var_os("PATH") {
        candidates.extend(
            std::env::split_paths(&paths)
                .filter(|path| path.is_absolute())
                .map(|path| path.join(name)),
        );
    }
    candidates.into_iter().find(|path| {
        path.is_file()
            && !path
                .to_string_lossy()
                .to_ascii_lowercase()
                .contains("windowsapps")
    })
}

async fn command(
    binary: &std::path::Path,
    args: &[OsString],
    timeout: Duration,
    cancel: Option<(watch::Receiver<u64>, u64)>,
    capture: bool,
) -> Result<Vec<u8>, String> {
    let mut process = Command::new(binary);
    process
        .args(args)
        .env_remove("DOCKER_HOST")
        .env_remove("DOCKER_CONTEXT")
        .env_remove("DOCKER_TLS_VERIFY")
        .env_remove("DOCKER_CERT_PATH")
        .stdin(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .stdout(if capture {
            std::process::Stdio::piped()
        } else {
            std::process::Stdio::null()
        })
        .kill_on_drop(true);
    #[cfg(windows)]
    process.creation_flags(0x08000000);
    let mut child = process
        .spawn()
        .map_err(|_| "Docker CLI를 실행할 수 없습니다.")?;
    let stdout = child.stdout.take();
    let work = async {
        let mut output = Vec::new();
        if let Some(stdout) = stdout {
            stdout
                .take((MAX_OUTPUT + 1) as u64)
                .read_to_end(&mut output)
                .await
                .map_err(|_| "Docker 응답을 읽을 수 없습니다.")?;
            if output.len() > MAX_OUTPUT {
                return Err("Docker 응답이 허용 크기를 초과했습니다.".into());
            }
        }
        let status = child
            .wait()
            .await
            .map_err(|_| "Docker 실행 결과를 확인할 수 없습니다.")?;
        if !status.success() {
            return Err("Docker 작업을 완료하지 못했습니다. OrbStack 또는 Docker Desktop 상태를 확인하세요.".into());
        }
        Ok(output)
    };
    if let Some((mut receiver, generation)) = cancel {
        if *receiver.borrow_and_update() != generation {
            return Err("Open WebUI 시작이 취소되었습니다.".into());
        }
        tokio::select! {
            result = tokio::time::timeout(timeout, work) => result.map_err(|_| "Docker 작업 시간이 초과되었습니다.")?,
            _ = receiver.changed() => Err("Open WebUI 시작이 취소되었습니다.".into()),
        }
    } else {
        tokio::time::timeout(timeout, work)
            .await
            .map_err(|_| "Docker 작업 시간이 초과되었습니다.")?
    }
}

impl Docker {
    async fn connect() -> Result<Self, String> {
        let binary =
            docker_binary().ok_or("OrbStack 또는 Docker Desktop의 Docker CLI를 설치하세요.")?;
        // Capture the CLI's saved context, then explicitly pin every command to it.
        // A remote TCP engine is never accepted as a local coding workspace.
        let context = command(
            &binary,
            &["context".into(), "show".into()],
            Duration::from_secs(3),
            None,
            true,
        )
        .await?;
        let context = String::from_utf8(context)
            .map_err(|_| "Docker 컨텍스트 형식을 확인하세요.")?
            .trim()
            .to_string();
        if context.is_empty()
            || context.len() > 128
            || !context
                .bytes()
                .all(|value| value.is_ascii_alphanumeric() || b"_.-".contains(&value))
        {
            return Err("Docker 컨텍스트 이름을 확인하세요.".into());
        }
        let result = command(
            &binary,
            &[
                "context".into(),
                "inspect".into(),
                context.clone().into(),
                "--format".into(),
                "{{json .Endpoints.docker.Host}}".into(),
            ],
            Duration::from_secs(3),
            None,
            true,
        )
        .await?;
        let endpoint: String = serde_json::from_slice(&result)
            .map_err(|_| "Docker 연결 주소를 확인할 수 없습니다.")?;
        if !endpoint.starts_with("unix:///") && !endpoint.starts_with("npipe:////./pipe/") {
            return Err("로컬 Docker 소켓 컨텍스트만 사용할 수 있습니다.".into());
        }
        let docker = Self { binary, context };
        docker
            .run(
                &[
                    "version".into(),
                    "--format".into(),
                    "{{.Server.Version}}".into(),
                ],
                Duration::from_secs(3),
                None,
                true,
            )
            .await?;
        Ok(docker)
    }
    async fn run(
        &self,
        args: &[OsString],
        timeout: Duration,
        cancel: Option<(watch::Receiver<u64>, u64)>,
        capture: bool,
    ) -> Result<Vec<u8>, String> {
        let mut full = vec!["--context".into(), self.context.clone().into()];
        full.extend_from_slice(args);
        command(&self.binary, &full, timeout, cancel, capture).await
    }
    async fn inspect(&self) -> Result<Option<Value>, String> {
        let listing = self
            .run(
                &[
                    "container".into(),
                    "ls".into(),
                    "-a".into(),
                    "--filter".into(),
                    format!("name=^/{CONTAINER}$").into(),
                    "--format".into(),
                    "{{.Names}}".into(),
                ],
                Duration::from_secs(3),
                None,
                true,
            )
            .await?;
        if String::from_utf8_lossy(&listing).trim().is_empty() {
            return Ok(None);
        }
        // Project only security-relevant nonsecret fields; never capture Config.Env.
        let format = r#"{"id":{{json .Id}},"name":{{json .Name}},"image":{{json .Config.Image}},"labels":{{json .Config.Labels}},"ports":{{json .HostConfig.PortBindings}},"mounts":{{json .Mounts}},"state":{{json .State.Status}},"startedAt":{{json .State.StartedAt}},"exitCode":{{json .State.ExitCode}},"networkMode":{{json .HostConfig.NetworkMode}},"privileged":{{json .HostConfig.Privileged}},"pidMode":{{json .HostConfig.PidMode}},"ipcMode":{{json .HostConfig.IpcMode}},"devices":{{json .HostConfig.Devices}},"capAdd":{{json .HostConfig.CapAdd}},"securityEnv":{{range .Config.Env}}{{if ge (len .) 11}}{{if eq (slice . 0 11) "WEBUI_AUTH="}}{{json .}}{{end}}{{end}}{{end}},"corsEnv":{{range .Config.Env}}{{if ge (len .) 18}}{{if eq (slice . 0 18) "CORS_ALLOW_ORIGIN="}}{{json .}}{{end}}{{end}}{{end}}}"#;
        let bytes = self
            .run(
                &[
                    "inspect".into(),
                    "--format".into(),
                    format.into(),
                    CONTAINER.into(),
                ],
                Duration::from_secs(3),
                None,
                true,
            )
            .await?;
        let inspected: Value = serde_json::from_slice(&bytes)
            .map_err(|_| "Open WebUI 컨테이너 설정을 확인할 수 없습니다.")?;
        validate_container(&inspected)?;
        if !self.validate_volume().await? {
            return Err("Open WebUI 데이터 볼륨의 소유권을 확인할 수 없습니다.".into());
        }
        Ok(Some(inspected))
    }
    async fn validate_volume(&self) -> Result<bool, String> {
        let listing = self
            .run(
                &[
                    "volume".into(),
                    "ls".into(),
                    "--filter".into(),
                    format!("name=^{VOLUME}$").into(),
                    "--format".into(),
                    "{{.Name}}".into(),
                ],
                Duration::from_secs(3),
                None,
                true,
            )
            .await?;
        if String::from_utf8_lossy(&listing).trim().is_empty() {
            return Ok(false);
        }
        let bytes = self
            .run(
                &[
                    "volume".into(),
                    "inspect".into(),
                    "--format".into(),
                    "{{json .Labels}}".into(),
                    VOLUME.into(),
                ],
                Duration::from_secs(3),
                None,
                true,
            )
            .await?;
        let labels: Value = serde_json::from_slice(&bytes)
            .map_err(|_| "Open WebUI 데이터 볼륨을 확인할 수 없습니다.")?;
        if labels.get(OWNER_LABEL).and_then(Value::as_str) != Some("open-webui")
            || labels.get(SCHEMA_LABEL).and_then(Value::as_str) != Some("1")
        {
            return Err(
                "같은 이름의 다른 데이터 볼륨이 있습니다. 기존 데이터를 변경하지 않았습니다."
                    .into(),
            );
        }
        Ok(true)
    }
}

fn validate_container(value: &Value) -> Result<(), String> {
    let labels = &value["labels"];
    let ports = value["ports"].as_object();
    let bindings = value["ports"]["8080/tcp"].as_array();
    let mounts = value["mounts"].as_array();
    let valid_mount = mounts.is_some_and(|mounts| {
        mounts.len() == 1
            && mounts[0]["Type"] == "volume"
            && mounts[0]["Name"] == VOLUME
            && mounts[0]["Destination"] == "/app/backend/data"
            && mounts[0]["RW"] == true
    });
    let valid_port = ports.is_some_and(|ports| ports.len() == 1)
        && bindings.is_some_and(|items| {
            items.len() == 1 && items[0]["HostIp"] == "127.0.0.1" && items[0]["HostPort"] == "43180"
        });
    if container_id(value).is_err()
        || value["name"] != format!("/{CONTAINER}")
        || value["image"] != IMAGE
        || labels[OWNER_LABEL] != "open-webui"
        || labels[SCHEMA_LABEL] != "1"
        || value["networkMode"] != "bridge"
        || value["privileged"] != false
        || value["securityEnv"] != "WEBUI_AUTH=True"
        || value["corsEnv"] != format!("CORS_ALLOW_ORIGIN={URL}")
        || value["pidMode"] != ""
        || value["ipcMode"] != "private"
        || value["devices"]
            .as_array()
            .is_some_and(|devices| !devices.is_empty())
        || value["capAdd"]
            .as_array()
            .is_some_and(|capabilities| !capabilities.is_empty())
        || !valid_port
        || !valid_mount
        || labels[PROVIDER_LABEL]
            .as_str()
            .and_then(|url| local_endpoint(url, "/v1").ok())
            .is_none()
        || !labels[MCP_LABEL]
            .as_str()
            .is_some_and(|url| url.is_empty() || url == MCP_URL)
    {
        return Err("같은 이름의 컨테이너가 앱의 소유권·보안·MCP 연결 설정과 다릅니다. 기존 컨테이너와 데이터 볼륨을 변경하지 않았습니다.".into());
    }
    Ok(())
}

fn container_id(value: &Value) -> Result<&str, String> {
    value["id"]
        .as_str()
        .filter(|id| id.len() == 64 && id.bytes().all(|byte| byte.is_ascii_hexdigit()))
        .ok_or_else(|| "검사한 Open WebUI 컨테이너 ID를 확인할 수 없습니다.".into())
}

async fn bounded_json(mut response: reqwest::Response) -> Option<Value> {
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.ok()? {
        if bytes.len() + chunk.len() > MAX_OUTPUT {
            return None;
        }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes).ok()
}

async fn config_probe() -> Result<Option<Value>, String> {
    let client = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(2))
        .build()
        .map_err(|_| "Open WebUI 검사 연결을 초기화할 수 없습니다.")?;
    let Ok(ready) = client.get(format!("{URL}/ready")).send().await else {
        return Ok(None);
    };
    if !ready.status().is_success() {
        return Ok(None);
    }
    let Some(ready) = bounded_json(ready).await else {
        return Ok(None);
    };
    if ready["status"] != true {
        return Ok(None);
    }
    let Ok(response) = client.get(format!("{URL}/api/config")).send().await else {
        return Ok(None);
    };
    if !response.status().is_success() {
        return Ok(None);
    }
    let Some(config) = bounded_json(response).await else {
        return Ok(None);
    };
    if config["features"]["auth"] != true {
        return Err("Open WebUI 인증이 활성화되어 있지 않습니다. 관리자 설정을 확인하세요.".into());
    }
    if config["status"] != true || config["version"] != VERSION || config["name"] != "Open WebUI" {
        return Err(
            "실행 중인 서비스가 설치된 Open WebUI 버전과 다릅니다. 앱에서 창을 열지 않았습니다."
                .into(),
        );
    }
    Ok(Some(config))
}

// Runs inside the verified container. Values leave it only as booleans. No model is
// generated and no Codexify tool is called; initialize only checks MCP transport.
const PROBE_MCP_PARSER: &str = r#"import json
def initialized(data):
 def matched(payload):
  if not isinstance(payload,dict) or payload.get('id')!=1:return None
  if 'error' in payload:return False
  return payload.get('result',{}).get('serverInfo',{}).get('name','').lower()=='codexify'
 try:
  direct=matched(json.loads(data))
  if direct is not None:return direct
 except (ValueError,TypeError):pass
 packet=[]
 for line in data.replace('\r\n','\n').replace('\r','\n').lstrip('\ufeff').split('\n')+['']:
  if line.startswith('data:'):packet.append(line[5:].lstrip(' '))
  elif not line:
   payload='\n'.join(packet).strip()
   packet=[]
   if not payload:continue
   try:
    result=matched(json.loads(payload))
    if result is not None:return result
   except (ValueError,TypeError):continue
 return False
"#;
const PROBE_CODE: &str = r#"import concurrent.futures,json,os,sys,urllib.request
def check(kind):
 session=None
 tool=None
 try:
  if kind=='provider':
   url=os.environ.get('OPENAI_API_BASE_URL','')+'/models'
   headers=json.loads(os.environ.get('OPENAI_API_CONFIGS','{}')).get('0',{}).get('headers',{}).copy()
   if not any(name.lower()=='host' for name in headers) and len(sys.argv)>1:headers['Host']=sys.argv[1]
   key=os.environ.get('OPENAI_API_KEY','')
   if key: headers['Authorization']='Bearer '+key
   req=urllib.request.Request(url,headers=headers)
  else:
   tools=json.loads(os.environ.get('TOOL_SERVER_CONNECTIONS','[]'))
   if not tools:return None
   tool=tools[0]
   payload={'jsonrpc':'2.0','id':1,'method':'initialize','params':{'protocolVersion':'2025-03-26','capabilities':{},'clientInfo':{'name':'toris-open-webui-check','version':'0.1.20'}}}
   headers={'Content-Type':'application/json','Accept':'application/json, text/event-stream','Host':tool.get('headers',{}).get('Host','')}
   req=urllib.request.Request(tool['url'],data=json.dumps(payload).encode(),headers=headers)
  with urllib.request.urlopen(req,timeout=2) as response:
   if kind=='mcp':session=response.headers.get('Mcp-Session-Id')
   data=response.read(16384).decode()
   if kind=='provider':return response.status==200 and 'json' in response.headers.get('Content-Type','')
   return initialized(data)
 except Exception:return False
 finally:
  if session and tool:
   try:
    cleanup=urllib.request.Request(tool['url'],method='DELETE',headers={'Host':tool.get('headers',{}).get('Host',''),'Mcp-Session-Id':session,'MCP-Protocol-Version':'2025-03-26'})
    with urllib.request.urlopen(cleanup,timeout=2) as response:pass
   except Exception:pass
with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
 results=list(pool.map(check,['provider','mcp']))
print(json.dumps(dict(zip(['provider','mcp'],results))))
"#;

impl OpenWebUiController {
    pub fn new() -> Self {
        Self::default()
    }

    fn phase(&self, generation: u64, phase: Phase, message: &str, active: bool) {
        if let Ok(mut job) = self.inner.job.lock() {
            if job.generation == generation {
                job.phase = phase;
                job.message = message.into();
                job.active = active;
            }
        }
    }
    fn cancelled(&self, generation: u64) -> bool {
        *self.inner.cancellation.borrow() != generation
    }
    fn cancellation(&self, generation: u64) -> Option<(watch::Receiver<u64>, u64)> {
        Some((self.inner.cancellation.subscribe(), generation))
    }

    pub async fn start(&self, config: &AppConfig) -> Result<OpenWebUiStatus, String> {
        let settings = Settings::from_config(config)?;
        let generation = {
            let mut job = self
                .inner
                .job
                .lock()
                .map_err(|_| "Open WebUI 시작 상태를 확인할 수 없습니다.")?;
            if job.active {
                None
            } else {
                job.generation += 1;
                job.active = true;
                job.phase = Phase::Pulling;
                job.message = "Docker를 확인하고 Open WebUI 이미지를 준비하고 있습니다.".into();
                self.inner.cancellation.send_replace(job.generation);
                Some(job.generation)
            }
        };
        let Some(generation) = generation else {
            return self.status(config).await;
        };
        let controller = self.clone();
        tokio::spawn(async move {
            match controller.start_inner(settings, generation).await {
                Ok(()) => controller.phase(
                    generation,
                    Phase::Starting,
                    "Open WebUI가 시작되었습니다. 데이터베이스와 로그인 화면을 확인하고 있습니다.",
                    false,
                ),
                Err(error) => controller.phase(generation, Phase::Error, &error, false),
            }
        });
        self.status(config).await
    }

    async fn start_inner(&self, settings: Settings, generation: u64) -> Result<(), String> {
        let docker = Docker::connect().await?;
        if self.cancelled(generation) {
            return Err("Open WebUI 시작이 취소되었습니다.".into());
        }
        if let Some(value) = docker.inspect().await? {
            if value["state"] == "running" {
                return Ok(());
            }
        } else {
            let available = std::net::TcpListener::bind(("127.0.0.1", 43180)).map_err(|_| {
                "43180 포트를 다른 프로그램이 사용 중입니다. 기존 프로그램을 변경하지 않았습니다."
            })?;
            drop(available);
            let cached = docker
                .run(
                    &[
                        "image".into(),
                        "inspect".into(),
                        IMAGE.into(),
                        "--format".into(),
                        "{{.Id}}".into(),
                    ],
                    Duration::from_secs(3),
                    self.cancellation(generation),
                    true,
                )
                .await
                .is_ok();
            if !cached {
                docker
                    .run(
                        &["pull".into(), IMAGE.into()],
                        Duration::from_secs(900),
                        self.cancellation(generation),
                        false,
                    )
                    .await?;
            }
        }
        let _operation = self.inner.operation.lock().await;
        if self.cancelled(generation) {
            return Err("Open WebUI 시작이 취소되었습니다.".into());
        }
        match docker.inspect().await? {
            Some(value) if value["state"] == "running" => return Ok(()),
            Some(_) => {}
            None => {
                if !docker.validate_volume().await? {
                    docker
                        .run(
                            &[
                                "volume".into(),
                                "create".into(),
                                "--label".into(),
                                format!("{OWNER_LABEL}=open-webui").into(),
                                "--label".into(),
                                format!("{SCHEMA_LABEL}=1").into(),
                                VOLUME.into(),
                            ],
                            Duration::from_secs(10),
                            self.cancellation(generation),
                            false,
                        )
                        .await?;
                }
                let env = settings.env_file()?;
                let args = vec![
                    "create".into(),
                    "--name".into(),
                    CONTAINER.into(),
                    "--label".into(),
                    format!("{OWNER_LABEL}=open-webui").into(),
                    "--label".into(),
                    format!("{SCHEMA_LABEL}=1").into(),
                    "--label".into(),
                    format!("{PROVIDER_LABEL}={}", settings.provider).into(),
                    "--label".into(),
                    format!("{MCP_LABEL}={}", settings.mcp.unwrap_or_default()).into(),
                    "--publish".into(),
                    "127.0.0.1:43180:8080".into(),
                    "--network".into(),
                    "bridge".into(),
                    "--mount".into(),
                    format!("type=volume,source={VOLUME},target=/app/backend/data").into(),
                    "--add-host".into(),
                    "host.docker.internal:host-gateway".into(),
                    "--restart".into(),
                    "unless-stopped".into(),
                    "--env-file".into(),
                    env.path().as_os_str().into(),
                    IMAGE.into(),
                ];
                docker
                    .run(
                        &args,
                        Duration::from_secs(20),
                        self.cancellation(generation),
                        false,
                    )
                    .await?;
                // The secret-bearing file is unlinked before the container starts.
                drop(env);
            }
        }
        let inspected = docker
            .inspect()
            .await?
            .ok_or("Open WebUI 컨테이너 소유권을 확인할 수 없습니다.")?;
        let id = container_id(&inspected)?;
        if self.cancelled(generation) {
            return Err("Open WebUI 시작이 취소되었습니다.".into());
        }
        let available = std::net::TcpListener::bind(("127.0.0.1", 43180)).map_err(|_| {
            "43180 포트를 다른 프로그램이 사용 중입니다. 기존 프로그램을 변경하지 않았습니다."
        })?;
        drop(available);
        self.phase(
            generation,
            Phase::Starting,
            "Open WebUI 컨테이너를 시작하고 있습니다.",
            true,
        );
        docker
            .run(
                &["start".into(), id.into()],
                Duration::from_secs(20),
                self.cancellation(generation),
                false,
            )
            .await?;
        Ok(())
    }

    pub async fn stop(&self, config: &AppConfig) -> Result<OpenWebUiStatus, String> {
        let generation = {
            let mut job = self
                .inner
                .job
                .lock()
                .map_err(|_| "Open WebUI 정지 상태를 확인할 수 없습니다.")?;
            job.generation += 1;
            job.active = false;
            job.phase = Phase::Stopped;
            job.message =
                "Open WebUI 시작이 취소되었거나 정지되었습니다. 대화 데이터는 보존됩니다.".into();
            self.inner.cancellation.send_replace(job.generation);
            job.generation
        };
        let _operation = self.inner.operation.lock().await;
        let result = async {
            let docker = Docker::connect().await?;
            if let Some(value) = docker.inspect().await? {
                if value["state"] == "running" || value["state"] == "restarting" {
                    docker
                        .run(
                            &[
                                "stop".into(),
                                "--time".into(),
                                "5".into(),
                                container_id(&value)?.into(),
                            ],
                            Duration::from_secs(10),
                            None,
                            false,
                        )
                        .await?;
                }
            }
            Ok::<(), String>(())
        }
        .await;
        if let Err(error) = result {
            self.phase(generation, Phase::Error, &error, false);
            return Err(error);
        }
        if let Ok(mut probes) = self.inner.probes.lock() {
            *probes = None;
        }
        self.status(config).await
    }

    pub async fn status(&self, config: &AppConfig) -> Result<OpenWebUiStatus, String> {
        let settings = Settings::from_config(config).ok();
        let (phase, message, active) = {
            let job = self
                .inner
                .job
                .lock()
                .map_err(|_| "Open WebUI 상태를 확인할 수 없습니다.")?;
            (job.phase, job.message.clone(), job.active)
        };
        let mut result = OpenWebUiStatus {
            status: phase,
            message,
            checked_at: chrono::Utc::now().to_rfc3339(),
            version: VERSION,
            url: URL,
            docker_available: false,
            container_running: false,
            setup_required: None,
            provider_url: settings.as_ref().map(|value| value.provider.clone()),
            mcp_url: settings.as_ref().and_then(|value| value.mcp.clone()),
            provider_reachable: None,
            mcp_reachable: None,
            can_open: false,
        };
        let docker = match Docker::connect().await {
            Ok(docker) => docker,
            Err(error) => {
                result.status = Phase::Error;
                result.message = error;
                return Ok(result);
            }
        };
        result.docker_available = true;
        let inspected = match docker.inspect().await {
            Ok(Some(inspected)) => inspected,
            Ok(None) => {
                if !active && result.status != Phase::Error {
                    result.status = Phase::Stopped;
                }
                return Ok(result);
            }
            Err(error) => {
                result.status = Phase::Error;
                result.message = error;
                return Ok(result);
            }
        };
        result.provider_url = inspected["labels"][PROVIDER_LABEL]
            .as_str()
            .map(str::to_string);
        result.mcp_url = inspected["labels"][MCP_LABEL]
            .as_str()
            .filter(|url| !url.is_empty())
            .map(str::to_string);
        result.container_running = inspected["state"] == "running";
        if !result.container_running {
            if inspected["state"] == "restarting" {
                result.status = Phase::Starting;
                result.message =
                    "Open WebUI 컨테이너가 재시작 중입니다. 준비 상태를 다시 확인하세요.".into();
                return Ok(result);
            }
            if inspected["exitCode"].as_i64().is_some_and(|code| code != 0) && !active {
                result.status = Phase::Error;
                result.message = "Open WebUI 컨테이너가 오류로 종료되었습니다. OrbStack 또는 Docker Desktop에서 해당 컨테이너 로그를 확인하세요.".into();
                return Ok(result);
            }
            if !active && result.status != Phase::Error {
                result.status = Phase::Stopped;
                result.message =
                    "Open WebUI가 정지되어 있습니다. 저장된 대화와 설정은 보존됩니다.".into();
            }
            return Ok(result);
        }
        let web_config = match config_probe().await {
            Ok(Some(config)) => config,
            Err(error) => {
                result.status = Phase::Error;
                result.message = error;
                return Ok(result);
            }
            Ok(None) => {
                let timed_out = inspected["startedAt"]
                    .as_str()
                    .and_then(|started| chrono::DateTime::parse_from_rfc3339(started).ok())
                    .is_some_and(|started| {
                        chrono::Utc::now()
                            .signed_duration_since(started)
                            .num_seconds()
                            > 300
                    });
                result.status = if timed_out {
                    Phase::Error
                } else {
                    Phase::Starting
                };
                result.message = if timed_out { "Open WebUI 준비 상태를 5분 동안 확인하지 못했습니다. 해당 컨테이너 로그와 데이터베이스 상태를 확인하세요." } else { "컨테이너가 실행 중입니다. Open WebUI 준비 상태와 로그인 설정을 확인하고 있습니다." }.into();
                return Ok(result);
            }
        };
        result.status = Phase::Ready;
        result.can_open = true;
        result.setup_required = Some(web_config["onboarding"] == true);
        result.message = if result.setup_required == Some(true) {
            "Open WebUI가 준비되었습니다. 처음 열면 관리자 계정을 직접 만드세요.".into()
        } else {
            "Open WebUI가 준비되었습니다. 저장된 계정으로 로그인하세요. 모델·MCP 주소는 최초 연결 설정이며 관리자 설정에서 변경할 수 있습니다.".into()
        };
        let id = container_id(&inspected)?.to_string();
        let provider = Url::parse(
            inspected["labels"][PROVIDER_LABEL]
                .as_str()
                .ok_or("Open WebUI 제공자 주소를 확인할 수 없습니다.")?,
        )
        .map_err(|_| "Open WebUI 제공자 주소 형식을 확인하세요.")?;
        let provider_host = &provider[url::Position::BeforeHost..url::Position::AfterPort];
        let cached = self.inner.probes.lock().ok().and_then(|cache| {
            cache
                .as_ref()
                .filter(|cache| {
                    cache.container_id == id && cache.at.elapsed() < Duration::from_secs(15)
                })
                .map(|cache| cache.result.clone())
        });
        let probes = if let Some(cached) = cached {
            cached
        } else {
            let probe = docker
                .run(
                    &[
                        "exec".into(),
                        id.clone().into(),
                        "python".into(),
                        "-c".into(),
                        format!("{PROBE_MCP_PARSER}\n{PROBE_CODE}").into(),
                        provider_host.into(),
                    ],
                    Duration::from_secs(5),
                    None,
                    true,
                )
                .await
                .ok()
                .and_then(|bytes| serde_json::from_slice::<ProbeResult>(&bytes).ok())
                .unwrap_or_default();
            if let Ok(mut cache) = self.inner.probes.lock() {
                *cache = Some(ProbeCache {
                    at: Instant::now(),
                    container_id: id,
                    result: probe.clone(),
                });
            }
            probe
        };
        result.provider_reachable = probes.provider;
        result.mcp_reachable = probes.mcp;
        result.checked_at = chrono::Utc::now().to_rfc3339();
        Ok(result)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> Value {
        json!({"id":"a".repeat(64),"name":format!("/{CONTAINER}"),"image":IMAGE,"labels":{OWNER_LABEL:"open-webui",SCHEMA_LABEL:"1",PROVIDER_LABEL:"http://127.0.0.1:10100/v1",MCP_LABEL:MCP_URL},"ports":{"8080/tcp":[{"HostIp":"127.0.0.1","HostPort":"43180"}]},"mounts":[{"Type":"volume","Name":VOLUME,"Destination":"/app/backend/data","RW":true}],"networkMode":"bridge","privileged":false,"pidMode":"","ipcMode":"private","devices":[],"capAdd":null,"securityEnv":"WEBUI_AUTH=True","corsEnv":format!("CORS_ALLOW_ORIGIN={URL}"),"state":"running"})
    }
    #[test]
    fn owned_container_requires_exact_network_image_auth_volume() {
        assert!(validate_container(&fixture()).is_ok());
        for (pointer, change) in [
            ("/image", json!("ghcr.io/open-webui/open-webui:main")),
            ("/ports/8080~1tcp/0/HostIp", json!("0.0.0.0")),
            ("/mounts/0/Type", json!("bind")),
            ("/mounts/0/Destination", json!("/var/run/docker.sock")),
            ("/privileged", json!(true)),
            ("/networkMode", json!("host")),
            ("/securityEnv", json!("auth-disabled")),
            ("/corsEnv", json!("CORS_ALLOW_ORIGIN=*")),
            (
                "/labels/kr.toris.studio.open-webui.mcp",
                json!("http://127.0.0.1:21228/mcp"),
            ),
        ] {
            let mut candidate = fixture();
            *candidate.pointer_mut(pointer).unwrap() = change;
            assert!(validate_container(&candidate).is_err(), "{pointer}");
        }
        let mut candidate = fixture();
        candidate["mounts"]
            .as_array_mut()
            .unwrap()
            .push(json!({"Type":"bind","Destination":"/projects"}));
        assert!(validate_container(&candidate).is_err());
    }
    #[test]
    fn endpoint_mapping_only_accepts_loopback_without_credentials() {
        assert_eq!(
            local_endpoint("http://localhost:10100/v1/", "/v1")
                .unwrap()
                .1,
            "http://host.docker.internal:10100/v1"
        );
        assert_eq!(
            local_endpoint("http://[::1]:21228/mcp", "/mcp").unwrap().1,
            "http://host.docker.internal:21228/mcp"
        );
        for invalid in [
            "http://127.0.0.1.example.com:10100/v1",
            "http://user:key@localhost:10100/v1",
            "https://localhost:10100/v1",
            "http://localhost:10100/v1?secret=yes",
            "http://192.168.1.2:10100/v1",
            "file:///v1",
            "http://localhost:10100/v1#fragment",
        ] {
            assert!(local_endpoint(invalid, "/v1").is_err(), "{invalid}");
        }
    }
    #[test]
    fn secret_env_is_private_and_cannot_inject_another_setting() {
        let config = AppConfig {
            opencodex_api_key: Some("test-key\nWEBUI_AUTH=False".into()),
            ..AppConfig::default()
        };
        assert!(Settings::from_config(&config).is_err());
        let settings = Settings {
            provider: "http://127.0.0.1:10100/v1".into(),
            container_provider: "http://host.docker.internal:10100/v1".into(),
            key: Some("literal=$value#secret".into()),
            mcp: None,
            container_mcp: None,
        };
        let file = settings.env_file().unwrap();
        let path = file.path().to_owned();
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(text.contains("OPENAI_API_KEY=literal=$value#secret\n"));
        assert!(text.contains("WEBUI_AUTH=True\n"));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
        drop(file);
        assert!(!path.exists());
    }
    #[test]
    fn provider_host_preserves_loopback_allowlist_and_ipv6_authority() {
        for (provider, host) in [
            ("http://127.0.0.1:10100/v1", "127.0.0.1:10100"),
            ("http://[::1]:10100/v1", "[::1]:10100"),
            ("http://localhost:10100/v1", "localhost:10100"),
        ] {
            let settings = Settings {
                provider: provider.into(),
                container_provider: "http://host.docker.internal:10100/v1".into(),
                key: None,
                mcp: None,
                container_mcp: None,
            };
            let file = settings.env_file().unwrap();
            let text = std::fs::read_to_string(file.path()).unwrap();
            let config = text
                .lines()
                .find_map(|line| line.strip_prefix("OPENAI_API_CONFIGS="))
                .unwrap();
            let parsed: Value = serde_json::from_str(config).unwrap();
            assert_eq!(parsed["0"]["headers"]["Host"], host);
        }
    }
    #[tokio::test]
    async fn actual_python_probe_parser_accepts_result_after_empty_sse_packet() {
        let fixtures = r#"
result='{"jsonrpc":"2.0","id":1,"result":{"serverInfo":{"name":"Codexify"}}}'
assert initialized(result)
assert initialized('event: message\ndata:\n\n: keepalive\n\nevent: message\ndata: '+result+'\n\n')
assert initialized('event: message\r\ndata: \r\n\r\nevent: message\r\ndata: '+result+'\r\n\r\n')
assert initialized('data: {"jsonrpc":"2.0","id":1,\ndata: "result":{"serverInfo":{"name":"Codexify"}}}\n\n')
assert not initialized('event: message\ndata:\n\n')
assert not initialized('data: '+result.replace('"id":1','"id":2')+'\n\n')
assert not initialized('data: {"id":1,"error":{"message":"failure"}}\n\n')
assert not initialized('data: '+result.replace('Codexify','OtherServer')+'\n\n')
"#;
        let executable = if cfg!(windows) { "python" } else { "python3" };
        let status = tokio::time::timeout(
            Duration::from_secs(5),
            Command::new(executable)
                .arg("-c")
                .arg(format!("{PROBE_MCP_PARSER}\n{fixtures}"))
                .kill_on_drop(true)
                .status(),
        )
        .await
        .expect("Python probe parser test timeout")
        .expect("Python is required to test the container probe parser");
        assert!(status.success());
    }
    #[test]
    fn serialized_status_has_no_api_key_or_admin_credentials() {
        let status = OpenWebUiStatus {
            status: Phase::Stopped,
            message: "stopped".into(),
            checked_at: "now".into(),
            version: VERSION,
            url: URL,
            docker_available: true,
            container_running: false,
            setup_required: None,
            provider_url: Some("http://localhost:10100/v1".into()),
            mcp_url: None,
            provider_reachable: None,
            mcp_reachable: None,
            can_open: false,
        };
        let value = serde_json::to_string(&status).unwrap();
        assert!(!value.contains("apiKey"));
        assert!(!value.contains("password"));
        assert!(!value.contains("Config.Env"));
    }
    #[tokio::test]
    async fn cancellation_generation_prevents_old_job_overwriting_new_status() {
        let controller = OpenWebUiController::new();
        controller.phase(0, Phase::Pulling, "old", true);
        controller.inner.job.lock().unwrap().generation = 1;
        controller.inner.cancellation.send_replace(1);
        controller.phase(0, Phase::Ready, "obsolete", false);
        assert!(controller.cancelled(0));
        assert_eq!(controller.inner.job.lock().unwrap().message, "old");
    }
}
