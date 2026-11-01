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

### 配布版（NSIS インストーラ）を使う場合の前提条件

| 要件 | 備考 |
|---|---|
| Windows 11 x64 | WebView2 ランタイム同梱（Windows 11 標準）。他 OS 向けの配布物はありません |
| Docker Desktop（WSL2 バックエンド）が起動していること | Docker が無い / 起動していない場合はアプリの「セットアップチェック」に「失敗」と修正方法が表示され、開始できません |
| Git | PATH にあること。無いとセットアップチェックで失敗と表示されます |
| サンドボックスイメージ 2 つ（`agent-orchestrator-sandbox:0.1.0`、`agent-orchestrator-egress-proxy:0.1.0`） | 配布物には含まれませんが、**初回起動時にアプリの「サンドボックスを準備する」から用意できます**（Docker Hub からピン留めしたベースイメージ `node:22.23.4-bookworm-slim@sha256:4b150b…` を取得し、ダイジェストを検証してからローカルでビルド。取得には同意のチェックが必要）。開発環境では `pnpm sandbox:build` でも可 |
| Claude Code / Codex の認証ファイル | ホストで一度ログインしておく（`claude` / `codex login`）。アプリは認証を代行しません |
| Node.js | **不要**（サイドカーに同梱） |

インストーラは**未署名**です（署名鍵なし）。SmartScreen の警告が出ます。社内検証用のリリース候補として扱い、一般公開版とは区別してください（`docs/RELEASE.md`）。

β版テスター向けの平易な手順・前提・料金・既知の制限・トラブルシューティングは `docs/BETA_TESTER_GUIDE.md`、問題報告は `docs/ISSUE_TEMPLATE.md`、協力者テストの手順は `docs/BETA_USER_TEST_PROTOCOL.md`、β運用の結果と次期改善は `docs/LIMITED_BETA_REPORT.md` を参照。

### 初回起動から最初の開発まで（GUI のみ、Node.js / pnpm 不要）

1. インストーラを実行し、アプリを起動する（セットアップチェックが自動で走る）。
2. Docker Desktop が起動していれば、「サンドボックスを準備する」が表示される。同意にチェック → 「サンドボックスを準備する」を押す（初回のみ、数分）。取得・ビルド・検証の手順と進捗が表示され、失敗時は原因と復旧方法、「再試行」が出る。完了すると自動で再チェックされ「実行可能」になる。
3. プロジェクトフォルダーを選択（または入力）→「選択」。
4. 依頼内容を入力 →「開始」。
5. 質問に回答して「回答して次へ」（通常 1〜2 ラウンド）。
6. 要件サマリーを確認し、同意にチェック →「この内容で開発を開始」。
7. 実行が終わると結果画面に移る。「変更内容を見る」「作業用コピーのフォルダーを開く」で成果を確認する（元のプロジェクトへの反映は手動）。

イメージの管理: `docker/manifest.json` にバージョンとベースイメージのダイジェストを固定し、取得したベースイメージの `RepoDigests` と、ビルドしたイメージのラベル（`dev.agent-orchestrator.version` / `dev.agent-orchestrator.base-digest`）を検証します。検証に失敗したイメージは削除して使いません。セットアップチェックも毎回ラベルを照合し、一致しないイメージは「使用しません」と表示します。アプリから任意のコマンドを実行する機能はありません（docker の固定引数のみ）。

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

## 運用者設定（環境変数）

| 変数 | 既定 | 用途 |
|---|---|---|
| `AGENT_ORCHESTRATOR_APP_DATA` | `~/.agent-orchestrator/app-data` | SQLite・tasks・runs・ワークスペースの保存先 |
| `AGENT_ORCHESTRATOR_EGRESS_ALLOWLIST` | `api.anthropic.com,api.openai.com,chatgpt.com,auth.openai.com,registry.npmjs.org` | コンテナから到達できるホスト。例: Prisma を使うプロジェクトでは `binaries.prisma.sh` を追加 |
| `AGENT_ORCHESTRATOR_MEMORY` / `_CPUS` / `_PIDS` | `4g` / `2` / `512` | ステップコンテナの資源上限。モノレポの並列 typecheck が SIGKILL される場合はメモリを増やす |
| `AGENT_ORCHESTRATOR_PNPM_MIN_RELEASE_AGE` | （未設定 = pnpm 既定） | pnpm 12 の supply-chain policy（公開からの最小経過時間）。ホストで承認済みの lockfile がサンドボックスで拒否される場合に `0` 等を設定（D-26） |
| `AGENT_ORCHESTRATOR_SANDBOX_IMAGE` / `_EGRESS_IMAGE` | `agent-orchestrator-sandbox:0.1.0` / `agent-orchestrator-egress-proxy:0.1.0` | ピン留めイメージ |

