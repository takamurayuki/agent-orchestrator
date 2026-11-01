//! Tauri commands exposed to the webview: exactly one per allowed IPC method, plus
//! `pick_project_folder` (native folder dialog) and `runner_state`.
//!
//! There is deliberately no generic "invoke any method" command. Params are passed
//! through as a JSON object; the runner validates them against the contracts
//! schemas. Rust never builds CLI arguments from these values.

use std::sync::Arc;

use serde_json::{Map, Value};
use tauri::{AppHandle, State, Wry};
use tauri_plugin_dialog::DialogExt;

use crate::sidecar::{IpcError, RunnerState, SidecarManager};

pub type Manager = Arc<SidecarManager<Wry>>;

macro_rules! ipc_command {
    ($name:ident, $method:literal) => {
        #[tauri::command]
        pub async fn $name(state: State<'_, Manager>, params: Map<String, Value>) -> Result<Value, IpcError> {
            state.call($method, params).await
        }
    };
}

ipc_command!(environment_check, "environment.check");
ipc_command!(project_inspect, "project.inspect");
ipc_command!(draft_create, "draft.create");
ipc_command!(draft_answer, "draft.answer");
ipc_command!(draft_revise, "draft.revise");
ipc_command!(draft_approve, "draft.approve");
ipc_command!(run_start, "run.start");
ipc_command!(run_cancel, "run.cancel");
ipc_command!(run_status, "run.status");
ipc_command!(run_list, "run.list");
ipc_command!(run_report, "run.report");
ipc_command!(sandbox_setup, "sandbox.setup");
ipc_command!(sandbox_cancel, "sandbox.cancel");
ipc_command!(sandbox_status, "sandbox.status");

/// Reveals a worktree (作業用コピー) in the OS file manager.
///
/// Security: the path must resolve to a directory under the runner's worktrees directory
/// (`<app-data>/worktrees`, or `AGENT_ORCHESTRATOR_WORKTREES`); nothing else is opened,
/// and no shell is involved (the file manager binary is spawned with the path as a single
/// argument). This is the only "open something on the host" capability of the UI.
#[tauri::command]
pub async fn reveal_worktree(app: AppHandle, path: String) -> Result<(), IpcError> {
    let config = crate::sidecar::SidecarConfig::resolve(&app)?;
    let worktrees = match std::env::var_os("AGENT_ORCHESTRATOR_WORKTREES") {
        Some(v) if !v.is_empty() => std::path::PathBuf::from(v),
        _ => config.app_data_dir.join("worktrees"),
    };
    let root = worktrees
        .canonicalize()
        .map_err(|_| IpcError::new("NOT_FOUND", "作業用コピーの保存先がまだありません"))?;
    let target = std::path::PathBuf::from(&path)
        .canonicalize()
        .map_err(|_| IpcError::new("NOT_FOUND", "作業用コピーのフォルダーが見つかりません（削除された可能性があります）"))?;
    if !target.starts_with(&root) || !target.is_dir() {
        return Err(IpcError::new("INVALID_PARAMS", "作業用コピー以外のフォルダーは開けません"));
    }
    #[cfg(target_os = "windows")]
    let program = "explorer.exe";
    #[cfg(target_os = "macos")]
    let program = "open";
    #[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
    let program = "xdg-open";
    std::process::Command::new(program)
        .arg(&target)
        .spawn()
        .map(|_| ())
        .map_err(|e| IpcError::new("INTERNAL_ERROR", format!("フォルダーを開けませんでした: {e}")))
}

/// Opens the native folder picker and returns the selected absolute path (or null).
#[tauri::command]
pub async fn pick_project_folder(app: AppHandle) -> Result<Option<String>, IpcError> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .set_title("プロジェクトフォルダーを選択")
        .pick_folder(move |path| {
            let _ = tx.send(path);
        });
    let picked = rx
        .await
        .map_err(|_| IpcError::new("INTERNAL_ERROR", "フォルダー選択ダイアログが応答しませんでした"))?;
    match picked {
        Some(p) => {
            let path = p
                .into_path()
                .map_err(|e| IpcError::new("INTERNAL_ERROR", format!("選択されたパスを解決できません: {e}")))?;
            Ok(Some(path.to_string_lossy().into_owned()))
        }
        None => Ok(None),
    }
}

/// Whether the runner sidecar is alive (and ready), for the setup screen.
#[tauri::command]
pub fn runner_state(state: State<'_, Manager>) -> RunnerState {
    state.state()
}
