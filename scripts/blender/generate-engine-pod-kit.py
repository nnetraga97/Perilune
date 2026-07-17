"""Generate Perilune's cohesive engine and command-pod hard-surface kit.

Run through Blender MCP or Blender's background Python execution. The script
creates a non-destructive authoring scene, exports one centered GLB per part,
and renders a kit overview for visual review.
"""

from __future__ import annotations

import math
from pathlib import Path

import bpy
from mathutils import Vector


ROOT = Path(__file__).resolve().parents[2]
AUTHORING = ROOT / "assets" / "parts" / "authoring"
PREVIEW_PATH = AUTHORING / "perilune-engine-pod-kit-preview.png"
BLEND_PATH = AUTHORING / "perilune-engine-pod-kit.blend"


PALETTE = {
    "hull": ((0.68, 0.74, 0.79, 1.0), 0.65, 0.30),
    "white": ((0.84, 0.87, 0.88, 1.0), 0.25, 0.32),
    "dark": ((0.035, 0.055, 0.070, 1.0), 0.72, 0.24),
    "graphite": ((0.11, 0.14, 0.17, 1.0), 0.80, 0.31),
    "blue": ((0.035, 0.32, 0.53, 1.0), 0.45, 0.28),
    "orange": ((0.72, 0.20, 0.035, 1.0), 0.55, 0.33),
    "gold": ((0.92, 0.54, 0.055, 1.0), 0.78, 0.22),
    "copper": ((0.48, 0.14, 0.035, 1.0), 0.88, 0.34),
    "window": ((0.015, 0.12, 0.19, 1.0), 0.18, 0.10),
    "ceramic": ((0.22, 0.23, 0.22, 1.0), 0.05, 0.68),
}


ASSETS = {
    "pod-tandem": "perilune-tandem-cab",
    "core-pilot": "perilune-pilot-chip",
    "eng-pike": "perilune-pike-engine",
    "eng-ember": "perilune-ember-engine",
    "eng-aspen": "perilune-aspen-engine",
    "rcs-quad": "perilune-quadjet-rcs",
}

# Preserve the editable .blend at full detail while exporting a lean runtime mesh.
# Ratios only affect curved meshes; hard-surface boxes and small details stay intact.
EXPORT_DECIMATION = {
    "pod-tandem": 0.65,
    "core-pilot": 0.75,
    "eng-pike": 0.65,
    "eng-ember": 0.65,
    "eng-aspen": 0.65,
    "rcs-quad": 0.75,
}


def clean_scene() -> None:
    if bpy.context.object and bpy.context.object.mode != "OBJECT":
        bpy.ops.object.mode_set(mode="OBJECT")
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    for datablocks in (bpy.data.meshes, bpy.data.curves, bpy.data.cameras, bpy.data.lights, bpy.data.materials):
        for block in list(datablocks):
            if block.users == 0:
                datablocks.remove(block)
    for collection in list(bpy.data.collections):
        bpy.data.collections.remove(collection)


def collection(name: str, parent: bpy.types.Collection | None = None) -> bpy.types.Collection:
    result = bpy.data.collections.new(name)
    (parent or bpy.context.scene.collection).children.link(result)
    return result


def move_to(obj: bpy.types.Object, target: bpy.types.Collection) -> bpy.types.Object:
    for current in list(obj.users_collection):
        current.objects.unlink(obj)
    target.objects.link(obj)
    return obj


def material(key: str) -> bpy.types.Material:
    name = f"MAT_{key.title()}"
    existing = bpy.data.materials.get(name)
    if existing:
        return existing
    color, metallic, roughness = PALETTE[key]
    result = bpy.data.materials.new(name=name)
    result.diffuse_color = color
    result.use_nodes = True
    bsdf = result.node_tree.nodes.get("Principled BSDF")
    bsdf.inputs["Base Color"].default_value = color
    bsdf.inputs["Metallic"].default_value = metallic
    bsdf.inputs["Roughness"].default_value = roughness
    if key == "window":
        bsdf.inputs["Coat Weight"].default_value = 0.55
        bsdf.inputs["Coat Roughness"].default_value = 0.08
    return result


