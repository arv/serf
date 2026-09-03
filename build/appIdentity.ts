/**
 * Which Serf Valley a build is. Two deploys run side by side — the stable
 * one built from the `stable` branch and the staging one built from
 * `main` — and installed to a phone they are indistinguishable unless the
 * build says which it is: the same name, the same icon, the same title.
 * The channel is decided once, at build time, from the branch being built
 * (see vite.config.ts), and everything that names the app reads it from
 * here: the document title, the web app manifest and the icons it points
 * at (appIdentityPlugin.ts), and the tag the start menu wears.
 *
 * Only a build of `stable` is stable. main is staging, and so is every
 * feature branch and every checkout with no branch to name — a build that
 * cannot prove it is the stable one is not allowed to look like it.
 */

export type Channel = 'stable' | 'staging';

/** The branch the stable deploy is built from. */
export const STABLE_BRANCH = 'stable';

export function channelFor(branch: string): Channel {
  return branch === STABLE_BRANCH ? 'stable' : 'staging';
}

/** The icon files each channel ships, by the URL the document and the
 * manifest name them under. Every channel has all three. */
export const ICON_FILES = [
  'icon-192.png',
  'icon-512.png',
  'apple-touch-icon.png',
] as const;

export interface Identity {
  channel: Channel;
  /** The document's `<title>`: the tab, the installed window, and the
   * home-screen label on iOS, which reads no manifest name. */
  title: string;
  /** The web app manifest, served as /manifest.webmanifest. */
  manifest: Record<string, unknown>;
}

const NAMES: Record<Channel, {name: string; shortName: string}> = {
  stable: {name: 'Serf Valley', shortName: 'Serf Valley'},
  // short_name is what a home screen prints under the icon, and it
  // truncates past about twelve characters.
  staging: {name: 'Serf Valley Staging', shortName: 'Serf Staging'},
};

export function identityFor(channel: Channel): Identity {
  const {name, shortName} = NAMES[channel];
  return {
    channel,
    title: name,
    manifest: {
      name,
      short_name: shortName,
      description:
        'A medieval village strategy game — watch your serfs carry every plank and stone.',
      start_url: '/',
      scope: '/',
      display_override: ['fullscreen', 'standalone'],
      display: 'fullscreen',
      orientation: 'any',
      background_color: '#223526',
      theme_color: '#223526',
      icons: [
        {src: '/icon-192.png', sizes: '192x192', type: 'image/png'},
        {src: '/icon-512.png', sizes: '512x512', type: 'image/png'},
        {
          src: '/icon-512.png',
          sizes: '512x512',
          type: 'image/png',
          purpose: 'maskable',
        },
      ],
    },
  };
}
