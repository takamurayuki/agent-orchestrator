# リリース候補（RC）検証レポート — v2.3（未署名 RC）

実施日: 2026-11-01　対象コミット: `be0595d`（v2.3）＋ RC 検証で見つけた不具合の修正 1 件（本レポート末尾のコミット）　実施者: 実装者（同一 PC）

> 位置づけ: 署名鍵が無いため **未署名のリリース候補** として扱い、一般公開版とは区別する（`docs/RELEASE.md` §5）。配布先は社内検証に限定する。

## 1. 配布物

| 項目 | 値 |
|---|---|
| インストーラ | `apps/desktop/src-tauri/target/release/bundle/nsis/Agent Orchestrator_0.1.0_x64-setup.exe`（25.2 MB） |
| SHA-256（修正後の最終ビルド） | `008BA1224C00FF7DAB4AF7F8FF3FBE0005C3A3889A5E34F9D62DEA33A930C049` |
| 同梱サイドカー | `agent-orchestrator-runner.exe`（Node SEA、100.8 MB、Node v24.22.1 をベースに `scripts/build-sidecar.mjs` で生成） |
| 本体 | `agent-orchestrator-desktop.exe`（4.3 MB、Tauri 2 / WebView2） |
| コード署名 | **未署名**（`Get-AuthenticodeSignature` = NotSigned）。SmartScreen 警告の対象 |
| ビルド手順 | `node scripts/build-sidecar.mjs` → `pnpm --filter @agent-orchestrator/desktop exec tauri build`（Rust release 2 分 39 秒） |

初回ビルド（`be0595d` そのまま、SHA-256 `83c93a58…a7ce8`）で検証中に不具合（§4）を見つけたため、修正後に再ビルド・再インストールして停止・再起動の検証をやり直した。

## 2. インストール / 起動 / 初回環境チェック / アンインストール

クリーンな別 PC / VM は用意できなかったため、同一 PC 上で次の 2 条件を実測した。

| 手順 | 結果 |
|---|---|
| `setup.exe /S /D=<dir>` サイレントインストール | exit 0。`agent-orchestrator-desktop.exe` / `agent-orchestrator-runner.exe` / `uninstall.exe` の 3 ファイル。`HKCU\…\Uninstall\Agent Orchestrator`（0.1.0）登録 |
| **最小 PATH で起動**（`PATH=C:\Windows\System32;C:\Windows`、Node / Git / Docker なし、空の app-data） | 同梱サイドカーが起動（`[runner] ready v0.1.0`）。セットアップチェックは「✖ 実行不可：セットアップが必要です」。Git「失敗（spawn git.exe ENOENT）→ Git をインストールして PATH に追加」、Docker CLI「失敗 → Docker Desktop をインストールし起動」、Claude / Codex CLI「警告（サンドボックス内の版で実行）」、認証・app-data・ディスク・allowlist は正常。開始ボタン無効（LIVE-03b PASS）。スクリーンショット `.tmp/ux/rc-clean-env.png` |
| **Node 非搭載 PATH で起動**（通常 PATH から nvm / nodejs / npm / pnpm を除外、空の app-data） | サイドカー ready、environment.check / project.inspect 成功（smoke PASS） |
| アプリ再起動（プロセス kill → 再起動、同じ app-data） | 履歴 3 件が SQLite から復元され、中断した Run の結果画面を開ける（§3 RC-restart） |
| `uninstall.exe /S` | exit 0。インストール先ディレクトリ削除、レジストリ登録 0、スタートメニュー 0。app-data（利用者データ）は設計どおり残す |
| 後始末 | Docker コンテナ / ボリューム / ネットワークの残存 0 |

## 3. GUI 操作（配布ビルド ⇔ 同梱 Runner ⇔ 実 CLI、Playwright を WebView2 に CDP 接続）

専用サンプルリポジトリ `.tmp/sample-rc`（`tests/fixtures/make-sample-repo.mjs`）を対象に、`apps/desktop/e2e-live/gui-live.spec.ts` と新規 `gui-rc.spec.ts` を順次実行した。

