import {
  BUILDING_DEFS,
  gatherOrigin,
  gatherRecipeOf,
  OUTPUT_CAP,
  type BuildingTypeId,
} from './defs/buildings.ts';
import { findResourcesNear, nearestResource, RESOURCE_CODE } from './map.ts';
import { WEAPON_OF } from './defs/units.ts';
import type { AiStrategy } from './defs/aiStrategies.ts';
import type { TechId } from './defs/techs.ts';
import type { UnitTypeId } from './defs/units.ts';
import type { Building, EntityId, Owner } from './entities.ts';
import type { GoodId } from './defs/goods.ts';
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
 * enabled (`--rules <id>,<id>` in the lab, or `--rules none` for none of
 * them), so a rule that pays and a rule that merely fires can be told
 * apart. That handle is the whole reason the posture work produced findings
 * instead of opinions, and a hundred interacting rules measurable only in
 * aggregate would have thrown it away.
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

export type EconomyRuleId =
  | 'resiteExtractor'
  | 'freeCappedHauler'
  | 'resumeDrainedPost'
  | 'forgeTheCounter'
  | 'keepTheQueueWarm';

/**
 * Where in a beat a rule runs.
 *
 * Not decoration: commands are applied in the order they are pushed, and
 * within one tick that order is load-bearing — research spends goods, a sale
 * refunds them, training consumes them. The two phases are the two points the
 * brain already emitted from, so rules keep firing exactly where the code
 * they came from did.
 */
export type RulePhase = 'recovery' | 'production';

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
  /** The seat's effective playbook — printed values with any advice merged
   * over them, which is what the war rules steer by. */
  strategy: AiStrategy;
  /** Is this tech in? Rules may not name a recipe the seat cannot forge. */
  researched: (id: TechId) => boolean;
  /**
   * What scouting says to build against: the class beating the dominant one
   * in the freshest trustworthy sighting, or null when nobody has been seen
   * in force. Handed in rather than derived, so this module stays free of
   * the brain's intel bookkeeping.
   */
  counter: { unit: UnitTypeId; recipe: number } | null;
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
  phase: RulePhase;
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
/*
 * Measured, and it is the rule that does not pay. Ablated over seeds 1-80
 * with `--engine none`: running it alone fires twice and rescues nothing,
 * leaving the same two matches undecided and the same one pinned at the
 * 120k horizon. `freeCappedHauler` alone rescues both.
 *
 * Kept anyway, and not out of sentiment: its condition wants a gatherer with
 * an exhausted radius AND live ground to move to AND enough on the shelf to
 * rebuild, which is simply rare in eighty seeds — six stalled matches is far
 * too thin a sample to delete a rule over. But it is unproven, and the
 * planning that produced it called it the core fix, which the measurement
 * does not support.
 */
