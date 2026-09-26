/**
 * The signpost's look, as pieces of CSS: the start screen's boards
 * (signpost/style.ts) are built from them, and so are the HUD's wood cards
 * (Hud.tsx) — the dialogs that stop a match wear the sign it started from.
 * One place for the palette, the outlined lettering and the chunky buttons,
 * so a retune of either screen reaches the other.
 *
 * Everything here is a string to interpolate into a style sheet: token and
 * variant blocks are declarations for a rule the caller writes, and
 * chunkyButton() writes whole rules for a selector it is handed.
 */

/** The outline and drop under every word on the sign. */
export const INK = '#3b1d10';
/** The lettering's fill. */
export const CREAM = '#fff4dc';

/** The palette as custom properties, declared on each root that wears the
 * look; everything below reads them. */
export const WOOD_TOKENS = `
  --comic: 'Lilita One';
  --ink: ${INK};
  --cream: ${CREAM};
  /* Small text on the wood, over a soft drop of ink. */
  --parchment: #ffe9c2;
  --note-drop: 0 2px 0 rgba(59, 29, 16, 0.6);
  --gold: linear-gradient(#ffd66b, #f0a33a);
  --stone: linear-gradient(#b9c6cc, #7f8c92);
`;

/** Outlined comic lettering: the stroke is painted under the fill, the
 * drop below is the same ink again. Sized in em, so it scales with the
 * font-size the caller sets. */
export const COMIC_LETTERING = `
  font-family: var(--comic), sans-serif;
  font-weight: 400;
  color: var(--cream);
  -webkit-text-stroke: 0.18em var(--ink);
  paint-order: stroke fill;
  text-shadow: 0 0.09em 0 var(--ink);
`;

/**
 * A text outline as a ring of hard shadows var(--ring) out, in ink. Under
 * a text stroke it fills the hole of each letter: the stroke alone only
 * just meets itself in the middle of an o, and where its two soft edges
 * meet the fill shows through as a dot. On its own it is an outline that
 * stays round at every corner, where a stroke mitres into spikes.
 */
export const INK_RING = Array.from({length: 24}, (_, i) => {
  const a = (i / 24) * 2 * Math.PI;
  const x = Number(Math.cos(a).toFixed(3));
  const y = Number(Math.sin(a).toFixed(3));
  return `calc(var(--ring) * ${x}) calc(var(--ring) * ${y}) 0 var(--ink)`;
}).join(',\n    ');

/* Chunky buttons come in two sizes and two finishes; a button takes one of
   each, declared on its own rule beside the size and padding it sets. */

/** The Play button's weight: a thick rim, a deep ledge. */
export const CHUNKY_BIG = `
  --rim: 4px; --ledge: 6px; --stroke: 6px; --ring: 3.4px;
  --hi: 3px; --lo: 5px;
`;
/** Back's weight: everything a notch thinner. */
export const CHUNKY_SMALL = `
  --rim: 3px; --ledge: 4px; --stroke: 5px; --ring: 2.9px;
  --hi: 2px; --lo: 3px;
`;
/** Gold: the thing the board is asking for. */
export const CHUNKY_GOLD = `
  --face: var(--gold);
  --lit: rgba(255, 255, 255, 0.45);
  --shade: rgba(160, 80, 20, 0.45);
`;
/** Stone: the other ways out. */
export const CHUNKY_STONE = `
  --face: var(--stone);
  --lit: rgba(255, 255, 255, 0.4);
  --shade: rgba(40, 50, 55, 0.35);
`;

/**
 * The chunky button's rules for `sel` (a selector list): flat fill, thick
 * ink outline, cream lettering, a solid ledge under it that it sinks into
 * when pressed. Every button it matches needs a size and a finish above.
 *
 * `sel` goes inside :is(), so the rules weigh what its heaviest selector
 * does, plus the state they add.
 */
export function chunkyButton(sel: string): string {
  const is = `:is(${sel})`;
  const bevel =
    'inset 0 var(--hi) 0 var(--lit), inset 0 calc(-1 * var(--lo)) 0 var(--shade)';
  return `
${is} {
  color: var(--cream);
  -webkit-text-stroke: var(--stroke) var(--ink);
  paint-order: stroke fill;
  text-shadow:
    ${INK_RING};
  border: var(--rim) solid var(--ink);
  background: var(--face);
  box-shadow: ${bevel}, 0 var(--ledge) 0 var(--ink);
  transition:
    transform 0.06s ease,
    box-shadow 0.06s ease;
}
/* Restated under the pointer, so a host sheet's own button hover (the
   HUD's glass one) cannot repaint the face. */
${is}:hover:not(:disabled) {
  border-color: var(--ink);
  background: var(--face);
}
/* Lit only where a cursor hovers: a tap leaves a button in :hover, and a
   lit face would stay stuck on after it. */
@media (hover: hover) {
  ${is}:hover:not(:disabled) { filter: brightness(1.08); }
}
/* Pressed: the button sinks by exactly the ledge it loses, so its bottom
   edge — the ledge's foot — stays where it was. */
${is}:active:not(:disabled) {
  transform: translateY(calc(var(--ledge) - 1px));
  box-shadow: ${bevel}, 0 1px 0 var(--ink);
}
/* Not yours to press: the finish goes to worn wood, and it neither lights
   nor sinks. Painted outright rather than through the finish's custom
   properties, so no finish rule, however it is written, paints over it. */
${is}:disabled {
  cursor: default;
  color: #f3e6cb;
  border: var(--rim) solid var(--ink);
  background: linear-gradient(#d8c29c, #b59b72);
  filter: none;
  transform: none;
  box-shadow:
    inset 0 var(--hi) 0 rgba(255, 255, 255, 0.3),
    inset 0 calc(-1 * var(--lo)) 0 rgba(90, 60, 30, 0.3),
    0 var(--ledge) 0 var(--ink);
}
`;
}
