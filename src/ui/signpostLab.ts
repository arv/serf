import {createEffect, createRoot} from 'solid-js';
import * as THREE from 'three';
import {RoomEnvironment} from 'three/addons/environments/RoomEnvironment.js';
import {
  CSS3DObject,
  CSS3DRenderer,
} from 'three/addons/renderers/CSS3DRenderer.js';
import {mergeVertices} from 'three/addons/utils/BufferGeometryUtils.js';
import {BUILD_CHANNEL, BUILD_LABEL} from '../app/buildInfo';
import {snapBuildings} from '../protocol/snapshot';
import {loadGlbAssets} from '../render/assets';
import {BuildingSync} from '../render/buildingSync';
import {GrassField} from '../render/grassField';
import {HeightField} from '../render/heightField';
import {MarginMesh} from '../render/marginMesh';
import {Mist} from '../render/mist';
import {background} from '../render/palette';
import {GameRenderer} from '../render/renderer';
import {ScatterMesh} from '../render/scatterMesh';
import {TerrainMesh} from '../render/terrainMesh';
import {WaterMesh} from '../render/waterMesh';
import * as BuildingTypeId from '../sim/defs/buildingTypeIdEnum.ts';
import {MISSION_DEFS, MISSION_ORDER} from '../sim/defs/missions';
import * as PlayerKind from '../sim/playerKindEnum.ts';
import {createWorld} from '../sim/world';
import {isMissionComplete, isMissionUnlocked} from './campaign';
import {armFullscreen, fullscreen} from './fullscreen';
import {muted, toggleMuted} from './store';

/**
 * Throwaway lab for a game-like start screen: a signpost standing in front
 * of the valley, one arrow per mode. Clicking an arrow turns the signpost
 * round and moves in on that arrow: its back is the board, and the mode's
 * options are on it. Served at /signpost.html by the dev server; nothing in
 * the game imports it.
 *
 * Style: KayKit, not "realistic wood". Every piece is coloured from the
 * pack's own palette atlas (hexagons_medieval.png — a gradient per cell,
 * light at the top of the object, dark at the bottom), with fat rounded
 * bevels and smooth normals. Each arrow is one solid plank; from behind,
 * that plank is the board.
 *
 * One WebGL context, one loop: the signpost is parented to the valley
 * camera rather than drawn on a second canvas over it, and nothing is
 * blurred by CSS (a full-screen filter under a canvas that changes every
 * frame is what made the first cut stutter).
 */

type Mode = 'campaign' | 'skirmish' | 'multi';

const params = new URLSearchParams(location.search);
/** ?unlock=all opens every commission, to check the board without
 * touching the real campaign progress in storage. */
const UNLOCK_ALL = params.get('unlock') === 'all';

// ---------------------------------------------------------------- utilities

let seed = 20260923;
function rand(): number {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 2 ** 32;
}
const jitter = (a: number): number => (rand() * 2 - 1) * a;
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
const easeInOut = (t: number): number =>
  t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;

interface Tween {
  start: number;
  dur: number;
  fn(t: number): void;
  ease(t: number): number;
  done(): void;
}
const tweens = new Set<Tween>();
function tween(
  dur: number,
  fn: (t: number) => void,
  ease: (t: number) => number = easeInOut,
): Promise<void> {
  return new Promise(done => {
    tweens.add({start: performance.now(), dur, fn, ease, done});
  });
}
function runTweens(now: number): void {
  for (const tw of tweens) {
    const t = Math.min((now - tw.start) / tw.dur, 1);
    tw.fn(tw.ease(t));
    if (t === 1) {
      tweens.delete(tw);
      tw.done();
    }
  }
}

// ------------------------------------------------------------ KayKit paint

/** Atlas cells, [column, row] of the 8x4 grid. */
const CELL = {
  wood: [5, 0], // warm crate wood, #c8855f -> #9b5a45
  post: [7, 1], // weathered grey-brown, #837265 -> #534741
  bolt: [3, 0], // dark steel
} as const;
type Cell = readonly [number, number];

const atlas = new THREE.TextureLoader().load(
  '/models/kaykit/hexagons_medieval.png',
);
atlas.flipY = false;
atlas.colorSpace = THREE.SRGBColorSpace;
atlas.anisotropy = 4;

/** Same parameters as the pack's own material (roughness 0.5, no metal). */
const kayMat = new THREE.MeshStandardMaterial({
  map: atlas,
  roughness: 0.5,
  metalness: 0,
});

/**
 * Carved grain for the sign's wood. KayKit models have none — they are
 * seen from across a map — but the menu puts a plank a hand's width from
 * the lens, and there flat colour reads as plastic. So: game-art grain,
 * not a photograph. A few long soft wavy lines and the odd knot, drawn
 * white-on-grey and used twice — as a bump map (the lines are shallow
 * grooves that catch the light) and as an AO map (their troughs darken a
 * touch). Neither carries colour, so the palette stays the pack's.
 */
function grainTexture(): THREE.CanvasTexture {
  const W = 1024;
  const H = 512;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d')!;
  g.fillStyle = '#fff';
  g.fillRect(0, 0, W, H);
  const knots = [
    {x: W * 0.3, y: H * 0.34, r: 26},
    {x: W * 0.74, y: H * 0.7, r: 20},
  ];
  // How far a line at height y is pushed aside by the knots near x.
  const around = (x: number, y: number): number => {
    let d = 0;
    for (const k of knots) {
      const dx = (x - k.x) / (k.r * 5);
      const dy = y - k.y;
      const fall = Math.exp(-dx * dx);
      d +=
        Math.sign(dy || 1) *
        fall *
        k.r *
        1.6 *
        Math.exp(-Math.abs(dy) / (k.r * 2.5));
    }
    return d;
  };
  g.lineCap = 'round';
  g.filter = 'blur(1.2px)';
  const lines = 14;
  for (let i = 0; i < lines; i++) {
    const y0 = ((i + 0.5 + jitter(0.3)) / lines) * H;
    const amp = 3 + rand() * 7;
    const freq = (Math.PI * 2 * (1 + Math.floor(rand() * 2))) / W;
    const ph = rand() * 6.28;
    // Most lines run the full length (so the texture tiles); some stop.
    const whole = rand() < 0.65;
    const x0 = whole ? -20 : rand() * W * 0.6;
    const x1 = whole ? W + 20 : x0 + W * (0.25 + rand() * 0.35);
    g.strokeStyle = `rgba(0,0,0,${0.35 + rand() * 0.25})`;
    g.lineWidth = 3 + rand() * 3;
    g.beginPath();
    for (let x = x0; x <= x1; x += 8) {
      const y = y0 + Math.sin(x * freq + ph) * amp + around(x, y0);
      if (x === x0) g.moveTo(x, y);
      else g.lineTo(x, y);
    }
    g.stroke();
  }
  for (const k of knots) {
    for (let r = 0; r < 3; r++) {
      g.strokeStyle = `rgba(0,0,0,${0.55 - r * 0.12})`;
      g.lineWidth = 4;
      g.beginPath();
      g.ellipse(
        k.x,
        k.y,
        k.r * (0.45 + r * 0.45) * 1.8,
        k.r * (0.45 + r * 0.45) * 0.7,
        0,
        0,
        Math.PI * 2,
      );
      g.stroke();
    }
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  t.channel = 1;
  return t;
}
const grainTex = grainTexture();

/** Wood: the pack's material plus the grain (read through uv1). */
const woodMat = kayMat.clone();
woodMat.bumpMap = grainTex;
woodMat.bumpScale = 1.2;
woodMat.aoMap = grainTex;
woodMat.aoMapIntensity = 0.35;

/**
 * Lay the grain onto `geo` as a second uv set. Each vertex is projected
 * along its dominant normal axis — front and back take (x, y), top and
 * bottom (x, z), the ends (z, y) — and the grain runs along x, or along y
 * for an upright piece like the post. `offset` keeps two planks from
 * showing the same knot in the same place.
 */
function grain(
  geo: THREE.BufferGeometry,
  upright: boolean,
  offset: number,
): THREE.BufferGeometry {
  const pos = geo.getAttribute('position');
  const nrm = geo.getAttribute('normal');
  const uv1 = new Float32Array(pos.count * 2);
  /** World units per repeat, along and across the grain. */
  const ALONG = 2.4;
  const ACROSS = 1.1;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const ax = Math.abs(nrm.getX(i));
    const ay = Math.abs(nrm.getY(i));
    const az = Math.abs(nrm.getZ(i));
    let a: number;
    let b: number;
    if (az >= ax && az >= ay) [a, b] = upright ? [y, x] : [x, y];
    else if (ay >= ax) [a, b] = upright ? [z, x] : [x, z];
    else [a, b] = upright ? [y, z] : [z, y];
    uv1[i * 2] = a / ALONG + offset;
    uv1[i * 2 + 1] = b / ACROSS + offset * 0.37;
  }
  geo.setAttribute('uv1', new THREE.BufferAttribute(uv1, 2));
  return geo;
}

