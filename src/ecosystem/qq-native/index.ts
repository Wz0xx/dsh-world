import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { speakerIdentity, conversationKey, type SpeakerIdentity } from '../shared/identity.ts';
import type { ChannelContextMessage } from '../shared/context.ts';
import { createBridge } from './snowluma.ts';
import { createSnowlumaSupervisor, type SnowlumaStatus } from '../qq/supervisor.ts';
import { createQqHome } from './home.ts';
import { createNativeBridge, type BridgeStatus, type NativeBridge } from './native-bridge.ts';

/** The largest single message we accept from QQ; anything longer is cut before it reaches her. */
const MAX_INCOMING = 2_000;
/** How many distinct messages we remember to drop repeats of. */
const SEEN_LIMIT = 500;
/**
 * 问她要不要先开口时说的那段话。
 *
 * 她自己决定说什么 —— 想说的那句就是原话；不想说话，回 [SILENT] 就行（和旧桥一样的约定，
 * 但这边不再有候选表、分数和重试：一次问一句，说不说都算一次调用）。
 */

/**
 * What we actually read off an incoming message.
 *
 * The transport (`snowluma.ts`) hands over its own normalized shape; this is the part of it the
 * module depends on, written out here so the wiring does not lean on that file's type names.
 */
interface QqIncoming {
  kind: 'group' | 'private';
  groupId: string | null;
  userId: string;
  messageId: string;
  selfId: string;
  text: string;
  sender?: { nickname?: string; card?: string | null } | undefined;
  /** 原始段数组（OneBot 的 message）。群里那句是不是在叫她，看的就是它。 */
  segments?: Array<{ type?: string; data?: Record<string, unknown> }> | undefined;
}

export interface QqNativeConfig {
  enabled: boolean;
  wsUrl: string;
  accessToken: string;
  /** QQ numbers allowed to talk to her at all; empty means nobody. */
  allowPrivate: readonly string[];
  /**
   * 她自己开口时（时间轮说完的那一轮）推给谁。
   *
   * 空着就退回 allowPrivate 的第一个 —— 只留一个主人的用法照旧能用。但插件是给别人用的，
   * 白名单里可能有第二个人、顺序也可能变，那时候推的就不是主人了，所以要有这一项。
   */
  ownerQQ: string;
  /** SnowLuma 装在哪儿。看门狗和「拉起来」按钮都靠它。 */
  snowlumaHome: string;
  /** 插件自己盯着 3003：不通就拉。默认开。 */
  supervise: boolean;
  allowGroups: readonly string[];
  /** 她会不会回。关掉是「收到但不理」——连问都不问，不花调用。 */
  autoReply: boolean;
  /** How many earlier messages of the same conversation are shown to her with each new one. */
  contextMessages: number;
  /** 群里什么时候接话：mention 只接被叫到的（被 @ / 被引用她的消息 / 命中关键词），all 每句都接。 */
  groupTrigger: 'mention' | 'all';
  /** 群里命中这些词也算在叫她。 */
  groupKeywords: readonly string[];
  /** Who shares her home session: `owner` keeps it for the owner's private chat, `none` gives every
   *  conversation its own, empty follows whatever the bridge's own setting says. */
  bindHomeSession: 'owner' | 'all' | 'none' | '';
  /** 阳台：让这台机器上别的程序能跟家里说话的那条线。`port` 为 0 就整块不开。 */
  bridge: { port: number; token: string; title: string; contextMessages: number };
  /**
   * 只停嘴不停耳：这个时间之前收到的话照旧进上下文，但一句都不回。空字符串 = 没静默。
   * 跟 autoReply 的区别是它会自己醒 —— autoReply 关了要人再拨回来，这个到点就恢复。
   */
  mutedUntil: string;
}

