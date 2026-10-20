//! Studio-owned browser preferences and runtime supervisor.
//! Only native code receives authentication URLs; stdout is a bounded private protocol.
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    io::Write,
    path::{Path, PathBuf},
    sync::{Arc, Mutex as StdMutex, OnceLock},
    time::{Duration, Instant},
};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, Command},
    sync::{mpsc, Mutex},
};

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum BrowserChoice {
    System,
    #[default]
    Playwright,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PreferencesInput {
    pub browser: BrowserChoice,
}
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct BrowserStatus {
    pub preference: BrowserChoice,
    pub effective_browser: BrowserChoice,
    pub available: bool,
    pub reason: Option<String>,
    pub phase: &'static str,
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Preferences {
    browser: BrowserChoice,
}
fn settings_path() -> PathBuf {
    crate::config::config_path().with_file_name("browser-settings.json")
}
fn data_directory() -> Result<PathBuf, String> {
    settings_path()
        .parent()
        .map(Path::to_path_buf)
        .ok_or_else(|| "브라우저 저장 폴더를 찾을 수 없습니다.".into())
}
fn read_preferences(path: &Path) -> Result<BrowserChoice, String> {
    match std::fs::read(path) {
        Ok(bytes) if bytes.len() <= 4096 => serde_json::from_slice::<Preferences>(&bytes)
            .map(|p| p.browser)
            .map_err(|_| "브라우저 설정 파일을 확인하세요.".into()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(BrowserChoice::Playwright),
        _ => Err("브라우저 설정을 읽을 수 없습니다.".into()),
    }
}
fn write_preferences(path: &Path, browser: BrowserChoice) -> Result<(), String> {
    let parent = path.parent().ok_or("브라우저 설정 경로를 확인하세요.")?;
    std::fs::create_dir_all(parent).map_err(|_| "브라우저 설정 폴더를 만들 수 없습니다.")?;
    let mut file = tempfile::NamedTempFile::new_in(parent)
        .map_err(|_| "브라우저 설정을 저장할 수 없습니다.")?;
    serde_json::to_writer(&mut file, &Preferences { browser })
        .map_err(|_| "브라우저 설정을 저장할 수 없습니다.")?;
    file.flush()
        .map_err(|_| "브라우저 설정을 저장할 수 없습니다.")?;
    file.as_file()
        .sync_all()
        .map_err(|_| "브라우저 설정을 저장할 수 없습니다.")?;
    file.persist(path)
        .map_err(|_| "브라우저 설정을 교체할 수 없습니다.")?;
    #[cfg(unix)]
    std::fs::File::open(parent)
        .and_then(|f| f.sync_all())
        .map_err(|_| "브라우저 설정을 동기화할 수 없습니다.")?;
    Ok(())
}
fn route(preference: BrowserChoice, available: bool, auth: bool) -> BrowserChoice {
    if auth || !available {
        BrowserChoice::System
    } else {
        preference
    }
}
/// This conservative policy also covers providers outside Studio's configured accounts.
fn is_auth_url(raw: &str) -> bool {
    let Ok(url) = url::Url::parse(raw) else {
        return false;
    };
    let host = url.host_str().unwrap_or("").to_ascii_lowercase();
    if [
        "accounts.google.com",
        "login.microsoftonline.com",
        "login.live.com",
        "appleid.apple.com",
        "nid.naver.com",
        "kauth.kakao.com",
    ]
    .contains(&host.as_str())
    {
        return true;
    }
    let decoded = decode_path(url.path());
    let segments: Vec<_> = decoded
        .split('/')
        .filter(|s| !s.is_empty())
        .map(|s| s.to_ascii_lowercase())
        .collect();
    if segments.iter().any(|s| {
        matches!(
            s.as_str(),
            "oauth"
                | "oauth2"
                | "oauth2.0"
                | "authorize"
                | "authorization"
                | "signin"
                | "login"
                | "auth"
        )
    }) {
        return true;
    }
    let keys: Vec<_> = url
        .query_pairs()
        .map(|(key, _)| key.to_ascii_lowercase())
        .collect();
    keys.iter().any(|key| {
        matches!(
            key.as_str(),
            "client_id" | "response_type" | "code_challenge" | "redirect_uri"
        )
    }) || (keys.iter().any(|key| key == "state")
        && keys
            .iter()
            .any(|key| matches!(key.as_str(), "code" | "token" | "access_token" | "id_token")))
}
fn decode_path(path: &str) -> String {
    let bytes = path.as_bytes();
    let mut output = Vec::new();
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            if let (Some(high), Some(low)) = (
                (bytes[index + 1] as char).to_digit(16),
                (bytes[index + 2] as char).to_digit(16),
            ) {
                output.push((high * 16 + low) as u8);
                index += 3;
                continue;
            }
        }
        output.push(bytes[index]);
        index += 1;
    }
    String::from_utf8_lossy(&output).into_owned()
}
fn supports_os(os: &str, major: u32, build: u32) -> bool {
    match os {
        "macos" => major >= 14,
        "windows" => major >= 10 && build >= 22000,
        _ => false,
    }
}
fn os_supported() -> bool {
    #[cfg(target_os = "macos")]
    {
        let output = std::process::Command::new("/usr/bin/sw_vers")
            .arg("-productVersion")
            .output();
        return output
            .ok()
            .filter(|o| o.status.success())
            .and_then(|o| String::from_utf8(o.stdout).ok())
            .and_then(|s| s.split('.').next()?.parse().ok())
            .is_some_and(|major| supports_os("macos", major, 0));
    }
    #[cfg(target_os = "windows")]
    {
        #[repr(C)]
        struct Version {
            size: u32,
            major: u32,
            minor: u32,
            build: u32,
            platform: u32,
            service: [u16; 128],
        }
        #[link(name = "ntdll")]
        unsafe extern "system" {
            fn RtlGetVersion(info: *mut Version) -> i32;
        }
        let mut version = Version {
            size: std::mem::size_of::<Version>() as u32,
            major: 0,
            minor: 0,
            build: 0,
            platform: 0,
            service: [0; 128],
        };
        return unsafe { RtlGetVersion(&mut version) } == 0
            && supports_os("windows", version.major, version.build);
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        false
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn normal_links_default_to_playwright_and_unsupported_hosts_fall_back() {
        assert_eq!(
            route(BrowserChoice::Playwright, true, false),
            BrowserChoice::Playwright
        );
        assert_eq!(
            route(BrowserChoice::Playwright, false, false),
            BrowserChoice::System
        );
        assert_eq!(
            route(BrowserChoice::System, true, false),
            BrowserChoice::System
        );
    }
    #[test]
    fn authentication_always_uses_system_browser() {
        for raw in [
            "https://accounts.google.com/o/oauth2/v2/auth?state=secret",
            "https://www.facebook.com/v22.0/dialog/oauth",
            "https://nid.naver.com/oauth2.0/authorize",
            "https://www.tiktok.com/v2/auth/authorize/",
            "https://example.com/oauth/authorize",
            "https://example.com/connect?client_id=abc&response_type=code",
        ] {
            assert!(is_auth_url(raw), "{raw}");
            assert_eq!(
                route(BrowserChoice::Playwright, true, is_auth_url(raw)),
                BrowserChoice::System
            );
        }
        assert!(!is_auth_url("https://example.com/articles/oauth-policy"));
        assert!(!is_auth_url("http://127.0.0.1:9876/page"));
    }
    #[test]
    fn preferences_persist_separately_without_touching_existing_settings() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("browser-settings.json");
        std::fs::write(temp.path().join("settings.json"), b"existing 0.1.24 data").unwrap();
        assert_eq!(read_preferences(&path).unwrap(), BrowserChoice::Playwright);
        write_preferences(&path, BrowserChoice::System).unwrap();
        assert_eq!(read_preferences(&path).unwrap(), BrowserChoice::System);
        write_preferences(&path, BrowserChoice::Playwright).unwrap();
        assert_eq!(read_preferences(&path).unwrap(), BrowserChoice::Playwright);
        assert_eq!(
            std::fs::read(temp.path().join("settings.json")).unwrap(),
            b"existing 0.1.24 data"
        );
        assert_eq!(std::fs::read_dir(temp.path()).unwrap().count(), 2);
    }
    #[test]
    fn invalid_preferences_do_not_silently_reset_user_choice() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("browser-settings.json");
        std::fs::write(&path, br#"{"browser":"aside"}"#).unwrap();
        assert!(read_preferences(&path).is_err());
        assert!(serde_json::from_str::<BrowserChoice>("\"aside\"").is_err());
    }
    #[tokio::test]
    async fn unsupported_runtime_routes_without_spawning_and_shutdown_gates_opens() {
        let temp = tempfile::tempdir().unwrap();
        let manager = Supervisor::new(temp.path().canonicalize().unwrap(), Budget::default());
        let opened = Arc::new(StdMutex::new(Vec::new()));
        let calls = opened.clone();
        manager
            .open(
                "https://example.com/".into(),
                BrowserChoice::Playwright,
                None,
                Arc::new(move |url| {
                    calls.lock().unwrap().push(url);
                    Ok(())
                }),
            )
            .await
            .unwrap();
        assert_eq!(*opened.lock().unwrap(), vec!["https://example.com/"]);
        assert!(!temp.path().join("browser-runtime-owner.json").exists());
        manager.shutdown().await.unwrap();
        assert!(manager
            .open(
                "https://example.com/".into(),
                BrowserChoice::System,
                None,
                Arc::new(|_| panic!("opened during shutdown"))
            )
            .await
            .is_err());
        manager.resume().unwrap();
        manager
            .open(
                "https://example.com/".into(),
                BrowserChoice::System,
                None,
                Arc::new(|_| Ok(())),
            )
            .await
            .unwrap();
    }
    #[tokio::test]
    async fn invalid_urls_do_not_reach_any_browser_or_leak_secrets() {
        let temp = tempfile::tempdir().unwrap();
        let manager = Supervisor::new(temp.path().canonicalize().unwrap(), Budget::default());
        for url in [
            "javascript:alert(1)",
            "https://user:secret@example.com/",
            "http://evil.example/",
            "https://example.com/\nsecret",
        ] {
            let error = manager
                .open(
                    url.into(),
                    BrowserChoice::System,
                    None,
                    Arc::new(|_| panic!("invalid URL opened")),
                )
                .await
                .unwrap_err();
            assert!(!error.contains("secret"));
        }
    }
    #[test]
    fn unconfirmed_previous_runtime_requires_recovery_before_relaunch() {
        let temp = tempfile::tempdir().unwrap();
        std::fs::write(
            temp.path().join("browser-runtime-owner.json"),
            b"owned previous runtime",
        )
        .unwrap();
        let manager = Supervisor::new(temp.path().canonicalize().unwrap(), Budget::default());
        assert_eq!(manager.phase(), "recovery_required");
        assert!(manager.resume().is_err());
    }
    fn fixture(source: &str) -> (tempfile::TempDir, Runtime) {
        let temp = tempfile::tempdir().unwrap();
        let worker = temp.path().join("fixture.mjs");
        std::fs::write(&worker, source).unwrap();
        (
            temp,
            Runtime {
                node: PathBuf::from("node"),
                worker,
                chrome: PathBuf::from("unused-fixture-browser"),
            },
        )
    }
    #[tokio::test]
    async fn real_worker_protocol_reuses_process_and_confirms_shutdown() {
        let (temp, runtime) = fixture(
            r#"import readline from 'node:readline';
console.log(JSON.stringify({event:'ready'}));
readline.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line); if(m.command==='shutdown'){console.log(JSON.stringify({event:'closed'}));process.exit(0)} console.log(JSON.stringify({id:m.id,ok:true}));});"#,
        );
        let manager = Supervisor::new(temp.path().canonicalize().unwrap(), Budget::default());
        let system: SystemOpen = Arc::new(|_| panic!("ordinary link went to system"));
        manager
            .open(
                "https://example.com/first".into(),
                BrowserChoice::Playwright,
                Some(runtime.clone()),
                system.clone(),
            )
            .await
            .unwrap();
        let pid = manager
            .worker
            .lock()
            .await
            .as_ref()
            .unwrap()
            .child
            .id()
            .unwrap();
        manager
            .open(
                "https://example.com/second".into(),
                BrowserChoice::Playwright,
                Some(runtime),
                system,
            )
            .await
            .unwrap();
        assert_eq!(
            manager.worker.lock().await.as_ref().unwrap().child.id(),
            Some(pid)
        );
        assert!(temp.path().join("browser-runtime-owner.json").exists());
        manager.shutdown().await.unwrap();
        assert_eq!(manager.phase(), "idle");
        assert!(!temp.path().join("browser-runtime-owner.json").exists());
    }
    #[tokio::test]
    async fn startup_timeout_without_browser_confirmation_blocks_retry() {
        let (temp, runtime) = fixture("setInterval(()=>{},1000)");
        let manager = Supervisor::new(
            temp.path().canonicalize().unwrap(),
            Budget {
                launch: Duration::from_millis(100),
                shutdown: Duration::from_millis(100),
            },
        );
        assert!(manager
            .open(
                "https://example.com/".into(),
                BrowserChoice::Playwright,
                Some(runtime),
                Arc::new(|_| Ok(()))
            )
            .await
            .is_err());
        assert_eq!(manager.phase(), "recovery_required");
        assert!(temp.path().join("browser-runtime-owner.json").exists());
    }
    #[tokio::test]
    async fn auth_events_are_native_only_deduplicated_and_non_auth_events_rejected() {
        let (temp, runtime) = fixture(
            r#"import readline from 'node:readline';
console.log(JSON.stringify({event:'ready'}));
readline.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.command==='shutdown'){console.log(JSON.stringify({event:'closed'}));process.exit(0)} for(let i=0;i<2;i++)console.log(JSON.stringify({event:'system_open',url:'https://accounts.google.com/o/oauth2/auth?state=private'}));console.log(JSON.stringify({id:m.id,ok:true}));});"#,
        );
        let manager = Supervisor::new(temp.path().canonicalize().unwrap(), Budget::default());
        let calls = Arc::new(StdMutex::new(Vec::new()));
        let captured = calls.clone();
        manager
            .open(
                "https://example.com/".into(),
                BrowserChoice::Playwright,
                Some(runtime),
                Arc::new(move |url| {
                    captured.lock().unwrap().push(url);
                    Ok(())
                }),
            )
            .await
            .unwrap();
        assert_eq!(calls.lock().unwrap().len(), 1);
        assert_eq!(
            calls.lock().unwrap()[0],
            "https://accounts.google.com/o/oauth2/auth?state=private"
        );
        manager.shutdown().await.unwrap();
    }
    #[test]
    fn encoded_authentication_and_callbacks_never_enter_playwright() {
        for raw in [
            "https://example.com/%6f%61uth/authorize",
            "https://example.com/return?code=private&state=private",
            "https://example.com/return?ACCESS_TOKEN=private&STATE=private",
            "https://example.com/connect?CLIENT_ID=private",
            "https://nid.naver.com/",
            "https://kauth.kakao.com/",
        ] {
            assert!(is_auth_url(raw), "{raw}");
        }
    }
    #[tokio::test]
    async fn shutdown_interrupts_startup_before_its_launch_deadline() {
        let (temp, runtime) = fixture("setInterval(()=>{},1000)");
        let manager = Arc::new(Supervisor::new(
            temp.path().canonicalize().unwrap(),
            Budget {
                launch: Duration::from_secs(30),
                shutdown: Duration::from_secs(1),
            },
        ));
        let opening = manager.clone();
        let task = tokio::spawn(async move {
            opening
                .open(
                    "https://example.com/".into(),
                    BrowserChoice::Playwright,
                    Some(runtime),
                    Arc::new(|_| Ok(())),
                )
                .await
        });
        while !temp.path().join("browser-runtime-owner.json").exists() {
            tokio::task::yield_now().await;
        }
        tokio::time::timeout(Duration::from_secs(2), manager.shutdown())
            .await
            .expect("shutdown waited for startup deadline")
            .unwrap_err();
        assert!(task.await.unwrap().is_err());
        assert_eq!(manager.phase(), "recovery_required");
    }
    #[tokio::test]
    async fn recovery_allows_system_links_but_blocks_runtime_launch() {
        let (temp, runtime) = fixture("process.exit(99)");
        std::fs::write(
            temp.path().join("browser-runtime-owner.json"),
            b"previous runtime",
        )
        .unwrap();
        let manager = Supervisor::new(temp.path().canonicalize().unwrap(), Budget::default());
        manager
            .open(
                "https://example.com/".into(),
                BrowserChoice::System,
                Some(runtime.clone()),
                Arc::new(|_| Ok(())),
            )
            .await
            .unwrap();
        assert!(manager
            .open(
                "https://example.com/".into(),
                BrowserChoice::Playwright,
                Some(runtime),
                Arc::new(|_| panic!("fallback bypassed recovery"))
            )
            .await
            .is_err());
        assert_eq!(manager.phase(), "recovery_required");
    }
    #[cfg(unix)]
    #[test]
    fn profile_symlink_and_symlinked_parent_are_rejected() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        std::fs::create_dir(root.join("personal")).unwrap();
        std::os::unix::fs::symlink(root.join("personal"), root.join("linked")).unwrap();
        assert!(create_private_profile(&root.join("linked")).is_err());
        assert!(create_private_profile(&root.join("linked/nested")).is_err());
        assert!(!root.join("personal/nested").exists());
    }
    #[tokio::test]
    async fn malformed_worker_output_cannot_open_unapproved_system_links() {
        for source in ["console.log('x'.repeat(70000));setInterval(()=>{},1000)", "console.log(JSON.stringify({event:'system_open',url:'https://example.com/private'}));setInterval(()=>{},1000)"] {
            let (temp,runtime)=fixture(source);
            let manager=Supervisor::new(temp.path().canonicalize().unwrap(),Budget {launch:Duration::from_secs(1),shutdown:Duration::from_millis(50)});
            assert!(manager.open("https://example.com/".into(),BrowserChoice::Playwright,Some(runtime),Arc::new(|_|panic!("unapproved system URL opened"))).await.is_err());
            assert_eq!(manager.phase(),"recovery_required");
        }
    }
    #[cfg(target_os = "macos")]
    #[tokio::test]
    async fn unresponsive_worker_and_its_owned_detached_browser_are_terminated() {
        let (temp, runtime) = fixture(
            r#"import childProcess from 'node:child_process';import readline from 'node:readline';
const child=childProcess.spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});console.log(JSON.stringify({event:'browser_started',pid:child.pid}));console.log(JSON.stringify({event:'ready'}));
readline.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.command==='open') console.log(JSON.stringify({id:m.id,ok:true}));});"#,
        );
        let manager = Supervisor::new(
            temp.path().canonicalize().unwrap(),
            Budget {
                launch: Duration::from_secs(2),
                shutdown: Duration::from_millis(100),
            },
        );
        manager
            .open(
                "https://example.com/".into(),
                BrowserChoice::Playwright,
                Some(runtime),
                Arc::new(|_| Ok(())),
            )
            .await
            .unwrap();
        let pid = manager
            .worker
            .lock()
            .await
            .as_ref()
            .unwrap()
            .browser_pid
            .load(std::sync::atomic::Ordering::SeqCst);
        manager.shutdown().await.unwrap();
        assert_eq!(unsafe { libc::kill(-(pid as i32), 0) }, -1);
        assert_eq!(
            std::io::Error::last_os_error().raw_os_error(),
            Some(libc::ESRCH)
        );
        assert_eq!(manager.phase(), "idle");
    }
    #[tokio::test]
    async fn failed_shutdown_keeps_system_browser_usable_without_resuming_playwright() {
        let temp = tempfile::tempdir().unwrap();
        std::fs::write(
            temp.path().join("browser-runtime-owner.json"),
            b"unknown prior runtime",
        )
        .unwrap();
        let manager = Supervisor::new(temp.path().canonicalize().unwrap(), Budget::default());
        assert!(manager.shutdown().await.is_err());
        manager
            .open(
                "https://example.com/".into(),
                BrowserChoice::System,
                None,
                Arc::new(|_| Ok(())),
            )
            .await
            .unwrap();
        assert!(manager.resume().is_err());
        assert!(manager
            .open(
                "https://example.com/".into(),
                BrowserChoice::Playwright,
                None,
                Arc::new(|_| panic!("recovery bypassed"))
            )
            .await
            .is_err());
    }
    #[tokio::test]
    async fn already_cancelled_launch_never_starts_node() {
        let (temp,runtime)=fixture("import fs from 'node:fs';fs.writeFileSync(process.argv[5]+'/started','yes');console.log(JSON.stringify({event:'ready'}));setInterval(()=>{},1000)");
        let (_cancel, receiver) = tokio::sync::watch::channel(true);
        let result = Worker::launch(
            runtime,
            temp.path().canonicalize().unwrap(),
            Arc::new(StdMutex::new(Phase::default())),
            Arc::new(StdMutex::new(HashMap::new())),
            Arc::new(|_| Ok(())),
            Duration::from_secs(1),
            receiver,
        )
        .await;
        assert!(result.is_err());
        assert!(!temp.path().join("started").exists());
    }
    #[tokio::test]
    async fn user_closed_browser_becomes_idle_and_next_link_relaunches() {
        let (temp, runtime) = fixture(
            r#"import readline from 'node:readline';console.log(JSON.stringify({event:'ready'}));readline.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.command==='shutdown'){console.log(JSON.stringify({event:'closed'}));process.exit(0)}console.log(JSON.stringify({id:m.id,ok:true}));setTimeout(()=>{console.log(JSON.stringify({event:'closed'}));process.exit(0)},25)});"#,
        );
        let manager = Supervisor::new(temp.path().canonicalize().unwrap(), Budget::default());
        manager
            .open(
                "https://example.com/first".into(),
                BrowserChoice::Playwright,
                Some(runtime.clone()),
                Arc::new(|_| Ok(())),
            )
            .await
            .unwrap();
        let first = manager.worker.lock().await.as_ref().unwrap().child.id();
        tokio::time::timeout(Duration::from_secs(1), async {
            while manager.phase() != "idle" {
                tokio::time::sleep(Duration::from_millis(5)).await
            }
        })
        .await
        .expect("closed browser still reported running");
        manager
            .open(
                "https://example.com/second".into(),
                BrowserChoice::Playwright,
                Some(runtime),
                Arc::new(|_| Ok(())),
            )
            .await
            .unwrap();
        assert_ne!(
            manager.worker.lock().await.as_ref().unwrap().child.id(),
            first
        );
        manager.shutdown().await.unwrap();
    }
    #[test]
    fn recovery_clears_known_absent_pids_and_releases_shutdown_gate() {
        let temp = tempfile::tempdir().unwrap();
        std::fs::write(
            temp.path().join("browser-runtime-owner.json"),
            br#"{"version":1,"bootSession":"same","workerPid":1234,"browserPid":5678}"#,
        )
        .unwrap();
        let manager = Supervisor::new(temp.path().canonicalize().unwrap(), Budget::default());
        manager.phase.lock().unwrap().stopping = true;
        manager.cancelled.send_replace(true);
        manager
            .refresh_recovery_with(Some("same"), |_, _| true)
            .unwrap();
        assert_eq!(manager.phase(), "idle");
        assert!(!temp.path().join("browser-runtime-owner.json").exists());
        assert!(!*manager.cancelled.borrow());
        manager.ensure_open(false).unwrap();
    }
    #[test]
    fn recovery_retains_marker_if_either_owned_process_or_group_is_present() {
        for live in [1234, 5678] {
            let temp = tempfile::tempdir().unwrap();
            std::fs::write(
                temp.path().join("browser-runtime-owner.json"),
                br#"{"version":1,"bootSession":"same","workerPid":1234,"browserPid":5678}"#,
            )
            .unwrap();
            let manager = Supervisor::new(temp.path().canonicalize().unwrap(), Budget::default());
            manager
                .refresh_recovery_with(Some("same"), |pid, _| pid != live)
                .unwrap();
            assert_eq!(manager.phase(), "recovery_required");
            assert!(temp.path().join("browser-runtime-owner.json").exists());
        }
    }
    #[test]
    fn recovery_clears_unknown_startup_only_after_verified_boot_change() {
        let temp = tempfile::tempdir().unwrap();
        std::fs::write(
            temp.path().join("browser-runtime-owner.json"),
            br#"{"version":1,"bootSession":"previous","launching":true}"#,
        )
        .unwrap();
        let manager = Supervisor::new(temp.path().canonicalize().unwrap(), Budget::default());
        manager
            .refresh_recovery_with(None, |_, _| panic!("unknown PIDs queried"))
            .unwrap();
        assert_eq!(manager.phase(), "recovery_required");
        manager
            .refresh_recovery_with(Some("previous"), |_, _| panic!("unknown PIDs queried"))
            .unwrap();
        assert_eq!(manager.phase(), "recovery_required");
        manager
            .refresh_recovery_with(Some("current"), |_, _| panic!("old-boot PIDs queried"))
            .unwrap();
        assert_eq!(manager.phase(), "idle");
        assert!(!temp.path().join("browser-runtime-owner.json").exists());
    }
    #[test]
    fn native_recovery_probe_never_calls_current_process_absent() {
        assert!(!process_absent(std::process::id(), false));
        assert!(!process_absent(0, false));
        assert!(boot_session().is_some());
    }
    #[cfg(target_os = "macos")]
    #[tokio::test]
    async fn closed_browser_leader_cannot_leave_owned_descendants_running() {
        let (temp, runtime) = fixture(
            r#"import childProcess from 'node:child_process';import readline from 'node:readline';
const source="const cp=require('node:child_process');cp.spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});setTimeout(()=>process.exit(0),75)";
const child=childProcess.spawn(process.execPath,['-e',source],{detached:true,stdio:'ignore'});console.log(JSON.stringify({event:'browser_started',pid:child.pid}));console.log(JSON.stringify({event:'ready'}));child.once('exit',()=>{console.log(JSON.stringify({event:'closed'}));process.stdin.destroy()});readline.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.command==='open')console.log(JSON.stringify({id:m.id,ok:true}));});"#,
        );
        let manager = Supervisor::new(temp.path().canonicalize().unwrap(), Budget::default());
        manager
            .open(
                "https://example.com/".into(),
                BrowserChoice::Playwright,
                Some(runtime),
                Arc::new(|_| Ok(())),
            )
            .await
            .unwrap();
        let pid = manager
            .worker
            .lock()
            .await
            .as_ref()
            .unwrap()
            .browser_pid
            .load(std::sync::atomic::Ordering::SeqCst);
        tokio::time::timeout(Duration::from_secs(2), async {
            while manager.phase() != "idle" {
                tokio::time::sleep(Duration::from_millis(5)).await
            }
        })
        .await
        .unwrap();
        let shutdown = manager.shutdown().await;
        let group_absent = unsafe { libc::kill(-(pid as i32), 0) } == -1
            && std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH);
        if !group_absent {
            unsafe {
                libc::kill(-(pid as i32), libc::SIGKILL);
            }
        }
        shutdown.unwrap();
        assert!(group_absent, "owned descendant survived closed event");
        assert_eq!(manager.phase(), "idle");
    }
    #[test]
    fn mac_bundle_resolves_native_helpers_and_library_resources_separately() {
        let temp = tempfile::tempdir().unwrap();
        let native = temp.path().join("Contents/Helpers/studio-browser");
        let data = temp.path().join("Contents/Resources/studio-browser");
        for path in [native.join("node"), native.join("chromium/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"), data.join("worker.mjs"), data.join("node_modules/playwright-core/package.json")] {
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, b"isolated layout fixture").unwrap();
        }
        assert!(runtime_from_roots(&native, &data, "aarch64-apple-darwin").is_ok());
        assert!(runtime_from_roots(&native, &native, "aarch64-apple-darwin").is_err());
        assert!(!native.join("worker.mjs").exists());
    }
    #[test]
    fn windows_and_prepared_runtime_keep_the_single_directory_layout() {
        let temp = tempfile::tempdir().unwrap();
        let base = temp.path();
        for relative in [
            "node.exe",
            "chromium/chrome-win64/chrome.exe",
            "worker.mjs",
            "node_modules/playwright-core/package.json",
        ] {
            let path = base.join(relative);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, b"isolated layout fixture").unwrap();
        }
        assert!(runtime_from_roots(base, base, "x86_64-pc-windows-msvc").is_ok());
    }
    #[tokio::test]
    #[ignore = "requires prepared headed runtime; STUDIO_BROWSER_NATIVE_FIXTURE=1 and --ignored"]
    async fn native_playwright_fixture() {
        assert_eq!(
            std::env::var("STUDIO_BROWSER_NATIVE_FIXTURE").as_deref(),
            Ok("1")
        );
        let runtime = runtime().expect("prepared runtime unavailable");
        let temp = tempfile::tempdir().unwrap();
        let manager = Supervisor::new(temp.path().canonicalize().unwrap(), Budget::default());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            loop {
                let Ok((mut stream, _)) = listener.accept().await else {
                    break;
                };
                tokio::spawn(async move {
                    use tokio::io::AsyncReadExt;
                    let mut buffer = [0u8; 4096];
                    let count = stream.read(&mut buffer).await.unwrap_or(0);
                    let request = String::from_utf8_lossy(&buffer[..count]);
                    let response = if request.starts_with("GET /bounce ") {
                        "HTTP/1.1 302 Found\r\nLocation: https://accounts.google.com/o/oauth2/v2/auth?state=native-fixture\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                    } else {
                        "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: 64\r\nConnection: close\r\n\r\n<!doctype html><html><title>Studio fixture</title>Browser</html>"
                    };
                    let _ = stream.write_all(response.as_bytes()).await;
                });
            }
        });
        let calls = Arc::new(StdMutex::new(Vec::new()));
        let captured = calls.clone();
        let system: SystemOpen = Arc::new(move |url| {
            captured.lock().unwrap().push(url);
            Ok(())
        });
        let result: Result<(), String> = async {
            manager
                .open(
                    format!("http://{address}/first"),
                    BrowserChoice::Playwright,
                    Some(runtime.clone()),
                    system.clone(),
                )
                .await?;
            let first = manager
                .worker
                .lock()
                .await
                .as_ref()
                .and_then(|w| w.child.id())
                .ok_or("missing owned worker")?;
            manager
                .open(
                    format!("http://{address}/second"),
                    BrowserChoice::Playwright,
                    Some(runtime.clone()),
                    system.clone(),
                )
                .await?;
            if manager
                .worker
                .lock()
                .await
                .as_ref()
                .and_then(|w| w.child.id())
                != Some(first)
            {
                return Err("worker was not reused".into());
            }
            manager
                .open(
                    format!("http://{address}/bounce"),
                    BrowserChoice::Playwright,
                    Some(runtime),
                    system,
                )
                .await?;
            if calls.lock().unwrap().len() != 1 {
                return Err("authentication redirect was not handed off exactly once".into());
            }
            if manager.phase() != "running" {
                return Err("redirect stopped the browser".into());
            }
            Ok(())
        }
        .await;
        let cleanup = manager.shutdown().await;
        server.abort();
        assert!(result.is_ok(), "native fixture failed: {result:?}");
        assert!(
            cleanup.is_ok(),
            "native fixture cleanup failed: {cleanup:?}"
        );
        assert_eq!(manager.phase(), "idle");
        assert!(!temp.path().join("browser-runtime-owner.json").exists());
    }
    #[test]
    fn supported_os_boundaries_are_explicit() {
        assert!(!supports_os("macos", 13, 0));
        assert!(supports_os("macos", 14, 0));
        assert!(!supports_os("windows", 10, 21999));
        assert!(supports_os("windows", 10, 22000));
        assert!(!supports_os("linux", 99, 99999));
    }
}

