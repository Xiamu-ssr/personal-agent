#!/usr/bin/env python3
"""Copy the five agreed mascot states. Candidates are explicitly marked as placeholders."""
from pathlib import Path
import argparse, json, shutil, subprocess
root=Path(__file__).resolve().parents[2]
p=argparse.ArgumentParser();p.add_argument('--require-final',action='store_true');args=p.parse_args()
source=root/'design/mascot'; dest=root/'android/app/src/main/res/raw';dest.mkdir(parents=True,exist_ok=True)
states=['idle','working','waiting','happy','error'];manifest={}
for state in states:
    folder=source/'states'/state
    final=all((folder/f).is_file() for f in ['still.png','light.mp4','dark.mp4'])
    if args.require_final and not final: raise SystemExit(f'Missing final state: {state}')
    shutil.copy2(folder/'still.png' if final else source/'candidates/a/portrait.png',dest/f'mascot_{state}_still.png')
    for tone in ['light','dark']:
        target=dest/f'mascot_{state}_{tone}.mp4'
        if final: shutil.copy2(folder/f'{tone}.mp4',target)
        else:
            # A still loop preserves the exact black/white background while the final animations are pending.
            subprocess.run(['ffmpeg','-loglevel','error','-y','-loop','1','-i',str(source/'candidates/a'/f'preview-{"white" if tone=="light" else "black"}.png'),'-vf','scale=256:256','-t','3','-r','24','-c:v','libx264','-pix_fmt','yuv420p','-movflags','+faststart',str(target)],check=True)
    manifest[state]='final' if final else 'candidate-a-placeholder'
(root/'android/mascot-assets.json').write_text(json.dumps(manifest,indent=2)+'\n')
print(json.dumps(manifest))
