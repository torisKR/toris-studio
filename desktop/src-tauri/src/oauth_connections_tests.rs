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

#[derive(Default)]
struct ValidatedVaultStore(crate::vault::tests::MemoryVault);
impl CredentialStore for ValidatedVaultStore {
    fn read(&self, account: &str) -> Result<Option<String>, String> {
        self.0.read(account)
    }
    fn write(&self, account: &str, value: &str) -> Result<(), String> {
        self.0.write(account, value)
    }
    fn delete(&self, account: &str) -> Result<(), String> {
        self.0.delete(account)
    }
}

#[tokio::test]
async fn connection_lifecycle_uses_production_vault_validation_across_restart() {
    let (_, _, transport, clock) = fixture();
    let store = Arc::new(ValidatedVaultStore::default());
    let service = OAuthService::new(store.clone(), transport.clone(), clock.clone());
    assert_eq!(
        connection_list_locked(&service).unwrap()["connections"],
        json!([])
    );
    let first = sample("111");
    let second = sample("222");
    commit_connection(&service, &first).unwrap();
    // A process interruption after the durable record, before the index commit.
    verified_write(&service, COMMIT_INDEX, &json!([second.id]).to_string()).unwrap();
    verified_write(
        &service,
        &connection_key(&second.id),
        &serde_json::to_string(&second).unwrap(),
    )
    .unwrap();
    let recovered = connection_list_locked(&service).unwrap();
    assert_eq!(recovered["connections"].as_array().unwrap().len(), 2);
    assert!(commit_ids(&service).unwrap().is_empty());
    connection_audit(&service, &first.id, "fixture", "success").unwrap();
    verified_write(
        &service,
        &format!("refresh-candidate:v2:{}", first.id),
        &serde_json::to_string(&first.session).unwrap(),
    )
    .unwrap();
    disconnect_connection(&service, &first.id).await.unwrap();
    store.0.restart();
    let restarted = OAuthService::new(store, transport, clock);
    let restored = connection_list_locked(&restarted).unwrap();
    let rows = restored["connections"].as_array().unwrap();
    assert_eq!(rows.len(), 2);
    let disconnected = rows
        .iter()
        .find(|row| row["connectionId"] == first.id)
        .unwrap();
    let connected = rows
        .iter()
        .find(|row| row["connectionId"] == second.id)
        .unwrap();
    assert_eq!(disconnected["disconnected"], true);
    assert_eq!(disconnected["cleanupPending"], true);
    assert_eq!(connected["connected"], true);
    assert!(read_connection(&restarted, &first.id)
        .unwrap()
        .session
        .access_token
        .is_empty());
    assert_eq!(
        read_connection(&restarted, &second.id)
            .unwrap()
            .session
            .access_token,
        "fixture-token"
    );
}

