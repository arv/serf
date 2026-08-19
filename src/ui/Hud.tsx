import { For, Show, createEffect, createSignal } from 'solid-js';
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
  EyeIcon,
  EyeOffIcon,
  FastIcon,
  FastestIcon,
  GoodIcon,
  LockIcon,
  PauseIcon,
  PlayIcon,
  BandIcon,
  MalletIcon,
  PopIcon,
  SpeakerIcon,
  SpeakerOffIcon,
  SwordsIcon,
} from './icons';
import { BuildingTip, GoodTip, TextTip, TipWrap, TooltipLayer, tooltip } from './tooltip';
import { buildingName, techName } from './names';
import { BUILD_GROUPS, buildAffordable, buildKey, buildUnlocked } from './buildMenu';
import { Key } from './shortcut';
import { hasKeyboard } from '../input/keyboard';
import { COMPACT, NARROW, SHORT, useMedia } from './breakpoints';
import { fullscreen } from './fullscreen';
import { goto } from '../app/router';
import { latestSaveName } from '../app/saveStore';
import { describeAdvice } from '../ai/insight';
import {
  CHEATS_ALLOWED,
  bandArm,
  buildChord,
  debugJobs,
  debugOpen,
  fogEnabled,
  invariantViolations,
  llmStatus,
  llmTraces,
  mission,
  muted,
  myPlayerId,
  netMode,
  dismissToast,
  netStatus,
  openPanel,
  outcome,
  placing,
  playersMeta,
  population,
  quitConfirm,
  replayMode,
  replayOver,
  selection,
  setBandArm,
  setFogEnabled,
  setOpenPanel,
  setQuitConfirm,
  setTechPanelOpen,
  setVolumePref,
  speed,
  stock,
  techPanelOpen,
  techs,
  toasts,
  toggleMuted,
  volume,
  type OrderMode,
} from './store';
import { play } from '../audio/audio';

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
  onArmOrder: (mode: OrderMode | null) => void;
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
  onRepair: (buildingId: number, repair: boolean) => void;
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
  /**
   * Small screen, either way up — the question every collapsible part
   * of the HUD actually wants answered. It used to be `(max-width:
   * 760px)`, which a phone held sideways fails: 844x390 is wide, and
   * that width bought it the desktop build card on a screen with a
   * third of the height to put one in.
   */
  const isCompact = useMedia(COMPACT);
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
  const buildVisible = (): boolean => !isCompact() || buildOpen();
  const place = (type: BuildingTypeId | null): void => {
    props.onPlace(type);
    if (type !== null && isCompact()) setBuildOpen(false);
  };
  const menuOpen = (): boolean => openPanel() === 'menu';
  /** The newest saved game, as of the last time the menu was opened: what
   * the Load button reads to know whether there is anything to load, and
   * to name it. Read on open rather than once at mount, because saving
   * from this very menu makes a new file the newest one. Deliberately not
   * cleared while the next read is in flight — the button would flicker
   * disabled every time the menu came up — so this is the last answer,
   * not necessarily the current one. The click settles that itself. */
  const [lastSave, setLastSave] = createSignal<string | null>(null);
  const setMenuOpen = (open: boolean): void => {
    setOpenPanel(open ? 'menu' : null);
    if (open) void latestSaveName().then(setLastSave);
  };
  const cost = (type: BuildingTypeId) => Object.entries(BUILDING_DEFS[type].cost) as [GoodId, number][];
  const affordable = (type: BuildingTypeId): boolean => buildAffordable(type, stock());
  const unlocked = (type: BuildingTypeId): boolean => buildUnlocked(type, techs().researched);

  // A building armed from the keyboard has to bring its tab with it: the
  // chord can reach a mine while the Food tab is showing, and a placement
  // whose button is on a tab nobody is looking at is a ghost on the map
  // with nothing on the HUD claiming it. Clicking a button lands here too
  // and changes nothing — that tab was already the open one.
  createEffect(() => {
    const type = placing();
    if (!type) return;
    const i = BUILD_GROUPS.findIndex((g) => g.types.includes(type));
    if (i >= 0) setActiveTab(i);
  });
  // Phones fold the card down to a pill, and a chord typed at a folded card
  // would arm a building with nothing on screen to show for it.
  createEffect(() => {
    if (buildChord()) setBuildOpen(true);
  });
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
  /** Each seat's newest standing pile, in English — the "where the AI
   * stands now" block above the consultation history in the debug overlay.
   * Traces run newest-first, so the first standing pile per seat wins.
   * Only the off-playbook lines: advice echoing the print changes nothing,
   * and a pile that is all echo reads "playing the playbook as printed". */
  const llmPostures = (): { playerId: number; moved: string[] }[] => {
    const out: { playerId: number; moved: string[] }[] = [];
    const seen = new Set<number>();
    for (const t of llmTraces()) {
      if (!t.standing || seen.has(t.playerId)) continue;
      seen.add(t.playerId);
      out.push({
        playerId: t.playerId,
        moved: describeAdvice(t.standing, t.knobs)
          .filter((l) => l.moved)
          .map((l) => l.text),
      });
    }
    return out.sort((a, b) => a.playerId - b.playerId);
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
  // The menu now sits above the toasts (37 > 36), which sit above the end
  // cards (36 > 35) — so no number is left that keeps a decided match's
  // card over an open menu. Close the menu instead: the card takes the
  // screen, and the ☰ button under its scrim can't reopen it while the
  // card stands. The tech sheet is untouched — it still loses to the card
  // on z-index alone.
  createEffect(() => {
    if (endCard() !== undefined && menuOpen()) setMenuOpen(false);
  });
  /** What quitting walks away from — the one line the player should weigh
   * before answering, and it differs by mode: a solo world dies with the
   * tab, a room plays on, a recording loses nothing at all. */
  const quitStakes = (): string =>
    replayMode()
      ? 'The recording stays on the menu — you can watch it again.'
      : netMode()
        ? 'The room plays on without you, and your seat is held if you come back.'
        : 'The village ends here — anything unsaved is gone.';

  return (
    <>
      <style>{`
        /* ——— Modern glass HUD ———
           Glass panels rgba(14,16,15,0.72) + blur, hairline borders,
           one gold accent #e5c469 for active states. */
        #ui { font-family: 'Space Grotesk', system-ui, sans-serif; }

        /* ——— Standing still ———
           One rule decides this layout: the HUD may re-flow when the
           player acts on it, and never when the world merely ticks
           underneath. A stock rolling over from 9 to 10, a ping coming
           back 30ms slower, a worker finally reaching its post — none
           of those may move a control the player is already reaching
           for. Three habits carry the rule:
             · every live number sits in a slot cut for its widest
               value (.num), so the digits change inside a fixed box
             · everything that comes and goes mid-match lives in a rail
               — a top-anchored column growing down into empty sky —
               rather than inside a strip whose neighbours it would
               shove sideways
             · cards that hold controls are sized by their frame, not
               by their contents, and a control that doesn't apply
               right now keeps its space rather than closing the gap. */
        #ui {
          /* One build button's cell. The ribbon is a grid of these, so
             every tab draws the same card and every button holds its
             place whatever its label turns out to say. Wide enough for
             the worst button in the game — Weaponsmith at its full
             price wants 165px, and everything else is under 142. */
          --build-col: 172px;
          --build-row: 33px;
          /* The selection card's frame. Fixed, so a status line
             growing a word doesn't drag the Sell button sideways. */
          --sel-w: 430px;
          /* How far the HUD's two strips stand off the window's edges,
             before the system's own chrome is added to it. */
          --hud-margin: 12px;
        }
        /* A number that changes while you watch it: right-aligned in a
           slot wide enough for its largest value. The digits move, the
           box doesn't, and nothing downstream of it notices. */
        #ui .num {
          display: inline-block;
          text-align: right;
          font-variant-numeric: tabular-nums;
        }

        /* ——— The three rails ———
           Everything transient — the research chip, connection
           trouble, the festival banner, toasts, the strategist's
           health line, the campaign checklist — hangs in one of three
           top-anchored columns instead of at some absolute top: of its
           own. Before this they all guessed at 56px and landed on each
           other: the mission checklist under the strategist badge, the
           festival banner under the debug table. In a rail they stack
           in flow order, an arrival pushes only what is below it, and
           the growth runs downward into the map — the one direction
           with nothing to disturb. */
        .hud-rail {
          position: absolute; top: 0;
          display: flex; flex-direction: column; gap: 6px;
          pointer-events: none;
        }
        .hud-rail > * { pointer-events: auto; }
        .hud-rail.left { left: 0; align-items: flex-start; }
        .hud-rail.center { left: 50%; transform: translateX(-50%); align-items: center; }
        /* Toasts share this rail, and they are the reason for the
           number: a notice must read over an end card's scrim. */
        .hud-rail.right { right: 0; align-items: flex-end; z-index: 36; }
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
        /* The shortcut letter, bolded in place inside its own label (see
           shortcut.tsx). Same gold as every other "this is live" accent. */
        #ui .kbd { font-weight: 700; color: #e5c469; }
        /* A locked or unaffordable button is not a shortcut worth teaching
           right now, so the letter goes grey with the rest of the label —
           gold on a dashed disabled button reads as "press me". */
        #ui button:disabled .kbd { color: inherit; }
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
             36     the right rail — toasts live in it, and "Replay saved"
                    answers a button on an end card, so it has to read
                    over the card's scrim
             37     the ☰ menu — it drops into the same corner the right
                    rail fills, and a notice sliding in over the buttons
                    the player is aiming at would also steal their clicks.
                    Numerically this puts the menu over the end cards too,
                    which the cards must not allow; an effect below closes
                    the menu the moment a card comes up, so the two never
                    actually stack.
             40     tooltips (see tooltip.tsx)
           The quit question is not on this scale: it is a modal <dialog>,
           and showModal() lifts it into the browser's top layer, over
           every number above. */

        /* ——— The top region ———
           A grid, so nothing up here has to guess at anyone else's
           size. Row one is the goods strip beside the chrome; row two
           is the rest of the screen, which the rails hang from. Every
           number this used to need is now a consequence of the layout:
           the strip no longer reserves 240px for a cluster whose real
           width is 179, and the rails no longer start at a hardcoded
           56px that a strip wrapping to two rows would have run
           straight through.
           The system's own chrome is not a phone question either: an
           iPad in landscape has a home indicator too, and env() is
           simply 0 on the machines that have none. So the insets are
           part of the base frame rather than something a breakpoint
           remembers to add — the version that gated them on width put
           the goods strip under the notch of every phone held
           sideways. */
        .hud-top {
          position: absolute;
          top: calc(var(--hud-margin) + var(--safe-top));
          right: calc(var(--hud-margin) + var(--safe-right));
          bottom: calc(var(--hud-margin) + var(--safe-bottom));
          left: calc(var(--hud-margin) + var(--safe-left));
          display: grid;
          grid-template-columns: minmax(0, 1fr) auto;
          grid-template-rows: auto minmax(0, 1fr);
          column-gap: 12px; row-gap: 8px;
          pointer-events: none;
        }
        .hud-rails { grid-column: 1 / -1; grid-row: 2; position: relative; }

        .hud-resources {
          grid-column: 1; grid-row: 1;
          display: flex; justify-content: center; min-width: 0;
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
          opacity: 0.35;
        }
        /* Three digits' worth of slot per good. This strip sits dead
           centre and every count in it changes on its own, so without
           a fixed slot one barn filling past 99 walks all fourteen
           chips sideways — the most-watched row on screen, twitching
           at whatever rate the village happens to produce. Wrapping
           settles for the same reason: the break lands in the same
           place every time, because the widths never move. */
        .hud-resources span.res .num { min-width: 3ch; }
        .hud-resources span.res:hover { background: rgba(255, 255, 255, 0.06); }
        .hud-resources span.res.has { opacity: 1; }
        /* Heads and beds. Ruled off from the goods because it is not one —
           it is the ceiling everything else is spent under. */
        .hud-resources span.res.pop {
          margin-left: 6px; padding-left: 13px;
          border-left: 1px solid rgba(255, 255, 255, 0.14);
          color: #c8c4b5;
        }
        .hud-resources span.res.pop .num { min-width: 3ch; }
        /* The cap is the right-hand half of "8/10": left-aligned so the
           slash stays put between two slots that each grow outward. */
        .hud-resources span.res.pop .num.cap { text-align: left; }
        .hud-resources span.res.pop.full { color: #e5c469; }
        /* Research lives in the centre rail, not in the goods strip.
           It comes and goes with a click on the abbey, and inside the
           strip its arrival shunted every good sideways by half a chip
           — a strip that rearranges itself the moment you start a
           study is a strip you cannot read at a glance. */
        .research-chip {
          position: relative; overflow: hidden;
          padding: 3px 11px !important;
          font-size: 12px; border-radius: 8px !important;
        }
        .research-chip .fill {
          position: absolute; inset: 0 auto 0 0;
          background: rgba(229, 196, 105, 0.28);
          transition: width 0.4s;
        }
        .research-chip .label { position: relative; }

        .hud-nettrouble {
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
        /* Four digits of round-trip, right-aligned. It updates every
           ping, and it used to sit left of the ☰ inside one right-hand
           cluster: a lucky 9ms reply moved the menu button a whole
           character to the right, under a cursor already travelling
           to it. */
        #ui .net-chip .num { min-width: 4ch; }

        /* ——— Top-right chrome ———
           Two boxes, not one. The ☰ is the fixed point: last in a
           right-anchored row, so nothing that appears to its left can
           push it. The speed cluster's right edge is pinned the same
           way, with the buttons at that end and the informational
           chips — ping, Replay, the fog eye — filling in leftward.
           Every control keeps its pixel; only the labels drift, and
           they drift into empty sky. */
        .hud-chrome {
          grid-column: 2; grid-row: 1;
          display: flex; align-items: flex-start; gap: 8px;
          pointer-events: none;
        }
        .hud-chrome > * { pointer-events: auto; }
        #ui .hud-menu-btn {
          width: 38px; height: 38px; padding: 0;
          display: grid; place-items: center;
          border-radius: 12px;
        }
        .hud-speed {
          display: flex; align-items: center; gap: 4px;
          padding: 5px 6px; border-radius: 12px;
        }
        #ui .hud-speed button {
          background: transparent; border: none; border-radius: 8px;
          color: #cfccc2; font-size: 12px; padding: 5px 11px;
        }
        #ui .hud-speed button:hover:not(:disabled) { background: rgba(255, 255, 255, 0.08); color: #f0ede4; border: none; }
        #ui .hud-speed button.icon { width: 30px; height: 26px; padding: 0; display: grid; place-items: center; }
        #ui .hud-speed button.active { background: #e5c469; color: #0e100f; border: none; }
        #ui .hud-speed .div { width: 1px; height: 16px; margin: 0 2px; background: rgba(255, 255, 255, 0.12); }

        /* Hung from the top of the rail region rather than a measured
           52px below the top of the screen: the chrome it drops out of
           is the row above, so the grid has already worked out where
           that is — on a phone, where the chrome sits under a strip
           that may have wrapped, as much as on a desktop. */
        .hud-menu {
          position: absolute; top: 0; right: 0; width: 200px;
          display: flex; flex-direction: column; gap: 6px;
          padding: 10px 12px; pointer-events: auto;
          z-index: 37;
        }
        .hud-menu .menu-head {
          display: flex; justify-content: space-between; align-items: center;
          margin-bottom: 2px; font-weight: 600; color: #f0ede4;
        }
        .hud-menu .menu-close { min-width: 0; padding: 2px 8px; }
        .hud-menu .menu-sound { display: flex; align-items: center; gap: 8px; }
        #ui .menu-sound .menu-mute {
          min-width: 0; padding: 4px 8px; line-height: 0;
          display: flex; align-items: center; justify-content: center;
        }
        .menu-sound input[type='range'] { flex: 1; min-width: 0; accent-color: #e5c469; }
        .menu-sound input[type='range']:disabled { opacity: 0.4; }

        .hud-bottom {
          position: absolute;
          left: calc(var(--hud-margin) + var(--safe-left));
          right: calc(var(--hud-margin) + var(--safe-right));
          bottom: calc(var(--hud-margin) + var(--safe-bottom));
          display: flex; align-items: flex-end; gap: 10px; pointer-events: none;
        }
        .hud-build {
          pointer-events: auto; flex: 0 1 auto; min-width: 0;
          display: flex; flex-direction: column; gap: 8px; padding: 10px;
        }
        /* A half-typed chord is a mode, and a mode has to be visible or the
           next keystroke goes somewhere the player didn't mean it to. The
           whole card lights rather than a word inside it: the letter being
           waited for could be any of the fifteen buttons below. */
        .hud-build.chording { border-color: #e5c469; }
        .build-head {
          display: flex; align-items: baseline; gap: 8px;
          font-size: 12px; font-weight: 600; letter-spacing: 0.04em;
          color: #cfccc2;
        }
        .build-head .chord-hint { font-size: 11.5px; font-weight: 400; color: #8f8c83; }
        .hud-build.chording .build-head .chord-hint { color: #e5c469; }
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
        /* A declared grid, not a wrapping row. Shrink-to-fit made the
           card a different width per tab — Industry 613px, War 295px —
           so picking a tab jumped the card's whole right edge by three
           hundred pixels and every button under the cursor with it.
           The frame below is one size for all four tabs, and because
           the cells are declared rather than measured, a building that
           unlocks and gains a price tag grows inside its own cell
           instead of re-wrapping the tab around it. */
        .hud-items {
          display: grid;
          /* auto-fill rather than a flat three: a cell is never allowed
             below --build-col, so when the card is squeezed — a narrow
             desktop with a selection card beside it, a landscape phone
             — the ribbon drops to two columns and then one instead of
             slicing "Weaponsmith ⛏10 🪨6" off mid-price. Three is
             simply how many fit at the width below. */
          grid-template-columns: repeat(auto-fill, minmax(var(--build-col), 1fr));
          grid-auto-rows: var(--build-row);
          gap: 6px;
          align-content: start;
          width: calc(3 * var(--build-col) + 12px);
          max-width: 100%;
          /* A flat height, not a floor: the frame has to be the same
             frame on every tab, and losing a column is what makes the
             rows overflow. They scroll inside it. */
          height: calc(2 * var(--build-row) + 6px);
          overflow-y: auto;
        }
        /* The tooltip wrapper is what the grid actually places; the
           button has to fill it to keep the cell's edges. */
        .hud-items > .tipwrap { display: block; min-width: 0; }
        #ui .hud-items button {
          width: 100%; height: 100%; min-height: 0;
          display: flex; align-items: center; justify-content: flex-start;
          padding: 0 10px; overflow: hidden;
        }
        #ui .hud-items button .cost { margin-left: auto; padding-left: 6px; }

        .hud-selection {
          pointer-events: auto; flex: 0 0 auto; min-width: 0; margin-left: auto;
          width: var(--sel-w); padding: 12px 14px;
        }

        /* Floating touch actions: marquee select + grab-the-army. Fixed to
           the right edge over the map — the one part of a phone screen the
           HUD hasn't claimed. Hidden entirely on fine pointers. */
        .hud-touch {
          position: fixed;
          right: calc(10px + var(--safe-right));
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
        /* Deselect only means anything with something selected, but the
           column hangs from its bottom edge: letting the button come and
           go slid the two above it up and down the screen every time a
           tap landed on a soldier. It keeps its slot and goes invisible
           instead — the same thumb travel to Muster, always. */
        #ui .hud-touch button.reserved { visibility: hidden; }
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
          width: 380px; max-height: 60vh;
          overflow: auto; padding: 8px 10px;
          font-family: ui-monospace, monospace; font-size: 11px;
          text-align: left;
        }
        .hud-debug table { width: 100%; border-collapse: collapse; }
        .hud-debug td, .hud-debug th { padding: 1px 4px; text-align: left; }
        /* The strategist ledger: one collapsed line per consultation,
           details on demand. Dev builds only ever fill it. */
        .hud-debug .llm { margin-bottom: 8px; }
        .hud-debug .llm .posture { margin: 3px 0 7px; }
        .hud-debug .llm .posture div, .hud-debug .llm .knobs div { padding-left: 8px; }
        .hud-debug .llm .knobs { margin: 2px 0 4px; }
        .hud-debug .llm .held { color: #85827a; }
        .hud-debug .llm details { margin: 3px 0 3px 2px; }
        .hud-debug .llm summary { cursor: pointer; }
        .hud-debug .llm .sent { color: #9fb06a; }
        .hud-debug .llm .kept { color: #a3a099; }
        .hud-debug .llm .failed { color: #c86a5a; }
        .hud-debug .llm pre {
          margin: 2px 0 6px; white-space: pre-wrap; word-break: break-word;
          color: #a3a099;
        }
        .hud-violations {
          padding: 6px 14px;
          border-color: rgba(214, 106, 80, 0.5); color: #f0b9a8; max-width: 70vw;
        }
        .hud-festival { padding: 6px 12px; }
        /* The LLM strategist's little health line: download progress while
           the model fetches, a short-lived "on" once it answers. */
        .hud-llm { padding: 6px 12px; opacity: 0.85; }
        .hud-toasts {
          display: flex; flex-direction: column; gap: 6px; align-items: flex-end;
        }
        .toast { padding: 7px 13px; }
        /* A toast that knows a place: click pans the camera there. */
        #ui .toast.clickable { cursor: pointer; border-color: rgba(214, 106, 80, 0.55); }
        #ui .toast.clickable:hover { border-color: rgba(214, 106, 80, 0.9); }
        /* Fixed rather than absolute: the briefing card uses this class
           too, and it renders from inside the left rail — an absolute
           inset: 0 would size it to that column instead of the screen. */
        .hud-end {
          position: fixed; inset: 0; display: grid; place-items: center;
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
        /* The "really leave?" card — a real <dialog>, so the browser does
           the modality itself: the page behind goes inert, focus is held
           to the two buttons, and the scrim is the ::backdrop. #ui's
           pointer-events:none inherits even into the top layer, so the
           card opts back in. */
        #ui dialog.confirm-card {
          pointer-events: auto;
          padding: 26px 36px; text-align: center; max-width: min(380px, 86vw);
        }
        .confirm-card::backdrop { background: rgba(8, 10, 8, 0.6); }
        .confirm-card h1 {
          margin: 0 0 8px; font-size: 20px; font-weight: 600; color: #e5c469;
        }
        .confirm-card p { margin: 0; color: #b6b3a6; }
        .confirm-actions { display: flex; gap: 10px; justify-content: center; margin-top: 18px; }
        .confirm-actions button { padding: 8px 22px; font-size: 14px; }

        /* ——— Progressive layer ———
           One HUD, adapting to what the device can do. Desktop keeps
           everything above; these rules only add. */

        /* Touch pointers can't hit a 28px chip: grow every target to the
           44px guideline. Applies to tablets too, at any width. */
        @media (pointer: coarse) {
          /* Fatter cells for fat fingers — declared here rather than
             left to the buttons, so the ribbon's frame is still a
             number the layout knows before it draws anything. */
          #ui { --build-row: 44px; }
          #ui button { padding: 11px 15px; min-height: 44px; }
          #ui .hud-speed button { padding: 9px 14px; min-height: 44px; }
          #ui .hud-speed button.icon { width: 46px; height: 44px; }
          #ui .hud-tabs button { padding: 9px 18px; min-height: 40px; }
          #ui .menu-close { min-height: 36px; padding: 4px 12px; }
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

        /* ——— A phone, whichever way up ———
           Everything below this line used to hang off one question,
           "is the window narrower than 760px?", and that question has
           a wrong answer for half the phones in service. Held
           sideways an iPhone 13 is 844x390 — wider than the gate and
           barely a third as tall — so it took the desktop layout on a
           screen with no room for one: no safe-area insets, no way to
           fold the build card away, and a tech sheet drawn 463px tall
           inside 390px of screen.
           So the rules come in three blocks now, and which block a
           rule belongs in is decided by what it is really for:
             · COMPACT — a small screen either way up. Insets, sheets,
               collapsible cards, scrolling instead of growing.
             · NARROW — upright. Things stack, because there is height
               to stack into and no width to share.
             · SHORT  — sideways. Things sit side by side and give up
               height, because that is the axis in short supply.
           The names are shared with the components that ask the same
           questions in JavaScript (see breakpoints.ts). */

        /* ——— COMPACT: a small screen, either way up ——— */
        @media ${COMPACT} {
          /* A little closer to the edges than the desktop's 12px: the
             screen is small and the margin is map. (The safe-area
             insets are in the base rules — every device that has them
             wants them, at every size.) */
          .hud-top, .hud-bottom {
            --hud-margin: 10px;
          }
          /* The fold ✕ sits at the row's end, so the tab strip stretches. */
          .hud-tabs { align-self: stretch; }
          .hud-build .hud-items {
            width: auto;
            touch-action: pan-y;
            overscroll-behavior: contain;
            -webkit-overflow-scrolling: touch;
          }
          /* The ☰ menu opens downward from the top corner, and on a
             short screen its own height ran off the bottom — with Quit
             on the end of it, so a landscape phone had no way to leave
             a match at all. It gives up height to the window and
             scrolls.
             A share of the window rather than a subtraction from it:
             the menu hangs under the chrome cluster, and how far down
             that starts depends on how many rows the goods strip took
             — 96px on a phone held sideways, 126px on one held upright
             with the strip stacked above it. 58% clears the deeper of
             those two with room over. Small viewport units, not
             dynamic ones: an open menu must not resize under the thumb
             as the URL bar comes and goes. */
          .hud-menu {
            box-sizing: border-box;
            max-height: min(58vh, 340px);
            max-height: min(58svh, 340px);
            overflow-y: auto; overscroll-behavior: contain; touch-action: pan-y;
          }
          /* .tech-panel's sheet layout lives in TechTreePanel's own <style>:
             that component renders later, so rules here lost the tie and
             a stale max-height silently capped the sheet. */
          .hud-debug { display: none; } /* desktop-only diagnostics */
        }

        /* ——— NARROW: held upright ——— */
        @media ${NARROW} {
          /* One column: resources, then the chrome under them, then the
             rails under both. Goods are what you glance at, and a strip
             that wraps to three rows pushes the rest down rather than
             landing on it. */
          .hud-top {
            grid-template-columns: minmax(0, 1fr);
            grid-template-rows: auto auto minmax(0, 1fr);
          }
          .hud-resources { grid-column: 1; grid-row: 1; justify-content: flex-start; }
          .hud-chrome { grid-column: 1; grid-row: 2; justify-self: end; }
          .hud-rails {
            grid-column: 1; grid-row: 3;
            display: flex; flex-direction: column; gap: 6px;
          }
          /* Three lanes need three lanes' worth of screen, and a phone
             has one. They become a single column instead — same order,
             same growth downward, and the toast that used to land on
             the objectives checklist now queues behind it. Relative
             rather than static so the right lane keeps its z-index. */
          .hud-rail { position: relative; top: auto; left: auto; right: auto; transform: none; }
          .hud-rail.center { align-items: flex-start; }
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

          .hud-bottom { flex-direction: column; align-items: stretch; gap: 8px; }
          .hud-selection { margin-left: 0; width: auto; }
          /* The thumb rail joins the column instead of floating over it.
             Fixed at 38vh it was a guess about how tall the cards would
             be, and a barracks with touch-sized buttons is 370px of
             card — the rail's ✕ ended up inside it. In the flow it
             cannot be wrong: it rides up when the card below it grows.
             Laid across rather than down, because a column of three
             would be a third of the stack. */
          .hud-touch {
            position: static; flex-direction: row; align-self: flex-end;
            margin-bottom: 2px;
          }
          /* The card is the screen's width here, so the grid takes it
             all and fits however many cells it holds — two on a phone,
             three on a tablet. The frame is a share of the screen
             rather than a count of cells, and it is still one number
             on every tab. */
          .hud-build .hud-items { height: 26vh; }
        }

        /* ——— SHORT: held sideways ———
           Width is what this screen has and height is what it hasn't,
           so the cards sit side by side and every one of them is
           capped: what does not fit scrolls inside its own card
           instead of growing up over the map. Nothing here may depend
           on the window being narrow — an iPhone 15 Pro Max is 932px
           across in this orientation. */
        @media ${SHORT} {
          /* The goods strip is read at a glance and never touched, so
             it is the one thing that can afford to be small. */
          .hud-resources > div { padding: 3px 6px; }
          .hud-resources span.res { padding: 2px 7px; font-size: 12.5px; gap: 4px; }
          .hud-resources span.res .num,
          .hud-resources span.res.pop .num { min-width: 2.5ch; }
          #ui .hud-speed button.icon { width: 42px; height: 38px; }
          #ui .hud-speed button { min-height: 38px; }
          #ui .menu-toggle { min-height: 38px; }

          /* The whole bottom row, capped. --hud-bottom-h is the number
             the cards inside it are cut to fit, and it is deliberately
             a share of the window rather than a count of rows: whatever
             is in these cards, together they get this much of the
             screen and the map keeps the rest.
             Small viewport units, like the menu's cap and the room list
             before it: vh is the window with the browser's own bars
             hidden, so on a phone that still has its URL bar showing,
             52vh is more than half of what the player can actually see
             — the cards would take the extra out of the map, and the
             thumb rail sitting on top of them would go with it.
             @supports rather than the usual pair of declarations,
             because this is a custom property: its value is not parsed
             for units when it is declared, so an unknown one would not
             fall back to the line above it — it would fail later, where
             the property is used, and take the cap with it. */
          #ui { --hud-bottom-h: min(52vh, 250px); }
          @supports (height: 1svh) {
            #ui { --hud-bottom-h: min(52svh, 250px); }
          }
          .hud-bottom {
            flex-direction: row; align-items: flex-end;
            max-height: var(--hud-bottom-h); gap: 8px;
          }
          /* The same length again on the children, not 100%: a
             percentage max-height resolves against a parent's height,
             and this parent has only a max-height, so the percentage
             would come out as no limit at all — which is exactly how a
             369px selection card ended up standing on a 375px screen. */
          .hud-bottom > * {
            /* border-box, because #ui is otherwise content-box: on the
               default the cap leaves out the card's own padding and
               border, and the selection card stood 26px taller than
               the frame that was supposed to be holding it. */
            box-sizing: border-box;
            min-height: 0; max-height: var(--hud-bottom-h);
          }
          /* Nearly the desktop card, because its contents were drawn to
             a 430px frame — the training queue's three columns, the
             priced build cells — and a card much under that starts
             slicing them. Half the window is the floor it may not pass,
             so the build card beside it always has a column to draw in. */
          .hud-selection {
            width: min(var(--sel-w), 46%);
            overflow-y: auto; overscroll-behavior: contain; touch-action: pan-y;
          }
          .hud-build { flex: 1 1 auto; min-width: 0; }
          /* Two rows of cells and the ribbon scrolls — a declared count
             rather than a share of the screen, so the card is the same
             height on every phone and the cells are never sliced. */
          .hud-build .hud-items { height: calc(2 * var(--build-row) + 6px); }
          /* The thumb rail clears the cards rather than floating over
             them — at 38vh it landed on the selection card's shoulder,
             with its ✕ on the building's health. It lies along the
             band above them rather than down it: three 46px buttons
             stacked are 154px, and the band between the goods strip
             and the cards is barely a hundred. */
          .hud-touch {
            flex-direction: row;
            bottom: calc(var(--hud-bottom-h) + 14px + var(--safe-bottom));
            right: calc(10px + var(--safe-right));
          }
          #ui .hud-touch button { width: 46px; height: 46px; border-radius: 12px; }
          /* Seven full-size rows do not fit in 58% of a 390px screen
             whatever we do — but at desktop sizing only three of them
             did, and Quit was never one. */
          #ui .hud-menu button { min-height: 36px; padding: 7px 13px; }
          /* The transient lanes get the band between the strips and the
             cards, and no more of it. A run of toasts is welcome to
             overlay the map; the objectives checklist standing on the
             build card is not. */
          .hud-rails { overflow: hidden; }
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
                <GoodIcon good={good} /> <span class="num">{stock()[good] ?? 0}</span>
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
            <PopIcon /> <span class="num">{population().pop}</span>/
            <span class="num cap">{population().cap}</span>
          </span>
        </div>
      </div>

      <div class="hud-chrome">
      {/* The speed cluster comes first and the ☰ last: in a
          right-anchored row that pins the menu button to the corner
          and lets the chips beside it grow away into open sky. */}
      <Show when={!netMode() || netStatus()?.state === 'ok'}>
      <div class="hud-speed panel">
        <Show when={netMode() && netStatus()?.state === 'ok'}>
          <span
            class="net-chip"
            {...tooltip(() => (
              <TextTip title="Connection" body="Round-trip to the relay and prediction lead." />
            ))}
          >
            ⇄ <span class="num">{(netStatus() as { rttMs: number }).rttMs}</span>ms
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
            {/* The recording is a finished match, so lifting the fog is
                spectating rather than cheating — the live game keeps this
                behind the admin panel. Render-only: playback is unchanged. */}
            <button
              class="icon"
              classList={{ active: !fogEnabled() }}
              {...tooltip(() => (
                <TextTip
                  title={fogEnabled() ? 'Reveal the valley' : 'Fog of war'}
                  body={
                    (fogEnabled()
                      ? 'Turns fog of war off to watch the whole map, rivals and all.'
                      : 'Turns fog of war back on — see only what this seat saw.') +
                    (hasKeyboard() ? ' (F)' : '')
                  }
                />
              ))}
              onClick={() => setFogEnabled(!fogEnabled())}
            >
              {fogEnabled() ? <EyeOffIcon /> : <EyeIcon />}
            </button>
            <span class="div"></span>
          </Show>
          <Show
            when={isCompact()}
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
      </Show>
      <button
        class="hud-menu-btn panel"
        classList={{ active: menuOpen() }}
        {...tooltip(() => <TextTip title="Menu" body="Save, load, or leave the village." />)}
        onClick={() => setMenuOpen(!menuOpen())}
      >
        ☰
      </button>
      </div>

      {/* Row two of the top grid: everything that comes and goes.
          It begins wherever the strip and the chrome above it
          happened to end, so a goods strip that wraps pushes the
          rails down instead of being drawn through by them. */}
      <div class="hud-rails">
        {/* Left rail: the standing account of who you are and how the
            machinery under the match is doing. */}
        <div class="hud-rail left">
          <Show when={llmBadge()}>{(text) => <div class="hud-llm panel">{text()}</div>}</Show>
          <MissionPanel onSpeed={props.onSpeed} />
        </div>

        {/* Centre rail, under the goods strip: what the village is busy
            with, and what has gone wrong. Ordered by how long each stays
            — a study runs for minutes, a broken connection is meant to
            be read and gone. */}
        <div class="hud-rail center">
          <Show when={techs().active}>
            {(a) => (
              <button
                class="research-chip panel"
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
          <Show when={techs().festivalTicksLeft > 0}>
            <div class="hud-festival panel">Festival! Everyone works faster</div>
          </Show>
          <Show when={netMode() && netStatus()?.state === 'disconnected'}>
            <div class="hud-nettrouble panel">
              Connection to the server lost. Reconnecting… — your seat is held,
              and the match rides out even a server restart.
            </div>
          </Show>
          <Show when={invariantViolations().length > 0}>
            <div class="hud-violations panel">
              {invariantViolations().length} invariant violation(s) — see console
            </div>
          </Show>
        </div>

        {/* Right rail, under the chrome it must not cover: notices, then
            the diagnostics table dev builds open. */}
        <div class="hud-rail right">
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
          <Show when={debugOpen()}>
            <div class="hud-debug panel">
              {/* The strategist's consultation ledger (dev builds only — the
                  signal stays empty everywhere else). Collapsed, each entry is
                  one line: who, when, how long, and what came of it; open, it
                  shows the advice sent downstairs, the standing pile, the
                  model's reply verbatim, and the exact prompt — the loop for
                  tuning prompt.ts without leaving the match. */}
              <Show when={llmTraces().length > 0}>
                <div class="llm">
                  <b>strategist ({llmTraces().length})</b>
                  {/* Where each seat stands now: its whole standing pile in
                      English, diffed against the playbook print. The entries
                      below are the history of how it got there. */}
                  <For each={llmPostures()}>
                    {(p) => (
                      <div class="posture">
                        <b>seat {p.playerId} posture</b>
                        <For
                          each={p.moved}
                          fallback={<div class="held">playing the playbook as printed</div>}
                        >
                          {(line) => <div>{line}</div>}
                        </For>
                        <Show when={p.moved.length > 0}>
                          <div class="held">everything else per the playbook</div>
                        </Show>
                      </div>
                    )}
                  </For>
                  <For each={llmTraces()}>
                    {(t) => (
                      <details>
                        <summary>
                          <span class={t.outcome}>{t.outcome}</span> · seat {t.playerId} · min{' '}
                          {t.minutes} · {(t.ms / 1000).toFixed(1)}s
                          {t.advice?.reason ? ` — ${t.advice.reason}` : ''}
                        </summary>
                        <Show when={t.error}>
                          <pre>error: {t.error}</pre>
                        </Show>
                        {/* This reply's real moves alone, clamped to what the
                            sim would take. A small model echoes most of the
                            print back on every reply, so the echoes collapse
                            to a count — the reply below has them verbatim. */}
                        <Show when={t.advice}>
                          {(advice) => {
                            const lines = () => describeAdvice(advice(), t.knobs);
                            const moved = () => lines().filter((l) => l.moved);
                            const held = () => lines().length - moved().length;
                            const knobs = (n: number): string => `${n} knob${n === 1 ? '' : 's'}`;
                            return (
                              <div class="knobs">
                                <For
                                  each={moved()}
                                  fallback={
                                    <div class="held">
                                      {held() > 0
                                        ? `only echoes the playbook (${knobs(held())})`
                                        : 'no knob changes'}
                                    </div>
                                  }
                                >
                                  {(line) => <div>{line.text}</div>}
                                </For>
                                <Show when={moved().length > 0 && held() > 0}>
                                  <div class="held">+ {knobs(held())} echoing the playbook</div>
                                </Show>
                              </div>
                            );
                          }}
                        </Show>
                        <pre>reply: {t.raw || '(none)'}</pre>
                        <details>
                          <summary>prompt</summary>
                          <For each={t.messages}>
                            {(m) => (
                              <pre>
                                [{m.role}] {m.content}
                              </pre>
                            )}
                          </For>
                        </details>
                      </details>
                    )}
                  </For>
                </div>
              </Show>
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
            {/* Any time in a solo match: the log runs from boot, so a
                mid-match save records everything up to this moment and
                playback pauses there. Multiplayer still records on the
                server, which only hands the log out once the match is
                decided — its button lives on the end card. */}
            <Show when={!netMode() && !replayMode()}>
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
                disabled={lastSave() === null}
                title={
                  lastSave() !== null
                    ? `Saved ${lastSave()!}`
                    : 'Nothing saved on this device yet'
                }
                onClick={() => {
                  // Asked again here rather than taken from the signal
                  // above: that name is as old as the last time this menu
                  // opened, and loading a file another tab has deleted
                  // since takes the running match down to the fatal card.
                  // One OPFS read is nothing beside the world about to be
                  // read off it.
                  void latestSaveName().then((name) => {
                    setLastSave(name);
                    if (name === null) return;
                    // The save's name is the whole address, like a
                    // replay's: the world lives in OPFS, and a reload of
                    // this URL comes back into the same village. force
                    // because loading the save this match already booted
                    // from is the same URL, and the router would otherwise
                    // call it the screen it is already on.
                    goto('?load=' + encodeURIComponent(name), { force: true });
                  });
                }}
              >
                Load last save
              </button>
            </Show>
            <Show when={fs.offerable()}>
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
            <div class="menu-sound">
              <button
                class="menu-mute"
                aria-pressed={muted()}
                // M only mutes while nothing is selected — with a squad
                // standing it is the move order. Advertising a key that
                // would march the army instead is worse than no hint.
                title={
                  (muted() ? 'Sound off' : 'Sound on') +
                  (hasKeyboard() && selection().size === 0 ? ' (M)' : '')
                }
                onClick={() => toggleMuted()}
              >
                {muted() ? <SpeakerOffIcon /> : <SpeakerIcon />}
              </button>
              <input
                type="range"
                min="0"
                max="1"
                step="0.05"
                value={volume()}
                disabled={muted()}
                aria-label="Sound volume"
                onInput={(e) => setVolumePref(Number(e.currentTarget.value))}
                onChange={() => play('uiClick')}
              />
            </div>
            <button
              onClick={() => {
                // In a match the world lives on (solo: gone unless saved;
                // multiplayer: the room plays on and the seat token can
                // rejoin) — but the player is leaving either way, so ask.
                // Asked by our own card, not confirm(): the browser climbs
                // out of fullscreen to show a native dialog.
                setQuitConfirm(true);
              }}
            >
              Quit to menu
            </button>
          </div>
        </Show>
      </div>
      </div>


      <div class="hud-bottom">
        <Show when={isCoarse() || isCompact()}>
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
                selection, and every hardware keyboard has one. Rendered
                whenever there is no keyboard and merely hidden when
                nothing is selected: the column hangs from its bottom
                edge, so a button that comes and goes would walk the two
                above it up and down the screen. */}
            <Show when={!hasKeyboard()}>
              <button
                classList={{ reserved: selection().size === 0 }}
                aria-hidden={selection().size === 0}
                tabindex={selection().size === 0 ? -1 : undefined}
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

        <Show when={(isCoarse() || isCompact()) && !replayMode() && placing()}>
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
                <MalletIcon /> <Key label="Build" k="B" />
                <Show when={placing()}>{(t) => <span class="cost">{buildingName(t())}…</span>}</Show>
              </button>
            </Show>
          }
        >
          <div class="hud-build panel" classList={{ chording: buildChord() }}>
            {/* The card's own name, which it never needed until it had a
                shortcut to teach. Keyboard only — with nothing to press,
                a header saying "Build" over the build card is furniture. */}
            <Show when={hasKeyboard()}>
              <div class="build-head">
                {/* Wrapped, because this row is a flex container: bare, the
                    gold B and the "uild" after it are two flex items and
                    the row's gap opens up inside the word. */}
                <span>
                  <Key label="Build" k="B" />
                </span>
                <span class="chord-hint">
                  {buildChord() ? 'now a letter…' : 'then a letter'}
                </span>
              </div>
            </Show>
            <div class="hud-tabs">
              <For each={BUILD_GROUPS}>
                {(group, i) => (
                  <button classList={{ active: activeTab() === i() }} onClick={() => setActiveTab(i())}>
                    {group.label}
                  </button>
                )}
              </For>
              <Show when={isCompact()}>
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
                          <LockIcon /> <Key label={buildingName(type)} k={buildKey(type)} />
                        </button>
                      }
                    >
                      <button
                        classList={{ active: placing() === type }}
                        disabled={!affordable(type) && placing() !== type}
                        onClick={() => place(placing() === type ? null : type)}
                      >
                        <Key label={buildingName(type)} k={buildKey(type)} />
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
          onArmOrder={props.onArmOrder}
          onDismiss={props.onDismiss}
          onSell={props.onSell}
          onRepair={props.onRepair}
          onTogglePause={props.onTogglePause}
          onSetRecipe={props.onSetRecipe}
        />
      </div>

      <Show when={techPanelOpen()}>
        <TechTreePanel onResearch={props.onResearch} />
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
            <button onClick={() => goto(location.pathname)}>Back to the menu</button>
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
            <button onClick={() => setQuitConfirm(true)}>Quit to menu</button>
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
                    // The same navigation launch() uses: the next
                    // mission's recipe as the whole query string.
                    goto(`?mission=${next().id}`);
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
                  goto(`${location.pathname}?mp=new`);
                } else {
                  // This very URL, from the top — the one navigation that
                  // means "again" rather than "elsewhere".
                  goto(location.search, { force: true });
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
            <button onClick={() => goto(location.search, { force: true })}>Watch again</button>
            <button onClick={() => goto(location.pathname)}>Back to the menu</button>
          </div>
        </div>
      </Show>

      <Show when={quitConfirm()}>
        <dialog
          class="panel confirm-card"
          aria-labelledby="quit-title"
          // A <dialog> in the DOM is merely closed; modality is asked for.
          // Deferred a tick because refs run before Solid puts the element
          // in the document, and showModal() on a detached dialog throws.
          ref={(el) => queueMicrotask(() => el.isConnected && el.showModal())}
          // Esc lands in controls.ts first (keydown outruns the browser's
          // cancel) and unmounts the card; this catches any close the game
          // did not order, so the signal never says open over a closed
          // dialog.
          onClose={() => setQuitConfirm(false)}
        >
          <h1 id="quit-title">Leave the match?</h1>
          <p>{quitStakes()}</p>
          <div class="confirm-actions">
            <button onClick={() => setQuitConfirm(false)}>Stay{hasKeyboard() ? ' (Esc)' : ''}</button>
            <button
              // showModal() hands focus to the autofocus element, so Enter
              // answers yes — the reflex the native dialog taught.
              autofocus
              onClick={() => goto(location.pathname)}
            >
              Quit to menu
            </button>
          </div>
        </dialog>
      </Show>

      <Show when={adminMode}>
        <AdminPanel onAdmin={props.onAdmin} />
      </Show>

      <TooltipLayer />

    </>
  );
}
