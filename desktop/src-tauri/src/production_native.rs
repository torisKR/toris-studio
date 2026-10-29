//! IPC for AI video production. Settings and storyboard edits come from the window; every
//! path, command and model run is decided in Rust. Publishing only creates a draft.
use serde_json::{json, Value};
use std::sync::Arc;
use tauri::State;

type Jobs<'a> = State<'a, Arc<crate::production::Productions>>;
type Video<'a> = State<'a, Arc<crate::video_runtime::VideoRuntime>>;
type Tts<'a> = State<'a, Arc<crate::tts_runtime::TtsRuntime>>;
type Agent<'a> = State<'a, Arc<crate::agent_runtime::AgentRuntime>>;

fn job_id(input: &Value) -> Result<String, String> {
    let id = input["jobId"].as_str().ok_or("작업 ID가 필요합니다.")?;
    uuid::Uuid::parse_str(id).map_err(|_| "작업 ID 형식 오류")?;
    Ok(id.to_owned())
}

#[tauri::command]
pub async fn production_engine_status(video: Video<'_>, tts: Tts<'_>) -> Result<Value, String> {
    let ffmpeg = crate::media::status()
        .await
        .map(|s| s["ffmpegAvailable"] == true)
        .unwrap_or(false);
    let mut status = video.status();
    status["tts"] = tts.status().await;
    status["ffmpeg"] = json!(ffmpeg);
    Ok(status)
}

#[tauri::command]
pub async fn production_engine_install(
    window: tauri::WebviewWindow,
    video: Video<'_>,
    input: Value,
) -> Result<Value, String> {
    crate::updater::authorize(&window)?;
    video.inner().install(
        input["engine"]
            .as_str()
            .unwrap_or(crate::video_runtime::DEFAULT_ENGINE),
    )
}

#[tauri::command]
pub async fn production_list() -> Result<Value, String> {
    Ok(json!({"jobs": crate::production::list_jobs(&crate::production::root()?)}))
}

/// Lets the webview's asset protocol read only this job's own media files.
fn allow_preview(app: &tauri::AppHandle, job: &Value) {
    use tauri::Manager;
    let scope = app.asset_protocol_scope();
    for file in crate::production::preview_files(job) {
        let _ = scope.allow_file(file);
    }
}

fn view(app: &tauri::AppHandle, jobs: &crate::production::Productions, job: &Value) -> Value {
    allow_preview(app, job);
    let running = job["id"]
        .as_str()
        .is_some_and(|id| jobs.running_id().as_deref() == Some(id));
    crate::production::job_view(job, running)
}

#[tauri::command]
pub async fn production_get(
    app: tauri::AppHandle,
    jobs: Jobs<'_>,
    input: Value,
) -> Result<Value, String> {
    let id = job_id(&input)?;
    let job = crate::production::read_job(&crate::production::root()?, &id)?;
    Ok(view(&app, &jobs, &job))
}

