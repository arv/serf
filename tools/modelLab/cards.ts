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
    sub: 'No inputs but a coastline. The pack has no boats, nets or fish, so all three cost the same handful of hand-built parts; what you are picking is the shape that says “this one needs water”.',
    pick: 'Fish house on stilts. It is the only one that cannot be mistaken for a land building at village zoom, which matters when the placement rule is the whole point.',
    extra: 'EXTRA settles this one. Its pier, its rowboats and its shipyard replace every hand-built part on these three cards except the fish themselves — drop those files in and the fishery becomes a pack-only building like the mill.',
  },
  {
    slot: 'livestock',
    name: 'Livestock',
    recipe: 'wheat → food',
    sub: 'The pack has fences, gates and troughs’ worth of props, but no animals at all. Pigs and hens are ours in every option, so the real question is how many buildings this becomes.',
    pick: 'Hen yard first, pig pen later. Hens are the smaller, cheaper, earlier building; pigs eat more wheat and pay more food, which gives the pair a natural tier.',
    extra: 'EXTRA ships a herd — sheep and cattle in four coats, plus a horse and cart. Those are better animals than mine and they tile into the same pens; the hens have no equivalent there, so a hen yard would stay hand-built either way.',
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
