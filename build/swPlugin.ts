import {createHash} from 'node:crypto';
import {readdirSync, readFileSync, statSync, writeFileSync} from 'node:fs';
import {join, posix, relative, sep} from 'node:path';
import type {Plugin, ResolvedConfig} from 'vite';

/**
 * Emits dist/sw.js: src/app/sw.js with its placeholders filled in.
 *
 * The service worker has to name every file it precaches, and half of
 * those names only exist after a build (hashed bundle chunks), so the list
 * is stitched together here rather than maintained by hand. It is taken
 * from the finished dist/ rather than from the rollup bundle, because
 * index.html and everything copied out of public/ only exist on disk —
 * and what the worker must cache is exactly what the server will serve.
 *
 * Two lists, two versions: the shell (document, bundle, fonts, icons)
 * turns over on every code change, while the ~10 MB of KayKit models (and
 * the audio samples beside them) keep their cache across the deploys that
 * did not touch them.
 */

const SW_SOURCE = 'src/app/sw.js';

/** Built files that belong to the heavy, slow-moving asset cache: the
 * KayKit models and the audio samples. Both are best-effort by design —
 * the renderer falls back to procedural models, the mixer to procedural
 * synthesis — so neither belongs in the all-or-nothing shell install,
 * where one failed fetch would cost every visitor offline support. */
const ASSET_PREFIXES = ['/models/', '/audio/'];
const isAsset = (f: string): boolean =>
  ASSET_PREFIXES.some(p => f.startsWith(p));

/** Never worth a place in the cache: licence texts and sourcemaps are
 * developer-facing, and nothing offline reads them. */
const SKIP = /\.(map|txt)$/;

function walk(dir: string, root: string, out: string[]): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, root, out);
    else out.push('/' + relative(root, full).split(sep).join(posix.sep));
  }
  return out;
}

function version(dist: string, files: string[]): string {
  const digest = createHash('sha256').update(files.join('\n'));
  // By content, not by build time: an unchanged deploy must not evict a
  // cache the player already has. Bundle chunks are named by their hash,
  // but index.html and the public files are not, so their bytes go in too.
  for (const file of files)
    digest.update(readFileSync(join(dist, file.slice(1))));
  return digest.digest('hex').slice(0, 12);
}

export function serviceWorkerPlugin(): Plugin {
  let config: ResolvedConfig;
  return {
    name: 'serf-service-worker',
    // Dev has no hashed file names to precache and no interest in serving
    // yesterday's bundle from disk; main.ts only registers the worker in a
    // production build.
    apply: 'build',
    configResolved(resolved) {
      config = resolved;
    },
    // closeBundle, not generateBundle: public/ is copied into dist/ as part
    // of the write, and the document itself is written by vite's html
    // plugin — neither is visible in the in-memory bundle.
    closeBundle() {
      const dist = join(config.root, config.build.outDir);
      const files = walk(dist, dist, [])
        .filter(f => f !== '/sw.js' && !SKIP.test(f))
        .sort();
      const assets = files.filter(isAsset);
      const shell = files.filter(f => !isAsset(f));
      if (!shell.includes('/index.html')) {
        this.error(
          'no index.html in the build output — the worker would cache no document',
        );
      }

      const source = readFileSync(SW_SOURCE, 'utf8')
        .replace('__SHELL_VERSION__', version(dist, shell))
        .replace('__ASSET_VERSION__', version(dist, assets))
        .replace("['__SHELL__']", JSON.stringify(shell))
        .replace("['__ASSETS__']", JSON.stringify(assets));
      // Every placeholder, not a named few: a substitution that silently
      // misses is the worst outcome here, since the worker still installs
      // and only stops caching what it was meant to. An unfilled
      // ['__ASSETS__'] would warm one bogus URL, swallow the failure, and
      // leave a build that looks offline-ready with no models on disk.
      const unfilled = [...new Set(source.match(/__[A-Z_]+__/g))];
      if (unfilled.length > 0) {
        this.error(
          `${SW_SOURCE} left ${unfilled.join(', ')} unsubstituted — ` +
            'a placeholder was renamed or its surrounding formatting changed.',
        );
      }
      writeFileSync(join(dist, 'sw.js'), source);
    },
  };
}
