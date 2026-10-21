//! Opt in only with a disposable database named studio_analytics_test_* on a separate loopback port.
//! TORIS_STUDIO_TEST_DATABASE_URL=... cargo test --no-default-features --test analytics_contract -- --ignored
use serde_json::{json, Value};
use toris_studio_desktop::{analytics, config::AppConfig};
use uuid::Uuid;
static TEST_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
fn configured() -> Result<(AppConfig, String), String> {
    let url = std::env::var("TORIS_STUDIO_TEST_DATABASE_URL")
        .map_err(|_| "Temporary analytics test database URL is required")?;
    let parsed = url::Url::parse(&url).map_err(|_| "Test URL error")?;
    if parsed.host_str() != Some("127.0.0.1")
        || parsed.port() == Some(54329)
        || !parsed.path().starts_with("/studio_analytics_test_")
    {
        return Err("Refusing a non-isolated analytics test database".into());
    }
    Ok((
        AppConfig {
            database_url: Some(url.clone()),
            ..Default::default()
        },
        url,
    ))
}
fn report(account: &str, text: &str) -> Value {
    json!({"action":"importPreview","filename":"fixture.csv","text":text,"platform":"x","accountId":account,"label":"contract fixture","timezone":"Asia/Seoul","aggregation":"period","mapping":{"date":"date","metrics":{"views":"views"}},"definitions":{"views":{"definition":"X report original views","unit":"count"}}})
}
#[tokio::test]
#[ignore = "requires a disposable analytics test PostgreSQL database"]
async fn persisted_import_preview_commit_correction_filters_remove_and_pause() -> Result<(), String>
{
    let _guard = TEST_LOCK.lock().await;
    let (config, url) = configured()?;
    analytics::dispatch(&config, json!({"action":"pause","paused":false})).await?;
    let account = format!("fixture-{}", Uuid::new_v4());
    let initial = analytics::dispatch(&config, json!({"action":"status"})).await?;
    assert_eq!(initial["schemaReady"], true);
    let preview = analytics::dispatch(
        &config,
        report(&account, "date,views\n2026-10-01,0\n2026-10-02,\n"),
    )
    .await?;
    assert_eq!(preview["canCommit"], true);
    assert_eq!(preview["observationCount"], 2);
    let command = json!({"action":"importCommit","previewId":preview["previewId"]});
    let (first, second) = tokio::join!(
        analytics::dispatch(&config, command.clone()),
        analytics::dispatch(&config, command)
    );
    let first = first?;
    let second = second?;
    assert_eq!(first["source"]["id"], second["source"]["id"]);
    assert_ne!(first["idempotent"], second["idempotent"]);
    let source = first["source"]["id"]
        .as_str()
        .ok_or("missing source")?
        .to_string();
    let observed=analytics::dispatch(&config,json!({"action":"query","platform":"x","accountId":account,"sourceKind":"import","from":"2026-10-01","to":"2026-10-02"})).await?;
    let rows = observed["observations"]
        .as_array()
        .ok_or("missing observations")?;
    assert_eq!(rows.len(), 2);
    assert!(rows.iter().any(|v| v["value"].as_f64() == Some(0.)));
    assert!(rows
        .iter()
        .any(|v| v["value"].is_null() && v["status"] == "not_returned"));
    assert!(rows
        .iter()
        .all(|v| v["timezone"] == "Asia/Seoul" && v["sourceKind"] == "import"));
    let empty = analytics::dispatch(
        &config,
        json!({"action":"query","accountId":account,"sourceKind":"api"}),
    )
    .await?;
    assert!(empty["observations"].as_array().unwrap().is_empty());
    let corrected = analytics::dispatch(
        &config,
        report(&account, "date,views\n2026-10-01,10\n2026-10-02,20\n"),
    )
    .await?;
    assert!(analytics::dispatch(
        &config,
        json!({"action":"importCommit","previewId":corrected["previewId"]})
    )
    .await
    .is_err());
    let replacement=analytics::dispatch(&config,json!({"action":"importCommit","previewId":corrected["previewId"],"replaceImportId":source})).await?;
    assert_eq!(replacement["replacedSourceId"], source);
    let observed =
        analytics::dispatch(&config, json!({"action":"query","accountId":account})).await?;
    assert_eq!(observed["observations"].as_array().unwrap().len(), 2);
    assert!(observed["observations"]
        .as_array()
        .unwrap()
        .iter()
        .all(|v| v["value"].as_f64() == Some(10.) || v["value"].as_f64() == Some(20.)));
    let history = analytics::dispatch(
        &config,
        json!({"action":"importHistory","accountId":account}),
    )
    .await?;
    assert_eq!(history["imports"].as_array().unwrap().len(), 2);
    assert!(history["imports"]
        .as_array()
        .unwrap()
        .iter()
        .any(|v| v["status"] == "replaced"));
    let remove = json!({"action":"importRemove","sourceId":replacement["source"]["id"]});
    assert_eq!(
        analytics::dispatch(&config, remove.clone()).await?["removed"],
        true
    );
    assert_eq!(analytics::dispatch(&config, remove).await?["removed"], true);
    let observed =
        analytics::dispatch(&config, json!({"action":"query","accountId":account})).await?;
    assert!(observed["observations"].as_array().unwrap().is_empty());
    // Explicit cache deletion cannot remove manual reports, and import removal cannot remove API data.
    let (client, connection) = tokio_postgres::connect(&url, tokio_postgres::NoTls)
        .await
        .map_err(|_| "test DB connection")?;
    let task = tokio::spawn(async move {
        let _ = connection.await;
    });
    let api = Uuid::new_v4();
    let conn = Uuid::new_v4().to_string();
    client.execute("INSERT INTO analytics_sources(id,source_kind,platform,account_id,connection_id,label,digest) VALUES($1,'api','x',$2,$3,'API fixture',$4)",&[&api,&account,&conn,&api.to_string()]).await.map_err(|_|"fixture API insert")?;
    assert!(analytics::dispatch(
        &config,
        json!({"action":"importRemove","sourceId":api.to_string()})
    )
    .await
    .is_err());
    let cache = analytics::dispatch(
        &config,
        json!({"action":"deleteApiCache","connectionId":conn}),
    )
    .await?;
    assert_eq!(cache["deletedSources"], 1);
    let history = analytics::dispatch(
        &config,
        json!({"action":"importHistory","accountId":account}),
    )
    .await?;
    assert_eq!(history["imports"].as_array().unwrap().len(), 2);
    analytics::dispatch(&config, json!({"action":"pause","paused":true})).await?;
    let reopened = AppConfig {
        database_url: Some(url),
        ..Default::default()
    };
    assert_eq!(
        analytics::dispatch(&reopened, json!({"action":"status"})).await?["paused"],
        true
    );
    assert_eq!(analytics::sync_due(&reopened).await?["paused"], true);
    analytics::dispatch(&config, json!({"action":"pause","paused":false})).await?;
    client
        .execute(
            "DELETE FROM analytics_sources WHERE account_id=$1",
            &[&account],
        )
        .await
        .map_err(|_| "test cleanup sources")?;
    task.abort();
    Ok(())
}
#[tokio::test]
#[ignore = "requires a disposable analytics test PostgreSQL database"]
async fn previews_expire_and_invalid_mapping_cannot_commit() -> Result<(), String> {
    let _guard = TEST_LOCK.lock().await;
    let (config, url) = configured()?;
    analytics::dispatch(&config, json!({"action":"pause","paused":false})).await?;
    let account = format!("fixture-{}", Uuid::new_v4());
    let mut input = report(&account, "date,views\n2026-10-01,1\n");
    input.as_object_mut().unwrap().remove("mapping");
    let p = analytics::dispatch(&config, input).await?;
    assert_eq!(p["canCommit"], false);
    assert!(analytics::dispatch(
        &config,
        json!({"action":"importCommit","previewId":p["previewId"]})
    )
    .await
    .is_err());
    let p = analytics::dispatch(&config, report(&account, "date,views\n2026-10-01,1\n")).await?;
    let id = Uuid::parse_str(p["previewId"].as_str().unwrap()).unwrap();
    let (client, connection) = tokio_postgres::connect(&url, tokio_postgres::NoTls)
        .await
        .map_err(|_| "test connection")?;
    let task = tokio::spawn(async move {
        let _ = connection.await;
    });
    client
        .execute(
            "UPDATE analytics_previews SET expires_at=now()-interval '1 second' WHERE id=$1",
            &[&id],
        )
        .await
        .map_err(|_| "test expire")?;
    assert!(analytics::dispatch(
        &config,
        json!({"action":"importCommit","previewId":id.to_string()})
    )
    .await
    .is_err());
    task.abort();
    Ok(())
}