/**
 * Point every vertex of `geo` at one atlas cell, sampling down the cell's
 * gradient by height: light at `top`, dark at `bottom`. That is the whole
 * of how KayKit colours a model, so a piece painted this way sits beside
 * the pack's buildings without looking like a guest.
 */
function paint(
  geo: THREE.BufferGeometry,
  cell: Cell,
  bottom?: number,
  top?: number,
): THREE.BufferGeometry {
  const pos = geo.getAttribute('position');
  if (bottom === undefined || top === undefined) {
    geo.computeBoundingBox();
    bottom = geo.boundingBox!.min.y;
    top = geo.boundingBox!.max.y;
  }
  const uv = new Float32Array(pos.count * 2);
  const [c, r] = cell;
  for (let i = 0; i < pos.count; i++) {
    const h = THREE.MathUtils.clamp(
      (pos.getY(i) - bottom) / (top - bottom || 1),
      0,
      1,
    );
    uv[i * 2] = (c + 0.5) / 8;
    uv[i * 2 + 1] = (r + 0.06 + 0.88 * (1 - h)) / 4;
  }
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return geo;
}

/**
 * Extrude `pts` into a soft-edged piece `depth` thick, centred on z = 0.
 * The bevel is inset (bevelOffset), so the silhouette is exactly `pts`;
 * welding and smoothing the normals is what turns the bevel's steps into
 * the rounded edge the pack has everywhere.
 */
function extrude(
  pts: THREE.Vector2[],
  depth: number,
  bevel: number,
): THREE.BufferGeometry {
  const core = Math.max(depth - 2 * bevel, 0.001);
  const g = new THREE.ExtrudeGeometry(new THREE.Shape(pts), {
    depth: core,
    bevelEnabled: true,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelOffset: -bevel,
    bevelSegments: 4,
    curveSegments: 6,
  });
  g.translate(0, 0, -core / 2);
  g.deleteAttribute('normal');
  g.deleteAttribute('uv');
  const welded = mergeVertices(g, 1e-4);
  welded.computeVertexNormals();
  return welded;
}

/** A w by h rectangle, centred, with its two top corners rounded to r. */
function roundedTop(w: number, h: number, r: number): THREE.Vector2[] {
  const pts = [
    new THREE.Vector2(-w / 2, -h / 2),
    new THREE.Vector2(w / 2, -h / 2),
  ];
  const arc = (cx: number, from: number): void => {
    for (let i = 0; i <= 6; i++) {
      const a = from + (i / 6) * (Math.PI / 2);
      pts.push(
        new THREE.Vector2(cx + Math.cos(a) * r, h / 2 - r + Math.sin(a) * r),
      );
    }
  };
  arc(w / 2 - r, 0);
  arc(-w / 2 + r, Math.PI / 2);
  return pts;
}

function mesh(
  geo: THREE.BufferGeometry,
  mat: THREE.Material = kayMat,
): THREE.Mesh {
  return new THREE.Mesh(geo, mat);
}

/**
 * Studio light for the menu pieces only. The valley's sun sits behind the
 * post from where the lens stands, which left the wood a muddy brown; the
 * pack's own renders are lit soft and even from the front. An envMap on
 * the materials lights just these meshes and leaves the valley alone.
 * GameRenderer keeps its WebGLRenderer to itself, so the lab borrows it
 * from the first draw of the post.
 */
let glRenderer: THREE.WebGLRenderer | null = null;
let studio: THREE.Texture | null = null;
function bakeStudio(): void {
  if (studio || !glRenderer) return;
  const pmrem = new THREE.PMREMGenerator(glRenderer);
  studio = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  pmrem.dispose();
  ui.traverse(o => {
    const m = (o as THREE.Mesh).material as
      | THREE.MeshStandardMaterial
      | undefined;
    if (!m?.isMeshStandardMaterial) return;
    m.envMap = studio;
    m.envMapIntensity = 0.42;
    m.fog = false;
    m.needsUpdate = true;
  });
}

// ------------------------------------------------------------------ valley

/** Same seed and walk as the shipping backdrop (backdropScene.ts). */
const BACKDROP_SEED = 41207;
const EYE_HEIGHT = 6;
const ORBIT_RADIUS = 19;
const LOOK_HEIGHT = 2.8;
const START_ANGLE = 2.2;
const FOG_NEAR = 26;
const FOG_FAR = 100;

/**
 * The lens. Narrower than the backdrop's 46: the signpost rides in front
 * of it, and a long lens is what keeps a near object from bulging.
 */
const FOV = 32;
const TAN = Math.tan(THREE.MathUtils.degToRad(FOV / 2));

const canvas = document.getElementById('menu-canvas') as HTMLCanvasElement;
const camera = new THREE.PerspectiveCamera(FOV, 1, 0.3, 400);

/**
 * Everything of the menu hangs off the camera. In `ui` space the camera is
 * at the origin looking down -z; the whole of it is shrunk toward the lens,
 * so the post stands a few tiles off rather than nine — well clear of any
 * hill between it and the eye. `stage` is where the signpost stands; the
 * zoom onto an arrow is `stage` sliding toward the lens.
 */
const STAGE_DIST = 9.5;
const STAGE_Y = 1.5;
const UI_SCALE = 0.45;
const ui = new THREE.Group();
ui.scale.setScalar(UI_SCALE);
camera.add(ui);
const stage = new THREE.Group();
ui.add(stage);
const REST = new THREE.Vector3(0, -STAGE_Y, -STAGE_DIST);
const stageBase = REST.clone();

// ----------------------------------------------------------------- signpost

