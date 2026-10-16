#!/usr/bin/env python3
"""Prepare real native screenshots, redact private regions and compose the README hero.

Requires Pillow. Raw screenshots stay outside Git. No UI, messages, graphs or facts are synthesized.
Usage: python3 render-readme.py --captures /path/to/private-captures
"""
import argparse
import hashlib
import json
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont, ImageFilter

parser = argparse.ArgumentParser()
parser.add_argument("--captures", type=Path, required=True)
parser.add_argument("--font", default="/System/Library/Fonts/STHeiti Medium.ttc")
parser.add_argument("--output", type=Path, default=Path(__file__).resolve().parent)
args = parser.parse_args()
args.output.mkdir(parents=True, exist_ok=True)

sources = {"chat": "live-chat.png", "feed": "live-feed.png", "feed-image": "live-feed-image.png",
           "library": "live-library.png", "document": "live-document.png"}
manifest = {"source": "Actual paired macOS app; real user account, 2026-10-16", "images": {}}
for name, filename in sources.items():
    im = Image.open(args.captures / filename).convert("RGB")
    if im.size != (2200, 1520):
        raise ValueError("Re-review crop/redaction coordinates for the new capture size")
    draw = ImageDraw.Draw(im)
    # Entire conversation-name rows, including text edges, are removed rather than lightly blurred.
    masks = [[22, 890, 412, 1078]]
    if name == "library":
        # Private artifact title. Public AR research title and the native cards remain intact.
        masks.append([590, 1030, 1275, 1103])
    for box in masks:
        draw.rectangle(box, fill="#1c1c1e" if name == "library" and box[0] > 500 else "#000000")
    # Crop only the top 56 px containing the OS remote-control indicator, outside product content.
    im = im.crop((0, 56, 2200, 1520))
    dest = args.output / f"mac-{name}.png"
    im.save(dest, optimize=True)
    manifest["images"][dest.name] = {"sha256": hashlib.sha256(dest.read_bytes()).hexdigest(),
        "size": list(im.size), "redactedRegionsBeforeCrop": masks, "cropTop": 56}

# The real UI is the main image, placed in a code-drawn frame on a quiet background.
hero = Image.new("RGB", (2400, 1880), "#e8eee5")
d = ImageDraw.Draw(hero)
for y in range(1880):
    t = y / 1879
    d.line((0, y, 2400, y), fill=tuple(int(a * (1-t) + b*t) for a, b in zip((236, 241, 231), (211, 224, 211))))
font = lambda size: ImageFont.truetype(args.font, size)
d.text((116, 72), "豆豆  /  Personal Agent", font=font(60), fill="#183b2e")
d.text((118, 170), "从一句话开始，陪你把事情做完。", font=font(42), fill="#254b3b")
d.text((2280, 106), "开源 · 自部署", font=font(28), fill="#517160", anchor="rt")
shot = Image.open(args.output / "mac-chat.png").convert("RGBA")
shot.thumbnail((2160, 1440), Image.Resampling.LANCZOS)
x, y = (2400 - shot.width) // 2, 302
shadow = Image.new("RGBA", hero.size)
ImageDraw.Draw(shadow).rounded_rectangle((x, y+20, x+shot.width, y+shot.height+20), radius=40, fill=(20, 50, 34, 70))
hero = Image.alpha_composite(hero.convert("RGBA"), shadow.filter(ImageFilter.GaussianBlur(32)))
mask = Image.new("L", shot.size)
ImageDraw.Draw(mask).rounded_rectangle((0, 0, shot.width, shot.height), radius=28, fill=255)
hero.paste(shot, (x, y), mask)
d = ImageDraw.Draw(hero)
d.text((118, 1790), "真实桌面界面 · 私人会话名称已遮挡", font=font(26), fill="#517160")
d.text((2280, 1790), "Android  /  macOS  /  Your Cloud", font=font(26), fill="#517160", anchor="rt")
hero.convert("RGB").save(args.output / "hero.jpg", quality=94, subsampling=0, optimize=True)
manifest["images"]["hero.jpg"] = {"sha256": hashlib.sha256((args.output / "hero.jpg").read_bytes()).hexdigest(),
    "size": [2400, 1880], "composition": "Code-drawn background/frame + actual redacted mac-chat.png + real font glyphs"}
(args.output / "provenance.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
print("Prepared five reviewed desktop captures and one screenshot-led hero")
