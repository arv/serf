import * as THREE from 'three';
import {
  ICE_FROM,
  ICE_GRACE_TICKS,
  ICE_UNTIL,
  TICKS_PER_SECOND,
  YEAR_TICKS,
} from '../sim/defs/balance';
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

/** How much of the year each season has: six minutes of summer to two of
 * winter. */
const SHARE: Record<Season, number> = {summer: 0.75, winter: 0.25};
/** The share of the year a season spends turning into the next, at the end
 * of its own: the snow comes in summer's last 48 seconds and goes in
 * winter's. */
const TURN = 0.1;

/**
 * The year's turns as shares of it, for the HUD's dial to draw: where the
 * snow starts coming, where winter begins (it has come), and where it
 * starts going. At 1 it has gone and the year begins again.
 */
export const TURNS = {
  snowing: SHARE.summer - TURN,
  winter: SHARE.summer,
  thawing: 1 - TURN,
} as const;

/** Where in the year a pinned season shows itself: the middle of the
 * stretch where it is wholly itself. */
const STILL: Record<Season, number> = {
  summer: TURNS.snowing / 2,
  winter: (TURNS.winter + TURNS.thawing) / 2,
};

/** Snow, as it lies. */
export const SNOW_COLOR = 0xe3ebf4;

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

/** The share of the year a lake spends closing before it bears, and
 * opening after it stops. */
const ICE_FORMING = 0.05;
const ICE_BREAKING = 0.03;

/** How far the view's clock may run past the last tick the sim reported,
 * and the gap past which it stops gliding and jumps. */
const LEAD = 30 * TICKS_PER_SECOND;
const JUMP = 3 * TICKS_PER_SECOND;

/** Every flake there could be; `falling` says what share is in the air. */
const FLAKES = 2600;

type Kind = 'ground' | 'solid' | 'team' | 'road';

