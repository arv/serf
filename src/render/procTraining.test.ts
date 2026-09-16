import * as THREE from 'three';
import {describe, expect, it} from 'vitest';
import {
  harvestTrainingRig,
  makeWindowGlows,
  ownTrainingMaterials,
  setTrainingLevel,
} from './procTraining';

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
    expect(glows.children.length).toBe(2);

    // Each pane stands a hair PROUD of its own void, along that void's own
    // normal — the whole point of reading the facing rather than assuming
    // one. The east window's standoff is in x, the front one's in z.
    const [a, b] = glows.children as THREE.Mesh[];
    const frontPane = [a!, b!].find(p => p.position.z > 0.5)!;
    const sidePane = [a!, b!].find(p => p.position.x > 0.5)!;
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
  });

  it('lights at level one, and breathes rather than strobing', () => {
    const rig = harvestTrainingRig(rigged())!;
    ownTrainingMaterials(rig);
    let low = Infinity;
    let high = -Infinity;
    for (let i = 0; i < 80; i++) {
      setTrainingLevel(rig, 1, i * 0.1);
      const pane = rig.panes[0]!;
      expect(pane.visible).toBe(true);
      const o = (pane.material as THREE.MeshBasicMaterial).opacity;
      low = Math.min(low, o);
      high = Math.max(high, o);
    }
    // A lamp behind a shutter: it moves, and it never comes close to out.
    expect(low).toBeGreaterThan(0.7);
    expect(high - low).toBeGreaterThan(0.05);
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
    const a = harvestTrainingRig(rigged())!;
    const b = harvestTrainingRig(rigged())!;
    // Two rigs off two models already differ; the clone is what matters
    // when both come off ONE shared template, which is how the renderer
    // builds them (Object3D.clone shares materials).
    ownTrainingMaterials(a);
    ownTrainingMaterials(b);
    setTrainingLevel(a, 1, 3);
    setTrainingLevel(b, 0, 3);
    expect(
      (a.panes[0]!.material as THREE.MeshBasicMaterial).opacity,
    ).toBeGreaterThan(0.5);
    expect(a.panes[0]!.material).not.toBe(b.panes[0]!.material);
  });

  it('is nothing at all on a building with no openings', () => {
    const plain = new THREE.Group();
    plain.add(wallPlate(1, 1));
    expect(harvestTrainingRig(plain)).toBeNull();
  });
});
