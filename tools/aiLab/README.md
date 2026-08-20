# aiLab — the LLM strategist bake-off

Does putting a model in the strategist's seat (`src/ai/`) actually win more
games than the printed playbook? This harness exists to answer that with a
number that has error bars, instead of a feeling.

```sh
# 1. calibrate — must print exactly 50.0%
pnpm bakeoff --engine none --seeds 1-12

# 2. the noise floor every model has to clear
pnpm bakeoff --engine random --seeds 1-40 --out runs/random.jsonl

# 3. real weights, via llama.cpp's own server (same GGUF the browser runs)
#    llama-server -m qwen2.5-0.5b-instruct-q4_k_m.gguf -c 2048 --port 8080
pnpm bakeoff --engine http://localhost:8080/v1 --seeds 1-40 --out runs/qwen.jsonl

pnpm bakeoff --help   # every flag
```

Sim-only sweeps run one match per `--jobs` process (`--jobs max` uses the
machine); results are byte-identical to `--jobs 1` for every engine except
`http`, where it also means concurrent requests — size the server's
`--parallel` to match.

> `llama-server` splits `-c` *across* its parallel slots, so `-c 2048
> --parallel 4` gives each slot 512 tokens and every consultation comes
> back `400 exceed_context_size_error` against this ~850-token prompt.
> Multiply: `-c 8192 --parallel 4`. The startup line to check is
> `n_ctx_slot = 2048`. A sweep that hits this still prints a win rate —
> a meaningless one — so read ENGINE HEALTH before believing any number.

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

Matches run the *real* pipeline — `LlmStrategist`, `buildMessages`,
`parseAdvice`, `AiSeats.applyAdvice` — with only the `ChatEngine` seam
swapped, so what is measured is what ships. Undecided matches are reported
and excluded, never awarded. Crashed trials are printed next to the rate.

## What to know before believing a number

- **Sample size.** A ±5-point read on the win rate needs ~385 trials
  (~193 seeds). Forty seeds (80 trials) resolves about ±11 points. The
  verdict line prints what your run can and cannot see.
- **Latency.** By default advice lands instantly (`--latency 0`), which
  hands the model a small oracle advantage — in the game, CPU inference
  takes tens of seconds while the valley keeps moving. Read the report's
  p50 latency, then re-run with `--latency measured` (realistic, not
  reproducible) or `--latency <ticks>` (reproducible) to make advice pay
  for its thinking time.
- **Advice can be structurally inert.** Most economy knobs sit behind the
  playbook's `growthAfter` research and the war knobs behind a mustered
  army, so advice to a seat that never gets that far changes nothing — on
  some seeds one seat dies before its knobs ever gate a decision. That is
  a fact about the game, not a bug in the harness; the mirrored arms
  average it out.
- **What HTTP inference does not measure:** wasm speed. `llama-server`
  runs the same GGUF through the same llama.cpp grammar-constrained
  decoding as wllama in the browser, so the *decisions* transfer; the
  *milliseconds* don't. For browser-honest latency, measure in the game
  and feed the number to `--latency`.

## Engines

| spec | what it is |
| --- | --- |
| `none` | no strategist — calibration; must score exactly 50% |
| `random[:seed]` | valid advice by dice — the noise floor; a model must beat this, not just 50% |
| `posture` | the stances picked by rule, no model — the bar a model has to be *worth*, not just beat |
| `posture-blind` | the same rule with `readOpponent` deleted — the null for `posture`, and the only fair one |
| `posture:<id>` | one stance held all match (`posture:siege`) — ablation, and it says what each stance is worth alone |
| `script:{...}` | one fixed reply forever — plumbing checks, personality experiments |
| `http://…/v1` | any OpenAI-compatible server (llama-server, Ollama, LM Studio, vLLM); `--model` names the model, `OPENAI_API_KEY` is sent if set |

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
deleted, which is what `--engine posture-blind` is:

| arm | advised win rate | 95% CI |
| --- | --- | --- |
| `posture-blind` (opponent ignored) | 51.8% (73/141) | [43.6%, 59.9%] |
| `posture` (opponent read) | 50.7% (73/144) | [42.6%, 58.7%] |
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
| `posture-blind` (rule) | 51.8% (73/141), flips 16 / 15 | 19 / 240 |
| `posture` (rule, reads the opponent) | 50.7% (73/144), flips 14 / 16 | 16 / 240 |

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

## Comparing two models

Two runs over the same seeds are far more comparable than their two
intervals suggest, because they are *paired*:

```sh
pnpm bakeoff:compare runs/qwen.jsonl runs/lfm.jsonl
```

joins the runs on (seed, advised seat), discards the pairs where both
models' trials came out the same (they carry no evidence either way), and
runs an exact McNemar test on the discordant remainder. On forty seeds
this can separate models whose Wilson intervals overlap hopelessly — it
is how `posture:siege` was shown to beat both the first `choosePosture`
draft (p = 0.012) and the noise floor (p = 0.0015) on runs whose
intervals overlap across their whole width.

## Output

The report prints to stdout; per-match progress goes to stderr. With
`--out runs/x.jsonl` every match becomes one JSON line (`kind`:
`control` / `arm` / `report`) carrying consultations, latencies, parse
failures, final standings and a determinism digest. Add `--trace` to keep
every prompt and reply — that is the raw material for a fine-tuning set.

Files under `runs/` are gitignored.
