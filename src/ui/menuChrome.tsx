/**
 * The pre-boot screens' shared visual language: glass card, one gold
 * accent, Space Grotesk — the same vocabulary as the in-game HUD. The menu
 * shell (MenuApp.tsx) injects this sheet once and swaps screens underneath
 * it, which is what keeps the start menu and the War Council pixel-
 * identical instead of drifting apart — and what makes walking between
 * them a change of card, not of page. Screen-specific rules live with
 * their screen.
 */

import {createSignal, onCleanup, onMount} from 'solid-js';
import {SHORT} from './breakpoints';

export const GOLD = '#e5c469';

export const MENU_STYLE = `
/* Registered so it interpolates; unregistered it would snap. Every use
   reads var(--glow, 0), so a browser without @property still works. */
@property --glow { syntax: '<number>'; inherits: false; initial-value: 0; }
/* 'contain' on the screen itself: a downward swipe at the top of the menu
   is someone scrolling it, not asking Chrome for pull-to-refresh — and a
   refresh here costs a page load, or in the council a trip back through
   the rejoin. */
#menu { position: fixed; inset: 0; overflow-y: auto; overflow-x: hidden; overscroll-behavior: contain;
  font-family: 'Space Grotesk', system-ui, sans-serif; }
#menu * { box-sizing: border-box; }

/* ——— Materials ———
   Every control is a face, a rim and a thickness. The thickness — a hard
   shadow in the object's own darker tone — is what a press takes away. */
#menu {
  --gold: ${GOLD};
  --gold-lit: #f5e4b6;

  /* --sod-lit is a contrast ceiling: gold-on-green at 14px needs 4.5:1. */
  --sod-lit: #4e6d2e;
  --sod: #43602a;
  --sod-deep: #34491f;
  --loam: #241a10;

  /* The recessed wells that tabs and pills sit in. */
  --well: rgba(0,0,0,0.46);
  --plaque-lit: #3a3527;
  --plaque: #2a2619;

  /* Toggle studs. Warm, but never gold — the accent stays spoken for. */
  --brass: #9d8047;
  --brass-lit: #f0d99b;

  /* One shared noise field. Desaturated: raw fractalNoise is coloured,
     and coloured speckle reads as a compression artifact. */
  --grain: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='140' height='140'%3E%3Cfilter id='g'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='3' stitchTiles='stitch'/%3E%3CfeColorMatrix type='saturate' values='0'/%3E%3C/filter%3E%3Crect width='140' height='140' filter='url(%23g)' opacity='0.3'/%3E%3C/svg%3E");

  /* Drawn, not typed, to match the icons' stroke weight. */
  --chevron: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='11' height='7' viewBox='0 0 11 7'%3E%3Cpath d='M1 1.6 L5.5 5.4 L10 1.6' fill='none' stroke='%23a5a299' stroke-width='1.4' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");

  --rim: inset 0 1px 0 rgba(255,255,255,0.16), inset 0 -1px 0 rgba(0,0,0,0.34);
  /* Quick down, slower back up; equal timings read as a flicker. */
  --press-in: 90ms;
  --press-out: 170ms;

  /* The band the composition centres on. See the .stack rules below. */
  --compose: 800px;
}
/* Both veils are fixed so they stay put while the screen scrolls; the
   background itself is the live canvas underneath (see menuBackdrop.ts). */
#menu .veil-a { position: fixed; inset: 0; background: radial-gradient(ellipse 80% 70% at 50% 42%, rgba(8,10,8,0.12) 0%, rgba(6,8,7,0.72) 100%); }
#menu .veil-b { position: fixed; inset: 0; background: linear-gradient(180deg, rgba(6,8,7,0.55) 0%, rgba(6,8,7,0) 26%, rgba(6,8,7,0) 62%, rgba(6,8,7,0.78) 100%); }
@keyframes menu-rise { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: none; } }
/* Arrives in reading order. Class-based past the masthead so the War
   Council's differently-shaped stack gets the same sequence for free. */
#menu .stack > *:not(.title), #menu .stack > .title > * { animation: menu-rise 0.5s ease-out both; }
#menu .stack > .title > *:nth-child(2) { animation-delay: 0.07s; }
#menu .stack > .title > *:nth-child(3) { animation-delay: 0.14s; }
#menu .stack > .card { animation-delay: 0.2s; }
#menu .stack > .secondary { animation-delay: 0.27s; }

/* ——— Fireflies ———
   Two layers, so the far one is blurred by the card's backdrop-filter.
   Two elements per fly — outer drifts, inner circles — since one cannot
   carry two transforms. A waypoint in the drift or an 'alternate' on the
   circle puts a corner or a reversal in it, and both read as a wiggle. */
#menu .flies { position: fixed; inset: 0; overflow: hidden; pointer-events: none; }
#menu .fly { position: absolute; top: 0; left: 0; width: 0; height: 0; opacity: 0;
  animation: fly-drift var(--dur) linear infinite; }
/* The glow is gradient falloff, not a filter: no blur pass per fly. */
#menu .fly b { display: block; width: 12px; height: 12px; margin: -6px 0 0 -6px; border-radius: 50%;
  background: radial-gradient(circle closest-side,
    rgba(255,252,232,1) 0%, rgba(250,228,152,0.82) 18%,
    rgba(232,199,108,0.34) 44%, rgba(229,196,105,0) 100%);
  animation: fly-wander var(--wander) linear var(--wander-lag) infinite; }
/* Linear on purpose: easing would decelerate into the endpoint, and a
   fly that slows to a stop looks like it ran down rather than left. */
@keyframes fly-drift {
  0% { opacity: 0; transform: translate3d(var(--x0), var(--y0), 0) scale(calc(var(--s) * 0.78)); }
  14% { opacity: var(--peak); }
  86% { opacity: var(--peak); }
  100% { opacity: 0; transform: translate3d(var(--x1), var(--y1), 0) scale(var(--s)); }
}
/* An octagon really, but at a minute a lap nobody resolves the sides.
   See --wander for why its speed, not its size, is what matters. */
@keyframes fly-wander {
  0% { transform: translate3d(var(--rx), 0, 0); }
  12.5% { transform: translate3d(calc(var(--rx) * 0.707), calc(var(--ry) * 0.707), 0); }
  25% { transform: translate3d(0, var(--ry), 0); }
  37.5% { transform: translate3d(calc(var(--rx) * -0.707), calc(var(--ry) * 0.707), 0); }
  50% { transform: translate3d(calc(var(--rx) * -1), 0, 0); }
  62.5% { transform: translate3d(calc(var(--rx) * -0.707), calc(var(--ry) * -0.707), 0); }
  75% { transform: translate3d(0, calc(var(--ry) * -1), 0); }
  87.5% { transform: translate3d(calc(var(--rx) * 0.707), calc(var(--ry) * -0.707), 0); }
  100% { transform: translate3d(var(--rx), 0, 0); }
}

/* One column, floored at zero. Left implicit, the column is 'auto', and an
   auto track never shrinks below its items' min-content — so anything in
   here that cannot shrink (a tab bar with one long word in it, say) widens
   the whole screen instead of itself. Everything then centres on that wider
   screen and the overflow-x above eats the difference, unreachably. The
   floor makes the column the window and leaves the card to deal with its
   own contents. */
#menu .shell { position: relative; min-height: 100%; display: grid;
  grid-template-columns: minmax(0, 1fr); grid-template-rows: 1fr auto; padding: 0 0 14px; }
/* ——— Where the composition sits ———
   Centring on content moved the tab bar by half of every pane height
   difference. Anchored to a reserved band instead; a stale --compose
   only sits it high or low, never moves the tab bar. max() hands back to
   the old top padding on short windows. Do not restore plain centering
   here: it put the overflow out of reach on short ones. */
#menu .stack { min-height: 0; display: flex; flex-direction: column; align-items: center;
  justify-content: flex-start; gap: 18px;
  padding: calc(24px + var(--safe-top)) calc(20px + var(--safe-right)) 4px calc(20px + var(--safe-left)); }
#menu .stack { padding-top: max(calc(24px + var(--safe-top)), calc((100vh - var(--compose)) / 2)); }
#menu .stack { padding-top: max(calc(24px + var(--safe-top)), calc((100svh - var(--compose)) / 2)); }

#menu .kicker { display: flex; align-items: center; gap: 12px; font-size: 11px; font-weight: 600;
  letter-spacing: 0.34em; text-align: center; color: #cbbd93; text-transform: uppercase; }
#menu .kicker i { display: block; width: 46px; height: 1px; background: linear-gradient(90deg, rgba(229,196,105,0) 0%, rgba(229,196,105,0.7) 100%); }
#menu .kicker i.r { background: linear-gradient(90deg, rgba(229,196,105,0.7) 0%, rgba(229,196,105,0) 100%); }
/* The only place the second face is used. Tracking is down from the
   grotesk's 0.16em: serif caps carry their own rhythm. */
#menu h1 { margin: 0; font-family: 'Marcellus', Georgia, serif;
  font-size: clamp(40px, 11vw, 66px); line-height: 0.98; font-weight: 400; letter-spacing: 0.1em;
  color: #f4f1e6; text-shadow: 0 1px 0 rgba(0,0,0,0.45), 0 2px 30px rgba(0,0,0,0.6); }
#menu .tagline { margin: 2px 0 0; font-size: clamp(12.5px, 3.6vw, 14.5px); color: #a9a698; letter-spacing: 0.01em; text-align: center; text-wrap: pretty; }
#menu .title { display: flex; flex-direction: column; align-items: center; gap: 8px; }

#menu .card { width: 100%; max-width: 486px; display: flex; flex-direction: column;
  background: rgba(14,16,15,0.74); backdrop-filter: blur(18px); -webkit-backdrop-filter: blur(18px);
  border: 1px solid rgba(255,255,255,0.09); border-radius: 16px; box-shadow: 0 18px 60px rgba(0,0,0,0.5); }
/* Equal tracks with a zero floor, not flex:1. A flex tab cannot shrink past
   its longest word — "MULTIPLAYER" is one — so on a narrow card the bar used
   to push the card, and through it the whole screen, wider than the window.
   A 1fr track has no such floor: the label gives way, never the layout. */
/* Sunk, not merely darker: the inset shadow is what makes the plaque
   above it read as raised. */
#menu .seg { --gp: 4px; --gg: 2px; --gr: 9px;
  display: grid; grid-auto-flow: column; grid-auto-columns: minmax(0, 1fr);
  gap: var(--gg); padding: var(--gp); margin: 10px 10px 0; background: var(--well); border-radius: 11px;
  box-shadow: inset 0 2px 4px rgba(0,0,0,0.5), inset 0 -1px 0 rgba(255,255,255,0.04); }
/* ——— The plaque ———
   One rail shared by the tabs, the counter and the room visibility, via
   --gp (well padding), --gg (gap), --n (cells), --i (chosen). Width comes
   out to one cell because the well is always as wide as its contents.
   Absolute, or it would claim a cell of its own. */
#menu .seg, #menu .pills, #menu .vis { position: relative; }
#menu .glide { position: absolute; z-index: 0; top: var(--gp); bottom: var(--gp); left: var(--gp);
  width: calc((100% - 2 * var(--gp) - (var(--n) - 1) * var(--gg)) / var(--n));
  transform: translateX(calc(var(--i) * (100% + var(--gg))));
  border-radius: var(--gr);
  background: var(--grain), linear-gradient(180deg, var(--plaque-lit) 0%, var(--plaque) 100%);
  background-blend-mode: soft-light, normal; background-size: 140px 140px, auto;
  box-shadow: var(--rim), 0 0 0 1px rgba(229,196,105,0.3), 0 2px 0 rgba(0,0,0,0.45), 0 3px 7px rgba(0,0,0,0.35);
  transition: transform 0.3s cubic-bezier(0.32, 0.9, 0.36, 1); }
/* Armed a frame after mount (Glide, below), or it would slide in from
   cell zero on first paint. */
#menu .glide.still { transition: none; }
#menu .seg button { position: relative; z-index: 1; min-width: 0; overflow-wrap: anywhere;
  cursor: pointer; display: flex; align-items: center; justify-content: center; gap: 7px;
  padding: 8px 10px; font: inherit; font-size: 12.5px; font-weight: 600; letter-spacing: 0.05em; text-transform: uppercase;
  color: #94958c; background: transparent; border: none; border-radius: 9px;
  transition: color var(--press-out), transform var(--press-out); }
#menu .seg button:hover { color: #f0ede4; }
/* Label only; the rest belongs to the plaque. After :hover on purpose —
   equal specificity, so the later rule wins on a hovered active tab. */
#menu .seg button.on { color: var(--gold-lit); }
#menu .seg button:active { transform: translateY(1px); transition-duration: var(--press-in); }
/* Offline: the relay-backed half of the menu stands down (StartMenu.tsx). */
#menu .seg button:disabled { opacity: 0.4; cursor: default; }
#menu .seg button:disabled:hover { color: #94958c; }
#menu .seg button:disabled:active { transform: none; }

/* The shelf's header, in the tab bar's slot and wearing its well, so
   opening a replay swaps the card's top rather than growing it. */
#menu .pane-head { display: flex; align-items: center; gap: 10px; padding: 4px; margin: 10px 10px 0;
  background: rgba(0,0,0,0.38); border-radius: 11px; }
#menu .pane-head .icon-btn { flex: none; width: 30px; height: 30px; border-radius: 9px; }
#menu .pane-head .title { min-width: 0; font-size: 12.5px; font-weight: 600; letter-spacing: 0.05em;
  text-transform: uppercase; color: #f5e4b6; }
#menu .pane-head .count { margin-left: auto; padding-right: 6px; font-size: 11px; color: #85857c;
  font-variant-numeric: tabular-nums; }

#menu .rows { display: flex; flex-direction: column; padding: 6px 16px 0; }
#menu .row { display: flex; align-items: center; justify-content: space-between; gap: 16px;
  padding: 11px 0; border-top: 1px solid rgba(255,255,255,0.07); }
#menu .row-label { font-size: 13.5px; color: #e4e1d6; }
#menu .row-hint { margin-top: 2px; font-size: 11.5px; color: #85857c; }

/* Cards, not tabs — a title plus a line is too much to slide a plaque
   under. Unchosen sits sunk, chosen lifts out as a plaque. */
#menu .choices { display: flex; gap: 8px; padding: 14px 0 4px; }
#menu .choice { flex: 1; cursor: pointer; padding: 10px 12px; text-align: left; font: inherit; font-size: 13px;
  color: #a9a89e; background: rgba(0,0,0,0.28); border: 1px solid rgba(255,255,255,0.06);
  border-radius: 11px; box-shadow: inset 0 2px 3px rgba(0,0,0,0.42);
  transition: color var(--press-out), background var(--press-out), border-color var(--press-out),
    box-shadow var(--press-out), transform var(--press-out); }
#menu .choice:hover { color: #ddd9cd; border-color: rgba(255,255,255,0.13); }
#menu .choice.on { color: #f4f0e3;
  background: var(--grain), linear-gradient(180deg, var(--plaque-lit) 0%, var(--plaque) 100%);
  background-blend-mode: soft-light, normal; background-size: 140px 140px, auto;
  border-color: rgba(229,196,105,0.5);
  box-shadow: var(--rim), 0 2px 0 rgba(0,0,0,0.45), 0 4px 9px rgba(0,0,0,0.3); }
#menu .choice.on .row-hint { color: #a8a293; }
#menu .choice:active { transform: translateY(1px); transition-duration: var(--press-in); }
#menu .choice.on:active { box-shadow: var(--rim), 0 1px 0 rgba(0,0,0,0.45); }

/* The tab bar's pairing at counter scale. Fixed tracks, not fr: numerals
   should keep their pitch across screens. */
#menu .pills { --gp: 3px; --gg: 2px; --gr: 7px; --pill-w: 34px; --pill-h: 27px;
  flex: none; display: grid; grid-auto-flow: column; grid-auto-columns: var(--pill-w);
  gap: var(--gg); padding: var(--gp); background: var(--well); border-radius: 9px;
  box-shadow: inset 0 2px 3px rgba(0,0,0,0.45); }
#menu .pills button { position: relative; z-index: 1; cursor: pointer; width: 100%; height: var(--pill-h);
  font: inherit; font-size: 13px; font-weight: 600;
  font-variant-numeric: tabular-nums; color: #94958c; background: transparent; border: none; border-radius: var(--gr);
  transition: color var(--press-out), transform var(--press-out); }
#menu .pills button:hover { color: #f0ede4; }
#menu .pills button.on { color: var(--gold-lit); }
#menu .pills button:active { transform: translateY(1px); transition-duration: var(--press-in); }
/* A count the table has no room for: dimmed, and it does not take a press. */
#menu .pills button:disabled { cursor: default; color: #55564f; }
#menu .pills button:disabled:active { transform: none; }

/* A select is not "chosen and lifted out" — it is a field with a value
   in it, so it wears the inputs' dark sunk face rather than the plaque,
   which made a pair of these the brightest thing in the card. */
#menu select { appearance: none; -webkit-appearance: none; cursor: pointer;
  padding: 6px 27px 6px 10px; font: inherit; font-size: 12.5px; color: #ddd9cd;
  /* Shorthand, not background-image: a select's UA background-color is
     the white system Field colour, and only the shorthand resets it. */
  background:
    var(--chevron) right 9px center / 10px 6px no-repeat,
    linear-gradient(180deg, rgba(0,0,0,0.30) 0%, rgba(0,0,0,0.44) 100%);
  border: 1px solid rgba(255,255,255,0.11); border-radius: 9px;
  box-shadow: inset 0 1px 0 rgba(255,255,255,0.07), 0 1px 0 rgba(0,0,0,0.35);
  transition: border-color var(--press-out), color var(--press-out),
    box-shadow var(--press-out), transform var(--press-out); }
#menu select:hover { color: #f0ede4; border-color: rgba(229,196,105,0.4); }
#menu select:active { transform: translateY(1px); transition-duration: var(--press-in);
  box-shadow: inset 0 1px 3px rgba(0,0,0,0.45); }
#menu select option { color: #e4e1d6; background: #23231f; }
/* A field that cannot be changed yet: it still reads as a field — the row
   is there to say what the setting IS — but it takes no press and no
   hover, the way a pill the table has no room for does above. */
#menu select:disabled { cursor: default; color: #7c7d74; opacity: 1; }
#menu select:disabled:hover { color: #7c7d74; border-color: rgba(255,255,255,0.11); }
#menu select:disabled:active { transform: none; box-shadow: inset 0 1px 0 rgba(255,255,255,0.07), 0 1px 0 rgba(0,0,0,0.35); }

#menu input { padding: 7px 10px; font: inherit; font-size: 13.5px; color: #f2efe4;
  background: linear-gradient(180deg, rgba(0,0,0,0.30) 0%, rgba(0,0,0,0.44) 100%);
  border: 1px solid rgba(255,255,255,0.11); border-radius: 9px;
  box-shadow: inset 0 1px 0 rgba(255,255,255,0.07); }
#menu input.seed { width: 108px; text-align: right; font-variant-numeric: tabular-nums; }
#menu input.code { width: 124px; text-align: center; font-size: 15px; font-weight: 600; letter-spacing: 0.22em; text-transform: uppercase; }

#menu .icon-btn { cursor: pointer; width: 34px; height: 34px; display: grid; place-items: center; color: #cbc8bc;
  background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.11); border-radius: 9px;
  box-shadow: var(--rim), 0 1px 0 rgba(0,0,0,0.35);
  transition: background var(--press-out), border-color var(--press-out), color var(--press-out),
    transform var(--press-out), box-shadow var(--press-out); }
#menu .icon-btn:hover { background: rgba(229,196,105,0.14); border-color: rgba(229,196,105,0.42); color: #f2db9a; }
#menu .icon-btn:active { transform: translateY(1px); transition-duration: var(--press-in);
  box-shadow: inset 0 1px 2px rgba(0,0,0,0.4); }

#menu .toggle { cursor: pointer; width: 46px; height: 26px; padding: 3px; display: flex; justify-content: flex-start;
  background: rgba(0,0,0,0.46); border: 1px solid rgba(255,255,255,0.13); border-radius: 999px;
  box-shadow: inset 0 2px 3px rgba(0,0,0,0.55);
  transition: background 0.18s, border-color 0.18s; }
/* The stud travels on a transform so it can ease; flipping
   justify-content is what used to make it snap. 20px is the track's
   46 less its border (2), padding (6) and the stud (18). */
#menu .toggle span { width: 18px; height: 18px; border-radius: 50%;
  background: radial-gradient(circle at 34% 28%, #948f86 0%, #6f6d66 55%, #4f4d47 100%);
  box-shadow: 0 1px 2px rgba(0,0,0,0.5), inset 0 1px 0 rgba(255,255,255,0.22);
  transition: background 0.18s, box-shadow 0.18s, transform 0.26s cubic-bezier(0.34, 1.5, 0.64, 1); }
#menu .toggle.on { background: rgba(229,196,105,0.22); border-color: rgba(229,196,105,0.55); }
#menu .toggle.on span { transform: translateX(20px);
  background: radial-gradient(circle at 34% 28%, var(--brass-lit) 0%, ${GOLD} 52%, var(--brass) 100%);
  box-shadow: 0 1px 3px rgba(0,0,0,0.5), inset 0 1px 0 rgba(255,255,255,0.4), 0 0 9px rgba(229,196,105,0.34); }

#menu .browser { display: flex; flex-direction: column; gap: 8px; padding: 12px 0; border-top: 1px solid rgba(255,255,255,0.07); }
/* The shelf while a file hovers over it: the dashed edge the empty state
   already wears, promoted to gold — "this is a place files land". */
#menu .browser.dropping { outline: 1.5px dashed rgba(229,196,105,0.5); outline-offset: 3px;
  border-radius: 8px; background: rgba(229,196,105,0.04); }
#menu .browser-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
#menu .browser-head .count { font-size: 11px; color: #85857c; font-variant-numeric: tabular-nums; }
/* Two rows and a slice of the third: the cut row is the affordance, and it
   is why the height is not a whole number of rows. 'contain' keeps a flick
   that runs past the end inside the list — without it the page underneath
   takes over mid-gesture, which on a phone reads as the list jumping. */
#menu .room-list { display: flex; flex-direction: column; gap: 6px; max-height: 132px; overflow-y: auto;
  overscroll-behavior: contain; scrollbar-width: thin; scrollbar-color: rgba(229,196,105,0.3) transparent; }
#menu .room { cursor: pointer; display: flex; align-items: center; justify-content: space-between; gap: 12px;
  padding: 9px 11px; text-align: left; font: inherit; color: #cfccc2; background: rgba(255,255,255,0.03);
  border: 1px solid rgba(255,255,255,0.1); border-radius: 10px;
  box-shadow: var(--rim), 0 1px 0 rgba(0,0,0,0.3);
  transition: background var(--press-out), border-color var(--press-out),
    transform var(--press-out), box-shadow var(--press-out); }
#menu .room:hover { border-color: rgba(229,196,105,0.4); transform: translateY(-1px);
  box-shadow: var(--rim), 0 2px 0 rgba(0,0,0,0.3), 0 4px 8px rgba(0,0,0,0.26); }
#menu .room.on { color: #f2efe4; background: rgba(229,196,105,0.10); border-color: rgba(229,196,105,0.5);
  box-shadow: var(--rim), 0 2px 0 rgba(0,0,0,0.32), 0 4px 9px rgba(0,0,0,0.26); }
#menu .room:active { transform: translateY(1px); transition-duration: var(--press-in);
  box-shadow: inset 0 1px 3px rgba(0,0,0,0.38); }
/* Sealed sits sunk rather than faded: the copy says finishing one
   "unseals" the next, so becoming available is the row rising. */
#menu .room:disabled { opacity: 0.5; cursor: default; background: rgba(0,0,0,0.18);
  border-color: rgba(255,255,255,0.06); box-shadow: inset 0 1px 3px rgba(0,0,0,0.45); }
#menu .room:disabled:hover, #menu .room:disabled:active { transform: none;
  border-color: rgba(255,255,255,0.06); box-shadow: inset 0 1px 3px rgba(0,0,0,0.45); }
#menu .room .code { display: block; font-size: 14px; font-weight: 600; letter-spacing: 0.16em; }
#menu .room .meta { display: block; margin-top: 2px; font-size: 11px; color: #85857c; font-variant-numeric: tabular-nums; }
/* A replay's row and its delete button, side by side. Siblings rather
   than one nested in the other: both are real buttons, which nesting
   would forbid — so the row keeps its own flex:1 and the ✕ sits beside
   it, each separately focusable. */
#menu .replay-row { display: flex; align-items: stretch; gap: 6px; }
#menu .replay-row .room { flex: 1; min-width: 0; }
#menu .replay-row .icon-btn { flex: none; align-self: center; width: 30px; height: 30px; border-radius: 8px; }
#menu .pips { display: flex; align-items: center; gap: 4px; flex: none; }
#menu .pips span { width: 7px; height: 7px; border-radius: 50%; background: rgba(255,255,255,0.16); }
#menu .pips span.filled { background: #8fbb56; }
#menu .browser-none { padding: 18px 12px; text-align: center; border: 1px dashed rgba(255,255,255,0.12); border-radius: 10px; }
#menu .browser-none .t { font-size: 12.5px; color: #b3b1a6; }
#menu .browser-none .s { margin-top: 3px; font-size: 11.5px; color: #7b7c73; }
#menu .browser-load { padding: 22px 0; text-align: center; font-size: 12px; color: #85857c; }
#menu .code-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 9px 0;
  border-top: 1px solid rgba(255,255,255,0.07); }
#menu .code-row span { font-size: 12.5px; color: #85857c; }
/* Two states of one setting, so it wears the tab bar's clothes. */
#menu .vis { --gp: 3px; --gg: 2px; --gr: 8px; --n: 2;
  flex: none; display: grid; grid-auto-flow: column; grid-auto-columns: minmax(0, 1fr);
  gap: var(--gg); padding: var(--gp); background: var(--well); border-radius: 11px;
  box-shadow: inset 0 2px 3px rgba(0,0,0,0.45); }
#menu .vis button { position: relative; z-index: 1; cursor: pointer; padding: 7px 15px;
  font: inherit; font-size: 12.5px; color: #94958c;
  background: transparent; border: none; border-radius: var(--gr);
  transition: color var(--press-out), transform var(--press-out); }
#menu .vis button:hover { color: #f0ede4; }
#menu .vis button.on { color: var(--gold-lit); }
#menu .vis button:active { transform: translateY(1px); transition-duration: var(--press-in); }

#menu .cta-wrap { display: flex; flex-direction: column; gap: 7px; padding: 13px 16px; margin-top: 2px;
  border-top: 1px solid rgba(255,255,255,0.07); }
/* ——— The turf ———
   A block of sod; pressing drives it into its socket and the loam goes
   to nothing. The spotlight follows the pointer rather than looping on a
   timer, blended 'screen' to lift the moss. The rim is warm, not white:
   white on green reads as glass laid over it. */
#menu .cta { position: relative; cursor: pointer; display: flex; align-items: center; justify-content: center;
  gap: 9px; padding: 13px 18px;
  font: inherit; font-size: 14px; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase;
  color: #f7e9c0; text-shadow: 0 1px 2px rgba(0,0,0,0.5);
  background-image:
    radial-gradient(200px circle at var(--mx, 50%) var(--my, 50%),
      rgba(228,247,182, calc(0.36 * var(--glow, 0))) 0%,
      rgba(150,205,92, calc(0.15 * var(--glow, 0))) 40%,
      rgba(0,0,0,0) 72%),
    var(--grain),
    linear-gradient(180deg, var(--sod-lit) 0%, var(--sod) 52%, var(--sod-deep) 100%);
  background-repeat: no-repeat, repeat, no-repeat;
  background-size: auto, 140px 140px, auto;
  background-blend-mode: screen, soft-light, normal;
  border: 1px solid #2b3d1c; border-radius: 11px;
  box-shadow: inset 0 1px 0 rgba(206,232,168,0.22), inset 0 -1px 0 rgba(0,0,0,0.4),
    0 3px 0 var(--loam), 0 6px 14px rgba(0,0,0,0.5);
  transition: transform var(--press-out), box-shadow var(--press-out), color var(--press-out),
    opacity 0.15s, --glow 0.3s ease-out; }
#menu .cta:hover { color: #fdf4dc; transform: translateY(-1px);
  box-shadow: inset 0 1px 0 rgba(206,232,168,0.28), inset 0 -1px 0 rgba(0,0,0,0.4),
    0 4px 0 var(--loam), 0 8px 18px rgba(0,0,0,0.55); }
#menu .cta:active { transform: translateY(3px); transition-duration: var(--press-in);
  box-shadow: inset 0 1px 3px rgba(0,0,0,0.45), 0 0 0 var(--loam), 0 1px 3px rgba(0,0,0,0.5); }
/* Dimmed still has its click handler, so it keeps its press. */
#menu .cta.dim { opacity: 0.5; }
#menu .cta:disabled { cursor: default; }
#menu .cta:disabled:active { transform: none;
  box-shadow: inset 0 1px 0 rgba(206,232,168,0.22), inset 0 -1px 0 rgba(0,0,0,0.4),
    0 3px 0 var(--loam), 0 6px 14px rgba(0,0,0,0.5); }
#menu .cta-url { display: flex; align-items: center; justify-content: center; flex-wrap: wrap; gap: 8px; font-size: 11px;
  color: #6f7169; font-variant-numeric: tabular-nums; word-break: break-all; text-align: center; }

#menu .secondary { display: flex; align-items: center; justify-content: center; flex-wrap: wrap; gap: 8px; padding-bottom: 4px; }
/* Errands, not the thing the player came for: thickness and nothing
   else — no grain, no accent, no motion beyond the press. */
#menu .secondary button { cursor: pointer; display: flex; align-items: center; gap: 7px; padding: 9px 15px; font: inherit;
  font-size: 12.5px; color: #b8b5aa; background: rgba(14,16,15,0.6); backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px); border: 1px solid rgba(255,255,255,0.09); border-radius: 10px;
  box-shadow: var(--rim), 0 2px 0 rgba(0,0,0,0.4), 0 4px 9px rgba(0,0,0,0.3);
  transition: color var(--press-out), border-color var(--press-out), transform var(--press-out), box-shadow var(--press-out); }
#menu .secondary button:hover { color: #f0ede4; border-color: rgba(255,255,255,0.2);
  transform: translateY(-1px); box-shadow: var(--rim), 0 3px 0 rgba(0,0,0,0.4), 0 6px 12px rgba(0,0,0,0.34); }
#menu .secondary button:active { transform: translateY(2px); transition-duration: var(--press-in);
  box-shadow: inset 0 1px 3px rgba(0,0,0,0.4), 0 0 0 rgba(0,0,0,0.4); }
#menu .secondary button:disabled { opacity: 0.45; cursor: default; }
#menu .secondary button:disabled:hover, #menu .secondary button:disabled:active { transform: none;
  box-shadow: var(--rim), 0 2px 0 rgba(0,0,0,0.4), 0 4px 9px rgba(0,0,0,0.3); }

#menu .footer { display: flex; align-items: center; justify-content: flex-start;
  padding: 0 20px var(--safe-bottom); font-size: 11px; color: #5f6159; letter-spacing: 0.06em; }
#menu .footer a { color: #85857c; text-decoration: none; }
#menu .footer a:hover { color: #cbbd93; text-decoration: underline; }

/* Phones and short windows: same DOM, tighter stack, bigger touch targets. */
@media (max-width: 560px) {
  #menu .kicker i { display: none; }
  #menu .footer { justify-content: center; }
  #menu .stack { gap: 14px; justify-content: flex-start; }
  /* Three tabs and their icons do not sit in a phone-width card: the icon
     and its gap are 22px of the ~100px a tab gets here, and "MULTIPLAYER"
     wants most of the rest. The labels already name the modes — the icons
     were the decoration, so they are what goes. */
  #menu .seg button svg { display: none; }
  #menu .seg button { gap: 0; padding: 10px 6px; letter-spacing: 0.03em; }
  #menu .pills { --pill-w: 40px; --pill-h: 34px; }
  #menu .icon-btn { width: 40px; height: 40px; }
  #menu .pane-head .icon-btn { width: 34px; height: 34px; }
  /* Proximity, not mandatory: a flick settles with a row against the top
     rather than sliced across the middle, but a deliberate nudge still
     goes where it was put. */
  #menu .room-list { scroll-snap-type: y proximity; }
  #menu .room { scroll-snap-align: start; }
}
/* The narrowest phones still in service. Two things do not fit at full
   size here: a tab label, which the 1fr track would otherwise break across
   lines mid-word, and the four opponent pills, which are the one control
   that cannot give — 4x40px is a specified size, so they push out through
   the card's padding instead. Shave both rather than wear either. */
@media (max-width: 359px) {
  #menu .seg button { padding: 10px 4px; font-size: 11px; }
  #menu .pills { --pill-w: 34px; }
}
/* The desktop card floats in a big window, so a 132px list costs it
   nothing. A tall phone is all card and no window: that same peephole
   showed two rooms with a third of the screen going spare underneath, and
   reaching the fourth room meant working a 132px scroller with a thumb.
   Spend the spare height on rooms.
   Only where there is spare height to spend — a 667px phone is already
   full, and taking more there would push the join button off the bottom.
   Small viewport units, not dynamic ones: the list must not resize under
   the finger as the URL bar comes and goes. */
@media (max-width: 560px) and (min-height: 720px) {
  #menu .room-list { max-height: 34vh; max-height: 34svh; }
}
/* ——— Held sideways ———
   A phone in landscape is 390-430px tall, and this screen spent 200 of
   them on a title: the card began below the fold and the Play button was
   two swipes down, on the one screen where nothing is more urgent than
   Play. The masthead is what gives way — the game is named on the tab and
   on the card the player came here to use.
   Keyed to height, not width — the same SHORT the HUD uses: this window
   is 844px across, so every width-keyed rule above it (the phone block at
   560px) sits this one out.
   The card's own contents are untouched — it scrolls if it must, and now
   it starts at the top of the screen while doing it. */
@media ${SHORT} {
  #menu .stack { gap: 10px; justify-content: flex-start;
    padding-top: calc(10px + var(--safe-top)); }
  #menu .kicker { display: none; }
  #menu .tagline { display: none; }
  #menu h1 { font-size: clamp(24px, 4.4vh, 34px); letter-spacing: 0.12em; }
  /* Shaving the masthead was not enough on its own: the settings
     themselves are 394px of rows, and the card carried all of them at
     full height with Play on the bottom edge — 500px down a 390px
     screen. So the card takes the window's height as its ceiling and
     the rows inside it do the scrolling, which puts the tab bar at the
     top and Play at the bottom of what you can see, always. The number
     below is the masthead, the row of secondary buttons under the card,
     and the gaps between the three. */
  #menu .card { max-height: calc(100vh - 118px); max-height: calc(100svh - 118px); }
  #menu .rows {
    flex: 1 1 auto; min-height: 0; padding-top: 2px;
    overflow-y: auto; overscroll-behavior: contain; touch-action: pan-y;
    scrollbar-width: thin; scrollbar-color: rgba(229,196,105,0.3) transparent;
  }
  #menu .row { padding: 8px 0; }
  #menu .cta-wrap { padding: 10px 16px; }
  #menu .cta { padding: 11px 18px; }
  #menu .footer { display: none; }
}
#menu button:focus-visible, #menu input:focus-visible, #menu a:focus-visible { outline: 2px solid rgba(229,196,105,0.55); outline-offset: 2px; }

/* ——— Reduced motion ———
   MUST stay last: a media query buys no specificity, so these only win by
   coming second. Higher up it lost silently to .cta, .toggle span and
   .glide. The spotlight stays (a pointer drives it); the pane swap is in
   StartMenu.tsx, which checks the same query. */
@media (prefers-reduced-motion: reduce) {
  #menu .stack, #menu .stack > *:not(.title), #menu .stack > .title > * { animation: none; }
  #menu .glide { transition: none; }
  #menu .flies { display: none; }
  #menu .toggle span { transition: background 0.18s, box-shadow 0.18s; }
}

`;