#[tokio::test]
async fn legacy_connection_copy_and_client_backup_use_production_vault_validation() {
    let (_, _, transport, clock) = fixture();
    let store = Arc::new(ValidatedVaultStore::default());
    let service = OAuthService::new(store.clone(), transport.clone(), clock.clone());
    let original = sample("111");
    service
        .write("client", Provider::Threads, &original.client)
        .unwrap();
    service
        .write("session", Provider::Threads, &original.session)
        .unwrap();
    let original_session = store.read("session:threads").unwrap();
    transport
        .responses
        .lock()
        .unwrap()
        .push_back(Ok(json!({"id":"111","username":"Fixture"})));
    let id = migrate_legacy(&service, Provider::Threads).await.unwrap();
    service
        .save_client(Provider::Threads, json!({"clientId":"changed-client"}))
        .await
        .unwrap();
    assert_eq!(store.read("session:threads").unwrap(), original_session);
    assert_eq!(
        store
            .read("legacy-client-changed:threads")
            .unwrap()
            .as_deref(),
        Some("true")
    );
    store.0.restart();
    let restarted = OAuthService::new(store, transport, clock);
    let migrated = read_connection(&restarted, &id).unwrap();
    assert_eq!(migrated.client.client_id, "example-client-id");
    assert_eq!(migrated.session.access_token, "fixture-token");
    assert_eq!(migrated.legacy_source.as_deref(), Some("threads"));
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

#[tokio::test]
async fn disconnect_cleanup_survives_failed_database_and_same_id_reconnect_attempt() {
    let (service, store, transport, _) = fixture();
    let c = sample("111");
    save_connection(&service, &c).unwrap();
    prepare_cleanup_locked(&service, &c.id, Some("fixture-db-A")).unwrap();
    disconnect_connection(&service, &c.id).await.unwrap();
    let listed = connection_list_locked(&service).unwrap();
    assert_eq!(listed["connections"][0]["cleanupPending"], true);
    assert!(
        begin_connection(&service, Provider::Threads, "read", Some(&c.id))
            .await
            .is_err(),
        "DB-down cleanup must block same-ID reconnection"
    );
    // Even an older writer restoring active credentials cannot erase cleanup intent.
    save_connection(&service, &c).unwrap();
    assert!(access_locked(&service, &c.id, "threads", "111", &[], false)
        .await
        .is_err());
    let tickets = cleanup_tickets_locked(&service).unwrap();
    assert_eq!(tickets.len(), 1);
    let generation = tickets[0]["generation"].as_str().unwrap();
    assert!(
        !listed.to_string().contains(generation),
        "native acknowledgement nonce must not cross IPC"
    );
    assert!(!listed.to_string().contains("fixture-db-A"));
    assert!(complete_cleanup_locked(&service, &c.id, "stale-generation", "fixture-db-A").is_err());
    assert_eq!(cleanup_tickets_locked(&service).unwrap().len(), 1);
    assert!(complete_cleanup_locked(&service, &c.id, generation, "fixture-db-B").is_err());
    // Repeating disconnect after switching config cannot redirect the intent.
    prepare_cleanup_locked(&service, &c.id, Some("fixture-db-B")).unwrap();
    assert_eq!(
        cleanup_tickets_locked(&service).unwrap()[0]["databaseFingerprint"],
        "fixture-db-A"
    );
    assert!(
        begin_connection(&service, Provider::Threads, "read", Some(&c.id))
            .await
            .is_err()
    );
    complete_cleanup_locked(&service, &c.id, generation, "fixture-db-A").unwrap();
    assert!(cleanup_tickets_locked(&service).unwrap().is_empty());
    assert!(
        begin_connection(&service, Provider::Threads, "read", Some(&c.id))
            .await
            .is_ok()
    );
    assert!(transport.requests.lock().unwrap().is_empty());
    assert!(store.read(&connection_key(&c.id)).unwrap().is_some());
}

#[tokio::test]
async fn legacy_cleanup_without_database_identity_never_adopts_current_database() {
    let (service, store, transport, _) = fixture();
    let c = sample("111");
    save_connection(&service, &c).unwrap();
    // This is the exact pre-fingerprint on-disk format.
    store
        .write(
            &cleanup_key(&c.id),
            &json!({"generation":"legacy","platform":"threads","requested_at":1}).to_string(),
        )
        .unwrap();
    prepare_cleanup_locked(&service, &c.id, Some("current-db")).unwrap();
    disconnect_connection(&service, &c.id).await.unwrap();
    assert!(cleanup_tickets_locked(&service).unwrap()[0]["databaseFingerprint"].is_null());
    assert!(complete_cleanup_locked(&service, &c.id, "legacy", "current-db").is_err());
    assert!(cleanup_pending(&service, &c.id).unwrap());
    assert!(
        begin_connection(&service, Provider::Threads, "read", Some(&c.id))
            .await
            .is_err()
    );
    assert!(transport.requests.lock().unwrap().is_empty());
}

#[cfg(feature = "desktop")]
#[tokio::test]
#[ignore = "requires disposable TORIS_PUBLICATIONS_TEST_DB or TORIS_STUDIO_TEST_DATABASE_URL"]
async fn disconnect_cleanup_database_recovery_holds_all_jobs_and_preserves_imports(
) -> Result<(), String> {
    let raw = std::env::var("TORIS_PUBLICATIONS_TEST_DB")
        .or_else(|_| std::env::var("TORIS_STUDIO_TEST_DATABASE_URL"))
        .map_err(|_| "Disposable fixture database required")?;
    let url = Url::parse(&raw).map_err(|_| "Fixture URL error")?;
    if url.host_str() != Some("127.0.0.1")
        || url.port() == Some(54329)
        || !url.path().starts_with("/toris_publications_test_")
            && !url.path().starts_with("/studio_analytics_test_")
    {
        return Err("Refusing non-isolated fixture database".into());
    }
    let config = crate::config::AppConfig {
        database_url: Some(raw),
        ..Default::default()
    };
    let fingerprint =
        crate::oauth_native::database_fingerprint(&config)?.ok_or("fixture fingerprint")?;
    let (service, _, transport, _) = fixture();
    let c = sample("fixture_account");
    let other = sample("other_account");
    save_connection(&service, &c)?;
    save_connection(&service, &other)?;
    let db = crate::social::database(&config).await?;
    let publication = Uuid::new_v4();
    let job = Uuid::new_v4();
    let other_job = Uuid::new_v4();
    let selected_api = Uuid::new_v4();
    let manual_import = Uuid::new_v4();
    let other_api = Uuid::new_v4();
    db.client
        .execute(
            "INSERT INTO publications(id,payload)VALUES($1,$2)",
            &[&publication, &json!({"title":"OAuth cleanup fixture"})],
        )
        .await
        .map_err(|_| "fixture publication")?;
    for (id, connection) in [(job, &c.id), (other_job, &other.id)] {
        db.client.execute("INSERT INTO publication_jobs(id,publication_id,revision,target_id,approval_hash,snapshot,mode,status,scheduled_at)VALUES($1,$2,1,$3,$4,$5,'scheduled','scheduled',now()+interval '1 day')",&[&id,&publication,&Uuid::new_v4(),&"0".repeat(64),&json!({"connectionId":connection,"platform":"threads","accountId":"fixture_account"})]).await.map_err(|_|"fixture approval")?;
    }
    for (id, kind, connection) in [
        (selected_api, "api", &c.id),
        (manual_import, "import", &c.id),
        (other_api, "api", &other.id),
    ] {
        db.client.execute("INSERT INTO analytics_sources(id,source_kind,platform,account_id,connection_id,label,digest)VALUES($1,$2,'threads','fixture_account',$3,'cleanup fixture',$4)",&[&id,&kind,&connection,&id.to_string()]).await.map_err(|_|"fixture source")?;
    }
    prepare_cleanup_locked(&service, &c.id, Some(&fingerprint))?;
    disconnect_connection(&service, &c.id).await?;
    let ticket = cleanup_tickets_locked(&service)?.remove(0);
    let generation = ticket["generation"].as_str().ok_or("fixture generation")?;
    let offline = crate::config::AppConfig::default();
    assert!(crate::oauth_native::run_cleanup(
        crate::oauth_native::cleanup_database(&offline, &c.id),
        async { complete_cleanup_locked(&service, &c.id, generation, &fingerprint) }
    )
    .await
    .is_err());
    assert!(cleanup_pending(&service, &c.id)?);
    let mut empty_database = url.clone();
    empty_database.set_path("/postgres");
    let switched = crate::config::AppConfig {
        database_url: Some(empty_database.to_string()),
        ..Default::default()
    };
    let empty = crate::social::database(&switched).await?;
    assert!(empty
        .client
        .query_one("SELECT to_regclass('public.publication_jobs')::text", &[])
        .await
        .map_err(|_| "fixture empty database")?
        .get::<_, Option<String>>(0)
        .is_none());
    drop(empty);
    assert!(
        crate::oauth_native::run_cleanup(
            async {
                crate::oauth_native::cleanup_database_target(&ticket, &switched)?;
                crate::oauth_native::cleanup_database(&switched, &c.id).await
            },
            async { complete_cleanup_locked(&service, &c.id, generation, &fingerprint) }
        )
        .await
        .is_err(),
        "an empty, reachable DB B must not acknowledge DB A's intent"
    );
    assert!(
        complete_cleanup_locked(&service, &c.id, generation, "different-empty-database").is_err()
    );
    assert!(cleanup_pending(&service, &c.id)?);
    assert!(
        begin_connection(&service, Provider::Threads, "read", Some(&c.id))
            .await
            .is_err()
    );
    // Simulate the legacy overwrite from the review: the independent marker
    // must still deny tokens and remain visible to background cleanup.
    save_connection(&service, &c)?;
    assert!(
        access_locked(&service, &c.id, "threads", "fixture_account", &[], false)
            .await
            .is_err()
    );
    let mut blocker = crate::social::database(&config).await?;
    let locked = blocker
        .client
        .transaction()
        .await
        .map_err(|_| "fixture lock transaction")?;
    locked
        .query_one(
            "SELECT id FROM publication_jobs WHERE id=$1 FOR UPDATE",
            &[&job],
        )
        .await
        .map_err(|_| "fixture row lock")?;
    assert!(
        crate::oauth_native::run_cleanup(
            crate::oauth_native::cleanup_database(&config, &c.id),
            async { complete_cleanup_locked(&service, &c.id, generation, &fingerprint) }
        )
        .await
        .is_err(),
        "locked approvals must retain the marker, never silently skip"
    );
    assert!(cleanup_pending(&service, &c.id)?);
    assert_eq!(
        db.client
            .query_one(
                "SELECT count(*) FROM analytics_sources WHERE id=$1",
                &[&selected_api]
            )
            .await
            .map_err(|_| "fixture source check")?
            .get::<_, i64>(0),
        1
    );
    locked.rollback().await.map_err(|_| "fixture unlock")?;
    crate::oauth_native::run_cleanup(
        crate::oauth_native::cleanup_database(&config, &c.id),
        async { complete_cleanup_locked(&service, &c.id, generation, &fingerprint) },
    )
    .await?;
    assert!(!cleanup_pending(&service, &c.id)?);
    assert_eq!(
        db.client
            .query_one("SELECT status FROM publication_jobs WHERE id=$1", &[&job])
            .await
            .map_err(|_| "fixture selected job")?
            .get::<_, String>(0),
        "needs_confirmation"
    );
    assert_eq!(
        db.client
            .query_one(
                "SELECT status FROM publication_jobs WHERE id=$1",
                &[&other_job]
            )
            .await
            .map_err(|_| "fixture other job")?
            .get::<_, String>(0),
        "scheduled"
    );
    assert_eq!(
        db.client
            .query_one(
                "SELECT count(*) FROM analytics_sources WHERE id=$1",
                &[&selected_api]
            )
            .await
            .map_err(|_| "fixture API cache")?
            .get::<_, i64>(0),
        0
    );
    for source in [manual_import, other_api] {
        assert_eq!(
            db.client
                .query_one(
                    "SELECT count(*) FROM analytics_sources WHERE id=$1",
                    &[&source]
                )
                .await
                .map_err(|_| "fixture preserved source")?
                .get::<_, i64>(0),
            1
        );
    }
    assert!(
        begin_connection(&service, Provider::Threads, "read", Some(&c.id))
            .await
            .is_ok()
    );
    assert!(transport.requests.lock().unwrap().is_empty());
    db.client
        .execute("DELETE FROM publications WHERE id=$1", &[&publication])
        .await
        .map_err(|_| "fixture publication cleanup")?;
    db.client
        .execute(
            "DELETE FROM analytics_sources WHERE id=ANY($1)",
            &[&vec![selected_api, manual_import, other_api]],
        )
        .await
        .map_err(|_| "fixture source cleanup")?;
    Ok(())
}

#[test]
fn every_google_login_and_tiktok_use_pkce() {
    for p in PROVIDERS {
        let expected = matches!(
            p,
            Provider::Youtube | Provider::GoogleCalendar | Provider::Tiktok
        );
        assert_eq!(uses_pkce(p), expected, "{}", p.id());
    }
}

#[test]
fn google_scopes_are_space_separated_and_others_comma() {
    assert_eq!(scope_separator(Provider::GoogleCalendar), " ");
    assert_eq!(scope_separator(Provider::Youtube), " ");
    assert_eq!(scope_separator(Provider::Threads), ",");
    assert_eq!(scope_separator(Provider::Tiktok), ",");
}

#[test]
fn builtin_google_client_has_no_secret_and_is_off_without_an_id() {
    assert!(
        builtin_google_client(Provider::Youtube, "").is_none(),
        "empty id: built-in mode off"
    );
    assert!(
        builtin_google_client(Provider::Tiktok, "id.apps.googleusercontent.com").is_none(),
        "Google only"
    );
    let c =
        builtin_google_client(Provider::GoogleCalendar, "id.apps.googleusercontent.com").unwrap();
    assert_eq!(c.client_secret, None);
    assert_eq!(c.redirect_uri, Provider::GoogleCalendar.default_redirect());
    assert_eq!(c.mode, ClientMode::GoogleBuiltin);
    assert!(validate_client(Provider::GoogleCalendar, &c).is_ok());
    let pending = PendingLogin {
        state: "s".into(),
        verifier: uses_pkce(Provider::GoogleCalendar).then(random_secret),
        client: c.clone(),
        expires_at: 0,
        cancel: watch::channel(false).0,
        publishing: false,
        provider_id: None,
        callback_uri: None,
    };
    let request = authorization_code_request(Provider::GoogleCalendar, &c, &pending, "code");
    let names: Vec<&str> = request.parameters.iter().map(|(k, _)| k.as_str()).collect();
    assert!(
        !names.contains(&"client_secret"),
        "no secret is sent: {names:?}"
    );
    assert!(
        names.contains(&"code_verifier"),
        "PKCE replaces the secret: {names:?}"
    );
}

#[test]
fn testing_google_logins_report_a_relogin_date_from_the_first_login() {
    let builtin =
        builtin_google_client(Provider::Youtube, "id.apps.googleusercontent.com").unwrap();
    let mut session = session_from_response(
        &json!({"access_token":"a","expires_in":3600,"refresh_token":"r"}),
        None,
        1_000,
        false,
    )
    .unwrap();
    session.login_at = 1_000;
    assert_eq!(relogin_by(&builtin, &session, true), Some(1_000 + 7 * DAY));
    session.expires_at = 999_999;
    session.issued_at = 500_000;
    assert_eq!(
        relogin_by(&builtin, &session, true),
        Some(1_000 + 7 * DAY),
        "refreshes do not move the date"
    );
    assert_eq!(
        relogin_by(&builtin, &session, false),
        None,
        "a published app has no weekly expiry"
    );
    assert_eq!(
        relogin_by(&client(Provider::Youtube), &session, true),
        None,
        "the user's own client is not ours to describe"
    );
}

fn google_service(id: &str) -> Arc<OAuthService> {
    let (_, store, transport, clock) = fixture();
    Arc::new(OAuthService::new(store, transport, clock).with_google_client(id))
}
fn provider_row(status: &Value, id: &str) -> Value {
    status["providers"]
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["platform"] == id)
        .unwrap()
        .clone()
}

