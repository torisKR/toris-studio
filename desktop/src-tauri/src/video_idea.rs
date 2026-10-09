//! Topic/category planning is AI-only and produces editable, unverified prose.
//! Only literal text and fixed motion preset identifiers enter the project;
//! generated commands, code, URLs, credentials and filesystem paths do not.
use crate::{ai, config::AppConfig, keyword, media};
use chrono::{SecondsFormat, Utc};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashSet;
use uuid::Uuid;

const REVIEW_WARNING: &str =
    "AI가 주제와 카테고리로 만든 검토용 초안입니다. 사실·표현·장면·본문·내레이션을 확인한 뒤 음성과 영상을 출력하세요.";
const INVALID_RESPONSE: &str =
    "AI가 유효한 영상 기획을 반환하지 않았습니다. 기존 프로젝트는 유지됩니다. 다시 생성하거나 주제를 구체적으로 입력하세요.";

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreateInput {
    pub topic: String,
    pub category: String,
    pub format: String,
    pub provider: String,
    pub language: Option<String>,
    pub scene_count: Option<usize>,
    pub duration_sec: Option<f64>,
}

struct CheckedInput {
    topic: String,
    category: String,
    format: String,
    provider: String,
    language: String,
    scene_count: usize,
    duration_sec: f64,
}

fn valid_char(ch: char) -> bool {
    !ch.is_control()
        && !matches!(ch, '\u{200b}' | '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}' | '\u{feff}')
}

