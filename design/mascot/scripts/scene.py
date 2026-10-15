"""Procedural Doudou candidates. Run with Blender, never with system Python.

All meshes, microfibres, shaders and studio lights are generated here. No assets,
textures, add-ons, network access or external .blend files are required.
"""

import argparse
import bisect
import json
import math
import random
import sys
import time
from pathlib import Path

import bpy
from mathutils import Vector


SEED = 80415
ROOT = None
FUZZ = 1.0
ASSEMBLY = None


def rgb(hex_color):
    """sRGB art-direction colours -> scene-linear shader inputs."""
    values = [int(hex_color[i:i + 2], 16) / 255 for i in (0, 2, 4)]
    return tuple(v / 12.92 if v <= .04045 else ((v + .055) / 1.055) ** 2.4 for v in values)


def material(name, color, fabric=True, roughness=.82):
    mat = bpy.data.materials.new(name)
    mat.diffuse_color = (*rgb(color), 1)
    mat.use_nodes = True
    nodes, links = mat.node_tree.nodes, mat.node_tree.links
    bsdf = nodes.get('Principled BSDF')
    bsdf.inputs['Base Color'].default_value = (*rgb(color), 1)
    bsdf.inputs['Roughness'].default_value = roughness
    bsdf.inputs['IOR'].default_value = 1.42
    bsdf.inputs['Specular IOR Level'].default_value = .28 if fabric else .48
    if fabric:
        bsdf.inputs['Sheen Weight'].default_value = .38
        bsdf.inputs['Sheen Roughness'].default_value = .72
        bsdf.inputs['Subsurface Weight'].default_value = .035
        bsdf.inputs['Subsurface Radius'].default_value = (.65, .36, .18)
        coord = nodes.new('ShaderNodeTexCoord')
        noise = nodes.new('ShaderNodeTexNoise')
        noise.inputs['Scale'].default_value = 165
        noise.inputs['Detail'].default_value = 2
        noise.inputs['Roughness'].default_value = .7
        links.new(coord.outputs['Generated'], noise.inputs['Vector'])
        bump = nodes.new('ShaderNodeBump')
        bump.inputs['Strength'].default_value = .3
        bump.inputs['Distance'].default_value = .022
        links.new(noise.outputs['Fac'], bump.inputs['Height'])
        links.new(bump.outputs['Normal'], bsdf.inputs['Normal'])
    return mat


def parent(obj):
    obj.parent = ROOT
    return obj


def smooth(obj, mat):
    obj.data.materials.append(mat)
    if hasattr(obj.data, 'polygons'):
        for poly in obj.data.polygons:
            poly.use_smooth = True
    parent(obj)
    return obj


def mesh_surface(name, fn, mat, nu=80, nv=48):
    vertices = [fn(u * math.tau / nu, v * math.pi / nv)
                for v in range(nv + 1) for u in range(nu)]
    faces = []
    for v in range(nv):
        for u in range(nu):
            a = v * nu + u
            b = v * nu + (u + 1) % nu
            c = (v + 1) * nu + (u + 1) % nu
            d = (v + 1) * nu + u
            # This winding faces out for the sphere parametrisation below.
            faces.append((a, d, c, b))
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(vertices, [], faces)
    mesh.update()
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.collection.objects.link(obj)
    return smooth(obj, mat)


def ellipsoid(name, loc, scale, mat, fur=0, rotation=None, kind='round'):
    def signed(v, p):
        return math.copysign(abs(v) ** p, v)

    def point(u, v):
        sv, cv = math.sin(v), math.cos(v)
        cu, su = math.cos(u), math.sin(u)
        if kind == 'cube':
            p = .43
            x = signed(sv, p) * signed(cu, p)
            y = signed(sv, p) * signed(su, p)
            z = signed(cv, p)
            # Gently stuffed, rather than a mathematically rigid box.
            x *= 1 + .012 * math.sin(v * 4 + u * 3)
            z += .017 * math.sin(u * 3) * sv
        else:
            x, y, z = sv * cu, sv * su, cv
            if kind == 'bean':
                x = x * (1 - .13 * cv) + .10 * (cv * cv - .35)
                y *= 1 - .045 * cv
                z += .045 * sv * cu
        return (scale[0] * x, scale[1] * y, scale[2] * z)

    obj = mesh_surface(name, point, mat, nu=96 if kind == 'cube' else 80)
    obj.location = loc
    if rotation:
        obj.rotation_euler = rotation
    if fur:
        fibres(obj, int(fur * FUZZ), mat)
    return obj