#[tokio::test]
async fn builtin_google_client_is_the_default_and_the_user_can_override_it() {
    let service = google_service("toris.apps.googleusercontent.com");
    let status = service.status_locked();
    let calendar = provider_row(&status, "google_calendar");
    assert_eq!(
        calendar["clientConfigured"], true,
        "no client input is needed"
    );
    assert_eq!(calendar["clientMode"], "google_builtin");
    assert_eq!(calendar["builtinAvailable"], true);
    assert_eq!(
        provider_row(&status, "youtube")["clientMode"],
        "google_builtin"
    );
    let tiktok = provider_row(&status, "tiktok");
    assert_eq!(tiktok["clientConfigured"], false);
    assert_eq!(tiktok["builtinAvailable"], false);

    service
        .save_client(
            Provider::GoogleCalendar,
            json!({"clientId":"mine.apps.googleusercontent.com"}),
        )
        .await
        .unwrap();
    let own = provider_row(&service.status_locked(), "google_calendar");
    assert_eq!(own["clientMode"], "developer");
    assert_eq!(
        service
            .client_for(Provider::GoogleCalendar)
            .unwrap()
            .unwrap()
            .client_id,
        "mine.apps.googleusercontent.com"
    );

    service
        .save_client(Provider::GoogleCalendar, json!({"mode":"builtin"}))
        .await
        .unwrap();
    let back = service
        .client_for(Provider::GoogleCalendar)
        .unwrap()
        .unwrap();
    assert_eq!(
        (
            back.mode,
            back.client_id.as_str(),
            back.client_secret.clone()
        ),
        (
            ClientMode::GoogleBuiltin,
            "toris.apps.googleusercontent.com",
            None
        )
    );
    assert!(
        service
            .save_client(Provider::Tiktok, json!({"mode":"builtin"}))
            .await
            .is_err(),
        "Google only"
    );
    assert!(
        service
            .save_client(Provider::Youtube, json!({"mode":"builtin","clientId":"x"}))
            .await
            .is_err(),
        "built-in takes no other field"
    );
}

