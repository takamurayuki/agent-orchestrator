# Agent Orchestrator

CLI に不慣れな開発者が、自然言語で依頼し、必要な質問に答えて要件を承認するだけで、
**Claude Code による実装 → 機械的検証 → Codex による独立レビュー → 必要時の再修正** を単一タスク単位で完結させるローカルデスクトップアプリ（MVP）。

仕様: [`docs/SPEC.md`](docs/SPEC.md)（Source of Truth）、受入テスト: [`docs/ACCEPTANCE.md`](docs/ACCEPTANCE.md)、技術的決定: [`docs/DECISIONS.md`](docs/DECISIONS.md)、最終レポート: [`docs/FINAL_REPORT.md`](docs/FINAL_REPORT.md)。

## 厳守事項（実装で強制）

- 承認前に Builder を呼ばない（承認済みスナップショットだけが Run に渡る）
- レビューを通っただけで完成扱いしない（7 つの完了ゲートを純粋関数で判定）
- 判断不能（JSON 不正・unknown・タイムアウト）は成功に変換しない → `NEEDS_HUMAN` / `BLOCKED`
- 元ブランチへの自動反映・push・merge・deploy・外部送信はしない（依頼に含まれていれば拒否し手動対応を案内）
- 隔離（Docker、非 root、egress allowlist）を**実測**で確認できなければ実行しない（fail-closed）

## 構成

```
apps/
  desktop/   Tauri 2 + Svelte 5 の 4 画面 UI（業務ロジックを持たない。Rust が Node サイドカーを管理）
  runner/    Node 22 + TypeScript のオーケストレータ（状態機械・完了ゲート・プロセス制御・永続化・IPC）
packages/
  contracts/ JSON Schema（contracts/*.schema.json）と Zod スキーマ、生成型
docker/      サンドボックスイメージと egress プロキシの Dockerfile
prompts/     Requirements / Builder / Reviewer プロンプトの説明
docs/        SPEC / ACCEPTANCE / DECISIONS / FINAL_REPORT / ACCEPTANCE_REPORT
tests/       integration（実 Docker）・e2e（実 CLI、RUN_LIVE_E2E=1）・fixtures
```

## 前提ソフトウェア

| 要件 | 確認方法 | 備考 |
|---|---|---|
| Windows 11 + WSL2 + Docker Desktop（WSL2 バックエンド、Linux コンテナ） | `docker info` | コンテナは WSL2 の Linux VM 内で動く。Linux + Docker でも動作する設計（未実測） |
| Node.js 22.13 以上（開発時） | `node --version` | `node:sqlite` を使うため 22.13+。配布時はサイドカーに同梱する設計（未検証） |
| pnpm 12 | `pnpm --version` | `corepack enable` でも可 |
| Git | `git --version` | |
| Rust toolchain + MSVC（デスクトップをビルドする場合） | `cargo --version` | Tauri 2 の要件に従う |
| Claude Code の認証 | ホストで一度 `claude` を起動してログイン、または `ANTHROPIC_API_KEY` | 認証の自動取得は行わない |
| Codex CLI の認証 | ホストで `codex login`、または `OPENAI_API_KEY` | 同上 |

ホストに `claude` / `codex` がインストールされている必要はありません（実行はサンドボックスイメージ内のピン留め版）。ただしホスト版がある場合はフラグ互換を `environment.check` で照合します。

## セットアップ

```bash
pnpm install
pnpm build                 # contracts と runner をビルド
pnpm sandbox:build         # Docker イメージ 2 つをローカルでビルド（初回は数分）
pnpm runner:check          # 環境チェック（JSON）。canRun=true になるまで表示される fix に従う
```

`pnpm runner:check` は OS / Git / Docker デーモン / イメージ / CLI フラグ互換 / 認証ファイルの有無 / app-data 書込 / ディスク容量 / egress allowlist を確認します。Run の起動前にはさらに Docker 隔離（直接通信の遮断・allowlist 外の 403・read-only・非 root）をプロービングコンテナで**実測**し、1 つでも失敗すれば `PRECHECK_FAILED` で停止します。

### デスクトップアプリ（開発モード）

```bash
pnpm --filter @agent-orchestrator/desktop run tauri:dev
```

