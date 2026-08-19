import {
  For,
  Show,
  createEffect,
  createSignal,
  onCleanup,
  type JSX,
  type ParentProps,
} from 'solid-js';

// The tooltip layer's shared signal has the same HMR fragility as store.ts:
// a hot swap splits it and tooltips freeze. Escalate to a full reload.
if (import.meta.hot) {
  import.meta.hot.accept(() => import.meta.hot?.invalidate());
}
import { TICKS_PER_SECOND } from '../sim/defs/balance';
import {
  BUILDING_DEFS,
  gatherRecipeOf,
  type BuildingTypeId,
  type Recipe,
} from '../sim/defs/buildings';
import { type GoodAmounts, type GoodId } from '../sim/defs/goods';
import { TECH_DEFS, type TechId } from '../sim/defs/techs';
import { COUNTER_TABLE, UNIT_DEFS, type UnitClass, type UnitTypeId } from '../sim/defs/units';
import { GoodIcon } from './icons';
import { buildingName, goodName, techDesc, techName, unitName } from './names';
import { stock, techs } from './store';

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
 * number to maintain. `anchor-name`/`position-area` keep it glued to the live
 * position of the trigger, `position-try-fallbacks` flips it below or hugs it
 * to the near edge when the first placement would not fit, and
 * `position-visibility` takes it away when the trigger scrolls out of a panel.
 * Browsers without anchor positioning (Firefox, Safari before 26) still get
 * the popover, placed from JS in `place()` below.
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
    showTimer = setTimeout(() => setTip({ target, content }), delay);
  };
  const hide = hideTip;
  // Where a touch started, so a press that turns into a scroll gives the
  // gesture back to the list instead of popping a tip over it.
  let from: { x: number; y: number } | null = null;
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
      from = { x: e.clientX, y: e.clientY };
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

/** Placement is CSS's job where the browser has anchor positioning. */
const CSS_ANCHORED =
  typeof CSS !== 'undefined' && CSS.supports?.('position-area', 'block-start span-all');

