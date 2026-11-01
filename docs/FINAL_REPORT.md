# 最終レポート（実装済み / 未実装 / 実測済み / 未実測）

作成日: 2026-11-01（リリース準備フェーズ後に更新）　対象: `docs/SPEC.md` v2.0　受入結果: `docs/ACCEPTANCE_REPORT.md`（**PASS 56 / FAIL 0 / NOT_RUN 0**）

## 0⁶. v0.1.0 公開準備の最終改善（2026-11-01 追記）

- **初回セットアップを GUI に統合（D-36）:** セットアップチェックでサンドボックスイメージが無い / マニフェストと不一致なら「サンドボックスを準備する」パネルを表示。ユーザーの同意（チェック）後に、ピン留めしたベースイメージ（`docker/manifest.json` のタグ@ダイジェスト）の取得 → ダイジェスト検証 → 埋め込みコンテキストからの 2 イメージのビルド（ラベル付与）→ ラベル検証を固定手順で実行し、進捗・失敗の原因と復旧方法・キャンセル・再試行を表示。検証に失敗したイメージは削除して使わない。セットアップチェックも毎回ラベルを照合。任意コマンド実行は追加せず、Docker 隔離・seccomp・egress 制御は変更なし。
- **成果物の確認（D-37）:** 結果画面に「作業用コピーのフォルダーを開く」（worktrees 配下に限定、シェル不使用）。変更ファイル・差分・未反映の明示は v2.3 のまま。自動反映は実装しない。
- **配布検証:** 配布ビルド（SHA-256 `D2DF25C5…953E`）を、ローカルイメージをすべて削除した状態・空の app-data・Node / pnpm なしの PATH で起動し、GUI だけで準備（39 秒）→ 実タスク COMPLETED（3.1 分、$0.12）→ アンインストール（残存 0、Docker コンテナ / ボリューム / ネットワーク 0）を実測。操作数は約 17〜22（CLI 0）。クリーンな別 PC / VM は未使用。詳細 `docs/RC_VERIFICATION.md`。
- 自動テスト: Vitest 208 passed / 1 skipped（LIVE 用ファイル、実 Docker 7 件含む）、Playwright 26 passed、svelte-check / tsc / cargo check / eslint クリーン。

## 0⁵. リリース候補（RC）検証の結果（2026-11-01 追記）

詳細は `docs/RC_VERIFICATION.md`。v2.3（`be0595d`）を未署名 RC として固定し、NSIS インストーラを再ビルド → サイレントインストール → 最小 PATH（Node / Git / Docker なし）での起動と初回環境チェック → Node 非搭載 PATH での GUI 全フロー（COMPLETED、2.5 分）→ 無効フォルダーのエラー表示 → 停止 → 再起動後の履歴復元 → アンインストール（残存 0）を実測した。

- **見つけた不具合（修正済み）:** 起動前検査（Docker 隔離プローブ）中に停止すると `PRECHECK_FAILED` として記録され「環境を直して」と案内されていた。エンジンで preflight 後にキャンセルを評価し `INTERRUPTED / CANCELLED` にする（回帰テスト追加）。再ビルドした配布物で GUI から再確認。
- **配布上の制限:** 未署名（一般公開版と区別）、サンドボックスイメージは配布物に含まれない（`pnpm sandbox:build` が必要）、クリーンな別 PC / VM での検証は未実施。README「既知の制限」と `docs/RELEASE.md` §5 に明記。
- 自動テスト（順次実行）: Vitest 201 passed / 1 skipped（LIVE 用ファイル）、Playwright 22 passed、svelte-check / tsc / cargo check / eslint クリーン。

## 0⁗. v2.3 UX 改善・操作性強化の結果（2026-11-01 追記）

### 変更した画面

| 画面 | 変更 |
|---|---|
| 結果・履歴（`Result.svelte`） | 状態ごとの平易な見出しと説明（完了＝取り込みはまだ / 人の判断が必要 / 実行前の確認で停止＝AI 未実行 / 途中で停止 / エラー）。「何が起きたか・変更の状態・次にできること」を先頭に表示。未解決の指摘は原因・影響（完了を妨げるか）・次の操作を明示、未検証要件には「完了と見なさない」注意、途中の変更には注意文。操作は「変更内容を見る（差分展開）」「作業用コピーのパスをコピー」「新しい依頼を作る」のみで、反映（push / merge）ボタンは出さず手動である旨を明示。内部ステータス・理由コード・Run ID・パス・Runner の技術的手順・egress・report.md は「内部ステータス・技術情報」に折りたたみ |
| ヒアリング・承認（`Interview.svelte`、新規 `ApprovalOverview.svelte`） | 質問中は承認セクションを出さない。回答完了後は 要件サマリー（何を作るか / 機能要件 / 受入条件を文章で / 制約・やらないこと / 進め方 / 確認方法 / 推奨・未確定）→ 承認（最大ラウンド数・所要時間の目安・料金発生・データ送信の同意）→ 「要件を修正する」（編集フォーム、折りたたみ）→ 「AI の要件理解と判断の記録」（要件理解・意思決定ログ・YAML、折りたたみ）の順。未解消の矛盾は承認不可理由に表示。修正後は「再承認が必要」を表示し同意を取り直す |
| 実行中（`Running.svelte`、`outcome.ts`） | 「現在の処理」を日本語で常時表示（実行前の確認 / 実装中 / 修正中（フィードバック付き） / ポリシー違反の修正を依頼中 / 検証中 / レビュー中）。ステップは 要件分析（承認済み）→ 実行前の確認 → 実装・修正（ラウンド n）→ 検証 → レビュー → 完了。ラウンドと経過時間を表示し、終了時刻の予測は出さないことを明示。「実行を停止する」。終了時は見出し・原因・対応を表示。Run ID・パス・task.yaml は技術情報に折りたたみ。生ログは表示せず、イベント要約でも出力抜粋フィールドを伏せる（`summarizePayload`） |
| モック（`mock.ts`） | `mockRun=needs_human`（3 ラウンド changes_requested → MAX_ROUNDS）と `mockRun=precheck_failed`（ベースライン検証失敗）、終了 Run の sessionStorage 永続化（リロード後の履歴検証用） |