def fibres(obj, count, mat, length=.025):
    """Short, tapered three-sided cotton fibres, area sampled on the surface.

    A deterministic mesh is substantially cheaper than a hair simulation and
    keeps the same silhouette in stills and in the turntable.
    """
    rng = random.Random(SEED + sum(ord(c) for c in obj.name))
    mesh = obj.data
    mesh.calc_loop_triangles()
    triangles, cumulative, total = [], [], 0.0
    for tri in mesh.loop_triangles:
        if tri.area < 1e-10:
            continue
        total += tri.area
        triangles.append(tri)
        cumulative.append(total)
    vertices, faces = [], []
    for _ in range(count):
        tri = triangles[bisect.bisect_left(cumulative, rng.random() * total)]
        a, b, c = [mesh.vertices[i] for i in tri.vertices]
        r, s = math.sqrt(rng.random()), rng.random()
        weights = (1 - r, r * (1 - s), r * s)
        pos = a.co * weights[0] + b.co * weights[1] + c.co * weights[2]
        normal = (a.normal * weights[0] + b.normal * weights[1] + c.normal * weights[2]).normalized()
        axis = Vector((0, 0, 1)) if abs(normal.z) < .9 else Vector((1, 0, 0))
        tangent = normal.cross(axis).normalized()
        bitangent = normal.cross(tangent).normalized()
        angle = rng.uniform(0, math.tau)
        bend = tangent * math.cos(angle) + bitangent * math.sin(angle)
        strand_length = length * rng.uniform(.55, 1.6)
        width = rng.uniform(.0011, .0018)
        start = len(vertices)
        for step, radius in ((0, width), (.58, width * .62), (1, width * .06)):
            center = pos + normal * (strand_length * step - .0015)
            center += bend * (strand_length * .26 * step * step)
            for side in range(3):
                theta = angle + math.tau * side / 3
                p = center + radius * (tangent * math.cos(theta) + bitangent * math.sin(theta))
                vertices.append(tuple(p))
        for ring in range(2):
            for side in range(3):
                a0 = start + ring * 3 + side
                b0 = start + ring * 3 + (side + 1) % 3
                faces.append((a0, b0, b0 + 3, a0 + 3))
    data = bpy.data.meshes.new(obj.name + ' / microfibres')
    data.from_pydata(vertices, [], faces)
    data.update()
    fuzz = bpy.data.objects.new(data.name, data)
    bpy.context.collection.objects.link(fuzz)
    fuzz.parent = obj
    fuzz.data.materials.append(mat)
    for poly in data.polygons:
        poly.use_smooth = True


def cord(name, points, radius, mat, root=True):
    data = bpy.data.curves.new(name, 'CURVE')
    data.dimensions = '3D'
    data.resolution_u = 12
    data.bevel_depth = radius
    data.bevel_resolution = 4
    data.use_fill_caps = True
    spline = data.splines.new('BEZIER')
    spline.bezier_points.add(len(points) - 1)
    for point, co in zip(spline.bezier_points, points):
        point.co = co
        point.handle_left_type = 'AUTO'
        point.handle_right_type = 'AUTO'
    obj = bpy.data.objects.new(name, data)
    bpy.context.collection.objects.link(obj)
    data.materials.append(mat)
    if root:
        parent(obj)
    return obj


def face(cx, y, z, spread, eye_mat, blush_mat, stitch_mat, glint_mat, nose=False):
    parts = {'eyes': [], 'glints': [], 'cheeks': []}
    for side in (-1, 1):
        x = cx + side * spread
        parts['eyes'].append(ellipsoid('Eye L' if side < 0 else 'Eye R', (x, y, z), (.105, .078, .125), eye_mat))
        parts['glints'].append([
            ellipsoid('Eye catchlight', (x - .028, y - .071, z + .045), (.023, .010, .025), glint_mat),
            ellipsoid('Eye soft glint', (x + .025, y - .074, z - .035), (.009, .006, .010), glint_mat)])
        parts['cheeks'].append(ellipsoid('Blush', (cx + side * (spread + .20), y + .054, z - .23), (.15, .028, .073), blush_mat))
    if nose:
        ellipsoid('Velvet nose', (cx, y - .075, z - .16), (.057, .036, .043), stitch_mat)
        cord('Muzzle smile left', [(cx - .10, y - .071, z - .25),
                                  (cx - .05, y - .087, z - .28),
                                  (cx, y - .095, z - .23)], .012, stitch_mat)
        cord('Muzzle smile right', [(cx, y - .095, z - .23),
                                   (cx + .05, y - .087, z - .28),
                                   (cx + .10, y - .071, z - .25)], .012, stitch_mat)
    else:
        parts['mouth'] = cord('Embroidered smile', [(cx - .105, y - .045, z - .235),
                                                   (cx, y - .060, z - .287),
                                                   (cx + .105, y - .045, z - .235)], .014, stitch_mat)
    return parts


