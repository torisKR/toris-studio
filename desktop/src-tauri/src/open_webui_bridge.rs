//! Loopback-only Open WebUI to Codexify transport.
//!
//! Open WebUI supplies its user/chat identifiers on the server side. We turn
//! those into a separate Codexify session namespace, never the saved ChatGPT
//! conversation. Connecting does not select a project or execute a tool.
use axum::{
    body::{to_bytes, Body},
    extract::{Request, State},
    http::{header, HeaderMap, Method, StatusCode},
    response::{IntoResponse, Response},
    routing::any,
    Router,
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::{net::TcpListener, sync::Mutex, task::JoinHandle};

pub const PORT: u16 = 43181;
const HOST: &str = "127.0.0.1:43181";
const MAX_BODY: usize = 2 * 1024 * 1024;
const CHAT_HEADER: &str = "x-toris-webui-chat";
const USER_HEADER: &str = "x-toris-webui-user";
const MAX_SESSIONS: usize = 128;
const SESSION_TTL: Duration = Duration::from_secs(30 * 60);

#[derive(Default)]
pub struct Controller {
    task: Mutex<Option<JoinHandle<()>>>,
}

impl Controller {
    /// Bind our own listener. An unrelated occupied port is never adopted.
    pub async fn ensure_started(&self) -> Result<(), String> {
        let mut task = self.task.lock().await;
        if task.as_ref().is_some_and(|task| !task.is_finished()) {
            return Ok(());
        }
        *task = None;
        let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, PORT))
            .await
            .map_err(|_| "Open WebUI MCP 연결 포트(43181)를 사용할 수 없습니다.")?;
        let client = reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(3))
            .timeout(Duration::from_secs(300))
            .build()
            .map_err(|_| "Open WebUI MCP 연결을 준비하지 못했습니다.")?;
        let state = Arc::new(BridgeState {
            client,
            config_path: crate::config::config_path(),
            sessions: Mutex::new(HashMap::new()),
            #[cfg(test)]
            profile: None,
        });
        *task = Some(tokio::spawn(async move {
            let _ = axum::serve(listener, router(state)).await;
        }));
        Ok(())
    }

    pub async fn stop(&self) {
        if let Some(task) = self.task.lock().await.take() {
            task.abort();
            let _ = task.await;
        }
    }
}

impl Drop for Controller {
    fn drop(&mut self) {
        if let Some(task) = self.task.get_mut().take() {
            task.abort();
        }
    }
}

struct BridgeState {
    client: reqwest::Client,
    config_path: PathBuf,
    sessions: Mutex<HashMap<String, TransportSession>>,
    #[cfg(test)]
    profile: Option<Arc<std::sync::Mutex<crate::codexify_connection::Profile>>>,
}

#[derive(Clone, PartialEq, Eq)]
struct WebUiIdentity {
    user: String,
    chat: String,
}

struct TransportSession {
    upstream_id: String,
    profile: crate::codexify_connection::Profile,
    identity: Option<WebUiIdentity>,
    expires: Instant,
}

impl BridgeState {
    fn profile(&self) -> Result<crate::codexify_connection::Profile, String> {
        #[cfg(test)]
        if let Some(profile) = &self.profile {
            return profile
                .lock()
                .map(|profile| profile.clone())
                .map_err(|_| "Invalid profile.".into());
        }
        crate::codexify_connection::load()
    }
}

fn webui_identity(headers: &HeaderMap) -> Option<WebUiIdentity> {
    Some(WebUiIdentity {
        user: identity(headers, USER_HEADER).ok()?.into(),
        chat: identity(headers, CHAT_HEADER).ok()?.into(),
    })
}

fn transport_id(headers: &HeaderMap) -> Result<Option<&str>, &'static str> {
    let Some(value) = headers.get("mcp-session-id") else {
        return Ok(None);
    };
    let value = value.to_str().map_err(|_| "invalid_mcp_session")?;
    if value.is_empty()
        || value.len() > 512
        || !value.bytes().all(|byte| (0x21..=0x7e).contains(&byte))
    {
        return Err("invalid_mcp_session");
    }
    Ok(Some(value))
}

fn local_upstream(profile: &crate::codexify_connection::Profile) -> bool {
    let Ok(url) = url::Url::parse(&profile.mcp_url) else {
        return false;
    };
    matches!(url.scheme(), "http" | "https")
        && matches!(
            url.host_str(),
            Some("127.0.0.1" | "localhost" | "[::1]" | "::1")
        )
        && url.port_or_known_default() != Some(PORT)
        && url.username().is_empty()
        && url.password().is_none()
        && url.path() == "/mcp"
        && url.query().is_none()
        && url.fragment().is_none()
}

