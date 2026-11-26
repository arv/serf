import * as THREE from 'three';
import type {Season} from './palette';
import type {GameRenderer} from './renderer';

/**
 * PROTOTYPE (?season=): the look of the valley in each season, nothing
 * more. The palette repaints the ground; this adds what a palette cannot —
 * snow settling on whatever faces the sky, foliage that turns or blossoms
 * tree by tree, a sun in the season's key, and something falling through
 * the air. No sim, no season clock.
 */

interface Look {
  sun: number;
  sunIntensity: number;
  hemiIntensity: number;
  /** How far sky-facing surfaces go to snow. */
  snow: number;
  /** 0 leaves foliage alone, 1 turns it, 2 sets some of it in blossom. */
  foliage: 0 | 1 | 2;
  /** What falls: count, the two colors a flake is picked between, pixel
   * size, fall speed and sideways drift. */
  fall?: {
    count: number;
    a: number;
    b: number;
    size: number;
    speed: number;
    drift: number;
  };
}

const LOOKS: Record<Exclude<Season, 'summer'>, Look> = {
  spring: {
    sun: 0xfff4d8,
    sunIntensity: 2.6,
    hemiIntensity: 1.15,
    snow: 0,
    foliage: 2,
    fall: {
      count: 320,
      a: 0xffd9e6,
      b: 0xffffff,
      size: 3.2,
      speed: 0.9,
      drift: 0.05,
    },
  },
  fall: {
    // Lower and warmer: the gold is in the light as much as the leaves.
    sun: 0xffd49a,
    sunIntensity: 2.45,
    hemiIntensity: 0.95,
    snow: 0,
    foliage: 1,
    fall: {
      count: 420,
      a: 0xe0a02a,
      b: 0xb8431c,
      size: 4.2,
      speed: 1.3,
      drift: 0.07,
    },
  },
  winter: {
    // A low, pale sun: long shadows, and snow that is not blown out.
    sun: 0xffe9d2,
    sunIntensity: 1.75,
    hemiIntensity: 1.25,
    snow: 0.92,
    foliage: 0,
    fall: {
      count: 2600,
      a: 0xffffff,
      b: 0xffffff,
      size: 3,
      speed: 3,
      drift: 0.012,
    },
  },
};

const SNOW = {value: new THREE.Color(0xeef3f8)};

function patch(material: THREE.Material, snow: number, foliage: number): void {
  const previous = material.onBeforeCompile.bind(material);
  material.onBeforeCompile = (shader, renderer) => {
    previous(shader, renderer);
    shader.uniforms.uSnow = SNOW;
    shader.uniforms.uSnowAmount = {value: snow};
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        '#include <common>\nvarying float vSnowUp;\nvarying float vSeed;',
      )
      .replace(
        '#include <defaultnormal_vertex>',
        /* glsl */ `#include <defaultnormal_vertex>
        vSnowUp = dot(
          normalize(transformedNormal),
          normalize(mat3(viewMatrix) * vec3(0.0, 1.0, 0.0)));
        // One number per plant, from where it stands: a whole tree turns
        // together, and its neighbor need not.
        vec4 seedAt = vec4(0.0, 0.0, 0.0, 1.0);
        #ifdef USE_INSTANCING
          seedAt = instanceMatrix * seedAt;
        #endif
        seedAt = modelMatrix * seedAt;
        vSeed = fract(sin(dot(seedAt.xz, vec2(12.9898, 78.233))) * 43758.5453);`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        /* glsl */ `#include <common>
        varying float vSnowUp;
        varying float vSeed;
        uniform vec3 uSnow;
        uniform float uSnowAmount;`,
      )
      .replace(
        '#include <color_fragment>',
        /* glsl */ `#include <color_fragment>
        #if ${foliage} > 0
        {
          vec3 c = diffuseColor.rgb;
          // Leaf, not bark or stone: green well clear of red and blue.
          float leafy = smoothstep(1.08, 1.3, c.g / max(max(c.r, c.b), 0.001));
          float lum = dot(c, vec3(0.3, 0.6, 0.1));
          #if ${foliage} == 1
            vec3 tint = vSeed < 0.45
              ? mix(vec3(0.95, 0.70, 0.12), vec3(0.92, 0.42, 0.07), vSeed / 0.45)
              : mix(vec3(0.92, 0.42, 0.07), vec3(0.66, 0.15, 0.08), (vSeed - 0.45) / 0.4);
            // The odd evergreen holds out, a little duller for it.
            vec3 turned = vSeed > 0.85 ? c * vec3(0.9, 0.85, 0.7) : tint * lum * 2.3;
          #else
            vec3 fresh = c * vec3(1.12, 1.18, 0.78);
            vec3 bloom = mix(vec3(1.0, 0.42, 0.62), vec3(1.0, 0.70, 0.80),
              fract(vSeed * 7.0)) * (0.42 + lum * 1.1);
            vec3 turned = vSeed > 0.84 ? bloom : fresh;
          #endif
          diffuseColor.rgb = mix(c, turned, leafy);
        }
        #endif
        diffuseColor.rgb = mix(
          diffuseColor.rgb, uSnow,
          smoothstep(0.35, 0.8, vSnowUp) * uSnowAmount);`,
      );
  };
  // The patch above changes the program; the key has to say so.
  material.customProgramCacheKey = () => `season${snow}/${foliage}`;
  material.needsUpdate = true;
}

