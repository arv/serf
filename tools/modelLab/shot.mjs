#!/usr/bin/env node
/**
 * Screenshot a page with headless Chromium over the DevTools protocol, and
 * print anything the page logged or threw on the way. Node's global
 * WebSocket does the talking, so this needs no dependencies at all.
 *
 *   node tools/modelLab/shot.mjs <url> <out.png> [width] [height] [waitMs]
 *
 * Used to check the lab's compositions and the published gallery without a
 * browser in the loop.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const [url, out, w = '1100', h = '900', waitMs = '6000'] = process.argv.slice(2);
if (!url || !out) {
  console.error('usage: shot.mjs <url> <out.png> [w] [h] [waitMs]');
  process.exit(2);
}

const CHROME = process.env.CHROME_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

const port = 9222 + Math.floor(process.pid % 500);
const profile = mkdtempSync(join(tmpdir(), 'labshot-'));
const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu-sandbox',
    '--enable-unsafe-swiftshader',
    '--use-angle=swiftshader',
    '--hide-scrollbars',
    `--user-data-dir=${profile}`,
    `--remote-debugging-port=${port}`,
    `--window-size=${w},${h}`,
    'about:blank',
  ],
  { stdio: ['ignore', 'ignore', 'pipe'] },
);
chrome.stderr.on('data', () => {});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function target() {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`);
      const list = await res.json();
      const page = list.find((t) => t.type === 'page');
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch {
      /* not up yet */
    }
    await sleep(250);
  }
  throw new Error('chromium never opened a debugging port');
}

const wsUrl = await target();
const ws = new WebSocket(wsUrl);
await new Promise((res, rej) => {
  ws.onopen = res;
  ws.onerror = rej;
});

let nextId = 1;
const pending = new Map();
const logs = [];
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg.result ?? msg.error);
    pending.delete(msg.id);
    return;
  }
  if (msg.method === 'Runtime.consoleAPICalled') {
    logs.push(
      `[${msg.params.type}] ` +
        msg.params.args.map((a) => a.value ?? a.description ?? a.type).join(' '),
    );
  }
  if (msg.method === 'Runtime.exceptionThrown') {
    const d = msg.params.exceptionDetails;
    logs.push(`[throw] ${d.exception?.description ?? d.text}`);
  }
  if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') {
    logs.push(`[log] ${msg.params.entry.text}`);
  }
};

const send = (method, params = {}) =>
  new Promise((res) => {
    const id = nextId++;
    pending.set(id, res);
    ws.send(JSON.stringify({ id, method, params }));
  });

await send('Runtime.enable');
await send('Log.enable');
await send('Page.enable');
// DARK=1 emulates the OS preference; THEME=dark|light stamps the root the
// way an Artifact's own theme toggle does, so both paths get checked.
if (process.env.DARK === '1') {
  await send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-color-scheme', value: 'dark' }],
  });
}
await send('Page.navigate', { url });
await sleep(Number(waitMs));
if (process.env.THEME) {
  await send('Runtime.evaluate', {
    expression: `document.documentElement.dataset.theme = ${JSON.stringify(process.env.THEME)}; dispatchEvent(new Event('resize'));`,
  });
  await sleep(1200);
}

// Beyond-the-viewport capture stitches a tall page in passes, which a
// fixed-position canvas does not survive; VIEWPORT_ONLY=1 grabs exactly
// what a phone would show instead.
const shot = await send('Page.captureScreenshot', {
  format: 'png',
  captureBeyondViewport: process.env.VIEWPORT_ONLY !== '1',
});
if (shot?.data) {
  writeFileSync(out, Buffer.from(shot.data, 'base64'));
  console.log(`wrote ${out}`);
} else {
  console.error('no screenshot:', shot);
}
for (const l of logs) console.log(l);

ws.close();
chrome.kill();
process.exit(0);
