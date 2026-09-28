import * as THREE from 'three';
import {describe, expect, it, vi} from 'vitest';
import type {BuildingSnap} from '../protocol/messages';
import type {Enum} from '../shared/enum.ts';
import {DEFAULT_MAP_SIZE, tileCount, tileIdx} from '../shared/grid';
import * as BuildingState from '../sim/buildingStateEnum.ts';
import {buildingDef} from '../sim/defs/buildings';
import * as BuildingTypeId from '../sim/defs/buildingTypeIdEnum.ts';
import type {MapView} from '../sim/map';
import * as Terrain from '../sim/terrainEnum.ts';
import {HeightField} from './heightField';

type BuildingTypeId = Enum<typeof BuildingTypeId>;
type BuildingState = Enum<typeof BuildingState>;

// A model with one part of every kind the ground fit tells apart
// (groundFit.ts): the building's own walls, a field that lies on the ground,
// a rigid thing on its own feet, and a door mark off the centre. Named so
// the two copies — preview and built — can be matched part for part.
vi.mock('./assets', async () => {
  const {GROUND_ANCHOR, GROUND_FIT} = await import('./groundFit');
  return {
    glbCarryProp: () => null,
    glbPropAtScale: () => null,
    hasGlbProp: () => false,
    makeGlbBuilding: () => {
      const group = new THREE.Group();
      const walls = new THREE.Mesh(
        new THREE.BoxGeometry(0.6, 0.8, 0.5).translate(-0.1, 0.4, -0.15),
      );
      walls.name = 'walls';
      group.add(walls);
      const field = new THREE.Mesh(
        new THREE.BoxGeometry(0.9, 0.02, 0.4).translate(0, 0.01, 0.25),
      );
      field.name = 'field';
      field.userData[GROUND_FIT] = 'drape';
      group.add(field);
      const frame = new THREE.Group();
      frame.userData[GROUND_FIT] = 'foot';
      frame.position.set(0.35, 0, 0.3);
      const legs = new THREE.Mesh(
        new THREE.BoxGeometry(0.15, 0.5, 0.15).translate(0, 0.25, 0),
      );
      legs.name = 'legs';
      frame.add(legs);
      group.add(frame);
      const door = new THREE.Group();
      door.name = GROUND_ANCHOR;
      door.position.set(-0.1, 0, 0.12);
      group.add(door);
      // Scaled by the footprint like the real ones (templateScale).
      group.scale.setScalar(2.4);
      return group;
    },
  };
});

const {BuildingSync} = await import('./buildingSync');
const {GhostPlacement} = await import('./ghost');

const SIZE = DEFAULT_MAP_SIZE;

/** Rolling ground — not a plane, so a part that follows it has to follow
 * it vertex by vertex, and one that is merely tilted would not match. */
function hills(): HeightField {
  const h = new Float32Array(tileCount(SIZE));
  for (let z = 0; z < SIZE; z++) {
    for (let x = 0; x < SIZE; x++) {
      h[tileIdx(x, z, SIZE)] =
        1 + 0.35 * Math.sin(x * 0.7) + 0.25 * Math.cos(z * 0.9) + 0.04 * x;
    }
  }
  return new HeightField(h, SIZE);
}

function grass(): MapView {
  const n = tileCount(SIZE);
  return {
    size: SIZE,
    play: SIZE,
    terrain: new Uint8Array(n).fill(Terrain.Grass),
    resource: new Uint8Array(n),
    blocked: new Uint8Array(n),
    buildingAt: new Int16Array(n).fill(-1),
    pathLevel: new Uint8Array(n),
    height: new Float32Array(n),
  };
}

/** Every named mesh under `root`, as its world-space vertices. */
function drawn(root: THREE.Object3D): Map<string, number[]> {
  root.updateWorldMatrix(true, true);
  const out = new Map<string, number[]>();
  root.traverse(o => {
    if (!(o instanceof THREE.Mesh) || !o.name) return;
    const pos = (o.geometry as THREE.BufferGeometry).getAttribute('position');
    const v = new THREE.Vector3();
    const flat: number[] = [];
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld);
      flat.push(v.x, v.y, v.z);
    }
    out.set(o.name, flat);
  });
  return out;
}

function expectSame(a: Map<string, number[]>, b: Map<string, number[]>): void {
  expect([...a.keys()].sort()).toEqual(['field', 'legs', 'walls']);
  expect([...b.keys()].sort()).toEqual([...a.keys()].sort());
  for (const [name, verts] of a) {
    const other = b.get(name)!;
    expect(other.length).toBe(verts.length);
    verts.forEach((c, i) => expect(other[i]).toBeCloseTo(c, 6));
  }
}

/** The preview at (x, y), and the building the sync draws for the same
 * footprint — both on the same hills. */
function both(
  type: BuildingTypeId,
  x: number,
  y: number,
  state: BuildingState = BuildingState.built,
): {preview: THREE.Object3D; built: THREE.Object3D} {
  const heights = hills();
  const def = buildingDef(type);

  const ghostScene = new THREE.Scene();
  const ghost = new GhostPlacement(ghostScene, heights, grass());
  ghost.show(type);
  ghost.moveTo(x, y, true);
  const preview = ghostScene.children.find(
    o => o.getObjectByName('walls') !== undefined,
  )!;

  const scene = new THREE.Scene();
  const sync = new BuildingSync(scene, heights);
  const snap: BuildingSnap = {
    id: 1,
    type,
    owner: 0,
    x,
    y,
    w: def.w,
    h: def.h,
    hp: 100,
    maxHp: 100,
    state,
    ...(state === BuildingState.site ? {siteNeeds: {}, progress01: 0.5} : {}),
    stock: {},
    inputs: {},
    inbound: {},
    reservedOut: {},
  };
  sync.update([snap]);
  const built = scene.children.find(
    o => o.getObjectByName('walls') !== undefined,
  )!;
  return {preview, built};
}

describe('the placement preview stands exactly as the building will', () => {
  it.each([
    ['a farm', BuildingTypeId.wheatFarm],
    ['a storehouse', BuildingTypeId.storehouse],
    ['a mine, turned down its hill', BuildingTypeId.ironMine],
    ['a gold mine elsewhere on the hill', BuildingTypeId.goldMine],
  ])('%s', (_, type) => {
    for (const [x, y] of [
      [10, 10],
      [17, 23],
      [31, 12],
    ] as const) {
      const {preview, built} = both(type, x, y);
      expect(preview.position.y).toBeCloseTo(built.position.y, 6);
      const pm = preview.getObjectByName('walls')!.parent!;
      const bm = built.getObjectByName('walls')!.parent!;
      expect(pm.rotation.y).toBeCloseTo(bm.rotation.y, 6);
      expectSame(drawn(preview), drawn(built));
    }
  });

  it('and so does the construction site it becomes first', () => {
    const {preview, built} = both(
      BuildingTypeId.ironMine,
      17,
      23,
      BuildingState.site,
    );
    expect(preview.position.y).toBeCloseTo(built.position.y, 6);
    expectSame(drawn(preview), drawn(built));
  });

  it('is not trivially level ground', () => {
    // Guard on the fixture: at these spots the parts really are bent, or
    // the comparisons above would pass for a building that ignores slopes.
    const {built} = both(BuildingTypeId.wheatFarm, 17, 23);
    const field = drawn(built).get('field')!;
    const ys = field.filter((_, i) => i % 3 === 1);
    expect(Math.max(...ys) - Math.min(...ys)).toBeGreaterThan(0.1);
  });
});
