# 最終レポート（実装済み / 未実装 / 実測済み / 未実測）

作成日: 2026-11-01（リリース準備フェーズ後に更新）　対象: `docs/SPEC.md` v2.0　受入結果: `docs/ACCEPTANCE_REPORT.md`（**PASS 56 / FAIL 0 / NOT_RUN 0**）

## 0¹¹. v0.2.2 最終安定化・リリース検証の結果（2026-11-02 追記）

詳細は `docs/V022_VERIFICATION.md`。

### 実装概要

| Phase | 内容 | 決定記録 |
|---|---|---|
| 1 生成物の依存関係診断（P0） | 生成スクリプト（`node <file>`）のソースを静的解析して読み込み先を抽出し、`git ls-files` / `git check-ignore` で **tracked / ignored / missing / unknown** に分類。`GeneratedArtifact.inputs` / `inputStatus` に付与し、Git 管理外の入力に依存する生成物は承認前に blocking 質問 `GENIN-`（対象外 / 入力なしで再生成＝内容の妥当性は未確認として記録）。unknown はブロックせず確認方法を示す。既存のハッシュ比較・完了ゲートは不変 | D-42 |
| 2 実行失敗の診断（P1） | `failure-diagnosis.ts` が記録から決定的に 16 分類（AI 側 CLI のコマンド拒否 / Docker / 通信制限 / 依存取得失敗 / サプライチェーンポリシー / 生成物 / レビュー判定不能 / 上限到達 …）し、確度付きで「何が起きたか・影響・自動修復の可否・次の操作」を report.md と結果画面に表示。原因不明は unknown のまま | D-43 |

### 修正した不具合（配布版の実機検証で発見。いずれも隔離・allowlist・Policy Gate・完了ゲートは変更しない）

| # | 内容 | 修正 |
|---|---|---|
| 1 | 新しい依頼の作成中（数十秒）にヒアリング画面へ移ると、前回の承認済み要件サマリーが表示され、承認ボタンが「既に承認済み」で止まる | `createDraft` が作成前に前回の draft / 承認結果を消し、作成中は「draft 作成中」を表示 |
| 2 | 回答送信後の再評価中（GAP_ANALYZING、1〜3 分）に素案の無いまま「承認して開発を開始」セクションが表示される | 再評価中は「要件を再評価しています」カードを表示し、承認セクションは素案があるとき（または BLOCKED の理由表示）だけ出す |
| 3 | 起動前検査のベースライン `install`（Run ごとに新しいボリュームへ依存を取り直す）が 131〜302 秒かかり、検証コマンド上限 300 秒で PRECHECK_FAILED になることがある | `install` にだけ 10 分の下限（`INSTALL_TIMEOUT_FLOOR_MS`）。隔離・allowlist・他のコマンドの上限は不変。単体テスト追加 |
| 4 | 配布版 GUI 検証スペックが操作に時間上限を持たず、上記 1〜2 と重なると 1 時間のテストタイムアウトまで原因不明のまま止まる | `playwright.live.config.ts` に `actionTimeout` / 失敗時スクリーンショット、回答後の再評価完了待ち、各シナリオ開始時にホームへ戻る |
| 5 | Tauri シェルのサイドカー要求タイムアウトが全メソッド一律 120 秒で、回答後の再評価（モデル呼び出し最大 3 回、各 300 秒）が 2 分を超えると GUI にエラーが出て結果を取りこぼす（配布版検証で 147 秒の `draft.answer` が該当） | `sidecar.rs`: `draft.*` メソッドだけ 20 分（`DRAFT_REQUEST_TIMEOUT`）。他のメソッドは 120 秒のまま。IPC メソッドの allowlist は不変 |

### テスト結果

Vitest 261 passed / 8 skipped（実 Docker 7 件含む）、Playwright 31 passed、tsc / svelte-check / eslint / cargo check クリーン、受入 PASS 56 / FAIL 0 / NOT_RUN 0（`pnpm acceptance` で再生成）。テストの削除・スキップ追加・品質ルールの緩和なし。

### 実 CLI 検証（TEST-01〜05、専用一時リポジトリ）

