"""Generate Perilune's compact NASA-style science and power GLB kit."""

from __future__ import annotations

import math
from pathlib import Path

import bpy
from mathutils import Vector


ROOT = Path("/Users/nicknetraganti/Desktop/Developer Stuff/Perilune/fable-test")
AUTHORING = ROOT / "assets/parts/authoring"
BLEND_PATH = AUTHORING / "perilune-science-power-kit.blend"
PREVIEW_PATH = AUTHORING / "perilune-science-power-kit-preview.png"

ASSETS = {
    "batt-s": "perilune-cell-pack-s",
    "batt-m": "perilune-cell-bank-m",
    "solar-fold": "perilune-petal-array",
    "solar-flat": "perilune-shingle-panel",
    "sci-thermo": "perilune-thermoscope",
    "sci-baro": "perilune-pressograph",
    "sci-spore": "perilune-spore-vault",
    "sci-survey": "perilune-starfield-camera",
    "sci-fieldkit": "perilune-field-sample-kit",
    "scan-prospector": "perilune-prospector-eye",
}

PALETTE = {
    "white": ((0.78, 0.82, 0.84, 1.0), 0.15, 0.42),
    "hull": ((0.54, 0.58, 0.61, 1.0), 0.45, 0.48),
    "graphite": ((0.035, 0.05, 0.065, 1.0), 0.70, 0.22),
    "gold": ((0.82, 0.48, 0.055, 1.0), 0.86, 0.28),
    "blue": ((0.025, 0.16, 0.31, 1.0), 0.42, 0.20),
    "green": ((0.17, 0.39, 0.27, 1.0), 0.08, 0.42),
    "orange": ((0.68, 0.16, 0.025, 1.0), 0.32, 0.38),
    "window": ((0.012, 0.10, 0.16, 1.0), 0.18, 0.08),
}


def clean_scene() -> None:
    if bpy.context.object and bpy.context.object.mode != "OBJECT":
        bpy.ops.object.mode_set(mode="OBJECT")
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    for datablocks in (bpy.data.collections, bpy.data.meshes, bpy.data.materials, bpy.data.cameras, bpy.data.lights):
        for datablock in list(datablocks):
            if datablock.users == 0:
                datablocks.remove(datablock)


def collection(name: str, parent: bpy.types.Collection | None = None) -> bpy.types.Collection:
    target = bpy.data.collections.new(name)
    (parent.children if parent else bpy.context.scene.collection.children).link(target)
    return target


def material(key: str) -> bpy.types.Material:
    name = f"MAT_Perilune_{key.title()}"
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


def finish(obj: bpy.types.Object, name: str, target: bpy.types.Collection, mat: str) -> bpy.types.Object:
    obj.name = name
    obj.data.name = name
    move_to(obj, target)
    obj.data.materials.append(material(mat))
    return obj


def box(
    target: bpy.types.Collection,
    name: str,
    location: tuple[float, float, float],
    dimensions: tuple[float, float, float],
    mat: str,
) -> bpy.types.Object:
    bpy.ops.mesh.primitive_cube_add(location=location)
    obj = bpy.context.object
    obj.dimensions = dimensions
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    return finish(obj, name, target, mat)


def cylinder(
    target: bpy.types.Collection,
    name: str,
    radius: float,
    height: float,
    y: float,
    mat: str,
    vertices: int = 8,
    x: float = 0.0,
    z: float = 0.0,
) -> bpy.types.Object:
    bpy.ops.mesh.primitive_cylinder_add(vertices=vertices, radius=radius, depth=height, location=(x, y, z))
    obj = bpy.context.object
    obj.rotation_euler.x = math.pi * 0.5
    bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)
    return finish(obj, name, target, mat)


def frustum(
    target: bpy.types.Collection,
    name: str,
    radius_bottom: float,
    radius_top: float,
    height: float,
    y: float,
    mat: str,
    vertices: int = 8,
    x: float = 0.0,
    z: float = 0.0,
) -> bpy.types.Object:
    bpy.ops.mesh.primitive_cone_add(
        vertices=vertices,
        radius1=radius_bottom,
        radius2=radius_top,
        depth=height,
        location=(x, y, z),
    )
    obj = bpy.context.object
    obj.rotation_euler.x = math.pi * 0.5
    bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)
    return finish(obj, name, target, mat)


