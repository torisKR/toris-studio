//! Contract tests only: no database, Reason connection, model or external account calls.
use chrono::{Duration, TimeZone, Utc};
use serde_json::{json, Value};
use toris_studio_desktop::{
    project_chat::HostedAssistant,
    reason_sns::{
        bind_handoffs, classify, content_hash, find_import, handoff_prompt, import_result,
        issue_handoff, load_handoffs, load_imports, parse_sns_request, plan_drafts, put_import,
        remove_import, request_key, store_bindings, validate_edits, Handoff, ImportEdits,
        ImportMarker, ResolvedMedia, SnsPost, MAX_REQUEST_BYTES, SNS_REQUEST_SCHEMA,
    },
};

fn now() -> chrono::DateTime<Utc> {
    Utc.with_ymd_and_hms(2026, 5, 1, 9, 0, 0).unwrap()
}

fn envelope() -> Value {
    json!({
        "schema": SNS_REQUEST_SCHEMA,
        "requestId": "sns-demo-001",
        "title": "단월 업데이트 홍보",
        "posts": [
            {"platform": "threads", "text": "새 장비가 나왔어요.", "hashtags": ["단월", "#업데이트"]},
            {"platform": "x", "text": "단월 업데이트", "hashtags": ["단월"]},
            {"platform": "naver_blog", "title": "업데이트 정리", "text": "블로그 본문", "hashtags": []}
        ],
        "scheduleAt": "2026-06-01T19:00:00+09:00"
    })
}

fn parse(value: &Value) -> Result<Option<toris_studio_desktop::reason_sns::SnsRequest>, String> {
    parse_sns_request(&value.to_string())
}

fn handoff(code: &str, from: Option<&str>) -> Handoff {
    Handoff {
        code: code.into(),
        assistant: HostedAssistant::Muse,
        created_at: now().to_rfc3339(),
        from: from.map(str::to_owned),
    }
}

#[test]
fn valid_requests_are_normalized() {
    let request = parse(&envelope()).unwrap().unwrap();
    assert_eq!(request.posts.len(), 3);
    // `#` is stripped: the publication module stores tags without it.
    assert_eq!(request.posts[0].hashtags, vec!["단월", "업데이트"]);
    assert_eq!(request.posts[2].title.as_deref(), Some("업데이트 정리"));
    assert_eq!(
        request.schedule_at.as_deref(),
        Some("2026-06-01T19:00:00+09:00")
    );
}

