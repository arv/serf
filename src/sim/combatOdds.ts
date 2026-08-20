import { COUNTER_TABLE, UNIT_DEFS, type UnitClass } from './defs/units.ts';

/**
 * Will this fight be won? — the question the brain never asked.
 *
 * `AiBrain` commits to a march on a bare unit count (`mustersNeeded` against
 * `armyAttackSize`), so seven spearmen read the same whether the defenders are
 * seven archers, which they beat, or seven knights, which slaughter them. This
 * module is the missing comparison: two forces in, one verdict out.
 *
 * The model is Lanchester's *square* law, and it is correct here rather than
 * merely convenient. Movement checks only `map.blocked` — there is no
 * unit-vs-unit collision, so units freely overlap. No frontage, no melee
 * blocking, no formation width: every soldier in an engagement can reach and
 * be reached at once. That is exactly the aimed-fire premise the square law
 * describes. (The *linear* law is the one for a frontage-limited melee, which
 * this game does not have.) Damage is deterministic besides — no hit rolls, no
 * variance, see the strike site in systems/combat.ts — so the differential
 * equations are the whole story, with no distribution to integrate over.
 *
 * With `a`, `b` the two sides' total hit points and `k` each side's damage per
 * point of its own hp:
 *
 *     da/dt = -k_B * b        db/dt = -k_A * a
 *
 * which conserves `k_A*a² - k_B*b²`. Since `k_A * a²` is `(dps_A / hp_A) *
 * hp_A²`, that whole invariant collapses to a product this file calls a
 * force's *power*:
 *
 *     power = dps * hp        and A wins iff power_A > power_B
 *
 * Multiplication only — which matters, because determinism.lint.test.ts bans
 * Math.pow, exp and log across src/sim/, so the textbook exponential solution
 * was never available. Nothing here needs it.
 *
 * The one thing the damage table alone gets wrong is the foot race, so `reach`
 * below corrects for kiting. What the model still does not carry: positions,
 * terrain, arrival order, and the fact that damage kills discrete soldiers
 * rather than draining one pool. It answers "which side is stronger, and by
 * how much", which is the only question the march decision actually asks.
 */

/** A force as the predictor sees it: soldiers by class, and the hit points
 * they are standing on. Hit points are carried separately from counts because
 * the two sources differ — our own army reports live `unit.hp` (armour tech
 * and prior wounds included), while a scouted enemy is counts alone. */
export interface Force {
  heavy: number;
  light: number;
  ranged: number;
  /** Total hp across all three classes. */
  hp: number;
}

/** The unit each class is assumed to be, for damage and hp per soldier. Right
 * for rival seats, who train exactly these; bandits are never predicted
 * against (their camps are exempt from the gate), so their slightly cheaper
 * stats never come up. */
const CLASS_UNIT: Record<UnitClass, 'knight' | 'spearman' | 'archer'> = {
  heavy: 'knight',
  light: 'spearman',
  ranged: 'archer',
};

const CLASSES: readonly UnitClass[] = ['heavy', 'light', 'ranged'];

export const EMPTY_FORCE: Force = { heavy: 0, light: 0, ranged: 0, hp: 0 };

/** Soldiers in a force, hit points aside. */
export function headcount(force: Force): number {
  return force.heavy + force.light + force.ranged;
}

/** Hit points a full-health soldier of this class stands on — how a scouted
 * count becomes an hp pool. Base values: an enemy's armour research is not
 * something a scout can see, so this under-reads a teched rival and the gate
 * errs toward committing. */
export function classHp(cls: UnitClass): number {
  return UNIT_DEFS[CLASS_UNIT[cls]].hp;
}

/** Damage per tick, one soldier of this class, before the counter table. */
function classDamage(cls: UnitClass): number {
  const combat = UNIT_DEFS[CLASS_UNIT[cls]].combat!;
  return combat.damage / combat.cooldownTicks;
}

function countOf(force: Force, cls: UnitClass): number {
  return cls === 'heavy' ? force.heavy : cls === 'light' ? force.light : force.ranged;
}

/**
 * What a melee soldier who cannot catch his target actually lands.
 *
 * The counter table is only half of the triangle; the other half is the foot
 * race. A ranged unit inside `kiteAway`'s loop fires and then walks directly
 * away, so a slower melee chaser spends the fight closing a gap that reopens
 * every tick and never reaches its 1.3-tile reach. That is why one archer
 * kills a marauder outright in combat.test.ts despite half the hit points, and
 * it is a bigger effect than the 1.5 multiplier that nominally represents it.
 * A model without it gets ranged-versus-heavy exactly backwards, reading the
 * heavy side's fatter hp pool as decisive.
 *
 * Not derived — fitted. Low enough that equal numbers go to the archers as the
 * duel says, high enough that numbers still tell and a big enough heavy force
 * still runs ranged down (roughly nine knights to seven archers). Real fights
 * happen among buildings and blocked tiles where the kite eventually snags, so
 * the honest value is neither 1 nor 0.
 */
