#!/usr/bin/env python3
"""Read-only signature/universal/DMG validation. Never installs or launches an App."""
import hashlib
import json
import plistlib
import subprocess
from pathlib import Path

root=Path(__file__).resolve().parents[1]
out=root/'verification/v0.6.0'
app=root/'build/豆豆.app'
dmg=root/'build/doudou-0.6.0.dmg'
mount=out/'dmg-mount'
checks=[]
def run(args):
    result=subprocess.run(args,capture_output=True,text=True)
    checks.append(dict(command=args,exit_code=result.returncode,output=result.stdout+result.stderr))
    if result.returncode: raise RuntimeError('Artifact validation failed: '+args[0])
    return result.stdout+result.stderr

def sha(path):
    digest=hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda:stream.read(1<<20),b''): digest.update(chunk)
    return digest.hexdigest()

run(['codesign','--verify','--deep','--strict','--all-architectures',str(app)])
signature=run(['codesign','-dvvv',str(app)])
assert 'Authority=Doudou Local Signing' in signature
architectures=run(['lipo','-archs',str(app/'Contents/MacOS/Doudou')]).strip().split()
assert set(architectures)=={'arm64','x86_64'}
with (app/'Contents/Info.plist').open('rb') as stream: info=plistlib.load(stream)
assert info['CFBundleShortVersionString']=='0.6.0'
run(['hdiutil','verify',str(dmg)])
mount.mkdir(exist_ok=True)
attached=False
try:
    run(['hdiutil','attach','-readonly','-nobrowse','-mountpoint',str(mount),str(dmg)])
    attached=True
    mirror=mount/'豆豆.app'
    run(['codesign','--verify','--deep','--strict','--all-architectures',str(mirror)])
    assert sha(app/'Contents/MacOS/Doudou')==sha(mirror/'Contents/MacOS/Doudou')
    assert (mount/'Applications').is_symlink()
finally:
    if attached: run(['hdiutil','detach',str(mount)])
result=dict(version=info['CFBundleShortVersionString'],architectures=architectures,signing_authority='Doudou Local Signing',binary_sha256=sha(app/'Contents/MacOS/Doudou'),dmg_sha256=sha(dmg),mounted_binary_matches=True,checks=checks)
(out/'artifact-validation.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
print(json.dumps({key:value for key,value in result.items() if key!='checks'},ensure_ascii=False))
