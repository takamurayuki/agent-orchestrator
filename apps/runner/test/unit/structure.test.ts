import { describe, expect, it } from 'vitest';
import type { DiffFile } from '@agent-orchestrator/contracts';
import { checkMarkdown, checkStructure, structureCommandResult } from '../../src/verification/structure.js';

const f = (path: string, status: DiffFile['status'] = 'modified'): DiffFile => ({ path, status, additions: 1, deletions: 0 });

describe('deterministic structure verification (D-40)', () => {
  it('parses JSON and YAML and reports broken files with a reason', () => {
    const files = { 'a.json': '{"ok":true}', 'b.json': '{broken', 'c.yaml': 'key: value\n', 'd.yml': 'key: [unclosed\n', 'e.ts': 'const x = {' };
    const issues = checkStructure([f('a.json'), f('b.json'), f('c.yaml'), f('d.yml'), f('e.ts')], (p) => files[p as keyof typeof files] ?? null);
    expect(issues.map((i) => i.file)).toEqual(['b.json', 'd.yml']);
    expect(issues[0]!.message).toContain('JSON');
  });

  it('skips deleted and unreadable files', () => {
    expect(checkStructure([f('gone.json', 'deleted'), f('missing.json')], () => null)).toEqual([]);
  });

  it('detects unclosed code fences and prefixed list markers in Markdown (the report.md regression)', () => {
    expect(checkMarkdown('ok.md', '# T\n\n```ts\ncode\n```\n\n- [注意] item\n- item 2\n')).toEqual([]);
    const unclosed = checkMarkdown('bad.md', '# T\n\n```ts\ncode\n');
    expect(unclosed[0]!.message).toContain('コードフェンス');
    const prefixed = checkMarkdown('report.md', '## Policy Gate\n[注意] - [warning] PG-VERIFY-SCRIPT package.json:3 — msg\n- [未承認 blocking] PG-X a.ts:1 — msg\n');
    expect(prefixed).toHaveLength(1);
    expect(prefixed[0]!.message).toContain('2 行目');
    // 表やコード内の「 - [」は対象外
    expect(checkMarkdown('t.md', '| a | b - [x] |\n')).toEqual([]);
  });

  it('produces a verification command record that the gate can evaluate', () => {
    expect(structureCommandResult([], 5)).toMatchObject({ name: 'structure', exitCode: 0, timedOut: false });
    const bad = structureCommandResult([{ file: 'x.json', message: 'JSON として解釈できません' }], 5);
    expect(bad.exitCode).toBe(1);
    expect(bad.stdoutExcerpt).toContain('x.json');
  });
});
