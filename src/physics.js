// Minimal collision world.
//  colliders: upright boxes  { cx, cz, hx, hz, rot, y0, y1, enabled?, seeThrough? }
//  surfaces:  walkable rects { x0, x1, z0, z1, yA, yB }  (height runs yA at z0 -> yB at z1; flat when equal)

export class Physics {
  constructor(colliders, surfaces) {
    this.colliders = colliders;
    this.surfaces = surfaces;
  }

  // Highest walkable surface under (x,z) that is not above the feet by more than stepUp.
  groundAt(x, z, feetY, stepUp = 0.6) {
    let best = -Infinity;
    for (const s of this.surfaces) {
      if (x < s.x0 || x > s.x1 || z < s.z0 || z > s.z1) continue;
      const h = s.yA === s.yB ? s.yA : s.yA + ((z - s.z0) / (s.z1 - s.z0)) * (s.yB - s.yA);
      if (h <= feetY + stepUp && h > best) best = h;
    }
    return best;
  }

  // Push a vertical cylinder (radius r, from feetY+0.35 to feetY+height) out of all colliders.
  resolve(pos, r, feetY, height, skipLow = false) {
    const lo = feetY + 0.35, hi = feetY + height;
    for (let pass = 0; pass < 3; pass++) {
      let moved = false;
      for (const c of this.colliders) {
        if (c.enabled === false || c.y1 <= lo || c.y0 >= hi || (skipLow && c.low)) continue;
        let dx = pos.x - c.cx, dz = pos.z - c.cz;
        if (Math.abs(dx) > c.hx + c.hz + r + 0.5 || Math.abs(dz) > c.hx + c.hz + r + 0.5) continue;
        let cos = 1, sin = 0;
        if (c.rot) {
          cos = Math.cos(c.rot); sin = Math.sin(c.rot);
          const lx = dx * cos - dz * sin, lz = dx * sin + dz * cos;
          dx = lx; dz = lz;
        }
        const qx = Math.max(-c.hx, Math.min(c.hx, dx));
        const qz = Math.max(-c.hz, Math.min(c.hz, dz));
        let ox = dx - qx, oz = dz - qz;
        const d2 = ox * ox + oz * oz;
        if (d2 >= r * r) continue;
        let px, pz;
        if (d2 > 1e-10) {
          const d = Math.sqrt(d2), k = (r - d) / d;
          px = ox * k; pz = oz * k;
        } else {
          // centre is inside the box: leave through the nearest face
          const ex = c.hx - Math.abs(dx), ez = c.hz - Math.abs(dz);
          if (ex < ez) { px = (dx < 0 ? -1 : 1) * (ex + r); pz = 0; }
          else { px = 0; pz = (dz < 0 ? -1 : 1) * (ez + r); }
        }
        if (c.rot) {
          const wx = px * cos + pz * sin, wz = -px * sin + pz * cos;
          px = wx; pz = wz;
        }
        pos.x += px; pos.z += pz;
        moved = true;
      }
      if (!moved) break;
    }
  }

  // Distance along a ray to the first solid collider, or Infinity. Used for line of sight later.
  raycast(ox, oy, oz, dx, dy, dz, maxDist, throughGlass = true, skipLow = false) {
    let best = maxDist;
    let hit = false;
    for (const c of this.colliders) {
      if (c.enabled === false) continue;
      if (throughGlass && c.seeThrough) continue;
      if (skipLow && c.low) continue;
      let px = ox - c.cx, pz = oz - c.cz, rx = dx, rz = dz;
      if (c.rot) {
        const cos = Math.cos(c.rot), sin = Math.sin(c.rot);
        const lx = px * cos - pz * sin, lz = px * sin + pz * cos;
        px = lx; pz = lz;
        const mx = rx * cos - rz * sin, mz = rx * sin + rz * cos;
        rx = mx; rz = mz;
      }
      let t0 = 0, t1 = best;
      const slab = (p, d, lo, hi) => {
        if (Math.abs(d) < 1e-9) return p >= lo && p <= hi;
        let a = (lo - p) / d, b = (hi - p) / d;
        if (a > b) [a, b] = [b, a];
        if (a > t0) t0 = a;
        if (b < t1) t1 = b;
        return t0 <= t1;
      };
      if (!slab(px, rx, -c.hx, c.hx)) continue;
      if (!slab(pz, rz, -c.hz, c.hz)) continue;
      if (!slab(oy, dy, c.y0, c.y1)) continue;
      if (t0 < best) { best = t0; hit = true; }
    }
    return hit ? best : Infinity;
  }
}
