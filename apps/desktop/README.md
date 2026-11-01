# @agent-orchestrator/desktop

Tauri 2 (Rust) + Svelte 5 + TypeScript + Vite desktop shell for Agent Orchestrator (SPEC §2, §3, §10.1, §12).

The UI never issues OS commands and never sees CLI commands. It calls one Tauri command per
IPC method; Rust owns a local Node runner sidecar and talks to it over stdio with
line-delimited JSON. No network listeners, no HTTP APIs.

## Layout

```
apps/desktop/
  src/
    App.svelte                      # nav (4 screens), global error, aria-live region
    components/{Home,Interview,Running,Result}.svelte   # S1..S4
    lib/api/
      transport.ts                  # Transport interface, typed params/results per IPC method
      tauri.ts                      # TauriTransport: invoke(<method>_command) + listen('runner://event')
      mock.ts, mock-data.ts         # MockTransport: full simulated flow (browser dev / Playwright)
      index.ts                      # getTransport(): Tauri when window.__TAURI_INTERNALS__ exists, else mock
    lib/stores/app.svelte.ts        # Svelte 5 runes state (screen, env, project, draft, run, events, history)
    lib/stores/actions.ts           # transport calls + event handling (reconnect via run.status sinceSequence)
    lib/components/                 # QuestionCard, StatusBadge, LogPanel, SetupCheck, FactsPanel, SummaryEditor, HistoryList, Alert
    lib/labels.ts                   # Japanese labels for states / codes, formatting helpers
  e2e/*.spec.ts                     # Playwright, titles map to ACCEPTANCE UI-01..UI-10
  src-tauri/
    src/main.rs, lib.rs             # tauri::Builder + plugin-dialog, SidecarManager state
    src/commands.rs                 # one command per allowed method + pick_project_folder + runner_state
    src/sidecar.rs                  # spawn, stdout reader (responses by id / events), stderr logger, timeouts, restart
    tauri.conf.json                 # 1200x820, strict CSP, identifier dev.agent-orchestrator.desktop
    capabilities/default.json       # core:default, dialog:allow-open only
```

## Commands

```sh
pnpm install                                               # from the repo root
pnpm --filter @agent-orchestrator/contracts build          # types come from contracts/dist
pnpm --filter @agent-orchestrator/desktop dev              # Vite + MockTransport in the browser (http://localhost:1420)
pnpm --filter @agent-orchestrator/desktop typecheck        # svelte-check
pnpm --filter @agent-orchestrator/desktop test:e2e         # Playwright (chromium) against vite --port 4173 + mock
pnpm --filter @agent-orchestrator/desktop tauri:dev        # real window; needs apps/runner built (see below)
cd apps/desktop/src-tauri && cargo check                   # Rust compile check
```

First time for Playwright: `pnpm --filter @agent-orchestrator/desktop exec playwright install chromium`.

### Mock transport query parameters (browser dev / tests)

- `?env=fail` — environment.check reports Docker failing (`canRun=false`), shows the setup checklist.
- `?mockDelay=<ms>` — delay between simulated run state transitions (default 700).
- `?mockLatency=<ms>` — simulated IPC latency per call (default 60).
- Project paths containing `invalid` → `not_git`; containing `dirty` → `unusable`; anything else → ok.

## Sidecar (runner) launch

Rust resolves the sidecar at first command use (`sidecar.rs::SidecarConfig::resolve`):

1. `AGENT_ORCHESTRATOR_RUNNER_CMD` (absolute path to an executable) and
   `AGENT_ORCHESTRATOR_RUNNER_ARGS` (JSON array of strings, default `[]`).
2. Otherwise the dev default: `node <repoRoot>/apps/runner/dist/main.js --ipc stdio`, where
   `<repoRoot>` is three ancestors above `apps/desktop/src-tauri` (`CARGO_MANIFEST_DIR`).

Environment passed to the sidecar: `AGENT_ORCHESTRATOR_APP_DATA` (default
`<app local data dir>/agent-orchestrator/app-data`, overridable by the same env var).

Protocol: `runner.ready` event first, then `{id,method,params}` requests on stdin and
`{id,ok,result|error}` responses / `{event,runId?,payload}` events on stdout. Every event is
forwarded to the webview as Tauri event `runner://event` with the whole JSON object as payload,
in order. Per-request timeout 120 s → `RUNNER_TIMEOUT`; if the process dies, pending requests
fail with `RUNNER_UNAVAILABLE` and the next command respawns the sidecar once. The method is
checked against the allowlist in Rust before anything is written to stdin.

## Decisions

- Mock folder picker: in the browser there is no native dialog, so Home shows a path text field
  plus 「選択」; inside Tauri an extra 「フォルダーを選択…」 button calls `pick_project_folder`.
  The text field remains available in Tauri as well.
- Approving (`draft.approve`) immediately calls `run.start`; the fixed `task.yaml` is shown on
  the Running screen (collapsible, read-only).
- Unanswered questions are sent as `skipped:true`; skipping a blocking question leads to a
  `BLOCKED` draft whose `blockedReason` is shown as text, with 「戻る」 to recover. No auto-approval.
- Summary edits (requirements / out of scope / approach / acceptance criteria) go through
  `draft.revise`, which bumps the revision and resets approval; unsaved edits block approval.
- Report markdown is rendered through a minimal line-based text renderer (headings/lists/paragraphs);
  no `{@html}` anywhere. Diff is shown in a `<pre>`.
- Terminal run states auto-navigate to the Result screen only on an actual transition.
- Interview limits (5 rounds / 15 questions / 3 per round) are mirrored in `lib/labels.ts` so the
  desktop package stays type-only on `@agent-orchestrator/contracts`.

## Verified / not verified

Verified on this machine (Windows 11, Node 24, pnpm 12.9.1, Rust 1.95 MSVC):

- `svelte-check`: 0 errors, 0 warnings.
- `vite build`: ok.
- `cargo check` in `src-tauri`: ok (tauri 2.12, tauri-plugin-dialog 2.8).
- Playwright E2E (chromium) against the mock transport: see the final report / CI output.

Not verified:

- Running inside a real Tauri window against the real runner (`apps/runner` had no `main.ts`
  when this package was written); the protocol implementation follows the spec text only.
- Packaged build: the plan is a Node SEA binary at
  `src-tauri/binaries/agent-orchestrator-runner-<target-triple>.exe` wired through Tauri
  `bundle.externalBin` and `AGENT_ORCHESTRATOR_RUNNER_CMD`. `externalBin` is intentionally not
  enabled in `tauri.conf.json` because the binary does not exist yet; dev launch via `node` works.
- `tauri dev` / `tauri build` end to end (only `cargo check` was run).
- Icons in `src-tauri/icons` are generated placeholders.
