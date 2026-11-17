import * as THREE from 'three';

// Small seeded RNG so textures are identical every run.
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function canvasTexture(size, draw) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  draw(c.getContext('2d'), size);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

function speckle(g, s, r, n, colors, maxSize = 2) {
  for (let i = 0; i < n; i++) {
    g.fillStyle = colors[(r() * colors.length) | 0];
    g.globalAlpha = 0.08 + r() * 0.25;
    const k = 0.5 + r() * maxSize;
    g.fillRect(r() * s, r() * s, k, k);
  }
  g.globalAlpha = 1;
}

function concreteTex() {
  return canvasTexture(1024, (g, s) => {
    const r = rng(7);
    g.fillStyle = '#b3a288';
    g.fillRect(0, 0, s, s);
    // large soft blotches (worn polish), drawn wrapped so the texture tiles without seams
    for (let i = 0; i < 70; i++) {
      const x = r() * s, y = r() * s, rad = 60 + r() * 200;
      const dark = r() < 0.5;
      for (const ox of [-s, 0, s]) for (const oy of [-s, 0, s]) {
        if (x + ox + rad < 0 || x + ox - rad > s || y + oy + rad < 0 || y + oy - rad > s) continue;
        const grd = g.createRadialGradient(x + ox, y + oy, 0, x + ox, y + oy, rad);
        grd.addColorStop(0, dark ? 'rgba(90,78,60,0.14)' : 'rgba(215,200,172,0.14)');
        grd.addColorStop(1, 'rgba(0,0,0,0)');
        g.fillStyle = grd;
        g.fillRect(x + ox - rad, y + oy - rad, rad * 2, rad * 2);
      }
    }
    speckle(g, s, r, 26000, ['#6f6452', '#d6c9ad', '#8d806a', '#4d4538']);
    // a few hairline cracks, also wrapped
    g.strokeStyle = 'rgba(60,50,38,0.55)';
    for (let i = 0; i < 4; i++) {
      let x = r() * s, y = r() * s, a = r() * Math.PI * 2;
      const pts = [[x, y]];
      const n = 30 + ((r() * 40) | 0);
      for (let k = 0; k < n; k++) {
        a += (r() - 0.5) * 0.7;
        x += Math.cos(a) * 9;
        y += Math.sin(a) * 9;
        pts.push([x, y]);
      }
      g.lineWidth = 0.7 + r() * 0.6;
      for (const ox of [-s, 0, s]) for (const oy of [-s, 0, s]) {
        g.beginPath();
        pts.forEach(([px, py], k) => (k ? g.lineTo(px + ox, py + oy) : g.moveTo(px + ox, py + oy)));
        g.stroke();
      }
    }
  });
}

function wallTex() {
  return canvasTexture(256, (g, s) => {
    const r = rng(3);
    g.fillStyle = '#e6e0d1';
    g.fillRect(0, 0, s, s);
    speckle(g, s, r, 2500, ['#d8d1c0', '#f1ecdf', '#cfc8b6'], 3);
  });
}

function ceilingTileTex() {
  // one texture tile = one 0.6 m ceiling tile
  return canvasTexture(256, (g, s) => {
    const r = rng(11);
    g.fillStyle = '#d9d6cc';
    g.fillRect(0, 0, s, s);
    speckle(g, s, r, 1800, ['#b9b5a8', '#c9c5b9', '#eeeae0'], 2);
    g.strokeStyle = '#a9a598';
    g.lineWidth = 5;
    g.strokeRect(0, 0, s, s);
  });
}

function carpetTex() {
  return canvasTexture(512, (g, s) => {
    const r = rng(19);
    g.fillStyle = '#62656a';
    g.fillRect(0, 0, s, s);
    speckle(g, s, r, 30000, ['#4a4d52', '#7b7e84', '#55585d', '#8a8d92'], 3);
  });
}

