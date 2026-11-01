import { loadJsonSchema } from '@agent-orchestrator/contracts';
import { CONTAINER_WORKSPACE, type SandboxExecutor } from '../isolation/types.js';
import { CONTRADICTION_SYSTEM_PROMPT, INTERVIEW_SYSTEM_PROMPT, PROPOSAL_SYSTEM_PROMPT, renderContradictionPrompt, renderInterviewPrompt, renderProposalPrompt, type ContradictionRequest, type InterviewModel, type InterviewRequest, type ModelResult, type ProposalRequest } from '../requirements/gap-analyzer.js';
import { buildClaudeArgs, parseClaudeJson, type ClaudeCredentials } from './claude.js';

/**
 * Requirements Agent のモデル呼び出し（Claude Code CLI の独立呼び出し。Builder とセッションを共有しない）。
 * - ツールは全て無効（--tools ""）。リポジトリの内容はダイジェストとしてプロンプトに含めるだけで、コンテナにマウントしない
 * - --json-schema で構造化出力を要求し、呼び出し側（gap-analyzer）が Zod + JSON Schema で再検証する
 * - 実行は Builder と同じサンドボックス（非 root、egress allowlist）
 */
export class ClaudeInterviewModel implements InterviewModel {
  constructor(
    private readonly sandbox: SandboxExecutor,
    private readonly credentials: () => Promise<ClaudeCredentials>,
    private readonly options: { timeoutMs?: number; maxBudgetUsd?: number } = {}
  ) {}

  private async call(draftKey: string, name: string, systemPrompt: string, prompt: string, schema: Record<string, unknown>, signal: AbortSignal): Promise<ModelResult<unknown>> {
    const creds = await this.credentials();
    const argv = buildClaudeArgs({ systemPrompt, maxBudgetUsd: this.options.maxBudgetUsd ?? 3, allowedTools: [], jsonSchema: JSON.stringify(toClaudeJsonSchema(schema)), toolsOverride: '' });
    let result;
    try {
      result = await this.sandbox.exec(draftKey, {
        name,
        argv,
        stdin: prompt,
        workspace: 'none',
        aux: 'none',
        workdir: CONTAINER_WORKSPACE,
        env: { ...creds.env, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1', DISABLE_TELEMETRY: '1' },
        network: 'egress',
        timeoutMs: this.options.timeoutMs ?? 300_000,
        signal,
        secrets: creds.secrets
      });
    } finally {
      // Draft 単位の呼び出しは使い捨て: ネットワーク・プロキシ・ボリュームを残さない
      await this.sandbox.cleanup(draftKey).catch(() => undefined);
    }
    const raw = result.stdout;
    if (result.spawnError) return { ok: false, error: `Requirements Agent を起動できませんでした: ${result.spawnError}`, raw };
    if (result.timedOut) return { ok: false, error: 'Requirements Agent がタイムアウトしました', raw };
    if (result.exitCode !== 0) return { ok: false, error: `Requirements Agent が異常終了しました (exit ${result.exitCode ?? 'null'}): ${result.stderr.trim().slice(0, 300)}`, raw };
    const parsed = parseClaudeJson(raw);
    if (!parsed) return { ok: false, error: 'Requirements Agent の出力に JSON がありません', raw };
    if (parsed.is_error) return { ok: false, error: `Requirements Agent がエラーを返しました: ${String(parsed.result ?? '').slice(0, 300)}`, raw };
    if (parsed.structured_output !== undefined) return { ok: true, value: parsed.structured_output, raw };
    const text = typeof parsed.result === 'string' ? parsed.result : '';
    const extracted = extractJson(text);
    if (extracted === undefined) return { ok: false, error: 'Requirements Agent の出力を JSON として解釈できません', raw };
    return { ok: true, value: extracted, raw };
  }

  interview(request: InterviewRequest, signal: AbortSignal): Promise<ModelResult<unknown>> {
    return this.call(`draft-${Date.now().toString(36)}`, `interview-r${request.round}`, INTERVIEW_SYSTEM_PROMPT, renderInterviewPrompt(request), loadJsonSchema('interview'), signal);
  }

  propose(request: ProposalRequest, signal: AbortSignal): Promise<ModelResult<unknown>> {
    return this.call(`draft-${Date.now().toString(36)}`, 'proposal', PROPOSAL_SYSTEM_PROMPT, renderProposalPrompt(request), loadJsonSchema('taskProposal'), signal);
  }

  detectContradictions(request: ContradictionRequest, signal: AbortSignal): Promise<ModelResult<unknown>> {
    return this.call(`draft-${Date.now().toString(36)}`, 'contradictions', CONTRADICTION_SYSTEM_PROMPT, renderContradictionPrompt(request), loadJsonSchema('contradiction'), signal);
  }
}

/**
 * Claude Code の `--json-schema` は `$schema`（draft 2020-12 の URI）を解決できず拒否する（LIVE-01 で実測: "no schema with key or ref ..."）。
 * メタ情報だけを落とし、検証内容（型・required・additionalProperties・enum・maxItems 等）はそのまま渡す。
 */
export function toClaudeJsonSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const { $schema: _meta, $id: _id, ...rest } = schema as Record<string, unknown> & { $schema?: unknown; $id?: unknown };
  return rest;
}

export function extractJson(text: string): unknown | undefined {
  const t = text.trim();
  const candidates = [t];
  const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(t);
  if (fence?.[1]) candidates.push(fence[1].trim());
  const first = t.indexOf('{');
  const last = t.lastIndexOf('}');
  if (first >= 0 && last > first) candidates.push(t.slice(first, last + 1));
  for (const c of candidates) {
    try {
      return JSON.parse(c);
    } catch {
      /* next */
    }
  }
  return undefined;
}
