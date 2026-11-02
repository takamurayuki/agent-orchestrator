# v0.2.2 最終安定化・リリース検証レポート

実施日: 2026-11-02　ベースライン: v0.2.1（`9d6ba7a`、Vitest 249 / Playwright 29 / 受入 56 PASS を実リポジトリで確認）　実施者: 実装者（同一 PC、Windows 11 Pro）

> 原則: 未検証項目は PASS と扱わない。モックの成功を実 CLI の成功として報告しない。Docker 隔離・seccomp・egress allowlist・Policy Gate・Completion Gate は変更していない。

## 1. Phase 1 生成物の依存関係診断（D-42）

| 項目 | 実装 |
|---|---|
| 依存関係の解析 | `requirements/generated.ts` の `extractGeneratorPaths`: package.json の生成スクリプト候補（`node <file>`）のソースから fs 呼び出しの引数（文字列リテラル / `join(...)` / `'dir/' + x` / 代入された識別子）を解決し、読み込み先と書き込み先を分ける。動的に決まるパスは `dynamic`（unknown） |
| 分類 | `repo-inspector.ts` の `classifyRepoPath`: `git ls-files`（tracked）/ `git check-ignore`（ignored）/ それ以外（missing: 未追跡または存在しない）。git にはシェルを介さず引数で渡す。`..` や絶対パスは unknown |
| 契約 | `GeneratedArtifact.inputs[]`（path / status / detail）と `inputStatus`（ok / missing / unknown）。zod と JSON Schema（task / task-proposal）を同時に更新 |
| 承認前の警告 | `inputStatus: missing` の生成物は blocking 質問 `GENIN-<round>-<n>`（「対象外にする」/「入力なしで再生成する（内容の妥当性は未確認として記録）」）。回答は判断記録として素案に機械的に適用（対象外 → outOfScope、続行 → openItems に注記）。`unknown` は facts と承認画面の注記のみでブロックしない |
| 更新確認と妥当性の区別 | Verifier の合格メッセージ・Builder / Reviewer 指示・承認画面で「最新性の確認」と「内容の妥当性（未確認）」を区別。既存のハッシュ比較と完了ゲートは不変 |
| テスト | `generated.test.ts`（静的解析 2 生成器 + 動的パス + 分類・質問・判断適用）、`verification-generated.test.ts`（妥当性未確認の注記）、`draft-service.test.ts`（gitignore 入力 → GENIN 質問 → manual / proceed、追跡済み入力 → ok） |

受入条件: 入力不足の検出（gitignore された `data/` を読む生成器 → `missing` と facts、質問）PASS / 正常な生成処理（`docs/API.md` ← `docs:api`、入力 `src` は tracked → ok、質問なし）PASS / 不明な依存を確認済みと誤判定しない（`process.argv` 由来の読み込みは unknown）PASS / 新規回帰テスト PASS。

## 2. Phase 2 実行失敗の診断改善（D-43）

`apps/runner/src/failure-diagnosis.ts` が Run の状態・理由コード・最終ラウンドの検証コマンド（終了コード・出力抜粋）・Builder の結果抜粋・Reviewer の判定・egress 集計から、次を区別する（確度 confirmed / inferred / unknown 付き）。

| 分類 | 判定の根拠 |
|---|---|
| builder_command_denied | Builder 結果抜粋の拒否表現（denied / not allowed / expansion obfuscation 等）。テキスト照合のため inferred |
| docker_error | 検証コマンドの docker エラー文 / exit 125–127、PRECHECK の Docker 失敗 |
| network_blocked | ENOTFOUND / ECONNREFUSED / 407 / 403 等、または egress 拒否ホストがあり install が失敗 |
| dependency_fetch_failed | ERR_PNPM_FETCH_* / NO_MATCHING_VERSION / OUTDATED_LOCKFILE 等 |
| supply_chain_policy | ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION |
| generated_artifact | `generate:<script>` の不合格（古い / スクリプト失敗） |
| review_undecidable | REVIEW_UNKNOWN / INVALID_JSON / INCONSISTENT |
| limit_reached / verification_failed | MAX_ROUNDS・TIMEOUT・GATE_FAILED を、最終ラウンドの失敗コマンドまたは Reviewer 指摘で分ける |
| policy_violation / scope_deviation / builder_failed / no_changes / precheck / cancelled | 理由コード |
| unknown | 上記で確定できない（INTERNAL_ERROR 等）。推測で埋めない |

