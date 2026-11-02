import { describe, expect, it } from 'vitest';
import type { DiffFile } from '@agent-orchestrator/contracts';
import { evaluatePolicyGate, parsePolicyExceptions } from '../../src/policy-gate.js';
import { collectPythonSuppressions, collectPythonTestSkips, pythonConfigChanges } from '../../src/policy-gate-python.js';

const mod = (path: string): DiffFile => ({ path, status: 'modified', additions: 1, deletions: 0 });
const del = (path: string): DiffFile => ({ path, status: 'deleted', additions: 0, deletions: 1 });
const gate = (files: DiffFile[], base: Record<string, string | null>, current: Record<string, string | null>) => evaluatePolicyGate({ files, baseContents: base, currentContents: current, exceptions: parsePolicyExceptions(null) });

describe('Policy Gate — Python rules (v0.3, D-45)', () => {
  it('new # noqa / # type: ignore / # pyright: ignore are blocking; pre-existing ones are not re-reported', () => {
    const before = 'import os  # noqa: F401\nx: int = "a"  # type: ignore\n';
    const after = `${before}import sys  # noqa\ny = 1  # pyright: ignore[reportGeneralTypeIssues]\nz = "# noqa inside a string"\n`;
    expect(collectPythonSuppressions(after).map((h) => `${h.kind}:${h.line}`)).toEqual(['noqa:1', 'type-ignore:2', 'noqa:3', 'type-ignore:4']);
    const r = gate([mod('src/a.py')], { 'src/a.py': before }, { 'src/a.py': after });
    expect(r.passed).toBe(false);
    expect(r.blocking.map((f) => `${f.ruleId}:${f.line}`)).toEqual(['PG-PY-NOQA:3', 'PG-PY-TYPE-IGNORE:4']);
  });

  it('added skip / xfail markers in test files are blocking, and deleting a test file is PG-TEST-DELETED', () => {
    const before = 'import pytest\n\ndef test_a():\n    assert True\n';
    const after = 'import pytest\n\n@pytest.mark.skip(reason="flaky")\ndef test_a():\n    assert True\n\n@pytest.mark.xfail\ndef test_b():\n    pytest.skip("later")\n';
    expect(collectPythonTestSkips(after).map((h) => h.line)).toEqual([3, 7, 9]);
    const r = gate([mod('tests/test_a.py'), del('tests/test_b.py')], { 'tests/test_a.py': before, 'tests/test_b.py': 'def test_b(): pass\n' }, { 'tests/test_a.py': after, 'tests/test_b.py': null });
    expect(r.blocking.filter((f) => f.ruleId === 'PG-PY-TEST-SKIP')).toHaveLength(3);
    expect(r.blocking.some((f) => f.ruleId === 'PG-TEST-DELETED' && f.file === 'tests/test_b.py')).toBe(true);
  });

  it('relaxing tool configuration (ignore / addopts deselect / ignore_errors) in pyproject is blocking; other tool edits are warnings', () => {
    const before = '[tool.ruff]\nline-length = 100\n\n[tool.pytest.ini_options]\ntestpaths = ["tests"]\n';
    const after = '[tool.ruff]\nline-length = 120\n\n[tool.ruff.lint]\nignore = ["E501", "F401"]\n\n[tool.pytest.ini_options]\ntestpaths = ["tests"]\naddopts = "--deselect tests/test_slow.py"\n\n[tool.mypy]\nignore_errors = true\n';
    const hits = pythonConfigChanges('pyproject.toml', before, after);
    expect(hits.filter((h) => h.severity === 'blocking').map((h) => h.text.trim())).toEqual(['ignore = ["E501", "F401"]', 'addopts = "--deselect tests/test_slow.py"', 'ignore_errors = true']);
    expect(hits.filter((h) => h.severity === 'warning').map((h) => h.text.trim())).toContain('line-length = 120');
    const r = gate([mod('pyproject.toml')], { 'pyproject.toml': before }, { 'pyproject.toml': after });
    expect(r.blocking.filter((f) => f.ruleId === 'PG-PY-CONFIG-RELAXED')).toHaveLength(3);
    expect(r.findings.filter((f) => f.ruleId === 'PG-PY-CONFIG-RELAXED' && f.severity === 'warning').length).toBeGreaterThan(0);
    // 依存の追加など [project] 配下の変更は検証ツール設定ではない
    const depOnly = gate([mod('pyproject.toml')], { 'pyproject.toml': '[project]\ndependencies = ["httpx"]\n' }, { 'pyproject.toml': '[project]\ndependencies = ["httpx", "rich"]\n' });
    expect(depOnly.findings.filter((f) => f.ruleId === 'PG-PY-CONFIG-RELAXED')).toEqual([]);
  });

  it('a clean Python change passes', () => {
    const r = gate([mod('src/greet.py')], { 'src/greet.py': 'def greet(n):\n    return n\n' }, { 'src/greet.py': 'def greet(n: str) -> str:\n    return f"Hello, {n}"\n' });
    expect(r.passed).toBe(true);
    expect(r.findings).toEqual([]);
  });
});
