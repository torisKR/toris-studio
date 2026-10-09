use super::*;
#[test]
fn legacy_tokens_do_not_claim_upload_permission_and_refresh_preserves_verified_scopes() {
    let old = session_from_response(
        &json!({"access_token":"test-token","expires_in":3600}),
        None,
        100,
        false,
    )
    .unwrap();
    assert!(!has_upload_scope(&old.scopes));
    let known=session_from_response(&json!({"access_token":"test-token","expires_in":3600,"scope":format!("{} {}",YOUTUBE_UPLOAD_SCOPE,Provider::Youtube.basic_scope())}),None,100,false).unwrap();
    assert!(has_upload_scope(&known.scopes));
    let rotated = session_from_response(
        &json!({"access_token":"rotated-token","expires_in":3600}),
        Some(&known),
        120,
        false,
    )
    .unwrap();
    assert_eq!(known.scopes, rotated.scopes);
    let reduced=session_from_response(&json!({"access_token":"reduced-token","expires_in":3600,"scope":Provider::Youtube.basic_scope()}),Some(&known),120,false).unwrap();
    assert!(!has_upload_scope(&reduced.scopes));
}
#[test]
fn upload_consent_is_explicit_and_does_not_change_default_login_scopes() {
    let client = ClientConfig {
        tiktok_audit_declared: false,
        client_id: "test.apps.googleusercontent.com".into(),
        client_secret: None,
        redirect_uri: Provider::Youtube.default_redirect(),
    };
    let read = authorization_url_for_mode(
        Provider::Youtube,
        &client,
        "random-state",
        Some("verifier"),
        false,
    )
    .unwrap();
    let write = authorization_url_for_mode(
        Provider::Youtube,
        &client,
        "random-state",
        Some("verifier"),
        true,
    )
    .unwrap();
    let scopes = |raw: String| {
        Url::parse(&raw)
            .unwrap()
            .query_pairs()
            .find(|(k, _)| k == "scope")
            .unwrap()
            .1
            .into_owned()
    };
    assert!(!scopes(read).contains(YOUTUBE_UPLOAD_SCOPE));
    assert!(scopes(write).contains(YOUTUBE_UPLOAD_SCOPE));
    assert!(authorization_url_for_mode(Provider::NaverBlog, &client, "state", None, true).is_err());
}

#[test]
fn all_publishing_grants_are_explicit_and_meta_permissions_are_verified() {
    for provider in PROVIDERS {
        let scopes = |publish| {
            Url::parse(
                &authorization_url_for_mode(
                    provider,
                    &ClientConfig {
                        tiktok_audit_declared: false,
                        client_id: "fixture".into(),
                        client_secret: Some("fixture-secret".into()),
                        redirect_uri: provider.default_redirect(),
                    },
                    "state",
                    None,
                    publish,
                )
                .unwrap(),
            )
            .unwrap()
            .query_pairs()
            .find(|(key, _)| key == "scope")
            .map(|(_, value)| value.into_owned())
            .unwrap_or_default()
        };
        assert!(!provider.publishing_authorized(
            &scopes(false)
                .split(|c: char| c == ',' || c.is_whitespace())
                .map(str::to_owned)
                .collect::<Vec<_>>()
        ));
        if provider.publishing_scope().is_some() {
            assert!(provider.publishing_authorized(
                &scopes(true)
                    .split(|c: char| c == ',' || c.is_whitespace())
                    .map(str::to_owned)
                    .collect::<Vec<_>>()
            ));
        }
    }
    assert_eq!(granted_permissions(&json!({"data":[{"permission":"pages_manage_posts","status":"granted"},{"permission":"pages_show_list","status":"declined"}]})).unwrap(),vec!["pages_manage_posts"]);
    assert!(granted_permissions(&json!({"access_token":"fixture-secret"})).is_err());
}
#[test]
fn comma_delimited_tiktok_scopes_and_facebook_refresh_use_official_exchange() {
    let session = session_from_response(
        &json!({"access_token":"fixture","expires_in":3600,"scope":"user.info.basic,video.upload"}),
        None,
        100,
        false,
    )
    .unwrap();
    assert!(Provider::Tiktok.publishing_authorized(&session.scopes));
    assert!(!session.scopes.iter().any(|scope| scope == "video.publish"));
    let client = ClientConfig {
        tiktok_audit_declared: false,
        client_id: "fixture-id".into(),
        client_secret: Some("fixture-secret".into()),
        redirect_uri: "https://example.test/callback".into(),
    };
    let request = refresh_request(Provider::Facebook, &client, &session);
    assert_eq!(
        request.endpoint,
        "https://graph.facebook.com/v25.0/oauth/access_token"
    );
    assert!(request
        .parameters
        .contains(&("grant_type".into(), "fb_exchange_token".into())));
}
