import * as THREE from 'three';
import {describe, expect, it, vi} from 'vitest';
import {DEFAULT_MAP_SIZE, tileCount, tileIdx} from '../shared/grid';
import * as BuildingTypeId from '../sim/defs/buildingTypeIdEnum.ts';
import {WATER_LEVEL, type MapView} from '../sim/map';
import * as Terrain from '../sim/terrainEnum.ts';
import {HeightField} from './heightField';
import type {PierInfo} from './pierFit';

// The same stand-in the built fishery's tests use (buildingSync.test.ts):
// the real models are GLB, and all the aim needs is a named deck running out
// of the front face — a plank box reaching 3.35 out of the pier's own origin.
vi.mock('./assets', () => ({
  glbCarryProp: () => null,
  glbPropAtScale: () => null,
  hasGlbProp: () => false,
  makeGlbBuilding: (type: number) => {
    const group = new THREE.Group();
    group.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1)));
    if (type === BuildingTypeId.fishery) {
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

const {GhostPlacement} = await import('./ghost');

/** The far end of the authored deck, in the pier's own units. */
const DECK_END = 3.35;

/** Dry ground at 0.1, a bed at -1 wherever `water` says so — the shore the
 * fit reads, since it asks the height field rather than the tile grid. */
function shoreHeights(water: (tx: number, tz: number) => boolean): HeightField {
  const h = new Float32Array(tileCount(DEFAULT_MAP_SIZE)).fill(0.1);
  for (let tz = 0; tz < DEFAULT_MAP_SIZE; tz++)
    for (let tx = 0; tx < DEFAULT_MAP_SIZE; tx++)
      if (water(tx, tz)) h[tileIdx(tx, tz, DEFAULT_MAP_SIZE)] = -1;
  return new HeightField(h, DEFAULT_MAP_SIZE);
}

/** The same shore as tiles, which is what decides the hut's quarter turn:
 * the ghost asks the sim's own waterFacing, so the preview starts where the
 * placed building would. */
function shoreMap(water: (tx: number, tz: number) => boolean): MapView {
  const terrain = new Uint8Array(tileCount(DEFAULT_MAP_SIZE)).fill(
    Terrain.Grass,
  );
  for (let tz = 0; tz < DEFAULT_MAP_SIZE; tz++)
    for (let tx = 0; tx < DEFAULT_MAP_SIZE; tx++)
      if (water(tx, tz))
        terrain[tileIdx(tx, tz, DEFAULT_MAP_SIZE)] = Terrain.Water;
  return {
    size: DEFAULT_MAP_SIZE,
    play: DEFAULT_MAP_SIZE,
    terrain,
  } as unknown as MapView;
}

interface Shore {
  ghost: InstanceType<typeof GhostPlacement>;
  scene: THREE.Scene;
  heights: HeightField;
}

function shore(
  water: (tx: number, tz: number) => boolean,
  standing: readonly PierInfo[] | (() => readonly PierInfo[]) = [],
): Shore {
  const scene = new THREE.Scene();
  const heights = shoreHeights(water);
  const ghost = new GhostPlacement(scene, heights, shoreMap(water), () =>
    typeof standing === 'function' ? standing() : standing,
  );
  return {ghost, scene, heights};
}

/** Where the previewed deck leaves the hut, in world space. */
function deckBase(scene: THREE.Scene): THREE.Vector3 {
  scene.updateMatrixWorld(true);
  const pier = scene.getObjectByName('fisheryPier')!;
  return pier.localToWorld(new THREE.Vector3(0, 0, 0));
}

/** Where the previewed deck ends, in world space. */
function deckTip(scene: THREE.Scene): THREE.Vector3 {
  scene.updateMatrixWorld(true);
  const pier = scene.getObjectByName('fisheryPier')!;
  return pier.localToWorld(new THREE.Vector3(0, 0, DECK_END));
}

/** The model the whole hut turns with — the pier's parent, as in a built
 * fishery (BuildingSync turns the model, never the root). */
function hutYaw(scene: THREE.Scene): number {
  return scene.getObjectByName('fisheryPier')!.parent!.rotation.y;
}

describe("the fishery preview's dock", () => {
  it('turns to the water before the player commits to the spot', () => {
    // Open water north of the hut placed at (10,10).
    const {ghost, scene, heights} = shore((_tx, tz) => tz <= 9);
    ghost.show(BuildingTypeId.fishery);
    ghost.moveTo(10, 10, true);

    // Facing 2, due north: the quarter turn the sim hands the built hut.
    // Without the aim the ghost wore the model's authored facing and the
    // player lined up a dock that swung elsewhere the moment it was built.
    expect(hutYaw(scene)).toBeCloseTo(Math.PI);
    const tip = deckTip(scene);
    expect(tip.z).toBeLessThan(10);
    expect(heights.at(tip.x, tip.z)).toBeLessThan(WATER_LEVEL);
  });

  it('aims off the grid where no quarter turn reaches the shore', () => {
    // A lake off the northwest corner only: the nearest water is diagonal,
    // so the facing alone sends the deck along a grid axis and dry.
    const {ghost, scene, heights} = shore((tx, tz) => tx <= 9 && tz <= 9);
    ghost.show(BuildingTypeId.fishery);
    ghost.moveTo(10, 10, true);

    const yaw = hutYaw(scene);
    expect(Math.abs(yaw % (Math.PI / 2))).toBeGreaterThan(1e-6);
    const tip = deckTip(scene);
    expect(heights.at(tip.x, tip.z)).toBeLessThan(WATER_LEVEL);
  });

  it('re-aims from the authored deck on every tile the cursor crosses', () => {
    // A pond too small for the authored deck: it strides clean over, dry
    // on the far bank, and no turn finds more water either — so the fit
    // answers with a trim. A cursor wandering along the shore must not
    // grind the planks away a step per tile.
    const {ghost, scene} = shore(
      (tx, tz) => tx >= 10 && tx <= 11 && tz >= 8 && tz <= 9,
    );
    ghost.show(BuildingTypeId.fishery);
    ghost.moveTo(10, 10, true);
    const pier = scene.getObjectByName('fisheryPier')!;
    const trimmed = pier.scale.x;
    expect(trimmed).toBeLessThan(1);
    const tip = deckTip(scene);

    for (let i = 0; i < 5; i++) {
      ghost.moveTo(12, 10, true);
      ghost.moveTo(10, 10, true);
    }
    expect(pier.scale.x).toBeCloseTo(trimmed);
    expect(deckTip(scene).z).toBeCloseTo(tip.z);
  });

  it('steers the preview clear of a deck already standing', () => {
    // A neighbour's jetty cutting northwest across the water this hut
    // faces. Two fisheries on one bank is legal — placement only ever
    // guards footprints, and a deck hangs two tiles past its own — so the
    // preview has to show the deck the player will actually get rather
    // than one drawn through the planks already there.
    const dir = {x: Math.sin(Math.PI * 1.25), z: Math.cos(Math.PI * 1.25)};
    const neighbour: PierInfo = {
      bx: 14,
      bz: 11,
      baseX: 13.5,
      baseZ: 10.2,
      spotX: 13.5 + dir.x * 3.1,
      spotZ: 10.2 + dir.z * 3.1,
      yaw: Math.PI * 1.25,
      deckY: 0.15,
      turn: Math.PI / 4,
      scale: 1,
    };
    const nTip = {
      x: neighbour.spotX + dir.x * 0.4,
      z: neighbour.spotZ + dir.z * 0.4,
    };
    const {ghost, scene, heights} = shore((_tx, tz) => tz <= 9, [neighbour]);
    ghost.show(BuildingTypeId.fishery);
    ghost.moveTo(10, 10, true);

    // It still fishes — the aim moved, the water did not stop being water.
    const tip = deckTip(scene);
    expect(heights.at(tip.x, tip.z)).toBeLessThan(WATER_LEVEL);
    // And it stands off the neighbour along its whole run. Sampled, because
    // two decks can end far apart and still cross in the middle.
    const base = deckBase(scene);
    for (let i = 0; i <= 10; i++) {
      const t = i / 10;
      const px = base.x + (tip.x - base.x) * t;
      const pz = base.z + (tip.z - base.z) * t;
      for (let j = 0; j <= 10; j++) {
        const u = j / 10;
        const qx = neighbour.baseX + (nTip.x - neighbour.baseX) * u;
        const qz = neighbour.baseZ + (nTip.z - neighbour.baseZ) * u;
        expect(Math.hypot(px - qx, pz - qz)).toBeGreaterThan(0.5);
      }
    }
  });

  it('re-aims when a neighbour goes up under a still cursor', () => {
    // The cursor holds on one tile while somebody else's fishery is
    // finished nearby — an ally's in a match, an AI's in a skirmish. The
    // aim was fitted against the decks standing at the time, so a preview
    // that kept it would be promising a placement the yard no longer
    // makes: the tile and the verdict are unchanged, and only the
    // neighbours moved.
    const dir = {x: Math.sin(Math.PI * 1.25), z: Math.cos(Math.PI * 1.25)};
    const late: PierInfo = {
      bx: 14,
      bz: 11,
      baseX: 13.5,
      baseZ: 10.2,
      spotX: 13.5 + dir.x * 3.1,
      spotZ: 10.2 + dir.z * 3.1,
      yaw: Math.PI * 1.25,
      deckY: 0.15,
      turn: Math.PI / 4,
      scale: 1,
    };
    const standing: PierInfo[] = [];
    const {ghost, scene} = shore(
      (_tx, tz) => tz <= 9,
      () => standing,
    );
    ghost.show(BuildingTypeId.fishery);
    ghost.moveTo(10, 10, true);
    const before = deckTip(scene).clone();

    standing.push(late);
    ghost.moveTo(10, 10, true); // same tile, same verdict

    const after = deckTip(scene);
    expect(after.distanceTo(before)).toBeGreaterThan(0.3);
  });

  it('leaves a building with no dock alone', () => {
    const {ghost, scene} = shore(() => false);
    ghost.show(BuildingTypeId.woodcutter);
    ghost.moveTo(10, 10, true);
    expect(scene.getObjectByName('fisheryPier')).toBeUndefined();
  });
});
