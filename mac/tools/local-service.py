#!/usr/bin/env python3
"""Disposable loopback-only HTTP/WebSocket fixture. Never logs headers, credentials or message bodies."""
import argparse
import base64
import hashlib
import json
import struct
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs, unquote

lock = threading.RLock()
peers = []
now = lambda: int(time.time() * 1000)
history = []
tasks = []
busy = False
reason = ''
scenario = 'idle'
scenario_version = 0
operations = dict(send=0, stop_task=0, interrupt=0, account_save=0, account_test=0, account_delete=0, device_delete=0)

fields = [
    dict(key='preset', label='邮箱类型', type='select', required=True,
         options=[dict(value='qq', label='QQ 邮箱'), dict(value='163', label='163 邮箱'), dict(value='custom', label='其他（手动填服务器）')]),
    dict(key='address', label='邮箱地址', type='text', required=True, placeholder='name@example.com'),
    dict(key='password', label='授权码', type='secret', required=True,
         help={'qq': 'QQ 邮箱网页版 → 设置 → 账号 → 开启 IMAP/SMTP → 生成授权码', '163': '163 邮箱网页版 → 设置 → 开启 IMAP 并生成授权码', 'custom': '在邮箱服务商设置中开启 IMAP，使用授权码或客户端专用密码'}),
    dict(key='host', label='IMAP 服务器', type='text', required=True, showIf={'preset':'custom'}, placeholder='imap.example.com'),
    dict(key='port', label='端口', type='number', default=993, showIf={'preset':'custom'}),
    dict(key='scope', label='读取范围', type='select', default='inbox', showIf={'preset':'custom'}, options=[dict(value='inbox', label='收件箱'), dict(value='all', label='全部文件夹')]),
    dict(key='label', label='备注（可选）', type='text', placeholder='例如：工作邮箱'),
]
accounts = [
    dict(id='qq', label='个人 QQ 邮箱（本地）', status='ok', error=None, checkedAt=now()-180000,
         values=dict(preset='qq', address='fixture@qq.com', password='••••', label='个人 QQ 邮箱（本地）')),
    dict(id='custom', label='工作邮箱（本地）', status='error', error='授权码需要更新（本地模拟）', checkedAt=now()-360000,
         values=dict(preset='custom', address='fixture@example.com', host='imap.example.com', port=1993, scope='all', label='工作邮箱（本地）', password='••••')),
]
devices = [
    dict(id='offline-phone', name='备用手机（本地）', kind='android', online=False, lastSeen=now()-3600000, capabilities=[dict(name='battery', title='电量', description='读取电量', enabled=True)]),
    dict(id='online-phone', name='测试手机（本地）', kind='android', online=True, lastSeen=now(), capabilities=[]),
]

def connector_data():
    email = dict(name='email', title='邮箱', description='QQ、163、企业邮箱（IMAP，只读）', icon='envelope', fields=fields, multiAccount=True)
    if accounts:
        email.update(status='on', accounts=accounts)
    else:
        email.update(status='off')
    return dict(cloud=dict(id='cloud', name='云电脑（本地假服务）', kind='cloud', online=True,
                         builtin=[dict(name='shell', title='命令行', description='在云电脑上执行命令', status='on')],
                         installed=[email] if accounts else [],
                         catalog=([email] if not accounts else []) + [dict(name='calendar-demo', title='日历', description='本地目录占位，账号表单即将支持', status='off')],
                         custom=[dict(name='local-notes', title='资料归档', description='豆豆自建的本地展示连接器', custom=True, status='on')]), devices=devices)


def broadcast(message):
    with lock:
        clients = list(peers)
    for peer in clients:
        peer.emit(message)


