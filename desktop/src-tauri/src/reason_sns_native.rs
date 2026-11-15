//! Reason Network SNS plans: native commands. Importing saves editable drafts
//! only. It never posts, never creates an executable publication job, and never
//! picks an account; the publication screen keeps its approval flow.
use crate::project_chat::HostedAssistant;
use crate::reason_network::{Message, ReasonNetwork, Receipt, Snapshot};
use crate::reason_sns::{self, ImportEdits, ImportMarker, MediaKind, ResolvedMedia, SnsRequest};
use chrono::Utc;
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::Arc;
use tauri::State;

type Network<'a> = State<'a, Arc<ReasonNetwork>>;

// Serializes marker lookup, the pending marker, the database transaction and
// the final marker, so two clicks cannot import the same plan twice.
static IMPORT_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HandoffInput {
    assistant: HostedAssistant,
    brief: String,
    platforms: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SnsMessageInput {
    message_id: String,
}

fn marker_view(marker: &ImportMarker) -> Value {
    json!({
        "state": marker.state,
        "platforms": marker.platforms,
        "contentDrafts": marker.content_ids.len(),
        "publicationDrafts": marker.publication_ids.len(),
        "mediaAttached": marker.media_attached,
        "updatedAt": marker.updated_at,
    })
}

/// Adds `sns`, `snsVia` and `snsImport` to each message of a refresh snapshot.
/// Binds first-use handoff codes in message order before classifying.
pub(crate) fn annotate(
    network: &ReasonNetwork,
    identity: Option<&str>,
    snapshot: Snapshot,
) -> Value {
    let root = network.storage().to_path_buf();
    let now = Utc::now();
    let mut order: Vec<&Message> = snapshot.messages.iter().collect();
    order.sort_by(|a, b| a.created_at.cmp(&b.created_at));
    let mut handoffs = reason_sns::load_handoffs(&root).unwrap_or_default();
    let uses: Vec<(String, String)> = order
        .iter()
        .filter_map(|m| {
            let h = handoffs
                .iter()
                .find(|h| crate::project_chat::strip_code(&m.text, &h.code).is_some())?;
            Some((h.code.clone(), m.from.clone()))
        })
        .collect();
    if reason_sns::bind_handoffs(&mut handoffs, &uses) {
        // Persist bindings; if that fails, the in-memory binding still applies now.
        let _ = reason_sns::store_bindings(&root, &uses);
    }
    let imports = reason_sns::load_imports(&root).unwrap_or_default();
    let mut value = serde_json::to_value(&snapshot).unwrap_or_else(|_| json!({}));
    if let Some(messages) = value["messages"].as_array_mut() {
        for (item, message) in messages.iter_mut().zip(&snapshot.messages) {
            let found = reason_sns::classify(
                &message.text,
                &message.from,
                message.from_name.is_some(),
                &handoffs,
                now,
            );
            let mut error = found.error;
            let mut import = Value::Null;
            if let (Some(request), Some(identity)) = (&found.request, identity) {
                let key = reason_sns::request_key(identity, &message.from, &request.request_id);
                match reason_sns::find_import(&imports, &key, request) {
                    Ok(Some(marker)) => import = marker_view(&marker),
                    Ok(None) => {}
                    Err(e) => error = Some(e),
                }
            }
            item["sns"] = serde_json::to_value(&found.request).unwrap_or(Value::Null);
            item["snsVia"] = json!(found.via.map(HostedAssistant::label));
            item["snsImport"] = import;
            if item["requestError"].is_null() {
                item["requestError"] = json!(error);
            }
        }
    }
    value
}

/// Re-reads the stored message and re-validates it; the window supplies only its ID.
async fn sns_request(
    network: &ReasonNetwork,
    message_id: &str,
) -> Result<(Message, SnsRequest, String), String> {
    let message = network.message(message_id).await?;
    let root = network.storage().to_path_buf();
    let handoffs = reason_sns::load_handoffs(&root)?;
    let found = reason_sns::classify(
        &message.text,
        &message.from,
        message.from_name.is_some(),
        &handoffs,
        Utc::now(),
    );
    if let Some(error) = found.error {
        return Err(error);
    }
    let request = found
        .request
        .ok_or("이 메시지는 Toris Studio SNS 기획 요청이 아닙니다.")?;
    if let Some(code) = found.code {
        reason_sns::store_bindings(&root, &[(code, message.from.clone())])?;
    }
    let identity = network.identity().await?;
    let key = reason_sns::request_key(&identity, &message.from, &request.request_id);
    Ok((message, request, key))
}

/// Creates a hosted-assistant handoff prompt with Studio's address and a fresh code.
/// Nothing is sent: the user pastes the prompt into Muse, OpenAI Dots or Grok Bot.
#[tauri::command]
pub async fn reason_network_sns_handoff(
    window: tauri::WebviewWindow,
    network: Network<'_>,
    input: HandoffInput,
) -> Result<Value, String> {
    crate::updater::authorize(&window)?;
    let brief = crate::reason_pipeline::plain_text(&input.brief);
    let brief = brief.trim();
    if brief.is_empty() || brief.chars().count() > reason_sns::MAX_BRIEF_CHARS {
        return Err(format!(
            "SNS 기획 요청은 1~{}자로 입력하세요.",
            reason_sns::MAX_BRIEF_CHARS
        ));
    }
    let mut platforms: Vec<String> = Vec::new();
    for raw in &input.platforms {
        if reason_sns::PLATFORMS.iter().all(|(id, _, _)| id != raw) {
            return Err("지원하지 않는 SNS 플랫폼이 포함되어 있습니다.".into());
        }
        if !platforms.contains(raw) {
            platforms.push(raw.clone());
        }
    }
    if platforms.is_empty() {
        return Err("기획할 플랫폼을 하나 이상 고르세요.".into());
    }
    let snapshot = network.refresh().await;
    let studio = snapshot
        .self_id
        .filter(|_| snapshot.state == "connected")
        .ok_or("Reason Network에 연결된 뒤에 전달문을 만들 수 있습니다. 연결·받은 요청 확인을 눌러 주세요.")?;
    let handoff = reason_sns::issue_handoff(network.storage(), input.assistant, Utc::now())?;
    let prompt =
        reason_sns::handoff_prompt(input.assistant, brief, &platforms, &studio, &handoff.code);
    Ok(json!({
        "code": handoff.code,
        "assistant": input.assistant.label(),
        "prompt": prompt,
    }))
}

async fn resolve_media(request: &SnsRequest, attach: bool) -> Result<ResolvedMedia, String> {
    let Some(media) = request.media.clone().filter(|_| attach) else {
        return Ok(ResolvedMedia::default());
    };
    match media.kind {
        MediaKind::VideoJob => {
            let job = tokio::task::spawn_blocking(move || {
                crate::production::read_job(&crate::production::root()?, &media.id)
            })
            .await
            .map_err(|_| "영상 작업을 확인하지 못했습니다.")?
            .map_err(|_| "기획이 가리키는 영상 작업을 찾지 못했습니다. 미디어 없이 가져오세요.")?;
            if job["status"] != "done" {
                return Err("기획이 가리키는 영상 작업이 아직 끝나지 않았습니다. 미디어 없이 가져오거나 제작을 마친 뒤 다시 가져오세요.".into());
            }
            let source = std::path::PathBuf::from(
                job["outputs"]["final"]
                    .as_str()
                    .ok_or("영상 작업에 완성 영상이 없습니다.")?,
            );
            // Local copy into the publication media store (the existing production path).
            let imported = crate::publication_media::import(&source, "video").await?;
            Ok(ResolvedMedia {
                video: imported["id"].as_str().map(str::to_owned),
                image: None,
            })
        }
        MediaKind::Media => {
            let id = media.id.clone();
            let meta = tokio::task::spawn_blocking(move || crate::publication_media::metadata(&id))
                .await
                .map_err(|_| "게시 미디어를 확인하지 못했습니다.")?
                .map_err(|_| {
                    "기획이 가리키는 게시 미디어를 찾지 못했습니다. 미디어 없이 가져오세요."
                })?;
            match meta["kind"].as_str() {
                Some("video") => Ok(ResolvedMedia {
                    video: Some(media.id),
                    image: None,
                }),
                Some("thumbnail") => Ok(ResolvedMedia {
                    video: None,
                    image: Some(media.id),
                }),
                _ => Err("게시 미디어 종류를 확인하지 못했습니다.".into()),
            }
        }
    }
}

/// Saves the reviewed posts as SNS content drafts and publication drafts in one
/// database transaction. Repeating it returns the earlier import.
#[tauri::command]
pub async fn reason_network_import_sns(
    window: tauri::WebviewWindow,
    state: State<'_, Arc<crate::AppState>>,
    updates: State<'_, Arc<crate::updater::UpdateController>>,
    network: Network<'_>,
    input: ImportEdits,
) -> Result<Value, String> {
    crate::updater::authorize(&window)?;
    if updates.installing() {
        return Err("업데이트 설치가 끝난 뒤 가져오세요.".into());
    }
    let _import = IMPORT_LOCK.lock().await;
    let (message, request, key) = sns_request(&network, &input.message_id).await?;
    let now = Utc::now();
    let (title, posts, schedule) = reason_sns::validate_edits(&request, &input, now)?;
    let root = network.storage().to_path_buf();
    let config = state.config_snapshot().await;
    if let Some(marker) =
        reason_sns::find_import(&reason_sns::load_imports(&root)?, &key, &request)?
    {
        if marker.state == "imported" {
            return Ok(json!({"reused": true, "import": marker_view(&marker)}));
        }
        // An interrupted import: committed if its first draft exists.
        let committed = match marker.publication_ids.first() {
            Some(id) => crate::publications::exists(&config, id).await?,
            None => false,
        };
        if committed {
            let done = ImportMarker {
                state: "imported".into(),
                updated_at: now.to_rfc3339(),
                ..marker
            };
            reason_sns::put_import(&root, done.clone())?;
            return Ok(json!({"reused": true, "import": marker_view(&done)}));
        }
        reason_sns::remove_import(&root, &key)?;
    }
    let media = resolve_media(&request, input.attach_media).await?;
    let plan = reason_sns::plan_drafts(&title, &posts, schedule, &media);
    let mut marker = ImportMarker {
        key: key.clone(),
        request_id: request.request_id.clone(),
        from: message.from.clone(),
        message_id: message.id.clone(),
        content_hash: reason_sns::content_hash(&request)?,
        state: "pending".into(),
        platforms: plan.platforms.clone(),
        content_ids: Vec::new(),
        publication_ids: plan
            .publications
            .iter()
            .map(|(id, _)| id.to_string())
            .collect(),
        media_attached: media.video.is_some() || media.image.is_some(),
        updated_at: now.to_rfc3339(),
    };
    reason_sns::put_import(&root, marker.clone())?;
    let saved = async {
        let _guard = crate::publications::lock_for_update()?;
        let mut db = crate::social::database(&config).await?;
        let tx = db
            .client
            .transaction()
            .await
            .map_err(|_| "로컬 DB 트랜잭션을 시작하지 못했습니다.".to_string())?;
        let mut content_ids = Vec::new();
        for content in &plan.contents {
            content_ids.push(crate::social::insert_content_in(&tx, content).await?);
        }
        for (id, publication) in &plan.publications {
            crate::publications::insert_draft_in(&tx, *id, publication).await?;
        }
        tx.commit()
            .await
            .map_err(|_| "SNS 초안을 로컬 DB에 저장하지 못했습니다.".to_string())?;
        Ok::<_, String>(content_ids)
    }
    .await;
    let content_ids = match saved {
        Ok(ids) => ids,
        Err(error) => {
            let _ = reason_sns::remove_import(&root, &key);
            return Err(error);
        }
    };
    marker.state = "imported".into();
    marker.content_ids = content_ids;
    marker.updated_at = Utc::now().to_rfc3339();
    // If this write fails, the pending marker is settled on the next attempt.
    let warning = reason_sns::put_import(&root, marker.clone()).err();
    Ok(json!({
        "reused": false,
        "import": marker_view(&marker),
        "warning": warning,
    }))
}

/// Replies to the original sender with the import status (platforms and counts only).
#[tauri::command]
pub async fn reason_network_send_sns_result(
    window: tauri::WebviewWindow,
    network: Network<'_>,
    input: SnsMessageInput,
) -> Result<Receipt, String> {
    crate::updater::authorize(&window)?;
    let (message, request, key) = sns_request(&network, &input.message_id).await?;
    let imports = reason_sns::load_imports(network.storage())?;
    let marker = reason_sns::find_import(&imports, &key, &request)?
        .filter(|m| m.state == "imported")
        .ok_or("먼저 이 SNS 기획을 Studio 초안으로 가져오세요.")?;
    let body = reason_sns::import_result(&request.request_id, Some(&marker)).to_string();
    // Destination and reply ID come from received metadata, never from the payload.
    network.send(&message.from, &body, Some(&message.id)).await
}