/** Components, not shared element consts: a JSX element is one real DOM
 * node, and a node can only have one parent. */
export function DiceIcon() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.8"
    >
      <rect x="3" y="3" width="18" height="18" rx="3" />
      <circle cx="8.5" cy="8.5" r="1.1" fill="currentColor" />
      <circle cx="15.5" cy="15.5" r="1.1" fill="currentColor" />
      <circle cx="15.5" cy="8.5" r="1.1" fill="currentColor" />
      <circle cx="8.5" cy="15.5" r="1.1" fill="currentColor" />
    </svg>
  );
}

/**
 * The sliding plaque for a segmented control (the .glide rules above).
 * Cannot travel on the frame it mounts, or it would slide in from cell
 * zero to wherever the remembered choice is; armed a frame later, which
 * also keeps the switch-on out of the same recalc as the move.
 */
export function Glide(props: {index: number}) {
  const [armed, setArmed] = createSignal(false);
  onMount(() => requestAnimationFrame(() => setArmed(true)));
  return (
    <i
      class="glide"
      classList={{still: !armed()}}
      style={{'--i': props.index}}
      aria-hidden="true"
    />
  );
}

/**
 * Let a turf button see the pointer, so its spotlight can follow. Used as
 * a ref; writes only custom properties the button's background reads.
 */
