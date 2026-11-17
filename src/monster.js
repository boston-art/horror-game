import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

// ---------------------------------------------------------------- navigation graph
// Built automatically from the map: nodes inside every room, a pair of nodes at every
// passable door, and a chain of nodes up each stairwell.
function buildNav(world, data, physics) {
  const S = data.settings, FH = S.floorHeight;
  const nodes = [];
  const add = (x, y, z, extra = {}) => { const n = { id: nodes.length, x, y, z, links: [], ...extra }; nodes.push(n); return n; };
  const link = (a, b, door = null) => {
    const cost = Math.hypot(a.x - b.x, a.z - b.z, a.y - b.y) + (door ? 2 : 0);
    a.links.push({ to: b, cost, door }); b.links.push({ to: a, cost, door });
  };
  const roomAt = (x, z, y) => {
    let best = null;
    for (const r of world.rooms) {
      if (Math.abs(r.y - y) > 0.5 || x < r.x0 || x > r.x1 || z < r.z0 || z > r.z1) continue;
      if (!best || (r.x1 - r.x0) * (r.z1 - r.z0) < (best.x1 - best.x0) * (best.z1 - best.z0)) best = r;
    }
    return best;
  };
  const clear = (a, b) => {
    const dx = b.x - a.x, dz = b.z - a.z, d = Math.hypot(dx, dz);
    if (d < 0.01) return true;
    for (const h of [0.5, 1.4]) if (physics.raycast(a.x, a.y + h, a.z, dx / d, 0, dz / d, d, false, true) < d) return false;
    return true;
  };

  // room nodes
  for (const r of world.rooms) {
    if (r.id.startsWith('f1_steps_down') || r.id.includes('stall')) continue;
    const w = r.x1 - r.x0, d = r.z1 - r.z0;
    const nx = Math.max(1, Math.ceil(w / 4.5)), nz = Math.max(1, Math.ceil(d / 4.5));
    for (let i = 0; i < nx; i++) for (let j = 0; j < nz; j++) {
      const x = r.x0 + (w * (i + 0.5)) / nx, z = r.z0 + (d * (j + 0.5)) / nz;
      if (physics.raycast(x, r.y + 3, z, 0, -1, 0, 2.6, false, true) < 2.6) continue; // sits inside furniture
      add(x, r.y, z, { room: r.id, patrol: !r.id.includes('small_room') && !r.id.includes('pocket') });
    }
  }
  // door nodes
  for (const d of world.doors) {
    if (d.type === 'glassPanel' || d.type === 'barrier' || d.type === 'elevator') continue;
    if (d.locked && !d.isExit) continue;
    if (d.isExit) continue;
    const off = 0.65, sides = d.axis === 'x' ? [[d.x, d.z - off], [d.x, d.z + off]] : [[d.x - off, d.z], [d.x + off, d.z]];
    const pair = sides.map(([x, z]) => add(x, d.y, z, { room: roomAt(x, z, d.y)?.id, doorNode: true }));
    link(pair[0], pair[1], d.type === 'opening' ? null : d);
  }
  // stairwells
  for (const sw of data.stairwells ?? []) {
    const ST = S.stairs, laneW = (sw.length - 0.2) / 2;
    const ax = sw.x + laneW / 2, bx = sw.x + sw.length - laneW / 2;
    const zTop = sw.z - 0.45, zMid = sw.z + ST.run + ST.landingDepth / 2;
    const fl = [...sw.floors].sort((a, b) => a - b);
    let prevHA = null;
    for (const f of fl) {
      const Y = (f - 1) * FH;
      const footB = add(bx, Y, zTop, { room: roomAt(bx, zTop, Y)?.id, stair: true });
      const footA = add(ax, Y, zTop, { room: roomAt(ax, zTop, Y)?.id, stair: true });
      link(footA, footB);
      if (prevHA) link(prevHA, footA);          // lane A comes up from the half-landing below
      prevHA = null;
      if (f !== fl[fl.length - 1]) {
        const hb = add(bx, Y + FH / 2, zMid, { stair: true }), ha = add(ax, Y + FH / 2, zMid, { stair: true });
        link(footB, hb); link(hb, ha);          // lane B goes up to the half-landing, then across it
        prevHA = ha;
      }
      if (f === fl[0] && sw.smallRoom) {
        const zb = sw.z + ST.run + 0.6, yb = Y - FH / 2;
        link(footA, add(ax, yb, zb, { room: roomAt(ax, zb, yb)?.id, stair: true }));
      }
    }
  }
  // same-room links where the straight line is clear
  for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) {
    const a = nodes[i], b = nodes[j];
    if (!a.room || a.room !== b.room || Math.abs(a.y - b.y) > 0.1) continue;
    if (Math.hypot(a.x - b.x, a.z - b.z) > 14) continue;
    if (clear(a, b)) link(a, b);
  }
  return { nodes, clear };
}

