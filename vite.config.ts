import { defineConfig } from 'vitest/config';
import solid from 'vite-plugin-solid';

// SharedArrayBuffer requires cross-origin isolation. Production hosting must
// send these same two headers.
const crossOriginIsolation = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

// Take whatever port the environment assigns (several dev servers share
// this repo — worktrees, the relay, other sessions); vite's default when
// nothing is set.
const port = process.env.PORT ? Number(process.env.PORT) : undefined;

export default defineConfig({
  plugins: [solid()],
  server: { headers: crossOriginIsolation, port },
  preview: { headers: crossOriginIsolation, port },
  // Sim tests are headless node — no DOM environment needed or wanted.
  test: { environment: 'node' },
});
