import { describe, expect, it } from 'vitest';
import { linkifyProse } from './linkify';

/** The href a term was linked to, or undefined if it was left as prose. */
function hrefFor(text: string, term: string, self?: string): string | undefined {
  for (const piece of linkifyProse(text, self)) {
    if (typeof piece !== 'string' && piece.text.toLowerCase() === term.toLowerCase()) {
      return piece.href;
    }
  }
  return undefined;
}

/** The whole sentence back, with linked runs bracketed. */
function marked(text: string, self?: string): string {
  return linkifyProse(text, self)
    .map((p) => (typeof p === 'string' ? p : `[${p.text}]`))
    .join('');
}

describe('prose linking', () => {
  it('links the things a sentence names', () => {
    expect(hrefFor('Wheat and water into ale.', 'ale')).toBe('/docs/goods/ale');
    expect(hrefFor('Trained at the Barracks.', 'Barracks')).toBe('/docs/buildings/barracks');
    expect(hrefFor('Kites knights all day.', 'knights')).toBe('/docs/units/knight');
    expect(hrefFor('Wants Brewing researched.', 'Brewing')).toBe('/docs/techs#tech-brewing');
  });

  it('follows plurals, including the old one', () => {
    // A trailing 's' covers most of them; Spearman does not take one.
    expect(hrefFor('Unlocks the Barracks and Spearmen.', 'Spearmen')).toBe('/docs/units/spearman');
    expect(hrefFor('Bring spears and walls.', 'spears')).toBe('/docs/goods/spear');
  });

  it('follows the words prose actually uses for a good', () => {
    expect(hrefFor('The head of the bread chain.', 'bread')).toBe('/docs/goods/food');
    expect(hrefFor('Ten beds of timber.', 'timber')).toBe('/docs/goods/wood');
  });

  it('prefers the longest name', () => {
    // Otherwise "Iron Mine" reads as a mention of iron, and the reader is
    // sent to the ore when the sentence named the building.
    expect(hrefFor('Ore from the iron mine.', 'iron mine')).toBe('/docs/buildings/ironMine');
    expect(hrefFor('A wave of Bandit Archers.', 'Bandit Archers')).toBe('/docs/units/banditArcher');
  });

  it('links a term once, however often it is named', () => {
    expect(marked('Wood, more wood, and wood again.')).toBe('[Wood], more wood, and wood again.');
  });

  it('never links the page being read', () => {
    expect(hrefFor('Ale is brewed here.', 'Ale', '/docs/goods/ale')).toBeUndefined();
  });

  it('does not turn a verb into a link', () => {
    // "keep" was a synonym for the Castle, and the plural rule then made a
    // link of "keeps" in the live Ale Rations description.
    expect(marked('The barracks keeps a cask: each soldier drinks 1 ale.')).toBe(
      'The [barracks] keeps a cask: each soldier drinks 1 [ale].',
    );
  });

  it('leaves ordinary English alone', () => {
    // Every one of these is also the name of something, and linking them
    // on sight is what the ambiguity rules exist to prevent.
    expect(marked('well past when a rush arrives')).toBe('well past when a rush arrives');
    expect(marked('placed by the Masonry road pass')).toBe('placed by the [Masonry] road pass');
    expect(hrefFor('the barracks keeps a cask of festivals', 'festivals')).toBeUndefined();
  });

  it('links an ambiguous word the sentence marks as a name', () => {
    // Either a capital of its own...
    expect(hrefFor('Water is drawn at the Well.', 'Well')).toBe('/docs/buildings/well');
    // ...or an article, which no adverb ever takes.
    expect(hrefFor('Drawn at the well by whoever needs it.', 'well')).toBe(
      '/docs/buildings/well',
    );
    expect(hrefFor('one mill is meant to serve two', 'mill')).toBe('/docs/buildings/mill');
    expect(hrefFor('the whole of a bow', 'bow')).toBe('/docs/goods/bow');
  });

  it('follows the short name a sentence gives a building', () => {
    expect(hrefFor('the farm all start here', 'farm')).toBe('/docs/buildings/wheatFarm');
    expect(hrefFor('slower than the farm that feeds it', 'farm')).toBe(
      '/docs/buildings/wheatFarm',
    );
  });

  it('does not read a leading capital as a proper noun', () => {
    // "Food comes out slowly" opens a sentence; the capital is the
    // sentence's, not the good's.
    expect(hrefFor('Food comes out slowly here.', 'Food')).toBeUndefined();
  });
});
