import * as THREE from 'three';
import mapData from './data/map.json';
import testData from './data/testroom.json';
import { buildWorld } from './world/builder.js';
import { Physics } from './physics.js';
import { Player } from './player.js';
import { Minimap } from './minimap.js';
import { Lights } from './lights.js';
import { Audio } from './audio.js';
import { Monster } from './monster.js';

const params = new URLSearchParams(location.search);
const data = params.get('map') === 'test' ? testData : mapData;
const DEBUG = params.has('debug');
const FH = data.settings.floorHeight;
const $ = (id) => document.getElementById(id);

// ---------- renderer / scene ----------
const canvas = $('game');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x000000);
const camera = new THREE.PerspectiveCamera(72, 1, 0.05, 90);
scene.add(camera);

function resize() {
  renderer.setSize(innerWidth, innerHeight, false);
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
}
addEventListener('resize', resize);
resize();

// ---------- world ----------
const world = buildWorld(data);
scene.add(world.group);
const physics = new Physics(world.colliders, world.surfaces);
const lights = new Lights(scene, world.fixtures);
const audio = new Audio();

// ---------- player, flashlight, walkie-talkie ----------
const player = new Player(camera, physics, canvas);
const start = data.settings.playerStart;
player.spawn = { x: start.x, z: start.z, y: world.levelY(start.floor), facingDeg: start.facingDeg };
player.teleport(player.spawn.x, player.spawn.z, player.spawn.y, player.spawn.facingDeg);

const flashlight = new THREE.SpotLight(0xfff1d6, 0, 26, 0.5, 0.55, 1.5);
flashlight.position.set(0.22, -0.2, -0.15);
flashlight.target.position.set(0.02, -0.03, -4);
flashlight.castShadow = true;
flashlight.shadow.mapSize.set(1024, 1024);
flashlight.shadow.camera.near = 0.3;
flashlight.shadow.camera.far = 26;
flashlight.shadow.bias = -0.0008;
camera.add(flashlight, flashlight.target);
let flashOn = true;

// the walkie-talkie held in the lower right of the view
const walkie = new THREE.Group();
{
  const dark = new THREE.MeshBasicMaterial({ color: 0x0b0b0c });
  const add = (geo, mat, x, y, z) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); walkie.add(m); return m; };
  add(new THREE.BoxGeometry(0.062, 0.15, 0.034), dark, 0, 0, 0);
  add(new THREE.CylinderGeometry(0.005, 0.007, 0.11, 8), dark, 0.02, 0.13, 0);
  add(new THREE.BoxGeometry(0.04, 0.035, 0.004), new THREE.MeshBasicMaterial({ color: 0x1c2a1c }), 0, 0.035, 0.018);
  walkie.userData.lens = add(new THREE.CylinderGeometry(0.014, 0.014, 0.01, 12), new THREE.MeshBasicMaterial({ color: 0xfff4d0 }), -0.012, 0.08, -0.005);
  walkie.userData.lens.rotation.x = Math.PI / 2;
  walkie.userData.led = add(new THREE.SphereGeometry(0.004, 6, 6), new THREE.MeshBasicMaterial({ color: 0x30ff50 }), 0.02, 0.06, 0.018);
  walkie.position.set(0.24, -0.22, -0.42);
  walkie.rotation.set(0.15, -0.25, 0.08);
  camera.add(walkie);
}
function setFlash(on) {
  flashOn = on;
  flashlight.intensity = on ? 55 : 0;
  walkie.userData.lens.material.color.set(on ? 0xfff4d0 : 0x222222);
}
setFlash(true);

// ---------- game state ----------
const game = {
  state: 'title',        // title | playing | paused | won | dying | dead
  fuses: 0,              // fuses carried
  power: 0,              // breaker panels reset
  hold: null,            // { panel, t } while E is held at a panel
  eHeld: false,
  noises: [],            // things the monster can hear: { x, y, z, radius }
  monster: null,
  time: 0,
};
function noise(x, y, z, radius, global = false) {
  game.noises.push({ x, y, z, radius, global });
}

