import * as THREE from 'three';

const RADIUS = 0.3;
const HEIGHT = 1.75;
export const EYE = 1.62;
export const WALK = 2.7;
export const SPRINT = 5.2;
const SPRINT_SECONDS = 6;      // full bar lasts this long
const REGEN_WALKING = 11;      // seconds to refill while walking
const REGEN_STANDING = 7;      // seconds to refill while standing still

export class Player {
  constructor(camera, physics, dom) {
    this.camera = camera;
    this.physics = physics;
    this.pos = { x: 0, z: 0 };
    this.feetY = 0;
    this.vy = 0;
    this.vel = { x: 0, z: 0 };
    this.yaw = 0;
    this.pitch = 0;
    this.onGround = true;
    this.active = false; // true while the game is being played
    this.keys = new Set();
    this.bob = 0;
    this.spawn = null;
    this.stamina = 1;
    this.exhausted = false;
    this.hidden = null;      // { spot, back } while in a hiding spot
    this.eye = EYE;
    this.stride = 0;
    this.onStep = null;      // callback(sprinting)
    this.isSprinting = false;
    this.speed = 0;
    camera.rotation.order = 'YXZ';

    addEventListener('keydown', (e) => this.keys.add(e.code));
    addEventListener('keyup', (e) => this.keys.delete(e.code));
    addEventListener('blur', () => this.keys.clear());
    dom.addEventListener('mousemove', (e) => {
      if (document.pointerLockElement !== dom || !this.active) return;
      this.yaw -= e.movementX * 0.0022;
      this.pitch = Math.max(-1.45, Math.min(1.45, this.pitch - e.movementY * 0.0022));
    });
  }

  // facingDeg: 0 = toward stairwell B (+x), 90 = toward the right-hand side (+z), 180 = toward A, 270 = left
  teleport(x, z, feetY, facingDeg) {
    this.pos.x = x; this.pos.z = z; this.feetY = feetY;
    this.vy = 0; this.vel.x = this.vel.z = 0;
    this.hidden = null; this.eye = EYE;
    if (facingDeg !== undefined) this.face(facingDeg);
    this.syncCamera(0);
  }

  face(deg) {
    this.yaw = -THREE.MathUtils.degToRad(deg + 90);
    this.pitch = 0;
  }

  enterHide(spot, y) {
    this.hidden = { spot, back: { x: this.pos.x, z: this.pos.z, y: this.feetY } };
    this.pos.x = spot.x; this.pos.z = spot.z; this.feetY = y;
    this.vel.x = this.vel.z = 0;
    if (spot.facingDeg !== undefined) this.face(spot.facingDeg);
  }

  leaveHide() {
    const b = this.hidden.back;
    this.pos.x = b.x; this.pos.z = b.z; this.feetY = b.y;
    this.hidden = null;
  }

  update(dt) {
    const k = this.keys;
    let f = 0, s = 0;
    if (this.active && !this.hidden) {
      if (k.has('KeyW') || k.has('ArrowUp')) f += 1;
      if (k.has('KeyS') || k.has('ArrowDown')) f -= 1;
      if (k.has('KeyD') || k.has('ArrowRight')) s += 1;
      if (k.has('KeyA') || k.has('ArrowLeft')) s -= 1;
    }
    const wantsMove = f !== 0 || s !== 0;
    const len = Math.hypot(f, s) || 1;
    f /= len; s /= len;

    // stamina
    const shift = k.has('ShiftLeft') || k.has('ShiftRight');
    this.isSprinting = shift && wantsMove && !this.exhausted && this.active;
    if (this.isSprinting) {
      this.stamina -= dt / SPRINT_SECONDS;
      if (this.stamina <= 0) { this.stamina = 0; this.exhausted = true; }
    } else {
      this.stamina = Math.min(1, this.stamina + dt / (wantsMove ? REGEN_WALKING : REGEN_STANDING));
      if (this.stamina > 0.25) this.exhausted = false;
    }

    const speed = this.isSprinting ? SPRINT : WALK;
    const sin = Math.sin(this.yaw), cos = Math.cos(this.yaw);
    const tx = (-sin * f + cos * s) * speed;
    const tz = (-cos * f - sin * s) * speed;
    const a = Math.min(1, dt * 12);
    this.vel.x += (tx - this.vel.x) * a;
    this.vel.z += (tz - this.vel.z) * a;

    if (!this.hidden) {
      // sub-step so a long frame cannot tunnel through a thin wall
      const dist = Math.hypot(this.vel.x, this.vel.z) * dt;
      const steps = Math.max(1, Math.ceil(dist / 0.15));
      const bx = this.pos.x, bz = this.pos.z;
      for (let i = 0; i < steps; i++) {
        this.pos.x += (this.vel.x * dt) / steps;
        this.pos.z += (this.vel.z * dt) / steps;
        this.physics.resolve(this.pos, RADIUS, this.feetY, HEIGHT);
      }
      const moved = Math.hypot(this.pos.x - bx, this.pos.z - bz);
      this.speed = moved / Math.max(dt, 1e-4);

      const g = this.physics.groundAt(this.pos.x, this.pos.z, this.feetY);
      if (g > -Infinity && (this.feetY <= g + 0.02 || (this.onGround && this.feetY - g < 0.5))) {
        this.feetY += (g - this.feetY) * Math.min(1, dt * 20);
        if (Math.abs(g - this.feetY) < 0.002) this.feetY = g;
        this.vy = 0;
        this.onGround = true;
      } else {
        this.onGround = false;
        this.vy -= 22 * dt;
        this.feetY += this.vy * dt;
        if (g > -Infinity && this.feetY < g) { this.feetY = g; this.vy = 0; this.onGround = true; }
        if (this.feetY < -30 && this.spawn) this.teleport(this.spawn.x, this.spawn.z, this.spawn.y, this.spawn.facingDeg);
      }

      if (this.onGround && moved > 0) {
        this.stride += moved;
        const need = this.isSprinting ? 1.15 : 0.8;
        if (this.stride >= need) { this.stride = 0; this.onStep?.(this.isSprinting); }
      }
      this.bob += moved * 2.6;
    } else {
      this.speed = 0;
    }

    const eyeTarget = this.hidden ? this.hidden.spot.camY ?? 0.6 : EYE;
    this.eye += (eyeTarget - this.eye) * Math.min(1, dt * 10);
    this.syncCamera(this.speed > 0.3 && this.onGround ? Math.sin(this.bob * 2) * (this.isSprinting ? 0.04 : 0.022) : 0);
  }

  syncCamera(bob) {
    this.camera.position.set(this.pos.x, this.feetY + this.eye + bob, this.pos.z);
    this.camera.rotation.set(this.pitch, this.yaw, 0);
  }

  get facingDeg() {
    return ((((-THREE.MathUtils.radToDeg(this.yaw) - 90) % 360) + 360) % 360);
  }
}
