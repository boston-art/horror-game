"""
Builds the monster for the game, rigs it, animates it (Idle / Walk / Run) and exports
public/models/monster.glb, plus a preview render at tools/monster_preview.png.

Run from the project folder:
    /Applications/Blender.app/Contents/MacOS/Blender -b -P tools/build_monster.py

If references/monster.glb exists, that model is used instead of the generated one and
is only rigged and animated.

Blender axes: Z up, the monster faces -Y.
"""
import bpy, bmesh, math, os, sys
from mathutils import Vector, Quaternion, Matrix

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_GLB = os.path.join(ROOT, "public", "models", "monster.glb")
OUT_PNG = os.path.join(ROOT, "tools", "monster_preview.png")
READY_MADE = os.path.join(ROOT, "references", "monster.glb")
TEX = os.path.join(ROOT, "tools", "monster_pinstripe.png")

bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
col = scene.collection

# ----------------------------------------------------------------------------- skeleton
# Joint positions of the hunched rest pose (metres). +X is one side, -Y is forward.
J = {
    "pelvis": (0, 0.04, 1.04), "spine1": (0, -0.06, 1.30), "hump": (0, -0.13, 1.57),
    "chest": (0, -0.31, 1.66), "neck": (0, -0.50, 1.64), "head": (0, -0.66, 1.58), "headtip": (0, -0.84, 1.53),
    "shoulder": (0.31, -0.33, 1.71), "elbow": (0.47, -0.42, 1.30), "wrist": (0.45, -0.63, 0.93), "blade": (0.41, -0.82, 0.05),
    "hip": (0.14, 0.03, 1.00), "knee": (0.23, -0.25, 0.57), "ankle": (0.21, 0.05, 0.10), "toe": (0.22, -0.19, 0.035),
}
def P(name, side=1):
    x, y, z = J[name]
    return Vector((x * side, y, z))

BONES = [  # name, head joint, tail joint, parent, side
    ("hips", "pelvis", "spine1", None, 0), ("spine", "spine1", "hump", "hips", 0), ("chest", "hump", "chest", "spine", 0),
    ("neck", "chest", "neck", "chest", 0), ("head", "neck", "headtip", "neck", 0),
]
for s, tag in ((1, "L"), (-1, "R")):
    BONES += [
        (f"upperarm.{tag}", "shoulder", "elbow", "chest", s), (f"forearm.{tag}", "elbow", "wrist", f"upperarm.{tag}", s),
        (f"hand.{tag}", "wrist", "blade", f"forearm.{tag}", s),
        (f"thigh.{tag}", "hip", "knee", "hips", s), (f"shin.{tag}", "knee", "ankle", f"thigh.{tag}", s),
        (f"foot.{tag}", "ankle", "toe", f"shin.{tag}", s),
    ]
SEG = {n: (P(a, s or 1), P(b, s or 1)) for n, a, b, _, s in BONES}

# ----------------------------------------------------------------------------- materials
def make_pinstripe():
    n = 256
    img = bpy.data.images.new("pinstripe", n, n)
    import random
    random.seed(4)
    px = [0.0] * (n * n * 4)
    for y in range(n):
        for x in range(n):
            stripe = (x % 32) < 2
            g = 0.035 + random.random() * 0.02
            r, gg, b = g, g, g * 1.15
            if stripe:
                r, gg, b = 0.2, 0.2, 0.21
            # grime
            if random.random() < 0.015:
                r, gg, b = r * 0.4, gg * 0.4, b * 0.4
            i = (y * n + x) * 4
            px[i:i + 4] = (r, gg, b, 1.0)
    img.pixels = px
    img.filepath_raw = TEX
    img.file_format = "PNG"
    img.save()
    return img

def material(name, color, rough=0.6, image=None, emit=None):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    bsdf = m.node_tree.nodes.get("Principled BSDF")
    bsdf.inputs["Base Color"].default_value = (*color, 1)
    bsdf.inputs["Roughness"].default_value = rough
    if image:
        t = m.node_tree.nodes.new("ShaderNodeTexImage")
        t.image = image
        m.node_tree.links.new(t.outputs["Color"], bsdf.inputs["Base Color"])
    return m

