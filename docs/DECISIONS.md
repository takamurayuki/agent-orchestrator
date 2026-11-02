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

## D-27 レビュー前ハッシュは検証後の状態から取り、.gitignore 対象は差分・ハッシュに含めない

- **決定:** (1) VERIFYING の後、REVIEWING の前にワークスペースをホストへ再同期（pull）してからレビュー前ハッシュを計算する。(2) 差分・ハッシュ用の一時 index は `git add -A`（`--force` なし）で作り、`.gitignore` 対象のファイルは含めない。
- **理由:** ドッグフーディング（自己リポジトリ）で、Builder がテストを実行して `test-results/vitest.json`（gitignore 対象）を書き、その後の検証ステップが同ファイルを更新したため、検証前の状態から取った「レビュー前ハッシュ」と、レビュー後に同期した状態のハッシュが不一致になり `WORKSPACE_MODIFIED_DURING_REVIEW` と誤判定した。Reviewer は書いていない。ハッシュ照合は「レビュー中に変更が無いこと」の検証なので、両ハッシュは同じ同期状態を基準にしなければならない。また .gitignore で除外されたファイルはプロジェクトが成果物と宣言したものではなく、差分に含めると Reviewer にノイズを与える。
- **影響・対処:** Run あたり pull が 1 回増える（数秒）。未追跡だが ignore されていないファイルは従来どおり差分・ハッシュに含む（EX-11）。回帰テスト `engine.test.ts`（pull 3 回の順序）、`workspace.test.ts`（ignore 対象が差分・ハッシュに影響しない）。

## D-28 AI へのプロンプトは argv ではなく stdin で渡す

- **決定:** Builder（`claude -p`：プロンプト引数なしで stdin を読む）、Requirements Agent（同）、Reviewer（`codex exec -`）のプロンプト本文を `SandboxStep.stdin` で渡し、`docker run -i` 経由でコンテナに流す。argv にはフラグとシステムプロンプトだけを載せる。spawn 失敗（`spawnError`）は Builder では `isError`、Reviewer では `parseError` として明示する。
- **理由:** ドッグフーディング（自己リポジトリ）で、差分に大きな JSON が含まれたレビュー用プロンプトを argv に載せたところ、Windows の `docker` クライアント起動時に argv 長制限（約 32 KB）で spawn が失敗し、2 ms で `exitCode=null` の結果が返ってレビューが「不正 JSON」扱いになった。失敗の原因が結果に現れず診断に時間がかかった。
- **影響・対処:** プロンプト長の上限が実質なくなる（Codex 側のコンテキスト上限は別）。回帰テスト `agents.test.ts`（argv にプロンプト本文が無い、stdin に含まれる、spawn 失敗はエラー）。

## D-29 Policy Gate（v2.1）: AI レビューと独立した静的ポリシーチェック

- **決定:** 各ラウンドの差分取得直後に `policy-gate.ts` を実行する。対象は 8 ルール（新規 eslint-disable、新規 @ts-ignore/@ts-nocheck、テストの skip/only/todo 追加、テストファイル削除、必須検証 scripts の削除・無効化・変更、tsconfig の strict 系緩和・exclude 追加、ESLint ルールの off 化・格下げ・ignores 追加、Vitest/Jest/Playwright の除外追加・passWithNoTests）。判定はベースコミットの内容と作業ツリーの内容を**内容の多重集合**で比較し、既存の違反・移動は数えない。コメント・テスト構文・設定ファイルは TypeScript コンパイラ API（スキャナ / AST）で解析し、文字列内の一致は無視する。検出結果は `ruleId / file / line / evidence / message / approved` を持ち `rounds/<n>/policy.json` と `policy.gate` イベントに記録する。
- **運用:** 未承認 blocking があれば検証・レビューを行わず Builder に差し戻す（残試行があれば。無ければ `NEEDS_HUMAN / POLICY_VIOLATION`）。完了ゲート 7 でも未承認 blocking を不合格にするため、Reviewer の `approved` では上書きできない。例外は**ベースコミット**の `.agent-orchestrator/policy.json`（`{"allow":[{"ruleId","file"(glob),"reason"}]}`）からのみ読み、作業ツリー側（= AI が今回の Run で書いた内容）は無視する。従来の regex ベースの差分ポリシー（`policy.ts`）はセキュリティ系（worktree 外・禁止パス）だけを残し即時停止とする。
- **理由:** ドッグフーディングで Builder が依頼と規約の矛盾を `eslint-disable-next-line` で回避し、Codex がそれを指摘せず approved になった（人間レビューと唯一不一致）。AI 同士の合意に依存しない機械的なゲートが必要。regex では文字列内の一致や既存違反の再検出で偽陽性が出るため AST を使う。
- **影響・対処:** TypeScript が runner の実行時依存になる（SEA バンドルが約 9 MB 増）。偽陽性・偽陰性の調査結果は `docs/QUALITY_REPORT.md` に記録。回帰テスト `policy-gate.test.ts`、`engine.test.ts`。
- **実機で見つけた偽陰性と修正:** 初版は `ts.createScanner().scan()` のループでコメントを集めていたが、テンプレートリテラルの `${}` 以降を素の scanner は正しく字句解析できず、`return \`...${x}...\`; // eslint-disable-line no-restricted-syntax` という**行末コメント**を取り逃がして Run が COMPLETED になった（v2.1 実 CLI 検証 1 回目）。パーサ駆動（全ノード/トークンの leading / trailing comment range）に変更し、回帰テストと `scripts/policy-gate-audit.mjs` の再実行で検出を確認した。

