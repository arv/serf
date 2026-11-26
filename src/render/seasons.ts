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
 * PROTOTYPE: the valley turns between summer and winter as the match runs.
 * Look only — the sim knows nothing of it; the season is read off the match
 * tick, so it pauses with the game and every seat and every replay sees the
 * same one. Summer opens the match; ?year=<seconds> sets the length of a
 * year and ?season=summer|winter pins one for a still.
 *
 * Nothing is repainted. The snow is a splice into the materials already on
 * screen, driven by a couple of shared uniforms, so a season is a few
 * numbers and the turn between the two is a lerp.
 */

const SEASONS = ['summer', 'winter'] as const;
type Season = (typeof SEASONS)[number];

/** Seconds in a year unless ?year says otherwise: four minutes a season. */
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
  /** Snow lying on whatever faces the sky. */
  snow: number;
  /** How much snow is in the air. */
  falling: number;
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
  snow: 0,
  falling: 0,
};

const KEYS: Record<Season, Key> = {
  summer: SUMMER,
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
] as const satisfies readonly (keyof Key)[];
const NUMBER_FIELDS = [
  'sunIntensity',
  'hemiIntensity',
  'snow',
  'falling',
] as const satisfies readonly (keyof Key)[];

/** Every flake there could be; `falling` says what share is in the air. */
const FLAKES = 2600;

