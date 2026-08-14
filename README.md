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
  the game is lost. First raid arrives after ~9 peaceful minutes.
- **Campaign**: six commissions that double as the tutorial (start menu →
  Campaign, or `?mission=<id>`): camp-raising, the bread chain, silver and
  research, the first raid, then the full game — and a bonus first rival.
  Objectives are judged by the sim; hints are a separate layer you can hide
  and finishing a commission unseals the next (see
  `docs/plan-campaign-tutorial.md`).
- **Goods** (13): water, wheat, wood, stone, iron, silver, gold, sword, spear,
  bow, ale, flour, food. Everything is hauled by serfs — there is no magic
  global stockpile; the resource bar shows what's physically in the castle.
- **Chains**: wells feed wheat farms; the mill grinds wheat to flour and the
  bakery bakes it into food (the fishery lands food straight off the shore);
  iron + wood become weapons at the smiths; food + weapons train soldiers at
  the barracks; wheat + water become ale, and ale delivered to the abbey
  throws festivals (+25% work speed) — or, with Ale Rations, fills the
  barracks cask so every recruit drinks and trains faster.
- **Siting gatherers**: the woodcutter, the quarry and the mines only stand
  where their worker has something in reach — the trees, the outcrop, the
  seam. Aiming one draws the square that worker will search, and the hut
  turns red outside it, so a hut is never built to stand idle.
- **Population**: the HUD counts every person you own — idle serfs, the
  workers inside your buildings, and your soldiers, since each one was a serf
  first. The castle sleeps 10 and you start with 8, so growth needs **houses**:
  10 more beds each, and a hire is refused while every bed is taken. Building
  wide and mustering an army compete for the same roofs.
- **Tech**: build an Abbey and research across Agriculture / Craft / Warfare.
  Unlocks are real strategic forks — Ironworking opens the sword economy,
  Archery opens the bow line, Masonry paves your roads, Millstones speeds the
  bread chain, Bellows rivals Deep Mining for the forge's favor, and the ale
  line runs Brewing → Festivals → Ale Rations.
- **Combat triangle**: Knights (heavy) ⟶ beat Spearmen (light) ⟶ catch
  Archers (ranged) ⟶ kite Knights. Bandit waves mix all three classes (the
  raid warning tells you the composition) — countering them means retooling
  your weapon production, not just clicking harder.

### Offline

Single player is a local sim, so a production build plays with the network
switched off. The first visit installs a service worker that precaches the
app shell and the ~10 MB of KayKit models; after that a cold launch — menu,
map generation, a whole skirmish, saving and loading — needs nothing from
the server. Only multiplayer does, and the start menu dims it when the
connection is gone.

Updates land on the start screen: a new build's worker installs in the
background, and the menu (where no match is at stake) waves it through and
reloads onto it. A worker that finishes installing mid-match stays parked
until the player is back at the menu.

### Full screen

Offered, never taken: browsers grant fullscreen only from inside a click,
tap or keypress, so there is a button on the start screen and one in the
in-game menu, and no way for the page to help itself. The answer is
remembered — and because beginning a match reloads the page, which exits
fullscreen, the match re-enters on your first click there. Leaving by any
other road (Esc, the browser's own control) is an answer too, and is not
argued with. Installed to a home screen the question never arises: the
manifest asks for `display: fullscreen`, which is also the only fullscreen
iOS has for a page at all — there the buttons hide themselves.

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
The offline worker inherits that for free — it replays the cached response
with the headers it was fetched with, so `crossOriginIsolated` holds with no
server in reach. `src/app/sw.js` ships to `dist/` verbatim (it is the one
hand-written JS file in the tree); `build/swPlugin.ts` fills in its precache
manifest from the finished build, and registration lives in
`src/app/serviceWorker.ts` — dev unregisters instead, so `pnpm dev` is never
served yesterday's bundle.

```sh
pnpm test        # headless sim suite (58 tests)
pnpm typecheck   # TS 7, strict + erasableSyntaxOnly
pnpm build       # typecheck + production bundle
```