def select(name):
    global history, tasks, busy, reason, scenario, scenario_version
    with lock:
        scenario_version += 1
        scenario = name
        history = [dict(role='assistant', text='这是本地验收窗口。所有消息和任务均为模拟数据。', ts=now()-90000)]
        tasks = [dict(id='report', description='比较公开资料，整理研究摘要', startedAt=now()-78000),
                 dict(id='table', description='校对表格并生成检查清单', startedAt=now()-23000)]
        busy = name != 'idle'
        reason = 'schedule' if name == 'schedule' else 'task_result' if name in ('task-result', 'queue') else 'user'
        if name == 'idle':
            tasks = []
        if name == 'schedule':
            history.append(dict(role='user', text='[定时] 该出「晨报」了\n\n挑选今天需要关注的消息。', source='schedule', ts=now()-1200))
        broadcast(dict(t='hello', busy=busy, tasks=tasks, devices=[], history=history))
        if busy:
            broadcast(dict(t='status', busy=True, reason=reason))
        if name in ('task-result', 'queue'):
            broadcast(dict(t='delta', text='后台资料已经整理好了。我正在核对结果，并把重要结论接回这段对话。'))
        if name == 'queue':
            history.append(dict(role='user', text='等这个结果处理完，帮我列出接下来要做的事。', source='app', ts=now()))
            broadcast(dict(t='user', text=history[-1]['text'], source='app', attachments=[]))
    return dict(ok=True, scenario=name)


class Peer:
    def __init__(self, handler):
        self.handler = handler
        self.lock = threading.Lock()
        self.active = True

    def emit(self, obj=None, opcode=1, payload=None):
        data = payload if payload is not None else json.dumps(obj, ensure_ascii=False).encode()
        head = bytes([0x80 | opcode])
        n = len(data)
        head += bytes([n]) if n < 126 else bytes([126]) + struct.pack('!H', n) if n < 65536 else bytes([127]) + struct.pack('!Q', n)
        try:
            with self.lock:
                self.handler.wfile.write(head + data)
                self.handler.wfile.flush()
        except (OSError, ValueError):
            self.active = False