#[tokio::test]
#[ignore = "requires a disposable analytics test PostgreSQL database"]
async fn manual_report_cannot_bypass_retry_after_and_cache_deletion_clears_only_its_job(
) -> Result<(), String> {
    let _guard = TEST_LOCK.lock().await;
    let (config, url) = configured()?;
    analytics::dispatch(&config, json!({"action":"pause","paused":false})).await?;
    let id = Uuid::new_v4().to_string();
    let other = Uuid::new_v4().to_string();
    let (client, connection) = tokio_postgres::connect(&url, tokio_postgres::NoTls)
        .await
        .map_err(|_| "test connection")?;
    let task = tokio::spawn(async move {
        let _ = connection.await;
    });
    for connection_id in [&id, &other] {
        client.execute("INSERT INTO analytics_jobs(connection_id,platform,account_id,status,next_sync_at,cursor,coverage) VALUES($1,'youtube','fixture-account','rate_limited',now()+interval '24 hours',$2,$3)",&[connection_id,&json!({"reportingJobId":"fixture-job","reportingPageToken":"opaque-page"}),&json!({"returnedFrom":"2026-10-01","isPartial":true})]).await.map_err(|_|"test job insert")?;
    }
    let blocked=analytics::dispatch(&config,json!({"action":"reportQuery","connectionId":id,"platform":"youtube","accountId":"fixture-account","report":"summary","range":"7d"})).await.unwrap_err();
    assert!(blocked.contains("재시도"));
    let view = analytics::dispatch(
        &config,
        json!({"action":"query","platform":"youtube","accountId":"fixture-account"}),
    )
    .await?;
    assert!(view["coverage"]
        .as_array()
        .unwrap()
        .iter()
        .any(|v| v["connectionId"] == id
            && v["cursor"]["reportingJobId"] == "fixture-job"
            && v["status"] == "rate_limited"));
    analytics::dispatch(
        &config,
        json!({"action":"deleteApiCache","connectionId":id}),
    )
    .await?;
    let remaining = client
        .query_one(
            "SELECT count(*) FROM analytics_jobs WHERE connection_id=$1",
            &[&other],
        )
        .await
        .map_err(|_| "test verify")?;
    assert_eq!(remaining.get::<_, i64>(0), 1);
    client
        .execute(
            "DELETE FROM analytics_jobs WHERE connection_id=$1",
            &[&other],
        )
        .await
        .map_err(|_| "test cleanup")?;
    task.abort();
    Ok(())
}

