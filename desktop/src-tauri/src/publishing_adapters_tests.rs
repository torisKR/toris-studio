use super::*;
use std::{collections::VecDeque, sync::Mutex};

#[derive(Default)]
struct Fixture {
    replies: Mutex<VecDeque<Result<Reply, AdapterError>>>,
    requests: Mutex<Vec<Request>>,
}
impl Transport for Fixture {
    fn send(&self, request: Request, _irreversible: bool) -> ResponseFuture<'_> {
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
