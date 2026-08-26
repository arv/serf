import { describe, expect, it } from 'vitest';
import {
  boundary,
  capturePointer,
  commonAncestor,
  hoverAlias,
  relayable,
  slide,
} from './mouseCapture';

/**
 * The DOM half of mouse capture — the lock, the drawn sprite, the
 * re-dispatch — is browser plumbing, and this suite is headless. What it
 * checks is the arithmetic and the bookkeeping underneath: where a locked
 * mouse's movement is allowed to leave the cursor, which elements a
 * crossing has to be announced to, and what a hover rule looks like once
 * it belongs to us. Those are the parts that would be wrong quietly.
 */

describe('slide', () => {
  it('keeps the cursor inside the window', () => {
    // The whole point of capture: no arithmetic here can put the pointer
    // where the menu bar lives, because there is no such number.
    expect(slide(4, -40, 1000)).toBe(0);
    expect(slide(990, 40, 1000)).toBe(999);
  });

  it('travels one for one in between', () => {
    expect(slide(100, 25, 1000)).toBe(125);
    expect(slide(100, -25.5, 1000)).toBe(74.5);
  });

  it('survives a window with no room in it', () => {
    // A zero-width window is a resize mid-frame, not a real screen; the
    // clamp must still produce a number rather than a negative edge.
    expect(slide(10, 5, 0)).toBe(0);
  });
});

describe('commonAncestor', () => {
  const chain = ['button', 'card', 'ui', 'body', 'html'];

  it('finds where two chains meet', () => {
    expect(commonAncestor(chain, ['label', 'card', 'ui', 'body', 'html'])).toBe('card');
  });

  it('answers with the element itself when one contains the other', () => {
    expect(commonAncestor(['label', ...chain], chain)).toBe('button');
  });

  it('has no answer for chains with nothing in common', () => {
    // What a press that started over the map and released over nothing
    // hands the click: no shared ancestor, so no click target.
    expect(commonAncestor(chain, [])).toBe(null);
  });
});

describe('boundary', () => {
  it('says nothing about the part of the chain that did not change', () => {
    // Moving from a button to its label is still inside the card and the
    // HUD; a leave event for either would take a tooltip down that the
    // pointer never left.
    const { left, entered } = boundary(
      ['button', 'card', 'ui', 'html'],
      ['label', 'button', 'card', 'ui', 'html'],
    );
    expect(left).toEqual([]);
    expect(entered).toEqual(['label']);
  });

  it('unwinds to the shared ancestor and back down the other side', () => {
    const { left, entered } = boundary(
      ['icon', 'buildBtn', 'card', 'ui', 'html'],
      ['text', 'speedBtn', 'card', 'ui', 'html'],
    );
    // Left innermost first, entered outermost first — the order the DOM
    // fires leave and enter in, and the order the classes have to follow
    // so a hovered chain is never half-marked.
    expect(left).toEqual(['icon', 'buildBtn']);
    expect(entered).toEqual(['speedBtn', 'text']);
  });

  it('treats a crossing onto nothing as leaving everything', () => {
    // What a released lock does: the cursor stops existing, and every
    // element it was standing in has to hear about it.
    const { left, entered } = boundary(['button', 'card', 'ui', 'html'], []);
    expect(left).toEqual(['button', 'card', 'ui', 'html']);
    expect(entered).toEqual([]);
  });
});

describe('hoverAlias', () => {
  it('leaves rules that never hovered alone', () => {
    expect(hoverAlias('#ui .hud-tabs button')).toBe(null);
  });

  it('moves the hover onto the class we control', () => {
    expect(hoverAlias('#ui button:hover:not(:disabled)')).toBe(
      '#ui button.vhover:not(:disabled)',
    );
  });

  it('inverts with the rest of the selector', () => {
    // The HUD's touch neutralizers are written as :not(:hover); mirrored
    // any other way they would switch the styling back on for a captured
    // pointer standing still.
    expect(hoverAlias('#ui button:not(:hover)')).toBe('#ui button:not(.vhover)');
  });

  it('rewrites every branch of a selector list', () => {
    expect(hoverAlias('#ui .res.ledger:hover, #ui .res.chip:hover')).toBe(
      '#ui .res.ledger.vhover, #ui .res.chip.vhover',
    );
  });

  it('drops the branches that were not hovering', () => {
    // The HUD writes its active states this way. Copying the list whole
    // would restate `#ui button.active` at the very end of the document,
    // where it outranks the rules that were written to follow it — the
    // resting style would win over everything, hover or no hover.
    expect(hoverAlias('#ui button.active, #ui button.active:hover:not(:disabled)')).toBe(
      '#ui button.active.vhover:not(:disabled)',
    );
  });

  it('keeps a comma that belongs to the selector', () => {
    // :is() and attribute values carry their own commas, and splitting on
    // those would produce two halves of a selector, neither of them valid.
    expect(hoverAlias(':is(.a, .b):hover')).toBe(':is(.a, .b).vhover');
    expect(hoverAlias('[title="a,b"]:hover, .plain')).toBe('[title="a,b"].vhover');
  });
});

describe('relayable', () => {
  it('re-aims the press events of a locked mouse', () => {
    expect(relayable('pointerdown', 'mouse', 1)).toBe(true);
    expect(relayable('pointermove', 'mouse', 0)).toBe(true);
    // The plain MouseEvents name no device at all.
    expect(relayable('mouseup', null, 1)).toBe(true);
    expect(relayable('wheel', null, 0)).toBe(true);
  });

  it('re-aims a click whose pointerType the lock left blank', () => {
    // This is the whole bug: Chromium fires the click of a locked pointer
    // as a PointerEvent with no pointerType, and a router that asked for
    // 'mouse' dropped every one of them — leaving a HUD that highlighted
    // under the drawn cursor and did nothing at all when pressed.
    expect(relayable('click', '', 1)).toBe(true);
    expect(relayable('dblclick', '', 2)).toBe(true);
    expect(relayable('auxclick', '', 1)).toBe(true);
  });

  it('leaves a keyboard activation where it landed', () => {
    // Enter on a focused button: no pointer behind it, so aiming it at the
    // cursor would press whatever the cursor happened to be over.
    expect(relayable('click', '', 0)).toBe(false);
    expect(relayable('click', null, 0)).toBe(false);
  });

  it('leaves a finger and a pen their own coordinates', () => {
    // A laptop screen is still a screen while the mouse is locked.
    expect(relayable('pointerdown', 'touch', 1)).toBe(false);
    expect(relayable('click', 'pen', 1)).toBe(false);
  });
});

describe('capturePointer', () => {
  const mouse = { pointerId: 7, pointerType: 'mouse' } as PointerEvent;

  it('asks the platform while the pointer is still the platform’s', () => {
    const asked: number[] = [];
    const el = { setPointerCapture: (id: number) => void asked.push(id) } as unknown as Element;

    capturePointer(el, mouse);

    expect(asked).toEqual([7]);
  });

  it('lets a refusal go rather than taking the gesture down with it', () => {
    // Blink throws InvalidStateError from setPointerCapture for as long as
    // a pointer lock is engaged, which full screen now keeps for the whole
    // match. Every caller of this has a drag half-built when it asks, and
    // a capture is what a drag would like, never what it needs.
    const el = {
      setPointerCapture: () => {
        throw new DOMException('locked', 'InvalidStateError');
      },
    } as unknown as Element;

    expect(() => capturePointer(el, mouse)).not.toThrow();
  });
});
