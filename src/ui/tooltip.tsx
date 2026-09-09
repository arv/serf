import {
  For,
  Show,
  createEffect,
  createRoot,
  createSignal,
  getOwner,
  onCleanup,
  type JSX,
  type Owner,
  type ParentProps,
} from 'solid-js';
import type {Enum} from '../shared/enum.ts';

// The tooltip layer's shared signal has the same HMR fragility as store.ts:
// a hot swap splits it and tooltips freeze. Escalate to a full reload.
if (import.meta.hot) {
  import.meta.hot.accept(() => import.meta.hot?.invalidate());
}
import {TICKS_PER_SECOND} from '../sim/defs/balance';
import {
  BUILDING_DEFS,
  gatherRecipeOf,
  rationOf,
  type Recipe,
} from '../sim/defs/buildings';
import * as BuildingTypeId from '../sim/defs/buildingTypeIdEnum.ts';
import * as GoodId from '../sim/defs/goodIdEnum.ts';
import {type GoodAmounts, goodEntries} from '../sim/defs/goods';
import * as RecipeKind from '../sim/defs/recipeKindEnum.ts';
import * as TechEffectKind from '../sim/defs/techEffectKindEnum.ts';
import {TECH_DEFS, type TechId} from '../sim/defs/techs';
import * as UnitClass from '../sim/defs/unitClassEnum.ts';
import {COUNTER_TABLE, UNIT_DEFS} from '../sim/defs/units';
import * as UnitTypeId from '../sim/defs/unitTypeIdEnum.ts';
import {GoodIcon} from './icons';
import {
  buildingName,
  goodName,
  RESOURCE_NAMES,
  techDesc,
  techName,
  unitName,
} from './names';
import {stock, techs} from './store';
import {type ActiveStudy, hauledByGood} from './techProgress.ts';

type BuildingTypeId = Enum<typeof BuildingTypeId>;
type GoodId = Enum<typeof GoodId>;
type UnitClass = Enum<typeof UnitClass>;
type UnitTypeId = Enum<typeof UnitTypeId>;

/**
 * One floating tooltip layer for the whole HUD. Spread `{...tooltip(...)}`
 * onto any element; content renders in a themed panel next to the element,
 * after a short hover delay. Replaces every native `title` attribute.
 *
 * The panel is a popover placed by CSS anchor positioning, which is what the
 * hand-rolled version was a worse copy of. That one measured the trigger once,
 * on hover, and wrote the answer down as fixed coordinates: anything that
 * moved afterwards — a resource number widening, a queue re-flowing, a window
 * resize, a panel scrolling under the cursor — left the tip pointing at where
 * the trigger used to be. Its idea of the viewport edge was a guessed
 * half-width rather than the panel's own, so a tip near a corner slid off its
 * trigger to make room it did not need, and below about 300px of window the
 * two clamps crossed and threw it across the screen. And it rode on a z-index,
 * which is only ever the highest number until the next one: the layer scale in
 * Hud.tsx has to keep making room for it, and a modal <dialog> — the top
 * layer — outranks every number in that scale anyway.
 *
 * Now the browser owns both jobs. The `popover` attribute puts the panel in
 * the top layer, over every panel and dialog with nothing to clip it and no
 * number to maintain. `anchor-name` and `anchor()` keep it glued to the live
 * position of the trigger, `justify-self: anchor-center` centres it on the
 * trigger while keeping it inside the window, `position-try-fallbacks` drops
 * it below a trigger with nothing above it, and `position-visibility` takes
 * it away when the trigger scrolls out of a panel.
 * There is no hand-placed path behind any of it: a browser without CSS anchor
 * positioning is one this game does not target.
 */

/** The anchor name the live trigger wears; only one tip is up at a time. */
const ANCHOR = '--tip-anchor';

