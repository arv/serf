"""The summer wheelbarrow, built in Blender.

    python tools/modelLab/wheelbarrow.py [--render out.png]

Needs Blender's Python module (`pip install bpy`) or run it inside Blender
(`blender -b -P tools/modelLab/wheelbarrow.py`). Writes
public/models/wheelbarrow/wheelbarrow.glb; --render also writes a four-view
design sheet (hero, side, top, front) for judging the shape, with two
stand-in loads in the tray that are not in the GLB.

Blender's axes: Z up, the wheel (nose) toward -Y, so the exported model has
its nose toward +Z in the game. One unit is one tile; a serf stands 0.85
tall. The origin is on the ground, x centred, and the model as built is the
parked pose: it rests on its wheel and its two legs.

Fixed measures the renderer is written against:
    WHEEL_R = 0.11              wheel radius
    AXLE_Y, AXLE_Z = -0.30, 0.11  the axle
    GRIP_HALF = 0.14            grips at x = +-GRIP_HALF,
    GRIP_Y, GRIP_Z = 0.40, 0.22   y = GRIP_Y, z = GRIP_Z
    LEG_Y, LEG_HALF = 0.12, 0.12  feet on the ground at y = LEG_Y, x = +-LEG_HALF
    FLOOR_Z = 0.17              the tray's inner floor
    BERTHS = (0, -0.12), (0, 0.04)  (x, y) of the two loads on the floor
"""

import math
import os
import sys

import bpy  # first: bmesh and mathutils only exist once it is loaded

import bmesh  # noqa: E402
from mathutils import Vector  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
OUT = os.path.join(ROOT, "public", "models", "wheelbarrow", "wheelbarrow.glb")

WHEEL_R = 0.11
WHEEL_W = 0.05
AXLE_Y = -0.30
AXLE_Z = WHEEL_R
GRIP_HALF = 0.14
GRIP_Y = 0.40
GRIP_Z = 0.22
LEG_Y = 0.12
LEG_HALF = 0.12
FLOOR_Z = 0.17
BERTHS = ((0.0, -0.12), (0.0, 0.04))

# The tray's inside, on the floor: front and back edges, half its width, and
# the height of its walls above the floor.
TRAY_FRONT = -0.19
TRAY_BACK = 0.13
TRAY_HALF = 0.13
WALL = 0.10
# The handles' section, width by height.
BAR_W = 0.036
BAR_H = 0.04


def srgb(hex_color):
    def lin(c):
        c /= 255
        return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4

    return (
        lin((hex_color >> 16) & 255),
        lin((hex_color >> 8) & 255),
        lin(hex_color & 255),
        1,
    )


def material(name, hex_color, roughness=0.9):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes["Principled BSDF"]
    bsdf.inputs["Base Color"].default_value = srgb(hex_color)
    bsdf.inputs["Roughness"].default_value = roughness
    bsdf.inputs["Metallic"].default_value = 0
    return mat


def add(mesh_name, bm, mat, bevel=0.008):
    mesh = bpy.data.meshes.new(mesh_name)
    bm.to_mesh(mesh)
    bm.free()
    obj = bpy.data.objects.new(mesh_name, mesh)
    bpy.context.collection.objects.link(obj)
    obj.data.materials.append(mat)
    if bevel:
        mod = obj.modifiers.new("bevel", "BEVEL")
        mod.width = bevel
        mod.segments = 1
        mod.limit_method = "ANGLE"
    return obj


def box(name, mat, size, at, rot=(0, 0, 0), bevel=0.008):
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1)
    for v in bm.verts:
        v.co = Vector((v.co.x * size[0], v.co.y * size[1], v.co.z * size[2]))
    obj = add(name, bm, mat, bevel)
    obj.location = at
    obj.rotation_euler = rot
    return obj


def bar(name, mat, path, width, height, bevel=0.008):
    """A bar of `width` x `height` following `path`, a list of (x, y, z),
    its section kept upright (the bars here never stand on end)."""
    bm = bmesh.new()
    rings = []
    up = Vector((0, 0, 1))
    for i, p in enumerate(path):
        a = Vector(path[max(i - 1, 0)])
        b = Vector(path[min(i + 1, len(path) - 1)])
        side = (b - a).cross(up).normalized()
        top = side.cross(b - a).normalized()
        ring = []
        for sw, sh in ((-1, -1), (1, -1), (1, 1), (-1, 1)):
            ring.append(
                bm.verts.new(
                    Vector(p) + side * sw * width / 2 + top * sh * height / 2
                )
            )
        rings.append(ring)
    for a, b in zip(rings, rings[1:]):
        for i in range(4):
            j = (i + 1) % 4
            bm.faces.new((a[i], a[j], b[j], b[i]))
    bm.faces.new(rings[0][::-1])
    bm.faces.new(rings[-1])
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    return add(name, bm, mat, bevel)


