import * as THREE from 'three';
import {OrbitControls} from 'three/addons/controls/OrbitControls.js';
import type {BuildingSnap} from '../../src/protocol/messages';
import {loadGlbAssets} from '../../src/render/assets';
import {BuildingSync} from '../../src/render/buildingSync';
import {HeightField} from '../../src/render/heightField';
import {TerrainMesh, Spoil, type SpoilKind} from '../../src/render/terrainMesh';
import type {Enum} from '../../src/shared/enum.ts';
import {tileIdx} from '../../src/shared/grid';
import * as BuildingState from '../../src/sim/buildingStateEnum.ts';
import {buildingDef} from '../../src/sim/defs/buildings';
import * as BuildingTypeId from '../../src/sim/defs/buildingTypeIdEnum.ts';
import * as GoodId from '../../src/sim/defs/goodIdEnum.ts';
import type {GoodAmounts} from '../../src/sim/defs/goods';
import type {MapView} from '../../src/sim/map';
import * as Terrain from '../../src/sim/terrainEnum.ts';
import {makeLights, makeRenderer, PITCH} from './scene';

type BuildingTypeId = Enum<typeof BuildingTypeId>;

/**
 * Buildings on slopes, through the real BuildingSync on a real TerrainMesh.
 *
 * Every other lab page stands its buildings on a flat plane, which is the
 * one ground on which nothing can float or sink. This one builds a small
 * map whose ground tilts under each footprint and hands the roster to the
 * same BuildingSync a match uses, so whatever the renderer does with a
 * slope — door stock hanging in the air, a field half under the hill, a
 * mine's rails running off into space — shows here exactly as it would in
 * a game.
 *
 * Columns are building types; rows are which way the ground falls. The
 * tilt is set by the height difference across the footprint's corners (the
 * number the sim's placement rule reads): the steepest a farm may stand on
 * for everything but the mines, and a p99 mine site for those (placement
 * does not limit a mine's slope at all).
 *
 *   pnpm dev, then /tools/modelLab/_slopes.html
 *   ?diff=<n>      corner difference for ordinary buildings (default 0.5)
 *   ?mine=<n>      corner difference for mines (default 0.95)
 *   ?stock=0       empty yards and doorsteps
 *   ?site=<0..1>   construction sites at that much progress instead
 *   ?focus=c,r     frame one slot (column, row — 0-based) up close
 *   ?yaw=<deg>     camera yaw (default 30, the rig's)
 *   ?pitch=<deg>   camera pitch (default 35, the rig's) — lower it to see
 *                  daylight under anything that floats
 *   ?zoom=<n>      orthographic zoom (default 1; focus defaults to 12)
 *   ?clean=1       no labels or help, for screenshots
 *
 * Drag to orbit, right-drag to pan, wheel to zoom.
 */

const q = new URLSearchParams(location.search);
const DIFF = Number(q.get('diff') ?? 0.5);
const MINE_DIFF = Number(q.get('mine') ?? 0.95);
const STOCK = q.get('stock') !== '0';
const SITE = q.has('site') ? Number(q.get('site')) : null;
const YAW = (Number(q.get('yaw') ?? 30) * Math.PI) / 180;
const CAM_PITCH = q.has('pitch')
  ? (Number(q.get('pitch')) * Math.PI) / 180
  : PITCH;

interface Column {
  type: BuildingTypeId;
  name: string;
  stock: GoodAmounts;
  spoil?: SpoilKind;
}

const COLUMNS: Column[] = [
  {
    type: BuildingTypeId.wheatFarm,
    name: 'Wheat Farm',
    stock: {[GoodId.wheat]: 4},
  },
  {
    type: BuildingTypeId.archeryRange,
    name: 'Archery Range',
    stock: {[GoodId.bow]: 3},
  },
  {
    type: BuildingTypeId.storehouse,
    name: 'Storehouse',
    stock: {
      [GoodId.wood]: 6,
      [GoodId.stone]: 5,
      [GoodId.wheat]: 4,
      [GoodId.iron]: 3,
    },
  },
  {
    type: BuildingTypeId.woodcutter,
    name: 'Woodcutter',
    stock: {[GoodId.wood]: 5},
  },
  {
    type: BuildingTypeId.quarry,
    name: 'Quarry',
    stock: {[GoodId.stone]: 5},
    spoil: Spoil.Stone,
  },
  {
    type: BuildingTypeId.ironMine,
    name: 'Iron Mine',
    stock: {[GoodId.iron]: 6},
    spoil: Spoil.Iron,
  },
  {
    type: BuildingTypeId.silverMine,
    name: 'Silver Mine',
    stock: {[GoodId.silver]: 6},
    spoil: Spoil.Silver,
  },
  {
    type: BuildingTypeId.goldMine,
    name: 'Gold Mine',
    stock: {[GoodId.gold]: 6},
    spoil: Spoil.Gold,
  },
];

