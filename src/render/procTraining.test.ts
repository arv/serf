import * as THREE from 'three';
import {describe, expect, it} from 'vitest';
import {
  harvestTrainingRig,
  makeWindowGlows,
  ownTrainingMaterials,
  setTrainingLevel,
} from './procTraining';

/** A slab of masonry facing +z, for an opening to be cut into. Big enough
 * that the spill around a window has wall to land on. */
function wall(w: number, h: number, z: number): THREE.Mesh {
  const m = wallPlate(w, h);
  m.position.set(0, 0.5, z);
  return m;
}

/**
 * A wall plate painted from the atlas cell the packs back their window and
 * door openings with — the paint `makeWindowGlows` finds a building's
 * openings by. `u` lands in column 3 and `v` in row 0 of the 8x4 grid,
 * which is what the finder tests.
 */
function voidPlate(w: number, h: number): THREE.Mesh {
  const geo = new THREE.PlaneGeometry(w, h);
  const uv = geo.getAttribute('uv');
  for (let i = 0; i < uv.count; i++) uv.setXY(i, 0.44, 0.1);
  return new THREE.Mesh(geo, new THREE.MeshLambertMaterial());
}

/** The same plate painted anywhere else — masonry, cell (0,2). */
function wallPlate(w: number, h: number): THREE.Mesh {
  const geo = new THREE.PlaneGeometry(w, h);
  const uv = geo.getAttribute('uv');
  for (let i = 0; i < uv.count; i++) uv.setXY(i, 0.3, 0.1);
  return new THREE.Mesh(geo, new THREE.MeshLambertMaterial());
}

describe('finding a building’s windows', () => {
  it('hangs one pane in each opening, facing the way the opening does', () => {
    const model = new THREE.Group();
    const front = voidPlate(0.2, 0.3);
    front.position.set(0, 0.5, 0.6);
    const side = voidPlate(0.2, 0.3);
    side.position.set(0.6, 0.5, 0);
    side.rotation.y = Math.PI / 2;
    model.add(front, side);

    const glows = makeWindowGlows(model)!;
    // A pane and a spill apiece.
    const panes = glows.children.filter(
      o => o.name === 'windowPane',
    ) as THREE.Mesh[];
    expect(panes.length).toBe(2);
    expect(glows.children.filter(o => o.name === 'windowSpill').length).toBe(2);

    // Each pane stands a hair PROUD of its own void, along that void's own
    // normal — the whole point of reading the facing rather than assuming
    // one. The east window's standoff is in x, the front one's in z.
    const frontPane = panes.find(p => p.position.z > 0.5)!;
    const sidePane = panes.find(p => p.position.x > 0.5)!;
    expect(frontPane.position.z).toBeGreaterThan(0.6);
    expect(frontPane.position.z).toBeLessThan(0.62);
    expect(sidePane.position.x).toBeGreaterThan(0.6);
    expect(sidePane.position.x).toBeLessThan(0.62);

    // And each is cut a little inside its opening, so the frame the pack
    // modelled around it still reads as a frame.
    const size = new THREE.Box3()
      .setFromObject(frontPane)
      .getSize(new THREE.Vector3());
    expect(size.x).toBeGreaterThan(0.1);
    expect(size.x).toBeLessThan(0.2);
    expect(size.y).toBeLessThan(0.3);
  });

  it('keeps an opening whose paint runs to the far edge of the atlas', () => {
    // A UV of exactly 1.0 floors to column 8 / row 4 — one past the 8x4
    // grid — and an unclamped lookup matches no cell at all, so the opening
    // vanishes without a word. assets.ts' atlasCell clamps for this reason
    // and so does the finder. None of today's models reaches 1.0 (they top
    // out at u 0.857, v 0.971), which is exactly why it wants a test.
    const model = new THREE.Group();
    const opening = voidPlate(0.2, 0.3);
    const uv = opening.geometry.getAttribute('uv');
    // The last cell of the grid, painted right up to its outer corner.
    for (let i = 0; i < uv.count; i++) uv.setXY(i, 1, 1);
    opening.position.set(0, 0.5, 0.6);
    model.add(opening);
    const glows = makeWindowGlows(model, [{cell: [3, 7]}]);
    expect(glows).not.toBeNull();
    expect(glows!.children.filter(o => o.name === 'windowPane').length).toBe(1);
  });

  it('leaves the masonry alone, and the flat dark the roofs wear', () => {
    const model = new THREE.Group();
    const wall = wallPlate(0.4, 0.4);
    wall.position.z = 0.6;
    // The same void paint lying flat — an eave's underside, not a window.
    const eave = voidPlate(0.4, 0.4);
    eave.rotation.x = -Math.PI / 2;
    eave.position.y = 1;
    model.add(wall, eave);
    expect(makeWindowGlows(model)).toBeNull();
  });
});

