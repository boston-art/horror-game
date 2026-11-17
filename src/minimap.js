// Top-down debug map drawn straight from the map data, for checking and correcting the layout.

const SCALE = 11; // pixels per metre
const X0 = -13.5, Z0 = -13.6;

export class Minimap {
  constructor(canvas, world, data) {
    this.canvas = canvas;
    this.g = canvas.getContext('2d');
    this.world = world;
    this.data = data;
    this.visible = true;
  }

  toggle() {
    this.visible = !this.visible;
    this.canvas.style.display = this.visible ? 'block' : 'none';
  }

  draw(player, floor, monster) {
    if (!this.visible) return;
    const g = this.g, W = this.canvas.width, H = this.canvas.height;
    const px = (x) => (x - X0) * SCALE, pz = (z) => (z - Z0) * SCALE;
    g.clearRect(0, 0, W, H);
    g.font = '9px ui-monospace, Menlo, monospace';
    g.textAlign = 'center';

    for (const r of this.world.rooms) {
      if (Math.abs(r.floor - floor) > 0.6) continue;
      const half = r.floor !== floor;
      g.beginPath();
      r.pts.forEach(([x, z], i) => (i ? g.lineTo(px(x), pz(z)) : g.moveTo(px(x), pz(z))));
      g.closePath();
      g.fillStyle = half ? 'rgba(90,90,120,.35)' : 'rgba(150,150,140,.35)';
      g.fill();
      g.strokeStyle = '#bbb';
      g.lineWidth = 1;
      g.stroke();
      if (r.x1 - r.x0 >= 4.4 && r.z1 - r.z0 >= 3) {
        g.fillStyle = '#ddd';
        g.fillText(r.name, px((r.x0 + r.x1) / 2), pz((r.z0 + r.z1) / 2) + 3, (r.x1 - r.x0) * SCALE - 4);
      }
    }
    for (const s of this.world.stairwells) {
      g.strokeStyle = '#8ad';
      g.strokeRect(px(s.x0), pz(s.z0), (s.x1 - s.x0) * SCALE, (s.z1 - s.z0) * SCALE);
      g.beginPath();
      for (let z = s.z0; z < s.zf; z += 0.28) { g.moveTo(px(s.x0), pz(z)); g.lineTo(px(s.x1), pz(z)); }
      g.strokeStyle = 'rgba(136,170,221,.45)';
      g.stroke();
    }
    for (const d of this.world.doors) {
      if (d.data.floor !== floor) continue;
      const w = d.width / 2;
      g.beginPath();
      if (d.axis === 'x') { g.moveTo(px(d.x - w), pz(d.z)); g.lineTo(px(d.x + w), pz(d.z)); }
      else { g.moveTo(px(d.x), pz(d.z - w)); g.lineTo(px(d.x), pz(d.z + w)); }
      g.lineWidth = 3;
      g.strokeStyle = d.isExit ? '#ffd400' : d.type === 'opening' ? '#3a3a3a' : d.type === 'glassPanel' ? '#7fd0ff' : d.locked ? '#e0453a' : '#4bd66a';
      g.stroke();
    }
    g.textAlign = 'center';
    for (const k of this.data.keySpawns ?? []) {
      if (Math.abs(k.floor - floor) > 0.6) continue;
      g.fillStyle = '#ffb020';
      g.fillText('K', px(k.x), pz(k.z) + 3);
    }
    for (const h of this.data.hidingSpots ?? []) {
      if (h.floor !== floor) continue;
      g.fillStyle = '#40d0e0';
      g.fillText('H', px(h.x), pz(h.z) + 3);
    }

    // player arrow
    const a = (player.facingDeg * Math.PI) / 180;
    const x = px(player.pos.x), z = pz(player.pos.z);
    g.fillStyle = '#fff';
    g.beginPath();
    g.moveTo(x + Math.cos(a) * 7, z + Math.sin(a) * 7);
    g.lineTo(x + Math.cos(a + 2.5) * 5, z + Math.sin(a + 2.5) * 5);
    g.lineTo(x + Math.cos(a - 2.5) * 5, z + Math.sin(a - 2.5) * 5);
    g.fill();

    if (monster?.ready) {
      const same = Math.abs(monster.pos.y - player.feetY) < 1.9;
      g.fillStyle = same ? '#ff3020' : 'rgba(255,48,32,.35)';
      g.beginPath(); g.arc(px(monster.pos.x), pz(monster.pos.z), 5, 0, Math.PI * 2); g.fill();
      g.strokeStyle = 'rgba(255,48,32,.5)'; g.lineWidth = 1; g.beginPath();
      monster.path.forEach((n, i) => (i ? g.lineTo(px(n.x), pz(n.z)) : g.moveTo(px(n.x), pz(n.z))));
      g.stroke();
    }
    g.textAlign = 'left';
    g.fillStyle = '#aaa';
    g.fillText(`FLOOR ${floor}   A <- x -> B   red: locked  green: open  yellow: exit  K: key spawn  H: hiding spot`, 6, H - 6);
  }
}
