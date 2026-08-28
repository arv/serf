import {describe, expect, it} from 'vitest';
import {APP_VERSION, BUILD_LABEL, GIT_COMMIT} from './buildInfo';

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

  it('joins the two into one label, and drops an unknown commit', () => {
    expect(BUILD_LABEL).toBe(
      GIT_COMMIT === 'unknown' ? APP_VERSION : `${APP_VERSION}+${GIT_COMMIT}`,
    );
    expect(BUILD_LABEL).not.toContain('unknown');
  });
});
