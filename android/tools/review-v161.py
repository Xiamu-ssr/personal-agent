#!/usr/bin/env python3
"""Run the shipped Android screens on a disposable emulator and synthetic HTTP fixture."""
import json,runpy,subprocess,time
from pathlib import Path

repo=Path(__file__).resolve().parents[2]
out=repo/'verification/v1.6.1'
r=runpy.run_path(str(Path(__file__).with_name('v08-review.py')))
r['adb'].__globals__.update(SERIAL='emulator-5566',SHOTS=out)
assert r['shell']('getprop','ro.boot.qemu').strip()=='1','Only the disposable emulator is permitted'
checks=[]
def visible(text):return any(text in (n.attrib.get('text','')+' '+n.attrib.get('content-desc','')) for n in r['nodes']())
def until(fn):
    end=time.monotonic()+20
    while time.monotonic()<end:
        if fn():return
        time.sleep(.3)
    raise AssertionError('Native UI did not settle')
def clean_billing_copy():
    for phrase in ['官方暂未提供','尚未接入余额','余量接口','公开接口']:
        assert not visible(phrase),'Internal billing explanation leaked into the product'

r['adb']('reverse','tcp:18770','tcp:18770')
r['shell']('am','force-stop',r['PACKAGE'])
prefs=b'<map><string name="server">http://127.0.0.1:18770</string><string name="token">synthetic-layout-token</string><string name="deviceId">layout-ui-review</string><string name="appearance">dark</string><boolean name="notifyMessages" value="false"/></map>'
subprocess.run(['adb','-s','emulator-5566','shell',"run-as com.xiamu.agent.checks sh -c 'cat > shared_prefs/agent.xml'"],input=prefs,check=True)
r['shell']('settings','put','system','font_scale','1.0')
r['shell']('am','start','-n',r['PACKAGE']+'/com.xiamu.agent.MainActivity')
until(lambda:visible('完整图片之后的文字'));time.sleep(1)
r['shot']('android-chat-image.png');checks.append('actual chat shows the full portrait before its caption')
r['tap']('动态');until(lambda:visible('长图完整展示'));time.sleep(1)
r['shot']('android-feed-image.png');checks.append('actual feed uses the original portrait ratio')
r['tap']('打开抽屉',True);r['tap']('设置');r['tap']('连接应用');r['tap']('云端 · 3')
until(lambda:visible('额度正常'));clean_billing_copy();r['shot']('android-connector-status.png')
r['tap']('Wind AI');until(lambda:visible('额度不足'));assert visible('额度正常');clean_billing_copy()
r['shot']('android-wind-status.png');checks.append('Wind shows compact normal/insufficient states per account')
r['shell']('settings','put','system','font_scale','1.4');time.sleep(1)
until(lambda:visible('重新测试'));clean_billing_copy();r['shot']('android-wind-large-font.png');checks.append('large text keeps account actions inside the card')
r['back']();r['back']();r['tap']('模型');until(lambda:visible('684 Flows'));clean_billing_copy();r['shot']('android-wallet-large-font.png')
checks.append('supplier wallet grows with the system font scale')
pid=r['shell']('pidof',r['PACKAGE']).strip();assert b'FATAL EXCEPTION' not in r['adb']('logcat','-d','--pid='+pid)
r['shell']('settings','put','system','font_scale','1.0')
(out/'android-ui-results.json').write_text(json.dumps({'fixture':'loopback synthetic only','physicalDevice':False,'checks':checks},ensure_ascii=False,indent=2)+'\n')
print('PASS:',len(checks),'actual native screen checks')
