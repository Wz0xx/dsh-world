import assert from 'node:assert/strict';
import test from 'node:test';
import { createWechatReading } from '../src/ecosystem/wechat/reading.ts';
import { speakerIdentity } from '../src/ecosystem/shared/identity.ts';

const identity = speakerIdentity({ channel: 'wechat', accountId: 'bot', speakerId: 'wechat:bot', conversationId: 'family@chatroom', conversationType: 'group', conversationName: '家人' });
const entry = { id: 'm.db:1', occurredAt: '2026-10-27T10:00:00Z', text: '今晚吃面', identity: { ...identity, speakerId: 'wechat:dad', speakerName: '爸爸' } };
function fixture() {
  let allowed = true;
  const reading = createWechatReading({ target: (id: string) => { if (!allowed || id !== identity.conversationId) throw new Error('聊天不在配置中'); return identity; } });
  const controller = new AbortController();
  const run = (args: object = {}) => reading.tool.execute({ chatId: identity.conversationId, ...args }, { signal: controller.signal } as never);
  return { reading, controller, run, revoke: () => { allowed = false; } };
}

test('history reads a configured group without a mention and keeps the same chatId and stable cursor for sending', async t => {
  const { reading, run } = fixture(); t.after(reading.stop);
  const result = run({ limit: 2 });
  const job = reading.poll()!;
  assert.equal(job.chatId, identity.conversationId); assert.equal(job.accountId, 'bot'); assert.equal(job.limit, 2);
  assert.deepEqual(reading.poll(), job, 'read-only requests can safely be delivered again until answered');
  reading.accept({ id: job.id, accountId: 'bot', chatId: job.chatId, messages: [entry], nextCursor: 'older-page' });
  const page = JSON.parse(await result as string);
  assert.equal(page.chatId, identity.conversationId); assert.equal(page.messages[0].identity.speakerId, 'wechat:dad');
  const older = run({ cursor: page.nextCursor });
  const next = reading.poll()!; assert.equal(next.cursor, 'older-page');
  reading.accept({ id: next.id, accountId: 'bot', chatId: next.chatId, messages: [] });
  assert.deepEqual(JSON.parse(await older as string).messages, []);
  assert.equal(reading.poll(), undefined);
});

test('history rejects invalid pagination, private chats, another account and cross-group results', async t => {
  const { reading, run } = fixture(); t.after(reading.stop);
  for (const args of [{ limit: 0 }, { limit: 21 }, { chatId: 'private' }, { cursor: '' }]) await assert.rejects(run(args));
  const result = run(); const job = reading.poll()!;
  assert.throws(() => reading.accept({ id: job.id, accountId: 'other', chatId: job.chatId, messages: [] }));
  assert.throws(() => reading.accept({ id: job.id, accountId: 'bot', chatId: job.chatId, messages: [{ ...entry, identity: { ...entry.identity, conversationId: 'other@chatroom' } }] }));
  reading.accept({ id: job.id, accountId: 'bot', chatId: job.chatId, error: '数据库快照不可读取' });
  await assert.rejects(result, /数据库快照不可读取/);
});

test('cancellation, stopping and a removed target release waiting reads; late results are harmless', async () => {
  const f = fixture();
  const pending = f.run(); const job = f.reading.poll()!;
  f.controller.abort(new Error('turn cancelled')); await assert.rejects(pending, /turn cancelled/);
  assert.equal(f.reading.poll(), undefined);
  f.reading.accept({ id: job.id, accountId: 'bot', chatId: job.chatId, messages: [] });
  const g = fixture(); const removed = g.run(); g.revoke();
  assert.equal(g.reading.poll(), undefined); await assert.rejects(removed, /聊天不在配置中/);
  const stopped = f.reading.tool.execute({ chatId: identity.conversationId }, { signal: new AbortController().signal } as never);
  f.reading.stop(); await assert.rejects(stopped, /停止/); g.reading.stop();
});

test('an absent or old adapter times out instead of hanging the model turn', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { reading, run } = fixture(); t.after(reading.stop);
  const pending = run(); const failed = assert.rejects(pending, /超时/);
  t.mock.timers.tick(30_000); await failed;
  assert.equal(reading.poll(), undefined);
});