export function TooltipLayer() {
  let el: HTMLDivElement | undefined;
  // The element currently wearing the anchor name, so it can be undressed
  // when the tip moves on — two anchors of one name and the browser picks
  // the later one in the DOM, which is nobody's trigger in particular.
  let anchored: HTMLElement | null = null;
  let open = false;

  const setAnchor = (target: HTMLElement | null): void => {
    if (anchored === target) return;
    anchored?.style.removeProperty('anchor-name');
    anchored = target;
    target?.style.setProperty('anchor-name', ANCHOR);
  };

  /** The fallback placement, for browsers with popovers but no anchors.
   * Runs with the panel already open, so it can measure the real box
   * instead of guessing at its width the way the old layer did. */
  const place = (target: HTMLElement): void => {
    if (!el) return;
    const gap = 8;
    // .tip-js turns the anchored placement off rather than leaving it to
    // be ignored: a browser that has position-area but somehow got here
    // would keep its centring and fight the coordinates below.
    el.classList.add('tip-js');
    const a = target.getBoundingClientRect();
    const box = el.getBoundingClientRect();
    const fits = (top: number): boolean =>
      top >= gap && top + box.height <= window.innerHeight - gap;
    const above = a.top - gap - box.height;
    const below = a.bottom + gap;
    const clamp = (v: number, max: number): number => Math.max(gap, Math.min(v, max - gap));
    // The gap is the margin in the anchored path; here it is in the maths.
    el.style.top = `${clamp(
      fits(above) || !fits(below) ? above : below,
      window.innerHeight - box.height,
    )}px`;
    el.style.left = `${clamp(
      a.left + a.width / 2 - box.width / 2,
      window.innerWidth - box.width,
    )}px`;
  };

  createEffect(() => {
    const t = tip();
    if (!el) return;
    if (!t) {
      setAnchor(null);
      el.removeAttribute('data-open');
      if (open) el.hidePopover?.();
      open = false;
      return;
    }
    // A trigger can vanish under the cursor — a build button whose menu
    // closes on the click — and a tip anchored to nothing has nothing to
    // point at, so it goes with it.
    if (!t.target.isConnected) {
      hideTip();
      return;
    }
    if (CSS_ANCHORED) setAnchor(t.target);
    // showPopover() throws if it is already showing, and the tip does stay
    // up across a move to a neighbouring trigger — only its content swaps.
    if (!open) el.showPopover?.();
    open = true;
    el.setAttribute('data-open', '');
    if (!CSS_ANCHORED) place(t.target);
  });

  // A click acts on the button, so the tip has said its piece — and a
  // pointerleave the browser never sends (the trigger was removed, the
  // window lost focus) is the other way a tip used to stick to the glass.
  // Capture, so it lands before the press that a touch tip opens on — that
  // one is still only a timer at this point, and clearing it is the point.
  window.addEventListener('pointerdown', hideTip, { capture: true });
  window.addEventListener('blur', hideTip);
  onCleanup(() => {
    window.removeEventListener('pointerdown', hideTip, { capture: true });
    window.removeEventListener('blur', hideTip);
    setAnchor(null);
  });

  return (
    <>
      <style>{`
        .tipwrap { display: inline-flex; }
        /* Above the anchor and centred on it, with the margin as the gap.
           inset: auto undoes the popover UA sheet's inset: 0, which would
           otherwise stretch the panel across its placement area. Every rule
           here is #ui-scoped because #ui .panel dresses this same element:
           a bare .tip ties with it on specificity and loses on order. */
        #ui .tip {
          position: fixed; inset: auto; margin: 8px;
          position-anchor: ${ANCHOR};
          position-area: block-start span-all;
          /* First fit wins: below the anchor, then hugged to whichever
             side has the room — the corners of the HUD, where a centred
             tip is exactly what does not fit. */
          position-try-fallbacks:
            flip-block, --tip-right, --tip-right-below, --tip-left, --tip-left-below;
          /* A trigger scrolled out of its panel takes its tip with it. */
          position-visibility: anchors-visible;
          width: max-content; max-width: min(280px, calc(100vw - 16px));
          padding: 8px 11px 9px;
          pointer-events: none; font-size: 12px; line-height: 1.45;
          transition: opacity 110ms ease;
        }
        /* data-open rather than :popover-open so that a browser old enough
           to ignore the attribute entirely still hides the empty panel
           between tips instead of parking it on the HUD. */
        #ui .tip:not([data-open]) { display: none; }
        /* The JS-placed twin: plain fixed coordinates, no placement of the
           browser's own left to argue with them (a position-area centres
           its box in the area, which is the last thing top/left want). */
        #ui .tip.tip-js {
          position-area: none; justify-self: auto; align-self: auto; margin: 0;
        }
        /* The fade lives entirely in the entry: @starting-style is the
           value the panel transitions *from* as it comes off display: none.
           The steady state is a plain opaque panel, so a browser with
           neither rule — or one whose frames have stalled — shows the tip
           rather than an invisible one waiting on an animation. */
        @starting-style { #ui .tip[data-open] { opacity: 0; } }
        @position-try --tip-right { position-area: block-start span-inline-end; }
        @position-try --tip-right-below { position-area: block-end span-inline-end; }
        @position-try --tip-left { position-area: block-start span-inline-start; }
        @position-try --tip-left-below { position-area: block-end span-inline-start; }
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
        <Show when={tip()}>{(t) => t().content()}</Show>
      </div>
    </>
  );
}

/**
 * Tooltip carrier for buttons that can be disabled — disabled elements don't
 * fire mouse events, so the wrapping span holds the handlers instead.
 */
export function TipWrap(props: ParentProps<{ tip: () => JSX.Element }>) {
  return (
    <span class="tipwrap" {...tooltip(props.tip)}>
      {props.children}
    </span>
  );
}

// --- Shared fragments -------------------------------------------------------

export function CostLine(props: { label: string; cost: GoodAmounts; extra?: string }) {
  const entries = () => (Object.entries(props.cost) as [GoodId, number][]).filter(([, n]) => n > 0);
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
            <span classList={{ 'tip-bad': (stock()[good] ?? 0) < n }}>
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
  water: 'Drawn at wells. Soaks the fields and thins the ale.',
  wheat: 'The crop. Milled into flour, brewed into ale, and it funds research.',
  wood: 'Felled in the forest. The village is built from it.',
  stone: 'Quarried from outcrops. Heavy building and road paving.',
  iron: 'Hauled from mountain seams. Becomes blades and spearheads.',
  silver: 'Minted currency. Pays for serfs and scholarship.',
  gold: 'Rare and bright. Buys the finest arms and gilding.',
  sword: 'Forged by the swordsmith. Arms one knight.',
  spear: 'Shafted by the spearmaker. Arms one spearman.',
  bow: 'Strung by the bowyer. Arms one archer.',
  ale: 'Brewed from wheat and water. Fuels festivals at the Abbey.',
  flour: 'Ground at the mill. On its own it feeds nobody.',
  food: 'Baked from flour and water. What a soldier costs.',
};

export function GoodTip(props: { good: GoodId }) {
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

const RESOURCE_NAMES: Record<string, string> = {
  wood: 'woods',
  rock: 'rock outcrops',
  ironDep: 'iron seams',
  silverDep: 'silver seams',
  goldDep: 'gold seams',
};

function goodsList(amounts: GoodAmounts): string {
  return (Object.entries(amounts) as [GoodId, number][])
    .filter(([, n]) => n > 0)
    .map(([g, n]) => `${n} ${goodName(g).toLowerCase()}`)
    .join(' + ');
}

function recipeText(recipe: Recipe): string {
  if (recipe.kind === 'gather') {
    return `Its worker gathers ${goodName(recipe.output).toLowerCase()} from nearby ${
      RESOURCE_NAMES[recipe.resource] ?? recipe.resource
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
  abbey: 'Monks research the tech tree here; delivered ale throws work-speed festivals.',
  barracks: 'Trains knights, spearmen, and archers from wheat and forged weapons.',
  house: 'Sleeps ten more villagers. Nobody lives here yet — beds are what let you hire.',
  storehouse: 'The heart of the village. All goods flow here — lose it and all is lost.',
};

export function BuildingTip(props: { type: BuildingTypeId }) {
  const def = () => BUILDING_DEFS[props.type];
  const lockedBy = () => {
    const req = def().requiresTech;
    if (req === undefined) return null;
    const researched = techs().researched;
    if (Array.isArray(req)) {
      // Any one of them opens the door; name them all while none has.
      return req.some((t) => researched.includes(t)) ? null : req.map(techName).join(' or ');
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
        {BUILDING_FLAVOR[props.type] ?? (def().recipe ? recipeText(def().recipe!) : '')}
      </div>
      <Show when={gatherRecipeOf(def())}>
        {(gather) => (
          <div class="tip-line">
            Must be built within {gather().radius} tiles of{' '}
            {RESOURCE_NAMES[gather().resource] ?? gather().resource} — that is as far as its
            worker will walk.
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
          Requires {lockedBy()} (research at the {buildingName('abbey')})
        </div>
      </Show>
    </>
  );
}

const CLASS_INFO: Record<UnitClass, { name: string; beats: UnitClass; losesTo: UnitClass }> = {
  heavy: { name: 'Heavy', beats: 'light', losesTo: 'ranged' },
  light: { name: 'Light', beats: 'ranged', losesTo: 'heavy' },
  ranged: { name: 'Ranged', beats: 'heavy', losesTo: 'light' },
};

const UNIT_FLAVOR: Partial<Record<UnitTypeId, string>> = {
  knight: 'Slow, armored, and lethal up close.',
  spearman: 'Fast peasant spears — they run archers down.',
  archer: 'Keeps its distance and kites heavy armor.',
};

export function UnitTip(props: { unit: UnitTypeId; cost?: GoodAmounts; lockedBy?: string | null }) {
  const def = () => UNIT_DEFS[props.unit];
  const combat = () => def().combat!;
  const cls = () => CLASS_INFO[combat().class];
  return (
    <>
      <div class="tip-title">
        {unitName(props.unit)}
        <span class="tag">{cls().name}</span>
      </div>
      <div class="tip-desc">{UNIT_FLAVOR[props.unit]}</div>
      <div class="tip-line">
        <b>{def().hp} hp</b> · {combat().damage} dmg · speed {def().speed}
      </div>
      <div class="tip-line">
        <span class="tip-good">
          ×{COUNTER_TABLE[combat().class][cls().beats]} vs {CLASS_INFO[cls().beats].name}
        </span>
        {' · '}
        <span class="tip-bad">
          ×{COUNTER_TABLE[combat().class][cls().losesTo]} vs {CLASS_INFO[cls().losesTo].name}
        </span>
      </div>
      <Show when={props.cost}>
        <CostLine label="Train" cost={props.cost!} />
      </Show>
      <Show when={props.lockedBy}>
        <div class="tip-warn">
          Requires {props.lockedBy} (research at the {buildingName('abbey')})
        </div>
      </Show>
    </>
  );
}

export function TechTip(props: { tech: TechId }) {
  const def = () => TECH_DEFS[props.tech];
  const unlockNames = () =>
    def()
      .effects.flatMap((e) =>
        e.kind === 'unlockBuilding'
          ? [buildingName(e.building)]
          : e.kind === 'unlockUnit'
            ? [unitName(e.unit)]
            : [],
      )
      .join(', ');
  const prereqNames = () =>
    def()
      .prereqs.filter((p) => !techs().researched.includes(p))
      .map((p) => techName(p))
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
export function TextTip(props: { title: string; body?: string }) {
  return (
    <>
      <div class="tip-title">{props.title}</div>
      <Show when={props.body}>
        <div class="tip-desc">{props.body}</div>
      </Show>
    </>
  );
}
