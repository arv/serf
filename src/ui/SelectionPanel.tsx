import { For, Index, Show } from 'solid-js';
import {
  BUILDING_DEFS,
  gatherRecipeOf,
  repairBill,
  type BuildingTypeId,
  type TileResourceName,
} from '../sim/defs/buildings';
import { FORGE_QUEUE_CAP, HIRE_SERF_COST, HIRE_SERF_TICKS, TICKS_PER_SECOND, TRAIN_QUEUE_CAP } from '../sim/defs/balance';
import type { BuildingSnap } from '../protocol/messages';
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
  selectionGroup,
  setTechPanelOpen,
  stock,
  techs,
  type OrderMode,
} from './store';

import { buildingName, goodName, techName, unitName } from './names';
import {
  HIRE_KEY,
  RALLY_KEY,
  RESEARCH_KEY,
  canHire,
  canTrain,
  trainKey,
  unitTechGate,
} from './commands';
import { SHORT } from './breakpoints';

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

/**
 * The training queue as fixed positions rather than a list: every slot the
 * barracks has, in order, with the empty ones as undefined. The card draws
 * all of them always, so an order finishing changes what a slot holds and
 * never how many there are.
 */
function queueSlots(
  queue: BuildingSnap['trainQueue'],
): (NonNullable<BuildingSnap['trainQueue']>[number] | undefined)[] {
  return Array.from({ length: TRAIN_QUEUE_CAP }, (_, i) => queue?.[i]);
}

/** The forge queue's declared slots — trainQueue's trick, same reason. */
function forgeSlots(
  queue: BuildingSnap['forgeQueue'],
): (NonNullable<BuildingSnap['forgeQueue']>[number] | undefined)[] {
  return Array.from({ length: FORGE_QUEUE_CAP }, (_, i) => queue?.[i]);
}

/**
 * What "in reach" means for this building, in the terms that decide what
 * the player does about it: a spent seam is a mine to tear down, a thin
 * grove is a woodcutter that will pick up again on its own.
 */
function reachTip(type: BuildingTypeId, resource: TileResourceName, left: number): string {
  const renews = resource === 'wood';
  if (left <= 0) {
    return renews
      ? 'Every tree inside the search square is down. Stumps grow back in time, slowly — this hut will start again on its own, but a forest is where it belongs.'
      : `Nothing workable is left inside the search square, and none of it comes back. This ${buildingName(type).toLowerCase()} is finished where it stands — sell it and put the next one on fresh ground.`;
  }
  return renews
    ? 'Loads of wood still standing inside the square its woodcutter searches. Felled tiles regrow, so a hut with room to breathe holds its number rather than running down to nothing.'
    : 'Loads still in the ground inside the square its worker searches — every one of them a trip, and none of them replaced. When it reaches zero the building is done wherever it stands.';
}

