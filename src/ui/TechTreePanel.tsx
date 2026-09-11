import {For, Show} from 'solid-js';
import type {Enum} from '../shared/enum.ts';
import * as BuildingTypeId from '../sim/defs/buildingTypeIdEnum.ts';
import {goodEntries} from '../sim/defs/goods';
import * as TechBranchNs from '../sim/defs/techBranchEnum.ts';
import {
  TECH_BRANCHES,
  TECH_DEFS,
  type TechId,
  TECH_IDS,
} from '../sim/defs/techs';
import {COMPACT, SHORT} from './breakpoints';
import {GoodIcon} from './icons';
import {buildingName, seatName, techDesc, techName} from './names';
import {
  myPlayerId,
  playersMeta,
  replayMode,
  setTechPanelOpen,
  techs,
  viewerId,
} from './store';
import * as TechNodeStateNs from './techNodeStateEnum.ts';
import {hauledIn, hauledTotal, studyProgress01} from './techProgress.ts';
import {TechTip, TextTip, tooltip} from './tooltip';
export type TechNodeState = Enum<typeof TechNodeStateNs>;
type TechBranch = Enum<typeof TechBranchNs>;

/**
 * Both of these keep the panel's numbers and its stylesheet in the same
 * language. TechBranch and TechNodeState are JS enum modules — values of
 * 1..n, not the words — so a record keyed by the word (and a classList
 * keyed by the value) silently produced an empty <h3> and a class called
 * "3", which is a legal class name and matches none of the rules below.
 * Written as Records over the enum so a state added to either module
 * fails the typecheck here rather than going quietly unstyled.
 */
const BRANCH_LABELS: Record<TechBranch, string> = {
  [TechBranchNs.agriculture]: 'Agriculture',
  [TechBranchNs.craft]: 'Craft',
  [TechBranchNs.warfare]: 'Warfare',
};

const NODE_CLASS: Record<TechNodeState, string> = {
  [TechNodeStateNs.done]: 'done',
  [TechNodeStateNs.researching]: 'researching',
  [TechNodeStateNs.delivering]: 'delivering',
  [TechNodeStateNs.available]: 'available',
  [TechNodeStateNs.locked]: 'locked',
};