// ---------- objective: fuses and breaker panels ----------
// Tuning lives in map.json settings.objective; these are the fallbacks.
const OBJ = { holdTime: 2.5, noiseRadius: 40, alertDelay: 4, sightBonus: 8, respawnCutPerPanel: 5, respawnMinGap: 15, ...data.settings.objective };
const PANEL = { w: 0.5, h: 0.7, d: 0.12, y: 1.4 };
const RED = 0xff2a1a, GREEN = 0x30ff60;

function makeFuse(glow = true) {
  const g = new THREE.Group();
  const glass = new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.014, 0.05, 12),
    new THREE.MeshStandardMaterial({ color: 0xfff0d0, emissive: 0x3a2a10, roughness: 0.1, metalness: 0, transparent: true, opacity: 0.55 }));
  const brass = new THREE.MeshStandardMaterial({ color: 0xc9a040, emissive: 0x2a1c00, roughness: 0.35, metalness: 0.85 });
  for (const s of [-1, 1]) {
    const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.016, 0.016, 0.016, 12), brass);
    cap.position.y = s * 0.032;
    g.add(cap);
  }
  const wire = new THREE.Mesh(new THREE.CylinderGeometry(0.0015, 0.0015, 0.05, 4), new THREE.MeshBasicMaterial({ color: 0xffd080 }));
  g.add(glass, wire);
  if (glow) {
    const l = new THREE.PointLight(0xffb050, 0.25, 1.6, 2);
    l.position.y = 0.1;
    g.add(l);
  }
  return g;
}

// fuses: one per panel, at distinct random entries of keySpawns
const panelData = data.panels ?? [];
const fuses = [];
{
  const spots = [...(data.keySpawns ?? [])];
  for (let i = spots.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [spots[i], spots[j]] = [spots[j], spots[i]]; }
  for (const sp of spots.slice(0, panelData.length)) {
    const mesh = makeFuse();
    mesh.rotation.z = Math.PI / 2;                 // lying on its side
    const holder = new THREE.Group();
    holder.add(mesh);
    holder.position.set(sp.x, world.levelY(sp.floor) + (sp.y ?? 0.05) + 0.018, sp.z);
    scene.add(holder);
    fuses.push({ id: sp.id, spawn: sp, mesh: holder, taken: false });
  }
}

// breaker panels: grey wall boxes, door swung open, lever, fuse slot, indicator light
const panels = panelData.map((p) => {
  const rot = ((p.rot ?? 0) * Math.PI) / 180;
  const fx = Math.cos(rot), fz = Math.sin(rot);   // the way the front faces
  const base = world.levelY(p.floor);
  const g = new THREE.Group();
  g.position.set(p.x + fx * PANEL.d / 2, base + (p.y ?? PANEL.y), p.z + fz * PANEL.d / 2);
  g.rotation.y = Math.PI / 2 - rot;              // local +z = front
  const metal = new THREE.MeshStandardMaterial({ color: 0x6d7174, roughness: 0.55, metalness: 0.6 });
  const box = new THREE.Mesh(new THREE.BoxGeometry(PANEL.w, PANEL.h, PANEL.d), metal);
  const inner = new THREE.Mesh(new THREE.PlaneGeometry(PANEL.w - 0.05, PANEL.h - 0.05), new THREE.MeshStandardMaterial({ color: 0x24272a, roughness: 0.8, metalness: 0.3 }));
  inner.position.z = PANEL.d / 2 + 0.001;
  const hinge = new THREE.Group();               // door hinged on the left edge, swung most of the way open
  hinge.position.set(-PANEL.w / 2, 0, PANEL.d / 2);
  const door = new THREE.Mesh(new THREE.BoxGeometry(PANEL.w - 0.02, PANEL.h - 0.02, 0.012), metal);
  door.position.set((PANEL.w - 0.02) / 2, 0, 0.006);
  hinge.add(door);
  hinge.rotation.y = -1.95;
  const dark = new THREE.MeshStandardMaterial({ color: 0x0c0c0c, roughness: 0.9 });
  const slot = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.12, 0.03), dark);
  slot.position.set(-0.09, -0.02, PANEL.d / 2 + 0.015);
  const slotFuse = makeFuse(false);
  slotFuse.position.set(-0.09, -0.02, PANEL.d / 2 + 0.035);
  slotFuse.visible = false;
  const leverPivot = new THREE.Group();
  leverPivot.position.set(0.12, -0.02, PANEL.d / 2 + 0.02);
  const lever = new THREE.Mesh(new THREE.BoxGeometry(0.025, 0.13, 0.025), new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.6 }));
  lever.position.y = 0.06;
  const knob = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.03, 0.035), new THREE.MeshStandardMaterial({ color: 0xa01818, roughness: 0.5 }));
  knob.position.y = 0.13;
  leverPivot.add(lever, knob);
  leverPivot.rotation.x = 2.4;                  // pointing down: off
  const ind = new THREE.Mesh(new THREE.SphereGeometry(0.016, 10, 8), new THREE.MeshBasicMaterial({ color: RED, toneMapped: false }));
  ind.position.set(0.15, 0.27, PANEL.d / 2 + 0.01);
  const glow = new THREE.PointLight(RED, 0.35, 2.2, 2);
  glow.position.set(0.15, 0.27, PANEL.d / 2 + 0.12);
  g.add(box, inner, hinge, slot, slotFuse, leverPivot, ind, glow);
  scene.add(g);
  return { ...p, group: g, base, wx: g.position.x, wz: g.position.z, powered: false, slotFuse, leverPivot, ind, glow };
});
const poweredFloors = new Set();
const allPowered = () => game.power >= panels.length;

