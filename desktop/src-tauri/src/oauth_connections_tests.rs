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

fn provider_row(status: &Value, id: &str) -> Value {
    status["providers"]
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["platform"] == id)
        .unwrap()
        .clone()
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
        (
            Provider::Youtube,
            Some(("/v1/oauth/youtube/refresh", "refreshToken")),
        ),
        (
            Provider::GoogleCalendar,
            Some(("/v1/oauth/google_calendar/refresh", "refreshToken")),
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
    assert!(
        !failure("unsupported_platform").permanent,
        "a platform switched off at the broker keeps every connection for when it returns"
    );
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
    service
        .save_client(Provider::Youtube, json!({"mode":"toris"}))
        .await
        .unwrap();
    transport.responses.lock().unwrap().push_back(Ok(json!({"v":1,"state":BROKER_STATE,"clientId":"g","redirectUri":"http://127.0.0.1:38471/oauth/google_calendar/callback","expiresAt":"2030-01-01T00:00:00Z"})));
    assert!(
        begin_connection(&service, Provider::Youtube, "read", None)
            .await
            .is_err(),
        "a YouTube login never returns to the Calendar loopback"
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
    assert_eq!(on["available"]["youtube"], true);
    assert_eq!(
        on["available"]["google_calendar"], false,
        "a platform the broker does not list stays off"
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

#[tokio::test]
async fn switching_only_the_connection_mode_still_invalidates_the_old_grant() {
    let (service, _) = toris_service();
    // The user's own record with the Toris record's fields: no ID yet, no secret, the same loopback.
    let own = ClientConfig {
        client_id: String::new(),
        client_secret: None,
        redirect_uri: toris_redirect(Provider::Youtube).into(),
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
        .save_client(Provider::Youtube, json!({"mode":"toris"}))
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

// ---- Google through the Toris broker ----

const GOOGLE_STATE: &str = "eyJwIjoieW91dHViZSJ9.c2lnbmF0dXJl";
fn query_of(url: &str) -> HashMap<String, String> {
    Url::parse(url)
        .unwrap()
        .query_pairs()
        .into_owned()
        .collect()
}

#[tokio::test]
async fn toris_google_login_uses_pkce_and_exchanges_through_the_broker_for_youtube_and_calendar() {
    for p in [Provider::Youtube, Provider::GoogleCalendar] {
        let (service, transport) = toris_service();
        service
            .save_client(p, json!({"mode":"toris"}))
            .await
            .unwrap();
        let loopback = format!("http://127.0.0.1:38471/oauth/{}/callback", p.id());
        transport.responses.lock().unwrap().extend([
            Ok(json!({"v":1,"state":GOOGLE_STATE,"clientId":"toris-desktop.apps.googleusercontent.com","redirectUri":loopback,"expiresAt":"2030-01-01T00:00:00Z"})),
            Ok(json!({"v":1,"access_token":"google-private-access","token_type":"bearer","expires_in":3599,"refresh_token":"google-private-refresh","scope":read_scope(p),"long_lived":false})),
        ]);
        if p == Provider::Youtube {
            transport.responses.lock().unwrap().push_back(Ok(
                json!({"items":[{"id":"UC_toris","snippet":{"title":"Toris"}}]}),
            ));
        }
        let started = begin_connection(&service, p, "read", None).await.unwrap();
        assert_eq!(
            started["manualCallback"], false,
            "Google returns to the loopback"
        );
        let auth = query_of(started["authorizationUrl"].as_str().unwrap());
        let start = transport.broker_requests.lock().unwrap()[0].clone();
        assert_eq!(start.path, format!("/v1/oauth/{}/start", p.id()));
        assert_eq!(
            auth["client_id"],
            "toris-desktop.apps.googleusercontent.com"
        );
        assert_eq!(auth["redirect_uri"], loopback);
        assert_eq!(auth["state"], GOOGLE_STATE);
        assert_eq!(
            auth["code_challenge"],
            start.body.as_ref().unwrap()["challenge"].as_str().unwrap(),
            "one verifier proves the login to the broker and to Google"
        );
        assert_eq!(auth["code_challenge_method"], "S256");
        assert_eq!(auth["access_type"], "offline");
        assert_eq!(auth["prompt"], "consent");
        assert_eq!(
            auth["scope"],
            read_scope(p),
            "Google scopes are space separated"
        );
        assert!(!auth.contains_key("client_secret"));
        let id = started["connectionId"].as_str().unwrap();
        let result = complete_connection(
            &service,
            id,
            &format!("{loopback}?code=4/0Ab-private-code&state={GOOGLE_STATE}"),
        )
        .await
        .unwrap();
        let token = transport.broker_requests.lock().unwrap()[1].clone();
        assert_eq!(token.path, format!("/v1/oauth/{}/token", p.id()));
        let body = token.body.unwrap();
        assert_eq!(body["redirectUri"], loopback.as_str());
        assert_eq!(body["code"], "4/0Ab-private-code");
        assert_eq!(
            URL_SAFE_NO_PAD.encode(Sha256::digest(
                body["verifier"].as_str().unwrap().as_bytes()
            )),
            auth["code_challenge"]
        );
        for request in transport.requests.lock().unwrap().iter() {
            assert_ne!(
                request.endpoint,
                p.token_endpoint(),
                "Google is not called directly"
            );
            assert!(request.parameters.iter().all(|(k, _)| k != "client_secret"));
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
        assert_eq!(
            c.session.refresh_token.as_deref(),
            Some("google-private-refresh")
        );
        let public = format!("{result}{}", connection_list_locked(&service).unwrap());
        for secret in [
            "google-private-access",
            "google-private-refresh",
            "4/0Ab-private-code",
            GOOGLE_STATE,
            body["verifier"].as_str().unwrap(),
        ] {
            assert!(!public.contains(secret), "{secret} leaked to IPC");
        }
    }
}

#[tokio::test]
async fn toris_google_refresh_goes_to_the_issuing_broker_and_keeps_the_unrotated_refresh_token() {
    for p in [Provider::Youtube, Provider::GoogleCalendar] {
        let (service, transport) = toris_service();
        let mut c = sample("UC_toris");
        c.platform = p.id().into();
        if p == Provider::GoogleCalendar {
            c.identities = vec![RemoteIdentity {
                account_id: "studio-calendar".into(),
                title: "Toris Studio 캘린더".into(),
            }];
        }
        c.client = ClientConfig {
            client_id: "toris-desktop.apps.googleusercontent.com".into(),
            redirect_uri: toris_redirect(p).into(),
            mode: ClientMode::Toris,
            broker: Some("https://broker.example.test".into()),
            ..Default::default()
        };
        c.session = session_from_response(
            &json!({"access_token":"old","expires_in":10,"refresh_token":"google-kept-refresh"}),
            None,
            100_000,
            false,
        )
        .unwrap();
        commit_connection(&service, &c).unwrap();
        transport.responses.lock().unwrap().push_back(Ok(
            json!({"v":1,"access_token":"fresh","token_type":"bearer","expires_in":3599,"long_lived":false}),
        ));
        if p == Provider::Youtube {
            transport.responses.lock().unwrap().push_back(Ok(
                json!({"items":[{"id":"UC_toris","snippet":{"title":"Toris"}}]}),
            ));
        }
        refresh_connection_locked(&service, &c.id, false)
            .await
            .unwrap();
        let last = transport
            .broker_requests
            .lock()
            .unwrap()
            .last()
            .unwrap()
            .clone();
        assert_eq!(
            (last.base.as_str(), last.path.as_str()),
            (
                "https://broker.example.test",
                format!("/v1/oauth/{}/refresh", p.id()).as_str()
            )
        );
        assert_eq!(
            last.body.unwrap(),
            json!({"refreshToken":"google-kept-refresh"})
        );
        let after = read_connection(&service, &c.id).unwrap();
        assert_eq!(after.session.access_token, "fresh");
        assert_eq!(
            after.session.refresh_token.as_deref(),
            Some("google-kept-refresh")
        );
        assert!(transport
            .requests
            .lock()
            .unwrap()
            .iter()
            .all(|r| r.endpoint != p.token_endpoint()));
    }
}

#[tokio::test]
async fn own_google_client_connections_still_refresh_directly_with_their_secret() {
    let (service, transport) = toris_service();
    let mut c = sample("UC_mine");
    c.platform = "youtube".into();
    c.client = client(Provider::Youtube);
    c.session = session_from_response(
        &json!({"access_token":"old","expires_in":10,"refresh_token":"mine-refresh"}),
        None,
        100_000,
        false,
    )
    .unwrap();
    commit_connection(&service, &c).unwrap();
    transport.responses.lock().unwrap().extend([
        Ok(json!({"access_token":"fresh","expires_in":3599})),
        Ok(json!({"items":[{"id":"UC_mine","snippet":{"title":"Mine"}}]})),
    ]);
    refresh_connection_locked(&service, &c.id, false)
        .await
        .unwrap();
    assert!(transport.broker_requests.lock().unwrap().is_empty());
    let requests = transport.requests.lock().unwrap();
    let first = &requests[0];
    assert_eq!(first.endpoint, "https://oauth2.googleapis.com/token");
    assert!(first
        .parameters
        .contains(&("client_secret".into(), "fixture-secret".into())));
}

#[tokio::test]
async fn toris_google_failures_need_a_new_login_only_when_the_grant_was_rejected() {
    for (answer, reconnect) in [
        (
            json!({"v":1,"error":{"code":"provider_rejected","retryable":false}}),
            true,
        ),
        (
            json!({"v":1,"error":{"code":"provider_unavailable","retryable":true}}),
            false,
        ),
        (
            json!({"v":1,"error":{"code":"unsupported_platform","retryable":false}}),
            false,
        ),
    ] {
        let (service, transport) = toris_service();
        let mut c = sample("studio-calendar");
        c.platform = "google_calendar".into();
        c.client = ClientConfig {
            redirect_uri: toris_redirect(Provider::GoogleCalendar).into(),
            mode: ClientMode::Toris,
            broker: Some(TORIS_BROKER.into()),
            ..Default::default()
        };
        c.session = session_from_response(
            &json!({"access_token":"google-private-access","expires_in":10,"refresh_token":"google-private-refresh"}),
            None,
            100_000,
            false,
        )
        .unwrap();
        commit_connection(&service, &c).unwrap();
        transport
            .responses
            .lock()
            .unwrap()
            .push_back(Err(broker_failure(&answer)));
        let error = refresh_connection_locked(&service, &c.id, false)
            .await
            .unwrap_err();
        let public = format!("{error}{}", connection_list_locked(&service).unwrap());
        for secret in ["google-private-access", "google-private-refresh"] {
            assert!(!public.contains(secret), "{secret} leaked: {error}");
        }
        assert_eq!(
            read_connection(&service, &c.id)
                .unwrap()
                .session
                .needs_reconnect,
            reconnect,
            "{answer}"
        );
    }
}

#[tokio::test]
async fn toris_youtube_disconnect_revokes_directly_with_google_not_through_the_broker() {
    let (service, transport) = toris_service();
    let mut c = sample("UC_toris");
    c.platform = "youtube".into();
    c.client = ClientConfig {
        redirect_uri: toris_redirect(Provider::Youtube).into(),
        mode: ClientMode::Toris,
        broker: Some(TORIS_BROKER.into()),
        ..Default::default()
    };
    c.session.refresh_token = Some("toris-private-refresh".into());
    save_connection(&service, &c).unwrap();
    transport.responses.lock().unwrap().push_back(Ok(json!({})));
    disconnect_connection(&service, &c.id).await.unwrap();
    assert!(transport.broker_requests.lock().unwrap().is_empty());
    let requests = transport.requests.lock().unwrap();
    assert_eq!(requests.len(), 1);
    assert_eq!(requests[0].endpoint, "https://oauth2.googleapis.com/revoke");
    assert_eq!(
        requests[0].parameters,
        vec![("token".into(), "toris-private-refresh".into())]
    );
}

#[tokio::test]
async fn google_offers_toris_or_the_users_own_client_and_no_built_in_secretless_mode() {
    let (service, _) = toris_service();
    for p in [Provider::Youtube, Provider::GoogleCalendar] {
        let row = provider_row(&service.status_locked(), p.id());
        assert_eq!(
            row["clientConfigured"], false,
            "no default client without the broker"
        );
        assert!(row.get("builtinAvailable").is_none() && row.get("googleTesting").is_none());
        assert!(service
            .save_client(p, json!({"mode":"builtin"}))
            .await
            .is_err());
        service
            .save_client(p, json!({"mode":"toris"}))
            .await
            .unwrap();
        let saved = service.client_for(p).unwrap().unwrap();
        assert_eq!(
            (saved.mode, saved.client_secret, saved.redirect_uri),
            (ClientMode::Toris, None, p.default_redirect())
        );
        assert_eq!(
            provider_row(&service.status_locked(), p.id())["clientMode"],
            "toris"
        );
    }
}

#[tokio::test]
async fn only_toris_youtube_access_reports_the_shared_google_quota() {
    for (mode, shared) in [(ClientMode::Toris, true), (ClientMode::Developer, false)] {
        let (service, _) = toris_service();
        let mut c = sample("UC_quota");
        c.platform = "youtube".into();
        c.client = if mode == ClientMode::Toris {
            ClientConfig {
                redirect_uri: toris_redirect(Provider::Youtube).into(),
                mode,
                broker: Some(TORIS_BROKER.into()),
                ..Default::default()
            }
        } else {
            client(Provider::Youtube)
        };
        c.session = session_from_response(
            &json!({"access_token":"live","expires_in":100000,"refresh_token":"rt","scope":"https://www.googleapis.com/auth/youtube.readonly"}),
            None,
            100_000,
            false,
        )
        .unwrap();
        commit_connection(&service, &c).unwrap();
        let access = access_locked(&service, &c.id, "youtube", "UC_quota", &[], false)
            .await
            .unwrap();
        assert_eq!(access.shared_quota, shared);
    }
}
