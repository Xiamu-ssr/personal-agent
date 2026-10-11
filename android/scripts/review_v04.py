#!/usr/bin/env python3
"""Android 0.4 review: pa35 only, debug app only, in-process fake service only."""
import argparse
import re
import shutil
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "verification" / "v0.4.0"
PACKAGE = "com.xiamu.agent.checks"
ACTIVITY = "com.xiamu.agent.V4ReviewActivity"
ADB = shutil.which("adb") or "/opt/homebrew/share/android-commandlinetools/platform-tools/adb"
SCENARIOS = ("today", "today-empty", "tasks", "queue", "memory", "memory-empty",
             "dou", "diaries", "settings", "connectors", "local", "devices", "health-fallback")


def adb(*args, **kwargs):
    return subprocess.run([ADB, "-s", "emulator-5554", *args], check=True, **kwargs)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("verify", "open", "capture"))
    parser.add_argument("value", nargs="?")
    args = parser.parse_args()
    name = adb("emu", "avd", "name", capture_output=True, text=True).stdout.splitlines()[0]
    if name != "pa35":
        raise SystemExit("只允许 pa35 / emulator-5554")
    OUT.mkdir(parents=True, exist_ok=True)
    if args.action == "verify":
        try:
            with (OUT / "build.log").open("w") as log:
                subprocess.run([str(ROOT / "gradlew"), "testDebugUnitTest", "assembleDebug", "assembleRelease",
                                "assembleDebugAndroidTest"], cwd=ROOT, stdout=log, stderr=subprocess.STDOUT, check=True)
            adb("shell", "am", "force-stop", PACKAGE)
            # Install -g affects only this disposable debug package; no permission dialog is clicked.
            for apk in ("app/build/outputs/apk/debug/app-debug.apk",
                        "app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk"):
                adb("install", "-r", "-g", str(ROOT / apk))
            with (OUT / "instrumentation.log").open("w") as log:
                adb("shell", "am", "instrument", "-w", "-r", PACKAGE + ".test/androidx.test.runner.AndroidJUnitRunner",
                    stdout=log, stderr=subprocess.STDOUT)
            result = (OUT / "instrumentation.log").read_text()
            if "FAILURES" in result or not re.search(r"OK \(\d+ tests\)", result):
                raise SystemExit("模拟器检查失败，见 instrumentation.log")
            adb("pull", "/sdcard/Android/data/" + PACKAGE + "/files/v0.4.0", str(OUT.parent))
            print("本地检查通过；截图与健康证据：" + str(OUT))
        finally:
            adb("emu", "kill")
    elif args.action == "open":
        if args.value not in SCENARIOS:
            raise SystemExit("场景：" + ", ".join(SCENARIOS))
        adb("shell", "am", "force-stop", PACKAGE)
        adb("shell", "am", "start", "-W", "-n", PACKAGE + "/" + ACTIVITY, "--es", "scenario", args.value)
        print("本地假服务场景：" + args.value)
    else:
        if not args.value or not re.fullmatch(r"[a-z0-9-]+", args.value):
            raise SystemExit("截图名称只能使用小写字母、数字、短横线")
        state = adb("shell", "dumpsys", "activity", "activities", capture_output=True, text=True).stdout
        resumed = [line for line in state.splitlines() if "ResumedActivity" in line]
        if not any(PACKAGE + "/" + ACTIVITY in line for line in resumed):
            raise SystemExit("当前不是本地假服务页面，拒绝截图")
        with (OUT / (args.value + ".png")).open("wb") as image:
            adb("exec-out", "screencap", "-p", stdout=image)
        print(OUT / (args.value + ".png"))


if __name__ == "__main__":
    main()
