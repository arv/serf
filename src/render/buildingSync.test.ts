import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { TILE_COUNT } from '../shared/grid';
import { HeightField } from './heightField';
import type { BuildingSnap } from '../protocol/messages';

// The KayKit buildings carry material *arrays* on their meshes (the textured
// group plus the team-color group). The real loader needs GLB files, so mock
// the surface this import graph touches and hand update() a synthetic model
// of the same shape.
vi.mock('./assets', () => ({
  glbCarryProp: () => null,
  makeGlbBuilding: (type: string) => {
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
    if (type === 'fishery') {
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
    return group;
  },
}));

const { makeShoal } = await import('./procParts');

const { BuildingSync } = await import('./buildingSync');

function snap(over: Partial<BuildingSnap>): BuildingSnap {
  return {
    id: 7,
    type: 'woodcutter',
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
  const sync = new BuildingSync(scene, new HeightField(new Float32Array(TILE_COUNT)), 0);
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
    sync.update([snap({ type: 'fishery', w: 3, h: 3, facing: 2 })]);
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
    sync.update([snap({ type: 'fishery', w: 3, h: 3, facing: 2 })]);
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
    sync.update([snap({ type: 'fishery', w: 3, h: 3, facing: 1, state: 'site', siteNeeds: {} })]);
    expect(sync.fisheryPiers().length).toBe(0);
  });
});

describe("the fishery's shoal", () => {
  it('swims nose-first, whichever way round its circle it goes', () => {
    const { sync, scene } = makeSync();
    sync.update([snap({ type: 'fishery', staffing: 'staffed' })]);
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