バックエンド（Runner の状態遷移・reasonCode・Policy Gate・Docker 隔離）は変更していない（D-35）。

### テスト結果

- Playwright 22 passed（既存 13 件を維持、locator の調整: 編集フォーム・task.yaml が折りたたみになった箇所。旧「ウォークスルー 4 件（スキップ）」は削除し、常時実行の `ui-11-14.spec.ts` 9 件に置き換え: COMPLETED / NEEDS_HUMAN / PRECHECK_FAILED の結果画面、承認画面の順序と再承認、進捗の「現在の処理」と修正ラウンド、停止、失敗時の原因表示、承認前後の画面遷移、リロード後の履歴）。
- Vitest 200 passed（実 Docker 7 件を含む、`CI=1 RUN_DOCKER_TESTS=1`）、tsc / svelte-check / cargo check / eslint クリーン。
- スクリーンショット: `.tmp/ux/v23-*.png`（結果 3 状態、承認、進捗）。

### 残課題

- 作業用コピーのフォルダーをアプリから開く操作（Tauri の shell/opener 権限が必要なため見送り）。
- 用語ツールチップ、Git リポジトリでない場合の GUI 向け手順、依頼例の提示、主要ボタンの固定表示、Run ID / レポートパスのコピー。
- 外部テスターによる評価は未実施。

## 0‴. v2.2 品質安定化・UX 検証の結果（2026-11-01 追記）

### Phase 1 Policy Gate の堅牢化 — 実装済み（D-31）

- 解析は TypeScript コンパイラ API（パーサ駆動のコメント範囲 / AST / JSONC パーサ）に限定し、**正規表現によるソース解析への置換は禁止**（D-31 に明記）。
- 回帰テスト（`policy-gate.test.ts` v2.2 群）: テンプレートリテラル内、正規表現リテラル（`/\/\/ eslint-disable/`）、JSX 式コンテナ内ディレクティブ（検出）と JSX テキスト（非検出）、複数行ブロックコメント、CRLF の行番号（LF→CRLF だけの変更は新規ではない）、Unicode（日本語・絵文字・サロゲートペア）。
- 判定不能は成功扱いにしない: 構文エラーのあるファイルは `PG-UNPARSEABLE`（blocking、可能な範囲で解析を続け eslint-disable 等も併せて検出）、JSONC 設定の破損も `PG-UNPARSEABLE`、検出器の例外は `PG-ANALYSIS-ERROR`（blocking）。
- 偽陽性の確認: runner の全ソース・テスト（30 ファイル超）を「新規ファイル」として評価し 0 件になる回帰テストを常設。`scripts/policy-gate-audit.mjs` 再実行: ドッグフーディング 17 ワークスペース（v2.2 の 3 件を含む）で AI 生成差分の真陽性 3（旧 2 件 + 本フェーズの `// eslint-disable-next-line no-console -- ...`）、偽陽性 0。自リポジトリのコミット c91bd00 の検証 scripts 強化は Phase 4 の分類で **warning**（「強化された（要確認）」）になり blocking ではなくなった。

### Phase 2 Policy Gate 差し戻しループの実測 — 一部観測（D-33）

| 実行 | 経路 | 状態遷移（run.state_changed の実ログ） | 結果 |
|---|---|---|---|
| `v22-policy-loop` | ヒアリング（`--prefer eslint_disable,...`）→ 承認 → Run | PREFLIGHT → IMPLEMENTING → NEEDS_HUMAN | 機械回答が Q-003 で「例外は登録済み」（虚偽）を選択。Requirements Agent は Policy Gate を知っているため要件に「例外が無ければ停止」を織り込み、Builder はベースコミットに policy.json が無いことを確認して**変更せず停止**（NO_CHANGES）。Builder $0.03、328 s |
| `v22-policy-loop-2` | ヒアリング（Q-002 で「後で例外登録」）→ 承認 → Run | PREFLIGHT → **IMPLEMENTING → POLICY_BLOCKED → IMPLEMENTING → VERIFYING → REVIEWING** → IMPLEMENTING → POLICY_BLOCKED → NEEDS_HUMAN | Round 1: Builder が `// eslint-disable-next-line no-console` を追加 → `policy.gate`（blocking 1、PG-ESLINT-DISABLE）→ POLICY_BLOCKED。Round 2: `builder.started` に `hasFeedback:true, feedbackKinds.policy:1`、`rounds/2/feedback.json` に違反と修正指示 → Builder が `process.stdout.write` に修正、Policy Gate 0 件、検証 4/4 PASS、Codex は「要件が console.log と抑制コメントを明示しているのに逸脱」で changes_requested（high 2）。Round 3: Builder が再び eslint-disable を書き → POLICY_BLOCKED → 上限で NEEDS_HUMAN / POLICY_VIOLATION。Builder 合計 $0.17、304 s |
| `v22-policy-loop-3` | 人間が書いた task.yaml（抑制コメントは「付けてよい」）を直接承認 → Run（`scripts/live-policy-loop.mjs`） | PREFLIGHT → IMPLEMENTING → VERIFYING → REVIEWING → COMPLETED | Builder はラウンド 1 から `process.stdout.write` を選び違反なし。Policy Gate 0 件、検証 PASS、Codex approved。Builder $0.05、137 s |

