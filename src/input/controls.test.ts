import {createComputed, createRoot} from 'solid-js';
import * as THREE from 'three';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import type {Enum} from '../shared/enum.ts';

// Controls pulls in the UI store, and the store reads the URL and the
// saved audio prefs the moment it is imported. Hoisted above the imports
// because that is when it happens: a beforeEach would be far too late.
vi.hoisted(() => {
  const g = globalThis as Record<string, unknown>;
  g.location = {search: ''};
  g.localStorage = {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
  };
});
import type {WorldMirror} from '../app/mirror';
import type {SimHost} from '../app/simHost';
import type {BuildingSnap} from '../protocol/messages';
import type {GhostPlacement} from '../render/ghost';
import type {HeightField} from '../render/heightField';
import type {SceneSync} from '../render/sceneSync';
import * as BuildingState from '../sim/buildingStateEnum.ts';
import * as CommandKind from '../sim/commandKindEnum.ts';
import * as BuildingTypeId from '../sim/defs/buildingTypeIdEnum.ts';
import * as GoodId from '../sim/defs/goodIdEnum.ts';
import {
  buildAim,
  orderMode,
  placing,
  resetMatchState,
  selectedBuilding,
  selection,
  selectionOwner,
  setBuildAim,
  setMyPlayerId,
  setNetMode,
  setPlacing,
  setReplayMode,
  setSelectedBuilding,
  setOrderMode,
  setSelection,
  setStock,
  setTechs,
  speed,
} from '../ui/store';
import {Controls} from './controls';
import {screenToGround, worldToScreen} from './picking';

type BuildingTypeId = Enum<typeof BuildingTypeId>;

const CANVAS_W = 800;
const CANVAS_H = 600;
const ME = 0;
const THEM = 1;

type Listener = (e: unknown) => void;

/**
 * Just enough element for Controls: listeners a test can fire, a style bag
 * it can write to, and the capture calls a drag makes. The band rectangle
 * is a div of exactly this shape, so one fake serves both.
 */
function fakeEl(): {
  style: {
    cssText: string;
    display: string;
    left: string;
    top: string;
    width: string;
    height: string;
  };
  clientWidth: number;
  clientHeight: number;
  addEventListener: (type: string, fn: Listener) => void;
  removeEventListener: () => void;
  setPointerCapture: () => void;
  releasePointerCapture: () => void;
  remove: () => void;
  fire: (type: string, e: unknown) => void;
} {
  const listeners = new Map<string, Listener[]>();
  return {
    style: {cssText: '', display: '', left: '', top: '', width: '', height: ''},
    clientWidth: CANVAS_W,
    clientHeight: CANVAS_H,
    addEventListener: (type, fn) =>
      void listeners.set(type, [...(listeners.get(type) ?? []), fn]),
    removeEventListener: () => {},
    setPointerCapture: () => {},
    releasePointerCapture: () => {},
    remove: () => {},
    fire: (type, e) => {
      for (const fn of listeners.get(type) ?? []) fn(e);
    },
  };
}

/**
 * A window that keeps its listeners. Controls binds the keyboard to the
 * window, so a test that wants to press a key has to be able to fire one
 * there; the no-op stub the pointer tests get would swallow it.
 */
function fakeWindow(): {
  addEventListener: (t: string, fn: Listener) => void;
  removeEventListener: () => void;
  fire: (t: string, e: unknown) => void;
} {
  const listeners = new Map<string, Listener[]>();
  return {
    addEventListener: (t, fn) =>
      void listeners.set(t, [...(listeners.get(t) ?? []), fn]),
    removeEventListener: () => {},
    fire: (t, e) => {
      for (const fn of listeners.get(t) ?? []) fn(e);
    },
  };
}

/**
 * A keydown in the fields Controls reads. Both spellings of the number,
 * because keyDigit prefers `code` — Shift+1 is `!` on a US layout.
 */
function keyDown(
  code: string,
  key: string,
  mods: {ctrlKey?: boolean; shiftKey?: boolean} = {},
): Record<string, unknown> {
  return {
    code,
    key,
    ctrlKey: mods.ctrlKey ?? false,
    shiftKey: mods.shiftKey ?? false,
    metaKey: false,
    altKey: false,
    isComposing: false,
    target: null,
    preventDefault: () => {},
  };
}

/** A left-button mouse pointer event, in the fields Controls reads. */
function ptr(x: number, y: number, shiftKey = false): Record<string, unknown> {
  return {
    button: 0,
    buttons: 1,
    pointerId: 1,
    pointerType: 'mouse',
    isPrimary: true,
    clientX: x,
    clientY: y,
    shiftKey,
    preventDefault: () => {},
  };
}

/** The same press made with a finger. */
function touchPtr(x: number, y: number): Record<string, unknown> {
  return {...ptr(x, y), pointerType: 'touch'};
}

/** The right button, which is the order button on the desktop. */
function rightPtr(x: number, y: number): Record<string, unknown> {
  return {...ptr(x, y), button: 2, buttons: 2};
}

/** A storehouse of yours, as the HUD's card would have it. */
function building(id: number): BuildingSnap {
  return {
    id,
    type: BuildingTypeId.storehouse,
    owner: ME,
    x: 10,
    y: 10,
    w: 3,
    h: 3,
    hp: 100,
    maxHp: 100,
    state: BuildingState.built,
    stock: {},
    inputs: {},
    inbound: {},
    reservedOut: {},
  };
}

/**
 * A world just big enough to band-select in: a camera looking straight
 * down on flat ground, and units whose screen positions the test reads
 * back through the same projection picking uses.
 */