fn router(state: Arc<BridgeState>) -> Router {
    Router::new()
        .route("/health", any(health))
        .route("/mcp", any(mcp))
        .fallback(|| async { rejection(StatusCode::NOT_FOUND, "not_found") })
        .with_state(state)
}

fn rejection(status: StatusCode, code: &'static str) -> Response {
    (
        status,
        axum::Json(
            json!({ "error": { "code": code, "message": "Open WebUI MCP request was rejected." } }),
        ),
    )
        .into_response()
}

fn allowed_headers(headers: &HeaderMap) -> bool {
    headers
        .get(header::HOST)
        .and_then(|host| host.to_str().ok())
        == Some(HOST)
        && !headers.contains_key(header::ORIGIN)
        && !headers
            .keys()
            .any(|key| key.as_str().starts_with("sec-fetch-"))
}

async fn health(request: Request) -> Response {
    if !allowed_headers(request.headers()) {
        return rejection(StatusCode::FORBIDDEN, "invalid_origin");
    }
    if request.method() != Method::GET {
        return rejection(StatusCode::METHOD_NOT_ALLOWED, "method_not_allowed");
    }
    axum::Json(json!({ "ok": true, "service": "toris-studio-openwebui-mcp", "port": PORT }))
        .into_response()
}

fn identity<'a>(headers: &'a HeaderMap, name: &'static str) -> Result<&'a str, &'static str> {
    let value = headers
        .get(name)
        .and_then(|header| header.to_str().ok())
        .ok_or("missing_webui_identity")?;
    if value.is_empty()
        || value.len() > 128
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
        || matches!(value, "CHAT_ID" | "USER_ID" | "null" | "None" | "undefined")
    {
        return Err("invalid_webui_identity");
    }
    Ok(value)
}

fn session(
    config_path: &std::path::Path,
    profile: &crate::codexify_connection::Profile,
    user: &str,
    chat: &str,
) -> String {
    let mut hash = Sha256::new();
    for field in [
        "toris-studio/open-webui/session/v1",
        &config_path.to_string_lossy(),
        &profile.mcp_url,
        &profile.project_root,
        user,
        chat,
    ] {
        hash.update((field.len() as u64).to_le_bytes());
        hash.update(field.as_bytes());
    }
    format!("toris-openwebui-{:x}", hash.finalize())
}

fn prepare_body(
    bytes: &[u8],
    headers: &HeaderMap,
    profile: &crate::codexify_connection::Profile,
    config_path: &std::path::Path,
) -> Result<Vec<u8>, &'static str> {
    let mut value: Value = serde_json::from_slice(bytes).map_err(|_| "invalid_json_rpc")?;
    let object = value.as_object_mut().ok_or("invalid_json_rpc")?;
    if object.get("jsonrpc").and_then(Value::as_str) != Some("2.0") {
        return Err("invalid_json_rpc");
    }
    let method = object
        .get("method")
        .and_then(Value::as_str)
        .filter(|method| !method.is_empty() && method.len() <= 256)
        .ok_or("invalid_json_rpc")?;
    if method == "tools/call" {
        let user = identity(headers, USER_HEADER)?;
        let chat = identity(headers, CHAT_HEADER)?;
        let params = object
            .get_mut("params")
            .and_then(Value::as_object_mut)
            .ok_or("invalid_tool_call")?;
        let name = params
            .get("name")
            .and_then(Value::as_str)
            .filter(|name| !name.is_empty() && name.len() <= 256)
            .ok_or("invalid_tool_call")?;
        // Project selection is an explicit model tool call, constrained to the
        // project the owner selected in Toris Studio. Never create a worktree.
        if name == "set_project_root" {
            let arguments = params
                .get_mut("arguments")
                .and_then(Value::as_object_mut)
                .ok_or("invalid_project_selection")?;
            if profile.project_root.is_empty()
                || arguments.get("path").and_then(Value::as_str)
                    != Some(profile.project_root.as_str())
                || arguments
                    .get("createWorktree")
                    .is_some_and(|value| value != &Value::Bool(false))
            {
                return Err("project_selection_mismatch");
            }
            // Omission asks Codexify to use its configured worktree mode.
            // Explicitly select the existing source tree instead.
            arguments.insert("createWorktree".into(), Value::Bool(false));
        }
        let metadata = params.entry("_meta").or_insert_with(|| json!({}));
        let metadata = metadata.as_object_mut().ok_or("invalid_tool_metadata")?;
        metadata.insert(
            "openai/session".into(),
            Value::String(session(config_path, profile, user, chat)),
        );
    }
    serde_json::to_vec(&value).map_err(|_| "invalid_json_rpc")
}

