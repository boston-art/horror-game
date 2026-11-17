"""
Builds the monster for the game, rigs it, animates it (Idle / Walk / Run / Scream) and exports
public/models/monster.glb, plus preview renders:
    tools/monster_preview.png         rest pose
    tools/monster_preview_run.png     a frame of the run
    tools/monster_preview_face.png    close-up of the face, lit like a flashlight
    tools/monster_preview_scream.png  the Scream pose framed like the in-game jump scare

Version 3: a pale, starved thing that crawls on all fours like a spider, knees up and out,
very long arms, clawed fingers. The head is one sculpted mesh (a dense sphere deformed by
code): long stretched face, huge black sockets with a pinpoint of light in each, a gaping
vertically stretched black mouth, deep creases from the sockets to the mouth, hollow
cheeks, brow ridges (references/monster_v3_face.png). Fine detail (creases, wrinkles,
mottling, veins) is in generated textures + normal maps. The face features are defined
once as 2D functions of the front-view position (x, z) and used both to deform the mesh
and to paint the textures, so the painted creases line up with the sculpted ones.
The first version (hunched figure in a suit) is kept in tools/build_monster_v1_suit.py.

Run from the project folder:
    /Applications/Blender.app/Contents/MacOS/Blender -b -P tools/build_monster.py

If references/monster.glb exists, that model is used instead of the generated one and
is only rigged and animated.

Blender axes: Z up, the monster faces -Y.
"""
import bpy, bmesh, math, os, sys, random
import numpy as np
from mathutils import Vector, Quaternion, Matrix

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_GLB = os.path.join(ROOT, "public", "models", "monster.glb")
OUT_PNG = os.path.join(ROOT, "tools", "monster_preview.png")
OUT_PNG_RUN = os.path.join(ROOT, "tools", "monster_preview_run.png")
OUT_PNG_FACE = os.path.join(ROOT, "tools", "monster_preview_face.png")
OUT_PNG_SCREAM = os.path.join(ROOT, "tools", "monster_preview_scream.png")
READY_MADE = os.path.join(ROOT, "references", "monster.glb")
TEXDIR = os.path.join(ROOT, "tools")
TEETH = True

bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
col = scene.collection

# ----------------------------------------------------------------------------- head placement
HS = 0.80                                 # head scale (head-local metres -> world)
HC = Vector((0, -0.535, 0.95))            # head centre in world space
def hw(x, y, z):
    return HC + Vector((x, y, z)) * HS

# ----------------------------------------------------------------------------- skeleton
# Joint positions of the crawling rest pose (metres). +X is one side, -Y is forward.
# Spider-like crouch: knees up and out, very long arms planted far in front, head raised.
J = {
    "pelvis": (0, 0.38, 0.60), "spine1": (0, 0.20, 0.70), "mid": (0, 0.0, 0.78),
    "chest": (0, -0.20, 0.82), "neck": (0, -0.36, 0.86), "head": (0, -0.47, 0.885), "headtip": (0, -0.68, 0.95),
    "shoulder": (0.19, -0.20, 0.80), "elbow": (0.50, -0.40, 0.56), "wrist": (0.42, -0.85, 0.09), "tip": (0.44, -1.10, 0.02),
    "hip": (0.12, 0.38, 0.58), "knee": (0.44, 0.06, 0.72), "ankle": (0.37, 0.44, 0.10), "toe": (0.39, 0.27, 0.03),
    "jaw": tuple(hw(0, 0.0, -0.06)), "chin": tuple(hw(0, -0.075, -0.24)),
}
def P(name, side=1):
    x, y, z = J[name]
    return Vector((x * side, y, z))

BONES = [  # name, head joint, tail joint, parent, side
    ("hips", "pelvis", "spine1", None, 0), ("spine", "spine1", "mid", "hips", 0), ("chest", "mid", "chest", "spine", 0),
    ("neck", "chest", "neck", "chest", 0), ("head", "neck", "headtip", "neck", 0), ("jaw", "jaw", "chin", "head", 0),
]
for s, tag in ((1, "L"), (-1, "R")):
    BONES += [
        (f"upperarm.{tag}", "shoulder", "elbow", "chest", s), (f"forearm.{tag}", "elbow", "wrist", f"upperarm.{tag}", s),
        (f"hand.{tag}", "wrist", "tip", f"forearm.{tag}", s),
        (f"thigh.{tag}", "hip", "knee", "hips", s), (f"shin.{tag}", "knee", "ankle", f"thigh.{tag}", s),
        (f"foot.{tag}", "ankle", "toe", f"shin.{tag}", s),
    ]
SEG = {n: (P(a, s or 1), P(b, s or 1)) for n, a, b, _, s in BONES}

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

# ----------------------------------------------------------------------------- the face, as 2D fields
# Head-local coordinates before scaling by HS: x across, z up, the face looks toward -y.
# Everything is symmetric in x except for a little noise.
SOCK = dict(cx=0.047, cz=0.028, rx=0.032, rz=0.037, tilt=0.16)
MOUTH = dict(cz=-0.122, rx=0.037, rz=0.082)

def socket_coords(X, Z):
    ax = np.abs(X)
    dx, dz = ax - SOCK["cx"], Z - SOCK["cz"]
    c, s = math.cos(SOCK["tilt"]), math.sin(SOCK["tilt"])
    u, v = dx * c - dz * s, dx * s + dz * c          # tops lean outward, a little sad and stretched
    e = np.sqrt((u / SOCK["rx"]) ** 2 + (v / SOCK["rz"]) ** 2)
    up = (v / SOCK["rz"]) / (e + 1e-6)              # +1 at the top of the socket, -1 at the bottom
    return e, up, u / SOCK["rx"]

def mouth_coords(X, Z):
    t = (Z - MOUTH["cz"]) / MOUTH["rz"]
    rx = MOUTH["rx"] * (1 + 0.14 * t)               # a little wider at the top, an egg standing up
    e = np.sqrt((X / rx) ** 2 + t ** 2)
    ang = np.arctan2(t, X / rx)
    return e, ang

def bowl(e, depth, inner):
    return depth * (1 - smoothstep(inner, 1.0, e)) * (1 - 0.18 * np.minimum(e, 1) ** 2)

def ellipse_arc(e, a0, a1, n=14):
    """Points (|x|, z) on the ellipse around the socket at socket radius e, angles in degrees."""
    out = []
    c, s = math.cos(SOCK["tilt"]), math.sin(SOCK["tilt"])
    for k in range(n):
        a = math.radians(a0 + (a1 - a0) * k / (n - 1))
        u, v = math.cos(a) * SOCK["rx"] * e, math.sin(a) * SOCK["rz"] * e
        dx, dz = u * c + v * s, -u * s + v * c
        out.append((SOCK["cx"] + dx, SOCK["cz"] + dz))
    return out

