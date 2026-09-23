import * as THREE from 'three';
import {RoomEnvironment} from 'three/addons/environments/RoomEnvironment.js';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {
  CSS3DObject,
  CSS3DRenderer,
} from 'three/addons/renderers/CSS3DRenderer.js';
import {mergeVertices} from 'three/addons/utils/BufferGeometryUtils.js';
import {snapBuildings} from '../../protocol/snapshot';
import {loadGlbAssets} from '../../render/assets';
import {BuildingSync} from '../../render/buildingSync';
import {GrassField} from '../../render/grassField';
import {HeightField} from '../../render/heightField';
import {MarginMesh} from '../../render/marginMesh';
import {Mist} from '../../render/mist';
import {background} from '../../render/palette';
import {GameRenderer} from '../../render/renderer';
import {ScatterMesh} from '../../render/scatterMesh';
import {TerrainMesh} from '../../render/terrainMesh';
import {WaterMesh} from '../../render/waterMesh';
import * as BuildingTypeId from '../../sim/defs/buildingTypeIdEnum.ts';
import {WATER_LEVEL} from '../../sim/map';
import * as PlayerKind from '../../sim/playerKindEnum.ts';
import * as Terrain from '../../sim/terrainEnum.ts';
import * as TileResource from '../../sim/tileResourceEnum.ts';
import {createWorld} from '../../sim/world';

/**
 * The start screen's world: the valley, and a signpost standing in front of
 * it with one arrow per mode. Opening a mode turns the signpost round and
 * moves in on that arrow — its back is the board with the mode's options on
 * it. Hosting flips the Multiplayer arrow over to its front, where the War
 * Council is.
 *
 * This module owns only the 3D and the boards' placement: each board is an
 * empty element pinned to its wood (CSS3DRenderer), and the screen
 * (Signpost.tsx) renders into it. Nothing here writes a board's contents.
 *
 * Style: KayKit, not "realistic wood". Every piece is coloured from the
 * pack's own palette atlas (hexagons_medieval.png — a gradient per cell,
 * light at the top of the object, dark at the bottom), with fat rounded
 * bevels and smooth normals, and soft carved grain that carries no colour.
 *
 * The signpost stands in the valley where the lens rests, and the shelf of
 * replays is a rock elsewhere in it: opening Replays is the lens going over
 * there. Nothing drifts; the pointer — on a phone, tilting it — moves the
 * lens a little round what it looks at.
 *
 * One WebGL context, one loop: the signpost is in the valley's own scene
 * rather than drawn on a second canvas over it, and nothing is blurred by
 * CSS — a full-screen filter under a canvas that changes every frame is
 * re-run every frame, and stutters.
 */

export type Mode = 'campaign' | 'skirmish' | 'multi';
/** Every board the screen can be in front of: a mode's, or the shelf of
 * recorded matches. */
export type Board = Mode | 'replays';

export interface SignpostEvents {
  /** The open board changed; null is back at the crossroads. */
  onBoard(board: Board | null): void;
}

export interface SignpostScene {
  /** Each mode's board: an element on the back of its arrow. */
  readonly faces: Readonly<Record<Mode, HTMLDivElement>>;
  /** The War Council's board, on the front of the Multiplayer arrow. */
  readonly councilFace: HTMLDivElement;
  /** The shelf of recorded matches, written on the face of the rock that springs up for it. */
  readonly shelfFace: HTMLDivElement;
  /** Turn the signpost round to `mode`'s board (closing another first).
   * `instant` skips the animation — a page that opens already there. */
  open(mode: Mode, instant?: boolean): Promise<void>;
  /** Go over to the rock with the shelf on it (closing any board first). */
  openShelf(): Promise<void>;
  /** Back to the crossroads. */
  close(): Promise<void>;
  /** Flip the Multiplayer arrow over to the War Council. */
  enterCouncil(instant?: boolean): Promise<void>;
  /** Flip it back to the Multiplayer board. */
  leaveCouncil(): Promise<void>;
  /** Tear down: the WebGL context goes with it, for the match to take. */
  stop(): void;
}

// ---------------------------------------------------------------- utilities

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
const easeInOut = (t: number): number =>
  t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
/** A small seeded generator: the sign's jitter and grain are the same on
 * every visit. */
function seeded(start: number): () => number {
  let s = start;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

// ------------------------------------------------------------ KayKit paint

/** Atlas cells, [column, row] of the 8x4 grid. */
const CELL = {
  wood: [5, 0], // warm crate wood, #c8855f -> #9b5a45
  post: [7, 1], // weathered grey-brown, #837265 -> #534741
  bolt: [3, 0], // dark steel
} as const;
type Cell = readonly [number, number];

/**
 * Carved grain for the sign's wood. KayKit models have none — they are
 * seen from across a map — but the menu puts a plank a hand's width from
 * the lens, and there flat colour reads as plastic. So: game-art grain,
 * not a photograph. A few long soft wavy lines and the odd knot, drawn
 * white-on-grey and used twice — as a bump map (the lines are shallow
 * grooves that catch the light) and as an AO map (their troughs darken a
 * touch). Neither carries colour, so the palette stays the pack's.
 */
function grainTexture(rand: () => number): THREE.CanvasTexture {
  const jitter = (a: number): number => (rand() * 2 - 1) * a;
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
      d +=
        Math.sign(dy || 1) *
        Math.exp(-dx * dx) *
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
      const s = k.r * (0.45 + r * 0.45);
      g.ellipse(k.x, k.y, s * 1.8, s * 0.7, 0, 0, Math.PI * 2);
      g.stroke();
    }
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  t.channel = 1;
  return t;
}

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

// ------------------------------------------------------------ the signpost

/** Half the post's thickness: the arrows are nailed to its front. */
const POST_HALF = 0.22;
/** Long enough that the post's foot is never on screen. */
const POST_LEN = 40;

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

