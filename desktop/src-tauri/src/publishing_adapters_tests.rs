use super::*;
use std::{collections::VecDeque, sync::Mutex};

#[derive(Default)]
struct Fixture {
    replies: Mutex<VecDeque<Result<Reply, AdapterError>>>,
    requests: Mutex<Vec<Request>>,
    trace: Arc<Mutex<Vec<Value>>>,
}
impl Transport for Fixture {
    fn send(&self, request: Request, irreversible: bool) -> ResponseFuture<'_> {
        self.trace.lock().unwrap().push(json!({
            "method":request.method.as_str(),
            "path":Url::parse(&request.url).unwrap().path(),
            "irreversible":irreversible,
        }));
        self.requests.lock().unwrap().push(request);
        let response = self
            .replies
            .lock()
            .unwrap()
            .pop_front()
            .expect("unexpected external request");
        Box::pin(async move { response })
    }
}
fn reply(value: Value) -> Result<Reply, AdapterError> {
    Ok(Reply {
        status: 200,
        headers: Default::default(),
        body: value,
    })
}
fn access(scopes: &[&str], audit: bool) -> crate::oauth::PublishingAccess {
    crate::oauth::PublishingAccess {
        token: "fixture-private-token".into(),
        scopes: scopes.iter().map(|s| s.to_string()).collect(),
        tiktok_audit_declared: audit,
    }
}
fn plan(platform: &str) -> Value {
    json!({"platform":platform,"accountId":if platform=="youtube"{"UCabcdefghijklmnopqrstuv"}else{"1234"},"title":"영상 제목","description":"본문","tags":[],"hashtags":["테스트"],"mode":"manual","video":{"probe":{"durationSeconds":10,"width":1080,"height":1920,"codec":"h264"}},"options":{"privacy":if platform=="tiktok"{"SELF_ONLY"}else{"private"},"mode":"direct","madeForKids":false,"confirmPublic":true,"musicConsent":true,"publishConsent":true,"allowComments":false,"allowDuet":false,"allowStitch":false}})
}
fn text_plan(platform: &str) -> Value {
    let mut input = plan(platform);
    input["contentKind"] = json!("text");
    input["video"] = Value::Null;
    input["thumbnail"] = Value::Null;
    input
}
#[test]
fn account_capabilities_advertise_text_only_for_page_and_threads() {
    for platform in PLATFORMS {
        let public = fixture_account(platform).public;
        assert_eq!(
            public["capabilities"]["text"],
            json!(matches!(platform, "facebook" | "threads"))
        );
        assert_eq!(public["capabilities"]["video"], true);
    }
}
#[test]
fn text_content_kind_is_explicit_and_rejects_unsupported_platforms() {
    for platform in PLATFORMS {
        let mut input = plan(platform);
        for kind in [Value::Null, json!("video")] {
            input["contentKind"] = kind;
            assert!(validate_plan(&input).is_ok());
        }
        let input = text_plan(platform);
        assert_eq!(
            validate_plan(&input).is_ok(),
            matches!(platform, "facebook" | "threads"),
            "text support for {platform}"
        );
        for kind in [
            json!("article"),
            json!("TEXT"),
            json!(""),
            json!(false),
            json!(1),
        ] {
            let mut input = plan(platform);
            input["contentKind"] = kind.clone();
            assert!(
                validate_plan(&input).is_err(),
                "invalid kind {kind} for {platform}"
            );
        }
    }
}
#[test]
fn text_preflight_validates_the_final_caption_and_rejects_media() {
    for platform in ["facebook", "threads"] {
        let mut input = text_plan(platform);
        input["title"] = json!(" ");
        input["description"] = json!(" \n ");
        input["hashtags"] = json!([]);
        assert!(validate_plan(&input).is_err(), "empty {platform} caption");
        input["description"] = json!("본문");
        assert!(validate_plan(&input).is_ok());
        input["options"]["confirmPublic"] = json!(false);
        assert!(validate_plan(&input).is_err());
        input["options"]["confirmPublic"] = json!(true);
        for key in ["video", "thumbnail", "videoMediaId", "thumbnailMediaId"] {
            let mut attached = input.clone();
            attached[key] = json!({"id":"unreviewed-media"});
            assert!(validate_plan(&attached).is_err(), "text must reject {key}");
        }
        let limit = if platform == "threads" { 500 } else { 10_000 };
        input["description"] = json!("a".repeat(limit));
        assert!(validate_plan(&input).is_ok(), "exact {platform} limit");
        input["title"] = json!("x");
        assert!(
            validate_plan(&input).is_err(),
            "merged {platform} caption exceeds limit"
        );
    }
}
#[test]
fn thumbnails_and_cover_frames_are_validated_before_publication() {
    let mut youtube = plan("youtube");
    for (mime, bytes, valid) in [
        ("image/png", 3 * 1024 * 1024, true),
        ("image/jpeg", 50 * 1024 * 1024, true),
        ("image/jpeg", 50 * 1024 * 1024 + 1, false),
        ("image/webp", 100, false),
        ("image/png", 0, false),
    ] {
        youtube["thumbnail"] = json!({"mime":mime,"bytes":bytes});
        assert_eq!(validate_plan(&youtube).is_ok(), valid);
    }
    let mut instagram = plan("instagram");
    instagram["thumbnail"] = json!({"mime":"image/jpeg","bytes":8 * 1024 * 1024});
    assert!(validate_plan(&instagram).is_ok());
    for thumbnail in [
        json!({"mime":"image/png","bytes":100}),
        json!({"mime":"image/jpeg","bytes":8 * 1024 * 1024 + 1}),
    ] {
        instagram["thumbnail"] = thumbnail;
        assert!(validate_plan(&instagram).is_err());
    }
    instagram["thumbnail"] = Value::Null;
    for platform in ["instagram", "tiktok"] {
        let mut video = plan(platform);
        for offset in [
            json!(-1),
            json!(0.5),
            json!("1"),
            json!(10_000),
            json!(i32::MAX as u64 + 1),
        ] {
            video["options"]["coverOffsetMs"] = offset;
            assert!(validate_plan(&video).is_err());
        }
        for offset in [0, 9_999] {
            video["options"]["coverOffsetMs"] = json!(offset);
            assert!(validate_plan(&video).is_ok());
        }
    }
    let mut inbox = plan("tiktok");
    inbox["mode"] = json!("tiktok_inbox");
    inbox["options"]["coverOffsetMs"] = json!(-1);
    assert!(validate_plan(&inbox).is_ok());
}
#[test]
fn youtube_final_description_includes_hashtags_in_the_preflight_limit() {
    let mut video = plan("youtube");
    video["hashtags"] = json!(["tag"]);
    video["description"] = json!("a".repeat(4994));
    assert_eq!(youtube_description(&video).len(), 5000);
    assert!(validate_plan(&video).is_ok());
    video["description"] = json!("a".repeat(4995));
    assert!(validate_plan(&video).is_err());
    video["description"] = json!("");
    video["hashtags"] = json!(["<invalid>"]);
    assert!(validate_plan(&video).is_err());
}
fn fixture_account(platform: &str) -> Account {
    let mut account = account(
        platform,
        if platform == "youtube" {
            "UCabcdefghijklmnopqrstuv"
        } else {
            "1234"
        },
        "테스트 채널",
        "fixture-private-token",
    );
    if platform == "tiktok" {
        account.public["creatorInfo"] = json!({"privacyLevelOptions":["SELF_ONLY","PUBLIC_TO_EVERYONE"],"commentDisabled":false,"duetDisabled":false,"stitchDisabled":true,"maxVideoPostDurationSec":180});
    }
    account
}
fn record_checkpoint() -> (Checkpoint, Arc<Mutex<Vec<Value>>>) {
    let values = Arc::new(Mutex::new(Vec::new()));
    let clone = values.clone();
    (
        Arc::new(move |v| {
            clone.lock().unwrap().push(v);
            Box::pin(async { Ok(()) })
        }),
        values,
    )
}

