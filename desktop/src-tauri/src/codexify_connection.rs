//! Per-user Codexify connection and private owner chat transport.
//!
//! The owner token remains native. An accepted message is queued for an existing
//! agent chat; it does not start a ChatGPT turn or prove image generation.
use chrono::Utc;
use fs2::FileExt;
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{fs, io::Read, path::Path, time::Duration};
use url::Url;

const MAX_PROFILE: u64 = 16_384;
const MAX_RESPONSE: usize = 2 * 1024 * 1024;
const OWNER_META: &str = "io.github.devnoname120/codexify/markdown-chat";
const STUDIO_TOOLS: [&str; 10] = [
    "studio_connection_check",
    "studio_asset_presets",
    "studio_asset_list",
    "studio_asset_request",
    "studio_asset_receive",
    "studio_publication_draft_receive",
    "studio_asset_resize",
    "studio_asset_create_3d",
    "studio_asset_review",
    "studio_asset_job_status",
];

#[derive(Clone, Deserialize, Serialize, PartialEq, Eq, Debug)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Profile {
    pub mcp_url: String,
    pub plugin_url: String,
    pub conversation_url: String,
    pub project_root: String,
    pub conversation_id: String,
}
impl Default for Profile {
    fn default() -> Self {
        Self {
            mcp_url: "http://127.0.0.1:21228/mcp".into(),
            plugin_url: String::new(),
            conversation_url: String::new(),
            project_root: String::new(),
            conversation_id: String::new(),
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SendInput {
    pub request_id: String,
    pub message: String,
    pub expected_profile: Profile,
}

fn valid_id(id: &str, max: usize) -> bool {
    !id.is_empty()
        && id.len() <= max
        && id
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'_' | b'-'))
}

fn mcp_url(raw: &str) -> Result<Url, String> {
    if raw.len() > 2048 {
        return Err("로컬 MCP 주소가 너무 깁니다.".into());
    }
    let mut url = Url::parse(raw).map_err(|_| "로컬 MCP 주소를 확인하세요.")?;
    if !matches!(url.scheme(), "http" | "https")
        || !matches!(
            url.host_str(),
            Some("localhost" | "127.0.0.1" | "[::1]" | "::1")
        )
        || !url.username().is_empty()
        || url.password().is_some()
        || url.path() != "/mcp"
        || url.query().is_some()
        || url.fragment().is_some()
        || url.port_or_known_default() == Some(0)
    {
        return Err("MCP 주소는 로그인 정보가 없는 로컬 /mcp 주소여야 합니다.".into());
    }
    // Avoid resolving localhost through configurable DNS/proxy services.
    if url.host_str() == Some("localhost") {
        url.set_host(Some("127.0.0.1"))
            .map_err(|_| "로컬 MCP 주소를 확인하세요.")?;
    }
    Ok(url)
}

fn chatgpt_url(raw: &str, route: &str) -> Result<String, String> {
    if raw.is_empty() {
        return Ok(String::new());
    }
    if raw.len() > 512 {
        return Err("ChatGPT 주소가 너무 깁니다.".into());
    }
    let url = Url::parse(raw).map_err(|_| "ChatGPT 주소를 확인하세요.")?;
    let segments: Vec<_> = url
        .path_segments()
        .ok_or("ChatGPT 주소를 확인하세요.")?
        .collect();
    if url.scheme() != "https"
        || url.host_str() != Some("chatgpt.com")
        || url.port().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || segments.len() != 2
        || segments[0] != route
        || !valid_id(segments[1], 128)
    {
        return Err("ChatGPT의 플러그인 또는 대화 주소를 입력하세요.".into());
    }
    Ok(url.to_string())
}

fn validate_project(raw: &str) -> Result<(), String> {
    if raw.is_empty() {
        return Ok(());
    }
    let drive_path = raw.strip_prefix("\\\\?\\").unwrap_or(raw);
    let windows = drive_path.as_bytes().get(1) == Some(&b':')
        && drive_path
            .as_bytes()
            .first()
            .is_some_and(u8::is_ascii_alphabetic)
        && matches!(drive_path.as_bytes().get(2), Some(b'/' | b'\\'));
    if raw.len() > 4096
        || raw.chars().any(char::is_control)
        || !(raw.starts_with('/') || windows)
        || raw
            .split(['/', '\\'])
            .any(|part| matches!(part, "." | ".."))
        || !drive_path
            .split(['/', '\\'])
            .enumerate()
            .any(|(i, part)| !part.is_empty() && !(windows && i == 0))
    {
        return Err(
            "프로젝트 폴더의 전체 경로를 입력하세요. 루트 폴더는 사용할 수 없습니다.".into(),
        );
    }
    Ok(())
}

fn validate(mut profile: Profile) -> Result<Profile, String> {
    profile.mcp_url = mcp_url(profile.mcp_url.trim())?.to_string();
    profile.plugin_url = chatgpt_url(profile.plugin_url.trim(), "plugins")?;
    profile.conversation_url = chatgpt_url(profile.conversation_url.trim(), "c")?;
    profile.project_root = profile.project_root.trim().to_string();
    profile.conversation_id = profile.conversation_id.trim().to_string();
    validate_project(&profile.project_root)?;
    if !profile.conversation_id.is_empty() && !valid_id(&profile.conversation_id, 128) {
        return Err("저장할 대화 ID를 확인하세요.".into());
    }
    Ok(profile)
}

fn profile_path() -> Result<std::path::PathBuf, String> {
    crate::config::config_path()
        .parent()
        .map(|path| path.join("codexify-connection.json"))
        .ok_or_else(|| "사용자 설정 폴더를 찾을 수 없습니다.".into())
}

fn load_at(path: &Path) -> Result<Profile, String> {
    match fs::symlink_metadata(path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Profile::default()),
        Ok(metadata) if metadata.is_file() && metadata.len() <= MAX_PROFILE => {
            let file = fs::File::open(path).map_err(|_| "Codexify 연결 설정을 읽지 못했습니다.")?;
            let mut bytes = Vec::new();
            file.take(MAX_PROFILE + 1)
                .read_to_end(&mut bytes)
                .map_err(|_| "Codexify 연결 설정을 읽지 못했습니다.")?;
            if bytes.len() as u64 > MAX_PROFILE {
                return Err("Codexify 연결 설정의 크기가 잘못되었습니다.".into());
            }
            let profile = serde_json::from_slice(&bytes)
                .map_err(|_| "Codexify 연결 설정의 형식이 잘못되었습니다.")?;
            validate(profile)
        }
        _ => Err("Codexify 연결 설정 파일을 확인하세요.".into()),
    }
}

pub fn load() -> Result<Profile, String> {
    load_at(&profile_path()?)
}

