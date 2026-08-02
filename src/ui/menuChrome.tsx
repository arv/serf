/**
 * The pre-boot screens' shared visual language: glass card, one gold
 * accent, Space Grotesk — the same vocabulary as the in-game HUD. Both the
 * start menu and the multiplayer War Council mount into #menu and inject
 * this sheet, which is what keeps the two screens pixel-identical instead
 * of drifting apart. Screen-specific rules live with their screen.
 */

export const GOLD = '#e5c469';

export const MENU_STYLE = `
#menu { position: fixed; inset: 0; overflow-y: auto; overflow-x: hidden; font-family: 'Space Grotesk', system-ui, sans-serif; }
#menu * { box-sizing: border-box; }
/* Both veils are fixed so they stay put while the screen scrolls; the
   background itself is the live canvas underneath (see menuBackdrop.ts). */
#menu .veil-a { position: fixed; inset: 0; background: radial-gradient(ellipse 80% 70% at 50% 42%, rgba(8,10,8,0.12) 0%, rgba(6,8,7,0.72) 100%); }
#menu .veil-b { position: fixed; inset: 0; background: linear-gradient(180deg, rgba(6,8,7,0.55) 0%, rgba(6,8,7,0) 26%, rgba(6,8,7,0) 62%, rgba(6,8,7,0.78) 100%); }
@keyframes menu-rise { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: none; } }
@media (prefers-reduced-motion: reduce) { #menu .stack { animation: none; } }

#menu .shell { position: relative; min-height: 100%; display: grid; grid-template-rows: 1fr auto; padding: 0 0 14px; }
/* 'safe' centering matters: plain centering makes the overflow unreachable
   on short windows, which is exactly when this screen needs to scroll. */
#menu .stack { min-height: 0; display: flex; flex-direction: column; align-items: center;
  justify-content: safe center; gap: 18px; animation: menu-rise 0.5s ease-out both;
  padding: calc(24px + env(safe-area-inset-top)) calc(20px + env(safe-area-inset-right)) 4px calc(20px + env(safe-area-inset-left)); }

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
#menu .seg { display: flex; gap: 2px; padding: 4px; margin: 10px 10px 0; background: rgba(0,0,0,0.38); border-radius: 11px; }
#menu .seg button { flex: 1; cursor: pointer; display: flex; align-items: center; justify-content: center; gap: 7px;
  padding: 8px 10px; font: inherit; font-size: 12.5px; font-weight: 600; letter-spacing: 0.05em; text-transform: uppercase;
  color: #94958c; background: transparent; border: none; border-radius: 9px; transition: background 0.15s, color 0.15s; }
#menu .seg button:hover { color: #f0ede4; }
#menu .seg button.on { color: #f5e4b6; background: rgba(229,196,105,0.16); }

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
#menu .browser-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
#menu .browser-head .count { font-size: 11px; color: #85857c; font-variant-numeric: tabular-nums; }
#menu .room-list { display: flex; flex-direction: column; gap: 6px; max-height: 132px; overflow-y: auto; }
#menu .room { cursor: pointer; display: flex; align-items: center; justify-content: space-between; gap: 12px;
  padding: 9px 11px; text-align: left; font: inherit; color: #cfccc2; background: rgba(255,255,255,0.03);
  border: 1px solid rgba(255,255,255,0.1); border-radius: 10px; transition: background 0.15s, border-color 0.15s; }
#menu .room:hover { border-color: rgba(229,196,105,0.4); }
#menu .room.on { color: #f2efe4; background: rgba(229,196,105,0.10); border-color: rgba(229,196,105,0.5); }
#menu .room:disabled { opacity: 0.45; cursor: default; }
#menu .room:disabled:hover { border-color: rgba(255,255,255,0.1); }
#menu .room .code { display: block; font-size: 14px; font-weight: 600; letter-spacing: 0.16em; }
#menu .room .meta { display: block; margin-top: 2px; font-size: 11px; color: #85857c; font-variant-numeric: tabular-nums; }
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

#menu .footer { display: flex; align-items: center; justify-content: space-between; gap: 12px;
  padding: 0 20px env(safe-area-inset-bottom); font-size: 11px; color: #5f6159; letter-spacing: 0.06em; }

/* Phones and short windows: same DOM, tighter stack, bigger touch targets. */
@media (max-width: 560px) {
  #menu .kicker i { display: none; }
  #menu .footer .tech { display: none; }
  #menu .footer { justify-content: center; }
  #menu .stack { gap: 14px; justify-content: flex-start; }
  #menu .pills button { width: 40px; height: 34px; }
  #menu .icon-btn { width: 40px; height: 40px; }
}
#menu button:focus-visible, #menu input:focus-visible { outline: 2px solid rgba(229,196,105,0.55); outline-offset: 2px; }
`;

/** Components, not shared element consts: a JSX element is one real DOM
 * node, and a node can only have one parent. */
export function DiceIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
      <rect x="3" y="3" width="18" height="18" rx="3" />
      <circle cx="8.5" cy="8.5" r="1.1" fill="currentColor" />
      <circle cx="15.5" cy="15.5" r="1.1" fill="currentColor" />
      <circle cx="15.5" cy="8.5" r="1.1" fill="currentColor" />
      <circle cx="8.5" cy="15.5" r="1.1" fill="currentColor" />
    </svg>
  );
}