type SystemOpen = Arc<dyn Fn(String) -> Result<(), String> + Send + Sync>;
const RECOVERY: &str = "전용 브라우저의 종료를 확인할 수 없습니다. Studio 전용 브라우저를 닫고 상태를 새로 확인하세요. 시작 중 중단되었다면 컴퓨터를 다시 시작하세요.";
const UNAVAILABLE: &str =
    "이 운영체제에서는 전용 브라우저를 지원하지 않아 기본 브라우저를 사용합니다.";
#[derive(Clone, Copy)]
struct Budget {
    launch: Duration,
    shutdown: Duration,
}
impl Default for Budget {
    fn default() -> Self {
        Self {
            launch: Duration::from_secs(30),
            shutdown: Duration::from_secs(10),
        }
    }
}
#[derive(Clone)]
struct Runtime {
    node: PathBuf,
    worker: PathBuf,
    chrome: PathBuf,
}
fn runtime() -> Result<Runtime, &'static str> {
    // This check precedes every runtime resolution and spawn; legacy OS never executes Node.
    if !os_supported() {
        return Err(UNAVAILABLE);
    }
    let target = if cfg!(target_os = "macos") {
        if cfg!(target_arch = "aarch64") {
            "aarch64-apple-darwin"
        } else {
            "x86_64-apple-darwin"
        }
    } else {
        "x86_64-pc-windows-msvc"
    };
    let exe = std::env::current_exe().map_err(|_| "전용 브라우저 설치 경로를 찾을 수 없습니다.")?;
    let parent = exe
        .parent()
        .ok_or("전용 브라우저 설치 경로를 찾을 수 없습니다.")?;
    let bundled_native = if cfg!(target_os = "macos") {
        parent.join("../Helpers/studio-browser")
    } else {
        parent.join("studio-browser")
    };
    let bundled_data = if cfg!(target_os = "macos") {
        parent.join("../Resources/studio-browser")
    } else {
        bundled_native.clone()
    };
    if cfg!(debug_assertions) && !bundled_native.is_dir() {
        let prepared = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("browser-runtime")
            .join(target);
        runtime_from_roots(&prepared, &prepared, target)
    } else {
        runtime_from_roots(&bundled_native, &bundled_data, target)
    }
}
fn runtime_from_roots(native: &Path, data: &Path, target: &str) -> Result<Runtime, &'static str> {
    let (node, chrome) = match target {
        "aarch64-apple-darwin" => ("node", "chromium/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"),
        "x86_64-apple-darwin" => ("node", "chromium/chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"),
        "x86_64-pc-windows-msvc" => ("node.exe", "chromium/chrome-win64/chrome.exe"),
        _ => return Err(UNAVAILABLE),
    };
    let paths = Runtime {
        node: native.join(node),
        worker: data.join("worker.mjs"),
        chrome: native.join(chrome),
    };
    if [&paths.node, &paths.worker, &paths.chrome]
        .iter()
        .all(|p| p.is_file())
        && data
            .join("node_modules/playwright-core/package.json")
            .is_file()
    {
        Ok(paths)
    } else {
        Err("전용 브라우저 구성요소를 사용할 수 없어 기본 브라우저를 사용합니다.")
    }
}

