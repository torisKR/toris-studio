//! Tauri commands for the Agent tab and for app features that use the selected model.
use crate::agent_runtime::{self, AgentRuntime, AgentSettings};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{collections::HashMap, sync::Arc};
use tauri::State;

type Runtime<'a> = State<'a, Arc<AgentRuntime>>;

fn public_settings(settings: &AgentSettings) -> Result<Value, String> {
    Ok(agent_runtime::settings_view(
        settings,
        agent_runtime::keys(),
    ))
}

#[tauri::command]
pub fn agent_settings_get(window: tauri::WebviewWindow) -> Result<Value, String> {
    crate::updater::authorize(&window)?;
    public_settings(&agent_runtime::load_settings()?)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveInput {
    settings: AgentSettings,
    /// provider -> new key; an empty string removes the saved key; absent keeps it.
    #[serde(default)]
    keys: HashMap<String, String>,
}
#[tauri::command]
pub async fn agent_settings_save(
    window: tauri::WebviewWindow,
    runtime: Runtime<'_>,
    input: SaveInput,
) -> Result<Value, String> {
    crate::updater::authorize(&window)?;
    agent_runtime::validate_settings(&input.settings)?;
    for (provider, value) in &input.keys {
        let value = value.trim();
        agent_runtime::write_key(provider, (!value.is_empty()).then_some(value))?;
    }
    agent_runtime::save_settings(&input.settings)?;
    runtime.reconfigure().await?;
    public_settings(&input.settings)
}

#[tauri::command]
pub async fn agent_call(
    window: tauri::WebviewWindow,
    runtime: Runtime<'_>,
    method: String,
    params: Option<Value>,
) -> Result<Value, String> {
    crate::updater::authorize(&window)?;
    let params = params.unwrap_or_else(|| json!({}));
    crate::hub::ui_params_allowed(&method, &params)?;
    runtime.call(&method, params).await
}

#[tauri::command]
pub async fn agent_runtime_restart(
    window: tauri::WebviewWindow,
    runtime: Runtime<'_>,
) -> Result<Value, String> {
    crate::updater::authorize(&window)?;
    runtime.restart().await?;
    Ok(json!({"ok":true}))
}

#[tauri::command]
pub async fn vector_db_start(window: tauri::WebviewWindow) -> Result<Value, String> {
    crate::updater::authorize(&window)?;
    crate::ops::start_vector_db().await
}

/// Model-backed text for the AI workspace, video drafts and SNS copy.
#[tauri::command]
pub async fn ai_generate(
    window: tauri::WebviewWindow,
    runtime: Runtime<'_>,
    input: Value,
) -> Result<Value, String> {
    crate::updater::authorize(&window)?;
    let prompt = input["prompt"]
        .as_str()
        .filter(|p| !p.trim().is_empty())
        .ok_or("요청 내용을 입력하세요.")?;
    let mut params = json!({"prompt": prompt, "purpose": "content"});
    if let Some(system) = input["system"].as_str() {
        params["system"] = json!(system);
    }
    runtime.call("complete", params).await
}

#[tauri::command]
pub async fn ai_status(
    window: tauri::WebviewWindow,
    runtime: Runtime<'_>,
) -> Result<Value, String> {
    crate::updater::authorize(&window)?;
    let settings = agent_runtime::load_settings()?;
    let status = runtime.call("status", json!({})).await?;
    Ok(
        json!({"providers": status["providers"], "contentModel": settings.content_model, "agentModel": settings.agent_model, "image": settings.image}),
    )
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageInput {
    job_id: String,
    prompt: String,
    #[serde(default)]
    size: Option<String>,
}
/// Generate an image with the selected API and store it against an existing asset job.
#[tauri::command]
pub async fn ai_generate_image(
    window: tauri::WebviewWindow,
    runtime: Runtime<'_>,
    input: ImageInput,
) -> Result<Value, String> {
    crate::updater::authorize(&window)?;
    uuid::Uuid::parse_str(&input.job_id).map_err(|_| "에셋 작업 ID 형식 오류")?;
    let image = runtime
        .call("image", json!({"prompt": input.prompt, "size": input.size.unwrap_or_else(|| "1024x1024".into())}))
        .await?;
    let data = image["base64"]
        .as_str()
        .ok_or("이미지 데이터가 없습니다.")?;
    let bytes = STANDARD
        .decode(data)
        .map_err(|_| "이미지 데이터 형식 오류")?;
    if bytes.len() > crate::assets::MAX_BYTES {
        return Err("생성된 이미지가 32 MiB를 넘습니다.".into());
    }
    let ext = agent_runtime::image_extension(&bytes).ok_or("지원하지 않는 이미지 형식입니다.")?;
    let job_id = input.job_id;
    let filename = format!("ai-{}.{ext}", &job_id[..8]);
    tokio::task::spawn_blocking(move || {
        crate::assets::dispatch("import", json!({"filename": filename, "dataBase64": STANDARD.encode(bytes), "jobId": job_id, "source": "ai"}))
    })
    .await
    .map_err(|_| "이미지 저장 작업이 중단되었습니다.".to_string())?
    .map(|saved| json!({"saved": saved, "provider": image["provider"], "model": image["model"]}))
}

/// Store a model-written SNS draft against an app-created request.
#[tauri::command]
pub async fn publication_ai_receive(
    window: tauri::WebviewWindow,
    input: Value,
) -> Result<Value, String> {
    crate::updater::authorize(&window)?;
    tokio::task::spawn_blocking(move || crate::chatgpt_drafts::receive(input))
        .await
        .map_err(|_| "초안 저장 실패".to_string())?
}

/// Opens the official login of one CLI in the system terminal, only when the user presses the button.
/// Login, tokens and their storage stay inside that CLI; the app only re-checks status afterwards.
#[tauri::command]
pub async fn agent_cli_login(window: tauri::WebviewWindow, tool: String) -> Result<Value, String> {
    crate::updater::authorize(&window)?;
    let (program, args) = agent_runtime::login_argv(&tool)?;
    let binary = agent_runtime::find_cli(program)
        .ok_or_else(|| format!("{program} CLI를 찾을 수 없습니다. 먼저 설치하세요."))?;
    open_terminal(&binary, args)?;
    Ok(json!({"started": true, "tool": tool}))
}

#[cfg(target_os = "macos")]
fn open_terminal(binary: &std::path::Path, args: &[&str]) -> Result<(), String> {
    use std::{io::Write, os::unix::fs::PermissionsExt};
    let failed = || "터미널에서 로그인 명령을 열지 못했습니다.".to_string();
    // A fresh private file per launch; Terminal runs `.command` files without Apple Events access.
    agent_runtime::remove_old_login_scripts(&std::env::temp_dir());
    let mut file = tempfile::Builder::new()
        .prefix(agent_runtime::LOGIN_SCRIPT_PREFIX)
        .suffix(".command")
        .tempfile()
        .map_err(|_| failed())?;
    file.write_all(agent_runtime::login_script(binary, args).as_bytes())
        .map_err(|_| failed())?;
    file.as_file()
        .set_permissions(std::fs::Permissions::from_mode(0o700))
        .map_err(|_| failed())?;
    let (_, path) = file.keep().map_err(|_| failed())?;
    let status = std::process::Command::new("/usr/bin/open")
        .arg(&path)
        .status()
        .map_err(|_| failed())?;
    status.success().then_some(()).ok_or_else(failed)
}

#[cfg(windows)]
fn open_terminal(binary: &std::path::Path, args: &[&str]) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    // One raw command line: standard argument quoting would double-quote the already quoted path.
    std::process::Command::new("cmd.exe")
        .raw_arg(agent_runtime::windows_login_command_line(binary, args)?)
        .spawn()
        .map(|_| ())
        .map_err(|_| "터미널에서 로그인 명령을 열지 못했습니다.".into())
}

#[cfg(not(any(target_os = "macos", windows)))]
fn open_terminal(_binary: &std::path::Path, _args: &[&str]) -> Result<(), String> {
    Err("이 운영체제에서는 터미널에서 직접 로그인하세요.".into())
}