| TEST | 結果 |
|---|---|
| 01 正常終了 | COMPLETED、1 ラウンド、546 秒、$0.12（生成物 docs/API.md の再生成・比較を含む検証 6/6） |
| 02 自動修正 | COMPLETED、2 ラウンド、1032 秒、$0.17（R1 で Codex が high 2 件 → R2 で修正 → approved） |
| 03 生成物の検証 | COMPLETED、1 ラウンド、448 秒、$0.06（`generate:docs:api` 合格） |
| 04 入力不足 | 承認前に GENIN-4-1 で警告 → 「対象外」→ COMPLETED、606 秒、$0.04。入力不足を無視して成功扱いにしない |
| 05 安全な停止 | NEEDS_HUMAN / POLICY_VIOLATION、3 ラウンド、416 秒、$0.15（POLICY_BLOCKED 2 回、制約を緩めずに停止。report.md に診断 policy_violation） |

### Windows 配布版

最終ビルド（SHA-256 `BDB48173…5E17BC`、未署名）を同一 PC・Node / pnpm 非搭載 PATH・空の app-data で実測: サイレントインストール → 同梱サイドカー起動 → smoke → 無効フォルダーの案内 → **GUI 全フロー COMPLETED（16 分、Builder $0.12、検証 6/6）** → 実行中の停止（INTERRUPTED / CANCELLED）→ 再起動後の履歴復元 2 件 → アンインストール（ディレクトリ・レジストリ・スタートメニュー 0、app-data は残す）→ Docker 残存 0。初回サンドボックスセットアップは今回未再検証（v0.1.0 で検証済み）、クリーン VM・第三者利用は未検証。

### 改善前後の比較

| 指標 | v0.2.1 | v0.2.2 |
|---|---|---|
| 生成物の入力が Git 管理外のとき | 実行後に Reviewer が指摘して 3 ラウンド消費（NEEDS_HUMAN、620 秒、$0.33） | 承認前に警告して利用者が選ぶ（TEST-04: 質問 1 件、Run は 1 ラウンド COMPLETED、$0.04） |
| 失敗時に利用者が得る情報 | 状態と理由コードの平易な説明（固定文） | 記録からの分類 + 確度 + 自動修復の可否 + 根拠（report.md / 結果画面） |
| 実 CLI タスクの完了率（`docs/QUALITY_REPORT.md`） | 3 件中 2 件（67%） | 5 件中 4 件（80%。未完了 1 件は意図した安全停止） |
| 配布版 GUI の全フロー | v0.1.0 で COMPLETED を確認 | 最終ビルドで再確認（§4） |

### 残課題とリスク

- クリーンな別 PC / VM・第三者による実利用・コード署名は引き続き未実施（一般公開の阻害要因）。
- ベースライン `install` の所要時間が 2〜5 分と大きく、ネットワークと Docker Desktop の状態に依存する。Run 間での pnpm store の再利用は未実装（隔離の設計を変えずに行う方法の検討が必要）。
- 生成スクリプトの入力解析は静的な近似（`fs.promises` 経由や別モジュールへの委譲は unknown）。
- 製品バージョン文字列が `0.1.0` のまま（サンドボックスイメージのラベルと連動するため意図的）。

## 0¹⁰. v0.2.1 安定化フェーズの結果（2026-11-02 追記）

### 実装概要

