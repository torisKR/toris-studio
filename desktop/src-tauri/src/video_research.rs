//! Create editable video drafts from selected, already saved research records.
//! No source media is downloaded. AI may select source excerpts, never introduce
//! new factual prose, URLs, file paths, shell commands, or project identifiers.
use crate::{ai, config::AppConfig, keyword, media, social};
use chrono::{DateTime, SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use url::{Host, Url};
use uuid::Uuid;

const DB_ERROR: &str = "선택한 자료를 로컬 DB에서 읽을 수 없습니다. DB 연결 상태를 확인하세요.";
const SOURCE_WARNING: &str =
    "수집 시점의 제목·설명을 인용한 편집 초안입니다. 원문과 영상 내용을 검토한 뒤 출력하세요.";

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PreviewInput {
    pub trend_ids: Vec<String>,
    pub keyword: Option<String>,
    pub topic: Option<String>,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreateInput {
    pub trend_ids: Vec<String>,
    pub keyword: Option<String>,
    pub topic: Option<String>,
    pub format: String,
    pub provider: Option<String>,
}

#[derive(Clone, Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ResearchSource {
    pub trend_id: String,
    pub source: String,
    pub title: String,
    pub url: String,
    pub description: String,
    pub fetched_at: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResearchPreview {
    pub sources: Vec<ResearchSource>,
    pub keyword: String,
    pub topic: String,
    pub warnings: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResearchResult {
    pub project: Value,
    pub provider: String,
    pub warnings: Vec<String>,
}

fn clean(raw: &str, limit: usize) -> String {
    raw.chars()
        .filter(|ch| {
            (!ch.is_control() || ch.is_whitespace())
                && !matches!(*ch, '\u{200b}' | '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}' | '\u{feff}')
        })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(limit)
        .collect()
}

fn optional_text(value: &Option<String>, limit: usize) -> Result<String, String> {
    let Some(value) = value else {
        return Ok(String::new());
    };
    if value.chars().count() > limit || value.chars().any(char::is_control) {
        return Err(format!(
            "영상 주제와 키워드의 길이 또는 문자를 확인하세요. 최대 {limit}자입니다."
        ));
    }
    Ok(clean(value, limit))
}

fn validate_preview(input: &PreviewInput) -> Result<(String, String), String> {
    let mut ids = HashSet::new();
    if !(1..=5).contains(&input.trend_ids.len())
        || input.trend_ids.iter().any(|id| {
            id.len() != 40 || !id.bytes().all(|ch| ch.is_ascii_hexdigit()) || !ids.insert(id)
        })
    {
        return Err("저장된 트렌드·키워드 콘텐츠를 중복 없이 1~5개 선택하세요.".into());
    }
    Ok((
        optional_text(&input.keyword, 100)?,
        optional_text(&input.topic, 300)?,
    ))
}

fn validate_create(input: &CreateInput) -> Result<PreviewInput, String> {
    if !matches!(
        input.format.as_str(),
        "shorts" | "vertical" | "youtube-landscape"
    ) || !matches!(
        input.provider.as_deref().unwrap_or("local"),
        "local" | "opencodex" | "teamclaude" | "claude-cli"
    ) {
        return Err("영상 형식 또는 AI 제공자를 확인하세요.".into());
    }
    let preview = PreviewInput {
        trend_ids: input.trend_ids.clone(),
        keyword: input.keyword.clone(),
        topic: input.topic.clone(),
    };
    validate_preview(&preview)?;
    Ok(preview)
}

fn valid_source(source: &ResearchSource) -> bool {
    if source.title.is_empty()
        || !matches!(
            source.source.as_str(),
            "youtube" | "naver_blog" | "google_trends"
        )
    {
        return false;
    }
    let Ok(url) = Url::parse(&source.url) else {
        return false;
    };
    url.scheme() == "https"
        && matches!(url.host(), Some(Host::Domain(host)) if host.contains('.') && host != "localhost" && !host.ends_with(".localhost") && !host.ends_with(".local"))
        && url.username().is_empty()
        && url.password().is_none()
        && url.port().is_none()
        && !url.query_pairs().any(|(key, _)| {
            matches!(
                key.to_ascii_lowercase().as_str(),
                "access_token"
                    | "refresh_token"
                    | "api_key"
                    | "apikey"
                    | "secret"
                    | "client_secret"
                    | "password"
                    | "cookie"
                    | "authorization"
            )
        })
}

async fn load_sources(config: &AppConfig, ids: &[String]) -> Result<Vec<ResearchSource>, String> {
    let db = social::database(config).await?;
    // Never accept titles, excerpts, source links, or a filesystem destination
    // supplied by a renderer. This bounded parameterized query uses saved IDs.
    let rows = db.client.query(
        "SELECT id,source,left(title,600) AS title,left(url,2048) AS url,left(coalesce(details->>'description',''),1200) AS description,fetched_at FROM social_trends WHERE id=ANY($1::text[])",
        &[&ids],
    ).await.map_err(|_| DB_ERROR)?;
    let mut records = HashMap::new();
    for row in rows {
        let fetched_at: DateTime<Utc> = row.try_get("fetched_at").map_err(|_| DB_ERROR)?;
        let source = ResearchSource {
            trend_id: row.try_get("id").map_err(|_| DB_ERROR)?,
            source: row.try_get("source").map_err(|_| DB_ERROR)?,
            title: clean(
                &row.try_get::<_, String>("title").map_err(|_| DB_ERROR)?,
                300,
            ),
            url: row.try_get("url").map_err(|_| DB_ERROR)?,
            description: clean(
                &row.try_get::<_, String>("description")
                    .map_err(|_| DB_ERROR)?,
                700,
            ),
            fetched_at: fetched_at.to_rfc3339_opts(SecondsFormat::Millis, true),
        };
        if !valid_source(&source) {
            return Err("선택한 자료의 제목과 공개 원문 주소를 확인하세요.".into());
        }
        records.insert(source.trend_id.clone(), source);
    }
    ids.iter()
        .map(|id| {
            records
                .remove(id)
                .ok_or_else(|| "선택한 자료가 DB에 없습니다. 최신 목록에서 다시 선택하세요.".into())
        })
        .collect()
}

fn make_preview(
    input: &PreviewInput,
    sources: Vec<ResearchSource>,
) -> Result<ResearchPreview, String> {
    let (keyword, topic) = validate_preview(input)?;
    if sources.len() != input.trend_ids.len() || sources.iter().any(|source| !valid_source(source))
    {
        return Err("선택한 자료를 확인하세요.".into());
    }
    let topic = if topic.is_empty() {
        if keyword.is_empty() {
            clean(&sources[0].title, 70)
        } else {
            keyword.clone()
        }
    } else {
        topic
    };
    let mut warnings = vec![SOURCE_WARNING.into()];
    if sources.iter().any(|source| source.description.is_empty()) {
        warnings.push("설명이 없는 자료는 저장된 제목만 사용합니다.".into());
    }
    Ok(ResearchPreview {
        sources,
        keyword,
        topic,
        warnings,
    })
}

pub async fn preview(config: &AppConfig, input: PreviewInput) -> Result<ResearchPreview, String> {
    validate_preview(&input)?;
    let sources = load_sources(config, &input.trend_ids).await?;
    make_preview(&input, sources)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AiScene {
    source_id: String,
    headline: String,
    body: String,
    narration: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct AiScript {
    scenes: Vec<AiScene>,
}

fn source_scene(
    source: &ResearchSource,
    headline: &str,
    body: &str,
    narration: &str,
    index: usize,
) -> Value {
    let duration = (narration.chars().count() as f64 / 6.0 + 2.0)
        .clamp(5.0, 18.0)
        .ceil();
    json!({
        "id":format!("source-{}",index + 1),"eyebrow":format!("자료 {} · {}",index + 1,source.source),
        "headline":headline,"body":body,"narration":narration,"durationSec":duration,
        "sourceLabel":source.source,"sourceUrl":source.url,"mediaType":"none",
        "role":"point","layout":"social-point","researchSourceIds":[source.trend_id],
    })
}

/// Keep a contiguous source excerpt. Prefer the last complete sentence inside
/// the character budget, then a complete word; a single unbroken token still
/// uses a strict Unicode character bound. Do not append invented punctuation.
fn bounded_excerpt(raw: &str, maximum: usize) -> &str {
    let raw = raw.trim();
    let Some((cutoff, _)) = raw.char_indices().nth(maximum) else {
        return raw;
    };
    if maximum == 0 {
        return "";
    }
    let characters: Vec<(usize, char)> = raw.char_indices().collect();
    let closing = |ch: char| matches!(ch, '"' | '\'' | '”' | '’' | ')' | ']' | '」' | '』');
    let mut sentence_end = None;
    for (index, (position, character)) in characters.iter().copied().enumerate() {
        if position >= cutoff {
            break;
        }
        if !matches!(character, '.' | '!' | '?' | '…' | '。' | '！' | '？') {
            continue;
        }
        // A period inside 1.5 or example.com does not end a sentence.
        let next = characters.get(index + 1).map(|(_, character)| *character);
        if next.is_some_and(|next| !next.is_whitespace() && !closing(next)) {
            continue;
        }
        let mut end = position + character.len_utf8();
        for (position, character) in characters.iter().copied().skip(index + 1) {
            if position >= cutoff || !closing(character) {
                break;
            }
            end = position + character.len_utf8();
        }
        if end <= cutoff {
            sentence_end = Some(end);
        }
    }
    let prefix = &raw[..cutoff];
    let end = sentence_end
        .or_else(|| {
            prefix
                .rfind(char::is_whitespace)
                .filter(|position| *position > 0)
        })
        .unwrap_or(cutoff);
    raw[..end].trim_end()
}

fn local_scenes(sources: &[ResearchSource]) -> Vec<Value> {
    sources
        .iter()
        .enumerate()
        .map(|(index, source)| {
            let excerpt = if source.description.is_empty() {
                &source.title
            } else {
                &source.description
            };
            source_scene(
                source,
                bounded_excerpt(&source.title, 70),
                bounded_excerpt(excerpt, 180),
                bounded_excerpt(excerpt, 240),
                index,
            )
        })
        .collect()
}

fn checked_excerpt(value: &str, source: &ResearchSource, limit: usize, required: bool) -> bool {
    let length = value.chars().count();
    (!required || length > 0)
        && length <= limit
        && !value.chars().any(char::is_control)
        && (value.is_empty() || source.title.contains(value) || source.description.contains(value))
}

fn validate_ai_script(text: &str, sources: &[ResearchSource]) -> Result<Vec<Value>, String> {
    if text.len() > 16_000 {
        return Err("AI 결과 크기를 확인하세요.".into());
    }
    // No Markdown/code fences or trailing prose accepted; the JSON schema is the
    // whole response. Every factual string must be an exact saved-source excerpt.
    let script: AiScript =
        serde_json::from_str(text).map_err(|_| "AI가 구조화된 장면 대본을 반환하지 않았습니다.")?;
    if script.scenes.len() != sources.len() {
        return Err("AI 결과에 선택한 자료가 누락되었습니다.".into());
    }
    let mut seen = HashSet::new();
    script.scenes.into_iter().enumerate().map(|(index, scene)| {
        let source = sources.iter().find(|source| source.trend_id == scene.source_id)
            .ok_or("AI 결과에 알 수 없는 출처가 있습니다.")?;
        if !seen.insert(scene.source_id)
            || !checked_excerpt(&scene.headline, source, 70, true)
            || !checked_excerpt(&scene.body, source, 260, false)
            || !checked_excerpt(&scene.narration, source, 360, true)
        {
            return Err("AI 문장이 저장된 출처와 일치하지 않습니다. 직접 편집할 로컬 초안을 사용하세요.".into());
        }
        Ok(source_scene(source, &scene.headline, &scene.body, &scene.narration, index))
    }).collect()
}

fn ai_sources(preview: &ResearchPreview) -> Vec<ai::ResearchExcerptSource<'_>> {
    preview
        .sources
        .iter()
        .map(|source| ai::ResearchExcerptSource {
            source_id: &source.trend_id,
            title: &source.title,
            description: &source.description,
        })
        .collect()
}

fn assemble_project(
    preview: &ResearchPreview,
    format: &str,
    provider: &str,
    mut scenes: Vec<Value>,
) -> Value {
    if scenes.len() <= 4 {
        scenes.insert(0, json!({"id":"research-hook","eyebrow":"RESEARCH BRIEF","headline":clean(&preview.topic,70),
            "body":"선택한 공개 자료를 함께 살펴봅니다.","narration":"선택한 자료의 핵심 내용을 살펴보겠습니다.",
            "durationSec":5,"mediaType":"none","role":"hook","layout":"social-hook"}));
    }
    if scenes.len() < 5 {
        scenes.push(json!({"id":"research-outro","eyebrow":"NEXT STEP","headline":"원문에서 맥락을 확인하세요",
            "body":"자료별 출처를 확인하고 내 관점을 더해 편집하세요.","narration":"출처를 확인하고 여러분의 관점을 더해 보세요.",
            "durationSec":5,"mediaType":"none","role":"outro","layout":"social-cta"}));
    }
    let created = Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true);
    json!({"id":Uuid::new_v4().to_string(),"title":clean(&format!("{} · 자료 기반 영상",preview.topic),300),
        "subtitle":"저장된 자료를 바탕으로 만든 검토용 초안","format":format,"template":"reference-briefing",
        "language":"ko","scenes":scenes,"createdAt":created,"updatedAt":created,
        "research":{"version":1,"keyword":preview.keyword,"topic":preview.topic,"provider":provider,
            "createdAt":created,"sources":preview.sources,"reviewRequired":true}})
}

pub async fn create(config: &AppConfig, input: CreateInput) -> Result<ResearchResult, String> {
    let preview_input = validate_create(&input)?;
    let _update_guard = keyword::lock_for_update()
        .map_err(|_| "키워드 탐색 또는 업데이트 작업이 끝난 뒤 영상 초안을 만드세요.")?;
    let _video_guard = media::lock_for_video_activity()?;
    let sources = load_sources(config, &preview_input.trend_ids).await?;
    let preview = make_preview(&preview_input, sources)?;
    let requested_provider = input.provider.as_deref().unwrap_or("local");
    let mut provider = "local".to_string();
    let mut warnings = preview.warnings.clone();
    let mut scenes = local_scenes(&preview.sources);
    if requested_provider != "local" {
        let generated = ai::generate_research_script(
            config,
            requested_provider,
            &preview.topic,
            &ai_sources(&preview),
        )
        .await;
        match generated.and_then(|result| {
            validate_ai_script(result.get("text").and_then(Value::as_str).ok_or("AI 대본 응답을 확인하세요.")?, &preview.sources)
        }) {
            Ok(ai_scenes) => { scenes = ai_scenes; provider = requested_provider.to_owned(); }
            // Provider error text can contain server-derived content. Use a fixed
            // safe status; never copy provider responses or credentials into IPC.
            Err(_) => warnings.push("AI 대본 생성 또는 출처 검증에 실패해 로컬 초안을 저장했습니다. AI 연결·사용량을 확인하거나 원문을 직접 편집하세요.".into()),
        }
    }
    let project = assemble_project(&preview, &input.format, &provider, scenes);
    let project = media::save_project(project)?;
    Ok(ResearchResult {
        project,
        provider,
        warnings,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn source(index: usize) -> ResearchSource {
        ResearchSource {
            trend_id: format!("{index:040x}"),
            source: "youtube".into(),
            title: format!("Rust 로컬 영상 자료 {index}"),
            url: format!("https://example.com/source-{index}"),
            description: "실제로 저장된 자료의 설명입니다. 소스를 직접 확인할 수 있습니다.".into(),
            fetched_at: "2026-10-08T00:00:00Z".into(),
        }
    }
    fn input(count: usize) -> PreviewInput {
        PreviewInput {
            trend_ids: (1..=count).map(|i| source(i).trend_id).collect(),
            keyword: Some("Rust".into()),
            topic: None,
        }
    }
    #[test]
    fn input_rejects_unbounded_duplicate_unknown_provider_and_paths() {
        for count in [0, 6] {
            assert!(validate_preview(&input(count)).is_err());
        }
        let mut request = input(2);
        request.trend_ids[1] = request.trend_ids[0].clone();
        assert!(validate_preview(&request).is_err());
        request = input(1);
        request.trend_ids[0] = "../../private".into();
        assert!(validate_preview(&request).is_err());
        request = input(1);
        request.keyword = Some("x".repeat(101));
        assert!(validate_preview(&request).is_err());
        for (format, provider) in [("unknown", "local"), ("shorts", "remote-provider")] {
            assert!(validate_create(&CreateInput {
                trend_ids: input(1).trend_ids,
                keyword: None,
                topic: None,
                format: format.into(),
                provider: Some(provider.into())
            })
            .is_err());
        }
        assert!(serde_json::from_value::<CreateInput>(
            json!({"trendIds":[source(1).trend_id],"format":"shorts","outputPath":"/private/tmp"})
        )
        .is_err());
    }
    #[test]
    fn local_drafts_keep_every_selected_source_and_all_supported_formats() {
        for count in 1..=5 {
            let sources = (1..=count).map(source).collect();
            let preview = make_preview(&input(count), sources).unwrap();
            for format in ["shorts", "vertical", "youtube-landscape"] {
                let project =
                    assemble_project(&preview, format, "local", local_scenes(&preview.sources));
                let scenes = project["scenes"].as_array().unwrap();
                assert!((3..=5).contains(&scenes.len()));
                assert!(scenes
                    .iter()
                    .all(|scene| scene["mediaType"] == "none" && scene.get("mediaUrl").is_none()));
                for source in &preview.sources {
                    assert!(scenes.iter().any(|scene| scene["sourceUrl"] == source.url));
                }
                assert_eq!(
                    project["research"]["sources"].as_array().unwrap().len(),
                    count
                );
                assert_eq!(project["format"], format);
                assert!(Uuid::parse_str(project["id"].as_str().unwrap()).is_ok());
            }
        }
    }
    #[test]
    fn missing_descriptions_do_not_invent_text_or_popularity() {
        let mut saved = source(1);
        saved.description.clear();
        let preview = make_preview(&input(1), vec![saved.clone()]).unwrap();
        let scenes = local_scenes(&preview.sources);
        assert_eq!(scenes[0]["narration"], saved.title);
        assert_eq!(preview.warnings.len(), 2);
    }
    #[test]
    fn bounded_excerpts_prefer_complete_korean_sentences_then_words() {
        let text = "첫 번째 문장입니다. 두 번째 문장도 확인했습니다! 세 번째 문장은 길어서 중간에 자르면 안 됩니다.";
        let cutoff = "첫 번째 문장입니다. 두 번째 문장도 확인했습니다! 세 번째 문장은"
            .chars()
            .count();
        assert_eq!(
            bounded_excerpt(text, cutoff),
            "첫 번째 문장입니다. 두 번째 문장도 확인했습니다!"
        );
        assert_eq!(
            bounded_excerpt("첫 문장인가요? 이어지는 설명입니다", 15),
            "첫 문장인가요?"
        );
        assert_eq!(
            bounded_excerpt("확인했습니다。 다음 내용입니다", 13),
            "확인했습니다。"
        );
        assert_eq!(
            bounded_excerpt("자료를 읽고 자신의 관점을 자연스럽게 더합니다", 16),
            "자료를 읽고 자신의 관점을"
        );
        assert_eq!(
            bounded_excerpt("값은 1.5 정도이며 추가 설명이 이어집니다", 13),
            "값은 1.5 정도이며"
        );
        assert_eq!(
            bounded_excerpt("“첫 문장입니다.” 다음 설명이 이어집니다", 18),
            "“첫 문장입니다.”"
        );
    }
    #[test]
    fn local_excerpts_are_exact_source_substrings_and_unicode_bounded() {
        let no_spaces = "초".repeat(500);
        assert_eq!(bounded_excerpt(&no_spaces, 180).chars().count(), 180);
        assert!(no_spaces.starts_with(bounded_excerpt(&no_spaces, 180)));
        assert_eq!(bounded_excerpt("글", 0), "");
        let mut saved = source(1);
        saved.description = "실제 자료의 문장입니다. ".repeat(35);
        let scene = &local_scenes(&[saved.clone()])[0];
        for (field, maximum) in [("body", 180), ("narration", 240)] {
            let excerpt = scene[field].as_str().unwrap();
            assert!(excerpt.chars().count() <= maximum);
            assert!(saved.description.contains(excerpt));
            assert!(excerpt.ends_with('.'));
        }
    }
    #[test]
    fn ai_response_accepts_excerpts_but_rejects_fabrication_unknown_sources_and_authority() {
        let sources = vec![source(1), source(2)];
        let valid = json!({"scenes":sources.iter().map(|source|json!({"sourceId":source.trend_id,"headline":source.title,"body":source.description,"narration":source.description})).collect::<Vec<_>>()});
        assert_eq!(
            validate_ai_script(&valid.to_string(), &sources)
                .unwrap()
                .len(),
            2
        );
        for field in ["headline", "body", "narration"] {
            let mut wrong = valid.clone();
            wrong["scenes"][0][field] = json!("조회수 1억 달성한 대박 콘텐츠");
            assert!(validate_ai_script(&wrong.to_string(), &sources).is_err());
        }
        let mut wrong = valid.clone();
        wrong["scenes"][0]["sourceId"] = json!("unknown");
        assert!(validate_ai_script(&wrong.to_string(), &sources).is_err());
        wrong = valid.clone();
        wrong["scenes"][0]["sourceId"] = wrong["scenes"][1]["sourceId"].clone();
        assert!(validate_ai_script(&wrong.to_string(), &sources).is_err());
        wrong = valid.clone();
        wrong["scenes"][0]["audioPath"] = json!("/private/secret.wav");
        assert!(validate_ai_script(&wrong.to_string(), &sources).is_err());
        assert!(validate_ai_script(&format!("```json\n{valid}\n```"), &sources).is_err());
    }
    #[test]
    fn prompt_bounds_untrusted_material_and_plain_source_urls() {
        let sources = (1..=5)
            .map(|index| {
                let mut source = source(index);
                source.title = "제".repeat(300);
                source.description = "설".repeat(700);
                source
            })
            .collect();
        let preview = make_preview(&input(5), sources).unwrap();
        let data = serde_json::to_string(&ai_sources(&preview)).unwrap();
        assert!(data.chars().count() <= 6_000);
        assert!(!data.contains("https://"));
        let data: Value = serde_json::from_str(&data).unwrap();
        assert!(data.as_array().unwrap().iter().all(|source| {
            source.as_object().unwrap().len() == 3
                && source.get("sourceId").is_some()
                && source.get("title").is_some()
                && source.get("description").is_some()
        }));
        for url in [
            "javascript:alert(1)",
            "https://127.0.0.1/private",
            "https://user:password@example.com/source",
            "https://localhost/path",
            "https://example.com:9000/path",
        ] {
            let mut saved = source(1);
            saved.url = url.into();
            assert!(!valid_source(&saved));
        }
    }
    #[tokio::test]
    async fn video_activity_gate_rejects_a_second_job() {
        let guard = media::lock_for_video_activity().unwrap();
        assert!(media::lock_for_video_activity().is_err());
        drop(guard);
        assert!(media::lock_for_video_activity().is_ok());
    }
    #[tokio::test]
    async fn update_gate_prevents_rendering_before_any_media_or_file_access() {
        // Another keyword test may hold the global gate briefly; wait only in
        // this fixture test, never queue real IPC work behind an installation.
        let update_guard = tokio::time::timeout(std::time::Duration::from_secs(5), async {
            loop {
                if let Ok(guard) = keyword::lock_for_update() {
                    break guard;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        let rejected = media::render_project(Value::Null).await.unwrap_err();
        assert_eq!(
            rejected,
            "키워드 탐색 또는 업데이트 작업이 끝난 뒤 영상을 출력하세요."
        );
        drop(update_guard);
    }
}