def seed_leaf(name, start, tip, width, mat):
    start, tip = Vector(start), Vector(tip)
    direction = tip - start
    sideways = Vector((direction.z, 0, -direction.x)).normalized()

    def point(u, v):
        t = v / math.pi
        center = start.lerp(tip, t)
        center.y -= .09 * math.sin(math.pi * t)
        pad = math.sin(math.pi * t) ** .8
        p = center + sideways * (width * pad * math.cos(u))
        p.y += .105 * pad * math.sin(u)
        return tuple(p)

    # Our parameterisation has opposite handedness; flip normals after creation.
    leaf = mesh_surface(name, point, mat, nu=48, nv=32)
    for polygon in leaf.data.polygons:
        polygon.flip()
    leaf.data.update()
    fibres(leaf, int(1600 * FUZZ), mat, length=.016)
    return leaf


def floppy_ear(side, mat, inner_mat):
    p0 = Vector((side * .50, .02, 2.32))
    p1 = Vector((side * .82, .02, 3.18))
    p2 = Vector((side * 1.42, -.03, 2.70))
    p3 = Vector((side * 1.17, -.12, 1.98))

    def center(t):
        return p0 * (1 - t) ** 3 + p1 * 3 * t * (1 - t) ** 2 + p2 * 3 * t * t * (1 - t) + p3 * t ** 3

    def point(u, v):
        t = v / math.pi
        c = center(t)
        tangent = (center(min(1, t + .001)) - center(max(0, t - .001))).normalized()
        sideways = Vector((tangent.z, 0, -tangent.x)).normalized()
        pad = math.sin(math.pi * t) ** .52
        p = c + sideways * (.215 * pad * math.cos(u))
        p.y += .155 * pad * math.sin(u)
        return tuple(p)

    ear = mesh_surface('Floppy ear ' + str(side), point, mat, nu=48, nv=48)
    for polygon in ear.data.polygons:
        polygon.flip()
    ear.data.update()
    fibres(ear, int(4200 * FUZZ), mat, length=.024)
    # Small padded inner-ear insert follows the drooping part of the ear.
    ellipsoid('Inner ear', (side * 1.08, -.171, 2.45), (.109, .038, .267),
              inner_mat, fur=350, rotation=(0, side * .22, 0))


def candidate_a(m):
    green = material('A / pistachio velvet', 'B1CA8F')
    leaf = material('A / sage leaf', '749E67')
    cream = material('A / oat mittens', 'E4DCBF')
    parts = {'arms': {}, 'feet': [], 'materials': {'green': green, 'leaf': leaf, 'cream': cream}}
    parts['body'] = ellipsoid('Bean body', (0, 0, 1.35), (.86, .65, 1.06), green, fur=25500, kind='bean')
    for side in (-1, 1):
        parts['arms'][side] = ellipsoid('Soft arm', (side * .82, -.02, 1.02), (.22, .25, .36), green,
                                        fur=2100, rotation=(0, -side * .24, side * .10))
        parts['feet'].append(ellipsoid('Oat foot', (side * .38, -.13, .28), (.265, .35, .205), cream, fur=1800))
    parts['stem'] = cord('Sprout stem', [(-.025, .02, 2.32), (.015, .02, 2.55), (.03, .02, 2.63)], .047, leaf)
    parts['leaves'] = [
        seed_leaf('Left padded leaf', (.01, .02, 2.49), (-.58, -.04, 2.91), .22, leaf),
        seed_leaf('Right padded leaf', (.01, .035, 2.51), (.58, .04, 2.79), .245, green)]
    parts['face'] = face(0, -.605, 1.64, .295, *m)
    # A subtle back seam is a seed detail, visible during the turntable.
    parts['seam'] = cord('Seed back seam', [(.04, .38, 2.23), (.06, .652, 1.56),
                                         (.04, .64, 1.10), (-.04, .39, .51)], .009,
                          material('A / seam', '93AD78'))
    return parts


