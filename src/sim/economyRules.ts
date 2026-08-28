import {
  BUILDING_DEFS,
  TOOL_GOODS,
  TOOL_OF,
  convertRecipeOf,
  gatherOrigin,
  gatherRecipeOf,
  OUTPUT_CAP,
  BuildingTypeId,
} from './defs/buildings.ts';
import { FORGE_QUEUE_CAP } from './defs/balance.ts';
import { findResourcesNear, nearestResource } from './map.ts';
import { WEAPON_OF, type UnitTypeId } from './defs/units.ts';
import { isUnitUnlocked } from './techHelpers.ts';
import type { AiStrategy } from './defs/aiStrategies.ts';
import type { TechId } from './defs/techs.ts';
import { type Building, type EntityId, type Owner, BuildingState } from './entities.ts';
import { type SimCommand, CommandKind } from './commands.ts';
import type { World } from './world.ts';
import { GoodId, goodKeys, type GoodAmounts, goodEntries } from './defs/goods.ts';
import { UnitTaskKind } from './units.ts';
import type { Enum } from '../shared/enum.ts';
import * as EconomyRuleIdNs from './economyRuleIdEnum.ts';

export * as EconomyRuleId from './economyRuleIdEnum.ts';
export type EconomyRuleId = Enum<typeof EconomyRuleIdNs>;
import * as RulePhaseNs from './rulePhaseEnum.ts';

export * as RulePhase from './rulePhaseEnum.ts';
export type RulePhase = Enum<typeof RulePhaseNs>;

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

/**
 * Where in a beat a rule runs.
 *
 * Not decoration: commands are applied in the order they are pushed, and
 * within one tick that order is load-bearing — research spends goods, a sale
 * refunds them, training consumes them. The two phases are the two points the
 * brain already emitted from, so rules keep firing exactly where the code
 * they came from did.
 */

/** What a rule reads. Assembled once per beat by the brain and handed to
 * every rule, so no rule can quietly widen what it depends on. */