## D-30 Requirements Agent の矛盾検出と意思決定ログ（v2.1）

- **決定:** 素案（TaskProposal）確定後、承認前に 3 回目のモデル呼び出し「矛盾検出」を行う（`contradiction.schema.json`: `id / kind(requirement_vs_requirement | requirement_vs_project) / severity(blocking | minor) / description / evidence / options(2 件以上) / recommendation`）。入力は要件・受入条件・facts・ダイジェスト・既回答・既決定。`RepoInspector` は ESLint ルール（error / off、`no-restricted-*` のメッセージ、ignores）と tsconfig の strict 系フラグを facts に加え、要件と既存設定の矛盾を検出可能にする。blocking の矛盾は `CONTRA-<id>` の blocking 質問（選択肢 = options、根拠付き）として次ラウンドで提示し、解消されるまで承認できない（スキップは BLOCKED）。回答は意思決定ログ（SQLite `decisions`、`tasks/<id>/revisions/<rev>/decisions.json`、DraftView.decisions）に記録し、次回の矛盾検出には「既決定」として渡して再提示しない。minor は素案の openItems に追記する。モデル出力が不正・失敗なら BLOCKED（RA-15 と同じ fail-closed）。
- **理由:** ドッグフーディングで、依頼（「必ずテンプレートリテラル」）とプロジェクト規約（lint で禁止）の矛盾がヒアリングで検出されず、Builder が `eslint-disable` で回避した。矛盾は人間が判断すべき事項であり、推奨値で隠さず選択肢として提示する（SPEC §3.3）。
- **影響・対処:** ヒアリングのモデル呼び出しが 1 回増える（約 30〜60 秒）。質問上限（5 ラウンド / 15 問）は矛盾質問にも適用し、超えれば BLOCKED。回帰テスト `draft-service.test.ts`（ケース 9 / 10、スキップ、戻る、minor、不正出力）、`gap-analyzer.test.ts`、`repo-inspector.test.ts`。

## 残課題（未実装 / 未実測）

- コード署名（署名鍵が無いため未実施。NSIS インストーラは作成・実測済み）。
- `HTTP_PROXY` を無視するツール（Prisma のエンジン取得など）は allowlist に入れても到達不可。透過プロキシが必要。
- 依頼とプロジェクト規約の矛盾（lint 規則など）をヒアリング段階で検出しない。Builder の `eslint-disable` 追加を差分ポリシーが警告しない。
- egress プロキシは TLS を終端しないため、許可ホストに対する通信内容の検査はしない。
- pnpm 以外のパッケージマネージャ用プロファイルは未提供（`node-pnpm` のみ）。
- モノレポの並列 typecheck がメモリ上限で SIGKILL され得る（運用者がメモリ上限を上げるか並列度を落とす）。

- コード署名（署名鍵が無いため未実施。NSIS インストーラは作成・実測済み）。
- egress プロキシは TLS を終端しないため、許可ホストに対する通信内容の検査はしない。
- pnpm 以外のパッケージマネージャ用プロファイルは未提供（`node-pnpm` のみ）。
- 実 CLI で `changes_requested` → 修正 → `approved` に収束するケースは未観測（3 ラウンド実測は上限到達で NEEDS_HUMAN）。

## D-31 Policy Gate は TypeScript コンパイラ API だけで判定し、判定不能は不合格にする（v2.2）

