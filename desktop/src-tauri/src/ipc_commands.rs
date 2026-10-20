//! Single source of application IPC commands for Tauri dispatch and its ACL manifest.
//! Adding a command here registers its handler and grants it only through main-local.

macro_rules! app_command_registry {
    ($callback:ident) => {
        $callback! {
            [crate::motion_native] motion_request_create,
            [crate::motion_native] motion_request_list,
            [crate::motion_native] motion_draft_apply,
            [crate::motion_native] motion_draft_preview,
            [crate::motion_native] motion_request_cancel,
            [crate::motion_native] motion_preview,
            [crate::motion_native] motion_preview_video,
            [crate::motion_native] motion_import_image,
            [crate::motion_native] motion_save_video,

            [crate::native_windows] set_main_activity,
            [crate::native_windows] native_open_render_preview,
            [crate::integration_native] codexify_connection_get,
            [crate::integration_native] codexify_connection_save,
            [crate::integration_native] codexify_connection_check,
            [crate::integration_native] codexify_chats,
            [crate::integration_native] codexify_chat_read,
            [crate::integration_native] codexify_chat_send,
            [crate::publication_native] publication_list,
            [crate::publication_native] publication_get,
            [crate::publication_native] publication_save,
            [crate::publication_native] publication_preflight,
            [crate::publication_native] publication_submit,
            [crate::publication_native] publication_cancel,
            [crate::publication_native] publication_retry,
            [crate::publication_native] publication_reconcile,
            [crate::publication_native] publication_export_handoff,
            [crate::publication_native] publication_confirm_handoff,
            [crate::publication_native] publication_accounts,
            [crate::publication_native] publication_begin_login,
            [crate::publication_native] publication_scheduler_status,
            [crate::publication_native] publication_set_paused,
            [crate::publication_native] publication_media_sources,
            [crate::publication_native] publication_import_media,
            [crate::publication_native] publication_preview_media,
            [crate::publication_native] publication_ai_request,
            [crate::publication_native] publication_ai_drafts,
            [crate::integration_native] codexify_runtime_status,
            [crate::integration_native] codexify_runtime_configure,
            [crate::integration_native] codexify_runtime_start,
            [crate::integration_native] codexify_runtime_stop,
            [crate::integration_native] codexify_runtime_doctor,
            [crate::integration_native] codexify_proxy_status,
            [crate::integration_native] codexify_proxy_start,
            [crate::integration_native] codexify_proxy_stop,
            [crate::integration_native] integration_status,
            [crate::integration_native] integration_upload_login,
            [crate::integration_native] integration_channels,
            [crate::integration_native] integration_choose_video,
            [crate::integration_native] integration_sample_video,
            [crate::integration_native] integration_prepare_upload,
            [crate::integration_native] integration_upload,
            [crate::integration_native] integration_acknowledge_upload,
            [crate::assets::native] asset_command,
            [crate::assets::native] asset_choose_folder,
            [crate::assets::native] asset_choose_files,
            [crate::assets::native] asset_reveal,
            [crate::desktop] get_dashboard,
            [crate::desktop] get_update_status,
            [crate::desktop] check_for_updates,
            [crate::desktop] install_update,
            [crate::desktop] cancel_update,
            [crate::desktop] create_channel,
            [crate::desktop] create_content,
            [crate::desktop] update_content,
            [crate::desktop] refresh_trends,
            [crate::desktop] ai_status,
            [crate::desktop] ai_generate,
            [crate::desktop] get_settings,
            [crate::desktop] get_keychain_status,
            [crate::desktop] retry_keychain_access,
            [crate::desktop] get_saved_collection_secret,
            [crate::desktop] save_settings,
            [crate::desktop] get_scheduler_status,
            [crate::desktop] set_scheduler,
            [crate::desktop] open_external,
            [crate::desktop] browser_runtime_status,
            [crate::desktop] save_browser_preferences,
            [crate::desktop] copy_text,
            [crate::desktop] start_database,
            [crate::desktop] backup_database,
            [crate::desktop] start_keyword_crawler,
            [crate::desktop] video_list_projects,
            [crate::desktop] video_save_project,
            [crate::desktop] video_template_catalog,
            [crate::desktop] video_template_preview,
            [crate::desktop] video_template_library_get,
            [crate::desktop] video_template_favorite,
            [crate::desktop] video_template_record_use,
            [crate::desktop] video_export_project,
            [crate::desktop] video_research_preview,
            [crate::desktop] video_create_research_project,
            [crate::desktop] video_create_idea_project,
            [crate::desktop] video_render_project,
            [crate::desktop] video_generate_voice,
            [crate::desktop] media_status,
            [crate::desktop] open_rendered_video,
            [crate::desktop] youtube_lookup_channel,
            [crate::desktop] youtube_channel_videos,
            [crate::desktop] prepare_youtube_embed,
            [crate::desktop] get_keyword_status,
            [crate::desktop] search_keywords,
            [crate::desktop] get_content_keywords,
            [crate::desktop] get_keyword_runs,
            [crate::desktop] crawl_keyword_content,
            [crate::desktop] cancel_keyword_search,
            [crate::desktop] oauth_status,
            [crate::desktop] oauth_save_client,
            [crate::desktop] oauth_begin_login,
            [crate::desktop] oauth_complete_login,
            [crate::desktop] oauth_refresh_session,
            [crate::desktop] oauth_disconnect,
        }
    };
}

macro_rules! command_names {
    ($( [$($module:ident)::*] $command:ident, )*) => {
        pub const COMMANDS: &[&str] = &[$(stringify!($command)),*];
    };
}
app_command_registry!(command_names);

#[allow(unused_imports)]
pub(crate) use app_command_registry;

pub const MAIN_PERMISSION: &str = "main-window-commands";
pub const CORE_PERMISSIONS: &[&str] = &["core:event:allow-listen", "core:event:allow-unlisten"];

/// Build one explicit permission from the same registry used by invoke_handler.
/// Command names come from Rust identifiers, so they require no JSON escaping.
pub fn permission_definition() -> String {
    let commands = COMMANDS
        .iter()
        .map(|command| format!("\"{command}\""))
        .collect::<Vec<_>>()
        .join(",");
    format!(
        r#"{{"permission":[{{"identifier":"{MAIN_PERMISSION}","description":"Application commands for the bundled main webview.","commands":{{"allow":[{commands}],"deny":[]}}}}]}}"#
    )
}
