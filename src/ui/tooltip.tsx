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
import { stock, techs } from './store';

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
} {
  return {
    onMouseEnter: (e: MouseEvent) => {
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
      clearTimeout(showTimer);
      showTimer = setTimeout(() => setTip({ rect, content }), 130);
    },
    onMouseLeave: () => {
      clearTimeout(showTimer);
      setTip(null);
    },
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

const GOOD_INFO: Record<GoodId, { name: string; desc: string }> = {
  water: { name: 'Water', desc: 'Drawn at wells. Floods rice paddies and thins the sake.' },
  rice: { name: 'Rice', desc: 'The staple. Feeds soldiers in training and funds research.' },
  bamboo: { name: 'Bamboo', desc: 'Cut from the groves. The village is built from it.' },
  stone: { name: 'Stone', desc: 'Quarried from outcrops. Heavy building and road paving.' },
  iron: { name: 'Iron', desc: 'Hauled from mountain seams. Becomes blades and spearheads.' },
  silver: { name: 'Silver', desc: 'Minted currency. Pays for serfs and scholarship.' },
  gold: { name: 'Gold', desc: 'Rare and bright. Buys the finest arms and inlays.' },
  katana: { name: 'Katana', desc: 'Forged by the swordsmith. Arms one samurai.' },
  yari: { name: 'Yari', desc: 'Shafted by the spearmaker. Arms one ashigaru.' },
  yumi: { name: 'Yumi', desc: 'Strung by the bowyer. Arms one archer.' },
  sake: { name: 'Sake', desc: 'Brewed from rice and water. Fuels festivals at the Terakoya.' },
};

export function GoodTip(props: { good: GoodId }) {
  return (
    <>
      <div class="tip-title">
        {GOOD_INFO[props.good].name}
        <span class="tag">{stock()[props.good] ?? 0} in store</span>
      </div>
      <div class="tip-desc">{GOOD_INFO[props.good].desc}</div>
    </>
  );
}

const RESOURCE_NAMES: Record<string, string> = {
  bamboo: 'bamboo groves',
  rock: 'rock outcrops',
  ironDep: 'iron seams',
  silverDep: 'silver seams',
  goldDep: 'gold seams',
};

function goodsList(amounts: GoodAmounts): string {
  return (Object.entries(amounts) as [GoodId, number][])
    .filter(([, n]) => n > 0)
    .map(([g, n]) => `${n} ${GOOD_INFO[g].name.toLowerCase()}`)
    .join(' + ');
}

function recipeText(recipe: Recipe): string {
  if (recipe.kind === 'gather') {
    return `Its worker gathers ${GOOD_INFO[recipe.output].name.toLowerCase()} from nearby ${
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
  terakoya: 'Monks research the tech tree here; delivered sake throws work-speed festivals.',
  dojo: 'Trains samurai, ashigaru, and archers from rice and forged weapons.',
  storehouse: 'The heart of the village. All goods flow here — lose it and all is lost.',
};

export function BuildingTip(props: { type: BuildingTypeId }) {
  const def = () => BUILDING_DEFS[props.type];
  const lockedBy = () => {
    const req = def().requiresTech;
    return req !== undefined && !techs().researched.includes(req) ? TECH_DEFS[req].name : null;
  };
  return (
    <>
      <div class="tip-title">
        {def().name}
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
        <div class="tip-warn">Requires {lockedBy()} (research at the Terakoya)</div>
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
};

export function UnitTip(props: { unit: UnitTypeId; cost?: GoodAmounts; lockedBy?: string | null }) {
  const def = () => UNIT_DEFS[props.unit];
  const combat = () => def().combat!;
  const cls = () => CLASS_INFO[combat().class];
  return (
    <>
      <div class="tip-title">
        {props.unit.charAt(0).toUpperCase() + props.unit.slice(1)}
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
        <div class="tip-warn">Requires {props.lockedBy} (research at the Terakoya)</div>
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
          ? [BUILDING_DEFS[e.building].name]
          : e.kind === 'unlockUnit'
            ? [e.unit.charAt(0).toUpperCase() + e.unit.slice(1)]
            : [],
      )
      .join(', ');
  const prereqNames = () =>
    def()
      .prereqs.filter((p) => !techs().researched.includes(p))
      .map((p) => TECH_DEFS[p].name)
      .join(', ');
  return (
    <>
      <div class="tip-title">{def().name}</div>
      <div class="tip-desc">{def().desc}</div>
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