export function spotlight(el: HTMLElement): void {
  const move = (e: PointerEvent): void => {
    const box = el.getBoundingClientRect();
    if (box.width === 0 || box.height === 0) return;
    el.style.setProperty(
      '--mx',
      `${((e.clientX - box.left) / box.width) * 100}%`,
    );
    el.style.setProperty(
      '--my',
      `${((e.clientY - box.top) / box.height) * 100}%`,
    );
    el.style.setProperty('--glow', '1');
  };
  const out = (): void => el.style.setProperty('--glow', '0');
  el.addEventListener('pointermove', move, {passive: true});
  el.addEventListener('pointerleave', out);
  // A finger leaves no pointer behind, so nothing else would put it out.
  el.addEventListener('pointercancel', out);
  const up = (e: PointerEvent): void => {
    if (e.pointerType !== 'mouse') out();
  };
  el.addEventListener('pointerup', up);
  onCleanup(() => {
    el.removeEventListener('pointermove', move);
    el.removeEventListener('pointerleave', out);
    el.removeEventListener('pointercancel', out);
    el.removeEventListener('pointerup', up);
  });
}

/**
 * Density, not a count: thirty is a scattering on a laptop and a swarm on
 * a phone. Power below 1 because matching area exactly leaves a small
 * screen empty. The ceiling is taste — each fly costs ~0.6ms of style
 * recalc per second and no layout — they read as snow before they cost.
 */
