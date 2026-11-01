# 受入テスト結果

生成: 2026-11-01T08:01:37.094Z

- Vitest: 200/201 passed
- Playwright: 13/17 passed
- 集計: PASS 56 / FAIL 0 / NOT_RUN 0

PASS = 対応する自動テストがすべて成功。FAIL = 1 件以上失敗。NOT_RUN = 対応テストの実行結果なし（LIVE は実機未実施）。

| ID | 分類 | シナリオ | 期待結果 | 結果 | 対応テスト |
|---|---|---|---|---|---|
| UI-01 | UI | 初回起動 | 4画面遷移・セットアップ案内 | **PASS** | 4 |
| UI-02 | UI | Gitフォルダ選択 | プロジェクト情報表示 | **PASS** | 3 |
| UI-03 | UI | 無効フォルダ選択 | 原因と修正案表示、Run不可 | **PASS** | 4 |
| UI-04 | UI | 日本語で依頼入力 | draftが作成される | **PASS** | 3 |
| UI-05 | UI | 3問以上の質問 | 最大3問ずつ表示 | **PASS** | 5 |
| UI-06 | UI | 質問を戻って修正 | 回答/サマリーが再評価 | **PASS** | 7 |
| UI-07 | UI | 承認前 | Run開始不可 | **PASS** | 7 |
| UI-08 | UI | 承認後 | YAML固定、Run画面へ | **PASS** | 3 |
| UI-09 | UI | 実行キャンセル | INTERRUPTED、詳細表示 | **PASS** | 3 |
| UI-10 | UI | キーボード操作 | 主要操作がマウスなしで可能 | **PASS** | 2 |
| RA-01 | Agent | repoに既存認証あり | 根拠つきfactsとして抽出 | **PASS** | 9 |
| RA-02 | Agent | 調査不能 | 未確認扱い、推測を事実にしない | **PASS** | 2 |
| RA-03 | Agent | 既存コードで自明 | 重複質問しない | **PASS** | 1 |
| RA-04 | Agent | 技術的な選択肢あり | 推奨案と根拠を表示 | **PASS** | 2 |
| RA-05 | Agent | blocking未回答 | 承認ボタン無効 | **PASS** | 2 |
| RA-06 | Agent | 回答→再評価 | 次の質問が更新される | **PASS** | 3 |
| RA-07 | Agent | 最大15問到達で未確定 | BLOCKED | **PASS** | 2 |
| RA-08 | Agent | AIが不正JSON | BLOCKED、UIに理由 | **PASS** | 2 |
| RA-09 | Agent | YAML出力 | schema検証成功 | **PASS** | 8 |
| RA-10 | Agent | 無効YAML | Run不可 | **PASS** | 13 |
| RA-11 | Agent | 承認後編集 | 新revision/再承認 | **PASS** | 2 |
| RA-12 | Agent | 未承認draft | Builder起動0回 | **PASS** | 5 |
| RA-13 | Agent | READMEが危険な指示を含む | 指示を実行せず無視 | **PASS** | 12 |
| RA-14 | Agent | 保護ファイルあり | 調査対象から除外 | **PASS** | 10 |
| RA-15 | Agent | 受入条件が曖昧 | 再質問またはBLOCKED | **PASS** | 3 |
| EX-01 | Engine | 実装+検証+レビュー成功 | COMPLETED | **PASS** | 3 |
| EX-02 | Engine | 検証失敗→修正成功 | Builder2回、Reviewer1回 | **PASS** | 1 |
| EX-03 | Engine | high指摘→修正→承認 | Builder2回、Reviewer2回 | **PASS** | 1 |
| EX-04 | Engine | 3回失敗 | NEEDS_HUMAN、MAX_ROUNDS | **PASS** | 1 |
| EX-05 | Engine | Reviewer unknown | NEEDS_HUMAN | **PASS** | 3 |
| EX-06 | Engine | Codex JSON不正 | NEEDS_HUMAN | **PASS** | 6 |
| EX-07 | Engine | approvedとhigh指摘の併存 | COMPLETED不可 | **PASS** | 5 |
| EX-08 | Engine | 検証タイムアウト | COMPLETED不可 | **PASS** | 3 |
| EX-09 | Engine | Builder非ゼロ終了 | COMPLETED不可 | **PASS** | 1 |
| EX-10 | Engine | 差分なし | COMPLETED不可 | **PASS** | 2 |
| EX-11 | Engine | 未追跡ファイルにバグ | レビュー対象に含む | **PASS** | 3 |
| EX-12 | Engine | SIGTERM | 子プロセス停止・INTERRUPTED | **PASS** | 9 |
| EX-13 | Engine | 並行Run開始 | 拒否 | **PASS** | 2 |
| SEC-01 | Security | Docker不可 | PRECHECK_FAILED | **PASS** | 2 |
| SEC-02 | Security | network egress制限不可 | PRECHECK_FAILED | **PASS** | 3 |
| SEC-03 | Security | Reviewer書込試行 | OSレベルで拒否 | **PASS** | 4 |
| SEC-04 | Security | worktree外へ書込 | 拒否 | **PASS** | 2 |
| SEC-05 | Security | 認証情報がstdoutに現れる | マスキング | **PASS** | 12 |
| SEC-06 | Security | shell metacharacterをタスクに含む | shell実行しない | **PASS** | 6 |
| SEC-07 | Security | 任意コマンドのYAML注入 | schema拒否 | **PASS** | 13 |
| SEC-08 | Security | 危険な権限フラグ入力 | 拒否 | **PASS** | 3 |
| SEC-09 | Security | symlinkで外部参照 | 拒否 | **PASS** | 10 |
| SEC-10 | Security | push/merge/deploy要求 | 拒否・手動対応案内 | **PASS** | 9 |
| AUD-01 | Audit | 生成したtask revision | SQLiteとYAMLに整合保存 | **PASS** | 2 |
| AUD-02 | Audit | 実行中のイベント | sequence順で永続化 | **PASS** | 2 |
| AUD-03 | Audit | アプリ異常終了後再起動 | 未完了RunはINTERRUPTED | **PASS** | 2 |
| AUD-04 | Audit | 検証失敗 | reportに理由と次の操作 | **PASS** | 2 |
| AUD-05 | Audit | UIログ再表示 | 再起動後にも確認可能 | **PASS** | 2 |

