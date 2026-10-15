#!/usr/bin/env python3
"""Generate the five selected Sprout states using local Blender and ffmpeg."""

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

sys.dont_write_bytecode = True
from PIL import Image, ImageDraw
from generate import BASE, composite, font


STATES = ('idle', 'working', 'waiting', 'happy', 'error')
OUTPUT = BASE / 'states'
FRAMES = 60
FPS = 24
FRAME_SAMPLES = {'idle': (0, 16, 32, 45), 'working': (0, 7, 19, 41),
                 'waiting': (0, 16, 41, 50), 'happy': (0, 15, 30, 45),
                 'error': (0, 15, 30, 45)}


def render(args, state, mode):
    work = args.work / state
    work.mkdir(parents=True, exist_ok=True)
    destination = work / ('still.png' if mode == 'still' else 'rgba')
    report_path = destination.with_suffix('.render.json') if mode == 'still' else destination / 'render.json'
    report_path.unlink(missing_ok=True)
    if mode == 'animation' and destination.exists():
        for old in destination.glob('*.png'):
            old.unlink()
    resolution = 1024 if mode == 'still' else 512
    samples = args.still_samples if mode == 'still' else args.video_samples
    command = [str(args.blender), '-b', '--factory-startup', '--python-exit-code', '1',
               '-P', str(BASE / 'scripts' / 'state_scene.py'), '--', '--state', state,
               '--mode', mode, '--output', str(destination), '--resolution', str(resolution),
               '--samples', str(samples), '--frames', str(FRAMES)]
    if args.cpu:
        command.extend(['--device', 'CPU'])
    log_path = work / f'{mode}.log'
    print(f'{state} / {mode}: {resolution}px; {log_path}', flush=True)
    with log_path.open('w') as log:
        subprocess.run(command, stdout=log, stderr=subprocess.STDOUT, check=True)
    if not report_path.exists():
        raise RuntimeError(f'Incomplete Blender render; inspect {log_path}')
    if mode == 'still':
        shutil.copyfile(destination, OUTPUT / state / 'still.png')
    return destination, json.loads(report_path.read_text())


def encode(args, state, frames):
    started = time.monotonic()
    for name, background in (('light', '#FFFFFF'), ('dark', '#000000')):
        rgb_frames = frames.parent / name
        rgb_frames.mkdir(exist_ok=True)
        for source in sorted(frames.glob('*.png')):
            with Image.open(source) as image:
                composite(image, background).save(rgb_frames / source.name)
        command = [str(args.ffmpeg), '-y', '-hide_banner', '-loglevel', 'error',
                   '-framerate', str(FPS), '-i', str(rgb_frames / '%04d.png'),
                   '-frames:v', str(FRAMES), '-an', '-c:v', 'libx264', '-preset', 'slow',
                   '-qp', '18', '-bf', '0', '-g', str(FRAMES),
                   '-force_key_frames', f'expr:eq(n,{FRAMES - 1})',
                   '-x264-params', 'aq-mode=0:ipratio=1:pbratio=1:scenecut=0:open-gop=0',
                   '-pix_fmt', 'yuv420p', '-color_primaries', 'bt709', '-color_trc', 'bt709',
                   '-colorspace', 'bt709', '-color_range', 'tv',
                   '-vf', 'scale=in_range=full:out_range=tv:out_color_matrix=bt709',
                   '-movflags', '+faststart', str(OUTPUT / state / f'{name}.mp4')]
        # Constant quantisation + independent first/last I frames give identical
        # decoded endpoint pixels, without making every frame an I frame.
        subprocess.run(command, check=True)
    return round(time.monotonic() - started, 3)


def contact_sheet(ffmpeg, state, qa):
    destination = qa / state
    destination.mkdir(parents=True, exist_ok=True)
    selected = FRAME_SAMPLES[state]
    sheet = Image.new('RGB', (1024, 566), '#FFFFFF')
    sheet.paste(Image.new('RGB', (1024, 283), '#000000'), (0, 283))
    draw = ImageDraw.Draw(sheet)
    for row, name in enumerate(('light', 'dark')):
        selection = 'select=' + '+'.join(rf'eq(n\,{n})' for n in selected)
        subprocess.run([str(ffmpeg), '-y', '-v', 'error', '-i', str(OUTPUT / state / f'{name}.mp4'),
                        '-vf', selection, '-fps_mode', 'vfr',
                        str(destination / f'{name}-%02d.png')], check=True)
        for column, frame in enumerate(sorted(destination.glob(f'{name}-*.png'))):
            with Image.open(frame) as image:
                sheet.paste(image.convert('RGB').resize((256, 256), Image.Resampling.LANCZOS),
                            (column * 256, row * 283))
            color = '#292929' if row == 0 else '#EEEEEE'
            draw.text((column * 256 + 10, row * 283 + 263),
                      f'{state} / {selected[column] / FPS:.3f}s', font=font(13), fill=color)
    sheet.save(OUTPUT / state / 'frames.png', optimize=True)


