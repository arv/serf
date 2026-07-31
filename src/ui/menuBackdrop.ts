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
/** Tight enough that the keep reads as a building, not a dot. */
const VIEW_HEIGHT = 17;
/** Radius and period of the camera's drift around the keep, in tiles / ms. */
const DRIFT_RADIUS = 3.2;
const DRIFT_PERIOD = 46_000;
/**
 * Push the keep off-centre so the menu card does not sit on top of it. The
 * camera is a fixed 45-degree iso rig, so "left on screen" is this direction
 * on the ground; focusing that far along it slides the subject the other way.
 */
const SCREEN_SHIFT = 7.5;
const SHIFT_X = Math.cos(Math.PI / 4) * SCREEN_SHIFT;
const SHIFT_Z = -Math.sin(Math.PI / 4) * SCREEN_SHIFT;

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
  const cx = (keep ? keep.x + keep.w / 2 : half) + SHIFT_X;
  const cz = (keep ? keep.y + keep.h / 2 : half) + SHIFT_Z;
  renderer.rig.focusOn(cx, cz, VIEW_HEIGHT);

  const still = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
  let raf = 0;
  let stopped = false;
  const loop = (): void => {
    if (stopped) return;
    const now = performance.now();
    if (!still) {
      // A slow arc around the keep, with a second slower term on each axis so
      // the path never quite repeats — a clean ellipse reads as a turntable,
      // which is the one thing that makes a live scene look canned. Plus a
      // gentle breath on the zoom.
      const t = (now / DRIFT_PERIOD) * Math.PI * 2;
      const x = cx + Math.sin(t) * DRIFT_RADIUS + Math.sin(t * 0.37) * DRIFT_RADIUS * 0.35;
      const z = cz + Math.cos(t) * DRIFT_RADIUS * 0.5 + Math.cos(t * 0.53) * DRIFT_RADIUS * 0.3;
      renderer.rig.focusOn(x, z, VIEW_HEIGHT * (1 + Math.sin(t * 0.21) * 0.05));
    }
    water.update(now);
    mist.update(now);
    renderer.frame();
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