interface TipState {
  target: HTMLElement;
  content: () => JSX.Element;
  /**
   * The reactive owner the trigger was rendered under. The tip is drawn in
   * a scope beneath it rather than in the layer's, which is what ties a
   * tip's lifetime to the thing it describes — see renderTip.
   */
  owner: Owner | null;
}

const [tip, setTip] = createSignal<TipState | null>(null);
let showTimer: ReturnType<typeof setTimeout> | undefined;
/** Whose tip the timer above is counting down for, while it runs. */
let pendingContent: (() => JSX.Element) | null = null;
/** Throws away the reads behind the tip on screen — see renderTip. */
let disposeTip: (() => void) | null = null;

/** Take the tip down, and call off one that was still on its way up. */
function hideTip(): void {
  clearTimeout(showTimer);
  pendingContent = null;
  dropTip();
  setTip(null);
}

/** Drop the drawn tip's own scope, if one is standing. */
function dropTip(): void {
  const dispose = disposeTip;
  disposeTip = null;
  dispose?.();
}

/**
 * Draw a tip's content in a scope of its own, under the owner that raised
 * its trigger.
 *
 * The layer is one panel for the whole HUD, so without this a tip was drawn
 * as part of the LAYER — and a tip's content is a closure written where the
 * trigger stands, over whatever that place has in scope. When the two
 * lifetimes came apart, the closure was still there to be run after the
 * thing it described had gone.
 *
 * That is not a rare corner. The building card is a `<Show>` over the
 * selected building, and its buttons' tips read that block's accessor. Sell
 * the building (or lose it, or press Escape) with the pointer resting on one
 * of them and the card's `<Show>` closes while the tip is still up: the
 * layer's copy of the closure re-ran on that same update, read an accessor
 * whose block was gone, and Solid threw its stale-read error out of the
 * setter — out of the structural frame handler, in the case that reported
 * this. Solid drops the rest of the update on the way out and leaves the
 * computations still queued behind the throw marked stale, and a stale
 * computation is never queued again: the card froze on screen for the rest
 * of the match, keeping its buttons and following nothing. The building was
 * gone from the sim; the window over it was not.
 *
 * So the tip gets a scope, dropped two ways. The trigger's own disposal
 * takes it (`tooltip` below hides a tip its trigger no longer stands
 * behind), which lands during the very tear-down that used to strand it —
 * before the update reaches the reads, so they never happen. And the layer
 * takes it when the tip moves on, which is what a root rather than plain
 * ownership buys: owned outright by a trigger that outlives twenty hovers,
 * every tip ever shown from it would still be subscribed and recomputing.
 */
function renderTip(t: TipState): JSX.Element {
  dropTip();
  // A trigger can go between the hover and the tip: the delay is a timer,
  // and 130ms is long enough for a building to be sold out from under the
  // card. Drawing the closure then is the same stale read by the other road
  // — on the tip's FIRST run rather than a later one — so a tip with
  // nothing left to point at is not drawn at all. The layer's effect takes
  // the empty panel down on the same update.
  if (!t.target.isConnected) return null;
  // The trigger's owner, so the tip reads the context its trigger reads.
  // Listener is null inside a root, so the layer subscribes to nothing the
  // tip touches — the tip's own reads are its own to answer for.
  return createRoot(dispose => {
    disposeTip = dispose;
    return t.content();
  }, t.owner ?? undefined);
}

