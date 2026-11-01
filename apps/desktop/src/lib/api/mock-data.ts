import type {
  AskedQuestion,
  EnvironmentReport,
  Fact,
  ProjectInfo,
  RunStatus,
  RunReportResult,
  TaskProposal,
  Answer
} from '@agent-orchestrator/contracts';

export const MOCK_PROJECT_PATH = 'C:\\Users\\dev\\projects\\web-app';

export function environmentReport(fail: boolean): EnvironmentReport {
  const now = new Date().toISOString();
  const checks: EnvironmentReport['checks'] = [
    {
      id: 'wsl',
      label: 'WSL2 (Ubuntu)',
      status: 'ok',
      detail: 'WSL バージョン 2.3.26、既定ディストリビューション Ubuntu-24.04',
      fix: null
    },
    fail
      ? {
          id: 'docker',
          label: 'Docker Desktop',
          status: 'fail',
          detail: 'Docker デーモンに接続できません (docker info: error during connect: open //./pipe/dockerDesktopLinuxEngine)',
          fix: 'Docker Desktop を起動し、Settings > Resources > WSL integration で Ubuntu-24.04 を有効にしてから「再チェック」を押してください。'
        }
      : {
          id: 'docker',
          label: 'Docker Desktop',
          status: 'ok',
          detail: 'Docker 27.3.1、WSL2 バックエンド、実行イメージ agent-orchestrator/sandbox:node22 を検出',
          fix: null
        },
    fail
      ? {
          id: 'egress',
          label: 'ネットワーク egress 制限',
          status: 'skipped',
          detail: 'Docker が利用できないため未検証',
          fix: 'Docker の問題を解消すると自動的に再検証されます。'
        }
      : {
          id: 'egress',
          label: 'ネットワーク egress 制限',
          status: 'ok',
          detail: 'allowlist プロキシ (api.anthropic.com, api.openai.com, registry.npmjs.org) を検出',
          fix: null
        },
    {
      id: 'claude-cli',
      label: 'Claude Code CLI',
      status: 'ok',
      detail: 'claude 2.1.0（認証済み）',
      fix: null
    },
    {
      id: 'codex-cli',
      label: 'Codex CLI',
      status: fail ? 'warn' : 'ok',
      detail: fail ? 'codex 0.48.0 を検出。--output-schema の対応はコンテナ内で未確認' : 'codex 0.48.0（認証済み、--output-schema 対応）',
      fix: fail ? 'Docker を復旧後、セットアップチェックを再実行してください。' : null
    },
    {
      id: 'git',
      label: 'Git',
      status: 'ok',
      detail: 'git version 2.47.1',
      fix: null
    },
    {
      id: 'disk',
      label: 'ディスク空き容量',
      status: 'ok',
      detail: 'C: に 184 GB の空き（最低 5 GB 必要）',
      fix: null
    }
  ];
  return {
    platform: 'win32',
    executionMode: fail ? 'unavailable' : 'docker-wsl',
    canRun: !fail,
    checks,
    checkedAt: now
  };
}

export function inspectProject(path: string): ProjectInfo {
  const now = new Date().toISOString();
  const lower = path.toLowerCase();
  if (lower.includes('invalid')) {
    return {
      path,
      status: 'not_git',
      gitRoot: null,
      currentBranch: null,
      headSha: null,
      isClean: null,
      defaultBaseRef: null,
      packageManager: null,
      frameworks: [],
      testFrameworks: [],
      verificationProfile: null,
      problems: [
        {
          code: 'NOT_GIT_REPOSITORY',
          message: '選択したフォルダーは Git リポジトリではありません（.git ディレクトリが見つかりません）。',
          fix: 'Git 管理されているプロジェクトのルートフォルダーを選択してください。新規プロジェクトの場合は、ターミナルで git init と最初のコミットを行ってから再度選択してください。'
        }
      ],
      fileCount: 0,
      inspectedAt: now
    };
  }
  if (lower.includes('dirty')) {
    return {
      path,
      status: 'unusable',
      gitRoot: path,
      currentBranch: 'feature/wip',
      headSha: '9f8e7d6c5b4a39281716150f0e0d0c0b0a090807',
      isClean: false,
      defaultBaseRef: 'develop',
      packageManager: 'pnpm',
      frameworks: ['SvelteKit'],
      testFrameworks: ['vitest'],
      verificationProfile: { name: 'node-pnpm', ready: false, missingScripts: ['lint'] },
      problems: [
        {
          code: 'WORKTREE_DIRTY',
          message: '未コミットの変更が 3 ファイルあります。ベース SHA を固定できません。',
          fix: '変更をコミットまたは stash してから再度選択してください。'
        },
        {
          code: 'VERIFICATION_SCRIPTS_MISSING',
          message: '検証プロファイル node-pnpm に必要な package.json scripts が不足しています: lint',
          fix: 'package.json に "lint" スクリプト（例: "eslint ."）を追加してください。'
        }
      ],
      fileCount: 388,
      inspectedAt: now
    };
  }
  return {
    path,
    status: 'ok',
    gitRoot: path,
    currentBranch: 'develop',
    headSha: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
    isClean: true,
    defaultBaseRef: 'develop',
    packageManager: 'pnpm',
    frameworks: ['SvelteKit 2', 'Express 4'],
    testFrameworks: ['vitest', 'playwright'],
    verificationProfile: { name: 'node-pnpm', ready: true, missingScripts: [] },
    problems: [],
    fileCount: 412,
    inspectedAt: now
  };
}

