# Model lab

A sketchpad for building compositions before they earn a place in
`src/render/assets.ts`. A candidate here is a *recipe*: a KayKit model or
two, some pack props placed around it, and whatever small parts we would
have to build ourselves — all in tile coordinates, lit and framed exactly
the way the game frames a building.

Its first job was the food chain: mill, bakery, fishery, and the goods a
serf carries. (A livestock slot was here too, and the hen yard it was for
was cut on balance rather than on looks — the compositions are gone with
it, but `git log` still has them if a use turns up.)

## Looking at them

```sh
pnpm dev            # then open /tools/modelLab/
```

Drag a card to turn it. `?only=<variant-id>` blows one composition up to
full width — the fastest way to judge a placement.

## The tower roof

`_levy.html` is a scratch page for the one thing tests cannot check: what
the guard tower's garrison looks like. It calls the same
`makeGlbBuilding` / `makeCharacter` / `playAnimation` the renderer does and
places the figures on the model's own `towerPost` marks exactly the way
`BuildingSync.#syncGarrison` does, so what reads there reads on a roof in a
match. Two towers side by side: the levy throwing, the archers drawing.

```sh
pnpm dev   # then /tools/modelLab/_levy.html
```

`?t=<0..1>` scrubs every clip to that fraction of its length — shoot a
series of those and you have the motion frame by frame. `?strip=throw`
(or `shoot`) lays one clip out left to right instead, turned square to the
camera, which is the only way to judge a throw: on a roof the men face
outward and you are usually behind them. `w`/`h`/`zoom`/`fy` size and frame
the shot.

## The four ore posts

`_mines.html` is the page the quarry, the iron, the silver and the gold
mine were pulled apart on. All four play the pack's one mine model, and
before this they were separated by a wheelbarrow's rotation and three
thumb-sized boulders that only appear when there is stock in the yard — at
village zoom, four copies of the same hill. The page draws them the way a
match does (`makeGlbBuilding` plus the stock stacks `buildingSync` piles on
`MINE_SPOTS`), in a row, at the rig's own angles, with the yards both empty
and full — which is the only way to see that the empty case was the one
doing the damage.

```sh
pnpm dev   # then /tools/modelLab/_mines.html
```

`?stock=0|1` shows one row instead of both. `?yaw=<deg>` walks the camera
round: the rig opens at 30° and turns in 15° steps, so a silhouette has to
survive being looked at from behind as well as from the front. `w`/`h` set
the canvas — shrink it to about 160px a row and you are looking at what the
player actually sees.

`_plan.html` is its companion: one mine straight down with a tenth-of-a-unit
grid over it, which is how the coordinates in `BUILDING_DECOR` get read off
rather than guessed. Red is the z axis, blue the x axis, and the grid box is
the unit square a decor entry is placed in.

`_spoil.html` is where the ground paint is judged instead of the models.
The other two stand their buildings on a plain lit plane, which is the
right stage for a silhouette and the wrong one for a tint the terrain mesh
draws — so this page builds a small real map, deposits and footprints and
all, and hands `TerrainMesh` the same spoil lookup `main.ts` gives it. The
seam scatter is in too, because the question is whether a post's spoiled
ground joins up with the seam it works.

```sh
pnpm dev   # then /tools/modelLab/_spoil.html
```

`?spoil=0` paints with the lookup disabled, which is the before shot;
`?yaw` and `w`/`h` behave as they do on `_mines.html`.

## The fishery's pier

`_pier.html` is where the deck is judged against real shoreline. Every other
page here stands its building on a plate of turf with a painted chord of
water behind it — the right stage for a silhouette and the wrong one for
"does this deck end in the lake", because that shoreline is authored to suit
the model. So this page generates a real world, asks `canPlace` for every
legal fishery site, and renders `BuildingSync`'s own deck fit
(`#measurePier`) on the ones where the deck AS AUTHORED ends on grass —
against the real terrain mesh, the real water plane and the real scatter.

```sh
pnpm dev   # then /tools/modelLab/_pier.html
```

