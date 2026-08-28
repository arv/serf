/**
 * Global tunables. Per-thing numbers (hp, speeds, costs) live on their defs;
 * this file holds cross-cutting knobs so a balance pass is one screen.
 */
import type { GoodAmounts } from './goods.ts';
import type { UnitClass } from './units.ts';
import { GoodId } from './goods.ts';

export const TICKS_PER_SECOND = 20;
export const TICK_MS = 1000 / TICKS_PER_SECOND;

// Population economy: serfs staff every production building and become
// soldiers. The pool starts scarce on purpose — with hands to spare, build
// order is just a queue; when staffing one building means not staffing
// another, every placement is a decision. Growth comes from hiring (paid
// in silver), so expanding the village is itself an economic choice.
// 8 is the tested floor: at 6 the campaign AI falls to the raids and AI-vs-AI
// stalemates, even with the silver-first build order (see ai.ts).
export const START_SERFS = 8;
// The village armory holds a few old weapons so a Soldiery rush can field
// defenders before the first raid without the full iron chain.
export const START_STOCK: GoodAmounts = {
  [GoodId.wood]: 36,
  [GoodId.stone]: 15,
  // Wheat is for the scholars and the brewer now; the bread the opening's
  // defenders eat is already baked, the same way their spears are already
  // forged. Without it a Soldiery rush would have to stand up the whole
  // mill-and-bakery chain before it could field anyone at all.
  [GoodId.wheat]: 12,
  [GoodId.food]: 8,
  [GoodId.silver]: 20,
  [GoodId.spear]: 2,
  [GoodId.sword]: 1,
  // The tool shed: one of each post's tool plus spares for the two the
  // opening leans on hardest, so the first village staffs itself exactly
  // as it did before tools existed — the squeeze is meant to arrive with
  // the SECOND woodcutter, not the first. Three hammers because a hammer
  // is a loan against a construction site (see TOOL_OF in buildings.ts):
  // three sites can rise at once, the fourth waits for a roof to top out.
  // Numbers are bakeoff-tuned like everything else in this block.
  [GoodId.axe]: 2,
  [GoodId.pickaxe]: 2,
  [GoodId.scythe]: 1,
  [GoodId.hammer]: 3,
  [GoodId.cauldron]: 1,
  [GoodId.rod]: 1,
};

// Logistics
export const MATCHER_INTERVAL = 5; // ticks between matcher/reconcile passes
export const JOB_BLOCKED_BACKOFF = 40; // ticks before retrying an unreachable job

// Trails
export const TRAILS_INTERVAL = 20; // ticks between trail passes
export const WEAR_DECAY = 0.98; // per pass multiplier
export const TRAIL_WEAR_THRESHOLD = 10; // wear to become a dirt trail
export const TRAIL_REVERT_WEAR = 0.75; // below this an unpaved trail reverts
export const REGROW_INTERVAL = 200; // tree regrowth cadence
export const WOOD_MAX_AMT = 6;

// Stone-road paving (Masonry)
export const PAVE_INTERVAL = 100; // ticks between paving scans
export const PAVE_WEAR_THRESHOLD = 20; // sustained wear before a trail is paved
export const MAX_CONCURRENT_PAVING = 4; // road sites in flight (never starves construction)

// Hiring
export const HIRE_SERF_COST = 4; // silver
/** Word has to reach the next village over and the recruit has to walk in. */
export const HIRE_SERF_TICKS = 8 * TICKS_PER_SECOND;
/** Paid-for hires that can be waiting at once. */
export const HIRE_QUEUE_CAP = 5;
/** Combat corpses linger this long so the death animation can play. */
export const CORPSE_TICKS = 30;

// Repairs
/**
 * A repair's material bill, as a share of what the building cost to raise
 * (scaled by how much of it is broken). Half, to pair with the sell refund:
 * tearing a ruin down and building it again gets you half the cost back and
 * pays the whole cost, so mending is always the cheaper road — as it should
 * be, since it also keeps the ground, the worker and the deliveries.
 */
