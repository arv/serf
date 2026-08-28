import { BUILDING_DEFS, type BuildingTypeId } from '../../sim/defs/buildings';
import { GOODS } from '../../sim/defs/goods';
import { TECH_DEFS, type TechId } from '../../sim/defs/techs';
import { UNIT_DEFS, type UnitTypeId } from '../../sim/defs/units';
import { goodName, techName, unitName } from '../../ui/names';
import { buildingHref, goodHref, techHref, unitHref } from './routes';
import { GoodId } from '../../sim/defs/goods';
import { GOOD_KEYS } from '../../sim/defs/goods';

/**
 * Which words in a sentence name something with a page of its own.
 *
 * The alternative — writing links by hand into every description — would
 * leave the game's own strings (a tech's `desc`) plain and would go stale
 * the moment a good is renamed. So the terms are read off the same tables
 * the rest of the guide reads, and the prose stays plain data.
 *
 * Pure, and deliberately free of Solid: the rules below are the fiddly
 * part, and they are worth testing without standing up a DOM.
 */

interface Term {
  text: string;
  href: string;
}

/**
 * Words that name something here and also mean something ordinary in
 * English. Linking these on sight gave "the Masonry [road] pass" and
 * "[well] past when a rush arrives", so they count as a name only when the
 * sentence marks them as one: a capital somewhere other than the first
 * word, or an article in front (see ARTICLES).
 */
const AMBIGUOUS = new Set([
  'well',
  'road',
  'house',
  'mill',
  'smith',
  'bow',
  'bandit',
  'food',
  // Tech names that are also plain nouns: "the barracks keeps a cask" is
  // not a reference to Ale Rations, and a bellows is a thing on a forge.
  'festivals',
  'bellows',
]);

/**
 * A word in front of an ambiguous name that makes it a thing rather than a
 * manner: "at the well" is the building, "well past" is not. Nothing in
 * English puts an article before the adverb, which is what makes this a
 * reliable tell.
 */
const ARTICLES = new Set(['a', 'an', 'the', 'every', 'each', 'one', 'its', 'their']);

/**
 * What the prose calls a thing when it does not use its name. These read
 * far better than forcing the descriptions to say "Food" where they mean
 * bread, or "Wheat Farm" where a sentence would just say the farm — and
 * the reader still gets the link.
 */
const SYNONYMS: { text: string; href: string }[] = [
  { text: 'bread', href: goodHref(GoodId.food) },
  { text: 'loaf', href: goodHref(GoodId.food) },
  { text: 'loaves', href: goodHref(GoodId.food) },
  { text: 'timber', href: goodHref(GoodId.wood) },
  { text: 'grain', href: goodHref(GoodId.wheat) },
  { text: 'coin', href: goodHref(GoodId.silver) },
  { text: 'farm', href: buildingHref('wheatFarm') },
  // No 'keep' for the Castle: the plural rule below would make a link of
  // the verb, and "the barracks keeps a cask" is live text.
];

function collectTerms(): Term[] {
  const terms: Term[] = [];
  for (const id of Object.keys(BUILDING_DEFS) as BuildingTypeId[]) {
    terms.push({ text: BUILDING_DEFS[id].name, href: buildingHref(id) });
  }
  for (const id of Object.keys(UNIT_DEFS) as UnitTypeId[]) {
    const name = unitName(id);
    const href = unitHref(id);
    terms.push({ text: name, href });
    // The plural the sentence actually uses: a trailing 's' covers Serfs
    // and Archers, but Spearman pluralises the old way.
    if (name.endsWith('man')) terms.push({ text: `${name.slice(0, -3)}men`, href });
  }
  for (const id of GOODS as readonly GoodId[]) {
    const href = goodHref(id);
    terms.push({ text: goodName(id), href });
    // 'rod' is what a sentence says; 'Fishing Rod' is the display name.
    const key = GOOD_KEYS[id];
    if (goodName(id).toLowerCase() !== key) terms.push({ text: key, href });
  }
  for (const id of Object.keys(TECH_DEFS) as TechId[]) {
    terms.push({ text: techName(id), href: techHref(id) });
  }
  terms.push(...SYNONYMS);
  // Longest first so "Iron Mine" beats "Iron" and "Bandit Archer" beats
  // "Bandit" — a JS alternation takes the first branch that matches.
  return terms.sort((a, b) => b.text.length - a.text.length);
}

const TERMS = collectTerms();
const HREF_OF = new Map(TERMS.map((t) => [t.text.toLowerCase(), t.href]));

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Every name in one pass, with an optional plural 's'. */
const PATTERN = new RegExp(`\\b(${TERMS.map((t) => escapeRe(t.text)).join('|')})(s)?\\b`, 'gi');

export type ProsePiece = string | { text: string; href: string };

/**
 * Split `text` into plain runs and linked ones. A term links only on its
 * first mention — a paragraph should read as prose, not as a link farm —
 * and never to `self`, the page already being read.
 */
export function linkifyProse(text: string, self?: string): ProsePiece[] {
  const pieces: ProsePiece[] = [];
  const linked = new Set<string>();
  let last = 0;
  PATTERN.lastIndex = 0;
  for (let m = PATTERN.exec(text); m !== null; m = PATTERN.exec(text)) {
    const whole = m[0];
    const term = m[1]!;
    const href = HREF_OF.get(term.toLowerCase());
    const preceding = text.slice(0, m.index).trimEnd();
    // Every sentence opens with a capital, so the first word of one says
    // nothing about proper-noun-hood — not just the first word of the
    // whole string.
    const opensSentence = preceding === '' || /[.!?]$/.test(preceding);
    const capitalised = term[0] !== term[0]!.toLowerCase() && !opensSentence;
    const article = preceding.split(/[\s(]+/).pop();
    const named = capitalised || ARTICLES.has((article ?? '').toLowerCase());
    if (
      href === undefined ||
      href === self ||
      linked.has(href) ||
      (AMBIGUOUS.has(term.toLowerCase()) && !named)
    ) {
      continue;
    }
    if (m.index > last) pieces.push(text.slice(last, m.index));
    pieces.push({ text: whole, href });
    linked.add(href);
    last = m.index + whole.length;
  }
  if (last < text.length) pieces.push(text.slice(last));
  return pieces;
}
