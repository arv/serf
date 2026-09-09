/**
 * In-match chat — the one line a seat may say to the table. Dependency-free
 * like lobby.ts so the relay, the client and vitest all load it as-is.
 *
 * The text rides the match socket as a string frame ({t:'chat'}) and comes
 * back to every connected seat, the sender included, stamped with the seat
 * it came from. The server never trusts the text off the wire — it passes
 * through sanitizeChatText there — and the client runs the same gate before
 * sending, so a pasted essay is cut on the keyboard that typed it rather
 * than dropped in silence a round trip later.
 */

/** Cap on one message, in code points. One toast's worth: long enough for
 * a sentence about the raid on the east road, short enough that a message
 * never grows into a panel that hides the map. */
export const MAX_CHAT_CHARS = 200;

/**
 * How much of the raw string is even looked at, in UTF-16 units. The
 * relay runs the sanitizer on whatever a socket sends, and the work below
 * (a regex pass, then a walk of the code points) is linear in what it is
 * given — so a megabyte of payload is cut here first, to a bound that any
 * message worth MAX_CHAT_CHARS still fits inside with room for the
 * whitespace the collapse then removes.
 */
const RAW_BOUND = MAX_CHAT_CHARS * 8;

/**
 * Trim a message to what a toast can show: one line, no control characters,
 * at most MAX_CHAT_CHARS. Null when nothing is left to say — a message of
 * spaces is not a message, and neither is something that is not a string.
 */
export function sanitizeChatText(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const bounded = raw.length > RAW_BOUND ? raw.slice(0, RAW_BOUND) : raw;
  // Control characters, newlines among them, become spaces: a toast is a
  // single line, and a pasted paragraph reads better collapsed than
  // rendered as one word per line. Runs collapse too, for the same reason.
  const text = bounded.replace(/[\p{Cc}\s]+/gu, ' ').trim();
  if (text.length === 0) return null;
  // Code points rather than UTF-16 units, so the cap never splits a
  // surrogate pair and ships half an emoji.
  const points = Array.from(text);
  return points.length > MAX_CHAT_CHARS
    ? points.slice(0, MAX_CHAT_CHARS).join('')
    : text;
}