def cylinder_z(
    target: bpy.types.Collection,
    name: str,
    radius: float,
    depth: float,
    z: float,
    mat: str,
    vertices: int = 8,
    x: float = 0.0,
    y: float = 0.0,
) -> bpy.types.Object:
    bpy.ops.mesh.primitive_cylinder_add(vertices=vertices, radius=radius, depth=depth, location=(x, y, z))
    return finish(bpy.context.object, name, target, mat)


def frustum_z(
    target: bpy.types.Collection,
    name: str,
    radius_back: float,
    radius_front: float,
    depth: float,
    z: float,
    mat: str,
    vertices: int = 8,
    x: float = 0.0,
    y: float = 0.0,
) -> bpy.types.Object:
    bpy.ops.mesh.primitive_cone_add(
        vertices=vertices,
        radius1=radius_back,
        radius2=radius_front,
        depth=depth,
        location=(x, y, z),
    )
    return finish(bpy.context.object, name, target, mat)


def rod_between(
    target: bpy.types.Collection,
    name: str,
    start: tuple[float, float, float],
    end: tuple[float, float, float],
    radius: float,
    mat: str,
    vertices: int = 6,
) -> bpy.types.Object:
    a, b = Vector(start), Vector(end)
    delta = b - a
    bpy.ops.mesh.primitive_cylinder_add(vertices=vertices, radius=radius, depth=delta.length, location=(a + b) * 0.5)
    obj = bpy.context.object
    obj.rotation_mode = "QUATERNION"
    obj.rotation_quaternion = delta.to_track_quat("Z", "Y")
    bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)
    return finish(obj, name, target, mat)


def build_battery_s(target: bpy.types.Collection) -> None:
    box(target, "SM_Power_CellPackS_Back", (0, 0, -0.025), (0.30, 0.30, 0.07), "graphite")
    box(target, "SM_Power_CellPackS_Face", (0, 0, 0.025), (0.27, 0.27, 0.035), "white")
    box(target, "SM_Power_CellPackS_Bus", (0, 0, 0.051), (0.035, 0.25, 0.012), "gold")
    for index, (x, y) in enumerate(((-0.075, -0.07), (0.075, -0.07), (-0.075, 0.07), (0.075, 0.07))):
        box(target, f"SM_Power_CellPackS_Cell_{index + 1:02d}", (x, y, 0.052), (0.11, 0.10, 0.012), "blue")


def build_battery_m(target: bpy.types.Collection) -> None:
    cylinder(target, "SM_Power_CellBankM_Core", 0.60, 0.28, 0, "graphite", 12)
    cylinder(target, "SM_Power_CellBankM_Shell", 0.61, 0.17, 0, "white", 12)
    cylinder(target, "SM_Power_CellBankM_BusTop", 0.615, 0.025, 0.115, "gold", 12)
    cylinder(target, "SM_Power_CellBankM_BusBottom", 0.615, 0.025, -0.115, "gold", 12)


def build_solar_fold(target: bpy.types.Collection) -> None:
    box(target, "SM_Power_PetalArray_Mount", (0, 0, -0.06), (0.22, 0.22, 0.11), "white")
    rod_between(target, "SM_Power_PetalArray_Hinge", (-0.46, 0, 0), (0.46, 0, 0), 0.035, "gold", 8)
    for side, x in (("L", -0.27), ("R", 0.27)):
        box(target, f"SM_Power_PetalArray_Frame_{side}", (x, 0, 0.035), (0.43, 0.76, 0.035), "hull")
        box(target, f"SM_Power_PetalArray_Cells_{side}", (x, 0, 0.06), (0.38, 0.70, 0.018), "blue")
        for row, y in enumerate((-0.23, 0, 0.23)):
            box(target, f"SM_Power_PetalArray_Grid_{side}_{row + 1:02d}", (x, y, 0.073), (0.38, 0.012, 0.008), "gold")


def build_solar_flat(target: bpy.types.Collection) -> None:
    box(target, "SM_Power_Shingle_Frame", (0, 0, 0), (0.50, 0.70, 0.035), "hull")
    box(target, "SM_Power_Shingle_Cells", (0, 0, 0.025), (0.45, 0.64, 0.022), "blue")
    for index, x in enumerate((-0.135, -0.045, 0.045, 0.135)):
        box(target, f"SM_Power_Shingle_Column_{index + 1:02d}", (x, 0, 0.042), (0.009, 0.64, 0.008), "gold")
    for index, y in enumerate((-0.21, 0.21)):
        box(target, f"SM_Power_Shingle_Row_{index + 1:02d}", (0, y, 0.043), (0.45, 0.009, 0.008), "gold")


