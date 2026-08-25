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
