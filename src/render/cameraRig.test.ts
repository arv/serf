import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CAMERA_YAW, CameraRig, ViewMode } from './cameraRig';
import { screenToGround, worldToScreen } from '../input/picking';
import { DEFAULT_MAP_SIZE, MAX_MAP_SIZE, MIN_MAP_SIZE, gridFor, marginFor } from '../shared/grid';

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

/** A key pressed while something else on the page owns it: a focused
 * field (pass a tag name) or a chord (pass modifiers). `target` has to be
 * defined as an own property — Event.target is a getter, and dispatch
 * would otherwise report the window it was fired on. */
const keyDownFrom = (
  code: string,
  opts: { tagName?: string; isContentEditable?: boolean } & Partial<KeyboardEvent>,
): void => {
  const { tagName, isContentEditable, ...mods } = opts;
  const e = new Event('keydown', { cancelable: true });
  Object.assign(e, { code, key: code, repeat: false }, mods);
  if (tagName !== undefined || isContentEditable !== undefined) {
    Object.defineProperty(e, 'target', {
      value: { tagName, isContentEditable },
      configurable: true,
    });
  }
  window.dispatchEvent(e);
};
const keyUp = (code: string): void => fire(window, 'keyup', { code, key: code });
const wheel = (
  canvas: EventTarget,
  deltaY: number,
  shiftKey = true,
  deltaX = 0,
  deltaMode = 0,
): void => fire(canvas, 'wheel', { deltaY, deltaX, shiftKey, deltaMode });

/** The yaw the rig is actually showing, read back off its ground quad:
 * screen-right on the ground is the top edge, and the rig's basis for it
 * is (cos yaw, -sin yaw). */
const yawOf = (rig: CameraRig): number => {
  const q = rig.viewQuad(new Float64Array(8));
  return Math.atan2(-(q[3]! - q[1]!), q[2]! - q[0]!);
};

/** Assert the rig is looking down `expected`, comparing the two as
 * directions rather than as numbers: turn far enough one way and the yaw
 * passes π, where the quad it is read back off wraps and a raw comparison
 * would be out by a whole turn. */
const expectYaw = (rig: CameraRig, expected: number, digits = 10): void => {
  const d = yawOf(rig) - expected;
  expect(Math.atan2(Math.sin(d), Math.cos(d))).toBeCloseTo(0, digits);
};

/** Run the ease to rest: a second of frames is many time constants. */
const settle = (rig: CameraRig): void => {
  for (let i = 0; i < 60; i++) rig.tick(FRAME);
};

/** Hold a key for `seconds` of frames, then let go. */
const hold = (rig: CameraRig, code: string, seconds: number): void => holdAll(rig, [code], seconds);

/** The same, for a chord: every key down together, held together, released
 * together. Pressing them in sequence is a different gesture and a weaker
 * one — the pan is in screen space, so a lean the yaw has turned moves on
 * both world axes, and a second key pressed after the first has let go can
 * walk the camera back off the clamp the first one reached. Two arrows at
 * once is what a player's hand does and what drives into the corner of the
 * clamp box. */
const holdAll = (rig: CameraRig, codes: readonly string[], seconds: number): void => {
  for (const code of codes) keyDown(code);
  for (let t = 0; t < seconds - 1e-9; t += FRAME) rig.tick(FRAME);
  for (const code of codes) keyUp(code);
};

