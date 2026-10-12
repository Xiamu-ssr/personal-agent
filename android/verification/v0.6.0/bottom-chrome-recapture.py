"""One boot, loopback fixture only; recapture the three requested bottom-chrome fixes."""
import io
import json
import re
import shutil
import subprocess
import time
import xml.etree.ElementTree as ET
from pathlib import Path
from PIL import Image

OUT = Path(__file__).resolve().parent
ROOT = OUT.parents[1]
SDK = Path('/opt/homebrew/share/android-commandlinetools')
ADB = shutil.which('adb') or str(SDK / 'platform-tools/adb')
PACKAGE = 'com.xiamu.agent.checks'
ACTIVITY = PACKAGE + '/com.xiamu.agent.V6ReviewActivity'


def adb(*args, **kwargs):
    return subprocess.run([ADB, '-s', 'emulator-5554', *args], check=True, timeout=35, **kwargs)


def open_page(page, skin):
    adb('shell', 'am', 'force-stop', PACKAGE, stdout=subprocess.DEVNULL)
    adb('shell', 'am', 'start', '-W', '-n', ACTIVITY, '--es', 'scenario', page,
        '--es', 'skin', skin, stdout=subprocess.DEVNULL)
    time.sleep(5)


def screenshot(name, color):
    data = adb('exec-out', 'screencap', '-p', capture_output=True).stdout
    bitmap = Image.open(io.BytesIO(data)).convert('RGB')
    width, height = bitmap.size
    # Bottom margin + gesture inset, away from the gesture indicator itself.
    xs = (int(width * .18), int(width * .25), int(width * .75), int(width * .82))
    ys = range(height - round(32 * density), height - 1)
    assert all(bitmap.getpixel((x, y)) == color for x in xs for y in ys), name + ': list visible below dock'
    (OUT / (name + '.png')).write_bytes(data)
    print('已保存 ' + name + '.png；底部像素检查通过。', flush=True)
    return {'name': name, 'size': [width, height], 'background': list(color), 'bottomBandDp': 32}


def swipe_list(count):
    width, height = Image.open(OUT / 'today-silver.png').size
    for _ in range(count):
        adb('shell', 'input', 'swipe', str(width // 2), str(round(height * .66)),
            str(width // 2), str(round(height * .22)), '180', stdout=subprocess.DEVNULL)
        time.sleep(.12)


started = time.monotonic()
process = None
checked = False
evidence = {'bootCount': 1, 'fixture': '127.0.0.1 only', 'screenshots': []}
emulator_log = OUT / 'bottom-chrome-emulator.log'
assert subprocess.run([ADB, '-s', 'emulator-5554', 'get-state'], capture_output=True).returncode != 0, 'Emulator already running'
with emulator_log.open('w') as log:
    try:
        process = subprocess.Popen([str(SDK / 'emulator/emulator'), '-avd', 'pa35', '-port', '5554',
                                    '-no-boot-anim', '-no-audio', '-no-snapshot', '-no-window',
                                    '-gpu', 'host', '-cores', '2', '-memory', '2048'], stdout=log, stderr=subprocess.STDOUT)
        deadline = time.monotonic() + 90
        while time.monotonic() < deadline:
            boot = subprocess.run([ADB, '-s', 'emulator-5554', 'shell', 'getprop', 'sys.boot_completed'], capture_output=True, text=True)
            if boot.returncode == 0 and boot.stdout.strip() == '1':
                break
            assert process.poll() is None, 'pa35 exited during boot'
            time.sleep(1)
        else:
            raise RuntimeError('pa35 boot timeout')
        assert adb('emu', 'avd', 'name', capture_output=True, text=True).stdout.splitlines()[0] == 'pa35'
        checked = True
        adb('install', '-r', str(ROOT / 'app/build/outputs/apk/debug/app-debug.apk'), stdout=subprocess.DEVNULL)
        adb('shell', 'pm', 'clear', PACKAGE, stdout=subprocess.DEVNULL)
        adb('shell', 'input', 'keyevent', 'KEYCODE_WAKEUP', stdout=subprocess.DEVNULL)
        adb('shell', 'wm', 'dismiss-keyguard', stdout=subprocess.DEVNULL)
        dpi = adb('shell', 'wm', 'density', capture_output=True, text=True).stdout
        density = int(re.findall(r'\d+', dpi)[-1]) / 160

        open_page('today', 'silver')
        evidence['screenshots'].append(screenshot('today-silver', (243, 245, 248)))
        swipe_list(4)
        time.sleep(.7)
        (OUT / 'diagnostics/bottom-chrome-today-end.png').write_bytes(adb('exec-out', 'screencap', '-p', capture_output=True).stdout)
        open_page('today', 'night')
        evidence['screenshots'].append(screenshot('today-night', (15, 18, 22)))

        open_page('tasks', 'silver')
        swipe_list(28)
        time.sleep(.7)
        adb('shell', 'uiautomator', 'dump', '/sdcard/bottom-chrome.xml', stdout=subprocess.DEVNULL)
        xml = adb('shell', 'cat', '/sdcard/bottom-chrome.xml', capture_output=True).stdout
        (OUT / 'diagnostics/bottom-chrome-tasks-end.xml').write_bytes(xml)
        nodes = ET.fromstring(xml).iter('node')
        positions = {node.attrib['text']: list(map(int, re.findall(r'\d+', node.attrib['bounds'])))
                     for node in nodes if node.attrib.get('text')}
        footer = positions['已显示全部任务']
        background = next(value for key, value in positions.items() if '后台还有' in key)
        assert footer[3] < background[1] - round(24 * density), 'Last task is obscured by the input/tab area'
        evidence['taskListEnd'] = {'footerBounds': footer, 'backgroundTaskTextBounds': background, 'clearancePixels': background[1] - footer[3]}
        (OUT / 'diagnostics/bottom-chrome-tasks-end.png').write_bytes(adb('exec-out', 'screencap', '-p', capture_output=True).stdout)

        open_page('tasks', 'silver')
        evidence['screenshots'].append(screenshot('tasks-grouped', (243, 245, 248)))
        evidence['passed'] = True
    finally:
        if process is not None or checked:
            subprocess.run([ADB, '-s', 'emulator-5554', 'emu', 'kill'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=10)
        if process is not None:
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                process.terminate()
                process.wait(timeout=5)
        evidence['durationSeconds'] = round(time.monotonic() - started, 1)
        evidence['killRequested'] = process is not None
        qemu = subprocess.run(['pgrep', '-f', 'qemu-system'], capture_output=True, text=True)
        evidence['qemuRemaining'] = len(qemu.stdout.splitlines())
        evidence['emulator5554Offline'] = subprocess.run([ADB, '-s', 'emulator-5554', 'get-state'], capture_output=True).returncode != 0
        (OUT / 'bottom-chrome-checks.json').write_text(json.dumps(evidence, ensure_ascii=False, indent=2))
        print('模拟器已关闭；qemu 残留 ' + str(evidence['qemuRemaining']) + '。', flush=True)
        log.flush()
        safe = [line for line in emulator_log.read_text(errors='replace').replace('\x00', '').splitlines()
                if not re.search(r'pubkey|public key|token|secret', line, re.I)]
        log.seek(0)
        log.truncate()
        log.write('\n'.join(safe) + '\n')
assert evidence['qemuRemaining'] == 0 and evidence['emulator5554Offline']
