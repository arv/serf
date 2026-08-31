import {describe as it_describes, expect, it} from 'vitest';
import {describe as describeDetail} from './viewer.ts';

it_describes('the error box printer', () => {
  it('never throws on a value that defeats a printer', () => {
    const circular: {self?: unknown} = {};
    circular.self = circular;
    // JSON.stringify throws on the first two, String on the last two.
    const nasty: unknown[] = [
      circular,
      1n,
      Object.create(null),
      {
        toString() {
          throw new Error('no');
        },
      },
    ];
    for (const detail of nasty) {
      expect(() => describeDetail(detail)).not.toThrow();
      expect(describeDetail(detail)).toBeTypeOf('string');
    }
  });

  it('still says what it can for the values that print', () => {
    expect(describeDetail(new Error('the pack is missing'))).toBe(
      'the pack is missing',
    );
    expect(describeDetail('a plain string')).toBe('a plain string');
    expect(describeDetail({code: 404})).toBe('{"code":404}');
    // JSON.stringify yields undefined here; String is the fallback.
    expect(describeDetail(() => {})).toBe('() => {}');
  });
});