- **決定:** (1) ソースの解析は `ts.createSourceFile` のパーサ駆動（コメント範囲は全ノード・トークンの leading / trailing、テスト構文は AST、設定は `parseConfigFileTextToJson` / AST）に限定し、**正規表現によるソース解析への置換を禁止する**（ファイル名・script 文字列の分類など、ソース本文以外に限り regex を使う）。(2) 構文エラー（`parseDiagnostics`）のあるファイルは `PG-UNPARSEABLE`（blocking、「判定不能」）を出した上で、可能な範囲で解析を続ける。JSONC 設定が解釈できない場合も `PG-UNPARSEABLE`。(3) 検出器自身が例外を投げたファイルは `PG-ANALYSIS-ERROR`（blocking）とし、成功扱いにしない（fail-closed）。
- **理由:** v2.1 で scanner ループの実装がテンプレートリテラル以降の行末コメントを取り逃がした（D-29 追記）。regex では文字列・正規表現リテラル・JSX テキストとコメントを区別できず、偽陽性・偽陰性の両方が出る。不完全なコードや検出器のバグで「検出 0 件」になると、それが「違反なし」と区別できないため、判定不能は明示して人間に渡す。
- **検証:** `policy-gate.test.ts` v2.2 群 — テンプレートリテラル内、正規表現リテラル（`/\/\/ eslint-disable/`）、JSX 式コンテナ内のディレクティブ（検出）と JSX テキスト（非検出）、複数行ブロックコメント、CRLF の行番号、Unicode（日本語・絵文字・サロゲートペア）、構文エラーのあるコード（`PG-UNPARSEABLE` ＋可能な範囲の検出）、設定の JSON 破損。偽陽性チェックとして、このリポジトリの runner の全ソース・テスト（30 ファイル超）を「新規ファイル」として評価し 0 件を確認する回帰テストを常設。
- **影響:** 構文エラーを含む差分は Builder に差し戻される（修正可能なフィードバック）。既存の JSDoc 風 `/** \n * eslint-disable */` は ESLint のディレクティブではないので検出しない。

## D-32 意思決定ログを共通モデルに統一し、新しい判断を優先する（v2.2）

- **決定:** `DecisionRecord` を `topicKey / source(interview | contradiction | revision) / kind / question / options / chosen / chosenLabel / rationale / consequence / evidence / relatedRequirements / decidedAt / history[] / supersededBy / status(active | retracted | superseded)` に統一する。通常質問の回答（source=interview、topicKey=質問 ID）、矛盾質問の回答（contradiction、topicKey=矛盾 ID、対象要件は保留中の素案から根拠文で照合）、承認前の要件修正（revision、topicKey=`revision:<field>`、旧値を consequence に記録）をすべて記録する。同じ topicKey の再判断は `history` に積み、「戻る」は削除ではなく `retracted`。素案生成・矛盾検出には `active` な判断だけを「拘束力のある判断（古い→新しい、後の判断が優先、revision は最新の明示的指示）」として渡し、再質問しない。
- **矛盾する判断の検出:** (1) 同じ問い（正規化した質問文）に異なる回答、(2) 同じ対象要件集合に異なる判断は、新しい方を優先し古い方を `superseded`（`supersededBy` と履歴 note 付き）にする。(3) 判断同士の意味的な矛盾は矛盾検出モデルに報告させ（プロンプトで判断 ID を根拠に書かせる）、ユーザーの解消（CONTRA- 回答）が根拠で名指しした判断を superseded にする。解消した側が常に新しい判断として扱われ、古い判断が新しい明示的指示を上書きすることはない。
- **理由:** v2.1 では矛盾回答しか記録されず、通常質問の判断や承認前の修正が YAML 再生成時に失われ得た。判断の出所・理由・履歴が無いと、後から「なぜこの要件になったか」を追えない。
- **互換:** SQLite の `decisions` テーブルは変更せず（`contradiction_id` 列が topicKey を保持、`decision_version=2`）、v2.1 形式の行は読み出し時に持ち上げる。`decisions.json` は status と history を含む。
- **検証:** `decisions.test.ts`（モデル・履歴・取り消し・矛盾判定・持ち上げ・拘束判断の文面）、`draft-service.test.ts`（通常回答の記録、戻る→retracted→再回答で履歴、revision の記録、拘束判断が propose に渡る、decisions.json、矛盾解消による superseded）。

## D-33 Policy Gate の差し戻しは明示的な POLICY_BLOCKED 状態を経由し、フィードバックを成果物に残す（v2.2）

- **決定:** 未承認 blocking があるラウンドは `IMPLEMENTING → POLICY_BLOCKED` に遷移してから次ラウンドの `IMPLEMENTING` に戻る（上限到達なら `POLICY_BLOCKED → NEEDS_HUMAN`）。Builder に渡したフィードバック（検証失敗・レビュー指摘・ポリシー違反）は `rounds/<n>/feedback.json` に保存し、`builder.started` イベントに `hasFeedback / feedbackKinds` を含める。
- **理由:** v2.1 は差し戻しを `IMPLEMENTING` のまま続行していたため、UI・ログから「ポリシーで差し戻された」ことが読み取れず、Phase 2 の実測条件（指摘が Claude Code に渡ったことのログ証跡）を満たせなかった。
- **影響:** 契約 `RUN_STATES` に `POLICY_BLOCKED` を追加（UI ラベル「ポリシー違反で差し戻し中」、実行画面では「実装」ステップに差し戻し表示）。`engine.test.ts` の遷移列を更新。

## D-34 検証 scripts の変更は「無効化・弱体化＝blocking」「追加・強化＝warning」「判定不能＝blocking（人間の承認）」に分類する（v2.2）