## LIVE（実 CLI / 実機）

| ID | シナリオ | 結果 | 備考 |
|---|---|---|---|
| LIVE-01 | 完全に隔離された小さなサンプルリポジトリで要件入力→ヒアリング→YAML承認→実装→検証→レビュー→結果表示を確認。 | **PASS** | 2026-11-01 tests/e2e/live-pipeline.test.ts（RUN_LIVE_E2E=1、headless）: 専用サンプルリポジトリで依頼→ヒアリング（Claude Code）→承認→実装（Claude Code）→検証（pnpm install/typecheck/lint/test:run 全 exit 0）→レビュー（Codex approved）→ COMPLETED、1 ラウンド、3 分 24 秒。GUI 経由（tauri dev + 実 Runner、Playwright を WebView2 に CDP 接続）でも依頼入力→ヒアリング→同意→承認→Run→結果（COMPLETED）まで 2.5 分で完走。複数ラウンド: CORS オリジン判定シナリオで Claude Code → Codex（high 指摘）→ Claude Code（修正）→ Codex → Claude Code → Codex の 3 ラウンドを実測。各ラウンドで差分が変化し、ハッシュ一致・検証 PASS、上限到達で NEEDS_HUMAN / MAX_ROUNDS（自動承認なし）。 ／ v2.2（2026-11-01）再実行: 同テストを headless で再実行し PASS（COMPLETED、1 ラウンド、157 s、Builder 17.6 s、install/typecheck/lint/test:run すべて exit 0）。 |
| LIVE-02 | 元リポジトリのHEAD/作業ツリー不変、リモートに副作用なし。 | **PASS** | 各 LIVE 実行で元リポジトリの HEAD と作業ツリーが不変、ワークスペースに remote が無いことを assert。egress プロキシのログで allowlist 外（oaiusercontent.com, ab.chatgpt.com, example.com）は 403。 ／ v2.2: 隔離・egress の実 Docker テスト 7 件（CI=1 RUN_DOCKER_TESTS=1）を再実行し PASS。GUI 経由の再実測は未実施（前回結果のまま）。 |
| LIVE-03 | Windows配布物がNodeの追加インストールなしでUI起動できる。WSL2/Docker/CLIが不足すると明示的に利用不可になる。 | **PASS** | NSIS インストーラ（Agent Orchestrator_0.1.0_x64-setup.exe、24 MB）を tauri build で作成。/S で一時ディレクトリにサイレントインストール → agent-orchestrator-desktop.exe（4.3 MB）+ 同梱サイドカー agent-orchestrator-runner.exe（Node SEA、91 MB）+ uninstall.exe。Node を PATH から外した環境（env -i）で起動し、同梱サイドカーが ready → GUI の environment.check / project.inspect が成功。サンドボックスイメージが無い構成では「✖ 実行不可：セットアップが必要です」と修正方法が表示され開始ボタンが無効。uninstall.exe /S で残存ファイル・レジストリ 0。コード署名は署名鍵が無いため未実施（docs/RELEASE.md に手順）。 ／ v2.2: インストーラは再ビルド・再実測していない（前回結果のまま。サイドカー / Rust に変更なし、cargo check のみ）。 |

## 対応テスト詳細

### UI-01 — PASS
- ✓ ui-01-04.spec.ts > UI-01 初回起動 > UI-01: 4画面のナビゲーションが表示され、環境NGのときはセットアップ案内と修正方法を表示し開始できない
- ✓ ui-01-04.spec.ts > UI-01 初回起動 > UI-01: 4画面のナビゲーションが表示され、環境NGのときはセットアップ案内と修正方法を表示し開始できない
- ✓ ui-01-04.spec.ts > UI-01 初回起動 > UI-01: 環境OKのとき実行可能と表示され、依頼内容が空なら開始できない
- ✓ ui-01-04.spec.ts > UI-01 初回起動 > UI-01: 環境OKのとき実行可能と表示され、依頼内容が空なら開始できない

