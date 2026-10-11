#!/usr/bin/env python3
"""Disposable v0.5 HTTP/WS fixture. Loopback only; no credentials or message bodies in logs."""
import argparse
import base64
import copy
import hashlib
import json
import mimetypes
import struct
import threading
import time
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse, parse_qs, unquote

lock = threading.RLock()
peers = []
now = lambda: int(time.time() * 1000)
anchor = now()
zone = timezone(timedelta(hours=8))
today = datetime.now(zone).date()
day = lambda n=0: (today-timedelta(days=n)).isoformat()
history = []
queued = []
tasks = []
busy = False
reason = ''
scenario = 'idle'
scenario_version = 0
serial = 0
operations = {k: 0 for k in ['send', 'stop_task', 'interrupt', 'unqueue', 'edit_queued', 'account_save', 'account_test', 'account_delete', 'device_delete', 'profile_save', 'icon', 'site', 'login', 'settings_save', 'task_history', 'task_send', 'blocked']}
profile = dict(avatar=dict(shape='bean', palette='mist'))

def later(delay, fn):
    timer = threading.Timer(delay, fn)
    timer.daemon = True
    timer.start()

def card_html(content, style=''):
    return '<!doctype html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>' +         'html,body{margin:0;background:transparent}*{box-sizing:border-box}body{font:15px -apple-system;color:#252e38;line-height:1.6}.card{padding:24px;background:#fbfcfed9;border-radius:24px}.chip{display:inline-block;padding:3px 10px;border-radius:20px;background:#f3dfb050;color:#6c4a25;font-size:12px}h1{font-size:24px;line-height:1.4;margin:14px 0 10px}h2{font-size:21px;margin:12px 0}.sub{color:#728093}.row{padding:12px 0;border-bottom:1px solid #dae2ea}.metric{font-size:32px;font-weight:650;color:#527aaa}button{border:1px solid #fff;border-radius:20px;background:linear-gradient(145deg,#fffbed,#f3dfb0);background:#f3dfb080;padding:10px 16px;color:#6c4a25;font:14px -apple-system;margin-top:14px;cursor:pointer}' + style +         '</style></head><body><section class="card">' + content + '</section><script>document.addEventListener("click",e=>{const b=e.target.closest("[data-prompt]");if(b){location.href="doudou://prompt?text="+encodeURIComponent(b.dataset.prompt)}})</script></body></html>'

brief_path = f'data/briefs/{day()}/晨报.html'
brief_title = '把周报收尾，下午留给自己的计划'
brief_cards = [
    dict(html=card_html('<span class="chip">今天 · 晨报</span><h1>' + brief_title + '</h1><p class="sub">上午先做最需要专注的事，晚些时候散步。</p><button data-prompt="帮我把今天的事排个顺序">排一下今天的顺序</button>', '.chip{animation:glow 3s ease-in-out infinite}@keyframes glow{50%{background:#f3dfb0a0}}')),
    dict(html=card_html('<span class="chip">生活 · 收口</span><h2>两件小事顺手做完</h2><div class="sub">取快递 · 给绿植浇水</div>')),
    dict(html=card_html('<span class="chip">阅读 · 长卡片</span><h2>这周的阅读与整理</h2><p class="sub">这张长卡片在卡片内部滚动。</p>' + ''.join(f'<div class="row"><b>第 {n} 项</b><div class="sub">读一个章节，写下一句自己的理解。</div></div>' for n in range(1, 19)) + '<div id="end">全部 18 项已经看完</div>')),
]
brief_items = [dict(date=day(), name='晨报', time=f'{day()}T07:36:00+08:00', path=brief_path, cards=brief_cards),
    dict(date=day(1), name='晚报', time=f'{day(1)}T21:30:00+08:00', path=f'data/briefs/{day(1)}/晚报.html', cards=[dict(html=card_html('<span class="chip">昨天</span><h2>今天的事已经收好了</h2><p class="sub">把未完成的两项留给明天。</p>'))]),
    dict(date=day(20), name='健康周报', time=f'{day(20)}T20:00:00+08:00', path=f'data/briefs/{day(20)}/健康周报.html', cards=[dict(html=card_html('<span class="chip">健康周报</span><h2>这一周休息得不错</h2><span class="metric">7.2</span> 小时'))])]
