import * as THREE from 'three';
import { makeLights, makeRenderer, PITCH } from './scene';
import {
  loadGlbAssets,
  makeGlbBuilding,
  glbYardProp,
  glbYardRock,
} from '../../src/render/assets';
import { BuildingTypeId } from '../../src/sim/defs/buildings';

/**
 * A scratch page for the one question the cards cannot answer: do the four
 * ore posts read apart from one another? It draws them the way a match
 * does — makeGlbBuilding plus the yard stock buildingSync stacks — in a row
 * at the game's own 45/35 rig, with the yard both empty and full.
 *
 *   pnpm dev, then /tools/modelLab/_mines.html
 *   ?stock=0|1   empty yards or full ones (default: both rows)
 *   ?yaw=<deg>   turn the whole row
 */

const q = new URLSearchParams(location.search);

const TYPES: BuildingTypeId[] = [BuildingTypeId.quarry, BuildingTypeId.ironMine, BuildingTypeId.silverMine, BuildingTypeId.goldMine];
const NAMES = ['Quarry', 'Iron Mine', 'Silver Mine', 'Gold Mine'];

/** buildingSync's MINE_SPOTS and YARDS, copied so the page needs no
 * private access. */
const MINE_SPOTS: [number, number, number, number][] = [
  [-0.218, 0.245, 0.4, 1],
  [0.177, 0.337, -0.3, 0.52],
  [-0.325, 0.274, 1.1, 0.54],
];
const YARD: Record<string, { prop?: string; rock?: number; size: number }> = {
  quarry: { prop: 'resource_stone', size: 0.12 },
  ironMine: { rock: 0x9a5f42, size: 0.153 },
  silverMine: { rock: 0xdbe4ee, size: 0.153 },
  goldMine: { rock: 0xf0bc42, size: 0.153 },
};

function yardPiles(type: BuildingTypeId, stacks: number): THREE.Group {
  const g = new THREE.Group();
  const spec = YARD[type]!;
  const s = 2 * 1.06; // min(w,h) * 1.06, the way #syncYard sizes it
  for (let i = 0; i < stacks; i++) {
    const [x, z, rot, f] = MINE_SPOTS[i]!;
    const item = spec.prop
      ? glbYardProp(spec.prop, spec.size * f * s)
      : glbYardRock(spec.rock!, spec.size * f * s);
    if (!item) continue;
    item.position.set(x * s, 0, z * s);
    item.rotation.y = rot;
    g.add(item);
  }
  return g;
}

const W = Number(q.get('w') ?? 1600);
const H = Number(q.get('h') ?? 380);
// The rig's own default is 30 degrees (CAMERA_YAW), turnable in 15-degree
// steps, so a composition has to survive being walked around.
const YAW = ((Number(q.get('yaw') ?? 30) * Math.PI) / 180);

await loadGlbAssets();

function row(stacks: number, title: string): void {
  const head = document.createElement('h2');
  head.textContent = title;
  document.querySelector('#app')!.appendChild(head);

  const canvas = document.createElement('canvas');
  document.querySelector('#app')!.appendChild(canvas);
  const renderer = makeRenderer(canvas);
  renderer.setClearColor(0x6aa63c, 1);
  renderer.setSize(W, H, false);
  canvas.style.width = `${W}px`;
  canvas.style.height = `${H}px`;

  const scene = new THREE.Scene();
  makeLights(scene);
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(120, 120),
    new THREE.MeshStandardMaterial({ color: 0x55a02a, roughness: 1 }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);

  const PITCH_X = 4.4;
  TYPES.forEach((type, i) => {
    const holder = new THREE.Group();
    const b = makeGlbBuilding(type, 1);
    if (b) holder.add(b);
    if (stacks) holder.add(yardPiles(type, stacks));
    // A dirt apron, the way the game's ground reads under a worked post.
    const apron = new THREE.Mesh(
      new THREE.CircleGeometry(1.3, 28),
      new THREE.MeshStandardMaterial({ color: 0x8d7146, roughness: 1 }),
    );
    apron.rotation.x = -Math.PI / 2;
    apron.position.y = 0.004;
    apron.receiveShadow = true;
    holder.add(apron);
    const t = (i - (TYPES.length - 1) / 2) * PITCH_X;
    // Spread along the camera's own screen-right axis, whatever the yaw, so
    // the row stays a row when you walk round it.
    holder.position.set(t * Math.cos(YAW), 0, -t * Math.sin(YAW));
    scene.add(holder);
  });

  const view = H / (W / (PITCH_X * TYPES.length + 1.4));
  const cam = new THREE.OrthographicCamera(
    (-(PITCH_X * TYPES.length + 1.4)) / 2,
    (PITCH_X * TYPES.length + 1.4) / 2,
    view / 2 + 0.55,
    -view / 2 + 0.55,
    0.1,
    120,
  );
  const dist = 40;
  cam.position.set(
    Math.sin(YAW) * Math.cos(PITCH) * dist,
    Math.sin(PITCH) * dist,
    Math.cos(YAW) * Math.cos(PITCH) * dist,
  );
  cam.lookAt(0, 0, 0);
  cam.updateProjectionMatrix();
  renderer.render(scene, cam);

  const labels = document.createElement('div');
  labels.className = 'labels';
  labels.style.width = `${W}px`;
  labels.innerHTML = NAMES.map((n) => `<span>${n}</span>`).join('');
  document.querySelector('#app')!.appendChild(labels);
}

const only = q.get('stock');
if (only === null || only === '0') row(0, 'Empty yards — nothing mined yet');
if (only === null || only === '1') row(3, 'Full yards — three stacks of stock');
console.log('rendered');
