import { defineConfig } from 'vitest/config';
import solid from 'vite-plugin-solid';

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
  plugins: [solid()],
  server: { headers: crossOriginIsolation, port },
  preview: { headers: crossOriginIsolation },
  // Sim tests are headless node — no DOM environment needed or wanted.
  test: { environment: 'node' },
});
