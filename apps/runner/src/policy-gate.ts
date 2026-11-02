import ts from 'typescript';
import type { DiffFile, PolicyFinding } from '@agent-orchestrator/contracts';
import { PY_CONFIG_RE, PY_FILE_RE, PY_TEST_FILE_RE, collectPythonSuppressions, collectPythonTestSkips, pythonConfigChanges } from './policy-gate-python.js';

/**
 * Policy Gate（v2.1、SPEC §7 / §9 の差分ポリシーを拡張）。AI レビューとは独立した静的チェック。純粋関数。
 *
 * 対象（ベースコミットと作業ツリーの比較。既存の違反は数えない）:
 *   PG-ESLINT-DISABLE       新規の eslint-disable 系コメント
 *   PG-TS-SUPPRESS          新規の @ts-ignore / @ts-nocheck
 *   PG-TEST-SKIP            テストの skip / only / x* / f* 追加（AST）
 *   PG-TEST-DELETED         テストファイルの削除
 *   PG-VERIFY-SCRIPT        必須検証 scripts（typecheck / lint / test:run）の削除・無効化・変更
 *   PG-TSCONFIG-RELAXED     tsconfig の strict 系フラグの緩和、exclude の追加
 *   PG-ESLINT-RELAXED       ESLint 設定でのルール無効化・格下げ、ignores の追加（AST）
 *   PG-TESTCONFIG-RELAXED   Vitest / Jest / Playwright 設定での除外追加・passWithNoTests（AST）
 *
 * 判定の原則:
 *   - 「新規」= ベースの内容に存在しないもの（位置ではなく内容の多重集合で比較。移動は検出しない）
 *   - AST が必要なもの（skip/only、設定ファイル）は TypeScript コンパイラ API で解析し、文字列内の一致は無視する
 *   - 例外（承認済み）はベースコミットの `.agent-orchestrator/policy.json` からのみ読む。作業ツリー側の変更は無視する
 *     （AI は現在の Run の間に例外を増やせない）
 */

export const POLICY_RULE_IDS = ['PG-ESLINT-DISABLE', 'PG-TS-SUPPRESS', 'PG-TEST-SKIP', 'PG-TEST-DELETED', 'PG-VERIFY-SCRIPT', 'PG-TSCONFIG-RELAXED', 'PG-ESLINT-RELAXED', 'PG-TESTCONFIG-RELAXED', 'PG-UNPARSEABLE', 'PG-ANALYSIS-ERROR', 'PG-PY-NOQA', 'PG-PY-TYPE-IGNORE', 'PG-PY-TEST-SKIP', 'PG-PY-CONFIG-RELAXED'] as const;
export type PolicyRuleId = (typeof POLICY_RULE_IDS)[number];

export interface PolicyException {
  ruleId: PolicyRuleId;
  /** glob（* と ** のみ）。省略時は全ファイル */
  file?: string;
  reason: string;
}

export interface PolicyGateInput {
  files: readonly DiffFile[];
  /** 変更ファイルのベース内容（削除・変更ファイル）。無いものは null */
  baseContents: Record<string, string | null>;
  /** 変更ファイルの作業ツリー内容（追加・変更ファイル）。無いものは null */
  currentContents: Record<string, string | null>;
  /** ベースコミットの .agent-orchestrator/policy.json（人間が管理）。不正なら無視 */
  exceptions?: readonly PolicyException[];
  /** 必須検証 scripts（プロファイル） */
  requiredScripts?: readonly string[];
}

export interface PolicyGateResult {
  findings: PolicyFinding[];
  /** 未承認の blocking 違反 */
  blocking: PolicyFinding[];
  passed: boolean;
}

