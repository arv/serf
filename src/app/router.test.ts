import { describe, expect, it } from 'vitest';

/**
 * The router itself is DOM plumbing (a Navigation API listener, or
 * pushState and popstate) and is exercised in a browser. What is checked
 * here is the rule it exists to serve: which URLs name the same screen.
 *
 * That rule carries the whole design. Every screen change now happens in
 * one document, so a navigation is no longer self-evidently a fresh start —
 * and the menu moves its own address bar constantly, writing the room code
 * in as the relay names it. Both pushState and replaceState arrive at the
 * router as navigations, so without this the council would tear itself down
 * and rebuild the moment it learned its own code.
 */

const LAUNCH_PARAMS = ['mp', 'ai', 'players', 'seed', 'skipMenu', 'mission', 'replay'];

/** The rule under test, over a URL rather than `location` — the same
 * expression main.ts routes on. */
function screenKey(search: string, loadPending = false): string {
  const params = new URLSearchParams(search);
  const chosen = LAUNCH_PARAMS.some((k) => params.has(k)) || loadPending;
  if (!chosen || params.get('mp') !== null) return 'menu';
  return `match:${search}`;
}

describe('which screen a URL names', () => {
  it('sends a bare URL to the menu', () => {
    expect(screenKey('')).toBe('menu');
  });

  it('keeps the council on the menu, room code and all', () => {
    // The council is a menu screen whose URL moves under it. If these
    // parted ways, naming the room would unmount the room.
    expect(screenKey('?mp=ABCD')).toBe('menu');
    expect(screenKey('?mp=ABCD')).toBe(screenKey('?mp=WXYZ'));
    expect(screenKey('?mp=ABCD&open=0')).toBe(screenKey(''));
  });

  it('treats every launch as its own screen', () => {
    expect(screenKey('?ai=2&seed=1')).toBe('match:?ai=2&seed=1');
    expect(screenKey('?mission=first-camp')).not.toBe(screenKey('?mission=the-raid'));
    expect(screenKey('?replay=a.json')).not.toBe(screenKey('?replay=b.json'));
  });

  it('parts a match from the menu', () => {
    expect(screenKey('?ai=2')).not.toBe(screenKey(''));
  });

  it('reads a pending save as a launch', () => {
    // Load save stashes the world and navigates; the URL it lands on is a
    // match even before its parameters say so.
    expect(screenKey('', true)).toBe('match:');
    expect(screenKey('', false)).toBe('menu');
  });

  it('calls the same match the same screen', () => {
    // What makes routing idempotent: arriving at the URL already showing
    // is not a reason to rebuild a world. Play again asks for that
    // explicitly instead (goto's `force`), which is why it cannot be
    // inferred from the URL.
    expect(screenKey('?ai=2&seed=1')).toBe(screenKey('?ai=2&seed=1'));
  });
});
