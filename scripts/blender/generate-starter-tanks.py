"""Generate the authored PL-100 and HV-1600 starter tank assets.

The models use an intentionally compact, profile-driven hard-surface treatment so
they remain inside Perilune's checked 64k-triangle catalog budget.  The vessel axis
is +Y, matching the existing part-model authoring pipeline.
"""

from __future__ import annotations

import math
from pathlib import Path

import bpy
from mathutils import Vector


ROOT = Path(__file__).resolve().parents[2]
AUTHORING = ROOT / "assets/parts/authoring"
BLEND_PATH = AUTHORING / "perilune-starter-tanks.blend"

ASSETS = {
    "tank-s1": "perilune-pl100-tank",
    "tank-m8": "perilune-hv1600-tank",
}

PALETTE = {
    "insulation": ((0.64, 0.69, 0.72, 1.0), 0.18, 0.48),
    "blue": ((0.025, 0.22, 0.36, 1.0), 0.42, 0.30),
    "orange": ((0.67, 0.20, 0.055, 1.0), 0.38, 0.34),
    "graphite": ((0.028, 0.040, 0.052, 1.0), 0.72, 0.26),
    "collision": ((0.10, 0.65, 0.85, 0.18), 0.0, 0.75),
}


def create_asset_scene() -> bpy.types.Scene:
    scene = bpy.data.scenes.new("SCN_PeriluneStarterTanks")
    scene.unit_settings.system = "METRIC"
    scene.unit_settings.scale_length = 1.0
    if bpy.context.window is None:
        raise RuntimeError("The starter-tank generator requires an interactive Blender window")
    bpy.context.window.scene = scene
    return scene


def collection(name: str, parent: bpy.types.Collection | None = None) -> bpy.types.Collection:
    target = bpy.data.collections.new(name)
    (parent.children if parent else bpy.context.scene.collection.children).link(target)
    return target


def material(key: str) -> bpy.types.Material:
    name = f"MAT_Tank_{key.title()}"
    existing = bpy.data.materials.get(name)
    if existing:
        return existing
    color, metallic, roughness = PALETTE[key]
    result = bpy.data.materials.new(name)
    result.diffuse_color = color
    result.use_nodes = True
    principled = result.node_tree.nodes.get("Principled BSDF")
    principled.inputs["Base Color"].default_value = color
    principled.inputs["Metallic"].default_value = metallic
    principled.inputs["Roughness"].default_value = roughness
    return result


def move_to(obj: bpy.types.Object, target: bpy.types.Collection) -> bpy.types.Object:
    for owner in list(obj.users_collection):
        owner.objects.unlink(obj)
    target.objects.link(obj)
    return obj


def finish(
    obj: bpy.types.Object,
    name: str,
    target: bpy.types.Collection,
    material_keys: tuple[str, ...],
) -> bpy.types.Object:
    obj.name = name
    obj.data.name = name
    move_to(obj, target)
    for key in material_keys:
        obj.data.materials.append(material(key))
    return obj


def lathe(
    target: bpy.types.Collection,
    name: str,
    profile: list[tuple[float, float, int]],
    segments: int,
    material_keys: tuple[str, ...],
) -> bpy.types.Object:
    """Revolve a (Y, radius, material index) profile around the Y axis."""
    vertices: list[tuple[float, float, float]] = []
    for y, radius, _ in profile:
        for index in range(segments):
            angle = math.tau * index / segments
            vertices.append((math.sin(angle) * radius, y, math.cos(angle) * radius))

    faces: list[tuple[int, ...]] = []
    face_materials: list[int] = []
    for ring in range(len(profile) - 1):
        for index in range(segments):
            next_index = (index + 1) % segments
            a = ring * segments + index
            b = ring * segments + next_index
            c = (ring + 1) * segments + next_index
            d = (ring + 1) * segments + index
            faces.append((a, b, c, d))
            face_materials.append(profile[ring][2])

    bottom_center = len(vertices)
    vertices.append((0.0, profile[0][0], 0.0))
    top_center = len(vertices)
    vertices.append((0.0, profile[-1][0], 0.0))
    top_ring = (len(profile) - 1) * segments
    for index in range(segments):
        next_index = (index + 1) % segments
        faces.append((bottom_center, next_index, index))
        face_materials.append(len(material_keys) - 1)
        faces.append((top_center, top_ring + index, top_ring + next_index))
        face_materials.append(len(material_keys) - 1)

    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(vertices, [], faces)
    mesh.update(calc_edges=True)
    obj = bpy.data.objects.new(name, mesh)
    target.objects.link(obj)
    finish(obj, name, target, material_keys)
    for polygon, material_index in zip(mesh.polygons, face_materials):
        polygon.material_index = material_index
        polygon.use_smooth = True
    return obj