def finish(
    obj: bpy.types.Object,
    target: bpy.types.Collection,
    mat: str,
    bevel: float = 0.0,
    smooth: bool = True,
) -> bpy.types.Object:
    move_to(obj, target)
    if obj.data and hasattr(obj.data, "materials"):
        obj.data.materials.append(material(mat))
    if obj.type == "MESH":
        if smooth:
            for polygon in obj.data.polygons:
                polygon.use_smooth = True
        if bevel > 0:
            modifier = obj.modifiers.new(name="Bevel_Edges", type="BEVEL")
            modifier.width = bevel
            modifier.segments = 1
            modifier.limit_method = "ANGLE"
    return obj


def cylinder(
    target: bpy.types.Collection,
    name: str,
    radius: float,
    height: float,
    y: float,
    mat: str = "hull",
    vertices: int = 20,
    bevel: float = 0.008,
) -> bpy.types.Object:
    bpy.ops.mesh.primitive_cylinder_add(
        vertices=vertices,
        radius=radius,
        depth=height,
        location=(0, y, 0),
        rotation=(math.pi / 2, 0, 0),
    )
    obj = bpy.context.object
    obj.name = name
    return finish(obj, target, mat, bevel)


def frustum(
    target: bpy.types.Collection,
    name: str,
    radius_top: float,
    radius_bottom: float,
    height: float,
    y: float,
    mat: str = "hull",
    vertices: int = 20,
    bevel: float = 0.008,
) -> bpy.types.Object:
    bpy.ops.mesh.primitive_cone_add(
        vertices=vertices,
        radius1=radius_top,
        radius2=radius_bottom,
        depth=height,
        location=(0, y, 0),
        rotation=(math.pi / 2, 0, 0),
    )
    obj = bpy.context.object
    obj.name = name
    return finish(obj, target, mat, bevel)


def torus(
    target: bpy.types.Collection,
    name: str,
    major: float,
    minor: float,
    y: float,
    mat: str = "dark",
    major_segments: int = 20,
    minor_segments: int = 4,
) -> bpy.types.Object:
    bpy.ops.mesh.primitive_torus_add(
        major_radius=major,
        minor_radius=minor,
        major_segments=min(major_segments, 20),
        minor_segments=min(minor_segments, 4),
        location=(0, y, 0),
        rotation=(math.pi / 2, 0, 0),
    )
    obj = bpy.context.object
    obj.name = name
    return finish(obj, target, mat, 0.0)


def box(
    target: bpy.types.Collection,
    name: str,
    size: tuple[float, float, float],
    location: tuple[float, float, float],
    mat: str = "hull",
    rotation: tuple[float, float, float] = (0, 0, 0),
    bevel: float = 0.008,
) -> bpy.types.Object:
    bpy.ops.mesh.primitive_cube_add(size=1, location=location, rotation=rotation)
    obj = bpy.context.object
    obj.name = name
    obj.dimensions = size
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    return finish(obj, target, mat, bevel, smooth=False)


def uv_sphere(
    target: bpy.types.Collection,
    name: str,
    scale: tuple[float, float, float],
    location: tuple[float, float, float],
    mat: str,
    segments: int = 24,
    rings: int = 12,
) -> bpy.types.Object:
    bpy.ops.mesh.primitive_uv_sphere_add(
        segments=segments,
        ring_count=rings,
        location=location,
    )
    obj = bpy.context.object
    obj.name = name
    obj.scale = scale
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    return finish(obj, target, mat)


def strut(
    target: bpy.types.Collection,
    name: str,
    start: tuple[float, float, float],
    end: tuple[float, float, float],
    radius: float,
    mat: str,
    vertices: int = 8,
) -> bpy.types.Object:
    a, b = Vector(start), Vector(end)
    delta = b - a
    midpoint = (a + b) * 0.5
    bpy.ops.mesh.primitive_cylinder_add(vertices=vertices, radius=radius, depth=delta.length, location=midpoint)
    obj = bpy.context.object
    obj.name = name
    obj.rotation_mode = "QUATERNION"
    obj.rotation_quaternion = delta.to_track_quat("Z", "Y")
    return finish(obj, target, mat, min(radius * 0.22, 0.006))


