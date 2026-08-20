import {
  BUILDING_DEFS,
  gatherOrigin,
  gatherRecipeOf,
  OUTPUT_CAP,
  type BuildingTypeId,
} from './defs/buildings.ts';
import { findResourcesNear, nearestResource, RESOURCE_CODE } from './map.ts';
import type { Building, EntityId, Owner } from './entities.ts';
import type { SimCommand } from './commands.ts';
import type { World } from './world.ts';

/**
 * The seat's economy as a set of named rules instead of a cascade.
 *
 * Everything else the brain decides is a priority chain — the first branch
 * whose condition holds wins and the rest are suppressed. That shape has
 * been measured three times in this repo and lost every time: the first
 * posture cascade lost to its own best constant (p = 0.012), the retuned
 * one never beat dice (p = 0.080 at eighty seeds), and conditioning it on
 * an opponent archetype lost again (p = 0.50). A chain can only ever be as
 * good as its single best branch for the situation it is in.
 *
 * Age of Empires II's AI is the other shape, and it is the one this file
 * borrows: a few thousand `(defrule (conditions) => (actions))` clauses,
 * re-read on a timer, each firing on its own when its conditions hold. The
 * variety comes out of rules *composing* — several answering the same beat
 * — rather than out of any one of them being clever.
 *
 * What is kept from the cascade world is the ability to say which rule
 * earned a win. Every rule has an id, and a sweep can run with any subset
 * enabled (`--engine rules:<id>,<id>` in the lab), so a rule that pays and
 * a rule that merely fires can be told apart. That handle is the whole
 * reason the posture work produced findings instead of opinions, and a
 * hundred interacting rules that can only be measured in aggregate would
 * have thrown it away.
 *
 * Two mechanisms keep composition from turning into a brawl:
 *
 * - **Claims.** A rule names the buildings it is about to order around.
 *   Two rules cannot both order the same hut in one beat; the earlier one
 *   in the table wins and the later one simply does not fire this time.
 * - **Groups.** Rules in the same group are alternatives to each other, so
 *   at most one fires per beat. That is how the two stall-recovery rules
 *   keep the exact first-wins behaviour they were measured with, while
 *   rules in different groups are free to answer the same beat together.
 *
 * Determinism: the table is a fixed array, buildings are walked in id
 * order, and nothing here reads a clock or an RNG.
 */

export type EconomyRuleId = 'resiteExtractor' | 'freeCappedHauler';

/** What a rule reads. Assembled once per beat by the brain and handed to
 * every rule, so no rule can quietly widen what it depends on. */
export interface RuleContext {
  world: World;
  owner: Owner;
  /** This seat's buildings, ascending id — the iteration order every rule
   * must use, since the sim's own tie-breaks are by id. */
  mine: Building[];
  /** The storehouse shelf. */
  stock: Record<string, number>;
  /** Loose hands: nothing in the village moves without one. */
  serfCount: number;
  /** The stall watchdog's reading for this beat. */
  stalled: boolean;
}

export interface RuleFiring {
  commands: SimCommand[];
  /** Buildings this firing orders around, so a later rule cannot also. */
  claims: EntityId[];
}

export interface EconomyRule {
  id: EconomyRuleId;
  /** The situation it answers, in one line. */
  when: string;
  /** Rules sharing a group are alternatives: at most one fires per beat. */
  group?: string;
  /** null when the rule has nothing to say this beat. */
  fire(ctx: RuleContext): RuleFiring | null;
}


/**
 * Re-site a worked-out extractor.
 *
 * A gatherer with nothing left in reach is a hand and a hut spent on ground
 * that will never yield again — tree groves regrow only on standing tiles
 * (`systems/production.ts` `regrow`), so a woodcutter that cleared its
 * radius sits on dead earth for the rest of the match, and a seam is simply
 * finished. Selling it is the whole move: the sale hands back half the
 * materials AND the resident, and the build order maintains standing counts,
 * so the next beat places the replacement — against a live deposit, because
 * `spotFor` anchors on `nearestResource`, which only counts tiles with
 * amount left.
 *
 * Two conditions keep it from making things worse: there has to be somewhere
 * live to re-site onto, and the shelf has to already hold the half the
 * refund will not cover. Failing either, selling is just losing a building.
 */
