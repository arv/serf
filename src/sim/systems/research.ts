import * as BuildingState from '../buildingStateEnum.ts';
import {FESTIVAL_DURATION} from '../defs/balance.ts';
import * as BuildingTypeId from '../defs/buildingTypeIdEnum.ts';
import * as GoodId from '../defs/goodIdEnum.ts';
import {goodKeys} from '../defs/goods.ts';
import * as TechEffectKind from '../defs/techEffectKindEnum.ts';
import * as TechId from '../defs/techIdEnum.ts';
import {TECH_DEFS} from '../defs/techs.ts';
import type {Building, Owner} from '../entities.ts';
import {stillWants, type World} from '../world.ts';
import {abortJob} from './logistics.ts';

/**
 * Ticks every player's active research and festival buff.
 *
 * A study is *ordered* by the research command (tick.ts), which writes its
 * bill on the Abbey and nothing else: the village carries the goods there
 * load by load like a site's materials, and the clock below does not start
 * until the last one is in. Completion applies one-shot effects here
 * (currently just paving — unlock checks read `researched` directly).
 */
export function researchSystem(world: World): void {
  // Each owner's first built abbey (the only one the old per-player scan
  // ever touched — it broke after the first match), gathered lazily in one
  // pass instead of a full building scan per player per tick.
  let abbeys: Map<Owner, Building> | undefined;
  const abbeyOf = (owner: Owner): Building | undefined => {
    if (!abbeys) {
      abbeys = new Map();
      for (const b of world.buildings.values()) {
        if (
          !b.dead &&
          b.type === BuildingTypeId.abbey &&
          b.state === BuildingState.built &&
          !abbeys.has(b.owner)
        ) {
          abbeys.set(b.owner, b);
        }
      }
    }
    return abbeys.get(owner);
  };

  for (const p of world.players) {
    const t = p.techs;

    // Waiting on the haul: the study is ordered, the bill is on the Abbey,
    // and nothing happens until the serfs have carried all of it in. What
    // ends the wait is the last load itself (settleResearchBill, called
    // from the Abbey's door), not a check here — this pass runs before
    // logistics does, so it would always be a tick behind the delivery it
    // was watching for. All that is left here is the other way a wait
    // ends: the roof came down (or was sold) with the books still on the
    // road. The order dies with it and the slot opens again — order it at
    // another Abbey. Whatever was already carried in is spent; it was
    // consumed at the door, like a repair's stone.
    if (t.active && !t.active.started) {
      const abbey = world.buildings.get(t.active.abbey);
      if (!abbey || abbey.dead || abbey.state !== BuildingState.built)
        t.active = undefined;
    }

    if (t.active?.started) {
      t.active.ticksLeft--;
      if (t.active.ticksLeft <= 0) {
        const def = TECH_DEFS[t.active.tech];
        t.researched.push(def.id);
        for (const effect of def.effects) {
          if (effect.kind === TechEffectKind.unlockPaving)
            p.pavingUnlocked = true;
        }
        t.active = undefined;
      }
    }

    if (t.festivalTicksLeft > 0) {
      t.festivalTicksLeft--;
      continue;
    }

    // Festivals: this player's built abbey burns 1 ale for a buff.
    if (!t.researched.includes(TechId.festivals)) continue;
    const abbey = abbeyOf(p.id);
    if (abbey && (abbey.inputs[GoodId.ale] ?? 0) > 0) {
      abbey.inputs[GoodId.ale] = (abbey.inputs[GoodId.ale] ?? 0) - 1;
      world.ledger.consumed[GoodId.ale] =
        (world.ledger.consumed[GoodId.ale] ?? 0) + 1;
      t.festivalTicksLeft = FESTIVAL_DURATION;
    }
  }
}

/**
 * Call the study off: the bill on the Abbey goes, the hauls walking it
 * there are called back, and the order goes with them.
 *
 * settleResearchBill's mirror — one opens the books, this one closes them
 * unopened — and cancelRepair's twin, which does the same three things for
 * a repair (systems/construction.ts). It exists because a bill can be one
 * the village will never be able to carry: Gilded Arms ordered with no
 * gold on the shelf and no Deep Mining to dig any is a study that waits
 * forever, and a seat studies one thing at a time, so the whole tree waits
 * behind it.
 *
 * The jobs are aborted HERE rather than left to the haul reconciler, which
 * would find them on its own — it runs one pass in MATCHER_INTERVAL ticks
 * (systems/logistics.ts), and in the ticks between, an open study haul can
 * still be dispatched and a walking one still reach the door. With the
 * bill gone, deliverGood has no study branch left to take, and the load
 * ends up on the Abbey's shelf, which is not a shelf anything ever leaves
 * from. Cargo is kept (`keepCargo`), so the good stays in the serf's hands
 * for rehomeCarriedGoods to find another home for.
 *
 * What was already carried IN stays spent. A study's load is consumed at
 * the threshold, load by load, the way a repair's stone is — the Abbey has
 * nothing to take it back off, so there is nothing here to refund.
 */
export function abandonResearch(world: World, playerId: Owner): void {
  const techs = world.players[playerId]?.techs;
  if (!techs?.active) return;
  const abbey = world.buildings.get(techs.active.abbey);
  if (abbey?.researchNeeds) {
    const bill = goodKeys(abbey.researchNeeds);
    delete abbey.researchNeeds;
    // The bill first, then its clocks — and only the ones nobody else is
    // keeping. An Abbey can owe a repair in the same stone and sip the
    // festival's ale in the same barrel; stillWants (world.ts) is the one
    // place that knows, and the matcher's own clearDemandAge asks it too.
    for (const g of bill) {
      if (!stillWants(world, abbey, g)) delete abbey.demandSince[g];
    }
    for (const job of world.jobs.values()) {
      if (job.research && job.to === abbey.id)
        abortJob(world, job, 'study called off', true);
    }
  }
  techs.active = undefined;
}
