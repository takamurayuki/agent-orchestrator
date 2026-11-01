import type { GeneratedArtifact, VerificationCommandResult } from '@agent-orchestrator/contracts';
import { CONTAINER_WORKSPACE, type SandboxExecutor } from '../isolation/types.js';
import { excerpt } from '../masking.js';

/**
 * 生成物の更新検証（v0.2.1、D-41）。Verifier の一部として、承認済み task の generatedArtifacts ごとに
 *   1. 生成物の正規化ハッシュを取る（固定の node スクリプト。ISO 時刻と行末空白は無視）
 *   2. `pnpm run <script>` をサンドボックス内（network none、workspace rw）で実行する
 *   3. 再びハッシュを取り、1 と一致すれば「最新」= 合格。違えば Builder の出力が古い / 未更新 = 不合格
 * script は package.json の scripts 名だけを受け付ける（任意のシェルコマンドは実行しない）。失敗は AI の推測で覆せない。
 */
const HASH_SCRIPT = [
  "const fs=require('fs');const p=process.argv[1];let t;",
  "try{t=fs.readFileSync(p,'utf8')}catch{console.log('MISSING');process.exit(0)}",
  "t=t.replace(/\\d{4}-\\d{2}-\\d{2}T[\\d:.]+Z/g,'<ts>').replace(/[ \\t]+$/gm,'').replace(/\\r\\n/g,'\\n');",
  "console.log(require('crypto').createHash('sha256').update(t).digest('hex'))"
].join('');

const SCRIPT_NAME_RE = /^[A-Za-z0-9_:.@/-]+$/;

export interface GeneratedVerifyInput {
  runId: string;
  round: number;
  artifacts: readonly GeneratedArtifact[];
  env: Record<string, string>;
  timeoutMs: number;
  signal: AbortSignal;
  onLog: (chunk: string) => void;
}

export async function verifyGeneratedArtifacts(sandbox: SandboxExecutor, input: GeneratedVerifyInput): Promise<VerificationCommandResult[]> {
  const results: VerificationCommandResult[] = [];
  for (const a of input.artifacts) {
    const started = Date.now();
    const name = `generate:${a.script}`;
    const fail = (detail: string, exitCode: number | null = 1, timedOut = false): VerificationCommandResult => ({ name, argv: ['pnpm', 'run', a.script], exitCode, timedOut, durationMs: Date.now() - started, stdoutExcerpt: excerpt(detail, 6000), stderrExcerpt: '', truncated: false });
    if (!SCRIPT_NAME_RE.test(a.script) || a.path.includes('..') || a.path.startsWith('/')) {
      results.push(fail(`生成スクリプト名または生成物パスが不正です: ${a.script} / ${a.path}`));
      continue;
    }
    const hash = async (label: string) => {
      const r = await sandbox.exec(input.runId, { name: `generate-hash-${label}-r${input.round}`, argv: ['node', '-e', HASH_SCRIPT, a.path], workspace: 'rw', aux: 'none', workdir: CONTAINER_WORKSPACE, env: input.env, network: 'none', timeoutMs: 60_000, signal: input.signal });
      return r.exitCode === 0 ? r.stdout.trim() : null;
    };
    input.onLog(`\n$ pnpm run ${a.script}  # 生成物 ${a.path} の更新確認\n`);
    const before = await hash('before');
    const run = await sandbox.exec(input.runId, { name: `generate-${a.script.replace(/[^A-Za-z0-9-]/g, '-')}-r${input.round}`, argv: ['pnpm', 'run', a.script], workspace: 'rw', aux: 'none', workdir: CONTAINER_WORKSPACE, env: input.env, network: 'none', timeoutMs: input.timeoutMs, signal: input.signal, onStdout: input.onLog, onStderr: input.onLog });
    if (run.timedOut) {
      results.push(fail(`生成スクリプト ${a.script} がタイムアウトしました`, null, true));
      continue;
    }
    if (run.exitCode !== 0) {
      results.push(fail(`生成スクリプト ${a.script} が失敗しました（exit ${run.exitCode ?? 'null'}）。ネットワークは遮断されています。\n${run.stderr || run.stdout}`, run.exitCode));
      continue;
    }
    const after = await hash('after');
    if (before === null || after === null) {
      results.push(fail(`生成物 ${a.path} のハッシュを取得できませんでした`));
    } else if (before === 'MISSING' && after === 'MISSING') {
      results.push(fail(`生成スクリプト ${a.script} を実行しても生成物 ${a.path} が作られませんでした（生成先が違う可能性）`));
    } else if (before !== after) {
      results.push(fail(`生成物 ${a.path} が最新ではありません: ${a.script} を再実行すると内容が変わります（Builder が再生成していない、または手で編集した）。${a.script} を実行して結果をそのまま含めてください`));
    } else {
      results.push({ name, argv: ['pnpm', 'run', a.script], exitCode: 0, timedOut: false, durationMs: Date.now() - started, stdoutExcerpt: `生成物 ${a.path} は最新です（${a.script} の再実行で変化なし）`, stderrExcerpt: '', truncated: false });
    }
  }
  return results;
}

/** 完了ゲートが要求する検証コマンド名 */
export function generatedCommandNames(artifacts: readonly GeneratedArtifact[] | undefined): string[] {
  return (artifacts ?? []).map((a) => `generate:${a.script}`);
}