- **決定:** `PG-VERIFY-SCRIPT` は変更を機械的に分類する。削除・no-op 化（`echo` / `true` / 空）は blocking。旧コマンド全体が新コマンドに含まれ `&&` / `;` で別コマンドが追加された、または厳格化フラグ（`--max-warnings 0`、`--strict`、`--noEmit`、`--frozen-lockfile`、`--coverage`、`--run`、`--bail` 等）だけが追加された場合は「強化」として **warning**（完了は妨げないが内容を提示）。それ以外（`eslint .` → `eslint src`、`--passWithNoTests` の追加など）は強化と機械的に判断できないため blocking とし、人間がベースコミットの `.agent-orchestrator/policy.json` に例外を登録しない限り通さない。AI（Builder / Reviewer）はいかなる経路でも例外を承認できない。
- **理由:** v2.1 は検証 scripts のあらゆる変更を blocking にしていたため、正当な強化（自リポジトリのコミット c91bd00）も差し戻された。一方で `eslint src` のような対象の縮小は「弱体化」だが文字列からは安全に判定できないので、安全側（人間の承認）に倒す。
- **検証:** `policy-gate.test.ts` v2.2 Phase 4（分類・warning の内容提示・unknown は blocking・例外で通過）。

## D-35 UI は Runner の状態を変えずに「平易な説明」へ変換する（v2.3）

- **決定:** 結果・進捗の表示は `apps/desktop/src/lib/outcome.ts` の純粋関数（`describeOutcome` / `describeActivity` / `severityImpact`）で state・reasonCode・イベントを平易な日本語（見出し・原因・変更の状態・次にできること）に変換する。バックエンドの状態遷移・reasonCode・nextActions は変更しない（nextActions は「技術者向け」として折りたたみに残す）。元プロジェクトへの反映機能は未実装のため、反映ボタンは表示せず、GUI から安全な操作（変更内容を見る / 作業用コピーのパスをコピー / 新しい依頼）だけを出す。実行画面は AI 出力・コマンド出力の生ログを表示せず、イベント要約でも `excerpt / raw / stdout / stderr / output / log / prompt / result` 系のフィールドは「[非表示 N 文字]」に伏せる。
- **理由:** v2.2 の UX レビュー（P0: 次の手動操作が CLI 前提、P1: 承認画面の長さ・進捗の不透明さ）。状態機械や Policy Gate を UI の都合で緩めない、という制約の下で、表示層だけで改善する。
- **検証:** モックに `mockRun=needs_human|precheck_failed` と終了 Run の sessionStorage 永続化を加え、`ui-11-14.spec.ts` で COMPLETED / NEEDS_HUMAN / PRECHECK_FAILED の表示、承認前後の遷移と再承認、進捗の「現在の処理」、リロード後の履歴を検証。既存の Playwright 13 件は維持（折りたたみ化に伴う locator の調整のみ）。

## D-36 サンドボックスイメージは GUI から固定手順で取得・ビルドし、ダイジェスト／ラベルで検証する（v0.1.0 公開準備）

- **決定:** `docker/manifest.json` にバージョン・ベースイメージ（タグ）・ベースイメージのダイジェスト・作成するイメージを固定する。runner は `docker/` のビルドコンテキストを `apps/runner/src/sandbox/assets.generated.ts` に埋め込み（`scripts/gen-sandbox-assets.mjs`、runner build で生成）、IPC `sandbox.setup`（`acknowledgePull: true` 必須）で次の固定手順だけを実行する: `docker info` → `docker pull <base>@<digest>` → `RepoDigests` にダイジェストが含まれることを検証 → 一時ディレクトリに書き出したコンテキストで `docker build --pull=false --build-arg NODE_IMAGE=<base>@<digest> --label version --label base-digest` × 2 → ビルド結果のラベル検証（不一致は `docker rmi` して失敗）。進捗は `sandbox.progress` イベント、`sandbox.cancel` で中止。セットアップチェック（environment.check）も毎回ラベルを照合し、不一致は `fail`（使用しない）。配布版でも開発版でも同じ手順（`scripts/build-images.mjs` も manifest を使う）。
- **理由:** 配布版にはリポジトリが無く、`pnpm sandbox:build` を要求すると非 CLI 利用者がインストール直後に詰まる。レジストリへのイメージ公開は未実施なので、ピン留めしたベースイメージからローカルでビルドする。外部取得はユーザーの明示的な同意の後だけ行う。
- **安全性:** 任意のシェルコマンド実行は追加しない（docker の固定引数のみ、`ALLOWED_COMMANDS` の範囲内）。Docker 隔離・seccomp・egress 制御は変更なし。ダイジェスト不一致・ラベル不一致は fail-closed（停止し、原因と復旧方法を表示）。
- **検証:** `sandbox-setup.test.ts`（同意なしで何も実行しない、固定手順と引数、ダイジェスト不一致で停止、ビルド失敗の原因・復旧、ラベル不一致で rmi、キャンセルと再試行、二重起動拒否）、Playwright `ui-15.spec.ts`（成功 / 検証失敗と再試行 / ビルド失敗 / キャンセル）、配布ビルドでイメージ無しから GUI だけで準備して実タスク完了（`docs/RC_VERIFICATION.md`）。

