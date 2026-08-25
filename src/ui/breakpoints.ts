import { createSignal, onCleanup } from 'solid-js';

/**
 * The two shapes a hand-held screen comes in, and the one name for both.
 *
 * The HUD used to ask one question — "is this narrower than 760px?" — and
 * hang every phone adaptation off the answer: the safe-area insets, the
 * build card's fold, the one-thumb speed button, the tech tree's sheet.
 * That question has a wrong answer for half the phones in service. Held
 * sideways, an iPhone 15 is 932x430 and an iPhone 13 is 844x390: wider
 * than a small laptop window and shorter than a paperback. Every one of
 * those adaptations switched itself off at exactly the size that needed
 * them most, and the sheet that should have covered the screen rendered
 * 463px tall inside 390px of it.
 *
 * So there are two axes now. NARROW is a phone held upright, where things
 * stack. SHORT is a phone held sideways, where things must instead give up
 * height and scroll. COMPACT is either — "a phone, whichever way up" — and
 * it is what the insets, the sheets and the collapsible cards hang off,
 * because none of those care which way the screen is turned.
 */
export const NARROW = '(max-width: 760px)';
/**
 * 520px: the tallest phone landscape in service is 430 (iPhone 15 Pro Max),
 * and the shortest tablet landscape is 768 (iPad). The gap between those
 * two numbers is wide enough that the line can sit in the middle of it and
 * never be the reason a device lands on the wrong side. A desktop window
 * squashed this flat has the same problem and gets the same answer.
 */
const SHORT_MAX = 520;
export const SHORT = `(max-height: ${SHORT_MAX}px)`;
/** Either of the above — a media query list, which is legal in both a
 *  stylesheet's `@media` and matchMedia(). */
export const COMPACT = `${NARROW}, ${SHORT}`;
/**
 * NARROW minus the landscape phones that also match it — upright and only
 * upright. Most adaptations don't need the distinction, because the two
 * blocks are written in cascade order and SHORT simply overrides what
 * NARROW said. The bottom row does: stacked, it wants its controls at the
 * end of the row, and in a line it wants them at the start, and that is an
 * order in the markup rather than a rule in a stylesheet. Tied to the same
 * number SHORT is cut from, so the two can never drift into a gap no
 * screen answers to.
 */
export const UPRIGHT = `${NARROW} and (min-height: ${SHORT_MAX + 1}px)`;

/** Reactive media query (no dependency; one listener per call site). */
export function useMedia(query: string): () => boolean {
  const mq = window.matchMedia(query);
  const [matches, setMatches] = createSignal(mq.matches);
  const onChange = (e: MediaQueryListEvent): void => {
    setMatches(e.matches);
  };
  mq.addEventListener('change', onChange);
  onCleanup(() => mq.removeEventListener('change', onChange));
  return matches;
}