表示: レポート `report.md` の「停止理由の診断」節、結果画面の診断カード（何が起きたか / 開発結果への影響 / 自動修復 / 次に取る操作 / 根拠の折りたたみ）、IPC `run.report` の `failureDiagnosis`。次の操作に権限や隔離・allowlist・ポリシーを緩める案内は含めない。テスト: `failure-diagnosis.test.ts`（11 分類 + unknown + precheck）、Playwright `ui-17`。

## 3. Phase 3 実 CLI 検証（専用の一時リポジトリ、`scripts/dogfood.mjs` / `scripts/live-policy-loop.mjs`、Claude Code 2.1.316 / Codex CLI 0.166.0）

| TEST | 対象 / 依頼 | 結果 | 観察 |
|---|---|---|---|
| TEST-01 正常終了 | `.tmp/dogfood/sample-gen`（生成物 `docs/API.md` ← `docs:api`）。`farewell(name)` 追加 | **COMPLETED**、1 ラウンド、546 秒（ヒアリング 95 / Run 452）、$0.12 | 素案が `generatedArtifacts`（inputStatus ok）を質問なしで識別。検証 6/6（`generate:docs:api` 含む）、Codex approved、scope none。Run 時間の内訳: ベースライン検証 185 秒（新規ボリュームへの pnpm install）、Builder 40 秒、レビュー 65 秒 |
| TEST-02 自動修正 | `.tmp/dogfood/sample-review`。`safeJoin(baseDir, relativePath)`（パストラバーサル防止） | **COMPLETED**、2 ラウンド、1032 秒（ヒアリング 430 / Run 602）、$0.17 | R1: Codex が high 2 件（`%25` の拒否漏れ、相対 baseDir の誤拒否）→ フィードバックが Builder に渡る → R2: 修正、Codex approved。ヒアリングでは矛盾質問 CONTRA-001（リテラル `%` の扱い）が出て解消 |
| TEST-03 生成物の検証 | `.tmp/dogfood/sample-gen`。`shout(name)` 追加（依頼文は生成物に触れない） | **COMPLETED**、1 ラウンド、448 秒、$0.06 | facts から `docs/API.md` を識別、Builder が `pnpm run docs:api` を実行、Verifier の `generate:docs:api`（ハッシュ比較）合格 |
| TEST-04 入力不足 | `.tmp/dogfood/sample-missing`（生成器 `scripts/gen-stats.mjs` が `.gitignore` 対象の `data/` を読む）。STATS に平均行を追加 | **GENIN-4-1 で承認前に警告** → 機械回答「対象外」→ Run は COMPLETED、1 ラウンド、606 秒、$0.04 | facts `generation.input`（confirmed）、素案 `inputStatus: missing`、質問文に「data（.gitignore 対象。ローカルにはあるが隔離ワークスペースには無い）」。対象外の判断は outOfScope に記録され、Builder の変更は `scripts/gen-stats.mjs` のみ。入力不足を無視して成功扱いにしていない |
| TEST-05 安全な停止 | `.tmp/dogfood/sample-strict`（no-console = error）。人間が書いた task.yaml `tests/fixtures/tasks/policy-required-disable.yaml`（eslint-disable コメントを必須） | **NEEDS_HUMAN / POLICY_VIOLATION**、3 ラウンド、416 秒、$0.15 | PREFLIGHT → IMPLEMENTING → **POLICY_BLOCKED** → IMPLEMENTING → VERIFYING → REVIEWING（Codex が要件違反を指摘）→ IMPLEMENTING → POLICY_BLOCKED → NEEDS_HUMAN。Policy Gate は 2 回 `PG-ESLINT-DISABLE` で差し戻し、制約を緩めずに停止。report.md に「停止理由の診断: policy_violation（confirmed）」 |

