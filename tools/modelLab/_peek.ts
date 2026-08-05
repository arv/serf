import * as THREE from 'three';
import { Kit } from './kit';
import { makeLights, makeRenderer } from './scene';

const FILES = [
  'extra/building_docks_green',
  'extra/building_shipyard_green',
  'extra/building_stables_green',
  'extra/building_tent_green',
];
const K = new Kit();
await K.load(FILES);

const canvas = document.createElement('canvas');
document.body.appendChild(canvas);
const renderer = makeRenderer(canvas);
renderer.setClearColor(0xa9c691, 1);
renderer.setSize(1300, 460, false);
const scene = new THREE.Scene();
makeLights(scene);
const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(60, 60),
  new THREE.MeshStandardMaterial({ color: 0x6aa63c, roughness: 1 }),
);
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);

FILES.forEach((f, i) => {
  // Each at the size a 2x2 building would be drawn.
  const g = K.base(f, 2, 2);
  if (!g) return console.log('MISSING', f);
  // Lay the row along the camera's own right vector — at yaw 45 a row
  // along +x walks diagonally off the bottom of the frame.
  const t = (i - (FILES.length - 1) / 2) * 3.6;
  g.position.set(t * Math.SQRT1_2, 0, -t * Math.SQRT1_2);
  scene.add(g);
  console.log('placed', f);
});

const cam = new THREE.OrthographicCamera(-8.2, 8.2, 2.9, -2.9, 0.1, 100);
const yaw = Math.PI / 4;
const pitch = (35 * Math.PI) / 180;
cam.position.set(Math.sin(yaw) * Math.cos(pitch) * 24, Math.sin(pitch) * 24, Math.cos(yaw) * Math.cos(pitch) * 24);
cam.lookAt(0, 0.9, 0);
renderer.render(scene, cam);
console.log('rendered');