def build_thermo(target: bpy.types.Collection) -> None:
    cylinder(target, "SM_Science_Thermoscope_Base", 0.055, 0.07, -0.14, "white", 8)
    rod_between(target, "SM_Science_Thermoscope_Stem", (0, -0.11, 0), (0, 0.10, 0), 0.015, "graphite", 6)
    frustum(target, "SM_Science_Thermoscope_Sensor", 0.025, 0.045, 0.11, 0.145, "hull", 8)
    cylinder(target, "SM_Science_Thermoscope_Collar", 0.04, 0.025, 0.08, "orange", 8)


def build_baro(target: bpy.types.Collection) -> None:
    box(target, "SM_Science_Pressograph_Housing", (0, 0, 0), (0.22, 0.18, 0.10), "white")
    box(target, "SM_Science_Pressograph_Face", (0, 0, 0.058), (0.18, 0.14, 0.022), "graphite")
    box(target, "SM_Science_Pressograph_Display", (-0.035, 0.025, 0.073), (0.08, 0.045, 0.008), "window")
    cylinder_z(target, "SM_Science_Pressograph_Dial", 0.025, 0.018, 0.078, "gold", 8, 0.055, -0.035)
    for index, x in enumerate((-0.06, 0, 0.06)):
        box(target, f"SM_Science_Pressograph_Vent_{index + 1:02d}", (x, -0.045, 0.073), (0.035, 0.012, 0.008), "hull")


def build_spore(target: bpy.types.Collection) -> None:
    cylinder(target, "SM_Science_SporeVault_Core", 0.20, 0.28, 0, "white", 12)
    frustum(target, "SM_Science_SporeVault_Top", 0.08, 0.20, 0.11, 0.195, "hull", 12)
    frustum(target, "SM_Science_SporeVault_Base", 0.20, 0.08, 0.11, -0.195, "graphite", 12)
    cylinder(target, "SM_Science_SporeVault_Seal", 0.21, 0.035, 0.125, "gold", 12)
    box(target, "SM_Science_SporeVault_Window", (0, 0.015, 0.205), (0.10, 0.11, 0.018), "green")


def build_survey(target: bpy.types.Collection) -> None:
    box(target, "SM_Science_StarfieldCamera_Housing", (0, 0, 0), (0.25, 0.34, 0.20), "white")
    box(target, "SM_Science_StarfieldCamera_Bus", (0.105, 0, 0.015), (0.055, 0.25, 0.17), "gold")
    cylinder_z(target, "SM_Science_StarfieldCamera_Lens", 0.09, 0.10, 0.13, "graphite", 12)
    cylinder_z(target, "SM_Science_StarfieldCamera_Glass", 0.072, 0.018, 0.19, "window", 12)
    frustum_z(target, "SM_Science_StarfieldCamera_Shade", 0.11, 0.09, 0.08, 0.235, "hull", 12)


def build_fieldkit(target: bpy.types.Collection) -> None:
    box(target, "SM_Science_FieldKit_Case", (0, -0.02, 0), (0.35, 0.21, 0.18), "orange")
    box(target, "SM_Science_FieldKit_Lid", (0, 0.105, 0), (0.35, 0.045, 0.18), "white")
    box(target, "SM_Science_FieldKit_HandleTop", (0, 0.185, 0), (0.14, 0.025, 0.025), "graphite")
    box(target, "SM_Science_FieldKit_HandleL", (-0.06, 0.15, 0), (0.025, 0.07, 0.025), "graphite")
    box(target, "SM_Science_FieldKit_HandleR", (0.06, 0.15, 0), (0.025, 0.07, 0.025), "graphite")
    for side, x in (("L", -0.11), ("R", 0.11)):
        box(target, f"SM_Science_FieldKit_Latch_{side}", (x, 0.10, 0.095), (0.045, 0.055, 0.015), "gold")
    box(target, "SM_Science_FieldKit_Label", (0, -0.015, 0.096), (0.10, 0.055, 0.012), "white")