export class Seasons {
  #look: Look;
  #seen = new WeakSet<THREE.Material>();
  #time = {value: 0};
  #centre = {value: new THREE.Vector3()};

  constructor(renderer: GameRenderer, season: Exclude<Season, 'summer'>) {
    const look = (this.#look = LOOKS[season]);
    const scene = renderer.scene;
    for (const child of scene.children) {
      if (child instanceof THREE.DirectionalLight) {
        child.color.set(look.sun);
        child.intensity = look.sunIntensity;
      } else if (child instanceof THREE.HemisphereLight) {
        child.intensity = look.hemiIntensity;
      }
    }
    if (look.fall) scene.add(this.#falling(look.fall));
  }

  #falling(fall: NonNullable<Look['fall']>): THREE.Points {
    const pos = new Float32Array(fall.count * 3);
    for (let i = 0; i < pos.length; i++) pos[i] = Math.random();
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const material = new THREE.ShaderMaterial({
      uniforms: {
        uTime: this.#time,
        uCentre: this.#centre,
        uA: {value: new THREE.Color(fall.a)},
        uB: {value: new THREE.Color(fall.b)},
        uSize: {value: fall.size},
        uSpeed: {value: fall.speed},
        uDrift: {value: fall.drift},
      },
      transparent: true,
      depthWrite: false,
      vertexShader: /* glsl */ `
        uniform float uTime;
        uniform vec3 uCentre;
        uniform float uSize;
        uniform float uSpeed;
        uniform float uDrift;
        varying float vPick;
        void main() {
          vec3 p = position;
          vPick = fract(p.x * 91.7);
          float speed = uSpeed * (0.75 + vPick * 0.5);
          p.y = fract(p.y - uTime * speed / 26.0);
          p.x = fract(p.x + sin(uTime * 0.6 + position.z * 40.0) * uDrift);
          vec3 world = uCentre + (p - vec3(0.5, 0.0, 0.5)) * vec3(90.0, 26.0, 90.0);
          gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
          gl_PointSize = uSize * (0.7 + fract(position.z * 57.3) * 0.8);
        }`,
      fragmentShader: /* glsl */ `
        uniform vec3 uA;
        uniform vec3 uB;
        varying float vPick;
        void main() {
          float d = length(gl_PointCoord - 0.5);
          gl_FragColor = vec4(mix(uA, uB, vPick), smoothstep(0.5, 0.15, d) * 0.85);
        }`,
    });
    material.userData.noFog = true;
    const points = new THREE.Points(geo, material);
    points.frustumCulled = false;
    points.renderOrder = 50;
    return points;
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
    // Scatter — trees, bushes, grass — is what is drawn instanced; nothing
    // a player owns is, so a banner's green is never mistaken for a leaf.
    const foliage = obj instanceof THREE.InstancedMesh ? this.#look.foliage : 0;
    for (const m of Array.isArray(mat) ? mat : [mat]) {
      if (this.#seen.has(m)) continue;
      this.#seen.add(m);
      const lit =
        m instanceof THREE.MeshLambertMaterial ||
        m instanceof THREE.MeshStandardMaterial;
      if (!lit || m.transparent || m.userData.noSnow) continue;
      if (this.#look.snow > 0 || foliage > 0)
        patch(m, this.#look.snow, foliage);
    }
  };
}