#[tokio::test]
#[ignore = "requires a disposable analytics test PostgreSQL database"]
async fn removed_and_replaced_imports_are_reimportable_and_row_order_deduplicates(
) -> Result<(), String> {
    let _guard = TEST_LOCK.lock().await;
    let (config, _) = configured()?;
    analytics::dispatch(&config, json!({"action":"pause","paused":false})).await?;
    let account = format!("review-{}", Uuid::new_v4());
    let a = "date,views\n2026-10-01,1\n2026-10-02,2\n";
    let b = "date,views\n2026-10-01,10\n2026-10-02,20\n";
    let a_reordered = "date,views\n2026-10-02,2\n2026-10-01,1\n";
    let pa = analytics::dispatch(&config, report(&account, a)).await?;
    let ca = analytics::dispatch(
        &config,
        json!({"action":"importCommit","previewId":pa["previewId"]}),
    )
    .await?;
    analytics::dispatch(
        &config,
        json!({"action":"importRemove","sourceId":ca["source"]["id"]}),
    )
    .await?;
    let pa = analytics::dispatch(&config, report(&account, a)).await?;
    let restored = analytics::dispatch(
        &config,
        json!({"action":"importCommit","previewId":pa["previewId"]}),
    )
    .await?;
    assert_eq!(restored["source"]["status"], "active");
    assert_eq!(restored["idempotent"], false);
    let pb = analytics::dispatch(&config, report(&account, b)).await?;
    let cb=analytics::dispatch(&config,json!({"action":"importCommit","previewId":pb["previewId"],"replaceImportId":restored["source"]["id"]})).await?;
    let pa = analytics::dispatch(&config, report(&account, a)).await?;
    let back=analytics::dispatch(&config,json!({"action":"importCommit","previewId":pa["previewId"],"replaceImportId":cb["source"]["id"]})).await?;
    assert_eq!(back["source"]["status"], "active");
    assert_eq!(back["idempotent"], false);
    let pr = analytics::dispatch(&config, report(&account, a_reordered)).await?;
    let reordered = analytics::dispatch(
        &config,
        json!({"action":"importCommit","previewId":pr["previewId"]}),
    )
    .await?;
    assert_eq!(reordered["idempotent"], true);
    assert_eq!(reordered["source"]["id"], back["source"]["id"]);
    let q = analytics::dispatch(&config, json!({"action":"query","accountId":account})).await?;
    assert_eq!(q["observations"].as_array().unwrap().len(), 2);
    Ok(())
}

