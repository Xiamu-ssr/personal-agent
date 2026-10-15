#!/usr/bin/env python3
"""Render, composite, encode and inspect the first-round Doudou candidates.

Uses the existing Blender, ffmpeg and Python/Pillow installation only. All
transient frames and logs stay in /tmp/v08-mascot (overridable with --work).
"""

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont


BASE = Path(__file__).resolve().parents[1]
CANDIDATES = {
    'a': ('A / SPROUT', '芽豆', 'A pistachio seed with two padded leaves.'),
    'b': ('B / FLOPPY', '绒豆', 'A lilac companion with long, softly drooping ears.'),
    'c': ('C / CUBE', '方豆', 'An apricot stuffed cube with a vanilla tuft.'),
}


def font(size):
    # System fonts, never copied or distributed with the assets.
    for path in ('/System/Library/Fonts/Supplemental/Arial.ttf',
                 '/System/Library/Fonts/Helvetica.ttc',
                 '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'):
        if Path(path).exists():
            return ImageFont.truetype(path, size)
    return ImageFont.load_default(size=size)


def composite(source, color):
    rgba = source.convert('RGBA')
    canvas = Image.new('RGBA', rgba.size, color)
    return Image.alpha_composite(canvas, rgba).convert('RGB')


def make_previews(candidate):
    directory = BASE / 'candidates' / candidate
    with Image.open(directory / 'portrait.png') as source:
        for name, color in (('white', '#FFFFFF'), ('black', '#000000')):
            composite(source, color).save(directory / f'preview-{name}.png', optimize=True)


def compare():
    target = BASE / 'candidates'
    if not all((target / candidate / 'portrait.png').exists() for candidate in CANDIDATES):
        return
    # White and black occupy exactly one row each. Backgrounds are pure App
    # colours; labels sit outside the character art, with the same pose/scale.
    width, row_h = 1800, 712
    sheet = Image.new('RGB', (width, row_h * 2), '#FFFFFF')
    sheet.paste(Image.new('RGB', (width, row_h), '#000000'), (0, row_h))
    draw = ImageDraw.Draw(sheet)
    for row, (background, foreground, secondary) in enumerate((
            ('#FFFFFF', '#151515', '#666666'), ('#000000', '#FFFFFF', '#ACACAC'))):
        y0 = row * row_h
        draw.text((42, y0 + 26), 'DOUDOU / 0.8 / CHARACTER STUDIES', font=font(19), fill=foreground)
        draw.text((width - 196, y0 + 27), 'LIGHT / #FFFFFF' if row == 0 else 'DARK / #000000',
                  font=font(15), fill=secondary)
        for column, (candidate, (label, _, _)) in enumerate(CANDIDATES.items()):
            with Image.open(target / candidate / 'portrait.png') as source:
                tile = source.convert('RGBA').resize((574, 574), Image.Resampling.LANCZOS)
                tile = composite(tile, background)
                sheet.paste(tile, (column * 600 + 13, y0 + 64))
            draw.text((column * 600 + 44, y0 + 642), label, font=font(27), fill=foreground)
            draw.text((column * 600 + 44, y0 + 681), '1024px master / procedural plush',
                      font=font(14), fill=secondary)
    sheet.save(target / 'compare.png', optimize=True)

    # An additional sheet samples the intended ~120dp header size at 1x.
    small = Image.new('RGB', (600, 398), '#FFFFFF')
    small.paste(Image.new('RGB', (600, 199), '#000000'), (0, 199))
    draw = ImageDraw.Draw(small)
    for row, color in enumerate(('#FFFFFF', '#000000')):
        foreground = '#222222' if row == 0 else '#FFFFFF'
        draw.text((18, row * 199 + 12), '120px / 1x', font=font(12), fill=foreground)
        for column, candidate in enumerate(CANDIDATES):
            with Image.open(target / candidate / 'portrait.png') as source:
                tile = source.convert('RGBA').resize((120, 120), Image.Resampling.LANCZOS)
                small.paste(composite(tile, color), (column * 200 + 40, row * 199 + 39))
            draw.text((column * 200 + 94, row * 199 + 170), candidate.upper(), font=font(15), fill=foreground)
    small.save(target / 'compare-120.png', optimize=True)