function resetPanel(p) {
  game.fuses--;
  game.power++;
  p.powered = true;
  poweredFloors.add(p.floor);
  p.slotFuse.visible = true;
  p.leverPivot.rotation.x = 0.7;                // up: on
  p.ind.material.color.setHex(GREEN);
  p.glow.color.setHex(GREEN);
  audio.breaker();
  lights.powerFloor(p.floor, FH);
  noise(p.wx, p.base, p.wz, OBJ.noiseRadius, true);
  if (game.monster) {
    game.monster.respawnCut = game.power * OBJ.respawnCutPerPanel;
    game.monster.respawnMinGap = OBJ.respawnMinGap;
    game.monster.alert(p.wx, p.base, p.wz, OBJ.alertDelay);
  }
  if (allPowered()) say('Power restored. The front door in reception is unlocked.', 4);
  else say(`The lights stutter on. Power ${game.power} / ${panels.length}.`, 3);
  updateObjectiveHud();
}

// ---------- UI ----------
const ui = { prompt: $('prompt'), msg: $('msg'), stamina: $('stamina'), objective: $('objective'), holdWrap: $('holdWrap'), hold: $('hold'), vignette: $('vignette'), hud: $('hud') };
function updateObjectiveHud() {
  ui.objective.textContent = `Power: ${game.power} / ${panels.length}\nFuses carried: ${game.fuses}`;
}
updateObjectiveHud();
let hinted = false;
function startHint() {
  if (hinted) return;
  hinted = true;
  say('The power is out. Find fuses and reset the breaker on each floor.', 5);
}
let msgTimer = 0;
function say(text, seconds = 2.2) {
  ui.msg.textContent = text;
  ui.msg.style.opacity = 1;
  msgTimer = seconds;
}
function show(id) {
  for (const s of document.querySelectorAll('.screen')) s.classList.toggle('show', s.id === id);
}
// film grain: a small noise tile, jittered every frame
{
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const g = c.getContext('2d'), img = g.createImageData(128, 128);
  for (let i = 0; i < img.data.length; i += 4) { const v = Math.random() * 255; img.data[i] = img.data[i + 1] = img.data[i + 2] = v; img.data[i + 3] = 255; }
  g.putImageData(img, 0, 0);
  $('grain').style.backgroundImage = `url(${c.toDataURL()})`;
}

function begin() {
  audio.start();
  game.state = 'playing';
  player.active = true;
  show(null);
  startHint();
  if (!DEBUG) Promise.resolve(canvas.requestPointerLock()).catch(() => {});
}
$('startBtn').addEventListener('click', begin);
$('resumeBtn').addEventListener('click', begin);
for (const b of document.querySelectorAll('.restart')) b.addEventListener('click', () => location.reload());
document.addEventListener('pointerlockchange', () => {
  if (DEBUG) return;
  if (document.pointerLockElement !== canvas && game.state === 'playing') {
    game.state = 'paused';
    player.active = false;
    show('paused');
  }
});
if (DEBUG) { game.state = 'playing'; player.active = true; show(null); startHint(); }

