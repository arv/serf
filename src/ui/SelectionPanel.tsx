import { For, Show } from 'solid-js';
import { BUILDING_DEFS } from '../sim/defs/buildings';
import { TECH_DEFS, type TechId } from '../sim/defs/techs';
import {
  HIRE_QUEUE_CAP,
  HIRE_SERF_COST,
  HIRE_SERF_TICKS,
  TICKS_PER_SECOND,
} from '../sim/defs/balance';
import type { GoodAmounts, GoodId } from '../sim/defs/goods';
import type { UnitTypeId } from '../sim/defs/units';
import { GoodIcon, LockIcon } from './icons';
import { TextTip, TipWrap, UnitTip } from './tooltip';
import {
  myPlayerId,
  population,
  selectedBuilding,
  selection,
  setTechPanelOpen,
  stock,
  techs,
} from './store';

import { buildingName, goodName, techName, unitName } from './names';

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

export function SelectionPanel(props: {
  onTrain: (buildingId: number, unit: UnitTypeId) => void;
  onHire: () => void;
  onDeselect: () => void;
  onDismiss: (buildingId: number) => void;
  onSell: (buildingId: number) => void;
  onTogglePause: (buildingId: number, paused: boolean) => void;
  onSetRecipe: (buildingId: number, index: number) => void;
}) {
  /**
   * No bed free, so a recruit has nowhere to walk in to. Advisory — the sim
   * refuses the order too, this only stops the button lying.
   *
   * `queued` is what keeps it honest: a recruit who is paid for and still
   * walking holds a bed the head count cannot see yet, and the sim's gate
   * (hasRoomToHire) counts them. Without it the last bed reads free for the
   * eight seconds of the walk, and the click goes nowhere. The castle's own
   * queue is the whole of it — hiring always goes to the storehouse, and a
   * seat has exactly one.
   */
  const noRoom = (queued = 0): boolean => population().pop + queued >= population().cap;
  return (
    <>
      <Show when={selectedBuilding()}>
        {(b) => {
          const def = () => BUILDING_DEFS[b().type];
          return (
            <div class="hud-selection panel">
              <div
                style={{
                  display: 'flex',
                  'align-items': 'center',
                  gap: '10px',
                  'min-width': '240px',
                }}
              >
                <span style={{ 'font-size': '13.5px', 'font-weight': '600', color: '#f0ede4' }}>
                  {buildingName(b().type)}
                </span>
                <span
                  style={{
                    flex: '1',
                    height: '4px',
                    'border-radius': '2px',
                    background: 'rgba(255,255,255,0.1)',
                    overflow: 'hidden',
                  }}
                >
                  <span
                    style={{
                      display: 'block',
                      height: '100%',
                      width: `${Math.round((b().hp / Math.max(b().maxHp, 1)) * 100)}%`,
                      background: '#8fbb56',
                      'border-radius': '2px',
                    }}
                  />
                </span>
                <span
                  style={{
                    'font-size': '11.5px',
                    color: '#9b988d',
                    'font-variant-numeric': 'tabular-nums',
                  }}
                >
                  {Math.round(b().hp)}/{b().maxHp}
                </span>
              </div>
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
                  {b().state === 'site'
                    ? b().staffing === 'staffed'
                      ? 'builder at work'
                      : b().staffing === 'recruiting'
                        ? 'builder on the way'
                        : 'needs a builder!'
                    : b().staffing === 'staffed'
                      ? 'worker at post'
                      : b().staffing === 'recruiting'
                        ? 'worker on the way'
                        : 'needs a worker!'}
                </span>
              </Show>
              <Show when={b().state === 'built' && b().staffing === 'staffed'}>
                <TipWrap
                  tip={() => (
                    <TextTip
                      title="Dismiss worker"
                      body="Sends the worker back to the serf pool — the way out when nobody is free to haul or build. This post stands open for a while so the freed hands can take up new work first."
                    />
                  )}
                >
                  <button
                    style={{ 'margin-left': '8px', 'min-height': '0', padding: '3px 10px' }}
                    onClick={() => props.onDismiss(b().id)}
                  >
                    Dismiss
                  </button>
                </TipWrap>
              </Show>
              <Show
                when={
                  b().owner === myPlayerId() && !def().storage && !def().isRoad && !def().systemOnly
                }
              >
                <Show when={b().paused}>
                  <span style={{ 'margin-left': '10px', color: '#e5c469' }}>paused</span>
                </Show>
                <TipWrap
                  tip={() => (
                    <TextTip
                      title={b().paused ? 'Resume' : 'Pause'}
                      body={
                        b().paused
                          ? 'Puts the place back to work: production, deliveries and construction pick up where they left off.'
                          : 'Halts the workshop without breaking it up: no production, no incoming deliveries, no construction progress. The worker keeps the post and finished stock still ships out.'
                      }
                    />
                  )}
                >
                  <button
                    style={{ 'margin-left': '8px', 'min-height': '0', padding: '3px 10px' }}
                    onClick={() => props.onTogglePause(b().id, !b().paused)}
                  >
                    {b().paused ? 'Resume' : 'Pause'}
                  </button>
                </TipWrap>
                <TipWrap
                  tip={() => (
                    <TextTip
                      title="Sell building"
                      body="Tears it down for half its build cost back, floored per good — a half-built site refunds half of what was delivered. The worker walks out a serf; anything stocked inside is lost."
                    />
                  )}
                >
                  <button
                    style={{ 'margin-left': '8px', 'min-height': '0', padding: '3px 10px' }}
                    onClick={() => props.onSell(b().id)}
                  >
                    Sell
                  </button>
                </TipWrap>
              </Show>
              <Show when={def().recipeOptions && b().state === 'built'}>
                <div style={{ 'margin-top': '6px', display: 'flex', gap: '6px', 'align-items': 'center' }}>
                  <span style={{ opacity: 0.7, 'font-size': '12px' }}>forge</span>
                  <For each={def().recipeOptions!}>
                    {(opt, i) => {
                      const output = () => Object.keys(opt.recipe.outputs)[0] as GoodId;
                      const locked = () =>
                        opt.requiresTech !== undefined &&
                        !techs().researched.includes(opt.requiresTech);
                      const active = () => (b().recipeIndex ?? 0) === i();
                      return (
                        <TipWrap
                          tip={() => (
                            <TextTip
                              title={`Forge ${goodName(output())}s`}
                              body={
                                locked()
                                  ? `Locked — needs ${techName(opt.requiresTech!)}.`
                                  : 'Deliveries and the smith switch to this weapon; a batch already on the fire finishes first.'
                              }
                            />
                          )}
                        >
                          <button
                            classList={{ active: active() }}
                            disabled={locked()}
                            onClick={() => props.onSetRecipe(b().id, i())}
                          >
                            <Show when={locked()}>
                              <LockIcon />{' '}
                            </Show>
                            <GoodIcon good={output()} size={13} />
                            <span class="cost">
                              <GoodsLine amounts={opt.recipe.inputs} />
                            </span>
                          </button>
                        </TipWrap>
                      );
                    }}
                  </For>
                </div>
              </Show>
              <Show when={b().type === 'storehouse' && b().state === 'built'}>
                <div style={{ 'margin-top': '6px' }}>
                  <TipWrap
                    tip={() => (
                      <TextTip
                        title="Hire Serf"
                        body={
                          noRoom(b().hireQueue ?? 0)
                            ? 'Every bed in the village is taken — counting the recruits already walking in, who each need one on arrival. Build a house; each sleeps ten.'
                            : `Word goes out to the next village; the recruit walks in after about ${Math.round(
                                HIRE_SERF_TICKS / TICKS_PER_SECOND,
                              )} seconds. Costs ${HIRE_SERF_COST} silver, paid when you order.`
                        }
                      />
                    )}
                  >
                    <button
                      disabled={
                        (stock().silver ?? 0) < HIRE_SERF_COST ||
                        (b().hireQueue ?? 0) >= HIRE_QUEUE_CAP ||
                        noRoom(b().hireQueue ?? 0)
                      }
                      onClick={() => props.onHire()}
                      style={{ position: 'relative', overflow: 'hidden' }}
                    >
                      {/* The recruit's walk, filling the button left to right. */}
                      <span
                        aria-hidden="true"
                        style={{
                          position: 'absolute',
                          inset: '0 auto 0 0',
                          width: `${(b().hireQueue ? (b().hireProgress01 ?? 0) : 0) * 100}%`,
                          background: 'rgba(229, 196, 105, 0.3)',
                          'pointer-events': 'none',
                        }}
                      />
                      <span style={{ position: 'relative' }}>
                        Hire Serf
                        <Show when={(b().hireQueue ?? 0) > 1}>
                          {' '}
                          ×{b().hireQueue}
                        </Show>
                      </span>
                      <span class="cost" style={{ position: 'relative' }}>
                        <GoodIcon good="silver" size={12} />
                        {HIRE_SERF_COST}
                      </span>
                    </button>
                  </TipWrap>
                </div>
              </Show>
              <Show when={b().type === 'abbey' && b().state === 'built'}>
                <div style={{ 'margin-top': '6px', display: 'flex', 'flex-wrap': 'wrap', gap: '8px', 'align-items': 'center' }}>
                  <button onClick={() => setTechPanelOpen(true)}>Research…</button>
                  <Show when={techs().active}>
                    {(a) => (
                      <span style={{ opacity: 0.85 }}>
                        {techName(a().tech)}{' '}
                        {Math.round((1 - a().ticksLeft / a().totalTicks) * 100)}%
                      </span>
                    )}
                  </Show>
                </div>
              </Show>
              <Show when={def().trains && b().state === 'built'}>
                {/* Wraps: three train buttons plus the queue tally outgrow
                    the panel's width cap, and touch sizing widens them
                    further — spilling off-screen on anything narrow. */}
                <div style={{ 'margin-top': '6px', display: 'flex', 'flex-wrap': 'wrap', gap: '6px' }}>
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
        <div
          class="hud-selection panel"
          style={{ display: 'flex', 'align-items': 'center', gap: '10px' }}
        >
          <span style={{ flex: '1' }}>
            {selection().size} {selection().size === 1 ? 'unit' : 'units'} selected
            <span style={{ opacity: 0.6, 'margin-left': '8px', 'font-size': '12px' }}>
              {matchMedia('(pointer: coarse)').matches
                ? 'tap the ground to send them'
                : 'right-click to send them'}
            </span>
          </span>
          <button
            style={{ 'min-height': '0', padding: '4px 12px' }}
            onClick={() => props.onDeselect()}
          >
            ✕
          </button>
        </div>
      </Show>
    </>
  );
}
