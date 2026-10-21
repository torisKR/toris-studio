use super::*;
use crate::oauth::tests::{client, fixture};

fn account(id: &str) -> RemoteIdentity {
    RemoteIdentity {
        account_id: id.into(),
        title: format!("Account {id}"),
    }
}
fn sample(id: &str) -> Connection {
    Connection { id:uuid::Uuid::new_v4().to_string(), platform:"threads".into(), client:client(Provider::Threads), session:session_from_response(&json!({"access_token":"fixture-token","expires_in":10000,"scope":"threads_basic,threads_manage_insights"}),None,100000,true).unwrap(), identities:vec![account(id)], verified_at:100000, disconnected:false, audit:vec![], legacy_source:None }
}
#[tokio::test]
async fn separate_authorizations_use_independent_vault_keys_and_disconnect() {
    let (service, store, _, _) = fixture();
    let a = sample("111");
    let b = sample("222");
    save_connection(&service, &a).unwrap();
    save_connection(&service, &b).unwrap();
    assert_ne!(connection_key(&a.id), connection_key(&b.id));
    assert_eq!(
        connection_list_locked(&service).unwrap()["connections"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    disconnect_locked(&service, &a.id).unwrap();
    assert!(read_connection(&service, &a.id).unwrap().disconnected);
    assert!(!read_connection(&service, &b.id).unwrap().disconnected);
    assert!(store.read(&connection_key(&b.id)).unwrap().is_some());
}
#[test]
fn identity_binding_rejects_wrong_connection_platform_account_and_read_scope() {
    let connection = sample("111");
    assert!(validate_binding(&connection, "threads", "111", &["threads_manage_insights"]).is_ok());
    assert!(validate_binding(&connection, "facebook", "111", &[]).is_err());
    assert!(validate_binding(&connection, "threads", "222", &[]).is_err());
    assert!(validate_binding(&connection, "threads", "111", &["threads_content_publish"]).is_err());
}
#[tokio::test]
async fn callback_state_is_bound_to_connection_and_cannot_be_cross_applied() {
    let (service, _, _, _) = fixture();
    service
        .write("client", Provider::Threads, &client(Provider::Threads))
        .unwrap();
    let a = begin_connection(&service, Provider::Threads, "read", None)
        .await
        .unwrap();
    let b = begin_connection(&service, Provider::Threads, "read", None)
        .await
        .unwrap();
    let url = Url::parse(a["authorizationUrl"].as_str().unwrap()).unwrap();
    let state = url
        .query_pairs()
        .find(|(key, _)| key == "state")
        .unwrap()
        .1
        .to_string();
    let callback = format!(
        "{}?code=fixture&state={state}",
        client(Provider::Threads).redirect_uri
    );
    assert!(
        complete_connection(&service, b["connectionId"].as_str().unwrap(), &callback)
            .await
            .is_err()
    );
    assert!(service
        .pending
        .lock()
        .unwrap()
        .contains_key(a["connectionId"].as_str().unwrap()));
}
#[tokio::test]
async fn legacy_copy_is_verified_idempotent_and_preserves_original_credentials() {
    let (service, store, transport, _) = fixture();
    let original = sample("111");
    service
        .write("client", Provider::Threads, &original.client)
        .unwrap();
    service
        .write("session", Provider::Threads, &original.session)
        .unwrap();
    let before = store.read("session:threads").unwrap();
    transport
        .responses
        .lock()
        .unwrap()
        .push_back(Ok(json!({"id":"111","username":"Fixture"})));
    let first = migrate_legacy(&service, Provider::Threads).await.unwrap();
    let second = migrate_legacy(&service, Provider::Threads).await.unwrap();
    assert_eq!(first, second);
    assert_eq!(before, store.read("session:threads").unwrap());
    assert_eq!(
        read_connection(&service, &first).unwrap().identities[0].account_id,
        "111"
    );
}
#[test]
fn ambiguous_platform_selection_fails_even_when_account_names_match() {
    let (service, _, _, _) = fixture();
    let a = sample("111");
    let b = sample("111");
    save_connection(&service, &a).unwrap();
    save_connection(&service, &b).unwrap();
    assert!(unique_connection(&service, Provider::Threads).is_err());
}
#[test]
fn new_read_permissions_never_include_publish_permissions_or_switch_instagram_login() {
    for provider in PROVIDERS {
        let scopes = read_scope(provider);
        assert!(!provider.publishing_authorized(
            &scopes
                .split([',', ' '])
                .map(str::to_owned)
                .collect::<Vec<_>>()
        ));
    }
    assert!(read_scope(Provider::Instagram).contains("instagram_business_manage_insights"));
    assert!(Provider::Instagram
        .authorization_endpoint()
        .contains("instagram.com"));
}

struct FaultStore {
    values: StdMutex<HashMap<String, String>>,
    fail_index: std::sync::atomic::AtomicBool,
}
impl CredentialStore for FaultStore {
    fn read(&self, key: &str) -> Result<Option<String>, String> {
        Ok(self.values.lock().unwrap().get(key).cloned())
    }
    fn write(&self, key: &str, value: &str) -> Result<(), String> {
        if key == INDEX && self.fail_index.load(std::sync::atomic::Ordering::SeqCst) {
            return Err("fixture vault failure".into());
        }
        self.values.lock().unwrap().insert(key.into(), value.into());
        Ok(())
    }
    fn delete(&self, key: &str) -> Result<(), String> {
        self.values.lock().unwrap().remove(key);
        Ok(())
    }
}
#[tokio::test]
async fn interrupted_migration_recovers_same_connection_without_replacing_original() {
    let (_, _, transport, clock) = fixture();
    let store = Arc::new(FaultStore {
        values: StdMutex::new(HashMap::new()),
        fail_index: std::sync::atomic::AtomicBool::new(true),
    });
    let service = OAuthService::new(store.clone(), transport.clone(), clock);
    let original = sample("111");
    service
        .write("client", Provider::Threads, &original.client)
        .unwrap();
    service
        .write("session", Provider::Threads, &original.session)
        .unwrap();
    let before = store.read("session:threads").unwrap();
    transport
        .responses
        .lock()
        .unwrap()
        .push_back(Ok(json!({"id":"111","username":"Fixture"})));
    assert!(migrate_legacy(&service, Provider::Threads).await.is_err());
    assert_eq!(before, store.read("session:threads").unwrap());
    let expected = store.read("legacy-copy:v2:threads").unwrap().unwrap();
    store
        .fail_index
        .store(false, std::sync::atomic::Ordering::SeqCst);
    assert_eq!(
        migrate_legacy(&service, Provider::Threads).await.unwrap(),
        expected
    );
    assert_eq!(before, store.read("session:threads").unwrap());
    assert_eq!(ids(&service).unwrap(), vec![expected]);
}

#[tokio::test]
async fn refresh_candidate_survives_identity_network_failure_and_does_not_refresh_twice() {
    let (service, store, transport, clock) = fixture();
    let mut c = sample("111");
    c.session.issued_at = 1;
    c.session.expires_at = 110000;
    save_connection(&service, &c).unwrap();
    transport.responses.lock().unwrap().extend([
        Ok(json!({"access_token":"rotated-fixture","expires_in":1000000})),
        Err(TokenFailure::transient("network_failure")),
        Ok(json!({"id":"111","username":"same-account"})),
    ]);
    assert!(refresh_connection_locked(&service, &c.id, false)
        .await
        .is_err());
    assert_eq!(
        read_connection(&service, &c.id)
            .unwrap()
            .session
            .access_token,
        "fixture-token"
    );
    assert!(store
        .read(&format!("refresh-candidate:v2:{}", c.id))
        .unwrap()
        .is_some());
    clock.set(200000); // Old Meta token expired; retained rotated token is still valid.
    let recovering = connection_list_locked(&service).unwrap();
    assert_eq!(recovering["connections"][0]["refreshable"], true);
    assert_eq!(recovering["connections"][0]["connected"], false);
    refresh_connection_locked(&service, &c.id, false)
        .await
        .unwrap();
    assert_eq!(
        read_connection(&service, &c.id)
            .unwrap()
            .session
            .access_token,
        "rotated-fixture"
    );
    assert_eq!(transport.requests.lock().unwrap().len(), 3);
}

#[tokio::test]
async fn refresh_identity_change_blocks_only_that_connection() {
    let (service, _, transport, _) = fixture();
    let mut a = sample("111");
    a.session.issued_at = 1;
    let b = sample("222");
    save_connection(&service, &a).unwrap();
    save_connection(&service, &b).unwrap();
    transport.responses.lock().unwrap().extend([
        Ok(json!({"access_token":"rotated-fixture","expires_in":1000000})),
        Ok(json!({"id":"333","username":"different-account"})),
    ]);
    assert!(refresh_connection_locked(&service, &a.id, false)
        .await
        .is_err());
    assert!(
        read_connection(&service, &a.id)
            .unwrap()
            .session
            .needs_reconnect
    );
    assert!(
        !read_connection(&service, &b.id)
            .unwrap()
            .session
            .needs_reconnect
    );
}

#[tokio::test]
async fn exact_facebook_page_token_requires_analytics_task_and_never_uses_other_page() {
    let (service, _, transport, _) = fixture();
    let mut c = sample("111");
    c.platform = "facebook".into();
    c.client = client(Provider::Facebook);
    c.session.scopes = vec!["read_insights".into(), "pages_read_engagement".into()];
    save_connection(&service, &c).unwrap();
    transport.responses.lock().unwrap().extend([
        Ok(json!({"data":[{"id":"222","access_token":"wrong-page-token","tasks":["ANALYZE"]}]})),
        Ok(json!({"data":[{"id":"111","access_token":"no-task-token","tasks":["CREATE_CONTENT"]}]})),
        Ok(json!({"data":[{"id":"111","access_token":"correct-page-token","tasks":["ANALYZE"]}]})),
    ]);
    assert!(access_locked(
        &service,
        &c.id,
        "facebook",
        "111",
        &["read_insights"],
        false
    )
    .await
    .is_err());
    assert!(access_locked(
        &service,
        &c.id,
        "facebook",
        "111",
        &["read_insights"],
        false
    )
    .await
    .is_err());
    let access = access_locked(
        &service,
        &c.id,
        "facebook",
        "111",
        &["read_insights"],
        false,
    )
    .await
    .unwrap();
    assert_eq!(access.token, "correct-page-token");
    assert_eq!(
        read_connection(&service, &c.id)
            .unwrap()
            .session
            .access_token,
        "fixture-token"
    );
}

#[tokio::test]
async fn completed_connection_is_single_use_and_does_not_replace_another_account() {
    let (service, store, transport, _) = fixture();
    service
        .write("client", Provider::Threads, &client(Provider::Threads))
        .unwrap();
    let a = sample("111");
    save_connection(&service, &a).unwrap();
    let before = store.read(&connection_key(&a.id)).unwrap();
    let started = begin_connection(&service, Provider::Threads, "read", None)
        .await
        .unwrap();
    let id = started["connectionId"].as_str().unwrap();
    let state = Url::parse(started["authorizationUrl"].as_str().unwrap())
        .unwrap()
        .query_pairs()
        .find(|(k, _)| k == "state")
        .unwrap()
        .1
        .to_string();
    let callback = format!(
        "{}?code=fixture&state={state}",
        client(Provider::Threads).redirect_uri
    );
    transport.responses.lock().unwrap().extend([
        Ok(json!({"access_token":"new-short","expires_in":3600})),
        Ok(json!({"access_token":"new-long","expires_in":1000000})),
        Ok(json!({"data":[{"permission":"threads_basic","status":"granted"},{"permission":"threads_manage_insights","status":"granted"}]})),
        Ok(json!({"id":"222","username":"second-account"})),
    ]);
    let result = complete_connection(&service, id, &callback).await.unwrap();
    assert_eq!(result["connections"].as_array().unwrap().len(), 2);
    assert_eq!(before, store.read(&connection_key(&a.id)).unwrap());
    assert!(complete_connection(&service, id, &callback).await.is_err());
    let public = result.to_string();
    assert!(!public.contains("new-long"));
    assert!(!public.contains("fixture-secret"));
    assert!(!public.contains("state="));
}

#[test]
fn tiktok_real_success_envelope_is_not_an_oauth_failure() {
    let body = json!({"data":{"user":{"open_id":"fixture_open_id","display_name":"Fixture"}},"error":{"code":"ok","message":"","log_id":"fixture-log"}});
    assert!(provider_error_for("https://open.tiktokapis.com/v2/user/info/", &body).is_none());
    for code in [
        "access_token_invalid",
        "rate_limit_exceeded",
        "scope_not_authorized",
        "internal_error",
    ] {
        assert!(provider_error_for(
            "https://open.tiktokapis.com/v2/user/info/",
            &json!({"error":{"code":code,"message":"provider text must never escape"}})
        )
        .is_some());
    }
    assert!(provider_error_for("https://graph.facebook.com/v25.0/me/accounts", &body).is_some());
}

#[tokio::test]
async fn new_login_index_failure_is_recoverable_after_callback_is_consumed() {
    let (_, _, transport, clock) = fixture();
    let store = Arc::new(FaultStore {
        values: StdMutex::new(HashMap::new()),
        fail_index: std::sync::atomic::AtomicBool::new(true),
    });
    let service = Arc::new(OAuthService::new(store.clone(), transport.clone(), clock));
    service
        .write("client", Provider::Threads, &client(Provider::Threads))
        .unwrap();
    let started = begin_connection(&service, Provider::Threads, "read", None)
        .await
        .unwrap();
    let id = started["connectionId"].as_str().unwrap();
    let state = Url::parse(started["authorizationUrl"].as_str().unwrap())
        .unwrap()
        .query_pairs()
        .find(|(k, _)| k == "state")
        .unwrap()
        .1
        .to_string();
    let callback = format!(
        "{}?code=fixture&state={state}",
        client(Provider::Threads).redirect_uri
    );
    transport.responses.lock().unwrap().extend([
        Ok(json!({"access_token":"new-short","expires_in":3600})),
        Ok(json!({"access_token":"new-long","expires_in":1000000})),
        Ok(json!({"data":[{"permission":"threads_basic","status":"granted"},{"permission":"threads_manage_insights","status":"granted"}]})),
        Ok(json!({"id":"222","username":"second-account"})),
    ]);
    assert!(complete_connection(&service, id, &callback).await.is_err());
    assert!(!service.pending.lock().unwrap().contains_key(id));
    store
        .fail_index
        .store(false, std::sync::atomic::Ordering::SeqCst);
    let recovered = connection_list_locked(&service).unwrap();
    assert_eq!(recovered["connections"].as_array().unwrap().len(), 1);
    assert_eq!(recovered["connections"][0]["connectionId"], id);
    assert_eq!(recovered["connections"][0]["accountId"], "222");
    assert_eq!(
        transport.requests.lock().unwrap().len(),
        4,
        "recovery must not replay the OAuth code"
    );
}

#[tokio::test]
async fn youtube_revoke_failure_blocks_local_access_and_retries_only_that_grant() {
    let (service, store, transport, _) = fixture();
    let mut a = sample("UC_fixture_a");
    a.platform = "youtube".into();
    a.client = client(Provider::Youtube);
    a.session.refresh_token = Some("a-private-refresh".into());
    a.session.long_lived = false;
    let mut b = a.clone();
    b.id = uuid::Uuid::new_v4().to_string();
    b.identities = vec![account("UC_fixture_b")];
    b.session.refresh_token = Some("b-private-refresh".into());
    save_connection(&service, &a).unwrap();
    save_connection(&service, &b).unwrap();
    let b_before = store.read(&connection_key(&b.id)).unwrap();
    transport.responses.lock().unwrap().extend([
        Err(TokenFailure::transient("network_failure")),
        Ok(json!({})),
    ]);
    disconnect_connection(&service, &a.id).await.unwrap();
    assert!(read_connection(&service, &a.id).unwrap().disconnected);
    assert!(
        access_locked(&service, &a.id, "youtube", "UC_fixture_a", &[], false)
            .await
            .is_err()
    );
    assert!(store
        .read(&format!("revocation-pending:v2:{}", a.id))
        .unwrap()
        .is_some());
    assert_eq!(
        connection_list_locked(&service).unwrap()["connections"][0]["revocationPending"],
        true
    );
    disconnect_connection(&service, &a.id).await.unwrap();
    assert!(store
        .read(&format!("revocation-pending:v2:{}", a.id))
        .unwrap()
        .is_none());
    assert_eq!(b_before, store.read(&connection_key(&b.id)).unwrap());
    let requests = transport.requests.lock().unwrap();
    assert_eq!(requests.len(), 2);
    for request in requests.iter() {
        assert_eq!(request.endpoint, "https://oauth2.googleapis.com/revoke");
        assert!(!request.get);
        assert_eq!(
            request.parameters,
            vec![("token".into(), "a-private-refresh".into())]
        );
        assert!(request.bearer.is_none());
    }
    let public = connection_list_locked(&service).unwrap().to_string();
    assert!(!public.contains("a-private-refresh"));
    assert!(!public.contains("b-private-refresh"));
}

#[test]
fn official_transport_decodes_tiktok_envelopes_and_empty_google_revocation() {
    let body=serde_json::to_vec(&json!({"data":{"user":{"open_id":"fixture"}},"error":{"code":"ok","message":"","log_id":"redacted"}})).unwrap();
    assert!(parse_token_response("https://open.tiktokapis.com/v2/user/info/", 200, &body).is_ok());
    assert!(parse_token_response("https://open.tiktokapis.com/v2/user/info/", 401, &body).is_err());
    let denied = serde_json::to_vec(
        &json!({"error":{"code":"access_token_invalid","message":"raw provider message"}}),
    )
    .unwrap();
    assert!(
        parse_token_response("https://open.tiktokapis.com/v2/user/info/", 200, &denied)
            .unwrap_err()
            .permanent
    );
    assert!(allowed_endpoint("https://oauth2.googleapis.com/revoke"));
    assert!(parse_token_response("https://oauth2.googleapis.com/revoke", 200, b"").is_ok());
    assert!(parse_token_response(
        "https://oauth2.googleapis.com/revoke",
        400,
        br#"{"error":"invalid_token"}"#
    )
    .is_err());
    assert!(parse_token_response("https://oauth2.googleapis.com/token", 200, b"").is_err());
}

#[tokio::test]
async fn youtube_revocation_marker_denies_access_before_local_cleanup_or_retry() {
    let (service, store, transport, _) = fixture();
    let mut c = sample("UC_fixture");
    c.platform = "youtube".into();
    c.client = client(Provider::Youtube);
    save_connection(&service, &c).unwrap();
    store
        .write(
            &revocation_key(&c.id),
            &serde_json::to_string(&PendingRevocation {
                token: "private-revoke-token".into(),
                retry_at: 100001,
                failures: 1,
            })
            .unwrap(),
        )
        .unwrap();
    assert!(
        !read_connection(&service, &c.id).unwrap().disconnected,
        "simulates a crash before tombstone commit"
    );
    assert!(
        access_locked(&service, &c.id, "youtube", "UC_fixture", &[], false)
            .await
            .is_err()
    );
    let listed = connection_list_locked(&service).unwrap();
    let row = &listed["connections"][0];
    assert_eq!(row["connected"], false);
    assert_eq!(row["refreshable"], false);
    assert_eq!(row["disconnected"], true);
    assert_eq!(row["revocationPending"], true);
    assert!(
        begin_connection(&service, Provider::Youtube, "read", Some(&c.id))
            .await
            .is_err()
    );
    retry_revocation(&service, &c.id, false).await.unwrap();
    assert!(
        transport.requests.lock().unwrap().is_empty(),
        "automatic retries respect the persisted backoff"
    );
    assert!(!listed.to_string().contains("private-revoke-token"));
    transport.responses.lock().unwrap().push_back(Ok(json!({})));
    retry_revocation(&service, &c.id, true).await.unwrap();
    let disconnected = read_connection(&service, &c.id).unwrap();
    assert!(disconnected.disconnected);
    assert!(disconnected.session.access_token.is_empty());
    assert!(store.read(&revocation_key(&c.id)).unwrap().is_none());
}
