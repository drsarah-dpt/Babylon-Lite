"""Blender Anatomy Helper — a small sidebar panel for organizing anatomy
meshes (arteries, veins, nerves, lymphatics, organs, ...) before exporting
to glTF/GLB for the Babylon-Lite custom model viewer.

NO BLENDER SKILL REQUIRED. You only ever: select objects in the Outliner
or 3D viewport, then click one button.

HOW TO INSTALL (do this once per Blender session — it is not saved with
your .blend file, so re-run it each time you reopen Blender):
  1. Open your .blend file in Blender.
  2. Switch to the "Scripting" workspace tab (top of the window).
  3. Click "New" in the text editor, then paste this entire file's
     contents in, replacing anything that was there.
  4. Click the "Run Script" (play) button, or press Alt+P with the
     cursor in the text editor.
  5. Go back to the "Layout" workspace. In the 3D viewport, press "N"
     to open the sidebar if it isn't already open, then click the
     "Anatomy" tab on the right edge.

HOW TO USE:
  - RENAME BY SYSTEM: select all the meshes that belong to one system
    (e.g. every artery mesh near the reproductive organs — shift-click
    them in the Outliner or viewport), type a label like "Artery" into
    the "Category" box, click "Prefix Selected Names". Each selected
    object is renamed to "Artery - <its original name>". Re-running
    with a different selection/category is safe — it will not
    double-prefix a name that already starts with "<Category> - ".

  - GROUP INTO ONE SYSTEM: select everything in a system (after naming
    them, or instead of naming them), type a group label like
    "Reproductive Arterial" into "Group name", click "Parent Selected
    To New Group". This creates an empty named "Reproductive Arterial"
    and parents all selected objects to it (keeping their current
    position — nothing moves). Babylon-Lite's glTF loader preserves
    this as a transform-node hierarchy, so later you (or the viewer's
    merge tool) can select/toggle the whole group as one unit.

  - LIST NAMES: click "List Selected Names" (or "List All Mesh Names")
    to dump every selected mesh's name — and its parent chain — into a
    Blender text block called "anatomy_name_dump" so you can read
    through it in the Text Editor and figure out what's what before
    you rename/group anything.

  - EXPORT: once you're happy, select the objects you want in the file
    (or select nothing to export everything) and click "Export Selected
    as GLB" (or "Export All as GLB"). This calls Blender's normal glTF
    exporter with settings that match what the custom model viewer
    expects (binary .glb, Y-up, applied transforms) — a file browser
    will pop up for you to pick where to save.

This script only touches objects you've selected; it never deletes or
merges geometry, so it's safe to experiment with (undo with Ctrl+Z if a
rename/parent goes somewhere you didn't want).
"""

import bpy
from mathutils import Vector


class ANATOMY_OT_prefix_names(bpy.types.Operator):
    """Prefix every selected object's name with the category label"""

    bl_idname = "anatomy.prefix_names"
    bl_label = "Prefix Selected Names"
    bl_options = {"REGISTER", "UNDO"}

    def execute(self, context):
        category = context.scene.anatomy_helper_category.strip()
        if not category:
            self.report({"ERROR"}, "Enter a category label first (e.g. Artery).")
            return {"CANCELLED"}

        prefix = f"{category} - "
        renamed = 0
        for obj in context.selected_objects:
            if obj.name.startswith(prefix):
                continue
            # Strip a differently-labeled prefix if present, so re-categorizing
            # an object doesn't end up with "Vein - Artery - foo".
            base_name = obj.name
            if " - " in base_name:
                _, _, rest = base_name.partition(" - ")
                base_name = rest
            obj.name = f"{prefix}{base_name}"
            renamed += 1

        self.report({"INFO"}, f"Renamed {renamed} object(s).")
        return {"FINISHED"}


class ANATOMY_OT_group_selected(bpy.types.Operator):
    """Parent every selected object under a new empty named after the group"""

    bl_idname = "anatomy.group_selected"
    bl_label = "Parent Selected To New Group"
    bl_options = {"REGISTER", "UNDO"}

    def execute(self, context):
        group_name = context.scene.anatomy_helper_group_name.strip()
        if not group_name:
            self.report({"ERROR"}, "Enter a group name first (e.g. Reproductive Arterial).")
            return {"CANCELLED"}

        selected = list(context.selected_objects)
        if not selected:
            self.report({"ERROR"}, "Select at least one object first.")
            return {"CANCELLED"}

        # Place the new empty at the median of the selected objects so it's
        # easy to find, then parent everything to it without moving anything
        # (keep_transform keeps each child's current world position).
        median = sum((obj.matrix_world.translation for obj in selected), Vector((0.0, 0.0, 0.0)))
        median = median / len(selected)

        bpy.ops.object.empty_add(type="PLAIN_AXES", location=median)
        group_empty = context.active_object
        group_empty.name = group_name
        group_empty.empty_display_size = 0.05

        for obj in selected:
            obj.parent = group_empty
            obj.matrix_parent_inverse = group_empty.matrix_world.inverted()

        self.report({"INFO"}, f"Parented {len(selected)} object(s) under \"{group_name}\".")
        return {"FINISHED"}