#[tokio::test]
#[ignore = "requires a disposable analytics test PostgreSQL database"]
async fn expired_youtube_cache_is_hidden_and_deleted_even_when_paused_without_touching_imports(
) -> Result<(), String> {
    let _guard = TEST_LOCK.lock().await;
    let (config, url) = configured()?;
    analytics::dispatch(&config, json!({"action":"pause","paused":false})).await?;
    let account = format!("review-{}", Uuid::new_v4());
    let source = Uuid::new_v4();
    let obs = Uuid::new_v4();
    let connection_id = Uuid::new_v4().to_string();
    let (client, connection) = tokio_postgres::connect(&url, tokio_postgres::NoTls)
        .await
        .map_err(|_| "fixture connection")?;
    let task = tokio::spawn(async move {
        let _ = connection.await;
    });
    client.execute("INSERT INTO analytics_sources(id,source_kind,platform,account_id,connection_id,label,digest,metadata,created_at) VALUES($1,'api','youtube',$2,$3,'expired API',$4,$5,now()-interval '31 days')",&[&source,&account,&connection_id,&source.to_string(),&json!({"authorizationVerifiedAt":"2020-01-01T00:00:00Z","authorizationExpiresAt":"2020-01-31T00:00:00Z"})]).await.map_err(|_|"fixture source")?;
    client.execute("INSERT INTO analytics_observations(id,source_id,record_key,metric,period_start,period_end,payload) VALUES($1,$2,'fixture','views','2026-10-01','2026-10-01',$3)",&[&obs,&source,&json!({"platform":"youtube","sourceKind":"api","accountId":account,"contentId":"","metric":"views","value":1})]).await.map_err(|_|"fixture observation")?;
    client.execute("INSERT INTO analytics_jobs(connection_id,platform,account_id,status,next_sync_at,cursor) VALUES($1,'youtube',$2,'rate_limited',now()+interval '12 hours',$3)",&[&connection_id,&account,&json!({"reportIds":["old-report"]})]).await.map_err(|_|"fixture rate limit")?;
    let mut manual = report(&account, "date,views\n2026-10-01,10\n");
    manual["platform"] = json!("youtube");
    let preview = analytics::dispatch(&config, manual).await?;
    analytics::dispatch(
        &config,
        json!({"action":"importCommit","previewId":preview["previewId"]}),
    )
    .await?;
    analytics::dispatch(&config, json!({"action":"pause","paused":true})).await?;
    analytics::sync_due(&config).await?;
    let api = analytics::dispatch(
        &config,
        json!({"action":"query","accountId":account,"sourceKind":"api"}),
    )
    .await?;
    assert!(
        api["observations"].as_array().unwrap().is_empty(),
        "expired YouTube API facts must never be displayed"
    );
    let count = client
        .query_one(
            "SELECT count(*) FROM analytics_sources WHERE id=$1",
            &[&source],
        )
        .await
        .map_err(|_| "fixture count")?;
    assert_eq!(count.get::<_, i64>(0), 0);
    let waiting = client
        .query_opt(
            "SELECT status,cursor FROM analytics_jobs WHERE connection_id=$1",
            &[&connection_id],
        )
        .await
        .map_err(|_| "fixture waiting")?;
    assert!(
        waiting.is_some(),
        "cache expiry must retain an active provider retry deadline"
    );
    let waiting = waiting.unwrap();
    assert_eq!(waiting.get::<_, String>("status"), "rate_limited");
    assert_eq!(waiting.get::<_, Value>("cursor"), json!({}));
    let imported = analytics::dispatch(
        &config,
        json!({"action":"query","accountId":account,"sourceKind":"import"}),
    )
    .await?;
    assert_eq!(imported["observations"].as_array().unwrap().len(), 1);
    analytics::dispatch(&config, json!({"action":"pause","paused":false})).await?;
    task.abort();
    Ok(())
}

