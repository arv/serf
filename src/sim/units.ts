import type {Enum} from '../shared/enum.ts';
import type {GoodId} from './defs/goods.ts';
import {UNIT_DEFS, type FightStats, type UnitTypeId} from './defs/units.ts';
import type {EntityId, Owner} from './entities.ts';
import * as UnitTaskKindNs from './unitTaskKindEnum.ts';

export type UnitTaskKind = Enum<typeof UnitTaskKindNs>;

/**
 * One leg of a queued route, as dealt to ONE unit: the tile he takes in his
 * squad's spread there (or the click itself, when it named an enemy
 * building — the assault takes the click), which of the three ground
 * orders it was (absent is the plain move, the command's own spelling),
 * and the pace his squad marches that leg at, where it binds (see
 * Unit.marchSpeed). Dealt when the leg is queued — tick.ts queueLeg says
 * why — and spent the moment it comes due.
 *
 * `patrol` marks a leg of a beat: taken, it goes back to the end of the
 * route instead of being spent, so a route whose legs all carry it is
 * walked round and round until a fresh order drops it (tick.ts takeLeg).
 * A patrol is two such legs at least — the ordered spot and the spot the
 * unit set out from, which is the beat's `home` — and Shift-P adds
 * another, slotted in just before home so the beat runs the spots in the
 * order they were given and comes home last (tick.ts orderPatrol; the
 * legs rotate as they are taken, so home is the one fixed point to slot
 * against). A plain leg queued behind a beat is walked once, on the round
 * it comes up in, and the beat goes on without it.
 */
export interface Waypoint {
  x: number;
  y: number;
  attack?: true | 'half';
  pace?: number;
  patrol?: true;
  home?: true;
}

/**
 * Task state machines are small discriminated unions; systems switch on
 * `task.t`. Movement is expressed as a path of tile indices plus a cursor.
 */
export type UnitTask =
  | {t: UnitTaskKindNs.idle; until: number} // wander/retry cooldown (tick when eligible)
  | {t: UnitTaskKindNs.move} // player order or wander; goes idle at the end
  // Attack-move: walk toward the ordered tile, engaging whatever comes into
  // acquire range on the way. The destination lives here because fighting
  // consumes the path — the combat system re-plans to it between fights.
  // `engageIdx` quiets the front leg: until the path cursor reaches it the
  // unit walks like a plain move (so a squad ordered away from a lost fight
  // breaks past its attackers instead of wheeling around), then goes live.
  | {
      t: UnitTaskKindNs.attackMove;
      destX: number;
      destY: number;
      engageIdx?: number;
    }
  // Hold ground: stand on this spot and strike only what comes within
  // weapon reach — never chase, never kite, never walk to a wall. The
  // stance Warcraft and StarCraft both call Hold Position. It has no
  // fields because it has no destination: the unit's own feet are the
  // order, and only a fresh order (a move, an attack-move, a focus) ends
  // it. The combat system's hold branch is the only thing that reads it.
  | {t: UnitTaskKindNs.hold}
  // Serf hauling (job id lives on the unit; phase lives on the job):
  | {t: UnitTaskKindNs.haul}
  // Resident worker gather loop:
  | {t: UnitTaskKindNs.gatherOut; tile: number}
  | {t: UnitTaskKindNs.gatherWork; tile: number; until: number}
  | {t: UnitTaskKindNs.gatherHome}
  // Serf walking to a building to become its worker (or a barracks recruit).
  | {t: UnitTaskKindNs.staff; buildingId: EntityId}
  // Bandit strategic objective: march on a player building.
  | {t: UnitTaskKindNs.raid; buildingId: EntityId};

