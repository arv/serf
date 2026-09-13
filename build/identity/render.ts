/**
 * Bakes every channel's icons from its one source.
 *
 *   pnpm icons
 *
 * Stable is drawn as an SVG (stable/icon.svg) and staging composites its
 * band over stable's 512 (staging/icon.html), so the channels are baked in
 * that order and re-baking stable is what re-bakes staging.
 *
 * Headless Chromium will not do either of the two obvious things here, and
 * both refusals are quiet — you get a plausible PNG rather than an error:
 *
 * It refuses to lay a page out narrower than 500px. Ask for a 192px window
 * and it lays out at 500 and hands back the leftmost 192px of it: an icon
 * that looks fine until you notice it is off-centre and cropped.
 *
 * And it clamps `--force-device-scale-factor` to 0.5, so the way round
 * that — a big layout rasterised small — cannot reach 192 or 180 either.
 *
 * So the window is always the same generous size, and each icon is drawn
 * at its own edge in the corner of it and cut out of the screenshot. Every
 * size is still rasterised from the vectors at exactly the size it ships
 * at, which is the sharp way round; only the framing is fixed. Both
 * sources take their edge from `--edge` so this file can set it, and fall
 * back to filling the viewport when opened in a browser on their own.
 */

import {execFileSync} from 'node:child_process';
import {readFileSync, rmSync, writeFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {crc32, deflateSync, inflateSync} from 'node:zlib';
import {ICON_FILES} from '../appIdentity.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const CHROMIUM = process.env.CHROMIUM ?? '/opt/pw-browsers/chromium';

/** The window every source is drawn in. Wider than Chromium's 500px floor
 * and than the largest icon; taller again by enough to clear the chrome it
 * reserves, which comes out of the viewport rather than the screenshot. */
const WINDOW = {width: 512, height: 752};

/** What each icon the build ships is the size of. Typed against the list
 * itself so adding a file there and forgetting it here does not compile —
 * and checked again below, since this file is not in tsconfig's `include`. */
const SIZES: Record<(typeof ICON_FILES)[number], number> = {
  'icon-512.png': 512,
  'icon-192.png': 192,
  'apple-touch-icon.png': 180,
};

/** Stable is first: staging's band is composited over stable's 512. */
const CHANNELS = [
  {channel: 'stable', source: 'icon.svg'},
  {channel: 'staging', source: 'icon.html'},
] as const;

const PNG_MAGIC = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const CHANNELS_PER_COLOR: Record<number, number> = {
  0: 1,
  2: 3,
  3: 1,
  4: 2,
  6: 4,
};

function chunk(type: string, data: Buffer): Buffer {
  const out = Buffer.alloc(data.length + 12);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'latin1');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/** Cuts the top-left `edge` by `edge` out of `file`, in place.
 *
 * A PNG is not addressable without going through its filters — each
 * scanline is stored as a difference from its neighbours — so this decodes
 * to flat pixels, takes the corner, and writes it back out under one
 * filter rather than trying to preserve whichever ones Chromium picked.
 * Paeth on the way out because these are gradients, which it predicts
 * about as well as anything and far better than storing them raw. */
function cropCorner(file: string, edge: number): void {
  const png = readFileSync(file);
  let header: Buffer | null = null;
  const parts: Buffer[] = [];
  for (let i = 8; i < png.length;) {
    const length = png.readUInt32BE(i);
    const type = png.toString('latin1', i + 4, i + 8);
    const body = png.subarray(i + 8, i + 8 + length);
    if (type === 'IHDR') header = Buffer.from(body);
    else if (type === 'IDAT') parts.push(body);
    i += length + 12;
  }
  if (header === null) throw new Error(`${file}: no IHDR`);
  const width = header.readUInt32BE(0);
  const height = header.readUInt32BE(4);
  if (header.readUInt8(8) !== 8)
    throw new Error(`${file}: not 8 bits a channel`);
  const step = CHANNELS_PER_COLOR[header.readUInt8(9)];
  if (step === undefined) throw new Error(`${file}: odd color type`);
  if (width < edge || height < edge) {
    throw new Error(`${file}: ${width}x${height} has no ${edge}px corner`);
  }

  const packed = inflateSync(Buffer.concat(parts));
  const stride = width * step;
  const flat = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = packed[y * (stride + 1)];
    const row = y * stride;
    const prev = row - stride;
    for (let x = 0; x < stride; x++) {
      const left = x >= step ? flat[row + x - step]! : 0;
      const up = y > 0 ? flat[prev + x]! : 0;
      const upLeft = x >= step && y > 0 ? flat[prev + x - step]! : 0;
      const raw = packed[y * (stride + 1) + 1 + x]!;
      const delta =
        filter === 1
          ? left
          : filter === 2
            ? up
            : filter === 3
              ? (left + up) >> 1
              : filter === 4
                ? paeth(left, up, upLeft)
                : 0;
      flat[row + x] = (raw + delta) & 255;
    }
  }

  const cropped = edge * step;
  const out = Buffer.alloc(edge * (cropped + 1));
  for (let y = 0; y < edge; y++) {
    const row = y * (cropped + 1);
    out[row] = 4;
    for (let x = 0; x < cropped; x++) {
      const left = x >= step ? flat[y * stride + x - step]! : 0;
      const up = y > 0 ? flat[(y - 1) * stride + x]! : 0;
      const upLeft =
        x >= step && y > 0 ? flat[(y - 1) * stride + x - step]! : 0;
      out[row + 1 + x] =
        (flat[y * stride + x]! - paeth(left, up, upLeft)) & 255;
    }
  }

  header.writeUInt32BE(edge, 0);
  header.writeUInt32BE(edge, 4);
  writeFileSync(
    file,
    Buffer.concat([
      PNG_MAGIC,
      chunk('IHDR', header),
      chunk('IDAT', deflateSync(out, {level: 9})),
      chunk('IEND', Buffer.alloc(0)),
    ]),
  );
}

/** The source in a document that pins it to `edge` in the corner. An SVG
 * needs that said for it; icon.html already reads `--edge` itself. */
function document(source: string, body: string, edge: number): string {
  const edged = `<!doctype html><meta charset="utf-8"><style>
     :root{--edge:${edge}px}
     html,body{margin:0}
   </style>`;
  if (!source.endsWith('.svg')) return edged + body;
  return `${edged}<style>
     svg{display:block;width:var(--edge);height:var(--edge)}
   </style>${body}`;
}

for (const file of ICON_FILES) {
  if (SIZES[file] === undefined) throw new Error(`no size for ${file}`);
}

for (const {channel, source} of CHANNELS) {
  const dir = join(HERE, channel);
  const body = readFileSync(join(dir, source), 'utf8');
  for (const file of ICON_FILES) {
    const edge = SIZES[file];
    const html = join(dir, '.render.html');
    const png = join(dir, file);
    writeFileSync(html, document(source, body, edge));
    try {
      execFileSync(
        CHROMIUM,
        [
          '--headless',
          '--no-sandbox',
          '--hide-scrollbars',
          '--force-device-scale-factor=1',
          `--window-size=${WINDOW.width},${WINDOW.height}`,
          `--screenshot=${png}`,
          `file://${html}`,
        ],
        {stdio: 'ignore'},
      );
    } finally {
      rmSync(html, {force: true});
    }
    cropCorner(png, edge);
    console.log(`${channel}/${file}`);
  }
}