MAT = {}
def setup_materials():
    MAT["suit"] = material("suit", (0.05, 0.05, 0.06), 0.85, make_pinstripe())
    MAT["skin"] = material("skin", (0.60, 0.55, 0.50), 0.5)
    MAT["bone"] = material("bone", (0.66, 0.62, 0.52), 0.4)
    MAT["teeth"] = material("teeth", (0.78, 0.72, 0.56), 0.3)
    MAT["mouth"] = material("mouth", (0.05, 0.005, 0.005), 0.5)

# ----------------------------------------------------------------------------- mesh helpers
def new_obj(name, bm, mat):
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    ob = bpy.data.objects.new(name, me)
    col.objects.link(ob)
    me.materials.append(MAT[mat])
    for p in me.polygons:
        p.use_smooth = True
    return ob

def weight_rigid(ob, bone):
    g = ob.vertex_groups.new(name=bone)
    g.add(list(range(len(ob.data.vertices))), 1.0, "REPLACE")

def seg_dist(p, a, b):
    ab = b - a
    t = max(0.0, min(1.0, (p - a).dot(ab) / ab.length_squared))
    return (p - (a + ab * t)).length

def weight_auto(ob, allowed=None):
    """Each vertex follows its two nearest bones (same side only)."""
    names = [n for n in SEG if (allowed is None or n in allowed)]
    groups = {n: ob.vertex_groups.new(name=n) for n in names}
    for v in ob.data.vertices:
        p = ob.matrix_world @ v.co
        ds = []
        for n in names:
            if (n.endswith(".L") and p.x < -0.02) or (n.endswith(".R") and p.x > 0.02):
                continue
            ds.append((seg_dist(p, *SEG[n]), n))
        ds.sort()
        (d0, n0), (d1, n1) = ds[0], ds[1]
        w0, w1 = 1 / (d0 ** 4 + 1e-8), 1 / (d1 ** 4 + 1e-8)
        tot = w0 + w1
        groups[n0].add([v.index], w0 / tot, "REPLACE")
        if w1 / tot > 0.02:
            groups[n1].add([v.index], w1 / tot, "REPLACE")

def planar_uv(ob, scale=5.0):
    me = ob.data
    uv = me.uv_layers.new(name="UVMap")
    for loop in me.loops:
        co = me.vertices[loop.vertex_index].co
        uv.data[loop.index].uv = ((co.x + co.y * 0.8) * scale, co.z * scale)

# ----------------------------------------------------------------------------- generated monster
def build_body():
    # stick figure -> skin modifier -> smooth organic body in a suit
    pts, radii, edges = [], [], []
    def v(pos, r):
        pts.append(pos); radii.append(r if isinstance(r, tuple) else (r, r)); return len(pts) - 1
    pelvis = v(P("pelvis"), (0.21, 0.16)); sp = v(P("spine1"), (0.22, 0.18)); hump = v(P("hump"), (0.31, 0.25))
    chest = v(P("chest"), (0.33, 0.21)); neck = v(P("neck"), 0.08); head = v(P("head"), 0.07)
    edges += [(pelvis, sp), (sp, hump), (hump, chest), (chest, neck), (neck, head)]
    for s in (1, -1):
        sh = v(P("shoulder", s), 0.13); el = v(P("elbow", s), 0.08); wr = v(P("wrist", s), 0.052)
        hand = v(P("wrist", s).lerp(P("blade", s), 0.12), 0.05)
        edges += [(chest, sh), (sh, el), (el, wr), (wr, hand)]
        hip = v(P("hip", s), 0.135); kn = v(P("knee", s), 0.09); an = v(P("ankle", s), 0.06); toe = v(P("toe", s), (0.055, 0.04))
        edges += [(pelvis, hip), (hip, kn), (kn, an), (an, toe)]
    me = bpy.data.meshes.new("stick")
    me.from_pydata([tuple(p) for p in pts], edges, [])
    ob = bpy.data.objects.new("stick", me)
    col.objects.link(ob)
    skin = ob.modifiers.new("skin", "SKIN")
    for i, r in enumerate(radii):
        me.skin_vertices[0].data[i].radius = r
        me.skin_vertices[0].data[i].use_root = (i == pelvis)
    sub = ob.modifiers.new("sub", "SUBSURF")
    sub.levels = 2
    dg = bpy.context.evaluated_depsgraph_get()
    body_me = bpy.data.meshes.new_from_object(ob.evaluated_get(dg))
    bpy.data.objects.remove(ob)
    body = bpy.data.objects.new("body", body_me)
    col.objects.link(body)
    for p in body_me.polygons:
        p.use_smooth = True
    body_me.materials.append(MAT["suit"])
    body_me.materials.append(MAT["skin"])
    # bare skin on the neck and hands, suit everywhere else
    nk, hd = P("neck"), P("head")
    for p in body_me.polygons:
        c = p.center
        bare = seg_dist(c, nk.lerp(P("chest"), 0.35), hd) < 0.12
        for s in (1, -1):
            if (c - P("wrist", s)).length < 0.075 or seg_dist(c, P("wrist", s), P("wrist", s).lerp(P("blade", s), 0.2)) < 0.07:
                bare = True
        p.material_index = 1 if bare else 0
    planar_uv(body)
    weight_auto(body)
    return body