It prints the tally to the console (`416 legal sites, 134 dry as authored, 0
dry after the fit` on seed 1), which is the number a change to the fit's
turn and trim limits — or to the fishery's footprint, which the page reads
from the def rather than assuming — has to be measured by. "Dry" there means what the fit
means by it, at both of the points it judges: a deck counts as wet only if
its tip AND the spot the fisherman casts from are both under the waterline.
Scoring the spot alone would let a deck that strides a narrow channel and
lands on the far bank pass, which is one of the two things the fit exists
to correct. `?fit=none` fits against ground
whose lake beds are filled to just OVER the waterline — the huts still
stand at their true height, no fit is found anywhere, and the deck comes
out as the model places it, which is the before shot. Just over, and not
level with it, because the field is float32: `WATER_LEVEL` rounds into it a
hair low, and a bed filled to exactly that reads back as a puddle deep
enough to fit a deck to. `?worst=1` picks the sites the fit has to distort
most instead of the first ones it finds, `?stranded=1` picks the ones it
could not save at all (the tally's last column, and otherwise unfindable —
every other filter draws from the decks that START dry), `?all=1` includes
the sites that were already wet, `?at=x,y` blows one site up, `?seed=<n>`
trawls a different world, and `?n`/`?cell`/`?view`/`?yaw` set how many, how big,
how close and from where. Turn the camera before calling a deck wrong: at
some yaws a deck that runs behind its hut is mostly occluded by the roof
and reads as a staircase.

## The fisherman's rod

`_angler.html` is where the rod's hold is judged. Whether the man is holding
it is not a property of the model — it is the model, the hand socket, and
what `Fishing_Idle` has done to both wrists, multiplied together — so it
cannot be read off the asset or argued from the Euler angles in
`fishingPoleProp`. This page stands the man on the game's own rig, equips
him through the same `setWorkTool(WORK.fish)` a match does, and turns him
through four quarter turns, because a hold is a three-dimensional claim and
one yaw cannot settle it: a rod pointing straight at the camera and a rod
pointing straight down the man's own nose draw the same.

```sh
pnpm dev   # then /tools/modelLab/_angler.html
```

It prints its reading to the console and leaves it on
`window.ANGLER_READING`, because squinting settles nothing and a fist a
finger's width off the haft draws like a fist holding it: the shaft's aim
against the man's own forward and right, each handslot's perpendicular miss
from the shaft's line, how far the hanging line is off plumb, and which way
the guide face points. Every constant in `fishingPoleProp` was read off it.

What it was written to catch was a rod lying across the man's chest. The aim
had been set by a pitch about the hand SOCKET's x, on the assumption that
the socket is squared to the body, and it is not — so the pitch rolled the
rod out sideways instead of forward.

**The left fist does not reach the rod, and that is a deliberate trade.**
Fishing_Idle is a two-handed pose, and the segment between its fists — steady
to 0.18 of a degree over the whole clip — lies 77.6 degrees off the man's
right, with his hips, chest and head all square to the front. Laid on THAT
axis the rod is gripped perfectly by both fists and points across his body.
Laid forward, which is what the fishery wants, the right fist still holds it
(the rod hangs off that socket, so it cannot miss) and the left falls about
0.098 short. Closing that gap means IKing the free hand onto the haft with
the machinery the farmer's scythe already uses, not moving `ROD_AIM`. The
page reports both misses so the trade stays visible rather than becoming
folklore.

The roll about the shaft is the other half of the placement, and the aim
alone does not set it: a shortest-arc turn onto `ROD_AIM` leaves the roll to
fall out of the arithmetic, which is how the reel came to hang off the SIDE
of the pole. `ROD_GUIDES` pins it — the face the guides and reel stand off,
averaged from the rod mesh's own vertices rather than taken from the reel
handle, which is a crank and sticks out sideways by design (89.9 degrees off
the guides, and rolling by it is exactly the mistake). Reel and guides share
one face on this model, 0.8 degrees apart, so they cannot be split: the
guide face rides up, which puts the reel above the shaft.

`?yaws=<n>` sets how many turns, `?spin=<deg>` turns the whole strip (a
single figure wants this — square to the camera the rod is aimed at the lens
and foreshortens to a dot; `?spin=90` lays it across the frame, which is the
view that settles which face the line runs down), `?t=<0..1>` scrubs the
clip, `?roll=<deg>` spins the rod about its own shaft, and `?rx`/`?ry`/`?rz`
override the wrap live so a new aim can be read off a screenshot. `?raw=1`
undoes everything `fishingPoleProp` did — hold, wrap, aim, grip slide, the
line's plumb and its stretch — and hangs the rod in the socket the way the
pack ships it, which is the before shot every correction is measured
against. `w`/`h`/`zoom`/`fy` size and frame the shot, as on the other pages.

## The farmstead

`_farm.html` is where the wheat farm's field was composed and the farmer's
scythe judged. It stands the built farmstead (`makeGlbBuilding`) with
farmers on the model's own `mowPath` marks — the circuit `sceneSync` walks
the resident along — one mid-stroke, one walking a lane, one standing.

