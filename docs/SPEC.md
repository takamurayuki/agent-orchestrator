# Agent Orchestrator — 最終実装仕様 v2.0

**ステータス:** 実装ベースライン / 2026-11-01  
**Source of Truth:** この仕様、`contracts/`、`prompts/`、`examples/`。矛盾時は `SPEC.md` → JSON Schema → examples の順に優先。  
**プロダクト目的:** CLIに不慣れな開発者が自然言語で依頼し、必要な質問に回答して要件を承認するだけで、Claude Codeによる実装、機械的検証、Codexによる独立レビュー、必要時の再修正を**単一タスク単位**で完結させる。  
**厳守:** 承認前に実装しない。レビューを通っただけで完成扱いしない。判断不能は成功に変換しない。元のブランチへの自動反映、push、merge、deploy、外部送信はしない。

## 1. 製品境界と用語

- **プロジェクト:** ユーザーが選択したローカルGitリポジトリ。
- **Requirements Agent:** リポジトリを読み取り専用で調べ、ユーザーと対話し、実行可能な `task.yaml` を生成する。MVPではClaude Code CLIの独立呼び出しを利用する（実装エージェントとセッションを共有しない）。
- **Orchestrator:** TypeScriptで書く決定的な状態管理・プロセス制御・承認・完了判定。
- **Builder:** Claude Code CLI。隔離ワークスペースに限って編集。
- **Reviewer:** Codex CLI。読み取り専用で実装差分と要件を評価。
- **Verifier:** AIではない静的チェック・自動テストの実行器。
- **Task Draft:** ヒアリング途中の未確定要求。**実行不可**。
- **Approved Task:** ユーザーが承認し、Schema検証、実行前検証が成功したimmutableなスナップショット。

### 1.1 MVP対象
Windows 11 + WSL2 + Dockerを優先対象とするローカルデスクトップアプリ。単一ユーザー、単一リポジトリ、同時実行1件。Gitベースの既存ソースに対して小〜中規模の機能追加/修正を行う。自然言語入力、コードベース調査、ヒアリング、承認、YAML出力、自律実行、ログ/結果表示、キャンセル、実行履歴を提供する。

### 1.2 MVP対象外
認証情報の自動取得、未インストールCLIの自動導入、クラウド実行、チーム共有、複数案件並列、push/PR/merge/deploy、サンドボックスの自動権限昇格、Git履歴改変、GUIからの任意シェル、AIによるプロダクト戦略の全面決定。GitHubやSNSなどへの自動投稿も禁止。

## 2. 技術選定（固定）

| 責務 | 技術 | 決定理由・制約 |
|---|---|---|
| Desktop Shell | Tauri 2 + Rust | 軽量なウィンドウと最小権限のOS境界 |
| UI | Svelte 5 + TypeScript + Vite | シンプルな4画面。UIにCLIを露出しない |
| Orchestrator | Node.js 22 LTS + TypeScript (ESM) | spawn、stream、JSON/YAML連携、単体テストが容易 |
| Node配布 | サイドカーとしてパッケージング | 開発時はNodeプロセス、配布時はユーザーにNodeインストールを要求しない設計。配布方式と実行バイナリの検証を必須にする |
| 永続化 | SQLite (Node側、WAL) | タスク/回答/状態/イベントのメタデータ。大きいログとdiffはファイル保存 |
| 入力検証 | Zod + YAML + JSON Schema | ユーザー入力/AI出力/実行設定の検証 |
| 子プロセス | Node `spawn` (`shell:false`) | コマンド注入防止、終了コードとストリームの回収 |
| 隔離 | Git worktree + Docker | 元ブランチに触れず、実行プロセスの権限を隔離 |
| Test | Vitest + Playwright | 状態機械の単体試験とUIのE2E |
| CLI adapters | Claude Code / Codex CLI | 設定済みの認証を利用し、バージョンをログに記録 |

**アーキテクチャルール:** UIはRust/Tauri commandを呼び出し、RustがローカルNodeサイドカーを管理する。Node側にはローカルIPC（stdio、行単位JSON-RPC風）を用意する。ネットワーク待受ポート・公開HTTP APIはMVPで作らない。UIはOSコマンドを発行できない。RustはNodeのCLIコマンドを利用者入力から組み立てない。

**クロスOSに関する決定:** Windows上でWindows用CLIを直接実行しない。実行環境はWSL2 Linux内のDockerコンテナに固定する。Tauri/Rust↔Node↔WSL2の引き渡しとファイルパス変換は `EnvironmentAdapter` に閉じ込める。Windows上のNodeサイドカーとWSL内の実行環境との連携を実機で検証し、検証できない構成では「実行不可」を明示する。MVP開発/検証ではWSL2内のNode orchestratorを先に動かし、UIとの接続は後段で実装してよい。

