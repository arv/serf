# Plan: an AI that never stalls, reads its opponent, and finds its own ideas

Status: **all three phases built and measured** (2026-08-20), and only one
of them paid. Phase 1 landed and cleared its bar. Phase 3a landed as
tooling. Phase 2 is an honest null — the intelligence got measurably
better and the win rate did not follow. See each phase's checkboxes, and
the sections added to `tools/aiLab/README.md`.

Three phases, deliberately ordered — a seat that freezes cannot adapt, and a
seat that cannot adapt has nothing worth searching for. That ordering held
up, but the dependency ran the other way too: phase 2's classifier reads
`unknown` half the time because behind fog the four shipped playbooks look
alike, so phase 3a's per-seat playbooks are what would give it a fair test.

Phase 1's diagnosis did not survive contact with the sim. Two of the three
things it fixed are not in `AiBrain` at all, and the seat that "stopped
playing" was working perfectly the whole time — read "What tracing actually
found" before trusting the two paragraphs below it.

## Why now

The bake-off (`tools/aiLab/`) can finally say whether an AI change helped,
and the first thing it says about the current AI is that **7.5% of matches
are broken games**: 18 of 240 never decided inside the 120k-tick horizon.

Tracing three of them found two distinct failures, and neither is a tuning
problem.

**A frozen economy — seed 9, both seats.** Sampled every 20k ticks:

```
t=40000   p0 pop=14 serfs=9 bld=17 sites=0 silver=0 food=4 wood=2
t=120000  p0 pop=14 serfs=9 bld=17 sites=0 silver=0 food=4 wood=2
```

Every number identical across 80,000 ticks — 67 minutes of game time with
zero change on either side. Nine serfs stand idle beside seventeen finished
buildings with no wood and no silver. The mechanism is irreversible: tree
groves regrow only on *standing, uncleared* tiles (`systems/production.ts`
`regrow`), so a woodcutter that has cleared its radius sits on dead ground
forever — and nothing in `AiBrain` can re-site a building. The build order
is a one-shot list of placements (`defs/aiStrategies.ts`), so once every
step is placed, `sites=0` is a terminal state.

**A collapse with no floor — seeds 44 and 51.** One seat at pop 2, one serf,
silver 0-1, food 0, while the other runs 21 pop. `survivalFloor: 3` exists
to catch precisely this and cannot: panic hiring still needs
`HIRE_SERF_COST` in silver and a bed to put the serf in, and a collapsed
seat has neither.

Both are "stuck on the economy". Neither is visible to a player as anything
but an opponent that stopped playing.

The other two asks are real but downstream. `#counterPlan` already adapts on
one axis (enemy dominant unit class → forge recipe and training), and it is
starved rather than wrong: instrumenting the march gate showed the brain
marches believing the enemy has three soldiers because three is all one lone
scout ever lit. And "new ideas" is not a model problem at all — see phase 3.

---

## Phase 1 — never stuck

Goal: **undecided matches from 18/240 to under 5/240**, with no loss of win
rate against the recorded baselines.

The shape is many small conditional rules, not one clever planner — the
AoE2 production-system approach, which is what actually ships in this genre.

### What tracing actually found

Re-running the traces before writing any code changed the diagnosis twice,
so the paragraphs above are kept as written and corrected here.

**The frozen-economy numbers above are not reproducible.** Seed 9 under
`--engine none` freezes at `pop=6 serfs=0 bld=9` for p0 and `pop=7 serfs=0
bld=16` for p1 — not `pop=14 serfs=9 bld=17`. The published trace was
almost certainly taken under an advised engine.

**It is not resource exhaustion, it is a hauler famine.** Measured with the
sim's own reach test (`findResourcesNear` at the gatherer's own radius), of
the eight extractors standing across both seats at t=120000 exactly one has
a worked-out seam. Every one of them is at `OUTPUT_CAP`, and p1's silver
mine holds four silver — one hire's worth — twenty tiles from the
storehouse. Both seats have **zero free serfs**: every hand is bound to a
post or was spent as a barracks recruit, and only an *idle serf* is offered
a haul job (`systems/logistics.ts`). Nothing hauls, so nothing reaches the
storehouse, so nothing is affordable, so no hand is ever hired. Fully
employed and completely paralysed.

