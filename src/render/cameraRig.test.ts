import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CAMERA_YAW, CameraRig } from './cameraRig';

/**
 * The rig's turn: Shift+wheel and Insert/Delete, stepped so the view lands
 * on angles worth landing on. Driven headless — the rig needs a window to
 * hang listeners on, a document, a location, and a canvas with a size,
 * none of which need a DOM to stand in for them. Node's own EventTarget
 * carries the events; the handlers read only code, key, repeat, deltaX,
 * deltaY and shiftKey, so a plain Event with those pinned on is a key or
 * a wheel as far as the rig can tell.
 */

const STEP = Math.PI / 12;
const FRAME = 1 / 60;

/** A fake canvas: an EventTarget with a size. */
const makeCanvas = (): HTMLCanvasElement => {
  const el = new EventTarget() as HTMLCanvasElement;
  Object.assign(el, { clientWidth: 1600, clientHeight: 900, setPointerCapture: () => {} });
  return el;
};

const fire = (target: EventTarget, type: string, init: object): void => {
  const e = new Event(type, { cancelable: true });
  Object.assign(e, init);
  target.dispatchEvent(e);
};

const keyDown = (code: string, repeat = false): void =>
  fire(window, 'keydown', { code, key: code, repeat });
const keyUp = (code: string): void => fire(window, 'keyup', { code, key: code });
const wheel = (canvas: EventTarget, deltaY: number, shiftKey = true, deltaX = 0): void =>
  fire(canvas, 'wheel', { deltaY, deltaX, shiftKey });

/** The yaw the rig is actually showing, read back off its ground quad:
 * screen-right on the ground is the top edge, and the rig's basis for it
 * is (cos yaw, -sin yaw). */
const yawOf = (rig: CameraRig): number => {
  const q = rig.viewQuad(new Float64Array(8));
  return Math.atan2(-(q[3]! - q[1]!), q[2]! - q[0]!);
};

/** Run the ease to rest: a second of frames is many time constants. */
const settle = (rig: CameraRig): void => {
  for (let i = 0; i < 60; i++) rig.tick(FRAME);
};

/** Hold a key for `seconds` of frames, then let go. */
const hold = (rig: CameraRig, code: string, seconds: number): void => {
  keyDown(code);
  for (let t = 0; t < seconds - 1e-9; t += FRAME) rig.tick(FRAME);
  keyUp(code);
};

