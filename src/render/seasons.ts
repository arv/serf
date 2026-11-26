import * as THREE from 'three';
import {TICKS_PER_SECOND} from '../sim/defs/balance';
import {
  background,
  fog,
  groundBounce,
  skyLight,
  water,
  waterDeep,
  waterShore,
} from './palette';
import type {GameRenderer} from './renderer';
import type {WaterMesh} from './waterMesh';

/**
 * PROTOTYPE: the valley turns through a year as the match runs. Look only —
 * the sim knows nothing of it; the season is read off the match tick, so
 * it pauses with the game and every seat and every replay sees the same
 * one. Spring opens the match; ?year=<seconds> sets the length of a year
 * and ?season=spring|summer|fall|winter pins one for a still. ?seasons=2
 * is the other calendar being weighed: summer and winter only, each turning
 * straight into the other.
 *
 * Nothing is repainted. The ground, the foliage and the snow are all
 * splices into the materials already on screen, driven by a handful of
 * shared uniforms, so a season is a few numbers and the turn between two
 * of them is a lerp.
 */

const SEASONS = ['spring', 'summer', 'fall', 'winter'] as const;
type Season = (typeof SEASONS)[number];
const TWO_SEASONS: readonly Season[] = ['summer', 'winter'];

/** Seconds in a year unless ?year says otherwise: two minutes a season. */
const YEAR_SECONDS = 480;
/** The share of a season spent settled before it starts to turn. */
const HOLD = 0.55;

interface Key {
  sun: number;
  sunIntensity: number;
  sky: number;
  bounce: number;
  hemiIntensity: number;
  haze: number;
  backdrop: number;
  shallow: number;
  mid: number;
  deep: number;
  /** What grass is pulled toward, and how far. */
  ground: number;
  groundAmount: number;
  /** Snow lying on whatever faces the sky. */
  snow: number;
  /** Leaves turned (fall) and trees in blossom (spring). */
  turn: number;
  bloom: number;
  /** What falls: how much of it, the two colors it is picked between,
   * pixel size, fall speed and sideways drift. */
  falling: number;
  fallA: number;
  fallB: number;
  fallSize: number;
  fallSpeed: number;
  fallDrift: number;
}

/** The printed game, to the last number: summer must change nothing. */
const SUMMER: Key = {
  sun: 0xfff1cf,
  sunIntensity: 2.7,
  sky: skyLight,
  bounce: groundBounce,
  hemiIntensity: 1.05,
  haze: fog,
  backdrop: background,
  shallow: waterShore,
  mid: water,
  deep: waterDeep,
  ground: 0xffffff,
  groundAmount: 0,
  snow: 0,
  turn: 0,
  bloom: 0,
  falling: 0,
  fallA: 0xffffff,
  fallB: 0xffffff,
  fallSize: 3,
  fallSpeed: 1,
  fallDrift: 0.03,
};

const KEYS: Record<Season, Key> = {
  spring: {
    ...SUMMER,
    sun: 0xfff4d8,
    sunIntensity: 2.6,
    sky: 0xd6ecff,
    bounce: 0x8cb058,
    hemiIntensity: 1.15,
    haze: 0xa8cdb4,
    ground: 0x7fd03c,
    groundAmount: 0.55,
    bloom: 1,
    falling: 0.12,
    fallA: 0xffd9e6,
    fallB: 0xffffff,
    fallSize: 3.2,
    fallSpeed: 0.9,
    fallDrift: 0.05,
  },
  summer: SUMMER,
  fall: {
    ...SUMMER,
    // Lower and warmer: the gold is in the light as much as the leaves.
    sun: 0xffd49a,
    sunIntensity: 2.45,
    sky: 0xe8dcc8,
    bounce: 0xa08a50,
    hemiIntensity: 0.95,
    haze: 0xc9b99a,
    backdrop: 0x2e2a1e,
    mid: 0x3a7688,
    ground: 0xb89a36,
    groundAmount: 0.85,
    turn: 1,
    falling: 0.16,
    fallA: 0xe0a02a,
    fallB: 0xb8431c,
    fallSize: 4.2,
    fallSpeed: 1.3,
    fallDrift: 0.07,
  },
  winter: {
    ...SUMMER,
    // A low, pale sun: long shadows, and snow that is not blown out.
    sun: 0xffe9d2,
    sunIntensity: 1.75,
    sky: 0xd6e4ff,
    bounce: 0xb4c4dc,
    hemiIntensity: 1.25,
    haze: 0xc6d3e0,
    backdrop: 0x2b3542,
    shallow: 0xb9d3e3,
    mid: 0x86b0cb,
    deep: 0x5b8db0,
    snow: 1,
    falling: 1,
    fallSize: 3,
    fallSpeed: 3,
    fallDrift: 0.012,
  },
};

