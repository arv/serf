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
| `posture` | the five stances picked by rule, no model — the bar a model has to be *worth*, not just beat |
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
