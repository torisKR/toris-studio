use toris_studio_desktop::publications;

#[test]
fn a_cancelled_browser_exit_restores_publication_operations() {
    assert!(publications::lock_for_update().is_ok());
    assert!(publications::begin_shutdown());
    assert!(publications::lock_for_update().is_err());
    // Browser termination could not be confirmed, so the app stays open.
    publications::cancel_shutdown();
    assert!(publications::lock_for_update().is_ok());
}
