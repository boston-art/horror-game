"""
Builds the monster for the game, rigs it, animates it (Idle / Walk / Run / Duck / Scream) and
exports public/models/monster.glb, plus preview renders in tools/:
    monster_preview.png         rest pose
    monster_preview_walk.png    a frame of the walk
    monster_preview_run.png     a frame of the run
    monster_preview_face.png    close-up of the face, lit like a flashlight
    monster_preview_scream.png  the Scream pose framed like the in-game jump scare
    monster_preview_duck.png    ducking through a 0.95 x 2.1 m door frame

Version 4, "the Stilt": a starved, far too tall figure (2.5 m) that walks upright on long,
slightly bent legs with the slow, careful steps of someone trying not to make a sound. Its
arms are folded up in front of its chest, hands raised, long fingers curled, as if it were
holding something that is not there; that keeps it narrow enough for the school's doors and
hallways. Its long, backswept skull sits on a thin neck that leans forward and is always
tilted a little too far to one side. The face is mostly mouth: narrow black sockets with a
pinpoint of light deep inside, no nose but two slits, and a long lipless mouth hanging open,
ringed with teeth and stained below. It ducks, folding at the hips and knees, to pass under
door lintels.

The head is one sculpted mesh (a dense sphere deformed by code). The face features are 2D
functions of the front-view position (x, z) used both to deform the mesh and to paint the
colour texture + normal map, so painted creases line up with sculpted ones. The legs are
animated with an analytic two-bone IK so the feet plant on the ground; the game plays the
clips at a rate matched to its ground speed (see the STRIDE printout at the end).

Earlier versions: tools/build_monster_v1_suit.py (hunched figure in a suit) and
tools/build_monster_v2_crawler.py (giant spider-like crawler, public/models/monster_v2_crawler.glb).

Run from the project folder:
    /Applications/Blender.app/Contents/MacOS/Blender -b -P tools/build_monster.py
Add `-- --no-render` to skip the preview renders.

Blender axes: Z up, the monster faces -Y. Units: metres, true size (the game uses scale 1).
"""
import bpy, bmesh, math, os, sys, random
import numpy as np
from mathutils import Vector, Quaternion, Matrix

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_GLB = os.path.join(ROOT, "public", "models", "monster.glb")
TEXDIR = os.path.join(ROOT, "tools")
PREV = lambda n: os.path.join(ROOT, "tools", f"monster_preview{n}.png")

bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
col = scene.collection
scene.render.fps = 24

# ----------------------------------------------------------------------------- head placement
HS = 0.85                                 # head scale (head-local units -> metres)
HC = Vector((0, -0.1625, 2.302))          # head centre in world space
def hw(x, y, z):
    return HC + Vector((x, y, z)) * HS

# ----------------------------------------------------------------------------- skeleton
# Rest pose (metres). +X is its left, -Y is forward. Standing, arms folded up in front.
J = {
    "pelvis": (0, 0.03, 1.35), "spine1": (0, 0.06, 1.55), "mid": (0, 0.075, 1.74),
    "chest": (0, 0.06, 1.92), "neck": (0, 0.0, 2.075), "head": (0, -0.12, 2.20), "headtip": (0, -0.24, 2.38),
    "shoulder": (0.165, 0.035, 2.02), "elbow": (0.190, 0.07, 1.50), "wrist": (0.075, -0.17, 1.72), "tip": (0.030, -0.205, 1.95),
    "hip": (0.095, 0.02, 1.32), "knee": (0.105, -0.04, 0.70), "ankle": (0.11, 0.03, 0.085), "toe": (0.115, -0.17, 0.03),
    "jaw": tuple(hw(0, 0.035, -0.075)), "chin": tuple(hw(0, -0.06, -0.255)),
}
def P(name, side=1):
    x, y, z = J[name]
    return Vector((x * side, y, z))

BONES = [  # name, head joint, tail joint, parent, side
    ("hips", "pelvis", "spine1", None, 0), ("spine", "spine1", "mid", "hips", 0), ("chest", "mid", "neck", "spine", 0),
    ("neck", "neck", "head", "chest", 0), ("head", "head", "headtip", "neck", 0), ("jaw", "jaw", "chin", "head", 0),
]
for s, tag in ((1, "L"), (-1, "R")):
    BONES += [
        (f"upperarm.{tag}", "shoulder", "elbow", "chest", s), (f"forearm.{tag}", "elbow", "wrist", f"upperarm.{tag}", s),
        (f"hand.{tag}", "wrist", "tip", f"forearm.{tag}", s),
        (f"thigh.{tag}", "hip", "knee", "hips", s), (f"shin.{tag}", "knee", "ankle", f"thigh.{tag}", s),
        (f"foot.{tag}", "ankle", "toe", f"shin.{tag}", s),
    ]
SEG = {n: (P(a, s or 1), P(b, s or 1)) for n, a, b, _, s in BONES}
PARENT = {n: p for n, _, _, p, _ in BONES}

# ----------------------------------------------------------------------------- numpy helpers
def smoothstep(a, b, x):
    t = np.clip((x - a) / (b - a), 0.0, 1.0)
    return t * t * (3 - 2 * t)

_GRIDS = {}
def vnoise(x, y, freq, seed, period=None):
    """Value noise; periodic with `period` lattice cells when given."""
    P_ = period or 1024
    key = (seed, P_)
    if key not in _GRIDS:
        _GRIDS[key] = np.random.RandomState(seed).rand(P_, P_).astype(np.float32)
    g = _GRIDS[key]
    fx, fy = x * freq, y * freq
    ix, iy = np.floor(fx).astype(np.int64), np.floor(fy).astype(np.int64)
    tx, ty = fx - ix, fy - iy
    tx = tx * tx * (3 - 2 * tx); ty = ty * ty * (3 - 2 * ty)
    x0, y0, x1, y1 = ix % P_, iy % P_, (ix + 1) % P_, (iy + 1) % P_
    a = g[y0, x0] * (1 - tx) + g[y0, x1] * tx
    b = g[y1, x0] * (1 - tx) + g[y1, x1] * tx
    return a * (1 - ty) + b * ty

def fbm(x, y, freq, seed, octaves=4, periodic=False):
    s, amp, tot = 0.0, 1.0, 0.0
    for o in range(octaves):
        f = freq * 2 ** o
        s = s + amp * vnoise(x, y, f, seed + 17 * o, int(f) if periodic else None)
        tot += amp; amp *= 0.5
    return s / tot

def blur(a, r, wrap=False):
    """Approximate gaussian blur: three separable box blurs of radius r pixels."""
    r = max(1, int(r))
    for _ in range(3):
        for ax in (0, 1):
            if wrap:
                p = np.concatenate([a.take(range(-r, 0), axis=ax), a, a.take(range(0, r + 1), axis=ax)], axis=ax)
            else:
                pad = [(0, 0), (0, 0)]; pad[ax] = (r, r + 1)
                p = np.pad(a, pad, mode="edge")
            c = np.cumsum(p, axis=ax)
            n = a.shape[ax]
            if ax == 0:
                a = (c[2 * r + 1:2 * r + 1 + n] - c[0:n]) / (2 * r + 1)
            else:
                a = (c[:, 2 * r + 1:2 * r + 1 + n] - c[:, 0:n]) / (2 * r + 1)
    return a

def curve_dist(AX, Z, pts):
    """Distance from (AX, Z) to a polyline, the side it is on, and how far along it (0..1)."""
    best = np.full(AX.shape, 1e9); side = np.zeros(AX.shape); tpar = np.zeros(AX.shape)
    lens = [0.0]
    for a, b in zip(pts, pts[1:]):
        lens.append(lens[-1] + math.hypot(b[0] - a[0], b[1] - a[1]))
    tot = lens[-1]
    for i, (a, b) in enumerate(zip(pts, pts[1:])):
        dx, dz = b[0] - a[0], b[1] - a[1]
        l2 = dx * dx + dz * dz
        t = np.clip(((AX - a[0]) * dx + (Z - a[1]) * dz) / l2, 0, 1)
        d = np.hypot(AX - (a[0] + t * dx), Z - (a[1] + t * dz))
        cr = dx * (Z - a[1]) - dz * (AX - a[0])
        m = d < best
        best = np.where(m, d, best); side = np.where(m, np.sign(cr), side)
        tpar = np.where(m, (lens[i] + t * math.sqrt(l2)) / tot, tpar)
    return best, side, tpar

def save_image(name, arr, non_color=False):
    h, w, _ = arr.shape
    img = bpy.data.images.new(name, w, h, alpha=False)
    if non_color:
        img.colorspace_settings.name = "Non-Color"
    rgba = np.ones((h, w, 4), np.float32)
    rgba[..., :3] = np.clip(arr, 0, 1)
    img.pixels.foreach_set(rgba.ravel())
    img.filepath_raw = os.path.join(TEXDIR, name + ".png")
    img.file_format = "PNG"
    img.save()
    return img

def normal_from_height(H, du, dv, strength=1.0, wrap=False):
    if wrap:
        gx = (np.roll(H, -1, 1) - np.roll(H, 1, 1)) / (2 * du)
        gy = (np.roll(H, -1, 0) - np.roll(H, 1, 0)) / (2 * dv)
    else:
        gy, gx = np.gradient(H, dv, du)
    n = np.stack([-gx * strength, -gy * strength, np.ones_like(H)], -1)
    n /= np.linalg.norm(n, axis=-1, keepdims=True)
    return n * 0.5 + 0.5

# ----------------------------------------------------------------------------- materials
def material(name, color, rough=0.6, image=None, normal=None, nstrength=1.0, emit=None, spec=None):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    bsdf = nt.nodes.get("Principled BSDF")
    bsdf.inputs["Base Color"].default_value = (*color, 1)
    bsdf.inputs["Roughness"].default_value = rough
    if spec is not None:
        bsdf.inputs["Specular IOR Level"].default_value = spec
    if image:
        t = nt.nodes.new("ShaderNodeTexImage")
        t.image = image
        nt.links.new(t.outputs["Color"], bsdf.inputs["Base Color"])
    if normal:
        t = nt.nodes.new("ShaderNodeTexImage")
        t.image = normal
        nm = nt.nodes.new("ShaderNodeNormalMap")
        nm.inputs["Strength"].default_value = nstrength
        nt.links.new(t.outputs["Color"], nm.inputs["Color"])
        nt.links.new(nm.outputs["Normal"], bsdf.inputs["Normal"])
    if emit:
        bsdf.inputs["Emission Color"].default_value = (*emit[0], 1)
        bsdf.inputs["Emission Strength"].default_value = emit[1]
    return m

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
    names = [n for n in SEG if n != "jaw" and (allowed is None or n in allowed)]
    groups = {n: ob.vertex_groups.new(name=n) for n in names}
    for v in ob.data.vertices:
        p = ob.matrix_world @ v.co
        ds = []
        for n in names:
            if (n.endswith(".L") and p.x < -0.02) or (n.endswith(".R") and p.x > 0.02):
                continue
            ds.append((seg_dist(p, *SEG[n]), n))
        ds.sort()
        if len(ds) == 1:
            groups[ds[0][1]].add([v.index], 1.0, "REPLACE"); continue
        (d0, n0), (d1, n1) = ds[0], ds[1]
        w0, w1 = 1 / (d0 ** 4 + 1e-8), 1 / (d1 ** 4 + 1e-8)
        tot = w0 + w1
        groups[n0].add([v.index], w0 / tot, "REPLACE")
        if w1 / tot > 0.02:
            groups[n1].add([v.index], w1 / tot, "REPLACE")