- **観測できた条件:** ラウンド 1 で実際に blocking 違反が出る（実行 2）／指摘が Claude Code に渡ったことのログ証跡（`builder.started.feedbackKinds.policy=1`、`rounds/2/feedback.json`、`policy.gate` イベント）／後続ラウンドで違反が解消される（実行 2 の Round 2: Policy Gate 0 件、検証 PASS、レビュー実行）。
- **未観測:** 差し戻し後に **COMPLETED** まで到達する経路（`... → REVIEWING → COMPLETED`）。実行 2 では要件そのものが抑制コメントを必須にしていたため、Codex が要件に照らして逸脱を正しく指摘し、Builder が要件に従って再び違反 → NEEDS_HUMAN。これは「依頼と Policy Gate が矛盾したら人間が決める」という設計どおりの fail-closed であり、人間レビューも妥当と判断（`docs/dogfood-review.json`）。逆に要件に規約へ合わせる余地があると（実行 3）Builder は最初から違反を生まない。3 回（Builder 合計約 $0.25、約 13 分）で打ち切り、未観測として記録する。モックでは `engine.test.ts` v2.1 case 8 で `IMPLEMENTING → POLICY_BLOCKED → IMPLEMENTING → VERIFYING → REVIEWING → COMPLETED` の遷移列を検証済み。
- 副産物: Requirements Agent が Policy Gate の存在を要件（「例外が無ければ停止」）に織り込む挙動を確認（実行 1）。虚偽の前提（「登録済み」）で承認しても Builder はベースコミットを確認して止まる。

### Phase 3 意思決定ログの改善 — 実装済み（D-32）

- 共通 `DecisionRecord`（topicKey / source / kind / question / options / chosen / chosenLabel / rationale / consequence / evidence / relatedRequirements / decidedAt / history / supersededBy / status）。通常質問・矛盾解消・承認前修正をすべて記録。
- 「戻る」は `retracted`、再回答は履歴に積む。矛盾する判断（同じ問い / 同じ対象要件 / 矛盾解消が名指しした判断）は新しい方を優先し古い方を `superseded`。素案生成・矛盾検出には active な判断を「拘束力のある判断（後の判断が優先、revision は最新の明示的指示）」として渡し再質問しない。
- 検証: `decisions.test.ts` 6 件、`draft-service.test.ts` 追加 3 件（記録・履歴・revision・superseded・propose への受け渡し・decisions.json）。実機（実行 2）でも Q-001 / Q-002 の判断が `source: interview`、理由（推奨案の引用）付きで記録されたことを確認。

### Phase 4 検証スクリプト変更の分類 — 実装済み（D-34）

- 無効化・削除 = blocking、`&&` での追加・厳格化フラグの追加 = warning（内容を提示、完了は可）、機械的に判断できない変更 = blocking（人間の例外登録が必要）。AI は例外を承認できない（例外はベースコミットの policy.json のみ）。
- 検証: `policy-gate.test.ts` Phase 4 群、監査で自コミット c91bd00 が warning に分類されることを確認。

### Phase 5 UI ユーザビリティ — 実施（`docs/UX_REVIEW.md`）

- `apps/desktop/e2e/ux-walkthrough.spec.ts`（`UX_WALKTHROUGH=1`）で 4 画面 11 枚のスクリーンショットを取得し、非 CLI 利用者視点で評価。良い点 6 項目、問題点 12 項目を P0〜P3 で優先度付け（P0: 要確認 / 完了時の「次の手動操作」が CLI 前提、P1: 質問中の承認セクションの情報過多、承認画面の長さと所要時間・利用量の目安欠如、進捗中の「今なにをしているか」、専門用語）。
- 本フェーズで対応した小改善: 実行画面で `POLICY_BLOCKED` を「実装（ポリシー違反で差し戻し中）」として表示し説明文を追加。モックにも意思決定ログを実装し UI で確認可能に。
- 外部テスターは確保できず未実施（募集時の観点を記載）。

### 完了基準の確認