export function tooltip(content: () => JSX.Element): {
  onPointerEnter: (e: PointerEvent) => void;
  onPointerLeave: () => void;
  onPointerDown: (e: PointerEvent) => void;
  onPointerMove: (e: PointerEvent) => void;
  onPointerUp: () => void;
  onPointerCancel: () => void;
} {
  // Captured while the trigger renders, which is the whole point: this is
  // the owner the tip is drawn under (renderTip), and the one whose disposal
  // takes the tip down below.
  const owner = getOwner();
  const show = (target: HTMLElement, delay: number): void => {
    clearTimeout(showTimer);
    pendingContent = content;
    showTimer = setTimeout(() => {
      pendingContent = null;
      setTip({target, content, owner});
    }, delay);
  };
  const hide = hideTip;
  // A trigger that goes takes its tip with it. The layer already drops a tip
  // whose target left the page, but only when the tip signal itself changes
  // — and nothing changes it when the card underneath is torn down. Guarded
  // by identity so a trigger unmounting elsewhere in the HUD cannot pull down
  // the tip some other trigger is showing.
  onCleanup(() => {
    if (tip()?.content === content || pendingContent === content) hideTip();
  });
  // Where a touch started, so a press that turns into a scroll gives the
  // gesture back to the list instead of popping a tip over it.
  let from: {x: number; y: number} | null = null;
  return {
    // Hover via pointerenter, not mouseenter: after every tap the browser
    // fires a compatibility mouseenter, and a touchscreen never sends the
    // matching mouseleave — the hover tip it opened stayed up forever.
    // pointerenter carries pointerType, so touch simply doesn't hover.
    onPointerEnter: (e: PointerEvent) => {
      if (e.pointerType === 'mouse') show(e.currentTarget as HTMLElement, 130);
    },
    onPointerLeave: hide,
    // Touch has no hover: press and hold reveals the tip instead, and it
    // clears on release. (Mouse presses are already covered by hover.)
    onPointerDown: (e: PointerEvent) => {
      if (e.pointerType === 'mouse') return;
      from = {x: e.clientX, y: e.clientY};
      show(e.currentTarget as HTMLElement, 260);
    },
    onPointerMove: (e: PointerEvent) => {
      if (!from) return;
      const dx = e.clientX - from.x;
      const dy = e.clientY - from.y;
      if (dx * dx + dy * dy > 100) {
        from = null;
        hide();
      }
    },
    onPointerUp: () => {
      from = null;
      hide();
    },
    onPointerCancel: () => {
      from = null;
      hide();
    },
  };
}

