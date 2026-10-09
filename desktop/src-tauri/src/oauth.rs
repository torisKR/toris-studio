//! Official OAuth account sessions for the local desktop application.
//!
//! Threat model: an untrusted WebView must never receive credentials; forged/replayed
//! callbacks, redirect substitution, cross-provider state reuse, and token-endpoint
//! redirects must not obtain a session. State is random, single use and memory-only.
//! Google and TikTok use provider-specific PKCE. No OIDC identity/ID token is trusted.
//! Tokens and user-supplied client credentials stay in the operating-system vault.
//! The system browser owns its login cookies: we neither extract browser cookies nor
//! promise to extend them. Refresh is only through the provider's official protocol.
//! A bounded, redacted auth-event trail is also retained in the OS vault.

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use chrono::{DateTime, Utc};
use rand::{rngs::OsRng, RngCore};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    future::Future,
    pin::Pin,
    sync::{Arc, Mutex as StdMutex, OnceLock},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    sync::{watch, Mutex},
    task::JoinHandle,
};
use url::Url;

const SERVICE: &str = "kr.toris.studio.oauth.v1";
const CALLBACK_PORT: u16 = 38471;
const LOGIN_TTL: u64 = 300;
const MAX_CALLBACK: usize = 8192;
const MAX_RESPONSE: usize = 262_144;
const MAX_TOKEN: usize = 16_384;
const DAY: u64 = 86_400;
const YOUTUBE_UPLOAD_SCOPE: &str = "https://www.googleapis.com/auth/youtube.upload";
fn has_upload_scope(scopes: &[String]) -> bool {
    scopes.iter().any(|s| {
        [
            YOUTUBE_UPLOAD_SCOPE,
            "https://www.googleapis.com/auth/youtube",
            "https://www.googleapis.com/auth/youtube.force-ssl",
        ]
        .contains(&s.as_str())
    })
}

/// The renderer can choose a known browser, never an executable or arguments.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum LoginBrowser {
    System,
    Aside,
}

impl LoginBrowser {
    pub fn program(self) -> Option<&'static str> {
        match self {
            Self::System => None,
            Self::Aside if cfg!(target_os = "windows") => Some("Aside.exe"),
            Self::Aside => Some("Aside"),
        }
    }
}

pub fn canonical_browser_url(raw: &str) -> Result<String, String> {
    if raw.len() > 2048 || raw.chars().any(char::is_control) {
        return Err("링크 길이와 형식을 확인하세요.".into());
    }
    let parsed = Url::parse(raw).map_err(|_| "링크 형식을 확인하세요.")?;
    let loopback = ["localhost", "127.0.0.1", "[::1]"].contains(&parsed.host_str().unwrap_or(""));
    if !parsed.username().is_empty()
        || parsed.password().is_some()
        || !(parsed.scheme() == "https" || (parsed.scheme() == "http" && loopback))
    {
        return Err("HTTPS 출처 또는 로컬 서비스 링크만 열 수 있습니다.".into());
    }
    // Windows ShellExecute treats the URL as program parameters. URL encoding
    // keeps literal spaces and quotes from becoming additional arguments.
    let canonical = parsed.to_string();
    if canonical.chars().any(|c| c.is_whitespace() || c == '"') {
        return Err("링크 형식을 확인하세요.".into());
    }
    Ok(canonical)
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Provider {
    Youtube,
    Threads,
    NaverBlog,
    Tiktok,
    Instagram,
    Facebook,
}
const PROVIDERS: [Provider; 6] = [
    Provider::Youtube,
    Provider::Threads,
    Provider::NaverBlog,
    Provider::Tiktok,
    Provider::Instagram,
    Provider::Facebook,
];

impl Provider {
    fn parse(raw: &str) -> Result<Self, String> {
        PROVIDERS
            .into_iter()
            .find(|p| p.id() == raw)
            .ok_or_else(|| "지원하지 않는 SNS입니다.".into())
    }
    fn id(self) -> &'static str {
        match self {
            Self::Youtube => "youtube",
            Self::Threads => "threads",
            Self::NaverBlog => "naver_blog",
            Self::Tiktok => "tiktok",
            Self::Instagram => "instagram",
            Self::Facebook => "facebook",
        }
    }
    fn label(self) -> &'static str {
        match self {
            Self::Youtube => "YouTube",
            Self::Threads => "Threads",
            Self::NaverBlog => "네이버",
            Self::Tiktok => "TikTok",
            Self::Instagram => "Instagram",
            Self::Facebook => "Facebook Page",
        }
    }
    fn meta(self) -> bool {
        matches!(self, Self::Threads | Self::Instagram | Self::Facebook)
    }
    fn secret_required(self) -> bool {
        self != Self::Youtube
    }
    fn authorization_endpoint(self) -> &'static str {
        match self {
            Self::Youtube => "https://accounts.google.com/o/oauth2/v2/auth",
            Self::Threads => "https://www.threads.net/oauth/authorize",
            Self::NaverBlog => "https://nid.naver.com/oauth2.0/authorize",
            Self::Tiktok => "https://www.tiktok.com/v2/auth/authorize/",
            Self::Instagram => "https://www.instagram.com/oauth/authorize",
            Self::Facebook => "https://www.facebook.com/v25.0/dialog/oauth",
        }
    }
    fn token_endpoint(self) -> &'static str {
        match self {
            Self::Youtube => "https://oauth2.googleapis.com/token",
            Self::Threads => "https://graph.threads.net/oauth/access_token",
            Self::NaverBlog => "https://nid.naver.com/oauth2.0/token",
            Self::Tiktok => "https://open.tiktokapis.com/v2/oauth/token/",
            Self::Instagram => "https://api.instagram.com/oauth/access_token",
            Self::Facebook => "https://graph.facebook.com/v25.0/oauth/access_token",
        }
    }
    fn basic_scope(self) -> &'static str {
        match self {
            Self::Youtube => "https://www.googleapis.com/auth/youtube.readonly",
            Self::Threads => "threads_basic",
            Self::NaverBlog => "",
            Self::Tiktok => "user.info.basic",
            Self::Instagram => "instagram_business_basic",
            Self::Facebook => "pages_show_list,pages_read_engagement",
        }
    }
    fn publishing_scope(self) -> Option<&'static str> {
        match self {
            Self::Youtube => Some("https://www.googleapis.com/auth/youtube.readonly https://www.googleapis.com/auth/youtube.upload"),
            Self::Threads => Some("threads_basic,threads_content_publish"),
            Self::Instagram => Some("instagram_business_basic,instagram_business_content_publish"),
            Self::Facebook => Some("pages_show_list,pages_read_engagement,pages_manage_posts"),
            Self::Tiktok => Some("user.info.basic,video.publish,video.upload"),
            Self::NaverBlog => None,
        }
    }
    fn publishing_authorized(self, scopes: &[String]) -> bool {
        match self {
            Self::Youtube => has_upload_scope(scopes),
            Self::Threads => scopes.iter().any(|s| s == "threads_content_publish"),
            Self::Instagram => scopes
                .iter()
                .any(|s| s == "instagram_business_content_publish"),
            Self::Facebook => [
                "pages_show_list",
                "pages_read_engagement",
                "pages_manage_posts",
            ]
            .iter()
            .all(|required| scopes.iter().any(|s| s == required)),
            Self::Tiktok => scopes
                .iter()
                .any(|s| s == "video.publish" || s == "video.upload"),
            Self::NaverBlog => false,
        }
    }
    fn permissions_endpoint(self) -> Option<&'static str> {
        match self {
            Self::Threads => Some("https://graph.threads.net/v1.0/me/permissions"),
            Self::Instagram => Some("https://graph.instagram.com/v25.0/me/permissions"),
            Self::Facebook => Some("https://graph.facebook.com/v25.0/me/permissions"),
            _ => None,
        }
    }
    fn default_redirect(self) -> String {
        format!(
            "http://127.0.0.1:{CALLBACK_PORT}/oauth/{}/callback",
            self.id()
        )
    }
    fn help(self) -> &'static str {
        match self {
        Self::Youtube => "Google 데스크톱 OAuth 클라이언트가 필요합니다. 계정 연결은 읽기 전용이며 공개 채널 조회는 YouTube Data API KEY를 사용합니다.",
        Self::Threads => "Meta Threads 앱과 등록된 HTTPS 콜백이 필요합니다. threads_basic 읽기 권한으로 연결하고 콜백 주소를 붙여 넣어 완료하세요.",
        Self::NaverBlog => "네이버 로그인 앱에 콜백을 등록하세요. 계정 로그인만 연결하며 네이버 블로그 글쓰기 권한은 제공하지 않습니다.",
        Self::Tiktok => "TikTok Login Kit Desktop 앱과 등록된 로컬 콜백이 필요합니다. user.info.basic 권한을 사용합니다.",
        Self::Facebook => "Facebook Login 앱과 등록된 HTTPS 콜백이 필요합니다. Page 조회 권한과 게시 권한은 각각 승인하며 개인 프로필에는 게시하지 않습니다.",
        Self::Instagram => "Instagram Business/Creator 계정과 Meta 앱의 등록된 HTTPS 콜백이 필요합니다. instagram_business_basic 권한으로 연결하세요.",
    }
    }
}

#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ClientConfig {
    client_id: String,
    client_secret: Option<String>,
    redirect_uri: String,
    #[serde(default)]
    tiktok_audit_declared: bool,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct TokenSession {
    access_token: String,
    refresh_token: Option<String>,
    expires_at: u64,
    refresh_expires_at: Option<u64>,
    issued_at: u64,
    long_lived: bool,
    needs_reconnect: bool,
    failures: u8,
    retry_at: u64,
    #[serde(default)]
    scopes: Vec<String>,
}
impl TokenSession {
    fn refreshable(&self, provider: Provider, now: u64) -> bool {
        !self.needs_reconnect
            && if provider.meta() {
                self.long_lived && self.expires_at > now
            } else {
                self.refresh_token.is_some()
                    && self.refresh_expires_at.map_or(true, |expiry| expiry > now)
            }
    }
}

// Never derive Debug on types holding a code, client secret or access/refresh token.
struct PendingLogin {
    state: String,
    verifier: Option<String>,
    client: ClientConfig,
    expires_at: u64,
    cancel: watch::Sender<bool>,
    publishing: bool,
}

#[derive(Clone, Deserialize, Serialize)]
struct AuditEvent {
    at: u64,
    event: String,
    outcome: String,
}

