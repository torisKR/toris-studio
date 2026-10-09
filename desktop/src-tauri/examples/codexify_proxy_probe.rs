//! Explicit live Quick Tunnel check; never changes existing bridges or registered plugins.
use toris_studio_desktop::codexify_proxy::ProxyController;
#[tokio::main]
async fn main() {
    if std::env::args().nth(1).as_deref() != Some("--live-check") {
        eprintln!("Use --live-check to create and stop one temporary Cloudflare proxy.");
        std::process::exit(2);
    }
    let proxy = ProxyController::default();
    let port = toris_studio_desktop::codexify_runtime::RuntimeController::new()
        .status()
        .await
        .unwrap()
        .port;
    match proxy.start(port).await {
        Ok(status) => {
            println!("{}", serde_json::to_string(&status).unwrap());
            let stopped = proxy.stop().await.unwrap();
            println!("{}", serde_json::to_string(&stopped).unwrap());
        }
        Err(error) => {
            proxy.shutdown();
            eprintln!("{error}");
            std::process::exit(1);
        }
    }
}
