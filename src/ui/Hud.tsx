import { For, Show, createSignal, onCleanup } from 'solid-js';
import { GOODS, type GoodId } from '../sim/defs/goods';
import { BUILDING_DEFS, type BuildingTypeId } from '../sim/defs/buildings';
import type { TechId } from '../sim/defs/techs';
import type { UnitTypeId } from '../sim/defs/units';
import type { AdminAction } from '../sim/commands';
import { clearSeatStash } from '../net/lobbyClient';
import { TechTreePanel } from './TechTreePanel';
import { SelectionPanel } from './SelectionPanel';
import { AdminPanel } from './AdminPanel';
import { MissionPanel, continueTarget } from './MissionPanel';
import {
  FastIcon,
  FastestIcon,
  GoodIcon,
  LockIcon,
  PauseIcon,
  PlayIcon,
  BandIcon,
  MalletIcon,
  PopIcon,
  SwordsIcon,
} from './icons';
import { BuildingTip, GoodTip, TextTip, TipWrap, TooltipLayer, tooltip } from './tooltip';
import { buildingName, techName } from './names';
import { BUILD_GROUPS } from './buildMenu';
import { hasKeyboard } from '../input/keyboard';
import { fullscreen } from './fullscreen';
import {
  CHEATS_ALLOWED,
  bandArm,
  debugJobs,
  debugOpen,
  invariantViolations,
  llmStatus,
  mission,
  myPlayerId,
  netMode,
  dismissToast,
  netStatus,
  openPanel,
  outcome,
  placing,
  playersMeta,
  population,
  replayMode,
  replayOver,
  selection,
  setBandArm,
  setOpenPanel,
  setTechPanelOpen,
  speed,
  stock,
  techPanelOpen,
  techs,
  toasts,
} from './store';

/** Reactive media query (no dependency; one listener per call site). */
function useMedia(query: string): () => boolean {
  const mq = window.matchMedia(query);
  const [matches, setMatches] = createSignal(mq.matches);
  const onChange = (e: MediaQueryListEvent): void => {
    setMatches(e.matches);
  };
  mq.addEventListener('change', onChange);
  onCleanup(() => mq.removeEventListener('change', onChange));
  return matches;
}

const SPEEDS = [
  { value: 0, icon: PauseIcon, label: 'Pause', hint: 'Orders you give still queue up.' },
  { value: 1, icon: PlayIcon, label: 'Normal speed', hint: undefined as string | undefined },
  { value: 3, icon: FastIcon, label: 'Fast forward', hint: 'Runs the village at 3× speed.' },
];

/** Replays get one speed beyond the live game's fastest: nobody is issuing
 * orders, so there is no reaction time to protect. */
const REPLAY_SPEED = {
  value: 8,
  icon: FastestIcon,
  label: 'Full gallop',
  hint: 'Replay only — runs the recording at 8× speed.',
};