## D-37 「作業用コピーのフォルダーを開く」は worktrees 配下に限定した固定コマンドで実装する（v0.1.0 公開準備）

- **決定:** Tauri コマンド `reveal_worktree(path)` は、`<app-data>/worktrees`（または `AGENT_ORCHESTRATOR_WORKTREES`）配下の既存ディレクトリに正規化後のパスが含まれる場合だけ、OS のファイルマネージャー（Windows: `explorer.exe <path>`）をシェルを介さず起動する。それ以外は拒否。元プロジェクトへの反映（コミット・push）機能は実装しない。
- **理由:** 結果画面からワークツリーを確認する手段がパスのコピーだけでは非 CLI 利用者に不十分（UX レビュー P0）。一方で UI から任意のパスやコマンドを開く能力は与えない。

## D-38 プロジェクト事前診断は読み取り専用で、判断できない項目は「未確認」として示す（v0.2.0）

- **決定:** プロジェクト選択時（ヒアリング前）に `apps/runner/src/requirements/diagnosis.ts` が、ファイル一覧とテキスト読み取りだけで次を診断する: lockfile（pnpm / lockfileVersion）、Node / pnpm のバージョン（`engines` / `packageManager` とサンドボックスの固定版 node 22.23.4 / pnpm 12.9.1 の比較）、サプライチェーン設定（`minimumReleaseAge`。未設定なら pnpm 12 既定の 24 時間が適用される旨を **unverified** で表示）、インストール時スクリプト（`--ignore-scripts` で実行されない旨を unverified）、ネットワーク（`.npmrc` レジストリ・lockfile の tarball / git ホスト・prisma / playwright 等の取得先と egress allowlist の不一致。レジストリ不一致は fail、取得先は warn）、検証プロファイル、作業ツリー。判定は ready / needs_attention / blocked。fail は problems に載せて開始を止め、warn / unverified は facts としてヒアリングに渡す。設定の自動変更・allowlist の自動拡張は行わない。
- **理由:** β運用で実行環境起因の失敗（pnpm の minimumReleaseAge、prisma の取得先）がヒアリングと承認の後の起動前検査で初めて分かった。依存解決（ネットワーク）を伴う確認は行わないため、確定できないことは「未確認」と明示し、PASS に見せない。
- **実測:** `scripts/diagnosis-audit.mjs` を実プロジェクトのコピー 5 件に適用（`test-results/diagnosis-audit.json`、`docs/FINAL_REPORT.md` 0⁹）。
- **トレードオフ:** `minimumReleaseAge` 未設定のプロジェクトはすべて「要確認」になる（実際に失敗するかは公開日時次第）。開始は妨げない。

## D-39 最小実装の原則とスコープ判定（v0.2.0）

- **決定:** 素案（TaskProposal）に `expectedChanges`（変更が予想されるファイル・領域）と `conflictRisks`（既存機能との衝突の可能性）を加え、task.yaml に引き継ぐ。素案プロンプトは「要件を満たす最小の変更」「Reviewer が実行できない受入条件を書かない」を指示し、Builder プロンプトは期待範囲と「範囲外の変更は最小限にし理由を Out-of-scope changes に書く」を指示する。エンジンは差分取得直後に `scope.ts` で判定し、`RoundRecord.scopeCheck` と `scope.checked` イベントに記録する。major（設定・検証・CI・コンテナ定義など影響の大きいファイルを含む、または予想外が 3 件以上）は検証・レビューを行わず Builder に 1 度返し、残れば `NEEDS_HUMAN / SCOPE_DEVIATION`。完了ゲート 7 でも major を不合格にする。minor（1〜2 件の通常ファイル）は記録して Reviewer に渡すだけ。`expectedChanges` が無い task は判定しない（互換）。
- **理由:** β運用の要確認 2 件は「依頼より大きな実装（新モジュール追加）」と「既存実装との衝突」。範囲を承認時に固定し、逸脱を機械的に検出して人間の判断に回す。状態機械は変えない（IMPLEMENTING のまま次ラウンドへ、または NEEDS_HUMAN）。
- **実測:** `scripts/scope-replay.mjs` で過去 8 Run の差分に適用し、人間の判断と 8/8 一致（`test-results/scope-replay.json`）。

## D-40 Verifier と Reviewer の役割整理（v0.2.0）

