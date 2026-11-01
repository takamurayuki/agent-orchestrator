# β版検証レポート — v0.1.0（未署名）

実施日: 2026-11-01　対象: v0.1.0 公開準備版（`cc868cc`）＋ β検証で見つけた不具合の修正 2 件（本レポート §4、コミット `5ed0e51`）　実施者: 実装者（開発機 1 台）

## 1. クリーン環境検証（Phase 1）

| 項目 | 結果 |
|---|---|
| 新規 Windows VM での検証 | **未実施**。開発機に Hyper-V の cmdlet と仮想化支援はあるが、Hyper-V 機能の有効化と VM 作成には管理者権限が必要で、Windows のインストール ISO も手元に無いため、本セッションでは実施できなかった。別 PC も利用できなかった。以下はすべて**同一の開発機**での代替検証であり、別環境での再現性は未確認 |
| ツール導入前後の表示 | PATH を `C:\Windows\System32;C:\Windows` に限定（Node.js / pnpm / Git / Docker なし）して配布ビルドを起動: 同梱サイドカーが起動し、Git / Docker CLI が「失敗」＋修正方法、Claude / Codex CLI が「警告（サンドボックス内の版で実行）」、開始ボタン無効。通常 PATH（Node / pnpm を除外）では「実行可能」（RC 検証、`docs/RC_VERIFICATION.md`） |
| 最新 NSIS インストーラからの起動 | β修正後に再ビルドした `Agent Orchestrator_0.1.0_x64-setup.exe`（SHA-256 `55B4E4DC3D7B4969113B96CD2E0D30F7445E4636D298D98C31418AB9A28BC52A`）を `/S` でインストールして起動（§1b） |
| サンドボックスのキャッシュ無し構築時間 | ベースイメージを削除し、GUI と同じ引数で `docker build --no-cache`（一時タグ）: ベース取得 9 秒、egress プロキシ 9 秒、サンドボックス 270 秒（npm で Claude Code / Codex / pnpm を取得）、**合計 289 秒（約 4.8 分）**。ダイジェスト検証 OK。利用者の Docker ビルドキャッシュは消さずに測定した（GUI 経由の準備は同じ手順で、キャッシュありなら 39 秒） |
| GUI で自然言語入力から実タスク完了まで | 最終ビルド（Node / pnpm なし PATH、空の app-data）で、サンプルリポジトリに対し依頼入力 → 質問回答 → 要件サマリー承認 → 実行 → 結果まで **2.3 分で COMPLETED**（1 ラウンド、Builder 14.8 秒 / $0.04、検証 PASS、Codex approved、Policy Gate 0 件）。見出し「開発が完了しました（元のプロジェクトへの取り込みはまだです）」、元リポジトリは不変 |
| アンインストール時の残存データ | インストール先・レジストリ・スタートメニュー 0。app-data（履歴 DB・作業用コピー）と Docker イメージ 2 つは残る（設計どおり。ガイド §8 に削除方法を記載）。Docker のコンテナ / ボリューム / ネットワークは 0 |

## 2. 外部テスター向け準備（Phase 2）

- `docs/BETA_TESTER_GUIDE.md`: 平易な日本語の手順（事前準備・インストール・初回セットアップ・使い方・料金が発生する操作・既知の制限・トラブルシューティング・アンインストール）。未署名であることと SmartScreen の扱いを冒頭に明記。
- `docs/ISSUE_TEMPLATE.md`: 問題報告テンプレート（環境・再現手順・期待/実際・Run ID・添付・頻度。秘密情報を貼らない注意）。
- README から両方を参照。

## 3. 実用性評価（Phase 3）

`scripts/dogfood.mjs`（配布版と同じ runner コード）で、既存プロジェクトのコピー 2 つとサンプルリポジトリに対して小規模タスクを実行した。ヒアリングの回答は機械的（先頭の選択肢）。

| タスク | 対象 | 結果 | 人間の介入 | 時間 | 料金（Builder） | AI 承認後に人間が見つけた問題 |
|---|---|---|---|---|---|---|
| `beta-batontime-slug`（toSlug 追加） | batontime コピー | PRECHECK_FAILED（AI 未実行） | 質問 1（blocking） | 169 s | $0 | — |
| `beta-batontime-ranges`（overlaps / mergeRanges） | batontime コピー | PRECHECK_FAILED（AI 未実行） | 0 | 94 s | $0 | — |
| `beta-self-slack-token`（Slack トークンのマスキング） | 自リポジトリのコピー | 承認不可（禁止操作検出の偽陽性）→ **修正後に再実行**: NEEDS_HUMAN / MAX_ROUNDS（3 ラウンド、543 s、Builder $0.21）。Codex の指摘は妥当: コピー元の masking.ts に既存の汎用パターンがあり、追加パターンでは「19 文字は非マスク」の受入条件を満たせない。依頼と既存実装の衝突で人間の判断が必要 | — | 46 s | $0 | — |
| `beta-sample-greet-honorific`（greetFormal 追加） | サンプル | COMPLETED（1 ラウンド） | 質問 2（任意） | 172 s | $0.05 | なし（title が空白のみを未指定扱いにした解釈は妥当） |
| （参考）GUI 全フロー `greet` 空文字仕様 | サンプル | COMPLETED（1 ラウンド） | 質問 1〜2 | 3.1 分 | $0.12 | なし |

### 指標（本フェーズ）

