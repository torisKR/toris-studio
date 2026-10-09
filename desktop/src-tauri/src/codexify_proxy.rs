//! App-owned public MCP tunnels. Credentials remain in each provider's own CLI configuration.
use serde::{Deserialize, Serialize};
use std::{path::PathBuf, sync::Mutex, time::Duration};
use tokio::{io::AsyncReadExt, process::Child};
use url::Url;

#[derive(Clone, Copy, Default, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ProxyProvider {
    #[default]
    Cloudflare,
    Ngrok,
}
impl ProxyProvider {
    fn name(self) -> &'static str {
        match self {
            Self::Cloudflare => "Cloudflare",
            Self::Ngrok => "ngrok",
        }
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxyStatus {
    pub provider: ProxyProvider,
    pub available: bool,
    pub running: bool,
    pub managed: bool,
    pub mcp_url: Option<String>,
    pub message: String,
}
struct Running {
    child: Child,
    mcp_url: Option<String>,
    profile_mcp_url: String,
    readers: Vec<tokio::task::JoinHandle<()>>,
    // Explicit empty configuration prevents loading another user's named-tunnel credentials.
    _configuration: tempfile::NamedTempFile,
}
impl Drop for Running {
    fn drop(&mut self) {
        let _ = self.child.start_kill();
        for reader in &self.readers {
            reader.abort();
        }
    }
}
#[derive(Default)]
struct RunningProviders {
    cloudflare: Option<Running>,
    ngrok: Option<Running>,
}
impl RunningProviders {
    fn selected(&mut self, provider: ProxyProvider) -> &mut Option<Running> {
        match provider {
            ProxyProvider::Cloudflare => &mut self.cloudflare,
            ProxyProvider::Ngrok => &mut self.ngrok,
        }
    }
}
#[derive(Default)]
pub struct ProxyController {
    operation: tokio::sync::Mutex<()>,
    running: Mutex<RunningProviders>,
}

fn binary(provider: ProxyProvider) -> Option<PathBuf> {
    let name = match (provider, cfg!(windows)) {
        (ProxyProvider::Cloudflare, true) => "cloudflared.exe",
        (ProxyProvider::Cloudflare, false) => "cloudflared",
        (ProxyProvider::Ngrok, true) => "ngrok.exe",
        (ProxyProvider::Ngrok, false) => "ngrok",
    };
    let sibling = std::env::current_exe().ok()?.parent()?.join(name);
    if sibling.is_file() {
        return Some(sibling);
    }
    if provider == ProxyProvider::Ngrok || cfg!(debug_assertions) {
        let mut candidates = vec![
            PathBuf::from("/opt/homebrew/bin").join(name),
            PathBuf::from("/usr/local/bin").join(name),
        ];
        if let Some(home) = dirs::home_dir() {
            candidates.push(
                home.join(if provider == ProxyProvider::Ngrok {
                    ".ngrok/bin"
                } else {
                    ".cloudflared/bin"
                })
                .join(name),
            );
            if provider == ProxyProvider::Ngrok {
                #[cfg(windows)]
                {
                    candidates.push(home.join("scoop/apps/ngrok/current").join(name));
                    candidates.push(home.join("AppData/Local/Programs/ngrok").join(name));
                    candidates.push(PathBuf::from("C:/Program Files/ngrok").join(name));
                    // Chocolatey's bin entry is a process-spawning shim. Own the actual agent PID.
                    candidates.push(
                        PathBuf::from("C:/ProgramData/chocolatey/lib/ngrok/tools").join(name),
                    );
                    if let Some(local) = dirs::data_local_dir() {
                        candidates.push(local.join("Microsoft/WinGet/Links").join(name));
                        candidates.push(local.join("Programs/ngrok").join(name));
                    }
                }
            }
        }
        return candidates.into_iter().find(|path| path.is_file());
    }
    None
}
fn ngrok_public_url(raw: &str) -> Option<String> {
    public_endpoint(raw, ProxyProvider::Ngrok)
}
fn remove_environment(provider: ProxyProvider, key: &std::ffi::OsStr) -> bool {
    let key = key.to_string_lossy();
    let key = if cfg!(windows) {
        key.to_ascii_uppercase()
    } else {
        key.into_owned()
    };
    match provider {
        ProxyProvider::Cloudflare => {
            key.starts_with("TUNNEL_") || key == "NO_TLS_VERIFY" || key == "NO_AUTOUPDATE"
        }
        ProxyProvider::Ngrok => key.starts_with("NGROK_"),
    }
}
fn public_endpoint(raw: &str, provider: ProxyProvider) -> Option<String> {
    let url = Url::parse(raw).ok()?;
    let host = url.host_str()?;
    let suffixes: &[&str] = match provider {
        ProxyProvider::Cloudflare => &[".trycloudflare.com"],
        ProxyProvider::Ngrok => &[
            ".ngrok-free.app",
            ".ngrok-free.dev",
            ".ngrok.app",
            ".ngrok.dev",
            ".ngrok.io",
            ".ngrok.pizza",
            ".ngrok-free.pizza",
        ],
    };
    let label = suffixes
        .iter()
        .find_map(|suffix| host.strip_suffix(suffix))?;
    if url.scheme() != "https"
        || label.is_empty()
        || label.len() > 63
        || !label
            .bytes()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-')
        || label.starts_with('-')
        || label.ends_with('-')
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
        || url.path() != "/"
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return None;
    }
    Some(format!("https://{host}/mcp"))
}
fn public_url(line: &str) -> Option<String> {
    for text in line.split_whitespace() {
        let text = text.trim_matches(|c: char| matches!(c, '"' | '\'' | ',' | '(' | ')' | '|'));
        if let Some(endpoint) = public_endpoint(text, ProxyProvider::Cloudflare) {
            return Some(endpoint);
        }
    }
    None
}
fn origin(raw: &str, expected_port: u16) -> Result<Url, String> {
    let mut url = Url::parse(raw).map_err(|_| "로컬 MCP 주소를 확인하세요.")?;
    if !matches!(url.scheme(), "http" | "https")
        || !matches!(
            url.host_str(),
            Some("localhost" | "127.0.0.1" | "[::1]" | "::1")
        )
        || url.path() != "/mcp"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("프록시는 앱에 저장한 로컬 MCP 서버에만 연결할 수 있습니다.".into());
    }
    if url.port_or_known_default() != Some(expected_port) {
        return Err("로컬 MCP 주소와 Codexify 실행 포트가 다릅니다. 연결 설정의 MCP 주소를 실행 포트에 맞추세요.".into());
    }
    if url.host_str() == Some("localhost") {
        url.set_host(Some("127.0.0.1"))
            .map_err(|_| "로컬 MCP 주소 오류")?;
    }
    url.set_path("/");
    Ok(url)
}
async fn bounded_json(mut response: reqwest::Response) -> Option<serde_json::Value> {
    if !response.status().is_success() {
        return None;
    }
    let mut body = Vec::new();
    loop {
        match response.chunk().await {
            Ok(Some(chunk)) if body.len() + chunk.len() <= 16_384 => body.extend_from_slice(&chunk),
            Ok(None) => return serde_json::from_slice(&body).ok(),
            _ => return None,
        }
    }
}
fn dns_addresses(
    value: &serde_json::Value,
    host: &str,
    provider: ProxyProvider,
) -> Vec<std::net::SocketAddr> {
    use std::net::{IpAddr, Ipv4Addr, SocketAddr};
    if value["Status"] != 0 || public_endpoint(&format!("https://{host}"), provider).is_none() {
        return vec![];
    }
    value["Answer"]
        .as_array()
        .into_iter()
        .flatten()
        .take(16)
        .filter_map(|answer| {
            if answer["type"] != 1 || answer["name"].as_str()?.trim_end_matches('.') != host {
                return None;
            }
            let ip: Ipv4Addr = answer["data"].as_str()?.parse().ok()?;
            let [a, b, c, _] = ip.octets();
            if ip.is_private()
                || ip.is_loopback()
                || ip.is_link_local()
                || ip.is_broadcast()
                || ip.is_documentation()
                || a == 0
                || a >= 224
                || (a == 100 && (64..=127).contains(&b))
                || (a == 198 && (18..=19).contains(&b))
                || (a == 192 && b == 0 && c == 0)
            {
                return None;
            }
            Some(SocketAddr::new(IpAddr::V4(ip), 443))
        })
        .collect()
}
async fn public_health_client(host: &str, provider: ProxyProvider) -> Option<reqwest::Client> {
    // Some local resolvers cache NXDOMAIN for newly created Quick Tunnel names.
    // Resolve only this generated public host through Cloudflare's HTTPS DNS API;
    // preserve the URL hostname, TLS verification and the system DNS settings.
    let dns = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(4))
        .build()
        .ok()?;
    let response = dns
        .get("https://cloudflare-dns.com/dns-query")
        .query(&[("name", host), ("type", "A")])
        .header("Accept", "application/dns-json")
        .send()
        .await
        .ok()?;
    let addresses = dns_addresses(&bounded_json(response).await?, host, provider);
    if addresses.is_empty() {
        return None;
    }
    reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(5))
        .resolve_to_addrs(host, &addresses)
        .build()
        .ok()
}
async fn read_urls<R: tokio::io::AsyncRead + Unpin>(
    mut stream: R,
    sender: tokio::sync::mpsc::Sender<StartupEvent>,
) {
    let mut bytes = [0u8; 1024];
    let mut pending = Vec::new();
    let mut found = false;
    while let Ok(n) = stream.read(&mut bytes).await {
        if n == 0 {
            break;
        }
        if found {
            continue;
        }
        for byte in &bytes[..n] {
            if *byte == b'\n' {
                if let Some(url) = public_url(&String::from_utf8_lossy(&pending)) {
                    let _ = sender.try_send(StartupEvent::Endpoint(url));
                    found = true;
                }
                pending.clear();
            } else if pending.len() < 4096 {
                pending.push(*byte);
            }
        }
    }
}