trait CredentialStore: Send + Sync {
    fn read(&self, account: &str) -> Result<Option<String>, String>;
    fn write(&self, account: &str, value: &str) -> Result<(), String>;
    fn delete(&self, account: &str) -> Result<(), String>;
}
struct OsCredentialStore;
struct NativeCredentialStore;
impl CredentialStore for NativeCredentialStore {
    fn read(&self, account: &str) -> Result<Option<String>, String> {
        #[cfg(target_os = "macos")]
        return crate::vault::read(SERVICE, account);
        #[cfg(not(target_os = "macos"))]
        {
            let entry = keyring::Entry::new(SERVICE, account).map_err(|_| vault_error())?;
            match entry.get_password() {
                Ok(value) => Ok(Some(value)),
                Err(keyring::Error::NoEntry) => Ok(None),
                Err(_) => Err(vault_error()),
            }
        }
    }
    fn write(&self, account: &str, value: &str) -> Result<(), String> {
        #[cfg(target_os = "macos")]
        return crate::vault::write(SERVICE, account, value);
        #[cfg(not(target_os = "macos"))]
        keyring::Entry::new(SERVICE, account)
            .and_then(|entry| entry.set_password(value))
            .map_err(|_| vault_error())
    }
    fn delete(&self, account: &str) -> Result<(), String> {
        #[cfg(target_os = "macos")]
        return crate::vault::delete(SERVICE, account);
        #[cfg(not(target_os = "macos"))]
        {
            let entry = keyring::Entry::new(SERVICE, account).map_err(|_| vault_error())?;
            match entry.delete_credential() {
                Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
                Err(_) => Err(vault_error()),
            }
        }
    }
}
impl CredentialStore for OsCredentialStore {
    fn read(&self, account: &str) -> Result<Option<String>, String> {
        #[cfg(target_os = "windows")]
        {
            chunked_read(&NativeCredentialStore, account)
        }
        #[cfg(not(target_os = "windows"))]
        {
            NativeCredentialStore.read(account)
        }
    }
    fn write(&self, account: &str, value: &str) -> Result<(), String> {
        #[cfg(target_os = "windows")]
        {
            chunked_write(&NativeCredentialStore, account, value)
        }
        #[cfg(not(target_os = "windows"))]
        {
            NativeCredentialStore.write(account, value)
        }
    }
    fn delete(&self, account: &str) -> Result<(), String> {
        #[cfg(target_os = "windows")]
        {
            chunked_delete(&NativeCredentialStore, account)
        }
        #[cfg(not(target_os = "windows"))]
        {
            NativeCredentialStore.delete(account)
        }
    }
}

// Windows native credentials cap a blob at 2560 bytes. Large provider JSON is
// set_password encodes UTF-16: <=1000 ASCII characters take <=2000 native bytes.
// All chunks remain encrypted by the OS vault, with no plaintext file fallback.
// The small root credential is replaced only after every new chunk is written;
// readers therefore see the previous complete session or the new complete one.
// This is a storage envelope, never an authentication token or encryption scheme.
#[cfg(any(target_os = "windows", test))]
const CHUNK_PREFIX: &str = "toris-vault-chunks-v1:";
#[cfg(any(target_os = "windows", test))]
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct ChunkManifest {
    generation: String,
    count: usize,
    digest: String,
}
#[cfg(any(target_os = "windows", test))]
fn chunk_manifest(value: &str) -> Result<Option<ChunkManifest>, String> {
    let Some(raw) = value.strip_prefix(CHUNK_PREFIX) else {
        return Ok(None);
    };
    let manifest: ChunkManifest = serde_json::from_str(raw).map_err(|_| vault_error())?;
    if manifest.count == 0
        || manifest.count > 128
        || manifest.generation.len() != 43
        || !manifest
            .generation
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
        || manifest.digest.len() != 43
    {
        return Err(vault_error());
    }
    Ok(Some(manifest))
}
#[cfg(any(target_os = "windows", test))]
fn chunk_account(account: &str, manifest: &ChunkManifest, index: usize) -> String {
    format!("{account}:{}:{index}", manifest.generation)
}
#[cfg(any(target_os = "windows", test))]
fn delete_chunks(
    store: &dyn CredentialStore,
    account: &str,
    manifest: &ChunkManifest,
) -> Result<(), String> {
    let mut failed = false;
    for index in 0..manifest.count {
        if store
            .delete(&chunk_account(account, manifest, index))
            .is_err()
        {
            failed = true;
        }
    }
    if failed {
        Err(vault_error())
    } else {
        Ok(())
    }
}
#[cfg(any(target_os = "windows", test))]
fn chunked_read(store: &dyn CredentialStore, account: &str) -> Result<Option<String>, String> {
    let Some(root) = store.read(account)? else {
        return Ok(None);
    };
    let Some(manifest) = chunk_manifest(&root)? else {
        return Ok(Some(root));
    };
    let mut encoded = String::new();
    for index in 0..manifest.count {
        let chunk = store
            .read(&chunk_account(account, &manifest, index))?
            .ok_or_else(vault_error)?;
        if chunk.len() > 1000 || !chunk.is_ascii() {
            return Err(vault_error());
        }
        encoded.push_str(&chunk);
    }
    let bytes = URL_SAFE_NO_PAD.decode(encoded).map_err(|_| vault_error())?;
    if bytes.len() > 65_536 || URL_SAFE_NO_PAD.encode(Sha256::digest(&bytes)) != manifest.digest {
        return Err(vault_error());
    }
    String::from_utf8(bytes)
        .map(Some)
        .map_err(|_| vault_error())
}
#[cfg(any(target_os = "windows", test))]
fn chunked_write(store: &dyn CredentialStore, account: &str, value: &str) -> Result<(), String> {
    if value.len() > 65_536 {
        return Err(vault_error());
    }
    let previous = store
        .read(account)?
        .map(|root| chunk_manifest(&root))
        .transpose()?
        .flatten();
    if value.len() <= 1000 && !value.starts_with(CHUNK_PREFIX) {
        store.write(account, value)?;
        if let Some(previous) = previous {
            let _ = delete_chunks(store, account, &previous);
        }
        return Ok(());
    }
    let encoded = URL_SAFE_NO_PAD.encode(value.as_bytes());
    let manifest = ChunkManifest {
        generation: random_secret(),
        count: encoded.len().div_ceil(1000),
        digest: URL_SAFE_NO_PAD.encode(Sha256::digest(value.as_bytes())),
    };
    for (index, chunk) in encoded.as_bytes().chunks(1000).enumerate() {
        let ascii = std::str::from_utf8(chunk).map_err(|_| vault_error())?;
        if store
            .write(&chunk_account(account, &manifest, index), ascii)
            .is_err()
        {
            let _ = delete_chunks(store, account, &manifest);
            return Err(vault_error());
        }
    }
    let root = format!(
        "{CHUNK_PREFIX}{}",
        serde_json::to_string(&manifest).map_err(|_| vault_error())?
    );
    if store.write(account, &root).is_err() {
        let _ = delete_chunks(store, account, &manifest);
        return Err(vault_error());
    }
    if let Some(previous) = previous {
        let _ = delete_chunks(store, account, &previous);
    }
    Ok(())
}
#[cfg(any(target_os = "windows", test))]
fn chunked_delete(store: &dyn CredentialStore, account: &str) -> Result<(), String> {
    let manifest = store
        .read(account)?
        .map(|root| chunk_manifest(&root))
        .transpose()?
        .flatten();
    if let Some(manifest) = manifest {
        delete_chunks(store, account, &manifest)?;
    }
    // Keep the manifest when chunk deletion fails so a later disconnect can find
    // and erase remaining encrypted fragments. A partially erased read fails closed.
    store.delete(account)?;
    Ok(())
}
#[cfg(any(not(target_os = "macos"), test))]
fn vault_error() -> String {
    "OS 자격 증명 저장소에 접근할 수 없습니다. macOS Keychain 또는 Windows 자격 증명 관리자 권한을 확인하세요.".into()
}

type TokenFuture<'a> = Pin<Box<dyn Future<Output = Result<Value, TokenFailure>> + Send + 'a>>;
struct TokenRequest {
    endpoint: &'static str,
    get: bool,
    parameters: Vec<(String, String)>,
    bearer: Option<String>,
}
#[derive(Clone, Copy)]
struct TokenFailure {
    permanent: bool,
    outcome: &'static str,
}
impl TokenFailure {
    fn transient(outcome: &'static str) -> Self {
        Self {
            permanent: false,
            outcome,
        }
    }
    fn invalid() -> Self {
        Self {
            permanent: true,
            outcome: "credential_rejected",
        }
    }
    fn message(self) -> String {
        if self.permanent {
            "SNS 인증이 만료되었거나 취소되었습니다. 다시 연결하세요.".into()
        } else {
            "SNS 인증 서버에 연결할 수 없습니다. 잠시 후 다시 시도하세요.".into()
        }
    }
}
trait TokenTransport: Send + Sync {
    fn send(&self, request: TokenRequest) -> TokenFuture<'_>;
}
struct OfficialTransport;
impl TokenTransport for OfficialTransport {
    fn send(&self, request: TokenRequest) -> TokenFuture<'_> {
        Box::pin(async move {
            // Fixed endpoint allowlist prevents an edited configuration becoming SSRF or
            // sending secrets to a caller-selected token endpoint. No redirects/proxies.
            if !allowed_endpoint(request.endpoint) {
                return Err(TokenFailure::invalid());
            }
            let client = reqwest::Client::builder()
                .no_proxy()
                .redirect(reqwest::redirect::Policy::none())
                .timeout(Duration::from_secs(15))
                .connect_timeout(Duration::from_secs(8))
                .build()
                .map_err(|_| TokenFailure::transient("transport_unavailable"))?;
            let mut builder = if request.get {
                client.get(request.endpoint).query(&request.parameters)
            } else {
                client.post(request.endpoint).form(&request.parameters)
            };
            if let Some(token) = request.bearer {
                builder = builder.bearer_auth(token);
            }
            let mut response = builder
                .header("Accept", "application/json")
                .header("Cache-Control", "no-store")
                .send()
                .await
                .map_err(|_| TokenFailure::transient("network_failure"))?;
            let status = response.status();
            if response
                .content_length()
                .is_some_and(|length| length > MAX_RESPONSE as u64)
            {
                return Err(TokenFailure::transient("oversized_response"));
            }
            let mut bytes = Vec::new();
            while let Some(chunk) = response
                .chunk()
                .await
                .map_err(|_| TokenFailure::transient("network_failure"))?
            {
                if bytes.len() + chunk.len() > MAX_RESPONSE {
                    return Err(TokenFailure::transient("oversized_response"));
                }
                bytes.extend_from_slice(&chunk);
            }
            let body: Value = serde_json::from_slice(&bytes)
                .map_err(|_| TokenFailure::transient("invalid_response"))?;
            if let Some(error) = provider_error(&body) {
                return Err(error);
            }
            if !status.is_success() {
                return Err(if status.as_u16() == 401 {
                    TokenFailure::invalid()
                } else {
                    TokenFailure::transient("provider_failure")
                });
            }
            Ok(body)
        })
    }
}
fn allowed_endpoint(endpoint: &str) -> bool {
    PROVIDERS
        .into_iter()
        .any(|p| p.token_endpoint() == endpoint)
        || [
            "https://graph.threads.net/access_token",
            "https://graph.threads.net/refresh_access_token",
            "https://graph.instagram.com/access_token",
            "https://graph.instagram.com/refresh_access_token",
            "https://graph.threads.net/v1.0/me/permissions",
            "https://graph.instagram.com/v25.0/me/permissions",
            "https://graph.facebook.com/v25.0/me/permissions",
        ]
        .contains(&endpoint)
}
fn provider_error(body: &Value) -> Option<TokenFailure> {
    let error = body
        .get("error")
        .filter(|v| !v.is_null() && v.as_str() != Some(""));
    if error.is_none() && body.get("error_type").is_none() {
        return None;
    }
    let code = error.and_then(Value::as_str).unwrap_or("");
    let meta_code = error.and_then(|v| v.get("code")).and_then(Value::as_u64);
    Some(
        if [
            "invalid_grant",
            "invalid_token",
            "access_denied",
            "invalid_refresh_token",
        ]
        .contains(&code)
            || matches!(meta_code, Some(190 | 102))
        {
            TokenFailure::invalid()
        } else {
            TokenFailure::transient("provider_rejected")
        },
    )
}

