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