export const REPAIR_COST_SHARE = 0.5;
/**
 * How long the masonry itself takes: the ticks a mend runs for if it has to
 * put a building back up from nothing. A repair charges this pro rata, so
 * patching a scratch is quick and rebuilding a wall the raiders nearly took
 * down is not. Materials still have to be carried in first — this is the
 * work that happens after they land, and the two overlap.
 *
 * Ten seconds, a little under the shortest build timer: mending is the fast
 * road as well as the cheap one, but it is no longer free of the clock, so a
 * building caught halfway through a mend by the next wave is a real risk to
 * plan around.
 */
export const REPAIR_MEND_TICKS = 10 * TICKS_PER_SECOND;

// Festivals (ale -> global work-speed buff)
export const FESTIVAL_DURATION = 60 * TICKS_PER_SECOND;
export const ABBEY_ALE_CAP = 2;

// Ale Rations (ale -> faster training at the barracks)
export const BARRACKS_ALE_CAP = 2;
/** Divides the training duration when a soldier drinks (never a gate: no
 * ale in the cask just means the course runs at normal speed). */
export const ALE_TRAIN_SPEEDUP = 1.25;

// Combat
/**
 * What a soldier's blow is worth against a wall, as a share of what it does
 * to a man, by the arm that swings it. Weapons are scaled for duels and
 * stone does not bleed, so every siege — raiders chewing the village and
 * armies razing the camp alike — runs slower than a fight, buying the
 * defenders a beat to answer before a building comes down.
 *
 * Melee at three quarters; the bow at half, because an arrow does less to
 * masonry than a shoulder does and ten archers were leveling the castle in
 * the time it takes to march home. Archers still pull real weight in a
 * siege — half is a discount, not a dismissal — but an army that wants
 * walls down fast brings men who can put their backs into it.
 */
export const BUILDING_DAMAGE_MULT: Record<UnitClass, number> = {
  heavy: 0.75,
  light: 0.75,
  ranged: 0.5,
};

// Raids — paced for the population economy's slower ramp (staffing every
// building and mustering an army both consume people). Stretched by a fifth
// when housing became a gate on that ramp: the castle sleeps ten, so the
// first raid now has to wait out a house as well as a barracks. At the old
// seven minutes every playbook met the first wave a squad short and the
// campaign stopped being winnable.
export const FIRST_RAID_TICK = 540 * TICKS_PER_SECOND; // 9 minutes of peace on the classic 64 map
export const RAID_INTERVAL = 180 * TICKS_PER_SECOND;
export const RAID_CAP = 8;

/**
 * The peace period, scaled to the map being played. The 9 minutes above
 * were tuned against 64-tile commutes; every haul on a bigger map walks
 * proportionally further, the economy ramps proportionally slower, and a
 * raid clock that ignored that made every playbook meet the first wave a
 * squad short again (measured: 8 of 9 seeds unwinnable at 96 on the flat
 * clock). Linear in the map side, exact integer math, and exactly
 * FIRST_RAID_TICK at 64. Mission overrides bypass this — a mission's
 * pinned clock is tuned against its pinned world.
 */
export function firstRaidTickFor(mapSize: number): number {
  return Math.floor((FIRST_RAID_TICK * mapSize) / 64);
}

/**
 * The between-waves clock, scaled the same way and for the same reason:
 * on a bigger map the defender's whole answer to a wave — the march home,
 * the rebuild, the next batch through the barracks — walks proportionally
 * further, while a flat 3-minute respawn kept the classic pressure. The
 * raiders' own longer march absorbs some of it, but the interval starts
 * counting at SPAWN, so back-to-back waves overlapped harder at 96 than
 * 64 ever saw. Exactly RAID_INTERVAL at 64.
 */
export function raidIntervalFor(mapSize: number): number {
  return Math.floor((RAID_INTERVAL * mapSize) / 64);
}

// Training
export const TRAIN_QUEUE_CAP = 5;
/** Forge orders (Smith queue) waiting at once — trainQueue's twin. */
export const FORGE_QUEUE_CAP = 5;

// Lost resident workers respawn after a mourning period.
export const WORKER_RESPAWN_TICKS = 15 * TICKS_PER_SECOND;
