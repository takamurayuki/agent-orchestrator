# 品質評価レポート（ドッグフーディング）

生成: 2026-11-01T07:12:16.173Z 対象: 8 件（test-results/dogfood/*.json）

## 指標

| 指標 | 値 |
|---|---|
| タスク数（Run 開始まで到達 / 全体） | 8 / 8 |
| タスク完了率（COMPLETED / Run 開始） | 6/8 = 75% |
| 内訳 | COMPLETED 6、NEEDS_HUMAN 1、PRECHECK_FAILED 1、INTERNAL_ERROR 0、承認前停止 0 |
| 1 タスク当たりの実行時間（ヒアリング+Run、平均） | 268s（ヒアリング 75s、Run 193s） |
| 平均修正ラウンド数（Run 開始分） | 1.38 |
| Builder 1 回あたり平均時間 | 31s（11 回） |
| Reviewer 1 回あたり平均時間 | 20s（10 回） |
| unknown 発生率（レビュー） | 0/10 |
| AI 利用量（Builder の報告費用） | $0.805（報告あり 11 回） |
| egress 拒否（allowlist 外） | 80 件 ／ 許可 1584 件 ／ エラー 0 件 |
| 元リポジトリ不変 | 全件 |

## タスク別

| タスク | 状態 | 理由 | ラウンド | 時間 | 変更ファイル | 未解決指摘 | 人間レビュー |
|---|---|---|---|---|---|---|---|
| batontime-format-remaining | COMPLETED | round 1: すべての完了ゲートを通過 | 1 | 144s | 2 | 0 | approved: formatRemaining は要件どおり（負値/NaN/±Infinity→00:00、秒は切り捨て、分は 2 桁超可）。テストは境界値（999/1000/59999/60000/125:07）を網羅し、既存の src/*.test.ts 配置規約に従う。人間の指摘なし。 |
| phase2-review-converge | COMPLETED | round 2: すべての完了ゲートを通過 | 2 | 344s | 2 | 0 | approved: safeJoin は空文字・NUL・バックスラッシュ・絶対パス・%・'..' セグメントを拒否し、posix.resolve で正規化して baseDir 直下以外を拒否。Round 1 の Codex 指摘（baseDir が '/' のとき結果 === baseDir を拒否できない）は妥当で、Round 2 で `result === base` 条件とテストが追加され approved。人間の所見: '%' を含む正当なファイル名も拒否する過剰拒否（安全側）、symlink は扱わない旨がコメントに明記されており妥当。 |
| phase2-verify-fail-conflict | COMPLETED | round 2: すべての完了ゲートを通過 | 2 | 290s | 2 | 0 | approved_with_concern: makeBanner の機能は正しい。Round 1 は lint（テンプレートリテラル禁止）で検証失敗、Round 2 で修正し approved。ただし修正方法は規約に合わせる書き換えではなく `eslint-disable-next-line` による規則の局所無効化（依頼が『必ずテンプレートリテラルで』と規約と矛盾していたため）。人間としては依頼の矛盾を質問段階で指摘すべきで、Codex もこの点を指摘していない。 |
| phase2-verify-fail-loop | COMPLETED | round 1: すべての完了ゲートを通過 | 1 | 170s | 2 | 0 | approved: formatList は仕様どおり。厳格 lint（テンプレートリテラル禁止・no-console）を Builder が事前に読み取り文字列連結で実装したため検証失敗ループは発生せず。"a (1 items)" の単数形は依頼どおり（仕様上の瑕疵ではない）。 |
| self-masking-patterns | NEEDS_HUMAN | round 3: レビュー changes_requested、修正上限に到達 | 3 | 562s | 2 | 1 | needs_human: 3 ラウンドとも Codex が high を出し MAX_ROUNDS。指摘はいずれも妥当: 依頼の『既存パターンの挙動を変えない』と『新ラベルで置換する』は、既存の env-assign / json-secret が同じ値を先に [REDACTED] に潰す設計と衝突する。最終差分（新パターンを先頭に置き、汎用パターンに新ラベル除外の先読みを追加）は機能的には動くが、`sk_live_…-xyz` のように長い値の一部だけが新ラベルに置き換わり残りが露出し得る点（Round 3 指摘）は実在する。人間としても優先順位の方針決定（ラベル付き置換を優先するか、既存の全体マスクを優先するか）が必要で、NEEDS_HUMAN は妥当。 |
| temporaid-core-clamp | PRECHECK_FAILED | ベースライン検証（変更前のリポジトリ）が失敗: typecheck, lint(未実行), test:run(未実行)。プロジェクト側で typecheck / lint / test:run が通る状態にしてから再実行してください | 0 | 195s | 0 | 0 | not_evaluated: ベースライン検証で PRECHECK_FAILED（prisma generate が binaries.prisma.sh へプロキシ非対応の直接接続を行い DNS 解決不可、apps/web の typecheck が SIGKILL）。AI は呼ばれず差分なし。環境側の制限として妥当な fail-closed。 |
| v21-conflict-gate-2 | COMPLETED | round 1: すべての完了ゲートを通過 | 1 | 244s | 2 | 0 | approved: v2.1 実機検証 2 回目（修正後）。ヒアリングの選択肢順が concat / exception / disable_rule となり（規則緩和は非推奨と明示）、文字列連結で実装。eslint-disable なし、Policy Gate 0 件、lint 通過、Codex approved。人間レビューも approved。矛盾はヒアリング段階で解消されたため矛盾検出ステップの差し戻しは発生せず（通常質問として回答履歴に残る。意思決定ログには CONTRA- 質問のみ記録される点は改善候補）。 |
| v21-conflict-gate | COMPLETED | round 1: すべての完了ゲートを通過 | 1 | 194s | 2 | 0 | rejected: v2.1 実機検証 1 回目。ヒアリングで矛盾は質問されたが（自動回答が先頭の disable_line を選択）、Builder が行末コメント `// eslint-disable-line no-restricted-syntax` で規則を回避し、初版 Policy Gate（scanner 実装）が取り逃がして COMPLETED。人間レビューでは不合格（規則の局所無効化）。→ パーサ駆動のコメント収集に修正し、監査で同ワークスペースの検出を確認。 |

## 人間レビューと AI 判定の一致

- **batontime-format-remaining**: AI=approved / 人間=approved（一致）。formatRemaining は要件どおり（負値/NaN/±Infinity→00:00、秒は切り捨て、分は 2 桁超可）。テストは境界値（999/1000/59999/60000/125:07）を網羅し、既存の src/*.test.ts 配置規約に従う。人間の指摘なし。
- **phase2-review-converge**: AI=approved / 人間=approved（一致）。safeJoin は空文字・NUL・バックスラッシュ・絶対パス・%・'..' セグメントを拒否し、posix.resolve で正規化して baseDir 直下以外を拒否。Round 1 の Codex 指摘（baseDir が '/' のとき結果 === baseDir を拒否できない）は妥当で、Round 2 で `result === base` 条件とテストが追加され approved。人間の所見: '%' を含む正当なファイル名も拒否する過剰拒否（安全側）、symlink は扱わない旨がコメントに明記されており妥当。
- **phase2-verify-fail-conflict**: AI=approved / 人間=approved_with_concern（不一致）。makeBanner の機能は正しい。Round 1 は lint（テンプレートリテラル禁止）で検証失敗、Round 2 で修正し approved。ただし修正方法は規約に合わせる書き換えではなく `eslint-disable-next-line` による規則の局所無効化（依頼が『必ずテンプレートリテラルで』と規約と矛盾していたため）。人間としては依頼の矛盾を質問段階で指摘すべきで、Codex もこの点を指摘していない。 未検出: 依頼とプロジェクト規約の矛盾を lint 無効化で回避した点（Reviewer 未検出）
- **phase2-verify-fail-loop**: AI=approved / 人間=approved（一致）。formatList は仕様どおり。厳格 lint（テンプレートリテラル禁止・no-console）を Builder が事前に読み取り文字列連結で実装したため検証失敗ループは発生せず。"a (1 items)" の単数形は依頼どおり（仕様上の瑕疵ではない）。
- **self-masking-patterns**: AI=changes_requested/needs_human / 人間=needs_human（一致）。3 ラウンドとも Codex が high を出し MAX_ROUNDS。指摘はいずれも妥当: 依頼の『既存パターンの挙動を変えない』と『新ラベルで置換する』は、既存の env-assign / json-secret が同じ値を先に [REDACTED] に潰す設計と衝突する。最終差分（新パターンを先頭に置き、汎用パターンに新ラベル除外の先読みを追加）は機能的には動くが、`sk_live_…-xyz` のように長い値の一部だけが新ラベルに置き換わり残りが露出し得る点（Round 3 指摘）は実在する。人間としても優先順位の方針決定（ラベル付き置換を優先するか、既存の全体マスクを優先するか）が必要で、NEEDS_HUMAN は妥当。
- **temporaid-core-clamp**: AI=PRECHECK_FAILED / 人間=not_evaluated（一致）。ベースライン検証で PRECHECK_FAILED（prisma generate が binaries.prisma.sh へプロキシ非対応の直接接続を行い DNS 解決不可、apps/web の typecheck が SIGKILL）。AI は呼ばれず差分なし。環境側の制限として妥当な fail-closed。
- **v21-conflict-gate-2**: AI=approved / 人間=approved（一致）。v2.1 実機検証 2 回目（修正後）。ヒアリングの選択肢順が concat / exception / disable_rule となり（規則緩和は非推奨と明示）、文字列連結で実装。eslint-disable なし、Policy Gate 0 件、lint 通過、Codex approved。人間レビューも approved。矛盾はヒアリング段階で解消されたため矛盾検出ステップの差し戻しは発生せず（通常質問として回答履歴に残る。意思決定ログには CONTRA- 質問のみ記録される点は改善候補）。
- **v21-conflict-gate**: AI=approved / 人間=rejected（不一致）。v2.1 実機検証 1 回目。ヒアリングで矛盾は質問されたが（自動回答が先頭の disable_line を選択）、Builder が行末コメント `// eslint-disable-line no-restricted-syntax` で規則を回避し、初版 Policy Gate（scanner 実装）が取り逃がして COMPLETED。人間レビューでは不合格（規則の局所無効化）。→ パーサ駆動のコメント収集に修正し、監査で同ワークスペースの検出を確認。 未検出: 行末の eslint-disable-line（テンプレートリテラル直後）— 修正済み

## Policy Gate 監査（偽陽性 / 偽陰性の調査）

- ドッグフーディングのワークスペース 15 件、本リポジトリの直近コミット 8 件にゲートを適用（`node scripts/policy-gate-audit.mjs`）。
- ワークスペースで検出あり: 2 件 （phase2-verify-fail-conflict: PG-ESLINT-DISABLE src/banner.ts:9 // eslint-disable-next-line no-restricted-syntax）（v21-conflict-gate: PG-ESLINT-DISABLE src/banner.ts:8 // eslint-disable-line no-restricted-syntax）
- コミットで検出あり: 1 件 （c91bd00 dogfood fixes: baseline verification, egress summary UI, pnpm/git conf: PG-VERIFY-SCRIPT package.json:12 scripts.typecheck が変更された: "pnpm -r run typecheck" → "pnpm --filter @agent-orchestrator/contracts run build && pnpm -r run typecheck" / PG-VERIFY-SCRIPT package.json:15 scripts.test:run が変更された: "vitest run" → "pnpm --filter @agent-orchestrator/contracts run build && vitest run"）
- 判定: ワークスペース側の検出はドッグフーディングで人間が指摘した eslint-disable 回避そのもの（真陽性）。それ以外の AI 生成差分・自作コミットに偽陽性なし。コミット側の PG-VERIFY-SCRIPT は検証 scripts の「変更」を設計どおり保守的に検出したもので、意図した変更（強化）でも人間の承認（例外登録）を要求する。