| 項目 | 結果 |
|---|---|
| smoke（environment.check / project.inspect） | PASS |
| RC-error: 無効フォルダー（`C:\Windows\Temp`） | 「Git リポジトリではありません (not_git)」、原因・修正案・エラーコード `NOT_GIT_REPOSITORY` を表示し、開始ボタン無効（理由テキスト付き） PASS |
| 要件ヒアリング → 承認 → 実行 → 結果（LIVE-01 GUI） | PASS（2.5 分）。要件サマリーが先頭、YAML 非表示で承認。Run は 1 ラウンドで **COMPLETED**（Builder 20.9 秒 / $0.11、検証 4/4、Codex approved、Policy Gate 0 件、変更 `src/greet.ts` / `test/greet.test.ts`）。結果画面の見出し「開発が完了しました（元のプロジェクトへの取り込みはまだです）」、内部ステータスは折りたたみ内で `COMPLETED`。egress: 許可 316 / 拒否 8（`ab.chatgpt.com`、`*.oaiusercontent.com` のみ）。元リポジトリは不変 |
| RC-cancel: 実行開始直後に「実行を停止する」 | **1 回目: FAIL**（§4 の不具合。起動前検査中の停止が `PRECHECK_FAILED` になり「実行前の確認で止まりました（AI は実行していません）」と表示）。**修正後の再ビルドで PASS**: `INTERRUPTED / CANCELLED`、見出し「途中で止まりました」、注意「この結果は「完了」ではありません」、反映ボタンなし。スクリーンショット `.tmp/ux/rc-result-interrupted.png` |
| RC-restart: 再起動後の履歴復元 | PASS（履歴 3 件: COMPLETED / PRECHECK_FAILED（不具合再現分） / INTERRUPTED。中断した Run の結果と report.md を開ける）。`.tmp/ux/rc-history-after-restart.png` |

## 4. 見つけた不具合と修正（リリースを妨げるもののみ）

| # | 内容 | 影響 | 修正 |
|---|---|---|---|
| 1 | 起動前検査（Docker 隔離の実測プローブ）中に停止すると、プローブが「キャンセルされました」を `fail` として返し、エンジンが `PRECHECK_FAILED` で終了していた | 利用者の停止操作が「環境の問題」として記録・案内され、誤解を招く（結果画面が「環境を直して再実行」を促す） | `apps/runner/src/engine.ts`: preflight 完了後に `checkCancelled()` を評価し、キャンセルなら `INTERRUPTED / CANCELLED`。回帰テスト `engine.test.ts`「cancellation during preflight → INTERRUPTED」。配布ビルドを再作成して GUI で再確認（PASS） |

その他、GUI 検証用スペック `gui-live.spec.ts` を v2.3 の折りたたみレイアウトに合わせて更新し、`gui-rc.spec.ts`（error / cancel / restart）を追加した。機能追加は行っていない。

## 5. 自動テスト（順次実行）

Docker テストと Playwright を同時に走らせると vite の WebServer がメモリ不足で落ちることがあったため（v2.3 検証時）、順次実行した。

| チェック | 結果 |
|---|---|
| Vitest（`CI=1 RUN_DOCKER_TESTS=1`、実 Docker 隔離 7 件含む） | 201 passed / 1 skipped（LIVE 用ファイル） |
| Playwright（モック UI、`pnpm test:e2e`） | 22 passed |
| svelte-check | 0 errors / 0 warnings |
| TypeScript（runner / tests / live スペック） | 0 errors |
| cargo check | OK |
| ESLint | クリーン |
| 既存のセキュリティ制約 | Docker 隔離・egress allowlist・read-only reviewer・Policy Gate に変更なし。実 Docker テスト 7 件 PASS、実 Run でも隔離プローブ・allowlist 外の拒否を確認 |

## 6. 完了条件の判定

| 条件 | 判定 |
|---|---|
| Vitest 200 件以上 PASS | PASS（201 passed / 1 skipped = LIVE 用ファイル） |
| Playwright 22 件以上 PASS | PASS（22 passed） |
| TypeScript / Svelte / Rust / ESLint | 成功 |
| 最新インストーラの動作確認 | 成功（インストール・起動・初回環境チェック・GUI 全フロー・停止・再起動・アンインストール） |
| 既存のセキュリティ制約に回帰なし | 回帰なし |
| 検証レポート | 本書 |

## 7. 既知の制限（配布時に明記、README「既知の制限」と同じ）

- 未署名（SmartScreen 警告）。署名後に一般公開版とする。
- サンドボックスイメージ 2 つは配布物に含まれず、利用者がリポジトリで `pnpm sandbox:build` する必要がある。
- クリーンな別 PC / VM での検証は未実施（同一 PC で PATH 最小化・Node 非搭載の起動を実測）。
- 元プロジェクトへの反映機能は無い（作業用コピーの取り込みは利用者の Git ツールで行う）。
- 外部テスターによる操作性評価は未実施。