function harness(opts: {pitched?: {x: number; z: number}} = {}) {
  const canvas = fakeEl();
  const camera = new THREE.OrthographicCamera(-20, 20, 15, -15, 0.1, 200);
  if (opts.pitched) {
    // The game's rig, in miniature: pitched 35° and yawed 30°, so the ground
    // under a roof is tiles away behind it and the two can differ.
    const pitch = (35 * Math.PI) / 180;
    const yaw = Math.PI / 6;
    const dir = new THREE.Vector3(
      Math.cos(pitch) * Math.sin(yaw),
      Math.sin(pitch),
      Math.cos(pitch) * Math.cos(yaw),
    );
    camera.position
      .set(opts.pitched.x, 0, opts.pitched.z)
      .addScaledVector(dir, 90);
    camera.lookAt(opts.pitched.x, 0, opts.pitched.z);
  } else {
    camera.position.set(0, 50, 0);
    camera.up.set(0, 0, -1);
    camera.lookAt(0, 0, 0);
  }
  camera.updateMatrixWorld(true);

  /** id → world (x, z), owner and kind; the ones picking asks about. */
  const units = new Map<
    number,
    {x: number; y: number; owner: number; kind: number}
  >();
  const sync = {
    latestIds: new Map<number, number>(),
    /**
     * Which publish these answers come from. The selection card's roster
     * is read off a new one and skipped between them (Controls'
     * #publishRoster), so a fake that never moved this would answer the
     * first read and gate out every one after it. Bumped by addUnit,
     * which is the only thing here that changes what a publish would say.
     */
    publishSeq: 0,
    positionOfInto: (
      id: number,
      _now: number,
      out: {x: number; y: number},
    ): boolean => {
      const u = units.get(id);
      if (!u) return false;
      out.x = u.x;
      out.y = u.y;
      return true;
    },
    ownerOf: (id: number): number | null => units.get(id)?.owner ?? null,
    kindOf: (id: number): number | null => units.get(id)?.kind ?? null,
    /** Nobody here has been in a fight: whole, or not published at all. */
    hpPctOf: (id: number): number | null => (units.has(id) ? 255 : null),
    /**
     * ...and everyone is the same size. Nothing in this file reads the
     * number — the card's arithmetic over it is roster.test.ts's — so one
     * standing figure keeps the fake to what these tests are about.
     */
    maxHpOf: (id: number): number | null => (units.has(id) ? 100 : null),
    isDead: (): boolean => false,
  };
  const addUnit = (
    id: number,
    x: number,
    z: number,
    owner = ME,
    kind = 0,
  ): void => {
    units.set(id, {x, y: z, owner, kind});
    sync.latestIds.set(id, sync.latestIds.size);
    sync.publishSeq++;
  };
  /** Where a unit's picking anchor lands on screen — the head, not the feet. */
  const screenOf = (id: number): {x: number; y: number} => {
    const u = units.get(id)!;
    return worldToScreen(
      camera,
      canvas as unknown as HTMLCanvasElement,
      u.x,
      0.4,
      u.y,
    );
  };

  const heights = {at: () => 0};
  const ghost = {show: () => {}, hide: () => {}, moveTo: () => {}};
  /** Every command the pointer sent, in order — what an order test reads. */
  const commands: Record<string, unknown>[] = [];
  /** Every gear the clock was told to run at — what a playback key test
   * reads, since the speed never reaches `commands`: it is a message to
   * the worker's timer, not an order in the sim. */
  const gears: number[] = [];
  const host = {
    sendCommands: (cs: Record<string, unknown>[]) => void commands.push(...cs),
    setSpeed: (s: number) => void gears.push(s),
  };
  const mirror = {
    // A 56-tile play square inside the 64 grid, the way a real map is
    // built: tiles 4..59 are walkable and the rest is margin. The chart's
    // orders are clamped into it.
    map: {size: 64, play: 56, buildingAt: new Int32Array(64 * 64).fill(-1)},
    buildings: new Map<number, BuildingSnap>(),
  };
  /** Where the camera was last sent — the second press of a number. */
  const rides: {x: number; z: number}[] = [];
  const rig = {
    touchPanEnabled: true,
    glideTo: (x: number, z: number) => void rides.push({x, z}),
  };

  // The keyboard lives on the window, so this has to be in place before
  // the constructor binds it. Stubbed here rather than in a hook because
  // the pointer tests want it too, and one window per harness keeps a
  // disposed Controls from answering the next test's keys.
  const win = fakeWindow();
  vi.stubGlobal('window', win);

  /** Stand a building on the map: the roster the pick reads, and the tiles
   * under it. `top` is how tall the renderer draws it, 0 for a flat plate. */
  const addBuilding = (b: BuildingSnap, top = 0): void => {
    mirror.buildings.set(b.id, b);
    for (let z = b.y; z < b.y + b.h; z++) {
      for (let x = b.x; x < b.x + b.w; x++)
        mirror.map.buildingAt[z * 64 + x] = b.id;
    }
    tops.set(b.id, top);
  };
  /** id -> drawn height, standing in for the renderer's measurements. */
  const tops = new Map<number, number>();

  // Stand-ins all the way down: these are the members the pointer path
  // actually reaches, and a real SceneSync would want a worker behind it.
  const controls = new Controls(
    canvas as unknown as HTMLCanvasElement,
    camera,
    sync as unknown as SceneSync,
    host as unknown as SimHost,
    mirror as unknown as WorldMirror,
    ghost as unknown as GhostPlacement,
    heights as unknown as HeightField,
    rig,
  );
  // The renderer's measurements, as BuildingSync would answer them: flat
  // ground, so a building's base is 0 and its ceiling is its own height.
  controls.setBuildingHeights({
    heightOf: id => tops.get(id) ?? 0,
    baseOf: () => 0,
    ceiling: () => Math.max(Number.NEGATIVE_INFINITY, ...tops.values()),
  });

  /** Drag a band from one screen point to another, the way a mouse does. */
  const band = (
    from: {x: number; y: number},
    to: {x: number; y: number},
    shiftKey = false,
  ): void => {
    canvas.fire('pointerdown', ptr(from.x, from.y, shiftKey));
    canvas.fire('pointermove', ptr(to.x, to.y, shiftKey));
    canvas.fire('pointerup', ptr(to.x, to.y, shiftKey));
  };

  /** Press a number, with Ctrl or Shift for the two spellings of a stamp. */
  const press = (
    digit: number,
    mods: {ctrlKey?: boolean; shiftKey?: boolean} = {},
  ): void => win.fire('keydown', keyDown(`Digit${digit}`, String(digit), mods));

  /** Type a letter — B and the chord letter after it, as the build card
   * is driven. Both spellings, the way keyLetter reads them. */
  const type = (letter: string): void =>
    win.fire(
      'keydown',
      keyDown(`Key${letter.toUpperCase()}`, letter.toLowerCase()),
    );

  /** Press a key that is not a letter or a number — the playback pair,
   * whose `code` and `key` disagree the moment Shift is involved. */
  const key = (code: string, k: string): void =>
    win.fire('keydown', keyDown(code, k));

  /** Where a world point lands on screen — the pixel a test clicks. */
  const at = (x: number, y: number, z: number): {x: number; y: number} =>
    worldToScreen(camera, canvas as unknown as HTMLCanvasElement, x, y, z);

  /** The tile the plain ground hit under a screen point falls on — what an
   * order used to aim at, and what the test contrasts the new aim with. */
  const groundTileAt = (p: {
    x: number;
    y: number;
  }): {x: number; y: number} | null => {
    const g = screenToGround(
      camera,
      canvas as unknown as HTMLCanvasElement,
      p.x,
      p.y,
      heights as unknown as HeightField,
    );
    return g && {x: Math.floor(g.x), y: Math.floor(g.z)};
  };

  /** Right-click a screen point, which is how the desktop gives an order. */
  const order = (p: {x: number; y: number}): void => {
    canvas.fire('pointerdown', rightPtr(p.x, p.y));
  };

  /** What the pointer is over, as the hover highlight reads it. */
  const hoverAt = (p: {x: number; y: number}): number => {
    canvas.fire('pointermove', ptr(p.x, p.y));
    controls.updateHoverIfDirty();
    return controls.hoverBuilding;
  };

  /** Select one unit the plain way: press and release on it. */
  const click = (p: {x: number; y: number}): void => {
    canvas.fire('pointerdown', ptr(p.x, p.y));
    canvas.fire('pointerup', ptr(p.x, p.y));
  };

  return {
    canvas,
    controls,
    addUnit,
    addBuilding,
    screenOf,
    band,
    at,
    order,
    hoverAt,
    click,
    groundTileAt,
    commands,
    gears,
    mirror,
    rides,
    press,
    type,
    key,
  };
}

