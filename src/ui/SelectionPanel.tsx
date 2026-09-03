import {For, Index, Show} from 'solid-js';
import type {BuildingSnap} from '../protocol/messages';
import type {Enum} from '../shared/enum.ts';
import {
  FORGE_QUEUE_CAP,
  HIRE_QUEUE_CAP,
  HIRE_SERF_COST,
  HIRE_SERF_TICKS,
  TICKS_PER_SECOND,
  TRAIN_QUEUE_CAP,
} from '../sim/defs/balance';
import {BUILDING_DEFS, gatherRecipeOf, repairBill} from '../sim/defs/buildings';
import {type GoodAmounts, goodEntries, goodKeys} from '../sim/defs/goods';
import {UNIT_DEFS} from '../sim/defs/units';
import {GoodIcon, LockIcon, UnitIcon} from './icons';
import {Key} from './shortcut';
import {
  myPlayerId,
  orderMode,
  playersMeta,
  population,
  replayMode,
  selectedBuilding,
  selection,
  selectionGroup,
  selectionOwner,
  selectionUnits,
  setTechPanelOpen,
  simTick,
  stock,
  techs,
  viewerId,
} from './store';
import {TextTip, TipWrap, UnitTip} from './tooltip';

import * as StaffingState from '../protocol/staffingStateEnum.ts';
import * as BuildingState from '../sim/buildingStateEnum.ts';
import * as BuildingTypeId from '../sim/defs/buildingTypeIdEnum.ts';
import * as GoodId from '../sim/defs/goodIdEnum.ts';
import * as UnitTypeId from '../sim/defs/unitTypeIdEnum.ts';
import type {TileResourceKind} from '../sim/map';
import * as TileResource from '../sim/tileResourceEnum.ts';
import {SHORT} from './breakpoints';
import {
  HIRE_KEY,
  RALLY_KEY,
  RESEARCH_KEY,
  canHire,
  canTrain,
  trainKey,
  unitTechGate,
} from './commands';
import {levyOrder} from './levy';
import {
  buildingName,
  goodName,
  seatName,
  techName,
  unitName,
  unitNamePlural,
} from './names';
import * as OrderMode from './orderModeEnum.ts';
import {ROSTER_TILES, hpFraction, hpTone, rosterGroups} from './roster';

type BuildingTypeId = Enum<typeof BuildingTypeId>;
type UnitTypeId = Enum<typeof UnitTypeId>;
type OrderMode = Enum<typeof OrderMode>;