### UI-02 — PASS
- ✓ ui-01-04.spec.ts > UI-02 / UI-03 フォルダ選択 > UI-02: Git フォルダを選択するとプロジェクト情報が表示される
- ✓ ui-01-04.spec.ts > UI-02 / UI-03 フォルダ選択 > UI-02: Git フォルダを選択するとプロジェクト情報が表示される
- ✓ ui-01-04.spec.ts > UI-02 / UI-03 フォルダ選択 > UI-03: 無効なフォルダでは原因と修正案が表示され、開始できない

### UI-03 — PASS
- ✓ RepoInspector (RA-01 / RA-13 / RA-14 / SEC-09) > UI-03 / RA-13: non-git folder and missing folder are unusable with fixe
- ✓ ui-01-04.spec.ts > UI-02 / UI-03 フォルダ選択 > UI-02: Git フォルダを選択するとプロジェクト情報が表示される
- ✓ ui-01-04.spec.ts > UI-02 / UI-03 フォルダ選択 > UI-03: 無効なフォルダでは原因と修正案が表示され、開始できない
- ✓ ui-01-04.spec.ts > UI-02 / UI-03 フォルダ選択 > UI-03: 無効なフォルダでは原因と修正案が表示され、開始できない

### UI-04 — PASS
- ✓ DraftService conversation state machine (SPEC §5) > UI-04 / UI-05 / RA-04: creating a draft inspects the repo and asks a
- ✓ ui-01-04.spec.ts > UI-04 依頼入力 > UI-04: 日本語で依頼を入力して開始すると draft が作成されヒアリング画面へ遷移する
- ✓ ui-01-04.spec.ts > UI-04 依頼入力 > UI-04: 日本語で依頼を入力して開始すると draft が作成されヒアリング画面へ遷移する

### UI-05 — PASS
- ✓ contracts: interview schema caps > rejects more than 3 questions per round [UI-05]
- ✓ DraftService conversation state machine (SPEC §5) > UI-04 / UI-05 / RA-04: creating a draft inspects the repo and asks a
- ✓ gap analyzer (SPEC §4.1) > RA-04 / UI-05: at most 3 questions, blocking first, then those with options
- ✓ ui-05-07.spec.ts > UI-05 質問の表示 > UI-05: 4問以上の質問が最大3問ずつ複数ラウンドで表示される
- ✓ ui-05-07.spec.ts > UI-05 質問の表示 > UI-05: 4問以上の質問が最大3問ずつ複数ラウンドで表示される