// made-up abstract artwork (nothing copied from the real building)
function artTex(seed) {
  const t = canvasTexture(128, (g, s) => {
    const r = rng(seed);
    const pal = [['#27374d', '#dda15e', '#e9edc9'], ['#6b2737', '#e08e45', '#f8f4a6'], ['#1b4332', '#95d5b2', '#d8f3dc'], ['#3d405b', '#e07a5f', '#f4f1de'], ['#22223b', '#9a8c98', '#f2e9e4'], ['#14213d', '#fca311', '#e5e5e5']][seed % 6];
    g.fillStyle = pal[2]; g.fillRect(0, 0, s, s);
    for (let i = 0; i < 9; i++) {
      g.fillStyle = pal[(r() * 3) | 0]; g.globalAlpha = 0.55 + r() * 0.45;
      if (r() < 0.5) g.fillRect(r() * s, r() * s, 20 + r() * 70, 8 + r() * 60);
      else { g.beginPath(); g.arc(r() * s, r() * s, 8 + r() * 30, 0, 7); g.fill(); }
    }
    g.globalAlpha = 1;
  });
  return t;
}

function woodTex(base, dark, seed) {
  return canvasTexture(512, (g, s) => {
    const r = rng(seed);
    g.fillStyle = base;
    g.fillRect(0, 0, s, s);
    g.strokeStyle = dark;
    for (let i = 0; i < 90; i++) {
      g.globalAlpha = 0.08 + r() * 0.2;
      g.lineWidth = 1 + r() * 3;
      const x = r() * s;
      g.beginPath();
      g.moveTo(x, 0);
      g.bezierCurveTo(x + (r() - 0.5) * 40, s * 0.33, x + (r() - 0.5) * 40, s * 0.66, x + (r() - 0.5) * 20, s);
      g.stroke();
    }
    g.globalAlpha = 1;
  });
}

// tile = how many metres one repeat of the texture covers (used by the world-space UV pass)
function std(opts, tile = 1) {
  const m = new THREE.MeshStandardMaterial(opts);
  m.userData.tile = tile;
  return m;
}

