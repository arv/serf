import {crc32, deflateSync} from 'node:zlib';
import {describe, expect, it} from 'vitest';
import {cropCorner, decodePng, encodePng, type Raster} from './png.ts';

/** A PNG encoded with one chosen filter on every row. The library encodes
 * with Paeth only, so round-tripping its own output would never exercise
 * the other four un-filter branches — which are exactly the ones Chromium
 * picks from and the ones a mistake would be silent in. */
function pngWithFilter(
  {width, height, channels, pixels}: Raster,
  filter: number,
): Buffer {
  const paeth = (a: number, b: number, c: number) => {
    const p = a + b - c;
    const [pa, pb, pc] = [Math.abs(p - a), Math.abs(p - b), Math.abs(p - c)];
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
  };
  const stride = width * channels;
  const out = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    out[y * (stride + 1)] = filter;
    for (let x = 0; x < stride; x++) {
      const left = x >= channels ? pixels[y * stride + x - channels]! : 0;
      const up = y > 0 ? pixels[(y - 1) * stride + x]! : 0;
      const upLeft =
        x >= channels && y > 0 ? pixels[(y - 1) * stride + x - channels]! : 0;
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
      out[y * (stride + 1) + 1 + x] =
        (pixels[y * stride + x]! - predicted) & 255;
    }
  }
  const chunk = (type: string, data: Buffer) => {
    const o = Buffer.alloc(data.length + 12);
    o.writeUInt32BE(data.length, 0);
    o.write(type, 4, 'latin1');
    data.copy(o, 8);
    o.writeUInt32BE(crc32(o.subarray(4, 8 + data.length)), 8 + data.length);
    return o;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.writeUInt8(8, 8);
  header.writeUInt8(
    channels === 4 ? 6 : channels === 3 ? 2 : channels === 2 ? 4 : 0,
    9,
  );
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(out)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** A gradient with a hard edge in it: smooth enough that a filter has
 * something to predict, and discontinuous enough that predicting it wrong
 * shows up rather than averaging away. */
function fixture(width: number, height: number, channels: number): Raster {
  const pixels = Buffer.alloc(width * height * channels);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      for (let c = 0; c < channels; c++) {
        pixels[(y * width + x) * channels + c] =
          (x * 7 + y * 13 + c * 61 + (x > width / 2 ? 128 : 0)) & 255;
      }
    }
  }
  return {width, height, channels, pixels};
}

const at = (r: Raster, x: number, y: number) => [
  ...r.pixels.subarray(
    (y * r.width + x) * r.channels,
    (y * r.width + x + 1) * r.channels,
  ),
];

describe('decodePng', () => {
  it.each([0, 1, 2, 3, 4])('un-filters a row filtered with type %i', filter => {
    const source = fixture(23, 17, 4);
    const decoded = decodePng(pngWithFilter(source, filter));
    expect(decoded.width).toBe(23);
    expect(decoded.height).toBe(17);
    expect(decoded.pixels.equals(source.pixels)).toBe(true);
  });

  it.each([
    ['grey', 1],
    ['grey and alpha', 2],
    ['RGB', 3],
    ['RGBA', 4],
  ])('reads %s', (_name, channels) => {
    const source = fixture(9, 6, channels);
    const decoded = decodePng(pngWithFilter(source, 4));
    expect(decoded.channels).toBe(channels);
    expect(decoded.pixels.equals(source.pixels)).toBe(true);
  });

  it('refuses what it cannot read rather than guessing', () => {
    expect(() => decodePng(Buffer.alloc(64))).toThrow(/not a PNG/);
  });
});

describe('encodePng', () => {
  it('round-trips through its own decoder', () => {
    const source = fixture(31, 12, 4);
    expect(decodePng(encodePng(source)).pixels.equals(source.pixels)).toBe(
      true,
    );
  });
});

describe('cropCorner', () => {
  // The screenshot is the whole window and the icon is drawn in the corner
  // of it, so this is the one operation standing between Chromium and the
  // committed assets.
  it.each([0, 1, 2, 3, 4])('takes the corner out of a type %i PNG', filter => {
    const source = fixture(40, 60, 4);
    const cropped = decodePng(cropCorner(pngWithFilter(source, filter), 24));
    expect([cropped.width, cropped.height]).toEqual([24, 24]);
    for (const [x, y] of [
      [0, 0],
      [23, 0],
      [0, 23],
      [23, 23],
      [11, 7],
    ]) {
      expect(at(cropped, x!, y!)).toEqual(at(source, x!, y!));
    }
  });

  it('keeps the corner, not a scaled-down whole', () => {
    // The far side of the window must not appear anywhere in the crop.
    const source = fixture(40, 40, 4);
    const cropped = decodePng(cropCorner(encodePng(source), 10));
    expect(at(cropped, 9, 9)).toEqual(at(source, 9, 9));
    expect(at(cropped, 9, 9)).not.toEqual(at(source, 39, 39));
  });

  it('refuses a crop the screenshot cannot cover', () => {
    expect(() => cropCorner(encodePng(fixture(16, 16, 4)), 32)).toThrow(
      /no 32px corner/,
    );
  });
});
