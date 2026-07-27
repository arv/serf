import { For, Show } from 'solid-js';
import { TECH_BRANCHES, TECH_DEFS, type TechId } from '../sim/defs/techs';
import { GOODS, type GoodId } from '../sim/defs/goods';
import { GoodIcon } from './icons';
import { TechTip, tooltip } from './tooltip';
import { buildingName, techName } from './names';
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
    <div class="tech-panel panel">
      <style>{`
        .tech-panel {
          position: absolute; top: 52px; left: 50%; transform: translateX(-50%);
          display: flex; gap: 18px; padding: 14px 18px; pointer-events: auto;
          max-width: 90vw; overflow-x: auto;
        }
        .tech-close {
          position: absolute; top: 8px; right: 8px; min-width: 0; padding: 2px 8px;
        }
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
        .tech-node .bar { height: 3px; background: #dfb670; margin-top: 4px; border-radius: 2px; }
        .tech-note { font-size: 11px; opacity: 0.75; margin-top: 6px; }
      `}</style>
      <button class="tech-close" onClick={() => setTechPanelOpen(false)}>
        ✕
      </button>
      <Show when={!techs().hasTerakoya}>
        <div class="tech-note">Build a {buildingName('terakoya')} to begin research.</div>
      </Show>
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
                    if (state(id) === 'available' && techs().hasTerakoya) props.onResearch(id);
                  }}
                >
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
                  <div class="desc">{TECH_DEFS[id].desc}</div>
                  <Show when={state(id) === 'researching'}>
                    <div class="bar" style={{ width: `${progress(id)}%` }} />
                  </Show>
                </div>
              )}
            </For>
          </div>
        )}
      </For>
    </div>
  );
}