function astar(nodes, start, goal) {
  const open = new Set([start]), came = new Map(), g = new Map([[start, 0]]);
  const h = (n) => Math.hypot(n.x - goal.x, n.z - goal.z, (n.y - goal.y) * 2);
  const f = new Map([[start, h(start)]]);
  while (open.size) {
    let cur = null;
    for (const n of open) if (!cur || f.get(n) < f.get(cur)) cur = n;
    if (cur === goal) {
      const path = [cur];
      while (came.has(cur)) { cur = came.get(cur); path.unshift(cur); }
      return path;
    }
    open.delete(cur);
    for (const l of cur.links) {
      const t = g.get(cur) + l.cost;
      if (t < (g.get(l.to) ?? Infinity)) {
        came.set(l.to, cur); g.set(l.to, t); f.set(l.to, t + h(l.to)); open.add(l.to);
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------- the monster
// Uniform scale of the whole monster. The glb (tools/build_monster.py) is modelled at its true
// size: a 2.5 m tall, narrow figure (under 0.46 m wide while moving) that walks hunched at about
// 2.3 m and ducks to about 1.6 m to pass under the 2.1 m door lintels.
const SIZE = 1.0;
const SPEED = { patrol: 1.5, investigate: 2.1, chase: 4.0, search: 1.9 };
// face centre in model space at 1x (model faces +z), used if the glb has no face_anchor node
const HEAD = new THREE.Vector3(0, 2.34, 0.255);
// Its eyes are about 2.3 m up while it walks; it also looks from a normal standing height, so
// tables hide the player no worse than they did before. Either ray seeing counts.
const SIGHT_HEIGHTS = [2.25, 1.55];
const CATCH_DIST = 1.6;                        // long arms: it grabs from a stride away
const SCARE_DIST = 0.21;                       // camera to face in the jump scare: the face fills the view
// Spawn / despawn cycle, seconds and metres. The monster is only in the building part of the time.
const CYCLE = {
  firstDelay: 30,          // play time before it first appears
  respawnMin: 30,          // gone for this long after it leaves ...
  respawnMax: 45,          // ... up to this long
  roamLimit: 75,           // leaves after roaming this long without ever seeing the player
  minSpawnDist: 12,        // walking distance from the player when it appears on the same floor
};
// The legs are animated with IK so the feet plant; each clip moves the body `dist` metres in
// `len` seconds at rate 1 (printed by tools/build_monster.py). Playing a clip at
// speed * len / dist keeps the planted feet still on the floor. `steps`: heel strikes per clip.
const GAIT = {
  Walk: { len: 84 / 24, dist: 5.1, steps: 6 },   // three slow strides, with a head snap in the middle
  Run: { len: 32 / 24, dist: 5.2, steps: 4 },
  Duck: { len: 26 / 24, dist: 1.5, steps: 2 },
};
const LIMB_RATE = 1.0;                  // 1 = exact no-slip
const limbRate = (clip, speed) => LIMB_RATE * speed * GAIT[clip].len / (GAIT[clip].dist * SIZE);
// Doors are 2.1 m high and it walks at up to 2.27 m: within this distance of a doorway it ducks.
const duckDist = (speed) => 0.9 + 0.25 * speed;
const VISIBLE_RANGE = 25;
// Walkie-talkie static: silent beyond STATIC_RANGE (horizontal metres, same floor only), first faint
// crackles just inside it, rising to strong at STATIC_NEAR. Full blast only while the player sees it.
const STATIC_RANGE = 16;
const STATIC_NEAR = 4;
// Monster footsteps: silent beyond STEP_RANGE (horizontal metres), loudest within STEP_NEAR.
const STEP_RANGE = 18;
const STEP_NEAR = 2;
// Height difference (m) over which a monster on the stairs fades out: full below the first value,
// nothing above the second (floors are 3.6 m apart, so another floor is always silent).
const SAME_FLOOR_DY = [1, 2];

export class Monster {
  constructor({ scene, world, data, physics, player, audio, game, camera, flashlightOn, openDoor, onCatch, sightBonus }) {
    Object.assign(this, { scene, world, data, physics, player, audio, game, camera, flashlightOn, openDoor, onCatch, sightBonus });
    // set by main.js as breakers are reset: seconds cut from the respawn gap, and its floor
    this.respawnCut = 0;
    this.respawnMinGap = 15;
    this.alertTarget = null;
    this.nav = buildNav(world, data, physics);
    const s = data.settings.monsterStart;
    this.pos = new THREE.Vector3(s.x, world.levelY(s.floor), s.z);
    this.yaw = Math.PI;
    this.state = 'patrol';
    this.path = [];
    this.wait = 1.5;
    this.seesPlayer = false;
    this.lastSeen = null;
    this.lostTimer = 0;
    this.searchTimer = 0;
    this.senseTimer = 0;
    this.stepTimer = 0;
    this.stuck = 0;
    this.speed = 0;
    this.ready = false;
    // not in the building at the start: it first turns up after CYCLE.firstDelay seconds of play
    this.phase = 'gone';                // gone | active | leaving
    this.goneTimer = CYCLE.firstDelay;
    this.roamTime = 0;
    this.everSeen = false;
    this.visible = false;               // can the player see it right now
    this.group = new THREE.Group();
    this.group.scale.setScalar(SIZE);
    this.group.visible = false;
    scene.add(this.group);
    new GLTFLoader().load(`${import.meta.env.BASE_URL}models/monster.glb`, (gltf) => {
      this.model = gltf.scene;
      this.model.traverse((o) => {
        if (!o.isMesh) return;
        o.castShadow = true; o.frustumCulled = false;
        // the pinpoint eyes stay visible in the dark and through the fog
        if (o.material.name === 'eye') { o.material.emissiveIntensity = 10; o.material.fog = false; o.castShadow = false; }
        // the sockets and the mouth are holes: pure black whatever light falls on them
        if (o.material.name === 'socket' || o.material.name === 'mouth') {
          o.material = new THREE.MeshBasicMaterial({ color: 0x000000, name: o.material.name });
        }
      });
      this.group.add(this.model);
      this.faceAnchor = this.model.getObjectByName('face_anchor');
      this.addEyePinpoints();
      this.mixer = new THREE.AnimationMixer(this.model);
      this.actions = {};
      for (const clip of gltf.animations) this.actions[clip.name] = this.mixer.clipAction(clip);
      this.current = null;
      this.play('Idle');
      this.ready = true;
    });
  }

  // Two tiny white points on the head bone that never shrink below a couple of pixels, so the
  // eyes can be seen down a dark hallway. Depth-tested (walls and doors hide them), no fog,
  // and up close they are only a few millimetres across.
  addEyePinpoints() {
    const mat = new THREE.ShaderMaterial({
      uniforms: { uSize: { value: 0.005 * SIZE }, uMin: { value: 2.5 }, uH: { value: 800 } },
      vertexShader: `
        uniform float uSize; uniform float uMin; uniform float uH;
        varying float vPx;
        void main() {
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mv;
          float px = uSize * projectionMatrix[1][1] * uH * 0.5 / max(-mv.z, 1e-3);
          gl_PointSize = max(uMin, px);
          vPx = gl_PointSize;
        }`,
      fragmentShader: `
        varying float vPx;
        void main() {
          float r = length(gl_PointCoord - 0.5) * 2.0;
          float a = vPx < 4.0 ? 1.0 : 1.0 - smoothstep(0.45, 1.0, r);
          if (a <= 0.0) discard;
          gl_FragColor = vec4(1.0, 0.98, 0.94, a);
        }`,
      transparent: true, depthWrite: false, depthTest: true, fog: false,
    });
    const size = new THREE.Vector2();
    for (const name of ['eye_L', 'eye_R']) {
      const node = this.model.getObjectByName(name);
      if (!node) continue;
      const geo = new THREE.BufferGeometry();
      // nudged a few millimetres out of the socket so the socket floor does not hide it
      geo.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0.004], 3));
      const pts = new THREE.Points(geo, mat);
      pts.frustumCulled = false;
      pts.renderOrder = 5;
      pts.onBeforeRender = (renderer) => {
        renderer.getDrawingBufferSize(size);
        mat.uniforms.uH.value = size.y;
        mat.uniforms.uMin.value = 2.5 * renderer.getPixelRatio();
      };
      node.add(pts);
    }
  }

  play(name, timeScale = 1, fade = 0.25) {
    const a = this.actions?.[name];
    if (!a) return;
    a.timeScale = timeScale;
    if (this.current === a) return;
    // walking into / out of the crouch: keep the stride phase so the feet do not jump
    const prev = this.current, gp = prev && GAIT[prev.getClip().name], gn = GAIT[name];
    a.reset();
    if (gp && gn) {
      const stride = ((prev.time / prev.getClip().duration) * gp.steps / 2) % 1;   // 0..1 within one stride
      a.time = (stride / (gn.steps / 2)) * a.getClip().duration;
    }
    a.fadeIn(fade).play();
    prev?.fadeOut(fade);
    this.current = a;
    this.lastClipTime = a.time;
  }

  // Is it about to walk through (or still in) a doorway lower than its head? Then it ducks:
  // from duckDist ahead of the door plane until 0.7 m past it, if its line crosses the opening.
  nearDoor(speed) {
    const r = duckDist(speed), fx = Math.sin(this.yaw), fz = Math.cos(this.yaw);
    for (const d of this.world.doors) {
      if (d.type === 'glassPanel' || d.type === 'elevator' || (d.height ?? 2.1) > 2.5) continue;
      if (d.locked && !(d.t > 0.5)) continue;
      if (Math.abs(d.y - this.pos.y) > 0.6) continue;
      const [n, fn, o, fo, dn, dob] = d.axis === 'x'
        ? [this.pos.z, fz, this.pos.x, fx, d.z, d.x] : [this.pos.x, fx, this.pos.z, fz, d.x, d.z];
      const half = (d.width ?? 0.95) / 2 + 0.35;
      if (Math.abs(n - dn) < 0.7 && Math.abs(o - dob) < half) return true;     // in the doorway now
      if (Math.abs(fn) < 0.2) continue;                                          // walking along the wall
      const t = (dn - n) / fn;                                                   // metres until the door plane
      if (t > 0 && t < r && Math.abs(o + fo * t - dob) < half) return true;
    }
    return false;
  }

  // ---- helpers
  nearestNode(x, y, z, needClear = true) {
    let best = null, bd = Infinity;
    const p = { x, y, z };
    for (const n of this.nav.nodes) {
      if (Math.abs(n.y - y) > 1.0) continue;
      const d = Math.hypot(n.x - x, n.z - z);
      if (d < bd && (!needClear || d < 0.3 || this.nav.clear(p, n))) { bd = d; best = n; }
    }
    return best ?? (needClear ? this.nearestNode(x, y, z, false) : null);
  }

  goTo(x, y, z) {
    const a = this.nearestNode(this.pos.x, this.pos.y, this.pos.z), b = this.nearestNode(x, y, z);
    if (!a || !b) { this.path = []; return false; }
    const p = astar(this.nav.nodes, a, b);
    if (!p) { this.path = []; return false; }
    this.path = p;
    this.goal = b;
    this.prevNode = null;
    return true;
  }

  pickPatrol() {
    const c = this.nav.nodes.filter((n) => n.patrol && !n.doorNode && Math.hypot(n.x - this.pos.x, n.z - this.pos.z, (n.y - this.pos.y) * 3) > 8);
    // bias a little toward wherever the player is, so the monster keeps turning up
    const p = this.player;
    c.sort((a, b) => Math.hypot(a.x - p.pos.x, a.z - p.pos.z, (a.y - p.feetY) * 2) - Math.hypot(b.x - p.pos.x, b.z - p.pos.z, (b.y - p.feetY) * 2));
    const pool = Math.random() < 0.45 ? c.slice(0, Math.max(1, Math.ceil(c.length / 3))) : c;
    const n = pool[Math.floor(Math.random() * pool.length)];
    if (n) this.goTo(n.x, n.y, n.z);
  }

  distToPlayer() {
    const p = this.player;
    return Math.hypot(p.pos.x - this.pos.x, p.pos.z - this.pos.z, (p.feetY - this.pos.y) * 2.2);
  }

  // 1 on the player's own floor, fading to 0 between 1 and 2 m of height difference (stairs).
  sameFloorFactor() {
    const dy = Math.abs(this.player.feetY - this.pos.y);
    return 1 - Math.min(1, Math.max(0, (dy - SAME_FLOOR_DY[0]) / (SAME_FLOOR_DY[1] - SAME_FLOOR_DY[0])));
  }

  flatDistToPlayer() {
    return Math.hypot(this.player.pos.x - this.pos.x, this.player.pos.z - this.pos.z);
  }

  // 0 .. 1 for the walkie-talkie. Exactly 0 while despawned, on another floor or beyond
  // STATIC_RANGE; 0.9 at STATIC_NEAR and closer; 1 while the player is looking at it.
  staticLevel() {
    if (!this.ready || this.phase === 'gone') return 0;
    if (this.visible) return 1;
    const floor = this.sameFloorFactor();
    if (floor <= 0) return 0;
    const t = Math.min(1, Math.max(0, (STATIC_RANGE - this.flatDistToPlayer()) / (STATIC_RANGE - STATIC_NEAR)));
    return t > 0 ? 0.9 * t ** 1.4 * floor : 0;
  }

  // 0 .. 0.9 volume of the monster's footsteps. Exactly 0 while despawned, on another floor or
  // beyond STEP_RANGE.
  stepVolume() {
    if (!this.ready || this.phase === 'gone') return 0;
    const floor = this.sameFloorFactor();
    if (floor <= 0) return 0;
    const t = Math.min(1, Math.max(0, (STEP_RANGE - this.flatDistToPlayer()) / (STEP_RANGE - STEP_NEAR)));
    return 0.9 * t ** 1.5 * floor;
  }

  // Can the player see it? In range, on screen, and a clear line from the camera to its head or
  // body (glass is see-through). Floors are not in the physics, so another level never counts.
  playerCanSee() {
    if (!this.ready || this.phase === 'gone') return false;
    const cam = this.camera;
    cam.updateMatrixWorld();
    const c = new THREE.Vector3().setFromMatrixPosition(cam.matrixWorld);
    if (Math.abs(this.pos.y - this.player.feetY) > 2.2) return false;
    const fx = Math.sin(this.yaw), fz = Math.cos(this.yaw);
    const pts = [[0.2, 2.3], [0.05, 1.7], [0, 1.1], [0, 0.5]];   // [forward, height] x SIZE: head, chest, hips, legs
    const v = new THREE.Vector3();
    for (const [f, h] of pts) {
      v.set(this.pos.x + fx * f * SIZE, this.pos.y + h * SIZE, this.pos.z + fz * f * SIZE);
      const dx = v.x - c.x, dy = v.y - c.y, dz = v.z - c.z, d = Math.hypot(dx, dy, dz);
      if (d > VISIBLE_RANGE || d < 0.01) continue;
      const ndc = v.clone().project(cam);
      if (ndc.z > 1 || Math.abs(ndc.x) > 1 || Math.abs(ndc.y) > 1) continue;
      if (this.physics.raycast(c.x, c.y, c.z, dx / d, dy / d, dz / d, d, true) >= d - 0.05) return true;
    }
    return false;
  }

  // ---- spawn / despawn
  trySpawn() {
    const p = this.player, cam = this.camera;
    const c = new THREE.Vector3().setFromMatrixPosition(cam.matrixWorld);
    // walking distance from the player to every node
    const start = this.nearestNode(p.pos.x, p.feetY, p.pos.z, false);
    const dist = new Map([[start, 0]]), open = [start];
    while (open.length) {
      let bi = 0;
      for (let i = 1; i < open.length; i++) if (dist.get(open[i]) < dist.get(open[bi])) bi = i;
      const cur = open.splice(bi, 1)[0];
      for (const l of cur.links) {
        const t = dist.get(cur) + l.cost;
        if (t < (dist.get(l.to) ?? Infinity)) { if (!dist.has(l.to)) open.push(l.to); dist.set(l.to, t); }
      }
    }
    const inSight = (n) => {
      if (Math.abs(n.y - p.feetY) > 2.2) return false;
      for (const h of [0.4, 1.2, 2.3]) {
        const dx = n.x - c.x, dy = n.y + h * SIZE - c.y, dz = n.z - c.z, d = Math.hypot(dx, dy, dz);
        if (d < 30 && this.physics.raycast(c.x, c.y, c.z, dx / d, dy / d, dz / d, d, true) >= d - 0.05) return true;
      }
      return false;
    };
    const cands = [];
    for (const n of this.nav.nodes) {
      if (n.doorNode || n.stair) continue;
      const otherFloor = Math.abs(n.y - p.feetY) > 2.2;
      const walk = dist.get(n) ?? Infinity;
      if (!otherFloor && walk < CYCLE.minSpawnDist) continue;
      if (walk === Infinity && !otherFloor) continue;
      if (inSight(n)) continue;
      cands.push({ n, score: (otherFloor ? 40 : 0) + Math.min(walk, 60) });
    }
    if (!cands.length) return false;
    cands.sort((a, b) => b.score - a.score);
    const pick = cands[Math.floor(Math.random() * Math.max(1, Math.ceil(cands.length / 3)))].n;
    this.pos.set(pick.x, pick.y, pick.z);
    this.yaw = Math.random() * Math.PI * 2;
    Object.assign(this, { phase: 'active', state: 'patrol', path: [], wait: 1 + Math.random(), roamTime: 0, everSeen: false,
      seesPlayer: false, lastSeen: null, lostTimer: 0, stuck: 0, senseTimer: 0, spawnNode: pick });
    this.group.visible = true;
    this.group.position.copy(this.pos);
    this.group.rotation.y = this.yaw;
    this.play('Idle');
    return true;
  }

  // the player got away (or it found nobody): walk off and vanish once out of sight
  leave() {
    this.phase = 'leaving';
    this.state = 'patrol';
    this.pickFarNode();
  }

  pickFarNode() {
    const p = this.player;
    const c = this.nav.nodes.filter((n) => !n.doorNode && Math.hypot(n.x - this.pos.x, n.z - this.pos.z, (n.y - this.pos.y) * 3) > 5);
    c.sort((a, b) => Math.hypot(b.x - p.pos.x, b.z - p.pos.z, (b.y - p.feetY) * 3) - Math.hypot(a.x - p.pos.x, a.z - p.pos.z, (a.y - p.feetY) * 3));
    const n = c[Math.floor(Math.random() * Math.max(1, Math.ceil(c.length / 4)))];
    if (n) this.goTo(n.x, n.y, n.z);
  }

  // a loud event it always hears (a breaker reset): if it is away, it comes back within `delay`
  // seconds (still spawning out of sight) and walks to the spot; if it is about, it goes now
  alert(x, y, z, delay) {
    if (this.phase === 'gone') {
      this.goneTimer = Math.min(this.goneTimer, delay);
      this.alertTarget = { x, y, z };
      return;
    }
    if (this.phase === 'leaving') this.phase = 'active';
    if (this.state !== 'chase') { this.state = 'investigate'; this.goTo(x, y, z); this.wait = 0; }
  }

  despawn() {
    this.phase = 'gone';
    const lo = Math.max(this.respawnMinGap, CYCLE.respawnMin - this.respawnCut);
    const hi = Math.max(lo, CYCLE.respawnMax - this.respawnCut);
    this.goneTimer = lo + Math.random() * (hi - lo);
    this.group.visible = false;
    this.visible = false;
    this.seesPlayer = false;
    this.state = 'patrol';
    this.path = [];
    this.speed = 0;
  }

  canSee() {
    const p = this.player;
    if (p.hidden && !this.game.hideSeen) return false;
    const ex = this.pos.x, ez = this.pos.z;
    const tx = p.pos.x, ty = p.feetY + (p.hidden ? 0.6 : 1.45), tz = p.pos.z;
    const dx = tx - ex, dz = tz - ez, flat = Math.hypot(dx, dz);
    // a lit flashlight gives the player away from much farther off
    let range = this.flashlightOn() ? 21 : 8.5;
    if (p.isSprinting) range += 3;
    if (this.state === 'chase') range += 4;
    range += this.sightBonus?.() ?? 0;          // the player stands on a powered (lit) floor
    if (Math.hypot(flat, ty - this.pos.y - SIGHT_HEIGHTS[0]) > range) return false;
    if (flat > 2.2) {
      const fx = Math.sin(this.yaw), fz = Math.cos(this.yaw);
      if ((dx * fx + dz * fz) / flat < 0.3) return false; // roughly a 145 degree cone
    }
    for (const h of SIGHT_HEIGHTS) {
      const ey = this.pos.y + h, dy = ty - ey, d = Math.hypot(dx, dy, dz);
      if (this.physics.raycast(ex, ey, ez, dx / d, dy / d, dz / d, d, true) >= d) return true;
    }
    return false;
  }

  hear() {
    let best = null;
    for (const n of this.game.noises) {
      // global noises (a breaker reset) carry through floors: only horizontal distance counts
      const d = n.global ? Math.hypot(n.x - this.pos.x, n.z - this.pos.z) : Math.hypot(n.x - this.pos.x, n.z - this.pos.z, (n.y - this.pos.y) * 2);
      if (d < n.radius && (!best || d < best.d)) best = { ...n, d };
    }
    return best;
  }

  // ---- main update
  update(dt) {
    if (!this.ready) return;
    if (this.game.state === 'dying') { this.updateScare(dt); return; }
    const p = this.player;

    if (this.phase === 'gone') {
      this.goneTimer -= dt;
      if (this.goneTimer <= 0) {
        if (!this.trySpawn()) this.goneTimer = 2;   // nowhere safe yet: try again shortly
        else if (this.alertTarget) {
          const a = this.alertTarget; this.alertTarget = null;
          this.state = 'investigate'; this.goTo(a.x, a.y, a.z); this.wait = 0;
        }
      }
      return;
    }
    this.roamTime += dt;

    this.senseTimer -= dt;
    if (this.senseTimer <= 0) {
      this.senseTimer = 0.1;
      this.visible = this.playerCanSee();
      // leaving: vanish the moment the player is not looking at it
      if (this.phase === 'leaving' && !this.visible) { this.despawn(); return; }
      this.seesPlayer = this.canSee();
      if (this.seesPlayer) {
        this.everSeen = true;
        if (this.phase === 'leaving') this.phase = 'active';
        this.lastSeen = { x: p.pos.x, y: p.feetY, z: p.pos.z };
        this.lostTimer = 0;
        if (this.state !== 'chase') { this.state = 'chase'; this.path = []; this.repath = 0; }
      }
    }
    const heard = this.hear();
    if (heard && this.state !== 'chase') {
      this.state = 'investigate';
      this.goTo(heard.x, heard.y, heard.z);
      this.wait = 0;
    }

    let speed = SPEED[this.state];
    if (this.state === 'chase') {
      if (!this.seesPlayer) {
        this.lostTimer += dt;
        if (this.lostTimer > 1.2 && !this.path.length) {
          // lost them: check where they were last seen, then search
          if (this.lastSeen && Math.hypot(this.lastSeen.x - this.pos.x, this.lastSeen.z - this.pos.z) > 1.2 && this.lostTimer < 12) {
            this.goTo(this.lastSeen.x, this.lastSeen.y, this.lastSeen.z);
            if (!this.path.length) this.startSearch();
          } else this.startSearch();
        }
      } else {
        this.detour = Math.max(0, (this.detour ?? 0) - dt);
        const direct = Math.abs(p.feetY - this.pos.y) < 0.7 && this.detour <= 0;
        if (direct) {
          this.path = [];
          const bx = this.pos.x, bz = this.pos.z;
          this.moveToward(p.pos.x, p.pos.z, speed, dt, true);
          // blocked by furniture or a corner: walk round it along the nav graph for a moment
          const made = Math.hypot(this.pos.x - bx, this.pos.z - bz);
          this.blocked = made < speed * dt * 0.35 ? (this.blocked ?? 0) + dt : 0;
          if (this.blocked > 0.35) { this.blocked = 0; this.detour = 1.6; this.repath = 0; }
        } else {
          this.repath -= dt;
          if (this.repath <= 0 || !this.path.length) { this.repath = 0.6; this.goTo(p.pos.x, p.feetY, p.pos.z); }
        }
      }
      // caught?
      const d = Math.hypot(p.pos.x - this.pos.x, p.pos.z - this.pos.z);
      if (d < CATCH_DIST && Math.abs(p.feetY - this.pos.y) < 1.0 && this.seesPlayer) { this.onCatch(); return; }
    } else if (this.state === 'search') {
      this.searchTimer -= dt;
      if (this.searchTimer <= 0) { this.path = []; this.wait = 0.5; this.leave(); }
      else if (!this.path.length) {
        this.wait -= dt;
        if (this.wait <= 0) {
          const o = this.lastSeen ?? this.pos;
          const near = this.nav.nodes.filter((n) => Math.abs(n.y - o.y) < 1 && Math.hypot(n.x - o.x, n.z - o.z) < 9 && !n.stair);
          const n = near[Math.floor(Math.random() * near.length)];
          if (n) this.goTo(n.x, n.y, n.z);
          this.wait = 0.6 + Math.random() * 1.2;
        }
      }
    } else if (this.state === 'investigate') {
      if (!this.path.length) this.startSearch();
    } else if (this.phase === 'leaving') {
      if (!this.path.length) this.pickFarNode();          // still in view: keep walking away
    } else if (!this.everSeen && this.roamTime > CYCLE.roamLimit) {
      this.leave();
    } else if (!this.path.length) {
      this.wait -= dt;
      if (this.wait <= 0) { this.pickPatrol(); this.wait = 1 + Math.random() * 2.5; }
    }

    const moving = this.path.length ? this.followPath(speed, dt) : this.state === 'chase' && this.seesPlayer;
    this.speed = moving ? speed : 0;

    // animation + sound
    this.ducking = moving && this.nearDoor(speed);
    if (!moving) this.play('Idle');
    else if (this.ducking) this.play('Duck', limbRate('Duck', speed), 0.18);
    else if (this.state === 'chase') this.play('Run', limbRate('Run', speed));
    else this.play('Walk', limbRate('Walk', speed));
    this.mixer.update(dt);
    // footsteps: one on every heel strike of the clip that is playing
    const cur = this.current, g = cur && GAIT[cur.getClip().name];
    if (moving && g) {
      const dur = cur.getClip().duration, a = (this.lastClipTime ?? cur.time) / dur * g.steps, b = cur.time / dur * g.steps;
      const crossed = b >= a ? Math.floor(b) - Math.floor(a) : 1;      // wrapped round the loop end
      if (crossed > 0) {
        const vol = this.stepVolume();
        const rx = Math.cos(p.yaw), rz = -Math.sin(p.yaw), flat = Math.hypot(this.pos.x - p.pos.x, this.pos.z - p.pos.z) || 1;
        this.audio.monsterStep(vol, ((this.pos.x - p.pos.x) * rx + (this.pos.z - p.pos.z) * rz) / flat, cur.getClip().name === 'Run' ? 1 : 0);
      }
    }
    this.lastClipTime = cur?.time ?? 0;
    this.group.position.copy(this.pos);
    this.group.rotation.y = this.yaw;
  }

  startSearch() {
    this.state = 'search';
    this.searchTimer = 10 + Math.random() * 5;
    this.path = [];
    this.wait = 0.4;
    if (!this.lastSeen) this.lastSeen = { x: this.pos.x, y: this.pos.y, z: this.pos.z };
  }

  moveToward(x, z, speed, dt, collide) {
    const dx = x - this.pos.x, dz = z - this.pos.z, d = Math.hypot(dx, dz);
    if (d > 1e-3) {
      const step = Math.min(d, speed * dt);
      this.pos.x += (dx / d) * step; this.pos.z += (dz / d) * step;
      const want = Math.atan2(dx, dz);
      let diff = ((want - this.yaw + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
      this.yaw += diff * Math.min(1, dt * 8);
    }
    if (collide) this.physics.resolve(this.pos, 0.35, this.pos.y, 1.9, true);
    const g = this.physics.groundAt(this.pos.x, this.pos.z, this.pos.y + 0.3);
    if (g > -Infinity) this.pos.y += (g - this.pos.y) * Math.min(1, dt * 14);
    return d;
  }

  followPath(speed, dt) {
    const next = this.path[0];
    // a closed door on the way: open it slowly and loudly, and wait for it
    const prev = this.prevNode;
    if (prev) {
      const l = prev.links.find((k) => k.to === next && k.door);
      if (l && l.door.t < 0.85) {
        if (l.door.target !== 1) {
          this.openDoor(l.door, true, { slow: true, loud: true });
        }
        this.play('Idle');
        return false;
      }
    }
    const before = Math.hypot(next.x - this.pos.x, next.z - this.pos.z);
    const d = this.moveToward(next.x, next.z, speed, dt, false);
    this.stuck = before - Math.hypot(next.x - this.pos.x, next.z - this.pos.z) < speed * dt * 0.2 ? this.stuck + dt : 0;
    if (d < 0.25 || this.stuck > 1.5) {
      if (this.stuck > 1.5) { this.pos.x = next.x; this.pos.z = next.z; this.pos.y = next.y; }
      this.stuck = 0;
      this.prevNode = this.path.shift();
    }
    return true;
  }

  // ---- jump scare: the face fills the screen
  startScare() {
    this.scareTime = 0;
    const face = new THREE.PointLight(0xffe6cc, 1.6, 3, 1.5);
    face.position.set(0, -0.12, 0.05);
    this.camera.add(face);
    const scream = this.actions.Scream;
    if (scream) {
      this.mixer.stopAllAction();
      scream.reset().setLoop(THREE.LoopOnce, 1);
      scream.clampWhenFinished = true;
      scream.timeScale = 1;
      scream.play();
      this.current = scream;
    } else this.play('Run', 3);
  }

  updateScare(dt) {
    this.scareTime += dt;
    this.mixer.update(this.actions.Scream ? dt : dt * 0.35);
    const cam = this.camera, g = this.group;
    cam.updateMatrixWorld();
    // where the face is relative to the monster in its current pose (at 1x, at the origin)
    g.position.set(0, 0, 0); g.quaternion.identity(); g.scale.setScalar(1);
    g.updateMatrixWorld(true);
    const A = this.faceAnchor ? this.faceAnchor.matrixWorld.clone() : new THREE.Matrix4().makeTranslation(HEAD.x, HEAD.y, HEAD.z);
    // where the face should be: straight in front of the camera, looking back at it, lunging in
    const camPos = new THREE.Vector3(), camQ = new THREE.Quaternion(), fwd = new THREE.Vector3();
    cam.matrixWorld.decompose(camPos, camQ, new THREE.Vector3());
    cam.getWorldDirection(fwd);
    const lunge = Math.min(1, this.scareTime / 0.12);
    const dist = SCARE_DIST * (2.2 - 1.2 * lunge) + Math.sin(this.scareTime * 60) * 0.008 * SIZE;
    const target = camPos.clone().addScaledVector(fwd, dist);
    const shake = new THREE.Quaternion().setFromEuler(new THREE.Euler((Math.random() - 0.5) * 0.05, (Math.random() - 0.5) * 0.06, (Math.random() - 0.5) * 0.04));
    const D = new THREE.Matrix4().compose(target, camQ.clone().multiply(shake), new THREE.Vector3(SIZE, SIZE, SIZE));
    const G = D.multiply(A.invert());
    G.decompose(g.position, g.quaternion, g.scale);
    g.position.x += (Math.random() - 0.5) * 0.01 * SIZE;
    g.position.y += (Math.random() - 0.5) * 0.01 * SIZE;
    this.pos.copy(g.position);
    this.yaw = Math.atan2(-fwd.x, -fwd.z);
  }

  debugText() {
    const phase = this.phase === 'gone' ? `gone, ${Math.ceil(this.goneTimer)} s` : `${this.phase} ${Math.round(this.roamTime)} s${this.visible ? ' VISIBLE' : ''}`;
    return `${phase}  ${this.state}  ${this.distToPlayer().toFixed(1)} m  sees:${this.seesPlayer}  floor ${Math.round(this.pos.y / this.data.settings.floorHeight) + 1}  path ${this.path.length}`;
  }
}