const post = new THREE.Group();
stage.add(post);
/** Half the post's thickness: the arrows are nailed to its front. */
const POST_HALF = 0.22;
/** Long enough that the post's foot is never on screen. */
const POST_LEN = 40;
{
  // A plain square post, its top just rounded off like every other edge
  // of the sign — no cap: one sat on it like a lid.
  const shaft = mesh(
    grain(
      // The gradient over the part you see — post space -1.2 to 3.6 — in
      // the shaft's own coordinates (its middle is POST_LEN / 2 below the
      // top at 3.4).
      paint(
        extrude(roundedTop(POST_HALF * 2, POST_LEN, 0.07), POST_HALF * 2, 0.09),
        CELL.post,
        POST_LEN / 2 - 4.6,
        POST_LEN / 2 + 0.2,
      ),
      true,
      0.13,
    ),
    woodMat,
  );
  // Top at 3.4; the rest runs down out of any frame, however tall the
  // screen and however high the signpost is lifted on it.
  shaft.position.y = 3.4 - POST_LEN / 2;
  post.add(shaft);
  shaft.onBeforeRender = r => {
    glRenderer ??= r;
  };
}

interface Arrow {
  mode: Mode;
  text: string;
  dir: 1 | -1;
  len: number;
  /** Pivot on the post: hover, tug and the straightening turn this. */
  root: THREE.Group;
  /** Turns the arrow about its own length (the War Council flip). Its
   * axis runs through the plank's middle, not the post. */
  spin: THREE.Group;
  planks: THREE.Mesh[];
  mat: THREE.MeshStandardMaterial;
  label: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshStandardMaterial>;
  /** The board: DOM on the arrow's back. */
  face: HTMLDivElement;
  faceObj: CSS3DObject;
  /** The War Council, made on first Host: DOM on the arrow's FRONT, where
   * the painted name is. The flip turns it up. */
  councilFace: HTMLDivElement | null;
  councilObj: CSS3DObject | null;
  inner: THREE.Group;
  baseY: number;
  yaw: number;
  tilt: number;
  vel: number;
  glow: number;
  /** The board on its back is the War Council, laid out for the closer
   * council zoom (see frameFor). */
  council: boolean;
}

const ARROW_H = 0.84;
const HEAD_H = 1.24;
const HEAD_L = 0.66;
const ARROW_D = 0.22;
/** Where the post crosses the arrow, measured from its tail. */
const THROUGH = 0.5;
/** Arrow body sits this far in front of the post's centre. */
const ARROW_Z = POST_HALF + ARROW_D / 2 + 0.01;
/** Clear of the post, on the arrow's own x axis (root space, tip-ward). */
const FACE_FROM = POST_HALF + 0.08;

/** Tail at x = 0, tip at x = len: a swallowtail, a plank, a fat head. */
function arrowOutline(len: number): THREE.Vector2[] {
  const hb = ARROW_H / 2;
  const hh = HEAD_H / 2;
  const neck = len - HEAD_L;
  return [
    new THREE.Vector2(0, -hb),
    new THREE.Vector2(neck, -hb),
    new THREE.Vector2(neck, -hh),
    new THREE.Vector2(len, 0),
    new THREE.Vector2(neck, hh),
    new THREE.Vector2(neck, hb),
    new THREE.Vector2(0, hb),
    new THREE.Vector2(0.2, 0),
  ];
}

const FONT = 'Lilita One';

/**
 * Comic lettering: fat face, thick dark outline, the outline dropped once
 * more below it for weight. Same recipe as the board's headings.
 */
function labelTexture(text: string, aspect: number): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.height = 200;
  c.width = Math.round(200 * aspect);
  const g = c.getContext('2d')!;
  let px = 120;
  const setFont = (): void => {
    g.font = `400 ${px}px "${FONT}"`;
  };
  setFont();
  g.letterSpacing = '2px';
  const fit = c.width * 0.9;
  const w = g.measureText(text).width;
  if (w > fit) px = Math.floor((px * fit) / w);
  setFont();
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.lineJoin = 'round';
  const x = c.width / 2;
  const y = 100 + px * 0.04;
  g.strokeStyle = g.fillStyle = '#3b1d10';
  g.lineWidth = px * 0.2;
  g.strokeText(text, x, y + px * 0.07);
  g.fillText(text, x, y + px * 0.07);
  g.strokeText(text, x, y);
  g.fillStyle = '#fff4dc';
  g.fillText(text, x, y);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

const ARROW_SPECS: {
  mode: Mode;
  text: string;
  y: number;
  dir: 1 | -1;
  len: number;
}[] = [
  {mode: 'campaign', text: 'Campaign', y: 2.65, dir: 1, len: 3.9},
  {mode: 'skirmish', text: 'Skirmish', y: 1.4, dir: -1, len: 3.8},
  {mode: 'multi', text: 'Multiplayer', y: 0.15, dir: 1, len: 4.0},
];

const css = new CSS3DRenderer();
css.domElement.id = 'css3d';
// The layer clips (overflow: hidden), and so it can still be scrolled: a
// click or focus on a button inside a turned board has the browser scroll
// it "into view", sliding every board sideways off its wood. Pin it.
css.domElement.addEventListener('scroll', () => {
  css.domElement.scrollLeft = 0;
  css.domElement.scrollTop = 0;
});
Object.assign(css.domElement.style, {position: 'fixed', inset: '0'});
document.body.appendChild(css.domElement);

const arrows: Arrow[] = [];
for (const spec of ARROW_SPECS) {
  const {dir, len} = spec;
  const root = new THREE.Group();
  root.position.y = spec.y;
  const yaw = dir * 0.1 + jitter(0.04);
  const tilt = dir * jitter(0.03);
  root.rotation.set(0, yaw, tilt);
  post.add(root);

  // Everything below is in root space: the post at x = 0, the arrow's tail
  // THROUGH behind it, the tip `dir * (len - THROUGH)` out along x.
  const toRoot = (p: THREE.Vector2): THREE.Vector2 =>
    new THREE.Vector2(dir * (p.x - THROUGH), p.y);
  const outline = arrowOutline(len).map(toRoot);
  if (dir < 0) outline.reverse(); // keep the winding counter-clockwise
  // One solid piece: its back is the board, and a groove running under
  // the controls reads as a seam in the UI, not as wood.
  const hh = HEAD_H / 2;
  const mat = woodMat.clone();
  const g = extrude(outline, ARROW_D, 0.05);
  g.translate(0, 0, ARROW_Z);
  const planks = [
    mesh(grain(paint(g, CELL.wood, -hh, hh), false, rand()), mat),
  ];
  // Everything of the arrow hangs in `inner`, which sits back at the root's
  // origin, inside `spin`, whose origin is the plank's middle.
  const spin = new THREE.Group();
  spin.position.z = ARROW_Z;
  const inner = new THREE.Group();
  inner.position.z = -ARROW_Z;
  spin.add(inner);
  root.add(spin);
  inner.add(...planks);

  // Front: painted lettering, from past the post to the neck of the head.
  const labelFrom = FACE_FROM + 0.05;
  const labelTo = len - THROUGH - HEAD_L;
  const labelW = labelTo - labelFrom;
  const labelH = ARROW_H * 0.8;
  const label = new THREE.Mesh(
    new THREE.PlaneGeometry(labelW, labelH),
    new THREE.MeshStandardMaterial({
      map: labelTexture(spec.text, labelW / labelH),
      transparent: true,
      roughness: 0.6,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -4,
    }),
  );
  label.position.set(
    (dir * (labelFrom + labelTo)) / 2,
    0,
    ARROW_Z + ARROW_D / 2 + 0.004,
  );
  inner.add(label);

  // A fat bolt where the arrow meets the post.
  const boltGeo = new THREE.SphereGeometry(
    0.08,
    12,
    6,
    0,
    Math.PI * 2,
    0,
    Math.PI / 2,
  );
  boltGeo.rotateX(Math.PI / 2);
  const bolt = mesh(paint(boltGeo, CELL.bolt));
  bolt.scale.z = 0.6;
  bolt.position.set(0, 0, ARROW_Z + ARROW_D / 2);
  inner.add(bolt);

  // Back: the board. It runs from past the post to the neck, and is turned
  // to face -z; from behind, the tip is at its far end, so the Play button
  // that goes there — flush with the neck, in line with the head's edges —
  // is the arrow pointing onward.
  // Its span and scale are set by placeFace(), per screen shape.
  const face = document.createElement('div');
  face.className = `face ${dir > 0 ? 'tip-start' : 'tip-end'}`;
  const faceObj = new CSS3DObject(face);
  // CSS3DObject sets pointer-events inline; a board turned away must not
  // swallow the clicks meant for the arrows. showFace() hands it back.
  face.style.pointerEvents = 'none';
  faceObj.rotation.y = Math.PI;
  faceObj.position.z = ARROW_Z - ARROW_D / 2 - 0.006;
  inner.add(faceObj);

  arrows.push({
    mode: spec.mode,
    text: spec.text,
    dir,
    len,
    root,
    spin,
    planks,
    mat,
    label,
    face,
    faceObj,
    councilFace: null,
    councilObj: null,
    inner,
    baseY: spec.y,
    yaw,
    tilt,
    vel: 0,
    glow: 0,
    council: false,
  });
}

