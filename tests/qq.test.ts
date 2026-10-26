import assert from 'node:assert/strict';
import test from 'node:test';
import { Readable } from 'node:stream';
import { QQ_PREFIX, WRITE_HEADER, qqRoute } from '../src/qq/route.ts';
import type { QqBridge } from '../src/qq/bridge.ts';

function request(method: string, path: string, options: { body?: unknown; headers?: Record<string, string> } = {}) {
  const text = options.body === undefined ? '' : JSON.stringify(options.body);
  const stream = Readable.from(text ? [Buffer.from(text)] : []);
  return Object.assign(stream, { method, url: QQ_PREFIX + path, headers: { host: '127.0.0.1:1707', ...options.headers } }) as never;
}
async function call(route: ReturnType<typeof qqRoute>, req: never) {
  let status = 0;
  let body = '';
  const res = { writeHead: (code: number) => { status = code; }, end: (text: string) => { body = text; }, setHeader: () => {}, getHeader: () => undefined, headersSent: false } as never;
  await route.handler(req, res);
  return { status, body: body ? JSON.parse(body) : undefined };
}
function stub(overrides: Partial<QqBridge> = {}): QqBridge {
  const base: QqBridge = {
    status: async () => ({ running: true, port: 3100, dir: 'D:/qq-bridge', dsh: true, sessions: [], faults: [] }),
    start: async () => ({ started: true }),
    stop: async () => ({ stopped: true }),
    bind: async (key, sessionId) => ({ started: true, key, sessionId }),
    unbind: async key => ({ started: true, key }),
    ensureRunning: async () => ({ started: true }),
    syncEndpoint: async () => ({ changed: false }),
    faults: () => [],
  };
  return { ...base, ...overrides };
}
const route = (bridge: QqBridge) => qqRoute(bridge);

test('QQ 状态是 GET，五扇门都是一个前缀下面', async () => {
  const answered = await call(route(stub()), request('GET', '/'));
  assert.equal(answered.status, 200);
  assert.equal(answered.body.running, true);
  const shaped = qqRoute(stub());
  assert.deepEqual({ kind: shaped.kind, path: shaped.path }, { kind: 'prefix', path: '/dsh-world/qq' });
});

test('写操作必须带 x-dsh-world 头，跨站来的连读都不给', async () => {
  assert.equal((await call(route(stub()), request('POST', '/start'))).status, 400);
  assert.equal((await call(route(stub()), request('POST', '/start', { headers: { [WRITE_HEADER]: '1', 'sec-fetch-site': 'cross-site' } }))).status, 403);
  const ok = await call(route(stub()), request('POST', '/start', { headers: { [WRITE_HEADER]: '1' } }));
  assert.equal(ok.status, 200);
  assert.equal(ok.body.started, true);
  // 认不出来的路径是 404，不是把请求交给 console。
  assert.equal((await call(route(stub()), request('POST', '/nope', { headers: { [WRITE_HEADER]: '1' } }))).status, 404);
});

test('绑定只接受 group:数字 和 private:数字，缺会话 id 直接拒', async () => {
  const seen: string[] = [];
  const bridge = stub({ bind: async (key, sessionId) => { seen.push(`${key}=${sessionId}`); return { started: false, key, sessionId }; } });
  const headers = { [WRITE_HEADER]: '1' };
  assert.equal((await call(route(bridge), request('POST', '/bind', { headers, body: { key: 'group:681528723' } }))).status, 400);
  assert.equal((await call(route(bridge), request('POST', '/bind', { headers, body: { key: 'someone', sessionId: 'session-1' } }))).status, 400);
  const ok = await call(route(bridge), request('POST', '/bind', { headers, body: { key: 'group:681528723', sessionId: 'session-1' } }));
  assert.equal(ok.status, 200);
  assert.deepEqual(seen, ['group:681528723=session-1']);
});