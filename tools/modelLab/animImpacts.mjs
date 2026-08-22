#!/usr/bin/env node
/**
 * Where, inside each animation clip, the impact actually lands — the
 * measurements behind the `impactPhase01` values in src/audio/animCues.ts.
 *
 *   node tools/modelLab/animImpacts.mjs           # audit the mapped clips
 *   node tools/modelLab/animImpacts.mjs curve Rig_Medium_Tools.glb Chopping handslot.r
 *
 * The audit evaluates the KayKit rig clips' bone tracks directly (a
 * dependency-free GLB parse plus a walk up the node hierarchy — no three,
 * no browser) and prints, per clip:
 *
 *  - gaits: when each foot plants — the toe descending into its floor
 *    band, and the ankle's descent stalling (heel-strike ends there);
 *  - strikes: the striking hand's fast-swing windows (speed above half
 *    its peak) and the deceleration spikes where the swing stops dead —
 *    the stop is the contact for an impact sound, the window start is
 *    where a whoosh belongs so its sweep peaks at the hit;
 *  - Death_A: when the falling body comes to rest, in seconds — the
 *    unitDeath recipe's thump layer is delayed to meet it.
 *
 * `curve` prints one bone's world position and speed over a clip for
 * eyeballing anything the audit's heuristics summarize away. Re-run the
 * audit whenever a clip mapping in characters.ts changes, and carry the
 * numbers into animCues.ts (and cues.ts for the death thump) by hand —
 * picking contact vs. swing-start is a judgement the script does not make.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const KK_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../public/models/kaykit/',
);

// --- GLB + accessor plumbing ----------------------------------------------

function parseGlb(path) {
  const buf = readFileSync(path);
  if (buf.readUInt32LE(0) !== 0x46546c67) throw new Error('not a GLB: ' + path);
  let off = 12;
  let json = null;
  let bin = null;
  while (off < buf.length) {
    const len = buf.readUInt32LE(off);
    const type = buf.readUInt32LE(off + 4);
    const chunk = buf.subarray(off + 8, off + 8 + len);
    if (type === 0x4e4f534a) json = JSON.parse(chunk.toString('utf8'));
    else if (type === 0x004e4942) bin = chunk;
    off += 8 + len;
  }
  return { json, bin };
}

function accessorArray(gltf, bin, idx) {
  const acc = gltf.accessors[idx];
  const bv = gltf.bufferViews[acc.bufferView];
  const n = { SCALAR: 1, VEC3: 3, VEC4: 4 }[acc.type];
  if (acc.componentType !== 5126) throw new Error('non-float accessor');
  const byteOff = (bv.byteOffset ?? 0) + (acc.byteOffset ?? 0);
  const stride = bv.byteStride ?? n * 4;
  const out = new Float32Array(acc.count * n);
  for (let i = 0; i < acc.count; i++) {
    for (let c = 0; c < n; c++) out[i * n + c] = bin.readFloatLE(byteOff + i * stride + c * 4);
  }
  return { data: out, count: acc.count, n };
}

// --- just enough math to compose world transforms -------------------------

function composeTRS(t, q, s) {
  const [x, y, z, w] = q;
  const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2;
  const yy = y * y2, yz = y * z2, zz = z * z2;
  const wx = w * x2, wy = w * y2, wz = w * z2;
  // Column-major 4x4.
  return [
    (1 - (yy + zz)) * s[0], (xy + wz) * s[0], (xz - wy) * s[0], 0,
    (xy - wz) * s[1], (1 - (xx + zz)) * s[1], (yz + wx) * s[1], 0,
    (xz + wy) * s[2], (yz - wx) * s[2], (1 - (xx + yy)) * s[2], 0,
    t[0], t[1], t[2], 1,
  ];
}

function mulMat(a, b) {
  const o = new Array(16).fill(0);
  for (let c = 0; c < 4; c++)
    for (let r = 0; r < 4; r++)
      for (let k = 0; k < 4; k++) o[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
  return o;
}

/** Normalized lerp — plenty for reading impact timing off dense tracks. */
function nlerpQuat(a, b, t) {
  const sign = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3] < 0 ? -1 : 1;
  const o = a.map((v, k) => v + (sign * b[k] - v) * t);
  const len = Math.hypot(...o) || 1;
  return o.map((v) => v / len);
}