def slab(name, mat, outline, x, thickness, bevel=0.006):
    """A board whose side view is `outline`, a list of (y, z), `thickness`
    across in x, centred on `x`."""
    bm = bmesh.new()
    near = [bm.verts.new((x - thickness / 2, y, z)) for y, z in outline]
    far = [bm.verts.new((x + thickness / 2, y, z)) for y, z in outline]
    n = len(outline)
    for i in range(n):
        j = (i + 1) % n
        bm.faces.new((near[i], near[j], far[j], far[i]))
    bm.faces.new(near[::-1])
    bm.faces.new(far)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    return add(name, bm, mat, bevel)


def drum(name, mat, radius, width, at, sides=12, hole=0.0, bevel=0.0, turn=0.0):
    """A round thing turning about the x axis: a disc, or with `hole` a ring.
    A corner sits straight down so the wheel stands on the ground at
    exactly `radius` below its centre."""
    bm = bmesh.new()
    cx, cy, cz = at

    def ring(r, x):
        out = []
        for k in range(sides):
            angle = -math.pi / 2 + turn + k * 2 * math.pi / sides
            out.append(
                bm.verts.new(
                    (cx + x, cy + math.cos(angle) * r, cz + math.sin(angle) * r)
                )
            )
        return out

    def strip(a, b):
        for i in range(sides):
            j = (i + 1) % sides
            bm.faces.new((a[i], a[j], b[j], b[i]))

    left, right = ring(radius, -width / 2), ring(radius, width / 2)
    strip(left, right)
    if hole:
        hole_left, hole_right = ring(hole, -width / 2), ring(hole, width / 2)
        strip(hole_right, hole_left)
        strip(hole_left, left)
        strip(right, hole_right)
    else:
        bm.faces.new(left[::-1])
        bm.faces.new(right)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    return add(name, bm, mat, bevel)


def handle_path(side):
    """Down at the axle beside the wheel, along under the tray, then up and
    out to the grip. Wider apart toward the back, like a pair of shafts."""
    under = FLOOR_Z - 0.022 - BAR_H / 2  # the floor boards sit on them
    points = [
        (0.055, AXLE_Y - 0.08, AXLE_Z - 0.005),
        (0.06, AXLE_Y, AXLE_Z),
        (0.085, TRAY_FRONT, under),
        (0.115, TRAY_BACK + 0.03, under + 0.004),
    ]
    # Straight from the back of the tray to the grip and a little past it.
    y0, z0 = points[-1][1], points[-1][2]
    x0 = points[-1][0]
    for y in (GRIP_Y - 0.04, GRIP_Y + 0.04):
        t = (y - y0) / (GRIP_Y - y0)
        points.append((x0 + (GRIP_HALF - x0) * t, y, z0 + (GRIP_Z - z0) * t))
    return [(side * x, y, z) for x, y, z in points]