export const FACTS: Fact[] = [
  { key: 'framework', value: 'SvelteKit 2 + Express 4（API サーバー）', source: 'package.json', confidence: 'confirmed' },
  // 同じ key の fact が複数あり得る（実データで each_key_duplicate を起こした回帰）
  { key: 'framework', value: 'Express 4（API サーバー）', source: 'package.json', confidence: 'confirmed' },
  { key: 'tests', value: 'Playwright（E2E）', source: 'playwright.config.ts', confidence: 'confirmed' },
  { key: 'database', value: 'PostgreSQL（drizzle-orm）。users テーブルに email / passwordHash 列あり', source: 'src/db/schema.ts', confidence: 'confirmed' },
  { key: 'tests', value: 'Vitest（単体）と Playwright（E2E）が設定済み', source: 'package.json, playwright.config.ts', confidence: 'confirmed' },
  { key: 'session', value: 'express-session が依存に含まれ、CSRF ミドルウェアが有効', source: 'package.json, src/server/app.ts', confidence: 'confirmed' },
  { key: 'passwordHash', value: 'bcrypt でハッシュ化している可能性（@types/bcrypt が devDependencies に存在、実装は未確認）', source: 'package.json', confidence: 'inferred' },
  { key: 'mail', value: 'メール送信基盤の有無', source: '調査範囲外（src/mail/ が存在せず、外部サービスの設定も未検出）', confidence: 'unknown' }
];

const ROUND1: AskedQuestion[] = [
  {
    id: 'Q-001',
    round: 1,
    question: '新規ユーザー登録も今回の対象に含めますか？',
    decisionImpact: 'blocking',
    options: [
      { value: 'login_only', label: 'ログインのみ' },
      { value: 'with_signup', label: '新規登録も含める' },
      { value: 'with_signup_reset', label: '新規登録とパスワード再設定も含める' }
    ],
    recommendation:
      '推奨: ログインのみ。理由: 既存の users テーブル（src/db/schema.ts）があり、登録フローを別タスクにするとレビュー範囲を小さく保てます。リスク: 検証用ユーザーを手動で作成する必要があります。'
  },
  {
    id: 'Q-002',
    round: 1,
    question: 'セッション管理の方式はどうしますか？',
    decisionImpact: 'blocking',
    options: [
      { value: 'cookie', label: 'HttpOnly Cookie セッション（既存の express-session を利用）' },
      { value: 'jwt', label: 'JWT（Authorization ヘッダー）' }
    ],
    recommendation:
      '推奨: HttpOnly Cookie セッション。理由: express-session が既に依存に含まれ、CSRF 対策ミドルウェアも設定済みです。代替の JWT はトークン失効の仕組みを追加実装する必要があります。'
  },
  {
    id: 'Q-003',
    round: 1,
    question: 'ログイン失敗時のエラーメッセージの方針を選んでください。',
    decisionImpact: 'non_blocking',
    options: [
      { value: 'generic', label: '「メールアドレスまたはパスワードが正しくありません」で統一する' },
      { value: 'specific', label: 'メール未登録とパスワード誤りを区別して表示する' }
    ],
    recommendation: '推奨: 統一メッセージ。理由: アカウントの存在を推測されるユーザー列挙攻撃を防げます。'
  }
];

