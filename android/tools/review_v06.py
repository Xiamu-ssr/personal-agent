#!/usr/bin/env python3
"""Build off-device, then capture all 0.6 evidence during one pa35 boot and kill it."""
import argparse
import json
import re
import shutil
import subprocess
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "verification/v0.6.0"
SDK = Path("/opt/homebrew/share/android-commandlinetools")
ADB = shutil.which("adb") or str(SDK / "platform-tools/adb")
EMULATOR = str(SDK / "emulator/emulator")
PACKAGE = "com.xiamu.agent.checks"


def adb(*args, **kwargs):
    return subprocess.run([ADB, "-s", "emulator-5554", *args], check=True, **kwargs)


def build():
    with (OUT / "build.log").open("w") as log:
        subprocess.run([str(ROOT / "gradlew"), "testDebugUnitTest", "assembleDebug", "assembleDebugAndroidTest", "assembleRelease", "--max-workers=2"],
                       cwd=ROOT, stdout=log, stderr=subprocess.STDOUT, check=True)


def install():
    for path in ("app/build/outputs/apk/debug/app-debug.apk", "app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk"):
        adb("install", "-r", str(ROOT / path), stdout=subprocess.DEVNULL)
    adb("shell", "pm", "clear", PACKAGE, stdout=subprocess.DEVNULL)
    adb("shell", "input", "keyevent", "KEYCODE_WAKEUP", stdout=subprocess.DEVNULL)
    adb("shell", "wm", "dismiss-keyguard", stdout=subprocess.DEVNULL)


def instrument(attempt):
    log_path = OUT / ("instrumentation.log" if attempt == 1 else f"instrumentation-retry-{attempt}.log")
    with log_path.open("w") as log:
        adb("shell", "am", "instrument", "-w", "-r", "-e", "class", "com.xiamu.agent.V6Checks",
            PACKAGE + ".test/androidx.test.runner.AndroidJUnitRunner", stdout=log, stderr=subprocess.STDOUT, timeout=300)
    adb("pull", "/sdcard/Android/data/" + PACKAGE + "/files/v0.6.0", str(OUT.parent), stdout=subprocess.DEVNULL)
    result = log_path.read_text()
    match = re.search(r"OK \((\d+) tests\)", result)
    return bool(match and "FAILURES" not in result), int(match[1]) if match else 0


