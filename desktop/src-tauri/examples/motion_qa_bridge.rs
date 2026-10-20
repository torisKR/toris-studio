//! Isolated QA adapter; never shipped or registered as an application command.
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};
use std::io::{Read, Write};
fn main() {
    let r = (|| -> Result<Value, String> {
        let root = std::path::PathBuf::from(
            std::env::var_os("TORIS_MOTION_QA_HOME").ok_or("QA home required")?,
        );
        let mut bytes = Vec::new();
        std::io::stdin()
            .take(3 * 1024 * 1024)
            .read_to_end(&mut bytes)
            .map_err(|e| e.to_string())?;
        let input: Value = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
        let args = &input["args"];
        let id = args["id"].as_str().unwrap_or("");
        use toris_studio_desktop::{graphics, graphics_render, motion_drafts};
        match input["action"].as_str().unwrap_or("") {
            "request" => motion_drafts::request_at(&root, args["input"].clone()),
            "list" => Ok(serde_json::from_slice(
                &std::fs::read(root.join("inbox.json")).unwrap_or_else(|_| b"[]".to_vec()),
            )
            .map_err(|_| "inbox parse")?),
            "receive" => motion_drafts::receive_at(&root, args.clone()),
            "apply" => motion_drafts::apply_at(&root, id, args["project"].clone()),
            "cancel" => motion_drafts::cancel_at(&root, id),
            "review" => {
                let r = motion_drafts::get_at(&root, id)?;
                if r["baseHash"] != graphics::hash(&args["project"]) {
                    return Err("편집 충돌".into());
                }
                graphics::apply_patch(&args["project"], &r["draft"])
            }
            "still" => {
                let mut scene = graphics_render::PreparedScene::new(
                    &args["project"],
                    args["index"].as_u64().unwrap_or(0) as usize,
                    540,
                    &root,
                )?;
                let frame = scene.frame(args["time"].as_f64().unwrap_or(2.0))?;
                let mut bytes = std::io::Cursor::new(Vec::new());
                image::DynamicImage::ImageRgba8(frame)
                    .write_to(&mut bytes, image::ImageFormat::Png)
                    .map_err(|_| "PNG error")?;
                Ok(
                    json!({"dataUrl":format!("data:image/png;base64,{}",STANDARD.encode(bytes.into_inner())),"hash":graphics::hash(&args["project"])}),
                )
            }
            _ => Err("Unknown QA action".into()),
        }
    })();
    let output = match r {
        Ok(v) => json!({"ok":true,"result":v}),
        Err(e) => json!({"ok":false,"error":e}),
    };
    let _ = writeln!(std::io::stdout(), "{output}");
}