#[tokio::test]
async fn without_a_built_in_id_google_needs_the_users_client() {
    let service = google_service("");
    let calendar = provider_row(&service.status_locked(), "google_calendar");
    assert_eq!(calendar["clientConfigured"], false);
    assert_eq!(calendar["builtinAvailable"], false);
    assert!(service
        .save_client(Provider::GoogleCalendar, json!({"mode":"builtin"}))
        .await
        .is_err());
}

#[test]
fn connection_rows_carry_the_testing_relogin_date_for_builtin_google_only() {
    let service = google_service("toris.apps.googleusercontent.com");
    let mut c = sample("111");
    c.platform = "youtube".into();
    c.client =
        builtin_google_client(Provider::Youtube, "toris.apps.googleusercontent.com").unwrap();
    c.session.login_at = 100_000;
    commit_connection(&service, &c).unwrap();
    let rows = connection_list_locked(&service).unwrap();
    let row = &rows["connections"][0];
    assert_eq!(row["clientMode"], "google_builtin");
    assert_eq!(
        row["reloginBy"],
        json!(timestamp(100_000 + 7 * DAY)),
        "GOOGLE_CLIENT_TESTING is on by default"
    );
    let mut own = sample("222");
    own.session.login_at = 100_000;
    commit_connection(&service, &own).unwrap();
    let rows = connection_list_locked(&service).unwrap();
    let other = rows["connections"]
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["accountId"] == "222")
        .unwrap();
    assert_eq!(other["reloginBy"], Value::Null);
}

