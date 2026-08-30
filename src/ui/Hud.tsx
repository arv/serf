import {For, Show, createEffect, createSignal, type JSX} from 'solid-js';
import {goto} from '../app/router';
import {latestSaveName} from '../app/saveStore';
import {play} from '../audio/audio';
import {hasKeyboard} from '../input/keyboard';
import {clearSeatStash} from '../net/lobbyClient';
import * as NetState from '../protocol/netStateEnum.ts';
import type {Enum} from '../shared/enum.ts';
import type {AdminAction} from '../sim/commands';
import {BUILDING_DEFS, type BuildingTypeId} from '../sim/defs/buildings';
import * as GoodId from '../sim/defs/goodIdEnum.ts';
import {goodEntries} from '../sim/defs/goods';
import type {TechId} from '../sim/defs/techs';
import type {UnitTypeId} from '../sim/defs/units';
import * as MatchState from '../sim/matchStateEnum.ts';
import {AdminPanel} from './AdminPanel';
import {COMPACT, NARROW, SHORT, useMedia} from './breakpoints';
import {
  BUILD_GROUPS,
  buildAffordable,
  buildKey,
  buildTab,
  buildUnlocked,
} from './buildMenu';
import {EconomyPanel} from './EconomyPanel';
import {fullscreen} from './fullscreen';
import * as HudPanel from './hudPanelEnum.ts';
import {
  LedgerIcon,
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
import {Minimap, type MinimapSource} from './Minimap';
import * as MinimapMode from './minimapModeEnum.ts';
import {MissionPanel, continueTarget} from './MissionPanel';
import {buildingName, techName} from './names';
import {SelectionPanel} from './SelectionPanel';
import {Key} from './shortcut';
import {REPLAY_GEAR, SPEED_GEARS} from './speedControl';
import {
  cheatsAllowed,
  bandArm,
  buildAim,
  buildChord,
  debugJobs,
  debugOpen,
  fogEnabled,
  invariantViolations,
  minimapOpen,
  setMinimapOpen,
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
  economyPanelOpen,
  setEconomyPanelOpen,
  toolWants,
  techs,
  toasts,
  toggleMuted,
  volume,
  type OrderMode,
} from './store';
import {TechTreePanel} from './TechTreePanel';
import {
  BuildingTip,
  GoodTip,
  TextTip,
  TipWrap,
  TooltipLayer,
  tooltip,
} from './tooltip';

type GoodId = Enum<typeof GoodId>;

/** The gears' faces. The numbers themselves come from speedControl, which
 * is what the keyboard steps through too — a second list here would be a
 * ladder the P/+/− keys could walk off the end of. */
const [PAUSED, NORMAL, FAST] = SPEED_GEARS;

/** What the keyboard offers for a gear, appended to its tooltip where
 * there is a keyboard to offer it to. P is the hold; + and − are the
 * ladder, so they belong to every rung above the hold. */
const PAUSE_KEYS = '(P)';
const GEAR_KEYS = '(+ / −)';

const SPEEDS = [
  {
    value: PAUSED,
    icon: PauseIcon,
    label: 'Pause',
    hint: 'Orders you give still queue up.',
    keys: PAUSE_KEYS,
  },
  {
    value: NORMAL,
    icon: PlayIcon,
    label: 'Normal speed',
    hint: undefined as string | undefined,
    keys: GEAR_KEYS,
  },
  {
    value: FAST,
    icon: FastIcon,
    label: 'Fast forward',
    hint: 'Runs the village at 3× speed.',
    keys: GEAR_KEYS,
  },
];

/** Replays get one speed beyond the live game's fastest: nobody is issuing
 * orders, so there is no reaction time to protect. */
const REPLAY_SPEED = {
  value: REPLAY_GEAR,
  icon: FastestIcon,
  label: 'Full gallop',
  hint: 'Replay only — runs the recording at 8× speed.',
  keys: GEAR_KEYS,
};

/** A gear's tooltip body: what it does, then the key that does it. The
 * keys are dropped whole on a device with no keyboard, the way every other
 * hint in the HUD is — and 'Normal speed' has no prose at all, so the hint
 * may be nothing but the keys. */
function gearBody(s: {hint?: string; keys: string}): string | undefined {
  const parts = [s.hint, hasKeyboard() ? s.keys : undefined].filter(Boolean);
  return parts.length > 0 ? parts.join(' ') : undefined;
}

/**
 * The goods the strip shows at all times: the ones a player glances at
 * every few seconds mid-decision. Everything else — the full nineteen,
 * arms and tools included — lives one tap away in the EconomyPanel. The
 * strip held all thirteen goods until the tools arrived; six more would
 * have wrapped it to two rows on every laptop (~74px a chip against
 * ~1174px of budget at 1440), and a strip that wraps pushes the whole
 * rail stack down the map.
 */
const HUD_GOODS: GoodId[] = [
  GoodId.wood,
  GoodId.stone,
  GoodId.food,
  GoodId.iron,
  GoodId.silver,
];

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
  onSell: (buildingId: number) => void;
  onClearRally: (buildingId: number) => void;
  onRepair: (buildingId: number, repair: boolean) => void;
  onTogglePause: (buildingId: number, paused: boolean) => void;
  onSetRecipe: (buildingId: number, index: number) => void;
  onEnqueueForge: (buildingId: number, recipeIndex: number) => void;
  onCancelForge: (
    buildingId: number,
    index: number,
    recipeIndex: number,
  ) => void;
  minimap: MinimapSource;
}) {
  // The sim rejects admin commands in a match (world.admin.enabled is
  // false), so every button here no-ops — except the fog toggle, which
  // never reaches the sim. Hide the panel rather than leave that one live.
  // Evaluated at mount, which is enough: runMatch sets netMode before it
  // mounts the HUD, so a networked match reads the gate closed however it
  // was entered.
  const adminMode =
    cheatsAllowed() && new URLSearchParams(location.search).has('admin');
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
  /**
   * A thumb is doing the pointing — either the device says so, or the
   * screen is small enough that one is doing it anyway. The question the
   * thumb rail and the placing bar both ask before they render: both exist
   * to give a finger what a mouse already has.
   */
  const hasThumb = (): boolean => isCoarse() || isCompact();
  /**
   * Upright and only upright — a phone narrow enough to stack, minus the
   * landscape phones that are also narrow (an iPhone SE sideways is 667x375
   * and inside NARROW). Almost nothing needs the distinction, because the
   * stylesheet gets it for free from cascade order: the SHORT block is
   * written after the NARROW one and simply overrides what it said. Markup
   * has no cascade, and the bottom row needs the answer in markup — stacked
   * it wants its controls at the end of the row, in a line it wants them at
   * the head. So it is spelled out here as the same two questions in the
   * same order, rather than as a third media query drawing the line again:
   * a `min-height: 521px` twin to SHORT leaves 520.5px in a gap where CSS
   * has stacked the row and this still says it hasn't.
   */
  const isNarrow = useMedia(NARROW);
  const isShort = useMedia(SHORT);
  const isUpright = (): boolean => isNarrow() && !isShort();
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
  /**
   * Nobody else's clock: no server ticking this match, and no log playing
   * one back. Both are worlds this player doesn't own outright, and the
   * parts of the HUD that write to the world ask before they offer —
   * saving, loading, and hurrying time are all only a solo game's to do.
   */
  const isSolo = (): boolean => !netMode() && !replayMode();
  /**
   * Whether the speed cluster is holding exactly one control, and so can be
   * the same square as the ☰ beside it rather than a panel around a row.
   * isCompact() and isSolo() between them are the three <Show>s inside it:
   * a match puts the ping chip in the panel (and takes the speed control
   * out — you cannot hurry a match), a replay adds its own chip, fog eye
   * and divider, and away from COMPACT the one cycling button becomes a
   * button per speed.
   * Read here rather than asked of the DOM with :has, which drops the whole
   * rule on a browser that lacks it and costs more to recalculate on one
   * that doesn't. The markup knows; it can say so.
   */
  const speedIsSingle = (): boolean => isCompact() && isSolo();
  const menuOpen = (): boolean => openPanel() === HudPanel.menu;
  /** The newest saved game, as of the last time the menu was opened: what
   * the Load button reads to know whether there is anything to load, and
   * to name it. Read on open rather than once at mount, because saving
   * from this very menu makes a new file the newest one. Deliberately not
   * cleared while the next read is in flight — the button would flicker
   * disabled every time the menu came up — so this is the last answer,
   * not necessarily the current one. The click settles that itself. */
  const [lastSave, setLastSave] = createSignal<string | null>(null);
  const setMenuOpen = (open: boolean): void => {
    setOpenPanel(open ? HudPanel.menu : null);
    if (open) void latestSaveName().then(setLastSave);
  };
  /** Nothing in hand: what greys the rail's ✕ out, and what leaves M free
   *  to be the mute key rather than the move order. */
  const nothingSelected = (): boolean => selection().size === 0;
  /**
   * The thumb rail's Deselect ✕, which stands at whichever end of the rail
   * is the far one — the bottom of a tablet's column, the left of a phone's
   * row — so the buttons nearest the hand never move. Written once and
   * rendered from either end of the rail rather than placed once and moved
   * with CSS `order`: order moves the picture and leaves the markup where it
   * was, and a screen reader swiping this rail would have been offered the
   * ✕ last while looking at it first. It is a touch control by definition
   * (a keyboard has Esc, and the rail doesn't render this at all when there
   * is one), so the reading order is the only order it has.
   */
  const DeselectButton = (): JSX.Element => (
    <button
      classList={{reserved: nothingSelected()}}
      aria-hidden={nothingSelected()}
      tabindex={nothingSelected() ? -1 : undefined}
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
  );
  /**
   * Build, the toggle — written once and rendered in two places, never
   * both at once: the pill at the foot of the HUD, and, where a sheet has
   * covered that spot, the button leading the strip at the sheet's own
   * foot, standing in the pill's very pixels. The whole point of that is
   * that the same tap opens and closes without the thumb moving, and two
   * buttons that have to be one button should be one button. Only the
   * class differs, because the stylesheet still has to tell a strip's
   * Build from the tabs beside it.
   *
   * Toggling rather than closing serves both: the strip's twin only ever
   * renders while the card is open, so `!buildOpen()` is false there —
   * and no pressed state on either, because the card standing open above
   * is the state.
   */
  const BuildToggle = (props: {class: string}): JSX.Element => (
    <button
      class={props.class + ' panel'}
      onClick={() => setBuildOpen(!buildOpen())}
    >
      <MalletIcon /> <Key label="Build" k="B" />
      {/* Hidden by the CSS everywhere the strip's twin can appear, so the
          two never come out different widths — and the placing bar is
          standing beside it there saying the same name in full. */}
      <Show when={placing() !== null}>
        <span class="cost">{buildingName(placing()!)}…</span>
      </Show>
    </button>
  );
  /**
   * The two controls that stand at the foot of the HUD — Build, and the
   * floating thumb rail — as one piece, because upright they share the last
   * line of the bottom row and a screen reader should meet them there. The
   * two calls in .hud-bottom render this at one end of the row or the other;
   * see the comment on the first of them.
   */
  const BottomControls = (): JSX.Element => (
    <>
      {/* Build is a toggle, and a toggle that moves is two buttons. It
          stands here whenever the open card leaves the spot free —
          upright the card is a line of the stack and the pill keeps its
          place under it, so this is the toggle and it never budges.
          Sideways the sheet covers this whole row, so the strip at the
          sheet's foot stands in for it instead, to the pixel (see
          BuildTabs). Off entirely on a desktop, where the card never
          folds and `buildVisible()` is always true. */}
      <Show when={!replayMode() && (!buildVisible() || isUpright())}>
        <BuildToggle class="hud-build-pill" />
      </Show>
      <Show when={hasThumb()}>
        <div class="hud-touch">
          {/* A phone's rail hangs from a margin — the right one upright,
              the bottom one sideways — so the far end is this one either
              way: the ✕ leads, the buttons that are always there keep
              the margin, and Muster stays nearest the thumb whether or
              not anything is selected. Only ever one of these two
              renders. */}
          <Show when={!hasKeyboard() && isCompact()}>
            <DeselectButton />
          </Show>
          {/* The minimap's door on small screens: the standing card
              below only renders where a corner can afford it, and a
              phone has no such corner either way up. The button wears a
              live thumbnail of the chart rather than an icon — standing
              awareness at no cost the button wasn't already paying: your
              white blob, rival colors, and the alarm pulse below when a
              warning knows a place. First in the rail — Muster and
              Deselect keep their spots nearest the thumb. */}
          <Show when={isCompact()}>
            <button
              class="map-thumb"
              aria-label="Map"
              classList={{
                active: minimapOpen(),
                alarm: toasts().some(t => t.focus !== undefined),
              }}
              {...tooltip(() => (
                <TextTip
                  title="Map"
                  body="The whole valley at a glance. Tap a spot to look there, or hold and drag to steer the camera."
                />
              ))}
              onClick={() => setMinimapOpen(!minimapOpen())}
            >
              <Minimap source={props.minimap} mode={MinimapMode.thumb} />
            </button>
          </Show>
          {/* The lasso is the only way to band-select without a pointer
              that drags one: bandArm() is what tells Controls to draw a
              band rather than let the camera have the drag, and this
              button is its only writer. So it retires for a mouse or
              trackpad — never for a keyboard, which types but cannot
              drag. */}
          <Show when={!hasFinePointer()}>
            <button
              classList={{active: bandArm()}}
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
              <TextTip
                title="Muster the army"
                body="Selects every soldier you own, wherever they are."
              />
            ))}
            onClick={() => props.onSelectArmy()}
          >
            <SwordsIcon />
          </button>
          {/* The tablet's column hangs from its bottom edge, so this is
              the far end here. See DeselectButton for why the ✕ is
              written at both ends of the rail rather than moved. */}
          <Show when={!hasKeyboard() && !isCompact()}>
            <DeselectButton />
          </Show>
        </div>
      </Show>
    </>
  );
  /**
   * The build card's tab strip — its head at a desk, and under COMPACT its
   * foot, where a thumb already is.
   *
   * Under SHORT it also leads with Build, in place of a ✕ closing the sheet
   * from the far end. SHORT is where the card becomes a sheet and covers
   * the whole bottom row, pill and all, so the button that folds it away
   * has to stand in the very place the pill that opened it stood — and then
   * the same tap twice opens and closes without the thumb moving. It is
   * full-bleed to the sheet's foot (the CSS) for exactly that reason: the
   * sheet's own padding is all the two positions would otherwise differ by,
   * and as it is they land within a pixel.
   * Upright there is no need. The card is a line of the stack rather than a
   * sheet over it, the pill is still standing underneath, and it is the
   * toggle itself.
   */
  const BuildTabs = (): JSX.Element => (
    <div class="hud-tabs">
      <Show when={isShort()}>
        <BuildToggle class="build-fold" />
      </Show>
      <For each={BUILD_GROUPS}>
        {(group, i) => (
          <button
            classList={{active: activeTab() === i()}}
            onClick={() => setActiveTab(i())}
          >
            {group.label}
          </button>
        )}
      </For>
    </div>
  );
  const cost = (type: BuildingTypeId) => goodEntries(BUILDING_DEFS[type].cost);
  const affordable = (type: BuildingTypeId): boolean =>
    buildAffordable(type, stock());
  const unlocked = (type: BuildingTypeId): boolean =>
    buildUnlocked(type, techs().researched);

  // A building named from the keyboard has to bring its tab with it: the
  // chord can reach a mine while the Food tab is showing, and a placement
  // whose button is on a tab nobody is looking at is a ghost on the map
  // with nothing on the HUD claiming it. Clicking a button lands here too
  // and changes nothing — that tab was already the open one.
  //
  // The aim rather than the placement, because a chord that names a
  // building the stores cannot pay for arms nothing at all, and that is the
  // case that needs the tab most: the answer to "why not" is the greyed
  // button and the cost written under it. See buildAim in the store.
  createEffect(() => {
    const type = buildAim();
    if (!type) return;
    const i = buildTab(type);
    if (i >= 0) setActiveTab(i);
  });
  // Phones fold the card down to a pill, and a chord typed at a folded card
  // would arm a building with nothing on screen to show for it.
  createEffect(() => {
    if (buildChord()) setBuildOpen(true);
  });
  const soloMode = (): boolean => playersMeta().length <= 1;
  /** The speed strip: replays add one gear past the live game's fastest. */
  const speeds = (): typeof SPEEDS =>
    replayMode() ? [...SPEEDS, REPLAY_SPEED] : SPEEDS;
  /** This seat has fallen while the match plays on (multiplayer). */
  const eliminated = (): boolean =>
    outcome().state === MatchState.playing &&
    playersMeta()[myPlayerId()]?.alive === false;
  const [spectating, setSpectating] = createSignal(false);
  /** The outcome card was waved away to watch the world play on. */
  const [observing, setObserving] = createSignal(false);
  const won = (): boolean => {
    const o = outcome();
    return o.state === MatchState.over && o.winner === myPlayerId();
  };
  /**
   * The one end-of-match card on screen. These states can genuinely overlap
   * — a tab that watched the storehouse fall and then slept past the room's
   * grace period is both 'over' and 'gone' — and each card is a full-screen
   * band, so without a strict order they stack into a double dialog. The
   * decided match outranks transport news: "Defeat" is the story, a swept
   * room is plumbing.
   */
  const endCard = ():
    | 'outcome'
    | 'gone'
    | 'eliminated'
    | 'replayOver'
    | undefined => {
    // A replay's outcome was decided when it was recorded; the only card
    // playback owes is the one that says the recording has run out.
    if (replayMode()) return replayOver() ? 'replayOver' : undefined;
    if (outcome().state === MatchState.over)
      return observing() ? undefined : 'outcome';
    if (netMode() && netStatus()?.state === NetState.gone) return 'gone';
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
          /* One square button, wherever a thumb is the pointer. The
             thumb rail is made of these; the Build pill stands beside
             the rail upright and has to be exactly as tall; and on a
             phone the speed button and the ☰ are the same square again
             in the opposite corner. One number rather than four
             literals, which drift the moment one of them is tuned. */
          --touch-btn: 52px;
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
           trouble, the festival banner, toasts, the campaign
           checklist — hangs in one of three top-anchored columns
           instead of at some absolute top: of its own. Before this
           they all guessed at 56px and landed on each other: the
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
             35     end-of-match cards, which outrank everything but the
                    layer that must land on them: toasts
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
           Two things are off this scale entirely, both in the browser's
           top layer and so over every number above: the quit question,
           a modal <dialog> lifted by showModal(), and the tooltips,
           lifted by the popover attribute (see tooltip.tsx). A tip has
           to read over anything it is asked about, and the top layer is
           that promise kept without a number to maintain. */

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
          display: inline-flex; align-items: center; gap: 3px;
          padding: 3px 9px; border-radius: 8px;
          font-size: 13.5px; font-weight: 500; color: #e9e6dd;
          opacity: 0.35;
        }
        /* Three digits' worth of slot per good. This strip sits dead
           centre and every count in it changes on its own, so without
           a fixed slot one barn filling past 99 walks every chip
           sideways — the most-watched row on screen, twitching at
           whatever rate the village happens to produce. (Seven chips
           now — five goods, population, the ledger — the rest of the
           goods live in the EconomyPanel.) Wrapping settles for the
           same reason: the break lands in the same place every time,
           because the widths never move.

           The digits sit at the left of that slot, against their icon:
           right-aligned, a lone 0 stood two blank characters away from
           the good it belonged to, which read as a gap between chips
           rather than as one chip. Growing rightward into the slot's
           own slack moves nothing downstream — the box is what holds
           the strip still, not which end the digits start from. */
        .hud-resources span.res .num { min-width: 3ch; text-align: left; }
        .hud-resources span.res:hover { background: rgba(255, 255, 255, 0.06); }
        .hud-resources span.res.has { opacity: 1; }
        /* Heads and beds. Ruled off from the goods because it is not one —
           it is the ceiling everything else is spent under. */
        .hud-resources span.res.pop {
          margin-left: 6px; padding-left: 13px;
          border-left: 1px solid rgba(255, 255, 255, 0.14);
          color: #c8c4b5;
        }
        /* Heads keep the right-aligned slot the goods just gave up: this
           one is "8/10", and the head count growing a digit must push
           into its own slack rather than shove the slash sideways. */
        .hud-resources span.res.pop .num { min-width: 3ch; text-align: right; }
        /* The cap is the right-hand half of "8/10": left-aligned so the
           slash stays put between two slots that each grow outward. */
        .hud-resources span.res.pop .num.cap { text-align: left; }
        .hud-resources span.res.pop.full { color: #e5c469; }
        /* The ledger chip is a real button wearing the chip's clothes:
           #ui button's own box is reset so it sits flush in the row. */
        #ui .hud-resources button.res.ledger {
          min-height: 0; margin-left: 6px; padding: 3px 9px 3px 13px;
          border: 0; border-radius: 8px;
          border-left: 1px solid rgba(255, 255, 255, 0.14);
          background: none; color: #c8c4b5;
        }
        #ui .hud-resources button.res.ledger:hover,
        #ui .hud-resources button.res.ledger.active {
          background: rgba(255, 255, 255, 0.08); color: #e9e6dd;
        }
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
        #ui button.hud-toolwants {
          min-height: 0; padding: 3px 11px; font-size: 12px;
          border-radius: 8px; color: #e5c469;
          display: inline-flex; align-items: center; gap: 7px;
        }
        .hud-toolwants .tw { display: inline-flex; align-items: center; gap: 3px; }
        .hud-toolwants .tw .num { min-width: 2ch; }

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
        /* :not(.build-fold) — every button in the strip is a tab
           except the one that isn't. Build wears .panel, and a bare
           tag selector here outranks that class, so without this the
           panel was quietly doing nothing: transparent, borderless,
           7px-cornered — a tab in all but name. */
        #ui .hud-tabs button:not(.build-fold) {
          padding: 4px 14px; font-size: 12px; font-weight: 600; letter-spacing: 0.04em;
          color: #a3a099; background: transparent; border: none; border-radius: 7px;
        }
        #ui .hud-tabs button:not(.build-fold):hover:not(.active) { color: #f0ede4; background: transparent; border: none; }
        #ui .hud-tabs button.active { background: #e5c469; color: #0e100f; }
        /* A declared grid, not a wrapping row. Shrink-to-fit made the
           card a different width per tab — a six-building tab 613px,
           a two-building one 295px — so picking a tab jumped the card's
           whole right edge by three hundred pixels and every button
           under the cursor with it.
           The frame below is one size for all three tabs, and because
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

        /* ——— The minimap card (desktop and tablet only) ———
           Last in the bottom row, so the corner is its fixed home: the
           selection card comes and goes to its left and the chart never
           moves for it. Its own auto margin pins it right when nothing
           is selected; with the selection card standing, that card's
           auto margin is already pushing, so this one stands down — two
           auto margins would split the free space and float the
           selection card into the middle of the screen. */
        .hud-minimap { pointer-events: auto; flex: 0 0 auto; margin-left: auto; padding: 8px; }
        .hud-selection + .hud-minimap { margin-left: 0; }
        .hud-minimap .minimap-canvas {
          display: block; width: var(--minimap-w, 168px); height: var(--minimap-w, 168px);
          border-radius: 9px; touch-action: none; cursor: crosshair;
        }
        /* A narrow desktop window: the build and selection cards are
           already fighting over this row (the ribbon drops columns), so
           the chart is the one that gives ground. Compact screens don't
           get here — the card doesn't render there at all. */
        @media (max-width: 1200px) { #ui { --minimap-w: 128px; } }

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
          width: var(--touch-btn); height: var(--touch-btn); padding: 0;
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
        /* The map button's live face. The canvas fills the button and
           must not take its taps — the button is the control, the chart
           is its clothing. */
        #ui .hud-touch button.map-thumb { padding: 3px; overflow: hidden; }
        .map-thumb .minimap-canvas {
          display: block; width: 100%; height: 100%;
          border-radius: 10px; pointer-events: none;
        }
        /* A warning that knows a place makes the button beat until its
           toast dies — the chart is where "where?" gets answered, and a
           glanceable alarm is most of what a hidden minimap gives up.
           A glow, not a border tint: one pixel of red border was
           invisible on a 46px button over a busy map. */
        @keyframes minimap-alarm {
          0%, 100% { box-shadow: 0 0 0 0 rgba(214, 106, 80, 0); }
          50% { box-shadow: 0 0 12px 4px rgba(214, 106, 80, 0.7); }
        }
        #ui .hud-touch button.map-thumb.alarm {
          border-color: rgba(214, 106, 80, 0.95);
          animation: minimap-alarm 1.1s ease-in-out infinite;
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
        /* Desktop keeps the card in the bottom row beside the selection
           card, where it costs the map nothing it wasn't already costing.
           The scrim belongs to the sheet, so here there is none. */
        .build-scrim { display: none; }
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
        /* Rendered under SHORT only (BuildTabs) — a phone sideways, or
           any window squashed as flat, which gets the same layout and
           the same answer. It has to be the pill to the eye as well as
           to the thumb, so it takes its whole face from the same two
           places the pill takes it (.panel, and #ui button) and states
           only what is left: the touch square, and a gap before the
           tabs begin. Nothing about weight or padding here on purpose —
           anything this sets that the pill doesn't is a way the two can
           come out different, and they have to be one button. */
        #ui .hud-tabs button.build-fold {
          margin-right: 8px;
          min-height: var(--touch-btn);
        }
        .hud-debug {
          width: 380px; max-height: 60vh;
          overflow: auto; padding: 8px 10px;
          font-family: ui-monospace, monospace; font-size: 11px;
          text-align: left;
        }
        .hud-debug table { width: 100%; border-collapse: collapse; }
        .hud-debug td, .hud-debug th { padding: 1px 4px; text-align: left; }
        .hud-violations {
          padding: 6px 14px;
          border-color: rgba(214, 106, 80, 0.5); color: #f0b9a8; max-width: 70vw;
        }
        .hud-festival { padding: 6px 12px; }
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
        /* The choices at the foot of a card read as one row, and the
           gutter between them has to be a real number: the tags sit on
           their own source lines, so the markup leaves no space at all
           between two buttons, and a won campaign card offers four of
           them — continue, again, observe, save — shoulder to shoulder.
           Side margins rather than a flex row on the card, because the
           buttons are the card's own children beside the copy, and it
           is inline flow that folds them onto a second line when the
           row outgrows the screen. */
        .end-card button { margin: 18px 6px 0; padding: 8px 24px; font-size: 14px; }
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
          #ui .hud-tabs button:not(.build-fold) { padding: 9px 18px; min-height: 40px; }
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
          /* ——— The chrome's two controls are one pair ———
             A phone's speed control is a single button — one tap cycles
             play, fast, pause — and the ☰ beside it is a single button,
             so they take the same square as each other and as the thumb
             rail in the opposite corner. They did not: the ☰ asked for
             38 and got 38x38 with the coarse block's 44px tap floor
             stretching it, while the speed button wore a panel with
             padding and came out 60x56 beside it. Two lozenges, no two
             edges agreeing.
             The panel is what the speed button wears, so the panel is
             what gets sized, and the button fills it — border-box, so
             the number here is the whole thing including the border the
             ☰ counts inside its own. */
          #ui .hud-menu-btn {
            width: var(--touch-btn); height: var(--touch-btn);
          }
          /* And when it really is a cluster it still stands exactly as
             tall: the icon's own 44 (38 sideways) plus 3px of padding
             each side plus the border is --touch-btn either way up. A
             replay's row of controls is wider than the ☰ — it is more
             controls — but its top and foot are the ☰'s. */
          #ui .hud-speed { padding: 3px 6px; }
          /* .single — set by the component when the panel really is
             holding just the one button (see speedIsSingle). A replay
             puts a fog eye and a divider in beside it and a match puts
             the ping chip there, and then it is a cluster again and
             wants its padding back. */
          #ui .hud-speed.single {
            box-sizing: border-box; padding: 0;
            width: var(--touch-btn); height: var(--touch-btn);
            border-radius: 12px;
          }
          /* A hair inside the panel's own corner, so the gold of the
             active state doesn't square off the rounding it sits in. */
          #ui .hud-speed.single button.icon {
            width: 100%; height: 100%; border-radius: 11px;
          }

          /* The strip is the sheet's foot here, not its head, and it is
             full-bleed to it: the sheet's own 10px of padding is
             exactly what would otherwise stand between the Build button
             leading the strip and the place the pill it replaces was
             standing, and the whole point of that button is that it
             does not move. Negative margins rather than an unpadded
             sheet, because the ribbon above it still wants the padding.
             The panel under it is surface enough, so the strip's own
             dark backing goes. */
          .hud-tabs {
            align-self: stretch; align-items: center;
            margin: 0 -10px -10px; padding: 0;
            background: transparent; border-radius: 0;
          }
          /* Room for every control on the strip. Measured when there
             were four tabs: at the coarse block's 18px they and Build
             came to 407px of a 373px screen upright and the last tab
             hung off the end. Three tabs clear that width even at the
             coarse padding, but the tighter one is what leaves a fourth
             room to come back. */
          #ui .hud-tabs button:not(.build-fold) { padding: 9px 12px; }
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
             that starts depends on how many rows the goods strip took.
             Those numbers were measured against the full thirteen-good
             strip (96px sideways, 126px upright); the strip is seven
             chips now — the rest moved to the EconomyPanel — so 58%
             clears the deeper case with more room than it was cut
             for, and it stays as the safe bound. Small viewport units, not
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

          /* "…Silver Mine" on the Build pill is what the placing bar
             standing beside it already says in full — the bar is a
             phone's only way out of placement, so the two are never
             apart here. Saying it twice is also what tipped the upright
             row over its width: pill plus thumb rail came to 395px of a
             370px line, and the rail wrapped underneath for exactly as
             long as a building was in hand. Build is all the pill needs
             to say while the bar is there to say the rest. The strip's
             twin is the same button (see BuildToggle) and wants the same
             silence — it only ever stands here, inside COMPACT. */
          .hud-build-pill .cost, .build-fold .cost { display: none; }

          /* Squared with whatever shares its row, both ways. The pill's
             own flex-start is a desktop rule; on a phone it hung the
             pill from the top of a row 8px taller than itself upright,
             and 14px above the placing bar's foot sideways. And the
             coarse-pointer 44px floor is the tap-target minimum, not a
             size that agrees with anything — beside a rail of 52px
             squares the pill read as the odd one out, so it takes the
             rail's own number. */
          #ui .hud-build-pill { align-self: flex-end; min-height: var(--touch-btn); }

          /* ——— The minimap is a sheet here, never a card ———
             A phone has no corner to spare: upright, the bottom is a
             full-width column; sideways, height is the whole budget.
             So the chart costs the screen nothing while closed — one
             button in the thumb rail — and takes the middle of it while
             open, the way the build menu does sideways. A tap on the
             chart glides the camera there and the sheet dismisses
             itself: the place it just showed you is what you came for.
             Bottom-anchored because the button that opened it is at the
             bottom, and sized by the tighter axis so both orientations
             get the same square. */
          /* The dim lives on the scrim, not on a sheet shadow: the sheet
             wears .panel, and #ui .panel's own shadow outranks a bare
             class here — a spread scrim declared on the sheet silently
             lost that fight and the world stayed full bright behind an
             open chart. The scrim is nobody's panel, so nothing contests
             it. */
          .minimap-scrim {
            position: fixed; inset: 0; pointer-events: auto; z-index: 19;
            background: rgba(6, 8, 7, 0.5);
          }
          /* #ui-prefixed to outrank #ui .panel's glass: the chart's own
             frame should be opaque, not the map showing through a chart
             of itself. */
          #ui .hud-minimap-sheet {
            position: fixed; z-index: 20;
            bottom: calc(var(--hud-margin) + var(--safe-bottom));
            left: 50%; transform: translateX(-50%);
            padding: 8px; pointer-events: auto;
            background: rgba(11, 13, 12, 0.97);
          }
          .hud-minimap-sheet .minimap-canvas {
            display: block;
            /* Small viewport units, like every other sheet: the chart
               must not resize under the finger as the URL bar goes. */
            width: min(78vw, 58vh, 340px);
            width: min(78vw, 58svh, 340px);
            height: auto; aspect-ratio: 1;
            border-radius: 9px; touch-action: none;
          }
          /* Over the chart's corner rather than on a header row: a
             header is a row of height, and sideways there is none to
             give. The tap that matters most — anywhere on the map —
             closes the sheet too, so this is the way out for a player
             who only came to look. */
          #ui .hud-minimap-sheet .minimap-close {
            position: absolute; top: 14px; right: 14px;
            width: 38px; height: 38px; min-height: 0; padding: 0;
            display: grid; place-items: center;
            background: rgba(14, 16, 15, 0.75);
          }
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

          /* A stack of full-width cards standing on one row of controls.
             The thumb rail and the Build pill are each a single row of
             buttons, and giving them a line apiece spent a band of map
             to say on two lines what one line says — with the pill left
             and the rail right, so nothing in the corner of the screen
             agreed with anything else in it.
             Wrap and order rather than new markup: the cards each claim
             a whole line, the two controls fall in together beneath
             them, and flex-end levels their bottom edges against the
             same margin the cards sit on. */
          .hud-bottom { flex-flow: row wrap; align-items: flex-end; gap: 8px; }
          /* border-box, because #ui is otherwise content-box: a stacked
             column got its width from align-items:stretch, which sizes
             the border box, and a wrapped row gets it from a basis,
             which sizes the content box. On the default the build
             card's own padding and border landed outside the margin and
             sliced the Woodcutter's price off the right edge. */
          .hud-bottom > .hud-placing,
          .hud-bottom > .hud-build,
          .hud-bottom > .hud-selection { box-sizing: border-box; flex: 1 0 100%; }
          .hud-selection { margin-left: 0; width: auto; }
          /* The thumb rail joins the flow instead of floating over it.
             Fixed at 38vh it was a guess about how tall the cards would
             be, and a barracks with touch-sized buttons is 370px of
             card — the rail's ✕ ended up inside it. In the flow it
             cannot be wrong: it rides up when the cards above it grow.
             Laid across rather than down, because a column of three
             would be a third of the stack. */
          .hud-touch {
            position: static; flex-direction: row;
            margin-left: auto;
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
          .hud-resources span.res { padding: 2px 7px; font-size: 12.5px; gap: 2px; }
          .hud-resources span.res .num,
          .hud-resources span.res.pop .num { min-width: 2.5ch; }
          #ui .hud-speed button.icon { width: 42px; height: 38px; }
          #ui .hud-speed button { min-height: 38px; }

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
          /* One row, and it does not wrap. A landscape phone is inside
             both blocks — 667x375 is narrow and short at once — so the
             line break the upright rules hand the cards has to be
             undone here, not just the direction. (The controls need no
             undoing: they are markup, not order, and the upright markup
             only answers to a screen that is narrow and tall.) */
          .hud-bottom {
            flex-flow: row nowrap; align-items: flex-end;
            max-height: var(--hud-bottom-h); gap: 8px;
            /* The right margin is the rail's now: it stands down the
               edge here (below), and a column on the right and a
               selection card on the right want the same corner. The
               cards stop short of it rather than the rail floating over
               them — floating is what put the ✕ on a building's health
               the last time these two shared a corner. */
            right: calc(
              var(--hud-margin) + var(--safe-right) + var(--touch-btn) + 10px
            );
          }
          .hud-bottom > .hud-placing,
          .hud-bottom > .hud-build { flex: 0 1 auto; }
          .hud-bottom > .hud-selection { flex: 0 0 auto; }
          /* The same length again on the children, not 100%: a
             percentage max-height resolves against a parent's height,
             and this parent has only a max-height, so the percentage
             would come out as no limit at all — which is exactly how a
             369px selection card ended up standing on a 375px screen. */
          /* The two exclusions are the two that have left the row: the
             build menu is a sheet at this size and the thumb rail is a
             fixed column down the edge, and capping either to the row's
             height puts back exactly the limit it left to escape. The
             rail showed what that costs — four buttons want 204px, the
             cap on a 360px screen is 187, and the column being anchored
             at its foot pushed the overflow downward: Muster hung three
             pixels off the bottom of the screen. */
          .hud-bottom > *:not(.hud-build):not(.hud-touch) {
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
          /* ——— The build menu is a sheet here, not a card ———
             Sharing the bottom row is what a desktop can afford. On a
             phone held sideways the same card was a third of the screen
             for as long as it was open — and open is precisely when you
             are looking at the ground to decide where a thing goes. The
             one place it does not have to compete for is the moment it
             is being read: nothing else on the HUD matters while you are
             picking a building.
             So it leaves the row and covers the map, the way the tech
             tree already does at this size, and it is gone again the
             instant a building is picked (place() folds it) or the scrim
             is tapped. What the map pays is a third of the screen for as
             long as the menu is open, instead of a third of every minute
             it is left open — and the cells get room to be tapped
             properly on the way. Same markup throughout: this is the
             card, moved. */
          .hud-build {
            position: fixed;
            bottom: calc(var(--hud-margin) + var(--safe-bottom));
            right: calc(var(--hud-margin) + var(--safe-right));
            left: calc(var(--hud-margin) + var(--safe-left));
            z-index: 20;
            /* As tall as its own tab needs and no taller — four cells in
               the Village tab is four cells, not the two declared rows
               the bottom card always reserved whether or not anything
               stood in the second one. Past the cap the ribbon scrolls,
               which is what the War tab does on the shortest screens.
               The top edge stays auto for that: pinning both edges would
               stretch the sheet to fill, which is how the old card came
               to be mostly empty. It grows upward from the bottom
               instead, because that is where the Build pill that opened
               it stands and where the thumb already is — a menu that
               answers a bottom-left tap by appearing at the top of the
               screen is a menu you have to go and find.
               The ceiling is the goods strip: the one readout that has
               to stay legible while you spend what it counts. */
            top: auto;
            max-height: calc(100vh - 76px - var(--hud-margin) - var(--safe-top) - var(--safe-bottom));
            max-height: calc(100svh - 76px - var(--hud-margin) - var(--safe-top) - var(--safe-bottom));
            /* Opaque, unlike the cards: at 0.72 the map beneath showed
               through a full-screen panel and the prices became unreadable.
               The spread shadow is what dims the world behind it. */
            background: rgba(11, 13, 12, 0.97);
            box-shadow: 0 0 0 100vmax rgba(6, 8, 7, 0.5);
          }
          .build-scrim {
            display: block; position: fixed; inset: 0;
            pointer-events: auto; z-index: 19;
          }
          /* The ribbon is as many rows as the tab has, not a declared
             two: the Village tab's four buildings are one row here, and
             the sheet is the height of one row. Only a tab that outgrows
             the sheet's cap scrolls. */
          .hud-build .hud-items { flex: 0 1 auto; min-height: 0; height: auto; }
          /* Down the right edge, not across the band above the cards.
             Across was a way of clearing them — a column of four is
             208px and the band between the goods strip and the cards is
             barely a hundred — but it left the buttons stranded in the
             middle of the screen agreeing with nothing, and a rail read
             as a rail in neither orientation. Sideways there is width to
             spare and height to count, so the column takes the width:
             it hangs from the bottom margin like the upright row hangs
             from the right one, in the corner the thumb curls around,
             and the cards give up the strip it stands in rather than
             passing under it.
             position: fixed is restated because the upright block sets
             static and an iPhone SE sideways — 667x375 — is inside both
             of them. It kept the static, sat in the row as a flex item,
             and the two lengths below did nothing on the very phone
             they were measured for. */
          .hud-touch {
            position: fixed; flex-direction: column;
            bottom: calc(var(--hud-margin) + var(--safe-bottom));
            right: calc(var(--hud-margin) + var(--safe-right));
          }
          #ui { --touch-btn: 46px; }
          #ui .hud-touch button { border-radius: 12px; }
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
            <For each={HUD_GOODS}>
              {good => (
                <span
                  class="res"
                  classList={{has: (stock()[good] ?? 0) > 0}}
                  {...tooltip(() => <GoodTip good={good} />)}
                >
                  <GoodIcon good={good} />{' '}
                  <span class="num">{stock()[good] ?? 0}</span>
                </span>
              )}
            </For>
            <span
              class="res pop has"
              classList={{full: population().pop >= population().cap}}
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
            {/* The ledger: the rest of the goods live behind this chip.
              A button styled as a chip, ruled off like population — it
              is not a good either, it is where the other twelve went. */}
            <button
              class="res ledger has"
              classList={{active: economyPanelOpen()}}
              {...tooltip(() => (
                <TextTip
                  title="The Ledger"
                  body="Every good the village owns, grouped — arms, tools, and all. The strip keeps only the handful you watch constantly."
                />
              ))}
              onClick={() => setEconomyPanelOpen(!economyPanelOpen())}
            >
              <LedgerIcon />
            </button>
          </div>
        </div>

        <div class="hud-chrome">
          {/* The speed cluster comes first and the ☰ last: in a
          right-anchored row that pins the menu button to the corner
          and lets the chips beside it grow away into open sky. */}
          <Show when={!netMode() || netStatus()?.state === NetState.ok}>
            <div class="hud-speed panel" classList={{single: speedIsSingle()}}>
              <Show when={netMode() && netStatus()?.state === NetState.ok}>
                <span
                  class="net-chip"
                  {...tooltip(() => (
                    <TextTip
                      title="Connection"
                      body="Round-trip to the relay and prediction lead."
                    />
                  ))}
                >
                  ⇄{' '}
                  <span class="num">
                    {(netStatus() as {rttMs: number}).rttMs}
                  </span>
                  ms
                </span>
              </Show>
              <Show when={!netMode()}>
                <Show when={replayMode()}>
                  <span
                    class="net-chip"
                    {...tooltip(() => (
                      <TextTip
                        title="Replay"
                        body="Watching a recording — orders have no effect."
                      />
                    ))}
                  >
                    Replay
                  </span>
                  {/* The recording is a finished match, so lifting the fog is
                spectating rather than cheating — the live game keeps this
                behind the admin panel. Render-only: playback is unchanged. */}
                  <button
                    class="icon"
                    classList={{active: !fogEnabled()}}
                    {...tooltip(() => (
                      <TextTip
                        title={
                          fogEnabled() ? 'Reveal the valley' : 'Fog of war'
                        }
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
                      {s => (
                        <button
                          class="icon"
                          classList={{active: speed() === s.value}}
                          {...tooltip(() => (
                            <TextTip title={s.label} body={gearBody(s)} />
                          ))}
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
                    classList={{active: speed() !== 1}}
                    {...tooltip(() => (
                      <TextTip
                        title={
                          speeds().find(s => s.value === speed())?.label ??
                          'Speed'
                        }
                        body={
                          'Taps cycle play, fast forward, pause.' +
                          (hasKeyboard() ? ' (P, + / −)' : '')
                        }
                      />
                    ))}
                    onClick={() => {
                      const order = replayMode()
                        ? [1, 3, REPLAY_SPEED.value, 0]
                        : [1, 3, 0];
                      const next =
                        order[(order.indexOf(speed()) + 1) % order.length]!;
                      props.onSpeed(next);
                    }}
                  >
                    {(() => {
                      const s =
                        speeds().find(x => x.value === speed()) ?? SPEEDS[1]!;
                      return <s.icon />;
                    })()}
                  </button>
                </Show>
              </Show>
            </div>
          </Show>
          <button
            class="hud-menu-btn panel"
            classList={{active: menuOpen()}}
            {...tooltip(() => (
              <TextTip title="Menu" body="Save, load, or leave the village." />
            ))}
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
            <MissionPanel onSpeed={props.onSpeed} />
          </div>

          {/* Centre rail, under the goods strip: what the village is busy
            with, and what has gone wrong. Ordered by how long each stays
            — a study runs for minutes, a broken connection is meant to
            be read and gone. */}
          <div class="hud-rail center">
            <Show when={techs().active}>
              {a => (
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
                    style={{
                      width: `${Math.round((1 - a().ticksLeft / a().totalTicks) * 100)}%`,
                    }}
                  />
                  <span class="label">⚗ {techName(a().tech)}</span>
                </button>
              )}
            </Show>
            <Show when={techs().festivalTicksLeft > 0}>
              <div class="hud-festival panel">
                Festival! Everyone works faster
              </div>
            </Show>
            {/* Posts standing open for tools. In the rail, not the strip,
              for the research chip's reason: a want coming and going
              must not shunt the goods sideways. Click opens the ledger. */}
            <Show when={Object.keys(toolWants()).length > 0}>
              <button
                class="hud-toolwants panel"
                {...tooltip(() => (
                  <TextTip
                    title="Posts want tools"
                    body="Buildings standing open until the Smith forges (or a hauler brings) the tool their worker needs. Sites count too — each borrows a hammer while it rises."
                  />
                ))}
                onClick={() => setEconomyPanelOpen(true)}
              >
                wants{' '}
                <For each={goodEntries(toolWants())}>
                  {([good, n]) => (
                    <span class="tw">
                      <GoodIcon good={good} size={12} /> {n}
                    </span>
                  )}
                </For>
              </button>
            </Show>
            <Show
              when={netMode() && netStatus()?.state === NetState.disconnected}
            >
              <div class="hud-nettrouble panel">
                Connection to the server lost. Reconnecting… — your seat is
                held, and the match rides out even a server restart.
              </div>
            </Show>
            <Show when={invariantViolations().length > 0}>
              <div class="hud-violations panel">
                {invariantViolations().length} invariant violation(s) — see
                console
              </div>
            </Show>
          </div>

          {/* Right rail, under the chrome it must not cover: notices, then
            the diagnostics table dev builds open. */}
          <div class="hud-rail right">
            <div class="hud-toasts">
              <For each={toasts()}>
                {t => (
                  <div
                    class="panel toast"
                    classList={{clickable: !!t.focus}}
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
                      {j => (
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
              {/* Everything the local disk is party to, under one gate:
                only a solo game's world is this device's to write down or
                to put back. A match lives on the server and a replay is
                already a recording. */}
              <Show when={isSolo()}>
                <button
                  onClick={() => {
                    props.onSave();
                    setMenuOpen(false);
                  }}
                >
                  Save village
                </button>
                {/* Any time in a solo match: the log runs from boot, so a
                  mid-match save records everything up to this moment and
                  playback pauses there. Multiplayer still records on the
                  server, which only hands the log out once the match is
                  decided — its button lives on the end card. */}
                <button
                  onClick={() => {
                    props.onSaveReplay();
                    setMenuOpen(false);
                  }}
                >
                  Save replay
                </button>
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
                    void latestSaveName().then(name => {
                      setLastSave(name);
                      if (name === null) return;
                      // The save's name is the whole address, like a
                      // replay's: the world lives in OPFS, and a reload of
                      // this URL comes back into the same village. force
                      // because loading the save this match already booted
                      // from is the same URL, and the router would otherwise
                      // call it the screen it is already on.
                      goto('?load=' + encodeURIComponent(name), {force: true});
                    });
                  }}
                >
                  Load last save
                </button>
              </Show>
              <Show when={fs.offerable()}>
                <button
                  aria-pressed={fs.active()}
                  // A chord rather than a letter, so it cannot be bolded
                  // into the label the way B and H are — see
                  // bindFullscreenKey for why fullscreen is the one
                  // shortcut here that spends no letter.
                  title={
                    (fs.active() ? 'Leave full screen' : 'Fill the screen') +
                    (hasKeyboard() ? ' (Alt+Enter)' : '')
                  }
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
                    (hasKeyboard() && nothingSelected() ? ' (M)' : '')
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
                  onInput={e => setVolumePref(Number(e.currentTarget.value))}
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
        {/* Upright, the cards stack and these two stand on the last line
            of them; every other shape lays the row out in a line and the
            rail floats clear of it above. Rendered from one end of the row
            or the other rather than placed once and moved with a CSS
            `order`, so what a screen reader walks is the order it is
            looking at. Only ever one of the two calls renders. */}
        <Show when={!isUpright()}>
          <BottomControls />
        </Show>

        <Show when={hasThumb() && !replayMode() && placing()}>
          {type => (
            <div class="hud-placing panel">
              <span class="what">
                <MalletIcon /> Tap the map to place{' '}
                <b>{buildingName(type())}</b>
              </span>
              <button class="cancel" onClick={() => place(null)}>
                ✕ Cancel{hasKeyboard() ? ' (Esc)' : ''}
              </button>
            </div>
          )}
        </Show>

        {/* A replay takes no orders, so it offers no build card: the map
            and the goods strip are the whole story. The pill this folds
            down to lives in BottomControls, at the foot of the row —
            never both. */}
        <Show when={buildVisible() && !replayMode()}>
          {/* The sheet's backstop, and only ever a sheet's: #ui is
              pointer-events:none, so without something taking the taps a
              finger aimed beside the open menu would land on the map and
              order the selection somewhere. Rendered always, shown only
              where the card becomes a sheet (the CSS below).
              Click and nothing else. Closing on touchstart as well looked
              like belt and braces and was the very hole this is here to
              plug: the scrim unmounts under the finger, and what the map
              then receives is a pointerup it never saw a pointerdown for
              — plus the compatibility mousedown/mouseup/click behind it —
              because the element that would have taken them is gone by
              the time they are dispatched. Waiting for the click leaves
              the scrim standing until every event of that tap has been
              delivered to it. */}
          <div
            class="build-scrim"
            aria-hidden="true"
            onClick={() => setBuildOpen(false)}
          />
          <div class="hud-build panel" classList={{chording: buildChord()}}>
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
            {/* Head of the card on a desktop, foot of the sheet on a
                phone — see BuildTabs. Only one of the two renders. */}
            <Show when={!isCompact()}>
              <BuildTabs />
            </Show>
            <div class="hud-items">
              <For each={BUILD_GROUPS[activeTab()]!.types}>
                {type => (
                  <TipWrap tip={() => <BuildingTip type={type} />}>
                    <Show
                      when={unlocked(type)}
                      fallback={
                        <button disabled>
                          <LockIcon />{' '}
                          <Key label={buildingName(type)} k={buildKey(type)} />
                        </button>
                      }
                    >
                      <button
                        classList={{active: placing() === type}}
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
            <Show when={isCompact()}>
              <BuildTabs />
            </Show>
          </div>
        </Show>

        <SelectionPanel
          onTrain={props.onTrain}
          onCancelTrain={props.onCancelTrain}
          onHire={props.onHire}
          onDeselect={props.onDeselect}
          onArmOrder={props.onArmOrder}
          onClearRally={props.onClearRally}
          onSell={props.onSell}
          onRepair={props.onRepair}
          onTogglePause={props.onTogglePause}
          onSetRecipe={props.onSetRecipe}
          onEnqueueForge={props.onEnqueueForge}
          onCancelForge={props.onCancelForge}
        />

        {/* The standing minimap — desktop and tablet, where the bottom-right
            corner can afford a card that never leaves. Compact screens get
            the sheet below instead; the Show also parks the paint loop
            while the card is off. Press-and-drag steers the camera. */}
        <Show when={!isCompact()}>
          <div class="hud-minimap panel">
            <Minimap source={props.minimap} mode={MinimapMode.pan} />
          </div>
        </Show>

        <Show when={isUpright()}>
          <BottomControls />
        </Show>
      </div>

      <Show when={economyPanelOpen()}>
        <EconomyPanel />
      </Show>
      <Show when={techPanelOpen()}>
        <TechTreePanel onResearch={props.onResearch} />
      </Show>

      {/* The minimap sheet — small screens only (the ☰-family panel state
          drives it, so Esc and the one-popup rule both apply). A tap on
          the chart glides the camera there and closes it; the scrim is
          the build sheet's: click only, so the map under a departing
          scrim never receives half a tap. */}
      <Show when={isCompact() && minimapOpen()}>
        <div
          class="minimap-scrim"
          aria-hidden="true"
          onClick={() => setMinimapOpen(false)}
        />
        <div class="hud-minimap-sheet panel">
          <Minimap
            source={props.minimap}
            mode={MinimapMode.jump}
            onNavigate={() => setMinimapOpen(false)}
          />
          <button
            class="minimap-close"
            aria-label="Close the map"
            onClick={() => setMinimapOpen(false)}
          >
            ✕
          </button>
        </div>
      </Show>

      <Show when={endCard() === 'gone'}>
        <div class="hud-end">
          <div class="panel end-card">
            <h1>The match is gone</h1>
            <p>
              The server no longer knows this match. A room stands for a few
              minutes after its last player leaves, then winds down — and this
              one wound down. It can't be resumed.
            </p>
            <button onClick={() => goto(location.pathname)}>
              Back to the menu
            </button>
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
              {next => (
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
                  goto(location.search, {force: true});
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
              <button onClick={() => setObserving(true)}>
                Observe the rest
              </button>
            </Show>
            {/* The recording runs from boot to this moment; saving names
                it by the clock and files it for the menu's Replays shelf.
                Solo, the world lives on behind the card, so a later save
                (from the menu, after observing) simply records more.
                Multiplayer records on the server, which hands each seat
                its copy — but only for a decided match, which this card
                is the proof of. */}
            <button onClick={() => props.onSaveReplay()}>Save replay</button>
            {/* The way out. No confirmation: the match is decided, so
                there is nothing left to abandon — the only thing this
                card holds that the menu doesn't is the unsaved replay,
                and its button sits right here. */}
            <button onClick={() => goto(location.pathname)}>
              Quit to menu
            </button>
          </div>
        </div>
      </Show>

      <Show when={endCard() === 'replayOver'}>
        <div class="hud-end">
          <div class="panel end-card">
            <h1>Replay over</h1>
            <p>The recording ends here.</p>
            <button onClick={() => goto(location.search, {force: true})}>
              Watch again
            </button>
            <button onClick={() => goto(location.pathname)}>
              Back to the menu
            </button>
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
          ref={el => queueMicrotask(() => el.isConnected && el.showModal())}
          // Esc lands in controls.ts first (keydown outruns the browser's
          // cancel) and unmounts the card; this catches any close the game
          // did not order, so the signal never says open over a closed
          // dialog.
          onClose={() => setQuitConfirm(false)}
        >
          <h1 id="quit-title">Leave the match?</h1>
          <p>{quitStakes()}</p>
          <div class="confirm-actions">
            <button onClick={() => setQuitConfirm(false)}>
              Stay{hasKeyboard() ? ' (Esc)' : ''}
            </button>
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
