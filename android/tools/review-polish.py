#!/usr/bin/env python3
"""Review native UI using a disposable emulator and the loopback contract fixture."""
import json, os, runpy, subprocess, time, urllib.request
from pathlib import Path

repo = Path(__file__).resolve().parents[2]
sdk = Path(os.environ.get('ANDROID_HOME', '/opt/homebrew/share/android-commandlinetools'))
out = Path('/tmp/doudou-v120-android-shots'); out.mkdir(exist_ok=True)
os.environ['PATH'] = str(sdk / 'platform-tools') + os.pathsep + os.environ['PATH']
os.environ['V08_REVIEW_SHOTS'] = str(out)
r = runpy.run_path(str(Path(__file__).with_name('v08-review.py')))
emulator = fixture = None
checks = []

def until(fn, seconds=40):
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        value = fn()
        if value: return value
        time.sleep(.3)
    raise RuntimeError('UI review timed out')

def visible(text): return any(text in (n.attrib.get('text', '') + n.attrib.get('content-desc', '')) for n in r['nodes']())
def api(path, body=None):
    request = urllib.request.Request(server + path, data=json.dumps(body).encode() if body is not None else None,
                                     headers={'Content-Type': 'application/json'})
    with urllib.request.urlopen(request, timeout=10) as response: return json.load(response)
def theme(dark): r['shell']('cmd', 'uimode', 'night', 'yes' if dark else 'no'); time.sleep(.8)

try:
    assert 'emulator-5554' not in subprocess.check_output(['adb', 'devices']).decode(), 'Refuse to use an existing emulator'
    fixture = subprocess.Popen(['node', str(repo / 'mac/tools/providers-fake-cloud.mjs')],
        env={**os.environ, 'DOUDOU_REVIEW_OUTPUT': str(out)}, stdout=(out / 'fixture.log').open('w'), stderr=subprocess.STDOUT)
    config = until(lambda: json.loads((out / 'providers-fake-cloud.json').read_text()) if (out / 'providers-fake-cloud.json').exists() and json.loads((out / 'providers-fake-cloud.json').read_text())['pid'] == fixture.pid else None)
    server = config['server']
    emulator = subprocess.Popen([str(sdk / 'emulator/emulator'), '-avd', 'pa35', '-port', '5554', '-no-window', '-no-audio', '-no-snapshot-save', '-gpu', 'swiftshader_indirect'],
        stdout=(out / 'emulator.log').open('w'), stderr=subprocess.STDOUT)
    r['adb']('wait-for-device', timeout=90)
    until(lambda: r['shell']('getprop', 'sys.boot_completed').strip() == '1', 90)
    r['shell']('settings', 'put', 'global', 'animator_duration_scale', '1')
    r['adb']('reverse', 'tcp:18768', 'tcp:' + server.rsplit(':', 1)[1])
    r['adb']('install', '-r', str(repo / 'android/app/build/outputs/apk/debug/app-debug.apk'), timeout=60)
    r['shell']('am', 'force-stop', r['PACKAGE'])
    r['shell']('run-as', r['PACKAGE'], 'mkdir', '-p', 'shared_prefs')
    prefs = b'<?xml version="1.0" encoding="utf-8"?><map><string name="server">http://127.0.0.1:18768</string><string name="token">local-ui-fixture-only</string><string name="deviceId">android-ui-review</string><boolean name="notifyMessages" value="false"/></map>'
    subprocess.run(['adb', '-s', 'emulator-5554', 'shell', "run-as com.xiamu.agent.checks sh -c 'cat > shared_prefs/agent.xml'"], input=prefs, check=True)
    r['shell']('am', 'start', '-n', r['PACKAGE'] + '/com.xiamu.agent.MainActivity')
    until(lambda: any(n.attrib.get('content-desc') == '打开抽屉' for n in r['nodes']()))
    checks.append('connected with isolated fake credentials')
    theme(False); r['shot']('01-chat-light.png')
    api('/__review/avatar', {'state': 'happy', 'text': '这件事办好了'}); time.sleep(1.2)
    r['shot']('02-companion-peek.png')
    if os.environ.get('DOUDOU_REVIEW_AVATAR_ONLY') == '1': raise SystemExit(0)
    until(lambda: visible('这件事办好了')); checks.append('completion status arrives over WebSocket')
    api('/__review/avatar', {'state': 'idle'}); theme(True); r['shot']('03-chat-dark.png')
    r['tap']('打开抽屉', True); r['tap']('设置'); until(lambda: visible('模型')); r['shot']('04-settings-dark.png')
    theme(False); r['shot']('05-settings-light.png'); r['tap']('模型')
    until(lambda: visible('示例模型服务')); r['shot']('06-models-light.png')
    r['tap']('示例 Claude'); until(lambda: api('/api/settings')['model']['provider'] == 'example')
    checks.append('native model selection saves provider and model')
    r['tap']('添加模型服务'); until(lambda: visible('硅基流动')); r['shot']('07-provider-preset.png')
    r['tap']('硅基流动'); until(lambda: visible('DeepSeek')); r['tap']('DeepSeek')
    until(lambda: visible('DeepSeek V4.1 Flash')); checks.append('native supplier menu updates preset models')
    theme(True); r['shot']('08-provider-dark.png')
    pid = r['shell']('pidof', r['PACKAGE']).strip()
    log = r['adb']('logcat', '-d', '--pid=' + pid)
    assert b'FATAL EXCEPTION' not in log
    checks.append('no app crash during native navigation and theme changes')
    (out / 'review.json').write_text(json.dumps({'checks': checks, 'screenshots': sorted(p.name for p in out.glob('*.png')), 'fixture': 'loopback only', 'physicalDevice': False}, ensure_ascii=False, indent=2))
    print('PASS: ' + str(len(checks)) + ' native Android UI checks', flush=True)
finally:
    if emulator:
        try: r['adb']('emu', 'kill')
        except Exception: pass
        try: emulator.wait(timeout=15)
        except subprocess.TimeoutExpired: emulator.terminate(); emulator.wait(timeout=10)
    if fixture:
        fixture.terminate(); fixture.wait(timeout=10)