fn save_at(path: &Path, input: Profile) -> Result<Profile, String> {
    let profile = validate(input)?;
    let parent = path.parent().ok_or("연결 설정 폴더를 확인하세요.")?;
    fs::create_dir_all(parent).map_err(|_| "연결 설정 폴더를 만들지 못했습니다.")?;
    let lock = fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(parent.join("codexify-connection.lock"))
        .map_err(|_| "연결 설정 저장 잠금을 만들지 못했습니다.")?;
    lock.lock_exclusive()
        .map_err(|_| "연결 설정 저장 잠금 실패")?;
    if let Ok(metadata) = fs::symlink_metadata(path) {
        if !metadata.is_file() {
            return Err("연결 설정 파일을 확인하세요.".into());
        }
    }
    let mut temporary = tempfile::NamedTempFile::new_in(parent)
        .map_err(|_| "연결 설정 저장 파일을 만들지 못했습니다.")?;
    serde_json::to_writer(&mut temporary, &profile)
        .map_err(|_| "연결 설정을 저장하지 못했습니다.")?;
    temporary
        .as_file()
        .sync_all()
        .map_err(|_| "연결 설정 저장 실패")?;
    temporary.persist(path).map_err(|_| "연결 설정 저장 실패")?;
    Ok(profile)
}

pub fn save(input: Profile) -> Result<Profile, String> {
    save_at(&profile_path()?, input)
}

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(3))
        .timeout(Duration::from_secs(12))
        .build()
        .map_err(|_| "로컬 연결을 준비하지 못했습니다.".into())
}

async fn response_bytes(response: reqwest::Response) -> Result<Vec<u8>, String> {
    if response
        .content_length()
        .is_some_and(|size| size > MAX_RESPONSE as u64)
    {
        return Err("로컬 서버의 응답이 너무 큽니다.".into());
    }
    let mut bytes = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| "로컬 서버의 응답을 읽지 못했습니다.")?;
        if bytes.len().saturating_add(chunk.len()) > MAX_RESPONSE {
            return Err("로컬 서버의 응답이 너무 큽니다.".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

fn find_rpc_result(bytes: &[u8], id: u64) -> Result<Option<Value>, String> {
    let decode = |value: Value| -> Result<Option<Value>, String> {
        if value.get("id") != Some(&json!(id)) {
            return Ok(None);
        }
        if value.get("error").is_some() {
            return Err("MCP 서버가 요청을 처리하지 못했습니다.".into());
        }
        value
            .get("result")
            .cloned()
            .map(Some)
            .ok_or_else(|| "MCP 응답 형식을 확인하세요.".into())
    };
    if let Ok(value) = serde_json::from_slice::<Value>(bytes) {
        if let Some(result) = decode(value)? {
            return Ok(Some(result));
        }
    } else {
        let Ok(text) = std::str::from_utf8(bytes) else {
            return Ok(None);
        };
        let mut data = String::new();
        for line in text.split('\n') {
            let line = line.trim_end_matches('\r');
            if line.is_empty() {
                if !data.is_empty() {
                    if let Ok(value) = serde_json::from_str::<Value>(&data) {
                        if let Some(result) = decode(value)? {
                            return Ok(Some(result));
                        }
                    }
                    data.clear();
                }
            } else if let Some(part) = line.strip_prefix("data:") {
                if !data.is_empty() {
                    data.push('\n');
                }
                data.push_str(part.strip_prefix(' ').unwrap_or(part));
            }
        }
    }
    Ok(None)
}

async fn rpc(
    client: &reqwest::Client,
    url: &Url,
    payload: Value,
    session: &mut Option<String>,
    protocol: Option<&str>,
) -> Result<Option<Value>, String> {
    let id = payload.get("id").and_then(Value::as_u64);
    let mut request = client
        .post(url.clone())
        .header("Accept", "application/json, text/event-stream")
        .json(&payload);
    if let Some(value) = session.as_deref() {
        request = request.header("Mcp-Session-Id", value);
    }
    if let Some(value) = protocol {
        request = request.header("MCP-Protocol-Version", value);
    }
    let response = request
        .send()
        .await
        .map_err(|_| "로컬 MCP 서버에 연결하지 못했습니다.")?;
    if !response.status().is_success() {
        return Err("로컬 MCP 서버의 주소와 실행 상태를 확인하세요.".into());
    }
    if let Some(value) = response.headers().get("Mcp-Session-Id") {
        let value = value.to_str().map_err(|_| "MCP 세션 형식 오류")?;
        if value.is_empty() || value.len() > 256 || value.chars().any(char::is_control) {
            return Err("MCP 세션 형식 오류".into());
        }
        *session = Some(value.into());
    }
    match id {
        Some(id) => {
            if response
                .content_length()
                .is_some_and(|size| size > MAX_RESPONSE as u64)
            {
                return Err("로컬 서버의 응답이 너무 큽니다.".into());
            }
            let mut bytes = Vec::new();
            let mut stream = response.bytes_stream();
            while let Some(chunk) = stream.next().await {
                let chunk = chunk.map_err(|_| "로컬 서버의 응답을 읽지 못했습니다.")?;
                if bytes.len().saturating_add(chunk.len()) > MAX_RESPONSE {
                    return Err("로컬 서버의 응답이 너무 큽니다.".into());
                }
                bytes.extend_from_slice(&chunk);
                if let Some(result) = find_rpc_result(&bytes, id)? {
                    return Ok(Some(result));
                }
            }
            Err("요청에 해당하는 MCP 응답을 받지 못했습니다.".into())
        }
        None => {
            // Notifications need only an HTTP acknowledgement; an SSE response
            // may stay open indefinitely, so do not wait for its body.
            Ok(None)
        }
    }
}

fn studio_name(name: &str) -> Option<&str> {
    STUDIO_TOOLS.iter().copied().find(|candidate| {
        name == *candidate
            || name
                .strip_suffix(*candidate)
                .is_some_and(|prefix| prefix.ends_with("__") || prefix.ends_with('.'))
    })
}

fn receiver_ready(tool: &Value) -> bool {
    let schema = &tool["inputSchema"];
    let required = |value: &Value, field: &str| {
        value
            .as_array()
            .is_some_and(|array| array.iter().any(|item| item == field))
    };
    schema["type"] == "object"
        && required(&schema["required"], "file")
        && required(&schema["required"], "jobId")
        && schema["properties"]["file"]["type"] == "object"
        && schema["properties"]["file"]["properties"]["download_url"]["type"] == "string"
        && schema["properties"]["file"]["properties"]["file_id"]["type"] == "string"
        && required(&schema["properties"]["file"]["required"], "download_url")
        && required(&schema["properties"]["file"]["required"], "file_id")
        && required(&tool["_meta"]["openai/fileParams"], "file")
}

async fn mcp_probe(profile: &Profile) -> Result<Value, String> {
    let client = client()?;
    let url = mcp_url(&profile.mcp_url)?;
    let mut session = None;
    let initialized = rpc(&client, &url, json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"toris-studio-desktop","version":env!("CARGO_PKG_VERSION")}}}), &mut session, None)
        .await?.ok_or("MCP 초기화 응답을 확인하세요.")?;
    let protocol = initialized["protocolVersion"]
        .as_str()
        .filter(|value| {
            !value.is_empty() && value.len() <= 32 && !value.chars().any(char::is_control)
        })
        .ok_or("MCP 프로토콜 버전을 확인하세요.")?;
    rpc(
        &client,
        &url,
        json!({"jsonrpc":"2.0","method":"notifications/initialized"}),
        &mut session,
        Some(protocol),
    )
    .await?;
    let mut tools = Vec::new();
    let mut cursor: Option<String> = None;
    let mut cursors = std::collections::HashSet::new();
    for page in 0..16_u64 {
        let params = cursor
            .as_ref()
            .map(|value| json!({"cursor":value}))
            .unwrap_or_else(|| json!({}));
        let response = rpc(
            &client,
            &url,
            json!({"jsonrpc":"2.0","id":page+2,"method":"tools/list","params":params}),
            &mut session,
            Some(protocol),
        )
        .await?
        .ok_or("MCP 도구 목록을 확인하세요.")?;
        let items = response["tools"]
            .as_array()
            .ok_or("MCP 도구 목록 형식을 확인하세요.")?;
        if tools.len() + items.len() > 512 {
            return Err("MCP 도구 목록이 너무 큽니다.".into());
        }
        tools.extend(items.iter().cloned());
        match response.get("nextCursor") {
            None | Some(Value::Null) => break,
            Some(Value::String(next)) if !next.is_empty() && next.len() <= 1024 => {
                if page == 15 || !cursors.insert(next.clone()) {
                    return Err("MCP 도구 목록의 페이지 정보가 잘못되었습니다.".into());
                }
                cursor = Some(next.clone());
            }
            _ => return Err("MCP 도구 목록의 페이지 정보가 잘못되었습니다.".into()),
        }
    }
    let mut found = std::collections::HashSet::new();
    let mut studio_tools = Vec::new();
    let mut file_receiver_ready = false;
    for tool in &tools {
        if let Some(name) = tool["name"].as_str() {
            if name.len() > 256 {
                continue;
            }
            if let Some(canonical) = studio_name(name) {
                found.insert(canonical);
                studio_tools.push(name.to_string());
                if canonical == "studio_asset_receive" && receiver_ready(tool) {
                    file_receiver_ready = true;
                }
            }
        }
    }
    let missing: Vec<_> = STUDIO_TOOLS
        .iter()
        .filter(|name| !found.contains(**name))
        .collect();
    let server_name = initialized["serverInfo"]["name"]
        .as_str()
        .filter(|value| value.len() <= 256);
    Ok(
        json!({"reachable":true,"serverName":server_name,"protocolVersion":protocol,"toolCount":tools.len(),"studioTools":studio_tools,"missingStudioTools":missing,"fileReceiverReady":file_receiver_ready}),
    )
}

