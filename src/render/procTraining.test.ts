import * as THREE from 'three';
import {describe, expect, it} from 'vitest';
import {
  harvestTrainingRig,
  makeArrowLane,
  makeBrazier,
  makeMusterBanner,
  makePell,
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

describe('the training rig', () => {
  /** One building's worth of cue: windows, a fire, a banner and a pell. */
  function rigged(): THREE.Group {
    const model = new THREE.Group();
    const window_ = voidPlate(0.2, 0.3);
    window_.position.set(0, 0.5, 0.6);
    model.add(window_);
    const glows = makeWindowGlows(model)!;
    model.add(glows);
    model.add(makeBrazier(), makeMusterBanner(), makePell());
    model.add(
      makeArrowLane([
        {from: [0.4, 0.2, 0], to: [-0.4, 0.2, 0]},
        {from: [0.4, 0.5, 0], to: [-0.4, 0.5, 0]},
      ]),
    );
    return model;
  }

  it('is dark and struck at level zero', () => {
    const rig = harvestTrainingRig(rigged())!;
    setTrainingLevel(rig, 0, 3);
    for (const pane of rig.panes) expect(pane.visible).toBe(false);
    for (const coals of rig.coals) expect(coals.visible).toBe(false);
    for (const arrow of rig.arrows) expect(arrow.visible).toBe(false);
    // The pole stays standing — only what flies from it comes down.
    expect(rig.hoist!.position.y).toBeLessThan(0.1);
    expect(rig.pell!.rotation.x).toBe(0);
  });

  it('lights up, runs the banner up and rocks the pell at level one', () => {
    const rig = harvestTrainingRig(rigged())!;
    const struck = rig.hoist!.position.y;
    setTrainingLevel(rig, 1, 3);
    for (const pane of rig.panes) {
      expect(pane.visible).toBe(true);
      expect(
        (pane.material as THREE.MeshBasicMaterial).opacity,
      ).toBeGreaterThan(0.5);
    }
    for (const flames of rig.flames) {
      expect(flames.visible).toBe(true);
      for (const tongue of flames.children) expect(tongue.visible).toBe(true);
    }
    expect(rig.hoist!.position.y).toBeGreaterThan(struck + 0.2);
    // The pell is struck on a beat, so SOME moment in the beat must move it.
    let swung = 0;
    for (let i = 0; i < 40; i++) {
      setTrainingLevel(rig, 1, i * 0.05);
      swung = Math.max(swung, Math.abs(rig.pell!.rotation.x));
    }
    expect(swung).toBeGreaterThan(0.01);
  });

  it('flies each arrow down its own line and pulls it out again', () => {
    const rig = harvestTrainingRig(rigged())!;
    const arrow = rig.arrows[0]!;
    let seenFlying = false;
    let seenStuck = false;
    let seenGone = false;
    let minX = Infinity;
    let maxX = -Infinity;
    for (let i = 0; i < 200; i++) {
      setTrainingLevel(rig, 1, i * 0.05);
      if (!arrow.visible) {
        seenGone = true;
        continue;
      }
      minX = Math.min(minX, arrow.position.x);
      maxX = Math.max(maxX, arrow.position.x);
      if (arrow.position.x > 0.2) seenFlying = true;
      if (arrow.position.x < -0.35) seenStuck = true;
    }
    expect(seenFlying).toBe(true);
    expect(seenStuck).toBe(true);
    expect(seenGone).toBe(true);
    // It never overshoots the straw, and never starts behind the mark.
    expect(minX).toBeGreaterThanOrEqual(-0.4001);
    expect(maxX).toBeLessThanOrEqual(0.4001);
  });

  it('gives each building its own fire to burn', () => {
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

  it('is nothing at all on a building that does not train', () => {
    const plain = new THREE.Group();
    plain.add(wallPlate(1, 1));
    expect(harvestTrainingRig(plain)).toBeNull();
  });
});
