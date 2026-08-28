import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { DEFAULT_MAP_SIZE, tileCount } from '../shared/grid';
import { WATER_LEVEL } from '../sim/map';
import { HeightField } from './heightField';
import { SITE_FRAME_H } from './models';
import type { BuildingSnap } from '../protocol/messages';
import type { GoodAmounts } from '../sim/defs/goods';
import { GoodId } from '../sim/defs/goods';
import { BuildingTypeId } from '../sim/defs/buildings';

// The KayKit buildings carry material *arrays* on their meshes (the textured
// group plus the team-color group). The real loader needs GLB files, so mock
// the surface this import graph touches and hand update() a synthetic model
// of the same shape.
vi.mock('./assets', () => ({
  glbCarryProp: () => null,
  makeGlbBuilding: (type: BuildingTypeId) => {
    const geo = new THREE.BoxGeometry(1, 1, 1);
    geo.clearGroups();
    geo.addGroup(0, 18, 0);
    geo.addGroup(18, 18, 1);
    const mesh = new THREE.Mesh(geo, [
      new THREE.MeshStandardMaterial(),
      new THREE.MeshLambertMaterial(),
    ]);
    const group = new THREE.Group();
    group.add(mesh);
    // The real fishery carries a shoal in its decor. The pack fish are GLB,
    // so stand an empty group in for each: makeShoal only needs the factory
    // to hand back something it can hang on a pivot, and the swimming is all
    // in the pivots.
    if (type === BuildingTypeId.fishery) {
      group.add(makeShoal(() => new THREE.Group()));
      // ...and a pier. A plank box runs +z out of the front face, the shape
      // fisheryPiers() measures for the fisherman's walk.
      const pier = new THREE.Group();
      pier.name = 'fisheryPier';
      const deck = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.1, 2.5));
      deck.position.z = 2.1;
      pier.add(deck);
      group.add(pier);
    }
    // The real mill carries its sails as a named node (renamed from the
    // pack's in assets.ts); frame() only needs something to rotate.
    if (type === BuildingTypeId.mill) {
      const fan = new THREE.Group();
      fan.name = 'millFan';
      group.add(fan);
    }
    return group;
  },
}));

const { makeShoal } = await import('./procParts');

const { BuildingSync } = await import('./buildingSync');

function snap(over: Partial<BuildingSnap>): BuildingSnap {
  return {
    id: 7,
    type: BuildingTypeId.woodcutter,
    owner: 0,
    x: 10,
    y: 10,
    w: 2,
    h: 2,
    hp: 150,
    maxHp: 150,
    state: 'built',
    stock: {},
    inputs: {},
    inbound: {},
    reservedOut: {},
    ...over,
  };
}

function makeSync(): { sync: InstanceType<typeof BuildingSync>; scene: THREE.Scene } {
  const scene = new THREE.Scene();
  const sync = new BuildingSync(
    scene,
    new HeightField(new Float32Array(tileCount(DEFAULT_MAP_SIZE)), DEFAULT_MAP_SIZE),
    0,
  );
  return { sync, scene };
}

describe('a construction site with multi-material meshes', () => {
  it('survives finishing: the site visual swaps for the built model', () => {
    const { sync, scene } = makeSync();
    sync.update([snap({ state: 'site', progress01: 0.5, siteNeeds: {} })]);
    const siteRoots = scene.children.length;
    expect(siteRoots).toBeGreaterThan(0);

    // The state swap disposes the site's cloned clip materials. Before the
    // fix this threw mid-update ("material.dispose is not a function"),
    // leaving the building invisible and poisoning every later update —
    // from that frame on no visual was ever created or removed again.
    sync.update([snap({ state: 'built' })]);
    expect(scene.children.length).toBe(siteRoots);

    // The next roster still syncs: a razed building's visual goes down
    // through the teardown — it lingers (model sinking, dust ring) while
    // the animation plays, and only then leaves the scene for good.
    sync.update([]);
    expect(scene.children.length).toBeGreaterThan(0);
    sync.frame(0.7);
    sync.frame(0.7);
    expect(scene.children.length).toBe(0);
  });

  it('a poisoned frame does not orphan later buildings', () => {
    const { sync, scene } = makeSync();
    sync.update([snap({ state: 'site', progress01: 0.5, siteNeeds: {} })]);
    // Completion and a brand-new site arrive in the same structural frame;
    // both must come out standing.
    sync.update([
      snap({ state: 'built' }),
      snap({ id: 8, x: 20, y: 20, state: 'site', progress01: 0, siteNeeds: {} }),
    ]);
    expect(scene.children.length).toBe(2);
  });
});