```sh
pnpm dev   # then /tools/modelLab/_farm.html
```

`?t=<0..1>` scrubs the mowing stroke; `?strip=mow|walk|idle` lays one clip
out left to right instead, scythe in hand, which is how the stroke and the
carry were tuned. The scythe has a hold for each: `?rx=`/`?rz=` aim the haft
out of the fist, `?ry=` rolls the tool about that haft (which way the blade
faces), and `?sy=` slides the fist along the snath — the knobs
`SCYTHE_CARRY` and `SCYTHE_MOW` in `src/render/characters.ts` were read off.
They override whichever hold the clip on screen wears, so tune the mowing
one under `?strip=mow` and the carried one under `?strip=walk`. `?marks=1` beads every walk mark to check the circuit
against the rows; `?rival=1` turns the seat red for the team roof.
`w`/`h`/`zoom`/`fy` frame the shot as everywhere else.

## The monument

`_monument.html` is where the wonder was composed: a serf cast in gold on a
battered stone pedestal, the one building here that is a person rather than
a workplace. It calls the real builder (`makeMonument`, in
`src/render/procBuildings.ts`) with the real figure — `makeStatueGeometry`
bakes one frame of the rig down to plain geometry (`src/render/statue.ts`)
— and sizes the result the way `makeGlbBuilding` sizes a building of that
footprint, with a live serf standing at the foot of it so the only question
that matters (how big is this next to the people who built it?) is on the
screen rather than in the head.

```sh
pnpm dev   # then /tools/modelLab/_monument.html
```

`?figure=<lord|abbot>` swaps the whole preset — body and pose travel
together, since neither the knight's nor the abbot's is the serf's. The
abbot is the **Lorekeeper** (KayKit Monthly Mystery Series 6, CC0 like every
other pack here — `public/models/kaykit/lorekeeper/LICENSE.txt`), which no
unit wears: he is addressed by a figure key rather than a unit kind
(`FIGURE_LOREKEEPER` in `src/render/characters.ts`), because the character
pipeline reads one number and the sim must never learn of him. He rides the
same Rig_Medium as the Adventurers bodies — same 23 joints, handslots
included, no clips of his own — so the shared animation library drives him
unchanged.

`?fp=<2|3>` sets the footprint it is sized for — 4.0 tall at 2x2, against a
house's 2.3 and the castle's 5.6. `?pose=<anim key>`, `?phase=<0..1>`,
`?load=<carry code>`, `?tool=<WORK kind>` and `?lift=<degrees>` cut the
figure from a different clip, moment, load, tool and chin angle; the
defaults are `SERF_AT_REST`, and the note on it says which alternatives were
looked at here and why they lost. `?serf=0` sends the man beside it home,
`?yaw` walks the camera round, `w`/`h`/`zoom`/`fy` frame the shot as
everywhere else. The page also prints the model's height and how many of its
triangles land in the team-colour slot — a monument nobody's colour reaches
is a monument every seat builds identically.

## The training cue

`_training.html` is where the barracks, the archery range and the castle were
taught to say they are busy. Like `_pier.html` it drives a real
`BuildingSync` rather than composing models by hand — here to render the cue
itself: it stands hand-written `BuildingSnap`s in one and lets it run,
so what is on the screen is the whole chain a match draws — the panes and
wall spills `assets.ts` finds in each model's own openings, the rig
`buildingSync` harvests off it, and the level it eases and flickers. Break
the wiring and the page goes dark, which is the point of it.

```sh
pnpm dev   # then /tools/modelLab/_training.html
```

`?pair=1` stands each building beside a cold copy of itself, which is the only
comparison that matters: the cue has to read as a *difference*, not as
decoration. `?cold=1` empties the queues instead. `?t=<seconds>` freezes the
clock at a moment — stepped at the frame rate, so it is repeatable and a
series of them cuts together into a clip — and `?warm=<seconds>` runs the
light up before that freeze, since the level eases and a cold start caught at
t=0 shows nothing. `?hide=spill|pane` drops one of the glow's two layers,
which is how an invisible spill was told apart from a misplaced one.
`?only=barracks|range|castle` blows one up; `?yaw`, `?zoom`, `?fy`, `?w`,
`?h` and `?gap` frame the shot as everywhere else — and turn the camera
before judging it, since the windows on the far side are lit too.

## Publishing the gallery

```sh
node tools/modelLab/bake.mjs          # only when a variant reaches for a new pack file
node tools/modelLab/build-gallery.mjs [out.html]
```

