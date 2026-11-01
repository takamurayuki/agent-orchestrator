# 受入テスト一覧（MVP）

テストIDは固定。Unit/IntegrationはモックCLIで検証し、LIVEは専用テストリポジトリ・隔離環境で実行する。

| ID | 分類 | シナリオ | 期待結果 |
|---|---|---|---|
| UI-01 | UI | 初回起動 | 4画面遷移・セットアップ案内 |
| UI-02 | UI | Gitフォルダ選択 | プロジェクト情報表示 |
| UI-03 | UI | 無効フォルダ選択 | 原因と修正案表示、Run不可 |
| UI-04 | UI | 日本語で依頼入力 | draftが作成される |
| UI-05 | UI | 3問以上の質問 | 最大3問ずつ表示 |
| UI-06 | UI | 質問を戻って修正 | 回答/サマリーが再評価 |
| UI-07 | UI | 承認前 | Run開始不可 |
| UI-08 | UI | 承認後 | YAML固定、Run画面へ |
| UI-09 | UI | 実行キャンセル | INTERRUPTED、詳細表示 |
| UI-10 | UI | キーボード操作 | 主要操作がマウスなしで可能 |
| RA-01 | Agent | repoに既存認証あり | 根拠つきfactsとして抽出 |
| RA-02 | Agent | 調査不能 | 未確認扱い、推測を事実にしない |
| RA-03 | Agent | 既存コードで自明 | 重複質問しない |
| RA-04 | Agent | 技術的な選択肢あり | 推奨案と根拠を表示 |
| RA-05 | Agent | blocking未回答 | 承認ボタン無効 |
| RA-06 | Agent | 回答→再評価 | 次の質問が更新される |
| RA-07 | Agent | 最大15問到達で未確定 | BLOCKED |
| RA-08 | Agent | AIが不正JSON | BLOCKED、UIに理由 |
| RA-09 | Agent | YAML出力 | schema検証成功 |
| RA-10 | Agent | 無効YAML | Run不可 |
| RA-11 | Agent | 承認後編集 | 新revision/再承認 |
| RA-12 | Agent | 未承認draft | Builder起動0回 |
| RA-13 | Agent | READMEが危険な指示を含む | 指示を実行せず無視 |
| RA-14 | Agent | 保護ファイルあり | 調査対象から除外 |
| RA-15 | Agent | 受入条件が曖昧 | 再質問またはBLOCKED |
| EX-01 | Engine | 実装+検証+レビュー成功 | COMPLETED |
| EX-02 | Engine | 検証失敗→修正成功 | Builder2回、Reviewer1回 |
| EX-03 | Engine | high指摘→修正→承認 | Builder2回、Reviewer2回 |
| EX-04 | Engine | 3回失敗 | NEEDS_HUMAN、MAX_ROUNDS |
| EX-05 | Engine | Reviewer unknown | NEEDS_HUMAN |
| EX-06 | Engine | Codex JSON不正 | NEEDS_HUMAN |
| EX-07 | Engine | approvedとhigh指摘の併存 | COMPLETED不可 |
| EX-08 | Engine | 検証タイムアウト | COMPLETED不可 |
| EX-09 | Engine | Builder非ゼロ終了 | COMPLETED不可 |
| EX-10 | Engine | 差分なし | COMPLETED不可 |
| EX-11 | Engine | 未追跡ファイルにバグ | レビュー対象に含む |
| EX-12 | Engine | SIGTERM | 子プロセス停止・INTERRUPTED |
| EX-13 | Engine | 並行Run開始 | 拒否 |
| SEC-01 | Security | Docker不可 | PRECHECK_FAILED |
| SEC-02 | Security | network egress制限不可 | PRECHECK_FAILED |
| SEC-03 | Security | Reviewer書込試行 | OSレベルで拒否 |
| SEC-04 | Security | worktree外へ書込 | 拒否 |
| SEC-05 | Security | 認証情報がstdoutに現れる | マスキング |
| SEC-06 | Security | shell metacharacterをタスクに含む | shell実行しない |
| SEC-07 | Security | 任意コマンドのYAML注入 | schema拒否 |
| SEC-08 | Security | 危険な権限フラグ入力 | 拒否 |
| SEC-09 | Security | symlinkで外部参照 | 拒否 |
| SEC-10 | Security | push/merge/deploy要求 | 拒否・手動対応案内 |
| AUD-01 | Audit | 生成したtask revision | SQLiteとYAMLに整合保存 |
| AUD-02 | Audit | 実行中のイベント | sequence順で永続化 |
| AUD-03 | Audit | アプリ異常終了後再起動 | 未完了RunはINTERRUPTED |
| AUD-04 | Audit | 検証失敗 | reportに理由と次の操作 |
| AUD-05 | Audit | UIログ再表示 | 再起動後にも確認可能 |

LIVE-01: 完全に隔離された小さなサンプルリポジトリで要件入力→ヒアリング→YAML承認→実装→検証→レビュー→結果表示を確認。  
LIVE-02: 元リポジトリのHEAD/作業ツリー不変、リモートに副作用なし。  
LIVE-03: Windows配布物がNodeの追加インストールなしでUI起動できる。WSL2/Docker/CLIが不足すると明示的に利用不可になる。
