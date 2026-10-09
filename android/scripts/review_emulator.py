#!/usr/bin/env python3
"""Review pa35 only. Never sends chat, uploads, connects cloud tools or runs jobs."""
import argparse
import re
import subprocess
import xml.etree.ElementTree as ET
from pathlib import Path

ADB = "/opt/homebrew/share/android-commandlinetools/platform-tools/adb"
DEVICE = "emulator-5554"
BLOCKED = {"发送", "停下", "立即运行", "连接", "完成", "生成", "换一个", "每日新闻速览", "每周开销小结", "生日提醒"}

def adb(*args, binary=False):
    r = subprocess.run([ADB, "-s", DEVICE, *args], capture_output=True, timeout=25)
    if r.returncode:
        raise SystemExit("模拟器命令失败")
    return r.stdout if binary else r.stdout.decode().strip()

def tree():
    adb("shell", "uiautomator", "dump", "/sdcard/pa-window.xml")
    return ET.fromstring(adb("exec-out", "cat", "/sdcard/pa-window.xml"))

def center(n):
    a = list(map(int, re.findall(r"\d+", n.get("bounds", ""))))
    if len(a) != 4:
        raise SystemExit("控件没有坐标")
    return str((a[0] + a[2]) // 2), str((a[1] + a[3]) // 2)

p = argparse.ArgumentParser()
p.add_argument("action", choices=["capture", "tap", "back", "nodes", "swipe"])
p.add_argument("value", nargs="?")
args = p.parse_args()
if adb("emu", "avd", "name").splitlines()[0] != "pa35":
    raise SystemExit("只允许操作 pa35 / emulator-5554")

if args.action == "tap":
    if args.value in BLOCKED:
        raise SystemExit("只读验收禁止这项动作")
    root = tree()
    parents = {child: parent for parent in root.iter() for child in parent}
    candidates = []
    for n in root.iter("node"):
        if n.get("text") == args.value or n.get("content-desc") == args.value:
            at = n
            while at.get("clickable") != "true" and at in parents:
                at = parents[at]
            if at.get("clickable") == "true":
                candidates.append(at)
    if not candidates:
        raise SystemExit("没有找到可点击控件：" + (args.value or ""))
    adb("shell", "input", "tap", *center(candidates[0]))
    print("已打开：" + args.value)
elif args.action == "back":
    adb("shell", "input", "keyevent", "4")
elif args.action == "swipe":
    adb("shell", "input", "swipe", "540", "1800", "540", "750", "400")
elif args.action == "capture":
    if not args.value or not re.fullmatch(r"[a-z0-9_-]+", args.value):
        raise SystemExit("截图名只能使用小写英文、数字和短横线")
    tree()
    path = Path("/tmp/pa-android-" + args.value + ".png")
    path.write_bytes(adb("exec-out", "screencap", "-p", binary=True))
    print(str(path))
else:
    for n in tree().iter("node"):
        if n.get("password") != "true" and (n.get("clickable") == "true" or n.get("content-desc")):
            text = (n.get("text") or n.get("content-desc") or "").replace("\n", " ")[:60]
            print(text, n.get("bounds"))