const COLOR_FIELDS = [
  'sun',
  'sky',
  'bounce',
  'haze',
  'backdrop',
  'shallow',
  'mid',
  'deep',
  'ground',
  'fallA',
  'fallB',
] as const satisfies readonly (keyof Key)[];
const NUMBER_FIELDS = [
  'sunIntensity',
  'hemiIntensity',
  'groundAmount',
  'snow',
  'turn',
  'bloom',
  'falling',
  'fallSize',
  'fallSpeed',
  'fallDrift',
] as const satisfies readonly (keyof Key)[];

/** Every flake there could be; `falling` says what share is in the air. */
const FLAKES = 2600;

type Kind = 'ground' | 'foliage' | 'solid';

export class Seasons {
  #renderer: GameRenderer;
  #water: WaterMesh;
  #sun: THREE.DirectionalLight | undefined;
  #hemi: THREE.HemisphereLight | undefined;
  #seen = new WeakSet<THREE.Material>();
  #yearTicks: number;
  /** The seasons the year walks through, in order. */
  #cycle: readonly Season[] = SEASONS;
  #backdrop = new THREE.Color();

  /** Shared by every spliced material: one write turns the whole valley. */
  #uniforms = {
    uSnow: {value: 0},
    uSnowColor: {value: new THREE.Color(0xe3ebf4)},
    uTurn: {value: 0},
    uBloom: {value: 0},
    uGround: {value: new THREE.Color()},
    uGroundAmount: {value: 0},
  };
  #air = {
    uTime: {value: 0},
    uCentre: {value: new THREE.Vector3()},
    uFalling: {value: 0},
    uA: {value: new THREE.Color()},
    uB: {value: new THREE.Color()},
    uSize: {value: 3},
    uSpeed: {value: 1},
    uDrift: {value: 0.03},
  };

  constructor(renderer: GameRenderer, water: WaterMesh) {
    this.#renderer = renderer;
    this.#water = water;
    for (const child of renderer.scene.children) {
      if (child instanceof THREE.DirectionalLight) this.#sun = child;
      else if (child instanceof THREE.HemisphereLight) this.#hemi = child;
    }
    const params = new URLSearchParams(location.search);
    const year = Number(params.get('year'));
    this.#yearTicks =
      (Number.isFinite(year) && year > 0 ? year : YEAR_SECONDS) *
      TICKS_PER_SECOND;
    const pinned = params.get('season') as Season;
    if (SEASONS.includes(pinned)) this.#cycle = [pinned];
    else if (params.get('seasons') === '2') this.#cycle = TWO_SEASONS;
    renderer.scene.add(this.#makeAir());
  }

  /** What falls through the air, whatever the season makes of it. */
  #makeAir(): THREE.Points {
    const pos = new Float32Array(FLAKES * 3);
    for (let i = 0; i < pos.length; i++) pos[i] = Math.random();
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const material = new THREE.ShaderMaterial({
      uniforms: this.#air,
      transparent: true,
      depthWrite: false,
      vertexShader: /* glsl */ `
        uniform float uTime;
        uniform vec3 uCentre;
        uniform float uFalling;
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
          // Each flake has its own threshold, so the air fills and empties
          // one flake at a time rather than all at once.
          float mine = fract(position.z * 57.3);
          gl_PointSize = mine < uFalling ? uSize * (0.7 + mine * 0.8) : 0.0;
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

  /** Where in the year a tick falls: the whole part is the season of the
   * cycle it is in, the fraction how far that one has turned into the next. */
  #phase(tick: number): number {
    const n = this.#cycle.length;
    const year = ((tick % this.#yearTicks) / this.#yearTicks) * n;
    const into = year % 1;
    return Math.floor(year) + THREE.MathUtils.smoothstep(into, HOLD, 1);
  }

  /** DEV: a tick to show in place of the match's, for stepping through a
   * year by hand (__seasons.preview = 1200). */
  preview: number | undefined;

  update(tick: number, seconds: number): void {
    const phase = this.#phase(this.preview ?? tick);
    const n = this.#cycle.length;
    const from = KEYS[this.#cycle[Math.floor(phase) % n]!];
    const to = KEYS[this.#cycle[(Math.floor(phase) + 1) % n]!];
    const t = phase % 1;
    const num = (field: (typeof NUMBER_FIELDS)[number]): number =>
      from[field] + (to[field] - from[field]) * t;
    const col = (
      out: THREE.Color,
      field: (typeof COLOR_FIELDS)[number],
    ): THREE.Color =>
      out.setHex(from[field]).lerp(SCRATCH.setHex(to[field]), t);

    const u = this.#uniforms;
    u.uSnow.value = num('snow');
    u.uTurn.value = num('turn');
    u.uBloom.value = num('bloom');
    u.uGroundAmount.value = num('groundAmount');
    // A tint is only meaningful where there is some of it: lerping through
    // summer's placeholder white would wash the turn out.
    u.uGround.value.setHex(from.groundAmount > 0 ? from.ground : to.ground);
    if (from.groundAmount > 0 && to.groundAmount > 0)
      col(u.uGround.value, 'ground');

    const air = this.#air;
    air.uTime.value = seconds;
    air.uFalling.value = num('falling');
    air.uSize.value = num('fallSize');
    air.uSpeed.value = num('fallSpeed');
    air.uDrift.value = num('fallDrift');
    air.uA.value.setHex((from.falling > 0 ? from : to).fallA);
    air.uB.value.setHex((from.falling > 0 ? from : to).fallB);

    const scene = this.#renderer.scene;
    if (this.#sun) {
      col(this.#sun.color, 'sun');
      this.#sun.intensity = num('sunIntensity');
    }
    if (this.#hemi) {
      col(this.#hemi.color, 'sky');
      col(this.#hemi.groundColor, 'bounce');
      this.#hemi.intensity = num('hemiIntensity');
    }
    if (scene.fog) col(scene.fog.color, 'haze');
    if (scene.background instanceof THREE.Color)
      col(scene.background, 'backdrop');
    else scene.background = col(this.#backdrop, 'backdrop');
    col(this.#water.colors.shallow, 'shallow');
    col(this.#water.colors.mid, 'mid');
    col(this.#water.colors.deep, 'deep');

    const camera = this.#renderer.rig.camera;
    camera.getWorldDirection(air.uCentre.value);
    // Where the camera's axis meets the ground, near enough.
    const down = air.uCentre.value.y;
    air.uCentre.value
      .multiplyScalar(down < -0.01 ? -camera.position.y / down : 0)
      .add(camera.position)
      .setY(0);

    scene.traverse(this.#visit);
  }

  #visit = (obj: THREE.Object3D): void => {
    const mesh = obj as THREE.Mesh;
    const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
    if (!mat || obj instanceof THREE.SkinnedMesh) return;
    // Scatter — trees, bushes, grass — is what is drawn instanced; nothing
    // a player owns is, so a banner's green is never mistaken for a leaf.
    const instanced = obj instanceof THREE.InstancedMesh;
    for (const m of Array.isArray(mat) ? mat : [mat]) {
      if (this.#seen.has(m)) continue;
      this.#seen.add(m);
      const lit =
        m instanceof THREE.MeshLambertMaterial ||
        m instanceof THREE.MeshStandardMaterial;
      if (!lit) continue;
      if (m.userData.ground) this.#splice(m, 'ground');
      else if (!m.transparent) this.#splice(m, instanced ? 'foliage' : 'solid');
    }
  };

  #splice(material: THREE.Material, kind: Kind): void {
    const previous = material.onBeforeCompile.bind(material);
    material.onBeforeCompile = (shader, renderer) => {
      previous(shader, renderer);
      Object.assign(shader.uniforms, this.#uniforms);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>\n${VARYINGS}`)
        .replace(
          '#include <defaultnormal_vertex>',
          `#include <defaultnormal_vertex>\n${VERTEX}`,
        );
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          `#include <common>\n${VARYINGS}${UNIFORMS}`,
        )
        .replace(
          '#include <color_fragment>',
          `#include <color_fragment>\n${FRAGMENT[kind]}`,
        );
    };
    // The splice changes the program; the key has to say so.
    material.customProgramCacheKey = () => `season:${kind}`;
    material.needsUpdate = true;
  }
}