Run の起動前には、変更前のリポジトリに対して検証プロファイルを一度実行する「ベースライン検証」を行い、通らなければ AI を呼ばずに `PRECHECK_FAILED` で止まります（D-23）。上の設定はこのベースラインを通すために使います。

## 使い方（4 画面）

1. **Home / Create**: プロジェクトフォルダーを選択（Git・ベースブランチ・検証プロファイルの可否を read-only で確認）、依頼を自然言語で入力。
2. **Interview / Approve**: 調査で判明した事実（確認済み / 推測 / 未確定を分離表示）を踏まえ、未確定事項だけを最大 3 問ずつ質問。推奨案と根拠を表示。回答・スキップ・戻るが可能。質問が終わると要件サマリー（何を作るか / 機能要件 / 受入条件 / 制約 / 進め方 / 確認方法 / 推奨・未確定）を最初に表示し、YAML を見ずに承認できる。blocking の質問が未回答、または未解消の矛盾があれば承認できない。編集フォームは折りたたみで、編集は新しい revision になり再承認（同意の取り直し）が必要。リポジトリ内容がモデルに送信されることへの同意の上で **「この内容で開発を開始」** を押すと task.yaml が固定され Run が始まる。
3. **Running**: 「現在の処理」（要件分析 / 実行前の確認 / 実装・修正 / 検証 / レビュー）を日本語で表示、ラウンド（n/3）と経過時間（終了時刻の予測はしない）、検証結果、レビュー判定、「実行を停止する」。終了時は原因と対応を表示。Run ID・パス・task.yaml は技術情報に折りたたみ、生ログは表示しない（イベント要約のみ）。
4. **Result / History**: 状態を平易な見出しで表示（完了 / 人の判断が必要 / 実行前の確認で停止 / 中断）し、何が起きたか・変更の状態・次にできることを示す。未解決の指摘は原因・影響・次の操作付き。未検証・途中の変更は「完了」と誤認させない注意を出す。変更ファイルと差分、作業用コピーのパスのコピー、新しい依頼。元プロジェクトへの反映はアプリでは行わない（ボタンも出さない）。内部ステータス・技術情報・egress・report.md は折りたたみ。

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

## 品質保証（v2.1 / v2.2）

- **Policy Gate（静的チェック）**: 各ラウンドの差分に対し、AI レビューとは独立に、新規の `eslint-disable` / `@ts-ignore` / `@ts-nocheck`、テストの `skip` / `only` / `todo` 追加、テストファイル削除、必須検証 scripts（typecheck / lint / test:run）の削除・無効化・変更、tsconfig / ESLint / Vitest・Jest・Playwright 設定の緩和を検出します。ベースコミットの内容と比較するので既存の違反は数えません。コメント・テスト構文・設定は AST（TypeScript コンパイラ API）で解析し、文字列内の一致は無視します。未承認の違反は Builder に差し戻され（修正可能）、残ったままでは完了できません。AI レビューの approved では上書きできません。
- **例外の承認**: 意図的な例外は**ベースコミット**の `.agent-orchestrator/policy.json` に理由付きで登録します（作業ツリー側＝AI が書いた内容は無視）。
  ```json
  { "allow": [{ "ruleId": "PG-ESLINT-DISABLE", "file": "src/legacy/**", "reason": "移行中のため no-console を許容" }] }
  ```
- **矛盾検出**: ヒアリングの最後に、要件同士と要件と既存コード・設定（lint ルール、型設定、既存実装）の矛盾を検出し、重大なものは選択肢と影響を示す質問として差し戻します。解消するまで承認できず、判断は意思決定ログ（`decisions.json`、画面の「意思決定ログ」）に残ります。
- **判定不能は不合格（v2.2、D-31）**: 構文エラーで解析できないファイルは `PG-UNPARSEABLE`、検出器の例外は `PG-ANALYSIS-ERROR` として blocking にし、「検出 0 件」と区別します。ソース解析は TypeScript コンパイラ API に限定し、正規表現によるソース解析は行いません。
- **検証 scripts の変更分類（v2.2、D-34）**: 削除・無効化は blocking、`&&` での追加や厳格化フラグの追加は warning（内容を表示、完了は可）、どちらとも機械的に判断できない変更は blocking で人間の例外登録が必要です。AI は例外を承認できません。
- **意思決定ログ（v2.2、D-32）**: 通常質問の回答・矛盾の解消・承認前の要件修正を共通の形式（出所・選択肢・理由・影響・対象要件・履歴・状態）で記録します。「戻る」は取り消しとして履歴に残り、同じ事項に矛盾する判断があれば新しい方を優先して古い方を `superseded` にします。素案の再生成時は有効な判断を拘束条件として渡すため、再質問しません。
- **ポリシー差し戻しの可視化（v2.2、D-33）**: 未承認の違反があるラウンドは `POLICY_BLOCKED` 状態を経て Builder に戻り、渡したフィードバックは `rounds/<n>/feedback.json` に残ります。

