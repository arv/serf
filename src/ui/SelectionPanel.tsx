import { For, Show } from 'solid-js';
import { BUILDING_DEFS } from '../sim/defs/buildings';
import { TECH_DEFS, type TechId } from '../sim/defs/techs';
import type { GoodAmounts, GoodId } from '../sim/defs/goods';
import type { UnitTypeId } from '../sim/defs/units';
import { GoodIcon, LockIcon } from './icons';
import { TipWrap, UnitTip } from './tooltip';
import { selectedBuilding, selection, techs } from './store';

import { buildingName, techName, unitName } from './names';

/** Which tech gates a trainable unit (mirrors unlockUnit effects). */
function unitTechGate(unit: UnitTypeId): TechId | undefined {
  for (const def of Object.values(TECH_DEFS)) {
    for (const e of def.effects) {
      if (e.kind === 'unlockUnit' && e.unit === unit) return def.id;
    }
  }
  return undefined;
}

function GoodsLine(props: { amounts: GoodAmounts }) {
  const entries = () =>
    (Object.entries(props.amounts) as [GoodId, number][]).filter(([, n]) => n > 0);
  return (
    <Show when={entries().length > 0} fallback={<span style={{ opacity: 0.6 }}>none</span>}>
      <For each={entries()}>
        {([good, n]) => (
          <>
            {' '}
            <GoodIcon good={good} size={12} />
            {n}
          </>
        )}
      </For>
    </Show>
  );
}

export function SelectionPanel(props: { onTrain: (buildingId: number, unit: UnitTypeId) => void }) {
  return (
    <>
      <Show when={selectedBuilding()}>
        {(b) => {
          const def = () => BUILDING_DEFS[b().type];
          return (
            <div class="hud-selection panel">
              <b style={{ 'font-family': "Georgia, 'Times New Roman', serif" }}>
                {buildingName(b().type)}
              </b>
              <span style={{ 'margin-left': '10px', opacity: 0.8 }}>
                HP {b().hp}/{b().maxHp}
              </span>
              <Show when={b().state === 'site'}>
                <span style={{ 'margin-left': '10px' }}>
                  needs <GoodsLine amounts={b().siteNeeds ?? {}} />
                </span>
              </Show>
              <Show when={b().state === 'built'}>
                <span style={{ 'margin-left': '10px' }}>
                  stock <GoodsLine amounts={b().stock} />
                  <span style={{ 'margin-left': '8px' }}>
                    in <GoodsLine amounts={b().inputs} />
                  </span>
                </span>
              </Show>
              <Show when={b().staffing}>
                <span
                  style={{
                    'margin-left': '10px',
                    color: b().staffing === 'staffed' ? '#9fb06a' : '#d98a6a',
                  }}
                >
                  {b().staffing === 'staffed'
                    ? 'worker at post'
                    : b().staffing === 'recruiting'
                      ? 'worker on the way'
                      : 'needs a worker!'}
                </span>
              </Show>
              <Show when={def().trains && b().state === 'built'}>
                <div style={{ 'margin-top': '6px', display: 'flex', gap: '6px' }}>
                  <For each={def().trains!}>
                    {(option) => {
                      const gate = unitTechGate(option.unit);
                      const locked = () => gate !== undefined && !techs().researched.includes(gate);
                      return (
                        <TipWrap
                          tip={() => (
                            <UnitTip
                              unit={option.unit}
                              cost={option.cost}
                              lockedBy={locked() ? techName(gate!) : null}
                            />
                          )}
                        >
                          <button
                            disabled={locked()}
                            onClick={() => props.onTrain(b().id, option.unit)}
                          >
                            <Show when={locked()}>
                              <LockIcon />{' '}
                            </Show>
                            {unitName(option.unit)}
                            <span class="cost">
                              <GoodsLine amounts={option.cost} />
                            </span>
                          </button>
                        </TipWrap>
                      );
                    }}
                  </For>
                  <Show when={(b().trainQueue?.length ?? 0) > 0}>
                    <span style={{ 'align-self': 'center' }}>{b().trainQueue!.length} queued</span>
                  </Show>
                </div>
              </Show>
            </div>
          );
        }}
      </Show>
      <Show when={!selectedBuilding() && selection().size > 0}>
        <div class="hud-selection panel">{selection().size} unit(s) selected</div>
      </Show>
    </>
  );
}
