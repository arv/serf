import { defineConfig } from 'vitest/config';
import solid from 'vite-plugin-solid';

// SharedArrayBuffer requires cross-origin isolation. Production hosting must
// send these same two headers.
const crossOriginIsolation = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

export default defineConfig({
  plugins: [solid()],
  server: { headers: crossOriginIsolation },
  preview: { headers: crossOriginIsolation },
  // Sim tests are headless node — no DOM environment needed or wanted.
  test: { environment: 'node' },
});
