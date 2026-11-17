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
  hasKey: false,
  noises: [],            // things the monster can hear: { x, y, z, radius }
  monster: null,
  time: 0,
};
function noise(x, y, z, radius) {
  game.noises.push({ x, y, z, radius });
}

// ---------- fire key ----------
const keyMesh = new THREE.Group();
{
  const red = new THREE.MeshStandardMaterial({ color: 0xd01818, emissive: 0x500000, roughness: 0.35, metalness: 0.4 });
  const ring = new THREE.Mesh(new THREE.TorusGeometry(0.028, 0.009, 8, 18), red);
  const shaft = new THREE.Mesh(new THREE.BoxGeometry(0.075, 0.012, 0.01), red); shaft.position.x = 0.065;
  const t1 = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.022, 0.01), red); t1.position.set(0.09, -0.014, 0);
  const t2 = new THREE.Mesh(new THREE.BoxGeometry(0.01, 0.016, 0.01), red); t2.position.set(0.07, -0.012, 0);
  keyMesh.add(ring, shaft, t1, t2);
  keyMesh.rotation.x = -Math.PI / 2;
  const glow = new THREE.PointLight(0xff2a1a, 0.25, 1.6, 2);
  glow.position.y = 0.1;
  keyMesh.add(glow);
}
let keySpawn = null;
if (data.keySpawns?.length) {
  keySpawn = data.keySpawns[Math.floor(Math.random() * data.keySpawns.length)];
  keyMesh.position.set(keySpawn.x, world.levelY(keySpawn.floor) + (keySpawn.y ?? 0.05) + 0.02, keySpawn.z);
  scene.add(keyMesh);
}

// ---------- UI ----------
const ui = { prompt: $('prompt'), msg: $('msg'), stamina: $('stamina'), key: $('keyicon'), vignette: $('vignette'), hud: $('hud') };
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
if (DEBUG) { game.state = 'playing'; player.active = true; show(null); }

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
  });
}

// ---------- interaction ----------
const doorTargets = world.doors.filter((d) => d.type !== 'opening' && d.type !== 'glassPanel');
function findTarget() {
  if (player.hidden) return { kind: 'leave', label: 'E   Leave hiding spot' };
  const cam = camera.position;
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
  for (const d of doorTargets) {
    const label = d.isExit ? 'E   Exit' : d.type === 'barrier' ? 'E   Look' : d.locked ? 'E   Try door' : d.target ? 'E   Close door' : 'E   Open door';
    consider('door', d, d.x, d.y + 1.2, d.z, 2.0, label);
  }
  for (const h of data.hidingSpots ?? []) {
    consider('hide', h, h.x, world.levelY(h.floor) + 1.0, h.z, 1.9, `E   Hide ${h.kind}`);
  }
  if (keySpawn && !game.hasKey) consider('key', null, keyMesh.position.x, keyMesh.position.y + 0.6, keyMesh.position.z, 1.9, 'E   Take the fire key');
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
  if (target.kind === 'key') {
    game.hasKey = true;
    scene.remove(keyMesh);
    ui.key.style.display = 'block';
    audio.pickup();
    say('You found the fire key.');
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
    if (!game.hasKey) { audio.rattle(); say(d.message); return; }
    if (d.locked) {
      d.locked = false;
      audio.unlock();
      say('The fire key turns.');
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
  if (e.code === 'KeyE') interact();
  if (e.code === 'KeyF' && game.state === 'playing') { setFlash(!flashOn); audio.click(); }
  if (!DEBUG) return;
  if (e.code === 'KeyM') minimap.toggle();
  if (e.code === 'KeyL') lights.setReview(!lights.review);
  const n = { Digit1: 1, Digit2: 2, Digit3: 3 }[e.code];
  if (n && world.rooms.some((r) => r.floor === n)) player.teleport(data.settings.hallMidX, 0, world.levelY(n));
});

player.onStep = (sprint) => {
  audio.footstep(sprint);
  if (sprint) noise(player.pos.x, player.feetY, player.pos.z, 16);
};

// ---------- debug HUD ----------
const minimap = new Minimap($('minimap'), world, data);
minimap.visible = false;
if (DEBUG) minimap.toggle();
function currentFloor() {
  return Math.max(1, Math.round(player.feetY / FH) + 1);
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
let frames = 0, fps = 0, fpsTime = 0;
function updateHud(dt) {
  frames++; fpsTime += dt;
  if (fpsTime < 0.5) return;
  fps = Math.round(frames / fpsTime); frames = 0; fpsTime = 0;
  const r = whereAmI();
  ui.hud.textContent =
    `Floor ${currentFloor()}  ${r ? `${r.name}  [${r.id}]` : '(between rooms)'}\n` +
    `x ${player.pos.x.toFixed(1)}   z ${player.pos.z.toFixed(1)}   facing ${player.facingDeg.toFixed(0)} deg\n` +
    `${fps} fps   key spawn: ${keySpawn?.id ?? '-'}` + (game.monster ? `\nmonster: ${game.monster.debugText()}` : '');
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
    ui.stamina.style.width = `${player.stamina * 100}%`;
    ui.stamina.classList.toggle('low', player.exhausted);
    ui.vignette.style.opacity = player.hidden ? 1 : 0;
    if (keySpawn && !game.hasKey) keyMesh.rotation.z += dt * 1.2;
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
  if (DEBUG) { updateHud(dt); minimap.draw(player, currentFloor(), game.monster); }
  grain.style.transform = `translate(${(Math.random() * 100) | 0}px, ${(Math.random() * 100) | 0}px)`;
  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}
frame();

export { game, world, physics, player, audio, scene, camera, noise, endGame, openDoor, say, data };
if (DEBUG) window.__game = { THREE, scene, camera, renderer, world, physics, player, data, game, lights, audio, update, interact, findTarget, keyMesh, openDoor, setFlash, get target() { return target; }, set target(t) { target = t; } };
