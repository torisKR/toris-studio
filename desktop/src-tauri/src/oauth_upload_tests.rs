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
    assert!(authorization_url_for_mode(Provider::Threads, &client, "state", None, true).is_err());
}