class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'
    def log_message(self, *_):
        pass

    def reply(self, obj, status=200):
        raw = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self):
        u = urlparse(self.path)
        path = u.path.removeprefix('/agent')
        if path == '/ws':
            return self.websocket(parse_qs(u.query).get('role', ['app'])[0])
        if path == '/verify/scenario':
            return self.reply(select(parse_qs(u.query).get('name', ['idle'])[0]))
        if path == '/verify/stats':
            return self.reply(dict(operations=operations, scenario=scenario))
        if path == '/api/state':
            return self.reply(dict(busy=busy, tasks=tasks, model='本地假服务', schedule=[], firstChat=None))
        if path == '/api/history':
            return self.reply(dict(items=history))
        if path == '/api/jobs':
            return self.reply(dict(running=[], recent=[]))
        if path == '/api/tree':
            return self.reply(dict(entries=[]))
        if path == '/api/skills':
            return self.reply(dict(skills=[]))
        if path == '/api/connectors':
            return self.reply(connector_data())
        return self.reply(dict(error='本地假服务没有此接口'), 404)

    def do_POST(self):
        self.mutate()

    def do_PUT(self):
        self.mutate()

    def do_DELETE(self):
        self.mutate()

    def mutate(self):
        # No headers / account values are written to the log or returned in error strings.
        path = urlparse(self.path).path.removeprefix('/agent')
        raw = self.rfile.read(int(self.headers.get('Content-Length', 0)))
        parts = [unquote(p) for p in path.split('/') if p]
        if len(parts) == 3 and parts[:2] == ['api', 'devices'] and self.command == 'DELETE':
            identity = parts[2]
            found = next((d for d in devices if d['id'] == identity), None)
            if found and found['online']:
                return self.reply(dict(error='只能移除离线设备'), 409)
            devices[:] = [d for d in devices if d['id'] != identity]
            operations['device_delete'] += 1
            return self.reply(dict(ok=True))
        if len(parts) >= 4 and parts[:3] == ['api', 'connectors', 'email'] and parts[3] == 'accounts':
            identity = parts[4] if len(parts) >= 5 else None
            account = next((a for a in accounts if a['id'] == identity), None)
            if self.command == 'DELETE' and account:
                accounts.remove(account)
                operations['account_delete'] += 1
                return self.reply(dict(ok=True))
            if self.command == 'POST' and len(parts) == 6 and parts[5] == 'test' and account:
                operations['account_test'] += 1
                time.sleep(8)
                account.update(status='ok', error=None, checkedAt=now())
                return self.reply(dict(ok=True))
            if self.command in ('POST', 'PUT'):
                values = json.loads(raw or b'{}').get('values', {})
                operations['account_save'] += 1
                time.sleep(8)
                if values.get('password') == 'reject':
                    return self.reply(dict(error='授权码不对（本地模拟），请检查后再试'), 400)
                old = account.get('values', {}) if account else {}
                merged = dict(old, **values)
                merged['password'] = '••••'
                updated = dict(id=identity or 'new-' + str(operations['account_save']), label=merged.get('label') or merged.get('address') or '本地账号', values=merged, status='ok', error=None, checkedAt=now())
                if account:
                    accounts[accounts.index(account)] = updated
                else:
                    accounts.append(updated)
                return self.reply(dict(id=updated['id'], label=updated['label'], status='ok'), 200 if account else 201)
        return self.reply(dict(error='本地验收尚未启用此操作'), 400)

    def websocket(self, role):
        key = self.headers.get('Sec-WebSocket-Key', '')
        accept = base64.b64encode(hashlib.sha1((key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').encode()).digest()).decode()
        self.send_response(101)
        self.send_header('Upgrade', 'websocket')
        self.send_header('Connection', 'Upgrade')
        self.send_header('Sec-WebSocket-Accept', accept)
        self.end_headers()
        peer = Peer(self)
        if role == 'app':
            with lock:
                peers.append(peer)
                peer.emit(dict(t='hello', busy=busy, tasks=tasks, devices=[], history=history))
            print('Local app socket connected', flush=True)
        try:
            while peer.active:
                head = self.rfile.read(2)
                if len(head) != 2:
                    break
                opcode = head[0] & 15
                n = head[1] & 127
                if n == 126:
                    n = struct.unpack('!H', self.rfile.read(2))[0]
                elif n == 127:
                    n = struct.unpack('!Q', self.rfile.read(8))[0]
                if n > 1 << 20:
                    break
                mask = self.rfile.read(4) if head[1] & 128 else b''
                data = self.rfile.read(n)
                if mask:
                    data = bytes(v ^ mask[i % 4] for i, v in enumerate(data))
                if opcode == 8:
                    break
                if opcode == 9:
                    peer.emit(opcode=10, payload=data)
                if opcode == 1 and role == 'app':
                    self.message(peer, json.loads(data))
        except (OSError, ValueError, struct.error):
            pass
        finally:
            peer.active = False
            with lock:
                if peer in peers:
                    peers.remove(peer)
            self.close_connection = True

    def message(self, peer, message):
        global busy
        kind = message.get('t')
        if kind in ('send', 'stop_task', 'interrupt'):
            operations[kind] += 1
        if kind == 'stop_task':
            identity = message.get('id')
            if identity == 'table':
                peer.emit(dict(t='task_stop', id=identity, ok=False, code='task_stop_failed', error='停止任务失败，请稍后再试'))
            else:
                peer.emit(dict(t='task_stop', id=identity, ok=True))
                generation = scenario_version
                def finish():
                    with lock:
                        if generation != scenario_version:
                            return
                        tasks[:] = [t for t in tasks if t['id'] != identity]
                    broadcast(dict(t='task', phase='notification', id=identity, status='stopped', background=True))
                    broadcast(dict(t='task', phase='snapshot', tasks=tasks))
                timer = threading.Timer(30, finish)
                timer.daemon = True
                timer.start()
            print('Local stop_task received', flush=True)
        elif kind == 'interrupt':
            busy = False
            broadcast(dict(t='turn_end', text='当前回复已停止。后台任务继续。'))
            broadcast(dict(t='status', busy=False))
            print('Local interrupt received', flush=True)
        elif kind == 'send':
            text = message.get('text', '')
            entry = dict(role='user', text=text, source='app', ts=now(), attachments=message.get('attachments', []))
            history.append(entry)
            broadcast(dict(t='user', text=text, source='app', attachments=entry['attachments']))
            if not busy:
                busy = True
                broadcast(dict(t='status', busy=True, reason='user'))
            print('Local send received (body hidden)', flush=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--port', type=int, default=18765)
    args = parser.parse_args()
    service = ThreadingHTTPServer(('127.0.0.1', args.port), Handler)
    service.daemon_threads = True
    print('Local fixture service listening on loopback port ' + str(service.server_port), flush=True)
    service.serve_forever()
