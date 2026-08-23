# Plan: single-player campaign + tutorial

Status: implemented. Seven missions (Hammer and Haft, mission 4 below,
was added after the first six shipped), authored maps rolled from pinned
seeds, objectives evaluated in the sim (a `mission` on `WorldConfig`,
checked in `victory.ts`), hints driven entirely on the main thread from
`StructuralUpdate` snapshots. No map editor, no new save format, no
rewrite of the solo mode — the finale *is* the solo mode.

Notes from the landing: seeds pinned at 101 / 202 / 303 / 404 /
20260724 / 606, each held by `missions.test.ts`; hints advance on the
objective latch bits (plus a Got-it button for lore steps) instead of
their own snapshot predicates — the latches already ride
`StructuralUpdate`, so hints needed no plumbing of their own; mission 3's
winnability test is scripted like mission 1's rather than AI-driven (the
brain trains soldiers the moment it can and eats every spear the
checklist wants stockpiled); and the objectives panel carries a "brief"
button that reopens the commission card mid-match.

## Why now

Two things make Serf Valley hard to hand to a new player today:

1. **The game teaches nothing.** Solo mode drops the player at a castle
   with a 9-minute clock already running (`FIRST_RAID_TICK`,
   `balance.ts`) toward a raid they don't know is coming, against an
   objective (raze the bandit camp, `victorySystem` in
   `src/sim/systems/victory.ts`) that nothing on screen states. The
   distinctive mechanics — emergent trails instead of road-drawing, the
   gatherer-reach placement rule, population-as-beds, the fish-or-bake
   fork — are exactly the ones a Settlers veteran will mis-assume their
   way past.

2. **The pieces are already lying around.** Pinned seeds give repeatable
   maps (`generateMap` + the map-fairness repair pass guarantees wood,
   rock and silver near every start). Playbooks proved that scripted
   openings are pure data (`aiStrategies.ts`). The worker already drains
   one-shot `GameEvent`s into toasts (`main.ts`), the end card is a
   working modal pattern (`endCard()` in `Hud.tsx`), and
   `winnable.test.ts` shows how to prove a mission beatable headlessly.
   A campaign is mostly *wiring*, not new systems.

Design values carried through: pure-data mission defs, deterministic sim
(win conditions in the sim, presentation on the main thread), additive
diffs, every phase green on its own.

## The campaign arc

Framing: the player is a newly-made **reeve**, sent by the crown to
settle a frontier valley — one commission per mission, each a different
pinned seed. Seven missions, ~70–105 minutes total for a first-timer; an
RTS veteran can sprint any mission on objectives alone, because hints
are a separate, dismissable layer that never gates anything.

Maps are seeded procedural (`seed` pinned per mission def) — no map
editor exists and none is needed; the fairness repair pass already
promises every start its wood, rock and silver. Seeds below are
placeholders to be pinned during implementation by playtest — except the
finale's: `20260724` is the seed `winnable.test.ts` already proves
takeable.