def cone_between(
    target: bpy.types.Collection,
    name: str,
    start: tuple[float, float, float],
    end: tuple[float, float, float],
    radius_start: float,
    radius_end: float,
    mat: str,
    vertices: int = 12,
) -> bpy.types.Object:
    a, b = Vector(start), Vector(end)
    delta = b - a
    bpy.ops.mesh.primitive_cone_add(
        vertices=vertices,
        radius1=radius_start,
        radius2=radius_end,
        depth=delta.length,
        location=(a + b) * 0.5,
    )
    obj = bpy.context.object
    obj.name = name
    obj.rotation_mode = "QUATERNION"
    obj.rotation_quaternion = delta.to_track_quat("Z", "Y")
    return finish(obj, target, mat, 0.003)


def radial_box(
    target: bpy.types.Collection,
    name: str,
    angle: float,
    radius: float,
    y: float,
    size: tuple[float, float, float],
    mat: str,
    bevel: float = 0.008,
) -> bpy.types.Object:
    return box(
        target,
        name,
        size,
        (math.sin(angle) * radius, y, math.cos(angle) * radius),
        mat,
        rotation=(0, angle, 0),
        bevel=bevel,
    )


def add_radial_bolts(target: bpy.types.Collection, prefix: str, radius: float, y: float, count: int = 8) -> None:
    for index in range(count):
        angle = math.tau * index / count
        radial_box(target, f"{prefix}_Bolt_{index + 1:02d}", angle, radius, y, (0.032, 0.032, 0.018), "gold", 0.003)


def build_tandem(target: bpy.types.Collection) -> None:
    cylinder(target, "SM_Pod_Tandem_Cabin", 0.92, 0.68, 0.0, "white", 32, 0.025)
    frustum(target, "SM_Pod_Tandem_TopShoulder", 0.70, 0.92, 0.18, 0.43, "hull", 32, 0.016)
    frustum(target, "SM_Pod_Tandem_BaseShoulder", 0.92, 0.76, 0.16, -0.42, "hull", 32, 0.016)
    cylinder(target, "SM_Pod_Tandem_TopHatch", 0.36, 0.07, 0.515, "dark", 24, 0.008)
    cylinder(target, "SM_Pod_Tandem_Heatshield", 0.77, 0.07, -0.515, "ceramic", 32, 0.008)
    torus(target, "SM_Pod_Tandem_WindowBand", 0.905, 0.025, 0.17, "dark", 32, 6)
    torus(target, "SM_Pod_Tandem_BaseAccent", 0.78, 0.022, -0.48, "orange", 32, 6)
    for index, angle in enumerate((0, math.pi * 0.5, math.pi, math.pi * 1.5)):
        radial_box(target, f"SM_Pod_Tandem_Window_{index + 1:02d}", angle, 0.925, 0.17, (0.34, 0.18, 0.035), "window", 0.022)
        radial_box(target, f"SM_Pod_Tandem_Service_{index + 1:02d}", angle + math.pi / 4, 0.935, -0.18, (0.18, 0.22, 0.035), "blue", 0.012)
    add_radial_bolts(target, "SM_Pod_Tandem", 0.75, -0.535, 12)


def build_pilot(target: bpy.types.Collection) -> None:
    cylinder(target, "SM_Core_Pilot_Main", 0.43, 0.12, 0.0, "graphite", 24, 0.015)
    cylinder(target, "SM_Core_Pilot_Top", 0.34, 0.06, 0.075, "hull", 24, 0.008)
    cylinder(target, "SM_Core_Pilot_Base", 0.40, 0.035, -0.09, "dark", 24, 0.005)
    torus(target, "SM_Core_Pilot_GoldBus", 0.35, 0.018, 0.10, "gold", 24, 6)
    for index, angle in enumerate((0, math.pi * 0.5, math.pi, math.pi * 1.5)):
        radial_box(target, f"SM_Core_Pilot_Sensor_{index + 1:02d}", angle, 0.435, 0.015, (0.11, 0.055, 0.018), "window", 0.006)
    add_radial_bolts(target, "SM_Core_Pilot", 0.39, -0.105, 8)