describe('the lit windows', () => {
  /** One building's worth of cue: a wall with an opening in it, lit. */
  function rigged(): THREE.Group {
    const model = new THREE.Group();
    const opening = voidPlate(0.2, 0.3);
    opening.position.set(0, 0.5, 0.6);
    model.add(opening);
    model.add(makeWindowGlows(model)!);
    return model;
  }

  it('is dark at level zero', () => {
    const rig = harvestTrainingRig(rigged())!;
    setTrainingLevel(rig, 0, 3);
    for (const pane of rig.panes) expect(pane.visible).toBe(false);
    for (const spill of rig.spills) expect(spill.visible).toBe(false);
  });

  it('breathes like a distant flame: alive, slow, never near out', () => {
    const rig = harvestTrainingRig(rigged())!;
    ownTrainingMaterials(rig);
    let low = Infinity;
    let high = -Infinity;
    let biggestStep = 0;
    let last = -1;
    // Twenty seconds at sixty frames, which is long enough for the four
    // beats the flicker is built from to drift right through each other.
    for (let i = 0; i < 1200; i++) {
      setTrainingLevel(rig, 1, i / 60);
      const pane = rig.panes[0]!;
      expect(pane.visible).toBe(true);
      const o = (pane.material as THREE.MeshBasicMaterial).opacity;
      low = Math.min(low, o);
      high = Math.max(high, o);
      if (last >= 0) biggestStep = Math.max(biggestStep, Math.abs(o - last));
      last = o;
    }
    // A fire, not a bulb: it moves...
    expect(high - low).toBeGreaterThan(0.15);
    // ...but never near out, because a dark window means the course
    // stopped, which is the one thing this cue is for.
    expect(low).toBeGreaterThan(0.65);
    // And it is SLOW. This is the bound that matters: a dozen windows on
    // the screen guttering at a flame's real speed read as blinking, which
    // is what the first cut did. Nothing here moves fast enough to catch
    // the eye — at sixty frames a second, under a hundredth of its range
    // per frame.
    expect(biggestStep).toBeLessThan(0.01);
  });

  it('gives every window its own flame, out of step with its neighbours', () => {
    const model = new THREE.Group();
    for (const x of [-0.4, 0, 0.4]) {
      const opening = voidPlate(0.1, 0.2);
      opening.position.set(x, 0.5, 0.6);
      model.add(opening);
    }
    model.add(wall(1.4, 1, 0.55));
    model.add(makeWindowGlows(model)!);
    const rig = harvestTrainingRig(model)!;
    ownTrainingMaterials(rig);
    expect(rig.panes.length).toBe(3);
    setTrainingLevel(rig, 1, 4.2);
    const lit = rig.panes.map(
      p => (p.material as THREE.MeshBasicMaterial).opacity,
    );
    // Three lamps in one hall, no two of them at the same brightness.
    expect(new Set(lit.map(o => o.toFixed(3))).size).toBe(3);
  });

  it('lights the spill under each pane, and keeps it the quieter of the two', () => {
    const rig = harvestTrainingRig(rigged())!;
    ownTrainingMaterials(rig);
    setTrainingLevel(rig, 1, 3);
    expect(rig.spills.length).toBe(rig.panes.length);
    const pane = (rig.panes[0]!.material as THREE.MeshBasicMaterial).opacity;
    const spill = (rig.spills[0]!.material as THREE.MeshBasicMaterial).opacity;
    expect(rig.spills[0]!.visible).toBe(true);
    expect(spill).toBeGreaterThan(0);
    expect(spill).toBeLessThan(pane);
  });

  it('stands the spill out on the wall, not down inside the recess', () => {
    // The opening is set back into the masonry; a spill hung off the plate
    // has its edges inside the stone, where the depth test eats them. It
    // has to come out to the face.
    const model = new THREE.Group();
    const opening = voidPlate(0.1, 0.2);
    opening.position.set(0, 0.5, 0.6);
    model.add(opening, wall(1, 1, 0.66));
    model.add(makeWindowGlows(model)!);
    const rig = harvestTrainingRig(model)!;
    expect(rig.spills[0]!.position.z).toBeGreaterThan(0.66);
    expect(rig.panes[0]!.position.z).toBeLessThan(0.66);
  });

  it('keeps the spill on the wall it has, not off the end of it', () => {
    // A window in a narrow face — a castle tower — must not throw a halo
    // wider than the stone it is cut into, or the overhang hangs in the
    // air beside the building and is seen as a bright sliver.
    const narrow = new THREE.Group();
    const opening = voidPlate(0.1, 0.2);
    opening.position.set(0, 0.5, 0.6);
    narrow.add(opening, wall(0.1, 1, 0.66));
    narrow.add(makeWindowGlows(narrow)!);
    const tight = harvestTrainingRig(narrow)!.spills[0]!;
    const tightW = new THREE.Box3()
      .setFromObject(tight)
      .getSize(new THREE.Vector3()).x;
    // The stone is 0.1 across, so the light on it is too.
    expect(tightW).toBeLessThanOrEqual(0.105);

    // ...while the same window in a broad wall spills as far as authored.
    const broad = new THREE.Group();
    const opening2 = voidPlate(0.1, 0.2);
    opening2.position.set(0, 0.5, 0.6);
    broad.add(opening2, wall(1.4, 1, 0.66));
    broad.add(makeWindowGlows(broad)!);
    const wide = harvestTrainingRig(broad)!.spills[0]!;
    const wideW = new THREE.Box3()
      .setFromObject(wide)
      .getSize(new THREE.Vector3()).x;
    expect(wideW).toBeGreaterThan(tightW * 1.5);
  });

  it('dims with the level rather than snapping off', () => {
    const rig = harvestTrainingRig(rigged())!;
    ownTrainingMaterials(rig);
    setTrainingLevel(rig, 1, 3);
    const full = (rig.panes[0]!.material as THREE.MeshBasicMaterial).opacity;
    setTrainingLevel(rig, 0.4, 3);
    const banked = (rig.panes[0]!.material as THREE.MeshBasicMaterial).opacity;
    expect(banked).toBeLessThan(full);
    expect(banked).toBeGreaterThan(0);
  });

  it('gives each building its own light to burn', () => {
    // Off ONE template, cloned — which is how the renderer builds two
    // barracks (makeGlbBuilding clones the shared template, and
    // Object3D.clone shares the materials). Two separately built models
    // would have separate materials already and this would pass with
    // ownTrainingMaterials deleted, which is the whole thing it is here to
    // catch.
    const template = rigged();
    const a = harvestTrainingRig(template.clone())!;
    const b = harvestTrainingRig(template.clone())!;
    expect(a.panes[0]!.material).toBe(b.panes[0]!.material); // shared, so far

    ownTrainingMaterials(a);
    ownTrainingMaterials(b);
    expect(a.panes[0]!.material).not.toBe(b.panes[0]!.material);

    // And the point of that: one hall lit, its neighbour dark.
    setTrainingLevel(a, 1, 3);
    setTrainingLevel(b, 0, 3);
    expect(
      (a.panes[0]!.material as THREE.MeshBasicMaterial).opacity,
    ).toBeGreaterThan(0.5);
    expect(b.panes[0]!.visible).toBe(false);
  });

  it('is nothing at all on a building with no openings', () => {
    const plain = new THREE.Group();
    plain.add(wallPlate(1, 1));
    expect(harvestTrainingRig(plain)).toBeNull();
  });
});
