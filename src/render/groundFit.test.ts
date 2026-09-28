import * as THREE from 'three';
import {describe, expect, it} from 'vitest';
import {tileIdx} from '../shared/grid';
import * as BuildingTypeId from '../sim/defs/buildingTypeIdEnum.ts';
import {
  anchorGround,
  downhillFacing,
  fitsGround,
  fitToGround,
  GROUND_ANCHOR,
  GROUND_FIT,
  modelFacing,
  releaseFit,
  seatOnGround,
  tessellate,
} from './groundFit';
import {HeightField} from './heightField';

const SIZE = 24;

/** A height field that is exactly the plane h = a + gx x + gz z at every
 * tile centre — and so, bilinear being exact on a plane, everywhere. */
function plane(a: number, gx: number, gz: number): HeightField {
  const h = new Float32Array(SIZE * SIZE);
  for (let z = 0; z < SIZE; z++) {
    for (let x = 0; x < SIZE; x++) {
      h[tileIdx(x, z, SIZE)] = a + gx * (x + 0.5) + gz * (z + 0.5);
    }
  }
  return new HeightField(h, SIZE);
}

/** World positions of a mesh's vertices, as drawn. */
function worldVerts(mesh: THREE.Mesh): THREE.Vector3[] {
  mesh.updateWorldMatrix(true, false);
  const pos = (mesh.geometry as THREE.BufferGeometry).getAttribute('position');
  const out: THREE.Vector3[] = [];
  for (let i = 0; i < pos.count; i++) {
    out.push(
      new THREE.Vector3()
        .fromBufferAttribute(pos, i)
        .applyMatrix4(mesh.matrixWorld),
    );
  }
  return out;
}

/** A root at (12, baseY, 12) with the model under it. */
function stand(model: THREE.Object3D, baseY: number): THREE.Group {
  const root = new THREE.Group();
  root.position.set(12, baseY, 12);
  root.add(model);
  return root;
}

describe('downhillFacing', () => {
  it('points the front at the lowest edge', () => {
    // Ground falling toward +z: the authored front already faces downhill.
    expect(downhillFacing(plane(5, 0, -0.3), 10, 10, 2, 2)).toBe(0);
    expect(downhillFacing(plane(5, -0.3, 0), 10, 10, 2, 2)).toBe(1);
    expect(downhillFacing(plane(5, 0, 0.3), 10, 10, 2, 2)).toBe(2);
    expect(downhillFacing(plane(5, 0.3, 0), 10, 10, 2, 2)).toBe(3);
  });

  it('keeps the authored front on level ground', () => {
    expect(downhillFacing(plane(1, 0, 0), 10, 10, 2, 2)).toBe(0);
  });

  it('turns only mines; everything else keeps the sim facing', () => {
    const h = plane(5, 0.3, 0);
    expect(
      modelFacing(BuildingTypeId.goldMine, 10, 10, 2, 2, undefined, h),
    ).toBe(3);
    expect(modelFacing(BuildingTypeId.quarry, 10, 10, 2, 2, undefined, h)).toBe(
      0,
    );
    expect(modelFacing(BuildingTypeId.fishery, 10, 10, 2, 2, 2, h)).toBe(2);
  });
});

describe('fitsGround', () => {
  it('leaves shore buildings, roads and salvage alone', () => {
    expect(fitsGround(BuildingTypeId.wheatFarm)).toBe(true);
    expect(fitsGround(BuildingTypeId.ironMine)).toBe(true);
    expect(fitsGround(BuildingTypeId.fishery)).toBe(false);
    expect(fitsGround(BuildingTypeId.salvage)).toBe(false);
  });
});

describe('anchorGround', () => {
  it('reads the ground at the anchor mark, turned with the model', () => {
    const h = plane(2, 0.1, 0);
    const model = new THREE.Group();
    const mark = new THREE.Group();
    mark.name = GROUND_ANCHOR;
    mark.position.set(0, 0, 1);
    model.add(mark);
    const root = stand(model, 0);
    expect(anchorGround(root, model, 1, h)).toBeCloseTo(h.at(12, 13));
    // A quarter turn swings the door from +z round to +x.
    model.rotation.y = Math.PI / 2;
    expect(anchorGround(root, model, 1, h)).toBeCloseTo(h.at(13, 12));
  });

  it('falls back to just inside the front edge', () => {
    const h = plane(2, 0, 0.1);
    const model = new THREE.Group();
    const root = stand(model, 0);
    expect(anchorGround(root, model, 1.5, h)).toBeCloseTo(h.at(12, 13.2));
  });
});

