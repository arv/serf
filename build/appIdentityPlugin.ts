import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import type {Plugin} from 'vite';
import {ICON_FILES, type Identity} from './appIdentity';

/**
 * Gives the build its name: the `<title>`, /manifest.webmanifest and the
 * icon files, all for the one channel this build is (appIdentity.ts).
 *
 * These used to live in public/, which vite copies whole — and a copy of
 * both channels' icons would sit in every build, precached by the service
 * worker for nothing. Here the manifest is written from the identity and
 * the icons are picked from build/identity/<channel>/, emitted under the
 * same URLs public/ served them from, so index.html, the server and the
 * worker's shell cache all see exactly what they did before. Dev serves
 * the same four URLs from a middleware.
 */

const IDENTITY_DIR = fileURLToPath(new URL('./identity/', import.meta.url));

const TITLE = /<title>[^<]*<\/title>/;

/** The document's title, replaced in place. A document with no title at
 * all is a mistake worth stopping the build for: it would ship under
 * whatever name the browser invents. */
export function retitle(html: string, title: string): string {
  if (!TITLE.test(html)) {
    throw new Error('index.html has no <title> for the build to name');
  }
  return html.replace(TITLE, `<title>${title}</title>`);
}

interface Served {
  type: string;
  body: () => Buffer;
}

/** Everything the plugin serves, by URL. Bodies are read on demand so a
 * dev server picks up an edited icon without a restart. */
function served(identity: Identity): Map<string, Served> {
  const out = new Map<string, Served>();
  out.set('/manifest.webmanifest', {
    type: 'application/manifest+json',
    body: () => Buffer.from(JSON.stringify(identity.manifest, null, 2) + '\n'),
  });
  for (const file of ICON_FILES) {
    out.set(`/${file}`, {
      type: 'image/png',
      body: () => readFileSync(join(IDENTITY_DIR, identity.channel, file)),
    });
  }
  return out;
}

export function appIdentityPlugin(identity: Identity): Plugin {
  const files = served(identity);
  return {
    name: 'serf-app-identity',
    transformIndexHtml(html) {
      return retitle(html, identity.title);
    },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const file = files.get((req.url ?? '').split('?')[0]!);
        if (file === undefined) return next();
        res.setHeader('content-type', file.type);
        res.end(file.body());
      });
    },
    generateBundle() {
      for (const [url, file] of files) {
        this.emitFile({
          type: 'asset',
          fileName: url.slice(1),
          source: file.body(),
        });
      }
    },
  };
}