def engine_mount(target: bpy.types.Collection, prefix: str, radius: float, top_y: float, height: float = 0.12) -> None:
    cylinder(target, f"{prefix}_Mount", radius, height, top_y, "dark", 28, 0.010)
    torus(target, f"{prefix}_MountAccent", radius * 0.84, radius * 0.025, top_y - height * 0.48, "gold", 28, 6)
    add_radial_bolts(target, prefix, radius * 0.88, top_y + height * 0.48, 8)


def engine_bell(
    target: bpy.types.Collection,
    prefix: str,
    x: float,
    z: float,
    top_y: float,
    exit_y: float,
    throat: float,
    exit_radius: float,
    mat: str = "graphite",
) -> None:
    height = top_y - exit_y
    obj = frustum(target, f"{prefix}_Bell", throat, exit_radius, height, (top_y + exit_y) * 0.5, mat, 28, 0.008)
    obj.location.x = x
    obj.location.z = z
    ring = torus(target, f"{prefix}_ExitRing", exit_radius * 0.90, exit_radius * 0.055, exit_y + 0.012, "hull", 28, 6)
    ring.location.x = x
    ring.location.z = z
    throat_ring = torus(target, f"{prefix}_ThroatRing", throat * 0.92, throat * 0.065, top_y - 0.02, "copper", 20, 6)
    throat_ring.location.x = x
    throat_ring.location.z = z


def build_pike(target: bpy.types.Collection) -> None:
    engine_mount(target, "SM_Engine_Pike", 0.58, 0.49, 0.12)
    cylinder(target, "SM_Engine_Pike_Pump", 0.36, 0.22, 0.32, "hull", 24, 0.018)
    engine_bell(target, "SM_Engine_Pike", 0, 0, 0.22, -0.53, 0.22, 0.47)
    for index, angle in enumerate((0, math.pi * 0.5, math.pi, math.pi * 1.5)):
        x, z = math.sin(angle) * 0.37, math.cos(angle) * 0.37
        strut(target, f"SM_Engine_Pike_Actuator_{index + 1:02d}", (x, 0.43, z), (x * 0.58, 0.10, z * 0.58), 0.028, "orange")
    strut(target, "SM_Engine_Pike_FeedA", (-0.28, 0.34, 0.05), (-0.18, -0.05, 0.10), 0.035, "blue")
    strut(target, "SM_Engine_Pike_FeedB", (0.28, 0.34, -0.05), (0.18, -0.05, -0.10), 0.035, "blue")


def build_mule(target: bpy.types.Collection) -> None:
    engine_mount(target, "SM_Engine_Mule", 1.20, 0.70, 0.16)
    cylinder(target, "SM_Engine_Mule_Manifold", 0.68, 0.28, 0.49, "hull", 28, 0.025)
    positions = ((-0.55, 0.32), (0.55, 0.32), (0, -0.55))
    for index, (x, z) in enumerate(positions):
        engine_bell(target, f"SM_Engine_Mule_{index + 1:02d}", x, z, 0.24, -0.78, 0.20, 0.34)
        strut(target, f"SM_Engine_Mule_StrutA_{index + 1:02d}", (x * 1.55, 0.63, z * 1.55), (x, 0.14, z), 0.038, "orange")
        strut(target, f"SM_Engine_Mule_StrutB_{index + 1:02d}", (x * 1.15, 0.50, z * 1.15), (x * 0.85, -0.15, z * 0.85), 0.032, "blue")
    torus(target, "SM_Engine_Mule_ManifoldBand", 0.62, 0.045, 0.38, "orange", 28, 8)


