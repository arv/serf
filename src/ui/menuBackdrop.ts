import * as THREE from 'three';
import { GameRenderer } from '../render/renderer';
import { TerrainMesh } from '../render/terrainMesh';
import { ScatterMesh } from '../render/scatterMesh';
import { HeightField } from '../render/heightField';
import { GrassField } from '../render/grassField';
import { WaterMesh } from '../render/waterMesh';
import { Mist } from '../render/mist';
import { BuildingSync } from '../render/buildingSync';
import { loadMedievalAssets } from '../render/medieval';
import { snapBuildings } from '../protocol/snapshot';
import { createWorld } from '../sim/world';

/**
 * The start screen's background: the actual game, framed on the castle and
 * blurred behind the menu.
 *
 * A captured still would have been cheaper, but it goes stale the moment the
 * art changes and it cannot be framed per-viewport. This renders a real
 * world instead — terrain, water, scatter and buildings, no units, no sim
 * worker and no HUD. The scene never ticks; only the camera moves, drifting
 * a slow arc around the keep.
 *
 * The blur, desaturation and darkening are CSS on the canvas (see the #menu
 * rules in index.html), so the cost here is one static scene and a camera.
 * If anything throws — no WebGL, assets refused — the caller keeps the plain
 * gradient background and the menu is unaffected.
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
/** Where the walk starts — chosen so the sun rakes across the keep. */
const START_ANGLE = 2.2;
const DRIFT_PERIOD = 96_000;

export interface Backdrop {
  stop(): void;
}

export async function startMenuBackdrop(canvas: HTMLCanvasElement): Promise<Backdrop> {
  // Buildings only — the castle is the subject, and skipping the character
  // atlas keeps the menu's first paint quick.
  await loadMedievalAssets();

  const world = createWorld({
    seed: BACKDROP_SEED,
    players: [{ kind: 'human' }],
    adminEnabled: false,
    banditsEnabled: false,
  });

  // Not interactive: the rig must not bind keys or the wheel, or typing a
  // room code in the menu above would pan the scene behind it.
  const renderer = new GameRenderer(canvas, false);
  const heights = new HeightField(world.map.height);
  const terrain = new TerrainMesh(world.map, heights);
  const scatter = new ScatterMesh(world.map, heights);
  const grass = new GrassField(world.map, heights);
  const water = new WaterMesh(world.map);
  const mist = new Mist(world.map);
  renderer.scene.add(terrain.mesh, scatter.group, grass.mesh, water.mesh, mist.group);

  const buildings = new BuildingSync(renderer.scene, heights);
  buildings.cameraQuaternion = renderer.rig.camera.quaternion;
  buildings.update(snapBuildings(world));

  // Frame the player's keep — the storehouse is the castle in this theme.
  const keep = [...world.buildings.values()].find((b) => b.type === 'storehouse');
  const half = world.map.terrain.length ** 0.5 / 2;
  const cx = keep ? keep.x + keep.w / 2 : half;
  const cz = keep ? keep.y + keep.h / 2 : half;
  const groundY = heights.at(cx, cz);

  const camera = new THREE.PerspectiveCamera(FOV, 1, 0.4, 400);
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
    const aspect = canvas.clientWidth / Math.max(canvas.clientHeight, 1);
    camera.aspect = aspect;
    camera.updateProjectionMatrix();
    const room = Math.min(Math.max((aspect - SHIFT_FROM) / (SHIFT_TO - SHIFT_FROM), 0), 1);
    yawOffset = OFF_CENTRE * room;
    aim(angle, lift); // re-apply: the offset just changed
  };
  fit();
  new ResizeObserver(fit).observe(canvas);

  const still = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
  aim(START_ANGLE, 0);
  let raf = 0;
  let stopped = false;
  const loop = (): void => {
    if (stopped) return;
    const now = performance.now();
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

  return {
    stop(): void {
      stopped = true;
      cancelAnimationFrame(raf);
    },
  };
}
