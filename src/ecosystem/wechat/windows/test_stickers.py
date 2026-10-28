import hashlib
import io
import unittest
from types import SimpleNamespace
from unittest.mock import Mock
import adapter
from incoming import ImageUnavailable
from stickers import StickerUnavailable, fetchSticker, parseSticker, MAX_STICKER_BYTES

PAYLOAD = b'GIF89a' + b'x' * 20
MD5 = hashlib.md5(PAYLOAD).hexdigest()
URL = 'http://vweixinf.tc.qq.com/a?b=1&amp;c=2'


def xml(md5=MD5, url=URL):
    return f'<msg><emoji md5="{md5}" cdnurl="{url}" width="300" height="300"/></msg>'.encode()


class Opener:
    def __init__(self, data): self.data, self.urls = data, []
    def open(self, request, timeout=None):
        self.urls.append(request.full_url)
        return io.BytesIO(self.data)


class StickerTest(unittest.TestCase):
    def test_self_media_is_ignored_before_reading_the_image_or_sticker(self):
        config = dict(selfId='bot')
        chat = dict(id='owner', name='伙伴')
        for kind in ('图片', '动画表情'):
            row = dict(local_id=1, shard='m.db', sort_seq=11, create_time=100, type=kind, sender_username='bot', content='self echo')
            self.assertIsNone(adapter.incomingMessage(object(), chat, row, config))

    def test_parse_unescapes_the_address(self):
        self.assertEqual(parseSticker(xml()), (MD5, 'http://vweixinf.tc.qq.com/a?b=1&c=2'))

    def test_only_matching_bytes_are_accepted(self):
        opener = Opener(PAYLOAD)
        self.assertEqual(fetchSticker(xml(), opener=opener), PAYLOAD)
        self.assertEqual(opener.urls, ['http://vweixinf.tc.qq.com/a?b=1&c=2'])
        with self.assertRaisesRegex(StickerUnavailable, 'md5'):
            fetchSticker(xml(), opener=Opener(b'other'))
        with self.assertRaisesRegex(StickerUnavailable, '大小'):
            fetchSticker(xml(), opener=Opener(b'x' * (MAX_STICKER_BYTES + 1)))

    def test_addresses_outside_tencent_cdn_never_get_a_request(self):
        for url in ('http://evil.example/a', 'http://qq.com.evil.example/a', 'file:///etc/passwd', 'http://user:pw@a.qq.com/x'):
            opener = Opener(PAYLOAD)
            with self.assertRaises(StickerUnavailable): fetchSticker(xml(url=url), opener=opener)
            self.assertEqual(opener.urls, [])

    def test_missing_fields_are_explicit(self):
        for body in (xml(md5='zz'), xml(url=''), b'<msg/>', b'not xml'):
            with self.assertRaises(StickerUnavailable): parseSticker(body)

    def test_private_sticker_is_a_media_request_and_failure_is_explicit(self):
        row = dict(local_id=1, shard='m.db', sort_seq=11, create_time=100, type='动画表情', sender_username='owner', content='[动画表情]')
        database = SimpleNamespace(readSticker=Mock(return_value=dict(file='a' * 64 + '.png', quality='original')))
        message = adapter.incomingMessage(database, dict(id='owner', name='伙伴'), row, dict(selfId='bot'))
        self.assertEqual(message['text'], '')
        self.assertEqual(message['media'][0]['image']['quality'], 'original')
        database.readSticker.side_effect = ImageUnavailable('下载失败')
        message = adapter.incomingMessage(database, dict(id='owner', name='伙伴'), row, dict(selfId='bot'))
        self.assertIn('下载失败', message['media'][0]['text'])
        self.assertIsNone(adapter.incomingMessage(database, dict(id='owner', name='伙伴'), dict(row, sender_username='bot'), dict(selfId='bot')))