fn traced_checkpoint(transport: &Fixture) -> (Checkpoint, Arc<Mutex<Vec<Value>>>) {
    let (persist, saved) = record_checkpoint();
    let trace = transport.trace.clone();
    (
        Arc::new(move |remote| {
            trace.lock().unwrap().push(json!({"checkpoint":remote}));
            persist(remote)
        }),
        saved,
    )
}
#[test]
fn provider_upload_urls_reject_confusion_redirects_and_arbitrary_hosts() {
    for (platform, url) in [
        (
            "youtube",
            "https://www.googleapis.com/upload/youtube/v3/videos?upload_id=fixture",
        ),
        (
            "instagram",
            "https://rupload.facebook.com/ig-api-upload/v25.0/123",
        ),
        (
            "facebook",
            "https://rupload.facebook.com/video-upload/v25.0/123",
        ),
        (
            "tiktok",
            "https://open-upload.tiktokapis.com/video/?upload_token=fixture",
        ),
    ] {
        assert!(trusted_upload_url(platform, url));
    }
    for url in [
        "http://rupload.facebook.com/video/123",
        "https://user:secret@rupload.facebook.com/video/123",
        "https://rupload.facebook.com.evil.test/video/123",
        "https://127.0.0.1/video/123",
        "https://open-upload.tiktokapis.com:8443/video/",
        "https://open-upload.tiktokapis.com/video/#token",
    ] {
        assert!(!trusted_upload_url("tiktok", url));
        assert!(!trusted_upload_url("facebook", url));
    }
    assert!(!trusted_upload_url(
        "youtube",
        "https://www.googleapis.com/evil"
    ));
    assert!(!trusted_upload_url(
        "tiktok",
        "https://www.googleapis.com/upload/youtube/v3/videos"
    ));
}
#[test]
fn irreversible_server_failures_never_retry_but_explicit_rejections_are_definite() {
    for code in [500, 502, 503, 504] {
        let e = response_error(code, true);
        assert!(e.uncertain);
        assert!(!e.retryable);
    }
    for code in [400, 401, 403] {
        let e = response_error(code, true);
        assert!(!e.uncertain);
        assert!(!e.retryable);
    }
    assert!(response_error(429, true).retryable);
    assert!(response_error(503, false).retryable);
}
#[test]
fn tiktok_audit_cannot_be_bypassed_by_job_option_and_interaction_choices_are_live() {
    let mut input = plan("tiktok");
    let mut account = fixture_account("tiktok");
    assert!(validate_plan(&input).is_ok());
    assert!(validate_tiktok_options(&input, &account.public).is_ok());
    input["options"]["privacy"] = json!("PUBLIC_TO_EVERYONE");
    input["options"]["directPostApproved"] = json!(true);
    assert!(validate_tiktok_options(&input, &account.public).is_err());
    account.public["capabilities"]["directPublicSupported"] = json!(true);
    assert!(validate_tiktok_options(&input, &account.public).is_ok());
    input["options"]["allowStitch"] = json!(true);
    assert!(validate_tiktok_options(&input, &account.public).is_err());
    input["options"]["allowStitch"] = json!(false);
    input["options"]["privacy"] = json!("FRIENDS_ONLY");
    assert!(validate_tiktok_options(&input, &account.public).is_err());
    input["options"]["mode"] = json!("draft");
    input["options"]["musicConsent"] = json!(false);
    assert!(validate_tiktok_options(&input, &account.public).is_ok());
}
#[test]
fn tiktok_chunk_math_includes_tail_without_a_small_final_chunk() {
    assert_eq!(tiktok_chunks(4 * 1024 * 1024), (4 * 1024 * 1024, 1));
    let length = 50 * 1024 * 1024 + 123;
    let (chunk, count) = tiktok_chunks(length);
    assert_eq!(count, 5);
    assert_eq!(length - (count - 1) * chunk, chunk + 123);
    assert_eq!(tiktok_chunks(4 * 1024 * 1024 * 1024).1, 409);
}
#[test]
fn tiktok_direct_requires_explicit_choices_for_immediate_and_scheduled_posts() {
    for mode in ["manual", "scheduled"] {
        let mut input = plan("tiktok");
        input["mode"] = json!(mode);
        assert!(validate_plan(&input).is_ok());
        assert!(validate_tiktok_options(&input, &fixture_account("tiktok").public).is_ok());
        for (key, value) in [
            ("privacy", Value::Null),
            ("musicConsent", json!(false)),
            ("publishConsent", json!(false)),
        ] {
            let mut unapproved = input.clone();
            unapproved["options"][key] = value;
            assert!(validate_plan(&unapproved).is_err(), "missing {key}: {mode}");
        }
    }
}
#[tokio::test]
async fn tiktok_direct_preserves_private_choice_and_checkpoints_before_file_upload() {
    let transport = Fixture::default();
    transport.replies.lock().unwrap().extend([
        reply(json!({"data":{"publish_id":"v_pub_file~v2.123456789","upload_url":"https://open-upload.tiktokapis.com/video/?upload_id=fixture"}})),
        reply(json!({})),
    ]);
    let mut input = plan("tiktok");
    input["mode"] = json!("scheduled");
    let (persist, saved) = traced_checkpoint(&transport);
    let output = tiktok_publish(
        &transport,
        &input,
        &fixture_account("tiktok"),
        Path::new("explicit-transport-fixture.mp4"),
        8 * 1024 * 1024,
        &persist,
    )
    .await
    .unwrap();
    assert_eq!(output["status"], "processing");
    let requests = transport.requests.lock().unwrap();
    assert_eq!(requests.len(), 2);
    assert_eq!(
        Url::parse(&requests[0].url).unwrap().path(),
        "/v2/post/publish/video/init/"
    );
    let Body::Json(body) = &requests[0].body else {
        panic!("TikTok init must be JSON");
    };
    assert_eq!(body["source_info"]["source"], "FILE_UPLOAD");
    assert_eq!(body["post_info"]["privacy_level"], "SELF_ONLY");
    assert_eq!(body["post_info"]["disable_comment"], true);
    assert_eq!(body["post_info"]["disable_duet"], true);
    assert_eq!(body["post_info"]["disable_stitch"], true);
    assert_eq!(requests[1].method, reqwest::Method::PUT);
    let trace = transport.trace.lock().unwrap();
    assert_eq!(trace[0]["method"], "POST");
    assert_eq!(trace[1]["checkpoint"]["stage"], "initialized");
    assert_eq!(trace[2]["method"], "PUT");
    assert_eq!(trace[3]["checkpoint"]["stage"], "uploaded");
    assert_eq!(saved.lock().unwrap()[0]["auditStatus"], "not_public");
}
#[tokio::test]
async fn tiktok_inbox_upload_does_not_apply_direct_post_metadata_or_claim_publication() {
    let transport = Fixture::default();
    transport.replies.lock().unwrap().extend([
        reply(json!({"data":{"publish_id":"v_inbox_file~v2.123456789","upload_url":"https://open-upload.tiktokapis.com/video/?upload_id=fixture"}})),
        reply(json!({})),
    ]);
    let mut input = plan("tiktok");
    input["mode"] = json!("tiktok_inbox");
    input["options"]["mode"] = json!("draft");
    input["options"]["privacy"] = json!("");
    let (persist, _) = record_checkpoint();
    let output = tiktok_publish(
        &transport,
        &input,
        &fixture_account("tiktok"),
        Path::new("explicit-transport-fixture.mp4"),
        8 * 1024 * 1024,
        &persist,
    )
    .await
    .unwrap();
    assert_eq!(output["status"], "processing");
    assert_eq!(output["remote"]["draft"], true);
    assert!(output["url"].is_null());
    let requests = transport.requests.lock().unwrap();
    assert_eq!(requests.len(), 2);
    assert_eq!(
        Url::parse(&requests[0].url).unwrap().path(),
        "/v2/post/publish/inbox/video/init/"
    );
    let Body::Json(body) = &requests[0].body else {
        panic!("TikTok init must be JSON");
    };
    assert!(body.get("post_info").is_none());
    assert_eq!(body["source_info"]["source"], "FILE_UPLOAD");
}
#[tokio::test]
async fn tiktok_checkpoint_failure_never_uploads_video_bytes() {
    let transport = Fixture::default();
    transport.replies.lock().unwrap().push_back(reply(json!({"data":{"publish_id":"v_pub_file~v2.123456789","upload_url":"https://open-upload.tiktokapis.com/video/?upload_id=fixture"}})));
    let persist: Checkpoint =
        Arc::new(|_| Box::pin(async { Err("fixture persistence failed".into()) }));
    let error = tiktok_publish(
        &transport,
        &plan("tiktok"),
        &fixture_account("tiktok"),
        Path::new("explicit-transport-fixture.mp4"),
        8 * 1024 * 1024,
        &persist,
    )
    .await
    .unwrap_err();
    assert!(!error.retryable);
    assert!(error.uncertain);
    assert_eq!(transport.requests.lock().unwrap().len(), 1);
}
#[test]
fn tiktok_inbox_sent_is_not_a_published_post() {
    let input = plan("tiktok");
    let mut remote =
        json!({"platform":"tiktok","accountId":"1234","publishId":"v_inbox~123","draft":true});
    let output = tiktok_status(
        &input,
        &remote,
        &json!({"data":{"status":"SEND_TO_USER_INBOX"}}),
    )
    .unwrap();
    assert_eq!(output["status"], "draft_sent");
    assert!(output["url"].is_null());
    assert!(output.get("postIds").is_none());
    let posted = tiktok_status(
        &input,
        &remote,
        &json!({"data":{"status":"PUBLISH_COMPLETE","publicaly_available_post_id":["876"]}}),
    )
    .unwrap();
    assert_eq!(posted["status"], "published");
    assert!(!posted["warnings"].as_array().unwrap().is_empty());
    remote["draft"] = json!(false);
    let output = tiktok_status(
        &input,
        &remote,
        &json!({"data":{"status":"PUBLISH_COMPLETE","publicaly_available_post_id":["876"]}}),
    )
    .unwrap();
    assert_eq!(output["status"], "published");
    assert!(tiktok_status(&input, &remote, &json!({"data":{"status":"FAILED"}})).is_err());
}
#[tokio::test]
async fn facebook_accounts_filter_permissions_and_never_expose_page_tokens() {
    let transport = Fixture::default();
    transport.replies.lock().unwrap().push_back(reply(json!({"data":[{"id":"1234","name":"내 Page","access_token":"page-private-token","tasks":["CREATE_CONTENT"]},{"id":"4321","name":"읽기 Page","access_token":"read-token","tasks":["ANALYZE"]}]})));
    let accounts = accounts_with(
        &transport,
        "facebook",
        &access(&["pages_manage_posts"], false),
    )
    .await
    .unwrap();
    assert_eq!(accounts.len(), 1);
    assert_eq!(accounts[0].token, "page-private-token");
    assert!(!accounts[0]
        .public
        .to_string()
        .contains("page-private-token"));
    assert!(!transport.requests.lock().unwrap()[0]
        .url
        .contains("fixture-private-token"));
}
#[tokio::test]
async fn instagram_checkpoint_precedes_upload_and_commit() {
    let transport = Fixture::default();
    transport.replies.lock().unwrap().extend([
        reply(json!({"id":"5678","uri":"https://rupload.facebook.com/ig-api-upload/v25.0/5678"})),
        reply(json!({"success":true})),
        reply(json!({"status_code":"FINISHED"})),
        reply(json!({"id":"9876"})),
        reply(json!({"permalink":"https://www.instagram.com/reel/fixture/"})),
    ]);
    let (persist, checkpoints) = record_checkpoint();
    let output = publish_with(
        &transport,
        &plan("instagram"),
        &fixture_account("instagram"),
        Path::new("fixture.mp4"),
        100,
        None,
        None,
        None,
        &persist,
    )
    .await
    .unwrap();
    assert_eq!(output["status"], "published");
    assert_eq!(output["externalId"], "9876");
    let checkpoints = checkpoints.lock().unwrap();
    assert_eq!(checkpoints[0]["stage"], "container_created");
    assert_eq!(checkpoints[2]["stage"], "commit_started");
    assert_eq!(checkpoints[3]["externalId"], "9876");
    let requests = transport.requests.lock().unwrap();
    match &requests[0].body {
        Body::Form(fields) => assert!(fields
            .iter()
            .any(|(key, value)| key == "share_to_feed" && value == "false")),
        _ => panic!("Instagram Reel must declare the reviewed sharing choice"),
    }
    assert!(requests[1].oauth_header);
    assert!(requests[3].url.ends_with("/1234/media_publish"));
}
#[tokio::test]
async fn checkpoint_failure_aborts_before_remote_bytes_and_keeps_handle() {
    let transport = Fixture::default();
    transport.replies.lock().unwrap().push_back(reply(
        json!({"id":"5678","uri":"https://rupload.facebook.com/ig-api-upload/v25.0/5678"}),
    ));
    let persist: Checkpoint = Arc::new(|_| Box::pin(async { Err("database unavailable".into()) }));
    let e = publish_with(
        &transport,
        &plan("instagram"),
        &fixture_account("instagram"),
        Path::new("fixture.mp4"),
        100,
        None,
        None,
        None,
        &persist,
    )
    .await
    .unwrap_err();
    assert!(e.uncertain);
    assert_eq!(e.remote.unwrap()["containerId"], "5678");
    assert_eq!(transport.requests.lock().unwrap().len(), 1);
}
#[tokio::test]
async fn ambiguous_meta_commit_never_reissues_publish() {
    let transport = Fixture::default();
    transport
        .replies
        .lock()
        .unwrap()
        .push_back(reply(json!({"status":"FINISHED"})));
    let (persist, _) = record_checkpoint();
    let remote = json!({"platform":"threads","accountId":"1234","containerId":"5678","stage":"commit_started"});
    let e = reconcile_with(
        &transport,
        &plan("threads"),
        &fixture_account("threads"),
        &remote,
        &persist,
    )
    .await
    .unwrap_err();
    assert!(e.uncertain);
    assert_eq!(transport.requests.lock().unwrap().len(), 1);
}
#[tokio::test]
async fn threads_text_creates_a_media_free_container_and_verifies_publication() {
    let transport = Fixture::default();
    transport.replies.lock().unwrap().extend([
        reply(json!({"id":"5678"})),
        reply(json!({"id":"5678","status":"FINISHED"})),
        reply(json!({"id":"9876"})),
        reply(json!({"id":"9876","media_type":"TEXT_POST","owner":{"id":"1234"},"permalink":"https://www.threads.net/@fixture/post/text123"})),
    ]);
    let (persist, checkpoints) = traced_checkpoint(&transport);
    let input = text_plan("threads");
    let output = publish_with(
        &transport,
        &input,
        &fixture_account("threads"),
        Path::new(""),
        0,
        None,
        None,
        None,
        &persist,
    )
    .await
    .unwrap();
    assert_eq!(output["status"], "published");
    assert_eq!(output["externalId"], "9876");
    assert_eq!(
        output["url"],
        "https://www.threads.net/@fixture/post/text123"
    );
    assert_eq!(output["thumbnailStatus"], "not_applicable");
    assert!(output["warnings"].as_array().unwrap().is_empty());
    let saved = checkpoints.lock().unwrap();
    assert_eq!(saved[0]["containerId"], "5678");
    assert_eq!(saved[0]["contentKind"], "text");
    assert_eq!(saved[1]["stage"], "commit_started");
    assert_eq!(saved[2]["externalId"], "9876");
    let trace = transport.trace.lock().unwrap();
    assert_eq!(trace.len(), 7);
    assert_eq!(trace[0]["method"], "POST");
    assert_eq!(trace[0]["irreversible"], true);
    assert_eq!(trace[1]["checkpoint"]["containerId"], "5678");
    assert_eq!(trace[2]["method"], "GET");
    assert_eq!(trace[2]["irreversible"], false);
    assert_eq!(trace[3]["checkpoint"]["stage"], "commit_started");
    assert_eq!(trace[4]["method"], "POST");
    assert_eq!(trace[4]["irreversible"], true);
    assert_eq!(trace[5]["checkpoint"]["externalId"], "9876");
    assert_eq!(trace[6]["method"], "GET");
    let requests = transport.requests.lock().unwrap();
    assert_eq!(requests.len(), 4);
    assert_eq!(requests[0].url, format!("{THREADS}/1234/threads"));
    let Body::Form(fields) = &requests[0].body else {
        panic!("Threads form");
    };
    assert_eq!(
        fields,
        &vec![
            ("media_type".into(), "TEXT".into()),
            ("text".into(), caption(&input))
        ]
    );
    assert_eq!(requests[2].url, format!("{THREADS}/1234/threads_publish"));
    let Body::Form(fields) = &requests[2].body else {
        panic!("Threads publish form");
    };
    assert_eq!(fields, &vec![("creation_id".into(), "5678".into())]);
    assert!(requests
        .iter()
        .all(|request| trusted_endpoint(&request.url)));
}
#[tokio::test]
async fn threads_text_requires_matching_remote_result_before_reporting_published() {
    for response in [
        Err(AdapterError::before("fixture read timeout")),
        reply(Value::Null),
        reply(json!({"permalink":"https://www.threads.net/@fixture/post/text123"})),
        reply(json!({"id":"wrong-post"})),
        reply(json!({"id":"9876","owner":{"id":"other-account"}})),
        reply(json!({"id":"9876","media_type":"VIDEO"})),
    ] {
        let transport = Fixture::default();
        transport.replies.lock().unwrap().push_back(response);
        let (persist, _) = record_checkpoint();
        let remote = json!({"platform":"threads","accountId":"1234","contentKind":"text","containerId":"5678","externalId":"9876","stage":"published","thumbnailStatus":"not_applicable"});
        let error = reconcile_with(
            &transport,
            &text_plan("threads"),
            &fixture_account("threads"),
            &remote,
            &persist,
        )
        .await
        .expect_err("unverified remote result cannot be published");
        assert!(error.uncertain);
        assert!(!error.retryable);
        assert_eq!(error.remote.as_ref(), Some(&remote));
        let requests = transport.requests.lock().unwrap();
        assert_eq!(requests.len(), 1);
        assert_eq!(requests[0].method, reqwest::Method::GET);
    }
}
#[tokio::test]
async fn text_reconciliation_rejects_changed_kind_and_unsafe_saved_ids_before_network() {
    for platform in ["facebook", "threads"] {
        let remote = if platform == "facebook" {
            json!({"platform":platform,"accountId":"1234","contentKind":"text","postId":"1234_5678","stage":"commit_accepted"})
        } else {
            json!({"platform":platform,"accountId":"1234","contentKind":"text","containerId":"5678","externalId":"9876","stage":"published"})
        };
        for kind in [Value::Null, json!("video"), json!("article")] {
            let transport = Fixture::default();
            transport.replies.lock().unwrap().push_back(reply(json!({"id":if platform=="facebook" {"1234_5678"} else {"9876"},"is_published":true})));
            let (persist, _) = record_checkpoint();
            let mut changed = remote.clone();
            changed["contentKind"] = kind;
            assert!(reconcile_with(
                &transport,
                &text_plan(platform),
                &fixture_account(platform),
                &changed,
                &persist
            )
            .await
            .is_err());
            assert!(transport.requests.lock().unwrap().is_empty());
        }
        for unsafe_id in ["../me", "9876?fields=access_token", "9876/feed", ""] {
            let transport = Fixture::default();
            transport
                .replies
                .lock()
                .unwrap()
                .push_back(reply(Value::Null));
            let (persist, _) = record_checkpoint();
            let mut changed = remote.clone();
            changed[if platform == "facebook" {
                "postId"
            } else {
                "externalId"
            }] = json!(unsafe_id);
            let error = reconcile_with(
                &transport,
                &text_plan(platform),
                &fixture_account(platform),
                &changed,
                &persist,
            )
            .await
            .unwrap_err();
            assert!(error.uncertain);
            assert!(!error.retryable);
            assert_eq!(error.remote.as_ref(), Some(&changed));
            assert!(transport.requests.lock().unwrap().is_empty());
        }
    }
}
#[tokio::test]
async fn threads_text_unknown_or_mismatched_container_status_stays_uncertain() {
    for value in [
        Value::Null,
        json!({"status":"UNKNOWN"}),
        json!({"id":"other","status":"IN_PROGRESS"}),
    ] {
        let transport = Fixture::default();
        transport.replies.lock().unwrap().push_back(reply(value));
        let (persist, _) = record_checkpoint();
        let remote = json!({"platform":"threads","accountId":"1234","contentKind":"text","containerId":"5678","stage":"uploaded","thumbnailStatus":"not_applicable"});
        let error = reconcile_with(
            &transport,
            &text_plan("threads"),
            &fixture_account("threads"),
            &remote,
            &persist,
        )
        .await
        .expect_err("unknown status is not confirmed processing");
        assert!(error.uncertain);
        assert!(!error.retryable);
        assert_eq!(error.remote.as_ref(), Some(&remote));
        assert_eq!(transport.requests.lock().unwrap().len(), 1);
    }
}
#[tokio::test]
async fn threads_requires_approved_public_media_url() {
    let transport = Fixture::default();
    let (persist, _) = record_checkpoint();
    let error = publish_with(
        &transport,
        &plan("threads"),
        &fixture_account("threads"),
        Path::new("fixture.mp4"),
        100,
        None,
        None,
        None,
        &persist,
    )
    .await
    .unwrap_err();
    assert!(!error.uncertain);
    assert!(transport.requests.lock().unwrap().is_empty());
}
#[tokio::test]
async fn tiktok_inbox_request_has_no_direct_caption_or_visibility() {
    let transport = Fixture::default();
    transport.replies.lock().unwrap().extend([reply(json!({"data":{"publish_id":"v_inbox~123","upload_url":"https://open-upload.tiktokapis.com/video/?upload_token=fixture"}})),reply(Value::Null)]);
    let mut input = plan("tiktok");
    input["options"]["mode"] = json!("draft");
    let (persist, _) = record_checkpoint();
    let output = publish_with(
        &transport,
        &input,
        &fixture_account("tiktok"),
        Path::new("fixture.mp4"),
        100,
        None,
        None,
        None,
        &persist,
    )
    .await
    .unwrap();
    assert_eq!(output["status"], "processing");
    let requests = transport.requests.lock().unwrap();
    assert!(requests[0].url.ends_with("/inbox/video/init/"));
    let Body::Json(ref body) = requests[0].body else {
        panic!("JSON request")
    };
    assert!(body.get("post_info").is_none());
    assert!(requests[1].token.is_none());
    assert!(!output.to_string().contains("upload_token"));
    assert!(!output.to_string().contains("fixture-private-token"));
}
#[tokio::test]
async fn text_preflight_needs_publish_scopes_before_account_lookup() {
    for (platform, required, response) in [
        (
            "facebook",
            vec![
                "pages_show_list",
                "pages_read_engagement",
                "pages_manage_posts",
            ],
            json!({"data":[{"id":"1234","name":"fixture Page","access_token":"fixture-page-token","tasks":["CREATE_CONTENT"]}]}),
        ),
        (
            "threads",
            vec!["threads_basic", "threads_content_publish"],
            json!({"id":"1234","username":"fixture"}),
        ),
    ] {
        let input = text_plan(platform);
        for missing in &required {
            let scopes = required
                .iter()
                .copied()
                .filter(|scope| scope != missing)
                .collect::<Vec<_>>();
            let transport = Fixture::default();
            transport
                .replies
                .lock()
                .unwrap()
                .push_back(reply(response.clone()));
            let error = selected_account(&transport, &input, &access(&scopes, false))
                .await
                .err()
                .expect("read-only scope must not authorize text publication");
            assert!(!error.uncertain);
            assert!(!error.retryable);
            assert!(
                transport.requests.lock().unwrap().is_empty(),
                "missing {missing}"
            );
        }
        let transport = Fixture::default();
        transport.replies.lock().unwrap().push_back(reply(response));
        let selected = selected_account(&transport, &input, &access(&required, false))
            .await
            .unwrap();
        assert_eq!(selected.public["accountId"], "1234");
        assert!(!selected.public.to_string().contains("fixture-page-token"));
    }
}
#[tokio::test]
async fn authenticated_account_change_blocks_before_publish() {
    let transport = Fixture::default();
    transport
        .replies
        .lock()
        .unwrap()
        .push_back(reply(json!({"id":"9999","username":"other-account"})));
    let error = selected_account(
        &transport,
        &plan("threads"),
        &access(&["threads_content_publish"], false),
    )
    .await
    .err()
    .unwrap();
    assert!(!error.uncertain);
    assert!(!error.retryable);
    assert_eq!(transport.requests.lock().unwrap().len(), 1);
}
#[test]
fn unsupported_fields_and_public_consent_are_explicit() {
    let mut input = plan("threads");
    input["tags"] = json!(["tag"]);
    assert_eq!(field_warnings(&input).len(), 2);
    input["options"]["confirmPublic"] = json!(false);
    assert!(validate_plan(&input).is_err());
    input = plan("youtube");
    input["options"]["privacy"] = json!("public");
    input["options"]["confirmPublic"] = json!(false);
    assert!(validate_plan(&input).is_err());
    input = plan("tiktok");
    input["options"]["musicConsent"] = json!(false);
    assert!(validate_plan(&input).is_err());
}

