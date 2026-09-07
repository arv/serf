import * as THREE from 'three';
import type {BuildingSnap} from '../../src/protocol/messages';
import {loadGlbAssets} from '../../src/render/assets';
import {
  BuildingSync,
  PIER_SPOT_BACK,
  type PierInfo,
} from '../../src/render/buildingSync';
import {CAMERA_YAW} from '../../src/render/cameraRig';
import {HeightField} from '../../src/render/heightField';
import {ScatterMesh} from '../../src/render/scatterMesh';
import {TerrainMesh} from '../../src/render/terrainMesh';
import {WaterMesh} from '../../src/render/waterMesh';
import * as BuildingState from '../../src/sim/buildingStateEnum.ts';
import {buildingDef} from '../../src/sim/defs/buildings';
import * as BuildingTypeId from '../../src/sim/defs/buildingTypeIdEnum.ts';
import {WATER_LEVEL} from '../../src/sim/map';
import {canPlace, createWorld, waterFacing} from '../../src/sim/world';
import {makeLights, makeRenderer, PITCH} from './scene';

/**
 * The fishery's pier, on real shoreline.
 *
 * The other pages stand a building on a plate of turf with a painted chord
 * of water behind it — the right stage for judging a silhouette and the
 * wrong one for judging whether a deck ends in the lake, because the
 * shoreline there is authored to suit the model. So this page generates a
 * real world, finds the legal shore sites where the deck AS AUTHORED ends on
 * grass, and renders `BuildingSync`'s own fit on each one against the real
 * terrain mesh, the real water plane and the real scatter.
 *
 *   pnpm dev, then /tools/modelLab/_pier.html
 *   ?fit=none   fit against ground whose lakes are filled to the
 *               waterline, so no fit is found and the deck stays as
 *               authored — the before shot, and the reason the fit exists
 *   ?seed=<n>   which world to trawl
 *   ?worst=1    the sites the fit has to distort most, rather than the
 *               first it finds
 *   ?all=1      every legal site, wet ones included
 *   ?at=x,y     one named site, for a long look at a single deck
 *   ?n=<count>  how many, ?cell=<px> how big each, ?view=<tiles> the zoom,
 *   ?yaw=<deg>  camera; the default is the rig's own opening angle
 */

const q = new URLSearchParams(location.search);
const SEED = Number(q.get('seed') ?? 1);
const COUNT = Number(q.get('n') ?? 8);
const CELL = Number(q.get('cell') ?? 300);
const FIT = q.get('fit') !== 'none';
const WORST = q.get('worst') === '1';
const ALL = q.get('all') === '1';
const AT = q.get('at')?.split(',').map(Number);
const YAW =
  q.get('yaw') !== null ? (Number(q.get('yaw')) * Math.PI) / 180 : CAMERA_YAW;
/** Tiles across the frame — village zoom, the bar decor has to clear. */
const VIEW = Number(q.get('view') ?? 12);

/** The fishery's footprint, and half of it — the offset from a site's
 * origin to its centre. Read off the def: this page used to write 3 and
 * 1.5 out in five places, which is five places to miss when the plot
 * changes size. */
const FP = buildingDef(BuildingTypeId.fishery).w;
const HALF = FP / 2;

const world = createWorld(SEED);
const map = world.map;
const heights = new HeightField(map.height, map.size);

/** The real ground with every lake bed filled to just over the waterline:
 * the huts still stand at their true height, but no fit can find water
 * anywhere, so `BuildingSync` hands back the deck exactly as the model
 * places it — the before shot. (Just OVER, because the field is float32 and
 * WATER_LEVEL rounds into it a hair low, which would read as a puddle.) */
const filledIn = new HeightField(
  map.height.map(h => Math.max(h, WATER_LEVEL + 0.05)),
  map.size,
);
/**
 * Is the deck's far end over water the player can see?
 *
 * Both points the fit judges, not just one: the fishing spot AND the tip a
 * step beyond it (`PIER_SPOT_BACK` along the yaw — the spot is the only
 * deck point `PierInfo` carries). Scoring the spot alone would call a deck
 * that strides a narrow channel and lands on the far bank "in the water",
 * because the spot behind the tip is over the channel — and that overshoot
 * is one of the two things the fit exists to correct, so the page would be
 * flattering the very change it is meant to check.
 *
 * The terrain mesh draws the height field vertex for vertex, so this is the
 * fit's own question — just without its draft, since what the page reports
 * is whether a deck ended up wet at all, not whether it cleared the
 * waterline by a plank.
 */
const pierWet = (p: PierInfo): boolean => {
  const wet = (x: number, z: number): boolean => heights.at(x, z) < WATER_LEVEL;
  return (
    wet(p.spotX, p.spotZ) &&
    wet(
      p.spotX + Math.sin(p.yaw) * PIER_SPOT_BACK,
      p.spotZ + Math.cos(p.yaw) * PIER_SPOT_BACK,
    )
  );
};

await loadGlbAssets();

function snap(id: number, x: number, y: number): BuildingSnap {
  return {
    id,
    type: BuildingTypeId.fishery,
    owner: 0,
    x,
    y,
    w: FP,
    h: FP,
    // The sim's own answer, or the deck would start out pointing +z on
    // every site and the fit would be judged against a straw man.
    facing: waterFacing(map, x, y, FP, FP, 1),
    hp: 150,
    maxHp: 150,
    state: BuildingState.built,
    stock: {},
    inputs: {},
    inbound: {},
    reservedOut: {},
  };
}

