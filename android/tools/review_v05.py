#!/usr/bin/env python3
"""Build first; then briefly run pa35/5554 against the debug loopback service, export, kill."""
import argparse
import json
import re
import shutil
import subprocess
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "verification" / "v0.5.0"
SDK = Path("/opt/homebrew/share/android-commandlinetools")
ADB = shutil.which("adb") or str(SDK / "platform-tools" / "adb")
EMULATOR = str(SDK / "emulator" / "emulator")
PACKAGE = "com.xiamu.agent.checks"


def adb(*args, **kwargs):
    return subprocess.run([ADB, "-s", "emulator-5554", *args], check=True, **kwargs)


def start_review(scenario):
    adb("shell", "am", "force-stop", PACKAGE, stdout=subprocess.DEVNULL)
    # A cold disposable emulator can retain its swipe lock screen after boot.
    adb("shell", "input", "keyevent", "KEYCODE_WAKEUP", stdout=subprocess.DEVNULL)
    adb("shell", "wm", "dismiss-keyguard", stdout=subprocess.DEVNULL)
    adb("shell", "input", "keyevent", "KEYCODE_BACK", stdout=subprocess.DEVNULL)
    startup = adb("shell", "am", "start", "-W", "-n", PACKAGE + "/com.xiamu.agent.V5ReviewActivity", "--es", "scenario", scenario, capture_output=True, text=True)
    (OUT / "profile-startup.log").write_text(startup.stdout + startup.stderr)
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        windows = adb("shell", "dumpsys", "window", capture_output=True, text=True).stdout
        if re.search(r"mCurrentFocus=.*V5ReviewActivity", windows):
            return
        time.sleep(0.2)
    (OUT / "profile-focus-diagnostic.log").write_text("\n".join(line for line in windows.splitlines() if "Focus" in line or "V5Review" in line))
    crash = adb("shell", "logcat", "-d", "-b", "crash", "-s", "AndroidRuntime:E", capture_output=True, text=True).stdout
    (OUT / "profile-crash.log").write_text(crash)
    with (OUT / "profile-focus-diagnostic.png").open("wb") as screenshot:
        adb("exec-out", "screencap", "-p", stdout=screenshot)
    raise SystemExit("普通假服务页面没有获得前台焦点，未采纳性能记录。")


def measure_scroll(gpu):
    # Outside JUnit/Compose's controlled clock: measure the ordinary debug Activity's real frames.
    start_review("today")
    time.sleep(2)
    size = adb("shell", "wm", "size", capture_output=True, text=True).stdout
    height = int(re.findall(r"\d+x(\d+)", size)[-1])
    adb("shell", "dumpsys", "gfxinfo", PACKAGE, "reset", stdout=subprocess.DEVNULL)
    for start, end in [(0.72, 0.28)] * 4 + [(0.28, 0.72)] * 4:
        adb("shell", "input", "swipe", "8", str(int(height * start)), "8", str(int(height * end)), "400", stdout=subprocess.DEVNULL)
        time.sleep(0.15)
    raw = adb("shell", "dumpsys", "gfxinfo", PACKAGE, "framestats", capture_output=True, text=True).stdout
    (OUT / "scroll-gfxinfo.log").write_text(raw)
    total = re.search(r"Total frames rendered:\s*(\d+)", raw)
    jank = re.search(r"Janky frames:\s*(\d+)\s*\(([\d.]+)%\)", raw)
    result = {"source": "普通 debug Activity，未运行 Compose 测试时钟", "swipes": 8, "emulatorCores": 2, "configuredRamMb": 2048, "gpu": gpu}
    if total:
        result["frames"] = int(total[1])
    if jank:
        result.update({"jankyFrames": int(jank[1]), "jankyPercent": float(jank[2])})
    for percentile in (50, 90, 95, 99):
        value = re.search(rf"^{percentile}th percentile:\s*(\d+)ms", raw, re.MULTILINE)
        if value:
            result[f"p{percentile}Ms"] = int(value[1])
    (OUT / "scroll-real-performance.json").write_text(json.dumps(result, ensure_ascii=False, indent=2))
    with (OUT / "brief-scroll-real.png").open("wb") as screenshot:
        adb("exec-out", "screencap", "-p", stdout=screenshot)


