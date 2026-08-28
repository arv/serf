import {VARIANTS, type Variant} from './variants';

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
   * What the paid EXTRA pack hands us here. The free pack is what most of
   * these compositions are built from; EXTRA is not on GitHub, and only the
   * handful of its models the fishery actually uses are vendored into
   * public/models/kaykit/extra. The rest of a slot's note is what would
   * become possible if the whole pack landed there.
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
    sub: 'Nothing in any pack is a bakery, so in the end the whole building is ours.',
    pick: 'Every shell the pack could have lent this slot is either a house or already someone else’s, and the one we were using was a house — with a clay dome bolted to its flank, which is the blacksmith’s silhouette exactly: the pack ships the forge as a domed stone oven under a round flue. Modelling it settles that, and drawing it with the pack’s own texture settles the rest: the atlas is not a grid of flat swatches but a set of nine-stop gradients, and Kay rides them, so a building painted in flat colours picked out of it can never sit beside one that is not. The oven takes a lighter slice of the same grey ramp as the walls rather than a colour of its own.',
    extra:
      'Nothing in EXTRA changes this one. The awning stall is the nearest thing to a food shop in any KayKit pack, but a stall is not a bakehouse and it has nowhere to put a fire.',
  },
  {
    slot: 'fishery',
    name: 'Fishery',
    recipe: 'shore → food',
    sub: 'No inputs at all — a coastline is the only thing it consumes. The early food against the bakery’s late one: a third of the rate, none of the chain.',
    pick: 'The one building here with nothing hand-built on it but a sign post. It also brought the game its first placement rule that is not about ore — touching water, and turned to face it — and the only decor that moves besides the well’s windlass.',
    extra:
      'In and working, and the only slot that needed EXTRA at all: the shipyard is the hut, the docks are the pier, and the anchor and boat rack are the quay. Those four are vendored. The fish are the last thing still ours, and no KayKit pack has one.',
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
  return s.replace(
    /[&<>"]/g,
    c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'})[c]!,
  );
}

function card(v: Variant): string {
  const pack = v.pack.map(p => `<code>${esc(p)}</code>`).join(' ');
  const made = v.handmade.length
    ? v.handmade.map(p => `<span>${esc(p)}</span>`).join(' ')
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
  return SLOTS.map(s => {
    const items = VARIANTS.filter(v => v.slot === s.slot)
      .map(card)
      .join('');
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
