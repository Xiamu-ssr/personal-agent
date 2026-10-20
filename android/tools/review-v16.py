#!/usr/bin/env python3
"""Exercise the actual native UI against usage-ui-fixture.mjs on a disposable emulator."""
import json, runpy, subprocess, time, urllib.request
from pathlib import Path

repo=Path(__file__).resolve().parents[2]
out=repo/'verification/v1.6.0'
r=runpy.run_path(str(Path(__file__).with_name('v08-review.py')))
r['adb'].__globals__.update(SERIAL='emulator-5566', SHOTS=out)
assert r['shell']('getprop','ro.boot.qemu').strip()=='1', 'Only the disposable emulator is permitted'
checks=[]
def api(path, body=None):
    request=urllib.request.Request('http://127.0.0.1:18770'+path,data=json.dumps(body).encode() if body is not None else None,
        headers={'content-type':'application/json'},method='PUT' if path=='/api/settings' and body else None)
    with urllib.request.urlopen(request,timeout=10) as response:return json.load(response)
def until(fn, seconds=25):
    end=time.monotonic()+seconds
    while time.monotonic()<end:
        if fn():return
        time.sleep(.3)
    raise AssertionError('UI or fixture state did not settle')
def visible(text):return any(text in (n.attrib.get('text','')+' '+n.attrib.get('content-desc','')) for n in r['nodes']())
def swipe_card():r['shell']('input','swipe','960','700','110','700','420');time.sleep(.8)

api('/api/settings',{'model':{'provider':'zenmux','id':'sample-haiku'}})
r['adb']('install','-r',str(repo/'android/app/build/outputs/apk/debug/app-debug.apk'))
r['adb']('reverse','tcp:18770','tcp:18770')
r['shell']('am','force-stop',r['PACKAGE']);r['shell']('run-as',r['PACKAGE'],'mkdir','-p','shared_prefs')
prefs=b'<map><string name="server">http://127.0.0.1:18770</string><string name="token">local-ui-fixture-only</string><string name="deviceId">usage-ui-review</string><boolean name="notifyMessages" value="false"/></map>'
subprocess.run(['adb','-s','emulator-5566','shell',"run-as com.xiamu.agent.checks sh -c 'cat > shared_prefs/agent.xml'"],input=prefs,check=True)
r['shell']('cmd','uimode','night','no');r['shell']('am','start','-n',r['PACKAGE']+'/com.xiamu.agent.MainActivity');time.sleep(1.5)
r['tap']('打开抽屉',True);r['tap']('设置');r['tap']('模型')
until(lambda:visible('684 Flows'));assert visible('3,450 Flows');r['shot']('android-model-wallet.png')
swipe_card();until(lambda:api('/__review/state')['model']['provider']=='11111111-1111-4111-8111-111111111111')
until(lambda:visible('128.6'));r['shot']('android-model-balance.png');checks.append('horizontal swipe saves the selected supplier and displays a cash balance without inventing a ratio')
r['tap']('编辑供应商',True);until(lambda:visible('删除服务'));r['tap']('名称',True);r['shell']('input','keyevent','KEYCODE_MOVE_END');r['text']('_UI');r['back']();r['tap']('测试并保存')
until(lambda:any(p['name']=='DeepSeek_UI' for p in api('/__review/state')['providers']));checks.append('native edit form saves the supplier name')
r['tap']('编辑供应商',True);until(lambda:visible('删除服务'));r['tap']('删除服务');r['tap']('删除')
until(lambda:api('/__review/state')['model']['provider']=='zenmux');until(lambda:visible('684 Flows'))
assert len(api('/__review/state')['providers'])==1;checks.append('deleting the active supplier switches to another configured supplier')
r['tap']('编辑供应商',True);until(lambda:visible('管理 Key'));r['back']();checks.append('ZenMux management credential has its own secret field')
swipe_card();until(lambda:visible('你的下一张卡片'));r['shot']('android-model-add-card.png');r['tap']('添加模型服务')
until(lambda:visible('API Key'));r['tap']('API Key',True);r['text']('synthetic-ui-key');r['back']();r['tap']('测试并保存')
until(lambda:len(api('/__review/state')['providers'])==2);until(lambda:api('/__review/state')['model']['provider']!='zenmux');checks.append('the final plus card adds and selects a supplier through the real native form')
r['back']();r['tap']('连接应用');r['tap']('云端 · 3');until(lambda:visible('1,950 积分'));r['shot']('android-connectors.png')
r['tap']('Tavily');until(lambda:visible('750 积分'));assert visible('1,200 积分');r['shot']('android-tavily-accounts.png');checks.append('connector list shows a summed allowance and details show two separate account balances')
r['back']();r['tap']('Wind AI');until(lambda:visible('官方暂未提供余量接口'));checks.append('unsupported billing endpoints remain explicit rather than showing a fabricated percentage')
pid=r['shell']('pidof',r['PACKAGE']).strip();assert b'FATAL EXCEPTION' not in r['adb']('logcat','-d','--pid='+pid)
(out/'android-ui-results.json').write_text(json.dumps({'fixture':'loopback only','physicalDevice':False,'checks':checks},ensure_ascii=False,indent=2)+'\n')
print('PASS:',len(checks),'native UI checks')
