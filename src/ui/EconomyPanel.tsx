import {For, Show, type JSX} from 'solid-js';
import type {Enum} from '../shared/enum.ts';
import * as GoodId from '../sim/defs/goodIdEnum.ts';
import {GOODS, GOOD_KEYS} from '../sim/defs/goods';
import {GoodIcon} from './icons';
import {goodName} from './names';
import {setEconomyPanelOpen, stock, toolWants} from './store';
import {GoodTip, tooltip} from './tooltip';

type GoodId = Enum<typeof GoodId>;

/**
 * The ledger: every good the village owns, grouped by what it is for.
 *
 * This sheet exists so the HUD strip does not have to. Thirteen goods
 * already filled the strip wall to wall (the comment over `.hud-resources`
 * tells that story), and the six tools would have pushed it to two rows on
 * every laptop — so the strip keeps the handful worth glancing at every
 * few seconds, and the full account lives here, a hover or a tap away,
 * the same arrangement Settlers used.
 *
 * Display order is this panel's own, NOT the GOODS array's: that array is
 * append-only (its index is the carry code), so new goods land at its
 * end regardless of what they are. Here they sit with their kin.
 */
const GROUPS: {label: string; goods: GoodId[]}[] = [
  {label: 'Raw', goods: [GoodId.wood, GoodId.stone, GoodId.water]},
  {label: 'Food', goods: [GoodId.wheat, GoodId.flour, GoodId.food, GoodId.ale]},
  {label: 'Metal', goods: [GoodId.iron, GoodId.silver, GoodId.gold]},
  {label: 'Arms', goods: [GoodId.spear, GoodId.sword, GoodId.bow]},
  {
    label: 'Tools',
    goods: [
      GoodId.axe,
      GoodId.pickaxe,
      GoodId.scythe,
      GoodId.hammer,
      GoodId.cauldron,
      GoodId.rod,
    ],
  },
];

// The panel must account for every good — a new one someone forgets to
// seat here should fail loudly in dev rather than silently not exist.
if (import.meta.env.DEV) {
  const seated = new Set(GROUPS.flatMap(g => g.goods));
  for (const g of GOODS) {
    if (!seated.has(g))
      throw new Error(`EconomyPanel: good '${GOOD_KEYS[g]}' is in no group`);
  }
}

/**
 * The view-transition name a good's icon or count carries, shared by its
 * chip on the goods strip and its row here: two elements answering to
 * one name across a transition are what the browser morphs one into the
 * other. Set as a custom property rather than as the name itself — the
 * name only switches on while a transition is being taken (see the
 * `ledger-vt` rules in Hud), and only on whichever of the pair is
 * standing, because a name two elements hold at once aborts the lot.
 */
export function ledgerVt(
  kind: 'icon' | 'num',
  good: GoodId,
): JSX.CSSProperties {
  return {'--vt': `ledger-${kind}-${GOOD_KEYS[good]}`};
}

/** The five columns. `morph` is the goods whose icon and count arrive from
 * the strip (and so carry its names); the rest fade in with the sheet. */
function LedgerGroups(props: {morph?: ReadonlySet<GoodId>}) {
  const vt = (kind: 'icon' | 'num', good: GoodId) =>
    props.morph?.has(good) ? ledgerVt(kind, good) : undefined;
  return (
    <div class="econ-groups">
      <For each={GROUPS}>
        {group => (
          <div class="econ-group">
            <h3>{group.label}</h3>
            <For each={group.goods}>
              {good => (
                <div
                  class="econ-row"
                  classList={{none: (stock()[good] ?? 0) === 0}}
                  {...tooltip(() => <GoodTip good={good} />)}
                >
                  <span class="vt" style={vt('icon', good)}>
                    <GoodIcon good={good} size={14} />
                  </span>
                  <span class="name">{goodName(good)}</span>
                  <Show when={group.label === 'Tools'}>
                    <span class="want">
                      {(toolWants()[good] ?? 0) > 0
                        ? `+${toolWants()[good]}`
                        : ''}
                    </span>
                  </Show>
                  <span class="num">
                    <span class="vt" style={vt('num', good)}>
                      {stock()[good] ?? 0}
                    </span>
                  </span>
                </div>
              )}
            </For>
          </div>
        )}
      </For>
    </div>
  );
}

/** Rules both shapes of the ledger share: the columns and their rows. */
const GROUP_CSS = `
  .econ-groups { display: flex; gap: 18px; min-height: 0; overflow-x: auto; }
  .econ-group { min-width: 118px; }
  .econ-group h3 {
    margin: 0 0 8px; font-size: 14px; color: #c8a15a;
    font-family: Georgia, 'Times New Roman', serif;
    font-variant: small-caps; letter-spacing: 0.08em;
    border-bottom: 1px solid #6b5230; padding-bottom: 4px;
  }
  .econ-row {
    display: flex; align-items: center; gap: 7px;
    font-size: 12.5px; padding: 3px 2px;
  }
  .econ-row .name { flex: 1; min-width: 0; }
  .econ-row .num { min-width: 3ch; text-align: right; font-weight: 600; }
  .econ-row .vt { display: inline-flex; }
  .econ-row.none { opacity: 0.45; }
  /* An open post waiting on this tool: the one number in here that
     is a task rather than a balance. Its slot is always cut, so a
     want appearing moves nothing. */
  .econ-row .want { min-width: 3.5ch; font-size: 11px; color: #e5c469; }
`;