trait Clock: Send + Sync {
    fn now(&self) -> u64;
}
struct SystemClock;
impl Clock for SystemClock {
    fn now(&self) -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs()
    }
}

struct OAuthService {
    store: Arc<dyn CredentialStore>,
    transport: Arc<dyn TokenTransport>,
    clock: Arc<dyn Clock>,
    gate: Mutex<()>,
    pending: StdMutex<HashMap<String, PendingLogin>>,
    loopback_listener: StdMutex<Option<JoinHandle<()>>>,
}
impl OAuthService {
    fn new(
        store: Arc<dyn CredentialStore>,
        transport: Arc<dyn TokenTransport>,
        clock: Arc<dyn Clock>,
    ) -> Self {
        Self {
            store,
            transport,
            clock,
            gate: Mutex::new(()),
            pending: StdMutex::new(HashMap::new()),
            loopback_listener: StdMutex::new(None),
        }
    }
    fn read<T: for<'de> Deserialize<'de>>(
        &self,
        kind: &str,
        provider: Provider,
    ) -> Result<Option<T>, String> {
        self.store
            .read(&format!("{kind}:{}", provider.id()))?
            .map(|raw| {
                if raw.len() > 65_536 {
                    return Err("저장된 OAuth 정보를 확인할 수 없습니다. 다시 연결하세요.".into());
                }
                serde_json::from_str(&raw)
                    .map_err(|_| "저장된 OAuth 정보를 확인할 수 없습니다. 다시 연결하세요.".into())
            })
            .transpose()
    }
    fn write<T: Serialize>(&self, kind: &str, provider: Provider, value: &T) -> Result<(), String> {
        let raw = serde_json::to_string(value).map_err(|_| "OAuth 정보를 저장할 수 없습니다.")?;
        self.store.write(&format!("{kind}:{}", provider.id()), &raw)
    }
    fn audit(&self, provider: Provider, event: &str, outcome: &str) -> Result<(), String> {
        let mut events = self
            .read::<Vec<AuditEvent>>("audit", provider)?
            .unwrap_or_default();
        events.push(AuditEvent {
            at: self.clock.now(),
            event: event.into(),
            outcome: outcome.into(),
        });
        // Windows credential blobs are small; do not let history grow indefinitely.
        if events.len() > 12 {
            events.drain(..events.len() - 12);
        }
        self.write("audit", provider, &events)
    }
    fn cancel_pending(&self, provider: Provider) {
        if let Some(pending) = self
            .pending
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .remove(provider.id())
        {
            let _ = pending.cancel.send(true);
        }
    }
    fn cleanup_pending(&self) {
        let now = self.clock.now();
        self.pending
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .retain(|_, pending| {
                if pending.expires_at <= now {
                    let _ = pending.cancel.send(true);
                    false
                } else {
                    true
                }
            });
    }
    async fn stop_previous_loopback_listener(&self) {
        let previous = self
            .loopback_listener
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .take();
        if let Some(task) = previous {
            // Abort first: a callback may already be waiting for our OAuth gate.
            // Joining it without cancellation while holding that gate deadlocks.
            task.abort();
            let _ = task.await;
        }
    }
    fn status_locked(&self) -> Value {
        self.cleanup_pending();
        let now = self.clock.now();
        let providers: Vec<Value> = PROVIDERS.into_iter().map(|provider| {
            let client_result = self.read::<ClientConfig>("client", provider);
            let session_result = self.read::<TokenSession>("session", provider);
            let error = client_result.as_ref().err().or(session_result.as_ref().err()).cloned();
            let client = client_result.ok().flatten(); let session = session_result.ok().flatten();
            let configured = client.as_ref().is_some_and(|config| validate_client(provider, config).is_ok());
            let connected = configured && session.as_ref().is_some_and(|s| !s.needs_reconnect && s.expires_at > now);
            let refreshable = configured && session.as_ref().is_some_and(|s| s.refreshable(provider, now));
            let needs_reconnect = session.as_ref().is_some_and(|s| s.needs_reconnect || (!refreshable && s.expires_at <= now));
            let pending = self.pending.lock().unwrap_or_else(|p| p.into_inner()).contains_key(provider.id());
            let detail = error.unwrap_or_else(|| if pending { "선택한 브라우저에서 인증을 완료하세요. 로그인 요청은 5분 뒤 만료됩니다.".into() }
                else if needs_reconnect { "연결이 만료되었거나 취소되었습니다. 다시 로그인하세요.".into() }
                else if session.as_ref().is_some_and(|s| s.failures > 0) { "갱신에 실패했습니다. 연결 가능한 경우 자동으로 다시 시도합니다.".into() }
                else if connected { if provider.meta() { "OS 저장소에 연결을 보관하고 만료 전에 장기 토큰을 갱신합니다.".into() } else { "OS 저장소에 연결을 보관하고 만료 전에 리프레시 토큰으로 갱신합니다.".into() } }
                else { provider.help().into() });
            let audit: Vec<AuditEvent> = self.read("audit", provider).ok().flatten().unwrap_or_default();
            json!({ "platform":provider.id(), "label":provider.label(), "clientConfigured":configured,
                "connected":connected, "uploadAuthorized":connected && provider == Provider::Youtube && session.as_ref().is_some_and(|s| has_upload_scope(&s.scopes)), "publishingAuthorized":connected && session.as_ref().is_some_and(|s| provider.publishing_authorized(&s.scopes)), "publishingScopes":session.as_ref().map(|s| s.scopes.clone()).unwrap_or_default(), "expiresAt":session.as_ref().and_then(|s| timestamp(s.expires_at)),
                "refreshable":refreshable, "needsReconnect":needs_reconnect, "detail":detail,
                "tiktokAuditDeclared":provider == Provider::Tiktok && client.as_ref().is_some_and(|c| c.tiktok_audit_declared), "redirectUri":client.as_ref().map(|c| c.redirect_uri.as_str()), "pending":pending,
                "audit":audit, "cookieStorage":"system_browser", "tokenStorage":"os_credentials" })
        }).collect();
        json!({"providers":providers})
    }
    async fn status(&self) -> Result<Value, String> {
        let _guard = self.gate.lock().await;
        Ok(self.status_locked())
    }
    async fn save_client(&self, provider: Provider, input: Value) -> Result<Value, String> {
        let _guard = self.gate.lock().await;
        let object = input.as_object().ok_or("OAuth 설정 형식을 확인하세요.")?;
        if object.keys().any(|key| {
            ![
                "clientId",
                "clientSecret",
                "redirectUri",
                "tiktokAuditDeclared",
            ]
            .contains(&key.as_str())
        }) {
            return Err("지원하지 않는 OAuth 설정입니다.".into());
        }
        let mut config = self
            .read::<ClientConfig>("client", provider)?
            .unwrap_or_else(|| ClientConfig {
                redirect_uri: if provider.meta() {
                    String::new()
                } else {
                    provider.default_redirect()
                },
                ..Default::default()
            });
        for (key, value) in object {
            if key == "tiktokAuditDeclared" {
                if provider != Provider::Tiktok {
                    return Err("TikTok 앱 심사 설정은 TikTok에만 적용됩니다.".into());
                }
                config.tiktok_audit_declared = value
                    .as_bool()
                    .ok_or("TikTok 앱 심사 설정 형식을 확인하세요.")?;
                continue;
            }
            let text = value
                .as_str()
                .ok_or("OAuth 설정은 텍스트로 입력하세요.")?
                .trim();
            if text.is_empty() {
                continue;
            }
            if text.len() > 2048 || text.chars().any(char::is_control) {
                return Err("OAuth 설정 길이 또는 형식을 확인하세요.".into());
            }
            match key.as_str() {
                "clientId" => config.client_id = text.into(),
                "clientSecret" => config.client_secret = Some(text.into()),
                "redirectUri" => config.redirect_uri = text.into(),
                _ => unreachable!(),
            }
        }
        validate_client(provider, &config)?;
        // Invalidate a grant if its client or redirect changes. It must never be
        // silently attached to a different developer application/account context.
        let previous = self.read::<ClientConfig>("client", provider)?;
        let changed = previous.as_ref().is_some_and(|old| {
            old.client_id != config.client_id
                || old.client_secret != config.client_secret
                || old.redirect_uri != config.redirect_uri
        });
        if changed {
            self.store.delete(&format!("session:{}", provider.id()))?;
            // Audit approval belongs to one developer app, not to the user account.
            // Changing client credentials requires a fresh explicit declaration.
            config.tiktok_audit_declared = false;
        }
        self.cancel_pending(provider);
        self.write("client", provider, &config)?;
        self.audit(provider, "client_saved", "success")?;
        Ok(self.status_locked())
    }
    async fn begin_login(self: &Arc<Self>, provider: Provider) -> Result<Value, String> {
        self.begin_login_mode(provider, false).await
    }
    async fn begin_login_mode(
        self: &Arc<Self>,
        provider: Provider,
        upload: bool,
    ) -> Result<Value, String> {
        let _guard = self.gate.lock().await;
        self.cleanup_pending();
        let config = self
            .read::<ClientConfig>("client", provider)?
            .ok_or_else(|| provider.help().to_string())?;
        validate_client(provider, &config)?;
        self.cancel_pending(provider);
        let loopback = Url::parse(&config.redirect_uri)
            .map_err(|_| "콜백 주소를 확인하세요.")?
            .scheme()
            == "http";
        let listener = if loopback {
            if self
                .pending
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .values()
                .any(|p| p.client.redirect_uri.starts_with("http:"))
            {
                return Err("다른 SNS 로그인 요청을 먼저 완료하세요.".into());
            }
            // Cancelling the watch receiver only schedules the old listener to
            // stop. Wait for its task to drop the socket before reusing our fixed
            // callback port; otherwise an immediate retry fails with AddrInUse.
            self.stop_previous_loopback_listener().await;
            Some(TcpListener::bind(("127.0.0.1", CALLBACK_PORT)).await.map_err(|_| "로컬 OAuth 포트가 사용 중입니다. 진행 중인 로그인을 완료한 후 다시 시도하세요.")?)
        } else {
            None
        };
        let state = random_secret();
        let verifier = matches!(provider, Provider::Youtube | Provider::Tiktok).then(random_secret);
        let authorization_url =
            authorization_url_for_mode(provider, &config, &state, verifier.as_deref(), upload)?;
        let (cancel, receiver) = watch::channel(false);
        self.pending
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .insert(
                provider.id().into(),
                PendingLogin {
                    state: state.clone(),
                    verifier,
                    client: config.clone(),
                    expires_at: self.clock.now() + LOGIN_TTL,
                    cancel,
                    publishing: upload,
                },
            );
        if let Err(error) = self.audit(provider, "login_started", "pending") {
            self.cancel_pending(provider);
            return Err(error);
        }
        if let Some(listener) = listener {
            let service = self.clone();
            let task = tokio::spawn(async move {
                service.listen(provider, listener, receiver).await;
            });
            *self
                .loopback_listener
                .lock()
                .unwrap_or_else(|p| p.into_inner()) = Some(task);
        }
        Ok(
            json!({"authorizationUrl":authorization_url, "redirectUri":config.redirect_uri, "pending":true, "manualCallback":!loopback}),
        )
    }
    async fn complete_login(&self, provider: Provider, input: Value) -> Result<Value, String> {
        let _guard = self.gate.lock().await;
        let object = input.as_object().ok_or("콜백 주소를 입력하세요.")?;
        if object.keys().any(|key| key != "callbackUrl") {
            return Err("콜백 URL만 입력하세요.".into());
        }
        let callback_url = object
            .get("callbackUrl")
            .and_then(Value::as_str)
            .ok_or("콜백 주소를 입력하세요.")?;
        let callback = {
            let pending = self.pending.lock().unwrap_or_else(|p| p.into_inner());
            let pending = pending
                .get(provider.id())
                .ok_or("진행 중인 로그인이 없습니다. 다시 시작하세요.")?;
            if pending.expires_at <= self.clock.now() {
                return Err("로그인 요청이 만료되었습니다. 다시 시작하세요.".into());
            }
            validate_callback(
                provider,
                &pending.client.redirect_uri,
                &pending.state,
                callback_url,
            )
        };
        let callback = match callback {
            Ok(callback) => callback,
            Err(error) => {
                self.audit(provider, "callback_rejected", "validation_failed")?;
                return Err(error);
            }
        };
        // Consume before any network operation. A code/state cannot be retried or
        // replayed after an error, a cancelled grant, or an ambiguous network result.
        let pending = self
            .pending
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .remove(provider.id())
            .ok_or("로그인 요청이 이미 사용되었습니다.")?;
        let _ = pending.cancel.send(true);
        if callback.denied {
            self.audit(provider, "login_failed", "user_denied")?;
            return Err("SNS 로그인이 취소되었습니다.".into());
        }
        let request = authorization_code_request(
            provider,
            &pending.client,
            &pending,
            callback.code.as_deref().unwrap_or(""),
        );
        let mut response = match self.transport.send(request).await {
            Ok(value) => value,
            Err(failure) => {
                self.audit(provider, "login_failed", failure.outcome)?;
                return Err(failure.message());
            }
        };
        // Instagram's code exchange may wrap exactly one token in data. Reject
        // multiple/ambiguous grants instead of choosing another account's token.
        if provider == Provider::Instagram && response.get("access_token").is_none() {
            if let Some(data) = response.get("data").and_then(Value::as_array) {
                if data.len() != 1 || !data[0].is_object() {
                    return Err("Instagram 인증 응답이 모호합니다. 계정을 다시 연결하세요.".into());
                }
                response = data[0].clone();
            }
        }
        // Meta documents a one-hour short-lived token but can omit expires_in in
        // this first response. It is only an input to the immediate long exchange.
        if provider.meta() && response.get("expires_in").is_none() {
            response
                .as_object_mut()
                .ok_or("SNS 인증 응답을 확인할 수 없습니다.")?
                .insert("expires_in".into(), json!(3600));
        }
        let mut session = session_from_response(&response, None, self.clock.now(), false)
            .map_err(|_| "SNS 인증 응답을 확인할 수 없습니다. 다시 로그인하세요.")?;
        if provider.meta() {
            let response = match self
                .transport
                .send(long_lived_request(provider, &pending.client, &session))
                .await
            {
                Ok(value) => value,
                Err(failure) => {
                    self.audit(provider, "login_failed", failure.outcome)?;
                    return Err(failure.message());
                }
            };
            session = session_from_response(&response, Some(&session), self.clock.now(), true)
                .map_err(|_| "SNS 장기 인증 응답을 확인할 수 없습니다. 다시 로그인하세요.")?;
        }
        // Meta token exchanges omit scopes. Never infer consent from what was requested:
        // verify the provider's granted permissions before advertising publishing access.
        if pending.publishing {
            if let Some(endpoint) = provider.permissions_endpoint() {
                let permissions = self
                    .transport
                    .send(TokenRequest {
                        endpoint,
                        get: true,
                        parameters: vec![],
                        bearer: Some(session.access_token.clone()),
                    })
                    .await
                    .map_err(TokenFailure::message)?;
                session.scopes = granted_permissions(&permissions)?;
            }
        }
        self.write("session", provider, &session)?;
        self.audit(provider, "login_completed", "success")?;
        Ok(self.status_locked())
    }
    async fn refresh_session(&self, provider: Provider) -> Result<Value, String> {
        let _guard = self.gate.lock().await;
        self.refresh_locked(provider, false).await?;
        Ok(self.status_locked())
    }
    async fn refresh_locked(&self, provider: Provider, automatic: bool) -> Result<(), String> {
        let Some(client) = self.read::<ClientConfig>("client", provider)? else {
            return if automatic {
                Ok(())
            } else {
                Err(provider.help().into())
            };
        };
        let Some(mut session) = self.read::<TokenSession>("session", provider)? else {
            return if automatic {
                Ok(())
            } else {
                Err("연결된 SNS 세션이 없습니다.".into())
            };
        };
        let now = self.clock.now();
        if !session.refreshable(provider, now) {
            if session.expires_at <= now && !session.needs_reconnect {
                session.needs_reconnect = true;
                self.write("session", provider, &session)?;
                self.audit(provider, "refresh_failed", "expired")?;
            }
            return if automatic {
                Ok(())
            } else {
                Err("갱신할 수 없는 세션입니다. 다시 로그인하세요.".into())
            };
        }
        if provider.meta() && now < session.issued_at.saturating_add(DAY) {
            return if automatic {
                Ok(())
            } else {
                Err("장기 토큰은 발급 또는 갱신 후 24시간이 지나야 다시 갱신할 수 있습니다.".into())
            };
        }
        if automatic
            && (session.retry_at > now
                || session.expires_at
                    > now.saturating_add(if provider.meta() { 7 * DAY } else { 300 }))
        {
            return Ok(());
        }
        let refreshed = self
            .transport
            .send(refresh_request(provider, &client, &session))
            .await
            .and_then(|response| {
                session_from_response(&response, Some(&session), now, provider.meta())
                    .map_err(|_| TokenFailure::transient("invalid_response"))
            });
        match refreshed {
            Ok(rotated) => {
                // One credential replacement contains both new tokens and expiry.
                // Preserve the old refresh token when the provider omits it.
                self.write("session", provider, &rotated)?;
                self.audit(provider, "session_refreshed", "success")?;
                Ok(())
            }
            Err(failure) => {
                session.failures = session.failures.saturating_add(1);
                session.retry_at = now.saturating_add(match session.failures {
                    1 => 60,
                    2 => 300,
                    _ => 900,
                });
                if failure.permanent {
                    session.needs_reconnect = true;
                }
                self.write("session", provider, &session)?;
                self.audit(provider, "refresh_failed", failure.outcome)?;
                if automatic {
                    Ok(())
                } else {
                    Err(failure.message())
                }
            }
        }
    }
    async fn refresh_due(&self) -> Result<(), String> {
        let _guard = self.gate.lock().await;
        // Continue other accounts when one provider/vault entry cannot be refreshed.
        let mut failed = false;
        for provider in PROVIDERS {
            if self.refresh_locked(provider, true).await.is_err() {
                failed = true;
            }
        }
        if failed {
            Err("일부 SNS 세션을 갱신할 수 없습니다. 연결 상태를 확인하세요.".into())
        } else {
            Ok(())
        }
    }
    async fn disconnect(&self, provider: Provider) -> Result<Value, String> {
        let _guard = self.gate.lock().await;
        self.cancel_pending(provider);
        self.store.delete(&format!("session:{}", provider.id()))?;
        self.audit(provider, "session_disconnected", "local_only")?;
        Ok(self.status_locked())
    }
    async fn listen(
        self: Arc<Self>,
        provider: Provider,
        listener: TcpListener,
        mut cancel: watch::Receiver<bool>,
    ) {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(LOGIN_TTL);
        loop {
            let accepted = tokio::select! {
                accepted = listener.accept() => accepted.ok(),
                _ = tokio::time::sleep_until(deadline) => {
                    let _guard = self.gate.lock().await;
                    let expired = self.pending.lock().unwrap_or_else(|p| p.into_inner()).get(provider.id()).is_some_and(|pending| pending.expires_at <= self.clock.now());
                    if expired { self.cancel_pending(provider); let _ = self.audit(provider, "login_failed", "expired"); }
                    return;
                },
                _ = cancel.changed() => return,
            };
            let Some((mut stream, peer)) = accepted else {
                return;
            };
            if !peer.ip().is_loopback() {
                continue;
            }
            let callback = match tokio::time::timeout(
                Duration::from_secs(5),
                read_callback_request(&mut stream, provider),
            )
            .await
            {
                Ok(Ok(callback)) => callback,
                _ => {
                    respond(&mut stream, false).await;
                    continue;
                }
            };
            let success = self
                .complete_login(provider, json!({"callbackUrl":callback}))
                .await
                .is_ok();
            respond(&mut stream, success).await;
            if !self
                .pending
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .contains_key(provider.id())
            {
                return;
            }
        }
    }
}

