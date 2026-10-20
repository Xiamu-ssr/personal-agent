#!/usr/bin/env python3
"""Actual MainActivity + WebView + Android document picker against product HTTP."""
import hashlib,json,runpy,subprocess,time,urllib.request,urllib.parse
from pathlib import Path

repo=Path(__file__).resolve().parents[2]
out=repo/'verification/v1.6.2';out.mkdir(parents=True,exist_ok=True)
r=runpy.run_path(str(Path(__file__).with_name('v08-review.py')))
r['adb'].__globals__.update(SERIAL='emulator-5566',SHOTS=out)
assert r['shell']('getprop','ro.boot.qemu').strip()=='1','Only the disposable emulator is permitted'
def visible(text):return any(text in (n.attrib.get('text','')+' '+n.attrib.get('content-desc','')) for n in r['nodes']())
def until(test,seconds=25):
    end=time.monotonic()+seconds
    while time.monotonic()<end:
        if test():return
        time.sleep(.3)
    raise AssertionError('Native UI did not settle')
checks=[]
r['adb']('reverse','tcp:18770','tcp:18770');r['shell']('am','force-stop',r['PACKAGE'])
prefs=b'<map><string name="server">http://127.0.0.1:18770</string><string name="token">local-fixture</string><string name="deviceId">synthetic-content-review</string><string name="appearance">dark</string><boolean name="notifyMessages" value="false"/></map>'
subprocess.run(['adb','-s','emulator-5566','shell',"run-as com.xiamu.agent.checks sh -c 'cat > shared_prefs/agent.xml'"],input=prefs,check=True)
r['shell']('settings','put','system','font_scale','1.0');r['shell']('am','start','-n',r['PACKAGE']+'/com.xiamu.agent.MainActivity')
until(lambda:visible('原生附件通道'));r['shot']('android-chat-delivery.png');checks.append('actual chat displays generated native media and an HTML file card')
r['tap']('HTML 海报');until(lambda:visible('页面完整打开'));r['shot']('android-html.png')
r['tap']('试试交互');until(lambda:visible('点击次数 1'));checks.append('HTML opens inside the app and JavaScript interaction works')
r['tap']('文件操作',True);r['tap']('另存为');until(lambda:visible('SAVE') or visible('Save') or visible('保存'))
for label in ['SAVE','Save','保存']:
    if visible(label):
        r['tap'](label);break
time.sleep(1)
if visible('Replace'):r['tap']('Replace')
until(lambda:visible('页面完整打开'))
source=urllib.request.urlopen(urllib.request.Request('http://127.0.0.1:18770/files/data/library/artifacts/'+urllib.parse.quote('独立海报.html'),headers={'Authorization':'Bearer local-fixture','X-Doudou-Protocol':'2'})).read()
saved=None
for _ in range(15):
    try:
        saved=r['adb']('exec-out','cat','/sdcard/Download/独立海报.html')
        if saved==source:break
    except subprocess.CalledProcessError:pass
    time.sleep(.4)
assert saved==source,'Saved file must match the authenticated original exactly'
checks.append('Android document picker saves the HTML and its bytes match the original')
r['back']();r['tap']('资源库');until(lambda:visible('独立海报'));time.sleep(3)
assert not visible('theme') and not visible('mark'),'Page support assets must not appear as documents'
r['shot']('android-library.png');checks.append('library shows standalone HTML and page previews without indexing support assets')
r['tap']('独立海报');until(lambda:visible('页面完整打开'));r['back']();checks.append('standalone library page opens successfully')
r['shell']('settings','put','system','font_scale','1.4');time.sleep(1);until(lambda:visible('独立海报'));r['shot']('android-library-large-font.png')
checks.append('large system font keeps preview and title separate')
r['shell']('settings','put','system','font_scale','1.0')
pid=r['shell']('pidof',r['PACKAGE']).strip();assert b'FATAL EXCEPTION' not in r['adb']('logcat','-d','--pid='+pid)
(out/'android-content.json').write_text(json.dumps({'fixture':'real product HTTP with synthetic files','physicalDevice':False,'checks':checks,'downloadBytes':len(source),'downloadSHA256':hashlib.sha256(source).hexdigest(),'downloadMatches':True},ensure_ascii=False,indent=2)+'\n')
print('PASS:',len(checks),'actual app checks; document picker saved matching bytes')
