/**
 * Global tunables. Per-thing numbers (hp, speeds, costs) live on their defs;
 * this file holds cross-cutting knobs so a balance pass is one screen.
 */
import type { GoodAmounts } from './goods.ts';

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
  wood: 36,
  stone: 15,
  // Wheat is for the scholars and the brewer now; the bread the opening's
  // defenders eat is already baked, the same way their spears are already
  // forged. Without it a Soldiery rush would have to stand up the whole
  // mill-and-bakery chain before it could field anyone at all.
  wheat: 12,
  food: 8,
  silver: 20,
  spear: 2,
  sword: 1,
};

// Logistics
export const MATCHER_INTERVAL = 5; // ticks between matcher/reconcile passes
export const JOB_BLOCKED_BACKOFF = 40; // ticks before retrying an unreachable job

// Trails
export const TRAILS_INTERVAL = 20; // ticks between trail passes
export const WEAR_DECAY = 0.98; // per pass multiplier
export const TRAIL_WEAR_THRESHOLD = 12; // wear to become a dirt trail
export const TRAIL_REVERT_WEAR = 1.5; // below this an unpaved trail reverts
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
/** A dismissed post stays open this long before it recruits again, so the
 * freed worker can take up new work instead of being pulled straight back. */
export const DISMISS_RESTAFF_BACKOFF = 30 * TICKS_PER_SECOND;
/** Combat corpses linger this long so the death animation can play. */
export const CORPSE_TICKS = 30;

// Festivals (ale -> global work-speed buff)
export const FESTIVAL_DURATION = 60 * TICKS_PER_SECOND;
export const ABBEY_ALE_CAP = 2;

// Ale Rations (ale -> faster training at the barracks)
export const BARRACKS_ALE_CAP = 2;
/** Divides the training duration when a soldier drinks (never a gate: no
 * ale in the cask just means the course runs at normal speed). */
export const ALE_TRAIN_SPEEDUP = 1.25;

// Raids — paced for the population economy's slower ramp (staffing every
// building and mustering an army both consume people). Stretched by a fifth
// when housing became a gate on that ramp: the castle sleeps ten, so the
// first raid now has to wait out a house as well as a barracks. At the old
// seven minutes every playbook met the first wave a squad short and the
// campaign stopped being winnable.
export const FIRST_RAID_TICK = 540 * TICKS_PER_SECOND; // 9 minutes of peace
export const RAID_INTERVAL = 180 * TICKS_PER_SECOND;
export const RAID_CAP = 8;

// Training
export const TRAIN_QUEUE_CAP = 5;

// Lost resident workers respawn after a mourning period.
export const WORKER_RESPAWN_TICKS = 15 * TICKS_PER_SECOND;