def build_prospector(target: bpy.types.Collection) -> None:
    box(target, "SM_Science_ProspectorEye_Mount", (0, -0.10, -0.06), (0.28, 0.16, 0.14), "graphite")
    box(target, "SM_Science_ProspectorEye_Housing", (0, 0.02, 0), (0.40, 0.22, 0.22), "white")
    frustum_z(target, "SM_Science_ProspectorEye_Dish", 0.20, 0.06, 0.10, 0.16, "hull", 12)
    cylinder_z(target, "SM_Science_ProspectorEye_Sensor", 0.055, 0.08, 0.25, "window", 8)
    rod_between(target, "SM_Science_ProspectorEye_Mast", (0, 0, 0.20), (0, 0, 0.32), 0.018, "graphite", 6)
    cylinder_z(target, "SM_Science_ProspectorEye_Collar", 0.075, 0.025, 0.29, "gold", 8)
    box(target, "SM_Science_ProspectorEye_Panel", (0.15, 0.01, 0.12), (0.07, 0.13, 0.018), "blue")


BUILDERS = {
    "batt-s": build_battery_s,
    "batt-m": build_battery_m,
    "solar-fold": build_solar_fold,
    "solar-flat": build_solar_flat,
    "sci-thermo": build_thermo,
    "sci-baro": build_baro,
    "sci-spore": build_spore,
    "sci-survey": build_survey,
    "sci-fieldkit": build_fieldkit,
    "scan-prospector": build_prospector,
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
    select_collection_objects(target)
    bpy.ops.export_scene.gltf(
        filepath=str(AUTHORING / f"{ASSETS[part_id]}.glb"),
        export_format="GLB",
        use_selection=True,
        export_apply=True,
        export_materials="EXPORT",
        export_cameras=False,
        export_lights=False,
        export_animations=False,
        export_yup=False,
    )


def audit(part_collections: dict[str, bpy.types.Collection]) -> dict[str, dict[str, int]]:
    report: dict[str, dict[str, int]] = {}
    depsgraph = bpy.context.evaluated_depsgraph_get()
    for part_id, target in part_collections.items():
        triangles = 0
        materials = set()
        meshes = 0
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


def create_preview_sheet(part_collections: dict[str, bpy.types.Collection], preview: bpy.types.Collection) -> None:
    preview_dir = AUTHORING / "science-power-previews"
    preview_dir.mkdir(parents=True, exist_ok=True)
    all_objects = [obj for target in part_collections.values() for obj in target.all_objects]
    original_visibility = [(obj, obj.hide_render) for obj in all_objects]

    camera_data = bpy.data.cameras.new("CAM_SciencePowerReview")
    camera = bpy.data.objects.new("CAM_SciencePowerReview", camera_data)
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

    width = height = 420
    columns = 4
    rows = math.ceil(len(rendered_paths) / columns)
    sheet = bpy.data.images.new("PeriluneSciencePowerPreviewSheet", width=width * columns, height=height * rows, alpha=True)
    sheet_pixels = [0.0] * (width * columns * height * rows * 4)
    for index, path in enumerate(rendered_paths):
        tile = bpy.data.images.load(str(path), check_existing=False)
        pixels = list(tile.pixels[:])
        column_index = index % columns
        row_from_bottom = rows - 1 - index // columns
        for y in range(height):
            source_start = y * width * 4
            destination_start = (((row_from_bottom * height + y) * width * columns + column_index * width) * 4)
            sheet_pixels[destination_start:destination_start + width * 4] = pixels[source_start:source_start + width * 4]
        bpy.data.images.remove(tile)
    sheet.pixels[:] = sheet_pixels
    sheet.filepath_raw = str(PREVIEW_PATH)
    sheet.file_format = "PNG"
    sheet.save()


def main() -> dict[str, object]:
    AUTHORING.mkdir(parents=True, exist_ok=True)
    clean_scene()
    root = collection("COL_PeriluneSciencePowerKit")
    collection("COL_Reference", root)
    collection("COL_Blockout", root)
    collection("COL_Geo", root)
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
    create_preview_sheet(part_collections, preview)
    bpy.ops.wm.save_as_mainfile(filepath=str(BLEND_PATH))
    return {
        "blend": str(BLEND_PATH),
        "preview": str(PREVIEW_PATH),
        "parts": report,
        "total_triangles": sum(item["triangles"] for item in report.values()),
    }


RESULT = main()