**And the escape valve was fine — the pathfinder ate the order.** The
impatience ramp does everything the comment says: by t=60000 `mustersNeeded`
is down to 1 and each seat orders its lone surviving knight at the enemy
castle. The order dies in `applyMoveUnits`, because `findPathToAdjacent`
returns null across a valley a flood fill says is fully connected — the A*
runaway-search cap was `(play * play) >> 1` = 4608 expansions on a 96 map
whose walkable component is **5016 tiles**. A cap whose only job is bounding
an *unreachable* search was smaller than the component a reachable one has
to cross, so every long march on this map was silently dropped and the army
sat in `raid` forever, re-trying every 45 ticks against a goal it was not
allowed to find. Not an AI bug at all.

### 1a. See the stall

- [x] Add a rolling progress window to `AiBrain`: sample `pop`, completed
      buildings, and storehouse throughput every N decision beats, keep the
      last K samples. Brain-local memory like `#intel` and `#vision`, never
      serialized — the determinism story is unchanged because overrides and
      observations reach the sim only through commands.
      → `AI_STALL` in `sim/systems/ai.ts`: four integers (pop, built, sites,
      total storehouse stock) every 2000 ticks, window of 8.
- [x] Define `stalled()` as "no scalar moved across the whole window".
      Seed 9 is the calibration case: it must read as stalled by t≈60000.
      → `#windowIsFlat()`. Shortest reportable stall is 14000 ticks, and
      nothing before `graceUntil: 20_000` counts, so seed 9 reads stalled
      well inside the calibration point.
- [x] Expose it on the existing diagnostics seam (`oddsReport()` sets the
      precedent) so the harness can count stalls, not just infer them from
      `undecided`.
      → `stallReport()`.

### 1b. Break the stall

Escalate in order, cheapest and least destructive first. Each step is its
own rule with its own trigger, so a seat takes only the ones it needs.

- [x] **Release hoarded silver** — drop `researchReserve` to 0 while
      stalled. Free, reversible, and the seed 9 trace shows silver 0 with
      research pending is a common terminal state.
- [x] **Ignore the growth gate** — `growthAfter` defers hiring behind a
      tech that a stalled seat may never afford.
- [x] **Re-site a dead extractor.** Planned as the core fix; measured as the
      one that does not pay — see the correction at the end of this phase.
      A production building
      whose anchor resource is exhausted inside its radius should be
      demolished and re-placed against a live deposit, reusing the existing
      `canPlace` / `ANCHOR_RESOURCE` machinery that the build order already
      uses. Check first whether refunds or demolition exist; if not, the
      cheaper version is to place an *additional* extractor and let the dead
      one idle.
      → **Both exist.** `{ kind: 'sellBuilding' }` tears a building down for
      half its cost back, floored per good, and walks the resident out as a
      serf first (`sim/tick.ts`). So the fallback was not needed: the brain
      sells the worked-out hut, the build order's standing-count rule wants
      it back on the next beat, and `spotFor` anchors on `nearestResource`,
      which only counts tiles with amount left. Guarded twice — there must
      be a live deposit to move to, and the shelf must already hold the half
      the refund does not cover, or selling is just losing a building.
- [ ] **Raise the survival floor's ceiling** — when pop is below
      `survivalFloor` and silver is short, prioritise the cheapest path back
      to income over the build order entirely.
      → **Not done, and not obviously needed.** Seeds 44 and 51 decide under
      `--engine none` at both baselines, so this rule has no failing case to
      be measured against. Left for whoever finds one.
- [x] **Verify the escape valve still fires.** `mustersNeeded` already walks
      the attack bar down to `staleFloor: 3` after `staleAfter: 20_000` and
      to 1 after `forlornAfter: 30_000`. Seed 9 sat frozen for 80k ticks
      with armies present, so confirm why no forlorn march ended it — that
      is either a second bug or a mis-set constant.
      → A mis-set constant, but in `sim/path.ts`, not in `AI_PACING`. See
      "What tracing actually found" above. The ramp itself is correct and
      untouched.

**One more rule the plan did not have**, and the one seed 9 actually needed:
**buy a hauler with a post**. A stalled seat with *zero* free serfs empties
the post whose output buffer is already full — a worker standing at a capped
hut is producing nothing, so freeing him costs no production, and it is
self-limiting because the buffer drains and the staffing sweep re-fills the
post once `DISMISS_RESTAFF_BACKOFF` runs out.

### 1c. Prove it

- [x] Extend the bake-off report with a stall count per match in the JSONL,
      beside `undecided`. → `MatchRecord.stalls`, printed under MATCHES.