const ROUND2: AskedQuestion[] = [
  {
    id: 'Q-004',
    round: 2,
    question: 'ログイン試行回数の制限（ブルートフォース対策）を設けますか？',
    decisionImpact: 'blocking',
    options: [
      { value: 'lock_5_15', label: '5 回連続で失敗したら 15 分間ロックする' },
      { value: 'none', label: '今回は制限しない（別タスクで対応）' }
    ],
    recommendation:
      '推奨: 5 回失敗で 15 分ロック。理由: 受入条件に総当たり対策を含められ、既存の rate-limit ミドルウェアを再利用できます。リスク: ロック解除方法（時間経過）を画面に明示する必要があります。'
  },
  {
    id: 'Q-005',
    round: 2,
    question: 'ログイン画面はどこに配置しますか？',
    decisionImpact: 'non_blocking',
    options: [
      { value: 'route', label: '/login の独立ページ' },
      { value: 'modal', label: 'ヘッダーから開くモーダル' }
    ],
    recommendation: '推奨: /login の独立ページ。理由: 既存の src/routes/ 構成と一貫し、保護ルートからのリダイレクト先として扱いやすいためです。'
  }
];

export const QUESTION_ROUNDS: AskedQuestion[][] = [ROUND1, ROUND2];
export const ALL_QUESTIONS: AskedQuestion[] = [...ROUND1, ...ROUND2];

export function optionLabel(questionId: string, value: string | null): string | null {
  if (value === null) return null;
  const q = ALL_QUESTIONS.find((x) => x.id === questionId);
  const opt = q?.options.find((o) => o.value === value);
  return opt ? opt.label : value;
}

function answerText(answers: Answer[], questionId: string): string {
  const a = answers.find((x) => x.questionId === questionId);
  if (!a) return '未確定（未質問）';
  if (a.skipped || a.value === null) return '未確定（スキップ）';
  return optionLabel(questionId, a.value) ?? a.value;
}

export function summarize(request: string, answers: Answer[]): string {
  return [
    `依頼: ${request}`,
    `スコープ: ${answerText(answers, 'Q-001')}`,
    `セッション管理: ${answerText(answers, 'Q-002')}`,
    `失敗時メッセージ: ${answerText(answers, 'Q-003')}`,
    `試行回数制限: ${answerText(answers, 'Q-004')}`,
    `画面配置: ${answerText(answers, 'Q-005')}`
  ].join('\n');
}

