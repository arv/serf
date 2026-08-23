import type * as THREE from 'three';
import { inBounds, tileIdx } from '../shared/grid';
import { buildingDef, type BuildingTypeId } from '../sim/defs/buildings';
import { canPlace } from '../sim/world';
import { UNIT_DEFS } from '../sim/defs/units';
import { HIRE_SERF_COST } from '../sim/defs/balance';
import {
  bandArm,
  buildChord,
  debugOpen,
  fogEnabled,
  lastAlert,
  muted,
  myPlayerId,
  openPanel,
  orderMode,
  placing,
  population,
  pushToast,
  quitConfirm,
  replayMode,
  selectedBuilding,
  setBandArm,
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
  setTechPanelOpen,
  stock,
  techPanelOpen,
  techs,
  toggleMuted,
  type OrderMode,
} from '../ui/store';
import { buildAffordable, buildUnlocked, buildingForKey } from '../ui/buildMenu';
import {
  HIRE_KEY,
  RALLY_KEY,
  RESEARCH_KEY,
  canHire,
  canRally,
  canTrain,
  trainingForKey,
  unitTechGate,
} from '../ui/commands';
import { techName, unitName } from '../ui/names';
import { fullscreen, guardEsc } from '../ui/fullscreen';
import { play } from '../audio/audio';
import { screenToGround, worldToScreen } from './picking';
import { keyDigit, matchingGroup } from './groups';
import { foreignChord, typingInto } from './typing';
import type { SceneSync } from '../render/sceneSync';
import type { GhostPlacement } from '../render/ghost';
import type { FogQuery } from '../render/fogOfWar';
import type { HeightField } from '../render/heightField';
import type { WorldMirror } from '../app/mirror';
import type { SimHost } from '../app/simHost';
import type { BuildingSnap } from '../protocol/messages';

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
const MILITARY_CODES = new Set(
  Object.values(UNIT_DEFS)
    .filter((d) => d.combat !== undefined)
    .map((d) => d.kindCode),
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
 * stamps, Shift+N adds, N calls back, N twice rides the camera out. They
 * are the one binding here that is not a mode at all — no click is claimed,
 * nothing has to be unwound, and Esc has no business with them.
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
  #selection = new Set<number>();
  /**
   * Control groups, bound the way both StarCrafts bind them: digit → the
   * unit ids stamped onto it.
   *
   * They live here beside the selection rather than in the store because
   * they are lists of ids and ids die: prune() already weeds the dead out
   * of the selection every frame, and a group is exactly the same problem.
   * The HUD gets the one crumb it needs (selectionGroup) pushed to it.
   */
  #groups = new Map<number, Set<number>>();
  /** The last group number called back, for the second press that rides
   * the camera out to it instead of re-selecting what is already selected. */
  #lastRecall: { digit: number; time: number } | null = null;
  /**
   * The last press that landed on one of your units — click or tap alike.
   * A second one on the same unit inside the window widens the selection to
   * that whole kind on screen; the id is what really decides it, so the two
   * input styles can share the record and differ only in how forgiving
   * their window and radius are.
   */
  #lastUnitPress: { id: number; px: number; py: number; time: number } | null = null;
  #dragStart: { x: number; y: number } | null = null;
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
  #scratchPos = { x: 0, y: 0 };
  #scratchScreen = { x: 0, y: 0 };
  #touchOrigin: { x: number; y: number } | null = null;
  /** The last ground move a tap ordered — a repeat tap on the spot inside
   * the double-tap window escalates it to a full attack-move. Screen point
   * for the "same spot" test, ordered tile so the escalation re-aims at
   * exactly what the first tap ordered even if the finger drifted. */
  #lastMoveTap: { px: number; py: number; tileX: number; tileY: number; time: number } | null =
    null;
  /** A marquee drag in flight (armed by the HUD's band button). */
  #bandTouch = false;
  /**
   * The camera, as much of it as this file has business touching: the touch
   * gate it closes while a marquee drag owns the finger, and the glide the
   * jump keys ride. Structural rather than the CameraRig type so a test can
   * hand in the two members instead of a renderer.
   */
  #rig: { touchPanEnabled: boolean; glideTo: (x: number, z: number) => void } | null;

  constructor(
    canvas: HTMLCanvasElement,
    camera: THREE.Camera,
    sync: SceneSync,
    host: SimHost,
    mirror: WorldMirror,
    ghost: GhostPlacement,
    heights: HeightField,
    rig?: { touchPanEnabled: boolean; glideTo: (x: number, z: number) => void },
  ) {
    this.#canvas = canvas;
    this.#camera = camera;
    this.#sync = sync;
    this.#host = host;
    this.#mirror = mirror;
    this.#ghost = ghost;
    this.#heights = heights;
    this.#rig = rig ?? null;

    this.#bandEl = document.createElement('div');
    this.#bandEl.style.cssText =
      'position:fixed; border:1px solid #bf4342; background:rgba(191,67,66,0.12); display:none; pointer-events:none; z-index:10;';
    document.body.appendChild(this.#bandEl);

    const signal = this.#off.signal;
    canvas.addEventListener('contextmenu', (e) => e.preventDefault(), { signal });
    canvas.addEventListener('pointerdown', this.#onDown, { signal });
    canvas.addEventListener('pointermove', this.#onMove, { signal });
    canvas.addEventListener('pointerup', this.#onUp, { signal });
    // The gesture can also end without a pointerup: the system takes it (a
    // notification shade, a browser back-swipe) or the capture is lost.
    // Nothing it was building up should land afterwards.
    canvas.addEventListener('pointercancel', this.#onCancel, { signal });
    canvas.addEventListener('lostpointercapture', this.#onCancel, { signal });
    window.addEventListener('keydown', this.#onKey, { signal });
    // Esc is this game's most-worn key, and inside fullscreen the browser
    // answers it too, with an exit no preventDefault can stop. Borrow the
    // key for the match (where the engine lends it at all); the menu keeps
    // the plain arrangement, having no modes for Esc to unwind.
    signal.addEventListener('abort', guardEsc(), { once: true });
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
    if (mode === 'rally') {
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
      else if (this.#selection.size > 0 || selectedBuilding() !== null) this.deselectAll();
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
      if ((e.key === ' ' || e.code === 'Space') && !(t instanceof HTMLButtonElement)) {
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
    if (b && b.owner === myPlayerId() && this.#buildingCommand(b, letter)) return;

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

    if (letter === RESEARCH_KEY) {
      // Not contextual: the tree is a sheet to read, not an order to give.
      setTechPanelOpen(!techPanelOpen());
      play('uiClick');
    } else if (letter === 'B') {
      // A replay takes no orders, so it offers no build card to chord into.
      if (replayMode()) return;
      setBuildChord(true);
      play('uiClick');
    } else if (letter === 'A' || letter === 'M') {
      if (this.#selection.size > 0 && !replayMode()) {
        this.armOrder(letter === 'A' ? 'attack' : 'move');
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

    if (letter === HIRE_KEY && b.type === 'storehouse' && b.state === 'built') {
      if (!canHire(b, stock(), population())) {
        const queued = b.hireQueue ?? 0;
        pushToast(
          (stock().silver ?? 0) < HIRE_SERF_COST
            ? `Not enough silver to hire — a serf costs ${HIRE_SERF_COST}.`
            : population().pop + queued >= population().cap
              ? 'Every bed is taken — build a house before you hire again.'
              : 'The recruiting queue is full.',
        );
        play('uiRefused');
        return true;
      }
      this.#host.sendCommands([{ kind: 'hireSerf' }]);
      play('uiCoin');
      return true;
    }

    if (letter === RALLY_KEY && canRally(b)) {
      // Arms the flag for the next click, exactly like the card's button.
      this.armOrder('rally');
      play('uiClick');
      return true;
    }

    const unit = trainingForKey(b, letter);
    if (unit !== null) {
      if (b.state !== 'built') return true;
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
      this.#host.sendCommands([{ kind: 'trainUnit', buildingId: b.id, unit }]);
      play('uiClick');
      return true;
    }

    return false;
  }

  /** Backspace: back to your own keep, the way both games spend that key. */
  #jumpHome(): void {
    for (const b of this.#mirror.buildings.values()) {
      if (b.type === 'storehouse' && b.owner === myPlayerId()) {
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
  #placementOrigin(px: number, py: number): { x: number; y: number } | null {
    const type = placing();
    if (!type) return null;
    const ground = screenToGround(this.#camera, this.#canvas, px, py, this.#heights);
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

  /** Drop ids that no longer exist (deaths); call once per frame. */
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
    for (const group of this.#groups.values()) {
      for (const id of group) {
        if (!this.#sync.latestIds.has(id) || this.#sync.isDead(id)) {
          group.delete(id);
          groupsChanged = true;
        }
      }
    }
    if (changed) this.#setSel(this.#selection);
    // The badge can go stale on a casualty that touched only the group (a
    // straggler nobody had selected), so it is refreshed even when the
    // selection itself came through the frame untouched.
    else if (groupsChanged) this.#publishGroup();
  }

  #setSel(sel: Set<number>): void {
    // A selection that grew is a player picking people up — worth a click.
    // Shrinking is not: prune() feeds deaths through here every frame, and
    // a death knell per battle casualty belongs to combat, not selection.
    if (sel !== this.#selection && sel.size > this.#selection.size) play('uiSelect');
    // An armed rally belongs to a selected building, and people being
    // selected is that building's card leaving the screen (the two
    // selections are mutually exclusive) — so the mode goes with it.
    // Without this, recalling a control group left rally armed with
    // nothing to plant for, and the next map click was swallowed. The
    // empty-selection case is the disarm further down.
    if (sel.size > 0 && orderMode() === 'rally') this.armOrder(null);
    this.#selection = sel;
    setSelection(new Set(sel));
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
          this.#touchOrigin = { x: e.clientX, y: e.clientY };
          return;
        }
        if (order === 'rally') this.#issueRally(e.clientX, e.clientY);
        else this.#issueMove(e.clientX, e.clientY, order === 'attack');
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
          this.#touchOrigin = { x: e.clientX, y: e.clientY };
          const origin = this.#placementOrigin(e.clientX, e.clientY);
          if (origin) {
            this.#ghost.show(type);
            this.#ghost.moveTo(origin.x, origin.y, this.#canPlaceHere(type, origin.x, origin.y));
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
      this.#dragStart = { x: e.clientX, y: e.clientY };
      this.#dragging = false;
      if (e.pointerType === 'touch') {
        this.#touchOrigin = { x: e.clientX, y: e.clientY };
        if (bandArm()) {
          // The marquee button armed this drag: it draws the selection
          // band, and the camera holds still until the finger lifts.
          this.#bandTouch = true;
          if (this.#rig) this.#rig.touchPanEnabled = false;
          this.#canvas.setPointerCapture(e.pointerId);
        }
      }
    } else if (e.button === 2) {
      // With nobody selected but a barracks open, the right-click is the
      // rally flag's shortcut — the gesture every RTS spends it on. With a
      // squad standing it stays the plain move it has always been.
      if (this.#selection.size === 0 && this.#rallyTarget()) {
        this.#issueRally(e.clientX, e.clientY);
      } else {
        this.#issueMove(e.clientX, e.clientY, false);
      }
    }
  };

  setFog(fog: FogQuery): void {
    this.#fog = fog;
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
    return this.#explored(x, y, def.w, def.h) && canPlace(this.#mirror.map, type, x, y);
  }

  /** Commit the armed building at this screen point, if it fits. */
  #place(px: number, py: number, keepArmed: boolean): void {
    const type = placing();
    if (!type) return;
    const origin = this.#placementOrigin(px, py);
    if (origin && this.#canPlaceHere(type, origin.x, origin.y)) {
      this.#host.sendCommands([
        { kind: 'placeBuilding', building: type, x: origin.x, y: origin.y },
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
      const def = buildingDef(type);
      pushToast(
        this.#explored(origin.x, origin.y, def.w, def.h)
          ? 'No room to build there.'
          : 'Too dark to build — nobody has scouted that ground.',
      );
      navigator.vibrate?.(30);
      play('uiRefused');
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
      return;
    }
    const dx = e.clientX - this.#dragStart.x;
    const dy = e.clientY - this.#dragStart.y;
    if (!this.#dragging && dx * dx + dy * dy > DRAG_THRESHOLD_PX * DRAG_THRESHOLD_PX) {
      this.#dragging = true;
      this.#canvas.setPointerCapture(e.pointerId);
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

    // An armed order takes the release the same way placement does, and for
    // the same reason: on touch the press only staked a claim.
    const order = this.#liveOrder();
    if (order) {
      if (e.pointerType === 'touch' && e.button === 0 && heldStill) {
        if (order === 'rally') this.#issueRally(e.clientX, e.clientY);
        else this.#issueMove(e.clientX, e.clientY, order === 'attack');
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
        if (dragged) this.#selectInRect(start.x, start.y, e.clientX, e.clientY, false);
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
    if (this.#repeatUnitPress(id, px, py, DOUBLE_CLICK_MS, DOUBLE_CLICK_RADIUS_PX)) {
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
  #repeatUnitPress(id: number, px: number, py: number, ms: number, radius: number): boolean {
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
    this.#lastUnitPress = { id, px, py, time: now };
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
   */
  #selectSameKind(unitId: number, additive: boolean): void {
    const kind = this.#sync.kindOf(unitId);
    if (kind === null) return;
    const now = performance.now();
    const w = this.#canvas.clientWidth;
    const h = this.#canvas.clientHeight;
    const sel = additive ? new Set(this.#selection) : new Set<number>();
    const screen = this.#scratchScreen;
    for (const id of this.#sync.latestIds.keys()) {
      if (this.#sync.kindOf(id) !== kind) continue;
      if (!this.#playerUnitScreenPosInto(id, now, screen)) continue;
      if (screen.x < 0 || screen.x > w || screen.y < 0 || screen.y > h) continue;
      sel.add(id);
    }
    // The one under the cursor is the subject of the gesture. It can fall a
    // pixel outside the box above (the projection is taken at the head, the
    // click radius is generous), and coming back without it would be the
    // gesture failing at the very unit it was aimed at.
    sel.add(unitId);
    setSelectedBuilding(null);
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
   * does. Foreign buildings stay an order, so an enemy camp still raids.
   */
  #touchTap(px: number, py: number): void {
    const unitId = this.#unitAt(px, py);
    const repeatUnit = this.#repeatUnitPress(unitId, px, py, DOUBLE_TAP_MS, DOUBLE_TAP_RADIUS_PX);
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
      setSelectedBuilding(null);
      this.#setSel(new Set([unitId]));
      return;
    }
    const building = this.#ownBuildingAt(px, py);
    if (building) {
      this.#lastMoveTap = null;
      this.#setSel(new Set());
      setSelectedBuilding(building);
      return;
    }
    if (this.#selection.size > 0) {
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
      this.#lastMoveTap = tile ? { px, py, tileX: tile.x, tileY: tile.y, time: now } : null;
      return;
    }
    this.deselectAll();
  }

  /** Run the deferred hover scan (and the placement ghost, which defers
   * from pointermove the same way), if the pointer moved since last frame. */
  updateHoverIfDirty(): void {
    if (!this.#hoverDirty) return;
    this.#hoverDirty = false;
    this.#updateGhost(this.#hoverX, this.#hoverY);
    this.#updateHover(this.#hoverX, this.#hoverY);
  }

  /** Track the armed building's ghost under the pointer. */
  #updateGhost(px: number, py: number): void {
    const type = placing();
    if (!type) return;
    const origin = this.#placementOrigin(px, py);
    if (!origin) return;
    this.#ghost.show(type);
    this.#ghost.moveTo(origin.x, origin.y, this.#canPlaceHere(type, origin.x, origin.y));
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
    this.#hoverBuilding = -1;
    if (bestId < 0) {
      const ground = screenToGround(this.#camera, this.#canvas, px, py, this.#heights);
      if (ground) {
        const tx = Math.floor(ground.x);
        const ty = Math.floor(ground.z);
        if (inBounds(tx, ty, this.#mirror.map.size)) {
          this.#hoverBuilding = this.#mirror.map.buildingAt[tileIdx(tx, ty, this.#mirror.map.size)]!;
        }
      }
    }
  }

  /** Screen position of an own unit, written into `out`; false otherwise. */
  #playerUnitScreenPosInto(id: number, now: number, out: { x: number; y: number }): boolean {
    if (this.#sync.ownerOf(id) !== myPlayerId()) return false;
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
      if (!this.#playerUnitScreenPosInto(id, now, screen)) continue;
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

  /** The building of yours under a screen point, or null. */
  #ownBuildingAt(px: number, py: number): BuildingSnap | null {
    const ground = screenToGround(this.#camera, this.#canvas, px, py, this.#heights);
    if (!ground) return null;
    const tx = Math.floor(ground.x);
    const ty = Math.floor(ground.z);
    if (!inBounds(tx, ty, this.#mirror.map.size)) return null;
    const bId = this.#mirror.map.buildingAt[tileIdx(tx, ty, this.#mirror.map.size)]!;
    const snap = bId >= 0 ? this.#mirror.buildings.get(bId) : undefined;
    return snap && snap.owner === myPlayerId() ? snap : null;
  }

  #selectAtPoint(px: number, py: number, additive: boolean): void {
    const bestId = this.#unitAt(px, py);
    if (bestId < 0 && !additive) {
      // No unit under the cursor — try a building.
      const snap = this.#ownBuildingAt(px, py);
      if (snap) {
        this.#setSel(new Set());
        setSelectedBuilding(snap);
        return;
      }
    }
    setSelectedBuilding(null);
    const sel = additive ? new Set(this.#selection) : new Set<number>();
    if (bestId >= 0) {
      if (additive && sel.has(bestId)) sel.delete(bestId);
      else sel.add(bestId);
    }
    this.#setSel(sel);
  }

  #selectInRect(x0: number, y0: number, x1: number, y1: number, additive: boolean): void {
    const now = performance.now();
    const minX = Math.min(x0, x1);
    const maxX = Math.max(x0, x1);
    const minY = Math.min(y0, y1);
    const maxY = Math.max(y0, y1);
    const sel = additive ? new Set(this.#selection) : new Set<number>();
    const screen = this.#scratchScreen;
    for (const id of this.#sync.latestIds.keys()) {
      if (!this.#playerUnitScreenPosInto(id, now, screen)) continue;
      if (screen.x >= minX && screen.x <= maxX && screen.y >= minY && screen.y <= maxY) {
        sel.add(id);
      }
    }
    this.#setSel(sel);
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
   * A group is a list of ids, not a snapshot of a squad, and prune() weeds
   * the dead out of every group each frame. So a group that lost half its
   * soldiers calls back the half that lived, and one that lost all of them
   * refuses out loud rather than answering with an empty selection — losing
   * the squad you still had selected is the worse of the two failures.
   */
  #controlGroup(digit: number, assign: boolean, add: boolean): void {
    if (assign || add) {
      // Nothing to stamp. Refuse rather than write the empty set: Ctrl+1
      // pressed a moment after the squad was wiped (or after a stray click
      // on empty ground) would otherwise quietly throw away the group it
      // was meant to confirm.
      if (this.#selection.size === 0) {
        play('uiRefused');
        return;
      }
      const group = assign ? new Set<number>() : (this.#groups.get(digit) ?? new Set<number>());
      for (const id of this.#selection) group.add(id);
      this.#groups.set(digit, group);
      play('uiClick');
      // The badge on the selection card is the only thing on screen that
      // says the stamp took, so it has to be republished here: neither
      // spelling of this changed the selection itself.
      this.#publishGroup();
      return;
    }

    const group = this.#groups.get(digit);
    if (!group || group.size === 0) {
      play('uiRefused');
      return;
    }
    const now = performance.now();
    const prev = this.#lastRecall;
    this.#lastRecall = { digit, time: now };
    if (prev && prev.digit === digit && now - prev.time <= GROUP_RECALL_MS) {
      // The second press is the camera's. Further presses land here again
      // and simply re-centre, which is what a player leaning on the key
      // means by it.
      this.#glideToGroup(group);
      return;
    }
    setSelectedBuilding(null);
    this.#lastMoveTap = null;
    this.#setSel(new Set(group));
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
    setSelectionGroup(matchingGroup(this.#groups, this.#selection));
  }

  /**
   * Send the selection somewhere. `attack` picks between the three orders:
   * `true` is an attack-move that engages enemies met along the way,
   * `'half'` walks the front half of the route as a plain move before going
   * live, and `false` is the plain move that ignores enemies throughout.
   * A single touch tap sends the half order (safe to flee with); a repeat
   * tap escalates it to the full attack-move; desktop right-click is the
   * plain move, and A or M arms the explicit attack-move or move for the
   * next click.
   *
   * Returns the ordered tile, so the touch double-tap can re-aim its
   * escalation at exactly what the first tap ordered; null if the point
   * missed the ground.
   */
  #issueMove(px: number, py: number, attack: boolean | 'half'): { x: number; y: number } | null {
    if (this.#selection.size === 0) return null;
    const ground = screenToGround(this.#camera, this.#canvas, px, py, this.#heights);
    if (!ground) return null;
    const x = Math.floor(ground.x);
    const y = Math.floor(ground.z);
    this.#sendMove(x, y, attack);
    this.#orderPulse(px, py, attack);
    return { x, y };
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
    if (order === 'rally' && !this.#rallyTarget()) {
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
    const ground = screenToGround(this.#camera, this.#canvas, px, py, this.#heights);
    if (!ground) return;
    const x = Math.floor(ground.x);
    const y = Math.floor(ground.z);
    const onSelf = x >= b.x && x < b.x + b.w && y >= b.y && y < b.y + b.h;
    this.#host.sendCommands([
      onSelf
        ? { kind: 'setRallyPoint', buildingId: b.id }
        : { kind: 'setRallyPoint', buildingId: b.id, x, y },
    ]);
    // Solid gold: an order taken, but nobody moves for it yet — the pulse
    // shape family the move orders wear, in the flag's own color.
    this.#pulse(px, py, 'solid #e5c469');
  }

  /** The wire half of a move order, aimed at a tile directly. */
  #sendMove(x: number, y: number, attack: boolean | 'half'): void {
    if (this.#selection.size === 0) return;
    this.#host.sendCommands([
      {
        kind: 'moveUnits',
        unitIds: [...this.#selection],
        x,
        y,
        ...(attack ? { attack } : {}),
      },
    ]);
  }

  /** A ring blooming at the tap/click plus a tick of haptics: order taken.
   * Attack-moves pulse a solid red ring, plain moves a dashed gold one, and
   * the half order a dotted red — three border styles, so the shape carries
   * the difference where color vision cannot. (The rally flag pulses too,
   * through #pulse directly: solid gold.) */
  #orderPulse(px: number, py: number, attack: boolean | 'half'): void {
    this.#pulse(
      px,
      py,
      attack === true ? 'solid #bf4342' : attack === 'half' ? 'dotted #bf4342' : 'dashed #e5c469',
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
    setSelectedBuilding(null);
  }

  /** Select every soldier you own — the phone answer to band-dragging an army. */
  selectArmy(): void {
    const sel = new Set<number>();
    for (const id of this.#sync.latestIds.keys()) {
      if (this.#sync.ownerOf(id) !== myPlayerId()) continue;
      const kind = this.#sync.kindOf(id);
      if (kind !== null && MILITARY_CODES.has(kind)) sel.add(id);
    }
    setSelectedBuilding(null);
    this.#setSel(sel);
  }
}