export interface Unit {
  id: EntityId;
  kind: UnitTypeId;
  owner: Owner;
  /** Tile-space position (floats; tile centers are at +0.5). */
  x: number;
  y: number;
  hp: number;
  /**
   * Full health for THIS man, which is not the same number as his kind's.
   * A kind's `hp` is only where he starts: armour research (militaryHp)
   * musters a soldier at up to half again as many, so a knight can walk out
   * of the barracks at 120 against a base of 80. Everything that reports a
   * wound — the bar over his head, the card that names him — measures
   * against this, because measuring against the kind calls an armoured man
   * untouched until a third of him is gone.
   */
  maxHp: number;
  path: number[] | null;
  pathIdx: number;
  task: UnitTask;
  /** Current haul job (serfs). */
  jobId?: number;
  /** Good physically on the unit's shoulders. */
  carrying?: GoodId;
  /** Home building (resident workers). */
  homeId?: EntityId;
  /** Tile the unit occupied last tick — trail wear bookkeeping. */
  lastTile: number;
  /**
   * The squad's pace, tiles/sec — a group move order marches at its slowest
   * member's speed so the fast arms hold formation instead of outrunning
   * the shield line (only set where it binds: units at or below the pace
   * march unmarked). Cleared when the walk arrives, and the moment a fight
   * starts — the counter table prices every chase at true speeds, and a
   * spearman who runs down archers at knight pace isn't a spearman.
   */
  marchSpeed?: number;
  /**
   * The orders behind the one being walked — Shift-clicked waypoints, in
   * the order they were given, the way every RTS since Warcraft II has
   * queued a route. The current leg is NOT in here: it lives in the task
   * and the path like any other order, so nothing that reads a walking
   * unit has to know the queue exists. When that leg ends (the walk
   * arrives, the assault razes its camp, a goal turns out to be sealed
   * off) the tick's waypoint step hands the unit the head of this list as
   * a fresh order (tick.ts waypointSystem). A fresh unqueued order drops
   * the whole list.
   *
   * Absent rather than empty when there is nothing queued, lazily — see
   * clearMarchSpeed for why a bare `= undefined` write is avoided.
   */
  orders?: Waypoint[];
  /**
   * Consecutive ticks a standing enemy has held this walker off (see
   * separation.ts holdOff). A walker wedged against an enemy's rank for
   * DETOUR_AFTER of them re-plans his route round it, and the count starts
   * over for the new route — so it is absent both when nobody holds him
   * and on the tick he detoured. Only ever set on someone that pass takes
   * (takesUpRoom: every soldier, and a civilian mid-fight), and never 0:
   * absent (undefined, lazily — see clearMarchSpeed for why) is the only
   * "no count" state.
   */
  heldTicks?: number;
  // Combat runtime. Not a soldier's alone: a civilian swinging his knife
  // (defs/units.ts MILITIA) keeps his clock and his target here too.
  cooldownLeft: number;
  targetId?: EntityId;
  targetIsBuilding?: boolean;
  /**
   * No building-target repathing before this tick. A raider whose objective
   * is walled off used to fail a full unreachable search, disengage, and
   * re-acquire the same building next tick — one worst-case A* per unit per
   * tick, forever; seven stuck knights alone ground the sim to a crawl.
   * The backoff turns that into one search every couple of seconds.
   */
  repathAt?: number;
  dead: boolean;
  /** Set by combat deaths only — the corpse lingers a moment for the death
   * animation. Absent for despawns (barracks consumption), which vanish at once. */
  deathTick?: number;
}

/**
 * Drop a standing pace cap without touching units that never carried one.
 * The field is added lazily — only members of a mixed squad that a march
 * held back ever get it — and a bare `= undefined` write would add the
 * property (a hidden-class transition) to every unit that walks a route
 * to its end. Every clear site goes through here so none regresses.
 */
export function clearMarchSpeed(unit: Unit): void {
  if (unit.marchSpeed !== undefined) unit.marchSpeed = undefined;
}

/** Drop every queued waypoint. Same lazy-field discipline as clearMarchSpeed. */
export function clearOrders(unit: Unit): void {
  if (unit.orders !== undefined) unit.orders = undefined;
}

