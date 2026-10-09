//! Explicitly opted-in provider QA. No tokens, identity fields or raw HTTP errors are printed.
use super::*;

async fn authorized_read(provider: Provider, token: &str) -> Result<Value, String> {
    let endpoint = match provider {
        Provider::Youtube => {
            "https://www.googleapis.com/youtube/v3/channels?part=id&mine=true&maxResults=1"
        }
        Provider::NaverBlog => "https://openapi.naver.com/v1/nid/me",
        _ => return Err("provider_not_in_live_read_probe".into()),
    };
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|_| "http_client_unavailable")?;
    let mut auth = reqwest::header::HeaderValue::from_str(&format!("Bearer {token}"))
        .map_err(|_| "invalid_saved_token")?;
    auth.set_sensitive(true);
    let mut response = client
        .get(endpoint)
        .header(reqwest::header::AUTHORIZATION, auth)
        .send()
        .await
        .map_err(|_| "provider_network_error")?;
    let status = response.status().as_u16();
    if !response.status().is_success() {
        return Err(format!("provider_http_{status}"));
    }
    if response
        .content_length()
        .is_some_and(|length| length > MAX_RESPONSE as u64)
    {
        return Err("provider_response_oversized".into());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "provider_response_read_failed")?
    {
        if bytes.len() + chunk.len() > MAX_RESPONSE {
            return Err("provider_response_oversized".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    let body: Value = serde_json::from_slice(&bytes).map_err(|_| "provider_response_invalid")?;
    let valid = match provider {
        Provider::Youtube => body["items"].as_array().is_some() && body.get("error").is_none(),
        Provider::NaverBlog => {
            body["resultcode"] == "00"
                && body["response"]["id"]
                    .as_str()
                    .is_some_and(|id| !id.is_empty())
        }
        _ => false,
    };
    if !valid {
        return Err("provider_identity_not_verified".into());
    }
    Ok(
        json!({"status":"passed","httpStatus":status,"authenticatedRead":true,"identityFieldsRedacted":true}),
    )
}

#[tokio::test]
#[ignore = "requires TORIS_LIVE_OAUTH_QA=1, saved YouTube/Naver grants, network, and OS vault consent; refreshes those grants"]
async fn saved_youtube_and_naver_grants_roundtrip_and_refresh() {
    assert_eq!(
        std::env::var("TORIS_LIVE_OAUTH_QA").as_deref(),
        Ok("1"),
        "Live OAuth QA requires explicit opt-in."
    );
    let mut results = Vec::new();
    for provider in [Provider::Youtube, Provider::NaverBlog] {
        let outcome=async {
            let saved=service().read::<TokenSession>("session",provider)?.ok_or("saved_grant_missing")?;
            let before=authorized_read(provider,&saved.access_token).await;
            let refresh=service().refresh_session(provider).await;
            if refresh.is_err() { return Err(json!({"platform":provider.id(),"status":"failed","before":before.unwrap_or_else(|code|json!({"status":"failed","code":code})),"refresh":"failed"})); }
            let refreshed=service().read::<TokenSession>("session",provider)?.ok_or("refreshed_grant_missing")?;
            let after=authorized_read(provider,&refreshed.access_token).await.map_err(|code|json!({"platform":provider.id(),"status":"failed","afterRefreshCode":code}))?;
            Ok::<Value,Value>(json!({"platform":provider.id(),"status":"passed","before":before.unwrap_or_else(|code|json!({"status":"failed","code":code})),"refreshSucceeded":true,"after":after,"expiresAt":timestamp(refreshed.expires_at),"freshBrowserLoginTested":false,"publicPostCreated":false}))
        }.await;
        results.push(outcome.unwrap_or_else(|error| if error.is_object(){error}else{json!({"platform":provider.id(),"status":"blocked","code":"saved_grant_unavailable"})}));
    }
    println!(
        "{}",
        json!({"checkedAt":Utc::now().to_rfc3339(),"realOAuthQa":results})
    );
    assert!(
        results.iter().all(|result| result["status"] == "passed"),
        "Live provider QA did not pass; see redacted results above."
    );
}
