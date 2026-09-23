/**
 * The start screen's styles: the page around the signpost (#menu — title,
 * corner icons, footer, build line) and the boards on the arrows
 * (#signpost-3d, the CSS3DRenderer's layer). One sheet, injected by the
 * screen (Signpost.tsx).
 *
 * The look is the signpost's, not the glass HUD's: Lilita One lettering in
 * cream with a thick ink outline, chunky gold buttons that sink onto a
 * ledge without their foot moving, cream panels outlined in ink.
 */
export const SIGNPOST_STYLE = `
/* ——— The page around the signpost ———
   #menu is the menu's own root (index.html): fixed over the canvas, zoomed
   by --ui-scale like every other screen. Here it holds only the chrome —
   title, corner icons, footer, build line — and lets every other click
   through to the world beneath it. */
#menu, #signpost-3d {
  --comic: 'Lilita One';
  --ink: #3b1d10;
  --cream: #fff4dc;
}
#menu {
  zoom: var(--ui-scale);
  --safe-top: calc(var(--safe-top-raw) / var(--ui-scale));
  --safe-right: calc(var(--safe-right-raw) / var(--ui-scale));
  --safe-bottom: calc(var(--safe-bottom-raw) / var(--ui-scale));
  --safe-left: calc(var(--safe-left-raw) / var(--ui-scale));
  overflow: hidden;
  pointer-events: none;
  color: var(--cream);
  font-family: 'Nunito', system-ui, sans-serif;
  font-weight: 800;
}
#menu * { box-sizing: border-box; }
#menu button, #menu a, #menu input { pointer-events: auto; }

/* The boards' layer: CSS3DRenderer's, between the canvas and #menu. */
#signpost-3d {
  position: fixed;
  inset: 0;
  z-index: 9;
  color: var(--cream);
  font-family: 'Nunito', system-ui, sans-serif;
  font-weight: 800;
}
#signpost-3d * { box-sizing: border-box; }

/* Outlined comic lettering: the stroke is painted under the fill, the
   drop below is the same ink again. */
#menu .comic, #signpost-3d .comic {
  font-family: var(--comic), sans-serif;
  font-weight: 400;
  color: var(--cream);
  -webkit-text-stroke: 0.18em var(--ink);
  paint-order: stroke fill;
  text-shadow: 0 0.09em 0 var(--ink);
}

#menu .sp-title {
  position: fixed;
  top: calc(3vh + var(--safe-top));
  left: 0;
  right: 0;
  margin: 0;
  text-align: center;
  transition: opacity 0.4s ease, transform 0.5s ease;
}
#menu .open .sp-title { opacity: 0; transform: translateY(-16px); }
#menu .sp-title h1 {
  margin: 0;
  font-size: clamp(48px, 8vw, 104px);
  line-height: 1;
  letter-spacing: 0.02em;
}
#menu .sp-title p {
  margin: 8px 0 0;
  font-size: clamp(14px, 1.6vw, 20px);
  letter-spacing: 0.04em;
}
/* The staging deploy says so on its face. */
#menu .sp-title .channel {
  display: inline-block;
  margin-top: 8px;
  padding: 2px 12px 3px;
  font-family: var(--comic), sans-serif;
  font-size: 15px;
  letter-spacing: 0.08em;
  color: var(--ink);
  background: linear-gradient(#ffd66b, #f0a33a);
  border: 3px solid var(--ink);
  border-radius: 10px;
}

/* The arrows as buttons, for a keyboard or a screen reader: the signpost
   itself is 3D and cannot take focus. Out of sight until focused. */
#menu .sp-arrows {
  position: fixed;
  left: 50%;
  bottom: 50%;
  translate: -50% 0;
  display: flex;
  gap: 8px;
}
#menu .sp-arrows button {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}
#menu .sp-arrows button:focus-visible {
  position: static;
  width: auto;
  height: auto;
  clip-path: none;
  font: inherit;
  font-family: var(--comic), sans-serif;
  font-size: 22px;
  padding: 6px 18px 8px;
  color: var(--cream);
  -webkit-text-stroke: 5px var(--ink);
  paint-order: stroke fill;
  background: linear-gradient(#ffd66b, #f0a33a);
  border: 3px solid var(--ink);
  border-radius: 12px;
  outline: 3px solid var(--cream);
}

#menu .sp-footer {
  position: fixed;
  left: 18px;
  bottom: calc(30px + var(--safe-bottom));
  display: flex;
  gap: 30px;
  font-size: 30px;
  transition: opacity 0.4s ease;
}
#menu .sp-footer button {
  color: inherit;
  font: inherit;
  padding: 0;
  background: none;
  border: none;
  cursor: pointer;
}
#menu .sp-footer button:hover { color: #ffe39a; }
#menu .sp-footer button:disabled { opacity: 0.5; cursor: default; color: var(--cream); }

/* Which build this is, as the old menu's footer said it: version, commit,
   branch — and where the credits and the license live. */
#menu .sp-build {
  position: fixed;
  left: 16px;
  bottom: calc(8px + var(--safe-bottom));
  font: 700 12px 'Nunito', system-ui, sans-serif;
  letter-spacing: 0.02em;
  color: rgba(255, 244, 220, 0.72);
  text-shadow: 0 1px 3px rgba(0, 0, 0, 0.9);
  white-space: nowrap;
  transition: opacity 0.4s ease;
}
#menu .sp-build a { color: inherit; text-decoration: none; }
#menu .sp-build a:hover { color: #ffe39a; text-decoration: underline; }
#menu .open .sp-build, #menu .open .sp-footer { opacity: 0; }
#menu .open .sp-build *, #menu .open .sp-footer * { pointer-events: none; }

/* A phone held upright: the links as large as one row across it allows
   (at 1px of type they measure ~17px, and three gaps of 0.8em), and the
   build line in two balanced lines under them — the branch name alone can
   be wider than a phone. */
@media (max-aspect-ratio: 17/20) {
  #menu .sp-footer {
    left: 0;
    right: 0;
    justify-content: center;
    bottom: calc(44px + var(--safe-bottom));
    font-size: min(24px, calc((100vw - 28px) / 19.6));
    gap: 0.8em;
    white-space: nowrap;
  }
  #menu .sp-build {
    left: 0;
    right: 0;
    padding: 0 12px;
    text-align: center;
    font-size: 11px;
    white-space: normal;
    text-wrap: balance;
  }
}

/* Sound and full screen: bare icons, drawn like the lettering — cream with
   an ink outline and the same drop under it. */
#menu .sp-opts {
  position: fixed;
  top: calc(14px + var(--safe-top));
  right: calc(14px + var(--safe-right));
  display: flex;
  gap: 6px;
}
#menu .opt {
  display: grid;
  place-items: center;
  width: 44px;
  height: 44px;
  padding: 0;
  cursor: pointer;
  color: inherit;
  background: none;
  border: none;
  filter: drop-shadow(0 2px 0 var(--ink));
}
#menu .opt[hidden] { display: none; }
#menu .opt:hover { filter: drop-shadow(0 2px 0 var(--ink)) brightness(1.1); }
#menu .opt:hover svg { --cream: #ffe39a; }
#menu .opt:active { translate: 0 2px; filter: none; }
/* A phone: the title is as wide as the screen, so it drops below the
   icons, which shrink a little. */
@media (max-width: 560px) {
  #menu .sp-title { top: calc(70px + var(--safe-top)); }
  #menu .sp-opts { top: calc(12px + var(--safe-top)); right: calc(12px + var(--safe-right)); }
  #menu .opt { width: 42px; height: 42px; }
}

/* ——— The boards ——— */
      #signpost-3d,
#signpost-3d * {
        pointer-events: none;
      }
      /* Only the board being read takes the pointer: the others are still
         in the DOM, just turned away, and would swallow clicks meant for
         the arrows. */
      #signpost-3d .face.active,
#signpost-3d .face.active * {
        pointer-events: auto;
      }

      /* ---- the board: the back of the arrow, a strip of game UI ---- */
      #signpost-3d .face {
        box-sizing: border-box;
        padding: 12px 16px;
        display: flex;
        align-items: stretch;
        gap: 14px;
        container-type: inline-size;
        /* Painted on the back of the arrow; the lab hides it while that
           side faces away (see the loop in scene.ts). */
        color: var(--ink);
      }
      /* Play sits at the arrow's tip, whichever end of the strip that is,
         flush with the board's edge — which is the neck of the head. */
      #signpost-3d .face.tip-start {
        padding-left: 0;
      }
      #signpost-3d .face.tip-end {
        padding-right: 0;
      }
      #signpost-3d .face.tip-end > .go {
        order: 2;
      }
      #signpost-3d .face > .go {
        flex: none;
        align-self: center;
        font-size: 34px;
        padding: 16px 22px 18px;
      }
      #signpost-3d .main {
        flex: 1;
        min-width: 0;
        display: flex;
        flex-direction: column;
        justify-content: center;
        gap: 8px;
      }
      #signpost-3d .face header {
        display: flex;
        align-items: center;
        gap: 12px;
      }
      #signpost-3d .face h2 {
        margin: 0;
        font-size: 38px;
        line-height: 1;
      }
      #signpost-3d .face .sub {
        font-size: 16px;
        color: #ffe9c2;
        text-shadow: 0 2px 0 rgba(59, 29, 16, 0.6);
        white-space: nowrap;
      }
      #signpost-3d .face button {
        font: inherit;
        cursor: pointer;
      }
      /* Chunky button: flat fill, thick ink outline, a solid ledge under it
         that it sinks into when pressed. */
      #signpost-3d .go,
#signpost-3d .back {
        font-family: var(--comic), sans-serif !important;
        font-size: 26px;
        padding: 8px 20px 10px;
        border: 4px solid var(--ink);
        border-radius: 16px;
        color: var(--cream);
        -webkit-text-stroke: 6px var(--ink);
        paint-order: stroke fill;
        background: linear-gradient(#ffd66b, #f0a33a);
        box-shadow:
          inset 0 3px 0 rgba(255, 255, 255, 0.45),
          inset 0 -5px 0 rgba(160, 80, 20, 0.45),
          0 6px 0 var(--ink);
        transition:
          transform 0.06s ease,
          box-shadow 0.06s ease;
      }
      /* Outlined button text: the crisp stroke draws the outline; under it a
         ring of shadows, reaching just past the stroke, fills each letter's
         hole. The stroke alone only just meets itself in the middle of an
         o, and where its two soft edges meet the gold shows through as a
         dot. */
      #signpost-3d .go,
#signpost-3d .back,
#signpost-3d .invite,
#signpost-3d .seg button[aria-pressed='true'] {
        --ring: 3.4px;
        text-shadow:
          calc(var(--ring) * 1) calc(var(--ring) * 0) 0 var(--ink),
          calc(var(--ring) * 0.966) calc(var(--ring) * 0.259) 0 var(--ink),
          calc(var(--ring) * 0.866) calc(var(--ring) * 0.5) 0 var(--ink),
          calc(var(--ring) * 0.707) calc(var(--ring) * 0.707) 0 var(--ink),
          calc(var(--ring) * 0.5) calc(var(--ring) * 0.866) 0 var(--ink),
          calc(var(--ring) * 0.259) calc(var(--ring) * 0.966) 0 var(--ink),
          calc(var(--ring) * 0) calc(var(--ring) * 1) 0 var(--ink),
          calc(var(--ring) * -0.259) calc(var(--ring) * 0.966) 0 var(--ink),
          calc(var(--ring) * -0.5) calc(var(--ring) * 0.866) 0 var(--ink),
          calc(var(--ring) * -0.707) calc(var(--ring) * 0.707) 0 var(--ink),
          calc(var(--ring) * -0.866) calc(var(--ring) * 0.5) 0 var(--ink),
          calc(var(--ring) * -0.966) calc(var(--ring) * 0.259) 0 var(--ink),
          calc(var(--ring) * -1) calc(var(--ring) * 0) 0 var(--ink),
          calc(var(--ring) * -0.966) calc(var(--ring) * -0.259) 0 var(--ink),
          calc(var(--ring) * -0.866) calc(var(--ring) * -0.5) 0 var(--ink),
          calc(var(--ring) * -0.707) calc(var(--ring) * -0.707) 0 var(--ink),
          calc(var(--ring) * -0.5) calc(var(--ring) * -0.866) 0 var(--ink),
          calc(var(--ring) * -0.259) calc(var(--ring) * -0.966) 0 var(--ink),
          calc(var(--ring) * -0) calc(var(--ring) * -1) 0 var(--ink),
          calc(var(--ring) * 0.259) calc(var(--ring) * -0.966) 0 var(--ink),
          calc(var(--ring) * 0.5) calc(var(--ring) * -0.866) 0 var(--ink),
          calc(var(--ring) * 0.707) calc(var(--ring) * -0.707) 0 var(--ink),
          calc(var(--ring) * 0.866) calc(var(--ring) * -0.5) 0 var(--ink),
          calc(var(--ring) * 0.966) calc(var(--ring) * -0.259) 0 var(--ink);
      }
      #signpost-3d .back {
        --ring: 2.9px;
      }
      #signpost-3d .go.small {
        font-size: 22px;
        padding: 4px 16px 6px;
      }
      #signpost-3d .back {
        margin-left: auto;
        font-size: 17px;
        padding: 3px 12px 5px;
        border-width: 3px;
        -webkit-text-stroke: 5px var(--ink);
        background: linear-gradient(#b9c6cc, #7f8c92);
        box-shadow:
          inset 0 2px 0 rgba(255, 255, 255, 0.4),
          inset 0 -3px 0 rgba(40, 50, 55, 0.35),
          0 4px 0 var(--ink);
      }
      #signpost-3d .go:hover,
#signpost-3d .back:hover {
        filter: brightness(1.08);
      }
      /* Pressed: the button sinks by exactly the ledge it loses, so its
         bottom edge — the ledge's foot — stays where it was. */
      #signpost-3d .go:active {
        transform: translateY(5px);
        box-shadow:
          inset 0 3px 0 rgba(255, 255, 255, 0.45),
          inset 0 -5px 0 rgba(160, 80, 20, 0.45),
          0 1px 0 var(--ink);
      }
      #signpost-3d .back:active {
        transform: translateY(3px);
        box-shadow:
          inset 0 2px 0 rgba(255, 255, 255, 0.4),
          inset 0 -3px 0 rgba(40, 50, 55, 0.35),
          0 1px 0 var(--ink);
      }
      /* Not yours to press — a joiner's Begin, Host with the network down:
         the gold goes to worn wood, and it neither lights nor sinks. */
      #signpost-3d .go:disabled {
        cursor: default;
        color: #f3e6cb;
        background: linear-gradient(#d8c29c, #b59b72);
        filter: none;
        transform: none;
        box-shadow:
          inset 0 3px 0 rgba(255, 255, 255, 0.3),
          inset 0 -5px 0 rgba(90, 60, 30, 0.3),
          0 6px 0 var(--ink);
      }
      /* Campaign: the commissions as stops on a trail. */
      /* Room above the stops for the heading, and below them before the
         mission: the board's contents are centred, so the heading moves
         up by what this adds. */
      #signpost-3d .path {
        display: flex;
        align-items: center;
        margin: 16px 0 20px;
      }
      /* A dotted line between stops, clear of both circles. The dots are
         a repeating pattern spaced to fit ('space'): a short gap gets a
         couple, a long one a proper dotted line, never a clipped dot. */
      #signpost-3d .trail {
        flex: 1;
        align-self: stretch;
        margin: 0 4px;
        opacity: 0.5;
        background: radial-gradient(circle, var(--ink) 2.1px, transparent 2.6px)
          center / 9px 6px space no-repeat;
        background-repeat: space no-repeat;
      }
      #signpost-3d .stop {
        flex: none;
        display: grid;
        place-items: center;
        width: 40px;
        height: 40px;
        padding: 0;
        border-radius: 50%;
        border: 4px solid var(--ink);
        background: linear-gradient(#ffd66b, #f0a33a);
        font-family: var(--comic), sans-serif !important;
        font-size: 24px;
        color: var(--cream);
        /* Outline as a ring of shadows rather than -webkit-text-stroke: the
           stroke joins corners with a miter, and the sharp top of a 4 threw
           a spike out of it. A ring is round everywhere. */
        text-shadow:
          2.6px 0px 0 var(--ink),
          2.4px 0.99px 0 var(--ink),
          1.84px 1.84px 0 var(--ink),
          0.99px 2.4px 0 var(--ink),
          0px 2.6px 0 var(--ink),
          -0.99px 2.4px 0 var(--ink),
          -1.84px 1.84px 0 var(--ink),
          -2.4px 0.99px 0 var(--ink),
          -2.6px 0px 0 var(--ink),
          -2.4px -0.99px 0 var(--ink),
          -1.84px -1.84px 0 var(--ink),
          -0.99px -2.4px 0 var(--ink),
          -0px -2.6px 0 var(--ink),
          0.99px -2.4px 0 var(--ink),
          1.84px -1.84px 0 var(--ink),
          2.4px -0.99px 0 var(--ink);
        box-shadow:
          inset 0 3px 0 rgba(255, 255, 255, 0.45),
          0 4px 0 var(--ink);
        transition:
          transform 0.06s ease,
          box-shadow 0.06s ease;
      }
      /* Hover, as on the gold buttons: a touch brighter. */
      #signpost-3d .stop:not(.locked):hover {
        filter: brightness(1.08);
      }
      /* The chosen stop stands a little proud and lighter. */
      #signpost-3d .stop.sel {
        transform: scale(1.18);
        background: linear-gradient(#fff3c4, #ffd66b);
      }
      /* Every open stop is a button: held down, it sinks onto its ledge,
         and comes back up on release — same as the gold buttons. */
      #signpost-3d .stop:not(.locked):active {
        transform: translateY(4px);
        box-shadow:
          inset 0 3px 0 rgba(255, 255, 255, 0.45),
          0 0 0 var(--ink);
      }
      #signpost-3d .stop.sel:active {
        transform: scale(1.18) translateY(4px);
      }
      #signpost-3d .stop.locked {
        cursor: default;
        color: #efe3d2;
        text-shadow: none;
        background: #9c8c80;
        box-shadow: 0 4px 0 var(--ink);
      }
      /* Title over its one-liner: side by side, the longer lines ran out
         of board and were cut off. */
      #signpost-3d .pick {
        display: flex;
        flex-direction: column;
        gap: 1px;
        min-width: 0;
      }
      #signpost-3d .pick .t {
        font-family: var(--comic), sans-serif;
        font-size: 24px;
        color: var(--cream);
        -webkit-text-stroke: 5px var(--ink);
        paint-order: stroke fill;
        white-space: nowrap;
      }
      #signpost-3d .pick .d {
        font-size: 16px;
        color: #ffe9c2;
        text-shadow: 0 2px 0 rgba(59, 29, 16, 0.6);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      /* Skirmish: three settings, two by two, with air between them and
         under the heading. */
      #signpost-3d .grid {
        display: grid;
        grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
        gap: 24px 20px;
        margin-top: 16px;
      }
      /* The campaign's difficulty: one row under the mission, the label
         beside its choices on every board width, and the choices no wider
         than they need. */
      #signpost-3d .field.level {
        flex-direction: row;
        align-items: center;
        gap: 12px;
        margin-top: 4px;
      }
      #signpost-3d .field.level .seg {
        flex: 1;
        max-width: 420px;
      }
      /* Label over control: the board ends at the neck, so a label beside
         each control left the controls too narrow for their words. */
      #signpost-3d .field {
        display: flex;
        flex-direction: column;
        gap: 2px;
        min-width: 0;
      }
      #signpost-3d .field label,
#signpost-3d .join label {
        font-family: var(--comic), sans-serif;
        font-size: 20px;
        color: var(--cream);
        -webkit-text-stroke: 5px var(--ink);
        paint-order: stroke fill;
        text-shadow: 0 2px 0 var(--ink);
        white-space: nowrap;
      }
      /* Over its box, the label's cream lines up with the box's cream: the
         box's is 3px in, behind its border, and Lilita's capitals start
         their fill about 1px into the text box. */
      #signpost-3d .field label {
        padding-left: 2px;
      }
      #signpost-3d .seg,
#signpost-3d .face input {
        background: #fbeed3;
        border: 3px solid var(--ink);
        border-radius: 12px;
        box-shadow:
          inset 0 -3px 0 rgba(160, 110, 60, 0.25),
          0 3px 0 rgba(59, 29, 16, 0.55);
        color: var(--ink);
      }
      /* A segmented choice. The gold highlight is one piece, the ::before,
         that slides to whichever option is pressed: :has() reads the index
         of the pressed option into --i, the option count into --n, and the
         move is a transition on translate. Options are equal width (flex 1
         from a zero basis), so the highlight's slot is simple arithmetic. */
      #signpost-3d .seg {
        --pad: 3px;
        --gap: 3px;
        --n: 3;
        --i: 0;
        position: relative;
        display: flex;
        padding: var(--pad);
        gap: var(--gap);
      }
      #signpost-3d .seg:has(> :last-child:nth-child(2)) {
        --n: 2;
      }
      #signpost-3d .seg:has(> :nth-child(2)[aria-pressed='true']) {
        --i: 1;
      }
      #signpost-3d .seg:has(> :nth-child(3)[aria-pressed='true']) {
        --i: 2;
      }
      /* Four options: the council's AI seats, 0 to 3. */
      #signpost-3d .seg:has(> :last-child:nth-child(4)) {
        --n: 4;
      }
      #signpost-3d .seg:has(> :nth-child(4)[aria-pressed='true']) {
        --i: 3;
      }
      #signpost-3d .seg::before {
        content: '';
        position: absolute;
        top: var(--pad);
        bottom: var(--pad);
        left: var(--pad);
        width: calc(
          (100% - 2 * var(--pad) - (var(--n) - 1) * var(--gap)) / var(--n)
        );
        translate: calc(var(--i) * (100% + var(--gap))) 0;
        box-sizing: border-box;
        border: 3px solid var(--ink);
        border-radius: 8px;
        background: linear-gradient(#ffd66b, #f0a33a);
        box-shadow: inset 0 2px 0 rgba(255, 255, 255, 0.45);
        /* A little overshoot: it lands, rather than parks. */
        transition: translate 0.28s cubic-bezier(0.3, 1.35, 0.55, 1);
      }
      #signpost-3d .seg button {
        position: relative;
        flex: 1;
        min-width: 0;
        font-family: var(--comic), sans-serif;
        font-size: 17px;
        color: #8a5a3c;
        background: none;
        border: 3px solid transparent;
        border-radius: 8px;
        padding: 2px 0;
        transition: color 0.2s ease;
      }
      #signpost-3d .seg button[aria-pressed='true'] {
        color: var(--cream);
        -webkit-text-stroke: 4px var(--ink);
        paint-order: stroke fill;
        --ring: 2.4px;
      }
      /* The chosen option, held down (mouse or finger): the outline stays
         put, the gold reads as pushed in — its light turned upside down, a
         shadow under its top edge — and the word sinks into it. */
      #signpost-3d .seg:has(> [aria-pressed='true']:active)::before {
        background: linear-gradient(#e89a34, #ffd66b);
        box-shadow: inset 0 3px 3px rgba(120, 60, 10, 0.45);
      }
      #signpost-3d .seg button[aria-pressed='true']:active {
        translate: 0 2px;
      }
      /* A choice that cannot be made: one option (an AI seat the table has
         no chair for) goes faint; a whole row (a joiner watching the host's
         settings, difficulty in a sandbox) fades as one, still readable. */
      #signpost-3d .seg button:disabled {
        cursor: default;
      }
      #signpost-3d .seg:has(button:enabled) button:disabled:not([aria-pressed='true']) {
        color: #cdb497;
      }
      #signpost-3d .seg button:disabled:active {
        translate: none;
      }
      #signpost-3d .seg:not(:has(button:enabled)) {
        opacity: 0.8;
      }
      #signpost-3d .seg:not(:has(button:enabled))::before {
        background: linear-gradient(#e9d3a3, #cfae76);
      }
      /* Multiplayer: host is the tip; joining is a code and a button. */
      #signpost-3d .join {
        display: flex;
        align-items: center;
        gap: 12px;
      }
      #signpost-3d .face input {
        font-family: var(--comic), sans-serif;
        font-size: 26px;
        letter-spacing: 0.25em;
        text-transform: uppercase;
        padding: 2px 10px;
        outline: none;
        width: 150px;
        box-sizing: border-box;
      }

      /* ---- Multiplayer ---- */
      /* Host at the tip, Open/Private under it: the one choice made before
         the War Council. */
      #signpost-3d .tipcol {
        flex: none;
        align-self: center;
        display: flex;
        flex-direction: column;
        align-items: stretch;
        gap: 10px;
      }
      #signpost-3d .face.tip-end > .tipcol {
        order: 2;
      }
      #signpost-3d .tipcol .go {
        font-size: 34px;
        padding: 12px 22px 14px;
      }
      /* The board as one grid, so things line up across it: Host beside
         the heading and the rooms, Open/Private level with the code row.
         .tipcol and .main step aside (display: contents) and their children
         take the cells. */
      #signpost-3d .face.mp {
        display: grid;
        grid-template-columns: 176px 6px minmax(0, 1fr);
        grid-template-rows: auto 1fr auto;
        align-items: center;
        column-gap: 14px;
        row-gap: 8px;
      }
      #signpost-3d .face.mp > .tipcol,
#signpost-3d .face.mp > .main {
        display: contents;
      }
      /* Between hosting and joining, a dotted line — the campaign trail's
         dots — so the board reads as two choices, not one form. */
      #signpost-3d .face.mp::before {
        content: '';
        grid-area: 1 / 2 / 4 / 3;
        align-self: stretch;
        margin: 6px 0;
        opacity: 0.45;
        background: radial-gradient(circle, var(--ink) 2.1px, transparent 2.6px)
          center / 6px 9px no-repeat;
        background-repeat: no-repeat space;
      }
      /* Host centred on the board's height. */
      #signpost-3d .face.mp .tipcol .go {
        grid-area: 1 / 1 / 4 / 2;
        align-self: center;
      }
      #signpost-3d .face.mp header {
        grid-area: 1 / 3;
      }
      #signpost-3d .face.mp .rooms {
        grid-area: 2 / 3;
        align-self: start;
      }
      #signpost-3d .face.mp .join {
        grid-area: 3 / 3;
      }
      #signpost-3d .face.mp.tip-end {
        grid-template-columns: minmax(0, 1fr) 6px 176px;
      }
      #signpost-3d .face.mp.tip-end .tipcol .go {
        grid-area: 1 / 3 / 4 / 4;
      }
      #signpost-3d .face.mp.tip-end header {
        grid-area: 1 / 1;
      }
      #signpost-3d .face.mp.tip-end .rooms {
        grid-area: 2 / 1;
      }
      #signpost-3d .face.mp.tip-end .join {
        grid-area: 3 / 1;
      }
      /* The heading and its refresh on top, the tickets (or why there
         are none) under them. */
      #signpost-3d .rooms {
        display: flex;
        flex-direction: column;
        align-items: stretch;
        gap: 6px;
        min-width: 0;
      }
      #signpost-3d .rooms-head {
        display: flex;
        align-items: center;
        gap: 10px;
      }
      #signpost-3d .rooms .lbl {
        flex: none;
        font-family: var(--comic), sans-serif;
        font-size: 20px;
        color: var(--cream);
        -webkit-text-stroke: 5px var(--ink);
        paint-order: stroke fill;
        text-shadow: 0 2px 0 var(--ink);
        white-space: nowrap;
      }
      /* Open rooms as tickets: cream cards with the room code and a dot per
         seat. Picking one puts its code in the box below. */
      /* However many rooms there are, the row stays one row: it scrolls
         sideways (the wheel too, see the lab), snaps to whole tickets, and
         fades at whichever end still has more past it. */
      #signpost-3d .tickets {
        flex: 0 1 auto;
        min-width: 0;
        display: flex;
        gap: 8px;
        overflow-x: auto;
        scrollbar-width: none;
        scroll-snap-type: x mandatory;
        /* Snap to the padding edge, not the border: otherwise the first
           ticket snaps 2px in and the row reads as already scrolled. */
        scroll-padding-inline: 2px;
        padding: 2px 2px 5px;
        --fade: 36px;
      }
      #signpost-3d .tickets::-webkit-scrollbar {
        display: none;
      }
      #signpost-3d .ticket {
        scroll-snap-align: start;
      }
      #signpost-3d .tickets.more-after {
        mask-image: linear-gradient(
          to right,
          #000 calc(100% - var(--fade)),
          transparent
        );
      }
      #signpost-3d .tickets.more-before {
        mask-image: linear-gradient(
          to left,
          #000 calc(100% - var(--fade)),
          transparent
        );
      }
      #signpost-3d .tickets.more-before.more-after {
        mask-image: linear-gradient(
          to right,
          transparent,
          #000 var(--fade),
          #000 calc(100% - var(--fade)),
          transparent
        );
      }
      #signpost-3d .rooms .lbl .n {
        color: #ffe39a;
      }
      #signpost-3d .ticket {
        flex: none;
        display: grid;
        grid-template-columns: auto auto;
        align-items: center;
        column-gap: 8px;
        padding: 3px 10px 5px;
        text-align: left;
        color: var(--ink);
        background: #fbeed3;
        border: 3px solid var(--ink);
        border-radius: 12px;
        box-shadow:
          inset 0 -3px 0 rgba(160, 110, 60, 0.25),
          0 3px 0 rgba(59, 29, 16, 0.55);
      }
      #signpost-3d .ticket .code {
        grid-column: 1 / span 2;
        font-family: var(--comic), sans-serif;
        font-size: 21px;
        letter-spacing: 0.06em;
        line-height: 1.1;
      }
      #signpost-3d .ticket .pips {
        display: flex;
        gap: 3px;
      }
      #signpost-3d .ticket .pips i {
        width: 9px;
        height: 9px;
        box-sizing: border-box;
        border-radius: 50%;
        border: 2px solid var(--ink);
      }
      #signpost-3d .ticket .pips i.on {
        background: var(--ink);
      }
      #signpost-3d .ticket .meta {
        font-size: 12px;
        color: #8a5a3c;
        white-space: nowrap;
      }
      #signpost-3d .ticket:not([disabled]):hover {
        filter: brightness(1.05);
      }
      #signpost-3d .ticket.sel {
        background: linear-gradient(#ffd66b, #f0a33a);
      }
      #signpost-3d .ticket.sel .meta {
        color: var(--ink);
      }
      #signpost-3d .ticket[disabled] {
        cursor: default;
        opacity: 0.5;
      }
      #signpost-3d .rooms .none {
        font-size: 16px;
        color: #ffe9c2;
        text-shadow: 0 2px 0 rgba(59, 29, 16, 0.6);
      }
      #signpost-3d .refresh {
        flex: none;
        display: grid;
        place-items: center;
        width: 36px;
        height: 36px;
        padding: 0;
        color: var(--ink);
        border: 3px solid var(--ink);
        border-radius: 50%;
        background: linear-gradient(#b9c6cc, #7f8c92);
        box-shadow:
          inset 0 2px 0 rgba(255, 255, 255, 0.4),
          0 3px 0 var(--ink);
      }
      #signpost-3d .refresh:hover {
        filter: brightness(1.08);
      }
      #signpost-3d .refresh:active {
        translate: 0 2px;
        box-shadow:
          inset 0 2px 0 rgba(255, 255, 255, 0.4),
          0 1px 0 var(--ink);
      }
      #signpost-3d .refresh.spin svg {
        animation: sp-spin 0.5s ease;
      }
      @keyframes sp-spin {
        to {
          rotate: 360deg;
        }
      }
      #signpost-3d .join label {
        padding-left: 2px;
      }

      /* ---- War Council: the Multiplayer board, turned over ---- */
      #signpost-3d .face.council {
        display: grid;
        grid-template-columns: 190px 6px minmax(0, 1fr);
        grid-template-rows: auto auto auto auto minmax(0, 1fr) auto;
        align-items: center;
        column-gap: 18px;
        row-gap: 12px;
        padding: 22px 30px 24px;
      }
      #signpost-3d .face.council > .tipcol,
#signpost-3d .face.council > .main {
        display: contents;
      }
      #signpost-3d .face.council::before {
        content: '';
        grid-area: 1 / 2 / 7 / 3;
        align-self: stretch;
        margin: 6px 0;
        opacity: 0.45;
        background: radial-gradient(circle, var(--ink) 2.1px, transparent 2.6px)
          center / 6px 9px no-repeat;
        background-repeat: no-repeat space;
      }
      #signpost-3d .face.council .tipcol .go {
        grid-area: 1 / 1 / 7 / 2;
        align-self: center;
        font-size: 38px;
      }
      #signpost-3d .face.council .tipcol .hint {
        grid-area: 5 / 1 / 7 / 2;
        align-self: start;
        text-align: center;
        font-size: 15px;
        line-height: 1.25;
        color: #ffe9c2;
        text-shadow: 0 2px 0 rgba(59, 29, 16, 0.6);
      }
      #signpost-3d .face.council header {
        grid-area: 1 / 3;
      }
      #signpost-3d .face.council .code-row {
        grid-area: 2 / 3;
      }
      #signpost-3d .face.council .seats {
        grid-area: 3 / 3;
      }
      #signpost-3d .face.council .settings {
        grid-area: 4 / 3;
      }
      #signpost-3d .face.council .log {
        grid-area: 5 / 3;
      }
      #signpost-3d .face.council .chat {
        grid-area: 6 / 3;
      }
      #signpost-3d .face.council.tip-end {
        grid-template-columns: minmax(0, 1fr) 6px 176px;
      }
      #signpost-3d .face.council.tip-end .tipcol .go {
        grid-area: 1 / 3 / 7 / 4;
      }
      #signpost-3d .face.council.tip-end .tipcol .hint {
        grid-area: 5 / 3 / 7 / 4;
      }
      #signpost-3d .face.council.tip-end header,
#signpost-3d .face.council.tip-end .code-row,
#signpost-3d .face.council.tip-end .seats,
#signpost-3d .face.council.tip-end .settings,
#signpost-3d .face.council.tip-end .log,
#signpost-3d .face.council.tip-end .chat {
        grid-column: 1;
      }
      /* Table talk: newest at the bottom, names in their banner colour. */
      #signpost-3d .log {
        align-self: stretch;
        min-height: 0;
        overflow-y: auto;
        scrollbar-width: none;
        display: flex;
        flex-direction: column;
        justify-content: flex-end;
        gap: 2px;
        padding: 6px 12px;
        border-radius: 12px;
        background: rgba(59, 29, 16, 0.22);
        box-shadow: inset 0 3px 4px rgba(59, 29, 16, 0.35);
        font-size: 19px;
        line-height: 1.3;
        color: #fff4dc;
        text-shadow: 0 1px 0 rgba(59, 29, 16, 0.7);
      }
      #signpost-3d .log .line b {
        font-family: var(--comic), sans-serif;
        font-weight: 400;
        color: var(--c);
        -webkit-text-stroke: 4px var(--ink);
        paint-order: stroke fill;
        margin-right: 4px;
      }
      #signpost-3d .log .note {
        color: #ffe39a;
        font-style: italic;
      }
      /* The table talk, a line on the board like the code box. */
      #signpost-3d .face .chat {
        font-family: 'Nunito', sans-serif;
        font-weight: 800;
        font-size: 17px;
        letter-spacing: 0;
        text-transform: none;
        width: 100%;
        padding: 6px 12px;
      }
      #signpost-3d .code-row {
        display: flex;
        align-items: center;
        gap: 10px;
        min-width: 0;
      }
      #signpost-3d .code-row .lbl,
#signpost-3d .settings label {
        font-family: var(--comic), sans-serif;
        font-size: 20px;
        color: var(--cream);
        -webkit-text-stroke: 5px var(--ink);
        paint-order: stroke fill;
        text-shadow: 0 2px 0 var(--ink);
        white-space: nowrap;
      }
      /* The room code: the one thing on this board you read out to a
         friend, so it is the biggest thing on it. */
      #signpost-3d .code-row .code {
        font-family: var(--comic), sans-serif;
        font-size: 34px;
        letter-spacing: 0.12em;
        color: var(--ink);
        background: #fbeed3;
        border: 3px solid var(--ink);
        border-radius: 12px;
        padding: 0 10px 0 13px;
        box-shadow:
          inset 0 -3px 0 rgba(160, 110, 60, 0.25),
          0 3px 0 rgba(59, 29, 16, 0.55);
      }
      #signpost-3d .invite {
        font-family: var(--comic), sans-serif !important;
        font-size: 18px;
        padding: 3px 12px 5px;
        border: 3px solid var(--ink);
        border-radius: 12px;
        color: var(--cream);
        -webkit-text-stroke: 5px var(--ink);
        paint-order: stroke fill;
        background: linear-gradient(#b9c6cc, #7f8c92);
        box-shadow:
          inset 0 2px 0 rgba(255, 255, 255, 0.4),
          inset 0 -3px 0 rgba(40, 50, 55, 0.35),
          0 4px 0 var(--ink);
        --ring: 2.9px;
      }
      #signpost-3d .invite:hover {
        filter: brightness(1.08);
      }
      #signpost-3d .invite:active {
        translate: 0 3px;
        box-shadow:
          inset 0 2px 0 rgba(255, 255, 255, 0.4),
          inset 0 -3px 0 rgba(40, 50, 55, 0.35),
          0 1px 0 var(--ink);
      }
      #signpost-3d .code-row .seg {
        flex: 0 1 260px;
        min-width: 0;
        margin-left: auto;
      }
      #signpost-3d .code-row .seg button {
        font-size: 15px;
        white-space: nowrap;
      }
      /* Seats as the council knows them: a banner colour and a name, or a
         dashed place waiting for someone. */
      #signpost-3d .seats {
        display: grid;
        grid-template-columns: repeat(4, minmax(0, 1fr));
        gap: 8px;
      }
      #signpost-3d .seat {
        display: flex;
        align-items: center;
        gap: 7px;
        min-width: 0;
        padding: 4px 12px 5px;
        font-family: var(--comic), sans-serif;
        font-size: 19px;
        color: var(--ink);
        white-space: nowrap;
        background: #fbeed3;
        border: 3px solid var(--ink);
        border-radius: 12px;
        animation: sp-seat-in 0.35s cubic-bezier(0.3, 1.4, 0.55, 1);
      }
      #signpost-3d .seat i {
        flex: none;
        width: 12px;
        height: 12px;
        border-radius: 50%;
        border: 2px solid var(--ink);
      }
      #signpost-3d .seat.open {
        color: #8a5a3c;
        background: rgba(251, 238, 211, 0.35);
        border-style: dashed;
        animation: none;
      }
      #signpost-3d .seat.open i {
        border-style: dashed;
      }
      @keyframes sp-seat-in {
        from {
          scale: 0.85;
        }
      }
      #signpost-3d .settings {
        display: flex;
        align-items: center;
        gap: 8px;
        min-width: 0;
      }
      #signpost-3d .settings .seg {
        flex: 1;
        min-width: 0;
      }
      #signpost-3d .settings .seg button {
        font-size: 17px;
      }
      /* AI seats and raids take what their few short words need; the
         difficulty gets the rest. */
      #signpost-3d .settings .seg:nth-of-type(1) {
        flex: 0 0 140px;
      }
      #signpost-3d .settings .seg:nth-of-type(3) {
        flex: 0 0 110px;
      }
      #signpost-3d .settings {
        gap: 10px;
      }

      /* A phone held upright: Play goes under everything, centred, instead
         of beside it. A container query can style what is in the board but
         not the board itself, so placeFace() sets .narrow for this part. */
      #signpost-3d .face.narrow {
        flex-direction: column;
        padding: 16px 18px 14px;
        gap: 8px;
      }
      /* Back: a size a thumb can find, its right edge in line with the
         right-hand column below it (stop 4, the option rows). */
      #signpost-3d .face.narrow .back {
        margin: 2px 0 0 auto;
        font-size: 20px;
        padding: 4px 16px 6px;
      }
      #signpost-3d .face.narrow > .go {
        order: 2;
        font-size: 28px;
        padding: 6px 40px 8px;
      }
      #signpost-3d .face.narrow.mp,
#signpost-3d .face.narrow.mp.tip-end {
        grid-template-columns: 1fr 1fr;
        grid-template-rows: auto auto auto auto;
        column-gap: 14px;
        row-gap: 6px;
      }
      /* Upright there is no height to spare for the dotted line: the Host
         row at the foot is apart enough. */
      #signpost-3d .face.narrow.mp::before {
        display: none;
      }
      #signpost-3d .face.narrow.mp header,
#signpost-3d .face.narrow.mp .rooms,
#signpost-3d .face.narrow.mp .join {
        grid-column: 1 / 3;
      }
      #signpost-3d .face.narrow.mp header {
        grid-row: 1;
      }
      #signpost-3d .face.narrow.mp .rooms {
        grid-row: 2;
      }
      #signpost-3d .face.narrow.mp .join {
        grid-row: 3;
      }
      #signpost-3d .face.narrow.mp .tipcol .go {
        grid-area: 4 / 1 / 5 / 3;
        justify-self: center;
        align-self: center;
      }
      #signpost-3d .face.narrow .tipcol .go {
        font-size: 28px;
        padding: 5px 32px 6px;
      }

      #signpost-3d .face.narrow.council,
#signpost-3d .face.narrow.council.tip-end {
        grid-template-columns: 1fr 1fr;
        grid-template-rows: auto auto auto auto minmax(0, 1fr) auto auto;
        column-gap: 14px;
        row-gap: 8px;
        padding: 16px 18px 14px;
      }
      #signpost-3d .face.narrow.council::before {
        display: none;
      }
      #signpost-3d .face.narrow.council header,
#signpost-3d .face.narrow.council .code-row,
#signpost-3d .face.narrow.council .seats,
#signpost-3d .face.narrow.council .settings,
#signpost-3d .face.narrow.council .log,
#signpost-3d .face.narrow.council .chat {
        grid-column: 1 / 3;
      }
      #signpost-3d .face.narrow.council .log {
        grid-row: 5;
      }
      #signpost-3d .face.narrow.council .chat {
        grid-row: 6;
      }
      #signpost-3d .face.narrow.council header {
        grid-row: 1;
      }
      #signpost-3d .face.narrow.council .code-row {
        grid-row: 2;
      }
      #signpost-3d .face.narrow.council .seats {
        grid-row: 3;
      }
      #signpost-3d .face.narrow.council .settings {
        grid-row: 4;
      }
      #signpost-3d .face.narrow.council .tipcol .go {
        grid-area: 7 / 1 / 8 / 3;
        justify-self: center;
        align-self: center;
        font-size: 28px;
        padding: 6px 48px 8px;
      }
      #signpost-3d .face.narrow.council .tipcol .hint {
        grid-area: 7 / 2;
        justify-self: start;
        align-self: center;
        text-align: left;
      }
      /* The narrow board a phone held upright gets (TALL_FACE in the lab):
         the same pieces, restacked to fit. */
      /* The narrow layout of a board (the lab sets .narrow per board, from
         the width the board actually gets — see frameFor): the same
         pieces, restacked to fit. */
      #signpost-3d .face.narrow header .sub {
        display: none;
      }
      #signpost-3d .face.narrow header .sub.alert {
        display: inline;
      }
      /* Clear of the first row of stops, which runs right up under Back. */
      #signpost-3d .face.narrow header {
        margin-bottom: 8px;
      }
      #signpost-3d .face.narrow .main {
        gap: 4px;
      }
      /* A trail that snakes: 1-2-3-4 left to right, down at the end,
           then 5-6-7-8 back right to left, so the dots stay one path.
           Children alternate stop, trail, stop… — fifteen in all. */
      #signpost-3d .face.narrow .path {
        /* Stacked, the mission keeps its own gap (.path + .pick below). */
        margin: 0;
        display: grid;
        grid-template-columns: auto 1fr auto 1fr auto 1fr auto;
        grid-template-rows: auto 22px auto;
        align-items: center;
        justify-items: center;
      }
      #signpost-3d .face.narrow .path > .trail {
        width: 100%;
        height: 100%;
      }
      #signpost-3d .face.narrow .path > :nth-child(1) {
        grid-area: 1 / 1;
      }
      #signpost-3d .face.narrow .path > :nth-child(2) {
        grid-area: 1 / 2;
      }
      #signpost-3d .face.narrow .path > :nth-child(3) {
        grid-area: 1 / 3;
      }
      #signpost-3d .face.narrow .path > :nth-child(4) {
        grid-area: 1 / 4;
      }
      #signpost-3d .face.narrow .path > :nth-child(5) {
        grid-area: 1 / 5;
      }
      #signpost-3d .face.narrow .path > :nth-child(6) {
        grid-area: 1 / 6;
      }
      #signpost-3d .face.narrow .path > :nth-child(7) {
        grid-area: 1 / 7;
      }
      /* The turn: two dots running down from 4 to 5. */
      #signpost-3d .face.narrow .path > :nth-child(8) {
        grid-area: 2 / 7;
        width: 6px;
        margin: 3px 0;
        background-size: 6px 8px;
        background-repeat: no-repeat space;
      }
      #signpost-3d .face.narrow .path > :nth-child(9) {
        grid-area: 3 / 7;
      }
      #signpost-3d .face.narrow .path > :nth-child(10) {
        grid-area: 3 / 6;
      }
      #signpost-3d .face.narrow .path > :nth-child(11) {
        grid-area: 3 / 5;
      }
      #signpost-3d .face.narrow .path > :nth-child(12) {
        grid-area: 3 / 4;
      }
      #signpost-3d .face.narrow .path > :nth-child(13) {
        grid-area: 3 / 3;
      }
      #signpost-3d .face.narrow .path > :nth-child(14) {
        grid-area: 3 / 2;
      }
      #signpost-3d .face.narrow .path > :nth-child(15) {
        grid-area: 3 / 1;
      }
      #signpost-3d .face.narrow .grid {
        grid-template-columns: minmax(0, 1fr);
        gap: 14px;
      }
      /* The stacked campaign board has height to spare under its snake
         of stops: the mission sits half a stop lower, and the difficulty
         half a stop lower again, between it and Play. */
      #signpost-3d .face.narrow .path + .pick {
        margin-top: 20px;
      }
      #signpost-3d .face.narrow .field.level {
        margin-top: 24px;
      }
      #signpost-3d .face.narrow .field {
        flex-direction: row;
        align-items: center;
        gap: 8px;
      }
      #signpost-3d .face.narrow .field label {
        flex: none;
        width: 96px;
        padding-left: 0;
      }
      #signpost-3d .face.narrow .field .seg {
        flex: 1;
        --pad: 2px;
      }
      #signpost-3d .face.narrow .field .seg button {
        padding: 0;
      }
      /* War Council, upright: the code needs no label, an open seat is
           just "Open", and the settings take two rows — AI seats and raids,
           then the difficulty across the full width. */
      #signpost-3d .face.narrow .code-row .lbl,
#signpost-3d .face.narrow .seat .w {
        display: none;
      }
      #signpost-3d .face.narrow .code-row .seg button {
        font-size: 13px;
      }
      #signpost-3d .face.narrow .seats {
        gap: 6px;
      }
      #signpost-3d .face.narrow .seat {
        padding: 2px 8px 3px;
        gap: 5px;
      }
      #signpost-3d .face.narrow .settings {
        display: grid;
        grid-template-columns: auto minmax(0, 1fr) auto minmax(0, 1fr);
        gap: 6px 8px;
      }
      #signpost-3d .face.narrow .settings .seg:nth-of-type(1),
#signpost-3d .face.narrow .settings .seg:nth-of-type(3) {
        flex: none;
      }
      #signpost-3d .face.narrow .settings label:nth-of-type(1) {
        grid-area: 1 / 1;
      }
      #signpost-3d .face.narrow .settings .seg:nth-of-type(1) {
        grid-area: 1 / 2;
      }
      #signpost-3d .face.narrow .settings label:nth-of-type(2) {
        grid-area: 1 / 3;
      }
      #signpost-3d .face.narrow .settings .seg:nth-of-type(3) {
        grid-area: 1 / 4;
      }
      #signpost-3d .face.narrow .settings .seg:nth-of-type(2) {
        grid-area: 2 / 1 / 3 / 5;
      }
      #signpost-3d .face.narrow .settings .seg:nth-of-type(2) button {
        font-size: 15px;
      }
      #signpost-3d .face.narrow .rooms {
        gap: 2px;
      }
      /* Upright: two columns, two rows showing; more scroll up and down
           with the same snap and fades. */
      #signpost-3d .face.narrow .rooms .tickets {
        display: grid;
        grid-template-columns: 1fr 1fr;
        grid-auto-rows: 32px;
        gap: 5px 8px;
        max-height: calc(2 * 32px + 5px + 3px);
        overflow-x: hidden;
        overflow-y: auto;
        scroll-snap-type: y mandatory;
        padding: 0 0 3px;
        --fade: 18px;
      }
      #signpost-3d .face.narrow .rooms .tickets.more-after {
        mask-image: linear-gradient(
          to bottom,
          #000 calc(100% - var(--fade)),
          transparent
        );
      }
      #signpost-3d .face.narrow .rooms .tickets.more-before {
        mask-image: linear-gradient(
          to top,
          #000 calc(100% - var(--fade)),
          transparent
        );
      }
      #signpost-3d .face.narrow .rooms .tickets.more-before.more-after {
        mask-image: linear-gradient(
          to bottom,
          transparent,
          #000 var(--fade),
          #000 calc(100% - var(--fade)),
          transparent
        );
      }
      /* One line each: code, then its seats. */
      #signpost-3d .face.narrow .ticket {
        grid-template-columns: 1fr auto;
        padding: 2px 10px 3px;
      }
      #signpost-3d .face.narrow .ticket .code {
        grid-column: auto;
      }
      #signpost-3d .face.narrow .ticket .meta {
        display: none;
      }
      #signpost-3d .face.narrow .refresh {
        width: 32px;
        height: 32px;
      }
    

      /* ---- the shelf of replays: one column, header / list / Watch ---- */
      #signpost-3d .face.shelf {
        padding: 14px 12px 16px;
      }
      #signpost-3d .face.shelf .main {
        justify-content: flex-start;
        gap: 10px;
        border-radius: 14px;
      }
      #signpost-3d .face.shelf h2 {
        font-size: 34px;
      }
      /* A file dragged over the board: the board says it will take it. */
      #signpost-3d .face.shelf .main.dropping {
        outline: 4px dashed #ffe9c2;
        outline-offset: 4px;
      }
      #signpost-3d .files {
        flex: 1;
        min-height: 0;
        overflow-y: auto;
        display: flex;
        flex-direction: column;
        gap: 8px;
        /* Room for the rows' ledges and outlines inside the scroller. */
        padding: 2px 2px 6px;
        scrollbar-width: thin;
        scrollbar-color: rgba(59, 29, 16, 0.6) transparent;
      }
      #signpost-3d .file {
        flex: none;
        display: flex;
        align-items: center;
        gap: 6px;
      }
      #signpost-3d .file .pick {
        flex: 1;
        min-width: 0;
        display: flex;
        flex-direction: column;
        align-items: flex-start;
        padding: 4px 12px 6px;
        text-align: left;
        color: var(--ink);
        background: #fbeed3;
        border: 3px solid var(--ink);
        border-radius: 12px;
        box-shadow:
          inset 0 -3px 0 rgba(160, 110, 60, 0.25),
          0 3px 0 rgba(59, 29, 16, 0.55);
      }
      #signpost-3d .file .pick:hover:enabled {
        filter: brightness(1.05);
      }
      #signpost-3d .file .pick.sel {
        background: linear-gradient(#ffd66b, #f0a33a);
      }
      #signpost-3d .file .pick:disabled {
        cursor: default;
        opacity: 0.55;
      }
      #signpost-3d .file .name {
        max-width: 100%;
        font-family: var(--comic), sans-serif;
        font-size: 19px;
        line-height: 1.15;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      #signpost-3d .file .meta {
        font-size: 12px;
        color: #8a5a3c;
      }
      #signpost-3d .file .pick.sel .meta {
        color: var(--ink);
      }
      /* Share and delete: small round steel buttons, like Refresh. */
      #signpost-3d .file .tool {
        flex: none;
        display: grid;
        place-items: center;
        width: 34px;
        height: 34px;
        padding: 0;
        color: var(--ink);
        border: 3px solid var(--ink);
        border-radius: 50%;
        background: linear-gradient(#b9c6cc, #7f8c92);
        box-shadow:
          inset 0 2px 0 rgba(255, 255, 255, 0.4),
          0 3px 0 var(--ink);
      }
      #signpost-3d .file .tool:hover {
        filter: brightness(1.08);
      }
      #signpost-3d .file .tool:active {
        transform: translateY(2px);
        box-shadow:
          inset 0 2px 0 rgba(255, 255, 255, 0.4),
          0 1px 0 var(--ink);
      }
      #signpost-3d .face.shelf .none,
#signpost-3d .face.shelf .note {
        margin: 0;
        font-size: 16px;
        line-height: 1.3;
        color: #ffe9c2;
        text-shadow: 0 2px 0 rgba(59, 29, 16, 0.6);
      }
      #signpost-3d .face.shelf .note {
        color: #ffe39a;
      }
      #signpost-3d .face.shelf .main > .go {
        flex: none;
        align-self: center;
        margin-bottom: 6px;
      }
`;