def tube(bm, pts, radii, segs=6, cap=True):
    """Sweep a ring along a list of points; radii is one number per point."""
    rings = []
    for i, p in enumerate(pts):
        t = (pts[min(i + 1, len(pts) - 1)] - pts[max(i - 1, 0)]).normalized()
        n = t.cross(Vector((0, 0, 1)))
        if n.length < 1e-4:
            n = t.cross(Vector((1, 0, 0)))
        n.normalize()
        b = t.cross(n)
        rings.append([bm.verts.new(p + (n * math.cos(a) + b * math.sin(a)) * radii[i])
                      for a in (2 * math.pi * k / segs for k in range(segs))])
    for r0, r1 in zip(rings, rings[1:]):
        for k in range(segs):
            bm.faces.new((r0[k], r0[(k + 1) % segs], r1[(k + 1) % segs], r1[k]))
    if cap:
        bm.faces.new(list(reversed(rings[0])))
        bm.faces.new(rings[-1])

def ellipsoid(bm, centre, radii, rot=None, u=10, v=7):
    m = Matrix.Translation(centre)
    if rot is not None:
        m = m @ rot
    m = m @ Matrix.Diagonal((*radii, 1))
    bmesh.ops.create_uvsphere(bm, u_segments=u, v_segments=v, radius=1.0, matrix=m)

def box_uv(ob, scale=2.2):
    """Per-face box projection, so nothing gets smeared along a limb."""
    me = ob.data
    uv = me.uv_layers.new(name="UVMap")
    for p in me.polygons:
        n = p.normal
        a = (abs(n.x), abs(n.y), abs(n.z))
        for li in p.loop_indices:
            co = ob.matrix_world @ me.vertices[me.loops[li].vertex_index].co
            if a[2] >= a[0] and a[2] >= a[1]:
                uv.data[li].uv = (co.x * scale, co.y * scale)
            elif a[0] >= a[1]:
                uv.data[li].uv = (co.y * scale, co.z * scale)
            else:
                uv.data[li].uv = (co.x * scale, co.z * scale)

def warped_angles(n, lo, hi, centre, width, boost, periodic):
    """n angles from lo to hi, packed densely around `centre`."""
    fine = np.linspace(lo, hi, 4001)
    d = fine - centre
    if periodic:
        d = (d + math.pi) % (2 * math.pi) - math.pi
    rho = 1 + boost * np.exp(-(d / width) ** 2)
    cdf = np.concatenate([[0], np.cumsum((rho[1:] + rho[:-1]) / 2)])
    cdf /= cdf[-1]
    k = np.arange(n) / (n if periodic else n - 1)
    return np.interp(k, cdf, fine)

def head_frame():
    """Unit directions of a lat/long sphere, denser over the face."""
    lons = warped_angles(112, -math.pi, math.pi, -math.pi / 2, 0.75, 2.2, True)
    lats = warped_angles(92, -math.pi / 2, math.pi / 2, -0.25, 0.75, 1.8, False)[1:-1]
    return lons, lats


# ----------------------------------------------------------------------------- the face, as 2D fields
# Head-local coordinates before scaling by HS: x across, z up, the face looks toward -y.
# Narrow tall sockets leaning outward at the top, no nose (two slits), and a long hanging
# mouth that takes up most of the lower face, wider at the bottom.
SOCK = dict(cx=0.038, cz=0.040, rx=0.0115, rz=0.027, tilt=0.34)
MOUTH = dict(cz=-0.128, rx=0.034, rz=0.094)

def mouth_w(t):
    return 1 - 0.12 * t                          # wider toward the bottom: it hangs

def socket_coords(X, Z):
    ax = np.abs(X)
    dx, dz = ax - SOCK["cx"], Z - SOCK["cz"]
    c, s = math.cos(SOCK["tilt"]), math.sin(SOCK["tilt"])
    u, v = dx * c - dz * s, dx * s + dz * c
    e = np.sqrt((u / SOCK["rx"]) ** 2 + (v / SOCK["rz"]) ** 2)
    up = (v / SOCK["rz"]) / (e + 1e-6)
    return e, up, u / SOCK["rx"]

def mouth_coords(X, Z):
    t = (Z - MOUTH["cz"]) / MOUTH["rz"]
    rx = MOUTH["rx"] * mouth_w(t)
    e = np.sqrt((X / rx) ** 2 + t ** 2)
    ang = np.arctan2(t, X / rx)
    return e, ang

def bowl(e, depth, inner):
    return depth * (1 - smoothstep(inner, 1.0, e)) * (1 - 0.18 * np.minimum(e, 1) ** 2)

def ellipse_arc(e, a0, a1, n=14):
    out = []
    c, s = math.cos(SOCK["tilt"]), math.sin(SOCK["tilt"])
    for k in range(n):
        a = math.radians(a0 + (a1 - a0) * k / (n - 1))
        u, v = math.cos(a) * SOCK["rx"] * e, math.sin(a) * SOCK["rz"] * e
        dx, dz = u * c + v * s, -u * s + v * c
        out.append((SOCK["cx"] + dx, SOCK["cz"] + dz))
    return out

# crease: points (|x|, z), geometric depth, geometric width, darkness, fold side
CREASES = [
    # long folds from the inner corner of each socket down beside the mouth to the chin
    ([(0.022, 0.006), (0.029, -0.020), (0.043, -0.050), (0.052, -0.090), (0.056, -0.136), (0.052, -0.184), (0.041, -0.232)], 0.008, 0.0050, 1.0, 1),
    # from the outer corner of each socket down the cheek
    ([(0.064, 0.006), (0.072, -0.034), (0.074, -0.084), (0.068, -0.134), (0.058, -0.180)], 0.006, 0.0050, 0.8, -1),
    # bags under the sockets
    (ellipse_arc(1.45, 205, 335), 0.004, 0.0032, 0.75, -1),
    (ellipse_arc(1.95, 220, 320), 0.003, 0.0030, 0.45, -1),
    # lid fold above the sockets
    (ellipse_arc(1.9, 50, 135), 0.003, 0.0030, 0.45, 1),
    # skin pulled tight beside the mouth
    ([(0.040, -0.040), (0.046, -0.080), (0.047, -0.125), (0.045, -0.170)], 0.003, 0.0030, 0.5, 1),
    # forehead: furrows going up (texture only)
    # stretched chin
    ([(0.018, -0.234), (0.026, -0.254)], 0.0, 0.0025, 0.45, 1),
]
_CREASE_CACHE = {}
def creases(X, Z):
    hit = _CREASE_CACHE.get(id(X))
    if hit is not None and hit[0] is X:
        return hit[1]
    AX = np.abs(X)
    out = []
    for i, (pts, depth, width, dark, fold) in enumerate(CREASES):
        d, side, t = curve_dist(AX, Z, pts)
        taper = np.sin(math.pi * np.clip(t, 0, 1)) ** 0.5
        wob = 1 + 0.35 * (vnoise(X * 40 + i, Z * 40, 1.0, 50 + i) - 0.5)
        out.append((d * wob, side, taper, depth, width, dark, fold))
    _CREASE_CACHE.clear()
    _CREASE_CACHE[id(X)] = (X, out)
    return out

def hole_mask(X, Z):
    es, _, _ = socket_coords(X, Z)
    em, _ = mouth_coords(X, Z)
    return np.maximum(1 - smoothstep(0.95, 1.02, es), 1 - smoothstep(0.95, 1.02, em))

def g2(X, Z, cx, cz, sx, sz):
    return np.exp(-(((X - cx) / sx) ** 2 + ((Z - cz) / sz) ** 2))

def face_height(X, Z):
    """Sculpted height of the face, positive = toward the viewer."""
    AX = np.abs(X)
    es, up, _ = socket_coords(X, Z)
    em, _ = mouth_coords(X, Z)
    h = np.zeros(X.shape)
    h += 0.0015 * np.exp(-((es - 1.15) / 0.12) ** 2)                                  # socket rims
    h += 0.016 * np.exp(-((es - 1.75) / 0.45) ** 2) * smoothstep(-0.1, 0.7, up)       # heavy brow ridges
    h += 0.003 * g2(X, Z, 0, 0.098, 0.025, 0.02)                                      # brow knot
    h += 0.005 * np.exp(-(X / 0.011) ** 2) * smoothstep(0.085, 0.05, Z) * smoothstep(-0.012, 0.01, Z)  # flat bridge, no nose
    h -= 0.008 * g2(AX, Z, 0.0075, -0.017, 0.0026, 0.0075)                            # two slits where a nose should be
    h += 0.004 * np.exp(-((em - 1.06) / 0.06) ** 2)                                   # thin pulled-back lip rim
    h += 0.013 * np.exp(-((em - 1.6) / 0.5) ** 2)                                     # the mouth pushes out
    h -= 0.018 * g2(AX, Z, 0.068, -0.072, 0.020, 0.050)                               # hollow cheeks
    h += 0.007 * g2(AX, Z, 0.068, -0.002, 0.018, 0.012)                               # cheekbones
    h -= 0.010 * g2(AX, Z, 0.085, 0.055, 0.020, 0.035)                                # temples
    h += 0.004 * g2(X, Z, 0, -0.245, 0.020, 0.010)                                    # chin
    for d, side, taper, depth, width, dark, fold in creases(X, Z):
        if depth <= 0:
            continue
        h -= depth * np.exp(-(d / width) ** 2) * taper
        h += depth * 0.55 * np.exp(-((d - 1.7 * width) / width) ** 2) * taper * np.where(side == fold, 1.0, 0.25)
    h *= 1 - hole_mask(X, Z)
    h -= bowl(es, 0.050, 0.85)                                                        # deep sockets
    h -= 0.010 * np.exp(-((es - 1.25) / 0.35) ** 2) * smoothstep(0.4, -0.4, up)      # sunken under the eyes
    h -= bowl(em, 0.110, 0.88)                                                        # the mouth
    return h

# ----------------------------------------------------------------------------- textures
FX0, FX1, FZ0, FZ1 = -0.120, 0.120, -0.270, 0.180   # area of the head covered by the face texture