function endGame(state) {
  game.state = state;
  player.active = false;
  player.keys.clear();
  if (document.pointerLockElement) document.exitPointerLock();
  show(state === 'won' ? 'win' : 'dead');
}

// ---------- doors ----------
function openDoor(d, open, opts = {}) {
  if (!d.dynamic || d.target === (open ? 1 : 0)) return;
  d.target = open ? 1 : 0;
  d.speed = opts.slow ? 0.55 : 2.4;
  const dist = Math.hypot(d.x - player.pos.x, d.z - player.pos.z, (d.y - player.feetY) * 2);
  const vol = Math.max(0, 1 - dist / 22) ** 1.5 * (opts.loud ? 1.6 : 1);
  if (open) audio.doorOpen(vol, opts.slow); else audio.doorClose(vol);
}
function updateDoors(dt) {
  for (const d of world.doors) {
    if (!d.dynamic || d.t === d.target) continue;
    const dir = Math.sign(d.target - d.t);
    d.t = Math.max(0, Math.min(1, d.t + dir * dt * d.speed));
    d.pose();
  }
}
for (const d of world.doors) if (d.dynamic) d.pose();

// ---------- monster ----------
function caught() {
  if (game.state !== 'playing') return;
  game.state = 'dying';
  game.dieTimer = 1.6;
  player.active = false;
  player.keys.clear();
  ui.prompt.textContent = '';
  ui.vignette.style.opacity = 0;
  setFlash(true);
  flashlight.intensity = 30;
  audio.scream();
  game.monster.startScare();
}
if (data.settings.monsterStart && !params.has('nomonster')) {
  game.monster = new Monster({
    scene, world, data, physics, player, audio, game, camera,
    flashlightOn: () => flashOn, openDoor, onCatch: caught,
    sightBonus: () => (poweredFloors.has(currentFloor()) ? OBJ.sightBonus : 0),
  });
}

// ---------- interaction ----------
const doorTargets = world.doors.filter((d) => d.type !== 'opening' && d.type !== 'glassPanel');
function findTarget() {
  if (player.hidden) return { kind: 'leave', label: 'E   Leave hiding spot' };
  const cam = camera.position;
  const panelLabel = () => (game.fuses > 0 ? 'E   Insert fuse and reset breaker' : 'E   Breaker panel');
  const fx = -Math.sin(player.yaw), fz = -Math.cos(player.yaw);
  let best = null, bestScore = -Infinity;
  const consider = (kind, ref, x, y, z, reach, label) => {
    const dx = x - cam.x, dz = z - cam.z, dist = Math.hypot(dx, dz);
    if (dist > reach || Math.abs(y - cam.y) > 1.7) return;
    const dot = dist < 0.45 ? 1 : (dx * fx + dz * fz) / dist;
    if (dot < 0.55) return;
    const score = dot * 2 - dist;
    if (score > bestScore) { bestScore = score; best = { kind, ref, label }; }
  };
  // while E is held at a panel only that panel counts, so the target cannot jump to a nearby fuse
  if (game.hold) {
    const p = game.hold.panel;
    consider('panel', p, p.wx, p.group.position.y, p.wz, 2.0, panelLabel());
    return best;
  }
  for (const p of panels) if (!p.powered) consider('panel', p, p.wx, p.group.position.y, p.wz, 2.0, panelLabel());
  for (const f of fuses) if (!f.taken) consider('fuse', f, f.mesh.position.x, f.mesh.position.y + 0.6, f.mesh.position.z, 1.9, 'E   Take the fuse');
  for (const d of doorTargets) {
    const label = d.isExit ? 'E   Exit' : d.type === 'barrier' ? 'E   Look' : d.locked ? 'E   Try door' : d.target ? 'E   Close door' : 'E   Open door';
    consider('door', d, d.x, d.y + 1.2, d.z, 2.0, label);
  }
  for (const h of data.hidingSpots ?? []) {
    consider('hide', h, h.x, world.levelY(h.floor) + 1.0, h.z, 1.9, `E   Hide ${h.kind}`);
  }
  return best;
}

