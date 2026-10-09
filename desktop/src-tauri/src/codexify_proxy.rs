//! App-owned Cloudflare Quick Tunnel. Public endpoints and private owner chat are separate.
use serde::Serialize;
use std::{path::PathBuf, sync::Mutex, time::Duration};
use tokio::{io::AsyncReadExt, process::Child};
use url::Url;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxyStatus {
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
pub struct ProxyController {
    operation: tokio::sync::Mutex<()>,
    running: Mutex<Option<Running>>,
}

fn binary() -> Option<PathBuf> {
    let name = if cfg!(windows) {
        "cloudflared.exe"
    } else {
        "cloudflared"
    };
    let sibling = std::env::current_exe().ok()?.parent()?.join(name);
    if sibling.is_file() {
        return Some(sibling);
    }
    if cfg!(debug_assertions) {
        let mut candidates = vec![
            PathBuf::from("/opt/homebrew/bin/cloudflared"),
            PathBuf::from("/usr/local/bin/cloudflared"),
        ];
        if let Some(home) = dirs::home_dir() {
            candidates.push(home.join(".cloudflared/bin").join(name));
        }
        return candidates.into_iter().find(|path| path.is_file());
    }
    None
}
fn public_url(line: &str) -> Option<String> {
    for text in line.split_whitespace() {
        let text = text.trim_matches(|c: char| matches!(c, '"' | '\'' | ',' | '(' | ')' | '|'));
        let Ok(url) = Url::parse(text) else { continue };
        let Some(host) = url.host_str() else { continue };
        let Some(label) = host.strip_suffix(".trycloudflare.com") else {
            continue;
        };
        if url.scheme() == "https"
            && !label.is_empty()
            && label.len() <= 63
            && label
                .bytes()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-')
            && !label.starts_with('-')
            && !label.ends_with('-')
            && url.username().is_empty()
            && url.password().is_none()
            && url.port().is_none()
            && url.path() == "/"
            && url.query().is_none()
            && url.fragment().is_none()
        {
            return Some(format!("https://{host}/mcp"));
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
fn dns_addresses(value: &serde_json::Value, host: &str) -> Vec<std::net::SocketAddr> {
    use std::net::{IpAddr, Ipv4Addr, SocketAddr};
    if value["Status"] != 0 || public_url(&format!("https://{host}")).is_none() {
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
async fn public_health_client(host: &str) -> Option<reqwest::Client> {
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
    let addresses = dns_addresses(&bounded_json(response).await?, host);
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
    sender: tokio::sync::mpsc::Sender<String>,
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
                    let _ = sender.try_send(url);
                    found = true;
                }
                pending.clear();
            } else if pending.len() < 4096 {
                pending.push(*byte);
            }
        }
    }
}
fn save_endpoint(url: &str) -> Result<(), String> {
    let path = crate::config::config_path()
        .parent()
        .ok_or("앱 저장 폴더 오류")?
        .join("codexify-proxy.json");
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
        &serde_json::json!({"mcpUrl":url,"kind":"cloudflare-quick-tunnel"}),
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
    fn snapshot(&self) -> Result<ProxyStatus, String> {
        let mut state = self.running.lock().map_err(|_| "프록시 상태 잠금 오류")?;
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
            available: binary().is_some(),
            running,
            managed: running,
            mcp_url: url.clone(),
            message: if target_changed {
                "로컬 MCP 주소가 변경됐습니다. 앱 프록시를 종료하고 현재 연결로 다시 시작하세요."
            } else if url.is_some() {
                "공개 MCP 주소를 저장했습니다. ChatGPT 플러그인 등록 화면에서 이 주소를 사용하세요."
            } else if running {
                "Cloudflare 공개 주소를 준비하고 있습니다."
            } else {
                "시작을 누르면 Cloudflare 프록시를 열고 공개 MCP 주소를 저장합니다."
            }
            .into(),
        })
    }
    pub async fn status(&self) -> Result<ProxyStatus, String> {
        self.snapshot()
    }
    pub async fn start(&self, expected_port: u16) -> Result<ProxyStatus, String> {
        let _operation = self.operation.lock().await;
        let profile = crate::codexify_connection::load()?;
        let target = origin(&profile.mcp_url, expected_port)?;
        let current = self.snapshot()?;
        if current.running {
            if current.mcp_url.is_none() {
                return Err(current.message);
            }
            return Ok(current);
        }
        let executable = binary().ok_or(
            "앱에 포함된 Cloudflare 실행 파일을 찾지 못했습니다. 공식 설치 파일로 업데이트하세요.",
        )?;
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
        let configuration = tempfile::Builder::new()
            .suffix(".yml")
            .tempfile()
            .map_err(|_| "프록시 실행 설정을 만들지 못했습니다.")?;
        std::fs::write(configuration.path(), b"{}\n").map_err(|_| "프록시 실행 설정 저장 실패")?;
        let mut command = tokio::process::Command::new(executable);
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
            ])
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true);
        // Never inherit Cloudflare auth, origin overrides or verbose file logging from the app environment.
        for (key, _) in std::env::vars_os() {
            if key.to_string_lossy().starts_with("TUNNEL_")
                || key == "NO_TLS_VERIFY"
                || key == "NO_AUTOUPDATE"
            {
                command.env_remove(key);
            }
        }
        #[cfg(windows)]
        command.creation_flags(0x08000000);
        let mut child = command
            .spawn()
            .map_err(|_| "Cloudflare 프록시를 시작하지 못했습니다.")?;
        let (sender, mut receiver) = tokio::sync::mpsc::channel(2);
        let stderr = child
            .stderr
            .take()
            .ok_or("프록시 상태를 확인하지 못했습니다.")?;
        let stdout = child
            .stdout
            .take()
            .ok_or("프록시 상태를 확인하지 못했습니다.")?;
        let readers = vec![
            tokio::spawn(read_urls(stderr, sender.clone())),
            tokio::spawn(read_urls(stdout, sender)),
        ];
        *self.running.lock().map_err(|_| "프록시 상태 잠금 오류")? = Some(Running {
            child,
            mcp_url: None,
            profile_mcp_url: profile.mcp_url.clone(),
            readers,
            _configuration: configuration,
        });
        let ready = async {
            let endpoint = tokio::time::timeout(Duration::from_secs(35), receiver.recv()).await
                .map_err(|_| "Cloudflare 공개 주소 생성이 지연됐습니다. 인터넷 연결을 확인하고 다시 시작하세요.")?
                .ok_or("Cloudflare 프록시가 주소를 만들기 전에 종료됐습니다.")?;
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
                match client.get(&health).send().await {
                    Ok(response) => {
                        reason = format!("HTTP {}", response.status().as_u16());
                        if bounded_json(response).await.is_some_and(|value| value["status"] == "ok") {
                            verified = true; break;
                        }
                    }
                    Err(error) => {
                        reason = if error.is_timeout() { "연결 시간 초과" } else { "DNS 또는 HTTPS 연결 실패" }.into();
                        if error.is_connect() && !dns_resolved && tokio::time::Instant::now() >= next_dns_check {
                            next_dns_check = tokio::time::Instant::now() + Duration::from_secs(4);
                            if let Some(resolved) = public_health_client(&host).await { client = resolved; dns_resolved = true; }
                        }
                    }
                }
                tokio::time::sleep(Duration::from_secs(1)).await;
            }
            if !verified { return Err(format!("공개 프록시 연결을 확인하지 못했습니다 ({reason}). 인터넷 연결을 확인하고 다시 시작하세요.")); }
            if crate::codexify_connection::load()?.mcp_url != profile.mcp_url {
                return Err("프록시 연결 중 MCP 주소가 변경됐습니다. 현재 연결로 다시 시작하세요.".into());
            }
            save_endpoint(&endpoint)?;
            let mut state = self.running.lock().map_err(|_| "프록시 상태 잠금 오류")?;
            let active = state.as_mut().ok_or("프록시 실행이 취소됐습니다.")?;
            if !matches!(active.child.try_wait(), Ok(None)) { return Err("Cloudflare 프록시가 종료됐습니다.".into()); }
            active.mcp_url = Some(endpoint);
            Ok::<_, String>(())
        }.await;
        if let Err(error) = ready {
            self.shutdown();
            return Err(error);
        }
        self.snapshot()
    }
    pub async fn stop(&self) -> Result<ProxyStatus, String> {
        let _operation = self.operation.lock().await;
        let mut child = self
            .running
            .lock()
            .map_err(|_| "프록시 상태 잠금 오류")?
            .take();
        if let Some(active) = child.as_mut() {
            let _ = active.child.start_kill();
            let _ = tokio::time::timeout(Duration::from_secs(3), active.child.wait()).await;
        }
        drop(child);
        self.snapshot()
    }
    pub fn shutdown(&self) {
        if let Ok(mut state) = self.running.lock() {
            state.take();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
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
            dns_addresses(&value, "apple.trycloudflare.com"),
            vec!["104.16.230.132:443".parse().unwrap()]
        );
        assert!(dns_addresses(&value, "localhost").is_empty());
        assert!(dns_addresses(
            &serde_json::json!({"Status":3,"Answer":value["Answer"]}),
            "apple.trycloudflare.com"
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
