import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { createComputed, createRoot } from 'solid-js';

// Controls pulls in the UI store, and the store reads the URL and the
// saved audio prefs the moment it is imported. Hoisted above the imports
// because that is when it happens: a beforeEach would be far too late.
vi.hoisted(() => {
  const g = globalThis as Record<string, unknown>;
  g.location = { search: '' };
  g.localStorage = {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
  };
});
import { Controls } from './controls';
import { screenToGround, worldToScreen } from './picking';
import type { BuildingSnap } from '../protocol/messages';
import type { SceneSync } from '../render/sceneSync';
import type { GhostPlacement } from '../render/ghost';
import type { HeightField } from '../render/heightField';
import type { WorldMirror } from '../app/mirror';
import type { SimHost } from '../app/simHost';
import {
  buildAim,
  placing,
  selectedBuilding,
  selection,
  setBuildAim,
  setMyPlayerId,
  setPlacing,
  setSelectedBuilding,
  setSelection,
  setStock,
  setTechs,
} from '../ui/store';
import { GoodId } from '../sim/defs/goods';

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
  style: { cssText: string; display: string; left: string; top: string; width: string; height: string };
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
    style: { cssText: '', display: '', left: '', top: '', width: '', height: '' },
    clientWidth: CANVAS_W,
    clientHeight: CANVAS_H,
    addEventListener: (type, fn) => void listeners.set(type, [...(listeners.get(type) ?? []), fn]),
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
function fakeWindow(): { addEventListener: (t: string, fn: Listener) => void; removeEventListener: () => void; fire: (t: string, e: unknown) => void } {
  const listeners = new Map<string, Listener[]>();
  return {
    addEventListener: (t, fn) => void listeners.set(t, [...(listeners.get(t) ?? []), fn]),
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
  mods: { ctrlKey?: boolean; shiftKey?: boolean } = {},
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
  return { ...ptr(x, y), pointerType: 'touch' };
}

/** The right button, which is the order button on the desktop. */
function rightPtr(x: number, y: number): Record<string, unknown> {
  return { ...ptr(x, y), button: 2, buttons: 2 };
}

/** A storehouse of yours, as the HUD's card would have it. */
function building(id: number): BuildingSnap {
  return {
    id,
    type: 'storehouse',
    owner: ME,
    x: 10,
    y: 10,
    w: 3,
    h: 3,
    hp: 100,
    maxHp: 100,
    state: 'built',
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
function harness(opts: { pitched?: { x: number; z: number } } = {}) {
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
    camera.position.set(opts.pitched.x, 0, opts.pitched.z).addScaledVector(dir, 90);
    camera.lookAt(opts.pitched.x, 0, opts.pitched.z);
  } else {
    camera.position.set(0, 50, 0);
    camera.up.set(0, 0, -1);
    camera.lookAt(0, 0, 0);
  }
  camera.updateMatrixWorld(true);

  /** id → world (x, z) and owner; the ones picking asks about. */
  const units = new Map<number, { x: number; y: number; owner: number }>();
  const sync = {
    latestIds: new Map<number, number>(),
    positionOfInto: (id: number, _now: number, out: { x: number; y: number }): boolean => {
      const u = units.get(id);
      if (!u) return false;
      out.x = u.x;
      out.y = u.y;
      return true;
    },
    ownerOf: (id: number): number | null => units.get(id)?.owner ?? null,
    kindOf: (): number | null => null,
    isDead: (): boolean => false,
  };
  const addUnit = (id: number, x: number, z: number, owner = ME): void => {
    units.set(id, { x, y: z, owner });
    sync.latestIds.set(id, sync.latestIds.size);
  };
  /** Where a unit's picking anchor lands on screen — the head, not the feet. */
  const screenOf = (id: number): { x: number; y: number } => {
    const u = units.get(id)!;
    return worldToScreen(camera, canvas as unknown as HTMLCanvasElement, u.x, 0.4, u.y);
  };

  const heights = { at: () => 0 };
  const ghost = { show: () => {}, hide: () => {}, moveTo: () => {} };
  /** Every command the pointer sent, in order — what an order test reads. */
  const commands: Record<string, unknown>[] = [];
  const host = {
    sendCommands: (cs: Record<string, unknown>[]) => void commands.push(...cs),
  };
  const mirror = {
    map: { size: 64, buildingAt: new Int32Array(64 * 64).fill(-1) },
    buildings: new Map<number, BuildingSnap>(),
  };
  /** Where the camera was last sent — the second press of a number. */
  const rides: { x: number; z: number }[] = [];
  const rig = { touchPanEnabled: true, glideTo: (x: number, z: number) => void rides.push({ x, z }) };

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
      for (let x = b.x; x < b.x + b.w; x++) mirror.map.buildingAt[z * 64 + x] = b.id;
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
    heightOf: (id) => tops.get(id) ?? 0,
    baseOf: () => 0,
    ceiling: () => Math.max(Number.NEGATIVE_INFINITY, ...[...tops.values()]),
  });

  /** Drag a band from one screen point to another, the way a mouse does. */
  const band = (
    from: { x: number; y: number },
    to: { x: number; y: number },
    shiftKey = false,
  ): void => {
    canvas.fire('pointerdown', ptr(from.x, from.y, shiftKey));
    canvas.fire('pointermove', ptr(to.x, to.y, shiftKey));
    canvas.fire('pointerup', ptr(to.x, to.y, shiftKey));
  };

  /** Press a number, with Ctrl or Shift for the two spellings of a stamp. */
  const press = (digit: number, mods: { ctrlKey?: boolean; shiftKey?: boolean } = {}): void =>
    win.fire('keydown', keyDown(`Digit${digit}`, String(digit), mods));

  /** Type a letter — B and the chord letter after it, as the build card
   * is driven. Both spellings, the way keyLetter reads them. */
  const type = (letter: string): void =>
    win.fire('keydown', keyDown(`Key${letter.toUpperCase()}`, letter.toLowerCase()));

  /** Where a world point lands on screen — the pixel a test clicks. */
  const at = (x: number, y: number, z: number): { x: number; y: number } =>
    worldToScreen(camera, canvas as unknown as HTMLCanvasElement, x, y, z);

  /** The tile the plain ground hit under a screen point falls on — what an
   * order used to aim at, and what the test contrasts the new aim with. */
  const groundTileAt = (p: { x: number; y: number }): { x: number; y: number } | null => {
    const g = screenToGround(camera, canvas as unknown as HTMLCanvasElement, p.x, p.y, heights as unknown as HeightField);
    return g && { x: Math.floor(g.x), y: Math.floor(g.z) };
  };

  /** Right-click a screen point, which is how the desktop gives an order. */
  const order = (p: { x: number; y: number }): void => {
    canvas.fire('pointerdown', rightPtr(p.x, p.y));
  };

  /** What the pointer is over, as the hover highlight reads it. */
  const hoverAt = (p: { x: number; y: number }): number => {
    canvas.fire('pointermove', ptr(p.x, p.y));
    controls.updateHoverIfDirty();
    return controls.hoverBuilding;
  };

  /** Select one unit the plain way: press and release on it. */
  const click = (p: { x: number; y: number }): void => {
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
    mirror,
    rides,
    press,
    type,
  };
}