export class Seasons {
  #renderer: GameRenderer;
  #water: WaterMesh;
  #sun: THREE.DirectionalLight | undefined;
  #hemi: THREE.HemisphereLight | undefined;
  /** Materials looked at and left alone. */
  #seen = new WeakSet<THREE.Material>();
  /**
   * Every material the seasons are spliced into, with what it had of its
   * own beforehand and the two wrappers put in their place. A Map, as the
   * fog's is and for the fog's reason: the GLB materials are cached for
   * the life of the document, so a second match splicing one a first
   * match left spliced declares everything twice and compiles nothing.
   */
  #spliced = new Map<THREE.Material, Splice>();
  /** Splices taken out while something else (the fog) was wrapped over
   * them: inert, but still on the material until that wrapper comes off,
   * and so still owed a lifting at dispose. */
  #buried = new Map<THREE.Material, Splice>();
  #disposed = false;
  /** What a skinned mesh wears: units take no snow, whoever else shares
   * the material. */
  #units = new WeakSet<THREE.Material>();
  /** Objects already listening for children, so the scene is only walked
   * where it has grown (the fog's pattern; see FogOfWar#patchNewMaterials). */
  #watched = new WeakSet<THREE.Object3D>();
  #pending: THREE.Object3D[] = [];
  #swept = false;
  #points: THREE.Points;
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
    uSnowColor: {value: new THREE.Color(SNOW_COLOR)},
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
      // The sim's own year unless ?year overrides the look of it: the
      // ice on screen has to be the ice the sim lets a man onto.
      Number.isFinite(year) && year > 0 ? year * TICKS_PER_SECOND : YEAR_TICKS;
    const pinned = params.get('season') as Season;
    if (SEASONS.includes(pinned)) this.#cycle = [pinned];
    const turning = this.#cycle.length > 1;
    this.year = {
      // A turning year opens on summer's first tick until the first frame
      // says where the match is.
      at: turning ? 0 : STILL[this.#cycle[0]!],
      ticks: this.#yearTicks,
      turning,
    };
    this.#points = this.#makeAir();
    renderer.scene.add(this.#points);
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
          gl_PointSize = 3.0 * (0.7 + mine * 0.8);
          // A flake not in the air is put outside the view: a point of
          // size zero is not promised to draw nothing.
          if (mine >= uFalling) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        void main() {
          float d = length(gl_PointCoord - 0.5);
          gl_FragColor = vec4(vec3(1.0), (1.0 - smoothstep(0.15, 0.5, d)) * 0.85);
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
    // A pinned season is the whole of its year and never turns.
    if (this.#cycle.length === 1) return 0;
    let into = (tick % this.#yearTicks) / this.#yearTicks;
    let i = 0;
    while (i < this.#cycle.length - 1 && into >= SHARE[this.#cycle[i]!]) {
      into -= SHARE[this.#cycle[i]!];
      i++;
    }
    const share = SHARE[this.#cycle[i]!];
    return i + THREE.MathUtils.smoothstep(into, share - TURN, share);
  }

  /** DEV: a tick to show in place of the match's, for stepping through a
   * year by hand (__seasons.preview = 1200). */
  preview: number | undefined;

  /** The tick last heard from the sim, the moment the view has reached,
   * and how far the two were apart when it was heard. */
  #heard = -1;
  #shown = 0;
  #behind = 0;
  #last: number | undefined;
  /** Match time for the falling snow, so it stops and hurries with the
   * game. */
  #airTime = 0;

  /** The sim reports its tick only now and then — a couple of times a
   * second — and a season that stepped with it would visibly judder. So
   * the view keeps its own clock, run at the match's speed every frame,
   * and each report only nudges it: the error is bled off over a second
   * or so rather than jumped.
   *
   * It is not trusted far on its own. With no word from the sim it runs
   * LEAD ahead of the last tick heard and then waits there, so a match
   * that has stopped does not go on turning; and found ahead, it waits
   * for the sim rather than stepping back. Only a gap too big to be
   * drift — a seek, a resync — is jumped. */
  #clock(tick: number, speed: number, dt: number): number {
    if (tick !== this.#heard) {
      const first = this.#heard < 0;
      this.#heard = tick;
      this.#behind = tick - this.#shown;
      if (first || this.#behind > JUMP || this.#behind < -(LEAD + JUMP)) {
        this.#shown = tick;
        this.#behind = 0;
      }
    }
    if (speed > 0) {
      const run = dt * TICKS_PER_SECOND * speed;
      const mend = this.#behind * Math.min(dt * 1.5, 1);
      // Never backwards, and never past the lead.
      const step = Math.min(
        Math.max(run + mend, 0),
        Math.max(this.#heard + LEAD - this.#shown, 0),
      );
      // Only what was actually made up comes off the error: a clock held
      // still has mended nothing.
      this.#behind -= step - run;
      this.#shown += step;
    }
    return this.#shown;
  }

  /** What the minimap needs of the season, kept current by update(): how
   * much snow lies, and the unknown and water colors as the scene has
   * them, as sRGB hex. One object, rewritten in place. */
  readonly chart = {snow: 0, unknown: background, water};

  /** Where the view has got to in the year, for the HUD's dial, kept
   * current by update(): `at` the share of it gone, 0 at summer's first
   * tick, and `ticks` its length. `turning` is false while ?season holds
   * one season still, and `at` stands in the middle of it. One object,
   * rewritten in place. */
  readonly year: {at: number; ticks: number; turning: boolean};

  /**
   * How far the lakes have frozen over at `tick`, 0 open to 1 hard. Not the
   * snow's curve but the sim's own window (iceBears in sim/defs/balance.ts):
   * hard for exactly as long as the ice bears, forming over the seconds
   * before and breaking over the seconds after. Ice that looks sound is
   * ice that is; what is still taking or already going looks it.
   */
  #frozen(tick: number): number {
    const into = (tick % this.#yearTicks) / this.#yearTicks;
    const until = ICE_UNTIL + ICE_GRACE_TICKS / YEAR_TICKS;
    return (
      THREE.MathUtils.smoothstep(into, ICE_FROM - ICE_FORMING, ICE_FROM) *
      (1 - THREE.MathUtils.smoothstep(into, until, until + ICE_BREAKING))
    );
  }

  /** DEV: the tick the view has reached, for checking it glides. */
  get shown(): number {
    return this.#shown;
  }

  update(tick: number, speed: number, seconds: number): void {
    // No frame before the first to measure from.
    const dt =
      this.#last === undefined
        ? 0
        : Math.min(Math.max(seconds - this.#last, 0), 0.25);
    this.#last = seconds;
    this.#airTime += dt * speed;
    const shown = this.preview ?? this.#clock(tick, speed, dt);
    const phase = this.#phase(shown);
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
    air.uTime.value = this.#airTime;
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
    // A pinned season has no year to read the ice off: its lake is as
    // frozen as its ground is white.
    this.#water.frozen.value = n === 1 ? u.uSnow.value : this.#frozen(shown);
    this.chart.snow = u.uSnow.value;
    this.chart.unknown = col(SCRATCH_OUT, 'backdrop').getHex();
    this.chart.water = col(SCRATCH_OUT, 'mid').getHex();
    if (n > 1) this.year.at = (shown % this.#yearTicks) / this.#yearTicks;

    const camera = this.#renderer.rig.camera;
    camera.getWorldDirection(air.uCentre.value);
    // Where the camera's axis meets the ground, near enough.
    const down = air.uCentre.value.y;
    air.uCentre.value
      .multiplyScalar(down < -0.01 ? -camera.position.y / down : 0)
      .add(camera.position)
      .setY(0);

    if (!this.#swept) {
      this.#swept = true;
      this.#pending.length = 0;
      scene.traverse(this.#visit);
    } else if (this.#pending.length > 0) {
      for (const root of this.#pending) root.traverse(this.#visit);
      this.#pending.length = 0;
    }
  }

  #onChildAdded = (event: {child: THREE.Object3D}): void => {
    // The listeners outlive the match on anything that does; they must not
    // go on filling a list nobody will read.
    if (!this.#disposed) this.#pending.push(event.child);
  };

  #visit = (obj: THREE.Object3D): void => {
    if (!this.#watched.has(obj)) {
      this.#watched.add(obj);
      obj.addEventListener('childadded', this.#onChildAdded);
    }
    const mesh = obj as THREE.Mesh;
    const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
    if (!mat) return;
    const unit = obj instanceof THREE.SkinnedMesh;
    for (const m of Array.isArray(mat) ? mat : [mat]) {
      if (unit) {
        // Whatever met this material first, a unit wearing it settles it.
        this.#units.add(m);
        this.#unsplice(m);
        continue;
      }
      if (this.#units.has(m) || this.#spliced.has(m) || this.#seen.has(m))
        continue;
      const lit =
        m instanceof THREE.MeshLambertMaterial ||
        m instanceof THREE.MeshStandardMaterial;
      if (lit && m.userData.ground) this.#splice(m, 'ground');
      else if (lit && m.userData.road) this.#splice(m, 'road');
      else if (lit && m.userData.team && !m.transparent)
        this.#splice(m, 'team');
      // `dry` is what was put down a minute ago (sleds.ts): no snow yet.
      else if (lit && !m.transparent && !m.userData.dry)
        this.#splice(m, 'solid');
      else this.#seen.add(m);
    }
  };

  #splice(material: THREE.Material, kind: Kind): void {
    // Both are stored to be assigned straight back onto this same material
    // (see #unsplice), and the live call sites below bind before they call.
    // oxlint-disable-next-line typescript/unbound-method
    const {onBeforeCompile, customProgramCacheKey} = material;
    const previous = onBeforeCompile.bind(material);
    const previousKey = customProgramCacheKey.bind(material);
    const hook: THREE.Material['onBeforeCompile'] = (shader, renderer) => {
      previous(shader, renderer);
      // Still in the chain under a later wrapper (the fog's) after being
      // unpicked: then it is a pass-through.
      if (!this.#spliced.has(material)) return;
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
    // The splice changes the program, so the key has to say so — on top
    // of whatever the material's own key already says (footprints.ts has
    // the story of what a shared key costs).
    const key = (): string =>
      this.#spliced.has(material)
        ? `${previousKey()}|season:${kind}`
        : previousKey();
    this.#spliced.set(material, {
      hook,
      key,
      ownHook: Object.hasOwn(material, 'onBeforeCompile')
        ? onBeforeCompile
        : undefined,
      ownKey: Object.hasOwn(material, 'customProgramCacheKey')
        ? customProgramCacheKey
        : undefined,
    });
    material.onBeforeCompile = hook;
    material.customProgramCacheKey = key;
    material.needsUpdate = true;
  }

  /** Take the seasons back out of a material. Where the splice is still
   * the outermost thing on it, the material gets back exactly what it had;
   * where something has since wrapped it, the splice stays in that chain
   * and goes inert (see the hook). */
  #unsplice(material: THREE.Material): void {
    const was = this.#spliced.get(material);
    if (!was) return;
    this.#spliced.delete(material);
    this.#buried.delete(material);
    const bare = material as Partial<THREE.Material>;
    if (material.onBeforeCompile === was.hook) {
      if (was.ownHook) material.onBeforeCompile = was.ownHook;
      else delete bare.onBeforeCompile;
    } else if (!this.#disposed) {
      this.#buried.set(material, was);
    }
    if (material.customProgramCacheKey === was.key) {
      if (was.ownKey) material.customProgramCacheKey = was.ownKey;
      else delete bare.customProgramCacheKey;
    }
    material.needsUpdate = true;
  }

  /**
   * Unpick every splice and take the snow out of the air, so the materials
   * that outlive this match meet the next one as they were. To run AFTER
   * the fog's own dispose: the fog hands each material back what it found
   * there, which for most is this splice, and only then is this splice the
   * outermost thing and able to be lifted off.
   */
  dispose(): void {
    this.#disposed = true;
    for (const material of this.#spliced.keys()) this.#unsplice(material);
    // Those unpicked under the fog's wrapper: the fog has handed the hook
    // back by now, so it can be lifted off like any other.
    for (const [material, was] of this.#buried) {
      this.#spliced.set(material, was);
      this.#unsplice(material);
    }
    this.#buried.clear();
    this.#pending.length = 0;
    this.#points.removeFromParent();
    this.#points.geometry.dispose();
    (this.#points.material as THREE.Material).dispose();
  }
}

interface Splice {
  hook: THREE.Material['onBeforeCompile'];
  key: THREE.Material['customProgramCacheKey'];
  ownHook: THREE.Material['onBeforeCompile'] | undefined;
  ownKey: THREE.Material['customProgramCacheKey'] | undefined;
}

const SCRATCH = new THREE.Color();
const SCRATCH_OUT = new THREE.Color();

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
      (1.0 - smoothstep(0.0, 0.3, last - s)) * smoothstep(0.0, 0.12, uSnow);
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
  // A seat's color — the roofs, mostly — is what says whose a building is,
  // and a roof gone white says nothing. So the team slot takes its snow
  // thin and in patches: plainly snowed on, with the color still the
  // larger part of it.
  team: /* glsl */ `
    {
      float lain = seasonNoise(vSeasonAt.xz * 2.4 + vSeasonAt.y);
      float depth = mix(0.2, 0.62, smoothstep(0.4, 0.65, lain));
      diffuseColor.rgb = mix(
        diffuseColor.rgb, uSnowColor,
        smoothstep(0.35, 0.8, vSeasonUp) *
          seasonCover(vSeasonAt, 0.3).x * depth);
    }
  `,
  // The ground is painted once, in summer's colors, and told apart here by
  // what those colors are: grass is green-to-gold and saturated, where
  // trodden earth is browner and rock is grey. Grass takes the full depth
  // of snow; a trail keeps showing through, and is the first to thaw.
  // The paving, which is a decal over the ground: snowed over as deep as
  // the grass beside it, with only the faintest line of it left, and the
  // first to show through again at the thaw.
  road: /* glsl */ `
    {
      vec2 cover = seasonCover(vSeasonAt, 0.2);
      diffuseColor.rgb *= 1.0 - 0.24 * cover.y;
      diffuseColor.rgb = mix(diffuseColor.rgb, uSnowColor, cover.x * 0.9);
    }
  `,
  ground: /* glsl */ `
    {
      vec3 c = diffuseColor.rgb;
      float grassy =
        smoothstep(0.83, 0.92, c.g / max(c.r, 0.001)) *
        (1.0 - smoothstep(0.62, 0.78, c.b / max(c.g, 0.001)));
      vec2 cover = seasonCover(vSeasonAt, (1.0 - grassy) * 0.3);
      // Where the snow has just gone the ground is dark and wet.
      c *= 1.0 - 0.24 * cover.y;
      diffuseColor.rgb = mix(c, uSnowColor, cover.x * mix(0.4, 0.94, grassy));
    }
  `,
};