// ------------------------------------------------------------ board faces

const esc = (s: string): string =>
  s.replace(
    /[&<>"]/g,
    c => `&${{'&': 'amp', '<': 'lt', '>': 'gt', '"': 'quot'}[c]};`,
  );
interface Room {
  code: string;
  filled: number;
  total: number;
  ai: number;
  /** Minutes since it opened. */
  age: number;
}
/** Stand-ins for the relay's open-room list (the lab talks to no server).
 * ?rooms=none shows the empty board, ?rooms=many a busy evening. */
const ROOMS: Room[] = (() => {
  const few: Room[] = [
    {code: 'KXQ7B', filled: 2, total: 4, ai: 1, age: 2},
    {code: 'MOSS3', filled: 1, total: 2, ai: 0, age: 0},
    {code: 'FJORD', filled: 3, total: 3, ai: 0, age: 5},
  ];
  const which = params.get('rooms');
  if (which === 'none') return [];
  if (which !== 'many') return few;
  const codes = [
    'KXQ7B',
    'MOSS3',
    'FJORD',
    'BRAN8',
    'OAKEN',
    'TW1LL',
    'HEATH',
    'RIVA2',
    'STONE',
    'MILLR',
    'QUAY5',
    'GLEN7',
  ];
  return codes.map((code, i) => {
    const total = 2 + (i % 3);
    return {
      code,
      total,
      filled: Math.min(total, 1 + ((i * 7) % 4)),
      ai: i % 4 === 1 ? 1 : 0,
      age: (i * 3) % 11,
    };
  });
})();

/** The order a player wants them in: rooms with a free seat first, the
 * newest of those first; full rooms last. */
function sortRooms(rooms: Room[]): Room[] {
  return [...rooms].sort((a, b) => {
    const fa = a.filled >= a.total ? 1 : 0;
    const fb = b.filled >= b.total ? 1 : 0;
    return fa - fb || a.age - b.age;
  });
}
const REFRESH = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v5h-5"/></svg>`;
const LOCK = `<svg width="18" height="18" viewBox="0 0 16 16" fill="currentColor"><path d="M5 7V5a3 3 0 0 1 6 0v2h.5A1.5 1.5 0 0 1 13 8.5v5A1.5 1.5 0 0 1 11.5 15h-7A1.5 1.5 0 0 1 3 13.5v-5A1.5 1.5 0 0 1 4.5 7H5zm1.5 0h3V5a1.5 1.5 0 0 0-3 0v2z"/></svg>`;

function head(title: string, sub: string): string {
  return `<header><h2 class="comic">${title}</h2><span class="sub">${sub}</span>
    <button class="back" data-back>Back</button></header>`;
}
function seg(options: string[], on: number): string {
  return `<div class="seg">${options
    .map((o, i) => `<button aria-pressed="${i === on}">${o}</button>`)
    .join('')}</div>`;
}

function fillFace(a: Arrow): void {
  const face = a.face;
  if (a.mode === 'campaign') {
    const done = MISSION_ORDER.filter(isMissionComplete).length;
    const stops = MISSION_ORDER.map((id, i) => {
      const open = UNLOCK_ALL || isMissionUnlocked(id);
      return `<button class="stop ${open ? '' : 'locked'} ${i === 0 ? 'sel' : ''}" data-i="${i}">${
        open ? i + 1 : LOCK
      }</button>`;
    }).join('<span class="trail"></span>');
    const m0 = MISSION_DEFS[MISSION_ORDER[0]!];
    face.innerHTML = `<button class="go">Play</button>
      <div class="main">${head('Campaign', `${done} of ${MISSION_ORDER.length} done`)}
        <div class="path">${stops}</div>
        <div class="pick"><span class="t">${esc(m0.title)}</span><span class="d">${esc(m0.tagline)}</span></div>
      </div>`;
    for (const b of face.querySelectorAll<HTMLButtonElement>(
      '.stop:not(.locked)',
    )) {
      b.addEventListener('click', () => {
        for (const o of face.querySelectorAll('.stop'))
          o.classList.toggle('sel', o === b);
        const m = MISSION_DEFS[MISSION_ORDER[Number(b.dataset.i)]!];
        face.querySelector('.pick')!.innerHTML =
          `<span class="t">${esc(m.title)}</span><span class="d">${esc(m.tagline)}</span>`;
      });
    }
  } else if (a.mode === 'skirmish') {
    face.innerHTML = `<button class="go">Play</button>
      <div class="main">${head('Skirmish', 'A fresh valley vs the AI')}
        <div class="grid">
          <div class="field"><label>Rivals</label>${seg(['1', '2', '3'], 0)}</div>
          <div class="field"><label>Difficulty</label>${seg(['Easy', 'Normal', 'Hard'], 1)}</div>
          <div class="field"><label>Map</label>${seg(['Small', 'Medium', 'Large'], 1)}</div>
          <div class="field"><label>Bandits</label>${seg(['Off', 'On'], 1)}</div>
        </div>
      </div>`;
  } else {
    // Two separate choices, not one form. Host, at the tip, makes a room
    // and goes straight to the War Council, where its code and the Invite
    // button are. Everything else is joining: open rooms as tickets, and a
    // code box that a picked ticket fills in, so one Join serves listed and
    // private rooms. (Open/Private is left to the council: it is a setting
    // of the room, and a new room is listed.)
    face.classList.add('mp');
    face.innerHTML = `<div class="tipcol"><button class="go">Host</button>
        <span class="hint">Makes a room with a code to share</span></div>
      <div class="main">${head('Multiplayer', 'Play with friends')}
        <div class="rooms"><span class="lbl">Open rooms<span class="n"></span></span>
          <div class="tickets"></div>
          <button class="refresh" title="Refresh">${REFRESH}</button></div>
        <div class="join"><label>Have a code?</label>
          <input maxlength="6" placeholder="ABCDE" spellcheck="false" autocomplete="off" />
          <button class="go small">Join</button></div>
      </div>`;
    const input = face.querySelector('input')!;
    const tickets = face.querySelector<HTMLElement>('.tickets')!;
    const count = face.querySelector<HTMLElement>('.rooms .n')!;
    /** Fade whichever end of the row still has tickets past it. */
    const edges = (): void => {
      const across = tickets.scrollWidth > tickets.clientWidth + 1;
      const el = tickets;
      const [pos, room] = across
        ? [el.scrollLeft, el.scrollWidth - el.clientWidth]
        : [el.scrollTop, el.scrollHeight - el.clientHeight];
      el.classList.toggle('more-before', room > 1 && pos > 1);
      el.classList.toggle('more-after', room > 1 && pos < room - 1);
    };
    tickets.addEventListener('scroll', edges, {passive: true});
    // A mouse wheel scrolls the row sideways: nobody has a sideways wheel.
    tickets.addEventListener(
      'wheel',
      e => {
        if (
          tickets.scrollWidth <= tickets.clientWidth + 1 ||
          Math.abs(e.deltaX) > Math.abs(e.deltaY)
        )
          return;
        e.preventDefault();
        tickets.scrollBy({left: e.deltaY, behavior: 'smooth'});
      },
      {passive: false},
    );
    const renderRooms = (): void => {
      const rooms = sortRooms(ROOMS);
      const open = rooms.filter(r => r.filled < r.total).length;
      count.textContent = rooms.length ? ` · ${open}` : '';
      tickets.innerHTML = rooms.length
        ? rooms
            .map(r => {
              const full = r.filled >= r.total;
              const pips = Array.from(
                {length: r.total},
                (_, i) => `<i class="${i < r.filled ? 'on' : ''}"></i>`,
              ).join('');
              const meta = full
                ? 'full'
                : r.ai
                  ? `${r.ai} AI`
                  : r.age
                    ? `${r.age} min`
                    : 'new';
              return `<button class="ticket" data-code="${r.code}" ${full ? 'disabled' : ''}>
              <span class="code">${r.code}</span><span class="pips">${pips}</span>
              <span class="meta">${meta}</span></button>`;
            })
            .join('')
        : `<span class="none">None right now. Host one, or use a code.</span>`;
      for (const t of tickets.querySelectorAll<HTMLButtonElement>(
        '.ticket:not([disabled])',
      )) {
        t.addEventListener('click', () => {
          const on = !t.classList.contains('sel');
          for (const o of tickets.querySelectorAll('.ticket'))
            o.classList.remove('sel');
          t.classList.toggle('sel', on);
          input.value = on ? t.dataset.code! : '';
        });
      }
    };
    renderRooms();
    requestAnimationFrame(edges);
    new ResizeObserver(edges).observe(tickets);
    input.addEventListener('input', () => {
      input.value = input.value
        .replace(/[^a-zA-Z0-9]/g, '')
        .toUpperCase()
        .slice(0, 6);
      for (const o of tickets.querySelectorAll('.ticket'))
        o.classList.toggle(
          'sel',
          (o as HTMLElement).dataset.code === input.value,
        );
    });
    const refresh = face.querySelector<HTMLButtonElement>('.refresh')!;
    refresh.addEventListener('click', () => {
      refresh.classList.remove('spin');
      void refresh.offsetWidth;
      refresh.classList.add('spin');
      renderRooms();
    });
  }
  wireSegs(face);
  face
    .querySelector('[data-back]')!
    .addEventListener('click', () => void close());
  face
    .querySelector('.tipcol .go')
    ?.addEventListener('click', () => void hostCouncil(a));
}

function wireSegs(face: HTMLElement): void {
  for (const s of face.querySelectorAll('.seg')) {
    s.addEventListener('click', e => {
      const b = (e.target as HTMLElement).closest('button');
      if (!b) return;
      for (const o of s.querySelectorAll('button'))
        o.setAttribute('aria-pressed', String(o === b));
    });
  }
}

// ---------------------------------------------------------- the War Council

/** A banner colour per seat, as the council shows them. */
const SEAT_COLORS = ['#3d7bd9', '#d9463d', '#e0b52e', '#4fa35a'];
let council: Arrow | null = null;
let joinTimer = 0;

function roomCode(): string {
  const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from(
    {length: 5},
    () => abc[Math.floor(Math.random() * abc.length)],
  ).join('');
}

function seatsHTML(names: (string | null)[]): string {
  return names
    .map((n, i) =>
      n
        ? `<span class="seat"><i style="background:${SEAT_COLORS[i]}"></i>${esc(n)}</span>`
        : `<span class="seat open"><i></i>Open<span class="w"> seat</span></span>`,
    )
    .join('');
}

/**
 * The War Council, on the same board: where hosting lands. The room code
 * with Invite and who can find the room, the seats as friends fill them,
 * and the match settings everyone at the table watches change. Begin, at
 * the tip, starts it for everyone.
 */
function fillCouncil(a: Arrow): void {
  const face = councilFaceOf(a);
  const code = roomCode();
  face.innerHTML = `<div class="tipcol"><button class="go">Begin</button></div>
    <div class="main">
      <header><h2 class="comic">War Council</h2><button class="back" data-leave>Leave</button></header>
      <div class="code-row"><span class="lbl">Room</span><span class="code">${code}</span>
        <button class="invite">Invite</button>${seg(['Listed', 'Invite only'], 0)}</div>
      <div class="seats">${seatsHTML(['You', null, null, null])}</div>
      <div class="settings">
        <label>AI seats</label>${seg(['0', '1', '2', '3'], 0)}
        ${seg(['Easy', 'Normal', 'Hard'], 1)}
        <label>Raids</label>${seg(['Off', 'On'], 1)}
      </div>
      <div class="log"></div>
      <input class="chat" placeholder="Say to the table…" maxlength="120" />
    </div>`;
  wireSegs(face);
  face
    .querySelector('[data-leave]')!
    .addEventListener('click', () => void leaveCouncil());
  const invite = face.querySelector<HTMLButtonElement>('.invite')!;
  invite.addEventListener('click', () => {
    void navigator.clipboard
      ?.writeText(`${location.origin}/?join=${code}`)
      .catch(() => {});
    invite.textContent = 'Copied!';
    setTimeout(() => (invite.textContent = 'Invite'), 1400);
  });
  // Table talk: lines in, newest at the bottom, and what you type goes on
  // the end under your own banner.
  const log = face.querySelector<HTMLElement>('.log')!;
  const say = (
    who: string | null,
    text: string,
    color = SEAT_COLORS[0],
  ): void => {
    const line = document.createElement('div');
    line.className = who ? 'line' : 'line note';
    line.innerHTML = who
      ? `<b style="--c:${color}">${esc(who)}</b> ${esc(text)}`
      : esc(text);
    log.append(line);
    log.scrollTop = log.scrollHeight;
  };
  say(null, `Room ${code} is open. Invite a friend, or add AI seats.`);
  const chat = face.querySelector<HTMLInputElement>('.chat')!;
  chat.addEventListener('keydown', e => {
    if (e.key !== 'Enter' || !chat.value.trim()) return;
    say('You', chat.value.trim());
    chat.value = '';
  });
  // The lab has no relay: a friend takes a seat after a moment, and says
  // something, so the board can be seen to change.
  clearTimeout(joinTimer);
  joinTimer = window.setTimeout(() => {
    if (council !== a) return;
    face.querySelector('.seats')!.innerHTML = seatsHTML([
      'You',
      'Wren',
      null,
      null,
    ]);
    say(null, 'Wren took a seat.');
    joinTimer = window.setTimeout(() => {
      if (council === a) say('Wren', 'hi! ready when you are', SEAT_COLORS[1]);
    }, 1400);
  }, 3000);
}

const FLIP_MS = 900;

/**
 * The council's board, on the front of the arrow: made on first use, the
 * same way the back's is. Upside down on purpose — the flip that brings
 * the front round (a half turn about the arrow's length) turns it the
 * right way up.
 */
function councilFaceOf(a: Arrow): HTMLDivElement {
  if (a.councilFace) return a.councilFace;
  const face = document.createElement('div');
  face.className = `face council ${a.dir > 0 ? 'tip-start' : 'tip-end'}`;
  const obj = new CSS3DObject(face);
  face.style.pointerEvents = 'none';
  obj.rotation.z = Math.PI;
  obj.position.z = ARROW_Z + ARROW_D / 2 + 0.006;
  a.inner.add(obj);
  a.councilFace = face;
  a.councilObj = obj;
  placeCouncilFace(a);
  return face;
}

function placeCouncilFace(a: Arrow): void {
  if (a.councilFace && a.councilObj)
    place(a.councilFace, a.councilObj, a, true);
}

/**
 * Flip the arrow a half turn about its length, bringing its front — and
 * the council painted there — round to the lens (or its back again), while
 * the lens moves in for the council (or back out). The painted name goes
 * as the front comes round edge-on: the council has the board to itself.
 */
async function flipBoard(a: Arrow, toCouncil: boolean): Promise<void> {
  busy = true;
  const from = stageBase.clone();
  const to = focusBase(a, toCouncil);
  const r0 = a.spin.rotation.x;
  const r1 = toCouncil ? Math.PI : 0;
  let swapped = false;
  await tween(FLIP_MS, t => {
    a.spin.rotation.x = lerp(r0, r1, t);
    stageBase.lerpVectors(from, to, t);
    if (!swapped && t >= 0.5) {
      swapped = true;
      a.council = toCouncil;
      a.label.visible = !toCouncil;
    }
  });
  busy = false;
}

function activateCouncil(a: Arrow, on: boolean): void {
  if (!a.councilFace) return;
  a.councilFace.classList.toggle('active', on);
  a.councilFace.style.pointerEvents = on ? 'auto' : 'none';
}

async function hostCouncil(a: Arrow): Promise<void> {
  if (busy || council) return;
  council = a;
  activate(a, false);
  fillCouncil(a);
  await flipBoard(a, true);
  activateCouncil(a, true);
}

async function leaveCouncil(): Promise<void> {
  const a = council;
  if (!a || busy) return;
  council = null;
  clearTimeout(joinTimer);
  activateCouncil(a, false);
  await flipBoard(a, false);
  activate(a, true);
}

// ------------------------------------------------------------------- layout

/**
 * How a board sits on the screen — one rule for every window, phone to
 * ultrawide, rather than a phone mode and a desktop mode.
 *
 * The lens shows R units of the arrow across the width. R comes from the
 * window: one unit per `perUnit` CSS pixels (a wide window shows the whole
 * arrow, post to tip; a narrow one less), never so little that the arrow is
 * taller than `cap` of the screen. What goes out of view as R shrinks: the
 * post side first, then — for the council, first of all — the arrowhead.
 * The board itself is the last thing cropped.
 *
 * The board's own layout then follows the space it got: pixels per unit are
 * the screen's, divided by a text scale that grows gently with the window.
 * So a big window lays the board out wide and draws it big, a phone lays it
 * out narrow (under 560px the boards restack, see .narrow) and draws it at
 * about its CSS size, and every window between gets something between.
 */
interface Frame {
  /** The board's stretch of the arrow, root space, tip-ward from the post. */
  face: [number, number];
  /** What the lens fits across the width, same space. */
  view: [number, number];
  /** CSS pixels per world unit for the board's layout. */
  px: number;
  /** Laid out narrow: restacked (.narrow). */
  narrow: boolean;
}

const FILL = 0.95;
/**
 * Below this layout width a board restacks (.narrow): what its wide layout
 * needs to fit. The council's wide layout — Begin column, code row with
 * Invite and Listed/Invite only, four seats, three settings in a row — is
 * much the widest.
 */
const narrowBelow = (council: boolean): number => (council ? 960 : 640);

function frameFor(a: Arrow, council: boolean): Frame {
  const W = innerWidth;
  const aspect = camera.aspect;
  const tip = a.len - THROUGH;
  const neck = tip - HEAD_L;
  const faceMax = neck - FACE_FROM;
  // The council wants its board big — it has the chat — so it closes in
  // much further, and gives up the arrowhead before any of the board.
  const perUnit = council ? 1000 : 380;
  const cap = council ? 0.92 : 0.62;
  const minFace = council ? Infinity : 1;
  const whole = tip - POST_HALF + 0.15;
  const R = Math.max(Math.min(W / perUnit, whole), (HEAD_H * aspect) / cap);
  const faceW = Math.min(faceMax, R, Math.max(minFace, R - HEAD_L));
  const face: [number, number] = [neck - faceW, neck];
  const view: [number, number] =
    R <= faceW + HEAD_L ? [face[0], face[0] + R] : [tip - R, tip];
  // Text scale: about CSS size on a phone, growing with the window — but
  // never so large that the board's layout gets less height than its
  // contents need (a phone held sideways has hardly any): the wide layouts
  // want ~212px, the stacked narrow one ~290, and the council more.
  const onScreen = (W * FILL) / R;
  const tallEnough = (h: number): number => (ARROW_H * 0.9 * onScreen) / h;
  let k = Math.min(Math.max(0.8, W / 1070), tallEnough(council ? 400 : 212));
  const narrow = faceW * (onScreen / k) < narrowBelow(council);
  if (narrow) k = Math.min(k, tallEnough(council ? 440 : 290));
  return {face, view, px: onScreen / k, narrow};
}

function place(
  face: HTMLDivElement,
  obj: CSS3DObject,
  a: Arrow,
  council: boolean,
): void {
  const {
    face: [from, to],
    px,
    narrow,
  } = frameFor(a, council);
  face.style.width = `${(to - from) * px}px`;
  face.style.height = `${ARROW_H * 0.9 * px}px`;
  face.classList.toggle('narrow', narrow);
  obj.scale.setScalar(1 / px);
  obj.position.x = (a.dir * (from + to)) / 2;
}

/** The board on the arrow's back. */
function placeFace(a: Arrow): void {
  place(a.face, a.faceObj, a, false);
}

let postX = 0;
let postY = 0;

function computeLayout(): void {
  const aspect = camera.aspect;
  const halfW = STAGE_DIST * TAN * aspect;
  const wide = aspect > 1.15;
  // The widest the signpost gets: the longest arrow each way from the post.
  const span = 2 * (4.0 - THROUGH);
  const s = Math.min(0.7, (halfW * 2 * 0.94) / span);
  post.scale.setScalar(s);
  // Right of centre on a wide screen, so the keep (pushed left by the
  // lens) stays in view.
  postX = wide ? halfW * 0.1 : 0;
  // On a screen taller than wide the signpost shrinks to fit the width and
  // would sit low under an empty sky; lift its arrows toward the middle,
  // more the taller the screen.
  const arrowsMid = (ARROW_SPECS[0]!.y + ARROW_SPECS[2]!.y) / 2;
  const lift = THREE.MathUtils.clamp((1 - aspect) / 0.4, 0, 1);
  postY = lift * (STAGE_Y - arrowsMid * s - 0.2);
  post.position.set(postX, postY, 0);
  for (const a of arrows) {
    placeFace(a);
    placeCouncilFace(a);
  }
}

/**
 * Where `stage` has to be for `a`'s board to be framed as frameFor says,
 * with the post turned half round and the arrow straightened.
 */
function focusBase(a: Arrow, council = a.council): THREE.Vector3 {
  const s = post.scale.x;
  const [from, to] = frameFor(a, council).view;
  const mid = (a.dir * (from + to)) / 2;
  const back = ARROW_Z - ARROW_D / 2;
  // Post turned by pi about y: (x, y, z) -> (-x, y, -z), then scaled and
  // placed.
  const c = new THREE.Vector3(postX - s * mid, postY + s * a.baseY, -s * back);
  const depth = ((to - from) * s) / (FILL * 2 * TAN * camera.aspect);
  return new THREE.Vector3(0, 0, -depth).sub(c);
}

// -------------------------------------------------------------- transitions

/**
 * The boards are always there, painted on the arrows' backs: they turn in
 * and out of view with the wood (backface-visibility hides a board whose
 * arrow faces front). All this toggles is which one takes the pointer.
 */
function activate(a: Arrow, on: boolean): void {
  a.face.classList.toggle('active', on);
  a.face.style.pointerEvents = on ? 'auto' : 'none';
}

let current: Arrow | null = null;
let busy = false;

const TURN_MS = 1150;

async function select(a: Arrow): Promise<void> {
  if (busy || current === a) return;
  busy = true;
  current = a;
  document.body.classList.add('open');
  const from = stageBase.clone();
  const to = focusBase(a);
  const r0 = post.rotation.y;
  const y0 = a.root.rotation.y;
  const z0 = a.root.rotation.z;
  await tween(TURN_MS, t => {
    // The turn leads, the move follows a little behind: it reads as the
    // signpost being turned toward you rather than the camera flying.
    post.rotation.y = lerp(r0, Math.PI, t);
    stageBase.lerpVectors(from, to, easeInOut(Math.min(1, t * 1.15)));
    a.root.rotation.y = lerp(y0, 0, t);
    a.root.rotation.z = lerp(z0, 0, t);
  });
  activate(a, true);
  busy = false;
}

async function close(): Promise<void> {
  const a = current;
  if (!a || busy) return;
  busy = true;
  activate(a, false);
  document.body.classList.remove('open');
  const from = stageBase.clone();
  const r0 = post.rotation.y;
  await tween(TURN_MS, t => {
    post.rotation.y = lerp(r0, 0, t);
    stageBase.lerpVectors(from, REST, t);
    a.root.rotation.y = lerp(0, a.yaw, t);
    a.root.rotation.z = lerp(0, a.tilt, t);
  });
  a.vel = -2.5;
  current = null;
  busy = false;
}

// -------------------------------------------------------------------- input

const ray = new THREE.Raycaster();
const eye = new THREE.Vector3();
const facePos = new THREE.Vector3();
const faceQuat = new THREE.Quaternion();
const normal = new THREE.Vector3();
const pointer = new THREE.Vector2(9, 9);
const parallax = new THREE.Vector2();
/** Where the sway leans toward: the mouse, and only the mouse. A finger
 * leaves no position between taps, and a lean toward its last tap would
 * slide the board off-centre on a phone. */
const leanTo = new THREE.Vector2();
let hovered: Arrow | null = null;

window.addEventListener('pointermove', e => {
  pointer.set(
    (e.clientX / innerWidth) * 2 - 1,
    -(e.clientY / innerHeight) * 2 + 1,
  );
  if (e.pointerType === 'mouse') leanTo.copy(pointer).clampScalar(-1, 1);
});
/** The arrow under a screen point, if any — asked at the click itself, so
 * a click that lands before the next frame's hover test still counts. */
function arrowAt(x: number, y: number): Arrow | null {
  ray.setFromCamera(
    new THREE.Vector2((x / innerWidth) * 2 - 1, -(y / innerHeight) * 2 + 1),
    camera,
  );
  const hit = ray.intersectObjects(
    arrows.flatMap(a => a.planks),
    false,
  )[0];
  return arrows.find(a => a.planks.includes(hit?.object as THREE.Mesh)) ?? null;
}

window.addEventListener('click', e => {
  if ((e.target as HTMLElement).closest('.face, #footer, #opts, #build'))
    return;
  const target = busy || current ? null : arrowAt(e.clientX, e.clientY);
  if (target) void select(target);
  else if (council && !busy) void leaveCouncil();
  else if (current && !busy) void close();
});
// iOS Safari only applies :active to a touch when something is listening
// for touches; without this, a finger on a board button shows no press.
document.addEventListener('touchstart', () => {}, {passive: true});

window.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  if (council) void leaveCouncil();
  else void close();
});