/** Which way the ground falls, as a unit vector in (x, z). +z is the front
 * every building is drawn facing, and roughly toward the default camera. */
const ROWS: {name: string; fall: [number, number]}[] = [
  {name: 'falls to the front', fall: [0, 1]},
  {name: 'falls to the back', fall: [0, -1]},
  {name: 'falls to the side', fall: [1, 0]},
  {name: 'falls diagonally', fall: [Math.SQRT1_2, Math.SQRT1_2]},
];

const PITCH_TILES = 12;
const MARGIN = 4;
const SIZE = Math.max(COLUMNS.length, ROWS.length) * PITCH_TILES + 2 * MARGIN;
const BASE = 0.6;

interface Slot {
  col: number;
  row: number;
  /** Footprint top-left tile. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** Ground gradient, height per tile, pointing uphill. */
  gx: number;
  gz: number;
}

const slots: Slot[] = [];
COLUMNS.forEach((c, col) => {
  const def = buildingDef(c.type);
  ROWS.forEach((r, row) => {
    const cx = MARGIN + col * PITCH_TILES + PITCH_TILES / 2;
    const cz = MARGIN + row * PITCH_TILES + PITCH_TILES / 2;
    // A plane's corner spread over a w x h footprint is |gx| w + |gz| h:
    // scale the fall so the spread is exactly the target.
    const target = def.mine ? MINE_DIFF : DIFF;
    const k =
      target / (Math.abs(r.fall[0]) * def.w + Math.abs(r.fall[1]) * def.h);
    slots.push({
      col,
      row,
      x: Math.round(cx - def.w / 2),
      y: Math.round(cz - def.h / 2),
      w: def.w,
      h: def.h,
      gx: -r.fall[0] * k,
      gz: -r.fall[1] * k,
    });
  });
});

const n = SIZE * SIZE;
const map: MapView = {
  size: SIZE,
  play: SIZE - 2,
  terrain: new Uint8Array(n).fill(Terrain.Grass),
  resource: new Uint8Array(n),
  blocked: new Uint8Array(n),
  buildingAt: new Int16Array(n).fill(-1),
  pathLevel: new Uint8Array(n),
  height: new Float32Array(n).fill(BASE),
};

// Each slot is a plane through its footprint's centre, held flat well past
// the doorstep (door stock stands a third of a tile outside the front
// wall) and eased back to the base height before the next slot starts.
const smooth = (t: number): number => {
  const c = Math.min(1, Math.max(0, t));
  return c * c * (3 - 2 * c);
};
const HOLD = 3;
const EASE = 6;
for (let tz = 0; tz < SIZE; tz++) {
  for (let tx = 0; tx < SIZE; tx++) {
    const px = tx + 0.5;
    const pz = tz + 0.5;
    const col = Math.floor((px - MARGIN) / PITCH_TILES);
    const row = Math.floor((pz - MARGIN) / PITCH_TILES);
    const s = slots.find(o => o.col === col && o.row === row);
    if (!s) continue;
    const cx = s.x + s.w / 2;
    const cz = s.y + s.h / 2;
    const r = Math.max(Math.abs(px - cx), Math.abs(pz - cz));
    const f = 1 - smooth((r - HOLD) / (EASE - HOLD));
    map.height[tileIdx(tx, tz, SIZE)] =
      BASE + f * (s.gx * (px - cx) + s.gz * (pz - cz));
  }
}

const snaps: BuildingSnap[] = slots.map((s, i) => {
  const id = i + 1;
  for (let dy = 0; dy < s.h; dy++) {
    for (let dx = 0; dx < s.w; dx++) {
      map.buildingAt[tileIdx(s.x + dx, s.y + dy, SIZE)] = id;
    }
  }
  const col = COLUMNS[s.col]!;
  const def = buildingDef(col.type);
  return {
    id,
    type: col.type,
    owner: 1,
    x: s.x,
    y: s.y,
    w: s.w,
    h: s.h,
    hp: def.hp,
    maxHp: def.hp,
    state: SITE === null ? BuildingState.built : BuildingState.site,
    ...(SITE === null ? {} : {progress01: SITE, siteNeeds: {}}),
    stock: STOCK ? col.stock : {},
    inputs: {},
    inbound: {},
    reservedOut: {},
  } as BuildingSnap;
});

await loadGlbAssets();

const renderer = makeRenderer(
  document.querySelector('#app')!.appendChild(document.createElement('canvas')),
);
renderer.setClearColor(0x6aa63c, 1);
// Construction sites rise out of a clip plane, as in the game's renderer.
renderer.localClippingEnabled = true;