def overview():
    if not all((OUTPUT / state / 'still.png').exists() for state in STATES):
        return
    sheet = Image.new('RGB', (2000, 960), '#FFFFFF')
    sheet.paste(Image.new('RGB', (2000, 480), '#000000'), (0, 480))
    draw = ImageDraw.Draw(sheet)
    for row, background in enumerate(('#FFFFFF', '#000000')):
        foreground = '#202020' if row == 0 else '#FFFFFF'
        draw.text((24, row * 480 + 18), 'DOUDOU / SPROUT / FIVE STATES', font=font(17), fill=foreground)
        for column, state in enumerate(STATES):
            with Image.open(OUTPUT / state / 'still.png') as image:
                thumb = image.convert('RGBA').resize((384, 384), Image.Resampling.LANCZOS)
                sheet.paste(composite(thumb, background), (column * 400 + 8, row * 480 + 47))
            draw.text((column * 400 + 24, row * 480 + 440), state.upper(), font=font(23), fill=foreground)
    sheet.save(OUTPUT / 'overview.png', optimize=True)


def manifest_update(state, mode, report=None, encoding_seconds=None):
    path = OUTPUT / 'manifest.json'
    manifest = json.loads(path.read_text()) if path.exists() else {}
    manifest['generated_utc'] = datetime.now(timezone.utc).isoformat()
    manifest['character'] = 'A / Sprout / 芽豆'
    manifest['generator'] = 'design/mascot/scripts/state_scene.py'
    entry = manifest.setdefault('states', {}).setdefault(state, {})
    if report is not None:
        entry[mode] = report
    if encoding_seconds is not None:
        entry['animation']['composite_and_encode_seconds'] = encoding_seconds
    entry['contact_sheet_frame_indices'] = list(FRAME_SAMPLES[state])
    entry['files'] = {p.name: {'bytes': p.stat().st_size, 'sha256': hashlib.sha256(p.read_bytes()).hexdigest()}
                      for p in sorted((OUTPUT / state).iterdir()) if p.suffix in ('.png', '.mp4')}
    path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--state', choices=('all', *STATES), default='all')
    parser.add_argument('--mode', choices=('all', 'still', 'animation', 'compose'), default='all')
    parser.add_argument('--work', type=Path, default=Path('/tmp/v08-mascot/states-final'))
    parser.add_argument('--blender', type=Path, default=Path('/Applications/Blender.app/Contents/MacOS/Blender'))
    parser.add_argument('--ffmpeg', type=Path, default=Path(shutil.which('ffmpeg') or '/opt/homebrew/bin/ffmpeg'))
    parser.add_argument('--still-samples', type=int, default=96)
    parser.add_argument('--video-samples', type=int, default=32)
    parser.add_argument('--cpu', action='store_true')
    args = parser.parse_args()
    for executable in [args.ffmpeg] + ([] if args.mode == 'compose' else [args.blender]):
        if not executable.is_file() or not os.access(executable, os.X_OK):
            parser.error(f'Existing executable unavailable: {executable}')
    start = time.monotonic()
    states = STATES if args.state == 'all' else (args.state,)
    for state in states:
        (OUTPUT / state).mkdir(parents=True, exist_ok=True)
        if args.mode in ('all', 'still'):
            _, report = render(args, state, 'still')
            manifest_update(state, 'still', report)
            print(f'{state} still: {report["total_seconds"]:.2f}s', flush=True)
        if args.mode in ('all', 'animation'):
            frames, report = render(args, state, 'animation')
            encoding_seconds = encode(args, state, frames)
            contact_sheet(args.ffmpeg, state, args.work / 'decoded')
            manifest_update(state, 'animation', report, encoding_seconds)
            print(f'{state} animation: {report["total_seconds"]:.2f}s', flush=True)
        if args.mode == 'compose':
            contact_sheet(args.ffmpeg, state, args.work / 'decoded')
            manifest_update(state, 'animation')
    overview()
    print(f'Finished in {time.monotonic() - start:.2f}s; output {OUTPUT}', flush=True)


if __name__ == '__main__':
    main()