function relabel(): void {
  for (const a of arrows) {
    const {width, height} = a.label.geometry.parameters;
    a.label.material.map?.dispose();
    a.label.material.map = labelTexture(a.text, width / height);
    a.label.material.needsUpdate = true;
  }
}

// ------------------------------------------------------------------ options

/**
 * Sound and full screen: two switches a player may want at any moment, so
 * they are round buttons in the corner rather than anything on the
 * signpost — one tap from the crossroads or from any board. They drive the
 * same store and fullscreen module the real menu does.
 */
/**
 * Drawn like the lettering: cream, with a dark outline. Every line is laid
 * twice — a wide ink stroke, then the cream one on top — and the speaker's
 * body is filled cream over an ink stroke (paint-order), so the outline is
 * the same weight all round.
 */
const INK = 'var(--ink)';
const CREAM = 'var(--cream)';
function outlined(paths: string, width: number): string {
  return `<g fill="none" stroke-linecap="round" stroke-linejoin="round">
    <g stroke="${INK}" stroke-width="${width + 2.2}">${paths}</g>
    <g stroke="${CREAM}" stroke-width="${width}">${paths}</g></g>`;
}
const SPEAKER = `<path d="M2.6 6.1h2.3L8.2 3.2v9.6L4.9 9.9H2.6a.9.9 0 0 1-.9-.9V7a.9.9 0 0 1 .9-.9Z"
  fill="${CREAM}" stroke="${INK}" stroke-width="2.2" stroke-linejoin="round" paint-order="stroke"/>`;