| 基準 | 結果 |
|---|---|
| 既存テストと新規テストがすべて PASS | Vitest 200 passed（実 Docker 7 件を含む。`CI=1 RUN_DOCKER_TESTS=1`）、LIVE-01 headless 再実行 PASS（157 s）。LIVE-02 は実 Docker テスト 7 件の再実行で代替、LIVE-03（インストーラ）は再実測なし（Rust / サイドカーに変更なし）、Playwright 13（+ ウォークスルー 4、既定はスキップ）、tsc / svelte-check / cargo check / eslint クリーン |
| Policy Gate の差し戻しループを実機で確認 | 一部観測（IMPLEMENTING → POLICY_BLOCKED → IMPLEMENTING → VERIFYING → REVIEWING、ログ証跡あり）。差し戻し後の COMPLETED は未観測（上記理由） |
| 意思決定ログの保存と再利用を確認 | テストと実機で確認（decisions.json / DraftView.decisions / propose プロンプトの拘束判断） |
| UX 課題を優先度付きで整理 | `docs/UX_REVIEW.md` |
| ドキュメント更新 | README、DECISIONS（D-31〜D-34）、QUALITY_REPORT、UX_REVIEW、本レポート |
| 制約 | Docker 隔離・ネットワーク制限・権限制御は変更なし。push / merge / deploy なし。実 CLI の利用は 3 Run + LIVE 再実行（Builder 合計 < $1） |

## 0″. v2.1 品質保証強化の結果（2026-11-01 追記）

### Phase 1 Policy Gate（P0）— 実装済み（D-29）

- `apps/runner/src/policy-gate.ts`: ベースコミットと作業ツリーの**内容の多重集合**比較で「新規」だけを検出する 8 ルール（新規 eslint-disable、新規 @ts-ignore/@ts-nocheck、テスト skip/only/todo 追加、テストファイル削除、必須検証 scripts の削除・無効化・変更、tsconfig の strict 緩和・exclude 追加、ESLint ルール off 化・格下げ・ignores 追加、Vitest/Jest/Playwright の除外追加・passWithNoTests）。コメント・テスト構文・設定は TypeScript コンパイラ API（パーサ駆動のコメント範囲、AST、JSONC パーサ）で判定し、文字列内の一致は無視。
- 検出結果は `ruleId / file / line / evidence / message / approved` を持ち、`rounds/<n>/policy.json`、`policy.gate` イベント、report.md、結果画面「Policy Gate」に表示。
- 未承認 blocking → 検証・レビューを飛ばして Builder に差し戻し（残試行があれば）、上限で `NEEDS_HUMAN / POLICY_VIOLATION`。完了ゲート 7 でも不合格にするため Reviewer の approved で上書き不可。例外は**ベースコミット**の `.agent-orchestrator/policy.json`（理由必須、glob 可）のみ。作業ツリー側（AI が書いた内容）は無視。
- 従来の regex 差分ポリシーはセキュリティ系（worktree 外・禁止パス）だけを残す。

### Phase 2 Requirements Agent の矛盾検出（P0）— 実装済み（D-30）

- 素案確定後に矛盾検出（`contradiction.schema.json`）を実行。要件同士 / 要件と既存コード・設定の矛盾を `blocking | minor` で分類し、blocking は根拠・選択肢・影響付きの blocking 質問（`CONTRA-*`）として差し戻す。解消するまで承認不可、スキップは BLOCKED、質問上限超過は BLOCKED。
- `RepoInspector` が ESLint ルール（error / off、`no-restricted-*` のメッセージ、ignores）と tsconfig の strict フラグを facts として抽出し、ヒアリング（ラウンド 1）でも矛盾が質問される。
- 判断は意思決定ログ（SQLite `decisions`、`tasks/<id>/revisions/<rev>/decisions.json`、DraftView.decisions、画面「意思決定ログ」）に保存し、再検出時に既決定として渡す。

### Phase 3 回帰テスト — 10 ケースすべて追加・PASS

| # | ケース | テスト |
|---|---|---|
| 1 | eslint-disable の新規追加を検出 | `policy-gate.test.ts` case 1 |
| 2 | 既存の eslint-disable は誤検出しない（移動・同一コメント増分） | case 2 |
| 3 | @ts-ignore / @ts-nocheck 検出（@ts-expect-error は許容） | case 3 |
| 4 | skip / only / xit / todo の追加検出（AST、文字列内は無視） | case 4 |
| 5 | テスト削除の検出 | case 5 |
| 6 | 検証設定の緩和（scripts / tsconfig / ESLint / Vitest） | case 6 群 |
| 7 | 未承認違反があると完了しない（3 ラウンド差し戻し → NEEDS_HUMAN、Reviewer approved でも不合格） | `engine.test.ts` v2.1 case 7、gate 7 |
| 8 | 違反を修正すると完了できる | `engine.test.ts` v2.1 case 8 |
| 9 | 矛盾した要件はユーザーに差し戻される | `draft-service.test.ts` case 9 |
| 10 | 矛盾解消後は YAML を生成できる（意思決定ログ付き） | `draft-service.test.ts` case 10 |

追加: ベースコミットの例外のみ有効（AI が作業ツリーに置いた例外は無効）、trailing コメントの回帰、テンプレートリテラル内の文字列は無視、minor 矛盾は openItems、矛盾出力の不正は BLOCKED。

### Phase 4 検証と記録