def build():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    timber = material("timber", 0x4A3220)
    plank = material("plank", 0x8A6238)
    pale = material("pale", 0xA57C4A)
    iron = material("iron", 0x4B4F58, 0.6)

    parts = []
    floor_base = FLOOR_Z - 0.02
    under = None
    for side in (-1, 1):
        path = handle_path(side)
        under = path[2][2]
        parts.append(bar("handle", timber, path[:-1], BAR_W, BAR_H))
        # The grip: the last stretch of the handle, worn pale by hands.
        parts.append(bar("grip", pale, path[-2:], BAR_W - 0.006, BAR_H - 0.008))
        # A leg down from the handle behind the tray, splayed a touch, with
        # a strut forward to the handle so it reads as braced.
        hx = side * (0.115 + 0.005)
        top_z = under + 0.004
        parts.append(
            bar(
                "leg",
                timber,
                [(side * LEG_HALF, LEG_Y, 0.0), (hx, LEG_Y - 0.01, top_z + 0.01)],
                0.034,
                0.034,
            )
        )
        parts.append(
            bar(
                "strut",
                timber,
                [
                    (side * (LEG_HALF - 0.004), LEG_Y - 0.005, 0.05),
                    (side * 0.1, -0.07, under - 0.01),
                ],
                0.022,
                0.022,
            )
        )
        # Side wall: its front edge leans out over the wheel to meet the
        # sloping front board. A pale rail along its top.
        x = side * (TRAY_HALF + 0.011)
        top = FLOOR_Z + WALL
        lean = TRAY_FRONT - 0.055
        parts.append(
            slab(
                "wall",
                plank,
                [
                    (TRAY_FRONT - 0.012, floor_base),
                    (TRAY_BACK + 0.022, floor_base),
                    (TRAY_BACK + 0.03, top),
                    (lean - 0.012, top),
                ],
                x,
                0.022,
            )
        )
        parts.append(
            box(
                "rim",
                pale,
                (0.03, TRAY_BACK - lean + 0.05, 0.026),
                (x * 1.03, (TRAY_BACK + lean) / 2 + 0.005, top + 0.008),
            )
        )
        # The wheel's bearing: an iron strap on each handle at the axle.
        parts.append(
            box(
                "bearing",
                iron,
                (0.044, 0.05, 0.05),
                (side * 0.06, AXLE_Y, AXLE_Z),
                bevel=0.005,
            )
        )

    # The floor: three boards across, on top of the handles.
    length = TRAY_BACK - TRAY_FRONT + 0.03
    for i, (width, shift) in enumerate(((0.1, 0.0), (0.1, 0.008), (0.1, -0.005))):
        parts.append(
            box(
                "board",
                pale if i % 2 else plank,
                (width, length, 0.022),
                (-0.1 + i * 0.1, (TRAY_FRONT + TRAY_BACK + 0.03) / 2 + shift, FLOOR_Z - 0.011),
            )
        )
    # The front board, sloping forward over the wheel; the back board upright.
    slope = math.atan2(0.055, WALL)
    front_mid = (TRAY_FRONT - 0.055 / 2 - 0.012, FLOOR_Z + WALL / 2)
    parts.append(
        box(
            "front",
            pale,
            (TRAY_HALF * 2 + 0.044, 0.022, math.hypot(WALL, 0.055) + 0.022),
            (0, front_mid[0], front_mid[1]),
            (slope, 0, 0),
        )
    )
    parts.append(
        box(
            "back",
            plank,
            (TRAY_HALF * 2 + 0.044, 0.022, WALL + 0.022),
            (0, TRAY_BACK + 0.011, FLOOR_Z + WALL / 2 - 0.011),
        )
    )
    # Stretchers across between the handles: one before the wheel well,
    # one behind the tray, and a low one between the legs.
    parts.append(box("stretcher", timber, (0.17, 0.03, 0.028), (0, TRAY_FRONT + 0.02, under)))
    parts.append(box("stretcher", timber, (0.25, 0.03, 0.03), (0, TRAY_BACK + 0.05, under + 0.004)))
    parts.append(box("stretcher", timber, (LEG_HALF * 2, 0.024, 0.024), (0, LEG_Y - 0.004, 0.05)))

    # The wheel: a wooden disc in an iron tyre, an iron hub, and the axle.
    axle = (0, AXLE_Y, AXLE_Z)
    parts.append(drum("tyre", iron, WHEEL_R, WHEEL_W, axle, hole=WHEEL_R - 0.018))
    parts.append(drum("disc", pale, WHEEL_R - 0.016, WHEEL_W - 0.014, axle))
    # Two cross battens on each face, the way a plank wheel is held.
    for x in (-1, 1):
        parts.append(
            box(
                "batten",
                timber,
                (0.008, 0.026, (WHEEL_R - 0.02) * 2),
                (x * (WHEEL_W / 2 - 0.004), AXLE_Y, AXLE_Z),
                bevel=0.003,
            )
        )
    parts.append(drum("hub", iron, 0.03, WHEEL_W + 0.03, axle, sides=8, turn=math.pi / 8))
    parts.append(drum("axle", iron, 0.012, 0.16, axle, sides=6))

    bpy.ops.object.select_all(action="DESELECT")
    for obj in parts:
        obj.select_set(True)
    for obj in parts:
        bpy.context.view_layer.objects.active = obj
        for mod in list(obj.modifiers):
            bpy.ops.object.modifier_apply(modifier=mod.name)
    bpy.context.view_layer.objects.active = parts[0]
    bpy.ops.object.join()
    barrow = bpy.context.view_layer.objects.active
    barrow.name = "wheelbarrow"
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    for poly in barrow.data.polygons:
        poly.use_smooth = False
    return barrow