- **決定:** 自動実行できる検証は Verifier 側へ: 変更された JSON / YAML / Markdown に対する決定的な構造検証（`verification/structure.ts`: 解釈可能、コードフェンスの閉じ、リスト記号の前に文字が付いた行）を検証コマンド `structure` として結果に加え、完了ゲートの必須コマンドに含める（プロファイルのコマンドが失敗した場合は構造検証を行わず、合格を捏造しない）。Reviewer には設計・ロジック・セキュリティ・要件整合性を中心に評価させ、「コマンド実行でしか確認できない条件は requirementsUnverified に挙げる（推測で合格にしない）」「期待範囲外の変更・不要な抽象化を指摘する」を明示。unknown は従来どおり NEEDS_HUMAN（fail-closed）。
- **理由:** β運用で Reviewer が「ドキュメント再生成を検証できない」として unknown を返した事例と、AI 承認後に人間が見つけた Markdown の体裁崩れ。
- **補足（v0.3、Python 実機検証で発見）:** Reviewer への指示文「You cannot run commands」は、Codex が read-only サンドボックス内でのファイル読み取り（cat / grep 等）まで控える結果になり、「既存コードと流儀を合わせる」など既存ファイルとの比較が必要な受入条件を 3 ラウンド続けて requirementsUnverified に挙げて `NEEDS_HUMAN` になった（ワークスペースの変更ファイル以外は差分に含まれないため）。指示を「読み取り専用のシェルコマンドでワークスペースのファイルを読んでよい。プロジェクトのコード（script / パッケージマネージャ / テスト / 生成スクリプト / インタプリタ / ネットワーク）は実行しない」に改めた。隔離（ワークスペース :ro、Codex `--sandbox read-only`）は変えていない。

## D-41 生成物の更新は「package.json の script 名」で宣言し、Verifier が再生成して比較する（v0.2.1）

- **決定:** 素案（`TaskProposal`）と task.yaml に `generatedArtifacts: [{ path, script, reason }]`（必須、空配列可）を追加する。`script` は **既存の package.json の scripts 名だけ**を受け付け（契約で `^[A-Za-z0-9_:.@/-]+$`、承認時に存在確認）、任意のシェルコマンドは宣言も実行もできない。リポジトリ調査は scripts 名・コマンド中の出力ファイル・生成ファイルのヘッダー（自動生成 / generated / DO NOT EDIT と生成元スクリプトのパス）から `generation.script` / `generated.file` の facts を出す。素案の script が package.json に無い場合は推測で進めず、承認前に blocking 質問 `GEN-<round>-<n>`（候補 script + 「今回は対象外（人が更新）」）を出し、回答は判断記録として素案へ機械的に適用する（script の差し替え、または生成物を外して outOfScope に記録）。Builder には「`pnpm run <script>` を実行し結果をそのまま含める。手で編集しない」と指示する。Verifier はプロファイルの検証がすべて通った後に、生成物ごとに固定の node スクリプトで正規化ハッシュ（ISO 時刻・行末空白・CRLF を無視）を取り、`pnpm run <script>` をサンドボックス内（ネットワーク none、workspace rw）で実行して再度ハッシュを取り、一致したときだけ検証コマンド `generate:<script>` を合格にする。完了ゲートは生成物ごとに `generate:<script>` の結果を必須とする。Reviewer には「生成物は Verifier が確認済み」と伝え、再生成の要求を指摘にしない。
- **理由:** v0.2.0 の実測で、受入条件が「docs/QUALITY_REPORT.md を再生成する」ことを要求し、Builder がスクリプトを実行せず Reviewer の指摘で 3 ラウンド止まった（NEEDS_HUMAN / MAX_ROUNDS）。生成物の更新は AI の読解では確認できず、決定的に再生成して比較する必要がある。一方で、生成手段を AI が推測してシェルコマンドを実行するのは「任意のシェルコマンド実行機能を追加しない」制約に反するため、allowlist に相当する package.json の scripts に限定し、不明なら人に尋ねる。
- **トレードオフ:** 入力がリポジトリに無い生成物（gitignore された計測結果から作るレポート等）は、サンドボックスでは入力なしの状態で再生成されるため「最新かどうか」は確認できても内容の妥当性は保証できない。サブパッケージの script は root から呼べないため、root に委譲 script を用意する必要がある。

## D-42 生成スクリプトの入力依存は Git の追跡状態で分類し、管理外なら承認前に利用者に選ばせる（v0.2.2）

- **決定:** リポジトリ調査で、生成スクリプト候補（package.json の `node <file>` コマンド）のソースを静的に解析し、fs 呼び出しの引数（文字列リテラル、`join(...)`、`'dir/' + x`、代入された識別子）から読み込み先と書き込み先を分ける。読み込み先は `git ls-files`（追跡）/ `git check-ignore`（.gitignore）/ それ以外（未追跡または存在しない）で **tracked / ignored / missing** に分類し、動的に決まるパスは **unknown** とする（推測で埋めない。git にはシェルを介さず引数で渡す）。結果は素案・task.yaml の `generatedArtifacts[].inputs` と `inputStatus`（ok / missing / unknown）に付与する（モデルの出力ではなく調査結果で上書き）。`missing` の生成物は承認前に blocking 質問 `GENIN-<round>-<n>`（「対象外にする（人が入力のある環境で更新）」/「入力なしで再生成する（最新性のみ検証、内容の妥当性は未確認として記録）」）を出し、`unknown` は facts と承認画面の注記にとどめてブロックしない。Verifier の合格メッセージ・Builder / Reviewer への指示・承認画面で「最新性の確認」と「内容の妥当性」を区別して示す。既存のハッシュ比較と完了ゲートは変更しない。
- **理由:** v0.2.1 の実測で、`docs/QUALITY_REPORT.md` の生成器が gitignore された `test-results/` を読むため、隔離ワークスペースでは入力なしで再生成されて 26 件のデータが空になり、3 ラウンド消費して NEEDS_HUMAN になった。入力不足は実行前に静的に分かるので、承認前に警告して利用者に選ばせる。
- **トレードオフ:** 静的解析は保守的な近似で、`fs.promises` 経由や別モジュールに委譲された読み込みは unknown になる。unknown を「確認済み」と誤判定しないことを優先し、確認方法（生成スクリプトが読むファイルが Git 管理下か確認する）を示す。

