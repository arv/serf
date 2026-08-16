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
- **Repairs**: a building the raiders left standing can be mended instead of
  written off — select it and hit **Repair**. The bill is half its build
  price scaled by the damage, and the materials are hauled in like a site's,
  so the walls come back up as fast as your serfs can carry stone. Always
  cheaper than tearing it down and paying full price again, and the worker
  never leaves the post. The castle repairs too, out of the stores already
  inside it, against a notional price of its own (it cost nothing to raise).
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
tap or keypress, so there is a switch on the start screen and a button in
the in-game menu, and no way for the page to help itself. It survives the
walk into a match and back out again, because neither costs a document
(see Navigation below); the answer is also remembered, so the reloads that
do still happen come back into it on your first click. Leaving by any
other road (Esc, the browser's own control) is an answer too, and is not
argued with. Installed to a home screen neither control appears at all: the
manifest asks for `display: fullscreen` and is given it, so there is nothing
left to offer — and that install is the only fullscreen iOS has for a page
in the first place. A desktop install usually lands on `standalone` instead,
which is an ordinary window with a screen still to fill, so there the offer
stands.

### Navigation

Every screen change happens in one document. The start menu, the War
Council, a skirmish, a campaign mission, a replay and the walk back to the
menu are all the same page rearranging itself — `src/app/router.ts`
intercepts navigations (the Navigation API where it exists, pushState and
popstate elsewhere) and `route()` in `src/app/main.ts` disposes the screen
that was up and builds the one the URL names. Multiplayer always worked
this way; now everything does, which is why fullscreen survives a launch
and why Back out of a match is not a reload.

The URL stays the source of truth rather than becoming decoration: every
screen is still fully described by its query string, so a shared link, the
GPU-loss recovery reload and a service worker's update swap all land
exactly where they did before. Routing is keyed on which screen a URL
names, not on the URL itself — the council rewrites its own address bar as
the relay names the room, and that must not tear the room down.

A match owns a WebGL context, a sim worker whose timers are deliberately
unthrottled, listeners on window and document, and a Solid root; ending one
gives all of it back. Its canvas is replaced rather than reused, since a
canvas hands out one context in its lifetime — which doubles as the scene
teardown, because every buffer and texture the match uploaded lives in the
context that goes with it.

Replacing the canvas is not on its own enough to drop what a match built,
and the reason is worth knowing before adding a listener to one: three.js
keeps a context's GPU buffers in WeakMaps keyed by its own module-level
geometries, and those live as long as the page — so a detached canvas stays
reachable, and every listener still on it holds its closure, and those
closures hold the sim worker, the mirror and the scene. `Controls`, the
`CameraRig` and the match itself therefore register every listener against
an `AbortController` and abort it on teardown. Walking menu → match → menu
repeatedly used to cost ~13 MB a round (14 MB, then 33, 46, 59, 72 across
four cycles, forced GC); it now sits flat at 21–22 MB.

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

## Credits

- 3D models: [KayKit Medieval Hexagon Pack](https://kaylousberg.itch.io/kaykit-medieval-hexagon)
  by Kay Lousberg (CC0) — `public/models/kaykit/`
- Audio samples: [Kenney](https://kenney.nl) impact / RPG / interface /
  jingle packs (CC0) — `public/audio/`; every cue also has a synthesized
  fallback, so the samples only ever improve what is already audible
