"""Read-only group history; cursors identify the oldest returned row, not a shifting offset."""
import base64
import json
from messages import MAX_CONTEXT_BYTES, displayMessage, messageEntry, messageNormalizer, recentEntries
from quotes import isAppMessage


def readHistory(database, config, request):
    chatId, accountId = request.get('chatId'), request.get('accountId')
    chat = next((chat for chat in config['chats'] if chat['id'] == chatId), None)
    if accountId != config['selfId'] or not chat or not chatId.endswith('@chatroom'):
        raise ValueError('读取目标不属于绑定账号的已配置群聊')
    limit = request.get('limit', 10)
    if type(limit) is not int or not 1 <= limit <= 20:
        raise ValueError('群消息分页数量必须为 1–20')
    boundary = None
    if 'cursor' in request:
        try:
            cursor = request['cursor']
            if not isinstance(cursor, str) or not cursor or len(cursor) > 1024: raise ValueError()
            value = json.loads(base64.b64decode(cursor, altchars=b'-_', validate=True))
            if not isinstance(value, list) or len(value) != 5 or value[:2] != [accountId, chatId]: raise ValueError()
            seq, shard, localId = value[2:]
            if type(seq) is not int or type(localId) is not int or not isinstance(shard, str) or not shard: raise ValueError()
            boundary = seq, shard, localId
        except (ValueError, TypeError, UnicodeError) as error:
            raise ValueError('群消息游标无效或不属于当前账号和群聊') from error
    normalize = messageNormalizer(database, chat, config)
    def historyEntry(row):
        if row['type'] == '系统消息': return None
        text = str(row['content'])
        if row['type'] != '文本' and not isAppMessage(row): text = f"【{row['type']}，未读取内容】"
        elif len(text) > 2000: text = '【文本超过 2000 字，未读取正文】'
        message = displayMessage(row, normalize) if isAppMessage(row) else normalize({**row, 'type': '文本', 'content': text}, includeSelf=True)
        if not message and isAppMessage(row):
            message = normalize({**row, 'type': '文本', 'content': f"【{row['type']}，未读取内容】"}, includeSelf=True)
        return messageEntry(row, message) if message else None
    found = recentEntries(database, chatId, historyEntry, config.get('pageSize', 50), limit + 1, before=boundary)
    keys = list(reversed(found))
    selected = []
    for key in keys[:limit]:
        if len(json.dumps([found[item] for item in reversed(selected + [key])], ensure_ascii=False).encode('utf-8')) > MAX_CONTEXT_BYTES: break
        selected.append(key)
    if keys and not selected: raise ValueError('单条群消息超出读取容量')
    result = dict(messages=[found[key] for key in reversed(selected)])
    if len(keys) > len(selected):
        result['nextCursor'] = base64.urlsafe_b64encode(json.dumps([accountId, chatId, *selected[-1]], ensure_ascii=False).encode('utf-8')).decode('ascii')
    return result