export function TooltipLayer() {
  let el: HTMLDivElement | undefined;
  // The element currently wearing the anchor name, so it can be undressed
  // when the tip moves on — two anchors of one name and the browser picks
  // the later one in the DOM, which is nobody's trigger in particular.
  let anchored: HTMLElement | null = null;

  const setAnchor = (target: HTMLElement | null): void => {
    if (anchored === target) return;
    anchored?.style.removeProperty('anchor-name');
    anchored = target;
    target?.style.setProperty('anchor-name', ANCHOR);
  };

  createEffect(() => {
    const t = tip();
    if (!el) return;
    // A trigger can vanish under the cursor — a build button whose menu
    // closes on the click — and a tip anchored to nothing has nothing to
    // point at, so it goes with it.
    if (t && !t.target.isConnected) {
      hideTip();
      return;
    }
    setAnchor(t?.target ?? null);
    // togglePopover() rather than the show/hide pair: it is a no-op when the
    // panel is already in the state asked for, and the panel does stay up
    // across a move to a neighbouring trigger — only its content swaps.
    el.togglePopover(t !== null);
  });

  // A click acts on the button, so the tip has said its piece — and a
  // pointerleave the browser never sends (the trigger was removed, the
  // window lost focus) is the other way a tip used to stick to the glass.
  // Capture, so it lands before the press that a touch tip opens on — that
  // one is still only a timer at this point, and clearing it is the point.
  window.addEventListener('pointerdown', hideTip, {capture: true});
  window.addEventListener('blur', hideTip);
  onCleanup(() => {
    window.removeEventListener('pointerdown', hideTip, {capture: true});
    window.removeEventListener('blur', hideTip);
    setAnchor(null);
    // The layer goes with the match; the scope behind the tip it was
    // showing is detached from it and would otherwise stay subscribed.
    dropTip();
  });

  return (
    <>
      <style>{`
        .tipwrap { display: inline-flex; }
        /* Above the trigger and centred on it, in a box that is the window
           less its edges (the notch included, where the phone has one).
           anchor-center is why that box is spelled out rather than left to a
           position-area: it centres the panel on the trigger but keeps it
           inside those insets, so a tip on a corner button slides along the
           edge instead of hanging off it — the case the old layer guessed a
           half-width for and got wrong. That leaves one fallback to declare,
           for a trigger with no room above it. Worth keeping the list that
           short on its own merits: Chromium tries only the first five
           options in it, so a ladder of near-misses is not a thing to lean
           on — an earlier draft hid its last-resort placement at number six
           and simply never reached it.
           Every rule here is #ui-scoped because #ui .panel dresses this same
           element: a bare .tip ties with it and loses on order. */
        #ui .tip {
          --tip-edge-start: max(8px, var(--safe-left));
          --tip-edge-end: max(8px, var(--safe-right));
          position: fixed;
          position-anchor: ${ANCHOR};
          inset: auto var(--tip-edge-end) calc(anchor(top) + 8px) var(--tip-edge-start);
          justify-self: anchor-center;
          position-try-fallbacks: --tip-below;
          /* A trigger scrolled out of its panel takes its tip with it. */
          position-visibility: anchors-visible;
          /* border-box so the width is the whole panel: it has to fit between
             the insets above, and it can only promise that if the padding and
             border are inside the number. 304px is the 280 of text this panel
             is drawn around plus that chrome, so a roomy window sees exactly
             what it always did. */
          box-sizing: border-box; margin: 0;
          width: max-content;
          max-width: min(304px, calc(100vw - var(--tip-edge-start) - var(--tip-edge-end)));
          padding: 8px 11px 9px;
          pointer-events: none; font-size: 12px; line-height: 1.45;
          transition: opacity 110ms ease;
        }
        @position-try --tip-below { top: calc(anchor(bottom) + 8px); bottom: auto; }
        /* The fade lives entirely in the entry: @starting-style is the value
           the panel transitions *from* as it comes off the UA sheet's
           display: none. The steady state is a plain opaque panel, so a tip
           on a frame that never arrives is a tip shown, not one left
           invisible waiting on an animation to finish. */
        @starting-style { #ui .tip:popover-open { opacity: 0; } }
        @media (prefers-reduced-motion: reduce) { #ui .tip { transition: none; } }
        .tip-title {
          font-family: Georgia, 'Times New Roman', serif; color: #e6c987;
          font-size: 13px; margin-bottom: 2px;
        }
        .tip-title .tag {
          font-family: system-ui, sans-serif; font-size: 10px; color: #b3a284;
          margin-left: 7px; letter-spacing: 0.04em; text-transform: uppercase;
        }
        .tip-desc { color: #d6c8ab; }
        .tip-line { color: #b3a284; margin-top: 3px; }
        .tip-line b { color: #d6c8ab; font-weight: 600; }
        .tip-warn { color: #d98a6a; margin-top: 3px; }
        .tip-good { color: #9fb06a; }
        .tip-bad { color: #c86a5a; }
        .tip-cost svg { vertical-align: -2px; margin: 0 1px 0 5px; }
      `}</style>
      {/* manual, not auto: nothing here is dismissible furniture, and an
          auto popover would light-dismiss on the very press that opens a
          touch tip. */}
      <div ref={el} popover="manual" class="panel tip" role="tooltip">
        <Show when={tip()}>{t => renderTip(t())}</Show>
      </div>
    </>
  );
}

/**
 * Tooltip carrier for buttons that can be disabled — disabled elements don't
 * fire mouse events, so the wrapping span holds the handlers instead.
 */
export function TipWrap(props: ParentProps<{tip: () => JSX.Element}>) {
  return (
    <span class="tipwrap" {...tooltip(props.tip)}>
      {props.children}
    </span>
  );
}

// --- Shared fragments -------------------------------------------------------