- [x] Baseline first: re-run `--engine none --seeds 1-80` and record the
      undecided rate before any change.
      → **4 / 160 arms** (seeds 9 and 27), win rate exactly 50.0%. Note the
      plan's headline 18/240 is the **`posture`** engine on the same seeds
      — 18 undecided lines across 240 matches, 16 of them scored arms.
      `--engine none` is a much quieter detector, because advice is what
      pushes seats into the states that stall.
- [x] After each rule, re-run and compare. **Undecided rate is the metric**;
      win rate is the guardrail that must not regress.
      → seeds 1-80, 160 arms each:

      | build | `none` undecided | `posture` undecided | `posture` win rate |
      | --- | --- | --- | --- |
      | baseline | 4 | 16 | 58.3% (84/144) |
      | + the two sim fixes | — | 6 | 61.0% (94/154) |
      | + the stall watchdog | **0** | **3** | **61.1% (96/157)** |

      The pathfinder cap does most of it; the watchdog closes seeds 58, 70
      and 78 on top and opens none. **The win-rate gain is not a result** —
      paired McNemar against the baseline is p = 0.210 (11 toward, 5 away).
      What is claimed is only the guardrail: the rate did not regress. And
      `--engine none` still prints exactly 50.0%, which is the calibration.

      Also worth writing down: the watchdog is nearly always asleep. Under
      `--engine none` it read a stall in 4 of 240 matches and sent 6
      recovery orders in total; under `posture`, 18 matches and 88 orders.
      Every other match is a seat that never reached any of this code.
- [x] Keep `winnable.test.ts` and `aiStrategies.test.ts` green — the
      campaign regression exists for exactly this class of change.

### Correction (2026-08-20): the core fix was the other one

Ablating the two recovery rules individually over seeds 1-80
(`--rules <ids>`, `src/sim/economyRules.ts`) says this phase named the wrong
one:

| rules enabled | undecided | recovery orders |
| --- | --- | --- |
| neither | 2 | 0 |
| `resiteExtractor` only | 2 | 2 |
| `freeCappedHauler` only | **0** | 26 |

Freeing a hand from a post already at its output cap rescues both stalled
matches on its own. Re-siting worked-out extractors fires twice and rescues
nothing.

The evidence for this was in the trace from the beginning and the plan read
past it: seed 9 ends with every extractor at cap, four silver sitting in the
mine, and zero loose serfs — a hauler famine, not resource exhaustion. The
"empty mine, build a new one" framing came from a real player intuition and
it is a reasonable rule; it is simply not what was killing these games.

`resiteExtractor` stays. Its condition wants an exhausted radius AND live
ground to move to AND enough on the shelf to rebuild, which is rare in
eighty seeds, and six stalled matches is too thin a sample to delete a rule
over. Unproven, not disproven.

---

## Phase 2 — adapts to the opponent

Goal: the seat plays differently against a rusher than against a booming
economy, and can be shown to.

**Fix the input before the inference.** The march-gate experiment
(`tools/aiLab/README.md`, "The combat predictor") is the cautionary tale:
better arithmetic over the same blindness measured nothing at all.

### 2a. Better intelligence — done, and it improved the estimate

- [x] Keep a **time series** per rival, not the single `Sighting` snapshot
      `#observeRivals` currently overwrites. Shipped as a roster keyed by
      unit id plus a bounded trend series over it; mean absolute error
      against the truth 3.10 → 2.54, blind samples 13.0% → 5.8%.
- [x] Re-scout on a schedule tied to staleness (`AI_INTEL.refreshAfter`
      already exists and is unused for this). It was worse than unused: one
      straggler in the light reset the clock. Doorstep reads per match
      2.75 → 5.25.
- [x] Record first-contact facts worth branching on: when their first
      soldier appeared, when their first attack landed, how many buildings
      they had at minute five. All three are on the summary; the first one
      turns out to be the enemy's *scout* in every playbook, so it says
      much less than it looks like it should.
- [x] Prove it. The win rate did not follow the estimate: the same posture
      rule scores 58.3% under the old intel and 51.8% under the new,
      paired p = 0.405 — unresolved, certainly not a win.

### 2b. Classify, then counter — done, and it decided nothing

- [x] A cheap archetype classifier over those observables —
      **rusher / booming / turtling**. `src/ai/archetype.ts`, pure over the
      summary, tested against literal objects.
