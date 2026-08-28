import * as THREE from 'three';
import { makeLights, makeRenderer } from './scene';
import { loadGlbAssets, makeGlbBuilding } from '../../src/render/assets';
import * as BuildingTypeId from '../../src/sim/defs/buildingTypeIdEnum.ts';

/** Top-down plan of the mine template, with a unit-square grid over it, so
 * decor coordinates can be read straight off the picture. */
await loadGlbAssets();

const canvas = document.createElement('canvas');
document.body.appendChild(canvas);
const r = makeRenderer(canvas);
r.setClearColor(0x6aa63c, 1);
r.setSize(900, 900, false);
const scene = new THREE.Scene();
makeLights(scene);

const b = makeGlbBuilding(BuildingTypeId.ironMine, 1)!;
scene.add(b);

// The unit square is scaled by min(w,h)*1.06*modelScale = 2*1.06*1.2 = 2.544
const S = 2 * 1.06 * 1.2;
const grid = new THREE.Group();
for (let i = -5; i <= 5; i++) {
  const t = (i / 10) * S;
  for (const axis of [0, 1]) {
    const g = new THREE.BufferGeometry().setFromPoints(
      axis === 0
        ? [new THREE.Vector3(t, 3, -S / 2), new THREE.Vector3(t, 3, S / 2)]
        : [new THREE.Vector3(-S / 2, 3, t), new THREE.Vector3(S / 2, 3, t)],
    );
    const c = i === 0 ? (axis === 0 ? 0xff0000 : 0x0000ff) : 0x222222;
    grid.add(new THREE.Line(g, new THREE.LineBasicMaterial({ color: c })));
  }
}
scene.add(grid);

const cam = new THREE.OrthographicCamera(-S * 0.75, S * 0.75, S * 0.75, -S * 0.75, 0.1, 40);
cam.position.set(0, 20, 0.001);
cam.lookAt(0, 0, 0);
cam.updateProjectionMatrix();
r.render(scene, cam);
console.log(
  'plan rendered (red line = z axis at x=0, blue = x axis at z=0; +z is DOWN the image, +x RIGHT)',
);
