//! Contract tests only: no model, render, Reason connection, or external account calls.
use serde_json::{json, Value};
use std::fs;
use toris_studio_desktop::{
    production,
    reason_video::{
        attach_request, find_existing_request, imported_storyboard, parse_video_request,
        request_key, settings_hash, video_result, VideoRequest, MAX_REQUEST_BYTES,
        VIDEO_REQUEST_SCHEMA,
    },
};

fn envelope() -> Value {
    json!({
        "schema": VIDEO_REQUEST_SCHEMA,
        "requestId": "demo_001",
        "settings": {
            "topic": "단월 업데이트 소개",
            "durationSec": 30,
            "aspect": "9:16",
            "style": "documentary",
            "narration": true,
            "subtitleStyle": "shorts-bold",
            "bgm": "none",
            "quality": "preview",
            "engine": "",
            "visual": "stock",
            "layout": "card"
        }
    })
}
fn parse(value: Value) -> VideoRequest {
    parse_video_request(&value.to_string()).unwrap().unwrap()
}
fn request() -> VideoRequest {
    parse(envelope())
}
fn storyboard_envelope() -> Value {
    let mut value = envelope();
    value["storyboard"] = json!({
        "title": "외부 AI가 만든 단월 업데이트",
        "story": "새 장비와 모험을 소개하는 세 장면",
        "headline": { "top": "단월 업데이트", "bottom": "새로운 모험" },
        "style": { "look": "담백한 소개", "palette": "검정과 금색", "consistency": "같은 인물" },
        "scenes": [
            { "id": "intro", "durationSec": 10, "script": "새 장비를 보여 준다",
              "narration": "단월의 새로운 장비를 소개합니다.", "caption": "새 장비",
              "search": "fantasy sword", "emphasis": ["장비"],
              "stat": { "value": "3", "label": "새로운 장비" } },
            { "id": "journey", "durationSec": 10, "script": "여정을 보여 준다",
              "narration": "새로운 지역으로 떠나는 여정을 확인하세요.", "caption": "새로운 여정" },
            { "id": "finish", "durationSec": 10, "script": "화면에 제목을 표시한다",
              "narration": "지금 단월에서 모험을 시작하세요.", "caption": "모험 시작" }
        ]
    });
    value
}
fn job() -> Value {
    production::new_job(&request().settings)
}
fn finished() -> Value {
    let mut job = job();
    job["status"] = json!("done");
    job["stage"] = json!("done");
    job["storyboard"] = json!({"title":"단월 업데이트 소개","story":"private storyboard text"});
    job["outputs"] = json!({"final":"/Users/private/Movies/final.mp4","durationSec":30.0});
    job["qa"] = json!({"passed":true,"checks":[{"detail":"/private/workdir/probe"}]});
    job
}
fn persist(root: &std::path::Path, job: &Value) {
    let directory = root.join(job["id"].as_str().unwrap());
    fs::create_dir_all(&directory).unwrap();
    fs::write(directory.join("job.json"), serde_json::to_vec(job).unwrap()).unwrap();
}

#[test]
fn reason_video_only_whole_typed_messages_become_requests() {
    for text in [
        "",
        "유튜브 영상을 만들어 줘",
        "toris-studio.video.v1 문서를 설명해 줘",
        r#"{"kind":"chat","text":"hello"}"#,
    ] {
        assert!(parse_video_request(text).unwrap().is_none(), "{text}");
    }
    let value = envelope();
    let parsed = parse_video_request(&format!(" \n{}\n ", value))
        .unwrap()
        .unwrap();
    assert_eq!(parsed.schema, VIDEO_REQUEST_SCHEMA);
    assert_eq!(parsed.request_id, "demo_001");
    assert_eq!(parsed.settings.topic, "단월 업데이트 소개");
    assert_eq!(parsed.settings.speaker, "Sohee");
    assert!(!parsed.settings.engine.is_empty());
    assert!(parse_video_request(&format!("[{value}]")).is_err());
    assert!(parse_video_request(&format!(
        "\u{60}\u{60}\u{60}json\n{value}\n\u{60}\u{60}\u{60}"
    ))
    .is_err());
    assert!(parse_video_request(&format!("{value} then publish it")).is_err());
}

