#!/usr/bin/env node
/**
 * Bake every model the compositions use down to vertex-colored arrays.
 *
 *   node tools/modelLab/bake.mjs [out.json]
 *
 * Starts the project's dev server, opens the bake page in headless
 * Chromium, and writes what it produces. It runs in a browser because that
 * is where GLTFLoader and a canvas to sample the pack's atlas both live —
 * and because the result then provably matches what the dev page renders.
 *
 * Output defaults to tools/modelLab/baked.json, which build-gallery.mjs
 * inlines into the published page.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const out = process.argv[2] ?? join(here, 'baked.json');

const CHROME = process.env.CHROME_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const PORT = 5407;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- dev server -----------------------------------------------------------
const vite = spawn(
  process.execPath,
  [
    join(root, 'node_modules', 'vite', 'bin', 'vite.js'),
    '--host',
    '127.0.0.1',
    '--port',
    String(PORT),
  ],
  { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PORT: String(PORT) } },
);
const bye = () => {
  try {
    vite.kill();
  } catch {
    /* already gone */
  }
};
process.on('exit', bye);

let up = false;
for (let i = 0; i < 80 && !up; i++) {
  await sleep(250);
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/tools/modelLab/bake.html`);
    up = r.ok;
  } catch {
    /* still starting */
  }
}
if (!up) {
  console.error('dev server never came up');
  process.exit(1);
}

// --- browser --------------------------------------------------------------
const profile = mkdtempSync(join(tmpdir(), 'bake-'));
const port = 9301;
const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu-sandbox',
    '--enable-unsafe-swiftshader',
    '--use-angle=swiftshader',
    `--user-data-dir=${profile}`,
    `--remote-debugging-port=${port}`,
    'about:blank',
  ],
  { stdio: 'ignore' },
);

let wsUrl;
for (let i = 0; i < 80 && !wsUrl; i++) {
  await sleep(250);
  try {
    const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    wsUrl = list.find((t) => t.type === 'page')?.webSocketDebuggerUrl;
  } catch {
    /* still starting */
  }
}
if (!wsUrl) {
  console.error('chromium never opened a debugging port');
  chrome.kill();
  process.exit(1);
}

const ws = new WebSocket(wsUrl);
await new Promise((res, rej) => {
  ws.onopen = res;
  ws.onerror = rej;
});
let nextId = 1;
const pending = new Map();
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg.result ?? msg.error);
    pending.delete(msg.id);
  }
};
const send = (method, params = {}) =>
  new Promise((res) => {
    const id = nextId++;
    pending.set(id, res);
    ws.send(JSON.stringify({ id, method, params }));
  });

await send('Runtime.enable');
await send('Page.enable');
await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/tools/modelLab/bake.html` });

let baked = null;
for (let i = 0; i < 120; i++) {
  await sleep(500);
  const r = await send('Runtime.evaluate', {
    expression: 'window.__BAKE_ERROR ? "E:" + window.__BAKE_ERROR : (window.__BAKED ?? "")',
    returnByValue: true,
  });
  const value = r?.result?.value ?? '';
  if (value.startsWith('E:')) {
    console.error(value.slice(2));
    ws.close();
    chrome.kill();
    process.exit(1);
  }
  if (value) {
    baked = value;
    break;
  }
}

ws.close();
chrome.kill();

if (!baked) {
  console.error('the bake page never produced anything');
  process.exit(1);
}

const models = JSON.parse(baked);
writeFileSync(out, JSON.stringify(models));
const kb = (Buffer.byteLength(baked) / 1024) | 0;
console.log(`baked ${Object.keys(models).length} models -> ${out} (${kb} kB)`);
process.exit(0);
