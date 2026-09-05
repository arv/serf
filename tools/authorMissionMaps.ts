/**
 * Build the campaign's authored ground from its recipes.
 *
 *   node --experimental-strip-types tools/authorMissionMaps.ts [id...] [--dry]
 *
 * With no ids it rebuilds all seven. Each recipe (tools/mapAuthor/missions/)
 * composes its valley out of the authoring kit's landforms and hands back
 * the landmarks the audit holds it to — a town site that can be built on,
 * stone in the opening view, water within a fishery's walk, ore a serf can
 * reach, ground for the bandit camp and for every prebuilt hut the mission
 * def places. Problems are printed and the run exits non-zero; the files
 * are still written unless `--dry`, because reading a broken map in the
 * preview is how it gets fixed.
 *
 * This is not a step in the build: the map files are checked in, and a
 * rebuild is something a person decides to do. After one, run
 * `pnpm vitest run src/sim/missions.test.ts` (the fast guard first, then
 * the playthroughs) and bump REPLAY_VERSION — mission ground is replay
 * surface.
 *
 * Plain node (>= 22 with --experimental-strip-types, >= 23 native), like
 * the other node-side scripts here.
 */
import {writeFileSync} from 'node:fs';
import type {Enum} from '../src/shared/enum.ts';
import * as MissionId from '../src/sim/defs/missionIdEnum.ts';
import {
  MISSION_ORDER,
  MISSION_DEFS,
  parseMissionId,
  MISSION_KEYS,
} from '../src/sim/defs/missions.ts';
import {audit, type Authored} from './mapAuthor/kit.ts';

type MissionId = Enum<typeof MissionId>;
import {build as breadAndWater} from './mapAuthor/missions/breadAndWater.ts';
import {build as clearing} from './mapAuthor/missions/clearing.ts';
import {build as gildedValley} from './mapAuthor/missions/gildedValley.ts';
import {build as hammerAndHaft} from './mapAuthor/missions/hammerAndHaft.ts';
import {build as holdTheValley} from './mapAuthor/missions/holdTheValley.ts';
import {build as ledger} from './mapAuthor/missions/ledger.ts';
import {build as levy} from './mapAuthor/missions/levy.ts';
import {build as rivalBanner} from './mapAuthor/missions/rivalBanner.ts';

const RECIPES: Record<MissionId, () => Authored> = {
  [MissionId.clearing]: clearing,
  [MissionId.breadAndWater]: breadAndWater,
  [MissionId.ledger]: ledger,
  [MissionId.hammerAndHaft]: hammerAndHaft,
  [MissionId.levy]: levy,
  [MissionId.holdTheValley]: holdTheValley,
  [MissionId.gildedValley]: gildedValley,
  [MissionId.rivalBanner]: rivalBanner,
};

const args = process.argv.slice(2);
const dry = args.includes('--dry');
const ids: MissionId[] = [];
for (const arg of args.filter(a => !a.startsWith('--'))) {
  const id = parseMissionId(arg);
  if (id === undefined) {
    console.error(
      `unknown mission: ${arg} (${MISSION_ORDER.map(m => MISSION_KEYS[m]).join(', ')})`,
    );
    process.exit(1);
  }
  ids.push(id);
}

let failed = false;
for (const id of ids.length > 0 ? ids : MISSION_ORDER) {
  const def = MISSION_DEFS[id];
  const authored = RECIPES[id]();
  // The def is the other half of the contract: the camp it pins and the
  // huts it pre-places have to fit the ground the recipe just laid.
  authored.campSpot ??= def.campSpot;
  authored.prebuilt ??= def.prebuilt;
  const json = authored.valley.serialize(authored.name, authored.starts);
  // Named by the mission's key, which is what the loader's wrappers
  // import (defs/missionMaps.ts). Ids are numbers now, and writing
  // `maps/5.json` beside the checked-in `maps/levy.json` is a rebuild
  // that silently changes nothing.
  const out = `src/sim/defs/maps/${MISSION_KEYS[id]}.json`;
  if (!dry) writeFileSync(out, json);
  const report = audit(authored);
  console.log(
    `\n=== ${id} — ${authored.name} (${json.length} bytes)${dry ? ' [dry]' : ''}`,
  );
  for (const line of authored.intent) console.log(`  · ${line}`);
  for (const line of report.lines) console.log(`  ${line}`);
  for (const problem of report.problems) {
    console.log(`  !! ${problem}`);
    failed = true;
  }
}
if (failed) process.exit(1);