def run_blender(args, candidate, mode):
    resolution = 1024 if mode == 'still' else 512
    samples = args.still_samples if mode == 'still' else args.video_samples
    destination = args.work / candidate / ('portrait.png' if mode == 'still' else 'frames')
    destination.parent.mkdir(parents=True, exist_ok=True)
    # A repeated animation render must not silently reuse old extra frames.
    if mode == 'animation' and destination.exists():
        for frame in destination.glob('*.png'):
            frame.unlink()
    report_path = destination.with_suffix('.render.json') if mode == 'still' else destination / 'render.json'
    report_path.unlink(missing_ok=True)
    log_path = args.work / candidate / f'{mode}.log'
    command = [str(args.blender), '-b', '--factory-startup', '--python-exit-code', '1',
               '-P', str(BASE / 'scripts' / 'scene.py'), '--',
               '--candidate', candidate, '--mode', mode, '--output', str(destination),
               '--resolution', str(resolution), '--samples', str(samples),
               '--fps', '24', '--frames', '72', '--engine', args.engine]
    if args.cpu:
        command += ['--device', 'CPU']
    print(f'{candidate.upper()} {mode}: {resolution}px, {samples} samples; log {log_path}', flush=True)
    with log_path.open('w') as log:
        subprocess.run(command, stdout=log, stderr=subprocess.STDOUT, check=True)
    if not report_path.exists():
        raise RuntimeError(f'Blender did not finish {candidate}/{mode}; inspect {log_path}')
    report = json.loads(report_path.read_text())
    if mode == 'still':
        shutil.copyfile(destination, BASE / 'candidates' / candidate / 'portrait.png')
        make_previews(candidate)
    return destination, report


def encode(ffmpeg, frames, output):
    # Frame compositing happens before H.264 encoding, so no player-specific
    # interpretation of RGBA or alpha is required. Explicit bt709 + yuv420p
    # work with native Android and macOS video decoders.
    white = frames.parent / 'white-frames'
    white.mkdir(exist_ok=True)
    for source in sorted(frames.glob('*.png')):
        with Image.open(source) as image:
            composite(image, '#FFFFFF').save(white / source.name)
    command = [str(ffmpeg), '-y', '-hide_banner', '-loglevel', 'error', '-framerate', '24',
               '-i', str(white / '%04d.png'), '-frames:v', '72', '-an', '-c:v', 'libx264',
               '-preset', 'slow', '-crf', '19', '-pix_fmt', 'yuv420p',
               '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709',
               '-vf', 'scale=in_range=full:out_range=tv:out_color_matrix=bt709',
               '-movflags', '+faststart', str(output)]
    subprocess.run(command, check=True)


def update_manifest(candidate, kind, report, encoding_seconds=0):
    path = BASE / 'candidates' / 'manifest.json'
    manifest = json.loads(path.read_text()) if path.exists() else {}
    manifest['generated_utc'] = datetime.now(timezone.utc).isoformat()
    manifest['generator'] = 'design/mascot/scripts/scene.py'
    item = manifest.setdefault('candidates', {}).setdefault(candidate, {})
    item[kind] = report
    if kind == 'animation':
        item[kind]['composite_and_encode_seconds'] = round(encoding_seconds, 3)
    files = {}
    for file in sorted((BASE / 'candidates' / candidate).iterdir()):
        if file.suffix not in ('.png', '.mp4'):
            continue
        files[file.name] = {'bytes': file.stat().st_size,
                            'sha256': hashlib.sha256(file.read_bytes()).hexdigest()}
    item['files'] = files
    path.write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + '\n')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--candidate', choices=['all', *CANDIDATES], default='a')
    parser.add_argument('--mode', choices=['all', 'still', 'animation', 'compose'], default='all')
    parser.add_argument('--work', type=Path, default=Path('/tmp/v08-mascot/final'))
    parser.add_argument('--blender', type=Path, default=Path('/Applications/Blender.app/Contents/MacOS/Blender'))
    parser.add_argument('--ffmpeg', type=Path, default=Path(shutil.which('ffmpeg') or '/opt/homebrew/bin/ffmpeg'))
    parser.add_argument('--still-samples', type=int, default=96)
    parser.add_argument('--video-samples', type=int, default=32)
    parser.add_argument('--engine', choices=['CYCLES', 'BLENDER_EEVEE'], default='CYCLES')
    parser.add_argument('--cpu', action='store_true')
    args = parser.parse_args()
    start = time.monotonic()
    candidates = list(CANDIDATES) if args.candidate == 'all' else [args.candidate]
    if args.mode != 'compose':
        for executable in [args.blender] + ([args.ffmpeg] if args.mode != 'still' else []):
            if not executable.is_file() or not os.access(executable, os.X_OK):
                parser.error(f'Executable unavailable: {executable}; no software is installed automatically.')
    for candidate in candidates:
        output = BASE / 'candidates' / candidate
        output.mkdir(parents=True, exist_ok=True)
        if args.mode in ('all', 'still'):
            _, report = run_blender(args, candidate, 'still')
            update_manifest(candidate, 'still', report)
            print(f'{candidate.upper()} still finished: {report["total_seconds"]:.1f}s', flush=True)
        if args.mode in ('all', 'animation'):
            frames, report = run_blender(args, candidate, 'animation')
            encode_start = time.monotonic()
            encode(args.ffmpeg, frames, output / 'turntable-white.mp4')
            update_manifest(candidate, 'animation', report, time.monotonic() - encode_start)
            print(f'{candidate.upper()} animation finished: {report["total_seconds"]:.1f}s', flush=True)
        if args.mode == 'compose':
            make_previews(candidate)
    compare()
    print(f'Finished in {time.monotonic() - start:.1f}s. Output: {BASE / "candidates"}', flush=True)


if __name__ == '__main__':
    main()
