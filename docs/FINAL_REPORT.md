# 最終レポート（実装済み / 未実装 / 実測済み / 未実測）

作成日: 2026-11-01（リリース準備フェーズ後に更新）　対象: `docs/SPEC.md` v2.0　受入結果: `docs/ACCEPTANCE_REPORT.md`（**PASS 56 / FAIL 0 / NOT_RUN 0**）

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