def candidate_b(m):
    lilac = material('B / lilac pile', 'BBB3DB')
    inner = material('B / inner ear', 'DAC5DD')
    belly = material('B / milk belly', 'E9E3ED')
    ellipsoid('Pear body', (0, .035, .93), (.68, .53, .72), lilac, fur=12000)
    ellipsoid('Big round head', (0, -.035, 1.88), (.86, .65, .72), lilac, fur=20500)
    for side in (-1, 1):
        floppy_ear(side, lilac, inner)
        ellipsoid('Round foot', (side * .37, -.20, .25), (.31, .39, .23), lilac, fur=1900)
    ellipsoid('Milk belly patch', (0, -.465, .86), (.405, .105, .42), belly, fur=2200)
    for side in (-1, 1):
        ellipsoid('Tucked paw', (side * .48, -.418, 1.00), (.18, .19, .34), lilac,
                  fur=1900, rotation=(0, -side * .48, 0))
    ellipsoid('Pom tail', (0, .55, .81), (.25, .25, .25), belly, fur=2400)
    face(0, -.643, 1.98, .29, *m, nose=True)


def candidate_c(m):
    apricot = material('C / apricot felt', 'E2AC85')
    cream = material('C / vanilla tuft', 'F3D7AC')
    seam = material('C / tonal seam', 'C48F6B')
    ellipsoid('Stuffed rounded cube', (0, 0, 1.35), (.84, .62, .82), apricot,
              fur=29000, kind='cube')
    for side in (-1, 1):
        ellipsoid('Paddle arm', (side * .88, -.015, 1.10), (.18, .23, .35), apricot,
                  fur=1800, rotation=(0, -side * .20, 0))
        ellipsoid('Little foot', (side * .40, -.12, .38), (.25, .32, .18), cream, fur=1400)
    ellipsoid('Tuft big', (-.09, .005, 2.245), (.145, .13, .26), cream,
              fur=1000, rotation=(0, -.52, 0))
    ellipsoid('Tuft small', (.13, .03, 2.24), (.105, .115, .20), cream,
              fur=650, rotation=(0, .47, 0))
    face(0, -.636, 1.57, .305, *m)
    cord('Back seam', [(0, .58, .69), (0, .635, 1.12),
                       (0, .635, 1.72), (0, .56, 2.08)], .010, seam)
    # Three handmade cross stitches on the back, no branding or external fonts.
    for z in (1.03, 1.35, 1.67):
        cord('Back cross stitch', [(-.045, .641, z - .035), (.045, .641, z + .035)], .010, cream)
        cord('Back cross stitch', [(-.045, .643, z + .035), (.045, .643, z - .035)], .010, cream)


def light(name, loc, energy, size, color, target=(0, 0, 1.4)):
    data = bpy.data.lights.new(name, 'AREA')
    data.energy, data.shape, data.size = energy, 'DISK', size
    data.color = rgb(color)
    obj = bpy.data.objects.new(name, data)
    bpy.context.collection.objects.link(obj)
    obj.location = loc
    obj.rotation_euler = (Vector(target) - obj.location).to_track_quat('-Z', 'Y').to_euler()