/// Plans in the agent runtime (model or labelled template) and waits for the user's approval.
#[tauri::command]
pub async fn production_create(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    jobs: Jobs<'_>,
    agent: Agent<'_>,
    input: Value,
) -> Result<Value, String> {
    crate::updater::authorize(&window)?;
    let settings = crate::production::parse_settings(&input)?;
    let mut job = crate::production::new_job(&settings);
    let id = job["id"].as_str().unwrap().to_owned();
    job["stages"]["plan"]["status"] = json!("running");
    let root = crate::production::root()?;
    crate::production::write_json(&root.join(&id).join("job.json"), &job)?;
    let shown = view(&app, &jobs, &job);
    let jobs = jobs.inner().clone();
    let agent = agent.inner().clone();
    let plan_id = id.clone();
    tauri::async_runtime::spawn(async move {
        let planned = plan(&agent, &settings).await;
        // Stock jobs fetch photo candidates for every scene before the user reviews the storyboard.
        let candidates = match (&planned, settings.visual.as_str()) {
            (Ok(storyboard), "stock") => {
                let _ = jobs
                    .update(&plan_id, |job| {
                        job["stages"]["plan"]["message"] =
                            json!("장면마다 상업적 이용 가능한 사진을 찾고 있습니다.");
                        Ok(())
                    })
                    .await;
                Some(scene_candidates(&plan_id, storyboard, &settings.aspect).await)
            }
            _ => None,
        };
        let _ = jobs.update(&plan_id, |job| {
            match planned {
                Ok(mut storyboard) => {
                    if let Some((found, notes)) = candidates {
                        // Pre-select the first photo of each scene; the user can change it in review.
                        for scene in storyboard["scenes"].as_array_mut().into_iter().flatten() {
                            let id = scene["id"].as_str().unwrap_or("").to_owned();
                            if let Some(first) = found.get(&id).and_then(|l| l.as_array()).and_then(|l| l.first()) {
                                scene["imageId"] = first["id"].clone();
                            }
                        }
                        job["candidates"] = Value::Object(found);
                        for note in notes {
                            if let Some(list) = job["errors"].as_array_mut() {
                                list.push(json!({"at": chrono::Utc::now().to_rfc3339(), "stage": "plan", "message": note, "kind": "log"}));
                            }
                        }
                    }
                    job["draft"] = storyboard;
                    job["status"] = json!("awaiting_approval");
                    job["stage"] = json!("storyboard");
                    job["stages"]["plan"]["status"] = json!("done");
                    job["stages"]["plan"]["message"] = Value::Null;
                    job["stages"]["storyboard"]["status"] = json!("running");
                }
                Err(error) => {
                    job["status"] = json!("failed");
                    job["stages"]["plan"]["status"] = json!("failed");
                    job["errors"] = json!([{"at": chrono::Utc::now().to_rfc3339(), "stage": "plan", "message": error, "kind": "error"}]);
                }
            }
            Ok(())
        }).await;
    });
    Ok(shown)
}

/// Photo candidates for each scene, searched one scene at a time (Openverse allows 20 searches a
/// minute without a key). A scene with no result keeps going and gets a drawn graphic.
async fn scene_candidates(
    job_id: &str,
    storyboard: &Value,
    aspect: &str,
) -> (serde_json::Map<String, Value>, Vec<String>) {
    let mut found = serde_json::Map::new();
    let mut notes = Vec::new();
    // Each scene's first photo is kept out of later scenes so one photo does not repeat.
    let mut taken = std::collections::HashSet::new();
    for scene in storyboard["scenes"].as_array().into_iter().flatten() {
        let id = scene["id"].as_str().unwrap_or("");
        let query = scene["search"].as_str().unwrap_or("");
        if query.is_empty() {
            continue;
        }
        match crate::production::find_candidates(job_id, id, query, aspect, &taken).await {
            Ok(list) => {
                if let Some(first) = list.first().and_then(|c| c["url"].as_str()) {
                    taken.insert(first.to_owned());
                }
                found.insert(id.to_owned(), json!(list));
            }
            Err(error) => notes.push(format!("{id} 사진 검색: {error}")),
        }
    }
    (found, notes)
}