// ---- Toris broker mode ----

const BROKER_STATE: &str = "eyJrIjoiazEiLCJwIjoidGlrdG9rIiwiZSI6OTk5OTk5OTk5OX0.c2lnbmF0dXJl";
fn toris_service() -> (Arc<OAuthService>, Arc<crate::oauth::tests::MockTransport>) {
    let (_, store, transport, clock) = fixture();
    (
        Arc::new(OAuthService::new(store, transport.clone(), clock).with_callback_port(0)),
        transport,
    )
}
fn state_of(started: &Value) -> String {
    Url::parse(started["authorizationUrl"].as_str().unwrap())
        .unwrap()
        .query_pairs()
        .find(|(k, _)| k == "state")
        .unwrap()
        .1
        .to_string()
}

#[tokio::test]
async fn toris_login_exchanges_through_the_broker_and_never_holds_a_secret() {
    let (service, transport) = toris_service();
    service
        .save_client(Provider::Tiktok, json!({"mode":"toris"}))
        .await
        .unwrap();
    transport.responses.lock().unwrap().extend([
        Ok(json!({"v":1,"state":BROKER_STATE,"clientId":"tt-public-key","redirectUri":"http://127.0.0.1:38471/oauth/tiktok/callback","expiresAt":"2030-01-01T00:00:00Z"})),
        Ok(json!({"v":1,"access_token":"tt-access","token_type":"bearer","expires_in":86400,"refresh_token":"tt-refresh","refresh_expires_in":15552000,"scope":"user.info.basic,user.info.stats,video.list","long_lived":false})),
        Ok(json!({"data":{"user":{"open_id":"open-1","display_name":"Tori"}},"error":{"code":"ok","message":"","log_id":"x"}})),
    ]);
    let started = begin_connection(&service, Provider::Tiktok, "read", None)
        .await
        .unwrap();
    let auth = started["authorizationUrl"].as_str().unwrap();
    assert!(auth.contains("client_key=tt-public-key"), "{auth}");
    assert_eq!(
        state_of(&started),
        BROKER_STATE,
        "the broker's signed state is used as-is"
    );
    let start = transport.broker_requests.lock().unwrap()[0].clone();
    assert_eq!(start.path, "/v1/oauth/tiktok/start");
    let challenge = start.body.as_ref().unwrap()["challenge"]
        .as_str()
        .unwrap()
        .to_owned();
    assert_eq!(challenge.len(), 43);
    assert_eq!(start.body.as_ref().unwrap()["purpose"], "read");
    let id = started["connectionId"].as_str().unwrap();
    let result = complete_connection(
        &service,
        id,
        &format!(
            "http://127.0.0.1:38471/oauth/tiktok/callback?code=auth-code-1&state={BROKER_STATE}"
        ),
    )
    .await
    .unwrap();
    let token = transport.broker_requests.lock().unwrap()[1].clone();
    assert_eq!(token.path, "/v1/oauth/tiktok/token");
    let body = token.body.unwrap();
    let mut keys: Vec<_> = body.as_object().unwrap().keys().cloned().collect();
    keys.sort();
    assert_eq!(
        keys,
        ["code", "redirectUri", "state", "verifier"],
        "only the broker's allowed fields"
    );
    assert_eq!(body["code"], "auth-code-1");
    assert_eq!(
        body["redirectUri"],
        "http://127.0.0.1:38471/oauth/tiktok/callback"
    );
    assert_eq!(
        URL_SAFE_NO_PAD.encode(Sha256::digest(
            body["verifier"].as_str().unwrap().as_bytes()
        )),
        challenge,
        "verifier proves the login that started"
    );
    for request in transport.requests.lock().unwrap().iter() {
        assert!(
            request.parameters.iter().all(|(k, _)| k != "client_secret"),
            "no secret leaves the app"
        );
        assert_ne!(
            request.endpoint,
            Provider::Tiktok.token_endpoint(),
            "the provider token endpoint is not called directly"
        );
    }
    let c = read_connection(&service, id).unwrap();
    assert_eq!(
        (
            c.client.mode,
            c.client.client_secret.clone(),
            c.client.broker.as_deref()
        ),
        (ClientMode::Toris, None, Some(TORIS_BROKER))
    );
    assert_eq!(c.session.refresh_token.as_deref(), Some("tt-refresh"));
    let public = result.to_string();
    for secret in [
        "tt-access",
        "tt-refresh",
        "auth-code-1",
        BROKER_STATE,
        body["verifier"].as_str().unwrap(),
    ] {
        assert!(!public.contains(secret), "{secret} leaked to IPC");
    }
}

