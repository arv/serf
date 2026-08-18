import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { defineConfig } from 'vitest/config';
import solid from 'vite-plugin-solid';
import { serviceWorkerPlugin } from './build/swPlugin';

const { version } = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf8'),
) as { version: string };

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

// SharedArrayBuffer requires cross-origin isolation. Production hosting must
// send these same two headers.
const crossOriginIsolation = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

// Honor PORT so several checkouts (worktrees) can run dev servers side by
// side without fighting over one hardcoded port. An explicit --port still
// wins, and without either we fall through to Vite's own default.
const port = process.env.PORT ? Number(process.env.PORT) : undefined;

export default defineConfig({
  plugins: [solid(), serviceWorkerPlugin()],
  // JSON modules ship as JSON.parse('...') rather than object literals:
  // the campaign's mission maps are ~450 KB of tile arrays each, and
  // JSON.parse beats the JS parser handily at that size — in the shipped
  // chunks and (dramatically) in vitest's module runner, where literal
  // evaluation made the mission tests ~10x slower.
  json: { stringify: true },
  define: {
    __APP_VERSION__: JSON.stringify(version),
    __GIT_COMMIT__: JSON.stringify(gitCommit()),
  },
  build: {
    rollupOptions: {
      output: {
        // The wllama engine into its own 'llm-*' chunk: inference glue
        // that only the opt-in LLM opponent ever imports, and the service
        // worker plugin recognizes llm/wllama-named files to keep them out
        // of the all-or-nothing shell precache (the 7 MB wasm keeps its
        // own name as an asset).
        manualChunks: (id) => (id.includes('@wllama/wllama') ? 'llm' : undefined),
      },
    },
  },
  // Prebundling the engine in dev drags a multi-MB dependency through
  // esbuild on every cold start for a feature most sessions never touch.
  optimizeDeps: { exclude: ['@wllama/wllama'] },
  // ES-format workers, because the sim worker code-splits: the campaign's
  // mission maps (sim/defs/missionMaps.ts) arrive as dynamic chunks when a
  // mission boots, and the default iife worker build cannot split at all.
  worker: { format: 'es' },
  server: { headers: crossOriginIsolation, port },
  preview: { headers: crossOriginIsolation, port },
  // Sim tests are headless node — no DOM environment needed or wanted.
  test: { environment: 'node' },
});