// Deliberately no Serialize or Debug: this credential must never cross IPC/logging.
struct Owner {
    port: u16,
    token: String,
}

fn owner_at(path: &Path, expected_owner: &Path) -> Result<Owner, String> {
    let original =
        fs::symlink_metadata(path).map_err(|_| "Codexify 소유자 채팅을 켜고 다시 연결하세요.")?;
    if !original.is_file() || original.len() > 4096 {
        return Err("Codexify 소유자 채팅 인증 파일을 확인하세요.".into());
    }
    let file =
        fs::File::open(path).map_err(|_| "Codexify 소유자 채팅 인증 파일을 읽지 못했습니다.")?;
    let metadata = file
        .metadata()
        .map_err(|_| "Codexify 소유자 채팅 인증 파일을 확인하세요.")?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let uid = fs::metadata(expected_owner)
            .map_err(|_| "사용자 폴더를 확인하세요.")?
            .uid();
        if metadata.uid() != uid
            || metadata.mode() & 0o077 != 0
            || original.ino() != metadata.ino()
            || original.dev() != metadata.dev()
        {
            return Err("Codexify 소유자 채팅 인증 파일의 접근 권한을 확인하세요.".into());
        }
    }
    #[cfg(not(unix))]
    let _ = expected_owner;
    if !metadata.is_file() || metadata.len() > 4096 {
        return Err("Codexify 소유자 채팅 인증 파일을 확인하세요.".into());
    }
    let mut bytes = Vec::new();
    file.take(4097)
        .read_to_end(&mut bytes)
        .map_err(|_| "Codexify 소유자 채팅 인증 파일을 읽지 못했습니다.")?;
    if bytes.len() > 4096 {
        return Err("Codexify 소유자 채팅 인증 파일을 확인하세요.".into());
    }
    let value: Value = serde_json::from_slice(&bytes)
        .map_err(|_| "Codexify 소유자 채팅 인증 파일의 형식을 확인하세요.")?;
    let port = value["port"]
        .as_u64()
        .filter(|port| *port > 0 && *port <= u16::MAX as u64)
        .ok_or("Codexify 소유자 채팅 포트를 확인하세요.")? as u16;
    let token = value["token"]
        .as_str()
        .filter(|value| {
            !value.is_empty()
                && value.len() <= 512
                && value.bytes().all(|byte| byte.is_ascii_graphic())
        })
        .ok_or("Codexify 소유자 채팅 인증을 확인하세요.")?
        .to_string();
    Ok(Owner { port, token })
}

fn owner() -> Result<Owner, String> {
    let home = dirs::home_dir().ok_or("사용자 폴더를 찾을 수 없습니다.")?;
    owner_at(&home.join(".codexify/owner-chat.json"), &home)
}

async fn owner_request(
    owner: &Owner,
    method: reqwest::Method,
    path: &str,
    body: Option<Value>,
) -> Result<Value, String> {
    let url = format!("http://127.0.0.1:{}{}", owner.port, path);
    let mut request = client()?
        .request(method, url)
        .header("Host", format!("127.0.0.1:{}", owner.port))
        .bearer_auth(&owner.token);
    if let Some(body) = body {
        request = request.json(&body);
    }
    let response = request
        .send()
        .await
        .map_err(|_| "Codexify 소유자 채팅 서버에 연결하지 못했습니다.")?;
    if !response.status().is_success() {
        return Err(match response.status().as_u16() {
            401 | 403 => "Codexify 소유자 채팅 인증을 다시 확인하세요.",
            404 => "선택한 대화가 현재 Codexify에 없습니다. 대화 목록을 새로 불러오세요.",
            409 => "같은 요청 ID로 다른 메시지를 보낼 수 없습니다. 원래 요청을 다시 확인하세요.",
            _ => "Codexify 소유자 채팅 요청을 처리하지 못했습니다.",
        }
        .into());
    }
    serde_json::from_slice(&response_bytes(response).await?)
        .map_err(|_| "Codexify 소유자 채팅 응답 형식을 확인하세요.".into())
}

