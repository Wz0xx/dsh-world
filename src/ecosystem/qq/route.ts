import type { IncomingMessage, ServerResponse } from 'node:http';
import { jsonObject, knownHost, readBody, sendJson, type JsonResult } from '../../http.ts';
import type { ConsoleDoors } from './panel.ts';

/**
 * The QQ module's few doors, on the same webServer as the console. The `/dsh-world/qq` prefix is never eaten
 * by the console's `/dsh-world` prefix (the host matches the longer one first).
 *
 * Read:  GET  /dsh-world/qq/native    her own OneBot channel: is it connected, what has it seen, is it replying
 *        GET  /dsh-world/qq/console   SnowLuma's console address, with a session token already traded for the
 *                                     panel password
 * Write: POST /dsh-world/qq/native    { autoReply?, bridge?: { port? } } the channel's switches; a new bridge
 *                                     port restarts the balcony on the spot
 *        POST /dsh-world/qq/panel-password  { username, password } remembers SnowLuma's panel password and
 *                                     trades it for a session token right away
 *
 * Writes require the `x-dsh-world` header: a cross-site page cannot add it (that would trigger a preflight,
 * and no preflight is answered here).
 *
 * There used to be a second half here — start/stop/halt/bind/unbind for the standalone `qq-bridge` process.
 * That process is gone (the channel now lives inside this plugin), so those doors went with it. The route is
 * registered whether or not the channel is switched on: `/native` answers `null` when it is off, and the
 * console door has nothing to do with it — which is why removing the bridge's config did not have to take
 * this endpoint down with it.
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

/**
 * What the panel may change about her own channel: replying, the balcony's port, and when to stay quiet.
 *
 * `mutedUntil` 是 ISO 时间（`null` = 立刻恢复）—— 只停嘴不停耳，到点自己醒。
 */
export interface NativePatch { autoReply?: boolean; bridge?: { port?: number }; mutedUntil?: string | null; startSnowluma?: true }
type SetNative = (patch: NativePatch) => unknown;

async function write(doors: ConsoleDoors | undefined, path: string, body: Record<string, unknown> | undefined, setNative?: SetNative): Promise<JsonResult | undefined> {
  switch (path) {
    case '/native': {
      if (!setNative) return bad('原生通道没有接上');
      const patch: NativePatch = {};
      if (typeof body?.autoReply === 'boolean') patch.autoReply = body.autoReply;
      // 静默：给一个时间点，到点前只收不回；给 null 或空串就是立刻恢复。
      if (body?.mutedUntil !== undefined) {
        const raw = body.mutedUntil;
        if (raw !== null && typeof raw !== 'string') return bad('mutedUntil 要是 ISO 时间字符串，或者 null');
        if (typeof raw === 'string' && raw.trim() !== '' && Number.isNaN(Date.parse(raw))) return bad('mutedUntil 不是能解析的时间');
        patch.mutedUntil = raw === null ? null : String(raw);
      }
      // 阳台：外面那条线开在哪个端口。换端口会打断已经连上的线，所以只认一个整数，别的一律拒。
      const rawBridge = body?.bridge;
      if (rawBridge !== undefined) {
        if (typeof rawBridge !== 'object' || rawBridge === null || Array.isArray(rawBridge)) return bad('bridge 要是一个对象');
        const port = (rawBridge as Record<string, unknown>).port;
        if (port === undefined) return bad('bridge 里要给 port');
        if (typeof port !== 'number' || !Number.isInteger(port) || port < 0 || port > 65535) return bad('bridge.port 要是 0 到 65535 之间的整数');
        patch.bridge = { port };
      }
      // 手动拉起 SnowLuma：只认 true，别的一概不猜。
      if (body?.startSnowluma === true) patch.startSnowluma = true;
      if (patch.autoReply === undefined && patch.bridge === undefined && patch.mutedUntil === undefined && patch.startSnowluma === undefined) {
        return bad('autoReply、bridge、mutedUntil、startSnowluma 至少要给一个');
      }
      return ok(setNative(patch));
    }
    case '/open': {
      if (!doors) return bad('控制台地址没有接上');
      // 只剩一扇门了：桥的控制台随桥一起拆掉了。
      if (body?.kind !== 'snowluma') return bad('kind 只能是 snowluma');
      return ok(await doors.open('snowluma'));
    }
    case '/panel-password': {
      if (!doors) return bad('控制台地址没有接上');
      const username = typeof body?.username === 'string' ? body.username.trim() : '';
      const password = typeof body?.password === 'string' ? body.password : '';
      if (password === '') return bad('密码不能为空');
      return ok({ snowluma: await doors.remember(username, password) });
    }
    default: return undefined;
  }
}

export function qqRoute(allowedHosts: readonly string[] = [], doors?: ConsoleDoors, native?: () => unknown, setNative?: SetNative) {
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
        if (req.method === 'GET' && path === '/native') {
          // 她自己接的那条 OneBot 通道。没开就老实回 null，界面据此显示「没开」。
          sendJson(res, ok(native?.() ?? null));
          return;
        }
        if (req.method === 'GET' && path === '/console') {
          if (!doors) {
            sendJson(res, { status: 404, body: { error: '控制台地址没有接上' } });
            return;
          }
          sendJson(res, ok({ snowluma: await doors.snowluma() }));
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
        const result = await write(doors, path, body, setNative);
        sendJson(res, result ?? { status: 404, body: { error: 'not found' } });
      } catch (error) {
        sendJson(res, { status: 500, body: { error: String(error instanceof Error ? error.message : error) } });
      }
    },
  };
}