def skin_tone(X, Y, freq_scale, periodic, contrast=1.0):
    """Cold, bloodless grey skin, shared by the head and the body."""
    n1 = fbm(X, Y, 6 * freq_scale, 11, 4, periodic)
    n2 = fbm(X, Y, 3 * freq_scale, 23, 3, periodic)
    n3 = fbm(X, Y, 48 * freq_scale, 31, 2, periodic)
    base = np.stack([0.76 + 0 * X, 0.74 + 0 * X, 0.66 + 0 * X], -1)               # dead, waxy, faintly yellow
    base = base * (1 - 0.16 * contrast + 0.24 * contrast * n1)[..., None] * (0.95 + 0.10 * n3)[..., None]
    blotch = contrast * smoothstep(0.52, 0.8, n2)[..., None]                     # livid purple-red patches
    base = base * (1 - 0.32 * blotch) + np.array([0.46, 0.30, 0.36]) * 0.32 * blotch
    sick = smoothstep(0.4, 0.75, fbm(X, Y, 2 * freq_scale, 41, 3, periodic))[..., None]
    base = base * (1 - 0.14 * sick) + np.array([0.55, 0.58, 0.48]) * 0.14 * sick
    return base

def veins(X, Y, freq, seed, periodic):
    r = 1 - np.abs(2 * fbm(X, Y, freq, seed, 4, periodic) - 1)
    return smoothstep(0.90, 0.985, r)

def make_face_textures(W=512, H=1024):
    """Left half: the front of the head (front projection). Right half: the back of the head."""
    xs = FX0 + (np.arange(W) + 0.5) / W * (FX1 - FX0)
    zs = FZ0 + (np.arange(H) + 0.5) / H * (FZ1 - FZ0)
    X, Z = np.meshgrid(xs, zs)
    du, dv = (FX1 - FX0) / W, (FZ1 - FZ0) / H
    AX = np.abs(X)
    tone = skin_tone(X * 2.3, Z * 2.3, 1.0, False)
    vein = veins(X * 2.3, Z * 2.3, 9, 61, False) * (0.5 + 0.5 * smoothstep(0.02, 0.14, Z))
    tone = tone * (1 - 0.28 * vein[..., None]) + np.array([0.30, 0.33, 0.45]) * 0.28 * vein[..., None]
    pores = fbm(X * 2.3, Z * 2.3, 160, 71, 2) - 0.5
    back_h = pores * 0.00012 + blur(vein, 1.5) * 0.00018

    es, up, _ = socket_coords(X, Z)
    em, mang = mouth_coords(X, Z)
    hgeo = face_height(X, Z)
    holes = hole_mask(X, Z)
    hf = back_h.copy()
    dark = np.zeros(X.shape)
    for d, side, taper, depth, width, dk, fold in creases(X, Z):
        hf -= 0.0012 * np.exp(-(d / 0.0016) ** 2) * taper
        dark += dk * (0.45 * np.exp(-(d / 0.0028) ** 2) + 0.25 * np.exp(-(d / 0.010) ** 2)) * taper
    under = smoothstep(1.1, 1.3, es) * (1 - smoothstep(1.7, 2.1, es)) * smoothstep(0.2, -0.5, up)
    hf -= 0.00025 * (np.sin(es * 2 * math.pi * 7) * 0.5 + 0.5) ** 3 * under
    stretch = smoothstep(1.05, 1.2, em) * (1 - smoothstep(1.6, 2.2, em))
    hf -= 0.00035 * (np.sin(mang * 40 + 3 * vnoise(X * 30, Z * 30, 1, 5)) * 0.5 + 0.5) ** 4 * stretch
    fh = smoothstep(0.09, 0.11, Z) * (1 - smoothstep(0.15, 0.175, Z)) * (1 - smoothstep(0.06, 0.09, AX))
    hf -= 0.00025 * (np.sin(Z * 2 * math.pi * 38 + 6 * vnoise(X * 20, Z * 20, 1, 9)) * 0.5 + 0.5) ** 4 * fh
    cav = np.clip(blur(hgeo, 0.007 / du) - hgeo, 0, None)
    dark += np.clip(cav / 0.006, 0, 1) * 0.55
    dark += 0.85 * (1 - smoothstep(0.98, 1.25, es)) + 0.30 * (1 - smoothstep(1.2, 2.6, es)) * smoothstep(0.6, -0.6, up)
    dark += 0.30 * g2(AX, Z, 0.068, -0.075, 0.020, 0.045)                            # hollow cheeks
    dark += 0.25 * g2(AX, Z, 0.085, 0.055, 0.018, 0.035)                             # temples
    dark += 0.95 * g2(AX, Z, 0.0075, -0.017, 0.003, 0.008)                           # nose slits
    dark += 0.20 * smoothstep(-0.235, -0.26, Z)                                      # under the chin
    dark = np.clip(dark + 0.08 * (fbm(X * 2.3, Z * 2.3, 30, 81, 3) - 0.5), 0, 1)
    light = (0.12 * g2(X, Z, 0, 0.13, 0.05, 0.04) + 0.10 * g2(AX, Z, 0.068, -0.004, 0.016, 0.010)
             + 0.08 * g2(X, Z, 0, -0.245, 0.02, 0.01) + 0.06 * np.exp(-((em - 1.10) / 0.06) ** 2))
    # wet, dark gums and old stains at the mouth: a dark red-brown rim, and streaks running
    # down from the lower lip and the corners
    rim = np.exp(-((em - 1.05) / 0.07) ** 2)
    streak = smoothstep(0.50, 0.85, fbm(X * 3, Z * 0.15, 70, 131, 3)) * smoothstep(MOUTH["cz"] - 0.25 * MOUTH["rz"], MOUTH["cz"] - 0.95 * MOUTH["rz"], Z)
    streak *= (1 - smoothstep(0.02, 0.045, AX)) * (1 - smoothstep(-0.20, -0.27, Z) * 0.4)
    stain = np.clip(0.75 * rim + 0.65 * streak + 0.25 * smoothstep(1.6, 1.0, em), 0, 1) * (1 - holes)
    dark = np.maximum(dark, holes)
    k = dark[..., None]
    front = tone * (1 + light[..., None]) * (1 - 0.9 * k) + np.array([0.20, 0.15, 0.17]) * 0.06 * k
    front = front * (1 - 0.75 * stain[..., None]) + np.array([0.22, 0.07, 0.06]) * 0.75 * stain[..., None]
    hf -= 0.00015 * streak
    back = tone
    color = np.concatenate([front, back], axis=1)
    hfront = hf * (1 - holes)
    nrm = np.concatenate([normal_from_height(hfront, du, dv), normal_from_height(back_h, du, dv)], axis=1)
    return save_image("monster_face", color), save_image("monster_face_n", nrm, True)

def make_body_textures(n=512):
    """Tileable skin for the body: mottling, veins, fine wrinkles."""
    u = (np.arange(n) + 0.5) / n
    U, V = np.meshgrid(u, u)
    tone = skin_tone(U, V, 1.0, True, 0.6) * 0.92
    vein = veins(U, V, 4, 91, True)
    vein2 = veins(U, V, 8, 97, True) * 0.6
    vv = np.maximum(vein, vein2)
    tone = tone * (1 - 0.24 * vv[..., None]) + np.array([0.32, 0.36, 0.50]) * 0.24 * vv[..., None]
    wr = smoothstep(0.6, 0.9, fbm(U, V, 16, 7, 3, True))
    hgt = 0.0005 * blur(vv, 2, True) + 0.00012 * (fbm(U, V, 64, 13, 2, True) - 0.5) - 0.00014 * wr
    cav = np.clip(blur(hgt, 6, True) - hgt, 0, None)
    tone = tone * (1 - np.clip(cav / 0.0002, 0, 1)[..., None] * 0.25)
    nrm = normal_from_height(hgt, 0.45 / n, 0.45 / n, 1.0, True)
    return save_image("monster_skin", tone), save_image("monster_skin_n", nrm, True)

MAT = {}
def setup_materials():
    fc, fn = make_face_textures()
    bc, bn = make_body_textures()
    MAT["face"] = material("face", (1, 1, 1), 0.42, fc, fn, 1.0)
    MAT["skin"] = material("skin", (1, 1, 1), 0.46, bc, bn, 1.0)
    MAT["nail"] = material("nail", (0.09, 0.075, 0.06), 0.28)
    MAT["teeth"] = material("teeth", (0.44, 0.40, 0.30), 0.35)
    MAT["mouth"] = material("mouth", (0, 0, 0), 1.0, spec=0.0)
    MAT["socket"] = material("socket", (0, 0, 0), 1.0, spec=0.0)
    MAT["eye"] = material("eye", (1, 1, 1), 0.3, emit=((1.0, 0.98, 0.94), 8.0))


# ----------------------------------------------------------------------------- body
def skin_object(name, pts, radii, edges, root):
    """Stick figure -> skin modifier -> subdivided smooth mesh."""
    me = bpy.data.meshes.new(name + "_stick")
    me.from_pydata([tuple(p) for p in pts], edges, [])
    ob = bpy.data.objects.new(name + "_stick", me)
    col.objects.link(ob)
    ob.modifiers.new("skin", "SKIN")
    for i, r in enumerate(radii):
        me.skin_vertices[0].data[i].radius = r
        me.skin_vertices[0].data[i].use_root = (i == root)
    sub = ob.modifiers.new("sub", "SUBSURF")
    sub.levels = 2
    dg = bpy.context.evaluated_depsgraph_get()
    out_me = bpy.data.meshes.new_from_object(ob.evaluated_get(dg))
    bpy.data.objects.remove(ob)
    out = bpy.data.objects.new(name, out_me)
    col.objects.link(out)
    for p in out_me.polygons:
        p.use_smooth = True
    out_me.materials.append(MAT["skin"])
    box_uv(out)
    return out

