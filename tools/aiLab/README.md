# aiLab — the AI bake-off

Does an advisor over a seat's playbook (`src/ai/`) actually win more games
than the printed playbook alone? This harness exists to answer that with a
number that has error bars, instead of a feeling.

**The model era is over (2026-08-29).** This file's measurements are why:
the browser LLM never beat the free rule reading the same summary
(`posture`, below), so the strategist, its prompt, and the wllama pipeline
were removed from the game. The harness stayed, because the advice seam it
measures through — replies as JSON through `parseAdvice`, applied via
`AiSeats.applyAdvice` — is how every AI change here gets judged, model or
not. The `http` engine went with the model; every recorded model row below
is kept as history. An engine now consults on the seat's summary directly
(`LabEngine.advise(summary)`), which reproduces the old pipeline's matches
digest-for-digest for `none`, `random` and `posture`.

```sh
# 1. calibrate — must print exactly 50.0%
pnpm bakeoff --engine none --seeds 1-12

# 2. the noise floor every advisor has to clear
pnpm bakeoff --engine random --seeds 1-40 --out runs/random.jsonl

# 3. one playbook against another — nobody advised. --no-control because
#    with --engine none a seating's control and its arms are the same match.
pnpm bakeoff --engine none --no-control --strategy steward:warlord --seeds 1-80

pnpm bakeoff --help   # every flag
```

## The balance sweep

A second, much smaller instrument in the same spirit: every playbook alone
on its own campaign map, many seeds, one table. No model, no seating
mirror — just "how often does each playbook take the map, and how fast".

```sh
pnpm balance 32        # 32 seeds
pnpm balance 32 1000   # ...from a different range
```

The second argument is the point. A campaign is about a second to run and
wildly noisy, so a two- or three-win move over 32 seeds means nothing, and
the only way to know is to re-run on a seed range you did not tune against.
Several plausible changes have died exactly there — a fletcher housing tweak
went 24/32 against 22 on one range and 22/32 against 25 on the next, which
is the same as saying it did nothing.

It cuts both ways: a change can also be real and only look like noise on
one range. The fletcher's third roof measured as nothing before the opening
armory moved, and as +2, +1 and +3 across three ranges after — same change,
different world. Re-measure after anything lands under you.

The standing baseline, 64 seeds across two ranges: abbot 59, steward 53,
warlord 51, fletcher 52 with its housing fixed (49 before). Warlord and
fletcher are the deck's thin end now; abbot is comfortably its strongest.

Sweeps run one match per `--jobs` process (`--jobs max` uses the machine);
results are byte-identical to `--jobs 1` for every engine.

## The tier duel

A third instrument, for the one question the other two cannot answer:
**is a difficulty tier actually harder to play against?**

```sh
pnpm balance 32 --difficulty hard   # every playbook at one tier, vs the map
pnpm tiers 12                       # the tiers against each other
pnpm tiers 12 1000                  # ...from a different range
```

The two ask different things, and the difference is the whole reason
`tiers.ts` exists. The balance sweep scores a seat against the ground and
the bandits — "is this seat effective" — and a hard seat marches sooner
with fewer men, which against a bandit camp is a gamble it sometimes
loses. Measured that way (64 seeds across two ranges, 256 campaigns a
tier) the tiers came out **easy 179, normal 204, hard 200**: easy clearly
worst, hard and normal a wash on wins — while the *median winning tick*
ordered perfectly and identically on both ranges, easy ~23.4k, normal
~20.8k, hard ~17.8k. A tier that takes the map six minutes sooner and
dies slightly more often trying is not a weaker opponent to sit across
from; it is a more aggressive one, and win-rate-against-bandits is simply
the wrong instrument for the question.

`pnpm tiers` is the right one: the same playbook on both seats, the tier
as the only asymmetry, every seed played in both seatings so the null
hypothesis is exactly 50% however lopsided the valley's two starts are —
the same cancellation the bake-off uses for advice. Bandits off, because a
neutral third party that kills one seat turns a duel into a coin toss the
mirror cannot cancel. A Wilson 95% interval straddling 50% is not a
result, exactly as above.

### Read the pair tally before the percentage

The mirror makes the null exactly 50%. What it does NOT do is let a win
rate reach 100%, and that is worth understanding before anyone tries to
tune toward one.

Some seeds deal two starts so unequal that whoever holds the better one
wins **both** seatings, whatever tier is sitting in it. Such a seed
contributes exactly one win and one loss to the rate — forever, at any
tier strength. So the sweep pairs the two seatings of each seed and
classifies them (`PairTally` in tiers.ts):

- **swept** — the tier won both seatings. It beat the valley.
- **split** — the same SEAT won both. The valley decided; the tier was not
  the variable.
- **lost** — the weaker tier won both. A genuine loss, and the only kind
  worth tuning against.

`lost = 0` is the honest reading of "it always wins", and hard against easy
now has it: **zero lost valleys in 192 seed-and-playbook pairs** across
both ranges, against a raw rate of 86%. All of the missing 14% is ground
the map had already decided, and chasing it with knobs is chasing the map
generator.

That claim was withdrawn once before believing it a second time, which is
worth knowing. At twelve seeds a range the tally read a clean zero across
96 pairs; twenty-four turned up a real loss (the Abbot, seed 1098). It is
zero again at the deeper count — but "zero so far" and "zero" are
different claims, and the difference is the depth. Quote the depth.

And do not read the last two off micro. The count went from two to zero
when micro landed, which is TWO EVENTS out of 192 pairs, and the win rate
across the same pairing moved by a single duel in 384. That is not a
result, it is the same small-sample trap this file warns about wearing a
different hat. Micro's honest record is below: it cost three points, the
archer restriction bought them back, and the net is nothing measurable.

The standing baseline, 24 seeds on each of two ranges — four playbooks,
both seatings, so 192 duels a pairing per range:

```
                 range 101                      range 1000
normal v easy    187/192  97.4%  [94.0, 98.9]   175/192  91.1%  [86.3, 94.4]
hard   v easy    181/192  94.3%  [90.0, 96.8]   165/192  85.9%  [80.3, 90.2]
hard   v normal  106/182  58.2%  [51.0, 65.2]   100/187  53.5%  [46.3, 60.5]

pooled: normal v easy   362/384  94.3%  [91.5, 96.2]
        hard   v easy   346/384  90.1%  [86.7, 92.7]
        hard   v normal 206/369  55.8%  [50.7, 60.8]
```

Measured on the build where soldiers take up room (replay 41). The same
sweeps on the main it merged read, pooled, normal-v-easy 359/384 (93.5%),
hard-v-easy 351/383 (91.6%) and hard-v-normal 216/369 (58.5%, [53.4,
63.5]): the two easy pairings are unmoved, and hard-against-normal reads
about three points lower — inside both intervals, so not a result, but
the direction to expect from a change that makes every fight a ring and
every standing rank a wall, since those level the field for whoever has
fewer men. (The easy pairings had already climbed from the 82% and 86%
an earlier build printed here before silver learned to go home first.)

Monotone, and the pooled figures clear of the 50% null — but read the
third row before trusting it. The two ranges give hard-against-normal
58.2% and 53.5%, the second on its own straddles the null, and earlier
builds spread as wide as 64.3% against 57.3% on the pairing that matters
most. The pooled figure is the number to quote; a single range on that
row is not.

Read the two easy pairings with the section above in mind: 90% is not
where hard ran out of strength, it is where the map generator ran out of
fair valleys — 11 to 25 of the 96 pairs decide themselves. Genuine losses
to easy are zero on range 101 and one on range 1000 (the abbot's, on main
too).

Hard against normal is the honest weak spot, and per playbook it is weaker
still. Pooled over both ranges, with intervals, only one of the four lords
is established as ahead of normal at all:

```
warlord   62/96  64.6%  [54.6, 73.4]  WINS
steward   53/96  55.2%  [45.3, 64.8]  no result
abbot     45/86  52.3%  [41.9, 62.6]  no result
fletcher  46/91  50.5%  [40.5, 60.6]  no result
```

Resist the story that wants telling here — this table has already told a
false one. On range 101 alone an earlier build read steward 52% and warlord
77%, which invites "hard sharpens an already aggressive lord and cannot
help a cautious one", and range 1000 reversed the pair (steward 60%,
warlord 65%). Forty-eight duels a cell cannot rank four playbooks.

Pooled at 96 duels a lord it is now only one interval that clears the
null; an earlier build had two, with the Abbot's since drifted down into
it. Read the rank order as
unsettled: the honest summary is that hard's edge over normal is real in
aggregate, uneven across the deck, and not established at all for half of
it. Anything more specific needs more seeds than anyone has spent.

Two lessons, both bought the expensive way.

**Measure before you tune, and on both ranges before you believe.** At 96
duels hard-versus-normal read 53/95, 55.8%, [45.8, 65.4] — "no result" —
and it would have been easy to read that as a weak tier. It was not weak,
it was under-measured. Three candidate strengthenings tried at that sample
(forcing `retreats: false`, a wider village, a faster clock for hard) all
came in at or below the printed table, which is exactly what noise looks
like.

The trap does not stop at the pooled number. Every claim on this page that
was later withdrawn — a clean zero on the pair tally, a four-point gain
from the intel and stance levers, a per-playbook ranking — was true on one
range and false on the other. One range is a hypothesis. Two is a result.
The cost of forgetting that is not a wrong number, it is a design argument
built on top of one.

**A capability can cost as easily as it pays, and the shape matters more
than the idea.** Micro — focus fire and pulling the wounded out — is the
one capability difference in the tier table, and its first cut measured at
57.7% against `normal` where no micro at all measures 60.8%, worse on both
ranges. It focused every soldier, melee included, and a spearman told to
attack somebody other than the man in front of him leaves that fight to
walk. Restricted to archers picking among what they can already hit — a
bow chooses its target without moving, which is what makes the choice free
— it recovers to 59.6% [54.5, 64.5] — statistically level with leaving it
off (60.8%). Same idea, three lines of restriction, three points of
difference, and a net of zero.

It ships anyway, under the rule warBehaviorIdEnum states for its own
verbs: a behavior whose payoff is drama rather than win rate still owes
proof that it does not COST a rate. Micro owes that proof precisely
because the first cut failed it, and the archers-only cut pays it. Archers
picking the wounded man out of a line is legible — a player can see it and
read the opponent as paying attention — which is the same ground
`heraldMarch` and `scoutFlees` stand on. What it is NOT is an edge, and
the lost-valley count is not evidence of one.

**The knobs have a ceiling, and it is not at the end of their range.** A
deliberate ceiling test — every hard knob pushed to its clamp at once,
mustering at three, a quarter of the cooldown, twice the village, thinking
twice as often — scored **48/92, 52.2%**, BELOW the gentle table, and
dragged the Warlord to 29%. These knobs tune a line that was already
tuned; past a point they detune it. Getting hard meaningfully past 60%
against normal is not a bigger number in the table. It needs either a
capability normal lacks (reading the rival's arms and training the
counter, say) or the resource handout the tier table exists to avoid.

One more guard worth keeping: a tier has to stay a PLAYER, not just a
loser. `pnpm balance 16 101 --difficulty easy` puts an easy seat alone on a
campaign map against the bandits, and it still takes 29 of 64 — weakened,
not broken. A tier that could not win a map at all would score beautifully
in the duel and be no fun to meet.

The ordering is also pinned in the suite (`tools/aiLab/tiers.test.ts`), on a
small fixed seed set, so a change that inverts it fails CI rather than
waiting for someone to re-run a sweep. That test is a *regression pin*, not
a second measurement: the sim is deterministic, so its duels have one
answer, and the numbers to argue from are the ones above.