settings = dict(model='anthropic/claude-haiku-5.5', permissionMode='auto', models=[
    dict(id='anthropic/claude-haiku-5.5', label='Claude Haiku 5.5', note='消耗约 1×；输入超过 100K 后约 5×'),
    dict(id='xiaomi/mimo-v2.6-pro', label='MiMo V2.6 Pro', note='输入约 4.35×，输出约 1.74×；缓存读约 0.36×'),
    dict(id='z-ai/glm-5.3-flashx', label='GLM 5.3 FlashX', note='输入约 3.75×，输出约 2.5×；缓存读约 7.5×')], permissionModes=[
    dict(id='auto', label='自动', note='不问用户，自动拦下危险操作'),
    dict(id='bypassPermissions', label='完全放行', note='什么都不拦')])
task_histories = {}

def reset_task_histories():
    task_histories.clear()
    specs = [('report', '整理公开资料，写研究摘要', 'running'), ('table', '校对表格并生成检查清单', 'running'),
        ('morning-1', '晨报', 'done'), ('spending-1', '支出整理', 'done'), ('reading-1', '阅读整理', 'error'), ('stopped-1', '旧资料整理', 'stopped')]
    for identity, title, status in specs:
        entries = [dict(kind='prompt', text='请' + title + '，把结论和需要继续做的事告诉我。', time=anchor-78000),
            dict(kind='text', text='先核对已有资料，再整理主要结论。', time=anchor-72000),
            dict(kind='tool', tool='Read', text='读取 data/memory/profile/总档.md', time=anchor-66000),
            dict(kind='tool', tool='Grep', text='搜索资料里的日期与数字', time=anchor-60000)]
        if status == 'done':
            result = '## 已完成\n\n主要内容已经整理好。\n\n| 项目 | 结论 |\n| --- | --- |\n| 进度 | 已核对 |\n| 下一步 | 按顺序推进 |\n\n- **先完成周报**，再处理生活杂项。'
            if identity == 'morning-1': result += '\n\n简报：' + brief_path
            entries.append(dict(kind='result', text=result, time=anchor-6000))
        elif status in ('error', 'stopped'):
            entries.append(dict(kind='result', text='## 任务' + ('出错' if status=='error' else '已停止') + '\n\n资料暂时读不到，可以在下面接着聊。', time=anchor-6000))
        task_histories[identity] = dict(id=identity, title=title, status=status, items=entries)

schedule = [dict(id='morning', name='晨报', cron='30 7 * * *', kind='brief'), dict(id='evening', name='晚报', cron='30 21 * * *', kind='brief'), dict(id='cleanup', name='夜间整理', cron='0 3 * * *', kind='cleanup')]

def html(title, description, color):
    return f'''<!doctype html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>{title}</title><meta name="description" content="{description}"><style>body{{margin:0;padding:28px;font:16px -apple-system;color:#253344;background:{color}}}h1{{font-size:28px;margin:25px 0}}.box{{padding:22px;background:#ffffffc0;border-radius:22px;margin:20px 0}}.n{{font-size:38px;color:#59758e}}.bar{{height:12px;background:#b0c5d8;border-radius:6px;margin:14px 0}}</style></head><body><small>这周 · 生活记录</small><h1>{title}</h1><p>{description}</p><div class="box"><small>本周合计</small><div class="n">1,286</div><div class="bar" style="width:75%"></div><p>饮食、交通和生活杂项</p></div><div class="box"><h3>给自己的小提醒</h3><p>留下空白，也是一种安排。</p></div></body></html>'''