describe("the fishery's pier", () => {
  it('reports a deck line turned with the building, landward end first', () => {
    const { sync } = makeSync();
    // Facing 2: the pier turns half a circle, out of the north face (-z).
    sync.update([snap({ type: BuildingTypeId.fishery, w: 3, h: 3, facing: 2 })]);
    const piers = sync.fisheryPiers();
    expect(piers.length).toBe(1);
    const p = piers[0]!;
    expect(p.bx).toBeCloseTo(11.5);
    expect(p.bz).toBeCloseTo(11.5);
    expect(p.yaw).toBeCloseTo(Math.PI);
    // The deck runs north: its landward end nearest the building, the
    // fishing spot further out (and a step short of the tip).
    expect(p.baseZ).toBeLessThan(11.5);
    expect(p.spotZ).toBeLessThan(p.baseZ);
    expect(p.baseX).toBeCloseTo(11.5);
    expect(p.spotX).toBeCloseTo(11.5);
    // Standing height: the planks sit a touch proud of the ground.
    expect(p.deckY).toBeGreaterThan(0);
    expect(p.deckY).toBeLessThan(0.2);
  });

  it('swings 45 degrees toward the wet diagonal on a corner-only shore', () => {
    const { sync, scene } = makeSync();
    // Facing 2 sends the pier north, but only the north-WEST diagonal is
    // water — the corner-pegged placement the quarter-turn facing can't
    // express.
    sync.update([snap({ type: BuildingTypeId.fishery, w: 3, h: 3, facing: 2 })]);
    sync.setWater((tx) => tx <= 9);
    const p = sync.fisheryPiers()[0]!;
    expect(p.yaw).toBeCloseTo(Math.PI + Math.PI / 4);
    // The fishing spot moved out along the diagonal, west of the deck line.
    expect(p.spotX).toBeLessThan(11);
    expect(p.spotZ).toBeLessThan(p.baseZ);
    // The decor itself turned with it, pivoting on the landward end...
    const pier = scene.getObjectByName('fisheryPier')!;
    expect(pier.rotation.y).toBeCloseTo(Math.PI / 4);
    // ...and the measurement is cached: asking again must not swing twice.
    expect(sync.fisheryPiers()[0]!.yaw).toBeCloseTo(p.yaw);
    expect(pier.rotation.y).toBeCloseTo(Math.PI / 4);
  });

  it('is absent while the fishery is still a site', () => {
    const { sync } = makeSync();
    sync.update([snap({ type: BuildingTypeId.fishery, w: 3, h: 3, facing: 1, state: 'site', siteNeeds: {} })]);
    expect(sync.fisheryPiers().length).toBe(0);
  });
});