The published page may not make a single request. An Artifact's CSP blocks
fetch and XHR outright — `data:` URIs included — so GLTFLoader cannot run
there at all, and neither can a texture load. `bake.mjs` therefore flattens
every model the compositions use down to vertex-colored arrays (see below),
into `baked.json`, and `build-gallery.mjs` inlines that beside a bundled
copy of the lab. The result is one file with no runtime dependencies of any
kind. Output defaults to `.gallery-build/gallery.html`.

`baked.json` is committed: it changes only when the set of pack files
changes, and keeping it means publishing does not need a browser.

## Screenshots

```sh
node tools/modelLab/shot.mjs <url> <out.png> [w] [h] [waitMs]
```

Headless Chromium over the DevTools protocol, no dependencies — it prints
whatever the page logged or threw, which is usually the answer. `DARK=1`
emulates a dark OS preference, `THEME=dark|light` stamps the root the way
the Artifact viewer's own toggle does, and `VIEWPORT_ONLY=1` captures one
screenful (beyond-the-viewport capture stitches tall pages in passes, and a
fixed canvas does not survive that).

## How a composition is put together

`variants.ts` holds the candidates; `kit.ts` is the toolkit they call.

- `K.base(file, w, h)` normalizes a pack model the way `makeGlbBuilding`
  does — footprint fitted to a unit square, then scaled by the short side of
  the footprint. What you see is the size the game would draw.
- `K.prop(file, { h | span, at, rot })` places a pack prop, sized by height
  or by footprint.
- `K.box/cyl/sphere/cone(..., swatch)` build hand-made parts in the pack's
  own colors, so they shade like the models beside them instead of sitting
  in their own palette. `SWATCH` holds those colors, sampled from the atlas.

There are no textures at runtime. The pack paints everything from one small
swatch atlas, so on load each vertex takes the color the atlas holds at its
own UV and the map is dropped. The look survives — the cells are flat or
vertically graded and the models' UVs already sit where they want the shade
— and it is what lets a composition be baked to plain arrays and shipped
inside a page.

One rule worth keeping: the atlas cell holding `#008454` is the team-color
slot the renderer repaints per owner, so no hand-built part may use it —
anything painted there would change color with the flag. That is why it is
absent from `SWATCH`.

## Assets

Everything here comes from Kay Lousberg's CC0 packs. The Medieval Hexagon
models the lab added (watermill, second house, fences, bridges, tent,
crates, pallet, water plants) share the atlas the game already ships, so
they cost a few kB each. The Restaurant Bits bread crate is the one prop
that drags a second texture in — the goods section says so on the card.

The paid EXTRA pack is not in this checkout, but the four models the fishery
actually uses are: `public/models/kaykit/extra/` holds the shipyard, the
docks, the anchor and the boat rack, plus the shared atlas they sample. That
is a hand-picked subset, not the pack — drop the full `Assets/gltf` folder in
beside them if you want the rest (the awning stall, the market, the herds),
and note that `extra/` carries no LICENSE.txt of its own the way the CC0
folders next to it do.

## Where the impacts land

`animImpacts.mjs` reads the rig clips' bone tracks straight out of the
GLBs (no browser, no three) and prints where each footfall plants, each
swing stops, and the death fall comes to rest — the measurements behind
`impactPhase01` in `src/audio/animCues.ts` and the death-thump delay in
`cues.ts`. Re-run it when a clip mapping in `characters.ts` changes:

```sh
node tools/modelLab/animImpacts.mjs
```

A `curve` mode prints one bone's position and speed across a clip for
judging anything the audit's heuristics summarize away:

```sh
node tools/modelLab/animImpacts.mjs curve Rig_Medium_Tools.glb Chopping handslot.r
```

## The hut roof

`reroofFishery.mjs` re-lays the fisherman's hut roof in the pack's grain.
Blender left it at 13 boards a slope, all at a dead 45 degrees; measured
after `normalize` those were 0.047 of the footprint where home_A's are
0.082 — half the pack's board with twice its line work. The script keeps 5
a slope, spread across the same span, and swings one board on each to Kay's
41.4 degrees.

That last part is where a KayKit roof's two tones come from, and it has to
be geometry: the roof column lands inside `TEAM_SWATCH_UV`, so a
faction-owned roof is drawn in one flat Lambert colour and its UVs never
reach a pixel. The kinked board reads 7/255 against its neighbours, against
6/255 for home_A's own band.

```sh
node tools/modelLab/reroofFishery.mjs
```

It runs once, on the model as Blender left it, and refuses a roof it has
already re-laid. The script is in the tree because the alternative is an
unreviewable diff in a `.bin`.