files = {
    **{item['path']: ''.join(card['html'] for card in item['cards']) for item in brief_items},
    'data/sites/本周支出/index.html': html('本周支出', '用一张图看看这周的钱花在哪里', '#e5edf5'),
    'data/sites/出行准备/index.html': html('出行准备', '周末短途出行的随身清单', '#e8f0ea'),
    'data/memory/profile/总档.md': '# 总档\n更新：本地样例\n\n夏木喜欢把事情想清楚，再动手做。\n\n工作时重视证据，也希望生活里留一些空白。\n\n固定习惯是晚上散步，周末读书。 → life/日常节奏.md\n\n近期在整理一份周报。 → work/周报.md\n\n这是全文的第五段，只在查看全部后出现。',
    'data/memory/work/周报.md': '# 周报\n\n周日上午核对数字，再整理结论。',
    'data/memory/work/项目记录.md': '# 项目记录\n\n每次验收保留证据。',
    'data/memory/life/日常节奏.md': '# 日常节奏\n\n散步和阅读都留一点时间。',
    'data/memory/preferences/协作习惯.md': '# 协作习惯\n\n先核实当前状态，再执行。',
    'data/memory/voice-notes/散步时想到的事.md': '# 散步时想到的事\n\n记录一个整理书架的想法。',
    'data/memory/role/角色.md': '# 豆豆的设定\n\n认真、克制，帮你把事情接着做完。',
    'data/memory/health/latest.json': json.dumps(dict(updated=day(), metrics=[dict(key='sleep', label='睡眠', value=7.2, unit='小时'), dict(key='resting_heart_rate', label='静息心率', value=62, unit='次/分'), dict(key='steps', label='步数', value=6840, unit='步'), dict(key='hrv', label='心率变异性', value=42, unit='ms')]), ensure_ascii=False),
}
profile_document = files['data/memory/profile/总档.md']
for n, title in enumerate(['给今天留一点空白', '书架上的小发现', '走慢一点也很好', '收好这一周']):
    files[f'data/diary/{day(n)}.md'] = f'# {title}\n\n今天把几件小事收好了，也给没完成的事留了位置。聊过的内容让我更了解你的节奏。\n\n明天继续。'

mail_fields = [dict(key='address', label='邮箱地址', type='text', required=True, placeholder='name@example.com'), dict(key='password', label='授权码', type='secret', required=True, help='在邮箱服务商设置里开启 IMAP，生成客户端专用授权码。'), dict(key='label', label='备注', type='text', required=False)]
manual_fields = copy.deepcopy(mail_fields) + [dict(key='host', label='IMAP 服务器', type='text', required=True, placeholder='imap.example.com'), dict(key='security', label='连接加密', type='select', required=True, default='ssl', options=[dict(value='ssl', label='SSL'), dict(value='starttls', label='STARTTLS')]), dict(key='port', label='端口', type='number', required=True, default=993, showIf={'security':'ssl'})]
names = [('qq-mail', 'QQ 邮箱'), ('netease-163', '163 邮箱'), ('netease-126', '126 邮箱'), ('gmail', 'Gmail'), ('exmail', '腾讯企业邮'), ('aliyun-mail', '阿里企业邮'), ('imap', '其他邮箱'), ('tavily', 'Tavily'), ('weread', '微信读书')]
accounts = {name: [] for name, _ in names}
accounts['qq-mail'] = [dict(id='qq-a', label='个人 QQ 邮箱（本地）', status='ok', error=None, checkedAt=anchor-180000, values=dict(address='fixture@qq.com', password='••••', label='个人 QQ 邮箱（本地）')), dict(id='qq-b', label='工作 QQ 邮箱（本地）', status='error', error='授权码需要更新（本地模拟）', checkedAt=anchor-360000, values=dict(address='work@qq.com', password='••••', label='工作 QQ 邮箱（本地）'))]
devices = [dict(id='offline-phone', name='备用手机（本地）', kind='android', online=False, lastSeen=anchor-3600000, capabilities=[dict(name='battery', title='电量', description='读取电量', enabled=True)]), dict(id='online-phone', name='测试手机（本地）', kind='android', online=True, lastSeen=anchor, capabilities=[])]

def connector_data():
    installed, catalog = [], []
    for name, title in names:
        fields = manual_fields if name == 'imap' else mail_fields
        description = '读取邮件（只读 IMAP）'
        if name in ('tavily', 'weread'):
            fields = [dict(key='apiKey', label='API Key', type='secret', required=True, help='在服务的个人设置页生成 API Key。')]
            description = '深入搜索和网页提取' if name == 'tavily' else '读取书架、阅读统计、划线和想法'
        c = dict(name=name, title=title, description=description, fields=fields, multiAccount=name not in ('tavily','weread'), icon=f'/api/connectors/{name}/icon', accounts=accounts[name])
        (installed if accounts[name] else catalog).append(c)
    return dict(cloud=dict(id='cloud', name='云电脑（本地假服务）', kind='cloud', online=True, installed=installed, catalog=catalog), devices=devices)

