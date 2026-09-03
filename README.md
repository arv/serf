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
- **Campaign**: seven commissions that double as the tutorial (start menu →
  Campaign, or `?mission=<id>`): camp-raising, the bread chain, silver and
  research, the Smith and the tools every post is staffed with, the first
  raid, then the full game — and a bonus first rival.
  Objectives are judged by the sim; hints are a separate layer you can hide
  and finishing a commission unseals the next (see
  `docs/plan-campaign-tutorial.md`). Each commission has its own authored
  valley — composed around the lesson rather than rolled from a seed: the
  treeline west and the stone east of the first camp, the river the bread
  chain is built along, the one gap in the crags every raid walks through,
  and a last map drawn as one half and mirrored so two banners get the
  same ground (`src/sim/defs/maps/README.md`).
- **Goods** (19): water, wheat, wood, stone, iron, silver, gold, sword, spear,
  bow, ale, flour, food — and six tools: axe, pickaxe, scythe, hammer,
  cauldron, fishing rod. Everything is hauled by serfs — there is no magic
  global stockpile; the HUD strip shows the handful you watch constantly and
  the Ledger (the chip at its end) shows everything physically in the castle.
- **Tools**: nearly every production post is staffed with a tool as well as a
  hand — the woodcutter takes an axe, the quarry and the mines a pickaxe, the
  farm a scythe, the bakery and brewery a cauldron, the fishery a rod — and
  every construction site *borrows* a hammer, returned at topping-out, so
  hammers cap how many buildings rise at once. Tools come back when a worker
  is dismissed or the building sold; they burn with the building and die with
  the worker. The village opens with a starter kit, so the squeeze arrives
  with the second woodcutter, not the first. All of it is forged at the
  **Smith** (the old weaponsmith, ungated now): orders queue ahead of a
  standing selection, and an idle Smith on auto forges whatever tool the
  village most lacks — or nothing. The pickaxe alone costs wood + stone
  rather than iron, so the ore economy can always restart from timber.
- **Chains**: wells feed wheat farms; the mill grinds wheat to flour and the
  bakery bakes it into food (the fishery lands food straight off the shore);
  iron + wood become weapons — and iron tools — at the Smith; food + weapons
  train soldiers at the barracks; wheat + water become ale, and ale delivered
  to the abbey throws festivals (+25% work speed) — or, with Ale Rations,
  fills the barracks cask so every recruit drinks and trains faster.
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
  Unlocks are real strategic forks — Ironworking (a craft root now: the tool
  economy cannot wait on boots) opens the iron mine and every iron recipe at
  the Smith, Archery opens the bow line, Masonry paves your roads, Millstones
  speeds the bread chain, Bellows rivals Deep Mining for the forge's favor,
  and the ale line runs Brewing → Festivals → Ale Rations.
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
tap or keypress, so there is a switch on the start screen, a button in
the in-game menu, an **Alt+Enter** chord bound at boot for every screen in
between, and no way for the page to help itself — the chord works only
because a keypress is itself one of the gestures a request may ride. It survives the
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

### Screen wake lock

A match asks the platform to keep the display awake, because this game is
watched more than it is touched: a bread chain laid and then observed is
minutes with no input at all, and a phone dims and locks in one of them.
The Screen Wake Lock API is the sanctioned way to say "not yet", and its
one rule shapes the whole of `src/app/wakeLock.ts` — only a visible page
may hold one, and the browser takes it back at every hide. So the lock is
re-asked for on the way back, off the same `HiddenSync` the sim and the
audio freeze on (the signal built because mobile browsers drop the
return-to-visible event), and one ask is in flight at a time.

Only a match holds it. The menu is a page you read and leave, and a start
screen fighting the lock screen would be spending the battery of a game
nobody started; quitting to it releases, without a reload to do it. Where
the API is absent (Firefox on Android, any plain-http build) or the answer
is no (a permissions policy, an OS in battery saver — Chromium refuses
outright there) nothing is broken: the screen dims on its own schedule,
exactly as it did before. Nor is a refusal chased — no retry on a timer, and
none on the spot against an OS that has just said no. The next return to
visible asks again the way every return does, and the complaint is logged
once rather than once per return.

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