### UI-06 — PASS
- ✓ DraftService conversation state machine (SPEC §5) > skipping a blocking question → BLOCKED; back re-asks the round [RA-0
- ✓ DraftService conversation state machine (SPEC §5) > UI-06: going back from the summary re-evaluates with the new answer
- ✓ SQLite repository > records questions and answers with back (retract) support [RA-06][UI-06]
- ✓ ui-05-07.spec.ts > UI-06 戻って修正 > UI-06: 戻るで前のラウンドに戻り回答を変えるとサマリーが再評価される
- ✓ ui-05-07.spec.ts > UI-06 戻って修正 > UI-06: 戻るで前のラウンドに戻り回答を変えるとサマリーが再評価される
- ✓ ui-05-07.spec.ts > UI-06 戻って修正 > UI-06: 要件サマリーを修正すると新しいリビジョンになり承認がリセットされる
- ✓ ui-05-07.spec.ts > UI-06 戻って修正 > UI-06: 要件サマリーを修正すると新しいリビジョンになり承認がリセットされる

### UI-07 — PASS
- ✓ DraftService conversation state machine (SPEC §5) > RA-05 / UI-07: approval is refused while blocking questions are unan
- ✓ RunEngine state machine (SPEC §6) > RA-12 / UI-07: unapproved snapshot never invokes the Builder
- ✓ completion gate (SPEC §6.1) > fails when task is not approved [RA-12][UI-07]
- ✓ ui-05-07.spec.ts > UI-07 承認前 > UI-07: 同意前は承認ボタンが無効で、Run は開始されない
- ✓ ui-05-07.spec.ts > UI-07 承認前 > UI-07: 同意前は承認ボタンが無効で、Run は開始されない
- ✓ ui-05-07.spec.ts > UI-07 承認前 > UI-07: blocking 質問をスキップすると BLOCKED になり承認できない（理由をテキスト表示）
- ✓ ui-05-07.spec.ts > UI-07 承認前 > UI-07: blocking 質問をスキップすると BLOCKED になり承認できない（理由をテキスト表示）

### UI-08 — PASS
- ✓ DraftService conversation state machine (SPEC §5) > RA-06 / RA-09 / UI-08: answering re-evaluates, then summary + valida
- ✓ ui-08-10.spec.ts > UI-08 承認後 > UI-08: 承認すると task.yaml が固定され Run 画面へ遷移し、実行が COMPLETED まで進む
- ✓ ui-08-10.spec.ts > UI-08 承認後 > UI-08: 承認すると task.yaml が固定され Run 画面へ遷移し、実行が COMPLETED まで進む

### UI-09 — PASS
- ✓ RunService > EX-12 / UI-09: cancel aborts the run → INTERRUPTED with details persisted
- ✓ ui-08-10.spec.ts > UI-09 実行キャンセル > UI-09: 実行中にキャンセルすると INTERRUPTED となり詳細が表示される
- ✓ ui-08-10.spec.ts > UI-09 実行キャンセル > UI-09: 実行中にキャンセルすると INTERRUPTED となり詳細が表示される

### UI-10 — PASS
- ✓ ui-08-10.spec.ts > UI-10 キーボード操作 > UI-10: マウスなしで主要操作（選択→依頼→回答→承認→キャンセル）ができ、フォーカスが見える
- ✓ ui-08-10.spec.ts > UI-10 キーボード操作 > UI-10: マウスなしで主要操作（選択→依頼→回答→承認→キャンセル）ができ、フォーカスが見える

### RA-01 — PASS
- ✓ RepoInspector (RA-01 / RA-13 / RA-14 / SEC-09) > RA-01: extracts facts with sources; existing auth is detected as confir
- ✓ RepoInspector (RA-01 / RA-13 / RA-14 / SEC-09) > RA-01: extracts facts with sources; existing auth is detected as confir
- ✓ RepoInspector (RA-01 / RA-13 / RA-14 / SEC-09) > v2.1: lint rules and TypeScript strictness are extracted as facts for c
- ✓ RepoInspector (RA-01 / RA-13 / RA-14 / SEC-09) > RA-02: unknowns are reported as unknown, not as facts
- ✓ RepoInspector (RA-01 / RA-13 / RA-14 / SEC-09) > RA-14: protected files (.env, *.key) and node_modules are excluded from
- ✓ RepoInspector (RA-01 / RA-13 / RA-14 / SEC-09) > RA-13: README instructions are included only as untrusted data
- ✓ RepoInspector (RA-01 / RA-13 / RA-14 / SEC-09) > SEC-09: symlinks are not followed
- ✓ RepoInspector (RA-01 / RA-13 / RA-14 / SEC-09) > UI-03 / RA-13: non-git folder and missing folder are unusable with fixe
- ✓ RepoInspector (RA-01 / RA-13 / RA-14 / SEC-09) > RA-13: too many files → blocked and returned to the human

### RA-02 — PASS
- ✓ RepoInspector (RA-01 / RA-13 / RA-14 / SEC-09) > RA-02: unknowns are reported as unknown, not as facts
- ✓ gap analyzer (SPEC §4.1) > RA-02: model facts without evidence are downgraded to inferred; inspector facts win

### RA-03 — PASS
- ✓ gap analyzer (SPEC §4.1) > RA-03: questions already asked (by id or text) are not asked again

### RA-04 — PASS
- ✓ DraftService conversation state machine (SPEC §5) > UI-04 / UI-05 / RA-04: creating a draft inspects the repo and asks a
- ✓ gap analyzer (SPEC §4.1) > RA-04 / UI-05: at most 3 questions, blocking first, then those with options

### RA-05 — PASS
- ✓ DraftService conversation state machine (SPEC §5) > RA-05 / UI-07: approval is refused while blocking questions are unan
- ✓ gap analyzer (SPEC §4.1) > RA-05: a skipped blocking question keeps the draft from reaching summary

### RA-06 — PASS
- ✓ DraftService conversation state machine (SPEC §5) > RA-06 / RA-09 / UI-08: answering re-evaluates, then summary + valida
- ✓ DraftService conversation state machine (SPEC §5) > skipping a blocking question → BLOCKED; back re-asks the round [RA-0
- ✓ SQLite repository > records questions and answers with back (retract) support [RA-06][UI-06]

### RA-07 — PASS
- ✓ DraftService conversation state machine (SPEC §5) > RA-07: fifth round with blocking left → BLOCKED
- ✓ gap analyzer (SPEC §4.1) > RA-07: cap reached (15 questions) with blocking left → blocked, no auto-approval

### RA-08 — PASS
- ✓ DraftService conversation state machine (SPEC §5) > RA-08: invalid model JSON → BLOCKED with reason shown; model failure
- ✓ gap analyzer (SPEC §4.1) > RA-08 / RA-15: invalid model JSON is rejected, never auto-fixed

### RA-09 — PASS
- ✓ contracts: examples validate with Zod and JSON Schema > examples/task.yaml is a valid Approved Task v2 [RA-09]
- ✓ DraftService conversation state machine (SPEC §5) > RA-06 / RA-09 / UI-08: answering re-evaluates, then summary + valida
- ✓ gap analyzer (SPEC §4.1) > RA-09: no questions and no blocking → summary ready
- ✓ task generator (RA-09 / RA-10 / SEC-07 / SEC-10) > generates a valid Approved Task v2 YAML with fixed limits and profile
- ✓ task generator (RA-09 / RA-10 / SEC-07 / SEC-10) > keeps the task id stable when provided (revisions share an id)
- ✓ task generator (RA-09 / RA-10 / SEC-07 / SEC-10) > SEC-10: rejects requirements that demand push/merge/deploy with manua
- ✓ task generator (RA-09 / RA-10 / SEC-07 / SEC-10) > RA-10 / SEC-07: invalid YAML (unknown profile, injected command field
- ✓ task generator (RA-09 / RA-10 / SEC-07 / SEC-10) > task ids are ascii-safe

### RA-10 — PASS
- ✓ contracts: task schema rejects unsafe or incomplete input [RA-10][SEC-07] > rejects empty requirements
- ✓ contracts: task schema rejects unsafe or incomplete input [RA-10][SEC-07] > rejects empty acceptanceCriteria
- ✓ contracts: task schema rejects unsafe or incomplete input [RA-10][SEC-07] > rejects unknown verification profiles and ar
- ✓ contracts: task schema rejects unsafe or incomplete input [RA-10][SEC-07] > rejects maxImplementationAttempts above 3 (n
- ✓ contracts: task schema rejects unsafe or incomplete input [RA-10][SEC-07] > rejects wrong schemaVersion
- ✓ contracts: task schema rejects unsafe or incomplete input [RA-10][SEC-07] > applies defaults for limits and review when 
- ✓ DraftService conversation state machine (SPEC §5) > RA-10: unmet verification profile blocks approval with the missing s
- ✓ task generator (RA-09 / RA-10 / SEC-07 / SEC-10) > generates a valid Approved Task v2 YAML with fixed limits and profile
- ✓ task generator (RA-09 / RA-10 / SEC-07 / SEC-10) > keeps the task id stable when provided (revisions share an id)
- ✓ task generator (RA-09 / RA-10 / SEC-07 / SEC-10) > SEC-10: rejects requirements that demand push/merge/deploy with manua
- ✓ task generator (RA-09 / RA-10 / SEC-07 / SEC-10) > RA-10 / SEC-07: invalid YAML (unknown profile, injected command field
- ✓ task generator (RA-09 / RA-10 / SEC-07 / SEC-10) > RA-10 / SEC-07: invalid YAML (unknown profile, injected command field
- ✓ task generator (RA-09 / RA-10 / SEC-07 / SEC-10) > task ids are ascii-safe

### RA-11 — PASS
- ✓ DraftService conversation state machine (SPEC §5) > AUD-01 / RA-11 / RA-12: approve writes immutable YAML; revise afterw
- ✓ SQLite repository > AUD-01: draft revisions and approved task are stored consistently; approved revision is immutable [R

### RA-12 — PASS
- ✓ DraftService conversation state machine (SPEC §5) > AUD-01 / RA-11 / RA-12: approve writes immutable YAML; revise afterw
- ✓ DraftService conversation state machine (SPEC §5) > RA-12: the draft phase never has a Builder — the model is the only e
- ✓ RunService > refuses unknown / unapproved task ids [RA-12]
- ✓ RunEngine state machine (SPEC §6) > RA-12 / UI-07: unapproved snapshot never invokes the Builder
- ✓ completion gate (SPEC §6.1) > fails when task is not approved [RA-12][UI-07]

### RA-13 — PASS
- ✓ DraftService conversation state machine (SPEC §5) > RA-13: dangerous README instructions are never executed (no executio
- ✓ RepoInspector (RA-01 / RA-13 / RA-14 / SEC-09) > RA-01: extracts facts with sources; existing auth is detected as confir
- ✓ RepoInspector (RA-01 / RA-13 / RA-14 / SEC-09) > v2.1: lint rules and TypeScript strictness are extracted as facts for c
- ✓ RepoInspector (RA-01 / RA-13 / RA-14 / SEC-09) > RA-02: unknowns are reported as unknown, not as facts
- ✓ RepoInspector (RA-01 / RA-13 / RA-14 / SEC-09) > RA-14: protected files (.env, *.key) and node_modules are excluded from
- ✓ RepoInspector (RA-01 / RA-13 / RA-14 / SEC-09) > RA-13: README instructions are included only as untrusted data
- ✓ RepoInspector (RA-01 / RA-13 / RA-14 / SEC-09) > RA-13: README instructions are included only as untrusted data
- ✓ RepoInspector (RA-01 / RA-13 / RA-14 / SEC-09) > SEC-09: symlinks are not followed
- ✓ RepoInspector (RA-01 / RA-13 / RA-14 / SEC-09) > UI-03 / RA-13: non-git folder and missing folder are unusable with fixe
- ✓ RepoInspector (RA-01 / RA-13 / RA-14 / SEC-09) > UI-03 / RA-13: non-git folder and missing folder are unusable with fixe
- ✓ RepoInspector (RA-01 / RA-13 / RA-14 / SEC-09) > RA-13: too many files → blocked and returned to the human
- ✓ RepoInspector (RA-01 / RA-13 / RA-14 / SEC-09) > RA-13: too many files → blocked and returned to the human

### RA-14 — PASS
- ✓ RepoInspector (RA-01 / RA-13 / RA-14 / SEC-09) > RA-01: extracts facts with sources; existing auth is detected as confir
- ✓ RepoInspector (RA-01 / RA-13 / RA-14 / SEC-09) > v2.1: lint rules and TypeScript strictness are extracted as facts for c
- ✓ RepoInspector (RA-01 / RA-13 / RA-14 / SEC-09) > RA-02: unknowns are reported as unknown, not as facts
- ✓ RepoInspector (RA-01 / RA-13 / RA-14 / SEC-09) > RA-14: protected files (.env, *.key) and node_modules are excluded from
- ✓ RepoInspector (RA-01 / RA-13 / RA-14 / SEC-09) > RA-14: protected files (.env, *.key) and node_modules are excluded from
- ✓ RepoInspector (RA-01 / RA-13 / RA-14 / SEC-09) > RA-13: README instructions are included only as untrusted data
- ✓ RepoInspector (RA-01 / RA-13 / RA-14 / SEC-09) > SEC-09: symlinks are not followed
- ✓ RepoInspector (RA-01 / RA-13 / RA-14 / SEC-09) > UI-03 / RA-13: non-git folder and missing folder are unusable with fixe
- ✓ RepoInspector (RA-01 / RA-13 / RA-14 / SEC-09) > RA-13: too many files → blocked and returned to the human
- ✓ gap analyzer (SPEC §4.1) > RA-14: prompt wraps repository content as untrusted and includes verbatim request

### RA-15 — PASS
- ✓ DraftService conversation state machine (SPEC §5) > v2.1 contradiction detection (cases 9 / 10) > invalid or failed cont
- ✓ gap analyzer (SPEC §4.1) > RA-08 / RA-15: invalid model JSON is rejected, never auto-fixed
- ✓ gap analyzer (SPEC §4.1) > RA-15: vague acceptance criteria (missing then) are rejected

### EX-01 — PASS
- ✓ RunService > runs an approved task to COMPLETED, writes report.md, and exposes status/events/report [EX-01][AUD-04][AUD-
- ✓ RunEngine state machine (SPEC §6) > EX-01: implement + verify + review success → COMPLETED
- ✓ completion gate (SPEC §6.1) > passes when all seven gates hold [EX-01]

### EX-02 — PASS
- ✓ RunEngine state machine (SPEC §6) > EX-02: verification fails then fix succeeds → Builder 2, Reviewer 1

### EX-03 — PASS
- ✓ RunEngine state machine (SPEC §6) > EX-03: high finding → fix → approved → Builder 2, Reviewer 2

### EX-04 — PASS
- ✓ RunEngine state machine (SPEC §6) > EX-04: three failures → NEEDS_HUMAN / MAX_ROUNDS

### EX-05 — PASS
- ✓ Codex Reviewer adapter > maps timeout / non-zero exit to parsed=null (unknown, no auto-repair) [EX-05]
- ✓ RunEngine state machine (SPEC §6) > EX-05: reviewer unknown → NEEDS_HUMAN
- ✓ completion gate (SPEC §6.1) > fails on invalid review JSON and on unknown verdict [EX-05][EX-06]

### EX-06 — PASS
- ✓ contracts: review schema and consistency [EX-06][EX-07] > rejects malformed review JSON (missing fields, bad severity)
- ✓ contracts: review schema and consistency [EX-06][EX-07] > flags approved verdict with blocking findings as inconsistent
- ✓ contracts: review schema and consistency [EX-06][EX-07] > flags approved verdict with unverified requirements
- ✓ Codex Reviewer adapter > parses valid review JSON (plain or fenced) and rejects invalid [EX-06]
- ✓ RunEngine state machine (SPEC §6) > EX-06: invalid review JSON → NEEDS_HUMAN (no auto-repair)
- ✓ completion gate (SPEC §6.1) > fails on invalid review JSON and on unknown verdict [EX-05][EX-06]

### EX-07 — PASS
- ✓ contracts: review schema and consistency [EX-06][EX-07] > rejects malformed review JSON (missing fields, bad severity)
- ✓ contracts: review schema and consistency [EX-06][EX-07] > flags approved verdict with blocking findings as inconsistent
- ✓ contracts: review schema and consistency [EX-06][EX-07] > flags approved verdict with unverified requirements
- ✓ RunEngine state machine (SPEC §6) > EX-07: approved with high finding → not COMPLETED
- ✓ completion gate (SPEC §6.1) > fails when approved coexists with high finding [EX-07]

### EX-08 — PASS
- ✓ RunEngine state machine (SPEC §6) > EX-08: verification timeout → not COMPLETED, reviewer not called that round
- ✓ completion gate (SPEC §6.1) > fails on verification timeout [EX-08]
- ✓ SandboxVerifier > EX-08: records timeouts as timedOut with null exit code

### EX-09 — PASS
- ✓ RunEngine state machine (SPEC §6) > EX-09: builder non-zero exit → NEEDS_HUMAN / BUILDER_FAILED

### EX-10 — PASS
- ✓ RunEngine state machine (SPEC §6) > EX-10: no diff → NEEDS_HUMAN / NO_CHANGES
- ✓ completion gate (SPEC §6.1) > fails with no diff [EX-10]

### EX-11 — PASS
- ✓ WorkspaceManager (git) > captures diff including untracked files and ignores node_modules [EX-11]
- ✓ Codex Reviewer adapter > includes untracked files in the prompt [EX-11]
- ✓ RunEngine state machine (SPEC §6) > EX-11: untracked files are part of the diff passed to the reviewer

### EX-12 — PASS
- ✓ Docker sandbox (live docker) > EX-12: timeout kills the container
- ✓ process runner (SEC-06 / SEC-05 / EX-12) > passes shell metacharacters literally (shell:false)
- ✓ process runner (SEC-06 / SEC-05 / EX-12) > refuses commands outside the allowlist
- ✓ process runner (SEC-06 / SEC-05 / EX-12) > kills the process tree on timeout and reports timedOut
- ✓ process runner (SEC-06 / SEC-05 / EX-12) > aborts via AbortSignal
- ✓ process runner (SEC-06 / SEC-05 / EX-12) > masks secrets and truncates oversized output
- ✓ process runner (SEC-06 / SEC-05 / EX-12) > does not leak the parent environment unless inheritEnv is set
- ✓ RunService > EX-12 / UI-09: cancel aborts the run → INTERRUPTED with details persisted
- ✓ RunEngine state machine (SPEC §6) > EX-12: cancellation during builder → INTERRUPTED

### EX-13 — PASS
- ✓ RunService > EX-13: a second run while one is active is refused
- ✓ RunEngine state machine (SPEC §6) > EX-13: another active run → refused

### SEC-01 — PASS
- ✓ RunEngine state machine (SPEC §6) > SEC-01/SEC-02: preflight failure → PRECHECK_FAILED, no builder
- ✓ preflight (SPEC §9) > SEC-01: Docker unavailable → not ok, isolation probe not attempted

### SEC-02 — PASS
- ✓ Docker sandbox (live docker) > SEC-02: probe confirms direct egress blocked, allowlist enforced, read-only volume and no
- ✓ RunEngine state machine (SPEC §6) > SEC-01/SEC-02: preflight failure → PRECHECK_FAILED, no builder
- ✓ preflight (SPEC §9) > SEC-02: egress cannot be restricted → not ok

### SEC-03 — PASS
- ✓ Docker sandbox (live docker) > SEC-03 / SEC-04: writes to a read-only workspace and outside the workspace are refused; -
- ✓ Codex Reviewer adapter > mounts the workspace read-only, injects the schema and auth via aux, and reads the output back 
- ✓ RunEngine state machine (SPEC §6) > SEC-03: workspace hash mismatch across review → NEEDS_HUMAN
- ✓ completion gate (SPEC §6.1) > fails when workspace hash changed during review [SEC-03]

### SEC-04 — PASS
- ✓ Docker sandbox (live docker) > SEC-03 / SEC-04: writes to a read-only workspace and outside the workspace are refused; -
- ✓ diff policy (security checks; quality checks live in policy-gate.test.ts since v2.1) > fails on forbidden paths and path

### SEC-05 — PASS
- ✓ process runner (SEC-06 / SEC-05 / EX-12) > passes shell metacharacters literally (shell:false)
- ✓ process runner (SEC-06 / SEC-05 / EX-12) > refuses commands outside the allowlist
- ✓ process runner (SEC-06 / SEC-05 / EX-12) > kills the process tree on timeout and reports timedOut
- ✓ process runner (SEC-06 / SEC-05 / EX-12) > aborts via AbortSignal
- ✓ process runner (SEC-06 / SEC-05 / EX-12) > masks secrets and truncates oversized output
- ✓ process runner (SEC-06 / SEC-05 / EX-12) > does not leak the parent environment unless inheritEnv is set
- ✓ credential hygiene across all run artifacts [SEC-05] > a token that leaks into builder output, review text and egress er
- ✓ Claude Builder adapter > runs inside the sandbox with rw workspace, egress network and injected credentials masked [SEC-
- ✓ masking [SEC-05] > masks known key formats and env assignments
- ✓ masking [SEC-05] > masks explicitly provided secrets and JSON tokens
- ✓ masking [SEC-05] > truncates with marker
- ✓ FileAndDbRecorder > writes the run directory layout and masks secrets in artifacts [SEC-05][AUD-05]

### SEC-06 — PASS
- ✓ process runner (SEC-06 / SEC-05 / EX-12) > passes shell metacharacters literally (shell:false)
- ✓ process runner (SEC-06 / SEC-05 / EX-12) > refuses commands outside the allowlist
- ✓ process runner (SEC-06 / SEC-05 / EX-12) > kills the process tree on timeout and reports timedOut
- ✓ process runner (SEC-06 / SEC-05 / EX-12) > aborts via AbortSignal
- ✓ process runner (SEC-06 / SEC-05 / EX-12) > masks secrets and truncates oversized output
- ✓ process runner (SEC-06 / SEC-05 / EX-12) > does not leak the parent environment unless inheritEnv is set

### SEC-07 — PASS
- ✓ contracts: task schema rejects unsafe or incomplete input [RA-10][SEC-07] > rejects empty requirements
- ✓ contracts: task schema rejects unsafe or incomplete input [RA-10][SEC-07] > rejects empty acceptanceCriteria
- ✓ contracts: task schema rejects unsafe or incomplete input [RA-10][SEC-07] > rejects unknown verification profiles and ar
- ✓ contracts: task schema rejects unsafe or incomplete input [RA-10][SEC-07] > rejects maxImplementationAttempts above 3 (n
- ✓ contracts: task schema rejects unsafe or incomplete input [RA-10][SEC-07] > rejects wrong schemaVersion
- ✓ contracts: task schema rejects unsafe or incomplete input [RA-10][SEC-07] > applies defaults for limits and review when 
- ✓ task generator (RA-09 / RA-10 / SEC-07 / SEC-10) > generates a valid Approved Task v2 YAML with fixed limits and profile
- ✓ task generator (RA-09 / RA-10 / SEC-07 / SEC-10) > keeps the task id stable when provided (revisions share an id)
- ✓ task generator (RA-09 / RA-10 / SEC-07 / SEC-10) > SEC-10: rejects requirements that demand push/merge/deploy with manua
- ✓ task generator (RA-09 / RA-10 / SEC-07 / SEC-10) > RA-10 / SEC-07: invalid YAML (unknown profile, injected command field
- ✓ task generator (RA-09 / RA-10 / SEC-07 / SEC-10) > RA-10 / SEC-07: invalid YAML (unknown profile, injected command field
- ✓ task generator (RA-09 / RA-10 / SEC-07 / SEC-10) > task ids are ascii-safe
- ✓ verification profile readiness (SPEC §7) > only exposes predefined commands (no shell from YAML) [SEC-07]

### SEC-08 — PASS
- ✓ Claude Builder adapter > builds a non-interactive argv without dangerous flags [SEC-08]
- ✓ Codex Reviewer adapter > uses read-only sandbox and output schema; no dangerous flags [SEC-08]
- ✓ forbidden CLI flags [SEC-08] > rejects dangerous permission flags

### SEC-09 — PASS
- ✓ RepoInspector (RA-01 / RA-13 / RA-14 / SEC-09) > RA-01: extracts facts with sources; existing auth is detected as confir
- ✓ RepoInspector (RA-01 / RA-13 / RA-14 / SEC-09) > v2.1: lint rules and TypeScript strictness are extracted as facts for c
- ✓ RepoInspector (RA-01 / RA-13 / RA-14 / SEC-09) > RA-02: unknowns are reported as unknown, not as facts
- ✓ RepoInspector (RA-01 / RA-13 / RA-14 / SEC-09) > RA-14: protected files (.env, *.key) and node_modules are excluded from
- ✓ RepoInspector (RA-01 / RA-13 / RA-14 / SEC-09) > RA-13: README instructions are included only as untrusted data
- ✓ RepoInspector (RA-01 / RA-13 / RA-14 / SEC-09) > SEC-09: symlinks are not followed
- ✓ RepoInspector (RA-01 / RA-13 / RA-14 / SEC-09) > SEC-09: symlinks are not followed
- ✓ RepoInspector (RA-01 / RA-13 / RA-14 / SEC-09) > UI-03 / RA-13: non-git folder and missing folder are unusable with fixe
- ✓ RepoInspector (RA-01 / RA-13 / RA-14 / SEC-09) > RA-13: too many files → blocked and returned to the human
- ✓ diff policy (security checks; quality checks live in policy-gate.test.ts since v2.1) > fails on forbidden paths and path

### SEC-10 — PASS
- ✓ DraftService conversation state machine (SPEC §5) > SEC-10: requests that demand push/merge/deploy are flagged and such 
- ✓ prohibited operations [SEC-10] > detects push/merge/deploy requests and provides manual guidance
- ✓ prohibited operations [SEC-10] > does not flag ordinary requests
- ✓ task generator (RA-09 / RA-10 / SEC-07 / SEC-10) > generates a valid Approved Task v2 YAML with fixed limits and profile
- ✓ task generator (RA-09 / RA-10 / SEC-07 / SEC-10) > keeps the task id stable when provided (revisions share an id)
- ✓ task generator (RA-09 / RA-10 / SEC-07 / SEC-10) > SEC-10: rejects requirements that demand push/merge/deploy with manua
- ✓ task generator (RA-09 / RA-10 / SEC-07 / SEC-10) > SEC-10: rejects requirements that demand push/merge/deploy with manua
- ✓ task generator (RA-09 / RA-10 / SEC-07 / SEC-10) > RA-10 / SEC-07: invalid YAML (unknown profile, injected command field
- ✓ task generator (RA-09 / RA-10 / SEC-07 / SEC-10) > task ids are ascii-safe

### AUD-01 — PASS
- ✓ DraftService conversation state machine (SPEC §5) > AUD-01 / RA-11 / RA-12: approve writes immutable YAML; revise afterw
- ✓ SQLite repository > AUD-01: draft revisions and approved task are stored consistently; approved revision is immutable [R

### AUD-02 — PASS
- ✓ RunEngine state machine (SPEC §6) > AUD-02: events are persisted with strictly increasing sequence and final status pers
- ✓ SQLite repository > AUD-02: events get strictly increasing sequence numbers and can be fetched since a sequence

### AUD-03 — PASS
- ✓ RunService > AUD-03: runs left in progress are marked INTERRUPTED on restart, never auto-resumed
- ✓ SQLite repository > lists active runs for restart recovery [AUD-03]

### AUD-04 — PASS
- ✓ RunService > runs an approved task to COMPLETED, writes report.md, and exposes status/events/report [EX-01][AUD-04][AUD-
- ✓ RunService > AUD-04: a failed run has a report with reason and next actions, and open findings in the report result

### AUD-05 — PASS
- ✓ RunService > runs an approved task to COMPLETED, writes report.md, and exposes status/events/report [EX-01][AUD-04][AUD-
- ✓ FileAndDbRecorder > writes the run directory layout and masks secrets in artifacts [SEC-05][AUD-05]
