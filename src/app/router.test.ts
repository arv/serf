import {describe, expect, it} from 'vitest';

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

/** A hand-copy of main.ts's list: this file tests the rule, not the
 * module — importing main.ts would boot the app. Keep the two in step;
 * a param missing here is a launch the rule below sends to the menu. */
const LAUNCH_PARAMS = [
  'mp',
  'ai',
  'players',
  'seed',
  'size',
  'skipMenu',
  'mission',
  'replay',
  'rewatch',
  'uploaded',
  'load',
];

/** The rule under test, over a URL rather than `location` — the same
 * expression main.ts routes on. The path comes first there for the two
 * screens named by one, so it comes first here. */
function screenKey(
  search: string,
  loadPending = false,
  pathname = '/',
): string {
  if (pathname === '/docs' || pathname.startsWith('/docs/')) return 'docs';
  if (pathname === '/all-replays') return 'all-replays';
  const params = new URLSearchParams(search);
  const chosen = LAUNCH_PARAMS.some(k => params.has(k)) || loadPending;
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
    expect(screenKey('?mission=first-camp')).not.toBe(
      screenKey('?mission=the-raid'),
    );
    expect(screenKey('?replay=a.json')).not.toBe(screenKey('?replay=b.json'));
  });

  it('names the end card’s rewatch a match, not the menu', () => {
    // ?rewatch carries no value — the scratch slot holds one recording —
    // so the rule has to read it as a launch by its presence alone, or
    // "Watch replay" would land back on the start screen.
    expect(screenKey('?rewatch')).toBe('match:?rewatch');
    expect(screenKey('?rewatch')).not.toBe(screenKey(''));
    // And it is its own screen: a rewatch asked for while a replay from
    // the shelf is playing is a different recording.
    expect(screenKey('?rewatch')).not.toBe(screenKey('?replay=a.json'));
  });

  it('names an uploaded replay a match of its own', () => {
    // A recording fetched from the server is a launch like any other, and
    // one id is not another: without the param in the list, a link to the
    // shelf's "Watch" would land on the start screen.
    expect(screenKey('?uploaded=20260101-000000000-abcdef')).toBe(
      'match:?uploaded=20260101-000000000-abcdef',
    );
    expect(screenKey('?uploaded=a')).not.toBe(screenKey('?uploaded=b'));
    // A match's key is its whole query string, so the shelf's ?key= riding
    // along makes a screen of its own — harmless, since the two URLs are
    // only ever arrived at one at a time.
    expect(screenKey('?uploaded=a&key=s')).not.toBe(screenKey('?uploaded=a'));
  });

  it('lets the two path-named screens win over the query', () => {
    // The shelf and the field guide are places a link points at. A launch
    // param left in the query — or the ?key= the shelf itself carries —
    // must not turn either of them into a match.
    expect(screenKey('', false, '/all-replays')).toBe('all-replays');
    expect(screenKey('?key=s3cret', false, '/all-replays')).toBe('all-replays');
    expect(screenKey('?ai=2', false, '/all-replays')).toBe('all-replays');
    expect(screenKey('?ai=2', true, '/docs')).toBe('docs');
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
