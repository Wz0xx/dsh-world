import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch
from native import connect


class ConfirmationTest(unittest.TestCase):
    def deliver(self, text, row, *, serverId=123, baseline=()):
        class Database:
            def __init__(self, **_):
                self.account, self.wxid, self.reads = 'bot-account', 'wxid_bot', 0

            def _message_dbs(self): return ['m.db']
            def _db_path(self, _): return 'unused.db'
            def _wal_path(self, _): return None

            def get_messages(self, _chat, limit, offset=0):
                self.reads += 1
                return list(baseline) if self.reads == 1 else [row]

            def get_message_row(self, _chat, _id, *, shard):
                return dict(server_id=serverId)

        process = SimpleNamespace(pid=123, create_time=lambda: 1)
        transport = Mock()
        modules = {
            'wechatauto.db': SimpleNamespace(WeChatDB=Database),
            'wechatauto.param': SimpleNamespace(WxParam=SimpleNamespace(ENABLE_FILE_LOGGER=False)),
            'incoming': SimpleNamespace(IncomingImages=lambda *_: SimpleNamespace(read=None, readSticker=None, readReference=None)),
        }
        config = dict(dbDir='unused', account='bot-account', selfId='wxid_bot')
        with patch.dict(sys.modules, modules), patch('native.findAccountProcess', return_value=process), \
                patch('native.checkAccountProcess'), patch('psutil.Process', return_value=process), \
                patch('native.fileStamp', return_value=(1, 1)), \
                patch('native.time.monotonic', side_effect=[0, 1, 2, 3, 4, 25]), \
                patch('native.time.sleep'), patch('sender.NativeSender', return_value=transport):
            _, send = connect(config, Path('unused'))
            try:
                send(dict(id='private'), dict(type='text', text=text))
            finally:
                send.close()
                transport.send.assert_called_once_with('private', 1, text)
                transport.close.assert_called_once_with()

    def test_text_receipt_matches_the_database_readers_trimmed_view(self):
        for text in ('原文', '原文 ', ' 原文\n', '\n第一行\n\n第二行\t'):
            with self.subTest(text=repr(text)):
                row = dict(shard='m.db', local_id=2, sender_username='wxid_bot', type='文本', content=text.strip())
                try:
                    self.deliver(text, row)
                except RuntimeError as error:
                    self.fail(f'已有服务器确认的正文仅首尾空白不同，不应判为发送不明：{error}')

    def test_text_confirmation_still_requires_new_own_server_confirmed_matching_message(self):
        row = dict(shard='m.db', local_id=2, sender_username='wxid_bot', type='文本', content='第一行\n第二行')
        cases = [
            dict(row={**row, 'content': '第一行 第二行'}),
            dict(row={**row, 'sender_username': 'someone_else'}),
            dict(row={**row, 'type': '图片'}),
            dict(row=row, serverId=0),
            dict(row=row, baseline=[row]),
        ]
        for case in cases:
            with self.subTest(case=case), self.assertRaisesRegex(RuntimeError, '尚未确认'):
                self.deliver('第一行\n第二行 ', **case)


if __name__ == '__main__':
    unittest.main()