# crease: points (|x|, z), geometric depth, geometric width, darkness, fold side (+1 outer / -1 inner)
CREASES = [
    # the long folds from the inner corner of each socket down beside the mouth to the chin
    ([(0.024, 0.000), (0.030, -0.030), (0.043, -0.064), (0.053, -0.105), (0.056, -0.150), (0.050, -0.198), (0.037, -0.232)], 0.008, 0.0050, 1.0, 1),
    # from the outer corner of each socket down the cheek
    ([(0.076, -0.004), (0.083, -0.042), (0.081, -0.088), (0.073, -0.138), (0.062, -0.182)], 0.006, 0.0050, 0.8, -1),
    # bags under the sockets
    (ellipse_arc(1.24, 210, 330), 0.004, 0.0032, 0.75, -1),
    (ellipse_arc(1.55, 225, 315), 0.003, 0.0030, 0.45, -1),
    # lid fold above the sockets
    (ellipse_arc(1.32, 50, 135), 0.003, 0.0030, 0.45, 1),
    # between the mouth corners and the cheek folds
    ([(0.040, -0.055), (0.047, -0.090), (0.049, -0.130)], 0.003, 0.0030, 0.5, 1),
    # furrows between the brows and on the forehead (texture only)
    ([(0.010, 0.070), (0.012, 0.098)], 0.0, 0.0022, 0.35, 1),
    ([(0.060, 0.088), (0.053, 0.112), (0.045, 0.128)], 0.0, 0.0022, 0.3, 1),
    ([(0.076, 0.070), (0.083, 0.098)], 0.0, 0.0022, 0.3, 1),
    # stretched neck / chin lines under the mouth
    ([(0.020, -0.212), (0.028, -0.236)], 0.0, 0.0025, 0.45, 1),
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
        # a little wobble so the lines do not look drawn with a ruler
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
    """Sculpted height of the face, metres, positive = toward the viewer."""
    AX = np.abs(X)
    es, up, _ = socket_coords(X, Z)
    em, _ = mouth_coords(X, Z)
    h = np.zeros(X.shape)
    h += 0.004 * np.exp(-((es - 1.12) / 0.10) ** 2)                                   # socket rims
    h += 0.013 * np.exp(-((es - 1.38) / 0.22) ** 2) * smoothstep(-0.1, 0.7, up)       # brow ridges
    h += 0.003 * g2(X, Z, 0, 0.075, 0.03, 0.02)                                       # brow knot
    nose = smoothstep(0.075, 0.04, Z) * smoothstep(-0.042, -0.022, Z) * (0.6 + 0.4 * smoothstep(0.05, -0.02, Z))
    h += 0.010 * np.exp(-(X / 0.010) ** 2) * nose                                     # nose ridge
    h += 0.005 * g2(X, Z, 0, -0.027, 0.012, 0.008)                                    # nose tip, barely
    h -= 0.006 * g2(AX, Z, 0.009, -0.033, 0.0038, 0.0026)                             # slit nostrils
    h += 0.007 * np.exp(-((em - 1.07) / 0.08) ** 2)                                   # thin stretched lips
    h += 0.009 * np.exp(-((em - 1.55) / 0.45) ** 2)                                   # the mouth pushes out
    h -= 0.017 * g2(AX, Z, 0.073, -0.078, 0.022, 0.048)                               # hollow cheeks
    h += 0.006 * g2(AX, Z, 0.074, -0.012, 0.018, 0.012)                               # cheekbones
    h -= 0.009 * g2(AX, Z, 0.090, 0.045, 0.020, 0.035)                                # temples
    h += 0.006 * g2(X, Z, 0, -0.222, 0.026, 0.014)                                    # chin
    for d, side, taper, depth, width, dark, fold in creases(X, Z):
        if depth <= 0:
            continue
        h -= depth * np.exp(-(d / width) ** 2) * taper
        h += depth * 0.55 * np.exp(-((d - 1.7 * width) / width) ** 2) * taper * np.where(side == fold, 1.0, 0.25)
    h *= 1 - hole_mask(X, Z)
    h -= bowl(es, 0.058, 0.90)                                                        # deep sockets
    h -= bowl(em, 0.095, 0.88)                                                        # gaping mouth
    return h

# ----------------------------------------------------------------------------- textures
FX0, FX1, FZ0, FZ1 = -0.128, 0.128, -0.255, 0.175   # area of the head covered by the face texture

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

def skin_tone(X, Y, freq_scale, periodic, contrast=1.0):
    """Shared pale skin palette (sRGB), so the head and the body match."""
    n1 = fbm(X, Y, 6 * freq_scale, 11, 4, periodic)
    n2 = fbm(X, Y, 3 * freq_scale, 23, 3, periodic)
    n3 = fbm(X, Y, 48 * freq_scale, 31, 2, periodic)
    base = np.stack([0.80 + 0 * X, 0.785 + 0 * X, 0.735 + 0 * X], -1)
    base = base * (1 - 0.14 * contrast + 0.20 * contrast * n1)[..., None] * (0.96 + 0.08 * n3)[..., None]
    blotch = contrast * smoothstep(0.55, 0.8, n2)[..., None]                     # bruised, purplish-grey patches
    base = base * (1 - 0.18 * blotch) + np.array([0.55, 0.45, 0.50]) * 0.18 * blotch
    sick = smoothstep(0.4, 0.75, fbm(X, Y, 2 * freq_scale, 41, 3, periodic))[..., None]
    base = base * (1 - 0.12 * sick) + np.array([0.62, 0.66, 0.52]) * 0.12 * sick
    return base

def veins(X, Y, freq, seed, periodic):
    r = 1 - np.abs(2 * fbm(X, Y, freq, seed, 4, periodic) - 1)
    return smoothstep(0.90, 0.985, r)

def normal_from_height(H, du, dv, strength=1.0, wrap=False):
    if wrap:
        gx = (np.roll(H, -1, 1) - np.roll(H, 1, 1)) / (2 * du)
        gy = (np.roll(H, -1, 0) - np.roll(H, 1, 0)) / (2 * dv)
    else:
        gy, gx = np.gradient(H, dv, du)
    n = np.stack([-gx * strength, -gy * strength, np.ones_like(H)], -1)
    n /= np.linalg.norm(n, axis=-1, keepdims=True)
    return n * 0.5 + 0.5

def make_face_textures(W=512, H=1024):
    """Left half: the front of the head (front projection). Right half: the back of the head,
    same skin noise in the same (x, z) coordinates so the two halves meet without a seam."""
    xs = FX0 + (np.arange(W) + 0.5) / W * (FX1 - FX0)
    zs = FZ0 + (np.arange(H) + 0.5) / H * (FZ1 - FZ0)
    X, Z = np.meshgrid(xs, zs)               # row 0 = bottom of the image = lowest z
    du, dv = (FX1 - FX0) / W, (FZ1 - FZ0) / H
    AX = np.abs(X)
    tone = skin_tone(X * 2.3, Z * 2.3, 1.0, False)
    vein = veins(X * 2.3, Z * 2.3, 9, 61, False) * (0.5 + 0.5 * smoothstep(0.02, 0.12, Z))
    tone = tone * (1 - 0.22 * vein[..., None]) + np.array([0.36, 0.38, 0.50]) * 0.22 * vein[..., None]
    pores = fbm(X * 2.3, Z * 2.3, 160, 71, 2) - 0.5
    back_h = pores * 0.00012 + blur(vein, 1.5) * 0.00015

    es, up, _ = socket_coords(X, Z)
    em, mang = mouth_coords(X, Z)
    hgeo = face_height(X, Z)
    holes = hole_mask(X, Z)
    # fine height: creases sharper than the mesh can hold, wrinkles, pores, veins
    hf = back_h.copy()
    dark = np.zeros(X.shape)
    for d, side, taper, depth, width, dk, fold in creases(X, Z):
        hf -= 0.0012 * np.exp(-(d / 0.0016) ** 2) * taper
        dark += dk * (0.80 * np.exp(-(d / 0.0028) ** 2) + 0.30 * np.exp(-(d / 0.009) ** 2)) * taper
    under = smoothstep(1.1, 1.3, es) * (1 - smoothstep(1.7, 2.1, es)) * smoothstep(0.2, -0.5, up)
    hf -= 0.00025 * (np.sin(es * 2 * math.pi * 7) * 0.5 + 0.5) ** 3 * under            # fine lines under the eyes
    stretch = smoothstep(1.05, 1.2, em) * (1 - smoothstep(1.6, 2.2, em))
    hf -= 0.00030 * (np.sin(mang * 34 + 3 * vnoise(X * 30, Z * 30, 1, 5)) * 0.5 + 0.5) ** 4 * stretch   # skin stretched round the mouth
    fh = smoothstep(0.075, 0.095, Z) * (1 - smoothstep(0.13, 0.16, Z)) * (1 - smoothstep(0.06, 0.09, AX))
    hf -= 0.00025 * (np.sin(Z * 2 * math.pi * 38 + 6 * vnoise(X * 20, Z * 20, 1, 9)) * 0.5 + 0.5) ** 4 * fh  # forehead
    # baked shading
    cav = np.clip(blur(hgeo, 0.007 / du) - hgeo, 0, None)
    dark += np.clip(cav / 0.006, 0, 1) * 0.55
    dark += 0.85 * (1 - smoothstep(0.98, 1.30, es)) + 0.30 * (1 - smoothstep(1.2, 1.9, es)) * smoothstep(0.3, -0.6, up) * (1 - smoothstep(0.02, 0.03, np.abs(X) - 0.0))
    dark += 0.90 * (1 - smoothstep(1.0, 1.32, em))
    dark += 0.32 * g2(AX, Z, 0.073, -0.08, 0.020, 0.045)                             # hollow cheeks
    dark += 0.25 * g2(AX, Z, 0.090, 0.045, 0.018, 0.035)                             # temples
    dark += 0.30 * g2(AX, Z, 0.018, 0.010, 0.007, 0.030) * smoothstep(-0.04, -0.02, Z)   # beside the nose
    dark += 0.90 * g2(AX, Z, 0.009, -0.033, 0.004, 0.003)                            # nostrils
    dark += 0.30 * g2(X, Z, 0, -0.035, 0.022, 0.006)                                 # under the nose
    dark += 0.20 * smoothstep(-0.215, -0.25, Z)                                      # under the chin
    dark = np.clip(dark + 0.08 * (fbm(X * 2.3, Z * 2.3, 30, 81, 3) - 0.5), 0, 1)
    light = (0.12 * g2(X, Z, 0, 0.125, 0.05, 0.04) + 0.10 * np.exp(-(X / 0.01) ** 2) * smoothstep(0.06, 0.0, Z) * smoothstep(-0.03, 0.0, Z)
             + 0.10 * g2(AX, Z, 0.072, -0.015, 0.016, 0.010) + 0.08 * g2(X, Z, 0, -0.222, 0.02, 0.012)
             + 0.10 * np.exp(-((em - 1.08) / 0.07) ** 2))
    dark = np.maximum(dark, holes)
    k = dark[..., None]
    front = tone * (1 + light[..., None]) * (1 - 0.9 * k) + np.array([0.20, 0.15, 0.17]) * 0.06 * k
    back = tone
    color = np.concatenate([front, back], axis=1)
    hfront = hf * (1 - holes)
    height = np.concatenate([hfront, back_h], axis=1)
    nrm = np.concatenate([normal_from_height(hfront, du, dv), normal_from_height(back_h, du, dv)], axis=1)
    return save_image("monster_face", color), save_image("monster_face_n", nrm, True)

def make_body_textures(n=512):
    """Tileable skin for the body: mottling, veins, fine wrinkles."""
    u = (np.arange(n) + 0.5) / n
    U, V = np.meshgrid(u, u)
    tone = skin_tone(U, V, 1.0, True, 0.55) * 0.93
    vein = veins(U, V, 4, 91, True)
    vein2 = veins(U, V, 8, 97, True) * 0.6
    vv = np.maximum(vein, vein2)
    tone = tone * (1 - 0.18 * vv[..., None]) + np.array([0.45, 0.48, 0.60]) * 0.18 * vv[..., None]
    wr = smoothstep(0.6, 0.9, fbm(U, V, 16, 7, 3, True))      # soft creased patches
    hgt = 0.0005 * blur(vv, 2, True) + 0.00012 * (fbm(U, V, 64, 13, 2, True) - 0.5) - 0.00012 * wr
    cav = np.clip(blur(hgt, 6, True) - hgt, 0, None)
    tone = tone * (1 - np.clip(cav / 0.0002, 0, 1)[..., None] * 0.25)
    # one tile covers ~0.45 m of body, so a texel is ~0.9 mm
    nrm = normal_from_height(hgt, 0.45 / n, 0.45 / n, 1.0, True)
    return save_image("monster_skin", tone), save_image("monster_skin_n", nrm, True)

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

MAT = {}
def setup_materials():
    fc, fn = make_face_textures()
    bc, bn = make_body_textures()
    MAT["face"] = material("face", (1, 1, 1), 0.48, fc, fn, 1.0)
    MAT["skin"] = material("skin", (1, 1, 1), 0.55, bc, bn, 1.0)
    MAT["claw"] = material("claw", (0.05, 0.045, 0.04), 0.3)
    MAT["teeth"] = material("teeth", (0.46, 0.42, 0.32), 0.4)
    # the holes: black, fully rough, no specular. The game swaps these for unlit black.
    MAT["mouth"] = material("mouth", (0, 0, 0), 1.0, spec=0.0)
    MAT["socket"] = material("socket", (0, 0, 0), 1.0, spec=0.0)
    MAT["eye"] = material("eye", (1, 1, 1), 0.3, emit=((1.0, 0.98, 0.94), 8.0))

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

# ----------------------------------------------------------------------------- body
def torso(y):
    """Centre height, half-width and half-depth of the ribcage at this y."""
    t = max(0.0, min(1.0, (y - J["chest"][1]) / (J["spine1"][1] - J["chest"][1])))
    return J["chest"][2] + (J["spine1"][2] - J["chest"][2]) * t, 0.138 - 0.06 * t, 0.098 - 0.03 * t

def build_body():
    # stick figure -> skin modifier -> smooth, starved body
    pts, radii, edges = [], [], []
    def v(pos, r):
        pts.append(pos); radii.append(r if isinstance(r, tuple) else (r, r)); return len(pts) - 1
    pelvis = v(P("pelvis"), (0.115, 0.085)); sp = v(P("spine1"), (0.066, 0.055)); mid = v(P("mid"), (0.098, 0.078))
    chest = v(P("chest"), (0.145, 0.105)); nb = v(P("chest").lerp(P("neck"), 0.5), 0.040)
    neck = v(P("neck"), 0.032); head = v(P("head"), 0.036)
    edges += [(pelvis, sp), (sp, mid), (mid, chest), (chest, nb), (nb, neck), (neck, head)]
    for s in (1, -1):
        sh = v(P("shoulder", s), 0.055); um = v(P("shoulder", s).lerp(P("elbow", s), 0.5), 0.026)
        el = v(P("elbow", s), 0.030); fu = v(P("elbow", s).lerp(P("wrist", s), 0.22), 0.026)
        fm = v(P("elbow", s).lerp(P("wrist", s), 0.6), 0.019)
        wr = v(P("wrist", s), 0.022); hand = v(P("wrist", s).lerp(P("tip", s), 0.28), (0.040, 0.014))
        edges += [(chest, sh), (sh, um), (um, el), (el, fu), (fu, fm), (fm, wr), (wr, hand)]
        hip = v(P("hip", s), 0.07); tm = v(P("hip", s).lerp(P("knee", s), 0.5), 0.036)
        kn = v(P("knee", s), 0.038); sm = v(P("knee", s).lerp(P("ankle", s), 0.5), 0.024)
        an = v(P("ankle", s), 0.026); toe = v(P("toe", s), (0.038, 0.016))
        edges += [(pelvis, hip), (hip, tm), (tm, kn), (kn, sm), (sm, an), (an, toe)]
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
    body_me.materials.append(MAT["skin"])
    box_uv(body)
    weight_auto(body)
    return body

def build_bones_showing(body):
    """Ribs, sternum, collarbones, spine, shoulder blades, hip bones and knobby joints pushing
    through the skin. Each bone is placed by casting a ray from inside the body to find the
    real skin surface, then sunk into it so only a ridge shows."""
    from mathutils.bvhtree import BVHTree
    me = body.data
    bvh = BVHTree.FromPolygons([body.matrix_world @ v.co for v in me.vertices], [tuple(p.vertices) for p in me.polygons])
    spine_pts = [P("pelvis"), P("spine1"), P("mid"), P("chest"), P("neck")]
    def centre(y):
        """Point on the body's centre line at this y."""
        for a, b in zip(spine_pts, spine_pts[1:]):
            if min(a.y, b.y) <= y <= max(a.y, b.y):
                return a.lerp(b, (y - a.y) / (b.y - a.y))
        return spine_pts[0] if y > spine_pts[0].y else spine_pts[-1]
    def surf(c, d, inset, maxd=0.16):
        d = d.normalized()
        hit = bvh.ray_cast(c, d, maxd)
        if hit[0] is None:                               # ran into a limb or missed: stay close to the body
            hit = bvh.ray_cast(c, d, 0.6)
            dist = min(hit[3], maxd * 0.8) if hit[0] is not None else maxd * 0.6
            return c + d * (dist - inset), d
        return hit[0] - d * inset, hit[1]
    def oriented(normal, along=Vector((0, 1, 0))):
        z = normal.normalized()
        x = along.cross(z); x.normalize()
        y = z.cross(x)
        m = Matrix((x, y, z)).transposed().to_4x4()
        return m
    out = []
    bm = bmesh.new()
    for i in range(7):                                  # ribs, wrapping from the spine round to the sternum
        y0 = -0.225 + i * 0.042
        r = 0.0095 if i < 6 else 0.0075
        for sd in (1, -1):
            pts = []
            for k in range(13):
                a = math.radians(22 + 136 * k / 12)
                y = y0 + 0.05 * math.sin(a) ** 2         # ribs sweep back as they go round
                p, _ = surf(centre(y), Vector((sd * math.sin(a), 0, math.cos(a))), r * 0.45, 0.13)
                pts.append(p)
            tube(bm, pts, [r * 0.4] + [r] * 11 + [r * 0.4], 6)
    st = [surf(centre(y), Vector((0, 0, -1)), 0.006)[0] for y in (-0.29, -0.23, -0.17, -0.11)]
    tube(bm, st, [0.010, 0.011, 0.010, 0.005], 6)       # sternum
    for sd in (1, -1):                                  # collarbones, from the base of the throat to the shoulder
        cc = P("chest") + Vector((0, 0.02, 0))
        pts = []
        for t in (0.0, 0.25, 0.5, 0.75, 1.0):
            target = Vector((sd * (0.025 + 0.16 * t), -0.32 + 0.07 * t, 0.80 + 0.06 * t - 0.03 * math.sin(math.pi * t)))
            pts.append(surf(cc, target - cc, 0.005, 0.3)[0])
        tube(bm, pts, [0.007, 0.0095, 0.009, 0.0095, 0.007], 6)
    rib = new_obj("ribs", bm, "skin"); box_uv(rib)
    weight_auto(rib, allowed={"hips", "spine", "chest", "neck"}); out.append(rib)

    bm = bmesh.new()
    y = J["pelvis"][1] + 0.05
    while y > J["neck"][1] + 0.02:                      # vertebrae: a row of knuckles down the back
        p, n = surf(centre(y), Vector((0, 0.15, 1)), 0.009)
        big = 1.0 if y > J["chest"][1] else 0.75
        ellipsoid(bm, p, (0.016 * big, 0.019 * big, 0.014 * big), oriented(n), u=8, v=6)
        y -= 0.041
    spine = new_obj("vertebrae", bm, "skin"); box_uv(spine)
    weight_auto(spine, allowed={"hips", "spine", "chest", "neck"}); out.append(spine)

    bm = bmesh.new()
    for sd in (1, -1):
        # shoulder blades: flat plates on the back with a sharp inner edge and a ridge across
        c = centre(-0.15)
        p, n = surf(c, Vector((sd * 0.62, 0.05, 0.78)), 0.007)
        m = Matrix.Translation(p) @ oriented(n) @ Matrix.Rotation(math.radians(20 * sd), 4, "Z")
        bmesh.ops.create_uvsphere(bm, u_segments=12, v_segments=8, radius=1.0, matrix=m @ Matrix.Diagonal((0.036, 0.066, 0.011, 1)))
        edge = [surf(centre(y), Vector((sd * 0.30, 0, 1)), 0.004)[0] for y in (-0.08, -0.13, -0.19, -0.23)]
        tube(bm, edge, [0.003, 0.0065, 0.006, 0.003], 5)
        ridge = [surf(centre(-0.17), Vector((sd * k, 0.0, 1)), 0.005)[0] for k in (0.35, 0.8, 1.6)]
        tube(bm, ridge, [0.004, 0.007, 0.009], 5)
        # hip bones: a ridge round the top of the pelvis, sharp at the front
        crest = []
        for k, yy in ((0.25, 0.44), (0.7, 0.40), (1.3, 0.34), (2.2, 0.30)):
            crest.append(surf(centre(yy), Vector((sd * k, 0, 1)), 0.006)[0])
        tube(bm, crest, [0.006, 0.012, 0.013, 0.007], 6)
    blades = new_obj("blades", bm, "skin"); box_uv(blades)
    weight_auto(blades, allowed={"hips", "spine", "chest", "neck"}); out.append(blades)

    bm = bmesh.new()
    def knob(joint, d, radii, inset):
        p, n = surf(joint, d, inset)
        ellipsoid(bm, p, radii, oriented(n), u=10, v=7)
    for sd in (1, -1):                                  # knobby joints
        el, wr, kn, an, sh = P("elbow", sd), P("wrist", sd), P("knee", sd), P("ankle", sd), P("shoulder", sd)
        knob(el, Vector((sd * 0.6, 0.6, 0.5)), (0.017, 0.017, 0.013), 0.008)          # point of the elbow
        knob(wr, Vector((sd * 0.7, 0.2, 0.6)), (0.012, 0.012, 0.009), 0.006)          # wrist bone
        knob(kn, Vector((sd * 0.3, -0.6, 0.7)), (0.022, 0.022, 0.014), 0.009)         # knee cap
        knob(an, Vector((sd, 0, 0.1)), (0.012, 0.014, 0.009), 0.005)                  # ankle bones
        knob(an, Vector((-sd, 0, 0.1)), (0.011, 0.013, 0.008), 0.005)
        knob(sh, Vector((sd * 0.5, -0.1, 1)), (0.022, 0.022, 0.012), 0.008)           # shoulder
        # ulna ridge along the back of the forearm, shin bone down the front of the leg
        ul = [surf(el.lerp(wr, t), Vector((sd * 0.3, 0.3, 1)), 0.004, 0.05)[0] for t in (0.08, 0.35, 0.65, 0.92)]
        tube(bm, ul, [0.004, 0.007, 0.006, 0.004], 5)
        tb = [surf(kn.lerp(an, t), Vector((0, -1, 0.15)), 0.005, 0.05)[0] for t in (0.1, 0.45, 0.85)]
        tube(bm, tb, [0.006, 0.008, 0.005], 5)
    knobs = new_obj("knobs", bm, "skin"); box_uv(knobs)
    weight_auto(knobs, allowed={n for n in SEG if "." in n}); out.append(knobs)
    return out

# ----------------------------------------------------------------------------- head
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

def head_base(D):
    """Base head shape for unit directions D (N x 3): tall gaunt skull, long narrow jaw."""
    dx, dy, dz = D[:, 0], D[:, 1], D[:, 2]
    RX, RY, RZ, ZC = 0.097, 0.110, 0.200, -0.035
    z = ZC + RZ * dz
    y = np.where(dy < 0, -RY * np.abs(dy) ** 0.8, RY * 1.10 * dy)
    taper = smoothstep(0.0, -0.235, z)
    x = RX * dx * (1 - 0.36 * taper) * (1 + 0.05 * smoothstep(0.02, 0.12, z))
    y = np.where(y > 0, y * (1 - 0.48 * taper), y * (1 - 0.15 * taper))
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
    # The black holes are whole faces. So that their edge is a clean ellipse and not a
    # staircase following the grid, the vertices on the boundary are slid onto the contour.
    CONT = 0.97
    fmat = [0] * len(fidx)
    for kind, mi in (("socket", 1), ("mouth", 2)):
        if kind == "socket":
            ev = socket_coords(X, Z)[0]
        else:
            ev = mouth_coords(X, Z)[0]
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
        for k in vin & vout:
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
                xn = X[k] / (MOUTH["rx"] * (1 + 0.14 * t))
                t, xn = t * f, xn * f
                Z[k] = MOUTH["cz"] + t * MOUTH["rz"]; X[k] = xn * MOUTH["rx"] * (1 + 0.14 * t)
    wf = smoothstep(0.15, -0.45, D[:, 1])            # only the front of the head gets a face
    h = face_height(X, Z)
    Y = Y - h * wf
    # the temples and cheeks also cave in from the side
    side = (0.009 * g2(np.abs(X), Z, 0.090, 0.045, 0.02, 0.035) + 0.008 * g2(np.abs(X), Z, 0.08, -0.08, 0.02, 0.05)) * np.abs(D[:, 0])
    X = X - np.sign(X) * side
    V = np.stack([X, Y, Z], 1)

    bm = bmesh.new()
    verts = [bm.verts.new(Vector(p)) for p in V]
    bm.verts.index_update()
    for f, mi in zip(fidx, fmat):
        bf = bm.faces.new([verts[k] for k in f])
        bf.material_index = mi
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    # UVs, per face: front projection, the back of the head on the right half of the texture
    uvl = bm.loops.layers.uv.new("UVMap")
    bm.normal_update()
    for f in bm.faces:
        # the painted face goes only on surfaces that look forward (and on the rims of the
        # holes); everything else gets the plain skin on the right half of the texture
        cx, cz = np.array([f.calc_center_median().x]), np.array([f.calc_center_median().z])
        near_hole = min(socket_coords(cx, cz)[0][0], mouth_coords(cx, cz)[0][0]) < 1.25
        front = f.material_index > 0 or (f.normal.y < 0.02 and f.normal.y < -0.45 * abs(f.normal.z)) or (near_hole and f.normal.y < 0.3)
        for l in f.loops:
            u = (l.vert.co.x - FX0) / (FX1 - FX0) * 0.5
            v = (l.vert.co.z - FZ0) / (FZ1 - FZ0)
            l[uvl].uv = (u if front else u + 0.5, v)
    # place it
    for v in bm.verts:
        v.co = hw(*v.co)
    ob = new_obj("head", bm, "face")
    ob.data.materials.append(MAT["socket"]); ob.data.materials.append(MAT["mouth"])
    # head / jaw weights: below the middle of the mouth the face hangs from the jaw
    gh, gj = ob.vertex_groups.new(name="head"), ob.vertex_groups.new(name="jaw")
    for vtx, (x, y, z) in zip(ob.data.vertices, V):
        wj = float(smoothstep(-0.095, -0.165, z) * smoothstep(0.07, -0.03, y))
        if wj < 1:
            gh.add([vtx.index], 1 - wj, "REPLACE")
        if wj > 0:
            gj.add([vtx.index], wj, "REPLACE")
    info = {"V": V, "D": D}
    return ob, info

def face_landmarks(info):
    """Positions (head-local) of the eyes and of the face centre, measured on the sculpted mesh."""
    V, D = info["V"], info["D"]
    front = D[:, 1] < 0
    out = {}
    for s in (1, -1):
        near = front & (np.hypot(V[:, 0] - s * SOCK["cx"], V[:, 2] - SOCK["cz"]) < 0.008)
        ybot = V[near, 1].max()
        out[s] = Vector((s * SOCK["cx"], ybot - 0.012, SOCK["cz"]))
    lips = front & (np.abs(V[:, 0]) < 0.03) & (V[:, 2] > -0.06) & (V[:, 2] < 0.06)
    out["face"] = Vector((0, V[lips, 1].min(), -0.07))
    return out

def build_head_parts():
    head, info = build_head()
    lm = face_landmarks(info)
    parts = [head]
    # pinpoint eyes, deep in the sockets
    bm = bmesh.new()
    for s in (1, -1):
        bmesh.ops.create_uvsphere(bm, u_segments=8, v_segments=6, radius=0.0026 * HS, matrix=Matrix.Translation(hw(*lm[s])))
    eyes = new_obj("eyes", bm, "eye"); weight_rigid(eyes, "head"); parts.append(eyes)
    if TEETH:
        # a few long, uneven needle teeth just inside the lips
        random.seed(9)
        V, D = info["V"], info["D"]
        front = D[:, 1] < 0
        em_all, ang_all = mouth_coords(V[:, 0], V[:, 2])
        rim = front & (em_all > 0.98) & (em_all < 1.12)
        bm = bmesh.new()
        jaw_pts = []
        n = 26
        for i in range(n):
            a = 2 * math.pi * i / n + random.uniform(-0.1, 0.1)
            if abs(math.sin(a)) < 0.6 or random.random() < 0.3:   # mostly top and bottom, with gaps
                continue
            t = math.sin(a)
            rx = MOUTH["rx"] * (1 + 0.14 * t)
            x, z = math.cos(a) * rx * 0.97, MOUTH["cz"] + t * MOUTH["rz"] * 0.97
            sel = rim & (np.abs(np.angle(np.exp(1j * (ang_all - a)))) < 0.25)
            ylip = V[sel, 1].min() if sel.any() else -0.09
            base = Vector((x, ylip + 0.007, z))
            inward = Vector((-x, 0, MOUTH["cz"] - z)); inward.normalize()
            length = random.uniform(0.010, 0.036)
            tip = base + inward * length + Vector((random.uniform(-0.003, 0.003), 0.004, 0))
            pts = [hw(*base), hw(*base.lerp(tip, 0.45)), hw(*tip)]
            tube(bm, pts, [0.0026 * HS, 0.0015 * HS, 0.0002], 5)
            jaw_pts.append(z < MOUTH["cz"])
        teeth = new_obj("teeth", bm, "teeth")
        gh, gj = teeth.vertex_groups.new(name="head"), teeth.vertex_groups.new(name="jaw")
        cz_world = hw(0, 0, MOUTH["cz"]).z
        for vtx in teeth.data.vertices:
            (gj if vtx.co.z < cz_world else gh).add([vtx.index], 1.0, "REPLACE")
        parts.append(teeth)
    return parts, lm

def build_digits():
    # long bony fingers with knobbly knuckles and long dark claws
    out = []
    for s, tag in ((1, "L"), (-1, "R")):
        skin_bm, claw_bm = bmesh.new(), bmesh.new()
        wrist, tipj = P("wrist", s), P("tip", s)
        fwd = (tipj - wrist); fwd.z = 0; fwd.normalize()
        side = Vector((-fwd.y, fwd.x, 0)) * s          # toward the outside of the hand
        palm = wrist.lerp(tipj, 0.28)
        fingers = [(-0.030, -24, 0.21), (-0.011, -8, 0.25), (0.010, 7, 0.24), (0.029, 22, 0.19), (-0.04, -66, 0.12)]
        for off, ang, length in fingers:
            d = (Matrix.Rotation(math.radians(ang) * s, 3, "Z") @ fwd)
            base = palm + side * off
            k1 = base + d * length * 0.36 + Vector((0, 0, 0.040))     # knuckles arch up like a spider's legs
            k2 = base + d * length * 0.68 + Vector((0, 0, 0.026))
            p3 = base + d * length + Vector((0, 0, -0.045))
            p3.z = max(p3.z, 0.014)
            pts = [base, base.lerp(k1, 0.5), k1, k1.lerp(k2, 0.5), k2, k2.lerp(p3, 0.5), p3]
            tube(skin_bm, pts, [0.012, 0.0095, 0.0125, 0.0085, 0.011, 0.0075, 0.0072], 7)
            c1 = p3 + d * 0.03 + Vector((0, 0, 0.004)); c2 = p3 + d * 0.065; c3 = p3 + d * 0.085
            c2.z = 0.010; c3.z = 0.002
            tube(claw_bm, [k2.lerp(p3, 0.75), p3 + d * 0.01, c1, c2, c3], [0.0068, 0.0072, 0.0052, 0.0028, 0.0004], 6)
        hand_skin = new_obj(f"fingers.{tag}", skin_bm, "skin"); box_uv(hand_skin)
        hand_claw = new_obj(f"claws.{tag}", claw_bm, "claw")
        for ob in (hand_skin, hand_claw):
            weight_rigid(ob, f"hand.{tag}"); out.append(ob)
        skin_bm, claw_bm = bmesh.new(), bmesh.new()
        toe, ankle = P("toe", s), P("ankle", s)
        fwd = (toe - ankle); fwd.z = 0; fwd.normalize()
        side = Vector((-fwd.y, fwd.x, 0)) * s
        for off, ang in ((-0.03, -18), (-0.01, -6), (0.01, 6), (0.03, 18)):
            d = (Matrix.Rotation(math.radians(ang) * s, 3, "Z") @ fwd)
            base = toe + side * off
            p1 = base + d * 0.06 + Vector((0, 0, 0.016)); p2 = base + d * 0.11; p2.z = 0.012
            tube(skin_bm, [base, base.lerp(p1, 0.5), p1, p2], [0.011, 0.0085, 0.0105, 0.007], 6)
            c2 = p2 + d * 0.05; c2.z = 0.003
            tube(claw_bm, [p1.lerp(p2, 0.8), p2 + d * 0.02, c2], [0.0065, 0.0042, 0.0005], 5)
        foot_skin = new_obj(f"toes.{tag}", skin_bm, "skin"); box_uv(foot_skin)
        foot_claw = new_obj(f"toeclaws.{tag}", claw_bm, "claw")
        for ob in (foot_skin, foot_claw):
            weight_rigid(ob, f"foot.{tag}"); out.append(ob)
    return out

LANDMARKS = {}
def build_generated():
    head_parts, lm = build_head_parts()
    LANDMARKS.update(lm)
    body = build_body()
    parts = [body] + build_bones_showing(body) + head_parts + build_digits()
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
    xs = [(ob.matrix_world @ v.co) for v in ob.data.vertices]
    lo = Vector((min(v.x for v in xs), min(v.y for v in xs), min(v.z for v in xs)))
    hi = Vector((max(v.x for v in xs), max(v.y for v in xs), max(v.z for v in xs)))
    k = 1.0 / (hi.z - lo.z)
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

def add_anchors(arm):
    """Empties on the head bone, exported as glTF nodes: the game puts the far-away eye
    pinpoints on eye_L / eye_R and frames the jump scare on face_anchor."""
    bpy.context.view_layer.update()
    out = {}
    if not LANDMARKS:
        return out
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

# ----------------------------------------------------------------------------- animation
AX = {"x": Vector((1, 0, 0)), "y": Vector((0, 1, 0)), "z": Vector((0, 0, 1))}

def pose(arm, frame, rots, hips_z=0.0):
    """rots: {bone: [(axis, degrees), ...]} with axes in armature space.
    For an upright bone +x leans it forward; for a hanging limb -x swings it forward.
    For the jaw, +x opens the mouth."""
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

def crawl(p, arm, leg, lift, twist, bob, jitter, thrust=0.0, jaw=10.0):
    """Diagonal crawl: left arm moves with the right leg. Limbs snap forward and plant."""
    s, c = math.sin, math.cos
    r = {
        "hips": [("z", twist * s(p)), ("y", 4 * s(p))],
        "spine": [("z", -twist * 0.7 * s(p))],
        "chest": [("z", -twist * s(p)), ("y", -7 * s(p))],
        "neck": [("z", twist * 0.7 * s(p)), ("x", -thrust)],
        "head": [("z", twist * s(p) + jitter * s(3 * p + 1)), ("y", jitter * 1.6 * s(2 * p + 0.4)), ("x", 3 * s(4 * p) - thrust * 0.5)],
        "jaw": [("x", jaw + jaw * 0.3 * s(2 * p + 0.5))],
    }
    for tag, sg, ph in (("L", 1, 0.0), ("R", -1, math.pi)):
        q = p + ph
        up = max(0.0, c(q)) ** 0.7                      # 1 while the hand is in the air moving forward
        r[f"upperarm.{tag}"] = [("x", -arm * s(q)), ("z", sg * 7 * c(q)), ("y", sg * 10 * up)]
        r[f"forearm.{tag}"] = [("x", -lift * up + arm * 0.25 * s(q))]
        r[f"hand.{tag}"] = [("x", lift * 1.1 * up - arm * 0.2 * s(q))]
        q = p + ph + math.pi                            # the leg on this side is half a cycle off
        up = max(0.0, c(q)) ** 0.7
        r[f"thigh.{tag}"] = [("x", -leg * s(q)), ("z", sg * 6 * c(q))]
        r[f"shin.{tag}"] = [("x", lift * 0.9 * up - leg * 0.3 * s(q))]
        r[f"foot.{tag}"] = [("x", -18 * up)]
    return r, -bob * (0.5 + 0.5 * c(2 * p))

def idle(p):
    s = math.sin
    snap = s(p) ** 9                                    # mostly still, then a sudden head tilt
    r = {
        "hips": [("z", 2 * s(p))],
        "spine": [("x", 1.5 * s(2 * p))], "chest": [("x", 2.5 * s(2 * p)), ("z", -2 * s(p))],
        "neck": [("z", 8 * snap), ("y", 10 * snap)],
        "head": [("y", 26 * snap + 3 * s(3 * p)), ("z", 9 * s(p + 1)), ("x", -5 + 4 * s(2 * p))],
        "jaw": [("x", 6 + 5 * s(p + 2) + 14 * snap)],   # the mouth slowly gapes, and stretches with the snap
    }
    for tag, sg in (("L", 1), ("R", -1)):
        r[f"upperarm.{tag}"] = [("x", 2 * s(2 * p + sg))]
        r[f"forearm.{tag}"] = [("x", 2 * s(2 * p + 1.5 * sg))]
        r[f"hand.{tag}"] = [("x", 9 * max(0.0, s(6 * p + sg * 1.3)) ** 3)]   # claws tapping the floor
        r[f"thigh.{tag}"] = [("x", 1.5 * s(2 * p))]
    return r, -0.02 * (0.5 + 0.5 * s(2 * p))

def scream(p):
    """Jump scare: head thrust forward, mouth stretched as wide as it goes, arms flung wide."""
    t = p / (2 * math.pi)                               # 0..1 over the clip, not a loop
    k = min(1.0, t / 0.12)
    k = k * k * (3 - 2 * k)
    s = math.sin
    tr = s(t * 160) * 1.5 + s(t * 97) * 1.0             # trembling
    r = {
        "hips": [("x", -6 * k)],
        "spine": [("x", -6 * k)],
        "chest": [("x", -10 * k)],
        "neck": [("x", -22 * k + tr * 0.5)],
        "head": [("x", 16 * k + tr), ("y", 4 * s(t * 23) * k)],
        "jaw": [("x", 10 + 18 * k + tr * 1.5)],
    }
    for tag, sg in (("L", 1), ("R", -1)):
        r[f"upperarm.{tag}"] = [("x", -40 * k), ("y", sg * 10 * k), ("z", sg * 30 * k)]
        r[f"forearm.{tag}"] = [("x", -20 * k + tr), ("z", sg * 25 * k)]
        r[f"hand.{tag}"] = [("x", -30 * k)]
        r[f"thigh.{tag}"] = [("x", 8 * k)]
    return r, 0.0

def animate(arm):
    # Short cycles: the game plays them fast so the limbs skitter while the body speed stays the same.
    make_action(arm, "Idle", 96, idle)
    make_action(arm, "Walk", 12, lambda p: crawl(p, arm=24, leg=20, lift=30, twist=8, bob=0.03, jitter=5, jaw=10))
    make_action(arm, "Run", 12, lambda p: crawl(p, arm=38, leg=30, lift=46, twist=13, bob=0.06, jitter=9, thrust=8, jaw=22))
    make_action(arm, "Scream", 40, scream)
    for pb in arm.pose.bones:
        pb.rotation_quaternion = Quaternion()
        pb.location = (0, 0, 0)

# ----------------------------------------------------------------------------- preview render
def solo(arm, name):
    for t in arm.animation_data.nla_tracks:
        t.mute = (name is not None and t.name != name)

def look(cam, target):
    cam.rotation_euler = (target - cam.location).to_track_quat("-Z", "Y").to_euler()

def render_preview(arm, anchors):
    cam_data = bpy.data.cameras.new("cam")
    cam_data.lens = 42
    cam_data.clip_start = 0.01
    cam = bpy.data.objects.new("cam", cam_data)
    col.objects.link(cam)
    cam.location = (-1.9, -3.1, 0.85)
    look(cam, Vector((0, -0.15, 0.48)))
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
    scene.cycles.samples = 48
    scene.cycles.device = "CPU"
    scene.render.resolution_x = 1000
    scene.render.resolution_y = 700
    scene.view_settings.view_transform = "Standard"
    # rest pose
    arm.data.pose_position = "REST"
    scene.frame_set(1)
    scene.render.filepath = OUT_PNG
    bpy.ops.render.render(write_still=True)
    # a frame from the run, to check the animation
    arm.data.pose_position = "POSE"
    solo(arm, "Run")
    scene.frame_set(4)
    scene.render.filepath = OUT_PNG_RUN
    bpy.ops.render.render(write_still=True)

    # close-ups in the dark, lit by a "flashlight" next to the camera
    sun.data.energy = 0.0
    bg.inputs[1].default_value = 0.03
    flash = bpy.data.objects.new("flash", bpy.data.lights.new("flash", "SPOT"))
    flash.data.energy = 25
    flash.data.spot_size = math.radians(50)
    flash.data.shadow_soft_size = 0.02
    col.objects.link(flash)
    # face: rest pose, from the front, slightly above
    arm.data.pose_position = "REST"
    scene.frame_set(1)
    bpy.context.view_layer.update()
    fc = anchors["face_anchor"].matrix_world.translation.copy()
    cam_data.lens = 70
    cam.location = fc + Vector((0.12, -0.95, 0.08))
    look(cam, fc + Vector((0, 0, 0.0)))
    flash.location = cam.location + Vector((0.12, 0, 0.08))
    look(flash, fc)
    scene.render.resolution_x = 800
    scene.render.resolution_y = 1000
    scene.render.filepath = OUT_PNG_FACE
    bpy.ops.render.render(write_still=True)
    # scream, framed like the game's jump scare (72 degree vertical fov, face 0.25 m away)
    arm.data.pose_position = "POSE"
    solo(arm, "Scream")
    scene.frame_set(24)
    bpy.context.view_layer.update()
    am = anchors["face_anchor"].matrix_world
    rot = am.to_quaternion().to_matrix().to_4x4()
    cam.matrix_world = Matrix.Translation(am.translation) @ rot @ Matrix.Translation((0, -0.22, 0)) @ Matrix.Rotation(math.radians(90), 4, "X")
    cam_data.sensor_fit = "VERTICAL"
    cam_data.angle = math.radians(72)
    flash.matrix_world = cam.matrix_world @ Matrix.Translation((0.08, -0.06, 0))
    flash.data.energy = 8
    scene.render.resolution_x = 960
    scene.render.resolution_y = 540
    scene.render.filepath = OUT_PNG_SCREAM
    bpy.ops.render.render(write_still=True)
    solo(arm, None)
    for o in (cam, sun, g, flash):
        bpy.data.objects.remove(o)

# ----------------------------------------------------------------------------- main
setup_materials()
if os.path.exists(READY_MADE):
    print("Using ready-made model:", READY_MADE)
    monster = load_ready_made()
else:
    monster = build_generated()
rig = build_rig(monster)
anchors = add_anchors(rig)
animate(rig)

tris = sum(len(p.vertices) - 2 for p in monster.data.polygons)
print("TRIANGLES", tris, "VERTS", len(monster.data.vertices))
for k, v in LANDMARKS.items():
    w = hw(*v)
    print("LANDMARK", k, "blender", tuple(round(c, 4) for c in w), "gltf", (round(w.x, 4), round(w.z, 4), round(-w.y, 4)))

os.makedirs(os.path.dirname(OUT_GLB), exist_ok=True)
bpy.ops.export_scene.gltf(
    filepath=OUT_GLB, export_format="GLB", export_animations=True,
    export_animation_mode="NLA_TRACKS", export_skins=True, export_yup=True,
    export_image_format="JPEG", export_jpeg_quality=88,
)
print("Exported", OUT_GLB, os.path.getsize(OUT_GLB), "bytes")
if "--no-render" not in sys.argv:
    render_preview(rig, anchors)
    print("Rendered", OUT_PNG, OUT_PNG_RUN, OUT_PNG_FACE, OUT_PNG_SCREAM)
