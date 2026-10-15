#!/usr/bin/env python3
"""Exercise the real debug App against v08-demo.mjs; always stop its emulator."""
import json, os, re, runpy, subprocess, time
from pathlib import Path

os.environ.setdefault('V08_REVIEW_SHOTS','/tmp/v08-android-shots/r2')
r=runpy.run_path(str(Path(__file__).with_name('v08-review.py')))
out=r['SHOTS']
record=None

def until(fn,seconds=15):
    end=time.monotonic()+seconds
    while time.monotonic()<end:
        value=fn()
        if value:return value
        time.sleep(.25)
    raise RuntimeError('Review condition timed out')

def history(id):return r['api']('/api/activities/'+id+'/history')
def hide_keyboard():
    if re.search(r'mInputShown=true',r['shell']('dumpsys','input_method')):r['back']()

try:
    r['adb']('wait-for-device',timeout=60)
    until(lambda:r['shell']('getprop','sys.boot_completed').strip()=='1',60)
    r['adb']('install','-r',str(Path(__file__).resolve().parents[1]/'app/build/outputs/apk/debug/app-debug.apk'))
    seed=r['api']('/api/side-chats',{'text':'帮我单独整理阅读清单','title':'阅读清单'})
    until(lambda:history(seed['id'])['status']=='done')
    r['shell']('cmd','uimode','night','no')
    r['shell']('am','force-stop',r['PACKAGE'])
    r['shell']('am','start','-n',r['PACKAGE']+'/com.xiamu.agent.MainActivity')
    until(lambda:any(n.attrib.get('text')=='开启本机能力' for n in r['nodes']()))
    time.sleep(1)
    old_ids={a['id'] for a in r['api']('/api/activities')['recent'] if a.get('chatType')=='side'}
    record=r['start_record']('02-side-chats.mp4')
    r['tap']('打开抽屉',True);r['tap']('新旁聊');r['shot']('09-new-side-chat.png')
    r['api']('/api/send',{'text':'DEMO_MAIN_HOLD'})
    assert r['api']('/api/state')['busy']
    r['edit']('Reading plan');r['tap']('发送',True)
    def created():
        data=r['api']('/api/activities')
        return next((a['id'] for a in data['running']+data['recent'] if a.get('chatType')=='side' and a['id'] not in old_ids),None)
    id=until(created)
    until(lambda:len(history(id)['messages'])>=3 and history(id)['status']=='done')
    hide_keyboard();time.sleep(.6);r['shot']('10-side-chat-messages.png')
    current=r['nodes']();ui=[n.attrib.get('text','') for n in current]
    assert any('旁聊' in n.attrib.get('content-desc','') for n in current) and any('想先从哪一步开始' in s for s in ui)
    assert not any('主聊天正在整理资料' in s for s in ui)
    side=history(id);main=r['api']('/api/history')['items'];main_busy=r['api']('/api/state')['busy']
    assert main_busy
    assert not any('这件事我们在旁聊里' in m.get('text','') for m in main)
    bubble=next(m for m in side['messages'] if m.get('options'))
    r['tap']('先做调研')
    until(lambda:any(m.get('id')==bubble['id'] and m.get('optionsUsed') for m in history(id)['messages']))
    time.sleep(.8);r['shot']('11-side-options-consumed.png')
    side=history(id)
    assert any(m.get('source')=='option' and m['text']=='先做调研' for m in side['messages'])
    assert not any(m.get('source')=='option' for m in r['api']('/api/history')['items'])
    r['tap']('回到主聊天',True);time.sleep(.6);r['shot']('12-main-chat-isolated.png')
    r['tap']('打开抽屉',True);time.sleep(.8);r['shot']('13-side-chat-list.png')
    ui=[n.attrib.get('text','') for n in r['nodes']()]
    assert 'Reading plan' in ui and '阅读清单' in ui
    assert not any(s.startswith('聊天 ·') for s in ui)
    r['tap']('Reading plan');time.sleep(.8);r['shot']('14-side-chat-reopened.png')
    r['stop_record'](record);record=None
    r['shell']('am','force-stop',r['PACKAGE'])
    r['shell']('am','start','-n',r['PACKAGE']+'/com.xiamu.agent.MainActivity')
    time.sleep(1.2);r['tap']('打开抽屉',True);time.sleep(.5);r['tap']('Reading plan');time.sleep(1)
    r['shot']('15-side-chat-after-restart.png')
    count=len(history(id)['messages']);r['tap']('先做调研');time.sleep(.5)
    assert len(history(id)['messages'])==count
    (out/'side-ui-proof.json').write_text(json.dumps({'id':id,'createdFromAndroidComposer':True,'firstSendAcceptedOnce':sum(m['role']=='user' and m['text']=='Reading plan' for m in side['messages'])==1,'mainStayedBusy':main_busy,'historiesIsolated':True,'sideOptionSource':True,'drawerOnlySideChats':True,'reopenedSameId':True,'disabledOptionsSurvivedAppRestart':True},indent=2))
    r['tap']('回到主聊天',True);r['tap']('动态',True)
    r['shell']('cmd','uimode','night','yes');time.sleep(1.2);r['swipe']();time.sleep(.4)
    assert not any(n.attrib.get('text')=='动态' for n in r['nodes']())
    r['shot']('04-feed-scrolled-dark.png')
    r['shell']('cmd','uimode','night','no')
    print('R2 SIDE CHAT PASS',flush=True)
finally:
    if record:
        try:r['stop_record'](record)
        except Exception:pass
    try:r['adb']('emu','kill')
    except Exception:pass
    host=out/'side-host/demo-host.json'
    if host.exists():
        pid=json.loads(host.read_text())['pid']
        command=subprocess.run(['ps','-p',str(pid),'-o','command='],capture_output=True,text=True).stdout
        if 'v08-demo.mjs' in command:
            try:os.kill(pid,15)
            except ProcessLookupError:pass
    print('CLEANUP REQUESTED',flush=True)
