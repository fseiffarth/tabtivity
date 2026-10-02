//! The command class table — hosted plan §3.3 (`docs/tabtivity_hosted_plan.md`).
//!
//! Every Tauri command the window can invoke (the `generate_handler!` list in
//! `lib.rs`) has exactly one [`CommandClass`], which says where it runs once
//! the backend is a per-user daemon and the window a thin client:
//!
//! - `Core`: the user's daemon. Projects, files, git, terminals, agents, mail,
//!   calendar, local models — anything whose data lives where the daemon runs.
//!   Exposed over the network.
//! - `Client`: the machine the user sits at. Clipboard, screenshots, native
//!   print, OS windows and workspaces, this machine's sensors, open-outside.
//!   Never exposed; a browser client adapts or hides the control.
//! - `Admin`: the server as a whole (OpenVPN, global machines, VMs, containers,
//!   app and dev builds). Admin role only, or disabled.
//! - `Off(reason)`: nothing in server mode can do it; refused with the named
//!   reason so the UI can say why.
//!
//! There is **no default class**: a command added without a row fails
//! [`tests::every_registered_command_has_a_class`], so a forgotten command can
//! never quietly land in `Core`. The table is keyed by the bare command name
//! (what the frontend's `invoke` passes), which Tauri already requires to be
//! unique. The table also drives `server_capabilities` and the generated
//! `commandClasses.ts` once P2 lands; keep it `AppHandle`-free.
//!
//! Rows that look misplaced, and why they are where they are:
//! - `pty_set_visible`, `complete_text` and the `copilot_*` commands take a
//!   `Window` today but only to identify the caller (§3.2); they are `Core`.
//! - The five mail commands raising a Rust-side file dialog (`mail_attach_pick`,
//!   `mail_pgp_import_pick`, `mail_contacts_import`, `mail_contacts_export`,
//!   `mail_attachment_save`) stay `Core`: the bytes they read or write are the
//!   daemon's, and P2's server-side file picker replaces the dialog. Every
//!   other path-taking command (`export_project`, `remote_download_to`,
//!   `calendar_read_ics`, …) gets its path from the frontend's own picker.
//! - `dev_todo_*` are `Admin` with `dev_build_*`: they read and write
//!   `todo/*.md` under `dev_build::SOURCE_ROOT`, a checkout path baked into the
//!   binary at build time — the server's, not any user's daemon data.
//! - `install_vibe` and `ensure_vibe_ollama_model` are `Core` although they
//!   install into the daemon user's own `$HOME` (`curl … | bash`, `~/.vibe`),
//!   not the state dir like `install_agent`: still bounded by the user's uid.
//! - `system_monitor_snapshot` is host-aware (a project's remote host, else the
//!   daemon's), so it is `Core`; the bare this-machine `monitor` readings are
//!   `Client` as §3.3 lists them.
//! - Saved-password `*_password_state` / `*_forget_password` commands are
//!   `Core`: §6.8 moves the opt-in store off the OS keychain, the commands'
//!   meaning survives. Only the keychain *unlock* pair is `Off`.
//! - Containers are `Admin` in v1 (§9: the Docker socket is root on the host).

/// Where a command runs once the backend is a daemon (hosted plan §3.3).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum CommandClass {
    /// The user's daemon; exposed over the network.
    Core,
    /// The machine the user sits at; never exposed.
    Client,
    /// The server as a whole; admin role only, or disabled.
    Admin,
    /// Nothing in server mode can do it; refused with the reason.
    Off(OffReason),
}

/// Why a command is `Off` in server mode. Stable tokens (`as_str`), so the
/// frontend can name the reason in its own words.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum OffReason {
    /// Unlocks the desktop's OS credential store (Secret Service / Keychain);
    /// a daemon has no such session (§6.8 replaces the store).
    OsKeychain,
    /// A whole-document save the headless owner replaces with per-operation
    /// commands or compare-and-swap (§3.4, owner plan H1).
    WholeDocumentSave,
    /// The window answering the phone's requests; the headless owner answers
    /// them itself (owner plan H3).
    HeadlessOwner,
    /// Reads the CLI config or login files of *this computer's* own user; on a
    /// server the user signs in through sign-in tabs instead (§5.1).
    LocalCliFiles,
}

impl CommandClass {
    /// The class's wire token: `core`, `client`, `admin` or `off`.
    pub fn as_str(self) -> &'static str {
        match self {
            CommandClass::Core => "core",
            CommandClass::Client => "client",
            CommandClass::Admin => "admin",
            CommandClass::Off(_) => "off",
        }
    }

    /// True for the one class a daemon dispatches.
    pub fn is_core(self) -> bool {
        self == CommandClass::Core
    }
}

