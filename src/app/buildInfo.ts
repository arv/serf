// Substituted by vite's `define` at build time — see vite.config.ts. They are
// free identifiers on purpose: `declare` erases, so the bundler is left with a
// bare name to replace.
declare const __APP_VERSION__: string;
declare const __GIT_COMMIT__: string;

/** The package version, e.g. `0.1.0`. */
export const APP_VERSION: string = __APP_VERSION__;

/**
 * Short sha of the commit this bundle was built from, or `unknown` when the
 * build had no checkout to read.
 */
export const GIT_COMMIT: string = __GIT_COMMIT__;

/**
 * What the start menu prints: `0.1.0+a1b2c3d`, falling back to a bare version
 * when the commit is unknown — a label reading `+unknown` tells nobody
 * anything the missing suffix doesn't.
 */
export const BUILD_LABEL: string =
  GIT_COMMIT === 'unknown' ? APP_VERSION : `${APP_VERSION}+${GIT_COMMIT}`;