## 3. ユーザージャーニーと画面

### 3.1 ユーザー操作
1. **プロジェクト選択:** ローカルフォルダー選択ダイアログ。Git、ベースブランチ、依存環境、テスト方式を読み取り専用チェック。成功/未検出/実行不能を表示。
2. **要望入力:** 「ログイン機能を追加したい」など自然言語。詳細は任意。内部で Draftを新規作成。
3. **必要最小限の質問:** 調査で判明した内容は質問しない。1画面最大3問のグループ。回答・スキップ・戻るが可能。安全性に重要な未確定項目のスキップは許可しても次へ進めず `BLOCKED` とする。
4. **要件確認:** 目的/スコープ/対象外/実装方針/受入条件/テスト/不明事項を自然言語で表示。ユーザーが修正できる。YAMLの編集は必須にしない。
5. **明示承認:** `この内容で開発を開始` を押した時点でtask.yamlを固定し、新規Runを開始。承認前はBuilderを絶対に呼び出さない。
6. **実行中:** 現在状態、ラウンド、経過時間、失敗・レビュー指摘、キャンセル操作を表示。全ログは折りたたんだ詳細に表示。
7. **結果:** 完了/要確認/中断を明示。変更ファイル、差分、テスト結果、レビュー概要、次の手動操作を表示。ワークツリーは保持。

### 3.2 画面定義（4画面）
- **S1 Home / Create:** プロジェクトフォルダ選択、要望テキスト欄、最近の履歴、開始ボタン。未設定環境はセットアップチェックへ。
- **S2 Interview / Approve:** チャット形式の質問カード、推奨案と根拠、回答欄、進捗、要件サマリー、修正、承認。機械生成された選択肢をそのまま信頼せずUIで安全な文字列表示。
- **S3 Running:** 状態、ラウンド(1/3)、検証結果、レビュー件数、経過時間、実行キャンセル、詳細ログ。
- **S4 Result / History:** ステータス、要約、差分、未解決指摘、レポートを開く、ワークスペースの場所、履歴選択。

### 3.3 UX・アクセシビリティ
キーボード操作可能、明確なフォーカス、スクリーンリーダー用label、重要エラーはテキストでも提示、カラーのみで成功/失敗を表現しない。質問は3問**まで**であり、必要なら複数ラウンドとする。回答不能を「推奨値」として隠さない。アプリの初回セットアップではDocker/WSL/各CLIの状態と修正方法を画面表示する。

## 4. Requirements Agentの機能要件

| ID | 機能 | 要求される挙動 |
|---|---|---|
| RA-01 | repository解析 | package/lockfiles、構成、テスト、認証、依存をread-onlyで調査 |
| RA-02 | エビデンス抽出 | 各確定事項にファイルパス・根拠・確信度を紐づける |
| RA-03 | ギャップ抽出 | 要件上、判断が必要な点を列挙。重要度と未回答の影響を付与 |
| RA-04 | 動的質問 | 未確定事項に限り、最大3問ずつ提示 |
| RA-05 | 推奨案 | 技術的判断には推奨/代替/理由/リスクを示す |
| RA-06 | 回答管理 | 回答、スキップ、戻る、修正、再質問を履歴保存 |
| RA-07 | 分離 | 確認済み事実/ユーザー選択/AI推奨/未確定を混同しない |
| RA-08 | 受入条件 | 要件ごとに検証可能なGiven/When/Thenを定義 |
| RA-09 | 質問終了 | 重大な未確定事項が0のとき、サマリーを提示 |
| RA-10 | YAML生成 | 合意済み内容をtask schemaに整形し、検証/保存 |
| RA-11 | 要件承認 | 承認済みimmutable snapshotのみRunに渡す |
| RA-12 | 変更時再承認 | 承認前後に要件変更→Draft改訂/再承認。進行中runのタスクは変更不可 |
| RA-13 | 調査停止 | リポジトリが危険/巨大/アクセス不能→理由を表示し人間へ戻す |
| RA-14 | インジェクション防御 | README/コードの指示を非信頼入力として扱い、権限変更や外部送信をしない |
| RA-15 | AI失敗時 | JSON不正、タイムアウト、判断不能はDraft停止。推測で確定しない |