describe('fitToGround', () => {
  it('drapes a tagged part over the ground, vertex by vertex', () => {
    const h = plane(2, 0.2, -0.1);
    const pad = new THREE.Mesh(
      new THREE.PlaneGeometry(3, 3).rotateX(-Math.PI / 2),
    );
    pad.userData[GROUND_FIT] = 'drape';
    const model = new THREE.Group();
    model.add(pad);
    const baseY = h.at(12, 12);
    stand(model, baseY);
    fitToGround(model, h, baseY);
    const verts = worldVerts(pad);
    // Tessellated so it can follow ground that is not a plane.
    expect(verts.length).toBeGreaterThan(4);
    for (const v of verts) expect(v.y).toBeCloseTo(h.at(v.x, v.z), 5);
  });

  it('turns a draped surface to face up its slope, in the model the fit is under', () => {
    const h = plane(2, 0.2, -0.1);
    const pad = new THREE.Mesh(
      new THREE.PlaneGeometry(3, 3).rotateX(-Math.PI / 2),
    );
    pad.userData[GROUND_FIT] = 'drape';
    const model = new THREE.Group();
    // Turned and scaled like a real template, so the normals have to go to
    // world space and back to be right.
    model.rotation.y = Math.PI / 2;
    model.scale.setScalar(1.5);
    model.add(pad);
    const baseY = h.at(12, 12);
    stand(model, baseY);
    fitToGround(model, h, baseY);
    pad.updateWorldMatrix(true, false);
    const toWorld = new THREE.Matrix3().getNormalMatrix(pad.matrixWorld);
    const want = new THREE.Vector3(-0.2, 1, 0.1).normalize();
    const nrm = (pad.geometry as THREE.BufferGeometry).getAttribute('normal');
    for (let i = 0; i < nrm.count; i++) {
      const n = new THREE.Vector3()
        .fromBufferAttribute(nrm, i)
        .applyMatrix3(toWorld)
        .normalize();
      expect(n.x).toBeCloseTo(want.x, 4);
      expect(n.y).toBeCloseTo(want.y, 4);
      expect(n.z).toBeCloseTo(want.z, 4);
    }
  });

  it('owns its normals and borrows everything else from the template', () => {
    const h = plane(3, -0.2, 0);
    const geo = new THREE.BoxGeometry(2, 2, 2).translate(0, 1, 0);
    const box = new THREE.Mesh(geo);
    const model = new THREE.Group();
    model.add(box);
    const baseY = h.at(12, 12);
    stand(model, baseY);
    fitToGround(model, h, baseY);
    const fitted = box.geometry as THREE.BufferGeometry;
    expect(fitted).not.toBe(geo);
    expect(fitted.getAttribute('normal')).not.toBe(geo.getAttribute('normal'));
    expect(fitted.getAttribute('uv')).toBe(geo.getAttribute('uv'));
    expect(fitted.getIndex()).toBe(geo.getIndex());
    // A wall the bend only stretches stays facing exactly where it faced.
    const before = geo.getAttribute('normal');
    const after = fitted.getAttribute('normal');
    for (let i = 0; i < before.count; i++) {
      if (Math.abs(before.getY(i)) > 0.5) continue; // walls only
      expect(after.getX(i)).toBeCloseTo(before.getX(i), 6);
      expect(after.getY(i)).toBeCloseTo(before.getY(i), 6);
      expect(after.getZ(i)).toBeCloseTo(before.getZ(i), 6);
    }
    // Freed on release; the template's own buffers are left alone.
    let freed = 0;
    fitted.addEventListener('dispose', () => freed++);
    releaseFit(model);
    expect(freed).toBe(1);
    expect(box.geometry).toBe(geo);
    expect(geo.getAttribute('normal')).toBe(before);
    expect(geo.getAttribute('uv')).toBeDefined();
    expect(geo.getIndex()).not.toBeNull();
    // Only the fit's own buffers were on the geometry when it was freed.
    expect(Object.keys(fitted.attributes).sort()).toEqual([
      'normal',
      'position',
    ]);
    expect(fitted.getIndex()).toBeNull();
  });

  it("stretches a building's base down to falling ground and never lifts it", () => {
    // Ground falls toward +x: the -x wall is dug in, the +x wall hangs.
    const h = plane(3, -0.2, 0);
    const box = new THREE.Mesh(
      new THREE.BoxGeometry(2, 2, 2).translate(0, 1, 0),
    );
    const model = new THREE.Group();
    model.add(box);
    const baseY = h.at(12, 12);
    stand(model, baseY);
    fitToGround(model, h, baseY);
    for (const v of worldVerts(box)) {
      const rest = v.y > baseY + 1 ? baseY + 2 : baseY; // top or bottom
      if (rest === baseY + 2) {
        // The roof line stays level.
        expect(v.y).toBeCloseTo(baseY + 2, 5);
      } else if (v.x > 12) {
        // Downhill: the base reaches the ground.
        expect(v.y).toBeCloseTo(h.at(v.x, v.z), 5);
      } else {
        // Uphill: left where it was, under the grass.
        expect(v.y).toBeCloseTo(baseY, 5);
      }
    }
  });

  it('lifts a footed part to the ground at its centre and bends only its feet', () => {
    const h = plane(1, 0, 0.25);
    const frame = new THREE.Mesh(
      new THREE.BoxGeometry(0.4, 1, 0.4).translate(0, 0.5, 0),
    );
    const part = new THREE.Group();
    part.userData[GROUND_FIT] = 'foot';
    part.position.set(0.5, 0, 1);
    part.add(frame);
    const model = new THREE.Group();
    model.add(part);
    const baseY = h.at(12, 12);
    stand(model, baseY);
    fitToGround(model, h, baseY);
    const pivot = h.at(12.5, 13);
    for (const v of worldVerts(frame)) {
      if (v.y > pivot + 0.5) expect(v.y).toBeCloseTo(pivot + 1, 5);
      else expect(v.y).toBeCloseTo(h.at(v.x, v.z), 5);
    }
  });

  it('refits from the template, and releaseFit puts the template back', () => {
    const geo = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
    const mesh = new THREE.Mesh(geo);
    mesh.userData[GROUND_FIT] = 'foot';
    const model = new THREE.Group();
    model.add(mesh);
    const root = stand(model, 0);
    const h = plane(1, 0, 0.2);
    fitToGround(model, h, 0);
    const once = worldVerts(mesh).map(v => v.y);
    // A preview re-fitted where it stands must not bend twice.
    fitToGround(model, h, 0);
    expect(worldVerts(mesh).map(v => v.y)).toEqual(once);
    expect(mesh.geometry).not.toBe(geo);
    expect(geo.getAttribute('position').getY(0)).toBeCloseTo(
      new THREE.BoxGeometry(1, 1, 1)
        .translate(0, 0.5, 0)
        .getAttribute('position')
        .getY(0),
    );
    releaseFit(model);
    expect(mesh.geometry).toBe(geo);
    // On level ground at the root's own height nothing bends, and the
    // template is drawn as it is.
    root.position.y = 1;
    fitToGround(model, plane(1, 0, 0), 1);
    expect(mesh.geometry).toBe(geo);
  });
});