const svg = (body: string): string =>
  `<svg viewBox="-1 -1 18 18" width="34" height="34">${body}</svg>`;
const ICONS = {
  soundOn: svg(
    SPEAKER +
      outlined(
        '<path d="M10.5 6.3a2.6 2.6 0 0 1 0 3.4"/><path d="M12.6 4.4a5.3 5.3 0 0 1 0 7.2"/>',
        1.4,
      ),
  ),
  soundOff: svg(
    SPEAKER +
      outlined(
        '<path d="M10.9 6.2l3.6 3.6"/><path d="M14.5 6.2l-3.6 3.6"/>',
        1.5,
      ),
  ),
  // Four corners pointing out: go full screen. Pointing in: come back.
  fsEnter: svg(
    outlined(
      '<path d="M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10"/>',
      1.7,
    ),
  ),
  fsExit: svg(
    outlined(
      '<path d="M6 2.5V6H2.5M13.5 6H10V2.5M10 13.5V10h3.5M2.5 10H6v3.5"/>',
      1.7,
    ),
  ),
};

/** The old footer's line: which build, which channel, and the two pages a
 * player must be able to reach. */
function mountBuild(): void {
  const el = document.getElementById('build')!;
  el.innerHTML = `SERF VALLEY · build ${esc(BUILD_LABEL)}${
    BUILD_CHANNEL === 'staging' ? ' · staging' : ''
  } · <a href="/docs/credits">Credits</a> · <a href="/docs/license">License</a>`;
}