元リポジトリは全件不変（`originalRepoUnchanged: true`）。egress 拒否は Codex のテレメトリ先（`*.oaiusercontent.com`、`ab.chatgpt.com`）のみ。生データ: `test-results/dogfood/v022-*.json`（ローカルのみ）、人間レビュー: `docs/dogfood-review.json`。

## 4. Phase 4 Windows 配布版の検証

クリーンな別 PC / VM は用意できなかったため（管理者権限の変更や外部リソースの取得は行わない方針）、同一 PC 上で **Node / pnpm 非搭載の PATH**（Git と Docker は実 CLI 動作に必要なため残す）と **空の app-data** で実測した。別環境での再現性は **未検証**。

### 4.1 配布物（最終ビルド）

| 項目 | 値 |
|---|---|
| インストーラ | `Agent Orchestrator_0.1.0_x64-setup.exe`（26,507,611 バイト） |
| SHA-256 | `BDB48173CBE61F76B9CA49F2E8EBA89A0C88CA31DF384FE24391E579DD5E17BC` |
| 同梱サイドカー | `agent-orchestrator-runner.exe`（Node SEA、105,828,864 バイト、SHA-256 `8061F053B01D706B2B10A82AEA75FB24C469D21957840DFE72AEFBB868F0C98F`） |
| コード署名 | **未署名**（NotSigned）。SmartScreen 警告の対象。一般公開不可 |
| ビルド手順 / 時間 | `pnpm build` → `node scripts/build-sidecar.mjs`（26 秒）→ `pnpm --filter @agent-orchestrator/desktop exec tauri build`（Rust フルビルド 334 秒） |
| 製品バージョン文字列 | `0.1.0` のまま（サンドボックスイメージのラベルと連動。公開版で一括更新） |

検証中に不具合を 5 件見つけて修正したため、インストーラは 4 回ビルドした（`E2131B92…` → `38DF8E25…` → `59911DBE…` → 最終 `BDB48173…`）。以下の結果は、特記がない限り最終ビルドでの実測。

### 4.2 インストール / 起動 / 再起動 / アンインストール（最終ビルド）

| 手順 | 結果 |
|---|---|
| `setup.exe /S /D=<dir>` サイレントインストール | exit 0。`agent-orchestrator-desktop.exe`（4,532,224）/ `agent-orchestrator-runner.exe` / `uninstall.exe` の 3 ファイル。`HKCU\…\Uninstall\Agent Orchestrator`（DisplayVersion 0.1.0）登録 |
| Node / pnpm 非搭載 PATH で起動（空の app-data、`AGENT_ORCHESTRATOR_APP_DATA` 指定、WebView2 のリモートデバッグ有効） | 同梱サイドカーが起動（`agent-orchestrator-runner` プロセス稼働、CDP 接続可）。`node` / `pnpm` は PATH に無いことを確認 |
| smoke（environment.check + project.inspect） | PASS。セットアップチェックは「実行可能」、Codex CLI はホストに無いため「警告（サンドボックス内の版で実行）」 |
| 初回サンドボックスセットアップ | **今回は未検証**（イメージが既にあり、消去して外部取得をやり直すことは「勝手に外部リソースを取得しない」方針で行わなかった）。v0.1.0 公開準備時に同じ手順（同意 → ピン留め取得 → 検証 → ビルド、39 秒）で検証済み |
| GUI: 依頼 → ヒアリング（質問 1 件に回答）→ 承認 → 実行 → 結果 | **PASS（COMPLETED）**。16.0 分（ヒアリング約 5 分: 回答後の再評価だけで約 4 分、ベースライン install 177 秒、Builder 1 ラウンド $0.12、検証 6/6 = install / typecheck / lint / test:run / `generate:docs:api` / structure、Codex approved）。結果画面の見出し「開発が完了しました（元のプロジェクトへの取り込みはまだです）」、report.md に実行レポート、作業用コピーのパス表示。同じフローは修正前のビルドでも 2 回 COMPLETED |
| GUI: 無効フォルダー（`C:\Windows\Temp`） | PASS。「Git リポジトリではありません (not_git)」と原因・修正案を表示し、開始ボタン無効 |
| GUI: 実行開始直後に「実行を停止する」 | PASS。`INTERRUPTED / CANCELLED`、見出し「途中で止まりました」、反映ボタンなし |
| アプリ終了 → 同じ app-data で再起動 | PASS。履歴 2 件（COMPLETED / INTERRUPTED）が復元され、中断した Run の結果画面を開ける |
| `uninstall.exe /S` | exit 0。インストール先ディレクトリ削除、レジストリ登録なし、スタートメニュー 0。app-data（利用者データ）は設計どおり残す |
| 後始末 | Docker コンテナ / ボリューム / ネットワークの残存 0 |