| # | Mission | Teaches | Bandits | Win | Fail |
|---|---|---|---|---|---|
| 1 | The Clearing | camera, select, placement + reach, trails, hiring, beds | off | build + stock objectives | castle falls (can't, practically) |
| 2 | Bread and Water | converter chains, well, food fork, game speeds | off | food chain standing + 12 food | castle falls |
| 3 | The Abbey's Ledger | silver economy, abbey + research, iron, the forge | off | ironworking + forge + 4 spears | castle falls |
| 4 | Hammer and Haft | the tools chain: the Smith, tool-gated posts, the borrowed hammer | off | Smith + iron, wood, food flowing + 3 hammers | castle falls |
| 5 | The Levy | barracks, RPS triangle, defending raids, attacking | on, early | 6 soldiers, raze the camp | castle falls |
| 6 | Hold the Valley | everything, unassisted | on, default | raze the camp (today's solo mode) | castle falls |
| 7 | The Rival Banner (bonus) | facing an AI playbook | on (neutral, mid-map) | last banner standing | eliminated |

### Mission 1 — The Clearing

*"The crown grants you a valley and eight hands. Put a roof over them."*

- **Setup**: `bandits: false`, `startSerfs: 6`, `startStock: { wood: 20,
  stone: 6, silver: 24 }` (deliberately below the default 8 serfs /
  36 wood — hiring and the wood loop must be *needed*, and with no raids
  the 8-serf balance floor doesn't apply).
- **Objectives** (all required, shown as a checklist):
  1. Raise a Woodcutter (1)
  2. Raise a Quarry (1)
  3. Raise a House (1)
  4. Hire until 11 villagers live here (`population ≥ 11`)
  5. Lay in 30 wood at the Castle (`stock wood ≥ 30`)
- The population target is 11 **on purpose**: the castle alone sleeps 10
  (`housing` in `buildings.ts`), so hiring past it makes the house
  objective load-bearing — population-is-beds is the lesson, not a
  checkbox. From 6 serfs that is 5 hires × `HIRE_SERF_COST` (4 silver) =
  20 silver; the 24-silver start affords them with a little slack.
- **Hints** (linear, each advances on a stateless predicate): camera
  pan/zoom → select the castle → open Build (the `'build'` panel) →
  *"the green ring is the woodcutter's reach — it must stand where its
  axeman can see trees"* (the ghost + `SelectedReach` already draw
  this) → *"watch the serfs: the paths they walk wear into trails on
  their own — there are no roads to draw"* → *"everyone needs a bed: the
  castle sleeps ten, a house sleeps ten more"* → the Hire button.
  Expected 5–8 min.

### Mission 2 — Bread and Water

*"An army marches on its stomach, and yours doesn't exist yet. Learn to
bake."*

- **Setup**: `bandits: false`, default serfs (8), `startStock: { wood:
  40, stone: 12, silver: 12 }`. Seed pinned to a map with shoreline near
  the start (the fishery hint needs one in reach).
- **Objectives**: Well, Wheat Farm, Mill, Bakery each ≥ 1;
  `stock food ≥ 12`.
- **Hints**: the chain drawn as a sentence (well → farm → mill → bakery,
  water twice — the bakery drinks too); *"nobody lives at the well or
  the mill — a bucket is a thing you do, wind does the grinding"*; the
  input/output buffers on the selection panel; *"one mill serves two
  farms"*; the shore alternative (*"in a hurry and poor? a fishery feeds
  with one hut and one hand — fish while you are poor, bake once you are
  not"*); and the speed keys (*"waiting on an oven is what fast-forward
  is for"* — speeds 0/1/3). 8–10 min.

### Mission 3 — The Abbey's Ledger

*"Learning costs silver. Silver comes out of a hill. Start digging."*

- **Setup**: `bandits: false`. **Pre-built** (already standing,
  worldgen-style): woodcutter, quarry, house, well, wheat farm — the
  player should not re-play missions 1–2. `startSerfs: 10`,
  `startStock: { wood: 50, stone: 20, wheat: 12, silver: 10 }`.
- **Objectives**: Abbey ≥ 1; Silver Mine ≥ 1; research **Ironworking**
  (forcing Cobbled Boots first — the tree's prereq line teaches itself);
  Iron Mine ≥ 1; Weaponsmith ≥ 1; `stock spear ≥ 4`.
- **Hints**: the tech panel (`'tech'` HudPanel) and the three branches;
  *"research is paid in goods and time, one study at a time"*; mines
  stand on mountainsides (the `mine` placement exemption); the forge's
  recipe menu (`recipeOptions` — spear/sword/bow). 10–12 min.

### Mission 4 — Hammer and Haft

*"They took every axe and pick with them. The huts still stand."*

Added after the first six shipped: the campaign taught the Smith as the
place spears come from (mission 3) and then handed every later mission a
full tool shed in its `startStock`, so the half of the economy that
decides *who can work at all* was never once played. This mission is that
half, and nothing else.

- **Setup**: `bandits: false`, `seed: 350`, `startSerfs: 12`,
  **pre-built** and standing idle: woodcutter, quarry, house, well, wheat
  farm, mill, bakery, iron mine — the predecessor's village, with no Smith
  among them. Techs `cobbledBoots` + `ironworking` granted (research was
  mission 3's lesson). `startStock: { wood: 30, stone: 15, iron: 4,
  silver: 6, hammer: 1 }` — no axe, no pickaxe, no scythe, no cauldron,
  and exactly one hammer.
- **The puzzle is the bootstrap.** The one hammer raises the Smith (a site
  borrows one and returns it at topping-out), and the four iron is all the
  Smith has until the mine is manned — but the pickaxe deliberately costs
  no iron (`buildings.ts` explains why), so forging the pick first and
  staffing the mine is always the way out of a bare rack. There is no
  hard-lock: even a player who burns the iron on the wrong tool can still
  forge a pick.
- **Objectives**: Smith ≥ 1; `stock iron ≥ 12` (the pickaxe → the mine);
  `stock wood ≥ 45` (the axe → the woodcutter); `stock food ≥ 12` (the
  scythe → the field and the cauldron → the oven); `stock hammer ≥ 3`.
  The checklist asks for what the posts *make* rather than for the tools
  themselves, because a forged tool is hauled to whichever post is calling
  for it — it reaches the castle shelf only once nothing is waiting on it.
  The hammers are the exception and the point: a hammer is wanted by a
  construction site, so a village with nothing rising wants none and the
  auto-forge goes cold. That batch is queued by hand at the forge menu, or
  not at all.
- **Hints**: the bare peg (*"no axe, no post"*); the iron-free pickaxe; the
  auto-forge working down the open posts; the two tools the bread chain
  needs and the two buildings (well, mill) that keep nobody and so want
  none; the hammer as a loan that caps how many sites can rise at once.
  8–10 min; won at tick ~8.5k on the taught line.

### Mission 5 — The Levy

*"Word from the pass: bandits have made camp in the north. The crown
expects them gone."*

- **Setup**: `bandits: true`, `firstRaidTick: 6000` (5 minutes — the
  point of this mission *is* the raid, arriving before the player feels
  ready). **Pre-granted techs**: `soldiery`, `cobbledBoots`,
  `ironworking` (research was mission 3's lesson). **Pre-built**:
  woodcutter, quarry, house ×2, well, wheat farm, mill, bakery, silver
  mine, abbey. `startSerfs: 12`, `startStock: { wood: 30, stone: 15,
  food: 10, iron: 6, silver: 25, spear: 2, sword: 1 }`.
- **Objectives**: Barracks ≥ 1; field 6 soldiers at once
  (`soldiers ≥ 6`); raze the bandit camp.
- **Hints**: training costs food + a weapon + a recruit off the
  population; the triangle (*"knights break spearmen's lines, spearmen
  skewer archers' pursuers, archers feather knights"*) — and the raid
  warning toast already names the wave's composition (`raidIncoming`
  text from `bandits.ts`), so the hint teaches *reading* it; right-click
  marching; *"the camp's guards don't chase far — bring everyone at
  once"*. Fail = castle falls, and here it actually can. 12–15 min.

### Mission 6 — Hold the Valley

*"No more letters from the crown. The valley is yours to keep — or
lose."*

Exactly today's solo mode: `seed: 20260724` (the winnable-test seed),
default stock/serfs/raid clock, objective `razeCamp`. No hints — only
the briefing card and the objective line. This is the graduation exam,
and it needs **zero new balance work** because `winnable.test.ts`
already holds this exact line.

### Mission 7 — The Rival Banner (bonus, post-campaign)

*"A rival reeve claims the far end of the valley. Two banners, one
charter."*

`players: [human, { kind: 'ai', strategy: 'steward' }]` on the 2-player
`START_LAYOUTS` ring, bandits on (worldgen already puts their camp in
the contested middle for multi-seat maps). No `ObjectiveSpec` — the
existing last-faction-standing branch in `victorySystem` decides it.
This mission is the on-ramp to skirmish and multiplayer, and it costs
almost nothing: the whole path already exists.

## Implementation blueprint

### 1. Mission defs — `src/sim/defs/missions.ts` (new, pure data)

Follows the `aiStrategies.ts` pattern exactly: a typed record, an order
array, a `parseMissionId` gate (URLs are hand-editable; mirror
`parseStrategyId`'s `Object.hasOwn` guard).

```ts
export type MissionId =
  | 'clearing' | 'breadAndWater' | 'ledger'
  | 'levy' | 'holdTheValley' | 'rivalBanner';

export type ObjectiveSpec =
  | { kind: 'building'; type: BuildingTypeId; count: number } // built, not dead
  | { kind: 'stock'; good: GoodId; amount: number }           // storehouse stock
  | { kind: 'research'; tech: TechId }
  | { kind: 'population'; count: number }
  | { kind: 'soldiers'; count: number }                       // living soldiers
  | { kind: 'razeCamp' };

export interface MissionDef {
  id: MissionId;
  title: string;
  briefing: string;              // the flavor paragraph
  seed: number;
  players: WorldConfig['players'];
  bandits: boolean;
  firstRaidTick?: number;        // overrides FIRST_RAID_TICK
  startSerfs?: number;           // overrides START_SERFS
  startStock?: GoodAmounts;      // overrides START_STOCK
  startTechs?: TechId[];         // pre-researched (player 0)
  prebuilt?: { type: BuildingTypeId; dx: number; dy: number }[];
  objectives: { spec: ObjectiveSpec; label: string }[]; // [] = elimination
}
```

Every objective is a **stateless predicate over the world** — stock ≥ N,
count ≥ N, tech ∈ researched, camp dead. No counters, no accumulators.
That is what keeps the objective system serializable for free: the only
state is a latch (below).

### 2. Win condition — in the sim, on purpose

Two homes were weighed. Main-thread-only objectives were tempting (zero
sim surface), but the win must set `world.outcome` — that is what drives
the end card, stops the raid escalation, and, decisively, is the only
thing `missions.test.ts` can assert on headlessly. So: **win conditions
in the sim, hints on the main thread.** The split is clean — the sim
knows *whether* you've won; only the UI knows *how to help you*.

- `WorldConfig` gains `mission?: MissionId` (id, not the spec — the sim
  looks up `MISSION_DEFS`, keeping config and save small).
- `World` gains `missionId?: MissionId` and `objectivesDone?: boolean[]`.
  The done flags **latch**: a stock objective met and then spent stays
  met (no flickering checkmarks, and the completion event fires exactly
  once). The latch is why this must be world state, saved and restored.
- `victorySystem` (`src/sim/systems/victory.ts`): before the existing
  solo branch, if `world.missionId` is set and objectives are non-empty,
  evaluate each un-latched spec, push a new
  `{ kind: 'objectiveComplete'; index; player }` `GameEvent` per
  newly-met one, and `endMatch(world, 0)` when all are latched. The
  storehouse-elimination loss above is untouched; the existing
  raze-the-camp branch remains for non-mission solo, and mission 6
  (objectives `[]`) falls through to the multi-seat elimination branch
  unchanged. Evaluation helper lives in a small
  `src/sim/systems/objectives.ts` to keep `victory.ts` readable.
- **Determinism**: `missions.ts` is pure data with no DOM
  (`determinism.lint.test.ts` stays green); mission id is config the
  same way `seed` is, so two hosts with the same config tick
  identically.

### 3. World setup — `src/sim/missionSetup.ts` (new), called from `createWorld`

`createWorld` (`src/sim/world.ts`) grows one block: if `config.mission`,
resolve the def and

1. apply `startStock` / `startSerfs` in place of `START_STOCK` /
   `START_SERFS` (the existing loops just read a local),
2. push `startTechs` into `players[0].techs.researched` (of the techs
   the campaign grants — soldiery, cobbledBoots, ironworking — none
   carries a side flag; only `masonry` would need `pavingUnlocked`
   mirrored, noted in code for whoever grants it later),
3. set `world.raidState.nextRaidTick = def.firstRaidTick ??
   FIRST_RAID_TICK`,
4. place `prebuilt` buildings via `placeBuiltBuilding` at castle-origin
   + offset, falling back to the same ring-spiral `rectClear`/`canPlace`
   search the bandit camp placement already uses when the pinned seed's
   terrain refuses a spot (deterministic — no rng draw unless needed,
   mirroring the map-repair pattern). Resident posts staff themselves
   through the normal `staffingSystem` path — no special casing.

The `?mission` config sets `banditsEnabled` from the def, so peaceful
missions get the existing no-camp/no-raids worldgen for free. No
`RAID_INTERVAL` override in the first pass — only the first-raid clock
is a mission knob.

### 4. Wire protocol + saves

- `StructuralUpdate` (`src/protocol/messages.ts`) gains
  `mission?: { id: MissionId; done: boolean[] }`; `postStructural`
  (`src/app/simWorker.ts`) includes it and folds it into the change-
  detection string so frames still skip when nothing moved.
- `save.ts`: `missionId` + `objectivesDone` as optional fields on the
  version-3 file, exactly the `banditsEnabled?` precedent — no version
  bump, old saves load with both absent.
- **Crucially**, the main thread's source of truth for "which mission is
  this" is `msg.mission.id` from the worker, *not* the URL — because the
  Load path reboots on `?seed=…` and would lose a URL param, but the
  world remembers.

### 5. Launch plumbing

- `configFromUrl` (`src/app/gameConfig.ts`): parse `?mission=`, and on a
  valid id return `{ seed: def.seed, players: def.players,
  banditsEnabled: def.bandits, adminEnabled: true, mission: id,
  myPlayerId: 0 }` (an unknown id is ignored — the URL is
  hand-editable). `GameConfig` carries `mission` through untouched.
- `main.ts`: add `'mission'` to `LAUNCH_PARAMS`. In the `onStructural`
  handler: `setMission(msg.mission ?? null)`, and when `msg.outcome`
  flips to a player-0 win with a mission present, write completion into
  the campaign store (idempotent).
- Optional polish: when `config.mission` is set, start the match paused
  (`host.setSpeed(0)` + store `setSpeed(0)`) so the briefing card is
  read on a still valley; its **Begin** button sets speed 1.

### 6. HUD — briefing, objectives, hints

- `src/ui/store.ts`: `HudPanel` union gains `'mission'`; new signal
  `[mission, setMission]` holding `{ id, done: boolean[] } | null`.
- `src/ui/MissionPanel.tsx` (new): three faces of one component —
  1. **Briefing**: the `endCard` modal pattern (`hud-end` /
     `panel end-card` classes in `Hud.tsx`), shown at tick 0 until
     dismissed;
  2. **Objectives checklist**: a slim always-visible panel (top-left,
     under the resource bar), labels from
     `MISSION_DEFS[mission().id].objectives` zipped with `done[]` —
     defs are shared code, so the UI imports them the way `StartMenu`
     already imports `AI_STRATEGIES`;
  3. **Hint line**: the current tutorial step's sentence, in the panel —
     *not* `pushToast` (8-second expiry is wrong for a standing
     instruction; toasts stay reserved for one-shot news like
     `objectiveComplete`, which does get a toast).
- `src/ui/hints.ts` (new, main-thread only): per-mission `HintStep[]` —
  `{ text, done(snapshot): boolean }` over `{ players, buildings }`
  snapshots plus UI signals (`placing()`, `openPanel()`). A trivial
  driver shows the first step whose `done` is false. Because every
  predicate is stateless, a loaded save fast-forwards past finished
  steps with no persistence at all. Hints live in `src/ui`, not
  `sim/defs`: they reference presentation concepts (which panel is
  open), and the sim must not know those exist. One **Hide hints**
  toggle, persisted in the campaign store — objectives-first players
  flip it once and never see hints again.
- `Hud.tsx` end card: on a mission win, add a **Continue** button beside
  Play again — `location.search = '?mission=' + nextId` (the same
  navigation `launch()` uses).

### 7. Start menu + progress store

- `localStorage['serf-campaign']`, shape
  `{ v: 1, completed: MissionId[], hintsHidden?: boolean }` —
  read/write helpers in a small `src/ui/campaign.ts`. Deliberately
  separate from the save slot: progress is a profile, a save is a world.
- `StartMenu.tsx`: the `seg` mode toggle grows a third entry —
  **Campaign** (`Mode = 'single' | 'campaign' | 'multi'`, and
  `StartState` callers updated). The campaign pane lists
  `MISSION_ORDER` rows (title, one-line premise, ✓ for completed, lock
  for not-yet-unlocked) in the room-browser's visual language; CTA
  "Begin: <title>" → `location.search = '?mission=' + id`. Unlock rule:
  mission *k* is open when *k−1* is completed (mission 1 always open);
  the URL param honors any id regardless — a deliberate pressure valve
  for testers and the impatient.
- Save-slot interplay: **allow** mid-mission saves into the existing
  single global slot. The mission id rides the save, the hint driver is
  resume-safe by construction, and completion recording keys off the
  worker's mission block — so Load "just works". The only cost is that
  a campaign save overwrites a sandbox save, which is today's behavior
  for any two games; namespacing the slot per-mission is deferred (open
  question).

### 8. Tests — `src/sim/missions.test.ts` (new)

- **Golden-path runs for missions 1–4**: scripted command sequences
  (via `cmds()` / `tickWorld` on `createWorld({ mission })`, the
  `testUtils.ts` style) that play each mission's intended solution and
  assert `outcome === { state: 'over', winner: 0 }` within a tick
  budget. These double as the proof that the pinned seed actually
  affords the mission (shore near start for M2, etc.) — a failing seed
  fails the test at authoring time, not in a player's browser.
- **Mission 5** is already covered: `winnable.test.ts` *is* its test
  (same seed, same config). Add a one-line variant constructing it via
  `{ mission: 'holdTheValley' }` to prove the mission path reaches the
  same outcome.
- **Mission 6**: brain-vs-brain via the `aiStrategies.test.ts` harness
  pattern; assert someone wins.
- **Determinism guard**: run mission 1 twice from the same config,
  compare world hashes (`hash.ts`) — the same shape
  `determinism.test.ts` already uses.
- **Plumbing**: `gameConfig.test.ts` cases for `?mission=` (valid,
  unknown, combined with a stray `?seed=` — mission's pinned seed
  wins); `save.test.ts` round-trip of `missionId`/`objectivesDone`.

## Rollout order

1. **Sim core** — `missions.ts` (defs for missions 1 and 5 only),
   `missionSetup.ts`, `World.missionId`/`objectivesDone`,
   `objectives.ts` + the `victory.ts` hook, `objectiveComplete` event,
   save fields. Tests: M1 golden path, M5-via-mission, determinism,
   save round-trip. Playable headlessly; zero UI change.
2. **Launch plumbing** — `?mission=` in `gameConfig.ts` +
   `LAUNCH_PARAMS`, mission block in `postStructural`, `mission`
   signal, objective toasts, end-card Continue. Playable by URL,
   dev-facing.
3. **HUD** — `MissionPanel` (briefing / checklist / hint line), paused
   start, `HudPanel` union entry.
4. **Menu + progress** — campaign pane in `StartMenu`, `serf-campaign`
   store, unlock/✓ states.
5. **Content** — missions 2–4 defs, hint scripts, golden-path tests,
   seed-pinning playtests; then mission 6 and README's solo-mode
   section.

Each phase lands green with everything before it; nothing past phase 1
touches the sim.

## Open questions

- **Finale seed**: pin `20260724` (winnability guaranteed by the
  existing test) or let the player roll a seed with a "not all valleys
  can be held" disclaimer? Proposed: pin it; free-seed play is what the
  skirmish/sandbox pane is for.
- **Hard mode**: is an "again, but harsher" finale variant (first raid
  at 7 min, +2 camp guards) worth a mission-def knob in the first pass,
  or a follow-up?
- **Mission 6**: in the first pass or the second? It is nearly free
  mechanically but doubles the playtest surface.
- **Best times**: record `bestTicks: Record<MissionId, number>` in the
  campaign store now (cheap) or never (scope)?
- **Save-slot namespacing**: is one global slot acceptable for v1 (a
  campaign save evicts a sandbox save), or should the campaign refuse
  the Save button in missions 1–4 (each ≤ 15 min) instead?
- **Raid-interval override**: mission 4 currently rides the stock
  3-minute `RAID_INTERVAL`. If playtesting wants a faster drumbeat
  there, the knob means threading an interval through `raidState` —
  small, but sim state, so deferred until a mission proves it needs it.
