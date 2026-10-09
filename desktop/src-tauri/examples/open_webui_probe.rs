//! Explicit local integration check. Does not change other containers or accounts.
use toris_studio_desktop::{config::AppConfig, open_webui::OpenWebUiController, open_webui_bridge};

fn public_config() -> Result<AppConfig, String> {
    let path = toris_studio_desktop::config::config_path();
    let mut config = if path.exists() {
        let metadata = std::fs::symlink_metadata(&path)
            .map_err(|_| "저장된 공개 설정을 확인할 수 없습니다.")?;
        if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > 32768 {
            return Err("저장된 공개 설정의 파일 형식을 확인하세요.".into());
        }
        let bytes = std::fs::read(path).map_err(|_| "저장된 공개 설정을 읽을 수 없습니다.")?;
        serde_json::from_slice::<AppConfig>(&bytes)
            .map_err(|_| "저장된 공개 설정 형식을 확인하세요.")?
    } else {
        AppConfig::default()
    };
    // This diagnostics option explicitly avoids credential hydration and all writes.
    config.database_url = None;
    config.opencodex_api_key = None;
    config.teamclaude_api_key = None;
    config.youtube_api_key = None;
    config.naver_client_id = None;
    config.naver_client_secret = None;
    config.validate()?;
    Ok(config)
}

#[tokio::main]
async fn main() {
    let args: Vec<_> = std::env::args().skip(1).collect();
    let serve = args.iter().any(|argument| argument == "--serve");
    let public = args.iter().any(|argument| argument == "--public-config");
    let action = match args
        .iter()
        .filter(|argument| !matches!(argument.as_str(), "--serve" | "--public-config"))
        .map(String::as_str)
        .collect::<Vec<_>>()
        .as_slice()
    {
        [] if serve => "status",
        ["--status"] => "status",
        ["--start"] => "start",
        ["--stop"] => "stop",
        _ => {
            eprintln!(
                "Use --status, --start, or --stop for the app-owned local Open WebUI container. Add --serve to retain its local MCP adapter and --public-config to skip credential hydration."
            );
            std::process::exit(2);
        }
    };
    let config = match if public {
        public_config()
    } else {
        AppConfig::load()
    } {
        Ok(config) => config,
        Err(error) => {
            eprintln!("{error}");
            std::process::exit(1);
        }
    };
    let controller = OpenWebUiController::new();
    let bridge = open_webui_bridge::Controller::default();
    if action == "start" || serve {
        if let Err(error) = bridge.ensure_started().await {
            eprintln!("{error}");
            std::process::exit(1);
        }
    }
    let result = match action {
        "start" => {
            let initial = controller.start(&config).await;
            if let Ok(ref status) = initial {
                println!("{}", serde_json::to_string(status).unwrap());
            }
            let mut result = initial;
            for _ in 0..180 {
                if result.as_ref().is_ok_and(|status| {
                    status.can_open
                        || status.status == toris_studio_desktop::open_webui::Phase::Error
                }) {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_secs(2)).await;
                result = controller.status(&config).await;
            }
            result
        }
        "stop" => controller.stop(&config).await,
        _ => controller.status(&config).await,
    };
    match result {
        Ok(status) => {
            println!("{}", serde_json::to_string(&status).unwrap());
            if status.status == toris_studio_desktop::open_webui::Phase::Error {
                std::process::exit(1);
            }
            if serve {
                std::future::pending::<()>().await;
            }
        }
        Err(error) => {
            eprintln!("{error}");
            std::process::exit(1);
        }
    }
}
