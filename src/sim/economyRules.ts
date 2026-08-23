import {
  BUILDING_DEFS,
  TOOL_GOODS,
  TOOL_OF,
  gatherOrigin,
  gatherRecipeOf,
  OUTPUT_CAP,
  type BuildingTypeId,
} from './defs/buildings.ts';
import { FORGE_QUEUE_CAP } from './defs/balance.ts';
import { findResourcesNear, nearestResource, RESOURCE_CODE } from './map.ts';
import { WEAPON_OF } from './defs/units.ts';
import { isUnitUnlocked } from './techHelpers.ts';
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
  | 'keepTheToolsComing'
  | 'forgeTheCounter'
  | 'handsBeforeSoldiers'
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
 *
 * The one rule in this file that does NOT wait on the stall watchdog, and
 * the reason is that its own condition is a stricter reading than the
 * window's. `stalled` is an inference — four scalars that have not moved —
 * and it costs eight samples two thousand ticks apart to draw, so the
 * earliest it can be believed is fourteen thousand ticks after the village
 * stopped. A village short of hands beside a post at its cap is not an
 * inference at all: hauling, construction, staffing and the barracks all
 * want a serf, the only source of one is a hire paid out of a storehouse
 * only a serf can reach, and nothing in the sim breaks that circle. At zero
 * hands the village is already dead when this reads true, so waiting a
 * further twelve minutes to confirm it only decides how much of the match
 * the corpse sits through — a four-player replay (seed 47786976) has all
 * three AI seats reach zero serfs and none of them survive to the reading:
 * two are razed before the window fills and the third runs out of match
 * with four thousand ticks still to go. Not one recovery order was sent in
 * thirty-seven thousand ticks.
 *
 * The line is the playbook's `survivalFloor` rather than zero, which is the
 * same line the panic hire draws and the same one `handsBeforeSoldiers`
 * holds the barracks at. Waiting for the last hand to be spent is waiting
 * too long twice over: one serf is one haul at a time, so a village at one
 * crawls out of a raid over tens of thousands of ticks if it crawls out at
 * all, and every post it frees on the way is a post that was producing
 * nothing anyway — the buffer is full, which is precisely why its resident
 * is standing idle. The trade is temporary in both directions:
 * `resumeDrainedPost` starts each place again the moment its pile has
 * shipped, and the rule goes quiet as soon as the pool is back over the
 * floor.
 *
 * A healthy seat is untouched all the same, because `serfCount` counts
 * serfs that EXIST rather than serfs standing idle: a village whose whole
 * pool is out on hauls reads far above the floor, and one that reads under
 * it has next to nothing to dispatch either way.
 */
/*
 * The rule that carries the result. Ablated over seeds 1-80: alone it fires
 * 26 of the 30 recovery orders and takes the sweep from two undecided
 * matches to none, with the longest match dropping off the 120k horizon to
 * 72986 ticks. The binding constraint on a stalled village was never dead
 * ground — it was having no hand free to carry anything.
 *
 * Re-measured when the gate moved off the watchdog and up to the survival
 * floor (2026-08-23), on the campaign sweep because that is the instrument
 * with raids in it: `pnpm balance 32` over five seed ranges, 128 matches
 * each, 460/640 wins before and 491/640 after — +3, +6, +6, +8, +8, every
 * range positive and four of the five never tuned against. Nearly all of it
 * is seats that used to be counted dead. The AI-vs-AI guardrail
 * (`--engine none --seeds 1-24`) keeps 0 undecided and a flat median, at
 * 368 recovery orders against the old 0: below the floor is a place seats
 * visit often, and it used to cost them the game.
 */