#[tokio::test]
async fn toris_meta_login_takes_the_long_lived_token_in_one_call_and_accepts_the_loopback_relay() {
    let (service, transport) = toris_service();
    service
        .save_client(Provider::Threads, json!({"mode":"toris"}))
        .await
        .unwrap();
    let state = "eyJwIjoidGhyZWFkcyJ9.c2ln";
    transport.responses.lock().unwrap().extend([
        Ok(json!({"v":1,"state":state,"clientId":"threads-app","redirectUri":"https://toris.kr/oauth/threads/callback","expiresAt":"2030-01-01T00:00:00Z"})),
        Ok(json!({"v":1,"access_token":"th-long","token_type":"bearer","expires_in":5184000,"long_lived":true})),
        Ok(json!({"data":[{"permission":"threads_basic","status":"granted"},{"permission":"threads_manage_insights","status":"granted"}]})),
        Ok(json!({"id":"th-1","username":"tori"})),
    ]);
    let started = begin_connection(&service, Provider::Threads, "read", None)
        .await
        .unwrap();
    let auth = started["authorizationUrl"].as_str().unwrap();
    assert!(
        auth.contains("redirect_uri=https%3A%2F%2Ftoris.kr%2Foauth%2Fthreads%2Fcallback"),
        "{auth}"
    );
    assert!(
        !auth.contains("code_challenge"),
        "Meta gets no PKCE parameters; the broker binds the verifier"
    );
    let id = started["connectionId"].as_str().unwrap();
    complete_connection(
        &service,
        id,
        &format!("http://127.0.0.1:38471/oauth/threads/callback?code=c&state={state}"),
    )
    .await
    .unwrap();
    assert_eq!(
        transport.broker_requests.lock().unwrap().len(),
        2,
        "start + token; no separate long-lived exchange"
    );
    let c = read_connection(&service, id).unwrap();
    assert!(c.session.long_lived);
    assert_eq!(
        c.session.scopes,
        ["threads_basic", "threads_manage_insights"]
    );
}

#[tokio::test]
async fn toris_refresh_goes_to_the_broker_only_where_a_secret_is_needed() {
    let (service, transport) = toris_service();
    let toris = |p: Provider| ClientConfig {
        client_id: "public".into(),
        client_secret: None,
        redirect_uri: toris_redirect(p).into(),
        mode: ClientMode::Toris,
        broker: Some("https://broker.example.test".into()),
        ..Default::default()
    };
    for (p, expected) in [
        (
            Provider::Tiktok,
            Some(("/v1/oauth/tiktok/refresh", "refreshToken")),
        ),
        (
            Provider::NaverBlog,
            Some(("/v1/oauth/naver_blog/refresh", "refreshToken")),
        ),
        (
            Provider::Facebook,
            Some(("/v1/oauth/facebook/refresh", "accessToken")),
        ),
        (Provider::Threads, None),
        (Provider::Instagram, None),
    ] {
        let session = session_from_response(
            &json!({"access_token":"a","expires_in":10,"refresh_token":"r"}),
            None,
            1,
            p.meta(),
        )
        .unwrap();
        transport.responses.lock().unwrap().push_back(Ok(
            json!({"v":1,"access_token":"new","expires_in":3600,"long_lived":p.meta()}),
        ));
        let before = transport.broker_requests.lock().unwrap().len();
        assert!(refresh_call(&service, p, &toris(p), &session).await.is_ok());
        let broker = transport.broker_requests.lock().unwrap();
        match expected {
            Some((path, field)) => {
                let last = broker.last().unwrap();
                assert_eq!(
                    (last.base.as_str(), last.path.as_str()),
                    ("https://broker.example.test", path),
                    "the issuing broker, not the current setting"
                );
                assert_eq!(
                    last.body
                        .as_ref()
                        .unwrap()
                        .as_object()
                        .unwrap()
                        .keys()
                        .collect::<Vec<_>>(),
                    [field]
                );
            }
            None => {
                assert_eq!(
                    broker.len(),
                    before,
                    "{} refreshes without a secret, directly",
                    p.id()
                );
                assert!(transport
                    .requests
                    .lock()
                    .unwrap()
                    .last()
                    .unwrap()
                    .endpoint
                    .contains("refresh_access_token"));
            }
        }
    }
}