/// Searches new photo candidates for one scene during storyboard review.
#[tauri::command]
pub async fn production_find_images(
    app: tauri::AppHandle,
    jobs: Jobs<'_>,
    input: Value,
) -> Result<Value, String> {
    let id = job_id(&input)?;
    let scene = input["sceneId"]
        .as_str()
        .ok_or("장면을 지정하세요.")?
        .to_owned();
    let query = input["query"]
        .as_str()
        .ok_or("검색어를 입력하세요.")?
        .to_owned();
    let job = crate::production::read_job(&crate::production::root()?, &id)?;
    if job["status"] != "awaiting_approval" {
        return Err("스토리보드를 확인하는 동안에만 사진을 다시 찾을 수 있습니다.".into());
    }
    let known = job["draft"]["scenes"]
        .as_array()
        .into_iter()
        .flatten()
        .any(|s| s["id"] == scene.as_str());
    if !known {
        return Err("장면을 찾을 수 없습니다.".into());
    }
    let aspect = job["settings"]["aspect"]
        .as_str()
        .unwrap_or("9:16")
        .to_owned();
    // Photos picked for the other scenes are skipped so a re-search brings something new.
    let picked: std::collections::HashSet<String> = job["draft"]["scenes"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|s| s["id"] != scene.as_str())
        .filter_map(|s| {
            let list = job["candidates"][s["id"].as_str()?].as_array()?;
            let chosen = list
                .iter()
                .find(|c| c["id"] == s["imageId"])
                .or(list.first())?;
            chosen["url"].as_str().map(str::to_owned)
        })
        .collect();
    let list = crate::production::find_candidates(&id, &scene, &query, &aspect, &picked).await?;
    let job = jobs
        .update(&id, |job| {
            if !job["candidates"].is_object() {
                job["candidates"] = json!({});
            }
            job["candidates"][scene.as_str()] = json!(list);
            Ok(())
        })
        .await?;
    Ok(view(&app, &jobs, &job))
}

async fn plan(
    agent: &Arc<crate::agent_runtime::AgentRuntime>,
    settings: &crate::production::Settings,
) -> Result<Value, String> {
    let run = agent.call("run.start", json!({"project": "", "task": settings.topic, "workflow": "video-production", "host": true,
        "input": {"topic": settings.topic, "durationSec": settings.duration_sec, "aspect": settings.aspect, "style": settings.style, "narration": settings.narration, "language": "ko",
            "visual": settings.visual}})).await?;
    let run_id = run["runId"]
        .as_str()
        .ok_or("기획 작업을 시작하지 못했습니다.")?
        .to_owned();
    for _ in 0..900 {
        let run = agent.call("run.get", json!({"runId": run_id})).await?;
        match run["phase"].as_str() {
            Some("done") => {
                let summary: Value = serde_json::from_str(run["summary"].as_str().unwrap_or(""))
                    .map_err(|_| "기획 결과 형식 오류")?;
                let mut storyboard = summary["storyboard"].clone();
                storyboard["template"] = json!(summary["template"] == true);
                storyboard["provider"] = summary["provider"].clone();
                storyboard["model"] = summary["model"].clone();
                return crate::production::validate_storyboard(&storyboard, settings);
            }
            Some("failed") | Some("cancelled") => {
                return Err(run["summary"]
                    .as_str()
                    .filter(|s| !s.is_empty())
                    .unwrap_or("기획에 실패했습니다.")
                    .chars()
                    .take(400)
                    .collect())
            }
            _ => tokio::time::sleep(std::time::Duration::from_millis(700)).await,
        }
    }
    Err("기획 시간이 초과되었습니다.".into())
}

#[tauri::command]
pub async fn production_approve(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    jobs: Jobs<'_>,
    video: Video<'_>,
    tts: Tts<'_>,
    input: Value,
) -> Result<Value, String> {
    crate::updater::authorize(&window)?;
    let id = job_id(&input)?;
    let settings =
        crate::production::read_job(&crate::production::root()?, &id)?["settings"].clone();
    if settings["visual"] != "stock" {
        video.ready(settings["engine"].as_str().unwrap_or(""))?;
    }
    let job = jobs
        .update(&id, |job| {
            if job["status"] != "awaiting_approval" && job["storyboard"].is_null() {
                return Err("스토리보드가 아직 준비되지 않았습니다.".into());
            }
            let draft = job["draft"].clone();
            let storyboard = input
                .get("storyboard")
                .cloned()
                .filter(|s| !s.is_null())
                .map(|edited| crate::production::with_plan_origin(edited, &draft))
                .unwrap_or_else(|| draft.clone());
            crate::production::apply_storyboard(job, storyboard)?;
            job["status"] = json!("running");
            job["stage"] = json!("scenes");
            Ok(())
        })
        .await?;
    jobs.inner()
        .spawn(id, video.inner().clone(), tts.inner().clone())?;
    Ok(view(&app, &jobs, &job))
}