impl OffReason {
    /// The reason's wire token.
    pub fn as_str(self) -> &'static str {
        match self {
            OffReason::OsKeychain => "os-keychain",
            OffReason::WholeDocumentSave => "whole-document-save",
            OffReason::HeadlessOwner => "headless-owner",
            OffReason::LocalCliFiles => "local-cli-files",
        }
    }
}

/// The class of one registered command, `None` for a name the table does not
/// know (which the completeness test rules out for every registered command).
pub fn class_of(command: &str) -> Option<CommandClass> {
    TABLE
        .iter()
        .find(|(name, _)| *name == command)
        .map(|(_, class)| *class)
}

/// Every row, in `commands/*.rs` order.
pub fn all() -> &'static [(&'static str, CommandClass)] {
    TABLE
}

/// The names of every command in one class, table order.
pub fn names_in(class: CommandClass) -> impl Iterator<Item = &'static str> {
    TABLE
        .iter()
        .filter(move |(_, c)| *c == class)
        .map(|(name, _)| *name)
}

use CommandClass::{Admin, Client, Core, Off};

/// One row per registered command. Grouped by the `commands/*.rs` file that
/// defines it, which is also how `lib.rs` lists them; keep a new command's row
/// next to its neighbours.
static TABLE: &[(&str, CommandClass)] = &[
    // commands/agent_prompts.rs
    ("agent_prompt_archive", Core),
    ("agent_prompt_blame", Core),
    ("agent_prompt_delete", Core),
    ("agent_prompt_history_clear", Core),
    ("agent_prompt_history_list", Core),
    ("agent_prompt_link_delete", Core),
    ("agent_prompt_links_list", Core),
    ("agent_prompt_link_upsert", Core),
    ("agent_prompt_record", Core),
    ("agent_prompt_reorder", Core),
    ("agent_prompts_list", Core),
    ("agent_prompt_upsert", Core),
    // commands/agents.rs
    ("agent_global_import", Off(OffReason::LocalCliFiles)),
    ("agent_global_open", Client),
    ("agent_global_set_codex_auto_review", Core),
    ("agent_global_status", Core),
    ("agent_is_installed", Core),
    ("agent_login_import", Off(OffReason::LocalCliFiles)),
    ("agent_logins", Core),
    ("agent_login_sign_out", Core),
    ("agent_tab_changes", Core),
    ("agent_tab_goal", Core),
    ("agent_tab_last_prompt", Core),
    ("agent_tab_model", Core),
    ("agent_tab_recent_prompts", Core),
    ("agent_tab_transcript", Core),
    ("agent_tab_undo_clear", Core),
    ("agent_usage", Core),
    ("agent_versions", Core),
    ("agent_warmup", Core),
    ("check_agent_updates", Core),
    ("claude_folder_trusted", Core),
    ("codex_hook_status", Core),
    ("dismiss_agent_version", Core),
    ("install_agent", Core),
    ("install_agent_remote", Core),
    ("install_agent_remote_command", Core),
    ("list_agents", Core),
    ("node_runtime_status", Core),
    ("probe_binaries", Core),
    ("uninstall_agent", Core),
    ("update_agent", Core),
    // commands/agent_tasks.rs
    ("agent_schedule_claim", Core),
    ("agent_schedule_complete", Core),
    ("agent_schedule_delete", Core),
    ("agent_schedules_cleanup_orphans", Core),
    ("agent_schedules_delete_target", Core),
    ("agent_schedules_list", Core),
    ("agent_schedule_upsert", Core),
    ("timer_lease_acquire", Core),
    ("timer_lease_release", Core),
    // commands/apps.rs
    ("cancel_file_drag", Client),
    ("check_pid_alive", Client),
    ("close_tracked_window", Client),
    ("drag_preview_icon", Client),
    ("embed_capability", Client),
    ("get_project_default_apps", Core),
    ("launch_app", Client),
    ("list_installed_apps", Client),
    ("list_tracked_windows", Client),
    ("open_file", Client),
    ("resolve_app_icon", Client),
    ("restore_open_apps", Client),
    ("run_script_detached", Core),
    ("set_project_default_apps", Core),
    ("start_file_drag", Client),
    ("untrack_window", Client),
    // commands/app_update.rs
    ("app_update_releases_url", Admin),
    ("app_update_staged", Admin),
    ("check_app_update", Admin),
    ("download_app_update", Admin),
    ("install_app_update", Admin),
    // commands/boxes.rs
    ("create_box", Core),
    ("delete_box", Core),
    ("ensure_box_folder", Core),
    ("get_boxes", Core),
    ("refresh_box_agent_docs", Core),
    ("rename_box", Core),
    ("save_boxes", Off(OffReason::WholeDocumentSave)),
    ("set_box_members", Core),
    ("set_box_mobile_access", Core),
    ("set_box_relations", Core),
    // commands/brand_migration.rs
    ("legacy_name_status", Core),
    // commands/browser.rs
    ("browser_capabilities", Client),
    ("browser_check_url", Core),
    ("browser_clear_data", Client),
    ("browser_close_live", Client),
    ("browser_download_decide", Client),
    ("browser_list_live", Client),
    ("browser_open_live", Client),
    ("browser_reader_fetch", Core),
    // commands/caldav.rs
    ("caldav_account_delete", Core),
    ("caldav_accounts_list", Core),
    ("caldav_account_upsert", Core),
    ("caldav_apply", Core),
    ("caldav_delete", Core),
    ("caldav_discover", Core),
    ("caldav_fetch", Core),
    ("caldav_forget_password", Core),
    ("caldav_password_state", Core),
    ("caldav_push", Core),
    ("caldav_refresh_access", Core),
    ("caldav_resource_etag", Core),
    // commands/calendar.rs
    ("calendar_alarms_claim", Core),
    ("calendar_fetch_ics", Core),
    ("calendar_load", Core),
    ("calendar_read_ics", Core),
    ("calendar_replace_events", Core),
    ("calendar_save", Core),
    ("calendar_write_ics", Core),
    ("create_calendar", Core),
    ("create_event", Core),
    ("create_task", Core),
    ("delete_calendar", Core),
    ("delete_event", Core),
    ("delete_task", Core),
    ("restore_calendar", Core),
    ("todo_columns_set", Core),
    ("todo_move_tasks", Core),
    ("update_calendar", Core),
    ("update_event", Core),
    ("update_task", Core),
    // commands/clipboard.rs
    ("clipboard_has_image", Client),
    ("copy_png_bytes_to_clipboard", Client),
    ("copy_text_to_clipboard", Client),
    ("save_clipboard_image", Client),
    // commands/copilot.rs
    ("copilot_accepted", Core),
    ("copilot_account", Core),
    ("copilot_cancel", Core),
    ("copilot_close_editor", Core),
    ("copilot_complete", Core),
    ("copilot_finish_sign_in", Core),
    ("copilot_message_action", Core),
    ("copilot_prepare", Core),
    ("copilot_project_policy", Core),
    ("copilot_set_project_policy", Core),
    ("copilot_setup", Core),
    ("copilot_shown", Core),
    ("copilot_sign_in", Core),
    ("copilot_sign_out", Core),
    ("copilot_stop", Core),
    // commands/crash.rs
    ("report_frontend_error", Core),
    // commands/credentials.rs
    ("credential_paste_to_pty", Core),
    ("keyring_state", Off(OffReason::OsKeychain)),
    ("keyring_unlock", Off(OffReason::OsKeychain)),
    // commands/debug.rs
    ("app_build_commit", Core),
    ("debug_app_resource_usage", Client),
    ("dev_build_now", Admin),
    ("dev_build_relaunch", Admin),
    ("dev_build_set_paused", Admin),
    ("dev_build_status", Admin),
    // The checkout under `dev_build::SOURCE_ROOT`, a build-time host path.
    ("dev_todo_groups", Admin),
    ("dev_todo_read", Admin),
    ("dev_todo_write", Admin),
    ("webview_renderer_claim", Client),
    ("webview_renderer_memory", Client),
    ("webview_renderer_restart", Client),
    ("webview_renderer_rss", Client),
    ("webview_rss_kib", Client),
    // commands/default_apps.rs
    ("get_default_apps", Core),
    ("patch_default_apps", Core),
    ("save_default_apps", Off(OffReason::WholeDocumentSave)),
    // commands/disk_usage.rs
    ("disk_usage_cancel", Core),
    ("disk_usage_devices", Core),
    ("disk_usage_scan", Core),
    // commands/exec_trust.rs
    ("exec_trust_approve", Core),
    // commands/format.rs
    ("check_syntax", Core),
    ("format_source", Core),
    ("formatter_available", Core),
    // commands/fs.rs
    ("copy_path", Core),
    ("create_dir", Core),
    ("create_file", Core),
    ("delete_dir", Core),
    ("delete_file", Core),
    ("detect_mime", Core),
    ("dir_size", Core),
    ("dir_size_breakdown", Core),
    ("extract_archive", Core),
    ("file_mtime", Core),
    ("file_source", Core),
    ("import_external_file", Core),
    ("list_dir", Core),
    ("list_dirs", Core),
    ("list_project_endings", Core),
    ("list_project_paths", Core),
    ("list_recent_downloads", Core),
    ("move_path", Core),
    ("project_path_exists", Core),
    ("read_file_bytes", Core),
    ("read_file_text", Core),
    ("rename_path", Core),
    ("update_gitignore_rule", Core),
    ("write_file_bytes", Core),
    ("write_file_text", Core),
    ("write_project_file", Core),
    ("write_project_file_bytes", Core),
    // commands/fs_watch.rs
    ("unwatch_dir", Core),
    ("watch_dir", Core),
    // commands/git.rs
    ("detect_git_providers", Core),
    ("git_add_all", Core),
    ("git_add_path", Core),
    ("git_available", Core),
    ("git_blame", Core),
    ("git_branches", Core),
    ("git_change_stats", Core),
    ("git_checkout", Core),
    ("git_clone", Core),
    ("git_commit", Core),
    ("git_commit_message", Core),
    ("git_diff_file", Core),
    ("git_dirty_probe", Core),
    ("git_file_at_rev", Core),
    ("git_file_log", Core),
    ("git_file_statuses", Core),
    ("git_generate_commit_message", Core),
    ("git_log", Core),
    ("git_log_search", Core),
    ("git_push", Core),
    ("git_release_preview", Core),
    ("git_release_tag", Core),
    ("git_remote_visibility", Core),
    ("git_repo_root", Core),
    ("git_reword_head", Core),
    ("git_status", Core),
    ("git_unpushed_commits", Core),
    ("git_worktree_add", Core),
    ("git_worktree_list", Core),
    ("git_worktree_lock", Core),
    ("git_worktree_prune", Core),
    ("git_worktree_remove", Core),
    ("git_worktree_selection_supported", Core),
    ("git_worktree_unlock", Core),
    // commands/git_fork.rs
    ("git_fork_clone", Core),
    ("provider_cli_available", Core),
    // commands/git_hosting.rs
    ("get_project_git_hosting", Core),
    ("set_project_git_hosting", Core),
    // commands/git_peer.rs
    ("git_peer_backups", Core),
    ("git_peer_checkout", Core),
    ("git_peer_mirror_dir", Core),
    ("git_peer_pair_confirm", Core),
    ("git_peer_resolve", Core),
    ("git_peer_restore_backup", Core),
    ("git_peer_set_enabled", Core),
    ("git_peer_status", Core),
    ("git_peer_sync_now", Core),
    // commands/git_publish.rs
    ("project_has_origin", Core),
    ("publish_project", Core),
    ("set_project_visibility", Core),
    ("switch_project_provider", Core),
    ("unpublish_project", Core),
    // commands/git_pull.rs
    ("git_fetch", Core),
    ("git_merge_abort", Core),
    ("git_merge_commit", Core),
    ("git_merge_sides", Core),
    ("git_merge_state", Core),
    ("git_pull_apply", Core),
    ("git_pull_preview", Core),
    // commands/global_machines.rs
    ("global_machine_add", Admin),
    ("global_machine_monitor_snapshot", Admin),
    ("global_machine_remove", Admin),
    ("global_machine_reorder", Admin),
    ("global_machine_set_auto_connect", Admin),
    ("global_machines_export", Admin),
    ("global_machines_import_read", Admin),
    ("global_machines_list", Admin),
    ("global_machine_tmux_list", Admin),
    ("global_machine_update", Admin),
    ("global_machine_usage_check", Admin),
    // commands/hpc_ws.rs
    ("hpc_scratch_candidates", Core),
    ("hpc_ws_allocate", Core),
    ("hpc_ws_anchor", Core),
    ("hpc_ws_available", Core),
    ("hpc_ws_extend", Core),
    ("hpc_ws_link", Core),
    ("hpc_ws_list", Core),
    ("hpc_ws_move_root", Core),
    ("hpc_ws_pull_logs", Core),
    ("hpc_ws_release", Core),
    ("set_project_hpc", Core),
    // commands/ide.rs
    ("detect_project_ides", Client),
    ("open_project_in_ide", Client),
    ("set_ide_launcher", Client),
    // commands/local_loss.rs
    ("local_loss_ack", Core),
    ("local_loss_list", Core),
    // commands/mail.rs
    ("mail_account_delete", Core),
    ("mail_account_set_ai", Core),
    ("mail_accounts_list", Core),
    ("mail_account_test", Core),
    ("mail_account_upsert", Core),
    ("mail_agent_drafts", Core),
    ("mail_agent_drafts_file", Core),
    ("mail_agent_mark", Core),
    ("mail_agent_mark_folder", Core),
    ("mail_agent_marks", Core),
    ("mail_agent_mark_sender", Core),
    ("mail_ai_classify_apply", Core),
    ("mail_attachment_preview", Core),
    ("mail_attachment_save", Core),
    ("mail_attachment_save_to_project", Core),
    ("mail_attach_pick", Core),
    ("mail_attach_remove", Core),
    ("mail_body", Core),
    ("mail_contact_list_delete", Core),
    ("mail_contact_list_upsert", Core),
    ("mail_contacts_delete", Core),
    ("mail_contacts_export", Core),
    ("mail_contacts_get", Core),
    ("mail_contacts_harvest_inbox", Core),
    ("mail_contacts_import", Core),
    ("mail_contacts_import_thunderbird", Client),
    ("mail_contacts_set_collect", Core),
    ("mail_contact_upsert", Core),
    ("mail_draft_discard", Core),
    ("mail_draft_save", Core),
    ("mail_draft_send", Core),
    ("mail_encryption_decline", Core),
    ("mail_encryption_enable", Core),
    ("mail_encryption_reset", Core),
    ("mail_encryption_state", Core),
    ("mail_encryption_unlock", Core),
    ("mail_extract_event", Core),
    ("mail_extract_task", Core),
    ("mail_filters_apply", Core),
    ("mail_filters_list", Core),
    ("mail_filters_set", Core),
    ("mail_flag", Core),
    ("mail_folders", Core),
    ("mail_forget_password", Core),
    ("mail_formalize_reply", Core),
    ("mail_headers", Core),
    ("mail_mark_folder_read", Core),
    ("mail_move", Core),
    ("mail_password_state", Core),
    ("mail_pgp_available", Core),
    ("mail_pgp_bind", Core),
    ("mail_pgp_delete", Core),
    ("mail_pgp_export", Core),
    ("mail_pgp_generate", Core),
    ("mail_pgp_import", Core),
    ("mail_pgp_import_pick", Core),
    ("mail_pgp_keys", Core),
    ("mail_pgp_recipients_ready", Core),
    ("mail_pgp_set_verified", Core),
    ("mail_priority_clear", Core),
    ("mail_priority_counts", Core),
    ("mail_priority_page", Core),
    ("mail_priority_set", Core),
    ("mail_purge", Core),
    ("mail_replies", Core),
    ("mail_search", Core),
    ("mail_staged_preview", Core),
    ("mail_summarize", Core),
    ("mail_sync", Core),
    ("mail_sync_cancel", Core),
    // commands/markdown.rs
    ("markdown_remote_image", Core),
    // commands/mobile_control.rs
    ("global_inbox_delete", Core),
    ("global_inbox_list", Core),
    ("global_inbox_open", Client),
    ("global_inbox_reveal", Client),
    ("mobile_admin", Core),
    ("mobile_attach_desktop_image", Client),
    ("mobile_desktop_images", Client),
    ("mobile_desktop_respond", Off(OffReason::HeadlessOwner)),
    ("mobile_host_apply", Admin),
    ("mobile_host_status", Admin),
    ("mobile_opaque_id", Core),
    ("mobile_prepare_phone_install_script", Core),
    ("mobile_tailscale_serve_status", Admin),
    ("mobile_verify_tailscale_serve", Admin),
    // commands/monitor.rs
    ("gpu_memory_snapshot", Client),
    ("gpu_process_snapshot", Client),
    ("machine_load_snapshot", Client),
    ("system_monitor_snapshot", Core),
    // commands/net_usage.rs
    ("get_net_usage", Core),
    // commands/network.rs
    ("network_host_snapshot", Core),
    ("network_ssh_link_snapshot", Core),
    // commands/ollama.rs
    ("cancel_text_completion", Core),
    ("clear_pending_ollama_pull", Core),
    ("complete_text", Core),
    ("delete_ollama_model", Core),
    ("delete_ollama_pull", Core),
    ("delete_partial_blob", Core),
    ("ensure_ollama_running", Core),
    ("ensure_vibe_ollama_model", Core),
    ("install_ollama", Admin),
    ("install_vibe", Core),
    ("list_installable_models", Core),
    ("list_local_drivers", Core),
    ("list_ollama_models", Core),
    ("list_ollama_models_detailed", Core),
    ("list_orphan_partial_blobs", Core),
    ("list_pending_ollama_pulls", Core),
    ("load_ollama_model", Core),
    ("ollama_check_updates", Core),
    ("ollama_gpu_status", Core),
    ("ollama_install_strategy", Core),
    ("ollama_is_installed", Core),
    ("ollama_is_running", Core),
    ("ollama_models_dir_plan", Core),
    ("ollama_registry_details", Core),
    ("ollama_registry_size", Core),
    ("ollama_status", Core),
    ("ollama_version_status", Core),
    ("pause_ollama_pull", Core),
    ("prepare_local_agent", Core),
    ("prepare_local_launch", Core),
    ("prepare_text_completion", Core),
    ("pull_ollama_model", Core),
    ("search_ollama_registry", Core),
    ("stop_ollama_model", Core),
    ("vibe_install_strategy", Core),
    ("vibe_is_installed", Core),
    // commands/openvpn.rs
    ("openvpn_active", Admin),
    ("openvpn_auth_needs", Admin),
    ("openvpn_connect", Admin),
    ("openvpn_disconnect", Admin),
    ("openvpn_disconnect_all_on_quit", Admin),
    ("openvpn_list_configs", Admin),
    ("openvpn_login_command", Admin),
    ("openvpn_remove_config", Admin),
    ("openvpn_status", Admin),
    ("openvpn_store_config", Admin),
    ("vpn_can_connect_silently", Admin),
    ("vpn_forget_password", Admin),
    ("vpn_has_saved_password", Admin),
    ("vpn_saved_password_state", Admin),
    // commands/os_clock.rs
    ("os_clock_format", Client),
    // commands/pdf_clip.rs
    ("pdf_clip_get", Core),
    ("pdf_clip_set", Core),
    // commands/pdf_markup.rs
    ("pdf_markup_submit", Core),
    // commands/power.rs
    ("get_power_state", Client),
    // commands/presenter.rs
    ("close_presenter_window", Client),
    ("open_presenter_window", Client),
    ("presenter_inhibit_sleep", Client),
    ("presenter_release_sleep", Client),
    // commands/printing.rs
    ("print_job_cancel", Client),
    ("print_jobs_cancel_all", Client),
    ("print_set_default", Client),
    ("print_set_enabled", Client),
    ("print_system_snapshot", Client),
    ("print_test_page", Client),
    // commands/print_native.rs
    ("print_pdf_native", Client),
    // commands/project_runtime.rs
    ("load_side_panel_folder", Core),
    ("save_side_panel_folder", Core),
    ("switch_project_runtime", Client),
    // commands/projects.rs
    ("add_compute_host", Core),
    ("adopt_folder_tab_layout", Core),
    ("archived_mirror_unsynced", Core),
    ("archive_project", Core),
    ("check_project_site", Core),
    ("clear_archive", Core),
    ("create_project", Core),
    ("delete_archived_project", Core),
    ("detach_project_from_remote", Core),
    ("extend_project_to_remote", Core),
    ("forget_project", Core),
    ("get_project_panel_prefs", Core),
    ("get_projects", Core),
    ("get_time_today", Core),
    ("import_project", Core),
    ("list_archived_projects", Core),
    ("load_project", Core),
    ("load_tab_session", Core),
    ("move_remote_mirror", Core),
    ("open_in_file_manager", Client),
    ("patch_compute_host", Core),
    ("plan_project_dir_rename", Core),
    ("preview_project_scaffold", Core),
    ("project_folder_exists", Core),
    ("project_generated_dir", Core),
    ("project_migration_apply", Core),
    ("project_migration_plan", Core),
    ("project_scaffold_missing", Core),
    ("projects_root_dir", Core),
    ("remote_mirror_root_dir", Core),
    ("remote_mirror_status", Core),
    ("remove_compute_host", Core),
    ("rename_project_dir", Core),
    ("repair_all_project_scaffolds", Core),
    ("repair_project_scaffold", Core),
    ("restore_archived_project", Core),
    ("root_work_dir", Core),
    ("sandbox_preflight", Admin),
    ("save_project", Core),
    ("save_projects", Core),
    ("save_tab_layout", Off(OffReason::WholeDocumentSave)),
    ("set_project_auto_connect", Core),
    ("set_project_categories", Core),
    ("set_project_description", Core),
    ("set_project_git_disabled", Core),
    ("set_project_git_push_mcp", Core),
    ("set_project_mobile_access", Core),
    ("set_project_name", Core),
    ("set_project_openvpn", Core),
    ("set_project_panel_prefs", Core),
    ("set_project_persist_sessions", Core),
    ("set_project_remote_control", Core),
    ("set_project_remote_label", Core),
    ("set_project_remote_user", Core),
    ("set_project_run_host", Core),
    ("set_project_sandbox", Admin),
    ("set_project_sandbox_spec", Admin),
    ("set_project_schedule_mcp", Core),
    ("set_remote_mirror_dir", Core),
    ("workspace_snapshot", Core),
    ("workspace_sync", Core),
    // commands/project_transfer.rs
    ("export_project", Core),
    ("import_project_export", Core),
    ("inspect_project_export", Core),
    ("preview_project_export", Core),
    // commands/python.rs
    ("python_interpreter_for", Core),
    ("python_interpreters", Core),
    ("set_project_python", Core),
    // commands/remote.rs
    ("remote_connect", Core),
    ("remote_connected_ids", Core),
    ("remote_connected_targets", Core),
    ("remote_disconnect", Core),
    ("remote_disconnect_all_hosts", Core),
    ("remote_tmux_kill", Core),
    ("remote_tmux_list", Core),
    ("remote_tmux_rename", Core),
    ("remote_upload_file", Core),
    ("remote_usage_check", Core),
    ("worker_outputs_preview", Core),
    ("worker_pull_outputs", Core),
    ("worker_sync_now", Core),
    // commands/root_mcp.rs
    ("git_push_mcp_clear", Core),
    ("git_push_mcp_decide", Core),
    ("git_push_mcp_proposals", Core),
    ("help_read", Core),
    ("help_search", Core),
    ("help_topics", Core),
    ("root_mcp_import_list", Core),
    ("root_mcp_import_remove", Core),
    ("root_mcp_review_apply", Core),
    ("root_mcp_review_apply_all", Core),
    ("root_mcp_review_list", Core),
    ("root_mcp_review_reject", Core),
    ("root_mcp_review_undo", Core),
    ("root_mcp_security_status", Core),
    ("root_mcp_session_access", Core),
    ("root_mcp_session_revoke", Core),
    ("root_mcp_status", Core),
    // commands/screenshot.rs
    ("capture_screenshot", Client),
    ("discard_pending_screenshot", Client),
    ("read_pending_screenshot", Client),
    ("save_pending_screenshot", Client),
    // commands/search.rs
    ("project_search", Core),
    // commands/settings.rs
    ("get_settings", Core),
    ("patch_settings", Core),
    ("save_settings", Off(OffReason::WholeDocumentSave)),
    ("save_window_state", Client),
    // commands/sheets.rs
    ("read_spreadsheet", Core),
    // commands/skills.rs
    ("skills_add_source", Core),
    ("skills_get_detail", Core),
    ("skills_install", Core),
    ("skills_list_catalog", Core),
    ("skills_list_installed", Core),
    ("skills_list_sources", Core),
    ("skills_refresh_source", Core),
    ("skills_remove_source", Core),
    ("skills_uninstall", Core),
    // commands/slurm.rs
    ("slurm_available", Core),
    ("slurm_cancel", Core),
    ("slurm_job_out", Core),
    ("slurm_queue", Core),
    ("slurm_submit", Core),
    // commands/spell.rs
    ("spell_add_word", Core),
    ("spell_check", Core),
    ("spell_dictionaries", Core),
    ("spell_install_language", Core),
    ("spell_languages", Core),
    ("spell_remove_language", Core),
    // commands/sqlite.rs
    ("sqlite_page", Core),
    ("sqlite_tables", Core),
    // commands/ssh.rs
    ("open_external_url", Client),
    ("remote_forget_password", Core),
    ("remote_get_default_path", Core),
    ("remote_has_saved_password", Core),
    ("remote_kill_all_jobs", Core),
    ("remote_list_default_paths", Core),
    ("remote_list_paths", Core),
    ("remote_login_command", Core),
    ("remote_remember_path", Core),
    ("remote_saved_password_state", Core),
    ("remote_set_default_path", Core),
    ("ssh_close_master", Core),
    ("ssh_connect", Core),
    ("ssh_default_dir", Core),
    ("ssh_host_key_preview", Core),
    ("ssh_list_addresses", Core),
    ("ssh_list_dir", Core),
    ("ssh_mkdir", Core),
    ("ssh_probe", Core),
    ("ssh_remember_address", Core),
    ("ssh_tooling_status", Core),
    ("ssh_trust_host_key", Core),
    // commands/subwindow.rs
    ("attach_subwindow", Client),
    ("desktop_coordinates_supported", Client),
    ("detached_retire_ack", Client),
    ("detached_retire_ready", Client),
    ("detached_window_frontmost", Client),
    ("detached_window_is_parked", Client),
    ("detach_subwindow", Client),
    ("focus_detached_window", Client),
    ("snap_detached_window", Client),
    ("sync_detached_scope", Client),
    // commands/sync.rs
    ("sync_apply_delete", Core),
    ("sync_auto_preview", Core),
    ("sync_big_folders", Core),
    ("sync_diff", Core),
    ("sync_file_meta", Core),
    ("sync_mark_selected", Core),
    ("sync_pull", Core),
    ("sync_push", Core),
    ("sync_resolve_if_identical", Core),
    ("sync_set_auto", Core),
    ("sync_set_excluded", Core),
    ("sync_status", Core),
    ("sync_transfer_preview", Core),
    ("sync_whole_project", Core),
    // commands/terminal.rs
    ("agent_fence_marks", Core),
    ("agent_fence_status", Core),
    ("copilot_fence_auth_status", Core),
    ("copilot_fence_sign_out", Core),
    ("local_tmux_kill", Core),
    ("local_tmux_kill_app_sessions", Core),
    ("local_tmux_list", Core),
    ("local_tmux_rename", Core),
    ("local_tmux_screen", Core),
    ("project_cpu_percent", Core),
    ("pty_kill", Core),
    ("pty_kill_scope", Core),
    ("pty_remove_view", Core),
    ("pty_resize", Core),
    ("pty_scrollback", Core),
    ("pty_set_visible", Core),
    ("pty_spawn", Core),
    ("pty_unwatch", Core),
    ("pty_watch", Core),
    ("pty_write", Core),
    ("register_host_bound_tab", Core),
    // commands/tex.rs
    ("compile_tex", Core),
    ("list_fonts", Core),
    ("resolve_tex_root", Core),
    ("synctex_edit", Core),
    ("synctex_page_lines", Core),
    ("synctex_status", Core),
    ("synctex_view", Core),
    ("tex_capability", Core),
    ("tex_preview_snippet", Core),
    // commands/timer.rs
    ("get_project_activity", Core),
    ("get_time_activity_all", Core),
    ("timer_flush_app", Core),
    ("timer_flush_project", Core),
    // commands/usage_stats.rs
    ("usage_bump", Core),
    ("usage_git_stats", Core),
    ("usage_summary", Core),
    ("usage_token_stats", Core),
    ("usage_watch_project", Core),
    // commands/vm.rs
    ("remote_download_size", Core),
    ("remote_download_to", Core),
    ("vm_allow_temporarily", Admin),
    ("vm_blocked", Admin),
    ("vm_boot", Admin),
    ("vm_doctor", Admin),
    ("vm_rebuild", Admin),
    ("vm_set_spec", Admin),
    ("vm_shutdown", Admin),
    ("vm_status", Admin),
    ("vm_unpushed_commits", Admin),
    // commands/workspace.rs
    ("desktop_owns_super_key", Client),
    ("get_opened_windows", Client),
    ("hide_window", Client),
    ("network_conn_type", Client),
    ("network_identity", Client),
    ("network_wifi_ssid", Client),
    ("show_window", Client),
    ("switch_project_windows", Client),
    ("workspace_capabilities", Client),
    ("workspace_info", Client),
    ("workspace_name", Client),
    ("workspace_switch", Client),
];

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::{BTreeSet, HashMap};

    /// The bare names of every command `lib.rs` registers, read from the
    /// source of `generate_handler![…]` itself so the test cannot drift from
    /// the registration.
    fn registered_commands() -> Vec<String> {
        let src = include_str!("../lib.rs");
        let start = src
            .find("generate_handler![")
            .expect("lib.rs registers commands through generate_handler!");
        let body = &src[start + "generate_handler![".len()..];
        let mut names = Vec::new();
        for line in body.lines() {
            let code = line.split("//").next().unwrap_or("").trim();
            if code.starts_with("])") {
                break;
            }
            for token in code.split(',') {
                let token = token.trim();
                if token.is_empty() {
                    continue;
                }
                assert!(
                    token.starts_with("commands::"),
                    "unexpected entry in generate_handler!: `{token}` — the \
                     completeness test only understands `commands::…::name` paths"
                );
                names.push(token.rsplit("::").next().unwrap().to_string());
            }
        }
        assert!(names.len() > 600, "parsed only {} commands from lib.rs", names.len());
        names
    }

    #[test]
    fn every_registered_command_has_a_class() {
        let registered = registered_commands();
        let missing: Vec<&str> = registered
            .iter()
            .map(String::as_str)
            .filter(|name| class_of(name).is_none())
            .collect();
        assert!(
            missing.is_empty(),
            "{} registered command(s) have no class in services::command_class::TABLE \
             (hosted plan §3.3 — there is no default class on purpose): {missing:?}",
            missing.len()
        );
    }

    #[test]
    fn every_classified_command_is_registered() {
        let registered: BTreeSet<String> = registered_commands().into_iter().collect();
        let stale: Vec<&str> = TABLE
            .iter()
            .map(|(name, _)| *name)
            .filter(|name| !registered.contains(*name))
            .collect();
        assert!(
            stale.is_empty(),
            "{} table row(s) name a command lib.rs no longer registers: {stale:?}",
            stale.len()
        );
    }

    #[test]
    fn table_has_no_duplicate_rows() {
        let mut seen: HashMap<&str, CommandClass> = HashMap::new();
        for (name, class) in TABLE {
            if let Some(first) = seen.insert(name, *class) {
                panic!("`{name}` is classified twice ({first:?} and {class:?})");
            }
        }
        assert_eq!(seen.len(), registered_commands().len());
    }

    #[test]
    fn the_examples_of_the_plan_hold() {
        // §3.3's table, one representative per cell.
        assert_eq!(class_of("pty_set_visible"), Some(Core));
        assert_eq!(class_of("complete_text"), Some(Core));
        assert_eq!(class_of("copilot_complete"), Some(Core));
        assert_eq!(class_of("copy_text_to_clipboard"), Some(Client));
        assert_eq!(class_of("capture_screenshot"), Some(Client));
        assert_eq!(class_of("openvpn_connect"), Some(Admin));
        assert_eq!(class_of("vm_boot"), Some(Admin));
        assert_eq!(class_of("keyring_unlock"), Some(Off(OffReason::OsKeychain)));
        assert_eq!(class_of("save_tab_layout"), Some(Off(OffReason::WholeDocumentSave)));
        assert_eq!(class_of("no_such_command"), None);
        assert!(names_in(Core).count() > names_in(Client).count());
        assert_eq!(Off(OffReason::HeadlessOwner).as_str(), "off");
        assert_eq!(OffReason::HeadlessOwner.as_str(), "headless-owner");
        assert_eq!(all().len(), registered_commands().len());
    }
}