| 指標 | 値 |
|---|---|
| 開発完了率 | Run 開始 4 件中 COMPLETED 1 件（25%）。内訳: PRECHECK_FAILED 2（環境要因、AI 未実行）、NEEDS_HUMAN 1（依頼と既存実装の衝突）、COMPLETED 1。AI が実行された 2 件では完了 1 / 要判断 1。参考: GUI 全フロー（§1）は COMPLETED |
| 人間の介入回数（blocking 質問への回答 + 停止判断） | タスクあたり平均 0.2（blocking 質問 1 件 / 5 タスク）+ 停止後の判断 3 件（PRECHECK_FAILED 2、NEEDS_HUMAN 1） 回（機械回答。PRECHECK_FAILED は「環境を直す」判断が 1 回必要） |
| 実行時間（ヒアリング + Run、完了したもの） | 約 3 分 |
| 利用料金（Builder 報告値、完了したもの） | $0.05〜0.12 / タスク |
| AI 承認後に人間が発見した問題 | 0 件（完了 1（+ GUI 全フロー 2 件） 件のレビュー） |
| 初回セットアップで迷った箇所 | ガイド整備時の自己評価: (1) Docker Desktop の WSL2 有効化と Claude / Codex のログインがアプリ外の作業である、(2) 「サンドボックスを準備する」が Docker 起動後にしか出ない（Docker 失敗中は先に Docker を直す必要がある）、(3) SmartScreen の警告 — ガイド §1〜2、§6 に記載 |

累積のドッグフーディング指標（v2.0〜β、`docs/QUALITY_REPORT.md`）: 16 タスク中 Run 開始 15、COMPLETED 8（53%）、NEEDS_HUMAN 4、PRECHECK_FAILED 3、承認前停止 1。平均 246 秒 / タスク、平均 1.33 ラウンド、Builder 費用合計 $1.31、レビュー unknown 0 / 16、元リポジトリ不変 全件、egress 拒否 128 / 許可 3,198 / エラー 0

## 4. 見つけた問題と分類（Phase 4）

| # | 重大度 | 内容 | 対応 |
|---|---|---|---|
| 1 | 中（実用性を損なう。GUI から回避不能） | 禁止操作検出 `EXTERNAL_POST` がサービス名（Slack / Teams / Discord / Twitter）だけで一致し、「Slack トークンをマスキング」のような実装依頼が承認不可になる偽陽性 | **修正**: サービス名の前後 40 文字以内に送信・投稿・通知を表す語がある場合だけ検出（`apps/runner/src/policy.ts`）。回帰テスト 7 件。「Slack に投稿する」等は引き続き検出 |
| 2 | 中（環境要因だが原因が伝わらない） | 依存パッケージが公開 24 時間未満だと pnpm 12 の `minimumReleaseAge` ポリシーでベースライン install が失敗し、理由文が「typecheck / lint / test:run が通る状態にして」としか言わない | **修正**: 既知の原因（minimumReleaseAge / ロックファイル不一致 / 通信エラー / タイムアウト）を理由文に診断して表示（`diagnoseBaselineFailure`、ポリシー自体は緩めない）。回帰テスト |
| 3 | 低（制限） | 別 PC / VM での検証未実施、未署名 | 既知の制限として明記。一般公開の前提条件 |
| 4 | 低（制限） | pnpm 以外のプロジェクトは対象外。`typecheck` / `lint` / `test:run` が無いと開始不可 | ガイドに明記 |

重大（セキュリティ・データ破壊・クラッシュ）に分類される未解決不具合: **なし**。

## 5. 自動テストとセキュリティ制約の確認

| チェック | 結果 |
|---|---|
| Vitest（`CI=1 RUN_DOCKER_TESTS=1`、実 Docker 隔離 7 件含む） | 209 passed / 1 skipped（LIVE 用ファイル、実 Docker 7 件含む） |
| Playwright | 26 passed |
| svelte-check / tsc / cargo check / eslint | クリーン |
| 受入レポート | PASS 56 / FAIL 0 / NOT_RUN 0 |
| セキュリティ制約（変更なしを確認） | コンテナ: `--user 1001`、`--cap-drop ALL`、`--security-opt no-new-privileges`、`--read-only`、tmpfs、pids / cpu / memory 制限、`--internal` ネットワーク + allowlist プロキシ、Reviewer は `:ro` + カスタム seccomp（D-22）。egress allowlist 既定 5 ホスト。runner が起動できるコマンドは `ALLOWED_COMMANDS`（git / docker / node / pnpm / tar / claude / codex / wsl）のみ。Policy Gate・完了ゲートは変更なし。β修正 2 件は検出精度と理由文のみ |

## 6. リリース判定

| 判定 | 結論 | 根拠 |
|---|---|---|
| **β版として配布可能か（社内・限定テスター、未署名）** | **可** | インストール〜初回セットアップ〜実タスク完了〜アンインストールを配布ビルドで実測。重大な未解決不具合なし。テスター向けガイド・報告テンプレート・トラブルシューティングを整備。未署名である旨と料金・データ送信の注意を明記 |
| **一般公開可能か** | **不可** | (1) コード署名未実施（SmartScreen 警告）、(2) 別 PC / VM での再現性未確認、(3) 外部テスターによる評価未実施、(4) 対応プロジェクトが Node + pnpm に限定 |

一般公開の前提: 署名、別環境での検証、β テスターのフィードバック反映、サンドボックスイメージの配布方法（現状はローカルビルド）の確定。
