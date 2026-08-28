import * as THREE from 'three';
import { GameRenderer } from '../render/renderer';
import { TerrainMesh } from '../render/terrainMesh';
import { ScatterMesh } from '../render/scatterMesh';
import { HeightField } from '../render/heightField';
import { GrassField } from '../render/grassField';
import { WaterMesh } from '../render/waterMesh';
import { MarginMesh } from '../render/marginMesh';
import { Mist } from '../render/mist';
import { background } from '../render/palette';
import { BuildingSync } from '../render/buildingSync';
import { loadGlbAssets } from '../render/assets';
import { snapBuildings } from '../protocol/snapshot';
import { createWorld } from '../sim/world';
import { batteryFramePacer } from '../render/framePacer';
import { BuildingTypeId } from '../sim/defs/buildings';
import { PlayerKind } from '../sim/player';

/**
 * The pre-boot background, shared by every menu screen: the actual game,
 * framed on the castle and blurred behind the glass. It is started once by
 * the menu shell (MenuApp.tsx) and outlives the screens in front of it, so
 * walking from the start screen into the War Council never restarts it.
 *
 * A captured still would have been cheaper, but it goes stale the moment the
 * art changes and it cannot be framed per-viewport. This renders a real
 * world instead — terrain, water, scatter and buildings, no units, no sim
 * worker and no HUD. The scene never ticks; only the camera moves, drifting
 * a slow arc around the keep.
 *
 * It renders onto its own canvas (#menu-canvas, created by the shell), not
 * the game's: the match that follows needs a WebGL context of its own, and
 * a canvas only ever hands out one. stop() drops this one so it can.
 *
 * The blur, desaturation and darkening are CSS on that canvas (see the
 * #menu-canvas rules in index.html), so the cost here is one static scene
 * and a camera. If anything throws — no WebGL, assets refused — the caller
 * keeps the plain gradient background and the menu is unaffected.
 *
 * Nothing imports this module directly: menuBackdrop.ts fetches it when a
 * screen first asks for a backdrop, so the three.js and render code below
 * stays off the path to the menu's own first paint.
 */

/** A seed whose start plateau frames well. Nothing depends on it. */
const BACKDROP_SEED = 41207;

/**
 * The backdrop uses its own perspective camera rather than the game's
 * orthographic rig. The game looks down a fixed isometric line because
 * that is what makes a strategy map readable; a menu wants the opposite —
 * standing in the grass looking up at the keep. An ortho projection at a
 * low tilt has no convergence and just reads as a flat side elevation, so
 * depth here has to come from a real lens.
 */
const FOV = 46;
/**
 * Eye height and stand-off, in tiles. Together these set the tilt: about
 * 10 degrees below level, against the game's fixed 35. Low enough to look
 * across the valley at the keep rather than down onto it, high enough that
 * the near grass does not become a wall.
 */
const EYE_HEIGHT = 6;
const ORBIT_RADIUS = 19;
/** Aim below the eye so the shot tilts down slightly, not up at the sky. */
const LOOK_HEIGHT = 2.8;
/**
 * Yaw applied after aiming, sliding the keep left of centre so the menu card
 * does not sit on top of it — but only as far as the viewport allows. The
 * card is a fixed 486px, so a wide window has room beside it and a portrait
 * one has none; a fixed offset that frames nicely on a desktop pushes the
 * keep clean off the side of a phone.
 */
const OFF_CENTRE = -0.42;
/** Aspect at which no shift is applied, and where it reaches full. */
const SHIFT_FROM = 1.0;
const SHIFT_TO = 1.8;
/**
 * The haze band, in tiles from the eye: where the valley starts to go and
 * where it is gone.
 *
 * The match has a band of its own (GameRenderer.setWorldExtent) and it is
 * cut for the other camera — an orthographic rig parked ninety tiles back
 * over ground it frames from above, where the far edge of the frame is
 * barely further from the lens than the near one. Standing in the grass is
 * the opposite case: the keep is twenty tiles off and the valley behind it
 * runs until the map stops. Lit evenly, that far ground reads as a painted
 * flat pinned up behind the castle — every ridge as crisp as the grass at
 * the eye, and the grid's own rim somewhere in it — and no amount of blur
 * on the canvas gives it depth, because blur is not what distance does.
 *
 * So the distance is taken away instead: near is set past the keep so the
 * subject keeps its contrast, and far lands short of the map's edge so the
 * horizon is dark long before there is an edge to see.
 */
const FOG_NEAR = 26;
const FOG_FAR = 100;

/** Where the walk starts — chosen so the sun rakes across the keep. */
const START_ANGLE = 2.2;
const DRIFT_PERIOD = 96_000;

export interface Backdrop {
  stop(): void;
}

/**
 * The one live backdrop, tracked here rather than in the shell that started
 * it, because leaving the menu is not always the shell's own doing: single
 * player begins with a navigation (StartMenu.tsx), and a page that walks
 * away still holding a WebGL context can be parked in the back/forward
 * cache — context and all. Phones hand contexts out sparingly, and the
 * match booting on the far side of that navigation needs one of its own.
 * releaseMenuBackdrop() gives this one back before the page leaves.
 */
let live: Backdrop | null = null;
/**
 * Bumped by every start and every release. A backdrop whose assets land
 * after it was released disposes of itself rather than taking a context
 * nobody will ever look at.
 */
let generation = 0;

/** Already gone by the time it was ready; nothing to stop. */
const DEAD: Backdrop = { stop() {} };