#[tokio::test]
async fn youtube_resumable_upload_keeps_session_url_native_and_applies_metadata_and_thumbnail() {
    let transport = Fixture::default();
    let mut headers = reqwest::header::HeaderMap::new();
    headers.insert(
        reqwest::header::LOCATION,
        "https://www.googleapis.com/upload/youtube/v3/videos?upload_id=fixture-private-session"
            .parse()
            .unwrap(),
    );
    transport.replies.lock().unwrap().extend([
        Ok(Reply { status: 200, headers, body: Value::Null }),
        reply(json!({"id":"abcdefghijk","snippet":{"channelId":"UCabcdefghijklmnopqrstuv"},"status":{"privacyStatus":"private"}})),
        reply(json!({"items":[{}]})),
    ]);
    let (persist, checkpoints) = record_checkpoint();
    let mut input = plan("youtube");
    input["tags"] = json!(["Rust", "개발"]);
    let output = publish_with(
        &transport,
        &input,
        &fixture_account("youtube"),
        Path::new("fixture.mp4"),
        100,
        Some(Path::new("cover.png")),
        None,
        None,
        &persist,
    )
    .await
    .unwrap();
    assert_eq!(output["status"], "processing");
    assert_eq!(output["thumbnailStatus"], "applied");
    assert!(!output.to_string().contains("fixture-private-session"));
    let checkpoints = checkpoints.lock().unwrap();
    assert!(checkpoints[0]["sessionHandle"].as_str().is_some());
    assert!(!serde_json::to_string(&*checkpoints)
        .unwrap()
        .contains("upload_id"));
    let requests = transport.requests.lock().unwrap();
    let Body::Json(ref body) = requests[0].body else {
        panic!("JSON metadata")
    };
    assert_eq!(body["snippet"]["tags"], json!(["Rust", "개발"]));
    assert!(body["snippet"]["description"]
        .as_str()
        .unwrap()
        .contains("#테스트"));
    assert_eq!(
        Url::parse(&requests[2].url).unwrap().path(),
        "/upload/youtube/v3/thumbnails/set"
    );
}

