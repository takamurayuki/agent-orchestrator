/**
 * ログ・レポートの秘密情報マスキング（SEC-05）。
 * 既知の API キー/トークン形式、`KEY=value` 形式の秘密らしき環境変数、Authorization ヘッダ、PEM 鍵を置き換える。
 * 完全な検出は保証しない（ホワイトリスト方式の allowlisted argv と併用する）。
 */
const PATTERNS: Array<{ name: string; re: RegExp; replace: string }> = [
  { name: 'anthropic', re: /sk-ant-[A-Za-z0-9_-]{10,}/g, replace: '[REDACTED:anthropic-key]' },
  { name: 'openai', re: /sk-(?:proj-)?[A-Za-z0-9_-]{16,}/g, replace: '[REDACTED:openai-key]' },
  { name: 'github', re: /gh[pousr]_[A-Za-z0-9]{20,}/g, replace: '[REDACTED:github-token]' },
  { name: 'aws', re: /AKIA[0-9A-Z]{16}/g, replace: '[REDACTED:aws-key]' },
  { name: 'slack', re: /xox[baprs]-[A-Za-z0-9-]{10,}/g, replace: '[REDACTED:slack-token]' },
  { name: 'jwt', re: /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, replace: '[REDACTED:jwt]' },
  { name: 'bearer', re: /(authorization\s*:\s*bearer\s+)[A-Za-z0-9._~+/=-]+/gi, replace: '$1[REDACTED:bearer]' },
  {
    name: 'env-assign',
    re: /\b((?:[A-Z0-9_]*(?:API_KEY|APIKEY|SECRET|TOKEN|PASSWORD|PASSWD|PRIVATE_KEY|ACCESS_KEY|AUTH)[A-Z0-9_]*)\s*[=:]\s*["']?)([^\s"'&]{6,})/g,
    replace: '$1[REDACTED]'
  },
  { name: 'pem', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, replace: '[REDACTED:private-key]' },
  { name: 'json-secret', re: /("(?:accessToken|refreshToken|id_token|access_token|refresh_token|apiKey|api_key|password|secret|token)"\s*:\s*")([^"]{6,})(")/gi, replace: '$1[REDACTED]$3' }
];

export function maskSecrets(text: string, extraSecrets: readonly string[] = []): string {
  let out = text;
  for (const secret of extraSecrets) {
    if (secret.length >= 6) out = out.split(secret).join('[REDACTED]');
  }
  for (const p of PATTERNS) out = out.replace(p.re, p.replace);
  return out;
}

/** 文字列を UTF-8 バイト上限で打ち切り、打ち切った場合はマーカーを付ける。 */
export function truncateBytes(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const buf = Buffer.from(text, 'utf8');
  if (buf.byteLength <= maxBytes) return { text, truncated: false };
  const head = buf.subarray(0, maxBytes).toString('utf8');
  return { text: `${head}\n...[TRUNCATED ${buf.byteLength - maxBytes} bytes]`, truncated: true };
}

/** 先頭/末尾を残す抜粋（UI 表示用）。 */
export function excerpt(text: string, maxChars = 4000): string {
  if (text.length <= maxChars) return text;
  const half = Math.floor(maxChars / 2);
  return `${text.slice(0, half)}\n...[${text.length - maxChars} chars omitted]...\n${text.slice(-half)}`;
}
