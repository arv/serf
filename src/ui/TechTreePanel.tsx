import { For, Show } from 'solid-js';
import { TECH_BRANCHES, TECH_DEFS, type TechId } from '../sim/defs/techs';
import { GOODS, type GoodId } from '../sim/defs/goods';
import { GoodIcon } from './icons';
import { TechTip, tooltip } from './tooltip';
import { buildingName, techDesc, techName } from './names';
import { setTechPanelOpen, stock, techs } from './store';

const BRANCH_LABELS: Record<string, string> = {
  agriculture: 'Agriculture',
  craft: 'Craft',
  warfare: 'Warfare',
};

type NodeState = 'done' | 'researching' | 'available' | 'unaffordable' | 'locked';

export function TechTreePanel(props: { onResearch: (tech: TechId) => void }) {
  const state = (id: TechId): NodeState => {
    const t = techs();
    if (t.researched.includes(id)) return 'done';
    if (t.active?.tech === id) return 'researching';
    const def = TECH_DEFS[id];
    if (!def.prereqs.every((p) => t.researched.includes(p))) return 'locked';
    if (t.active) return 'locked';
    const s = stock();
    const affordable = GOODS.every((g) => (s[g] ?? 0) >= (def.cost[g] ?? 0));
    return affordable ? 'available' : 'unaffordable';
  };

  const progress = (id: TechId): number => {
    const a = techs().active;
    if (!a || a.tech !== id) return 0;
    return Math.round((1 - a.ticksLeft / a.totalTicks) * 100);
  };

  return (
    <>
      {/* The tap-absorbing half of the phone sheet's scrim (the dimming
          half is the panel's own box-shadow). First in the DOM so the sheet
          paints over it, and a real element because a shadow spread is not
          hit-testable — see the media query below. */}
      <div class="tech-scrim" />
      <div class="tech-panel panel">
        <style>{`
        .tech-scrim { display: none; }
        /* A header row over a row of branches, rather than one row of
           everything. Both of this sheet's furnishings — the ✕ and the
           line about needing an Abbey — were flex items among the
           branches: the note came out as a fifth column four words
           wide, stacked "Build a / Abbey to / begin / research.", and
           the ✕ sat in dead space past the last branch. Neither is a
           branch, so neither belongs in that row. */
        .tech-panel {
          position: absolute; top: 52px; left: 50%; transform: translateX(-50%);
          display: flex; flex-direction: column; gap: 10px;
          padding: 14px 18px; pointer-events: auto;
          max-width: 90vw;
          /* Modal layer — see the layer scale in Hud.tsx. Without a number
             the sheet took its luck from DOM order and lost to the floating
             touch actions (z-index 11), which drew their band-select and
             muster buttons straight through the middle of it. */
          z-index: 20;
        }
        .tech-head {
          display: flex; align-items: center; justify-content: space-between;
          gap: 18px; min-height: 26px;
        }
        /* A square icon button, sized rather than padded. #ui button's
           10px radius on a chip this small rounded it most of the way
           to a circle, which read as a stray token dropped on the
           sheet rather than its close.
           The selector is deliberate on both counts. Without #ui it
           loses every box property it declares to #ui button's; with
           only #ui .tech-close it merely *ties* any other one-class
           rule and the winner falls to whichever sheet was injected
           last, which is not a thing a button's size should depend on.
           Naming the element settles it outright. */
        #ui button.tech-close {
          flex: none; width: 26px; height: 26px; padding: 0;
          min-width: 0; min-height: 0;
          display: grid; place-items: center;
          border-radius: 8px; font-size: 12px;
        }
        /* The branches scroll, not the sheet: the ✕ is above them now
           and has to stay reachable however long the tree gets. */
        .tech-branches { display: flex; gap: 18px; min-height: 0; overflow-x: auto; }
        .tech-branch { min-width: 195px; }
        .tech-branch h3 {
          margin: 0 0 8px; font-size: 14px; color: #c8a15a;
          font-family: Georgia, 'Times New Roman', serif;
          font-variant: small-caps; letter-spacing: 0.08em;
          border-bottom: 1px solid #6b5230; padding-bottom: 4px;
        }
        .tech-node {
          border: 1px solid #6b5230; border-radius: 5px; padding: 6px 8px;
          margin-bottom: 6px; font-size: 12px; cursor: default;
          background: rgba(0, 0, 0, 0.18);
        }
        .tech-node .cost { opacity: 0.85; margin-left: 4px; }
        .tech-node .desc { opacity: 0.65; font-size: 11px; margin-top: 2px; }
        .tech-node.done { border-color: #7a9a4a; background: rgba(96, 122, 60, 0.22); }
        .tech-node.researching { border-color: #dfb670; background: rgba(212, 169, 60, 0.14); }
        .tech-node.available { border-color: #c8735a; cursor: pointer; }
        .tech-node.available:hover {
          background: rgba(176, 74, 56, 0.25); box-shadow: 0 0 6px rgba(223, 182, 112, 0.35);
        }
        .tech-node.unaffordable { opacity: 0.7; }
        .tech-node.locked { opacity: 0.4; }
        /* Research progress fills the node itself, the way the Hire button
           fills — a sliver of bar tacked on the bottom is easy to miss. */
        .tech-node { position: relative; overflow: hidden; }
        .tech-node > *:not(.fill) { position: relative; }
        .tech-node .fill {
          position: absolute; inset: 0 auto 0 0;
          background: rgba(223, 182, 112, 0.22); pointer-events: none;
        }
        .tech-note { font-size: 11.5px; opacity: 0.75; }

        /* Phone: three side-by-side branches can't fit, and a flex row just
           runs off-screen. Become a full-height sheet with the branches
           stacked and scrolling. (These overrides live here, not in the HUD
           stylesheet, because this component's <style> renders later and
           would otherwise win.) */
        @media (max-width: 760px) {
          /* Taps on the dimmed area have to stop here. #ui is
             pointer-events:none and the dimming is a box-shadow spread,
             which nothing can hit, so an order aimed at the open sheet used
             to fall straight through to the map and deselect, select, or —
             after the long press — send the selection walking. */
          .tech-scrim {
            display: block;
            position: fixed;
            inset: 0;
            pointer-events: auto;
            /* Just under the sheet, and above the touch actions it now
               covers — the scrim is what makes those taps stop here. */
            z-index: 19;
          }
          .tech-panel {
            /* A sheet this size must be opaque: at 0.72 alpha the build card
               behind it showed through and made the list unreadable. The
               huge spread shadow does the dimming; .tech-scrim above takes
               the taps. */
            background: rgba(11, 13, 12, 0.98);
            box-shadow: 0 0 0 100vmax rgba(6, 8, 7, 0.55);
            top: calc(64px + var(--safe-top));
            bottom: calc(10px + var(--safe-bottom));
            left: calc(10px + var(--safe-left));
            right: calc(10px + var(--safe-right));
            transform: none;
            max-width: none;
            max-height: none;
            gap: 10px;
            overflow: hidden;
            padding: 14px;
          }
          /* The branches stack and take the scroll; the header keeps
             the ✕ in view at the top of it. min-height:0 is what lets
             this shrink inside the column instead of pushing the
             sheet's bottom off the screen. */
          .tech-branches {
            flex-direction: column; gap: 10px;
            flex: 1 1 auto; min-height: 0;
            overflow-x: hidden; overflow-y: auto;
            /* Spell the scroll gesture out: the page itself can't scroll
               (body is overflow:hidden) and the canvas takes
               touch-action:none, so this container must claim pan-y. */
            touch-action: pan-y;
            overscroll-behavior: contain;
            -webkit-overflow-scrolling: touch;
          }
          .tech-branch { min-width: 0; width: 100%; }
          .tech-node { padding: 9px 10px; font-size: 13px; }
          .tech-node .desc { font-size: 12px; }
        }

        /* A thumb needs more than 26px of ✕, and that is true of a
           tablet at any width — so this hangs off the pointer rather
           than off the phone breakpoint above. It used to live in the
           HUD sheet, reaching across into this panel; a rule about
           this button belongs beside the rest of them. */
        @media (pointer: coarse) {
          #ui button.tech-close { width: 36px; height: 36px; font-size: 14px; }
        }
      `}</style>
        <div class="tech-head">
          {/* Phrased around the name rather than in front of it: the
              old line hard-coded "a" ahead of an interpolated building
              and read "Build a Abbey". "The" agrees with anything the
              defs care to call it. */}
          <div class="tech-note">
            <Show when={!techs().hasAbbey}>
              The {buildingName('abbey')} opens this tree — build one to begin.
            </Show>
          </div>
          <button class="tech-close" onClick={() => setTechPanelOpen(false)}>
            ✕
          </button>
        </div>
        <div class="tech-branches">
        <For each={TECH_BRANCHES}>
          {(branch) => (
            <div class="tech-branch">
              <h3>{BRANCH_LABELS[branch]}</h3>
              <For
                each={(Object.keys(TECH_DEFS) as TechId[]).filter(
                  (id) => TECH_DEFS[id].branch === branch,
                )}
              >
                {(id) => (
                  <div
                    classList={{ 'tech-node': true, [state(id)]: true }}
                    {...tooltip(() => <TechTip tech={id} />)}
                    onClick={() => {
                      if (state(id) === 'available' && techs().hasAbbey) props.onResearch(id);
                    }}
                  >
                    {/* First in the DOM so it paints behind the text. */}
                    <Show when={state(id) === 'researching'}>
                      <div class="fill" style={{ width: `${progress(id)}%` }} />
                    </Show>
                    <b>
                      {state(id) === 'done' ? '✓ ' : ''}
                      {techName(id)}
                    </b>
                    <span class="cost">
                      <For each={Object.entries(TECH_DEFS[id].cost) as [GoodId, number][]}>
                        {([good, n]) => (
                          <>
                            {' '}
                            <GoodIcon good={good} size={12} />
                            {n}
                          </>
                        )}
                      </For>
                    </span>
                    <div class="desc">{techDesc(id)}</div>
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