/** The rectangle that covers these screen points, with room to spare. */
function around(
  points: {x: number; y: number}[],
): [{x: number; y: number}, {x: number; y: number}] {
  const pad = 20;
  const xs = points.map(p => p.x);
  const ys = points.map(p => p.y);
  return [
    {x: Math.min(...xs) - pad, y: Math.min(...ys) - pad},
    {x: Math.max(...xs) + pad, y: Math.max(...ys) + pad},
  ];
}

describe('band select', () => {
  let controls: ReturnType<typeof harness>['controls'] | null = null;

  beforeEach(() => {
    vi.stubGlobal('document', {
      createElement: () => fakeEl(),
      getElementById: () => null,
      body: {appendChild: () => {}},
      head: {appendChild: () => {}},
    });
    vi.stubGlobal('window', {
      addEventListener: () => {},
      removeEventListener: () => {},
    });
    setMyPlayerId(ME);
    setSelection(new Set<number>());
    setSelectedBuilding(null);
  });

  afterEach(() => {
    controls?.dispose();
    controls = null;
    setSelection(new Set<number>());
    setSelectedBuilding(null);
    vi.unstubAllGlobals();
  });

  it('picks up every one of yours the band closed over', () => {
    const h = harness();
    controls = h.controls;
    h.addUnit(1, -5, -3);
    h.addUnit(2, 5, 3);
    h.addUnit(3, 0, 0, THEM); // theirs: a band never takes what it cannot order
    h.addUnit(4, 18, 12); // yours, but outside the rectangle

    h.band(...around([h.screenOf(1), h.screenOf(2)]));

    expect([...selection()].sort((a, b) => a - b)).toEqual([1, 2]);
  });

  it('closes the building card the band selected over', () => {
    // The two selections are mutually exclusive, and SelectionPanel draws
    // the units' card only where no building is open. A band that left the
    // card standing selected the squad invisibly: rings on the map, and a
    // HUD still showing the keep — the lasso read as having done nothing.
    const h = harness();
    controls = h.controls;
    h.addUnit(1, -5, -3);
    setSelectedBuilding(building(7));

    h.band(...around([h.screenOf(1)]));

    expect([...selection()]).toEqual([1]);
    expect(selectedBuilding()).toBeNull();
  });

  it('closes it for a band that caught nobody too, the way a click on grass does', () => {
    const h = harness();
    controls = h.controls;
    h.addUnit(1, -5, -3);
    setSelectedBuilding(building(7));

    // A rectangle in the far corner, nowhere near the one unit on the map.
    h.band({x: 10, y: 10}, {x: 60, y: 60});

    expect(selection().size).toBe(0);
    expect(selectedBuilding()).toBeNull();
  });

  it('draws the band even where the platform refuses the capture', () => {
    // Full screen captures the mouse now (input/mouseCapture.ts), and Blink
    // throws InvalidStateError out of setPointerCapture for as long as a
    // pointer lock is engaged — whoever asks. That call sits one line above
    // the line that shows the band, so the throw took the lasso with it:
    // the rectangle went on being sized and selecting, invisibly, and the
    // drag read as having done nothing until the units lit up at the end.
    const made: ReturnType<typeof fakeEl>[] = [];
    vi.stubGlobal('document', {
      createElement: () => {
        const el = fakeEl();
        made.push(el);
        return el;
      },
      getElementById: () => null,
      body: {appendChild: () => {}},
      head: {appendChild: () => {}},
    });
    const h = harness();
    controls = h.controls;
    h.canvas.setPointerCapture = () => {
      throw new DOMException('locked', 'InvalidStateError');
    };
    h.addUnit(1, -5, -3);
    const [from, to] = around([h.screenOf(1)]);

    h.canvas.fire('pointerdown', ptr(from.x, from.y));
    h.canvas.fire('pointermove', ptr(to.x, to.y));

    const rect = made.find(el =>
      el.style.cssText.includes('border:1px solid'),
    )!;
    expect(rect.style.display).toBe('block');
    expect(rect.style.left).toBe(`${Math.min(from.x, to.x)}px`);
    expect(rect.style.top).toBe(`${Math.min(from.y, to.y)}px`);
    expect(rect.style.width).toBe(`${Math.abs(to.x - from.x)}px`);
    expect(rect.style.height).toBe(`${Math.abs(to.y - from.y)}px`);

    h.canvas.fire('pointerup', ptr(to.x, to.y));
    expect(rect.style.display).toBe('none');
    expect([...selection()]).toEqual([1]);
  });

  it('adds to the standing selection when Shift is held', () => {
    const h = harness();
    controls = h.controls;
    h.addUnit(1, -5, -3);
    h.addUnit(2, 5, 3);

    h.band(...around([h.screenOf(1)]));
    h.band(...around([h.screenOf(2)]), true);

    expect([...selection()].sort((a, b) => a - b)).toEqual([1, 2]);
  });
});

/**
 * The roster tiles on the selection card. They are pictures of the men
 * already in hand, and clicking one means what clicking the man himself
 * means — so these check the card's picks against the map's rule rather
 * than against a rule of their own.
 */