const resiteExtractor: EconomyRule = {
  id: 'resiteExtractor',
  when: 'a gatherer has exhausted everything inside its radius',
  group: 'stallRecovery',
  fire(ctx) {
    if (!ctx.stalled) return null;
    for (const b of ctx.mine) {
      if (b.state !== 'built') continue;
      const def = BUILDING_DEFS[b.type as BuildingTypeId];
      const recipe = gatherRecipeOf(def);
      if (!recipe) continue;
      const code = RESOURCE_CODE[recipe.resource]!;
      const c = gatherOrigin(def, b.x, b.y);
      if (findResourcesNear(ctx.world.map, c.x, c.y, code, recipe.radius, 1).length > 0) continue;
      if (nearestResource(ctx.world.map, code, b.x, b.y) < 0) continue; // nowhere to go
      const cost = def.cost as Record<string, number>;
      const canRebuild = Object.entries(cost).every(
        ([good, n]) => (ctx.stock[good] ?? 0) + Math.floor(n / 2) >= n,
      );
      if (!canRebuild) continue;
      return { commands: [{ kind: 'sellBuilding', buildingId: b.id }], claims: [b.id] };
    }
    return null;
  },
};

/**
 * Buy a hauler with a post nobody is using.
 *
 * Nothing in the village moves without a loose serf — the haul matcher only
 * ever offers a job to an idle one (`systems/logistics.ts`) — and a seat can
 * spend its last hand legitimately, by binding it to a hut or handing it to
 * the barracks as a recruit. Seed 9 ends exactly there: every extractor at
 * cap, four silver sitting in the silver mine, and nobody to carry it the
 * twenty tiles to the storehouse that would pay for the hand that carries it.
 *
 * The post to empty is one whose output buffer is already full, which is
 * precisely a post producing nothing: its worker stands at a capped hut
 * waiting for a haul that cannot come. Freeing him costs no production at
 * all, and it is self-limiting — once he has drained the buffer the post is
 * under cap again, and staffing re-fills it when the dismissal backoff runs
 * out.
 *
 * Only a worker reading idle is taken. A hand released mid-trip used to be
 * lost for good; `unbindWorker` resets the task now, but a rule whose whole
 * purpose is producing a hauler should not lean on that.
 */
const freeCappedHauler: EconomyRule = {
  id: 'freeCappedHauler',
  when: 'the village has no loose hand and a post is sitting at its output cap',
  group: 'stallRecovery',
  fire(ctx) {
    if (!ctx.stalled || ctx.serfCount > 0) return null;
    for (const b of ctx.mine) {
      if (b.state !== 'built' || b.workerId === undefined) continue;
      const out = gatherRecipeOf(BUILDING_DEFS[b.type as BuildingTypeId])?.output;
      if (out === undefined || (b.stock[out] ?? 0) < OUTPUT_CAP) continue;
      const worker = ctx.world.units.get(b.workerId);
      if (!worker || worker.dead || worker.task.t !== 'idle') continue;
      return { commands: [{ kind: 'dismissWorker', buildingId: b.id }], claims: [b.id] };
    }
    return null;
  },
};

/**
 * The table. Order is priority: an earlier rule's claims win, and an earlier
 * rule in a group fires instead of a later one. Adding a rule means adding it
 * here and to `EconomyRuleId`, so nothing fires that cannot be named — and
 * therefore nothing fires that cannot be ablated.
 */
export const ECONOMY_RULES: readonly EconomyRule[] = [resiteExtractor, freeCappedHauler];

export const ALL_ECONOMY_RULES: readonly EconomyRuleId[] = ECONOMY_RULES.map((r) => r.id);

/**
 * Every applicable rule fires, subject to claims and groups. Commands come
 * back in table order, which is what makes a sweep reproducible.
 *
 * `enabled` is the ablation handle: pass a subset to measure what one rule is
 * worth, or an empty set to turn the layer off entirely.
 */
export function runEconomyRules(
  ctx: RuleContext,
  enabled: ReadonlySet<EconomyRuleId>,
  /** The table to run. Defaults to the real one; tests pass a table of
   * stand-ins so the runner itself is exercised rather than re-implemented
   * beside it. */
  table: readonly EconomyRule[] = ECONOMY_RULES,
): { commands: SimCommand[]; fired: EconomyRuleId[] } {
  const commands: SimCommand[] = [];
  const fired: EconomyRuleId[] = [];
  const claimed = new Set<EntityId>();
  const groupsFired = new Set<string>();

  for (const rule of table) {
    if (!enabled.has(rule.id)) continue;
    if (rule.group !== undefined && groupsFired.has(rule.group)) continue;
    const firing = rule.fire(ctx);
    if (!firing) continue;
    if (firing.claims.some((id) => claimed.has(id))) continue;
    for (const id of firing.claims) claimed.add(id);
    if (rule.group !== undefined) groupsFired.add(rule.group);
    commands.push(...firing.commands);
    fired.push(rule.id);
  }
  return { commands, fired };
}
