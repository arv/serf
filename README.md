# Serf ⚔️

A medieval Settlers-like RTS in the browser: ~80% economy and logistics, ~20%
combat. Watch your serfs physically carry every good across the valley, wear
trails into the grass, and — with Masonry — pave the busiest lanes into stone
roads.

## Play

```sh
pnpm install
pnpm dev
```

- **Goal**: destroy the bandit camp in the far corner. If your castle falls,
  the game is lost. First raid arrives after ~5 peaceful minutes.
- **Goods** (11): water, wheat, wood, stone, iron, silver, gold, sword, spear,
  bow, ale. Everything is hauled by serfs — there is no magic global
  stockpile; the resource bar shows what's physically in the castle.
- **Chains**: wells feed wheat farms; iron + wood become weapons at the
  smiths; wheat + weapons train soldiers at the barracks; wheat + water become
  ale, and ale delivered to the abbey throws festivals (+25% work speed).
- **Tech**: build an Abbey and research across Agriculture / Craft / Warfare.
  Unlocks are real strategic forks — Ironworking opens the sword economy,
  Archery opens the bow line, Masonry paves your roads.
- **Combat triangle**: Knights (heavy) ⟶ beat Spearmen (light) ⟶ catch
  Archers (ranged) ⟶ kite Knights. Bandit waves mix all three classes (the
  raid warning tells you the composition) — countering them means retooling
  your weapon production, not just clicking harder.

### Controls

| Input | Action |
|---|---|
| Left click / drag | Select units (shift = add) |
| Right click | Move order / attack enemy building |
| Click building | Building panel (barracks: train units) |
| WASD / arrows / middle-drag | Pan camera |
| Mouse wheel | Zoom |
| Esc | Cancel placement / clear selection |
| ` (backquote) | Logistics debug overlay |
| `?seed=123` URL param | Pick a map seed |

## Architecture

The simulation is a pure, deterministic, serializable data machine running at
a fixed 20 Hz in a **Web Worker**; the main thread only renders (three.js)
and handles UI (SolidJS). Hot per-tick unit state crosses over a
**SharedArrayBuffer** (seqlock-guarded slots, interpolated on the render
clock); slow structural state and one-shot events ride postMessage; input
comes back as typed commands. `src/sim/` never touches the DOM or three.js —
which is why the whole economy (logistics matcher with reservations,
production, research, combat) has a headless vitest suite, including a fuzz
harness that kills serfs and demolishes buildings for 10k ticks while
asserting the goods-conservation ledger and every reservation invariant.

SharedArrayBuffer needs cross-origin isolation: dev/preview servers send
COOP/COEP headers (see `vite.config.ts`); production hosting must do the same.

```sh
pnpm test        # headless sim suite (58 tests)
pnpm typecheck   # TS 7, strict + erasableSyntaxOnly
pnpm build       # typecheck + production bundle
```