describe('picking a face off the selection card', () => {
  let controls: ReturnType<typeof harness>['controls'] | null = null;

  beforeEach(() => {
    vi.stubGlobal('document', {
      createElement: () => fakeEl(),
      getElementById: () => null,
      body: {appendChild: () => {}},
      head: {appendChild: () => {}},
    });
    vi.stubGlobal('window', {
      addEventListener: () => {},
      removeEventListener: () => {},
    });
    setMyPlayerId(ME);
    setSelection(new Set<number>());
    setSelectedBuilding(null);
  });

  afterEach(() => {
    controls?.dispose();
    controls = null;
    setSelection(new Set<number>());
    setSelectedBuilding(null);
    vi.unstubAllGlobals();
  });

  it('takes the one clicked out of the band', () => {
    const h = harness();
    controls = h.controls;
    h.addUnit(1, -5, -3);
    h.addUnit(2, 5, 3);
    h.addUnit(3, 0, 0);
    h.band(...around([h.screenOf(1), h.screenOf(2), h.screenOf(3)]));

    h.controls.pickUnit(2, false);

    expect([...selection()]).toEqual([2]);
  });

  it('drops him with shift, which is the only thing shift can mean here', () => {
    // Every tile is one of the selected, so the map's additive toggle has
    // exactly one branch left on this card: not him.
    const h = harness();
    controls = h.controls;
    h.addUnit(1, -5, -3);
    h.addUnit(2, 5, 3);
    h.band(...around([h.screenOf(1), h.screenOf(2)]));

    h.controls.pickUnit(2, true);

    expect([...selection()]).toEqual([1]);
  });

  it('adds a man back that shift had dropped', () => {
    // The toggle runs both ways, same as the map's: the card can put back
    // what it just took out, which is what makes a slipped click undoable.
    const h = harness();
    controls = h.controls;
    h.addUnit(1, -5, -3);
    h.addUnit(2, 5, 3);
    h.band(...around([h.screenOf(1), h.screenOf(2)]));

    h.controls.pickUnit(2, true);
    h.controls.pickUnit(2, true);

    expect([...selection()].sort((a, b) => a - b)).toEqual([1, 2]);
  });

  it('refuses a man the publish has buried', () => {
    // The click lands a frame after the paint, and a tile can outlive its
    // man by that frame. Picking him would put a dead id in the selection
    // for prune() to find, and the order in between would go to nobody.
    const h = harness();
    controls = h.controls;
    h.addUnit(1, -5, -3);
    h.addUnit(2, 5, 3);
    h.band(...around([h.screenOf(1), h.screenOf(2)]));

    h.controls.pickUnit(99, false);

    expect([...selection()].sort((a, b) => a - b)).toEqual([1, 2]);
  });

  it('does not let the next ground tap escalate an order this squad never gave', () => {
    // The finger's double-tap escalation re-aims at the tile the *first*
    // tap ordered. Tap the grass, pick a face off the card, tap the same
    // grass again inside the window: without dropping the remembered tap
    // that second one reads as a repeat, and a man who was not even
    // selected for the first order gets a full attack-move at its target.
    const h = harness();
    controls = h.controls;
    h.addUnit(1, -5, -3);
    h.addUnit(2, 5, 3);
    h.band(...around([h.screenOf(1), h.screenOf(2)]));
    const grass = {x: 700, y: 420};
    const tap = (): void => {
      h.canvas.fire('pointerdown', touchPtr(grass.x, grass.y));
      h.canvas.fire('pointerup', touchPtr(grass.x, grass.y));
    };

    tap();
    expect(h.commands.at(-1)).toMatchObject({
      kind: CommandKind.moveUnits,
      attack: 'half',
    });

    h.controls.pickUnit(2, false);
    tap();

    // The half order again — a fresh one for the man now in hand — rather
    // than the escalated attack-move the remembered tap would have made.
    expect(h.commands.at(-1)).toMatchObject({
      kind: CommandKind.moveUnits,
      attack: 'half',
    });
    expect(h.commands.at(-1)).not.toMatchObject({attack: true});
  });

  it('closes a building card that was somehow still standing', () => {
    const h = harness();
    controls = h.controls;
    h.addUnit(1, -5, -3);
    h.band(...around([h.screenOf(1)]));
    setSelectedBuilding(building(7));

    h.controls.pickUnit(1, false);

    expect([...selection()]).toEqual([1]);
    expect(selectedBuilding()).toBeNull();
  });
});

describe('control groups', () => {
  let controls: ReturnType<typeof harness>['controls'] | null = null;

  beforeEach(() => {
    vi.stubGlobal('document', {
      createElement: () => fakeEl(),
      getElementById: () => null,
      body: {appendChild: () => {}},
      head: {appendChild: () => {}},
    });
    setMyPlayerId(ME);
    setSelection(new Set<number>());
    setSelectedBuilding(null);
  });

  afterEach(() => {
    controls?.dispose();
    controls = null;
    setSelection(new Set<number>());
    setSelectedBuilding(null);
    vi.unstubAllGlobals();
  });

  it('stamps the open building card onto a number and calls it back', () => {
    // The whole point of the binding: the barracks you keep going back to
    // answers to a number, so hiring costs a keypress and not a trip.
    const h = harness();
    controls = h.controls;
    const b = building(7);
    h.mirror.buildings.set(b.id, b);
    setSelectedBuilding(b);

    h.press(1, {ctrlKey: true});
    setSelectedBuilding(null); // walk away — click grass, lasso a squad, anything
    h.press(1);

    expect(selectedBuilding()?.id).toBe(7);
    expect(selection().size).toBe(0);
  });

  it('answers with the mirror’s building, not the snapshot it was stamped from', () => {
    // Ids are what a group holds; the card has to be the live snapshot, or
    // a recall would reopen a barracks at the hp it had three minutes ago.
    const h = harness();
    controls = h.controls;
    const stamped = building(7);
    h.mirror.buildings.set(7, stamped);
    setSelectedBuilding(stamped);
    h.press(1, {ctrlKey: true});

    setSelectedBuilding(null);
    h.mirror.buildings.set(7, {...stamped, hp: 40});
    h.press(1);

    expect(selectedBuilding()?.hp).toBe(40);
  });

  it('rides the camera out to the building on the second press', () => {
    const h = harness();
    controls = h.controls;
    const b = building(7); // 3x3 at (10, 10)
    h.mirror.buildings.set(b.id, b);
    setSelectedBuilding(b);
    h.press(1, {ctrlKey: true});

    h.press(1);
    expect(h.rides).toEqual([]); // the first press is the selection's
    h.press(1);
    expect(h.rides).toEqual([{x: 11.5, z: 11.5}]); // the second is the camera's
  });

  it('keeps a squad and a building apart on the same id', () => {
    // Units and buildings draw from one id pool, so #12 can be both a
    // soldier and a barracks — and a number must answer with the one it
    // was stamped from.
    const h = harness();
    controls = h.controls;
    h.addUnit(12, -5, -3);
    const b = building(12);
    h.mirror.buildings.set(12, b);

    h.band(...around([h.screenOf(12)]));
    h.press(1, {ctrlKey: true}); // 1 is the soldier
    setSelectedBuilding(b);
    h.press(2, {ctrlKey: true}); // 2 is the building of the same id

    h.press(1);
    expect([...selection()]).toEqual([12]);
    expect(selectedBuilding()).toBeNull();

    h.press(2);
    expect(selectedBuilding()?.id).toBe(12);
    expect(selection().size).toBe(0);
  });

  it('will not let Shift trade a squad for a building', () => {
    // Shift adds; it has never destroyed a group, and a building — which
    // cannot be added to, being the one building — is no reason to start.
    const h = harness();
    controls = h.controls;
    h.addUnit(1, -5, -3);
    h.band(...around([h.screenOf(1)]));
    h.press(3, {ctrlKey: true});

    const b = building(7);
    h.mirror.buildings.set(b.id, b);
    setSelectedBuilding(b);
    h.press(3, {shiftKey: true}); // refused: 3 is the squad's

    setSelectedBuilding(null);
    h.press(3);
    expect([...selection()]).toEqual([1]);
    expect(selectedBuilding()).toBeNull();
  });

  it('lets Shift take a number nobody is using', () => {
    const h = harness();
    controls = h.controls;
    const b = building(7);
    h.mirror.buildings.set(b.id, b);
    setSelectedBuilding(b);

    h.press(4, {shiftKey: true});
    setSelectedBuilding(null);
    h.press(4);

    expect(selectedBuilding()?.id).toBe(7);
  });

  it('lets Ctrl overwrite a squad’s number with a building', () => {
    // Ctrl is how a group is overwritten, here as anywhere.
    const h = harness();
    controls = h.controls;
    h.addUnit(1, -5, -3);
    h.band(...around([h.screenOf(1)]));
    h.press(5, {ctrlKey: true});

    const b = building(7);
    h.mirror.buildings.set(b.id, b);
    setSelectedBuilding(b);
    h.press(5, {ctrlKey: true});

    setSelectedBuilding(null);
    h.press(5);
    expect(selectedBuilding()?.id).toBe(7);
    expect(selection().size).toBe(0);
  });

  it('drops a razed building’s group and frees the number', () => {
    // prune() weeds the dead out of every group each frame, and a razed
    // building is that same problem one entry wide. The number falls free
    // rather than being left to refuse forever.
    const h = harness();
    controls = h.controls;
    const b = building(7);
    h.mirror.buildings.set(b.id, b);
    setSelectedBuilding(b);
    h.press(6, {ctrlKey: true});

    h.mirror.buildings.delete(7); // razed, or sold
    setSelectedBuilding(null);
    h.controls.prune();
    h.press(6);
    expect(selectedBuilding()).toBeNull();

    // ...and the number takes a new tenant.
    const other = building(8);
    h.mirror.buildings.set(8, other);
    setSelectedBuilding(other);
    h.press(6, {shiftKey: true}); // free, so even Shift will take it
    setSelectedBuilding(null);
    h.press(6);
    expect(selectedBuilding()?.id).toBe(8);
  });

  it('opens the card on the second press too, not just rides out to it', () => {
    // The camera is what the second press adds, not what it does instead.
    // Let the card go and press the number twice and you want the card
    // back and the view on it — a ride to a barracks whose card never
    // opened is the one thing the stamp was not for.
    const h = harness();
    controls = h.controls;
    const b = building(7);
    h.mirror.buildings.set(b.id, b);
    setSelectedBuilding(b);
    h.press(1, {ctrlKey: true});

    h.press(1);
    h.controls.deselectAll(); // Esc, inside the beat
    h.press(1);

    expect(selectedBuilding()?.id).toBe(7);
    expect(h.rides).toEqual([{x: 11.5, z: 11.5}]);
  });

  it('re-selects a squad on the second press too', () => {
    // Same rule on the units half of the binding, for the same reason.
    const h = harness();
    controls = h.controls;
    h.addUnit(1, -5, -3);
    h.band(...around([h.screenOf(1)]));
    h.press(2, {ctrlKey: true});

    h.press(2);
    h.controls.deselectAll();
    h.press(2);

    expect([...selection()]).toEqual([1]);
    expect(h.rides.length).toBe(1);
  });

  it('does not hand the next press to the camera after a refusal', () => {
    // A refusal is not a first press. When the razed building's group is
    // dropped here rather than by prune(), remembering the press would
    // make the next number press — someone's first real recall — fly the
    // camera instead of opening the card it was pressed for.
    const h = harness();
    controls = h.controls;
    const gone = building(7);
    h.mirror.buildings.set(7, gone);
    setSelectedBuilding(gone);
    h.press(4, {ctrlKey: true});

    h.mirror.buildings.delete(7);
    setSelectedBuilding(null);
    h.press(4); // refused: razed, and the group goes with it

    const fresh = building(8);
    h.mirror.buildings.set(8, fresh);
    setSelectedBuilding(fresh);
    h.press(4, {ctrlKey: true});
    setSelectedBuilding(null);
    h.press(4);

    expect(selectedBuilding()?.id).toBe(8);
    expect(h.rides).toEqual([]); // the first recall of a number never rides
  });

  it('refuses a number that holds nothing, leaving the card standing', () => {
    const h = harness();
    controls = h.controls;
    const b = building(7);
    h.mirror.buildings.set(b.id, b);
    setSelectedBuilding(b);

    h.press(9);

    expect(selectedBuilding()?.id).toBe(7);
  });
});

