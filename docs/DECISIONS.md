# 技術的決定事項（DECISIONS）

SPEC.md を唯一の要件ベースラインとし、契約の曖昧さ・不整合・環境制約に対して「安全な失敗」に倒した決定を記録する。各項目は **決定 / 理由 / 影響・対処** の順。

## D-01 隔離ワークスペースは `git worktree` ではなく「detached なローカル clone」

- **決定:** `git clone --local --no-hardlinks --no-checkout <repo> <app-data>/worktrees/<runId>` → `git checkout --detach <baseSha>` → `git remote remove origin` → `core.hooksPath=/dev/null`。
- **理由:** (1) `git worktree` は元リポジトリと refs を共有するため、Builder がワークスペース内で `git branch -f main` や `git checkout -B` を実行すると元リポジトリのブランチが動く（SPEC「元ブランチに触れない」「元リポジトリの HEAD 不変」に反する）。(2) worktree の `.git` はホストの絶対パスを指すファイルなので、コンテナ内で git が動かない。(3) remote を削除することで誤 push の経路を物理的に断つ。
- **影響・対処:** UI/レポートでは「ワークスペースの場所」として表示（SPEC の "worktree" に相当）。元リポジトリへの取り込みはユーザーが差分を見て手動で行う。統合テスト `workspace.test.ts` で元リポジトリの HEAD/status 不変を検証。

## D-02 egress 制限 = Docker `--internal` ネットワーク + allowlist CONNECT プロキシ

- **決定:** Run ごとに `docker network create --internal` を作成し、allowlist プロキシコンテナ（node:http、依存なし）だけを `bridge` にも接続。各ステップは `HTTPS_PROXY=http://egress-proxy:3128` を受け取る。allowlist 既定: `api.anthropic.com, api.openai.com, chatgpt.com, auth.openai.com, registry.npmjs.org`（`AGENT_ORCHESTRATOR_EGRESS_ALLOWLIST` で変更可）。
- **理由:** Docker 単体にはドメイン allowlist が無い。「制限のないネットワークを安全とみなさない」ため、技術的に閉じたネットワーク上でプロキシのみを出口にする。
- **影響・対処:** preflight でプロービングコンテナを実行し、(a) 直接通信が失敗、(b) allowlist 外は 403、(c) allowlist 内は 200、(d) read-only mount に書けない、(e) uid=1001 を**実測**する。いずれか失敗で `PRECHECK_FAILED`（SEC-01/02）。TLS は終端しないため、許可ホストへの通信内容は検査しない。DNS は internal ネットワークでも Docker 内蔵 DNS が解決する場合があるが、接続自体が到達不能であることを確認している。

## D-03 各ステップは使い捨てコンテナ（`docker run --rm`）、タイムアウトは `docker kill`

- **決定:** Builder / Verifier / Reviewer / Requirements Agent の各呼び出しを独立した `docker run --rm --init` で実行。非 root（1001）、`--cap-drop ALL`、`--security-opt no-new-privileges`、`--read-only` root、`--tmpfs /tmp`、`--tmpfs /home/agent`、`--pids-limit`、`--cpus`、`--memory`。Docker socket はマウントしない。ワークスペースは名前付きボリューム（D-18）。
- **理由:** `docker exec` でのプロセス停止はコンテナ内の子プロセスが残り得る。コンテナごと kill すれば子プロセス群を確実に停止できる（EX-12）。
- **影響・対処:** ステップ間で状態を共有しない（node_modules はワークスペース内に残るので再利用される）。

## D-04 Reviewer の read-only 保証は 2 層 + ハッシュ照合

- **決定:** Codex の `--sandbox read-only` に加え、ワークスペースボリュームを `readonly` でマウント（OS レベル拒否 SEC-03）。さらにレビュー前後の tree hash（一時 index + `git write-tree`、未追跡含む）を比較し、不一致なら `NEEDS_HUMAN`（完了ゲート 6）。

## D-05 認証情報の注入方法

