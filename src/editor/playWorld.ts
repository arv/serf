import {Rng} from '../shared/rng.ts';
import {dealStrategies, type AiStrategyId} from '../sim/defs/aiStrategies.ts';
import {
  START_SERFS,
  START_STOCK,
  firstRaidTickFor,
} from '../sim/defs/balance.ts';
import * as BuildingTypeId from '../sim/defs/buildingTypeIdEnum.ts';
import * as UnitTypeId from '../sim/defs/unitTypeIdEnum.ts';
import {BANDIT} from '../sim/entities.ts';
import {
  clearResources,
  rectClear,
  recomputeBlocked,
  type GameMap,
} from '../sim/map.ts';
import * as MatchState from '../sim/matchStateEnum.ts';
import {makePlayer, type PlayerKind} from '../sim/player.ts';
import {
  campCorners,
  placeBuiltBuilding,
  spawnUnitNearby,
  type World,
} from '../sim/world.ts';
import type {EditorMapState} from './editorMap.ts';

export interface EditorPlayConfig {
  /** Deals the AI seats their playbooks (and the solo camp its corner). */
  seed: number;
  /** One entry per seat; length must equal the map's player count. */
  players: {kind: PlayerKind; strategy?: AiStrategyId}[];
  banditsEnabled: boolean;
}

/**
 * A ready-to-tick World from an authored map — createWorld's tail
 * (world.ts) without generateMap or startLayout: the editor already owns
 * the ground and the starts. Deliberately OUTSIDE src/sim: worldgen's
 * determinism contract stays untouched, and this runs on the main thread
 * only — the result reaches the sim worker as an ordinary serialized
 * world through the same handoff the Load button uses.
 *
 * The map is deep-copied first, so playtesting never mutates the editing
 * session it came from.
 */
export function worldFromEditor(
  state: EditorMapState,
  cfg: EditorPlayConfig,
): World {
  if (cfg.players.length !== state.starts.length) {
    throw new Error(
      `map has ${state.starts.length} start(s) but ${cfg.players.length} seat(s) were dealt`,
    );
  }
  const src = state.map;
  const map: GameMap = {
    size: src.size,
    play: src.play,
    terrain: Uint8Array.from(src.terrain),
    resource: Uint8Array.from(src.resource),
    resourceAmt: Uint8Array.from(src.resourceAmt),
    blocked: Uint8Array.from(src.blocked),
    buildingAt: new Int16Array(src.buildingAt.length).fill(-1),
    wear: new Float32Array(src.wear.length),
    pathLevel: new Uint8Array(src.pathLevel.length),
    height: Float32Array.from(src.height),
  };
  const size = map.size;
  const starts = state.starts.map(s => ({...s}));
  const seed = cfg.seed | 0;
  const deal = dealStrategies(seed, cfg.players);
  const rng = new Rng(seed);

  const world: World = {
    tick: 0,
    rngState: rng.state,
    nextId: 1,
    map,
    units: new Map(),
    buildings: new Map(),
    jobs: new Map(),
    nextJobId: 1,
    ledger: {produced: {}, consumed: {}},
    pendingDeltas: [],
    players: cfg.players.map((p, i) => makePlayer(i, p.kind, deal[i])),
    // Authored ground: the editor placed these seat by seat, so they are
    // taken as written rather than dealt (createWorld rolls only the
    // generated table). Copied — `starts` is the playtest's own.
    starts: starts.map(s => ({...s})),
    // The raid clock scales with the PLAYABLE span, exactly as createWorld's
    // does (the margin adds no marching distance for anyone).
    raidState: {nextRaidTick: firstRaidTickFor(map.play), wave: 0},
    admin: {
      enabled: true,
      raidsEnabled: cfg.banditsEnabled,
      instantBuild: false,
    },
    pendingEvents: [],
    outcome: {state: MatchState.playing},
    banditsEnabled: cfg.banditsEnabled,
  };

  // Each faction's storehouse on its authored start; clear anything under it.
  for (let p = 0; p < starts.length; p++) {
    const {x: shX, y: shY} = starts[p]!;
    clearResources(map, shX - 1, shY - 1, 5, 5);
    const storehouse = placeBuiltBuilding(
      world,
      BuildingTypeId.storehouse,
      p,
      shX,
      shY,
    );
    storehouse.stock = {...START_STOCK};
  }

  // Bandit camp, the same seed order the generated worlds use: middle
  // first with rivals on the map, a seed-dealt corner solo, corners as
  // fallbacks farthest-from-any-doorstep first. Corners are play-relative;
  // the editor's grids always carry the canonical margin.
  const corners = campCorners(map.play, (map.size - map.play) / 2);
  let campSeeds: [number, number][];
  if (starts.length === 1) {
    const first = rng.int(corners.length);
    campSeeds = corners.map((_, ci) => corners[(first + ci) % corners.length]!);
  } else {
    const nearestStart = ([cx, cy]: [number, number]): number => {
      let best = Infinity;
      for (const st of starts) {
        const d = Math.max(Math.abs(cx - st.x), Math.abs(cy - st.y));
        if (d < best) best = d;
      }
      return best;
    };
    const middle: [number, number] = [size / 2 - 1, size / 2 - 1];
    campSeeds = [
      middle,
      ...corners.sort((a, z) => nearestStart(z) - nearestStart(a)),
    ];
  }
  if (!cfg.banditsEnabled) campSeeds = [];
  let campPlaced = false;
  outer: for (const [cx, cy] of campSeeds) {
    for (let r = 0; r < 16; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          if (rectClear(map, cx + dx, cy + dy, 3, 3)) {
            const camp = placeBuiltBuilding(
              world,
              BuildingTypeId.banditCamp,
              BANDIT,
              cx + dx,
              cy + dy,
            );
            for (let g = 0; g < 3; g++) {
              spawnUnitNearby(
                world,
                UnitTypeId.bandit,
                BANDIT,
                camp.x - 0.5 + g * 2,
                camp.y + camp.h + 1.5,
              );
            }
            campPlaced = true;
            break outer;
          }
        }
      }
    }
  }
  // A campless world with bandits on is an instant win: the solo victory
  // check reads "no camp stands" as "the camp fell" on the very first
  // tick. Worldgen guarantees itself a spot; an authored map owes no such
  // promise, so refuse the launch rather than hand out a hollow victory.
  if (cfg.banditsEnabled && !campPlaced) {
    throw new Error(
      'no room for the bandit camp: clear a 3×3 near the middle or a corner of the playable area, or turn bandits off',
    );
  }

  // Starting serfs, scattered just south of each storehouse. Nearby, not
  // exact: worldgen's layouts guarantee open meadow south of every castle,
  // but an authored start may hug the play boundary or a painted lake, and
  // a serf must never open the game standing in scenery.
  for (let p = 0; p < starts.length; p++) {
    const {x: shX, y: shY} = starts[p]!;
    for (let i = 0; i < START_SERFS; i++) {
      const x = shX - 1 + (i % 5) + 0.5;
      const y = shY + 4 + Math.floor(i / 5) + 0.5;
      spawnUnitNearby(world, UnitTypeId.serf, p, x, y);
    }
  }

  recomputeBlocked(map);
  world.rngState = rng.state;
  return world;
}