const KITE_EFFICIENCY = 0.35;

function reach(attacker: UnitClass, defender: UnitClass): number {
  const atk = UNIT_DEFS[CLASS_UNIT[attacker]];
  const def = UNIT_DEFS[CLASS_UNIT[defender]];
  const atkIsMelee = atk.combat!.range <= 2;
  const defIsRanged = def.combat!.range > 2;
  return atkIsMelee && defIsRanged && def.speed > atk.speed ? KITE_EFFICIENCY : 1;
}

/**
 * A force's damage per tick against a particular enemy composition.
 *
 * Each attacking class gets its counter multiplier — and its `reach`, the
 * kiting correction — averaged over the enemy's classes, weighted by where the
 * enemy's *hit points* sit rather than by head count: a lone knight is more of
 * the enemy's real substance than a lone archer, and it is the hp that has to
 * be chewed through. That weighting also
 * matches how targets are actually chosen in combat.ts, which scores
 * candidates `dist / advantage`: a mild pull toward favourable matchups laid
 * over a choice that distance dominates. Modelling a strict best-matchup
 * allocation instead would credit the army with micro nobody performs.
 */
export function damagePerTick(force: Force, enemy: Force): number {
  const enemyHp = enemy.hp;
  if (enemyHp <= 0) return 0;

  // Enemy hp split by class, from counts at full health. Only the *shares*
  // matter below, so a scouted force whose true hp differs from base still
  // weights correctly as long as its composition is right.
  let nominal = 0;
  const share: number[] = [];
  for (const cls of CLASSES) nominal += countOf(enemy, cls) * classHp(cls);
  if (nominal <= 0) return 0;
  for (const cls of CLASSES) share.push((countOf(enemy, cls) * classHp(cls)) / nominal);

  let dps = 0;
  for (const attacker of CLASSES) {
    const n = countOf(force, attacker);
    if (n === 0) continue;
    let mult = 0;
    for (let i = 0; i < CLASSES.length; i++) {
      const target = CLASSES[i]!;
      mult += share[i]! * COUNTER_TABLE[attacker][target] * reach(attacker, target);
    }
    dps += n * classDamage(attacker) * mult;
  }
  return dps;
}

/**
 * The square law's invariant for one side: damage rate times hit points. Two
 * forces' powers are directly comparable — the larger one wins the fight, and
 * the ratio is how comfortably.
 */
export function powerOf(force: Force, enemy: Force): number {
  return damagePerTick(force, enemy) * force.hp;
}

/**
 * The share of our own hit points still standing once the loser is wiped —
 * 0 for a fight we do not win, approaching 1 for a walkover.
 *
 * Straight from the invariant (`k_A*a² - k_B*b² = k_A*aFinal²`), and it is
 * the number the gate actually thresholds on, because raw power is the wrong
 * scale to ask a person for. Power is `dps × hp` and both factors grow with
 * the force, so power is *quadratic* in headcount: two-to-one in bodies is
 * four-to-one in power, three-to-one is nine. Thresholding on that needs a
 * range nobody has intuitions about — measured on this game it took a bar of
 * ~1000% before a march was ever refused. The square root undoes the square,
 * and what comes back is bounded, monotone, and reads in the units a captain
 * would use: 90% is a rout in our favour, 50% a bloody win, 0% a defeat.
 */
export function survivingFraction(force: Force, enemy: Force): number {
  const mine = powerOf(force, enemy);
  const theirs = powerOf(enemy, force);
  if (mine <= 0 || mine <= theirs) return 0;
  return Math.sqrt(1 - theirs / mine);
}

/** The same read in hit points rather than share — for a debug overlay. */
export function survivorsAfter(force: Force, enemy: Force): number {
  return survivingFraction(force, enemy) * force.hp;
}

/**
 * Is this fight worth taking at the given appetite?
 *
 * `marchConfidence` is the share of his own army, as a percentage, that a
 * captain must expect to still be standing afterwards before he will march.
 * 0 marches on anything and is every playbook's default, so an unadvised seat
 * behaves exactly as it did before this file existed; 30 refuses only routs,
 * 60 wants a clear win, 80 wants a massacre.
 *
 * An enemy of nothing is always worth attacking — that is the undefended
 * castle, and refusing it would be absurd.
 */
export function shouldCommit(force: Force, enemy: Force, marchConfidence: number): boolean {
  if (marchConfidence <= 0) return true;
  if (headcount(enemy) === 0 || enemy.hp <= 0) return true;
  return survivingFraction(force, enemy) * 100 >= marchConfidence;
}
