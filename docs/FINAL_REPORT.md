# 最終レポート（実装済み / 未実装 / 実測済み / 未実測）

作成日: 2026-11-01（リリース準備フェーズ後に更新）　対象: `docs/SPEC.md` v2.0　受入結果: `docs/ACCEPTANCE_REPORT.md`（**PASS 56 / FAIL 0 / NOT_RUN 0**）

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
