import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { createMaterials, applyWorldUV } from './materials.js';
import { buildProp } from './props.js';

// Turns the map data file into meshes, colliders and walkable surfaces.
// Axes: x runs from stairwell A to stairwell B, z is positive on the right-hand side
// when walking from A toward B, y is up. All units are metres.

const HINGED = new Set(['wood', 'woodWindow', 'fire', 'woodGlass', 'glassBlack', 'exit', 'steel', 'steelWindow']);
const DOOR_HEIGHT = { glassBlack: 2.5, exit: 2.3, elevator: 2.1, glassPanel: 2.75, barrier: 2.3 };
const SEE_THROUGH = new Set(['glassBlack', 'woodGlass', 'glassPanel', 'barrier']);

export function buildWorld(data) {
  const S = data.settings;
  const FH = S.floorHeight, CH = S.ceilingHeight, T = S.wallThickness;
  const levelY = (f) => (f - 1) * FH;
  // floor 0 is the basement: lower ceilings, and it is never lit
  const ceilFor = (f) => (f < 1 ? S.basementCeilingHeight ?? CH : CH);
  const mats = createMaterials();
  const batches = {};
  const colliders = [], surfaces = [], fixtures = [], doors = [], rooms = [], warnings = [];
  const group = new THREE.Group();

  // ---------- geometry helpers ----------
  const push = (mat, geo) => (batches[mat] ||= []).push(geo);
  function box(mat, cx, cy, cz, sx, sy, sz, rotY = 0) {
    const g = new THREE.BoxGeometry(sx, sy, sz);
    if (rotY) g.rotateY(rotY);
    g.translate(cx, cy, cz);
    push(mat, g);
  }
  function collider(cx, cz, sx, sz, y0, y1, extra) {
    const c = { cx, cz, hx: sx / 2, hz: sz / 2, y0, y1, rot: 0, ...extra };
    colliders.push(c);
    return c;
  }
  function solid(mat, cx, cy, cz, sx, sy, sz, extra) {
    box(mat, cx, cy, cz, sx, sy, sz);
    return collider(cx, cz, sx, sz, cy - sy / 2, cy + sy / 2, extra);
  }
  function quad(mat, x0, z0, x1, z1, y, up) {
    const g = new THREE.PlaneGeometry(x1 - x0, z1 - z0);
    g.rotateX(up ? -Math.PI / 2 : Math.PI / 2);
    g.translate((x0 + x1) / 2, y, (z0 + z1) / 2);
    push(mat, g);
  }
  function polyQuad(mat, pts, y, up) {
    const shape = new THREE.Shape(pts.map(([x, z]) => new THREE.Vector2(x, up ? -z : z)));
    const g = new THREE.ShapeGeometry(shape);
    g.rotateX(up ? -Math.PI / 2 : Math.PI / 2);
    g.translate(0, y, 0);
    push(mat, g);
  }

  // ---------- wall lines ----------
  // Every straight room edge is collected on a "line" (same floor, same axis, same coordinate).
  // Overlapping edges of neighbouring rooms merge into one wall; doors and openings cut gaps.
  const lines = new Map();
  const lineKey = (level, axis, coord) => `${level}|${axis}|${coord.toFixed(2)}`;
  function edge(level, axis, coord, a, b, h) {
    if (a > b) [a, b] = [b, a];
    const key = lineKey(level, axis, coord);
    let L = lines.get(key);
    if (!L) lines.set(key, (L = { level, axis, coord, segs: [], cuts: [] }));
    L.segs.push({ a, b, h });
  }
  function cut(level, axis, coord, a, b, top, who) {
    const L = lines.get(lineKey(level, axis, coord));
    if (!L) { warnings.push(`${who}: no wall found at ${axis === 'x' ? 'z' : 'x'}=${coord} on floor ${level}`); return false; }
    L.cuts.push({ a, b, top });
    return true;
  }
  function wallPiece(level, axis, coord, a, b, y0, y1, baseboard) {
    if (b - a < 0.01 || y1 - y0 < 0.01) return;
    const base = levelY(level), mid = (a + b) / 2, len = b - a;
    const cy = base + (y0 + y1) / 2;
    // the basement is bare poured concrete with no skirting
    const wm = level < 1 ? 'rawWall' : 'wall';
    if (level < 1) baseboard = false;
    if (axis === 'x') {
      solid(wm, mid, cy, coord, len, y1 - y0, T);
      if (baseboard) box('woodTrim', mid, base + 0.06, coord, len, 0.12, T + 0.03);
    } else {
      solid(wm, coord, cy, mid, T, y1 - y0, len);
      if (baseboard) box('woodTrim', coord, base + 0.06, mid, T + 0.03, 0.12, len);
    }
  }
  function buildLines() {
    for (const L of lines.values()) {
      L.segs.sort((p, q) => p.a - q.a);
      const merged = [];
      for (const s of L.segs) {
        const m = merged[merged.length - 1];
        if (m && s.a <= m.b + 1e-3) { m.b = Math.max(m.b, s.b); m.h = Math.max(m.h, s.h); }
        else merged.push({ ...s });
      }
      for (const m of merged) {
        let pieces = [{ a: m.a - T / 2, b: m.b + T / 2 }];
        for (const c of L.cuts) {
          const next = [];
          // a cut that reaches the end of the wall also removes the corner stub
          const ca = c.a <= m.a + 1e-3 ? -Infinity : c.a, cb = c.b >= m.b - 1e-3 ? Infinity : c.b;
          for (const p of pieces) {
            if (cb <= p.a || ca >= p.b) { next.push(p); continue; }
            if (ca > p.a) next.push({ a: p.a, b: ca });
            if (cb < p.b) next.push({ a: cb, b: p.b });
          }
          pieces = next;
          const a = Math.max(c.a, m.a), b = Math.min(c.b, m.b);
          if (b > a && c.top < m.h) wallPiece(L.level, L.axis, L.coord, a, b, c.top, m.h, false);
        }
        for (const p of pieces) wallPiece(L.level, L.axis, L.coord, p.a, p.b, 0, m.h, true);
      }
    }
  }

  // ---------- rooms ----------
  const FLOOR_MAT = { concrete: 'concrete', carpet: 'carpet', raw: 'rawFloor' };
  const CEIL_MAT = { smooth: 'ceilingSmooth', tile: 'ceilingTile', raw: 'rawCeiling' };
  function addRoom(r) {
    const y = levelY(r.floor), h = r.height ?? ceilFor(r.floor);
    const pts = r.shape ?? [[r.x, r.z], [r.x + r.w, r.z], [r.x + r.w, r.z + r.d], [r.x, r.z + r.d]];
    const xs = pts.map((p) => p[0]), zs = pts.map((p) => p[1]);
    const rec = {
      id: r.id, name: r.name ?? r.id, floor: r.floor, y, h, pts,
      x0: Math.min(...xs), x1: Math.max(...xs), z0: Math.min(...zs), z1: Math.max(...zs),
    };
    rooms.push(rec);
    surfaces.push({ x0: rec.x0, x1: rec.x1, z0: rec.z0, z1: rec.z1, yA: y, yB: y });
    const fm = FLOOR_MAT[r.floorMat ?? (r.floor < 1 ? 'raw' : 'concrete')];
    if (r.shape) polyQuad(fm, pts, y, true); else quad(fm, rec.x0, rec.z0, rec.x1, rec.z1, y, true);

    const ceil = r.ceiling ?? (r.floor < 1 ? 'raw' : 'smooth');
    if (ceil === 'vault') {
      // shallow barrel vault running along x
      const w = rec.z1 - rec.z0, rise = 0.35, len = rec.x1 - rec.x0;
      const R = (w * w / 4 + rise * rise) / (2 * rise), half = Math.asin(w / 2 / R);
      const g = new THREE.CylinderGeometry(R, R, len, 14, 1, true, -half, half * 2);
      g.rotateX(-Math.PI / 2); g.rotateY(Math.PI / 2);
      g.translate((rec.x0 + rec.x1) / 2, y + h + rise - R, (rec.z0 + rec.z1) / 2);
      push('ceilingVault', g);
      box('wall', rec.x0 + 0.03, y + h + rise / 2, (rec.z0 + rec.z1) / 2, 0.06, rise, w);
      box('wall', rec.x1 - 0.03, y + h + rise / 2, (rec.z0 + rec.z1) / 2, 0.06, rise, w);
    } else if (ceil !== 'none') {
      const cm = CEIL_MAT[ceil];
      if (r.shape) polyQuad(cm, pts, y + h, false); else quad(cm, rec.x0, rec.z0, rec.x1, rec.z1, y + h, false);
    }

    for (let i = 0; i < pts.length; i++) {
      const [ax, az] = pts[i], [bx, bz] = pts[(i + 1) % pts.length];
      if (Math.abs(az - bz) < 1e-6) edge(r.floor, 'x', az, ax, bx, h);
      else if (Math.abs(ax - bx) < 1e-6) edge(r.floor, 'z', ax, az, bz, h);
      else {
        // angled wall (display alcove)
        const dx = bx - ax, dz = bz - az, len = Math.hypot(dx, dz) + T * 0.6, rot = Math.atan2(-dz, dx);
        const cx = (ax + bx) / 2, cz = (az + bz) / 2;
        box('wall', cx, y + h / 2, cz, len, h, T, rot);
        box('woodTrim', cx, y + 0.06, cz, len, 0.12, T + 0.03, rot);
        colliders.push({ cx, cz, hx: len / 2, hz: T / 2, y0: y, y1: y + h, rot });
      }
    }
    addFixtures(r, rec);
    return rec;
  }

  function addFixtures(r, rec) {
    const type = r.lights ?? 'panel';
    if (type === 'none' || r.floor < 1) return; // the basement has no fixtures at all
    const w = rec.x1 - rec.x0, d = rec.z1 - rec.z0, sp = r.lightSpacing ?? 4.4;
    const nx = Math.max(1, Math.round(w / sp)), nz = Math.max(1, Math.round(d / sp));
    for (let i = 0; i < nx; i++) for (let j = 0; j < nz; j++) {
      const x = rec.x0 + (w * (i + 0.5)) / nx, z = rec.z0 + (d * (j + 0.5)) / nz;
      fixtures.push({ type, x, y: rec.y + rec.h, z, alongX: w >= d, room: rec.id, on: true });
      // grey acoustic ceiling panels between the drum lights on floor 1
      if (type === 'drum' && nx > 1 && i < nx - 1 && nz === 1) {
        box('acoustic', x + w / nx / 2, rec.y + rec.h - 0.03, z, Math.min(2.4, w / nx - 1.2), 0.05, Math.min(1.5, d - 0.6));
      }
    }
  }

  // ---------- doors ----------
  function leafMeshes(type, w, h) {
    // leaf-local space: hinge at x=0, leaf runs to x=w, y up from the floor, z is thickness
    const parts = [];
    const add = (mat, x, y, z, sx, sy, sz) => parts.push({ mat, x, y, z, sx, sy, sz });
    const th = 0.05;
    if (type === 'wood' || type === 'woodWindow') {
      add('woodDoor', w / 2, h / 2, 0, w, h, th);
      if (type === 'woodWindow') add('glassDark', w * 0.52, h * 0.68, 0, w * 0.5, 0.75, th + 0.012);
      add('metalDark', w - 0.09, 1.0, 0, 0.12, 0.03, th + 0.12);
    } else if (type === 'steel' || type === 'steelWindow') {
      add('steel', w / 2, h / 2, 0, w, h, th + 0.01);
      if (type === 'steelWindow') add('glassDark', w * 0.5, h * 0.7, 0, w * 0.22, 0.5, th + 0.022);
      add('metalDark', w - 0.1, 1.0, 0, 0.12, 0.03, th + 0.12);
    } else if (type === 'fire') {
      add('woodFire', w / 2, h / 2, 0, w, h, th + 0.01);
      add('metalDark', w / 2, 1.02, 0, w * 0.84, 0.07, th + 0.14); // push bar
    } else if (type === 'glassBlack' || type === 'woodGlass') {
      const fm = type === 'glassBlack' ? 'black' : 'woodDoor', st = type === 'glassBlack' ? 0.07 : 0.13;
      add(fm, st / 2, h / 2, 0, st, h, th);
      add(fm, w - st / 2, h / 2, 0, st, h, th);
      add(fm, w / 2, h - st / 2, 0, w - st * 2, st, th);
      add(fm, w / 2, 0.11, 0, w - st * 2, 0.22, th);
      add('glassDark', w / 2, h / 2 + 0.07, 0, w - st * 2, h - st - 0.22, 0.02);
      add(type === 'glassBlack' ? 'black' : 'metalDark', w - st - 0.04, 1.05, 0, 0.03, 0.3, th + 0.14);
    } else if (type === 'exit') {
      add('woodDoor', w / 2, h / 2, 0, w, h, th + 0.01);
      const cols = ['paneRed', 'paneAmber', 'paneBlue', 'paneGreen'];
      for (let r = 0; r < 3; r++) for (let c = 0; c < 2; c++) {
        add(cols[(r * 2 + c + (w > 0.85 ? 1 : 0)) % 4], w * (0.3 + c * 0.4), 0.75 + r * 0.55, 0, w * 0.28, 0.4, th + 0.03);
      }
      add('brass', w - 0.1, 1.05, 0, 0.04, 0.25, th + 0.14);
    } else if (type === 'elevator') {
      add('metalElev', w / 2, h / 2, 0, w, h, th);
      add('brass', w * 0.22, 1.1, 0, 0.07, 0.3, th + 0.03);
      add('glassDark', w * 0.7, 1.55, 0, 0.2, 0.2, th + 0.012);
    }
    return parts.map((p) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(p.sx, p.sy, p.sz), mats[p.mat]);
      m.position.set(p.x, p.y, p.z);
      m.userData.mat = p.mat;
      m.castShadow = m.receiveShadow = true;
      return m;
    });
  }

  function addDoor(d) {
    const type = d.type ?? 'wood';
    const w = d.width ?? 0.95;
    const level = d.floor, base = levelY(level);
    const axis = d.wallAlong; // 'x': the wall runs along x (door sits at a fixed z); 'z': the other way
    const isOpening = type === 'opening';
    const h = d.height ?? (isOpening ? (w > 3 ? 2.75 : 2.3) : DOOR_HEIGHT[type] ?? 2.1);
    const coord = axis === 'x' ? d.z : d.x, centre = axis === 'x' ? d.x : d.z;
    // optional glazed side lights (metres wide, each side) and a coloured transom (metres tall) round the leaf
    const side = d.sidelights ?? 0, tr = d.transom ?? 0;
    cut(level, axis, coord, centre - w / 2 - side, centre + w / 2 + side, h + tr, `door ${d.id}`);

    const g = new THREE.Group();
    if (axis === 'x') g.position.set(d.x - w / 2, base, d.z);
    else { g.position.set(d.x, base, d.z - w / 2); g.rotation.y = -Math.PI / 2; }

    // casing
    const frameMat = d.frame ?? (type === 'fire' || type === 'elevator' || type === 'steel' || type === 'steelWindow' || level < 1 ? 'metalDark'
      : type === 'glassBlack' || type === 'glassPanel' || type === 'barrier' ? 'black' : 'woodTrim');
    const fw = 0.1, fd = T + 0.06;
    const frame = [];
    if (!(isOpening && w > 3) && type !== 'barrier' && d.frame !== 'none') {
      frame.push([-fw / 2, h / 2, fw, h], [w + fw / 2, h / 2, fw, h], [w / 2, h + fw / 2, w + fw * 2, fw]);
    }
    for (const [x, y, sx, sy] of frame) {
      const m = new THREE.Mesh(new THREE.BoxGeometry(sx, sy, fd), mats[frameMat]);
      m.position.set(x, y, 0); m.userData.mat = frameMat; g.add(m);
    }

    const rec = {
      id: d.id, data: d, type, locked: !!d.locked, open: false, group: g, pivots: [], collider: null,
      message: d.message ?? (d.locked ? 'Locked.' : ''),
      x: d.x, z: d.z, y: base, width: w, height: h, axis,
      isExit: d.id === S.exitDoor,
    };

    const fixed = (mat, x, y, z, sx, sy, sz) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(sx, sy, sz), mats[mat]);
      m.position.set(x, y, z); m.userData.mat = mat; g.add(m);
    };
    if (side || tr) {
      const ox = -side, ow = w + side * 2, top = h + tr;
      fixed(frameMat, ox - fw / 2, top / 2, 0, fw, top, fd);
      fixed(frameMat, ox + ow + fw / 2, top / 2, 0, fw, top, fd);
      fixed(frameMat, ox + ow / 2, top + fw / 2, 0, ow + fw * 2, fw, fd);
      for (const sx of side ? [-side / 2 - fw / 2, w + side / 2 + fw / 2] : []) {
        fixed('glassDark', sx, h / 2 + 0.2, 0, side - fw, h - 0.4, 0.03);
        fixed(frameMat, sx, 0.2, 0, side - fw, 0.4, fd - 0.04);
        const cx = axis === 'x' ? d.x - w / 2 + sx : d.x, cz = axis === 'x' ? d.z : d.z - w / 2 + sx;
        collider(cx, cz, axis === 'x' ? side : T, axis === 'x' ? T : side, base, base + h, { seeThrough: true });
      }
      if (tr) {
        const cols = ['paneRed', 'paneAmber', 'paneGreen', 'paneBlue'], n = Math.max(3, Math.round(ow / 0.32));
        for (let i = 0; i < n; i++) fixed(cols[i % 4], ox + (ow * (i + 0.5)) / n, h + fw / 2 + (tr - fw) / 2, 0, ow / n - 0.04, tr - fw - 0.04, 0.03);
      }
    }
    if (type === 'glassPanel') {
      fixed('glassClear', w / 2, h / 2, 0, w, h, 0.03);
      fixed('black', w / 2, 0.05, 0, w, 0.1, 0.08);
    } else if (type === 'barrier') {
      fixed('black', 0.05, 0.5, 0, 0.08, 1.0, 0.08);
      fixed('black', w - 0.05, 0.5, 0, 0.08, 1.0, 0.08);
      fixed('red', w / 2, 0.92, 0, w - 0.1, 0.07, 0.02);
      fixed('red', w / 2, 0.5, 0, w - 0.1, 0.07, 0.02);
    } else if (type === 'glassBlack') {
      // fixed glass transom with a black bar above the doors (the arches sit behind it)
      fixed('black', w / 2, h - 0.38, 0, w, 0.07, 0.08);
      fixed('glassDark', w / 2, h - 0.17, 0, w, 0.34, 0.02);
    }

    if (!isOpening && type !== 'glassPanel' && type !== 'barrier') {
      const leafH = type === 'glassBlack' ? h - 0.4 : h;
      const double = d.double ?? (w > 1.4 && type !== 'elevator');
      const lw = double ? w / 2 : w;
      // default swing: away from the hallway for side doors, into the hallway for doors across it
      const dir = d.swing ?? (axis === 'x' ? (d.z < 0 ? -1 : 1) : (d.x < S.hallMidX ? 1 : -1));
      const phi = (axis === 'x' ? -dir : dir) * (Math.PI / 2);
      const p1 = new THREE.Group();
      for (const m of leafMeshes(type, lw - 0.01, leafH)) p1.add(m);
      g.add(p1);
      rec.pivots.push({ obj: p1, closed: 0, opened: phi });
      if (double) {
        const p2 = new THREE.Group();
        p2.position.x = w; p2.rotation.y = Math.PI;
        for (const m of leafMeshes(type, lw - 0.01, leafH)) p2.add(m);
        g.add(p2);
        rec.pivots.push({ obj: p2, closed: Math.PI, opened: Math.PI - phi });
      }
    }

    if (!isOpening) {
      const sx = axis === 'x' ? w : T, sz = axis === 'x' ? T : w;
      rec.collider = collider(d.x, d.z, sx, sz, base, base + h, { seeThrough: SEE_THROUGH.has(type), door: rec.id });
    }

    // t runs 0 (closed) .. 1 (open); doors.js animates it toward target
    rec.t = 0; rec.target = 0; rec.speed = 2.4;
    rec.pose = () => {
      const e = rec.t * rec.t * (3 - 2 * rec.t);
      for (const p of rec.pivots) p.obj.rotation.y = p.closed + (p.opened - p.closed) * e;
      if (rec.collider) rec.collider.enabled = rec.t < 0.5;
    };

    const dynamic = HINGED.has(type) && !rec.locked || rec.isExit;
    rec.dynamic = dynamic;
    if (dynamic) {
      group.add(g);
    } else {
      // never moves: bake into the static batches
      g.updateMatrixWorld(true);
      g.traverse((m) => {
        if (!m.isMesh) return;
        const geo = m.geometry.clone().applyMatrix4(m.matrixWorld);
        push(m.userData.mat, geo);
      });
      rec.group = null;
    }
    doors.push(rec);
  }

  // ---------- stairwells ----------
  function addStairwell(sw) {
    const ST = S.stairs;
    const sx = sw.x, z0 = sw.z, len = sw.length, ex = sx + len;
    const run = ST.run, n = ST.steps, rise = FH / 2 / n, tread = run / n;
    const zf = z0 + run, z1 = zf + ST.landingDepth;
    const gap = 0.2, laneW = (len - gap) / 2;
    const A0 = sx, A1 = sx + laneW, B0 = ex - laneW, B1 = ex; // lane A (A side) goes down, lane B goes up
    const fl = [...sw.floors].sort((p, q) => p - q);
    const lowest = fl[0], highest = fl[fl.length - 1];
    const hasSmall = !!sw.smallRoom;
    const yBot = levelY(lowest) - (hasSmall ? FH / 2 : 0), yTop = levelY(highest) + FH * 1.5;
    const midX = (sx + ex) / 2, midZ = (z0 + z1) / 2;
    const slope = Math.atan2(FH / 2, run), slopeLen = Math.hypot(run, FH / 2);

    // shaft shell
    solid('wall', sx, (yBot + yTop) / 2, midZ, T, yTop - yBot, z1 - z0 + T);
    solid('wall', ex, (yBot + yTop) / 2, midZ, T, yTop - yBot, z1 - z0 + T);
    const outerBot = hasSmall ? yBot + sw.smallRoom.height : yBot;
    solid('wall', midX, (outerBot + yTop) / 2, z1, len + T, yTop - outerBot, T);
    quad('ceilingSmooth', sx, z0, ex, z1, yTop, false);
    // wall below the lowest landing edge
    if (hasSmall) solid('wall', midX, (yBot + levelY(lowest)) / 2, z0 - T / 2, len, levelY(lowest) - yBot, T);
    if (hasSmall) box('wall', sx + laneW + gap / 2, (yBot + levelY(lowest)) / 2, (z0 + zf) / 2, gap, levelY(lowest) - yBot, run);
    // centre divider: solid for movement, open to sight (it is a railing)
    collider(sx + laneW + gap / 2, (z0 + zf) / 2, gap, run, yBot, yTop, { seeThrough: true });

    const sloped = (mat, x, yMid, sxz, syz, up) => {
      const g = new THREE.BoxGeometry(sxz, syz, slopeLen);
      g.rotateX(up ? -slope : slope);
      g.translate(x, yMid, (z0 + zf) / 2);
      push(mat, g);
    };

    for (const f of fl) {
      const Y = levelY(f), top = f === highest;
      // open the hallway wall onto the stairs, and close the slab edge above the opening
      cut(f, 'x', z0, sx, ex, 99, `stairwell ${sw.id}`);
      const fasciaTop = top ? yTop : Y + FH, fasciaBot = Y + ceilFor(f);
      box('wall', midX, (fasciaBot + fasciaTop) / 2, z0 - T / 2, len, fasciaTop - fasciaBot, T);

      // lane B: up half a floor
      for (let i = 0; i < n; i++) {
        const ty = Y + (i + 1) * rise;
        box('concreteStair', (B0 + B1) / 2, ty - (rise + 0.2) / 2, z0 + (i + 0.5) * tread, laneW, rise + 0.2, tread);
      }
      surfaces.push({ x0: B0, x1: B1, z0, z1: zf, yA: Y, yB: Y + FH / 2 });
      // lane A: down half a floor
      const laneA = f !== lowest || hasSmall;
      if (laneA) {
        for (let i = 0; i < n; i++) {
          const ty = Y - (i + 1) * rise;
          box('concreteStair', (A0 + A1) / 2, ty - (rise + 0.2) / 2, z0 + (i + 0.5) * tread, laneW, rise + 0.2, tread);
        }
        surfaces.push({ x0: A0, x1: A1, z0, z1: zf, yA: Y, yB: Y - FH / 2 });
      } else {
        solid('wall', (A0 + A1) / 2, Y + CH / 2, z0, laneW, CH, T);
      }
      // half-landing above this floor
      const hy = Y + FH / 2;
      box('concreteStair', midX, hy - 0.1, (zf + z1) / 2, len, 0.2, z1 - zf);
      surfaces.push({ x0: sx, x1: ex, z0: zf, z1, yA: hy, yB: hy });
      // two tall dark windows on the half-landing (none below ground)
      if (hy >= 0) for (const wx of [(A0 + A1) / 2, (B0 + B1) / 2]) {
        box('white', wx, hy + 1.75, z1 - T / 2 - 0.02, 1.05, 1.9, 0.05);
        box('windowNight', wx, hy + 1.75, z1 - T / 2 - 0.05, 0.85, 1.7, 0.03);
        box('white', wx, hy + 1.75, z1 - T / 2 - 0.07, 0.9, 0.05, 0.03);
      }

      // railings (black metal) along the inner side of each flight + wall handrails
      const railB = B0 - 0.05, railA = A1 + 0.05;
      sloped('black', railB, Y + FH / 4 + 0.95, 0.05, 0.05, true);
      sloped('black', railB, Y + FH / 4 + 0.12, 0.04, 0.04, true);
      sloped('black', ex - T / 2 - 0.06, Y + FH / 4 + 0.92, 0.05, 0.1, true);
      if (laneA) {
        sloped('black', railA, Y - FH / 4 + 0.95, 0.05, 0.05, false);
        sloped('black', railA, Y - FH / 4 + 0.12, 0.04, 0.04, false);
        sloped('black', sx + T / 2 + 0.06, Y - FH / 4 + 0.92, 0.05, 0.1, false);
      }
      for (let i = 0; i < n * 2; i++) {
        const t = (i + 0.5) / (n * 2), z = z0 + t * run;
        box('black', railB, Y + t * (FH / 2) + 0.54, z, 0.018, 0.82, 0.018);
        if (laneA) box('black', railA, Y - t * (FH / 2) + 0.54, z, 0.018, 0.82, 0.018);
      }
      box('black', midX, Y + 0.52, z0 + 0.05, gap - 0.04, 1.04, 0.1); // newel post on the landing

      if (top) {
        // the flight above the top floor is blocked off
        collider((B0 + B1) / 2, z0 + 0.2, laneW, 0.1, Y, Y + CH, { seeThrough: true });
        box('woodFire', (B0 + B1) / 2, Y + 0.55, z0 + 0.2, laneW, 0.16, 0.04);
        box('woodFire', (B0 + B1) / 2, Y + 1.05, z0 + 0.2, laneW, 0.16, 0.04);
        box('woodFire', (B0 + B1) / 2, Y + 1.55, z0 + 0.2, laneW, 0.16, 0.04);
        box('red', (B0 + B1) / 2, Y + 1.05, z0 + 0.17, 0.5, 0.3, 0.02);
      }
    }

    if (hasSmall) {
      // small room half a level below the lowest floor, reached by the last flight of lane A
      const sr = sw.smallRoom, lvl = lowest - 0.5;
      addRoom({
        id: `${sw.id}_small_room`, name: sr.name ?? 'Small room under the stairs', floor: lvl,
        x: sx, z: zf, w: len, d: sr.depth, height: sr.height, lights: 'none', ceiling: 'smooth',
      });
      addDoor({ id: `${sw.id}_small_room_door`, floor: lvl, wallAlong: 'x', x: (A0 + A1) / 2, z: zf, width: laneW - 0.3, type: 'opening', height: 2.2 });
      // small high window on the far wall
      box('white', midX, yBot + 1.9, zf + sr.depth - T / 2 - 0.02, 0.8, 0.7, 0.05);
      box('windowNight', midX, yBot + 1.9, zf + sr.depth - T / 2 - 0.05, 0.62, 0.52, 0.03);
    }
    return { id: sw.id, x0: sx, x1: ex, z0, z1, zf, floors: fl };
  }

  // ---------- build ----------
  for (const r of data.rooms) addRoom(r);
  const stairwells = (data.stairwells ?? []).map(addStairwell);
  for (const d of data.doors) addDoor(d);
  const cyl = (mat, x, y, z, r, h) => { const g = new THREE.CylinderGeometry(r, r, h, 14); g.translate(x, y, z); push(mat, g); };
  const blob = (mat, x, y, z, rx, ry, rz) => { const g = new THREE.SphereGeometry(1, 10, 8); g.scale(rx, ry, rz); g.translate(x, y, z); push(mat, g); };
  for (const p of data.props ?? []) buildProp(p, { box, collider, levelY, cyl, blob, warn: (w) => warnings.push(w) });
  buildLines();

  for (const [name, geos] of Object.entries(batches)) {
    const mat = mats[name];
    if (!mat) { warnings.push(`unknown material ${name}`); continue; }
    const merged = mergeGeometries(geos, false);
    if (mat.userData.tile) applyWorldUV(merged, mat.userData.tile);
    const mesh = new THREE.Mesh(merged, mat);
    mesh.castShadow = !mat.transparent;
    mesh.receiveShadow = true;
    mesh.name = `static:${name}`;
    group.add(mesh);
    for (const g of geos) g.dispose();
  }

  for (const w of warnings) console.warn('[map]', w);
  return { group, colliders, surfaces, fixtures, doors, rooms, stairwells, warnings, mats, levelY };
}