const SCRATCH = new THREE.Color();

const VARYINGS = /* glsl */ `
  varying float vSeasonUp;
  varying float vSeasonSeed;
`;

const UNIFORMS = /* glsl */ `
  uniform float uSnow;
  uniform vec3 uSnowColor;
  uniform float uTurn;
  uniform float uBloom;
  uniform vec3 uGround;
  uniform float uGroundAmount;
`;

const VERTEX = /* glsl */ `
  vSeasonUp = dot(
    normalize(transformedNormal),
    normalize(mat3(viewMatrix) * vec3(0.0, 1.0, 0.0)));
  // One number per plant, from where it stands: a whole tree turns
  // together, and its neighbor need not.
  vec4 seasonAt = vec4(0.0, 0.0, 0.0, 1.0);
  #ifdef USE_INSTANCING
    seasonAt = instanceMatrix * seasonAt;
  #endif
  seasonAt = modelMatrix * seasonAt;
  vSeasonSeed = fract(sin(dot(seasonAt.xz, vec2(12.9898, 78.233))) * 43758.5453);
`;

/** Snow on whatever faces the sky. */
const SNOW = /* glsl */ `
  diffuseColor.rgb = mix(
    diffuseColor.rgb, uSnowColor,
    smoothstep(0.35, 0.8, vSeasonUp) * uSnow * 0.92);
`;

