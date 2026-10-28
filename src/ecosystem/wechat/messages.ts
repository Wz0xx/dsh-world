import { defineTool } from '@deepseek-ai/dsh-tools';
import type { SpeakerIdentity } from '../shared/identity.ts';
import type { ChannelReference } from '../shared/context.ts';

export const wechatTextOutput = { schema: { type: 'string' as const }, render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }] };

export function incomingText(text: string, reference?: ChannelReference): string {
  if (!reference) return text;
  const source = JSON.stringify({ id: reference.id, speakerId: reference.speakerId, speakerName: reference.speakerName, type: reference.type });
  const quoted = reference.image ? (reference.type === 'image' ? '【引用图片，当时已读取】' : '【引用表情包，当时已读取】') : reference.text;
  const content = quoted + (reference.image?.firstFrame ? '\n动图仅查看首帧。' : '');
  return [text, `【引用 ${source}】\n` + content.split(/\r\n?|\n/).map(line => '> ' + line).join('\n')].filter(Boolean).join('\n\n');
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'dsh-world-wechat-outgoing': { kind: 'dsh-world-wechat-outgoing'; form: 'recall'; identity: SpeakerIdentity; messages: WechatMessage[] };
  }
}

export type WechatMessage = { type: 'text'; text: string } | { type: 'image' | 'sticker'; path: string }
  | { type: 'sticker'; stickerId: string };

export function replyText(messages: readonly WechatMessage[]): string {
  return messages.map(message => message.type === 'text' ? message.text : 'stickerId' in message
    ? `【表情包 ${message.stickerId}】` : `【${message.type === 'image' ? '图片' : '表情包'} ${message.path}】`).join('\n\n');
}

export function replyMessages(value: unknown): WechatMessage[] {
  if (!Array.isArray(value) || !value.length || value.length > 16) throw new Error('一次需要 1–16 条微信消息');
  return value.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('无效的微信消息');
    const input = item as Record<string, unknown>;
    if (input.type === 'text' && typeof input.text === 'string' && input.text.trim() && !input.text.includes('\0') && Buffer.byteLength(input.text) < 4095) return { type: 'text', text: input.text };
    if (input.type === 'sticker' && typeof input.stickerId === 'string' && /^st_[A-Za-z0-9_-]+$/.test(input.stickerId)) return { type: 'sticker', stickerId: input.stickerId };
    if ((input.type === 'image' || input.type === 'sticker') && typeof input.path === 'string' && input.path && input.path.length < 1024 && !input.path.includes('\0')) return { type: input.type, path: input.path };
    throw new Error('文字超长，或图片/表情缺少有效路径或表情 ID');
  });
}

export function wechatSendTool(send: (chatId: string, messages: WechatMessage[], context: import('@deepseek-ai/dsh-tools').ToolRunContext) => Promise<string>) {
  return defineTool({
    name: 'wechat_send',
    description: '主动联系微信中的人或群，或者回复当前微信消息，都用同一个工具。先用 wechat_chats 查询已配置目标；群聊可先用 wechat_history 看近期消息，再用同一个 chatId 发言，无需等别人 @。chatId 使用准确 ID，不能按昵称猜测。messages 每项是独立消息，可连续短句并穿插图片或表情，按数组顺序发送。text 放文字；image 用允许目录内的本地绝对路径；sticker 用现有 stickerId（send_sticker 的 list 可查询）或本地图片/GIF 路径。这里只排队，尚未确认发送；用返回的 ID 调用 wechat_delivery 查询结果，结果不明时不要重复发送。同一聊天的一批话尽量一次排好。普通最终回答不会自动转发到微信。',
    parameters: { chatId: { type: 'string', required: true }, messages: { type: 'array', required: true, items: { oneOf: [
      { type: 'object', additionalProperties: false, properties: { type: { type: 'string', const: 'text', required: true }, text: { type: 'string', required: true } } },
      { type: 'object', additionalProperties: false, properties: { type: { type: 'string', const: 'image', required: true }, path: { type: 'string', required: true } } },
      { type: 'object', additionalProperties: false, properties: { type: { type: 'string', const: 'sticker', required: true }, stickerId: { type: 'string', required: true } } },
      { type: 'object', additionalProperties: false, properties: { type: { type: 'string', const: 'sticker', required: true }, path: { type: 'string', required: true } } },
    ] } } },
    output: wechatTextOutput,
    execute: async ({ chatId, messages }, context) => send(chatId, replyMessages(messages), context),
  });
}