let target = null;
function interact() {
  if (game.state !== 'playing' || !target) return;
  if (target.kind === 'leave') {
    const spot = player.hidden.spot;
    player.leaveHide();
    game.hideSeen = false;
    return;
  }
  if (target.kind === 'fuse') {
    const f = target.ref;
    f.taken = true;
    scene.remove(f.mesh);
    game.fuses++;
    audio.pickup();
    say('You found a fuse.');
    updateObjectiveHud();
    return;
  }
  if (target.kind === 'panel') {
    if (game.fuses <= 0) { audio.rattle(); say('The breaker needs a fuse.'); return; }
    if (!game.hold) { game.hold = { panel: target.ref, t: 0 }; audio.panelStart(); }
    return;
  }
  if (target.kind === 'hide') {
    const h = target.ref;
    // the monster only knows about the spot if it was looking when you got in
    game.hideSeen = !!game.monster?.seesPlayer;
    player.enterHide(h, world.levelY(h.floor));
    if (h.door) { const d = world.doors.find((x) => x.id === h.door); if (d) openDoor(d, false); }
    return;
  }
  const d = target.ref;
  if (d.isExit) {
    if (!allPowered()) { audio.rattle(); say(`No power. Reset the breakers (${game.power} / ${panels.length}).`, 3); return; }
    if (d.locked) {
      d.locked = false;
      audio.unlock();
      say('The door lock clicks open.');
      openDoor(d, true);
      setTimeout(() => { if (game.state === 'playing') endGame('won'); }, 1500);
    }
    return;
  }
  if (d.locked || !d.dynamic) {
    if (d.type !== 'barrier') audio.rattle();
    say(d.message || 'Locked.');
    noise(d.x, d.y, d.z, 7);
    return;
  }
  openDoor(d, !d.target);
  noise(d.x, d.y, d.z, 14);
}

addEventListener('keydown', (e) => {
  if (e.repeat) return;
  if (e.code === 'KeyE') { game.eHeld = true; interact(); }
  if (e.code === 'KeyF' && game.state === 'playing') { setFlash(!flashOn); audio.click(); }
  if (!DEBUG) return;
  if (e.code === 'KeyM') minimap.toggle();
  if (e.code === 'KeyL') lights.setReview(!lights.review);
  const n = { Digit0: 0, Digit1: 1, Digit2: 2, Digit3: 3 }[e.code];
  if (n !== undefined && world.rooms.some((r) => r.floor === n)) player.teleport(data.settings.hallMidX, 0, world.levelY(n));
});

addEventListener('keyup', (e) => { if (e.code === 'KeyE') game.eHeld = false; });
addEventListener('blur', () => { game.eHeld = false; });

player.onStep = (sprint) => {
  audio.footstep(sprint);
  if (sprint) noise(player.pos.x, player.feetY, player.pos.z, 16);
};

// ---------- debug HUD ----------
const minimap = new Minimap($('minimap'), world, data);
minimap.visible = false;
if (DEBUG) minimap.toggle();
function currentFloor() {
  return Math.max(0, Math.round(player.feetY / FH) + 1);
}
function whereAmI() {
  const { x, z } = player.pos, y = player.feetY;
  for (const s of world.stairwells) {
    if (x >= s.x0 && x <= s.x1 && z >= s.z0 && z <= s.z1 && y > -0.51) return { id: s.id, name: `Stairwell ${s.id.slice(-1)}` };
  }
  let best = null;
  for (const r of world.rooms) {
    if (x < r.x0 || x > r.x1 || z < r.z0 || z > r.z1 || Math.abs(r.y - y) > 1.2) continue;
    if (!best || (r.x1 - r.x0) * (r.z1 - r.z0) < (best.x1 - best.x0) * (best.z1 - best.z0)) best = r;
  }
  return best;
}
function debugMarks() {
  return [
    ...fuses.filter((f) => !f.taken).map((f) => ({ x: f.spawn.x, z: f.spawn.z, floor: f.spawn.floor, ch: 'F', color: '#ffb020' })),
    ...panels.map((p) => ({ x: p.wx, z: p.wz, floor: p.floor, ch: 'P', color: p.powered ? '#30ff60' : '#ff3a2a' })),
  ];
}
let frames = 0, fps = 0, fpsTime = 0;
function updateHud(dt) {
  frames++; fpsTime += dt;
  if (fpsTime < 0.5) return;
  fps = Math.round(frames / fpsTime); frames = 0; fpsTime = 0;
  const r = whereAmI();
  ui.hud.textContent =
    `Floor ${currentFloor()}  ${r ? `${r.name}  [${r.id}]` : '(between rooms)'}\n` +
    `x ${player.pos.x.toFixed(1)}   z ${player.pos.z.toFixed(1)}   facing ${player.facingDeg.toFixed(0)} deg\n` +
    `${fps} fps   fuses: ${fuses.map((f) => f.id + (f.taken ? '(taken)' : '')).join(', ') || '-'}\n` +
    `panels: ${panels.map((p) => `${p.id} ${p.powered ? 'ON' : 'off'}`).join('  ')}   carried ${game.fuses}   power ${game.power}/${panels.length}` + (game.monster ? `\nmonster: ${game.monster.debugText()}` : '');
}