describe('right-click orders', () => {
  let controls: ReturnType<typeof harness>['controls'] | null = null;

  beforeEach(() => {
    vi.stubGlobal('document', {
      createElement: () => fakeEl(),
      getElementById: () => null,
      body: {appendChild: () => {}},
      head: {appendChild: () => {}},
    });
    vi.stubGlobal('window', {
      addEventListener: () => {},
      removeEventListener: () => {},
    });
    setMyPlayerId(ME);
    setSelection(new Set<number>());
    setSelectedBuilding(null);
  });

  afterEach(() => {
    controls?.dispose();
    controls = null;
    setSelection(new Set<number>());
    setSelectedBuilding(null);
    vi.unstubAllGlobals();
  });

  /** The keep, its center, and a squad standing clear of it. */
  function keepAndSquad(): ReturnType<typeof harness> {
    const keep = {...building(7), owner: THEM};
    const cx = keep.x + keep.w / 2;
    const h = harness({pitched: {x: cx, z: cx}});
    h.addBuilding(keep, TOP);
    h.addUnit(1, keep.x - 4, keep.y - 4);
    h.click(h.screenOf(1));
    expect([...selection()]).toEqual([1]);
    return h;
  }

  /** How tall the keep is drawn — a castle's 3x3 model, near enough. */
  const TOP = 3.2;
  /** The keep's middle tile, which is what an order aimed at it means. */
  const KEEP_TILE = {x: 11, y: 11};

  it('aims at the keep the pointer is lit on, not the ground behind it', () => {
    const h = keepAndSquad();
    controls = h.controls;
    const roof = h.at(11.5, TOP, 11.5);

    // The highlight promises the keep...
    expect(h.hoverAt(roof)).toBe(7);
    // ...and the order keeps that promise. Before this, the click read the
    // ground under those pixels — tiles behind the wall — and the squad
    // marched around the keep onto the open ground on its far side.
    h.order(roof);

    expect(h.commands.at(-1)).toMatchObject({
      kind: CommandKind.moveUnits,
      ...KEEP_TILE,
    });
  });

  it('reads the roof pixel as the keep even though the ground there is not', () => {
    // Guards the test above: if that pixel's ground hit happened to land on
    // the footprint anyway, the order would aim right without the fix.
    const h = keepAndSquad();
    controls = h.controls;
    const roof = h.at(11.5, TOP, 11.5);

    const ground = h.groundTileAt(roof)!;
    const onFootprint =
      ground.x >= 10 && ground.x < 13 && ground.y >= 10 && ground.y < 13;
    expect(onFootprint).toBe(false);
  });

  it('a finger dragging the map hovers nothing, and asks nothing of the scan', () => {
    const h = keepAndSquad();
    controls = h.controls;
    const roof = h.at(11.5, TOP, 11.5);

    // Standing on the keep with a finger down: still the keep.
    expect(h.hoverAt(roof)).toBe(7);
    h.canvas.fire('pointerdown', touchPtr(roof.x, roof.y));

    // The finger travels past the slop — the camera has the drag now, and
    // there is nothing under a fingertip to light up. The pan marks the
    // hover dirty every frame it moves the world, and the scan that would
    // answer walks every unit and rays the buildings; this is the frame
    // that skips it.
    h.canvas.fire('pointermove', touchPtr(roof.x + 60, roof.y + 60));
    controls.updateHoverIfDirty();
    expect(controls.hoverBuilding).toBe(-1);

    // Even back over the keep mid-swipe: a finger on the glass is holding
    // ground still, not pointing at what slid beneath it.
    h.canvas.fire('pointermove', touchPtr(roof.x, roof.y));
    controls.updateHoverIfDirty();
    expect(controls.hoverBuilding).toBe(-1);

    // Off the glass, and nothing is lit: the release marks no hover dirty,
    // and a touchscreen with no finger on it has no cursor for a highlight
    // to belong to.
    h.canvas.fire('pointerup', touchPtr(roof.x, roof.y));
    controls.updateHoverIfDirty();
    expect(controls.hoverBuilding).toBe(-1);

    // A pointer that actually moves picks it back up.
    expect(h.hoverAt(roof)).toBe(7);
  });

  it('leaves bare ground exactly where it was', () => {
    const h = keepAndSquad();
    controls = h.controls;
    // Well clear of the keep and of anything it covers.
    const grass = h.at(11.5, 0, 17.5);

    expect(h.hoverAt(grass)).toBe(-1);
    h.order(grass);

    expect(h.commands.at(-1)).toMatchObject({
      kind: CommandKind.moveUnits,
      x: 11,
      y: 17,
    });
  });
});

