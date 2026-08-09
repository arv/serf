# Plan: research tree refresh + brewery utilization

Status: implemented. Millstones, Ale Rations and Bellows are in the tree;
the brewery brews on a 20 s batch; the barracks keeps an ale cask once Ale
Rations lands (each recruit drinks 1 and trains 25% faster — never a gate);
the Abbot's playbook researches Brewing → Festivals and raises a brewery.
Open questions resolved: rations went to training speed (not HP), Bellows
made the first pass, and the bellows buff covers bowstaves too — one roof,
one bellows.

## Why now

Two things drifted apart when the food chain landed (`flour`, `food`, the
mill / bakery / fishery, and a barracks that trains on bread instead of raw
wheat):

1. **The tech tree still speaks the old wheat economy.** Agriculture is
   irrigation → brewing → festivals: one farm buff, then ale all the way
   down. Nothing in the tree touches the mill, the bakery or the fishery —
   the buildings the war economy now actually marches on. `farmSpeed`
   accelerates the front of a chain whose designed bottleneck is the mill
   ("one mill serves two farms", `buildings.ts`).

2. **The brewery is oversupplied fourfold.** It brews 1 ale / 15 s =
   4 ale/min. Ale's only sink is the abbey festival: 1 ale per 60 s buff
   (`FESTIVAL_DURATION`), so demand tops out at 1 ale/min with the buff at
   permanent uptime. The brewery fills its output cap and idles at ~25%
   duty while holding a population slot and eating the mill's wheat.
   And it is invisible to the campaign: **no AI playbook researches
   `brewing` or builds a brewery** (`aiStrategies.ts` research orders stop
   at irrigation).

## Proposed research tree

Keep the three branches, the one-at-a-time queue, and the pure-data tech
shape. No currently-ungated building becomes gated — the raid clock
(`FIRST_RAID_TICK` = 9 min) was tuned against the current build orders, and
gating the bakery would re-litigate that. Additions only.

### Agriculture — becomes the food-and-ale branch (3 → 5 nodes)

```
Irrigation ──┬── Millstones                     (NEW)
             └── Brewing ── Festivals ── Ale Rations   (NEW)
```

| Tech | Cost | Time | Effect |
| --- | --- | --- | --- |
| Irrigation | wheat 5, silver 3 | 25 s | unchanged: farms +30% |
| **Millstones** | stone 6, silver 5 | 30 s | mill **and bakery** +30% (`foodSpeed` modifier) |
| Brewing | wheat 8, silver 4 | 30 s | unchanged: unlocks Brewery |
| Festivals | ale 2, silver 6 | 30 s | unchanged: abbey burns ale for +25% work speed |
| **Ale Rations** | ale 4, silver 6 | 30 s | barracks stocks ale; each soldier trained drinks 1 and trains **25% faster** |

- **Millstones** gives the tree a lever on the chain's real bottleneck.
  Deliberately excludes the fishery: the fishery is the poor village's
  option ("fish while you are poor, bake once you are not") and a
  late-game buff to it would undercut that fork.
- **Ale Rations** is the second ale sink (details below). Costing ale to
  research it means the brewery is already employed before the effect
  lands. It lives in Agriculture on purpose — a cross-branch payoff, the
  same way Craft's ironworking feeds Warfare's swords.

### Craft — one optional addition (4 → 5 nodes)

```
Cobbled Boots ──┬── Ironworking ──┬── Deep Mining
                │                 └── Bellows          (NEW, optional)
                └── Masonry
```

| Tech | Cost | Time | Effect |
| --- | --- | --- | --- |
| **Bellows** | iron 3, silver 6 | 30 s | weaponsmith +30% (`forgeSpeed` modifier) |

Bellows gives Deep Mining a real rival for the post-ironworking slot:
faster ore versus faster weapons out of the same forge. Skippable if the
first pass should stay minimal — nothing else depends on it.

### Warfare — unchanged (4 nodes)

Soldiery → Archery; Soldiery → Mail Armor → Gilded Arms. The food switch
already routed war through the bakery; the training-speed lever arrives
via Ale Rations rather than a duplicate "field rations" tech here.

### Implementation notes (tree)

- Two new `ModifierKey`s: `foodSpeed`, `forgeSpeed`. Each is one read at
  an existing `getModifier` site in `production.ts` — the pattern
  `b.type === 'wheatFarm' ? farmSpeed : 1` already shows where
  (mill/bakery for `foodSpeed`, weaponsmith for `forgeSpeed`).
- `TechTreePanel` renders from `TECH_DEFS` — new nodes appear for free;
  the branch column scrolls, so 5 nodes fit.
- Tests: extend `research.test.ts` with modifier-application cases per new
  key, mirroring the existing `serfSpeed` test.

## Brewery utilization plan

Three complementary moves; the goal is a brewery whose duty cycle tracks
how hard the player is pushing, instead of a flat 25%.

1. **Add the second sink — Ale Rations.** The barracks accepts ale up to a
   cap of 2 (mirror `ABBEY_ALE_CAP` plumbing: a demand in `logistics.ts`,
   an accept branch on delivery). When training starts and ale is in
   stock, `training.ts` consumes 1 and scales that order's
   `durationTicks` by 1/1.25. No ale → normal speed, never blocked: ale is
   an accelerant, not a gate, so a raided brewery can't stall the army.
   Demand scales with war tempo: a busy barracks at 2–3 soldiers/min
   drinks 2–3 ale/min on top of the festival's 1.

2. **Slow the brewery to fit its market: 15 s → 20 s per ale (3 ale/min).**
   With both sinks active (festival 1/min + rations 2–3/min at war) a
   single brewery sits near full duty instead of 4× oversupplying a
   1/min market. Wheat math stays sane: 3 wheat/min is half a farm's
   6/min, alongside the mill's draw.

3. **Teach the campaign AI to drink.** Extend the long-game playbook (the
   one already researching `irrigation`) with `brewing`, `festivals` in
   its `researchOrder`, and add a brewery build step
   (`anchor: 'base'`, `after: 'brewing'`, `needs: 'abbey'`) plus a second
   well if the first is saturated. Gate: `winnable.test.ts` must stay
   green — if the extra spend costs the AI its army timing, the brewery
   step waits on `ironworking` the way the fishery does.

Festival tuning itself (duration, buff size) is deliberately untouched in
this pass — change the sinks first, measure, then reach for the
`FESTIVAL_DURATION` knob only if uptime still disappoints.

## Rollout order

1. Tree data: new techs + `foodSpeed`/`forgeSpeed` keys + reads + tests.
2. Brewery: 20 s batch; Ale Rations plumbing in logistics + training + tests.
3. AI: playbook research order + brewery step; run the winnable suite.
4. Docs: README's goods count (11 → 13) and chain description are already
   stale from the food-chain landing — fold the corrections in here.

## Open questions

- Should Ale Rations speed training by 25%, or grant a small starting-HP
  bonus instead? Speed is proposed: HP is Mail Armor's identity, and
  stacking a third HP multiplier muddies the combat triangle math.
- Bellows: in or out of the first pass?
- Should the *bow* recipe (wood-only, no iron) also benefit from Bellows,
  or should the forge buff be iron-recipes-only? Proposed: all three —
  one roof, one bellows.