def box(
    target: bpy.types.Collection,
    name: str,
    dimensions: tuple[float, float, float],
    location: tuple[float, float, float],
    material_key: str,
    rotation_y: float = 0.0,
    bevel: float = 0.0,
) -> bpy.types.Object:
    bpy.ops.mesh.primitive_cube_add(location=location, rotation=(0.0, rotation_y, 0.0))
    obj = bpy.context.object
    obj.dimensions = dimensions
    bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)
    finish(obj, name, target, (material_key,))
    if bevel > 0:
        modifier = obj.modifiers.new("Bevel_ManufacturedEdge", "BEVEL")
        modifier.width = bevel
        modifier.segments = 1
    return obj


def cylinder_y(
    target: bpy.types.Collection,
    name: str,
    radius: float,
    height: float,
    location: tuple[float, float, float],
    material_key: str,
    vertices: int = 6,
) -> bpy.types.Object:
    bpy.ops.mesh.primitive_cylinder_add(
        vertices=vertices,
        radius=radius,
        depth=height,
        location=location,
        rotation=(math.pi * 0.5, 0.0, 0.0),
    )
    obj = bpy.context.object
    bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)
    return finish(obj, name, target, (material_key,))


def radial_box(
    target: bpy.types.Collection,
    name: str,
    angle: float,
    radius: float,
    y: float,
    dimensions: tuple[float, float, float],
    material_key: str,
    bevel: float = 0.0,
) -> bpy.types.Object:
    return box(
        target,
        name,
        dimensions,
        (math.sin(angle) * radius, y, math.cos(angle) * radius),
        material_key,
        rotation_y=angle,
        bevel=bevel,
    )


def build_pl100(target: bpy.types.Collection) -> None:
    # Material indices: insulation, blue, orange, graphite.
    profile = [
        (-0.450, 0.600, 2),
        (-0.405, 0.600, 1),
        (-0.365, 0.555, 0),
        (-0.285, 0.535, 0),
        (-0.255, 0.565, 0),
        (0.255, 0.565, 0),
        (0.285, 0.535, 1),
        (0.365, 0.555, 0),
        (0.405, 0.600, 1),
        (0.450, 0.600, 2),
    ]
    lathe(
        target,
        "SM_PL100_PressureShell_LOD0",
        profile,
        10,
        ("insulation", "blue", "graphite"),
    )
    radial_box(target, "SM_PL100_ServicePanel", 0.0, 0.575, 0.02, (0.23, 0.20, 0.040), "graphite", 0.012)
    radial_box(target, "SM_PL100_IdentificationPlate", 0.0, 0.599, 0.02, (0.14, 0.085, 0.010), "blue", 0.004)
    cylinder_y(target, "SM_PL100_FillValve", 0.038, 0.18, (-0.18, 0.06, 0.545), "graphite", 6)


def build_hv1600(target: bpy.types.Collection) -> None:
    profile = [
        (-1.900, 1.250, 2),
        (-1.835, 1.250, 1),
        (-1.770, 1.185, 0),
        (-1.585, 1.135, 0),
        (-1.535, 1.185, 0),
        (-0.820, 1.145, 0),
        (-0.770, 1.185, 0),
        (0.770, 1.185, 0),
        (0.820, 1.145, 0),
        (1.535, 1.185, 0),
        (1.585, 1.135, 0),
        (1.770, 1.185, 0),
        (1.835, 1.250, 1),
        (1.900, 1.250, 2),
    ]
    lathe(
        target,
        "SM_HV1600_PressureShell_LOD0",
        profile,
        12,
        ("insulation", "orange", "graphite"),
    )
    for index, angle in enumerate((0.0, math.pi * 0.5, math.pi, math.pi * 1.5)):
        radial_box(
            target,
            f"SM_HV1600_Longeron_{index + 1:02d}",
            angle,
            1.165,
            0.0,
            (0.075, 3.05, 0.045),
            "orange",
            0.010,
        )
    radial_box(target, "SM_HV1600_ServicePanel", 0.0, 1.180, 0.35, (0.42, 0.46, 0.052), "graphite", 0.018)
    radial_box(target, "SM_HV1600_IdentificationPlate", 0.0, 1.210, 0.35, (0.28, 0.15, 0.012), "orange", 0.005)
    for index, x in enumerate((-0.30, 0.30)):
        cylinder_y(target, f"SM_HV1600_FeedLine_{index + 1:02d}", 0.042, 2.48, (x, -0.12, 1.145), "graphite", 6)


