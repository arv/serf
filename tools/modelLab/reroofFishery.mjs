#!/usr/bin/env node
/**
 * Re-lay the fisherman's hut roof in the pack's own grain.
 *
 *   node tools/modelLab/reroofFishery.mjs [modelDir]
 *
 * The hut came out of Blender with its roof boarded at the modeller's
 * pitch: 13 boards a slope, 0.066 wide with a 0.006 groove between them,
 * and every board sampling the atlas column at its own offset. Against the
 * pack that is a slatted deck, not a roof. Two numbers say why:
 *
 * - **Board pitch, measured after `normalize`** — every building is fitted
 *   to the unit square before it is drawn (assets.ts), so a raw model width
 *   says nothing on its own. The hut normalizes by 0.643 (its bbox is 1.55
 *   across, the boat off the gable owning most of that), which put its
 *   boards at 0.047 of the footprint against 0.082 on home_A, 0.064 on
 *   home_B, 0.061 on the church. Half the pack's board is twice the pack's
 *   line work.
 * - **Shade jitter** — the roof column is a ramp (u = 0.4375, v running
 *   0.80..0.92 eave to ridge), and each board was laid on it at its own v,
 *   the spread across boards reaching a third of a board's own span. Every
 *   seam therefore came with a step in tone on top of the groove, which is
 *   what read as stripes at village zoom. Kay's roofs sample one continuous
 *   ramp: on home_A the whole roof is a single welded surface.
 *
 * So: keep 5 boards a slope (0.120 of the footprint — a shade wider than
 * home_A's, which is the point, this is a plank roof and it should say so),
 * spread to cover the same span the 13 did, and put every board on one
 * shared v ramp. The boards kept are the modeller's own, jitter in height
 * and length intact, so the roof still reads as laid rather than extruded.
 *
 * Written down as a script rather than done by hand because the alternative
 * is an unreviewable diff in a .bin. It runs once, on the model as Blender
 * left it; it refuses a roof it has already re-laid.
 */
import fs from 'node:fs';

const dir = process.argv[2] ?? 'public/models/kaykit/';
const NAME = 'building_fishery_green';

/** Which of the 13 authored boards survive, evenly spread across a slope. */
const KEEP = [0, 3, 6, 9, 12];
/** The groove left between two boards, in model units (was 0.006). */
const GAP = 0.004;
/** The atlas column the team-colour roof is cut from. */
const ROOF_U = 0.4375;

const gltf = JSON.parse(fs.readFileSync(dir + NAME + '.gltf', 'utf8'));
const bin = fs.readFileSync(dir + gltf.buffers[0].uri);
const prim = gltf.meshes[0].primitives[0];

function read(i) {
  const a = gltf.accessors[i];
  const bv = gltf.bufferViews[a.bufferView];
  const base = (bv.byteOffset ?? 0) + (a.byteOffset ?? 0);
  const width = {VEC3: 3, VEC2: 2, SCALAR: 1}[a.type];
  const out = [];
  for (let k = 0; k < a.count; k++) {
    const v = [];
    for (let c = 0; c < width; c++) {
      const o = base + (k * width + c) * (a.componentType === 5123 ? 2 : 4);
      v.push(
        a.componentType === 5126
          ? bin.readFloatLE(o)
          : a.componentType === 5123
            ? bin.readUInt16LE(o)
            : bin.readUInt32LE(o),
      );
    }
    out.push(width === 1 ? v[0] : v);
  }
  return out;
}

const pos = read(prim.attributes.POSITION);
const nrm = read(prim.attributes.NORMAL);
const uv = read(prim.attributes.TEXCOORD_0);
const idx = read(prim.indices);

// --- the mesh's separate pieces, welded by position ---------------------
const posKey = v => v.map(x => Math.round(x * 1e5)).join(',');
const welds = new Map();
const weld = pos.map(v => {
  const k = posKey(v);
  if (!welds.has(k)) welds.set(k, welds.size);
  return welds.get(k);
});
const parent = [...Array(welds.size).keys()];
const find = a => {
  while (parent[a] !== a) {
    parent[a] = parent[parent[a]];
    a = parent[a];
  }
  return a;
};
const union = (a, b) => {
  a = find(a);
  b = find(b);
  if (a !== b) parent[a] = b;
};
for (let t = 0; t < idx.length; t += 3) {
  union(weld[idx[t]], weld[idx[t + 1]]);
  union(weld[idx[t]], weld[idx[t + 2]]);
}
const pieces = new Map();
for (let t = 0; t < idx.length; t += 3) {
  const root = find(weld[idx[t]]);
  let piece = pieces.get(root);
  if (!piece) pieces.set(root, (piece = {tris: [], verts: new Set()}));
  piece.tris.push(t);
  for (const j of [idx[t], idx[t + 1], idx[t + 2]]) piece.verts.add(j);
}