def build_ember(target: bpy.types.Collection) -> None:
    engine_mount(target, "SM_Engine_Ember", 0.58, 0.39, 0.10)
    cylinder(target, "SM_Engine_Ember_Chamber", 0.27, 0.20, 0.25, "hull", 24, 0.014)
    engine_bell(target, "SM_Engine_Ember", 0, 0, 0.18, -0.44, 0.19, 0.59)
    for index in range(4):
        angle = math.tau * index / 4
        strut(target, f"SM_Engine_Ember_Coolant_{index + 1:02d}", (math.sin(angle) * 0.31, 0.31, math.cos(angle) * 0.31), (math.sin(angle) * 0.46, -0.28, math.cos(angle) * 0.46), 0.022, "blue")
    for y in (-0.02, -0.13, -0.24):
        torus(target, f"SM_Engine_Ember_BellBand_{int(abs(y)*100):02d}", 0.38 + abs(y) * 0.45, 0.012, y, "gold", 24, 5)


def build_aspen(target: bpy.types.Collection) -> None:
    engine_mount(target, "SM_Engine_Aspen", 1.18, 0.67, 0.14)
    frustum(target, "SM_Engine_Aspen_Manifold", 0.95, 0.54, 0.28, 0.46, "hull", 32, 0.024)
    cylinder(target, "SM_Engine_Aspen_Chamber", 0.44, 0.24, 0.24, "graphite", 28, 0.018)
    engine_bell(target, "SM_Engine_Aspen", 0, 0, 0.17, -0.73, 0.30, 0.82)
    for index in range(6):
        angle = math.tau * index / 6
        x, z = math.sin(angle) * 0.70, math.cos(angle) * 0.70
        strut(target, f"SM_Engine_Aspen_Truss_{index + 1:02d}", (x * 1.30, 0.62, z * 1.30), (x * 0.55, 0.08, z * 0.55), 0.032, "blue")
    for y, major in ((-0.05, 0.48), (-0.22, 0.57), (-0.39, 0.66), (-0.56, 0.75)):
        torus(target, f"SM_Engine_Aspen_CoolingBand_{int(abs(y)*100):02d}", major, 0.014, y, "gold", 28, 5)


def build_srb(target: bpy.types.Collection, prefix: str, height: float, heavy: bool) -> None:
    half = height * 0.5
    body_radius = 0.54 if heavy else 0.52
    cylinder(target, f"{prefix}_Casing", body_radius, height - 0.30, 0.04, "white", 28, 0.018)
    frustum(target, f"{prefix}_TopCap", body_radius * 0.86, body_radius, 0.18, half - 0.09, "hull", 28, 0.012)
    frustum(target, f"{prefix}_Nozzle", body_radius * 0.45, body_radius * 0.70, 0.22, -half + 0.11, "graphite", 24, 0.010)
    torus(target, f"{prefix}_TopRing", body_radius * 0.91, 0.045, half - 0.18, "orange", 28, 7)
    torus(target, f"{prefix}_ExitRing", body_radius * 0.64, 0.035, -half + 0.015, "hull", 24, 6)
    segments = 7 if heavy else 4
    usable = height - 0.70
    for index in range(segments):
        y = -usable * 0.5 + usable * index / max(segments - 1, 1)
        torus(target, f"{prefix}_Segment_{index + 1:02d}", body_radius * 0.96, 0.026, y, "orange", 28, 6)
    for index, angle in enumerate((0, math.pi)):
        for sign in (-1, 1):
            y = sign * (half * 0.52)
            radial_box(target, f"{prefix}_Clamp_{index + 1:02d}_{'T' if sign > 0 else 'B'}", angle, body_radius + 0.035, y, (0.12, 0.22, 0.045), "dark", 0.010)


