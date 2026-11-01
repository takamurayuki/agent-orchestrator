import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ClaudeCredentials } from './agents/claude.js';
import type { CodexCredentials } from './agents/codex.js';

/**
 * ホストに設定済みの CLI 認証を、最小権限でコンテナに注入するための読み出し。
 * - Claude: ANTHROPIC_API_KEY / CLAUDE_CODE_OAUTH_TOKEN 環境変数、無ければ ~/.claude/.credentials.json の OAuth accessToken を
 *   CLAUDE_CODE_OAUTH_TOKEN として渡す（値はログからマスキング）
 * - Codex: OPENAI_API_KEY 環境変数、無ければ ~/.codex/auth.json を read-only bind mount
 * 認証情報の自動取得・ログインは行わない（MVP 対象外）。見つからなければ例外（preflight が先に検出する）。
 */
export class CredentialsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CredentialsError';
  }
}

export async function loadClaudeCredentials(env: NodeJS.ProcessEnv = process.env): Promise<ClaudeCredentials> {
  if (env.ANTHROPIC_API_KEY) return { env: { ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY }, secrets: [env.ANTHROPIC_API_KEY] };
  if (env.CLAUDE_CODE_OAUTH_TOKEN) return { env: { CLAUDE_CODE_OAUTH_TOKEN: env.CLAUDE_CODE_OAUTH_TOKEN }, secrets: [env.CLAUDE_CODE_OAUTH_TOKEN] };
  const file = join(env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), '.credentials.json');
  if (!existsSync(file)) throw new CredentialsError('Claude の認証情報が見つかりません（ANTHROPIC_API_KEY / CLAUDE_CODE_OAUTH_TOKEN / ~/.claude/.credentials.json）');
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { claudeAiOauth?: { accessToken?: string; expiresAt?: number } };
    const token = parsed.claudeAiOauth?.accessToken;
    if (!token) throw new CredentialsError('~/.claude/.credentials.json に OAuth accessToken がありません');
    if (parsed.claudeAiOauth?.expiresAt && parsed.claudeAiOauth.expiresAt < Date.now()) {
      throw new CredentialsError('Claude の OAuth トークンが期限切れです。ホストで `claude` を起動して再ログインしてください');
    }
    return { env: { CLAUDE_CODE_OAUTH_TOKEN: token }, secrets: [token] };
  } catch (err) {
    if (err instanceof CredentialsError) throw err;
    throw new CredentialsError(`~/.claude/.credentials.json を読めません: ${(err as Error).message}`);
  }
}

export async function loadCodexCredentials(env: NodeJS.ProcessEnv = process.env): Promise<CodexCredentials> {
  if (env.OPENAI_API_KEY) return { authJsonPath: null, env: { OPENAI_API_KEY: env.OPENAI_API_KEY }, secrets: [env.OPENAI_API_KEY] };
  const file = join(env.CODEX_HOME ?? join(homedir(), '.codex'), 'auth.json');
  if (!existsSync(file)) throw new CredentialsError('Codex の認証情報が見つかりません（OPENAI_API_KEY / ~/.codex/auth.json）');
  const secrets: string[] = [];
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    for (const v of collectStrings(parsed)) if (v.length >= 16) secrets.push(v);
  } catch {
    /* マスキング用の抽出に失敗しても注入は可能 */
  }
  return { authJsonPath: file, env: {}, secrets };
}

function collectStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const v of value) collectStrings(v, out);
  else if (value && typeof value === 'object') for (const v of Object.values(value)) collectStrings(v, out);
  return out;
}