/** The lettering face, loaded by the page (index.html). */
const FONT = 'Lilita One';

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

/**
 * Comic lettering: fat face, thick dark outline, the outline dropped once
 * more below it for weight. Same recipe as the boards' headings.
 */
function labelTexture(text: string, aspect: number): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.height = 200;
  c.width = Math.round(200 * aspect);
  const g = c.getContext('2d')!;
  let px = 120;
  g.font = `400 ${px}px "${FONT}"`;
  g.letterSpacing = '2px';
  const w = g.measureText(text).width;
  if (w > c.width * 0.9) px = Math.floor((px * c.width * 0.9) / w);
  g.font = `400 ${px}px "${FONT}"`;
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

interface Arrow {
  mode: Mode;
  dir: 1 | -1;
  len: number;
  baseY: number;
  /** Pivot on the post: hover, tug and the straightening turn this. */
  root: THREE.Group;
  /** Turns the arrow about its own length (the War Council flip). Its
   * axis runs through the plank's middle, not the post. */
  spin: THREE.Group;
  plank: THREE.Mesh;
  mat: THREE.MeshStandardMaterial;
  label: THREE.Mesh;
  /** The board: DOM on the arrow's back. */
  face: HTMLDivElement;
  faceObj: CSS3DObject;
  yaw: number;
  tilt: number;
  vel: number;
  glow: number;
}

// ------------------------------------------------------------------ valley

/** A seed whose start plateau frames well. Nothing depends on it. */
const BACKDROP_SEED = 41207;
const EYE_HEIGHT = 6;
const ORBIT_RADIUS = 19;
const LOOK_HEIGHT = 2.8;
/** Where the lens rests on its circle round the keep — chosen so the sun
 * rakes across the keep. */
const START_ANGLE = 2.2;
/** The haze band, in tiles from the eye (see the old backdrop's note:
 * far ground lit evenly reads as a painted flat pinned behind the keep). */
const FOG_NEAR = 26;
const FOG_FAR = 100;

/**
 * The lens. Narrow: the signpost rides in front of it, and a long lens is
 * what keeps a near object from bulging.
 */
const FOV = 32;
const TAN = Math.tan(THREE.MathUtils.degToRad(FOV / 2));

/**
 * The signpost stands in `ui`, a space fixed in the valley where the lens
 * rests (see placeRest): in it the resting lens is at the origin looking
 * down -z, and the whole of it is shrunk toward the lens, so the post
 * stands a few tiles off rather than nine — well clear of any hill between
 * it and the eye. `stage` is where the signpost stands; the zoom onto an
 * arrow is `stage` sliding toward the lens.
 */
const STAGE_DIST = 9.5;
const STAGE_Y = 1.5;
const UI_SCALE = 0.45;

const TURN_MS = 1150;
const FLIP_MS = 900;
/** The lens's trip from the signpost to the rock, and back. */
const FLY_MS = 1600;

/**
 * The pointer — or on a phone, tilting it — moves the lens a little round
 * what it looks at, which is what sells the depth. How far, at the
 * signpost (ui units, at the crossroads; less as the lens closes in on a
 * board) and at the rock (tiles), and how many degrees of tilt make a full
 * lean.
 */
const LEAN = {x: 0.6, y: 0.3};
const ROCK_LEAN = {x: 0.45, y: 0.2};
const TILT_FULL = 20;

/**
 * The rock the shelf is written on — the pack's mountain_C, a heap of
 * hexagonal slabs — and the face of it the list is written on: the front
 * slab's right-hand face, in the model's own units. The slab's sides are
 * upright and its foot is flat, but its top is cut on a slant, from `low`
 * at its left end up to `high` at its right.
 */
const ROCK_FACE = {
  x: 0.2015,
  z: 0.862,
  yaw: THREE.MathUtils.degToRad(29),
  w: 0.551,
  low: 0.758,
  high: 0.828,
};
/** The list inside the face: its width, and the stone left clear above and
 * below it (the model's units) — above the flat foot, and under the top's
 * low end, so the whole of it is on the face. */
const LIST_W = ROCK_FACE.w * 0.92;
const LIST_MARGIN = 0.03;
const LIST_H = ROCK_FACE.low - 2 * LIST_MARGIN;
/** How wide the rock is, in tiles: a big one, well over the grass, and
 * seen near level from in front of its face. */
const ROCK_WIDTH = 3.6;

// ------------------------------------------------------------------ layout

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
 * The board's own layout then follows the space it got: pixels per unit
 * are the screen's, divided by a text scale that grows gently with the
 * window. So a big window lays the board out wide and draws it big, a
 * phone lays it out narrow and draws it at about its CSS size, and every
 * window between gets something between.
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
 * Invite and Listed / Invite only, four seats, three settings in a row — is
 * much the widest.
 */
const narrowBelow = (council: boolean): number => (council ? 960 : 640);

function frameFor(
  len: number,
  council: boolean,
  width: number,
  aspect: number,
): Frame {
  const tip = len - THROUGH;
  const neck = tip - HEAD_L;
  const faceMax = neck - FACE_FROM;
  // The council wants its board big — it has the chat — so it closes in
  // much further, and gives up the arrowhead before any of the board.
  const perUnit = council ? 1000 : 380;
  const cap = council ? 0.92 : 0.62;
  const minFace = council ? Infinity : 1;
  const whole = tip - POST_HALF + 0.15;
  const R = Math.max(Math.min(width / perUnit, whole), (HEAD_H * aspect) / cap);
  const faceW = Math.min(faceMax, R, Math.max(minFace, R - HEAD_L));
  const face: [number, number] = [neck - faceW, neck];
  const view: [number, number] =
    R <= faceW + HEAD_L ? [face[0], face[0] + R] : [tip - R, tip];
  // Text scale: about CSS size on a phone, growing with the window — but
  // never so large that the board's layout gets less height than its
  // contents need (a phone held sideways has hardly any): the wide layouts
  // want ~212px, the stacked narrow one ~290, and the council more.
  const onScreen = (width * FILL) / R;
  const tallEnough = (h: number): number => (ARROW_H * 0.9 * onScreen) / h;
  let k = Math.min(
    Math.max(0.8, width / 1070),
    tallEnough(council ? 400 : 212),
  );
  const narrow = faceW * (onScreen / k) < narrowBelow(council);
  if (narrow) k = Math.min(k, tallEnough(council ? 440 : 290));
  return {face, view, px: onScreen / k, narrow};
}