export function createMaterials() {
  const wood = woodTex('#8a5a33', '#4a2c14', 5);
  const woodFire = woodTex('#7c4f26', '#2e1a08', 9);
  return {
    concrete: std({ map: concreteTex(), roughness: 0.32, metalness: 0.0 }, 6),
    concreteStair: std({ map: concreteTex(), roughness: 0.75, color: 0xb0aa9c }, 5),
    carpet: std({ map: carpetTex(), roughness: 1 }, 1.5),
    wall: std({ map: wallTex(), roughness: 0.9 }, 2),
    ceilingSmooth: std({ color: 0xdedbd2, roughness: 0.95 }),
    ceilingTile: std({ map: ceilingTileTex(), roughness: 0.95 }, 0.6),
    ceilingVault: std({ color: 0xdedbd2, roughness: 0.95, side: THREE.DoubleSide }),
    acoustic: std({ color: 0x8e9196, roughness: 1 }),
    woodTrim: std({ map: wood, roughness: 0.55, color: 0xd9b48a }, 1.2),
    woodDoor: std({ map: wood, roughness: 0.5 }, 1.2),
    woodFire: std({ map: woodFire, roughness: 0.45 }, 1.2),
    deskWood: std({ map: wood, roughness: 0.5, color: 0xc9a27a }, 1.2),
    white: std({ color: 0xeeeeea, roughness: 0.8 }),
    black: std({ color: 0x141414, roughness: 0.45, metalness: 0.6 }),
    metalDark: std({ color: 0x2b2824, roughness: 0.4, metalness: 0.8 }),
    metalElev: std({ color: 0x3a3632, roughness: 0.5, metalness: 0.7 }),
    brass: std({ color: 0x9a7a3a, roughness: 0.35, metalness: 0.9 }),
    red: std({ color: 0xb01818, roughness: 0.5 }),
    glassDark: std({ color: 0x05070a, roughness: 0.05, metalness: 0.2, transparent: true, opacity: 0.78 }),
    glassClear: std({ color: 0x9fb4b8, roughness: 0.05, metalness: 0.1, transparent: true, opacity: 0.22 }),
    windowNight: std({ color: 0x020409, roughness: 0.05, metalness: 0.6 }),
    paneRed: std({ color: 0x8a1c1c, roughness: 0.2, emissive: 0x2a0505 }),
    paneBlue: std({ color: 0x1c3f8a, roughness: 0.2, emissive: 0x050a2a }),
    paneGreen: std({ color: 0x1f6a3a, roughness: 0.2, emissive: 0x052a10 }),
    paneAmber: std({ color: 0xb07a1c, roughness: 0.2, emissive: 0x2a1a05 }),
    whiteboard: std({ color: 0xe8ecec, roughness: 0.25 }),
    shelfWood: std({ map: wood, roughness: 0.6, color: 0xb98a60 }, 1.2),
    bookRed: std({ color: 0x7a2424, roughness: 0.8 }),
    bookBlue: std({ color: 0x24406e, roughness: 0.8 }),
    bookTan: std({ color: 0xb09a72, roughness: 0.8 }),
    bookGreen: std({ color: 0x2f5a3c, roughness: 0.8 }),
    bookDark: std({ color: 0x2a2622, roughness: 0.8 }),
    fabricGrey: std({ color: 0x45484c, roughness: 0.95 }),
    leatherBrown: std({ color: 0x4a2f22, roughness: 0.45 }),
    leatherBlack: std({ color: 0x101010, roughness: 0.35 }),
    chrome: std({ color: 0xbfc4c8, roughness: 0.2, metalness: 1 }),
    stumpWood: std({ map: woodFire, roughness: 0.9, color: 0x9a7a5a }, 0.8),
    plantGreen: std({ color: 0x2c5a2a, roughness: 0.8 }),
    plantPink: std({ color: 0x8a4a68, roughness: 0.8 }),
    cork: std({ color: 0x9a7a52, roughness: 1 }),
    corkBlack: std({ color: 0x18181a, roughness: 1 }),
    sinkGrey: std({ color: 0x55585c, roughness: 0.4 }),
    mirror: std({ color: 0x8f989c, roughness: 0.05, metalness: 1 }),
    blueGlow: std({ color: 0x1d5fd0, emissive: 0x0a3fb0, emissiveIntensity: 0.9, roughness: 0.4 }),
    lampGlow: std({ color: 0x555049, emissive: 0x2a251c, roughness: 0.4 }),
    artA: std({ map: artTex(0), roughness: 0.8 }), artB: std({ map: artTex(1), roughness: 0.8 }),
    artC: std({ map: artTex(2), roughness: 0.8 }), artD: std({ map: artTex(3), roughness: 0.8 }),
    artE: std({ map: artTex(4), roughness: 0.8 }), artF: std({ map: artTex(5), roughness: 0.8 }),
    glassFrost: std({ color: 0xc8d4d6, roughness: 0.6, transparent: true, opacity: 0.55 }),
    chairBlue: std({ color: 0x27365c, roughness: 0.8 }),
    cabinetGrey: std({ color: 0x7c8086, roughness: 0.6, metalness: 0.3 }),
    cabinetDoor: std({ color: 0x8a8e94, roughness: 0.5, metalness: 0.35 }),
    tableOak: std({ map: wood, roughness: 0.55, color: 0xf0c890 }, 1.2),
    void: new THREE.MeshBasicMaterial({ color: 0x000000 }),
  };
}

// Rewrites UVs from world position so textures keep a constant real-world scale
// on every wall/floor no matter how the box was sized.
export function applyWorldUV(geo, tile) {
  const p = geo.attributes.position, n = geo.attributes.normal, uv = geo.attributes.uv;
  if (!p || !n || !uv) return;
  for (let i = 0; i < p.count; i++) {
    const ax = Math.abs(n.getX(i)), ay = Math.abs(n.getY(i)), az = Math.abs(n.getZ(i));
    let u, v;
    if (ay > ax && ay > az) { u = p.getX(i); v = p.getZ(i); }
    else if (ax > az) { u = p.getZ(i); v = p.getY(i); }
    else { u = p.getX(i); v = p.getY(i); }
    uv.setXY(i, u / tile, v / tile);
  }
  uv.needsUpdate = true;
}
