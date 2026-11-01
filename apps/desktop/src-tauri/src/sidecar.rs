//! Local Node runner sidecar management.
//!
//! The UI never talks to the runner directly: it calls one Tauri command per IPC
//! method (see `commands.rs`), and this module writes a line-delimited JSON request
//! to the sidecar's stdin and waits for the matching response on stdout.
//!
//! Protocol (SPEC §10.1, contracts/ipc.schema.json):
//! - request:  `{"id":"<uuid>","method":"run.start","params":{...}}`
//! - response: `{"id":"...","ok":true,"result":{...}}` / `{"id":"...","ok":false,"error":{...}}`
//! - event:    `{"event":"run.event","runId":"...","payload":{...}}` (forwarded to the
//!   webview as the Tauri event `runner://event`, order preserved)
//! - stderr is logs only.
//!
//! Security rules: the method must be in `ALLOWED_METHODS`; the sidecar command line
//! is never assembled from user input (it is fixed at startup from env/defaults).

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use serde::Serialize;
use serde_json::{json, Map, Value};
use tauri::{AppHandle, Emitter, Manager, Runtime};
use tokio::sync::oneshot;

/// IPC method allowlist (SPEC §10.1). Anything else is rejected before touching stdio.
pub const ALLOWED_METHODS: &[&str] = &[
    "environment.check",
    "project.inspect",
    "draft.create",
    "draft.answer",
    "draft.revise",
    "draft.approve",
    "run.start",
    "run.cancel",
    "run.status",
    "run.list",
    "run.report",
    "sandbox.setup",
    "sandbox.cancel",
    "sandbox.status",
];

/// Tauri event name used to forward every runner event to the webview.
pub const RUNNER_EVENT: &str = "runner://event";

/// Per-request timeout.
pub const REQUEST_TIMEOUT: Duration = Duration::from_secs(120);

/// How long to wait for `runner.ready` after spawning before giving up.
const READY_TIMEOUT: Duration = Duration::from_secs(20);

/// Error returned to the webview. Mirrors `IpcError` from the contracts package.
#[derive(Debug, Clone, Serialize)]
pub struct IpcError {
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<Value>,
}

impl IpcError {
    pub fn new(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.to_string(),
            message: message.into(),
            details: None,
        }
    }

    fn from_value(value: Option<&Value>) -> Self {
        match value {
            Some(v) => Self {
                code: v
                    .get("code")
                    .and_then(Value::as_str)
                    .unwrap_or("INTERNAL_ERROR")
                    .to_string(),
                message: v
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or("ランナーからエラー詳細のない応答が返されました")
                    .to_string(),
                details: v.get("details").cloned(),
            },
            None => Self::new("INTERNAL_ERROR", "ランナーからエラー詳細のない応答が返されました"),
        }
    }
}

/// How the sidecar is launched. Fixed at startup; never derived from user input.
#[derive(Debug, Clone)]
pub struct SidecarConfig {
    pub program: PathBuf,
    pub args: Vec<String>,
    pub app_data_dir: PathBuf,
}

impl SidecarConfig {
    /// Resolve the launch configuration.
    ///
    /// Priority:
    /// 1. `AGENT_ORCHESTRATOR_RUNNER_CMD` (absolute path to an executable) and
    ///    `AGENT_ORCHESTRATOR_RUNNER_ARGS` (JSON array of strings; defaults to `[]`).
    /// 2. Dev default: `node <repoRoot>/apps/runner/dist/main.js --ipc stdio`, where
    ///    `<repoRoot>` is resolved from the cargo manifest dir (`apps/desktop/src-tauri`).
    ///
    /// Packaged build plan (NOT verified yet): ship a Node SEA binary as a Tauri
    /// `externalBin` at `src-tauri/binaries/agent-orchestrator-runner-<target-triple>.exe`
    /// and point `AGENT_ORCHESTRATOR_RUNNER_CMD` at it (or resolve it next to the app
    /// executable). Until that is validated on a real machine, only the dev path is
    /// claimed to work.
    pub fn resolve<R: Runtime>(app: &AppHandle<R>) -> Result<Self, IpcError> {
        let app_data_dir = match std::env::var_os("AGENT_ORCHESTRATOR_APP_DATA") {
            Some(v) if !v.is_empty() => PathBuf::from(v),
            _ => app
                .path()
                .app_local_data_dir()
                .map_err(|e| IpcError::new("INTERNAL_ERROR", format!("アプリデータディレクトリを解決できません: {e}")))?
                .join("agent-orchestrator")
                .join("app-data"),
        };

        if let Some(cmd) = std::env::var_os("AGENT_ORCHESTRATOR_RUNNER_CMD").filter(|v| !v.is_empty()) {
            let program = PathBuf::from(cmd);
            if !program.is_absolute() {
                return Err(IpcError::new(
                    "ENVIRONMENT_UNAVAILABLE",
                    "AGENT_ORCHESTRATOR_RUNNER_CMD は絶対パスである必要があります",
                ));
            }
            let args = match std::env::var("AGENT_ORCHESTRATOR_RUNNER_ARGS") {
                Ok(raw) if !raw.trim().is_empty() => serde_json::from_str::<Vec<String>>(&raw).map_err(|e| {
                    IpcError::new(
                        "ENVIRONMENT_UNAVAILABLE",
                        format!("AGENT_ORCHESTRATOR_RUNNER_ARGS は文字列の JSON 配列である必要があります: {e}"),
                    )
                })?,
                _ => Vec::new(),
            };
            return Ok(Self {
                program,
                args,
                app_data_dir,
            });
        }

        // 2. 配布物: Tauri の externalBin は実行ファイルと同じディレクトリに
        //    `agent-orchestrator-runner(.exe)` として配置される（target triple は除去される）。
        if let Some(packaged) = packaged_sidecar_path() {
            return Ok(Self {
                program: packaged,
                args: vec!["--ipc".to_string(), "stdio".to_string()],
                app_data_dir,
            });
        }

        let script = repo_root().join("apps").join("runner").join("dist").join("main.js");
        Ok(Self {
            program: PathBuf::from("node"),
            args: vec![
                script.to_string_lossy().into_owned(),
                "--ipc".to_string(),
                "stdio".to_string(),
            ],
            app_data_dir,
        })
    }
}

