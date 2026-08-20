import { Match, Show, Switch } from 'solid-js';
import { hasKeyboard } from '../input/keyboard';
import { shortcutLabel } from './shortcutLabel';

/**
 * A label with its keyboard shortcut taught inside it: **B**uild, We**l**l.
 *
 * Bolding the letter in place is the whole point. A trailing "(B)" is a
 * footnote the eye files under punctuation; the gold letter sitting in the
 * word is the word, so the shortcut is learned by reading the button you
 * were going to click anyway. Every letter this game hands out is chosen to
 * live in its own label (see BUILD_KEYS, TRAIN_KEYS) — the parenthesised
 * fallback exists for the odd label that cannot, not as a licence to skip
 * the choosing.
 *
 * Nothing renders without a keyboard. `hasKeyboard()` is a guess that only
 * ever upgrades (input/keyboard.ts), so a tablet that gains a Folio
 * mid-match grows its shortcuts on the first keypress rather than needing a
 * reload — and a phone is never told about keys it has no way to press.
 *
 * Where the letter goes is shortcutLabel's decision, and lives apart so it
 * can be tested headlessly.
 *
 * The whole label rides in one wrapper span, and it has to: most of these
 * buttons are flex containers, and a flex container turns each loose text
 * node into an anonymous item whose leading and trailing whitespace is
 * trimmed. Emitted bare, "Guard " + T + "ower" lost the space and read as
 * "GuardTower" — and any label whose letter opens a later word would have
 * hit the same thing. Inside one span it is ordinary inline text again.
 */
export function Key(props: { label: string; k: string }) {
  const parts = () => shortcutLabel(props.label, props.k);
  return (
    <Show when={hasKeyboard()} fallback={props.label}>
      <Switch fallback={props.label}>
        <Match when={parts().kind === 'appended'}>
          <span>
            {props.label} <span class="kbd">({(parts() as { key: string }).key})</span>
          </span>
        </Match>
        <Match when={parts().kind === 'split'}>
          <span>
            {(parts() as { before: string }).before}
            <span class="kbd">{(parts() as { letter: string }).letter}</span>
            {(parts() as { after: string }).after}
          </span>
        </Match>
      </Switch>
    </Show>
  );
}
