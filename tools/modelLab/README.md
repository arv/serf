# Model lab

A sketchpad for building compositions before they earn a place in
`src/render/assets.ts`. A candidate here is a *recipe*: a KayKit model or
two, some pack props placed around it, and whatever small parts we would
have to build ourselves — all in tile coordinates, lit and framed exactly
the way the game frames a building.

Its first job was the food chain: mill, bakery, fishery, livestock, and the
goods a serf carries.

## Looking at them

```sh
pnpm dev            # then open /tools/modelLab/
```

Drag a card to turn it. `?only=<variant-id>` blows one composition up to
full width — the fastest way to judge a placement.

## Publishing the gallery

```sh
node tools/modelLab/build-gallery.mjs [out.html]
```

Bundles the lab into one classic script and inlines every model, the texture
atlas and the page's font as data URIs, so the result is a single file that
works with no network at all (which is also what a published Artifact's CSP
demands). Output defaults to `.gallery-build/gallery.html`.

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
- `K.box/cyl/sphere/cone(..., swatch)` build hand-made parts that sample one
  cell of the pack's own texture atlas, so they shade like the models beside
  them instead of sitting in their own palette. `SWATCH` lists the cells with
  their sampled hex values.

One rule worth keeping: cell `3,3` is the team-color slot the renderer
repaints per owner, so no hand-built part may point at it — anything painted
there would change color with the flag.

## Assets

Everything here comes from Kay Lousberg's CC0 packs. The Medieval Hexagon
models the lab added (watermill, second house, fences, bridges, tent,
crates, pallet, water plants) share the atlas the game already ships, so
they cost a few kB each. The Restaurant Bits bread crate is the one prop
that drags a second texture in — the goods section says so on the card.

The paid EXTRA pack is *not* in this checkout. Drop its `Assets/gltf` folder
into `public/models/kaykit` and the fishery's jetty, boats and shipyard, plus
the livestock pens' animals, stop being hand-built.
