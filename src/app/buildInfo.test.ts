import {describe, expect, it} from 'vitest';
import {
  APP_VERSION,
  BUILD_CHANNEL,
  BUILD_LABEL,
  GIT_BRANCH,
  GIT_COMMIT,
} from './buildInfo';

// Reading these at all is the point of the test: if the `define` block ever
// goes missing from vite.config.ts the identifiers stay free, and importing
// the module throws ReferenceError instead of silently shipping a footer that
// reads `build undefined`.
describe('build identity', () => {
  it('takes the version from package.json', () => {
    expect(APP_VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('takes a short commit sha from the checkout', () => {
    expect(GIT_COMMIT).toMatch(/^([0-9a-f]{7}|unknown)$/);
  });

  it('takes a branch name from the checkout', () => {
    expect(GIT_BRANCH).not.toBe('');
  });

  it('is stable only when built from the stable branch', () => {
    expect(BUILD_CHANNEL).toBe(GIT_BRANCH === 'stable' ? 'stable' : 'staging');
  });

  it('joins them into one label, and drops what is unknown', () => {
    const versionAndCommit =
      GIT_COMMIT === 'unknown' ? APP_VERSION : `${APP_VERSION}+${GIT_COMMIT}`;
    expect(BUILD_LABEL).toBe(
      GIT_BRANCH === 'unknown'
        ? versionAndCommit
        : `${versionAndCommit} (${GIT_BRANCH})`,
    );
    // The sentinels, not the word: a branch may legitimately be called
    // fix/unknown-crash, and the label should print it.
    expect(BUILD_LABEL).not.toContain('+unknown');
    expect(BUILD_LABEL).not.toContain('(unknown)');
  });
});