export function TechTreePanel(props: {
  onResearch: (tech: TechId) => void;
  onCancelResearch: (tech: TechId) => void;
}) {
  const state = (id: TechId): TechNodeState => {
    const t = techs();
    if (t.researched.includes(id)) return TechNodeStateNs.done;
    if (t.active?.tech === id)
      return t.active.started
        ? TechNodeStateNs.researching
        : TechNodeStateNs.delivering;
    // No abbey, no research. The head-note already says so in words; the
    // node has to agree in form — 'available' dressed it in the pointer
    // cursor and hover glow while the click handler (rightly) swallowed
    // the click, a control that invites and then answers with nothing.
    if (!t.hasAbbey) return TechNodeStateNs.locked;
    const def = TECH_DEFS[id];
    if (!def.prereqs.every(p => t.researched.includes(p)))
      return TechNodeStateNs.locked;
    if (t.active) return TechNodeStateNs.locked;
    // The shelf is not consulted. A study is ordered on credit like a
    // building is pegged out on credit — the bill goes on the Abbey and
    // the village carries it there as it can (tick.ts) — so a node dimmed
    // for an empty storehouse would be the build ribbon's old stock gate
    // again, in the one place it was never true either: greying out the
    // plan a poor village most needs to make. The cost is written on the
    // node; what it can be paid with is the player's to read.
    return TechNodeStateNs.available;
  };

  /** One bar for the whole order: the haul is its first half, the reading
   * its second (see studyProgress01). */
  const progress = (id: TechId): number => {
    const a = techs().active;
    if (!a || a.tech !== id) return 0;
    return Math.round(studyProgress01(a) * 100);
  };

  /**
   * The order in words, on the panel's own reserved line.
   *
   * It used to be a line inside the delivering node, which meant clicking
   * a node grew it and shoved every node under it down the column — a
   * layout shift on the one click the panel exists for. A seat studies one
   * thing at a time, so this was never a per-node fact anyway: it belongs
   * in the head, where the ✕ has already paid for the height. Empty when
   * nothing is being studied, and the line is kept either way.
   */
  const studyLine = (): string => {
    const a = techs().active;
    if (!a) return '';
    if (!a.started) {
      return `${techName(a.tech)} — ${hauledIn(a)} of ${hauledTotal(
        a.tech,
      )} loads carried to the ${buildingName(BuildingTypeId.abbey)}.`;
    }
    // The same number the node's bar is drawing — the whole order, not
    // the reading on its own, so the words and the fill never disagree.
    return `${techName(a.tech)} — goods all in; ${Math.round(
      studyProgress01(a) * 100,
    )}% done.`;
  };

  return (
    <>
      {/* The tap-absorbing half of the phone sheet's scrim (the dimming
          half is the panel's own box-shadow). First in the DOM so the sheet
          paints over it, and a real element because a shadow spread is not
          hit-testable — see the media query below. */}
      <div class="tech-scrim" />
      <div class="tech-panel panel" classList={{watching: replayMode()}}>
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
        /* Both of the head's words stack on its left: the standing note
           about this tree, and under it the running line about the order
           in hand. min-width:0 so a long note shrinks rather than pushing
           the ✕ off the sheet. */
        .tech-headlines {
          display: flex; flex-direction: column; gap: 2px; min-width: 0;
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
        /* The way out of the study in hand, beside the words about it.
           Sized like the ✕ it stands next to rather than like the sheet's
           other buttons, and named with the element for the same
           specificity reason (see .tech-close above). Warm rather than
           loud: abandoning is a plain decision a village makes, not a
           destruction to be dressed in red. */
        #ui button.tech-abandon {
          flex: none; padding: 4px 10px; min-height: 0;
          border-radius: 8px; font-size: 11.5px; white-space: nowrap;
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
        /* The haul half of the same order: the same warm border, dashed,
           because nothing is being learned yet — the fill under it counts
           loads carried in, not ticks studied. */
        .tech-node.delivering {
          border-color: #dfb670; border-style: dashed;
          background: rgba(212, 169, 60, 0.08);
        }
        .tech-node.available { border-color: #c8735a; cursor: pointer; }
        .tech-node.available:hover {
          background: rgba(176, 74, 56, 0.25); box-shadow: 0 0 6px rgba(223, 182, 112, 0.35);
        }
        .tech-node.locked { opacity: 0.4; }
        /* A replay's tree is read, not clicked. An affordable node keeps
           its face — it says what the seat could take up next, which is
           the point of opening a rival's — but not the pointer cursor or
           the hover glow, which promise a click the recording cannot
           honor (the handler below declines it). */
        .tech-panel.watching .tech-node.available { cursor: default; }
        .tech-panel.watching .tech-node.available:hover {
          background: rgba(0, 0, 0, 0.18); box-shadow: none;
        }
        /* Research progress fills the node itself, the way the Hire button
           fills — a sliver of bar tacked on the bottom is easy to miss. */
        .tech-node { position: relative; overflow: hidden; }
        .tech-node > *:not(.fill) { position: relative; }
        .tech-node .fill {
          position: absolute; inset: 0 auto 0 0;
          background: rgba(223, 182, 112, 0.22); pointer-events: none;
        }
        .tech-note { font-size: 11.5px; opacity: 0.75; }
        /* One reserved line, kept whether or not anything is being
           studied — the same bargain the selection card's status line
           makes. Ordering a study must not move the tree under the
           cursor that ordered it, and one line held empty is cheaper
           than fourteen nodes each holding one. Never wraps, for the
           same reason: the head is a fixed height or it is nothing. */
        .tech-status {
          font-size: 11.5px; opacity: 0.85;
          min-height: 1.35em; line-height: 1.35;
          white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
        }

        /* A small screen, either way up: three side-by-side branches
           can't fit, and a flex row just runs off-screen. Become a
           full-height sheet with the branches stacked and scrolling.
           Keyed to COMPACT and not to width — held sideways a phone is
           844px across, and on the width gate this sheet used to render
           463px tall inside 390px of screen, with the bottom third of
           the tree simply off it. (These overrides live here, not in
           the HUD stylesheet, because this component's <style> renders
           later and would otherwise win.) */
        @media ${COMPACT} {
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

        /* Held sideways, the sheet has width it isn't using: the
           branches stack into one column because that is what a phone
           held upright has room for, and on 844px of screen that made
           a single file of nodes with a mile of scroll beside two
           empty thirds. Two columns, and the tree is a third of the
           scrolling it was. */
        @media ${SHORT} {
          .tech-branches {
            display: grid; grid-template-columns: repeat(2, minmax(0, 1fr));
            align-content: start; gap: 10px 12px;
          }
          .tech-head { min-height: 0; }
        }

        /* A thumb needs more than 26px of ✕, and that is true of a
           tablet at any width — so this hangs off the pointer rather
           than off the phone breakpoint above. It used to live in the
           HUD sheet, reaching across into this panel; a rule about
           this button belongs beside the rest of them. */
        @media (pointer: coarse) {
          #ui button.tech-close { width: 36px; height: 36px; font-size: 14px; }
          #ui button.tech-abandon { min-height: 36px; padding: 0 12px; font-size: 13px; }
        }
      `}</style>
        <div class="tech-head">
          <div class="tech-headlines">
            {/* Phrased around the name rather than in front of it: the
                old line hard-coded "a" ahead of an interpolated building
                and read "Build a Abbey". "The" agrees with anything the
                defs care to call it. */}
            <div class="tech-note">
              {/* Whose tree this is, in a replay — the HUD's seat chip
                  says so too, but a sheet this size covers it. "Build one
                  to begin" is advice, and there is nobody here to take it:
                  a seat without an Abbey is simply reported as such. */}
              <Show
                when={replayMode()}
                fallback={
                  <Show when={!techs().hasAbbey}>
                    The {buildingName(BuildingTypeId.abbey)} opens this tree —
                    build one to begin.
                  </Show>
                }
              >
                {viewerId() === myPlayerId()
                  ? 'Your studies'
                  : `${seatName(viewerId(), playersMeta())}'s studies`}
                {techs().hasAbbey
                  ? ''
                  : ` — no ${buildingName(BuildingTypeId.abbey)} standing yet`}
                . A recording takes no orders.
              </Show>
            </div>
            {/* Always rendered — see .tech-status. */}
            <div class="tech-status">{studyLine()}</div>
          </div>
          {/* The way out of an order the village cannot pay for: a study
              is billed to the Abbey and taken on credit, so nothing stops
              a seat ordering one it has no way to supply — Gilded Arms
              with no gold on the shelf and no Deep Mining to dig any —
              and a seat studies one thing at a time. Without this the
              whole tree waits behind a bill nobody can ever carry.
              Hidden in a replay, which takes no orders, and hidden when
              there is nothing to call off.

              And hidden when the tree on screen is not this seat's. Today
              that cannot happen outside a replay — both writers of
              viewerId are replay-gated (the HUD's seat chip renders under
              `replayMode`, and controls' #viewOwner returns unless it is a
              replay) — but the button would send MY cancel named with the
              tech the OTHER seat is studying, which the sim's stale-click
              guard turns into a no-op unless both seats happen to be
              studying the same thing, and then it calls off my own. A
              control whose correctness rests on a rule enforced two files
              away should say the rule itself. */}
          <Show
            when={
              !replayMode() && viewerId() === myPlayerId() && techs().active
            }
          >
            {a => (
              <button
                class="tech-abandon"
                {...tooltip(() => (
                  <TextTip
                    title={`Abandon ${techName(a().tech)}`}
                    body={
                      a().started
                        ? 'Frees the tree for another study. The goods are already in the books — nothing comes back.'
                        : `Frees the tree for another study. Loads already carried to the ${buildingName(
                            BuildingTypeId.abbey,
                          )} are spent; the ones still on the road are carried home instead.`
                    }
                  />
                ))}
                onClick={() => props.onCancelResearch(a().tech)}
              >
                Abandon
              </button>
            )}
          </Show>
          <button class="tech-close" onClick={() => setTechPanelOpen(false)}>
            ✕
          </button>
        </div>
        <div class="tech-branches">
          <For each={TECH_BRANCHES}>
            {branch => (
              <div class="tech-branch">
                <h3>{BRANCH_LABELS[branch]}</h3>
                <For
                  each={TECH_IDS.filter(id => TECH_DEFS[id].branch === branch)}
                >
                  {id => (
                    <div
                      classList={{
                        'tech-node': true,
                        [NODE_CLASS[state(id)]]: true,
                      }}
                      {...tooltip(() => <TechTip tech={id} />)}
                      onClick={() => {
                        // A recording takes no orders — the worker would
                        // drop it at the door, and the click must not
                        // claim otherwise on the way there.
                        if (replayMode()) return;
                        if (
                          state(id) === TechNodeStateNs.available &&
                          techs().hasAbbey
                        )
                          props.onResearch(id);
                      }}
                    >
                      {/* First in the DOM so it paints behind the text. */}
                      <Show
                        when={
                          state(id) === TechNodeStateNs.researching ||
                          state(id) === TechNodeStateNs.delivering
                        }
                      >
                        <div class="fill" style={{width: `${progress(id)}%`}} />
                      </Show>
                      <b>
                        {state(id) === TechNodeStateNs.done ? '✓ ' : ''}
                        {techName(id)}
                      </b>
                      <span class="cost">
                        <For each={goodEntries(TECH_DEFS[id].cost)}>
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
