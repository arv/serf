# Serf Valley ⚔️

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
  the game is lost. The first raid waits out an opening peace that scales
  with the map — about 13.5 minutes on the default 96×96 valley.
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
  price scaled by the damage, and the materials are hauled in like a site's;
  the masons then work them in, so the walls climb back over the seconds
  that follow rather than snapping back when the last plank lands. A mend
  interrupted by the next wave is a wall that is still half down. Always
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
argued with.

Esc is also the game's busiest key, and inside fullscreen the browser
answers it first — with an exit that no `preventDefault` can stop, by
design of the Fullscreen spec, so that no page can trap anyone. The one
sanctioned way to ask for the key anyway is the Keyboard Lock API, and a
match holds it for its lifetime where it exists (Chromium): a short press
stays in the game to cancel what it meant to cancel, the browser moves its
own exit to press-and-hold Esc, and a press with nothing left to unwind
leaves fullscreen through the game's own switch. Where the API is absent
(Firefox, Safari) Esc keeps both meanings, as it always did.

Installed to a home screen neither control appears at all: the
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
| Double-click a unit | Select every unit of that kind on screen (shift = add) |
| **Ctrl+1**…**Ctrl+0** | Stamp the selection as a control group |
| **Shift+1**…**Shift+0** | Add the selection to that group |
| **1**…**0** | Call the group back; twice in a beat also jumps the camera to it |
| Right click | Move order / attack enemy building |
| Click building | Building panel (barracks: train units) |
| **A** / **M** (units selected) | Arm attack-move / plain move — next click is the target |
| **B** then a letter | Build: **H**ouse, **W**oodcutter, **Q**uarry, **A**bbey, We**l**l, Wheat **F**arm, **M**ill, **B**akery, Fi**s**hery, B**r**ewery, **I**ron Mine, Sil**v**er Mine, **G**old Mine, Wea**p**onsmith, Barrac**k**s |
| **R** | Tech tree |
| **H** (castle selected) | Hire Serf |
| **K** / **S** / **A** (barracks selected) | Train **K**night / **S**pearman / **A**rcher |
| M (nothing selected) | Mute |
| Cursor at screen edge / arrows / middle-drag | Pan camera (edge scroll has a start-menu toggle) |
| Backspace | Jump to your keep |
| Space | Jump to the last alert |
| Mouse wheel | Zoom |
| Esc | Unwind one mode: chord → order → placement → open sheet → selection → fullscreen |
| ` (backquote) | Logistics debug overlay |
| `?seed=123` URL param | Pick a map seed |

Shortcut letters are taught in place — the HUD bolds the letter inside its
own label (**B**uild, We**l**l, **H**ire Serf) and shows nothing at all on a
device with no keyboard. Camera control follows Warcraft III / StarCraft II:
edge scroll (`input/edgeScroll.ts`), arrows, middle-drag, wheel zoom. WASD
deliberately does *not* pan — those letters belong to the orders and the
build chord, and `A` cannot both pan left and attack-move.

Control groups are StarCraft's, numbers and all, and they are the one
binding that is not a mode: no click is claimed, so Esc has nothing to
unwind. A group is a list of ids rather than a snapshot of a squad — the
dead are weeded out of every group each frame, so a group that lost half its
soldiers calls back the half that lived, and one that lost all of them
refuses out loud rather than answering with an empty selection. The
selection card names the group it is standing on, which is the whole
feedback loop: Ctrl+1 changes nothing else a player can see.

Ctrl on a Mac too, not ⌘ — ⌘1–⌘9 switch browser tabs above the page, where
no `preventDefault` reaches, and macOS ships its own ⌃1–⌃9 (switch to
desktop N) turned off. StarCraft binds Ctrl on every platform it ships on,
so this is both the compatible answer and the familiar one.

Touch gets the double-click as a double-tap on a unit — the same widening
to that kind on screen. A phone has no shift and no band drag without first
arming the HUD's marquee, so this is the one gesture that hands a finger a
whole kind at once.

The letters on a selected building's panel are contextual, as in both those
games, so they may reuse a global letter: the barracks' **A**rcher is the
attack-move's A, which is only safe because a building selection and a unit
selection cannot both stand. The gates are shared between the button and the
key (`ui/commands.ts`, `ui/buildMenu.ts`), so a shortcut can never fire where
its button is greyed out — and every refusal names which gate it hit.

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

The optional **LLM strategist** (the "LLM strategist" toggle in the start
menu) runs a small language model on-device — llama.cpp via wllama, CPU
wasm so the renderer keeps the GPU — and lets it steer the AI seats'
posture knobs on a slow cadence. Whether a given model's advice actually
wins games is a measurable question, and `tools/aiLab/` is the measuring
instrument: a seed-sweeping, seat-mirrored bake-off with error bars
(`pnpm bakeoff --help`, and the README there).

```sh
pnpm test        # headless sim suite (58 tests)
pnpm typecheck   # TS 7, strict + erasableSyntaxOnly
pnpm build       # typecheck + production bundle
pnpm bakeoff     # LLM strategist bake-off (tools/aiLab)
```

## Credits

- 3D models: [KayKit Medieval Hexagon Pack](https://kaylousberg.itch.io/kaykit-medieval-hexagon)
  by Kay Lousberg (CC0) — `public/models/kaykit/`
- Audio samples: [Kenney](https://kenney.nl) impact / RPG / interface /
  jingle packs (CC0) — `public/audio/`; every cue also has a synthesized
  fallback, so the samples only ever improve what is already audible