fn selected_chat(profile: &Profile, list: &Value) -> Result<(), String> {
    if profile.conversation_id.is_empty() || profile.project_root.is_empty() {
        return Err("프로젝트 폴더와 연결할 대화를 먼저 저장하세요.".into());
    }
    validate_project(&profile.project_root)?;
    if !valid_id(&profile.conversation_id, 128) {
        return Err("선택한 대화 ID를 확인하세요.".into());
    }
    list["chats"]
        .as_array()
        .ok_or("Codexify 대화 목록 형식을 확인하세요.")?
        .iter()
        .find(|chat| chat["id"].as_str() == Some(profile.conversation_id.as_str()))
        .ok_or("선택한 대화가 현재 Codexify에 없습니다. 대화 목록을 새로 불러오세요.")?;
    Ok(())
}

fn read_json_file(path: &Path, limit: u64) -> Result<Value, String> {
    let metadata =
        fs::symlink_metadata(path).map_err(|_| "대화의 프로젝트 연결 기록을 확인하세요.")?;
    if !metadata.is_file() || metadata.len() > limit {
        return Err("대화의 프로젝트 연결 기록을 확인하세요.".into());
    }
    let file = fs::File::open(path).map_err(|_| "대화의 프로젝트 연결 기록을 읽지 못했습니다.")?;
    let mut bytes = Vec::new();
    file.take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "대화의 프로젝트 연결 기록을 읽지 못했습니다.")?;
    if bytes.len() as u64 > limit {
        return Err("대화의 프로젝트 연결 기록이 너무 큽니다.".into());
    }
    serde_json::from_slice(&bytes).map_err(|_| "대화의 프로젝트 연결 기록을 확인하세요.".into())
}

fn binding_matches(binding: &Value, project: &Path) -> bool {
    if binding["version"] != 2 {
        return false;
    }
    let Some(root) = binding["projectRoot"]
        .as_str()
        .and_then(|root| fs::canonicalize(root).ok())
    else {
        return false;
    };
    let Some(access) = binding["accessRoot"]
        .as_str()
        .and_then(|root| fs::canonicalize(root).ok())
    else {
        return false;
    };
    root == project && project.starts_with(access)
}

fn lexical_normalize(path: &Path) -> std::path::PathBuf {
    use std::path::Component;
    let mut result = std::path::PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                if matches!(result.components().next_back(), Some(Component::Normal(_))) {
                    result.pop();
                }
            }
            _ => result.push(component.as_os_str()),
        }
    }
    result
}

fn project_metadata_key(project: &Path) -> String {
    let normalized = lexical_normalize(project);
    let basename = normalized
        .file_name()
        .map(|part| part.to_string_lossy())
        .unwrap_or_default();
    let mut slug: String = basename
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-') {
                c
            } else {
                '-'
            }
        })
        .collect();
    if slug.is_empty() {
        slug = "project".into();
    }
    let digest = format!(
        "{:x}",
        Sha256::digest(normalized.to_string_lossy().as_bytes())
    );
    format!("{slug}-{}", &digest[..12])
}

fn has_no_symlinks(path: &Path) -> bool {
    path.ancestors().all(|part| {
        fs::symlink_metadata(part).is_ok_and(|metadata| !metadata.file_type().is_symlink())
    })
}

fn verify_chat_project_at(profile: &Profile, state: &Value, bindings: &Path) -> Result<(), String> {
    let raw = state["chat_file"]
        .as_str()
        .ok_or("대화의 프로젝트 연결을 확인하세요.")?;
    validate_project(raw)?;
    let chat_file = Path::new(raw);
    let digest = format!("{:x}", Sha256::digest(raw.as_bytes()));
    if digest != profile.conversation_id
        || chat_file.file_name().and_then(|part| part.to_str()) != Some("CHAT.md")
    {
        return Err("대화의 프로젝트 연결을 확인하세요.".into());
    }
    let chat_dir = chat_file
        .parent()
        .ok_or("대화의 프로젝트 연결을 확인하세요.")?;
    let owner = chat_dir
        .file_name()
        .and_then(|part| part.to_str())
        .ok_or("대화의 프로젝트 연결을 확인하세요.")?;
    if owner.len() != 64
        || !owner
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
        || chat_dir
            .parent()
            .and_then(Path::file_name)
            .and_then(|part| part.to_str())
            != Some("chats")
    {
        return Err("대화의 프로젝트 연결을 확인하세요.".into());
    }
    let project = fs::canonicalize(&profile.project_root)
        .map_err(|_| "저장한 프로젝트 폴더를 찾을 수 없습니다.")?;
    let memory = bindings
        .parent()
        .ok_or("프로젝트 연결 기록을 확인하세요.")?
        .join("projects");
    let expected_chat = |root: &Path| {
        memory
            .join(project_metadata_key(root))
            .join("chats")
            .join(owner)
            .join("CHAT.md")
    };
    if !(chat_file == expected_chat(Path::new(&profile.project_root))
        || chat_file == expected_chat(&project))
        || !has_no_symlinks(chat_file)
    {
        return Err(
            "Codexify 기본 메모리 폴더에 저장된 이 프로젝트의 대화만 연결할 수 있습니다.".into(),
        );
    }
    // Single-project Codexify has no conversation-project binding files. The
    // exact private metadata path, project namespace and opaque ID identify the
    // full selected project independently of the ambiguous workspace basename.
    if fs::symlink_metadata(bindings)
        .is_err_and(|error| error.kind() == std::io::ErrorKind::NotFound)
    {
        return Ok(());
    }
    if !has_no_symlinks(bindings) {
        return Err("프로젝트 연결 기록의 폴더를 확인하세요.".into());
    }
    let entries =
        fs::read_dir(bindings).map_err(|_| "ChatGPT에서 프로젝트 연결을 먼저 완료하세요.")?;
    let mut matches = 0;
    let mut has_binding = false;
    for (count, entry) in entries.enumerate() {
        if count >= 256 {
            return Err("프로젝트 연결 기록이 너무 많습니다. Codexify 설정을 확인하세요.".into());
        }
        let entry = entry.map_err(|_| "프로젝트 연결 기록을 읽지 못했습니다.")?;
        let directory = entry
            .file_type()
            .map_err(|_| "프로젝트 연결 기록을 확인하세요.")?;
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            continue;
        };
        if !directory.is_dir()
            || name.len() != 24
            || !name
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
        {
            continue;
        }
        let path = entry.path().join(format!("{owner}.json"));
        if fs::symlink_metadata(&path).is_ok() {
            has_binding = true;
        }
        if let Ok(binding) = read_json_file(&path, 65_536) {
            let Some(access) = binding["accessRoot"]
                .as_str()
                .and_then(|root| fs::canonicalize(root).ok())
            else {
                continue;
            };
            let mut hasher = Sha256::new();
            hasher.update(b"codexify/access-root/v1\0");
            hasher.update(access.to_string_lossy().as_bytes());
            let expected = format!("{:x}", hasher.finalize());
            if expected[..24] == *name && binding_matches(&binding, &project) {
                let raw_project = binding["projectRoot"]
                    .as_str()
                    .ok_or("프로젝트 연결 기록을 확인하세요.")?;
                let memory = bindings
                    .parent()
                    .ok_or("프로젝트 연결 기록을 확인하세요.")?
                    .join("projects");
                let expected_chat = memory
                    .join(project_metadata_key(Path::new(raw_project)))
                    .join("chats")
                    .join(owner)
                    .join("CHAT.md");
                if chat_file == expected_chat && has_no_symlinks(chat_file) {
                    matches += 1;
                }
            }
        }
    }
    if matches != 1 && has_binding {
        return Err("선택한 대화의 전체 프로젝트 경로가 확인되지 않았습니다. ChatGPT에서 이 프로젝트를 다시 연결하세요.".into());
    }
    Ok(())
}