fn validate_input(input: CreateInput) -> Result<CheckedInput, String> {
    let topic = input.topic.trim();
    let language = input.language.as_deref().unwrap_or("ko");
    let scene_count = input.scene_count.unwrap_or(5);
    let duration_sec = input.duration_sec.unwrap_or(45.0);
    if topic.is_empty()
        || topic.chars().count() > 300
        || !input.topic.chars().all(valid_char)
        || !matches!(
            input.category.as_str(),
            "education" | "tech" | "business" | "lifestyle" | "entertainment" | "news"
        )
        || !matches!(
            input.format.as_str(),
            "shorts" | "vertical" | "youtube-landscape"
        )
        || !matches!(
            input.provider.as_str(),
            "opencodex" | "teamclaude" | "claude-cli"
        )
        || !matches!(language, "ko" | "ja" | "zh" | "en")
        || !(3..=8).contains(&scene_count)
        || !duration_sec.is_finite()
        || !(18.0..=180.0).contains(&duration_sec)
    {
        return Err(
            "주제(1~300자), 카테고리, 연결된 AI, 영상 형식과 생성 옵션을 확인하세요.".into(),
        );
    }
    if duration_sec < scene_count as f64 * 3.0 || duration_sec > scene_count as f64 * 30.0 {
        return Err(
            "장면 수와 전체 길이를 조정하세요. 장면마다 3~30초를 사용할 수 있습니다.".into(),
        );
    }
    Ok(CheckedInput {
        topic: topic.split_whitespace().collect::<Vec<_>>().join(" "),
        category: input.category,
        format: input.format,
        provider: input.provider,
        language: language.to_owned(),
        scene_count,
        duration_sec,
    })
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct AiMotion {
    preset: String,
    intensity: f64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AiScene {
    headline: String,
    body: String,
    narration: String,
    duration_sec: f64,
    motion: AiMotion,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct AiPlan {
    title: String,
    scenes: Vec<AiScene>,
}

fn plain_text(raw: &str, maximum: usize) -> bool {
    let text = raw.trim();
    if text.chars().count() < 2 || raw.chars().count() > maximum || !raw.chars().all(valid_char) {
        return false;
    }
    // These fields are displayed and rendered as text, never evaluated. Still
    // reject clear executable/media instructions rather than accepting them as
    // a video plan. The model cannot smuggle privileged project fields in JSON.
    let lower = text.to_ascii_lowercase();
    if [
        "http://",
        "https://",
        "www.",
        "file://",
        "javascript:",
        "data:",
        "```",
        "<script",
        "</script",
        "#!/",
        "$(",
        "${",
        "rm -rf",
        "powershell -",
        "cmd.exe",
        "curl -",
        "wget ",
        "import os",
        "subprocess.",
        "function(",
        "function (",
        "eval(",
        "exec(",
        "../",
        "..\\",
        "c:\\",
        "\\\\",
        "/users/",
        "/private/",
        "/tmp/",
        "/home/",
        "/etc/",
    ]
    .iter()
    .any(|marker| lower.contains(marker))
    {
        return false;
    }
    !text
        .split_whitespace()
        .any(|word| word.starts_with('/') || word.starts_with('~') || word.starts_with(".\\"))
}

fn validate_plan(text: &str, input: &CheckedInput) -> Result<AiPlan, String> {
    if text.len() > 24_576 {
        return Err(INVALID_RESPONSE.into());
    }
    let plan: AiPlan = serde_json::from_str(text).map_err(|_| INVALID_RESPONSE)?;
    if !plain_text(&plan.title, 100) || plan.scenes.len() != input.scene_count {
        return Err(INVALID_RESPONSE.into());
    }
    let mut total = 0.0;
    let mut presets = HashSet::new();
    for scene in &plan.scenes {
        if !plain_text(&scene.headline, 70)
            || !plain_text(&scene.body, 180)
            || !plain_text(&scene.narration, 240)
            || !scene.motion.intensity.is_finite()
            || !(0.0..=1.0).contains(&scene.motion.intensity)
            || !scene.duration_sec.is_finite()
            || !(3.0..=30.0).contains(&scene.duration_sec)
            || scene.narration.chars().count() as f64 > scene.duration_sec * 7.0
            || !matches!(
                scene.motion.preset.as_str(),
                "kinetic-title"
                    | "stagger-rise"
                    | "slide-reveal"
                    | "focus-pulse"
                    | "parallax-pan"
                    | "orbit-cards"
            )
        {
            return Err(INVALID_RESPONSE.into());
        }
        total += scene.duration_sec;
        presets.insert(scene.motion.preset.as_str());
    }
    if presets.len() < 2
        || (total - input.duration_sec).abs() > (input.duration_sec * 0.15).max(2.0)
    {
        return Err(INVALID_RESPONSE.into());
    }
    Ok(plan)
}

fn assemble_project(input: &CheckedInput, plan: AiPlan) -> Value {
    let created = Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true);
    let last = plan.scenes.len() - 1;
    let scenes: Vec<Value> = plan.scenes.into_iter().enumerate().map(|(index, scene)| {
        let (role, layout) = if index == 0 {
            ("hook", "social-hook")
        } else if index == last {
            ("outro", "social-cta")
        } else {
            ("point", "social-point")
        };
        json!({"id":format!("idea-{}",index + 1),"eyebrow":format!("SCENE {:02}",index + 1),
            "headline":scene.headline.trim(),"body":scene.body.trim(),"narration":scene.narration.trim(),
            "durationSec":scene.duration_sec,"mediaType":"none","role":role,"layout":layout,
            "motion":{"preset":scene.motion.preset,"intensity":scene.motion.intensity}})
    }).collect();
    json!({"id":Uuid::new_v4().to_string(),"title":plan.title.trim(),
        "subtitle":"주제·카테고리로 AI가 만든 검토용 모션 영상 초안","format":input.format,
        "template":"adaptive-promo","language":input.language,"scenes":scenes,
        "createdAt":created,"updatedAt":created,
        "idea":{"version":1,"topic":input.topic,"category":input.category,"provider":input.provider,
            "createdAt":created,"reviewRequired":true,"motionSkill":"toris-video-motion"}})
}

fn finish_generation(
    input: &CheckedInput,
    generated: Result<Value, String>,
    save: impl FnOnce(Value) -> Result<Value, String>,
) -> Result<Value, String> {
    // Provider failures are already sanitized by the private AI transport.
    // Do not create an empty/local project or switch to a different biller.
    let generated = generated?;
    let text = generated
        .get("text")
        .and_then(Value::as_str)
        .ok_or(INVALID_RESPONSE)?;
    let plan = validate_plan(text, input)?;
    let project = save(assemble_project(input, plan))?;
    let mut warnings = vec![REVIEW_WARNING];
    if input.category == "news" {
        warnings.push("실시간 검색이나 뉴스 사실 확인을 수행하지 않은 기획입니다. 원문·날짜·인용은 직접 확인하고 추가하세요.");
    }
    Ok(json!({"project":project,"provider":input.provider,"warnings":warnings}))
}

pub async fn create(config: &AppConfig, input: CreateInput) -> Result<Value, String> {
    let input = validate_input(input)?;
    let _update_guard = keyword::lock_for_update()
        .map_err(|_| "키워드 탐색 또는 업데이트 작업이 끝난 뒤 영상 기획을 생성하세요.")?;
    let _video_guard = media::lock_for_video_activity()?;
    let request = ai::VideoIdeaRequest {
        topic: &input.topic,
        category: &input.category,
        format: &input.format,
        language: &input.language,
        scene_count: input.scene_count,
        duration_sec: input.duration_sec,
    };
    let generated = ai::generate_video_idea(config, &input.provider, &request).await;
    finish_generation(&input, generated, media::save_project)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn input() -> CreateInput {
        CreateInput {
            topic: "아침 집중 루틴".into(),
            category: "lifestyle".into(),
            format: "shorts".into(),
            provider: "opencodex".into(),
            language: None,
            scene_count: None,
            duration_sec: None,
        }
    }
    fn plan() -> Value {
        let presets = [
            "kinetic-title",
            "stagger-rise",
            "slide-reveal",
            "focus-pulse",
            "parallax-pan",
        ];
        json!({"title":"아침을 시작하는 다섯 가지 방법","scenes":presets.iter().map(|preset|json!({
            "headline":"하나씩 시작해 보세요","body":"오늘 할 일을 간단하게 정리합니다.",
            "narration":"하나씩 정리하며 오늘 할 일을 시작해 보세요.","durationSec":9,
            "motion":{"preset":preset,"intensity":0.6}})).collect::<Vec<_>>()})
    }
    #[test]
    fn planner_input_rejects_unknown_fields_providers_counts_durations_and_controls() {
        let mut requests = Vec::new();
        let mut wrong = input();
        wrong.topic = " ".into();
        requests.push(wrong);
        let mut wrong = input();
        wrong.topic = "한".repeat(301);
        requests.push(wrong);
        let mut wrong = input();
        wrong.topic = "주제\u{202e}역방향".into();
        requests.push(wrong);
        let mut wrong = input();
        wrong.category = "untrusted".into();
        requests.push(wrong);
        let mut wrong = input();
        wrong.provider = "local".into();
        requests.push(wrong);
        let mut wrong = input();
        wrong.language = Some("unknown".into());
        requests.push(wrong);
        for count in [0, 2, 9] {
            let mut wrong = input();
            wrong.scene_count = Some(count);
            requests.push(wrong);
        }
        for seconds in [0.0, 17.0, 181.0, f64::NAN, f64::INFINITY, 180.0] {
            let mut wrong = input();
            wrong.duration_sec = Some(seconds);
            requests.push(wrong);
        }
        for request in requests {
            assert!(validate_input(request).is_err());
        }
        assert!(
            serde_json::from_value::<CreateInput>(json!({"topic":"주제","category":"tech",
            "format":"shorts","provider":"opencodex","systemPrompt":"do something"}))
            .is_err()
        );
        let checked = validate_input(input()).unwrap();
        assert_eq!(checked.language, "ko");
        assert_eq!(checked.scene_count, 5);
        assert_eq!(checked.duration_sec, 45.0);
    }
    #[test]
    fn planner_preserves_exact_prose_and_assigns_only_native_project_fields() {
        let input = validate_input(input()).unwrap();
        let checked = validate_plan(&plan().to_string(), &input).unwrap();
        let project = assemble_project(&input, checked);
        assert!(Uuid::parse_str(project["id"].as_str().unwrap()).is_ok());
        assert_eq!(project["template"], "adaptive-promo");
        assert_eq!(project["idea"]["reviewRequired"], true);
        assert_eq!(project["idea"]["motionSkill"], "toris-video-motion");
        assert!(project.get("research").is_none());
        for (index, scene) in project["scenes"].as_array().unwrap().iter().enumerate() {
            assert_eq!(scene["body"], plan()["scenes"][index]["body"]);
            assert_eq!(scene["narration"], plan()["scenes"][index]["narration"]);
            assert_eq!(scene["motion"]["intensity"], 0.6);
            assert_eq!(scene["mediaType"], "none");
            assert!(
                scene.get("mediaUrl").is_none()
                    && scene.get("audioPath").is_none()
                    && scene.get("sourceUrl").is_none()
            );
        }
    }
    #[test]
    fn planner_rejects_code_urls_project_authority_motion_and_unreadable_duration() {
        let input = validate_input(input()).unwrap();
        for (field, bad) in [
            ("body", "https://evil.test"),
            ("headline", "<script>run()</script>"),
            ("narration", "$(secret)"),
            ("body", "/Users/secret.wav"),
            ("body", "```rust"),
            ("body", "rm -rf /tmp/test"),
        ] {
            let mut wrong = plan();
            wrong["scenes"][0][field] = json!(bad);
            assert!(validate_plan(&wrong.to_string(), &input).is_err());
        }
        for field in ["sourceUrl", "mediaUrl", "audioPath", "systemPrompt"] {
            let mut wrong = plan();
            wrong["scenes"][0][field] = json!("unexpected");
            assert!(validate_plan(&wrong.to_string(), &input).is_err());
        }
        let mut wrong = plan();
        wrong["scenes"][0]["motion"]["preset"] = json!("run-code");
        assert!(validate_plan(&wrong.to_string(), &input).is_err());
        wrong = plan();
        wrong["scenes"][0]["motion"]["intensity"] = json!(999);
        assert!(validate_plan(&wrong.to_string(), &input).is_err());
        wrong = plan();
        wrong["scenes"][0]["narration"] = json!("가".repeat(64));
        assert!(validate_plan(&wrong.to_string(), &input).is_err());
        wrong = plan();
        wrong["scenes"][0]["durationSec"] = json!(31);
        assert!(validate_plan(&wrong.to_string(), &input).is_err());
        wrong = plan();
        wrong["scenes"][0]["durationSec"] = json!(3);
        assert!(validate_plan(&wrong.to_string(), &input).is_err());
        wrong = plan();
        wrong["scenes"].as_array_mut().unwrap().pop();
        assert!(validate_plan(&wrong.to_string(), &input).is_err());
        assert!(validate_plan(&format!("```json\n{}\n```", plan()), &input).is_err());
    }
    #[test]
    fn provider_or_validation_failure_never_calls_save_or_changes_existing_store() {
        let input = validate_input(input()).unwrap();
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("projects.json");
        let original = br#"{"projects":[{"id":"existing","unknown":"preserve"}]}"#;
        std::fs::write(&path, original).unwrap();
        for generated in [
            Err("PROVIDER_AUTH_REQUIRED: 구독 로그인을 확인하세요.".into()),
            Ok(json!({"text":"not JSON"})),
            Ok(json!({"text":plan().to_string()+" trailing prose"})),
        ] {
            let result = finish_generation(&input, generated, |project| {
                std::fs::write(&path, project.to_string()).unwrap();
                panic!("failed generation must not reach persistence")
            });
            assert!(result.is_err());
            assert_eq!(std::fs::read(&path).unwrap(), original);
        }
    }
    #[test]
    fn successful_plan_reaches_save_once_and_keeps_news_review_explicit() {
        let mut request = input();
        request.category = "news".into();
        let input = validate_input(request).unwrap();
        let mut saved = 0;
        let result = finish_generation(&input, Ok(json!({"text":plan().to_string()})), |project| {
            saved += 1;
            Ok(project)
        })
        .unwrap();
        assert_eq!(saved, 1);
        assert_eq!(result["provider"], "opencodex");
        assert_eq!(result["warnings"].as_array().unwrap().len(), 2);
        assert_eq!(result["project"]["idea"]["category"], "news");
    }
}
