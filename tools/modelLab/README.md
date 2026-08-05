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

The paid EXTRA pack is *not* in this checkout. Drop its `Assets/gltf` folder
into `public/models/kaykit` and the fishery's jetty, boats and shipyard stop
being hand-built.
