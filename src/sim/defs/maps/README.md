# Campaign mission maps

One serf-map JSON file per campaign mission — the authored ground a
mission's world is built from. `../missions.ts` holds each mission's
recipe (and pins its `campSpot`); `../missionMaps.ts` loads the file on
demand as a code-split chunk, and `createWorldAsync` awaits it before the
synchronous `createWorld` builds the world. The format is
`src/sim/mapFile.ts`; it is exactly the map editor's file format, so these
files round-trip through the editor.

## Tweaking a map

- **In the editor**: open the map editor, Import the file, paint, Export,
  and replace the file. Reload the game — `?mission=<id>` boots straight
  into it.
- **By script**: the tile grids are base64 (one byte per tile for
  `terrain`, `resource` and `resourceAmt`; a little-endian int16 of
  millimetres for `height`), so there is no tile in the file to find by
  eye — a tweak that is easier written than painted goes through the
  format instead: `parseMapJson` the file, poke
  `map.terrain[y * size + x]` (terrain 0 grass / 1 water / 2 rock;
  resource 0 none / 1 wood / 2 rock / 3 iron / 4 silver / 5 gold, with a
  matching `resourceAmt`), and `serializeMapFile` it back.

After a tweak:

1. `pnpm vitest run src/sim/missions.test.ts` — the fast guard ("every
   mission map file parses and fits its def") catches a broken file or a
   blocked `campSpot` in milliseconds; the playthrough tests then re-prove
   the mission is still winnable.
2. `src/shared/replayVersion.test.ts` will fail on purpose: a mission map
   is replay surface. Bump `REPLAY_VERSION` and pin the new hash.

## Rolling a fresh map from worldgen

```
node tools/exportMissionMap.ts <seed> <seats> <name> <out.json> [play]
```

It writes the world that seed generates and prints the `campSpot` the
classic camp search would pick — paste that into the mission's def. These
seven were born from the missions' original pinned seeds:

```
node tools/exportMissionMap.ts 106 1 "The Clearing"      src/sim/defs/maps/clearing.json
node tools/exportMissionMap.ts 202 1 "Bread and Water"   src/sim/defs/maps/breadAndWater.json
node tools/exportMissionMap.ts 303 1 "The Abbey's Ledger" src/sim/defs/maps/ledger.json
node tools/exportMissionMap.ts 350 1 "Hammer and Haft"    src/sim/defs/maps/hammerAndHaft.json
node tools/exportMissionMap.ts 405 1 "The Levy"          src/sim/defs/maps/levy.json
node tools/exportMissionMap.ts 17  1 "Hold the Valley"   src/sim/defs/maps/holdTheValley.json
node tools/exportMissionMap.ts 11  2 "The Rival Banner"  src/sim/defs/maps/rivalBanner.json
```

Re-running one of those today does **not** reproduce the file beside it.
The scenery margin has come in twice — from half the playable side, to
0.42 of one, and now to an affine depth that works out at 28 tiles on a
96-tile valley — and worldgen lays out a different grid at every seed each
time. Rather than reroll seven proven maps, the files were cropped onto
each new grid: the same playable ground, its tiles re-indexed by the 20 the
margin has lost in total, and each mission's pinned `campSpot` moved with
them. The commands above are how a map is born, not how these seven are
rebuilt.