### 4.3 配布版検証で見つけた不具合と修正

| # | 内容 | 影響 | 修正 |
|---|---|---|---|
| 1 | 新しい依頼の作成中（数十秒）にヒアリング画面へ移ると、前回の承認済み要件サマリーが表示され、承認ボタンが「既に承認済み」で止まる | 2 件目以降の依頼で利用者が混乱する。自動操作は停止 | `createDraft` が作成前に前回の draft / 承認結果を消し、作成中は「draft 作成中」を表示（`actions.ts` / `Interview.svelte`） |
| 2 | 回答送信後の再評価中（GAP_ANALYZING、1〜4 分）に、素案が無いまま「承認して開発を開始」セクションが表示される | 利用者が再評価中と分からない | 再評価中は「要件を再評価しています」カードを表示し、承認セクションは素案があるとき（または BLOCKED の理由表示）だけ出す |
| 3 | 起動前検査のベースライン `install` が 131〜302 秒かかり、検証コマンド上限（300 秒）で `PRECHECK_FAILED` になることがある（4 回中 1 回） | 実行成功率の低下 | `install` にだけ 10 分の下限（`INSTALL_TIMEOUT_FLOOR_MS`）。隔離・allowlist・他コマンドの上限は不変。単体テスト追加 |
| 4 | GUI 検証スペック（Playwright live）に操作の時間上限が無く、上記と重なると 1 時間のテストタイムアウトまで原因不明のまま止まる | 検証の効率 | `playwright.live.config.ts` に `actionTimeout` / 失敗時スクリーンショット、回答後の再評価完了待ち、各シナリオ開始時にホームへ戻る、draft 作成待ち 180 秒 |
| 5 | **Tauri シェルのサイドカー要求タイムアウトが全メソッド一律 120 秒**。再評価が 2 分を超えると GUI に `RUNNER_TIMEOUT` が出て結果を取りこぼす（実測: 147 秒の `draft.answer` で発生。最終ビルドの検証では再評価に約 4 分かかった） | 実利用で最も影響が大きい。GUI では承認に進めない | `sidecar.rs`: `draft.*` メソッドだけ 20 分（`DRAFT_REQUEST_TIMEOUT`）。他は 120 秒のまま。IPC メソッドの allowlist は不変 |

そのほか、配布版検証の 1 回で Requirements Agent（Claude CLI）が exit 1・stderr 空で異常終了し draft が BLOCKED になった（一時的な外部エラー。再実行で再現せず）。stderr が空のときに stdout の抜粋を理由に含める改善は未実施（残課題）。

## 5. Phase 5 自動テスト（順次実行）