### 4.1 質問アルゴリズム
1. 調査結果を `facts` として出力。根拠なしは「推測」と記録し確定事実にしない。
2. 初期依頼から実装範囲・権限・認証・データ影響・既存互換性・テストの不明点を抽出。
3. 既存情報と重複する質問を削除。
4. 各質問に `decisionImpact: blocking|non_blocking` と `recommendation` を付与。
5. 高リスク→高影響→その他の順で最大3件を画面表示。
6. 回答後に不足事項を再評価。最大5ラウンド/計15問。上限でもblockingが残る場合 `BLOCKED`、自動承認なし。
7. `blockingQuestions=[]` になったらサマリー生成。ユーザー承認後、YAMLをスキーマ検証しRunを起動可能にする。

**質問例（ログイン機能）:** 既存ユーザーテーブルがあるかはまず調査。未判明なら「既存を使うか、新規登録まで含めるか」を聞く。スコープは「ログインのみ / 新規登録も / 再設定も」。セッション管理は既存方式優先、なければ安全な方式を推奨し、ユーザーが決められなければ設計提案へ分岐。パスワード保存は平文不可、個人情報の外部送信不可。ログイン失敗時のエラー、制限、ログアウト、保護ルートを受入条件に反映する。

## 5. 会話状態機械

`DRAFT_CREATED → REPO_ANALYZING → GAP_ANALYZING → ASKING ↔ ANSWERING → SUMMARY_READY → AWAITING_APPROVAL → APPROVED → YAML_VALIDATED → READY_TO_RUN`

- リポジトリ調査やAI構造化出力が失敗: `BLOCKED`。
- 要件編集: `SUMMARY_READY` または `ASKING` に戻る。承認フラグをリセット。
- ユーザーキャンセル: `DRAFT_CANCELLED`。
- `APPROVED`以降の内容変更は新Revisionとして作成し、旧Runに影響させない。
- 質問履歴と回答履歴はSQLite、YAMLはローカルファイルに保存。

## 6. 実行状態機械

`CREATED → PREFLIGHT → IMPLEMENTING → VERIFYING → REVIEWING → COMPLETED`

- VERIFYING失敗 → 次のIMPLEMENTING（残試行があれば）。レビューは実行しない。
- REVIEWINGが`changes_requested` → 次のIMPLEMENTING（残試行があれば）。
- REVIEWINGが`unknown`またはJSON不正 → `NEEDS_HUMAN`。
- CLI異常終了、無効な隔離、ポリシー違反、修正上限到達、時間切れ → `NEEDS_HUMAN`（preflightで失敗した場合は `PRECHECK_FAILED`）。
- SIGINT/キャンセル → 子プロセス群の停止後 `INTERRUPTED`。
- 予期しない実装例外 → `INTERNAL_ERROR`。

`maxImplementationAttempts=3`は初回1回+修正2回。各試行は実装 → Verifier → Reviewer（検証通過時のみ）。実装・検証・レビューは逐次実行。進行中Runの並行起動を禁止。

### 6.1 完了ゲート（すべて必須）
1. 実行に用いたtask snapshotがユーザー承認済みである。
2. 全検証コマンドの終了コードが0、タイムアウト/検証欠落なし。
3. 要件に対応した変更差分が存在する（未追跡ファイルも含む）。
4. レビュー出力のJSON形式・内容整合性が有効で、`verdict=approved`。
5. `critical/high`の未解決指摘は0、`requirementsUnverified=[]`。
6. レビュー開始前後のワークスペースハッシュ一致（Reviewerによる意図しない変更の不存在）。
7. 制限時間内で、禁止操作なし。全イベントが永続化されている。

**保証範囲:** approvedは「定めたゲートを通過した」という意味。バグなしやセキュリティ完全性を保証しない。最終反映はユーザーが手動で行う。

## 7. task.yaml 契約

`contracts/task.schema.json` を正とする。主要フィールドは以下。`requirements`、`acceptanceCriteria`は空配列禁止。repoは絶対パス、baseRefをSHAに固定してから実行する。検証プロファイルはあらかじめ定義されたもののみ選べ、任意のシェルコマンドをYAMLから実行しない。

```yaml
schemaVersion: 2
id: TASK-LOGIN-001
title: メールアドレスとパスワードでのログイン
repository: /home/user/projects/web-app
baseRef: develop
requirements:
  - メールアドレスとパスワードで認証する
  - ログアウト時にセッションを無効化する
acceptanceCriteria:
  - id: AC-001
    given: 有効なユーザーが存在する
    when: 正しい認証情報でログインする
    then: 認証済みセッションが確立する
  - id: AC-002
    given: 未認証ユーザーである
    when: 保護された画面にアクセスする
    then: アクセスが拒否される
verificationProfile: node-pnpm
limits:
  maxImplementationAttempts: 3
  maxDurationSeconds: 2700
  cliTimeoutSeconds: 900
  verificationTimeoutSeconds: 300
review:
  blockingSeverities: [critical, high]
```