- 回帰: Vitest 183（実 Docker 7 含む）、Playwright 13、tsc / svelte-check / cargo check / eslint クリーン、受入 PASS 56 / 0 / 0。
- 偽陽性・偽陰性の調査（`scripts/policy-gate-audit.mjs`、`docs/QUALITY_REPORT.md`）: ドッグフーディング 14 ワークスペースと自リポジトリ直近 12 コミットにゲートを適用。AI 生成差分の真陽性 2（旧 `eslint-disable-next-line`、新 `eslint-disable-line`）、偽陽性 0。自作コミットでは `PG-VERIFY-SCRIPT` 1 件（検証 scripts の強化変更を設計どおり保守的に検出）。
- **実 CLI 検証 1 回目で偽陰性を発見・修正:** 依頼と lint 規約が矛盾するシナリオで、Builder が `return \`...\`; // eslint-disable-line no-restricted-syntax`（行末コメント）を書き、初版の scanner 実装が取り逃がして COMPLETED になった。パーサ駆動のコメント収集に修正し、回帰テストと監査で検出を確認（D-29 追記）。
- **実 CLI 検証 2 回目（修正後、同じ矛盾依頼・新規サンプルリポジトリ）:** ヒアリングのラウンド 1 で「必ずテンプレートリテラル」と `no-restricted-syntax` の矛盾が blocking 質問として提示され、選択肢は `concat（規約に従う）/ exception（人間が policy.json に例外登録）/ disable_rule（Policy Gate で阻止される旨を明示）` の順。規約に従う選択で Builder は文字列連結で実装し、eslint-disable なし、Policy Gate 0 件、検証 PASS、Codex approved → COMPLETED（1 ラウンド、244 s、Builder $0.06）。人間レビューも approved。
- **未観測:** 実 CLI で Policy Gate が blocking を出して Builder に差し戻し、修正後に完了する経路。モックテスト（case 7 / 8）で検証済み。実 AI 出力に対する検出自体は監査（旧 `eslint-disable-next-line`、新 `eslint-disable-line`）で確認。
- **残課題:** ヒアリング（通常質問）で解消された矛盾は回答履歴に残るが意思決定ログには記録されない（CONTRA- 質問のみ）。`PG-VERIFY-SCRIPT` は検証 scripts の強化変更も検出するため、意図した変更には例外登録が必要。Policy Gate は TS/JS/JSON 設定のみ対象（Python 等は対象外）。

## 0′. ドッグフーディング・品質検証フェーズの結果（2026-11-01 追記）

詳細指標は `docs/QUALITY_REPORT.md`（`scripts/quality-report.mjs` が `test-results/dogfood/*.json` と `docs/dogfood-review.json` から生成）。

### Phase 1 実プロジェクトでの試験利用（3 件、コピー上で実行）

| タスク | 対象 | 結果 | ラウンド | 時間 | 人間レビュー / AI 判定 |
|---|---|---|---|---|---|
| T1 `formatRemaining(ms)`（mm:ss 整形 + テスト） | batontime（React/Firebase スキャフォールド、21 ファイル） | COMPLETED | 1 | 144 s | approved / approved（一致） |
| T2 `maskSecrets` に Google / Stripe キーのパターン追加 + テスト | agent-orchestrator 自身（156 ファイル） | NEEDS_HUMAN / MAX_ROUNDS | 3 | 562 s | needs_human / changes_requested（一致）。Codex の 3 指摘は妥当（新ラベル置換と既存の全体マスクの優先順位が依頼内で矛盾） |
| T3 `clamp()` を packages/core に追加 | temporaid（pnpm モノレポ、149 ファイル、Prisma） | PRECHECK_FAILED（ベースライン検証） | 0 | 195 s | not_evaluated（AI 未呼出。`prisma generate` が HTTP_PROXY を無視して `binaries.prisma.sh` へ直接接続し DNS 不可、`apps/web` typecheck が SIGKILL） |

実プロジェクトで最初に当たったのは AI ではなく「検証環境」の問題で、以下を**製品側の不具合として修正**した（いずれも回帰テスト付き、D-23〜D-28）:

1. ロックファイル未コミット / `packageManager: pnpm@9.12.0` による版切替失敗 / pnpm 12 の supply-chain policy による lockfile 拒否 → pnpm の版切替を無効化、運用者設定 `AGENT_ORCHESTRATOR_PNPM_MIN_RELEASE_AGE`（D-24, D-26）
2. Git for Windows の `core.autocrlf`（システム設定）を無視して `git status` していたため、クリーンなリポジトリが「未コミット変更あり」で preflight 失敗 → 利用者設定で判定（D-25）
3. **ベースライン検証**（Builder 前に未変更リポジトリで検証プロファイルを実行）を追加し、環境起因の失敗を AI 費用ゼロで `PRECHECK_FAILED` にする（D-23）。T2 では、私自身が失敗テストを含むコミットを作った際にベースラインが検出した
4. ネストした `functions/node_modules` の symlink で pull の tar が失敗 → 除外パターンを全階層に（docker-sandbox 回帰テスト）
5. Builder が書いた `test-results/vitest.json`（gitignore 対象）を検証ステップが更新し、レビュー前後ハッシュが不一致 → レビュー前に再同期、`.gitignore` 対象を差分・ハッシュから除外（D-27）
6. 自己リポジトリの差分（大きな JSON を含む）をプロンプトとして argv に載せたため Windows の argv 長制限で `docker run` の spawn が失敗し、レビューが即 null → **プロンプトは stdin で渡す**、spawn 失敗を明示的なエラーに（D-28）
7. `round.json` / `status.json` が未マスクで保存され得た → 保存前にマスキング。全成果物を走査する認証情報ハイジーンテストを追加
8. 自分自身の `typecheck` / `test:run` が contracts のビルド済み dist を前提にしていてクリーンクローンで失敗 → スクリプトを自己完結に。`describe.skip` の LIVE テストが収集時にネットワークを使っていた → `beforeAll` へ