## D-43 実行失敗の診断は記録からの決定的な分類とし、原因不明は unknown のまま示す（v0.2.2）

- **決定:** `failure-diagnosis.ts` が Run の状態・理由コード・最終ラウンドの検証コマンド（名前・終了コード・出力抜粋）・Builder の結果抜粋・Reviewer の判定・egress 集計から、失敗を **builder_command_denied（AI 側 CLI のコマンド拒否） / docker_error / network_blocked / dependency_fetch_failed / supply_chain_policy / generated_artifact / review_undecidable / limit_reached / verification_failed / policy_violation / scope_deviation / builder_failed / no_changes / precheck / cancelled / unknown** に分類し、確度（confirmed: 記録の決定的な証拠 / inferred: テキスト照合 / unknown）を付ける。利用者には「何が起きたか」「開発結果への影響」「自動修復可能か（yes / no / unknown と理由）」「次に取る操作」を日本語で、レポート（report.md）と結果画面に表示する。次の操作に「権限を広げる」「隔離・allowlist・ポリシーを緩める」は含めない。
- **理由:** β〜v0.2.1 の実測で、停止理由が「レビュー上限」「生成物が古い」「AI 側 CLI がコマンドを拒否した」「サプライチェーンポリシー」など異なるのに、利用者には同じ NEEDS_HUMAN としか見えず、次の操作を判断できなかった。AI に原因を要約させると推測が混じるため、構造化された記録だけから決定的に分類する。

## D-44 検証プロファイルは lockfile から決め、pnpm / npm / yarn 1 を同じ安全条件で扱う（v0.3）

- **決定:** `node-pnpm` に加えて `node-npm`（`package-lock.json` / `npm-shrinkwrap.json`、`npm ci --ignore-scripts --no-audit --no-fund`）と `node-yarn`（`yarn.lock` の Yarn 1 形式、`yarn install --frozen-lockfile --ignore-scripts --non-interactive`）を追加する。プロファイルはリポジトリ調査で lockfile から決め（優先順 pnpm → yarn → npm）、task.yaml に固定する。どのプロファイルも「lockfile 固定 + インストール時スクリプト無効 + package.json の typecheck / lint / test:run」という同じ条件で、任意コマンドは実行しない。script の実行（検証・生成物の再生成・Builder への指示）は `<pm> run <script>` をプロファイルから組み立てる。npm / yarn のキャッシュは pnpm store と同様にワークスペースボリューム内（`.npm-cache` / `.yarn-cache`、同期から除外）。Yarn 1 の lockfile は `registry.yarnpkg.com`（npm レジストリのミラー）を参照し、`--registry` を付けてもこの URL から取得するため、既定の egress allowlist にこのホストを追加する。Yarn 2+（Berry）と bun は未対応として事前診断で「実行不可」と理由・対処を示す（Berry は corepack による取得と yarnpkg への通信許可が必要で、別途判断する）。
- **理由:** 利用者から「pnpm 以外のプロジェクトでは実行不可になる」との指摘。本ツールは環境を問わず開発を支援することが目的で、サンドボックスイメージ（node:22）には npm 10 と yarn 1.22 が同梱済みのため、イメージを変えずに対応できる。
- **トレードオフ:** pnpm の minimumReleaseAge のような公開からの経過時間によるサプライチェーン保護は npm / yarn 1 には無い（事前診断でも項目を出さない）。lockfile に固定した版だけを入れる点は同じ。

## D-45 Python は uv / pip の 2 プロファイルで対応し、検証ツールは宣言された依存からだけ決める（v0.3）