**実行可能性検証:** `node-pnpm`はプロジェクトの既存 `typecheck` / `lint` / `test:run` scripts を要求する。未定義ならタスク承認画面で不足を表示し、実行を禁止する。検証スクリプトはユーザーのリポジトリに属するため、隔離コンテナ内でのみ実行する。TestsをAIが削除・skipに変更した場合はdiffポリシーチェックでfailする。

## 8. AI入出力契約

### 8.1 Requirements Agent
`contracts/interview.schema.json` のJSONを要求し、少なくとも `facts`, `questions`, `blockingQuestions`, `summary` を含める。回答は `questionId` ごとに管理し、自由入力は文字列として扱う。AIが出力した `commands`、外部URL、権限操作要求を実行しない。値は表示のためにエスケープする。

### 8.2 Builder（Claude Code）
タスクスナップショット、受入条件、ベースSHA、前回のテスト失敗/レビュー指摘を入力として渡す。既存規約に従って実装、必要なテストを追加。検証設定を弱めず、push/merge/deploy/認証情報アクセスを行わない。`claude -p` の非対話方式を用い、バージョン依存のフラグはAdapter内に限定。`--dangerously-skip-permissions`を禁止。

### 8.3 Reviewer（Codex）
`contracts/review.schema.json`を満たすレビューJSONを生成。ベースSHAとの全変更（untracked含む）、要件、受入条件、検証結果を照合。ワークスペースは読み取り専用。`codex exec` の呼び出しはAdapter内に限定し、現在のCLI仕様と`--output-schema`対応をpreflight/実環境で確認。結果JSONが不正な場合はunknownとし、自動修復して合格にしない。

### 8.4 データ境界
モデルへのリポジトリ送信が発生し得ることを承認画面で明示。機密リポジトリは事前確認必須。秘密鍵・`.env`・認証トークン・個人情報をプロンプトに意図せず含めない。Repo調査にはパス除外とファイル容量制限を適用。パス操作はcanonicalizeし、外部パス/symlink escapeを禁止。

## 9. 安全性・隔離要件

- **worktreeは隔離ではない。** Dockerを含む実行コンテナが使えなければ実装を開始しない。
- コンテナは非root、権限最小化、capabilities全削除、no-new-privileges、CPU/メモリ/PID制限、ホストDocker socket未マウント。
- Builderに許可する書込範囲はworktreeのみ。Codexは同範囲もread-only。
- LLMが必要とするネットワーク通信は管理されたegressポリシー内でのみ許可。**通信許可先を技術的に制限できない場合、自律実行を禁止**（制限のないDockerネットワークを安全とみなさない）。認証ファイルは最小権限で注入し、実行ログには保存しない。
- プロンプト・CLI出力は非信頼。`shell:false`、allowlisted argv、ログのマスキング。AIによるコマンド提案をOrchestratorが直接実行しない。
- Dockerイメージはローカルでピン留めし、事前に依存インストール。任意検証コマンドによる権限昇格は禁止。
- タスク作成フェーズでも読み取り調査は同様に機密ファイル除外、ファイル数/サイズ/時間制限を設け、ワークツリーを変更しない。
- 起動前検査対象: Git clean、Docker isolationとegress、CLIバージョン/認証可否、検証profile、ディスク容量、ディレクトリ権限。失敗時は理由を表示して停止。

## 10. プロセス・永続化設計

### 10.1 IPCイベント
`contracts/ipc.schema.json`に従う。request `{id,method,params}` / response `{id,ok,result?,error?}` / event `{event,runId?,payload}`。MVPで許可するmethod: `environment.check`, `project.inspect`, `draft.create`, `draft.answer`, `draft.revise`, `draft.approve`, `run.start`, `run.cancel`, `run.status`, `run.list`, `run.report`。Rust側はmethod allowlistのみ公開する。イベント配送は順序を保持し、UI再接続時はSQLiteに保存した最後のシーケンス番号以降を再取得する。

### 10.2 永続化
SQLite tables: `projects`, `drafts`, `draft_revisions`, `questions`, `answers`, `approved_tasks`, `runs`, `run_events`, `review_findings`。主キーはUUID/ULID、タイムスタンプUTC ISO8601、タスク/レビューJSONはversion列を持つ。生ログは `runs/<runId>/...`、UIには一部抜粋を表示。Run状態はsqlite transactionで保存、イベントには連番を付ける。復旧起動時、実行中のままのRunは自動再開せず `INTERRUPTED` として人間に提示。