describe('CameraRig turn', () => {
  let canvas: HTMLCanvasElement;
  let rig: CameraRig;

  beforeEach(() => {
    vi.stubGlobal('window', Object.assign(new EventTarget(), { innerWidth: 1600, innerHeight: 900 }));
    vi.stubGlobal('document', Object.assign(new EventTarget(), { hidden: false }));
    vi.stubGlobal('location', { search: '' });
    canvas = makeCanvas();
    rig = new CameraRig(canvas);
  });
  afterEach(() => {
    rig.dispose();
    vi.unstubAllGlobals();
  });

  it('boots on the default line, two steps off square', () => {
    expect(yawOf(rig)).toBeCloseTo(CAMERA_YAW, 10);
    expect(CAMERA_YAW).toBeCloseTo(2 * STEP, 12);
  });

  it('Shift+wheel turns one step a notch and eases there; a plain wheel zooms', () => {
    wheel(canvas, 100);
    rig.tick(FRAME);
    // In flight: left the line, not yet on the next step.
    const mid = yawOf(rig);
    expect(mid).toBeGreaterThan(CAMERA_YAW);
    expect(mid).toBeLessThan(CAMERA_YAW + STEP);
    settle(rig);
    expect(yawOf(rig)).toBeCloseTo(CAMERA_YAW + STEP, 10);
    // Two notches back: square to the grid, exactly.
    wheel(canvas, -100);
    wheel(canvas, -100);
    wheel(canvas, -100);
    settle(rig);
    expect(yawOf(rig)).toBeCloseTo(0, 10);
    // The unshifted wheel is the zoom: the frame grows, the line holds.
    const before = rig.viewQuad(new Float64Array(8));
    wheel(canvas, 100, false);
    settle(rig);
    expect(yawOf(rig)).toBeCloseTo(0, 10);
    const after = rig.viewQuad(new Float64Array(8));
    expect(after[2]! - after[0]!).toBeGreaterThan(before[2]! - before[0]!);
  });

  it('banks trackpad travel into whole steps and forgets it on a reversal', () => {
    for (let i = 0; i < 19; i++) wheel(canvas, 5);
    settle(rig);
    expect(yawOf(rig)).toBeCloseTo(CAMERA_YAW, 10); // 95: not yet
    wheel(canvas, 5);
    settle(rig);
    expect(yawOf(rig)).toBeCloseTo(CAMERA_YAW + STEP, 10); // 100: one
    wheel(canvas, 60);
    wheel(canvas, -60);
    wheel(canvas, 60);
    settle(rig);
    expect(yawOf(rig)).toBeCloseTo(CAMERA_YAW + STEP, 10); // never reached 100 one way
    // A shifted wheel some platforms hand over as horizontal travel.
    wheel(canvas, 0, true, 100);
    settle(rig);
    expect(yawOf(rig)).toBeCloseTo(CAMERA_YAW + 2 * STEP, 10);
  });

  it('a Delete tap inside one frame is one step; Insert the other way', () => {
    keyDown('Delete');
    keyUp('Delete');
    settle(rig);
    expect(yawOf(rig)).toBeCloseTo(CAMERA_YAW + STEP, 10);
    keyDown('Insert');
    keyUp('Insert');
    keyDown('Insert');
    keyUp('Insert');
    settle(rig);
    expect(yawOf(rig)).toBeCloseTo(CAMERA_YAW - STEP, 10);
    // Key repeat is not more taps.
    keyDown('Insert', true);
    keyUp('Insert');
    settle(rig);
    expect(yawOf(rig)).toBeCloseTo(CAMERA_YAW - STEP, 10);
  });

  it('[ and ] are Insert and Delete for keyboards without them', () => {
    // By physical key (the code), and by name where a source leaves the
    // code blank.
    keyDown('BracketRight');
    keyUp('BracketRight');
    fire(window, 'keydown', { code: '', key: ']', repeat: false });
    fire(window, 'keyup', { code: '', key: ']' });
    settle(rig);
    expect(yawOf(rig)).toBeCloseTo(CAMERA_YAW + 2 * STEP, 10);
    hold(rig, 'BracketLeft', 0.5);
    settle(rig);
    expect(yawOf(rig)).toBeCloseTo(CAMERA_YAW - STEP, 6);
    // Opposite keys held together cancel; the release settles on a step.
    keyDown('BracketRight');
    keyDown('Insert');
    for (let i = 0; i < 30; i++) rig.tick(FRAME);
    expect(yawOf(rig)).toBeCloseTo(CAMERA_YAW - STEP, 6);
    keyUp('BracketRight');
    keyUp('Insert');
    settle(rig);
    expect(yawOf(rig)).toBeCloseTo(CAMERA_YAW - STEP, 6);
  });

  it('a held key turns freely at a quarter turn a second, then settles on the nearest step', () => {
    // Half a second: 45° of travel, three steps exactly.
    hold(rig, 'Delete', 0.5);
    settle(rig);
    expect(yawOf(rig)).toBeCloseTo(CAMERA_YAW + 3 * STEP, 6);
    // A third of a second: 30° — two steps; and mid-hold the yaw is off
    // the step grid, which is what "freely" means.
    keyDown('Insert');
    for (let i = 0; i < 7; i++) rig.tick(FRAME); // 10.5°
    const mid = (yawOf(rig) - CAMERA_YAW) / STEP;
    expect(Math.abs(mid - Math.round(mid))).toBeGreaterThan(0.05);
    for (let i = 0; i < 13; i++) rig.tick(FRAME); // 30° in all
    keyUp('Insert');
    settle(rig);
    expect(yawOf(rig)).toBeCloseTo(CAMERA_YAW + STEP, 6);
  });

  it('a short hold still means one whole step, not a wobble back', () => {
    hold(rig, 'Delete', 2 * FRAME); // ~3°
    settle(rig);
    expect(yawOf(rig)).toBeCloseTo(CAMERA_YAW + STEP, 10);
  });

  it('a tap landed mid-way through a wheel turn adds to that turn', () => {
    wheel(canvas, 100);
    rig.tick(FRAME); // the ease is under way
    keyDown('Delete');
    rig.tick(FRAME);
    keyUp('Delete');
    settle(rig);
    expect(yawOf(rig)).toBeCloseTo(CAMERA_YAW + 2 * STEP, 6);
  });

  it('turns about the look-at point', () => {
    const center = (q: Float64Array): [number, number] => [
      (q[0]! + q[4]!) / 2,
      (q[1]! + q[5]!) / 2,
    ];
    const before = center(rig.viewQuad(new Float64Array(8)));
    hold(rig, 'Delete', 0.4);
    settle(rig);
    const after = center(rig.viewQuad(new Float64Array(8)));
    expect(after[0]).toBeCloseTo(before[0]!, 8);
    expect(after[1]).toBeCloseTo(before[1]!, 8);
  });

  it("the plan view is north-up by definition and doesn't turn", () => {
    rig.setViewMode('topDown');
    wheel(canvas, 100);
    hold(rig, 'Delete', 0.5);
    keyDown('Insert');
    keyUp('Insert');
    settle(rig);
    expect(yawOf(rig)).toBeCloseTo(0, 10);
    // Back in the game, on the game's own line, with nothing banked.
    rig.setViewMode('game');
    settle(rig);
    expect(yawOf(rig)).toBeCloseTo(CAMERA_YAW, 10);
  });

  it('viewFrame hands the audio the basis viewQuad draws by', () => {
    hold(rig, 'Delete', 0.25);
    settle(rig);
    const f = rig.viewFrame(3);
    const q = rig.viewQuad(new Float64Array(8));
    const len = Math.hypot(q[2]! - q[0]!, q[3]! - q[1]!);
    expect(f.rx).toBeCloseTo((q[2]! - q[0]!) / len, 10);
    expect(f.rz).toBeCloseTo((q[3]! - q[1]!) / len, 10);
    expect(f.cx).toBeCloseTo((q[0]! + q[4]!) / 2, 10);
    expect(f.cz).toBeCloseTo((q[1]! + q[5]!) / 2, 10);
    // The extent is the 45° AABB's half-span plus the margin, whatever the
    // yaw: on the diamond itself it is the live AABB (square there), and
    // turned square to the grid — where the live AABB is the footprint,
    // wider than tall — it has not moved.
    keyDown('Insert');
    keyUp('Insert');
    settle(rig); // 45°
    expect(yawOf(rig)).toBeCloseTo(Math.PI / 4, 10);
    const b = rig.viewBounds(3);
    const ext45 = rig.viewFrame(3).ext;
    expect(ext45).toBeCloseTo((b.maxX - b.minX) / 2, 10);
    expect(ext45).toBeCloseTo((b.maxZ - b.minZ) / 2, 10);
    for (let i = 0; i < 3; i++) {
      keyDown('Insert');
      keyUp('Insert');
    }
    settle(rig); // 0°
    const s = rig.viewBounds(3);
    expect(s.maxX - s.minX).not.toBeCloseTo(s.maxZ - s.minZ, 1);
    expect(rig.viewFrame(3).ext).toBeCloseTo(ext45, 10);
  });
});
