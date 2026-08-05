#!/usr/bin/env node
/**
 * Build the shareable gallery: bundle the lab into one script, inline every
 * KayKit file it touches as a data URI, and stitch both into the page shell.
 *
 *   node tools/modelLab/build-gallery.mjs [out.html]
 *
 * The result is a single file with no external requests — which is what a
 * published Artifact's CSP requires, and what makes the page work on a
 * phone with the screen locked and the tunnel gone.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const out = process.argv[2] ?? join(root, '.gallery-build', 'gallery.html');

// --- 1. bundle ------------------------------------------------------------
console.log('bundling…');
execFileSync(
  process.execPath,
  [join(root, 'node_modules', 'vite', 'bin', 'vite.js'), 'build', '--config', join(here, 'vite.gallery.config.ts')],
  { cwd: root, stdio: 'inherit' },
);
const bundle = readFileSync(join(root, '.gallery-build', 'gallery.js'), 'utf8');

// --- 2. inline the assets -------------------------------------------------
// Every file the compositions reach for, keyed by the URL GLTFLoader will
// ask for once it resolves .bin and texture URIs against the .gltf's path.
const MODELS = [
  'building_windmill_green',
  'building_watermill_green',
  'building_home_B_green',
  'building_market_green',
  'fence_wood_straight',
  'fence_wood_straight_gate',
  'sack',
  'barrel',
  'wheelbarrow',
  'pallet',
  'tent',
  'crate_A_small',
  'crate_A_big',
  'crate_open',
  'crate_long_A',
  'waterplant_A',
  'waterlily_A',
  'restaurant/crate_buns',
];
const TEXTURES = ['hexagons_medieval.png', 'restaurant/restaurantbits_texture.png'];

const assets = {};
const dataUri = (file, mime) =>
  `data:${mime};base64,${readFileSync(join(root, 'public', 'models', 'kaykit', file)).toString('base64')}`;

for (const m of MODELS) {
  for (const [ext, mime] of [
    ['.gltf', 'model/gltf+json'],
    ['.bin', 'application/octet-stream'],
  ]) {
    const rel = `${m}${ext}`;
    if (!existsSync(join(root, 'public', 'models', 'kaykit', rel))) {
      throw new Error(`missing asset: ${rel}`);
    }
    assets[`/models/kaykit/${rel}`] = dataUri(rel, mime);
  }
}
for (const t of TEXTURES) assets[`/models/kaykit/${t}`] = dataUri(t, 'image/png');

const assetJson = JSON.stringify(assets);
const bytes = Buffer.byteLength(assetJson) + Buffer.byteLength(bundle);
console.log(`assets ${(Buffer.byteLength(assetJson) / 1024) | 0} kB, script ${(Buffer.byteLength(bundle) / 1024) | 0} kB`);

// --- 3. stitch ------------------------------------------------------------
const shell = readFileSync(join(here, 'gallery.shell.html'), 'utf8');
// The page's own face, inlined: the Artifact CSP blocks font CDNs, and a
// silent fallback to system-ui would undo the whole chrome.
const font = `data:font/woff2;base64,${readFileSync(join(root, 'public', 'fonts', 'space-grotesk-latin.woff2')).toString('base64')}`;
const html = shell
  .replace('__FONT__', () => font)
  .replace('/*__CSS__*/', () => readFileSync(join(here, 'lab.css'), 'utf8'))
  .replace('__ASSETS__', () => assetJson.replace(/<\//g, '<\\/'))
  .replace('/*__BUNDLE__*/', () => bundle.replace(/<\/script>/gi, '<\\/script>'));

writeFileSync(out, html);
console.log(`wrote ${out} (${(Buffer.byteLength(html) / 1024 / 1024).toFixed(2)} MB total, payload ${(bytes / 1024) | 0} kB)`);
