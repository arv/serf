#!/usr/bin/env node
/**
 * What one frame costs the GPU, counted rather than guessed.
 *
 * Drives a real match in headless Chromium over the DevTools protocol and
 * reads `__renderer.info` — the draw calls and triangles three actually
 * submitted for the last frame, main pass and shadow pass together. Those
 * two numbers are the render-side equivalent of tools/perf/stress.ts's
 * ms/tick: hardware-independent, so a change that halves them has halved
 * the work every phone does, whatever the frame rate here (this runs on
 * SwiftShader, whose timings mean nothing).
 *
 * Needs a dev server up:
 *
 *   pnpm dev --port 5199
 *   node tools/perf/renderProbe.mjs
 *
 * The camera is left exactly where a match opens it, and the world is
 * sampled at a fixed age, so two runs of the same seed compare directly.
 * `--seed` and `--settle` move both. Set CHROME_PATH if Chromium is not
 * where Playwright puts it.
 */
import {spawn} from 'node:child_process';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
};
const seed = arg('seed', '7');
const size = arg('size', '96');
const settle = Number(arg('settle', '20000'));
const base = arg('url', 'http://127.0.0.1:5199');
const url = `${base}/?seed=${seed}&size=${size}&ai=1&bandits=1`;

const CHROME =
  process.env.CHROME_PATH ??
  '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const port = 9200 + (process.pid % 300);
const profile = mkdtempSync(join(tmpdir(), 'renderprobe-'));
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
    '--window-size=1280,800',
    'about:blank',
  ],
  {stdio: ['ignore', 'ignore', 'pipe']},
);
chrome.stderr.on('data', () => {});
/** Settles when the browser is actually gone, so its profile directory can
 * be cleared without racing the writes it makes on the way down. Already
 * settled if it went before anyone asked. */
const chromeGone = new Promise(res => chrome.once('exit', res));
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function debuggerUrl() {
  for (let i = 0; i < 80; i++) {
    try {
      const list = await (
        await fetch(`http://127.0.0.1:${port}/json/list`)
      ).json();
      const page = list.find(t => t.type === 'page');
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch {
      /* not up yet */
    }
    await sleep(250);
  }
  throw new Error('chromium never opened a debugging port');
}

/**
 * Everything from here down runs inside a try/finally, because everything
 * from here down can fail — the browser may never open its debugging
 * port, the match may never come up, an evaluate may throw — and the
 * browser is already running by then. An exit that skipped the cleanup
 * left a headless Chromium (eleven processes of one, in fact) alive for
 * the rest of the session, holding its profile directory and its memory,
 * with nothing left to reap it.
 */
let ws = null;
let nextId = 1;
const pending = new Map();
const errors = [];
const send = (method, params = {}) =>
  new Promise(res => {
    const id = nextId++;
    pending.set(id, res);
    ws.send(JSON.stringify({id, method, params}));
  });
const evaluate = async expression => {
  const r = await send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (r?.exceptionDetails) {
    throw new Error(r.exceptionDetails.exception?.description ?? 'eval failed');
  }
  return r?.result?.value;
};

let failure = null;
try {
  ws = new WebSocket(await debuggerUrl());
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = rej;
  });
  ws.onmessage = ev => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg.result ?? msg.error);
      pending.delete(msg.id);
      return;
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails;
      errors.push(d.exception?.description ?? d.text);
    }
  };

  await send('Runtime.enable');
  await send('Page.enable');
  await send('Page.navigate', {url});
  let up = false;
  for (let i = 0; i < 120; i++) {
    await sleep(1000);
    if ((await evaluate('typeof window.__renderer')) === 'object') {
      up = true;
      break;
    }
  }
  if (!up) {
    throw new Error(
      `the match never came up${errors.length ? `: ${errors[0]}` : ''}`,
    );
  }
  await sleep(settle);

  // A frame with nothing casting is the same frame without its shadow
  // pass, so the difference between the two is what the shadows cost.
  const sample = await evaluate(`(async () => {
    const read = () => {
      const i = window.__renderer.info.render;
      return {calls: i.calls, triangles: i.triangles};
    };
    const settle = () => new Promise(r =>
      requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 700))));
    await settle();
    const lit = read();
    const parked = [];
    window.__scene.traverse(o => { if (o.castShadow) { o.castShadow = false; parked.push(o); } });
    await settle();
    const unlit = read();
    for (const o of parked) o.castShadow = true;
    await settle();
    let objects = 0, instances = 0;
    window.__scene.traverse(o => {
      objects++;
      if (o.isInstancedMesh) instances += o.count;
    });
    return {lit, unlit, objects, instances};
  })()`);

  const {lit, unlit, objects, instances} = sample;
  const row = (name, v) =>
    `${name.padEnd(16)} ${String(v.calls).padStart(6)} calls  ${v.triangles
      .toLocaleString('en-US')
      .padStart(11)} tris`;
  console.log(`seed ${seed}  size ${size}  settled ${settle}ms`);
  console.log(row('frame', lit));
  console.log(row('  main pass', unlit));
  console.log(
    row('  shadow pass', {
      calls: lit.calls - unlit.calls,
      triangles: lit.triangles - unlit.triangles,
    }),
  );
  console.log(`scene objects    ${objects}, live instances ${instances}`);
  for (const e of errors.slice(0, 5)) console.log(`[throw] ${e}`);
} catch (err) {
  failure = err;
} finally {
  ws?.close();
  chrome.kill();
  // kill() only sends the signal. The wait is bounded because a browser
  // that will not die is not a reason to hang the probe, and a scratch
  // directory left in tmp is not worth failing a run over either — tmp
  // is swept anyway.
  await Promise.race([chromeGone, sleep(3000)]);
  try {
    rmSync(profile, {recursive: true, force: true});
  } catch {
    /* the OS clears tmp */
  }
}

if (failure) {
  console.error(failure.message ?? failure);
  process.exit(1);
}
process.exit(0);