fn timestamp(seconds: u64) -> Option<String> {
    i64::try_from(seconds)
        .ok()
        .and_then(|seconds| DateTime::<Utc>::from_timestamp(seconds, 0))
        .map(|time| time.to_rfc3339())
}
fn random_secret() -> String {
    let mut bytes = [0_u8; 32];
    OsRng.fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}
fn validate_client(provider: Provider, client: &ClientConfig) -> Result<(), String> {
    if client.client_id.trim().is_empty()
        || client.client_id.len() > 2048
        || client.client_id.chars().any(char::is_control)
    {
        return Err("OAuth Client ID를 입력하세요.".into());
    }
    if provider.secret_required()
        && client
            .client_secret
            .as_ref()
            .map_or(true, |s| s.trim().is_empty())
    {
        return Err("OAuth Client Secret을 입력하세요.".into());
    }
    let redirect =
        Url::parse(&client.redirect_uri).map_err(|_| "등록된 OAuth 콜백 주소를 입력하세요.")?;
    if !redirect.username().is_empty()
        || redirect.password().is_some()
        || redirect.query().is_some()
        || redirect.fragment().is_some()
        || redirect.host_str().is_none()
    {
        return Err("OAuth 콜백은 사용자 정보, 쿼리 또는 해시가 없는 고정 주소여야 합니다.".into());
    }
    if provider.meta() {
        if redirect.scheme() != "https"
            || matches!(
                redirect.host_str(),
                Some("127.0.0.1" | "localhost" | "[::1]")
            )
        {
            return Err("Meta에 등록된 실제 HTTPS 콜백 주소를 입력하세요. 인증 후 그 콜백 URL을 앱에 붙여 넣으세요.".into());
        }
    } else if client.redirect_uri != provider.default_redirect() {
        return Err(format!(
            "이 SNS의 로컬 콜백을 {}로 등록하세요.",
            provider.default_redirect()
        ));
    }
    Ok(())
}
#[cfg(test)]
fn authorization_url(
    provider: Provider,
    client: &ClientConfig,
    state: &str,
    verifier: Option<&str>,
) -> Result<String, String> {
    authorization_url_for_mode(provider, client, state, verifier, false)
}
fn authorization_url_for_mode(
    provider: Provider,
    client: &ClientConfig,
    state: &str,
    verifier: Option<&str>,
    upload: bool,
) -> Result<String, String> {
    if upload && provider.publishing_scope().is_none() {
        return Err("이 SNS는 공식 영상 게시 연결을 지원하지 않습니다.".into());
    }
    let mut url =
        Url::parse(provider.authorization_endpoint()).map_err(|_| "인증 주소 설정 오류")?;
    let mut query = url.query_pairs_mut();
    query
        .append_pair(
            if provider == Provider::Tiktok {
                "client_key"
            } else {
                "client_id"
            },
            &client.client_id,
        )
        .append_pair("response_type", "code")
        .append_pair("redirect_uri", &client.redirect_uri)
        .append_pair("state", state);
    if !provider.basic_scope().is_empty() {
        let scope = if upload {
            provider.publishing_scope().unwrap_or_default().to_owned()
        } else {
            provider.basic_scope().to_owned()
        };
        query.append_pair("scope", &scope);
    }
    if provider == Provider::Youtube {
        query
            .append_pair("access_type", "offline")
            .append_pair("prompt", "consent");
    }
    if provider == Provider::Instagram {
        query.append_pair("enable_fb_login", "0");
    }
    if let Some(verifier) = verifier {
        let digest = Sha256::digest(verifier.as_bytes());
        // TikTok Desktop explicitly requires hex(SHA256), unlike Google/RFC7636.
        let challenge = if provider == Provider::Tiktok {
            digest.iter().map(|byte| format!("{byte:02x}")).collect()
        } else {
            URL_SAFE_NO_PAD.encode(digest)
        };
        query
            .append_pair("code_challenge", &challenge)
            .append_pair("code_challenge_method", "S256");
    }
    drop(query);
    Ok(url.into())
}
struct ValidCallback {
    code: Option<String>,
    denied: bool,
}
fn validate_callback(
    provider: Provider,
    redirect_uri: &str,
    state: &str,
    raw: &str,
) -> Result<ValidCallback, String> {
    if raw.len() > MAX_CALLBACK || raw.chars().any(char::is_control) {
        return Err("콜백 주소가 너무 길거나 잘못되었습니다.".into());
    }
    let expected = Url::parse(redirect_uri).map_err(|_| "콜백 주소 설정 오류")?;
    let received = Url::parse(raw).map_err(|_| "SNS에서 이동한 전체 콜백 주소를 붙여 넣으세요.")?;
    if received.scheme() != expected.scheme()
        || received.host_str() != expected.host_str()
        || received.port_or_known_default() != expected.port_or_known_default()
        || received.path() != expected.path()
        || !received.username().is_empty()
        || received.password().is_some()
        || received
            .fragment()
            .is_some_and(|fragment| !(provider == Provider::Instagram && fragment == "_"))
    {
        return Err("등록된 OAuth 콜백 주소와 일치하지 않습니다.".into());
    }
    let mut values = HashMap::new();
    for (key, value) in received.query_pairs() {
        if ["state", "code", "error"].contains(&key.as_ref())
            && values
                .insert(key.into_owned(), value.into_owned())
                .is_some()
        {
            return Err("중복 OAuth 응답은 사용할 수 없습니다.".into());
        }
    }
    if values.get("state").map(String::as_str) != Some(state) {
        return Err("OAuth 요청 확인에 실패했습니다. 앱에서 로그인을 다시 시작하세요.".into());
    }
    let denied = values.contains_key("error");
    let code = values.remove("code");
    if !denied
        && code
            .as_ref()
            .map_or(true, |code| code.is_empty() || code.len() > 4096)
    {
        return Err("OAuth 인증 코드가 없습니다.".into());
    }
    if denied && code.is_some() {
        return Err("잘못된 OAuth 인증 응답입니다.".into());
    }
    Ok(ValidCallback { code, denied })
}
fn base_parameters(provider: Provider, client: &ClientConfig) -> Vec<(String, String)> {
    let mut values = vec![(
        if provider == Provider::Tiktok {
            "client_key"
        } else {
            "client_id"
        }
        .into(),
        client.client_id.clone(),
    )];
    if let Some(secret) = &client.client_secret {
        values.push(("client_secret".into(), secret.clone()));
    }
    values
}
fn authorization_code_request(
    provider: Provider,
    client: &ClientConfig,
    pending: &PendingLogin,
    code: &str,
) -> TokenRequest {
    let mut values = base_parameters(provider, client);
    values.extend([
        ("grant_type".into(), "authorization_code".into()),
        ("code".into(), code.into()),
        ("redirect_uri".into(), client.redirect_uri.clone()),
    ]);
    if provider == Provider::NaverBlog {
        values.push(("state".into(), pending.state.clone()));
    }
    if let Some(verifier) = &pending.verifier {
        values.push(("code_verifier".into(), verifier.clone()));
    }
    TokenRequest {
        endpoint: provider.token_endpoint(),
        get: false,
        parameters: values,
        bearer: None,
    }
}
fn long_lived_request(
    provider: Provider,
    client: &ClientConfig,
    session: &TokenSession,
) -> TokenRequest {
    if provider == Provider::Facebook {
        return TokenRequest {
            endpoint: provider.token_endpoint(),
            get: true,
            parameters: vec![
                ("grant_type".into(), "fb_exchange_token".into()),
                ("client_id".into(), client.client_id.clone()),
                (
                    "client_secret".into(),
                    client.client_secret.clone().unwrap_or_default(),
                ),
                ("fb_exchange_token".into(), session.access_token.clone()),
            ],
            bearer: None,
        };
    }
    let (endpoint, grant) = if provider == Provider::Threads {
        (
            "https://graph.threads.net/access_token",
            "th_exchange_token",
        )
    } else {
        (
            "https://graph.instagram.com/access_token",
            "ig_exchange_token",
        )
    };
    TokenRequest {
        endpoint,
        get: true,
        parameters: vec![
            ("grant_type".into(), grant.into()),
            (
                "client_secret".into(),
                client.client_secret.clone().unwrap_or_default(),
            ),
            ("access_token".into(), session.access_token.clone()),
        ],
        bearer: None,
    }
}
fn refresh_request(
    provider: Provider,
    client: &ClientConfig,
    session: &TokenSession,
) -> TokenRequest {
    if provider == Provider::Facebook {
        return long_lived_request(provider, client, session);
    }
    if provider.meta() {
        let (endpoint, grant) = if provider == Provider::Threads {
            (
                "https://graph.threads.net/refresh_access_token",
                "th_refresh_token",
            )
        } else {
            (
                "https://graph.instagram.com/refresh_access_token",
                "ig_refresh_token",
            )
        };
        TokenRequest {
            endpoint,
            get: true,
            parameters: vec![
                ("grant_type".into(), grant.into()),
                ("access_token".into(), session.access_token.clone()),
            ],
            bearer: None,
        }
    } else {
        let mut values = base_parameters(provider, client);
        values.extend([
            ("grant_type".into(), "refresh_token".into()),
            (
                "refresh_token".into(),
                session.refresh_token.clone().unwrap_or_default(),
            ),
        ]);
        TokenRequest {
            endpoint: provider.token_endpoint(),
            get: false,
            parameters: values,
            bearer: None,
        }
    }
}
fn positive_seconds(value: &Value, key: &str) -> Option<u64> {
    value
        .get(key)
        .and_then(|v| {
            v.as_u64()
                .or_else(|| v.as_str().and_then(|s| s.parse().ok()))
        })
        .filter(|seconds| *seconds > 0 && *seconds < 10 * 365 * DAY)
}
fn session_from_response(
    response: &Value,
    previous: Option<&TokenSession>,
    now: u64,
    long_lived: bool,
) -> Result<TokenSession, ()> {
    let token = response
        .get("access_token")
        .and_then(Value::as_str)
        .filter(|v| !v.is_empty() && v.len() <= MAX_TOKEN && !v.chars().any(char::is_control))
        .ok_or(())?;
    let lifetime = positive_seconds(response, "expires_in").ok_or(())?;
    let refresh_token = match response.get("refresh_token") {
        Some(Value::String(value))
            if !value.is_empty()
                && value.len() <= MAX_TOKEN
                && !value.chars().any(char::is_control) =>
        {
            Some(value.clone())
        }
        Some(Value::Null) | None => previous.and_then(|session| session.refresh_token.clone()),
        _ => return Err(()),
    };
    let refresh_expires_at = positive_seconds(response, "refresh_expires_in")
        .map(|seconds| now.saturating_add(seconds))
        .or_else(|| previous.and_then(|s| s.refresh_expires_at));
    Ok(TokenSession {
        access_token: token.into(),
        refresh_token,
        expires_at: now.saturating_add(lifetime),
        refresh_expires_at,
        issued_at: now,
        long_lived,
        needs_reconnect: false,
        failures: 0,
        retry_at: 0,
        scopes: match response.get("scope") {
            Some(Value::String(raw)) if raw.len() <= 8192 => raw
                .split(|c: char| c.is_whitespace() || c == ',')
                .filter(|s| !s.is_empty())
                .map(str::to_owned)
                .collect(),
            None | Some(Value::Null) => previous.map(|s| s.scopes.clone()).unwrap_or_default(),
            _ => return Err(()),
        },
    })
}
async fn read_callback_request(
    stream: &mut TcpStream,
    provider: Provider,
) -> Result<String, String> {
    let mut bytes = Vec::new();
    let mut chunk = [0_u8; 1024];
    loop {
        let length = stream
            .read(&mut chunk)
            .await
            .map_err(|_| "callback_read_failed")?;
        if length == 0 {
            return Err("callback_incomplete".into());
        }
        if bytes.len() + length > MAX_CALLBACK {
            return Err("callback_oversized".into());
        }
        bytes.extend_from_slice(&chunk[..length]);
        if bytes.windows(4).any(|window| window == b"\r\n\r\n") {
            break;
        }
    }
    let text = std::str::from_utf8(&bytes).map_err(|_| "callback_invalid")?;
    callback_url_from_request(text, provider)
}
fn callback_url_from_request(text: &str, provider: Provider) -> Result<String, String> {
    if text.len() > MAX_CALLBACK {
        return Err("callback_oversized".into());
    }
    let mut lines = text.split("\r\n");
    let first = lines.next().ok_or("callback_invalid")?;
    let parts: Vec<_> = first.split(' ').collect();
    if parts.len() != 3 || parts[0] != "GET" || !matches!(parts[2], "HTTP/1.1" | "HTTP/1.0") {
        return Err("callback_invalid".into());
    }
    let host: Vec<_> = lines
        .filter_map(|line| line.split_once(':'))
        .filter(|(name, _)| name.eq_ignore_ascii_case("host"))
        .collect();
    if host.len() != 1 || host[0].1.trim() != format!("127.0.0.1:{CALLBACK_PORT}") {
        return Err("callback_invalid_host".into());
    }
    let expected_path = format!("/oauth/{}/callback", provider.id());
    if parts[1].split('?').next() != Some(expected_path.as_str()) {
        return Err("callback_invalid_path".into());
    }
    Ok(format!("http://127.0.0.1:{CALLBACK_PORT}{}", parts[1]))
}
async fn respond(stream: &mut TcpStream, success: bool) {
    // Static HTML, no code/state/token/provider-controlled error body reflected.
    let body = if success {
        "<!doctype html><meta charset=utf-8><title>Toris Studio</title><p>Connection saved. Return to Toris Studio.</p>"
    } else {
        "<!doctype html><meta charset=utf-8><title>Toris Studio</title><p>Connection could not be completed. Check Toris Studio.</p>"
    };
    let response = format!("HTTP/1.1 {}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nCache-Control: no-store\r\nContent-Security-Policy: default-src 'none'; frame-ancestors 'none'\r\nReferrer-Policy: no-referrer\r\nConnection: close\r\n\r\n{body}", if success { "200 OK" } else { "400 Bad Request" }, body.len());
    let _ = tokio::time::timeout(
        Duration::from_secs(2),
        stream.write_all(response.as_bytes()),
    )
    .await;
    let _ = stream.shutdown().await;
}

