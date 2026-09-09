import {describe, expect, it} from 'vitest';
import {MAX_CHAT_CHARS, sanitizeChatText} from './chat';

/**
 * The chat sanitizer is the trust boundary for what a seat may say: the
 * relay runs it on every message before echoing it to the table, and the
 * client runs it before sending.
 */
describe('sanitizeChatText', () => {
  it('passes an ordinary line through untouched', () => {
    expect(sanitizeChatText('Raid on the east road!')).toBe(
      'Raid on the east road!',
    );
  });

  it('refuses anything that is not a string', () => {
    expect(sanitizeChatText(undefined)).toBeNull();
    expect(sanitizeChatText(42)).toBeNull();
    expect(sanitizeChatText({text: 'hi'})).toBeNull();
  });

  it('refuses a message with nothing to say', () => {
    expect(sanitizeChatText('')).toBeNull();
    expect(sanitizeChatText('   \n\t ')).toBeNull();
  });

  it('collapses newlines, tabs and control characters into one line', () => {
    expect(sanitizeChatText('  one\ntwo\t\tthree\u0007four  ')).toBe(
      'one two three four',
    );
  });

  it('does bounded work on a payload far past the cap', () => {
    // A megabyte of text is cut before the regex and the code-point walk
    // ever see it; what comes out is still exactly the cap.
    const huge = 'x'.repeat(1 << 20);
    expect(sanitizeChatText(huge)).toHaveLength(MAX_CHAT_CHARS);
  });

  it('caps at MAX_CHAT_CHARS without splitting a surrogate pair', () => {
    const long = 'a'.repeat(MAX_CHAT_CHARS + 20);
    expect(sanitizeChatText(long)).toHaveLength(MAX_CHAT_CHARS);
    // An astral character at the cut: the cap counts code points, so the
    // last character kept is the whole castle, not its leading surrogate.
    const castle = '\u{1F3F0}';
    const out = sanitizeChatText(castle.repeat(MAX_CHAT_CHARS + 1))!;
    expect(Array.from(out)).toHaveLength(MAX_CHAT_CHARS);
    expect(out.endsWith(castle)).toBe(true);
  });
});
