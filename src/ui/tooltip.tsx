import {
  For,
  Show,
  createEffect,
  createSignal,
  onCleanup,
  type JSX,
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
}

const [tip, setTip] = createSignal<TipState | null>(null);
let showTimer: ReturnType<typeof setTimeout> | undefined;

/** Take the tip down, and call off one that was still on its way up. */
function hideTip(): void {
  clearTimeout(showTimer);
  setTip(null);
}

export function tooltip(content: () => JSX.Element): {
  onPointerEnter: (e: PointerEvent) => void;
  onPointerLeave: () => void;
  onPointerDown: (e: PointerEvent) => void;
  onPointerMove: (e: PointerEvent) => void;
  onPointerUp: () => void;
  onPointerCancel: () => void;
} {
  const show = (target: HTMLElement, delay: number): void => {
    clearTimeout(showTimer);
    showTimer = setTimeout(() => setTip({target, content}), delay);
  };
  const hide = hideTip;
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
        <Show when={tip()}>{t => t().content()}</Show>
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
}) {
  const entries = () => goodEntries(props.cost).filter(([, n]) => n > 0);
  const short = () => {
    const s = stock();
    return entries().some(([good, n]) => (s[good] ?? 0) < n);
  };
  return (
    <div class="tip-line tip-cost">
      <b>{props.label}</b>
      <Show when={entries().length > 0} fallback={<span> free</span>}>
        <For each={entries()}>
          {([good, n]) => (
            <span classList={{'tip-bad': (stock()[good] ?? 0) < n}}>
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
        <span class="tip-bad"> (short on goods)</span>
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
    'Monks research the tech tree here; delivered ale throws work-speed festivals.',
  [BuildingTypeId.barracks]:
    'Trains knights, spearmen, and archers from wheat and forged weapons.',
  [BuildingTypeId.guardTower]:
    'Two archers man the roof, shooting half again as hard and two tiles further than they would on the ground. Man it and any archer with nothing else to do walks in from the field on his own; while none is free — none trained yet, or every one of them marching — villagers answer instead and hold it with stones, far weaker but today rather than three techs from now. Standing it down empties the roof again and gives the men back. Nobody manning it can be shot at while the tower stands.',
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
      <CostLine
        label="Build"
        cost={def().cost}
        extra={`${Math.round(def().buildTicks / TICKS_PER_SECOND)}s`}
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
      <Show when={prereqNames().length > 0}>
        <div class="tip-warn">Requires {prereqNames()}</div>
      </Show>
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
