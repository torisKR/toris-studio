//! Host-side check for factory requests. The webview cannot pass a command, path, or token
//! through to the agent runtime; only these fields are forwarded.
use serde_json::{json, Value};

const KEYS: &[&str] = &[
    "brief",
    "kind",
    "view",
    "orientation",
    "resumeProject",
    "opinion",
    "applyOpinion",
];

pub fn parse_request(input: &Value) -> Result<Value, String> {
    let object = input.as_object().ok_or("요청 형식을 확인하세요.")?;
    for key in object.keys() {
        if !KEYS.contains(&key.as_str()) {
            return Err(format!("{key}: 허용되지 않은 필드입니다."));
        }
    }
    let kind = object.get("kind").and_then(Value::as_str).unwrap_or("game");
    if kind != "game" && kind != "app" {
        return Err("종류를 확인하세요.".into());
    }
    let view = optional_enum(object.get("view"), &["2d", "3d", "ui"], "화면")?;
    let orientation = optional_enum(
        object.get("orientation"),
        &["landscape", "portrait"],
        "방향",
    )?;
    let brief = object
        .get("brief")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    if brief.chars().count() > 2000 {
        return Err("요청이 너무 깁니다.".into());
    }
    if brief
        .chars()
        .any(|ch| ch.is_control() && ch != '\n' && ch != '\r' && ch != '\t')
        || brief.contains("$(")
        || brief.contains("sk-ant-")
        || brief.contains("sk-or-")
    {
        return Err("요청에 명령이나 비밀값을 넣을 수 없습니다.".into());
    }
    let resume = object
        .get("resumeProject")
        .and_then(Value::as_str)
        .unwrap_or("");
    if !resume.is_empty() && !is_slug(resume) {
        return Err("프로젝트 이름을 확인하세요.".into());
    }
    if brief.is_empty() && resume.is_empty() {
        return Err("요청을 입력하세요.".into());
    }
    let opinion = object
        .get("opinion")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    if opinion.chars().count() > 500 {
        return Err("의견은 500자 이하로 적어 주세요.".into());
    }
    if opinion_unsafe(opinion) {
        return Err("의견에 명령이나 비밀값을 넣을 수 없습니다.".into());
    }
    let apply = match object.get("applyOpinion") {
        None => false,
        Some(Value::Bool(value)) => *value,
        Some(_) => return Err("의견 반영 여부를 확인하세요.".into()),
    };
    let mut clean = json!({ "kind": kind });
    if !brief.is_empty() {
        clean["brief"] = json!(brief);
    }
    if let Some(view) = view {
        clean["view"] = json!(view);
    }
    if let Some(orientation) = orientation {
        clean["orientation"] = json!(orientation);
    }
    if !resume.is_empty() {
        clean["resumeProject"] = json!(resume);
    }
    if !opinion.is_empty() {
        clean["opinion"] = json!(opinion);
        clean["applyOpinion"] = json!(apply);
    }
    Ok(json!({
        "workflow": if kind == "app" { "app-factory" } else { "game-factory" },
        "task": brief,
        "input": clean,
    }))
}

fn optional_enum(
    value: Option<&Value>,
    allowed: &[&str],
    label: &str,
) -> Result<Option<String>, String> {
    let Some(value) = value else { return Ok(None) };
    let text = value
        .as_str()
        .ok_or_else(|| format!("{label}을 확인하세요."))?;
    if !allowed.contains(&text) {
        return Err(format!("{label}을 확인하세요."));
    }
    Ok(Some(text.to_owned()))
}

fn opinion_unsafe(text: &str) -> bool {
    text.chars()
        .any(|ch| ch.is_control() && ch != '\n' && ch != '\r' && ch != '\t')
        || text.contains("$(")
        || text.contains("sk-ant-")
        || text.contains("sk-or-")
        || text.contains("```")
        || text.contains("http://")
        || text.contains("https://")
}

fn is_slug(value: &str) -> bool {
    let mut chars = value.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    first.is_ascii_lowercase()
        && value.len() >= 2
        && value.len() <= 40
        && value
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
}

#[cfg(test)]
mod tests {
    use super::parse_request;
    use serde_json::json;

    #[test]
    fn requests_keep_only_closed_fields() {
        let parsed = parse_request(
            &json!({"brief": "도트 게임", "kind": "game", "view": "2d", "command": "rm"}),
        )
        .unwrap_err();
        assert!(parsed.contains("command"));
        assert!(parse_request(&json!({"brief": "게임 $(rm)"})).is_err());
        assert!(parse_request(&json!({"brief": "게임", "resumeProject": "../x"})).is_err());
        let ok =
            parse_request(&json!({"brief": "할 일 앱", "kind": "app", "orientation": "portrait"}))
                .unwrap();
        assert_eq!(ok["workflow"], "app-factory");
        assert!(ok["input"].get("command").is_none());
        assert_eq!(ok["input"]["orientation"], "portrait");
        let recorded = parse_request(
            &json!({"brief": "게임", "opinion": "더 단순하게", "applyOpinion": false}),
        )
        .unwrap();
        assert_eq!(recorded["input"]["applyOpinion"], false);
        assert_eq!(recorded["input"]["opinion"], "더 단순하게");
        assert!(parse_request(&json!({"brief": "게임", "opinion": "하지 마 $(rm)"})).is_err());
    }
}