// ---------- update / render ----------
function update(dt) {
  game.time += dt;
  if (game.state === 'playing') {
    player.update(dt);
    updateDoors(dt);
    game.monster?.update(dt);
    game.noises.length = 0;
    target = findTarget();
    ui.prompt.textContent = target ? target.label : '';
    // hold E at a panel: releasing or looking away cancels
    if (game.hold) {
      const h = game.hold;
      if (!game.eHeld || target?.ref !== h.panel || h.panel.powered || game.fuses <= 0) game.hold = null;
      else {
        h.t += dt;
        if (h.t >= OBJ.holdTime) { game.hold = null; resetPanel(h.panel); target = null; ui.prompt.textContent = ''; }
      }
    }
    ui.holdWrap.style.display = game.hold ? 'block' : 'none';
    if (game.hold) ui.hold.style.width = `${Math.min(1, game.hold.t / OBJ.holdTime) * 100}%`;
    ui.stamina.style.width = `${player.stamina * 100}%`;
    ui.stamina.classList.toggle('low', player.exhausted);
    ui.vignette.style.opacity = player.hidden ? 1 : 0;
    for (const f of fuses) if (!f.taken) f.mesh.rotation.y += dt * 1.2;
    // walkie sway
    walkie.position.y = -0.22 + Math.sin(player.bob * 2) * 0.006;
    walkie.position.x = 0.24 + Math.cos(player.bob) * 0.004;
  } else if (game.state === 'dying') {
    game.monster?.update(dt);
    updateDoors(dt);
    camera.rotation.z = (Math.random() - 0.5) * 0.05;
    game.dieTimer -= dt;
    if (game.dieTimer <= 0) endGame('dead');
  }
  if (msgTimer > 0) { msgTimer -= dt; if (msgTimer <= 0) ui.msg.style.opacity = 0; }
  const level = game.monster ? game.monster.staticLevel() : 0;
  audio.updateStatic(game.state === 'playing' || game.state === 'dying' ? level : 0, dt, game.state !== 'title');
  // LED follows the static: steady green when silent, blinking amber then red, faster as it nears
  const sl = audio.staticLevel;
  walkie.userData.led.material.color.setHex(sl <= 0 || Math.sin(game.time * (6 + sl * 30)) <= 0 ? 0x30ff50 : sl > 0.5 ? 0xff3020 : 0xffa020);
  // the player is looking at it: terror layer (static is already at full via staticLevel)
  audio.updateTerror(game.state === 'playing' && !!game.monster?.visible, dt);
  lights.update(dt, camera.position);
}

const grain = $('grain');
const clock = new THREE.Clock();
function frame() {
  const dt = Math.min(clock.getDelta(), 0.05);
  update(dt);
  if (DEBUG) { updateHud(dt); minimap.draw(player, currentFloor(), game.monster, debugMarks()); }
  grain.style.transform = `translate(${(Math.random() * 100) | 0}px, ${(Math.random() * 100) | 0}px)`;
  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}
frame();

export { game, world, physics, player, audio, scene, camera, noise, endGame, openDoor, say, data };
if (DEBUG) window.__game = { THREE, scene, camera, renderer, world, physics, player, data, game, lights, audio, update, interact, findTarget, fuses, panels, OBJ, resetPanel, poweredFloors, monster: game.monster, openDoor, setFlash, get target() { return target; }, set target(t) { target = t; } };