#[test]
fn ordinary_chat_and_other_schemas_are_not_requests() {
    assert_eq!(
        parse_sns_request("안녕하세요, 기획 보냈어요").unwrap(),
        None
    );
    assert_eq!(
        parse_sns_request(r#"{"schema":"toris-studio.video.v1"}"#).unwrap(),
        None
    );
    assert!(parse_sns_request(r#"{"schema":"toris-studio.sns.v2"}"#).is_err());
    assert!(parse_sns_request(&format!("```json\n{}\n```", envelope())).is_err());
}

#[test]
fn strict_fields_and_limits_are_enforced() {
    let mut cases = Vec::new();
    let mut v = envelope();
    v["posts"][0]["command"] = json!("publish");
    cases.push(v);
    let mut v = envelope();
    v["approved"] = json!(true);
    cases.push(v);
    let mut v = envelope();
    v["posts"][0]["platform"] = json!("linkedin");
    cases.push(v);
    let mut v = envelope();
    v["posts"][1]["text"] = json!("가".repeat(279));
    cases.push(v); // 279 + "#단월" (4) > 280
    let mut v = envelope();
    v["posts"][0]["hashtags"] = json!(["띄어 쓰기"]);
    cases.push(v);
    let mut v = envelope();
    v["posts"][0]["hashtags"] = json!(["단월", "단월"]);
    cases.push(v);
    let mut v = envelope();
    v["posts"][1]["platform"] = json!("threads");
    cases.push(v); // duplicate platform
    let mut v = envelope();
    v["posts"] = json!([]);
    cases.push(v);
    let mut v = envelope();
    v["requestId"] = json!("../etc");
    cases.push(v);
    let mut v = envelope();
    v["scheduleAt"] = json!("내일 저녁");
    cases.push(v);
    let mut v = envelope();
    v["media"] = json!({"kind": "url", "id": "https://example.com/a.mp4"});
    cases.push(v);
    let mut v = envelope();
    v["media"] = json!({"kind": "videoJob", "id": "/tmp/a.mp4"});
    cases.push(v);
    for case in cases {
        assert!(parse(&case).is_err(), "accepted: {case}");
    }
    let duplicate = envelope()
        .to_string()
        .replacen("\"title\":", "\"title\":\"a\",\"title\":", 1);
    assert!(parse_sns_request(&duplicate).is_err());
    let huge = json!({"schema": SNS_REQUEST_SCHEMA, "pad": "x".repeat(MAX_REQUEST_BYTES)});
    assert!(parse(&huge).is_err());
}

#[test]
fn invisible_characters_are_removed_and_line_breaks_normalized() {
    let mut v = envelope();
    v["posts"][0]["text"] = json!("첫 줄\r\n둘째\u{200b} 줄\u{2028}셋째\u{7}");
    let request = parse(&v).unwrap().unwrap();
    assert_eq!(request.posts[0].text, "첫 줄\n둘째 줄\n셋째");
}

#[test]
fn raw_json_is_accepted_only_from_known_peers() {
    let text = envelope().to_string();
    assert!(classify(&text, "toris/peer", true, &[], now())
        .request
        .is_some());
    let stranger = classify(&text, "toris/muse", false, &[], now());
    assert!(stranger.request.is_none());
    assert!(stranger.error.is_some());
}

#[test]
fn hosted_messages_need_an_issued_code_on_the_first_line() {
    let code = "TS-0123456789";
    let handoffs = [handoff(code, None)];
    let tagged = format!("[{code}]\n{}", envelope());
    let found = classify(&tagged, "toris/muse", false, &handoffs, now());
    assert!(found.request.is_some(), "{:?}", found.error);
    assert_eq!(found.via, Some(HostedAssistant::Muse));
    // Lowercase code still matches (the project-chat rule).
    let lower = format!("[{}]\n{}", code.to_lowercase(), envelope());
    assert!(classify(&lower, "toris/muse", false, &handoffs, now())
        .request
        .is_some());
    // An unknown code is not accepted from a non-peer.
    let other = format!("[TS-FFFFFFFFFF]\n{}", envelope());
    assert!(classify(&other, "toris/muse", false, &handoffs, now())
        .request
        .is_none());
    // Code with prose instead of JSON is an error, not a request.
    let prose = format!("[{code}]\n스레드에는 이렇게 쓰세요");
    let found = classify(&prose, "toris/muse", false, &handoffs, now());
    assert!(found.request.is_none() && found.error.is_some());
}

#[test]
fn a_code_binds_to_its_first_sender_and_expires() {
    let code = "TS-ABCDEF0123";
    let mut handoffs = vec![handoff(code, None)];
    assert!(bind_handoffs(
        &mut handoffs,
        &[
            (code.into(), "toris/muse".into()),
            (code.into(), "toris/other".into())
        ]
    ));
    assert_eq!(handoffs[0].from.as_deref(), Some("toris/muse"));
    let tagged = format!("[{code}]\n{}", envelope());
    assert!(classify(&tagged, "toris/muse", false, &handoffs, now())
        .request
        .is_some());
    let stolen = classify(&tagged, "toris/other", false, &handoffs, now());
    assert!(stolen.request.is_none() && stolen.error.is_some());
    let later = now() + Duration::days(31);
    assert!(classify(&tagged, "toris/muse", false, &handoffs, later)
        .request
        .is_none());
}

#[test]
fn handoff_store_issues_unique_codes_and_persists_bindings() {
    let dir = tempfile::tempdir().unwrap();
    let a = issue_handoff(dir.path(), HostedAssistant::Dots, now()).unwrap();
    let b = issue_handoff(dir.path(), HostedAssistant::Grok, now()).unwrap();
    assert_ne!(a.code, b.code);
    assert!(a.code.starts_with("TS-") && a.code.len() == 13);
    store_bindings(dir.path(), &[(a.code.clone(), "toris/dots".into())]).unwrap();
    let stored = load_handoffs(dir.path()).unwrap();
    assert_eq!(stored.len(), 2);
    assert_eq!(stored[0].from.as_deref(), Some("toris/dots"));
    assert_eq!(stored[1].from, None);
    for _ in 0..60 {
        issue_handoff(dir.path(), HostedAssistant::Muse, now()).unwrap();
    }
    assert_eq!(load_handoffs(dir.path()).unwrap().len(), 50);
}

#[test]
fn handoff_prompt_names_studio_code_and_format() {
    let prompt = handoff_prompt(
        HostedAssistant::Grok,
        "이번 주 업데이트 홍보",
        &["threads".into(), "x".into()],
        "toris/studio@mac",
        "TS-0123456789",
    );
    assert!(prompt.contains("Grok Bot"));
    assert!(prompt.contains("`toris/studio@mac`"));
    assert!(prompt.contains("[TS-0123456789]"));
    assert!(prompt.contains(SNS_REQUEST_SCHEMA));
    assert!(prompt.contains("send_message"));
}

fn marker(key: &str, hash: &str, state: &str) -> ImportMarker {
    ImportMarker {
        key: key.into(),
        request_id: "sns-demo-001".into(),
        from: "toris/peer".into(),
        message_id: "m1".into(),
        content_hash: hash.into(),
        state: state.into(),
        platforms: vec!["threads".into()],
        content_ids: vec!["c1".into()],
        publication_ids: vec!["p1".into()],
        media_attached: false,
        updated_at: now().to_rfc3339(),
    }
}

#[test]
fn import_markers_are_keyed_by_origin_and_reject_changed_content() {
    let request = parse(&envelope()).unwrap().unwrap();
    let key = request_key("studio", "toris/peer", &request.request_id);
    assert_ne!(
        key,
        request_key("studio", "toris/other", &request.request_id)
    );
    assert_ne!(
        request_key("ab", "c", "d"),
        request_key("a", "bc", "d"),
        "length-prefixed"
    );
    let dir = tempfile::tempdir().unwrap();
    put_import(
        dir.path(),
        marker(&key, &content_hash(&request).unwrap(), "imported"),
    )
    .unwrap();
    let imports = load_imports(dir.path()).unwrap();
    assert!(find_import(&imports, &key, &request).unwrap().is_some());
    let mut changed = envelope();
    changed["posts"][0]["text"] = json!("다른 내용");
    let changed = parse(&changed).unwrap().unwrap();
    assert!(find_import(&imports, &key, &changed).is_err());
    remove_import(dir.path(), &key).unwrap();
    assert!(load_imports(dir.path()).unwrap().is_empty());
}

fn edits(posts: Vec<SnsPost>, schedule: Option<&str>) -> ImportEdits {
    ImportEdits {
        message_id: "m1".into(),
        title: "편집한 제목".into(),
        posts,
        schedule_at: schedule.map(str::to_owned),
        attach_media: false,
    }
}

#[test]
fn edits_are_revalidated_and_limited_to_requested_platforms() {
    let request = parse(&envelope()).unwrap().unwrap();
    let mut posts = request.posts.clone();
    posts.truncate(1);
    posts[0].text = "고친 본문".into();
    let (title, posts_ok, schedule) = validate_edits(
        &request,
        &edits(posts.clone(), Some("2026-06-01T19:00:00+09:00")),
        now(),
    )
    .unwrap();
    assert_eq!(title, "편집한 제목");
    assert_eq!(posts_ok[0].text, "고친 본문");
    assert!(schedule.is_some());
    let mut added = posts.clone();
    added.push(SnsPost {
        platform: "tiktok".into(),
        title: None,
        text: "추가".into(),
        hashtags: vec![],
    });
    assert!(validate_edits(&request, &edits(added, None), now()).is_err());
    assert!(validate_edits(
        &request,
        &edits(posts.clone(), Some("2026-04-01T00:00:00Z")),
        now()
    )
    .is_err());
    assert!(validate_edits(
        &request,
        &edits(posts.clone(), Some("2028-01-01T00:00:00Z")),
        now()
    )
    .is_err());
    let mut long = posts;
    long[0].text = "가".repeat(501);
    assert!(validate_edits(&request, &edits(long, None), now()).is_err());
}

#[test]
fn drafts_never_become_executable_and_x_naver_stay_manual() {
    let request = parse(&envelope()).unwrap().unwrap();
    let at = Some(Utc.with_ymd_and_hms(2026, 6, 1, 10, 0, 0).unwrap());
    let plan = plan_drafts("홍보", &request.posts, at, &ResolvedMedia::default());
    assert_eq!(plan.contents.len(), 3);
    for content in &plan.contents {
        assert_eq!(content["status"], "draft");
        assert!(content["channelId"].is_null());
    }
    assert!(plan.contents[0]["body"]
        .as_str()
        .unwrap()
        .ends_with("#단월 #업데이트"));
    // threads + x share a text draft; naver_blog becomes an article draft.
    assert_eq!(plan.publications.len(), 2);
    let (_, text) = &plan.publications[0];
    assert_eq!(text["contentKind"], "text");
    let targets = text["targets"].as_array().unwrap();
    assert_eq!(targets[0]["platform"], "threads");
    assert_eq!(targets[0]["mode"], "scheduled");
    assert_eq!(
        targets[0]["accountId"], "",
        "no account is chosen on import"
    );
    assert_eq!(targets[1]["platform"], "x");
    assert_eq!(targets[1]["mode"], "manual_handoff");
    assert!(targets[1]["scheduledAt"].is_null());
    let (_, article) = &plan.publications[1];
    assert_eq!(article["contentKind"], "article");
    assert_eq!(article["targets"][0]["mode"], "manual_handoff");
    assert_eq!(article["targets"][0]["overrides"]["title"], "업데이트 정리");
    for (_, publication) in &plan.publications {
        assert!(publication.get("jobs").is_none());
        assert!(publication.get("approved").is_none());
    }
}

#[test]
fn video_platforms_or_attached_video_make_a_video_draft() {
    let posts = vec![
        SnsPost {
            platform: "instagram".into(),
            title: None,
            text: "릴스".into(),
            hashtags: vec![],
        },
        SnsPost {
            platform: "threads".into(),
            title: None,
            text: "글".into(),
            hashtags: vec![],
        },
    ];
    let plan = plan_drafts("홍보", &posts, None, &ResolvedMedia::default());
    assert_eq!(plan.publications[0].1["contentKind"], "video");
    assert_eq!(plan.publications[0].1["targets"][0]["mode"], "manual");
    let media = ResolvedMedia {
        video: Some("11111111-1111-4111-8111-111111111111".into()),
        image: None,
    };
    let plan = plan_drafts("홍보", &posts[1..], None, &media);
    assert_eq!(plan.publications[0].1["contentKind"], "video");
    assert_eq!(
        plan.publications[0].1["videoMediaId"],
        "11111111-1111-4111-8111-111111111111"
    );
}

#[test]
fn result_reply_reports_counts_not_local_ids() {
    let imported = marker("k", "h", "imported");
    let body = import_result("sns-demo-001", Some(&imported));
    assert_eq!(body["schema"], "toris-studio.sns-result.v1");
    assert_eq!(body["result"]["status"], "imported");
    assert_eq!(body["result"]["published"], false);
    assert_eq!(body["result"]["contentDrafts"], 1);
    let text = body.to_string();
    assert!(!text.contains("c1") && !text.contains("p1"));
    let pending = marker("k", "h", "pending");
    assert_eq!(
        import_result("x", Some(&pending))["result"]["status"],
        "not_imported"
    );
}
