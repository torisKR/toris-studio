//! Single source of application IPC commands for Tauri dispatch and its ACL manifest.
//! Adding a command here registers its handler and grants it only through main-local.

macro_rules! app_command_registry {
    ($callback:ident) => {
        $callback! {
            [crate::creation_native] creation_bridge_info,
            [crate::creation_native] creation_request_create,
            [crate::creation_native] creation_request_list,
            [crate::creation_native] creation_request_get,
            [crate::creation_native] creation_request_cancel,
            [crate::oauth_native] oauth_connections,
            [crate::oauth_native] oauth_connection_dispatch,
            [crate::desktop] analytics_dispatch,
            [crate::workspace_export] workspace_export_report,
            [crate::motion_native] motion_request_create,
            [crate::motion_native] motion_generate,
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
            [crate::agent_native] ai_status,
            [crate::agent_native] ai_generate,
            [crate::agent_native] ai_generate_image,
            [crate::agent_native] agent_settings_get,
            [crate::agent_native] agent_settings_save,
            [crate::agent_native] agent_call,
            [crate::agent_native] agent_runtime_restart,
            [crate::agent_native] vector_db_start,
            [crate::agent_native] publication_ai_receive,
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
            [crate::desktop] tts_status,
            [crate::desktop] tts_install,
            [crate::desktop] tts_start,
            [crate::desktop] tts_stop,
            [crate::desktop] open_rendered_video,
            [crate::production_native] production_engine_status,
            [crate::production_native] production_engine_install,
            [crate::production_native] production_list,
            [crate::production_native] production_get,
            [crate::production_native] production_create,
            [crate::production_native] production_approve,
            [crate::production_native] production_pause,
            [crate::production_native] production_resume,
            [crate::production_native] production_cancel,
            [crate::production_native] production_retry,
            [crate::production_native] production_update_edit,
            [crate::production_native] production_open_final,
            [crate::production_native] production_save_video,
            [crate::production_native] production_publication_draft,
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
            [crate::planner_native] planner_today,
            [crate::planner_native] planner_save_event,
            [crate::planner_native] planner_delete_event,
            [crate::planner_native] planner_save_work_item,
            [crate::planner_native] planner_conflicts,
            [crate::planner_native] planner_resolve_conflict,
            [crate::planner_native] planner_sync_calendar,
            [crate::ops_native] ops_overview,
            [crate::ops_native] ops_save_product,
            [crate::ops_native] ops_delete_product,
            [crate::ops_native] ops_refresh,
            [crate::ops_native] ops_open_task,
            [crate::ops_native] ops_save_secret,
            [crate::hub_native] hub_start,
            [crate::hub_native] hub_decide,
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
