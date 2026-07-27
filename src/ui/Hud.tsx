import { For, Show, createSignal } from 'solid-js';
import { GOODS, type GoodId } from '../sim/defs/goods';
import { BUILDING_DEFS, type BuildingTypeId } from '../sim/defs/buildings';
import type { TechId } from '../sim/defs/techs';
import type { UnitTypeId } from '../sim/defs/units';
import type { AdminAction } from '../sim/commands';
import { TechTreePanel } from './TechTreePanel';
import { SelectionPanel } from './SelectionPanel';
import { AdminPanel } from './AdminPanel';
import { FastIcon, GoodIcon, LockIcon, PauseIcon, PlayIcon } from './icons';
import {
  BuildingTip,
  CostLine,
  GoodTip,
  TextTip,
  TipWrap,
  TooltipLayer,
  tooltip,
} from './tooltip';
import {
  debugJobs,
  debugOpen,
  invariantViolations,
  outcome,
  placing,
  setTechPanelOpen,
  speed,
  stock,
  techPanelOpen,
  techs,
  toasts,
} from './store';
import { buildingName, techName } from './names';
import { THEME } from '../render/medieval';

const SPEEDS = [
  { value: 0, icon: PauseIcon, label: 'Pause', hint: 'Orders you give still queue up.' },
  { value: 1, icon: PlayIcon, label: 'Normal speed', hint: undefined as string | undefined },
  { value: 3, icon: FastIcon, label: 'Fast forward', hint: 'Runs the village at 3× speed.' },
];

/** Build menu grouped the way a lord thinks. Chips follow the theme. */
const MEDIEVAL = THEME === 'medieval';
const BUILD_GROUPS: { label: string; kanji: string; types: BuildingTypeId[] }[] = [
  {
    label: 'Village',
    kanji: MEDIEVAL ? '⌂' : '村',
    types: ['bambooHut', 'quarry', 'well', 'ricePaddy', 'terakoya'],
  },
  {
    label: 'Industry',
    kanji: MEDIEVAL ? '⚒' : '工',
    types: ['sakeBrewery', 'ironMine', 'silverMine', 'goldMine', 'swordsmith', 'spearmaker', 'bowyer'],
  },
  { label: 'War', kanji: MEDIEVAL ? '⚔' : '戦', types: ['dojo'] },
];