function mountOptions(): void {
  const sound = document.getElementById('opt-sound') as HTMLButtonElement;
  const full = document.getElementById('opt-full') as HTMLButtonElement;
  sound.addEventListener('click', () => toggleMuted());
  full.addEventListener('click', () => fullscreen().toggle());
  armFullscreen();
  createRoot(() => {
    createEffect(() => {
      const off = muted();
      sound.innerHTML = off ? ICONS.soundOff : ICONS.soundOn;
      sound.setAttribute('aria-pressed', String(!off));
      sound.setAttribute('aria-label', off ? 'Sound off' : 'Sound on');
      sound.title = off ? 'Sound: off' : 'Sound: on';
    });
    createEffect(() => {
      const fs = fullscreen();
      full.hidden = !fs.offerable();
      const on = fs.active();
      full.innerHTML = on ? ICONS.fsExit : ICONS.fsEnter;
      full.setAttribute('aria-pressed', String(on));
      full.setAttribute('aria-label', 'Full screen');
      full.title = on ? 'Leave full screen' : 'Full screen';
    });
  });
}

// --------------------------------------------------------------------- boot

async function main(): Promise<void> {
  await Promise.all([
    loadGlbAssets(),
    document.fonts.load(`100px "${FONT}"`),
    document.fonts.load('800 20px Nunito'),
  ]);
  relabel();
  for (const a of arrows) fillFace(a);
  mountOptions();
  mountBuild();

  const world = createWorld({
    seed: BACKDROP_SEED,
    players: [{kind: PlayerKind.human}],
    adminEnabled: false,
    banditsEnabled: false,
  });
  const renderer = new GameRenderer(canvas, {interactive: false});
  renderer.setWorldExtent(world.map.play, world.map.size);
  renderer.scene.fog = new THREE.Fog(background, FOG_NEAR, FOG_FAR);
  const heights = new HeightField(world.map.height, world.map.size);
  const water = new WaterMesh(world.map);
  const mist = new Mist(world.map);
  renderer.scene.add(
    new TerrainMesh(world.map, heights).group,
    new ScatterMesh(world.map, heights).group,
    new GrassField(world.map, heights).mesh,
    water.mesh,
    new MarginMesh(world.map, heights).mesh,
    mist.group,
    camera,
  );
  const buildings = new BuildingSync(renderer.scene, heights);
  buildings.cameraQuaternion = camera.quaternion;
  buildings.update(snapBuildings(world));

  const keep = [...world.buildings.values()].find(
    b => b.type === BuildingTypeId.storehouse,
  );
  const half = world.map.size / 2;
  const cx = keep ? keep.x + keep.w / 2 : half;
  const cz = keep ? keep.y + keep.h / 2 : half;
  const groundY = heights.at(cx, cz);

  const fit = (): void => {
    camera.aspect = innerWidth / Math.max(innerHeight, 1);
    camera.updateProjectionMatrix();
    css.setSize(innerWidth, innerHeight);
    computeLayout();
    if (current && !busy) stageBase.copy(focusBase(current));
  };
  window.addEventListener('resize', fit);
  fit();

  const still =
    window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
  let last = performance.now();
  const loop = (now: number): void => {
    requestAnimationFrame(loop);
    // At most one frame in flight — see GameRenderer.gpuReady.
    if (!renderer.gpuReady()) return;
    const dt = Math.min((now - last) / 1000, 0.05);
    last = now;
    runTweens(now);

    // The valley: a slow sway rather than the backdrop's full orbit — the
    // post is lit by the valley's sun, and a full turn would walk it into
    // back-light.
    parallax.lerp(leanTo, 1 - Math.exp(-dt * 3));
    const t = still ? 0 : now / 60000;
    const angle =
      START_ANGLE + Math.sin(t * Math.PI * 2) * 0.12 - parallax.x * 0.015;
    const room = THREE.MathUtils.clamp((camera.aspect - 1) / 0.8, 0, 1);
    camera.position.set(
      cx + Math.sin(angle) * ORBIT_RADIUS,
      groundY + EYE_HEIGHT + Math.sin(t * 4) * 0.3,
      cz + Math.cos(angle) * ORBIT_RADIUS,
    );
    camera.lookAt(cx, groundY + LOOK_HEIGHT, cz);
    camera.rotateY(-0.2 * room);
    // The menu leans against the pointer, which is what sells the depth.
    // Squared distance: the lean shrinks faster than the view does as the
    // lens closes in, so at the crossroads it sways and in front of a
    // board — on a phone held upright, very close — it barely moves the
    // board at all.
    const lean = (-stageBase.z / STAGE_DIST) ** 2;
    stage.position.set(
      stageBase.x - parallax.x * 0.18 * lean,
      stageBase.y - parallax.y * 0.1 * lean,
      stageBase.z,
    );

    ray.setFromCamera(pointer, camera);
    const hit = ray.intersectObjects(
      arrows.flatMap(a => a.planks),
      false,
    )[0];
    hovered =
      busy || current
        ? null
        : (arrows.find(a => a.planks.includes(hit?.object as THREE.Mesh)) ??
          null);
    document.body.style.cursor = hovered ? 'pointer' : '';

    for (const a of arrows) {
      if (a !== current) {
        const lit = a === hovered;
        const want =
          a.yaw +
          (lit ? -0.18 * Math.sign(a.yaw || 1) : 0) +
          Math.sin(now / 1100 + a.baseY * 3) * 0.012;
        a.vel += ((want - a.root.rotation.y) * 60 - a.vel * 9) * dt;
        a.root.rotation.y += a.vel * dt;
        a.glow = lerp(a.glow, lit ? 1 : 0, 1 - Math.exp(-dt * 10));
      }
      a.mat.emissive.setRGB(0.12 * a.glow, 0.06 * a.glow, 0.02 * a.glow);
    }

    // A board is shown only while its side of the arrow faces the lens.
    // (backface-visibility can't do this: CSS3DRenderer's wrappers leave
    // the boards showing through the fronts of the arrows, mirrored.)
    camera.getWorldPosition(eye);
    const facing = (obj: CSS3DObject): boolean => {
      obj.getWorldPosition(facePos);
      obj.getWorldQuaternion(faceQuat);
      return (
        normal
          .set(0, 0, 1)
          .applyQuaternion(faceQuat)
          .dot(facePos.negate().add(eye)) > 0
      );
    };
    for (const a of arrows) {
      // Only the open arrow's board: the others' backs come round with the
      // post too, and their boards would show at the edges of the view.
      a.face.style.visibility =
        current === a && facing(a.faceObj) ? 'visible' : 'hidden';
      if (a.councilFace && a.councilObj)
        // a.council flips at the edge-on moment of the flip, so the council
        // stays on the wood until its side has turned away (and appears
        // only once it has turned toward the lens).
        a.councilFace.style.visibility =
          a.council && facing(a.councilObj) ? 'visible' : 'hidden';
    }

    bakeStudio();
    water.update(now);
    mist.update(now);
    renderer.render(camera);
    css.render(renderer.scene, camera);
    if (!canvas.classList.contains('lit')) canvas.classList.add('lit');
  };
  requestAnimationFrame(loop);

  const opening = params.get('open');
  const initial = arrows.find(
    a => a.mode === (opening === 'council' ? 'multi' : opening),
  );
  if (initial)
    setTimeout(async () => {
      await select(initial);
      if (opening === 'council') await hostCouncil(initial);
    }, 300);
}
void main();
