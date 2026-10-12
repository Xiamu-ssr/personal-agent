#!/usr/bin/env python3
"""Independent sampling of the owned stress process and WebKit candidates, every 30 seconds.
The XPC process list is explicitly not an assertion of attribution to this App.
"""
import argparse
import csv
import json
import subprocess
import time
from datetime import datetime, timezone
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument('--pid', type=int, required=True)
parser.add_argument('--output', type=Path, required=True)
args = parser.parse_args()
command = subprocess.check_output(['ps', '-p', str(args.pid), '-o', 'args='], text=True)
if 'verification/v0.6.0/memory-pressure/' not in command or '-server http://127.0.0.1:' not in command:
    raise SystemExit('Refusing to monitor a process outside the owned loopback stress run')
args.output.parent.mkdir(parents=True, exist_ok=True)

def webkit():
    result = []
    for line in subprocess.check_output(['ps', '-axo', 'pid=,rss=,%cpu=,comm='], text=True).splitlines():
        fields=line.strip().split(None,3)
        if len(fields)==4 and 'com.apple.WebKit.' in fields[3]:
            result.append(dict(pid=int(fields[0]),rss_mb=round(int(fields[1])/1024,3),cpu_percent=float(fields[2]),name=Path(fields[3]).name))
    return result

baseline = {r['pid'] for r in webkit()}
started = time.monotonic()
with args.output.open('w') as output, args.output.with_suffix('.webkit.jsonl').open('w') as xpc:
    writer = csv.writer(output)
    writer.writerow(['utc', 'monitor_seconds', 'pid', 'rss_mb', 'ps_cpu_percent', 'state'])
    tick = 0
    while True:
        sample = subprocess.run(['ps', '-p', str(args.pid), '-o', 'rss=,%cpu=,stat='], capture_output=True, text=True)
        if sample.returncode or not sample.stdout.strip(): break
        rss, cpu, state = sample.stdout.split()
        elapsed=round(time.monotonic()-started,3)
        writer.writerow([datetime.now(timezone.utc).isoformat(), elapsed, args.pid, round(int(rss)/1024,3), float(cpu), state])
        output.flush()
        rows=webkit()
        xpc.write(json.dumps(dict(seconds=elapsed,baseline=[r for r in rows if r['pid'] in baseline],new_candidates=[r for r in rows if r['pid'] not in baseline],attribution='candidate only; XPC ownership not proven'))+'\n')
        xpc.flush()
        tick += 1
        time.sleep(max(0, started+tick*30-time.monotonic()))
