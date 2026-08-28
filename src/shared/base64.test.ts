import {describe, expect, it} from 'vitest';
import {
  bytesFromBase64,
  bytesToBase64,
  float32FromBase64,
  float32ToBase64,
  int16FromBase64,
  int16ToBase64,
} from './base64.ts';

describe('base64', () => {
  it('round-trips bytes', () => {
    for (const bytes of [
      new Uint8Array(0),
      Uint8Array.of(0),
      Uint8Array.of(1, 2, 3), // 4 chars, no padding
      Uint8Array.of(255, 254), // one pad char
      Uint8Array.of(0, 128, 255, 1, 2), // two
    ]) {
      expect(bytesFromBase64(bytesToBase64(bytes))).toEqual(bytes);
    }
  });

  it('agrees with the canonical alphabet and padding', () => {
    expect(bytesToBase64(Uint8Array.of(1, 2, 3))).toBe('AQID');
    expect(bytesToBase64(Uint8Array.of(255, 255))).toBe('//8=');
    expect([...bytesFromBase64('//8=')]).toEqual([255, 255]);
  });

  it('carries a grid larger than one chunk', () => {
    // 0x8000 is the fallback's chunk size; cross it, and every byte value.
    const bytes = new Uint8Array(0x8000 * 2 + 7);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 7) & 0xff;
    expect(bytesFromBase64(bytesToBase64(bytes))).toEqual(bytes);
  });

  it('encodes a view without dragging in the rest of the buffer', () => {
    const whole = Uint8Array.of(9, 9, 1, 2, 3, 9);
    expect(bytesToBase64(whole.subarray(2, 5))).toBe('AQID');
  });

  it('throws on text that is not base64', () => {
    expect(() => bytesFromBase64('~~ not base64 ~~')).toThrow();
  });
});

describe('base64 typed arrays', () => {
  it('round-trips int16, sign and all', () => {
    const values = Int16Array.of(0, 1, -1, 32767, -32768, 4700, -1600);
    expect(int16FromBase64(int16ToBase64(values))).toEqual(values);
  });

  it('round-trips float32 exactly — a save resumes on these numbers', () => {
    const values = Float32Array.of(
      0,
      -0,
      1 / 3,
      -1e-8,
      3.4e38,
      Math.fround(0.30000001192092896),
    );
    expect(float32FromBase64(float32ToBase64(values))).toEqual(values);
  });

  it('is little-endian on the wire, whatever the host is', () => {
    // 0x0102 low byte first; 1.0f is 00 00 80 3f.
    expect(int16ToBase64(Int16Array.of(0x0102))).toBe(
      bytesToBase64(Uint8Array.of(0x02, 0x01)),
    );
    expect(float32ToBase64(Float32Array.of(1))).toBe(
      bytesToBase64(Uint8Array.of(0x00, 0x00, 0x80, 0x3f)),
    );
  });

  it('drops a trailing partial element rather than guessing', () => {
    expect(int16FromBase64(bytesToBase64(Uint8Array.of(1, 0, 9))).length).toBe(
      1,
    );
    expect(
      float32FromBase64(bytesToBase64(Uint8Array.of(1, 2, 3))).length,
    ).toBe(0);
  });
});
