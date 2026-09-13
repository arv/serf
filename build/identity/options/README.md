# Icon candidates

Five directions for the app icon, drawn as SVG and rasterised by
`render.mjs` with the same headless Chromium the staging band is baked
with. `preview/` holds a 512 of each so the options can be looked at
without running anything.

    node build/identity/options/render.mjs out

| | | |
|---|---|---|
| `a-keep` | Refined keep | The mark we ship, drawn to the constraints |
| `b-hauler` | The hauler | A serf under a plank — the game's own thesis |
| `c-arms` | Heraldic arms | A wheat sheaf on a gold roundel |
| `d-isokeep` | Isometric keep | The keep as the renderer draws it |
| `e-road` | The lane | A paved road up to the gate |

Whichever wins becomes `../stable/icon-512.png`, `icon-192.png` and
`apple-touch-icon.png`, and its SVG moves next to them as the source the
staging band composites over — the same arrangement `staging/icon.html`
already documents.

## What a candidate has to clear

- **The maskable crop.** The manifest lists `icon-512.png` with
  `purpose: 'maskable'`, so Android may crop to the middle 80% — a circle
  of radius 205 on the 512 canvas. Every candidate here keeps its lit
  content inside it (furthest: `a-keep` at 198). The icon we ship today
  reaches 240.
- **48px.** The size a launcher and a tab actually draw. Silhouette and
  value contrast are what reach it; detail does not.
- **The staging band.** `../staging/icon.html` lays an amber STAGING band
  over the bottom 17%, so nothing load-bearing goes below y=425.
- **The game's key.** Pale plaster, warm timber and one gold accent, from
  `src/render/palette.ts` and `GOLD` in `src/ui/menuChrome.tsx`.