fn service() -> &'static Arc<OAuthService> {
    static INSTANCE: OnceLock<Arc<OAuthService>> = OnceLock::new();
    INSTANCE.get_or_init(|| {
        Arc::new(OAuthService::new(
            Arc::new(OsCredentialStore),
            Arc::new(OfficialTransport),
            Arc::new(SystemClock),
        ))
    })
}
pub async fn status() -> Result<Value, String> {
    service().status().await
}
pub async fn save_client(platform: String, input: Value) -> Result<Value, String> {
    service()
        .save_client(Provider::parse(&platform)?, input)
        .await
}
/// Explicit publishing consent; normal account login remains read-only.
pub async fn begin_publish_login(platform: String) -> Result<Value, String> {
    let provider = Provider::parse(&platform)?;
    if provider.publishing_scope().is_none() {
        return Err("이 SNS는 영상 게시 권한을 제공하지 않습니다.".into());
    }
    service().begin_login_mode(provider, true).await
}
/// Credentials are intentionally native-only. This type is never serialized or Debug.
pub(crate) struct PublishingAccess {
    pub token: String,
    pub scopes: Vec<String>,
    pub tiktok_audit_declared: bool,
}
pub(crate) async fn publishing_access(platform: &str) -> Result<PublishingAccess, String> {
    let provider = Provider::parse(platform)?;
    let service = service();
    let _guard = service.gate.lock().await;
    let session = service
        .read::<TokenSession>("session", provider)?
        .ok_or("게시 계정에 로그인하세요.")?;
    if session.needs_reconnect {
        return Err("SNS 계정을 다시 연결하세요.".into());
    }
    if session.expires_at <= service.clock.now() + 60 {
        service.refresh_locked(provider, false).await?;
    }
    let session = service
        .read::<TokenSession>("session", provider)?
        .ok_or("SNS 연결을 확인하세요.")?;
    if session.needs_reconnect
        || session.expires_at <= service.clock.now()
        || !provider.publishing_authorized(&session.scopes)
    {
        return Err(
            "이 계정의 게시 권한을 별도로 승인하세요. 읽기 전용 연결은 게시 권한이 아닙니다."
                .into(),
        );
    }
    let audit_declared = provider == Provider::Tiktok
        && service
            .read::<ClientConfig>("client", provider)?
            .is_some_and(|client| client.tiktok_audit_declared);
    Ok(PublishingAccess {
        token: session.access_token,
        scopes: session.scopes,
        tiktok_audit_declared: audit_declared,
    })
}
fn granted_permissions(response: &Value) -> Result<Vec<String>, String> {
    let data = response
        .get("data")
        .and_then(Value::as_array)
        .ok_or("SNS 게시 권한 응답을 확인할 수 없습니다.")?;
    let scopes: Vec<String> = data
        .iter()
        .filter(|item| item["status"] == "granted")
        .filter_map(|item| item["permission"].as_str())
        .filter(|scope| scope.len() <= 256)
        .map(str::to_owned)
        .collect();
    Ok(scopes)
}
pub async fn begin_youtube_upload_login() -> Result<Value, String> {
    service().begin_login_mode(Provider::Youtube, true).await
}
/// Token remains native-only and is used solely for fixed Google API endpoints.
pub(crate) async fn youtube_upload_access() -> Result<String, String> {
    let service = service();
    let _guard = service.gate.lock().await;
    let provider = Provider::Youtube;
    let session = service
        .read::<TokenSession>("session", provider)?
        .ok_or("YouTube 업로드 계정에 로그인하세요.")?;
    if !has_upload_scope(&session.scopes) {
        return Err(
            "YouTube 업로드 권한을 추가로 승인하세요. 기존 읽기 연결은 그대로 유지됩니다.".into(),
        );
    }
    if session.needs_reconnect {
        return Err("YouTube 계정에 다시 로그인하세요.".into());
    }
    if session.expires_at <= service.clock.now() + 60 {
        service.refresh_locked(provider, false).await?;
    }
    let session = service
        .read::<TokenSession>("session", provider)?
        .ok_or("YouTube 연결을 확인하세요.")?;
    if session.needs_reconnect
        || session.expires_at <= service.clock.now()
        || !has_upload_scope(&session.scopes)
    {
        return Err("YouTube 업로드 권한을 다시 승인하세요.".into());
    }
    Ok(session.access_token)
}
pub async fn begin_login(platform: String) -> Result<Value, String> {
    service().begin_login(Provider::parse(&platform)?).await
}
pub async fn complete_login(platform: String, input: Value) -> Result<Value, String> {
    service()
        .complete_login(Provider::parse(&platform)?, input)
        .await
}
pub async fn refresh_session(platform: String) -> Result<Value, String> {
    service().refresh_session(Provider::parse(&platform)?).await
}
pub async fn disconnect(platform: String) -> Result<Value, String> {
    service().disconnect(Provider::parse(&platform)?).await
}
pub async fn refresh_due() -> Result<(), String> {
    service().refresh_due().await
}

