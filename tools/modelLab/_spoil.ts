import * as THREE from 'three';
import { makeLights, makeRenderer, PITCH } from './scene';
import { loadGlbAssets, makeGlbBuilding } from '../../src/render/assets';
import { HeightField } from '../../src/render/heightField';
import { TerrainMesh, Spoil, type SpoilKind } from '../../src/render/terrainMesh';
import { ScatterMesh } from '../../src/render/scatterMesh';
import { TileResource, Terrain, type MapView } from '../../src/sim/map';
import { tileIdx } from '../../src/shared/grid';
import { BuildingTypeId } from '../../src/sim/defs/buildings';

/**
 * The spoil pass, on the real terrain mesh.
 *
 * _mines.html stands the four posts on a flat plane, which is the right
 * stage for judging a silhouette and the wrong one for judging ground
 * paint: the ground there is a MeshStandardMaterial, and the thing under
 * test is TerrainMesh's own vertex painter. So this page builds a small
 * real map — deposits in the rock, footprints in buildingAt — and hands
 * the mesh the same spoil lookup main.ts gives it.
 *
 *   pnpm dev, then /tools/modelLab/_spoil.html
 *   ?spoil=0   paint with the lookup disabled, for the before shot
 *   ?yaw=<deg> walk the camera round
 */

const q = new URLSearchParams(location.search);
const SIZE = 34;
const PLAY = 30;

const YAW = (Number(q.get('yaw') ?? 30) * Math.PI) / 180;

/** Laid out along the camera's own screen-right axis so the four stay a row
 * whatever the yaw, the way _mines.html does it. */
const SPACING = 7.5;
const KINDS: { type: BuildingTypeId; res: number }[] = [
  { type: BuildingTypeId.quarry, res: TileResource.Rock },
  { type: BuildingTypeId.ironMine, res: TileResource.IronDep },
  { type: BuildingTypeId.silverMine, res: TileResource.SilverDep },
  { type: BuildingTypeId.goldMine, res: TileResource.GoldDep },
];
const MID = 16;
const POSTS = KINDS.map((k, i) => {
  const t = (i - (KINDS.length - 1) / 2) * SPACING;
  return {
    ...k,
    at: [Math.round(MID + t * Math.cos(YAW)), Math.round(MID - t * Math.sin(YAW))] as [
      number,
      number,
    ],
  };
});

const n = SIZE * SIZE;
const map: MapView = {
  size: SIZE,
  play: PLAY,
  terrain: new Uint8Array(n).fill(Terrain.Grass),
  resource: new Uint8Array(n),
  blocked: new Uint8Array(n),
  buildingAt: new Int16Array(n).fill(-1),
  pathLevel: new Uint8Array(n),
  height: new Float32Array(n).fill(0.6),
};

// Each post on a 2x2 footprint, with its seam in the ground behind it —
// the siting rule the sim actually enforces (a gatherer only stands where
// its worker has something in reach).
const typeOf = new Map<number, BuildingTypeId>();
POSTS.forEach((p, i) => {
  const id = i + 1;
  typeOf.set(id, p.type);
  for (let dy = 0; dy < 2; dy++) {
    for (let dx = 0; dx < 2; dx++) {
      map.buildingAt[tileIdx(p.at[0] + dx, p.at[1] + dy, SIZE)] = id;
    }
  }
  for (let dy = -3; dy <= -1; dy++) {
    for (let dx = -1; dx <= 2; dx++) {
      const tx = p.at[0] + dx;
      const ty = p.at[1] + dy;
      if ((tx * 7 + ty * 13) % 3 === 0) continue; // a ragged seam, not a slab
      map.resource[tileIdx(tx, ty, SIZE)] = p.res;
    }
  }
});

const W = Number(q.get('w') ?? 1650);
const H = Number(q.get('h') ?? 430);
const SPOIL_ON = q.get('spoil') !== '0';

await loadGlbAssets();

const canvas = document.createElement('canvas');
document.querySelector('#app')!.appendChild(canvas);
const renderer = makeRenderer(canvas);
renderer.setClearColor(0x6aa63c, 1);
renderer.setSize(W, H, false);
canvas.style.width = `${W}px`;
canvas.style.height = `${H}px`;

const scene = new THREE.Scene();
makeLights(scene);

const heights = new HeightField(map.height as Float32Array, SIZE);
const terrain = new TerrainMesh(map, heights, (id): SpoilKind => {
  if (!SPOIL_ON) return Spoil.None;
  const t = typeOf.get(id);
  return t === BuildingTypeId.quarry
    ? Spoil.Stone
    : t === BuildingTypeId.ironMine
      ? Spoil.Iron
      : t === BuildingTypeId.silverMine
        ? Spoil.Silver
        : t === BuildingTypeId.goldMine
          ? Spoil.Gold
          : Spoil.None;
});
terrain.repaintAll();
scene.add(terrain.mesh);

// The seam itself, as the game scatters it — the whole point is whether the
// spoil joins up with this.
const scatter = new ScatterMesh(map, heights);
scene.add(scatter.group);

for (const p of POSTS) {
  const b = makeGlbBuilding(p.type, 1);
  if (!b) continue;
  // buildingSync anchors a building at its footprint centre.
  b.position.set(p.at[0] + 1, heights.at(p.at[0] + 1, p.at[1] + 1), p.at[1] + 1);
  scene.add(b);
}

const centerX = MID + 1;
const centerZ = MID + 1;
const view = SPACING * KINDS.length + 3;
const cam = new THREE.OrthographicCamera(
  -view / 2,
  view / 2,
  (view * H) / W / 2 + 1.6,
  (-view * H) / W / 2 + 1.6,
  0.1,
  200,
);
const dist = 60;
cam.position.set(
  centerX + Math.sin(YAW) * Math.cos(PITCH) * dist,
  Math.sin(PITCH) * dist,
  centerZ + Math.cos(YAW) * Math.cos(PITCH) * dist,
);
cam.lookAt(centerX, 0, centerZ);
cam.updateProjectionMatrix();
renderer.render(scene, cam);

const head = document.createElement('h2');
head.textContent = SPOIL_ON ? 'With spoil' : 'Without spoil (today)';
document.querySelector('#app')!.prepend(head);
const labels = document.createElement('div');
labels.className = 'labels';
labels.style.width = `${W}px`;
labels.innerHTML = ['Quarry', 'Iron Mine', 'Silver Mine', 'Gold Mine']
  .map((s) => `<span>${s}</span>`)
  .join('');
document.querySelector('#app')!.appendChild(labels);
console.log('rendered');
