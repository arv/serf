import {GOODS, type GoodAmounts} from '../sim/defs/goods';
import {TECH_DEFS, type TechId} from '../sim/defs/techs';

/**
 * The one study a seat has running, as the snapshot carries it
 * (TechSnap.active). Structural rather than imported so the pure helpers
 * below can be tested with a literal.
 */
export type ActiveStudy = {
  tech: TechId;
  ticksLeft: number;
  totalTicks: number;
  started: boolean;
  needs?: GoodAmounts;
};

/** A study's whole bill in loads — what it costs, not what is left of it. */
export function hauledTotal(tech: TechId): number {
  const cost = TECH_DEFS[tech].cost;
  return GOODS.reduce((n, g) => n + (cost[g] ?? 0), 0);
}

/**
 * Loads already standing in the Abbey.
 *
 * The snapshot sends what is *left* and only while something is left, so
 * an absent bill has two readings and they need different answers. Once
 * `started` the walk is over by definition and everything is in. Before
 * that, no bill means the Abbey holding it can no longer be read — it came
 * down this tick (see snapPlayers) — and nothing is known, so nothing is
 * counted in: reading the absence as "nothing left to carry" would draw
 * the study as delivered on the frame its roof fell.
 */
export function hauledIn(a: ActiveStudy): number {
  const total = hauledTotal(a.tech);
  if (a.started) return total;
  if (!a.needs) return 0;
  const left = GOODS.reduce((n, g) => n + (a.needs![g] ?? 0), 0);
  return total - left;
}

/**
 * One study, one bar, 0..1 — the walk and the reading joined end to end.
 *
 * An order is two waits with nothing in common but their subject: serfs
 * carry the bill to the Abbey, and only then do the monks start turning
 * pages. Measured separately they made a bar that filled to the brim,
 * dropped to nothing and filled again, which reads as the work being
 * thrown away rather than handed over. So the haul takes the first half
 * and the study the second, and the bar only ever goes forwards.
 *
 * The two halves do not run at the same rate — a hauling village can sit
 * near 0% for a minute while a study is a fixed handful of seconds — but
 * the node says which half it is in (the dashed border, and the line in
 * the panel's head), and a bar that never goes backwards is worth more
 * than one whose halves are to scale.
 */
export function studyProgress01(a: ActiveStudy): number {
  if (!a.started) {
    const total = hauledTotal(a.tech);
    // A bill of nothing is a bill already paid: the halfway mark, not
    // zero. No tech is priced that way today; the guard is for the
    // division, not for a case the defs have.
    return total > 0 ? (hauledIn(a) / total) * 0.5 : 0.5;
  }
  return 0.5 + (1 - a.ticksLeft / Math.max(a.totalTicks, 1)) * 0.5;
}