TORSO_BONES = {"hips", "spine", "chest", "neck", "head"}
def build_torso():
    pts, radii, edges = [], [], []
    def v(pos, r):
        pts.append(Vector(pos)); radii.append(r if isinstance(r, tuple) else (r, r)); return len(pts) - 1
    pelvis = v(P("pelvis"), (0.112, 0.085)); low = v(P("pelvis") + Vector((0, 0.0, -0.07)), (0.080, 0.068))
    waist = v(P("spine1"), (0.070, 0.056)); mid = v(P("mid"), (0.100, 0.080))
    chest = v(P("chest"), (0.128, 0.094)); upper = v((0, 0.035, 2.005), (0.108, 0.078))
    nb = v((0, -0.01, 2.08), 0.050); nm = v((0, -0.065, 2.145), 0.036)
    nh = v(P("head"), 0.033)
    edges += [(low, pelvis), (pelvis, waist), (waist, mid), (mid, chest), (chest, upper), (upper, nb), (nb, nm), (nm, nh)]
    for s in (1, -1):
        trap = v(Vector((0.085 * s, 0.045, 2.065)), 0.042)              # trapezius: the shoulders hunch up round the neck
        yoke = v(P("shoulder", s) + Vector((-0.015 * s, 0, 0.0)), 0.048)
        glute = v(Vector((0.058 * s, 0.085, 1.27)), 0.058)
        edges += [(upper, trap), (trap, yoke), (pelvis, glute)]
        hip = v(P("hip", s), 0.072); t1 = v(P("hip", s).lerp(P("knee", s), 0.25) + Vector((0, -0.008, 0)), 0.062)
        tm = v(P("hip", s).lerp(P("knee", s), 0.55), 0.049)
        ak = v(P("hip", s).lerp(P("knee", s), 0.85), 0.037); kn = v(P("knee", s), 0.043)
        calf = v(P("knee", s).lerp(P("ankle", s), 0.24) + Vector((0, 0.016, 0)), 0.047)
        sl = v(P("knee", s).lerp(P("ankle", s), 0.62), 0.028); an = v(P("ankle", s), 0.026)
        edges += [(low, hip), (hip, t1), (t1, tm), (tm, ak), (ak, kn), (kn, calf), (calf, sl), (sl, an)]
    ob = skin_object("torso", pts, radii, edges, pelvis)
    weight_auto(ob, allowed=TORSO_BONES | {n for n in SEG if n.split(".")[0] in ("thigh", "shin", "foot")})
    return ob

def build_arm(s, tag):
    pts, radii, edges = [], [], []
    def v(pos, r):
        pts.append(Vector(pos)); radii.append(r if isinstance(r, tuple) else (r, r)); return len(pts) - 1
    sh, el, wr = P("shoulder", s), P("elbow", s), P("wrist", s)
    a = v(sh, 0.050); a2 = v(sh.lerp(el, 0.18), 0.040); b = v(sh.lerp(el, 0.45), 0.031); c = v(sh.lerp(el, 0.85), 0.025); d = v(el, 0.032)
    e = v(el.lerp(wr, 0.25), 0.030); f = v(el.lerp(wr, 0.65), 0.021); g = v(wr, 0.018)
    edges += [(a, a2), (a2, b), (b, c), (c, d), (d, e), (e, f), (f, g)]
    ob = skin_object(f"arm.{tag}", pts, radii, edges, a)
    weight_auto(ob, allowed={"chest", f"upperarm.{tag}", f"forearm.{tag}", f"hand.{tag}"})
    return ob

def build_bones_showing(meshes):
    """Ribs, sternum, collarbones, spine, shoulder blades, hip bones and knobby joints pushing
    through the skin, placed by casting rays from inside the body to find the skin."""
    from mathutils.bvhtree import BVHTree
    vs, fs, off = [], [], 0
    for m in meshes:
        vs += [m.matrix_world @ v.co for v in m.data.vertices]
        fs += [tuple(i + off for i in p.vertices) for p in m.data.polygons]
        off += len(m.data.vertices)
    bvh = BVHTree.FromPolygons(vs, fs)
    spine_pts = [P("pelvis"), P("spine1"), P("mid"), P("chest"), Vector((0, 0.035, 2.005)), Vector((0, -0.01, 2.08)), Vector((0, -0.065, 2.145)), P("head")]
    def centre(z):
        for a, b in zip(spine_pts, spine_pts[1:]):
            if a.z <= z <= b.z:
                return a.lerp(b, (z - a.z) / (b.z - a.z))
        return spine_pts[0] if z < spine_pts[0].z else spine_pts[-1]
    def surf(c, d, inset, maxd=0.18, strict=False):
        d = d.normalized()
        hit = bvh.ray_cast(c, d, maxd)
        if hit[0] is None:
            if strict:
                return None, None
            return c + d * (maxd * 0.6 - inset), d
        return hit[0] - d * inset, hit[1]
    def oriented(normal, along=Vector((0, 0, 1))):
        z = normal.normalized()
        x = along.cross(z); x.normalize()
        y = z.cross(x)
        return Matrix((x, y, z)).transposed().to_4x4()
    out = []
    bm = bmesh.new()
    for i in range(8):                                  # ribs, from the spine round to the sternum
        z0 = 2.00 - i * 0.047
        r = 0.0085 if i < 6 else 0.007
        a1 = 160 if i < 6 else 125 - (i - 6) * 20
        for sd in (1, -1):
            pts = []
            for k in range(13):
                a = math.radians(25 + (a1 - 25) * k / 12)
                z = z0 - 0.075 * (a / math.pi) ** 1.3
                p, _ = surf(centre(z), Vector((sd * math.sin(a), math.cos(a), 0)), r * 0.6, 0.16)
                pts.append(p)
            tube(bm, pts, [r * 0.4] + [r * 0.9] * 11 + [r * 0.4], 6)
    st = [surf(centre(z), Vector((0, -1, 0)), 0.006)[0] for z in (1.99, 1.93, 1.86, 1.79)]
    for sd in (1, -1):                                  # neck tendons, from behind the jaw to the top of the sternum
        pts = [surf(centre(z), Vector((sd * (0.75 - 0.5 * (2.17 - z) / 0.17), -0.6, 0)), 0.006, 0.12)[0] for z in (2.17, 2.12, 2.07, 2.02)]
        tube(bm, pts, [0.008, 0.011, 0.011, 0.007], 7)
    tube(bm, st, [0.010, 0.011, 0.010, 0.005], 6)       # sternum
    for sd in (1, -1):                                  # collarbones
        cc = Vector((0, 0.04, 1.95))
        pts = []
        for t in (0.0, 0.25, 0.5, 0.75, 1.0):
            target = Vector((sd * (0.02 + 0.14 * t), -0.04 + 0.06 * t, 2.02 + 0.02 * t - 0.012 * math.sin(math.pi * t)))
            pts.append(surf(cc, target - cc, 0.005, 0.3)[0])
        tube(bm, pts, [0.007, 0.0095, 0.009, 0.0095, 0.007], 6)
    # hip crests: a sharp ridge round the top of the pelvis
    for sd in (1, -1):
        crest = []
        for k, a in enumerate((40, 70, 100, 130, 150)):
            aa = math.radians(a)
            crest.append(surf(centre(1.40 - 0.03 * k / 4), Vector((sd * math.sin(aa), math.cos(aa), 0)), 0.006)[0])
        tube(bm, crest, [0.005, 0.011, 0.012, 0.010, 0.005], 6)
    rib = new_obj("ribs", bm, "skin"); box_uv(rib)
    weight_auto(rib, allowed=TORSO_BONES - {"head"}); out.append(rib)

    bm = bmesh.new()
    z = 1.28
    while z < 2.24:                                     # vertebrae: knuckles down the back and neck
        c = centre(z)
        p, n = surf(c, Vector((0, 1, 0.05 if z < 2.05 else -0.4)), 0.009)
        big = 1.0 if z < 2.05 else 0.7
        ellipsoid(bm, p, (0.017 * big, 0.014 * big, 0.019 * big), oriented(n), u=8, v=6)
        z += 0.042 if z < 2.05 else 0.035
    for sd in (1, -1):                                  # shoulder blades
        p, n = surf(centre(1.92), Vector((sd * 0.6, 0.8, 0.05)), 0.007)
        m = Matrix.Translation(p) @ oriented(n) @ Matrix.Rotation(math.radians(-14 * sd), 4, "Z")
        bmesh.ops.create_uvsphere(bm, u_segments=12, v_segments=8, radius=1.0, matrix=m @ Matrix.Diagonal((0.036, 0.066, 0.011, 1)))
        edge = [surf(centre(z), Vector((sd * 0.28, 1, 0)), 0.004)[0] for z in (1.97, 1.91, 1.85, 1.80)]
        tube(bm, edge, [0.003, 0.0065, 0.006, 0.003], 5)
    spine = new_obj("vertebrae", bm, "skin"); box_uv(spine)
    weight_auto(spine, allowed=TORSO_BONES); out.append(spine)

    bm = bmesh.new()
    def knob(joint, d, radii, inset, maxd=0.12):
        p, n = surf(joint, d, inset, maxd, True)
        if p is None:
            return
        ellipsoid(bm, p, radii, oriented(n, Vector((0, 0, 1)) if abs(n.z) < 0.9 else Vector((0, 1, 0))), u=10, v=7)
    for sd in (1, -1):
        el, wr, kn, an, sh = P("elbow", sd), P("wrist", sd), P("knee", sd), P("ankle", sd), P("shoulder", sd)
        knob(el, Vector((sd * 0.3, 1, -0.35)), (0.016, 0.013, 0.017), 0.008)          # point of the elbow
        knob(wr, Vector((sd * 0.8, 0.3, 0)), (0.011, 0.012, 0.009), 0.006)            # wrist bone
        knob(kn, Vector((0, -1, 0.1)), (0.023, 0.026, 0.014), 0.010)                  # kneecap
        knob(an, Vector((sd, 0, 0)), (0.012, 0.014, 0.009), 0.005)                    # ankle bones
        knob(an, Vector((-sd, 0, 0)), (0.011, 0.013, 0.008), 0.005)
        knob(sh, Vector((sd, -0.1, 0.6)), (0.022, 0.022, 0.012), 0.008)               # shoulder
        fdir = (wr - el).normalized()
        ul = [surf(el.lerp(wr, t), Vector((sd * 0.7, 0.7, 0)) - fdir * fdir.dot(Vector((sd * 0.7, 0.7, 0))), 0.004, 0.06)[0] for t in (0.1, 0.4, 0.7, 0.92)]
        tube(bm, ul, [0.004, 0.0065, 0.006, 0.004], 5)                               # ulna ridge
        tb = [surf(kn.lerp(an, t), Vector((0, -1, 0)), 0.005, 0.07)[0] for t in (0.12, 0.45, 0.85)]
        tube(bm, tb, [0.006, 0.008, 0.005], 5)                                        # shin bone
    knobs = new_obj("knobs", bm, "skin"); box_uv(knobs)
    weight_auto(knobs, allowed={n for n in SEG if "." in n}); out.append(knobs)
    return out

# ----------------------------------------------------------------------------- head
def head_base(D):
    """Long, narrow, backswept skull and a long jaw."""
    dx, dy, dz = D[:, 0], D[:, 1], D[:, 2]
    RX, RY, RZ, ZC = 0.090, 0.108, 0.215, -0.040
    z = ZC + RZ * dz
    back = 1.12 * (1 + 0.32 * smoothstep(-0.06, 0.13, z))          # the cranium sweeps back
    y = np.where(dy < 0, -RY * np.abs(dy) ** 0.8, RY * back * dy)
    taper = smoothstep(0.0, -0.25, z)
    x = RX * dx * (1 - 0.38 * taper) * (1 + 0.06 * smoothstep(0.02, 0.13, z))
    y = np.where(y > 0, y * (1 - 0.50 * taper), y * (1 - 0.12 * taper))
    z = z + 0.035 * np.maximum(dy, 0) ** 2 * smoothstep(0.0, 0.15, z)  # and lifts at the back
    return np.stack([x, y, z], 1)