export function buildProposal(request: string, answers: Answer[]): TaskProposal {
  const scope = answers.find((a) => a.questionId === 'Q-001')?.value ?? 'login_only';
  const session = answers.find((a) => a.questionId === 'Q-002')?.value ?? 'cookie';
  const message = answers.find((a) => a.questionId === 'Q-003');
  const lock = answers.find((a) => a.questionId === 'Q-004')?.value ?? 'lock_5_15';
  const placement = answers.find((a) => a.questionId === 'Q-005');

  const requirements = ['メールアドレスとパスワードで認証できる'];
  if (session === 'jwt') requirements.push('認証成功時に JWT を発行し、Authorization ヘッダーで検証する');
  else requirements.push('認証成功時に HttpOnly Cookie セッションを確立し、ログアウトで無効化する');
  if (scope !== 'login_only') requirements.push('メールアドレスとパスワードで新規ユーザー登録ができる（パスワードは bcrypt でハッシュ化）');
  if (scope === 'with_signup_reset') requirements.push('パスワード再設定の申請と再設定ができる');
  if (lock === 'lock_5_15') requirements.push('5 回連続でログインに失敗したアカウントを 15 分間ロックする');
  requirements.push('未認証ユーザーが保護ルートにアクセスするとログイン画面へ誘導される');

  const outOfScope = ['SSO / ソーシャルログイン', '二要素認証', 'push / merge / deploy（手動で実施）'];
  if (scope === 'login_only') outOfScope.unshift('新規ユーザー登録', 'パスワード再設定');
  if (scope === 'with_signup') outOfScope.unshift('パスワード再設定');
  if (lock === 'none') outOfScope.push('ログイン試行回数の制限');

  const acceptanceCriteria = [
    { id: 'AC-001', given: '有効なユーザーが存在する', when: '正しいメールアドレスとパスワードでログインする', then: '認証済みセッションが確立し、ダッシュボードへ遷移する' },
    {
      id: 'AC-002',
      given: '未認証ユーザーである',
      when: '保護されたルート /dashboard にアクセスする',
      then: 'ログイン画面にリダイレクトされる'
    },
    {
      id: 'AC-003',
      given: '有効なユーザーが存在する',
      when: '誤ったパスワードでログインする',
      then: message?.value === 'specific' ? 'パスワードが誤っている旨が表示され、セッションは確立しない' : '「メールアドレスまたはパスワードが正しくありません」と表示され、セッションは確立しない'
    },
    { id: 'AC-004', given: 'ログイン済みである', when: 'ログアウトする', then: 'セッションが無効化され、保護ルートにアクセスできない' }
  ];
  if (lock === 'lock_5_15') {
    acceptanceCriteria.push({ id: 'AC-005', given: '同一アカウントで 5 回連続ログインに失敗した', when: '正しい認証情報でログインする', then: '15 分間はロック中である旨が表示され、ログインできない' });
  }

  const openItems: string[] = [];
  if (!message || message.skipped) openItems.push('ログイン失敗時のメッセージ方針（既定: 統一メッセージ）');
  if (!placement || placement.skipped) openItems.push('ログイン画面の配置（既定: /login）');
  openItems.push('パスワードハッシュ方式は bcrypt と推測（実装時に src/server/auth を確認）');

  return {
    title: scope === 'login_only' ? 'メールアドレスとパスワードでのログイン' : 'メール/パスワードによるログインと新規登録',
    objective: request,
    requirements,
    outOfScope,
    approach:
      (session === 'jwt'
        ? 'Express API に /api/auth/login, /api/auth/logout を追加し、jsonwebtoken で署名した JWT を返す。'
        : '既存の express-session を利用して /api/auth/login, /api/auth/logout を追加し、HttpOnly / SameSite=Lax の Cookie を発行する。') +
      ' パスワード比較は bcrypt.compare を用い、平文は保存・ログ出力しない。' +
      (placement?.value === 'modal' ? ' ログイン UI はヘッダーのモーダルとして実装する。' : ' ログイン UI は src/routes/login/+page.svelte として実装する。') +
      ' hooks.server.ts で保護ルートのガードを追加し、Vitest で API、Playwright でログイン導線を検証する。',
    acceptanceCriteria,
    openItems
  };
}

export function toTaskYaml(taskId: string, repository: string, baseRef: string, proposal: TaskProposal): string {
  const quote = (s: string) => JSON.stringify(s);
  const lines = [
    'schemaVersion: 2',
    `id: ${taskId}`,
    `title: ${quote(proposal.title)}`,
    `repository: ${quote(repository)}`,
    `baseRef: ${baseRef}`,
    'requirements:',
    ...proposal.requirements.map((r) => `  - ${quote(r)}`),
    'acceptanceCriteria:',
    ...proposal.acceptanceCriteria.flatMap((ac) => [`  - id: ${ac.id}`, `    given: ${quote(ac.given)}`, `    when: ${quote(ac.when)}`, `    then: ${quote(ac.then)}`]),
    'verificationProfile: node-pnpm',
    'limits:',
    '  maxImplementationAttempts: 3',
    '  maxDurationSeconds: 2700',
    '  cliTimeoutSeconds: 900',
    '  verificationTimeoutSeconds: 300',
    'review:',
    '  blockingSeverities: [critical, high]'
  ];
  return lines.join('\n') + '\n';
}

export const CHANGED_FILES = [
  'src/routes/login/+page.svelte',
  'src/routes/login/+page.server.ts',
  'src/server/auth/login.ts',
  'src/server/auth/login.test.ts',
  'src/hooks.server.ts',
  'e2e/login.spec.ts'
];