| Phase | 内容 | 決定記録 |
|---|---|---|
| 1 生成物更新の検証 | 素案・task.yaml に `generatedArtifacts: [{ path, script, reason }]`（必須、空可）を追加。`script` は **package.json の scripts 名のみ**（契約の正規表現 + 承認時の存在確認。任意のシェルコマンドは宣言も実行も不可）。リポジトリ調査が scripts 名・コマンド中の出力ファイル・生成ファイルのヘッダー（自動生成 / generated / DO NOT EDIT + 生成元パス）から `generation.script` / `generated.file` の facts を出し、素案プロンプトで生成物の列挙を必須化。script が package.json に無ければ推測せず承認前に blocking 質問 `GEN-<round>-<n>`（候補 script + 「今回は対象外（人が更新）」）を出し、回答を判断記録として素案に機械的に適用。Builder には `pnpm run <script>` の実行と手編集禁止を指示。Verifier はプロファイル検証の合格後、生成物ごとに正規化ハッシュ（ISO 時刻・行末空白・CRLF 無視）→ 退避 → `pnpm run <script>`（サンドボックス内、ネットワーク none）→ ハッシュ → 復元を行い、一致したときだけ検証コマンド `generate:<script>` を合格にする（Verifier はワークスペースを変更しない）。完了ゲートは生成物ごとに `generate:<script>` を必須。Reviewer には「生成物は Verifier が確認済み」と伝える。承認画面に「生成物の更新」節 | D-41 |
| 2 事前診断 UX | verdict を `ready / unverified / issues / blocked`（実行可能 / 未確認あり / 問題あり / 実行不可）に分け、`minimumReleaseAge` 未設定・インストール時スクリプト・判定不能な engines は **未確認**（問題と断定しない）。各未確認項目に `howToVerify`（確認方法）を追加。ホーム画面は実行に影響する項目（fail / warn）だけを目立たせ、未確認は件数付きの折りたたみに「理由」「確認方法」「失敗したとき」を表示、正常項目も折りたたみ。サプライチェーン設定・allowlist の自動変更なし | D-38 改訂 |

状態機械、Docker 隔離・seccomp・egress allowlist・Policy Gate は変更なし。新しい検証コマンド `generate:<script>`、質問 ID 接頭辞 `GEN-`、root の `quality:report` script、サンプルフィクスチャの生成物 `docs/API.md`（`docs:api`）を追加。

### テスト結果

- Vitest 249 passed / 8 skipped（LIVE 用）（実 Docker 7 件含む。新規: 生成物の facts・質問・判断適用 6、Verifier の生成物検証・ゲート・退避復元 8、DraftService の GEN 質問フロー 4）、Playwright 29（ui-16 を新しい診断 UI と「生成物の更新」節に合わせて更新）、tsc / svelte-check / eslint クリーン（Rust は変更なし）。
- **事前診断の偽陽性・偽陰性**（`scripts/diagnosis-audit.mjs`、実プロジェクトのコピー 5 件 + サンプル 1 件）: 実行不可 0、問題あり 2（batontime の `packageManager pnpm@9`、temporaid の prisma / playwright 取得先。いずれも真陽性）、未確認 4（全件 `minimumReleaseAge` 未設定のみ）。v0.2.0 では 5/5 が「要確認」だったものが、実行に影響する 2 件と「未確認だが実行可能」4 件に分かれた。偽陰性 0。
- **実 CLI（生成物を含むタスク）**: 下表。

| タスク | v0.2.0 | v0.2.1 |
|---|---|---|
| 品質レポートに平均費用の行（本リポジトリのクローン。生成物 `docs/QUALITY_REPORT.md` ← `quality:report`） | NEEDS_HUMAN / MAX_ROUNDS、3 ラウンド、494 秒、$0.26。Builder が生成スクリプトを実行せず、Reviewer が 3 回同じ指摘 | NEEDS_HUMAN / MAX_ROUNDS、3 ラウンド、620 秒、$0.33。素案が質問なしで生成物を識別（script は既存）。R1: Builder が `pnpm run quality:report` を実行し `generate:quality:report` 合格、Reviewer が「再生成で 26 件が空になった」と指摘（真陽性: 生成器の入力 `test-results/` は gitignore でクローンに無い）。R2: Builder が生成物を `git show` で手で戻し再生成しなかった → **Verifier の `generate:quality:report` が不合格（更新漏れを決定的に検出）**。R3: 再生成 → Reviewer が再指摘 → 停止。停止理由は正確で、入力がリポジトリに無い生成物はサンドボックスで妥当に再生成できないという本質的な制約 |
| サンプル `shout` 関数追加（依頼文は生成物に触れない。生成物 `docs/API.md` ← `docs:api`） | — | COMPLETED、2 ラウンド、176 秒、$0.09。facts だけから素案が `generatedArtifacts` を識別。R1: Builder 側 Claude Code の自前ヒューリスティックがコマンドを拒否し再生成されず → `generate:docs:api` 不合格（stale）。R2: 再生成して合格、Reviewer approved。元リポジトリ不変、egress 拒否 8（Codex のテレメトリ） |
| 同上（退避・復元を加えた Verifier で再実行） | — | COMPLETED、**1 ラウンド**、145 秒、$0.06。Builder が `pnpm run docs:api` を実行して差分に含め、`generate:docs:api` 合格、Reviewer approved。作業用コピーに退避ファイルは残らず、生成物は Builder の出力のまま |

