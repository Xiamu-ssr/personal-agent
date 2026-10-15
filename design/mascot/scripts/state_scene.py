"""Blender-only rig and periodic poses for the selected A / Sprout mascot."""

import argparse
import json
import math
import shutil
import sys
import time
from pathlib import Path
from types import SimpleNamespace

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))
import bpy
from mathutils import Vector
import scene as core


STATES = ('idle', 'working', 'waiting', 'happy', 'error')
HERO_PHASE = {'idle': .13, 'working': .28, 'waiting': .47, 'happy': .38, 'error': .43}
PIVOT = (0, 0, .56)


def empty(name, loc, parent=None):
    obj = bpy.data.objects.new(name, None)
    bpy.context.collection.objects.link(obj)
    obj.location = loc
    obj.parent = parent or core.ROOT
    return obj


def attach(obj, group):
    """Keep neutral-pose coordinates; subsequent group deltas act at its pivot."""
    bpy.context.view_layer.update()
    obj.parent = group
    obj.matrix_parent_inverse = group.matrix_world.inverted()


def visible(obj, value):
    obj.hide_render = not value
    for child in obj.children:
        visible(child, value)


def box(name, loc, dimensions, mat, bevel=.035, rotation=None):
    bpy.ops.mesh.primitive_cube_add(size=1, location=loc)
    obj = bpy.context.object
    obj.name = name
    obj.scale = dimensions
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    modifier = obj.modifiers.new('Soft manufactured corners', 'BEVEL')
    modifier.width = bevel
    modifier.segments = 4
    modifier.harden_normals = True
    weighted = obj.modifiers.new('Flat panel normals', 'WEIGHTED_NORMAL')
    weighted.keep_sharp = True
    obj.data.materials.append(mat)
    core.parent(obj)
    if rotation:
        obj.rotation_euler = rotation
    return obj


def window(t, start, end):
    if not start < t < end:
        return 0.0
    return math.sin(math.pi * (t - start) / (end - start)) ** 2


def make_star(name, loc, radius, mat):
    points = []
    for side in (-1, 1):
        for i in range(10):
            angle = math.pi / 2 + i * math.pi / 5
            r = radius * (1 if i % 2 == 0 else .46)
            points.append((r * math.cos(angle), side * .018, r * math.sin(angle)))
    faces = [tuple(range(9, -1, -1)), tuple(range(10, 20))]
    faces += [(i, (i + 1) % 10, (i + 1) % 10 + 10, i + 10) for i in range(10)]
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(points, [], faces)
    mesh.update()
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.collection.objects.link(obj)
    obj.location = loc
    obj.data.materials.append(mat)
    modifier = obj.modifiers.new('Puffy star edges', 'BEVEL')
    modifier.width, modifier.segments = .012, 3
    core.parent(obj)
    return obj


def headphones(rig):
    ink = core.material('Headphones / soft charcoal', '566361', False, .55)
    cushion = core.material('Headphones / oat cushion', 'E5DBBD')
    trim = core.material('Headphones / sage trim', '91A786', False, .52)
    parts = [core.cord('Headphones / padded headband', [
        (-.86, .10, 1.77), (-.83, .10, 2.13), (-.56, .10, 2.43),
        (0, .10, 2.49), (.56, .10, 2.43), (.83, .10, 2.13), (.86, .10, 1.77)], .065, ink)]
    for side in (-1, 1):
        parts.append(core.ellipsoid('Headphones / cushion', (side * .79, -.015, 1.77),
                                    (.17, .25, .28), cushion, fur=900))
        parts.append(core.ellipsoid('Headphones / ear cup', (side * .91, -.015, 1.77),
                                    (.11, .22, .245), ink))
        parts.append(core.ellipsoid('Headphones / small inset', (side * .994, -.025, 1.77),
                                    (.035, .12, .14), trim))
    for obj in parts:
        attach(obj, rig['upper'])