#[cfg(test)]
#[path = "oauth_upload_tests.rs"]
mod upload_tests;

#[cfg(test)]
#[path = "oauth_live_tests.rs"]
mod live_tests;

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn browser_choice_rejects_executables_and_arguments() {
        assert_eq!(
            serde_json::from_str::<LoginBrowser>("\"system\"")
                .unwrap()
                .program(),
            None
        );
        assert!(serde_json::from_str::<LoginBrowser>("\"aside\"")
            .unwrap()
            .program()
            .is_some());
        for input in [
            "\"/tmp/aside\"",
            "\"Aside --profile other\"",
            "\"sh\"",
            "{}",
        ] {
            assert!(serde_json::from_str::<LoginBrowser>(input).is_err());
        }
    }
    #[test]
    fn browser_url_encodes_arguments_and_rejects_unsafe_destinations() {
        let encoded =
            canonical_browser_url("https://example.com/?q=\" --disable-web-security").unwrap();
        assert!(!encoded.contains('"'));
        assert!(!encoded.chars().any(char::is_whitespace));
        assert!(encoded.contains("%22%20"));
        assert!(canonical_browser_url("http://127.0.0.1:38471/oauth/naver_blog/callback").is_ok());
        for raw in [
            "https://example.com/\n",
            "https://user:secret@example.com/",
            "http://example.com/",
            "file:///tmp/file",
        ] {
            assert!(canonical_browser_url(raw).is_err());
        }
    }
    use std::collections::VecDeque;
    use std::sync::atomic::{AtomicU64, Ordering};
    #[derive(Default)]
    struct MemoryStore(StdMutex<HashMap<String, String>>);
    impl CredentialStore for MemoryStore {
        fn read(&self, account: &str) -> Result<Option<String>, String> {
            Ok(self.0.lock().unwrap().get(account).cloned())
        }
        fn write(&self, account: &str, value: &str) -> Result<(), String> {
            self.0.lock().unwrap().insert(account.into(), value.into());
            Ok(())
        }
        fn delete(&self, account: &str) -> Result<(), String> {
            self.0.lock().unwrap().remove(account);
            Ok(())
        }
    }
    #[derive(Default)]
    struct NativeWindowsMemoryStore(StdMutex<HashMap<String, String>>);
    impl CredentialStore for NativeWindowsMemoryStore {
        fn read(&self, account: &str) -> Result<Option<String>, String> {
            Ok(self.0.lock().unwrap().get(account).cloned())
        }
        fn write(&self, account: &str, value: &str) -> Result<(), String> {
            // Mirror keyring's Windows set_password UTF-16 blob limit exactly.
            if value.encode_utf16().count() * 2 > 2560 {
                return Err("native Windows credential size limit".into());
            }
            self.0.lock().unwrap().insert(account.into(), value.into());
            Ok(())
        }
        fn delete(&self, account: &str) -> Result<(), String> {
            self.0.lock().unwrap().remove(account);
            Ok(())
        }
    }
    #[derive(Default)]
    struct MockTransport {
        responses: StdMutex<VecDeque<Result<Value, TokenFailure>>>,
        requests: StdMutex<Vec<TokenRequest>>,
    }
    impl TokenTransport for MockTransport {
        fn send(&self, request: TokenRequest) -> TokenFuture<'_> {
            self.requests.lock().unwrap().push(request);
            let response = self
                .responses
                .lock()
                .unwrap()
                .pop_front()
                .expect("unexpected token request");
            Box::pin(async move { response })
        }
    }
    struct TestClock(AtomicU64);
    impl Clock for TestClock {
        fn now(&self) -> u64 {
            self.0.load(Ordering::Relaxed)
        }
    }
    fn fixture() -> (
        Arc<OAuthService>,
        Arc<MemoryStore>,
        Arc<MockTransport>,
        Arc<TestClock>,
    ) {
        let store = Arc::new(MemoryStore::default());
        let transport = Arc::new(MockTransport::default());
        let clock = Arc::new(TestClock(AtomicU64::new(100_000)));
        (
            Arc::new(OAuthService::new(
                store.clone(),
                transport.clone(),
                clock.clone(),
            )),
            store,
            transport,
            clock,
        )
    }
    fn client(provider: Provider) -> ClientConfig {
        ClientConfig {
            tiktok_audit_declared: false,
            client_id: "example-client-id".into(),
            client_secret: Some("fixture-secret".into()),
            redirect_uri: if provider.meta() {
                "https://oauth.example.test/callback".into()
            } else {
                provider.default_redirect()
            },
        }
    }
    fn add_pending(service: &OAuthService, provider: Provider, state: &str, expires_at: u64) {
        let (cancel, _) = watch::channel(false);
        service.pending.lock().unwrap().insert(
            provider.id().into(),
            PendingLogin {
                state: state.into(),
                verifier: Some("fixture-verifier".into()),
                client: client(provider),
                expires_at,
                cancel,
                publishing: false,
            },
        );
    }
    fn token(now: u64) -> TokenSession {
        session_from_response(
            &json!({"access_token":"old-access", "refresh_token":"old-refresh", "expires_in":3600}),
            None,
            now,
            false,
        )
        .unwrap()
    }
    #[test]
    fn redirects_are_exact_and_secrets_never_enter_authorization_url() {
        for provider in PROVIDERS {
            let config = client(provider);
            assert!(validate_client(provider, &config).is_ok());
            let url =
                authorization_url(provider, &config, "unique-state", Some("verifier")).unwrap();
            assert!(!url.contains("fixture-secret"));
            assert!(!url.contains("client_secret"));
            assert!(validate_callback(
                provider,
                &config.redirect_uri,
                "unique-state",
                &format!("{}?code=example&state=unique-state", config.redirect_uri)
            )
            .is_ok());
            assert!(validate_callback(
                provider,
                &config.redirect_uri,
                "unique-state",
                "https://attacker.test/callback?code=a&state=unique-state"
            )
            .is_err());
        }
        let mut config = client(Provider::Youtube);
        config.redirect_uri = "http://localhost:38471/oauth/youtube/callback".into();
        assert!(validate_client(Provider::Youtube, &config).is_err());
        config = client(Provider::Instagram);
        config.redirect_uri = "https://127.0.0.1:38471/oauth/instagram/callback".into();
        assert!(validate_client(Provider::Instagram, &config).is_err());
    }
    #[test]
    fn pkce_uses_google_base64_and_tiktok_hex() {
        let verifier = random_secret();
        assert_eq!(verifier.len(), 43);
        let google = Url::parse(
            &authorization_url(
                Provider::Youtube,
                &client(Provider::Youtube),
                "state",
                Some(&verifier),
            )
            .unwrap(),
        )
        .unwrap();
        let tiktok = Url::parse(
            &authorization_url(
                Provider::Tiktok,
                &client(Provider::Tiktok),
                "state",
                Some(&verifier),
            )
            .unwrap(),
        )
        .unwrap();
        assert_eq!(
            google
                .query_pairs()
                .find(|(k, _)| k == "code_challenge")
                .unwrap()
                .1
                .len(),
            43
        );
        assert_eq!(
            tiktok
                .query_pairs()
                .find(|(k, _)| k == "code_challenge")
                .unwrap()
                .1
                .len(),
            64
        );
    }
    #[tokio::test]
    async fn restarting_loopback_login_releases_port_and_rejects_old_state() {
        let (service, _, transport, _) = fixture();
        for provider in [Provider::Youtube, Provider::NaverBlog] {
            service
                .write("client", provider, &client(provider))
                .unwrap();
        }
        let first = service.begin_login(Provider::Youtube).await.unwrap();
        let first_url = Url::parse(first["authorizationUrl"].as_str().unwrap()).unwrap();
        let old_state = first_url
            .query_pairs()
            .find(|(key, _)| key == "state")
            .unwrap()
            .1
            .into_owned();
        let second = service.begin_login(Provider::Youtube).await.expect(
            "restarting our own pending login must release its listener before binding again",
        );
        let second_url = Url::parse(second["authorizationUrl"].as_str().unwrap()).unwrap();
        let new_state = second_url
            .query_pairs()
            .find(|(key, _)| key == "state")
            .unwrap()
            .1
            .into_owned();
        assert_ne!(old_state, new_state);
        assert!(service.begin_login(Provider::NaverBlog).await.is_err());
        assert!(service.complete_login(Provider::Youtube, json!({"callbackUrl":format!("{}?code=old-code&state={old_state}", Provider::Youtube.default_redirect())})).await.is_err());
        assert!(transport.requests.lock().unwrap().is_empty());
        assert!(service.status().await.unwrap()["providers"][0]["pending"]
            .as_bool()
            .unwrap());
        service.disconnect(Provider::Youtube).await.unwrap();
        service
            .begin_login(Provider::NaverBlog)
            .await
            .expect("a disconnected listener must not block the next provider");
        service.disconnect(Provider::NaverBlog).await.unwrap();
        service.stop_previous_loopback_listener().await;
        // A listener can reach complete_login while another command holds the
        // gate. Cancellation must release its socket without waiting on the gate.
        let listener = TcpListener::bind(("127.0.0.1", CALLBACK_PORT))
            .await
            .unwrap();
        let held_gate = service.gate.lock().await;
        let waiting_service = service.clone();
        let waiting = tokio::spawn(async move {
            let _listener = listener;
            let _guard = waiting_service.gate.lock().await;
        });
        *service.loopback_listener.lock().unwrap() = Some(waiting);
        tokio::task::yield_now().await;
        tokio::time::timeout(
            Duration::from_secs(1),
            service.stop_previous_loopback_listener(),
        )
        .await
        .expect("a callback waiting for the gate must remain cancellable");
        assert!(TcpListener::bind(("127.0.0.1", CALLBACK_PORT))
            .await
            .is_ok());
        drop(held_gate);
    }
    #[test]
    fn callback_rejects_duplicate_state_cross_provider_and_fragments() {
        let redirect = Provider::Youtube.default_redirect();
        for suffix in [
            "?code=a&state=valid&state=valid",
            "?code=a&state=other",
            "?code=a&state=valid#code=b",
            "?error=denied&code=a&state=valid",
        ] {
            assert!(validate_callback(
                Provider::Youtube,
                &redirect,
                "valid",
                &(redirect.clone() + suffix)
            )
            .is_err());
        }
        assert!(validate_callback(
            Provider::Youtube,
            &redirect,
            "valid",
            &format!("{}?code=a&state=valid", Provider::Tiktok.default_redirect())
        )
        .is_err());
    }
    #[tokio::test]
    async fn completion_is_single_use_and_public_status_redacts_credentials() {
        let (service, _, transport, _) = fixture();
        let provider = Provider::Youtube;
        service
            .write("client", provider, &client(provider))
            .unwrap();
        add_pending(&service, provider, "valid", 100_300);
        transport.responses.lock().unwrap().push_back(Ok(json!({"access_token":"secret-access-value", "refresh_token":"secret-refresh-value", "expires_in":3600})));
        let input = json!({"callbackUrl":format!("{}?code=secret-code-value&state=valid",provider.default_redirect())});
        let result = service
            .complete_login(provider, input.clone())
            .await
            .unwrap();
        assert!(result["providers"][0]["connected"].as_bool().unwrap());
        for secret in [
            "secret-access-value",
            "secret-refresh-value",
            "fixture-secret",
            "secret-code-value",
            "example-client-id",
        ] {
            assert!(!result.to_string().contains(secret));
        }
        assert!(service.complete_login(provider, input).await.is_err());
        assert_eq!(transport.requests.lock().unwrap().len(), 1);
    }
    #[tokio::test]
    async fn expired_and_forged_pending_make_no_network_request() {
        let (service, _, transport, _) = fixture();
        let provider = Provider::Youtube;
        add_pending(&service, provider, "valid", 99_999);
        assert!(service
            .complete_login(
                provider,
                json!({"callbackUrl":format!("{}?code=a&state=valid",provider.default_redirect())})
            )
            .await
            .is_err());
        add_pending(&service, provider, "valid", 100_300);
        assert!(service
            .complete_login(
                provider,
                json!({"callbackUrl":format!("{}?code=a&state=wrong",provider.default_redirect())})
            )
            .await
            .is_err());
        assert!(transport.requests.lock().unwrap().is_empty());
    }
    #[tokio::test]
    async fn refresh_rotates_atomically_and_preserves_omitted_refresh_token() {
        let (service, _, transport, clock) = fixture();
        let provider = Provider::Tiktok;
        service
            .write("client", provider, &client(provider))
            .unwrap();
        service
            .write("session", provider, &token(clock.now()))
            .unwrap();
        transport.responses.lock().unwrap().extend([Ok(json!({"access_token":"new-access", "refresh_token":"rotated-refresh", "expires_in":7200})), Ok(json!({"access_token":"next-access", "expires_in":3600}))]);
        service.refresh_session(provider).await.unwrap();
        service.refresh_session(provider).await.unwrap();
        let session: TokenSession = service.read("session", provider).unwrap().unwrap();
        assert_eq!(session.refresh_token.as_deref(), Some("rotated-refresh"));
        assert_eq!(session.access_token, "next-access");
        assert!(transport.requests.lock().unwrap()[1]
            .parameters
            .contains(&("refresh_token".into(), "rotated-refresh".into())));
    }
    #[tokio::test]
    async fn rejected_refresh_requires_reconnect_and_never_retries_automatically() {
        let (service, _, transport, clock) = fixture();
        let provider = Provider::Youtube;
        service
            .write("client", provider, &client(provider))
            .unwrap();
        service
            .write("session", provider, &token(clock.now()))
            .unwrap();
        transport
            .responses
            .lock()
            .unwrap()
            .push_back(Err(TokenFailure::invalid()));
        assert!(service.refresh_session(provider).await.is_err());
        service.refresh_due().await.unwrap();
        let result = service.status().await.unwrap();
        assert_eq!(result["providers"][0]["connected"], false);
        assert_eq!(result["providers"][0]["needsReconnect"], true);
        assert_eq!(transport.requests.lock().unwrap().len(), 1);
    }
    #[tokio::test]
    async fn transient_refresh_backs_off_and_expired_access_is_never_connected() {
        let (service, _, transport, clock) = fixture();
        let provider = Provider::Youtube;
        service
            .write("client", provider, &client(provider))
            .unwrap();
        let mut session = token(clock.now());
        session.expires_at = clock.now() - 1;
        service.write("session", provider, &session).unwrap();
        transport
            .responses
            .lock()
            .unwrap()
            .push_back(Err(TokenFailure::transient("network_failure")));
        service.refresh_due().await.unwrap();
        service.refresh_due().await.unwrap();
        assert_eq!(
            service.status().await.unwrap()["providers"][0]["connected"],
            false
        );
        assert_eq!(transport.requests.lock().unwrap().len(), 1);
    }
    #[tokio::test]
    async fn disconnect_retains_client_and_other_provider_but_prevents_pending_replay() {
        let (service, _, _, clock) = fixture();
        let provider = Provider::Youtube;
        service
            .write("client", provider, &client(provider))
            .unwrap();
        service
            .write("session", provider, &token(clock.now()))
            .unwrap();
        service
            .write("session", Provider::Tiktok, &token(clock.now()))
            .unwrap();
        add_pending(&service, provider, "valid", 100_300);
        service.disconnect(provider).await.unwrap();
        assert!(service
            .read::<ClientConfig>("client", provider)
            .unwrap()
            .is_some());
        assert!(service
            .read::<TokenSession>("session", provider)
            .unwrap()
            .is_none());
        assert!(service
            .read::<TokenSession>("session", Provider::Tiktok)
            .unwrap()
            .is_some());
        assert!(service
            .complete_login(
                provider,
                json!({"callbackUrl":format!("{}?code=a&state=valid",provider.default_redirect())})
            )
            .await
            .is_err());
    }
    #[tokio::test]
    async fn blank_client_fields_preserve_and_changed_client_invalidates_session() {
        let (service, _, _, clock) = fixture();
        let provider = Provider::Youtube;
        service
            .write("client", provider, &client(provider))
            .unwrap();
        service
            .write("session", provider, &token(clock.now()))
            .unwrap();
        service
            .save_client(
                provider,
                json!({"clientId":"", "clientSecret":"", "redirectUri":""}),
            )
            .await
            .unwrap();
        assert_eq!(
            service
                .read::<ClientConfig>("client", provider)
                .unwrap()
                .unwrap()
                .client_secret
                .as_deref(),
            Some("fixture-secret")
        );
        assert!(service
            .read::<TokenSession>("session", provider)
            .unwrap()
            .is_some());
        service
            .save_client(provider, json!({"clientId":"different-client"}))
            .await
            .unwrap();
        assert!(service
            .read::<TokenSession>("session", provider)
            .unwrap()
            .is_none());
    }
    #[tokio::test]
    async fn meta_tokens_are_upgraded_and_refresh_waits_twenty_four_hours() {
        let (service, _, transport, clock) = fixture();
        let provider = Provider::Threads;
        service
            .write("client", provider, &client(provider))
            .unwrap();
        add_pending(&service, provider, "valid", 100_300);
        transport.responses.lock().unwrap().extend([
            Ok(json!({"access_token":"short-meta"})),
            Ok(json!({"access_token":"long-meta", "expires_in":60*DAY})),
        ]);
        service
            .complete_login(
                provider,
                json!({"callbackUrl":"https://oauth.example.test/callback?code=a&state=valid"}),
            )
            .await
            .unwrap();
        assert_eq!(transport.requests.lock().unwrap().len(), 2);
        assert!(service.refresh_session(provider).await.is_err());
        clock.0.store(100_000 + DAY, Ordering::Relaxed);
        transport.responses.lock().unwrap().push_back(Ok(
            json!({"access_token":"refreshed-meta", "expires_in":60*DAY}),
        ));
        service.refresh_session(provider).await.unwrap();
        assert_eq!(
            transport.requests.lock().unwrap()[2].endpoint,
            "https://graph.threads.net/refresh_access_token"
        );
    }
    #[test]
    fn endpoints_are_fixed_and_provider_errors_are_redacted() {
        assert!(!allowed_endpoint("https://attacker.test/token"));
        assert!(
            provider_error(&json!({"error":"invalid_grant", "error_description":"secret-token"}))
                .unwrap()
                .permanent
        );
        assert!(
            !provider_error(&json!({"error":{"code":4,"message":"secret-token"}}))
                .unwrap()
                .message()
                .contains("secret-token")
        );
    }
    #[test]
    fn callback_http_requires_get_exact_host_path_and_bounded_input() {
        let valid =
            "GET /oauth/youtube/callback?code=a&state=b HTTP/1.1\r\nHost: 127.0.0.1:38471\r\n\r\n";
        assert_eq!(
            callback_url_from_request(valid, Provider::Youtube).unwrap(),
            "http://127.0.0.1:38471/oauth/youtube/callback?code=a&state=b"
        );
        for invalid in [
            valid.replace("GET ", "POST "),
            valid.replace("127.0.0.1:38471", "attacker.example"),
            valid.replace("youtube/callback", "tiktok/callback"),
            valid.replace("\r\n\r\n", "\r\nHost: 127.0.0.1:38471\r\n\r\n"),
            "x".repeat(MAX_CALLBACK + 1),
        ] {
            assert!(callback_url_from_request(&invalid, Provider::Youtube).is_err());
        }
    }
    #[tokio::test]
    async fn malformed_refresh_response_has_retry_backoff() {
        let (service, _, transport, clock) = fixture();
        let provider = Provider::Youtube;
        service
            .write("client", provider, &client(provider))
            .unwrap();
        let mut session = token(clock.now());
        session.expires_at = clock.now() - 1;
        service.write("session", provider, &session).unwrap();
        transport
            .responses
            .lock()
            .unwrap()
            .push_back(Ok(json!({"access_token":"token-with-no-expiry"})));
        service.refresh_due().await.unwrap();
        service.refresh_due().await.unwrap();
        let session: TokenSession = service.read("session", provider).unwrap().unwrap();
        assert_eq!(session.failures, 1);
        assert!(session.retry_at > clock.now());
        assert_eq!(transport.requests.lock().unwrap().len(), 1);
    }
    #[test]
    fn windows_vault_chunks_large_unicode_records_and_cleans_rotation_and_disconnect() {
        let store = NativeWindowsMemoryStore::default();
        let first = "token-한글".repeat(2000);
        chunked_write(&store, "session:youtube", &first).unwrap();
        assert_eq!(
            chunked_read(&store, "session:youtube").unwrap().as_deref(),
            Some(first.as_str())
        );
        assert!(store
            .0
            .lock()
            .unwrap()
            .values()
            .all(|value| value.encode_utf16().count() * 2 <= 2560));
        let previous: Vec<String> = store
            .0
            .lock()
            .unwrap()
            .keys()
            .filter(|key| key.as_str() != "session:youtube")
            .cloned()
            .collect();
        let next = "rotated-token".repeat(1500);
        chunked_write(&store, "session:youtube", &next).unwrap();
        assert_eq!(
            chunked_read(&store, "session:youtube").unwrap().as_deref(),
            Some(next.as_str())
        );
        assert!(previous
            .iter()
            .all(|key| !store.0.lock().unwrap().contains_key(key)));
        chunked_delete(&store, "session:youtube").unwrap();
        assert!(store.0.lock().unwrap().is_empty());
        // Old single-blob credentials remain readable, then upgrade on a big write.
        store.write("client:youtube", "legacy-json").unwrap();
        assert_eq!(
            chunked_read(&store, "client:youtube").unwrap().as_deref(),
            Some("legacy-json")
        );
    }
    #[test]
    fn windows_chunk_commit_failure_preserves_previous_session() {
        struct FailingStore {
            inner: NativeWindowsMemoryStore,
            fail_root: std::sync::atomic::AtomicBool,
        }
        impl CredentialStore for FailingStore {
            fn read(&self, account: &str) -> Result<Option<String>, String> {
                self.inner.read(account)
            }
            fn write(&self, account: &str, value: &str) -> Result<(), String> {
                if account == "session:youtube" && self.fail_root.load(Ordering::Relaxed) {
                    Err("fixture failure".into())
                } else {
                    self.inner.write(account, value)
                }
            }
            fn delete(&self, account: &str) -> Result<(), String> {
                self.inner.delete(account)
            }
        }
        let store = FailingStore {
            inner: NativeWindowsMemoryStore::default(),
            fail_root: std::sync::atomic::AtomicBool::new(false),
        };
        let previous = "old-token".repeat(1000);
        chunked_write(&store, "session:youtube", &previous).unwrap();
        let count = store.inner.0.lock().unwrap().len();
        store.fail_root.store(true, Ordering::Relaxed);
        assert!(chunked_write(&store, "session:youtube", &"new-token".repeat(2000)).is_err());
        assert_eq!(
            chunked_read(&store, "session:youtube").unwrap().as_deref(),
            Some(previous.as_str())
        );
        assert_eq!(store.inner.0.lock().unwrap().len(), count);
    }
    #[test]
    fn windows_missing_or_modified_chunk_fails_closed() {
        let store = NativeWindowsMemoryStore::default();
        chunked_write(&store, "session:youtube", &"secret-token".repeat(1000)).unwrap();
        let root = store.read("session:youtube").unwrap().unwrap();
        let manifest = chunk_manifest(&root).unwrap().unwrap();
        store
            .write(&chunk_account("session:youtube", &manifest, 0), "tampered")
            .unwrap();
        assert!(chunked_read(&store, "session:youtube").is_err());
        store
            .delete(&chunk_account("session:youtube", &manifest, 0))
            .unwrap();
        assert!(chunked_read(&store, "session:youtube").is_err());
    }
    #[test]
    fn windows_utf16_limit_is_enforced_for_medium_ascii_and_maximum_record() {
        let store = NativeWindowsMemoryStore::default();
        assert!(store.write("raw", &"a".repeat(1281)).is_err());
        for value in [
            "a".repeat(2000),
            "한글".repeat(333),
            "🚀".repeat(400),
            "a".repeat(65_536),
        ] {
            chunked_write(&store, "session:youtube", &value).unwrap();
            assert_eq!(
                chunked_read(&store, "session:youtube").unwrap().as_deref(),
                Some(value.as_str())
            );
            assert!(store
                .0
                .lock()
                .unwrap()
                .values()
                .all(|value| value.encode_utf16().count() * 2 <= 2560));
        }
    }
    #[test]
    fn windows_disconnect_cleanup_failure_keeps_manifest_for_retry() {
        struct DeleteFailureStore {
            inner: NativeWindowsMemoryStore,
            fail_once: std::sync::atomic::AtomicBool,
        }
        impl CredentialStore for DeleteFailureStore {
            fn read(&self, account: &str) -> Result<Option<String>, String> {
                self.inner.read(account)
            }
            fn write(&self, account: &str, value: &str) -> Result<(), String> {
                self.inner.write(account, value)
            }
            fn delete(&self, account: &str) -> Result<(), String> {
                if account != "session:youtube" && self.fail_once.swap(false, Ordering::Relaxed) {
                    Err("fixture cleanup failure".into())
                } else {
                    self.inner.delete(account)
                }
            }
        }
        let store = DeleteFailureStore {
            inner: NativeWindowsMemoryStore::default(),
            fail_once: std::sync::atomic::AtomicBool::new(false),
        };
        chunked_write(&store, "session:youtube", &"a".repeat(8000)).unwrap();
        store.fail_once.store(true, Ordering::Relaxed);
        assert!(chunked_delete(&store, "session:youtube").is_err());
        assert!(store.read("session:youtube").unwrap().is_some());
        assert!(chunked_read(&store, "session:youtube").is_err());
        chunked_delete(&store, "session:youtube").unwrap();
        assert!(store.inner.0.lock().unwrap().is_empty());
    }
}