const resiteExtractor: EconomyRule = {
  id: 'resiteExtractor',
  when: 'a gatherer has exhausted everything inside its radius',
  phase: 'recovery',
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
 * cap, a capped pile of silver sitting in the silver mine, and nobody to
 * carry it the twenty tiles to the storehouse that would pay for the hand
 * that carries it.
 *
 * The post to empty is one whose output buffer is already full, which is
 * precisely a post producing nothing: its worker stands at a capped hut
 * waiting for a haul that cannot come. Freeing him costs no production at
 * all. Pausing is how a post is emptied — the one lever hands the resident
 * back — and a halted post recruits nobody, so the order sticks until
 * `resumeDrainedPost` below starts the place again once the pile is gone.
 *
 * Only a worker reading idle is taken. A hand released mid-trip used to be
 * lost for good; `unbindWorker` resets the task now, but a rule whose whole
 * purpose is producing a hauler should not lean on that.
 */
/*
 * The rule that carries the result. Ablated over seeds 1-80: alone it fires
 * 26 of the 30 recovery orders and takes the sweep from two undecided
 * matches to none, with the longest match dropping off the 120k horizon to
 * 72986 ticks. The binding constraint on a stalled village was never dead
 * ground — it was having no hand free to carry anything.
 */
const freeCappedHauler: EconomyRule = {
  id: 'freeCappedHauler',
  when: 'the village has no loose hand and a post is sitting at its output cap',
  phase: 'recovery',
  group: 'stallRecovery',
  fire(ctx) {
    if (!ctx.stalled || ctx.serfCount > 0) return null;
    for (const b of ctx.mine) {
      if (b.state !== 'built' || b.paused || b.workerId === undefined) continue;
      const out = gatherRecipeOf(BUILDING_DEFS[b.type as BuildingTypeId])?.output;
      if (out === undefined || (b.stock[out] ?? 0) < OUTPUT_CAP) continue;
      const worker = ctx.world.units.get(b.workerId);
      if (!worker || worker.dead || worker.task.t !== 'idle') continue;
      return {
        commands: [{ kind: 'setBuildingPaused', buildingId: b.id, paused: true }],
        claims: [b.id],
      };
    }
    return null;
  },
};

/**
 * The other half of `freeCappedHauler`: start a drained post back up.
 *
 * A halted gatherer recruits nobody for as long as it stands halted, so the
 * freed hand stays a hauler until this rule says otherwise. The pile the
 * post was paused over still evacuates (paused buildings ship their stock),
 * and once it is gone the post is producing ground again — unpausing puts
 * it back on the staffing sweep's list, and the next idle hand mans it.
 *
 * Waiting for empty rather than merely under cap is deliberate: the whole
 * point of the pause was the hauling, and reopening the post after one load
 * would capture the hand with the rest of the pile still standing.
 *
 * Not gated on `stalled` — the stall clears precisely because the goods
 * moved, and the rule must still fire afterwards or the post stays halted
 * for the rest of the match. Gatherers are the only thing it touches, so
 * the towers `#manTowers` stands down are never restarted from here.
 */
const resumeDrainedPost: EconomyRule = {
  id: 'resumeDrainedPost',
  when: 'a post paused to free its hand has shipped the last of its pile',
  phase: 'recovery',
  fire(ctx) {
    const commands: SimCommand[] = [];
    const claims: EntityId[] = [];
    for (const b of ctx.mine) {
      if (b.state !== 'built' || !b.paused) continue;
      const out = gatherRecipeOf(BUILDING_DEFS[b.type as BuildingTypeId])?.output;
      if (out === undefined || (b.stock[out] ?? 0) > 0) continue;
      commands.push({ kind: 'setBuildingPaused', buildingId: b.id, paused: false });
      claims.push(b.id);
    }
    return commands.length > 0 ? { commands, claims } : null;
  },
};

/**
 * Forge what beats what the scouts have seen.
 *
 * The playbook's weapon mix by smith age is the printed line; smiths beyond
 * the first switch to the recipe that counters a living rival's dominant
 * class. The first smith keeps the playbook's own line — a sighting is a
 * reason to hedge, not to stampede — and a counter the seat cannot forge
 * (tech-gated recipe) leaves the mix as written.
 *
 * Claims each smith it retunes, so a later rule cannot re-order the same
 * forge in the same beat.
 */
const forgeTheCounter: EconomyRule = {
  id: 'forgeTheCounter',
  when: 'a forge is set to something other than what this seat should be making',
  phase: 'production',
  fire(ctx) {
    const commands: SimCommand[] = [];
    const claims: EntityId[] = [];
    const smiths = ctx.mine.filter((b) => b.type === 'weaponsmith' && b.state === 'built');
    smiths.forEach((smith, i) => {
      let want = ctx.strategy.weaponMix[Math.min(i, ctx.strategy.weaponMix.length - 1)]!;
      if (ctx.counter && i > 0) {
        const opt = BUILDING_DEFS.weaponsmith.recipeOptions?.[ctx.counter.recipe];
        if (opt && (opt.requiresTech === undefined || ctx.researched(opt.requiresTech))) {
          want = ctx.counter.recipe;
        }
      }
      const option = BUILDING_DEFS.weaponsmith.recipeOptions?.[want];
      if (!option) return;
      if (option.requiresTech !== undefined && !ctx.researched(option.requiresTech)) return;
      if ((smith.recipeIndex ?? 0) !== want) {
        commands.push({ kind: 'setBuildingRecipe', buildingId: smith.id, index: want });
        claims.push(smith.id);
      }
    });
    return commands.length > 0 ? { commands, claims } : null;
  },
};

/**
 * Keep the barracks queue warm, and unjam it when it sticks.
 *
 * The counter unit jumps the queue when its weapon is at hand — `around` is
 * the feasibility test, so a counter the economy cannot arm falls straight
 * through to the playbook's own preference.
 *
 * A queue can also go stale: an unstarted entry whose weapon the village
 * neither holds nor has on the way pins its slot forever — the iron ran out
 * under a spearman order while swords piled up in the store, and a queue at
 * depth stops this rule from ever running again. One stale entry makes way
 * per beat, and only while a unit the seat CAN arm is waiting for the slot.
 * An empty-handed queue keeps its entries: unstarted orders are what summon
 * their weapons at all (`trainingDemand` reads them), so a seat with nothing
 * in reach must hold its place in line rather than clear it.
 */
const keepTheQueueWarm: EconomyRule = {
  id: 'keepTheQueueWarm',
  when: 'the barracks queue is short, or stuck behind a weapon nobody can make',
  phase: 'production',
  fire(ctx) {
    const barracks = ctx.mine.find((b) => b.type === 'barracks' && b.state === 'built');
    if (!barracks) return null;
    const around = (good: GoodId): boolean =>
      (ctx.stock[good] ?? 0) + (barracks.inputs[good] ?? 0) + (barracks.inbound[good] ?? 0) > 0;
    const prefs = ctx.counter
      ? [ctx.counter.unit, ...ctx.strategy.trainPreference]
      : ctx.strategy.trainPreference;
    const ready = prefs.find((unit) => {
      const weapon = WEAPON_OF[unit];
      return weapon !== undefined && around(weapon);
    });

    const commands: SimCommand[] = [];
    let cancelled = 0;
    if (ready !== undefined) {
      const staleIdx = (barracks.trainQueue ?? []).findIndex((item) => {
        if (item.started) return false;
        const weapon = WEAPON_OF[item.unit];
        return weapon !== undefined && !around(weapon);
      });
      if (staleIdx >= 0) {
        commands.push({
          kind: 'cancelTraining',
          buildingId: barracks.id,
          index: staleIdx,
          unit: barracks.trainQueue![staleIdx]!.unit,
        });
        cancelled = 1;
      }
    }
    if ((barracks.trainQueue?.length ?? 0) - cancelled < ctx.strategy.barracksQueueDepth) {
      commands.push({
        kind: 'trainUnit',
        buildingId: barracks.id,
        unit: ready ?? ctx.strategy.trainFallback,
      });
    }
    return commands.length > 0 ? { commands, claims: [barracks.id] } : null;
  },
};

/**
 * The table. Order is priority: an earlier rule's claims win, and an earlier
 * rule in a group fires instead of a later one. Adding a rule means adding it
 * here and to `EconomyRuleId`, so nothing fires that cannot be named — and
 * therefore nothing fires that cannot be ablated.
 */
export const ECONOMY_RULES: readonly EconomyRule[] = [
  resiteExtractor,
  freeCappedHauler,
  resumeDrainedPost,
  forgeTheCounter,
  keepTheQueueWarm,
];

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
  phase: RulePhase,
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
    if (rule.phase !== phase) continue;
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
