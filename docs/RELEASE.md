# リリース手順（Windows）

## 1. 前提

- `pnpm install && pnpm build`（contracts / runner）、`pnpm sandbox:build`（Docker イメージ。利用者側でも初回セットアップで実行する）
- Rust toolchain（MSVC）、WebView2 ランタイム（Windows 11 標準）
- Node 22 以上（ビルド時のみ。配布物には同梱される）

## 2. ビルド

```bash
node scripts/build-sidecar.mjs      # runner → Node SEA 単一 exe（apps/desktop/src-tauri/binaries/agent-orchestrator-runner-x86_64-pc-windows-msvc.exe）
pnpm --filter @agent-orchestrator/desktop exec tauri build   # bundle.targets = ["nsis"] → src-tauri/target/release/bundle/nsis/*-setup.exe
```

NSIS インストーラは `externalBin` のサイドカーを `agent-orchestrator-runner.exe` としてアプリと同じディレクトリに展開する。Rust はそのファイルを見つけるとサイドカーとして使う（無ければ開発モード）。

## 3. コード署名（鍵があるときだけ）

本リポジトリ作成時点では署名鍵が無いため **未実施**。手順のみ整備する。

1. 署名証明書（EV または OV）を `Cert:\CurrentUser\My` にインポートし、拇印を確認する: `Get-ChildItem Cert:\CurrentUser\My -CodeSigningCert`
2. **サイドカー exe を先に署名する**（postject で注入した exe は元の Node 署名が無効になっている）:
   `signtool sign /fd SHA256 /tr http://timestamp.digicert.com /td SHA256 /sha1 <拇印> apps\desktop\src-tauri\binaries\agent-orchestrator-runner-x86_64-pc-windows-msvc.exe`
3. `apps/desktop/src-tauri/tauri.conf.json` に Windows 署名設定を追加して `tauri build` を実行する（Tauri が本体 exe とインストーラを署名する）:

   ```json
   "bundle": {
     "windows": {
       "certificateThumbprint": "<拇印>",
       "digestAlgorithm": "sha256",
       "timestampUrl": "http://timestamp.digicert.com"
     }
   }
   ```

   CI で証明書を直接置けない場合は `bundle.windows.signCommand` に Azure Trusted Signing / クラウド HSM の CLI を指定する。
4. 署名確認: `signtool verify /pa /v <exe or setup.exe>`

署名が無い配布物は SmartScreen の警告対象になる。未署名のまま配布しない。

## 4. 配布前チェック

- Node 未インストール環境で `*-setup.exe /S` → 起動 → セットアップチェックが表示されること（LIVE-03）
- Docker Desktop / イメージ / CLI 認証が無い環境で「実行不可：セットアップが必要です」と修正方法が表示されること
- `docs/ACCEPTANCE_REPORT.md` が FAIL 0 であること
- `docs/FINAL_REPORT.md` の未検証項目・残余リスクを README の既知の制限に反映していること

## 5. リリース候補（RC）の扱い

- 署名鍵が無い間は、ビルドした配布物を **「未署名リリース候補（RC）」** として扱い、一般公開版とは区別する（配布は評価目的の利用者に限り、ファイル名や配布ページに「未署名 RC」と明記）。
- RC の検証手順と結果は `docs/RC_VERIFICATION.md` に記録する（インストーラの SHA-256、インストール / 起動 / 初回環境チェック / GUI 全フロー / 停止 / 再起動後の履歴 / アンインストール）。
- 検証ジョブは順次実行する: `CI=1 RUN_DOCKER_TESTS=1 pnpm vitest run` → `pnpm test:e2e`（Playwright）→ LIVE。Docker テストと Playwright を同時に走らせると WebServer（vite）がメモリ不足で落ちることがある。
- サンドボックスイメージは配布物に含まれないが、初回起動時にアプリの「サンドボックスを準備する」から取得・ビルド・検証できる（`docker/manifest.json` のピン留め）。ベースイメージを更新するときは manifest の `baseDigest` を更新し、`pnpm sandbox:build --force` と `node scripts/gen-sandbox-assets.mjs`（runner の build に含まれる）で埋め込みを更新する。
- 一般公開版に進む条件: コード署名（§3）、クリーン環境（別 PC / VM）での検証。

## 6. 現在の配布物（v0.2.2 時点、未署名 RC）

| 項目 | 値 |
|---|---|
| インストーラ | `apps/desktop/src-tauri/target/release/bundle/nsis/Agent Orchestrator_0.1.0_x64-setup.exe`（26,507,611 バイト = 25.28 MiB。配布版検証で見つけた不具合の修正後に再ビルドした最終版） |
| SHA-256 | `BDB48173CBE61F76B9CA49F2E8EBA89A0C88CA31DF384FE24391E579DD5E17BC`（検証途中のビルド: `E2131B92…97BDF` → `38DF8E25…1ED87` → `59911DBE…1D937` → 最終） |
| 同梱サイドカー | `agent-orchestrator-runner.exe`（Node SEA、105,828,864 バイト、SHA-256 `8061F053B01D706B2B10A82AEA75FB24C469D21957840DFE72AEFBB868F0C98F`） |
| コード署名 | **未署名**（`Get-AuthenticodeSignature` = NotSigned）。一般配布不可、配布は評価目的の利用者に限る |
| 製品バージョン文字列 | `0.1.0` のまま（`tauri.conf.json` / package.json / サンドボックスイメージのラベル `dev.agent-orchestrator.version` と連動するため、v0.2.x では意図的に変更していない。公開版で一括して更新する） |
| 検証記録 | `docs/V022_VERIFICATION.md` §4（同一 PC・Node / pnpm 非搭載 PATH・空の app-data での実測。クリーン VM は未検証） |

ビルド所要時間（本 PC）: `pnpm build` + サイドカー 約 30 秒、`tauri build` 334 秒（Rust のフルビルド時。フロントエンドのみの変更では約 3 分）。
