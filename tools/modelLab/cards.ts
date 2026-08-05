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
    sub: 'The one slot the pack already answers. Both candidates ship a moving part as its own node, so either can turn while the mill is staffed the way the well crank does.',
    pick: 'Windmill. It stands anywhere, it is the taller silhouette, and the watermill’s riverbank rule is a constraint the mill does not need to earn its keep — keep the watermill in the drawer as a later variant.',
  },
  {
    slot: 'bakery',
    name: 'Bakery',
    recipe: 'flour + water → food',
    sub: 'Nothing in the pack is a bakery, so every option builds an oven. What they differ on is what the oven is attached to, and how much of the town’s existing vocabulary they reuse.',
    pick: 'Oven house. The bake-house is cheaper to build but wears the house model, and the village already reads houses as population — a food building that looks like a house will be misread every time.',
    extra: 'EXTRA’s awning stall with the hanging meat and grain sacks is the closest thing to a food shop in any KayKit pack — worth trying as a fourth bakery, or holding back for a butcher if livestock ships its own building.',
  },
  {
    slot: 'fishery',
    name: 'Fishery',
    recipe: 'shore → food',
    sub: 'No inputs but a coastline. What you are picking is the shape that says “this one needs water” — and since the EXTRA pier and shipyard landed, how little of it we have to build ourselves.',
    pick: 'Shipyard. It arrived with the EXTRA pack and settles the section: a boat on the slipway, an anchor, the pier beside it, and not one hand-built part. It also reads as an industry rather than a hut, which the other three never quite manage.',
    extra: 'In and working. The pier now runs out from the fisherman’s hut too, and the camp got the proper tent. The rowboats and the fish are the only things still ours — the boats are in a folder we have not seen yet.',
  },
  {
    slot: 'livestock',
    name: 'Livestock',
    recipe: 'wheat → food',
    sub: 'No pack has animals for this — mine are hand-built in all four. What differs is how much of the pen comes for free, and the EXTRA stables come with their own fence, hay and awning.',
    pick: 'Built, and it is the two combined: the EXTRA stables for the shed and its own rail fence, with hens in the pen. Wheat goes in, food comes out — one building and one hand, against the mill and bakery’s two of each, at half the food per grain. Bread for a tight village; birds for land you can spare.',
    extra: 'The stables are in. There are no animals in any KayKit pack — no sheep, no cattle — so the hens are ours, and were always going to be.',
  },
  {
    slot: 'goods',
    name: 'The goods',
    recipe: 'what a serf carries',
    sub: 'Every new good needs a prop on a serf’s shoulders and a pile in the yard. These are shown at carry scale — drag them the same way.',
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
        <p class="pick"><span>would take</span>${esc(s.pick)}</p>
        ${s.extra ? `<p class="extra"><span>with EXTRA</span>${esc(s.extra)}</p>` : ''}
      </section>`;
  }).join('');
}