## 永続化と出力

```
~/.agent-orchestrator/app-data/           （AGENT_ORCHESTRATOR_APP_DATA で変更可）
  orchestrator.sqlite                      projects / drafts / draft_revisions / questions / answers / approved_tasks / runs / run_events / review_findings / run_rounds
  tasks/<taskId>/revisions/<rev>/task.yaml
  runs/<runId>/{task.snapshot.yaml, metadata.json, events.jsonl, status.json, report.md, egress.jsonl, rounds/<n>/{builder.log,verify.json,verify.log,review.json,review.raw.txt,review.log,diff.patch,round.json,policy.json,feedback.json}}
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
UX_WALKTHROUGH=1 pnpm --filter @agent-orchestrator/desktop exec playwright test e2e/ux-walkthrough.spec.ts   # 4 画面のスクリーンショットを .tmp/ux/ に保存（docs/UX_REVIEW.md の根拠）
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
# ドッグフーディング（ヒアリング→承認→Run を機械回答で通す。--prefer で選択肢を指定可）
node scripts/dogfood.mjs --name <id> --repo <path> --request "<依頼>" [--prefer eslint_disable,...]
# Policy Gate 差し戻しループの再現（人間が書いた task.yaml を直接承認して Run）
node scripts/live-policy-loop.mjs --name <id> --repo <path> --task tests/fixtures/tasks/policy-loop-console.yaml
```

実行結果は `docs/FINAL_REPORT.md` と `docs/ACCEPTANCE_REPORT.md`（`test-results/live.json` を集計）に記録しています。モデル API を呼ぶため費用が発生します（LIVE-01 の 1 回あたり: Claude 数十円規模、Codex はサブスクリプション消費）。

## 既知の制限・未検証事項

- コード署名は未実施（署名鍵なし）。NSIS インストーラの作成・サイレントインストール・起動・アンインストールは実測済み（`docs/RC_VERIFICATION.md`）。未署名のため、リリース候補（RC）として社内配布に限定する。
- サンドボックスイメージは配布物に含まれない。初回起動時に GUI から取得・ビルドする（Docker Hub への到達が必要。社内プロキシ環境では Docker Desktop 側のプロキシ設定が必要）。ビルド済みイメージのレジストリ配布は未実施。
- クリーンな Windows 環境（別 PC / VM）での検証は未実施。同一 PC 上で PATH を最小化（Node / Git / Docker なし）した起動と、Node 非搭載 PATH での全フローを実測した。
- 元プロジェクトへの反映（コミット・push）機能は無い。作業用コピーのパスを示すだけで、取り込みは利用者が Git ツールで行う。
- 外部テスターによる操作性評価は未実施。
- WSL2 ディストリビューション内で runner を動かす構成は未実測（Docker Desktop の WSL 連携が必要）。
- egress プロキシは TLS を終端しないため、許可ホストへの通信内容は検査しない。
- `pnpm install --ignore-scripts` のため postinstall が必要な依存を持つプロジェクトでは検証が失敗し得る（`NEEDS_HUMAN`）。
- 検証プロファイルは `node-pnpm` のみ。
- Reviewer（Codex）コンテナは bubblewrap を動かすため、Docker 既定 seccomp に `unshare/clone/mount/umount2/pivot_root` だけを追加したカスタムプロファイルを使う（capability は全て落としたまま。`docs/DECISIONS.md` D-22）。
- Builder の試行上限は 3 回（初回 + 修正 2 回）。上限到達・判断不能はすべて人間へ戻す。
- 「完了」はゲート通過の意味であり、バグが無いことやセキュリティの完全性を保証しない。最終反映はユーザーが手動で行う。
