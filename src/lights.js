import * as THREE from 'three';

// Ceiling fixtures. At night most are dead, a few stay on and some flicker.
// Only the fixtures nearest the camera get a real light; the rest are just glowing shapes.

const FIX = {
  panel: { geo: () => new THREE.BoxGeometry(1.2, 0.04, 0.6), drop: 0.02 },
  drum: { geo: () => new THREE.CylinderGeometry(0.4, 0.4, 0.24, 24), drop: 0.3 },
  lantern: { geo: () => new THREE.CylinderGeometry(0.2, 0.2, 0.26, 12), drop: 0.6 },
};
const ON = new THREE.Color(1.0, 0.93, 0.8), OFF = new THREE.Color(0.055, 0.055, 0.06);
const POOL = 6;

function hash(i) {
  const x = Math.sin(i * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

export class Lights {
  constructor(scene, fixtures) {
    this.fixtures = fixtures;
    this.meshes = [];
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), one = new THREE.Vector3(1, 1, 1), up = new THREE.Vector3(0, 1, 0);
    for (const [type, def] of Object.entries(FIX)) {
      const list = fixtures.filter((f) => f.type === type);
      if (!list.length) continue;
      const mesh = new THREE.InstancedMesh(def.geo(), new THREE.MeshBasicMaterial({ toneMapped: false, fog: false }), list.length);
      list.forEach((f, i) => {
        q.setFromAxisAngle(up, f.alongX ? 0 : Math.PI / 2);
        m4.compose(new THREE.Vector3(f.x, f.y - def.drop, f.z), q, one);
        mesh.setMatrixAt(i, m4);
        mesh.setColorAt(i, OFF);
        f.mesh = mesh; f.index = i; f.ly = f.y - def.drop - 0.25;
      });
      scene.add(mesh);
      this.meshes.push(mesh);
    }
    fixtures.forEach((f, i) => {
      const r = hash(i + 1);
      f.mode = r < 0.1 ? 'on' : r < 0.3 ? 'flicker' : 'off';
      f.lit = f.mode === 'on';
      f.timer = hash(i + 77) * 2;
    });
    this.pool = [];
    for (let i = 0; i < POOL; i++) {
      const l = new THREE.PointLight(0xffe2b8, 0, 11, 1.7);
      scene.add(l);
      this.pool.push(l);
    }
    this.ambient = new THREE.HemisphereLight(0xbfd0ff, 0x302820, 0.05);
    scene.add(this.ambient);
    this.scene = scene;
    this.review = false;
    this.timer = 0;
    this.apply();
  }

  setReview(on) {
    this.review = on;
    this.apply();
  }

  apply() {
    this.ambient.intensity = this.review ? 0.75 : 0.05;
    this.scene.fog = this.review ? null : new THREE.FogExp2(0x000000, 0.04);
    for (const f of this.fixtures) this.paint(f, this.review ? true : f.lit);
    this.timer = 0;
  }

  paint(f, lit) {
    f.shown = lit;
    f.mesh.setColorAt(f.index, lit ? ON : OFF);
    f.mesh.instanceColor.needsUpdate = true;
  }

  update(dt, cam) {
    if (!this.review) {
      for (const f of this.fixtures) {
        if (f.mode !== 'flicker') continue;
        f.timer -= dt;
        if (f.timer <= 0) {
          f.lit = !f.lit;
          f.timer = f.lit ? 0.04 + Math.random() * (Math.random() < 0.3 ? 2.5 : 0.25) : 0.05 + Math.random() * 1.4;
          this.paint(f, f.lit);
        }
      }
    }
    this.timer -= dt;
    if (this.timer <= 0) {
      this.timer = 0.25;
      this.near = this.fixtures
        .filter((f) => this.review || f.mode !== 'off')
        .map((f) => ({ f, d: (f.x - cam.x) ** 2 + (f.z - cam.z) ** 2 + ((f.ly - cam.y) * 4) ** 2 }))
        .sort((a, b) => a.d - b.d)
        .slice(0, POOL);
    }
    this.pool.forEach((l, i) => {
      const n = this.near[i];
      if (!n) { l.intensity = 0; return; }
      l.position.set(n.f.x, n.f.ly, n.f.z);
      l.intensity = this.review ? 7 : n.f.lit ? 5.5 : 0;
    });
  }
}
