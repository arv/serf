/**
 * The pre-boot screens' shared visual language: glass card, one gold
 * accent, Space Grotesk — the same vocabulary as the in-game HUD. The menu
 * shell (MenuApp.tsx) injects this sheet once and swaps screens underneath
 * it, which is what keeps the start menu and the War Council pixel-
 * identical instead of drifting apart — and what makes walking between
 * them a change of card, not of page. Screen-specific rules live with
 * their screen.
 */

import {SHORT} from './breakpoints';

export const GOLD = '#e5c469';

export const MENU_STYLE = `
/* 'contain' on the screen itself: a downward swipe at the top of the menu
   is someone scrolling it, not asking Chrome for pull-to-refresh — and a
   refresh here costs a page load, or in the council a trip back through
   the rejoin. */
#menu { position: fixed; inset: 0; overflow-y: auto; overflow-x: hidden; overscroll-behavior: contain;
  font-family: 'Space Grotesk', system-ui, sans-serif; }
#menu * { box-sizing: border-box; }
/* Both veils are fixed so they stay put while the screen scrolls; the
   background itself is the live canvas underneath (see menuBackdrop.ts). */
#menu .veil-a { position: fixed; inset: 0; background: radial-gradient(ellipse 80% 70% at 50% 42%, rgba(8,10,8,0.12) 0%, rgba(6,8,7,0.72) 100%); }
#menu .veil-b { position: fixed; inset: 0; background: linear-gradient(180deg, rgba(6,8,7,0.55) 0%, rgba(6,8,7,0) 26%, rgba(6,8,7,0) 62%, rgba(6,8,7,0.78) 100%); }
@keyframes menu-rise { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: none; } }
@media (prefers-reduced-motion: reduce) { #menu .stack { animation: none; } }

/* One column, floored at zero. Left implicit, the column is 'auto', and an
   auto track never shrinks below its items' min-content — so anything in
   here that cannot shrink (a tab bar with one long word in it, say) widens
   the whole screen instead of itself. Everything then centres on that wider
   screen and the overflow-x above eats the difference, unreachably. The
   floor makes the column the window and leaves the card to deal with its
   own contents. */
#menu .shell { position: relative; min-height: 100%; display: grid;
  grid-template-columns: minmax(0, 1fr); grid-template-rows: 1fr auto; padding: 0 0 14px; }
/* 'safe' centering matters: plain centering makes the overflow unreachable
   on short windows, which is exactly when this screen needs to scroll. */
#menu .stack { min-height: 0; display: flex; flex-direction: column; align-items: center;
  justify-content: safe center; gap: 18px; animation: menu-rise 0.5s ease-out both;
  padding: calc(24px + var(--safe-top)) calc(20px + var(--safe-right)) 4px calc(20px + var(--safe-left)); }

#menu .kicker { display: flex; align-items: center; gap: 12px; font-size: 11px; font-weight: 600;
  letter-spacing: 0.34em; text-align: center; color: #cbbd93; text-transform: uppercase; }
#menu .kicker i { display: block; width: 46px; height: 1px; background: linear-gradient(90deg, rgba(229,196,105,0) 0%, rgba(229,196,105,0.7) 100%); }
#menu .kicker i.r { background: linear-gradient(90deg, rgba(229,196,105,0.7) 0%, rgba(229,196,105,0) 100%); }
#menu h1 { margin: 0; font-size: clamp(40px, 11vw, 62px); line-height: 0.94; font-weight: 500; letter-spacing: 0.16em;
  color: #f4f1e6; text-shadow: 0 2px 30px rgba(0,0,0,0.6); }
#menu .tagline { margin: 2px 0 0; font-size: clamp(12.5px, 3.6vw, 14.5px); color: #a9a698; letter-spacing: 0.01em; text-align: center; text-wrap: pretty; }
#menu .title { display: flex; flex-direction: column; align-items: center; gap: 8px; }

#menu .card { width: 100%; max-width: 486px; display: flex; flex-direction: column;
  background: rgba(14,16,15,0.74); backdrop-filter: blur(18px); -webkit-backdrop-filter: blur(18px);
  border: 1px solid rgba(255,255,255,0.09); border-radius: 16px; box-shadow: 0 18px 60px rgba(0,0,0,0.5); }
/* Equal tracks with a zero floor, not flex:1. A flex tab cannot shrink past
   its longest word — "MULTIPLAYER" is one — so on a narrow card the bar used
   to push the card, and through it the whole screen, wider than the window.
   A 1fr track has no such floor: the label gives way, never the layout. */
#menu .seg { display: grid; grid-auto-flow: column; grid-auto-columns: minmax(0, 1fr);
  gap: 2px; padding: 4px; margin: 10px 10px 0; background: rgba(0,0,0,0.38); border-radius: 11px; }
#menu .seg button { min-width: 0; overflow-wrap: anywhere;
  cursor: pointer; display: flex; align-items: center; justify-content: center; gap: 7px;
  padding: 8px 10px; font: inherit; font-size: 12.5px; font-weight: 600; letter-spacing: 0.05em; text-transform: uppercase;
  color: #94958c; background: transparent; border: none; border-radius: 9px; transition: background 0.15s, color 0.15s; }
#menu .seg button:hover { color: #f0ede4; }
#menu .seg button.on { color: #f5e4b6; background: rgba(229,196,105,0.16); }
/* Offline: the relay-backed half of the menu stands down (StartMenu.tsx). */
#menu .seg button:disabled { opacity: 0.4; cursor: default; }
#menu .seg button:disabled:hover { color: #94958c; }

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

#menu .choices { display: flex; gap: 6px; padding: 14px 0 4px; }
#menu .choice { flex: 1; cursor: pointer; padding: 9px 10px; text-align: left; font: inherit; font-size: 13px;
  color: #b3b1a6; background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.1);
  border-radius: 10px; transition: border-color 0.15s, background 0.15s; }
#menu .choice:hover { border-color: rgba(229,196,105,0.4); }
#menu .choice.on { color: #f2efe4; background: rgba(229,196,105,0.10); border-color: rgba(229,196,105,0.5); }

#menu .pills { display: flex; gap: 2px; padding: 3px; background: rgba(0,0,0,0.34); border-radius: 9px; }
#menu .pills button { cursor: pointer; width: 34px; height: 27px; font: inherit; font-size: 13px; font-weight: 600;
  font-variant-numeric: tabular-nums; color: #94958c; background: transparent; border: none; border-radius: 7px;
  transition: background 0.15s, color 0.15s; }
#menu .pills button:hover { color: #f0ede4; }
#menu .pills button.on { color: #f5e4b6; background: rgba(229,196,105,0.16); }

#menu .opponents { display: flex; flex-direction: column; gap: 5px; }
#menu select { cursor: pointer; padding: 7px 9px; font: inherit; font-size: 12.5px; color: #e4e1d6;
  background: rgba(0,0,0,0.34); border: 1px solid rgba(255,255,255,0.13); border-radius: 9px;
  transition: border-color 0.15s; }
#menu select:hover { border-color: rgba(229,196,105,0.42); }
#menu select option { color: #e4e1d6; background: #23231f; }

#menu input { padding: 8px 10px; font: inherit; font-size: 13.5px; color: #f2efe4;
  background: rgba(0,0,0,0.34); border: 1px solid rgba(255,255,255,0.13); border-radius: 9px; }
#menu input.seed { width: 108px; text-align: right; font-variant-numeric: tabular-nums; }
#menu input.code { width: 124px; text-align: center; font-size: 15px; font-weight: 600; letter-spacing: 0.22em; text-transform: uppercase; }

#menu .icon-btn { cursor: pointer; width: 34px; height: 34px; display: grid; place-items: center; color: #cbc8bc;
  background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.11); border-radius: 9px; }
#menu .icon-btn:hover { background: rgba(229,196,105,0.14); border-color: rgba(229,196,105,0.42); color: #f2db9a; }

#menu .toggle { cursor: pointer; width: 46px; height: 26px; padding: 3px; display: flex; justify-content: flex-start;
  background: rgba(0,0,0,0.4); border: 1px solid rgba(255,255,255,0.13); border-radius: 999px;
  transition: background 0.18s, border-color 0.18s; }
#menu .toggle span { width: 18px; height: 18px; border-radius: 50%; background: #7d7f77; transition: background 0.18s; }
#menu .toggle.on { justify-content: flex-end; background: rgba(229,196,105,0.22); border-color: rgba(229,196,105,0.55); }
#menu .toggle.on span { background: ${GOLD}; }

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
  border: 1px solid rgba(255,255,255,0.1); border-radius: 10px; transition: background 0.15s, border-color 0.15s; }
#menu .room:hover { border-color: rgba(229,196,105,0.4); }
#menu .room.on { color: #f2efe4; background: rgba(229,196,105,0.10); border-color: rgba(229,196,105,0.5); }
#menu .room:disabled { opacity: 0.45; cursor: default; }
#menu .room:disabled:hover { border-color: rgba(255,255,255,0.1); }
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
#menu .vis { display: flex; gap: 6px; flex: none; }
#menu .vis button { cursor: pointer; padding: 7px 13px; font: inherit; font-size: 12.5px; color: #b3b1a6;
  background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.1); border-radius: 9px;
  transition: background 0.15s, border-color 0.15s; }
#menu .vis button:hover { border-color: rgba(229,196,105,0.4); }
#menu .vis button.on { color: #f2efe4; background: rgba(229,196,105,0.10); border-color: rgba(229,196,105,0.5); }

#menu .cta-wrap { display: flex; flex-direction: column; gap: 7px; padding: 13px 16px; margin-top: 2px;
  border-top: 1px solid rgba(255,255,255,0.07); }
#menu .cta { cursor: pointer; display: flex; align-items: center; justify-content: center; gap: 9px; padding: 13px 18px;
  font: inherit; font-size: 14px; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; color: #f7e9c0;
  background: rgba(229,196,105,0.13); border: 1px solid rgba(229,196,105,0.5); border-radius: 11px;
  transition: background 0.15s, border-color 0.15s, opacity 0.15s; }
#menu .cta:hover { background: rgba(229,196,105,0.22); border-color: rgba(229,196,105,0.8); color: #fdf4dc; }
#menu .cta.dim { opacity: 0.5; }
#menu .cta-url { display: flex; align-items: center; justify-content: center; flex-wrap: wrap; gap: 8px; font-size: 11px;
  color: #6f7169; font-variant-numeric: tabular-nums; word-break: break-all; text-align: center; }

#menu .secondary { display: flex; align-items: center; justify-content: center; flex-wrap: wrap; gap: 8px; padding-bottom: 4px; }
#menu .secondary button { cursor: pointer; display: flex; align-items: center; gap: 7px; padding: 9px 15px; font: inherit;
  font-size: 12.5px; color: #b8b5aa; background: rgba(14,16,15,0.6); backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px); border: 1px solid rgba(255,255,255,0.09); border-radius: 10px; }
#menu .secondary button:hover { color: #f0ede4; border-color: rgba(255,255,255,0.2); }
#menu .secondary button:disabled { opacity: 0.45; cursor: default; }

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
  #menu .pills button { width: 40px; height: 34px; }
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
  #menu .pills button { width: 34px; }
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
#menu button:focus-visible, #menu input:focus-visible { outline: 2px solid rgba(229,196,105,0.55); outline-offset: 2px; }
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