describe('the damage bars', () => {
  /** The orientation baked into the first bar instance. The bars are
   * instanced, so the matrix is where the camera's angle actually ends up. */
  const barQuat = (scene: THREE.Scene): THREE.Quaternion => {
    const bars = scene.children.filter(
      (o): o is THREE.InstancedMesh => o instanceof THREE.InstancedMesh,
    );
    expect(bars.length).toBeGreaterThan(0);
    const m = new THREE.Matrix4();
    bars[0]!.getMatrixAt(0, m);
    const q = new THREE.Quaternion();
    m.decompose(new THREE.Vector3(), q, new THREE.Vector3());
    return q;
  };

  it('turn with the camera, not only when a building changes', () => {
    const { sync, scene } = makeSync();
    // The live object the rig turns, exactly as main.ts hands it over.
    const cam = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 6);
    sync.cameraQuaternion = cam;
    sync.update([snap({ hp: 60 })]); // hurt, so it wears a bar
    expect(barQuat(scene).angleTo(cam)).toBeCloseTo(0, 6);

    // The camera turns. No roster change, no highlight change — nothing
    // that has ever rebuilt these bars.
    cam.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 3);
    sync.frame(1 / 60);
    expect(barQuat(scene).angleTo(cam)).toBeCloseTo(0, 6);

    // And while the world is stopped: the game pauses, the camera does not.
    cam.setFromAxisAngle(new THREE.Vector3(0, 1, 0), -Math.PI / 4);
    sync.frame(0);
    expect(barQuat(scene).angleTo(cam)).toBeCloseTo(0, 6);

    // A camera at rest rebuilds nothing — the bars are left exactly as they
    // were, instance buffer and all.
    const bars = scene.children.find((o): o is THREE.InstancedMesh => o instanceof THREE.InstancedMesh)!;
    const before = bars.instanceMatrix.version;
    sync.frame(1 / 60);
    sync.frame(1 / 60);
    expect(bars.instanceMatrix.version).toBe(before);
  });

  it('is not fooled into rebuilding by a pan', () => {
    // lookAt derives the orientation from a position that is the target
    // plus an offset, so panning wanders the quaternion's last bits while
    // the angle stands still. An exact compare called that a turn and
    // rewrote every bar in the settlement, most frames of every pan.
    const { sync, scene } = makeSync();
    const cam = new THREE.Quaternion();
    const eye = new THREE.Vector3();
    const up = new THREE.Vector3(0, 1, 0);
    const look = new THREE.Object3D();
    /** Aim a camera at (x, z) from the rig's own fixed offset. */
    const aimAt = (x: number, z: number): void => {
      eye.set(x + 42.1, 51.6, z + 42.1);
      look.position.copy(eye);
      look.lookAt(x, 0, z);
      cam.copy(look.quaternion);
    };
    aimAt(40, 55);
    sync.cameraQuaternion = cam;
    sync.update([snap({ hp: 60 })]);
    const bars = scene.children.find((o): o is THREE.InstancedMesh => o instanceof THREE.InstancedMesh)!;
    const before = bars.instanceMatrix.version;
    // A long pan, in the fractional steps a real one arrives in.
    let differing = 0;
    for (let i = 1; i <= 200; i++) {
      const was = cam.clone();
      aimAt(40 + i * 0.137, 55 - i * 0.211);
      if (!cam.equals(was)) differing++;
      sync.frame(1 / 60);
    }
    // The premise: an exact compare really would have fired, and often.
    expect(differing).toBeGreaterThan(50);
    expect(bars.instanceMatrix.version).toBe(before);
    // A turn far too small to see still counts as a turn.
    const tiny = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), 1e-3);
    cam.multiply(tiny);
    sync.frame(1 / 60);
    expect(bars.instanceMatrix.version).toBeGreaterThan(before);
  });
});

describe("the mill's sails", () => {
  it('turn while a batch grinds and coast to rest when it ends', () => {
    const { sync, scene } = makeSync();
    // A mill mid-batch: no staffing (the wind is the worker), just working.
    sync.update([snap({ type: BuildingTypeId.mill, working: true })]);
    const fan = scene.getObjectByName('millFan')!;
    expect(fan.rotation.z).toBe(0);
    for (let i = 0; i < 20; i++) sync.frame(0.1);
    const turned = fan.rotation.z;
    expect(turned).toBeGreaterThan(0.5);

    // Batch over: momentum keeps the sails moving just after...
    sync.update([snap({ type: BuildingTypeId.mill })]);
    sync.frame(0.1);
    expect(fan.rotation.z).toBeGreaterThan(turned);
    // ...but they coast to a stop rather than turning forever.
    for (let i = 0; i < 100; i++) sync.frame(0.1);
    const rest = fan.rotation.z;
    sync.frame(0.1);
    expect(fan.rotation.z).toBe(rest);
  });

  it('stand still on a mill that is not grinding', () => {
    const { sync, scene } = makeSync();
    sync.update([snap({ type: BuildingTypeId.mill })]);
    for (let i = 0; i < 10; i++) sync.frame(0.1);
    expect(scene.getObjectByName('millFan')!.rotation.z).toBe(0);
  });
});