/** Deck lines for every site, keyed by footprint origin. One throwaway
 * scene per pass, so this asks the real code where the planks end rather
 * than re-deriving the geometry here. */
function measure(
  sites: {x: number; y: number}[],
  ground: HeightField,
): Map<string, PierInfo> {
  const sync = new BuildingSync(new THREE.Scene(), ground);
  sync.update(sites.map((s, i) => snap(i + 1, s.x, s.y)));
  const out = new Map<string, PierInfo>();
  for (const p of sync.fisheryPiers())
    out.set(`${Math.round(p.bx - HALF)},${Math.round(p.bz - HALF)}`, p);
  return out;
}

const sites: {x: number; y: number}[] = [];
for (let y = 0; y < map.size - FP; y++)
  for (let x = 0; x < map.size - FP; x++)
    if (canPlace(map, BuildingTypeId.fishery, x, y)) sites.push({x, y});

const asAuthored = measure(sites, filledIn);
const fitted = measure(sites, heights);

/** Turn in degrees and trim in tiles the fit spent on each site, and
 * whether either end of the story is dry. */
const rows = sites.map(s => {
  const key = `${s.x},${s.y}`;
  const a = asAuthored.get(key)!;
  const f = fitted.get(key)!;
  const reach = (p: PierInfo): number =>
    Math.hypot(p.spotX - p.baseX, p.spotZ - p.baseZ);
  let turn = ((f.yaw - a.yaw) * 180) / Math.PI;
  while (turn > 180) turn -= 360;
  while (turn < -180) turn += 360;
  return {
    ...s,
    turn,
    trim: reach(a) - reach(f),
    dryAsAuthored: !pierWet(a),
    dryFitted: !pierWet(f),
  };
});

const dry = rows.filter(r => r.dryAsAuthored);
console.log(
  `seed ${SEED}: ${rows.length} legal sites, ` +
    `${dry.length} dry as authored, ` +
    `${rows.filter(r => r.dryFitted).length} dry after the fit`,
);

// Legal sites come in overlapping runs along a shore, so take them a frame
// apart: a cell holding three fisheries says nothing about any of them.
const picked: typeof rows = [];
for (const r of (AT
  ? rows.filter(r => r.x === AT[0] && r.y === AT[1])
  : ALL
    ? [...rows]
    : dry
).sort((a, b) =>
  WORST
    ? Math.abs(b.turn) + b.trim * 60 - (Math.abs(a.turn) + a.trim * 60)
    : a.y - b.y || a.x - b.x,
)) {
  if (picked.length >= COUNT) break;
  if (picked.some(p => Math.hypot(p.x - r.x, p.y - r.y) < VIEW)) continue;
  picked.push(r);
}

const scene = new THREE.Scene();
makeLights(scene);
const terrain = new TerrainMesh(map, heights);
terrain.repaintAll();
scene.add(terrain.group);
scene.add(new WaterMesh(map).mesh);
scene.add(new ScatterMesh(map, heights).group);

// One fishery per picked site, all in the same world — they are far enough
// apart that a frame only ever holds the one it is centered on.
const buildings = new BuildingSync(scene, FIT ? heights : filledIn);
buildings.update(picked.map((s, i) => snap(i + 1, s.x, s.y)));
buildings.fisheryPiers();

const gl = document.createElement('canvas');
const renderer = makeRenderer(gl);
renderer.setClearColor(0x1d2b18, 1);
renderer.setSize(CELL, CELL, false);

const app = document.querySelector('#app')!;
const head = document.createElement('h2');
head.textContent = FIT
  ? `seed ${SEED}: the deck fitted to the water`
  : `seed ${SEED}: the deck as authored (nothing aiming it)`;
app.appendChild(head);
const grid = document.createElement('div');
grid.className = 'grid';
app.appendChild(grid);

const cam = new THREE.OrthographicCamera();
for (const s of picked) {
  const cx = s.x + HALF;
  const cz = s.y + HALF;
  cam.left = -VIEW / 2;
  cam.right = VIEW / 2;
  cam.top = VIEW / 2;
  cam.bottom = -VIEW / 2;
  cam.near = 0.1;
  cam.far = 400;
  const dist = 120;
  cam.position.set(
    cx + Math.sin(YAW) * Math.cos(PITCH) * dist,
    Math.sin(PITCH) * dist,
    cz + Math.cos(YAW) * Math.cos(PITCH) * dist,
  );
  cam.lookAt(cx, 0, cz);
  cam.updateProjectionMatrix();
  renderer.render(scene, cam);

  const fig = document.createElement('figure');
  const out = document.createElement('canvas');
  out.width = CELL;
  out.height = CELL;
  out.getContext('2d')!.drawImage(gl, 0, 0);
  const cap = document.createElement('figcaption');
  const wet = FIT ? !s.dryFitted : !s.dryAsAuthored;
  cap.textContent =
    `(${s.x},${s.y}) turn ${s.turn.toFixed(0)}° ` +
    `trim ${s.trim.toFixed(2)} — ${wet ? 'in the water' : 'DRY'}`;
  cap.style.color = wet ? '#dfe8d6' : '#ff9c7a';
  fig.append(out, cap);
  grid.appendChild(fig);
}
console.log('rendered');