const FLIES_BASE = 30;
const FLIES_REF_AREA = 1440 * 900;
const FLIES_MIN = 11;
const FLIES_MAX = 52;

function flyCount(): number {
  const area = window.innerWidth * window.innerHeight;
  const scaled = FLIES_BASE * (area / FLIES_REF_AREA) ** 0.75;
  return Math.max(FLIES_MIN, Math.min(FLIES_MAX, Math.round(scaled)));
}

/** More behind than in front: lights over text being read distract. */
const FLIES_FAR_SHARE = 0.58;

const between = (lo: number, hi: number): number =>
  lo + Math.random() * (hi - lo);

/**
 * One firefly's next flight. Two points, not three: a middle waypoint is
 * a corner the fly visibly turns at. Entry is drawn inside the viewport,
 * since the walk is too short to get in from outside it.
 */
function flightPath(el: HTMLElement): void {
  const x0 = between(3, 97);
  const y0 = between(3, 97);
  // Polar, not per-axis: independent dx/dy can both land near zero, and a
  // fly that barely drifts is one the orbit dominates. This floors it.
  const angle = between(0, Math.PI * 2);
  const reach = between(14, 30) * (Math.min(innerWidth, innerHeight) / 100);
  const set = (k: string, v: string): void => el.style.setProperty(k, v);
  set('--x0', `${x0.toFixed(2)}vw`);
  set('--y0', `${y0.toFixed(2)}vh`);
  set(
    '--x1',
    `${(x0 + (Math.cos(angle) * reach * 100) / innerWidth).toFixed(2)}vw`,
  );
  set(
    '--y1',
    `${(y0 + (Math.sin(angle) * reach * 100) / innerHeight).toFixed(2)}vh`,
  );
  set('--peak', between(0.32, 0.9).toFixed(2));
  set('--s', between(0.6, 1.35).toFixed(2));
}

