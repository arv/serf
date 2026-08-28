/**
 * Typed arrays to base64 and back, for formats that carry grids through
 * JSON — the map file's tiles (src/sim/mapFile.ts) and the world save's
 * (src/sim/save.ts). Multi-byte elements are little-endian, spelled out
 * rather than taken from the host: a save written on one machine is read
 * on another, and `new Int16Array(buffer)` would quietly mean two
 * different files on two different CPUs.
 *
 * `Uint8Array.fromBase64` / `Uint8Array.prototype.toBase64` are the real
 * answer: no intermediate binary string, and encoding a megabyte no longer
 * means a megabyte of `String.fromCharCode`. They are used wherever they
 * exist — every current browser, and node from 25 (V8 14.1). The
 * `btoa`/`atob` path behind the check is for the runtimes that are one V8
 * short: node 24, which is what CI and the relay server run. When node 25
 * is the floor, the fallback (and this comment) can go.
 */

/** Chunked so the fallback's `fromCharCode` never sees an argument list
 * long enough to blow the stack — a map's height grid is ~74 K bytes. */
const CHUNK = 0x8000;

export function bytesToBase64(bytes: Uint8Array): string {
  if (typeof bytes.toBase64 === 'function') return bytes.toBase64();
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/** Throws (SyntaxError from the native decoder, DOMException from `atob`)
 * on anything that is not base64 — callers that read untrusted documents
 * catch and report in their own vocabulary. */
export function bytesFromBase64(text: string): Uint8Array {
  if (typeof Uint8Array.fromBase64 === 'function')
    return Uint8Array.fromBase64(text);
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function int16ToBase64(values: Int16Array): string {
  const bytes = new Uint8Array(values.length * 2);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < values.length; i++)
    view.setInt16(i * 2, values[i]!, true);
  return bytesToBase64(bytes);
}

/** A trailing odd byte is dropped rather than guessed at; callers check the
 * count they expected. Throws on text that is not base64, as above. */
export function int16FromBase64(text: string): Int16Array {
  const bytes = bytesFromBase64(text);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const values = new Int16Array(bytes.length >> 1);
  for (let i = 0; i < values.length; i++)
    values[i] = view.getInt16(i * 2, true);
  return values;
}

export function float32ToBase64(values: Float32Array): string {
  const bytes = new Uint8Array(values.length * 4);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < values.length; i++)
    view.setFloat32(i * 4, values[i]!, true);
  return bytesToBase64(bytes);
}

/** Trailing bytes short of a whole float are dropped; see int16FromBase64. */
export function float32FromBase64(text: string): Float32Array {
  const bytes = bytesFromBase64(text);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const values = new Float32Array(bytes.length >> 2);
  for (let i = 0; i < values.length; i++)
    values[i] = view.getFloat32(i * 4, true);
  return values;
}