### Phase 2 未観測ループの検証（実 CLI、強制なし）

| ケース | 観測 | シナリオ |
|---|---|---|
| Codex `changes_requested` → Claude Code 修正 → `approved` | **観測** | `safeJoin`（パストラバーサル判定）: Round 1 high「baseDir が `/` のとき結果 === baseDir を拒否できない」→ Round 2 で条件とテストを追加 → approved → COMPLETED（2 ラウンド、344 s） |
| 自動検証失敗 → Claude Code 修正 → 検証成功 | **観測** | 厳格 lint（テンプレートリテラル禁止）のサンプルで、依頼が「必ずテンプレートリテラルで」と規約に矛盾 → Round 1 lint exit 1 → Round 2 修正 → 検証 PASS → approved → COMPLETED（2 ラウンド、290 s）。ただし修正は `eslint-disable-next-line` による規則の局所無効化で、Codex はこれを指摘しなかった（人間レビューは approved_with_concern、唯一の不一致） |
| （参考）同じ厳格 lint で矛盾の無い依頼 | 1 ラウンドで完了 | Builder が lint 設定を読み取り、文字列連結で実装（検証失敗ループは発生せず） |

### Phase 3 安全性と可観測性

- **seccomp の残余リスク整理と引数制限:** Reviewer コンテナのプロファイルは Docker 既定 + 5 syscall。さらに `clone` は **CLONE_NEWUSER を含む呼び出しのみ**追加許可、`unshare` は **namespace フラグ以外のビットが無い呼び出しのみ**に絞った（`SCMP_CMP_MASKED_EQ`。bwrap が動くことを変種ごとに実測）。`mount` / `umount2` / `pivot_root` はポインタ引数のため絞れない。残余リスク: 非特権 user namespace 内の mount 系 syscall によるカーネル攻撃面（capability は全て落下、書込先は :ro ワークスペース・/aux・tmpfs のみ）。D-22 に更新。
- **egress ログの UI 表示:** Run ごとに `runs/<runId>/egress.jsonl` を保存し、結果画面の「ネットワーク（egress プロキシ）」で **許可（AI / レジストリ通信）／ 拒否（allowlist 外、ホスト別件数）／ 接続エラー** を区別して表示。ログはホスト名とポートのみ（URL パス・ヘッダー・認証情報なし）。Playwright UI-08 で表示を検証。ドッグフーディングでは Codex が `*.oaiusercontent.com` / `ab.chatgpt.com` へ接続を試み、拒否されていることが可視化された（計 64 件拒否、機能影響なし）。
- **認証情報のログ混入テスト:** Builder 出力・レビュー要約・egress エラー文にトークンを混入させ、`runs/<runId>` 配下の全ファイルと SQLite のイベントに残らないことを検証（この過程で round.json / status.json の未マスクを発見・修正）。

### Phase 4 品質指標（ドッグフーディング 6 Run）

| 指標 | 値 |
|---|---|
| タスク完了率（COMPLETED / Run 開始） | 4 / 6 = 67%（NEEDS_HUMAN 1、PRECHECK_FAILED 1） |
| 1 タスク当たりの実行時間（平均） | 284 s（ヒアリング 67 s、Run 217 s） |
| 平均修正ラウンド数 | 1.50（Builder 9 回、Reviewer 8 回） |
| Builder / Reviewer 1 回あたり平均時間 | 33 s / 21 s |
| unknown 発生率（レビュー） | 0 / 8（JSON 不正・unknown なし） |
| 人間が発見した未検出の問題 | 1 件（lint 規則の局所無効化を Reviewer が指摘せず） |
| 人間レビューと AI 判定の一致 | 5 / 6（不一致 1 件は上記） |
| AI 利用量 | Builder 報告費用 合計 $0.683（9 回、1 回 $0.05〜0.11）。Codex はサブスクリプション消費（費用 API なし）。ヒアリング（Requirements Agent）は費用未報告 |
| egress | 許可 1,191 / 拒否 64 / エラー 0 |
| 元リポジトリの不変 | 全件 |

回帰: Vitest 162、Playwright 13、tsc / svelte-check / cargo check / eslint クリーン、受入テスト PASS 56 / FAIL 0 / NOT_RUN 0。

### 改善候補（優先順位付き）

1. **（高）依頼とプロジェクト規約の矛盾をヒアリング段階で検出する** — 検証設定（lint ルール等）と依頼文の衝突を Requirements Agent の facts に含め、blocking 質問にする。あわせて差分ポリシーに `eslint-disable` / `@ts-ignore` / `skip` 系コメントの**新規追加**を警告として検出し、Reviewer プロンプトにも明示する（今回の唯一の未検出）。
2. **（高）プロキシ非対応ツールへの対応** — `prisma generate` 等 `HTTP_PROXY` を無視するツールは allowlist に入れても到達できない。透過プロキシ（iptables REDIRECT）または egress ゲートウェイ方式の検討。それまでは README に「対象外のプロジェクト種別」として明記。
3. **（中）ベースライン検証の結果キャッシュ** — 同じ baseSha で成功したベースラインを再利用し、Run ごとの install / typecheck（1〜4 分）を省く。
4. **（中）Requirements Agent の費用・トークンの記録** — Claude JSON の `total_cost_usd` / usage を Draft にも保存し、品質レポートに含める。
5. **（中）モノレポの並列 typecheck と資源上限** — `pnpm -r` の並列実行でメモリ 4g を超えて SIGKILL。並列度の抑制（`--workspace-concurrency 1`）か上限の自動調整。
6. **（低）egress ログの許可先別件数・時系列表示**、Codex の `oaiusercontent.com` 到達試行の背景調査（添付ファイル取得と推定）。