def laptop():
    shell = core.material('Laptop / warm aluminium', 'DBDFD9', False, .42)
    lid_mat = core.material('Laptop / dark sage lid', '60776F', False, .48)
    key_mat = core.material('Laptop / charcoal keys', '46544F', False, .62)
    cream = core.material('Laptop / bean insignia', 'E9E2C8', False, .5)
    box('Laptop / base', (0, -1.02, .60), (1.50, .84, .09), shell, .045)
    box('Laptop / keyboard recess', (0, -.96, .651), (1.34, .51, .015), key_mat, .035)
    for row in range(3):
        for column in range(10):
            box('Laptop / key', (-.60 + column * .134, -.77 - row * .13, .665),
                (.104, .087, .019), shell, .012)
    box('Laptop / trackpad', (0, -1.255, .653), (.38, .13, .014), shell, .022)
    angle, height = math.radians(29), .44
    center = (0, -1.365 - height / 2 * math.sin(angle), .66 + height / 2 * math.cos(angle))
    box('Laptop / open screen', center, (1.24, .072, height), lid_mat, .043, (angle, 0, 0))
    # The screen faces the character. The viewer sees an original seed emblem
    # on the lid; the outer palms remain visible above and beside the small lid.
    mark = core.ellipsoid('Laptop / seed emblem', (0, center[1] - .046, center[2]),
                          (.052, .014, .075), cream, rotation=(angle, 0, -.25))
    return mark


def arm_to(rig, side, wrist, palm_scale=1):
    shoulder = Vector((side * .72, -.075, 1.28))
    wrist = Vector(wrist)
    arm = rig['parts']['arms'][side]
    delta = wrist - shoulder
    arm.location = (shoulder + wrist) * .5
    arm.rotation_mode = 'QUATERNION'
    arm.rotation_quaternion = delta.to_track_quat('Z', 'Y')
    arm.scale = (.88, .86, delta.length / .72)
    palm = rig['palms'][side]
    palm.location = wrist
    palm.scale = (palm_scale,) * 3


def build(args):
    scene = core.setup(SimpleNamespace(candidate='a', fuzz=args.fuzz, engine='CYCLES',
                                      samples=args.samples, device=args.device,
                                      resolution=args.resolution, fps=24))
    # Exact same camera, transform, world, four softboxes and floor reference
    # for all states. Padding comfortably contains the leaves and the small hop.
    original = list(core.ROOT.children)
    upper = empty('Rig / breathing and head lean', PIVOT)
    parts = core.ASSEMBLY
    for obj in original:
        if obj not in parts['feet']:
            attach(obj, upper)
    rig = {'upper': upper, 'parts': parts, 'eye_controls': [], 'closed': [],
           'leaf_controls': [], 'palms': {}, 'brows': [], 'stars': []}
    thread = bpy.data.materials['Face / cocoa thread']
    eye_ink = bpy.data.materials['Eyes / espresso glass']
    for i, (eye, glints) in enumerate(zip(parts['face']['eyes'], parts['face']['glints'])):
        control = empty('Rig / eyelid ' + str(i), tuple(eye.location))
        attach(control, upper)
        for obj in [eye, *glints]:
            attach(obj, control)
        rig['eye_controls'].append(control)
        x, y, z = eye.location
        arch = .054 if args.state == 'happy' else -.026
        curve = core.cord('Face / closed smile eye', [(x - .098, y - .080, z),
                         (x, y - .087, z + arch), (x + .098, y - .080, z)], .018, eye_ink)
        attach(curve, upper)
        rig['closed'].append(curve)
        if args.state in ('working', 'error'):
            tilt = (-1 if i == 0 else 1) * (.020 if args.state == 'working' else -.010)
            brow = core.cord('Face / soft eyebrow', [(x - .07, y + .052, z + .20 - tilt),
                              (x, y + .034, z + .216), (x + .07, y + .052, z + .20 + tilt)],
                             .010, thread)
            attach(brow, upper)
            rig['brows'].append(brow)
    for i, leaf in enumerate(parts['leaves']):
        control = empty('Rig / leaf sway ' + str(i), (.01, .02, 2.50))
        attach(control, upper)
        attach(leaf, control)
        rig['leaf_controls'].append(control)
    if args.state in ('working', 'happy', 'error'):
        for side in (-1, 1):
            palm = core.ellipsoid('Padded mitten ' + str(side), (side * .82, -.04, 1.02),
                                  (.185, .19, .18), parts['materials']['green'], fur=1150)
            attach(palm, upper)
            rig['palms'][side] = palm
    if args.state == 'working':
        headphones(rig)
        laptop()
    if args.state == 'happy':
        gold = core.material('Happy / butter stars', 'E7BD64', False, .52)
        rig['stars'] = [make_star('Happy / star L', (-1.03, -.10, 2.45), .13, gold),
                        make_star('Happy / star R', (.98, -.05, 2.68), .095, gold)]
    if args.state == 'error':
        blue = core.material('Error / soft blue sweat', '8FC7D4', False, .30)

        def drop(u, v):
            cv, sv = math.cos(v), math.sin(v)
            radius = sv * (1 - .52 * cv)
            return (.078 * radius * math.cos(u), .049 * radius * math.sin(u), .142 * cv)

        rig['drop'] = core.mesh_surface('Error / one sweat drop', drop, blue, nu=48, nv=32)
        attach(rig['drop'], upper)
        shine = core.ellipsoid('Error / sweat glint', (-.018, -.047, .018), (.011, .008, .040),
                               bpy.data.materials['Eyes / softbox glint'])
        shine.parent = rig['drop']
        shine.matrix_parent_inverse.identity()
        shine.location = (-.018, -.047, .018)
    rig['mouth_points'] = [point.co.copy() for point in parts['face']['mouth'].data.splines[0].bezier_points]
    bpy.context.view_layer.update()
    return scene, rig