fn verify_chat_project(profile: &Profile, state: &Value) -> Result<(), String> {
    let home = dirs::home_dir().ok_or("사용자 폴더를 찾을 수 없습니다.")?;
    verify_chat_project_at(
        profile,
        state,
        &home.join(".codexify/conversation-projects"),
    )
}

fn unwrap_owner(value: Value) -> Result<Value, String> {
    value["_meta"][OWNER_META]
        .as_object()
        .map(|object| Value::Object(object.clone()))
        .ok_or_else(|| "Codexify 대화 응답 형식을 확인하세요.".into())
}

pub async fn chats() -> Result<Value, String> {
    let profile = load()?;
    let owner = owner()?;
    let mut result = owner_request(&owner, reqwest::Method::GET, "/api/chats", None).await?;
    if !result["chats"].is_array() || !result["serverTimeMs"].is_u64() {
        return Err("Codexify 대화 목록 형식을 확인하세요.".into());
    }
    if result["chats"].as_array().is_some_and(|chats| {
        chats.iter().any(|chat| {
            !chat.is_object() || !chat["id"].is_string() || !chat["workspace"].is_string()
        })
    }) {
        return Err("Codexify 대화 목록 형식을 확인하세요.".into());
    }
    enrich_project_matches(&profile, &mut result);
    require_unchanged_profile(&load()?, &profile)?;
    Ok(result)
}

fn enrich_project_matches(profile: &Profile, result: &mut Value) {
    let namespace = (!profile.project_root.is_empty())
        .then(|| project_metadata_key(Path::new(&profile.project_root)));
    let canonical_namespace = (!profile.project_root.is_empty())
        .then(|| {
            fs::canonicalize(&profile.project_root)
                .ok()
                .map(|root| project_metadata_key(&root))
        })
        .flatten();
    if let Some(chats) = result["chats"].as_array_mut() {
        for chat in chats {
            let matches = chat["workspace"].as_str().is_some_and(|workspace| {
                namespace.as_deref() == Some(workspace)
                    || canonical_namespace.as_deref() == Some(workspace)
            });
            chat["projectMatches"] = json!(matches);
        }
    }
}

pub async fn chat_read() -> Result<Value, String> {
    let profile = load()?;
    let owner = owner()?;
    let list = owner_request(&owner, reqwest::Method::GET, "/api/chats", None).await?;
    selected_chat(&profile, &list)?;
    let state = unwrap_owner(
        owner_request(
            &owner,
            reqwest::Method::GET,
            &format!("/api/chats/{}", profile.conversation_id),
            None,
        )
        .await?,
    )?;
    verify_chat_project(&profile, &state)?;
    require_unchanged_profile(&load()?, &profile)?;
    Ok(state)
}

pub async fn chat_send(input: SendInput) -> Result<Value, String> {
    if !valid_id(&input.request_id, 80) {
        return Err("메시지 요청 ID를 확인하세요.".into());
    }
    if input.message.trim().is_empty() || input.message.len() > 1024 * 1024 {
        return Err("메시지는 비어 있지 않은 1 MiB 이하의 내용이어야 합니다.".into());
    }
    let profile = load()?;
    let expected_profile = validate(input.expected_profile)?;
    require_unchanged_profile(&profile, &expected_profile)?;
    let owner = owner()?;
    let list = owner_request(&owner, reqwest::Method::GET, "/api/chats", None).await?;
    selected_chat(&profile, &list)?;
    let state = unwrap_owner(
        owner_request(
            &owner,
            reqwest::Method::GET,
            &format!("/api/chats/{}", profile.conversation_id),
            None,
        )
        .await?,
    )?;
    verify_chat_project(&profile, &state)?;
    require_unchanged_profile(&load()?, &profile)?;
    let value = unwrap_owner(
        owner_request(
            &owner,
            reqwest::Method::POST,
            &format!("/api/chats/{}/send", profile.conversation_id),
            Some(json!({"request_id":input.request_id,"message":input.message})),
        )
        .await?,
    )?;
    if !value["sent"]["id"].is_string() || !value["sent"]["end"].is_u64() {
        return Err(
            "메시지 저장 응답을 확인하세요. 같은 요청 ID로 다시 확인할 수 있습니다.".into(),
        );
    }
    Ok(value)
}

fn require_unchanged_profile(current: &Profile, expected: &Profile) -> Result<(), String> {
    if current != expected {
        return Err(
            "메시지를 준비한 이후 연결 설정이 바뀌었습니다. 대상을 확인하고 다시 전송하세요."
                .into(),
        );
    }
    Ok(())
}

