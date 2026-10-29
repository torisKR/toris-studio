//! Manual check of licence-cleared stock search and download against the live APIs.
//! Usage: cargo run --example stock_probe -- "<english query>" [9:16|16:9|1:1]
use toris_studio_desktop::stock_media;

#[tokio::main]
async fn main() {
    let args: Vec<String> = std::env::args().collect();
    let query = args
        .get(1)
        .cloned()
        .unwrap_or_else(|| "seoul skyline".into());
    let aspect = args.get(2).cloned().unwrap_or_else(|| "9:16".into());
    let found = stock_media::search(&query, &aspect, 4)
        .await
        .expect("search");
    for candidate in &found {
        println!(
            "{} | {}x{} | {}",
            candidate["license"],
            candidate["width"],
            candidate["height"],
            stock_media::credit_line(candidate)
        );
    }
    let target = std::env::temp_dir().join("toris-stock-probe.jpg");
    let saved = stock_media::download(&found[0], &target)
        .await
        .expect("download");
    println!("saved {} {}", target.display(), saved);
}
