// Furniture and props, all built from boxes. Each entry in map.json "props" is
//   { "type": "...", "floor": 1, "x": .., "z": .., "rot": 0|90|180|270, ...options }
// x,z is the centre of the piece. rot turns it clockwise seen from above.
// Local axes before rotation: +x = the piece's length, +z = its depth (front is -z).

export function buildProp(p, api) {
  const { box, collider, levelY } = api;
  const y0 = levelY(p.floor) + (p.y ?? 0);
  const r = (-(p.rot ?? 0) * Math.PI) / 180;
  const cos = Math.cos(r), sin = Math.sin(r);
  const wx = (lx, lz) => p.x + lx * cos + lz * sin;
  const wz = (lx, lz) => p.z - lx * sin + lz * cos;
  // B: visual box in local coordinates (y measured from the floor to the box centre)
  const B = (mat, lx, y, lz, sx, sy, sz) => box(mat, wx(lx, lz), y0 + y, wz(lx, lz), sx, sy, sz, r);
  // C: collision box in local coordinates
  const C = (lx, lz, sx, sz, h, extra) =>
    collider(wx(lx, lz), wz(lx, lz), sx, sz, y0, y0 + h, { rot: r, ...extra });
  const legs = (mat, w, d, h, t = 0.05) => {
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) B(mat, sx * (w / 2 - t), h / 2, sz * (d / 2 - t), t, h, t);
  };

  switch (p.type) {
    case 'pipe': {
      // exposed pipe / duct / conduit run under the ceiling, visual only: len along local x, size square, yc = centre height
      B(p.mat ?? 'pipe', 0, p.yc ?? 2.4, 0, p.len ?? 4, p.size ?? 0.12, p.size ?? 0.12);
      break;
    }
    case 'box': {
      B(p.mat ?? 'white', 0, p.h / 2, 0, p.w, p.h, p.d);
      C(0, 0, p.w, p.d, p.h, p.seeThrough ? { seeThrough: true } : undefined);
      break;
    }
    case 'receptionDesk': {
      // long counter, crest side (-z) faces the entrance; low white wall and frosted glass behind it
      const w = p.w ?? 3.4;
      B('white', 0, 0.55, -0.36, w * 0.62, 1.1, 0.08);
      B('deskWood', 0, 0.5, 0, w, 1.0, 0.7);
      B('black', 0, 1.02, 0, w + 0.06, 0.04, 0.78);
      B('brass', 0, 0.62, -0.41, 0.5, 0.5, 0.02);
      B('white', 0, 0.48, 1.25, w * 0.8, 0.96, 0.22);
      B('woodTrim', 0, 0.98, 1.25, w * 0.8 + 0.04, 0.05, 0.26);
      B('glassFrost', 0, 1.5, 0.75, w * 0.75, 1.0, 0.03);
      C(0, 0, w, 0.7, 1.05);
      C(0, 1.25, w * 0.8, 0.22, 1.0);
      C(0, 0.75, w * 0.75, 0.05, 2.0, { seeThrough: true });
      break;
    }
    case 'teacherDesk': {
      const w = 1.5, d = 0.75;
      B('deskWood', 0, 0.74, 0, w, 0.05, d);
      B('deskWood', 0, 0.4, -d / 2 + 0.02, w, 0.66, 0.03);          // modesty panel at the front
      B('deskWood', -w / 2 + 0.02, 0.37, 0, 0.03, 0.72, d);
      B('deskWood', w / 2 - 0.02, 0.37, 0, 0.03, 0.72, d);
      B('deskWood', w / 2 - 0.25, 0.45, 0.05, 0.42, 0.5, d - 0.15);  // drawer stack
      C(0, -d / 2 + 0.05, w, 0.1, 0.78);
      C(-w / 2 + 0.03, 0, 0.06, d, 0.78);
      C(w / 2 - 0.25, 0.05, 0.5, d - 0.1, 0.78);
      break;
    }
    case 'studentDesk': {
      B('deskWood', 0, 0.7, 0, 0.62, 0.035, 0.46);
      legs('metalDark', 0.6, 0.44, 0.69, 0.025);
      // chair behind it
      B('chairBlue', 0, 0.44, 0.52, 0.42, 0.04, 0.4);
      B('chairBlue', 0, 0.68, 0.71, 0.42, 0.34, 0.03);
      for (const sx of [-1, 1]) for (const sz of [0.34, 0.7]) B('metalDark', sx * 0.19, 0.22, sz, 0.02, 0.44, 0.02);
      C(0, 0, 0.62, 0.46, 0.74, { low: true });
      C(0, 0.55, 0.42, 0.4, 0.5, { low: true });
      break;
    }
    case 'cabinet': {
      // tall two-door storage cabinet, doors on the -z face
      const w = p.w ?? 1.0, d = 0.55, h = p.h ?? 1.95;
      B('cabinetGrey', 0, h / 2, 0.02, w, h, d - 0.04);
      B('cabinetDoor', -w / 4, h / 2, -d / 2 + 0.01, w / 2 - 0.012, h - 0.04, 0.02);
      B('cabinetDoor', w / 4, h / 2, -d / 2 + 0.01, w / 2 - 0.012, h - 0.04, 0.02);
      B('metalDark', -0.03, h * 0.5, -d / 2 - 0.01, 0.015, 0.14, 0.02);
      B('metalDark', 0.03, h * 0.5, -d / 2 - 0.01, 0.015, 0.14, 0.02);
      C(0, 0, w, d, h);
      break;
    }
    case 'table': {
      const w = p.w ?? 1.8, d = p.d ?? 0.9, mat = p.mat ?? 'tableOak';
      B(mat, 0, 0.74, 0, w, 0.05, d);
      B(mat, 0, 0.67, -d / 2 + 0.06, w - 0.2, 0.09, 0.025);
      B(mat, 0, 0.67, d / 2 - 0.06, w - 0.2, 0.09, 0.025);
      legs(mat, w - 0.06, d - 0.06, 0.72, 0.07);
      C(0, 0, w, d, 0.78);
      break;
    }
    case 'libraryDesk': {
      // L-shaped front desk
      const w = p.w ?? 3.2;
      B('deskWood', 0, 0.52, 0, w, 1.04, 0.65);
      B('black', 0, 1.06, 0, w + 0.04, 0.04, 0.7);
      B('deskWood', w / 2 - 0.33, 0.52, 0.95, 0.65, 1.04, 1.3);
      B('black', w / 2 - 0.33, 1.06, 0.95, 0.7, 0.04, 1.34);
      B('black', -0.6, 1.25, 0.05, 0.5, 0.32, 0.04);   // monitor
      B('black', -0.6, 1.1, 0.08, 0.2, 0.04, 0.16);
      C(0, 0, w, 0.65, 1.08);
      C(w / 2 - 0.33, 0.95, 0.65, 1.3, 1.08);
      break;
    }
    case 'bench': {
      const w = p.w ?? 1.6, d = 0.45;
      for (let i = 0; i < 6; i++) B('woodDoor', 0, 0.42, -d / 2 + 0.04 + i * (d - 0.08) / 5, w, 0.035, 0.055);
      for (const sx of [-1, 1]) {
        B('black', sx * (w / 2 - 0.2), 0.2, -d / 2 + 0.03, 0.035, 0.4, 0.035);
        B('black', sx * (w / 2 - 0.2), 0.2, d / 2 - 0.03, 0.035, 0.4, 0.035);
        B('black', sx * (w / 2 - 0.2), 0.39, 0, 0.035, 0.035, d);
      }
      C(0, 0, w, d, 0.45);
      break;
    }
    case 'chair': {
      B(p.mat ?? 'chairBlue', 0, 0.45, 0, 0.44, 0.05, 0.44);
      B(p.mat ?? 'chairBlue', 0, 0.72, 0.2, 0.44, 0.4, 0.04);
      legs('metalDark', 0.42, 0.42, 0.44, 0.025);
      C(0, 0, 0.44, 0.44, 0.5, { low: true });
      break;
    }
    case 'deskGrid': {
      // rows of student desks: xs and zs are lists of positions, every desk turned by rot
      for (const x of p.xs) for (const z of p.zs) buildProp({ type: 'studentDesk', floor: p.floor, x, z, rot: p.rot }, api);
      break;
    }
    case 'whiteboard': {
      const w = p.w ?? 3;
      B('whiteboard', 0, 1.45, 0, w, 1.2, 0.03);
      B('metalDark', 0, 0.83, -0.03, w, 0.04, 0.08);
      B('metalDark', 0, 2.06, 0, w + 0.04, 0.03, 0.04);
      break;
    }
    case 'bookshelf': {
      const w = p.w ?? 1.2, h = 2.1, d = 0.34;
      B('shelfWood', 0, h / 2, d / 2 - 0.01, w, h, 0.02);
      B('shelfWood', -w / 2 + 0.015, h / 2, 0, 0.03, h, d);
      B('shelfWood', w / 2 - 0.015, h / 2, 0, 0.03, h, d);
      B('shelfWood', 0, h - 0.015, 0, w, 0.03, d);
      const books = ['bookRed', 'bookBlue', 'bookTan', 'bookGreen', 'bookDark'];
      let seed = Math.abs(Math.round(p.x * 31 + p.z * 17)) + 3;
      const rnd = () => { seed = (seed * 9301 + 49297) % 233280; return seed / 233280; };
      for (let k = 0; k < 6; k++) {
        const sy = 0.06 + k * 0.34;
        B('shelfWood', 0, sy, 0, w - 0.06, 0.025, d - 0.02);
        if (k === 5) break;
        let x = -w / 2 + 0.05;
        while (x < w / 2 - 0.12) {
          const bw = 0.12 + rnd() * 0.22, bh = 0.2 + rnd() * 0.09;
          if (rnd() > 0.14 && x + bw < w / 2 - 0.04) B(books[(rnd() * books.length) | 0], x + bw / 2, sy + 0.012 + bh / 2, -0.03, bw - 0.01, bh, 0.2);
          x += bw;
        }
      }
      C(0, 0, w, d, h);
      break;
    }
    case 'armchair': {
      // wooden-armed chair (library) or grey upholstered (reception) with mat
      const m = p.mat ?? 'fabricGrey', frame = p.frame ?? 'black';
      B(m, 0, 0.36, 0, 0.66, 0.2, 0.66);
      B(m, 0, 0.66, 0.3, 0.66, 0.5, 0.14);
      B(frame === 'wood' ? 'tableOak' : m, -0.37, 0.45, 0, 0.1, 0.42, 0.7);
      B(frame === 'wood' ? 'tableOak' : m, 0.37, 0.45, 0, 0.1, 0.42, 0.7);
      legs(frame === 'wood' ? 'tableOak' : 'metalDark', 0.78, 0.66, 0.26, 0.05);
      C(0, 0, 0.84, 0.72, 0.9);
      break;
    }
    case 'couch': {
      const w = p.w ?? 1.7, m = p.mat ?? 'leatherBrown';
      B(m, 0, 0.36, 0, w, 0.2, 0.7);
      B(m, 0, 0.66, 0.31, w, 0.5, 0.14);
      B('tableOak', -w / 2 - 0.04, 0.45, 0, 0.1, 0.42, 0.74);
      B('tableOak', w / 2 + 0.04, 0.45, 0, 0.1, 0.42, 0.74);
      legs('tableOak', w + 0.1, 0.7, 0.26, 0.06);
      C(0, 0, w + 0.18, 0.76, 0.9);
      break;
    }
    case 'leatherChair': {
      B('leatherBlack', 0, 0.38, 0, 0.74, 0.12, 0.72);
      B('leatherBlack', 0, 0.62, 0.34, 0.74, 0.42, 0.1);
      for (const sx of [-1, 1]) { B('chrome', sx * 0.36, 0.2, 0, 0.02, 0.36, 0.7); }
      C(0, 0, 0.78, 0.76, 0.85);
      break;
    }
    case 'stump': {
      api.cyl('stumpWood', wx(0, 0), y0 + 0.21, wz(0, 0), p.r ?? 0.42, 0.42);
      api.cyl('tableOak', wx(0, 0), y0 + 0.43, wz(0, 0), (p.r ?? 0.42) - 0.03, 0.02);
      api.blob('white', wx(0.05, 0), y0 + 0.56, wz(0.05, 0), 0.13, 0.13, 0.1);
      C(0, 0, 0.8, 0.8, 0.45);
      break;
    }
    case 'sideTable': {
      B('woodDoor', 0, 0.5, 0, 0.45, 0.03, 0.45);
      B('woodDoor', 0, 0.2, 0, 0.4, 0.02, 0.4);
      legs('woodDoor', 0.43, 0.43, 0.5, 0.03);
      C(0, 0, 0.45, 0.45, 0.52);
      break;
    }
    case 'plant': {
      api.cyl('white', wx(0, 0), y0 + 0.2, wz(0, 0), 0.18, 0.4);
      B('stumpWood', 0, 0.8, 0, 0.03, 0.9, 0.03);
      const pts = [[0.16, 0.85, 0.05], [-0.14, 1.0, 0.1], [0.05, 1.15, -0.15], [-0.08, 1.3, -0.03], [0.14, 1.38, 0.1], [0, 1.5, 0]];
      for (const [x, y, z] of pts) api.blob('plantGreen', wx(x, z), y0 + y, wz(x, z), 0.17, 0.1, 0.15);
      C(0, 0, 0.4, 0.4, 1.5);
      break;
    }
    case 'plantWall': {
      const w = p.w ?? 2.4;
      B('black', 0, 1.3, 0.02, w, 2.5, 0.05);
      B('metalDark', 0, 1.25, -0.04, w * 0.3, 2.2, 0.03);   // dark water panel in the middle
      let seed = 7;
      const rnd = () => { seed = (seed * 9301 + 49297) % 233280; return seed / 233280; };
      for (let i = 0; i < 70; i++) {
        let x = (rnd() - 0.5) * w;
        if (Math.abs(x) < w * 0.16) x += (x < 0 ? -1 : 1) * w * 0.18;
        const y = 0.25 + rnd() * 2.2;
        api.blob(rnd() < 0.2 ? 'plantPink' : 'plantGreen', wx(x, -0.08), y0 + y, wz(x, -0.08), 0.12 + rnd() * 0.1, 0.09 + rnd() * 0.07, 0.09);
      }
      C(0, -0.05, w, 0.25, 2.6);
      break;
    }
    case 'displayCase': {
      const w = p.w ?? 1.4, d = 0.5, h = 1.0;
      B('black', 0, 0.04, 0, w, 0.08, d);
      B('glassClear', 0, h / 2 + 0.04, 0, w - 0.04, h - 0.08, d - 0.04);
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) B('black', sx * (w / 2 - 0.012), h / 2, sz * (d / 2 - 0.012), 0.024, h, 0.024);
      B('black', 0, h, 0, w, 0.024, d);
      B('glassClear', 0, 0.5, 0, w - 0.06, 0.01, d - 0.06);
      const items = ['bookBlue', 'bookTan', 'white', 'bookDark', 'bookRed'];
      for (let i = 0; i < 5; i++) {
        const x = -w / 2 + 0.2 + (i * (w - 0.4)) / 4;
        api.blob(items[i % 5], wx(x, 0), y0 + (i % 2 ? 0.6 : 0.16), wz(x, 0), 0.07, 0.09, 0.07);
      }
      C(0, 0, w, d, h, { seeThrough: true });
      break;
    }
    case 'pedestal': {
      B('white', 0, 0.5, 0, 0.5, 1.0, 0.5);
      B('white', 0, 0.04, 0, 0.56, 0.08, 0.56);
      // abstract made-up sculpture
      const k = Math.round(p.x * 7) % 3;
      if (k === 0) { api.blob('white', wx(0, 0), y0 + 1.2, wz(0, 0), 0.16, 0.2, 0.14); api.blob('white', wx(0.05, 0), y0 + 1.42, wz(0.05, 0), 0.1, 0.1, 0.1); }
      else if (k === 1) { B('bookTan', 0, 1.2, 0, 0.12, 0.4, 0.12); api.blob('bookTan', wx(0, 0), y0 + 1.45, wz(0, 0), 0.14, 0.08, 0.14); }
      else { api.cyl('bookBlue', wx(0, 0), y0 + 1.13, wz(0, 0), 0.1, 0.26); api.blob('bookBlue', wx(0, 0), y0 + 1.3, wz(0, 0), 0.13, 0.07, 0.13); }
      C(0, 0, 0.56, 0.56, 1.5);
      break;
    }
    case 'mannequin': {
      B('black', 0, 0.02, 0, 0.3, 0.04, 0.3);
      B('metalDark', 0, 0.55, 0, 0.03, 1.1, 0.03);
      api.blob(p.mat ?? 'plantGreen', wx(0, 0), y0 + 1.3, wz(0, 0), 0.2, 0.3, 0.13);
      api.blob('bookTan', wx(0, 0), y0 + 1.66, wz(0, 0), 0.05, 0.06, 0.05);
      C(0, 0, 0.4, 0.3, 1.7);
      break;
    }
    case 'waterStation': {
      B('white', 0, 0.85, 0, 0.5, 1.7, 0.36);
      B('blueGlow', -0.16, 0.5, -0.185, 0.14, 0.95, 0.012);
      B('blueGlow', 0, 1.5, -0.185, 0.36, 0.2, 0.012);
      B('metalElev', 0.42, 0.8, -0.02, 0.34, 0.12, 0.34);
      B('black', 0, 1.0, -0.19, 0.3, 0.42, 0.01);
      C(0.1, 0, 0.75, 0.38, 1.7);
      break;
    }
    case 'bins': {
      B('cabinetGrey', -0.26, 0.42, 0, 0.5, 0.84, 0.5);
      B('black', 0.26, 0.42, 0, 0.5, 0.84, 0.5);
      B('cabinetDoor', -0.26, 0.86, 0, 0.52, 0.04, 0.52);
      B('cabinetDoor', 0.26, 0.86, 0, 0.52, 0.04, 0.52);
      B('black', -0.26, 0.885, 0, 0.28, 0.01, 0.12);
      B('black', 0.26, 0.885, 0, 0.2, 0.01, 0.2);
      C(0, 0, 1.04, 0.52, 0.9);
      break;
    }
    case 'extinguisher': {
      api.cyl('red', wx(0, -0.09), y0 + 1.05, wz(0, -0.09), 0.07, 0.42);
      B('black', 0, 1.3, -0.09, 0.05, 0.08, 0.05);
      B('metalDark', 0, 1.2, -0.02, 0.1, 0.08, 0.03);
      break;
    }
    case 'bulletin': {
      const w = p.w ?? 2, h = p.h ?? 1.1, y = p.yc ?? 1.5;
      B(p.mat ?? 'cork', 0, y, 0, w, h, 0.03);
      B('woodTrim', 0, y + h / 2, -0.005, w + 0.06, 0.05, 0.045);
      B('woodTrim', 0, y - h / 2, -0.005, w + 0.06, 0.05, 0.045);
      B('woodTrim', -w / 2, y, -0.005, 0.05, h, 0.045);
      B('woodTrim', w / 2, y, -0.005, 0.05, h, 0.045);
      break;
    }
    case 'frame': {
      const w = p.w ?? 0.6, h = p.h ?? 0.8, y = p.yc ?? 1.55;
      B(p.border ?? 'black', 0, y, 0, w + 0.07, h + 0.07, 0.03);
      B(p.art ?? 'artA', 0, y, -0.012, w, h, 0.03);
      break;
    }
    case 'artRow': {
      // a run of made-up framed art along a wall, from (x,z) to (x2,z2)
      const n = p.count, arts = ['artA', 'artB', 'artC', 'artD', 'artE', 'artF'];
      let seed = Math.abs(Math.round(p.x * 13 + p.z * 29)) + p.floor * 101;
      const rnd = () => { seed = (seed * 9301 + 49297) % 233280; return seed / 233280; };
      for (let i = 0; i < n; i++) {
        const t = n === 1 ? 0.5 : i / (n - 1);
        const size = p.small ? [0.26, 0.34] : [0.45 + rnd() * 0.5, 0.5 + rnd() * 0.45];
        buildProp({
          type: 'frame', floor: p.floor, rot: p.rot, x: p.x + (p.x2 - p.x) * t, z: p.z + (p.z2 - p.z) * t,
          w: size[0], h: size[1], yc: (p.yc ?? 1.55) + (p.small ? 0 : (rnd() - 0.5) * 0.12),
          art: arts[(rnd() * arts.length) | 0], border: rnd() < 0.3 ? 'woodDoor' : 'black',
        }, api);
      }
      break;
    }
    case 'pictureGrid': {
      // wall covered in a grid of small frames
      const cols = p.cols ?? 10, rows = p.rows ?? 3, w = p.w ?? 4;
      const arts = ['artA', 'artB', 'artC', 'artD', 'artE', 'artF'];
      for (let c = 0; c < cols; c++) for (let r2 = 0; r2 < rows; r2++) {
        const lx = -w / 2 + (w * (c + 0.5)) / cols, y = 1.25 + r2 * 0.44;
        B('black', lx, y, 0, 0.3, 0.38, 0.025);
        B(arts[(c * 7 + r2 * 3) % 6], lx, y, -0.01, 0.24, 0.32, 0.025);
      }
      break;
    }
    case 'wallPanel': {
      // pale glass history panel, left blank
      B('glassFrost', 0, 1.45, -0.03, p.w ?? 0.8, 1.7, 0.02);
      break;
    }
    case 'archNiche': {
      B('woodDoor', 0, 1.3, 0, 1.1, 2.0, 0.06);
      B('woodDoor', 0, 2.35, 0, 0.8, 0.2, 0.06);
      B(p.screen ? 'black' : 'glassFrost', 0, 1.3, -0.02, 0.8, 1.7, 0.05);
      break;
    }
    case 'sinkRow': {
      const w = p.w ?? 2.4;
      B('sinkGrey', 0, 0.85, -0.25, w, 0.12, 0.5);
      B('woodDoor', 0, 0.72, -0.25, w, 0.14, 0.48);
      for (let i = 0; i < 3; i++) {
        const lx = -w / 2 + (w * (i + 0.5)) / 3;
        B('mirror', lx, 1.65, -0.02, 0.45, 1.3, 0.02);
        B('black', lx, 1.65, -0.012, 0.5, 1.35, 0.02);
        B('chrome', lx, 0.98, -0.1, 0.03, 0.14, 0.03);
        B('lampGlow', lx + w / 6, 1.65, -0.03, 0.05, 0.7, 0.04);
      }
      C(0, -0.25, w, 0.5, 0.92);
      break;
    }
    case 'toilet': {
      B('white', 0, 0.2, 0, 0.38, 0.4, 0.5);
      B('white', 0, 0.55, 0.2, 0.42, 0.4, 0.16);
      B('white', 0, 0.42, -0.02, 0.4, 0.04, 0.46);
      C(0, 0.05, 0.42, 0.6, 0.75);
      break;
    }
    case 'computerDesk': {
      const w = p.w ?? 1.25;
      B('deskWood', 0, 0.73, 0, w, 0.04, 0.6);
      B('deskWood', -w / 2 + 0.02, 0.36, 0, 0.03, 0.72, 0.58);
      B('deskWood', w / 2 - 0.02, 0.36, 0, 0.03, 0.72, 0.58);
      B('black', 0, 1.0, 0.12, 0.5, 0.32, 0.03);       // monitor
      B('black', 0, 0.8, 0.14, 0.18, 0.1, 0.12);
      B('black', 0.4, 0.95, 0.1, 0.17, 0.4, 0.36);      // tower
      B('metalDark', -0.05, 0.76, -0.14, 0.4, 0.02, 0.13); // keyboard
      C(0, 0, w, 0.6, 0.78);
      buildProp({ type: 'chair', floor: p.floor, x: wx(0, -0.6), z: wz(0, -0.6), rot: (p.rot ?? 0) + 180, mat: 'black' }, api);
      break;
    }
    case 'beanbag': {
      api.blob(p.mat ?? 'bookBlue', wx(0, 0), y0 + 0.24, wz(0, 0), 0.5, 0.3, 0.5);
      C(0, 0, 0.7, 0.7, 0.4);
      break;
    }
    case 'hazardSign': {
      // four-colour diamond next to the lab door
      const y = 1.6, k = 0.13;
      const quad = (mat, lx, ly) => box(mat, wx(lx, -0.01), y0 + y + ly, wz(lx, -0.01), 0.18, 0.18, 0.012, r);
      B('white', 0, y, 0, 0.42, 0.42, 0.008);
      quad('paneBlue', -k, 0); quad('paneAmber', k, 0); quad('paneRed', 0, k); quad('white', 0, -k);
      break;
    }
    default:
      api.warn?.(`unknown prop type ${p.type}`);
  }
}