const TEST_FILE_RE = /(^|\/)(__tests__|tests?|spec|e2e)\/|\.(test|spec)\.[cm]?[jt]sx?$/i;
const CODE_FILE_RE = /\.([cm]?[jt]sx?)$/i;
const ESLINT_CONFIG_RE = /(^|\/)(eslint\.config\.[cm]?[jt]s|\.eslintrc(\.[cm]?js|\.json|\.yml|\.yaml)?)$/i;
const TSCONFIG_RE = /(^|\/)tsconfig(\.[^/]+)?\.json$/i;
const TESTCONFIG_RE = /(^|\/)(vitest|jest|playwright|vite)\.config\.[cm]?[jt]s$/i;
const PACKAGE_JSON_RE = /(^|\/)package\.json$/;
const DEFAULT_REQUIRED_SCRIPTS = ['typecheck', 'lint', 'test:run'];
const NOOP_SCRIPT_RE = /^\s*(?:echo\b.*|true|:|exit\s+0|)\s*$/;
const STRICT_FLAGS = ['strict', 'noImplicitAny', 'strictNullChecks', 'strictFunctionTypes', 'strictBindCallApply', 'strictPropertyInitialization', 'noImplicitThis', 'alwaysStrict', 'noUnusedLocals', 'noUnusedParameters', 'noImplicitReturns', 'noFallthroughCasesInSwitch', 'noUncheckedIndexedAccess', 'exactOptionalPropertyTypes', 'noImplicitOverride', 'useUnknownInCatchVariables'];

// ---------------------------------------------------------------------------------------------
// ユーティリティ
// ---------------------------------------------------------------------------------------------

/** 多重集合の差（after にあって before に無い分） */
function newItems<T>(before: T[], after: T[], key: (x: T) => string): T[] {
  const counts = new Map<string, number>();
  for (const b of before) counts.set(key(b), (counts.get(key(b)) ?? 0) + 1);
  const out: T[] = [];
  for (const a of after) {
    const k = key(a);
    const c = counts.get(k) ?? 0;
    if (c > 0) counts.set(k, c - 1);
    else out.push(a);
  }
  return out;
}

