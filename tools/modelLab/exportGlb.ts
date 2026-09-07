import {GLTFExporter} from 'three/addons/exporters/GLTFExporter.js';
import {loadGlbAssets, makeGlbBuilding} from '../../src/render/assets';
import {buildingFromKey} from '../../src/sim/defs/buildings';

/**
 * Export one building's composed model as a .glb, for opening in a DCC tool.
 *
 * It runs in a browser for the same reason bake.ts does: GLTFLoader lives
 * there, and what comes out is then provably the group the renderer draws —
 * pack base, decor, hand-built parts and the atlas material, exactly as
 * `makeGlbBuilding` assembles them. exportGlb.mjs drives the page and
 * writes the bytes.
 *
 *   ?b=<building key>   which building (default fishery)
 *   ?owner=<seat>       paint the team-colour slot for that seat (default 0)
 */

declare global {
  interface Window {
    __GLB?: string;
    __GLB_ERROR?: string;
  }
}

const status = document.getElementById('status')!;
const q = new URLSearchParams(location.search);
const key = q.get('b') ?? 'fishery';
const owner = Number(q.get('owner') ?? '0');

try {
  const type = buildingFromKey(key);
  if (type === undefined) throw new Error(`no building named ${key}`);
  await loadGlbAssets();
  const group = makeGlbBuilding(type, owner);
  if (!group) throw new Error(`no model for ${key}`);
  group.name = key;
  const bin = await new GLTFExporter().parseAsync(group, {binary: true});
  const bytes = new Uint8Array(bin as ArrayBuffer);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  window.__GLB = btoa(s);
  status.textContent = `exported ${key} (${bytes.length} bytes)`;
} catch (err) {
  window.__GLB_ERROR = String(err);
  status.textContent = `failed: ${String(err)}`;
}
