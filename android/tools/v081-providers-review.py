#!/usr/bin/env python3
"""Provider UI acceptance on emulator-5554; only fake credentials and demo data.
Start v081-providers-demo.mjs (or the real isolated local cloud harness) first.
The driver always kills the emulator, including after a failed assertion.
"""
import json,os,runpy,time
from pathlib import Path
os.environ.setdefault('V08_REVIEW_SHOTS','/tmp/v081-android-shots')
r=runpy.run_path(str(Path(__file__).with_name('v08-review.py')))
out=r['SHOTS'];mode=os.environ.get('V081_PROVIDER_MODE','fixture')
def until(fn,seconds=25):
    end=time.monotonic()+seconds
    while time.monotonic()<end:
        value=fn()
        if value:return value
        time.sleep(.3)
    raise RuntimeError('Provider review condition timed out')
def visible(text):return any(text in n.attrib.get('text','') for n in r['nodes']())
def hide_keyboard():
    if 'mInputShown=true' in r['shell']('dumpsys','input_method'):r['back']()
def field(label):
    return next(n for n in r['nodes']() if n.attrib.get('class')=='android.widget.EditText' and any(c.attrib.get('content-desc')==label for c in n.iter('node')))
def fill(label,value):
    r['click'](*r['bounds'](field(label)));r['shell']('input','keycombination','113','29');r['shell']('input','keyevent','67');r['text'](value);hide_keyboard()
def scroll_to(text,up=True):
    for _ in range(5):
        if visible(text):return
        r['swipe'](up)
    raise RuntimeError('Missing provider control '+text)
def selected(title):
    return any((n.attrib.get('selected')=='true' or n.attrib.get('checked')=='true') and any(c.attrib.get('text')==title for c in n.iter('node')) for n in r['nodes']())
def theme(dark):r['shell']('cmd','uimode','night','yes' if dark else 'no');time.sleep(.6)
def settings():return r['api']('/api/settings')
def edit_provider(name):
    scroll_to(name)
    buttons=[n for n in r['nodes']() if n.attrib.get('text')=='编辑'];r['click'](*r['bounds'](buttons[-1]))
    until(lambda:visible('留空保持不变'))
def delete_current():r['tap']('删除服务');r['tap']('删除')

try:
    r['adb']('wait-for-device',timeout=60);until(lambda:r['shell']('getprop','sys.boot_completed').strip()=='1',60)
    r['adb']('install','-r',str(Path(__file__).resolve().parents[1]/'app/build/outputs/apk/debug/app-debug.apk'),timeout=60)
    r['shell']('am','force-stop',r['PACKAGE']);r['shell']('am','start','-n',r['PACKAGE']+'/com.xiamu.agent.MainActivity')
    until(lambda:any(n.attrib.get('content-desc')=='打开抽屉' for n in r['nodes']()))
    theme(False);r['tap']('打开抽屉',True);r['tap']('设置');r['tap']('模型')
    until(lambda:visible('Demo Service'));assert visible('ZenMux（内置）')
    r['shot']('41-provider-models-light.png');theme(True);r['shot']('42-provider-models-dark.png');theme(False)
    r['tap']('Demo Sonnet');until(lambda:settings()['model']['provider']!='zenmux');assert selected('Demo Sonnet')
    builtin={'provider':'zenmux','id':'anthropic/claude-haiku-5.5'}
    r['api']('/api/settings',{'model':builtin},method='PUT');until(lambda:selected('Claude Haiku 5.5'))
    scroll_to('添加模型服务');r['tap']('添加模型服务');until(lambda:visible('Anthropic'))
    fill('名称','Local Test');fill('Base URL','https://example.test');fill('API Key','sk-test-0000abcd')
    fill('模型 ID 1','demo-new');fill('显示名 1','Demo New')
    r['tap']('显示 API Key',True);assert field('API Key').attrib.get('text')=='sk-test-0000abcd';r['tap']('隐藏 API Key',True)
    r['tap']('添加模型');scroll_to('模型 2');r['tap']('删除模型 2',True)
    scroll_to('名称',False);r['shot']('43-provider-add-form.png')
    r['control'](action='fail-next');r['control'](action='delay',ms=3500);r['tap']('测试并保存')
    assert visible('正在测试并保存…')
    until(lambda:visible('API Key 无效或模型不可用'));r['shot']('44-provider-test-error.png')
    assert not any(p['name']=='Local Test' for p in settings()['providers'])
    r['control'](action='delay',ms=350);r['tap']('测试并保存');until(lambda:visible('Local Test'))
    provider=next(p for p in settings()['providers'] if p['name']=='Local Test')
    assert provider['baseUrl']=='https://example.test' and 'apiKey' not in provider
    edit_provider('Local Test');assert field('API Key').attrib.get('text','')==''
    assert visible('••••abcd');r['shot']('45-provider-edit-masked.png')
    fill('名称','Local Test Edited');r['tap']('测试并保存');until(lambda:visible('Local Test Edited'))
    r['api']('/api/settings',{'model':{'provider':provider['id'],'id':'demo-new'}},method='PUT')
    edit_provider('Local Test Edited');delete_current();until(lambda:visible('先换到别的模型'))
    r['back']();scroll_to('Claude Haiku 5.5',False);r['tap']('Claude Haiku 5.5');until(lambda:settings()['model']==builtin)
    edit_provider('Local Test Edited');delete_current();until(lambda:not any(p['id']==provider['id'] for p in settings()['providers']))
    requests=r['control']()['requests']
    patches=[x for x in requests if x['method']=='PATCH' and x['path']=='/api/providers/'+provider['id']]
    assert patches and all(not x.get('keyPresent') for x in patches)
    pid=r['shell']('pidof',r['PACKAGE']).strip()
    log=r['adb']('logcat','-d','--pid='+pid)
    assert b'sk-test-0000abcd' not in log
    (out/('provider-app-'+mode+'.log')).write_bytes(log)
    proof={'mode':mode,'groupedSingleSelectionSaved':True,'externalSelectionSyncedOverWebSocket':True,'createFailureDidNotSave':True,'progressVisible':True,'showHidePasswordWorks':True,'addAndRemoveModelRow':True,'editKeyMaskedAndBlankOmitted':True,'activeDeleteRejectedWithCloudPrompt':True,'inactiveDeleteSucceeded':True,'apiKeyAbsentFromAppLogs':True,'requests':requests}
    (out/('provider-ui-proof-'+mode+'.json')).write_text(json.dumps(proof,ensure_ascii=False,indent=2),encoding='utf-8')
    print('PROVIDER UI PASS '+mode,flush=True)
except Exception:
    try:r['shot']('providers-interrupted.png')
    except Exception:pass
    try:(out/'providers-interrupted.xml').write_bytes(r['adb']('exec-out','cat','/sdcard/v08-window.xml'))
    except Exception:pass
    raise
finally:
    try:r['adb']('emu','kill')
    except Exception:pass