describe("the fishery's shoal", () => {
  it('swims under the waterline, not at the deck height the template bakes', () => {
    const { sync, scene } = makeSync();
    sync.update([snap({ type: BuildingTypeId.fishery, staffing: 'staffed' })]);
    const shoal = scene.getObjectByName('fisheryShoal')!;
    // The test heightfield is flat zero, so the shore sits at y=0 — well
    // above the water plane. The group must have been re-seated below it.
    const y = shoal.getWorldPosition(new THREE.Vector3()).y;
    expect(y).toBeLessThan(WATER_LEVEL);
  });

  it('swims nose-first, whichever way round its circle it goes', () => {
    const { sync, scene } = makeSync();
    sync.update([snap({ type: BuildingTypeId.fishery, staffing: 'staffed' })]);
    const shoal = scene.getObjectByName('fisheryShoal');
    expect(shoal).toBeDefined();
    // Three fish, and the pack deals them both directions.
    const speeds = shoal!.children.map((p) => (p.userData as { speed: number }).speed);
    expect(speeds.some((s) => s > 0)).toBe(true);
    expect(speeds.some((s) => s < 0)).toBe(true);

    // One frame to seat them on their circles — makeShoal leaves every pivot
    // at the origin — then a short step to measure.
    const DT = 0.05;
    sync.frame(DT);
    const before = shoal!.children.map((p) => p.position.clone());
    sync.frame(DT);

    shoal!.children.forEach((pivot, i) => {
      // Where it actually went this frame, against where its nose ended up
      // pointing. The model's nose is -z.
      const moved = pivot.position.clone().sub(before[i]!).setY(0).normalize();
      const nose = new THREE.Vector3(0, 0, -1).applyEuler(pivot.rotation).setY(0).normalize();
      // A twentieth of a second of arc is short enough that the chord and the
      // tangent agree closely; tail-first would land near -1.
      expect(nose.dot(moved)).toBeGreaterThan(0.99);
    });
  });
});

describe('the measurements the pointer picks against', () => {
  /** The mocked model is a unit box centered on its origin. */
  const MODEL_TOP = 0.5;

  it('measures a built building by its model, from the ground it stands on', () => {
    const scene = new THREE.Scene();
    const ground = new Float32Array(tileCount(DEFAULT_MAP_SIZE)).fill(1.5);
    const sync = new BuildingSync(scene, new HeightField(ground, DEFAULT_MAP_SIZE), 0);
    sync.update([snap({ state: 'built' })]);
    expect(sync.heightOf(7)).toBeCloseTo(MODEL_TOP);
    // Height is over the building's own base, and the base is where the
    // hillside put it — the two are read together or not at all.
    expect(sync.baseOf(7)).toBeCloseTo(1.5);
    // The ceiling is absolute: the roof's elevation, ground included.
    expect(sync.ceiling()).toBeCloseTo(1.5 + MODEL_TOP);
  });

  it('gives a fresh site its scaffolding, which is all there is to click', () => {
    const { sync } = makeSync();
    sync.update([snap({ state: 'site', progress01: 0, siteNeeds: {} })]);
    // The building itself is a sliver at this point; the frame is not.
    expect(sync.heightOf(7)).toBeCloseTo(SITE_FRAME_H);
    // The ceiling counts the site by what it will be, frame included.
    expect(sync.ceiling()).toBeGreaterThanOrEqual(SITE_FRAME_H);
  });

  it('leaves a road flat: its scaffolding is not a pick box', () => {
    const { sync } = makeSync();
    sync.update([snap({ type: BuildingTypeId.roadSite, w: 1, h: 1, state: 'site', progress01: 0, siteNeeds: {} })]);
    // The frame stands 0.7 up while the road is laid, but a road is ground:
    // picking it by its scaffolding would shadow the route it is part of.
    expect(sync.heightOf(7)).toBe(0);
    expect(sync.ceiling()).toBe(Number.NEGATIVE_INFINITY);
  });

  it('knows nothing of a building that never stood', () => {
    const { sync } = makeSync();
    expect(sync.heightOf(99)).toBe(0);
    expect(sync.baseOf(99)).toBe(0);
    // Nothing standing anywhere: no ceiling to climb to, so a pick is the
    // ground hit it always was.
    expect(sync.ceiling()).toBe(Number.NEGATIVE_INFINITY);
  });
});