#[tauri::command]
pub async fn production_pause(
    app: tauri::AppHandle,
    jobs: Jobs<'_>,
    input: Value,
) -> Result<Value, String> {
    let id = job_id(&input)?;
    jobs.cancel(&id);
    let job = jobs
        .update(&id, |job| {
            if job["status"] == "running" {
                job["status"] = json!("paused");
            }
            Ok(())
        })
        .await?;
    Ok(view(&app, &jobs, &job))
}

#[tauri::command]
pub async fn production_resume(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    jobs: Jobs<'_>,
    video: Video<'_>,
    tts: Tts<'_>,
    input: Value,
) -> Result<Value, String> {
    crate::updater::authorize(&window)?;
    let id = job_id(&input)?;
    let job = crate::production::read_job(&crate::production::root()?, &id)?;
    if job["storyboard"].is_null() {
        return Err("스토리보드를 먼저 승인하세요.".into());
    }
    if job["status"] == "done" {
        return Err("이미 완료된 영상입니다. 장면을 다시 만들려면 장면 재생성을 누르세요.".into());
    }
    if job["settings"]["visual"] != "stock" {
        video.ready(job["settings"]["engine"].as_str().unwrap_or(""))?;
    }
    jobs.inner()
        .spawn(id.clone(), video.inner().clone(), tts.inner().clone())?;
    production_get(app, jobs, json!({"jobId": id})).await
}

#[tauri::command]
pub async fn production_cancel(
    app: tauri::AppHandle,
    jobs: Jobs<'_>,
    input: Value,
) -> Result<Value, String> {
    let id = job_id(&input)?;
    jobs.cancel(&id);
    let job = jobs
        .update(&id, |job| {
            if job["status"] != "done" {
                job["status"] = json!("cancelled");
            }
            Ok(())
        })
        .await?;
    Ok(view(&app, &jobs, &job))
}

#[tauri::command]
pub async fn production_retry(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    jobs: Jobs<'_>,
    video: Video<'_>,
    tts: Tts<'_>,
    input: Value,
) -> Result<Value, String> {
    crate::updater::authorize(&window)?;
    let id = job_id(&input)?;
    if jobs.running_id().as_deref() == Some(id.as_str()) {
        return Err("진행 중에는 일시 중지한 뒤 다시 실행하세요.".into());
    }
    let stage = input["stage"]
        .as_str()
        .ok_or("다시 실행할 단계를 지정하세요.")?
        .to_owned();
    let scene = input["sceneId"].as_str().map(str::to_owned);
    jobs.update(&id, |job| {
        crate::production::mark_retry(job, scene.as_deref(), &stage)
    })
    .await?;
    jobs.inner()
        .spawn(id.clone(), video.inner().clone(), tts.inner().clone())?;
    production_get(app, jobs, json!({"jobId": id})).await
}

/// Edit settings (subtitles, BGM, speaker) only touch what depends on them.
#[tauri::command]
pub async fn production_update_edit(
    app: tauri::AppHandle,
    jobs: Jobs<'_>,
    input: Value,
) -> Result<Value, String> {
    let id = job_id(&input)?;
    if jobs.running_id().as_deref() == Some(id.as_str()) {
        return Err("진행 중에는 일시 중지한 뒤 바꾸세요.".into());
    }
    let edit = input["edit"].clone();
    jobs.update(&id, |job| {
        let mut settings = job["settings"].clone();
        let mut from = None::<&str>;
        for (key, stage) in [
            ("subtitleStyle", "subtitles"),
            ("bgm", "edit"),
            ("speaker", "voice"),
        ] {
            if let Some(value) = edit.get(key) {
                if settings[key] != *value {
                    settings[key] = value.clone();
                    from = Some(match (from, stage) {
                        (Some("voice"), _) | (_, "voice") => "voice",
                        (Some("subtitles"), _) | (_, "subtitles") => "subtitles",
                        _ => stage,
                    });
                }
            }
        }
        let parsed = crate::production::parse_settings(&settings)?;
        job["settings"] = serde_json::to_value(&parsed).map_err(|_| "설정 오류")?;
        match from {
            Some("voice") => {
                if let Some(board) = job["storyboard"].clone().as_object() {
                    crate::production::apply_storyboard(job, Value::Object(board.clone()))?;
                }
            }
            Some(stage) => crate::production::invalidate_from(job, stage),
            None => {}
        }
        if from.is_some() && job["status"] == "done" {
            job["status"] = json!("paused");
        }
        Ok(())
    })
    .await
    .map(|job| view(&app, &jobs, &job))
}