#[tokio::test]
#[ignore = "requires a disposable analytics test PostgreSQL database"]
async fn youtube_video_deadlines_and_revocation_preserve_manual_and_other_connections(
) -> Result<(), String> {
    let _guard = TEST_LOCK.lock().await;
    let (config, url) = configured()?;
    analytics::dispatch(&config, json!({"action":"pause","paused":false})).await?;
    let account = format!("lifecycle-{}", Uuid::new_v4());
    let conn = Uuid::new_v4().to_string();
    let other_conn = Uuid::new_v4().to_string();
    let (client, connection) = tokio_postgres::connect(&url, tokio_postgres::NoTls)
        .await
        .map_err(|_| "fixture connection")?;
    let task = tokio::spawn(async move {
        let _ = connection.await;
    });
    let source = Uuid::new_v4();
    let other_source = Uuid::new_v4();
    for (id, connection_id) in [(&source, &conn), (&other_source, &other_conn)] {
        client.execute("INSERT INTO analytics_sources(id,source_kind,platform,account_id,connection_id,label,digest,authorization_verified_at,authorization_expires_at) VALUES($1,'api','youtube',$2,$3,'verified fixture',$4,now(),now()+interval '30 days')",&[id,&account,connection_id,&id.to_string()]).await.map_err(|_|"fixture source")?;
    }
    for (content, deadline) in [
        ("expired-video", "2000-01-01T00:00:00Z"),
        ("current-video", "2090-01-01T00:00:00Z"),
    ] {
        let id = Uuid::new_v4();
        let expires = chrono::DateTime::parse_from_rfc3339(deadline)
            .unwrap()
            .with_timezone(&chrono::Utc);
        client.execute("INSERT INTO analytics_observations(id,source_id,record_key,metric,period_start,period_end,payload,verification_expires_at) VALUES($1,$2,$3,'views','2020-01-01','2020-01-01',$4,$5)",&[&id,&source,&content,&json!({"platform":"youtube","sourceKind":"api","accountId":account,"contentId":content,"metric":"views","value":1}),&expires]).await.map_err(|_|"fixture observation")?;
    }
    let q = analytics::dispatch(
        &config,
        json!({"action":"query","accountId":account,"sourceKind":"api"}),
    )
    .await?;
    let observations = q["observations"].as_array().unwrap();
    assert_eq!(observations.len(), 1);
    assert_eq!(observations[0]["contentId"], "current-video");
    assert!(
        observations[0]["expiresAt"].as_str().is_some(),
        "effective lifecycle expiry must reach the frontend"
    );
    assert!(observations[0]["authorizationExpiresAt"].as_str().is_some());
    assert!(observations[0]["verificationExpiresAt"].as_str().is_some());
    let mut manual = report(&account, "date,views\n2026-10-01,10\n");
    manual["platform"] = json!("youtube");
    let preview = analytics::dispatch(&config, manual).await?;
    analytics::dispatch(
        &config,
        json!({"action":"importCommit","previewId":preview["previewId"]}),
    )
    .await?;
    assert_eq!(
        analytics::purge_youtube_connection(&config, &conn).await?,
        1
    );
    let other = client
        .query_one(
            "SELECT count(*) FROM analytics_sources WHERE id=$1",
            &[&other_source],
        )
        .await
        .map_err(|_| "fixture verify")?;
    assert_eq!(other.get::<_, i64>(0), 1);
    let imported = analytics::dispatch(
        &config,
        json!({"action":"query","accountId":account,"sourceKind":"import"}),
    )
    .await?;
    assert_eq!(imported["observations"].as_array().unwrap().len(), 1);
    task.abort();
    Ok(())
}