def build_head():
    lons, lats = head_frame()
    NU, NV = len(lons), len(lats)
    LA, LO = np.meshgrid(lats, lons, indexing="ij")
    D = np.stack([np.cos(LA) * np.cos(LO), np.cos(LA) * np.sin(LO), np.sin(LA)], -1).reshape(-1, 3)
    D = np.concatenate([D, [[0, 0, -1], [0, 0, 1]]])
    B = head_base(D)
    X, Y, Z = B[:, 0].copy(), B[:, 1].copy(), B[:, 2].copy()
    NVERT = len(D)
    idx = lambda i, j: i * NU + (j % NU)
    fidx = []
    for i in range(NV - 1):
        for j in range(NU):
            fidx.append((idx(i, j), idx(i, j + 1), idx(i + 1, j + 1), idx(i + 1, j)))
    for j in range(NU):
        fidx.append((idx(0, j + 1), idx(0, j), NVERT - 2))
        fidx.append((idx(NV - 1, j), idx(NV - 1, j + 1), NVERT - 1))
    CONT = 0.97
    fmat = [0] * len(fidx)
    for kind, mi in (("socket", 1), ("mouth", 2)):
        ev = socket_coords(X, Z)[0] if kind == "socket" else mouth_coords(X, Z)[0]
        inside = []
        for fi, f in enumerate(fidx):
            front = all(D[k, 1] < 0 for k in f)
            cxz = (np.array([X[list(f)].mean()]), np.array([Z[list(f)].mean()]))
            ec = (socket_coords(*cxz) if kind == "socket" else mouth_coords(*cxz))[0][0]
            inside.append(front and ec < CONT)
            if inside[-1]:
                fmat[fi] = mi
        vin, vout = set(), set()
        for f, ins in zip(fidx, inside):
            (vin if ins else vout).update(f)
        for k in vin & vout:                        # slide the boundary onto the contour
            if D[k, 1] >= 0:
                continue
            f = CONT / max(ev[k], 1e-4)
            if kind == "socket":
                sg = 1 if X[k] >= 0 else -1
                c, s_ = math.cos(SOCK["tilt"]), math.sin(SOCK["tilt"])
                dx, dz = abs(X[k]) - SOCK["cx"], Z[k] - SOCK["cz"]
                u, v = (dx * c - dz * s_) * f, (dx * s_ + dz * c) * f
                X[k] = sg * (SOCK["cx"] + c * u + s_ * v); Z[k] = SOCK["cz"] - s_ * u + c * v
            else:
                t = (Z[k] - MOUTH["cz"]) / MOUTH["rz"]
                xn = X[k] / (MOUTH["rx"] * mouth_w(t))
                t, xn = t * f, xn * f
                Z[k] = MOUTH["cz"] + t * MOUTH["rz"]; X[k] = xn * MOUTH["rx"] * mouth_w(t)
    wf = smoothstep(0.15, -0.45, D[:, 1])
    h = face_height(X, Z)
    Y = Y - h * wf
    side = (0.010 * g2(np.abs(X), Z, 0.085, 0.055, 0.02, 0.035) + 0.009 * g2(np.abs(X), Z, 0.075, -0.08, 0.02, 0.05)) * np.abs(D[:, 0])
    X = X - np.sign(X) * side
    V = np.stack([X, Y, Z], 1)

    bm = bmesh.new()
    verts = [bm.verts.new(Vector(p)) for p in V]
    bm.verts.index_update()
    for f, mi in zip(fidx, fmat):
        bf = bm.faces.new([verts[k] for k in f])
        bf.material_index = mi
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    uvl = bm.loops.layers.uv.new("UVMap")
    bm.normal_update()
    for f in bm.faces:
        cx, cz = np.array([f.calc_center_median().x]), np.array([f.calc_center_median().z])
        near_hole = min(socket_coords(cx, cz)[0][0], mouth_coords(cx, cz)[0][0]) < 1.25
        front = f.material_index > 0 or (f.normal.y < 0.02 and f.normal.y < -0.45 * abs(f.normal.z)) or (near_hole and f.normal.y < 0.3)
        for l in f.loops:
            u = (l.vert.co.x - FX0) / (FX1 - FX0) * 0.5
            v = (l.vert.co.z - FZ0) / (FZ1 - FZ0)
            l[uvl].uv = (u if front else u + 0.5, v)
    for v in bm.verts:
        v.co = hw(*v.co)
    ob = new_obj("head", bm, "face")
    ob.data.materials.append(MAT["socket"]); ob.data.materials.append(MAT["mouth"])
    gh, gj = ob.vertex_groups.new(name="head"), ob.vertex_groups.new(name="jaw")
    for vtx, (x, y, z) in zip(ob.data.vertices, V):
        wj = float(smoothstep(-0.105, -0.150, z) * smoothstep(0.07, -0.03, y))
        if wj < 1:
            gh.add([vtx.index], 1 - wj, "REPLACE")
        if wj > 0:
            gj.add([vtx.index], wj, "REPLACE")
    return ob, {"V": V, "D": D}

def face_landmarks(info):
    V, D = info["V"], info["D"]
    front = D[:, 1] < 0
    out = {}
    for s in (1, -1):
        near = front & (np.hypot(V[:, 0] - s * SOCK["cx"], V[:, 2] - SOCK["cz"]) < 0.008)
        ybot = V[near, 1].max()
        out[s] = Vector((s * SOCK["cx"], ybot - 0.012, SOCK["cz"]))
    mid = front & (np.abs(V[:, 0]) < 0.03) & (V[:, 2] > -0.10) & (V[:, 2] < 0.0)
    out["face"] = Vector((0, V[mid, 1].min(), -0.05))
    return out

def build_head_parts():
    head, info = build_head()
    lm = face_landmarks(info)
    parts = [head]
    bm = bmesh.new()
    for s in (1, -1):
        bmesh.ops.create_uvsphere(bm, u_segments=8, v_segments=6, radius=0.0024 * HS, matrix=Matrix.Translation(hw(*lm[s])))
    eyes = new_obj("eyes", bm, "eye"); weight_rigid(eyes, "head"); parts.append(eyes)
    # crowded, crooked, human-looking teeth top and bottom, set in a mouth stretched far too long
    random.seed(9)
    V, D = info["V"], info["D"]
    front = D[:, 1] < 0
    em_all, ang_all = mouth_coords(V[:, 0], V[:, 2])
    rim = front & (em_all > 0.98) & (em_all < 1.12)
    bm = bmesh.new()
    def tooth(a, kk, length, wid, back=0.0):
        t = math.sin(a)
        rx = MOUTH["rx"] * mouth_w(t)
        x, z = math.cos(a) * rx * kk, MOUTH["cz"] + t * MOUTH["rz"] * kk
        sel = rim & (np.abs(np.angle(np.exp(1j * (ang_all - a)))) < 0.22)
        ylip = V[sel, 1].min() if sel.any() else -0.09
        base = Vector((x, ylip + 0.007 + back, z))
        inward = Vector((-x * 0.6, 0, MOUTH["cz"] - z)); inward.normalize()
        inward = Matrix.Rotation(random.uniform(-0.45, 0.45), 3, Vector((0, 1, 0))) @ inward     # crooked
        tip = base + inward * length + Vector((0, random.uniform(-0.002, 0.006), 0))
        mid = base.lerp(tip, 0.5) + Vector((0, -0.002, 0))
        tube(bm, [hw(*base), hw(*base.lerp(tip, 0.2)), hw(*mid), hw(*tip)], [wid * HS, wid * 0.95 * HS, wid * 0.6 * HS, 0.0002], 6)
    for lo_, hi_, cnt in ((30, 150, 15), (210, 330, 15)):            # upper and lower rows
        for i in range(cnt):
            a = math.radians(lo_ + (hi_ - lo_) * (i + 0.5) / cnt + random.uniform(-3, 3))
            if random.random() < 0.15:
                continue                                              # a gap
            mid = 1 - abs(i - (cnt - 1) / 2) / (cnt / 2)
            tooth(a, 0.985, random.uniform(0.010, 0.030) * (0.6 + 0.6 * mid), random.uniform(0.0026, 0.0036))
            if random.random() < 0.4:
                tooth(a + math.radians(4), 0.93, random.uniform(0.006, 0.014), 0.0024, 0.007)   # a second, crowded row
    for lo_, hi_, cnt in ((-25, 25, 3), (155, 205, 3)):                # a few small ones down the long sides
        for i in range(cnt):
            if random.random() < 0.4:
                continue
            a = math.radians(lo_ + (hi_ - lo_) * (i + 0.5) / cnt)
            tooth(a, 0.985, random.uniform(0.006, 0.011), 0.0024)
    teeth = new_obj("teeth", bm, "teeth")
    gh, gj = teeth.vertex_groups.new(name="head"), teeth.vertex_groups.new(name="jaw")
    cz_world = hw(0, 0, MOUTH["cz"]).z
    for vtx in teeth.data.vertices:
        (gj if vtx.co.z < cz_world else gh).add([vtx.index], 1.0, "REPLACE")
    parts.append(teeth)
    return parts, lm