function lineOf(text: string, pos: number): number {
  let line = 1;
  for (let i = 0; i < pos && i < text.length; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

function scriptKind(path: string): ts.ScriptKind {
  if (/\.tsx$/i.test(path)) return ts.ScriptKind.TSX;
  if (/\.jsx$/i.test(path)) return ts.ScriptKind.JSX;
  if (/\.[cm]?js$/i.test(path)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function parse(path: string, text: string): ts.SourceFile {
  return ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, scriptKind(path));
}

/** 構文エラー（パーサ診断）。TS の SourceFile は内部プロパティ parseDiagnostics を持つ（公開 API には無いが安定して存在） */
export function syntaxErrors(path: string, text: string): string[] {
  const sf = parse(path, text);
  const diags = (sf as unknown as { parseDiagnostics?: ts.Diagnostic[] }).parseDiagnostics ?? [];
  return diags.slice(0, 5).map((d) => `${lineOf(text, d.start ?? 0)}: ${ts.flattenDiagnosticMessageText(d.messageText, ' ')}`);
}

function globToRegExp(glob: string): RegExp {
  const esc = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*\//g, '(?:.*/)?').replace(/\*\*/g, '.*').replace(/\*/g, '[^/]*');
  return new RegExp(`^${esc}$`);
}

export function parsePolicyExceptions(json: string | null): PolicyException[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json) as { allow?: unknown };
    if (!parsed || !Array.isArray(parsed.allow)) return [];
    return parsed.allow
      .filter((e): e is PolicyException => typeof e === 'object' && e !== null && typeof (e as PolicyException).ruleId === 'string' && (POLICY_RULE_IDS as readonly string[]).includes((e as PolicyException).ruleId) && typeof (e as PolicyException).reason === 'string' && (e as PolicyException).reason.trim() !== '')
      .map((e) => ({ ruleId: e.ruleId, reason: e.reason, ...(typeof e.file === 'string' ? { file: e.file } : {}) }));
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------------------------
// コメント系（eslint-disable / ts-ignore）: TS スキャナでコメント trivia だけを見る（文字列内の一致を無視）
// ---------------------------------------------------------------------------------------------

interface CommentHit {
  kind: 'eslint-disable' | 'ts-suppress';
  text: string;
  line: number;
}

const ESLINT_DISABLE_RE = /^\s*(?:\/\*|\/\/)\s*eslint-disable(?:-next-line|-line)?\b/;
const TS_SUPPRESS_RE = /^\s*\/\/\s*@ts-(?:ignore|nocheck)\b/;

/**
 * コメントはパーサ駆動で収集する（全ノード/トークンの leading / trailing comment range）。
 * 素の scanner.scan() ループはテンプレートリテラルの `${}` 以降を正しく字句解析できず、行末の
 * `// eslint-disable-line` を取り逃がす（v2.1 実機検証で発覚した偽陰性）。
 */
export function collectSuppressComments(path: string, text: string): CommentHit[] {
  const sf = parse(path, text);
  const hits: CommentHit[] = [];
  const seen = new Set<number>();
  const addRange = (r: ts.CommentRange) => {
    if (seen.has(r.pos)) return;
    seen.add(r.pos);
    const comment = text.slice(r.pos, r.end);
    const normalized = comment.replace(/\r?\n/g, ' ');
    if (ESLINT_DISABLE_RE.test(normalized)) hits.push({ kind: 'eslint-disable', text: normalized.trim().slice(0, 160), line: lineOf(text, r.pos) });
    else if (TS_SUPPRESS_RE.test(normalized)) hits.push({ kind: 'ts-suppress', text: normalized.trim().slice(0, 160), line: lineOf(text, r.pos) });
  };
  const visit = (node: ts.Node) => {
    for (const r of ts.getLeadingCommentRanges(text, node.getFullStart()) ?? []) addRange(r);
    for (const r of ts.getTrailingCommentRanges(text, node.getEnd()) ?? []) addRange(r);
    for (const child of node.getChildren(sf)) visit(child);
  };
  visit(sf);
  for (const r of ts.getLeadingCommentRanges(text, sf.endOfFileToken.getFullStart()) ?? []) addRange(r);
  hits.sort((a, b) => a.line - b.line);
  return hits;
}

// ---------------------------------------------------------------------------------------------
// テスト skip / only（AST）
// ---------------------------------------------------------------------------------------------

interface SkipHit {
  text: string;
  line: number;
}

const TEST_FNS = new Set(['it', 'test', 'describe', 'suite', 'bench']);
const SKIP_PROPS = new Set(['skip', 'only', 'todo']);
const PREFIXED = new Set(['xit', 'xtest', 'xdescribe', 'fit', 'fdescribe', 'ftest']);

export function collectTestSkips(path: string, text: string): SkipHit[] {
  const sf = parse(path, text);
  const hits: SkipHit[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      // it.skip(...) / describe.only(...) / test.skip.each(...)(...)。外側の呼び出し（callee が CallExpression）は内側で数えるので除く
      let root: ts.Expression = callee;
      let sawSkip = false;
      while (ts.isPropertyAccessExpression(root)) {
        if (SKIP_PROPS.has(root.name.text)) sawSkip = true;
        root = root.expression;
      }
      if (ts.isIdentifier(root)) {
        if (sawSkip && TEST_FNS.has(root.text)) hits.push({ text: callee.getText(sf).slice(0, 80), line: lineOf(text, node.getStart(sf)) });
        else if (PREFIXED.has(root.text) && root === callee) hits.push({ text: root.text, line: lineOf(text, node.getStart(sf)) });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return hits;
}

// ---------------------------------------------------------------------------------------------
// 設定の緩和
// ---------------------------------------------------------------------------------------------

interface ConfigHit {
  text: string;
  line: number;
  /** 省略時 blocking。warning は完了を妨げないが内容を提示する（検証の追加・強化） */
  severity?: 'blocking' | 'warning';
}

/**
 * 検証 scripts の変更分類（v2.2、Phase 4）。
 *   - 削除 / no-op 化 → blocking
 *   - 旧コマンド全体が新コマンドに含まれ、`&&` / `;` で別コマンドが追加されている、または厳格化フラグが追加された → 「強化」として warning（内容を提示）
 *   - それ以外（機械的に強化と判断できない） → blocking（人間の承認＝ベースコミットの例外登録が必要）
 */
const STRENGTHEN_FLAGS = ['--max-warnings', '--max-warnings=0', '--strict', '--noEmit', '--frozen-lockfile', '--coverage', '--run', '--bail', '--reporter=junit', '--passWithNoTests=false'];
export function classifyScriptChange(was: string, now: string): 'removed' | 'noop' | 'strengthened' | 'unknown' | 'unchanged' {
  const w = was.trim();
  const n = now.trim();
  if (n === w) return 'unchanged';
  if (NOOP_SCRIPT_RE.test(n)) return 'noop';
  if (n.includes(w)) {
    const rest = n.replace(w, '').trim();
    if (/^(&&|;)\s*\S/.test(rest) || /\S\s*(&&|;)$/.test(rest)) return 'strengthened';
    const addedFlags = rest.split(/\s+/).filter(Boolean);
    if (addedFlags.length > 0 && addedFlags.every((f) => STRENGTHEN_FLAGS.some((k) => f === k || f.startsWith(`${k}=`)) || /^--max-warnings(=\d+)?$/.test(f) || f === '0')) return 'strengthened';
  }
  return 'unknown';
}

export function parseJsonc(path: string, text: string): Record<string, unknown> | null {
  const r = ts.parseConfigFileTextToJson(path, text);
  // 構文エラーがあれば（寛容パーサが部分的な config を返しても）解析不能として扱う（fail-closed、v2.2）
  if (r.error) return null;
  return r.config && typeof r.config === 'object' ? (r.config as Record<string, unknown>) : null;
}

/** tsconfig: strict 系フラグが true → false/削除、exclude の追加 */
export function tsconfigRelaxations(path: string, before: string | null, after: string | null): ConfigHit[] {
  // 新規の tsconfig（ベース無し）や削除は「緩和」とみなさない（削除は tsc が失敗し検証で検出される）
  if (!after || !before) return [];
  const b = parseJsonc(path, before);
  const a = parseJsonc(path, after);
  if (!a) return [];
  const hits: ConfigHit[] = [];
  const bOpts = (b?.compilerOptions as Record<string, unknown> | undefined) ?? {};
  const aOpts = (a.compilerOptions as Record<string, unknown> | undefined) ?? {};
  for (const flag of STRICT_FLAGS) {
    if (bOpts[flag] === true && aOpts[flag] !== true) hits.push({ text: `compilerOptions.${flag}: true → ${JSON.stringify(aOpts[flag] ?? 'removed')}`, line: findLine(after, `"${flag}"`) });
  }
  const bEx = Array.isArray(b?.exclude) ? (b!.exclude as string[]) : [];
  const aEx = Array.isArray(a.exclude) ? (a.exclude as string[]) : [];
  for (const e of newItems(bEx, aEx, (x) => String(x))) hits.push({ text: `exclude += ${JSON.stringify(e)}`, line: findLine(after, JSON.stringify(e)) });
  return hits;
}

function findLine(text: string, needle: string): number {
  const idx = text.indexOf(needle);
  return idx < 0 ? 1 : lineOf(text, idx);
}

/** package.json: 必須 scripts の削除 / no-op 化 / 変更 */
export function verifyScriptChanges(before: string | null, after: string | null, required: readonly string[]): ConfigHit[] {
  if (!after) return required.map((s) => ({ text: `package.json が削除され scripts.${s} が失われた`, line: 1 }));
  interface Pkg {
    scripts?: Record<string, unknown>;
  }
  let b: Pkg | null = null;
  let a: Pkg | null = null;
  try {
    a = JSON.parse(after) as Pkg;
  } catch {
    return [{ text: 'package.json が JSON として解釈できない', line: 1 }];
  }
  try {
    b = before ? (JSON.parse(before) as Pkg) : null;
  } catch {
    b = null;
  }
  const hits: ConfigHit[] = [];
  for (const s of required) {
    const was = b?.scripts?.[s];
    const now = a?.scripts?.[s];
    if (typeof was !== 'string') continue; // ベースに無いものは対象外（readiness で別途判定）
    if (typeof now !== 'string') {
      hits.push({ text: `scripts.${s} が削除された（was: ${was}）`, line: findLine(after, '"scripts"') });
      continue;
    }
    const kind = classifyScriptChange(was, now);
    if (kind === 'noop') hits.push({ text: `scripts.${s} が無効化された: ${JSON.stringify(now)}`, line: findLine(after, `"${s}"`) });
    else if (kind === 'strengthened') hits.push({ text: `scripts.${s} が強化された（要確認）: ${JSON.stringify(was)} → ${JSON.stringify(now)}`, line: findLine(after, `"${s}"`), severity: 'warning' });
    else if (kind === 'unknown') hits.push({ text: `scripts.${s} が変更された（強化と機械的に判断できないため人間の承認が必要）: ${JSON.stringify(was)} → ${JSON.stringify(now)}`, line: findLine(after, `"${s}"`) });
  }
  return hits;
}

interface RuleSetting {
  rule: string;
  severity: string;
}

function literalToSeverity(node: ts.Expression): string | null {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isNumericLiteral(node)) return node.text;
  if (ts.isArrayLiteralExpression(node) && node.elements[0]) return literalToSeverity(node.elements[0]);
  return null;
}

function propName(p: ts.PropertyAssignment): string | null {
  const n = p.name;
  if (ts.isIdentifier(n) || ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) return n.text;
  return null;
}

/** ESLint 設定（JS / JSON）から rules の設定と ignores を集める */
export function collectEslintSettings(path: string, text: string): { rules: RuleSetting[]; ignores: string[] } {
  const rules: RuleSetting[] = [];
  const ignores: string[] = [];
  if (/\.(json|yml|yaml)$/i.test(path) || /\.eslintrc$/.test(path)) {
    const cfg = parseJsonc(path, text);
    if (cfg) {
      const r = (cfg.rules as Record<string, unknown> | undefined) ?? {};
      for (const [rule, v] of Object.entries(r)) rules.push({ rule, severity: String(Array.isArray(v) ? v[0] : v) });
      for (const i of Array.isArray(cfg.ignorePatterns) ? (cfg.ignorePatterns as string[]) : []) ignores.push(String(i));
    }
    return { rules, ignores };
  }
  const sf = parse(path, text);
  const visit = (node: ts.Node) => {
    if (ts.isPropertyAssignment(node)) {
      const name = propName(node);
      if (name === 'rules' && ts.isObjectLiteralExpression(node.initializer)) {
        for (const p of node.initializer.properties) {
          if (ts.isPropertyAssignment(p)) {
            const rule = propName(p);
            const sev = literalToSeverity(p.initializer);
            if (rule && sev !== null) rules.push({ rule, severity: sev });
          }
        }
      }
      if ((name === 'ignores' || name === 'ignorePatterns') && ts.isArrayLiteralExpression(node.initializer)) {
        for (const el of node.initializer.elements) if (ts.isStringLiteral(el)) ignores.push(el.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return { rules, ignores };
}

const SEVERITY_RANK: Record<string, number> = { '0': 0, off: 0, '1': 1, warn: 1, '2': 2, error: 2 };

/** ESLint: ルールの off 化 / 格下げ、ignores の追加 */
export function eslintRelaxations(path: string, before: string | null, after: string | null): ConfigHit[] {
  if (!after) return [{ text: 'ESLint 設定ファイルが削除された', line: 1 }];
  const a = collectEslintSettings(path, after);
  const b = before ? collectEslintSettings(path, before) : { rules: [], ignores: [] };
  const hits: ConfigHit[] = [];
  const bRules = new Map<string, number>();
  for (const r of b.rules) bRules.set(r.rule, Math.max(bRules.get(r.rule) ?? 0, SEVERITY_RANK[r.severity] ?? 2));
  for (const r of a.rules) {
    const rank = SEVERITY_RANK[r.severity] ?? 2;
    const was = bRules.get(r.rule);
    if (was === undefined) {
      if (rank === 0) hits.push({ text: `rule ${r.rule} を off に設定（新規）`, line: findLine(after, r.rule) });
    } else if (rank < was) {
      hits.push({ text: `rule ${r.rule} を格下げ（${was} → ${rank}）`, line: findLine(after, r.rule) });
    }
  }
  for (const i of newItems(b.ignores, a.ignores, (x) => x)) hits.push({ text: `ignores += ${JSON.stringify(i)}`, line: findLine(after, i) });
  return hits;
}

/** Vitest / Jest / Playwright 設定: exclude / testPathIgnorePatterns / testIgnore の追加、passWithNoTests: true の追加 */
export function testConfigRelaxations(path: string, before: string | null, after: string | null): ConfigHit[] {
  if (!after) return [{ text: 'テスト設定ファイルが削除された', line: 1 }];
  const collect = (text: string) => {
    const sf = parse(path, text);
    const excludes: string[] = [];
    let passWithNoTests = false;
    const visit = (node: ts.Node) => {
      if (ts.isPropertyAssignment(node)) {
        const name = propName(node);
        if ((name === 'exclude' || name === 'testPathIgnorePatterns' || name === 'testIgnore' || name === 'ignore') && ts.isArrayLiteralExpression(node.initializer)) {
          for (const el of node.initializer.elements) if (ts.isStringLiteral(el) || ts.isRegularExpressionLiteral(el)) excludes.push(el.getText(sf));
        }
        if (name === 'passWithNoTests' && node.initializer.kind === ts.SyntaxKind.TrueKeyword) passWithNoTests = true;
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
    return { excludes, passWithNoTests };
  };
  const a = collect(after);
  const b = before ? collect(before) : { excludes: [], passWithNoTests: false };
  const hits: ConfigHit[] = [];
  for (const e of newItems(b.excludes, a.excludes, (x) => x)) hits.push({ text: `テスト除外 += ${e}`, line: findLine(after, e.replace(/^['"`]|['"`]$/g, '')) });
  if (a.passWithNoTests && !b.passWithNoTests) hits.push({ text: 'passWithNoTests: true が追加された', line: findLine(after, 'passWithNoTests') });
  return hits;
}

// ---------------------------------------------------------------------------------------------
// ゲート本体
// ---------------------------------------------------------------------------------------------

export function evaluatePolicyGate(input: PolicyGateInput): PolicyGateResult {
  const findings: PolicyFinding[] = [];
  const exceptions = input.exceptions ?? [];
  const required = input.requiredScripts ?? DEFAULT_REQUIRED_SCRIPTS;
  const add = (ruleId: PolicyRuleId, file: string, line: number, evidence: string, message: string, severity: 'blocking' | 'warning' = 'blocking') => {
    const approvedBy = exceptions.find((e) => e.ruleId === ruleId && (!e.file || globToRegExp(e.file).test(file)));
    findings.push({ ruleId, severity, file, line, evidence: evidence.slice(0, 200), message, approved: Boolean(approvedBy), approvalReason: approvedBy?.reason ?? null });
  };

  for (const f of input.files) {
    const path = f.path.replace(/\\/g, '/');
    const before = input.baseContents[f.path] ?? null;
    const after = f.status === 'deleted' ? null : (input.currentContents[f.path] ?? null);

    if (f.status === 'deleted' && (TEST_FILE_RE.test(path) || PY_TEST_FILE_RE.test(path))) {
      add('PG-TEST-DELETED', f.path, 1, `deleted (${f.deletions} lines)`, 'テストファイルが削除された');
      continue;
    }
    if (after === null) continue;

    // 検出器自身の例外・解析不能は成功として扱わない（fail-closed）
    try {
      if (PY_FILE_RE.test(path)) {
        // Python（v0.3、D-45）: 行単位の保守的な検出
        const bHits = before ? collectPythonSuppressions(before) : [];
        const aHits = collectPythonSuppressions(after);
        for (const h of newItems(bHits, aHits, (x) => `${x.kind}:${x.text}`)) {
          if (h.kind === 'noqa') add('PG-PY-NOQA', f.path, h.line, h.text, '新規の # noqa。lint の指摘を抑制せずコードを規約に合わせること');
          else add('PG-PY-TYPE-IGNORE', f.path, h.line, h.text, '新規の # type: ignore / # pyright: ignore。型エラーを抑制せず修正すること');
        }
        if (PY_TEST_FILE_RE.test(path)) {
          const bSkips = before ? collectPythonTestSkips(before) : [];
          const aSkips = collectPythonTestSkips(after);
          for (const sk of newItems(bSkips, aSkips, (x) => x.text)) add('PG-PY-TEST-SKIP', f.path, sk.line, sk.text, 'テストの skip / xfail の追加');
        }
      } else if (PY_CONFIG_RE.test(path)) {
        for (const h of pythonConfigChanges(path, before, after)) add('PG-PY-CONFIG-RELAXED', f.path, h.line, h.text, h.severity === 'blocking' ? '検証ツール設定の緩和（ignore / exclude / deselect 等）' : '検証ツール設定の変更（内容を確認）', h.severity);
      } else if (CODE_FILE_RE.test(path) && !PACKAGE_JSON_RE.test(path)) {
        const errors = syntaxErrors(path, after);
        if (errors.length > 0) add('PG-UNPARSEABLE', f.path, Number(errors[0]?.split(':')[0]) || 1, errors.join(' | '), '構文エラーのため静的ポリシーを確定できない（判定不能）。コードを構文的に正しくすること');
        // コメント系（移動は検出しないよう内容の多重集合で比較）。構文エラーがあっても可能な範囲で解析する
        const bHits = before ? collectSuppressComments(path, before) : [];
        const aHits = collectSuppressComments(path, after);
        for (const h of newItems(bHits, aHits, (x) => `${x.kind}:${x.text}`)) {
          if (h.kind === 'eslint-disable') add('PG-ESLINT-DISABLE', f.path, h.line, h.text, '新規の eslint-disable コメント。ルールを無効化せずコードを規約に合わせること');
          else add('PG-TS-SUPPRESS', f.path, h.line, h.text, '新規の @ts-ignore / @ts-nocheck。型エラーを抑制せず修正すること');
        }
        if (TEST_FILE_RE.test(path)) {
          const bSkips = before ? collectTestSkips(path, before) : [];
          const aSkips = collectTestSkips(path, after);
          for (const sk of newItems(bSkips, aSkips, (x) => x.text)) add('PG-TEST-SKIP', f.path, sk.line, sk.text, 'テストの skip / only / todo の追加');
        }
        if (ESLINT_CONFIG_RE.test(path)) for (const h of eslintRelaxations(path, before, after)) add('PG-ESLINT-RELAXED', f.path, h.line, h.text, 'ESLint 設定の緩和', h.severity);
        if (TESTCONFIG_RE.test(path)) for (const h of testConfigRelaxations(path, before, after)) add('PG-TESTCONFIG-RELAXED', f.path, h.line, h.text, 'テスト設定の緩和', h.severity);
      } else if (PACKAGE_JSON_RE.test(path)) {
        // ルート直下の package.json だけ検証 scripts を見る（ワークスペースパッケージの scripts はプロファイル外）
        if (!path.includes('/')) {
          for (const h of verifyScriptChanges(before, after, required)) {
            add('PG-VERIFY-SCRIPT', f.path, h.line, h.text, h.severity === 'warning' ? '検証コマンドの追加・強化（内容を確認）' : '必須検証コマンドの削除・無効化・変更', h.severity);
          }
        }
      } else if (TSCONFIG_RE.test(path)) {
        if (!parseJsonc(path, after)) add('PG-UNPARSEABLE', f.path, 1, 'tsconfig を JSON として解釈できない', '設定ファイルが解析不能（判定不能）');
        for (const h of tsconfigRelaxations(path, before, after)) add('PG-TSCONFIG-RELAXED', f.path, h.line, h.text, 'TypeScript 設定の緩和', h.severity);
      } else if (ESLINT_CONFIG_RE.test(path)) {
        for (const h of eslintRelaxations(path, before, after)) add('PG-ESLINT-RELAXED', f.path, h.line, h.text, 'ESLint 設定の緩和', h.severity);
      }
    } catch (err) {
      add('PG-ANALYSIS-ERROR', f.path, 1, (err instanceof Error ? err.message : String(err)).slice(0, 200), 'ポリシー検出器が解析中に例外を起こした（判定不能）。人間が差分を確認すること');
    }
  }
  // package.json が削除された場合
  for (const f of input.files) {
    if (f.status === 'deleted' && !f.path.includes('/') && PACKAGE_JSON_RE.test(f.path)) add('PG-VERIFY-SCRIPT', f.path, 1, 'deleted', 'package.json が削除された');
  }

  const blocking = findings.filter((x) => x.severity === 'blocking' && !x.approved);
  return { findings, blocking, passed: blocking.length === 0 };
}

/** Builder へのフィードバック文（修正可能にする）。 */
export function renderPolicyFeedback(findings: readonly PolicyFinding[]): string[] {
  return findings.filter((f) => !f.approved).map((f) => `[${f.ruleId}] ${f.file}:${f.line} — ${f.message}\n  evidence: ${f.evidence}`);
}
