import {GOLD} from '../../ui/menuChrome';

/**
 * The shelf's one sheet, wearing the same glass-and-gold language as the
 * field guide's. Two rules exist to undo the game's globals, for the same
 * reason DOCS_STYLE has them: index.html locks the document to
 * overflow:hidden and user-select:none because a game owns its gestures,
 * and this is a page to read and scroll.
 *
 * Written with native CSS nesting, so `#shelf` is said once and the shape
 * of the page is the shape of the sheet: the head, the body, and the row
 * with its cells inside it. The two breakpoint rules nest as well, which
 * puts a column's phone width and its desk width next to each other
 * instead of sixteen lines apart.
 */
export const SHELF_STYLE = `
#shelf {
  position: fixed; inset: 0; z-index: 20; overflow-y: auto; overflow-x: hidden;
  overscroll-behavior: contain; background: #0e1210; color: #e4e1d6;
  font-family: 'Space Grotesk', system-ui, sans-serif; font-size: 14px; line-height: 1.5;
  user-select: text; -webkit-user-select: text;

  & * { box-sizing: border-box; }
  & code { font-family: ui-monospace, monospace; font-size: 12.5px; color: #cbbd93; }

  & a {
    color: ${GOLD}; text-decoration: none;
    &:hover { text-decoration: underline; }
  }
  /* One ring for both kinds of control: the rows are anchors and the
     refresh is a button, and a keyboard walking the page must not be able
     to tell which is which. */
  & a:focus-visible, & button:focus-visible {
    outline: 2px solid rgba(229,196,105,0.55); outline-offset: 2px; border-radius: 3px;
  }

  & .shelf-head {
    /* Wraps rather than clips: the page sets overflow-x:hidden, so a head
       too wide for a phone does not scroll sideways to reach the way
       out — it simply loses it off the edge. */
    position: sticky; top: 0; z-index: 3; display: flex; flex-wrap: wrap;
    align-items: center; gap: 8px 14px;
    padding: calc(10px + var(--safe-top)) calc(18px + var(--safe-right)) 10px calc(18px + var(--safe-left));
    background: rgba(14,16,15,0.82); backdrop-filter: blur(18px); -webkit-backdrop-filter: blur(18px);
    border-bottom: 1px solid rgba(255,255,255,0.09);

    & .kicker {
      font-size: 11px; font-weight: 600; letter-spacing: 0.3em;
      text-transform: uppercase; color: #cbbd93; white-space: nowrap;
    }
    & .refresh {
      margin-left: auto; font: inherit; font-size: 12.5px; color: #cbbd93;
      background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.12);
      border-radius: 8px; padding: 4px 12px; cursor: pointer;
      &:hover { color: #f0ede4; border-color: rgba(229,196,105,0.4); }
    }
    & .back { font-size: 12.5px; white-space: nowrap; }
  }

  & main {
    max-width: 1120px; margin: 0 auto;
    padding: 20px calc(18px + var(--safe-right)) calc(60px + var(--safe-bottom)) calc(18px + var(--safe-left));

    & .note { margin: 0 0 16px; color: #a9a698; max-width: 70ch; text-wrap: pretty; }
  }

  & .table { display: flex; flex-direction: column; gap: 8px; }

  & .row {
    /* Six columns on a desk, stacked on a phone: the widths are
       content-led (a date, the billing, three numbers, the buttons)
       rather than equal, because the middle column is the only one whose
       text varies in length. */
    display: grid; gap: 4px 16px; align-items: center; padding: 12px 16px;
    grid-template-columns: 1fr; grid-auto-rows: min-content;
    background: rgba(14,16,15,0.74); border: 1px solid rgba(255,255,255,0.09);
    border-radius: 14px;
    @media (min-width: 720px) {
      grid-template-columns: 150px minmax(0,1fr) 92px 84px 84px 150px;
    }

    /* Recorded under another sim, so this build cannot re-run it. */
    &.stale { opacity: 0.62; }
    /* A quit match is a quieter row than one played to a winner: still a
       game, still watchable, just the commoner event. */
    &.quit { border-left: 3px solid rgba(229,196,105,0.22); }

    & .cell {
      display: flex; flex-direction: column; min-width: 0;

      &.num {
        font-variant-numeric: tabular-nums;
        @media (min-width: 720px) { text-align: right; }
      }
      &.act {
        flex-direction: row; align-items: center; gap: 10px;
        @media (min-width: 720px) { justify-content: flex-end; }
      }
    }
    & .strong { color: #f2efe4; font-size: 14px; overflow: hidden; text-overflow: ellipsis; }
    & .sub { color: #85857c; font-size: 11.5px; overflow: hidden; text-overflow: ellipsis; }

    & .watch {
      padding: 5px 14px; border-radius: 9px; font-size: 13px; font-weight: 600;
      color: #f5e4b6; background: rgba(229,196,105,0.14); border: 1px solid rgba(229,196,105,0.3);
      &:hover { background: rgba(229,196,105,0.22); text-decoration: none; }
    }
    & .raw { font-size: 11.5px; color: #85857c; }
    & .no-watch { font-size: 12px; color: #85857c; }
  }
}
`;