#[derive(Default)]
struct Phase {
    recovery: bool,
    running: bool,
    stopping: bool,
}
struct Supervisor {
    directory: PathBuf,
    phase: Arc<StdMutex<Phase>>,
    worker: Mutex<Option<Worker>>,
    handoffs: Arc<StdMutex<HashMap<[u8; 32], Instant>>>,
    budget: Budget,
    cancelled: tokio::sync::watch::Sender<bool>,
}
fn manager() -> Result<&'static Supervisor, String> {
    static INSTANCE: OnceLock<Supervisor> = OnceLock::new();
    if let Some(manager) = INSTANCE.get() {
        return Ok(manager);
    }
    let directory = data_directory()?;
    Ok(INSTANCE.get_or_init(|| Supervisor::new(directory, Budget::default())))
}
pub fn status() -> Result<BrowserStatus, String> {
    let preference = read_preferences(&settings_path())?;
    let manager = manager()?;
    manager.refresh_recovery()?;
    let phase = manager.phase();
    let availability = runtime();
    let reason = if phase == "recovery_required" {
        Some(RECOVERY.into())
    } else {
        availability.as_ref().err().map(|s| s.to_string())
    };
    let available = availability.is_ok() && phase != "recovery_required";
    Ok(BrowserStatus {
        preference,
        effective_browser: if phase == "recovery_required" {
            preference
        } else {
            route(preference, available, false)
        },
        available,
        reason,
        phase,
    })
}
pub fn save_preferences(input: PreferencesInput) -> Result<BrowserStatus, String> {
    static WRITE: StdMutex<()> = StdMutex::new(());
    let _guard = WRITE
        .lock()
        .map_err(|_| "브라우저 설정을 저장할 수 없습니다.")?;
    write_preferences(&settings_path(), input.browser)?;
    status()
}
pub async fn open(
    url: String,
    choice: Option<BrowserChoice>,
    system: impl Fn(String) -> Result<(), String> + Send + Sync + 'static,
) -> Result<(), String> {
    let preference = choice
        .map(Ok)
        .unwrap_or_else(|| read_preferences(&settings_path()))?;
    let supervisor = manager()?;
    supervisor.refresh_recovery()?;
    supervisor
        .open(url, preference, runtime().ok(), Arc::new(system))
        .await
}
/// Sets the gate before waiting for any in-flight open operation. Call before exit/update.
pub async fn shutdown() -> Result<(), String> {
    manager()?.shutdown().await
}
/// Reopen the gate only if installation failed after a confirmed shutdown.
pub fn resume() -> Result<(), String> {
    manager()?.resume()
}
impl Supervisor {
    fn new(directory: PathBuf, budget: Budget) -> Self {
        let recovery = directory.join("browser-runtime-owner.json").exists();
        Self {
            directory,
            phase: Arc::new(StdMutex::new(Phase {
                recovery,
                ..Phase::default()
            })),
            worker: Mutex::new(None),
            handoffs: Arc::new(StdMutex::new(HashMap::new())),
            budget,
            cancelled: tokio::sync::watch::channel(false).0,
        }
    }
    fn phase(&self) -> &'static str {
        let phase = self.phase.lock().unwrap_or_else(|e| e.into_inner());
        if phase.recovery {
            "recovery_required"
        } else if phase.running {
            "running"
        } else {
            "idle"
        }
    }
    fn ensure_open(&self, system: bool) -> Result<(), String> {
        let phase = self.phase.lock().map_err(|_| RECOVERY)?;
        if phase.stopping {
            Err("브라우저를 종료하고 있습니다.".into())
        } else if phase.recovery && !system {
            Err(RECOVERY.into())
        } else {
            Ok(())
        }
    }
    fn resume(&self) -> Result<(), String> {
        let mut phase = self.phase.lock().map_err(|_| RECOVERY)?;
        if phase.recovery {
            return Err(RECOVERY.into());
        }
        phase.stopping = false;
        self.cancelled.send_replace(false);
        Ok(())
    }
    fn set_finished(&self, confirmed: bool) -> Result<(), String> {
        let marker = self.directory.join("browser-runtime-owner.json");
        let removed = if confirmed {
            match std::fs::remove_file(marker) {
                Ok(()) => true,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => true,
                Err(_) => false,
            }
        } else {
            false
        };
        let mut phase = self.phase.lock().map_err(|_| RECOVERY)?;
        phase.running = false;
        phase.recovery = !removed;
        if removed {
            Ok(())
        } else {
            Err(RECOVERY.into())
        }
    }
    async fn shutdown(&self) -> Result<(), String> {
        self.refresh_recovery()?;
        let result = self.shutdown_owned().await;
        if result.is_err() {
            // A failed exit/update leaves the app running. System links remain
            // available; recovery and cancellation still prevent any relaunch.
            self.phase.lock().map_err(|_| RECOVERY)?.stopping = false;
        }
        result
    }
    async fn shutdown_owned(&self) -> Result<(), String> {
        self.phase.lock().map_err(|_| RECOVERY)?.stopping = true;
        self.cancelled.send_replace(true);
        let deadline = tokio::time::Instant::now() + self.budget.shutdown;
        let mut slot = match tokio::time::timeout_at(deadline, self.worker.lock()).await {
            Ok(slot) => slot,
            Err(_) => {
                self.phase.lock().map_err(|_| RECOVERY)?.recovery = true;
                return Err(RECOVERY.into());
            }
        };
        if let Some(mut worker) = slot.take() {
            let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
            let confirmed = tokio::time::timeout_at(
                deadline,
                worker.stop(remaining.saturating_sub(Duration::from_secs(3))),
            )
            .await
            .unwrap_or(false);
            self.set_finished(confirmed)
        } else if self.phase() == "recovery_required" {
            Err(RECOVERY.into())
        } else {
            Ok(())
        }
    }
    async fn open(
        &self,
        raw: String,
        preference: BrowserChoice,
        runtime: Option<Runtime>,
        system: SystemOpen,
    ) -> Result<(), String> {
        let url = crate::oauth::canonical_browser_url(&raw)?;
        let system_route = if preference == BrowserChoice::System || is_auth_url(&url) {
            true
        } else {
            runtime.is_none() && self.phase() != "recovery_required"
        };
        self.ensure_open(system_route)?;
        // Serialize both spawn and requests; concurrent links reuse one browser/profile.
        let mut slot = self.worker.lock().await;
        self.ensure_open(system_route)?;
        if system_route {
            return if is_auth_url(&url) {
                handoff(&self.handoffs, &system, url)
            } else {
                system(url).map_err(|_| "기본 브라우저를 열 수 없습니다.".into())
            };
        }
        if let Some(worker) = slot.as_mut() {
            if worker.closed.load(std::sync::atomic::Ordering::SeqCst)
                || worker
                    .child
                    .try_wait()
                    .map_err(|_| "전용 브라우저 상태를 확인할 수 없습니다.")?
                    .is_some()
            {
                let mut ended = slot.take().unwrap();
                self.set_finished(ended.stop(self.budget.shutdown).await)?;
            }
        }
        if slot.is_none() {
            let profile = self.directory.join("playwright-profile");
            create_private_profile(&profile)?;
            self.write_owner(serde_json::json!({"version":1,"launching":true}))?;
            let result = Worker::launch(
                runtime.unwrap(),
                profile,
                self.phase.clone(),
                self.handoffs.clone(),
                system,
                self.budget.launch,
                self.cancelled.subscribe(),
            )
            .await;
            match result {
                Ok(mut worker) => {
                    if let Err(error)=self.write_owner(serde_json::json!({"version":1,"workerPid":worker.child.id(),"browserPid":worker.browser_pid.load(std::sync::atomic::Ordering::SeqCst)})) {
                        self.set_finished(worker.stop(Duration::ZERO).await)?;return Err(error);
                    }
                    self.phase.lock().map_err(|_| RECOVERY)?.running = true;
                    *slot = Some(worker);
                }
                Err((error, confirmed)) => {
                    self.set_finished(confirmed)?;
                    return Err(error);
                }
            }
        }
        let worker = slot.as_mut().unwrap();
        if worker
            .request(
                "open",
                Some(url),
                self.budget.launch,
                self.cancelled.subscribe(),
            )
            .await
            .is_err()
        {
            let mut failed = slot.take().unwrap();
            self.set_finished(
                failed
                    .stop(if *self.cancelled.borrow() {
                        Duration::ZERO
                    } else {
                        self.budget.shutdown.saturating_sub(Duration::from_secs(3))
                    })
                    .await,
            )?;
            return Err("전용 브라우저에서 링크를 열 수 없습니다.".into());
        }
        Ok(())
    }
    fn write_owner(&self, mut value: serde_json::Value) -> Result<(), String> {
        value["bootSession"] = boot_session()
            .ok_or("전용 브라우저의 부팅 세션을 확인할 수 없습니다.")?
            .into();
        let mut file = tempfile::NamedTempFile::new_in(&self.directory)
            .map_err(|_| "전용 브라우저 상태를 저장할 수 없습니다.")?;
        serde_json::to_writer(&mut file, &value)
            .map_err(|_| "전용 브라우저 상태를 저장할 수 없습니다.")?;
        file.as_file()
            .sync_all()
            .map_err(|_| "전용 브라우저 상태를 저장할 수 없습니다.")?;
        file.persist(self.directory.join("browser-runtime-owner.json"))
            .map_err(|_| "전용 브라우저 상태를 저장할 수 없습니다.")?;
        #[cfg(unix)]
        std::fs::File::open(&self.directory)
            .and_then(|file| file.sync_all())
            .map_err(|_| "전용 브라우저 상태를 저장할 수 없습니다.")?;
        Ok(())
    }
}
fn create_private_profile(path: &Path) -> Result<(), String> {
    for ancestor in path.ancestors() {
        if std::fs::symlink_metadata(ancestor)
            .is_ok_and(|m| m.file_type().is_symlink() || !m.is_dir())
        {
            return Err("전용 브라우저 프로필 경로를 확인하세요.".into());
        }
    }
    std::fs::create_dir_all(path).map_err(|_| "전용 브라우저 프로필을 만들 수 없습니다.")?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))
            .map_err(|_| "전용 브라우저 프로필을 보호할 수 없습니다.")?;
    }
    Ok(())
}
fn handoff(
    seen: &StdMutex<HashMap<[u8; 32], Instant>>,
    system: &SystemOpen,
    raw: String,
) -> Result<(), String> {
    let url = crate::oauth::canonical_browser_url(&raw)?;
    if !is_auth_url(&url) {
        return Err("인증 링크 형식을 확인하세요.".into());
    }
    let digest: [u8; 32] = Sha256::digest(url.as_bytes()).into();
    let mut seen = seen.lock().map_err(|_| "인증 브라우저를 열 수 없습니다.")?;
    seen.retain(|_, instant| instant.elapsed() < Duration::from_secs(30));
    if seen.contains_key(&digest) {
        return Ok(());
    }
    if seen.len() >= 128 {
        return Err("인증 브라우저 요청이 너무 많습니다.".into());
    }
    system(url).map_err(|_| "기본 브라우저를 열 수 없습니다.")?;
    seen.insert(digest, Instant::now());
    Ok(())
}