/// Returns the final MP4 path; the window opens it with the existing native preview command.
#[tauri::command]
pub async fn production_open_final(
    window: tauri::WebviewWindow,
    input: Value,
) -> Result<Value, String> {
    crate::updater::authorize(&window)?;
    let id = job_id(&input)?;
    let job = crate::production::read_job(&crate::production::root()?, &id)?;
    let path = job["outputs"]["final"]
        .as_str()
        .ok_or("완성 영상이 없습니다.")?;
    Ok(json!({"path": path}))
}

/// Copies the final MP4 where the user picks. The original stays in the job folder.
#[tauri::command]
pub async fn production_save_video(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    input: Value,
) -> Result<Value, String> {
    use tauri_plugin_dialog::DialogExt;
    crate::updater::authorize(&window)?;
    let id = job_id(&input)?;
    let job = crate::production::read_job(&crate::production::root()?, &id)?;
    let source = std::path::PathBuf::from(
        job["outputs"]["final"]
            .as_str()
            .ok_or("완성 영상이 없습니다.")?,
    );
    let name: String = job["storyboard"]["title"]
        .as_str()
        .unwrap_or("toris-video")
        .chars()
        .filter(|c| c.is_alphanumeric() || *c == ' ' || *c == '-')
        .take(60)
        .collect();
    let picked = tokio::task::spawn_blocking(move || {
        app.dialog()
            .file()
            .set_title("MP4 저장")
            .set_file_name(format!("{}.mp4", name.trim()))
            .add_filter("MP4 영상", &["mp4"])
            .blocking_save_file()
    })
    .await
    .map_err(|_| "저장 위치 선택 실패")?;
    let Some(target) = picked else {
        return Ok(json!({"saved": null}));
    };
    let target = target.into_path().map_err(|_| "로컬 경로를 선택하세요.")?;
    std::fs::copy(&source, &target).map_err(|_| "영상을 저장할 수 없습니다.")?;
    Ok(json!({"saved": target}))
}

/// Imports the final MP4 into the publication media store and saves an unscheduled draft.
/// Publishing still goes through the existing preflight and approval screens.
#[tauri::command]
pub async fn production_publication_draft(
    window: tauri::WebviewWindow,
    state: State<'_, Arc<crate::AppState>>,
    input: Value,
) -> Result<Value, String> {
    crate::updater::authorize(&window)?;
    let id = job_id(&input)?;
    let job = crate::production::read_job(&crate::production::root()?, &id)?;
    if job["status"] != "done" {
        return Err("영상 제작이 끝난 뒤 게시 초안을 만드세요.".into());
    }
    let source = std::path::PathBuf::from(
        job["outputs"]["final"]
            .as_str()
            .ok_or("완성 영상이 없습니다.")?,
    );
    let media = crate::publication_media::import(&source, "video").await?;
    let draft = crate::production::publication_payload(
        &job,
        media["id"].as_str().ok_or("미디어 가져오기 실패")?,
    );
    let saved = crate::publications::save(&state.config_snapshot().await, draft).await?;
    Ok(json!({"publication": saved, "media": media, "requiresApproval": true}))
}