def measure_polling():
    remote = "/sdcard/Android/data/" + PACKAGE + "/files/v0.5.0/task-polling-real.json"
    adb("shell", "rm", "-f", remote, stdout=subprocess.DEVNULL)
    start_review("running")
    time.sleep(7.5)
    with (OUT / "task-polling-real.png").open("wb") as screenshot:
        adb("exec-out", "screencap", "-p", stdout=screenshot)
    adb("shell", "input", "keyevent", "HOME", stdout=subprocess.DEVNULL)
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        ready = subprocess.run([ADB, "-s", "emulator-5554", "shell", "test", "-s", remote], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        if ready.returncode == 0:
            break
        time.sleep(0.1)
    else:
        raise SystemExit("假服务页面未导出 history 时间记录，未采纳 3 秒刷新结果。")
    adb("pull", remote, str(OUT / "task-polling-real.json"), stdout=subprocess.DEVNULL)
    result = json.loads((OUT / "task-polling-real.json").read_text())
    if result["historyRequests"] < 3 or not all(2800 <= interval <= 4500 for interval in result["intervalsMs"]):
        raise SystemExit("普通 App 的 3 秒 history 刷新未通过，见 task-polling-real.json")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--skip-build", action="store_true")
    parser.add_argument("--profile-only", action="store_true")
    parser.add_argument("--profile", choices=("all", "scroll", "polling"), default="all")
    parser.add_argument("--gpu", choices=("host", "swiftshader"), default="host")
    parser.add_argument("--classes", default="com.xiamu.agent.V5Checks,com.xiamu.agent.ContentChecks")
    parser.add_argument("--log-name", default="instrumentation.log")
    args = parser.parse_args()
    if not re.fullmatch(r"[a-zA-Z0-9.$,#]+", args.classes) or not re.fullmatch(r"[a-z0-9.-]+", args.log_name):
        raise SystemExit("检查类或日志名称无效")
    OUT.mkdir(parents=True, exist_ok=True)
    if not args.skip_build:
        with (OUT / "build.log").open("w") as log:
            subprocess.run([str(ROOT / "gradlew"), "testDebugUnitTest", "assembleDebug", "assembleDebugAndroidTest", "assembleRelease", "--max-workers=2"],
                           cwd=ROOT, stdout=log, stderr=subprocess.STDOUT, check=True)
    else:
        # A skipped build must still contain all current source changes.
        inputs = [ROOT / "app/build.gradle.kts"]
        for directory in ("app/src/main", "app/src/debug"):
            inputs.extend(path for path in (ROOT / directory).rglob("*") if path.is_file())
        debug_apk = ROOT / "app/build/outputs/apk/debug/app-debug.apk"
        test_apk = ROOT / "app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk"
        tests = [path for path in (ROOT / "app/src/androidTest").rglob("*") if path.is_file()]
        if not debug_apk.exists() or not test_apk.exists() or max(path.stat().st_mtime for path in inputs) > debug_apk.stat().st_mtime or max(path.stat().st_mtime for path in tests) > test_apk.stat().st_mtime:
            raise SystemExit("源码晚于 APK，请先重新构建；没有启动模拟器。")
    process = None
    checked = False
    exported = False
    log_handle = (OUT / "emulator.log").open("w")
    try:
        status = subprocess.run([ADB, "-s", "emulator-5554", "get-state"], capture_output=True, text=True)
        if status.returncode:
            process = subprocess.Popen([EMULATOR, "-avd", "pa35", "-port", "5554", "-no-boot-anim", "-no-audio", "-no-snapshot", "-no-window", "-gpu", args.gpu, "-cores", "2", "-memory", "2048"],
                                       stdout=log_handle, stderr=subprocess.STDOUT)
        deadline = time.monotonic() + 75
        while time.monotonic() < deadline:
            state = subprocess.run([ADB, "-s", "emulator-5554", "shell", "getprop", "sys.boot_completed"], capture_output=True, text=True)
            if state.returncode == 0 and state.stdout.strip() == "1":
                break
            if process is not None and process.poll() is not None:
                raise SystemExit("pa35 启动失败，见 emulator.log")
            time.sleep(1)
        else:
            raise SystemExit("pa35 启动超时")
        name = adb("emu", "avd", "name", capture_output=True, text=True).stdout.splitlines()[0]
        if name != "pa35":
            raise SystemExit("只允许 pa35 / emulator-5554")
        checked = True
        adb("shell", "am", "force-stop", PACKAGE, stdout=subprocess.DEVNULL)
        # Only the disposable debug packages are installed; no system permission dialogs are used.
        for apk in ("app/build/outputs/apk/debug/app-debug.apk", "app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk"):
            adb("install", "-r", str(ROOT / apk), stdout=subprocess.DEVNULL)
        # Only this disposable .checks package is cleared, including stale local service state.
        adb("shell", "pm", "clear", PACKAGE, stdout=subprocess.DEVNULL)
        adb("shell", "rm", "-rf", "/sdcard/Android/data/" + PACKAGE + "/files/v0.5.0", stdout=subprocess.DEVNULL)
        print("pa35 已启动，开始本地假服务检查。", flush=True)
        if args.profile_only:
            if args.profile in ("all", "scroll"):
                measure_scroll(args.gpu)
            if args.profile in ("all", "polling"):
                measure_polling()
            print("普通页面性能和刷新间隔记录已导出。", flush=True)
            return
        with (OUT / args.log_name).open("w") as log:
            adb("shell", "am", "instrument", "-w", "-r", "-e", "class", args.classes,
                PACKAGE + ".test/androidx.test.runner.AndroidJUnitRunner", stdout=log, stderr=subprocess.STDOUT, timeout=240)
        result = (OUT / args.log_name).read_text()
        match = re.search(r"OK \((\d+) tests\)", result)
        # Export even if an assertion failed, so the completed captures remain reviewable.
        adb("pull", "/sdcard/Android/data/" + PACKAGE + "/files/v0.5.0", str(OUT.parent), stdout=subprocess.DEVNULL)
        exported = True
        if "FAILURES" in result or not match:
            raise SystemExit("本地检查失败，见 " + str(OUT / args.log_name))
        if args.profile in ("all", "scroll"):
            measure_scroll(args.gpu)
        if args.profile in ("all", "polling"):
            measure_polling()
        (OUT / "acceptance.json").write_text(json.dumps({"fixture": "loopback only", "avd": "pa35", "serial": "emulator-5554", "tests": int(match[1]), "classes": args.classes, "passed": True}, ensure_ascii=False, indent=2))
        print("本地检查通过：" + match[1] + " 项；截图：" + str(OUT), flush=True)
    finally:
        if checked or process is not None:
            subprocess.run([ADB, "-s", "emulator-5554", "emu", "kill"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            if process is not None:
                try:
                    process.wait(timeout=8)
                except subprocess.TimeoutExpired:
                    process.terminate()
                    process.wait(timeout=5)
            print("已导出证据并关闭 pa35。" if exported else "已关闭 pa35。", flush=True)
        log_handle.close()
        # Emulator startup prints its ADB public key; keep verification logs free of key material.
        clean_lines = [line for line in (OUT / "emulator.log").read_text(errors="replace").replace("\x00", "").splitlines()
                       if not re.search(r"pubkey|public key|token|secret", line, re.IGNORECASE)]
        (OUT / "emulator.log").write_text("\n".join(clean_lines) + "\n")


if __name__ == "__main__":
    main()
