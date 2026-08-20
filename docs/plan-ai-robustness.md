# Plan: an AI that never stalls, reads its opponent, and finds its own ideas

Status: phase 2 built and measured (2026-08-20) — the intelligence got
better and the win rate did not move; see 2a-2c below and the two new
sections in `tools/aiLab/README.md`. Phases 1 and 3 are still proposed.

Three phases, deliberately ordered — a seat that freezes cannot adapt, and a
seat that cannot adapt has nothing worth searching for. Phase 1 is the only
one with a baseline number today; phases 2 and 3 get their metrics from
phase 1's instrumentation.

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

### 1a. See the stall

- [ ] Add a rolling progress window to `AiBrain`: sample `pop`, completed
      buildings, and storehouse throughput every N decision beats, keep the
      last K samples. Brain-local memory like `#intel` and `#vision`, never
      serialized — the determinism story is unchanged because overrides and
      observations reach the sim only through commands.
- [ ] Define `stalled()` as "no scalar moved across the whole window".
      Seed 9 is the calibration case: it must read as stalled by t≈60000.
- [ ] Expose it on the existing diagnostics seam (`oddsReport()` sets the
      precedent) so the harness can count stalls, not just infer them from
      `undecided`.

### 1b. Break the stall

Escalate in order, cheapest and least destructive first. Each step is its
own rule with its own trigger, so a seat takes only the ones it needs.

- [ ] **Release hoarded silver** — drop `researchReserve` to 0 while
      stalled. Free, reversible, and the seed 9 trace shows silver 0 with
      research pending is a common terminal state.
- [ ] **Ignore the growth gate** — `growthAfter` defers hiring behind a
      tech that a stalled seat may never afford.
- [ ] **Re-site a dead extractor.** The core fix. A production building
      whose anchor resource is exhausted inside its radius should be
      demolished and re-placed against a live deposit, reusing the existing
      `canPlace` / `ANCHOR_RESOURCE` machinery that the build order already
      uses. Check first whether refunds or demolition exist; if not, the
      cheaper version is to place an *additional* extractor and let the dead
      one idle.
- [ ] **Raise the survival floor's ceiling** — when pop is below
      `survivalFloor` and silver is short, prioritise the cheapest path back
      to income over the build order entirely.
- [ ] **Verify the escape valve still fires.** `mustersNeeded` already walks
      the attack bar down to `staleFloor: 3` after `staleAfter: 20_000` and
      to 1 after `forlornAfter: 30_000`. Seed 9 sat frozen for 80k ticks
      with armies present, so confirm why no forlorn march ended it — that
      is either a second bug or a mis-set constant.

### 1c. Prove it

- [ ] Extend the bake-off report with a stall count per match in the JSONL,
      beside `undecided`.
- [ ] Baseline first: re-run `--engine none --seeds 1-80` and record the
      undecided rate before any change.
- [ ] After each rule, re-run and compare. **Undecided rate is the metric**;
      win rate is the guardrail that must not regress.
- [ ] Keep `winnable.test.ts` and `aiStrategies.test.ts` green — the
      campaign regression exists for exactly this class of change.

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
      input** (`--engine posture-blind`).
- [x] 80 seeds, paired McNemar. `posture` 50.7% against `posture-blind`
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

- [ ] Give the harness **per-seat playbooks** — `match.ts` currently hands
      both seats `cfg.strategy`, so playbook-vs-playbook cannot be measured
      at all. This is the blocking change, and it is small.
- [ ] Define a mutation space over `AiStrategy`: knob perturbations first
      (safe, bounded by `ADVICE_RANGES`), build-order reordering second
      (riskier — the opening encodes hard-won knowledge).
- [ ] A generation loop: mutate → evaluate on the sim → keep winners.

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