class ClipEvaluator {
  constructor(gltf, bin, clipName) {
    const anim = gltf.animations.find((a) => a.name === clipName);
    if (!anim) throw new Error(`no clip ${clipName}`);
    this.tracks = new Map(); // node index -> {translation?, rotation?, scale?}
    this.duration = 0;
    for (const ch of anim.channels) {
      const samp = anim.samplers[ch.sampler];
      const times = accessorArray(gltf, bin, samp.input);
      const values = accessorArray(gltf, bin, samp.output);
      let t = this.tracks.get(ch.target.node);
      if (!t) this.tracks.set(ch.target.node, (t = {}));
      t[ch.target.path] = {
        times: times.data,
        count: times.count,
        values: values.data,
        n: values.n,
        step: samp.interpolation === 'STEP',
      };
      this.duration = Math.max(this.duration, times.data[times.count - 1]);
    }
    this.nodes = gltf.nodes;
    this.parent = new Array(this.nodes.length).fill(-1);
    this.nodes.forEach((n, i) => (n.children ?? []).forEach((c) => (this.parent[c] = i)));
    this.byName = new Map(this.nodes.map((n, i) => [n.name, i]));
  }

  #sample(tr, t) {
    const { times, count, values, n, step } = tr;
    if (t <= times[0]) return Array.from(values.slice(0, n));
    if (t >= times[count - 1]) return Array.from(values.slice((count - 1) * n, count * n));
    let i = 1;
    while (times[i] < t) i++;
    const f = step ? 0 : (t - times[i - 1]) / (times[i] - times[i - 1]);
    const a = Array.from(values.slice((i - 1) * n, i * n));
    const b = Array.from(values.slice(i * n, (i + 1) * n));
    return n === 4 ? nlerpQuat(a, b, f) : a.map((v, k) => v + (b[k] - v) * f);
  }

  #local(nodeIdx, t) {
    const node = this.nodes[nodeIdx];
    const tr = this.tracks.get(nodeIdx) ?? {};
    return composeTRS(
      tr.translation ? this.#sample(tr.translation, t) : node.translation ?? [0, 0, 0],
      tr.rotation ? this.#sample(tr.rotation, t) : node.rotation ?? [0, 0, 0, 1],
      tr.scale ? this.#sample(tr.scale, t) : node.scale ?? [1, 1, 1],
    );
  }

  worldPos(boneName, t) {
    let i = this.byName.get(boneName);
    if (i === undefined) throw new Error(`no bone ${boneName}`);
    let m = this.#local(i, t);
    for (let p = this.parent[i]; p !== -1; p = this.parent[p]) m = mulMat(this.#local(p, t), m);
    return [m[12], m[13], m[14]];
  }

  /** N+1 world positions of a bone across the clip, plus speeds between. */
  sampleBone(boneName, N) {
    const pos = [];
    for (let i = 0; i <= N; i++) pos.push(this.worldPos(boneName, (i / N) * this.duration));
    const dt = this.duration / N;
    const speed = pos.map((p, i) => {
      if (i === 0) return 0;
      const q = pos[i - 1];
      return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]) / dt;
    });
    return { pos, speed };
  }
}

const cache = new Map();
function evaluator(file, clip) {
  if (!cache.has(file)) cache.set(file, parseGlb(join(KK_DIR, file)));
  const { json, bin } = cache.get(file);
  return new ClipEvaluator(json, bin, clip);
}

// --- detectors ------------------------------------------------------------

const N = 400;
const ph = (i) => (i / N).toFixed(2);

/** Phases where a bone's Y descends into its floor band (min + 20% range). */
function plantPhases(ev, bone) {
  const ys = ev.sampleBone(bone, N).pos.map((p) => p[1]);
  const min = Math.min(...ys);
  const band = min + 0.2 * (Math.max(...ys) - min);
  const events = [];
  for (let i = 0; i <= N; i++) {
    if (ys[i] <= band && ys[(i + N) % (N + 1)] > band) events.push(ph(i));
  }
  return events;
}