def build_head():
    c = P("head")
    bm = bmesh.new()
    bmesh.ops.create_uvsphere(bm, u_segments=24, v_segments=16, radius=0.155)
    bmesh.ops.scale(bm, vec=(0.92, 1.22, 1.16), verts=bm.verts)
    # flatten the lower face a little so the grin sits on a plane-ish area
    for v in bm.verts:
        if v.co.z < -0.02 and v.co.y < 0:
            v.co.y *= 0.93
    bmesh.ops.translate(bm, vec=c + Vector((0, 0, 0.02)), verts=bm.verts)
    head = new_obj("head", bm, "skin")
    # jaw
    bm = bmesh.new()
    bmesh.ops.create_uvsphere(bm, u_segments=20, v_segments=12, radius=0.12)
    bmesh.ops.scale(bm, vec=(0.98, 1.2, 0.72), verts=bm.verts)
    bmesh.ops.translate(bm, vec=c + Vector((0, -0.015, -0.085)), verts=bm.verts)
    jaw = new_obj("jaw", bm, "skin")
    # dark mouth band wrapping the front of the face
    bm = bmesh.new()
    bmesh.ops.create_uvsphere(bm, u_segments=24, v_segments=12, radius=0.15)
    bmesh.ops.scale(bm, vec=(0.925, 1.215, 0.34), verts=bm.verts)
    for v in bm.verts:
        v.co.z += 0.045 * math.atan2(v.co.x, -v.co.y) ** 2 if v.co.y < 0 else 0.0
    bmesh.ops.translate(bm, vec=c + Vector((0, -0.012, -0.055)), verts=bm.verts)
    mouth = new_obj("mouth", bm, "mouth")
    # two rows of bare teeth along the grin
    bm = bmesh.new()
    n = 13
    for row, (zoff, h) in enumerate(((-0.036, 0.034), (-0.076, 0.030))):
        for i in range(n):
            a = math.radians(-58 + 116 * i / (n - 1))
            pos = c + Vector((math.sin(a) * 0.139, -math.cos(a) * 0.183 - 0.006, zoff + 0.045 * a * a))  # corners curl up into a grin
            w = 0.0135 if abs(a) < 0.8 else 0.011
            m = Matrix.Translation(pos) @ Matrix.Rotation(-a, 4, "Z")
            r = bmesh.ops.create_cube(bm, size=1.0, matrix=m)
            for vv in r["verts"]:
                local = m.inverted() @ vv.co
                local.x *= w; local.y *= 0.012; local.z *= h
                # taper toward the biting edge
                if (local.z > 0) == (row == 1):
                    local.x *= 0.55
                vv.co = m @ local
    teeth = new_obj("teeth", bm, "teeth")
    for p in teeth.data.polygons:
        p.use_smooth = False
    for ob in (head, jaw, mouth, teeth):
        weight_rigid(ob, "head")
    return [head, jaw, mouth, teeth]

