import * as THREE from 'three';
import { loadGlbAssets, makeGlbBuilding } from '../../src/render/assets';

await loadGlbAssets();
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(1200, 620, false);
renderer.shadowMap.enabled = true;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.32;
document.body.appendChild(renderer.domElement);
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x8fbf6a);
scene.add(new THREE.HemisphereLight(0xcfe4f7, 0x7f9a50, 1.05));
const sun = new THREE.DirectionalLight(0xfff1cf, 2.7);
sun.position.set(-6, 9, 6);
sun.castShadow = true;
scene.add(sun);
const ground = new THREE.Mesh(new THREE.PlaneGeometry(80, 80), new THREE.MeshLambertMaterial({ color: 0x55a02a }));
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);

for (let i = 0; i < 2; i++) {
  const g = makeGlbBuilding('fishery', 0);
  if (!g) break;
  g.rotation.y = i * Math.PI;
  const t = (i - 0.5) * 5.2;
  g.position.set(t * Math.SQRT1_2, 0, -t * Math.SQRT1_2);
  scene.add(g);
}
const cam = new THREE.OrthographicCamera(-6.2, 6.2, 3.2, -3.2, 0.1, 100);
const yaw = Math.PI / 4;
const pitch = (35 * Math.PI) / 180;
cam.position.set(Math.sin(yaw) * Math.cos(pitch) * 30, Math.sin(pitch) * 30, Math.cos(yaw) * Math.cos(pitch) * 30);
cam.lookAt(0, 0.8, 0);
renderer.render(scene, cam);
console.log('rendered');