export function Hud(props: {
  onSpeed: (speed: number) => void;
  onPlace: (type: BuildingTypeId | null) => void;
  onHire: () => void;
  onResearch: (tech: TechId) => void;
  onTrain: (buildingId: number, unit: UnitTypeId) => void;
  onCancelTrain: (buildingId: number, index: number, unit: UnitTypeId) => void;
  onSave: () => void;
  onSaveReplay: () => void;
  onAdmin: (action: AdminAction) => void;
  onFocus: (x: number, y: number) => void;
  onSelectArmy: () => void;
  onDeselect: () => void;
  onDismiss: (buildingId: number) => void;
  onSell: (buildingId: number) => void;
  onTogglePause: (buildingId: number, paused: boolean) => void;
  onSetRecipe: (buildingId: number, index: number) => void;
}) {
  // The sim rejects admin commands in a match (world.admin.enabled is
  // false), so every button here no-ops — except the fog toggle, which
  // never reaches the sim. Hide the panel rather than leave that one live.
  const adminMode = CHEATS_ALLOWED && new URLSearchParams(location.search).has('admin');
  // Mid-match, the menu is the only place to ask. The browser will not take
  // the request from anywhere but a gesture, and this button is one.
  const fs = fullscreen();
  const [activeTab, setActiveTab] = createSignal(0);
  const isPhone = useMedia('(max-width: 760px)');
  const isCoarse = useMedia('(pointer: coarse)');
  // A mouse or trackpad — the thing that makes a drag draw a selection
  // band instead of panning the camera (controls.ts hands plain touch
  // drags to the rig). Not the same question as "is there a keyboard":
  // an iPad on a Folio, or any tablet with a Bluetooth keyboard, types
  // without ever gaining a pointer.
  const hasFinePointer = useMedia('(any-pointer: fine)');
  // Phones start with the build card folded to a pill; arming a placement
  // folds it again so the map is visible while you aim the ghost.
  const [buildOpen, setBuildOpen] = createSignal(false);
  const buildVisible = (): boolean => !isPhone() || buildOpen();
  const place = (type: BuildingTypeId | null): void => {
    props.onPlace(type);
    if (type !== null && isPhone()) setBuildOpen(false);
  };
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
    if (req === undefined) return true;
    const researched = techs().researched;
    return Array.isArray(req) ? req.some((t) => researched.includes(t)) : researched.includes(req);
  };
  const soloMode = (): boolean => playersMeta().length <= 1;
  /** The strategist badge's one line, or null for no badge. Discriminates
   * on state: only loading and ready have anything to show — a failure is
   * a one-time toast, not a standing shrug. */
  const llmBadge = (): string | null => {
    const s = llmStatus();
    if (s?.state === 'loading') return `Strategist: downloading ${s.pct}%`;
    if (s?.state === 'ready') return 'Strategist: on';
    return null;
  };
  /** The speed strip: replays add one gear past the live game's fastest. */
  const speeds = (): typeof SPEEDS => (replayMode() ? [...SPEEDS, REPLAY_SPEED] : SPEEDS);
  /** This seat has fallen while the match plays on (multiplayer). */
  const eliminated = (): boolean =>
    outcome().state === 'playing' && playersMeta()[myPlayerId()]?.alive === false;
  const [spectating, setSpectating] = createSignal(false);
  /** The outcome card was waved away to watch the world play on. */
  const [observing, setObserving] = createSignal(false);
  const won = (): boolean => {
    const o = outcome();
    return o.state === 'over' && o.winner === myPlayerId();
  };
  /**
   * The one end-of-match card on screen. These states can genuinely overlap
   * — a tab that watched the storehouse fall and then slept past the room's
   * grace period is both 'over' and 'gone' — and each card is a full-screen
   * band, so without a strict order they stack into a double dialog. The
   * decided match outranks transport news: "Defeat" is the story, a swept
   * room is plumbing.
   */
  const endCard = (): 'outcome' | 'gone' | 'eliminated' | 'replayOver' | undefined => {
    // A replay's outcome was decided when it was recorded; the only card
    // playback owes is the one that says the recording has run out.
    if (replayMode()) return replayOver() ? 'replayOver' : undefined;
    if (outcome().state === 'over') return observing() ? undefined : 'outcome';
    if (netMode() && netStatus()?.state === 'gone') return 'gone';
    if (eliminated() && !spectating()) return 'eliminated';
    return undefined;
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
        /* Selected must beat hovered. The hover rule above outranks a
           bare .active (its :not() counts toward specificity), which
           left a clicked button showing plain hover styling — invisible
           right when the player clicks. The twin selector restates the
           choice with :hover attached, which is strictly more specific
           than the hover rule itself, so it wins wherever either sits
           in the sheet. The solid border keeps "chosen" readable next
           to "merely under the cursor". */
        #ui button.active,
        #ui button.active:hover:not(:disabled) {
          background: rgba(229, 196, 105, 0.3);
          border-color: #e5c469;
        }
        #ui button:focus-visible { outline: 2px solid #e5c469; outline-offset: 2px; }
        #ui .cost {
          margin-left: 6px; white-space: nowrap;
          font-size: 11.5px; color: #b6b3a6;
          font-variant-numeric: tabular-nums;
        }
        #ui .cost svg { margin-left: 4px; vertical-align: -1px; }

        /* ——— Layer order ———
           #ui is position:fixed, so everything below shares one stacking
           context and anything that overlaps needs a number here rather
           than a lucky spot in the DOM.
             (auto) the HUD proper: top strips, build card, selection card
             11     floating touch actions, over the map
             19/20  the tech sheet's scrim and the sheet itself — modal
             30     notices that outrank an open sheet: net trouble
             35     end-of-match cards, which outrank everything but the two
                    layers that must land on them: toasts and tips
             36     toasts — "Replay saved" answers a button on an end card,
                    so it has to read over the card's scrim
             40     tooltips (see tooltip.tsx) */

        /* Wrapper for the two top strips: invisible on desktop (children
           keep their absolute spots), a flow column on phones so they can
           stack in either order without measuring each other. */
        .hud-top { position: absolute; inset: 0; pointer-events: none; }

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
        /* Heads and beds. Ruled off from the goods because it is not one —
           it is the ceiling everything else is spent under. */
        .hud-resources span.res.pop {
          margin-left: 6px; padding-left: 13px;
          border-left: 1px solid rgba(255, 255, 255, 0.14);
          color: #c8c4b5;
        }
        .hud-resources span.res.pop.full { color: #e5c469; }
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
          z-index: 30;
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

        /* Floating touch actions: marquee select + grab-the-army. Fixed to
           the right edge over the map — the one part of a phone screen the
           HUD hasn't claimed. Hidden entirely on fine pointers. */
        .hud-touch {
          position: fixed;
          right: calc(10px + env(safe-area-inset-right));
          bottom: 38vh;
          display: flex; flex-direction: column; gap: 8px;
          pointer-events: auto; z-index: 11;
        }
        #ui .hud-touch button {
          width: 52px; height: 52px; padding: 0;
          border-radius: 14px; font-size: 20px;
          display: grid; place-items: center;
          background: rgba(14, 16, 15, 0.72);
          -webkit-backdrop-filter: blur(14px); backdrop-filter: blur(14px);
        }
        /* The :hover twin outlives a tap: touch leaves the button stuck
           in :hover, and the coarse-pointer hover neutralizer would
           otherwise strip the armed state right as it is switched on. */
        #ui .hud-touch button.active,
        #ui .hud-touch button.active:hover {
          background: rgba(229, 196, 105, 0.35);
          border-color: #e5c469;
        }
        .hud-build-pill {
          pointer-events: auto; align-self: flex-start;
          padding: 10px 16px; font-weight: 600;
        }
        /* Placement is a mode, and a mode with no way out is a trap. A
           mouse leaves it with Esc or a right click; a finger has neither,
           so until this bar the only exit was finding somewhere the
           building actually fits — impossible for a mine with no mountain
           in sight. Touch pointers only: the desktop already has two. */
        .hud-placing {
          pointer-events: auto; min-width: 0;
          display: flex; align-items: center; gap: 10px;
          padding: 6px 6px 6px 14px;
        }
        .hud-placing .what {
          flex: 1 1 auto; min-width: 0;
          display: flex; align-items: center; gap: 8px;
          overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
        }
        .hud-placing .what b { color: #e5c469; font-weight: 600; }
        #ui .hud-placing .cancel { flex: 0 0 auto; }
        #ui .build-fold {
          margin-left: auto; min-height: 0;
          padding: 4px 12px; background: transparent; border: none; color: #a3a099;
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
        /* The LLM strategist's little health line: download progress while
           the model fetches, a short-lived "on" once it answers. Left side,
           clear of the festival banner and the toasts on the right. */
        .hud-llm { position: absolute; top: 56px; left: 12px; padding: 6px 12px; opacity: 0.85; }
        .hud-toasts {
          position: absolute; top: 96px; right: 12px; display: flex;
          flex-direction: column; gap: 6px; align-items: flex-end;
          z-index: 36;
        }
        .toast { padding: 7px 13px; pointer-events: auto; }
        /* A toast that knows a place: click pans the camera there. */
        #ui .toast.clickable { cursor: pointer; border-color: rgba(214, 106, 80, 0.55); }
        #ui .toast.clickable:hover { border-color: rgba(214, 106, 80, 0.9); }
        .hud-end {
          position: absolute; inset: 0; display: grid; place-items: center;
          background: rgba(8, 10, 8, 0.6); pointer-events: auto;
          /* The match is over: nothing on the HUD, open sheet included,
             may sit on top of the card that says so. */
          z-index: 35;
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
          /* The :hover twin is what makes this stick: a tap leaves the
             button in :hover, and the neutralizer above outranks a bare
             .active — without the pair, a picked forge weapon never
             showed as selected on a touchscreen. */
          #ui button.active,
          #ui button.active:hover:not(:disabled) {
            background: rgba(229, 196, 105, 0.3);
            border-color: #e5c469;
          }
        }

        /* Phone-width: the two top strips can't share a row, and the two
           bottom cards can't sit side by side. Stack them, and let the
           long lists scroll instead of growing over the map. */
        @media (max-width: 760px) {
          /* Resources first, speed under them — goods are what you glance
             at, and flow order means a wrapping strip can never overlap the
             pill. Children go static inside the flex column. */
          .hud-top {
            display: flex; flex-direction: column; gap: 8px;
            inset: auto;
            top: calc(10px + env(safe-area-inset-top));
            left: calc(10px + env(safe-area-inset-left));
            right: calc(10px + env(safe-area-inset-right));
          }
          .hud-speed {
            position: static;
            align-self: flex-end;
          }
          .hud-resources {
            position: static;
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
          /* The fold ✕ sits at the row's end, so the tab strip stretches. */
          .hud-tabs { align-self: stretch; }
          .hud-build .hud-items {
            min-height: 0;
            max-height: 26vh;
            overflow-y: auto;
            touch-action: pan-y;
            overscroll-behavior: contain;
            -webkit-overflow-scrolling: touch;
          }
          .hud-menu {
            top: calc(120px + env(safe-area-inset-top));
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

      <div class="hud-top">
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
          <span
            class="res pop has"
            classList={{ full: population().pop >= population().cap }}
            {...tooltip(() => (
              <TextTip
                title="Population"
                body={
                  population().pop >= population().cap
                    ? 'Every bed is taken — build a house before you hire again. Workers and soldiers are counted too: each one was a serf.'
                    : 'Everyone you own: idle serfs, the workers inside your buildings, and your soldiers. The castle sleeps 10; each house adds 10 more.'
                }
              />
            ))}
          >
            <PopIcon /> {population().pop}/{population().cap}
          </span>
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
          {...tooltip(() => <TextTip title="Menu" body="Save, load, or leave the village." />)}
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
          <Show when={replayMode()}>
            <span
              class="net-chip"
              {...tooltip(() => (
                <TextTip title="Replay" body="Watching a recording — orders have no effect." />
              ))}
            >
              Replay
            </span>
          </Show>
          <Show
            when={isPhone()}
            fallback={
              <For each={speeds()}>
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
            }
          >
            {/* One thumb, one button: each tap steps play -> fast -> pause.
                The icon shows the state you are in, gold when time is not
                running normally. */}
            <button
              class="icon"
              classList={{ active: speed() !== 1 }}
              {...tooltip(() => (
                <TextTip
                  title={speeds().find((s) => s.value === speed())?.label ?? 'Speed'}
                  body="Taps cycle play, fast forward, pause."
                />
              ))}
              onClick={() => {
                const order = replayMode() ? [1, 3, REPLAY_SPEED.value, 0] : [1, 3, 0];
                const next = order[(order.indexOf(speed()) + 1) % order.length]!;
                props.onSpeed(next);
              }}
            >
              {(() => {
                const s = speeds().find((x) => x.value === speed()) ?? SPEEDS[1]!;
                return <s.icon />;
              })()}
            </button>
          </Show>
        </Show>
      </div>
      </div>

      <Show when={menuOpen()}>
        <div class="hud-menu panel">
          <div class="menu-head">
            <span>Menu</span>
            <button class="menu-close" onClick={() => setMenuOpen(false)}>
              ✕
            </button>
          </div>
          <Show when={!netMode() && !replayMode()}>
            <button
              onClick={() => {
                props.onSave();
                setMenuOpen(false);
              }}
            >
              Save village
            </button>
          </Show>
          {/* Only once the match is decided — the recorders refuse before
              that anyway (a replay is a finished game's record). Here for
              the player who chose Observe and outlived the end card. */}
          <Show when={!netMode() && !replayMode() && outcome().state === 'over'}>
            <button
              onClick={() => {
                props.onSaveReplay();
                setMenuOpen(false);
              }}
            >
              Save replay
            </button>
          </Show>
          <Show when={!netMode() && !replayMode()}>
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
          </Show>
          <Show when={fs.supported}>
            <button
              aria-pressed={fs.active()}
              onClick={() => {
                fs.toggle();
                setMenuOpen(false);
              }}
            >
              {fs.active() ? 'Exit full screen' : 'Full screen'}
            </button>
          </Show>
          <button
            onClick={() => {
              // In a match the world lives on (solo: gone unless saved;
              // multiplayer: the room plays on and the seat token can
              // rejoin) — but the player is leaving either way, so ask.
              if (confirm('Leave the match and return to the menu?')) {
                location.href = location.pathname;
              }
            }}
          >
            Quit to menu
          </button>
        </div>
      </Show>

      <div class="hud-bottom">
        <Show when={isCoarse() || isPhone()}>
          <div class="hud-touch">
            {/* The lasso is the only way to band-select without a pointer
                that drags one: bandArm() is what tells Controls to draw a
                band rather than let the camera have the drag, and this
                button is its only writer. So it retires for a mouse or
                trackpad — never for a keyboard, which types but cannot
                drag. */}
            <Show when={!hasFinePointer()}>
              <button
                classList={{ active: bandArm() }}
                {...tooltip(() => (
                  <TextTip
                    title="Band select"
                    body="Arm it, then drag a box over your people. The camera holds still for that one drag."
                  />
                ))}
                onClick={() => setBandArm(!bandArm())}
              >
                <BandIcon />
              </button>
            </Show>
            <button
              {...tooltip(() => (
                <TextTip title="Muster the army" body="Selects every soldier you own, wherever they are." />
              ))}
              onClick={() => props.onSelectArmy()}
            >
              <SwordsIcon />
            </button>
            {/* This one really does answer to the keyboard: Esc clears the
                selection, and every hardware keyboard has one. */}
            <Show when={selection().size > 0 && !hasKeyboard()}>
              <button
                {...tooltip(() => (
                  <TextTip
                    title="Deselect"
                    body="Lets the current selection go — taps stop being move orders."
                  />
                ))}
                onClick={() => props.onDeselect()}
              >
                ✕
              </button>
            </Show>
          </div>
        </Show>

        <Show when={(isCoarse() || isPhone()) && !replayMode() && placing()}>
          {(type) => (
            <div class="hud-placing panel">
              <span class="what">
                <MalletIcon /> Tap the map to place <b>{buildingName(type())}</b>
              </span>
              <button class="cancel" onClick={() => place(null)}>
                ✕ Cancel{hasKeyboard() ? ' (Esc)' : ''}
              </button>
            </div>
          )}
        </Show>

        {/* A replay takes no orders, so it offers no build card: the map
            and the goods strip are the whole story. */}
        <Show
          when={buildVisible() && !replayMode()}
          fallback={
            <Show when={!replayMode()}>
              <button class="hud-build-pill panel" onClick={() => setBuildOpen(true)}>
                <MalletIcon /> Build
                <Show when={placing()}>{(t) => <span class="cost">{buildingName(t())}…</span>}</Show>
              </button>
            </Show>
          }
        >
          <div class="hud-build panel">
            <div class="hud-tabs">
              <For each={BUILD_GROUPS}>
                {(group, i) => (
                  <button classList={{ active: activeTab() === i() }} onClick={() => setActiveTab(i())}>
                    {group.label}
                  </button>
                )}
              </For>
              <Show when={isPhone()}>
                <button class="build-fold" onClick={() => setBuildOpen(false)}>
                  ✕
                </button>
              </Show>
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
                        onClick={() => place(placing() === type ? null : type)}
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
        </Show>

        <SelectionPanel
          onTrain={props.onTrain}
          onCancelTrain={props.onCancelTrain}
          onHire={props.onHire}
          onDeselect={props.onDeselect}
          onDismiss={props.onDismiss}
          onSell={props.onSell}
          onTogglePause={props.onTogglePause}
          onSetRecipe={props.onSetRecipe}
        />
      </div>

      <Show when={techPanelOpen()}>
        <TechTreePanel onResearch={props.onResearch} />
      </Show>

      <MissionPanel onSpeed={props.onSpeed} />

      <Show when={techs().festivalTicksLeft > 0}>
        <div class="hud-festival panel">Festival! Everyone works faster</div>
      </Show>

      <Show when={llmBadge()}>{(text) => <div class="hud-llm panel">{text()}</div>}</Show>

      <div class="hud-toasts">
        <For each={toasts()}>
          {(t) => (
            <div
              class="panel toast"
              classList={{ clickable: !!t.focus }}
              onClick={() => {
                if (!t.focus) return;
                props.onFocus(t.focus.x, t.focus.y);
                dismissToast(t.id);
              }}
            >
              {t.text}
            </div>
          )}
        </For>
      </div>

      <Show when={netMode() && netStatus()?.state === 'disconnected'}>
        <div class="hud-nettrouble panel">
          Connection to the server lost. Reconnecting… — your seat is held,
          and the match rides out even a server restart.
        </div>
      </Show>

      <Show when={endCard() === 'gone'}>
        <div class="hud-end">
          <div class="panel end-card">
            <h1>The match is gone</h1>
            <p>
              The server no longer knows this match. A room stands for a few
              minutes after its last player leaves, then winds down — and
              this one wound down. It can't be resumed.
            </p>
            <button onClick={() => (location.href = location.pathname)}>Back to the menu</button>
          </div>
        </div>
      </Show>

      <Show when={endCard() === 'eliminated'}>
        <div class="hud-end">
          <div class="panel end-card">
            <h1>Defeat</h1>
            <p>
              Your castle has fallen and the village scatters — but the battle
              for the valley rages on without you.
            </p>
            <button onClick={() => setSpectating(true)}>Watch the rest</button>
            <button
              onClick={() => {
                if (confirm('Leave the match and return to the menu?')) {
                  location.href = location.pathname;
                }
              }}
            >
              Quit to menu
            </button>
          </div>
        </div>
      </Show>

      <Show when={endCard() === 'outcome'}>
        <div class="hud-end">
          <div class="panel end-card">
            <h1>{won() ? 'Victory' : 'Defeat'}</h1>
            <p>
              {won()
                ? mission()
                  ? 'The commission is fulfilled. The crown takes note, reeve.'
                  : soloMode()
                    ? 'The bandit camp lies in ruins. The valley is yours.'
                    : 'The last rival banner has fallen. The valley is yours.'
                : 'The storehouse has fallen. The village scatters to the winds.'}
            </p>
            <Show when={won() ? continueTarget() : undefined}>
              {(next) => (
                <button
                  onClick={() => {
                    sessionStorage.removeItem('serf-load-pending');
                    // The same navigation launch() uses: a fresh page, the
                    // next mission's recipe in the query string.
                    location.search = `?mission=${next().id}`;
                  }}
                >
                  Continue: {next().title}
                </button>
              )}
            </Show>
            <button
              onClick={() => {
                sessionStorage.removeItem('serf-load-pending');
                if (netMode()) {
                  // A bare reload rejoins the finished room by seat token
                  // and lands right back on this screen. Drop the seat and
                  // host a fresh council instead.
                  clearSeatStash();
                  location.href = `${location.pathname}?mp=new`;
                } else {
                  location.reload();
                }
              }}
            >
              Play again
            </button>
            {/* The decision is made, but the valley plays on behind this
                card — waving it away watches the rest unfold. Solo only:
                a multiplayer loss already has its own spectator path, and
                a won room is winding down. */}
            <Show when={!netMode()}>
              <button onClick={() => setObserving(true)}>Observe the rest</button>
            </Show>
            {/* The recording runs from boot to this moment; saving names
                it by the clock and files it for the menu's Replays shelf.
                Solo, the world lives on behind the card, so a later save
                (from the menu, after observing) simply records more.
                Multiplayer records on the server, which hands each seat
                its copy — but only for a decided match, which this card
                is the proof of. */}
            <button onClick={() => props.onSaveReplay()}>Save replay</button>
          </div>
        </div>
      </Show>

      <Show when={endCard() === 'replayOver'}>
        <div class="hud-end">
          <div class="panel end-card">
            <h1>Replay over</h1>
            <p>The recording ends here.</p>
            <button onClick={() => location.reload()}>Watch again</button>
            <button onClick={() => (location.href = location.pathname)}>Back to the menu</button>
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
