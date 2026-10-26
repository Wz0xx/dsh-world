import type { IncomingMessage, ServerResponse } from 'node:http';
import { jsonObject, knownHost, readBody, sendJson, type JsonResult } from '../http.ts';
import type { QqBridge } from './bridge.ts';

/**
 * The QQ module's few doors, on the same webServer as the console. The `/dsh-world/qq` prefix is never eaten
 * by the console's `/dsh-world` prefix (the host matches the longer one first).
 *
 * Read:  GET  /dsh-world/qq           is the bridge up, is it talking to DSH, which entries are bound
 * Write: POST /dsh-world/qq/start     bring it up if it is down
 *        POST /dsh-world/qq/stop      ask it to exit gracefully (flushes state first)
 *        POST /dsh-world/qq/bind      { key, sessionId } points a QQ entry at a session
 *        POST /dsh-world/qq/unbind    { key }
 *
 * Writes require the `x-dsh-world` header: a cross-site page cannot add it (that would trigger a preflight,
 * and no preflight is answered here).
 */

export const QQ_PREFIX = '/dsh-world/qq';
export const WRITE_HEADER = 'x-dsh-world';
const MAX_BODY_BYTES = 8 * 1024;
const ok = (body: unknown = { ok: true }): JsonResult => ({ status: 200, body });
const bad = (error: string): JsonResult => ({ status: 400, body: { error } });

function allowed(req: IncomingMessage, allowedHosts: readonly string[]): boolean {
  if (req.headers['sec-fetch-site'] === 'cross-site') return false;
  return knownHost(req.headers.host, allowedHosts);
}

async function write(qq: QqBridge, path: string, body: Record<string, unknown> | undefined): Promise<JsonResult | undefined> {
  switch (path) {
    case '/start': return ok(await qq.start());
    case '/stop': return ok(await qq.stop());
    case '/bind': {
      const key = typeof body?.key === 'string' ? body.key.trim() : '';
      const sessionId = typeof body?.sessionId === 'string' ? body.sessionId.trim() : '';
      if (!key || !sessionId) return bad('key 和 sessionId 都必须是非空字符串');
      if (!/^(group|private):\d+$/.test(key)) return bad('key 形如 group:123 或 private:123');
      return ok(await qq.bind(key, sessionId));
    }
    case '/unbind': {
      const key = typeof body?.key === 'string' ? body.key.trim() : '';
      if (!key) return bad('key 必填');
      return ok(await qq.unbind(key));
    }
    default: return undefined;
  }
}

export function qqRoute(qq: QqBridge, allowedHosts: readonly string[] = []) {
  return {
    kind: 'prefix' as const, path: QQ_PREFIX,
    handler: async (req: IncomingMessage, res: ServerResponse) => {
      if (!allowed(req, allowedHosts)) {
        sendJson(res, { status: 403, body: { error: 'forbidden' } });
        return;
      }
      const url = new URL(req.url ?? QQ_PREFIX, 'http://localhost');
      const path = url.pathname.slice(QQ_PREFIX.length) || '/';
      try {
        if (req.method === 'GET' && (path === '/' || path === '')) {
          sendJson(res, ok(await qq.status()));
          return;
        }
        if (req.method !== 'POST') {
          sendJson(res, { status: 405, body: { error: 'method not allowed' }, headers: { allow: 'GET, POST' } });
          return;
        }
        if (String(req.headers[WRITE_HEADER] ?? '') === '') {
          sendJson(res, { status: 400, body: { error: `写操作必须带 ${WRITE_HEADER} 请求头` } });
          return;
        }
        const body = jsonObject(await readBody(req, MAX_BODY_BYTES));
        const result = await write(qq, path, body);
        sendJson(res, result ?? { status: 404, body: { error: 'not found' } });
      } catch (error) {
        sendJson(res, { status: 500, body: { error: String(error instanceof Error ? error.message : error) } });
      }
    },
  };
}