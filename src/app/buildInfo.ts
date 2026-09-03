// Substituted by vite's `define` at build time — see vite.config.ts. They are
// free identifiers on purpose: `declare` erases, so the bundler is left with a
// bare name to replace.
declare const __APP_VERSION__: string;
declare const __GIT_COMMIT__: string;
declare const __GIT_BRANCH__: string;
declare const __BUILD_CHANNEL__: 'stable' | 'staging';

/** The package version, e.g. `0.1.0`. */
export const APP_VERSION: string = __APP_VERSION__;

/**
 * Short sha of the commit this bundle was built from, or `unknown` when the
 * build had no checkout to read.
 */
export const GIT_COMMIT: string = __GIT_COMMIT__;

/**
 * The branch this bundle was built from — `stable` for the stable deploy,
 * `main` for staging — or `unknown` when the build had no branch to name.
 */
export const GIT_BRANCH: string = __GIT_BRANCH__;

/**
 * Which deploy this is. Decided from the branch at build time
 * (build/appIdentity.ts): only a build of `stable` is stable, and every
 * other build — main, a feature branch, a nameless checkout — is staging.
 * The same decision names the app and picks its icon; this is the half
 * the start menu can see.
 */
export const BUILD_CHANNEL: 'stable' | 'staging' = __BUILD_CHANNEL__;

/**
 * What the start menu prints: `0.1.0+a1b2c3d (main)`, falling back to a
 * bare version when the commit is unknown and dropping the branch when it
 * is — a label reading `+unknown (unknown)` tells nobody anything the
 * missing parts don't.
 */
const VERSION_AND_COMMIT: string =
  GIT_COMMIT === 'unknown' ? APP_VERSION : `${APP_VERSION}+${GIT_COMMIT}`;
export const BUILD_LABEL: string =
  GIT_BRANCH === 'unknown'
    ? VERSION_AND_COMMIT
    : `${VERSION_AND_COMMIT} (${GIT_BRANCH})`;
