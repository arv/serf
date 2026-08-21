# Tools in the economy: the Smith and six tools

> **Status: implemented.** Deviations from the plan as written, found during
> the build:
>
> - **The pickaxe costs wood 2 + stone 1, not iron.** An iron pickaxe is a
>   circle — every mine is staffed by one, so losing your picks meant no ore
>   could ever flow again to forge the next. Not theoretical: the winnable
>   test's AI deadlocked exactly there (two iron mines open for 35k ticks,
>   zero iron in the world) before the recipe changed.
> - **No player-facing standing order.** The Smith's card is queue + auto
>   only, exactly the user's model ("queue plus auto when no queue"); a
>   recipe click ORDERS one batch, barracks-style. `recipeIndex` (the
>   standing order) remains in the sim for the AI's weaponMix/counter play
>   and shows on the card as a clearable "between orders" line if set.
> - **forgeTheCounter and keepTheToolsComing split the anvils by a shared
>   predicate (`toolSmith`)**, not by claims — a claim collision suppresses a
>   whole firing, which would have unmanaged every other smith for the beat.
> - **The fishery keys S → E** (`BUILD_KEYS`): "Smith" spent all five of its
>   letters on existing buildings, and the fishery had a free E.
> - **Fixture tool kit** (`FIXTURE_TOOLS` in testUtils.ts): every test
>   storehouse ships tools so the hundreds of pre-tools fixtures stay
>   honest; tool-economy tests zero it explicitly.

## Context

The economy has 13 goods and one terminal crafting building, the Weaponsmith, which turns iron and
wood into one of three weapons. Weapons are the only item that gates anything — the barracks refuses
a recruit until the matching sword/spear/bow sits in its input buffer (`WEAPON_OF` in
`src/sim/defs/units.ts:112`, `firstReadyTraining` in `src/sim/systems/staffing.ts:77`). Everything
else in the village is gated only on people.

The goal is a second, *civilian* gate — the Settlers 3 idea that expanding your economy costs tools,
not just hands. A new woodcutter needs an axe before anyone will work it. That turns the Weaponsmith
into a **Smith** serving the whole village rather than only the army, gives iron a purpose long
before Soldiery, and makes "how fast can I add another building?" a resource question rather than
purely a population one.

Two constraints shaped the design:

- **No soft-locks.** The Smith is the only source of tools, so it can never itself require one, and
  it must be reachable from a standing start.
- **The HUD is already full.** The resource strip renders all 13 goods always, even at zero, and has
  roughly 80px of headroom on a 1440px window (`src/ui/Hud.tsx:445-482`). Six more goods needs ~440px.
  It would wrap on every laptop, and it would regress the hardcoded `58vh` phone-menu height at
  `Hud.tsx:857`, whose comment records that the number was derived from the current chip count to
  keep **Quit** on screen.

### Decisions taken

| Question | Decision |
|---|---|
| What tools do | Consumed to staff a post. `START_STOCK` ships a starter kit so the opening plays as today and the squeeze arrives on expansion. |
| The hammer | Not a staffing gate. A construction site **borrows** one and returns it on completion, so hammers cap concurrent building and can never soft-lock. |
| Which posts | 9 of the 10 resident-worker posts are gated. The Smith is the exception. |
| Smith control | A **queue** (barracks-style) that pre-empts a **standing order**, which is `auto` by default. |
| Smith timing | Building loses its tech gate entirely; every recipe carries its own. |
| Recipe inputs | Iron + wood. No coal, no smelter, no new tile resource. The fishing rod is wood-only. |
| Tool recovery | Returned on dismiss and on sell; lost when the worker dies or the building is destroyed. |
| HUD | Strip curated to a handful of goods; full stock moves into a new Economy panel. |

## Design

### The unifying idea: a tool is a hauled good that lives in the building's input buffer

This is what makes the feature cheap. There is **no equipment slot on `Unit`** and none is added.
A post that wants a tool raises a haul demand exactly the way a converter demands its inputs; a serf
carries the axe to the woodcutter; it sits in `b.inputs`; staffing consumes it when the worker binds.
That gives us for free:

- Save/replay safety — `Building.inputs` already persists and hashes.
- Visibility — you watch an axe walk across the map to the new hut.
- The existing precedent — this is exactly how the barracks consumes a weapon.
- Sell/destroy semantics — a tool still in `inputs` follows whatever `inputs` already does.

### Tool → post map

There are exactly ten posts with a resident worker. New table in `src/sim/defs/buildings.ts`,
mirroring `WEAPON_OF`:

```ts
/** The tool a serf must be handed before he will take up this post.
 * The Smith is deliberately absent and must stay that way: it is the only
 * source of tools, so gating it is the one thing that can hard-lock a game. */
export const TOOL_OF: Partial<Record<BuildingTypeId, GoodId>> = {
  woodcutter: 'axe',
  quarry: 'pickaxe',
  ironMine: 'pickaxe',
  silverMine: 'pickaxe',
  goldMine: 'pickaxe',
  wheatFarm: 'scythe',
  bakery: 'cauldron',
  brewery: 'cauldron',
  fishery: 'rod',
};
```

Mill, well, abbey, house and castle have no worker at all and are unaffected; barracks and guard
tower already gate on soldiers and weapons.

### The hammer: a loan against the site

Every player-placed site (not `isRoad`, not `systemOnly`) demands `hammer: 1` alongside its wood and
stone at construction priority 1. On completion the hammer moves from `b.inputs` into `b.stock` and
is carried home by the existing priority-3 evacuation. Repairs need no hammer.

With `START_STOCK hammer: 3` you can raise three buildings at once; a fourth waits. This is the one
tool that is a *rate* limit rather than a *count* limit, and it is why the mechanic cannot deadlock:
hammers are only ever lost when a site is destroyed mid-build.

`src/protocol/snapshot.ts:292` already plays `WORK.hammer` for a builder, so the animation is correct.

### The Smith

Loses `requiresTech` entirely — with 9 of 10 posts tool-gated, the only tool source must be placeable
from minute one. Gating moves onto the recipes, so a Smith raised at t=0 can forge rods immediately
and sits idle for everything else until ore arrives. Indices 0/1/2 **must not move**: they are
load-bearing in `aiStrategies.ts` (`weaponMix`), `src/ai/insight.ts:31` (`WEAPON_NAMES`),
`COUNTER_PICK` in `src/sim/systems/ai.ts` and `forgeTheCounter` in `src/sim/economyRules.ts`.

```
0 spear     iron 1 + wood 2  (10s)  [ironworking]
1 sword     iron 2 + wood 1  (14s)  [ironworking]
2 bow       wood 3           ( 8s)  [archery]
3 axe       iron 1 + wood 2  ( 8s)  [ironworking]
4 pickaxe   iron 2 + wood 1  (10s)  [ironworking]
5 scythe    iron 1 + wood 2  ( 8s)  [ironworking]
6 hammer    iron 1 + wood 1  ( 6s)  [ironworking]
7 cauldron  iron 1 + wood 1  ( 8s)  [ironworking]
8 rod       wood 3           ( 6s)  — ungated
```

The rod being wood-only mirrors the bow, and is what keeps the shore reachable for a village with no
iron — `buildings.ts` calls the fishery "the poor village's option" and that should survive.

### Queue over standing order over auto

The barracks already has exactly this shape (`trainQueue` on `entities.ts:76`, `TRAIN_QUEUE_CAP`,
`firstReadyTraining`, fixed queue slots in the UI), so the Smith mirrors it rather than inventing
anything. At **batch start** — the existing `prodRecipeIndex` seam in
`src/sim/systems/production.ts:64-100`, which already exists to keep a batch honest across a
mid-batch switch — resolve in this order:

1. **Queue.** First unstarted `forgeQueue` item whose recipe is unlocked and whose inputs are
   present. Mark it `started`; remove it on completion, mirroring the barracks so a pause or a
   switch never loses the item.