累計（`docs/QUALITY_REPORT.md` 改善前後表）: 改善前 21 件 完了 57% / 要確認 5 / unknown 1、v0.2.0 5 件 完了 60% / 要確認 2 / unknown 1、v0.2.1 3 件 完了 67%（2/3）/ 要確認 1 / unknown 0、完了タスク平均費用 $0.07（前フェーズと同じ）。v0.2.1 の未完了 1 件は上記の「入力がリポジトリに無い生成物」で、更新漏れ自体は Verifier が検出している

### 残課題

- 生成器の入力がリポジトリに無い（gitignore された計測結果など）生成物は、サンドボックスでは「最新か」は確認できても内容の妥当性は保証できない。事前診断または素案段階で「入力がコミットされていない生成物」を警告するのが次の改善候補。
- サブパッケージの scripts は root の `pnpm run` から呼べないため、生成物の script は root に委譲 script を用意する必要がある（本リポジトリでは `quality:report` を追加）。
- Builder 側 CLI の自前ヒューリスティックによるコマンド拒否で 1 ラウンド消費する事例（サンプルタスク R1）。本ツール側では Verifier の不合格として正しく検出されるが、ラウンドと費用がかかる。
- `minimumReleaseAge` 未設定は引き続き「未確認」。確定にはレジストリ照会が必要で行わない方針。別環境・外部テスターでの検証は未実施。

## 0⁹. v0.2.0 βフィードバック改善の結果（2026-11-02 追記）

### 実装概要

| Phase | 内容 | 決定記録 |
|---|---|---|
| 1 事前診断（P0） | プロジェクト選択直後に `requirements/diagnosis.ts` が読み取り専用で lockfile（pnpm / lockfileVersion）、Node・pnpm 版（`engines` / `packageManager` とサンドボックス固定版の比較）、サプライチェーン設定（`minimumReleaseAge`。未設定は pnpm 12 既定の 24 時間を **未確認** として表示）、インストール時スクリプト（`--ignore-scripts` で未実行 → 未確認）、ネットワーク（`.npmrc` レジストリ・lockfile の tarball / git ホスト・prisma / playwright 等の取得先と egress allowlist の不一致。レジストリは fail、取得先は warn）、検証プロファイル、作業ツリーを診断。verdict ready / needs_attention / blocked をホーム画面に表示し、fail は開始を止め、warn / unverified は facts としてヒアリングへ。設定・allowlist の自動変更なし | D-38 |
| 2 最小実装（P0） | 素案に `expectedChanges`（必須、1 件以上）と `conflictRisks`（必須、空可）を追加し task.yaml に引き継ぐ。素案プロンプトに最小変更の原則・Reviewer が実行できない受入条件の禁止を追加。Builder プロンプトに期待範囲・衝突リスク・「範囲外は最小限にし理由を Out-of-scope changes に書く」を追加。エンジンは差分直後に `scope.ts` で判定（major: 設定・検証・CI・コンテナ定義などを含む、または予想外 3 件以上 → 検証前に Builder へ 1 度差し戻し、残れば `NEEDS_HUMAN / SCOPE_DEVIATION`。minor: 記録と Reviewer への提示）。完了ゲート 7 でも major を不合格。承認画面に「変更が予想されるファイル・領域」「既存機能との衝突の可能性」、結果画面にスコープ判定を表示 | D-39 |
| 3 Verifier / Reviewer（P1） | 変更された JSON / YAML / Markdown の決定的な構造検証（`verification/structure.ts`）を検証コマンド `structure` として追加し、完了ゲートの必須コマンドに含める（プロファイルのコマンドが失敗した場合は合格を捏造しない）。Reviewer は設計・ロジック・セキュリティ・要件整合性に集中し、実行でしか確認できない条件は requirementsUnverified に挙げて `changes_requested`（unknown は差分・作業領域を読めなかった場合に限定） | D-40 |