Rust 側が `node apps/runner/dist/main.js --ipc stdio` をサイドカーとして起動します（`AGENT_ORCHESTRATOR_RUNNER_CMD` / `AGENT_ORCHESTRATOR_RUNNER_ARGS` で変更可）。ブラウザのみで UI を確認する場合は `pnpm --filter @agent-orchestrator/desktop run dev`（モックトランスポート）。

## 使い方（4 画面）

1. **Home / Create**: プロジェクトフォルダーを選択（Git・ベースブランチ・検証プロファイルの可否を read-only で確認）、依頼を自然言語で入力。
2. **Interview / Approve**: 調査で判明した事実（確認済み / 推測 / 未確定を分離表示）を踏まえ、未確定事項だけを最大 3 問ずつ質問。推奨案と根拠を表示。回答・スキップ・戻るが可能。blocking の質問が未回答なら承認できない。要件サマリー（目的 / スコープ / 対象外 / 実装方針 / 受入条件 / 不明事項）を編集でき、編集は新しい revision になる。リポジトリ内容がモデルに送信されることへの同意の上で **「この内容で開発を開始」** を押すと task.yaml が固定され Run が始まる。
3. **Running**: 状態、ラウンド（n/3）、検証結果、レビュー指摘件数、経過時間、キャンセル。全イベントは折りたたみログに表示。
4. **Result / History**: 完了 / 要確認 / 中断を明示。変更ファイル、差分、未解決指摘、レポート、ワークスペースの場所、次の手動操作、履歴。

## 検証プロファイル

`node-pnpm` のみ。対象リポジトリの `package.json` に `typecheck` / `lint` / `test:run` scripts と `pnpm-lock.yaml` が必要です。実行コマンドは固定（`pnpm install --frozen-lockfile --ignore-scripts` → `pnpm run typecheck` → `pnpm run lint` → `pnpm run test:run`）で、task.yaml から任意コマンドは実行できません。

## セキュリティ・隔離の設計

- **実行環境**: Run ごとに使い捨てコンテナ（`docker run --rm`）。非 root（uid 1001）、`--cap-drop ALL`、`--security-opt no-new-privileges`、read-only root FS、`--pids-limit` / `--cpus` / `--memory`、Docker socket 非マウント。
- **ワークスペース**: 元リポジトリから detached clone（remote 削除・hooks 無効）を作り、Run ごとの名前付きボリュームに tar で同期。Builder は `/workspace` のみ書込可、Reviewer は read-only マウント。レビュー前後のツリーハッシュ一致を完了条件にする。bind mount は使わない（この環境の Docker Desktop で I/O エラーになることを実測。`docs/DECISIONS.md` D-18）。
- **ネットワーク**: Run ごとの `--internal` ネットワーク + allowlist CONNECT プロキシ。既定の許可先は `api.anthropic.com, api.openai.com, chatgpt.com, auth.openai.com, registry.npmjs.org`（`AGENT_ORCHESTRATOR_EGRESS_ALLOWLIST`）。typecheck / lint / test はネットワーク無し。
- **CLI 権限**: `--dangerously-skip-permissions` / `bypassPermissions` / `danger-full-access` は argv 組み立て時に拒否。Builder は `--permission-mode acceptEdits --permission-prompts none` + ツール allowlist、対象リポジトリの `.claude/settings`（hooks）は読み込まない。Reviewer は `--sandbox read-only`。
- **認証情報**: ホストの設定済み認証を環境変数（Claude）または 0600 のファイル（Codex、Run 終了時にボリュームごと削除）で注入。ログ・イベント・レポートはマスキング。
- **入力検証**: すべての AI 出力と YAML を Zod + JSON Schema で二重検証。IPC は method allowlist と Zod params。子プロセスは常に `shell:false`、コマンド名 allowlist。
- **リポジトリ調査**: read-only、`.env` / 鍵 / 認証ファイルを除外、symlink を辿らない、ファイル数・サイズ・時間の上限。README 等の内容は非信頼データとしてモデルに渡す。

## 永続化と出力

```
~/.agent-orchestrator/app-data/           （AGENT_ORCHESTRATOR_APP_DATA で変更可）
  orchestrator.sqlite                      projects / drafts / draft_revisions / questions / answers / approved_tasks / runs / run_events / review_findings / run_rounds
  tasks/<taskId>/revisions/<rev>/task.yaml
  runs/<runId>/{task.snapshot.yaml, metadata.json, events.jsonl, status.json, report.md, rounds/<n>/{builder.log,verify.json,verify.log,review.json,review.raw.txt,review.log,diff.patch,round.json}}
  worktrees/<runId>/                        隔離ワークスペース（失敗時も保全。削除は手動）
```