- **決定:** `python-uv`（`pyproject.toml` + `uv.lock`、`uv sync --frozen` → `uv run --frozen --no-sync <tool>`）と `python-pip`（`requirements.txt`、`python3 -m venv .venv` → `.venv/bin/python -m pip install --no-input -r requirements*.txt` → `.venv/bin/python -m <tool>`）を追加する。プロファイルはファイルから決め（`package.json` があれば Node を優先、次に `uv.lock`、次に `requirements.txt`）、task.yaml に固定する。検証コマンドは **依存に宣言されたツールだけ** から組み立てる: lint は ruff（無ければ flake8）、test は pytest、typecheck は mypy か pyright（どちらも無ければ `python -m compileall -q .` の構文チェック）。lint / test のツールが依存に無いプロジェクトは「実行不可」とし、推測で別のツールを入れたり実行したりしない。上書きと生成物の script は `pyproject.toml` の `[tool.agent-orchestrator.scripts]` に書き、値は許可されたツール名（python / python3 / ruff / mypy / pyright / pytest / flake8 / black / isort / pylint / bandit / coverage）で始まるものだけを受け付ける（シェル経由では実行しない。許可外は「実行不可」として理由を示す）。サンドボックスイメージに Debian 付属の Python 3（bookworm は 3.11）、pip / venv、uv を同梱し、`requires-python` がサンドボックスの版を許すかを事前診断で判定する。Policy Gate には Python 向けの規則を追加する: 新規の `# noqa` / `# type: ignore` / `# pyright: ignore`（`PG-PY-NOQA` / `PG-PY-TYPE-IGNORE`）、テストの `skip` / `xfail` 追加（`PG-PY-TEST-SKIP`）、テストファイル削除（既存の `PG-TEST-DELETED`）、`pyproject.toml` / `ruff.toml` / `mypy.ini` / `pytest.ini` / `setup.cfg` / `tox.ini` / `pyrightconfig.json` / `.flake8` の検証ツール設定の緩和（`ignore` / `exclude` / `per-file-ignores` / `addopts --deselect` / `ignore_errors` 等は blocking、他の変更は warning、`PG-PY-CONFIG-RELAXED`）。行単位の保守的な検出で、文字列内の一致は数えない。uv / pip のキャッシュと `.venv` はワークスペースボリューム内（同期から除外）。既定の egress allowlist に `pypi.org` と `files.pythonhosted.org` を加える。
- **理由:** 利用者から「他言語にも対応」の要望。Python はフロント / バックエンドを問わず利用が多く、uv の lockfile（`uv.lock`）は Node の lockfile と同じ「固定した版だけを入れる」条件を満たす。pip は lockfile が無いが `requirements.txt` の `==` 固定を事前診断で確認（未固定は警告）すれば同じ運用ができる。
- **トレードオフ:** Node の `--ignore-scripts` に相当する抑止が無く、wheel の無い依存は sdist のビルド（`setup.py` 等）が隔離コンテナ内で実行される（事前診断で「未確認」として確認方法を示す。隔離・egress 制限は同じ）。poetry / pdm / pipenv の lockfile と conda は未対応（事前診断で「実行不可」）。サンドボックスの Python は 1 版（3.11）に固定で、複数版のテストはできない。typecheck の既定は構文チェックに留まる（型検査は mypy / pyright を依存に加えたときだけ）。

## D-46 サンドボックスの版は「固定版」か「最新版」を利用者が選び、入った版をイメージに記録して環境チェックで更新を知らせる（v0.3）

- **決定:** サンドボックスのベースイメージ（node:22 bookworm-slim）と同梱ツール（Claude Code / Codex / pnpm / uv）の版について、`pinned`（マニフェストに固定したダイジェストと版。既定）と `latest`（取得時点の浮動タグ `node:22-bookworm-slim` と各ツールの `latest`）の 2 方針を用意し、GUI の「サンドボックスを準備する / 更新する」で利用者が選ぶ（開発環境では `pnpm sandbox:build --policy latest`）。`latest` でも、取得したベースイメージのダイジェストを読み取って `FROM <tag>@<digest>` でビルドし、ラベル（`dev.agent-orchestrator.base-digest` / `version-policy` / `built-at`）と `/etc/agent-orchestrator/versions.json`（node / pnpm / npm / yarn / claudeCode / codex / python / uv と方針・取得日時）に記録する。環境チェックはイメージのラベルで検証方法を切り替え（pinned: マニフェストのダイジェストと一致 / latest: 記録されたダイジェストがある）、`versions.json` を `--network none` のコンテナで読んで同梱版を表示し、ホストから npm レジストリに `npm view <pkg> version` で最新版を問い合わせて、新しい版があれば latest 方針では警告（更新を促す）、pinned 方針では情報として示す。レジストリに到達できなければ「未確認」と明示する。自動更新はしない（利用者の操作で再ビルド）。
- **理由:** 利用者から「固定だけでなく最新版も選びたい。脆弱性対応のため」との要望。固定版は再現性と検証済みという利点があるが、ベースイメージや CLI の脆弱性修正を取り込めない。最新版は逆に未検証の版が入るため、どちらかを強制せず選べるようにし、入った版を必ず記録・表示して「何が動いているか分からない」状態を避ける。
- **トレードオフ:** latest 方針では、エージェント CLI の新版で必須フラグが変わると実行に失敗し得る（起動前のフラグ互換チェックで検出し NEEDS_HUMAN）。更新の確認はホストからの読み取りのみ（レジストリへの問い合わせ 1 件ずつ、15 秒上限）で、脆弱性データベースとの照合はしない。pinned のマニフェスト更新はリリースごとに人間が行う。