def collision_proxy(target: bpy.types.Collection, name: str, radius: float, height: float) -> None:
    obj = cylinder_y(target, name, radius, height, (0.0, 0.0, 0.0), "collision", 8)
    obj.display_type = "WIRE"
    obj.hide_render = True
    obj.hide_viewport = True


def blockout_proxy(target: bpy.types.Collection, name: str, radius: float, height: float) -> None:
    obj = cylinder_y(target, name, radius, height, (0.0, 0.0, 0.0), "insulation", 10)
    obj.display_type = "BOUNDS"
    obj.hide_render = True
    obj.hide_viewport = True


def select_collection_objects(target: bpy.types.Collection) -> list[bpy.types.Object]:
    bpy.ops.object.select_all(action="DESELECT")
    objects = [obj for obj in target.all_objects if obj.type == "MESH"]
    for obj in objects:
        obj.hide_set(False)
        obj.select_set(True)
    if objects:
        bpy.context.view_layer.objects.active = objects[0]
    return objects


def apply_export_modifiers(objects: list[bpy.types.Object]) -> None:
    for obj in objects:
        if not obj.modifiers:
            continue
        bpy.context.view_layer.objects.active = obj
        obj.select_set(True)
        for modifier in list(obj.modifiers):
            bpy.ops.object.modifier_apply(modifier=modifier.name)


def export_part(part_id: str, target: bpy.types.Collection) -> None:
    objects = select_collection_objects(target)
    apply_export_modifiers(objects)
    bpy.ops.export_scene.gltf(
        filepath=str(AUTHORING / f"{ASSETS[part_id]}.glb"),
        export_format="GLB",
        use_selection=False,
        use_active_scene=True,
        collection=target.name,
        export_apply=True,
        export_materials="EXPORT",
        export_cameras=False,
        export_lights=False,
        export_animations=False,
        export_yup=False,
    )


def triangle_count(target: bpy.types.Collection) -> int:
    depsgraph = bpy.context.evaluated_depsgraph_get()
    triangles = 0
    for obj in target.all_objects:
        if obj.type != "MESH":
            continue
        evaluated = obj.evaluated_get(depsgraph)
        mesh = evaluated.to_mesh()
        mesh.calc_loop_triangles()
        triangles += len(mesh.loop_triangles)
        evaluated.to_mesh_clear()
    return triangles


def look_at(obj: bpy.types.Object, target: tuple[float, float, float]) -> None:
    obj.rotation_euler = (Vector(target) - obj.location).to_track_quat("-Z", "Y").to_euler()


def setup_review(preview: bpy.types.Collection) -> bpy.types.Object:
    scene = bpy.context.scene
    scene.render.engine = "BLENDER_EEVEE"
    scene.render.resolution_x = 640
    scene.render.resolution_y = 640
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.film_transparent = False
    scene.render.image_settings.color_mode = "RGBA"
    scene.world = bpy.data.worlds.new("WORLD_StarterTankReview")
    scene.world.color = (0.008, 0.014, 0.024)

    camera_data = bpy.data.cameras.new("CAM_StarterTankReview")
    camera = bpy.data.objects.new("CAM_StarterTankReview", camera_data)
    preview.objects.link(camera)
    camera_data.lens = 58
    scene.camera = camera

    lights = (
        ("LGT_StarterTankKey", "AREA", (4.5, 5.5, 4.0), 1050.0, 4.0, (0.80, 0.90, 1.0)),
        ("LGT_StarterTankFill", "AREA", (-4.0, 1.0, 3.0), 700.0, 3.0, (0.38, 0.58, 1.0)),
        ("LGT_StarterTankRim", "AREA", (1.0, 4.0, -4.5), 1150.0, 3.0, (1.0, 0.34, 0.12)),
    )
    for name, kind, location, energy, size, color in lights:
        data = bpy.data.lights.new(name, kind)
        data.energy = energy
        data.shape = "DISK"
        data.size = size
        data.color = color
        obj = bpy.data.objects.new(name, data)
        obj.location = location
        look_at(obj, (0.0, 0.0, 0.0))
        preview.objects.link(obj)
    return camera