pub async fn check() -> Result<Value, String> {
    let profile = load()?;
    let (mcp, owner) = tokio::join!(mcp_probe(&profile), chats());
    require_unchanged_profile(&load()?, &profile)?;
    let mut result = match mcp {
        Ok(value) => value,
        Err(message) => {
            json!({"reachable":false,"serverName":null,"protocolVersion":null,"toolCount":0,"studioTools":[],"missingStudioTools":STUDIO_TOOLS,"fileReceiverReady":false,"message":message})
        }
    };
    result["ownerReady"] = json!(owner.is_ok());
    result["checkedAt"] = json!(Utc::now().to_rfc3339());
    if result.get("message").is_none() {
        result["message"] = json!(if result["fileReceiverReady"] == true {
            if owner.is_ok() {
                "Studio 파일 수신 도구와 앱 채팅이 연결됐습니다. 메시지 전송은 대화에 저장되며, ChatGPT의 활성 요청이 있어야 처리됩니다."
            } else {
                "Studio 파일 수신 도구가 연결됐습니다. Codexify 소유자 채팅을 켜면 앱에서 메시지를 보낼 수 있습니다."
            }
        } else {
            "Codexify에 연결됐지만 Studio 파일 수신 도구가 없습니다. Studio MCP 설정을 연결하세요."
        });
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{io::Write, net::TcpListener};

    #[test]
    fn connection_addresses_are_local_and_chatgpt_routes_are_exact() {
        assert_eq!(
            mcp_url("http://localhost:21228/mcp").unwrap().host_str(),
            Some("127.0.0.1")
        );
        assert!(mcp_url("http://[::1]:21228/mcp").is_ok());
        for raw in [
            "https://example.com/mcp",
            "http://127.0.0.1.evil.test/mcp",
            "http://user:secret@127.0.0.1/mcp",
            "http://127.0.0.1/mcp?token=value",
            "http://127.0.0.1/mcp#fragment",
            "http://127.0.0.1/admin",
            "file:///mcp",
            "http://127.0.0.1:0/mcp",
        ] {
            assert!(mcp_url(raw).is_err(), "accepted {raw}");
        }
        assert!(chatgpt_url("https://chatgpt.com/plugins/plugin_test", "plugins").is_ok());
        assert!(chatgpt_url("https://chatgpt.com/c/conversation-1", "c").is_ok());
        for raw in [
            "https://chatgpt.com.evil.test/c/one",
            "https://chatgpt.com/c/one?token=x",
            "https://user@chatgpt.com/c/one",
            "https://chatgpt.com/c/one/extra",
            "https://chatgpt.com/plugins/x",
        ] {
            assert!(chatgpt_url(raw, "c").is_err(), "accepted {raw}");
        }
    }

    #[test]
    fn project_root_requires_non_root_absolute_path() {
        for raw in [
            "/",
            "C:\\",
            "C:/",
            "relative/project",
            "/project/../other",
            "C:\\project\\..\\other",
            "/project\nsecret",
        ] {
            assert!(validate_project(raw).is_err(), "accepted {raw}");
        }
        for raw in ["", "/home/person/project", "C:\\Users\\person\\project"] {
            assert!(validate_project(raw).is_ok());
        }
    }

    #[test]
    fn profile_persists_outside_appconfig_and_invalid_save_preserves_previous() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("profile.json");
        let profile = Profile {
            plugin_url: "https://chatgpt.com/plugins/plugin_test".into(),
            project_root: "/project/studio".into(),
            ..Profile::default()
        };
        assert_eq!(load_at(&path).unwrap(), Profile::default());
        assert_eq!(save_at(&path, profile.clone()).unwrap(), profile);
        assert_eq!(load_at(&path).unwrap(), profile);
        let bad = Profile {
            mcp_url: "https://external.test/mcp".into(),
            ..profile.clone()
        };
        assert!(save_at(&path, bad).is_err());
        assert_eq!(load_at(&path).unwrap(), profile);
        let bytes = fs::read_to_string(path).unwrap();
        assert!(!bytes.contains("token"));
        assert!(!bytes.contains("apiKey"));
    }

    #[cfg(unix)]
    #[test]
    fn profile_rejects_symlink_destination() {
        use std::os::unix::fs::symlink;
        let directory = tempfile::tempdir().unwrap();
        let target = directory.path().join("target.json");
        fs::write(&target, b"preserve").unwrap();
        let path = directory.path().join("profile.json");
        symlink(&target, &path).unwrap();
        assert!(load_at(&path).is_err());
        assert!(save_at(&path, Profile::default()).is_err());
        assert_eq!(fs::read(&target).unwrap(), b"preserve");
    }

    #[test]
    fn receiver_readiness_needs_real_file_reference_schema_and_metadata() {
        let mut receive = crate::mcp_bridge::tools()
            .into_iter()
            .find(|tool| tool["name"] == "studio_asset_receive")
            .unwrap();
        assert!(receiver_ready(&receive));
        receive["name"] = json!("studio__studio_asset_receive");
        assert_eq!(
            studio_name(receive["name"].as_str().unwrap()),
            Some("studio_asset_receive")
        );
        assert_eq!(studio_name("evil_studio_asset_receive"), None);
        receive["_meta"] = json!({});
        assert!(!receiver_ready(&receive));
        receive["_meta"] = json!({"openai/fileParams":["file"]});
        receive["inputSchema"]["properties"]["file"]["required"] = json!(["download_url"]);
        assert!(!receiver_ready(&receive));
    }

    #[test]
    fn sse_parser_matches_response_id_and_ignores_notifications() {
        let bytes = b"event: message\r\ndata: {\"jsonrpc\":\"2.0\",\"method\":\"notice\"}\r\n\r\nevent: message\r\ndata: {\"jsonrpc\":\"2.0\",\"id\":2,\"result\":\r\ndata: {\"tools\":[]}}\r\n\r\n";
        assert_eq!(
            find_rpc_result(bytes, 2).unwrap(),
            Some(json!({"tools":[]}))
        );
        assert_eq!(find_rpc_result(bytes, 3).unwrap(), None);
        assert_eq!(find_rpc_result(b"data: {\"id\":2,", 2).unwrap(), None);
        assert!(
            find_rpc_result(br#"{"id":2,"error":{"message":"private-token"}}"#, 2)
                .unwrap_err()
                .contains("처리하지 못")
        );
        assert!(
            !find_rpc_result(br#"{"id":2,"error":{"message":"private-token"}}"#, 2)
                .unwrap_err()
                .contains("private-token")
        );
    }

    fn read_request(socket: &mut std::net::TcpStream) -> String {
        socket
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        let mut bytes = Vec::new();
        let mut buffer = [0; 4096];
        loop {
            let count = socket.read(&mut buffer).unwrap();
            assert!(count > 0);
            bytes.extend_from_slice(&buffer[..count]);
            if let Some(end) = bytes.windows(4).position(|window| window == b"\r\n\r\n") {
                let headers = String::from_utf8_lossy(&bytes[..end]);
                let length = headers
                    .lines()
                    .find_map(|line| {
                        line.split_once(':').and_then(|(name, value)| {
                            name.eq_ignore_ascii_case("content-length")
                                .then(|| value.trim().parse::<usize>().ok())
                                .flatten()
                        })
                    })
                    .unwrap_or(0);
                if bytes.len() >= end + 4 + length {
                    break;
                }
            }
        }
        String::from_utf8(bytes).unwrap()
    }

    #[tokio::test]
    async fn mcp_handshake_preserves_session_and_handles_paginated_open_sse() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let tools: Vec<_> = crate::mcp_bridge::tools()
            .into_iter()
            .map(|mut tool| {
                tool["name"] = json!(format!("studio__{}", tool["name"].as_str().unwrap()));
                tool
            })
            .collect();
        let handle = std::thread::spawn(move || {
            let responses = [
                json!({"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-03-26","serverInfo":{"name":"mock-codexify"}}}).to_string(),
                String::new(),
                json!({"jsonrpc":"2.0","id":2,"result":{"tools":[{"name":"native_read"}],"nextCursor":"next-page"}}).to_string(),
                format!("event: message\ndata: {}\n\n", json!({"jsonrpc":"2.0","id":3,"result":{"tools":tools}})),
            ];
            let mut requests = Vec::new();
            for (index, body) in responses.iter().enumerate() {
                let (mut socket, _) = listener.accept().unwrap();
                requests.push(read_request(&mut socket));
                if index == 3 {
                    socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\n\r\n{:x}\r\n{body}\r\n", body.len()).as_bytes()).unwrap();
                    // Deliberately never send the closing chunk. Client must
                    // finish at the matching SSE event, rather than EOF.
                    let mut buffer = [0; 1];
                    let _ = socket.read(&mut buffer);
                } else {
                    let status = if index == 1 { "202 Accepted" } else { "200 OK" };
                    socket.write_all(format!("HTTP/1.1 {status}\r\nContent-Type: application/json\r\nMcp-Session-Id: studio-session\r\nConnection: close\r\nContent-Length: {}\r\n\r\n{body}", body.len()).as_bytes()).unwrap();
                }
            }
            requests
        });
        let result = mcp_probe(&Profile {
            mcp_url: format!("http://{address}/mcp"),
            ..Profile::default()
        })
        .await
        .unwrap();
        assert_eq!(result["reachable"], true);
        assert_eq!(result["toolCount"], crate::mcp_bridge::tools().len() + 1);
        assert_eq!(result["fileReceiverReady"], true);
        assert_eq!(result["missingStudioTools"], json!([]));
        let requests = handle.join().unwrap();
        for request in &requests[1..] {
            assert!(request
                .to_lowercase()
                .contains("mcp-session-id: studio-session"));
            assert!(request
                .to_lowercase()
                .contains("mcp-protocol-version: 2025-03-26"));
        }
        assert!(requests[1].contains("notifications/initialized"));
        assert!(requests[3].contains("next-page"));
    }

    #[tokio::test]
    async fn local_client_rejects_http_redirect_without_following_it() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let handle = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            let request = read_request(&mut socket);
            socket.write_all(b"HTTP/1.1 302 Found\r\nLocation: https://outside.test/secret\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").unwrap();
            request
        });
        let error = mcp_probe(&Profile {
            mcp_url: format!("http://{address}/mcp"),
            ..Profile::default()
        })
        .await
        .unwrap_err();
        assert!(!error.contains("outside.test"));
        assert!(handle.join().unwrap().starts_with("POST /mcp"));
    }

    #[cfg(unix)]
    #[test]
    fn owner_credential_requires_private_regular_owned_file_and_never_echoes_secret() {
        use std::os::unix::fs::{symlink, PermissionsExt};
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("owner-chat.json");
        fs::write(
            &path,
            br#"{"port":3120,"token":"private-owner-credential"}"#,
        )
        .unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
        let owner = owner_at(&path, directory.path()).unwrap();
        assert_eq!(owner.port, 3120);
        fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
        let error = owner_at(&path, directory.path()).err().unwrap();
        assert!(!error.contains("private-owner-credential"));
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
        let link = directory.path().join("link.json");
        symlink(&path, &link).unwrap();
        assert!(owner_at(&link, directory.path()).is_err());
        fs::write(&path, vec![b'x'; 4097]).unwrap();
        assert!(owner_at(&path, directory.path()).is_err());
    }

    #[test]
    fn owner_responses_require_namespaced_metadata() {
        let result =
            json!({"sent":{"id":"message-1","end":10,"created_at_ms":12,"tool_call_count":0}});
        assert_eq!(
            unwrap_owner(json!({"_meta":{OWNER_META:result}})).unwrap(),
            result
        );
        assert!(unwrap_owner(json!({"sent":{"id":"message-1"}})).is_err());
    }

    struct BindingFixture {
        _directory: tempfile::TempDir,
        profile: Profile,
        state: Value,
        bindings: std::path::PathBuf,
        binding_file: std::path::PathBuf,
    }
    fn binding_fixture() -> BindingFixture {
        let directory = tempfile::tempdir().unwrap();
        // Canonical temporary base also avoids macOS /var -> /private/var alias.
        let base = fs::canonicalize(directory.path()).unwrap();
        let project = base.join("studio");
        fs::create_dir(&project).unwrap();
        let project_string = project.to_string_lossy().to_string();
        let owner = "a".repeat(64);
        let chat_file = base
            .join(".codexify/projects")
            .join(project_metadata_key(&project))
            .join("chats")
            .join(&owner)
            .join("CHAT.md");
        fs::create_dir_all(chat_file.parent().unwrap()).unwrap();
        fs::write(&chat_file, "# owner chat").unwrap();
        let mut hasher = Sha256::new();
        hasher.update(b"codexify/access-root/v1\0");
        hasher.update(project_string.as_bytes());
        let access_key = format!("{:x}", hasher.finalize());
        let bindings = base.join(".codexify/conversation-projects");
        let binding_file = bindings
            .join(&access_key[..24])
            .join(format!("{owner}.json"));
        fs::create_dir_all(binding_file.parent().unwrap()).unwrap();
        fs::write(&binding_file, json!({"version":2,"accessRoot":project_string,"projectRoot":project_string,"managedWorktree":false}).to_string()).unwrap();
        let raw = chat_file.to_string_lossy().to_string();
        let profile = Profile {
            project_root: project_string,
            conversation_id: format!("{:x}", Sha256::digest(raw.as_bytes())),
            ..Profile::default()
        };
        BindingFixture {
            _directory: directory,
            profile,
            state: json!({"chat_file":raw}),
            bindings,
            binding_file,
        }
    }

    #[test]
    fn full_project_binding_accepts_exact_owner_chat_and_rejects_same_basename() {
        let fixture = binding_fixture();
        assert!(
            verify_chat_project_at(&fixture.profile, &fixture.state, &fixture.bindings).is_ok()
        );
        let other = fixture._directory.path().join("other/studio");
        fs::create_dir_all(&other).unwrap();
        let wrong = Profile {
            project_root: other.to_string_lossy().into(),
            ..fixture.profile.clone()
        };
        assert!(verify_chat_project_at(&wrong, &fixture.state, &fixture.bindings).is_err());
        let wrong_id = Profile {
            conversation_id: "b".repeat(64),
            ..fixture.profile.clone()
        };
        assert!(verify_chat_project_at(&wrong_id, &fixture.state, &fixture.bindings).is_err());
        fs::remove_file(&fixture.binding_file).unwrap();
        assert!(
            verify_chat_project_at(&fixture.profile, &fixture.state, &fixture.bindings).is_ok()
        );
    }

    #[test]
    fn default_single_project_chat_needs_exact_namespace_even_without_bindings() {
        let fixture = binding_fixture();
        fs::remove_dir_all(&fixture.bindings).unwrap();
        assert!(
            verify_chat_project_at(&fixture.profile, &fixture.state, &fixture.bindings).is_ok()
        );
        let other = fixture._directory.path().join("another/studio");
        fs::create_dir_all(&other).unwrap();
        let wrong = Profile {
            project_root: other.to_string_lossy().into(),
            ..fixture.profile.clone()
        };
        assert!(verify_chat_project_at(&wrong, &fixture.state, &fixture.bindings).is_err());
    }

    #[test]
    fn contradictory_owner_binding_is_rejected_despite_matching_namespace() {
        let fixture = binding_fixture();
        let other = fixture._directory.path().join("another/studio");
        fs::create_dir_all(&other).unwrap();
        let access = &fixture.profile.project_root;
        fs::write(
            &fixture.binding_file,
            json!({"version":2,"accessRoot":access,"projectRoot":other,"managedWorktree":false})
                .to_string(),
        )
        .unwrap();
        assert!(
            verify_chat_project_at(&fixture.profile, &fixture.state, &fixture.bindings).is_err()
        );
    }

    #[test]
    fn send_contract_requires_expected_profile_and_rejects_changed_target() {
        assert!(serde_json::from_value::<SendInput>(
            json!({"requestId":"request-1","message":"hello"})
        )
        .is_err());
        let profile = Profile {
            conversation_id: "a".repeat(64),
            project_root: "/project/studio".into(),
            ..Profile::default()
        };
        let input: SendInput = serde_json::from_value(
            json!({"requestId":"request-1","message":"hello","expectedProfile":profile}),
        )
        .unwrap();
        let changed = Profile {
            conversation_id: "b".repeat(64),
            ..profile.clone()
        };
        assert!(require_unchanged_profile(&changed, &input.expected_profile).is_err());
        assert!(require_unchanged_profile(&profile, &input.expected_profile).is_ok());
    }

    #[test]
    fn conversation_must_be_explicitly_selected_and_currently_listed() {
        let fixture = binding_fixture();
        let list = json!({"chats":[{"id":fixture.profile.conversation_id,"workspace":"studio"}],"serverTimeMs":10});
        assert!(selected_chat(&fixture.profile, &list).is_ok());
        assert!(selected_chat(&Profile::default(), &list).is_err());
        assert!(selected_chat(&fixture.profile, &json!({"chats":[]})).is_err());
    }

    #[test]
    fn owner_chat_list_matches_project_namespace_and_rejects_duplicate_basename() {
        let fixture = binding_fixture();
        let other = fixture._directory.path().join("other/studio");
        fs::create_dir_all(&other).unwrap();
        let namespace = project_metadata_key(Path::new(&fixture.profile.project_root));
        assert!(namespace.starts_with("studio-"));
        assert_eq!(namespace.len(), "studio-".len() + 12);
        let mut list = json!({"chats":[
            {"id":"selected","workspace":namespace},
            {"id":"different-project","workspace":project_metadata_key(&other)},
            {"id":"ambiguous-basename","workspace":"studio"}
        ],"serverTimeMs":10});
        enrich_project_matches(&fixture.profile, &mut list);
        assert_eq!(list["chats"][0]["projectMatches"], true);
        assert_eq!(list["chats"][1]["projectMatches"], false);
        assert_eq!(list["chats"][2]["projectMatches"], false);
        assert_eq!(list["chats"][0]["workspace"], namespace);
        enrich_project_matches(&Profile::default(), &mut list);
        assert!(list["chats"]
            .as_array()
            .unwrap()
            .iter()
            .all(|chat| chat["projectMatches"] == false));
    }

    #[cfg(unix)]
    #[test]
    fn symlinked_binding_or_transcript_is_rejected() {
        use std::os::unix::fs::symlink;
        let fixture = binding_fixture();
        let original = fixture.binding_file.with_extension("old");
        fs::rename(&fixture.binding_file, &original).unwrap();
        symlink(&original, &fixture.binding_file).unwrap();
        assert!(
            verify_chat_project_at(&fixture.profile, &fixture.state, &fixture.bindings).is_err()
        );
        fs::remove_file(&fixture.binding_file).unwrap();
        fs::rename(&original, &fixture.binding_file).unwrap();
        let chat_file = Path::new(fixture.state["chat_file"].as_str().unwrap());
        let original = chat_file.with_extension("old");
        fs::rename(chat_file, &original).unwrap();
        symlink(&original, chat_file).unwrap();
        assert!(
            verify_chat_project_at(&fixture.profile, &fixture.state, &fixture.bindings).is_err()
        );
    }

    #[tokio::test]
    async fn owner_api_uses_private_bearer_and_unwraps_queued_message_receipt() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let handle = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            let request = read_request(&mut socket);
            let body = json!({"_meta":{OWNER_META:{"sent":{"id":"message-1","end":10,"created_at_ms":12,"tool_call_count":0}}}}).to_string();
            socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).as_bytes()).unwrap();
            request
        });
        let owner = Owner {
            port: address.port(),
            token: "test-owner-token".into(),
        };
        let value = unwrap_owner(
            owner_request(
                &owner,
                reqwest::Method::POST,
                "/api/chats/chat-1/send",
                Some(json!({"request_id":"request-1","message":"queued request"})),
            )
            .await
            .unwrap(),
        )
        .unwrap();
        assert_eq!(value["sent"]["id"], "message-1");
        assert!(!value.to_string().contains("test-owner-token"));
        let request = handle.join().unwrap().to_lowercase();
        assert!(request.contains("authorization: bearer test-owner-token"));
        assert!(request.contains(&format!("host: {address}")));
        assert!(request.contains("request_id"));
    }
}