type Kind = 'ground' | 'solid';

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
    /** 1 while the snow is going, 0 while it is coming: the two do not
     * look alike. */
    uThaw: {value: 0},
    uSnowColor: {value: new THREE.Color(0xe3ebf4)},
  };
  #air = {
    uTime: {value: 0},
    uCentre: {value: new THREE.Vector3()},
    uFalling: {value: 0},
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
    renderer.scene.add(this.#makeAir());
  }

  /** The snow in the air. */
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
        void main() {
          vec3 p = position;
          float speed = 3.0 * (0.75 + fract(p.x * 91.7) * 0.5);
          p.y = fract(p.y - uTime * speed / 26.0);
          p.x = fract(p.x + sin(uTime * 0.6 + position.z * 40.0) * 0.012);
          vec3 world = uCentre + (p - vec3(0.5, 0.0, 0.5)) * vec3(90.0, 26.0, 90.0);
          gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
          // Each flake has its own threshold, so the air fills and empties
          // one flake at a time rather than all at once.
          float mine = fract(position.z * 57.3);
          gl_PointSize = mine < uFalling ? 3.0 * (0.7 + mine * 0.8) : 0.0;
        }`,
      fragmentShader: /* glsl */ `
        void main() {
          float d = length(gl_PointCoord - 0.5);
          gl_FragColor = vec4(vec3(1.0), smoothstep(0.5, 0.15, d) * 0.85);
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

  /** The tick last heard from the sim, the moment the view has reached,
   * and how far the two were apart when it was heard. */
  #heard = -1;
  #shown = 0;
  #behind = 0;
  #last = 0;

  /** The sim reports its tick only now and then — a couple of times a
   * second — and a season that stepped with it would visibly judder. So
   * the view keeps its own clock, run at the match's speed every frame,
   * and each report only nudges it: the error is bled off over a second
   * or so rather than jumped. A big gap (a seek, a resync) is jumped. */
  #clock(tick: number, speed: number, seconds: number): number {
    const dt = Math.min(Math.max(seconds - this.#last, 0), 0.25);
    this.#last = seconds;
    if (tick !== this.#heard) {
      const first = this.#heard < 0;
      this.#heard = tick;
      this.#behind = tick - this.#shown;
      if (first || Math.abs(this.#behind) > 3 * TICKS_PER_SECOND) {
        this.#shown = tick;
        this.#behind = 0;
      }
    }
    if (speed > 0) {
      const mend = this.#behind * Math.min(dt * 1.5, 1);
      this.#behind -= mend;
      // Never backwards: a clock that is ahead only waits.
      this.#shown += Math.max(dt * TICKS_PER_SECOND * speed + mend, 0);
    }
    return this.#shown;
  }

  /** DEV: the tick the view has reached, for checking it glides. */
  get shown(): number {
    return this.#shown;
  }

  update(tick: number, speed: number, seconds: number): void {
    const phase = this.#phase(
      this.preview ?? this.#clock(tick, speed, seconds),
    );
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

    // Snow does not come and go the way the light does. Coming, it is in
    // the air before any of it lies; going, the sky clears first and the
    // ground is the last thing to let go of it.
    const thaw = to.snow < from.snow;
    const lying = THREE.MathUtils.smoothstep(t, thaw ? 0.1 : 0.3, 1);
    const inAir = THREE.MathUtils.smoothstep(t, 0, thaw ? 0.2 : 0.25);
    const u = this.#uniforms;
    u.uSnow.value = from.snow + (to.snow - from.snow) * lying;
    u.uThaw.value = thaw ? 1 : 0;

    const air = this.#air;
    air.uTime.value = seconds;
    air.uFalling.value = from.falling + (to.falling - from.falling) * inAir;

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
    for (const m of Array.isArray(mat) ? mat : [mat]) {
      if (this.#seen.has(m)) continue;
      this.#seen.add(m);
      const lit =
        m instanceof THREE.MeshLambertMaterial ||
        m instanceof THREE.MeshStandardMaterial;
      if (!lit) continue;
      if (m.userData.ground) this.#splice(m, 'ground');
      else if (!m.transparent) this.#splice(m, 'solid');
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
          `#include <common>\n${VARYINGS}${UNIFORMS}${COVER}`,
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
  varying vec3 vSeasonAt;
`;

const UNIFORMS = /* glsl */ `
  uniform float uSnow;
  uniform float uThaw;
  uniform vec3 uSnowColor;
`;

const VERTEX = /* glsl */ `
  vSeasonUp = dot(
    normalize(transformedNormal),
    normalize(mat3(viewMatrix) * vec3(0.0, 1.0, 0.0)));
  // Where in the valley this is: snow lies and goes by place, not by mesh.
  vec4 seasonAt = vec4(position, 1.0);
  #ifdef USE_INSTANCING
    seasonAt = instanceMatrix * seasonAt;
  #endif
  vSeasonAt = (modelMatrix * seasonAt).xyz;
`;

/** How much snow lies at a place, shared by everything it lies on. */
const COVER = /* glsl */ `
  float seasonHash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
  }
  float seasonNoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
    return mix(
      mix(seasonHash(i), seasonHash(i + vec2(1.0, 0.0)), f.x),
      mix(seasonHash(i + vec2(0.0, 1.0)), seasonHash(i + vec2(1.0, 1.0)), f.x),
      f.y);
  }
  // x: how much snow lies here. y: how lately it left, for wet ground.
  // 'early' is how much sooner than open ground this spot thaws.
  vec2 seasonCover(vec3 at, float early) {
    vec2 p = at.xz + at.y * 0.7;
    float drift = seasonNoise(p * 0.16) * 0.65 + seasonNoise(p * 0.5) * 0.35;
    drift = clamp((drift - 0.22) / 0.56, 0.0, 1.0);
    // Coming, it fades in over everything at once and piles up, only a
    // little sooner in one place than another. Going, it draws back into
    // drifts with an edge you can see.
    float last = mix(
      mix(0.5, drift, 0.45),
      clamp(drift + early, 0.0, 1.0),
      uThaw);
    float soft = mix(0.5, 0.13, uThaw);
    float s = uSnow * (1.0 + 2.0 * soft) - soft;
    float lies = smoothstep(last - soft, last + soft, s);
    float left = uThaw * (1.0 - lies) *
      smoothstep(0.3, 0.0, last - s) * smoothstep(0.0, 0.12, uSnow);
    return vec2(lies, left);
  }
`;

/** Snow on whatever faces the sky. Roofs and boughs shed it before the
 * ground does. */
const SNOW = /* glsl */ `
  diffuseColor.rgb = mix(
    diffuseColor.rgb, uSnowColor,
    smoothstep(0.35, 0.8, vSeasonUp) * seasonCover(vSeasonAt, 0.3).x * 0.92);
`;

const FRAGMENT: Record<Kind, string> = {
  solid: SNOW,
  // The ground is painted once, in summer's colors, and told apart here by
  // what those colors are: grass is green-to-gold and saturated, where
  // trodden earth is browner and rock is grey. Grass takes the full depth
  // of snow; a trail keeps showing through, and is the first to thaw.
  ground: /* glsl */ `
    {
      vec3 c = diffuseColor.rgb;
      float grassy =
        smoothstep(0.83, 0.92, c.g / max(c.r, 0.001)) *
        smoothstep(0.78, 0.62, c.b / max(c.g, 0.001));
      vec2 cover = seasonCover(vSeasonAt, (1.0 - grassy) * 0.3);
      // Where the snow has just gone the ground is dark and wet.
      c *= 1.0 - 0.24 * cover.y;
      diffuseColor.rgb = mix(c, uSnowColor, cover.x * mix(0.4, 0.94, grassy));
    }
  `,
};