export function Hud(props: {
  onSpeed: (speed: number) => void;
  onPlace: (type: BuildingTypeId | null) => void;
  onHire: () => void;
  onResearch: (tech: TechId) => void;
  onTrain: (buildingId: number, unit: UnitTypeId) => void;
  onSave: () => void;
  onAdmin: (action: AdminAction) => void;
}) {
  const adminMode = new URLSearchParams(location.search).has('admin');
  const [menuOpen, setMenuOpen] = createSignal(false);
  const cost = (type: BuildingTypeId) => Object.entries(BUILDING_DEFS[type].cost) as [GoodId, number][];
  const affordable = (type: BuildingTypeId): boolean => {
    const s = stock();
    return cost(type).every(([good, n]) => (s[good] ?? 0) >= n);
  };
  const unlocked = (type: BuildingTypeId): boolean => {
    const req = BUILDING_DEFS[type].requiresTech;
    return req === undefined || techs().researched.includes(req);
  };

  return (
    <>
      <style>{`
        /* ——— Feudal-Japan lacquer HUD ———
           Palette: sumi lacquer #241a12/#100a05, vermillion (shu-iro) #a63a24/#c3402b,
           kin gold #d9b45a, washi cream #eddfb6. */
        #ui { font-family: 'Zen Antique', Georgia, serif; }
        #ui .panel {
          background: linear-gradient(180deg, #241a12 0%, #180f08 45%, #100a05 100%);
          border: 1px solid #080502;
          border-top: 3px solid #a63a24;
          box-shadow:
            inset 0 1px 0 rgba(217, 180, 90, 0.25),
            inset 0 0 0 1px rgba(166, 58, 36, 0.3),
            inset 0 0 0 4px rgba(8, 5, 2, 0.9),
            inset 0 0 0 5px rgba(217, 180, 90, 0.18),
            inset 0 0 50px rgba(0, 0, 0, 0.55),
            0 8px 28px rgba(0, 0, 0, 0.7);
          border-radius: 2px;
          color: #eddfb6;
          font-size: 13px;
        }
        #ui button {
          background: linear-gradient(180deg, #3a2b1b 0%, #241809 60%, #1a1005 100%);
          border: 1px solid #090502;
          border-bottom: 2px solid rgba(166, 58, 36, 0.55);
          border-radius: 2px;
          color: #eddfb6;
          text-shadow: 0 1px 2px rgba(0, 0, 0, 0.9);
          box-shadow: inset 0 1px 0 rgba(217, 180, 90, 0.3), inset 0 0 0 1px rgba(217, 180, 90, 0.1), inset 0 -3px 5px rgba(0, 0, 0, 0.45);
          padding: 6px 11px;
          font-family: 'Zen Antique', Georgia, serif;
          font-size: 12px;
          cursor: pointer;
          transition: border-color 0.1s, box-shadow 0.1s, color 0.1s;
        }
        #ui button:hover:not(:disabled) {
          color: #f8ecc6;
          border-color: rgba(195, 64, 43, 0.8);
          box-shadow: inset 0 1px 0 rgba(217, 180, 90, 0.45), inset 0 0 10px rgba(195, 64, 43, 0.3), 0 0 10px rgba(195, 64, 43, 0.35);
        }
        #ui button:disabled {
          cursor: default;
          color: #7d7161;
          background:
            repeating-linear-gradient(-45deg, rgba(0, 0, 0, 0.3) 0 6px, transparent 6px 12px),
            linear-gradient(180deg, #241d14 0%, #17110a 100%);
          border-bottom-color: #090502;
          box-shadow: inset 0 1px 0 rgba(217, 180, 90, 0.08), inset 0 -3px 5px rgba(0, 0, 0, 0.5);
        }
        #ui button.active {
          background: linear-gradient(160deg, #c3402b, #8c2b18);
          border-color: #d9b45a;
          color: #f5e6c8;
          box-shadow: inset 0 1px 0 rgba(255, 190, 150, 0.35), inset 0 -2px 3px rgba(0, 0, 0, 0.45), 0 0 10px rgba(195, 64, 43, 0.4);
        }
        #ui .cost {
          opacity: 0.9; margin-left: 6px; white-space: nowrap;
          font-family: 'Shippori Mincho', Georgia, serif;
          font-variant-numeric: tabular-nums;
          color: #d3c092;
        }
        #ui .cost svg { margin-left: 4px; }

        .hud-resources {
          position: absolute; top: 10px; left: 50%; transform: translateX(-50%);
          display: flex; gap: 15px; padding: 8px 20px; pointer-events: auto;
          white-space: nowrap;
        }
        .hud-resources span {
          opacity: 0.4; display: inline-flex; align-items: center; gap: 5px;
          font-family: 'Shippori Mincho', Georgia, serif; font-weight: 600;
          font-size: 14px; color: #e8d6a4;
          font-variant-numeric: tabular-nums;
          text-shadow: 0 1px 2px rgba(0, 0, 0, 0.9);
        }
        .hud-resources span.has { opacity: 1; }

        .hud-speed {
          position: absolute; top: 10px; right: 10px; display: flex; gap: 4px;
          pointer-events: auto;
        }
        .hud-speed button { min-width: 38px; padding: 6px 8px; letter-spacing: 0.08em; }

        .hud-menu {
          position: absolute; top: 52px; right: 10px; width: 190px;
          display: flex; flex-direction: column; gap: 6px;
          padding: 10px 12px; pointer-events: auto;
        }
        .hud-menu .menu-head {
          display: flex; justify-content: space-between; align-items: center;
          margin-bottom: 2px;
        }
        .hud-menu .menu-close { min-width: 0; padding: 2px 8px; }

        .research-chip {
          position: relative; overflow: hidden; padding: 4px 12px;
          font-size: 12px;
        }
        .research-chip .fill {
          position: absolute; inset: 0 auto 0 0;
          background: linear-gradient(180deg, rgba(217, 180, 90, 0.5), rgba(166, 110, 36, 0.45));
          transition: width 0.4s;
        }
        .research-chip .label { position: relative; }

        .hud-build {
          position: absolute; bottom: 12px; left: 12px;
          display: flex; flex-direction: column; gap: 8px;
          padding: 13px 16px 14px; pointer-events: auto; max-width: 66vw;
        }
        .hud-build .group { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; }
        .hud-build .group-seal {
          width: 26px; height: 26px; display: grid; place-items: center; flex-shrink: 0;
          background: linear-gradient(160deg, #c3402b, #8c2b18);
          border-radius: 3px;
          box-shadow: inset 0 1px 0 rgba(255, 190, 150, 0.35), inset 0 -2px 3px rgba(0, 0, 0, 0.45), 0 1px 4px rgba(0, 0, 0, 0.6);
          color: #f5e6c8;
          font-family: 'Shippori Mincho', serif; font-weight: 700; font-size: 15px;
          text-shadow: 0 1px 1px rgba(0, 0, 0, 0.5);
        }
        .hud-build .group-label {
          letter-spacing: 0.16em; text-transform: uppercase;
          color: #d9b45a; width: 72px; font-size: 11px; flex-shrink: 0;
          text-shadow: 0 1px 2px rgba(0, 0, 0, 0.9);
        }

        .hud-selection {
          /* Command-card corner, clear of the build bar — and interactive:
             without pointer-events the train buttons are mouse-dead. */
          position: absolute; bottom: 12px; right: 12px;
          padding: 8px 16px; pointer-events: auto; max-width: 34vw;
        }
        .hud-debug {
          position: absolute; top: 52px; right: 10px; width: 380px; max-height: 60vh;
          overflow: auto; padding: 8px 10px; pointer-events: auto;
          font-family: ui-monospace, monospace; font-size: 11px;
        }
        .hud-debug table { width: 100%; border-collapse: collapse; }
        .hud-debug td, .hud-debug th { padding: 1px 4px; text-align: left; }
        .hud-violations {
          position: absolute; top: 52px; left: 50%; transform: translateX(-50%);
          background: #6b2114; color: #f5e7d0; padding: 6px 14px; border-radius: 2px;
          border: 1px solid #c3402b; max-width: 70vw;
        }
        .hud-festival {
          position: absolute; top: 52px; right: 10px; padding: 6px 12px;
          border-color: #d9b45a;
        }
        .hud-toasts {
          position: absolute; top: 90px; right: 10px; display: flex;
          flex-direction: column; gap: 6px; align-items: flex-end;
        }
        .toast { padding: 7px 13px; border-top-color: #c3402b; }
        .hud-end {
          position: absolute; inset: 0; display: grid; place-items: center;
          background: rgba(6, 8, 6, 0.7); pointer-events: auto;
        }
        .end-card { padding: 30px 44px; text-align: center; }
        .end-card h1 {
          margin: 0 0 8px; font-size: 30px;
          font-family: 'Shippori Mincho', Georgia, serif; font-weight: 600;
          color: #d9b45a; text-shadow: 0 1px 3px rgba(0, 0, 0, 0.8);
        }
        .end-card button { margin-top: 12px; padding: 8px 24px; font-size: 14px; }
      `}</style>

      <div class="hud-resources panel">
        <For each={[...GOODS]}>
          {(good) => (
            <span
              classList={{ has: (stock()[good] ?? 0) > 0 }}
              {...tooltip(() => <GoodTip good={good} />)}
            >
              <GoodIcon good={good} /> {stock()[good] ?? 0}
            </span>
          )}
        </For>
        <Show when={techs().active}>
          {(a) => (
            <button
              class="research-chip"
              {...tooltip(() => (
                <TextTip
                  title={techName(a().tech)}
                  body="Being researched — click to open the tech tree."
                />
              ))}
              onClick={() => setTechPanelOpen(true)}
            >
              <span
                class="fill"
                style={{ width: `${Math.round((1 - a().ticksLeft / a().totalTicks) * 100)}%` }}
              />
              <span class="label">⚗ {techName(a().tech)}</span>
            </button>
          )}
        </Show>
      </div>

      <div class="hud-speed">
        <button
          classList={{ active: menuOpen() }}
          {...tooltip(() => <TextTip title="Menu" body="Save and load the village." />)}
          onClick={() => setMenuOpen(!menuOpen())}
        >
          ☰
        </button>
        <For each={SPEEDS}>
          {(s) => (
            <button
              classList={{ active: speed() === s.value }}
              {...tooltip(() => <TextTip title={s.label} body={s.hint} />)}
              onClick={() => props.onSpeed(s.value)}
            >
              <s.icon />
            </button>
          )}
        </For>
      </div>

      <Show when={menuOpen()}>
        <div class="hud-menu panel">
          <div class="menu-head">
            <b>Menu</b>
            <button class="menu-close" onClick={() => setMenuOpen(false)}>
              ✕
            </button>
          </div>
          <button
            onClick={() => {
              props.onSave();
              setMenuOpen(false);
            }}
          >
            Save village
          </button>
          <button
            disabled={!localStorage.getItem('serf-save')}
            onClick={() => {
              const data = localStorage.getItem('serf-save');
              if (data) {
                // sessionStorage: survives this tab's reload but is invisible
                // to other tabs — two open tabs must never race for it.
                sessionStorage.setItem('serf-load-pending', data);
                location.reload();
              }
            }}
          >
            Load last save
          </button>
        </div>
      </Show>

      <div class="hud-build panel">
        <For each={BUILD_GROUPS}>
          {(group) => (
            <div class="group">
              <span class="group-seal">{group.kanji}</span>
              <span class="group-label">{group.label}</span>
              <For each={group.types}>
                {(type) => (
                  <TipWrap tip={() => <BuildingTip type={type} />}>
                    <Show
                      when={unlocked(type)}
                      fallback={
                        <button disabled>
                          <LockIcon /> {buildingName(type)}
                        </button>
                      }
                    >
                      <button
                        classList={{ active: placing() === type }}
                        disabled={!affordable(type) && placing() !== type}
                        onClick={() => props.onPlace(placing() === type ? null : type)}
                      >
                        {buildingName(type)}
                        <span class="cost">
                          <For each={cost(type)}>
                            {([good, n]) => (
                              <>
                                <GoodIcon good={good} size={12} />
                                {n}
                              </>
                            )}
                          </For>
                        </span>
                      </button>
                    </Show>
                  </TipWrap>
                )}
              </For>
              <Show when={group.label === 'War'}>
                <TipWrap
                  tip={() => (
                    <>
                      <TextTip
                        title="Hire Serf"
                        body="Another pair of hands joins the village to haul goods and build."
                      />
                      <CostLine label="Hire" cost={{ silver: 5 }} />
                    </>
                  )}
                >
                  <button disabled={(stock().silver ?? 0) < 5} onClick={() => props.onHire()}>
                    Hire Serf
                    <span class="cost">
                      <GoodIcon good="silver" size={12} />5
                    </span>
                  </button>
                </TipWrap>
              </Show>
            </div>
          )}
        </For>
      </div>

      <Show when={techPanelOpen()}>
        <TechTreePanel onResearch={props.onResearch} />
      </Show>

      <Show when={techs().festivalTicksLeft > 0}>
        <div class="hud-festival panel">Festival! Everyone works faster</div>
      </Show>

      <SelectionPanel onTrain={props.onTrain} />

      <div class="hud-toasts">
        <For each={toasts()}>{(t) => <div class="panel toast">{t.text}</div>}</For>
      </div>

      <Show when={outcome() !== 'playing'}>
        <div class="hud-end">
          <div class="panel end-card">
            <h1>
              {outcome() === 'won'
                ? MEDIEVAL
                  ? 'Victory'
                  : '勝利 — Victory'
                : MEDIEVAL
                  ? 'Defeat'
                  : '敗北 — Defeat'}
            </h1>
            <p>
              {outcome() === 'won'
                ? 'The bandit camp lies in ruins. The valley is yours.'
                : 'The storehouse has fallen. The village scatters to the winds.'}
            </p>
            <button
              onClick={() => {
                // A fresh game, unconditionally: clear any pending load so
                // the reload can't boot back into a save.
                sessionStorage.removeItem('serf-load-pending');
                location.reload();
              }}
            >
              Play again
            </button>
          </div>
        </div>
      </Show>

      <Show when={invariantViolations().length > 0}>
        <div class="hud-violations">
          {invariantViolations().length} invariant violation(s) — see console
        </div>
      </Show>

      <Show when={adminMode}>
        <AdminPanel onAdmin={props.onAdmin} />
      </Show>

      <TooltipLayer />

      <Show when={debugOpen()}>
        <div class="hud-debug panel">
          <b>jobs ({debugJobs().length})</b>
          <table>
            <thead>
              <tr>
                <th>id</th>
                <th>good</th>
                <th>route</th>
                <th>pri</th>
                <th>phase</th>
                <th>serf</th>
                <th>age</th>
              </tr>
            </thead>
            <tbody>
              <For each={debugJobs()}>
                {(j) => (
                  <tr>
                    <td>{j.id}</td>
                    <td>{j.good}</td>
                    <td>
                      {j.from}→{j.to}
                    </td>
                    <td>{j.priority}</td>
                    <td>{j.phase}</td>
                    <td>{j.serfId ?? '—'}</td>
                    <td>{j.age}</td>
                  </tr>
                )}
              </For>
            </tbody>
          </table>
        </div>
      </Show>
    </>
  );
}
