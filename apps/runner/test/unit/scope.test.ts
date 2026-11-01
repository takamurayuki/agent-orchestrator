import { describe, expect, it } from 'vitest';
import type { DiffFile } from '@agent-orchestrator/contracts';
import { evaluateScope, matchesExpected, renderScopeFeedback } from '../../src/scope.js';

const f = (path: string, status: DiffFile['status'] = 'modified'): DiffFile => ({ path, status, additions: 1, deletions: 0 });

describe('scope check (D-39)', () => {
  it('matches exact paths, directory prefixes, globs and free-text entries containing paths', () => {
    expect(matchesExpected('src/greet.ts', 'src/greet.ts')).toBe(true);
    expect(matchesExpected('src/lib/time.ts', 'src/lib')).toBe(true);
    expect(matchesExpected('src/lib/time.ts', 'src/lib/')).toBe(true);
    expect(matchesExpected('test/greet.test.ts', 'test/**/*.test.ts')).toBe(true);
    expect(matchesExpected('test/greet.test.ts', 'test/*.ts')).toBe(true);
    expect(matchesExpected('apps/runner/src/report.ts', 'apps/runner/src/report.ts（renderReport の Policy Gate 行）')).toBe(true);
    expect(matchesExpected('tests/unit/quality-report-cost.test.ts', '費用集計関数のテスト（例: tests/unit/quality-report-cost.test.ts。vitest.config.ts の include に合わせて配置）')).toBe(true);
    expect(matchesExpected('src/other.ts', 'src/greet.ts')).toBe(false);
    expect(matchesExpected('srcfoo/x.ts', 'src')).toBe(false);
  });

  it('does not judge when the task has no expected changes', () => {
    const r = evaluateScope([f('a.ts'), f('b.ts')], []);
    expect(r.severity).toBe('none');
    expect(r.unexpected).toEqual([]);
  });

  it('all changes inside the expected scope → none; 1–2 unexpected source files → minor', () => {
    expect(evaluateScope([f('src/greet.ts'), f('test/greet.test.ts', 'untracked')], ['src/greet.ts', 'test/']).severity).toBe('none');
    const minor = evaluateScope([f('src/greet.ts'), f('src/util.ts', 'untracked')], ['src/greet.ts']);
    expect(minor.severity).toBe('minor');
    expect(minor.unexpected).toEqual(['src/util.ts']);
    expect(minor.detail).toContain('軽微');
  });

  it('3+ unexpected files, or any unexpected config / lockfile / CI / container change → major', () => {
    const many = evaluateScope([f('scripts/quality-report.mjs'), f('scripts/quality-metrics.mjs', 'untracked'), f('scripts/quality-metrics.d.mts', 'untracked'), f('tests/unit/quality-metrics.test.ts', 'untracked'), f('docs/QUALITY_REPORT.md')], ['scripts/quality-report.mjs', 'docs/QUALITY_REPORT.md']);
    expect(many.severity).toBe('major');
    expect(many.unexpected).toHaveLength(3);
    const sensitive = evaluateScope([f('src/greet.ts'), f('package.json')], ['src/greet.ts'], 'I had to add a dependency');
    expect(sensitive.severity).toBe('major');
    expect(sensitive.detail).toContain('package.json');
    expect(sensitive.builderReason).toBe('I had to add a dependency');
    expect(evaluateScope([f('.github/workflows/ci.yml')], ['src/']).severity).toBe('major');
  });

  it('masks secrets in the recorded builder reason and renders actionable feedback', () => {
    const r = evaluateScope([f('src/a.ts'), f('src/b.ts'), f('src/c.ts')], ['src/x.ts'], 'token sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ-abcdefghijklmnopqrstAA used');
    expect(r.builderReason).not.toContain('sk-ant-api03-abcdefghijklmnopqrstuvwxyz');
    const fb = renderScopeFeedback(r);
    expect(fb).toContain('outside the expected scope');
    expect(fb).toContain('src/x.ts');
    expect(fb).toContain('Out-of-scope changes');
  });
});