describe('the stock piles at a building door', () => {
  // The piles hang off the visual's root as one group, parked just outside
  // the front wall. Each good's stack is a cluster of props around its lane
  // (each prop jittered a few centimetres off it), so read the ground back
  // as the centre of every cluster.
  function stackXs(scene: THREE.Scene, h = 3): number[] {
    const root = scene.children.find((o) => o instanceof THREE.Group) as THREE.Group;
    const piles = root.children.find(
      (o) => o instanceof THREE.Group && Math.abs(o.position.z - (h / 2 + 0.3)) < 1e-6,
    ) as THREE.Group | undefined;
    if (!piles) return [];
    const clusters: number[][] = [];
    for (const prop of [...piles.children].sort((a, b) => a.position.x - b.position.x)) {
      const last = clusters[clusters.length - 1];
      if (last && Math.abs(prop.position.x - last[0]!) < 0.1) last.push(prop.position.x);
      else clusters.push([prop.position.x]);
    }
    return clusters.map((c) => c.reduce((a, b) => a + b, 0) / c.length);
  }

  /** Is a stack still standing on the ground it stood on before? */
  function stands(xs: number[], was: number): boolean {
    return xs.some((x) => Math.abs(x - was) < 0.05);
  }

  function castle(stock: GoodAmounts): BuildingSnap {
    return snap({ type: BuildingTypeId.storehouse, w: 3, h: 3, stock });
  }

  it('leaves the stacks already standing where they are when a new good arrives', () => {
    const { sync, scene } = makeSync();
    // A castle, so the goods are free to be anything: wood first...
    sync.update([castle({ [GoodId.wood]: 4 })]);
    const first = stackXs(scene);
    expect(first.length).toBe(1);

    // ...then stone lands beside it. Before lanes, the row was centred on
    // however many kinds it held, so this second kind shoved the wood half
    // a lane sideways — piles sliding for goods nobody had touched.
    sync.update([castle({ [GoodId.wood]: 4, [GoodId.stone]: 2 })]);
    const second = stackXs(scene);
    expect(second.length).toBe(2);
    expect(stands(second, first[0]!)).toBe(true);

    // A third kind flanks the other way, and still nothing moves.
    sync.update([castle({ [GoodId.wood]: 4, [GoodId.stone]: 2, [GoodId.iron]: 1 })]);
    const third = stackXs(scene);
    expect(third.length).toBe(3);
    for (const x of second) expect(stands(third, x)).toBe(true);
  });

  it('holds a stack still while its own count moves', () => {
    const { sync, scene } = makeSync();
    sync.update([castle({ [GoodId.wood]: 2, [GoodId.stone]: 3 })]);
    const before = stackXs(scene);
    // A carrier takes a plank off the stack: the goods that remain keep
    // their ground.
    sync.update([castle({ [GoodId.wood]: 1, [GoodId.stone]: 3 })]);
    const after = stackXs(scene);
    expect(after.length).toBe(2);
    for (const x of before) expect(stands(after, x)).toBe(true);
  });

  it('hands a drained good its lane back for the next arrival', () => {
    const { sync, scene } = makeSync();
    sync.update([castle({ [GoodId.wood]: 2, [GoodId.stone]: 2 })]);
    const both = stackXs(scene);
    // The wood goes out the door entirely, and its lane empties.
    sync.update([castle({ [GoodId.stone]: 2 })]);
    const alone = stackXs(scene);
    expect(alone.length).toBe(1);
    expect(stands(both, alone[0]!)).toBe(true);
    // Iron arrives: it takes the freed lane rather than opening a third one
    // past the stone, and the stone still has not moved.
    const refilled = (sync.update([castle({ [GoodId.stone]: 2, [GoodId.iron]: 3 })]), stackXs(scene));
    expect(refilled.length).toBe(2);
    for (const x of both) expect(stands(refilled, x)).toBe(true);
  });

  it('stands a lone good squarely at the door', () => {
    const { sync, scene } = makeSync();
    sync.update([castle({ [GoodId.wood]: 3 })]);
    // Lane 0, jitter aside.
    expect(Math.abs(stackXs(scene)[0]!)).toBeLessThan(0.05);
  });
});