export function CostLine(props: {
  label: string;
  cost: GoodAmounts;
  extra?: string;
  /**
   * A bill the thing pays as it is built, rather than a price the stores
   * must cover before the order will be taken. Buildings are the only cost
   * of that kind: a site is pegged out for nothing and rises as far as the
   * loads carried to it have paid for, so being short of a good delays the
   * roof and refuses nothing. Training and research are paid at the
   * counter, and are short in the harder sense — hence two colours and two
   * sentences rather than one of each.
   */
  onCredit?: boolean;
}) {
  const entries = () => goodEntries(props.cost).filter(([, n]) => n > 0);
  const missing = (good: GoodId, n: number): boolean =>
    (stock()[good] ?? 0) < n;
  const short = () => entries().some(([good, n]) => missing(good, n));
  return (
    <div class="tip-line tip-cost">
      <b>{props.label}</b>
      <Show when={entries().length > 0} fallback={<span> free</span>}>
        <For each={entries()}>
          {([good, n]) => (
            <span
              classList={{
                'tip-bad': !props.onCredit && missing(good, n),
                'tip-warn': props.onCredit && missing(good, n),
              }}
            >
              <GoodIcon good={good} size={12} />
              {n}
            </span>
          )}
        </For>
      </Show>
      <Show when={props.extra}>
        <span> · {props.extra}</span>
      </Show>
      <Show when={short()}>
        <Show
          when={props.onCredit}
          fallback={<span class="tip-bad"> (short on goods)</span>}
        >
          <span class="tip-warn"> (the site waits on what is missing)</span>
        </Show>
      </Show>
    </div>
  );
}

// --- Content builders -------------------------------------------------------

/** Names live in names.ts (the icon layer needs them too); the flavor text
 * lives here. */
const GOOD_DESC: Record<GoodId, string> = {
  [GoodId.water]: 'Drawn at wells. Soaks the fields and thins the ale.',
  [GoodId.wheat]:
    'The crop. Milled into flour, brewed into ale, and it funds research.',
  [GoodId.wood]: 'Felled in the forest. The village is built from it.',
  [GoodId.stone]: 'Quarried from outcrops. Heavy building and road paving.',
  [GoodId.iron]: 'Hauled from mountain seams. Becomes blades and spearheads.',
  [GoodId.silver]: 'Minted currency. Pays for serfs and scholarship.',
  [GoodId.gold]: 'Rare and bright. Buys the finest arms and gilding.',
  [GoodId.sword]: 'Forged by the swordsmith. Arms one knight.',
  [GoodId.spear]: 'Shafted by the spearmaker. Arms one spearman.',
  [GoodId.bow]: 'Strung by the bowyer. Arms one archer.',
  [GoodId.ale]: 'Brewed from wheat and water. Fuels festivals at the Abbey.',
  [GoodId.flour]: 'Ground at the mill. On its own it feeds nobody.',
  [GoodId.food]: 'Baked from flour and water. What a soldier costs.',
  [GoodId.axe]:
    'Ground keen at the Smith. A woodcutter works with one or not at all.',
  [GoodId.pickaxe]:
    'Wood and stone \u2014 never iron, so the mines can always restart. Staffs the quarry and every mine.',
  [GoodId.scythe]:
    'A long blade from the Smith. No farmer takes a field without one.',
  [GoodId.hammer]:
    'The builder\u2019s loan: every site borrows one and returns it at topping-out.',
  [GoodId.cauldron]:
    'Smithed copperwork. The bakery and the brewery cook out of it.',
  [GoodId.rod]:
    'Cut and strung at the Smith \u2014 no iron in it. Staffs the fishery.',
};

export function GoodTip(props: {good: GoodId}) {
  return (
    <>
      <div class="tip-title">
        {goodName(props.good)}
        <span class="tag">{stock()[props.good] ?? 0} in store</span>
      </div>
      <div class="tip-desc">{GOOD_DESC[props.good]}</div>
    </>
  );
}

