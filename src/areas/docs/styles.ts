import {
  CHUNKY_SMALL,
  CHUNKY_STONE,
  COMIC_LETTERING,
  INK_RING,
  WOOD_TOKENS,
  chunkyButton,
} from '../../ui/woodStyle';

/**
 * Carved grain for the boards, as the signpost's arrows have it: noise
 * stretched along the plank, kept only where it is darkest, in the ink's
 * own brown. Soft enough that a paragraph set on it still reads.
 *
 * The tile holds a whole number of noise periods each way (1200 × 0.0025
 * = 3, 400 × 0.07 = 28), which with stitchTiles is what lets it repeat
 * without a seam; keep them whole when retuning either.
 */
const GRAIN = encodeURIComponent(
  `<svg xmlns='http://www.w3.org/2000/svg' width='1200' height='400'>` +
    `<filter id='g'>` +
    `<feTurbulence type='fractalNoise' baseFrequency='0.0025 0.07' numOctaves='3' seed='11' stitchTiles='stitch'/>` +
    `<feColorMatrix values='0 0 0 0 0.23  0 0 0 0 0.11  0 0 0 0 0.06  1.6 0 0 0 -0.62'/>` +
    `</filter>` +
    `<rect width='100%' height='100%' filter='url(#g)'/>` +
    `</svg>`,
);

/** A plank: the grain over the signpost's crate wood, lit from above. */
const WOOD = `url("data:image/svg+xml,${GRAIN}"), linear-gradient(#b0704f, #95563b)`;

/**
 * Everything set on the board as a cream panel. Spelled out per selector
 * rather than through :is(), for woodStyle's reason: :is() forgives a
 * malformed selector by dropping it, and a typo here should show.
 */
const PANELS = ['.tile', '.stats', 'table', '.tech', '.credit'];
const panels = (suffix = ''): string =>
  PANELS.map(p => `#docs ${p}${suffix}`).join(', ');

/**
 * The wiki's one sheet, scoped under #docs like SIGNPOST_STYLE is under
 * #menu, and wearing the start screen's look (its palette, lettering and
 * buttons come from woodStyle.ts): the valley's sky behind,
 * wooden boards, Lilita One lettering in cream with a thick ink outline,
 * cream panels outlined in ink, and gold for whatever is chosen.
 *
 * The signpost's rules for colour: on wood, words are cream with an ink
 * drop under them; on a cream panel, words are ink. Every panel, pill and
 * chip is outlined in ink and stands on a ledge of it.
 *
 * Two rules exist to undo the game's globals: index.html locks html/body to
 * overflow:hidden and user-select:none because a game owns its gestures —
 * a wiki is a document, so #docs scrolls itself and gives selection back.
 */