## The experiment

Per seed, up to three headless matches on one valley, both seats running the
same playbook so advice is the only asymmetry:

- **control** — neither seat advised
- **arm A** — seat 0 advised
- **arm B** — seat 1 advised

The mirrored pair makes the null hypothesis exactly 50% regardless of how
lopsided the map's two starts are: whichever seat the valley favors wears
the advice in half the trials and plays control in the other half. The
report scores the advised side's win rate against that bar, with a Wilson
95% interval, and refuses to call an interval that straddles 50% a result.

Matches run the real advice path — `parseAdvice`, standing-pile merge,
`AiSeats.applyAdvice` — with only the advisor behind `LabEngine.advise`
swapped, so what is measured is what a seat can actually be told. (Until
2026-08-29 the same path ran through the shipped `LlmStrategist`; the
consult semantics — merge over a standing pile, a repeat costs no message —
were kept verbatim when it was removed, verified digest-for-digest.)
Undecided matches are reported and excluded, never awarded. Crashed trials
are printed next to the rate.

## Two playbooks, and two different nulls

`--strategy steward:warlord` seats a different playbook on each side. That
is the whole question of "is this playbook better than that one", and
answering it needs care, because the harness now has two nulls and they are
not the same one.

**The advised win rate is unaffected.** Its mirror is over *which seat wears
the advice*, and that argument never mentioned what the seats are playing.
Advise each seat in turn and, under the null, the advised side takes exactly
one of the two arms — so the bar stays exactly 50%, and `--engine none
--strategy steward:warlord` still calibrates to 50.0% with zero flips, just
as the symmetric run does. What changes is the *meaning*: the rate now pools
advice given to the steward with advice given to the warlord, two different
treatments averaged, and the per-seat split is two questions rather than two
halves of one. The report says so where the number is printed.

**The playbook question needs its own mirror.** "Which playbook won more
matches" is not nulled at 50% by anything — the valley's two starts are not
equal (seat 1 took 65% of seeds over 24 stock seeds) so a steward that sat
in seat 0 all sweep would bank the map's head start and report it as
strategy. The fix is the same trick one level up: **play every seed in both
seatings** and score the steward across the pair. Under "these two are
equally good" it takes exactly one of its two seatings whatever the map
does. So a run whose two playbooks differ plays each seed twice more, and
the report grows a `PLAYBOOK MATCHUP` section:

- scored on the **unadvised matches only** — one per (seed, seating), never
  a seating's control *and* its arms, which under `--engine none` are the
  identical match and would treble the sample without adding an
  observation. "Playbook A with a model behind it beats B" is a third
  question and is not folded in.
- the pooled rate is printed with its Wilson interval **flagged as
  optimistic**: the two seatings of a seed share a valley, so 2N trials are
  not 2N independent draws. Read it for effect size.
- the verdict comes off a **seed-level exact binomial**. A seed where each
  playbook took its own seating is the map talking and carries no evidence,
  exactly as a concordant pair carries none in McNemar's test; the decisive
  seeds are the ones one playbook took from both chairs. This assumes
  nothing about the map, which is why it is what the verdict reads.
- the seat split is printed beside it, so the bias the mirror is cancelling
  is visible rather than asserted.

