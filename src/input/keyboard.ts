import { createSignal } from 'solid-js';

// Same escalation as ui/store.ts: a module-level signal cannot survive a
// hot swap — importers keep reading the old module's signal while the
// listener below writes the new one's.
if (import.meta.hot) {
  import.meta.hot.accept(() => import.meta.hot?.invalidate());
}

/**
 * Whether a physical keyboard is (near-certainly) present.
 *
 * The web platform cannot be asked directly — the Keyboard API describes
 * layouts, not presence, and WebHID blocklists keyboards outright — so
 * this is a guess with an upgrade path:
 *
 * - The opening guess reads `(any-pointer: fine)`: a mouse or trackpad
 *   all but always travels with a keyboard, a coarse-only device usually
 *   goes without.
 * - The first keydown that cannot have come from an on-screen keyboard
 *   proves one and flips this true for good. On-screen keyboards only
 *   type into editable fields (and Android's reports `Unidentified`
 *   keys), so a named key arriving anywhere else must be hardware. This
 *   is what catches the iPad whose attached keyboard no media query can
 *   see.
 *
 * Presence can be proven; absence never can — a keyboard may simply not
 * have been touched yet. So anything hidden behind this must stay
 * reachable another way (the ✕ button retires because Esc exists, the
 * lasso because the trackpad drags a band), and a false stays false for
 * the session rather than flickering on a guess.
 */
const [hasKeyboard, setHasKeyboard] = createSignal(
  window.matchMedia('(any-pointer: fine)').matches,
);
export { hasKeyboard };

/** On-screen keyboards type here; keys landing anywhere else are hardware. */
function editable(t: EventTarget | null): boolean {
  return (
    t instanceof HTMLInputElement ||
    t instanceof HTMLTextAreaElement ||
    (t instanceof HTMLElement && t.isContentEditable)
  );
}

if (!hasKeyboard()) {
  const confirm = (e: KeyboardEvent): void => {
    // isComposing rules out IME steps, 'Unidentified' the Android OSK.
    if (!e.isTrusted || e.isComposing || e.key === 'Unidentified' || editable(e.target)) return;
    setHasKeyboard(true);
    window.removeEventListener('keydown', confirm);
  };
  window.addEventListener('keydown', confirm);
}
