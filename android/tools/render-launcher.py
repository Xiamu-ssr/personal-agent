#!/usr/bin/env python3
"""Render the Android adaptive foreground from the same mascot still used by mac/tools/icon.swift.

Requires Pillow. The launcher supplies the white background and the device's icon mask.
The full visible mascot fits Android's central 66/108 safe square, including circular masks.
"""
from pathlib import Path
from PIL import Image

repo = Path(__file__).resolve().parents[2]
source = repo / "design/mascot/states/idle/still.png"
mascot = Image.open(source).convert("RGBA")
mascot = mascot.crop(mascot.getbbox())
canvas = Image.new("RGBA", (432, 432))  # 108dp at xxxhdpi
mascot.thumbnail((260, 260), Image.Resampling.LANCZOS)
canvas.alpha_composite(mascot, ((432 - mascot.width) // 2, (432 - mascot.height) // 2))
dest = repo / "android/app/src/main/res/drawable-nodpi/ic_launcher_fg.png"
dest.parent.mkdir(parents=True, exist_ok=True)
canvas.save(dest, optimize=True)
print(dest.relative_to(repo))
