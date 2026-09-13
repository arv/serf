/**
 * Just enough PNG to take the corner out of a screenshot.
 *
 * Headless Chromium screenshots the whole window it is given, so an icon
 * drawn in the corner of one arrives with the rest of the window attached
 * (render.ts says why it has to be drawn that way). Cutting it out means
 * going through the format: a PNG stores each scanline as a difference
 * from the row above and the pixel to the left, so there is no addressing
 * a rectangle without undoing that first.
 *
 * Which is all this does — inflate, un-filter to flat pixels, take the
 * corner, filter and deflate again. Paeth on the way out because these are
 * gradients, which it predicts about as well as anything and far better
 * than storing them raw. Only what Chromium actually emits is supported:
 * eight bits a channel, no interlacing.
 */

import {crc32, deflateSync, inflateSync} from 'node:zlib';

const MAGIC = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

/** Channels per pixel, by PNG color type. 3 is palette, which is one byte
 * an index — unpacking it needs the palette, and Chromium never sends it. */
const CHANNELS: Record<number, number> = {0: 1, 2: 3, 4: 2, 6: 4};

export interface Raster {
  width: number;
  height: number;
  /** Bytes per pixel: 1 grey, 2 grey+alpha, 3 RGB, 4 RGBA. */
  channels: number;
  /** `width * height * channels` bytes, row major, no filter bytes. */
  pixels: Buffer;
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

function chunk(type: string, data: Buffer): Buffer {
  const out = Buffer.alloc(data.length + 12);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'latin1');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

export function decodePng(png: Buffer): Raster {
  if (!png.subarray(0, 8).equals(MAGIC)) throw new Error('not a PNG');
  let header: Buffer | null = null;
  const parts: Buffer[] = [];
  for (let i = 8; i + 8 <= png.length;) {
    const length = png.readUInt32BE(i);
    const type = png.toString('latin1', i + 4, i + 8);
    const body = png.subarray(i + 8, i + 8 + length);
    if (type === 'IHDR') header = body;
    else if (type === 'IDAT') parts.push(body);
    i += length + 12;
  }
  if (header === null) throw new Error('PNG has no IHDR');
  const width = header.readUInt32BE(0);
  const height = header.readUInt32BE(4);
  if (header.readUInt8(8) !== 8) throw new Error('PNG is not 8 bits a channel');
  const channels = CHANNELS[header.readUInt8(9)];
  if (channels === undefined) {
    throw new Error(`PNG color type ${header.readUInt8(9)} is not supported`);
  }
  if (header.readUInt8(12) !== 0) throw new Error('PNG is interlaced');

  const packed = inflateSync(Buffer.concat(parts));
  const stride = width * channels;
  if (packed.length < height * (stride + 1))
    throw new Error('PNG is truncated');
  const pixels = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = packed[y * (stride + 1)];
    const row = y * stride;
    const above = row - stride;
    for (let x = 0; x < stride; x++) {
      const left = x >= channels ? pixels[row + x - channels]! : 0;
      const up = y > 0 ? pixels[above + x]! : 0;
      const upLeft = x >= channels && y > 0 ? pixels[above + x - channels]! : 0;
      const stored = packed[y * (stride + 1) + 1 + x]!;
      const predicted =
        filter === 1
          ? left
          : filter === 2
            ? up
            : filter === 3
              ? (left + up) >> 1
              : filter === 4
                ? paeth(left, up, upLeft)
                : 0;
      pixels[row + x] = (stored + predicted) & 255;
    }
  }
  return {width, height, channels, pixels};
}

export function encodePng({width, height, channels, pixels}: Raster): Buffer {
  const stride = width * channels;
  const filtered = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    const row = y * (stride + 1);
    filtered[row] = 4;
    for (let x = 0; x < stride; x++) {
      const left = x >= channels ? pixels[y * stride + x - channels]! : 0;
      const up = y > 0 ? pixels[(y - 1) * stride + x]! : 0;
      const upLeft =
        x >= channels && y > 0 ? pixels[(y - 1) * stride + x - channels]! : 0;
      filtered[row + 1 + x] =
        (pixels[y * stride + x]! - paeth(left, up, upLeft)) & 255;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.writeUInt8(8, 8);
  header.writeUInt8(
    channels === 4 ? 6 : channels === 3 ? 2 : channels === 2 ? 4 : 0,
    9,
  );
  return Buffer.concat([
    MAGIC,
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(filtered, {level: 9})),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** The top-left `edge` by `edge` square of `png`, as a PNG. */
export function cropCorner(png: Buffer, edge: number): Buffer {
  const {width, height, channels, pixels} = decodePng(png);
  if (edge > width || edge > height) {
    throw new Error(`a ${width}x${height} PNG has no ${edge}px corner`);
  }
  const stride = width * channels;
  const cropped = Buffer.alloc(edge * edge * channels);
  for (let y = 0; y < edge; y++) {
    pixels.copy(
      cropped,
      y * edge * channels,
      y * stride,
      y * stride + edge * channels,
    );
  }
  return encodePng({width: edge, height: edge, channels, pixels: cropped});
}
