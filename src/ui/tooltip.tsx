import { For, Show, createSignal, type JSX, type ParentProps } from 'solid-js';

// The tooltip layer's shared signal has the same HMR fragility as store.ts:
// a hot swap splits it and tooltips freeze. Escalate to a full reload.
if (import.meta.hot) {
  import.meta.hot.accept(() => import.meta.hot?.invalidate());
}
import { TICKS_PER_SECOND } from '../sim/defs/balance';
import { BUILDING_DEFS, type BuildingTypeId, type Recipe } from '../sim/defs/buildings';
import { type GoodAmounts, type GoodId } from '../sim/defs/goods';
import { TECH_DEFS, type TechId } from '../sim/defs/techs';
import { COUNTER_TABLE, UNIT_DEFS, type UnitClass, type UnitTypeId } from '../sim/defs/units';
import { GoodIcon } from './icons';
import { buildingName, goodName, techDesc, techName, unitName } from './names';
import { THEME } from '../render/medieval';
import { stock, techs } from './store';

const MEDIEVAL = THEME === 'medieval';

/**
 * One floating tooltip layer for the whole HUD. Spread `{...tooltip(...)}`
 * onto any element; content renders in a themed panel anchored above or
 * below the element (whichever half of the screen it sits in), after a short
 * hover delay. Replaces every native `title` attribute.
 */

interface TipState {
  rect: DOMRect;
  content: () => JSX.Element;
}

const [tip, setTip] = createSignal<TipState | null>(null);
let showTimer: ReturnType<typeof setTimeout> | undefined;

export function tooltip(content: () => JSX.Element): {
  onMouseEnter: (e: MouseEvent) => void;
  onMouseLeave: () => void;
  onPointerDown: (e: PointerEvent) => void;
  onPointerUp: () => void;
  onPointerCancel: () => void;
} {
  const show = (target: HTMLElement, delay: number): void => {
    const rect = target.getBoundingClientRect();
    clearTimeout(showTimer);
    showTimer = setTimeout(() => setTip({ rect, content }), delay);
  };
  const hide = (): void => {
    clearTimeout(showTimer);
    setTip(null);
  };
  return {
    onMouseEnter: (e: MouseEvent) => show(e.currentTarget as HTMLElement, 130),
    onMouseLeave: hide,
    // Touch has no hover: press and hold reveals the tip instead, and it
    // clears on release. (Mouse presses are already covered by hover.)
    onPointerDown: (e: PointerEvent) => {
      if (e.pointerType !== 'mouse') show(e.currentTarget as HTMLElement, 260);
    },
    onPointerUp: hide,
    onPointerCancel: hide,
  };
}

export function TooltipLayer() {
  const pos = (): JSX.CSSProperties => {
    const t = tip();
    if (!t) return {};
    const cx = Math.min(Math.max(t.rect.left + t.rect.width / 2, 150), window.innerWidth - 150);
    const above = t.rect.top > window.innerHeight / 2;
    return {
      left: `${cx}px`,
      ...(above
        ? { bottom: `${window.innerHeight - t.rect.top + 8}px` }
        : { top: `${t.rect.bottom + 8}px` }),
    };
  };

  return (
    <>
      <style>{`
        .tipwrap { display: inline-flex; }
        .tip-layer {
          position: fixed; transform: translateX(-50%); z-index: 40;
          width: max-content; max-width: 280px; padding: 8px 11px 9px;
          pointer-events: none; font-size: 12px; line-height: 1.45;
        }
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
      <Show when={tip()}>
        <div class="panel tip-layer" style={pos()}>
          {tip()!.content()}
        </div>
      </Show>
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

/** Names live in names.ts (the icon layer needs them too); only the flavor
 * text is theme-branched here. */
const GOOD_DESC: Record<GoodId, string> = MEDIEVAL
  ? {
      water: 'Drawn at wells. Soaks the fields and thins the ale.',
      rice: 'The staple. Feeds soldiers in training and funds research.',
      bamboo: 'Felled in the forest. The village is built from it.',
      stone: 'Quarried from outcrops. Heavy building and road paving.',
      iron: 'Hauled from mountain seams. Becomes blades and spearheads.',
      silver: 'Minted currency. Pays for serfs and scholarship.',
      gold: 'Rare and bright. Buys the finest arms and gilding.',
      katana: 'Forged by the swordsmith. Arms one knight.',
      yari: 'Shafted by the spearmaker. Arms one spearman.',
      yumi: 'Strung by the bowyer. Arms one archer.',
      sake: 'Brewed from wheat and water. Fuels festivals at the Abbey.',
    }
  : {
      water: 'Drawn at wells. Floods rice paddies and thins the sake.',
      rice: 'The staple. Feeds soldiers in training and funds research.',
      bamboo: 'Cut from the groves. The village is built from it.',
      stone: 'Quarried from outcrops. Heavy building and road paving.',
      iron: 'Hauled from mountain seams. Becomes blades and spearheads.',
      silver: 'Minted currency. Pays for serfs and scholarship.',
      gold: 'Rare and bright. Buys the finest arms and inlays.',
      katana: 'Forged by the swordsmith. Arms one samurai.',
      yari: 'Shafted by the spearmaker. Arms one ashigaru.',
      yumi: 'Strung by the bowyer. Arms one archer.',
      sake: 'Brewed from rice and water. Fuels festivals at the Terakoya.',
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
  bamboo: MEDIEVAL ? 'woods' : 'bamboo groves',
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
  terakoya: MEDIEVAL
    ? 'Monks research the tech tree here; delivered ale throws work-speed festivals.'
    : 'Monks research the tech tree here; delivered sake throws work-speed festivals.',
  dojo: MEDIEVAL
    ? 'Trains knights, spearmen, and archers from wheat and forged weapons.'
    : 'Trains samurai, ashigaru, and archers from rice and forged weapons.',
  storehouse: 'The heart of the village. All goods flow here — lose it and all is lost.',
};

export function BuildingTip(props: { type: BuildingTypeId }) {
  const def = () => BUILDING_DEFS[props.type];
  const lockedBy = () => {
    const req = def().requiresTech;
    return req !== undefined && !techs().researched.includes(req) ? techName(req) : null;
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
      <Show when={def().nearDeposit}>
        <div class="tip-line">Must be placed beside {RESOURCE_NAMES[def().nearDeposit!.resource]}.</div>
      </Show>
      <CostLine
        label="Build"
        cost={def().cost}
        extra={`${Math.round(def().buildTicks / TICKS_PER_SECOND)}s`}
      />
      <Show when={lockedBy()}>
        <div class="tip-warn">
          Requires {lockedBy()} (research at the {buildingName('terakoya')})
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
  samurai: 'Slow, armored, and lethal up close.',
  ashigaru: 'Fast peasant spears — they run archers down.',
  archer: 'Keeps its distance and kites heavy armor.',
}; // flavor is class-based and reads fine in both themes

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
          Requires {props.lockedBy} (research at the {buildingName('terakoya')})
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