# ----------------------------------------------------------------------------- hands and feet
def build_hands_feet():
    out = []
    for s, tag in ((1, "L"), (-1, "R")):
        skin_bm, nail_bm = bmesh.new(), bmesh.new()
        W, T = P("wrist", s), P("tip", s)
        fwd = (T - W).normalized()
        outv = Vector((0, -1, 0)); outv = (outv - fwd * outv.dot(fwd)).normalized()    # away from the chest
        side = Vector((s, 0, 0)); side = (side - fwd * side.dot(fwd) - outv * side.dot(outv)).normalized()
        frame = Matrix((side, fwd, outv)).transposed().to_4x4()
        ellipsoid(skin_bm, W + fwd * 0.045, (0.032, 0.055, 0.012), frame, u=12, v=8)      # bony palm
        for o, L, cl in ((-1.0, 0.150, 0.8), (-0.33, 0.185, 1.0), (0.33, 0.178, 0.9), (1.0, 0.145, 0.7)):
            d = (fwd + side * o * 0.16).normalized()
            base = W + fwd * 0.088 + side * o * 0.024
            k1 = base + d * L * 0.36 + outv * 0.022
            k2 = base + d * L * 0.68 + outv * 0.020 * cl
            tp = base + d * L * 0.90 - outv * 0.020 * cl
            pts = [base, base.lerp(k1, 0.5), k1, k1.lerp(k2, 0.5), k2, k2.lerp(tp, 0.5), tp]
            tube(skin_bm, pts, [0.0105, 0.0085, 0.0105, 0.0075, 0.0092, 0.0068, 0.0062], 7)
            nd = (d * 0.45 - outv * 0.9).normalized()
            n1 = tp + nd * 0.012; n2 = tp + nd * 0.030 + d * 0.004
            tube(nail_bm, [k2.lerp(tp, 0.8), tp + nd * 0.003, n1, n2], [0.0062, 0.0062, 0.004, 0.0004], 6)
        # thumb, from the outer edge of the palm, curling in
        tb = W + fwd * 0.030 + side * 0.026
        td = (fwd * 0.55 + side * 0.65 - outv * 0.1).normalized()
        t1 = tb + td * 0.045 + outv * 0.012; t2 = tb + td * 0.085 + fwd * 0.02; t3 = t2 + (fwd * 0.6 - side * 0.3 - outv * 0.4).normalized() * 0.03
        tube(skin_bm, [tb, t1, t2, t3], [0.012, 0.010, 0.0085, 0.0065], 7)
        tube(nail_bm, [t2.lerp(t3, 0.7), t3 + (t3 - t2).normalized() * 0.018], [0.006, 0.0004], 6)
        hs = new_obj(f"hand.{tag}", skin_bm, "skin"); box_uv(hs)
        hn = new_obj(f"nails.{tag}", nail_bm, "nail")
        for ob in (hs, hn):
            weight_rigid(ob, f"hand.{tag}"); out.append(ob)
        # long narrow feet with long toes
        skin_bm, nail_bm, sole_bm = bmesh.new(), bmesh.new(), bmesh.new()
        A, T = P("ankle", s), P("toe", s)
        f2 = (T - A); f2.z = 0; f2.normalize()
        sd2 = Vector((s, 0, 0))
        fr = Matrix((sd2, f2, Vector((0, 0, 1)))).transposed().to_4x4()
        ellipsoid(sole_bm, Vector((A.x, A.y + 0.01, 0.045)), (0.030, 0.045, 0.040), fr, u=10, v=8)              # heel
        ellipsoid(sole_bm, A.lerp(T, 0.55) * Vector((1, 1, 0)) + Vector((0, 0, 0.030)), (0.040, 0.115, 0.028), fr, u=12, v=8)
        for o, L in ((-1.0, 0.095), (-0.5, 0.085), (0.0, 0.078), (0.5, 0.068), (1.0, 0.058)):
            d = (f2 + sd2 * o * 0.12).normalized()
            base = Vector((T.x, T.y, 0.022)) + sd2 * o * 0.026 * s * s - f2 * 0.02
            p1 = base + d * L * 0.45 + Vector((0, 0, 0.016)); p2 = base + d * L; p2.z = 0.010
            tube(skin_bm, [base, base.lerp(p1, 0.5), p1, p2], [0.011 if o != -1.0 else 0.013, 0.008, 0.0095, 0.0065], 6)
            tube(nail_bm, [p1.lerp(p2, 0.8), p2 + d * 0.016 + Vector((0, 0, -0.005))], [0.0058, 0.0004], 5)
        fs = new_obj(f"foot.{tag}", skin_bm, "skin"); box_uv(fs)
        fn = new_obj(f"toenails.{tag}", nail_bm, "nail")
        for ob in (fs, fn):
            weight_rigid(ob, f"foot.{tag}"); out.append(ob)
        SOLES.append(new_obj(f"sole.{tag}", sole_bm, "skin"))        # blended into the legs with the body
    return out
SOLES = []

LANDMARKS = {}
def build_generated():
    head_parts, lm = build_head_parts()
    LANDMARKS.update(lm)
    torso = build_torso()
    arms = [build_arm(1, "L"), build_arm(-1, "R")]
    hands_feet = build_hands_feet()
    body = blend_body(torso, arms, build_bones_showing([torso] + arms) + SOLES)
    parts = [body] + head_parts + hands_feet
    return join(parts)

def blend_body(torso, arms, extras):
    """Voxel-remesh the torso, legs, arms and the bones under the skin into one surface, so the
    joins melt together like real anatomy, then decimate and re-weight it. Each vertex is
    weighted only to the bones of the part it came from (so the chest never follows a forearm)."""
    from mathutils.bvhtree import BVHTree
    def bvh_of(o):
        return BVHTree.FromPolygons([o.matrix_world @ v.co for v in o.data.vertices], [tuple(p.vertices) for p in o.data.polygons])
    regions = [(bvh_of(torso), TORSO_BONES | {n for n in SEG if n.split(".")[0] in ("thigh", "shin", "foot")})]
    for o, tag in zip(arms, ("L", "R")):
        regions.append((bvh_of(o), {"chest", f"upperarm.{tag}", f"forearm.{tag}", f"hand.{tag}"}))
    ob = join([torso] + arms + extras)
    ob.name = "body"
    ob.vertex_groups.clear()
    bpy.context.view_layer.objects.active = ob
    m = ob.modifiers.new("rm", "REMESH"); m.mode = "VOXEL"; m.voxel_size = 0.0065; m.adaptivity = 0.0
    bpy.ops.object.modifier_apply(modifier="rm")
    m = ob.modifiers.new("sm", "SMOOTH"); m.factor = 0.5; m.iterations = 2
    bpy.ops.object.modifier_apply(modifier="sm")
    m = ob.modifiers.new("dc", "DECIMATE"); m.ratio = 0.30
    bpy.ops.object.modifier_apply(modifier="dc")
    me = ob.data
    me.materials.clear(); me.materials.append(MAT["skin"])
    for p in me.polygons:
        p.use_smooth = True
    for uv in list(me.uv_layers):
        me.uv_layers.remove(uv)
    box_uv(ob)
    groups = {}
    for v in me.vertices:
        p = ob.matrix_world @ v.co
        best = min(regions, key=lambda r: (r[0].find_nearest(p)[3] if r[0].find_nearest(p)[0] is not None else 9))
        names = best[1]
        ds = []
        for n in names:
            if n == "jaw" or (n.endswith(".L") and p.x < -0.02) or (n.endswith(".R") and p.x > 0.02):
                continue
            ds.append((seg_dist(p, *SEG[n]), n))
        ds.sort()
        (d0, n0), (d1, n1) = ds[0], ds[1]
        w0, w1 = 1 / (d0 ** 4 + 1e-8), 1 / (d1 ** 4 + 1e-8)
        tot = w0 + w1
        for n, w in ((n0, w0 / tot), (n1, w1 / tot)):
            if w > 0.02:
                if n not in groups:
                    groups[n] = ob.vertex_groups.new(name=n)
                groups[n].add([v.index], w, "REPLACE")
    return ob

def join(parts):
    bpy.ops.object.select_all(action="DESELECT")
    for p in parts:
        p.select_set(True)
    bpy.context.view_layer.objects.active = parts[0]
    bpy.ops.object.join()
    ob = parts[0]
    ob.name = "Monster"
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

def add_anchors(arm):
    """Empties on the head bone: the game puts the far-away eye pinpoints on eye_L / eye_R and
    frames the jump scare on face_anchor."""
    bpy.context.view_layer.update()
    out = {}
    for name, key in (("eye_L", 1), ("eye_R", -1), ("face_anchor", "face")):
        e = bpy.data.objects.new(name, None)
        e.empty_display_size = 0.03
        col.objects.link(e)
        e.parent = arm
        e.parent_type = "BONE"
        e.parent_bone = "head"
        bpy.context.view_layer.update()
        e.matrix_world = Matrix.Translation(hw(*LANDMARKS[key]))
        out[name] = e
    bpy.context.view_layer.update()
    return out

# ----------------------------------------------------------------------------- posing (FK + leg IK)
AXV = {"x": Vector((1, 0, 0)), "y": Vector((0, 1, 0)), "z": Vector((0, 0, 1))}
def qrot(lst):
    """[(axis, degrees), ...] in armature axes. For an upright bone +x leans it forward,
    +y rolls it toward its right side, +z turns it to its left. For the jaw, +x opens."""
    q = Quaternion()
    for axis, deg in lst:
        q = Quaternion(AXV[axis], math.radians(deg)) @ q
    return q

LEG = {}
def leg_setup():
    for s, tag in ((1, "L"), (-1, "R")):
        H, K, A, T = P("hip", s), P("knee", s), P("ankle", s), P("toe", s)
        u0 = (A - H).normalized()
        w0 = (K - H) - u0 * (K - H).dot(u0); w0.normalize()
        LEG[tag] = dict(H=H, K=K, A=A, T=T, a=(K - H).length, b=(A - K).length, side0=u0.cross(w0), s=s)
LEGLEN = lambda: LEG["L"]["a"] + LEG["L"]["b"]

def frame_m(d, side):
    d = d.normalized(); x = side - d * side.dot(d); x.normalize(); z = x.cross(d)
    return Matrix((x, d, z)).transposed()

def between(d0, s0, d1, s1):
    return (frame_m(d1, s1) @ frame_m(d0, s0).transposed()).to_quaternion()

def solve_pose(spec):
    """spec: loc (pelvis offset), rel {bone: [(axis, deg)]} applied on top of the parent,
    feet {tag: (ankle target, toe-down pitch in degrees)}. Returns absolute rotation deltas."""
    loc = spec.get("loc", Vector())
    rel = spec.get("rel", {})
    D = {}
    for name, _, _, parent, _ in BONES:
        if name.split(".")[0] in ("thigh", "shin", "foot"):
            continue
        D[name] = (D[parent] if parent else Quaternion()) @ qrot(rel.get(name, []))
    Dh = D["hips"]
    pel = P("pelvis") + loc
    for tag, L in LEG.items():
        tgt, pitch = spec["feet"][tag]
        Hp = pel + Dh @ (L["H"] - P("pelvis"))
        f = Dh @ Vector((L["s"] * 0.10, -1, 0))
        dv = tgt - Hp
        u = dv.normalized()
        a, b = L["a"], L["b"]
        d = max(min(dv.length, (a + b) * 0.9995), abs(a - b) + 1e-3)
        w = f - u * f.dot(u); w.normalize()
        ca = max(-1.0, min(1.0, (a * a + d * d - b * b) / (2 * a * d)))
        K = Hp + (u * ca + w * math.sqrt(1 - ca * ca)) * a
        Ae = Hp + u * d
        side = u.cross(w)
        D["thigh." + tag] = between(L["K"] - L["H"], L["side0"], K - Hp, side)
        D["shin." + tag] = between(L["A"] - L["K"], L["side0"], Ae - K, side)
        D["foot." + tag] = Quaternion(Vector((1, 0, 0)), math.radians(pitch))
    return D, loc