def build_blades():
    out = []
    for s, tag in ((1, "L"), (-1, "R")):
        a, b = P("wrist", s).lerp(P("blade", s), 0.06), P("blade", s)
        for k, (length, off, rad) in enumerate(((1.0, 0.0, 0.045), (0.6, 0.04, 0.03))):
            tip = a.lerp(b, length)
            d = tip - a
            bm = bmesh.new()
            bmesh.ops.create_cone(bm, cap_ends=True, segments=8, radius1=rad, radius2=0.0025, depth=d.length)
            # flatten into a blade, then give it a slight curve
            for v in bm.verts:
                v.co.x *= 0.32
                t = v.co.z / d.length + 0.5
                v.co.y += 0.05 * math.sin(t * math.pi) * (1 if k == 0 else -1)
            rot = Vector((0, 0, 1)).rotation_difference(d.normalized()).to_matrix().to_4x4()
            mid = (a + tip) / 2 + Vector((off * s, 0, 0))
            bmesh.ops.transform(bm, matrix=Matrix.Translation(mid) @ rot, verts=bm.verts)
            ob = new_obj(f"blade{k}.{tag}", bm, "bone")
            weight_rigid(ob, f"hand.{tag}")
            out.append(ob)
    return out

def build_tatters():
    # torn jacket tails and a ragged collar hanging off the suit
    import random
    random.seed(11)
    bm = bmesh.new()
    def strip(top_a, top_b, drop, jag):
        segs = 5
        tops = [top_a.lerp(top_b, i / segs) for i in range(segs + 1)]
        bots = [t + Vector((random.uniform(-0.02, 0.02), random.uniform(-0.03, 0.05), -drop * random.uniform(1 - jag, 1))) for t in tops]
        vt = [bm.verts.new(t) for t in tops]; vb = [bm.verts.new(b) for b in bots]
        for i in range(segs):
            bm.faces.new((vt[i], vt[i + 1], vb[i + 1], vb[i]))
    pel = P("pelvis")
    for s in (1, -1):
        strip(pel + Vector((0.02 * s, 0.15, 0.02)), pel + Vector((0.21 * s, 0.06, 0.0)), 0.42, 0.55)   # back tails
        strip(pel + Vector((0.21 * s, 0.05, 0.0)), pel + Vector((0.2 * s, -0.13, 0.03)), 0.34, 0.6)     # side
        strip(pel + Vector((0.2 * s, -0.13, 0.03)), pel + Vector((0.04 * s, -0.17, 0.06)), 0.26, 0.7)   # front flap
    ob = new_obj("tatters", bm, "suit")
    planar_uv(ob)
    weight_auto(ob, allowed={"hips", "thigh.L", "thigh.R"})
    return ob

def build_generated():
    parts = [build_body()] + build_head() + build_blades() + [build_tatters()]
    return join(parts)

def join(parts):
    bpy.ops.object.select_all(action="DESELECT")
    for p in parts:
        p.select_set(True)
    bpy.context.view_layer.objects.active = parts[0]
    bpy.ops.object.join()
    ob = parts[0]
    ob.name = "Monster"
    return ob

# ----------------------------------------------------------------------------- ready-made model
def load_ready_made():
    bpy.ops.import_scene.gltf(filepath=READY_MADE)
    meshes = [o for o in scene.objects if o.type == "MESH"]
    for o in meshes:
        bpy.ops.object.select_all(action="DESELECT")
        o.select_set(True)
        bpy.context.view_layer.objects.active = o
        bpy.ops.object.parent_clear(type="CLEAR_KEEP_TRANSFORM")
        for m in list(o.modifiers):
            o.modifiers.remove(m)
        o.vertex_groups.clear()
    ob = join(meshes)
    for o in [o for o in scene.objects if o is not ob]:
        bpy.data.objects.remove(o)
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    # scale to the generated monster's height and stand it on the floor, centred
    xs = [(ob.matrix_world @ v.co) for v in ob.data.vertices]
    lo = Vector((min(v.x for v in xs), min(v.y for v in xs), min(v.z for v in xs)))
    hi = Vector((max(v.x for v in xs), max(v.y for v in xs), max(v.z for v in xs)))
    k = 1.9 / (hi.z - lo.z)
    ob.scale = (k, k, k)
    ob.location = (-(lo.x + hi.x) / 2 * k, -(lo.y + hi.y) / 2 * k - 0.3, -lo.z * k)
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    weight_auto(ob)
    return ob

