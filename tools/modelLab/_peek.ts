import * as THREE from 'three';
import { Kit } from './kit';
import { makeLights, makeRenderer } from './scene';

const K = new Kit();
await K.load(['extra/building_shipyard_green']);

const canvas = document.createElement('canvas');
document.body.appendChild(canvas);
const renderer = makeRenderer(canvas);
renderer.setClearColor(0xa9c691, 1);
renderer.setSize(1400, 420, false);
const scene = new THREE.Scene();
makeLights(scene);
const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(80, 80),
  new THREE.MeshStandardMaterial({ color: 0x6aa63c, roughness: 1 }),
);
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);

// The same model at four quarter turns, so every face of it is visible.
for (let i = 0; i < 4; i++) {
  const g = K.base('extra/building_shipyard_green', 3, 3, { rot: (i * Math.PI) / 2 });
  if (!g) break;
  const t = (i - 1.5) * 4.6;
  g.position.set(t * Math.SQRT1_2, 0, -t * Math.SQRT1_2);
  scene.add(g);
}

const cam = new THREE.OrthographicCamera(-10, 10, 3, -3, 0.1, 100);
const yaw = Math.PI / 4;
const pitch = (35 * Math.PI) / 180;
cam.position.set(
  Math.sin(yaw) * Math.cos(pitch) * 30,
  Math.sin(pitch) * 30,
  Math.cos(yaw) * Math.cos(pitch) * 30,
);
cam.lookAt(0, 1.0, 0);
renderer.render(scene, cam);
console.log('rendered');