function GoodsLine(props: {amounts: GoodAmounts}) {
  const entries = () => goodEntries(props.amounts).filter(([, n]) => n > 0);
  return (
    <Show
      when={entries().length > 0}
      fallback={<span style={{opacity: 0.6}}>none</span>}
    >
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
  return Array.from({length: TRAIN_QUEUE_CAP}, (_, i) => queue?.[i]);
}

/** The forge queue's declared slots — trainQueue's trick, same reason. */
function forgeSlots(
  queue: BuildingSnap['forgeQueue'],
): (NonNullable<BuildingSnap['forgeQueue']>[number] | undefined)[] {
  return Array.from({length: FORGE_QUEUE_CAP}, (_, i) => queue?.[i]);
}

/**
 * The hire queue's declared slots. The same trick again, over a count
 * rather than a list: the sim keeps the castle's recruits as a number
 * (every one of them is the same man), so a slot is filled or it is not.
 */
function hireSlots(queued: number | undefined): boolean[] {
  return Array.from({length: HIRE_QUEUE_CAP}, (_, i) => i < (queued ?? 0));
}

/**
 * What "in reach" means for this building, in the terms that decide what
 * the player does about it: a spent seam is a mine to tear down, a thin
 * grove is a woodcutter that will pick up again on its own.
 */
function reachTip(
  type: BuildingTypeId,
  resource: TileResourceKind,
  left: number,
): string {
  const renews = resource === TileResource.Wood;
  if (left <= 0) {
    return renews
      ? 'Every tree inside the search square is down. Stumps grow back in time, slowly — this hut will start again on its own, but a forest is where it belongs.'
      : `Nothing workable is left inside the search square, and none of it comes back. This ${buildingName(type).toLowerCase()} is finished where it stands — sell it and put the next one on fresh ground.`;
  }
  return renews
    ? 'Loads of wood still standing inside the square its woodcutter searches. Felled tiles regrow, so a hut with room to breathe holds its number rather than running down to nothing.'
    : 'Loads still in the ground inside the square its worker searches — every one of them a trip, and none of them replaced. When it reaches zero the building is done wherever it stands.';
}

/**
 * A booked pickup nobody has claimed, held this long: the one state where
 * a staffed hut on good ground still makes nothing (its shelf fills and
 * production stops on the full-buffer rule), and the one the card used to
 * be silent about — it reads identically to a treeless hut from the
 * outside. Alarmed only after a real wait: the matcher books pickups
 * seconds before a hand frees up in a village's ordinary churn, and a
 * card that cried over that would teach the player to ignore it.
 */
const HAUL_STARVED_AFTER = 10 * TICKS_PER_SECOND;

const HAUL_STARVED_TIP =
  'Loads sit here with a pickup booked and no serf free to come — and a ' +
  'hut downs tools the moment its shelf fills, so an uncollected pile is ' +
  'a stopped saw. Construction and workshop errands outrank carrying ' +
  'goods home, so a village short of hands starves its storehouse first. ' +
  'Hire serfs at the castle, or let the sites and workshops ahead of ' +
  'this pile finish.';

export function SelectionPanel(props: {
  onTrain: (buildingId: number, unit: UnitTypeId) => void;
  onCancelTrain: (buildingId: number, index: number, unit: UnitTypeId) => void;
  onHire: () => void;
  onCancelHire: (index: number) => void;
  onDeselect: () => void;
  /** One face on the roster, clicked: him alone, or dropped with shift. */
  onPickUnit: (id: number, additive: boolean) => void;
  onArmOrder: (mode: OrderMode | null) => void;
  /** Hold ground — sent on the spot, unlike the two orders above. */
  onHold: () => void;
  onClearRally: (buildingId: number) => void;
  onSell: (buildingId: number) => void;
  onRepair: (buildingId: number, repair: boolean) => void;
  onTogglePause: (buildingId: number, paused: boolean) => void;
  onSetRecipe: (buildingId: number, index: number) => void;
  onEnqueueForge: (buildingId: number, recipeIndex: number) => void;
  onCancelForge: (
    buildingId: number,
    index: number,
    recipeIndex: number,
  ) => void;
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
  const noRoom = (queued = 0): boolean =>
    population().pop + queued >= population().cap;

  /**
   * The selection as people rather than ids — kind and hitpoints a head,
   * in display order. Controls refills it off each new publish of the unit
   * buffer — twenty a second — and then only when a value the card draws
   * has actually moved.
   */
  const roster = () => selectionUnits();
  /**
   * What the head counts — the roster, so it counts the same people the
   * tiles under it draw.
   *
   * The id set would be the more obvious source and is the wrong one: the
   * roster drops an id the latest publish has stopped carrying (see
   * rosterOf — that is a man who died between the two reads, and half a
   * frame of a ghost tile is worse than none), and a head reading off the
   * ids would spend that frame saying six over five faces.
   *
   * The fall back to the ids covers the other end of it: a selection made
   * before any publish has been read has nobody in the roster yet, and a
   * card headed "0 units selected" over an empty grid would be worse than
   * a count that is momentarily ahead of the faces. The tiles need two
   * people before they draw at all, so nothing contradicts it there.
   */
  const headCount = () => roster().length || selection().size;
  /** The soldiers in hand — who the hold order is for. */
  const fighters = () =>
    roster().filter(u => UNIT_DEFS[u.kind].combat !== undefined);
  /** The one in hand, when it is one — the card that gets a name. */
  const lone = () => (roster().length === 1 ? roster()[0]! : null);
  /** All of one kind, so the head can name them: knights, not units. */
  const soleKind = () => {
    const kinds = rosterGroups(roster());
    return kinds.length === 1 ? kinds[0]!.kind : null;
  };
  /** The kind the head speaks for — one man's, or a whole squad's when
   * they are all the same. Null for a mixed band, which has none. */
  const headKind = () => lone()?.kind ?? soleKind();
  /**
   * The tiles the card actually draws — three rows of eight, which is as
   * far down the screen as this card may grow: past that a phone held
   * sideways is all roster and no valley. The last cell goes to the count
   * of who did not fit rather than to an arbitrary twenty-fourth man, and
   * the roster hands the wounded over first when it is being cut, so the
   * men who did not fit are the ones with nothing wrong with them.
   */
  const shown = () =>
    roster().length > ROSTER_TILES
      ? roster().slice(0, ROSTER_TILES - 1)
      : roster();
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
        /* Glyph and name travel together — one tooltip target, and one
           item in the head's row, so the health pinned to the right of it
           has a single edge to sit against either way. */
        .sel-head .sel-who { display: inline-flex; align-items: center; gap: 7px; min-width: 0; }
        .sel-head .name { font-size: 13.5px; font-weight: 600; color: #f0ede4; }
        .sel-head .bar {
          flex: 1; height: 4px; border-radius: 2px; overflow: hidden;
          background: rgba(255, 255, 255, 0.1);
        }
        .sel-head .bar > span {
          display: block; height: 100%; border-radius: 2px; background: #8fbb56;
        }
        /* The count at the head of a squad's card keeps a slot too — a
           casualty taking it from 10 to 9 must not slide the group badge
           beside it. */
        .sel-head .name .num { min-width: 2ch; }
        .sel-head .hp { font-size: 11.5px; color: #9b988d; }
        .sel-head .hp .num { min-width: 3ch; }
        .sel-head .hp .num.max { text-align: left; }
        /* Health, in the three colors the tiles use: fine, hurt, and
           about to be a casualty. A bar sliding through every shade
           between green and red says "something is happening"; three
           steps say which of the three things the player has to decide
           — leave him, pull him out, or write him off. */
        .sel-head .bar > span.hurt { background: #e0b74f; }
        .sel-head .bar > span.dire { background: #d0714f; }

        /* The control-group badge, quiet beside the name: it is the same
           crumb the unit card carries, and the name is what the head is
           for. Muted like the hp text rather than set in the name's own
           13.5/600, which would read as a second title. */
        .sel-head .note { font-size: 11.5px; color: #9b988d; }

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
        /* Hauler starvation, in the worked-out alarm's color: both are
           "this hut makes nothing", and the words carry the difference.
           The seconds keep a slot so a wait crossing 99s cannot rewrap
           the line. */
        .sel-starved { color: #d98a6a; font-size: 12px; }
        .sel-starved .num { display: inline-block; min-width: 3ch; text-align: right; }

        /* ——— Who is in hand ———
           The roster answers "what did I just pick up?", and it is built
           to the same rule as the rest of the card: nothing is sized by
           its own text. A declared grid of eight columns and a fixed row
           height, so a tile is an eighth of the card whatever is in it.
           There was a tally by kind over this — a row of glyphs and
           counts — and it was the same glyphs the tiles underneath were
           already showing, one line higher and without the health. Two
           readings of one fact is one of them to skip.
           A tile is a glyph over a bar and no number. The number was
           there first, and it was read as the kind's stat rather than
           as this man's state — every tile in a healthy squad prints
           its maximum, so "80" looked like what a knight is rather
           than how he is. The bar says the same thing as a picture,
           which is the thing worth scanning twenty of; the exact
           figure is a hover away in the tooltip, and the head of a
           lone selection still spells it out. */
        .sel-roster {
          display: grid;
          grid-template-columns: repeat(8, minmax(0, 1fr));
          grid-auto-rows: var(--sel-tile-h);
          gap: 5px;
        }
        .hud-selection { --sel-tile-h: 30px; }
        /* Room for a thumb's worth of tooltip press, the same trade the
           queue's slots make one card over. */
        @media (pointer: coarse) { .hud-selection { --sel-tile-h: 40px; } }
        /* The tooltip wrapper is what the grid places, so the tile has to
           fill it to keep the cell's edges. */
        .sel-roster > .tipwrap { display: block; min-width: 0; height: 100%; }
        /* Written against the id rather than the bare class because the
           tile is a button now, and the HUD's own button rule — 13px
           text, 10px corners, 7px of padding — is the more specific
           selector of the two. A cell a sixth the width of
           the card cannot afford any of that. The gold hover it also
           brings is kept: this is a thing you click, and it should say so
           under the cursor. */
        #ui .sel-tile {
          box-sizing: border-box;
          display: flex; flex-direction: column; justify-content: center; gap: 3px;
          width: 100%; height: 100%; padding: 3px 4px; border-radius: 5px;
          font-size: 12px;
          /* Zero, because a coarse pointer gives every button in the HUD a
             44px floor (Hud.tsx) and the cell it has to sit in is 40. The
             row is the thumb target here — the whole of it, which is why
             the tile fills it — so the floor made each face four pixels
             taller than the row it was drawn in and pushed it over the
             one below. The grid decides the height; the button obeys. */
          min-height: 0;
          background: rgba(255, 255, 255, 0.06);
          border: 1px solid rgba(255, 255, 255, 0.09);
        }
        /* The keyboard's turn: the roster is a row of buttons now, so it
           is tabbable, and a focus ring that the mouse never shows is
           what tells someone arriving by Tab which man they are on. */
        #ui .sel-tile:focus-visible {
          outline: 2px solid rgba(229, 196, 105, 0.8); outline-offset: 1px;
        }
        .sel-tile > svg { display: block; margin: 0 auto; }
        .sel-tile .bar {
          height: 3px; border-radius: 2px; overflow: hidden;
          background: rgba(255, 255, 255, 0.12);
        }
        .sel-tile .bar > span { display: block; height: 100%; background: #8fbb56; }
        .sel-tile .bar > span.hurt { background: #e0b74f; }
        .sel-tile .bar > span.dire { background: #d0714f; }
        /* The overflow cell — the tail of a big army, counted. A span,
           not a button: there is no one man behind it to pick.
           Carries the id for the same reason the rule above does, and it
           is the rule above it is fighting: a bare .sel-tile.more is two
           classes, which loses to one id and one class however many
           classes it stacks up, and the cell came out wearing a filled
           tile's back and border instead of its own dashed outline. */
        #ui .sel-tile.more {
          align-items: center; justify-content: center;
          font-size: 12px; color: #9b988d; background: none; border-style: dashed;
        }

        .sel-row { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
        /* Pinned right, where it stood back when a count line shared this
           row and pushed it there. */
        #ui .sel-row button.sel-close { margin-left: auto; }
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
        {b => {
          const def = () => BUILDING_DEFS[b().type];
          /** The gather recipe, if this building works the land at all —
              a type-level fact, so the reach line it drives is either
              on this card for as long as the building is selected or
              never on it. */
          const gather = () => gatherRecipeOf(def());
          /** Raised by the seat this client plays. What names the card
              when it is not — and, outside a replay, the only seat the
              pointer can reach at all. */
          const yours = () => b().owner === myPlayerId();
          /**
           * Raised by the seat the HUD is showing through: yours in a
           * match, whichever seat the pointer last picked in a replay
           * (viewerId in the store). The rows that read the stores and
           * the techs — a Train button's lock, Hire's price against the
           * silver, the forge's recipes — are drawn for THIS seat,
           * because the stock() and techs() they are read against are
           * this seat's. Drawn for the Warlord's barracks, they are the
           * whole reason to open it: his queue, and what his village
           * could and could not afford to put in it.
           *
           * Drawn, in a replay, and no more: a recording takes no orders,
           * so every such row carries `inert={replayMode()}` — nothing in
           * it takes a click or a focus — and the card's last line says
           * so. selectionOrders.lint.test.ts checks that every order on
           * this card sits under one of those rows.
           */
          const viewed = () => b().owner === viewerId();
          /**
           * Does this building offer a row of standing orders at all?
           * A type-level question on purpose: the answer has to hold
           * for as long as the thing stays selected, because the row
           * appearing halfway through would be exactly the jump this
           * card is meant to have stopped. That is why there is no
           * state gate here — a site becomes built mid-selection, and
           * gating on it made the row pop in at topping-out. Worse, it
           * left a misplaced site uncancellable: the sim sells and
           * pauses sites (a sale refunds half of what was delivered —
           * the Sell tooltip has said so all along), but the buttons
           * never appeared until the building finished. Which of the
           * buttons are live right now is each button's own affair.
           */
          const hasOrders = () =>
            viewed() && !def().isRoad && !def().systemOnly;
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
          /** The tower's halt lever, which is the manning of it. Undefined
              for every other building (and for a tower still on the
              scaffold), where the lever is the ordinary halt. */
          const levy = () => levyOrder(b());
          /** The lever's face: a standing tower's speaks of its roof, every
              other building's is the workshop halt it has always been. */
          const pauseLabel = () =>
            levy()?.label ?? (b().paused ? 'Resume' : 'Pause');
          return (
            <div class="hud-selection panel">
              <div class="sel-head">
                <span class="name">{buildingName(b().type)}</span>
                {/* Whose it is — printed only when it is not yours, which
                    outside a replay is never: the pointer reaches nobody
                    else's buildings in a live match, and a card that
                    announced "yours" on every hut would be saying the one
                    thing the player already knows. Watching a recording it
                    is the first thing they need, because a mill is a mill
                    whoever raised it. */}
                <Show when={!yours()}>
                  <span class="note">{seatName(b().owner, playersMeta())}</span>
                </Show>
                {/* The same feedback loop the unit card's badge is, for the
                    half of the number row that opens a card: Ctrl+4 on the
                    barracks changes nothing a player can see, so without
                    this the stamp is a keypress into the void. Tested
                    against null rather than truthiness — group 0 is a real
                    group and a falsy number. */}
                <Show when={selectionGroup() !== null}>
                  <span class="note">group {selectionGroup()}</span>
                </Show>
                <span class="bar">
                  <span
                    style={{
                      width: `${Math.round((b().hp / Math.max(b().maxHp, 1)) * 100)}%`,
                    }}
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
                <div class="sel-row" inert={replayMode()}>
                  {/* Repairs get a slot of their own rather than a line
                      in the block below, because the castle — which may
                      be neither paused nor sold — is exactly the
                      building you most want mended. */}
                  <TipWrap
                    tip={() => (
                      <TextTip
                        title={
                          b().repairNeeds
                            ? 'Call off the repair'
                            : 'Repair building'
                        }
                        body={
                          b().state !== BuildingState.built
                            ? 'A site heals as it rises — the builders are already putting every delivery on the walls, so there is nothing separate to mend.'
                            : b().repairNeeds
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
                      disabled={
                        b().state !== BuildingState.built ||
                        (!b().repairNeeds && unpaid() <= 0)
                      }
                      onClick={() =>
                        props.onRepair(b().id, b().repairNeeds === undefined)
                      }
                    >
                      {b().repairNeeds ? 'Cancel repair' : 'Repair'}
                      {/* No bill on an undamaged building — nor on one whose
                          damage is bought and only waiting on the masons:
                          repairBill of nothing is nothing, and "Repair none"
                          is worse than saying only "Repair". */}
                      <Show
                        when={
                          b().state === BuildingState.built &&
                          !b().repairNeeds &&
                          unpaid() > 0
                        }
                      >
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
                          title={pauseLabel()}
                          body={
                            b().state !== BuildingState.built
                              ? b().paused
                                ? 'Resumes the build: materials flow again and a builder is called back to the frame.'
                                : 'Halts the site where it stands — no new deliveries are called for (a load already on the road still lands), no progress — and the builder rejoins the serf pool. Nothing already delivered is lost.'
                              : levy()
                                ? b().paused
                                  ? 'Mans the tower: an archer with nothing else to do walks in from the field and climbs up. Whenever none is free — none trained yet, or every one of them marching — villagers answer the levy instead and hold it with stones until an archer turns up to relieve them. Nobody up there can be shot at while the tower stands.'
                                  : 'Empties the roof: the villagers go back to work and the archers walk back out of the door as soldiers, free to march with the army. Nobody is called up again until the tower is manned.'
                                : b().paused
                                  ? 'Puts the place back to work: it calls for a worker again, and production, deliveries and construction pick up where they left off.'
                                  : 'Halts the workshop without breaking it up — no production, no incoming deliveries, no construction progress — and sends the worker home a serf, free to haul or build. Finished stock still ships out.'
                          }
                        />
                      )}
                    >
                      <button
                        onClick={() => props.onTogglePause(b().id, !b().paused)}
                      >
                        {pauseLabel()}
                      </button>
                    </TipWrap>
                    <TipWrap
                      tip={() => (
                        <TextTip
                          title="Sell building"
                          body="Tears it down for salvage: half its build cost, floored per good — a half-built site yields half of what was delivered. The worker walks out a serf, and the salvage is left piled on the ground with everything the building held, for your serfs to cart home."
                        />
                      )}
                    >
                      <button onClick={() => props.onSell(b().id)}>Sell</button>
                    </TipWrap>
                  </Show>
                </div>
              </Show>

              {/* viewed(), like every other row that gives an order: a
                  replay can open a rival's Smith, and the row is drawn
                  for it — his order book, his recipes locked against his
                  techs — but drawn inert, so a live ✕ over the Warlord's
                  forge queue never offers a thing that was never on the
                  table. Only the repair/pause/sell row used to need
                  saying so, because only your own buildings could be
                  selected at all. */}
              <Show
                when={
                  viewed() &&
                  def().recipeOptions &&
                  b().state === BuildingState.built
                }
              >
                {/* The forge menu: one declared grid, three to a row —
                    nine recipes today and the frame would hold a tenth.
                    A click ORDERS one batch (the barracks' verb), it does
                    not retune the smith: the queue is worked first, and
                    an empty queue falls back to auto — forge whatever
                    tool the village most lacks, or nothing. */}
                <div class="sel-forge" inert={replayMode()}>
                  <span class="sel-label">forge</span>
                  <For each={def().recipeOptions!}>
                    {(opt, i) => {
                      const output = () => goodKeys(opt.recipe.outputs)[0]!;
                      const locked = () =>
                        opt.requiresTech !== undefined &&
                        !techs().researched.includes(opt.requiresTech);
                      const queueFull = () =>
                        (b().forgeQueue?.length ?? 0) >= FORGE_QUEUE_CAP;
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
                <div class="sel-queue sel-forge-queue" inert={replayMode()}>
                  <span class="sel-label">
                    queue <span class="num">{b().forgeQueue?.length ?? 0}</span>
                    /{FORGE_QUEUE_CAP}
                  </span>
                  <Index each={forgeSlots(b().forgeQueue)}>
                    {(slot, i) => (
                      <Show
                        when={slot()}
                        fallback={
                          <span class="sel-slot empty" aria-hidden="true" />
                        }
                      >
                        {item => {
                          const output = () =>
                            goodKeys(
                              def().recipeOptions![item().recipeIndex]!.recipe
                                .outputs,
                            )[0]!;
                          return (
                            <TipWrap
                              tip={() => (
                                <TextTip
                                  title={
                                    item().started
                                      ? 'Strike the order'
                                      : 'Remove from queue'
                                  }
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
                                classList={{waiting: !item().started}}
                                onClick={() =>
                                  props.onCancelForge(
                                    b().id,
                                    i,
                                    item().recipeIndex,
                                  )
                                }
                              >
                                <span class="unit">
                                  <GoodIcon good={output()} size={13} />{' '}
                                  <span class="label">
                                    {goodName(output())}
                                  </span>
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
                <div class="sel-line sel-forge-idle" inert={replayMode()}>
                  <Show
                    when={b().recipeIndex !== undefined}
                    fallback={
                      <span>
                        between orders: forges the scarcest tool, or rests
                      </span>
                    }
                  >
                    <span>
                      between orders: forges{' '}
                      {goodName(
                        goodKeys(
                          def().recipeOptions![b().recipeIndex!]!.recipe
                            .outputs,
                        )[0]!,
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

              {/* The castle's recruiting, built like the barracks': an
                  order button, and under it the queue as a declared grid
                  of slots. It used to be the button alone, wearing the
                  leader's walk as a fill and the depth as a "×3" — which
                  said how many were coming and gave the player no way to
                  say "not that many after all". A recruit is four silver
                  paid up front, and a hire ordered into a raid (or a
                  fourth one ordered by a slipped finger) was money the
                  village could not get back. Now every man in the line
                  has a slot with a ✕ on it, exactly as a drilling
                  spearman does. */}
              <Show
                when={
                  viewed() &&
                  b().type === BuildingTypeId.storehouse &&
                  b().state === BuildingState.built
                }
              >
                <div class="sel-row" inert={replayMode()}>
                  <TipWrap
                    tip={() => (
                      <TextTip
                        title="Hire Serf"
                        body={
                          noRoom(b().hireQueue ?? 0)
                            ? 'Every bed in the village is taken — counting the recruits already walking in, who each need one on arrival. Build a house; each sleeps ten.'
                            : `Word goes out to the next village; the recruit walks in after about ${Math.round(
                                HIRE_SERF_TICKS / TICKS_PER_SECOND,
                              )} seconds. Costs ${HIRE_SERF_COST} silver, paid when you order — and refunded in full if you call him back off the road.`
                        }
                      />
                    )}
                  >
                    <button
                      disabled={!canHire(b(), stock(), population())}
                      onClick={() => props.onHire()}
                    >
                      <Key label="Hire Serf" k={HIRE_KEY} />
                      <span class="cost">
                        <GoodIcon good={GoodId.silver} size={12} />
                        {HIRE_SERF_COST}
                      </span>
                    </button>
                  </TipWrap>
                </div>
                {/* HIRE_QUEUE_CAP slots, the training queue's grid and the
                    training queue's rules — the count and then one cell per
                    slot, drawn at full depth from the moment the castle is
                    selected, so a recruit landing changes what a slot says
                    and never how many there are. */}
                <div class="sel-queue" inert={replayMode()}>
                  <span class="sel-label">
                    queue <span class="num">{b().hireQueue ?? 0}</span>/
                    {HIRE_QUEUE_CAP}
                  </span>
                  {/* Index over positions rather than over men: the queue is
                      a count, and every recruit in it is the same recruit —
                      only the slot's place in the line tells them apart. */}
                  <Index each={hireSlots(b().hireQueue)}>
                    {(slot, i) => (
                      <Show
                        when={slot()}
                        fallback={
                          <span class="sel-slot empty" aria-hidden="true" />
                        }
                      >
                        <TipWrap
                          tip={() => (
                            <TextTip
                              title={
                                i === 0
                                  ? 'Call the recruit back'
                                  : 'Cancel the order'
                              }
                              body={
                                i === 0
                                  ? `He turns around wherever he is on the road and the ${HIRE_SERF_COST} silver comes back to the castle. Only the walk is lost — the next in line sets out fresh.`
                                  : `Word never goes out for this one, and the ${HIRE_SERF_COST} silver comes back to the castle. The man already walking is not disturbed.`
                              }
                            />
                          )}
                        >
                          <button
                            class="sel-progress sel-slot"
                            classList={{waiting: i > 0}}
                            onClick={() => props.onCancelHire(i)}
                          >
                            {/* The leader's walk, filling his chip left to
                                right — the same clock the button used to
                                wear, now on the man it belongs to. Nobody
                                behind him has set out, so nobody behind him
                                has a fill. */}
                            <span
                              aria-hidden="true"
                              class="sel-fill"
                              style={{
                                width: `${(i === 0 ? (b().hireProgress01 ?? 0) : 0) * 100}%`,
                              }}
                            />
                            <span class="unit">
                              {unitName(UnitTypeId.serf)}
                            </span>
                            <span class="x">✕</span>
                          </button>
                        </TipWrap>
                      </Show>
                    )}
                  </Index>
                </div>
              </Show>

              <Show
                when={
                  b().type === BuildingTypeId.abbey &&
                  b().state === BuildingState.built
                }
              >
                <div class="sel-row">
                  <button onClick={() => setTechPanelOpen(true)}>
                    <Key label="Research…" k={RESEARCH_KEY} />
                  </button>
                  <Show when={techs().active}>
                    {a => (
                      <span style={{opacity: 0.85}}>
                        {techName(a().tech)}{' '}
                        <span class="num">
                          {Math.round(
                            (1 - a().ticksLeft / a().totalTicks) * 100,
                          )}
                        </span>
                        %
                      </span>
                    )}
                  </Show>
                </div>
              </Show>

              <Show
                when={
                  viewed() && def().trains && b().state === BuildingState.built
                }
              >
                {/* Wraps: three priced train buttons outgrow the card's
                    width cap on a narrow screen, and are better stacked
                    than sliced. Safe to wrap where the queue below is
                    not: what these buttons say is settled by the
                    building's type, so the row is whatever height it is
                    from the moment the barracks is selected. */}
                <div class="sel-row" inert={replayMode()}>
                  <For each={def().trains!}>
                    {option => {
                      const gate = unitTechGate(option.unit);
                      const locked = () =>
                        gate !== undefined &&
                        !techs().researched.includes(gate);
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
                            disabled={
                              !canTrain(b(), option.unit, techs().researched)
                            }
                            onClick={() => props.onTrain(b().id, option.unit)}
                          >
                            <Show when={locked()}>
                              <LockIcon />{' '}
                            </Show>
                            <Key
                              label={unitName(option.unit)}
                              k={trainKey(option.unit)}
                            />
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
                <div class="sel-row" inert={replayMode()}>
                  <TipWrap
                    tip={() => (
                      <TextTip
                        title="Rally point"
                        body="Then click a spot: every soldier that finishes training marches there instead of standing at the door. Click the barracks itself to take the flag down."
                      />
                    )}
                  >
                    <button
                      classList={{active: orderMode() === OrderMode.rally}}
                      onClick={() =>
                        props.onArmOrder(
                          orderMode() === OrderMode.rally
                            ? null
                            : OrderMode.rally,
                        )
                      }
                    >
                      <Key label="Rally" k={RALLY_KEY} />
                    </button>
                  </TipWrap>
                  <Show
                    when={orderMode() === OrderMode.rally}
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
                    <span class="sel-label">
                      click where they should muster
                    </span>
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
                <div class="sel-queue" inert={replayMode()}>
                  <span class="sel-label">
                    queue <span class="num">{b().trainQueue?.length ?? 0}</span>
                    /{TRAIN_QUEUE_CAP}
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
                        fallback={
                          <span class="sel-slot empty" aria-hidden="true" />
                        }
                      >
                        {item => (
                          <TipWrap
                            tip={() => (
                              <TextTip
                                title={
                                  item().started
                                    ? 'Cancel training'
                                    : 'Remove from queue'
                                }
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
                              classList={{waiting: !item().started}}
                              onClick={() =>
                                props.onCancelTrain(
                                  b().id,
                                  i,
                                  item().unit as UnitTypeId,
                                )
                              }
                            >
                              {/* The training clock, filling the chip left to right. */}
                              <span
                                aria-hidden="true"
                                class="sel-fill"
                                style={{
                                  width: `${(item().progress01 ?? 0) * 100}%`,
                                }}
                              />
                              {/* The name gives way before the ✕ does: on a
                                  narrow card the slot is thinner than
                                  "Spearman ✕", and a clipped word still
                                  reads while a clipped ✕ looks broken. */}
                              <span class="unit">
                                {unitName(item().unit as UnitTypeId)}
                              </span>
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
                    two is up there, and a stood-down one says plainly that
                    it is empty, because a tower nobody has manned defends
                    nothing at all. */}
                <Show when={manned() && b().state === BuildingState.built}>
                  <span
                    classList={{good: garrison() > 0, bad: garrison() === 0}}
                  >
                    {garrison() === 0
                      ? b().paused
                        ? 'stood down — nobody on the roof until you man it'
                        : 'unmanned — waiting for someone to climb up'
                      : `${garrison()}/${b().garrisonCap} ${levied() ? 'villagers' : 'archers'} on the roof`}
                  </span>
                </Show>
                <Show when={b().staffing}>
                  <span
                    classList={{
                      good: b().staffing === StaffingState.staffed,
                      bad: b().staffing !== StaffingState.staffed,
                    }}
                  >
                    {b().state === BuildingState.site
                      ? b().staffing === StaffingState.staffed
                        ? 'builder at work'
                        : b().staffing === StaffingState.recruiting
                          ? 'builder on the way'
                          : 'needs a builder!'
                      : b().staffing === StaffingState.staffed
                        ? 'worker at post'
                        : b().staffing === StaffingState.recruiting
                          ? 'worker on the way'
                          : 'needs a worker!'}
                  </span>
                </Show>
                {/* Not on a standing tower: there the halt is the manning
                    order, and the line above has already said whether the
                    roof is manned and by whom — a halted tower is an empty
                    one, which is what that line says. */}
                <Show when={b().paused && levy() === undefined}>
                  <span class="note"> · paused</span>
                </Show>
                <Show when={b().repairNeeds}>
                  {needs => (
                    <span class="good">
                      {' '}
                      · repairing, wants <GoodsLine amounts={needs()} />
                    </span>
                  )}
                </Show>
                {/* The bill is settled and the walls are still going up. */}
                <Show
                  when={!b().repairNeeds && b().repairPending !== undefined}
                >
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
                {g => (
                  <div class="sel-line">
                    <TipWrap
                      tip={() => (
                        <TextTip
                          title={`${goodName(g().output)} in reach`}
                          body={reachTip(
                            b().type,
                            g().resource,
                            b().resourceLeft ?? 0,
                          )}
                        />
                      )}
                    >
                      <span class="sel-reach">
                        <span class="sel-label">in reach</span>{' '}
                        <GoodIcon good={g().output} size={12} />
                        <span
                          class="num"
                          classList={{spent: (b().resourceLeft ?? 0) <= 0}}
                        >
                          {b().resourceLeft ?? 0}
                        </span>
                        <Show when={(b().resourceLeft ?? 0) <= 0}>
                          <span class="sel-label spent"> · worked out</span>
                        </Show>
                      </span>
                    </TipWrap>
                    {/* The other way a hut makes nothing: a booked pickup
                        no free hand has come for. Worked-out says the
                        ground failed the hut; this says the village did.
                        Deliberately not gated on the shelf being AT its
                        cap — a starved hut oscillates one load under it
                        every time a hauler finally snatches one, and an
                        alarm that blinked off on that beat would read as
                        five different problems instead of one. The wait
                        is measured here against the frame clock, because
                        the roster ships a stable tick on purpose (see
                        BuildingSnap.outWaitingSince). */}
                    <Show
                      when={
                        b().state === BuildingState.built &&
                        b().outWaitingSince !== undefined &&
                        simTick() - b().outWaitingSince! >= HAUL_STARVED_AFTER
                      }
                    >
                      <TipWrap
                        tip={() => (
                          <TextTip
                            title="Nobody is hauling"
                            body={HAUL_STARVED_TIP}
                          />
                        )}
                      >
                        <span class="sel-starved">
                          {' '}
                          · no hauler for{' '}
                          <span class="num">
                            {Math.floor(
                              (simTick() - b().outWaitingSince!) /
                                TICKS_PER_SECOND,
                            )}
                          </span>
                          s
                        </span>
                      </TipWrap>
                    </Show>
                  </div>
                )}
              </Show>

              <div class="sel-line">
                <Show when={b().state === BuildingState.site}>
                  <span>
                    needs <GoodsLine amounts={b().siteNeeds ?? {}} />
                  </span>
                </Show>
                <Show when={b().state === BuildingState.built}>
                  <span>
                    stock <GoodsLine amounts={b().stock} />{' '}
                    <span style={{'margin-left': '8px'}}>
                      in <GoodsLine amounts={b().inputs} />
                    </span>
                  </span>
                </Show>
              </div>
              {/* The people card's last line, for the same reason: the
                  order rows above are drawn in a replay — the queue and
                  the locks are what a recording is opened to read — and
                  a row of buttons that takes no click needs the one line
                  that says why. Only under rows there are; a bandit camp
                  has none, and a line about orders over a card with none
                  would be answering a question nobody asked. */}
              <Show when={replayMode() && viewed()}>
                <div class="sel-line" style={{opacity: 0.6}}>
                  a recording takes no orders — watching only
                </div>
              </Show>
            </div>
          );
        }}
      </Show>

      <Show when={!selectedBuilding() && selection().size > 0}>
        {/* ——— The people card ———
            It used to say "4 units selected" and nothing else, which is
            the same sentence for four serfs about to be caught in a raid
            and for four knights who can answer it — and which of those it
            is was the whole decision the player was making. So: who they
            are, and how much is left of them.
            One picked up gets a card like a building's, name and health
            across the head. Several get the head as a count — named as
            their kind when they are all of one — and a tile per head with
            its own health under it: the wounded one in a squad is what the
            player is looking for, and an average would hide exactly
            that. */}
        <div class="hud-selection panel">
          <div class="sel-head">
            {/* Both spellings of the head keep the same shape — icon,
                name, group badge, then health pinned right — so picking
                up a second knight does not move the buttons under it. */}
            {/* The head names them, and the tip behind it is the same
                card the drill ground shows before you pay for one: what
                the kind is worth, and what it loses to. A mixed band has
                no one kind to describe, so its tip says where to read the
                mixture instead. */}
            <TipWrap
              tip={() =>
                headKind() ? (
                  <UnitTip unit={headKind()!} />
                ) : (
                  /* No one kind to describe. Usually that is a mixed
                     band and says so — but the roster can also be a
                     step behind the ids for a frame (see headCount),
                     and a lone knight whose tile has not arrived yet is
                     not a mixture of anything. The count is what tells
                     them apart. */
                  <TextTip
                    title={roster().length > 0 ? 'A mixed band' : 'In hand'}
                    body="Every tile below is one of them: what they are, and how much of them is left."
                  />
                )
              }
            >
              <span class="sel-who">
                <Show when={headKind()}>
                  <UnitIcon unit={headKind()!} size={17} decorative />
                </Show>
                <Show
                  when={lone()}
                  fallback={
                    <span class="name">
                      <span class="num">{headCount()}</span>{' '}
                      {/* A squad of one kind is named as what it is: six
                          knights read as "6 Knights", not as six of
                          something. A mixed band has no such word and
                          falls back to the count — the tiles under this
                          are what answer it there, one glyph a man. */}
                      {soleKind()
                        ? unitNamePlural(soleKind()!, headCount())
                        : headCount() === 1
                          ? 'unit'
                          : 'units'}{' '}
                      selected
                    </span>
                  }
                >
                  <span class="name">{unitName(lone()!.kind)}</span>
                </Show>
              </span>
            </TipWrap>
            {/* Whose, on the same rule the building card's name follows.
                Absent for a set that is not one seat's — a shift-click
                across a battle can build one, and no single name would
                cover it (see Controls' #soleOwner). Reads as a note beside
                the name rather than inside it: the name says what they
                are, and this says whose they are, which is a question a
                replay asks and a match rarely does. */}
            <Show
              when={
                selectionOwner() !== null && selectionOwner() !== myPlayerId()
              }
            >
              <span class="note">
                {seatName(selectionOwner()!, playersMeta())}
              </span>
            </Show>
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
              <span class="note">group {selectionGroup()}</span>
            </Show>
            {/* One in hand gets the building card's own head: a bar and
                the numbers behind it. A squad's health is on the tiles,
                where it can say which of them is the hurt one — so the
                head keeps the space empty rather than averaging them. */}
            <Show when={lone()}>
              <span class="bar">
                <span
                  class={hpTone(hpFraction(lone()!))}
                  style={{width: `${Math.round(hpFraction(lone()!) * 100)}%`}}
                />
              </span>
              <span class="hp">
                <span class="num">{lone()!.hp}</span>/
                <span class="num max">{lone()!.maxHp}</span>
              </span>
            </Show>
          </div>

          {/* A tile per head: what it is, what is left of it. Indexed
              rather than keyed, because the roster is a fresh array
              whenever anything the card draws moves, and Index updates a
              cell in place instead of tearing down two dozen of them for
              one man's arrow.
              The order is not fixed for all time — a death closes the gap
              it leaves, and past the tile cap a man moves up the first
              time he is wounded (rosterOf) — but it only moves on events
              like those, never from one publish to the next. So between
              them a tile stays the tile it was, and the bar under it is
              the only thing that travels. */}
          <Show when={roster().length > 1}>
            {/* The instruction lives on the group, said once when a
                reader steps into it, rather than on all two dozen faces.
                A tile's accessible name is the man and his health,
                because that is what changes tile to tile and what a
                reader is walking the grid to compare; hanging "click to
                take him on his own, shift-click to leave him behind" off
                each name would read that sentence twenty-four times to
                someone tabbing through and bury the one number that
                differs. The pointer gets the same words from the
                tooltip, which is exactly the audience the tooltip
                cannot reach. */}
            <div
              class="sel-roster"
              role="group"
              aria-label="The band in hand. Click a face to take that man on his own; shift-click to leave him behind."
            >
              <Index each={shown()}>
                {unit => (
                  <TipWrap
                    tip={() => (
                      <TextTip
                        title={`${unitName(unit().kind)} · ${unit().hp} of ${unit().maxHp} hitpoints`}
                        body="Click to take him on his own; shift-click to leave him behind. The same two a click on the man himself gives."
                      />
                    )}
                  >
                    {/* A button, because it is one: the tile is the man,
                        and clicking a man is how this game has always
                        picked him up. The whole of it is the target
                        rather than the glyph, so a thumb has the cell.

                        It also has to name itself out loud — a picture
                        and a bar name nobody — so the label is the man
                        and his health, and the glyph inside stays hidden
                        rather than being read out as a second name after
                        it. What the click does is said once on the group
                        above, not again on every face. */}
                    <button
                      class="sel-tile"
                      aria-label={`${unitName(unit().kind)}, ${unit().hp} of ${unit().maxHp} hitpoints`}
                      onClick={e => props.onPickUnit(unit().id, e.shiftKey)}
                    >
                      <UnitIcon unit={unit().kind} size={16} decorative />
                      <span class="bar">
                        <span
                          class={hpTone(hpFraction(unit()))}
                          style={{
                            width: `${Math.round(hpFraction(unit()) * 100)}%`,
                          }}
                        />
                      </span>
                    </button>
                  </TipWrap>
                )}
              </Index>
              {/* An army past the card's three rows, counted rather than
                  drawn: the card may not grow without limit down a phone
                  screen, and past two dozen faces the tiles are a texture
                  anyway — what the player is reading by then is whether
                  any bar in it has gone red. Which is why the cut is not
                  arbitrary, and why the cell says so when asked: a wound
                  moves a man onto the card, so the ones left out of it
                  are the ones nothing has happened to. */}
              <Show when={roster().length > shown().length}>
                <TipWrap
                  tip={() => (
                    <TextTip
                      title={`${roster().length - shown().length} more`}
                      body="Only so many tiles fit. Anyone who has taken a wound is drawn ahead of those who have not, so these are the ones still whole."
                    />
                  )}
                >
                  <span class="sel-tile more">
                    +{roster().length - shown().length}
                  </span>
                </TipWrap>
              </Show>
            </div>
          </Show>

          <div class="sel-row">
            {/* The A/M shortcuts' home on screen — and, tapped, the touch way
                to the two orders a finger otherwise cannot ask for: the plain
                walk that ignores what it passes, and the full attack-move.
                A single tap on the map still sends the half order between
                them. Clicking an armed button again calls the order off.

                Gone entirely in a replay rather than greyed: the squad in
                the rings may not even be the watching seat's, and a
                disabled Attack button beside the Warlord's knights offers
                a thing that was never on the table. The ✕ stays — letting
                go is an order to nobody. */}
            <Show when={!replayMode()}>
              <TipWrap
                tip={() => (
                  <TextTip
                    title="Attack-move"
                    body="Then click a spot: they advance on it and engage anything they meet on the way."
                  />
                )}
              >
                <button
                  classList={{active: orderMode() === OrderMode.attack}}
                  onClick={() =>
                    props.onArmOrder(
                      orderMode() === OrderMode.attack
                        ? null
                        : OrderMode.attack,
                    )
                  }
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
                  classList={{active: orderMode() === OrderMode.move}}
                  onClick={() =>
                    props.onArmOrder(
                      orderMode() === OrderMode.move ? null : OrderMode.move,
                    )
                  }
                >
                  <Key label="Move" k="M" />
                </button>
              </TipWrap>
              {/* Patrol: a mode like Attack and Move, and soldiers only
                  like Hold — a serf handed a patrol takes the plain walk,
                  so a band of them is offered nothing rather than a
                  button that promises a beat nobody walks. */}
              <Show when={fighters().length > 0}>
                <TipWrap
                  tip={() => (
                    <TextTip
                      title="Patrol"
                      body="Then click a spot: they walk there and back, and there again, fighting whatever they meet on the way, until you give another order. Shift-click adds a spot to the beat."
                    />
                  )}
                >
                  <button
                    classList={{active: orderMode() === OrderMode.patrol}}
                    onClick={() =>
                      props.onArmOrder(
                        orderMode() === OrderMode.patrol
                          ? null
                          : OrderMode.patrol,
                      )
                    }
                  >
                    <Key label="Patrol" k="P" />
                  </button>
                </TipWrap>
              </Show>
              {/* Hold ground. Not a mode like its two neighbours — there
                  is no spot to click, so the press IS the order — and
                  lit not because it is armed but because the sim says the
                  squad is holding (the roster reads the stance off each
                  publish). Soldiers only: a serf takes no such order, and
                  a band of them is offered nothing rather than a button
                  that would confirm an order the sim throws away. */}
              <Show when={fighters().length > 0}>
                <TipWrap
                  tip={() => (
                    <TextTip
                      title="Hold ground"
                      body="They stop where they stand and fight only what comes within reach — no chasing, no giving ground. Any other order releases them."
                    />
                  )}
                >
                  <button
                    classList={{active: fighters().every(u => u.holding)}}
                    onClick={() => props.onHold()}
                  >
                    <Key label="Hold" k="H" />
                  </button>
                </TipWrap>
              </Show>
            </Show>
            {/* Let them go — pinned to the far end of the row, which is
                where it stood when a count line was holding this row open.
                In a replay it is the only thing left in the row (the
                orders above are gone, not greyed) and it keeps that end
                rather than sliding to the near one. */}
            <button class="sel-close" onClick={() => props.onDeselect()}>
              ✕
            </button>
          </div>
          {/* An armed order outranks the standing advice: what the next
              click does has just changed, and "right-click to send them"
              beside a lit Attack button is the card contradicting itself.
              This line is the only thing that says so — the cursor
              deliberately does not change. Its own reserved line, below
              the buttons, so swapping one sentence for another cannot
              shuffle them. */}
          <div class="sel-line" style={{opacity: 0.6}}>
            {replayMode()
              ? 'a recording takes no orders — watching only'
              : orderMode() === OrderMode.attack
                ? 'click where to attack-move'
                : orderMode() === OrderMode.move
                  ? 'click where to walk'
                  : orderMode() === OrderMode.patrol
                    ? 'click the far end of the beat'
                    : fighters().length > 0 && fighters().every(u => u.holding)
                      ? 'holding ground — any order releases them'
                      : matchMedia('(pointer: coarse)').matches
                        ? 'tap the ground to send them'
                        : 'right-click to send them'}
          </div>
        </div>
      </Show>
    </>
  );
}