function goodsList(amounts: GoodAmounts): string {
  return goodEntries(amounts)
    .filter(([, n]) => n > 0)
    .map(([g, n]) => `${n} ${goodName(g).toLowerCase()}`)
    .join(' + ');
}

function recipeText(recipe: Recipe): string {
  if (recipe.kind === RecipeKind.gather) {
    return `Its worker gathers ${goodName(recipe.output).toLowerCase()} from nearby ${
      RESOURCE_NAMES[recipe.resource] ?? 'ground'
    }.`;
  }
  const secs = Math.round(recipe.durationTicks / TICKS_PER_SECOND);
  const outputs = goodsList(recipe.outputs);
  const inputs = goodsList(recipe.inputs);
  return inputs.length > 0
    ? `Turns ${inputs} into ${outputs} every ${secs}s.`
    : `Produces ${outputs} every ${secs}s.`;
}

const BUILDING_FLAVOR: Partial<Record<BuildingTypeId, string>> = {
  [BuildingTypeId.abbey]:
    'Monks research the tech tree here — a study’s goods are hauled in before the books open — and delivered ale throws work-speed festivals.',
  [BuildingTypeId.barracks]:
    'Trains knights and spearmen from bread and forged weapons. Archers are trained at the Archery Range.',
  [BuildingTypeId.archeryRange]:
    'Trains archers from bread and bows, a quarter faster than the barracks ever did — and on its own queue, so bowmen and steel are mustered side by side rather than one behind the other.',
  [BuildingTypeId.guardTower]:
    'Two archers man the roof, shooting half again as hard and two tiles further than they would on the ground. Man it and any archer with nothing else to do walks in from the field on his own; while none is free — none trained yet, or every one of them marching — villagers answer instead and hold it with stones, far weaker but today rather than a research, a bow and a range from now. Standing it down empties the roof again and gives the men back. Nobody manning it can be shot at while the tower stands.',
  [BuildingTypeId.house]:
    'Sleeps ten more villagers. Nobody lives here yet — beds are what let you hire.',
  [BuildingTypeId.storehouse]:
    'The heart of the village. All goods flow here — lose it and all is lost.',
};

export function BuildingTip(props: {type: BuildingTypeId}) {
  const def = () => BUILDING_DEFS[props.type];
  const lockedBy = () => {
    const req = def().requiresTech;
    if (req === undefined) return null;
    const researched = techs().researched;
    if (Array.isArray(req)) {
      // Any one of them opens the door; name them all while none has.
      return req.some(t => researched.includes(t))
        ? null
        : req.map(techName).join(' or ');
    }
    return researched.includes(req) ? null : techName(req);
  };
  return (
    <>
      <div class="tip-title">
        {buildingName(props.type)}
        <span class="tag">
          {def().w}×{def().h} · {def().hp} hp
        </span>
      </div>
      <div class="tip-desc">
        {BUILDING_FLAVOR[props.type] ??
          (def().recipe ? recipeText(def().recipe!) : '')}
      </div>
      <Show when={gatherRecipeOf(def())}>
        {gather => (
          <div class="tip-line">
            Must be built within {gather().radius} tiles of{' '}
            {RESOURCE_NAMES[gather().resource] ?? gather().resource} — that is
            as far as its worker will walk.
          </div>
        )}
      </Show>
      {/* The ration, said before the wood is spent rather than after the
          shaft goes quiet: a mine is the one gatherer that costs something
          every day it runs, and that is a thing to know while choosing
          where — and whether — to put it. */}
      <Show when={rationOf(def())}>
        {ration => (
          <div class="tip-line">
            Its miner eats 1 {goodName(ration().good).toLowerCase()} for every{' '}
            {ration().per} loads, carried out to him like any other delivery.
            None waiting and the shaft stands idle.
          </div>
        )}
      </Show>
      {/* On credit, always: what is written here is what finishes the
          building, not what the stores must hold before the plan may be
          pegged out. */}
      <CostLine
        label="Build"
        cost={def().cost}
        extra={`${Math.round(def().buildTicks / TICKS_PER_SECOND)}s`}
        onCredit
      />
      <Show when={lockedBy()}>
        <div class="tip-warn">
          Requires {lockedBy()} (research at the{' '}
          {buildingName(BuildingTypeId.abbey)})
        </div>
      </Show>
    </>
  );
}