enum StartupEvent {
    Endpoint(String),
    Failure(&'static str),
}
fn ngrok_failure(line: &str) -> Option<&'static str> {
    if line.contains("ERR_NGROK_108") || line.contains("ERR_NGROK_109") {
        Some("ngrok 계정의 동시 세션 한도에 도달했습니다. 기존 ngrok 연결은 유지했습니다. 계정의 세션을 확인하거나 Cloudflare를 선택하세요.")
    } else if [
        "ERR_NGROK_4018",
        "ERR_NGROK_105",
        "ERR_NGROK_106",
        "ERR_NGROK_107",
    ]
    .iter()
    .any(|code| line.contains(code))
    {
        Some("ngrok 계정 인증이 필요합니다. 공식 ngrok 설정에서 계정을 인증한 뒤 다시 시작하세요. 인증 토큰은 앱이나 채팅에 입력하지 마세요.")
    } else {
        None
    }
}
fn ngrok_address_matches(value: &serde_json::Value, expected: &Url) -> bool {
    let Some(port) = expected.port_or_known_default() else {
        return false;
    };
    let Some(host) = expected.host_str() else {
        return false;
    };
    let mut authorities = vec![
        expected[url::Position::BeforeHost..url::Position::AfterPort].to_owned(),
        format!("{host}:{port}"),
    ];
    if host == "127.0.0.1" {
        authorities.push(format!("localhost:{port}"));
        if expected.port().is_none() {
            authorities.push("localhost".into());
        }
    }
    let parsed = if let Some(raw) = value.as_str() {
        if !authorities
            .iter()
            .map(|authority| format!("{}://{authority}", expected.scheme()))
            .any(|origin| raw == origin || raw == format!("{origin}/"))
        {
            return false;
        }
        Url::parse(raw).ok()
    } else if let Some(fields) = value.as_object() {
        // The installed agent serializes net/url.URL, including every URL component.
        // Reject extra or missing fields instead of dropping aliases or URL metadata.
        const FIELDS: [&str; 11] = [
            "Scheme",
            "Opaque",
            "User",
            "Host",
            "Path",
            "Fragment",
            "RawQuery",
            "RawPath",
            "RawFragment",
            "ForceQuery",
            "OmitHost",
        ];
        if fields.len() != FIELDS.len()
            || !FIELDS.iter().all(|key| fields.contains_key(*key))
            || fields["Scheme"].as_str() != Some(expected.scheme())
            || !fields["User"].is_null()
            || fields["ForceQuery"].as_bool() != Some(false)
            || fields["OmitHost"].as_bool() != Some(false)
            || ["Opaque", "Fragment", "RawQuery", "RawPath", "RawFragment"]
                .iter()
                .any(|key| fields[*key].as_str() != Some(""))
            || !matches!(fields["Path"].as_str(), Some("" | "/"))
        {
            return false;
        }
        let Some(host) = fields["Host"].as_str() else {
            return false;
        };
        // Restrict the authority before parsing so it cannot encode user info or a path.
        if !authorities.iter().any(|authority| host == authority) {
            return false;
        }
        Url::parse(&format!("{}://{host}/", expected.scheme())).ok()
    } else {
        None
    };
    let Some(mut addr) = parsed else {
        return false;
    };
    if addr.host_str() == Some("localhost") && addr.set_host(Some("127.0.0.1")).is_err() {
        return false;
    }
    addr == *expected
}
fn ngrok_event(line: &str, expected: &Url, accept_url: bool) -> Option<StartupEvent> {
    if let Some(message) = ngrok_failure(line) {
        return Some(StartupEvent::Failure(message));
    }
    let value: serde_json::Value = serde_json::from_str(line).ok()?;
    if matches!(value["lvl"].as_str(), Some("eror" | "error" | "crit")) {
        return Some(StartupEvent::Failure("ngrok 연결을 시작하지 못했습니다. 계정 설정, 기존 세션, 인터넷 연결을 확인하세요. 다른 ngrok 연결은 변경하지 않았습니다."));
    }
    // This is accepted only from this child process's JSON stdout, never an external agent API.
    if !accept_url
        || value["msg"].as_str() != Some("started tunnel")
        || value["obj"].as_str() != Some("tunnels")
    {
        return None;
    }
    if !ngrok_address_matches(&value["addr"], expected) {
        return None;
    }
    ngrok_public_url(value["url"].as_str()?).map(StartupEvent::Endpoint)
}
async fn read_ngrok<R: tokio::io::AsyncRead + Unpin>(
    mut stream: R,
    expected: Url,
    accept_url: bool,
    sender: tokio::sync::mpsc::Sender<StartupEvent>,
) {
    let mut bytes = [0u8; 1024];
    let mut pending = Vec::new();
    let mut oversized = false;
    let mut done = false;
    while let Ok(n) = stream.read(&mut bytes).await {
        if n == 0 {
            break;
        }
        if done {
            continue;
        }
        for byte in &bytes[..n] {
            if *byte == b'\n' {
                if !oversized {
                    if let Some(event) =
                        ngrok_event(&String::from_utf8_lossy(&pending), &expected, accept_url)
                    {
                        let _ = sender.try_send(event);
                        done = true;
                    }
                }
                pending.clear();
                oversized = false;
            } else if pending.len() < 16_384 {
                pending.push(*byte);
            } else {
                oversized = true;
            }
        }
    }
    if !done && !oversized && !pending.is_empty() {
        if let Some(event) = ngrok_event(&String::from_utf8_lossy(&pending), &expected, accept_url)
        {
            let _ = sender.try_send(event);
        }
    }
}
fn ngrok_configuration() -> Result<(PathBuf, tempfile::NamedTempFile), String> {
    use std::io::{BufRead, BufReader, Read};
    let home = dirs::home_dir().ok_or("사용자 ngrok 설정 폴더를 찾지 못했습니다.")?;
    let mut candidates = Vec::new();
    #[cfg(target_os = "macos")]
    candidates.push(home.join("Library/Application Support/ngrok/ngrok.yml"));
    #[cfg(target_os = "windows")]
    {
        if let Some(local) = dirs::data_local_dir() {
            candidates.push(local.join("ngrok/ngrok.yml"));
        }
        candidates.push(home.join("AppData/Local/ngrok/ngrok.yml"));
    }
    candidates.push(home.join(".config/ngrok/ngrok.yml"));
    candidates.push(home.join(".ngrok2/ngrok.yml"));
    let path = candidates.into_iter().find(|path| std::fs::symlink_metadata(path).is_ok_and(|m| m.is_file() && !m.file_type().is_symlink()))
        .ok_or("ngrok 계정 설정이 없습니다. 공식 ngrok CLI에서 계정을 인증한 뒤 다시 시작하세요. 인증 토큰은 앱이나 채팅에 입력하지 마세요.")?;
    let metadata =
        std::fs::metadata(&path).map_err(|_| "ngrok 설정 파일을 확인하지 못했습니다.")?;
    if metadata.len() > 262_144 {
        return Err("ngrok 설정 파일이 너무 큽니다. 공식 ngrok 설정을 확인하세요.".into());
    }
    // Inspect only the schema version; credentials are never extracted or serialized.
    let file = std::fs::File::open(&path).map_err(|_| "ngrok 설정 파일을 읽지 못했습니다.")?;
    let mut reader = BufReader::new(file.take(262_145));
    let mut line = String::new();
    let mut consumed = 0;
    let mut version = None;
    while consumed <= 262_144 {
        line.clear();
        let count = reader
            .read_line(&mut line)
            .map_err(|_| "ngrok 설정 버전을 확인하지 못했습니다.")?;
        if count == 0 {
            break;
        }
        consumed += count;
        if let Some(raw) = line.strip_prefix("version:") {
            let raw = raw
                .split('#')
                .next()
                .unwrap_or("")
                .trim()
                .trim_matches(['\'', '"']);
            version = match raw {
                "2" => Some(2),
                "3" => Some(3),
                _ => None,
            };
            break;
        }
    }
    let version = version.ok_or(
        "ngrok 설정 버전을 확인하지 못했습니다. 공식 ngrok CLI의 config check로 설정을 확인하세요.",
    )?;
    let configuration = tempfile::Builder::new()
        .suffix(".yml")
        .tempfile()
        .map_err(|_| "ngrok 실행 설정을 만들지 못했습니다.")?;
    let overlay = if version == 3 {
        "version: 3\nagent:\n  web_addr: false\n  console_ui: false\n  update_check: false\n  remote_management: false\n  crl_noverify: false\n  log: stdout\n  log_format: json\n  log_level: info\n"
    } else {
        "version: 2\nweb_addr: false\nconsole_ui: false\nupdate_check: false\nremote_management: false\ncrl_noverify: false\nlog: stdout\nlog_format: json\nlog_level: info\n"
    };
    std::fs::write(configuration.path(), overlay)
        .map_err(|_| "ngrok 실행 설정을 저장하지 못했습니다.")?;
    Ok((path, configuration))
}
fn save_endpoint(url: &str, provider: ProxyProvider) -> Result<(), String> {
    let path = crate::config::config_path()
        .parent()
        .ok_or("앱 저장 폴더 오류")?
        .join(if provider == ProxyProvider::Cloudflare {
            "codexify-proxy.json"
        } else {
            "codexify-proxy-ngrok.json"
        });
    std::fs::create_dir_all(path.parent().unwrap())
        .map_err(|_| "프록시 주소 저장 폴더를 만들지 못했습니다.")?;
    if let Ok(meta) = std::fs::symlink_metadata(&path) {
        if !meta.is_file() {
            return Err("프록시 주소 저장 파일을 확인하세요.".into());
        }
    }
    let mut temporary = tempfile::NamedTempFile::new_in(path.parent().unwrap())
        .map_err(|_| "프록시 주소를 저장하지 못했습니다.")?;
    serde_json::to_writer(
        &mut temporary,
        &serde_json::json!({"mcpUrl":url,"provider":provider,"kind":if provider == ProxyProvider::Cloudflare {"cloudflare-quick-tunnel"} else {"ngrok-https-tunnel"}}),
    )
    .map_err(|_| "프록시 주소를 저장하지 못했습니다.")?;
    temporary
        .as_file()
        .sync_all()
        .map_err(|_| "프록시 주소 저장 실패")?;
    temporary
        .persist(path)
        .map_err(|_| "프록시 주소 저장 실패")?;
    Ok(())
}
impl ProxyController {
    fn snapshot(&self, provider: ProxyProvider) -> Result<ProxyStatus, String> {
        let mut providers = self.running.lock().map_err(|_| "프록시 상태 잠금 오류")?;
        let state = providers.selected(provider);
        if state
            .as_mut()
            .is_some_and(|child| !matches!(child.child.try_wait(), Ok(None)))
        {
            state.take();
        }
        let running = state.is_some();
        let target_changed = state.as_ref().is_some_and(|child| {
            crate::codexify_connection::load()
                .map(|profile| profile.mcp_url != child.profile_mcp_url)
                .unwrap_or(true)
        });
        let url = state
            .as_ref()
            .filter(|_| !target_changed)
            .and_then(|child| child.mcp_url.clone());
        Ok(ProxyStatus {
            provider,
            available: binary(provider).is_some(),
            running,
            managed: running,
            mcp_url: url.clone(),
            message: if target_changed {
                "로컬 MCP 주소가 변경됐습니다. 앱 프록시를 종료하고 현재 연결로 다시 시작하세요."
            } else if url.is_some() {
                "공개 MCP 주소를 저장했습니다. ChatGPT 플러그인 등록 화면에서 이 주소를 사용하세요."
            } else if running {
                "선택한 프록시의 공개 주소를 준비하고 있습니다."
            } else {
                "시작을 누르면 선택한 프록시를 열고 공개 MCP 주소를 저장합니다."
            }
            .into(),
        })
    }
    pub async fn status(&self) -> Result<ProxyStatus, String> {
        self.snapshot(ProxyProvider::Cloudflare)
    }
    pub async fn status_for(&self, provider: ProxyProvider) -> Result<ProxyStatus, String> {
        self.snapshot(provider)
    }
    pub async fn start(&self, expected_port: u16) -> Result<ProxyStatus, String> {
        self.start_for(ProxyProvider::Cloudflare, expected_port)
            .await
    }
    pub async fn start_for(
        &self,
        provider: ProxyProvider,
        expected_port: u16,
    ) -> Result<ProxyStatus, String> {
        let _operation = self.operation.lock().await;
        let profile = crate::codexify_connection::load()?;
        let target = origin(&profile.mcp_url, expected_port)?;
        let current = self.snapshot(provider)?;
        if current.running {
            if current.mcp_url.is_none() {
                return Err(current.message);
            }
            return Ok(current);
        }
        let executable = binary(provider).ok_or(match provider {
            ProxyProvider::Cloudflare => "앱에 포함된 Cloudflare 실행 파일을 찾지 못했습니다. 공식 설치 파일로 업데이트하세요.",
            ProxyProvider::Ngrok => "ngrok 실행 파일이 없습니다. 공식 ngrok CLI를 설치하고 계정을 인증한 뒤 다시 시작하세요. macOS에서는 Homebrew, Windows에서는 공식 설치 프로그램을 사용할 수 있습니다.",
        })?;
        let checked = crate::codexify_connection::check().await?;
        if checked["reachable"] != true || checked["serverName"].as_str() != Some("codexify") {
            return Err("로컬 Codexify 연결을 확인한 뒤 프록시를 시작하세요.".into());
        }
        if crate::codexify_connection::load()?.mcp_url != profile.mcp_url {
            return Err(
                "연결 확인 중 MCP 주소가 변경됐습니다. 현재 연결을 확인하고 다시 시작하세요."
                    .into(),
            );
        }
        let mut command = tokio::process::Command::new(executable);
        let configuration = match provider {
            ProxyProvider::Cloudflare => {
                let configuration = tempfile::Builder::new()
                    .suffix(".yml")
                    .tempfile()
                    .map_err(|_| "프록시 실행 설정을 만들지 못했습니다.")?;
                std::fs::write(configuration.path(), b"{}\n")
                    .map_err(|_| "프록시 실행 설정 저장 실패")?;
                command
                    .args(["tunnel", "--no-autoupdate", "--config"])
                    .arg(configuration.path())
                    .args([
                        "--url",
                        target.as_str(),
                        "--protocol",
                        "http2",
                        "--metrics",
                        "127.0.0.1:0",
                        "--loglevel",
                        "info",
                    ]);
                // Never inherit origin or credential overrides for a fresh Quick Tunnel.
                for (key, _) in std::env::vars_os() {
                    if remove_environment(ProxyProvider::Cloudflare, &key) {
                        command.env_remove(key);
                    }
                }
                configuration
            }
            ProxyProvider::Ngrok => {
                let (existing, configuration) = ngrok_configuration()?;
                command
                    .arg("http")
                    .arg(target.as_str())
                    .arg("--config")
                    .arg(existing)
                    .arg("--config")
                    .arg(configuration.path())
                    .args([
                        "--log",
                        "stdout",
                        "--log-format",
                        "json",
                        "--log-level",
                        "info",
                        "--inspect=false",
                        "--upstream-tls-verify=true",
                    ]);
                // Let ngrok read the unchanged user's config itself; never inject or expose auth values.
                for (key, _) in std::env::vars_os() {
                    if remove_environment(ProxyProvider::Ngrok, &key) {
                        command.env_remove(key);
                    }
                }
                configuration
            }
        };
        command
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true);
        #[cfg(windows)]
        command.creation_flags(0x08000000);
        let mut child = command
            .spawn()
            .map_err(|_| format!("{} 프록시를 시작하지 못했습니다.", provider.name()))?;
        let (sender, mut receiver) = tokio::sync::mpsc::channel(2);
        let stderr = child
            .stderr
            .take()
            .ok_or("프록시 상태를 확인하지 못했습니다.")?;
        let stdout = child
            .stdout
            .take()
            .ok_or("프록시 상태를 확인하지 못했습니다.")?;
        let readers = match provider {
            ProxyProvider::Cloudflare => vec![
                tokio::spawn(read_urls(stderr, sender.clone())),
                tokio::spawn(read_urls(stdout, sender)),
            ],
            ProxyProvider::Ngrok => vec![
                tokio::spawn(read_ngrok(stderr, target.clone(), false, sender.clone())),
                tokio::spawn(read_ngrok(stdout, target.clone(), true, sender)),
            ],
        };
        *self
            .running
            .lock()
            .map_err(|_| "프록시 상태 잠금 오류")?
            .selected(provider) = Some(Running {
            child,
            mcp_url: None,
            profile_mcp_url: profile.mcp_url.clone(),
            readers,
            _configuration: configuration,
        });
        let ready = async {
            let event = tokio::time::timeout(Duration::from_secs(35), receiver.recv()).await
                .map_err(|_| format!("{} 공개 주소 생성이 지연됐습니다. 인터넷 연결과 계정 설정을 확인하고 다시 시작하세요.",provider.name()))?
                .ok_or("프록시가 공개 주소를 만들기 전에 종료됐습니다. 계정과 기존 세션을 확인하세요.")?;
            let endpoint = match event { StartupEvent::Endpoint(endpoint) => endpoint, StartupEvent::Failure(message) => return Err(message.to_owned()) };
            let health = endpoint.strip_suffix("/mcp").ok_or("공개 주소 형식 오류")?.to_owned() + "/health";
            let mut client = reqwest::Client::builder().no_proxy().redirect(reqwest::redirect::Policy::none()).timeout(Duration::from_secs(5)).build().map_err(|_| "프록시 검증 초기화 실패")?;
            let host = Url::parse(&endpoint).map_err(|_| "공개 주소 형식 오류")?.host_str().ok_or("공개 주소 형식 오류")?.to_owned();
            let mut dns_resolved = false;
            let mut next_dns_check = tokio::time::Instant::now();
            let mut verified = false;
            let deadline = tokio::time::Instant::now() + Duration::from_secs(25);
            let mut reason = "응답 없음".to_string();
            // The URL is printed before Cloudflare has finished registering its edge connection.
            while tokio::time::Instant::now() < deadline {
                let mut request = client.get(&health);
                if provider == ProxyProvider::Ngrok { request = request.header("ngrok-skip-browser-warning", "1"); }
                match request.send().await {
                    Ok(response) => {
                        reason = format!("HTTP {}", response.status().as_u16());
                        if bounded_json(response).await.is_some_and(|value| value["status"] == "ok" && value["tools"].as_u64().is_some()) {
                            verified = true; break;
                        }
                    }
                    Err(error) => {
                        reason = if error.is_timeout() { "연결 시간 초과" } else { "DNS 또는 HTTPS 연결 실패" }.into();
                        if error.is_connect() && !dns_resolved && tokio::time::Instant::now() >= next_dns_check {
                            next_dns_check = tokio::time::Instant::now() + Duration::from_secs(4);
                            if let Some(resolved) = public_health_client(&host, provider).await { client = resolved; dns_resolved = true; }
                        }
                    }
                }
                tokio::time::sleep(Duration::from_secs(1)).await;
            }
            if !verified { return Err(format!("공개 프록시 연결을 확인하지 못했습니다 ({reason}). 인터넷 연결을 확인하고 다시 시작하세요.")); }
            if crate::codexify_connection::load()?.mcp_url != profile.mcp_url {
                return Err("프록시 연결 중 MCP 주소가 변경됐습니다. 현재 연결로 다시 시작하세요.".into());
            }
            save_endpoint(&endpoint, provider)?;
            let mut state = self.running.lock().map_err(|_| "프록시 상태 잠금 오류")?;
            let active = state.selected(provider).as_mut().ok_or("프록시 실행이 취소됐습니다.")?;
            if !matches!(active.child.try_wait(), Ok(None)) { return Err("프록시가 종료됐습니다.".into()); }
            active.mcp_url = Some(endpoint);
            Ok::<_, String>(())
        }.await;
        if let Err(error) = ready {
            self.shutdown_for(provider);
            return Err(error);
        }
        self.snapshot(provider)
    }
    /// Compatibility stop used by runtime shutdown: stop both app-owned providers.
    pub async fn stop(&self) -> Result<ProxyStatus, String> {
        let _operation = self.operation.lock().await;
        self.stop_selected(ProxyProvider::Cloudflare).await?;
        self.stop_selected(ProxyProvider::Ngrok).await?;
        self.snapshot(ProxyProvider::Cloudflare)
    }
    pub async fn stop_for(&self, provider: ProxyProvider) -> Result<ProxyStatus, String> {
        let _operation = self.operation.lock().await;
        self.stop_selected(provider).await?;
        self.snapshot(provider)
    }
    async fn stop_selected(&self, provider: ProxyProvider) -> Result<(), String> {
        let mut child = self
            .running
            .lock()
            .map_err(|_| "프록시 상태 잠금 오류")?
            .selected(provider)
            .take();
        if let Some(active) = child.as_mut() {
            let _ = active.child.start_kill();
            let _ = tokio::time::timeout(Duration::from_secs(3), active.child.wait()).await;
        }
        drop(child);
        Ok(())
    }
    fn shutdown_for(&self, provider: ProxyProvider) {
        self.running
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .selected(provider)
            .take();
    }
    pub fn shutdown(&self) {
        let mut state = self
            .running
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        state.cloudflare.take();
        state.ngrok.take();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn provider_defaults_to_cloudflare_and_rejects_unknown_values() {
        assert_eq!(ProxyProvider::default(), ProxyProvider::Cloudflare);
        assert_eq!(
            serde_json::from_str::<ProxyProvider>("\"ngrok\"").unwrap(),
            ProxyProvider::Ngrok
        );
        assert!(serde_json::from_str::<ProxyProvider>("\"other\"").is_err());
    }
    #[test]
    fn credentials_environment_respects_windows_case_insensitive_names() {
        use std::ffi::OsStr;
        assert!(remove_environment(
            ProxyProvider::Ngrok,
            OsStr::new("NGROK_AUTHTOKEN")
        ));
        assert!(remove_environment(
            ProxyProvider::Cloudflare,
            OsStr::new("TUNNEL_TOKEN")
        ));
        assert!(!remove_environment(
            ProxyProvider::Ngrok,
            OsStr::new("PATH")
        ));
        for key in ["ngrok_authtoken", "Ngrok_Api_Key"] {
            assert_eq!(
                remove_environment(ProxyProvider::Ngrok, OsStr::new(key)),
                cfg!(windows)
            );
        }
        for key in ["tunnel_token", "no_tls_verify", "No_AutoUpdate"] {
            assert_eq!(
                remove_environment(ProxyProvider::Cloudflare, OsStr::new(key)),
                cfg!(windows)
            );
        }
    }
    #[test]
    fn ngrok_endpoint_requires_owned_stdout_event_local_addr_and_official_https_domain() {
        let target = origin("http://127.0.0.1:21228/mcp", 21228).unwrap();
        let event = serde_json::json!({"lvl":"info","msg":"started tunnel","obj":"tunnels","addr":"http://127.0.0.1:21228","url":"https://sample.ngrok-free.dev"});
        assert!(
            matches!(ngrok_event(&event.to_string(),&target,true),Some(StartupEvent::Endpoint(ref url)) if url == "https://sample.ngrok-free.dev/mcp")
        );
        assert!(ngrok_event(&event.to_string(), &target, false).is_none());
        for field in [
            "http://127.0.0.1:3120",
            "http://127.0.0.1:43157",
            "http://example.com:21228",
        ] {
            let mut stale = event.clone();
            stale["addr"] = serde_json::json!(field);
            assert!(ngrok_event(&stale.to_string(), &target, true).is_none());
        }
        let mut unrelated = event.clone();
        unrelated["msg"] = serde_json::json!("metadata");
        assert!(ngrok_event(&unrelated.to_string(), &target, true).is_none());
        for invalid in [
            "https://one.trycloudflare.com",
            "http://sample.ngrok-free.dev",
            "https://sample.ngrok-free.dev.evil.test",
            "https://token@sample.ngrok-free.dev",
            "https://a.b.ngrok-free.dev",
            "https://sample.ngrok-free.dev/owner",
            "https://sample.ngrok-free.dev?token=private",
            "https://sample.ngrok-free.dev:8443",
        ] {
            let mut stale = event.clone();
            stale["url"] = serde_json::json!(invalid);
            assert!(ngrok_event(&stale.to_string(), &target, true).is_none());
        }
        for domain in [
            "ngrok-free.app",
            "ngrok-free.dev",
            "ngrok.app",
            "ngrok.dev",
            "ngrok.io",
            "ngrok.pizza",
            "ngrok-free.pizza",
        ] {
            assert!(ngrok_public_url(&format!("https://sample.{domain}")).is_some());
        }
    }
    #[test]
    fn ngrok_serialized_url_object_preserves_every_component_and_matches_exact_upstream() {
        let target = origin("http://127.0.0.1:21228/mcp", 21228).unwrap();
        let address = serde_json::json!({
            "Scheme":"http", "Opaque":"", "User":null, "Host":"127.0.0.1:21228",
            "Path":"/", "Fragment":"", "RawQuery":"", "RawPath":"",
            "RawFragment":"", "ForceQuery":false, "OmitHost":false
        });
        let event = serde_json::json!({"lvl":"info","msg":"started tunnel","obj":"tunnels","addr":address,"url":"https://sample.ngrok-free.dev"});
        assert!(matches!(
            ngrok_event(&event.to_string(), &target, true),
            Some(StartupEvent::Endpoint(_))
        ));
        for (field, invalid) in [
            ("Scheme", serde_json::json!("https")),
            ("Opaque", serde_json::json!("127.0.0.1:21228")),
            ("User", serde_json::json!({"Username":"private"})),
            ("Path", serde_json::json!("/a/..")),
            ("Path", serde_json::json!("/owner")),
            ("Fragment", serde_json::json!("private")),
            ("RawQuery", serde_json::json!("token=private")),
            ("RawPath", serde_json::json!("/")),
            ("RawFragment", serde_json::json!("private")),
            ("ForceQuery", serde_json::json!(true)),
            ("OmitHost", serde_json::json!(true)),
            ("ForceQuery", serde_json::json!("false")),
            ("Host", serde_json::json!("127.0.0.1:43157")),
            ("Host", serde_json::json!("127.0.0.1:21228/a/..")),
            ("Host", serde_json::json!("@127.0.0.1:21228")),
            ("Host", serde_json::json!("127.0.0.1:21228?")),
            ("Host", serde_json::json!("127.0.0.1:21228#")),
            ("Host", serde_json::json!("127.0.0.1:21228\\")),
        ] {
            let mut invalid_address = address.clone();
            invalid_address[field] = invalid;
            assert!(
                !ngrok_address_matches(&invalid_address, &target),
                "field: {field}"
            );
        }
        for alias in ["user", "rawQuery", "metadata", "url"] {
            let mut invalid = address.clone();
            invalid[alias] = serde_json::json!("private");
            assert!(!ngrok_address_matches(&invalid, &target));
        }
        let mut missing = address.clone();
        missing.as_object_mut().unwrap().remove("User");
        assert!(!ngrok_address_matches(&missing, &target));
        for raw in [
            "http://@127.0.0.1:21228/",
            "http://127.0.0.1:21228/a/..",
            "http://127.0.0.1:21228/?",
            "http://127.0.0.1:21228/#",
        ] {
            assert!(!ngrok_address_matches(&serde_json::json!(raw), &target));
        }
        for (raw, port, host) in [
            ("https://127.0.0.1:21228/mcp", 21228, "127.0.0.1:21228"),
            ("https://[::1]:21228/mcp", 21228, "[::1]:21228"),
            ("https://[::1]/mcp", 443, "[::1]"),
            ("http://localhost:21228/mcp", 21228, "localhost:21228"),
        ] {
            let expected = origin(raw, port).unwrap();
            let mut addr = address.clone();
            addr["Scheme"] = serde_json::json!(expected.scheme());
            addr["Host"] = serde_json::json!(host);
            assert!(ngrok_address_matches(&addr, &expected));
            assert!(ngrok_address_matches(
                &serde_json::json!(format!("{}://{host}/", expected.scheme())),
                &expected
            ));
        }
    }
    /// Explicit network verification: exposes only this test's health JSON, never an MCP server.
    #[tokio::test]
    #[ignore = "requires explicit approval for a temporary public health-only ngrok fixture"]
    async fn ngrok_cli_health_only_fixture_matches_real_stdout_and_stops_owned_child() {
        use tokio::io::AsyncWriteExt;
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let fixture = tokio::spawn(async move {
            while let Ok((mut socket, _)) = listener.accept().await {
                let mut request = [0u8; 1024];
                let Ok(Ok(n)) =
                    tokio::time::timeout(Duration::from_secs(2), socket.read(&mut request)).await
                else {
                    continue;
                };
                let (status, body) = if request[..n].starts_with(b"GET /health HTTP/") {
                    ("200 OK", "{\"status\":\"ok\",\"tools\":0}")
                } else {
                    ("404 Not Found", "{\"error\":\"fixture-only\"}")
                };
                let response = format!("HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
                let _ = socket.write_all(response.as_bytes()).await;
            }
        });
        let target = origin(&format!("http://127.0.0.1:{port}/mcp"), port).unwrap();
        let (existing, configuration) = ngrok_configuration().unwrap();
        let mut command = tokio::process::Command::new(
            binary(ProxyProvider::Ngrok).expect("trusted ngrok CLI is unavailable"),
        );
        command
            .arg("http")
            .arg(target.as_str())
            .arg("--config")
            .arg(existing)
            .arg("--config")
            .arg(configuration.path())
            .args([
                "--log",
                "stdout",
                "--log-format",
                "json",
                "--log-level",
                "info",
                "--inspect=false",
                "--upstream-tls-verify=true",
            ])
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true);
        for (key, _) in std::env::vars_os() {
            if remove_environment(ProxyProvider::Ngrok, &key) {
                command.env_remove(key);
            }
        }
        let mut child = command
            .spawn()
            .expect("owned health fixture agent did not start");
        let (sender, mut receiver) = tokio::sync::mpsc::channel(2);
        let readers = vec![
            tokio::spawn(read_ngrok(
                child.stdout.take().unwrap(),
                target.clone(),
                true,
                sender.clone(),
            )),
            tokio::spawn(read_ngrok(
                child.stderr.take().unwrap(),
                target.clone(),
                false,
                sender,
            )),
        ];
        let mut owned = Running {
            child,
            mcp_url: None,
            profile_mcp_url: String::new(),
            readers,
            _configuration: configuration,
        };
        let endpoint = match tokio::time::timeout(Duration::from_secs(35), receiver.recv()).await {
            Ok(Some(StartupEvent::Endpoint(endpoint))) => endpoint,
            _ => panic!("real agent stdout did not yield a verified fixture endpoint"),
        };
        let mut health = Url::parse(&endpoint).unwrap();
        health.set_path("/health");
        let client = reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(12))
            .build()
            .unwrap();
        let response = client
            .get(health)
            .header("ngrok-skip-browser-warning", "1")
            .send()
            .await
            .expect("fixture HTTPS health request failed");
        let result = bounded_json(response)
            .await
            .expect("fixture health exceeded bounds or returned invalid JSON");
        assert_eq!(result, serde_json::json!({"status":"ok","tools":0}));
        owned.child.start_kill().unwrap();
        tokio::time::timeout(Duration::from_secs(3), owned.child.wait())
            .await
            .expect("owned agent stop timed out")
            .unwrap();
        assert!(owned.child.try_wait().unwrap().is_some());
        fixture.abort();
    }
    #[test]
    fn ngrok_errors_never_return_raw_auth_values_or_remote_output() {
        for text in [
            "ERR_NGROK_108 private-token-value",
            "ERR_NGROK_4018 private-token-value",
        ] {
            let result = ngrok_failure(text).unwrap();
            assert!(!result.contains("private-token-value"));
        }
        let target = origin("http://127.0.0.1:21228/mcp", 21228).unwrap();
        let event = serde_json::json!({"lvl":"eror","msg":"private-secret-error","err":"private-token-value"});
        assert!(
            matches!(ngrok_event(&event.to_string(),&target,true),Some(StartupEvent::Failure(message)) if !message.contains("private-"))
        );
    }
    #[tokio::test]
    async fn oversized_ngrok_json_line_is_skipped_and_stderr_cannot_supply_endpoint() {
        let target = origin("http://127.0.0.1:21228/mcp", 21228).unwrap();
        let event=serde_json::json!({"lvl":"info","msg":"started tunnel","obj":"tunnels","addr":"http://127.0.0.1:21228","url":"https://sample.ngrok-free.dev","metadata":"x".repeat(20_000)}).to_string()+"\n";
        let (sender, mut receiver) = tokio::sync::mpsc::channel(2);
        read_ngrok(event.as_bytes(), target.clone(), true, sender).await;
        assert!(receiver.recv().await.is_none());
        let event=serde_json::json!({"lvl":"info","msg":"started tunnel","obj":"tunnels","addr":"http://127.0.0.1:21228","url":"https://sample.ngrok-free.dev"}).to_string()+"\n";
        let (sender, mut receiver) = tokio::sync::mpsc::channel(2);
        read_ngrok(event.as_bytes(), target, false, sender).await;
        assert!(receiver.recv().await.is_none());
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn stopping_one_provider_preserves_the_other_owned_process_and_shutdown_stops_both() {
        fn running() -> Running {
            let child = tokio::process::Command::new("/bin/sleep")
                .arg("60")
                .kill_on_drop(true)
                .spawn()
                .unwrap();
            Running {
                child,
                mcp_url: None,
                profile_mcp_url: String::new(),
                readers: vec![],
                _configuration: tempfile::NamedTempFile::new().unwrap(),
            }
        }
        let controller = ProxyController::default();
        {
            let mut state = controller.running.lock().unwrap();
            state.cloudflare = Some(running());
            state.ngrok = Some(running());
        }
        controller.stop_for(ProxyProvider::Ngrok).await.unwrap();
        assert!(
            !controller
                .status_for(ProxyProvider::Ngrok)
                .await
                .unwrap()
                .running
        );
        assert!(
            controller
                .status_for(ProxyProvider::Cloudflare)
                .await
                .unwrap()
                .running
        );
        {
            let mut state = controller.running.lock().unwrap();
            state.ngrok = Some(running());
        }
        controller.shutdown_for(ProxyProvider::Cloudflare);
        assert!(
            !controller
                .status_for(ProxyProvider::Cloudflare)
                .await
                .unwrap()
                .running
        );
        assert!(
            controller
                .status_for(ProxyProvider::Ngrok)
                .await
                .unwrap()
                .running
        );
        controller.shutdown();
        assert!(
            !controller
                .status_for(ProxyProvider::Ngrok)
                .await
                .unwrap()
                .running
        );
    }
    #[test]
    fn dns_fallback_accepts_only_expected_public_records() {
        let value = serde_json::json!({"Status":0,"Answer":[
            {"name":"apple.trycloudflare.com.","type":1,"data":"104.16.230.132"},
            {"name":"another.trycloudflare.com","type":1,"data":"104.16.231.132"},
            {"name":"apple.trycloudflare.com","type":1,"data":"127.0.0.1"},
            {"name":"apple.trycloudflare.com","type":1,"data":"10.0.0.1"},
            {"name":"apple.trycloudflare.com","type":1,"data":"100.64.0.1"},
            {"name":"apple.trycloudflare.com","type":1,"data":"169.254.1.1"},
            {"name":"apple.trycloudflare.com","type":1,"data":"192.0.2.1"},
            {"name":"apple.trycloudflare.com","type":1,"data":"198.18.0.1"},
            {"name":"apple.trycloudflare.com","type":1,"data":"224.0.0.1"}
        ]});
        assert_eq!(
            dns_addresses(&value, "apple.trycloudflare.com", ProxyProvider::Cloudflare),
            vec!["104.16.230.132:443".parse().unwrap()]
        );
        assert!(dns_addresses(&value, "localhost", ProxyProvider::Cloudflare).is_empty());
        assert!(dns_addresses(
            &serde_json::json!({"Status":3,"Answer":value["Answer"]}),
            "apple.trycloudflare.com",
            ProxyProvider::Cloudflare
        )
        .is_empty());
    }
    #[test]
    fn only_public_cloudflare_origin_becomes_mcp_endpoint() {
        assert_eq!(
            public_url("INF | https://apple-moon.trycloudflare.com |"),
            Some("https://apple-moon.trycloudflare.com/mcp".into())
        );
        for value in [
            "http://apple.trycloudflare.com",
            "https://apple.trycloudflare.com.evil.test",
            "https://token@apple.trycloudflare.com",
            "https://a.b.trycloudflare.com",
            "https://apple.trycloudflare.com/?token=secret",
            "https://apple.trycloudflare.com/owner",
            "https://apple.trycloudflare.com:8443",
        ] {
            assert!(public_url(value).is_none(), "{value}");
        }
    }
    #[test]
    fn proxy_only_for_local_mcp_not_owner_or_remote_service() {
        assert_eq!(
            origin("http://localhost:21228/mcp", 21228)
                .unwrap()
                .as_str(),
            "http://127.0.0.1:21228/"
        );
        for value in [
            "https://example.com/mcp",
            "http://127.0.0.1:3120",
            "http://secret@localhost:21228/mcp",
            "http://localhost:21228/mcp?token=x",
        ] {
            assert!(origin(value, 21228).is_err());
        }
        assert!(origin("http://localhost:43157/mcp", 21228).is_err());
    }
    #[tokio::test]
    async fn oversized_process_line_is_bounded_and_never_a_secret_output() {
        let data = vec![b'x'; 40_000];
        let (sender, mut receiver) = tokio::sync::mpsc::channel(2);
        read_urls(data.as_slice(), sender).await;
        assert!(receiver.recv().await.is_none());
    }
    #[tokio::test]
    async fn stop_never_adopts_or_terminates_external_tunnel() {
        let controller = ProxyController::default();
        let result = controller.stop().await.unwrap();
        assert!(!result.running && !result.managed && result.mcp_url.is_none());
    }
}
