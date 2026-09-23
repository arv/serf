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
import {butterflyQuad, wander} from '../../render/butterflies';
import {FramePacer} from '../../render/framePacer';
import {GrassField} from '../../render/grassField';
import {HeightField} from '../../render/heightField';
import {MarginMesh} from '../../render/marginMesh';
import {Mist} from '../../render/mist';
import {GameRenderer} from '../../render/renderer';
import {crossedQuads, ScatterMesh} from '../../render/scatterMesh';
import {
  foliageMaterial,
  makeFlowerSprite,
  makeButterflySprite,
  makeGrassSprite,
} from '../../render/spriteTextures';
import {TerrainMesh} from '../../render/terrainMesh';
import {WaterMesh} from '../../render/waterMesh';
import * as BuildingTypeId from '../../sim/defs/buildingTypeIdEnum.ts';
import {WATER_LEVEL} from '../../sim/map';
import * as PlayerKind from '../../sim/playerKindEnum.ts';
import * as Terrain from '../../sim/terrainEnum.ts';
import * as TileResource from '../../sim/tileResourceEnum.ts';
import {createWorld} from '../../sim/world';
import {makeSky, SKY} from './sky';

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
/** The shelves of files, each on a surface somewhere in the valley. */
export type Shelf = 'replays' | 'saves';
export type Board = Mode | Shelf;

export interface SignpostEvents {
  /** The open board changed; null is back at the crossroads. */
  onBoard(board: Board | null): void;
}