/// Packaged sidecar next to the app executable (Tauri `externalBin`). `None` when absent (dev mode).
pub fn packaged_sidecar_path() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let dir = exe.parent()?;
    let name = if cfg!(windows) { "agent-orchestrator-runner.exe" } else { "agent-orchestrator-runner" };
    let candidate = dir.join(name);
    if candidate.is_file() {
        Some(candidate)
    } else {
        None
    }
}

/// `apps/desktop/src-tauri` → repo root (three ancestors up).
pub fn repo_root() -> PathBuf {
    let manifest = Path::new(env!("CARGO_MANIFEST_DIR"));
    manifest
        .ancestors()
        .nth(3)
        .map(Path::to_path_buf)
        .unwrap_or_else(|| manifest.to_path_buf())
}

type Pending = Arc<Mutex<HashMap<String, oneshot::Sender<Result<Value, IpcError>>>>>;

/// Public, serialisable view of the sidecar status (`runner_state` command).
#[derive(Debug, Clone, Serialize, Default)]
pub struct RunnerState {
    pub alive: bool,
    pub ready: bool,
    pub pid: Option<u32>,
    pub version: Option<String>,
    pub program: Option<String>,
    pub restarts: u32,
}

struct ReadyInfo {
    version: Option<String>,
    pid: Option<u32>,
}

struct Instance {
    child: Child,
    stdin: Mutex<ChildStdin>,
    pending: Pending,
    alive: Arc<AtomicBool>,
    ready: Arc<Mutex<Option<ReadyInfo>>>,
    program: String,
}

impl Instance {
    fn is_alive(&mut self) -> bool {
        if !self.alive.load(Ordering::SeqCst) {
            return false;
        }
        match self.child.try_wait() {
            Ok(Some(_)) => {
                self.alive.store(false, Ordering::SeqCst);
                false
            }
            Ok(None) => true,
            Err(_) => false,
        }
    }

    fn shutdown(&mut self) {
        self.alive.store(false, Ordering::SeqCst);
        let _ = self.child.kill();
        let _ = self.child.wait();
        fail_all_pending(&self.pending);
    }
}

fn fail_all_pending(pending: &Pending) {
    let drained: Vec<_> = match pending.lock() {
        Ok(mut map) => map.drain().collect(),
        Err(_) => Vec::new(),
    };
    for (_, tx) in drained {
        let _ = tx.send(Err(IpcError::new(
            "RUNNER_UNAVAILABLE",
            "ランナープロセスが終了したため要求を完了できませんでした",
        )));
    }
}

/// Owns at most one sidecar process and restarts it (once per command) when it died.
pub struct SidecarManager<R: Runtime> {
    app: AppHandle<R>,
    instance: Mutex<Option<Instance>>,
    restarts: Mutex<u32>,
}

impl<R: Runtime> SidecarManager<R> {
    pub fn new(app: AppHandle<R>) -> Self {
        Self {
            app,
            instance: Mutex::new(None),
            restarts: Mutex::new(0),
        }
    }

