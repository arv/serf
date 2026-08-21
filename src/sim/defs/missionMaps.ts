import type { MissionId } from './missions.ts';
import type { MapFile } from '../mapFile.ts';

/**
 * The campaign's authored ground, loaded on demand. Dynamic imports on
 * purpose: the six map files are ~250 KB of JSON each, and a static
 * import anywhere in the sim would sink them all into the boot bundle of
 * every surface that links the sim — the menu included. This table is the
 * only doorway; each file ships as its own code-split chunk and arrives
 * only when its mission actually boots (the module registry memoizes, so
 * a re-boot pays nothing).
 *
 * A table of six thunks rather than one `import(\`./maps/${id}\`)`: the
 * bundler statically sees exactly which files are reachable, and a
 * MissionId that somehow escaped parseMissionId fails here at compile
 * time, not as a 404 at boot. The thunks import the maps/<id>.ts wrappers
 * rather than the JSON directly — the wrapper's static edge carries the
 * `with { type: 'json' }` attribute node insists on, in the one position
 * (static) where Vite's dev server strips it before the browser's strict
 * JSON-module MIME check can object.
 */
const MISSION_MAPS: Record<MissionId, () => Promise<{ default: MapFile }>> = {
  clearing: () => import('./maps/clearing.ts'),
  breadAndWater: () => import('./maps/breadAndWater.ts'),
  ledger: () => import('./maps/ledger.ts'),
  levy: () => import('./maps/levy.ts'),
  holdTheValley: () => import('./maps/holdTheValley.ts'),
  rivalBanner: () => import('./maps/rivalBanner.ts'),
};

/** Fetch one mission's authored map (the raw file; parseMapData is the
 * gate that makes it a GameMap — createWorld runs it). */
export async function loadMissionMap(id: MissionId): Promise<MapFile> {
  return (await MISSION_MAPS[id]()).default;
}