def broadcast(message):
    with lock:
        clients = list(peers)
    for peer in clients:
        peer.emit(message)

def envelope(entry):
    return dict(t='user', **{k: v for k, v in entry.items() if k != 'role'})

def select(name):
    global history, queued, tasks, busy, reason, scenario, scenario_version
    with lock:
        scenario_version += 1
        scenario = name
        history = [dict(role='assistant', text='这是本地验收窗口。页面内容、消息和任务均为模拟数据。', ts=anchor-90000)]
        history.append(dict(role='card', label='晨报', title=brief_title, path=brief_path, outputs=[brief_path], taskId='morning-1', ok=True, ts=anchor-60000))
        queued = []
        tasks = []
        reset_task_histories()
        files['data/memory/profile/总档.md'] = profile_document
        brief_items[0]['cards'] = brief_cards
        busy = name in ('task-result', 'queue', 'queue-late', 'schedule')
        reason = 'schedule' if name == 'schedule' else 'task_result' if busy else ''
        if name in ('tasks', 'task-result', 'queue', 'queue-late', 'schedule'):
            tasks = [dict(id='report', description='整理公开资料，写研究摘要', startedAt=now()-78000), dict(id='table', description='校对表格并生成检查清单', startedAt=now()-23000)]
        if name in ('memory-pressure', 'memory-pressure-burst'):
            tasks = [dict(id='report', description='本地压力验证任务，持续轮询', startedAt=now())]
            history = [dict(role='user' if n % 3 == 0 else 'assistant',
                text=f'## 本地历史消息 {n}\n\n' + ('长对话与 Markdown 布局验证。English0123456789。' * 45), ts=anchor-500000+n*1000) for n in range(420)]
            pressure_profile = '# 本地多指针压力总档\n\n' + '\n\n'.join(
                f'记忆 {n}：保留稳定的正文，任务刷新时不应重新绘制。 → work/周报.md → life/日常节奏.md → preferences/协作习惯.md' for n in range(18))
            files['data/memory/profile/总档.md'] = pressure_profile
            # Idle CPU means idle documents: the ordinary UI fixture also tests an animated card.
            brief_items[0]['cards'] = [dict(html=c['html'].replace('</head>', '<style>*{animation:none!important;transition:none!important}</style></head>')) for c in brief_cards]
            generation = scenario_version
            started = time.monotonic()
            def pressure_tick():
                if generation != scenario_version: return
                elapsed = time.monotonic()-started
                within = elapsed % 150
                with lock:
                    if within < 30:
                        revision = int(elapsed * 1000) if name == 'memory-pressure-burst' else int(elapsed)
                        files['data/memory/profile/总档.md'] = pressure_profile + f'\n\n本地快照更新：{revision}'
                        broadcast(dict(t='files_changed'))
                    elif within < 51 and elapsed < 600:
                        if not busy: broadcast(dict(t='status',busy=True,reason=''))
                        broadcast(dict(t='delta',text='本地服务流入增量。**证据**与 Markdown 渲染。\n'))
                    elif 51 <= within < 55:
                        text='本地消息流结束；进入空闲观察。' + ('长段落排版验证。' * 160)
                        history.append(dict(role='assistant',text=text,ts=now()))
                        broadcast(dict(t='turn_end',text=text)); broadcast(dict(t='status',busy=False,reason=''))
                if elapsed < 635: later(0.02 if name == 'memory-pressure-burst' and elapsed < 25 else 3,pressure_tick)
            later(0.02 if name == 'memory-pressure-burst' else 3,pressure_tick)
        if name == 'schedule':
            history.append(dict(role='user', id='alarm', text='[定时] 该出「晨报」了\n\n写一份 HTML 简报。', source='schedule', ts=now()-1200))
        broadcast(dict(t='hello', busy=busy, reason=reason, tasks=tasks, devices=[], history=history, queued=[]))
        if busy:
            broadcast(dict(t='status', busy=True, reason=reason))
        if name in ('task-result', 'queue', 'queue-late'):
            broadcast(dict(t='delta', text='后台资料已经整理好了。我正在核对结果，并把结论接回这段对话。'))
        if name in ('queue', 'queue-late'):
            entry = dict(role='user', id='queue-seed', text='等这个结果处理完，帮我列出接下来要做的事。', source='app', ts=now(), attachments=[])
            queued.append(entry)
            broadcast(envelope(entry))
        broadcast(dict(t='files_changed'))
    return dict(ok=True, scenario=name)


