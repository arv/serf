import * as THREE from 'three';
import {RoomEnvironment} from 'three/addons/environments/RoomEnvironment.js';
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
import * as PlayerKind from '../../sim/playerKindEnum.ts';
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
 * One WebGL context, one loop: the signpost is parented to the valley
 * camera rather than drawn on a second canvas over it, and nothing is
 * blurred by CSS — a full-screen filter under a canvas that changes every
 * frame is re-run every frame, and stutters.
 */

export type Mode = 'campaign' | 'skirmish' | 'multi';

export interface SignpostEvents {
  /** The open board changed; null is back at the crossroads. */
  onBoard(mode: Mode | null): void;
}

export interface SignpostScene {
  /** Each mode's board: an element on the back of its arrow. */
  readonly faces: Readonly<Record<Mode, HTMLDivElement>>;
  /** The War Council's board, on the front of the Multiplayer arrow. */
  readonly councilFace: HTMLDivElement;
  /** Turn the signpost round to `mode`'s board (closing another first).
   * `instant` skips the animation — a page that opens already there. */
  open(mode: Mode, instant?: boolean): Promise<void>;
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
/** Where the walk starts — chosen so the sun rakes across the keep. */
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
 * Everything of the menu hangs off the camera. In `ui` space the camera is
 * at the origin looking down -z; the whole of it is shrunk toward the lens,
 * so the post stands a few tiles off rather than nine — well clear of any
 * hill between it and the eye. `stage` is where the signpost stands; the
 * zoom onto an arrow is `stage` sliding toward the lens.
 */
const STAGE_DIST = 9.5;
const STAGE_Y = 1.5;
const UI_SCALE = 0.45;

const TURN_MS = 1150;
const FLIP_MS = 900;

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
  await Promise.all([loadGlbAssets(), document.fonts.load(`100px "${FONT}"`)]);

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

  // ——— the stage the signpost stands on, hung off the camera
  const ui = new THREE.Group();
  ui.scale.setScalar(UI_SCALE);
  camera.add(ui);
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

  // ——— studio light: for the sign only. The valley's sun sits behind the
  // post from where the lens stands, which left the wood a muddy brown; the
  // pack's own renders are lit soft and even from the front. An envMap on
  // the sign's materials lights just these meshes and leaves the valley.
  {
    const pmrem = new THREE.PMREMGenerator(renderer.webgl);
    const studio = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
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

  // ——— layout
  let postX = 0;
  let postY = 0;
  let inCouncil = false;
  let current: Arrow | null = null;

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
  };

  let busy = false;
  const fit = (): void => {
    camera.aspect = innerWidth / Math.max(innerHeight, 1);
    camera.updateProjectionMatrix();
    css.setSize(innerWidth, innerHeight);
    layout();
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
  /** Where the sway leans toward: the mouse, and only the mouse. A finger
   * leaves no position between taps, and a lean toward its last tap would
   * slide the board off-centre on a phone. */
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
    if (!current) {
      const a = arrowUnder(toNdc(e.clientX, e.clientY));
      if (a) void scene.open(a.mode);
    } else if (!inCouncil) {
      void scene.close();
    }
  };
  window.addEventListener('pointermove', onMove);
  window.addEventListener('click', onClick);

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

    // The valley: a slow sway rather than a full orbit — the post is lit by
    // the valley's sun, and a full turn would walk it into back-light.
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
    // lens closes in, so at the crossroads it sways and in front of a board
    // — on a phone held upright, very close — it barely moves at all.
    const lean = still ? 0 : (-stageBase.z / STAGE_DIST) ** 2;
    stage.position.set(
      stageBase.x - parallax.x * 0.18 * lean,
      stageBase.y - parallax.y * 0.1 * lean,
      stageBase.z,
    );

    hovered = busy || current ? null : arrowUnder(pointer);
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
    open: (mode, instant = false) =>
      queue(async () => {
        const a = byMode(mode);
        if (current === a) return;
        if (current) await turnBack();
        await turnTo(a, instant);
      }),
    close: () =>
      queue(async () => {
        if (inCouncil) await flip(false, false);
        await turnBack();
      }),
    enterCouncil: (instant = false) =>
      queue(async () => {
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