    /// Snapshot of the sidecar state for the UI.
    pub fn state(&self) -> RunnerState {
        let mut guard = match self.instance.lock() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        };
        let restarts = self.restarts.lock().map(|r| *r).unwrap_or(0);
        match guard.as_mut() {
            Some(inst) => {
                let alive = inst.is_alive();
                let ready = inst.ready.lock().ok().and_then(|r| r.as_ref().map(|i| (i.version.clone(), i.pid)));
                RunnerState {
                    alive,
                    ready: ready.is_some(),
                    pid: ready.as_ref().and_then(|r| r.1).or(Some(inst.child.id())),
                    version: ready.and_then(|r| r.0),
                    program: Some(inst.program.clone()),
                    restarts,
                }
            }
            None => RunnerState {
                restarts,
                ..RunnerState::default()
            },
        }
    }

    /// Make sure a live sidecar exists; spawn (or respawn once) if needed.
    fn ensure_running(&self) -> Result<(), IpcError> {
        let mut guard = match self.instance.lock() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        };
        let need_spawn = match guard.as_mut() {
            Some(inst) => {
                if inst.is_alive() {
                    false
                } else {
                    log::warn!("runner sidecar is not alive; restarting once");
                    inst.shutdown();
                    if let Ok(mut r) = self.restarts.lock() {
                        *r += 1;
                    }
                    true
                }
            }
            None => true,
        };
        if need_spawn {
            let config = SidecarConfig::resolve(&self.app)?;
            let inst = spawn(&self.app, &config)?;
            *guard = Some(inst);
        }
        Ok(())
    }

    /// Send one request and wait for its response (120 s timeout).
    pub async fn call(&self, method: &str, params: Map<String, Value>) -> Result<Value, IpcError> {
        if !ALLOWED_METHODS.contains(&method) {
            return Err(IpcError::new(
                "METHOD_NOT_ALLOWED",
                format!("許可されていない IPC メソッドです: {method}"),
            ));
        }
        self.ensure_running()?;

        let id = uuid::Uuid::new_v4().to_string();
        let (tx, rx) = oneshot::channel();
        let pending = {
            let guard = match self.instance.lock() {
                Ok(g) => g,
                Err(p) => p.into_inner(),
            };
            let inst = guard
                .as_ref()
                .ok_or_else(|| IpcError::new("RUNNER_UNAVAILABLE", "ランナーが起動していません"))?;
            if let Ok(mut map) = inst.pending.lock() {
                map.insert(id.clone(), tx);
            }
            let line = serde_json::to_string(&json!({ "id": id, "method": method, "params": params }))
                .map_err(|e| IpcError::new("INTERNAL_ERROR", format!("要求のシリアライズに失敗しました: {e}")))?;
            let write_result = inst.stdin.lock().map_err(|_| ()).and_then(|mut stdin| {
                stdin
                    .write_all(line.as_bytes())
                    .and_then(|_| stdin.write_all(b"\n"))
                    .and_then(|_| stdin.flush())
                    .map_err(|_| ())
            });
            if write_result.is_err() {
                if let Ok(mut map) = inst.pending.lock() {
                    map.remove(&id);
                }
                inst.alive.store(false, Ordering::SeqCst);
                return Err(IpcError::new(
                    "RUNNER_UNAVAILABLE",
                    "ランナーへの書き込みに失敗しました。次の操作で再起動を試みます",
                ));
            }
            Arc::clone(&inst.pending)
        };

        match tokio::time::timeout(REQUEST_TIMEOUT, rx).await {
            Ok(Ok(result)) => result,
            Ok(Err(_canceled)) => Err(IpcError::new(
                "RUNNER_UNAVAILABLE",
                "ランナープロセスが終了したため要求を完了できませんでした",
            )),
            Err(_elapsed) => {
                if let Ok(mut map) = pending.lock() {
                    map.remove(&id);
                }
                Err(IpcError::new(
                    "RUNNER_TIMEOUT",
                    format!("ランナーが {} 秒以内に応答しませんでした ({method})", REQUEST_TIMEOUT.as_secs()),
                ))
            }
        }
    }

    /// Kill the sidecar (used on app exit).
    pub fn shutdown(&self) {
        if let Ok(mut guard) = self.instance.lock() {
            if let Some(inst) = guard.as_mut() {
                inst.shutdown();
            }
            *guard = None;
        }
    }
}

