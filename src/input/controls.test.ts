import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';

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
import { worldToScreen } from './picking';
import type { BuildingSnap } from '../protocol/messages';
import type { SceneSync } from '../render/sceneSync';
import type { GhostPlacement } from '../render/ghost';
import type { HeightField } from '../render/heightField';
import type { WorldMirror } from '../app/mirror';
import type { SimHost } from '../app/simHost';
import {
  selectedBuilding,
  selection,
  setMyPlayerId,
  setSelectedBuilding,
  setSelection,
} from '../ui/store';

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
function harness() {
  const canvas = fakeEl();
  const camera = new THREE.OrthographicCamera(-20, 20, 15, -15, 0.1, 200);
  camera.position.set(0, 50, 0);
  camera.up.set(0, 0, -1);
  camera.lookAt(0, 0, 0);
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
  const host = { sendCommands: () => {} };
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

  return { canvas, controls, addUnit, screenOf, band, mirror, rides, press };
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