def pose(rig, state, t):
    cycle = 1 - math.cos(math.tau * t)
    breath = .5 * cycle
    upper, parts = rig['upper'], rig['parts']
    core.ROOT.location = (0, 0, 0)
    core.ROOT.rotation_euler = (0, 0, 0)
    upper.rotation_euler = (0, 0, 0)
    upper.scale = (1 + .004 * breath, 1 + .004 * breath, 1 + .012 * breath)
    for i, leaf in enumerate(rig['leaf_controls']):
        leaf.rotation_euler = (.012 * cycle, (-1 if i else 1) * .035 * cycle, 0)
    for side, arm in parts['arms'].items():
        arm.location = (side * .82, -.02, 1.02)
        arm.rotation_mode = 'XYZ'
        arm.rotation_euler = (0, -side * .24, side * .10)
        arm.scale = (1, 1, 1)
    blink = window(t, .48, .61)
    if state == 'waiting':
        blink = window(t, .63, .76)
        upper.rotation_euler.y = math.radians(11) + .024 * cycle
        upper.rotation_euler.z = -.015 * cycle
    if state == 'working':
        upper.rotation_euler.x = .035 + .005 * cycle
        upper.scale.z = 1 + .005 * breath
        for side in (-1, 1):
            tap = .5 - .5 * math.cos(math.tau * 4 * t + (math.pi if side < 0 else 0))
            arm_to(rig, side, (side * .59, -.94, .845 + .042 * tap), .94)
        blink = .7 * window(t, .72, .83)
    if state == 'happy':
        jump = window(t, .12, .69)
        core.ROOT.location.z = .17 * jump
        upper.scale.z = 1 + .025 * jump
        upper.rotation_euler.y = -.035 * cycle
        wave = .5 - .5 * math.cos(math.tau * 3 * t)
        arm_to(rig, 1, (1.02 + .075 * wave, -.11, 1.94 - .12 * wave))
        arm_to(rig, -1, (-1.00, -.12, 1.30 + .05 * cycle), .95)
        for i, star in enumerate(rig['stars']):
            amount = window(t, .14 + i * .04, .82 + i * .04)
            star.scale = (amount,) * 3
            star.rotation_euler.y = .18 * cycle * (-1 if i else 1)
            visible(star, amount > .015)
    if state == 'error':
        upper.rotation_euler.y = -.055 - .014 * cycle
        scratch = .5 - .5 * math.cos(math.tau * 3 * t)
        arm_to(rig, 1, (.76 + .034 * scratch, -.055, 2.03 - .075 * scratch), .94)
        arm_to(rig, -1, (-.90, -.15, 1.01), .90)
        amount = window(t, .14, .86)
        drop = rig['drop']
        z = 2.02 - .22 * max(0, min(1, (t - .14) / .72))
        x = -.59
        cv = (z - 1.35) / 1.06
        xn = (x - .086 * (cv * cv - .35)) / (.86 * (1 - .13 * cv))
        y = -.65 * (1 - .045 * cv) * math.sqrt(max(.025, 1 - cv * cv - xn * xn)) - .055
        drop.location = (x, y, z)
        drop.scale = (amount,) * 3
        visible(drop, amount > .03)
        # Hidden endpoint transforms also match, so the complete rig is periodic.
        if amount == 0:
            drop.location = (-.59, -.30, 2.02)
        blink = .70 * window(t, .66, .77)
    for i, (control, eye, glints, closed) in enumerate(zip(
            rig['eye_controls'], parts['face']['eyes'], parts['face']['glints'], rig['closed'])):
        openness = (1 - blink) * (.88 if state == 'working' else 1)
        if state == 'error':
            openness *= .94 if i == 0 else .88
        control.scale = (1, 1, max(.04, openness))
        visible(eye, state != 'happy' and openness > .16)
        for glint in glints:
            visible(glint, state != 'happy' and openness > .30)
        visible(closed, state == 'happy' or openness <= .16)
    for point, neutral in zip(parts['face']['mouth'].data.splines[0].bezier_points, rig['mouth_points']):
        value = neutral.copy()
        if state == 'happy':
            value.x *= 1.33
            if abs(value.x) < .01:
                value.z -= .023
        elif state == 'working':
            value.x *= .67
            value.z = 1.385 + (value.z - 1.385) * .45
        elif state == 'error':
            value.x *= .78
            value.z += value.x * .12
        point.co = value
    bpy.context.view_layer.update()


