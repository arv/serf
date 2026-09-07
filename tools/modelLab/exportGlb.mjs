#!/usr/bin/env node
/**
 * Export a .glb for Blender and friends, from one of two pages.
 *
 *   node tools/modelLab/exportGlb.mjs [building] [out.glb] [query]
 *   node tools/modelLab/exportGlb.mjs site      [out.glb] [query]
 *
 * A building key exports that building's composed model on nothing
 * (exportGlb.html); `site` exports a patch of real shoreline with a
 * fishery and a house standing on it (exportSite.html). The trailing
 * `query` is appended to the page's own — `seed=7&r=20`, `owner=1`.
 *
 * Starts the project's dev server and drives headless Chromium, the same
 * walk bake.mjs makes and for the same reason: GLTFLoader lives in a
 * browser, and going through one means the file is what the renderer draws.
 *
 * Defaults to the fishery, written to .gallery-build/<target>.glb.
 */
import {spawn} from 'node:child_process';
import {mkdirSync, mkdtempSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const target = process.argv[2] ?? 'fishery';
const out = process.argv[3] ?? join(root, '.gallery-build', `${target}.glb`);
const extra = process.argv[4] ?? '';
const [file, base] =
  target === 'site'
    ? ['exportSite.html', '']
    : ['exportGlb.html', `b=${target}`];

const CHROME =
  process.env.CHROME_PATH ??
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 5408;
const sleep = ms => new Promise(r => setTimeout(r, ms));

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
  {cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env: {...process.env}},
);
const bye = () => {
  try {
    vite.kill();
  } catch {
    /* already gone */
  }
};
process.on('exit', bye);

const page =
  `http://127.0.0.1:${PORT}/tools/modelLab/${file}?` +
  [base, extra].filter(Boolean).join('&');
let up = false;
for (let i = 0; i < 80 && !up; i++) {
  await sleep(250);
  try {
    up = (await fetch(page)).ok;
  } catch {
    /* still starting */
  }
}
if (!up) {
  console.error('dev server never came up');
  process.exit(1);
}

// --- browser --------------------------------------------------------------
const profile = mkdtempSync(join(tmpdir(), 'exportglb-'));
const port = 9302;
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
  {stdio: 'ignore'},
);

let wsUrl;
for (let i = 0; i < 80 && !wsUrl; i++) {
  await sleep(250);
  try {
    const list = await (
      await fetch(`http://127.0.0.1:${port}/json/list`)
    ).json();
    wsUrl = list.find(t => t.type === 'page')?.webSocketDebuggerUrl;
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
ws.onmessage = ev => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg.result ?? msg.error);
    pending.delete(msg.id);
  }
};
const send = (method, params = {}) =>
  new Promise(res => {
    const id = nextId++;
    pending.set(id, res);
    ws.send(JSON.stringify({id, method, params}));
  });
const evaluate = async expression => {
  const r = await send('Runtime.evaluate', {expression, returnByValue: true});
  return r?.result?.value ?? '';
};

await send('Runtime.enable');
await send('Page.enable');
await send('Page.navigate', {url: page});

// The page reports done by length; the bytes come back in chunks, because a
// textured building is a megabyte of base64 and one evaluate is a poor
// place to put it.
let total = 0;
for (let i = 0; i < 120 && !total; i++) {
  await sleep(500);
  const err = await evaluate('window.__GLB_ERROR ?? ""');
  if (err) {
    console.error(err);
    ws.close();
    chrome.kill();
    process.exit(1);
  }
  total = Number(await evaluate('window.__GLB?.length ?? 0'));
}
if (!total) {
  console.error('the export page never produced anything');
  ws.close();
  chrome.kill();
  process.exit(1);
}

const CHUNK = 1 << 18;
let b64 = '';
for (let i = 0; i < total; i += CHUNK) {
  b64 += await evaluate(`window.__GLB.slice(${i}, ${i + CHUNK})`);
}

const note = await evaluate('window.__GLB_NOTE ?? ""');

ws.close();
chrome.kill();

const buf = Buffer.from(b64, 'base64');
mkdirSync(dirname(out), {recursive: true});
writeFileSync(out, buf);
if (note) console.log(note);
console.log(`exported ${target} -> ${out} (${(buf.length / 1024) | 0} kB)`);
process.exit(0);
