#!/usr/bin/env python3
"""Inspect delivered image/video files, not just successful render exit codes."""

import argparse
import hashlib
import json
import shutil
import subprocess
import sys
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw, ImageStat

sys.dont_write_bytecode = True
from generate import BASE, CANDIDATES, composite, font


def check(condition, message):
    if not condition:
        raise AssertionError(message)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--qa', type=Path, default=Path('/tmp/v08-mascot/qa'))
    args = parser.parse_args()
    ffmpeg, ffprobe = shutil.which('ffmpeg'), shutil.which('ffprobe')
    check(ffmpeg and ffprobe, 'Existing ffmpeg + ffprobe are required')
    args.qa.mkdir(parents=True, exist_ok=True)
    target = BASE / 'candidates'
    manifest = json.loads((target / 'manifest.json').read_text())
    results = []
    for candidate in CANDIDATES:
        directory = target / candidate
        if not directory.exists():
            continue  # Unselected B/C output was explicitly removed in stage two.
        portrait = directory / 'portrait.png'
        with Image.open(portrait) as source:
            check(source.size == (1024, 1024) and source.mode == 'RGBA', f'{candidate}: RGBA 1024 master')
            source.load()
            alpha = source.getchannel('A')
            bounds = alpha.getbbox()
            check(bounds and min(bounds[0], bounds[1], 1024 - bounds[2], 1024 - bounds[3]) >= 24,
                  f'{candidate}: character or fur clipped: {bounds}')
            check(alpha.getextrema() == (0, 255), f'{candidate}: real transparency and opaque body')
            for corner in ((0, 0), (1023, 0), (0, 1023), (1023, 1023)):
                check(alpha.getpixel(corner) == 0, f'{candidate}: transparent corner')
            for name, color in (('white', '#FFFFFF'), ('black', '#000000')):
                with Image.open(directory / f'preview-{name}.png') as preview:
                    check(preview.size == (1024, 1024), f'{candidate}: preview dimensions')
                    delta = ImageChops.difference(preview.convert('RGB'), composite(source, color))
                    check(delta.getbbox() is None, f'{candidate}: correct alpha compositing on {name}')
        video = directory / 'turntable-white.mp4'
        info = json.loads(subprocess.check_output([
            ffprobe, '-v', 'error', '-show_streams', '-show_format', '-of', 'json', str(video)]))
        streams = info['streams']
        check(len(streams) == 1 and streams[0]['codec_type'] == 'video', f'{candidate}: video-only container')
        stream = streams[0]
        check(stream['codec_name'] == 'h264' and stream['pix_fmt'] == 'yuv420p', f'{candidate}: portable H.264')
        check((stream['width'], stream['height']) == (512, 512), f'{candidate}: video dimensions')
        check(stream['avg_frame_rate'] == '24/1' and int(stream['nb_frames']) == 72, f'{candidate}: 72 frames / 24fps')
        check(abs(float(info['format']['duration']) - 3) < .02, f'{candidate}: three-second duration')
        # Decode the entire video; a readable container does not prove valid frames.
        subprocess.run([ffmpeg, '-v', 'error', '-i', str(video), '-f', 'null', '-'], check=True)
        frames = args.qa / candidate
        frames.mkdir(exist_ok=True)
        subprocess.run([ffmpeg, '-y', '-v', 'error', '-i', str(video), '-vf',
                        r'select=not(mod(n\,18))', '-fps_mode', 'vfr',
                        str(frames / '%02d.png')], check=True)
        strip = Image.new('RGB', (1024, 288), '#FFFFFF')
        thumbnails = []
        for index, frame in enumerate(sorted(frames.glob('*.png'))):
            with Image.open(frame) as image:
                check(min(image.convert('RGB').getpixel((0, 0))) >= 250, f'{candidate}: white video background')
                thumbnails.append(image.convert('RGB').copy())
                strip.paste(image.resize((256, 256), Image.Resampling.LANCZOS), (256 * index, 0))
        check(len(thumbnails) == 4, f'{candidate}: four turntable quadrants')
        differences = [sum(ImageStat.Stat(ImageChops.difference(thumbnails[0], image)).mean) / 3
                       for image in thumbnails[1:]]
        check(min(differences) > 1, f'{candidate}: animation actually changes the 3D view')
        ImageDraw.Draw(strip).text((15, 265), f'{candidate.upper()} / 0.00s     0.75s     1.50s     2.25s',
                                   font=font(14), fill='#222222')
        strip.save(args.qa / f'{candidate}-turntable-strip.jpg', quality=92)
        for name, metadata in manifest['candidates'][candidate]['files'].items():
            path = directory / name
            check(path.stat().st_size < 5_000_000, f'{candidate}/{name}: below 5MB')
            check(hashlib.sha256(path.read_bytes()).hexdigest() == metadata['sha256'], f'{candidate}/{name}: manifest hash')
        results.append({'candidate': candidate, 'alpha_bounds': bounds,
                        'video_frames': int(stream['nb_frames']),
                        'duration_seconds': float(info['format']['duration']),
                        'turntable_view_difference': [round(value, 3) for value in differences]})
    with Image.open(target / 'compare.png') as sheet:
        check(sheet.size == (1800, 1424), 'comparison image dimensions')
        check(sheet.getpixel((0, 0)) == (255, 255, 255), 'white comparison row')
        check(sheet.getpixel((0, 713)) == (0, 0, 0), 'black comparison row')
    with Image.open(target / 'compare-120.png') as sheet:
        check(sheet.size == (600, 398), '120px comparison sheet dimensions')
    for path in target.rglob('*'):
        if path.is_file():
            check(path.stat().st_size < 5_000_000, f'{path.name}: below 5MB')
    report = {'status': 'passed', 'candidates': results}
    (args.qa / 'verification.json').write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps(report, indent=2))
    print('Full decode, geometry bounds, alpha, background composites, dimensions, frame count, file sizes and hashes passed.')


if __name__ == '__main__':
    main()