def pose_snapshot():
    return {obj.name: ([value for row in obj.matrix_world for value in row], obj.hide_render)
            for obj in bpy.context.scene.objects if obj.type not in ('CAMERA', 'LIGHT')}


def main():
    argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    parser = argparse.ArgumentParser()
    parser.add_argument('--state', choices=STATES, required=True)
    parser.add_argument('--mode', choices=('still', 'animation'), default='still')
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--samples', type=int, default=64)
    parser.add_argument('--resolution', type=int, default=1024)
    parser.add_argument('--frames', type=int, default=60)
    parser.add_argument('--phase', type=float)
    parser.add_argument('--device', choices=('AUTO', 'CPU'), default='AUTO')
    parser.add_argument('--fuzz', type=float, default=1)
    args = parser.parse_args(argv)
    start = time.monotonic()
    scene, rig = build(args)
    pose(rig, args.state, 0)
    first = pose_snapshot()
    pose(rig, args.state, 1)
    last = pose_snapshot()
    endpoint_error = max(abs(a - b) for name in first for a, b in zip(first[name][0], last[name][0]))
    assert endpoint_error < 1e-6 and all(first[n][1] == last[n][1] for n in first), 'Rig endpoints differ'
    setup_seconds = time.monotonic() - start
    args.output.parent.mkdir(parents=True, exist_ok=True)
    if args.mode == 'still':
        pose(rig, args.state, args.phase if args.phase is not None else HERO_PHASE[args.state])
        scene.render.filepath = str(args.output)
        bpy.ops.render.render(write_still=True)
        report_path = args.output.with_suffix('.render.json')
    else:
        args.output.mkdir(parents=True, exist_ok=True)
        for frame in range(args.frames - 1):
            scene.frame_set(frame + 1)
            pose(rig, args.state, frame / (args.frames - 1))
            scene.render.filepath = str(args.output / f'{frame:04d}.png')
            bpy.ops.render.render(write_still=True)
            print(f'STATE_FRAME {args.state} {frame + 1}/{args.frames}', flush=True)
        shutil.copyfile(args.output / '0000.png', args.output / f'{args.frames - 1:04d}.png')
        report_path = args.output / 'render.json'
    report = {'state': args.state, 'mode': args.mode, 'engine': scene.render.engine,
              'resolution': args.resolution, 'samples': args.samples,
              'fps': 24, 'frames': 1 if args.mode == 'still' else args.frames,
              'endpoint_pose_max_abs': endpoint_error, 'seed': core.SEED,
              'setup_seconds': round(setup_seconds, 3),
              'total_seconds': round(time.monotonic() - start, 3),
              'blender': bpy.app.version_string,
              'camera': {'location': list(scene.camera.location),
                         'rotation': list(scene.camera.rotation_euler),
                         'ortho_scale': scene.camera.data.ortho_scale},
              'lights': [{'name': obj.name, 'location': list(obj.location),
                          'energy': obj.data.energy, 'size': obj.data.size}
                         for obj in scene.objects if obj.type == 'LIGHT']}
    report_path.write_text(json.dumps(report, indent=2) + '\n')
    print('STATE_DONE ' + json.dumps(report), flush=True)


if __name__ == '__main__':
    main()