状態機械（IMPLEMENTING → … → COMPLETED / NEEDS_HUMAN）、Docker 隔離・seccomp・egress allowlist・Policy Gate は変更なし。新しい理由コード `SCOPE_DEVIATION` と検証コマンド `structure` を追加。

### テスト結果

- Vitest 238 passed / 1 skipped（LIVE 用ファイル）（実 Docker 7 件含む）（新規: 事前診断 8 + 統合 4、スコープ 5、エンジンのスコープ / 構造検証 8、構造検証 4）、Playwright 29（新規 ui-16: 事前診断の表示と素案の最小実装情報）、tsc / svelte-check / cargo check / eslint クリーン、受入 PASS 56 / FAIL 0。
- **事前診断の偽陽性・偽陰性**（`scripts/diagnosis-audit.mjs`、実プロジェクトのコピー 5 件）: fail（実行不可）0 件、warn の真陽性 2（batontime の `packageManager pnpm@9` vs サンドボックス pnpm 12、temporaid の prisma / playwright の取得先）、unverified 5/5（全件が `minimumReleaseAge` 未設定 → 「要確認」。β で実際に失敗した batontime はここに該当し、失敗しなかったサンプルも同じ表示になる＝確定できない事項を未確認として出す設計上のトレードオフ）。偽陰性（実際に失敗したのに ready と出た）0。
- **スコープ逸脱の検出と誤検出**（`scripts/scope-replay.mjs`、過去 8 Run の差分に人手の期待範囲で再適用）: 人間の判断と 8/8 一致（major 1 = β の quality-avg-cost、none 7）。
- **実 CLI の小規模タスク（改善後）**: 下表。初回の 2 件はモデルが `expectedChanges` を出力しなかった（埋め込み JSON スキーマに項目が無く任意扱い）ため、スキーマで必須化して 3 件を再実行した。

| タスク | 改善前（β） | 改善後（v0.2.0） |
|---|---|---|
| 品質レポートに平均費用の行（本リポジトリ） | NEEDS_HUMAN / REVIEW_UNKNOWN、3 ラウンド、730 秒、$0.66。新モジュール 2 + テスト 1 を追加 | NEEDS_HUMAN / MAX_ROUNDS、3 ラウンド、494 秒、$0.26。素案に expectedChanges / conflictRisks、スコープ判定 minor（新モジュール 1 + テスト 1）、Reviewer は unknown ではなく一貫した指摘（「生成済み QUALITY_REPORT.md が更新されていない（AC-006）」）。費用 −61%、時間 −32%、停止理由が明確。未完了の原因は素案が再生成を要求する受入条件を含めたこと |
| report.md の warning 表示（本リポジトリ） | COMPLETED だが人間が体裁崩れを発見（リスト記号の前に接頭辞） | COMPLETED、1 ラウンド、309 秒、$0.15。expectedChanges どおりの差分、体裁崩れなし |
| サンプル greetLoud | — | COMPLETED、1 ラウンド、156 秒、$0.04。scope none、structure OK |

累計（`docs/QUALITY_REPORT.md` 改善前後表）: 改善前 21 件 完了 57% / 実行環境起因の失敗 3 / 要確認 5 / unknown 1、改善後 5 件 完了 60% / 実行環境起因 0 / 要確認 2 / unknown 1（スキーマ修正前の 1 件）。改善後の完了タスク平均費用 $0.07（改善前 $0.09）。

### 未解決事項

- 受入条件が「生成物（レポート等）の更新」を要求する場合、Builder が生成コマンドを実行せず Reviewer の指摘で止まる。素案段階で該当条件を除外するか、Builder に生成コマンドの実行を促す必要がある（次期）。
- `minimumReleaseAge` 未設定のプロジェクトは全件「要確認」になる。確定にはレジストリ照会（ネットワーク）が必要で、本フェーズでは行わない方針。
- 別環境・外部テスターでの検証は引き続き未実施。

