import { For, Show } from 'solid-js';
import { BUILDING_DEFS, repairBill } from '../sim/defs/buildings';
import { HIRE_SERF_COST, HIRE_SERF_TICKS, TICKS_PER_SECOND, TRAIN_QUEUE_CAP } from '../sim/defs/balance';
import type { GoodAmounts, GoodId } from '../sim/defs/goods';
import type { UnitTypeId } from '../sim/defs/units';
import { GoodIcon, LockIcon } from './icons';
import { TextTip, TipWrap, UnitTip } from './tooltip';
import { Key } from './shortcut';
import {
  myPlayerId,
  orderMode,
  population,
  selectedBuilding,
  selection,
  setTechPanelOpen,
  stock,
  techs,
  type OrderMode,
} from './store';

import { buildingName, goodName, techName, unitName } from './names';
import { HIRE_KEY, RESEARCH_KEY, canHire, canTrain, trainKey, unitTechGate } from './commands';

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
            <span class="num">{n}</span>
          </>
        )}
      </For>
    </Show>
  );
}

export function SelectionPanel(props: {
  onTrain: (buildingId: number, unit: UnitTypeId) => void;
  onCancelTrain: (buildingId: number, index: number, unit: UnitTypeId) => void;
  onHire: () => void;
  onDeselect: () => void;
  onArmOrder: (mode: OrderMode | null) => void;
  onDismiss: (buildingId: number) => void;
  onSell: (buildingId: number) => void;
  onRepair: (buildingId: number, repair: boolean) => void;
  onTogglePause: (buildingId: number, paused: boolean) => void;
  onSetRecipe: (buildingId: number, index: number) => void;
}) {
  /**
   * No bed free, so a recruit has nowhere to walk in to. Advisory — the sim
   * refuses the order too, this only stops the tooltip lying about why.
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
      <style>{`
        /* ——— A card that holds still ———
           Everything written on here is live: stock rises, a worker
           finally reaches his post, a wall takes an arrow. None of it
           may move a button. Four habits keep the card honest, and
           they are the same ones the rest of the HUD runs on:
             · the card is one fixed width (--sel-w, set in Hud.tsx),
               so a longer word cannot widen it
             · the controls sit together in rows of their own, above
               the running commentary rather than trailing off the end
               of it — before this, Sell was whatever number of pixels
               past "worker on the way" the sentence happened to end,
               and it moved when the sentence did
             · every live number keeps a slot cut for its largest value
             · a control that doesn't apply this second greys out
               rather than leaving, so the gap its neighbours are
               standing on never closes — and the player learns where
               Repair lives before the day they need it
           What is left changes only when the player changes it, or
           when the building itself becomes something else — a site
           finishing is news, and the card is allowed to say so. */
        .hud-selection { display: flex; flex-direction: column; gap: 6px; }

        .sel-head { display: flex; align-items: center; gap: 10px; }
        .sel-head .name { font-size: 13.5px; font-weight: 600; color: #f0ede4; }
        .sel-head .bar {
          flex: 1; height: 4px; border-radius: 2px; overflow: hidden;
          background: rgba(255, 255, 255, 0.1);
        }
        .sel-head .bar > span {
          display: block; height: 100%; border-radius: 2px; background: #8fbb56;
        }
        .sel-head .hp { font-size: 11.5px; color: #9b988d; }
        .sel-head .hp .num { min-width: 3ch; }
        .sel-head .hp .num.max { text-align: left; }

        /* One reserved line. Whatever the building is doing right now
           goes on it, and the line is the same height whether that is
           "needs a worker!" or nothing at all — so the row of buttons
           under it never learns that anything happened. */
        .sel-line { min-height: 1.35em; line-height: 1.35; font-size: 12.5px; }
        .sel-line .num { min-width: 2ch; }
        .sel-status .good { color: #9fb06a; }
        .sel-status .bad { color: #d98a6a; }
        .sel-status .note { color: #e5c469; }

        .sel-row { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
        #ui .sel-row button { min-height: 0; padding: 3px 10px; }
        .sel-label { opacity: 0.7; font-size: 12px; }

        /* The fills — a recruit's walk, a batch on the drill ground —
           are painted over the button rather than laid out beside it,
           so a clock ticking costs the layout nothing. */
        #ui .sel-progress { position: relative; overflow: hidden; }
        .sel-progress > *:not(.sel-fill) { position: relative; }
        .sel-fill {
          position: absolute; inset: 0 auto 0 0;
          background: rgba(229, 196, 105, 0.3); pointer-events: none;
        }
        /* ×2, ×3 … on the hire button: a slot, so the button doesn't
           breathe every time a recruit lands. */
        .sel-hire-n { display: inline-block; min-width: 3ch; }
      `}</style>

      <Show when={selectedBuilding()}>
        {(b) => {
          const def = () => BUILDING_DEFS[b().type];
          const mine = () => b().owner === myPlayerId();
          /**
           * Does this building offer a row of standing orders at all?
           * A type-level question on purpose: the answer has to hold
           * for as long as the thing stays selected, because the row
           * appearing halfway through would be exactly the jump this
           * card is meant to have stopped. Which of the buttons in it
           * are live right now is a separate matter, settled with
           * `reserved` below.
           */
          const hasOrders = () =>
            mine() && b().state === 'built' && !def().isRoad && !def().systemOnly;
          const damaged = () => b().repairNeeds !== undefined || b().hp < b().maxHp;
          return (
            <div class="hud-selection panel">
              <div class="sel-head">
                <span class="name">{buildingName(b().type)}</span>
                <span class="bar">
                  <span
                    style={{ width: `${Math.round((b().hp / Math.max(b().maxHp, 1)) * 100)}%` }}
                  />
                </span>
                <span class="hp">
                  <span class="num">{Math.round(b().hp)}</span>/
                  <span class="num max">{b().maxHp}</span>
                </span>
              </div>

              {/* Standing orders, straight under the name and before a
                  word of commentary — the four of them keep their
                  places for as long as this building is selected. */}
              <Show when={hasOrders()}>
                <div class="sel-row">
                  <TipWrap
                    tip={() => (
                      <TextTip
                        title="Dismiss worker"
                        body={
                          b().staffing === 'staffed'
                            ? 'Sends the worker back to the serf pool — the way out when nobody is free to haul or build. This post stands open for a while so the freed hands can take up new work first.'
                            : 'Nobody is at this post to send home.'
                        }
                      />
                    )}
                  >
                    <button
                      disabled={b().staffing !== 'staffed'}
                      onClick={() => props.onDismiss(b().id)}
                    >
                      Dismiss
                    </button>
                  </TipWrap>
                  {/* Repairs get a slot of their own rather than a line
                      in the block below, because the castle — which may
                      be neither paused nor sold — is exactly the
                      building you most want mended. */}
                  <TipWrap
                    tip={() => (
                      <TextTip
                        title={b().repairNeeds ? 'Call off the repair' : 'Repair building'}
                        body={
                          b().repairNeeds
                            ? 'Stops the order. Materials already nailed on stay nailed on; the ones still walking over turn around and go back into the stores.'
                            : damaged()
                              ? 'Calls for materials — half the build price, scaled by the damage — and the serfs who carry them patch the walls as they arrive. Cheaper than rebuilding, and the worker never leaves the post.'
                              : 'Not a scratch on it. This is where the order will be when there is.'
                        }
                      />
                    )}
                  >
                    <button
                      disabled={!damaged()}
                      onClick={() => props.onRepair(b().id, b().repairNeeds === undefined)}
                    >
                      {b().repairNeeds ? 'Cancel repair' : 'Repair'}
                      {/* No bill on an undamaged building: repairBill of
                          nothing is nothing, and "Repair none" is worse
                          than saying only "Repair". */}
                      <Show when={!b().repairNeeds && damaged()}>
                        <span class="cost">
                          <GoodsLine amounts={repairBill(b().type, b().maxHp - b().hp)} />
                        </span>
                      </Show>
                    </button>
                  </TipWrap>
                  <Show when={!def().storage}>
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
                      <button onClick={() => props.onTogglePause(b().id, !b().paused)}>
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
                      <button onClick={() => props.onSell(b().id)}>Sell</button>
                    </TipWrap>
                  </Show>
                </div>
              </Show>

              <Show when={def().recipeOptions && b().state === 'built'}>
                <div class="sel-row">
                  <span class="sel-label">forge</span>
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
                <div class="sel-row">
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
                      class="sel-progress"
                      disabled={!canHire(b(), stock(), population())}
                      onClick={() => props.onHire()}
                    >
                      {/* The recruit's walk, filling the button left to right. */}
                      <span
                        aria-hidden="true"
                        class="sel-fill"
                        style={{
                          width: `${(b().hireQueue ? (b().hireProgress01 ?? 0) : 0) * 100}%`,
                        }}
                      />
                      <span>
                        <Key label="Hire Serf" k={HIRE_KEY} />
                        <span class="sel-hire-n">
                          <Show when={(b().hireQueue ?? 0) > 1}> ×{b().hireQueue}</Show>
                        </span>
                      </span>
                      <span class="cost">
                        <GoodIcon good="silver" size={12} />
                        {HIRE_SERF_COST}
                      </span>
                    </button>
                  </TipWrap>
                </div>
              </Show>

              <Show when={b().type === 'abbey' && b().state === 'built'}>
                <div class="sel-row">
                  <button onClick={() => setTechPanelOpen(true)}>
                    <Key label="Research…" k={RESEARCH_KEY} />
                  </button>
                  <Show when={techs().active}>
                    {(a) => (
                      <span style={{ opacity: 0.85 }}>
                        {techName(a().tech)}{' '}
                        <span class="num">
                          {Math.round((1 - a().ticksLeft / a().totalTicks) * 100)}
                        </span>
                        %
                      </span>
                    )}
                  </Show>
                </div>
              </Show>

              <Show when={def().trains && b().state === 'built'}>
                {/* Wraps: three train buttons plus the queue row outgrow
                    the panel's width cap, and touch sizing widens them
                    further — spilling off-screen on anything narrow. */}
                <div class="sel-row">
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
                            disabled={!canTrain(b(), option.unit, techs().researched)}
                            onClick={() => props.onTrain(b().id, option.unit)}
                          >
                            <Show when={locked()}>
                              <LockIcon />{' '}
                            </Show>
                            <Key label={unitName(option.unit)} k={trainKey(option.unit)} />
                            <span class="cost">
                              <GoodsLine amounts={option.cost} />
                            </span>
                          </button>
                        </TipWrap>
                      );
                    }}
                  </For>
                </div>
                {/* One chip per order, in queue order. The fill is the same
                    device as the hire button's: the started item's training
                    clock, left to right. Clicking a chip cancels it.
                    The row stands whether or not anything is in it — a
                    recruit finishing used to fold it away and drop the
                    train buttons a line down the card. */}
                <div class="sel-row">
                  <span class="sel-label">
                    queue <span class="num">{b().trainQueue?.length ?? 0}</span>/{TRAIN_QUEUE_CAP}
                  </span>
                  <For each={b().trainQueue ?? []}>
                    {(item, i) => (
                      <TipWrap
                        tip={() => (
                          <TextTip
                            title={item.started ? 'Cancel training' : 'Remove from queue'}
                            body={
                              item.started
                                ? 'Stops the recruit mid-drill: the ingredients go back into the barracks stores and the person walks back out a serf. The time already trained is lost.'
                                : 'Nothing is spent until training starts — ingredients already delivered stay at the barracks for the next order.'
                            }
                          />
                        )}
                      >
                        <button
                          class="sel-progress"
                          onClick={() => props.onCancelTrain(b().id, i(), item.unit as UnitTypeId)}
                        >
                          {/* The training clock, filling the chip left to right. */}
                          <span
                            aria-hidden="true"
                            class="sel-fill"
                            style={{ width: `${(item.progress01 ?? 0) * 100}%` }}
                          />
                          <span>
                            {unitName(item.unit as UnitTypeId)}
                            <Show when={!item.started}>
                              <span style={{ opacity: 0.6 }}> · waiting</span>
                            </Show>{' '}
                            ✕
                          </span>
                        </button>
                      </TipWrap>
                    )}
                  </For>
                </div>
              </Show>

              {/* The running commentary, last: it is the one part of the
                  card that rewrites itself unasked, so nothing the
                  player aims at sits below it. */}
              <div class="sel-line sel-status">
                <Show when={b().staffing}>
                  <span classList={{ good: b().staffing === 'staffed', bad: b().staffing !== 'staffed' }}>
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
                <Show when={b().paused}>
                  <span class="note"> · paused</span>
                </Show>
                <Show when={b().repairNeeds}>
                  {(needs) => (
                    <span class="good">
                      {' '}
                      · repairing, wants <GoodsLine amounts={needs()} />
                    </span>
                  )}
                </Show>
              </div>

              <div class="sel-line">
                <Show when={b().state === 'site'}>
                  <span>
                    needs <GoodsLine amounts={b().siteNeeds ?? {}} />
                  </span>
                </Show>
                <Show when={b().state === 'built'}>
                  <span>
                    stock <GoodsLine amounts={b().stock} /> <span style={{ 'margin-left': '8px' }}>
                      in <GoodsLine amounts={b().inputs} />
                    </span>
                  </span>
                </Show>
              </div>
            </div>
          );
        }}
      </Show>

      <Show when={!selectedBuilding() && selection().size > 0}>
        <div class="hud-selection panel">
          <div class="sel-row">
            <span style={{ flex: '1', 'min-width': '150px' }}>
              <span class="num">{selection().size}</span>{' '}
              {selection().size === 1 ? 'unit' : 'units'} selected
            </span>
            {/* The A/M shortcuts' home on screen — and, tapped, the touch way
                to the two orders a finger otherwise cannot ask for: the plain
                walk that ignores what it passes, and the full attack-move.
                A single tap on the map still sends the half order between
                them. Clicking an armed button again calls the order off. */}
            <TipWrap
              tip={() => (
                <TextTip
                  title="Attack-move"
                  body="Then click a spot: they advance on it and engage anything they meet on the way."
                />
              )}
            >
              <button
                classList={{ active: orderMode() === 'attack' }}
                onClick={() => props.onArmOrder(orderMode() === 'attack' ? null : 'attack')}
              >
                <Key label="Attack" k="A" />
              </button>
            </TipWrap>
            <TipWrap
              tip={() => (
                <TextTip
                  title="Move"
                  body="Then click a spot: they walk there and ignore every fight on the way — the order to retreat with."
                />
              )}
            >
              <button
                classList={{ active: orderMode() === 'move' }}
                onClick={() => props.onArmOrder(orderMode() === 'move' ? null : 'move')}
              >
                <Key label="Move" k="M" />
              </button>
            </TipWrap>
            <button onClick={() => props.onDeselect()}>✕</button>
          </div>
          {/* An armed order outranks the standing advice: what the next
              click does has just changed, and "right-click to send them"
              beside a lit Attack button is the card contradicting itself.
              This line is the only thing that says so — the cursor
              deliberately does not change. Its own reserved line, below
              the buttons, so swapping one sentence for another cannot
              shuffle them. */}
          <div class="sel-line" style={{ opacity: 0.6 }}>
            {orderMode() === 'attack'
              ? 'click where to attack-move'
              : orderMode() === 'move'
                ? 'click where to walk'
                : matchMedia('(pointer: coarse)').matches
                  ? 'tap the ground to send them'
                  : 'right-click to send them'}
          </div>
        </div>
      </Show>
    </>
  );
}