## 0. リリース準備フェーズの結果

### Phase 1 ベースライン確定

- `.gitignore` を点検し、`node_modules` / `dist` / Tauri `target` / SEA サイドカー exe / `app-data` / `.tmp` / ログ / `test-results/*`（`live.json` のみ追跡）を除外。`env -i` 起動時に生成された `%SystemDrive%/` を削除し除外。
- 追跡対象 151 ファイルを秘密情報パターン（API キー、トークン、PEM、OAuth JSON）で走査。該当はテスト用のダミー鍵文字列のみ。認証ファイル・実行ログ・SQLite・一時データは含まれない。
- ベースラインコミット: **`f0b4162`**（push なし）。

### Phase 2 Reviewer のセキュリティ強化（seccomp）

- **原因:** Codex `--sandbox read-only` が内部で使う bubblewrap は非特権 user namespace を必要とする。Docker 既定 seccomp は `unshare` / `mount` / `pivot_root` を CAP_SYS_ADMIN 保持時のみ許可し、`clone` の namespace フラグをマスクで拒否するため、cap-drop ALL のコンテナでは `bwrap: No permissions to create a new namespace` となる（カーネル自体は `max_user_namespaces=63941` で許可）。
- **調査:** `scripts/derive-seccomp-profile.mjs` が Docker 既定プロファイル（moby/profiles）に候補 12 syscall を追加し、1 つずつ外して実イメージで bwrap を実測。必要最小集合は **`unshare`, `clone`, `mount`, `umount2`, `pivot_root`** の 5 つ（`clone3`, `setns`, `chroot`, `sethostname`, `mount_setattr`, `open_tree`, `move_mount` は不要）。
- **実装:** `docker/sandbox/seccomp-reviewer.json`（既定 + 5 syscall）を `isolation/seccomp-profile.ts` に埋め込み、Reviewer ステップのみ `--security-opt seccomp=<app-data>/sandbox/seccomp-reviewer.json` を適用。`unconfined` は廃止。プロファイルが無ければ fail-closed。cap-drop ALL / no-new-privileges / 非 root / read-only root / ワークスペース `:ro` / internal ネットワークは維持。
- **実測:** 既定プロファイルでは bwrap 失敗、カスタムでは成功、CapEff=0、hostname 変更不可（`docker-sandbox.test.ts`）。実 Codex がワークスペース内で `ls` / `cat` を実行し、`/workspace` への書込は `denied` と報告。隔離・egress テスト 7 件すべて PASS。
- **残余リスク:** 非特権 user namespace 内の `mount` / `pivot_root` が使えるため、カーネル userns 実装の脆弱性が攻撃面になる。capability は全て落ちており、書込先はワークスペース `:ro`、`/aux`、tmpfs のみ。D-22 に記録。

### Phase 3 実 CLI 複数ラウンド検証

| シナリオ | 結果 |
|---|---|
| オープンリダイレクト判定 `isSafeRedirect` | 1 ラウンドで Codex approved → COMPLETED（複数ラウンドにならず） |
| CORS オリジン判定 `isAllowedOrigin`（完全一致 + サブドメインワイルドカード） | **3 ラウンド**: Round 1 Claude Code 実装（34 s）→ 検証 PASS → Codex `changes_requested`（high: ホスト名検証が不正ラベル・非正規オリジンを受理）→ Round 2 修正（32 s、差分 +45→+61 行）→ 検証 PASS → Codex `changes_requested`（high: 16 進 IPv4 形式で厳密検証を回避）→ Round 3 修正（26 s）→ 検証 PASS → Codex `changes_requested`（high: ポート 0 / IPv6 ホストの完全一致を許可できない）→ 上限到達で **NEEDS_HUMAN / MAX_ROUNDS** |

- 指摘の伝達: `round.started` イベントで Round 2 / 3 に `hasFeedback: true`、各ラウンドの差分は前ラウンドの指摘に対応して変化（diff.patch は 3 ラウンドすべて異なる）。レビュー前後のワークスペースハッシュは 3 回とも一致。
- 上限・予算: 3 ラウンド、Builder `--max-budget-usd 10`、`cliTimeoutSeconds 900`、`maxDurationSeconds 2700` 内で終了。自動承認は行われず、レポートに未解決指摘と次の手動操作を記載。
- 観察: Codex は毎ラウンド異なる high 指摘を出した（要件の「意図しないオリジンを許可しない」を厳格に解釈）。修正ループの機構は実証されたが、`approved` に収束するケースの実測は 1 ラウンド完了の 3 回（LIVE-01 headless、GUI、リダイレクト）のみ。

### Phase 4 Windows 配布