#[tokio::test]
async fn facebook_text_posts_message_then_verifies_the_checkpointed_post() {
    let transport = Fixture::default();
    transport.replies.lock().unwrap().extend([
        reply(json!({"id":"1234_5678"})),
        reply(json!({"id":"1234_5678","is_published":true,"permalink_url":"https://www.facebook.com/1234/posts/5678"})),
    ]);
    let (persist, checkpoints) = traced_checkpoint(&transport);
    let input = text_plan("facebook");
    let mut page = fixture_account("facebook");
    page.token = "fixture-page-token".into();
    let output = publish_with(
        &transport,
        &input,
        &page,
        Path::new(""),
        0,
        None,
        None,
        None,
        &persist,
    )
    .await
    .unwrap();
    assert_eq!(output["status"], "published");
    assert_eq!(output["externalId"], "1234_5678");
    assert_eq!(output["url"], "https://www.facebook.com/1234/posts/5678");
    assert_eq!(output["thumbnailStatus"], "not_applicable");
    assert!(!output.to_string().contains("fixture-page-token"));
    let saved = checkpoints.lock().unwrap();
    assert_eq!(saved[0]["stage"], "commit_started");
    assert_eq!(saved[1]["postId"], "1234_5678");
    assert_eq!(saved[1]["contentKind"], "text");
    let trace = transport.trace.lock().unwrap();
    assert_eq!(trace.len(), 5);
    assert_eq!(trace[0]["checkpoint"]["stage"], "commit_started");
    assert_eq!(trace[1]["method"], "POST");
    assert_eq!(trace[1]["irreversible"], true);
    assert_eq!(trace[2]["checkpoint"]["postId"], "1234_5678");
    assert_eq!(trace[3]["method"], "GET");
    assert_eq!(trace[3]["irreversible"], false);
    assert_eq!(trace[4]["checkpoint"]["stage"], "published");
    let requests = transport.requests.lock().unwrap();
    assert_eq!(requests.len(), 2);
    assert_eq!(requests[0].method, reqwest::Method::POST);
    assert_eq!(requests[0].url, format!("{META}/1234/feed"));
    assert_eq!(requests[0].token.as_deref(), Some("fixture-page-token"));
    let Body::Form(fields) = &requests[0].body else {
        panic!("Page form");
    };
    assert_eq!(
        fields,
        &vec![
            ("message".into(), caption(&input)),
            ("published".into(), "true".into())
        ]
    );
    assert_eq!(requests[1].method, reqwest::Method::GET);
    let query = Url::parse(&requests[1].url).unwrap();
    assert_eq!(query.path(), "/v25.0/1234_5678");
    assert!(query
        .query_pairs()
        .any(|(k, v)| k == "fields" && v == "id,is_published,permalink_url"));
}
#[tokio::test]
async fn text_ambiguous_creation_never_retries_or_claims_publication() {
    for platform in ["facebook", "threads"] {
        for ambiguous in [
            None,
            Some(Value::Null),
            Some(json!({"success":true})),
            Some(json!({"id":"../unsafe"})),
        ] {
            let transport = Fixture::default();
            transport
                .replies
                .lock()
                .unwrap()
                .push_back(match ambiguous {
                    None => Err(AdapterError::uncertain(None)),
                    Some(value) => reply(value),
                });
            let (persist, _) = traced_checkpoint(&transport);
            let error = publish_with(
                &transport,
                &text_plan(platform),
                &fixture_account(platform),
                Path::new(""),
                0,
                None,
                None,
                None,
                &persist,
            )
            .await
            .unwrap_err();
            assert!(error.uncertain);
            assert!(!error.retryable);
            let requests = transport.requests.lock().unwrap();
            assert_eq!(requests.len(), 1);
            assert_eq!(requests[0].method, reqwest::Method::POST);
            assert!(transport
                .trace
                .lock()
                .unwrap()
                .iter()
                .filter(|event| event.get("method").is_some())
                .all(|event| event["irreversible"] == true));
            if platform == "facebook" {
                let remote = error.remote.unwrap();
                assert_eq!(remote["stage"], "commit_started");
                assert!(remote["postId"].is_null());
            }
        }
    }
}
#[tokio::test]
async fn facebook_text_unverified_readback_recovers_by_saved_post_id_without_reposting() {
    for unverified in [
        Err(AdapterError::before("fixture read timeout")),
        reply(Value::Null),
        reply(json!({"id":"another-post","is_published":true})),
        reply(json!({"id":"1234_5678"})),
    ] {
        let transport = Fixture::default();
        transport.replies.lock().unwrap().extend([
            reply(json!({"id":"1234_5678"})), unverified,
            reply(json!({"id":"1234_5678","is_published":true,"permalink_url":"https://www.facebook.com/1234/posts/5678"})),
        ]);
        let (persist, _) = record_checkpoint();
        let input = text_plan("facebook");
        let account = fixture_account("facebook");
        let error = publish_with(
            &transport,
            &input,
            &account,
            Path::new(""),
            0,
            None,
            None,
            None,
            &persist,
        )
        .await
        .unwrap_err();
        assert!(error.uncertain);
        assert!(!error.retryable);
        let remote = error.remote.unwrap();
        assert_eq!(remote["postId"], "1234_5678");
        let output = reconcile_with(&transport, &input, &account, &remote, &persist)
            .await
            .unwrap();
        assert_eq!(output["status"], "published");
        let requests = transport.requests.lock().unwrap();
        assert_eq!(requests.len(), 3);
        assert_eq!(
            requests
                .iter()
                .filter(|request| request.method == reqwest::Method::POST)
                .count(),
            1
        );
        assert_eq!(requests[2].method, reqwest::Method::GET);
    }
}
#[tokio::test]
async fn threads_text_ambiguous_publish_never_reissues_the_commit() {
    for ambiguous in [None, Some(Value::Null), Some(json!({"success":true}))] {
        for status in ["FINISHED", "PUBLISHED"] {
            let transport = Fixture::default();
            transport.replies.lock().unwrap().extend([
                reply(json!({"id":"5678"})),
                reply(json!({"id":"5678","status":"FINISHED"})),
                match &ambiguous {
                    None => Err(AdapterError::uncertain(None)),
                    Some(value) => reply(value.clone()),
                },
                reply(json!({"id":"5678","status":status})),
            ]);
            let (persist, _) = record_checkpoint();
            let input = text_plan("threads");
            let account = fixture_account("threads");
            let error = publish_with(
                &transport,
                &input,
                &account,
                Path::new(""),
                0,
                None,
                None,
                None,
                &persist,
            )
            .await
            .unwrap_err();
            assert!(error.uncertain);
            assert!(!error.retryable);
            let remote = error.remote.unwrap();
            assert_eq!(remote["containerId"], "5678");
            assert_eq!(remote["stage"], "commit_started");
            let error = reconcile_with(&transport, &input, &account, &remote, &persist)
                .await
                .unwrap_err();
            assert!(error.uncertain);
            assert!(!error.retryable);
            assert_eq!(error.remote.as_ref(), Some(&remote));
            let requests = transport.requests.lock().unwrap();
            assert_eq!(requests.len(), 4);
            assert_eq!(
                requests
                    .iter()
                    .filter(|request| request.url.ends_with("/threads_publish"))
                    .count(),
                1
            );
            assert_eq!(requests[3].method, reqwest::Method::GET);
        }
    }
}
#[tokio::test]
async fn text_checkpoint_failures_stop_the_next_action_and_preserve_recoverable_ids() {
    for platform in ["facebook", "threads"] {
        for failed_checkpoint in 1..=3 {
            let transport = Fixture::default();
            let verified = if platform == "facebook" {
                transport
                    .replies
                    .lock()
                    .unwrap()
                    .push_back(reply(json!({"id":"1234_5678"})));
                json!({"id":"1234_5678","is_published":true})
            } else {
                transport.replies.lock().unwrap().extend([
                    reply(json!({"id":"5678"})),
                    reply(json!({"id":"5678","status":"FINISHED"})),
                    reply(json!({"id":"9876"})),
                ]);
                json!({"id":"9876","media_type":"TEXT_POST","owner":{"id":"1234"}})
            };
            transport
                .replies
                .lock()
                .unwrap()
                .push_back(reply(verified.clone()));
            let saved = Arc::new(Mutex::new(Vec::<Value>::new()));
            let capture = saved.clone();
            let persist: Checkpoint = Arc::new(move |remote| {
                let mut saved = capture.lock().unwrap();
                saved.push(remote);
                let fail = saved.len() == failed_checkpoint;
                Box::pin(async move {
                    if fail {
                        Err("fixture database failure".into())
                    } else {
                        Ok(())
                    }
                })
            });
            let input = text_plan(platform);
            let account = fixture_account(platform);
            let error = publish_with(
                &transport,
                &input,
                &account,
                Path::new(""),
                0,
                None,
                None,
                None,
                &persist,
            )
            .await
            .unwrap_err();
            assert!(error.uncertain);
            assert!(!error.retryable);
            let remote = error.remote.unwrap();
            assert_eq!(Some(&remote), saved.lock().unwrap().last());
            assert_eq!(
                transport.requests.lock().unwrap().len(),
                if platform == "facebook" {
                    failed_checkpoint - 1
                } else {
                    failed_checkpoint
                }
            );
            if !remote[if platform == "facebook" {
                "postId"
            } else {
                "externalId"
            }]
            .is_null()
            {
                let recovery = Fixture::default();
                recovery.replies.lock().unwrap().push_back(reply(verified));
                let (persist, _) = record_checkpoint();
                let output = reconcile_with(&recovery, &input, &account, &remote, &persist)
                    .await
                    .unwrap();
                assert_eq!(output["status"], "published");
                let requests = recovery.requests.lock().unwrap();
                assert_eq!(requests.len(), 1);
                assert_eq!(requests[0].method, reqwest::Method::GET);
            }
        }
    }
}
#[tokio::test]
async fn text_receipts_never_return_untrusted_permalinks() {
    for (platform, remote, verified) in [
        (
            "facebook",
            json!({"platform":"facebook","accountId":"1234","contentKind":"text","postId":"1234_5678","stage":"commit_accepted"}),
            json!({"id":"1234_5678","is_published":true,"permalink_url":"https://evil.test/steal"}),
        ),
        (
            "threads",
            json!({"platform":"threads","accountId":"1234","contentKind":"text","containerId":"5678","externalId":"9876","stage":"published"}),
            json!({"id":"9876","permalink":"https://www.threads.net.evil.test/post/9876"}),
        ),
    ] {
        let transport = Fixture::default();
        transport.replies.lock().unwrap().push_back(reply(verified));
        let (persist, _) = record_checkpoint();
        let output = reconcile_with(
            &transport,
            &text_plan(platform),
            &fixture_account(platform),
            &remote,
            &persist,
        )
        .await
        .unwrap();
        assert_eq!(output["status"], "published");
        assert!(output["url"].is_null());
        assert!(!output.to_string().contains("evil.test"));
    }
}
#[tokio::test]
async fn threads_text_pending_container_resumes_once_then_reconciles_only_the_post() {
    let transport = Fixture::default();
    transport.replies.lock().unwrap().extend([
        reply(json!({"id":"5678"})),
        reply(json!({"status":"IN_PROGRESS"})),
        reply(json!({"status":"FINISHED"})),
        reply(json!({"id":"9876"})),
        reply(json!({"id":"9876"})),
        reply(json!({"id":"9876"})),
    ]);
    let (persist, _) = record_checkpoint();
    let input = text_plan("threads");
    let account = fixture_account("threads");
    let pending = publish_with(
        &transport,
        &input,
        &account,
        Path::new(""),
        0,
        None,
        None,
        None,
        &persist,
    )
    .await
    .unwrap();
    assert_eq!(pending["status"], "processing");
    assert!(pending["url"].is_null());
    let published = reconcile_with(&transport, &input, &account, &pending["remote"], &persist)
        .await
        .unwrap();
    assert_eq!(published["status"], "published");
    let confirmed = reconcile_with(&transport, &input, &account, &published["remote"], &persist)
        .await
        .unwrap();
    assert_eq!(confirmed["externalId"], "9876");
    let requests = transport.requests.lock().unwrap();
    assert_eq!(requests.len(), 6);
    assert_eq!(
        requests
            .iter()
            .filter(|request| request.url.ends_with("/1234/threads"))
            .count(),
        1
    );
    assert_eq!(
        requests
            .iter()
            .filter(|request| request.url.ends_with("/threads_publish"))
            .count(),
        1
    );
    assert_eq!(requests[5].method, reqwest::Method::GET);
}
#[tokio::test]
async fn facebook_text_is_processing_until_readback_explicitly_confirms_published() {
    let transport = Fixture::default();
    transport.replies.lock().unwrap().extend([
        reply(json!({"id":"1234_5678"})),
        reply(json!({"id":"1234_5678","is_published":false})),
        reply(json!({"id":"1234_5678","is_published":true})),
    ]);
    let (persist, _) = record_checkpoint();
    let input = text_plan("facebook");
    let account = fixture_account("facebook");
    let pending = publish_with(
        &transport,
        &input,
        &account,
        Path::new(""),
        0,
        None,
        None,
        None,
        &persist,
    )
    .await
    .unwrap();
    assert_eq!(pending["status"], "processing");
    assert_eq!(pending["remote"]["stage"], "commit_accepted");
    let confirmed = reconcile_with(&transport, &input, &account, &pending["remote"], &persist)
        .await
        .unwrap();
    assert_eq!(confirmed["status"], "published");
    assert_eq!(confirmed["remote"]["stage"], "published");
    assert_eq!(
        transport
            .requests
            .lock()
            .unwrap()
            .iter()
            .filter(|request| request.method == reqwest::Method::POST)
            .count(),
        1
    );
}
#[tokio::test]
async fn threads_legacy_video_kinds_keep_media_url_upload_and_video_receipts() {
    for kind in [None, Some(Value::Null), Some(json!("video"))] {
        let transport = Fixture::default();
        transport.replies.lock().unwrap().extend([
            reply(json!({"id":"5678"})),
            reply(json!({"status":"IN_PROGRESS"})),
        ]);
        let (persist, _) = record_checkpoint();
        let mut input = plan("threads");
        if let Some(kind) = kind {
            input["contentKind"] = kind;
        }
        let media_url = "https://media.example.test/approved.mp4";
        let output = publish_with(
            &transport,
            &input,
            &fixture_account("threads"),
            Path::new("fixture.mp4"),
            100,
            None,
            Some(media_url),
            None,
            &persist,
        )
        .await
        .unwrap();
        assert_eq!(output["status"], "processing");
        assert_eq!(output["thumbnailStatus"], "unsupported");
        assert_eq!(output["warnings"].as_array().unwrap().len(), 1);
        let requests = transport.requests.lock().unwrap();
        let Body::Form(fields) = &requests[0].body else {
            panic!("Threads video form");
        };
        assert_eq!(
            fields,
            &vec![
                ("media_type".into(), "VIDEO".into()),
                ("video_url".into(), media_url.into()),
                ("text".into(), caption(&input))
            ]
        );
    }
}
#[tokio::test]
async fn facebook_accepted_upload_is_processing_until_provider_confirms_publication() {
    let transport = Fixture::default();
    transport.replies.lock().unwrap().extend([
        reply(json!({"video_id":"8765","upload_url":"https://rupload.facebook.com/video-upload/v25.0/8765"})),
        reply(json!({"success":true})),reply(json!({"success":true})),
        reply(json!({"status":{"video_status":"ready","publishing_phase":{"status":"complete"}},"permalink_url":"https://www.facebook.com/reel/8765"})),
    ]);
    let (persist, _) = record_checkpoint();
    let input = plan("facebook");
    let account = fixture_account("facebook");
    let output = publish_with(
        &transport,
        &input,
        &account,
        Path::new("fixture.mp4"),
        100,
        None,
        None,
        None,
        &persist,
    )
    .await
    .unwrap();
    assert_eq!(output["status"], "processing");
    assert!(output["url"].is_null());
    let final_result = reconcile_with(&transport, &input, &account, &output["remote"], &persist)
        .await
        .unwrap();
    assert_eq!(final_result["status"], "published");
    assert_eq!(final_result["url"], "https://www.facebook.com/reel/8765");
}