#[derive(Debug)]
enum Event {
    Ready,
    Reply { id: u64, ok: bool },
    Closed,
    Failed,
}
struct Worker {
    child: Child,
    stdin: ChildStdin,
    events: mpsc::Receiver<Event>,
    reader: tokio::task::JoinHandle<()>,
    browser_pid: Arc<std::sync::atomic::AtomicU32>,
    closed: Arc<std::sync::atomic::AtomicBool>,
    next_id: u64,
    #[cfg(target_os = "windows")]
    job: winjob::Job,
}
impl Worker {
    async fn launch(
        runtime: Runtime,
        profile: PathBuf,
        phase: Arc<StdMutex<Phase>>,
        handoffs: Arc<StdMutex<HashMap<[u8; 32], Instant>>>,
        system: SystemOpen,
        timeout: Duration,
        mut cancelled: tokio::sync::watch::Receiver<bool>,
    ) -> Result<Self, (String, bool)> {
        if *cancelled.borrow() {
            return Err(("브라우저를 종료하고 있습니다.".into(), true));
        }
        let mut command = Command::new(&runtime.node);
        command
            .arg(&runtime.worker)
            .arg("--browser")
            .arg(&runtime.chrome)
            .arg("--profile")
            .arg(profile)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null())
            .kill_on_drop(true);
        // Do not inherit Node preload/debug options or module overrides from Studio's environment.
        for key in [
            "NODE_OPTIONS",
            "NODE_PATH",
            "NODE_REPL_EXTERNAL_MODULE",
            "NODE_EXTRA_CA_CERTS",
            "ELECTRON_RUN_AS_NODE",
        ] {
            command.env_remove(key);
        }
        #[cfg(unix)]
        command.process_group(0);
        #[cfg(target_os = "windows")]
        command.creation_flags(0x08000004); // CREATE_NO_WINDOW | CREATE_SUSPENDED
        let mut child = command
            .spawn()
            .map_err(|_| ("전용 브라우저 작업자를 시작할 수 없습니다.".into(), true))?;
        #[cfg(target_os = "windows")]
        let job = match winjob::Job::attach(&child) {
            Ok(job) => job,
            Err(_) => {
                let _ = child.kill().await;
                return Err(("전용 브라우저 프로세스를 보호할 수 없습니다.".into(), false));
            }
        };
        let stdin = child.stdin.take().expect("piped stdin");
        let stdout = child.stdout.take().expect("piped stdout");
        let browser_pid = Arc::new(std::sync::atomic::AtomicU32::new(0));
        let closed = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let (sender, events) = mpsc::channel(16);
        let read_pid = browser_pid.clone();
        let read_closed = closed.clone();
        let reader = tokio::spawn(async move {
            let mut output = BufReader::new(stdout);
            loop {
                let line = match bounded_line(&mut output).await {
                    Ok(Some(line)) => line,
                    Ok(None) => break,
                    Err(_) => {
                        let _ = sender.send(Event::Failed).await;
                        break;
                    }
                };
                let value: serde_json::Value = match serde_json::from_slice(&line) {
                    Ok(value) => value,
                    Err(_) => {
                        let _ = sender.send(Event::Failed).await;
                        break;
                    }
                };
                let event = match value.get("event").and_then(|v| v.as_str()) {
                    Some("browser_started") => {
                        let pid = value
                            .get("pid")
                            .and_then(|v| v.as_u64())
                            .and_then(|v| u32::try_from(v).ok())
                            .filter(|p| {
                                *p > 1 && *p <= i32::MAX as u32 && *p != std::process::id()
                            });
                        if let Some(pid) = pid {
                            if read_pid.swap(pid, std::sync::atomic::Ordering::SeqCst) != 0 {
                                let _ = sender.send(Event::Failed).await;
                                break;
                            }
                            continue;
                        }
                        Event::Failed
                    }
                    Some("ready") => Event::Ready,
                    Some("closed") => {
                        read_closed.store(true, std::sync::atomic::Ordering::SeqCst);
                        if let Ok(mut phase) = phase.lock() {
                            phase.running = false;
                        }
                        Event::Closed
                    }
                    Some("failed") => Event::Failed,
                    Some("system_open") => {
                        if value
                            .get("url")
                            .and_then(|v| v.as_str())
                            .is_some_and(|url| handoff(&handoffs, &system, url.to_string()).is_ok())
                        {
                            continue;
                        }
                        Event::Failed
                    }
                    None => match (
                        value.get("id").and_then(|v| v.as_u64()),
                        value.get("ok").and_then(|v| v.as_bool()),
                    ) {
                        (Some(id), Some(ok)) => Event::Reply { id, ok },
                        _ => Event::Failed,
                    },
                    _ => Event::Failed,
                };
                let failed = matches!(event, Event::Failed);
                if sender.send(event).await.is_err() || failed {
                    break;
                }
            }
            if !read_closed.load(std::sync::atomic::Ordering::SeqCst) {
                if let Ok(mut phase) = phase.lock() {
                    phase.recovery = true;
                }
            }
        });
        let mut worker = Self {
            child,
            stdin,
            events,
            reader,
            browser_pid,
            closed,
            next_id: 1,
            #[cfg(target_os = "windows")]
            job,
        };
        let started = tokio::select! {
            result=tokio::time::timeout(timeout,worker.events.recv())=>matches!(result,Ok(Some(Event::Ready))),
            _=cancelled.changed()=>false,
        };
        if started && !*cancelled.borrow() {
            Ok(worker)
        } else {
            let confirmed = worker.stop(Duration::ZERO).await;
            Err((
                "전용 브라우저가 시작 제한 시간 안에 준비되지 않았습니다.".into(),
                confirmed,
            ))
        }
    }
    async fn request(
        &mut self,
        command: &str,
        url: Option<String>,
        timeout: Duration,
        mut cancelled: tokio::sync::watch::Receiver<bool>,
    ) -> Result<(), String> {
        if *cancelled.borrow() {
            return Err("브라우저를 종료하고 있습니다.".into());
        }
        let id = self.next_id;
        self.next_id = self
            .next_id
            .checked_add(1)
            .ok_or("브라우저 요청을 확인하세요.")?;
        let mut payload = serde_json::json!({"id":id,"command":command});
        if let Some(url) = url {
            payload["url"] = url.into();
        }
        tokio::select! {
            result=tokio::time::timeout(timeout,async {
                self.send(payload).await?;
                match self.events.recv().await {Some(Event::Reply{id:reply,ok:true}) if reply==id=>Ok(()),_=>Err("브라우저 요청을 완료할 수 없습니다.".into())}
            })=>result.map_err(|_| "브라우저 요청 시간이 초과되었습니다.")?,
            _=cancelled.changed()=>Err("브라우저를 종료하고 있습니다.".into()),
        }
    }
    async fn send(&mut self, payload: serde_json::Value) -> Result<(), String> {
        let mut line =
            serde_json::to_vec(&payload).map_err(|_| "브라우저 요청을 만들 수 없습니다.")?;
        line.push(b'\n');
        self.stdin
            .write_all(&line)
            .await
            .map_err(|_| "브라우저 작업자에 연결할 수 없습니다.")?;
        self.stdin
            .flush()
            .await
            .map_err(|_| "브라우저 작업자에 연결할 수 없습니다.".into())
    }
    async fn stop(&mut self, grace: Duration) -> bool {
        let graceful = tokio::time::timeout(grace, async {
            if self.child.try_wait().ok().flatten().is_none() {
                let _ = self
                    .send(serde_json::json!({"id":self.next_id,"command":"shutdown"}))
                    .await;
                while !self.closed.load(std::sync::atomic::Ordering::SeqCst) {
                    if self.events.recv().await.is_none() {
                        break;
                    }
                }
            }
            self.child.wait().await.is_ok()
        })
        .await
        .unwrap_or(false);
        let pid = self.browser_pid.load(std::sync::atomic::Ordering::SeqCst);
        #[cfg(target_os = "macos")]
        let tree_absent = pid == 0 || process_absent(pid, true);
        #[cfg(target_os = "windows")]
        let tree_absent = self.job.empty();
        #[cfg(not(any(target_os = "macos", target_os = "windows")))]
        let tree_absent = pid == 0;
        let confirmed =
            if graceful && self.closed.load(std::sync::atomic::Ordering::SeqCst) && tree_absent {
                true
            } else {
                self.force_stop(pid).await
            };
        self.reader.abort();
        let _ = (&mut self.reader).await;
        confirmed
    }
    async fn force_stop(&mut self, browser_pid: u32) -> bool {
        #[cfg(not(target_os = "macos"))]
        let _ = browser_pid;
        #[cfg(target_os = "macos")]
        {
            // Chrome is deliberately detached by Playwright. Its reported launch PID owns
            // a distinct process group; never kill a group that belongs to another app.
            if browser_pid > 1 {
                let group = unsafe { libc::getpgid(browser_pid as i32) };
                if group == browser_pid as i32 {
                    unsafe {
                        libc::kill(-group, libc::SIGKILL);
                    }
                } else if group == -1
                    && std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH)
                {
                    // A dead leader can leave renderers in the group it owned.
                    // Group IDs cannot be reused while those members remain.
                    unsafe {
                        libc::kill(-(browser_pid as i32), libc::SIGKILL);
                    }
                } else {
                    return false;
                }
            }
            if let Some(pid) = self.child.id() {
                unsafe {
                    libc::kill(-(pid as i32), libc::SIGKILL);
                }
            }
        }
        #[cfg(target_os = "windows")]
        self.job.terminate();
        let _ = self.child.start_kill();
        if tokio::time::timeout(Duration::from_secs(2), self.child.wait())
            .await
            .ok()
            .and_then(Result::ok)
            .is_none()
        {
            return false;
        }
        #[cfg(target_os = "macos")]
        {
            if browser_pid > 1 {
                for _ in 0..20 {
                    if unsafe { libc::kill(-(browser_pid as i32), 0) } == -1
                        && std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH)
                    {
                        return true;
                    }
                    tokio::time::sleep(Duration::from_millis(50)).await;
                }
                return false;
            }
        }
        #[cfg(target_os = "windows")]
        {
            for _ in 0..20 {
                if self.job.empty() {
                    return true;
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
            return false;
        }
        #[cfg(not(target_os = "windows"))]
        {
            // Without browser_started or closed, the worker could have crashed
            // between detached Chromium spawn and its ownership notification.
            false
        }
    }
}
async fn bounded_line(
    reader: &mut BufReader<tokio::process::ChildStdout>,
) -> Result<Option<Vec<u8>>, ()> {
    const MAX: usize = 65536;
    let mut bytes = Vec::new();
    loop {
        let chunk = reader.fill_buf().await.map_err(|_| ())?;
        if chunk.is_empty() {
            return if bytes.is_empty() { Ok(None) } else { Err(()) };
        }
        let consumed = chunk
            .iter()
            .position(|b| *b == b'\n')
            .map(|i| i + 1)
            .unwrap_or(chunk.len());
        if bytes.len() + consumed > MAX {
            return Err(());
        }
        bytes.extend_from_slice(&chunk[..consumed]);
        reader.consume(consumed);
        if bytes.last() == Some(&b'\n') {
            return Ok(Some(bytes));
        }
    }
}
#[cfg(target_os = "windows")]
mod winjob {
    use std::ffi::c_void;
    type Handle = *mut c_void;
    #[repr(C)]
    struct BasicLimit {
        process_time: i64,
        job_time: i64,
        flags: u32,
        min_working: usize,
        max_working: usize,
        active_processes: u32,
        affinity: usize,
        priority: u32,
        scheduling: u32,
    }
    #[repr(C)]
    struct IoCounters {
        read_ops: u64,
        write_ops: u64,
        other_ops: u64,
        read_bytes: u64,
        write_bytes: u64,
        other_bytes: u64,
    }
    #[repr(C)]
    struct ExtendedLimit {
        basic: BasicLimit,
        io: IoCounters,
        process_memory: usize,
        job_memory: usize,
        peak_process: usize,
        peak_job: usize,
    }
    #[repr(C)]
    struct Accounting {
        user_time: i64,
        kernel_time: i64,
        period_user: i64,
        period_kernel: i64,
        page_faults: u32,
        total_processes: u32,
        active_processes: u32,
        terminated_processes: u32,
    }
    #[link(name = "ntdll")]
    unsafe extern "system" {
        fn NtResumeProcess(process: Handle) -> i32;
    }
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn CreateJobObjectW(attributes: *const c_void, name: *const u16) -> Handle;
        fn SetInformationJobObject(
            job: Handle,
            class: i32,
            info: *const c_void,
            length: u32,
        ) -> i32;
        fn AssignProcessToJobObject(job: Handle, process: Handle) -> i32;
        fn TerminateJobObject(job: Handle, code: u32) -> i32;
        fn QueryInformationJobObject(
            job: Handle,
            class: i32,
            info: *mut c_void,
            length: u32,
            returned: *mut u32,
        ) -> i32;
        fn CloseHandle(handle: Handle) -> i32;
    }
    pub(super) struct Job(Handle);
    // Job handles are kernel objects; ownership remains in one Worker and is never shared.
    unsafe impl Send for Job {}
    impl Job {
        pub(super) fn attach(child: &tokio::process::Child) -> Result<Self, ()> {
            unsafe {
                let handle = CreateJobObjectW(std::ptr::null(), std::ptr::null());
                if handle.is_null() {
                    return Err(());
                }
                let job = Self(handle);
                let mut limits: ExtendedLimit = std::mem::zeroed();
                limits.basic.flags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
                if SetInformationJobObject(
                    handle,
                    9,
                    &limits as *const _ as *const c_void,
                    std::mem::size_of::<ExtendedLimit>() as u32,
                ) == 0
                {
                    return Err(());
                }
                let process = child.raw_handle().ok_or(())?;
                if AssignProcessToJobObject(handle, process) == 0 {
                    return Err(());
                }
                // Node starts only after job ownership is established, so all
                // Chrome descendants inherit the kill-on-close job.
                if NtResumeProcess(process) < 0 {
                    return Err(());
                }
                Ok(job)
            }
        }
        pub(super) fn terminate(&self) {
            unsafe {
                TerminateJobObject(self.0, 1);
            }
        }
        pub(super) fn empty(&self) -> bool {
            unsafe {
                let mut info: Accounting = std::mem::zeroed();
                QueryInformationJobObject(
                    self.0,
                    1,
                    &mut info as *mut _ as *mut c_void,
                    std::mem::size_of::<Accounting>() as u32,
                    std::ptr::null_mut(),
                ) != 0
                    && info.active_processes == 0
            }
        }
    }
    impl Drop for Job {
        fn drop(&mut self) {
            unsafe {
                CloseHandle(self.0);
            }
        }
    }
}
/// OS boot identity makes an interrupted launch recoverable after a real reboot.
/// No process from a previous boot can still own a browser profile.
fn boot_session() -> Option<String> {
    #[cfg(target_os = "macos")]
    {
        let mut bytes = [0u8; 128];
        let mut length = bytes.len();
        let result = unsafe {
            libc::sysctlbyname(
                c"kern.bootsessionuuid".as_ptr(),
                bytes.as_mut_ptr().cast(),
                &mut length,
                std::ptr::null_mut(),
                0,
            )
        };
        if result != 0 || length > bytes.len() {
            return None;
        }
        let text = std::str::from_utf8(&bytes[..length])
            .ok()?
            .trim_end_matches('\0')
            .trim();
        if text.len() != 36 {
            return None;
        }
        return Some(text.to_string());
    }
    #[cfg(target_os = "windows")]
    {
        #[repr(C)]
        struct BootInfo {
            identifier: [u8; 16],
            firmware: u32,
            flags: u64,
        }
        #[link(name = "ntdll")]
        unsafe extern "system" {
            fn NtQuerySystemInformation(
                class: i32,
                info: *mut std::ffi::c_void,
                length: u32,
                returned: *mut u32,
            ) -> i32;
        }
        let mut info = BootInfo {
            identifier: [0; 16],
            firmware: 0,
            flags: 0,
        };
        let status = unsafe {
            NtQuerySystemInformation(
                90,
                (&mut info as *mut BootInfo).cast(),
                std::mem::size_of::<BootInfo>() as u32,
                std::ptr::null_mut(),
            )
        };
        if status < 0 || info.identifier == [0; 16] {
            return None;
        }
        return Some(
            info.identifier
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect(),
        );
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        std::fs::read_to_string("/proc/sys/kernel/random/boot_id")
            .ok()
            .map(|s| s.trim().to_string())
    }
}
/// Probe only: never adopt, signal or terminate a recorded PID during recovery.
fn process_absent(pid: u32, group: bool) -> bool {
    if pid <= 1 || pid > i32::MAX as u32 {
        return false;
    }
    #[cfg(target_os = "macos")]
    {
        let absent=|id| unsafe {libc::kill(id,0)}==-1 && std::io::Error::last_os_error().raw_os_error()==Some(libc::ESRCH);
        return absent(pid as i32) && (!group || absent(-(pid as i32)));
    }
    #[cfg(target_os = "windows")]
    {
        #[link(name = "kernel32")]
        unsafe extern "system" {
            fn OpenProcess(access: u32, inherit: i32, pid: u32) -> *mut std::ffi::c_void;
            fn GetLastError() -> u32;
            fn GetExitCodeProcess(process: *mut std::ffi::c_void, code: *mut u32) -> i32;
            fn CloseHandle(process: *mut std::ffi::c_void) -> i32;
        }
        let _ = group;
        unsafe {
            let process = OpenProcess(0x1000, 0, pid); // PROCESS_QUERY_LIMITED_INFORMATION
            if process.is_null() {
                return GetLastError() == 87;
            } // ERROR_INVALID_PARAMETER: PID absent
            let mut code = 259;
            let result = GetExitCodeProcess(process, &mut code);
            CloseHandle(process);
            return result != 0 && code != 259;
        }
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = group;
        false
    }
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct OwnerRecord {
    version: u32,
    boot_session: Option<String>,
    worker_pid: Option<u32>,
    browser_pid: Option<u32>,
}
impl Supervisor {
    fn refresh_recovery(&self) -> Result<(), String> {
        if self.phase() != "recovery_required" {
            return Ok(());
        }
        self.refresh_recovery_with(boot_session().as_deref(), process_absent)
    }
    fn refresh_recovery_with(
        &self,
        current_boot: Option<&str>,
        absent: impl Fn(u32, bool) -> bool,
    ) -> Result<(), String> {
        if self.phase() != "recovery_required" {
            return Ok(());
        }
        // A startup/cleanup operation retains this mutex. Never clear a marker
        // while that operation can still publish a browser PID.
        let Ok(mut slot) = self.worker.try_lock() else {
            return Ok(());
        };
        let marker = self.directory.join("browser-runtime-owner.json");
        if let Some(worker) = slot.as_mut() {
            let _ = worker.child.try_wait();
        }
        use std::io::Read;
        let mut bytes = Vec::new();
        let Ok(file) = std::fs::File::open(&marker) else {
            return Ok(());
        };
        if file.take(4097).read_to_end(&mut bytes).is_err() || bytes.len() > 4096 {
            return Ok(());
        }
        let Ok(owner) = serde_json::from_slice::<OwnerRecord>(&bytes) else {
            return Ok(());
        };
        if owner.version != 1 {
            return Ok(());
        }
        let boot_changed = match (owner.boot_session.as_deref(), current_boot) {
            (Some(before), Some(now)) if !before.is_empty() && !now.is_empty() => before != now,
            _ => false,
        };
        let known_absent = if boot_changed {
            true
        } else {
            match (owner.worker_pid, owner.browser_pid) {
                (Some(worker), Some(browser)) if worker > 1 && browser > 1 => {
                    absent(worker, true) && absent(browser, true)
                }
                _ => false,
            }
        };
        if !known_absent {
            return Ok(());
        }
        if let Some(worker) = slot.take() {
            worker
                .closed
                .store(true, std::sync::atomic::Ordering::SeqCst);
            worker.reader.abort();
            // PIDs/groups were proved absent; drop cannot terminate another process.
            drop(worker);
        }
        self.set_finished(true)?;
        let mut phase = self.phase.lock().map_err(|_| RECOVERY)?;
        phase.stopping = false;
        self.cancelled.send_replace(false);
        Ok(())
    }
}
