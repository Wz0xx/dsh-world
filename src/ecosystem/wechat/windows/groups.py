"""Group triggers use WeChat source metadata; context is bounded, read-only and paginated."""
import json
from xml.etree import ElementTree
from messages import MAX_CONTEXT_BYTES, messageOrder, recentEntries

MAX_CONTEXT_MESSAGES = 8


def mentionedIds(source):
    if source in (None, b'', ''):
        return []
    if isinstance(source, bytes):
        if source.startswith(bytes.fromhex('28b52ffd')):
            import zstandard
            source = zstandard.ZstdDecompressor().decompress(source, max_output_size=128 * 1024)
        source = source.decode('utf-8')
    if not isinstance(source, str) or len(source.encode('utf-8')) > 128 * 1024:
        raise ValueError('微信消息来源格式无效')
    root = ElementTree.fromstring(source)
    return [value.strip() for value in (root.findtext('atuserlist') or '').split(',') if value.strip()]


def recentContext(database, chatId, current, normalize, pageSize=50, limit=MAX_CONTEXT_MESSAGES):
    result = list(recentEntries(database, chatId, normalize, pageSize, limit, before=messageOrder(current)).values())
    while result and len(json.dumps(result, ensure_ascii=False).encode('utf-8')) > MAX_CONTEXT_BYTES:
        result.pop(0)
    return result