REST_Q = {}
def apply_pose(arm, frame, spec):
    D, loc = solve_pose(spec)
    for pb in arm.pose.bones:
        pb.rotation_mode = "QUATERNION"
        if pb.name == "root":
            pb.rotation_quaternion = Quaternion()
        else:
            rest = REST_Q[pb.name]
            par = PARENT[pb.name]
            Dp = D[par] if par else Quaternion()
            pb.rotation_quaternion = rest.inverted() @ Dp.inverted() @ D[pb.name] @ rest
        pb.keyframe_insert("rotation_quaternion", frame=frame)
    hb = arm.pose.bones["hips"]
    hb.location = REST_Q["hips"].inverted() @ loc
    hb.keyframe_insert("location", frame=frame)

def make_action(arm, name, specs):
    arm.animation_data_create()
    act = bpy.data.actions.new(name)
    arm.animation_data.action = act
    for f, spec in enumerate(specs):
        apply_pose(arm, f + 1, spec)
    track = arm.animation_data.nla_tracks.new()
    track.name = name
    strip = track.strips.new(name, 1, act)
    strip.name = name
    arm.animation_data.action = None
    return act

# ----------------------------------------------------------------------------- gaits
def ss(a, b, x):
    t = max(0.0, min(1.0, (x - a) / (b - a)))
    return t * t * (3 - 2 * t)

def foot_at(phi, tag, S, duty, lift, heel, yc):
    """Ankle target and toe-down pitch for one foot; phi 0 = heel strike, in the body frame."""
    L = LEG[tag]
    F0 = L["T"] - L["A"]
    R = S * duty / 2
    x = L["A"].x
    F0 = Vector((0, L["T"].y - 0.085 - L["A"].y, 0.004 - L["A"].z))     # ankle -> tips of the toes: the heel lifts round them
    def ankle_heel_up(y_flat, th):
        toe = Vector((x, y_flat, L["A"].z)) + F0
        return toe - Quaternion(Vector((1, 0, 0)), math.radians(th)) @ F0
    if phi < duty:
        k = phi / duty
        y = yc - R + 2 * R * k
        th = heel * ss(0.70, 1.0, k) ** 1.5           # the heel peels up at the end of the stance
        return ankle_heel_up(y, th), th
    s = (phi - duty) / (1 - duty)
    A0 = ankle_heel_up(yc + R, heel)
    A1 = Vector((x, yc - R, L["A"].z))
    e = ss(0.0, 1.0, s)
    A = A0.lerp(A1, e)
    A.z += lift * math.sin(math.pi * min(1.0, s * 1.08)) ** 1.3
    th = heel * (1 - s) ** 2 - 18 * math.sin(math.pi * s) ** 2 * s
    return A, th

def gait(nframes, nstrides, S, duty, h0, lift, heel, sway, upper, yc_off=0.0):
    """One looping clip of `nstrides` strides of length S (body moves S per stride)."""
    yc = LEG["L"]["A"].y + yc_off
    rows = []
    reach = LEGLEN() * 0.985
    for f in range(nframes + 1):
        t = f / nframes
        ph = (t * nstrides) % 1.0
        feet = {"L": foot_at(ph, "L", S, duty, lift, heel, yc), "R": foot_at((ph + 0.5) % 1.0, "R", S, duty, lift, heel, yc)}
        sx = sway * math.cos(2 * math.pi * (ph - duty / 2))
        zmax = 9.0
        for tag, (A, _) in feet.items():
            H = LEG[tag]["H"] + Vector((sx, 0, 0))
            hz = math.hypot(A.x - H.x, A.y - H.y)
            zmax = min(zmax, A.z + math.sqrt(max(0.0, reach * reach - hz * hz)) - (LEG[tag]["H"].z - P("pelvis").z))
        rows.append([t, ph, feet, sx, min(h0, zmax), zmax])
    # smooth the hip height (it is a pendulum, not a piston), staying within reach
    z = np.array([r[4] for r in rows[:-1]])
    for _ in range(3):
        z = (np.roll(z, 1) + z + np.roll(z, -1)) / 3
    zmx = np.array([r[5] for r in rows[:-1]])
    z = z - max(0.0, float((z - zmx).max()))
    specs = []
    for i, (t, ph, feet, sx, _, _) in enumerate(rows):
        hz = z[i % len(z)]
        rel, extra = upper(t, ph)
        specs.append({"loc": Vector((sx, extra.get("dy", 0.0), hz - P("pelvis").z)), "rel": rel, "feet": feet})
    return specs

def standing(t):
    return {tag: (LEG[tag]["A"].copy(), 0.0) for tag in LEG}

def arms_folded(t, ph, amt=1.0, tw=0.0):
    """Arms stay folded up in front: elbows in, hands raised. A small bounce, finger twitches."""
    r = {}
    for tag, sg in (("L", 1), ("R", -1)):
        b = math.sin(4 * math.pi * ph)
        r[f"upperarm.{tag}"] = [("x", 3 * amt * b)]
        r[f"forearm.{tag}"] = [("x", -3 * amt * b)]
        r[f"hand.{tag}"] = [("x", tw * sg)]
    return r

def walk_upper(t, ph):
    s = math.sin
    # head: tilted, then a sudden snap the other way two-thirds through, easing back slowly
    roll = 16 - 46 * ss(0.555, 0.575, t) + 46 * ss(0.62, 0.98, t)
    twitch = 9 * math.exp(-((t - 0.21) / 0.012) ** 2) - 6 * math.exp(-((t - 0.83) / 0.015) ** 2)
    r = {
        "hips": [("x", 4), ("z", 5 * s(2 * math.pi * ph)), ("y", -2 * s(2 * math.pi * ph))],
        "spine": [("x", 3), ("z", -3 * s(2 * math.pi * ph))],
        "chest": [("x", 3 + 1.5 * s(4 * math.pi * ph)), ("z", -4 * s(2 * math.pi * ph))],
        "neck": [("x", 14 + 2 * s(4 * math.pi * ph + 0.6))],
        "head": [("y", roll), ("x", 6 + twitch), ("z", 6 * s(2 * math.pi * t))],
        "jaw": [("x", 12 + 4 * s(2 * math.pi * t * 2))],
    }
    r.update(arms_folded(t, ph, 1.0, 10 * math.exp(-((t - 0.4) / 0.01) ** 2)))
    return r, {}

def run_upper(t, ph):
    s = math.sin
    jit = 4 * s(2 * math.pi * 6 * t) + 2.5 * s(2 * math.pi * 11 * t + 1)
    r = {
        "hips": [("x", 14), ("z", 7 * s(2 * math.pi * ph)), ("y", -3 * s(2 * math.pi * ph))],
        "spine": [("x", 8), ("z", -4 * s(2 * math.pi * ph))],
        "chest": [("x", 8 + 3 * s(4 * math.pi * ph)), ("z", -6 * s(2 * math.pi * ph))],
        "neck": [("x", 6)],
        "head": [("x", -18 + jit), ("y", 10 + jit * 0.8), ("z", -7 * s(2 * math.pi * ph))],
        "jaw": [("x", 26 + 6 * s(2 * math.pi * 4 * t))],
    }
    r.update(arms_folded(t, ph, 2.2, 0))
    for tag in ("L", "R"):
        r[f"upperarm.{tag}"].append(("x", 12))       # elbows pulled back, hands up by the throat
        r[f"forearm.{tag}"].append(("x", -6))
    return r, {}

def duck_upper(t, ph):
    s = math.sin
    r = {
        "hips": [("x", 38), ("z", 4 * s(2 * math.pi * ph))],
        "spine": [("x", 14)],
        "chest": [("x", 14 + 1.5 * s(4 * math.pi * ph)), ("z", -3 * s(2 * math.pi * ph))],
        "neck": [("x", -22)],
        "head": [("x", -26), ("y", 14 + 3 * s(2 * math.pi * t)), ("z", 4 * s(2 * math.pi * t))],
        "jaw": [("x", 16)],
    }
    r.update(arms_folded(t, ph, 1.0, 0))
    for tag in ("L", "R"):
        r[f"upperarm.{tag}"].append(("x", 14))       # elbows tucked back against the ribs
        r[f"forearm.{tag}"].append(("x", -10))
    return r, {}

def idle_specs(n=120):
    out = []
    for f in range(n + 1):
        t = f / n
        s = math.sin
        roll = 16 + 42 * ss(0.10, 0.58, t) - 72 * ss(0.69, 0.705, t) + 14 * ss(0.75, 1.0, t)
        pitch = 8 + 6 * ss(0.10, 0.58, t) - 14 * ss(0.69, 0.705, t) + 8 * ss(0.75, 1.0, t)
        jaw = 8 + 18 * ss(0.15, 0.62, t) - 18 * ss(0.69, 0.71, t)
        br = s(2 * math.pi * 2 * t)
        r = {
            "hips": [("x", 3)], "spine": [("x", 2 + 0.8 * br)],
            "chest": [("x", 3 + 1.4 * br)],
            "neck": [("x", 14), ("y", 0.25 * (roll - 16))],
            "head": [("y", roll * 0.8), ("x", pitch), ("z", 4 * s(2 * math.pi * t))],
            "jaw": [("x", jaw)],
        }
        tw = 0.0
        for c in (0.18, 0.33, 0.47, 0.86):
            tw += 9 * math.exp(-((t - c) / 0.008) ** 2)
        r.update(arms_folded(t, 0, 0.0, tw))
        out.append({"loc": Vector((0, 0, -0.05 + 0.006 * br)), "rel": r, "feet": standing(t)})
    return out

def scream_specs(n=40):
    out = []
    for f in range(n + 1):
        t = f / n
        k = ss(0.0, 0.12, t)
        s = math.sin
        tr = s(t * 160) * 1.5 + s(t * 97) * 1.0
        r = {
            "hips": [("x", 8 * k)], "spine": [("x", 8 * k)], "chest": [("x", 10 * k)],
            "neck": [("x", 18 * k + tr * 0.5)],
            "head": [("x", -30 * k + tr), ("y", 6 * (1 - k) + 3 * s(t * 23) * k)],
            "jaw": [("x", 10 + 22 * k + tr * 1.5)],
        }
        for tag, sg in (("L", 1), ("R", -1)):
            # arms fly up and out to the sides of the head, fingers spread: they frame the face, never cover it
            r[f"upperarm.{tag}"] = [("y", -sg * 120 * k), ("x", -15 * k)]
            r[f"forearm.{tag}"] = [("y", -sg * 20 * k), ("x", 20 * k + tr)]
            r[f"hand.{tag}"] = [("x", -25 * k), ("y", -sg * 20 * k)]
        out.append({"loc": Vector((0, -0.04 * k, -0.06 * k)), "rel": r, "feet": standing(t)})
    return out

