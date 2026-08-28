import {GOLD} from '../../ui/menuChrome';

/**
 * The wiki's one sheet, scoped under #docs like MENU_STYLE is under #menu,
 * and wearing the same visual language: glass cards, hairline borders, one
 * gold accent, Space Grotesk (already @font-face'd by index.html).
 *
 * Two rules exist to undo the game's globals: index.html locks html/body to
 * overflow:hidden and user-select:none because a game owns its gestures —
 * a wiki is a document, so #docs scrolls itself and gives selection back.
 */
export const DOCS_STYLE = `
#docs { position: fixed; inset: 0; z-index: 20; overflow-y: auto; overflow-x: hidden;
  overscroll-behavior: contain; background: #0e1210; color: #e4e1d6;
  font-family: 'Space Grotesk', system-ui, sans-serif; font-size: 14px; line-height: 1.55;
  user-select: text; -webkit-user-select: text; }
#docs * { box-sizing: border-box; }

#docs a { color: ${GOLD}; text-decoration: none; }
#docs a:hover { text-decoration: underline; }
/* Colour alone does not identify a link: gold on the body's grey is about
   1.2:1 against the surrounding text, well under the 3:1 that would let
   hue carry the meaning by itself, and a hover underline reaches neither a
   touch screen nor a keyboard. So links set in running prose are underlined
   always. The ones that sit in their own affordance — a nav pill, a cost
   chip, a card — are left alone: their shape is the cue. */
#docs .lede a, #docs p a, #docs ul.refs a, #docs td a, #docs .tech a {
  text-decoration: underline; text-underline-offset: 2px;
  text-decoration-color: rgba(229,196,105,0.5); text-decoration-thickness: 1px; }
#docs .lede a:hover, #docs p a:hover, #docs ul.refs a:hover, #docs td a:hover,
#docs .tech a:hover { text-decoration-color: ${GOLD}; }
#docs td a.chip, #docs .lede a.chip, #docs p a.chip, #docs ul.refs a.chip,
#docs .tech a.chip { text-decoration: none; }
#docs a:focus-visible { outline: 2px solid rgba(229,196,105,0.55); outline-offset: 2px; border-radius: 3px; }
/* A heading focused by a page turn is a destination, not a control: it
   gets the ring only if the reader is actually navigating by keyboard. */
#docs [tabindex="-1"]:focus { outline: none; }
#docs [tabindex="-1"]:focus-visible { outline: 2px solid rgba(229,196,105,0.4); outline-offset: 4px; border-radius: 4px; }

#docs .doc-head { position: sticky; top: 0; z-index: 3; display: flex; align-items: center; gap: 14px;
  padding: calc(10px + var(--safe-top)) calc(18px + var(--safe-right)) 10px calc(18px + var(--safe-left));
  background: rgba(14,16,15,0.82); backdrop-filter: blur(18px); -webkit-backdrop-filter: blur(18px);
  border-bottom: 1px solid rgba(255,255,255,0.09); }
#docs .doc-head .kicker { font-size: 11px; font-weight: 600; letter-spacing: 0.3em;
  text-transform: uppercase; color: #cbbd93; white-space: nowrap; }
#docs .doc-head .kicker a { color: inherit; }
#docs .doc-head .back { margin-left: auto; font-size: 12.5px; white-space: nowrap; }

#docs .doc-body { display: grid; grid-template-columns: 180px minmax(0, 860px); gap: 26px;
  max-width: 1120px; margin: 0 auto;
  padding: 22px calc(18px + var(--safe-right)) calc(60px + var(--safe-bottom)) calc(18px + var(--safe-left)); }

#docs .doc-nav { position: sticky; top: 74px; align-self: start; display: flex; flex-direction: column; gap: 2px; }
#docs .doc-nav a { padding: 6px 10px; border-radius: 8px; font-size: 13px; color: #b3b1a6; }
#docs .doc-nav a:hover { color: #f0ede4; background: rgba(255,255,255,0.04); text-decoration: none; }
#docs .doc-nav a.on { color: #f5e4b6; background: rgba(229,196,105,0.14); }

#docs main { min-width: 0; }
#docs h1 { margin: 0 0 4px; font-size: 30px; font-weight: 500; letter-spacing: 0.04em; color: #f4f1e6; }
#docs h2 { margin: 30px 0 10px; font-size: 13px; font-weight: 600; letter-spacing: 0.18em;
  text-transform: uppercase; color: #cbbd93; }
#docs .lede { margin: 0 0 18px; color: #a9a698; max-width: 62ch; text-wrap: pretty; }
/* The same voice as the page's lede, sitting under a section heading
   rather than a title: tighter above, because the h2's own margin is
   already the gap, and tighter below, because the tiles it introduces
   are the next line rather than the next section. */
#docs .group-lede { margin: -2px 0 12px; color: #a9a698; max-width: 62ch; text-wrap: pretty; }
#docs .crumb { font-size: 12px; letter-spacing: 0.08em; text-transform: uppercase; color: #85857c; }

/* Grid pages: glass tiles. The whole tile is one link. */
#docs .tiles { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 12px; }
#docs .tile { position: relative; display: flex; flex-direction: column; gap: 8px; padding: 14px;
  background: rgba(14,16,15,0.74); border: 1px solid rgba(255,255,255,0.09); border-radius: 16px;
  color: #e4e1d6; transition: border-color 0.15s, background 0.15s; }
#docs .tile:hover { border-color: rgba(229,196,105,0.4); background: rgba(20,22,20,0.8); text-decoration: none; }
#docs .tile .t-name { font-size: 15px; font-weight: 600; color: #f2efe4; }
#docs .tile .t-sub { font-size: 12px; color: #85857c; }
/* A tile that carries links of its own cannot be one: the name's anchor is
   stretched over the card instead, and anything else interactive is lifted
   above it. Keeps one big click target without nesting controls. */
#docs .tile a.stretch::after { content: ''; position: absolute; inset: 0; border-radius: 16px; }
#docs .tile a.stretch:hover { text-decoration: none; }
#docs .tile .costs { position: relative; z-index: 1; align-self: flex-start; }

/* Stat rows: a def-list with hairline separators, numbers right and tabular. */
#docs .stats { display: flex; flex-direction: column; margin: 0; padding: 4px 16px;
  background: rgba(14,16,15,0.74); border: 1px solid rgba(255,255,255,0.09); border-radius: 16px; }
#docs .stats > div { display: flex; align-items: baseline; justify-content: space-between; gap: 18px;
  padding: 9px 0; border-top: 1px solid rgba(255,255,255,0.07); }
#docs .stats > div:first-child { border-top: none; }
#docs .stats dt { font-size: 12.5px; letter-spacing: 0.04em; color: #94958c; }
#docs .stats dd { margin: 0; text-align: right; font-variant-numeric: tabular-nums; color: #e9e6da; }

/* Cost chips: the real GoodIcon beside a tabular amount, each chip a link. */
#docs .costs { display: inline-flex; flex-wrap: wrap; gap: 6px; vertical-align: middle; }
/* inline-block, not inline-flex: a chip is often set in a sentence ("needs
   a [Cauldron] from the Smith"), and an inline-flex box takes its baseline
   from its first flex item — the icon — which drops the whole pill below
   the line. An inline-block's baseline is its last line box, i.e. the
   chip's own text, so it sits on the sentence's baseline for free. */
#docs .chip { display: inline-block; padding: 2px 8px;
  background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.1); border-radius: 999px;
  font-size: 12.5px; font-variant-numeric: tabular-nums; color: #e4e1d6; white-space: nowrap; }
#docs .chip > * + * { margin-left: 5px; }
#docs a.chip:hover { border-color: rgba(229,196,105,0.45); text-decoration: none; }
#docs .chip.free { color: #85857c; font-style: italic; }

/* Tables are the one thing here wider than a phone. #docs hides its own
   horizontal overflow (a wiki that slides sideways under a thumb reads as
   broken), so without a scroller of their own the far columns would simply
   be unreachable — the commands page keeps its payloads out there. */
#docs .scroll-x { overflow-x: auto; overscroll-behavior-x: contain;
  scrollbar-width: thin; scrollbar-color: rgba(229,196,105,0.3) transparent; }
#docs table { width: 100%; border-collapse: collapse; background: rgba(14,16,15,0.74);
  border: 1px solid rgba(255,255,255,0.09); border-radius: 16px; overflow: hidden; }
#docs th { padding: 9px 14px; text-align: left; font-size: 11.5px; font-weight: 600;
  letter-spacing: 0.14em; text-transform: uppercase; color: #94958c;
  border-bottom: 1px solid rgba(255,255,255,0.09); }
#docs td { padding: 9px 14px; border-top: 1px solid rgba(255,255,255,0.06);
  font-variant-numeric: tabular-nums; vertical-align: baseline; }
#docs tr:first-child td { border-top: none; }

#docs ul.refs { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 6px; }
#docs ul.refs li { color: #b3b1a6; }

/* Model cards: the stage keeps its shape before the shot lands, so the page
   never reflows under the reader as previews arrive. */
#docs .stage { position: relative; aspect-ratio: 4 / 3; border-radius: 12px; overflow: hidden;
  background: radial-gradient(ellipse 70% 60% at 50% 45%, rgba(127,154,80,0.14), rgba(10,12,10,0.4) 100%);
  touch-action: pan-y; }
#docs .stage canvas { position: absolute; inset: 0; width: 100%; height: 100%; display: block; }
#docs .stage.grabbable { cursor: grab; }
#docs .stage.grabbable:active { cursor: grabbing; }
#docs .stage .fallback { position: absolute; inset: 0; display: grid; place-items: center; color: #6f7169; }
#docs .stage.loading::after { content: ''; position: absolute; inset: 0;
  background: linear-gradient(100deg, transparent 30%, rgba(255,255,255,0.05) 50%, transparent 70%);
  background-size: 220% 100%; animation: docs-shimmer 1.4s linear infinite; }
@keyframes docs-shimmer { from { background-position: 130% 0; } to { background-position: -90% 0; } }
@media (prefers-reduced-motion: reduce) { #docs .stage.loading::after { animation: none; } }
#docs .hero { max-width: 460px; margin-bottom: 18px; }
#docs .hero .stage { border-radius: 16px; border: 1px solid rgba(255,255,255,0.09); }
#docs .hero .hint { margin-top: 6px; font-size: 11.5px; color: #6f7169; text-align: center; }
/* Coarse pointers get the same turn gesture, but "drag" is what a mouse
   does; the phone is already holding the thing. */
@media (hover: none) { #docs .hero .hint { display: none; } }

/* The clip picker under an animated unit. Same well-and-pill vocabulary as
   the menu's tab bar, at panel scale. */
#docs .anim-bar { display: grid; grid-auto-flow: column; grid-auto-columns: minmax(0, 1fr);
  gap: 2px; padding: 3px; margin-top: 10px; background: rgba(0,0,0,0.38); border-radius: 10px; }
#docs .anim-bar button { min-width: 0; cursor: pointer; padding: 7px 6px; font: inherit;
  font-size: 12px; font-weight: 600; letter-spacing: 0.04em; color: #94958c;
  background: transparent; border: none; border-radius: 8px; transition: background 0.15s, color 0.15s; }
#docs .anim-bar button:hover { color: #f0ede4; }
#docs .anim-bar button.on { color: #f5e4b6; background: rgba(229,196,105,0.16); }
#docs .anim-bar button:focus-visible { outline: 2px solid rgba(229,196,105,0.55); outline-offset: -2px; }

/* Tech cards, anchored for #tech-<id> links. */
#docs .tech { padding: 14px 16px; margin-bottom: 10px; background: rgba(14,16,15,0.74);
  border: 1px solid rgba(255,255,255,0.09); border-radius: 16px; scroll-margin-top: 84px; }
#docs .tech:target { border-color: rgba(229,196,105,0.55); }
#docs .tech .t-head { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }
#docs .tech .t-head .name { font-size: 15px; font-weight: 600; color: #f2efe4; }
#docs .tech .t-head .meta { font-size: 12px; color: #85857c; font-variant-numeric: tabular-nums; }
#docs .tech p { margin: 6px 0 0; color: #b3b1a6; }

#docs .missing { padding: 40px 20px; text-align: center; color: #a9a698; }

@media (max-width: 720px) {
  #docs .doc-body { grid-template-columns: minmax(0, 1fr); gap: 14px; padding-top: 12px; }
  #docs .doc-nav { position: static; flex-direction: row; flex-wrap: wrap; gap: 4px; }
  #docs .doc-nav a { padding: 7px 12px; background: rgba(255,255,255,0.04); border-radius: 999px; }
  #docs h1 { font-size: 24px; }
  /* Give the far columns somewhere to go rather than letting them wrap to
     one word per line. */
  #docs .scroll-x table { min-width: 560px; }
  #docs h2 { margin-top: 24px; }
}
/* The narrowest phones still in service: the masthead is the first thing
   that will not fit beside a back link, so it gives way rather than
   pushing the link off the edge. */
@media (max-width: 420px) {
  #docs .doc-head { gap: 10px; }
  #docs .doc-head .kicker .wide { display: none; }
  #docs .doc-head .kicker { min-width: 0; overflow: hidden; text-overflow: ellipsis;
    letter-spacing: 0.2em; }
  #docs .doc-head .back { font-size: 12px; }
  #docs .tiles { grid-template-columns: minmax(0, 1fr); }
  #docs .stats { padding: 4px 12px; }
  #docs .anim-bar button { padding: 8px 4px; font-size: 11.5px; letter-spacing: 0; }
}
`;
