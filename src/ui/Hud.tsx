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
import { BuildingTip, GoodTip, TextTip, TipWrap, TooltipLayer, tooltip } from './tooltip';
import { buildingName, techName } from './names';
import {
  debugJobs,
  debugOpen,
  netMode,
  netStatus,
  invariantViolations,
  myPlayerId,
  openPanel,
  outcome,
  placing,
  playersMeta,
  setOpenPanel,
  setTechPanelOpen,
  speed,
  stock,
  techPanelOpen,
  techs,
  toasts,
  CHEATS_ALLOWED,
} from './store';

const SPEEDS = [
  { value: 0, icon: PauseIcon, label: 'Pause', hint: 'Orders you give still queue up.' },
  { value: 1, icon: PlayIcon, label: 'Normal speed', hint: undefined as string | undefined },
  { value: 3, icon: FastIcon, label: 'Fast forward', hint: 'Runs the village at 3× speed.' },
];

const BUILD_GROUPS: { label: string; types: BuildingTypeId[] }[] = [
  { label: 'Village', types: ['bambooHut', 'quarry', 'well', 'ricePaddy', 'terakoya'] },
  {
    label: 'Industry',
    types: ['sakeBrewery', 'ironMine', 'silverMine', 'goldMine', 'swordsmith', 'spearmaker', 'bowyer'],
  },
  { label: 'War', types: ['dojo'] },
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
  // The sim rejects admin commands in a match (world.admin.enabled is
  // false), so every button here no-ops — except the fog toggle, which
  // never reaches the sim. Hide the panel rather than leave that one live.
  const adminMode = CHEATS_ALLOWED && new URLSearchParams(location.search).has('admin');
  const [activeTab, setActiveTab] = createSignal(0);
  const menuOpen = (): boolean => openPanel() === 'menu';
  const setMenuOpen = (open: boolean): void => {
    setOpenPanel(open ? 'menu' : null);
  };
  const cost = (type: BuildingTypeId) => Object.entries(BUILDING_DEFS[type].cost) as [GoodId, number][];
  const affordable = (type: BuildingTypeId): boolean => {
    const s = stock();
    return cost(type).every(([good, n]) => (s[good] ?? 0) >= n);
  };
  const unlocked = (type: BuildingTypeId): boolean => {
    const req = BUILDING_DEFS[type].requiresTech;
    return req === undefined || techs().researched.includes(req);
  };
  const soloMode = (): boolean => playersMeta().length <= 1;
  const won = (): boolean => {
    const o = outcome();
    return o.state === 'over' && o.winner === myPlayerId();
  };

  return (
    <>
      <style>{`
        /* ——— Modern glass HUD ———
           Glass panels rgba(14,16,15,0.72) + blur, hairline borders,
           one gold accent #e5c469 for active states. */
        #ui { font-family: 'Space Grotesk', system-ui, sans-serif; }
        #ui .panel {
          background: rgba(14, 16, 15, 0.72);
          -webkit-backdrop-filter: blur(14px);
          backdrop-filter: blur(14px);
          border: 1px solid rgba(255, 255, 255, 0.09);
          border-radius: 14px;
          box-shadow: 0 4px 24px rgba(0, 0, 0, 0.35);
          color: #eceade;
          font-size: 13px;
        }
        #ui button {
          font-family: inherit;
          font-size: 13px;
          font-weight: 500;
          color: #eceade;
          background: rgba(255, 255, 255, 0.06);
          border: 1px solid rgba(255, 255, 255, 0.14);
          border-radius: 10px;
          padding: 7px 12px;
          cursor: pointer;
          transition: background 0.15s, border-color 0.15s, color 0.15s;
        }
        #ui button:hover:not(:disabled) {
          background: rgba(229, 196, 105, 0.14);
          border-color: rgba(229, 196, 105, 0.45);
        }
        #ui button:disabled {
          cursor: default;
          color: #6d6f68;
          background: rgba(255, 255, 255, 0.025);
          border-style: dashed;
          border-color: rgba(255, 255, 255, 0.12);
        }
        #ui button.active {
          background: rgba(229, 196, 105, 0.16);
          border-color: rgba(229, 196, 105, 0.5);
        }
        #ui button:focus-visible { outline: 2px solid #e5c469; outline-offset: 2px; }
        #ui .cost {
          margin-left: 6px; white-space: nowrap;
          font-size: 11.5px; color: #b6b3a6;
          font-variant-numeric: tabular-nums;
        }
        #ui .cost svg { margin-left: 4px; vertical-align: -1px; }

        .hud-resources {
          position: absolute; top: 12px; left: 12px; right: 240px;
          display: flex; justify-content: center; pointer-events: none;
        }
        .hud-resources > div {
          pointer-events: auto; max-width: 100%;
          display: flex; flex-wrap: wrap; justify-content: center; align-items: center; gap: 2px;
          padding: 5px 8px; border-radius: 12px;
        }
        .hud-resources span.res {
          display: inline-flex; align-items: center; gap: 6px;
          padding: 3px 9px; border-radius: 8px;
          font-size: 13.5px; font-weight: 500; color: #e9e6dd;
          font-variant-numeric: tabular-nums;
          opacity: 0.35;
        }
        .hud-resources span.res:hover { background: rgba(255, 255, 255, 0.06); }
        .hud-resources span.res.has { opacity: 1; }
        .research-chip {
          position: relative; overflow: hidden;
          margin-left: 6px; padding: 3px 11px !important;
          font-size: 12px; border-radius: 8px !important;
        }
        .research-chip .fill {
          position: absolute; inset: 0 auto 0 0;
          background: rgba(229, 196, 105, 0.28);
          transition: width 0.4s;
        }
        .research-chip .label { position: relative; }

        .hud-nettrouble {
          position: absolute;
          top: 70px;
          left: 50%;
          transform: translateX(-50%);
          padding: 8px 18px;
          color: #e8b7a0;
          z-index: 12;
        }
        #ui .net-chip {
          font-size: 12px;
          color: #9fae9a;
          padding: 0 8px;
          align-self: center;
        }
        .hud-speed {
          position: absolute; top: 12px; right: 12px;
          display: flex; align-items: center; gap: 4px;
          padding: 5px 6px; border-radius: 12px; pointer-events: auto;
        }
        #ui .hud-speed button {
          background: transparent; border: none; border-radius: 8px;
          color: #cfccc2; font-size: 12px; padding: 5px 11px;
        }
        #ui .hud-speed button:hover:not(:disabled) { background: rgba(255, 255, 255, 0.08); color: #f0ede4; border: none; }
        #ui .hud-speed button.icon { width: 30px; height: 26px; padding: 0; display: grid; place-items: center; }
        #ui .hud-speed button.active { background: #e5c469; color: #0e100f; border: none; }
        #ui .hud-speed .div { width: 1px; height: 16px; margin: 0 2px; background: rgba(255, 255, 255, 0.12); }

        .hud-menu {
          position: absolute; top: 52px; right: 12px; width: 200px;
          display: flex; flex-direction: column; gap: 6px;
          padding: 10px 12px; pointer-events: auto;
        }
        .hud-menu .menu-head {
          display: flex; justify-content: space-between; align-items: center;
          margin-bottom: 2px; font-weight: 600; color: #f0ede4;
        }
        .hud-menu .menu-close { min-width: 0; padding: 2px 8px; }

        .hud-bottom {
          position: absolute; left: 12px; right: 12px; bottom: 12px;
          display: flex; align-items: flex-end; gap: 10px; pointer-events: none;
        }
        .hud-build {
          pointer-events: auto; flex: 0 1 auto; min-width: 0;
          display: flex; flex-direction: column; gap: 8px; padding: 10px;
        }
        .hud-tabs {
          display: flex; gap: 2px; padding: 3px; align-self: flex-start;
          background: rgba(0, 0, 0, 0.35); border-radius: 9px;
        }
        #ui .hud-tabs button {
          padding: 4px 14px; font-size: 12px; font-weight: 600; letter-spacing: 0.04em;
          color: #a3a099; background: transparent; border: none; border-radius: 7px;
        }
        #ui .hud-tabs button:hover:not(.active) { color: #f0ede4; background: transparent; border: none; }
        #ui .hud-tabs button.active { background: #e5c469; color: #0e100f; }
        .hud-items {
          display: flex; flex-wrap: wrap; gap: 6px;
          align-items: flex-start; align-content: flex-start;
          min-width: 0; min-height: 72px;
        }

        .hud-selection {
          pointer-events: auto; flex: 0 1 auto; min-width: 0; margin-left: auto;
          max-width: 430px; padding: 12px 14px;
        }
        .hud-debug {
          position: absolute; top: 56px; right: 12px; width: 380px; max-height: 60vh;
          overflow: auto; padding: 8px 10px; pointer-events: auto;
          font-family: ui-monospace, monospace; font-size: 11px;
        }
        .hud-debug table { width: 100%; border-collapse: collapse; }
        .hud-debug td, .hud-debug th { padding: 1px 4px; text-align: left; }
        .hud-violations {
          position: absolute; top: 56px; left: 50%; transform: translateX(-50%);
          padding: 6px 14px; pointer-events: auto;
          border-color: rgba(214, 106, 80, 0.5); color: #f0b9a8; max-width: 70vw;
        }
        .hud-festival { position: absolute; top: 56px; right: 12px; padding: 6px 12px; pointer-events: auto; }
        .hud-toasts {
          position: absolute; top: 96px; right: 12px; display: flex;
          flex-direction: column; gap: 6px; align-items: flex-end;
        }
        .toast { padding: 7px 13px; pointer-events: auto; }
        .hud-end {
          position: absolute; inset: 0; display: grid; place-items: center;
          background: rgba(8, 10, 8, 0.6); pointer-events: auto;
        }
        .end-card { padding: 30px 44px; text-align: center; }
        .end-card h1 {
          margin: 0 0 8px; font-size: 26px; font-weight: 600; color: #e5c469;
        }
        .end-card button { margin-top: 12px; padding: 8px 24px; font-size: 14px; }

        /* ——— Progressive layer ———
           One HUD, adapting to what the device can do. Desktop keeps
           everything above; these rules only add. */

        /* Touch pointers can't hit a 28px chip: grow every target to the
           44px guideline. Applies to tablets too, at any width. */
        @media (pointer: coarse) {
          #ui button { padding: 11px 15px; min-height: 44px; }
          #ui .hud-speed button { padding: 9px 14px; min-height: 44px; }
          #ui .hud-speed button.icon { width: 46px; height: 44px; }
          #ui .hud-tabs button { padding: 9px 18px; min-height: 40px; }
          #ui .menu-close, #ui .tech-close { min-height: 36px; padding: 4px 12px; }
          .hud-resources span.res { padding: 7px 10px; }
          /* Hover styling is meaningless without a hover cursor and just
             leaves buttons stuck in the hover state after a tap. */
          #ui button:hover:not(:disabled) {
            background: rgba(255, 255, 255, 0.06);
            border-color: rgba(255, 255, 255, 0.14);
          }
          #ui .hud-tabs button.active { background: #e5c469; color: #0e100f; }
          #ui .hud-speed button.active { background: #e5c469; color: #0e100f; }
          #ui button.active {
            background: rgba(229, 196, 105, 0.16);
            border-color: rgba(229, 196, 105, 0.5);
          }
        }

        /* Phone-width: the two top strips can't share a row, and the two
           bottom cards can't sit side by side. Stack them, and let the
           long lists scroll instead of growing over the map. */
        @media (max-width: 760px) {
          .hud-nettrouble {
          position: absolute;
          top: 70px;
          left: 50%;
          transform: translateX(-50%);
          padding: 8px 18px;
          color: #e8b7a0;
          z-index: 12;
        }
        #ui .net-chip {
          font-size: 12px;
          color: #9fae9a;
          padding: 0 8px;
          align-self: center;
        }
        .hud-speed {
            top: calc(10px + env(safe-area-inset-top));
            right: calc(10px + env(safe-area-inset-right));
          }
          .hud-resources {
            top: calc(66px + env(safe-area-inset-top));
            left: calc(10px + env(safe-area-inset-left));
            right: calc(10px + env(safe-area-inset-right));
            justify-content: flex-start;
          }
          /* Full width now, so the goods wrap onto a second row instead of
             running off the edge — nothing is hidden and there's no
             invisible scroll to discover. */
          .hud-resources > div {
            width: 100%;
            flex-wrap: wrap;
            justify-content: flex-start;
            row-gap: 2px;
          }
          .hud-resources span.res { flex: 0 0 auto; padding: 4px 8px; font-size: 13px; }

          .hud-bottom {
            left: calc(10px + env(safe-area-inset-left));
            right: calc(10px + env(safe-area-inset-right));
            bottom: calc(10px + env(safe-area-inset-bottom));
            flex-direction: column;
            align-items: stretch;
            gap: 8px;
          }
          .hud-selection { margin-left: 0; max-width: none; }
          .hud-build .hud-items {
            min-height: 0;
            max-height: 26vh;
            overflow-y: auto;
            touch-action: pan-y;
            overscroll-behavior: contain;
            -webkit-overflow-scrolling: touch;
          }
          .hud-menu {
            top: calc(66px + env(safe-area-inset-top));
            right: calc(10px + env(safe-area-inset-right));
          }
          /* .tech-panel's phone layout lives in TechTreePanel's own <style>:
             that component renders later, so rules here lost the tie and
             a stale max-height silently capped the sheet. */
          .hud-toasts {
            top: calc(120px + env(safe-area-inset-top));
            right: calc(10px + env(safe-area-inset-right));
          }
          .hud-debug { display: none; } /* desktop-only diagnostics */
        }

        /* Landscape phones are short: keep the bottom cards side by side
           and cap their height so the map stays visible. */
        @media (max-width: 900px) and (max-height: 480px) {
          .hud-bottom { flex-direction: row; align-items: flex-end; }
          .hud-selection { max-width: 50%; }
          .hud-build .hud-items { max-height: 20vh; }
        }
      `}</style>

      <div class="hud-resources">
        <div class="panel">
          <For each={[...GOODS]}>
            {(good) => (
              <span
                class="res"
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
      </div>

      <div class="hud-speed panel">
        <button
          classList={{ active: menuOpen() }}
          {...tooltip(() => <TextTip title="Menu" body="Save and load the village." />)}
          onClick={() => setMenuOpen(!menuOpen())}
        >
          ☰
        </button>
        <Show when={netMode() && netStatus()?.state === 'ok'}>
          <span
            class="net-chip"
            {...tooltip(() => (
              <TextTip title="Connection" body="Round-trip to the relay and prediction lead." />
            ))}
          >
            {'⇄ ' + String((netStatus() as { rttMs: number }).rttMs) + 'ms'}
          </span>
        </Show>
        <Show when={!netMode()}>
          <span class="div"></span>
          <For each={SPEEDS}>
            {(s) => (
              <button
                class="icon"
                classList={{ active: speed() === s.value }}
                {...tooltip(() => <TextTip title={s.label} body={s.hint} />)}
                onClick={() => props.onSpeed(s.value)}
              >
                <s.icon />
              </button>
            )}
          </For>
        </Show>
      </div>

      <Show when={menuOpen()}>
        <div class="hud-menu panel">
          <div class="menu-head">
            <span>Menu</span>
            <button class="menu-close" onClick={() => setMenuOpen(false)}>
              ✕
            </button>
          </div>
          <Show when={!netMode()}>
            <button
              onClick={() => {
                props.onSave();
                setMenuOpen(false);
              }}
            >
              Save village
            </button>
          </Show>
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

      <div class="hud-bottom">
        <div class="hud-build panel">
          <div class="hud-tabs">
            <For each={BUILD_GROUPS}>
              {(group, i) => (
                <button classList={{ active: activeTab() === i() }} onClick={() => setActiveTab(i())}>
                  {group.label}
                </button>
              )}
            </For>
          </div>
          <div class="hud-items">
            <For each={BUILD_GROUPS[activeTab()]!.types}>
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
                              <GoodIcon good={good} size={11} />
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
          </div>
        </div>

        <SelectionPanel onTrain={props.onTrain} onHire={props.onHire} />
      </div>

      <Show when={techPanelOpen()}>
        <TechTreePanel onResearch={props.onResearch} />
      </Show>

      <Show when={techs().festivalTicksLeft > 0}>
        <div class="hud-festival panel">Festival! Everyone works faster</div>
      </Show>

      <div class="hud-toasts">
        <For each={toasts()}>{(t) => <div class="panel toast">{t.text}</div>}</For>
      </div>

      <Show when={netMode() && netStatus()?.state === 'disconnected'}>
        <div class="hud-nettrouble panel">Connection to the server lost. Reconnecting…</div>
      </Show>

      <Show when={outcome().state === 'over'}>
        <div class="hud-end">
          <div class="panel end-card">
            <h1>{won() ? 'Victory' : 'Defeat'}</h1>
            <p>
              {won()
                ? soloMode()
                  ? 'The bandit camp lies in ruins. The valley is yours.'
                  : 'The last rival banner has fallen. The valley is yours.'
                : 'The storehouse has fallen. The village scatters to the winds.'}
            </p>
            <button
              onClick={() => {
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
        <div class="hud-violations panel">
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