def build_rcs(target: bpy.types.Collection) -> None:
    box(target, "SM_RCS_Quadjet_Core", (0.13, 0.13, 0.13), (0, 0, 0), "hull", bevel=0.018)
    box(target, "SM_RCS_Quadjet_Backplate", (0.18, 0.15, 0.035), (0, 0, -0.075), "dark", bevel=0.008)
    directions = ((1, 0, 0), (-1, 0, 0), (0, 1, 0), (0, -1, 0))
    for index, direction in enumerate(directions):
        dx, dy, dz = direction
        start = (dx * 0.055, dy * 0.055, 0.035)
        end = (dx * 0.14, dy * 0.14, 0.065)
        cone_between(target, f"SM_RCS_Quadjet_Nozzle_{index + 1:02d}", start, end, 0.027, 0.045, "graphite", 14)
        cone_between(target, f"SM_RCS_Quadjet_Throat_{index + 1:02d}", (0, 0, 0.02), start, 0.018, 0.024, "copper", 10)
    add_radial_bolts(target, "SM_RCS_Quadjet", 0.075, -0.07, 4)


BUILDERS = {
    "pod-tandem": build_tandem,
    "core-pilot": build_pilot,
    "eng-pike": build_pike,
    "eng-ember": build_ember,
    "eng-aspen": build_aspen,
    "rcs-quad": build_rcs,
}


def select_collection_objects(target: bpy.types.Collection) -> list[bpy.types.Object]:
    bpy.ops.object.select_all(action="DESELECT")
    objects = list(target.all_objects)
    for obj in objects:
        obj.select_set(True)
    if objects:
        bpy.context.view_layer.objects.active = objects[0]
    return objects


def export_part(part_id: str, target: bpy.types.Collection) -> None:
    output = AUTHORING / f"{ASSETS[part_id]}.glb"
    select_collection_objects(target)
    temporary_modifiers: list[tuple[bpy.types.Object, bpy.types.Modifier]] = []
    ratio = EXPORT_DECIMATION[part_id]
    for obj in target.all_objects:
        if obj.type != "MESH" or len(obj.data.polygons) < 24:
            continue
        modifier = obj.modifiers.new("MOD_RuntimeDecimate", "DECIMATE")
        modifier.decimate_type = "COLLAPSE"
        modifier.ratio = ratio
        modifier.use_collapse_triangulate = True
        temporary_modifiers.append((obj, modifier))
    try:
        bpy.ops.export_scene.gltf(
            filepath=str(output),
            export_format="GLB",
            use_selection=True,
            export_apply=True,
            export_materials="EXPORT",
            export_cameras=False,
            export_lights=False,
            export_animations=False,
            # Geometry is authored directly in Perilune's +Y stack convention.
            # Blender's normal Z-up conversion would rotate these parts sideways.
            export_yup=False,
        )
    finally:
        for obj, modifier in temporary_modifiers:
            obj.modifiers.remove(modifier)