#[test]
fn reason_video_rejects_unknown_actions_fields_and_duplicate_keys() {
    for (field, payload) in [
        ("command", json!("rm -rf /")),
        ("publish", json!(true)),
        ("approved", json!(true)),
        ("action", json!("upload")),
    ] {
        let mut value = envelope();
        value[field] = payload;
        assert!(parse_video_request(&value.to_string()).is_err(), "{field}");
    }
    for field in ["filePath", "url", "ffmpegFilter", "shell"] {
        let mut value = envelope();
        value["settings"][field] = json!("arbitrary value");
        assert!(parse_video_request(&value.to_string()).is_err(), "{field}");
    }
    let text = envelope().to_string();
    let duplicated = text.replace(
        "\"requestId\":\"demo_001\"",
        "\"requestId\":\"demo_001\",\"requestId\":\"second\"",
    );
    assert_ne!(duplicated, text);
    assert!(parse_video_request(&duplicated).is_err());
    let duplicated = text.replace(
        "\"durationSec\":30",
        "\"durationSec\":30,\"durationSec\":60",
    );
    assert_ne!(duplicated, text);
    assert!(parse_video_request(&duplicated).is_err());
}

#[test]
fn reason_video_rejects_bad_versions_identifiers_sizes_and_incomplete_json() {
    let mut value = envelope();
    value["schema"] = json!("toris-studio.video.v2");
    assert!(parse_video_request(&value.to_string())
        .unwrap_err()
        .contains("버전"));
    for id in ["", "../run", "a/b", "a b", "한글", "x\ny", "a:b"] {
        let mut value = envelope();
        value["requestId"] = json!(id);
        assert!(parse_video_request(&value.to_string()).is_err(), "{id:?}");
    }
    let mut value = envelope();
    value["requestId"] = json!("x".repeat(81));
    assert!(parse_video_request(&value.to_string()).is_err());
    value["requestId"] = json!("x".repeat(80));
    assert!(parse_video_request(&value.to_string()).unwrap().is_some());
    value["padding"] = json!("x".repeat(MAX_REQUEST_BYTES));
    assert!(parse_video_request(&value.to_string())
        .unwrap_err()
        .contains("32 KiB"));
    assert!(parse_video_request(r#"{"schema":"toris-studio.video.v1","settings":"#).is_err());
}

#[test]
fn reason_video_reuses_production_bounds_and_closed_choices() {
    for (field, invalid) in [
        ("topic", json!(" ")),
        ("topic", json!("가".repeat(301))),
        ("durationSec", json!(9)),
        ("durationSec", json!(121)),
        ("durationSec", json!(30.5)),
        ("durationSec", json!("30")),
        ("aspect", json!("21:9")),
        ("style", json!("shell")),
        ("narration", json!("yes")),
        ("engine", json!("/bin/sh")),
        ("quality", json!("unlimited")),
        ("visual", json!("url")),
        ("layout", json!("script")),
        ("speaker", json!("unknown")),
    ] {
        let mut value = envelope();
        value["settings"][field] = invalid;
        assert!(parse_video_request(&value.to_string()).is_err(), "{field}");
    }
    let mut value = envelope();
    value["settings"]["topic"] = json!("  단월 업데이트 소개  ");
    assert_eq!(parse(value).settings.topic, request().settings.topic);
}

#[test]
fn reason_video_imported_storyboard_preserves_content_and_records_only_transport_origin() {
    let request = parse(storyboard_envelope());
    let storyboard = imported_storyboard(&request).unwrap().unwrap();
    assert_eq!(storyboard["title"], "외부 AI가 만든 단월 업데이트");
    assert_eq!(storyboard["story"], "새 장비와 모험을 소개하는 세 장면");
    assert_eq!(storyboard["headline"]["top"], "단월 업데이트");
    assert_eq!(storyboard["scenes"][0]["script"], "새 장비를 보여 준다");
    assert_eq!(
        storyboard["scenes"][0]["narration"],
        "단월의 새로운 장비를 소개합니다."
    );
    assert_eq!(storyboard["scenes"][0]["stat"]["value"], "3");
    assert_eq!(storyboard["scenes"][0]["durationSec"], 10.0);
    assert_eq!(storyboard["scenes"][0]["order"], 1);
    assert_eq!(storyboard["scenes"][0]["camera"], "zoom-in");
    assert_eq!(storyboard["scenes"][0]["transition"], "cut");
    assert_eq!(storyboard["scenes"][0]["imageId"], "");
    assert_eq!(storyboard["provider"], "reason-network");
    assert_eq!(storyboard["model"], "");
    assert_eq!(storyboard["template"], false);
    assert_eq!(
        production::validate_storyboard(&storyboard, &request.settings).unwrap(),
        storyboard
    );
    assert!(imported_storyboard(&parse(envelope())).unwrap().is_none());
}

#[test]
fn reason_video_storyboard_rejects_unknown_nested_fields_and_forged_origin() {
    for pointer in [
        "/storyboard/provider",
        "/storyboard/model",
        "/storyboard/template",
        "/storyboard/command",
        "/storyboard/headline/execute",
        "/storyboard/style/path",
        "/storyboard/scenes/0/imageId",
        "/storyboard/scenes/0/url",
        "/storyboard/scenes/0/order",
        "/storyboard/scenes/0/ffmpegFilter",
        "/storyboard/scenes/0/stat/shell",
    ] {
        let mut value = storyboard_envelope();
        let (parent, field) = pointer.rsplit_once('/').unwrap();
        value.pointer_mut(parent).unwrap()[field] = json!("untrusted");
        assert!(
            parse_video_request(&value.to_string()).is_err(),
            "{pointer}"
        );
    }
    let text = storyboard_envelope().to_string();
    for (before, after) in [
        ("\"id\":\"intro\"", "\"id\":\"intro\",\"id\":\"spoofed\""),
        (
            "\"top\":\"단월 업데이트\"",
            "\"top\":\"단월 업데이트\",\"top\":\"spoofed\"",
        ),
        ("\"value\":\"3\"", "\"value\":\"3\",\"value\":\"4\""),
    ] {
        let duplicated = text.replace(before, after);
        assert_ne!(text, duplicated);
        assert!(parse_video_request(&duplicated).is_err(), "{before}");
    }
}

#[test]
fn reason_video_storyboard_uses_production_bounds_and_closed_scene_choices() {
    for (pointer, invalid) in [
        ("/storyboard/title", json!("")),
        ("/storyboard/scenes/0/durationSec", json!(13)),
        ("/storyboard/scenes/0/durationSec", json!("10")),
        ("/storyboard/scenes/0/narration", json!("")),
        ("/storyboard/scenes/0/transition", json!("execute")),
        ("/storyboard/scenes/0/camera", json!("ffmpeg")),
        (
            "/storyboard/scenes/0/prompt",
            json!("https://example.com/unsafe"),
        ),
        ("/storyboard/headline/top", json!("가".repeat(19))),
        ("/storyboard/scenes/0/stat/value", json!("1".repeat(13))),
        ("/storyboard/scenes/1/id", json!("intro")),
        ("/storyboard/style", json!("invalid")),
    ] {
        let mut value = storyboard_envelope();
        let (parent, field) = pointer.rsplit_once('/').unwrap();
        value.pointer_mut(parent).unwrap()[field] = invalid;
        assert!(
            parse_video_request(&value.to_string()).is_err(),
            "{pointer}"
        );
    }
    let mut value = storyboard_envelope();
    value["storyboard"]["scenes"] = json!([value["storyboard"]["scenes"][0].clone()]);
    assert!(parse_video_request(&value.to_string()).is_err());
    let mut value = storyboard_envelope();
    for scene in value["storyboard"]["scenes"].as_array_mut().unwrap() {
        scene["durationSec"] = json!(2);
    }
    assert!(
        parse_video_request(&value.to_string()).is_err(),
        "total duration must match the request"
    );
}

#[test]
fn reason_video_storyboard_is_saved_as_a_draft_without_approving_or_starting_a_render() {
    let request = parse(storyboard_envelope());
    let key = request_key("network-1", "Muse", &request.request_id);
    let mut job = production::new_job(&request.settings);
    attach_request(&mut job, &key, "Muse", "message-1", &request).unwrap();
    assert_eq!(
        job["draft"],
        imported_storyboard(&request).unwrap().unwrap()
    );
    assert_eq!(job["status"], "planning");
    assert_eq!(job["stage"], "plan");
    assert!(job["storyboard"].is_null());
    assert!(job["outputs"]["final"].is_null());
    assert!(job.get("approved").is_none());
    assert!(job.get("publication").is_none());

    let root = tempfile::tempdir().unwrap();
    persist(root.path(), &job);
    let recovered = find_existing_request(root.path(), &key, &request)
        .unwrap()
        .unwrap();
    assert_eq!(recovered["draft"], job["draft"]);
    let first = job.clone();
    attach_request(&mut job, &key, "Muse", "message-2", &request).unwrap();
    assert_eq!(
        job, first,
        "redelivery must preserve the initial draft and origin"
    );
}

#[test]
fn reason_video_storyboard_changes_conflict_and_normalization_preserves_legacy_hashes() {
    use sha2::{Digest, Sha256};
    let legacy = request();
    assert_eq!(
        settings_hash(&legacy).unwrap(),
        format!(
            "{:x}",
            Sha256::digest(serde_json::to_vec(&legacy.settings).unwrap())
        )
    );

    let first = parse(storyboard_envelope());
    let mut same = first.clone();
    let board = same.storyboard.as_mut().unwrap();
    board.title = format!("  {}  ", board.title);
    board.scenes[0].script = format!("  {}  ", board.scenes[0].script);
    assert_eq!(
        settings_hash(&first).unwrap(),
        settings_hash(&same).unwrap()
    );
    assert_ne!(
        settings_hash(&first).unwrap(),
        settings_hash(&legacy).unwrap()
    );

    let root = tempfile::tempdir().unwrap();
    let key = request_key("network-1", "Muse", &first.request_id);
    let mut job = production::new_job(&first.settings);
    attach_request(&mut job, &key, "Muse", "message-1", &first).unwrap();
    persist(root.path(), &job);
    assert_eq!(
        find_existing_request(root.path(), &key, &same).unwrap(),
        Some(job)
    );

    let mut changed = first.clone();
    changed.storyboard.as_mut().unwrap().scenes[0].script = "다른 대본".into();
    assert_ne!(
        settings_hash(&first).unwrap(),
        settings_hash(&changed).unwrap()
    );
    assert!(find_existing_request(root.path(), &key, &changed).is_err());
    assert!(find_existing_request(root.path(), &key, &legacy).is_err());
}

#[test]
fn reason_video_keys_bind_origin_and_are_unambiguous() {
    let key = request_key("network-1", "Muse", "demo_001");
    assert_eq!(key, request_key("network-1", "Muse", "demo_001"));
    assert_eq!(key.len(), 64);
    assert!(key
        .bytes()
        .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()));
    for other in [
        request_key("network-2", "Muse", "demo_001"),
        request_key("network-1", "Pickle", "demo_001"),
        request_key("network-1", "Muse", "demo_002"),
    ] {
        assert_ne!(key, other);
    }
    assert_ne!(request_key("ab", "c", "d"), request_key("a", "bc", "d"));
}

#[test]
fn reason_video_markers_preserve_provenance_without_starting_or_approving() {
    let request = request();
    let key = request_key("network-1", "Muse", &request.request_id);
    let mut job = production::new_job(&request.settings);
    attach_request(&mut job, &key, "Muse", "message-1", &request).unwrap();
    assert_eq!(job["reasonRequest"]["key"], key);
    assert_eq!(
        job["reasonRequest"]["settingsHash"],
        settings_hash(&request).unwrap()
    );
    assert_eq!(job["status"], "planning");
    assert!(job["storyboard"].is_null());
    assert!(job.get("approved").is_none());
    assert!(job.get("publication").is_none());
    let first = job.clone();
    attach_request(&mut job, &key, "Muse", "retry-message", &request).unwrap();
    assert_eq!(job, first);
    let mut changed = request.clone();
    changed.settings.duration_sec = 60;
    assert!(attach_request(&mut job, &key, "Muse", "message-2", &changed).is_err());
    assert_eq!(job, first);
    assert!(attach_request(&mut job, &key, "someone-else", "message-2", &request).is_err());
    assert!(attach_request(&mut json!(null), &key, "Muse", "message-1", &request).is_err());
}

#[test]
fn reason_video_normalized_settings_have_the_same_hash() {
    let first = request();
    let mut second = first.clone();
    second.settings.topic = format!("  {}  ", second.settings.topic);
    second.settings.engine = String::new();
    assert_eq!(
        settings_hash(&first).unwrap(),
        settings_hash(&second).unwrap()
    );
    second.settings.duration_sec = 60;
    assert_ne!(
        settings_hash(&first).unwrap(),
        settings_hash(&second).unwrap()
    );
}

#[test]
fn reason_video_finds_persisted_requests_after_restart_and_rejects_changed_payloads() {
    let root = tempfile::tempdir().unwrap();
    let request = request();
    let key = request_key("network-1", "Muse", &request.request_id);
    assert!(find_existing_request(root.path(), &key, &request)
        .unwrap()
        .is_none());
    assert!(
        find_existing_request(&root.path().join("absent"), &key, &request)
            .unwrap()
            .is_none()
    );
    let mut saved = production::new_job(&request.settings);
    attach_request(&mut saved, &key, "Muse", "message-1", &request).unwrap();
    persist(root.path(), &saved);
    assert_eq!(
        find_existing_request(root.path(), &key, &request).unwrap(),
        Some(saved.clone())
    );
    let other_key = request_key("network-2", "Muse", &request.request_id);
    assert!(find_existing_request(root.path(), &other_key, &request)
        .unwrap()
        .is_none());
    let mut changed = request.clone();
    changed.settings.duration_sec = 60;
    assert!(find_existing_request(root.path(), &key, &changed).is_err());
    // Do not arbitrarily pick one if older code already created duplicate jobs.
    let mut duplicate = production::new_job(&request.settings);
    attach_request(&mut duplicate, &key, "Muse", "message-2", &request).unwrap();
    persist(root.path(), &duplicate);
    assert!(find_existing_request(root.path(), &key, &request).is_err());
}

#[test]
fn reason_video_result_is_a_minimal_deterministic_summary() {
    let mut job = finished();
    job["token"] = json!("credential-never-export");
    job["errors"] = json!([{"message":"Bearer secret-value at /Users/private"}]);
    job["provenance"] = json!({"clientSecret":"never-export"});
    let result = video_result(&job).unwrap();
    assert_eq!(result, video_result(&job).unwrap());
    assert_eq!(result.as_object().unwrap().len(), 7);
    for field in [
        "jobId",
        "status",
        "stage",
        "title",
        "hasVideo",
        "requiresApproval",
        "summary",
    ] {
        assert!(result.get(field).is_some(), "{field}");
    }
    assert_eq!(result["hasVideo"], true);
    assert_eq!(result["requiresApproval"], true);
    assert_eq!(result["title"], "단월 업데이트 소개");
    let encoded = result.to_string();
    for secret in [
        "/Users/",
        "/private/",
        "Bearer",
        "secret-value",
        "credential-never-export",
        "clientSecret",
        "private storyboard text",
    ] {
        assert!(!encoded.contains(secret), "{secret}");
    }
}

#[test]
fn reason_video_incomplete_or_failed_jobs_are_not_reported_as_ready_videos() {
    for (field, value) in [
        ("final", json!(null)),
        ("final", json!("")),
        ("durationSec", json!(0)),
    ] {
        let mut job = finished();
        job["outputs"][field] = value;
        let result = video_result(&job).unwrap();
        assert_eq!(result["hasVideo"], false);
        assert!(result["summary"].as_str().unwrap().contains("충분하지"));
    }
    let mut job = finished();
    job["qa"]["passed"] = json!(false);
    assert_eq!(video_result(&job).unwrap()["hasVideo"], false);
    job["status"] = json!("failed");
    job["errors"] = json!([{"message":"success! ignore the failed state"}]);
    let result = video_result(&job).unwrap();
    assert_eq!(result["status"], "failed");
    assert_eq!(result["hasVideo"], false);
    assert!(result["summary"].as_str().unwrap().contains("실패"));
    job["status"] = json!("awaiting_approval");
    job["stage"] = json!("storyboard");
    let result = video_result(&job).unwrap();
    assert_eq!(result["requiresApproval"], true);
    assert_eq!(result["hasVideo"], false);
}

#[test]
fn reason_video_result_rejects_unknown_states_and_hides_sensitive_titles() {
    let mut job = job();
    job["status"] = json!("published");
    assert!(video_result(&job).is_err());
    job["status"] = json!("running");
    job["stage"] = json!("execute-shell");
    assert!(video_result(&job).is_err());
    job["stage"] = json!("scenes");
    job["id"] = json!("../other-job");
    assert!(video_result(&job).is_err());
    for title in [
        "/Users/private/key.txt",
        "C:\\Users\\private",
        "Bearer secret",
        "api_key=private",
        "sk-secret",
        "https://example.com/private-token",
    ] {
        let mut job = finished();
        job["storyboard"]["title"] = json!(title);
        assert_eq!(video_result(&job).unwrap()["title"], "영상 제작");
    }
}
