#!/usr/bin/env python3
"""Validate the local 0.8 package without opening user data or accessing credentials."""
import hashlib,json,plistlib,subprocess
from pathlib import Path
root=Path(__file__).resolve().parents[1]
app=root/'build/豆豆.app'
dmg=root/'build/doudou-0.8.1.dmg'
info=plistlib.loads((app/'Contents/Info.plist').read_bytes())
assert info['CFBundleShortVersionString']=='0.8.1'
arch=subprocess.check_output(['lipo','-archs',str(app/'Contents/MacOS/Doudou')],text=True).strip()
assert set(arch.split())=={'arm64','x86_64'}
subprocess.run(['codesign','--verify','--deep','--strict',str(app)],check=True)
assets=[]
for state in ['idle','working','waiting','happy','error']:
    for name in ['still.png','light.mp4','dark.mp4']:
        file=app/'Contents/Resources/Mascot'/state/name
        assert file.is_file() and file.stat().st_size>0
        assets.append({'path':str(file.relative_to(app)),'bytes':file.stat().st_size})
report={'version':info['CFBundleShortVersionString'],'architectures':arch,'signed':True,'mascotAssets':len(assets),'dmgBytes':dmg.stat().st_size,'dmgSha256':hashlib.sha256(dmg.read_bytes()).hexdigest(),'assets':assets}
out=root/'verification/v0.8.1';out.mkdir(parents=True,exist_ok=True)
(out/'artifact.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
print(json.dumps({k:v for k,v in report.items() if k!='assets'},ensure_ascii=False))