// --- the roof boards ----------------------------------------------------
// A board is a plain box (12 tris) cut from the roof column, narrow across
// the ridge and long enough to run eave to ridge. That last test is what
// keeps the ridge cap (one box spanning the whole roof) out of the set.
const boards = [];
for (const piece of pieces.values()) {
  if (piece.tris.length !== 12) continue;
  const vs = [...piece.verts];
  if (!vs.every(j => Math.abs(uv[j][0] - ROOF_U) < 1e-3)) continue;
  const xs = vs.map(j => pos[j][0]);
  const ys = vs.map(j => pos[j][1]);
  const zs = vs.map(j => pos[j][2]);
  const x0 = Math.min(...xs);
  const x1 = Math.max(...xs);
  const z0 = Math.min(...zs);
  const z1 = Math.max(...zs);
  if (x1 - x0 > 0.09 || z1 - z0 < 0.4 || Math.max(...ys) < 0.8) continue;
  const vv = vs.map(j => uv[j][1]);
  boards.push({
    piece,
    x0,
    x1,
    zc: (z0 + z1) / 2,
    vmin: Math.min(...vv),
    vmax: Math.max(...vv),
  });
}
const slopes = [boards.filter(b => b.zc > 0), boards.filter(b => b.zc < 0)];
for (const slope of slopes) slope.sort((a, b) => a.x0 - b.x0);
if (slopes.some(s => s.length !== 13)) {
  console.error(
    `expected 13 boards a slope, found ${slopes.map(s => s.length).join(' and ')} — ` +
      'this roof has been re-laid already, or the hut was remodelled',
  );
  process.exit(1);
}

// One ramp for the whole roof: the mean of what the boards were sampling,
// so the eave-to-ridge falloff is the same on every one of them.
const ramp = [
  boards.reduce((a, b) => a + b.vmin, 0) / boards.length,
  boards.reduce((a, b) => a + b.vmax, 0) / boards.length,
];

const dropped = new Set();
for (const slope of slopes) {
  const x0 = slope[0].x0;
  const pitch = (slope.at(-1).x1 - x0) / KEEP.length;
  slope.forEach((board, i) => {
    const k = KEEP.indexOf(i);
    if (k < 0) {
      for (const t of board.piece.tris) dropped.add(t);
      return;
    }
    const left = x0 + pitch * k + GAP / 2;
    const right = x0 + pitch * (k + 1) - GAP / 2;
    const mid = (board.x0 + board.x1) / 2;
    for (const j of board.piece.verts) {
      pos[j][0] = pos[j][0] < mid ? left : right;
      const along = (uv[j][1] - board.vmin) / (board.vmax - board.vmin);
      uv[j][1] = ramp[0] + along * (ramp[1] - ramp[0]);
    }
  });
}

// --- write the buffers back ---------------------------------------------
const used = new Set();
const tris = [];
for (let t = 0; t < idx.length; t += 3) {
  if (dropped.has(t)) continue;
  tris.push([idx[t], idx[t + 1], idx[t + 2]]);
  for (const j of [idx[t], idx[t + 1], idx[t + 2]]) used.add(j);
}
const order = [...used].sort((a, b) => a - b);
const remap = new Map(order.map((j, i) => [j, i]));
const count = order.length;
const posBuf = Buffer.alloc(count * 12);
const nrmBuf = Buffer.alloc(count * 12);
const uvBuf = Buffer.alloc(count * 8);
const min = [Infinity, Infinity, Infinity];
const max = [-Infinity, -Infinity, -Infinity];
order.forEach((j, i) => {
  for (let c = 0; c < 3; c++) {
    posBuf.writeFloatLE(pos[j][c], i * 12 + c * 4);
    nrmBuf.writeFloatLE(nrm[j][c], i * 12 + c * 4);
    min[c] = Math.min(min[c], pos[j][c]);
    max[c] = Math.max(max[c], pos[j][c]);
  }
  uvBuf.writeFloatLE(uv[j][0], i * 8);
  uvBuf.writeFloatLE(uv[j][1], i * 8 + 4);
});
const idxBuf = Buffer.alloc(tris.length * 6);
tris.forEach((t, i) =>
  t.forEach((j, c) => idxBuf.writeUInt16LE(remap.get(j), (i * 3 + c) * 2)),
);
// glTF wants every bufferView on a 4-byte boundary; only the index view can
// land odd, and it is last, so a tail pad is all it takes.
const padded =
  idxBuf.length % 4
    ? Buffer.concat([idxBuf, Buffer.alloc(4 - (idxBuf.length % 4))])
    : idxBuf;
const parts = [posBuf, nrmBuf, uvBuf, padded];
let offset = 0;
gltf.bufferViews = parts.map((b, i) => {
  const view = {
    buffer: 0,
    byteLength: i === 3 ? idxBuf.length : b.length,
    byteOffset: offset,
    target: i === 3 ? 34963 : 34962,
  };
  offset += b.length;
  return view;
});
gltf.accessors = [
  {bufferView: 0, componentType: 5126, count, max, min, type: 'VEC3'},
  {bufferView: 1, componentType: 5126, count, type: 'VEC3'},
  {bufferView: 2, componentType: 5126, count, type: 'VEC2'},
  {bufferView: 3, componentType: 5123, count: tris.length * 3, type: 'SCALAR'},
];
const buffer = Buffer.concat(parts);
gltf.buffers[0].byteLength = buffer.length;
fs.writeFileSync(dir + gltf.buffers[0].uri, buffer);
fs.writeFileSync(dir + NAME + '.gltf', JSON.stringify(gltf, null, '\t') + '\n');
console.log(
  `${KEEP.length} boards a slope (was 13), ${count} verts, ${tris.length} tris`,
);
