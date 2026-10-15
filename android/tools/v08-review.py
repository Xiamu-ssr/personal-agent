#!/usr/bin/env python3
"""Small adb UI driver for the local 0.8 host. Never selects a physical device."""
import json,os,re,subprocess,time,urllib.request,xml.etree.ElementTree as ET
from pathlib import Path
SERIAL='emulator-5554'; PACKAGE='com.xiamu.agent.checks'; SHOTS=Path(os.environ.get('V08_REVIEW_SHOTS','/tmp/v08-android-shots'));SHOTS.mkdir(parents=True,exist_ok=True)
def adb(*args,timeout=25): return subprocess.check_output(['adb','-s',SERIAL,*args],timeout=timeout)
def shell(*args): return adb('shell',*args).decode(errors='replace')
def dump():
    for attempt in range(3):
        try:
            result=shell('uiautomator','dump','/sdcard/v08-window.xml')
            if 'ERROR' not in result:
                return ET.fromstring(adb('exec-out','cat','/sdcard/v08-window.xml'))
        except (subprocess.SubprocessError,ET.ParseError): pass
        time.sleep(.4)
    raise RuntimeError('uiautomator did not produce a current root node')
def nodes(): return list(dump().iter('node'))
def bounds(node):
    a=list(map(int,re.findall(r'\d+',node.attrib['bounds'])));return ((a[0]+a[2])//2,(a[1]+a[3])//2)
def tap(label,desc=False,occurrence=0):
    attr='content-desc' if desc else 'text'; matches=[n for n in nodes() if n.attrib.get(attr,'').strip()==label]
    if not matches: raise RuntimeError('Missing UI '+label)
    x,y=bounds(matches[occurrence]);shell('input','tap',str(x),str(y));time.sleep(.5)
def click(x,y): shell('input','tap',str(x),str(y));time.sleep(.3)
def text(value): shell('input','text',value.replace(' ','%s'))
def edit(value,index=0):
    n=[n for n in nodes() if n.attrib.get('class')=='android.widget.EditText'][index]
    click(*bounds(n));text(value)
def back(): shell('input','keyevent','4');time.sleep(.4)
def shot(name):
    p=SHOTS/name;p.write_bytes(adb('exec-out','screencap','-p'));print(str(p),flush=True);return str(p)
def swipe(up=True):
    wh=re.search(r'(\d+)x(\d+)',shell('wm','size'));w,h=map(int,wh.groups())
    shell('input','swipe',str(w//2),str(int(h*(.76 if up else .3))),str(w//2),str(int(h*(.3 if up else .76))),'450');time.sleep(.6)
def control(**body):
    r=urllib.request.urlopen(urllib.request.Request('http://127.0.0.1:18769/',data=json.dumps(body).encode(),headers={'Content-Type':'application/json'}),timeout=25)
    return json.load(r)
def api(path,body=None,method=None):
    r=urllib.request.urlopen(urllib.request.Request('http://127.0.0.1:18768'+path,data=json.dumps(body).encode() if body is not None else None,method=method,headers={'Content-Type':'application/json','Authorization':'Bearer local-android-demo-only'}),timeout=30)
    return json.load(r)
def send(value):
    edit(value);tap('发送',desc=True);back()
def start_record(name):
    p=subprocess.Popen(['adb','-s',SERIAL,'shell','screenrecord','--bit-rate','2000000','--time-limit','180','/sdcard/'+name],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    time.sleep(.4);return (p,name)
def stop_record(record):
    p,name=record
    for pid in shell('pidof','screenrecord').split(): shell('kill','-2',pid)
    p.wait(timeout=10);adb('pull','/sdcard/'+name,str(SHOTS/name));shell('rm','/sdcard/'+name);return str(SHOTS/name)
if __name__=='__main__':
    import sys
    cmd=sys.argv[1]
    if cmd=='dump':
        for n in nodes():
            a=n.attrib
            if a.get('text') or a.get('content-desc') or a.get('class')=='android.widget.EditText': print({k:a[k] for k in ['text','content-desc','class','bounds','clickable','enabled'] if k in a})
    elif cmd=='tap': tap(sys.argv[2],len(sys.argv)>3 and sys.argv[3]=='desc')
    elif cmd=='shot': shot(sys.argv[2])
    elif cmd=='send': send(sys.argv[2])
    elif cmd=='back': back()
    elif cmd=='swipe': swipe(len(sys.argv)<3 or sys.argv[2]=='up')
