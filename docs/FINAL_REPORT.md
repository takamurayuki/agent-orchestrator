# 最終レポート（実装済み / 未実装 / 実測済み / 未実測）

作成日: 2026-11-01（実環境検証後に更新）　対象: `docs/SPEC.md` v2.0　受入結果: `docs/ACCEPTANCE_REPORT.md`（**PASS 56 / FAIL 0 / NOT_RUN 0**）

## 0. 実環境検証の結果（今回の追加）

| 項目 | 結果 | 実測内容 |
|---|---|---|
| LIVE-01 headless（`tests/e2e/live-pipeline.test.ts`） | **PASS** | 専用サンプルリポジトリで 依頼 → ヒアリング（Claude Code、ツール無し・JSON Schema 出力）→ 承認 → 実装（Claude Code、サンドボックス）→ 検証（pnpm install / typecheck / lint / test:run 全 exit 0）→ レビュー（Codex `approved`）→ 完了ゲート 7 項目通過 → **COMPLETED**。1 ラウンド、3 分 24 秒。差分は `src/greet.ts` +3、`test/greet.test.ts` +8 |
| LIVE-02 | **PASS** | 元リポジトリの HEAD・作業ツリーが不変、ワークスペースに remote 無しを assert。egress ログで allowlist 外（`*.oaiusercontent.com`、`ab.chatgpt.com`、`example.com`）は 403 |
| GUI ⇔ 実 Runner（`tauri dev`） | **PASS** | WebView2 のリモートデバッグに Playwright を CDP 接続（`apps/desktop/e2e-live/gui-live.spec.ts`）。Home で環境チェック表示 → フォルダー指定 → プロジェクト情報 → 依頼入力 → ヒアリング画面 → 同意 → 「この内容で開発を開始」→ Run 画面（task.yaml 固定表示）→ 結果画面「完了（COMPLETED）」まで 2.5 分で完走 |
| LIVE-03a（配布 exe、Node 同梱） | **PASS** | `scripts/build-sidecar.mjs`（esbuild → Node SEA → postject、node v24.22.1 同梱、95 MB）+ `tauri build --no-bundle`。Node を PATH から外した `env -i` 環境で `agent-orchestrator-desktop.exe` を起動 → 同梱サイドカーが `ready` → GUI の environment.check / project.inspect が成功 |
| LIVE-03b（環境不足の明示） | **PASS** | サンドボックスイメージ名を存在しないものにして起動 → 「✖ 実行不可：セットアップが必要です」と修正方法が表示され、開始ボタンが無効 |
| 回帰（既存テスト） | **PASS** | Vitest 156 件（実 Docker 6 件含む、+7 件の回帰テスト追加）、Playwright 13 件、svelte-check / cargo check / tsc / eslint クリーン |

### 実測で発見し修正した不具合（すべて回帰テスト追加）

| # | 発見場所 | 症状 | 修正 | 回帰テスト |
|---|---|---|---|---|
| 1 | LIVE-01 | Claude Code `--json-schema` が契約の `$schema`（draft 2020-12 URI）を解決できず終了 → Draft が BLOCKED | `toClaudeJsonSchema` で `$schema` / `$id` を除いて渡す（検証は元スキーマで実施）D-19 | `agents.test.ts` |
| 2 | LIVE-01 | ホストの `codex` が `.cmd` シム → `spawn` が EINVAL / `codex.exe` が allowlist 外で environment.check が例外 | `.exe` を allowlist に追加、`.cmd` は同じ場所の JS エントリを `node` で起動 D-20 | `process-runner.test.ts` |
| 3 | LIVE-01 | Codex の bubblewrap が user namespace を作れず（Docker 既定 seccomp）コマンドを実行できないまま diff のみでレビュー | Reviewer コンテナのみ `seccomp=unconfined`（cap-drop ALL 等は維持）D-22。修正後は `exec succeeded` を確認 | `agents.test.ts` |
| 4 | LIVE-01 | Requirements Agent 失敗時に Draft 用のプロキシコンテナ・ネットワークが残留 | `finally` で cleanup | `agents.test.ts` |
| 5 | GUI | 実データで同じ `key` の facts が複数あり、Svelte `each_key_duplicate` でヒアリング画面が描画されない | `FactsPanel` のキーを `key:index` に変更。モックデータに重複 key を追加 | Playwright 13 件（UI-04〜08 が重複 key を通る） |
| 6 | GUI | Codex がコンテナ内の `.pnpm-store` を untracked として言及 | ワークスペースの `.git/info/exclude` に同期除外パスを登録 | `workspace.test.ts` |
| 7 | 配布 | SEA 化のため JSON Schema の実行時ファイル読込・`import.meta.url` が使えない | スキーマを `schemas.generated.ts` に埋め込み、version をバンドル時に埋め込み、`node:sea` でエントリ判定 D-21 | contracts 17 件（埋め込みスキーマで検証） |

### 安全条件の遵守

