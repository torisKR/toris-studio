//! Explicit local-only probe. Generates a 3-second QA MP4, never logs in or uploads.
#[tokio::main]
async fn main() {
    if std::env::args().nth(1).as_deref() != Some("--generate-local-sample") {
        eprintln!("Use --generate-local-sample to create a QA video. No upload occurs.");
        std::process::exit(2);
    }
    match toris_studio_desktop::publishing::make_sample().await {
        Ok(file) => println!(
            "{}",
            serde_json::json!({"generated":true,"selection":file,"publicPostsCreated":0})
        ),
        Err(error) => {
            eprintln!("{error}");
            std::process::exit(1);
        }
    }
}