2. **Standing order.** `b.recipeIndex`, if it names a real recipe.
3. **Auto** (`recipeIndex === AUTO_RECIPE`, `-1`, and the default for a newly built Smith).
   Integer-only and deterministic:

   > gap(tool) = (posts wanting that tool and not holding one) − stock(tool).
   > Highest gap wins; ties break on `GOODS` order. **No gap > 0 → the Smith idles** rather than
   > forging surplus axes out of scarce iron.

Because auto only ever picks tools, a player who wants weapons queues them or pins a standing order.

**This preserves every AI code path unchanged.** `setBuildingRecipe` keeps its current meaning — set
the standing order — so `forgeTheCounter` and `weaponMix` work as they do today. The AI never
enqueues, so its Smiths always have an empty queue and fall straight through to step 2.

## Files to change

Rollout follows the house precedent in `docs/plan-research-tree-brewery.md`: data → sim → UI → AI → docs.

### 1. Data

- **`src/sim/defs/goods.ts`** — **append** `'axe','pickaxe','scythe','hammer','cauldron','rod'` (19
  goods). Never insert: the array index is the SAB carry byte (`units.ts:103-109`), the last tiebreak
  in the job sort (`logistics.ts:266`) and part of the determinism hash (`hash.ts:73`). The file's own
  comment says so. Single lowercase words to match the existing style; `rod` displays as "Fishing Rod".
- **`src/sim/defs/buildings.ts`** — `TOOL_OF`; six new `recipeOptions` appended; `requiresTech`
  removed; `name: 'Weaponsmith'` → `'Smith'`. **Keep the `weaponsmith` type id** — renaming it would
  churn saves, all four AI playbooks, `economyRules.ts`, `assets.ts` and `snapshot.ts` for a display
  string. Leave a comment saying so.
- **`src/sim/defs/techs.ts`** — `ironworking.prereqs: ['cobbledBoots']` → `[]`, cost down
  (`{stone: 6, silver: 8}` → roughly `{stone: 4, silver: 5}`), duration 40s → ~30s. **Remove the
  `unlockBuilding: 'weaponsmith'` effect from both `ironworking` and `archery`** — the building is
  ungated now — and rewrite both `desc` strings plus `bellows`'.
- **`src/sim/defs/balance.ts`** — `FORGE_QUEUE_CAP = 5` beside `TRAIN_QUEUE_CAP`; `START_STOCK` gains
  `axe: 2, pickaxe: 2, scythe: 1, hammer: 3, cauldron: 1, rod: 1`. Comment these as bakeoff-tuned,
  like the existing weapon-rack comment.

### 2. Sim

- **`src/sim/entities.ts`** — `forgeQueue?: { recipeIndex: number; started: boolean }[]` on `Building`,
  beside `trainQueue` at `:76`.
- **`src/sim/commands.ts` + `src/sim/tick.ts:187-202`** — allow `-1` in `setBuildingRecipe`
  validation; add `enqueueForge { buildingId, recipeIndex }` and `cancelForge { buildingId, index,
  recipeIndex }`. Carry **both** index and recipeIndex on the cancel, exactly as `cancelTraining`
  does at `commands.ts:30`, so a stale click cannot cancel the wrong item after the queue shifted.
- **`src/sim/systems/production.ts`** — the three-step resolution above, stamped into `prodRecipeIndex`
  at batch start.
- **`src/sim/systems/staffing.ts`** — a post in `TOOL_OF` only recruits once its tool sits in
  `b.inputs`; consume it at `bindWorker`. In `unbindWorker` (`production.ts:281`) return the tool to
  `b.inputs` **only** on the voluntary paths — the dismiss command, sell, and `releaseObsoletePosts` —
  never on worker death.
- **`src/sim/systems/logistics.ts`** — a priority-2 standing demand for an unstaffed post's tool
  (alongside converter inputs and `trainingDemand`); `hammer: 1` folded into the priority-1
  construction demand; input top-up follows the **head of the forge queue** where there is one, so a
  Smith queued onto rods does not sit demanding iron; and widen the priority-3 evacuation at `:222`
  so a returned hammer in `b.stock` is carried home even though `outputGoodsOf(def)` does not name it.
