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
import { screenToGround, worldToScreen } from './picking';
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