- **決定:** Claude は `ANTHROPIC_API_KEY` / `CLAUDE_CODE_OAUTH_TOKEN` 環境変数、無ければ `~/.claude/.credentials.json` の OAuth accessToken を `CLAUDE_CODE_OAUTH_TOKEN` として渡す。Codex は `OPENAI_API_KEY`、無ければ `~/.codex/auth.json` を aux ボリュームの `CODEX_HOME=/aux/codex-home` に 0600 / uid 1001 で配置（Run 終了時にボリュームごと削除）。値はログ・イベント・レポートからマスキング（`masking.ts`）。
- **理由:** 認証の自動取得は対象外。設定済みの認証をそのまま使い、コンテナ内に永続化しない。
- **未検証:** 実 CLI がコンテナ内でこれらの認証を受け付けるかは LIVE テスト（`RUN_LIVE_E2E=1`）で実測が必要。本セッションでは実施していない（README「未検証事項」参照）。

## D-06 Builder の権限フラグ

- **決定:** `--permission-mode acceptEdits` + `--permission-prompts none` + `--allowedTools` allowlist（無制限 Bash なし）+ `--setting-sources user`（対象リポジトリの settings/hooks を読まない）+ `--disable-slash-commands --strict-mcp-config --no-session-persistence --max-budget-usd`。`--dangerously-skip-permissions` / `bypassPermissions` / Codex `danger-full-access` は argv 組み立て時に検査して拒否（SEC-08）。
- **理由:** SPEC 8.2。コンテナ隔離があっても CLI 側の権限は最小にする（多層防御）。
- **影響:** Claude Code 2.1.316 に `--max-turns` は無いため、上限は予算（USD）と cliTimeoutSeconds で与える。フラグの存在は `environment.check` で `--help` 出力と照合する。

## D-07 Requirements Agent はツール無し・リポジトリ非マウント

- **決定:** 決定的な `RepoInspector`（read-only、機密除外、上限付き）がダイジェストと facts を作り、モデルには `--tools ""` でダイジェストだけを渡す（`--json-schema` で構造化出力）。モデルはファイルを読まない。
- **理由:** モデルによる任意ファイル読取（.env 等）を構造的に不可能にする（RA-14、SEC）。README 等は `<untrusted_repository_content>` で囲み、指示ではなくデータとして扱う。
- **影響:** 深いコード理解が必要な場合は質問精度が落ちる。ダイジェストにはファイルツリー（最大 400）、package.json、設定ファイル、認証/テストのヒント、README 先頭 60 行を含める。

## D-08 task-proposal 契約の追加

- **決定:** `interview.schema.json` は `additionalProperties:false` で `facts/questions/blockingQuestions/summary` のみ。task.yaml の生成に必要な title / requirements / acceptanceCriteria（Given/When/Then）/ outOfScope / approach / openItems を得るため、`packages/contracts/schemas/task-proposal.schema.json`（Task Proposal v1）を追加し、2 回目のモデル呼び出しで要求する。
- **理由:** 既存契約を変更せず、承認画面の「目的/スコープ/対象外/実装方針/受入条件/不明事項」を構造化する。
- **影響:** repository / baseRef / verificationProfile / limits / review は Orchestrator が付与（モデルは決めない）。

## D-09 blocking 質問のスキップは即 `BLOCKED`、「戻る」で回復

- **決定:** blocking をスキップした時点で Draft を `BLOCKED` にし、理由に質問 ID を示す。`draft.answer({back:true})` で直前ラウンドに戻って回答できる。上限（5 ラウンド/15 問）到達時に blocking が残る（聞けていない blocking を含む）場合も `BLOCKED`。
- **理由:** SPEC 3.1-3「スキップは許可しても次へ進めず BLOCKED」。自動承認・推測確定をしない。

## D-10 承認後の編集は常に新 revision

- **決定:** `draft.revise` は現在の revision が承認済みか否かに関わらず新 revision を作り、承認フラグをリセット。承認済み revision は DB 制約（`updateRevision` が例外）で不変。task id は revision 間で維持。
- **理由:** RA-11/RA-12。進行中 Run が参照する `approved_tasks` スナップショットは影響を受けない。