export interface RuleContext {
  world: World;
  owner: Owner;
  /** This seat's buildings, ascending id — the iteration order every rule
   * must use, since the sim's own tie-breaks are by id. */
  mine: Building[];
  /** The storehouse shelf. */
  stock: GoodAmounts;
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
  id: EconomyRuleIdNs.resiteExtractor,
  when: 'a gatherer has exhausted everything inside its radius',
  phase: RulePhaseNs.recovery,
  group: 'stallRecovery',
  fire(ctx) {
    if (!ctx.stalled) return null;
    for (const b of ctx.mine) {
      if (b.state !== BuildingState.built) continue;
      const def = BUILDING_DEFS[b.type as BuildingTypeId];
      const recipe = gatherRecipeOf(def);
      if (!recipe) continue;
      const code = recipe.resource;
      const c = gatherOrigin(def, b.x, b.y);
      if (findResourcesNear(ctx.world.map, c.x, c.y, code, recipe.radius, 1).length > 0) continue;
      if (nearestResource(ctx.world.map, code, b.x, b.y) < 0) continue; // nowhere to go
      const cost = def.cost;
      const canRebuild = goodEntries(cost).every(
        ([good, n]) => (ctx.stock[good] ?? 0) + Math.floor(n / 2) >= n,
      );
      if (!canRebuild) continue;
      return { commands: [{ kind: CommandKind.sellBuilding, buildingId: b.id }], claims: [b.id] };
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
 * One of the rules here that does NOT wait on the stall watchdog — with
 * `resumeDrainedPost`, which must be able to undo it whatever the window
 * says, and `handsBeforeSoldiers`, which reads the same hand count — and
 * the reason is that the condition is a stricter reading than the window's.
 * `stalled` is an inference — four scalars that have not moved —
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
 * each. Read the number with its history, because the README's warning
 * about re-measuring under a moving floor caught this change in the act:
 *
 *   - against the sim as it stood when this was written, 460/640 before and
 *     491/640 after, every range positive;
 *   - against the sim after main's spear work landed under it (a spearman
 *     could not be armed with the Mage's staff, which starved seats of
 *     their cheapest soldier), 493/640 and 504/640 — the same rescue worth
 *     +11 rather than +31, on three ranges up and two down.
 *
 * So the win rate is a guardrail here, not the case: it says no regression,
 * and at this sample it cannot resolve more than that. The case is the
 * replay — three seats permanently paralysed with zero recovery orders sent
 * in 37851 ticks, and the seat that unfreezes when the rule is allowed to
 * fire (open jobs 54 -> 9, storehouse 52 -> 99). The AI-vs-AI guardrail
 * (`--engine none --seeds 1-24`) keeps 0 undecided and a flat median, at
 * 368 recovery orders against the old 0: below the floor is a place seats
 * visit often, and the rules that answer it were unreachable.
 */
const freeCappedHauler: EconomyRule = {
  id: EconomyRuleIdNs.freeCappedHauler,
  when: 'the village is short of hands and a post is sitting at its output cap',
  phase: RulePhaseNs.recovery,
  group: 'stallRecovery',
  fire(ctx) {
    if (ctx.serfCount >= ctx.strategy.survivalFloor) return null;
    for (const b of ctx.mine) {
      if (b.state !== BuildingState.built || b.paused || b.workerId === undefined) continue;
      const out = gatherRecipeOf(BUILDING_DEFS[b.type as BuildingTypeId])?.output;
      if (out === undefined || (b.stock[out] ?? 0) < OUTPUT_CAP) continue;
      const worker = ctx.world.units.get(b.workerId);
      if (!worker || worker.dead || worker.task.t !== UnitTaskKind.idle) continue;
      return {
        commands: [{ kind: CommandKind.setBuildingPaused, buildingId: b.id, paused: true }],
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
  id: EconomyRuleIdNs.keepTheToolsComing,
  when: 'a post stands open for a tool nobody has made and nobody has ordered',
  phase: RulePhaseNs.production,
  fire(ctx) {
    // Halted anvils included, and that is what makes this rule the tool
    // line's guarantee rather than a best effort: `holdTheGlutForge` below
    // may stand every forge in the village down, and a village that cannot
    // replace a lost axe has no woodcutter. A halted Smith is one order
    // away from working, so it counts.
    const smiths = ctx.mine.filter(
      (b) => b.type === BuildingTypeId.weaponsmith && b.state === BuildingState.built,
    );
    if (smiths.length === 0) return null;

    // What the village is short of: a post open for it with nothing on the
    // way, or a site still owed the hammer it borrows.
    const wanted = new Set<GoodId>();
    for (const b of ctx.mine) {
      if (b.state === BuildingState.site) {
        if (
          !b.paused &&
          (b.siteNeeds?.[GoodId.hammer] ?? 0) > 0 &&
          (b.inbound[GoodId.hammer] ?? 0) === 0
        ) {
          wanted.add(GoodId.hammer);
        }
        continue;
      }
      if (b.state !== BuildingState.built || b.paused) continue;
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
      const index = BUILDING_DEFS[BuildingTypeId.weaponsmith].recipeOptions!.findIndex(
        (o) => (o.recipe.outputs[tool] ?? 0) > 0,
      );
      if (index < 0) return null;
      const opt = BUILDING_DEFS[BuildingTypeId.weaponsmith].recipeOptions![index]!;
      if (opt.requiresTech !== undefined && !ctx.researched(opt.requiresTech)) continue;
      // Already ordered anywhere? An order stands until its batch lands, so
      // re-adding one every beat would fill five slots with the same axe.
      // A batch in a HALTED forge is the one case where the order standing
      // is not the same as the tool coming — nothing is being made there —
      // so that anvil is started rather than ordered from again.
      const holder = smiths.find((b) => b.forgeQueue?.some((o) => o.recipeIndex === index));
      if (holder) {
        if (holder.paused !== true) continue;
        return {
          commands: [{ kind: CommandKind.setBuildingPaused, buildingId: holder.id, paused: false }],
          claims: [holder.id],
        };
      }
      // A working anvil first; a halted one only when there is no other.
      const smith =
        smiths.find((b) => !b.paused && (b.forgeQueue?.length ?? 0) < FORGE_QUEUE_CAP) ??
        smiths.find((b) => (b.forgeQueue?.length ?? 0) < FORGE_QUEUE_CAP);
      if (!smith) return null;
      const commands: SimCommand[] = [];
      // Claimed only on the waking path. A plain order claims nothing on
      // purpose (see above), but a halted anvil is one `holdTheGlutForge`
      // may also be about to start — its pile can be under the clear line
      // while a post stands open — and two rules ordering the same forge
      // open in one beat is the exact collision claims exist to settle.
      const claims: EntityId[] = [];
      if (smith.paused === true) {
        commands.push({ kind: CommandKind.setBuildingPaused, buildingId: smith.id, paused: false });
        claims.push(smith.id);
      }
      commands.push({ kind: CommandKind.enqueueForge, buildingId: smith.id, recipeIndex: index });
      return { commands, claims };
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
  id: EconomyRuleIdNs.resumeDrainedPost,
  when: 'a post paused to free its hand has shipped the last of its pile',
  phase: RulePhaseNs.recovery,
  fire(ctx) {
    const commands: SimCommand[] = [];
    const claims: EntityId[] = [];
    for (const b of ctx.mine) {
      if (b.state !== BuildingState.built || !b.paused) continue;
      const out = gatherRecipeOf(BUILDING_DEFS[b.type as BuildingTypeId])?.output;
      if (out === undefined || (b.stock[out] ?? 0) > 0) continue;
      commands.push({ kind: CommandKind.setBuildingPaused, buildingId: b.id, paused: false });
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
  id: EconomyRuleIdNs.forgeTheCounter,
  when: 'a forge is set to something other than what this seat should be making',
  phase: RulePhaseNs.production,
  fire(ctx) {
    const commands: SimCommand[] = [];
    const claims: EntityId[] = [];
    const smiths = ctx.mine.filter(
      (b) => b.type === BuildingTypeId.weaponsmith && b.state === BuildingState.built,
    );
    smiths.forEach((smith, i) => {
      let want = ctx.strategy.weaponMix[Math.min(i, ctx.strategy.weaponMix.length - 1)]!;
      if (ctx.counter && i > 0) {
        const opt = BUILDING_DEFS[BuildingTypeId.weaponsmith].recipeOptions?.[ctx.counter.recipe];
        if (opt && (opt.requiresTech === undefined || ctx.researched(opt.requiresTech))) {
          want = ctx.counter.recipe;
        }
      }
      const option = BUILDING_DEFS[BuildingTypeId.weaponsmith].recipeOptions?.[want];
      if (!option) return;
      if (option.requiresTech !== undefined && !ctx.researched(option.requiresTech)) return;
      if (smith.recipeIndex !== want) {
        commands.push({ kind: CommandKind.setBuildingRecipe, buildingId: smith.id, index: want });
        claims.push(smith.id);
      }
    });
    return commands.length > 0 ? { commands, claims } : null;
  },
};

/**
 * The shelf lines the glut rule works between. A Schmitt trigger for the
 * same reason `handsBeforeSoldiers` is one: halting empties the post and
 * starting it again calls a hand back across the village, so a forge that
 * flapped on a single arrowhead would spend its worker walking. Halt above
 * the high line, start again at or below the low one, and between them the
 * forge keeps doing whatever it is already doing.
 *
 * The campaign sweep cannot pick these numbers, and it is worth knowing
 * that before trying. Every pair pays about the same, 32 seeds x 4
 * playbooks per range:
 *
 * | halt above | start at or below | tuned ranges (off 304/384) | fresh ranges (off 200/256) |
 * | --- | --- | --- | --- |
 * | 3 | 1 | — | 208 (+8) |
 * | 5 | 2 | 320 (+16) | 210 (+10) |
 * | 6 | 3 | — | 211 (+11) |
 * | 8 | 4 | 314 (+10) | 208 (+8) |
 * | 12 | 6 | 311 (+7) | — |
 * | 16 | 8 | 312 (+8) | — |
 *
 * Read the columns together. On the ranges the pairs were first compared
 * over, 5/2 looks six wins better than 8/4; on two ranges never used to
 * pick a threshold the whole field lands inside three wins of itself and
 * the gap is gone. The sweep's honest answer is that the rule pays and the
 * line is invisible to it anywhere from 3 to 16.
 *
 * What DOES pick them is the four-seat standoff in aiStrategies.test.ts —
 * seed 42, no bandits, four playbooks that must reach an ending inside
 * ninety thousand ticks. It fails at 6/3 and at 5/2, and passes at 7/3 and
 * 8/4. Below seven, seats stop forging early enough and often enough that
 * four exhausted villages never muster anyone to finish each other off,
 * and a match that was decided runs to the horizon undecided. A solo
 * campaign cannot see this: there is nobody on the other side of it.
 *
 * So eight and four, one step clear of a cliff rather than sitting on its
 * edge. And specifically NOT `OUTPUT_CAP`, which is the tempting number
 * here — a producer stalls when its own buffer fills at five, so five
 * reads like the same rule applied to the shelf. It is the wrong five: a
 * hut's buffer is one hauler's backlog, while the shelf is the village's
 * war chest, and the standoff test is where the difference shows up. Any
 * retune should expect the sweep to say nothing and should run that test
 * before believing a smaller line is free.
 */
const FORGE_GLUT = 8;
const FORGE_GLUT_CLEAR = 4;

/**
 * Halt a forge whose weapon is piling up unclaimed.
 *
 * A Smith is the one building in the village with no natural brake. Every
 * gatherer stops at `OUTPUT_CAP` — a full buffer is a hut that has stopped
 * working — but a forge's output is evacuated to the storehouse, and the
 * storehouse is bottomless, so the buffer never fills and the recipe never
 * stops. What the recipe spends is not bottomless: a bowstave is three
 * wood, and two woodcutters against a standing order for bows is a losing
 * trade the moment the barracks stops taking them.
 *
 * Which is exactly where every playbook in the deck ends up. Driven alone
 * on a peaceful map (`banditsEnabled: false`, seed 101, 60k ticks) the
 * Abbot finishes with nineteen bows on the shelf and its wood at zero from
 * tick twenty thousand on; the Steward finishes with thirty-nine swords,
 * the Warlord sixty-four, the Fletcher sixteen bows beside ninety-nine
 * unclaimed iron. Stone climbs all match on all four. Only the wood runs
 * out, because only the wood is being spent on something nobody wants —
 * and a village whose shelf reads zero wood cannot place anything costing
 * ten of it, which is most of the buildings a plan has left by then. The
 * Abbot's brewery, last in its build order and gated behind Brewing, is
 * never raised at all in sixty thousand ticks of peace.
 *
 * Halting is the lever the sim already documents for this — `tick.ts` calls
 * `setBuildingPaused` "the lever for 'the bowyer is eating all my wood'".
 * It stops the recipe, stops the input hauls (`systems/logistics.ts` raises
 * no demand for a halted post), and hands the resident back to the pool,
 * while the finished weapons on the shelf stay exactly where they are for
 * the barracks to draw on. Nothing is destroyed and nothing is decided
 * permanently: the pile is the only thing the rule reads, so training the
 * archers it bought starts the forge again by itself.
 *
 * It will stand down every anvil in the village if every weapon is piled
 * up, and that is deliberate rather than reckless. Nine of the ten posts
 * are gated on a tool and the Smith is the only source of one, so a seat
 * that could not forge would be a seat that never replaces a lost axe —
 * but the tool line is `keepTheToolsComing`'s job, and it now starts a
 * halted anvil to serve an order rather than skipping past it. Holding a
 * forge open against a shortage that has not happened yet is paying for
 * that guarantee twice, in the one good the shortage is about.
 *
 * The one anvil it will not touch is one with a batch in its queue. A
 * queued order jumps the standing recipe (`forgeDemandRecipe`), and
 * `keepTheToolsComing` is what puts tools there — so a forge with a queue
 * is a forge making something the village asked for by name, and the queue
 * emptying is the signal that it is done.
 *
 * Reads the standing recipe rather than the queue head for the same reason:
 * the standing order is what the forge goes back to and keeps doing
 * forever, and it is the forever that starves the wood. A Smith on auto
 * (no `recipeIndex`) names no recipe from the def alone and is left alone.
 *
 * Claims what it orders, so nothing re-tunes an anvil this rule is standing
 * down in the same beat — and it sits after `forgeTheCounter` in the table,
 * so a forge the scouts have just re-aimed keeps its new orders and is
 * judged on the next beat, against the pile its new recipe is actually
 * making.
 */
const holdTheGlutForge: EconomyRule = {
  id: EconomyRuleIdNs.holdTheGlutForge,
  when: "a forge is spending the village's wood on a weapon nobody is claiming",
  phase: RulePhaseNs.production,
  fire(ctx) {
    const commands: SimCommand[] = [];
    const claims: EntityId[] = [];
    const smiths = ctx.mine.filter(
      (b) => b.type === BuildingTypeId.weaponsmith && b.state === BuildingState.built,
    );
    for (const b of smiths) {
      const recipe = convertRecipeOf(BUILDING_DEFS[BuildingTypeId.weaponsmith], b);
      if (!recipe) continue;
      // One output per forge recipe today; summing is what the shape means
      // rather than what it happens to hold.
      let shelf = 0;
      for (const good of goodKeys(recipe.outputs)) shelf += ctx.stock[good] ?? 0;
      if (b.paused === true) {
        if (shelf > FORGE_GLUT_CLEAR) continue;
        commands.push({ kind: CommandKind.setBuildingPaused, buildingId: b.id, paused: false });
        claims.push(b.id);
        continue;
      }
      if (shelf <= FORGE_GLUT) continue;
      if ((b.forgeQueue?.length ?? 0) > 0) continue;
      commands.push({ kind: CommandKind.setBuildingPaused, buildingId: b.id, paused: true });
      claims.push(b.id);
    }
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
 * The lower edge is deliberately the loose one, and it was measured before
 * it was left that way. Reopening at floor+1 can still dip the pool to
 * floor-1: `staffingSystem` sweeps every 25 ticks against a brain that
 * decides every 20, so a queue two deep takes a second recruit in the gap
 * before the hold comes back down (pinned in ai.test.ts). Closing at
 * `<= floor` instead of `< floor` removes that dip completely — and costs
 * the campaign 448 wins of 640 against this version's 491, which is worse
 * than having no rule at all (460). (Measured before main's spear work
 * landed under this branch, on the same tree as the 460/491 pair above; a
 * 43-match gap on every range is far outside what that move could flip.) A seat that will not train while it
 * sits AT its floor is a seat that never fields an army, because sitting at
 * the floor is what a raided village does. One hand of overshoot is the
 * price of the seat having soldiers, and the sweep says it is worth paying
 * twice over.
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
  id: EconomyRuleIdNs.handsBeforeSoldiers,
  when: 'the raid took the hands: the barracks waits until the village has serfs again',
  phase: RulePhaseNs.production,
  fire(ctx) {
    const commands: SimCommand[] = [];
    const claims: EntityId[] = [];
    // The two lines of the trigger: close under the floor, open only above
    // it. At the floor exactly, whatever the barracks is doing it keeps
    // doing — which is the band that stops the flapping.
    const short = ctx.serfCount < ctx.strategy.survivalFloor;
    const clear = ctx.serfCount > ctx.strategy.survivalFloor;
    for (const b of ctx.mine) {
      if (
        b.state !== BuildingState.built ||
        BUILDING_DEFS[b.type as BuildingTypeId].trains === undefined
      ) {
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
        commands.push({ kind: CommandKind.setBuildingPaused, buildingId: b.id, paused: want });
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
  id: EconomyRuleIdNs.keepTheQueueWarm,
  when: 'the barracks queue is short, or stuck behind a weapon nobody can make',
  phase: RulePhaseNs.production,
  fire(ctx) {
    const barracks = ctx.mine.find(
      (b) => b.type === BuildingTypeId.barracks && b.state === BuildingState.built,
    );
    if (!barracks) return null;
    const around = (good: GoodId): boolean =>
      (ctx.stock[good] ?? 0) + (barracks.inputs[good] ?? 0) + (barracks.inbound[good] ?? 0) > 0;
    const prefs: readonly UnitTypeId[] = ctx.counter
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
    const trainable = (unit: UnitTypeId): boolean => isUnitUnlocked(ctx.world, ctx.owner, unit);
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
          kind: CommandKind.cancelTraining,
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
      commands.push({ kind: CommandKind.trainUnit, buildingId: barracks.id, unit: order });
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
  holdTheGlutForge,
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

/** The spelling of each rule id, for the lab's --rules flag and its traces. */
export const ECONOMY_RULE_KEYS: Readonly<Record<EconomyRuleId, string>> = {
  [EconomyRuleIdNs.resiteExtractor]: 'resiteExtractor',
  [EconomyRuleIdNs.freeCappedHauler]: 'freeCappedHauler',
  [EconomyRuleIdNs.resumeDrainedPost]: 'resumeDrainedPost',
  [EconomyRuleIdNs.keepTheToolsComing]: 'keepTheToolsComing',
  [EconomyRuleIdNs.forgeTheCounter]: 'forgeTheCounter',
  [EconomyRuleIdNs.holdTheGlutForge]: 'holdTheGlutForge',
  [EconomyRuleIdNs.handsBeforeSoldiers]: 'handsBeforeSoldiers',
  [EconomyRuleIdNs.keepTheQueueWarm]: 'keepTheQueueWarm',
};

const ECONOMY_RULE_BY_KEY = new Map<string, EconomyRuleId>(
  ALL_ECONOMY_RULES.map((id) => [ECONOMY_RULE_KEYS[id], id]),
);

export function economyRuleFromKey(key: string): EconomyRuleId | undefined {
  return ECONOMY_RULE_BY_KEY.get(key);
}