There is no `bakeoff:compare` step for a playbook matchup: the pairing is
*inside* the run (a seed's two seatings), not across two runs.
`bakeoff:compare` remains the tool for two engines over the same seeds.

## What to know before believing a number

- **Sample size.** A ±5-point read on the win rate needs ~385 trials
  (~193 seeds). Forty seeds (80 trials) resolves about ±11 points. The
  verdict line prints what your run can and cannot see.
- **Latency.** By default advice lands instantly (`--latency 0`), which is
  what every recorded run used. The model era priced its tens of seconds of
  CPU inference back in with this flag; a rule engine answers for free, so
  0 is honest now — the flag stays for any advisor that would not be.
- **Advice can be structurally inert.** Most economy knobs sit behind the
  playbook's `growthAfter` research and the war knobs behind a mustered
  army, so advice to a seat that never gets that far changes nothing — on
  some seeds one seat dies before its knobs ever gate a decision. That is
  a fact about the game, not a bug in the harness; the mirrored arms
  average it out.

## Engines

| spec | what it is |
| --- | --- |
| `none` | no advisor — calibration; must score exactly 50% |
| `random[:seed]` | valid advice by dice — the noise floor; an advisor must beat this, not just 50% |
| `posture` | the stances picked by rule — the reference every recorded number was measured under, and the test bench for candidate stance rules |
| `rules` (flag, not an engine) | `--rules <ids>` narrows which economy rules the seats run; `--rules none` turns the layer off entirely |
| `posture-reads` | the same rule conditioned on an opponent archetype. Measured against `posture` and it does not pay (p = 0.50), so it is the experiment, not the reference |
| `posture:<id>` | one stance held all match (`posture:siege`) — ablation, and it says what each stance is worth alone |
| `script:{...}` | one fixed reply forever — plumbing checks, personality experiments |
| `stances` (flag, not an engine) | `--stances off` pins every seat to its printed playbook — the pre-stance-engine null (see below) |

(`http://…/v1` — any OpenAI-compatible server — was an engine until
2026-08-29 and produced every model row below; it left with the model.)

## The stance engine, and what the nulls mean now (2026-08-29)

The measured lesson of every sweep below — aggression ends games, and a
found rival should be marched on — now ships inside the brain instead of
riding as advice: each playbook carries a stance cascade
(`AiStrategy.stances`, knob tables in `src/sim/defs/aiPostures.ts`) and the
brain switches moods as the match turns (`#updateStance` in
`src/sim/systems/ai.ts`). Three things change about reading this file:

- **`--engine none` is still THE calibration null** — the mirror pins it at
  exactly 50.0% whatever the brains do, because both seats run identical
  brains. Its *meaning* moved: "unadvised" now includes the seat's own
  stance engine. The pre-stance game is `--stances off`, and the engine's
  worth is the paired comparison between the two.
- **`--engine posture` is the test bench, not the shipped brain.** It
  overrides a seat's knobs wholesale on the advice cadence, stance engine
  underneath. Write a candidate cascade as a `choosePosture` variant, run
  it here, and only a paired win earns it a place in the playbook data.
- **Every recorded row below predates the stance engine** — measured
  against printed playbooks, i.e. today's `--stances off`. They stay as
  history; re-measure before comparing anything new against them.

### What the engine and the war verbs measured (2026-08-29, map 96, seeds 1-80)

Every layer of the fun-and-realism arc was gated the same way: calibration
must stay exactly 50.0%, undecided must not rise, the campaign sweep must
not regress on any of three ranges (101 / 1000 / 5000, the last never tuned
against), and the layer's own off-switch must reproduce the layer-less game
so the comparison is paired, not remembered.

| layer | flips winner (of 160 paired) | undecided | campaign (384 games) |
| --- | --- | --- | --- |
| stance engine (`--stances off` as null) | 44 (22 each way, p = 1.00) | 0 → 0 | +2 / −2 / ±0 |
| war behaviors (`--war none` as null) | 22 (11 each way, p = 1.00) | 0 → 0 | ±0 / ±0 / −1 |
| the herald's march-hold (all-but-`heraldMarch` as null) | 20 (10 each way, p = 1.00) | 0 → 0 | ±0 (range 101) |

Read the flips column the way the archetype experiment's "the branch is
live" check was read: both seats carry every layer, so the mirror pins the
advised rate at 50% by construction and strength is not what these sweeps
can see — what they establish is that the layers genuinely change games
(a quarter of them, for the stances) at zero cost to the guardrails. The
`--stances off` arm also reproduced the pre-stance tree digest-for-digest
(240/240), which is what makes it a null rather than a hope.

**The fingerprints are the point** (`war` per seat in every JSONL line;
first matchup sweep, seeds 1-24 both seatings, six pairings): the abbot
sortied 0.00 times a match and retreated its losing pushes; the fletcher
sortied 9.37 times and never retreated; the steward probed at 3.57 with
the deck's best strike rate; the warlord marched three minutes before
anyone (median 13345 against the abbot's 16825), wore 0.9 moods a match
against everyone else's 5-7, and mostly struck unannounced — pounce
musters at five, under the herald's minimum of six, so the rusher gives
less warning and the abbot's twelve-strong push always announces. Four
playbooks, four different games, visible through a rival's own fog — the
`archetypePersonality` test pins the direction of that read in CI.

That first sweep also raised two alarms, and running the SAME pairings on
the pre-arc tree (a worktree at the arc's base commit, same seeds) is what
told the inherited from the introduced. The fletcher beating the steward
about 3-to-1 turned out to be the deck as the arc found it — 25% pooled
for the steward at the base commit, 26% after the arc — a balance drift
that predates this work and is not of it. The abbot-fletcher standoff is
also ancient (the fletcher-cannot-crack-walls class this file has recorded
since the playbook shipped), and there the arc is a repair: 20 of 96
matches undecided at the base commit, 10 after — aggression ends games,
again. The two corrections the sweep prompted stay on their own numbers
(sorties stand down once the impatience ramp is walking the muster bar;
the fletcher's harass clock eased 500 → 900, cutting the arc's own first
cut from 14 undecided to 10): harassment is an opening behavior now in
fact as well as spirit.

## Measurements (2026-08-18, map 96, bandits on, `steward` both seats)

### The baselines

- **`none`** scored **exactly 50.0%** at both 8 and 24 seeds, with zero
  flips — the calibration holds. The 24-seed run also measured the valley
  itself: seat 1 won 65% of seeds, which is the map bias the mirroring
  exists to cancel.
- **`random`** scored **46.7%** (24 seeds), **46.6%** (seeds 1-40) and
  **47.0%** (seeds 1-80) — three independent reads on one number, which
  is the best evidence the harness is stable. Random knob-turning flips
  about a quarter of matches while helping nobody on net. That is the
  floor: a model earns its download by beating *this*, not 50% alone.

### Authoring knobs does not work at this size

The original prompt asked the model to emit knob values. Seeds 1-40:

| engine | advised win rate | 95% CI | |
| --- | --- | --- | --- |
| `qwen2.5-0.5b` | **33.8%** (26/77) | [24.2%, 44.9%] | below the floor — advice HURTS |
| `lfm2.5-350m` | 50.0% (38/76) | [39.0%, 61.0%] | measured nothing at all |

Qwen flipped matches *away* from the advised seat 13 times against 2
toward. Lfm's 50.0% is not a tie: all 80 of its advised matches ended on
the identical winner and identical tick count as their controls, because
across 862 consultations it emitted two distinct strings — one of them
the playbook's own `trainPreference` restated. Read the flip counts, not
the win rate: "50.0% with zero flips" and "50.0% with balanced flips"
print the same headline and mean completely different things.

### Choosing a posture does

Same models, same seeds, same pipeline — only the ask changed, from
authoring eleven numbers to naming one of five stances (`src/ai/posture.ts`).

| engine | advised win rate | 95% CI | vs `random`, paired |
| --- | --- | --- | --- |
| `posture:siege` (constant) | **68.4%** (52/76) | [57.3%, 77.8%] | **p = 0.0015** |
| `http` lfm2.5-350m | **63.4%** (45/71) | [51.8%, 73.6%] | **p = 0.0225** |
| `posture:muster` (constant) | 60.8% (45/74) | [49.4%, 71.1%] | — |
| `posture` (rule, seeds 1-40) | 60.0% (45/75) | [48.7%, 70.3%] | p = 0.21 |
| `posture` (rule, seeds 1-80) | 58.3% (84/144) | [50.2%, 66.1%] | p = 0.080 |
| `posture:expand` (constant) | 50.0% (39/78) | [39.2%, 60.8%] | — |
| `random` (seeds 1-80) | 47.0% (70/149) | [39.1%, 55.0%] | — |

The same 350M model that measured nothing as a knob-author clears both
the 50% null and the noise floor as a stance-picker. Nothing about the
weights changed; the task did.

### What the sweeps taught about the valley

- **Aggression wins here.** `siege` and `muster` are the two strongest
  stances and are not separable from each other (p = 0.38), while both
  beat `expand` (siege vs expand, p = 0.0024). Matches resolve in about
  eleven minutes, so an economy stance spends the deciding window paying
  for growth that never gets to fight. The printed `steward` line is too
  passive: `prefersRivals: false` sends the army to bandit camps, and
  `armyAttackSize: 7` on a 900-tick cooldown commits too little too late.
- **A rule can lose to its own best constant.** The first `choosePosture`
  draft — grow while small, raid while nothing is found, siege once
  strong — scored 51.3% and did not beat `random` at all (p = 0.63),
  while the `siege` constant it could have chosen scored 68.4%. Retuning
  the cascade toward the aggressive end took it to 58.3% at 80 seeds,
  the whole interval above 50%. Intuition about which situation "calls
  for" economy was simply wrong, and only the ablation showed it.
- **The model does not pick the best stance.** Over 1300 consultations
  lfm chose `muster` 47%, `fortify` 40%, `expand` 13% — and `siege`,
  the strongest stance, never once. Its score tracks `muster`, which is
  roughly what a muster-heavy mix should score. Whatever it is reading,
  it is not finding the aggressive end of the menu; prompt ordering and
  the wording of each `when` line are the obvious things to try next.

### The undecided matches were mostly a pathfinding bug

The harness's `undecided` count is the one number here that is a bug
report rather than an estimate, and chasing it (`docs/plan-ai-robustness.md`
phase 1) found the AI was not at fault for most of it.

Seed 9 freezes with both seats holding full extractor huts, one of them
sitting on four silver — a hire's worth — and **zero free serfs** to carry
it to the storehouse, which is the only way anything gets bought. Meanwhile
the impatience ramp was doing its job perfectly: `mustersNeeded` walked the
bar to one soldier and each seat duly ordered its last knight at the enemy
castle. The order was then dropped by `findPathToAdjacent`, because the A*
runaway-search cap was `(play * play) >> 1` = 4608 expansions against a
walkable component of **5016 tiles** — a cap whose only job is bounding an
*unreachable* search, sized below what a reachable one has to cross. Every
long march on a 96 map was silently discarded.

Seeds 1-80, 160 arms, `steward` both seats:

| build | `none` undecided | `posture` undecided | `posture` win rate |
| --- | --- | --- | --- |
| before | 4 | 16 | 58.3% (84/144) |
| + the pathfinder cap (and the `unbindWorker` leak) | — | 6 | 61.0% (94/154) |
| + the AI's stall watchdog | **0** | **3** | **61.1% (96/157)** |

**The win rate is not the finding.** Paired McNemar over the same seeds is
p = 0.210 — eleven toward, five away, which is a coin flip. The claim is
the undecided count, which is a direct observation on named matches, plus
the guardrail that the rate did not regress and `--engine none` still
prints exactly 50.0%.

Two things this changes about reading older rows in this file: every arm
above was measured with long marches silently failing, so the aggressive
stances were being scored on marches that partly never happened. And a
`posture` row's `undecided` was ten matches of pathfinding bug.

### The combat predictor, and a negative result worth keeping

`src/sim/combatOdds.ts` predicts an engagement before the army commits to
it, gated by the `marchConfidence` knob (0 in every playbook — off). It is
the one experiment here that failed, and how it failed is the useful part.

At 40 seeds `marchConfidence: 30` looked like a win: **55.8%** (43/77),
flips 8 toward the advised seat against 3 away, beating the noise floor at
p = 0.049. Doubling the sample erased all of it:

| arm | 40 seeds | 80 seeds |
| --- | --- | --- |
| `marchConfidence: 30` | 55.8%, flips 8/3 | **51.6%** (81/157), flips 14/11 |
| ...vs `random`, paired | p = 0.049 | **p = 0.121** |
| ...vs the `posture` rule | — | p = 0.473 |
| ...vs a lowered muster bar | p = 0.0074 | **p = 0.061** |

Nothing survives. The 40-seed reading was exactly the ±11pp resolution
this file warns about, arrived at by someone who knew that and read the
number anyway. **Two arms at 40 seeds are not evidence; the paired test on
the same seeds at 80 is.**

Two findings came out of it regardless:

- **Blind early aggression loses, and that replicates.** A muster bar
  dropped to `armyAttackSize: 4` scores 43.4% at 80 seeds (41.6% at 40),
  flips 12 toward and 20 away — well under the floor. Marching sooner is
  worth something only if something knows when, which is why the gate was
  worth trying and why the dumb control was the right null for it.
- **The estimate is the bottleneck, not the model.** The gate's first cut
  was a brake and it never fired: instrumenting it (`AiBrain.oddsReport()`)
  showed no threshold below a 3x bar vetoed anything, because the brain
  already only marches when it heavily outnumbers *what it has seen*. A
  seat marches believing the enemy has three soldiers because three is all
  one lone scout ever lit. Better arithmetic over the same blindness buys
  nothing; the next work is intelligence.

### Intelligence, and what fixing the input was worth

*(2026-08-20, same map, bandits and seeds. These ran on the build that has
the roster intel, so their win rates are comparable to the ones above only
where a paired test says so — which is why every claim below is paired.)*

The predictor's negative result ended on "the next work is intelligence",
so intelligence is what came next: the per-rival picture stopped being one
snapshot and became a roster of the soldiers actually seen, keyed by unit
id, with a bounded trend series over it and the first-contact facts hung
off it (`src/sim/systems/ai.ts`). The estimate improved and the win rate
did not follow.

**The estimate.** Scored against the truth every 500 ticks over twelve
unadvised matches — both estimators computed on the *same* trajectories, so
this is not two different games being compared — against a real army
averaging 4.94 soldiers:

| estimator | believes | mean abs error | blind |
| --- | --- | --- | --- |
| the old single snapshot | 1.97 | 3.10 | 13.0% |
| the roster | 2.56 | 2.86 | 10.7% |
| the roster's peak over the trust window | **3.00** | **2.54** | **6.3%** |

Two smaller findings fell out of building it. Striking the fallen off the
roster — the obviously honest rule — reads the valley *worse* (error 3.43,
blind 34%), because the barracks refills faster than the trust window
closes. And `AI_INTEL.refreshAfter` was all but dead: a single rival
straggler wandering into the light reset the re-scout clock as though the
yard had been read, so a harassed seat never looked at what was massing
behind it. Requiring a real force to count doubled doorstep reads, 2.75 to
5.25 per match.

**The win rate.** Nothing. The same posture rule, on the same eighty seeds,
under the old intel and the new:

| arm | advised win rate | flips | undecided |
| --- | --- | --- | --- |
| old snapshot intel | 58.3% (84/144) | 25 / 16 | 16 / 240 |
| roster intel | 51.8% (73/141) | 16 / 15 | 19 / 240 |
| ...paired McNemar | 14 won, 9 lost, **p = 0.405** | | |

Read that as unresolved rather than as a loss — 6.5pp is inside the ±8pp
this sample can see, and the paired test is the one that matters. But it is
certainly not a win, and the honest summary is that a materially better
estimate of the enemy's strength bought nothing measurable, because almost
nothing in the brain is gated on that estimate: `marchConfidence` is 0 in
every playbook, and the posture cascade never looked at enemy army size at
all.

### Classifying the opponent, and the null that beat it

So the next step made a posture rule that *does* look: a rusher / booming /
turtling classifier over the intel series (`src/ai/archetype.ts`), and a
`choosePosture` conditioned on it — pounce on a rival that has shown no
army, and stop breaking a siege for a lone raider who is not the opponent
in force. The honest null is the identical cascade with the classifier
deleted, which is what `--engine posture` is:

| arm | advised win rate | 95% CI |
| --- | --- | --- |
| `posture` (opponent ignored) | 51.8% (73/141) | [43.6%, 59.9%] |
| `posture-reads` (opponent read) | 50.7% (73/144) | [42.6%, 58.7%] |
| ...paired McNemar | 0 won, 2 lost, **p = 0.50** | |

**Conditioning on the opponent decided nothing.** And the diagnostics say
that is a real null rather than dead code: the branch changes the stance on
about one consultation in seven, the two arms end in a materially different
world in 41 of 160 paired trials, and the winner differs in five of them —
it just does not win them.

The one arm on this build that looks like anything is the new stance held
constant — `pounce` is `siege` with the muster bar dropped from twelve to
five, which is the aggression the whole cascade keeps re-discovering:

| arm (80 seeds, this build) | advised win rate | undecided |
| --- | --- | --- |
| `posture:pounce` (constant) | 56.6% (86/152), flips 25 / 17 | **8 / 240** |
| `posture` (rule) | 51.8% (73/141), flips 16 / 15 | 19 / 240 |
| `posture-reads` (rule, reads the opponent) | 50.7% (73/144), flips 14 / 16 | 16 / 240 |

Paired, `pounce` beats neither rule at this sample (vs blind p = 0.324, vs
the archetype rule p = 0.143), so treat the win rate as unresolved — but
the undecided column is not a coin flip. A seat that marches at five ends
its matches: 8 of 240 against 19. **A rule losing to its own best constant
is now the third time this file has recorded that pattern**, and the
constant is aggressive every time.

Why the classifier fails is more useful than that it failed. It does track
the opponent — over twelve seeds per playbook it reads `warlord` as a
rusher six times as often as `abbot`, and `abbot` as booming four times as
often as `warlord` — but half of every read is `unknown`, and the margins
are single-digit percentages. Behind fog, three playbooks whose blurbs
promise completely different games look much alike: every one of them walks
a lone scout past your castle around minute four, and none of them brings a
force to your gates before the match is nearly decided. **The seat cannot
branch on a difference the valley never shows it.** The next thing to fix
is upstream of the classifier again: per-seat playbooks in the harness
(plan 3a) so rusher-vs-boomer can be *staged* rather than hoped for, and
scouting that reads a rival's economy rather than only its soldiers.

Resolution: 40 seeds is ±11pp, 80 seeds ±8pp, and ±5pp would need ~193
seeds. Treat single-run gaps under ~10pp as unresolved and reach for
`bakeoff:compare` — the paired test separates runs these intervals
cannot.

### The economy rules, and which one earned the result

The economy is a rule table (`src/sim/economyRules.ts`) rather than another
priority cascade — independent rules that all fire in a beat, with claims so
two never order the same building and groups so genuine alternatives stay
first-wins. `--rules <ids>` runs any subset, which is the whole point: a
rule that pays and a rule that merely fires produce the same win rate.

Seeds 1-80, `--engine none`. Both seats get the same rules, so the advised
rate is pinned at exactly 50.0% by construction — **the metric here is
playability, not strength**:

| rules enabled | undecided | longest match | recovery orders |
| --- | --- | --- | --- |
| production only (no recovery) | 2 | 120000 (the horizon) | 0 |
| `resiteExtractor` only | 2 | 120000 | 2 |
| `freeCappedHauler` only | **0** | 72986 | 26 |
| all four | **0** | 71216 | 30 |

Identical stall *detection* in every row — six matches, same watchdog. What
differs is whether anything rescues them.

**`freeCappedHauler` carries the whole result.** Alone it fires 26 of the 30
orders and takes the sweep to zero undecided; `resiteExtractor` alone fires
twice and rescues nothing. The binding constraint on a stalled village was
never dead ground, it was having no hand free to carry anything — which is
what the seed 9 trace said all along (every extractor at cap, four silver in
the mine, zero loose serfs) and what the planning got backwards by calling
re-siting the core fix.

Two cautions on the size of this. Two matches out of 240 is a small effect,
and six stalls is a thin sample to attribute anything to — `resiteExtractor`
is unproven rather than useless, since its condition (exhausted radius AND
live ground to move to AND enough on the shelf to rebuild) is simply rare.
And an earlier version of this measurement was thrown away: those sweeps ran
while the source was being edited, and the harness spawns a process per match
that reads the files at spawn time. The clean re-run differed by two recovery
orders, which is exactly how a retracted finding starts.

**Update (2026-08-23): the table above measures a gate that has since
moved.** `freeCappedHauler` no longer waits on the stall watchdog, and it
frees hands up to the playbook's `survivalFloor` rather than only at zero —
a played replay turned up three seats that reached the dead end and none
that lived the fourteen thousand flat ticks a `stalled` reading costs. A new
rule, `handsBeforeSoldiers`, stands the barracks down over the same line, so
a hand the seat hires is not spent on a recruit. The instrument that shows
it is `pnpm balance` rather than this one, because the failure is a raid
taking the hands and this sweep's undecided count was already zero: 460/640
campaign wins before, 491/640 after, positive on all five seed ranges —
though see the caveat below, because that floor moved before the change
landed. The
guardrail here is unchanged at 0 undecided and a flat median, at 368
recovery orders against **0** on the same 48 matches — not the 30 in the
table above, which is a different sweep (seeds 1-80). Zero is the finding
restated: on seeds 1-24 the watchdog never once read a stall, so every rule
it gated was unreachable for the whole sweep.

**And the floor moved under it, which is this page's own warning coming
true.** Merging main brought the spear work — a spearman who could not be
armed — which rescues seats from the other end of the same failure. Re-run
on the merged tree the pair reads 493/640 and 504/640: the baseline gained
33 on its own and the hand-shortage fix is left with **+11 over 640, three
ranges up and two down**, which is inside what this instrument can resolve
and therefore not a result. It stands as a guardrail (no regression) rather
than as evidence, and the case for the change rests on the replay it was
cut from. Full write-up in `docs/plan-ai-robustness.md`.

**Update (2026-09-01): `resiteExtractor` lost both of its gates, and the
row above no longer describes it.** A played replay (seed 63759505) has a
seat work both its groves flat at t=14000 and never cut another log: the
match ended at 18617, inside `AI_STALL.graceUntil`, so the watchdog the
rule waited on had not so much as opened its window — and the rule's other
condition, "the shelf already holds the half the refund will not cover", is
a deadlock in the one case it most matters, since the reason the shelf is
empty is the hut standing on bare ground. It now reads its own condition,
which is a cleared radius, and the map says that is permanent
(`depleteResourceTile` writes the tile to `None`; `regrow` only bumps tiles
that are still wood). So the "2 firings, 0 rescues" row measured a rule
that could barely fire, not a rule that does not work.

The same replay is where the seats stopped freezing a scout mid-map: a
search goal taken on a stale rival's behalf was retired the beat it was
taken, so the guard that writes off a walk the sim keeps dropping ("ordered
again while standing still") never had two identical orders to compare. In
that replay **215 of the seats' 290 unit-move orders were no-ops at one
motionless soldier**; after the fix, 2 of 41. The fingerprint says the same
thing at sweep scale: `fled` per seat falls from 14.66 to 0.63, because a
"flight" used to be re-issued at the same wounded man every beat.

Guardrails, all three `pnpm balance` ranges (baseline vs both fixes):
101 → 94/128 vs 93/128, 1000 → 110/128 vs 104/128, 2000 (64 seeds) →
199/256 vs 208/256. Pooled 403/512 against 405/512 — flat, and the ranges
disagree in sign, which is this page's own definition of noise. The
mirrored sweep (`--engine none --seeds 1-40`) holds 0 undecided on both
sides; the median match lengthens 17257 → 18569 ticks, which is what a seat
that no longer parks a soldier or runs out of wood looks like from outside.

**The build order's reserve, and the version of it that was measured and
thrown away.** A seat that has just sold a worked-out woodcutter holds the
scrap that was meant to raise its replacement — and every playbook prices
its well at 4 wood against the cutter's 6, seventh on a list the cutter
leads, so the build order's "first step that is affordable AND placeable"
spent it one rung down. The fix holds the shelf for the first unmet
*gatherer* the seat cannot yet pay for, when there is ground to put it on.

The first draft held for the first unmet step of ANY kind, which is the
tidier statement of "a priority list is a priority list" and is not what
the plans were tuned as. Measured over the same three ranges it scores
**405/512 against 405/512** — dead flat, +8 on one range and −8 on another
— while visibly shrinking the villages it did not help: the abbot goes from
20.1 heads to 17.3 and 8.5 soldiers to 7.4, because a seat saving for a
twelve-stone guard tower stops laying the farms and wells below it. It also
put `tiers.test.ts`'s hard-vs-normal non-inferiority at 6/13.

Narrowed to gatherers it is nearly a no-op outside the case it was written
for: 92/128, 107/128, 207/256 (pooled **406/512**), with steward, warlord
and fletcher scoring bit-identically to the run before it on two of the
three ranges — the reserve simply never binds for them there. 0 undecided
and an unchanged median and longest match on the mirrored sweep. The
producer half of the leapfrog is the bug; the rest of it is the game.


## Playbook against playbook (2026-08-20, map 96, bandits on, seeds 1-80)

The first sweeps the seating mirror made possible. Treat these as a
demonstration of the capability, not a finding about the deck — nothing
here separates from the null.

| matchup | steward, pooled | on seat 0 | on seat 1 | seat swing | seeds one took both | exact p |
| --- | --- | --- | --- | --- | --- | --- |
| vs `warlord` | 47.7% (74/155) | 54.5% | 41.0% | 13.5pp | 13 v 16, 47 split | 0.711 |
| vs `abbot` | 55.2% (85/154) | 64.5% | 46.2% | 18.3pp | 13 v 7, 54 split | 0.263 |
| vs `fletcher` | 43.9% (65/148) | 49.3% | 39.0% | 10.3pp | 8 v 15, 45 split | 0.210 |

The interesting column is not the first one. **The seat is worth more than
the playbook here.** The steward scores 64.5% against the abbot from seat 0
and 46.2% from seat 1 — an 18-point swing that has nothing to do with
either playbook, and exactly the number a single-seating run would have
published as strategy. Worse, 54 of that matchup's 74 resolved seeds went
to whoever sat in the favoured chair: on nearly three seeds in four the
seating decides the match and the playbook does not. Only 20 seeds had a
playbook win from both chairs, and those split 13-7 — a gap that looks
like something until you notice it rests on twenty seeds and comes back
p = 0.26.

All three matchups look the same: a seat swing of 10 to 18 points, most
seeds decided by the chair, and nothing left over that clears the bar. The
printed deck is, on this map at this horizon, not measurably ordered — and
the seat effect it is buried under is several times larger than any gap
between the playbooks.

So a playbook comparison run on one seating is not a weak measurement, it
is the map's seat bias wearing a playbook's name. That is why the mirror
is not optional and why the sweep pays double for it.

The `fletcher` matchup also reproduced phase 1's number from a different
direction: **24 of its 320 matches never decided inside the 120k horizon**,
7.5%, the same rate `docs/plan-ai-robustness.md` opens with. Twelve of its
eighty seeds were unresolvable for that reason alone. A harness that cannot
finish one seed in eight is spending its resolution on stalls.

Two sanity checks came out of the same runs:

- the advised win rate printed **exactly 50.0%** in all three
  (155/310, 154/308, 148/296) with the two seats on different playbooks —
  the asymmetric calibration, holding at 80 seeds exactly as the symmetric
  one does at 12.
- `--jobs 1` and `--jobs 3` still agree match for match on every digest.

## Comparing two runs

Two runs over the same seeds are far more comparable than their two
intervals suggest, because they are *paired*:

```sh
pnpm bakeoff:compare runs/posture.jsonl runs/candidate.jsonl
```

joins the runs on (seed, advised seat), discards the pairs where both
models' trials came out the same (they carry no evidence either way), and
runs an exact McNemar test on the discordant remainder. On forty seeds
this can separate models whose Wilson intervals overlap hopelessly — it
is how `posture:siege` was shown to beat both the first `choosePosture`
draft (p = 0.012) and the noise floor (p = 0.0015) on runs whose
intervals overlap across their whole width.

## The mutation space

`mutate.ts` is the primitive a playbook search drives: one playbook in, one
playbook a single bounded step away out, deterministic in the `Rng` handed
to it and nothing else. There is no generation loop yet, on purpose — what
had to be settled first is what a *neighbour* is, because that decides both
what a search can find and what it can break on the way.

The mutable set is **exactly the advice whitelist** (`src/ai/advice.ts`),
bounded by exactly its ranges. Three things follow, and they are the reason
for the choice:

- **Every mutant is sayable as advice.** A mutant round-trips through the
  shipped `parseAdvice` unchanged (asserted over 800 mutations from all four
  playbooks), so it is deliverable through the seam that already exists —
  `AiSeats.applyAdvice` at tick zero. A search needs no sim plumbing, no new
  `AiStrategyId`, and a winner ships as a posture without translation.
- **Whatever search finds, a model could have said.** The knobs explored are
  the knobs the strategist is allowed to turn, so a result lands in
  `ai/posture.ts` rather than in a parallel vocabulary nobody prompts with.
- **The opening is out of reach.** `build` and `researchOrder` pass through
  by reference and a test asserts the identity. Reordering them is the
  riskier second step in the plan and deserves its own experiment;
  `survivalFloor` and `growthAfter` sit out too, since neither is
  range-bounded anywhere and there is nothing to mutate them *within*.

`ADVICE_RANGES` is read, never added to — a new key there lengthens the
`random` engine's RNG stream and stops the recorded 46.6% / 47.0% noise
floor reproducing. `marchConfidence` is spliced in from its own constant,
the same trick `parseAdvice` plays.

Numeric knobs move by a share of their own range (never less than 1, or
`barracksQueueDepth` would never move) and clamp; a knob already pinned at
the edge it was pushed towards steps the other way instead of wasting the
mutation, which matters because every printed playbook holds
`marchConfidence` at the bottom of its range. List knobs swap, drop or
insert one entry.

The control for any search built on this is already measured: the `random`
engine redraws these same knobs from scratch every consultation and scores
**47.0%** over eighty seeds. A mutation operator that cannot beat redrawing
at random is not a search, it is the same dice with extra steps.

## Output

The report prints to stdout; per-match progress goes to stderr. With
`--out runs/x.jsonl` every match becomes one JSON line (`kind`:
`control` / `arm` / `report`) carrying consultations, latencies, parse
failures, final standings and a determinism digest. Add `--trace` to keep
every advisor reply verbatim — the raw material for auditing exactly what
an engine told a seat.

Files under `runs/` are gitignored.