Each screen is also its own bundle chunk, fetched when a URL first names
it: the match (`src/app/matchScreen.ts` — three.js, the render stack, the
HUD, the input layer), the map editor, the field guide, the wardrobe, and
the menu's own live backdrop (`src/ui/menuBackdrop.ts` fetches the scene
behind it, which is cosmetic by design). What a cold visit must fetch
before the start menu is on the glass is about 60 kB gzipped rather than
330; the match's chunk is then warmed behind the menu, so pressing Play
does not start a download. Dependencies that do not change get chunks of
their own too — `three`, `solid-js` and wllama, named in `vite.config.ts`
— so an ordinary deploy rotates the app's chunk names and leaves 170 kB
of gzipped three.js sitting in the cache where it already was.

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
| **Ctrl+1**…**Ctrl+0** | Stamp the selection — units *or* a building — as a control group |
| **Shift+1**…**Shift+0** | Add the selection to that group (never overwrites one) |
| **1**…**0** | Call the group back — units selected, or a building's panel opened; twice in a beat also jumps the camera to it |
| Right click | Move order / attack enemy building |
| Click building | Building panel (barracks: train units) |
| Click a face on the selection card | Take that one on his own (shift = leave him behind) |
| **A** / **M** (units selected) | Arm attack-move / plain move — next click is the target, on the map or on the minimap |
| Minimap: drag | Steer the camera; right click it, or click it with **A**/**M** armed, to send the selection there |
| **F** (replay only) | Lift the fog and watch the whole valley — a cheat in a live match, spectating in a finished one |
| **B** then a letter | Build: **H**ouse, **W**oodcutter, **Q**uarry, **A**bbey, We**l**l, Wheat **F**arm, **M**ill, **B**akery, Fish**e**ry, B**r**ewery, **I**ron Mine, Sil**v**er Mine, **G**old Mine, **S**mith, Barrac**k**s, Guard **T**ower |
| **R** | Tech tree |
| **H** (castle selected) | Hire Serf |
| **K** / **S** / **A** (barracks selected) | Train **K**night / **S**pearman / **A**rcher |
| M (nothing selected) | Mute |
| Cursor at screen edge / arrows / middle-drag | Pan camera (edge scroll has a start-menu toggle) |
| Backspace | Jump to your keep |
| Space | Jump to the last alert |
| **+** / **−** | A gear at a time: pause ↔ normal ↔ fast forward (↔ 8× in a replay) — the bottom rung is the pause, so − holds the village and + lets it go |
| **Alt+Enter** | Full screen — on the menu and the map editor too, not just in a match |
| Mouse wheel | Zoom |
| **Shift** + wheel / **Insert**, **Delete** / **[**, **]** | Turn the camera — 15° a notch, or hold the key; two notches square the default 30° view to the map, and the minimap frame with it. The brackets are for keyboards without an Insert key. The map editor's camera does not turn — its view toggle is how that screen changes its angle, and the brackets size the brush there |
| Esc | Unwind one mode: chord → order → placement → open sheet → selection → fullscreen |
| ` (backquote) | Logistics debug overlay |
| `?seed=123` URL param | Pick a map seed |

Playback is the one cluster whose keys are not letters, and deliberately.
Every letter this game binds is one the HUD prints inside a word, and the
speed strip has none left to bold — F already lifts a replay's fog. So the
clock is the +/− pair and nothing else: the bottom rung of the ladder *is*
the pause, so − from walking pace holds the village in one press and + lets
it go again. A dedicated P would have been a second road to a rung that
already takes one keystroke, and one that then has to remember which gear it
interrupted. That pair is the grand strategy binding rather than the RTS one
— Paradox's clock, where Stellaris takes this same spread of spellings
(`+`, `=`, numpad +) — because the RTS lineage this game otherwise follows
has no speed key to copy: StarCraft changes speed from no key at all, and
pauses, where it pauses, on the Pause key itself.

Fullscreen takes Alt+Enter, which *is* the convention its neighbours use —
Blizzard's titles and Age of Empires alike toggle the screen on it — and
being a chord it costs no letter. It is bound at boot rather than inside a
match, so the chord that filled the screen during a skirmish still works on
the menu ten seconds later.

The gears themselves live in one place (`ui/speedControl.ts`) — the buttons
and the keys walk the same ladder, so + climbs out of a pause the mouse
took, and neither surface can be left holding a gear the other has never
heard of (a replay's 8×, in the screen where the ladder is a rung taller).

Shortcut letters are taught in place — the HUD bolds the letter inside its
own label (**B**uild, We**l**l, **H**ire Serf) and shows nothing at all on a
device with no keyboard. Camera control follows Warcraft III / StarCraft II:
edge scroll (`input/edgeScroll.ts`), arrows, middle-drag, wheel zoom, and a
camera that turns on Insert/Delete (Shift+wheel and [ ] too) over a minimap
that stays north-up. The minimap takes the map's own order gestures as well
as steering the camera — right-click it, or click it with A or M armed, and
the selection is sent there: the whole valley at two pixels a tile is a poor
place to pick a unit out of and a fine one to point at, so the chart gives
orders but never takes a selection. WASD
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

That card says who is in hand, not how many: one person picked up gets a
name, a glyph and their health across the head, the way a building's card
already does. A squad gets the count (named as its kind when they are all
one — "6 Spearmen") and a tile per head: a glyph over that head's own
health bar, in three colors, so the one man about to fall is findable in a
squad of twenty rather than averaged away. No number on the tile — a
number was tried and taken out again, because every tile in a healthy
squad printed the same thing, its kind's maximum, and read as what a
knight *is* rather than as how this one *is*. The bar carries the state,
and the exact figure is a hover away. The kind and the
health come off the same shared buffer the renderer draws from, re-read
once per publish rather than once per frame (`ui/roster.ts`); past three
rows of tiles the tail is counted instead of drawn, so an army cannot grow
the card down a phone screen — and the cut is not arbitrary: past the cap
the wounded are drawn first, so the men left out are the ones nothing has
happened to. Only past the cap, and on "hurt at all" rather than on how
hurt, because a unit crosses that line once in its life (nothing heals a
person) — sorting by health would re-order the tiles on every arrow, which
is precisely when they are being read.

The faces are buttons. Clicking one takes that man on his own and
shift-clicking leaves him behind — the same two a click on him out in the
valley gives, since a tile is one of the selected by definition and the
map's additive click is a toggle. Only those two: a man dropped from the
card takes his tile with him, so there is nothing left there to click, and
it is the map or his control group that brings him back. They are real buttons rather than
pictures that listen, so Tab walks the roster and the hover says the thing
can be clicked before you try it. No double-click: the first click leaves
one man selected, the roster stops drawing below two, and the second would
land on the map the shrinking card just uncovered.

A number holds whatever was selected when it was stamped, and that is either
a band of people or one of your buildings — the same either/or the selection
itself is. A building on a number is the economy's half of the binding:
Ctrl+4 on the barracks, and from then on 4 opens its card wherever the
fighting has taken the view, so hiring a soldier costs a keypress instead of
a trip back across the map. The castle, the smithy and the storehouse earn
their numbers the same way, and 4 twice still brings the camera along when
the trip is the point. A razed building takes its number with it, freeing it
to be stamped again; Shift is the half that never destroys a group, so it
takes a free number and refuses a taken one rather than trading a squad for
a barracks.

Ctrl on a Mac too, not ⌘ — ⌘1–⌘9 switch browser tabs above the page, where
no `preventDefault` reaches, and macOS ships its own ⌃1–⌃9 (switch to
desktop N) turned off. StarCraft binds Ctrl on every platform it ships on,
so this is both the compatible answer and the familiar one.

Touch gets the double-click as a double-tap on a unit — the same widening
to that kind on screen. A phone has no shift and no band drag without first
arming the HUD's marquee, so this is the one gesture that hands a finger a
whole kind at once.

Watching a replay, all of that reaches every seat. A recording is a match
with the orders taken out — the log is the sim's whole diet, so a click can
never touch the tick — and there is nobody left to hide a village from, so
the pointer picks up the Warlord's serfs and opens his mill's card the same
way it does your own. Which is most of the reason to open a recording at
all: an AI is otherwise a thing you only ever meet at your gates, and its
mistakes are only legible from inside its own valley.

Two rules keep that honest. A rival's building has to have been on screen —
*explored* ground, the same memory the renderer draws it from — so a click
into the dark cannot read the stock of a hut nobody has seen; F lifts the
fog and then everything is fair game. And any gesture that grabs a crowd at
once — a band drag, a double-click's widening — commits to one banner (the
seat filling the rectangle, or the clicked unit's), because "27 units
selected" across both sides of a melee is not a fact about anything. The
cards name whose people and whose walls these are, the rings under a rival's
squad fly that seat's color rather than your vermillion, and a squad's order
buttons are gone rather than greyed: they were never on the table.

The HUD turns with the pointer. Pick a seat's people or one of their
buildings and the goods strip, the population, the wants chip, the research
chip and the warnings are all that seat's: the Warlord's barracks card shows
his drill queue with the Train buttons locked or greyed against *his* techs
and *his* stores, his Smith shows its order book, and Research… on his Abbey
opens *his* tree. A chip in the speed cluster names the seat being watched
and clicks through to the next one. Every order row on a card is drawn
inert — the queue and the locks are what the card is opened to read, but
nothing in it takes a click, and the card says so. Which seat is *yours*
still decides what it always did: the name printed beside a rival's hut, the
fog the map is drawn through (F lifts it), and the outcome.

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

The **AI opponents** are the Age of Empires shape: a playbook of strategic
numbers per personality, a stance engine that switches its war knobs as
the match turns (`src/sim/defs/aiPostures.ts`, `AiStrategy.stances`), and
a set of reactive war verbs — harassment sorties, grudges, outpost
defense, retreats for the lords that retreat, heralds that announce a full
assault fifteen seconds before it moves. **Difficulty** is a fifth layer
over those (`src/sim/defs/difficulty.ts`): a transform applied to the knobs
a brain has already composed, so a tier scales whatever mood the seat is in
rather than pinning it. Easy musters late, refuses an even fight, raids
nobody, arms everyone with spears, thinks on a half-speed clock and is
slower still to notice the situation has turned; hard grows wider, marches
sooner and comes looking for you early.

It buys none of that with a handout. Every seat opens with the same larder
at every setting, and the fog model is untouched: a tier scales how long a
lord REMEMBERS what its scouts saw and how much of it it takes seriously,
never what its people can see. That distinction does more work than it
looks — a seat will not re-tool its forges for a rival whose picture has
gone stale, so an easy lord that forgets quickly stops answering what you
field at all, and keeps making what its playbook printed while you walk
knights into its spearmen. The rule the table follows is that easy may
soften anything while hard may only sharpen what a playbook already does,
so the abbot's refusal to raid survives the hardest setting in the game.

In the **campaign** the same control does a second, separate job: it
scales the commission's own opening — the larder, the hands in the yard,
the peace before the first raid, and then the gap between the waves after
it, which is the number a commission is actually won or lost on — leaving
the ground, the objectives and the prebuilt village exactly as authored. What each setting
actually changes is spelled out in the field guide at `/docs/difficulty`,
computed from the sim's own table rather than written down beside it. Every layer is
measured before it ships, and `tools/aiLab/` is the measuring instrument: a seed-sweeping,
seat-mirrored bake-off with error bars, per-behavior ablation flags and a
per-playbook FINGERPRINTS table (`pnpm bakeoff --help`, and the README
there — which also records why the on-device LLM strategist that once
advised the seats was removed: it never beat the rule reading the same
summary).

```sh
pnpm test        # headless suite: sim, editor, server, aiLab (800+ tests)
pnpm typecheck   # TS 7, strict + erasableSyntaxOnly
pnpm build       # typecheck + production bundle
pnpm format      # oxfmt, in place (CI runs `pnpm format:check`)
pnpm lint        # oxlint (CI runs it too; `pnpm lint:fix` applies fixes)
pnpm bakeoff     # AI bake-off (tools/aiLab)
pnpm balance     # per-playbook campaign sweep (`--difficulty` for a tier)
pnpm tiers       # easy/normal/hard against each other, seat-mirrored
```

Formatting is [oxfmt](https://oxc.rs/docs/guide/usage/formatter)
(`.oxfmtrc.json`: 80 columns, single quotes, no space inside braces, bare
single arrow params, sorted imports), and CI fails on an unformatted file.
Left alone: the prose in `README.md` and `docs/`, the vendored models under
`public/models/`, and the one-line generated data
(`src/sim/defs/maps/*.json`, `tools/modelLab/baked.json`) a formatter would
explode into thousands of lines.

Linting is [oxlint](https://oxc.rs/docs/guide/usage/linter)
(`.oxlintrc.json`), and CI fails on a finding. Only the `correctness`
category is on — code that is outright wrong or dead — so a warning is
worth fixing rather than arguing with, and `pnpm lint:fix` handles the
mechanical ones. It runs `--type-aware` (the `oxlint-tsgolint` dev
dependency), which is where the rules that need a checker live: it is what
noticed that `.sort()` on our numeric ids orders them as text, so a
thirteen-id list sorted `[1, 10, 2]`. Type-aware or not, the whole run is
about a second and a half over 418 files.

No rule is switched off wholesale. Two carve-outs, each as narrow as it
goes: `no-unassigned-vars` is off for `**/*.tsx` only, because Solid
assigns the `let` behind `ref={el}` through a compiler transform the rule
cannot see (it stays on for the other ~380 files); and the four sites
where a rule reads a deliberate idiom as a mistake carry an
`oxlint-disable-next-line` saying which idiom — three spreads that are
snapshots taken because the loop body deletes from the map it walks, and
one saved `onBeforeCompile` that is put straight back on the material it
came off. The `vitest` and `jsx-a11y` plugins are off — the first reads
Vitest's `expect(value, 'message')` as an arity error, the second wants
markup changes that belong in a change of their own.

One thing to know about the import sorting: a comment directly above the
first import travels with it, so a file header or a `/// <reference lib>`
lands mid-block unless a **blank line** separates it from the imports. The
two workers (`src/app/simWorker.ts`, `src/app/netWorker.ts`) need theirs —
a `<reference>` TypeScript no longer reads is a silent one.

## Credits

The game carries its own credits page — `/docs/credits` in the field guide,
also linked from the start screen's footer — with logos and links.

- 3D models: [KayKit](https://kaylousberg.itch.io/kaykit-medieval-hexagon)
  packs by Kay Lousberg (CC0) — Medieval Hexagon foremost, plus the
  Adventurers characters, Dungeon Remastered, Forest Nature, Restaurant
  Bits and RPG Tools — `public/models/kaykit/`
- Audio samples: [Kenney](https://kenney.nl) impact / RPG / interface /
  jingle packs (CC0) — `public/audio/`; every cue also has a synthesized
  fallback, so the samples only ever improve what is already audible
- Renderer: [three.js](https://threejs.org) (MIT)
- UI runtime: [SolidJS](https://www.solidjs.com) (MIT)
- Typeface: [Space Grotesk](https://github.com/floriankarsten/space-grotesk)
  by Florian Karsten (OFL 1.1) — `public/fonts/`
