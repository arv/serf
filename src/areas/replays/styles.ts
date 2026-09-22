import {GOLD} from '../../ui/menuChrome';

/**
 * The shelf's one sheet, scoped under #shelf the way DOCS_STYLE is under
 * #docs, and wearing the same glass-and-gold language. Same two rules
 * undoing the game's globals, for the same reason: index.html locks the
 * document to overflow:hidden and user-select:none because a game owns its
 * gestures, and this is a page to read and scroll.
 */
export const SHELF_STYLE = `
#shelf { position: fixed; inset: 0; z-index: 20; overflow-y: auto; overflow-x: hidden;
  overscroll-behavior: contain; background: #0e1210; color: #e4e1d6;
  font-family: 'Space Grotesk', system-ui, sans-serif; font-size: 14px; line-height: 1.5;
  user-select: text; -webkit-user-select: text; }
#shelf * { box-sizing: border-box; }
#shelf a { color: ${GOLD}; text-decoration: none; }
#shelf a:hover { text-decoration: underline; }
#shelf a:focus-visible, #shelf button:focus-visible {
  outline: 2px solid rgba(229,196,105,0.55); outline-offset: 2px; border-radius: 3px; }

#shelf .shelf-head { position: sticky; top: 0; z-index: 3; display: flex; align-items: center; gap: 14px;
  padding: calc(10px + var(--safe-top)) calc(18px + var(--safe-right)) 10px calc(18px + var(--safe-left));
  background: rgba(14,16,15,0.82); backdrop-filter: blur(18px); -webkit-backdrop-filter: blur(18px);
  border-bottom: 1px solid rgba(255,255,255,0.09); }
#shelf .kicker { font-size: 11px; font-weight: 600; letter-spacing: 0.3em;
  text-transform: uppercase; color: #cbbd93; white-space: nowrap; }
#shelf .refresh { margin-left: auto; font: inherit; font-size: 12.5px; color: #cbbd93;
  background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.12);
  border-radius: 8px; padding: 4px 12px; cursor: pointer; }
#shelf .refresh:hover { color: #f0ede4; border-color: rgba(229,196,105,0.4); }
#shelf .back { font-size: 12.5px; white-space: nowrap; }

#shelf main { max-width: 1120px; margin: 0 auto;
  padding: 20px calc(18px + var(--safe-right)) calc(60px + var(--safe-bottom)) calc(18px + var(--safe-left)); }
#shelf .note { margin: 0 0 16px; color: #a9a698; max-width: 70ch; text-wrap: pretty; }
#shelf code { font-family: ui-monospace, monospace; font-size: 12.5px; color: #cbbd93; }

#shelf .table { display: flex; flex-direction: column; gap: 8px; }
/* Six columns on a desk, stacked on a phone: the widths are content-led
   (a date, the billing, three numbers, the buttons) rather than equal,
   because the middle column is the only one whose text varies in length. */
#shelf .row { display: grid; gap: 4px 16px; align-items: center; padding: 12px 16px;
  grid-template-columns: 1fr; grid-auto-rows: min-content;
  background: rgba(14,16,15,0.74); border: 1px solid rgba(255,255,255,0.09);
  border-radius: 14px; }
@media (min-width: 720px) {
  #shelf .row { grid-template-columns: 150px minmax(0,1fr) 92px 84px 84px 150px; }
}
#shelf .row.stale { opacity: 0.62; }
/* A quit match is a quieter row than one played to a winner — still a
   game, still watchable, just the commoner event. */
#shelf .row.quit { border-left: 3px solid rgba(229,196,105,0.22); }
#shelf .cell { display: flex; flex-direction: column; min-width: 0; }
#shelf .cell.num { font-variant-numeric: tabular-nums; }
@media (min-width: 720px) { #shelf .cell.num { text-align: right; } }
#shelf .strong { color: #f2efe4; font-size: 14px; overflow: hidden; text-overflow: ellipsis; }
#shelf .sub { color: #85857c; font-size: 11.5px; overflow: hidden; text-overflow: ellipsis; }

#shelf .cell.act { flex-direction: row; align-items: center; gap: 10px; }
@media (min-width: 720px) { #shelf .cell.act { justify-content: flex-end; } }
#shelf .watch { padding: 5px 14px; border-radius: 9px; font-size: 13px; font-weight: 600;
  color: #f5e4b6; background: rgba(229,196,105,0.14); border: 1px solid rgba(229,196,105,0.3); }
#shelf .watch:hover { background: rgba(229,196,105,0.22); text-decoration: none; }
#shelf .raw { font-size: 11.5px; color: #85857c; }
#shelf .no-watch { font-size: 12px; color: #85857c; }
`;
