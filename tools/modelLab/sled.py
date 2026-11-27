"""The winter sled, built in Blender.

    python tools/modelLab/sled.py [--render out.png]

Needs Blender's Python module (`pip install bpy`) or run it inside Blender
(`blender -b -P tools/modelLab/sled.py`). Writes public/models/sled/sled.glb;
--render also writes a three-view sheet for judging the shape.

Blender's axes: Z up, the nose toward -Y, so the exported model has its
nose toward +Z in the game. One unit is one tile; a serf stands 0.85 tall.
"""

import math
import os
import sys

import bpy  # first: bmesh and mathutils only exist once it is loaded

import bmesh  # noqa: E402
from mathutils import Vector  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
OUT = os.path.join(ROOT, "public", "models", "sled", "sled.glb")

# Half the runner gauge, the runners' length on the snow, the deck's height.
HALF = 0.21
TAIL = 0.46
NOSE = -0.36
DECK = 0.15


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


def sweep(name, mat, path, width, height, bevel=0.008):
    """A bar of `width` x `height` following `path`, a list of (y, z)."""
    bm = bmesh.new()
    rings = []
    for i, (y, z) in enumerate(path):
        a = path[max(i - 1, 0)]
        b = path[min(i + 1, len(path) - 1)]
        ty, tz = b[0] - a[0], b[1] - a[1]
        length = math.hypot(ty, tz)
        # The bar's "up" at this point: the tangent turned a quarter, the
        # same way all along, so the section never flips as the nose curls
        # over past upright.
        ny, nz = tz / length, -ty / length
        ring = []
        for sx, sn in ((-1, -1), (1, -1), (1, 1), (-1, 1)):
            ring.append(
                bm.verts.new(
                    (
                        sx * width / 2,
                        y + ny * sn * height / 2,
                        z + nz * sn * height / 2,
                    )
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


def runner_path():
    """Flat on the snow, then curling up and back over at the nose."""
    path = [(TAIL, 0.03), (TAIL - 0.3, 0.03), (NOSE, 0.03)]
    radius = 0.15
    for step in range(1, 7):
        angle = math.radians(step * 22)
        path.append(
            (NOSE - math.sin(angle) * radius, 0.03 + (1 - math.cos(angle)) * radius)
        )
    return path


def build():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    timber = material("timber", 0x4A3220)
    plank = material("plank", 0x8A6238)
    pale = material("pale", 0xA57C4A)
    cord = material("cord", 0xC9B58A)
    iron = material("iron", 0x4B4F58, 0.6)

    parts = []
    path = runner_path()
    tip_y, tip_z = path[-1]
    for side in (-1, 1):
        x = side * HALF
        runner = sweep("runner", timber, path, 0.055, 0.06)
        runner.location.x = x
        parts.append(runner)
        # An iron shoe under the runner, proud of the timber: the line that
        # reads as "this slides".
        shoe = sweep(
            "shoe", iron, [(y, z - 0.034) for y, z in path[:7]], 0.035, 0.014, 0.003
        )
        shoe.location.x = x
        parts.append(shoe)
        # Three knees stand the deck off the runners, leaning in a little.
        for y in (0.32, 0.0, -0.3):
            parts.append(
                box(
                    "knee",
                    timber,
                    (0.045, 0.05, DECK - 0.04),
                    (x * 0.94, y, 0.03 + (DECK - 0.04) / 2),
                    (0, -side * 0.12, 0),
                )
            )
        # A stake at each corner and a rail between them, to keep a load on.
        for y in (0.4, -0.3):
            parts.append(
                box(
                    "stake",
                    timber,
                    (0.04, 0.04, 0.17),
                    (x * 1.02, y, DECK + 0.075),
                    (0, side * 0.1, 0),
                )
            )
        parts.append(
            box("rail", pale, (0.034, 0.74, 0.034), (x * 1.06, 0.05, DECK + 0.13))
        )
        # The brace from the nose curl back down to the deck.
        parts.append(
            sweep(
                "brace",
                timber,
                [(tip_y + 0.02, tip_z - 0.01), (-0.3, DECK + 0.02)],
                0.03,
                0.03,
            )
        )
        parts[-1].location.x = x

    # Bolsters across, under the deck, on each pair of knees.
    for y in (0.32, 0.0, -0.3):
        parts.append(box("bolster", timber, (HALF * 2 + 0.07, 0.06, 0.04), (0, y, DECK - 0.03)))
    # The deck: four boards, a little uneven, the way a village sled is.
    for i, (width, length, shift) in enumerate(
        ((0.1, 0.84, 0.0), (0.105, 0.88, 0.015), (0.1, 0.86, -0.01), (0.1, 0.84, 0.005))
    ):
        parts.append(
            box(
                "board",
                plank if i % 2 else pale,
                (width, length, 0.028),
                (-0.165 + i * 0.11, 0.04 + shift, DECK + 0.004),
            )
        )
    # A tailboard, so the load has something to lean on when he pulls.
    parts.append(box("tailboard", plank, (HALF * 2 + 0.02, 0.03, 0.15), (0, 0.44, DECK + 0.08), (-0.08, 0, 0)))
    # The drawbar joining the two noses, lashed at each end: where the
    # trace is tied.
    parts.append(box("drawbar", pale, (HALF * 2 + 0.12, 0.04, 0.04), (0, tip_y + 0.01, tip_z), bevel=0.012))
    for side in (-1, 1):
        for dx in (-0.03, 0.03):
            parts.append(
                box(
                    "lashing",
                    cord,
                    (0.016, 0.062, 0.062),
                    (side * HALF + dx, tip_y + 0.01, tip_z),
                    bevel=0.004,
                )
            )

    bpy.ops.object.select_all(action="DESELECT")
    for obj in parts:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = parts[0]
    for obj in parts:
        bpy.context.view_layer.objects.active = obj
        for mod in list(obj.modifiers):
            bpy.ops.object.modifier_apply(modifier=mod.name)
    bpy.context.view_layer.objects.active = parts[0]
    bpy.ops.object.join()
    sled = bpy.context.view_layer.objects.active
    sled.name = "sled"
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    for poly in sled.data.polygons:
        poly.use_smooth = False
    return sled


def export(sled):
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    bpy.ops.object.select_all(action="DESELECT")
    sled.select_set(True)
    bpy.ops.export_scene.gltf(
        filepath=OUT, export_format="GLB", use_selection=True, export_yup=True
    )
    tris = sum(len(p.vertices) - 2 for p in sled.data.polygons)
    print(f"wrote {OUT}: {tris} triangles, {os.path.getsize(OUT)} bytes")


def render(sled, out):
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
    snow = add("snow", bm, material("snow", 0xE3EBF4, 1), 0)
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
        "hero": (Vector((1.6, -2.0, 1.7)), 1.5),
        "side": (Vector((3, 0, 0.14)), 1.5),
        "top": (Vector((0, 0.02, 3)), 1.5),
        "front": (Vector((0, -3, 0.4)), 1.1),
    }
    base, ext = os.path.splitext(out)
    for name, (at, scale) in views.items():
        cam.location = at
        cam.data.ortho_scale = scale
        cam.rotation_euler = (target - at).to_track_quat("-Z", "Y").to_euler()
        scene.render.filepath = f"{base}-{name}{ext}"
        bpy.ops.render.render(write_still=True)
        print("rendered", scene.render.filepath)
    _ = snow, sled


if __name__ == "__main__":
    sled = build()
    export(sled)
    if "--render" in sys.argv:
        render(sled, sys.argv[sys.argv.index("--render") + 1])