/** The rectangle that covers these screen points, with room to spare. */
function around(points: { x: number; y: number }[]): [{ x: number; y: number }, { x: number; y: number }] {
  const pad = 20;
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  return [
    { x: Math.min(...xs) - pad, y: Math.min(...ys) - pad },
    { x: Math.max(...xs) + pad, y: Math.max(...ys) + pad },
  ];
}

describe('band select', () => {
  let controls: ReturnType<typeof harness>['controls'] | null = null;

  beforeEach(() => {
    vi.stubGlobal('document', {
      createElement: () => fakeEl(),
      getElementById: () => null,
      body: { appendChild: () => {} },
      head: { appendChild: () => {} },
    });
    vi.stubGlobal('window', { addEventListener: () => {}, removeEventListener: () => {} });
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

    expect([...selection()].sort()).toEqual([1, 2]);
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
    h.band({ x: 10, y: 10 }, { x: 60, y: 60 });

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
      body: { appendChild: () => {} },
      head: { appendChild: () => {} },
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

    const rect = made.find((el) => el.style.cssText.includes('border:1px solid'))!;
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

    expect([...selection()].sort()).toEqual([1, 2]);
  });
});

describe('control groups', () => {
  let controls: ReturnType<typeof harness>['controls'] | null = null;

  beforeEach(() => {
    vi.stubGlobal('document', {
      createElement: () => fakeEl(),
      getElementById: () => null,
      body: { appendChild: () => {} },
      head: { appendChild: () => {} },
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

    h.press(1, { ctrlKey: true });
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
    h.press(1, { ctrlKey: true });

    setSelectedBuilding(null);
    h.mirror.buildings.set(7, { ...stamped, hp: 40 });
    h.press(1);

    expect(selectedBuilding()?.hp).toBe(40);
  });

  it('rides the camera out to the building on the second press', () => {
    const h = harness();
    controls = h.controls;
    const b = building(7); // 3x3 at (10, 10)
    h.mirror.buildings.set(b.id, b);
    setSelectedBuilding(b);
    h.press(1, { ctrlKey: true });

    h.press(1);
    expect(h.rides).toEqual([]); // the first press is the selection's
    h.press(1);
    expect(h.rides).toEqual([{ x: 11.5, z: 11.5 }]); // the second is the camera's
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
    h.press(1, { ctrlKey: true }); // 1 is the soldier
    setSelectedBuilding(b);
    h.press(2, { ctrlKey: true }); // 2 is the building of the same id

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
    h.press(3, { ctrlKey: true });

    const b = building(7);
    h.mirror.buildings.set(b.id, b);
    setSelectedBuilding(b);
    h.press(3, { shiftKey: true }); // refused: 3 is the squad's

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

    h.press(4, { shiftKey: true });
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
    h.press(5, { ctrlKey: true });

    const b = building(7);
    h.mirror.buildings.set(b.id, b);
    setSelectedBuilding(b);
    h.press(5, { ctrlKey: true });

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
    h.press(6, { ctrlKey: true });

    h.mirror.buildings.delete(7); // razed, or sold
    setSelectedBuilding(null);
    h.controls.prune();
    h.press(6);
    expect(selectedBuilding()).toBeNull();

    // ...and the number takes a new tenant.
    const other = building(8);
    h.mirror.buildings.set(8, other);
    setSelectedBuilding(other);
    h.press(6, { shiftKey: true }); // free, so even Shift will take it
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
    h.press(1, { ctrlKey: true });

    h.press(1);
    h.controls.deselectAll(); // Esc, inside the beat
    h.press(1);

    expect(selectedBuilding()?.id).toBe(7);
    expect(h.rides).toEqual([{ x: 11.5, z: 11.5 }]);
  });

  it('re-selects a squad on the second press too', () => {
    // Same rule on the units half of the binding, for the same reason.
    const h = harness();
    controls = h.controls;
    h.addUnit(1, -5, -3);
    h.band(...around([h.screenOf(1)]));
    h.press(2, { ctrlKey: true });

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
    h.press(4, { ctrlKey: true });

    h.mirror.buildings.delete(7);
    setSelectedBuilding(null);
    h.press(4); // refused: razed, and the group goes with it

    const fresh = building(8);
    h.mirror.buildings.set(8, fresh);
    setSelectedBuilding(fresh);
    h.press(4, { ctrlKey: true });
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
      body: { appendChild: () => {} },
      head: { appendChild: () => {} },
    });
    vi.stubGlobal('window', { addEventListener: () => {}, removeEventListener: () => {} });
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
    const keep = { ...building(7), owner: THEM };
    const cx = keep.x + keep.w / 2;
    const h = harness({ pitched: { x: cx, z: cx } });
    h.addBuilding(keep, TOP);
    h.addUnit(1, keep.x - 4, keep.y - 4);
    h.click(h.screenOf(1));
    expect([...selection()]).toEqual([1]);
    return h;
  }

  /** How tall the keep is drawn — a castle's 3x3 model, near enough. */
  const TOP = 3.2;
  /** The keep's middle tile, which is what an order aimed at it means. */
  const KEEP_TILE = { x: 11, y: 11 };

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

    expect(h.commands.at(-1)).toMatchObject({ kind: 'moveUnits', ...KEEP_TILE });
  });

  it('reads the roof pixel as the keep even though the ground there is not', () => {
    // Guards the test above: if that pixel's ground hit happened to land on
    // the footprint anyway, the order would aim right without the fix.
    const h = keepAndSquad();
    controls = h.controls;
    const roof = h.at(11.5, TOP, 11.5);

    const ground = h.groundTileAt(roof)!;
    const onFootprint = ground.x >= 10 && ground.x < 13 && ground.y >= 10 && ground.y < 13;
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

    expect(h.commands.at(-1)).toMatchObject({ kind: 'moveUnits', x: 11, y: 17 });
  });
});