def dispatch():
    global busy, reason
    with lock:
        if busy or not queued:
            return
        entry = queued.pop(0)
        history.append(copy.deepcopy(entry))
        busy, reason = True, 'user'
        generation = scenario_version
        broadcast(dict(t='status', busy=True, reason='user'))
        def finish():
            global busy, reason
            with lock:
                if generation != scenario_version:
                    return
                text = '收到了。这条回复来自本地假服务，菜单栏和主窗口共享同一段对话。'
                history.append(dict(role='assistant', text=text, ts=now()))
                broadcast(dict(t='delta', text=text))
                broadcast(dict(t='turn_end', text=text))
                busy, reason = False, ''
                broadcast(dict(t='status', busy=False))
                dispatch()
        later(1, finish)


class Peer:
    def __init__(self, handler):
        self.handler = handler
        self.lock = threading.Lock()
        self.active = True
    def emit(self, obj=None, opcode=1, payload=None):
        data = payload if payload is not None else json.dumps(obj, ensure_ascii=False).encode()
        n = len(data)
        head = bytes([0x80 | opcode]) + (bytes([n]) if n < 126 else bytes([126]) + struct.pack('!H', n) if n < 65536 else bytes([127]) + struct.pack('!Q', n))
        try:
            with self.lock:
                self.handler.wfile.write(head + data); self.handler.wfile.flush()
        except (OSError, ValueError):
            self.active = False


