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