describe('seatOnGround', () => {
  it('stands a stack on the lowest ground under it', () => {
    const h = plane(2, 0.3, 0);
    const stack = new THREE.Mesh(
      new THREE.BoxGeometry(1, 0.5, 1).translate(0, 0.25, 0),
    );
    const root = new THREE.Group();
    root.position.set(12, h.at(12, 12), 12);
    root.add(stack);
    seatOnGround(stack, h);
    const box = new THREE.Box3().setFromObject(stack);
    expect(box.min.y).toBeCloseTo(h.at(11.5, 12), 5);
  });
});

describe('tessellate', () => {
  it('cuts every edge down to size and keeps the material groups', () => {
    const geo = new THREE.BoxGeometry(2, 0.1, 0.1);
    const out = tessellate(geo, 0.25);
    const pos = out.getAttribute('position');
    for (let i = 0; i < pos.count; i += 3) {
      const a = new THREE.Vector3().fromBufferAttribute(pos, i);
      const b = new THREE.Vector3().fromBufferAttribute(pos, i + 1);
      const c = new THREE.Vector3().fromBufferAttribute(pos, i + 2);
      expect(
        Math.max(a.distanceTo(b), b.distanceTo(c), c.distanceTo(a)),
      ).toBeLessThanOrEqual(0.25 + 1e-6);
    }
    expect(out.groups.map(g => g.materialIndex)).toEqual(
      geo.groups.map(g => g.materialIndex),
    );
    expect(out.groups.reduce((n, g) => n + g.count, 0)).toBe(pos.count);
    // Cached: every instance of a template shares one cut.
    expect(tessellate(geo, 0.25)).toBe(out);
  });
});
