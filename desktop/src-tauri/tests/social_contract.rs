//! Run only against the explicitly opted-in local DB; records made here are removed.
//! TORIS_STUDIO_TEST_DATABASE_URL=... cargo test --no-default-features --test social_contract -- --ignored
use serde_json::json;
use toris_studio_desktop::{config::AppConfig, social};
use uuid::Uuid;

#[tokio::test]
#[ignore = "requires an explicitly configured local PostgreSQL application-role test database"]
async fn postgres_crud_enforces_channel_platform_and_preserves_concurrent_partial_edits(
) -> Result<(), String> {
    let database_url = std::env::var("TORIS_STUDIO_TEST_DATABASE_URL")
        .map_err(|_| "Set TORIS_STUDIO_TEST_DATABASE_URL for this opt-in test.".to_string())?;
    let config = AppConfig {
        database_url: Some(database_url.clone()),
        ..Default::default()
    };
    config.validate()?;
    let marker = format!("rust-contract-{}", Uuid::new_v4());
    let mut channel_ids = Vec::new();
    let mut content_ids = Vec::new();
    let outcome = async {
        for (platform, url) in [
            ("youtube", "https://www.youtube.com/@contract"),
            ("threads", "https://www.threads.com/@contract"),
            ("naver_blog", "https://blog.naver.com/contract"),
            ("tiktok", "https://www.tiktok.com/@contract"),
            ("instagram", "https://www.instagram.com/contract"),
        ] {
            let record = social::create_channel(
                &config,
                &json!({"platform":platform,"name":marker,"handle":"contract","url":url}),
            )
            .await?;
            channel_ids.push(Uuid::parse_str(&record.id).map_err(|_| "Invalid channel ID")?);
        }
        let record = social::create_content(
            &config,
            &json!({"platform":"youtube","channelId":channel_ids[0].to_string(),
            "title":marker,"body":"original","status":"draft"}),
        )
        .await?;
        content_ids.push(Uuid::parse_str(&record.id).map_err(|_| "Invalid content ID")?);
        if social::create_content(
            &config,
            &json!({"platform":"threads","channelId":channel_ids[0].to_string(),
            "title":marker,"body":"invalid","status":"draft"}),
        )
        .await
        .is_ok()
        {
            return Err("Cross-platform channel mismatch was accepted.".into());
        }
        let title = json!({"title":"concurrent-title"});
        let body = json!({"body":"concurrent-body"});
        let (first, second) = tokio::join!(
            social::update_content(&config, &record.id, &title),
            social::update_content(&config, &record.id, &body)
        );
        first?;
        second?;
        let scheduled = social::update_content(
            &config,
            &record.id,
            &json!({"status":"scheduled","scheduledAt":"2026-10-09T12:00:00+09:00"}),
        )
        .await?;
        if scheduled.title != "concurrent-title"
            || scheduled.body != "concurrent-body"
            || scheduled.scheduled_at.as_deref() != Some("2026-10-09T03:00:00.000Z")
        {
            return Err("Concurrent patches or RFC3339 schedule did not persist.".into());
        }
        if social::update_content(
            &config,
            &record.id,
            &json!({"status":"published","url":"https://www.instagram.com/invalid"}),
        )
        .await
        .is_ok()
        {
            return Err("Cross-platform published URL was accepted.".into());
        }
        let published = social::update_content(
            &config,
            &record.id,
            &json!({"status":"published","url":"https://www.youtube.com/watch?v=abcdefghijk"}),
        )
        .await?;
        if published.status != "published" {
            return Err("Published record did not persist.".into());
        }
        let dashboard = social::dashboard(&config).await?;
        if !dashboard.database.connected
            || !dashboard.content.iter().any(|item| item.id == record.id)
        {
            return Err("Dashboard did not return persisted content.".into());
        }
        Ok::<_, String>(())
    }
    .await;
    // Clean only the random IDs inserted by this test, even when a contract check fails.
    let (client, connection) = tokio_postgres::connect(&database_url, tokio_postgres::NoTls)
        .await
        .map_err(|_| "Test cleanup connection failed.".to_string())?;
    let task = tokio::spawn(async move {
        let _ = connection.await;
    });
    for id in &content_ids {
        client
            .execute("DELETE FROM social_content WHERE id=$1", &[id])
            .await
            .map_err(|_| "Test cleanup failed.")?;
    }
    for id in &channel_ids {
        client
            .execute("DELETE FROM social_channels WHERE id=$1", &[id])
            .await
            .map_err(|_| "Test cleanup failed.")?;
    }
    task.abort();
    outcome
}