export const DIFF_EXCERPT = `diff --git a/src/server/auth/login.ts b/src/server/auth/login.ts
new file mode 100644
index 0000000..4f2a1c9
--- /dev/null
+++ b/src/server/auth/login.ts
@@ -0,0 +1,31 @@
+import bcrypt from 'bcrypt';
+import { db } from '../../db/client';
+import { users } from '../../db/schema';
+import { eq } from 'drizzle-orm';
+
+const MAX_FAILURES = 5;
+const LOCK_MINUTES = 15;
+
+export async function login(email: string, password: string) {
+  const user = await db.query.users.findFirst({ where: eq(users.email, email) });
+  if (!user) return { ok: false as const, reason: 'invalid_credentials' };
+  if (user.lockedUntil && user.lockedUntil > new Date()) {
+    return { ok: false as const, reason: 'locked' };
+  }
+  const matches = await bcrypt.compare(password, user.passwordHash);
+  if (!matches) {
+    await recordFailure(user.id);
+    return { ok: false as const, reason: 'invalid_credentials' };
+  }
+  await resetFailures(user.id);
+  return { ok: true as const, userId: user.id };
+}
diff --git a/src/hooks.server.ts b/src/hooks.server.ts
index 3e1f0aa..b7c2d10 100644
--- a/src/hooks.server.ts
+++ b/src/hooks.server.ts
@@ -4,6 +4,12 @@ export const handle: Handle = async ({ event, resolve }) => {
+  if (event.url.pathname.startsWith('/dashboard') && !event.locals.session) {
+    throw redirect(303, '/login?next=' + encodeURIComponent(event.url.pathname));
+  }
   return resolve(event);
 };
`;

export function reportMarkdown(run: RunStatus, extra: { verificationPassed: boolean; findingsCount: number; requirementsUnverified: string[] }): string {
  const status = run.state;
  return [
    `# 実行レポート: ${run.taskTitle}`,
    '',
    `- Run ID: ${run.runId}`,
    `- 状態: ${status}${run.reasonCode ? ` (${run.reasonCode})` : ''}`,
    `- リポジトリ: ${run.repository}`,
    `- ベース: ${run.baseRef}${run.baseSha ? ` @ ${run.baseSha.slice(0, 12)}` : ''}`,
    `- ラウンド: ${run.currentRound}/${run.maxRounds}`,
    '',
    '## 完了ゲート',
    '',
    `1. 承認済みスナップショット: ${run.approvedTaskId} ✔`,
    `2. 検証コマンド: ${extra.verificationPassed ? 'typecheck / lint / test:run すべて exit 0' : '未完了または失敗'}`,
    `3. 差分: ${status === 'COMPLETED' ? `${CHANGED_FILES.length} ファイル変更` : '部分的'}`,
    `4. レビュー: ${status === 'COMPLETED' ? 'approved' : '未完了'}`,
    `5. 未解決 critical/high: ${run.openBlockingFindings}、未検証要件: ${extra.requirementsUnverified.length}`,
    '',
    '## レビュー概要',
    '',
    extra.findingsCount > 0 ? `- 指摘 ${extra.findingsCount} 件（うち blocking ${run.openBlockingFindings} 件）` : '- 指摘なし',
    ...extra.requirementsUnverified.map((r) => `- 未検証: ${r}`),
    '',
    '## 次の手動操作',
    '',
    ...run.nextActions.map((a) => `- ${a}`),
    ''
  ].join('\n');
}

