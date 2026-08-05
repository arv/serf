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

// --- 2. the models -------------------------------------------------------
// Plain arrays, baked by bake.mjs. Nothing here is fetched at runtime: a
// published Artifact's CSP blocks fetch and XHR outright — data: URIs
// included — so the models travel as text inside the page and are decoded
// with atob.
const bakedPath = join(here, 'baked.json');
if (!existsSync(bakedPath)) {
  throw new Error('no baked.json — run `node tools/modelLab/bake.mjs` first');
}
const modelJson = readFileSync(bakedPath, 'utf8');
console.log(`models ${(Buffer.byteLength(modelJson) / 1024) | 0} kB, script ${(Buffer.byteLength(bundle) / 1024) | 0} kB`);

// --- 3. stitch ------------------------------------------------------------
const shell = readFileSync(join(here, 'gallery.shell.html'), 'utf8');
// The page's own face, inlined: the Artifact CSP blocks font CDNs, and a
// silent fallback to system-ui would undo the whole chrome.
const font = `data:font/woff2;base64,${readFileSync(join(root, 'public', 'fonts', 'space-grotesk-latin.woff2')).toString('base64')}`;
const html = shell
  .replace('__FONT__', () => font)
  .replace('/*__CSS__*/', () => readFileSync(join(here, 'lab.css'), 'utf8'))
  .replace('__MODELS__', () => modelJson.replace(/<\//g, '<\\/'))
  .replace('/*__BUNDLE__*/', () => bundle.replace(/<\/script>/gi, '<\\/script>'));

writeFileSync(out, html);
console.log(`wrote ${out} (${(Buffer.byteLength(html) / 1024 / 1024).toFixed(2)} MB)`);