/**
 * Give the backdrop's WebGL context back, now. Safe to call at any time,
 * including with a start still in flight and with no backdrop at all.
 */
export function releaseMenuBackdrop(): void {
  generation++;
  live?.stop();
  live = null;
}

export async function startMenuBackdrop(canvas: HTMLCanvasElement): Promise<Backdrop> {
  const mine = ++generation;
  // Buildings only — the castle is the subject, and skipping the character
  // atlas keeps the menu's first paint quick.
  await loadGlbAssets();
  // Released while the models were loading: take no context at all. Every
  // line below this one is synchronous, so this is the only window.
  if (mine !== generation) return DEAD;

  const world = createWorld({
    seed: BACKDROP_SEED,
    players: [{ kind: PlayerKind.human }],
    adminEnabled: false,
    banditsEnabled: false,
  });

  // Not interactive: the rig must not bind keys or the wheel, or typing a
  // room code in the menu above would pan the scene behind it.
  const renderer = new GameRenderer(canvas, false);
  renderer.setWorldExtent(world.map.play, world.map.size);
  // ...and then take its fog band back: setWorldExtent cut one for the
  // match's camera, not for this one. The scene's own background is the
  // color to fade into — it is what lies behind the last ridge, so a
  // horizon that reaches it has nowhere left to show a seam.
  renderer.scene.fog = new THREE.Fog(background, FOG_NEAR, FOG_FAR);
  const heights = new HeightField(world.map.height, world.map.size);
  const terrain = new TerrainMesh(world.map, heights);
  const scatter = new ScatterMesh(world.map, heights);
  const grass = new GrassField(world.map, heights);
  const water = new WaterMesh(world.map);
  const marginMesh = new MarginMesh(world.map, heights);
  const mist = new Mist(world.map);
  renderer.scene.add(
    terrain.mesh,
    scatter.group,
    grass.mesh,
    water.mesh,
    marginMesh.mesh,
    mist.group,
  );

  const buildings = new BuildingSync(renderer.scene, heights);
  buildings.cameraQuaternion = renderer.rig.camera.quaternion;
  buildings.update(snapBuildings(world));

  // Frame the player's keep — the castle at the map's heart.
  const keep = [...world.buildings.values()].find((b) => b.type === BuildingTypeId.storehouse);
  const half = world.map.size / 2;
  const cx = keep ? keep.x + keep.w / 2 : half;
  const cz = keep ? keep.y + keep.h / 2 : half;
  const groundY = heights.at(cx, cz);

  const camera = new THREE.PerspectiveCamera(FOV, 1, 0.4, 400);
  let stopped = false;
  let yawOffset = 0;
  let angle = START_ANGLE;
  let lift = 0;
  const aim = (a: number, l: number): void => {
    angle = a;
    lift = l;
    camera.position.set(
      cx + Math.sin(angle) * ORBIT_RADIUS,
      groundY + EYE_HEIGHT + lift,
      cz + Math.cos(angle) * ORBIT_RADIUS,
    );
    camera.lookAt(cx, groundY + LOOK_HEIGHT, cz);
    camera.rotateY(yawOffset);
  };
  const fit = (): void => {
    if (stopped) return;
    const aspect = canvas.clientWidth / Math.max(canvas.clientHeight, 1);
    camera.aspect = aspect;
    camera.updateProjectionMatrix();
    const room = Math.min(Math.max((aspect - SHIFT_FROM) / (SHIFT_TO - SHIFT_FROM), 0), 1);
    yawOffset = OFF_CENTRE * room;
    aim(angle, lift); // re-apply: the offset just changed
  };
  fit();
  const observer = new ResizeObserver(fit);
  observer.observe(canvas);

  const still = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
  aim(START_ANGLE, 0);
  let raf = 0;
  // Same 30 fps phone cap as the match loop — a menu left open on a phone
  // otherwise drains the battery on a blurred backdrop, and the drift is
  // far too slow for the skipped frames to read as judder through the glass.
  const pacer = batteryFramePacer();
  const loop = (): void => {
    if (stopped) return;
    const now = performance.now();
    // The same gate the match loop uses, for the same reason: the menu is
    // where the player is clicking buttons, and a backdrop that fills the
    // frame pipeline makes those buttons answer six frames late. See
    // GameRenderer.gpuReady.
    if (!renderer.gpuReady() || !pacer.due(now)) {
      raf = requestAnimationFrame(loop);
      return;
    }
    if (!still) {
      // A very slow walk around the keep, with a gentle rise and fall on the
      // eye. Two terms rather than one so the path never quite repeats — a
      // clean circle reads as a turntable, which is the single thing that
      // makes a live scene look canned.
      const t = (now / DRIFT_PERIOD) * Math.PI * 2;
      aim(START_ANGLE + t + Math.sin(t * 0.41) * 0.12, Math.sin(t * 0.63) * 0.5);
    }
    water.update(now);
    mist.update(now);
    renderer.frame(camera);
    raf = requestAnimationFrame(loop);
  };
  raf = requestAnimationFrame(loop);

  const backdrop: Backdrop = {
    stop(): void {
      if (stopped) return;
      stopped = true;
      if (live === backdrop) live = null;
      cancelAnimationFrame(raf);
      observer.disconnect();
      // The context goes with it: the match about to boot needs one of its
      // own, and browsers hand them out sparingly.
      renderer.dispose();
    },
  };
  live = backdrop;
  return backdrop;
}