// ---------------------------------------------------------------- the scene

/** The one live scene: a single-player launch is a navigation, and the
 * page must give its WebGL context back before the match asks for one. */
let live: SignpostScene | null = null;

/** Stop the live scene, if any. Safe at any time. */
export function releaseSignpost(): void {
  live?.stop();
  live = null;
}

export async function startSignpost(
  canvas: HTMLCanvasElement,
  events: SignpostEvents,
): Promise<SignpostScene> {
  releaseSignpost();
  const [, , rockGltf] = await Promise.all([
    loadGlbAssets(),
    document.fonts.load(`100px "${FONT}"`),
    new GLTFLoader().loadAsync('/models/kaykit/mountain_C.gltf'),
  ]);

  const rand = seeded(20260923);
  const jitter = (a: number): number => (rand() * 2 - 1) * a;
  const still =
    window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

  // ——— materials
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
  const grainTex = grainTexture(rand);
  /** Wood: the pack's material plus the grain (read through uv1). */
  const woodMat = kayMat.clone();
  woodMat.bumpMap = grainTex;
  woodMat.bumpScale = 1.2;
  woodMat.aoMap = grainTex;
  woodMat.aoMapIntensity = 0.35;

  // ——— the valley
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
  const camera = new THREE.PerspectiveCamera(FOV, 1, 0.3, 400);
  const grass = new GrassField(world.map, heights);
  renderer.scene.add(
    new TerrainMesh(world.map, heights).group,
    new ScatterMesh(world.map, heights).group,
    grass.mesh,
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

  // ——— the stage the signpost stands on: fixed in the valley, where the
  // lens rests (see rest), so its space is the lens's own there.
  const ui = new THREE.Group();
  ui.scale.setScalar(UI_SCALE);
  renderer.scene.add(ui);
  /** The lens at rest: where the signpost's framing is worked out from. */
  const rest = new THREE.PerspectiveCamera();
  const stage = new THREE.Group();
  ui.add(stage);
  const REST = new THREE.Vector3(0, -STAGE_Y, -STAGE_DIST);
  const stageBase = REST.clone();

  const post = new THREE.Group();
  stage.add(post);
  {
    // A plain square post, its top just rounded off like every other edge
    // of the sign. The gradient runs over the part you see — post space
    // -1.2 to 3.6 — in the shaft's own coordinates (its middle is
    // POST_LEN / 2 below the top at 3.4).
    const shaft = new THREE.Mesh(
      grain(
        paint(
          extrude(
            roundedTop(POST_HALF * 2, POST_LEN, 0.07),
            POST_HALF * 2,
            0.09,
          ),
          CELL.post,
          POST_LEN / 2 - 4.6,
          POST_LEN / 2 + 0.2,
        ),
        true,
        0.13,
      ),
      woodMat,
    );
    shaft.position.y = 3.4 - POST_LEN / 2;
    post.add(shaft);
  }

  // ——— the boards' layer
  const css = new CSS3DRenderer();
  css.domElement.id = 'signpost-3d';
  // The layer clips (overflow: hidden), and so it can still be scrolled: a
  // click or focus on a button inside a turned board has the browser scroll
  // it "into view", sliding every board sideways off its wood. Pin it.
  const pin = (): void => {
    css.domElement.scrollLeft = 0;
    css.domElement.scrollTop = 0;
  };
  css.domElement.addEventListener('scroll', pin);
  canvas.insertAdjacentElement('afterend', css.domElement);

  /** A board element, pinned into `parent` at the arrow's back or front. */
  const boardOf = (
    parent: THREE.Object3D,
    classes: string,
  ): {el: HTMLDivElement; obj: CSS3DObject} => {
    const el = document.createElement('div');
    el.className = classes;
    const obj = new CSS3DObject(el);
    // CSS3DObject sets pointer-events inline; a board turned away must not
    // swallow the clicks meant for the arrows. activate() hands it back.
    el.style.pointerEvents = 'none';
    parent.add(obj);
    return {el, obj};
  };

  // ——— the arrows
  const arrows: Arrow[] = ARROW_SPECS.map(spec => {
    const {dir, len} = spec;
    const root = new THREE.Group();
    root.position.y = spec.y;
    const yaw = dir * 0.1 + jitter(0.04);
    const tilt = dir * jitter(0.03);
    root.rotation.set(0, yaw, tilt);
    post.add(root);

    // Root space: the post at x = 0, the arrow's tail THROUGH behind it,
    // the tip `dir * (len - THROUGH)` out along x.
    const outline = arrowOutline(len).map(
      p => new THREE.Vector2(dir * (p.x - THROUGH), p.y),
    );
    if (dir < 0) outline.reverse(); // keep the winding counter-clockwise
    // One solid piece: its back is the board, and a groove running under
    // the controls would read as a seam in the UI, not as wood.
    const hh = HEAD_H / 2;
    const mat = woodMat.clone();
    const g = extrude(outline, ARROW_D, 0.05);
    g.translate(0, 0, ARROW_Z);
    const plank = new THREE.Mesh(
      grain(paint(g, CELL.wood, -hh, hh), false, rand()),
      mat,
    );
    // Everything of the arrow hangs in `inner`, which sits back at the
    // root's origin, inside `spin`, whose origin is the plank's middle.
    const spin = new THREE.Group();
    spin.position.z = ARROW_Z;
    const inner = new THREE.Group();
    inner.position.z = -ARROW_Z;
    spin.add(inner);
    root.add(spin);
    inner.add(plank);

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
    const bolt = new THREE.Mesh(paint(boltGeo, CELL.bolt), kayMat);
    bolt.scale.z = 0.6;
    bolt.position.set(0, 0, ARROW_Z + ARROW_D / 2);
    inner.add(bolt);

    // Back: the board, turned to face -z. From behind, the tip is at its
    // far end, so the Play button that goes there — flush with the neck —
    // is the arrow pointing onward.
    const tipSide = dir > 0 ? 'tip-start' : 'tip-end';
    const {el: face, obj: faceObj} = boardOf(
      inner,
      `face ${tipSide}${spec.mode === 'multi' ? ' mp' : ''}`,
    );
    faceObj.rotation.y = Math.PI;
    faceObj.position.z = ARROW_Z - ARROW_D / 2 - 0.006;

    return {
      mode: spec.mode,
      dir,
      len,
      baseY: spec.y,
      root,
      spin,
      plank,
      mat,
      label,
      face,
      faceObj,
      yaw,
      tilt,
      vel: 0,
      glow: 0,
    };
  });
  const byMode = (mode: Mode): Arrow => arrows.find(a => a.mode === mode)!;
  const multi = byMode('multi');

  // The council's board, on the Multiplayer arrow's front. Upside down on
  // purpose: the flip that brings the front round (a half turn about the
  // arrow's length) turns it the right way up.
  const {el: councilFace, obj: councilObj} = boardOf(
    multi.spin.children[0]!,
    `face council ${multi.dir > 0 ? 'tip-start' : 'tip-end'}`,
  );
  councilObj.rotation.z = Math.PI;
  councilObj.position.z = ARROW_Z + ARROW_D / 2 + 0.006;

  // ——— the shelf: a rock standing in the valley, the list written on one
  // of its faces. Opening it is the lens going over there.
  /** The rock, normalised to a width of 1 (its foot at 0, centred), then
   * scaled to ROCK_WIDTH and stood on its spot (findRockSpot). */
  const rock = new THREE.Group();
  renderer.scene.add(rock);
  /** The rock's width in the model's units: a face's size over this is its
   * size in the rock's. */
  let rockW = 1;
  /** On the face, in the model's own frame: the list hangs from this. */
  const faceAnchor = new THREE.Object3D();
  {
    const model = rockGltf.scene;
    // The pack's own palette material, as the sign wears it (studio light
    // included, below): the model's uvs already point into the atlas.
    model.traverse(o => {
      if ((o as THREE.Mesh).isMesh) (o as THREE.Mesh).material = kayMat;
    });
    const box = new THREE.Box3().setFromObject(model);
    rockW = box.max.x - box.min.x;
    faceAnchor.position.set(ROCK_FACE.x, LIST_MARGIN + LIST_H / 2, ROCK_FACE.z);
    faceAnchor.rotation.y = ROCK_FACE.yaw;
    model.add(faceAnchor);
    model.position.set(
      -(box.min.x + box.max.x) / 2,
      -box.min.y,
      -(box.min.z + box.max.z) / 2,
    );
    const norm = new THREE.Group();
    norm.add(model);
    norm.scale.setScalar(1 / rockW);
    rock.add(norm);
    rock.scale.setScalar(ROCK_WIDTH);
  }
  const {el: shelfFace, obj: shelfObj} = boardOf(faceAnchor, 'face shelf');

  // ——— studio light: for the sign only. The valley's sun sits behind the
  // post from where the lens stands, which left the wood a muddy brown; the
  // pack's own renders are lit soft and even from the front. An envMap on
  // the sign's materials lights just these meshes and leaves the valley.
  {
    const pmrem = new THREE.PMREMGenerator(renderer.webgl);
    const studio = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    pmrem.dispose();
    const lit = (o: THREE.Object3D): void => {
      const m = (o as THREE.Mesh).material as
        | THREE.MeshStandardMaterial
        | undefined;
      if (!m?.isMeshStandardMaterial) return;
      m.envMap = studio;
      m.envMapIntensity = 0.42;
      m.fog = false;
      m.needsUpdate = true;
    };
    ui.traverse(lit);
    rock.traverse(lit);
  }

  // ——— layout
  let postX = 0;
  let postY = 0;
  let inCouncil = false;
  let current: Arrow | null = null;
  let shelfOpen = false;
  const place = (
    el: HTMLDivElement,
    obj: CSS3DObject,
    a: Arrow,
    council: boolean,
  ): void => {
    const {
      face: [from, to],
      px,
      narrow,
    } = frameFor(a.len, council, innerWidth, camera.aspect);
    el.style.width = `${(to - from) * px}px`;
    el.style.height = `${ARROW_H * 0.9 * px}px`;
    el.classList.toggle('narrow', narrow);
    obj.scale.setScalar(1 / px);
    obj.position.x = (a.dir * (from + to)) / 2;
  };

  /**
   * Where `stage` has to be for `a`'s board to be framed as frameFor says,
   * with the post turned half round and the arrow straightened.
   */
  const focusBase = (a: Arrow, council: boolean): THREE.Vector3 => {
    const s = post.scale.x;
    const [from, to] = frameFor(a.len, council, innerWidth, camera.aspect).view;
    const mid = (a.dir * (from + to)) / 2;
    const back = ARROW_Z - ARROW_D / 2;
    // Post turned by pi about y: (x, y, z) -> (-x, y, -z), then scaled and
    // placed.
    const c = new THREE.Vector3(
      postX - s * mid,
      postY + s * a.baseY,
      -s * back,
    );
    const depth = ((to - from) * s) / (FILL * 2 * TAN * camera.aspect);
    return new THREE.Vector3(0, 0, -depth).sub(c);
  };

  /**
   * Where the rock stands: somewhere in the valley on dry, open grass — no
   * river, no trees, no buildings — with room in front of its face for the
   * lens, and the ground under it near level. Off to one side of the keep
   * as the lens sees it from rest, and not far, so the trip is short and
   * the rock is part of the view, not in front of it. Its face turns to
   * the resting lens.
   *
   * Scored rather than filtered — a wooded valley may have nowhere that is
   * perfect — except for water: never in the river.
   */
  const findRockSpot = (): {x: number; z: number; y: number; face: number} => {
    const map = world.map;
    const size = map.size;
    const tileAt = (x: number, z: number): number => {
      const tx = Math.floor(x);
      const tz = Math.floor(z);
      return tx < 0 || tz < 0 || tx >= size || tz >= size ? -1 : tz * size + tx;
    };
    const wet = (x: number, z: number): boolean => {
      const i = tileAt(x, z);
      return (
        i < 0 ||
        map.terrain[i] === Terrain.Water ||
        heights.at(x, z) < WATER_LEVEL + 0.25
      );
    };
    const cluttered = (x: number, z: number): boolean => {
      const i = tileAt(x, z);
      return (
        i < 0 ||
        map.terrain[i] !== Terrain.Grass ||
        map.resource[i] !== TileResource.None ||
        map.buildingAt[i]! >= 0
      );
    };
    const restX = cx + Math.sin(START_ANGLE) * ORBIT_RADIUS;
    const restZ = cz + Math.cos(START_ANGLE) * ORBIT_RADIUS;
    const toKeep = Math.atan2(cx - restX, cz - restZ);
    let best = {x: restX, z: restZ, y: heights.at(restX, restZ), face: toKeep};
    let bestScore = Infinity;
    for (let tz = 0; tz < size; tz++)
      for (let tx = 0; tx < size; tx++) {
        const x = tx + 0.5;
        const z = tz + 0.5;
        const away = Math.hypot(x - restX, z - restZ);
        if (away < 6 || away > 18) continue;
        // Beside the keep from the resting lens, not in front of it.
        const off = Math.abs(
          THREE.MathUtils.euclideanModulo(
            Math.atan2(x - restX, z - restZ) - toKeep + Math.PI,
            Math.PI * 2,
          ) - Math.PI,
        );
        if (off < 0.2 || off > 1.1) continue;
        let score = Math.abs(away - 10) * 0.3 + Math.abs(off - 0.45) * 2;
        // Its footprint: dry (always), open, near level.
        let lo = Infinity;
        let hi = -Infinity;
        let dry = true;
        for (let dz = -2; dz <= 2 && dry; dz += 0.5)
          for (let dx = -2; dx <= 2 && dry; dx += 0.5) {
            if (dx * dx + dz * dz > 4.4) continue;
            if (wet(x + dx, z + dz)) dry = false;
            if (cluttered(x + dx, z + dz)) score += 1;
            const h = heights.at(x + dx, z + dz);
            lo = Math.min(lo, h);
            hi = Math.max(hi, h);
          }
        if (!dry) continue;
        score += (hi - lo) * 8;
        // The way toward the resting lens, where the lens will stand: dry
        // and open.
        const fx = (restX - x) / away;
        const fz = (restZ - z) / away;
        for (let d = 2; d <= 6.5; d += 0.5)
          for (let l = -1.2; l <= 1.2; l += 0.6) {
            const px = x + fx * d - fz * l;
            const pz = z + fz * d + fx * l;
            if (wet(px, pz)) score += 3;
            else if (cluttered(px, pz)) score += 1;
          }
        if (score < bestScore) {
          bestScore = score;
          best = {x, z, y: lo - 0.05, face: Math.atan2(fx, fz)};
        }
      }
    return best;
  };
  {
    const spot = findRockSpot();
    rock.position.set(spot.x, spot.y, spot.z);
    // A trodden patch in front of the face, where the lens stands: seen
    // from there, grass a stride away would stand taller than the list.
    const size = world.map.size;
    const fx = Math.sin(spot.face);
    const fz = Math.cos(spot.face);
    for (let d = 0; d <= 8; d += 0.5)
      for (let l = -1.5; l <= 1.5; l += 0.5) {
        const tx = Math.floor(spot.x + fx * d - fz * l);
        const tz = Math.floor(spot.z + fz * d + fx * l);
        if (tx >= 0 && tz >= 0 && tx < size && tz < size)
          grass.removeTile(tz * size + tx);
      }
    // The face points `face`; the model's face points ROCK_FACE.yaw.
    rock.rotation.y = spot.face - ROCK_FACE.yaw;
  }

  /** The list's text scale: set by placeShelf, from the face's width. */
  let shelfK = 1;
  /** How far in front of the face the lens stands (tiles): set by
   * placeShelf. */
  let shelfDist = 4;

  /**
   * Size the list to the face, and stand the lens far enough back that
   * the face fills most of the window's height — or its width, on a phone.
   */
  const placeShelf = (): void => {
    const toWorld = ROCK_WIDTH / rockW;
    const faceH = ROCK_FACE.high * toWorld;
    const faceW = ROCK_FACE.w * toWorld;
    shelfDist = Math.max(
      faceH / (0.8 * 2 * TAN),
      faceW / (0.9 * 2 * TAN * camera.aspect),
    );
    // The list, laid out about 380px wide whatever that is on screen.
    const perPx = (2 * shelfDist * TAN) / innerHeight;
    const toPx = toWorld / perPx;
    shelfK = THREE.MathUtils.clamp((LIST_W * toPx) / 380, 0.75, 1.35);
    shelfFace.style.width = `${(LIST_W * toPx) / shelfK}px`;
    shelfFace.style.height = `${(LIST_H * toPx) / shelfK}px`;
    // The anchor is in the model's units.
    shelfObj.scale.setScalar((shelfK * perPx) / toWorld);
    // A hair off the stone, toward the lens.
    shelfObj.position.set(0, 0, 0.004 / toWorld);
  };

  /** Where the lens rests, looking at the signpost: START_ANGLE round,
   * the keep pushed left on a wide window to leave the right for the
   * signpost. */
  const placeRest = (): void => {
    const room = THREE.MathUtils.clamp((camera.aspect - 1) / 0.8, 0, 1);
    rest.position.set(
      cx + Math.sin(START_ANGLE) * ORBIT_RADIUS,
      groundY + EYE_HEIGHT,
      cz + Math.cos(START_ANGLE) * ORBIT_RADIUS,
    );
    rest.lookAt(cx, groundY + LOOK_HEIGHT, cz);
    rest.rotateY(-0.2 * room);
    ui.position.copy(rest.position);
    ui.quaternion.copy(rest.quaternion);
  };

  const layout = (): void => {
    const aspect = camera.aspect;
    const halfW = STAGE_DIST * TAN * aspect;
    // The widest the signpost gets: the longest arrow each way from the post.
    const span = 2 * (4.0 - THROUGH);
    const s = Math.min(0.7, (halfW * 2 * 0.94) / span);
    post.scale.setScalar(s);
    // Right of centre on a wide screen, so the keep (pushed left by the
    // lens) stays in view.
    postX = aspect > 1.15 ? halfW * 0.1 : 0;
    // On a screen taller than wide the signpost shrinks to fit the width
    // and would sit low under an empty sky; lift its arrows toward the
    // middle, more the taller the screen.
    const arrowsMid = (ARROW_SPECS[0]!.y + ARROW_SPECS[2]!.y) / 2;
    const lift = THREE.MathUtils.clamp((1 - aspect) / 0.4, 0, 1);
    postY = lift * (STAGE_Y - arrowsMid * s - 0.2);
    post.position.set(postX, postY, 0);
    for (const a of arrows) place(a.face, a.faceObj, a, false);
    place(councilFace, councilObj, multi, true);
    placeShelf();
  };

  let busy = false;
  const fit = (): void => {
    camera.aspect = innerWidth / Math.max(innerHeight, 1);
    camera.updateProjectionMatrix();
    css.setSize(innerWidth, innerHeight);
    layout();
    placeRest();
    if (current && !busy) stageBase.copy(focusBase(current, inCouncil));
  };
  window.addEventListener('resize', fit);
  fit();

  // ——— transitions: one at a time, in the order asked for
  interface Tween {
    start: number;
    dur: number;
    fn(t: number): void;
    ease(t: number): number;
    done(): void;
  }
  const tweens = new Set<Tween>();
  const tween = (
    dur: number,
    fn: (t: number) => void,
    ease: (t: number) => number = easeInOut,
  ): Promise<void> =>
    new Promise(done => {
      // Reduced motion: the same states, arrived at in a cut.
      tweens.add({
        start: performance.now(),
        dur: still ? 1 : dur,
        fn,
        ease,
        done,
      });
    });
  let chain = Promise.resolve();
  const queue = (step: () => Promise<void>): Promise<void> =>
    (chain = chain.then(step, step));

  /** Which board takes the pointer: the one being read, and no other. */
  const activate = (el: HTMLDivElement, on: boolean): void => {
    el.classList.toggle('active', on);
    el.style.pointerEvents = on ? 'auto' : 'none';
  };

  const turnTo = async (a: Arrow, instant: boolean): Promise<void> => {
    busy = true;
    current = a;
    events.onBoard(a.mode);
    const from = stageBase.clone();
    const to = focusBase(a, false);
    const r0 = post.rotation.y;
    const y0 = a.root.rotation.y;
    const z0 = a.root.rotation.z;
    await tween(instant ? 1 : TURN_MS, t => {
      // The turn leads, the move follows a little behind: it reads as the
      // signpost being turned toward you rather than the camera flying.
      post.rotation.y = lerp(r0, Math.PI, t);
      stageBase.lerpVectors(from, to, easeInOut(Math.min(1, t * 1.15)));
      a.root.rotation.y = lerp(y0, 0, t);
      a.root.rotation.z = lerp(z0, 0, t);
    });
    activate(a.face, true);
    busy = false;
  };

  const turnBack = async (): Promise<void> => {
    const a = current;
    if (!a) return;
    busy = true;
    activate(a.face, false);
    events.onBoard(null);
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
  };

  /** How far the lens is on its way to the rock: 0 at the signpost, 1 in
   * front of the face. */
  let fly = 0;

  const showShelf = async (): Promise<void> => {
    busy = true;
    shelfOpen = true;
    events.onBoard('replays');
    const f0 = fly;
    await tween(FLY_MS, t => {
      fly = lerp(f0, 1, t);
    });
    activate(shelfFace, true);
    busy = false;
  };

  const hideShelf = async (): Promise<void> => {
    if (!shelfOpen) return;
    busy = true;
    activate(shelfFace, false);
    events.onBoard(null);
    const f0 = fly;
    await tween(FLY_MS, t => {
      fly = lerp(f0, 0, t);
    });
    shelfOpen = false;
    busy = false;
  };

  /**
   * Flip the Multiplayer arrow a half turn about its length, bringing its
   * front — and the council there — round to the lens (or its back again),
   * while the lens moves in for the council (or back out). The painted name
   * goes as the front comes round edge-on: the council has the board to
   * itself.
   */
  const flip = async (toCouncil: boolean, instant: boolean): Promise<void> => {
    busy = true;
    activate(toCouncil ? multi.face : councilFace, false);
    const from = stageBase.clone();
    const to = focusBase(multi, toCouncil);
    const r0 = multi.spin.rotation.x;
    const r1 = toCouncil ? Math.PI : 0;
    let swapped = false;
    await tween(instant ? 1 : FLIP_MS, t => {
      multi.spin.rotation.x = lerp(r0, r1, t);
      stageBase.lerpVectors(from, to, t);
      if (!swapped && t >= 0.5) {
        swapped = true;
        inCouncil = toCouncil;
        multi.label.visible = !toCouncil;
      }
    });
    activate(toCouncil ? councilFace : multi.face, true);
    busy = false;
  };

  // ——— input
  const ray = new THREE.Raycaster();
  const pointer = new THREE.Vector2(9, 9);
  const parallax = new THREE.Vector2();
  /** Where the lens leans toward: the mouse, or on a phone its tilt. Not
   * a finger: it leaves no position between taps, and a lean toward its
   * last tap would slide the board off-centre. */
  const leanTo = new THREE.Vector2();
  let hovered: Arrow | null = null;

  const toNdc = (x: number, y: number): THREE.Vector2 =>
    new THREE.Vector2((x / innerWidth) * 2 - 1, -(y / innerHeight) * 2 + 1);
  const arrowUnder = (ndc: THREE.Vector2): Arrow | null => {
    ray.setFromCamera(ndc, camera);
    const hit = ray.intersectObjects(
      arrows.map(a => a.plank),
      false,
    )[0];
    return arrows.find(a => a.plank === hit?.object) ?? null;
  };

  const onMove = (e: PointerEvent): void => {
    pointer.copy(toNdc(e.clientX, e.clientY));
    if (e.pointerType === 'mouse') leanTo.copy(pointer).clampScalar(-1, 1);
  };
  /** A click on the world: an arrow opens its board; open ground closes
   * one — unless it is the council, where a stray click must not walk the
   * player out of a room. Clicks on the boards and the page's own chrome
   * never reach here as world clicks. */
  const onClick = (e: MouseEvent): void => {
    const el = e.target as HTMLElement | null;
    if (el?.closest('.face, #menu button, #menu a, #menu input')) return;
    if (busy) return;
    if (shelfOpen) {
      void scene.close();
    } else if (!current) {
      const a = arrowUnder(toNdc(e.clientX, e.clientY));
      if (a) void scene.open(a.mode);
    } else if (!inCouncil) {
      void scene.close();
    }
  };
  window.addEventListener('pointermove', onMove);
  window.addEventListener('click', onClick);

  // A phone has no pointer to lean after, but it has a tilt: the lens
  // leans as the phone does, measured from how it is being held (which
  // drifts along slowly, so holding it at a new angle settles back to
  // straight on).
  let held: {beta: number; gamma: number} | null = null;
  const onTilt = (e: DeviceOrientationEvent): void => {
    if (e.beta === null || e.gamma === null) return;
    // Held sideways, the phone's own axes swap round the screen's.
    const turn = screen.orientation?.angle ?? 0;
    const across =
      turn === 90 ? e.beta : turn === 270 || turn === -90 ? -e.beta : e.gamma;
    const along =
      turn === 90 ? -e.gamma : turn === 270 || turn === -90 ? e.gamma : e.beta;
    held ??= {beta: along, gamma: across};
    held.beta += (along - held.beta) * 0.01;
    held.gamma += (across - held.gamma) * 0.01;
    leanTo.set(
      THREE.MathUtils.clamp((across - held.gamma) / TILT_FULL, -1, 1),
      THREE.MathUtils.clamp((held.beta - along) / TILT_FULL, -1, 1),
    );
  };
  const touchOnly = !(
    window.matchMedia?.('(any-pointer: fine)').matches ?? false
  );
  /** iOS asks before it hands out the tilt, and only from a tap. */
  const askTilt = (): void => {
    window.removeEventListener('touchend', askTilt);
    const ask = (
      DeviceOrientationEvent as unknown as {
        requestPermission?: () => Promise<'granted' | 'denied'>;
      }
    ).requestPermission;
    if (ask)
      void ask()
        .then(r => {
          if (r === 'granted')
            window.addEventListener('deviceorientation', onTilt);
        })
        .catch(() => {});
  };
  if (touchOnly && typeof DeviceOrientationEvent !== 'undefined') {
    window.addEventListener('deviceorientation', onTilt);
    window.addEventListener('touchend', askTilt);
  }

  // ——— the loop
  const eye = new THREE.Vector3();
  const facePos = new THREE.Vector3();
  const faceQuat = new THREE.Quaternion();
  const normal = new THREE.Vector3();
  /** Does this board's side of its arrow face the lens? A board turned
   * away is hidden (backface-visibility can't do it: CSS3DRenderer's
   * wrappers leave the boards showing through the wood, mirrored). */
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

  let raf = 0;
  let stopped = false;
  const pivot = new THREE.Vector3();
  const lensAt = new THREE.Vector3();
  const faceAt = new THREE.Vector3();
  const faceN = new THREE.Vector3();
  const faceRight = new THREE.Vector3();
  const signPos = new THREE.Vector3();
  const signQuat = new THREE.Quaternion();
  const rockQuat = new THREE.Quaternion();
  let last = performance.now();
  const loop = (now: number): void => {
    if (stopped) return;
    raf = requestAnimationFrame(loop);
    // At most one frame in flight — see GameRenderer.gpuReady.
    if (!renderer.gpuReady()) return;
    const dt = Math.min((now - last) / 1000, 0.05);
    last = now;
    for (const tw of tweens) {
      const t = Math.min((now - tw.start) / tw.dur, 1);
      tw.fn(tw.ease(t));
      if (t === 1) {
        tweens.delete(tw);
        tw.done();
      }
    }

    // The lens: at rest in front of the signpost, or over at the rock, or
    // on its way between. Nothing drifts; the pointer (or the phone's
    // tilt) moves it a little round what it looks at.
    parallax.lerp(leanTo, 1 - Math.exp(-dt * 3));
    const px = still ? 0 : parallax.x;
    const py = still ? 0 : parallax.y;
    // At the signpost: round the point on its axis at the stage's depth —
    // the signpost, or the board the lens has closed in on. Squared
    // distance: the swing shrinks faster than the view does as the lens
    // closes in, so at the crossroads it sways and in front of a board —
    // on a phone held upright, very close — it barely moves at all.
    const lean = (-stageBase.z / STAGE_DIST) ** 2;
    stage.position.copy(stageBase);
    ui.updateMatrixWorld();
    ui.localToWorld(pivot.set(0, 0, stageBase.z));
    ui.localToWorld(lensAt.set(px * LEAN.x * lean, py * LEAN.y * lean, 0));
    camera.position.copy(lensAt);
    camera.lookAt(pivot);
    if (fly > 0) {
      signPos.copy(camera.position);
      signQuat.copy(camera.quaternion);
      // At the rock: square in front of the face, level with its middle,
      // swung round it by the pointer.
      rock.updateMatrixWorld();
      faceAnchor.getWorldPosition(faceAt);
      faceAnchor.getWorldDirection(faceN).setY(0).normalize();
      faceRight.set(faceN.z, 0, -faceN.x);
      camera.position
        .copy(faceAt)
        .addScaledVector(faceN, shelfDist)
        .addScaledVector(faceRight, px * ROCK_LEAN.x)
        .setY(faceAt.y + py * ROCK_LEAN.y);
      // Never under the ground (or the river) where it stands.
      camera.position.y = Math.max(
        camera.position.y,
        Math.max(
          heights.at(camera.position.x, camera.position.z),
          WATER_LEVEL,
        ) + 0.5,
      );
      camera.lookAt(faceAt);
      // On the way: over the ground between, a little lifted mid-trip.
      camera.position.lerp(signPos, 1 - fly);
      camera.position.y += Math.sin(fly * Math.PI) * 1.2;
      rockQuat.copy(camera.quaternion);
      camera.quaternion.slerpQuaternions(signQuat, rockQuat, fly);
    }

    hovered = busy || current || shelfOpen ? null : arrowUnder(pointer);
    document.body.style.cursor = hovered ? 'pointer' : '';
    for (const a of arrows) {
      if (a !== current) {
        const lit = a === hovered;
        const want =
          a.yaw +
          (lit ? -0.18 * Math.sign(a.yaw || 1) : 0) +
          (still ? 0 : Math.sin(now / 1100 + a.baseY * 3) * 0.012);
        a.vel += ((want - a.root.rotation.y) * 60 - a.vel * 9) * dt;
        a.root.rotation.y += a.vel * dt;
        a.glow = lerp(a.glow, lit ? 1 : 0, 1 - Math.exp(-dt * 10));
      }
      a.mat.emissive.setRGB(0.12 * a.glow, 0.06 * a.glow, 0.02 * a.glow);
    }

    // Only the open arrow's board draws, and only while its side faces the
    // lens; the council's shows from the edge-on moment of the flip on.
    camera.getWorldPosition(eye);
    for (const a of arrows)
      a.face.style.visibility =
        current === a && facing(a.faceObj) ? 'visible' : 'hidden';
    councilFace.style.visibility =
      inCouncil && facing(councilObj) ? 'visible' : 'hidden';
    shelfFace.style.visibility =
      shelfOpen && facing(shelfObj) ? 'visible' : 'hidden';

    water.update(now);
    mist.update(now);
    renderer.render(camera);
    css.render(renderer.scene, camera);
    if (!canvas.classList.contains('lit')) canvas.classList.add('lit');
  };
  raf = requestAnimationFrame(loop);

  const scene: SignpostScene = {
    faces: {
      campaign: byMode('campaign').face,
      skirmish: byMode('skirmish').face,
      multi: multi.face,
    },
    councilFace,
    shelfFace,
    open: (mode, instant = false) =>
      queue(async () => {
        const a = byMode(mode);
        if (current === a) return;
        await hideShelf();
        if (current) await turnBack();
        await turnTo(a, instant);
      }),
    openShelf: () =>
      queue(async () => {
        if (shelfOpen) return;
        if (inCouncil) return; // a room is left by its Leave, not by this
        if (current) await turnBack();
        await showShelf();
      }),
    close: () =>
      queue(async () => {
        await hideShelf();
        if (inCouncil) await flip(false, false);
        await turnBack();
      }),
    enterCouncil: (instant = false) =>
      queue(async () => {
        await hideShelf();
        if (current !== multi) {
          if (current) await turnBack();
          await turnTo(multi, instant);
        }
        if (!inCouncil) await flip(true, instant);
      }),
    leaveCouncil: () =>
      queue(async () => {
        if (inCouncil) await flip(false, false);
      }),
    stop: () => {
      if (stopped) return;
      stopped = true;
      if (live === scene) live = null;
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', fit);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('deviceorientation', onTilt);
      window.removeEventListener('touchend', askTilt);
      window.removeEventListener('click', onClick);
      document.body.style.cursor = '';
      css.domElement.removeEventListener('scroll', pin);
      css.domElement.remove();
      // The context goes with it: the match about to boot needs one of its
      // own, and browsers hand them out sparingly.
      renderer.dispose();
    },
  };
  live = scene;
  return scene;
}
