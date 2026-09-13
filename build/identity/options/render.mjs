/**
 * Renders every option SVG beside this file to PNG at each icon size, with
 * headless Chromium — the same renderer the game runs in, so what an icon
 * looks like here is what it looks like installed.
 *
 *   node build/identity/options/render.mjs [outDir]
 *
 * Headless Chromium screenshots the whole window, but lays the page out in
 * a viewport shorter than it by however much chrome the build reserves — so
 * asking for a square window returns a square PNG with the page squeezed
 * into the top of it and white underneath. Rather than guess that inset,
 * the window is asked for tall, the SVG is drawn at the window's full width
 * (square, so `size` tall), and the white rows below it are cut off.
 *
 * Cutting only trailing rows is why the crop can be this short: a PNG
 * scanline's filter refers to the row above it, never below, so dropping
 * the tail of the image leaves every remaining row byte-identical and
 * there is nothing to un-filter and re-filter.
 */
import {execFileSync} from 'node:child_process';
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import {basename, dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {crc32, deflateSync, inflateSync} from 'node:zlib';

const HERE = dirname(fileURLToPath(import.meta.url));
const CHROMIUM = process.env.CHROMIUM ?? '/opt/pw-browsers/chromium';

/** 512 and 192 are the manifest's icons and 180 the apple-touch-icon. The
 * rest are for looking at: 384 for a review sheet, and 96 and 48 for the
 * sizes a launcher and a browser tab actually draw — the ones an icon has
 * to survive. */
const SIZES = [512, 384, 192, 180, 96, 48];

/** Slack for the window chrome. Anything at least as tall as the inset
 * works; the crop takes care of the rest. */
const PAD = 240;

const PNG_MAGIC = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

const page = svg =>
  `<!doctype html><meta charset="utf-8"><style>
     html,body{margin:0;background:#0000}
     svg{display:block;width:100vw;height:auto}
   </style>${svg}`;

function chunk(type, data) {
  const out = Buffer.alloc(data.length + 12);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'latin1');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

/** Rewrites `file` keeping only its top `rows` scanlines. */
function cropRows(file, rows) {
  const png = readFileSync(file);
  let head = null;
  let idat = [];
  for (let i = 8; i < png.length;) {
    const length = png.readUInt32BE(i);
    const type = png.toString('latin1', i + 4, i + 8);
    const body = png.subarray(i + 8, i + 8 + length);
    if (type === 'IHDR') head = Buffer.from(body);
    else if (type === 'IDAT') idat.push(body);
    i += length + 12;
  }
  if (head === null) throw new Error(`${file}: no IHDR`);
  const width = head.readUInt32BE(0);
  const height = head.readUInt32BE(4);
  const depth = head.readUInt8(8);
  const color = head.readUInt8(9);
  if (depth !== 8) throw new Error(`${file}: expected 8 bits per channel`);
  const channels = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4}[color];
  if (channels === undefined) throw new Error(`${file}: color type ${color}`);
  if (rows > height)
    throw new Error(`${file}: only ${height} rows to crop to ${rows}`);

  const stride = 1 + width * channels;
  const kept = inflateSync(Buffer.concat(idat)).subarray(0, rows * stride);
  head.writeUInt32BE(rows, 4);
  writeFileSync(
    file,
    Buffer.concat([
      PNG_MAGIC,
      chunk('IHDR', head),
      chunk('IDAT', deflateSync(kept, {level: 9})),
      chunk('IEND', Buffer.alloc(0)),
    ]),
  );
  return width;
}

const out = process.argv[2] ?? join(HERE, 'out');
mkdirSync(out, {recursive: true});

for (const file of readdirSync(HERE)
  .filter(f => f.endsWith('.svg'))
  .sort()) {
  const name = basename(file, '.svg');
  const html = join(out, `.${name}.html`);
  writeFileSync(html, page(readFileSync(join(HERE, file), 'utf8')));
  for (const size of SIZES) {
    const png = join(out, `${name}-${size}.png`);
    execFileSync(
      CHROMIUM,
      [
        '--headless',
        '--no-sandbox',
        '--hide-scrollbars',
        '--force-device-scale-factor=1',
        `--window-size=${size},${size + PAD}`,
        `--screenshot=${png}`,
        `file://${html}`,
      ],
      {stdio: 'ignore'},
    );
    const width = cropRows(png, size);
    if (width !== size) {
      throw new Error(`${name} at ${size}: Chromium returned ${width}px wide`);
    }
  }
  rmSync(html);
  console.log(name);
}
