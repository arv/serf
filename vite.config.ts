import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import solid from 'vite-plugin-solid';
import {defineConfig} from 'vitest/config';
import {channelFor, identityFor} from './build/appIdentity';
import {appIdentityPlugin} from './build/appIdentityPlugin';
import {serviceWorkerPlugin} from './build/swPlugin';

const {version} = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf8'),
) as {version: string};

// The start menu shows which build you are on, and the browser can read
// neither package.json nor the checkout — both halves have to be baked in
// here. A build outside a git checkout (or from a source tarball) still has
// to succeed, so a missing commit degrades to 'unknown' rather than throwing;
// CI hosts that export the sha are believed before we shell out to git.
function gitCommit(): string {
  const fromEnv = process.env.RAILWAY_GIT_COMMIT_SHA ?? process.env.GITHUB_SHA;
  if (fromEnv) return fromEnv.slice(0, 7);
  try {
    return execFileSync('git', ['rev-parse', '--short=7', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return 'unknown';
  }
}

// The branch decides more than a footer: it is what makes a build the
// stable one or the staging one (build/appIdentity.ts), so it takes the
// same route as the commit — the host's word first (Railway names the
// branch it deploys; Actions names a pull request's head, else the ref),
// then the checkout. A detached HEAD has no branch name — `rev-parse`
// answers 'HEAD' — and reads as unknown like a missing checkout does.
function gitBranch(): string {
  const fromEnv =
    process.env.RAILWAY_GIT_BRANCH ||
    process.env.GITHUB_HEAD_REF ||
    process.env.GITHUB_REF_NAME;
  if (fromEnv) return fromEnv;
  try {
    const name = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return name === 'HEAD' || name === '' ? 'unknown' : name;
  } catch {
    return 'unknown';
  }
}

const branch = gitBranch();
const identity = identityFor(channelFor(branch));

// SharedArrayBuffer requires cross-origin isolation. Production hosting must
// send these same two headers.
const crossOriginIsolation = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

/**
 * Dependencies that are given a chunk of their own, matched on the
 * directory every one of their files sits in. (pnpm's real directory is
 * `.pnpm/<name>@<version>/node_modules/<name>/`, so the trailing separator
 * is what keeps `three` off `@types/three` and `solid-js` off a package
 * merely named after it. `[\\/]` rather than `/` for every separator: a
 * module id arrives in the platform's own spelling, and on Windows that is
 * a backslash — which a forward-slash substring would quietly never match,
 * leaving the whole split silently undone.)
 *
 * These are the files that do not change. App code is rewritten daily and
 * its chunk hashes turn over with it; three.js and Solid turn over when the
 * lockfile says so, which is a handful of times a year. Left to the
 * automatic chunker they were mixed into whichever app chunk happened to
 * pull them — three.js shared a 683 kB chunk with six render modules, Solid
 * shared one with the building table — so a one-line balance tweak handed
 * every returning player 176 kB of three.js to fetch again. Named here they
 * keep their own file names across such a deploy, and the browser (and the
 * service worker's shell precache, which fetches through the HTTP cache)
 * keeps what it already has.

 */
const VENDOR_CHUNKS: [inside: RegExp, chunk: string][] = [
  [/node_modules[\\/]three[\\/]/, 'three'],
  [/node_modules[\\/]solid-js[\\/]/, 'solid'],
];

function vendorChunk(id: string): string | undefined {
  for (const [inside, chunk] of VENDOR_CHUNKS) {
    if (inside.test(id)) return chunk;
  }
  return undefined;
}

// Honor PORT so several checkouts (worktrees) can run dev servers side by
// side without fighting over one hardcoded port. An explicit --port still
// wins, and without either we fall through to Vite's own default.
const port = process.env.PORT ? Number(process.env.PORT) : undefined;

export default defineConfig({
  plugins: [solid(), appIdentityPlugin(identity), serviceWorkerPlugin()],
  // JSON modules ship as JSON.parse('...') rather than object literals:
  // the campaign's mission maps are ~250 KB each, and JSON.parse beats the
  // JS parser at that size, in the shipped chunks and in vitest's module
  // runner both. It mattered most when the maps were tile *arrays* —
  // literal evaluation made the mission tests ~10x slower; they are base64
  // strings now, and this still costs nothing.
  json: {stringify: true},
  define: {
    __APP_VERSION__: JSON.stringify(version),
    __GIT_COMMIT__: JSON.stringify(gitCommit()),
    __GIT_BRANCH__: JSON.stringify(branch),
    __BUILD_CHANNEL__: JSON.stringify(identity.channel),
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks: vendorChunk,
      },
    },
  },
  // ES-format workers, because the sim worker code-splits: the campaign's
  // mission maps (sim/defs/missionMaps.ts) arrive as dynamic chunks when a
  // mission boots, and the default iife worker build cannot split at all.
  worker: {format: 'es'},
  server: {headers: crossOriginIsolation, port},
  preview: {headers: crossOriginIsolation, port},
  test: {
    // Sim tests are headless node — no DOM environment needed or wanted.
    environment: 'node',
    // Vitest's 5s default measures wall clock, but most of this suite does
    // real work — map generation across seeds, thousand-tick determinism
    // runs, noise buffers, brush sweeps. Idle, those land well inside a
    // second; on a contended box they are simply not scheduled often enough
    // to finish, and the suite fails a random handful of tests drawn from
    // wherever the starvation happened to land. 30s absorbs that. The cost
    // is that a test which grows genuinely slow no longer trips the clock,
    // so the heavyweights that need more still carry explicit per-test
    // timeouts (see sim/missions, sim/aiStrategies) rather than leaning on
    // this number.
    testTimeout: 30_000,
    // Same reasoning, same starvation: our hooks only reset mock state, but
    // a process that isn't running cannot finish even that.
    hookTimeout: 30_000,
  },
});