## D-11 preflight の「Git clean」は fail

- **決定:** 元リポジトリに未コミット変更があれば `PRECHECK_FAILED`。
- **理由:** SPEC 9 の起動前検査に「Git clean」がある。clone は baseRef のコミット内容しか含まないため、未コミットの作業がある状態で実行するとユーザーの期待と実装対象が食い違う。
- **影響:** 修正方法（commit / stash）を表示。

## D-12 差分が空・ポリシー違反・Builder 異常終了は再試行せず `NEEDS_HUMAN`

- **決定:** `NO_CHANGES` / `POLICY_VIOLATION`（テスト削除・skip、検証設定の弱体化、禁止パス、worktree 外）/ `BUILDER_FAILED` / `BUILDER_TIMEOUT` は即 `NEEDS_HUMAN`。再試行は検証失敗と `changes_requested` のみ。
- **理由:** SPEC 6「CLI 異常終了、ポリシー違反 → NEEDS_HUMAN」。差分が無い状態での再試行は上限を浪費する。

## D-13 `approved` と blocking 指摘の併存は `REVIEW_INCONSISTENT`

- **決定:** verdict=approved でも critical/high 指摘または requirementsUnverified が残れば、完了ゲート 4/5 で不合格 → `NEEDS_HUMAN`（再試行しない）。
- **理由:** EX-07。レビュー出力の内容整合性が取れていないものを修正ループに回さない。

## D-14 永続化は `node:sqlite`（WAL）

- **決定:** better-sqlite3 等のネイティブ依存を避け、Node 22.13+ 組み込みの `node:sqlite` を使う。
- **理由:** サイドカー配布（Node SEA 等）でネイティブモジュールの同梱を避ける。
- **影響:** Node 22 では ExperimentalWarning が stderr に出る。`engines.node >= 22.13`。

## D-15 実行モードと WSL2

- **決定:** `EnvironmentAdapter` が `docker-desktop-windows` / `docker-wsl` / `docker-linux` / `unavailable` を判定。Windows では Docker Desktop（WSL2 バックエンド）経由でコンテナは WSL2 の Linux VM 内で動く。bind mount は Windows パスをそのまま渡す。
- **理由:** SPEC 2「Windows 上で Windows 用 CLI を直接実行しない。実行環境は WSL2 Linux 内の Docker コンテナ」。CLI（claude/codex/pnpm）はすべてコンテナ内のピン留め版を使う。
- **未検証:** WSL2 ディストリビューション内で runner を動かす構成（`docker-wsl`）は本セッションの WSL Ubuntu に Docker 連携が無く、実測していない。

## D-16 検証コマンドの `install` はネットワーク（egress allowlist 経由）を許可

- **決定:** `pnpm install --frozen-lockfile --ignore-scripts` のみ egress 許可（`registry.npmjs.org`）。typecheck / lint / test:run は `--network none`。
- **理由:** イメージに全プロジェクトの依存を事前インストールすることは不可能。`--ignore-scripts` で postinstall による任意コード実行を抑止する。
- **影響:** postinstall を必要とする依存（ネイティブビルド等）があるプロジェクトでは install が不完全になり得る。その場合 typecheck/test が失敗し `NEEDS_HUMAN` になる（fail-closed）。

## D-17 デスクトップ（Tauri）と runner の結合

- **決定:** Rust は IPC method allowlist を持ち、1 method = 1 Tauri command。Node サイドカーは開発時 `node apps/runner/dist/main.js --ipc stdio`。配布時の Node SEA サイドカーは設計のみで**未検証**（LIVE-03）。
- **理由:** SPEC 2・10.1。

## D-18 bind mount を使わず、名前付きボリューム + tar 同期でワークスペースを渡す

