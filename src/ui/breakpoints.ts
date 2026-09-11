import {createSignal, onCleanup} from 'solid-js';

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
export const SHORT = '(max-height: 520px)';
/** Either of the above — a media query list, which is legal in both a
 *  stylesheet's `@media` and matchMedia(). */
export const COMPACT = `${NARROW}, ${SHORT}`;
/**
 * COMPACT's complement: not a phone, whichever way up — a tablet, a laptop,
 * a desktop. What it buys is the promise that both dimensions are roomy at
 * once, which is what a layout may assume before it stops letting the page
 * scroll and starts fitting itself to the window instead.
 *
 * A window in the half-pixel between the pairs — 760.4 wide, 520.5 tall,
 * which a browser zoom can produce — matches neither this nor COMPACT, and
 * that is deliberate. Rules written against this one are refinements the
 * phone layouts have their own answer for, so falling down the crack costs
 * the refinement and never the layout.
 */
export const ROOMY = '(min-width: 761px) and (min-height: 521px)';

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