export function SelectionPanel(props: {
  onTrain: (buildingId: number, unit: UnitTypeId) => void;
  onCancelTrain: (buildingId: number, index: number, unit: UnitTypeId) => void;
  onHire: () => void;
  onDeselect: () => void;
  onArmOrder: (mode: OrderMode | null) => void;
  onClearRally: (buildingId: number) => void;
  onSell: (buildingId: number) => void;
  onRepair: (buildingId: number, repair: boolean) => void;
  onTogglePause: (buildingId: number, paused: boolean) => void;
  onSetRecipe: (buildingId: number, index: number) => void;
  onEnqueueForge: (buildingId: number, recipeIndex: number) => void;
  onCancelForge: (buildingId: number, index: number, recipeIndex: number) => void;
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
             · anything the sim can add to or take from — the training
               queue — is a declared grid of slots rather than a row of
               chips sized by their own labels: the frame is drawn for
               the fullest case and the orders move inside it
           The card hangs off the bottom of the window, so a line that
           grows lifts every button above it. Height is as much of the
           frame as width is.
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

        /* The ground-in-reach readout. Its own slot for the number,
           cut for the widest a woodcutter in a deep forest can quote,
           so a felled tree cannot nudge the line it sits on. */
        .sel-reach .num { display: inline-block; min-width: 4ch; text-align: right; }
        .sel-reach .spent { color: #d98a6a; }

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

        /* ——— The training queue ———
           A declared grid, not a wrapping row of chips. The count plus
           one cell per queue slot, three to a row — six cells and two
           rows at today's cap of five, and a cap that moved would still
           be a number the layout knows before it draws anything.
           Nothing in here is sized by its own text: a cell is a third of
           the card wide whether it says "Spearman" or nothing at all,
           and the rows are a declared height rather than whatever the
           chips in them came to. */
        .sel-queue {
          display: grid;
          grid-template-columns: repeat(3, minmax(0, 1fr));
          grid-auto-rows: var(--sel-slot-h);
          gap: 6px;
          align-items: center;
        }
        /* One chip: the .sel-row button height (padding 3px on 12.5px
           text), fixed here so an empty queue reserves exactly what a
           full one uses. */
        .hud-selection { --sel-slot-h: 25px; }
        /* A thumb, on a phone or a tablet alike. Not the 44px the rest
           of the HUD grows to: this card holds a dozen controls and a
           five-slot queue, and at 44px apiece it is taller than a
           landscape phone. 34px is what a finger can hit without the
           card taking the screen — and the card scrolls now if it
           still doesn't fit. */
        @media (pointer: coarse) {
          #ui .sel-row button { min-height: 34px; padding: 5px 12px; }
          .hud-selection { --sel-slot-h: 34px; }
        }
        /* The tooltip wrapper is what the grid places, so the button has
           to fill it to keep the cell's edges (same as the build ribbon). */
        .sel-queue > .tipwrap { display: block; min-width: 0; height: 100%; }
        #ui .sel-queue button.sel-slot {
          box-sizing: border-box;
          width: 100%; height: 100%; min-height: 0;
          display: flex; align-items: center; gap: 4px;
          padding: 0 8px; font-size: 12.5px;
        }
        /* Not yet in training — waiting on ingredients and a recruit. The
           dashed outline says so without a word whose width would come
           and go the moment the recruit walked in. */
        #ui .sel-queue button.sel-slot.waiting {
          border-style: dashed; color: #c9c6ba;
        }
        .sel-slot .unit { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
        .sel-slot .x { flex: 0 0 auto; opacity: 0.7; }
        /* An order the player hasn't given yet: the outline of the slot
           it would take, so the queue is one shape at every depth and the
           barracks says how much room is left without being asked. */
        .sel-slot.empty {
          box-sizing: border-box;
          width: 100%; height: 100%;
          border: 1px dashed rgba(255, 255, 255, 0.09); border-radius: 10px;
        }

        /* ——— The forge menu ———
           Same declared-grid discipline as the training queue: the
           label and then one cell per recipe, three to a row, each cell
           a third of the card whether it holds a bow or nothing. Nine
           recipes make label + 3 rows, drawn once at selection. */
        .sel-forge {
          display: grid;
          grid-template-columns: repeat(3, minmax(0, 1fr));
          grid-auto-rows: var(--sel-slot-h);
          gap: 6px;
          align-items: center;
        }
        .sel-forge > .sel-label { grid-column: 1 / -1; }
        .sel-forge > .tipwrap { display: block; min-width: 0; height: 100%; }
        #ui .sel-forge button {
          box-sizing: border-box;
          width: 100%; height: 100%; min-height: 0;
          display: flex; align-items: center; justify-content: center; gap: 4px;
          padding: 0 6px; font-size: 12px;
        }
        .sel-forge .cost { min-width: 0; overflow: hidden; white-space: nowrap; }
        .sel-forge-idle { opacity: 0.7; }
        /* ——— The forge on a phone held sideways ———
           Nine recipes and a five-slot queue make this the tallest card
           in the game, and SHORT gives the whole bottom row about 200px.
           At the desktop shape 126px of it sat below the fold — with the
           QUEUE in that 126px, so ordering a batch showed the player
           nothing at all until they thought to scroll.
           So the cells lose their price and keep their glyph (the price
           is a tooltip away, and a phone has no room for nine of them),
           which fits five to a row instead of three; and the queue lays
           its five slots out in one row rather than two. What is left is
           the whole card: recipes, queue and what the fire does between
           orders, all of it on screen while a thumb is on it. */
        @media ${SHORT} {
          .sel-forge { grid-template-columns: repeat(5, minmax(0, 1fr)); }
          /* Six, not five: the queue's label is a cell like any other, so
             six columns is what puts it and all five slots on ONE row.
             At five it wrapped to two and gave back the row the recipes
             had just saved. */
          .sel-forge-queue { grid-template-columns: repeat(6, minmax(0, 1fr)); }
          /* A sixth of the card is about 58px, and "queue 0/5" at 12px
             with a 2ch slot cut for the count is wider than that — it
             broke after the count and took a second line back. Smaller,
             unwrapped, and the slot given up: the count is one digit
             against a cap of five, so nothing here can move anything. */
          .sel-forge-queue .sel-label { font-size: 11px; white-space: nowrap; }
          .sel-forge-queue .sel-label .num { min-width: 0; }
          .sel-forge .cost { display: none; }
          #ui .sel-forge button { padding: 0 2px; }
          /* The order chips lose their name for the same reason the
             recipe cells lose their price: at a fifth of a 380px card
             "Fishing Rod ✕" is three clipped letters. The glyph is the
             one part that still reads, and it is the part that says
             which order this is. */
          .sel-forge-queue .sel-slot .unit .label { display: none; }
          #ui .sel-forge-queue button.sel-slot { justify-content: center; padding: 0 4px; }
        }
        #ui button.sel-idle-clear {
          min-height: 0; padding: 0 6px; font-size: 11px; vertical-align: 1px;
        }
      `}</style>

      <Show when={selectedBuilding()}>
        {(b) => {
          const def = () => BUILDING_DEFS[b().type];
          /** The gather recipe, if this building works the land at all —
              a type-level fact, so the reach line it drives is either
              on this card for as long as the building is selected or
              never on it. */
          const gather = () => gatherRecipeOf(def());
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
          /** What a fresh order would be struck against: the damage, less
              what a running repair has already been paid to put back (a mend
              runs on for a few seconds after the last plank lands). */
          const unpaid = () => b().maxHp - b().hp - (b().repairPending ?? 0);
          /** Manned rather than staffed: the guard tower holds soldiers, and
              the card's people-shaped controls speak of them instead. */
          const manned = () => b().garrisonCap !== undefined;
          const garrison = () => b().garrison ?? 0;
          /** Villagers on the roof rather than soldiers. */
          const levied = () => b().levied === true;
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
                  word of commentary — the three of them keep their
                  places for as long as this building is selected. */}
              <Show when={hasOrders()}>
                <div class="sel-row">
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
                            ? 'Stops the order. Materials already worked into the walls stay there; the ones still walking over turn around and go back into the stores.'
                            : b().repairPending !== undefined
                              ? 'The last of the materials are in and the masons are at work — this one is paid for and finishing on its own.'
                              : unpaid() > 0
                                ? 'Calls for materials — half the build price, scaled by the damage. The serfs carry them over and the masons work them in, so the walls come back up over the next few seconds rather than all at once.'
                                : 'Not a scratch on it. This is where the order will be when there is.'
                        }
                      />
                    )}
                  >
                    <button
                      disabled={!b().repairNeeds && unpaid() <= 0}
                      onClick={() => props.onRepair(b().id, b().repairNeeds === undefined)}
                    >
                      {b().repairNeeds ? 'Cancel repair' : 'Repair'}
                      {/* No bill on an undamaged building — nor on one whose
                          damage is bought and only waiting on the masons:
                          repairBill of nothing is nothing, and "Repair none"
                          is worse than saying only "Repair". */}
                      <Show when={!b().repairNeeds && unpaid() > 0}>
                        <span class="cost">
                          <GoodsLine amounts={repairBill(b().type, unpaid())} />
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
                            manned()
                              ? b().paused
                                ? 'Starts the tower: villagers answer the levy again, until archers arrive to take the wall for good.'
                                : 'Stands the tower down: the villagers on the roof climb down and go back to work, and no more are called up. Archers stay — an idle one costs the village nothing — and any that turn up still man it.'
                              : b().paused
                                ? 'Puts the place back to work: it calls for a worker again, and production, deliveries and construction pick up where they left off.'
                                : 'Halts the workshop without breaking it up — no production, no incoming deliveries, no construction progress — and sends the worker home a serf, free to haul or build. Finished stock still ships out.'
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
                {/* The forge menu: one declared grid, three to a row —
                    nine recipes today and the frame would hold a tenth.
                    A click ORDERS one batch (the barracks' verb), it does
                    not retune the smith: the queue is worked first, and
                    an empty queue falls back to auto — forge whatever
                    tool the village most lacks, or nothing. */}
                <div class="sel-forge">
                  <span class="sel-label">forge</span>
                  <For each={def().recipeOptions!}>
                    {(opt, i) => {
                      const output = () => Object.keys(opt.recipe.outputs)[0] as GoodId;
                      const locked = () =>
                        opt.requiresTech !== undefined &&
                        !techs().researched.includes(opt.requiresTech);
                      const queueFull = () => (b().forgeQueue?.length ?? 0) >= FORGE_QUEUE_CAP;
                      return (
                        <TipWrap
                          tip={() => (
                            <TextTip
                              title={`Order a ${goodName(output()).toLowerCase()}`}
                              body={
                                locked()
                                  ? `Locked — needs ${techName(opt.requiresTech!)}.`
                                  : 'One batch, ahead of the standing work. Ingredients are called for when it takes the fire.'
                              }
                            />
                          )}
                        >
                          <button
                            disabled={locked() || queueFull()}
                            onClick={() => props.onEnqueueForge(b().id, i())}
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
                {/* The order book: FORGE_QUEUE_CAP declared slots, the
                    training queue's grid with the same rules. */}
                <div class="sel-queue sel-forge-queue">
                  <span class="sel-label">
                    queue <span class="num">{b().forgeQueue?.length ?? 0}</span>/{FORGE_QUEUE_CAP}
                  </span>
                  <Index each={forgeSlots(b().forgeQueue)}>
                    {(slot, i) => (
                      <Show
                        when={slot()}
                        fallback={<span class="sel-slot empty" aria-hidden="true" />}
                      >
                        {(item) => {
                          const output = () =>
                            Object.keys(
                              def().recipeOptions![item().recipeIndex]!.recipe.outputs,
                            )[0] as GoodId;
                          return (
                            <TipWrap
                              tip={() => (
                                <TextTip
                                  title={item().started ? 'Strike the order' : 'Remove from queue'}
                                  body={
                                    item().started
                                      ? 'The batch on the fire still finishes — striking the order only means nothing re-queues it.'
                                      : 'Nothing is spent until the batch takes the fire, so ingredients already delivered stay for the next order.'
                                  }
                                />
                              )}
                            >
                              <button
                                class="sel-slot"
                                classList={{ waiting: !item().started }}
                                onClick={() =>
                                  props.onCancelForge(b().id, i, item().recipeIndex)
                                }
                              >
                                <span class="unit">
                                  <GoodIcon good={output()} size={13} />{' '}
                                  <span class="label">{goodName(output())}</span>
                                </span>
                                <span class="x">✕</span>
                              </button>
                            </TipWrap>
                          );
                        }}
                      </Show>
                    )}
                  </Index>
                </div>
                {/* What the fire does between orders. Reserved line, so
                    the AI pinning or clearing a standing order (or a save
                    carrying one) never moves the buttons above it. */}
                <div class="sel-line sel-forge-idle">
                  <Show
                    when={b().recipeIndex !== undefined}
                    fallback={<span>between orders: forges the scarcest tool, or rests</span>}
                  >
                    <span>
                      between orders: forges{' '}
                      {goodName(
                        Object.keys(
                          def().recipeOptions![b().recipeIndex!]!.recipe.outputs,
                        )[0] as GoodId,
                      ).toLowerCase()}
                      s{' '}
                      <button
                        class="sel-idle-clear"
                        onClick={() => props.onSetRecipe(b().id, -1)}
                      >
                        ✕
                      </button>
                    </span>
                  </Show>
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
                {/* Wraps: three priced train buttons outgrow the card's
                    width cap on a narrow screen, and are better stacked
                    than sliced. Safe to wrap where the queue below is
                    not: what these buttons say is settled by the
                    building's type, so the row is whatever height it is
                    from the moment the barracks is selected. */}
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
                {/* The rally flag: where fresh soldiers muster as they step
                    out of the door. The button arms the next click/tap the
                    way the squad card's Attack and Move do (desktop also
                    takes a plain right-click with the barracks open); the
                    slot beside it holds either the armed hint or the
                    standing flag's note — one reserved line, so planting
                    or striking the flag never moves the queue below. */}
                <div class="sel-row">
                  <TipWrap
                    tip={() => (
                      <TextTip
                        title="Rally point"
                        body="Then click a spot: every soldier that finishes training marches there instead of standing at the door. Click the barracks itself to take the flag down."
                      />
                    )}
                  >
                    <button
                      classList={{ active: orderMode() === 'rally' }}
                      onClick={() => props.onArmOrder(orderMode() === 'rally' ? null : 'rally')}
                    >
                      <Key label="Rally" k={RALLY_KEY} />
                    </button>
                  </TipWrap>
                  <Show
                    when={orderMode() === 'rally'}
                    fallback={
                      <Show when={b().rally}>
                        <span class="sel-label">
                          soldiers muster at the flag{' '}
                          {/* The glyph is the whole visible label, so the
                              accessible name has to be spelled out. */}
                          <button
                            class="sel-idle-clear"
                            aria-label="Take the rally flag down"
                            title="Take the rally flag down"
                            onClick={() => props.onClearRally(b().id)}
                          >
                            ✕
                          </button>
                        </span>
                      </Show>
                    }
                  >
                    <span class="sel-label">click where they should muster</span>
                  </Show>
                </div>
                {/* The queue: TRAIN_QUEUE_CAP slots, declared rather than
                    measured — the same trick the build ribbon plays with
                    its cells, and for the same reason. A wrapping row of
                    chips sized by their own labels re-flowed on every
                    event the sim raised: a chip losing "· waiting" when
                    its recruit walked in shrank by fifty pixels and slid
                    the rest of the queue sideways, and an order finishing
                    took the row from three lines to two and lifted the
                    whole card — Repair, Sell and all three train
                    buttons — sixty pixels up the screen, because the card
                    is anchored to the bottom of the window. Now it is
                    the count and then one cell per slot, three to a row,
                    the unordered ones standing as empty outlines. The
                    grid is the same size for an idle barracks as for a
                    full one, so the only thing an arriving soldier
                    changes is what a slot says. */}
                <div class="sel-queue">
                  <span class="sel-label">
                    queue <span class="num">{b().trainQueue?.length ?? 0}</span>/{TRAIN_QUEUE_CAP}
                  </span>
                  {/* Index, not For: the slots are positions, so the second
                      one stays the second one when the queue behind it
                      shifts (an order finishes, or the staffing system
                      pulls a ready order to the front) and only its text
                      changes. */}
                  <Index each={queueSlots(b().trainQueue)}>
                    {(slot, i) => (
                      <Show
                        when={slot()}
                        fallback={<span class="sel-slot empty" aria-hidden="true" />}
                      >
                        {(item) => (
                          <TipWrap
                            tip={() => (
                              <TextTip
                                title={item().started ? 'Cancel training' : 'Remove from queue'}
                                body={
                                  item().started
                                    ? 'Stops the recruit mid-drill: the ingredients go back into the barracks stores and the person walks back out a serf. The time already trained is lost.'
                                    : 'Waiting on ingredients and a recruit — and nothing is spent until training starts, so ingredients already delivered stay at the barracks for the next order.'
                                }
                              />
                            )}
                          >
                            <button
                              class="sel-progress sel-slot"
                              classList={{ waiting: !item().started }}
                              onClick={() =>
                                props.onCancelTrain(b().id, i, item().unit as UnitTypeId)
                              }
                            >
                              {/* The training clock, filling the chip left to right. */}
                              <span
                                aria-hidden="true"
                                class="sel-fill"
                                style={{ width: `${(item().progress01 ?? 0) * 100}%` }}
                              />
                              {/* The name gives way before the ✕ does: on a
                                  narrow card the slot is thinner than
                                  "Spearman ✕", and a clipped word still
                                  reads while a clipped ✕ looks broken. */}
                              <span class="unit">{unitName(item().unit as UnitTypeId)}</span>
                              <span class="x">✕</span>
                            </button>
                          </TipWrap>
                        )}
                      </Show>
                    )}
                  </Index>
                </div>
              </Show>

              {/* The running commentary, last: it is the one part of the
                  card that rewrites itself unasked, so nothing the
                  player aims at sits below it. */}
              <div class="sel-line sel-status">
                {/* A tower unlocks with the barracks but shoots best with
                    archers, who wait on Archery — so it says which of the
                    two is up there, and a stood-down one says that starting
                    it is what puts villagers on the wall today. */}
                <Show when={manned() && b().state === 'built'}>
                  <span classList={{ good: garrison() > 0, bad: garrison() === 0 }}>
                    {garrison() === 0
                      ? b().paused
                        ? 'stood down — start it and villagers will man it'
                        : 'unmanned — waiting for someone to climb up'
                      : `${garrison()}/${b().garrisonCap} ${levied() ? 'villagers' : 'archers'} on the roof`}
                  </span>
                </Show>
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
                {/* The bill is settled and the walls are still going up. */}
                <Show when={!b().repairNeeds && b().repairPending !== undefined}>
                  <span class="good"> · mending</span>
                </Show>
              </div>

              {/* What the ground around it still holds. A gatherer's
                  own question, and the one the card could not answer:
                  the reach outline on the map says whether anything is
                  left, this says how much — how many more loads that
                  hut, quarry or mine can take out of the ground it
                  stands on before it is finished there. Shown for the
                  site too: a mine still going up is exactly when the
                  size of the seam under it is worth knowing. */}
              <Show when={gather()}>
                {(g) => (
                  <div class="sel-line">
                    <TipWrap
                      tip={() => (
                        <TextTip
                          title={`${goodName(g().output)} in reach`}
                          body={reachTip(b().type, g().resource, b().resourceLeft ?? 0)}
                        />
                      )}
                    >
                      <span class="sel-reach">
                        <span class="sel-label">in reach</span>{' '}
                        <GoodIcon good={g().output} size={12} />
                        <span class="num" classList={{ spent: (b().resourceLeft ?? 0) <= 0 }}>
                          {b().resourceLeft ?? 0}
                        </span>
                        <Show when={(b().resourceLeft ?? 0) <= 0}>
                          <span class="sel-label spent"> · worked out</span>
                        </Show>
                      </span>
                    </TipWrap>
                  </div>
                )}
              </Show>

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
              {/* The whole feedback loop for control groups. Ctrl+1 changes
                  nothing a player can see — the same units stay selected —
                  so without this badge the stamp is a keypress into the
                  void, and the only way to find out whether it took is to
                  press 1 and hope. It doubles as the teaching: a recall
                  that lights up "group 1" says what the number row does.

                  Tested against null rather than truthiness, and read again
                  inside rather than through Show's callback: group 0 is a
                  real group and a falsy number, and the callback would hand
                  back the boolean the `when` narrowed to, not the digit. */}
              <Show when={selectionGroup() !== null}>
                <span class="note"> · group {selectionGroup()}</span>
              </Show>
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