#[test]
fn broker_errors_map_to_reconnect_or_retry() {
    let failure =
        |code: &str| broker_failure(&json!({"v":1,"error":{"code":code,"retryable":false}}));
    assert!(failure("provider_rejected").permanent);
    assert!(failure("state_invalid").permanent);
    assert!(failure("verifier_mismatch").permanent);
    assert!(!failure("rate_limited").permanent);
    assert!(!failure("provider_unavailable").permanent);
    assert!(!failure("internal").permanent);
    assert_eq!(failure("upgrade_required").outcome, "upgrade_required");
    assert!(failure("upgrade_required").message().contains("업데이트"));
    assert!(
        !broker_failure(&json!({"v":1})).permanent,
        "an unknown shape is retried, not trusted"
    );
}

#[test]
fn broker_address_is_https_without_extras_and_requests_name_the_app_version() {
    assert_eq!(
        validate_broker_url("https://oauth.toris.kr").unwrap(),
        "https://oauth.toris.kr"
    );
    assert_eq!(
        validate_broker_url("https://oauth.toris.kr/").unwrap(),
        "https://oauth.toris.kr"
    );
    for bad in [
        "http://oauth.toris.kr",
        "https://u:p@oauth.toris.kr",
        "https://oauth.toris.kr/v1",
        "https://oauth.toris.kr?x=1",
        "https://oauth.toris.kr#a",
        "ftp://x",
        "not a url",
    ] {
        assert!(validate_broker_url(bad).is_err(), "{bad}");
    }
    assert!(
        validate_broker_url("http://127.0.0.1:8787").is_ok() == cfg!(debug_assertions),
        "loopback http only in debug builds"
    );
    assert_eq!(
        broker_user_agent(),
        format!("TorisStudio/{}", env!("CARGO_PKG_VERSION"))
    );
}

#[tokio::test]
async fn toris_start_rejects_a_redirect_the_app_does_not_know() {
    let (service, transport) = toris_service();
    service
        .save_client(Provider::Tiktok, json!({"mode":"toris"}))
        .await
        .unwrap();
    transport.responses.lock().unwrap().push_back(Ok(json!({"v":1,"state":BROKER_STATE,"clientId":"tt","redirectUri":"https://evil.example/cb","expiresAt":"2030-01-01T00:00:00Z"})));
    assert!(begin_connection(&service, Provider::Tiktok, "read", None)
        .await
        .is_err());
    transport.responses.lock().unwrap().push_back(Ok(json!({"v":1,"state":"bad state with spaces","clientId":"tt","redirectUri":"http://127.0.0.1:38471/oauth/tiktok/callback","expiresAt":"2030-01-01T00:00:00Z"})));
    assert!(begin_connection(&service, Provider::Tiktok, "read", None)
        .await
        .is_err());
    assert!(
        service
            .save_client(Provider::Youtube, json!({"mode":"toris"}))
            .await
            .is_err(),
        "Google never uses the broker"
    );
}

#[tokio::test]
async fn the_broker_address_is_a_constant_and_cannot_be_overridden_from_the_webview() {
    let (service, transport) = toris_service();
    // Even a value written under the old keychain key is ignored.
    service
        .store
        .write("broker:url", "https://evil.example.test")
        .unwrap();
    assert_eq!(broker_base(&service).unwrap(), TORIS_BROKER);
    let (_, store, mock, clock) = fixture();
    let injected = OAuthService::new(store, mock, clock).with_broker("https://broker.example.test");
    assert_eq!(
        broker_base(&injected).unwrap(),
        "https://broker.example.test",
        "tests inject through a test-only path"
    );
    assert!(
        dispatch(json!({"action":"setBroker","url":"https://broker.example.test"}))
            .await
            .is_err(),
        "no IPC path changes the broker"
    );
    transport
        .responses
        .lock()
        .unwrap()
        .push_back(Err(TokenFailure::transient("network_failure")));
    assert!(broker_view(&service).await.get("customBroker").is_none());
}

