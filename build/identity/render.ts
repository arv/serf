/**
 * Bakes every channel's icons from its one source.
 *
 *   pnpm icons
 *
 * Stable is drawn from stable/icon.svg; staging composites its band over
 * the same SVG (staging/icon.html), so both channels rasterise the vectors
 * at exactly the size they ship at rather than resampling a larger PNG.
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
 * So the window is always the same generous size, each icon is drawn at
 * its own edge in the corner of it, and png.ts cuts that corner out of the
 * screenshot. Only the framing is fixed; the drawing is still rendered at
 * its final size. Both sources take that edge from `--edge` so this file
 * can set it, and fall back to filling the viewport when opened in a
 * browser on their own.
 */

import {execFileSync} from 'node:child_process';
import {readFileSync, rmSync, writeFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {ICON_FILES, ICON_SIZES} from '../appIdentity.ts';
import {cropCorner, decodePng} from './png.ts';

const HERE = dirname(fileURLToPath(import.meta.url));

/** Where the rest of the repo's headless-Chromium scripts look for it —
 * tools/perf/renderProbe.mjs and tools/modelLab/{bake,shot}.mjs — so one
 * CHROME_PATH covers all of them. */
const CHROME =
  process.env.CHROME_PATH ??
  '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

/** The window every source is drawn in. Wider than Chromium's 500px floor
 * and than the largest icon; taller again by enough to clear the chrome it
 * reserves, which comes out of the viewport rather than the screenshot. */
const WINDOW = {width: 512, height: 752};

const CHANNELS = [
  {channel: 'stable', source: 'icon.svg'},
  {channel: 'staging', source: 'icon.html'},
] as const;

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

function bake(): void {
  for (const {channel, source} of CHANNELS) {
    const dir = join(HERE, channel);
    const body = readFileSync(join(dir, source), 'utf8');
    for (const file of ICON_FILES) {
      const edge = ICON_SIZES[file];
      const html = join(dir, '.render.html');
      const png = join(dir, file);
      writeFileSync(html, document(source, body, edge));
      try {
        execFileSync(
          CHROME,
          [
            '--headless',
            '--no-sandbox',
            '--hide-scrollbars',
            '--force-device-scale-factor=1',
            `--window-size=${WINDOW.width},${WINDOW.height}`,
            `--screenshot=${png}`,
            pathToFileURL(html).href,
          ],
          {stdio: 'ignore'},
        );
      } finally {
        rmSync(html, {force: true});
      }
      const shot = decodePng(readFileSync(png));
      if (shot.width < edge) {
        throw new Error(
          `${channel}/${file}: Chromium laid out ${shot.width}px wide, ` +
            `too narrow for a ${edge}px icon`,
        );
      }
      writeFileSync(png, cropCorner(readFileSync(png), edge));
      console.log(`${channel}/${file}`);
    }
  }
}

/** Only when run, not when imported: importing this module should never
 * launch a browser. Spelled the way tools/aiLab spells its own, which is
 * the spelling that survives a path the shell would have escaped. */
const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href)
  bake();