- **決定:** Run ごとに `workspace` / `aux` の名前付きボリュームを作成（root 作成後 uid 1001 に chown）。ホストのワークスペースはホスト側 `tar` → `docker run -i ... tar -x` で push し、Builder / Reviewer 実行後に逆方向で pull（ミラー。`node_modules` 等は除外）。補助ファイル（レビュー schema / 出力 / Codex 認証）は `docker cp` で aux ボリュームに出し入れする。
- **理由:** 本環境の Docker Desktop では Windows パスの bind mount が `stat /run/desktop/mnt/host/c/...: input/output error` で失敗することを実測した（`-v` / `--mount`、複数パス形式で再現）。環境依存の機能に依存すると fail-closed で何も動かなくなるため、どの Docker 構成でも成立するボリューム方式に統一した。副次効果として `pnpm install` の node_modules が Windows FS に書かれず高速。
- **影響・対処:** 差分・ハッシュはホスト側 git（pull 後）で計算。pull はホスト側ワークスペースを置き換えるミラー。GNU tar がコロン付きパスをリモート指定と解釈するため、tar には `cwd` で作業ディレクトリを与え argv にホストパスを出さない。実測: `tests/integration/docker-sandbox.test.ts`（RUN_DOCKER_TESTS=1）で push/pull・read-only・非 root・egress を確認済み。

## D-19 Claude Code `--json-schema` には `$schema` / `$id` を渡さない

- **決定:** Requirements Agent の構造化出力に渡すスキーマから `$schema`（draft 2020-12 URI）と `$id` を除いて渡す（`toClaudeJsonSchema`）。制約（type / required / additionalProperties / enum / maxItems）はそのまま。
- **理由:** LIVE-01 の実測で Claude Code 2.1.316 が `--json-schema is not a valid JSON Schema: no schema with key or ref "https://json-schema.org/draft/2020-12/schema"` で終了した（メタスキーマ URI を解決しない）。契約ファイル自体は変更しない。
- **影響・対処:** Orchestrator 側の検証（Ajv 2020 + Zod）は元のスキーマで行うので、受理条件は変わらない。回帰テスト `agents.test.ts`。

## D-20 Windows の npm CLI シム（.cmd）は shell:false で起動できない

- **決定:** ホスト側 CLI の存在・フラグ互換チェックでは、PATH 上の `<cmd>.cmd` を見つけたら同じ場所の `node_modules/<pkg>/...js` を `node` で直接実行する（`claude` → `@anthropic-ai/claude-code/cli.js`、`codex` → `@openai/codex/bin/codex.js`）。`.exe` も候補に含める。
- **理由:** Node 20.12 以降、`.cmd`/`.bat` の `spawn` は shell 無しだと `EINVAL`（CVE-2024-27980 対策）。シェル経由の起動は SEC-06（shell:false）に反するため採らない。
- **影響・対処:** 実行本体はコンテナ内のピン留め版なので、ホスト検出は warn 以上にならない。テスト用フィクスチャ（`make-sample-repo.mjs`）だけは固定引数で `shell:true` を使う。

## D-21 配布サイドカーは Node SEA（単一実行ファイル）

- **決定:** `scripts/build-sidecar.mjs` が runner を esbuild で 1 本の CommonJS にバンドルし、`node --experimental-sea-config` → `postject` で `node.exe` に注入、`apps/desktop/src-tauri/binaries/agent-orchestrator-runner-<triple>.exe` に配置する。Tauri の `bundle.externalBin` で同梱し、Rust は実行ファイルと同じディレクトリの `agent-orchestrator-runner(.exe)` を見つけたらそれを使う（無ければ開発モードの `node apps/runner/dist/main.js`）。
- **理由:** 利用者に Node のインストールを要求しない（SPEC §2）。`node:sqlite` が組み込みなのでネイティブモジュールの同梱が不要。
- **影響・対処:** JSON Schema は `src/schemas.generated.ts` に埋め込み、実行時にファイルを読まない。SEA 内では `import.meta.url` が使えないため version はバンドル時に埋め込む。`node:sea` の `isSea()` でエントリ判定。注入後の exe は元の署名が無効になる（配布時は再署名が必要）。

## D-22 Reviewer コンテナは「Docker 既定 seccomp + bubblewrap 用の最小 syscall」のカスタムプロファイルで動かす

