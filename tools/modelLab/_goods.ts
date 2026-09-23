import * as THREE from 'three';
import * as AnimKey from '../../src/render/animKeyEnum.ts';
import {loadGlbAssets} from '../../src/render/assets';
import {
  loadCharacterAssets,
  makeCharacter,
  playAnimation,
} from '../../src/render/characters';
import {
  makeCarryProp,
  makePileProp,
  makeTieredPile,
  pileCap,
  pileSlot,
} from '../../src/render/models';
import type {Enum} from '../../src/shared/enum.ts';
import * as GoodId from '../../src/sim/defs/goodIdEnum.ts';
import {GOODS} from '../../src/sim/defs/goods';
import * as UnitTypeId from '../../src/sim/defs/unitTypeIdEnum.ts';
import {makeLights, makeRenderer, PITCH} from './scene';

type GoodId = Enum<typeof GoodId>;

/**
 * The raw goods, the way a match shows them: a serf carrying one, and the
 * stock pile at a building's door at a few counts, laid by the same
 * pileSlot BuildingSync.#syncPiles uses.
 *
 *   pnpm dev, then /tools/modelLab/_goods.html
 *   ?goods=wood,stone   only these rows (GOOD_KEYS spellings)
 *   ?counts=1,5,20      the pile sizes drawn
 *   ?yaw=<deg>          turn the camera (the rig opens at 30)
 *   ?w= ?h=             canvas size per row
 */

const q = new URLSearchParams(location.search);
const KEYS: Record<string, GoodId> = {
  wood: GoodId.wood,
  stone: GoodId.stone,
  iron: GoodId.iron,
  silver: GoodId.silver,
  gold: GoodId.gold,
};
const ROWS = (q.get('goods') ?? 'wood,stone,iron,silver,gold')
  .split(',')
  .filter(k => k in KEYS);
const COUNTS = (q.get('counts') ?? '1,3,5,8,20,40').split(',').map(Number);
const W = Number(q.get('w') ?? 1400);
const H = Number(q.get('h') ?? 300);
const YAW = (Number(q.get('yaw') ?? 30) * Math.PI) / 180;

await Promise.all([loadGlbAssets(), loadCharacterAssets()]);

/** One good's door pile in lane 0, the way #syncPiles lays it. */
function pile(good: GoodId, n: number): THREE.Group {
  const tiered = makeTieredPile(good, Math.min(n, pileCap(good)));
  if (tiered) return tiered;
  const g = new THREE.Group();
  for (let i = 0; i < Math.min(n, pileCap(good)); i++) {
    const prop = makePileProp(good);
    const [x, y, z, yaw] = pileSlot(i, (i * 0.37) % 1, (i * 0.61) % 1);
    prop.position.set(x, y, z);
    prop.rotation.y = yaw;
    g.add(prop);
  }
  return g;
}

function carrier(good: GoodId): THREE.Group {
  const made = makeCharacter(UnitTypeId.serf, 0, 0);
  if (!made) throw new Error('characters not loaded');
  const {group, visual} = made;
  const load = makeCarryProp(GOODS.indexOf(good) + 1);
  if (load && visual.carryAnchor) {
    load.position.set(0, 0, 0);
    visual.carryAnchor.add(load);
  }
  playAnimation(visual, AnimKey.carry, 0);
  visual.mixer.update(0.3);
  group.rotation.y = -0.6;
  return group;
}

function row(key: string): void {
  const good = KEYS[key]!;
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
    new THREE.PlaneGeometry(80, 80),
    new THREE.MeshStandardMaterial({color: 0x55a02a, roughness: 1}),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);

  const items: THREE.Object3D[] = [
    carrier(good),
    ...COUNTS.map(n => pile(good, n)),
  ];
  const PITCH_X = 1.2;
  items.forEach((item, i) => {
    const t = (i - (items.length - 1) / 2) * PITCH_X;
    item.position.x += t * Math.cos(YAW);
    item.position.z += -t * Math.sin(YAW);
    scene.add(item);
  });

  const span = PITCH_X * items.length;
  const view = H / (W / span);
  const cam = new THREE.OrthographicCamera(
    -span / 2,
    span / 2,
    view / 2 + 0.45,
    -view / 2 + 0.45,
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
  labels.innerHTML = [`${key}, carried`, ...COUNTS.map(n => `${n} at the door`)]
    .map(s => `<span>${s}</span>`)
    .join('');
  document.querySelector('#app')!.appendChild(labels);
}

for (const key of ROWS) row(key);
console.log('rendered');