#[tokio::test]
#[ignore = "requires a disposable analytics test PostgreSQL database"]
async fn report_owner_aliases_survive_binding_rebinding_correction_and_remove_without_leaks(
) -> Result<(), String> {
    let _guard = TEST_LOCK.lock().await;
    let (config, url) = configured()?;
    let (mut client, connection) = tokio_postgres::connect(&url, tokio_postgres::NoTls)
        .await
        .map_err(|e| e.to_string())?;
    let task = tokio::spawn(async move {
        let _ = connection.await;
    });
    // Match the application's restricted role. Owner-created migrations must grant
    // data access without granting schema ownership or DDL privileges.
    assert_eq!(
        client
            .query_one("SELECT current_user", &[])
            .await
            .map_err(|e| e.to_string())?
            .get::<_, String>(0),
        "toris_app"
    );
    let ddl = client
        .batch_execute("CREATE TABLE analytics_forbidden_ddl_fixture(id integer)")
        .await
        .expect_err("app must not create schema objects");
    assert_eq!(
        ddl.code(),
        Some(&tokio_postgres::error::SqlState::INSUFFICIENT_PRIVILEGE)
    );
    let a = Uuid::new_v4();
    let b = Uuid::new_v4();
    let connection_id = Uuid::new_v4();
    let remote_a = format!("old-{}", Uuid::new_v4());
    let remote_b = format!("next-{}", Uuid::new_v4());
    for channel in [a, b] {
        client.execute("INSERT INTO social_channels(id,platform,name,url) VALUES($1,'x','alias fixture','https://x.com/fixture')",&[&channel]).await.map_err(|e|e.to_string())?;
    }
    // Historical app versions wrote the original remote account ID into imports.
    let preview =
        analytics::dispatch(&config, report(&remote_a, "date,views\n2026-10-01,125\n")).await?;
    let original = analytics::dispatch(
        &config,
        json!({"action":"importCommit","previewId":preview["previewId"]}),
    )
    .await?;
    let original_id = original["source"]["id"]
        .as_str()
        .ok_or("missing original")?
        .to_string();
    // Exercise the same pre-upsert transaction hook as native bindChannel.
    for owner in [&remote_a, &remote_b] {
        let tx = client.transaction().await.map_err(|e| e.to_string())?;
        analytics::remember_report_owners(&tx, &a, "x", owner).await?;
        tx.execute("INSERT INTO social_channel_connections(channel_id,connection_id,platform,account_id) VALUES($1,$2,'x',$3) ON CONFLICT(channel_id) DO UPDATE SET connection_id=EXCLUDED.connection_id,account_id=EXCLUDED.account_id",&[&a,&connection_id,owner]).await.map_err(|e|e.to_string())?;
        tx.commit().await.map_err(|e| e.to_string())?;
    }
    let history = analytics::dispatch(
        &config,
        json!({"action":"importHistory","channelId":a.to_string(),"platform":"x"}),
    )
    .await?;
    assert_eq!(history["imports"].as_array().unwrap().len(), 1);
    assert_eq!(history["imports"][0]["accountId"], remote_a);
    assert_eq!(history["imports"][0]["reportChannelId"], a.to_string());
    let query = analytics::dispatch(
        &config,
        json!({"action":"query","channelId":a.to_string(),"sourceKind":"import"}),
    )
    .await?;
    assert_eq!(query["observations"].as_array().unwrap().len(), 1);
    assert_eq!(query["observations"][0]["value"], 125.);
    assert_eq!(query["observations"][0]["accountId"], remote_a);
    assert_eq!(query["observations"][0]["reportChannelId"], a.to_string());
    // Another channel reuses that exact remote identity. Its report/history must
    // not inherit A's aliases; new reports still use B's stable local owner.
    let tx = client.transaction().await.map_err(|e| e.to_string())?;
    analytics::remember_report_owners(&tx, &b, "x", &remote_a).await?;
    tx.execute("INSERT INTO social_channel_connections(channel_id,connection_id,platform,account_id) VALUES($1,$2,'x',$3)",&[&b,&connection_id,&remote_a]).await.map_err(|e|e.to_string())?;
    tx.commit().await.map_err(|e| e.to_string())?;
    let mut other_input = report(&b.to_string(), "date,views\n2026-10-01,999\n");
    other_input["channelId"] = json!(b.to_string());
    let other = analytics::dispatch(&config, other_input).await?;
    analytics::dispatch(
        &config,
        json!({"action":"importCommit","previewId":other["previewId"]}),
    )
    .await?;
    let other_rows = analytics::dispatch(
        &config,
        json!({"action":"query","channelId":b.to_string(),"sourceKind":"import"}),
    )
    .await?;
    assert_eq!(other_rows["observations"].as_array().unwrap().len(), 1);
    assert_eq!(other_rows["observations"][0]["value"], 999.);
    let mut wrong = report(&remote_a, "date,views\n2026-10-01,888\n");
    wrong["channelId"] = json!(b.to_string());
    wrong["replaceImportId"] = json!(original_id);
    assert!(analytics::dispatch(&config, wrong).await.is_err());
    assert!(analytics::dispatch(
        &config,
        json!({"action":"importRemove","channelId":b.to_string(),"sourceId":original_id})
    )
    .await
    .is_err());
    // Select the historical source before preview. Its original owner is pinned,
    // and an altered replacement ID at commit is rejected without any mutation.
    let mut correction = report(&remote_a, "date,views\n2026-10-01,130\n");
    correction["channelId"] = json!(a.to_string());
    correction["replaceImportId"] = json!(original_id);
    let reviewed = analytics::dispatch(&config, correction).await?;
    assert!(analytics::dispatch(
        &config,
        json!({"action":"importCommit","previewId":reviewed["previewId"]})
    )
    .await
    .is_err());
    assert!(analytics::dispatch(&config,json!({"action":"importCommit","previewId":reviewed["previewId"],"replaceImportId":other_rows["observations"][0]["sourceId"]})).await.is_err());
    let corrected=analytics::dispatch(&config,json!({"action":"importCommit","previewId":reviewed["previewId"],"replaceImportId":original_id})).await?;
    assert_eq!(corrected["source"]["accountId"], remote_a);
    let history = analytics::dispatch(
        &config,
        json!({"action":"importHistory","channelId":a.to_string()}),
    )
    .await?;
    let sources = history["imports"].as_array().unwrap();
    assert_eq!(sources.len(), 2);
    assert_eq!(
        sources.iter().filter(|s| s["status"] == "active").count(),
        1
    );
    assert_eq!(
        sources.iter().filter(|s| s["status"] == "replaced").count(),
        1
    );
    let query = analytics::dispatch(
        &config,
        json!({"action":"query","channelId":a.to_string(),"sourceKind":"import"}),
    )
    .await?;
    assert_eq!(query["observations"].as_array().unwrap().len(), 1);
    assert_eq!(query["observations"][0]["value"], 130.);
    assert_eq!(
        query["observations"][0]["definition"],
        "X report original views"
    );
    assert_eq!(query["observations"][0]["timezone"], "Asia/Seoul");
    assert_eq!(query["observations"][0]["periodStart"], "2026-10-01");
    analytics::dispatch(&config,json!({"action":"importRemove","channelId":a.to_string(),"sourceId":corrected["source"]["id"]})).await?;
    assert!(analytics::dispatch(
        &config,
        json!({"action":"query","channelId":a.to_string(),"sourceKind":"import"})
    )
    .await?["observations"]
        .as_array()
        .unwrap()
        .is_empty());
    let history = analytics::dispatch(
        &config,
        json!({"action":"importHistory","channelId":a.to_string()}),
    )
    .await?;
    assert_eq!(history["imports"].as_array().unwrap().len(), 2);
    assert_eq!(
        history["imports"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|s| s["status"] == "removed")
            .count(),
        1
    );
    // Deleting a local channel must not make its retained original identities
    // available to be claimed by a different channel later.
    client
        .execute("DELETE FROM social_channels WHERE id=$1", &[&a])
        .await
        .map_err(|e| e.to_string())?;
    let tx = client.transaction().await.map_err(|e| e.to_string())?;
    analytics::remember_report_owners(&tx, &b, "x", &remote_a).await?;
    tx.commit().await.map_err(|e| e.to_string())?;
    let retained = client
        .query_one(
            "SELECT channel_id FROM analytics_report_owners WHERE platform='x' AND account_id=$1",
            &[&remote_a],
        )
        .await
        .map_err(|e| e.to_string())?;
    assert_eq!(retained.get::<_, Uuid>(0), a);
    let after_delete = analytics::dispatch(
        &config,
        json!({"action":"importHistory","channelId":b.to_string()}),
    )
    .await?;
    assert_eq!(after_delete["imports"].as_array().unwrap().len(), 1);
    client
        .execute(
            "DELETE FROM analytics_sources WHERE platform='x' AND account_id=ANY($1)",
            &[&vec![remote_a, b.to_string()]],
        )
        .await
        .map_err(|e| e.to_string())?;
    client
        .execute(
            "DELETE FROM social_channels WHERE id=ANY($1)",
            &[&vec![a, b]],
        )
        .await
        .map_err(|e| e.to_string())?;
    drop(client);
    let _ = task.await;
    Ok(())
}