- **決定:** Reviewer ステップ（Codex）のコンテナにのみ `--security-opt seccomp=<app-data>/sandbox/seccomp-reviewer.json` を付ける（`SandboxStep.allowUserNamespaces`）。プロファイルは Docker 既定プロファイル（moby/profiles `seccomp/default.json`）に、CAP_SYS_ADMIN 無しでも許可する syscall を **`unshare`, `clone`, `mount`, `umount2`, `pivot_root`** の 5 つだけ追加したもの。さらに引数で絞る: `clone` は既定の「namespace フラグ無し」許可を残したまま、追加許可は **`CLONE_NEWUSER` を含む呼び出しのみ**（`SCMP_CMP_MASKED_EQ`）、`unshare` は **namespace フラグ（NEWUSER/NEWNS/NEWPID/NEWIPC/NEWUTS/NEWNET/NEWCGROUP）以外のビットが立っていない呼び出しのみ**。`mount` / `umount2` / `pivot_root` の引数はポインタなので seccomp では絞れない。`scripts/derive-seccomp-profile.mjs` が候補 12 syscall を 1 つずつ外して実測し、この最小集合を導出した（`clone3`, `setns`, `chroot`, `sethostname`, `mount_setattr`, `open_tree`, `move_mount` は不要と判明）。`--cap-drop ALL`、`no-new-privileges`、非 root（1001）、read-only root、ワークスペースボリューム `readonly`、internal ネットワーク + egress プロキシ、レビュー前後のハッシュ照合はそのまま。Builder / Verifier / Requirements Agent には付けない。プロファイル内容は `isolation/seccomp-profile.ts` に埋め込み（SEA 同梱）、実行時に app-data へ毎回書き出す。プロファイルが無ければ fail-closed（例外）。
- **理由:** LIVE-01 の実測で、Codex `--sandbox read-only` が内部で使う bubblewrap が `bwrap: No permissions to create a new namespace` で失敗し、Codex はコマンドを 1 つも実行できず diff だけでレビューしていた。原因は Docker 既定 seccomp が `unshare`/`mount`/`pivot_root` を CAP_SYS_ADMIN 保持時のみ許可し、`clone` の namespace フラグをマスクで拒否していること（カーネル自体は非特権 user namespace を許可: `max_user_namespaces=63941`）。当初の暫定策 `seccomp=unconfined` は Docker が既定で遮断する約 40 の syscall（`bpf`, `keyctl`, `kexec_load`, `ptrace` の一部等）も開けてしまうため、必要な 5 つだけに狭めた。`--dangerously-bypass-approvals-and-sandbox` で Codex 側のサンドボックスを外す案は SEC-08 に反するため採らない。
- **残余リスク:** 非特権 user namespace 内で `mount`/`pivot_root` が使えるため、カーネルの userns 実装の脆弱性が攻撃面になる（capability は全て落ちており、書込先はワークスペース `:ro`、`/aux`、tmpfs のみ）。実測: `docker-sandbox.test.ts`（既定では bwrap 失敗、プロファイルでは成功、CapEff=0、hostname 変更不可）、実 Codex でコマンド実行成功・`/workspace` への書込は denied。

## D-23 Builder 実行前に「ベースライン検証」を行う

- **決定:** ワークスペース作成・同期の直後、Builder を呼ぶ前に検証プロファイル（install / typecheck / lint / test:run）を未変更のリポジトリに対して実行する（`verify.baseline.*` イベント、`rounds/0/verify.baseline.{json,log}`）。失敗したら `PRECHECK_FAILED`（理由にコマンド名を列挙）で停止し、AI を一度も呼ばない。
- **理由:** ドッグフーディングで、ネイティブ依存（postinstall が必要）や `prisma generate`（egress allowlist 外へのダウンロード）を含むプロジェクトは変更の有無に関係なく検証が失敗することが分かった。ベースラインを取らないと、AI の実装が原因なのか環境が原因なのか区別できず、修正ラウンド（最大 3 回分の Builder / Reviewer 費用）を浪費する。
- **影響・対処:** Run の所要時間が検証 1 回分（install 含む）増える。ベースライン失敗はプロジェクト側の修正（scripts、依存、allowlist 設定）を促すメッセージを出す。回帰テスト `engine.test.ts`（ベースライン失敗で Builder 0 回）。