function gait(file, clip) {
  const ev = evaluator(file, clip);
  console.log(`${clip}  (${ev.duration.toFixed(2)}s)`);
  for (const bone of ['toes.l', 'toes.r', 'foot.l', 'foot.r']) {
    console.log(`  ${bone} plants at phase ${plantPhases(ev, bone).join(', ')}`);
  }
}

function strike(file, clip, bone = 'handslot.r') {
  const ev = evaluator(file, clip);
  const { speed } = ev.sampleBone(bone, N);
  const peak = Math.max(...speed);
  // Fast-swing windows: speed above half its peak.
  const windows = [];
  let start = null;
  for (let i = 1; i <= N; i++) {
    const hot = speed[i] > 0.5 * peak;
    if (hot && start === null) start = i;
    if (!hot && start !== null) {
      windows.push(`${ph(start)}..${ph(i)}`);
      start = null;
    }
  }
  // Deceleration spikes: where the swing stops dead. Top events, deduped
  // to one per tenth of the clip.
  const decel = [];
  for (let i = 2; i <= N; i++) decel.push([speed[i - 1] - speed[i], i]);
  decel.sort((a, b) => b[0] - a[0]);
  const stops = [];
  for (const [d, i] of decel) {
    if (d < 0.25 * decel[0][0]) break;
    if (stops.every((s) => Math.abs(s - i) > N / 10)) stops.push(i);
  }
  stops.sort((a, b) => a - b);
  console.log(`${clip}  (${ev.duration.toFixed(2)}s)  ${bone}`);
  console.log(`  swings ${windows.join(', ')}  stops at ${stops.map(ph).join(', ')}`);
}

function death(file, clip) {
  const ev = evaluator(file, clip);
  const { pos, speed } = ev.sampleBone('hips', N);
  // Landing: the last sample after which the hips never move again.
  let rest = N;
  while (rest > 0 && speed[rest] < 0.05) rest--;
  const t = ((rest / N) * ev.duration).toFixed(2);
  console.log(`${clip}  (${ev.duration.toFixed(2)}s)`);
  console.log(`  body at rest from t=${t}s (hips settle at y=${pos[N][1].toFixed(2)})`);
}

// --- modes ----------------------------------------------------------------

const [mode, ...rest] = process.argv.slice(2);

if (mode === 'curve') {
  const [file, clip, bone, samples] = rest;
  const ev = evaluator(file, clip);
  const M = Number(samples ?? 80);
  console.log(`# ${clip} ${bone} duration=${ev.duration.toFixed(3)}s`);
  console.log('phase\tt\tx\ty\tz\tspeed');
  const { pos, speed } = ev.sampleBone(bone, M);
  for (let i = 0; i <= M; i++) {
    const p = pos[i];
    console.log(
      `${(i / M).toFixed(3)}\t${((i / M) * ev.duration).toFixed(3)}\t` +
        `${p[0].toFixed(3)}\t${p[1].toFixed(3)}\t${p[2].toFixed(3)}\t${speed[i].toFixed(2)}`,
    );
  }
} else {
  // The clips LOOP_CUES maps (KK_CLIP_NAMES + every KKSpec.attackClip),
  // and the death clip the unitDeath thump is timed against.
  console.log('== gaits (footfall = toe plants; heel-strike ends where the ankle stalls)');
  gait('Rig_Medium_MovementBasic.glb', 'Walking_A');
  gait('Rig_Medium_MovementBasic.glb', 'Running_A');
  console.log('\n== work loops');
  strike('Rig_Medium_Tools.glb', 'Chopping');
  strike('Rig_Medium_Tools.glb', 'Pickaxing');
  strike('Rig_Medium_Tools.glb', 'Hammering');
  console.log('\n== combat');
  strike('Rig_Medium_CombatMelee.glb', 'Melee_1H_Attack_Chop');
  strike('Rig_Medium_CombatMelee.glb', 'Melee_1H_Attack_Stab');
  strike('Rig_Medium_CombatMelee.glb', 'Melee_2H_Attack_Chop');
  strike('Rig_Medium_CombatRanged.glb', 'Ranged_Bow_Draw', 'hand.r');
  console.log('\n== death');
  death('Rig_Medium_General.glb', 'Death_A');
}