- `tauri build`（`bundle.targets = ["nsis"]`）で **`Agent Orchestrator_0.1.0_x64-setup.exe`（24 MB）** を作成。
- `/S /D=<dir>` でサイレントインストール → `agent-orchestrator-desktop.exe`（4.3 MB）、同梱サイドカー `agent-orchestrator-runner.exe`（Node SEA、91 MB）、`uninstall.exe`。
- Node を PATH から外した環境で起動 → 同梱サイドカーが ready → environment.check / project.inspect 成功（Playwright CDP smoke）。サンドボックスイメージ無しの構成で「✖ 実行不可：セットアップが必要です」と修正方法を表示し開始ボタン無効。
- `uninstall.exe /S` で残存ファイル・レジストリ 0。
- **コード署名: 未実施**（`Cert:\CurrentUser\My` / `LocalMachine\My` に署名証明書なし）。手順と設定（`certificateThumbprint`、サイドカーの先行署名、`signCommand`）は `docs/RELEASE.md` に整備。未署名のまま配布しない。

### Phase 5 最終検証

| チェック | 結果 |
|---|---|
| Vitest（実 Docker 7 件含む） | 157 passed / 1 skipped（LIVE は別実行） |
| Playwright（モック UI-01〜10） | 13 passed |
| TypeScript（contracts / runner / tests） | 0 errors |
| svelte-check | 0 errors / 0 warnings |
| cargo check | ok |
| eslint | 0 problems |
| 受入テスト集計 | PASS 56 / FAIL 0 / NOT_RUN 0 |

## 1. 実装済み（自動テストで実測）

| 領域 | 内容 | 根拠 |
|---|---|---|
| 契約 | JSON Schema（task / review / interview / ipc + task-proposal）、Zod + Ajv 二重検証、埋め込みスキーマ | contracts 17 件 |
| 実行状態機械 | 6 状態 + 4 終端、3 回上限、検証失敗時はレビューを飛ばす、unknown / JSON 不正 / 不整合は人間へ | engine 22 件 + LIVE 3 ラウンド |
| 完了ゲート | 7 ゲートを純粋関数で判定 | gate 11 件 |
| プロセス制御 | shell:false、コマンド allowlist、タイムアウト、出力上限、マスキング | process-runner 7 件 |
| 隔離ワークスペース | detached clone、未追跡含む差分、tree hash、同期除外、元リポジトリ不変 | workspace 5 件 + LIVE-02 |
| Docker サンドボックス | 使い捨てコンテナ、非 root、cap-drop ALL、read-only root、internal ネットワーク + allowlist プロキシ、ボリューム + tar 同期、Reviewer 用カスタム seccomp | docker-sandbox 7 件 + LIVE |
| 起動前検査 | 環境 / リポジトリ / 検証プロファイル / 認証注入 / Docker 隔離の実測 | preflight 5 件 + LIVE |
| Verifier / Builder / Reviewer | 固定コマンド、実フラグ、危険フラグ拒否、契約検証、認証注入、read-only レビュー | 各テスト + LIVE |
| Requirements Agent | read-only 調査、facts の根拠、ギャップ分析、ラウンド管理、素案 → task.yaml、承認 / 再承認 | 約 40 件 + LIVE |
| 永続化・監査 | SQLite（WAL）、連番イベント、runs/<runId>、report.md、再起動時 INTERRUPTED | storage / run-service |
| IPC / デスクトップ | stdio JSON、method allowlist、Tauri 2 + Svelte 5 の 4 画面、サイドカー解決 | ipc + Playwright + LIVE GUI |
| 配布 | Node SEA サイドカー、NSIS インストーラ | LIVE-03 |

## 2. 未実装 / 未実測

| 内容 | 状態 |
|---|---|
| コード署名 | 署名鍵が無いため未実施。手順整備のみ（`docs/RELEASE.md`） |
| 実 CLI で `changes_requested` → 修正 → `approved` に収束するケース | 未観測（3 ラウンドシナリオは上限到達で NEEDS_HUMAN、他 3 回は 1 ラウンドで approved）。ループ機構自体は実測済み |
| 実 CLI での検証失敗（typecheck / lint / test）→ 修正ループ | 未観測（4 回の実行で検証は常に PASS）。モックで EX-02 を検証 |
| WSL2 ディストリビューション内で runner を動かす構成 | 未実測 |
| `node-pnpm` 以外の検証プロファイル | MVP 対象外 |
| egress の TLS 検査 | プロキシは CONNECT 中継のみ |
| 大規模リポジトリでの性能 | サンプル（8〜10 ファイル）のみ |

## 3. 残余リスク

- Reviewer コンテナで非特権 user namespace を許可（D-22）。カーネル userns の脆弱性が攻撃面。
- egress allowlist は許可ホストへの通信内容を検査しない。許可先（Anthropic / OpenAI / npm registry）へのデータ送信はモデル利用の前提として承認画面で同意を得る。
- `pnpm install --ignore-scripts` のため postinstall が必要な依存では検証が失敗する（fail-closed）。
- 未署名の配布物は SmartScreen 警告の対象。

## 4. 残課題

1. 署名鍵の調達とコード署名の実施（サイドカー → 本体 → インストーラ）。
2. 実 CLI で approved に収束する修正ループ、検証失敗からの修正ループの実測機会。
3. egress プロキシのログを `runs/<runId>/egress.jsonl` に保存し UI に表示。
4. 大規模リポジトリでのダイジェスト品質と性能の評価。