async fn mcp(State(state): State<Arc<BridgeState>>, request: Request) -> Response {
    if !allowed_headers(request.headers()) {
        return rejection(StatusCode::FORBIDDEN, "invalid_origin");
    }
    if !matches!(
        *request.method(),
        Method::POST | Method::GET | Method::DELETE
    ) {
        return rejection(StatusCode::METHOD_NOT_ALLOWED, "method_not_allowed");
    }
    let (parts, body) = request.into_parts();
    if parts.uri.query().is_some() {
        return rejection(StatusCode::BAD_REQUEST, "invalid_path");
    }
    let profile = match state.profile() {
        Ok(profile) if local_upstream(&profile) => profile,
        _ => return rejection(StatusCode::SERVICE_UNAVAILABLE, "invalid_local_profile"),
    };
    let bytes = match to_bytes(body, MAX_BODY).await {
        Ok(bytes) => bytes,
        Err(_) => return rejection(StatusCode::PAYLOAD_TOO_LARGE, "request_too_large"),
    };
    let body = if parts.method == Method::POST {
        match prepare_body(&bytes, &parts.headers, &profile, &state.config_path) {
            Ok(body) => body,
            Err(code) => return rejection(StatusCode::BAD_REQUEST, code),
        }
    } else if !bytes.is_empty() {
        return rejection(StatusCode::BAD_REQUEST, "unexpected_body");
    } else {
        Vec::new()
    };
    let method = serde_json::from_slice::<Value>(&body)
        .ok()
        .and_then(|value| {
            value
                .get("method")
                .and_then(Value::as_str)
                .map(str::to_owned)
        });
    let initialize = method.as_deref() == Some("initialize");
    let tool_call = method.as_deref() == Some("tools/call");
    let context = webui_identity(&parts.headers);
    let adapter_id = match transport_id(&parts.headers) {
        Ok(id) => id.map(str::to_owned),
        Err(code) => return rejection(StatusCode::BAD_REQUEST, code),
    };
    if initialize && adapter_id.is_some() {
        return rejection(StatusCode::BAD_REQUEST, "unexpected_mcp_session");
    }
    if matches!(parts.method, Method::GET | Method::DELETE) && adapter_id.is_none() {
        return rejection(StatusCode::BAD_REQUEST, "missing_mcp_session");
    }
    let upstream_id = {
        let mut sessions = state.sessions.lock().await;
        sessions.retain(|_, session| session.expires > Instant::now());
        if initialize && sessions.len() >= MAX_SESSIONS {
            return rejection(StatusCode::TOO_MANY_REQUESTS, "mcp_session_limit");
        }
        if let Some(id) = &adapter_id {
            let Some(session) = sessions.get_mut(id) else {
                return rejection(StatusCode::BAD_REQUEST, "unknown_mcp_session");
            };
            if session.profile != profile {
                return rejection(StatusCode::CONFLICT, "mcp_profile_changed");
            }
            // Discovery may happen before templates have a chat/user value.
            // Bind once on the first identified tool call, atomically, then
            // require the same identity on all subsequent transport methods.
            if session.identity.is_none() && tool_call && context.is_some() {
                session.identity = context.clone();
            }
            if session.identity != context {
                return rejection(StatusCode::FORBIDDEN, "mcp_session_identity_mismatch");
            }
            session.expires = Instant::now() + SESSION_TTL;
            Some(session.upstream_id.clone())
        } else {
            None
        }
    };
    let mut upstream = state.client.request(parts.method.clone(), &profile.mcp_url);
    // Deliberately omit authorization, cookies, forwarding, origin and all
    // caller-supplied identity headers. Only MCP transport headers cross over.
    for name in [
        header::ACCEPT.as_str(),
        "mcp-protocol-version",
        "last-event-id",
    ] {
        if let Some(value) = parts.headers.get(name) {
            if value.as_bytes().len() > 4096 {
                return rejection(StatusCode::BAD_REQUEST, "invalid_transport_header");
            }
            upstream = upstream.header(name, value);
        }
    }
    if let Some(id) = upstream_id {
        upstream = upstream.header("mcp-session-id", id);
    }
    if parts.method == Method::POST {
        upstream = upstream
            .header(header::CONTENT_TYPE, "application/json")
            .body(body);
    }
    let upstream = match upstream.send().await {
        Ok(response) => response,
        Err(_) => return rejection(StatusCode::BAD_GATEWAY, "local_mcp_unavailable"),
    };
    if !upstream.status().is_success() {
        return rejection(upstream.status(), "local_mcp_rejected_request");
    }
    if state.profile().as_ref().ok() != Some(&profile) {
        return rejection(StatusCode::CONFLICT, "mcp_profile_changed");
    }
    let response_id = match transport_id(upstream.headers()) {
        Ok(id) => id.map(str::to_owned),
        Err(_) => return rejection(StatusCode::BAD_GATEWAY, "invalid_local_session"),
    };
    let returned_id = {
        let mut sessions = state.sessions.lock().await;
        sessions.retain(|_, session| session.expires > Instant::now());
        if parts.method == Method::DELETE {
            if let Some(id) = &adapter_id {
                sessions.remove(id);
            }
            None
        } else if let Some(id) = &adapter_id {
            let Some(session) = sessions.get_mut(id) else {
                return rejection(StatusCode::CONFLICT, "mcp_session_closed");
            };
            if let Some(upstream_id) = response_id {
                session.upstream_id = upstream_id;
            }
            Some(id.clone())
        } else if initialize {
            if let Some(upstream_id) = response_id {
                if sessions.len() >= MAX_SESSIONS {
                    return rejection(StatusCode::TOO_MANY_REQUESTS, "mcp_session_limit");
                }
                let id = format!("toris-webui-transport-{}", uuid::Uuid::new_v4());
                sessions.insert(
                    id.clone(),
                    TransportSession {
                        upstream_id,
                        profile,
                        identity: context,
                        expires: Instant::now() + SESSION_TTL,
                    },
                );
                Some(id)
            } else {
                None
            }
        } else {
            None
        }
    };
    let mut response = Response::builder().status(upstream.status());
    for name in [
        header::CONTENT_TYPE.as_str(),
        header::CACHE_CONTROL.as_str(),
        "mcp-protocol-version",
    ] {
        if let Some(value) = upstream.headers().get(name) {
            response = response.header(name, value);
        }
    }
    if let Some(id) = returned_id {
        response = response.header("mcp-session-id", id);
    }
    response
        .body(Body::from_stream(upstream.bytes_stream()))
        .unwrap_or_else(|_| rejection(StatusCode::BAD_GATEWAY, "invalid_local_response"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn profile() -> crate::codexify_connection::Profile {
        crate::codexify_connection::Profile {
            mcp_url: "http://127.0.0.1:21228/mcp".into(),
            project_root: "/projects/toris_studio".into(),
            conversation_id: "saved-chatgpt-conversation".into(),
            ..Default::default()
        }
    }

    fn headers() -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert(header::HOST, HOST.parse().unwrap());
        headers.insert(CHAT_HEADER, "chat-123".parse().unwrap());
        headers.insert(USER_HEADER, "user-456".parse().unwrap());
        headers
    }

    fn call() -> Value {
        json!({"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"get_agent_brief","arguments":{},"_meta":{"openai/session":"forged-chatgpt-session","other":"preserved"}}})
    }

    fn prepared(
        value: &Value,
        headers: &HeaderMap,
        profile: &crate::codexify_connection::Profile,
    ) -> Result<Value, &'static str> {
        prepare_body(
            &serde_json::to_vec(value).unwrap(),
            headers,
            profile,
            std::path::Path::new("/app/settings.json"),
        )
        .map(|bytes| serde_json::from_slice(&bytes).unwrap())
    }

    #[test]
    fn session_is_stable_and_isolates_users_chats_projects_and_installations() {
        let profile = profile();
        let path = std::path::Path::new("/app/settings.json");
        let first = session(path, &profile, "user-456", "chat-123");
        assert_eq!(first, session(path, &profile, "user-456", "chat-123"));
        assert_ne!(first, profile.conversation_id);
        assert!(first.starts_with("toris-openwebui-"));
        assert_ne!(first, session(path, &profile, "user-789", "chat-123"));
        assert_ne!(first, session(path, &profile, "user-456", "chat-789"));
        let mut changed = profile.clone();
        changed.project_root = "/projects/another".into();
        assert_ne!(first, session(path, &changed, "user-456", "chat-123"));
        changed = profile.clone();
        changed.mcp_url = "http://127.0.0.1:43157/mcp".into();
        assert_ne!(first, session(path, &changed, "user-456", "chat-123"));
        assert_ne!(
            first,
            session(
                std::path::Path::new("/another/settings.json"),
                &profile,
                "user-456",
                "chat-123"
            )
        );
        changed = profile.clone();
        changed.conversation_id = "different-chatgpt-conversation".into();
        assert_eq!(first, session(path, &changed, "user-456", "chat-123"));
    }

    #[test]
    fn only_tool_calls_receive_isolated_metadata() {
        let value = prepared(&call(), &headers(), &profile()).unwrap();
        assert_eq!(value["params"]["_meta"]["other"], "preserved");
        assert!(value["params"]["_meta"]["openai/session"]
            .as_str()
            .unwrap()
            .starts_with("toris-openwebui-"));
        for method in ["initialize", "tools/list", "notifications/initialized"] {
            let input = json!({"jsonrpc":"2.0","method":method,"params":{}});
            assert_eq!(
                prepared(&input, &HeaderMap::new(), &profile()).unwrap(),
                input
            );
        }
        assert!(prepared(&json!([]), &headers(), &profile()).is_err());
        assert!(prepared(&json!({"method":"tools/list"}), &headers(), &profile()).is_err());
        let mut invalid = call();
        invalid["params"]["_meta"] = json!("invalid");
        assert_eq!(
            prepared(&invalid, &headers(), &profile()),
            Err("invalid_tool_metadata")
        );
    }

    #[test]
    fn missing_invalid_and_unexpanded_identity_never_calls_tools() {
        for name in [CHAT_HEADER, USER_HEADER] {
            let mut missing = headers();
            missing.remove(name);
            assert_eq!(
                prepared(&call(), &missing, &profile()),
                Err("missing_webui_identity")
            );
            for invalid in [
                "",
                "{{CHAT_ID}}",
                "{{USER_ID}}",
                "null",
                "../chat",
                "CHAT_ID",
                "USER_ID",
            ] {
                let mut headers = headers();
                headers.insert(name, invalid.parse().unwrap());
                assert_eq!(
                    prepared(&call(), &headers, &profile()),
                    Err("invalid_webui_identity")
                );
            }
            let mut headers = headers();
            headers.insert(name, "a".repeat(129).parse().unwrap());
            assert_eq!(
                prepared(&call(), &headers, &profile()),
                Err("invalid_webui_identity")
            );
        }
    }

    #[test]
    fn selected_project_is_explicit_and_cannot_be_switched_by_tool_arguments() {
        let input = json!({"jsonrpc":"2.0","method":"tools/call","params":{"name":"set_project_root","arguments":{"path":"/projects/toris_studio"}}});
        assert_eq!(
            prepared(&input, &headers(), &profile()).unwrap()["params"]["arguments"]
                ["createWorktree"],
            Value::Bool(false)
        );
        let mut wrong = input.clone();
        wrong["params"]["arguments"]["path"] = json!("/projects/another");
        assert_eq!(
            prepared(&wrong, &headers(), &profile()),
            Err("project_selection_mismatch")
        );
        let mut empty = profile();
        empty.project_root.clear();
        assert_eq!(
            prepared(&input, &headers(), &empty),
            Err("project_selection_mismatch")
        );
        let mut worktree = input;
        worktree["params"]["arguments"]["createWorktree"] = Value::Bool(true);
        assert_eq!(
            prepared(&worktree, &headers(), &profile()),
            Err("project_selection_mismatch")
        );
        worktree["params"]["arguments"]["createWorktree"] = Value::Bool(false);
        assert!(prepared(&worktree, &headers(), &profile()).is_ok());
    }

    #[test]
    fn only_exact_host_without_browser_origin_is_allowed() {
        assert!(allowed_headers(&headers()));
        for host in [
            "localhost:43181",
            "host.docker.internal:43181",
            "127.0.0.1:43182",
            "attacker.example",
            "127.0.0.1:43181@attacker.example",
        ] {
            let mut headers = headers();
            headers.insert(header::HOST, host.parse().unwrap());
            assert!(!allowed_headers(&headers));
        }
        for name in ["origin", "sec-fetch-site", "sec-fetch-mode"] {
            let mut headers = headers();
            headers.insert(
                header::HeaderName::from_bytes(name.as_bytes()).unwrap(),
                "same-origin".parse().unwrap(),
            );
            assert!(!allowed_headers(&headers));
        }
    }

    async fn mock_bridge(upstream_url: String) -> (String, JoinHandle<()>, Arc<BridgeState>) {
        let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
            .await
            .unwrap();
        let address = listener.local_addr().unwrap();
        let mut profile = profile();
        profile.mcp_url = upstream_url;
        let state = Arc::new(BridgeState {
            client: reqwest::Client::builder()
                .no_proxy()
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .unwrap(),
            config_path: "/test/settings.json".into(),
            sessions: Mutex::new(HashMap::new()),
            profile: Some(Arc::new(std::sync::Mutex::new(profile))),
        });
        let served = state.clone();
        let task = tokio::spawn(async move {
            axum::serve(listener, router(served)).await.unwrap();
        });
        (format!("http://{address}"), task, state)
    }

    #[tokio::test]
    async fn streams_sse_preserves_mcp_sessions_and_does_not_forward_credentials() {
        let upstream = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
            .await
            .unwrap();
        let address = upstream.local_addr().unwrap();
        let app = Router::new().route("/mcp", any(|request: Request| async move {
            let transport = request.headers().get("mcp-session-id").cloned();
            let protocol = request.headers().get("mcp-protocol-version").cloned();
            assert_eq!(request.headers()[header::ACCEPT], "application/json, text/event-stream");
            assert!(!request.headers().contains_key(header::AUTHORIZATION));
            assert!(!request.headers().contains_key(header::COOKIE));
            assert!(!request.headers().contains_key(CHAT_HEADER));
            assert!(!request.headers().contains_key(USER_HEADER));
            let bytes = to_bytes(request.into_body(), MAX_BODY).await.unwrap();
            let value: Value = serde_json::from_slice(&bytes).unwrap();
            if value["method"] == "initialize" {
                assert!(transport.is_none());
            } else {
                assert_eq!(transport.unwrap(), "returned-session");
                assert_eq!(protocol.unwrap(), "2025-03-26");
            }
            if value["method"] == "tools/call" {
                assert!(value["params"]["_meta"]["openai/session"].as_str().unwrap().starts_with("toris-openwebui-"));
            } else if value["method"] == "tools/list" {
                assert_eq!(value["method"], "tools/list");
                assert!(value["params"]["_meta"].is_null());
            } else {
                assert_eq!(value["method"], "initialize");
            }
            Response::builder()
                .header(header::CONTENT_TYPE, "text/event-stream")
                .header("mcp-session-id", "returned-session")
                .header("mcp-protocol-version", "2025-03-26")
                .body(Body::from("event: message\ndata: {\"jsonrpc\":\"2.0\",\"id\":3,\"result\":{\"tools\":[]}}\n\n"))
                .unwrap()
        }));
        let upstream_task = tokio::spawn(async move {
            axum::serve(upstream, app).await.unwrap();
        });
        let (base, bridge_task, _) = mock_bridge(format!("http://{address}/mcp")).await;
        let client = reqwest::Client::builder().no_proxy().build().unwrap();
        let initialized = client
            .post(format!("{base}/mcp"))
            .headers(headers())
            .header(header::ACCEPT, "application/json, text/event-stream")
            .json(&json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}))
            .send()
            .await
            .unwrap();
        let transport = initialized.headers()["mcp-session-id"]
            .to_str()
            .unwrap()
            .to_string();
        assert!(transport.starts_with("toris-webui-transport-"));
        assert_ne!(transport, "returned-session");
        for value in [
            call(),
            json!({"jsonrpc":"2.0","id":3,"method":"tools/list","params":{}}),
        ] {
            let response = client
                .post(format!("{base}/mcp"))
                .headers(headers())
                .header("mcp-session-id", &transport)
                .header("mcp-protocol-version", "2025-03-26")
                .header(header::ACCEPT, "application/json, text/event-stream")
                .header(header::AUTHORIZATION, "secret-test-only")
                .header(header::COOKIE, "secret-test-only")
                .json(&value)
                .send()
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::OK);
            assert_eq!(response.headers()["mcp-session-id"], transport);
            assert_eq!(response.headers()["mcp-protocol-version"], "2025-03-26");
            assert_eq!(
                response.headers()[header::CONTENT_TYPE],
                "text/event-stream"
            );
            assert!(response
                .text()
                .await
                .unwrap()
                .contains("event: message\ndata:"));
        }
        bridge_task.abort();
        upstream_task.abort();
    }

    #[tokio::test]
    async fn request_limits_paths_methods_and_upstream_errors_are_sanitized() {
        let upstream = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
            .await
            .unwrap();
        let address = upstream.local_addr().unwrap();
        let upstream_task = tokio::spawn(async move {
            let app = Router::new().route(
                "/mcp",
                any(|| async {
                    (
                        StatusCode::UNAUTHORIZED,
                        "private server error, secret-test-only",
                    )
                }),
            );
            axum::serve(upstream, app).await.unwrap();
        });
        let (base, bridge_task, _) = mock_bridge(format!("http://{address}/mcp")).await;
        let client = reqwest::Client::builder().no_proxy().build().unwrap();
        let oversized = client
            .post(format!("{base}/mcp"))
            .headers(headers())
            .body(" ".repeat(MAX_BODY + 1))
            .send()
            .await
            .unwrap();
        assert_eq!(oversized.status(), StatusCode::PAYLOAD_TOO_LARGE);
        let health = client
            .get(format!("{base}/health"))
            .headers(headers())
            .send()
            .await
            .unwrap()
            .json::<Value>()
            .await
            .unwrap();
        assert_eq!(
            health,
            json!({"ok":true,"service":"toris-studio-openwebui-mcp","port":PORT})
        );
        for (path, status) in [
            ("/mcp?target=http://other", StatusCode::BAD_REQUEST),
            ("/other", StatusCode::NOT_FOUND),
        ] {
            assert_eq!(
                client
                    .get(format!("{base}{path}"))
                    .headers(headers())
                    .send()
                    .await
                    .unwrap()
                    .status(),
                status
            );
        }
        assert_eq!(
            client
                .put(format!("{base}/mcp"))
                .headers(headers())
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::METHOD_NOT_ALLOWED
        );
        assert_eq!(
            client
                .get(format!("{base}/mcp"))
                .headers(headers())
                .header(header::ORIGIN, "http://attacker.example")
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::FORBIDDEN
        );
        let response = client
            .post(format!("{base}/mcp"))
            .headers(headers())
            .json(&json!({"jsonrpc":"2.0","id":3,"method":"tools/list"}))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        let body = response.text().await.unwrap();
        assert!(!body.contains("secret-test-only"));
        assert!(body.contains("local_mcp_rejected_request"));
        bridge_task.abort();
        upstream_task.abort();
    }

    #[tokio::test]
    async fn sse_first_chunk_arrives_before_upstream_finishes() {
        use futures_util::StreamExt;
        let release = Arc::new(tokio::sync::Notify::new());
        let upstream_release = release.clone();
        let upstream = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
            .await
            .unwrap();
        let address = upstream.local_addr().unwrap();
        let app = Router::new().route(
            "/mcp",
            any(move || {
                let release = upstream_release.clone();
                async move {
                    let first = futures_util::stream::once(async {
                        Ok::<_, std::io::Error>(axum::body::Bytes::from_static(b"event: message\n"))
                    });
                    let second = futures_util::stream::once(async move {
                        release.notified().await;
                        Ok::<_, std::io::Error>(axum::body::Bytes::from_static(
                            b"data: {\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{}}\n\n",
                        ))
                    });
                    Response::builder()
                        .header(header::CONTENT_TYPE, "text/event-stream")
                        .body(Body::from_stream(first.chain(second)))
                        .unwrap()
                }
            }),
        );
        let upstream_task = tokio::spawn(async move {
            axum::serve(upstream, app).await.unwrap();
        });
        let (base, bridge_task, _) = mock_bridge(format!("http://{address}/mcp")).await;
        let client = reqwest::Client::builder().no_proxy().build().unwrap();
        let response = tokio::time::timeout(
            Duration::from_secs(2),
            client
                .post(format!("{base}/mcp"))
                .headers(headers())
                .json(&json!({"jsonrpc":"2.0","id":1,"method":"tools/list"}))
                .send(),
        )
        .await
        .unwrap()
        .unwrap();
        let mut stream = response.bytes_stream();
        let first = tokio::time::timeout(Duration::from_secs(2), stream.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert_eq!(first.as_ref(), b"event: message\n");
        release.notify_one();
        let second = tokio::time::timeout(Duration::from_secs(2), stream.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert!(second.starts_with(b"data:"));
        assert!(stream.next().await.is_none());
        bridge_task.abort();
        upstream_task.abort();
    }

    #[tokio::test]
    async fn transport_is_fenced_by_chat_user_profile_and_delete_ownership() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        let count = Arc::new(AtomicUsize::new(0));
        let calls = count.clone();
        let upstream = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
            .await
            .unwrap();
        let address = upstream.local_addr().unwrap();
        let app = Router::new().route(
            "/mcp",
            any(move |request: Request| {
                let calls = calls.clone();
                async move {
                    calls.fetch_add(1, Ordering::SeqCst);
                    Response::builder()
                        .header("mcp-session-id", "upstream-private-session")
                        .header(header::CONTENT_TYPE, "application/json")
                        .body(Body::from(if request.method() == Method::DELETE {
                            ""
                        } else {
                            "{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{}}"
                        }))
                        .unwrap()
                }
            }),
        );
        let upstream_task = tokio::spawn(async move {
            axum::serve(upstream, app).await.unwrap();
        });
        let (base, bridge_task, state) = mock_bridge(format!("http://{address}/mcp")).await;
        let client = reqwest::Client::builder().no_proxy().build().unwrap();
        let initialize = client
            .post(format!("{base}/mcp"))
            .headers(headers())
            .json(&json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}))
            .send()
            .await
            .unwrap();
        let id = initialize.headers()["mcp-session-id"]
            .to_str()
            .unwrap()
            .to_string();
        assert_eq!(count.load(Ordering::SeqCst), 1);
        for header in [CHAT_HEADER, USER_HEADER] {
            let mut other = headers();
            other.insert(header, "other-identity".parse().unwrap());
            for method in [Method::GET, Method::DELETE, Method::POST] {
                let mut request = client
                    .request(method.clone(), format!("{base}/mcp"))
                    .headers(other.clone())
                    .header("mcp-session-id", &id);
                if method == Method::POST {
                    request = request.json(&call());
                }
                assert_eq!(
                    request.send().await.unwrap().status(),
                    StatusCode::FORBIDDEN
                );
            }
        }
        assert_eq!(
            count.load(Ordering::SeqCst),
            1,
            "Rejected scopes must never reach the upstream."
        );
        assert_eq!(
            client
                .get(format!("{base}/mcp"))
                .headers(headers())
                .header("mcp-session-id", "unregistered-session")
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::BAD_REQUEST
        );
        assert_eq!(
            client
                .get(format!("{base}/mcp"))
                .headers(headers())
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::BAD_REQUEST
        );
        assert_eq!(
            client
                .get(format!("{base}/mcp"))
                .headers(headers())
                .header("mcp-session-id", &id)
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::OK
        );
        let original = state.profile().unwrap();
        state.profile.as_ref().unwrap().lock().unwrap().project_root = "/projects/changed".into();
        assert_eq!(
            client
                .post(format!("{base}/mcp"))
                .headers(headers())
                .header("mcp-session-id", &id)
                .json(&call())
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::CONFLICT
        );
        *state.profile.as_ref().unwrap().lock().unwrap() = original;
        assert_eq!(
            client
                .delete(format!("{base}/mcp"))
                .headers(headers())
                .header("mcp-session-id", &id)
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::OK
        );
        assert!(!state.sessions.lock().await.contains_key(&id));
        assert_eq!(
            client
                .post(format!("{base}/mcp"))
                .headers(headers())
                .header("mcp-session-id", &id)
                .json(&call())
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::BAD_REQUEST
        );
        assert_eq!(count.load(Ordering::SeqCst), 3);
        bridge_task.abort();
        upstream_task.abort();
    }

    #[tokio::test]
    async fn discovery_binds_first_identified_tool_once_and_sessions_expire_with_a_limit() {
        let upstream = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
            .await
            .unwrap();
        let address = upstream.local_addr().unwrap();
        let app = Router::new().route(
            "/mcp",
            any(|| async {
                Response::builder()
                    .header("mcp-session-id", "upstream-session")
                    .body(Body::from("{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{}}"))
                    .unwrap()
            }),
        );
        let upstream_task = tokio::spawn(async move {
            axum::serve(upstream, app).await.unwrap();
        });
        let (base, bridge_task, state) = mock_bridge(format!("http://{address}/mcp")).await;
        let client = reqwest::Client::builder().no_proxy().build().unwrap();
        let mut discovery = headers();
        discovery.insert(CHAT_HEADER, "{{CHAT_ID}}".parse().unwrap());
        discovery.insert(USER_HEADER, "{{USER_ID}}".parse().unwrap());
        let initialized = client
            .post(format!("{base}/mcp"))
            .headers(discovery.clone())
            .json(&json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}))
            .send()
            .await
            .unwrap();
        let id = initialized.headers()["mcp-session-id"]
            .to_str()
            .unwrap()
            .to_string();
        assert!(state.sessions.lock().await[&id].identity.is_none());
        assert_eq!(
            client
                .post(format!("{base}/mcp"))
                .headers(discovery.clone())
                .header("mcp-session-id", &id)
                .json(&json!({"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}))
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::OK
        );
        assert_eq!(
            client
                .post(format!("{base}/mcp"))
                .headers(discovery.clone())
                .header("mcp-session-id", &id)
                .json(&call())
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::BAD_REQUEST
        );
        assert_eq!(
            client
                .post(format!("{base}/mcp"))
                .headers(headers())
                .header("mcp-session-id", &id)
                .json(&call())
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::OK
        );
        assert_eq!(
            state.sessions.lock().await[&id]
                .identity
                .as_ref()
                .unwrap()
                .chat,
            "chat-123"
        );
        let mut another = headers();
        another.insert(CHAT_HEADER, "another-chat".parse().unwrap());
        assert_eq!(
            client
                .post(format!("{base}/mcp"))
                .headers(another)
                .header("mcp-session-id", &id)
                .json(&call())
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::FORBIDDEN
        );
        let captured = state.profile().unwrap();
        {
            let mut sessions = state.sessions.lock().await;
            sessions.get_mut(&id).unwrap().expires = Instant::now() - Duration::from_secs(1);
            for index in 0..MAX_SESSIONS {
                sessions.insert(
                    format!("filled-{index}"),
                    TransportSession {
                        upstream_id: "upstream".into(),
                        profile: captured.clone(),
                        identity: None,
                        expires: Instant::now() + SESSION_TTL,
                    },
                );
            }
        }
        assert_eq!(
            client
                .post(format!("{base}/mcp"))
                .headers(discovery)
                .json(&json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}))
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::TOO_MANY_REQUESTS
        );
        assert_eq!(state.sessions.lock().await.len(), MAX_SESSIONS);
        assert!(!state.sessions.lock().await.contains_key(&id));
        bridge_task.abort();
        upstream_task.abort();
    }

    #[test]
    fn upstream_is_local_and_cannot_recurse_into_the_adapter() {
        assert!(local_upstream(&profile()));
        for url in [
            "http://127.0.0.1:43181/mcp",
            "http://localhost:43181/mcp",
            "https://remote.example/mcp",
            "http://127.0.0.1:21228/arbitrary",
            "http://127.0.0.1:21228/mcp?target=remote",
            "http://secret@127.0.0.1:21228/mcp",
        ] {
            let mut profile = profile();
            profile.mcp_url = url.into();
            assert!(!local_upstream(&profile));
        }
    }
}
