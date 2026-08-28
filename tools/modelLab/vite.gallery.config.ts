import {fileURLToPath} from 'node:url';
import {defineConfig} from 'vite';

/**
 * Bundles the gallery into one classic script — three.js, the toolkit, the
 * compositions and the card markup in a single file with no imports left.
 * A published Artifact runs under a CSP that blocks every external host, so
 * a module graph with bare specifiers (or an import map pointing at blob
 * URLs) is not an option: it has to be one inlined <script>.
 */
export default defineConfig({
  build: {
    lib: {
      entry: fileURLToPath(new URL('./gallery.ts', import.meta.url)),
      formats: ['iife'],
      name: 'SerfModelLab',
      fileName: () => 'gallery.js',
    },
    outDir: fileURLToPath(new URL('../../.gallery-build', import.meta.url)),
    emptyOutDir: true,
    // Nothing from public/ belongs in the bundle dir — every asset the
    // page needs is inlined by build-gallery.mjs.
    copyPublicDir: false,
    // Vite 8 bundles with rolldown; its own (oxc) minifier is what's
    // installed here, so don't ask for esbuild's.
    minify: true,
    target: 'es2022',
    reportCompressedSize: false,
  },
});