const scene = new THREE.Scene();
makeLights(scene);

const heights = new HeightField(map.height as Float32Array, SIZE);
const terrain = new TerrainMesh(map, heights, (id): SpoilKind => {
  const s = slots[id - 1];
  return (s && COLUMNS[s.col]!.spoil) ?? Spoil.None;
});
terrain.repaintAll();
scene.add(terrain.group);

const buildings = new BuildingSync(scene, heights);
buildings.update(snaps);

// ---- camera -----------------------------------------------------------

const focus = q.get('focus')?.split(',').map(Number);
const focusSlot = focus
  ? slots.find(s => s.col === focus[0] && s.row === focus[1])
  : undefined;
const target = focusSlot
  ? new THREE.Vector3(
      focusSlot.x + focusSlot.w / 2,
      BASE,
      focusSlot.y + focusSlot.h / 2,
    )
  : new THREE.Vector3(
      MARGIN + (COLUMNS.length * PITCH_TILES) / 2,
      BASE,
      MARGIN + (ROWS.length * PITCH_TILES) / 2,
    );

const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 400);
cam.zoom = Number(q.get('zoom') ?? (focusSlot ? 12 : 1));
const dist = 120;
cam.position.set(
  target.x + Math.sin(YAW) * Math.cos(CAM_PITCH) * dist,
  target.y + Math.sin(CAM_PITCH) * dist,
  target.z + Math.cos(YAW) * Math.cos(CAM_PITCH) * dist,
);

const controls = new OrbitControls(cam, renderer.domElement);
controls.target.copy(target);
controls.update();

/** World units across the view at zoom 1: the whole grid fits. */
const VIEW = COLUMNS.length * PITCH_TILES + 6;

function resize(): void {
  const w = window.innerWidth;
  const h = window.innerHeight;
  renderer.setSize(w, h, false);
  renderer.domElement.style.width = `${w}px`;
  renderer.domElement.style.height = `${h}px`;
  const vh = (VIEW * h) / w;
  cam.left = -VIEW / 2;
  cam.right = VIEW / 2;
  cam.top = vh / 2;
  cam.bottom = -vh / 2;
  cam.updateProjectionMatrix();
}
window.addEventListener('resize', resize);
resize();

// ---- labels -----------------------------------------------------------

const labelRoot = document.querySelector('#labels')!;
const labels: {el: HTMLElement; at: THREE.Vector3}[] = [];
const label = (text: string, at: THREE.Vector3, cls = ''): void => {
  const el = document.createElement('span');
  el.textContent = text;
  if (cls) el.className = cls;
  labelRoot.appendChild(el);
  labels.push({el, at});
};
COLUMNS.forEach((c, col) => {
  const s = slots.find(o => o.col === col && o.row === ROWS.length - 1)!;
  const x = s.x + s.w / 2;
  const z = s.y + s.h / 2 + PITCH_TILES / 2 - 0.5;
  label(c.name, new THREE.Vector3(x, heights.at(x, z), z));
});
ROWS.forEach((r, row) => {
  const x = MARGIN;
  const z = MARGIN + row * PITCH_TILES + PITCH_TILES / 2;
  label(r.name, new THREE.Vector3(x, BASE, z), 'row');
});

if (q.get('clean') === '1') {
  for (const el of document.querySelectorAll<HTMLElement>('#labels, #help'))
    el.style.display = 'none';
}

const help = document.querySelector('#help')!;
help.textContent =
  `Corner height difference: ${DIFF} (ordinary), ${MINE_DIFF} (mines). ` +
  'Drag to orbit, right-drag to pan, wheel to zoom. ' +
  'URL: ?diff= ?mine= ?stock=0 ?site=0.4 ?focus=col,row ?yaw= ?pitch= ?zoom=';

const SCRATCH = new THREE.Vector3();
function placeLabels(): void {
  const w = window.innerWidth;
  const h = window.innerHeight;
  for (const {el, at} of labels) {
    SCRATCH.copy(at).project(cam);
    const hidden = Math.abs(SCRATCH.x) > 1.05 || Math.abs(SCRATCH.y) > 1.05;
    el.style.display = hidden ? 'none' : '';
    el.style.left = `${((SCRATCH.x + 1) / 2) * w}px`;
    el.style.top = `${((1 - SCRATCH.y) / 2) * h}px`;
  }
}

// ---- loop -------------------------------------------------------------

let last = performance.now();
let frames = 0;
function tick(now: number): void {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  controls.update();
  buildings.cameraQuaternion = cam.quaternion;
  buildings.frame(dt);
  renderer.render(scene, cam);
  placeLabels();
  if (++frames === 3) console.log('rendered');
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);
