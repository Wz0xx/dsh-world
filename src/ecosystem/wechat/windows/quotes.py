"""Decode reply cards once; quoted XML is never passed to the model as message text."""
from xml.etree import ElementTree


class MessageContentError(ValueError):
    pass


def isAppMessage(row):
    kind = row['type']
    return kind == '文件/链接/卡片' or (isinstance(kind, int) and kind & 0xffffffff == 49)


def xmlRoot(text):
    if not isinstance(text, str) or len(text.encode('utf-8')) > 128 * 1024:
        raise MessageContentError('应用消息超过解析容量')
    if '<!DOCTYPE' in text.upper() or '<!ENTITY' in text.upper():
        raise MessageContentError('应用消息含不支持的 XML 声明')
    try: return ElementTree.fromstring(text)
    except ElementTree.ParseError as error:
        raise MessageContentError(f'应用消息 XML 无法解析：{error}') from error


def referenceError(reference, error):
    reference.pop('image', None)
    reference['error'] = str(error)[:500]
    reference['text'] = f'【引用内容未读取：{reference["error"]}】'
    return reference


def parseQuote(row):
    if not isAppMessage(row): return None
    text = str(row['content']).strip()
    sender = row.get('sender_username')
    if sender and text.startswith(sender + ':\n'): text = text[len(sender) + 2:]
    if not text.startswith(('<msg', '<?xml', '<appmsg')): return None
    root = xmlRoot(text)
    app = root if root.tag == 'appmsg' else root.find('appmsg')
    if app is None or app.findtext('type') != '57': return None
    words = app.findtext('title') or ''
    if len(words) > 2000: raise MessageContentError('引用回复的留言超过 2000 字')
    reference = dict(type='other', text='【引用消息】')
    ref = app.find('refermsg')
    if ref is None: return words, referenceError(reference, '缺少原消息信息')
    messageId, author, name = (ref.findtext(key) or '' for key in ('svrid', 'fromusr', 'displayname'))
    if messageId:
        if len(messageId) > 20 or not messageId.isascii() or not messageId.isdecimal() or not 0 < int(messageId) < 1 << 64:
            return words, referenceError(reference, '原消息 ID 无效')
        reference['id'] = messageId
    if author:
        if len(author) > 240 or any(ord(char) < 32 or ord(char) == 127 for char in author):
            return words, referenceError(reference, '原作者 ID 无效')
        reference['speakerId'] = 'wechat:' + author
    if name and len(name) <= 256 and not any(ord(char) < 32 or ord(char) == 127 for char in name):
        reference['speakerName'] = name
    kind = ref.findtext('type') or ''
    content = ref.findtext('content') or ''
    if kind == '1':
        reference['type'] = 'text'
        if not content.strip(): return words, referenceError(reference, '原文字内容为空')
        if len(content) > 2000: return words, referenceError(reference, '原文字超过 2000 字')
        reference['text'] = content
    elif kind in ('3', '47', '11000'):
        reference['type'] = 'image' if kind == '3' else 'sticker'
        reference['text'] = '【引用图片，未读取】' if kind == '3' else '【引用表情包，未读取】'
    elif kind == '49':
        try:
            nested = xmlRoot(content)
            app = nested if nested.tag == 'appmsg' else nested.find('appmsg')
            title = app.findtext('title') if app is not None else None
            if not title or len(title) > 2000: raise MessageContentError('嵌套消息没有可读取的标题')
            reference['text'] = title
        except MessageContentError as error: referenceError(reference, error)
    else:
        reference['text'] = {'34': '【引用语音，未读取】', '43': '【引用视频，未读取】'}.get(kind, '【不支持的引用类型，未读取】')
    return words, reference