class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'
    def log_message(self, *_):
        pass
    def handle(self):
        try: super().handle()
        except (BrokenPipeError, ConnectionResetError): pass
    def raw_reply(self, raw, mime, status=200, headers=None):
        self.send_response(status)
        self.send_header('Content-Type', mime)
        self.send_header('Content-Length', str(len(raw)))
        for k, v in (headers or {}).items(): self.send_header(k, v)
        self.end_headers()
        self.wfile.write(raw)
    def reply(self, obj, status=200, headers=None):
        self.raw_reply(json.dumps(obj, ensure_ascii=False).encode(), 'application/json; charset=utf-8', status, headers)
    def do_GET(self):
        u = urlparse(self.path); path = u.path.removeprefix('/agent'); query = parse_qs(u.query)
        if path == '/ws': return self.websocket(query.get('role', ['app'])[0])
        if path == '/verify/reset':
            with lock:
                settings.update(model='anthropic/claude-haiku-5.5', permissionMode='auto')
                for key in operations: operations[key] = 0
                select('idle')
            return self.reply(dict(ok=True))
        if path == '/verify/scenario': return self.reply(select(query.get('name', ['idle'])[0]))
        if path == '/verify/stats': return self.reply(dict(operations=operations, scenario=scenario, queued=len(queued), historyUsers=sum(h['role']=='user' for h in history)))
        if path == '/api/state': return self.reply(dict(busy=busy, tasks=tasks, schedule=schedule, firstChat=int(datetime(2026,9,24,tzinfo=zone).timestamp()*1000), userCall='夏木', agentName='豆豆'))
        if path == '/api/profile': return self.reply(profile)
        if path == '/api/settings': return self.reply(copy.deepcopy(settings))
        if path == '/verify/blocked':
            operations['blocked'] += 1
            return self.reply(dict(ok=True))
        parts = [unquote(p) for p in path.split('/') if p]
        if len(parts)==4 and parts[:2]==['api','tasks'] and parts[3]=='history':
            operations['task_history'] += 1
            task = task_histories.get(parts[2])
            return self.reply(copy.deepcopy(task) if task else dict(error='没有这个任务'), 200 if task else 404)
        if path == '/api/briefs':
            try: days = int(query.get('days', ['7'])[0])
            except ValueError: return self.reply(dict(error='days 应是整数'),400)
            if not 1 <= days <= 365: return self.reply(dict(error='days 应在 1 到 365 之间'),400)
            cutoff = day(days-1)
            return self.reply(dict(items=[] if scenario=='empty' else sorted([b for b in brief_items if b['date']>=cutoff], key=lambda b:b['time'], reverse=True)))
        if path == '/api/history': return self.reply(dict(items=history))
        if path == '/api/jobs':
            age = {'morning-1':3600000, 'spending-1':3*86400000, 'reading-1':12*86400000, 'stopped-1':13*86400000}
            recent=[]
            for identity, elapsed in age.items():
                task=task_histories[identity]
                if task['status']=='running': continue
                outputs=[brief_path] if identity=='morning-1' else ['data/sites/本周支出/index.html'] if identity=='spending-1' else []
                recent.append(dict(id=identity,label=task['title'],title=task['title'],status=task['status'],ok=task['status']=='done',ts=anchor-elapsed,outputs=outputs,**({'path':brief_path} if identity=='morning-1' else {})))
            return self.reply(dict(running=[],recent=recent))
        if path == '/api/tree':
            directory = query.get('dir',[''])[0].rstrip('/')
            names = {}
            for filename, content in files.items():
                if not filename.startswith(directory+'/'): continue
                relative = filename[len(directory)+1:]; first, slash, _ = relative.partition('/')
                names[first] = dict(name=first, dir=bool(slash), size=0 if slash else len(content.encode()), mtime=anchor-3600000)
            if directory=='data/sites' and scenario!='sites-empty': names['暂时无法加载'] = dict(name='暂时无法加载', dir=True, size=0, mtime=anchor)
            if directory=='data/sites' and scenario=='sites-empty': names={}
            return self.reply(dict(entries=list(names.values())))
        if path == '/api/skills': return self.reply(dict(skills=[]))
        if path == '/api/connectors': return self.reply(connector_data())
        if path.startswith('/api/connectors/') and path.endswith('/icon'):
            name = unquote(path.split('/')[3])
            if name not in accounts: return self.reply(dict(error='无此图标'),404)
            folder = Path(__file__).resolve().parents[2]/'cloud'/'connectors'/name
            icon = next((folder/f for f in ['icon.png','icon.ico','icon.svg'] if (folder/f).is_file()), None)
            operations['icon'] += 1
            if icon: return self.raw_reply(icon.read_bytes(), mimetypes.guess_type(str(icon))[0] or 'image/png', headers={'Cache-Control':'public, max-age=86400'})
            return self.reply(dict(error='图标暂不可读'),404)
        if path.startswith('/files/'):
            filename = unquote(path.removeprefix('/files/'))
            if filename.endswith('/'): filename += 'index.html'
            if filename=='data/memory/health/latest.json' and scenario=='health-empty': return self.reply(dict(error='还没有健康数据'),404)
            if filename not in files: return self.reply(dict(error='本地样例文件不存在'),404)
            if filename.startswith('data/sites/'): operations['site'] += 1
            return self.raw_reply(files[filename].encode(), mimetypes.guess_type(filename)[0] or 'text/plain')
        return self.reply(dict(error='本地假服务没有此接口'),404)
    def do_POST(self): self.mutate()
    def do_PUT(self): self.mutate()
    def do_DELETE(self): self.mutate()
    def mutate(self):
        global profile
        path = urlparse(self.path).path.removeprefix('/agent')
        raw = self.rfile.read(int(self.headers.get('Content-Length',0)))
        try: body = json.loads(raw or b'{}')
        except ValueError: return self.reply(dict(error='JSON 格式不对'),400)
        parts = [unquote(p) for p in path.split('/') if p]
        if path=='/api/login':
            operations['login'] += 1
            return self.reply(dict(ok=True),headers={'Set-Cookie':'pa_token=local-fixture; Path=/agent; HttpOnly; SameSite=Lax'})
        if path=='/verify/blocked':
            operations['blocked'] += 1
            return self.reply(dict(ok=True))
        if path=='/api/settings' and self.command=='PUT':
            if not body or any(k not in ('model','permissionMode') for k in body): return self.reply(dict(error='设置字段不对'),400)
            for key, options in [('model','models'),('permissionMode','permissionModes')]:
                if key in body and not any(o['id']==body[key] for o in settings[options]): return self.reply(dict(error='没有这个选项'),400)
            settings.update(body); operations['settings_save'] += 1
            return self.reply(copy.deepcopy(settings))
        if len(parts)==4 and parts[:2]==['api','tasks'] and parts[3]=='send' and self.command=='POST':
            identity=parts[2]; task=task_histories.get(identity)
            if task is None: return self.reply(dict(error='没有这个任务'),404)
            text=body.get('text','')
            if not isinstance(text,str) or not text.strip(): return self.reply(dict(error='续聊不能为空'),400)
            if scenario=='task-send-error': return self.reply(dict(error='本地模拟：续聊发送失败'),502)
            with lock:
                operations['task_send'] += 1
                task['items'].append(dict(kind='prompt',text=text.strip(),time=now()))
                task['items'].append(dict(kind='tool',tool='Read',text='继续核对这份任务的原始记录',time=now()))
                task['status']='running'
                if not any(t['id']==identity for t in tasks): tasks.append(dict(id=identity,description=task['title'],startedAt=now()))
                generation=scenario_version
                broadcast(dict(t='task',phase='snapshot',tasks=tasks))
                def finish_task():
                    with lock:
                        if generation!=scenario_version: return
                        task['status']='done'
                        result='## 续聊已完成\n\n已经沿着这份任务的上下文继续整理。\n\n- 补充了一份**检查清单**。\n- 后续安排已经收好。'
                        if identity=='morning-1': result += '\n\n简报：' + brief_path
                        task['items'].append(dict(kind='result',text=result,time=now()))
                        tasks[:]=[t for t in tasks if t['id']!=identity]
                        broadcast(dict(t='task',phase='notification',id=identity,status='completed',background=True))
                        broadcast(dict(t='task',phase='snapshot',tasks=tasks))
                        broadcast(dict(t='job',phase='done',taskId=identity,label=task['title'],title=task['title'],path=brief_path if identity=='morning-1' else None,outputs=[],ok=True,ts=now()))
                later(4,finish_task)
            return self.reply(dict(ok=True,id=identity))
        if path=='/api/profile' and self.command=='PUT':
            avatar = body.get('avatar',{})
            if avatar.get('shape') not in ('bean','girl','boy','cat') or avatar.get('palette') not in ('mist','dusk','mint','sakura'):
                return self.reply(dict(error='头像参数不对'),400)
            profile = dict(avatar=dict(shape=avatar['shape'],palette=avatar['palette'])); operations['profile_save'] += 1
            return self.reply(profile)
        if path=='/api/run':
            select('schedule'); return self.reply(dict(ok=True,mode='alarm'),202)
        if len(parts)==3 and parts[:2]==['api','devices'] and self.command=='DELETE':
            found = next((d for d in devices if d['id']==parts[2]),None)
            if found and found['online']: return self.reply(dict(error='只能移除离线设备'),409)
            devices[:] = [d for d in devices if d['id']!=parts[2]]; operations['device_delete'] += 1
            return self.reply(dict(ok=True))
        if len(parts)>=4 and parts[:2]==['api','connectors'] and parts[2] in accounts and parts[3]=='accounts':
            group=accounts[parts[2]]; identity=parts[4] if len(parts)>=5 else None
            account=next((a for a in group if a['id']==identity),None)
            if self.command=='DELETE' and account:
                group.remove(account); operations['account_delete'] += 1; return self.reply(dict(ok=True))
            if self.command=='POST' and len(parts)==6 and parts[5]=='test' and account:
                operations['account_test'] += 1; time.sleep(1)
                account.update(status='ok',error=None,checkedAt=now()); return self.reply(dict(ok=True))
            if self.command in ('POST','PUT'):
                values=body.get('values',{}); operations['account_save'] += 1; time.sleep(1)
                if values.get('password')=='reject' or values.get('apiKey')=='reject': return self.reply(dict(error='授权码不对（本地模拟），请检查后再试'),400)
                merged=dict(account.get('values',{}) if account else {},**values)
                for key in ('password','apiKey'):
                    if key in merged: merged[key]='••••'
                updated=dict(id=identity or 'new-'+str(operations['account_save']),label=merged.get('label') or merged.get('address') or '本地账号',values=merged,status='ok',error=None,checkedAt=now())
                if account: group[group.index(account)]=updated
                else: group.append(updated)
                return self.reply(dict(id=updated['id'],label=updated['label'],status='ok'),200 if account else 201)
        return self.reply(dict(error='本地验收尚未启用此操作'),400)
    def websocket(self,role):
        key=self.headers.get('Sec-WebSocket-Key','')
        accept=base64.b64encode(hashlib.sha1((key+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').encode()).digest()).decode()
        self.send_response(101); self.send_header('Upgrade','websocket'); self.send_header('Connection','Upgrade'); self.send_header('Sec-WebSocket-Accept',accept); self.end_headers()
        peer=Peer(self)
        if role=='app':
            with lock:
                peers.append(peer); peer.emit(dict(t='hello',busy=busy,reason=reason,tasks=tasks,devices=[],history=history,queued=queued))
            print('Local app socket connected',flush=True)
        try:
            while peer.active:
                head=self.rfile.read(2)
                if len(head)!=2: break
                opcode=head[0]&15; n=head[1]&127
                if n==126: n=struct.unpack('!H',self.rfile.read(2))[0]
                elif n==127: n=struct.unpack('!Q',self.rfile.read(8))[0]
                if n>1<<20: break
                mask=self.rfile.read(4) if head[1]&128 else b''; data=self.rfile.read(n)
                if mask: data=bytes(v^mask[i%4] for i,v in enumerate(data))
                if opcode==8: break
                if opcode==9: peer.emit(opcode=10,payload=data)
                if opcode==1 and role=='app': self.message(peer,json.loads(data))
        except (OSError,ValueError,struct.error): pass
        finally:
            peer.active=False
            with lock:
                if peer in peers: peers.remove(peer)
            self.close_connection=True
    def message(self,peer,message):
        global busy, reason, serial
        with lock:
            kind=message.get('t')
            if kind in operations: operations[kind] += 1
            if kind=='stop_task':
                identity=message.get('id')
                if identity=='table': peer.emit(dict(t='task_stop',id=identity,ok=False,code='task_stop_failed',error='停止任务失败，请稍后再试'))
                else:
                    peer.emit(dict(t='task_stop',id=identity,ok=True)); generation=scenario_version
                    def finish():
                        with lock:
                            if generation!=scenario_version: return
                            tasks[:]=[t for t in tasks if t['id']!=identity]
                            if identity in task_histories: task_histories[identity]['status']='stopped'
                            broadcast(dict(t='task',phase='notification',id=identity,status='stopped',background=True))
                            broadcast(dict(t='task',phase='snapshot',tasks=tasks))
                    later(1.5,finish)
            elif kind=='interrupt':
                busy,reason=False,''
                broadcast(dict(t='turn_end',text='当前回复已停止。后台任务继续。')); broadcast(dict(t='status',busy=False)); dispatch()
            elif kind=='send':
                serial+=1
                entry=dict(role='user',id=f'local-{serial}',text=message.get('text',''),source='app',ts=now(),attachments=message.get('attachments',[]))
                queued.append(entry); broadcast(envelope(entry)); dispatch()
            elif kind in ('unqueue','edit_queued'):
                identity=message.get('id'); entry=next((e for e in queued if e['id']==identity),None)
                if entry and scenario=='queue-late':
                    queued.remove(entry); history.append(copy.deepcopy(entry)); entry=None
                if not entry: peer.emit(dict(t='queue_update',id=identity,state='too_late'))
                elif kind=='unqueue': queued.remove(entry); broadcast(dict(t='queue_update',id=identity,state='removed'))
                else:
                    text=message.get('text','').strip()
                    if not text: peer.emit(dict(t='error',error='排队消息不能为空')); return
                    entry['text']=text; broadcast(dict(t='queue_update',id=identity,state='edited',text=text))
            print('Local operation received: '+str(kind)+' (body hidden)',flush=True)

if __name__=='__main__':
    parser=argparse.ArgumentParser(); parser.add_argument('--port',type=int,default=18765); args=parser.parse_args()
    select('idle')
    service=ThreadingHTTPServer(('127.0.0.1',args.port),Handler); service.daemon_threads=True
    print('Local fixture service listening on loopback port '+str(service.server_port),flush=True)
    service.serve_forever()
