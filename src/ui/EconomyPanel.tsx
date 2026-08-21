import { For, Show } from 'solid-js';
import { GOODS, type GoodId } from '../sim/defs/goods';
import { GoodIcon } from './icons';
import { GoodTip, tooltip } from './tooltip';
import { goodName } from './names';
import { setEconomyPanelOpen, stock, toolWants } from './store';
import { COMPACT } from './breakpoints';

/**
 * The ledger: every good the village owns, grouped by what it is for.
 *
 * This sheet exists so the HUD strip does not have to. Thirteen goods
 * already filled the strip wall to wall (the comment over `.hud-resources`
 * tells that story), and the six tools would have pushed it to two rows on
 * every laptop — so the strip keeps the handful worth glancing at every
 * few seconds, and the full account lives here, one tap away, the same
 * arrangement Settlers used.
 *
 * Display order is this panel's own, NOT the GOODS array's: that array is
 * append-only (its index is the carry code), so new goods land at its
 * end regardless of what they are. Here they sit with their kin.
 */
const GROUPS: { label: string; goods: GoodId[] }[] = [
  { label: 'Raw', goods: ['wood', 'stone', 'water'] },
  { label: 'Food', goods: ['wheat', 'flour', 'food', 'ale'] },
  { label: 'Metal', goods: ['iron', 'silver', 'gold'] },
  { label: 'Arms', goods: ['spear', 'sword', 'bow'] },
  { label: 'Tools', goods: ['axe', 'pickaxe', 'scythe', 'hammer', 'cauldron', 'rod'] },
];

// The panel must account for every good — a new one someone forgets to
// seat here should fail loudly in dev rather than silently not exist.
if (import.meta.env.DEV) {
  const seated = new Set(GROUPS.flatMap((g) => g.goods));
  for (const g of GOODS) {
    if (!seated.has(g)) throw new Error(`EconomyPanel: good '${g}' is in no group`);
  }
}

export function EconomyPanel() {
  return (
    <>
      {/* Scrim + sheet, exactly the tech tree's arrangement — see
          TechTreePanel for why the scrim is a real element. */}
      <div class="econ-scrim" />
      <div class="econ-panel panel">
        <style>{`
        .econ-scrim { display: none; }
        .econ-panel {
          position: absolute; top: 52px; left: 50%; transform: translateX(-50%);
          display: flex; flex-direction: column; gap: 10px;
          padding: 14px 18px; pointer-events: auto;
          max-width: 90vw;
          z-index: 20; /* modal layer — same shelf as the tech sheet */
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
        .econ-row.none { opacity: 0.45; }
        /* An open post waiting on this tool: the one number in here that
           is a task rather than a balance. Its slot is always cut, so a
           want appearing moves nothing. */
        .econ-row .want { min-width: 3.5ch; font-size: 11px; color: #e5c469; }

        @media ${COMPACT} {
          .econ-scrim {
            display: block;
            position: fixed; inset: 0; pointer-events: auto;
            z-index: 19;
          }
          .econ-panel {
            background: rgba(11, 13, 12, 0.98);
            box-shadow: 0 0 0 100vmax rgba(6, 8, 7, 0.55);
            top: calc(64px + var(--safe-top));
            bottom: calc(10px + var(--safe-bottom));
            left: calc(10px + var(--safe-left));
            right: calc(10px + var(--safe-right));
            transform: none; max-width: none; max-height: none;
            overflow: hidden; padding: 14px;
          }
          .econ-groups {
            flex-direction: column; gap: 10px;
            flex: 1 1 auto; min-height: 0;
            overflow-x: hidden; overflow-y: auto;
            touch-action: pan-y;
            overscroll-behavior: contain;
            -webkit-overflow-scrolling: touch;
          }
          .econ-group { min-width: 0; width: 100%; }
          .econ-row { font-size: 13.5px; padding: 5px 2px; }
        }
        `}</style>
        <div class="econ-head">
          <h2>The Ledger</h2>
          <button class="econ-close" onClick={() => setEconomyPanelOpen(false)}>
            ✕
          </button>
        </div>
        <div class="econ-groups">
          <For each={GROUPS}>
            {(group) => (
              <div class="econ-group">
                <h3>{group.label}</h3>
                <For each={group.goods}>
                  {(good) => (
                    <div
                      class="econ-row"
                      classList={{ none: (stock()[good] ?? 0) === 0 }}
                      {...tooltip(() => <GoodTip good={good} />)}
                    >
                      <GoodIcon good={good} size={14} />
                      <span class="name">{goodName(good)}</span>
                      <Show when={group.label === 'Tools'}>
                        <span class="want">
                          {(toolWants()[good] ?? 0) > 0 ? `+${toolWants()[good]}` : ''}
                        </span>
                      </Show>
                      <span class="num">{stock()[good] ?? 0}</span>
                    </div>
                  )}
                </For>
              </div>
            )}
          </For>
        </div>
      </div>
    </>
  );
}