# ----------------------------------------------------------------------------- rig
def build_rig(mesh):
    arm_data = bpy.data.armatures.new("MonsterRig")
    arm = bpy.data.objects.new("MonsterRig", arm_data)
    col.objects.link(arm)
    bpy.context.view_layer.objects.active = arm
    bpy.ops.object.mode_set(mode="EDIT")
    eb = arm_data.edit_bones
    root = eb.new("root"); root.head = (0, 0, 0); root.tail = (0, 0.25, 0); root.use_deform = False
    for name, _, _, parent, _ in BONES:
        b = eb.new(name)
        b.head, b.tail = SEG[name]
        b.parent = eb[parent] if parent else root
    bpy.ops.object.mode_set(mode="OBJECT")
    mesh.parent = arm
    mod = mesh.modifiers.new("Armature", "ARMATURE")
    mod.object = arm
    return arm

# ----------------------------------------------------------------------------- animation
AX = {"x": Vector((1, 0, 0)), "y": Vector((0, 1, 0)), "z": Vector((0, 0, 1))}

def pose(arm, frame, rots, hips_z=0.0):
    """rots: {bone: [(axis, degrees), ...]} with axes in armature space.
    For an upright bone +x leans it forward; for a hanging limb -x swings it forward."""
    for pb in arm.pose.bones:
        pb.rotation_mode = "QUATERNION"
        rest = pb.bone.matrix_local.to_quaternion()
        q = Quaternion()
        for axis, deg in rots.get(pb.name, []):
            q = Quaternion(AX[axis], math.radians(deg)) @ q
        pb.rotation_quaternion = rest.inverted() @ q @ rest
        pb.keyframe_insert("rotation_quaternion", frame=frame)
    hb = arm.pose.bones["hips"]
    hb.location = hb.bone.matrix_local.to_quaternion().inverted() @ Vector((0, 0, hips_z))
    hb.keyframe_insert("location", frame=frame)

def make_action(arm, name, length, fn):
    arm.animation_data_create()
    act = bpy.data.actions.new(name)
    arm.animation_data.action = act
    for f in range(length + 1):
        rots, bob = fn(2 * math.pi * f / length)
        pose(arm, f + 1, rots, bob)
    track = arm.animation_data.nla_tracks.new()
    track.name = name
    strip = track.strips.new(name, 1, act)
    strip.name = name
    arm.animation_data.action = None
    return act

def gait(p, leg, knee, arm_swing, lean, bob, twist):
    s, c = math.sin, math.cos
    r = {
        "hips": [("z", -twist * s(p)), ("x", lean * 0.3)],
        "spine": [("x", lean * 0.4), ("z", twist * 0.8 * s(p))],
        "chest": [("x", lean * 0.3 + 2 * s(2 * p)), ("z", twist * s(p))],
        "neck": [("x", -lean * 0.5)],
        "head": [("x", -lean * 0.4 + 3 * s(2 * p + 1)), ("z", -twist * s(p))],
    }
    for tag, ph in (("L", 0.0), ("R", math.pi)):
        q = p + ph
        r[f"thigh.{tag}"] = [("x", -leg * s(q) - leg * 0.15)]
        r[f"shin.{tag}"] = [("x", knee * (0.55 + 0.45 * s(q - 1.9)))]
        r[f"foot.{tag}"] = [("x", -10 * s(q - 0.6))]
        r[f"upperarm.{tag}"] = [("x", arm_swing * s(q) + lean * 0.3)]
        r[f"forearm.{tag}"] = [("x", arm_swing * 0.5 * s(q - 0.5))]
        r[f"hand.{tag}"] = [("x", arm_swing * 0.35 * s(q - 1.0))]
    return r, -bob * (0.5 + 0.5 * c(2 * p))

