"""Optional, silent 12-frame CPU insert. Run only in a fresh Cloud Linux Blender process.

blender --background --factory-startup --threads 2 --python scripts/cloud-ui-focus-blender.py -- \
  --cloud-cpu --image public/senior-club/home.png --output /tmp/unique-ui-focus-run
Never loads or writes a .blend file. Existing scenes and files are left intact.
"""
import argparse
import json
from pathlib import Path
import sys


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--cloud-cpu", action="store_true", required=True)
    parser.add_argument("--image", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args(sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else [])
    if sys.platform != "linux":
        raise SystemExit("Cloud Linux only. Mac Blender rendering is disabled.")
    if not args.image.is_file():
        raise SystemExit("Screenshot file is missing.")
    args.output.mkdir(parents=True, exist_ok=False)
    import bpy  # imported only after the platform/output guard

    scene = bpy.data.scenes.new("TorisCloudUIFocus")
    bpy.context.window.scene = scene
    scene.render.engine = "CYCLES"
    scene.cycles.device = "CPU"
    scene.cycles.samples = 8
    scene.cycles.seed = 0
    scene.cycles.use_animated_seed = False
    scene.cycles.use_denoising = False
    scene.render.resolution_x = 384
    scene.render.resolution_y = 216
    scene.render.resolution_percentage = 100
    scene.render.fps = 30
    scene.frame_start, scene.frame_end = 1, 12
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGBA"
    scene.render.film_transparent = True
    scene.render.filepath = str(args.output.resolve() / "frame-")
    scene.render.use_file_extension = True
    scene.render.use_overwrite = False
    scene.view_settings.view_transform = "AgX"
    camera_data = bpy.data.cameras.new("CloudUICamera")
    camera = bpy.data.objects.new("CloudUICamera", camera_data)
    scene.collection.objects.link(camera)
    camera.location = (0, 0, 10)
    camera_data.type = "ORTHO"
    camera_data.ortho_scale = 7.4
    scene.camera = camera

    image = bpy.data.images.load(str(args.image.resolve()), check_existing=True)
    if tuple(image.size) != (1080, 1920):
        raise SystemExit("Sample image changed. Recheck the bell focus coordinates.")
    material = bpy.data.materials.new("CloudUIScreenshot")
    material.use_nodes = True
    nodes, links = material.node_tree.nodes, material.node_tree.links
    texture = nodes.new("ShaderNodeTexImage")
    texture.image = image
    emission = nodes.new("ShaderNodeEmission")
    links.new(texture.outputs["Color"], emission.inputs["Color"])
    links.new(emission.outputs["Emission"], nodes.get("Material Output").inputs["Surface"])
    bpy.ops.mesh.primitive_plane_add(size=2)
    screen = bpy.context.object
    screen.name = "CloudUIScreenshot"
    screen.scale = (0.984375, 1.75, 1)
    screen.data.materials.append(material)

    accent = bpy.data.materials.new("CloudUIFocusAccent")
    accent.use_nodes = True
    emitter = accent.node_tree.nodes.new("ShaderNodeEmission")
    emitter.inputs["Color"].default_value = (0.2, 0.85, 0.55, 1)
    accent.node_tree.links.new(emitter.outputs["Emission"], accent.node_tree.nodes.get("Material Output").inputs["Surface"])
    # Matches normalized source focusRegion of createExplainerSample, top-left origin.
    x, y, w, h = 0.73, 0.51, 0.16, 0.09
    center_x = (x + w / 2 - 0.5) * 1.96875
    center_y = (0.5 - y - h / 2) * 3.5
    focus_w, focus_h = w * 1.96875, h * 3.5
    for name, dx, dy, sx, sy in [
        ("top", 0, focus_h / 2, focus_w / 2, 0.01),
        ("bottom", 0, -focus_h / 2, focus_w / 2, 0.01),
        ("left", -focus_w / 2, 0, 0.01, focus_h / 2),
        ("right", focus_w / 2, 0, 0.01, focus_h / 2),
    ]:
        bpy.ops.mesh.primitive_plane_add(size=2, location=(center_x + dx, center_y + dy, 0.02))
        border = bpy.context.object
        border.name = "CloudUIFocus_" + name
        border.scale = (sx, sy, 1)
        border.data.materials.append(accent)
        border.hide_render = True
        border.keyframe_insert("hide_render", frame=1)
        border.hide_render = False
        border.keyframe_insert("hide_render", frame=5)

    audit = {"blender": bpy.app.version_string, "engine": scene.render.engine, "device": scene.cycles.device,
             "samples": scene.cycles.samples, "frames": [1, 12], "resolution": [384, 216], "fps": 30,
             "source": str(args.image), "objects": [o.name for o in scene.objects],
             "status": "prepared; rendering optional silent CPU insert"}
    (args.output / "settings.json").write_text(json.dumps(audit, indent=2))
    bpy.ops.render.render(animation=True, scene=scene.name)


if __name__ == "__main__":
    main()
