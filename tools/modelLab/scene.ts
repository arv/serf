import * as THREE from 'three';
import type {Kit} from './kit';
import type {Variant} from './variants';

/**
 * One diorama per variant: the composed model on a plate of ground, lit and
 * graded exactly like the game (same hemisphere + sun, same ACES exposure),
 * seen through the same orthographic 45/35 rig. What reads here is what
 * reads in a match.
 */

export const YAW = Math.PI / 4;
export const PITCH = (35 * Math.PI) / 180;

const GRASS = 0x55a02a;
const GRASS_EDGE = 0x4a8f24;
const WATER = 0x2f7e96;
const EARTH = 0x8d7146;

export function makeRenderer(canvas: HTMLCanvasElement): THREE.WebGLRenderer {
  // preserveDrawingBuffer: the viewer blits this canvas into each card's 2D
  // canvas right after rendering, and without it the buffer may already be
  // cleared by the time drawImage reads it.
  const r = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    alpha: true,
    preserveDrawingBuffer: true,
  });
  r.setClearColor(0x000000, 0);
  r.shadowMap.enabled = true;
  r.shadowMap.type = THREE.PCFShadowMap;
  r.toneMapping = THREE.ACESFilmicToneMapping;
  r.toneMappingExposure = 1.32;
  return r;
}

export function makeLights(scene: THREE.Scene): THREE.DirectionalLight {
  scene.add(new THREE.HemisphereLight(0xcfe4f7, 0x7f9a50, 1.05));
  const sun = new THREE.DirectionalLight(0xfff1cf, 2.7);
  sun.position.set(-4, 7, 5);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  const half = 4.5;
  sun.shadow.camera.left = -half;
  sun.shadow.camera.right = half;
  sun.shadow.camera.top = half;
  sun.shadow.camera.bottom = -half;
  sun.shadow.camera.near = 0.5;
  sun.shadow.camera.far = 24;
  sun.shadow.bias = -0.0008;
  scene.add(sun, sun.target);
  return sun;
}

/** The ground plate: grass, a trodden apron under the building, and water
 * on the far side for anything that needs a shore. */
function plate(v: Variant, r: number): THREE.Group {
  const g = new THREE.Group();
  const disc = new THREE.Mesh(
    new THREE.CircleGeometry(r, 48),
    new THREE.MeshStandardMaterial({color: GRASS, roughness: 1, metalness: 0}),
  );
  disc.rotation.x = -Math.PI / 2;
  disc.receiveShadow = true;
  g.add(disc);

  // A slim skirt so the plate reads as a slab of turf, not a decal.
  const skirt = new THREE.Mesh(
    new THREE.CylinderGeometry(r, r * 0.985, 0.14, 48, 1, true),
    new THREE.MeshStandardMaterial({
      color: GRASS_EDGE,
      roughness: 1,
      side: THREE.DoubleSide,
    }),
  );
  skirt.position.y = -0.07;
  g.add(skirt);

  if (!v.closeUp) {
    const apron = new THREE.Mesh(
      new THREE.CircleGeometry(Math.min(v.w, v.h) * 0.62, 28),
      new THREE.MeshStandardMaterial({color: EARTH, roughness: 1}),
    );
    apron.rotation.x = -Math.PI / 2;
    apron.position.y = 0.004;
    apron.receiveShadow = true;
    g.add(apron);
  }

  if (v.waterAt !== undefined) {
    // A chord of the plate, on the near side of the shoreline. Laying a
    // shape flat with rotation.x = -90 maps its y to world -z, so the
    // outline is authored negated and comes out the right way round.
    const shape = new THREE.Shape();
    const z0 = v.waterAt;
    const steps = 40;
    shape.moveTo(-r, -z0);
    for (let i = 0; i <= steps; i++) {
      const t = -r + (2 * r * i) / steps;
      const zz = Math.sqrt(Math.max(0, r * r - t * t));
      if (zz > z0) shape.lineTo(t, -zz);
    }
    shape.lineTo(r, -z0);
    const water = new THREE.Mesh(
      new THREE.ShapeGeometry(shape),
      new THREE.MeshStandardMaterial({
        color: WATER,
        roughness: 0.35,
        metalness: 0.1,
      }),
    );
    water.rotation.x = -Math.PI / 2;
    water.position.y = 0.03;
    g.add(water);
    // Wet sand along the waterline, cut to the chord so it stops at the
    // turf's edge instead of running off it like a road.
    const chord = 2 * Math.sqrt(Math.max(0, r * r - z0 * z0));
    const bank = new THREE.Mesh(
      new THREE.PlaneGeometry(chord, 0.34),
      new THREE.MeshStandardMaterial({color: 0xc8b184, roughness: 1}),
    );
    bank.rotation.x = -Math.PI / 2;
    bank.position.set(0, 0.006, z0 - 0.1);
    g.add(bank);
  }
  return g;
}

export interface Diorama {
  group: THREE.Group;
  /** Radius that frames the composition, for the ortho camera. */
  radius: number;
  center: THREE.Vector3;
}

export function makeDiorama(K: Kit, v: Variant): Diorama {
  const group = new THREE.Group();
  const model = v.build(K);
  const mb = new THREE.Box3().setFromObject(model);
  const ms = new THREE.Vector3();
  mb.getSize(ms);
  // Buildings stand on a plate the size of their footprint; the goods are
  // hand props, so their turf is cut to whatever they actually cover.
  const plateR = v.closeUp
    ? Math.max(ms.x, ms.z) * 0.62 + 0.22
    : Math.max(v.w, v.h) * 0.95 + 0.5;
  group.add(plate(v, plateR));
  group.add(model);
  const bb = new THREE.Box3().setFromObject(model);
  const center = new THREE.Vector3();
  bb.getCenter(center);
  const size = new THREE.Vector3();
  bb.getSize(size);
  // At 45/35 a composition's screen height is roughly its ground span plus
  // most of its height, so tall things (windmill, oven chimney) get framed
  // by the same rule as flat ones (a fishery's quay). The plate is a
  // floor on the framing so the turf never crops mid-card.
  const span = Math.max(size.x, size.z);
  const view =
    Math.max(span * 1.45, span * 0.95 + size.y * 1.05, plateR * 1.92) + 0.35;
  center.y = size.y * 0.42;
  return {group, radius: view / 2, center};
}

/** Place an orthographic camera on the game's rig angles, framing `d`. */
export function frame(
  cam: THREE.OrthographicCamera,
  d: Diorama,
  yaw: number,
  aspect: number,
): void {
  const view = d.radius * 2;
  cam.left = (-view * aspect) / 2;
  cam.right = (view * aspect) / 2;
  cam.top = view / 2;
  cam.bottom = -view / 2;
  cam.near = 0.1;
  cam.far = 60;
  const dist = 18;
  cam.position.set(
    d.center.x + Math.sin(yaw) * Math.cos(PITCH) * dist,
    d.center.y + Math.sin(PITCH) * dist,
    d.center.z + Math.cos(yaw) * Math.cos(PITCH) * dist,
  );
  cam.lookAt(d.center);
  cam.updateProjectionMatrix();
}