def idle(p):
    s = math.sin
    r = {
        "spine": [("x", 1.5 * s(p))], "chest": [("x", 2.5 * s(p))],
        "neck": [("z", 6 * s(p * 2 + 0.5))], "head": [("z", 11 * s(p)), ("x", 4 * s(2 * p)), ("y", 5 * s(p + 1))],
    }
    for tag, sg in (("L", 1), ("R", -1)):
        r[f"upperarm.{tag}"] = [("x", 3 * s(p + sg)), ("y", sg * 2 * s(p))]
        r[f"forearm.{tag}"] = [("x", 4 * s(p + 1.5 * sg))]
        r[f"hand.{tag}"] = [("x", 5 * s(2 * p + sg))]
    return r, -0.012 * (0.5 + 0.5 * s(p))

def animate(arm):
    make_action(arm, "Idle", 96, idle)
    make_action(arm, "Walk", 28, lambda p: gait(p, leg=24, knee=34, arm_swing=13, lean=4, bob=0.035, twist=5))
    make_action(arm, "Run", 16, lambda p: gait(p, leg=42, knee=62, arm_swing=28, lean=16, bob=0.07, twist=9))
    for pb in arm.pose.bones:
        pb.rotation_quaternion = Quaternion()
        pb.location = (0, 0, 0)

# ----------------------------------------------------------------------------- preview render
def render_preview(arm):
    arm.data.pose_position = "REST"
    scene.frame_set(1)
    cam_data = bpy.data.cameras.new("cam")
    cam_data.lens = 50
    cam = bpy.data.objects.new("cam", cam_data)
    col.objects.link(cam)
    cam.location = (-1.3, -4.7, 1.25)
    target = Vector((0, -0.25, 1.0))
    cam.rotation_euler = (target - cam.location).to_track_quat("-Z", "Y").to_euler()
    scene.camera = cam
    sun = bpy.data.objects.new("sun", bpy.data.lights.new("sun", "SUN"))
    sun.data.energy = 3.2
    sun.rotation_euler = (math.radians(50), 0, math.radians(-35))
    col.objects.link(sun)
    bm = bmesh.new()
    bmesh.ops.create_grid(bm, x_segments=1, y_segments=1, size=12)
    me = bpy.data.meshes.new("ground"); bm.to_mesh(me); bm.free()
    g = bpy.data.objects.new("ground", me)
    me.materials.append(material("ground", (0.22, 0.30, 0.12), 0.9))
    col.objects.link(g)
    world = bpy.data.worlds.new("w")
    world.use_nodes = True
    world.node_tree.nodes["Background"].inputs[0].default_value = (0.55, 0.72, 0.85, 1)
    world.node_tree.nodes["Background"].inputs[1].default_value = 0.9
    scene.world = world
    scene.render.engine = "CYCLES"
    scene.cycles.samples = 48
    scene.cycles.device = "CPU"
    scene.render.resolution_x = 600
    scene.render.resolution_y = 1000
    scene.render.filepath = OUT_PNG
    scene.view_settings.view_transform = "Standard"
    bpy.ops.render.render(write_still=True)
    for o in (cam, sun, g):
        bpy.data.objects.remove(o)
    arm.data.pose_position = "POSE"

# ----------------------------------------------------------------------------- main
setup_materials()
if os.path.exists(READY_MADE):
    print("Using ready-made model:", READY_MADE)
    monster = load_ready_made()
else:
    monster = build_generated()
rig = build_rig(monster)
animate(rig)

os.makedirs(os.path.dirname(OUT_GLB), exist_ok=True)
bpy.ops.export_scene.gltf(
    filepath=OUT_GLB, export_format="GLB", export_animations=True,
    export_animation_mode="NLA_TRACKS", export_skins=True, export_yup=True,
)
print("Exported", OUT_GLB)
if "--no-render" not in sys.argv:
    render_preview(rig)
    print("Rendered", OUT_PNG)
