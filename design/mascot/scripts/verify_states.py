#!/usr/bin/env python3
"""Validate decoded state assets, including exact loop endpoints and colours."""

import argparse
import hashlib
import json
import shutil
import subprocess
import sys
from pathlib import Path

sys.dont_write_bytecode = True
from PIL import Image, ImageChops, ImageStat
from generate_states import BASE, FRAMES, FPS, OUTPUT, STATES


def check(condition, message):
    if not condition:
        raise AssertionError(message)


def mae(a, b):
    difference = ImageChops.difference(a, b)
    return sum(ImageStat.Stat(difference).mean) / 3


def inspect_video(ffmpeg, ffprobe, path, background, qa):
    info = json.loads(subprocess.check_output([ffprobe, '-v', 'error', '-show_streams',
                                               '-show_format', '-of', 'json', str(path)]))
    streams = info['streams']
    check(len(streams) == 1 and streams[0]['codec_type'] == 'video', f'{path}: no audio/extra streams')
    video = streams[0]
    check(video['codec_name'] == 'h264' and video['pix_fmt'] == 'yuv420p', f'{path}: H.264/yuv420p')
    check((video['width'], video['height']) == (512, 512), f'{path}: 512px square')
    check(video['avg_frame_rate'] == '24/1', f'{path}: 24fps')
    check(int(video['nb_frames']) == FRAMES, f'{path}: {FRAMES} frames')
    check(abs(float(info['format']['duration']) - FRAMES / FPS) < .001, f'{path}: 2.5 seconds')
    check(path.stat().st_size < 1_000_000, f'{path}: below 1MB')
    raw = subprocess.check_output([ffmpeg, '-v', 'error', '-i', str(path),
                                   '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'])
    stride = 512 * 512 * 3
    check(len(raw) == FRAMES * stride, f'{path}: full decode')
    first = Image.frombytes('RGB', (512, 512), raw[:stride])
    last = Image.frombytes('RGB', (512, 512), raw[-stride:])
    difference = ImageChops.difference(first, last)
    endpoint_mae = mae(first, last)
    endpoint_max = max(extrema[1] for extrema in difference.getextrema())
    changed = sum(1 for pixel in difference.getdata() if pixel != (0, 0, 0))
    check(endpoint_mae == 0 and endpoint_max == 0, f'{path}: identical decoded first/last frames')
    solid = Image.new('RGB', (512, 512), background)
    border_max, largest_change = 0, 0
    corner_coordinates = ((0, 0), (511, 0), (0, 511), (511, 511))
    midpoint_corners = None
    first_step, last_step = None, None
    for n in range(FRAMES):
        frame = Image.frombytes('RGB', (512, 512), raw[n * stride:(n + 1) * stride])
        for coordinate in corner_coordinates:
            check(frame.getpixel(coordinate) == background, f'{path}: exact background, frame {n}')
        delta = ImageChops.difference(frame, solid)
        for region in ((0, 0, 512, 12), (0, 500, 512, 512), (0, 0, 12, 512), (500, 0, 512, 512)):
            border_max = max(border_max, max(value[1] for value in delta.crop(region).getextrema()))
        if n == 1:
            first_step = mae(frame, first)
        if n == FRAMES - 2:
            last_step = mae(frame, last)
        if n == FRAMES // 2:
            midpoint_corners = [frame.getpixel(p) for p in corner_coordinates]
            frame.save(qa / f'{path.stem}-midpoint.png')
        largest_change = max(largest_change, mae(frame, first))
    check(border_max == 0, f'{path}: pure 12px outer border on every decoded frame')
    check(largest_change > .05, f'{path}: actual animation')
    return {'width': 512, 'height': 512, 'fps': 24, 'frames': FRAMES,
            'duration_seconds': float(info['format']['duration']),
            'codec': video['codec_name'], 'pixel_format': video['pix_fmt'], 'audio_streams': 0,
            'bytes': path.stat().st_size, 'endpoint_rgb_mae_0_255': endpoint_mae,
            'endpoint_max_channel_delta': endpoint_max, 'endpoint_changed_pixels': changed,
            'first_to_second_rgb_mae': round(first_step, 6),
            'penultimate_to_last_rgb_mae': round(last_step, 6),
            'max_animation_rgb_mae_from_start': round(largest_change, 6),
            'midpoint_corner_rgb_tl_tr_bl_br': midpoint_corners,
            'all_frames_corner_checks': FRAMES * 4,
            'all_frames_12px_border_max_channel_error': border_max}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--qa', type=Path, default=Path('/tmp/v08-mascot/states-qa'))
    args = parser.parse_args()
    ffmpeg, ffprobe = shutil.which('ffmpeg'), shutil.which('ffprobe')
    check(ffmpeg and ffprobe, 'Existing ffmpeg / ffprobe are required')
    args.qa.mkdir(parents=True, exist_ok=True)
    manifest = json.loads((OUTPUT / 'manifest.json').read_text())
    result = {'status': 'passed', 'mae_scale': 'RGB code values, 0..255', 'states': {}}
    reference_camera, reference_lights = None, None
    for state in STATES:
        entry = manifest['states'][state]
        still_report, animation_report = entry['still'], entry['animation']
        if reference_camera is None:
            reference_camera, reference_lights = still_report['camera'], still_report['lights']
        for rendered in (still_report, animation_report):
            check(rendered['camera'] == reference_camera, f'{state}: identical camera')
            check(rendered['lights'] == reference_lights, f'{state}: identical studio lighting')
            check(rendered['endpoint_pose_max_abs'] < 1e-6, f'{state}: periodic rig transforms')
        folder = OUTPUT / state
        check({p.name for p in folder.iterdir()} == {'still.png', 'light.mp4', 'dark.mp4', 'frames.png'},
              f'{state}: four requested files only')
        with Image.open(folder / 'still.png') as image:
            check(image.size == (1024, 1024) and image.mode == 'RGBA', f'{state}: RGBA 1024 still')
            alpha = image.getchannel('A')
            bounds = alpha.getbbox()
            check(alpha.getextrema() == (0, 255), f'{state}: true transparency')
            check(bounds and min(bounds[0], bounds[1], 1024 - bounds[2], 1024 - bounds[3]) >= 24,
                  f'{state}: unclipped representative pose: {bounds}')
        with Image.open(folder / 'frames.png') as image:
            check(image.size == (1024, 566), f'{state}: 4 decoded frames on each background')
        for name, metadata in entry['files'].items():
            path = folder / name
            check(hashlib.sha256(path.read_bytes()).hexdigest() == metadata['sha256'], f'{state}/{name}: hash')
            check(path.stat().st_size < 5_000_000, f'{state}/{name}: under 5MB')
        qa = args.qa / state
        qa.mkdir(exist_ok=True)
        item = {'still_alpha_bounds': bounds}
        for name, background in (('light', (255, 255, 255)), ('dark', (0, 0, 0))):
            item[name] = inspect_video(ffmpeg, ffprobe, folder / f'{name}.mp4', background, qa)
        result['states'][state] = item
        print(f'{state}: first/last MAE light={item["light"]["endpoint_rgb_mae_0_255"]}, '
              f'dark={item["dark"]["endpoint_rgb_mae_0_255"]}; exact corner + border colours; '
              f'{item["light"]["bytes"]}/{item["dark"]["bytes"]} bytes', flush=True)
    with Image.open(OUTPUT / 'overview.png') as image:
        check(image.size == (2000, 960), 'overview dimensions')
        check(image.getpixel((0, 0)) == (255, 255, 255), 'overview white row')
        check(image.getpixel((0, 481)) == (0, 0, 0), 'overview black row')
    check(not (BASE / 'candidates' / 'b').exists() and not (BASE / 'candidates' / 'c').exists(),
          'B/C candidate output directories removed')
    check((BASE / 'candidates' / 'a' / 'portrait.png').exists(), 'A candidate retained')
    check((BASE / 'candidates' / 'compare.png').exists(), 'comparison record retained')
    (OUTPUT / 'verification.json').write_text(json.dumps(result, indent=2) + '\n')
    (args.qa / 'verification.json').write_text(json.dumps(result, indent=2) + '\n')
    print('PASS: 10 videos, 600 decoded frames, exact endpoints and pure borders, 5 transparent stills.')


if __name__ == '__main__':
    main()