def export(barrow):
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    bpy.ops.object.select_all(action="DESELECT")
    barrow.select_set(True)
    bpy.ops.export_scene.gltf(
        filepath=OUT, export_format="GLB", use_selection=True, export_yup=True
    )
    tris = sum(len(p.vertices) - 2 for p in barrow.data.polygons)
    print(f"wrote {OUT}: {tris} triangles, {os.path.getsize(OUT)} bytes")


def stand_in_loads():
    """A log bundle and a sack on the two berths, for the sheet only: the
    game puts its own goods in the tray."""
    bark = material("bark", 0x9A6A3C)
    sack = material("sack", 0xC9B58A)
    (lx, ly), (sx, sy) = BERTHS
    loads = []
    r = 0.034
    for dy, dz in ((-r, r), (r, r), (0, r * 2.7)):
        loads.append(drum("log", bark, r, 0.18, (lx, ly + dy, FLOOR_Z + dz), sides=6))
    loads.append(box("sack", sack, (0.16, 0.14, 0.11), (sx, sy, FLOOR_Z + 0.055), bevel=0.03))
    return loads


def render(barrow, out):
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.samples = 48
    scene.cycles.device = "CPU"
    scene.render.resolution_x = 900
    scene.render.resolution_y = 640
    scene.view_settings.view_transform = "Standard"
    world = bpy.data.worlds.new("sky")
    world.use_nodes = True
    world.node_tree.nodes["Background"].inputs[0].default_value = (0.62, 0.74, 0.95, 1)
    world.node_tree.nodes["Background"].inputs[1].default_value = 0.9
    scene.world = world

    bm = bmesh.new()
    bmesh.ops.create_grid(bm, x_segments=1, y_segments=1, size=6)
    grass = add("grass", bm, material("grass", 0x7FA552, 1), 0)
    loads = stand_in_loads()
    sun = bpy.data.objects.new("sun", bpy.data.lights.new("sun", "SUN"))
    sun.data.energy = 3.2
    sun.data.angle = 0.05
    sun.rotation_euler = (math.radians(58), 0, math.radians(-40))
    scene.collection.objects.link(sun)

    cam = bpy.data.objects.new("cam", bpy.data.cameras.new("cam"))
    cam.data.type = "ORTHO"
    scene.collection.objects.link(cam)
    scene.camera = cam
    target = Vector((0, 0.02, 0.14))
    views = {
        "hero": (Vector((1.6, -2.0, 1.7)), 1.3),
        "side": (Vector((3, 0.02, 0.14)), 1.1),
        "top": (Vector((0, 0.02, 3)), 1.3),
        "front": (Vector((0, -3, 0.4)), 0.8),
    }
    base, ext = os.path.splitext(out)
    shots = []
    for name, (at, scale) in views.items():
        cam.location = at
        cam.data.ortho_scale = scale
        cam.rotation_euler = (target - at).to_track_quat("-Z", "Y").to_euler()
        scene.render.filepath = f"{base}-{name}{ext}"
        bpy.ops.render.render(write_still=True)
        shots.append((name, scene.render.filepath))
    _ = grass, loads, barrow

    try:
        from PIL import Image, ImageDraw, ImageFont
    except ImportError:
        for _, path in shots:
            print("rendered", path)
        return
    tiles = [Image.open(path).convert("RGB") for _, path in shots]
    w, h = tiles[0].size
    sheet = Image.new("RGB", (w * 2, h * 2), "white")
    draw = ImageDraw.Draw(sheet)
    font = ImageFont.load_default(size=22)
    for i, ((name, path), tile) in enumerate(zip(shots, tiles)):
        x, y = (i % 2) * w, (i // 2) * h
        sheet.paste(tile, (x, y))
        draw.rectangle((x, y, x + w - 1, y + h - 1), outline=(90, 90, 90))
        draw.text((x + 14, y + 10), name, fill=(30, 30, 30), font=font)
        os.remove(path)
    sheet.save(out)
    print("rendered", out)


if __name__ == "__main__":
    barrow = build()
    export(barrow)
    if "--render" in sys.argv:
        render(barrow, sys.argv[sys.argv.index("--render") + 1])
