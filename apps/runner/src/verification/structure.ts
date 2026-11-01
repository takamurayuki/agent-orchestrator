import { parse as parseYaml } from 'yaml';
import type { DiffFile, VerificationCommandResult } from '@agent-orchestrator/contracts';

/**
 * 決定的な構造検証（v0.2.0、D-40）。AI ではなく Verifier の一部として、変更されたテキストファイルの
 * 機械的な整合性を確認する。Reviewer の推測に頼らない。
 *   - *.json: JSON として解釈できる
 *   - *.yaml / *.yml: YAML として解釈できる
 *   - *.md: コードフェンス（```）が閉じている、見出し直後に同レベル以上の構造崩れが無い（最小限）
 * 対象はテキストで、削除されたファイルは対象外。
 */
export interface StructureIssue {
  file: string;
  message: string;
}

export function checkStructure(files: readonly DiffFile[], readFile: (path: string) => string | null): StructureIssue[] {
  const issues: StructureIssue[] = [];
  for (const f of files) {
    if (f.status === 'deleted') continue;
    const path = f.path.replace(/\\/g, '/');
    const lower = path.toLowerCase();
    if (!/\.(json|ya?ml|md|markdown)$/.test(lower)) continue;
    const text = readFile(f.path);
    if (text === null) continue;
    if (lower.endsWith('.json')) {
      try {
        JSON.parse(text);
      } catch (err) {
        issues.push({ file: path, message: `JSON として解釈できません: ${(err as Error).message.slice(0, 120)}` });
      }
    } else if (/\.ya?ml$/.test(lower)) {
      try {
        parseYaml(text);
      } catch (err) {
        issues.push({ file: path, message: `YAML として解釈できません: ${(err as Error).message.slice(0, 120)}` });
      }
    } else {
      issues.push(...checkMarkdown(path, text));
    }
  }
  return issues;
}

export function checkMarkdown(path: string, text: string): StructureIssue[] {
  const issues: StructureIssue[] = [];
  const lines = text.split(/\r?\n/);
  let fenceOpen: { line: number; marker: string } | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const m = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (!m) continue;
    const marker = m[1]!;
    if (!fenceOpen) fenceOpen = { line: i + 1, marker };
    else if (marker[0] === fenceOpen.marker[0] && marker.length >= fenceOpen.marker.length) fenceOpen = null;
  }
  if (fenceOpen) issues.push({ file: path, message: `コードフェンスが閉じていません（${fenceOpen.line} 行目から）` });
  // リスト記号の前に文字が付いた行（例: "[注意] - item"）は Markdown のリストにならない。生成テキストでの崩れを検出する
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^\S[^`]*\s-\s\[[^\]]+\]\s/.test(line) && !/^(\s*[-*+]|\s*\d+\.)\s/.test(line) && !/^#/.test(line) && !/^\|/.test(line)) {
      issues.push({ file: path, message: `${i + 1} 行目: リスト記号「- 」の前に文字があり、リスト項目として表示されません` });
    }
  }
  return issues;
}

/** VerificationResult に加える決定的検証の記録（コマンドではないが同じ形式で扱う） */
export function structureCommandResult(issues: readonly StructureIssue[], durationMs: number): VerificationCommandResult {
  const summary = issues.length === 0 ? '構造検証: 問題なし' : issues.map((i) => `${i.file}: ${i.message}`).join('\n');
  return {
    name: 'structure',
    argv: ['structure-check', 'json', 'yaml', 'markdown'],
    exitCode: issues.length === 0 ? 0 : 1,
    timedOut: false,
    durationMs,
    stdoutExcerpt: summary.slice(0, 6000),
    stderrExcerpt: '',
    truncated: false
  };
}
