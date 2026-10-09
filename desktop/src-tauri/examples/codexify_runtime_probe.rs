//! Read-only runtime status/doctor, or an explicit isolated temporary-child lifecycle test.
use toris_studio_desktop::codexify_runtime::{isolated_check, RuntimeController};

#[tokio::main]
async fn main() {
    let args: Vec<_> = std::env::args().skip(1).collect();
    let result = match args.as_slice() {
        [option] if option == "--isolated-check" => isolated_check().await,
        [option] if option == "--doctor" => {
            RuntimeController::new().doctor().await.and_then(|report| {
                serde_json::to_value(report).map_err(|_| "진단을 표시하지 못했습니다.".into())
            })
        }
        [] => RuntimeController::new().status().await.and_then(|status| {
            serde_json::to_value(status).map_err(|_| "상태를 표시하지 못했습니다.".into())
        }),
        _ => Err("--doctor 또는 --isolated-check만 지원합니다.".into()),
    };
    match result {
        Ok(value) => println!("{}", serde_json::to_string_pretty(&value).unwrap()),
        Err(error) => {
            eprintln!("{error}");
            std::process::exit(1);
        }
    }
}