#[tokio::test]
async fn toris_availability_comes_from_the_broker_and_defaults_to_off() {
    let (service, transport) = toris_service();
    transport
        .responses
        .lock()
        .unwrap()
        .push_back(Err(TokenFailure::transient("network_failure")));
    let off = broker_view(&service).await;
    assert_eq!(
        off["available"]["tiktok"], false,
        "an unreachable broker shows only the developer-app form"
    );
    assert_eq!(off["naverSearch"], false);
    assert_eq!(
        broker_view(&service).await["available"]["threads"],
        false,
        "a failure is cached briefly, not retried per call"
    );
    assert_eq!(transport.broker_requests.lock().unwrap().len(), 1);

    let (service, transport) = toris_service();
    transport.responses.lock().unwrap().push_back(Ok(json!({"v":1,"minAppVersion":"0.1.0","platforms":{"tiktok":{"enabled":true},"threads":{"enabled":false},"youtube":{"enabled":true}},"naverSearch":{"enabled":true}})));
    let on = broker_view(&service).await;
    assert_eq!(on["available"]["tiktok"], true);
    assert_eq!(on["available"]["threads"], false);
    assert_eq!(
        on["available"]["youtube"],
        Value::Null,
        "Google is never a Toris platform"
    );
    assert_eq!(on["naverSearch"], true);
    assert_eq!(
        transport.broker_requests.lock().unwrap()[0].path,
        "/v1/config"
    );
    assert!(
        transport.broker_requests.lock().unwrap()[0].body.is_none(),
        "config is a GET"
    );
}

#[tokio::test]
async fn naver_search_through_the_broker_sends_only_the_query_fields() {
    let (service, transport) = toris_service();
    transport.responses.lock().unwrap().push_back(Ok(json!({"v":1,"total":1,"start":1,"display":1,"items":[{"title":"t","link":"https://blog.naver.com/a/1","description":"d","bloggername":"b","bloggerlink":"https://blog.naver.com/a","postdate":"20261120"}]})));
    let result = naver_search_with(&service, "  로컬 여행 ").await.unwrap();
    assert_eq!(result["items"][0]["title"], "t");
    let request = transport.broker_requests.lock().unwrap()[0].clone();
    assert_eq!(request.path, "/v1/naver/search/blog");
    assert_eq!(
        request.body.unwrap(),
        json!({"query":"로컬 여행","display":20,"sort":"date"})
    );
    for bad in ["", "   ", &"가".repeat(101)] {
        assert!(naver_search_with(&service, bad).await.is_err(), "{bad}");
    }
    transport
        .responses
        .lock()
        .unwrap()
        .push_back(Err(TokenFailure::transient("quota_exhausted")));
    let error = naver_search_with(&service, "ai").await.unwrap_err();
    assert!(!error.contains("http"), "{error}");
}

#[test]
fn the_first_login_time_survives_refreshes() {
    let first = session_from_response(
        &json!({"access_token":"a","expires_in":3600,"refresh_token":"r"}),
        None,
        1_000,
        false,
    )
    .unwrap();
    assert_eq!(first.login_at, 1_000);
    let refreshed = session_from_response(
        &json!({"access_token":"b","expires_in":3600}),
        Some(&first),
        50_000,
        false,
    )
    .unwrap();
    assert_eq!(
        refreshed.login_at, 1_000,
        "a refresh keeps the first login time"
    );
    assert_eq!(refreshed.issued_at, 50_000);
}

#[tokio::test]
async fn switching_only_the_connection_mode_still_invalidates_the_old_grant() {
    let service = google_service("toris.apps.googleusercontent.com");
    // The user's own record with the same ID, no secret and the default redirect: only the mode differs.
    let own = ClientConfig {
        client_id: "toris.apps.googleusercontent.com".into(),
        client_secret: None,
        redirect_uri: Provider::Youtube.default_redirect(),
        mode: ClientMode::Developer,
        ..Default::default()
    };
    service.write("client", Provider::Youtube, &own).unwrap();
    service
        .write(
            "session",
            Provider::Youtube,
            &session_from_response(
                &json!({"access_token":"a","expires_in":3600}),
                None,
                1,
                false,
            )
            .unwrap(),
        )
        .unwrap();
    service
        .save_client(Provider::Youtube, json!({"mode":"builtin"}))
        .await
        .unwrap();
    assert_eq!(
        service
            .store
            .read("legacy-client-changed:youtube")
            .unwrap()
            .as_deref(),
        Some("true"),
        "a different app context never inherits the grant"
    );
}

#[tokio::test]
async fn a_rejected_refresh_of_the_testing_google_client_says_logins_expire_every_7_days() {
    let (_, store, mock, clock) = fixture();
    let service = Arc::new(
        OAuthService::new(store, mock.clone(), clock)
            .with_google_client("toris.apps.googleusercontent.com"),
    );
    for (client, expected) in [
        (
            builtin_google_client(Provider::Youtube, "toris.apps.googleusercontent.com").unwrap(),
            "7일마다",
        ),
        (client(Provider::Youtube), "다시 연결하세요"),
    ] {
        let mut c = sample("yt-1");
        c.platform = "youtube".into();
        c.client = client;
        c.session = session_from_response(
            &json!({"access_token":"a","expires_in":1,"refresh_token":"r"}),
            None,
            100,
            false,
        )
        .unwrap();
        commit_connection(&service, &c).unwrap();
        mock.responses
            .lock()
            .unwrap()
            .push_back(Err(TokenFailure::invalid()));
        let error = refresh_connection_locked(&service, &c.id, false)
            .await
            .unwrap_err();
        assert!(error.contains(expected), "{error}");
        assert!(
            read_connection(&service, &c.id)
                .unwrap()
                .session
                .needs_reconnect
        );
    }
}
