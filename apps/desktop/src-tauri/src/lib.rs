//! Agent Orchestrator desktop shell.
//!
//! Boundary rules (SPEC §2): the UI calls Tauri commands only; Rust owns the Node
//! runner sidecar and talks to it over stdio with line-delimited JSON. No network
//! listeners, no HTTP APIs, no shell access from the webview.

mod commands;
mod sidecar;

use std::sync::Arc;

use tauri::{Manager, RunEvent};

use crate::sidecar::SidecarManager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let _ = env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).try_init();

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let manager: commands::Manager = Arc::new(SidecarManager::new(app.handle().clone()));
            app.manage(manager);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::environment_check,
            commands::project_inspect,
            commands::draft_create,
            commands::draft_answer,
            commands::draft_revise,
            commands::draft_approve,
            commands::run_start,
            commands::run_cancel,
            commands::run_status,
            commands::run_list,
            commands::run_report,
            commands::sandbox_setup,
            commands::sandbox_cancel,
            commands::sandbox_status,
            commands::reveal_worktree,
            commands::pick_project_folder,
            commands::runner_state,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                if let Some(manager) = app.try_state::<commands::Manager>() {
                    manager.shutdown();
                }
            }
        });
}
