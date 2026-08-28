/**
 * sessionStorage and localStorage, for the handful of things the app
 * stashes across a reload: which save the GPU-loss rescue wrote, and how
 * many times in a row the browser has refused a WebGL context.
 *
 * Its own module because both halves of the boot path want it and they no
 * longer share one: main.ts reads the load handoff before it knows what
 * screen to build, and the match (matchScreen.ts) writes both from behind
 * a dynamic import.
 */

/**
 * Storage, tolerated: where site data is blocked, touching
 * sessionStorage/localStorage itself throws — and the boot path must not
 * die for a convenience stash (StartMenu and the stores wear the same
 * try/catch). A denied read is an absent stash; a denied write is a
 * handoff that doesn't survive, which every caller already tolerates.
 */
export function stashGet(kind: 'local' | 'session', key: string): string | null {
  try {
    return (kind === 'session' ? sessionStorage : localStorage).getItem(key);
  } catch {
    return null;
  }
}

/** @returns whether the write actually landed — a caller whose next move
 * depends on the stash surviving a reload (the gl-fails counter) must not
 * take that move on a stash that went nowhere. */
export function stashSet(kind: 'local' | 'session', key: string, value: string | null): boolean {
  try {
    const store = kind === 'session' ? sessionStorage : localStorage;
    if (value === null) store.removeItem(key);
    else store.setItem(key, value);
    return true;
  } catch {
    // Denied or full: the stash just doesn't happen.
    return false;
  }
}