/**
 * The ledger grown out of the goods strip — the shape it takes wherever
 * there is room (ROOMY). The strip and this sheet are one element in two
 * states: the sheet stands where the strip stood, its first row carries
 * the strip's own population and ledger chips (`head`), and the goods the
 * strip was showing fly down into their rows. Hud owns when it stands.
 */
export function LedgerSheet(props: {
  head: JSX.Element;
  morph: ReadonlySet<GoodId>;
}) {
  return (
    <div class="ledger-sheet panel vt" style={{'--vt': 'ledger-sheet'}}>
      <style>{`
        ${GROUP_CSS}
        .ledger-sheet {
          position: absolute; top: 0; left: 50%; transform: translateX(-50%);
          box-sizing: border-box; width: max-content; max-width: 100%;
          display: flex; flex-direction: column; gap: 8px;
          padding: 5px 8px 14px; pointer-events: auto;
          z-index: 20; /* modal layer — same shelf as the tech sheet */
        }
        .ledger-head { display: flex; align-items: center; gap: 2px; }
        .ledger-head h2 {
          margin: 0 auto 0 10px; font-size: 15px; color: #c8a15a;
          font-family: Georgia, 'Times New Roman', serif;
          font-variant: small-caps; letter-spacing: 0.08em;
        }
        .ledger-sheet .econ-groups { flex-wrap: wrap; padding: 0 10px; }
      `}</style>
      <div class="ledger-head">
        <h2 class="vt" style={{'--vt': 'ledger-title'}}>
          The Ledger
        </h2>
        {props.head}
      </div>
      <div class="vt" style={{'--vt': 'ledger-body'}}>
        <LedgerGroups morph={props.morph} />
      </div>
    </div>
  );
}

/** The ledger on a phone: a sheet of its own under the strip, which
 * stays put above it — only the goods it was showing fly down into their
 * rows. Opened by a tap on the strip; closed by another, or by ✕. */
export function EconomyPanel(props: {morph: ReadonlySet<GoodId>}) {
  return (
    <>
      {/* Scrim + sheet, the tech tree's arrangement — see TechTreePanel
          for why the scrim is a real element. Unlike that one, a tap on it
          closes the sheet: it covers the strip too, and the strip is what
          was tapped to open it, so tapping it again has to land somewhere
          that answers. */}
      <div class="econ-scrim" onClick={() => setEconomyPanelOpen(false)} />
      <div class="econ-panel panel">
        <style>{`
        ${GROUP_CSS}
        .econ-scrim {
          display: block;
          position: fixed; inset: 0; pointer-events: auto;
          z-index: 19;
        }
        .econ-panel {
          position: absolute;
          display: flex; flex-direction: column; gap: 10px;
          pointer-events: auto;
          z-index: 20; /* modal layer — same shelf as the tech sheet */
          background: rgba(11, 13, 12, 0.98);
          box-shadow: 0 0 0 100vmax rgba(6, 8, 7, 0.55);
          top: calc(64px + var(--safe-top));
          bottom: calc(10px + var(--safe-bottom));
          left: calc(10px + var(--safe-left));
          right: calc(10px + var(--safe-right));
          overflow: hidden; padding: 14px;
        }
        .econ-head {
          display: flex; align-items: center; justify-content: space-between;
          gap: 18px; min-height: 26px;
        }
        .econ-head h2 {
          margin: 0; font-size: 15px; color: #c8a15a;
          font-family: Georgia, 'Times New Roman', serif;
          font-variant: small-caps; letter-spacing: 0.08em;
        }
        #ui button.econ-close {
          flex: none; width: 26px; height: 26px; padding: 0;
          min-width: 0; min-height: 0;
          display: grid; place-items: center;
          border-radius: 8px; font-size: 12px;
        }
        .econ-panel .econ-groups {
          flex-direction: column; gap: 10px;
          flex: 1 1 auto; min-height: 0;
          overflow-x: hidden; overflow-y: auto;
          touch-action: pan-y;
          overscroll-behavior: contain;
          -webkit-overflow-scrolling: touch;
        }
        .econ-panel .econ-group { min-width: 0; width: 100%; }
        .econ-panel .econ-row { font-size: 13.5px; padding: 5px 2px; }
        `}</style>
        <div class="econ-head">
          <h2>The Ledger</h2>
          <button class="econ-close" onClick={() => setEconomyPanelOpen(false)}>
            ✕
          </button>
        </div>
        <LedgerGroups morph={props.morph} />
      </div>
    </>
  );
}
