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
| `script:{...}` | one fixed reply forever — plumbing checks, personality experiments |
| `http://…/v1` | any OpenAI-compatible server (llama-server, Ollama, LM Studio, vLLM); `--model` names the model, `OPENAI_API_KEY` is sent if set |

## Output

The report prints to stdout; per-match progress goes to stderr. With
`--out runs/x.jsonl` every match becomes one JSON line (`kind`:
`control` / `arm` / `report`) carrying consultations, latencies, parse
failures, final standings and a determinism digest. Add `--trace` to keep
every prompt and reply — that is the raw material for a fine-tuning set.

Files under `runs/` are gitignored.