const CLASS_INFO: Record<
  UnitClass,
  {name: string; beats: UnitClass; losesTo: UnitClass}
> = {
  [UnitClass.heavy]: {
    name: 'Heavy',
    beats: UnitClass.light,
    losesTo: UnitClass.ranged,
  },
  [UnitClass.light]: {
    name: 'Light',
    beats: UnitClass.ranged,
    losesTo: UnitClass.heavy,
  },
  [UnitClass.ranged]: {
    name: 'Ranged',
    beats: UnitClass.heavy,
    losesTo: UnitClass.light,
  },
};

const UNIT_FLAVOR: Partial<Record<UnitTypeId, string>> = {
  [UnitTypeId.serf]:
    'Carries the valley on his back, and raises what it builds.',
  [UnitTypeId.worker]:
    'Belongs to a workshop — the trade is the door he walks into.',
  [UnitTypeId.knight]: 'Slow, armored, and lethal up close.',
  [UnitTypeId.spearman]: 'Fast peasant spears — they run archers down.',
  [UnitTypeId.archer]: 'Keeps its distance and kites heavy armor.',
  // The three the valley meets rather than trains. They reach this card
  // now: an admin parade puts one of each in your own hand, and a replay
  // hands the pointer to whoever the raid belongs to.
  [UnitTypeId.bandit]: 'Comes down the road for what is stacked outside.',
  [UnitTypeId.banditArcher]:
    'Shoots from the treeline and is gone before the answer arrives.',
  [UnitTypeId.marauder]:
    'Two hands on the axe, and no interest in the granary.',
};

/**
 * The card for one kind of person. Written for the drill-ground buttons,
 * where every unit named has a weapon — but the selection card names serfs
 * and workers too, and they have no class, no damage and nothing to counter.
 * So the fighting half is drawn only when there is fighting to describe,
 * rather than reaching through a `!` that used to be true by luck of who
 * asked.
 */
export function UnitTip(props: {
  unit: UnitTypeId;
  cost?: GoodAmounts;
  lockedBy?: string | null;
}) {
  const def = () => UNIT_DEFS[props.unit];
  const combat = () => def().combat;
  const cls = () => {
    const c = combat();
    return c ? CLASS_INFO[c.class] : null;
  };
  return (
    <>
      <div class="tip-title">
        {unitName(props.unit)}
        <Show when={cls()}>
          <span class="tag">{cls()!.name}</span>
        </Show>
      </div>
      {/* Only when there is one. The map is partial by design — a kind
          may arrive before anyone has written its line — and an
          unconditional row leaves a blank band of tip between the title
          and the numbers, which reads as something failing to load. */}
      <Show when={UNIT_FLAVOR[props.unit]}>
        <div class="tip-desc">{UNIT_FLAVOR[props.unit]}</div>
      </Show>
      <div class="tip-line">
        <b>{def().hp} hp</b>
        {combat() ? ` · ${combat()!.damage} dmg` : ''} · speed {def().speed}
      </div>
      <Show when={combat()}>
        <div class="tip-line">
          <span class="tip-good">
            ×{COUNTER_TABLE[combat()!.class][cls()!.beats]} vs{' '}
            {CLASS_INFO[cls()!.beats].name}
          </span>
          {' · '}
          <span class="tip-bad">
            ×{COUNTER_TABLE[combat()!.class][cls()!.losesTo]} vs{' '}
            {CLASS_INFO[cls()!.losesTo].name}
          </span>
        </div>
      </Show>
      <Show when={props.cost}>
        <CostLine label="Train" cost={props.cost!} />
      </Show>
      <Show when={props.lockedBy}>
        <div class="tip-warn">
          Requires {props.lockedBy} (research at the{' '}
          {buildingName(BuildingTypeId.abbey)})
        </div>
      </Show>
    </>
  );
}

