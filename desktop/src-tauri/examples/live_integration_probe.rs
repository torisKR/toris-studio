//! Opt-in real local integration probe. Never prints credentials or publishes content.
//! Reads the installed desktop configuration/vault. All QA rows are rolled back.
use serde_json::{json, Value};
use std::time::Duration;
use toris_studio_desktop::{config::AppConfig, oauth, social, vault};
use uuid::Uuid;

async fn database(config: &AppConfig) -> Result<Value, String> {
    let url = config
        .database_url
        .as_deref()
        .ok_or("database_not_configured")?;
    let (mut client, connection) = tokio::time::timeout(
        Duration::from_secs(5),
        tokio_postgres::connect(url, tokio_postgres::NoTls),
    )
    .await
    .map_err(|_| "database_timeout")?
    .map_err(|_| "database_connection_failed")?;
    let connection_task = tokio::spawn(async move {
        let _ = connection.await;
    });
    let result = async {
        client.batch_execute("SET statement_timeout='5s'; SET lock_timeout='2s'").await.map_err(|_| "database_session_setup_failed")?;
        let role = client.query_one("SELECT current_user::text, current_database()::text, current_setting('server_version')::text, rolsuper FROM pg_roles WHERE rolname=current_user", &[])
            .await.map_err(|_| "database_identity_failed")?;
        let schemas = client.query_one("SELECT count(*)::bigint FROM social_schema_migrations WHERE version='001_social'", &[]).await.map_err(|_| "database_schema_missing")?;
        let migrations:i64 = schemas.get(0);
        let channel_id = Uuid::new_v4(); let content_id = Uuid::new_v4(); let bad_id = Uuid::new_v4();
        let tx = client.transaction().await.map_err(|_| "database_begin_failed")?;
        tx.execute("INSERT INTO social_channels (id,platform,name,handle,url) VALUES ($1,'youtube','Toris live QA temporary','@toris-qa','https://www.youtube.com/@toris-qa')", &[&channel_id]).await.map_err(|_| "database_insert_channel_failed")?;
        tx.execute("INSERT INTO social_content (id,platform,channel_id,title,body,status) VALUES ($1,'youtube',$2,'Toris live QA','original','draft')", &[&content_id,&channel_id]).await.map_err(|_| "database_insert_content_failed")?;
        tx.execute("UPDATE social_content SET body='QA verified',status='ready' WHERE id=$1", &[&content_id]).await.map_err(|_| "database_update_failed")?;
        let content=tx.query_one("SELECT body,status FROM social_content WHERE id=$1", &[&content_id]).await.map_err(|_| "database_readback_failed")?;
        let body:String=content.get(0); let status:String=content.get(1);
        if body!="QA verified" || status!="ready" { return Err("database_readback_mismatch".into()); }
        tx.batch_execute("SAVEPOINT cross_platform").await.map_err(|_|"database_savepoint_failed")?;
        let rejected=tx.execute("INSERT INTO social_content (id,platform,channel_id,title,status) VALUES ($1,'threads',$2,'Invalid QA','draft')", &[&bad_id,&channel_id]).await;
        let foreign_key_enforced=rejected.as_ref().err().and_then(|e|e.as_db_error()).is_some_and(|e|e.code().code()=="23503");
        tx.batch_execute("ROLLBACK TO SAVEPOINT cross_platform").await.map_err(|_|"database_savepoint_restore_failed")?;
        tx.rollback().await.map_err(|_|"database_rollback_failed")?;
        let remaining=client.query_one("SELECT (SELECT count(*) FROM social_channels WHERE id=$1)+(SELECT count(*) FROM social_content WHERE id=$2)", &[&channel_id,&content_id]).await.map_err(|_|"database_cleanup_check_failed")?;
        let remaining:i64=remaining.get(0);
        if !foreign_key_enforced || remaining!=0 { return Err("database_constraints_or_cleanup_failed".into()); }
        let dashboard=social::dashboard(config).await.map_err(|_|"native_dashboard_failed")?;
        Ok(json!({"status":"passed","role":role.get::<_,String>(0),"database":role.get::<_,String>(1),"postgresVersion":role.get::<_,String>(2),"superuser":role.get::<_,bool>(3),"schema001Present":migrations==1,"insertReadUpdate":true,"foreignKeyEnforced":foreign_key_enforced,"rollbackConfirmed":true,"remainingQaRows":remaining,"nativeDashboardConnected":dashboard.database.connected,"dashboardCounts":{"channels":dashboard.channels.len(),"content":dashboard.content.len(),"trends":dashboard.trends.len()}}))
    }.await;
    drop(client);
    connection_task.abort();
    result
}

#[tokio::main]
async fn main() {
    if !std::env::args().any(|arg| arg == "--live") {
        eprintln!("Pass --live to inspect the actual local configuration and database.");
        std::process::exit(2);
    }
    let mut report = json!({"checkedAt":chrono::Utc::now().to_rfc3339(),"realEnvironment":true,"publicPostsCreated":0,"modelCalls":0});
    match AppConfig::load() {
        Ok(config) => {
            report["configuration"] = json!({"status":"loaded","databaseConfigured":config.database_url.is_some(),"youtubeApiKeyConfigured":config.youtube_api_key.is_some(),"naverSearchConfigured":config.naver_client_id.is_some() && config.naver_client_secret.is_some()});
            report["database"] = match database(&config).await {
                Ok(result) => result,
                Err(code) => json!({"status":"blocked","code":code}),
            };
        }
        Err(_) => {
            report["configuration"] =
                json!({"status":"blocked","code":"configuration_or_vault_unavailable"})
        }
    }
    report["oauth"] = match oauth::status().await {
        Ok(value) => {
            let providers:Vec<Value>=value["providers"].as_array().into_iter().flatten().map(|p|json!({"platform":p["platform"],"clientConfigured":p["clientConfigured"],"connected":p["connected"],"needsReconnect":p["needsReconnect"],"refreshable":p["refreshable"],"pending":p["pending"],"expiresAt":p["expiresAt"]})).collect();
            json!({"status":"inspected_saved_state","providers":providers,"providerRoundtripTested":false})
        }
        Err(_) => json!({"status":"blocked","code":"oauth_store_unavailable"}),
    };
    report["keychainBlocked"] = json!(vault::access_blocked());
    println!("{}", serde_json::to_string_pretty(&report).unwrap());
}