function Firefly() {
  let el!: HTMLElement;
  onMount(() => {
    // Fixed for life: re-rolling duration mid-flight rescales the clock.
    // The negative delay stops them all igniting on the same frame.
    el.style.setProperty('--dur', `${between(13, 24).toFixed(2)}s`);
    // The orbit must never be able to cancel the drift, or the fly stops
    // dead and circles — that was the wiggle, and half of them could do
    // it. A loop moves at 2*pi*r/T; these keep that at ~0.16 of the drift
    // (0.36 at p99). Phase offset per fly so they don't all bend at once.
    el.style.setProperty('--wander', `${between(45, 80).toFixed(1)}s`);
    el.style.setProperty('--wander-lag', `-${between(0, 80).toFixed(1)}s`);
    // vmin, the same unit as the reach, so the ratio holds on any screen.
    // In px the orbit stayed one size while the drift shrank with it.
    el.style.setProperty('--rx', `${between(1.1, 2.3).toFixed(2)}vmin`);
    el.style.setProperty('--ry', `${between(1.1, 2.3).toFixed(2)}vmin`);
    el.style.setProperty('animation-delay', `-${between(0, 24).toFixed(2)}s`);
    flightPath(el);
    // Swapped at the boundary, where opacity is zero, so it is invisible.
    el.addEventListener('animationiteration', e => {
      if (e.target === el) flightPath(el);
    });
  });
  return (
    <i class="fly" ref={el}>
      <b />
    </i>
  );
}

/** One layer of fireflies. `near` is the one that crosses in front of the card. */
export function Fireflies(props: {near?: boolean}) {
  // Counted once: recomputing on resize would restart every flight.
  const total = flyCount();
  const far = Math.ceil(total * FLIES_FAR_SHARE);
  const count = props.near === true ? total - far : far;
  return (
    <div class="flies" aria-hidden="true">
      {Array.from({length: count}, () => (
        <Firefly />
      ))}
    </div>
  );
}