アプリ再起動時、実行中のまま残っていた Run は自動再開せず `INTERRUPTED` として表示します。

## テスト

```bash
pnpm typecheck && pnpm lint
pnpm test:run                                        # unit + integration（モック CLI、実 git、実 SQLite）
RUN_DOCKER_TESTS=1 pnpm test:docker                  # 実 Docker: 隔離・egress・read-only・同期の実測
pnpm test:e2e                                        # Playwright（UI、モックトランスポート）
RUN_LIVE_E2E=1 pnpm vitest run tests/e2e             # 実 CLI の LIVE-01/02（費用と時間がかかる。専用サンプルリポジトリを自動生成）
pnpm acceptance                                      # ACCEPTANCE.md の ID ごとに PASS/FAIL/NOT_RUN を集計 → docs/ACCEPTANCE_REPORT.md
```

## 配布ビルド（Node 同梱サイドカー）

```bash
node scripts/build-sidecar.mjs                      # esbuild → Node SEA → postject。apps/desktop/src-tauri/binaries/ に配置
pnpm --filter @agent-orchestrator/desktop exec tauri build   # NSIS: target/release/bundle/nsis/Agent Orchestrator_0.1.0_x64-setup.exe（サイドカー同梱）
```

Rust は実行ファイルと同じディレクトリに `agent-orchestrator-runner(.exe)` があればそれをサイドカーとして使い、無ければ開発モード（ホストの `node apps/runner/dist/main.js`）にフォールバックします。インストーラを Node が PATH に無い環境へサイレントインストールして起動・接続できることを実測済み（LIVE-03）。コード署名は署名鍵が無いため未実施で、手順は `docs/RELEASE.md` を参照（未署名のまま配布しない）。

## LIVE 検証（実 CLI）

```bash
RUN_LIVE_E2E=1 pnpm vitest run tests/e2e                     # LIVE-01/02 headless（専用サンプルリポジトリを自動生成）
# GUI ⇔ 実 Runner: WebView2 のリモートデバッグに Playwright を CDP 接続する
set WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9333
pnpm --filter @agent-orchestrator/desktop run tauri:dev      # または target/release の exe
LIVE_CDP_URL=http://127.0.0.1:9333 LIVE_SAMPLE_REPO=<sample repo> pnpm --filter @agent-orchestrator/desktop exec playwright test -c playwright.live.config.ts
#   LIVE_MODE=smoke（環境チェック + プロジェクト選択のみ）、LIVE_EXPECT_ENV_FAIL=1（利用不可表示の確認）
```

実行結果は `docs/FINAL_REPORT.md` と `docs/ACCEPTANCE_REPORT.md`（`test-results/live.json` を集計）に記録しています。モデル API を呼ぶため費用が発生します（LIVE-01 の 1 回あたり: Claude 数十円規模、Codex はサブスクリプション消費）。

## 既知の制限・未検証事項

- コード署名は未実施（署名鍵なし）。NSIS インストーラの作成・サイレントインストール・起動・アンインストールは実測済み。
- WSL2 ディストリビューション内で runner を動かす構成は未実測（Docker Desktop の WSL 連携が必要）。
- egress プロキシは TLS を終端しないため、許可ホストへの通信内容は検査しない。
- `pnpm install --ignore-scripts` のため postinstall が必要な依存を持つプロジェクトでは検証が失敗し得る（`NEEDS_HUMAN`）。
- 検証プロファイルは `node-pnpm` のみ。
- Reviewer（Codex）コンテナは bubblewrap を動かすため、Docker 既定 seccomp に `unshare/clone/mount/umount2/pivot_root` だけを追加したカスタムプロファイルを使う（capability は全て落としたまま。`docs/DECISIONS.md` D-22）。
- Builder の試行上限は 3 回（初回 + 修正 2 回）。上限到達・判断不能はすべて人間へ戻す。
- 「完了」はゲート通過の意味であり、バグが無いことやセキュリティの完全性を保証しない。最終反映はユーザーが手動で行う。
