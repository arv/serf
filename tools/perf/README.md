# tools/perf — where the tick budget goes, and proof it still ticks the same

Three scripts. Two measure, one keeps the measuring honest.

## The problem these solve

The sim is deterministic, and replays and saves rest on that (see
`src/shared/replayVersion.test.ts`). So an optimization here is only
allowed if the world it produces is **bit-identical** afterwards — not
"close enough", not "the same winner". Iteration order, float operation
order and tie-breaks are all load-bearing.

That makes "did it get faster" and "did it stay the same" two separate
questions, and both need answering before a change lands.

## Measure

```sh
# Per-system breakdown on a deliberately heavy valley.
node --experimental-strip-types tools/perf/stress.ts --ticks 2000

# Whole-match throughput, two AI seats playing it out.
node --experimental-strip-types tools/perf/profile.ts --ticks 20000
```

`stress.ts` exists because the AI bake-off matches stay small — around 30
units — so they measure the quiet case. It inflates a real generated world
to late-game weight (hundreds of serfs, ~90 buildings, a live bandit war)
and times each system separately. `--serfs N` sweeps the scaling curve,
which is how you tell an O(n) cost from an O(n²) one.

For function-level detail, let V8 do it:

```sh
node --experimental-strip-types --cpu-prof --cpu-prof-dir=/tmp/prof \
  tools/perf/stress.ts --ticks 3000 --serfs 300
```

## Prove it still ticks the same

```sh
git stash
node --experimental-strip-types tools/perf/digest.ts > /tmp/before.txt
node --experimental-strip-types tools/perf/stress.ts --ticks 1500 --hash > /tmp/sbefore.txt
git stash pop
node --experimental-strip-types tools/perf/digest.ts > /tmp/after.txt
node --experimental-strip-types tools/perf/stress.ts --ticks 1500 --hash > /tmp/safter.txt
diff /tmp/before.txt /tmp/after.txt && diff /tmp/sbefore.txt /tmp/safter.txt && echo IDENTICAL
```

`digest.ts` plays 32 matches — eight seeds × two map sizes × bandits on and
off, with different playbooks in each seat — and prints `hashWorld` every
500 ticks. Hashing at intervals rather than only at the end matters: a
divergence that cancels out by the last tick still means the sim moved, and
the first tick that disagrees is the one worth debugging.

`stress.ts --hash` covers what those matches cannot. The AI matches are
too small and too peaceful to exercise combat's target-acquisition
tie-breaks; the stress valley has hundreds of bodies and a standing army in
it, which is exactly where a reordered scan would show up.

Run both. Then run `pnpm test` — `determinism.test.ts` and `save.test.ts`
are the same net from a different angle, and `replayVersion.test.ts` will
tell you the compatibility surface moved (update its hash; only bump
`REPLAY_VERSION` if behavior genuinely changed, which for a performance
change it should not have).

## What this bought, the first time round

A 96×96 valley with 260 units and 93 buildings went from **0.845 to 0.573
ms/tick**, about a third off, with every hash above unchanged. The largest
single find was the Smith's auto-recipe picker: it surveyed every building
in the settlement to decide what to forge, twice per Smith per tick, and a
Smith with no iron did it forever — a third of the entire tick budget spent
re-deciding something it could not act on.