describe('CameraRig turn', () => {
  let canvas: HTMLCanvasElement;
  let rig: CameraRig;

  beforeEach(() => {
    vi.stubGlobal(
      'window',
      Object.assign(new EventTarget(), { innerWidth: 1600, innerHeight: 900 }),
    );
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
    expectYaw(rig, CAMERA_YAW, 10);
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
    expectYaw(rig, CAMERA_YAW + STEP, 10);
    // Two notches back: square to the grid, exactly.
    wheel(canvas, -100);
    wheel(canvas, -100);
    wheel(canvas, -100);
    settle(rig);
    expectYaw(rig, 0, 10);
    // The unshifted wheel is the zoom: the frame grows, the line holds.
    const before = rig.viewQuad(new Float64Array(8));
    wheel(canvas, 100, false);
    settle(rig);
    expectYaw(rig, 0, 10);
    const after = rig.viewQuad(new Float64Array(8));
    expect(after[2]! - after[0]!).toBeGreaterThan(before[2]! - before[0]!);
  });

  it('banks trackpad travel into whole steps and forgets it on a reversal', () => {
    for (let i = 0; i < 19; i++) wheel(canvas, 5);
    settle(rig);
    expectYaw(rig, CAMERA_YAW, 10); // 95: not yet
    wheel(canvas, 5);
    settle(rig);
    expectYaw(rig, CAMERA_YAW + STEP, 10); // 100: one
    // The bank is spent, not debited: a swipe turns every 100 of travel,
    // evenly, rather than gaining on the count.
    for (let i = 0; i < 20; i++) wheel(canvas, 5);
    settle(rig);
    expectYaw(rig, CAMERA_YAW + 2 * STEP, 10);
    wheel(canvas, 60);
    wheel(canvas, -60);
    wheel(canvas, 60);
    settle(rig);
    expectYaw(rig, CAMERA_YAW + 2 * STEP, 10); // never reached 100 one way
    // A shifted wheel some platforms hand over as horizontal travel.
    wheel(canvas, 0, true, 100);
    settle(rig);
    expectYaw(rig, CAMERA_YAW + 3 * STEP, 10);
  });

  it('reads a notch the same in pixels, lines and pages', () => {
    // Chromium hands over pixels, Firefox three lines, and the spec allows
    // a screenful. Each is one notch, and one notch is one step.
    wheel(canvas, 100);
    settle(rig);
    expectYaw(rig, CAMERA_YAW + STEP, 10);
    wheel(canvas, 3, true, 0, 1); // lines
    settle(rig);
    expectYaw(rig, CAMERA_YAW + 2 * STEP, 10);
    wheel(canvas, 1, true, 0, 2); // pages
    settle(rig);
    expectYaw(rig, CAMERA_YAW + 3 * STEP, 10);
    // Raw, a line-mode notch is 3 — a thirtieth of the price. Normalized
    // it is one step, so the turn is not dead on Firefox.
    for (let i = 0; i < 5; i++) wheel(canvas, -3, true, 0, 1);
    settle(rig);
    expectYaw(rig, CAMERA_YAW - 2 * STEP, 10);
    // The zoom reads the same unit: a line-mode notch reframes as much as
    // its pixel-mode twin, rather than by three-hundredths of it.
    const span = (): number => {
      const q = rig.viewQuad(new Float64Array(8));
      return Math.hypot(q[2]! - q[0]!, q[3]! - q[1]!);
    };
    const start = span();
    wheel(canvas, 100, false);
    const byPixels = span() / start;
    wheel(canvas, -100, false); // back to where it was
    expect(span()).toBeCloseTo(start, 8);
    wheel(canvas, 2.5, false, 0, 1); // 2.5 lines = 100px
    expect(span() / start).toBeCloseTo(byPixels, 8);
  });

  it('one event is never two turns, however coarsely a device counts', () => {
    // A Windows notch is 120px, and Firefox's three lines normalize to the
    // same. Change left banked would make every fifth notch turn twice.
    for (let i = 1; i <= 10; i++) {
      wheel(canvas, 120);
      settle(rig);
      expectYaw(rig, CAMERA_YAW + i * STEP, 6);
    }
    // Nor does one enormous event stand for the many notches it outweighs.
    wheel(canvas, 10_000);
    settle(rig);
    expectYaw(rig, CAMERA_YAW + 11 * STEP, 6);
  });

  it('a Delete tap inside one frame is one step; Insert the other way', () => {
    keyDown('Delete');
    keyUp('Delete');
    settle(rig);
    expectYaw(rig, CAMERA_YAW + STEP, 10);
    keyDown('Insert');
    keyUp('Insert');
    keyDown('Insert');
    keyUp('Insert');
    settle(rig);
    expectYaw(rig, CAMERA_YAW - STEP, 10);
    // Key repeat is not more taps.
    keyDown('Insert', true);
    keyUp('Insert');
    settle(rig);
    expectYaw(rig, CAMERA_YAW - STEP, 10);
  });

  it('[ and ] are Insert and Delete for keyboards without them', () => {
    // By physical key (the code), and by name where a source leaves the
    // code blank.
    keyDown('BracketRight');
    keyUp('BracketRight');
    fire(window, 'keydown', { code: '', key: ']', repeat: false });
    fire(window, 'keyup', { code: '', key: ']' });
    settle(rig);
    expectYaw(rig, CAMERA_YAW + 2 * STEP, 10);
    hold(rig, 'BracketLeft', 0.5);
    settle(rig);
    expectYaw(rig, CAMERA_YAW - STEP, 6);
    // Opposite keys held together cancel; the release settles on a step.
    keyDown('BracketRight');
    keyDown('Insert');
    for (let i = 0; i < 30; i++) rig.tick(FRAME);
    expectYaw(rig, CAMERA_YAW - STEP, 6);
    keyUp('BracketRight');
    keyUp('Insert');
    settle(rig);
    expectYaw(rig, CAMERA_YAW - STEP, 6);
  });

  it('a held key turns freely at a quarter turn a second, then settles on the nearest step', () => {
    // Half a second: 45° of travel, three steps exactly.
    hold(rig, 'Delete', 0.5);
    settle(rig);
    expectYaw(rig, CAMERA_YAW + 3 * STEP, 6);
    // A third of a second: 30° — two steps; and mid-hold the yaw is off
    // the step grid, which is what "freely" means.
    keyDown('Insert');
    for (let i = 0; i < 7; i++) rig.tick(FRAME); // 10.5°
    const mid = (yawOf(rig) - CAMERA_YAW) / STEP;
    expect(Math.abs(mid - Math.round(mid))).toBeGreaterThan(0.05);
    for (let i = 0; i < 13; i++) rig.tick(FRAME); // 30° in all
    keyUp('Insert');
    settle(rig);
    expectYaw(rig, CAMERA_YAW + STEP, 6);
  });

  it('opposite keys stop the turn dead; they do not settle it mid-hold', () => {
    // Turning, off the step grid, when the other key comes down under the
    // same hand. The camera must hold exactly there: settling here would
    // snap the view while a key is still down, and then lurch back into a
    // free turn the moment one came up.
    keyDown('Delete');
    for (let i = 0; i < 7; i++) rig.tick(FRAME); // 10.5°, off-grid
    const paused = yawOf(rig);
    expect((paused - CAMERA_YAW) / STEP).toBeCloseTo(0.7, 6);
    keyDown('Insert');
    for (let i = 0; i < 30; i++) rig.tick(FRAME);
    expect(yawOf(rig)).toBeCloseTo(paused, 12); // not a degree of it moved
    // Lifting the second key hands the turn back to the first.
    keyUp('Insert');
    for (let i = 0; i < 3; i++) rig.tick(FRAME); // 15° in all
    keyUp('Delete');
    settle(rig);
    expectYaw(rig, CAMERA_YAW + STEP, 6);
  });

  it('a flip under the hand settles against the leg it ended on', () => {
    // Out to 30° on Delete, stopped, then back on Insert. The release must
    // land near where the eye left the camera — measuring the whole round
    // trip against the final direction would fling it the other way.
    keyDown('Delete');
    for (let i = 0; i < 20; i++) rig.tick(FRAME); // +30°
    keyDown('Insert');
    for (let i = 0; i < 5; i++) rig.tick(FRAME); // held
    keyUp('Delete'); // Insert alone now: the flip
    for (let i = 0; i < 7; i++) rig.tick(FRAME); // back to +19.5°
    const before = yawOf(rig);
    keyUp('Insert');
    settle(rig);
    expectYaw(rig, CAMERA_YAW + STEP, 6); // the step next door, not a swing past 0
    expect(Math.abs(yawOf(rig) - before)).toBeLessThan(STEP);
    // Far enough back and it simply stops where it is.
    keyDown('Insert');
    for (let i = 0; i < 20; i++) rig.tick(FRAME); // -30°
    keyUp('Insert');
    settle(rig);
    expectYaw(rig, CAMERA_YAW - STEP, 6);
  });

  it('a short hold still means one whole step, not a wobble back', () => {
    hold(rig, 'Delete', 2 * FRAME); // ~3°
    settle(rig);
    expectYaw(rig, CAMERA_YAW + STEP, 10);
  });

  it('a tap landed mid-way through a wheel turn adds to that turn', () => {
    wheel(canvas, 100);
    rig.tick(FRAME); // the ease is under way
    keyDown('Delete');
    rig.tick(FRAME);
    keyUp('Delete');
    settle(rig);
    expectYaw(rig, CAMERA_YAW + 2 * STEP, 6);
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

  it('leaves the key to whoever already owns it', () => {
    // Renaming a map in the editor: every Delete is a character, and none
    // of them is a camera turn. Same for the HUD's volume slider taking
    // an arrow, and for a select being walked.
    for (const tagName of ['INPUT', 'TEXTAREA', 'SELECT']) {
      keyDownFrom('Delete', { tagName });
      keyUp('Delete');
    }
    keyDownFrom('Delete', { tagName: 'DIV', isContentEditable: true });
    keyUp('Delete');
    // Chords belong to the browser: ⌘[ is Back, ⌥ and Ctrl are not ours.
    keyDownFrom('BracketLeft', { metaKey: true });
    keyUp('BracketLeft');
    keyDownFrom('BracketRight', { altKey: true });
    keyUp('BracketRight');
    keyDownFrom('Delete', { ctrlKey: true });
    keyUp('Delete');
    settle(rig);
    expectYaw(rig, CAMERA_YAW, 10);
    // A plain press over the map still turns, so the guard is a gate and
    // not a wall — and a DIV is not a field.
    keyDownFrom('Delete', { tagName: 'DIV' });
    keyUp('Delete');
    settle(rig);
    expectYaw(rig, CAMERA_YAW + STEP, 10);
  });

  it('lets go of a key held when focus moved into a field', () => {
    // Down over the map, up with a field focused: keyup is ungated, so
    // the key cannot stick down and turn the camera forever.
    keyDown('Delete');
    for (let i = 0; i < 10; i++) rig.tick(FRAME);
    fire(window, 'keyup', { code: 'Delete', key: 'Delete' });
    settle(rig);
    const landed = yawOf(rig);
    expectYaw(rig, CAMERA_YAW + STEP, 6);
    for (let i = 0; i < 60; i++) rig.tick(FRAME);
    expect(yawOf(rig)).toBeCloseTo(landed, 10);
  });

  it('cancels opposite keys pressed and released inside one frame', () => {
    // The sub-frame path is the one #unseen exists for, and opposite keys
    // have to cancel there too. Overlapping, in both orders.
    keyDown('Delete');
    keyDown('Insert');
    keyUp('Delete');
    keyUp('Insert');
    settle(rig);
    expectYaw(rig, CAMERA_YAW, 10);
    keyDown('Insert');
    keyDown('Delete');
    keyUp('Insert');
    keyUp('Delete');
    settle(rig);
    expectYaw(rig, CAMERA_YAW, 10);
    // Nested, the inner pair released first.
    keyDown('Delete');
    keyDown('Insert');
    keyUp('Insert');
    keyUp('Delete');
    settle(rig);
    expectYaw(rig, CAMERA_YAW, 10);
    // And two taps the same way still mean two steps, not one.
    keyDown('Delete');
    keyDown('BracketRight');
    keyUp('Delete');
    keyUp('BracketRight');
    settle(rig);
    expectYaw(rig, CAMERA_YAW + 2 * STEP, 10);
  });

  it('reports that it moved, once, to whoever asks', () => {
    // The hover scan waits on a pointer that may never move; a camera
    // turning under a still hand has to be able to say so.
    expect(rig.consumeMoved()).toBe(true); // construction framed it
    expect(rig.consumeMoved()).toBe(false);
    rig.tick(FRAME);
    expect(rig.consumeMoved()).toBe(false); // a camera at rest is still
    wheel(canvas, 100);
    rig.tick(FRAME);
    expect(rig.consumeMoved()).toBe(true); // mid-ease
    settle(rig);
    rig.consumeMoved();
    rig.tick(FRAME);
    expect(rig.consumeMoved()).toBe(false); // settled again
    rig.focusOn(20, 20);
    expect(rig.consumeMoved()).toBe(true);
  });

  it('counts as under way for a beat after the last motion', () => {
    // What the frame pacer asks before it decides whether to draw: a
    // camera the player is pushing around earns frames a resting one
    // does not.
    const at = performance.now();
    rig.focusOn(20, 20);
    expect(rig.driving(at)).toBe(true);
    // The tail outlives a gap between touch samples...
    expect(rig.driving(at + 100)).toBe(true);
    // ...and not a finger that has come off the glass.
    expect(rig.driving(at + 1000)).toBe(false);
    // Any way the camera moves counts, a turn as much as a pan.
    wheel(canvas, 100);
    rig.tick(FRAME);
    expect(rig.driving(performance.now())).toBe(true);
  });

  it('is under way the instant a glide is ordered, not a frame later', () => {
    // driving() is asked by the pacer, which decides whether the frame
    // that would tick this glide runs at all. Answering from the last
    // motion alone would open the ride on a resting-cap frame.
    rig.tick(FRAME);
    const at = performance.now();
    expect(rig.driving(at + 1000)).toBe(false); // nothing doing
    rig.glideTo(40, 40);
    expect(rig.driving(at + 1000)).toBe(true); // filed, not yet applied
  });

  it('is under way while a key holds the camera, before the tick that moves it', () => {
    rig.tick(FRAME);
    const at = performance.now();
    expect(rig.driving(at + 1000)).toBe(false);
    keyDown('ArrowLeft');
    expect(rig.driving(at + 1000)).toBe(true);
    keyUp('ArrowLeft');
    // The key is up and the pan it asked for is spent; only the tail is
    // left, and this is well past it.
    rig.tick(FRAME);
    expect(rig.driving(performance.now() + 1000)).toBe(false);
  });

  it('holds still on a screen that does not turn — the editor', () => {
    // Every way in is closed, not just the brackets it wanted back.
    rig.setTurnEnabled(false);
    for (const code of ['Delete', 'Insert', 'BracketRight', 'BracketLeft']) {
      keyDown(code);
      keyUp(code);
    }
    fire(window, 'keydown', { code: '', key: ']', repeat: false });
    fire(window, 'keyup', { code: '', key: ']' });
    hold(rig, 'Delete', 0.5);
    wheel(canvas, 100);
    wheel(canvas, 3, true, 0, 1);
    settle(rig);
    expectYaw(rig, CAMERA_YAW, 10);
    // The zoom is not a turn and is left alone.
    const span = (): number => {
      const q = rig.viewQuad(new Float64Array(8));
      return Math.hypot(q[2]! - q[0]!, q[3]! - q[1]!);
    };
    const before = span();
    wheel(canvas, 100, false);
    expect(span()).toBeGreaterThan(before);
    // And it can be handed back.
    rig.setTurnEnabled(true);
    keyDown('Delete');
    keyUp('Delete');
    settle(rig);
    expectYaw(rig, CAMERA_YAW + STEP, 10);
  });

  it('lets go of a held key when a screen stops turning mid-hold', () => {
    // The travel already made settles once; after that the key is inert
    // rather than stuck turning a camera that no longer answers to it.
    keyDown('Delete');
    for (let i = 0; i < 10; i++) rig.tick(FRAME);
    rig.setTurnEnabled(false);
    for (let i = 0; i < 30; i++) rig.tick(FRAME);
    const landed = yawOf(rig);
    keyUp('Delete');
    settle(rig);
    expect(yawOf(rig)).toBeCloseTo(landed, 10);
    expectYaw(rig, CAMERA_YAW + STEP, 6);
  });

  it("the plan view is north-up by definition and doesn't turn", () => {
    rig.setViewMode(ViewMode.topDown);
    wheel(canvas, 100);
    hold(rig, 'Delete', 0.5);
    keyDown('Insert');
    keyUp('Insert');
    settle(rig);
    expectYaw(rig, 0, 10);
    // Back in the game, on the game's own line, with nothing banked — a
    // press the plan view swallowed must not turn the match's camera.
    rig.setViewMode(ViewMode.game);
    settle(rig);
    expectYaw(rig, CAMERA_YAW, 10);
    keyDown('Delete');
    rig.setViewMode(ViewMode.topDown);
    keyUp('Delete');
    rig.setViewMode(ViewMode.game);
    settle(rig);
    expectYaw(rig, CAMERA_YAW, 10);
  });

  it('picking sees the camera as it stands, without waiting for a draw', () => {
    // project/unproject read the camera's world matrix, which three
    // rebuilds inside render(). Nothing here ever renders — exactly the
    // position a pointer handler is in between frames — so a stale matrix
    // shows up as picking answering for the camera's old angle.
    //
    // The strongest tie available: viewQuad's corners are the ground under
    // the screen's corners, so projecting them has to land on the screen's
    // corners. If picking and the rig disagree about the yaw, this parts.
    const corners = (): { x: number; y: number }[] => {
      const q = rig.viewQuad(new Float64Array(8));
      return [0, 1, 2, 3].map((i) =>
        worldToScreen(rig.camera, canvas, q[i * 2]!, 0, q[i * 2 + 1]!),
      );
    };
    const expected = [
      { x: 0, y: 0 },
      { x: canvas.clientWidth, y: 0 },
      { x: canvas.clientWidth, y: canvas.clientHeight },
      { x: 0, y: canvas.clientHeight },
    ];
    const check = (): void => {
      corners().forEach((c, i) => {
        expect(c.x).toBeCloseTo(expected[i]!.x, 6);
        expect(c.y).toBeCloseTo(expected[i]!.y, 6);
      });
    };
    check(); // the boot line
    for (let i = 0; i < 6; i++) wheel(canvas, 100); // a quarter turn
    settle(rig);
    expectYaw(rig, CAMERA_YAW + 6 * STEP, 10);
    check();
    // Mid-turn too — the ease moves the camera on a tick, and a hand on
    // the mouse does not wait for the frame to finish.
    wheel(canvas, -100);
    rig.tick(FRAME);
    check();
    // And the round trip: the ground under the middle of the screen is
    // the point the camera is looking at, whichever way it faces.
    settle(rig);
    const mid = screenToGround(rig.camera, canvas, canvas.clientWidth / 2, canvas.clientHeight / 2);
    const q = rig.viewQuad(new Float64Array(8));
    expect(mid!.x).toBeCloseTo((q[0]! + q[4]!) / 2, 6);
    expect(mid!.z).toBeCloseTo((q[1]! + q[5]!) / 2, 6);
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
    expectYaw(rig, Math.PI / 4, 10);
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

/**
 * The zoom-out cap and the scenery ring's depth are one decision: the ring
 * is however far a frame reaches past the play square at full zoom-out, and
 * the cap is what decides that distance. They are written in two files
 * (MAX_VIEW_FRACTION here, marginFor in shared/grid.ts) and cannot be
 * written in one — grid.ts is imported by the server, which has no camera —
 * so what keeps them together is this: not a shared number, which two hands
 * can edit apart just as easily, but the property the pair exists to
 * deliver, asserted against the rig's real behavior. Move either constant
 * the wrong way and this fails.
 *
 * Panning, not focusOn: the pan clamp is the rule the ring was sized
 * against. focusOn is allowed past it on purpose (it centers a border
 * castle without asking, and #clampAxis then ratchets rather than yanking
 * the view back), so it is not what this measures.
 *
 * Both window shapes, each to its own allowance (see ASPECTS): 16:9 is cut
 * for exactly and gets none, 21:9 carries the standing exception, pinned
 * so it cannot quietly grow.
 */
/** Distinct yaws: the rig turns in 15° steps and the grid is square, so a
 * quarter turn is every case there is. */
const TURNS = 6;
const ARROWS = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'];
/**
 * The two window shapes, and how far each is allowed past the grid.
 *
 * 16:9 is what the ring is cut for and gets none. 21:9 is the standing
 * exception and always has been: the frustum grows sideways with the
 * aspect while the zoom cap only bounds its height, so a wide enough
 * window always wins in the end and no ring short of the old 4x grid
 * covers every shape a monitor can be. What is pinned here is the SIZE of
 * that exception — about a tile at the largest maps, where it used to be
 * nearer two. Left unpinned it would be free to grow back.
 */
const ASPECTS = [
  { name: '16:9', w: 1600, h: 900, slack: 0 },
  { name: '21:9', w: 2560, h: 1080, slack: 2 },
];

const stubWindow = (): void => {
  vi.stubGlobal('window', Object.assign(new EventTarget(), { innerWidth: 1600, innerHeight: 900 }));
  vi.stubGlobal('document', Object.assign(new EventTarget(), { hidden: false }));
  vi.stubGlobal('location', { search: '' });
};

/** A rig on a window of the given shape, bounded to a play square of
 * `play` tiles sitting in its ring. */
const rigFor = (
  play: number,
  w: number,
  h: number,
): { rig: CameraRig; canvas: HTMLCanvasElement } => {
  const canvas = makeCanvas();
  Object.assign(canvas, { clientWidth: w, clientHeight: h });
  const rig = new CameraRig(canvas);
  rig.resize();
  const margin = marginFor(play);
  rig.setPlayBounds(margin, margin + play);
  return { rig, canvas };
};

/** Far more wheel than the cap allows, so the cap is what stops it. */
const zoomOut = (canvas: EventTarget): void => {
  for (let i = 0; i < 40; i++) wheel(canvas, 400, false);
};

describe('the frame never leaves the grid', () => {
  beforeEach(stubWindow);
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  for (const { name, w, h, slack } of ASPECTS) {
    for (const play of [MIN_MAP_SIZE, DEFAULT_MAP_SIZE, MAX_MAP_SIZE]) {
      it(`holds on a ${play}-tile valley at ${name}, every turn, every corner`, () => {
        const grid = gridFor(play);
        const quad = new Float64Array(8);
        for (let turn = 0; turn < TURNS; turn++) {
          // A rig apiece: the pan clamp ratchets, so a case must not inherit
          // where the last one left the camera.
          const { rig, canvas } = rigFor(play, w, h);
          for (let t = 0; t < turn; t++) wheel(canvas, 100, true);
          settle(rig);
          zoomOut(canvas);
          // Then lean on the pan in every direction. The clamps are per-axis
          // and hold what they have, so by the last one the camera is in the
          // corner of everything it is allowed to reach.
          for (const code of ARROWS) {
            hold(rig, code, 6);
            rig.viewQuad(quad);
            for (let i = 0; i < 8; i += 2) {
              const where = `play ${play}, ${name}, turn ${turn}, ${code}, corner ${i / 2}`;
              expect(quad[i], `x — ${where}`).toBeGreaterThanOrEqual(-slack);
              expect(quad[i], `x — ${where}`).toBeLessThanOrEqual(grid + slack);
              expect(quad[i + 1], `z — ${where}`).toBeGreaterThanOrEqual(-slack);
              expect(quad[i + 1], `z — ${where}`).toBeLessThanOrEqual(grid + slack);
            }
          }
          rig.dispose();
        }
      });
    }
  }
});

/**
 * The other side of the same cliff.
 *
 * VIEW_PAN_INSET decides how much of its own footprint the pan charges
 * against the play square, and MAX_VIEW_FRACTION how much world a frame
 * covers; between them they set how far the frame hangs past the boundary,
 * which is what the scenery ring is cut to fill. Both therefore want to go
 * up and in, which is the direction anyone reading `the frame never leaves
 * the grid` alone would be pushed — and that test never complains, because
 * a camera bolted to the middle of the map never leaves the grid at all.
 * This is what stands on the far side.
 *
 * What it pins is that the player can look at every part of their own
 * valley: every corner of the play square can be brought inside the frame,
 * at the zoom the game is played at, at some angle the camera can be
 * turned to. Three qualifications, each of them deliberate.
 *
 * At the working zoom, not at full zoom-out. The pan clamp charges the
 * frame's own footprint, so the further out the wheel goes the nearer the
 * middle the camera is held, and by the stop it holds station over the
 * centre with the map's corners outside a turned frame. That is the clamp
 * working, not failing — the arrangement Warcraft and StarCraft ship,
 * where the wheel does not survey and the minimap does.
 *
 * At some angle, not at every one. The frame is a rectangle the yaw has
 * turned over a square map, so it favours one diagonal; on a wide window
 * a corner can want the camera squared up before it comes in. Turning is
 * a thing the player has, and two notches of it is not a hardship.
 *
 * (An earlier version asserted the corners at full zoom-out, and so held
 * MAX_VIEW_FRACTION at 0.45 for a reason that was never a requirement.
 * Do not tighten it back without first deciding that surveying by wheel is
 * something the game promises.)
 */
describe('the whole valley can still be looked at', () => {
  /** Is a world point inside the view quad? The quad is a rectangle the yaw
   * has turned, so the cheap axis-aligned test would not do: a point is in
   * it when it lies on the inner side of all four edges, taken in order. */
  const inQuad = (q: Float64Array, x: number, z: number): boolean => {
    let sign = 0;
    for (let i = 0; i < 8; i += 2) {
      const ax = q[i]!;
      const az = q[i + 1]!;
      const bx = q[(i + 2) % 8]!;
      const bz = q[(i + 3) % 8]!;
      const cross = (bx - ax) * (z - az) - (bz - az) * (x - ax);
      if (Math.abs(cross) < 1e-9) continue;
      const s = Math.sign(cross);
      if (sign === 0) sign = s;
      else if (s !== sign) return false;
    }
    return true;
  };

  /**
   * Every way the pan can be leaned on from rest: each arrow alone, and
   * each pair of adjacent ones. The clamp box is axis-aligned and a long
   * enough hold always slams into it, so these eight reach every corner
   * and edge of it — which is every position the camera is allowed to
   * take. Exhaustive rather than aimed: working out which arrows lead
   * toward a point means a dot product against a measured heading, and on
   * the diagonals that quantity passes through zero, so noise picks an
   * arrow that undoes the other.
   */
  const LEANS: string[][] = [
    ['ArrowUp'],
    ['ArrowDown'],
    ['ArrowLeft'],
    ['ArrowRight'],
    ['ArrowUp', 'ArrowLeft'],
    ['ArrowUp', 'ArrowRight'],
    ['ArrowDown', 'ArrowLeft'],
    ['ArrowDown', 'ArrowRight'],
  ];

  /** Can the player bring this world point into frame at all, at this yaw? */
  const canReach = (
    play: number,
    w: number,
    h: number,
    turn: number,
    x: number,
    z: number,
  ): boolean => {
    const quad = new Float64Array(8);
    for (const lean of LEANS) {
      const { rig, canvas } = rigFor(play, w, h);
      for (let t = 0; t < turn; t++) wheel(canvas, 100, true);
      settle(rig);
      // No wheel: the boot view is where the game is played and where this
      // has to hold. Zoomed out the clamp holds the camera near the middle
      // by design, and the corners of a square map fall outside a turned
      // frame — see this block's own comment.
      holdAll(rig, lean, 4);
      rig.viewQuad(quad);
      const reached = inQuad(quad, x, z);
      rig.dispose();
      if (reached) return true;
    }
    return false;
  };

  const cornersOf = (play: number): [number, number][] => {
    const m = marginFor(play);
    return [
      [m, m],
      [m + play, m],
      [m, m + play],
      [m + play, m + play],
    ];
  };

  beforeEach(stubWindow);
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  for (const { name, w, h } of ASPECTS) {
    for (const play of [MIN_MAP_SIZE, DEFAULT_MAP_SIZE, MAX_MAP_SIZE]) {
      it(`reaches every corner of a ${play}-tile valley at ${name}`, () => {
        for (const [x, z] of cornersOf(play)) {
          const turns = [...Array(TURNS).keys()].filter((turn) => canReach(play, w, h, turn, x, z));
          expect(
            turns.length,
            `play ${play}, ${name}, corner ${x},${z} cannot be brought into frame at any turn`,
          ).toBeGreaterThan(0);
        }
      });
    }
  }
});