#[tokio::test]
async fn text_media_length_never_reads_paths_but_legacy_video_still_does() {
    for platform in ["facebook", "threads"] {
        let input = text_plan(platform);
        for path in [Path::new(""), Path::new("fixture-text-has-no-video.mp4")] {
            assert_eq!(approved_media_length(&input, path).await.unwrap(), 0);
        }
        let invalid_mp4 = tempfile::NamedTempFile::new().unwrap();
        assert_eq!(
            approved_media_length(&input, invalid_mp4.path())
                .await
                .unwrap(),
            0
        );
        let mut legacy = plan(platform);
        for kind in [Value::Null, json!("video")] {
            legacy["contentKind"] = kind;
            assert!(approved_media_length(&legacy, invalid_mp4.path())
                .await
                .is_err());
        }
    }
}
#[tokio::test]
async fn real_video_upload_does_not_inherit_the_64_mib_qa_limit() {
    use std::io::Write;
    let mut file = tempfile::NamedTempFile::new().unwrap();
    file.write_all(b"\x00\x00\x00\x18ftypisom").unwrap();
    file.as_file().set_len(65 * 1024 * 1024).unwrap();
    assert_eq!(
        media_length(file.path(), "youtube").await.unwrap(),
        65 * 1024 * 1024
    );
    assert_eq!(
        media_length(file.path(), "instagram").await.unwrap(),
        65 * 1024 * 1024
    );
    file.as_file().set_len(4 * 1024 * 1024 * 1024 + 1).unwrap();
    assert!(media_length(file.path(), "tiktok").await.is_err());
}

#[test]
fn video_probe_constraints_follow_the_current_tiktok_creator_limit() {
    let mut input = plan("tiktok");
    let account = fixture_account("tiktok");
    assert!(validate_media_probe(&input, &account.public).is_ok());
    input["video"]["probe"]["durationSeconds"] = json!(181);
    assert!(validate_media_probe(&input, &account.public).is_err());
    input["options"]["mode"] = json!("draft");
    assert!(validate_media_probe(&input, &account.public).is_ok());
    input["video"]["probe"]["width"] = json!(359);
    assert!(validate_media_probe(&input, &account.public).is_err());
    input["video"]["probe"] = Value::Null;
    assert!(validate_media_probe(&input, &account.public).is_err());
}