export const DOCS_STYLE = `
#docs {${WOOD_TOKENS}
  --paper: #fbeed3;
  /* Words on a cream panel that are not the ink itself: labels, notes. */
  --umber: #8a5a3c;
  /* A link set in words: on wood, the menu's hover gold; on cream, a
     burnt orange that keeps 5:1 against the panel. */
  --link-wood: #ffe39a;
  --link-paper: #9c4418;
  /* The parchment a step back, for the asides on the wood: crumbs, hints,
     notes. Mixed from the token so a retune of either reaches both. */
  --parchment-soft: color-mix(in srgb, var(--parchment) 85%, transparent);
  /* A cream well's bevel, and the ledge of ink it stands on. */
  --well-bevel: inset 0 -3px 0 rgba(160,110,60,0.25);
  --well-ledge: rgba(59,29,16,0.55);
  position: fixed; inset: 0; z-index: 20; overflow-y: auto; overflow-x: hidden;
  overscroll-behavior: contain;
  /* The sky over the valley (signpost/sky.ts): deep overhead, pale at the
     horizon, with a few soft clouds. On the scroller itself, so it stays
     put while the boards scroll over it. */
  background:
    radial-gradient(ellipse 16% 5% at 18% 14%, rgba(255,255,255,0.75), transparent),
    radial-gradient(ellipse 22% 6% at 74% 9%, rgba(255,255,255,0.6), transparent),
    radial-gradient(ellipse 14% 4% at 88% 38%, rgba(255,255,255,0.45), transparent),
    radial-gradient(ellipse 18% 5% at 8% 62%, rgba(255,255,255,0.4), transparent),
    linear-gradient(#3a8ee0, #7db8ec 55%, #a6d0f0);
  color: var(--cream);
  font-family: 'Nunito', system-ui, sans-serif; font-weight: 700;
  font-size: 15px; line-height: 1.55;
  user-select: text; -webkit-user-select: text;
  scrollbar-color: #95563b transparent;
}
#docs * { box-sizing: border-box; }
#docs ::selection { background: #ffd66b; color: var(--ink); }

#docs a { color: var(--link-wood); text-decoration: none; }
#docs a:hover { text-decoration: underline; }
/* Colour alone does not identify a link: a hover underline reaches
   neither a touch screen nor a keyboard. So links set in running prose are
   underlined always. The ones that sit in their own affordance — a nav
   pill, a cost chip, a card — are left alone: their shape is the cue. */
#docs .lede a, #docs p a, #docs ul.refs a, #docs td a, #docs .tech a {
  text-decoration: underline; text-underline-offset: 2px;
  text-decoration-thickness: 1.5px; }
#docs td a.chip, #docs .lede a.chip, #docs p a.chip, #docs ul.refs a.chip,
#docs .tech a.chip { text-decoration: none; }
/* No border-radius here: the outline follows each control's own shape,
   and setting one would square off a chip or a tile while it has focus. */
#docs a:focus-visible, #docs button:focus-visible {
  outline: 3px solid var(--ink); outline-offset: 2px; }
/* A heading focused by a page turn is a destination, not a control: it
   gets the ring only if the reader is actually navigating by keyboard. */
#docs [tabindex="-1"]:focus { outline: none; }
#docs [tabindex="-1"]:focus-visible { outline: 3px solid var(--cream); outline-offset: 4px; }

#docs code { font-family: ui-monospace, monospace; font-size: 0.86em; font-weight: 600;
  padding: 0 4px; border-radius: 4px; background: rgba(59,29,16,0.14); }

/* Outlined comic lettering, as on the signpost: the stroke is painted
   under the fill, the drop below is the same ink again. */
#docs h1, #docs h2, #docs .doc-head .kicker {${COMIC_LETTERING}}

/* ——— The head: a plank across the top ——— */
#docs .doc-head { position: sticky; top: 0; z-index: 3; display: flex; align-items: center; gap: 14px;
  padding: calc(10px + var(--safe-top)) calc(18px + var(--safe-right)) 12px calc(18px + var(--safe-left));
  background: ${WOOD};
  border-bottom: 4px solid var(--ink);
  box-shadow: inset 0 3px 0 rgba(255,255,255,0.18), 0 4px 0 rgba(59,29,16,0.35); }
#docs .doc-head .kicker { font-size: 26px; line-height: 1.1; letter-spacing: 0.02em; white-space: nowrap; }
#docs .doc-head .kicker a { color: inherit; text-decoration: none; }
/* The signpost's stone Back button, at its size. */
#docs .doc-head .back {${CHUNKY_SMALL}${CHUNKY_STONE}
  margin-left: auto; white-space: nowrap;
  font-family: var(--comic), sans-serif; font-size: 17px; line-height: 1.2;
  padding: 3px 14px 5px; border-radius: 14px; }
#docs .doc-head .back:hover { text-decoration: none; }
${chunkyButton('#docs .doc-head .back')}

#docs .doc-body { display: grid; grid-template-columns: 190px minmax(0, 880px); gap: 22px;
  max-width: 1140px; margin: 0 auto;
  padding: 24px calc(18px + var(--safe-right)) calc(60px + var(--safe-bottom)) calc(18px + var(--safe-left)); }

/* ——— The nav: the boards' segmented choice, stood on end ——— */
/* Level with the board: the head's height plus the body's top padding. */
#docs .doc-nav { position: sticky; top: calc(84px + var(--safe-top)); align-self: start; display: flex; flex-direction: column; gap: 3px;
  padding: 4px; background: var(--paper); border: 3px solid var(--ink); border-radius: 14px;
  box-shadow: var(--well-bevel), 0 4px 0 var(--well-ledge); }
#docs .doc-nav a { padding: 5px 12px 6px; border: 3px solid transparent; border-radius: 9px;
  font-family: var(--comic), sans-serif; font-size: 18px; line-height: 1.2; color: var(--umber);
  transition: color 0.15s, background-color 0.15s; }
#docs .doc-nav a:hover { color: var(--ink); background: rgba(240,163,58,0.18); text-decoration: none; }

/* ——— The board the page is written on ——— */
#docs main { min-width: 0; padding: 22px 28px 32px;
  background: ${WOOD};
  border: 4px solid var(--ink); border-radius: 22px;
  box-shadow: inset 0 4px 0 rgba(255,255,255,0.18), inset 0 -8px 0 rgba(80,35,15,0.3), 0 8px 0 var(--ink);
  /* Words on the wood: cream, with the ink's drop under them so they
     stand off the grain, as the boards' one-liners do. */
  text-shadow: 0 1.5px 0 rgba(59,29,16,0.7); }
#docs h1 { margin: 0 0 6px; font-size: 44px; line-height: 1.05; letter-spacing: 0.02em; }
#docs h2 { margin: 30px 0 10px; font-size: 24px; line-height: 1.15; letter-spacing: 0.02em;
  -webkit-text-stroke: 5px var(--ink); text-shadow: 0 2px 0 var(--ink); }
#docs .lede { margin: 0 0 18px; max-width: 64ch; color: var(--parchment); text-wrap: pretty; }
/* The same voice as the page's lede, sitting under a section heading
   rather than a title: tighter above, because the h2's own margin is
   already the gap, and tighter below, because the tiles it introduces
   are the next line rather than the next section. */
#docs .group-lede { margin: -2px 0 12px; max-width: 64ch; color: var(--parchment); text-wrap: pretty; }
#docs .crumb { margin: 0 0 4px; font-size: 13px; letter-spacing: 0.08em; text-transform: uppercase;
  color: var(--parchment-soft); }

/* ——— Cream panels ———
   Everything set on the board — tiles, stat cards, tables, tech and
   credit cards — is the boards' cream box: outlined in ink, standing on a
   ledge. Inside one the words go to ink and lose the drop. */
${panels()} {
  background: var(--paper); color: var(--ink); text-shadow: none;
  border: 3px solid var(--ink); border-radius: 14px;
  box-shadow: var(--well-bevel), 0 4px 0 var(--well-ledge); }
${panels(' a')} { color: var(--link-paper); }

/* Grid pages: tiles. The whole tile is one link, and it behaves like the
   signpost's buttons: a touch brighter under the pointer, and pressed, it
   sinks onto its ledge. */
#docs .tiles { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 14px; }
#docs .tile { position: relative; display: flex; flex-direction: column; gap: 8px; padding: 12px;
  transition: transform 0.06s ease, box-shadow 0.06s ease, background-color 0.15s; }
#docs .tile:hover { background-color: var(--cream); text-decoration: none; }
/* Only the tile's own link: a chip lifted above it is a press elsewhere. */
#docs a.tile:active, #docs .tile:has(a.stretch:active) { transform: translateY(3px);
  box-shadow: var(--well-bevel), 0 1px 0 var(--well-ledge); }
#docs .tile .t-name { font-family: var(--comic), sans-serif; font-weight: 400; font-size: 20px;
  line-height: 1.15; color: var(--ink); }
#docs .tile .t-sub { font-size: 13px; line-height: 1.4; color: var(--umber); }
/* A tile that carries links of its own cannot be one: the name's anchor is
   stretched over the card instead, and anything else interactive is lifted
   above it. Keeps one big click target without nesting controls. */
#docs .tile a.stretch { color: var(--ink); }
#docs .tile a.stretch::after { content: ''; position: absolute; inset: 0; border-radius: 12px; }
#docs .tile a.stretch:hover { text-decoration: none; }
#docs .tile .costs { position: relative; z-index: 1; align-self: flex-start; }

/* Stat rows: a def-list with hairline separators, numbers right and tabular. */
#docs .stats { display: flex; flex-direction: column; margin: 0; padding: 4px 16px; }
#docs .stats > div { display: flex; align-items: baseline; justify-content: space-between; gap: 18px;
  padding: 9px 0; border-top: 2px dotted rgba(59,29,16,0.2); }
#docs .stats > div:first-child { border-top: none; }
#docs .stats dt { font-size: 13.5px; color: var(--umber); }
#docs .stats dd { margin: 0; text-align: right; font-weight: 800; font-variant-numeric: tabular-nums; }

/* Cost chips: the real GoodIcon beside a tabular amount, each chip a link —
   a little cream pill in ink, on wood and on a panel alike. */
#docs .costs { display: inline-flex; flex-wrap: wrap; gap: 6px; vertical-align: middle; }
/* inline-block, not inline-flex: a chip is often set in a sentence ("needs
   a [Cauldron] from the Smith"), and an inline-flex box takes its baseline
   from its first flex item — the icon — which drops the whole pill below
   the line. An inline-block's baseline is its last line box, i.e. the
   chip's own text, so it sits on the sentence's baseline for free. */
#docs .chip, #docs a.chip { display: inline-block; padding: 1px 9px 2px;
  background: var(--cream); border: 2px solid var(--ink); border-radius: 999px;
  box-shadow: 0 2px 0 var(--well-ledge);
  font-size: 13px; font-weight: 800; line-height: 1.45; font-variant-numeric: tabular-nums;
  color: var(--ink); text-shadow: none; white-space: nowrap; }
#docs .chip > * + * { margin-left: 5px; }
#docs a.chip:hover { background: var(--gold); text-decoration: none; }
#docs .chip.free { color: var(--umber); font-style: italic; font-weight: 700; }

/* Tables are the one thing here wider than a phone. #docs hides its own
   horizontal overflow (a wiki that slides sideways under a thumb reads as
   broken), so without a scroller of their own the far columns would simply
   be unreachable — the commands page keeps its payloads out there. The
   scroller leaves room for the table's ledge, which it would otherwise
   clip. */
#docs .scroll-x { overflow-x: auto; overscroll-behavior-x: contain; padding-bottom: 5px;
  scrollbar-width: thin; scrollbar-color: rgba(59,29,16,0.5) transparent; }
#docs table { width: 100%; border-collapse: separate; border-spacing: 0; overflow: hidden; }
#docs th { padding: 9px 14px 7px; text-align: left;
  font-family: var(--comic), sans-serif; font-weight: 400; font-size: 16px; letter-spacing: 0.02em;
  color: var(--umber); border-bottom: 3px solid var(--ink); }
#docs td { padding: 9px 14px; border-top: 2px dotted rgba(59,29,16,0.2);
  font-variant-numeric: tabular-nums; vertical-align: baseline; }
#docs tr:first-child td { border-top: none; }
/* A row that needs a line of why, under the what — the difficulty grid's
   knobs mean nothing from their names alone. Sits inside the first cell so
   the numeric columns stay on one baseline. */
#docs td .row-note { margin-top: 3px; font-size: 12.5px; line-height: 1.45;
  color: var(--umber); font-variant-numeric: normal; max-width: 34ch; }

#docs ul.refs { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 6px; }
#docs ul.refs li { color: var(--parchment); }

/* Model cards: the stage keeps its shape before the shot lands, so the page
   never reflows under the reader as previews arrive. The model stands
   under the valley's own sky. */
#docs .stage { position: relative; aspect-ratio: 4 / 3; border-radius: 9px; overflow: hidden;
  background: linear-gradient(#5aa2e6, #bfe0f6); border: 2px solid var(--ink);
  touch-action: pan-y; }
#docs .stage canvas { position: absolute; inset: 0; width: 100%; height: 100%; display: block; }
#docs .stage.grabbable { cursor: grab; }
#docs .stage.grabbable:active { cursor: grabbing; }
#docs .stage .fallback { position: absolute; inset: 0; display: grid; place-items: center; color: rgba(59,29,16,0.55); }
#docs .stage.loading::after { content: ''; position: absolute; inset: 0;
  background: linear-gradient(100deg, transparent 30%, rgba(255,255,255,0.3) 50%, transparent 70%);
  background-size: 220% 100%; animation: docs-shimmer 1.4s linear infinite; }
@keyframes docs-shimmer { from { background-position: 130% 0; } to { background-position: -90% 0; } }
/* Reduced motion: the shimmer holds still, and a pressed tile lands
   without travelling, as woodStyle's chunky buttons do. */
@media (prefers-reduced-motion: reduce) {
  #docs .stage.loading::after { animation: none; }
  #docs .tile { transition: none; }
}
#docs .hero { max-width: 460px; margin-bottom: 18px; }
#docs .hero .stage { border-width: 3px; border-radius: 14px; box-shadow: 0 4px 0 var(--well-ledge); }
#docs .hero .hint { margin-top: 8px; font-size: 12.5px; color: var(--parchment-soft); text-align: center; }
/* Coarse pointers get the same turn gesture, but "drag" is what a mouse
   does; the phone is already holding the thing. */
@media (hover: none) { #docs .hero .hint { display: none; } }

/* The clip picker under an animated unit: the boards' segmented choice —
   a cream well, and the chosen clip in gold with its word outlined. */
#docs .anim-bar { display: grid; grid-auto-flow: column; grid-auto-columns: minmax(0, 1fr);
  gap: 3px; padding: 3px; margin-top: 10px; background: var(--paper);
  border: 3px solid var(--ink); border-radius: 12px; text-shadow: none;
  box-shadow: var(--well-bevel), 0 3px 0 var(--well-ledge); }
#docs .anim-bar button { min-width: 0; cursor: pointer; padding: 3px 4px 4px;
  font: inherit; font-family: var(--comic), sans-serif; font-size: 16px; color: var(--umber);
  background: none; border: 3px solid transparent; border-radius: 8px;
  transition: color 0.15s, background-color 0.15s; }
#docs .anim-bar button:hover { color: var(--ink); }
/* The chosen option, in the nav and the clip picker alike: gold, outlined
   in ink, its word outlined too. After both hovers, so it keeps its cream. */
#docs .doc-nav a.on, #docs .anim-bar button.on { color: var(--cream); background: var(--gold); border-color: var(--ink);
  -webkit-text-stroke: 4px var(--ink); paint-order: stroke fill;
  --ring: 2.4px; text-shadow: ${INK_RING};
  box-shadow: inset 0 2px 0 rgba(255,255,255,0.45); }
#docs .anim-bar button:active { translate: 0 2px; }

/* Tech cards, anchored for #tech-<key> links (routes.ts techAnchor). The
   one linked to wears a gold ring round its ink. */
#docs .tech { padding: 12px 16px 14px; margin-bottom: 12px; scroll-margin-top: calc(96px + var(--safe-top)); }
#docs .tech:target { box-shadow: var(--well-bevel), 0 0 0 4px #ffd66b, 0 4px 0 4px var(--well-ledge); }
#docs .tech .t-head { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }
#docs .tech .t-head .name { font-family: var(--comic), sans-serif; font-size: 20px; line-height: 1.15; }
#docs .tech .t-head .meta { font-size: 13px; color: var(--umber); font-variant-numeric: tabular-nums; }
#docs .tech p { margin: 6px 0 0; }

#docs .missing { padding: 40px 20px; text-align: center; }

/* Credits: one card per project, the mark on the left, the thanks on the
   right. The art box keeps one size whatever it holds — a PNG badge, an
   inline SVG, two letters of the typeface itself. */
#docs .credits { display: flex; flex-direction: column; gap: 14px; max-width: 740px; }
#docs .credit { display: flex; gap: 16px; padding: 14px; }
#docs .credit .c-art { flex: none; width: 96px; height: 96px; display: grid; place-items: center;
  background: var(--cream); border: 2px solid var(--ink); border-radius: 10px; color: var(--ink); }
#docs .credit .c-art img { display: block; width: 88px; height: 88px; }
#docs .credit .c-aa { font-size: 40px; }
#docs .credit .c-name { font-family: var(--comic), sans-serif; font-size: 20px; line-height: 1.15; }
#docs .credit .c-what { margin: 4px 0 8px; text-wrap: pretty; }
#docs .credit .c-links { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 14px; font-size: 13px; }
#docs .c-note { margin-top: 18px; font-size: 13px; color: var(--parchment-soft); max-width: 64ch; text-wrap: pretty; }

@media (max-width: 720px) {
  #docs .doc-body { grid-template-columns: minmax(0, 1fr); gap: 16px; padding-top: 14px; }
  /* The nav lies down: the same cream well, its choices wrapping. */
  #docs .doc-nav { position: static; flex-direction: row; flex-wrap: wrap; }
  #docs .doc-nav a { padding: 3px 10px 4px; font-size: 16px; }
  #docs main { padding: 16px 16px 24px; border-width: 3px; border-radius: 18px;
    box-shadow: inset 0 3px 0 rgba(255,255,255,0.18), inset 0 -6px 0 rgba(80,35,15,0.3), 0 6px 0 var(--ink); }
  #docs h1 { font-size: 34px; }
  #docs .doc-head .kicker { font-size: 22px; }
  /* Give the far columns somewhere to go rather than letting them wrap to
     one word per line. */
  #docs .scroll-x table { min-width: 560px; }
  #docs h2 { margin-top: 24px; font-size: 22px; }
}
/* The narrowest phones still in service: the masthead is the first thing
   that will not fit beside a back link, so it gives way rather than
   pushing the link off the edge. */
@media (max-width: 420px) {
  #docs .doc-head { gap: 10px; }
  #docs .doc-head .kicker .wide { display: none; }
  #docs .doc-head .kicker { min-width: 0; overflow: hidden; text-overflow: ellipsis; font-size: 20px; }
  #docs .doc-head .back { font-size: 15px; padding: 2px 10px 4px; }
  #docs .tiles { grid-template-columns: minmax(0, 1fr); }
  #docs .stats { padding: 4px 12px; }
  /* The narrowest phones: a 96px mark beside prose leaves the prose one
     word wide, so the mark gives up size rather than the words. */
  #docs .credit .c-art { width: 64px; height: 64px; }
  #docs .credit .c-art img { width: 56px; height: 56px; }
  #docs .credit .c-art svg { width: 44px; height: 44px; }
  #docs .credit .c-aa { font-size: 28px; }
  #docs .anim-bar button { padding: 4px 2px; font-size: 14px; }
}
`;