export function TechTip(props: {tech: TechId}) {
  const def = () => TECH_DEFS[props.tech];
  const unlockNames = () =>
    def()
      .effects.flatMap(e =>
        e.kind === TechEffectKind.unlockBuilding
          ? [buildingName(e.building)]
          : e.kind === TechEffectKind.unlockUnit
            ? [unitName(e.unit)]
            : [],
      )
      .join(', ');
  const prereqNames = () =>
    def()
      .prereqs.filter(p => !techs().researched.includes(p))
      .map(p => techName(p))
      .join(', ');
  return (
    <>
      <div class="tip-title">{techName(props.tech)}</div>
      <div class="tip-desc">{techDesc(props.tech)}</div>
      <Show when={unlockNames().length > 0}>
        <div class="tip-line">
          <b>Unlocks:</b> {unlockNames()}
        </div>
      </Show>
      <CostLine
        label="Research"
        cost={def().cost}
        extra={`${Math.round(def().durationTicks / TICKS_PER_SECOND)}s`}
      />
      {/* The seconds above are the study alone. The goods are carried to
          the Abbey before any of them run, and that walk is the other half
          of the wait — worth saying on the tip that quotes the clock. */}
      <div class="tip-line">
        Serfs carry the goods to the {buildingName(BuildingTypeId.abbey)} first;
        the study starts when the last load arrives. Order it before you can pay
        for it and the village catches up.
      </div>
      <Show when={prereqNames().length > 0}>
        <div class="tip-warn">Requires {prereqNames()}</div>
      </Show>
    </>
  );
}

/**
 * The study in hand, for the HUD's research chip.
 *
 * The chip is one bar and a name, and while the serfs are still walking
 * the bar's own number ("39%") answers the wrong question: what a player
 * wants at that moment is which loads are still on the road, and there is
 * no room on a chip that size to say. So the tip says it, good by good —
 * carried, of what the study asks — and a line that is fully in goes
 * green so the eye lands on the ones that are not.
 *
 * Only while the goods are moving. Once the books open every line reads
 * n/n by definition, which is a row of noise over the one number that has
 * become interesting again: the seconds left of the reading.
 */
export function StudyTip(props: {study: ActiveStudy}) {
  const abbey = () => buildingName(BuildingTypeId.abbey);
  return (
    <>
      <div class="tip-title">{techName(props.study.tech)}</div>
      <Show
        when={!props.study.started}
        fallback={
          <>
            <div class="tip-desc">Being read at the {abbey()}.</div>
            <div class="tip-line">
              <b>Left:</b> {Math.ceil(props.study.ticksLeft / TICKS_PER_SECOND)}
              s
            </div>
          </>
        }
      >
        <div class="tip-desc">
          Serfs are carrying its goods to the {abbey()}; the reading starts when
          the last load lands.
        </div>
        <div class="tip-line tip-cost">
          <b>Carried in:</b>
          <For each={hauledByGood(props.study)}>
            {row => (
              <span classList={{'tip-good': row.carried >= row.wanted}}>
                <GoodIcon good={row.good} size={12} />
                {row.carried}/{row.wanted}
              </span>
            )}
          </For>
        </div>
      </Show>
      <div class="tip-line">Click to open the tech tree.</div>
    </>
  );
}

/** Plain title + body tip for simple controls. */
export function TextTip(props: {title: string; body?: string}) {
  return (
    <>
      <div class="tip-title">{props.title}</div>
      <Show when={props.body}>
        <div class="tip-desc">{props.body}</div>
      </Show>
    </>
  );
}