def create_preview(part_collections: dict[str, bpy.types.Collection], preview: bpy.types.Collection) -> None:
    layout = {
        "pod-tandem": (-3.0, 2.4, 0.0),
        "core-pilot": (0.0, 2.4, 0.0),
        "rcs-quad": (3.0, 2.4, 0.0),
        "eng-pike": (-3.0, -0.9, 0.0),
        "eng-ember": (0.0, -0.9, 0.0),
        "eng-aspen": (3.0, -0.9, 0.0),
    }
    original_visibility: list[tuple[bpy.types.Object, bool]] = []
    preview_objects: list[bpy.types.Object] = []
    for part_id, target in part_collections.items():
        offset = Vector(layout[part_id])
        for obj in target.all_objects:
            original_visibility.append((obj, obj.hide_render))
            obj.hide_render = True
            duplicate = obj.copy()
            duplicate.data = obj.data
            duplicate.location = obj.location + offset
            duplicate.hide_render = False
            preview.objects.link(duplicate)
            preview_objects.append(duplicate)

    camera_data = bpy.data.cameras.new("CAM_KitOverview")
    camera = bpy.data.objects.new("CAM_KitOverview", camera_data)
    preview.objects.link(camera)
    camera.location = (0.0, 0.55, 20.0)
    target_point = Vector((0.0, 0.55, 0.0))
    camera.rotation_euler = (target_point - camera.location).to_track_quat("-Z", "Y").to_euler()
    camera_data.type = "ORTHO"
    camera_data.ortho_scale = 11.2
    bpy.context.scene.camera = camera

    for name, location, energy, size in (
        ("LGT_Key", (5.5, 8.0, 8.5), 1250, 5.0),
        ("LGT_Fill", (-7.0, 4.0, 5.0), 850, 4.0),
        ("LGT_Rim", (2.0, -8.0, 7.0), 1100, 3.0),
    ):
        data = bpy.data.lights.new(name, type="AREA")
        data.energy = energy
        data.shape = "DISK"
        data.size = size
        light = bpy.data.objects.new(name, data)
        light.location = location
        light.rotation_euler = (target_point - light.location).to_track_quat("-Z", "Y").to_euler()
        preview.objects.link(light)

    world = bpy.context.scene.world or bpy.data.worlds.new("World")
    bpy.context.scene.world = world
    world.use_nodes = True
    world.node_tree.nodes["Background"].inputs["Color"].default_value = (0.004, 0.007, 0.012, 1)
    world.node_tree.nodes["Background"].inputs["Strength"].default_value = 0.20

    scene = bpy.context.scene
    scene.render.engine = "BLENDER_EEVEE"
    scene.render.resolution_x = 1400
    scene.render.resolution_y = 900
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.filepath = str(PREVIEW_PATH)
    scene.render.film_transparent = False
    scene.view_settings.look = "AgX - Medium High Contrast"
    scene.render.image_settings.color_mode = "RGBA"
    try:
        bpy.ops.render.render(write_still=True)
    finally:
        for duplicate in preview_objects:
            bpy.data.objects.remove(duplicate, do_unlink=True)
        for obj, hidden in original_visibility:
            obj.hide_render = hidden


def create_isolated_preview_sheet(
    part_collections: dict[str, bpy.types.Collection],
    preview: bpy.types.Collection,
) -> None:
    preview_dir = AUTHORING / "engine-pod-previews"
    preview_dir.mkdir(parents=True, exist_ok=True)
    all_objects = [obj for target in part_collections.values() for obj in target.all_objects]
    original_visibility = [(obj, obj.hide_render) for obj in all_objects]

    camera_data = bpy.data.cameras.new("CAM_IsolatedPartReview")
    camera = bpy.data.objects.new("CAM_IsolatedPartReview", camera_data)
    preview.objects.link(camera)
    camera_data.type = "ORTHO"
    bpy.context.scene.camera = camera

    for name, location, energy, size in (
        ("LGT_ReviewKey", (4.5, 6.0, 7.0), 900, 4.0),
        ("LGT_ReviewFill", (-4.0, 2.0, 5.0), 650, 3.0),
        ("LGT_ReviewRim", (1.0, -5.0, 3.0), 750, 2.5),
    ):
        data = bpy.data.lights.new(name, type="AREA")
        data.energy = energy
        data.shape = "DISK"
        data.size = size
        light = bpy.data.objects.new(name, data)
        light.location = location
        light.rotation_euler = (Vector((0, 0, 0)) - light.location).to_track_quat("-Z", "Y").to_euler()
        preview.objects.link(light)

    scene = bpy.context.scene
    scene.render.engine = "BLENDER_EEVEE"
    scene.render.resolution_x = 420
    scene.render.resolution_y = 420
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.film_transparent = False
    scene.view_settings.look = "AgX - Medium High Contrast"
    world = scene.world or bpy.data.worlds.new("World")
    scene.world = world
    world.use_nodes = True
    world.node_tree.nodes["Background"].inputs["Color"].default_value = (0.004, 0.007, 0.012, 1)
    world.node_tree.nodes["Background"].inputs["Strength"].default_value = 0.18

    rendered_paths: list[Path] = []
    try:
        for obj in all_objects:
            obj.hide_render = True
        for part_id, target in part_collections.items():
            objects = list(target.all_objects)
            for obj in objects:
                obj.hide_render = False
            corners = [obj.matrix_world @ Vector(corner) for obj in objects for corner in obj.bound_box]
            minimum = Vector((min(v.x for v in corners), min(v.y for v in corners), min(v.z for v in corners)))
            maximum = Vector((max(v.x for v in corners), max(v.y for v in corners), max(v.z for v in corners)))
            center = (minimum + maximum) * 0.5
            size = maximum - minimum
            span = max(size.x, size.y, size.z, 0.2)
            camera.location = center + Vector((span * 1.5, span * 0.85, span * 3.5))
            camera.rotation_euler = (center - camera.location).to_track_quat("-Z", "Y").to_euler()
            camera_data.ortho_scale = max(size.y * 1.40, max(size.x, size.z) * 1.75, 0.45)
            output = preview_dir / f"{ASSETS[part_id]}.png"
            scene.render.filepath = str(output)
            bpy.ops.render.render(write_still=True)
            rendered_paths.append(output)
            for obj in objects:
                obj.hide_render = True
    finally:
        for obj, hidden in original_visibility:
            obj.hide_render = hidden

    tile_width = 420
    tile_height = 420
    columns = 4
    rows = math.ceil(len(rendered_paths) / columns)
    sheet = bpy.data.images.new(
        "PeriluneEnginePodPreviewSheet",
        width=tile_width * columns,
        height=tile_height * rows,
        alpha=True,
    )
    sheet_pixels = [0.0] * (tile_width * columns * tile_height * rows * 4)
    for index, path in enumerate(rendered_paths):
        tile = bpy.data.images.load(str(path), check_existing=False)
        pixels = list(tile.pixels[:])
        column = index % columns
        row_from_top = index // columns
        row_from_bottom = rows - 1 - row_from_top
        for y in range(tile_height):
            source_start = y * tile_width * 4
            destination_start = (
                ((row_from_bottom * tile_height + y) * tile_width * columns + column * tile_width) * 4
            )
            sheet_pixels[destination_start:destination_start + tile_width * 4] = (
                pixels[source_start:source_start + tile_width * 4]
            )
        bpy.data.images.remove(tile)
    sheet.pixels[:] = sheet_pixels
    sheet.filepath_raw = str(PREVIEW_PATH)
    sheet.file_format = "PNG"
    sheet.save()