describe('build chord', () => {
  let controls: ReturnType<typeof harness>['controls'] | null = null;

  beforeEach(() => {
    vi.stubGlobal('document', {
      createElement: () => fakeEl(),
      getElementById: () => null,
      body: { appendChild: () => {} },
      head: { appendChild: () => {} },
    });
    setMyPlayerId(ME);
    setStock({});
    setTechs({ researched: [], festivalTicksLeft: 0, pavingUnlocked: false, hasAbbey: false });
    setPlacing(null);
    setBuildAim(null);
  });

  afterEach(() => {
    controls?.dispose();
    controls = null;
    setStock({});
    setTechs({ researched: [], festivalTicksLeft: 0, pavingUnlocked: false, hasAbbey: false });
    setPlacing(null);
    setBuildAim(null);
    vi.unstubAllGlobals();
  });

  it('arms the building the letter names, and aims the ribbon at it', () => {
    const h = harness();
    controls = h.controls;
    setStock({ [GoodId.wood]: 20, [GoodId.stone]: 20 });

    h.type('B');
    h.type('M');

    expect(placing()).toBe('mill');
    expect(buildAim()).toBe('mill');
  });

  it('aims the ribbon at a building the stores cannot pay for', () => {
    // The refusal is the case that needs the tab most: the toast says the
    // stores are short, and the button that says short of what is on a tab
    // the player is not looking at. Nothing is armed — the gate still
    // holds — but the ribbon has been pointed at the answer.
    const h = harness();
    controls = h.controls;
    setStock({ [GoodId.wood]: 1 });

    h.type('B');
    h.type('M');

    expect(placing()).toBeNull();
    expect(buildAim()).toBe('mill');
  });

  it('aims the ribbon at a building that is not researched yet', () => {
    const h = harness();
    controls = h.controls;
    setStock({ [GoodId.wood]: 99, [GoodId.stone]: 99 });

    h.type('B');
    h.type('I'); // the Iron Mine, behind ironworking

    expect(placing()).toBeNull();
    expect(buildAim()).toBe('ironMine');
  });

  it('aims again when the same refused building is chorded twice', () => {
    // The signal is written with equals:false for exactly this: a player
    // who read the cost, tabbed away and typed the chord again gets the
    // tab back. Plain signal equality would swallow the second write.
    const h = harness();
    controls = h.controls;
    setStock({});
    const aims: (string | null)[] = [];

    const stop = createRoot((dispose) => {
      createComputed(() => void aims.push(buildAim()));
      return dispose;
    });
    h.type('B');
    h.type('M');
    h.type('B');
    h.type('M');
    stop();

    expect(aims).toEqual([null, 'mill', 'mill']);
  });

  it('leaves a stray letter alone', () => {
    const h = harness();
    controls = h.controls;
    setStock({ [GoodId.wood]: 99, [GoodId.stone]: 99 });

    h.type('B');
    h.type('Z');

    expect(placing()).toBeNull();
    expect(buildAim()).toBeNull();
  });
});