- 実 CLI の利用量: LIVE-01 headless 1 回、GUI 1 回、認証スモーク 1 回（Claude 約 $0.01 + 2 回の実装/ヒアリング、Codex レビュー 2 回 + スモーク 1 回）。Builder の予算上限 `--max-budget-usd 10`、Requirements Agent `3`、`cliTimeoutSeconds 900`、`maxDurationSeconds 2700`、試行 3 回を適用。
- 対象は `tests/fixtures/make-sample-repo.mjs` が生成する一時リポジトリのみ。push / merge / deploy は行っていない（ワークスペースに remote 無し、egress は allowlist のみ）。
- 認証情報はコンテナ env / 0600 ファイルで注入し、ログ・レポート・イベントはマスキング。本レポートにも含めない。
- 破壊的操作・権限不足は発生していない（別アプリが使用中だったデバッグポート 9222 は避けて 9333 を使用）。

## 1. 実装済み（自動テストで実測）

| 領域 | 内容 | 根拠 |
|---|---|---|
| 契約 | `contracts/*.schema.json`（task / review / interview / ipc）+ 追加の `task-proposal.schema.json`、Zod と Ajv の二重検証、埋め込みスキーマ | `packages/contracts/test` 17 件 |
| 実行状態機械 | CREATED→PREFLIGHT→IMPLEMENTING→VERIFYING→REVIEWING→COMPLETED、NEEDS_HUMAN / PRECHECK_FAILED / INTERRUPTED / INTERNAL_ERROR、3 回上限、検証失敗時はレビューを飛ばす、unknown / JSON 不正 / 不整合は人間へ | `engine.test.ts` 22 件（EX-01〜13） |
| 完了ゲート | 7 ゲートを純粋関数 `evaluateCompletionGate` に実装 | `gate.test.ts` 11 件 |
| プロセス制御 | `shell:false`、コマンド allowlist（`.exe`/`.cmd` 含む）、タイムアウト時のプロセスツリー停止、出力上限、マスキング | `process-runner.test.ts` |
| 隔離ワークスペース | detached clone（remote 削除、hooks 無効、同期除外を git exclude）、未追跡を含む差分、tree hash、元リポジトリ不変 | `workspace.test.ts`（実 git） |
| Docker サンドボックス | 使い捨てコンテナ、非 root、cap-drop ALL、no-new-privileges、read-only root、pids/cpu/mem、internal ネットワーク + allowlist プロキシ、名前付きボリューム + tar 同期、`docker kill` による停止 | `docker-sandbox.test.ts` 6 件（実 Docker）+ LIVE |
| 起動前検査 | 環境チェック + リポジトリ + 検証プロファイル + 認証注入可否 + Docker 隔離の実測 | `preflight.test.ts`、LIVE の preflight 全 ok |
| Verifier | `node-pnpm` 固定コマンド、逐次実行、失敗で停止・欠落記録、タイムアウト | `verification.test.ts` + LIVE |
| Builder / Reviewer アダプタ | 実フラグに基づく argv、危険フラグ拒否、JSON 解析・契約検証、認証注入、read-only レビュー + bubblewrap 動作 | `agents.test.ts` + LIVE |
| Requirements Agent | read-only 調査、facts の根拠付け、ギャップ分析、回答/スキップ/戻る、素案 → task.yaml、承認、再承認 | `repo-inspector` / `gap-analyzer` / `task-generator` / `draft-service` テスト + LIVE |
| 永続化・監査 | SQLite（WAL）、連番イベント、`runs/<runId>/...`、report.md、再起動時の INTERRUPTED 復旧 | `storage.test.ts`、`run-service.test.ts` |
| IPC | stdio 行単位 JSON、method allowlist、Zod params、順序保持、再接続 | `ipc.test.ts` + 実起動 |
| デスクトップ | Tauri 2（サイドカー管理、1 method = 1 command）+ Svelte 5 の 4 画面、配布サイドカー解決 | svelte-check、cargo check、Playwright 13 件、LIVE GUI |
| 配布 | Node SEA サイドカー、`externalBin`、リリース exe | LIVE-03 |

## 2. 未実装 / 未実測

| 内容 | 状態 |
|---|---|
| インストーラ（NSIS / MSI）の作成と再署名 | 未実施。`tauri build --no-bundle` の exe + サイドカー exe の組で起動を実測 |
| WSL2 ディストリビューション内で runner を動かす構成 | 未実測（本環境の WSL Ubuntu に Docker 連携が無い）。Windows 側 Docker Desktop 経由で動作 |
| `node-pnpm` 以外の検証プロファイル | MVP 対象外 |
| egress の TLS 検査 | プロキシは CONNECT 中継のみ |
| 複数ラウンド（検証失敗 → 修正、changes_requested → 修正）の実 CLI での実測 | 2 回の実行はいずれも 1 ラウンドで完了。ループ自体はモックで EX-02/03/04 を検証済み |
| 大規模リポジトリでの性能 | サンプル（8 ファイル）のみ実測 |

## 3. 残課題

1. インストーラ作成と署名（LIVE-03 の配布形態の完成）。
2. 実 CLI での複数ラウンド（修正ループ）の実測機会を得る（意図的に失敗するサンプルで）。
3. Codex コンテナの seccomp を「既定 + user namespace 関連のみ許可」のカスタムプロファイルに狭める。
4. egress プロキシのログを `runs/<runId>/egress.jsonl` に保存し UI に表示する。
5. `pnpm install --ignore-scripts` で動かない依存を持つプロジェクトへの対応方針。