def _describe_object(obj, depth=0):
    chain = []
    node = obj
    while node is not None:
        chain.append(node.name)
        node = node.parent
    chain.reverse()
    return "  " * depth + " > ".join(chain)


class ANATOMY_OT_list_names(bpy.types.Operator):
    """Write selected (or all) mesh object names + parent chains to a text block"""

    bl_idname = "anatomy.list_names"
    bl_label = "List Names"
    bl_options = {"REGISTER", "UNDO"}

    all_objects: bpy.props.BoolProperty(default=False)

    def execute(self, context):
        objects = context.scene.objects if self.all_objects else context.selected_objects
        meshes = sorted(
            (obj for obj in objects if obj.type == "MESH"),
            key=lambda obj: obj.name.lower(),
        )

        text_name = "anatomy_name_dump"
        text = bpy.data.texts.get(text_name)
        if text is None:
            text = bpy.data.texts.new(text_name)
        text.clear()

        if not meshes:
            text.write("(no mesh objects found in the requested selection)\n")
        else:
            for obj in meshes:
                text.write(_describe_object(obj) + "\n")

        self.report({"INFO"}, f"Wrote {len(meshes)} name(s) to the \"{text_name}\" text block.")
        return {"FINISHED"}


class ANATOMY_OT_export_glb(bpy.types.Operator):
    """Export to a GLB file using settings matching the custom model viewer"""

    bl_idname = "anatomy.export_glb"
    bl_label = "Export as GLB"
    bl_options = {"REGISTER"}

    filepath: bpy.props.StringProperty(subtype="FILE_PATH")
    use_selection: bpy.props.BoolProperty(default=True)

    def invoke(self, context, event):
        if not self.filepath:
            self.filepath = "model.glb"
        context.window_manager.fileselect_add(self)
        return {"RUNNING_MODAL"}

    def execute(self, context):
        bpy.ops.export_scene.gltf(
            filepath=self.filepath,
            export_format="GLB",
            use_selection=self.use_selection,
            export_apply=True,
            export_yup=True,
        )
        self.report({"INFO"}, f"Exported to {self.filepath}")
        return {"FINISHED"}


class ANATOMY_PT_panel(bpy.types.Panel):
    """Sidebar panel: press N in the 3D viewport, then the 'Anatomy' tab"""

    bl_label = "Anatomy Helper"
    bl_idname = "ANATOMY_PT_panel"
    bl_space_type = "VIEW_3D"
    bl_region_type = "UI"
    bl_category = "Anatomy"

    def draw(self, context):
        layout = self.layout

        box = layout.box()
        box.label(text="1. Rename by system")
        box.prop(context.scene, "anatomy_helper_category", text="Category")
        box.operator("anatomy.prefix_names", icon="FONT_DATA")

        box = layout.box()
        box.label(text="2. Group into one system")
        box.prop(context.scene, "anatomy_helper_group_name", text="Group name")
        box.operator("anatomy.group_selected", icon="OUTLINER")

        box = layout.box()
        box.label(text="3. List names (reference)")
        row = box.row(align=True)
        row.operator("anatomy.list_names", text="Selected").all_objects = False
        row.operator("anatomy.list_names", text="All Meshes").all_objects = True

        box = layout.box()
        box.label(text="4. Export")
        row = box.row(align=True)
        op = row.operator("anatomy.export_glb", text="Selected")
        op.use_selection = True
        op = row.operator("anatomy.export_glb", text="Everything")
        op.use_selection = False


classes = (
    ANATOMY_OT_prefix_names,
    ANATOMY_OT_group_selected,
    ANATOMY_OT_list_names,
    ANATOMY_OT_export_glb,
    ANATOMY_PT_panel,
)


def register():
    for cls in classes:
        bpy.utils.register_class(cls)
    bpy.types.Scene.anatomy_helper_category = bpy.props.StringProperty(
        name="Category", default="Artery"
    )
    bpy.types.Scene.anatomy_helper_group_name = bpy.props.StringProperty(
        name="Group name", default="Reproductive Arterial"
    )


def unregister():
    del bpy.types.Scene.anatomy_helper_group_name
    del bpy.types.Scene.anatomy_helper_category
    for cls in reversed(classes):
        bpy.utils.unregister_class(cls)


register()