export interface SignpostScene {
  /** Each mode's board: an element on the back of its arrow. */
  readonly faces: Readonly<Record<Mode, HTMLDivElement>>;
  /** The War Council's board, on the front of the Multiplayer arrow. */
  readonly councilFace: HTMLDivElement;
  /** The shelves' boards: the replays on a rock's face, the saves on the
   * storehouse's wall. */
  readonly shelfFaces: Readonly<Record<Shelf, HTMLDivElement>>;
  /** Turn the signpost round to `mode`'s board (closing another first).
   * `instant` skips the animation — a page that opens already there. */
  open(mode: Mode, instant?: boolean): Promise<void>;
  /** Go over to where a shelf is (closing any board first). */
  openShelf(shelf: Shelf): Promise<void>;
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
/** The post's length before it is planted (placeRest cuts it to the
 * ground). */
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
const ORBIT_RADIUS = 19;
/** The resting lens: this far over the ground it stands on — down in the
 * valley, so the signpost is seen planted in it, the trees on the left and
 * the keep behind — and aimed this far over the keep's ground. */
const EYE_HEIGHT = 1.6;
const LOOK_HEIGHT = 1.6;
/** How far round from the resting lens the saves' wall faces: off to the
 * back side, so the walk there is one circle of a sensible size. */
const WALL_FACING = THREE.MathUtils.degToRad(130);
/** How high the walk to the castle's wall arches at its middle: over the
 * trees, which stand about this tall. */
const WALK_ARCH = 3;
/** Stone left clear over the saves' list, under what is above it on the
 * wall (tiles). */
const LIST_TOP_GAP = 0.1;
/** How far the post goes into the ground it is planted in. */
const POST_SUNK = 0.3;
/** The pond right of the signpost: tiles ahead of the resting lens and to
 * its right, its radius, and how deep its middle is. */
const POND = {ahead: 10, right: 3.2, r: 2.4, bed: -0.9};
/** The butterflies behind the signpost: how big (the game's are 0.22
 * tiles across), how far their loops reach (a share of the game's), how
 * high they fly, how far their wings are turned up toward the lens, and
 * where each loops — out behind the pond, in the pond's terms (tiles
 * ahead of the resting lens and right of it). */
const BUTTERFLY = {
  size: 0.8,
  reach: 0.6,
  height: 0.6,
  tip: 0.8,
  spots: [
    {right: 6, ahead: 16, phase: 0, tint: 0xf2d96a},
    {right: 8.5, ahead: 18.5, phase: 37, tint: 0xf5efdc},
  ],
};
/**
 * The menu's frame cap, on every device, as the old backdrop had it: a
 * menu left open has nothing to gain from 120 Hz and a battery to lose —
 * that drain is what makes a laptop throttle its graphics.
 */
const MENU_FPS = 30;
/** Half the width of ground the menu's shadows fall on (tiles). */
const SHADOW_HALF = 30;
/** The menu's sun: behind the resting lens and off to its right (radians
 * round from straight behind), and how high. It lights the faces of the
 * keep the lens sees and lays the signpost's shadow ahead of it; the
 * game's own sun, from behind the keep, left everything in view in shade. */
const SUN = {
  right: THREE.MathUtils.degToRad(50),
  up: THREE.MathUtils.degToRad(50),
};
/** Where the lens rests on its circle round the keep — chosen so the lens
 * stands just past a stand of pines, which frame the left. */
const START_ANGLE = 2.52;
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
/** The walk round to the castle's wall: longer, and taken slower. */
const WALL_WALK_MS = 2400;

/**
 * The pointer — or on a phone, tilting it — moves the lens a little round
 * what it looks at, which is what sells the depth. How far, at the
 * signpost (ui units, at the crossroads; less as the lens closes in on a
 * board) and at the rock (tiles), and how many degrees of tilt make a full
 * lean.
 */
const LEAN = {x: 0.6, y: 0.3};
/** At a shelf, the swing is a share of how far off the lens stands. */
const SHELF_LEAN = {x: 0.12, y: 0.05};
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

/**
 * The layout height a board's contents want, wide and stacked narrow
 * (px): the text scale is held down until the board has that much. The
 * campaign's has a difficulty row under its trail of stops.
 */
const NEEDS: Record<Mode, [wide: number, narrow: number]> = {
  campaign: [262, 440],
  skirmish: [212, 290],
  multi: [212, 290],
};

function frameFor(
  len: number,
  council: boolean,
  width: number,
  aspect: number,
  needs: [wide: number, narrow: number],
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
  // contents need (a phone held sideways has hardly any): `needs`, and the
  // council more.
  const onScreen = (width * FILL) / R;
  const tallEnough = (h: number): number => (ARROW_H * 0.9 * onScreen) / h;
  let k = Math.min(
    Math.max(0.8, width / 1070),
    tallEnough(council ? 400 : needs[0]),
  );
  const narrow = faceW * (onScreen / k) < narrowBelow(council);
  if (narrow) k = Math.min(k, tallEnough(council ? 440 : needs[1]));
  return {face, view, px: onScreen / k, narrow};
}

// ---------------------------------------------------------------- the scene

/** The one live scene: a single-player launch is a navigation, and the
 * page must give its WebGL context back before the match asks for one. */
let live: SignpostScene | null = null;
/** Bumped by every release: a start still loading when a newer start (or
 * a release) comes along must not finish and take `live` from it. */
let starts = 0;

/** Stop the live scene, if any. Safe at any time. */
export function releaseSignpost(): void {
  starts++;
  live?.stop();
  live = null;
}

export async function startSignpost(
  canvas: HTMLCanvasElement,
  events: SignpostEvents,
): Promise<SignpostScene> {
  releaseSignpost();
  const mine = starts;
  const gltf = new GLTFLoader();
  const [, , rockGltf] = await Promise.all([
    loadGlbAssets(),
    document.fonts.load(`100px "${FONT}"`),
    gltf.loadAsync('/models/kaykit/mountain_C.gltf'),
  ]);
  // Superseded while loading: build nothing, so there is no second scene
  // (and WebGL context) running untracked.
  if (mine !== starts) throw new Error('signpost start superseded');

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
  // The signpost is planted a few tiles in front of the resting lens,
  // and the river runs there: fill it in, a grassy bank blended into the
  // ground round it. The menu's valley is its own; the ground and grass
  // are built from the map after this.
  {
    const map = world.map;
    const store = [...world.buildings.values()].find(
      b => b.type === BuildingTypeId.storehouse,
    );
    const kx = store ? store.x + store.w / 2 : map.size / 2;
    const kz = store ? store.y + store.h / 2 : map.size / 2;
    const ex = kx + Math.sin(START_ANGLE) * ORBIT_RADIUS;
    const ez = kz + Math.cos(START_ANGLE) * ORBIT_RADIUS;
    const fx = (kx - ex) / ORBIT_RADIUS;
    const fz = (kz - ez) / ORBIT_RADIUS;
    // Ahead by the stage's distance, a touch right, where the post stands
    // on any window's shape.
    const px = ex + fx * STAGE_DIST * UI_SCALE - fz * 0.4;
    const pz = ez + fz * STAGE_DIST * UI_SCALE + fx * 0.4;
    const BANK = 0.12;
    const R = 3.2;
    for (let tz = Math.floor(pz - R - 2); tz <= pz + R + 2; tz++)
      for (let tx = Math.floor(px - R - 2); tx <= px + R + 2; tx++) {
        if (tx < 0 || tz < 0 || tx >= map.size || tz >= map.size) continue;
        const d = Math.hypot(tx + 0.5 - px, tz + 0.5 - pz);
        if (d > R + 2) continue;
        const i = tz * map.size + tx;
        // Full bank inside R, easing out to the ground as it was over the
        // two tiles past it.
        const k = d <= R ? 1 : 1 - THREE.MathUtils.smoothstep(d, R, R + 2);
        const h = map.height[i]!;
        if (h >= BANK) continue;
        map.height[i] = lerp(h, BANK, k);
        if (k > 0.5 && map.terrain[i] === Terrain.Water)
          map.terrain[i] = Terrain.Grass;
      }
    // And a pond to its right, a little further off, so the valley's
    // water is still in the view the bank took it out of.
    const qx = ex + fx * POND.ahead - fz * POND.right;
    const qz = ez + fz * POND.ahead + fx * POND.right;
    for (let tz = Math.floor(qz - POND.r - 2); tz <= qz + POND.r + 2; tz++)
      for (let tx = Math.floor(qx - POND.r - 2); tx <= qx + POND.r + 2; tx++) {
        if (tx < 0 || tz < 0 || tx >= map.size || tz >= map.size) continue;
        const d = Math.hypot(tx + 0.5 - qx, tz + 0.5 - qz);
        if (d > POND.r + 1.5) continue;
        const i = tz * map.size + tx;
        // A bowl: deepest in the middle, up to the bank at its rim.
        const bed = lerp(
          POND.bed,
          BANK,
          THREE.MathUtils.smoothstep(d, 0, POND.r + 1.5),
        );
        map.height[i] = Math.min(map.height[i]!, bed);
        if (bed < WATER_LEVEL) {
          map.terrain[i] = Terrain.Water;
          map.resource[i] = TileResource.None;
        }
      }
  }
  const renderer = new GameRenderer(canvas, {interactive: false});
  renderer.setWorldExtent(world.map.play, world.map.size);
  renderer.scene.fog = new THREE.Fog(SKY.horizon, FOG_NEAR, FOG_FAR);
  /** Seconds of wind, for the meadow's sway (see sway). */
  const windTime = {value: 0};
  /** The sway's materials, one per material swayed: the game shares them,
   * and they must not sway there. */
  const swaying = new Map<THREE.Material, THREE.Material>();
  /**
   * Let a meadow mesh sway in the wind: its tips bend most, its roots not
   * at all, each clump a little out of step with the next so the wind runs
   * across the field in waves. `top`: how far a tip leans (tiles).
   */
  const sway = (mesh: THREE.InstancedMesh, top: number): void => {
    const src = mesh.material as THREE.Material;
    let own = swaying.get(src);
    if (!own) {
      mesh.geometry.computeBoundingBox();
      const box = mesh.geometry.boundingBox!;
      const base = box.min.y;
      const height = Math.max(box.max.y - base, 1e-3);
      own = src.clone();
      own.onBeforeCompile = shader => {
        shader.uniforms.windTime = windTime;
        shader.vertexShader = shader.vertexShader
          .replace('void main() {', 'uniform float windTime;\nvoid main() {')
          .replace(
            '#include <begin_vertex>',
            `#include <begin_vertex>
            {
              float bend = pow(clamp((position.y - ${base.toFixed(4)}) /
                ${height.toFixed(4)}, 0.0, 1.0), 1.5) * ${top.toFixed(4)};
              vec2 at = instanceMatrix[3].xz;
              float phase = at.x * 0.45 + at.y * 0.3;
              float gust = sin(windTime * 1.3 + phase) * 0.7
                + sin(windTime * 2.9 + phase * 1.9) * 0.3;
              // In the clump's own frame, which its turn spins: every
              // clump leans its own way, as tufts do.
              transformed.x += gust * bend;
              transformed.z += gust * bend * 0.4;
            }`,
          );
      };
      own.customProgramCacheKey = () =>
        `signpost-sway-${top}-${base}-${height}`;
      swaying.set(src, own);
    }
    mesh.material = own;
  };
  renderer.scene.background = new THREE.Color(SKY.horizon);
  /** The sky and its mountains, riding with the lens (see the loop). */
  const sky = makeSky(FOG_FAR * 3);
  const heights = new HeightField(world.map.height, world.map.size);
  const water = new WaterMesh(world.map);
  const mist = new Mist(world.map);
  const camera = new THREE.PerspectiveCamera(FOV, 1, 0.3, 400);
  const grass = new GrassField(world.map, heights);
  const scatter = new ScatterMesh(world.map, heights);
  renderer.scene.add(
    new TerrainMesh(world.map, heights).group,
    scatter.group,
    grass.mesh,
    water.mesh,
    new MarginMesh(world.map, heights).mesh,
    mist.group,
    camera,
    sky.mesh,
  );
  // The meadow sways; the trees are too sturdy to.
  sway(grass.mesh, 0.035);
  for (const m of scatter.meshesOf('flower')) sway(m, 0.03);
  for (const m of scatter.meshesOf('reed')) sway(m, 0.05);
  const keep = [...world.buildings.values()].find(
    b => b.type === BuildingTypeId.storehouse,
  );
  const buildings = new BuildingSync(renderer.scene, heights);
  buildings.cameraQuaternion = camera.quaternion;
  buildings.update(snapBuildings(world));
  // The game stands a building at the ground under its middle; where the
  // ground falls away toward its edges the keep's plinth floats, which the
  // menu's lens — down at the rock, round at the back wall — sees. Sink it
  // to the lowest ground under its footprint, a little into it.
  if (keep) {
    const bx = keep.x + keep.w / 2;
    const bz = keep.y + keep.h / 2;
    let lowest = Infinity;
    for (let z = keep.y - 0.25; z <= keep.y + keep.h + 0.25; z += 0.25)
      for (let x = keep.x - 0.25; x <= keep.x + keep.w + 0.25; x += 0.25)
        lowest = Math.min(lowest, heights.at(x, z));
    for (const o of renderer.scene.children)
      if (
        Math.abs(o.position.x - bx) < 1e-3 &&
        Math.abs(o.position.z - bz) < 1e-3
      )
        o.position.y = Math.min(o.position.y, lowest - 0.05);
  }
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
  /** The post: a plain square shaft, its top just rounded off like every
   * other edge of the sign, planted in the ground where the signpost
   * stands — so its length is the ground's to say (plant, on layout). */
  const shaft = new THREE.Mesh(new THREE.BufferGeometry(), woodMat);
  post.add(shaft);
  /** Make the shaft run from its top (post space 3.4) down to `bottom`.
   * The colour's gradient runs over the part in view, the top 4.8. */
  const shaftTo = (bottom: number): void => {
    const len = Math.max(3.4 - bottom, 1);
    shaft.geometry.dispose();
    shaft.geometry = grain(
      paint(
        extrude(roundedTop(POST_HALF * 2, len, 0.07), POST_HALF * 2, 0.09),
        CELL.post,
        len / 2 - 4.6,
        len / 2 + 0.2,
      ),
      true,
      0.13,
    );
    shaft.position.y = 3.4 - len / 2;
  };
  shaftTo(3.4 - POST_LEN);

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
  const rockBoard = boardOf(faceAnchor, 'face shelf');

  // ——— the saves: written on a wall of the storehouse (placed below,
  // once the building's model is found).
  const wallAnchor = new THREE.Object3D();
  renderer.scene.add(wallAnchor);
  const savesBoard = boardOf(wallAnchor, 'face shelf');

  // ——— studio light: for the sign only. The valley's sun sits behind the
  // post from where the lens stands, which left the wood a muddy brown; the
  // pack's own renders are lit soft and even from the front. An envMap on
  // the sign's materials lights just these meshes and leaves the valley.
  /** Light a piece the studio way (set below; also used for the saves'
   * banner, hung once the castle is searched). */
  let lit: (o: THREE.Object3D) => void = () => {};
  {
    const pmrem = new THREE.PMREMGenerator(renderer.webgl);
    const studio = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    pmrem.dispose();
    lit = (o: THREE.Object3D): void => {
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
    // Now the sun is behind the lens, the sign and the rock throw shadows.
    for (const g of [ui, rock])
      g.traverse(o => {
        if ((o as THREE.Mesh).isMesh) o.castShadow = true;
      });
  }

  // ——— layout
  let postX = 0;
  let postY = 0;
  let inCouncil = false;
  let current: Arrow | null = null;
  let shelfOpen: Shelf | null = null;
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
    } = frameFor(a.len, council, innerWidth, camera.aspect, NEEDS[a.mode]);
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
    const [from, to] = frameFor(
      a.len,
      council,
      innerWidth,
      camera.aspect,
      NEEDS[a.mode],
    ).view;
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
  const map = world.map;
  const mapSize = map.size;
  const tileAt = (x: number, z: number): number => {
    const tx = Math.floor(x);
    const tz = Math.floor(z);
    return tx < 0 || tz < 0 || tx >= mapSize || tz >= mapSize
      ? -1
      : tz * mapSize + tx;
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
  // The sun behind the resting lens, off to its right (see SUN), and its
  // shadow box held over the lens's side of the valley — the signpost, the
  // keep, the rock — rather than the whole world, so shadows come out
  // crisp.
  {
    const back = new THREE.Vector3(
      Math.sin(START_ANGLE),
      0,
      Math.cos(START_ANGLE),
    );
    const right = new THREE.Vector3(back.z, 0, -back.x);
    const dir = back
      .clone()
      .multiplyScalar(Math.cos(SUN.right))
      .addScaledVector(right, Math.sin(SUN.right))
      .multiplyScalar(Math.cos(SUN.up))
      .setY(Math.sin(SUN.up));
    renderer.setSun(dir);
    sky.setSun(dir);
    renderer.aimShadow(
      new THREE.Vector3((cx + restX) / 2, groundY, (cz + restZ) / 2),
      SHADOW_HALF,
    );
  }
  /** Clear the grass on the tiles `along` ahead of (x, z) toward `face`,
   * `across` either side: a trodden patch where the lens stands, since
   * seen from there, grass a stride away stands taller than the list. */
  const tread = (
    x: number,
    z: number,
    face: number,
    along: number,
    across: number,
  ): void => {
    const fx = Math.sin(face);
    const fz = Math.cos(face);
    for (let d = -across; d <= along; d += 0.5)
      for (let l = -across; l <= across; l += 0.5) {
        const i = tileAt(x + fx * d - fz * l, z + fz * d + fx * l);
        if (i >= 0) grass.removeTile(i);
      }
  };
  /**
   * Grass and flowers at the rock's foot, either side of the list: the
   * valley's own clumps, bigger, so the rock stands in the meadow rather
   * than on a lawn. Kept out from in front of the list — the list is drawn
   * over the valley, so a blade there would show behind the writing.
   */
  const tuft = (face: number): void => {
    rock.updateMatrixWorld(true);
    const at = faceAnchor.getWorldPosition(new THREE.Vector3());
    const fx = Math.sin(face);
    const fz = Math.cos(face);
    /** Half the list's width, and a hair. */
    const clear = (LIST_W * ROCK_WIDTH) / rockW / 2 + 0.08;
    // [side, out past the list's edge, off the face, size, flower]
    const clumps: [number, number, number, number, boolean][] = [
      [-1, 0.1, 0.3, 1.2, false],
      [-1, 0.45, 0.45, 1.0, true],
      [1, 0.15, 0.35, 0.9, true],
      [1, 0.5, 0.25, 1.1, false],
    ];
    const grassN = clumps.filter(c => !c[4]).length;
    const grassMesh = new THREE.InstancedMesh(
      crossedQuads(0.62, 0.42),
      foliageMaterial(makeGrassSprite()),
      grassN,
    );
    const flowerMesh = new THREE.InstancedMesh(
      crossedQuads(0.5, 0.4),
      foliageMaterial(makeFlowerSprite()),
      clumps.length - grassN,
    );
    const put = new THREE.Object3D();
    let g = 0;
    let f = 0;
    clumps.forEach(([side, out, off, size, flower], k) => {
      const l = side * (clear + out);
      const x = at.x + fx * off + fz * l;
      const z = at.z + fz * off - fx * l;
      put.position.set(x, heights.at(x, z) + (flower ? 0.18 : 0.2) * size, z);
      put.rotation.set(0, k * 1.3, 0);
      put.scale.setScalar(size);
      put.updateMatrix();
      if (flower) flowerMesh.setMatrixAt(f++, put.matrix);
      else grassMesh.setMatrixAt(g++, put.matrix);
    });
    renderer.scene.add(grassMesh, flowerMesh);
    sway(grassMesh, 0.04);
    sway(flowerMesh, 0.03);
  };
  const findRockSpot = (): {x: number; z: number; y: number; face: number} => {
    const size = mapSize;
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
    tread(spot.x, spot.z, spot.face, 8, 1.5);
    // The face points `face`; the model's face points ROCK_FACE.yaw.
    rock.rotation.y = spot.face - ROCK_FACE.yaw;
    tuft(spot.face);
  }

  /**
   * The storehouse's wall: the biggest single flat, upright face of its
   * model — found in the geometry the building is drawn with, so it holds
   * whatever the model is — facing out, on the far side from the resting
   * lens, out of sight until the lens goes round. One face: triangles in
   * one plane that touch, so a list never runs round a corner or across to
   * a piece of wall that only happens to line up. Written on it, upright.
   */
  /**
   * Over the castle's own banner — a flat card at the lens's distance —
   * hang the Dungeon pack's, the rally flag's cloth, which has folds and a
   * cut foot to it: a touch bigger, so it covers the card, flush on the
   * wall. Double-sided, as the rally flag has it (the pack ships it for
   * dungeon walls, one face only), and lit the signpost's way.
   */
  /** The list's size on the wall, and what the lens frames there: the
   * whole banner, centred on it (wallView). */
  const wall = {w: 1, h: 1};
  const wallFit = {w: 1, h: 1};
  const wallView = new THREE.Object3D();
  renderer.scene.add(wallView);
  if (keep) {
    renderer.scene.updateMatrixWorld(true);
    const bx = keep.x + keep.w / 2;
    const bz = keep.y + keep.h / 2;
    const reach = Math.max(keep.w, keep.h) / 2 + 0.5;
    interface Tri {
      pts: [THREE.Vector3, THREE.Vector3, THREE.Vector3];
      area: number;
    }
    interface Plane {
      n: THREE.Vector3;
      tris: Tri[];
    }
    const planes = new Map<string, Plane>();
    /** The building's own meshes: what may stand between the lens and a
     * face. */
    const walls: THREE.Mesh[] = [];
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    const c = new THREE.Vector3();
    const n = new THREE.Vector3();
    const box = new THREE.Box3();
    renderer.scene.traverse(o => {
      const m = o as THREE.Mesh;
      if (!m.isMesh || (m as THREE.InstancedMesh).isInstancedMesh) return;
      // The building's own model: within its footprint (not the ground it
      // stands on, which is centred there too), and tall (not a pile).
      box.setFromObject(m);
      const mid = box.getCenter(a);
      if (Math.abs(mid.x - bx) > reach || Math.abs(mid.z - bz) > reach) return;
      if (box.max.x - box.min.x > 2 * reach) return;
      if (box.max.z - box.min.z > 2 * reach) return;
      if (box.max.y - box.min.y < 0.8) return;
      walls.push(m);
      // A mirrored piece (negative scale) has its triangles wound the
      // other way round: its faces' fronts are the other side.
      const flip = m.matrixWorld.determinant() < 0 ? -1 : 1;
      const pos = m.geometry.getAttribute('position');
      const idx = m.geometry.getIndex();
      const count = idx ? idx.count : pos.count;
      const at = (k: number, v: THREE.Vector3): THREE.Vector3 =>
        v
          .fromBufferAttribute(pos, idx ? idx.getX(k) : k)
          .applyMatrix4(m.matrixWorld);
      for (let k = 0; k + 2 < count; k += 3) {
        at(k, a);
        at(k + 1, b);
        at(k + 2, c);
        n.subVectors(b, a).cross(c.clone().sub(a));
        const area = n.length() / 2;
        if (area < 1e-5) continue;
        n.normalize().multiplyScalar(flip);
        if (Math.abs(n.y) > 0.05) continue;
        // Facing out of the building, not into its courtyard.
        if (n.x * (a.x - bx) + n.z * (a.z - bz) <= 0) continue;
        // The far side only: facing away from the resting lens.
        if (n.x * (restX - bx) + n.z * (restZ - bz) >= 0) continue;
        const key = [n.x, n.z, n.dot(a)].map(v => Math.round(v * 20)).join();
        let p = planes.get(key);
        if (!p) planes.set(key, (p = {n: n.clone(), tris: []}));
        p.tris.push({pts: [a.clone(), b.clone(), c.clone()], area});
      }
    });
    // Each plane's triangles, joined where they share a corner: its faces.
    const vkey = (v: THREE.Vector3): string =>
      `${Math.round(v.x * 1e3)},${Math.round(v.y * 1e3)},${Math.round(v.z * 1e3)}`;
    const faces: {n: THREE.Vector3; pts: THREE.Vector3[]; area: number}[] = [];
    for (const p of planes.values()) {
      const root = p.tris.map((_, i) => i);
      const find = (i: number): number => {
        while (root[i] !== i) i = root[i] = root[root[i]!]!;
        return i;
      };
      const owner = new Map<string, number>();
      p.tris.forEach((t, i) => {
        for (const v of t.pts) {
          const k = vkey(v);
          const j = owner.get(k);
          if (j === undefined) owner.set(k, i);
          else root[find(i)] = find(j);
        }
      });
      const joined = new Map<number, {pts: THREE.Vector3[]; area: number}>();
      p.tris.forEach((t, i) => {
        const r = find(i);
        let f = joined.get(r);
        if (!f) joined.set(r, (f = {pts: [], area: 0}));
        f.pts.push(...t.pts);
        f.area += t.area;
      });
      for (const f of joined.values()) faces.push({n: p.n, ...f});
    }
    faces.sort((x, y) => y.area - x.area);
    /** A face's frame: its middle, its axes, its size. */
    const frame = (f: (typeof faces)[number]) => {
      const normal = f.n;
      const up = new THREE.Vector3(0, 1, 0);
      const right = new THREE.Vector3().crossVectors(up, normal);
      let lo = Infinity;
      let hi = -Infinity;
      let bottom = Infinity;
      let top = -Infinity;
      for (const q of f.pts) {
        const u = q.x * right.x + q.z * right.z;
        lo = Math.min(lo, u);
        hi = Math.max(hi, u);
        bottom = Math.min(bottom, q.y);
        top = Math.max(top, q.y);
      }
      const p0 = f.pts[0]!;
      const off = (lo + hi) / 2 - (p0.x * right.x + p0.z * right.z);
      const mid = new THREE.Vector3(
        p0.x + right.x * off,
        (bottom + top) / 2,
        p0.z + right.z * off,
      );
      return {mid, normal, up, right, w: hi - lo, h: top - bottom};
    };
    // The biggest face the lens can see all of from where it will stand:
    // rays from there to its middle and toward its corners, none stopped
    // by another part of the building.
    const ray = new THREE.Raycaster();
    const eye = new THREE.Vector3();
    const toPt = new THREE.Vector3();
    const seen = (fr: ReturnType<typeof frame>): boolean => {
      const dist = Math.max(
        fr.h / (0.8 * 2 * TAN),
        fr.w / (0.9 * 2 * TAN * camera.aspect),
      );
      eye.copy(fr.mid).addScaledVector(fr.normal, dist);
      // Its front: a ray to its middle meets it, where it is. (From behind,
      // a ray passes through a face's back unseen, so this is what tells.)
      toPt.subVectors(fr.mid, eye);
      ray.set(eye, toPt.clone().normalize());
      ray.far = dist + 0.05;
      const hit = ray.intersectObjects(walls, false)[0];
      if (!hit || hit.distance < dist - 0.03) return false;
      for (const [du, dv] of [
        [0, 0],
        [-0.4, -0.4],
        [0.4, -0.4],
        [-0.4, 0.4],
        [0.4, 0.4],
      ] as const) {
        const pt = fr.mid
          .clone()
          .addScaledVector(fr.right, du * fr.w)
          .addScaledVector(fr.up, dv * fr.h)
          .addScaledVector(fr.normal, 0.01);
        toPt.subVectors(pt, eye);
        const far = toPt.length();
        ray.set(eye, toPt.normalize());
        ray.far = far - 0.02;
        if (ray.intersectObjects(walls, false).length > 0) return false;
      }
      return true;
    };
    // On this castle that is one of its banners, out of sight at the
    // back; any wall at all will do before none. Of those the lens can see
    // whole, the one facing about WALL_FACING round from the resting lens:
    // straight away from it, the walk there (one circle, walkToWall) would
    // have to go right round the keep; that far round, it sweeps out to the
    // side and comes in to the wall head on.
    const framed = faces.map(frame).filter(fr => fr.w > 0.3 && fr.h > 0.6);
    const toRest = new THREE.Vector3(restX - bx, 0, restZ - bz).normalize();
    const facing = (fr: (typeof framed)[number]): number =>
      Math.abs(fr.normal.dot(toRest) - Math.cos(WALL_FACING));
    const wallFace =
      framed.filter(seen).sort((a, b) => facing(a) - facing(b))[0] ?? framed[0];
    // The banner on it: a smaller face just in front of it, parallel,
    // within its outline. The list takes the plain stone under its point,
    // clear of the carved bricks low on the wall.
    let chosen = wallFace;
    if (wallFace) {
      for (const fr of faces.map(frame)) {
        if (fr.normal.dot(wallFace.normal) < 0.99) continue;
        const ahead = toPt
          .subVectors(fr.mid, wallFace.mid)
          .dot(wallFace.normal);
        if (ahead < 0.003 || ahead > 0.2) continue;
        const across = Math.abs(toPt.dot(wallFace.right));
        const upDown = Math.abs(fr.mid.y - wallFace.mid.y);
        if (across > wallFace.w / 2 || upDown > wallFace.h / 2) continue;
        if (fr.h < 0.3 || fr.w < 0.15) continue;
        const foot = wallFace.mid.y - wallFace.h / 2 + 0.06;
        const point = fr.mid.y - fr.h / 2 - 0.03;
        if (point - foot < 0.4) break;
        const low = foot + (point - foot) * 0.265;
        chosen = {
          ...wallFace,
          mid: wallFace.mid.clone().setY((low + point) / 2),
          h: point - low,
        };
        break;
      }
    }
    if (chosen) {
      // Clear of whatever is over the list — a window, a banner's point.
      chosen = {
        ...chosen,
        mid: chosen.mid.clone().setY(chosen.mid.y - LIST_TOP_GAP / 2),
        h: chosen.h - LIST_TOP_GAP,
      };
      wallAnchor.position.copy(chosen.mid);
      wallAnchor.quaternion.setFromRotationMatrix(
        new THREE.Matrix4().makeBasis(chosen.right, chosen.up, chosen.normal),
      );
      wall.w = chosen.w;
      wall.h = chosen.h;
      // Framed close: the list and a band of stone round it.
      wallView.quaternion.copy(wallAnchor.quaternion);
      wallView.position.copy(chosen.mid);
      wallFit.w = chosen.w * 1.08;
      wallFit.h = chosen.h * 1.2;
    }
  }

  /**
   * A shelf's stop: the surface its list is written on, and how the lens
   * looks at it. The anchor is the list's middle, its +z out of the
   * surface and its +y the list's up.
   */
  interface Stop {
    board: {el: HTMLDivElement; obj: CSS3DObject};
    anchor: THREE.Object3D;
    /** What the lens centres on, if not the list: the whole of a thing
     * the list is only part of. Its +z is the surface's out. */
    view?: THREE.Object3D;

    /** The surface to frame, and the list on it (tiles). */
    fit: {w: number; h: number};
    list: {w: number; h: number};
    /** How steeply the lens looks at the surface: PI / 2 square on. */
    elev: number;
    /** Set by placeStop: how far off the lens stands (tiles). */
    dist: number;
  }
  const rockScale = ROCK_WIDTH / rockW;
  const stops: Record<Shelf, Stop> = {
    replays: {
      board: rockBoard,
      anchor: faceAnchor,
      fit: {w: ROCK_FACE.w * rockScale, h: ROCK_FACE.high * rockScale},
      list: {w: LIST_W * rockScale, h: LIST_H * rockScale},
      elev: Math.PI / 2,
      dist: 1,
    },
    saves: {
      board: savesBoard,
      anchor: wallAnchor,
      view: wallView,
      fit: wallFit,
      list: {w: wall.w * 0.9, h: wall.h},
      elev: Math.PI / 2,
      dist: 1,
    },
  };

  /**
   * Stand the lens far enough off that the surface fills most of the
   * window's height — or its width, on a phone — and lay the list out to
   * fit it, about 380px wide whatever that comes to on screen.
   */
  const placeStop = (stop: Stop): void => {
    const {el, obj} = stop.board;
    stop.dist = Math.max(
      (stop.fit.h * Math.sin(stop.elev)) / (0.8 * 2 * TAN),
      stop.fit.w / (0.9 * 2 * TAN * camera.aspect),
    );
    const toPx = innerHeight / (2 * stop.dist * TAN);
    // As long as the surface allows, and no longer than shows.
    const shows = (0.82 * 2 * TAN * stop.dist) / Math.sin(stop.elev);
    const listH = Math.min(stop.list.h, shows);
    const k = THREE.MathUtils.clamp((stop.list.w * toPx) / 380, 0.75, 1.35);
    el.style.width = `${(stop.list.w * toPx) / k}px`;
    el.style.height = `${(listH * toPx) / k}px`;
    // In the anchor's units, which may be a model's.
    stop.anchor.updateWorldMatrix(true, false);
    const scale = stop.anchor.getWorldScale(tmpScale).x;
    obj.scale.setScalar(k / toPx / scale);
    // A hair off the surface, toward the lens.
    obj.position.set(0, 0, 0.002 / scale);
  };
  const tmpScale = new THREE.Vector3();

  /** Where the lens rests, looking at the signpost: START_ANGLE round,
   * the keep pushed left on a wide window to leave the right for the
   * signpost. */
  const placeRest = (): void => {
    const room = THREE.MathUtils.clamp((camera.aspect - 1) / 0.8, 0, 1);
    rest.position.set(
      restX,
      Math.max(heights.at(restX, restZ), WATER_LEVEL) + EYE_HEIGHT,
      restZ,
    );
    rest.lookAt(cx, groundY + LOOK_HEIGHT, cz);
    rest.rotateY(-0.2 * room);
    ui.position.copy(rest.position);
    ui.quaternion.copy(rest.quaternion);
    stage.position.copy(REST);
    ui.updateMatrixWorld(true);
    // Plant the post: down to the ground under it (a bank over the river
    // there, made for it at the start), and a little in.
    const foot = post.localToWorld(new THREE.Vector3(0, 0, 0));
    foot.y = heights.at(foot.x, foot.z) - POST_SUNK;
    shaftTo(post.worldToLocal(foot).y);
  };

  const layout = (): void => {
    const aspect = camera.aspect;
    const halfW = STAGE_DIST * TAN * aspect;
    // The widest the signpost gets: the longest arrow each way from the post.
    const span = 2 * (4.0 - THROUGH);
    const s = Math.min(0.7, (halfW * 2 * 0.94) / span);
    post.scale.setScalar(s);
    // Right of centre on a wide screen, so the keep (pushed left by the
    // lens) stays in view, and the trees and rocks on the left.
    postX = aspect > 1.15 ? halfW * 0.28 : 0;
    // On a screen taller than wide the signpost shrinks to fit the width
    // and would sit low under an empty sky; lift its arrows toward the
    // middle, more the taller the screen.
    const arrowsMid = (ARROW_SPECS[0]!.y + ARROW_SPECS[2]!.y) / 2;
    const lift = THREE.MathUtils.clamp((1 - aspect) / 0.4, 0, 1);
    postY = lift * (STAGE_Y - arrowsMid * s - 0.2);
    post.position.set(postX, postY, 0);
    for (const a of arrows) place(a.face, a.faceObj, a, false);
    place(councilFace, councilObj, multi, true);
    placeStop(stops.replays);
    placeStop(stops.saves);
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
    // The hover's glow goes out on the way: the loop leaves the open arrow
    // alone, so whatever it held here it would still hold coming back.
    const g0 = a.glow;
    await tween(instant ? 1 : TURN_MS, t => {
      // The turn leads, the move follows a little behind: it reads as the
      // signpost being turned toward you rather than the camera flying.
      post.rotation.y = lerp(r0, Math.PI, t);
      stageBase.lerpVectors(from, to, easeInOut(Math.min(1, t * 1.15)));
      a.root.rotation.y = lerp(y0, 0, t);
      a.root.rotation.z = lerp(z0, 0, t);
      a.glow = lerp(g0, 0, t);
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
    // Back at rest, not hovered: it lights and leans again only if the
    // pointer is on it now.
    a.vel = 0;
    current = null;
    busy = false;
  };

  /** How far the lens is on its way to a shelf: 0 at the signpost, 1 at
   * the shelf. */
  let fly = 0;
  /** The shelf the lens is at or going to (or coming back from). */
  let target: Stop = stops.replays;

  const showShelf = async (shelf: Shelf): Promise<void> => {
    busy = true;
    shelfOpen = shelf;
    target = stops[shelf];
    events.onBoard(shelf);
    const f0 = fly;
    await tween(target === stops.saves ? WALL_WALK_MS : FLY_MS, t => {
      fly = lerp(f0, 1, t);
    });
    activate(target.board.el, true);
    busy = false;
  };

  const hideShelf = async (): Promise<void> => {
    if (!shelfOpen) return;
    busy = true;
    activate(target.board.el, false);
    events.onBoard(null);
    const f0 = fly;
    await tween(target === stops.saves ? WALL_WALK_MS : FLY_MS, t => {
      fly = lerp(f0, 0, t);
    });
    shelfOpen = null;
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

  /** Hover is a mouse's: a finger's last touch is not resting on anything. */
  let mouse = false;
  const onMove = (e: PointerEvent): void => {
    pointer.copy(toNdc(e.clientX, e.clientY));
    mouse = e.pointerType === 'mouse';
    if (mouse) leanTo.copy(pointer).clampScalar(-1, 1);
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
  let held: {beta: number; gamma: number; turn: number} | null = null;
  const onTilt = (e: DeviceOrientationEvent): void => {
    if (e.beta === null || e.gamma === null) return;
    // Held sideways, the phone's own axes swap round the screen's.
    const turn = screen.orientation?.angle ?? 0;
    const across =
      turn === 90 ? e.beta : turn === 270 || turn === -90 ? -e.beta : e.gamma;
    const along =
      turn === 90 ? -e.gamma : turn === 270 || turn === -90 ? e.gamma : e.beta;
    // A rotation swaps the axes the rest was measured on: start again.
    if (held?.turn !== turn) held = {beta: along, gamma: across, turn};
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
          // The sheet can be answered after the scene has gone (the tap
          // was Play): nothing to lean then.
          if (r === 'granted' && !stopped)
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
  const walk = new THREE.Vector3();
  const lensAt = new THREE.Vector3();
  const faceAt = new THREE.Vector3();
  const faceN = new THREE.Vector3();
  const faceRight = new THREE.Vector3();
  const signPos = new THREE.Vector3();
  const signQuat = new THREE.Quaternion();
  const rockQuat = new THREE.Quaternion();
  const stopPos = new THREE.Vector3();
  const keepQuat = new THREE.Quaternion();
  /**
   * The trip to the castle's wall: round one circle, from the lens at the
   * signpost (A) to the lens at the wall (B), arriving at B moving
   * straight on to the wall. Of the circles through A, the one that meets
   * the line in to the wall at B head on — its centre off to one side of
   * B, along the wall — and round it the way that arrives moving toward
   * the wall, however far round that is: out from the signpost, a wide
   * sweep, and in. Along the ground: its height over the ground eases from
   * the signpost's to the wall's. The lens turns off the signpost onto the
   * castle and keeps to it, turning onto the wall — square to it — only at
   * the end. `signPos`/`signQuat` are the lens at the signpost,
   * `stopPos`/`rockQuat` at the wall, `faceN` the way out of the wall;
   * `fly` how far along.
   */
  const castleAt = new THREE.Vector3();
  const walkToWall = (): void => {
    const under = (x: number, z: number): number =>
      Math.max(heights.at(x, z), WATER_LEVEL);
    // n: out of the wall; w: along it.
    const nx = faceN.x;
    const nz = faceN.z;
    const nl = Math.hypot(nx, nz) || 1;
    const ox = nx / nl;
    const oz = nz / nl;
    const wx = oz;
    const wz = -ox;
    // The centre C = B + w s, as far from A as from B.
    const abx = signPos.x - stopPos.x;
    const abz = signPos.z - stopPos.z;
    const across = wx * abx + wz * abz;
    const sgn = Math.abs(across) < 1e-3 ? 1e-3 : across;
    const off = (abx * abx + abz * abz) / (2 * sgn);
    const mx = stopPos.x + wx * off;
    const mz = stopPos.z + wz * off;
    const radius = Math.abs(off);
    const a0 = Math.atan2(signPos.x - mx, signPos.z - mz);
    const a1 = Math.atan2(stopPos.x - mx, stopPos.z - mz);
    // Round the way that arrives moving in to the wall (against n): at an
    // angle a the circle runs (cos a, -sin a) as a grows.
    const dir = Math.cos(a1) * -ox + -Math.sin(a1) * -oz > 0 ? 1 : -1;
    const turn =
      dir * THREE.MathUtils.euclideanModulo(dir * (a1 - a0), Math.PI * 2);
    const ang = a0 + turn * fly;
    camera.position.set(
      mx + Math.sin(ang) * radius,
      0,
      mz + Math.cos(ang) * radius,
    );
    const h0 = signPos.y - under(signPos.x, signPos.z);
    const h1 = stopPos.y - under(stopPos.x, stopPos.z);
    // Arching up over the trees on the way, down again at each end.
    camera.position.y =
      under(camera.position.x, camera.position.z) +
      lerp(h0, h1, fly) +
      Math.sin(fly * Math.PI) * WALK_ARCH;
    // Off the signpost onto the castle, kept on the castle all the way,
    // and onto the wall at the end.
    castleAt.set(cx, faceAt.y + 0.6, cz);
    camera.lookAt(castleAt);
    keepQuat.copy(camera.quaternion);
    camera.quaternion.slerpQuaternions(
      signQuat,
      keepQuat,
      THREE.MathUtils.smoothstep(fly, 0, 0.35),
    );
    const onto = THREE.MathUtils.smoothstep(fly, 0.8, 1);
    if (onto > 0) {
      keepQuat.copy(camera.quaternion);
      camera.quaternion.slerpQuaternions(keepQuat, rockQuat, onto);
    }
  };
  const anchorQuat = new THREE.Quaternion();
  const listUp = new THREE.Vector3();
  const yAxis = new THREE.Vector3(0, 1, 0);
  let last = performance.now();
  // ——— two butterflies out in the field behind the pond: the game's own
  // painted ones.
  const flutterers = new THREE.InstancedMesh(
    butterflyQuad().scale(BUTTERFLY.size, 1, BUTTERFLY.size),
    new THREE.MeshBasicMaterial({
      map: makeButterflySprite(),
      alphaTest: 0.5,
      side: THREE.DoubleSide,
    }),
    BUTTERFLY.spots.length,
  );
  flutterers.frustumCulled = false;
  BUTTERFLY.spots.forEach(({tint}, k) =>
    flutterers.setColorAt(k, new THREE.Color(tint)),
  );
  renderer.scene.add(flutterers);
  const flutterAt = new THREE.Object3D();
  flutterAt.rotation.order = 'YXZ';
  /** Move the butterflies on: `t` seconds. They loop about spots set off
   * the post's foot along the resting lens's right and forward. */
  const flutter = (t: number): void => {
    // The pond's frame: from the resting lens toward the keep.
    const ax = (cx - restX) / ORBIT_RADIUS;
    const az = (cz - restZ) / ORBIT_RADIUS;
    for (let k = 0; k < BUTTERFLY.spots.length; k++) {
      const {right, ahead, phase} = BUTTERFLY.spots[k]!;
      const sx = restX + ax * ahead - az * right;
      const sz = restZ + az * ahead + ax * right;
      const w = wander(0, 0, phase, t + phase);
      const x = sx + w.x * BUTTERFLY.reach;
      const z = sz + w.z * BUTTERFLY.reach;
      flutterAt.position.set(
        x,
        Math.max(heights.at(x, z), WATER_LEVEL) +
          BUTTERFLY.height +
          Math.sin((t + phase) * 1.9) * 0.12,
        z,
      );
      // Wings turned up toward the lens, banking the way it is flying:
      // level, from down here, they were edge-on and all but vanished.
      const toLens = Math.atan2(camera.position.x - x, camera.position.z - z);
      flutterAt.rotation.set(
        -BUTTERFLY.tip,
        toLens + Math.PI,
        Math.sin(w.yaw - toLens) * 0.5,
      );
      const flap = Math.abs(Math.sin((t + phase) * 17));
      flutterAt.scale.set(0.3 + 0.7 * flap, 1, 1);
      flutterAt.updateMatrix();
      flutterers.setMatrixAt(k, flutterAt.matrix);
    }
    flutterers.instanceMatrix.needsUpdate = true;
  };
  const pacer = new FramePacer(MENU_FPS);
  const loop = (now: number): void => {
    if (stopped) return;
    raf = requestAnimationFrame(loop);
    // At most one frame in flight — see GameRenderer.gpuReady — and at
    // most MENU_FPS of them.
    if (!renderer.gpuReady() || !pacer.due(now)) return;
    const dt = Math.min((now - last) / 1000, 0.05);
    if (!still) {
      sky.drift(dt);
      windTime.value += dt;
    }
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
    // The signpost stands where it is planted; the zoom onto a board is
    // the lens walking up to it — where the stage would have come to the
    // lens, the lens goes the other way.
    const lean = (-stageBase.z / STAGE_DIST) ** 2;
    stage.position.copy(REST);
    ui.updateMatrixWorld();
    walk.subVectors(REST, stageBase);
    ui.localToWorld(pivot.set(walk.x, walk.y, REST.z));
    ui.localToWorld(
      lensAt.set(
        walk.x + px * LEAN.x * lean,
        walk.y + py * LEAN.y * lean,
        walk.z,
      ),
    );
    camera.position.copy(lensAt);
    camera.lookAt(pivot);
    if (fly === 0 && camera.near !== 0.3) {
      camera.near = 0.3;
      camera.updateProjectionMatrix();
    }
    if (fly > 0) {
      signPos.copy(camera.position);
      signQuat.copy(camera.quaternion);
      // At the shelf: off the surface at its angle, swung round it by the
      // pointer.
      const {elev, dist} = target;
      const anchor = target.view ?? target.anchor;
      anchor.updateWorldMatrix(true, false);
      anchor.getWorldPosition(faceAt);
      anchor.getWorldQuaternion(anchorQuat);
      faceN.set(0, 0, 1).applyQuaternion(anchorQuat);
      listUp.set(0, 1, 0).applyQuaternion(anchorQuat);
      faceN
        .multiplyScalar(Math.sin(elev))
        .addScaledVector(listUp, -Math.cos(elev))
        .normalize();
      faceRight.crossVectors(faceN, yAxis).negate().normalize();
      camera.position
        .copy(faceAt)
        .addScaledVector(faceN, dist)
        .addScaledVector(faceRight, px * SHELF_LEAN.x * dist);
      camera.position.y += py * SHELF_LEAN.y * dist;
      // Never under the ground (or the river) where it stands.
      camera.position.y = Math.max(
        camera.position.y,
        Math.max(
          heights.at(camera.position.x, camera.position.z),
          WATER_LEVEL,
        ) + Math.min(0.5, dist * 0.3),
      );
      camera.lookAt(faceAt);
      // Close in on a small thing, the near plane comes in with the lens.
      const near = lerp(0.3, Math.min(0.3, dist * 0.1), fly);
      if (Math.abs(camera.near - near) > 1e-4) {
        camera.near = near;
        camera.updateProjectionMatrix();
      }
      stopPos.copy(camera.position);
      rockQuat.copy(camera.quaternion);
      if (target === stops.saves) walkToWall();
      else {
        // On the way: round the keep rather than through it — the angle
        // round it swings over first, the distance from it closes in
        // after — a little lifted mid-trip.
        const a0 = Math.atan2(signPos.x - cx, signPos.z - cz);
        const a1 = Math.atan2(stopPos.x - cx, stopPos.z - cz);
        const turn =
          THREE.MathUtils.euclideanModulo(a1 - a0 + Math.PI, Math.PI * 2) -
          Math.PI;
        const r0 = Math.hypot(signPos.x - cx, signPos.z - cz);
        const r1 = Math.hypot(stopPos.x - cx, stopPos.z - cz);
        const ang = a0 + turn * fly;
        const r = lerp(r0, r1, fly * fly);
        camera.position.set(
          cx + Math.sin(ang) * r,
          lerp(signPos.y, stopPos.y, fly) + Math.sin(fly * Math.PI) * 1.5,
          cz + Math.cos(ang) * r,
        );
        camera.quaternion.slerpQuaternions(signQuat, rockQuat, fly);
      }
    }

    hovered =
      !mouse || busy || current || shelfOpen ? null : arrowUnder(pointer);
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
    for (const [shelf, stop] of Object.entries(stops) as [Shelf, Stop][])
      stop.board.el.style.visibility =
        shelfOpen === shelf && facing(stop.board.obj) ? 'visible' : 'hidden';

    water.update(now);
    mist.update(now);
    sky.mesh.position.copy(camera.position);
    // After the lens is placed: the wings turn to where it is now.
    flutter(still ? 0 : now / 1000);
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
    shelfFaces: {replays: rockBoard.el, saves: savesBoard.el},
    open: (mode, instant = false) =>
      queue(async () => {
        const a = byMode(mode);
        if (current === a) return;
        await hideShelf();
        if (current) await turnBack();
        await turnTo(a, instant);
      }),
    openShelf: shelf =>
      queue(async () => {
        if (shelfOpen === shelf) return;
        if (inCouncil) return; // a room is left by its Leave, not by this
        await hideShelf();
        if (current) await turnBack();
        await showShelf(shelf);
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