- **Construction completion** — move the hammer from `inputs` to `stock`.
- **Ledger** — `checkLedger` in `src/sim/debug/invariants.ts` walks `GOODS` and polices tool
  conservation automatically. Every consume/return path must post to `world.ledger`, including the
  deliberate losses on death and destruction.
- **Versions** — three, all required:
  - `REPLAY_VERSION` 14 → 15 in `src/shared/replayVersion.ts`, **and** the two pins in
    `src/shared/replayVersion.test.ts` (`EXPECTED_VERSION = 14` at `:27` and `EXPECTED_HASH`) — the
    test hashes the sim surface and fails on both until each is updated.
  - `WORLD_SAVE_VERSION` 4 → 5 in `src/shared/saveVersion.ts`. Old saves are rejected outright, so no
    `recipeIndex` migration is needed.
  - `package.json` `version` 0.6.0 → **0.7.0** — baked in by `vite.config.ts:50` as `__APP_VERSION__`
    and read by `src/app/buildInfo.ts` into `APP_VERSION` / `BUILD_LABEL`, the version the player sees.
    A minor bump, not a patch: this changes the save format, the replay format and the economy.

  Multiplayer consequence to expect: the server keys persisted rooms off `REPLAY_VERSION`
  (`server/src/persist.ts:190`, `server/src/rooms.ts:98`), so live rooms on the Railway volume
  **rebase onto their snapshot** across the deploy rather than replaying — correct, but it discards
  the in-flight replay log for any match running at deploy time.

### 3. UI

TypeScript forces four of these — every exhaustive `Record<GoodId, …>` fails to compile until filled:

- **`src/ui/names.ts:39`** `GOOD_NAMES`, **`src/ui/tooltip.tsx:293`** `GOOD_DESC`,
  **`src/render/palette.ts:95`** `goodColors`, **`src/ui/icons.tsx:10,28`** `GOOD_HEX` + `PATHS`
  (six new 16×16 inline SVG glyphs in the house monochrome-with-accent style — note `MalletIcon` at
  `icons.tsx:293` already reads as a hammer and the two must not be confusable).
- **`src/render/models.ts:135`** `carryProto` is a non-exhaustive `switch` with **no default**, so a
  new good silently renders as an empty group and serfs would carry nothing visible.
  `src/render/characters.ts` already has procedural `pickaxeProp()`, hammer, axe and fishing-rod props
  to reuse.
- **New `src/ui/EconomyPanel.tsx`**, modelled on `src/ui/TechTreePanel.tsx`. Add `'economy'` to
  `HudPanel` in `src/ui/store.ts:110` and a HUD button beside the tech button. Groups goods in a
  **display order independent of `GOODS`** (required anyway, since tools append at the end):
  Raw · Food · Metal · Arms · Tools.
- **`src/ui/Hud.tsx:1078-1113`** — `<For each={[...GOODS]}>` becomes `<For each={HUD_GOODS}>`, curated
  to `wood, stone, food, iron, silver` + population. Six chips ≈ 465px, which *improves* the phone-menu
  situation rather than regressing it — re-derive the `58vh` number at `Hud.tsx:857` downward and
  update that comment.
- **Stall visibility** — a gating mechanic must never fail silently. Put "3 posts want an axe" in the
  **center rail**, not the strip, following `Hud.tsx:482-495` where the research chip was moved out
  precisely so it could not shunt the goods sideways.
- **`src/ui/SelectionPanel.tsx:379-419`** — the forge row is built for three buttons on a fixed 430px
  card and now needs nine plus a queue. Rebuild as declared grids, following the barracks block at
  `:485` (`repeat(3, minmax(0,1fr))`, fixed slots):
  - `arms` row — 3 buttons; `tools` rows — 6 buttons in 3×2. **Clicking a recipe enqueues it**, matching
    the barracks train buttons.
  - `when idle` row — a binary `[auto ⚙] / [hold]` toggle rather than a nine-way picker, so it stays
    touch-friendly. When the AI has pinned a standing order this row displays it.
  - `queue` row — `FORGE_QUEUE_CAP` fixed slots, cancel on click.

  The card's contract at `SelectionPanel.tsx:106-132` is "nothing live may move a button" — declared
  grids, fixed slots, controls grey out rather than unmount.