def render_asset(
    part_id: str,
    visible: bpy.types.Collection,
    hidden: bpy.types.Collection,
    camera: bpy.types.Object,
    camera_location: tuple[float, float, float],
) -> Path:
    visible.hide_render = False
    hidden.hide_render = True
    camera.location = camera_location
    look_at(camera, (0.0, 0.0, 0.0))
    path = AUTHORING / f"{ASSETS[part_id]}-preview.png"
    bpy.context.scene.render.filepath = str(path)
    bpy.ops.render.render(write_still=True)
    hidden.hide_render = False
    return path


def main() -> dict[str, object]:
    AUTHORING.mkdir(parents=True, exist_ok=True)
    original_scene = bpy.context.scene
    baseline = {
        "objects": set(bpy.data.objects),
        "collections": set(bpy.data.collections),
        "meshes": set(bpy.data.meshes),
        "materials": set(bpy.data.materials),
        "cameras": set(bpy.data.cameras),
        "lights": set(bpy.data.lights),
        "worlds": set(bpy.data.worlds),
    }
    asset_scene = create_asset_scene()

    root = collection("COL_PeriluneStarterTanks")
    reference = collection("COL_StarterTanks_Reference", root)
    blockout = collection("COL_StarterTanks_Blockout", root)
    geo = collection("COL_StarterTanks_Geo", root)
    collision = collection("COL_StarterTanks_Collision", root)
    export = collection("COL_StarterTanks_Export", root)
    preview = collection("COL_StarterTanks_Preview", root)
    del reference, geo

    pl100 = collection("COL_Part_tank_s1", export)
    hv1600 = collection("COL_Part_tank_m8", export)
    build_pl100(pl100)
    build_hv1600(hv1600)
    blockout_proxy(blockout, "SM_PL100_Blockout", 0.60, 0.90)
    blockout_proxy(blockout, "SM_HV1600_Blockout", 1.25, 3.80)
    collision_proxy(collision, "SM_PL100_COL", 0.60, 0.90)
    collision_proxy(collision, "SM_HV1600_COL", 1.25, 3.80)

    export_part("tank-s1", pl100)
    export_part("tank-m8", hv1600)
    counts = {
        "tank-s1": triangle_count(pl100),
        "tank-m8": triangle_count(hv1600),
    }

    camera = setup_review(preview)
    previews = {
        "tank-s1": str(render_asset("tank-s1", pl100, hv1600, camera, (2.05, 1.25, 2.35))),
        "tank-m8": str(render_asset("tank-m8", hv1600, pl100, camera, (5.35, 3.15, 5.85))),
    }
    bpy.data.libraries.write(str(BLEND_PATH), {asset_scene}, fake_user=True, compress=True)
    report = {
        "blend": str(BLEND_PATH),
        "authoring_glbs": {part_id: str(AUTHORING / f"{asset}.glb") for part_id, asset in ASSETS.items()},
        "previews": previews,
        "triangles": counts,
        "materials": sorted(material.name for material in set(bpy.data.materials) - baseline["materials"]),
    }

    bpy.context.window.scene = original_scene
    bpy.data.scenes.remove(asset_scene)
    for datablocks, key in (
        (bpy.data.objects, "objects"),
        (bpy.data.collections, "collections"),
        (bpy.data.meshes, "meshes"),
        (bpy.data.materials, "materials"),
        (bpy.data.cameras, "cameras"),
        (bpy.data.lights, "lights"),
        (bpy.data.worlds, "worlds"),
    ):
        for datablock in list(set(datablocks) - baseline[key]):
            datablocks.remove(datablock, do_unlink=True)
    return report


RESULT = main()
