import type * as THREE from 'three';
import type {WorldMirror} from '../app/mirror';
import type {SimHost} from '../app/simHost';
import {play} from '../audio/audio';
import type {BuildingSnap} from '../protocol/messages';
import type {FogQuery} from '../render/fogOfWar';
import type {GhostPlacement} from '../render/ghost';
import type {HeightField} from '../render/heightField';
import type {SceneSync} from '../render/sceneSync';
import type {Enum} from '../shared/enum.ts';
import {inBounds, tileIdx} from '../shared/grid';
import {clamp} from '../shared/math';
import * as BuildingState from '../sim/buildingStateEnum.ts';
import * as CommandKind from '../sim/commandKindEnum.ts';
import {HIRE_SERF_COST} from '../sim/defs/balance';
import {buildingDef, gatherRecipeOf} from '../sim/defs/buildings';
import * as BuildingTypeId from '../sim/defs/buildingTypeIdEnum.ts';
import * as GoodId from '../sim/defs/goodIdEnum.ts';
import {UNIT_DEFS} from '../sim/defs/units';
import {isPlayerOwner} from '../sim/entities';
import {playMax, playMin} from '../sim/map';
import {canPlace, placementRefusal} from '../sim/world';
import {buildAffordable, buildUnlocked, buildingForKey} from '../ui/buildMenu';
import {
  HIRE_KEY,
  HOLD_KEY,
  PATROL_KEY,
  RALLY_KEY,
  RESEARCH_KEY,
  canHire,
  canRally,
  canTrain,
  trainingForKey,
  unitTechGate,
} from '../ui/commands';
import {fullscreen, guardEsc} from '../ui/fullscreen';
import {
  buildingName,
  goodName,
  RESOURCE_NAMES,
  techName,
  unitName,
} from '../ui/names';
import * as OrderMode from '../ui/orderModeEnum.ts';
import {rosterOf, sameRoster, type SelectedUnit} from '../ui/roster';
import {nudgeSpeed} from '../ui/speedControl';
import {
  bandArm,
  buildChord,
  debugOpen,
  fogEnabled,
  lastAlert,
  muted,
  myPlayerId,
  netMode,
  openPanel,
  orderMode,
  placing,
  population,
  pushToast,
  quitConfirm,
  replayMode,
  selectedBuilding,
  setBandArm,
  setBuildAim,
  setBuildChord,
  setDebugOpen,
  setFogEnabled,
  setOpenPanel,
  setOrderMode,
  setPlacing,
  setQuitConfirm,
  setSelectedBuilding,
  setSelection,
  setSelectionGroup,
  setSelectionOwner,
  setSelectionUnits,
  setTechPanelOpen,
  stock,
  techPanelOpen,
  techs,
  toggleMuted,
  viewSeat,
} from '../ui/store';
import * as ControlGroupKind from './controlGroupKindEnum.ts';
import {groupEmpty, keyDigit, matchingGroup, type ControlGroup} from './groups';
import {capturePointer} from './mouseCapture';
import {
  screenToBuilding,
  screenToGround,
  worldToScreen,
  type BuildingHeights,
  type BuildingProbe,
} from './picking';
import {foreignChord, typingInto} from './typing';

type BuildingTypeId = Enum<typeof BuildingTypeId>;
type OrderMode = Enum<typeof OrderMode>;

/**
 * Which of the move orders a click sends: `false` the plain walk, `true`
 * the attack-move, `'half'` the quiet-then-live one a finger taps, and
 * `'patrol'` the beat walked back and forth. The wire spells the last one
 * as its own flag (see SimCommand); here it rides in the same slot as the
 * others because every order site picks exactly one.
 */
type MoveOrder = boolean | 'half' | 'patrol';

/** The move order an armed A, M or P stands for. Never called with the
 * rally flag, which plants rather than moves. */
function orderOf(order: OrderMode): MoveOrder {
  if (order === OrderMode.attack) return true;
  if (order === OrderMode.patrol) return 'patrol';
  return false;
}

const CLICK_RADIUS_PX = 16;
const DRAG_THRESHOLD_PX = 4;
const TOUCH_SLOP_PX = 12;
/** Repeat-tap window for escalating a half move into a full attack-move.
 * Generous on radius: two quick presses of the same finger land farther
 * apart than one aimed tap. */
const DOUBLE_TAP_MS = 350;
const DOUBLE_TAP_RADIUS_PX = 24;
/** Double-click window for widening a click to a whole kind. Tighter than
 * the touch pair above on both counts: a mouse's two clicks land on the
 * same pixel, and the OS default for this gesture is around half a second
 * everywhere. What really decides it is the unit under both clicks. */
const DOUBLE_CLICK_MS = 400;
const DOUBLE_CLICK_RADIUS_PX = 8;
/** Repeat-press window for the control-group number that rides the camera
 * out to its squad. Shared by keyboard and nothing else, so it can be as
 * generous as the keyboard's own repeat feel wants. */
const GROUP_RECALL_MS = 450;

/**
 * The A–Z letter a keypress means, or '' for anything else.
 *
 * `key` before `code`, which is the opposite of the usual game answer, and
 * on purpose: every letter this game binds is one the HUD prints — the gold
 * W inside **W**oodcutter. `key` is the letter on the keycap under the
 * player's finger, whatever their layout, so it is the one that agrees with
 * what they just read. `code` is the physical QWERTY position, which is the
 * right answer for WASD (a square has to stay a square) and the wrong one
 * here: it would send a Dvorak player hunting for their comma.
 *
 * `code` still backstops it, because `key` is the softer of the two — it
 * comes back 'Dead' mid-accent and empty from some synthetic and remote
 * input paths, and a shortcut that quietly stops existing is worse than one
 * that lands a row over.
 */
function keyLetter(e: KeyboardEvent): string {
  if (e.key.length === 1) {
    const k = e.key.toUpperCase();
    if (k >= 'A' && k <= 'Z') return k;
  }
  return e.code.startsWith('Key') ? e.code.slice(3) : '';
}

/** Kind codes that count as army for the select-army shortcut. */
const MILITARY_CODES = new Set<number>(
  Object.values(UNIT_DEFS)
    .filter(d => d.combat !== undefined)
    .map(d => d.id),
);

/**
 * Left click / drag: select player units; double-click one to take every
 * unit of that kind on screen. Right click: move order for the
 * current selection. Build-menu placement mode overrides both: hover shows a
 * validity-tinted ghost, left click places, right click / Esc cancels. A
 * small mode machine avoids the classic click-vs-drag papercuts; the band
 * rectangle is an HTML div, not WebGL.
 *
 * The keyboard adds two more modes on the same machine (see #onKey): A or M
 * with people selected arms an attack-move or a plain move for the next
 * click, and B opens a build chord whose next letter arms a building. Both
 * are modes that claim the next click, so both are mutually exclusive with
 * placement and with each other, and Esc unwinds them one at a time.
 *
 * The number row is StarCraft's ten control groups (#controlGroup): Ctrl+N
 * stamps, Shift+N adds, N calls back, N twice rides the camera out. What is
 * stamped is whatever is selected, so a number holds either a band of
 * people or one of your buildings — a barracks on 4 means 4 opens its card
 * from anywhere, which is how a soldier gets hired without the trip back.
 * They are the one binding here that is not a mode at all — no click is
 * claimed, nothing has to be unwound, and Esc has no business with them.
 *
 * The minimap takes the same order gestures the map does (see
 * orderAtMapPoint): right-click it for a plain move, or click it with A or
 * M armed for the attack-move or the move. A squad can be sent across the
 * valley without the camera going with them, which is what a chart is for.
 *
 * Touch speaks selection-first, like every phone RTS: tap a unit to select,
 * then tap the ground to send the selection there as a half attack-move —
 * plain for the front half of the route so a retreat breaks clean, live for
 * the back half so soldiers still fight where they were sent (an order
 * pulse + a tick of haptics confirm it). Tapping the same spot again within
 * a beat escalates the order to a full attack-move for a deliberate charge.
 * A tap on one of your own buildings opens that building instead of
 * marching onto it. The HUD's marquee button arms
 * a one-shot band select — the next finger drag draws the band while the
 * camera holds still — and its army button grabs every soldier at once.
 * Placement has no Esc and no right click there either, so the way out of
 * an armed building is the HUD's cancel bar, which comes back through
 * setPlacement(null).
 */