def audit(part_collections: dict[str, bpy.types.Collection]) -> dict[str, dict[str, int]]:
    report: dict[str, dict[str, int]] = {}
    depsgraph = bpy.context.evaluated_depsgraph_get()
    for part_id, target in part_collections.items():
        triangles = 0
        meshes = 0
        materials = set()
        for obj in target.all_objects:
            if obj.type != "MESH":
                continue
            meshes += 1
            evaluated = obj.evaluated_get(depsgraph)
            mesh = evaluated.to_mesh()
            mesh.calc_loop_triangles()
            triangles += len(mesh.loop_triangles)
            evaluated.to_mesh_clear()
            materials.update(slot.material.name for slot in obj.material_slots if slot.material)
        report[part_id] = {"triangles": triangles, "mesh_objects": meshes, "materials": len(materials)}
    return report


def main() -> dict[str, object]:
    AUTHORING.mkdir(parents=True, exist_ok=True)
    clean_scene()
    root = collection("COL_PeriluneEnginePodKit")
    geo = collection("COL_Geo", root)
    collection("COL_Reference", root)
    collection("COL_Blockout", root)
    collection("COL_Collision", root)
    preview = collection("COL_Preview", root)
    export_root = collection("COL_Export", root)

    part_collections: dict[str, bpy.types.Collection] = {}
    for part_id, builder in BUILDERS.items():
        target = collection(f"COL_Part_{part_id.replace('-', '_')}", export_root)
        part_collections[part_id] = target
        builder(target)

    report = audit(part_collections)
    for part_id, target in part_collections.items():
        export_part(part_id, target)

    create_isolated_preview_sheet(part_collections, preview)
    bpy.ops.wm.save_as_mainfile(filepath=str(BLEND_PATH))
    return {
        "blend": str(BLEND_PATH),
        "preview": str(PREVIEW_PATH),
        "parts": report,
        "total_triangles": sum(item["triangles"] for item in report.values()),
    }


RESULT = main()
