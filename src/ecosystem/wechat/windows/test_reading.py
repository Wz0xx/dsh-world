import unittest
import json
import tempfile
from pathlib import Path
from unittest.mock import patch
from reading import readHistory


def row(number):
    return dict(local_id=number, shard='m.db', sort_seq=number, create_time=1700000000+number,
                type='文本', sender_username='dad', content=f'群里第 {number} 句话')


class ReadingTest(unittest.TestCase):
    def setUp(self):
        self.rows = [row(i) for i in range(8, 0, -1)]
        self.calls = []
        owner = self
        class Database:
            def get_messages(self, chatId, limit, offset=0):
                owner.calls.append((chatId, limit, offset))
                return owner.rows[offset:offset+limit]
            def get_nickname(self, _): return '爸爸'
        self.database = Database()
        self.config = dict(selfId='bot', chats=[dict(id='family@chatroom', name='家人', trigger='mention')], pageSize=2)
        self.request = dict(id='request', accountId='bot', chatId='family@chatroom', limit=3)

    def test_group_without_mentions_is_paginated_stably_when_new_messages_arrive(self):
        first = readHistory(self.database, self.config, self.request)
        self.assertEqual([entry['id'] for entry in first['messages']], ['m.db:6', 'm.db:7', 'm.db:8'])
        self.assertEqual(first['messages'][0]['identity']['speakerId'], 'wechat:dad')
        self.rows.insert(0, row(9))
        second = readHistory(self.database, self.config, {**self.request, 'cursor': first['nextCursor']})
        self.assertEqual([entry['id'] for entry in second['messages']], ['m.db:3', 'm.db:4', 'm.db:5'])
        last = readHistory(self.database, self.config, {**self.request, 'cursor': second['nextCursor']})
        self.assertEqual([entry['id'] for entry in last['messages']], ['m.db:1', 'm.db:2'])
        self.assertNotIn('nextCursor', last)
        self.assertTrue(all(call[1] == 2 for call in self.calls))

    def test_equal_sequences_and_shards_are_neither_skipped_nor_duplicated(self):
        self.rows = [{**row(i), 'sort_seq': 10, 'shard': 'a.db' if i % 2 else 'b.db'} for i in range(8, 0, -1)]
        seen, cursor = [], None
        for _ in range(4):
            page = readHistory(self.database, self.config, {**self.request, **({'cursor': cursor} if cursor else {})})
            seen.extend(entry['id'] for entry in page['messages'])
            cursor = page.get('nextCursor')
            if not cursor: break
        self.assertEqual(len(seen), 8); self.assertEqual(len(set(seen)), 8)

    def test_wrong_binding_private_targets_bad_cursors_and_limits_do_not_read_the_database(self):
        first = readHistory(self.database, self.config, self.request)
        self.calls.clear()
        for patch in [dict(accountId='other'), dict(chatId='unselected@chatroom'), dict(chatId='private'), dict(limit=True), dict(limit=21), dict(cursor='bad'), dict(cursor='')]:
            with self.subTest(patch=patch), self.assertRaises(ValueError):
                readHistory(self.database, self.config, {**self.request, **patch})
        self.config['chats'].append(dict(id='other@chatroom', name='其他'))
        with self.assertRaises(ValueError):
            readHistory(self.database, self.config, {**self.request, 'chatId': 'other@chatroom', 'cursor': first['nextCursor']})
        self.assertEqual(self.calls, [])

    def test_self_messages_are_visible_and_unread_media_is_explicit_without_raw_payload(self):
        self.rows = [{**row(3), 'sender_username': 'bot', 'content': '我刚刚说过'},
                     {**row(2), 'type': '图片', 'content': 'private-image-xml'},
                     {**row(1), 'type': '视频', 'content': 'private-video-xml'}]
        page = readHistory(self.database, self.config, self.request)
        self.assertEqual(len(page['messages']), 3)
        self.assertEqual(page['messages'][-1]['identity']['speakerId'], 'wechat:bot')
        self.assertIn('未读取', str(page)); self.assertNotIn('private-', str(page))

    def test_large_pages_return_a_cursor_instead_of_silently_losing_older_messages(self):
        self.rows = [{**row(i), 'content': '鱼' * 2000} for i in range(20, 0, -1)]
        seen, cursor = [], None
        for _ in range(20):
            page = readHistory(self.database, self.config, {**self.request, 'limit': 20, **({'cursor': cursor} if cursor else {})})
            self.assertLessEqual(len(json.dumps(page['messages'], ensure_ascii=False).encode('utf-8')), 16 * 1024)
            seen.extend(entry['id'] for entry in page['messages']); cursor = page.get('nextCursor')
            if not cursor: break
        self.assertEqual(len(seen), 20); self.assertEqual(len(set(seen)), 20)

    def test_system_events_are_not_attributed_to_people_and_unknown_real_senders_fail_explicitly(self):
        self.rows.insert(0, {**row(9), 'type': '系统消息', 'sender_username': '', 'content': '<sysmsg>成员变动</sysmsg>'})
        page = readHistory(self.database, self.config, self.request)
        self.assertNotIn('m.db:9', [entry['id'] for entry in page['messages']])
        self.rows[0]['type'] = '文本'
        with self.assertRaisesRegex(ValueError, '发送者未解析'):
            readHistory(self.database, self.config, self.request)

    def test_reads_and_sends_share_one_poll_without_advancing_the_receive_cursor(self):
        from adapter import MessageStore, flushOutgoing
        with tempfile.TemporaryDirectory() as directory:
            store = MessageStore(Path(directory) / 'state.sqlite'); store.baseline('family@chatroom', 8)
            config = {**self.config, 'moduleFile': 'unused'}
            work = [dict(read=self.request, job=dict(id='a' * 64, accountId='bot', chatId='family@chatroom', messages=[dict(type='text', text='看过再说')])), {}]
            sent, receipts = [], []
            try:
                with patch('adapter.postHome') as post:
                    flushOutgoing(config, self.database, store, lambda chat, item: sent.append((chat['id'], item['text'])),
                                  poll=lambda _: work.pop(0), report=lambda _, value: receipts.append(value))
                    page = post.call_args.args[1]['readResult']
                    self.assertEqual(page['messages'][-1]['id'], 'm.db:8')
                self.assertEqual(sent, [('family@chatroom', '看过再说')])
                self.assertEqual(receipts[-1]['status'], 'sent'); self.assertEqual(store.cursor('family@chatroom'), 8)
                store.checkPending()
            finally: store.close()


if __name__ == '__main__': unittest.main()
