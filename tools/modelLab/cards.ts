import { VARIANTS, type Variant } from './variants';

/**
 * Card markup for the gallery, generated from the variant list so the
 * copy on the page and the model on the plate can never drift apart.
 */

interface Slot {
  slot: Variant['slot'];
  name: string;
  /** The recipe, as an eyebrow — this is a chain, and the arrows carry it. */
  recipe: string;
  sub: string;
  /** Which one I would take, and why. */
  pick: string;
  /**
   * What the paid EXTRA pack would hand us here. The free pack is what
   * these compositions are built from — EXTRA is not on GitHub and is not
   * in the checkout — but several hand-built parts stop being necessary
   * the moment its files land in public/models/kaykit.
   */
  extra?: string;
}

const SLOTS: Slot[] = [
  {
    slot: 'mill',
    name: 'Mill',
    recipe: 'wheat → flour',
    sub: 'The one slot the pack answered outright.',
    pick: 'It stands anywhere, and the watermill’s riverbank rule is a constraint the mill does not need to earn its keep. The watermill stays in the drawer as a later variant.',
  },
  {
    slot: 'bakery',
    name: 'Bakery',
    recipe: 'flour + water → food',
    sub: 'Nothing in any pack is a bakery, so the oven is ours either way.',
    pick: 'The oven house — a purpose-built stone bakehouse whose whole front is the arch — is still the better silhouette. This went in first because it needed no new machinery in the renderer, and the swap is contained.',
    extra: 'EXTRA’s awning stall with the hanging meat and grain sacks is the closest thing to a food shop in any KayKit pack — worth trying as a fourth bakery, or holding back for a butcher if livestock ships its own building.',
  },
  {
    slot: 'fishery',
    name: 'Fishery',
    recipe: 'shore → food',
    sub: 'No inputs at all — a coastline is the only thing it consumes.',
    pick: 'The one building here with nothing hand-built on it but its sign. It also brought the game its first placement rule that is not about ore: touching water, and turned to face it.',
    extra: 'In and working. The pier runs out from the fisherman’s hut, the camp has its proper tent, and the pack’s own boat replaced the hull I modelled. The fish are the last thing still ours, and no KayKit pack has one.',
  },
  {
    slot: 'livestock',
    name: 'Livestock',
    recipe: 'wheat → food',
    sub: 'The shed and its fence are the pack’s; the birds are not.',
    pick: 'Wheat goes in, food comes out — one building and one hand, against the mill and bakery’s two of each, at half the food per grain. Bread for a tight village; birds for land you can spare.',
    extra: 'The stables are in. There are no animals in any KayKit pack — no sheep, no cattle — so the hens are ours, and were always going to be.',
  },
  {
    slot: 'goods',
    name: 'The goods',
    recipe: 'what a serf carries',
    sub: 'Every new good needs a prop on a serf’s shoulders and a pile in the yard. Still undecided — these are shown at carry scale, so drag them the same way.',
    pick: 'Loaves in the pack’s open crate for food, and the tan sack repainted near-white for flour. Both stay inside the atlas we already ship; the Restaurant Bits crate is the better model but drags a second texture in for one prop.',
  },
];

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

function card(v: Variant): string {
  const pack = v.pack.map((p) => `<code>${esc(p)}</code>`).join(' ');
  const made = v.handmade.length
    ? v.handmade.map((p) => `<span>${esc(p)}</span>`).join(' ')
    : '<span class="none">nothing — pack only</span>';
  return `
    <article class="card" data-variant="${v.id}">
      <div class="stage" data-stage>
        <span class="hint">drag to turn</span>
      </div>
      <div class="body">
        <h3>${esc(v.title)} <span class="fp">${v.w}×${v.h}</span></h3>
        <p>${esc(v.blurb)}</p>
        <dl>
          <dt>from the pack</dt><dd class="pack">${pack}</dd>
          <dt>we build</dt><dd class="made">${made}</dd>
        </dl>
      </div>
    </article>`;
}

export function galleryMarkup(): string {
  return SLOTS.map((s) => {
    const items = VARIANTS.filter((v) => v.slot === s.slot).map(card).join('');
    return `
      <section class="slot" id="${s.slot}">
        <header class="slot-head">
          <p class="recipe">${esc(s.recipe)}</p>
          <h2>${esc(s.name)}</h2>
          <p>${esc(s.sub)}</p>
        </header>
        <div class="cards">${items}</div>
        <p class="pick"><span>why this one</span>${esc(s.pick)}</p>
        ${s.extra ? `<p class="extra"><span>with EXTRA</span>${esc(s.extra)}</p>` : ''}
      </section>`;
  }).join('');
}
