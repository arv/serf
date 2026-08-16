import { Show } from 'solid-js';
import { hasKeyboard } from '../input/keyboard';

/**
 * A label with its keyboard shortcut taught inside it: **B**uild, We**l**l.
 *
 * Bolding the letter in place is the whole point. A trailing "(B)" is a
 * footnote the eye files under punctuation; the gold letter sitting in the
 * word is the word, so the shortcut is learned by reading the button you
 * were going to click anyway. Every letter this game hands out is chosen to
 * live in its own label (see BUILD_KEYS) — the parenthesised fallback below
 * exists for the odd label that cannot, not as a licence to skip the
 * choosing.
 *
 * Nothing renders without a keyboard. `hasKeyboard()` is a guess that only
 * ever upgrades (input/keyboard.ts), so a tablet that gains a Folio
 * mid-match grows its shortcuts on the first keypress rather than needing a
 * reload — and a phone is never told about keys it has no way to press.
 */
export function Key(props: { label: string; k: string }) {
  const at = (): number => props.label.toLowerCase().indexOf(props.k.toLowerCase());
  return (
    <Show when={hasKeyboard()} fallback={props.label}>
      <Show
        when={at() >= 0}
        fallback={
          <>
            {props.label} <span class="kbd">({props.k.toUpperCase()})</span>
          </>
        }
      >
        {props.label.slice(0, at())}
        <span class="kbd">{props.label.slice(at(), at() + 1)}</span>
        {props.label.slice(at() + 1)}
      </Show>
    </Show>
  );
}