- **`src/ui/buildMenu.ts`** — `BUILD_KEYS` uses `P` for we**a**ponsmith, which no longer appears in
  "Smith"; pick a free letter from S/M/I/T/H (`buildMenu.test.ts` enforces one unique key per building
  and that the name can bold it). The Smith should also move from the Industry tab to **Village**, now
  that it is ungated and feeds the food chain — Industry drops to 4 and Village rises to 5, both
  inside the declared 3×2 `.hud-items` frame at `Hud.tsx:623-632`.

### 4. AI

- **`src/sim/defs/aiStrategies.ts`** — resequence all four playbooks' `researchOrder` for
  ironworking-at-root, and add an early Smith `BuildStep` so the AI does not starve itself of tools.
- **`src/sim/economyRules.ts`** — new rule (e.g. `keepTheToolsComing`): a post waiting on a tool with
  an idle Smith sets that Smith's standing order to auto. Add to **both** `EconomyRuleId` and
  `ECONOMY_RULES` — `economyRules.test.ts:45` enforces the pair. Place it *before* `forgeTheCounter`
  so `claims` arbitration stops the counter-pick rule clobbering a Smith mid-tool.
- **`src/ai/insight.ts:31`** — `WEAPON_NAMES` is indexed by recipe index and has three entries; a Smith
  on index 3–8 would read past the end. Guard it, or return the tool's name.
- **`src/ai/advice.ts`** — leave alone. `WEAPON_MIX_MAX = 2` still correctly clamps the LLM to the
  three weapon indices. Add a line about tools to `prompt.ts`'s glossary and surface tool stock in
  `summary.ts` so the strategist is not blind to a tool stall.

### 5. Docs

`README.md:25-58` is the canonical economy summary — "Goods (13)" and the Chains paragraph both change.

## Verification

1. `pnpm test` — the compile errors from the four exhaustive `Record<GoodId, …>` maps are the
   scaffolding; work through them first. `pnpm typecheck` covers `tools/aiLab` and `server` too.
2. **`src/sim/winnable.test.ts`** and **`src/sim/aiStrategies.test.ts`** are the real gates: the AI must
   still beat seed 17 within 45 000 ticks, and every playbook must still win the campaign map alone.
   Expect these to fail first and to drive the `START_STOCK` and recipe-duration numbers.
3. `src/sim/determinism.test.ts` and `src/sim/save.test.ts` — auto resolution and queue ordering are
   the risk; both must read only world state, integers only.
4. Extend `src/sim/weaponsmith.test.ts`: queue pre-empts standing order; a started batch survives a
   queue cancel; auto idles when no tool is wanted; a tech-locked recipe cannot be enqueued.
5. Ledger: run with invariants on and confirm `checkLedger` balances across a full match — including a
   raid that destroys a staffed building (tool lost) and a manual dismiss (tool returned).
6. **`pnpm bakeoff`** (`tools/aiLab/`, `--rules` ablation) to measure whether the tool gate moved win
   rates, and to justify the new economy rule by ablating it.
7. Play it: `?size=32` for an early raid per the combat-verification notes. Check that the HUD strip
   does not wrap at 1280px, that the ☰ menu's Quit is reachable on a phone in both orientations, that
   the forge grid does not shift when a batch completes or the queue drains, and that a serf is
   visibly seen carrying an axe to a new woodcutter.

## Deliberately out of scope

Coal, a smelter and iron bars; a saw; tool wear over time; Settlers-style global priority weights
(the queue plus auto replaces them); and any campaign beat teaching tools — though
`src/sim/defs/missions.ts` and `src/ui/hints.ts` should be re-run to confirm the starter kit keeps
the existing missions passable.