## D-24 サンドボックス内の pnpm はバージョン切替を行わない

- **決定:** Verifier / Builder のコンテナ環境に `pnpm_config_manage_package_manager_versions=false`、`COREPACK_ENABLE_STRICT=0`、`COREPACK_ENABLE_AUTO_PIN=0` を設定し、イメージにピン留めした pnpm（12.9.1）をそのまま使う。
- **理由:** ドッグフーディング（batontime）で `package.json#packageManager: pnpm@9.12.0` を持つプロジェクトの `pnpm install` が、指定版のダウンロード（ホームは tmpfs、egress は allowlist）に失敗して `ERR_PNPM_ENGINE_BIN_MISSING` となり、ベースライン検証で停止した。
- **影響・対処:** プロジェクトが要求する pnpm 版と異なる版で lockfile を解釈する（lockfileVersion 9 系は互換）。非互換なら install が失敗し PRECHECK_FAILED で報告される。回帰テスト `verification.test.ts`。

## D-25 利用者リポジトリの状態確認は利用者の git 設定で行う

- **決定:** `isClean` / `currentBranch` / `headSha` は `GIT_CONFIG_NOSYSTEM` を付けずに実行する（ワークスペースの clone / diff / hash は従来どおりシステム設定を無視して LF のまま扱う）。
- **理由:** Git for Windows は `core.autocrlf=true` をシステム設定に持つ。システム設定を無視して `git status` を実行すると、CRLF でチェックアウトされた作業ツリーの全ファイルが「変更あり」に見え、preflight の「Git clean」が誤って失敗する（ドッグフーディング temporaid で実測。利用者側の `git status` はクリーン）。
- **影響・対処:** 利用者に見えている状態と一致する。回帰テスト `workspace.test.ts`（`GIT_CONFIG_SYSTEM` で autocrlf=true を与えても clean）。

## D-26 運用者設定でサンドボックスの install ポリシーを調整できる（既定は変更しない）

- **決定:** `AGENT_ORCHESTRATOR_PNPM_MIN_RELEASE_AGE=<分>` が設定されたときだけ、検証 / Builder コンテナに `pnpm_config_minimum_release_age` を渡す（数字以外は無視。固定キー CI 等は上書き不可）。egress allowlist（`AGENT_ORCHESTRATOR_EGRESS_ALLOWLIST`）とメモリ上限（`AGENT_ORCHESTRATOR_MEMORY`）も従来どおり運用者設定。
- **理由:** ドッグフーディングで、(a) pnpm 12 の supply-chain policy（公開から一定時間未満のパッケージを拒否）により、ホストでは承認済みの lockfile がサンドボックス内（承認キャッシュ無し）で `ERR_PNPM_LOCKFILE_...` 相当で拒否される（batontime）、(b) `prisma generate` が `binaries.prisma.sh` からエンジンを取得する（temporaid）、(c) 並列 typecheck がメモリ上限 4g で SIGKILL される（temporaid apps/web）ケースを確認した。いずれも AI ではなくプロジェクト/環境側の要件で、既定を緩めるのではなく運用者が明示的に設定して初めて有効になる。
- **影響・対処:** 設定値はイベント・レポートには出さない（秘密ではないが、環境依存）。README に設定方法を記載。回帰テスト `verification.test.ts`。

## 残課題（未実装 / 未実測）

- コード署名（署名鍵が無いため未実施。NSIS インストーラは作成・実測済み）。
- egress プロキシは TLS を終端しないため、許可ホストに対する通信内容の検査はしない。
- pnpm 以外のパッケージマネージャ用プロファイルは未提供（`node-pnpm` のみ）。
- 実 CLI で `changes_requested` → 修正 → `approved` に収束するケースは未観測（3 ラウンド実測は上限到達で NEEDS_HUMAN）。