export function seedHistory(): Array<{ run: RunStatus; report: RunReportResult }> {
  const base = {
    repository: MOCK_PROJECT_PATH,
    baseRef: 'develop',
    maxRounds: 3
  };
  const completed: RunStatus = {
    ...base,
    runId: '01JBF2Y8K7Q9M3N4P5R6S7T8U9',
    approvedTaskId: 'APT-01JBF2Y8K7Q9M3N4P5R6S7T8U8',
    taskId: 'TASK-PAGING-001',
    taskTitle: '検索結果一覧のページング追加',
    baseSha: '7c9e6679f1a24b2d8e3f0a1b2c3d4e5f60718293',
    state: 'COMPLETED',
    reasonCode: 'COMPLETED',
    reasonDetail: '全ゲートを通過しました。',
    currentRound: 1,
    worktreePath: 'C:\\Users\\dev\\.agent-orchestrator\\worktrees\\01JBF2Y8K7Q9M3N4P5R6S7T8U9',
    runDir: 'C:\\Users\\dev\\AppData\\Local\\agent-orchestrator\\app-data\\runs\\01JBF2Y8K7Q9M3N4P5R6S7T8U9',
    startedAt: '2026-10-28T09:12:04.000Z',
    finishedAt: '2026-10-28T09:31:48.000Z',
    lastSequence: 14,
    openBlockingFindings: 0,
    nextActions: ['ワークツリーの差分を確認し、必要なら手動でコミット / push してください', 'ワークツリーは保持されています。不要になれば削除してください']
  };
  const needsHuman: RunStatus = {
    ...base,
    runId: '01JBM9X1A2B3C4D5E6F7G8H9J0',
    approvedTaskId: 'APT-01JBM9X1A2B3C4D5E6F7G8H9J1',
    taskId: 'TASK-CSV-002',
    taskTitle: 'CSV エクスポートの文字コード対応（BOM 付き UTF-8）',
    baseSha: '3b2a1c0d9e8f7a6b5c4d3e2f1a0b9c8d7e6f5a4b',
    state: 'NEEDS_HUMAN',
    reasonCode: 'MAX_ROUNDS',
    reasonDetail: '3 ラウンド実施後も Reviewer が high 指摘 1 件を未解決としたため停止しました。',
    currentRound: 3,
    worktreePath: 'C:\\Users\\dev\\.agent-orchestrator\\worktrees\\01JBM9X1A2B3C4D5E6F7G8H9J0',
    runDir: 'C:\\Users\\dev\\AppData\\Local\\agent-orchestrator\\app-data\\runs\\01JBM9X1A2B3C4D5E6F7G8H9J0',
    startedAt: '2026-10-30T13:02:11.000Z',
    finishedAt: '2026-10-30T13:58:40.000Z',
    lastSequence: 41,
    openBlockingFindings: 1,
    nextActions: ['指摘 F-003（Excel 互換の BOM 出力）をワークツリーで手動確認してください', '修正後に新しい依頼として再実行してください']
  };
  return [
    {
      run: completed,
      report: {
        run: completed,
        reportMarkdown: reportMarkdown(completed, { verificationPassed: true, findingsCount: 0, requirementsUnverified: [] }),
        diffExcerpt:
          'diff --git a/src/routes/search/+page.svelte b/src/routes/search/+page.svelte\n@@ -12,3 +12,9 @@\n+  <nav aria-label="ページ">\n+    <a href="?page={page - 1}">前へ</a>\n+    <a href="?page={page + 1}">次へ</a>\n+  </nav>\n',
        diffTruncated: false,
        changedFiles: ['src/routes/search/+page.svelte', 'src/routes/search/+page.server.ts', 'src/lib/paging.ts', 'src/lib/paging.test.ts'],
        openFindings: [],
        requirementsUnverified: [],
        egress: { available: true, allowed: 14, denied: 2, errors: 0, allowedHosts: ['api.anthropic.com', 'chatgpt.com', 'registry.npmjs.org'], deniedHosts: [{ host: 'ab.chatgpt.com', count: 2 }], errorHosts: [] },
        policyFindings: [],
        reportPath: completed.runDir + '\\report.md',
        worktreePath: completed.worktreePath
      }
    },
    {
      run: needsHuman,
      report: {
        run: needsHuman,
        reportMarkdown: reportMarkdown(needsHuman, {
          verificationPassed: true,
          findingsCount: 2,
          requirementsUnverified: ['Excel で開いた際に文字化けしないこと（BOM 付き UTF-8）']
        }),
        diffExcerpt:
          'diff --git a/src/server/export/csv.ts b/src/server/export/csv.ts\n@@ -1,4 +1,5 @@\n-const header = columns.join(",");\n+const BOM = "\\uFEFF";\n+const header = BOM + columns.join(",");\n',
        diffTruncated: true,
        changedFiles: ['src/server/export/csv.ts', 'src/server/export/csv.test.ts'],
        openFindings: [
          {
            id: 'F-003',
            severity: 'high',
            file: 'src/server/export/csv.ts',
            line: 2,
            description: 'BOM が文字列連結で付与されているが、ストリーミング出力経路（exportLarge）では付与されていない。',
            recommendation: 'Writable の先頭チャンクで BOM を書き出す共通関数に統一してください。'
          },
          {
            id: 'F-004',
            severity: 'low',
            file: 'src/server/export/csv.test.ts',
            line: 18,
            description: 'テストが BOM の存在のみを確認し、Excel 互換の改行 (CRLF) を検証していない。',
            recommendation: 'CRLF の検証ケースを追加してください。'
          }
        ],
        requirementsUnverified: ['Excel で開いた際に文字化けしないこと（BOM 付き UTF-8）'],
        egress: { available: true, allowed: 14, denied: 2, errors: 0, allowedHosts: ['api.anthropic.com', 'chatgpt.com', 'registry.npmjs.org'], deniedHosts: [{ host: 'ab.chatgpt.com', count: 2 }], errorHosts: [] },
        policyFindings: [],
        reportPath: needsHuman.runDir + '\\report.md',
        worktreePath: needsHuman.worktreePath
      }
    }
  ];
}