const FRAGMENT: Record<Kind, string> = {
  solid: SNOW,
  // The ground is painted once, in summer's colors, and told apart here by
  // what those colors are: grass is green-to-gold and saturated, where
  // trodden earth is browner and rock is grey. Grass takes the season's
  // tint and the full depth of snow; a trail keeps showing through.
  ground: /* glsl */ `
    {
      vec3 c = diffuseColor.rgb;
      float grassy =
        smoothstep(0.83, 0.92, c.g / max(c.r, 0.001)) *
        smoothstep(0.78, 0.62, c.b / max(c.g, 0.001));
      float lum = dot(c, vec3(0.3, 0.6, 0.1));
      c = mix(c, uGround * lum * 1.9, uGroundAmount * grassy);
      diffuseColor.rgb = mix(c, uSnowColor, uSnow * mix(0.4, 0.94, grassy));
    }
  `,
  foliage: /* glsl */ `
    {
      vec3 c = diffuseColor.rgb;
      // Leaf, not bark or stone: green well clear of red and blue.
      float leafy = smoothstep(1.08, 1.3, c.g / max(max(c.r, c.b), 0.001));
      float lum = dot(c, vec3(0.3, 0.6, 0.1));
      // Each plant has its own moment in the turn, so a wood goes over a
      // tree at a time; a second number, unrelated, picks its color.
      float when = vSeasonSeed * 0.6;
      float hue = fract(vSeasonSeed * 13.0);
      vec3 tint = hue < 0.5
        ? mix(vec3(0.95, 0.70, 0.12), vec3(0.92, 0.42, 0.07), hue / 0.5)
        : mix(vec3(0.92, 0.42, 0.07), vec3(0.66, 0.15, 0.08), (hue - 0.5) / 0.5);
      // The odd evergreen holds out.
      float turns = fract(vSeasonSeed * 29.0) < 0.85 ? 1.0 : 0.15;
      c = mix(c, tint * lum * 2.3,
        leafy * turns * smoothstep(when, when + 0.4, uTurn));
      float blooming = smoothstep(when, when + 0.4, uBloom);
      c *= mix(vec3(1.0), vec3(1.12, 1.18, 0.78), leafy * uBloom);
      vec3 blossom =
        mix(vec3(1.0, 0.42, 0.62), vec3(1.0, 0.70, 0.80), hue) *
        (0.42 + lum * 1.1);
      c = mix(c, blossom,
        leafy * blooming * step(0.84, fract(vSeasonSeed * 29.0 + 0.5)));
      diffuseColor.rgb = c;
    }
    ${SNOW}
  `,
};