describe('build chord', () => {
  let controls: ReturnType<typeof harness>['controls'] | null = null;

  beforeEach(() => {
    vi.stubGlobal('document', {
      createElement: () => fakeEl(),
      getElementById: () => null,
      body: {appendChild: () => {}},
      head: {appendChild: () => {}},
    });
    setMyPlayerId(ME);
    setStock({});
    setTechs({
      researched: [],
      festivalTicksLeft: 0,
      pavingUnlocked: false,
      hasAbbey: false,
    });
    setPlacing(null);
    setBuildAim(null);
  });

  afterEach(() => {
    controls?.dispose();
    controls = null;
    setStock({});
    setTechs({
      researched: [],
      festivalTicksLeft: 0,
      pavingUnlocked: false,
      hasAbbey: false,
    });
    setPlacing(null);
    setBuildAim(null);
    vi.unstubAllGlobals();
  });

  it('arms the building the letter names, and aims the ribbon at it', () => {
    const h = harness();
    controls = h.controls;
    setStock({[GoodId.wood]: 20, [GoodId.stone]: 20});

    h.type('B');
    h.type('M');

    expect(placing()).toBe(BuildingTypeId.mill);
    expect(buildAim()).toBe(BuildingTypeId.mill);
  });

  it('aims the ribbon at a building the stores cannot pay for', () => {
    // The refusal is the case that needs the tab most: the toast says the
    // stores are short, and the button that says short of what is on a tab
    // the player is not looking at. Nothing is armed — the gate still
    // holds — but the ribbon has been pointed at the answer.
    const h = harness();
    controls = h.controls;
    setStock({[GoodId.wood]: 1});

    h.type('B');
    h.type('M');

    expect(placing()).toBeNull();
    expect(buildAim()).toBe(BuildingTypeId.mill);
  });

  it('aims the ribbon at a building that is not researched yet', () => {
    const h = harness();
    controls = h.controls;
    setStock({[GoodId.wood]: 99, [GoodId.stone]: 99});

    h.type('B');
    h.type('I'); // the Iron Mine, behind ironworking

    expect(placing()).toBeNull();
    expect(buildAim()).toBe(BuildingTypeId.ironMine);
  });

  it('aims again when the same refused building is chorded twice', () => {
    // The signal is written with equals:false for exactly this: a player
    // who read the cost, tabbed away and typed the chord again gets the
    // tab back. Plain signal equality would swallow the second write.
    const h = harness();
    controls = h.controls;
    setStock({});
    const aims: (BuildingTypeId | null)[] = [];

    const stop = createRoot(dispose => {
      createComputed(() => void aims.push(buildAim()));
      return dispose;
    });
    h.type('B');
    h.type('M');
    h.type('B');
    h.type('M');
    stop();

    expect(aims).toEqual([null, BuildingTypeId.mill, BuildingTypeId.mill]);
  });

  it('leaves a stray letter alone', () => {
    const h = harness();
    controls = h.controls;
    setStock({[GoodId.wood]: 99, [GoodId.stone]: 99});

    h.type('B');
    h.type('Z');

    expect(placing()).toBeNull();
    expect(buildAim()).toBeNull();
  });
});

describe('playback keys', () => {
  let controls: ReturnType<typeof harness>['controls'] | null = null;

  beforeEach(() => {
    vi.stubGlobal('document', {
      createElement: () => fakeEl(),
      getElementById: () => null,
      body: {appendChild: () => {}},
      head: {appendChild: () => {}},
    });
    setMyPlayerId(ME);
    resetMatchState();
  });

  afterEach(() => {
    controls?.dispose();
    controls = null;
    resetMatchState();
    vi.unstubAllGlobals();
  });

  it('holds the village on −, and lets it go again on +', () => {
    // The pause is the bottom rung, so the pair that walks the ladder is
    // the pair that pauses — no third key, and none advertised.
    const h = harness();
    controls = h.controls;

    h.key('Minus', '-');
    expect(h.gears).toEqual([0]);
    expect(speed()).toBe(0);

    h.key('Equal', '+');
    expect(h.gears).toEqual([0, 1]);
    expect(speed()).toBe(1);
  });

  it('leaves P alone, and every other stray letter with it', () => {
    // P was a pause key here once. Nothing should have taken its place:
    // a letter that quietly moves the clock is worse than no letter.
    const h = harness();
    controls = h.controls;

    h.type('P');

    expect(h.gears).toEqual([]);
    expect(speed()).toBe(1);
  });

  it('steps a gear on + and -, and stops at the ends', () => {
    const h = harness();
    controls = h.controls;

    h.key('Equal', '+');
    expect(speed()).toBe(3);
    // Nowhere further up in a live match, and + must never be the key
    // that pauses.
    h.key('Equal', '+');
    expect(speed()).toBe(3);

    h.key('Minus', '-');
    h.key('Minus', '-');
    expect(speed()).toBe(0);
    h.key('Minus', '-');
    expect(speed()).toBe(0);
  });

  it('takes the shifted + and the bare = for the same key', () => {
    const h = harness();
    controls = h.controls;

    // A US layout shifts Equal into '+'; some layouts do not shift at all.
    h.key('Equal', '=');

    expect(speed()).toBe(3);
  });

  it('climbs into the replay gear, which a live match has no rung for', () => {
    const h = harness();
    controls = h.controls;
    setReplayMode(true);

    h.key('Equal', '+');
    h.key('Equal', '+');

    expect(speed()).toBe(8);
  });

  it('says nothing to a networked clock', () => {
    // One shared clock, so there is no pause and no fast forward to press
    // — which is why the HUD hides those buttons in a match too.
    const h = harness();
    controls = h.controls;
    setNetMode(true);

    h.key('Equal', '+');
    h.key('Minus', '-');

    expect(h.gears).toEqual([]);
    expect(speed()).toBe(1);
  });
});

