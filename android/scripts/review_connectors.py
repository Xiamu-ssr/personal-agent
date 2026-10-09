#!/usr/bin/env python3
"""Only drive the debug fixture activity on pa35; it has no server session."""
import argparse
import re
import subprocess
import xml.etree.ElementTree as ET
from pathlib import Path

ADB = "/opt/homebrew/share/android-commandlinetools/platform-tools/adb"
PACKAGE = "com.xiamu.agent.checks"
ACTIVITY = "com.xiamu.agent.ConnectorReviewActivity"
SCENARIOS = {"cloud", "legacy", "detail-empty", "detail-multi", "detail-error", "form-default", "form-custom", "form-failed", "form-validating", "form-edit", "form-edit-custom", "form-edit-legacy", "devices", "devices-conflict"}

def adb(*args):
    result = subprocess.run([ADB, "-s", "emulator-5554", *args], capture_output=True, timeout=25)
    if result.returncode:
        raise SystemExit("模拟器命令失败")
    return result.stdout

def tree():
    adb("shell", "uiautomator", "dump", "/sdcard/pa-connectors.xml")
    return ET.fromstring(adb("exec-out", "cat", "/sdcard/pa-connectors.xml"))

def center(node):
    bounds = list(map(int, re.findall(r"\d+", node.get("bounds", ""))))
    if len(bounds) != 4:
        raise SystemExit("控件没有坐标")
    return str((bounds[0] + bounds[2]) // 2), str((bounds[1] + bounds[3]) // 2)

parser = argparse.ArgumentParser()
parser.add_argument("action", choices=["open", "capture", "tap", "back", "swipe", "nodes"])
parser.add_argument("value", nargs="?")
args = parser.parse_args()
if adb("emu", "avd", "name").decode().splitlines()[0] != "pa35":
    raise SystemExit("只允许 pa35 / emulator-5554")

if args.action == "open":
    if args.value not in SCENARIOS:
        raise SystemExit("未知 fixture")
    adb("shell", "am", "force-stop", PACKAGE)
    adb("shell", "am", "start", "-W", "-n", PACKAGE + "/" + ACTIVITY, "--es", "scenario", args.value)
    print("本地 fixture：" + args.value)
else:
    state = adb("shell", "dumpsys", "activity", "activities").decode()
    resumed = [line for line in state.splitlines() if "ResumedActivity" in line or "mResumedActivity" in line]
    if not any(PACKAGE + "/" + ACTIVITY in line for line in resumed):
        raise SystemExit("当前不是隔离的 fixture 页面，拒绝操作")
    if args.action == "capture":
        if not args.value or not re.fullmatch(r"[a-z0-9-]+", args.value):
            raise SystemExit("截图名称无效")
        tree()
        path = Path("/tmp/pa-android-v03-" + args.value + ".png")
        path.write_bytes(adb("exec-out", "screencap", "-p"))
        print(path)
    elif args.action == "tap":
        root = tree()
        parents = {child: parent for parent in root.iter() for child in parent}
        candidates = []
        for node in root.iter("node"):
            if node.get("text") == args.value or node.get("content-desc") == args.value:
                at = node
                while at.get("clickable") != "true" and at in parents:
                    at = parents[at]
                if at.get("clickable") == "true" and at.get("enabled") != "false":
                    candidates.append(at)
        if not candidates:
            raise SystemExit("未找到控件：" + (args.value or ""))
        adb("shell", "input", "tap", *center(candidates[-1]))
        print("fixture 操作：" + args.value)
    elif args.action == "back":
        adb("shell", "input", "keyevent", "4")
    elif args.action == "swipe":
        adb("shell", "input", "swipe", "540", "1740", "540", "740", "400")
    else:
        for node in tree().iter("node"):
            if node.get("password") != "true" and (node.get("clickable") == "true" or node.get("content-desc")):
                print((node.get("text") or node.get("content-desc") or "")[:60], node.get("bounds"))