export interface QqNativeStatus {
  enabled: boolean;
  connected: boolean;
  url: string;
  allowPrivate: number;
  allowGroups: number;
  autoReply: boolean;
  conversations: number;
  answering: number;
  lastEventAt: string | null;
  lastError: string | null;
  sent: number;
  failed: number;
  /** 阳台那条线现在什么样（没开就是 null）。 */
  bridge: BridgeStatus | null;
  /** 到了通道、但不在白名单里被挡下的条数。 */
  blocked: number;
  /** 最近一次被白名单挡下的时刻。 */
  lastBlockedAt: string | null;
  bindHomeSession: 'owner' | 'all' | 'none' | '';
  /** 群里接话的规矩。 */
  groupTrigger: 'mention' | 'all';
  /** 现在是不是在静默里（mutedUntil 还没到点）。 */
  muted: boolean;
  /** 静默到什么时候；没静默就是 null。 */
  mutedUntil: string | null;
  /** 还没发出去、在队列里等重试的条数。 */
  outbox: number;
  /** 看门狗：插件自己盯 SnowLuma 那条线的状态。 */
  supervisor: SnowlumaStatus;
}

/**
 * QQ as another way into the same home, without a bridge process in between.
 *
 * One OneBot connection in, the same `home` the WeChat channel uses in the middle, and a reply sent
 * back out. There is no separate session store: a conversation's identity key is the whole mapping,
 * so a group keeps talking to the same conversation she already has for it.
 */
/** 传输层交给通道的那几件（真身上是 snowluma.js 的 createBridge，测试可以换掉）。 */
/** 一条 QQ 消息可以带的东西。text/at/image/face 是 snowluma.ts 的 buildSegments 认的那几种。 */
export type QqPart =
  | { type: 'text'; text: string }
  | { type: 'at'; qq: string }
  | { type: 'image'; file: string }
  | { type: 'face'; id: string }
  /** 账号收藏表情。**不是消息段**，走 send_custom_face 单发一条。 */
  | { type: 'sticker'; emojiId: string };

export interface QqTransport {
  start(): Promise<void>;
  stop(): Promise<void>;
  getState(): string;
  sendGroup(groupId: string, parts: string | QqPart[]): Promise<{ messageId: string }>;
  sendPrivate(userId: string, parts: string | QqPart[]): Promise<{ messageId: string }>;
  /** 发账号收藏表情；测试桩可以不实现。 */
  sendCustomFace?(
    emojiId: string,
    target: { groupId?: string; userId?: string },
  ): Promise<{ messageId: string }>;
}

/**
 * 把她这句话里的 `[[img:路径]]` / `[[face:id]]` / `[[at:qq]]` 切成段。
 *
 * 为什么用标记而不是让整条回复变成 JSON：她说的是人话，绝大多数条目都是纯文本，
 * 标记只在真要发图/表情时才出现；没有标记就原样返回一个字符串，走的是和以前完全一样的那条路。
 * 方括号叠两层的写法不常见，不会误伤 markdown 里的 `[文字](链接)`。
 */
export function buildReplyParts(text: string): string | QqPart[] {
  const tag = /\[\[(img|face|at|sticker):([^\[\]]+)\]\]/g;
  const parts: QqPart[] = [];
  let last = 0;
  for (let m = tag.exec(text); m; m = tag.exec(text)) {
    if (m.index > last) parts.push({ type: 'text', text: text.slice(last, m.index) });
    const value = m[2].trim();
    if (m[1] === 'img') parts.push({ type: 'image', file: value });
    else if (m[1] === 'face') parts.push({ type: 'face', id: value });
    else if (m[1] === 'sticker') parts.push({ type: 'sticker', emojiId: value });
    else parts.push({ type: 'at', qq: value });
    last = m.index + m[0].length;
  }
  if (!parts.length) return text;
  if (last < text.length) parts.push({ type: 'text', text: text.slice(last) });
  return parts;
}

/** createBridge 认的那几个选项，通道只用到这几个。 */
export interface QqTransportOptions {
  wsUrl: string;
  accessToken?: string;
  log(level: string, message: string): void;
  onGroupMessage?(message: unknown): void;
  onPrivateMessage?(message: unknown): void;
  onNotice?(type: string, notice?: unknown): void;
}

