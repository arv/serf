/**
 * Roll a world at a seed and write it down as a serf-map JSON file — the
 * format the campaign builds its worlds from (src/sim/defs/maps/) and the
 * map editor round-trips. This is how a mission map is (re)born: generate
 * from a seed you like, then tweak the file by hand or in the editor.
 *
 * Also reports the bandit camp origin createWorld's classic seed-driven
 * search would have picked on this world — paste it into the mission's
 * `campSpot` so the camp stands where the balance was proven.
 *
 * Usage:
 *   node tools/exportMissionMap.ts <seed> <seats> <name> <out.json> [play]
 * e.g.
 *   node tools/exportMissionMap.ts 17 1 "Hold the Valley" src/sim/defs/maps/holdTheValley.json
 *
 * Plain node (>= 23, native type stripping); not covered by any tsconfig,
 * like the other node-side scripts (see tools/modelLab/tsconfig.json).
 */
import { writeFileSync } from 'node:fs';
import { Rng } from '../src/shared/rng.ts';
import { DEFAULT_MAP_SIZE, marginFor, tileIdx } from '../src/shared/grid.ts';
import { clearResources, generateMap, rectClear, type StartSpot } from '../src/sim/map.ts';
import { serializeMapFile } from '../src/sim/mapFile.ts';
import { campCorners, resolveMapSize, startLayout } from '../src/sim/world.ts';

const [seedArg, seatsArg, name, out, playArg] = process.argv.slice(2);
if (!seedArg || !seatsArg || !name || !out) {
  console.error('usage: node tools/exportMissionMap.ts <seed> <seats> <name> <out.json> [play]');
  process.exit(1);
}
const seed = Number(seedArg) | 0;
const seats = Number(seatsArg) | 0;
const play = resolveMapSize(playArg ? Number(playArg) : DEFAULT_MAP_SIZE);

const layout = startLayout(play, marginFor(play), seats);
if (!layout) {
  console.error(`no start layout for ${seats} seats`);
  process.exit(1);
}
const starts: StartSpot[] = layout.map(([x, y]) => ({ x, y }));

const rng = new Rng(seed);
const map = generateMap(rng, starts, play);

// The pristine ground, before any building stamps a footprint on it —
// createWorld does its own clearing and placing when it builds the world.
const json = serializeMapFile({ map, players: seats, starts, name });

// Replay createWorld's classic camp search on a working copy of the world:
// storehouses stamped first (they were, when the classic seeds rolled), the
// same rng stream picking the solo corner, the same spiral finding ground.
for (const s of starts) {
  clearResources(map, s.x - 1, s.y - 1, 5, 5);
  for (let dy = 0; dy < 3; dy++) {
    for (let dx = 0; dx < 3; dx++) {
      map.buildingAt[tileIdx(s.x + dx, s.y + dy, map.size)] = 1;
    }
  }
}
const corners = campCorners(play);
let campSeeds: [number, number][];
if (starts.length === 1) {
  const first = rng.int(corners.length);
  campSeeds = corners.map((_, ci) => corners[(first + ci) % corners.length]!);
} else {
  const nearestStart = ([cx, cy]: [number, number]): number => {
    let best = Infinity;
    for (const st of starts) {
      const d = Math.max(Math.abs(cx + 1 - (st.x + 1)), Math.abs(cy + 1 - (st.y + 1)));
      if (d < best) best = d;
    }
    return best;
  };
  const middle: [number, number] = [map.size / 2 - 1, map.size / 2 - 1];
  campSeeds = [middle, ...corners.sort((a, z) => nearestStart(z) - nearestStart(a))];
}
let campSpot: { x: number; y: number } | undefined;
outer: for (const [cx, cy] of campSeeds) {
  for (let r = 0; r < 16; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        if (rectClear(map, cx + dx, cy + dy, 3, 3)) {
          campSpot = { x: cx + dx, y: cy + dy };
          break outer;
        }
      }
    }
  }
}

writeFileSync(out, json);
console.log(`${out}: seed ${seed}, ${seats} seat(s), play ${play} (${json.length} bytes)`);
console.log(
  campSpot
    ? `campSpot: { x: ${campSpot.x}, y: ${campSpot.y} }`
    : 'campSpot: none found (all seeds blocked)',
);
