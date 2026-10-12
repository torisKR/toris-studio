//! Pure template data for isolated browser QA: stdout only, no configuration,
//! account, vault, database, network, or file access.
use serde_json::{json, Value};
use toris_studio_desktop::video_templates::{catalog, preview, CreateInput};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let templates = serde_json::to_value(catalog())?;
    let items = templates
        .as_array()
        .ok_or_else(|| std::io::Error::other("Template catalog is not an array"))?;
    let first_category = items
        .first()
        .and_then(|template| template["categories"].as_array())
        .and_then(|categories| categories.first())
        .ok_or_else(|| std::io::Error::other("Template catalog is empty"))?;
    let mut cases = Vec::<Value>::new();
    for template in items {
        let mut categories = vec![first_category];
        if let Some(category) = template["categories"]
            .as_array()
            .and_then(|value| value.first())
        {
            if category != first_category {
                categories.push(category);
            }
        }
        for category in categories {
            for topic in ["", "늦은 이전 주제 QA", "새로 선택한 영상 주제 QA"] {
                let input = json!({
                    "templateId": template["id"],
                    "topic": topic,
                    "category": category,
                    "format": template["format"],
                    "language": "ko",
                    "sceneCount": template["sampleProject"]["scenes"].as_array()
                        .ok_or_else(|| std::io::Error::other("Template sample has no scenes"))?.len(),
                    "durationSec": template["durationSec"],
                });
                let typed: CreateInput = serde_json::from_value(input.clone())?;
                let result = preview(typed).map_err(std::io::Error::other)?;
                cases.push(json!({ "input": input, "result": result }));
            }
        }
    }
    // Preview controls are exercised independently from template selection.
    // Include only explicit QA inputs, using the same native validation path.
    let first = &items[0];
    let default_count = first["sampleProject"]["scenes"]
        .as_array()
        .ok_or_else(|| std::io::Error::other("Template sample has no scenes"))?
        .len();
    let category_input = json!({
        "templateId": first["id"],
        "topic": "새로 선택한 영상 주제 QA",
        "category": "tech",
        "format": first["format"],
        "language": "ko",
        "sceneCount": default_count,
        "durationSec": first["durationSec"],
    });
    let typed: CreateInput = serde_json::from_value(category_input.clone())?;
    let result = preview(typed).map_err(std::io::Error::other)?;
    cases.push(json!({ "input": category_input, "result": result }));
    for format in ["shorts", "vertical", "youtube-landscape"] {
        for language in ["ko", "en"] {
            for scene_count in [default_count, 6] {
                for duration in [first["durationSec"].clone(), json!(60)] {
                    let input = json!({
                        "templateId": first["id"],
                        "topic": "새로 선택한 영상 주제 QA",
                        "category": first_category,
                        "format": format,
                        "language": language,
                        "sceneCount": scene_count,
                        "durationSec": duration,
                    });
                    let typed: CreateInput = serde_json::from_value(input.clone())?;
                    let result = preview(typed).map_err(std::io::Error::other)?;
                    cases.push(json!({ "input": input, "result": result }));
                }
            }
        }
    }
    println!(
        "{}",
        serde_json::to_string(&json!({ "catalog": templates, "cases": cases }))?
    );
    Ok(())
}
