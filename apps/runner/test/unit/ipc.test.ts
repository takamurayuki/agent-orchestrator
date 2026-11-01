import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { IpcError, IpcServer } from '../../src/ipc.js';

const server = () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const chunks: string[] = [];
  output.on('data', (c: Buffer) => chunks.push(c.toString('utf8')));
  const s = new IpcServer(input, output);
  return { s, input, output, lines: () => chunks.join('').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>) };
};

describe('IPC server (SPEC §10.1)', () => {
  it('rejects methods outside the allowlist and malformed requests', async () => {
    const { s } = server();
    expect((await s.handleLine(JSON.stringify({ id: '1', method: 'shell.exec', params: { cmd: 'rm -rf /' } })))?.error?.code).toBe('METHOD_NOT_ALLOWED');
    expect((await s.handleLine('{not json'))?.error?.code).toBe('INVALID_REQUEST');
    expect((await s.handleLine(JSON.stringify({ id: '1', method: 'run.start' })))?.error?.code).toBe('INVALID_REQUEST');
    expect(await s.handleLine('')).toBeNull();
  });

  it('validates params per method and reports unimplemented methods', async () => {
    const { s } = server();
    s.register('run.start', async (p) => ({ started: p }));
    expect((await s.handleLine(JSON.stringify({ id: '2', method: 'run.start', params: {} })))?.error?.code).toBe('INVALID_PARAMS');
    expect((await s.handleLine(JSON.stringify({ id: '3', method: 'run.start', params: { approvedTaskId: 'AT', extra: 1 } })))?.error?.code).toBe('INVALID_PARAMS');
    const ok = await s.handleLine(JSON.stringify({ id: '4', method: 'run.start', params: { approvedTaskId: 'AT' } }));
    expect(ok).toEqual({ id: '4', ok: true, result: { started: { approvedTaskId: 'AT' } } });
    expect((await s.handleLine(JSON.stringify({ id: '5', method: 'run.cancel', params: { runId: 'r' } })))?.error?.code).toBe('METHOD_NOT_ALLOWED');
  });

  it('maps service errors to codes and masks secrets in messages', async () => {
    const { s } = server();
    s.register('run.cancel', async () => {
      throw new IpcError('NOT_FOUND', 'run not found');
    });
    s.register('run.list', async () => {
      throw new Error('leak ANTHROPIC_API_KEY=sk-ant-api03-abcdefghijklmnopqrstuvwxyz');
    });
    expect((await s.handleLine(JSON.stringify({ id: '1', method: 'run.cancel', params: { runId: 'x' } })))?.error).toMatchObject({ code: 'NOT_FOUND' });
    const r = await s.handleLine(JSON.stringify({ id: '2', method: 'run.list', params: {} }));
    expect(r?.error?.code).toBe('INTERNAL_ERROR');
    expect(r?.error?.message).not.toContain('sk-ant-api03-abcdefghijklmnopqrstuvwxyz');
  });

  it('streams responses and events in order over stdio', async () => {
    const { s, input, lines } = server();
    s.register('run.list', async () => ({ runs: [] }));
    s.start();
    s.emit({ event: 'runner.ready', payload: { version: '0.1.0' } });
    input.write(`${JSON.stringify({ id: 'a', method: 'run.list', params: {} })}\n`);
    input.write(`${JSON.stringify({ id: 'b', method: 'nope', params: {} })}\n`);
    await new Promise((r) => setTimeout(r, 50));
    s.emit({ event: 'run.event', runId: 'r', payload: { sequence: 1 } });
    await s.flush();
    await new Promise((r) => setTimeout(r, 20));
    const out = lines();
    expect(out[0]).toMatchObject({ event: 'runner.ready' });
    expect(out.find((l) => l.id === 'a')).toMatchObject({ ok: true });
    expect((out.find((l) => l.id === 'b') as { error: { code: string } }).error.code).toBe('METHOD_NOT_ALLOWED');
    expect(out[out.length - 1]).toMatchObject({ event: 'run.event', runId: 'r' });
  });
});
