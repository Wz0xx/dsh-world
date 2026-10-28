import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync, rmSync } from 'node:fs';
import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { jsonObject, knownHost, readBody, sendJson, type JsonResult } from '../../http.ts';
import { speakerIdentity, type SpeakerIdentity } from '../shared/identity.ts';
import { durableWrite } from '../../life/lifeStore.ts';
import { createWechatHome } from './home.ts';
import type { PreparedReply, WechatReceipt } from './archive.ts';
import { channelContext, channelMedia, channelReference, type ChannelContextMessage, type ChannelReference } from '../shared/context.ts';
import { admitContextImages } from './images.ts';
import { dirname, join } from 'node:path';
import { createWechatSending } from './sending.ts';
import { createWechatReading } from './reading.ts';

export const WECHAT_PATH = '/dsh-world/wechat/ask';

export function createWechatModule(deps: { ctx: Context; home(identity: SpeakerIdentity): Promise<Agent>; file: string; worldId?: string; acceptAgent?(agent: Agent): boolean; incomingDir?: string; origin(): string; allowedHosts: readonly string[]; settings?(): { contextMessages: number; bufferSeconds: number }; record?(reply: PreparedReply): Promise<string>; receipt?(receipt: WechatReceipt): Promise<void> }) {
  const token = randomBytes(32).toString('hex');
  const sending = createWechatSending({ ...deps, file: join(dirname(deps.file), 'wechat-outbox.sqlite'), worldId: deps.worldId ?? 'default' });
  const reading = createWechatReading({ target: sending.target });
  const attached = new Map<Agent, (() => void)[]>();
  const requests = new Set<Promise<JsonResult>>();
  let closing: Promise<void> | undefined;
  let stopped = false;
  let lastContactAt: string | undefined;
  /** What the adapter last said about the WeChat account itself; only the adapter knows whether it is logged in. */
  let accountState: 'online' | 'offline' | undefined;
  const settings = () => deps.settings?.() ?? { contextMessages: 8, bufferSeconds: 3 };
  function attach(agent: Agent) {
    if (stopped || attached.has(agent)) return;
    const disposers: (() => void)[] = [];
    try { for (const tool of [...sending.tools, reading.tool]) disposers.push(agent.ctx.tools.register(tool)); attached.set(agent, disposers); }
    catch (error) { for (const dispose of disposers.reverse()) dispose(); throw error; }
  }
  const detachCreate = deps.ctx.on('agent/created', ({ agent }) => { if (deps.acceptAgent?.(agent)) attach(agent); return undefined; });
  const detachDispose = deps.ctx.on('agent/disposed', ({ agent }) => { attached.delete(agent); });
  const home = createWechatHome({ ...deps, home: async identity => { const agent = await deps.home(identity); attach(agent); return agent; }, images: async (identity, context, reference) => {
    if (!reference?.image && !context.some(message => message.image || message.reference?.image)) return [];
    if (!deps.incomingDir) throw new Error('Group image directory is unavailable');
    return admitContextImages(deps.ctx, deps.incomingDir, identity, context, reference);
  } });
  async function handle(req: IncomingMessage): Promise<JsonResult> {
    const given = req.headers['x-dsh-world-token'];
    if (!knownHost(req.headers.host, deps.allowedHosts) || req.headers['sec-fetch-site'] === 'cross-site' || typeof given !== 'string') return { status: 403, body: { error: 'forbidden' } };
    const bytes = Buffer.from(given), expected = Buffer.from(token);
    if (bytes.length !== expected.length || !timingSafeEqual(bytes, expected)) return { status: 403, body: { error: 'forbidden' } };
    if (stopped) return { status: 503, body: { error: 'wechat unavailable' } };
    lastContactAt = new Date().toISOString();
    if (req.method !== 'POST') return { status: 405, body: { error: 'method not allowed' }, headers: { allow: 'POST' } };
    const body = jsonObject(await readBody(req, 64 * 1024));
    if (body && 'status' in body) {
      const reported = (body.status as { wechat?: unknown } | null)?.wechat;
      if (reported !== 'online' && reported !== 'offline') return { status: 400, body: { error: 'bad status' } };
      accountState = reported; return { status: 200, body: { accepted: true } };
    }
    if (body && 'outbox' in body) {
      try { const job = await sending.poll(body.outbox); const read = reading.poll(); accountState = 'online'; return { status: 200, body: { accepted: true, settings: settings(), ...(job ? { job } : {}), ...(read ? { read } : {}) } }; }
      catch (error) { deps.ctx.logger.warn('dsh-world WeChat outbox failed:', error); return { status: 400, body: { error: 'invalid WeChat outbox binding or pending job; check adapter configuration' } }; }
    }
    if (body && 'readResult' in body) {
      try { reading.accept(body.readResult); return { status: 200, body: { accepted: true } }; }
      catch (error) { deps.ctx.logger.warn('dsh-world WeChat read failed:', error); return { status: 400, body: { error: 'invalid WeChat history result' } }; }
    }
    if (body && 'receipt' in body) {
      const receipt = body.receipt as Partial<WechatReceipt> | null;
      if (!receipt || typeof receipt !== 'object' || typeof receipt.id !== 'string' || !/^[a-f0-9]{64}$/.test(receipt.id)
        || !Number.isSafeInteger(receipt.confirmed) || receipt.confirmed! < 0 || receipt.confirmed! > 16
        || !['sent', 'uncertain', 'failed'].includes(receipt.status ?? '')) return { status: 400, body: { error: 'bad receipt' } };
      try { await sending.receipt(receipt as WechatReceipt); return { status: 200, body: { accepted: true } }; }
      catch (error) { deps.ctx.logger.warn('dsh-world WeChat receipt failed:', error); return { status: 503, body: { error: 'receipt not recorded; retry receipt only' } }; }
    }
    const text = typeof body?.text === 'string' ? body.text.trim() : '';
    let identity: SpeakerIdentity; let context: ChannelContextMessage[]; let media: ChannelContextMessage[]; let reference: ChannelReference | undefined;
    try { identity = speakerIdentity(body?.identity); context = channelContext(body?.context, identity, settings().contextMessages); media = channelMedia(body?.media, identity); reference = channelReference(body?.reference, identity); } catch { return { status: 400, body: { error: 'bad identity or context' } }; }
    if ((!text && !media.length && !reference) || [...text].length > 2000) return { status: 400, body: { error: 'bad request' } };
    if (identity.channel !== 'wechat') return { status: 400, body: { error: 'bad channel' } };
    if ((identity.conversationType === 'group') !== identity.conversationId.endsWith('@chatroom')) return { status: 400, body: { error: 'bad conversation type' } };
    try { return { status: 200, body: { accepted: true, ...(await home.ask(text, identity, context, media, reference)) } }; }
    catch (error) { deps.ctx.logger.warn('dsh-world WeChat request failed:', error); return { status: 503, body: { error: 'home request failed; delivery must be checked before retrying' } }; }
  }
  return {
    status() { return { ...sending.status(), lastContactAt: lastContactAt ?? null, account: accountState ?? null, ...settings() }; },
    start() {
      durableWrite(deps.file, JSON.stringify({ origin: deps.origin(), token, path: WECHAT_PATH, pid: process.pid, protocol: 4, references: true }, null, 2));
      for (const agent of deps.ctx.agents.list()) if (deps.acceptAgent?.(agent)) attach(agent);
    },
    stop() {
      if (stopped) return closing;
      stopped = true; reading.stop(); home.stop();
      detachCreate(); detachDispose();
      for (const disposers of attached.values()) for (const dispose of disposers.reverse()) { try { dispose(); } catch { /* agent already disposed */ } }
      attached.clear();
      try { if (JSON.parse(readFileSync(deps.file, 'utf8')).token === token) rmSync(deps.file, { force: true }); } catch { /* already absent, or a newer module owns the file */ }
      return closing = Promise.allSettled([...requests]).then(() => sending.stop());
    },
    route: { kind: 'exact' as const, path: WECHAT_PATH, handler: async (req: IncomingMessage, res: ServerResponse) => {
      let result: JsonResult;
      const request = handle(req); requests.add(request);
      try { result = await request; } catch { result = { status: 500, body: { error: 'internal error' } }; }
      finally { requests.delete(request); }
      sendJson(res, result);
    } },
  };
}
export type WechatModule = ReturnType<typeof createWechatModule>;