export class Controls {
  #canvas: HTMLCanvasElement;
  #camera: THREE.Camera;
  #sync: SceneSync;
  #host: SimHost;
  #mirror: WorldMirror;
  #ghost: GhostPlacement;
  #heights: HeightField;
  /** Fog test, so placement cannot probe ground nobody has scouted. */
  #fog: FogQuery | null = null;
  /**
   * How tall the renderer draws each building, for the pick that reaches up
   * a castle's walls instead of stopping at the plate it stands on. Null
   * until the renderer is wired in (and in tests), which costs nothing but
   * the reach: the probe then answers with no ceiling to climb to, and a
   * pick is the plain footprint hit it always was.
   */
  #buildingHeights: BuildingHeights | null = null;
  /** The map/height pair screenToBuilding walks, built once — a pick runs
   * every frame the pointer moves, and this would be an allocation each. */
  #probe: BuildingProbe;
  #selection = new Set<number>();
  /**
   * Control groups, bound the way both StarCrafts bind them: digit → the
   * unit ids stamped onto it, or the one building (see ControlGroup).
   *
   * They live here beside the selection rather than in the store because
   * they are lists of ids and ids die: prune() already weeds the dead out
   * of the selection every frame, and a group is exactly the same problem —
   * a razed barracks as much as a fallen knight.
   * The HUD gets the one crumb it needs (selectionGroup) pushed to it.
   */
  #groups = new Map<number, ControlGroup>();
  /** What the card was last told the selection is, to compare against. */
  #roster: readonly SelectedUnit[] = [];
  /** The publish #roster was read out of; -1 until the first one. */
  #rosterSeq = -1;
  /** The last group number called back, for the second press that rides
   * the camera out to it instead of re-selecting what is already selected. */
  #lastRecall: {digit: number; time: number} | null = null;
  /**
   * The last press that landed on one of your units — click or tap alike.
   * A second one on the same unit inside the window widens the selection to
   * that whole kind on screen; the id is what really decides it, so the two
   * input styles can share the record and differ only in how forgiving
   * their window and radius are.
   */
  #lastUnitPress: {id: number; px: number; py: number; time: number} | null =
    null;
  #dragStart: {x: number; y: number} | null = null;
  #dragging = false;
  #bandEl: HTMLDivElement;
  /**
   * Every listener this Controls registers, on one signal — window and
   * canvas alike. The canvas ones matter as much as the window one: a
   * match's canvas is detached when the match ends, but detached is not
   * dead, because three keeps GPU buffers in WeakMaps keyed by its own
   * module-level geometries and those live as long as the page. A canvas
   * still reachable that way would hold these closures, and they hold the
   * sim worker, the mirror and the scene.
   */
  #off = new AbortController();
  #hoverUnit = -1;
  #hoverBuilding = -1;
  /** Last pointer position + dirty flag: pointermove can fire at hundreds
   * of Hz, so the O(units) hover scan runs at most once per frame, from
   * the rAF loop (updateHoverIfDirty). */
  #hoverX = 0;
  #hoverY = 0;
  #hoverDirty = false;
  #hoverIsTouch = false;
  // Scratch objects for the per-unit screen-space scans.
  #scratchPos = {x: 0, y: 0};
  #scratchScreen = {x: 0, y: 0};
  #touchOrigin: {x: number; y: number} | null = null;
  /** The last ground move a tap ordered — a repeat tap on the spot inside
   * the double-tap window escalates it to a full attack-move. Screen point
   * for the "same spot" test, ordered tile so the escalation re-aims at
   * exactly what the first tap ordered even if the finger drifted. */
  #lastMoveTap: {
    px: number;
    py: number;
    tileX: number;
    tileY: number;
    time: number;
  } | null = null;
  /** A marquee drag in flight (armed by the HUD's band button). */
  #bandTouch = false;
  /** A finger past the slop, dragging the valley rather than pointing at
   * it — see #onMove and updateHoverIfDirty. */
  #touchPan = false;
  /**
   * The camera, as much of it as this file has business touching: the touch
   * gate it closes while a marquee drag owns the finger, and the glide the
   * jump keys ride. Structural rather than the CameraRig type so a test can
   * hand in the two members instead of a renderer.
   */
  #rig: {
    touchPanEnabled: boolean;
    glideTo: (x: number, z: number) => void;
  } | null;

  constructor(
    canvas: HTMLCanvasElement,
    camera: THREE.Camera,
    sync: SceneSync,
    host: SimHost,
    mirror: WorldMirror,
    ghost: GhostPlacement,
    heights: HeightField,
    rig?: {touchPanEnabled: boolean; glideTo: (x: number, z: number) => void},
  ) {
    this.#canvas = canvas;
    this.#camera = camera;
    this.#sync = sync;
    this.#host = host;
    this.#mirror = mirror;
    this.#ghost = ghost;
    this.#heights = heights;
    this.#rig = rig ?? null;
    this.#probe = {
      idAt: (x, z) => {
        const tx = Math.floor(x);
        const ty = Math.floor(z);
        if (!inBounds(tx, ty, this.#mirror.map.size)) return -1;
        return this.#mirror.map.buildingAt[
          tileIdx(tx, ty, this.#mirror.map.size)
        ]!;
      },
      heightOf: id => this.#buildingHeights?.heightOf(id) ?? 0,
      baseOf: id => this.#buildingHeights?.baseOf(id) ?? 0,
      ceiling: () =>
        this.#buildingHeights?.ceiling() ?? Number.NEGATIVE_INFINITY,
    };

    this.#bandEl = document.createElement('div');
    this.#bandEl.style.cssText =
      'position:fixed; border:1px solid #bf4342; background:rgba(191,67,66,0.12); display:none; pointer-events:none; z-index:10;';
    document.body.appendChild(this.#bandEl);

    const signal = this.#off.signal;
    canvas.addEventListener('contextmenu', e => e.preventDefault(), {signal});
    canvas.addEventListener('pointerdown', this.#onDown, {signal});
    canvas.addEventListener('pointermove', this.#onMove, {signal});
    canvas.addEventListener('pointerup', this.#onUp, {signal});
    // The gesture can also end without a pointerup: the system takes it (a
    // notification shade, a browser back-swipe) or the capture is lost.
    // Nothing it was building up should land afterwards.
    canvas.addEventListener('pointercancel', this.#onCancel, {signal});
    canvas.addEventListener('lostpointercapture', this.#onCancel, {signal});
    window.addEventListener('keydown', this.#onKey, {signal});
    // Esc is this game's most-worn key, and inside fullscreen the browser
    // answers it too, with an exit no preventDefault can stop. Borrow the
    // key for the match (where the engine lends it at all); the menu keeps
    // the plain arrangement, having no modes for Esc to unwind.
    signal.addEventListener('abort', guardEsc(), {once: true});
  }

  /**
   * Let the match's input go: every listener at once, and the band element
   * with them. Without this they outlive the world they steer — Esc
   * clearing a selection in a menu, through a Controls holding a
   * terminated worker.
   */
  dispose(): void {
    this.#off.abort();
    this.#bandEl.remove();
  }

  /**
   * Arm (or disarm) build placement. Everything that changes the mode goes
   * through here, the HUD's buttons included: writing the signal alone
   * leaves the ghost standing on the map until the next pointer move, and
   * a finger that just tapped Cancel may never send one.
   */
  setPlacement(type: BuildingTypeId | null): void {
    setPlacing(type);
    // The ribbon follows the aim, so anything armed from anywhere brings
    // its own tab. A button click is already on that tab and this changes
    // nothing; the chord below has aimed before it ever gets here.
    if (type !== null) setBuildAim(type);
    if (type === null) this.#ghost.hide();
    // Two modes that both claim the next click cannot both be armed.
    else this.armOrder(null);
    setBuildChord(false);
  }

  /**
   * Arm (or disarm) an order waiting for its target — the A/M shortcuts and
   * the selection card's buttons both land here.
   *
   * A method rather than a bare setter because arming one mode has to
   * disarm the others: placement and an order both claim the next click,
   * and two things claiming one click is one of them losing silently.
   */
  armOrder(mode: OrderMode | null): void {
    // Nobody to order about — an armed order over an empty selection would
    // eat the click that was going to select someone. The rally flag is
    // the exception: it is armed from a selected barracks, not a squad.
    if (mode === OrderMode.rally) {
      if (!this.#rallyTarget()) return;
    } else if (mode !== null && (this.#selection.size === 0 || replayMode())) {
      return;
    }
    setOrderMode(mode);
    if (mode !== null) {
      this.setPlacement(null);
      // An explicit order supersedes the tap that came before it: the
      // double-tap escalation must not treat the next tap as a repeat.
      this.#lastMoveTap = null;
    }
  }

  /**
   * Whether a plain click means an order right now rather than whatever
   * the surface under it normally does — an A, an M or a rally flag,
   * armed and unspent.
   *
   * Asked by the minimap, which has to know before the gesture rather than
   * after it: the same press that would give an order is the one that
   * steers the camera, and on a phone it cannot commit to either until the
   * finger lifts.
   */
  orderArmed(): boolean {
    return this.#liveOrder() !== null;
  }

  /**
   * A click on the minimap, taken as an order at the tile it points to.
   * The chart is the whole map at two pixels a tile, so this is how a
   * squad is sent somewhere off screen — and the rally flag planted there
   * — without the trip over and back.
   *
   * The buttons mean exactly what they mean on the map itself, which is
   * the point: `secondary` (the right button) is the plain move, or the
   * barracks' rally flag when nothing is selected, and it cancels an armed
   * order rather than spending it. A plain click spends the armed order —
   * A's attack-move, M's move, the flag — and disarms, spent or refused,
   * the same one-shot the map's click is.
   *
   * `px`/`py` are the click itself, in client pixels: the confirming pulse
   * blooms over the chart, where the player is looking, rather than over a
   * patch of ground that may be nowhere on screen. `queue` is Shift held:
   * the order lines up behind the squad's standing ones (see #sendMove).
   */
  orderAtMapPoint(
    x: number,
    z: number,
    secondary: boolean,
    px: number,
    py: number,
    queue = false,
  ): void {
    const {x: tx, y: ty} = this.#playTile(x, z);
    const order = this.#liveOrder();
    if (secondary) {
      if (order) {
        this.armOrder(null);
        return;
      }
      // With nobody selected but a barracks open, the right-click plants
      // the flag — the same rule the map's own right-click follows.
      if (this.#selection.size === 0) this.#issueRallyAt(tx, ty, px, py);
      else this.#issueMoveAt(tx, ty, false, px, py, queue);
      return;
    }
    if (!order) return;
    if (order === OrderMode.rally) this.#issueRallyAt(tx, ty, px, py);
    else this.#issueMoveAt(tx, ty, orderOf(order), px, py, queue);
    this.armOrder(null);
  }

  /**
   * A world point off the chart, as a tile inside the play square. The
   * minimap's own clamp stops at the square's far edge, which is one past
   * its last tile; an order aimed there would land in the margin nobody
   * can walk on.
   */
  #playTile(x: number, z: number): {x: number; y: number} {
    const map = this.#mirror.map;
    const lo = playMin(map);
    const hi = playMax(map) - 1;
    return {
      x: clamp(Math.floor(x), lo, hi),
      y: clamp(Math.floor(z), lo, hi),
    };
  }

  /**
   * Keyboard shortcuts.
   *
   * The order they are tested in is the design:
   *
   * - Esc unwinds one mode per press, innermost first — a half-typed build
   *   chord, then an armed order, then a placement, then the selection, and
   *   with nothing at all left it lets go of fullscreen itself. One key,
   *   one undo, no state the player cannot see their way out of.
   * - A half-typed build chord swallows the next letter whole. B, W is a
   *   woodcutter and nothing else; while the chord stands, M cannot mute
   *   the game out from under it.
   * - A number is a control group and nothing else — no other binding wants
   *   the number row, and a building's contextual letters cannot collide
   *   with one. Ctrl earns its way past the modifier guard for these alone.
   * - Otherwise A and M are orders while people are selected, B opens the
   *   chord, and the odds and ends (mute, the debug overlay) have what is
   *   left. M is the one key that answers to two things, and the selection
   *   decides which: with a squad standing it is the move order every RTS
   *   binds it to, and only with nothing selected does it still mute.
   * - The two camera jumps sit here rather than in CameraRig because they
   *   are aimed at things only this layer can see: Backspace at your own
   *   keep, Space at the last alert. The rig owns the directions (arrows,
   *   the edge push); this owns the destinations.
   */
  #onKey = (e: KeyboardEvent): void => {
    // Chords belong to the browser and the OS (⌘M minimises), and a key
    // typed into a field is being typed, not pressed. Both tests live in
    // input/typing.ts, which CameraRig's own listeners share — the rig
    // sits on the window too, and a map being renamed in the editor must
    // not turn the camera on every Delete.
    if (foreignChord(e)) return;
    // Ctrl stopped being a blanket disqualifier the day control groups
    // landed: Ctrl+1 is half of how a group is stamped. Everything else
    // Ctrl touches is still the browser's.
    //
    // Ctrl on a Mac too, not ⌘, which is worth saying because it looks like
    // the wrong answer and is not. ⌘1–⌘9 switch browser tabs, at a level no
    // preventDefault can reach, so ⌘ is not ours to bind in a tab at all.
    // Ctrl is free on a stock Mac: macOS ships ⌃1–⌃9 as "switch to desktop
    // N" but leaves those rows unchecked, so they fire only for someone who
    // went and enabled them — and that someone loses this binding to Spaces
    // exactly the way they lose it in StarCraft II, which binds Ctrl on
    // every platform it ships on.
    if (e.ctrlKey && keyDigit(e) === null) return;
    const t = e.target;
    if (typingInto(t)) return;

    // Both spellings, for the reason keyLetter gives: `code` comes back
    // empty on some input paths, and Esc is the one key that must never be
    // the thing that stopped working — it is how every mode is left.
    if (e.key === 'Escape' || e.code === 'Escape') {
      // The quit question sits on top of everything, wherever it was asked
      // from, so it is the first thing Esc takes back down.
      if (quitConfirm()) setQuitConfirm(false);
      else if (buildChord()) setBuildChord(false);
      else if (orderMode()) this.armOrder(null);
      else if (placing()) this.setPlacement(null);
      // An open sheet is the outermost thing on screen, so it goes before
      // the selection under it. The tech tree had only its ✕ until now,
      // which is the one exit a player never looks for.
      else if (openPanel() !== null) setOpenPanel(null);
      else if (this.#selection.size > 0 || selectedBuilding() !== null)
        this.deselectAll();
      // Nothing left to unwind. The guard held the short press inside
      // fullscreen so the branches above could run at all; this rung keeps
      // Esc's outermost meaning — and going through our own switch, the
      // exit is remembered as the player's answer.
      else fullscreen().set(false);
      return;
    }

    // While the quit question stands, the rest of the keyboard belongs to
    // its buttons: B must not open the build chord behind a modal card.
    // Enter and Tab never land in this handler, so answering and moving
    // between the two buttons still work. The two browser defaults this
    // handler always swallows stay swallowed even now — Backspace's legacy
    // navigation and Space's document scroll — but Space on the dialog's
    // focused button is left alone: that is how it is pressed.
    if (quitConfirm()) {
      if (e.key === 'Backspace' || e.code === 'Backspace') e.preventDefault();
      if (
        (e.key === ' ' || e.code === 'Space') &&
        !(t instanceof HTMLButtonElement)
      ) {
        e.preventDefault();
      }
      return;
    }

    const letter = keyLetter(e);

    if (buildChord()) {
      setBuildChord(false);
      const type = letter ? buildingForKey(letter) : null;
      if (type) this.#armBuild(type);
      else play('uiRefused');
      return;
    }

    // The selected building's own command panel, and it goes first: these
    // letters overlap the global ones on purpose (a barracks' Archer is the
    // attack-move's A), and the overlap is only safe because a building
    // selection is never a unit selection.
    const b = selectedBuilding();
    if (b && b.owner === myPlayerId() && this.#buildingCommand(b, letter))
      return;

    // Control groups. They sit behind the chord, which swallows the next
    // key whole whether or not it is a letter, and behind the building
    // panel, which cannot want a number — its commands are all letters — so
    // where exactly they land among these three does not matter. What
    // matters is that nothing further down wants the number row either.
    const digit = keyDigit(e);
    if (digit !== null) {
      // Backstop the browser's own find-as-you-type and any Ctrl+number
      // the platform might still be listening for.
      e.preventDefault();
      this.#controlGroup(digit, e.ctrlKey, e.shiftKey);
      return;
    }

    // Playback: the same gears the HUD's speed cluster holds. A networked
    // match runs on one shared clock, so there is nothing here to press —
    // which is why the HUD hides those buttons there too.
    if (!netMode() && this.#playbackKey(e)) return;

    if (letter === RESEARCH_KEY) {
      // Not contextual: the tree is a sheet to read, not an order to give.
      setTechPanelOpen(!techPanelOpen());
      play('uiClick');
    } else if (letter === 'B') {
      // A replay takes no orders, so it offers no build card to chord into.
      if (replayMode()) return;
      setBuildChord(true);
      play('uiClick');
    } else if (letter === HOLD_KEY) {
      // Sent, not armed: the order has no target to wait for. Nothing to
      // hold with — no soldier in hand, or a replay — is nothing at all,
      // exactly as A over an empty selection is (a refusal sound for a
      // key that means nothing here would be the keyboard scolding a
      // player who merely has no army yet).
      this.holdGround();
    } else if (letter === 'A' || letter === 'M' || letter === PATROL_KEY) {
      if (this.#selection.size > 0 && !replayMode()) {
        this.armOrder(
          letter === 'A'
            ? OrderMode.attack
            : letter === PATROL_KEY
              ? OrderMode.patrol
              : OrderMode.move,
        );
        play('uiClick');
      } else if (letter === 'M') {
        toggleMuted();
        // Unmuting clicks so the change is audible either way; muting's
        // confirmation is the silence itself.
        if (!muted()) play('uiClick');
      }
    } else if (letter === 'F' && replayMode()) {
      // Replay only: a recording has nobody left to hide from, so the fog
      // is the viewer's choice — in a live match this stays a cheat.
      setFogEnabled(!fogEnabled());
      play('uiClick');
    } else if (e.key === 'Backspace' || e.code === 'Backspace') {
      // Browsers stopped navigating Back on this years ago, but the guard
      // is free and this listener is on window — the one place a stray
      // default would take the whole page with it.
      e.preventDefault();
      this.#jumpHome();
    } else if (e.key === ' ' || e.code === 'Space') {
      // A focused control owns Space: that is how someone presses a button
      // without a mouse, and taking it would leave the HUD reachable by
      // keyboard but not operable by one.
      if (
        t instanceof HTMLButtonElement ||
        t instanceof HTMLAnchorElement ||
        t instanceof HTMLSelectElement
      ) {
        return;
      }
      // Otherwise it is ours whether or not there is anywhere to jump to.
      // The default is a page scroll, and scrolling the document out from
      // under the map is a worse answer than doing nothing at all — so the
      // key is swallowed first and the jump is what may or may not follow.
      e.preventDefault();
      // Both games put "take me to the last thing that happened" here: the
      // one camera key that answers a notification rather than a direction.
      const at = lastAlert();
      if (at) this.#rig?.glideTo(at.x, at.y);
    } else if (e.key === '`' || e.code === 'Backquote') {
      const open = !debugOpen();
      setDebugOpen(open);
      // The worker skips serializing its jobs table until told to.
      this.#host.setDebug(open);
    }
  };

  /**
   * The clock's keys — + and − a gear at a time — or false for a key that
   * meant something else.
   *
   * One pair, and no pause key beside it: the bottom rung of the ladder is
   * the pause, so − from walking pace holds the village in a single press
   * and + lets it go again. A P would have been a second road to a rung
   * that already takes one keystroke to reach, and one that then has to
   * remember which gear it interrupted.
   *
   * Not letters, and that is the point: every letter this game binds is one
   * the HUD prints inside a word, and "Fast forward" has no free letter
   * left to bold (F lifts a replay's fog). The +/− pair is what the grand
   * strategy games bind their clock to — Paradox's, where Stellaris takes
   * this same spread of spellings — and it reads off the keycap without a
   * legend. It is not the RTS convention: StarCraft has no speed key at
   * all, and its pause, where it has one, is the Pause key itself.
   *
   * Both spellings of each, for the reason keyLetter gives. `+` needs
   * Shift on most layouts and none on some, so the unshifted `=` is taken
   * as the same key — the way a browser's own zoom does.
   */
  #playbackKey(e: KeyboardEvent): boolean {
    if (e.key === '+' || e.key === '=' || e.code === 'Equal') {
      nudgeSpeed(this.#host, 1);
      return true;
    }
    if (e.key === '-' || e.code === 'Minus') {
      nudgeSpeed(this.#host, -1);
      return true;
    }
    return false;
  }

  /**
   * Run a command off the selected building's panel, if this letter names
   * one. Returns whether the letter was spoken for — a building that has no
   * command on that key lets it fall through to the global bindings, so
   * selecting your castle does not cost you the build chord.
   *
   * Every refusal says which gate it hit, for the reason the build chord
   * does: the greyed button is the explanation, and someone typing instead
   * of looking never sees it.
   */
  #buildingCommand(b: BuildingSnap, letter: string): boolean {
    if (!letter || replayMode()) return false;

    if (
      letter === HIRE_KEY &&
      b.type === BuildingTypeId.storehouse &&
      b.state === BuildingState.built
    ) {
      if (!canHire(b, stock(), population())) {
        const queued = b.hireQueue ?? 0;
        pushToast(
          (stock()[GoodId.silver] ?? 0) < HIRE_SERF_COST
            ? `Not enough silver to hire — a serf costs ${HIRE_SERF_COST}.`
            : population().pop + queued >= population().cap
              ? 'Every bed is taken — build a house before you hire again.'
              : 'The recruiting queue is full.',
        );
        play('uiRefused');
        return true;
      }
      this.#host.sendCommands([{kind: CommandKind.hireSerf}]);
      play('uiCoin');
      return true;
    }

    if (letter === RALLY_KEY && canRally(b)) {
      // Arms the flag for the next click, exactly like the card's button.
      this.armOrder(OrderMode.rally);
      play('uiClick');
      return true;
    }

    const unit = trainingForKey(b, letter);
    if (unit !== null) {
      if (b.state !== BuildingState.built) return true;
      const gate = unitTechGate(unit);
      if (!canTrain(b, unit, techs().researched)) {
        pushToast(
          gate !== undefined && !techs().researched.includes(gate)
            ? `The ${unitName(unit)} needs ${techName(gate)} first.`
            : 'The drill queue is full.',
        );
        play('uiRefused');
        return true;
      }
      this.#host.sendCommands([
        {kind: CommandKind.trainUnit, buildingId: b.id, unit},
      ]);
      play('uiClick');
      return true;
    }

    return false;
  }

  /** Backspace: back to your own keep, the way both games spend that key. */
  #jumpHome(): void {
    for (const b of this.#mirror.buildings.values()) {
      if (b.type === BuildingTypeId.storehouse && b.owner === myPlayerId()) {
        this.#rig?.glideTo(b.x + b.w / 2, b.y + b.h / 2);
        return;
      }
    }
  }

  /**
   * Commit a chord to a placement, under the same two gates the ribbon's
   * buttons wear. A refusal says which one it was: the button the player
   * cannot see (they typed instead of looked) is greyed for a reason, and
   * "nothing happened" is the one answer that teaches nothing.
   */
  #armBuild(type: BuildingTypeId): void {
    const name = buildingDef(type).name;
    // Before the gates, not after: a refusal is exactly when the player
    // most needs the button in front of them — greyed, with the cost or
    // the lock on it — and a tab that stayed put leaves the toast as the
    // only account of what just happened.
    setBuildAim(type);
    if (!buildUnlocked(type, techs().researched)) {
      pushToast(`The ${name} needs researching first.`);
      play('uiRefused');
      return;
    }
    if (!buildAffordable(type, stock())) {
      pushToast(`Not enough in the stores for a ${name}.`);
      play('uiRefused');
      return;
    }
    this.setPlacement(type);
    play('uiClick');
  }

  /** Footprint origin tile for a ghost centered under the cursor. */
  #placementOrigin(px: number, py: number): {x: number; y: number} | null {
    const type = placing();
    if (!type) return null;
    const ground = screenToGround(
      this.#camera,
      this.#canvas,
      px,
      py,
      this.#heights,
    );
    if (!ground) return null;
    const def = buildingDef(type);
    return {
      x: Math.round(ground.x - def.w / 2),
      y: Math.round(ground.z - def.h / 2),
    };
  }

  get selected(): ReadonlySet<number> {
    return this.#selection;
  }

  /** Unit under the cursor (any owner), for hover hp bars. -1 when none. */
  get hoverUnit(): number {
    return this.#hoverUnit;
  }

  /** Building under the cursor, for hover hp bars. -1 when none. */
  get hoverBuilding(): number {
    return this.#hoverBuilding;
  }

  /**
   * Drop ids that no longer exist (deaths), and refresh what the card
   * knows about the people still in hand; call once per frame.
   */
  prune(): void {
    let changed = false;
    for (const id of this.#selection) {
      // A corpse stays in the publish while its death animation plays, so
      // "gone from the publish" is not enough: a wiped squad went on
      // wearing selection rings, counting in the HUD, and putting dead ids
      // into the next move order.
      if (!this.#sync.latestIds.has(id) || this.#sync.isDead(id)) {
        this.#selection.delete(id);
        changed = true;
      }
    }
    // Control groups are lists of ids too, and they outlive the selection
    // by design — so without this, group 1 keeps calling back the four
    // knights who fell three minutes ago, and the camera it rides out to
    // is aimed at wherever they last stood.
    let groupsChanged = false;
    for (const [digit, group] of this.#groups) {
      if (group.kind === ControlGroupKind.building) {
        // A razed (or sold) building is the same problem one entry wide,
        // and the number goes with it: an empty unit group can still be
        // grown by a Shift press, but a building group has nothing left to
        // be, so it is dropped whole and the number falls free again.
        if (!this.#mirror.buildings.has(group.id)) {
          this.#groups.delete(digit);
          groupsChanged = true;
        }
        continue;
      }
      for (const id of group.ids) {
        if (!this.#sync.latestIds.has(id) || this.#sync.isDead(id)) {
          group.ids.delete(id);
          groupsChanged = true;
        }
      }
    }
    if (changed) this.#setSel(this.#selection);
    // The badge can go stale on a casualty that touched only the group (a
    // straggler nobody had selected), so it is refreshed even when the
    // selection itself came through the frame untouched.
    else if (groupsChanged) this.#publishGroup();
    // Health moves without the selection changing at all — that is what a
    // fight is — so the roster is offered the frame rather than refreshed
    // only when ids come and go. #publishRoster is what decides whether
    // there is a new publish behind the frame, and then whether what it
    // says is worth telling anyone about.
    this.#publishRoster();
  }

  /**
   * Hand the card the selection as people: kind and hitpoints per head.
   *
   * The ids alone make "4 units selected", which reads the same for four
   * serfs and for four knights — so the card reads the live publish for
   * what each of them is and how much is left of them. Only a change the
   * card would actually print reaches the signal; see sameRoster.
   */
  #publishRoster(force = false): void {
    // Nothing in the roster is interpolated — kinds and health are read
    // straight off the last publish — so between publishes there is
    // provably nothing to find, and this is the frame loop.
    const seq = this.#sync.publishSeq;
    if (!force && seq === this.#rosterSeq) return;
    this.#rosterSeq = seq;
    const next = rosterOf(this.#selection, this.#sync);
    if (sameRoster(next, this.#roster)) return;
    this.#roster = next;
    setSelectionUnits(next);
  }

  #setSel(sel: Set<number>): void {
    // A selection that grew is a player picking people up — worth a click.
    // Shrinking is not: prune() feeds deaths through here every frame, and
    // a death knell per battle casualty belongs to combat, not selection.
    if (sel !== this.#selection && sel.size > this.#selection.size)
      play('uiSelect');
    // An armed rally belongs to a selected building, and people being
    // selected is that building's card leaving the screen (the two
    // selections are mutually exclusive) — so the mode goes with it.
    // Without this, recalling a control group left rally armed with
    // nothing to plant for, and the next map click was swallowed. The
    // empty-selection case is the disarm further down.
    if (sel.size > 0 && orderMode() === OrderMode.rally) this.armOrder(null);
    this.#selection = sel;
    const owner = this.#soleOwner(sel);
    // Before the selection is published: the card that draws for these
    // ids reads the stores and techs, and those must already be the
    // right seat's on the frame it first paints.
    this.#viewOwner(owner);
    setSelection(new Set(sel));
    setSelectionOwner(owner);
    // Straight away rather than at the next prune(), and past the publish
    // gate: a click that picks up a knight has to draw his card on the
    // frame it happened, and the card is nothing but the roster.
    this.#publishRoster(true);
    this.#publishGroup();
    // An order with nobody left to carry it out: the squad was let go, or
    // prune() just buried the last of them. Disarm rather than leave the
    // card lit and the next click swallowed to order thin air.
    if (sel.size === 0 && orderMode()) this.armOrder(null);
  }

  /**
   * Forget everything the current gesture had started: the band
   * rectangle, and the tap that would have selected or placed.
   * Used when the gesture is taken away rather than finished — a cancelled
   * touch, a lost capture, or a second finger arriving.
   */
  #abortGesture = (): void => {
    this.#touchOrigin = null;
    this.#touchPan = false;
    this.#dragStart = null;
    this.#dragging = false;
    this.#bandEl.style.display = 'none';
    // An armed marquee whose drag was taken away: give the camera its
    // finger back and drop the claim on this gesture. Without this, the
    // pan stayed disabled until some later marquee resolved — and if the
    // player disarmed the button in between, the stale #bandTouch turned
    // their next plain pan into a band-select. bandArm itself survives:
    // the button's one-shot offer was interrupted, not spent, so the next
    // drag still draws the band.
    if (this.#bandTouch) {
      this.#bandTouch = false;
      if (this.#rig) this.#rig.touchPanEnabled = true;
    }
  };

  #onCancel = (): void => {
    this.#abortGesture();
  };

  /** Only the first finger down commands anything. A second one means the
   * camera — pinch-zoom, two-finger pan — and what the first was starting
   * is not what the player meant by it. */
  #secondaryTouch(e: PointerEvent): boolean {
    return e.pointerType === 'touch' && !e.isPrimary;
  }

  #onDown = (e: PointerEvent): void => {
    if (this.#secondaryTouch(e)) {
      this.#abortGesture();
      return;
    }
    const order = this.#liveOrder();
    if (order) {
      if (e.button === 0) {
        if (e.pointerType === 'touch') {
          // Same deal as placement: the finger may be starting a map drag,
          // so the order commits on release and only if it stayed put.
          this.#touchOrigin = {x: e.clientX, y: e.clientY};
          return;
        }
        if (order === OrderMode.rally) this.#issueRally(e.clientX, e.clientY);
        // A-click on something hostile means THAT one, not the ground it
        // stands on. Anywhere else the armed order is the attack-move it
        // has always been. Shift queues either behind the standing orders
        // — and, with P armed, adds the spot to the beat being walked.
        else if (
          order !== OrderMode.attack ||
          !this.#issueFocus(e.clientX, e.clientY, e.shiftKey)
        )
          this.#issueMove(e.clientX, e.clientY, orderOf(order), e.shiftKey);
        this.armOrder(null);
      } else if (e.button === 2) {
        this.armOrder(null);
      }
      return;
    }
    const type = placing();
    if (type) {
      if (e.button === 0) {
        if (e.pointerType === 'touch') {
          // The finger may be starting a map drag, so commit on release
          // and only if it stayed put — a drag pans instead of building.
          // Meanwhile the ghost appears under the finger at once: touch
          // has no hover, so the press itself is the only chance to show
          // the footprint and its valid/invalid tint before it commits.
          this.#touchOrigin = {x: e.clientX, y: e.clientY};
          const origin = this.#placementOrigin(e.clientX, e.clientY);
          if (origin) {
            this.#ghost.show(type);
            this.#ghost.moveTo(
              origin.x,
              origin.y,
              this.#canPlaceHere(type, origin.x, origin.y),
            );
          }
          return;
        }
        this.#place(e.clientX, e.clientY, e.shiftKey);
      } else if (e.button === 2) {
        this.setPlacement(null);
      }
      return;
    }
    if (e.button === 0) {
      this.#dragStart = {x: e.clientX, y: e.clientY};
      this.#dragging = false;
      if (e.pointerType === 'touch') {
        this.#touchOrigin = {x: e.clientX, y: e.clientY};
        if (bandArm()) {
          // The marquee button armed this drag: it draws the selection
          // band, and the camera holds still until the finger lifts.
          this.#bandTouch = true;
          if (this.#rig) this.#rig.touchPanEnabled = false;
          capturePointer(this.#canvas, e);
        }
      }
    } else if (e.button === 2) {
      // With nobody selected but a barracks open, the right-click is the
      // rally flag's shortcut — the gesture every RTS spends it on. With a
      // squad standing it stays the plain move it has always been.
      // Shift on either half is the waypoint: the order waits its turn
      // behind the ones the squad already has (see #sendMove).
      if (this.#selection.size === 0 && this.#rallyTarget()) {
        this.#issueRally(e.clientX, e.clientY);
      } else if (!this.#issueFocus(e.clientX, e.clientY, e.shiftKey)) {
        this.#issueMove(e.clientX, e.clientY, false, e.shiftKey);
      }
    }
  };

  setFog(fog: FogQuery): void {
    this.#fog = fog;
  }

  /** Wire in the renderer's model measurements — see #buildingHeights. */
  setBuildingHeights(heights: BuildingHeights): void {
    this.#buildingHeights = heights;
  }

  /**
   * You cannot build on ground you have never scouted.
   *
   * This is a real rule, not just a guard. Without it, arming a building
   * and clicking across the dark is a free map probe: the click is silently
   * dropped wherever something already stands, so "nothing happened" maps
   * out a rival's base without sending a single order. Requiring
   * exploration removes the question rather than the answer.
   */
  #explored(x: number, y: number, w: number, h: number): boolean {
    if (!this.#fog) return true;
    for (let ty = y; ty < y + h; ty++) {
      for (let tx = x; tx < x + w; tx++) {
        if (!this.#fog.exploredAt(tx + 0.5, ty + 0.5)) return false;
      }
    }
    return true;
  }

  #canPlaceHere(type: BuildingTypeId, x: number, y: number): boolean {
    const def = buildingDef(type);
    return (
      this.#explored(x, y, def.w, def.h) &&
      canPlace(this.#mirror.map, type, x, y)
    );
  }

  /** Commit the armed building at this screen point, if it fits. */
  #place(px: number, py: number, keepArmed: boolean): void {
    const type = placing();
    if (!type) return;
    const origin = this.#placementOrigin(px, py);
    if (origin && this.#canPlaceHere(type, origin.x, origin.y)) {
      this.#host.sendCommands([
        {
          kind: CommandKind.placeBuilding,
          building: type,
          x: origin.x,
          y: origin.y,
        },
      ]);
      play('uiPlace');
      if (!keepArmed) this.setPlacement(null);
      return;
    }
    // A refused spot must never be a silent nothing. With a mouse the red
    // ghost already warned before the click; a finger taps blind — no
    // hover — so without this the phone reads "building is broken" where
    // the desktop reads "I can see it won't fit". Same rule, told out loud.
    if (origin) {
      this.#ghost.show(type);
      this.#ghost.moveTo(origin.x, origin.y, false);
      pushToast(this.#refusal(type, origin.x, origin.y));
      navigator.vibrate?.(30);
      play('uiRefused');
    }
  }

  /**
   * Why that spot said no, in the player's words.
   *
   * Each rule gets its own sentence because they ask for different moves:
   * "no room" sends the player looking for something in the way, and under
   * a mine four tiles from the nearest seam there is nothing in the way at
   * all — the fix is to build somewhere else entirely. The reasons come
   * from the same function that refused the site (placementRefusal), so
   * the sentence can never describe a rule other than the one that fired.
   */
  #refusal(type: BuildingTypeId, x: number, y: number): string {
    const def = buildingDef(type);
    if (!this.#explored(x, y, def.w, def.h)) {
      return 'Too dark to build — nobody has scouted that ground.';
    }
    switch (placementRefusal(this.#mirror.map, type, x, y)) {
      case 'resource': {
        // Named for the good it would carry home, which is how the
        // selection card already talks about the ground ("iron in reach").
        const gather = gatherRecipeOf(def);
        return gather
          ? `Nothing to work there — no ${goodName(gather.output).toLowerCase()} within ${gather.radius} tiles.`
          : 'Nothing to work there.';
      }
      case 'water':
        return 'Too far from the water to fish.';
      case 'seam': {
        // The one rule that names ground rather than a worker's reach, so
        // it gets the resource's own word rather than the gatherer's.
        const near = def.nearResource;
        return near
          ? `${buildingName(type)} must stand within ${near.radius} tiles of ${RESOURCE_NAMES[near.kind] ?? 'the seam'}.`
          : 'The ground there is wrong for it.';
      }
      case 'slope':
        return 'The ground is too steep to build there.';
      case 'occupied':
      default:
        return 'No room to build there.';
    }
  }

  /** A finger that travels past the slop is a pan, not a tap. */
  #cancelTap(px: number, py: number): void {
    const o = this.#touchOrigin;
    if (!o) return;
    const dx = px - o.x;
    const dy = py - o.y;
    if (dx * dx + dy * dy > TOUCH_SLOP_PX * TOUCH_SLOP_PX) {
      this.#touchOrigin = null;
    }
  }

  #onMove = (e: PointerEvent): void => {
    if (this.#secondaryTouch(e)) return;
    this.#hoverX = e.clientX;
    this.#hoverY = e.clientY;
    this.#hoverIsTouch = e.pointerType === 'touch';
    this.#hoverDirty = true;
    if (placing()) {
      // A travelling finger is panning the map, not aiming: drop the
      // pending placement (the ghost still tracks so the site stays visible).
      if (e.pointerType === 'touch') this.#cancelTap(e.clientX, e.clientY);
      // The ghost itself moves from the rAF loop (updateHoverIfDirty, via
      // the dirty flag set above): pointermove fires at input-device rate —
      // up to 1000 Hz on a gaming mouse — and re-running placement
      // validity and the outline geometry per event bought nothing a frame
      // could show.
      return;
    }
    this.#ghost.hide();
    if (orderMode()) {
      // A travelling finger is panning the map, not aiming the order.
      if (e.pointerType === 'touch') this.#cancelTap(e.clientX, e.clientY);
      return;
    }
    if (!this.#dragStart) return;
    if (e.pointerType === 'touch' && !this.#bandTouch) {
      // The camera owns plain finger drags; only an armed marquee selects.
      this.#cancelTap(e.clientX, e.clientY);
      // Past the slop the finger is dragging the valley, not pointing into
      // it, and a highlight is a claim about what a pointer is over. There
      // is no pointer: the finger is on the glass holding ground still
      // while the world slides beneath it, so whatever the scan found
      // would be a different unit every frame, lit under a fingertip that
      // is already covering it. Dropped rather than frozen: a highlight
      // left standing would ride a unit across the screen for the length
      // of the swipe, pointing at nothing at all.
      //
      // Dropping it is also the cheapest frame in the swipe. The scan
      // walks every unit on the field projecting each through the camera
      // and casts a ray at the buildings, it is marked dirty by the pan
      // itself as well as by the finger, and so it would run once per
      // frame for the whole gesture — against the pan, on the one thread
      // the pan is drawn from.
      //
      // The next pointer move picks the highlight back up: a mouse on a
      // device that has one, or the press that starts the next gesture. A
      // finger merely lifted does not, and should not — the release marks
      // no hover dirty, so nothing is left lit once the hand is off the
      // glass, which is the honest state of a screen with no cursor
      // resting anywhere on it.
      if (this.#touchOrigin === null && !this.#touchPan) {
        this.#touchPan = true;
        this.#hoverUnit = -1;
        this.#hoverBuilding = -1;
      }
      return;
    }
    const dx = e.clientX - this.#dragStart.x;
    const dy = e.clientY - this.#dragStart.y;
    if (
      !this.#dragging &&
      dx * dx + dy * dy > DRAG_THRESHOLD_PX * DRAG_THRESHOLD_PX
    ) {
      this.#dragging = true;
      capturePointer(this.#canvas, e);
      this.#bandEl.style.display = 'block';
    }
    if (this.#dragging) {
      const x0 = Math.min(this.#dragStart.x, e.clientX);
      const y0 = Math.min(this.#dragStart.y, e.clientY);
      this.#bandEl.style.left = `${x0}px`;
      this.#bandEl.style.top = `${y0}px`;
      this.#bandEl.style.width = `${Math.abs(dx)}px`;
      this.#bandEl.style.height = `${Math.abs(dy)}px`;
    }
  };

  #onUp = (e: PointerEvent): void => {
    if (this.#secondaryTouch(e)) return;
    const heldStill = this.#touchOrigin !== null;
    this.#touchOrigin = null;
    this.#touchPan = false;

    // An armed order takes the release the same way placement does, and for
    // the same reason: on touch the press only staked a claim.
    const order = this.#liveOrder();
    if (order) {
      if (e.pointerType === 'touch' && e.button === 0 && heldStill) {
        if (order === OrderMode.rally) this.#issueRally(e.clientX, e.clientY);
        // A-click on something hostile means THAT one, not the ground it
        // stands on. Anywhere else the armed order is the attack-move it
        // has always been.
        else if (
          order !== OrderMode.attack ||
          !this.#issueFocus(e.clientX, e.clientY)
        )
          this.#issueMove(e.clientX, e.clientY, orderOf(order));
        this.armOrder(null);
      }
      return;
    }

    // Placement mode never arms a drag, so it has to be handled before the
    // drag guard below: touch commits here (a mouse placed on press).
    if (placing()) {
      if (e.pointerType === 'touch' && e.button === 0 && heldStill) {
        this.#place(e.clientX, e.clientY, false);
      }
      return;
    }
    if (e.button !== 0 || !this.#dragStart) return;
    const start = this.#dragStart;
    this.#dragStart = null;
    this.#bandEl.style.display = 'none';

    if (e.pointerType === 'touch') {
      if (this.#bandTouch) {
        // The armed marquee resolves: a real drag selects the band, a mere
        // tap falls back to point-select. One-shot either way.
        const dragged = this.#dragging;
        this.#bandTouch = false;
        this.#dragging = false;
        setBandArm(false);
        if (this.#rig) this.#rig.touchPanEnabled = true;
        // A marquee is its own gesture, not half of a double-tap: without
        // this, the tap that armed nothing and the tap that drew the band
        // pair up and widen to a whole kind.
        this.#lastUnitPress = null;
        if (dragged)
          this.#selectInRect(start.x, start.y, e.clientX, e.clientY, false);
        else this.#selectAtPoint(e.clientX, e.clientY, false);
        return;
      }
      // A tap that stayed put speaks selection-first; a travelled finger
      // was a pan and means nothing here.
      if (heldStill) this.#touchTap(e.clientX, e.clientY);
      return;
    }
    if (this.#dragging) {
      this.#dragging = false;
      // A band drag is not the first half of a double-click, however
      // briefly it passed over the unit it started on.
      this.#lastUnitPress = null;
      this.#selectInRect(start.x, start.y, e.clientX, e.clientY, e.shiftKey);
    } else {
      this.#clickSelect(e.clientX, e.clientY, e.shiftKey);
    }
  };

  /**
   * A left click that selected rather than dragged. One click picks what is
   * under it; two on the same unit inside a beat widen to every unit of
   * that kind on screen, which is what a double-click has meant in this
   * genre since Warcraft II. Shift adds to the standing selection either
   * way, so shift-double-click is how a mixed army is assembled a kind at
   * a time.
   */
  #clickSelect(px: number, py: number, additive: boolean): void {
    const id = this.#unitAt(px, py);
    if (
      this.#repeatUnitPress(id, px, py, DOUBLE_CLICK_MS, DOUBLE_CLICK_RADIUS_PX)
    ) {
      // A third and fourth click land here again and re-widen to the same
      // set, so a shaky hand cannot toggle its own selection back off.
      this.#selectSameKind(id, additive);
      return;
    }
    this.#selectAtPoint(px, py, additive);
  }

  /**
   * Was this the second of a pair on the same unit — a double-click, or the
   * finger's version of one? Records the press either way, and a press that
   * missed every unit (id < 0) breaks the chain rather than starting one:
   * two clicks on empty grass are two clicks on empty grass.
   */
  #repeatUnitPress(
    id: number,
    px: number,
    py: number,
    ms: number,
    radius: number,
  ): boolean {
    const prev = this.#lastUnitPress;
    if (id < 0) {
      this.#lastUnitPress = null;
      return false;
    }
    const now = performance.now();
    const dx = prev ? px - prev.px : 0;
    const dy = prev ? py - prev.py : 0;
    const repeat =
      prev !== null &&
      prev.id === id &&
      now - prev.time <= ms &&
      dx * dx + dy * dy <= radius * radius;
    this.#lastUnitPress = {id, px, py, time: now};
    return repeat;
  }

  /**
   * Every unit of one kind that is on screen right now — what a
   * double-click means by "and the rest of them".
   *
   * On screen rather than on the map, which is the rule both StarCrafts
   * use and the one that makes the gesture safe: a swordsman double-clicked
   * at the gate calls in the others holding the gate, not the two
   * garrisoning the far corner of the map who were the only thing standing
   * between the mill and a raid.
   *
   * One banner, too. Live that is not a question — the pick never reaches
   * a rival — but a replay's does, and "and the rest of them" said over a
   * melee has to mean this side's swordsmen, not both sides'.
   */
  #selectSameKind(unitId: number, additive: boolean): void {
    const kind = this.#sync.kindOf(unitId);
    if (kind === null) return;
    const owner = this.#sync.ownerOf(unitId);
    const now = performance.now();
    const w = this.#canvas.clientWidth;
    const h = this.#canvas.clientHeight;
    const sel = additive ? new Set(this.#selection) : new Set<number>();
    const screen = this.#scratchScreen;
    for (const id of this.#sync.latestIds.keys()) {
      if (this.#sync.kindOf(id) !== kind) continue;
      if (this.#sync.ownerOf(id) !== owner) continue;
      if (!this.#selectableUnitScreenPosInto(id, now, screen)) continue;
      if (screen.x < 0 || screen.x > w || screen.y < 0 || screen.y > h)
        continue;
      sel.add(id);
    }
    // The one under the cursor is the subject of the gesture. It can fall a
    // pixel outside the box above (the projection is taken at the head, the
    // click radius is generous), and coming back without it would be the
    // gesture failing at the very unit it was aimed at.
    sel.add(unitId);
    this.#setBuilding(null);
    this.#setSel(sel);
  }

  /**
   * The touch grammar: tap a unit to select it; tap one of your buildings to
   * open its panel; otherwise, with a selection standing, tap the ground (or
   * a foe) to send them there. Empty ground with nothing selected clears.
   *
   * Your own buildings outrank the move order on purpose. A finger has one
   * gesture, so while a selection stood, a tap on the brewery marched them
   * over instead of opening it — and with the village built up, that left
   * the panels reachable only by deselecting first. Nothing is lost: a
   * building's tiles are blocked, so that order only ever walked them to
   * the free ground beside it, which is exactly what tapping beside it
   * does. That still holds now the tap reaches up the walls rather than
   * stopping at the plate, because the order it outranks would aim at the
   * building's own tile too (see #orderTarget) — blocked ground, and the
   * same walk to the same doorstep. Foreign buildings stay an order, so an
   * enemy camp still raids.
   */
  #touchTap(px: number, py: number): void {
    const unitId = this.#unitAt(px, py);
    const repeatUnit = this.#repeatUnitPress(
      unitId,
      px,
      py,
      DOUBLE_TAP_MS,
      DOUBLE_TAP_RADIUS_PX,
    );
    if (unitId >= 0) {
      this.#lastMoveTap = null;
      // The mouse's double-click, given to the finger: tap a soldier, tap
      // them again, and their whole kind on screen comes along. A phone
      // has no shift, so this is the only way it can grab a kind at all
      // short of arming the marquee and drawing a band around them.
      if (repeatUnit) {
        this.#selectSameKind(unitId, false);
        return;
      }
      this.#setBuilding(null);
      this.#setSel(new Set([unitId]));
      return;
    }
    const building = this.#selectableBuildingAt(px, py);
    if (building) {
      this.#lastMoveTap = null;
      this.#setSel(new Set());
      this.#setBuilding(building);
      return;
    }
    // Ground, with people selected: send them. A replay cannot, so there
    // the tap falls through to the deselect below rather than becoming a
    // gesture that does nothing at all — letting go is the one thing a
    // spectator's tap on bare grass can still mean.
    if (this.#selection.size > 0 && !replayMode()) {
      const now = performance.now();
      const prev = this.#lastMoveTap;
      const dx = prev ? px - prev.px : 0;
      const dy = prev ? py - prev.py : 0;
      if (
        prev &&
        now - prev.time <= DOUBLE_TAP_MS &&
        dx * dx + dy * dy <= DOUBLE_TAP_RADIUS_PX * DOUBLE_TAP_RADIUS_PX
      ) {
        // A repeat tap on the spot escalates the standing order to a full
        // attack-move. It re-aims at the tile the first tap ordered — the
        // second tap is a modifier, not a new aim, so the squad's goal
        // doesn't wobble a tile between two presses of one finger. Further
        // taps land in this branch again and simply keep the order standing.
        this.#sendMove(prev.tileX, prev.tileY, true);
        this.#orderPulse(px, py, true);
        prev.px = px;
        prev.py = py;
        prev.time = now;
        return;
      }
      // The phone default is the half attack-move: one gesture has to serve
      // both "go fight over there" and "get out of there". Quiet for the
      // front half of the walk, so a tap away from a lost fight actually
      // escapes it; live for the back half, so a tapped army still fights
      // what it finds where it was sent.
      const tile = this.#issueMove(px, py, 'half');
      this.#lastMoveTap = tile
        ? {px, py, tileX: tile.x, tileY: tile.y, time: now}
        : null;
      return;
    }
    this.deselectAll();
  }

  /**
   * The world under a still pointer has changed — the camera moved. Ask
   * for the same scan a pointermove asks for, on the same once-a-frame
   * budget: the deferral is about how often the scan runs, not about what
   * is allowed to trigger it.
   */
  markHoverDirty(): void {
    this.#hoverDirty = true;
  }

  /** Run the deferred hover scan (and the placement ghost, which defers
   * from pointermove the same way), if the pointer moved since last frame
   * — or the camera did, which moves the world under it just the same. */
  updateHoverIfDirty(): void {
    if (!this.#hoverDirty) return;
    this.#hoverDirty = false;
    this.#updateGhost(this.#hoverX, this.#hoverY);
    // A finger dragging the map is not hovering over it — see #onMove. The
    // ghost above still tracks: a building being aimed is the one thing a
    // travelling finger is genuinely pointing at.
    if (this.#touchPan) return;
    this.#updateHover(this.#hoverX, this.#hoverY);
  }

  /** Track the armed building's ghost under the pointer. */
  #updateGhost(px: number, py: number): void {
    const type = placing();
    if (!type) return;
    const origin = this.#placementOrigin(px, py);
    if (!origin) return;
    this.#ghost.show(type);
    this.#ghost.moveTo(
      origin.x,
      origin.y,
      this.#canPlaceHere(type, origin.x, origin.y),
    );
  }

  /** Track what's under the cursor — any owner; hp is interesting on foes. */
  #updateHover(px: number, py: number): void {
    const now = performance.now();
    let bestId = -1;
    let bestDist = CLICK_RADIUS_PX * CLICK_RADIUS_PX;
    // Touch placement mode has no hover to show — skip the unit scan.
    if (!(this.#hoverIsTouch && placing())) {
      const pos = this.#scratchPos;
      for (const id of this.#sync.latestIds.keys()) {
        if (!this.#sync.positionOfInto(id, now, pos)) continue;
        const groundY = this.#heights.at(pos.x, pos.y);
        const screen = worldToScreen(
          this.#camera,
          this.#canvas,
          pos.x,
          groundY + 0.4,
          pos.y,
          this.#scratchScreen,
        );
        const dx = screen.x - px;
        const dy = screen.y - py;
        const d = dx * dx + dy * dy;
        if (d < bestDist) {
          bestDist = d;
          bestId = id;
        }
      }
    }
    this.#hoverUnit = bestId;
    this.#hoverBuilding = bestId < 0 ? this.#buildingAt(px, py) : -1;
  }

  /**
   * Whose things this client may put a ring around.
   *
   * A live match: your own, and only your own. A selection is the list an
   * order is spent on, so a ring around a rival's knight would be a
   * promise the sim has no intention of keeping.
   *
   * A replay is that same match with the orders taken out — the log is the
   * sim's whole diet, a stray click never reaches the tick (see
   * app/simWorker.ts), and there is nobody left to hide anything from. So
   * playback lets the pointer reach every seat: watching what the Warlord
   * built, and which of his huts stood idle, is most of why anyone opens a
   * recording at all.
   */
  #selectable(owner: number | null): boolean {
    return owner !== null && (replayMode() || owner === myPlayerId());
  }

  /** Screen position of a unit this client may select, written into `out`;
   * false for anyone else's — and for one the fog is holding, which
   * positionOfInto answers for by reporting no position at all. */
  #selectableUnitScreenPosInto(
    id: number,
    now: number,
    out: {x: number; y: number},
  ): boolean {
    if (!this.#selectable(this.#sync.ownerOf(id))) return false;
    return this.#unitScreenPosInto(id, now, out);
  }

  /**
   * The same, for ANY unit the fog is not holding — selection's ownership
   * gate lifted.
   *
   * Selection wants only your own, because a ring is a promise about who
   * an order will be spent on. An order AGAINST somebody wants the
   * opposite: naming a rival's knight is the whole gesture, and the pick
   * that finds him must not stop at the same fence.
   */
  #unitScreenPosInto(
    id: number,
    now: number,
    out: {x: number; y: number},
  ): boolean {
    const pos = this.#scratchPos;
    if (!this.#sync.positionOfInto(id, now, pos)) return false;
    const groundY = this.#heights.at(pos.x, pos.y);
    worldToScreen(this.#camera, this.#canvas, pos.x, groundY + 0.4, pos.y, out);
    return true;
  }

  /** Nearest own unit within tap radius of a screen point, or -1. */
  #unitAt(px: number, py: number): number {
    const now = performance.now();
    let bestId = -1;
    let bestDist = CLICK_RADIUS_PX * CLICK_RADIUS_PX;
    const screen = this.#scratchScreen;
    for (const id of this.#sync.latestIds.keys()) {
      if (!this.#selectableUnitScreenPosInto(id, now, screen)) continue;
      const dx = screen.x - px;
      const dy = screen.y - py;
      const d = dx * dx + dy * dy;
      if (d < bestDist) {
        bestDist = d;
        bestId = id;
      }
    }
    return bestId;
  }

  /** Nearest unit under a screen point that is NOT yours, or -1 — the pick
   * an order against somebody needs. Bandits count: right-clicking a
   * raider is as good a way to name him as any. */
  #hostileUnitAt(px: number, py: number): number {
    const me = myPlayerId();
    const now = performance.now();
    let bestId = -1;
    let bestDist = CLICK_RADIUS_PX * CLICK_RADIUS_PX;
    const screen = this.#scratchScreen;
    for (const id of this.#sync.latestIds.keys()) {
      const owner = this.#sync.ownerOf(id);
      if (owner === null || owner === me) continue;
      if (!this.#unitScreenPosInto(id, now, screen)) continue;
      const dx = screen.x - px;
      const dy = screen.y - py;
      const d = dx * dx + dy * dy;
      if (d < bestDist) {
        bestDist = d;
        bestId = id;
      }
    }
    return bestId;
  }

  /**
   * The building under a screen point, or -1. Walls and roofs count, not
   * just the ground the building stands on: a castle is mostly sky from
   * this camera, and a click on its towers means the castle.
   */
  #buildingAt(px: number, py: number): number {
    return screenToBuilding(
      this.#camera,
      this.#canvas,
      px,
      py,
      this.#heights,
      this.#probe,
    );
  }

  /**
   * The tile an order aimed at this screen point should go to. A point on a
   * building's drawn box aims at that building; bare ground aims where the
   * ray meets it.
   *
   * Orders read the same pick as the hover highlight for one reason: the
   * highlight is the promise. The bar that lights under the pointer says
   * "this is what you are about to order against", and a click that then
   * landed on the ground four tiles behind the wall — which is where the
   * ground under a keep's tower is — marched the squad around the thing
   * they aimed at. The footprint's center rather than the tile the box was
   * crossed over: a building is one target, and aiming at the middle of it
   * puts the pathing on the same footing wherever on the walls you clicked.
   */
  #orderTarget(px: number, py: number): {x: number; y: number} | null {
    const id = this.#buildingAt(px, py);
    const b = id >= 0 ? this.#mirror.buildings.get(id) : undefined;
    if (b) return {x: Math.floor(b.x + b.w / 2), y: Math.floor(b.y + b.h / 2)};
    const ground = screenToGround(
      this.#camera,
      this.#canvas,
      px,
      py,
      this.#heights,
    );
    if (!ground) return null;
    return {x: Math.floor(ground.x), y: Math.floor(ground.z)};
  }

  /**
   * The building under a screen point this client may open a card for, or
   * null — yours in a live match, any seat's in a replay.
   *
   * A rival's has to clear the fog first, and *explored* rather than
   * visible ground because that is the rule the renderer draws by: a
   * building on ground the watching seat once scouted stays on screen from
   * memory, and one on ground it never reached is not drawn at all.
   * Without the gate a click into the dark would open a card for a hut
   * nobody can see, reading its stock and its staffing straight off ground
   * the seat never walked — the card telling the player what the picture
   * deliberately does not. F lifts the fog and the same click then lands,
   * which is the point of that key.
   */
  #selectableBuildingAt(px: number, py: number): BuildingSnap | null {
    const bId = this.#buildingAt(px, py);
    const snap = bId >= 0 ? this.#mirror.buildings.get(bId) : undefined;
    if (!snap || !this.#selectable(snap.owner)) return null;
    if (
      snap.owner !== myPlayerId() &&
      this.#fog &&
      !this.#fog.exploredAt(snap.x + snap.w / 2, snap.y + snap.h / 2)
    ) {
      return null;
    }
    return snap;
  }

  #selectAtPoint(px: number, py: number, additive: boolean): void {
    const bestId = this.#unitAt(px, py);
    if (bestId < 0 && !additive) {
      // No unit under the cursor — try a building.
      const snap = this.#selectableBuildingAt(px, py);
      if (snap) {
        this.#setSel(new Set());
        this.#setBuilding(snap);
        return;
      }
    }
    this.#setBuilding(null);
    const sel = additive ? new Set(this.#selection) : new Set<number>();
    if (bestId >= 0) {
      if (additive && sel.has(bestId)) sel.delete(bestId);
      else sel.add(bestId);
    }
    this.#setSel(sel);
  }

  /**
   * Every one of yours the band closed over.
   *
   * The card goes with it, exactly as a click's does. A unit selection and
   * an open building are mutually exclusive — SelectionPanel draws the
   * "N units selected" card only where no building is open — and the band
   * was the one gesture that picked people up without saying so. Lasso a
   * squad with the keep's card standing and the squad was selected, rings
   * and all, while the HUD went on showing the keep: the whole gesture
   * read as having done nothing.
   */
  #selectInRect(
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    additive: boolean,
  ): void {
    const now = performance.now();
    const minX = Math.min(x0, x1);
    const maxX = Math.max(x0, x1);
    const minY = Math.min(y0, y1);
    const maxY = Math.max(y0, y1);
    const screen = this.#scratchScreen;
    const caught: number[] = [];
    for (const id of this.#sync.latestIds.keys()) {
      if (!this.#selectableUnitScreenPosInto(id, now, screen)) continue;
      if (
        screen.x >= minX &&
        screen.x <= maxX &&
        screen.y >= minY &&
        screen.y <= maxY
      ) {
        caught.push(id);
      }
    }
    const owner = this.#bandOwner(caught, additive);
    const sel = additive ? new Set(this.#selection) : new Set<number>();
    for (const id of caught) {
      if (this.#sync.ownerOf(id) === owner) sel.add(id);
    }
    this.#setBuilding(null);
    this.#setSel(sel);
  }

  /**
   * The one seat these people belong to, or null when they are not one
   * seat's — which is what the card needs, because "12 units selected"
   * under a name that only covers eight of them is worse than no name.
   *
   * Every gesture that grabs a crowd at once commits to a single banner
   * (see #bandOwner), so in practice this is that banner. Shift-clicking
   * across a battle one unit at a time can still build a mixed set: the
   * player picked each of them deliberately, and the honest answer to
   * "whose are these" is then nobody's in particular.
   */
  #soleOwner(sel: ReadonlySet<number>): number | null {
    let owner: number | null = null;
    for (const id of sel) {
      const o = this.#sync.ownerOf(id);
      if (o === null) continue;
      if (owner === null) owner = o;
      else if (owner !== o) return null;
    }
    return owner;
  }

  /**
   * Whose people a band comes back holding. One seat's, always.
   *
   * Live there is nothing to decide — the rectangle only ever closes over
   * your own. Watching a replay it could close over a whole battle, and a
   * selection flying two banners is one the card cannot name, the rings
   * cannot color, and the number at the top of it means nothing in: "27
   * units selected" across both sides of a fight is not a fact about
   * anything.
   *
   * So: the seat with the most people inside the rectangle, the lower seat
   * breaking a tie. Dragged over the Warlord's village that is the Warlord,
   * which is what the gesture was aimed at; dragged over a melee it is
   * whoever brought more, which is at least the side the eye was on. A
   * shift-drag keeps the seat already selected instead, so a squad is grown
   * a corner of the map at a time rather than swapped out from under the
   * hand halfway through — but only where the people already held ARE one
   * seat's. A set shift-clicked out of both sides has no seat to keep, and
   * reading one off whichever id the selection happens to yield first would
   * decide the drag by the order the player clicked in three gestures ago,
   * which is not on screen and not a rule anyone could learn. So a mixed
   * hand falls through to the count below, and the drag adds what a plain
   * drag would have taken.
   */
  #bandOwner(caught: readonly number[], additive: boolean): number | null {
    if (additive) {
      const held = this.#soleOwner(this.#selection);
      if (held !== null) return held;
    }
    const counts = new Map<number, number>();
    let best: number | null = null;
    let bestCount = 0;
    for (const id of caught) {
      const owner = this.#sync.ownerOf(id);
      if (owner === null) continue;
      const n = (counts.get(owner) ?? 0) + 1;
      counts.set(owner, n);
      if (n > bestCount || (n === bestCount && best !== null && owner < best)) {
        best = owner;
        bestCount = n;
      }
    }
    return best;
  }

  /**
   * A number key, bound the way both StarCrafts bind it:
   *
   * - **Ctrl+N** stamps the standing selection onto group N, replacing
   *   whatever was there.
   * - **Shift+N** adds the standing selection to group N and leaves the
   *   selection alone — the way a squad is grown a reinforcement at a time
   *   without having to re-drag the whole army.
   * - **N** calls group N back.
   * - **N twice** inside a beat also rides the camera out to them, which is
   *   the half of this binding that makes it a two-front game rather than a
   *   selection shortcut.
   *
   * What is stamped is whatever is selected, and that is either people or
   * one of your buildings. A building on a number is the economy's half of
   * this binding: Ctrl+4 on the barracks, and 4 opens its card from
   * anywhere, so hiring a soldier costs a keypress instead of a trip back
   * across the map — and 4 twice brings the camera along when the trip is
   * the point. The castle, the smithy and the storehouse all earn a number
   * the same way.
   *
   * A group is a list of ids, not a snapshot of a squad, and prune() weeds
   * the dead out of every group each frame — razed buildings as much as
   * fallen soldiers. So a group that lost half its soldiers calls back the
   * half that lived, and one that lost all of them (or the barracks it was)
   * refuses out loud rather than answering with an empty selection — losing
   * the squad you still had selected is the worse of the two failures.
   */
  #controlGroup(digit: number, assign: boolean, add: boolean): void {
    if (assign || add) this.#stampGroup(digit, assign);
    else this.#recallGroup(digit);
  }

  /** Ctrl+N and Shift+N: put the standing selection on this number. */
  #stampGroup(digit: number, assign: boolean): void {
    const held = this.#groups.get(digit);
    // Shift is the half of this binding that has never destroyed a group,
    // and a building is no reason to start: a number holding people is not
    // somewhere Shift may put a barracks, and a number holding a barracks
    // is not somewhere it may add a soldier — there is nothing to add to,
    // since a building group is the one building. So Shift takes a free
    // number and refuses a taken one; Ctrl is how a group is overwritten,
    // here as anywhere. A group emptied by casualties counts as free.
    const building = selectedBuilding();
    if (building) {
      const already =
        held?.kind === ControlGroupKind.building && held.id === building.id;
      if (!assign && !already && !groupEmpty(held)) {
        play('uiRefused');
        return;
      }
      this.#groups.set(digit, {
        kind: ControlGroupKind.building,
        id: building.id,
      });
      play('uiClick');
      // The badge on the card is the only thing on screen that says the
      // stamp took, so it has to be republished here: neither spelling of
      // this changed the selection itself.
      this.#publishGroup();
      return;
    }
    // Nothing to stamp. Refuse rather than write the empty set: Ctrl+1
    // pressed a moment after the squad was wiped (or after a stray click
    // on empty ground) would otherwise quietly throw away the group it
    // was meant to confirm.
    if (this.#selection.size === 0) {
      play('uiRefused');
      return;
    }
    if (!assign && held?.kind === ControlGroupKind.building) {
      play('uiRefused');
      return;
    }
    const ids =
      assign || held?.kind !== ControlGroupKind.units
        ? new Set<number>()
        : held.ids;
    for (const id of this.#selection) ids.add(id);
    this.#groups.set(digit, {kind: ControlGroupKind.units, ids});
    play('uiClick');
    this.#publishGroup();
  }

  /** N: call this number back — and the second press rides out to it. */
  #recallGroup(digit: number): void {
    const group = this.#groups.get(digit);
    if (!group || groupEmpty(group)) {
      play('uiRefused');
      return;
    }
    // A razed (or sold) building, caught in the narrow window before
    // prune() gets to its group: still a refusal, not a card opened onto a
    // stale snapshot. The press is not remembered either — a refusal is not
    // a first press, and recording it would hand the *next* press of this
    // number to the camera when that press is someone's first real recall.
    const snap =
      group.kind === ControlGroupKind.building
        ? this.#mirror.buildings.get(group.id)
        : null;
    if (group.kind === ControlGroupKind.building && !snap) {
      this.#groups.delete(digit);
      play('uiRefused');
      this.#publishGroup();
      return;
    }
    const now = performance.now();
    const prev = this.#lastRecall;
    this.#lastRecall = {digit, time: now};
    this.#lastMoveTap = null;
    // Every press recalls. The camera is what the second press *adds*, not
    // something it does instead: a player who let go of what the number
    // holds (Esc, a click on grass) and then pressed it twice was flown out
    // to a squad that was no longer selected — or to a barracks whose card
    // never opened, which is the one thing the stamp was for. Re-calling
    // what is already standing is a no-op, so the ordinary double-press
    // pays nothing for this.
    if (snap) {
      // The two selections are mutually exclusive: clear first, then open.
      // #setSel republishes the badge, which reads the open card.
      this.#setSel(new Set());
      this.#setBuilding(snap);
    } else if (group.kind === ControlGroupKind.units) {
      this.#setBuilding(null);
      this.#setSel(new Set(group.ids));
    }
    // The second press is the camera's. Further presses land here again
    // and simply re-centre, which is what a player leaning on the key
    // means by it.
    if (
      prev !== null &&
      prev.digit === digit &&
      now - prev.time <= GROUP_RECALL_MS
    ) {
      if (snap) this.#rig?.glideTo(snap.x + snap.w / 2, snap.y + snap.h / 2);
      else if (group.kind === ControlGroupKind.units)
        this.#glideToGroup(group.ids);
    }
  }

  /** Ride out to the middle of a group — the second press of its number. */
  #glideToGroup(group: ReadonlySet<number>): void {
    const now = performance.now();
    const pos = this.#scratchPos;
    let sumX = 0;
    let sumY = 0;
    let n = 0;
    for (const id of group) {
      // Fog can swallow a position even for your own people (positionOfInto
      // reports none for anything hidden), so the count is what divides,
      // not the group size.
      if (!this.#sync.positionOfInto(id, now, pos)) continue;
      sumX += pos.x;
      sumY += pos.y;
      n++;
    }
    if (n === 0) {
      play('uiRefused');
      return;
    }
    this.#rig?.glideTo(sumX / n, sumY / n);
  }

  /** Push the card's group badge — see matchingGroup for what it means. */
  #publishGroup(): void {
    const b = selectedBuilding();
    setSelectionGroup(
      matchingGroup(this.#groups, this.#selection, b?.id ?? null),
    );
  }

  /**
   * Open a building's card, or close it — and republish the badge, since
   * the open card is now half of what the badge is computed from. Every
   * path in here goes through this rather than the store's setter for that
   * one reason; the store's setter is still main.ts's, which only ever
   * swaps a fresh snapshot of the same building in.
   */
  #setBuilding(snap: BuildingSnap | null): void {
    // Same order as #setSel, for the same reason: the card is drawn
    // against the viewed seat's stock and techs.
    if (snap) this.#viewOwner(snap.owner);
    setSelectedBuilding(snap);
    this.#publishGroup();
  }

  /**
   * Turn the HUD to face the seat whose people or building was just
   * picked — a replay's rule, and only a replay's (see viewerId in the
   * store). Live, the pointer reaches nobody else's, so there is nothing
   * to turn to; and a live HUD that could be turned by pointing would be
   * one that read a rival's stores off a mis-click.
   *
   * Nobody's, or a mixed set's, leaves it where it was: a click on the
   * ground clears the rings, not the strip. Bandits own no seat and have
   * no stores to show, so their camp is looked at from wherever the HUD
   * already stands.
   */
  #viewOwner(owner: number | null): void {
    if (!replayMode() || owner === null || !isPlayerOwner(owner)) return;
    viewSeat(owner);
  }

  /**
   * Send the selection somewhere. `attack` picks between the four orders:
   * `true` is an attack-move that engages enemies met along the way,
   * `'half'` walks the front half of the route as a plain move before going
   * live, `'patrol'` walks there and back and there again until told
   * otherwise, and `false` is the plain move that ignores enemies
   * throughout. A single touch tap sends the half order (safe to flee
   * with); a repeat tap escalates it to the full attack-move; desktop
   * right-click is the plain move, and A, M or P arms the explicit
   * attack-move, move or patrol for the next click.
   *
   * `queue` lines the order up behind the squad's standing ones instead of
   * replacing them (see #sendMove); on a patrol it adds the spot to the
   * beat.
   *
   * Returns the ordered tile, so the touch double-tap can re-aim its
   * escalation at exactly what the first tap ordered; null if the point
   * missed the ground — or if there was no order to give.
   */
  #issueMove(
    px: number,
    py: number,
    attack: MoveOrder,
    queue = false,
  ): {x: number; y: number} | null {
    const target = this.#orderTarget(px, py);
    if (!target) return null;
    return this.#issueMoveAt(target.x, target.y, attack, px, py, queue)
      ? target
      : null;
  }

  /**
   * The same order, aimed at a tile that was picked some other way than by
   * looking down the camera — the minimap's click, which knows exactly
   * which tile it means and has no ground pick to make. `px`/`py` are the
   * click itself: where the confirming pulse blooms, which for a chart
   * order is over the chart, not over the ground it points at.
   *
   * Returns whether the order went out.
   */
  #issueMoveAt(
    x: number,
    y: number,
    attack: MoveOrder,
    px: number,
    py: number,
    queue = false,
  ): boolean {
    // Playback has always dropped orders at the worker's door, which was
    // enough while the only squad a replay could select was the watching
    // seat's own. It is not enough now that the ring may be around the
    // Warlord's knights: the pulse and its haptic tick say "order taken",
    // and a click that says so of a rival's people in a finished match is
    // the interface lying about who is in charge of what.
    if (replayMode()) return false;
    if (this.#selection.size === 0) return false;
    this.#sendMove(x, y, attack, queue);
    this.#orderPulse(px, py, attack);
    return true;
  }

  /**
   * The armed order, if it can still be spent. A rally whose barracks is
   * gone (razed while the mode stood armed — the one path no selection
   * change announces) is disarmed here and reported as no order at all,
   * so the click it would have eaten keeps its ordinary meaning instead
   * of being swallowed to plant nothing.
   */
  #liveOrder(): OrderMode | null {
    const order = orderMode();
    if (order === OrderMode.rally && !this.#rallyTarget()) {
      this.armOrder(null);
      return null;
    }
    return order;
  }

  /**
   * The selected building, if it can take a rally flag right now: yours,
   * built, and of a kind that trains. Null is both "no barracks open" and
   * "a replay takes no orders" — every rally path asks this first, so the
   * two gates are written once.
   */
  #rallyTarget(): BuildingSnap | null {
    if (replayMode()) return null;
    const b = selectedBuilding();
    if (!b || b.owner !== myPlayerId() || !canRally(b)) return null;
    return b;
  }

  /**
   * Plant the selected barracks' rally flag at this screen point — or take
   * it down, when the point is the barracks itself: aiming the flag at its
   * own door is the "back to normal" gesture, and it needs one, because
   * the door is the one spot a flag cannot otherwise mean.
   */
  #issueRally(px: number, py: number): void {
    const b = this.#rallyTarget();
    if (!b) return;
    // Its own walls count as its door: the flag comes down for a click
    // anywhere the barracks is drawn, which is the same pixel that lights
    // it under the pointer.
    const onSelf = this.#buildingAt(px, py) === b.id;
    const target = this.#orderTarget(px, py);
    if (!target) return;
    this.#sendRally(b, target.x, target.y, onSelf, px, py);
  }

  /** The wire half of the flag, aimed at a tile directly — see #issueMove
   * and #issueMoveAt for why the pair is split this way. */
  #sendRally(
    b: BuildingSnap,
    x: number,
    y: number,
    onSelf: boolean,
    px: number,
    py: number,
  ): void {
    this.#host.sendCommands([
      onSelf
        ? {kind: CommandKind.setRallyPoint, buildingId: b.id}
        : {kind: CommandKind.setRallyPoint, buildingId: b.id, x, y},
    ]);
    // Solid gold: an order taken, but nobody moves for it yet — the pulse
    // shape family the move orders wear, in the flag's own color.
    this.#pulse(px, py, 'solid #e5c469');
  }

  /** Plant the flag at a tile the chart named, or take it down when that
   * tile is one of the barracks' own — the minimap's answer to clicking
   * the building's door, which on a chart is a couple of pixels wide but
   * is still the only gesture that can mean "back to normal". */
  #issueRallyAt(x: number, y: number, px: number, py: number): void {
    const b = this.#rallyTarget();
    if (!b) return;
    const onSelf = x >= b.x && x < b.x + b.w && y >= b.y && y < b.y + b.h;
    this.#sendRally(b, x, y, onSelf, px, py);
  }

  /**
   * Right-click — or A-click — on something hostile: attack THAT one.
   *
   * Two orders, because they do different halves of the job. The
   * attack-move walks the squad to it and keeps them fighting on the way;
   * the focus order (`focusTarget`) pins the specific target, which is the
   * part the sim would otherwise decide for itself — left alone,
   * `acquireUnit` sends each soldier at the nearest enemy it counters, so
   * a squad told to kill the barracks stops at the fence in front of it.
   *
   * A hostile unit under the cursor wins over the building behind it: a
   * click on a man standing against a wall means the man. Returns whether
   * the order went out, so both callers fall through to the plain order
   * they had before when the cursor is over open ground, one of your own,
   * or something you have not scouted.
   *
   * With Shift held (`queue`) only the attack-move goes out, queued: the
   * focus order takes effect the moment it lands, and a target pinned now
   * for a leg that starts later is the wrong fight for the men still
   * walking the first one. A queued attack-move onto his tile is what an
   * RTS gives a shift-click on an enemy anyway — the squad engages him
   * when it gets there, and the sim picks the target the way it always
   * does. A queued click on a building still becomes the assault on it:
   * the sim reads the building under the tile when the leg comes due.
   */
  #issueFocus(px: number, py: number, queue = false): boolean {
    // The same guard the move order keeps: a click in a finished match
    // must not pretend to command anybody.
    if (replayMode()) return false;
    if (this.#selection.size === 0) return false;
    const me = myPlayerId();
    // Only soldiers can be told to attack a thing. A selection of serfs
    // falls through and keeps the move order it meant.
    const fighters = [...this.#selection].filter(id => {
      const kind = this.#sync.kindOf(id);
      return kind !== null && MILITARY_CODES.has(kind);
    });
    if (fighters.length === 0) return false;

    let targetId = -1;
    let building = false;
    const unitId = this.#hostileUnitAt(px, py);
    if (unitId >= 0) targetId = unitId;
    if (targetId < 0) {
      const bId = this.#buildingAt(px, py);
      const snap = bId >= 0 ? this.#mirror.buildings.get(bId) : undefined;
      // Explored ground only, for the reason the selection check gives:
      // the fog may still be showing a building the seat has never walked,
      // and an order against one is the interface claiming knowledge the
      // player does not have.
      if (
        snap &&
        snap.owner !== me &&
        (!this.#fog ||
          this.#fog.exploredAt(snap.x + snap.w / 2, snap.y + snap.h / 2))
      ) {
        targetId = bId;
        building = true;
      }
    }
    if (targetId < 0) return false;

    const ground = this.#orderTarget(px, py);
    if (!ground) return false;
    this.#host.sendCommands(
      queue
        ? [
            {
              kind: CommandKind.moveUnits,
              unitIds: fighters,
              x: ground.x,
              y: ground.y,
              attack: true,
              queue: true,
            },
          ]
        : [
            {
              kind: CommandKind.moveUnits,
              unitIds: fighters,
              x: ground.x,
              y: ground.y,
              attack: true,
            },
            // After the move, never before: applyMoveUnits sets the task,
            // and the sim skips a focus order for anything on a plain move.
            {
              kind: CommandKind.focusTarget,
              unitIds: fighters,
              targetId,
              ...(building ? {building: true as const} : {}),
            },
          ],
    );
    this.#orderPulse(px, py, true);
    return true;
  }

  /**
   * The wire half of a move order, aimed at a tile directly. `queue` is the
   * Shift-click every RTS since Warcraft II has spelled a route with: the
   * order waits behind the ones the squad is already walking rather than
   * replacing them, so a string of shift-clicks is walked point by point.
   * An unshifted click drops the string. The sim owns the queue (Unit.orders):
   * this side only says which kind of click it was. A patrol is its own
   * flag rather than a third attack value: the sim reads it as the live
   * order it is, and the attack flag stays home.
   */
  #sendMove(x: number, y: number, attack: MoveOrder, queue = false): void {
    if (this.#selection.size === 0) return;
    this.#host.sendCommands([
      {
        kind: CommandKind.moveUnits,
        unitIds: [...this.#selection],
        x,
        y,
        ...(attack === 'patrol'
          ? {patrol: true as const}
          : attack
            ? {attack}
            : {}),
        ...(queue ? {queue: true as const} : {}),
      },
    ]);
  }

  /** A ring blooming at the tap/click plus a tick of haptics: order taken.
   * Attack-moves pulse a solid red ring, plain moves a dashed gold one, the
   * half order a dotted red and a patrol a double red — four border styles,
   * so the shape carries the difference where color vision cannot. (The
   * rally flag pulses too, through #pulse directly: solid gold.) */
  #orderPulse(px: number, py: number, attack: MoveOrder): void {
    this.#pulse(
      px,
      py,
      attack === true
        ? 'solid #bf4342'
        : attack === 'half'
          ? 'dotted #bf4342'
          : attack === 'patrol'
            ? 'double #bf4342'
            : 'dashed #e5c469',
    );
  }

  #pulse(px: number, py: number, border: string): void {
    const el = document.createElement('div');
    el.style.cssText =
      `position:fixed;left:${px}px;top:${py}px;width:44px;height:44px;` +
      `margin:-22px 0 0 -22px;border:2px ${border};` +
      'border-radius:50%;pointer-events:none;z-index:10;opacity:0.9;' +
      'animation:serf-order-pulse 0.45s ease-out forwards;';
    if (!document.getElementById('serf-order-pulse-style')) {
      const style = document.createElement('style');
      style.id = 'serf-order-pulse-style';
      style.textContent =
        '@keyframes serf-order-pulse { from { transform: scale(1); opacity: 0.9; }' +
        ' to { transform: scale(0.25); opacity: 0; } }';
      document.head.appendChild(style);
    }
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 500);
    navigator.vibrate?.(12);
    play('uiOrder');
  }

  /** Clear both unit selection and the building panel (HUD ✕ button). */
  deselectAll(): void {
    this.#lastMoveTap = null;
    this.#setSel(new Set());
    this.#setBuilding(null);
  }

  /**
   * A face on the selection card, clicked or tapped.
   *
   * The card's tiles are the squad the player is already holding, so this
   * is the same gesture the map's click is, aimed at a picture instead of
   * at a man forty tiles away: plain picks him out of the band on his own,
   * and shift drops him from it. Both are `#selectAtPoint`'s rule with the
   * pick already made — additive toggles, and a tile is by definition one
   * of the selected, so shift on one always means "not him".
   *
   * The finger gets the plain half for free (a tap is a click) and the
   * shift half not at all, which is the same bargain the map makes it.
   *
   * There is deliberately no double-click here, though the map has one
   * (two clicks on a man take his whole kind). It cannot work on a tile:
   * the first click leaves one man selected, the roster stops drawing at
   * one, and the second click of the pair lands on whatever the card
   * shrank away from — the map behind it, which reads as a click on grass
   * and lets the squad go. The gesture stays where it works.
   */
  pickUnit(id: number, additive: boolean): void {
    // Before the guard below, not after it. The finger's double-tap
    // escalation re-aims at the tile the *first* tap ordered, so a face
    // pressed between two taps on the same patch of grass would hand a
    // full attack-move to a different set of men, at a target chosen for
    // the men no longer holding it. What cancels that is the player
    // turning to the card at all — not whether the press happened to
    // find a live man, which is a race they neither see nor caused. Put
    // after the guard, the one case the guard exists for was also the
    // one case that left the tap armed. Every other path that changes
    // who is selected drops it unconditionally too: #touchTap on a unit
    // or a building, a group recalled, deselectAll.
    this.#lastMoveTap = null;
    // Belt and braces: a card cannot be showing a man the publish has
    // buried, but the click arrives a frame after the paint either way.
    if (!this.#sync.latestIds.has(id) || this.#sync.isDead(id)) return;
    this.#setBuilding(null);
    const sel = additive ? new Set(this.#selection) : new Set<number>();
    if (additive && sel.has(id)) sel.delete(id);
    else sel.add(id);
    this.#setSel(sel);
  }

  /**
   * Hold ground: the selected soldiers stop where they stand and fight
   * only what comes within reach (sim: UnitTaskKind.hold). The H key and
   * the card's Hold button both land here.
   *
   * An order, not a mode — it goes out on the spot — which is why it is
   * the one squad command with no click behind it and no target to pick.
   * The soldiers are picked out of the selection here rather than left to
   * the sim, so an order the sim would answer with nothing (a band of
   * serfs) is not confirmed as if it had been taken: the sim re-checks
   * every man anyway, but the pulse and the tick say "order taken", and
   * that has to be true. Sending it disarms an A or M that was waiting
   * for a click: the squad they were armed for has just been given its
   * order.
   *
   * The confirming ring blooms over the squad itself, since there is no
   * click to bloom at — its screen centroid, which for a spread band is
   * somewhere among them. Returns whether the order went out.
   */
  holdGround(): boolean {
    if (replayMode()) return false;
    const fighters = [...this.#selection].filter(id => {
      const kind = this.#sync.kindOf(id);
      return kind !== null && MILITARY_CODES.has(kind);
    });
    if (fighters.length === 0) return false;
    this.#host.sendCommands([
      {kind: CommandKind.holdGround, unitIds: fighters},
    ]);
    this.armOrder(null);
    this.#lastMoveTap = null;
    const at = this.#scratchScreen;
    let px = 0;
    let py = 0;
    let n = 0;
    const now = performance.now();
    for (const id of fighters) {
      if (!this.#unitScreenPosInto(id, now, at)) continue;
      px += at.x;
      py += at.y;
      n++;
    }
    // Solid gold, the rally flag's ring: a thing planted rather than a
    // place walked to.
    if (n > 0) this.#pulse(px / n, py / n, 'solid #e5c469');
    else play('uiOrder');
    return true;
  }

  /** Select every soldier you own — the phone answer to band-dragging an army. */
  selectArmy(): void {
    const sel = new Set<number>();
    for (const id of this.#sync.latestIds.keys()) {
      if (this.#sync.ownerOf(id) !== myPlayerId()) continue;
      const kind = this.#sync.kindOf(id);
      if (kind !== null && MILITARY_CODES.has(kind)) sel.add(id);
    }
    this.#setBuilding(null);
    this.#setSel(sel);
  }
}