const freeCappedHauler: EconomyRule = {
  id: 'freeCappedHauler',
  when: 'the village is short of hands and a post is sitting at its output cap',
  phase: 'recovery',
  group: 'stallRecovery',
  fire(ctx) {
    if (ctx.serfCount >= ctx.strategy.survivalFloor) return null;
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
 * Keep the tools coming: order the tool a post is standing open for.
 *
 * A tool-gated post with nothing on the way is production lost every beat
 * it waits, and no weapon order is worth a woodcutter that never cuts. But
 * the answer is an ORDER, not a forge: the first draft of this rule put the
 * seat's last smith on auto for as long as any post was open, which on the
 * Abbot's two-line plan meant its bow forge spent the match making axes —
 * it reached the guard towers with no archers to put in them, and the
 * playbook test said so. The queue exists exactly so a batch can jump the
 * line without touching what the forge goes back to afterwards.
 *
 * So: one order per beat, for the tool with a post waiting and none in
 * reach, at the first smith that can forge it and has room. Claims nothing
 * — enqueueing does not touch recipeIndex, so forgeTheCounter is free to
 * keep steering the same anvil's standing work in the same beat.
 */
const keepTheToolsComing: EconomyRule = {
  id: 'keepTheToolsComing',
  when: 'a post stands open for a tool nobody has made and nobody has ordered',
  phase: 'production',
  fire(ctx) {
    const smiths = ctx.mine.filter(
      (b) => b.type === 'weaponsmith' && b.state === 'built' && !b.paused,
    );
    if (smiths.length === 0) return null;

    // What the village is short of: a post open for it with nothing on the
    // way, or a site still owed the hammer it borrows.
    const wanted = new Set<GoodId>();
    for (const b of ctx.mine) {
      if (b.state === 'site') {
        if (!b.paused && (b.siteNeeds?.hammer ?? 0) > 0 && (b.inbound.hammer ?? 0) === 0) {
          wanted.add('hammer');
        }
        continue;
      }
      if (b.state !== 'built' || b.paused) continue;
      const tool = TOOL_OF[b.type];
      if (tool === undefined) continue;
      const worker = b.workerId !== undefined ? ctx.world.units.get(b.workerId) : undefined;
      if (worker && !worker.dead) continue;
      if ((b.inputs[tool] ?? 0) + (b.inbound[tool] ?? 0) > 0) continue;
      wanted.add(tool);
    }
    if (wanted.size === 0) return null;

    // TOOL_GOODS order, not set order: the same shortage must always pick
    // the same tool, whatever order the buildings happened to be walked in.
    for (const tool of TOOL_GOODS) {
      if (!wanted.has(tool)) continue;
      if ((ctx.stock[tool] ?? 0) > 0) continue; // one on the shelf is already coming
      const index = BUILDING_DEFS.weaponsmith.recipeOptions!.findIndex(
        (o) => (o.recipe.outputs[tool] ?? 0) > 0,
      );
      if (index < 0) return null;
      const opt = BUILDING_DEFS.weaponsmith.recipeOptions![index]!;
      if (opt.requiresTech !== undefined && !ctx.researched(opt.requiresTech)) continue;
      // Already ordered anywhere? An order stands until its batch lands, so
      // re-adding one every beat would fill five slots with the same axe.
      if (smiths.some((b) => b.forgeQueue?.some((o) => o.recipeIndex === index))) continue;
      const smith = smiths.find((b) => (b.forgeQueue?.length ?? 0) < FORGE_QUEUE_CAP);
      if (!smith) return null;
      return {
        commands: [{ kind: 'enqueueForge', buildingId: smith.id, recipeIndex: index }],
        claims: [],
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
      if (smith.recipeIndex !== want) {
        commands.push({ kind: 'setBuildingRecipe', buildingId: smith.id, index: want });
        claims.push(smith.id);
      }
    });
    return commands.length > 0 ? { commands, claims } : null;
  },
};

/**
 * Hands before soldiers: hold the barracks while the village is short of
 * serfs, and open it again the moment the pool is back.
 *
 * A knight is a serf plus a sword. That is the whole of it: `staffing.ts`
 * consumes an arriving serf as each recruit, so a barracks with a warm
 * queue and its ingredients on the shelf is a standing order against the
 * one resource a raided village cannot replace quickly. A seat that has
 * just lost its hands to a raid will therefore spend the next one it hires
 * on a soldier, and be back where it started — the silver gone, the haul
 * board still frozen, and one more body walking the map instead of carrying
 * anything.
 *
 * `survivalFloor` is the same line the panic hire draws (`systems/ai.ts`),
 * and drawing it twice is the point: below it the seat pays for hands and
 * refuses to spend them, which is one policy rather than two halves that
 * cancel out. Above it the rule is silent, so every seat that is not in
 * trouble plays exactly the game it played before.
 *
 * The hold is a Schmitt trigger, not a threshold, and that is load-bearing
 * rather than tidy. Training costs exactly one hand, so a barracks reopened
 * the instant the pool *touches* the floor takes a recruit and puts the
 * seat straight back under it — and each of those openings books a fresh
 * set of priority-2 bread-and-weapon hauls that outrank the storehouse
 * evacuation and survive the next hold, because a pause suppresses new
 * demand but does not stand down errands already on the board
 * (`systems/logistics.ts` reconciles destinations that are gone, not
 * destinations that are halted). Measured on the replay this was cut from:
 * a rule that reopened at the floor flapped across it and served nine such
 * hauls with the two hands the seat had. So it closes UNDER the floor and
 * opens only ABOVE it: one hand of margin, which is exactly the hand the
 * recruiter is about to take.
 *
 * Halting rather than cancelling, for three reasons. The queue survives —
 * an order stands until its batch lands, so the seat resumes the army it
 * had planned rather than re-deciding it. A halted barracks recruits
 * nobody, and turns away the recruit already walking to its door
 * (`staffing.ts`), which is the hand this rule is actually trying to save.
 * And it stops calling for bread and weapons (`systems/logistics.ts`), so
 * the few hauls the village can still crew go to the storehouse — where
 * hire silver has to land — instead of to a barracks that cannot train.
 *
 * Claims what it holds, so `keepTheQueueWarm` below cannot deepen a queue
 * this rule is standing down in the same beat.
 */
const handsBeforeSoldiers: EconomyRule = {
  id: 'handsBeforeSoldiers',
  when: 'the raid took the hands: the barracks waits until the village has serfs again',
  phase: 'production',
  fire(ctx) {
    const commands: SimCommand[] = [];
    const claims: EntityId[] = [];
    // The two lines of the trigger: close under the floor, open only above
    // it. At the floor exactly, whatever the barracks is doing it keeps
    // doing — which is the band that stops the flapping.
    const short = ctx.serfCount < ctx.strategy.survivalFloor;
    const clear = ctx.serfCount > ctx.strategy.survivalFloor;
    for (const b of ctx.mine) {
      if (b.state !== 'built' || BUILDING_DEFS[b.type as BuildingTypeId].trains === undefined) {
        continue;
      }
      const halted = b.paused === true;
      const want = halted ? !clear : short;
      // A barracks already running that this rule does not want to hold is
      // not its business, and claiming it would be the bug: a claim lasts
      // one beat, so an unconditional one would silence `keepTheQueueWarm`
      // for the whole match.
      if (!want && !halted) continue;
      if (want !== halted) {
        commands.push({ kind: 'setBuildingPaused', buildingId: b.id, paused: want });
      }
      // Claimed on every beat the hold stands, order or no order: the pause
      // is sent once and the claim is what keeps the queue from being
      // refilled behind it on all the beats after.
      claims.push(b.id);
    }
    return commands.length > 0 || claims.length > 0 ? { commands, claims } : null;
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
    // Only what the seat can actually train. `enqueueTraining` refuses a
    // unit whose tech is not in and says nothing about it, so an order for
    // one is not a slow order — it is no order at all, and the queue it was
    // meant to fill stays empty. The Abbot walks straight into this: its
    // fallback is the archer, gated behind Archery, so from the beat its
    // barracks opens until that research lands it re-orders the same
    // refused archer every beat — a hundred of them inside twenty thousand
    // ticks on the seed this was found on — while the barracks stands with
    // an empty queue. And an empty queue is not merely idle: unstarted
    // orders are what summon their own ingredients (trainingDemand), so
    // nothing hauls bread or a weapon there either.
    const trainable = (unit: UnitTypeId): boolean =>
      isUnitUnlocked(ctx.world, ctx.owner, unit);
    const ready = prefs.find((unit) => {
      const weapon = WEAPON_OF[unit];
      return weapon !== undefined && around(weapon) && trainable(unit);
    });
    // What to hold the slot with when no weapon is in reach: the playbook's
    // fallback, or — when that is the locked one — the first preference the
    // seat can actually put in the queue. None trainable at all and there
    // is no order worth giving.
    const warm = trainable(ctx.strategy.trainFallback)
      ? ctx.strategy.trainFallback
      : prefs.find(trainable);

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
    const order = ready ?? warm;
    if (
      order !== undefined &&
      (barracks.trainQueue?.length ?? 0) - cancelled < ctx.strategy.barracksQueueDepth
    ) {
      commands.push({ kind: 'trainUnit', buildingId: barracks.id, unit: order });
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
  keepTheToolsComing,
  forgeTheCounter,
  handsBeforeSoldiers,
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
