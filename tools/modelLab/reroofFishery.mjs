#!/usr/bin/env node
/**
 * Re-lay the fisherman's hut roof in the pack's own grain.
 *
 *   node tools/modelLab/reroofFishery.mjs [modelDir]
 *
 * The hut came out of Blender boarded at the modeller's pitch — 13 boards a
 * slope, 0.066 wide with a 0.006 groove between them, every one of them at a
 * dead 45 degrees. Against the pack that is a slatted deck rather than a
 * roof, and it is wrong in both directions at once:
 *
 * - **Too many lines.** Board width has to be measured after `normalize`,
 *   which fits every building to the unit square before it is drawn
 *   (assets.ts). The hut normalizes by 0.643 — its bbox is 1.55 across, the
 *   boat off the gable owning most of that — which put its boards at 0.047
 *   of the footprint against 0.082 on home_A, 0.064 on home_B, 0.061 on the
 *   church. Half the pack's board is twice the pack's line work.
 * - **No bands.** A KayKit roof carries two tones, and they are made of
 *   geometry: the main face is 45 degrees and a section of every slope sits
 *   at 41.4 (measured on home_A — see the STRIPS note in procBuildings.ts),
 *   so the surface kinks and the two halves take the light a shade apart.
 *   A roof of boards all at one pitch cannot have that at any width. It has
 *   to be the normals, because the roof column lands inside TEAM_SWATCH_UV:
 *   a faction-owned roof is drawn in one flat Lambert colour and its UVs
 *   never reach a pixel.
 *
 * So: 5 boards a slope (0.120 of the footprint — a shade wider than home_A's,
 * which is the point, this is a plank roof and should say so), spread across
 * the span the 13 covered, and one board on each slope swung to Kay's 41.4.
 * The boards kept are the modeller's own, jitter in height and length
 * intact, so the roof still reads as laid rather than extruded. Their v
 * offsets are levelled onto one ramp while we are here — inert on a
 * faction roof, but it is what the bandit-grey stock material would show.
 *
 * Written down as a script rather than done by hand because the alternative
 * is an unreviewable diff in a .bin. It runs once, on the model as Blender
 * left it; it refuses a roof it has already re-laid.
 */
import fs from 'node:fs';
import path from 'node:path';

const dir = process.argv[2] ?? 'public/models/kaykit';
const NAME = 'building_fishery_green';
/** The model dir joined properly, so a trailing slash is nobody's problem. */
const at = name => path.join(dir, name);

/** Which of the 13 authored boards survive, evenly spread across a slope. */
const KEEP = [0, 3, 6, 9, 12];
/** The groove left between two boards, in model units (was 0.006). */
const GAP = 0.004;
/**
 * Which of the kept boards are laid at Kay's shallower pitch, per slope —
 * the +z slope first. Off-centre and different on the two, because his
 * roofs are not symmetrical either.
 */
const SHALLOW = [[1], [3]];
/** How much shallower, in degrees: 45 down to Kay's 41.4. */
const KINK_DEG = 3.6;
/** The atlas column the team-colour roof is cut from. */
const ROOF_U = 0.4375;

const gltf = JSON.parse(fs.readFileSync(at(NAME + '.gltf'), 'utf8'));
const bin = fs.readFileSync(at(gltf.buffers[0].uri));
const prim = gltf.meshes[0].primitives[0];

/** Components per element, for the accessor types this mesh is made of. */
const WIDTH = {VEC3: 3, VEC2: 2, SCALAR: 1};
/** Bytes per component, and how to read one, for the same. */
const COMPONENT = {
  5126: {bytes: 4, get: o => bin.readFloatLE(o)},
  5123: {bytes: 2, get: o => bin.readUInt16LE(o)},
  5125: {bytes: 4, get: o => bin.readUInt32LE(o)},
};

/**
 * One accessor, as an array of numbers (SCALAR) or of tuples.
 *
 * Tightly packed only, and only the shapes this hut is exported in. An
 * interleaved view or a component type this has not been taught would be
 * read as nonsense and written straight back out as a corrupt .bin — the
 * board count below would almost certainly catch that, but "almost" is the
 * wrong guarantee when the output is a binary nobody can read a diff of.
 * So it stops instead.
 */
function read(i) {
  const a = gltf.accessors[i];
  const bv = gltf.bufferViews[a.bufferView];
  if (bv.byteStride !== undefined) {
    throw new Error(`accessor ${i}: interleaved views are not handled`);
  }
  const width = WIDTH[a.type];
  const comp = COMPONENT[a.componentType];
  if (!width || !comp) {
    throw new Error(
      `accessor ${i}: ${a.type}/${a.componentType} is not handled`,
    );
  }
  const base = (bv.byteOffset ?? 0) + (a.byteOffset ?? 0);
  const out = [];
  for (let k = 0; k < a.count; k++) {
    const v = [];
    for (let c = 0; c < width; c++) {
      v.push(comp.get(base + (k * width + c) * comp.bytes));
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
for (const [si, slope] of slopes.entries()) {
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
    // Kay's kink: swing this board shallower about its own middle, in the
    // plane the slope falls through. Its ridge end tucks under the cap and
    // its eave end lifts, and — normals turning with it — it takes the
    // light a shade apart from the boards either side, which is the whole
    // point of doing it in geometry.
    if (!SHALLOW[si].includes(k)) return;
    const turn = board.zc > 0 ? -1 : 1;
    const th = (turn * KINK_DEG * Math.PI) / 180;
    const cos = Math.cos(th);
    const sin = Math.sin(th);
    const cz =
      [...board.piece.verts].reduce((a, j) => a + pos[j][2], 0) /
      board.piece.verts.size;
    const cy =
      [...board.piece.verts].reduce((a, j) => a + pos[j][1], 0) /
      board.piece.verts.size;
    const spin = (v, oz, oy) => {
      const z = v[2] - oz;
      const y = v[1] - oy;
      v[2] = oz + z * cos - y * sin;
      v[1] = oy + z * sin + y * cos;
    };
    for (const j of board.piece.verts) {
      spin(pos[j], cz, cy);
      spin(nrm[j], 0, 0);
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
// The indices go back out as uint16, which this hut has room to spare for
// (3.3k vertices) and which only ever shrinks here — but the write itself
// would wrap silently rather than fail, so say so out loud.
if (count > 0xffff) {
  throw new Error(`${count} vertices will not fit uint16 indices`);
}
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
fs.writeFileSync(at(gltf.buffers[0].uri), buffer);
fs.writeFileSync(at(NAME + '.gltf'), JSON.stringify(gltf, null, '\t') + '\n');
console.log(
  `${KEEP.length} boards a slope (was 13), ${count} verts, ${tris.length} tris`,
);
