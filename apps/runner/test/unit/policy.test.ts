import { describe, expect, it } from 'vitest';
import { assertNoForbiddenFlags, checkDiffPolicy, detectProhibitedOperations, findForbiddenFlags } from '../../src/policy.js';
import { maskSecrets, truncateBytes } from '../../src/masking.js';

describe('prohibited operations [SEC-10]', () => {
  it('detects push/merge/deploy requests and provides manual guidance', () => {
    const ops = detectProhibitedOperations('ログイン機能を追加して main にマージして本番にデプロイして');
    const codes = ops.map((o) => o.code);
    expect(codes).toContain('MERGE');
    expect(codes).toContain('DEPLOY');
    expect(ops.every((o) => o.guidance.length > 0)).toBe(true);
    expect(detectProhibitedOperations('implement login and git push to origin').map((o) => o.code)).toContain('PUSH');
  });

  it('does not flag ordinary requests', () => {
    expect(detectProhibitedOperations('メールアドレスとパスワードでログインできるようにしたい')).toEqual([]);
    // β版検証で見つけた偽陽性: サービス名だけでは外部送信と判定しない
    expect(detectProhibitedOperations('maskSecrets に Slack のトークン（xoxb- で始まる）をマスキングするパターンを追加してテストも追加')).toEqual([]);
    expect(detectProhibitedOperations('Microsoft Teams の会議 URL を正規化する関数を追加')).toEqual([]);
    expect(detectProhibitedOperations('完了したら Slack に投稿する').map((o) => o.code)).toContain('EXTERNAL_POST');
    expect(detectProhibitedOperations('エラー時に Discord へ通知を送る').map((o) => o.code)).toContain('EXTERNAL_POST');
    expect(detectProhibitedOperations('post a summary to Slack when the build finishes').map((o) => o.code)).toContain('EXTERNAL_POST');
    expect(detectProhibitedOperations('Teams の webhook に結果を送信する').map((o) => o.code)).toContain('EXTERNAL_POST');
  });
});

describe('forbidden CLI flags [SEC-08]', () => {
  it('rejects dangerous permission flags', () => {
    expect(findForbiddenFlags(['claude', '-p', 'x', '--dangerously-skip-permissions'])).toEqual(['--dangerously-skip-permissions']);
    expect(findForbiddenFlags(['codex', 'exec', '--dangerously-bypass-approvals-and-sandbox'])).toHaveLength(1);
    expect(findForbiddenFlags(['codex', 'exec', '--sandbox', 'danger-full-access'])).toHaveLength(1);
    expect(findForbiddenFlags(['claude', '--permission-mode', 'bypassPermissions'])).toHaveLength(1);
    expect(() => assertNoForbiddenFlags(['docker', 'run', '--privileged'])).toThrow(/forbidden/);
    expect(() => assertNoForbiddenFlags(['claude', '-p', 'x', '--permission-mode', 'acceptEdits'])).not.toThrow();
  });
});

describe('diff policy (security checks; quality checks live in policy-gate.test.ts since v2.1)', () => {
  it('fails on forbidden paths and path escapes [SEC-04][SEC-09]', () => {
    const v = checkDiffPolicy({
      files: [
        { path: '.github/workflows/ci.yml', status: 'modified', additions: 1, deletions: 0 },
        { path: '../outside.txt', status: 'added', additions: 1, deletions: 0 },
        { path: '.env', status: 'added', additions: 1, deletions: 0 }
      ]
    });
    const codes = v.map((x) => x.code);
    expect(codes).toContain('FORBIDDEN_PATH');
    expect(codes).toContain('PATH_ESCAPE');
  });

  it('passes for ordinary source changes with added tests', () => {
    const v = checkDiffPolicy({
      files: [
        { path: 'src/auth/login.ts', status: 'added', additions: 30, deletions: 0 },
        { path: 'src/auth/login.test.ts', status: 'added', additions: 20, deletions: 0 }
      ],
      patches: { 'src/auth/login.test.ts': "+it('logs in', () => {})" }
    });
    expect(v).toEqual([]);
  });
});

describe('masking [SEC-05]', () => {
  it('masks known key formats and env assignments', () => {
    const text = 'ANTHROPIC_API_KEY=sk-ant-api03-abcdefghijklmnop1234 and Authorization: Bearer abc.def.ghi OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwxyz';
    const masked = maskSecrets(text);
    expect(masked).not.toContain('sk-ant-api03');
    expect(masked).not.toContain('sk-proj-abcdefghijklmnopqrstuvwxyz');
    expect(masked).not.toContain('Bearer abc.def.ghi');
    expect(masked).toContain('[REDACTED');
  });

  it('masks explicitly provided secrets and JSON tokens', () => {
    expect(maskSecrets('token is supersecretvalue', ['supersecretvalue'])).toBe('token is [REDACTED]');
    expect(maskSecrets('{"accessToken":"abcdefghijkl"}')).toContain('[REDACTED]');
  });

  it('truncates with marker', () => {
    const r = truncateBytes('a'.repeat(100), 10);
    expect(r.truncated).toBe(true);
    expect(r.text).toContain('[TRUNCATED 90 bytes]');
  });
});