def setup(args):
    global ROOT, FUZZ, ASSEMBLY
    bpy.ops.object.select_all(action='SELECT')
    bpy.ops.object.delete(use_global=False)
    FUZZ = args.fuzz
    ROOT = bpy.data.objects.new('Doudou / turntable root', None)
    bpy.context.collection.objects.link(ROOT)
    eye = material('Eyes / espresso glass', '292626', False, .16)
    blush = material('Blush / peach felt', 'DEA5A4')
    stitch = material('Face / cocoa thread', '6B5145', False, .78)
    glint = material('Eyes / softbox glint', 'FFF9EA', False, .22)
    ASSEMBLY = {'a': candidate_a, 'b': candidate_b, 'c': candidate_c}[args.candidate]((eye, blush, stitch, glint))

    scene = bpy.context.scene
    scene.render.engine = args.engine
    if args.engine == 'CYCLES':
        scene.cycles.samples = args.samples
        scene.cycles.use_denoising = True
        scene.cycles.seed = SEED
        scene.cycles.use_animated_seed = False
        scene.cycles.max_bounces = 5
        scene.cycles.diffuse_bounces = 3
        scene.cycles.glossy_bounces = 3
        scene.cycles.transparent_max_bounces = 4
        scene.cycles.adaptive_threshold = .035
        scene.render.use_persistent_data = True
        if args.device != 'CPU':
            prefs = bpy.context.preferences.addons['cycles'].preferences
            try:
                prefs.compute_device_type = 'METAL'
                prefs.get_devices()
                usable = [d for d in prefs.devices if d.type == 'METAL']
                if usable:
                    for device in prefs.devices:
                        device.use = device.type == 'METAL'
                    scene.cycles.device = 'GPU'
                    print('MASCOT_DEVICE ' + ', '.join(d.name for d in usable), flush=True)
            except (TypeError, RuntimeError) as error:
                print('MASCOT_DEVICE CPU fallback: ' + str(error), flush=True)
    else:
        scene.eevee.taa_render_samples = args.samples
        if hasattr(scene.eevee, 'use_gtao'):
            scene.eevee.use_gtao = True

    scene.render.resolution_x = scene.render.resolution_y = args.resolution
    scene.render.resolution_percentage = 100
    scene.render.film_transparent = True
    scene.render.image_settings.file_format = 'PNG'
    scene.render.image_settings.color_mode = 'RGBA'
    scene.render.image_settings.color_depth = '8'
    scene.render.image_settings.compression = 30
    scene.render.fps = args.fps
    scene.view_settings.view_transform = 'AgX'
    scene.view_settings.look = 'AgX - Medium High Contrast'
    scene.view_settings.exposure = .25
    scene.view_settings.gamma = 1
    world = bpy.data.worlds.new('Neutral studio')
    world.use_nodes = True
    world.node_tree.nodes['Background'].inputs['Color'].default_value = (*rgb('E6EAF0'), 1)
    world.node_tree.nodes['Background'].inputs['Strength'].default_value = .45
    scene.world = world
    light('Key / large silk', (-3.5, -4.5, 6), 420, 4.2, 'FFF1DF')
    light('Fill / neutral silk', (4, -2, 3.5), 235, 3.8, 'E5EDFF')
    light('Rim / top silk', (1.5, 3.2, 5), 520, 3.0, 'FFF8E9')
    light('Front / eye softbox', (-.8, -4.0, 2.0), 35, 2.0, 'FFFFFF')

    camera_data = bpy.data.cameras.new('Portrait orthographic')
    camera = bpy.data.objects.new('Portrait orthographic', camera_data)
    bpy.context.collection.objects.link(camera)
    camera.location = (3.5, -8.5, 3.25)
    target = Vector((0, 0, 1.47 if args.candidate != 'c' else 1.34))
    camera.rotation_euler = (target - camera.location).to_track_quat('-Z', 'Y').to_euler()
    camera_data.type = 'ORTHO'
    camera_data.ortho_scale = 3.72 if args.candidate != 'c' else 3.22
    camera_data.lens = 70
    scene.camera = camera
    return scene


def main():
    argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    parser = argparse.ArgumentParser()
    parser.add_argument('--candidate', choices=['a', 'b', 'c'], required=True)
    parser.add_argument('--mode', choices=['still', 'animation'], default='still')
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--resolution', type=int, default=1024)
    parser.add_argument('--samples', type=int, default=64)
    parser.add_argument('--fps', type=int, default=24)
    parser.add_argument('--frames', type=int, default=72)
    parser.add_argument('--engine', choices=['CYCLES', 'BLENDER_EEVEE'], default='CYCLES')
    parser.add_argument('--device', choices=['AUTO', 'CPU'], default='AUTO')
    parser.add_argument('--fuzz', type=float, default=1)
    args = parser.parse_args(argv)
    start = time.monotonic()
    scene = setup(args)
    setup_seconds = time.monotonic() - start
    args.output.parent.mkdir(parents=True, exist_ok=True)
    if args.mode == 'still':
        scene.render.filepath = str(args.output)
        bpy.ops.render.render(write_still=True)
    else:
        args.output.mkdir(parents=True, exist_ok=True)
        for frame in range(args.frames):
            # A full turn with matching endpoint velocity, no duplicated end frame.
            phase = frame / args.frames
            ROOT.rotation_euler.z = math.tau * phase
            ROOT.location.z = .018 * math.sin(phase * math.tau * 2)
            scene.frame_set(frame + 1)
            scene.render.filepath = str(args.output / f'{frame:04d}.png')
            bpy.ops.render.render(write_still=True)
            print(f'MASCOT_FRAME {args.candidate} {frame + 1}/{args.frames}', flush=True)
    elapsed = time.monotonic() - start
    report = {'candidate': args.candidate, 'mode': args.mode, 'engine': args.engine,
              'samples': args.samples, 'resolution': args.resolution, 'fps': args.fps,
              'frames': 1 if args.mode == 'still' else args.frames,
              'setup_seconds': round(setup_seconds, 3), 'total_seconds': round(elapsed, 3),
              'blender': bpy.app.version_string, 'seed': SEED, 'fuzz': args.fuzz}
    report_path = args.output.with_suffix('.render.json') if args.mode == 'still' else args.output / 'render.json'
    report_path.write_text(json.dumps(report, indent=2) + '\n')
    print('MASCOT_DONE ' + json.dumps(report), flush=True)


if __name__ == '__main__':
    main()