CLIPS = {}   # name -> (frames, distance per clip at rate 1)
def animate(arm):
    bpy.context.view_layer.update()
    for pb in arm.pose.bones:
        if pb.name != "root":
            REST_Q[pb.name] = pb.bone.matrix_local.to_quaternion()
    leg_setup()
    make_action(arm, "Idle", idle_specs(120))
    # walk: three slow strides per clip so the head snap does not repeat every step
    W = dict(n=84, k=3, S=1.70, duty=0.62, h0=1.30, lift=0.13, heel=32, sway=0.025)
    make_action(arm, "Walk", gait(W["n"], W["k"], W["S"], W["duty"], W["h0"], W["lift"], W["heel"], W["sway"], walk_upper))
    CLIPS["Walk"] = (W["n"], W["k"] * W["S"], W["duty"])
    R = dict(n=32, k=2, S=2.60, duty=0.38, h0=1.20, lift=0.30, heel=45, sway=0.02)
    make_action(arm, "Run", gait(R["n"], R["k"], R["S"], R["duty"], R["h0"], R["lift"], R["heel"], R["sway"], run_upper, -0.05))
    CLIPS["Run"] = (R["n"], R["k"] * R["S"], R["duty"])
    Dk = dict(n=26, k=1, S=1.50, duty=0.62, h0=0.98, lift=0.12, heel=30, sway=0.02)
    make_action(arm, "Duck", gait(Dk["n"], Dk["k"], Dk["S"], Dk["duty"], Dk["h0"], Dk["lift"], Dk["heel"], Dk["sway"], duck_upper, -0.10))
    CLIPS["Duck"] = (Dk["n"], Dk["k"] * Dk["S"], Dk["duty"])
    make_action(arm, "Scream", scream_specs(40))
    for pb in arm.pose.bones:
        pb.rotation_quaternion = Quaternion()
        pb.location = (0, 0, 0)

# ----------------------------------------------------------------------------- measuring
def solo(arm, name):
    for t in arm.animation_data.nla_tracks:
        t.mute = (name is not None and t.name != name)

def measure(arm, mesh, name, frames):
    solo(arm, name)
    lo = np.full(3, 1e9); hi = np.full(3, -1e9); wmax = (0, 0); zmax = (0, 0)
    for f in frames:
        scene.frame_set(f)
        dg = bpy.context.evaluated_depsgraph_get()
        ev = mesh.evaluated_get(dg)
        me = ev.to_mesh()
        co = np.empty(len(me.vertices) * 3, np.float32)
        me.vertices.foreach_get("co", co)
        co = co.reshape(-1, 3)
        ev.to_mesh_clear()
        lo = np.minimum(lo, co.min(0)); hi = np.maximum(hi, co.max(0))
        w = float(co[:, 0].max() - co[:, 0].min()); h = float(co[:, 2].max())
        if w > wmax[0]: wmax = (w, f)
        if h > zmax[0]: zmax = (h, f)
    print(f"MEASURE {name:7s} width(x) max {wmax[0]:.3f} m (frame {wmax[1]})  top max {zmax[0]:.3f} m (frame {zmax[1]})  "
          f"bbox x[{lo[0]:.2f},{hi[0]:.2f}] y[{lo[1]:.2f},{hi[1]:.2f}] z[{lo[2]:.3f},{hi[2]:.3f}]")
    solo(arm, None)
    return lo, hi

# ----------------------------------------------------------------------------- preview render
def look(cam, target):
    cam.rotation_euler = (target - cam.location).to_track_quat("-Z", "Y").to_euler()

def render_preview(arm, anchors):
    cam_data = bpy.data.cameras.new("cam")
    cam_data.lens = 35
    cam_data.clip_start = 0.01
    cam = bpy.data.objects.new("cam", cam_data)
    col.objects.link(cam)
    scene.camera = cam
    sun = bpy.data.objects.new("sun", bpy.data.lights.new("sun", "SUN"))
    sun.data.energy = 3.0
    sun.rotation_euler = (math.radians(55), 0, math.radians(-40))
    col.objects.link(sun)
    bm = bmesh.new()
    bmesh.ops.create_grid(bm, x_segments=1, y_segments=1, size=12)
    me = bpy.data.meshes.new("ground"); bm.to_mesh(me); bm.free()
    g = bpy.data.objects.new("ground", me)
    me.materials.append(material("ground", (0.16, 0.15, 0.14), 0.9))
    col.objects.link(g)
    world = bpy.data.worlds.new("w")
    world.use_nodes = True
    bg = world.node_tree.nodes["Background"]
    bg.inputs[0].default_value = (0.20, 0.22, 0.26, 1)
    bg.inputs[1].default_value = 0.9
    scene.world = world
    scene.render.engine = "CYCLES"
    scene.cycles.samples = 40
    scene.cycles.device = "CPU"
    scene.view_settings.view_transform = "Standard"
    def shot(path, rx, ry):
        scene.render.resolution_x, scene.render.resolution_y = rx, ry
        scene.render.filepath = path
        bpy.ops.render.render(write_still=True)
    # full body
    cam.location = (-2.3, -4.6, 1.55)
    look(cam, Vector((0, 0, 1.22)))
    arm.data.pose_position = "REST"; scene.frame_set(1)
    shot(PREV(""), 760, 1000)
    arm.data.pose_position = "POSE"
    solo(arm, "Walk"); scene.frame_set(48)
    shot(PREV("_walk"), 760, 1000)
    solo(arm, "Run"); scene.frame_set(6)
    cam.location = (-4.2, -2.6, 1.4); look(cam, Vector((0, 0, 1.1)))
    shot(PREV("_run"), 1000, 760)
    # ducking through a door frame (0.95 m wide, 2.1 m high, posts 0.1 m) seen from the side-front
    solo(arm, "Duck"); scene.frame_set(8)
    bm = bmesh.new()
    for m in (Matrix.Translation((0.525, -0.15, 1.05)) @ Matrix.Diagonal((0.05, 0.08, 1.05, 1)),
              Matrix.Translation((-0.525, -0.15, 1.05)) @ Matrix.Diagonal((0.05, 0.08, 1.05, 1)),
              Matrix.Translation((0, -0.15, 2.15)) @ Matrix.Diagonal((0.575, 0.08, 0.05, 1))):
        bmesh.ops.create_cube(bm, size=2.0, matrix=m)
    me = bpy.data.meshes.new("doorframe"); bm.to_mesh(me); bm.free()
    door = bpy.data.objects.new("doorframe", me)
    me.materials.append(material("doorwood", (0.30, 0.20, 0.12), 0.6))
    col.objects.link(door)
    cam.location = (-2.6, -3.6, 1.3); look(cam, Vector((0, -0.1, 1.0)))
    shot(PREV("_duck"), 1000, 760)
    bpy.data.objects.remove(door)
    # close-ups in the dark, lit by a "flashlight" next to the camera
    sun.data.energy = 0.0
    bg.inputs[1].default_value = 0.03
    flash = bpy.data.objects.new("flash", bpy.data.lights.new("flash", "SPOT"))
    flash.data.energy = 25
    flash.data.spot_size = math.radians(50)
    flash.data.shadow_soft_size = 0.02
    col.objects.link(flash)
    arm.data.pose_position = "REST"; solo(arm, None); scene.frame_set(1)
    bpy.context.view_layer.update()
    fc = anchors["face_anchor"].matrix_world.translation.copy()
    cam_data.lens = 70
    cam.location = fc + Vector((0.10, -0.95, 0.05))
    look(cam, fc + Vector((0, 0, -0.01)))
    flash.location = cam.location + Vector((0.12, 0, 0.08))
    look(flash, fc)
    shot(PREV("_face"), 800, 1000)
    # scream, framed like the game's jump scare (72 degree vertical fov)
    arm.data.pose_position = "POSE"
    solo(arm, "Scream"); scene.frame_set(24)
    bpy.context.view_layer.update()
    am = anchors["face_anchor"].matrix_world
    rot = am.to_quaternion().to_matrix().to_4x4()
    cam.matrix_world = Matrix.Translation(am.translation) @ rot @ Matrix.Translation((0, -SCARE_DIST, 0)) @ Matrix.Rotation(math.radians(90), 4, "X")
    cam_data.sensor_fit = "VERTICAL"
    cam_data.angle = math.radians(72)
    cam_data.clip_start = 0.05
    flash.matrix_world = cam.matrix_world @ Matrix.Translation((0.08, -0.06, 0))
    flash.data.energy = 6
    shot(PREV("_scream"), 960, 540)
    # in the dark hallway: the flashlight finds it standing 6 m away
    arm.data.pose_position = "POSE"; solo(arm, "Idle"); scene.frame_set(70)
    cam_data.sensor_fit = "AUTO"; cam_data.lens = 26
    cam.matrix_world = Matrix.Identity(4)
    cam.location = (0.4, -6.0, 1.6); look(cam, Vector((0, 0, 1.5)))
    flash.location = cam.location + Vector((0.2, 0, -0.25)); look(flash, Vector((0, 0, 1.4)))
    flash.data.energy = 120; flash.data.spot_size = math.radians(35); flash.data.spot_blend = 0.6
    shot(PREV("_hall"), 960, 540)
    solo(arm, None)
    for o in (cam, sun, g, flash):
        bpy.data.objects.remove(o)

SCARE_DIST = 0.21

# ----------------------------------------------------------------------------- main
setup_materials()
monster = build_generated()
rig = build_rig(monster)
anchors = add_anchors(rig)
animate(rig)

tris = sum(len(p.vertices) - 2 for p in monster.data.polygons)
print("TRIANGLES", tris, "VERTS", len(monster.data.vertices))
for k, v in LANDMARKS.items():
    w = hw(*v)
    print("LANDMARK", k, "blender", tuple(round(c, 4) for c in w), "gltf", (round(w.x, 4), round(w.z, 4), round(-w.y, 4)))
for name, (n, dist, duty) in CLIPS.items():
    print(f"CLIP {name}: {n} frames = {n / 24:.4f} s, moves {dist:.3f} m per clip at rate 1 ({dist / (n / 24):.3f} m/s), duty {duty}")

for name, n in (("Walk", 84), ("Run", 32), ("Duck", 26), ("Idle", 120), ("Scream", 40)):
    measure(rig, monster, name, range(1, n + 2))

os.makedirs(os.path.dirname(OUT_GLB), exist_ok=True)
bpy.ops.export_scene.gltf(
    filepath=OUT_GLB, export_format="GLB", export_animations=True,
    export_animation_mode="NLA_TRACKS", export_skins=True, export_yup=True,
    export_image_format="JPEG", export_jpeg_quality=88,
)
print("Exported", OUT_GLB, os.path.getsize(OUT_GLB), "bytes")
if "--no-render" not in sys.argv:
    render_preview(rig, anchors)
    print("Rendered previews")