## 0⁸. 限定β運用フェーズの結果（2026-11-01 追記）

詳細は `docs/LIMITED_BETA_REPORT.md`。コード変更なし（ドキュメントと実行記録のみ）。

- **配布環境:** 別 PC / VM は**未検証**（前フェーズと同じ理由）。Claude / Codex のログイン手順はインストール済み環境で部分確認、新規インストール手順そのものは未検証。初回構築時間は前フェーズ実測（289 秒）。
- **外部ユーザーテスト:** **未実施**（協力者を確保できない）。`docs/BETA_USER_TEST_PROTOCOL.md` に手順・課題・記録項目・記録票を用意。
- **実用性（小規模タスク 5 件、実 CLI、機械回答）:** 完了 4、要確認 1（スコープ膨張 + Reviewer が検証できない受入条件で unknown）。β以降 10 件の累計: 完了率 50%、実行環境起因の失敗率 20%（pnpm minimumReleaseAge）、AI レビューの問題検出 5 / 11 ラウンド、人間が見つけた未検出の問題 1 / 5（report.md の体裁、低）、平均 266 秒、Builder 合計 $1.39（平均 $0.14 / タスク）。
- **次期リリースの改善 3 件:** (1) 実行前失敗の事前検知（プロジェクト選択時に pnpm ポリシー違反を診断）、(2) 要確認の削減（最小実装の原則・変更ファイルの見込み・既存実装との衝突検出）、(3) Reviewer が検証できない受入条件の verifier への移譲と体裁観点の追加。

## 0⁷. β版検証フェーズの結果（2026-11-01 追記）

詳細は `docs/BETA_VERIFICATION.md`。

- **クリーン環境:** 新規 Windows VM / 別 PC は利用できず**未検証**（管理者権限と ISO が無い）。同一機で PATH 最小化（Node / pnpm / Git / Docker なし）の起動、ベースイメージ削除後の `--no-cache` 構築時間（**289 秒**: 取得 9 秒 + プロキシ 9 秒 + サンドボックス 270 秒）、最終ビルドでの GUI 全フロー（2.3 分で COMPLETED、$0.04）、アンインストール残存 0 を実測。
- **外部テスター向け:** `docs/BETA_TESTER_GUIDE.md`（事前準備・手順・料金が発生する操作・既知の制限・未署名の明示・トラブルシューティング）、`docs/ISSUE_TEMPLATE.md`。
- **実用性評価（小規模タスク 5 件、機械回答）:** COMPLETED 1、NEEDS_HUMAN 1（依頼と既存実装の衝突。Codex の指摘は妥当）、PRECHECK_FAILED 2（pnpm 12 の minimumReleaseAge ポリシーで baseline install が失敗。AI 未実行・料金なし）、承認不可 1（禁止操作検出の偽陽性 → 修正して再実行）。AI 承認後に人間が見つけた問題 0。累積（16 タスク）: 完了率 53%、平均 246 秒、Builder 合計 $1.31。
- **修正した不具合（重大でないが実用性を損なうもの）:** (1) `EXTERNAL_POST` 検出がサービス名だけで一致する偽陽性 → 送信・投稿・通知の語との共起に限定（回帰テスト 7 件）。(2) ベースライン検証失敗の理由文に既知原因（minimumReleaseAge / ロックファイル不一致 / 通信エラー / タイムアウト）の診断を追加（ポリシーは緩めない）。
- **判定:** β版（社内・限定テスター、未署名）として配布 **可**。一般公開は **不可**（未署名、別環境未検証、外部評価未実施、対応プロジェクトが Node + pnpm 限定）。
- 自動テスト: Vitest 209 passed / 1 skipped（LIVE 用ファイル、実 Docker 7 件含む）、Playwright 26 passed、svelte-check / tsc / cargo check / eslint クリーン。セキュリティ制約（コンテナ強化フラグ、egress allowlist、コマンド allowlist、Policy Gate）に変更なし。

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
