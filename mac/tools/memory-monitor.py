#!/usr/bin/env python3
"""Independent ps RSS/CPU sampling for the owned stress process, every 30 s."""
import argparse
import csv
import subprocess
import time
from datetime import datetime, timezone
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument('--pid', type=int, required=True)
parser.add_argument('--output', type=Path, required=True)
args = parser.parse_args()
command = subprocess.check_output(['ps', '-p', str(args.pid), '-o', 'args='], text=True)
if 'verification/v0.5.0/memory-pressure/' not in command or '-server http://127.0.0.1:' not in command:
    raise SystemExit('Refusing to monitor a process outside the owned loopback stress run')
args.output.parent.mkdir(parents=True, exist_ok=True)
started = time.monotonic()
with args.output.open('w') as output:
    writer = csv.writer(output)
    writer.writerow(['utc', 'monitor_seconds', 'pid', 'rss_mb', 'ps_cpu_percent', 'state'])
    tick = 0
    while True:
        sample = subprocess.run(['ps', '-p', str(args.pid), '-o', 'rss=,%cpu=,stat='], capture_output=True, text=True)
        if sample.returncode or not sample.stdout.strip():
            break
        rss, cpu, state = sample.stdout.split()
        writer.writerow([datetime.now(timezone.utc).isoformat(), round(time.monotonic()-started, 3), args.pid, round(int(rss)/1024, 3), float(cpu), state])
        output.flush()
        tick += 1
        time.sleep(max(0, started+tick*30-time.monotonic()))