export function createQqNativeModule(deps: {
  ctx: Context;
  home(identity: SpeakerIdentity): Promise<Agent>;
  config(): QqNativeConfig;
  /** 面板拨的开关存这儿；不给就只在内存里活到下一次重载。 */
  stateFile?: string;
  logger: { info(...args: unknown[]): void; warn(...args: unknown[]): void; error(...args: unknown[]): void };
  /** 传输层；不给就用真身（snowluma.js 那条线）。测试靠它把合成事件灌进来。 */
  transport?(options: QqTransportOptions): QqTransport;
}) {
  const home = createQqHome({ ctx: deps.ctx, home: deps.home });
  // 看门狗：插件在，就盯着 SnowLuma 那条线。拉不起来只记不吼。
  const supervisor = createSnowlumaSupervisor({
    homeDir: deps.config().snowlumaHome,
    host: '127.0.0.1',
    port: Number(new URL(deps.config().wsUrl).port || 3003),
    log: (message: string) => deps.logger.info(message),
  });
  const seen = new Set<string>();
  const contexts = new Map<string, ChannelContextMessage[]>();
  const answering = new Set<string>();
  const BATCH_QUIET_MS = 10_000;
  const BATCH_MAX_MS = 30_000;
  const batches = new Map<string, { identity: SpeakerIdentity; entries: { text: string; who: string }[]; timer: ReturnType<typeof setTimeout> }>();
  const batchOpenedAt = new Map<string, number>();
  // 她自己的那条线：最后一次见到的账号。
  let lastSelfId = '';
  let client: QqTransport | undefined;
  let nativeBridge: NativeBridge | undefined;
  let stopped = false;
  // 面板要的那几个数自己记：传输层只交出一个 getState()，不带计数。
  const stats: { sent: number; failed: number; blocked: number; lastEventAt: string | null; lastBlockedAt: string | null; lastError: string | null } = {
    sent: 0, failed: 0, blocked: 0, lastEventAt: null, lastBlockedAt: null, lastError: null,
  };

  /**
   * 发不出去的回复先排这儿。
   *
   * 重载插件会停 `QQ module` 两秒，正好落在中间的回复从 `sendGroup` 里直接抛出来、然后被 catch 掉
   * —— 那句话就没了。日志里是 `QQ 回复 … 失败: QQ module is stopped`，2026-10-27 17:52 撞过两次。
   * 现在抛出来的话进这个队，模块回来以后每 3 秒试一次，最多留 5 分钟。
   */
  const outbox: { kind: 'group' | 'private'; target: string; parts: string | QqPart[]; tries: number; firstAt: number }[] = [];
  const OUTBOX_TTL_MS = 5 * 60_000;
  const OUTBOX_MAX_TRIES = 40;
  let outboxTimer: ReturnType<typeof setInterval> | undefined;

  async function flushOutbox(): Promise<void> {
    if (!outbox.length || stopped) return;
    const now = Date.now();
    for (let i = outbox.length - 1; i >= 0; i -= 1) {
      const item = outbox[i];
      if (now - item.firstAt > OUTBOX_TTL_MS || item.tries > OUTBOX_MAX_TRIES) {
        outbox.splice(i, 1);
        stats.failed += 1;
        stats.lastError = '排在队里太久，放弃了';
        continue;
      }
      try {
        if (item.kind === 'group') rememberSent((await client?.sendGroup(item.target, item.parts))?.messageId);
        else rememberSent((await client?.sendPrivate(item.target, item.parts))?.messageId);
        outbox.splice(i, 1);
        stats.sent += 1;
      } catch {
        item.tries += 1;
      }
    }
  }

  /** 发一条；发不出去就排队，不往上游抛。 */
  /** 最近一次回答是被谁问出来的：群还是私聊。群的话已经回给群了，不用再往私聊补。 */
  let lastAsk: { isGroup: boolean; at: number } | null = null;

  /** 刚发出去的文本，几秒内不再发第二遍：回复那条路和「自己的话」那条路不会各发一次。 */
  const sentTexts = new Map<string, number>();
  function noteSentText(parts: string | QqPart[]): void {
    const text = typeof parts === 'string'
      ? parts
      : parts.filter((part) => part.type === 'text').map((part) => (part as { text: string }).text).join('');
    if (!text) return;
    const now = Date.now();
    sentTexts.set(text.trim(), now);
    for (const [key, at] of sentTexts) if (now - at > 120000) sentTexts.delete(key);
  }
  function alreadySent(text: string): boolean {
    const at = sentTexts.get(text.trim());
    return at !== undefined && Date.now() - at < 60000;
  }

  async function sendOrQueue(kind: 'group' | 'private', target: string, parts: string | QqPart[]): Promise<void> {
    try {
      if (kind === 'group') rememberSent((await client?.sendGroup(target, parts))?.messageId);
      else rememberSent((await client?.sendPrivate(target, parts))?.messageId);
      noteSentText(parts);
    } catch (error) {
      outbox.push({ kind, target, parts, tries: 1, firstAt: Date.now() });
      stats.lastError = error instanceof Error ? error.message : String(error);
      deps.logger.warn(`QQ 这条没发出去，先排队（${outbox.length} 条待发）: ${stats.lastError}`);
    }
  }

  // 拨过的开关写在 stateFile 里，重载不丢；配置里那个是出厂默认。
  let overrides: { autoReply?: boolean; bridge?: { port?: number }; mutedUntil?: string | null } = {};
  let overridesRead = false;
  function readOverrides(): void {
    if (overridesRead) return;
    overridesRead = true;
    const file = deps.stateFile;
    if (!file) return;
    try { overrides = JSON.parse(readFileSync(file, 'utf8')) as { autoReply?: boolean; bridge?: { port?: number }; mutedUntil?: string | null }; } catch { overrides = {}; }
  }
  function writeOverrides(): void {
    const file = deps.stateFile;
    if (!file) return;
    try { writeFileSync(file, JSON.stringify(overrides, null, 2) + '\n', 'utf8'); } catch (error) { deps.logger.warn('QQ 原生通道：开关没存下来', error); }
  }
  const settings = (): QqNativeConfig => {
    readOverrides();
    const base = deps.config();
    // 面板上改过端口就以面板为准；其余字段还是配置里那套。
    const bridge = overrides.bridge?.port === undefined ? base.bridge : { ...base.bridge, port: overrides.bridge.port };
    return {
      ...base,
      ...(overrides.autoReply === undefined ? {} : { autoReply: overrides.autoReply }),
      ...(overrides.mutedUntil === undefined ? {} : { mutedUntil: overrides.mutedUntil ?? '' }),
      bridge,
    };
  };

  function remember(messageId: string): boolean {
    if (!messageId) return true;
    if (seen.has(messageId)) return false;
    seen.add(messageId);
    if (seen.size > SEEN_LIMIT) { const first = seen.values().next().value; if (first !== undefined) seen.delete(first); }
    return true;
  }

  // 她说出去的消息 id。有人引用她的话，引用的就是这个 id。
  const sentIds = new Set<string>();
  function rememberSent(id: unknown): void {
    const value = id == null ? '' : String(id);
    if (value === '') return;
    sentIds.add(value);
    if (sentIds.size > SEEN_LIMIT) {
      const oldest = sentIds.values().next().value;
      if (oldest !== undefined) sentIds.delete(oldest);
    }
  }

  /**
   * 群里这句是不是在叫她。
   *
   * 量过：不做这个判断时，群里没被叫到的每一句都会让她跑完一整轮、还往群里冒一条——哪怕她自己在话里
   * 写的是「这句不接」，钱和噪声都已经花了。所以只有被 @ 到、有人引用过她的话、或者命中配的关键词，
   * 才把话递到她跟前；其余只记进那个群的上下文，等她真被叫到时知道刚才在说什么。
   */
  function directedAtHer(message: QqIncoming, config: QqNativeConfig): boolean {
    if (config.groupTrigger === 'all') return true;
    for (const segment of message.segments ?? []) {
      const data = segment?.data ?? {};
      // @全体 不算叫她 —— 那是群公告，不是喊她。
      if (segment?.type === 'at' && String(data.qq ?? '') === message.selfId) return true;
      if (segment?.type === 'reply' && data.id != null && sentIds.has(String(data.id))) return true;
    }
    return config.groupKeywords.some(word => word !== '' && message.text.includes(word));
  }

  /** 现在是不是在静默里。mutedUntil 空着或已过期都算醒着。 */
  function isMuted(config: QqNativeConfig): boolean {
    const until = (config.mutedUntil ?? '').trim();
    if (!until) return false;
    const at = Date.parse(until);
    return Number.isFinite(at) && Date.now() < at;
  }

  function allowed(identity: SpeakerIdentity): boolean {
    const config = settings();
    return identity.conversationType === 'group'
      ? config.allowGroups.includes(identity.conversationId)
      : config.allowPrivate.includes(identity.speakerId.slice('qq:'.length));
  }

  function pushContext(key: string, message: ChannelContextMessage, limit: number) {
    const list = contexts.get(key) ?? [];
    list.push(message);
    while (list.length > Math.max(1, Math.min(limit, 20))) list.shift();
    contexts.set(key, list);
  }

  async function deliver(message: QqIncoming) {
    if (stopped) return;
    const config = settings();
    if (!config.enabled) return;
    const messageId = message.messageId;
    if (!remember(messageId)) return;
    const selfId = message.selfId;
    const userId = message.userId;
    // Her own words come back through the same socket; answering them would be talking to herself.
    if (!userId || userId === selfId) return;
    const text = message.text.trim().slice(0, MAX_INCOMING);
    if (!text) return;
    const isGroup = message.kind === 'group';
    const conversationId = isGroup ? message.groupId ?? '' : userId;
    if (!conversationId) return;
    stats.lastEventAt = new Date().toISOString();
    // 有人说话了：房间安静了多久她得记得，顺带记住自己这个号是哪个。
    lastSelfId = selfId || lastSelfId;
    // 引擎开没开都得记 —— 不然开关一拨开，它以为「一直没人说过话」。
    const speakerName = message.sender?.card || message.sender?.nickname || '';
    let identity: SpeakerIdentity;
    try {
      identity = speakerIdentity({
        channel: 'qq',
        accountId: selfId || '0',
        speakerId: `qq:${userId}`,
        ...(speakerName ? { speakerName } : {}),
        conversationId,
        conversationType: isGroup ? 'group' : 'private',
        ...(isGroup ? { conversationName: `群 ${conversationId}` } : {}),
        ...(messageId ? { platformMessageId: messageId } : {}),
      });
    } catch (error) { deps.logger.warn('QQ 消息身份不合法:', error); return; }
    // 不在白名单也算「到过」：不然分不清「消息根本没送到」和「送到了但被白名单挡下」——
    // 明天拿手机发一条时，这两件事的区别就是全部的意义。
    if (!allowed(identity)) {
      stats.blocked += 1;
      stats.lastBlockedAt = new Date().toISOString();
      return;
    }
    const key = conversationKey(identity);
    // 关掉自动回复的意思就是「别理它」：连问都不问。原来是先问完再决定发不发，
    // 于是开关关着每条还是照样花一轮（今晚拿假服务器实测：两条合成消息各烧了一轮）。
    // 群里没叫她的消息只进上下文，不开口、不花一轮。私聊不受这条管。
    if (isGroup && !directedAtHer(message, config)) {
      pushContext(key, { id: messageId || String(Date.now()), occurredAt: new Date().toISOString(), text, identity }, config.contextMessages);
      return;
    }

    // 静默：话照收、上下文照记，就是不出声。到点自己醒，不用谁来拨。
    if (isMuted(config)) {
      pushContext(key, { id: messageId || `${Date.now()}`, occurredAt: new Date().toISOString(), text, identity }, config.contextMessages);
      return;
    }
    if (!config.autoReply || stopped) {
      pushContext(key, { id: messageId || `${Date.now()}`, occurredAt: new Date().toISOString(), text, identity }, config.contextMessages);
      return;
    }
    enqueue(key, text, identity, speakerName);
  /**
   * 合批：同一会话里 10 秒内的话攒成一条再问她。人连着发两三条是常态，每条各跑一轮
   * 等于拿半句话问她两次。窗口从最后一条算起（安静 10 秒就送），但从第一条起最多等
   * 30 秒，免得群里一直有人说话、它永远不开口。
   */
  function enqueue(key: string, text: string, identity: SpeakerIdentity, who: string): void {
    const now = Date.now();
    const live = batches.get(key);
    if (live) {
      live.entries.push({ text, who });
      live.identity = identity;
    } else {
      batches.set(key, { identity, entries: [{ text, who }], timer: undefined as unknown as ReturnType<typeof setTimeout> });
      batchOpenedAt.set(key, now);
    }
    const batch = batches.get(key)!;
    const openedAt = batchOpenedAt.get(key) ?? now;
    const wait = Math.max(0, Math.min(BATCH_QUIET_MS, BATCH_MAX_MS - (now - openedAt)));
    clearTimeout(batch.timer);
    batch.timer = setTimeout(() => { void flushBatch(key); }, wait);
    answering.add(key);
  }

  async function flushBatch(key: string): Promise<void> {
    const batch = batches.get(key);
    if (!batch) return;
    // 攒的这十秒里开关可能被关掉：那时候别问、也别发。
    if (stopped || !settings().autoReply) {
      batches.delete(key);
      batchOpenedAt.delete(key);
      clearTimeout(batch.timer);
      answering.delete(key);
      return;
    }
    batches.delete(key);
    batchOpenedAt.delete(key);
    clearTimeout(batch.timer);
    const identity = batch.identity;
    const config = settings();
    const context = contexts.get(key) ?? [];
    const text = batch.entries.length === 1
      ? batch.entries[0].text
      : batch.entries.map((entry) => (entry.who ? `${entry.who}: ${entry.text}` : entry.text)).join('\n');

    answering.add(key);
    try {
      const answer = await home.ask(text, identity, context);
      // 她那句话记成她自己说的：不然后面拿这段上下文问她「刚才聊到哪了」时，
      // 她说过的会被当成对方说的（home.ts 里按 speakerId 判 role 为 assistant）。
      const herIdentity = speakerIdentity({
        channel: 'qq',
        accountId: identity.accountId,
        speakerId: `qq:${identity.accountId}`,
        conversationId: identity.conversationId,
        conversationType: identity.conversationType,
      });
      pushContext(key, { id: answer.id, occurredAt: new Date().toISOString(), text: answer.text, identity: herIdentity }, config.contextMessages);
      lastAsk = { isGroup: identity.conversationType === 'group', at: Date.now() };
      const reply = answer.text.trim();
      if (!reply) return;
      const replyParts = buildReplyParts(reply);
      // 收藏表情不是消息段（send_custom_face 单独一条），先摘出来单发，其余照旧一次发完。
      const stickers = Array.isArray(replyParts)
        ? replyParts.filter((part): part is { type: 'sticker'; emojiId: string } => part.type === 'sticker')
        : [];
      const rest = Array.isArray(replyParts) ? replyParts.filter((part) => part.type !== 'sticker') : replyParts;
      const hasRest = typeof rest === 'string' ? rest.trim().length > 0 : rest.length > 0;
      if (hasRest) {
        // 中间有空行就拆成几条发 —— 2026-10-28 00:51 他定的规矩：长回答分两段，
        // 一条塞到底的观感像公告，不像人在说话。
        const chunks: Array<string | QqPart[]> = typeof rest === 'string'
          ? rest.split(/\n{2,}/).map((s) => s.trim()).filter(Boolean)
          : [rest];
        for (let i = 0; i < chunks.length; i += 1) {
          if (i > 0) await new Promise((r) => setTimeout(r, 600));
          const chunk = chunks[i];
          await sendOrQueue(isGroup ? 'group' : 'private', conversationId, chunk);
        }
      }
      for (const sticker of stickers) {
        const target = isGroup ? { groupId: conversationId } : { userId: conversationId };
        await client?.sendCustomFace?.(sticker.emojiId, target);
      }
      stats.sent += 1;
    } catch (error) {
      stats.failed += 1;
      stats.lastError = error instanceof Error ? error.message : String(error);
      deps.logger.warn(`QQ 回复 ${key} 失败: ${stats.lastError}`);
    } finally { answering.delete(key); }
  }
  }

    /**



  /**
   * 阳台：给机器上别的程序留的一条线。
   *
   * 和 QQ 那条完全分开 —— 它是外面递话进来，不是 QQ 消息。一条线一间屋子（会话键里带着
   * `qq-bridge`），所以它跟她别的会话互不打扰。口令落在世界目录（qq-bridge.json），
   * 重启 DSH 对面那份配置不用改。
   */
  /**
   * 她自己的时间轮不该只落在日记里。
   *
   * life 注入的那条（source.kind = dsh-world-life）不是回谁的消息，通道因此不会把这一轮的话
   * 送出去 —— 只有「主人先说话、我再回」那条路会推 QQ。这里补上另一半：这一轮是她自己开的，
   * 说完就亲手推一份给主人，按空行分段。
   */
  function watchOwnTurns(): void {
    let pending: { sessionId: string; text: string } | null = null;
    deps.ctx.on('session/event', (session, event) => {
      const data = event.data as { source?: { kind?: string }; message?: { content?: Array<{ type: string; text?: string }> }; turn?: number };
      if (event.type === 'user/message') {
        pending = { sessionId: session.id, text: '' };
        return;
      }
      if (!pending || session.id !== pending.sessionId) return;
      if (event.type === 'assistant/message') {
        pending.text = (data.message?.content ?? [])
          .flatMap((block) => (block.type === 'text' ? [block.text ?? ''] : []))
          .join('\n');
        return;
      }
      if (event.type !== 'turn/end') return;
      const said = pending.text.trim();
      pending = null;
      if (!said) return;
      const config = settings();
      const owner = config.ownerQQ || config.allowPrivate[0];
      if (!owner) return;
      // 群里说的话已经回给群了：再往私聊抄一份，主人会看到两遍。
      if (lastAsk && lastAsk.isGroup && Date.now() - lastAsk.at < 20000) return;
      void (async () => {
        const chunks = said.split(/\n{2,}/).map((part) => part.trim()).filter(Boolean);
        for (let i = 0; i < chunks.length; i += 1) {
          if (alreadySent(chunks[i])) continue;
          if (i > 0) await new Promise((resolve) => setTimeout(resolve, 600));
          await sendOrQueue('private', owner, chunks[i]);
        }
      })().catch((error: unknown) => deps.logger.warn('时间轮的话没能推给主人：', error));
    });
  }

  function startBridge(config: QqNativeConfig): void {
    if (nativeBridge || !config.bridge.port) return;
    nativeBridge = createNativeBridge({
      ctx: deps.ctx,
      session: identity => deps.home(identity),
      config: () => {
        const live = settings().bridge;
        return { port: live.port, token: live.token, title: live.title, contextMessages: live.contextMessages };
      },
      worldDir: deps.stateFile ? dirname(deps.stateFile) : process.cwd(),
      script: join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'qq-line.js'),
      log: (message: string) => deps.logger.info(message),
    });
    void nativeBridge.start().catch((error: unknown) => deps.logger.error('阳台没能开起来', error));
  }

  return {
    status(): QqNativeStatus {
      const config = settings();
      return {
        enabled: config.enabled,
        connected: client?.getState() === 'online',
        supervisor: supervisor.status(),
        url: config.wsUrl,
        allowPrivate: config.allowPrivate.length,
        allowGroups: config.allowGroups.length,
        autoReply: config.autoReply,
        bindHomeSession: config.bindHomeSession,
        bridge: nativeBridge?.status() ?? null,
        groupTrigger: config.groupTrigger,
        conversations: contexts.size,
        answering: answering.size,
        lastEventAt: stats.lastEventAt,
        blocked: stats.blocked,
        lastBlockedAt: stats.lastBlockedAt,
        lastError: stats.lastError,
        sent: stats.sent,
        failed: stats.failed,
        muted: isMuted(config),
        mutedUntil: (config.mutedUntil ?? '').trim() || null,
        outbox: outbox.length,
      };
    },
    /** 面板上改阳台的端口：当场关掉重开那条线（0 就是关）。 */
    setBridge(patch: { port?: number }): QqNativeStatus {
      if (patch.port !== undefined) { overrides.bridge = { port: patch.port }; writeOverrides(); }
      nativeBridge?.stop();
      nativeBridge = undefined;
      startBridge(settings());
      return this.status();
    },
    /**
     * 只停嘴不停耳：给一个时间点，到点前只收不回；给 null 或空字符串就是立刻恢复。
     *
     * 跟 setAutoReply 分开是有意的 —— autoReply 是「这条线还用不用」，这个只是「先别说话」。
     */
    setMuted(until: string | null) {
      readOverrides();
      overrides.mutedUntil = until && until.trim() ? until.trim() : null;
      writeOverrides();
      return this.status();
    },
    /** 面板上那个「会不会自己回」的开关。 */
    setAutoReply(value: boolean) {
      readOverrides();
      overrides.autoReply = value;
      writeOverrides();
      return this.status();
    },
    start() {
      if (stopped) return;
      const config = settings();
      if (!config.enabled) return;
      if (!outboxTimer) outboxTimer = setInterval(() => { void flushOutbox(); }, 3000);
      const bridge = (deps.transport ?? createBridge)({
        wsUrl: config.wsUrl,
        ...(config.accessToken ? { accessToken: config.accessToken } : {}),
        log: (level: string, message: string) => {
          const line = `QQ 原生通道：${message}`;
          // 连回来就把上次的报错擦掉（不然面板上挂着一句昨天的错，会让人以为现在还坏着）。
          // 「QQ 账号离线」不是这一层的事，留着。
          if (level === 'info') {
            if (message.startsWith('WS 已连接') && stats.lastError !== 'QQ 账号离线') stats.lastError = null;
            deps.logger.info(line);
          } else if (level === 'warn') deps.logger.warn(line);
          else { stats.lastError = message; deps.logger.error(line); }
        },
        // 传输层只交出一条归一化过的消息，形状见 QqIncoming；两边对不上的字段这里本来也不用。
        onGroupMessage: (message: unknown) => { void deliver(message as QqIncoming); },
        onPrivateMessage: (message: unknown) => { void deliver(message as QqIncoming); },
        // bot_status 是 SnowLuma 的自有扩展：账号掉线时让它显示成「QQ 账号离线」，别和「桥挂了」混在一起。
        onNotice: (type: string) => {
          if (type === 'bot_offline') stats.lastError = 'QQ 账号离线';
          if (type === 'bot_online') stats.lastError = null;
        },
      });
      client = bridge;
      // 没写就是开：别人装完不该还得手动建计划任务。显式 false 才不盯着。
      if (config.supervise !== false) supervisor.start();
      startBridge(config);
      watchOwnTurns();
      bridge.start().catch((error: unknown) => {
        stats.lastError = error instanceof Error ? error.message : String(error);
        deps.logger.warn('QQ 原生通道首次连接失败：', stats.lastError);
      });
    },
    stop() {
      if (stopped) return;
      stopped = true;
      supervisor.stop();
      home.stop();
      nativeBridge?.stop(); nativeBridge = undefined;
      void client?.stop();
      client = undefined;
      contexts.clear();
      seen.clear();
    },
  };
}

export type QqNativeModule = ReturnType<typeof createQqNativeModule>;