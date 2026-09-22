import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {describe, expect, it} from 'vitest';

/**
 * The repository's licensing claims, checked against what it ships.
 *
 * The guide's License page (src/areas/docs/pages/LicensePage.tsx) makes
 * claims about things outside itself: the licence package.json declares,
 * the files it tells a reader to open, the third-party terms it defers
 * to, and what the game records of a match. A page that says one thing
 * while the repository does another is worse than no page.
 *
 * It lives here rather than beside the page because every check is a file
 * read: src is the browser tree and its tsconfig keeps node out of it on
 * purpose, while this directory already exists for the repo-level work
 * that needs a filesystem.
 *
 * What is NOT checked is the prose. A passing suite says the page's
 * references resolve, not that its wording is right — read the page.
 */

const root = join(import.meta.dirname, '..');
const read = (path: string): string => readFileSync(join(root, path), 'utf8');

const PAGE = 'src/areas/docs/pages/LicensePage.tsx';

describe('what the repository says it is licensed under', () => {
  it('agrees between package.json and the page', () => {
    const pkg = JSON.parse(read('package.json')) as {license: string};
    expect(pkg.license).toBe('Apache-2.0');
    expect(read(PAGE)).toContain('Apache License, Version 2.0');
  });

  it('ships the real Apache text, not a paraphrase of it', () => {
    // The page is a summary and says so; this is the file it defers to.
    // Checked by the licence's own load-bearing headings rather than a
    // hash, which would only prove the file had not been touched.
    const license = read('LICENSE');
    expect(license).toContain('Apache License');
    expect(license).toContain('Version 2.0, January 2004');
    expect(license).toContain('3. Grant of Patent License.');
    expect(license).toContain('7. Disclaimer of Warranty.');
    expect(license).toContain('8. Limitation of Liability.');
  });

  it('points a reader at files that are actually there', () => {
    // A licence page whose own references 404 is the one page that
    // cannot afford it.
    const page = read(PAGE);
    expect(page).toContain('<code>LICENSE</code>');
    expect(page).toContain('<code>NOTICE</code>');
    expect(() => read('LICENSE')).not.toThrow();
    expect(() => read('NOTICE')).not.toThrow();
  });
});

describe('the work that is not ours to license', () => {
  it('is named in NOTICE, and every licence file it names exists', () => {
    const notice = read('NOTICE');
    for (const path of [
      'public/models/kaykit/LICENSE.txt',
      'public/audio/LICENSE.txt',
      'public/fonts/OFL-SpaceGrotesk.txt',
      'public/fonts/OFL-Marcellus.txt',
    ]) {
      expect(() => read(path)).not.toThrow();
      expect(notice).toContain(path);
    }
  });

  it('is linked from Credits at the paths the fonts actually ship under', () => {
    // public/fonts ships one OFL per typeface; the page pointed at a
    // combined /fonts/OFL.txt that has never existed.
    const credits = read('src/areas/docs/pages/CreditsPage.tsx');
    expect(credits).not.toContain('/fonts/OFL.txt');
    expect(credits).toContain('/fonts/OFL-SpaceGrotesk.txt');
    expect(credits).toContain('/fonts/OFL-Marcellus.txt');
  });
});

describe('the guide’s house style', () => {
  /** A .tsx file with its comments taken out, which is roughly its copy.
   * Block comments carry the design notes, JSX comments the asides inside
   * the markup, and the em-dash rule governs neither. */
  const copyOf = (path: string): string =>
    read(path)
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
      .replace(/^\s*\/\/.*$/gm, '');

  it('keeps em dashes out of the copy these pages put on screen', () => {
    // The repo has already run this pass twice over the older guide
    // pages. These two are the newest copy in it, and the rule is the
    // same: the dash becomes a full stop where the clause stands alone, a
    // comma where it was an aside, a colon where what follows explains
    // what came before. Code comments keep theirs; they are not copy.
    for (const path of [
      'src/areas/docs/pages/LicensePage.tsx',
      'src/areas/replays/replaysScreen.tsx',
    ]) {
      expect(copyOf(path)).not.toContain('\u2014');
    }
  });
});

describe('what the page promises about recording a match', () => {
  it('states the floor an abandoned match has to clear', () => {
    // The page promises "quit after the first half-minute". If the floor
    // in replayUpload.ts moves, the promise is wrong and this fails.
    expect(read('src/app/replayUpload.ts')).toContain(
      'MIN_ABANDONED_TICKS = Math.round(30_000 / TICK_MS)',
    );
    expect(read(PAGE)).toContain('half-minute');
  });

  it('tells the reader the one way to send nothing', () => {
    // There is no opt-out switch, so the page's answer has to be the true
    // one: solo play is a local sim and works with the network off.
    expect(read(PAGE)).toContain('play with the network off');
  });

  it('says matches may be kept and used as training data', () => {
    // The reason the shelf exists at all, and the one a player would most
    // want stated rather than left to infer from a listing they cannot
    // see. Checked as a claim, not as a turn of phrase: the words may be
    // rewritten, the disclosure may not quietly go missing.
    const page = read(PAGE);
    expect(page).toContain('training');
    expect(page).toContain('training data');
    expect(page).toContain('computer players');
  });

  it('keeps the shelf’s pruning from reading as a promise of deletion', () => {
    // The server drops the oldest recordings as new ones arrive
    // (replayUploads.ts), which is housekeeping on one listing — not
    // deletion, and no undoing of a model that has already learned from a
    // game. A page implying otherwise would be worse than no page, so the
    // caveat is checked as carefully as the promise.
    const page = read(PAGE);
    expect(page).toContain('not a promise of deletion');
    expect(page).toContain('cannot be untaught');
    // And the pruning it is describing is really there.
    const store = read('server/src/replayUploads.ts');
    expect(store).toContain('MAX_STORED_REPLAYS');
    expect(store).toContain('pruneStoredReplays');
  });

  it('admits that multiplayer chat rides along', () => {
    // The relay records what is said at the table into the replay, so the
    // page cannot describe a recording as holding only orders.
    expect(read('server/src/rooms.ts')).toContain('recordChat');
    expect(read(PAGE)).toContain('chat line');
  });
});
