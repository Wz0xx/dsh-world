import tempfile
import unittest
import threading
from pathlib import Path
from adapter import MessageStore, flushOutgoing, watch


class SendingTest(unittest.TestCase):
    def test_model_wait_does_not_block_native_delivery_or_require_the_turn_to_end(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);store=MessageStore(root/'state.sqlite');store.baseline('private',10)
            row=dict(local_id=2,shard='m.db',sort_seq=11,type='文本',sender_username='owner',content='来聊天')
            class Database:
                def get_messages(self,_chat,limit,offset=0):return [row][offset:offset+limit]
            config=dict(selfId='wxid_bot',moduleFile=str(root/'wechat.json'),chats=[dict(id='private',name='伙伴')],pollSeconds=0.01)
            jobs=[];sent=[];delivered=threading.Event()
            def ask(*_):
                jobs.append(dict(id='a'*64,accountId='wxid_bot',chatId='private',messages=[dict(type='text',text='边聊边发')]))
                if not delivered.wait(1):raise RuntimeError('model waited for delivery, but native sender was blocked')
                return dict(text='现在整轮才结束')
            def send(_chat,item):sent.append(item['text']);delivered.set()
            def poll(_):
                if store.cursor('private')==11:raise StopIteration('本轮验证完成')
                return dict(job=jobs.pop(0) if jobs else None)
            try:
                with self.assertRaises(StopIteration):
                    watch(config,Database(),store,send,ask=ask,report=lambda *_:None,poll=poll)
                self.assertEqual(sent,['边聊边发']);store.checkPending()
            finally:store.close()

    def test_confirmed_send_only_reposts_receipt_after_host_network_failure(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);store=MessageStore(root/'state.sqlite');store.baseline('private',10)
            config=dict(selfId='wxid_bot',moduleFile=str(root/'wechat.json'),chats=[dict(id='private',name='伙伴')])
            job=dict(id='a'*64,accountId='wxid_bot',chatId='private',messages=[dict(type='text',text='只发一次')])
            sent=[]
            def offline(*_):raise RuntimeError('回执网络失败')
            try:
                with self.assertRaisesRegex(RuntimeError,'回执网络失败'):
                    flushOutgoing(config,None,store,lambda _chat,item:sent.append(item),poll=lambda _:dict(job=job),report=offline)
                store.checkPending()
                jobs=[job,None];receipts=[]
                flushOutgoing(config,None,store,lambda *_:sent.append('重复'),poll=lambda _:dict(job=jobs.pop(0)),report=lambda _file,r:receipts.append(r))
                self.assertEqual(len(sent),1)
                self.assertEqual(receipts[-1],dict(id='a'*64,confirmed=1,status='sent'))
            finally:store.close()

    def test_proactive_and_reactive_jobs_share_ordered_delivery_without_model_requests(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); store = MessageStore(root / 'state.sqlite')
            config = dict(selfId='wxid_bot', moduleFile=str(root/'wechat.json'), chats=[dict(id='private',name='伙伴'),dict(id='family@chatroom',name='家人',trigger='mention')])
            store.baseline('private',10); store.baseline('family@chatroom',20)
            jobs = [dict(id='a'*64, accountId='wxid_bot', chatId='private', messages=[dict(type='text',text='主动一句'),dict(type='text',text='再一句')]),
                    dict(id='b'*64, accountId='wxid_bot', chatId='family@chatroom', messages=[dict(type='text',text='群里一句')])]
            sent, receipts = [], []
            def poll(_config): return dict(job=jobs.pop(0) if jobs else None)
            try:
                flushOutgoing(config, None, store, lambda chat,item: sent.append((chat['id'],item['text'])), poll=poll, report=lambda _file,receipt: receipts.append(receipt))
                self.assertEqual(sent,[('private','主动一句'),('private','再一句'),('family@chatroom','群里一句')])
                self.assertEqual([(r['confirmed'],r['status']) for r in receipts],[(2,'sent'),(1,'sent')])
                store.checkPending()
            finally: store.close()

    def test_uncertain_delivery_is_never_replayed_after_restart_and_keeps_manual_barrier(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); store = MessageStore(root/'state.sqlite'); store.baseline('private',10)
            config=dict(selfId='wxid_bot',moduleFile=str(root/'wechat.json'),chats=[dict(id='private',name='伙伴')])
            job=dict(id='a'*64,accountId='wxid_bot',chatId='private',messages=[dict(type='text',text='一'),dict(type='text',text='二')])
            sent,receipts=[],[]
            def send(_chat,item):
                sent.append(item['text'])
                if len(sent)==2:raise RuntimeError('断开，结果不明')
            try:
                with self.assertRaisesRegex(RuntimeError,'第 2/2 条'):
                    flushOutgoing(config,None,store,send,poll=lambda _config:dict(job=job),report=lambda _file,r:receipts.append(r))
                self.assertEqual(receipts[-1],dict(id='a'*64,confirmed=1,status='uncertain'))
                store.close();store=MessageStore(root/'state.sqlite')
                with self.assertRaisesRegex(RuntimeError,'尚未确认'):
                    flushOutgoing(config,None,store,send,poll=lambda _config:dict(job=job),report=lambda *_:None)
                self.assertEqual(sent,['一','二'])
            finally:store.close()

    def test_received_claim_with_an_existing_receipt_only_reposts_receipt(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);store=MessageStore(root/'state.sqlite')
            store.beginReply('a'*64,1);store.confirmReply('a'*64,1)
            config=dict(selfId='wxid_bot',moduleFile=str(root/'wechat.json'),chats=[dict(id='private',name='伙伴')])
            job=dict(id='a'*64,accountId='wxid_bot',chatId='private',messages=[dict(type='text',text='已经发过')])
            jobs=[job,None]; sent,receipts=[],[]
            try:
                flushOutgoing(config,None,store,lambda *_:sent.append(True),poll=lambda _config:dict(job=jobs.pop(0)),report=lambda _file,r:receipts.append(r))
                self.assertEqual(sent,[])
                self.assertEqual(receipts[-1]['status'],'sent')
            finally:store.close()

    def test_job_cannot_override_bound_account_or_allowlist(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);store=MessageStore(root/'state.sqlite')
            config=dict(selfId='wxid_bot',moduleFile=str(root/'wechat.json'),chats=[dict(id='private',name='伙伴')])
            job=dict(id='a'*64,accountId='wxid_other',chatId='private',messages=[dict(type='text',text='不要发送')])
            sent=[]
            try:
                with self.assertRaises(ValueError):flushOutgoing(config,None,store,lambda *_:sent.append(True),poll=lambda _config:dict(job=job))
                job={**job,'accountId':'wxid_bot','chatId':'unselected'}
                with self.assertRaises(ValueError):flushOutgoing(config,None,store,lambda *_:sent.append(True),poll=lambda _config:dict(job=job))
                self.assertEqual(sent,[])
            finally:store.close()


if __name__=='__main__':unittest.main()