describe('watching a replay', () => {
  let controls: ReturnType<typeof harness>['controls'] | null = null;

  beforeEach(() => {
    vi.stubGlobal('document', {
      createElement: () => fakeEl(),
      getElementById: () => null,
      body: {appendChild: () => {}},
      head: {appendChild: () => {}},
    });
    resetMatchState();
    setMyPlayerId(ME);
    setReplayMode(true);
  });

  afterEach(() => {
    controls?.dispose();
    controls = null;
    resetMatchState();
    vi.unstubAllGlobals();
  });

  /** A building of the given seat's, stood where nothing else is. */
  function theirs(id: number, owner: number): BuildingSnap {
    return {...building(id), owner, x: 20, y: 20};
  }

  /** The pixel over a building's middle tile, seen from straight above. */
  function centerOf(
    h: ReturnType<typeof harness>,
    b: BuildingSnap,
  ): {x: number; y: number} {
    return h.at(b.x + b.w / 2, 0, b.y + b.h / 2);
  }

  it('rings a rival’s people, where a live match never lets a click land', () => {
    const h = harness();
    controls = h.controls;
    h.addUnit(3, 0, 0, THEM);

    h.click(h.screenOf(3));

    expect([...selection()]).toEqual([3]);
    // And the card is told whose they are: one ring looks like another.
    expect(selectionOwner()).toBe(THEM);
  });

  it('leaves the same people alone once it is a live match again', () => {
    // The same click in a live match, to show what the replay flag is
    // doing here rather than some other change of behavior.
    const h = harness();
    controls = h.controls;
    setReplayMode(false);
    h.addUnit(3, 0, 0, THEM);

    h.click(h.screenOf(3));

    expect([...selection()]).toEqual([]);
    expect(selectionOwner()).toBeNull();
  });

  it('opens a rival’s building card', () => {
    const h = harness();
    controls = h.controls;
    const mill = theirs(9, THEM);
    h.addBuilding(mill);

    h.click(centerOf(h, mill));

    expect(selectedBuilding()?.id).toBe(9);
  });

  it('will not open a card for a hut on ground the seat never scouted', () => {
    // The renderer does not draw a building on unexplored ground, so a
    // click that opened its card would read the stock of a hut that is
    // not on screen — the card telling the player what the picture is
    // deliberately withholding.
    const h = harness();
    controls = h.controls;
    const mill = theirs(9, THEM);
    h.addBuilding(mill);
    h.controls.setFog({
      visibleAt: () => false,
      exploredAt: () => false,
      litAt: () => 0,
    });

    h.click(centerOf(h, mill));

    expect(selectedBuilding()).toBeNull();

    // F lifts the fog in a replay, and then the same click lands.
    h.controls.setFog({
      visibleAt: () => true,
      exploredAt: () => true,
      litAt: () => 1,
    });
    h.click(centerOf(h, mill));

    expect(selectedBuilding()?.id).toBe(9);
  });

  it('brings back one banner from a band drawn over a battle', () => {
    // Weight of numbers decides: the rectangle was aimed at whoever fills
    // it. A selection flying two banners is one the card cannot name and
    // the count at the top of it is a fact about nothing.
    const h = harness();
    controls = h.controls;
    h.addUnit(1, -5, -3);
    h.addUnit(2, -4, -2);
    h.addUnit(3, 0, 0, THEM);
    h.addUnit(4, 1, 1, THEM);
    h.addUnit(5, 2, 2, THEM);

    h.band(...around([h.screenOf(1), h.screenOf(5)]));

    expect([...selection()].sort((a, b) => a - b)).toEqual([3, 4, 5]);
    expect(selectionOwner()).toBe(THEM);
  });

  it('grows the squad it already holds when the band is shift-drawn', () => {
    // Otherwise a second corner of the same army swaps sides underneath
    // the hand, because the rectangle happened to catch more of the enemy.
    const h = harness();
    controls = h.controls;
    h.addUnit(1, -5, -3);
    h.addUnit(2, -4, -2);
    h.addUnit(3, 0, 0, THEM);
    h.addUnit(4, 1, 1, THEM);
    h.addUnit(5, 2, 2, THEM);
    h.click(h.screenOf(1));

    h.band(...around([h.screenOf(1), h.screenOf(5)]), true);

    expect([...selection()].sort((a, b) => a - b)).toEqual([1, 2]);
    expect(selectionOwner()).toBe(ME);
  });

  it('widens a double-click inside one banner', () => {
    // "And the rest of them" said over a melee means this side's
    // swordsmen, not both sides'.
    const KNIGHT = 2;
    const h = harness();
    controls = h.controls;
    h.addUnit(1, -5, -3, THEM, KNIGHT);
    h.addUnit(2, -4, -2, THEM, KNIGHT);
    h.addUnit(3, 0, 0, ME, KNIGHT);

    h.click(h.screenOf(1));
    h.click(h.screenOf(1));

    expect([...selection()].sort((a, b) => a - b)).toEqual([1, 2]);
  });

  it('names no seat for a squad shift-clicked out of both sides', () => {
    // Picked one at a time, each click deliberate — so the mixed set
    // stands. What cannot stand is a name over it: the card would be
    // calling half of them somebody they are not.
    const h = harness();
    controls = h.controls;
    h.addUnit(1, -5, -3);
    h.addUnit(3, 0, 0, THEM);

    h.click(h.screenOf(1));
    expect(selectionOwner()).toBe(ME);
    h.canvas.fire('pointerdown', ptr(h.screenOf(3).x, h.screenOf(3).y, true));
    h.canvas.fire('pointerup', ptr(h.screenOf(3).x, h.screenOf(3).y, true));

    expect([...selection()].sort((a, b) => a - b)).toEqual([1, 3]);
    expect(selectionOwner()).toBeNull();
  });

  it('does not let click order decide what a shift-drag grows', () => {
    // A mixed hand has no seat to keep, so the drag falls back to the
    // count over the rectangle — the same rule a plain drag follows, and
    // one the player can see. Reading the seat off whichever id the
    // selection yielded first decided the drag by the order they had
    // clicked in two gestures ago.
    const shiftClick = (
      h: ReturnType<typeof harness>,
      p: {x: number; y: number},
    ): void => {
      h.canvas.fire('pointerdown', ptr(p.x, p.y, true));
      h.canvas.fire('pointerup', ptr(p.x, p.y, true));
    };
    /** The same board every time; `order` is which side is clicked first. */
    const drag = (order: readonly number[]): number[] => {
      const h = harness();
      controls?.dispose();
      controls = h.controls;
      h.addUnit(1, -8, -8);
      h.addUnit(2, 0, 0);
      h.addUnit(3, 1, 1, THEM);
      h.addUnit(4, 2, 2, THEM);
      h.addUnit(5, 3, 3, THEM);
      for (const id of order) shiftClick(h, h.screenOf(id));
      expect(selectionOwner()).toBeNull();
      h.band(...around([h.screenOf(2), h.screenOf(5)]), true);
      return [...selection()].sort((a, b) => a - b);
    };

    // Three of theirs against one of yours inside the rectangle, so the
    // band takes theirs — whichever of the two was shift-clicked first.
    expect(drag([1, 3])).toEqual([1, 3, 4, 5]);
    expect(drag([3, 1])).toEqual([1, 3, 4, 5]);
  });

  it('gives no order, however the ring got there', () => {
    // The worker has always dropped a replay's orders at the door. The
    // click must not claim otherwise on the way there — a pulse under a
    // rival's knights says the viewer is in charge of them.
    const h = harness();
    controls = h.controls;
    h.addUnit(3, 0, 0, THEM);
    h.click(h.screenOf(3));
    expect([...selection()]).toEqual([3]);

    h.order(h.at(6, 0, 6));

    expect(h.commands).toEqual([]);
  });
});