export function makeUnit(
  id: EntityId,
  kind: UnitTypeId,
  owner: Owner,
  x: number,
  y: number,
  hp: number,
): Unit {
  return {
    id,
    kind,
    owner,
    x,
    y,
    hp,
    // Everyone is born whole; only the barracks hands out more than a kind
    // carries (see Unit.maxHp), and it raises both numbers together.
    maxHp: hp,
    path: null,
    pathIdx: 0,
    task: {t: UnitTaskKindNs.idle, until: 0},
    lastTile: -1,
    cooldownLeft: 0,
    dead: false,
  };
}

/**
 * Can this man be handed an attack order at all?
 *
 * True for the civilians, who carry a knife (defs/units.ts MILITIA) and
 * fight with it only while an A order is on them. Soldiers are never asked
 * — they have a `combat` block, which outranks this everywhere it is read.
 *
 * The one gate between "a serf may defend himself" and "a serf may be sent
 * at the enemy", so every order that arms somebody goes through it:
 * tick.ts's attack-move, its assault on a building, and its focus order.
 */
export function canTakeUpArms(unit: Unit): boolean {
  return UNIT_DEFS[unit.kind].militia !== undefined;
}

/**
 * What a unit fights with right now, or undefined for one that is not in
 * the war at all this tick. The combat system's per-unit gate (systems/
 * combat.ts) and the separation pass's roster, below, are the same
 * question asked twice, which is why it is answered once here.
 *
 * A soldier's is his weapon and never changes. A civilian's is his order,
 * and that is the whole shape of the feature:
 *
 * - Under an attack order — A over the ground (UnitTaskKind.attackMove) or
 *   over an enemy building (raid) — he fights like the melee unit he is
 *   imitating. He acquires, closes, chases and strikes, at MILITIA's very
 *   low output. This is the only way a villager ever goes looking for a
 *   fight, and it takes a deliberate order every time: a plain move never
 *   arms him, so the ordinary business of the valley is unchanged.
 * - Under anything else — an errand, a stroll, a plain move, standing
 *   idle — he is not in the war, whatever is happening around him. He can
 *   still answer the man cutting him down (systems/combat.ts
 *   lastResortStrike), but that is a reflex, not a fight he is in: it
 *   never moves him a step and never puts him in anyone's way.
 *
 * Spelled as the task rather than as a flag on the unit, so the order IS
 * the state: nothing extra to serialize, and no way for the two to drift.
 */
export function fightOf(unit: Unit): FightStats | undefined {
  const def = UNIT_DEFS[unit.kind];
  if (def.combat) return def.combat;
  if (!def.militia) return undefined;
  return unit.task.t === UnitTaskKindNs.attackMove ||
    unit.task.t === UnitTaskKindNs.raid
    ? def.militia
    : undefined;
}

/**
 * Does this man take up room — the separation pass's roster (systems/
 * separation.ts), which is to say: can other men walk through him?
 *
 * Whoever has a fight in his hands, which is every soldier always and a
 * civilian exactly while an attack order is on him. That is the rule the
 * player is given and the one the order makes visible: an errand walks
 * through a parade and a parade walks through an errand, because the
 * economy must never jam behind a crowd — and a serf you sent in with A is
 * a body like any other, his own side's included, from the moment he sets
 * off to the moment the order ends.
 *
 * The order, not the swing. A hauler who is jumped mid-errand answers with
 * his knife (systems/combat.ts lastResortStrike) and stays a ghost
 * throughout: the alternative made every villager a raid caught in the
 * open turn solid for a few seconds, which is the economy jamming behind a
 * crowd by another name — and it let a fight nobody ordered decide who
 * could walk where. If the player wants a wall of villagers he says so.
 */
export function takesUpRoom(unit: Unit): boolean {
  return fightOf(unit) !== undefined;
}