def polling():
    # Real elapsed time, outside Compose's JUnit clock. Never accept another launch's output.
    remote = "/sdcard/Android/data/" + PACKAGE + "/files/v0.6.0/task-polling-real.json"
    adb("shell", "am", "force-stop", PACKAGE, stdout=subprocess.DEVNULL)
    adb("shell", "rm", "-f", remote, stdout=subprocess.DEVNULL)
    adb("shell", "am", "start", "-W", "-n", PACKAGE + "/com.xiamu.agent.V6ReviewActivity", "--es", "scenario", "running", stdout=subprocess.DEVNULL)
    time.sleep(7)
    adb("shell", "input", "keyevent", "HOME", stdout=subprocess.DEVNULL)
    # onStop follows the HOME transition; existence must be observed after that write.
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        ready = subprocess.run([ADB, "-s", "emulator-5554", "shell", "test", "-s", remote], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        if ready.returncode == 0:
            break
        time.sleep(.1)
    else:
        raise RuntimeError("The ordinary page did not export a fresh polling record")
    adb("pull", remote, str(OUT / "task-polling-real.json"), stdout=subprocess.DEVNULL)
    value = json.loads((OUT / "task-polling-real.json").read_text())
    assert value.get("launchId") and value.get("clock") == "System.nanoTime", "Missing launch provenance"
    assert value["requests"] >= 3 and all(2800 <= item <= 4500 for item in value["intervalsMs"]), value


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--skip-build", action="store_true")
    parser.add_argument("--repair-session", action="store_true", help="Keep the same boot for local repairs after a failed assertion; stdin retry/finish.")
    args = parser.parse_args()
    OUT.mkdir(parents=True, exist_ok=True)
    if not args.skip_build:
        build()
    else:
        for apk, directories in (("app/build/outputs/apk/debug/app-debug.apk", ("app/src/main", "app/src/debug")),
                                 ("app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk", ("app/src/androidTest",))):
            target = ROOT / apk
            inputs = [ROOT / "app/build.gradle.kts"] + [p for d in directories for p in (ROOT / d).rglob("*") if p.is_file()]
            assert target.exists() and target.stat().st_mtime >= max(p.stat().st_mtime for p in inputs), "Source newer than APK; no emulator was started."
    process = None
    checked = False
    handle = (OUT / "emulator.log").open("w")
    start = time.monotonic()
    try:
        status = subprocess.run([ADB, "-s", "emulator-5554", "get-state"], capture_output=True, text=True)
        if status.returncode:
            process = subprocess.Popen([EMULATOR, "-avd", "pa35", "-port", "5554", "-no-boot-anim", "-no-audio", "-no-snapshot", "-no-window", "-gpu", "host", "-cores", "2", "-memory", "2048"], stdout=handle, stderr=subprocess.STDOUT)
        deadline = time.monotonic() + 90
        while time.monotonic() < deadline:
            ready = subprocess.run([ADB, "-s", "emulator-5554", "shell", "getprop", "sys.boot_completed"], capture_output=True, text=True)
            if ready.returncode == 0 and ready.stdout.strip() == "1":
                break
            if process is not None and process.poll() is not None:
                raise RuntimeError("pa35 exited during boot")
            time.sleep(1)
        else:
            raise RuntimeError("pa35 boot timeout")
        assert adb("emu", "avd", "name", capture_output=True, text=True).stdout.splitlines()[0] == "pa35", "Only pa35 may be used"
        checked = True
        install()
        attempt = 0
        while True:
            attempt += 1
            print(f"本次开机第 {attempt} 轮本地验收开始。", flush=True)
            passed, count = instrument(attempt)
            if passed:
                acceptance = {"fixture": "127.0.0.1 only", "avd": "pa35", "serial": "emulator-5554", "tests": count, "passed": True, "bootCount": 1, "attempts": attempt}
                (OUT / "acceptance.json").write_text(json.dumps(acceptance, ensure_ascii=False, indent=2))
                try:
                    polling()
                    acceptance["ordinaryPolling"] = {"passed": True}
                except Exception as failure:
                    acceptance["ordinaryPolling"] = {"passed": False, "reason": str(failure)}
                    raise
                finally:
                    (OUT / "acceptance.json").write_text(json.dumps(acceptance, ensure_ascii=False, indent=2))
                print(f"验收通过 {count} 项；开始关闭模拟器。", flush=True)
                break
            print("本轮有断言失败，证据已导出。", flush=True)
            if not args.repair_session:
                raise RuntimeError("Instrumentation failed")
            command = input().strip()
            if command != "retry":
                raise RuntimeError("Ended repair session")
            install()
    finally:
        if checked or process is not None:
            subprocess.run([ADB, "-s", "emulator-5554", "emu", "kill"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        if process is not None:
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                process.terminate()
                process.wait(timeout=5)
        handle.close()
        # Emulator stdout may contain generated adb public keys; never keep those in evidence.
        safe = [line for line in (OUT / "emulator.log").read_text(errors="replace").replace("\x00", "").splitlines()
                if not re.search(r"pubkey|public key|token|secret", line, re.I)]
        (OUT / "emulator.log").write_text("\n".join(safe) + "\n")
        (OUT / "emulator-session.json").write_text(json.dumps({"durationSeconds": round(time.monotonic()-start, 1), "killRequested": checked or process is not None}))
        print("本次模拟器已关闭。", flush=True)


if __name__ == "__main__":
    main()
