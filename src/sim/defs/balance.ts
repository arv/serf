/**
 * Global tunables. Per-thing numbers (hp, speeds, costs) live on their defs;
 * this file holds cross-cutting knobs so a balance pass is one screen.
 */
import type { GoodAmounts } from './goods';

export const TICKS_PER_SECOND = 20;
export const TICK_MS = 1000 / TICKS_PER_SECOND;

// Population economy: serfs staff every production building and become
// soldiers, so the starting pool is bigger and hiring cheaper.
// One extra pair of hands since builders joined the population economy:
// every site borrows a serf while it rises.
export const START_SERFS = 10;
// The village armory holds a few old weapons so a Bushidō rush can field
// defenders before the first raid without the full iron chain.
export const START_STOCK: GoodAmounts = {
  bamboo: 36,
  stone: 15,
  rice: 12,
  silver: 20,
  yari: 2,
  katana: 1,
};

// Logistics
export const MATCHER_INTERVAL = 5; // ticks between matcher/reconcile passes
export const JOB_BLOCKED_BACKOFF = 40; // ticks before retrying an unreachable job

// Trails
export const TRAILS_INTERVAL = 20; // ticks between trail passes
export const WEAR_DECAY = 0.98; // per pass multiplier
export const TRAIL_WEAR_THRESHOLD = 12; // wear to become a dirt trail
export const TRAIL_REVERT_WEAR = 1.5; // below this an unpaved trail reverts
export const REGROW_INTERVAL = 200; // bamboo regrowth cadence
export const BAMBOO_MAX_AMT = 6;

// Stone-road paving (Masonry)
export const PAVE_INTERVAL = 100; // ticks between paving scans
export const PAVE_WEAR_THRESHOLD = 20; // sustained wear before a trail is paved
export const MAX_CONCURRENT_PAVING = 4; // road sites in flight (never starves construction)

// Hiring
export const HIRE_SERF_COST = 4; // silver
/** Combat corpses linger this long so the death animation can play. */
export const CORPSE_TICKS = 30;

// Festivals (sake -> global work-speed buff)
export const FESTIVAL_DURATION = 60 * TICKS_PER_SECOND;
export const TERAKOYA_SAKE_CAP = 2;

// Raids — paced for the population economy's slower ramp (staffing every
// building and mustering an army both consume people).
export const FIRST_RAID_TICK = 420 * TICKS_PER_SECOND; // 7 minutes of peace
export const RAID_INTERVAL = 150 * TICKS_PER_SECOND;
export const RAID_CAP = 8;

// Training
export const TRAIN_QUEUE_CAP = 5;

// Lost resident workers respawn after a mourning period.
export const WORKER_RESPAWN_TICKS = 15 * TICKS_PER_SECOND;