- [x] Make posture selection conditional on archetype in
      `ai/posture.ts` `choosePosture`.
- [x] "They have no army at minute eight, punish now" — as the `pounce`
      stance rather than inside `#counterPlan`, since the march bar is
      posture's business and the forge is the captain's.

### 2c. Prove it — done; the null won

- [x] The honest null is **the same posture rule without the archetype
      input** (`--engine posture`, with the classifier at `--engine posture-reads`).
- [x] 80 seeds, paired McNemar. `posture-reads` 50.7% against `posture`
      51.8%: 0 trials won, 2 lost, **p = 0.50**. The branch is live — it
      changes the stance on one consultation in seven and the two arms end
      in a different world in 41 of 160 trials — and it wins none of them.
      By this file's own standard the classifier is decoration, and the
      reason is upstream: behind fog, `warlord` and `abbot` look far more
      alike than their blurbs do. **Phase 3a (per-seat playbooks) is now
      the blocking change for phase 2 as well** — rusher-vs-boomer has to
      be staged before conditioning on it can be measured.

---

## Phase 3 — comes up with new ideas

The honest framing: a small local model will not invent viable strategies
for this game, because it has no model of these balance numbers. What
produces genuinely novel strategy in game AI is **search**, and this repo is
unusually well set up for it — a fast deterministic headless sim, a harness
that plays 240 matches unattended, and a paired test that separates arms
whose intervals overlap.

**The bake-off is already most of a strategy-discovery engine.** Point it at
generating playbooks instead of grading hand-written ones. The precedent is
already in the tree: the posture ablation found that aggression wins in this
valley and flatly contradicted the intuition that authored the first
cascade (`ai/posture.ts` header). The measurement found the idea, not the
author.

### 3a. Make playbooks searchable

- [x] Give the harness **per-seat playbooks** — `match.ts` handed both seats
      `cfg.strategy`, so playbook-vs-playbook could not be measured at all.
      `--strategy steward:warlord` now seats one each, and an asymmetric run
      plays every seed in **both seatings**, because the advice mirror is
      deaf to which playbook is better. Two nulls, both exactly 50%, and
      they answer different questions — see the README's "Two playbooks, and
      two different nulls".
- [x] Define a mutation space over `AiStrategy`: knob perturbations
      (`tools/aiLab/mutate.ts`), bounded by exactly the advice whitelist, so
      every mutant round-trips through the shipped `parseAdvice` and rides
      the `AiSeats.applyAdvice` seam that already exists.
- [ ] Build-order reordering, the riskier second half of that space — the
      opening encodes hard-won knowledge and deserves its own experiment.
- [ ] A generation loop: mutate → evaluate on the sim → keep winners. The
      primitive is there and tested; nothing drives it yet.

### 3b. The LLM's actual job here

- [ ] Use the model as a **proposal operator, not a decider**: it suggests
      candidate playbooks, the sim judges them, bad proposals cost nothing
      because they are discarded. Novelty tolerates a model that is
      sometimes wrong; strategy does not — which is the whole lesson of the
      posture work.

### 3c. Do not fool yourself

- [ ] **Hold seeds back.** Evolve on 1-40, confirm on 41-80, discard
      anything that does not survive the holdout. This repo has already
      published a 40-seed finding that evaporated at 80.
- [ ] Budget honestly: a 40-seed evaluation is ~7 minutes, so a generation
      of 20 candidates is ~2.5 hours. Overnight work, not interactive.
- [ ] Watch for degenerate winners — a playbook that beats the sim by
      exploiting a bug is a bug report, not a strategy.

---

## Order, and why

1. **Phase 1**, because 7.5% of matches are currently unplayable and it is
   the only phase with a baseline number today.
2. **Phase 2a** (intel) before 2b (inference), because the combat-predictor
   experiment already proved that order matters.
3. **Phase 3a** (per-seat playbooks) can land any time — it is a small
   harness change that unblocks both playbook tuning and search.

## Risks

- **Watchdog rules fight the playbook.** Every phase-1 rule overrides
  authored intent. Keep them stall-triggered only, so an unstalled seat is
  byte-identical to today — the same discipline `marchConfidence: 0` uses.
- **Re-siting buildings touches the sim, not just the brain.** Demolition
  and refunds may not exist; check before designing around them.
- **Search overfits.** See 3c. This is the failure most likely to produce a
  result that looks good and is not.
