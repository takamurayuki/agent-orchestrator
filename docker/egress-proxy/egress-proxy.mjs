// egress プロキシ。EGRESS_ALLOWLIST（カンマ区切りホスト名）にあるホストへの CONNECT / HTTP 転送だけを許し、他は 403。
// allow/deny を 1 行 JSON で stdout に記録する（docker logs で回収し runs/<runId>/egress.jsonl に保存）。
// 依存なし（node:http / node:net）。ホスト名は完全一致（大文字小文字区別なし）。"*.example.com" はサブドメイン一致。
import http from 'node:http';
import net from 'node:net';

const port = Number(process.env.EGRESS_PORT ?? 3128);
const allowlist = (process.env.EGRESS_ALLOWLIST ?? '')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter((s) => s !== '');

function isAllowed(host) {
  const h = String(host).toLowerCase();
  return allowlist.some((entry) => (entry.startsWith('*.') ? h.endsWith(entry.slice(1)) || h === entry.slice(2) : h === entry));
}

function log(record) {
  process.stdout.write(`${JSON.stringify({ ts: new Date().toISOString(), ...record })}\n`);
}

function splitHostPort(value, defaultPort) {
  const m = /^\[?([^\]]+?)\]?(?::(\d+))?$/.exec(value ?? '');
  if (!m) return null;
  return { host: m[1], port: m[2] ? Number(m[2]) : defaultPort };
}

const server = http.createServer((req, res) => {
  let target;
  try {
    target = new URL(req.url ?? '');
  } catch {
    res.writeHead(400).end('bad request');
    return;
  }
  const host = target.hostname;
  if (!isAllowed(host)) {
    log({ action: 'deny', method: req.method, host, port: target.port || 80 });
    res.writeHead(403, { 'content-type': 'text/plain' }).end(`egress denied: ${host}\n`);
    return;
  }
  log({ action: 'allow', method: req.method, host, port: target.port || 80 });
  const upstream = http.request({ host, port: target.port || 80, method: req.method, path: `${target.pathname}${target.search}`, headers: req.headers }, (up) => {
    res.writeHead(up.statusCode ?? 502, up.headers);
    up.pipe(res);
  });
  upstream.on('error', (err) => {
    log({ action: 'error', method: req.method, host, error: err.message });
    if (!res.headersSent) res.writeHead(502);
    res.end();
  });
  req.pipe(upstream);
});

server.on('connect', (req, socket, head) => {
  const parsed = splitHostPort(req.url, 443);
  if (!parsed) {
    socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    return;
  }
  const { host, port: targetPort } = parsed;
  if (!isAllowed(host)) {
    log({ action: 'deny', method: 'CONNECT', host, port: targetPort });
    socket.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n');
    return;
  }
  log({ action: 'allow', method: 'CONNECT', host, port: targetPort });
  const upstream = net.connect(targetPort, host, () => {
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head && head.length > 0) upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });
  upstream.on('error', (err) => {
    log({ action: 'error', method: 'CONNECT', host, port: targetPort, error: err.message });
    socket.destroy();
  });
  socket.on('error', () => upstream.destroy());
});

server.listen(port, '0.0.0.0', () => {
  log({ action: 'start', port, allowlist });
});