describe('minimap orders', () => {
  let controls: ReturnType<typeof harness>['controls'] | null = null;

  beforeEach(() => {
    vi.stubGlobal('document', {
      createElement: () => fakeEl(),
      getElementById: () => null,
      body: {appendChild: () => {}},
      head: {appendChild: () => {}},
    });
    setMyPlayerId(ME);
    setSelection(new Set<number>());
    setSelectedBuilding(null);
    setOrderMode(null);
  });

  afterEach(() => {
    controls?.dispose();
    controls = null;
    setSelection(new Set<number>());
    setSelectedBuilding(null);
    setOrderMode(null);
    setReplayMode(false);
    vi.unstubAllGlobals();
  });

  /** A squad of one, selected — every order below needs someone to give. */
  function squad(): ReturnType<typeof harness> {
    const h = harness();
    h.addUnit(1, 0, 0);
    h.click(h.screenOf(1));
    expect([...selection()]).toEqual([1]);
    return h;
  }

  /** A barracks of yours, open on the HUD's card — what a rally flag needs. */
  function barracks(id = 7): BuildingSnap {
    return {...building(id), type: BuildingTypeId.barracks};
  }

  /** The chart click, in the shape the Minimap makes it: a world point and
   * the client pixel the pulse blooms at. */
  const CLICK = {px: 120, py: 640};
  const chart = (
    c: ReturnType<typeof harness>['controls'],
    x: number,
    z: number,
    secondary = false,
  ): void => c.orderAtMapPoint(x, z, secondary, CLICK.px, CLICK.py);

  it('sends a plain move where the right button points', () => {
    const h = squad();
    controls = h.controls;

    chart(h.controls, 30.7, 42.2, true);

    expect(h.commands.at(-1)).toMatchObject({
      kind: CommandKind.moveUnits,
      unitIds: [1],
      x: 30,
      y: 42,
    });
    // A plain move, not the half order a finger's tap on the map gives.
    expect(h.commands.at(-1)).not.toHaveProperty('attack');
  });

  it('spends an armed A on the chart as an attack-move', () => {
    const h = squad();
    controls = h.controls;
    h.type('A');
    expect(h.controls.orderArmed()).toBe(true);

    chart(h.controls, 30.7, 42.2);

    expect(h.commands.at(-1)).toMatchObject({
      kind: CommandKind.moveUnits,
      x: 30,
      y: 42,
      attack: true,
    });
    // One-shot, the same as the map's armed click.
    expect(orderMode()).toBeNull();
    expect(h.controls.orderArmed()).toBe(false);
  });

  it('spends an armed M on the chart as a plain move', () => {
    const h = squad();
    controls = h.controls;
    h.type('M');

    chart(h.controls, 12.5, 51.5);

    expect(h.commands.at(-1)).toMatchObject({
      kind: CommandKind.moveUnits,
      x: 12,
      y: 51,
    });
    expect(h.commands.at(-1)).not.toHaveProperty('attack');
    expect(orderMode()).toBeNull();
  });

  it('leaves the camera nothing to do while an order is armed', () => {
    // The chart's own answer to a plain press is to steer the camera, and
    // it asks this first so the two never both happen on one click.
    const h = squad();
    controls = h.controls;

    expect(h.controls.orderArmed()).toBe(false);
    h.type('A');
    expect(h.controls.orderArmed()).toBe(true);
  });

  it('cancels an armed order with the right button, ordering nothing', () => {
    const h = squad();
    controls = h.controls;
    h.type('A');

    chart(h.controls, 30.5, 42.5, true);

    expect(orderMode()).toBeNull();
    expect(h.commands).toEqual([]);
  });

  it('clamps an order at the chart edge onto the last playable tile', () => {
    // The Minimap clamps its own reading to the play square, whose far
    // edge is one past the last tile it draws: an order aimed there would
    // land in the margin nobody can walk on.
    const h = squad();
    controls = h.controls;

    chart(h.controls, 60, 60, true); // playMax on both axes

    expect(h.commands.at(-1)).toMatchObject({
      kind: CommandKind.moveUnits,
      x: 59,
      y: 59,
    });
  });

  it('gives no order with nobody selected', () => {
    const h = harness();
    controls = h.controls;

    chart(h.controls, 30.5, 42.5, true);

    expect(h.commands).toEqual([]);
  });

  it('gives no order in a replay, however the ring got there', () => {
    const h = squad();
    controls = h.controls;
    setReplayMode(true);

    chart(h.controls, 30.5, 42.5, true);

    expect(h.commands).toEqual([]);
  });

  it('plants the open barracks rally flag where the chart points', () => {
    const h = harness();
    controls = h.controls;
    const b = barracks();
    h.addBuilding(b);
    setSelectedBuilding(b);

    chart(h.controls, 30.5, 42.5, true);

    expect(h.commands.at(-1)).toEqual({
      kind: CommandKind.setRallyPoint,
      buildingId: 7,
      x: 30,
      y: 42,
    });
  });

  it('takes the flag down again from the barracks own tiles', () => {
    const h = harness();
    controls = h.controls;
    const b = barracks();
    h.addBuilding(b);
    setSelectedBuilding(b);

    chart(h.controls, b.x + 1.5, b.y + 1.5, true);

    // No point at all is the "back to normal" command — the same thing
    // clicking the building itself means on the map.
    expect(h.commands.at(-1)).toEqual({
      kind: CommandKind.setRallyPoint,
      buildingId: 7,
    });
  });

  it('sends the squad rather than the flag when both could take the click', () => {
    // The map's rule: a standing selection owns the right-click, and the
    // flag is what is left when nothing is selected.
    const h = squad();
    controls = h.controls;
    const b = barracks();
    h.addBuilding(b);
    setSelectedBuilding(b);
    setSelection(new Set([1]));

    chart(h.controls, 30.5, 42.5, true);

    expect(h.commands.at(-1)).toMatchObject({kind: CommandKind.moveUnits});
  });
});
