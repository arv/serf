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

  return { canvas, controls, addUnit, screenOf, band };
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

  it('picks up everyone of yours the band closed over', () => {
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