| チェック | 結果 |
|---|---|
| Vitest（実 Docker 隔離 7 件含む） | **261 passed / 8 skipped**（LIVE 用）。新規: failure-diagnosis 5、generated 3（D-42）、verification-generated 1、draft-service 2、verification（install の下限）1 |
| Playwright（モック UI） | **31 passed**（新規 ui-17 2 件: 診断カードの表示 / 完了時は非表示）。Rust ビルドと同時実行したときだけ画面遷移の待ちで 1 件落ちたが、単独実行では 2 回とも全件 PASS |
| TypeScript（runner / tests / contracts） | クリーン |
| svelte-check | 0 errors / 0 warnings |
| Rust `cargo check` / `cargo test` | クリーン（`sidecar.rs` の draft.* タイムアウト変更を含む） |
| ESLint | クリーン |
| 受入テスト（`docs/ACCEPTANCE_REPORT.md`） | `pnpm acceptance` で再生成: **PASS 56 / FAIL 0 / NOT_RUN 0** |
| Docker 隔離テスト | Vitest に含む 7 件 PASS（read-only / 非 root / egress 遮断 / seccomp） |
| Policy Gate 回帰テスト | `policy-gate.test.ts` / `policy.test.ts` PASS（Vitest に含む）+ TEST-05 で実機確認 |

テストの削除・スキップ追加・品質ルールの緩和は行っていない（新規テストの追加のみ）。

## 6. Phase 6 リリース判定

未検証項目を PASS とは扱わない。判定は次のとおり。

| 判定 | 結論 | 根拠 |
|---|---|---|
| 内部利用可能 | **可** | 主要機能（ヒアリング → 承認 → 隔離実行 → 検証 → レビュー → 結果）を実 CLI と配布版 GUI の両方で確認。安全性（Docker 隔離 7 件の実測、Policy Gate の安全停止 TEST-05、egress 拒否の記録、元リポジトリ不変）を確認。自動テストに回帰なし |
| 限定 β 配布可能 | **可（未署名 RC として、社内検証に限定）** | インストーラ・サイレントインストール・Node / pnpm 非搭載環境での同梱サイドカー起動・実 CLI 動作・停止・再起動・アンインストールを最終ビルドで確認。初回サンドボックスセットアップは v0.1.0 で検証済み（今回は未再検証） |
| 一般公開可能 | **不可** | (1) コード署名が無い（SmartScreen 警告）。(2) クリーンな別 PC / VM での再現性が未検証（同一 PC のみ）。(3) 第三者による実利用が未実施。(4) ベースライン install が環境依存で 2〜5 分かかり、初回体験が不安定。(5) 製品バージョン文字列が 0.1.0 のまま |

一般公開に進む条件: コード署名（`docs/RELEASE.md` §3）、クリーン環境での検証（`docs/BETA_USER_TEST_PROTOCOL.md`）、外部テスター 2〜3 名の実利用、バージョン文字列とサンドボックスイメージラベルの一括更新。

## 7. 自動テストの最終結果とコミット

- Vitest 261 passed / 0 failed / 8 skipped、Playwright 31 passed、受入 PASS 56 / FAIL 0 / NOT_RUN 0、tsc / svelte-check / eslint / cargo check クリーン。
- 実 CLI の生データ: `test-results/dogfood/v022-*.json`（ローカルのみ）、配布版 GUI の記録: `.tmp/v022-gui*.log`、`.tmp/rc-v022-app-data`（ローカルのみ）。
- コミット: `3a7b11c`（実装・修正・検証記録）。本ドキュメントへのコミット SHA の追記はその直後のコミット。

補足: 配布版検証の終盤、本 PC の CPU 負荷が 100% のままで、モック Playwright の画面遷移を待つ 2 件（UI-08 / UI-14a）が時間切れで落ちた。原因は他の作業の負荷で、両スペックの待ち時間を既定値相当に広げたうえで全 31 件 PASS を確認した（品質ルールの緩和ではなく、テストの待ち時間の調整）。
