# Campaign mission maps

One serf-map JSON file per campaign mission — the authored ground a
mission's world is built from. `../missions.ts` holds each mission's
recipe (and pins its `campSpot`); `../missionMaps.ts` loads the file on
demand as a code-split chunk, and `createWorldAsync` awaits it before the
synchronous `createWorld` builds the world. The format is
`src/sim/mapFile.ts`; it is exactly the map editor's file format, so these
files round-trip through the editor.

## Where these maps come from

They are **composed, not rolled**. Each one is a recipe in
`tools/mapAuthor/missions/<id>.ts` — a valley floor, the hills and rivers
cut into it, and then the timber, stone and seams laid where the mission
wants the player to look. Rebuild them with:

```
node --experimental-strip-types tools/authorMissionMaps.ts [id...]
```

which writes the JSON and prints an audit of each map against the
promises worldgen makes to every start (stone in the opening view, water
within a fishery's walk, ore a serf can walk to, ground for the camp and
for every hut the mission def pre-places) plus the one number that
decides whether a taught line works at all: **what the first legal hut
site out of the keep can actually work**. Anything it calls a problem
fails the run.

The maps used to be worldgen rolls at pinned seeds, frozen to files. That
made them ground nothing could be said about: mission 1 opened with gold
ten tiles from the keep and its timber wherever the noise had put it.
The per-mission `seed` in `missions.ts` still matters — it deals AI
playbooks and starts the world's rng — but it no longer decides a single
tile.

`tools/mapPreview.ts` prints a map file as ASCII, which is how a recipe
is read back:

```
node --experimental-strip-types tools/mapPreview.ts src/sim/defs/maps/levy.json --camp 43,43
```

## Tweaking a map

- **In the recipe** (preferred): edit
  `tools/mapAuthor/missions/<id>.ts` and rebuild. The recipe is the
  intent; the JSON is its output, and a tweak made only to the JSON is a
  tweak the next rebuild throws away.
- **In the editor**: open the map editor, Import the file, paint, Export,
  and replace the file — for a one-off touch-up the kit has no vocabulary
  for. Say so in the recipe if you do, or it will be lost.
- **By script**: the tile grids are base64 (one byte per tile for
  `terrain`, `resource` and `resourceAmt`; a little-endian int16 of
  millimetres for `height`), so there is no tile in the file to find by
  eye — `parseMapJson` the file, poke `map.terrain[y * size + x]`
  (terrain 0 grass / 1 water / 2 rock; resource 0 none / 1 wood / 2 rock
  / 3 iron / 4 silver / 5 gold, with a matching `resourceAmt`), and
  `serializeMapFile` it back.

After a tweak:

1. `pnpm vitest run src/sim/missionMaps.test.ts` — the standing contract
   for authored ground (the audit's questions, asked of the tiles that
   shipped) in a second or two.
2. `pnpm vitest run src/sim/missions.test.ts` — the fast "every mission
   map file parses and fits its def" guard, and then the playthroughs
   that re-prove each mission is still winnable.
3. `src/shared/replayVersion.test.ts` will fail on purpose: a mission map
   is replay surface. Bump `REPLAY_VERSION` and pin the new hash.

## Rolling a map from worldgen instead

```
node --experimental-strip-types tools/exportMissionMap.ts <seed> <seats> <name> <out.json>
```

writes the world a seed generates and prints the `campSpot` the classic
corner search would pick. That is where these maps came from originally,
and it is still the way to start from a generated valley — but a mission
map that ships should end up as a recipe, so that what it is trying to
say is written down somewhere other than the tiles.
