#!/usr/bin/env python3
"""Run the v0.5-style phase stress and independent sampler against an explicit loopback fixture."""
import json
import os
import subprocess
import sys
from pathlib import Path
from urllib.parse import urlparse

root = Path(__file__).resolve().parents[1]
output = root/'verification/v0.6.0/memory-pressure'
output.mkdir(parents=True,exist_ok=True)
server = os.environ.get('LOCAL_SERVICE_URL','http://127.0.0.1:18866/agent')
url = urlparse(server)
if url.scheme!='http' or url.hostname not in ('127.0.0.1','localhost','::1'):
    raise SystemExit('An explicit loopback server is required')

def system(name):
    with (output/(name+'.system.txt')).open('w') as log:
        for args in (['memory_pressure','-Q'],['sysctl','vm.swapusage'],['vm_stat']):
            subprocess.run(args,stdout=log,stderr=log,check=False)

system('before')
with (output/'v06.log').open('w') as log:
    env=dict(os.environ,STRESS_SECONDS='630')
    stress=subprocess.Popen([str(output/'v06'),'v06',str(output),'-server',server,'-onboarded','YES','-notifyMessages','NO'],cwd=root,env=env,stdout=log,stderr=log)
    (output/'run.pid').write_text(str(stress.pid))
    print(f'Owned loopback stress PID {stress.pid}; 630 seconds',flush=True)
    monitor=subprocess.Popen([sys.executable,str(root/'tools/memory-monitor.py'),'--pid',str(stress.pid),'--output',str(output/'v06-independent.csv')],cwd=root)
    try:
        code=stress.wait()
        print(f'Stress exit: {code}',flush=True)
        monitor.wait(timeout=35)
    finally:
        if stress.poll() is None: stress.terminate()
        if monitor.poll() is None: monitor.terminate(); monitor.wait()
        system('after')
rows=[json.loads(line) for line in (output/'v06.jsonl').read_text().splitlines()]
last=rows[-1]
summary=dict(duration_seconds=last['seconds'],end=last.get('end'),rss_peak_mb=max(r['rss_mb'] for r in rows),footprint_peak_mb=max(r['footprint_mb'] for r in rows),
    rss_final_mb=last['rss_mb'],footprint_final_mb=last['footprint_mb'],counts=last['counts'],window_state=last['window_state'],samples=len(rows))
(output/'summary.json').write_text(json.dumps(summary,ensure_ascii=False,indent=2)+'\n')
print(json.dumps(summary,ensure_ascii=False),flush=True)
raise SystemExit(code)
