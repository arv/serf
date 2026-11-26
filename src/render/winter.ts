import * as THREE from 'three';
import type {GameRenderer} from './renderer';

/**
 * PROTOTYPE (?winter): the look of a snowed-in valley, nothing more. Snow
 * settles on whatever faces the sky, the light goes cold and low, and
 * flakes fall. No sim, no season clock.
 */

const SNOW = new THREE.Color(0xeef3f8);
const snowUniform = {value: SNOW};

function patch(material: THREE.Material, amount: number): void {
  const previous = material.onBeforeCompile.bind(material);
  material.onBeforeCompile = (shader, renderer) => {
    previous(shader, renderer);
    shader.uniforms.uSnow = snowUniform;
    shader.uniforms.uSnowAmount = {value: amount};
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying float vSnowUp;')
      .replace(
        '#include <defaultnormal_vertex>',
        /* glsl */ `#include <defaultnormal_vertex>
        vSnowUp = dot(
          normalize(transformedNormal),
          normalize(mat3(viewMatrix) * vec3(0.0, 1.0, 0.0)));`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        '#include <common>\nvarying float vSnowUp;\nuniform vec3 uSnow;\nuniform float uSnowAmount;',
      )
      .replace(
        '#include <color_fragment>',
        /* glsl */ `#include <color_fragment>
        diffuseColor.rgb = mix(
          diffuseColor.rgb, uSnow,
          smoothstep(0.35, 0.8, vSnowUp) * uSnowAmount);`,
      );
  };
  // The patch above changes the program; the key has to say so.
  material.customProgramCacheKey = () => `snow${amount}`;
  material.needsUpdate = true;
}

export class Winter {
  #seen = new WeakSet<THREE.Material>();
  #flakes: THREE.Points;
  #time = {value: 0};
  #centre = {value: new THREE.Vector3()};

  constructor(renderer: GameRenderer) {
    const scene = renderer.scene;
    for (const child of scene.children) {
      if (child instanceof THREE.DirectionalLight) {
        // A low, pale sun: long shadows, and snow that is not blown out.
        child.color.set(0xffe9d2);
        child.intensity = 1.75;
      } else if (child instanceof THREE.HemisphereLight) {
        child.intensity = 1.25;
      }
    }

    const COUNT = 2600;
    const pos = new Float32Array(COUNT * 3);
    for (let i = 0; i < COUNT * 3; i++) pos[i] = Math.random();
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const material = new THREE.ShaderMaterial({
      uniforms: {uTime: this.#time, uCentre: this.#centre},
      transparent: true,
      depthWrite: false,
      vertexShader: /* glsl */ `
        uniform float uTime;
        uniform vec3 uCentre;
        void main() {
          vec3 p = position;
          float speed = 2.2 + fract(p.x * 91.7) * 1.6;
          p.y = fract(p.y - uTime * speed / 26.0);
          p.x = fract(p.x + sin(uTime * 0.6 + position.z * 40.0) * 0.012);
          vec3 world = uCentre + (p - vec3(0.5, 0.0, 0.5)) * vec3(90.0, 26.0, 90.0);
          gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
          gl_PointSize = 2.0 + fract(position.z * 57.3) * 2.5;
        }`,
      fragmentShader: /* glsl */ `
        void main() {
          float d = length(gl_PointCoord - 0.5);
          gl_FragColor = vec4(1.0, 1.0, 1.0, smoothstep(0.5, 0.15, d) * 0.85);
        }`,
    });
    material.userData.noFog = true;
    this.#flakes = new THREE.Points(geo, material);
    this.#flakes.frustumCulled = false;
    this.#flakes.renderOrder = 50;
    scene.add(this.#flakes);
  }

  update(renderer: GameRenderer, seconds: number): void {
    this.#time.value = seconds;
    renderer.rig.camera.getWorldDirection(this.#centre.value);
    // Where the camera's axis meets the ground, near enough.
    const cam = renderer.rig.camera.position;
    const t = this.#centre.value.y < -0.01 ? -cam.y / this.#centre.value.y : 0;
    this.#centre.value.multiplyScalar(t).add(cam).setY(0);
    renderer.scene.traverse(this.#visit);
  }

  #visit = (obj: THREE.Object3D): void => {
    const mesh = obj as THREE.Mesh;
    const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
    if (!mat || obj instanceof THREE.SkinnedMesh) return;
    for (const m of Array.isArray(mat) ? mat : [mat]) {
      if (this.#seen.has(m)) continue;
      this.#seen.add(m);
      const lit =
        m instanceof THREE.MeshLambertMaterial ||
        m instanceof THREE.MeshStandardMaterial;
      if (!lit || m.transparent || m.userData.noSnow) continue;
      patch(m, (m.userData.snow as number | undefined) ?? 0.92);
    }
  };
}