### 10.3 出力
```
app-data/
  orchestrator.sqlite
  tasks/<taskId>/revisions/<revision>/task.yaml
  runs/<runId>/
    task.snapshot.yaml
    metadata.json
    events.jsonl
    status.json
    report.md
    rounds/1/{builder.log,verify.json,review.json,diff.patch}
    rounds/2/...
```
秘密情報を含む可能性のあるdiff/logは権限を制限し、レポート出力にもマスキング。大容量ログはサイズ上限で打ち切りとマーカー記録。失敗時も結果を保存し、worktreeを保持して明示的な削除操作まで保全する。

## 11. 機能要件一覧と受入条件の対応

| 機能群 | ID範囲 | 最低合格条件 |
|---|---|---|
| 環境確認とGUI | UI-01〜UI-10 | 4画面、フォルダ選択、非CLI操作、検証結果の表示、キャンセル |
| 要件ヒアリング | RA-01〜RA-15 | 調査→質問→承認→YAML、証拠/推測分離 |
| タスク実行 | EX-01〜EX-13 | worktree、隔離、実装/テスト/レビュー、3回上限、結果 |
| セキュリティ | SEC-01〜SEC-10 | 失敗時fail-closed、秘密情報保護、禁止操作拒否 |
| 保存・監査 | AUD-01〜AUD-05 | リビジョン、実行ログ、履歴、レポート、異常復旧 |

`tests/ACCEPTANCE.md` に個別テストケースを定義する。

## 12. 実装リポジトリ構成

```
agent-orchestrator/
  apps/
    desktop/
      src/routes-or-components/{Home,Interview,Running,Result}.svelte
      src/lib/{api,stores,components}/
      src-tauri/src/{main.rs,commands.rs,sidecar.rs}
    runner/
      src/{main,ipc,engine,gate,report,config,preflight,workspace,isolation}.ts
      src/agents/{requirements,claude,codex}.ts
      src/requirements/{repo-inspector,gap-analyzer,questions,task-generator}.ts
      src/verification/{profiles,runner}.ts
      src/storage/{db,repository}.ts
  packages/
    contracts/    # JSON schemas / Zod schemas and generated TS types
  prompts/{requirements,builder,reviewer}.md
  examples/{task.yaml,interview.json,review.json}
  tests/{unit,integration,e2e}/
  docs/{SPEC,ACCEPTANCE,DECISIONS}.md
  package.json
  pnpm-workspace.yaml
```

**境界:** desktopは業務ロジックを持たない。runnerはTauri非依存。contractsは両者共有。各CLI Adapterの単体テストではCLIをmockし、live CLI実行は`RUN_LIVE_E2E=1`時のみ行う。

## 13. 実装順序（依存順に固定）

1. Monorepo、TypeScript、Zod、JSON Schema、SQLite migration、Vitest。
2. Run状態機械、完了ゲート、Process Runner、モックテスト。
3. Git worktreeとDocker Sandbox、preflight、ログ/レポート、CLI adapters。
4. Requirements Agent（repo inspector→gap analyzer→interview→revision→approve→YAML）。
5. IPC APIとTauri shell、Svelte 5の4画面。
6. UI⇔Runner接続、キャンセル/再起動時の復旧、履歴、エラー表示。
7. Unit/Integration/Playwright、Docker/WSL2実機E2E、配布パッケージ検証。

## 14. Definition of Done

- `tests/ACCEPTANCE.md` の必須テストがすべて緑。
- lint / typecheck / unit / integration / UI E2Eが成功。実CLI E2Eは**明示的なテスト用リポジトリ**で実施し、認証・通信ポリシーを確認。
- GUIからYAMLを手入力せずに質問→承認→実装→検証→レビュー→結果表示ができる。
- 承認前実行、未検証完了、無制限修正、勝手なpush/merge/deployが不可能。
- worktreeを除く元リポジトリのHEAD/ファイルが不変。
- 失敗時も理由、次の手動作業、ログ/差分が確認できる。
- インストール/環境セットアップ/セキュリティ制限/実運用上の残課題をREADMEで説明。
- 実装済み/未実装/実測済み/未実測を区別した最終レポートを生成。

## 15. エージェントへの実装指示

この仕様を唯一の要件ベースラインとして扱う。まずテスト可能な純粋モジュールを実装し、それから実CLIとGUIを結合する。未確認のCLIフラグやDockerネットワーク制御方式は推測で「実装済み」にしない。安全性が保証できなければfail-closedし、`docs/DECISIONS.md`に技術的な制約と対処案を記録する。UX上の推奨案はユーザーの合意なしに重要要件へ昇格しない。既存機能と矛盾する追加要件は本仕様に従いv2として実装する。