fn spawn<R: Runtime>(app: &AppHandle<R>, config: &SidecarConfig) -> Result<Instance, IpcError> {
    if let Err(e) = std::fs::create_dir_all(&config.app_data_dir) {
        log::warn!("could not create app data dir {:?}: {e}", config.app_data_dir);
    }
    let mut command = Command::new(&config.program);
    command
        .args(&config.args)
        .env("AGENT_ORCHESTRATOR_APP_DATA", &config.app_data_dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    log::info!("spawning runner sidecar: {:?} {:?}", config.program, config.args);
    let mut child = command.spawn().map_err(|e| {
        IpcError::new(
            "RUNNER_UNAVAILABLE",
            format!(
                "ランナーを起動できません ({} {}): {e}",
                config.program.to_string_lossy(),
                config.args.join(" ")
            ),
        )
    })?;

    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| IpcError::new("INTERNAL_ERROR", "ランナーの stdin を取得できません"))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| IpcError::new("INTERNAL_ERROR", "ランナーの stdout を取得できません"))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| IpcError::new("INTERNAL_ERROR", "ランナーの stderr を取得できません"))?;

    let pending: Pending = Arc::new(Mutex::new(HashMap::new()));
    let alive = Arc::new(AtomicBool::new(true));
    let ready: Arc<Mutex<Option<ReadyInfo>>> = Arc::new(Mutex::new(None));
    let (ready_tx, ready_rx) = std::sync::mpsc::channel::<()>();

    // stdout reader: responses → pending oneshots, events → webview.
    {
        let app = app.clone();
        let pending = Arc::clone(&pending);
        let alive = Arc::clone(&alive);
        let ready = Arc::clone(&ready);
        thread::Builder::new()
            .name("runner-stdout".into())
            .spawn(move || {
                let reader = BufReader::new(stdout);
                let mut ready_tx = Some(ready_tx);
                for line in reader.lines() {
                    let line = match line {
                        Ok(l) => l,
                        Err(e) => {
                            log::warn!("runner stdout read error: {e}");
                            break;
                        }
                    };
                    if line.trim().is_empty() {
                        continue;
                    }
                    let value: Value = match serde_json::from_str(&line) {
                        Ok(v) => v,
                        Err(_) => {
                            log::debug!("runner stdout (non-JSON): {line}");
                            continue;
                        }
                    };
                    if let Some(id) = value.get("id").and_then(Value::as_str) {
                        let tx = pending.lock().ok().and_then(|mut map| map.remove(id));
                        if let Some(tx) = tx {
                            let ok = value.get("ok").and_then(Value::as_bool).unwrap_or(false);
                            let outcome = if ok {
                                Ok(value.get("result").cloned().unwrap_or(Value::Null))
                            } else {
                                Err(IpcError::from_value(value.get("error")))
                            };
                            let _ = tx.send(outcome);
                        } else {
                            log::debug!("runner response for unknown id {id}");
                        }
                        continue;
                    }
                    if let Some(event) = value.get("event").and_then(Value::as_str) {
                        if event == "runner.ready" {
                            let payload = value.get("payload");
                            if let Ok(mut r) = ready.lock() {
                                *r = Some(ReadyInfo {
                                    version: payload
                                        .and_then(|p| p.get("version"))
                                        .and_then(Value::as_str)
                                        .map(str::to_string),
                                    pid: payload
                                        .and_then(|p| p.get("pid"))
                                        .and_then(Value::as_u64)
                                        .map(|p| p as u32),
                                });
                            }
                            if let Some(tx) = ready_tx.take() {
                                let _ = tx.send(());
                            }
                        }
                        if let Err(e) = app.emit(RUNNER_EVENT, value) {
                            log::warn!("failed to emit runner event: {e}");
                        }
                    }
                }
                alive.store(false, Ordering::SeqCst);
                fail_all_pending(&pending);
                log::warn!("runner stdout closed; sidecar considered dead");
            })
            .map_err(|e| IpcError::new("INTERNAL_ERROR", format!("stdout 読み取りスレッドを開始できません: {e}")))?;
    }

    // stderr reader: logs only.
    thread::Builder::new()
        .name("runner-stderr".into())
        .spawn(move || {
            let reader = BufReader::new(stderr);
            for line in reader.lines().map_while(Result::ok) {
                log::info!("[runner] {line}");
            }
        })
        .map_err(|e| IpcError::new("INTERNAL_ERROR", format!("stderr 読み取りスレッドを開始できません: {e}")))?;

    // Wait (bounded) for runner.ready so the first command does not race startup.
    // If the process exits before that, surface the failure immediately.
    match ready_rx.recv_timeout(READY_TIMEOUT) {
        Ok(()) => {}
        Err(_) => {
            if let Ok(Some(status)) = child.try_wait() {
                let _ = child.kill();
                return Err(IpcError::new(
                    "RUNNER_UNAVAILABLE",
                    format!("ランナーが起動直後に終了しました (exit: {status})。apps/runner がビルドされているか確認してください"),
                ));
            }
            log::warn!("runner.ready not received within {READY_TIMEOUT:?}; continuing anyway");
        }
    }

    Ok(Instance {
        program: config.program.to_string_lossy().into_owned(),
        child,
        stdin: Mutex::new(stdin),
        pending,
        alive,
        ready,
    })
}
