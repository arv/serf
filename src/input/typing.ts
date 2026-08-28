/**
 * Whether a key event is going somewhere that wants the key itself.
 *
 * Two layers bind bare keys to the game — Controls for the orders and the
 * build chord, CameraRig for the directions — and both sit on the window,
 * where every keystroke on the page passes whether or not the map is what
 * the player is looking at. A map's name being typed in the editor, the
 * HUD's volume slider taking an arrow, a `select` being walked with the
 * letter row: in each case the key is already spoken for, and answering it
 * a second time is how a rename turns the camera.
 *
 * One module rather than a copy in each, because a copy is a thing that
 * drifts — and the comment claiming the two matched is what a reviewer
 * caught being wrong once already.
 *
 * Duck-typed, not `instanceof`. The DOM constructors are globals, and
 * naming one is enough to throw wherever it is absent — a headless test
 * of the rig, an SSR pass, a worker. The tag name is on the element
 * either way, and a check that cannot throw is worth more here than one
 * that is stricter about elements from another realm.
 */
export function typingInto(target: EventTarget | null | undefined): boolean {
  const el = target as
    | {tagName?: unknown; isContentEditable?: unknown}
    | null
    | undefined;
  if (!el || typeof el.tagName !== 'string') return false;
  if (el.isContentEditable === true) return true;
  const tag = el.tagName.toUpperCase();
  // `select` is here for the same reason as the other two: focused, it
  // answers to the arrows and to the letter row itself.
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

/**
 * Whether a chord belongs to the browser or the OS rather than to us —
 * ⌘[ is Back, ⌥← is a word, ⌘M minimises. Shift is deliberately not in
 * here: it modifies bindings of ours (the wheel turn) rather than lifting
 * them away, and a field taking Shift+Arrow is already covered by
 * typingInto.
 *
 * Ctrl is the caller's business. The rig has nothing on it and treats it
 * as foreign; Controls keeps Ctrl+1…0 for the control groups, the way
 * StarCraft does on every platform it ships on.
 */
export function foreignChord(e: KeyboardEvent): boolean {
  return e.metaKey || e.altKey || e.isComposing;
}
