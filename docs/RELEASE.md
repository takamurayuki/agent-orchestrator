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
