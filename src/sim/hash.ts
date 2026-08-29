import * as BuildingState from './buildingStateEnum.ts';
import {GOODS} from './defs/goods.ts';
import {UNIT_DEFS} from './defs/units.ts';
import * as UnitTaskKind from './unitTaskKindEnum.ts';
import type {World} from './world.ts';

/**
 * 32-bit FNV-1a digest of the outcome-relevant world state. It was the
 * lockstep desync detector; with one simulator there is nothing to compare
 * across machines, and it now serves the tests — "are these two worlds the
 * same" for save/clone round-trips and determinism regressions. Float
 * coordinates hash by their f64 bit patterns (bit-exact or bust).
 */

const scratch = new DataView(new ArrayBuffer(8));

export function hashWorld(world: World): number {
  let h = 0x811c9dc5;
  const mix = (byte: number): void => {
    h ^= byte & 0xff;
    h = Math.imul(h, 0x01000193);
  };
  const mixU32 = (v: number): void => {
    mix(v);
    mix(v >>> 8);
    mix(v >>> 16);
    mix(v >>> 24);
  };
  const mixF64 = (v: number): void => {
    scratch.setFloat64(0, v, true);
    mixU32(scratch.getUint32(0, true));
    mixU32(scratch.getUint32(4, true));
  };

  mixU32(world.tick);
  mixU32(world.rngState);
  mixU32(world.nextId);
  mixU32(world.nextJobId);

  for (const u of world.units.values()) {
    mixU32(u.id);
    mixF64(u.x);
    mixF64(u.y);
    // F64, not U32: the counter table's fractional multipliers land
    // fractional blows, and truncation would call 9.75 and 9.5 the same
    // man — identical until one falls a swing earlier.
    mixF64(u.hp);
    mixU32(u.owner);
    mix(u.dead ? 1 : 0);
    mixU32(u.pathIdx);
    // The route, not just the cursor into it. Two worlds can hold identical
    // positions and still be walking to different places.
    mixU32(u.path?.length ?? 0);
    if (u.path) for (const tile of u.path) mixU32(tile);
    // Combat runtime. Who a unit is fighting, and how far it is through the
    // swing, steer many ticks of behavior before anyone moves a step — which
    // is exactly the window a digest is supposed to close. A save that
    // restored the wrong target hashed as the same world until the fight
    // resolved differently.
    mixU32(u.cooldownLeft);
    // The repath backoff steers when a blocked walker tries again for 45
    // ticks at a stretch. 0 is a safe "no backoff" sentinel: a real
    // repathAt is always world.tick + 45 > 0.
    mixU32(u.repathAt ?? 0);
    mixU32(u.targetId ?? 0); // 0 is a safe sentinel: entity ids start at 1
    mix(u.targetIsBuilding ? 1 : 0);
    // The formation pace steers every step of a march — two worlds can
    // stand identical mid-column and still arrive ticks apart. 0 is a safe
    // "own speed" sentinel: a real pace is always positive.
    mixF64(u.marchSpeed ?? 0);
    mix(u.task.t); // task tag
    if (u.task.t === UnitTaskKind.attackMove) {
      // The stored destination steers behavior for many ticks — a clone or
      // save that garbled it must not hash as "the same world".
      mixU32(u.task.destX);
      mixU32(u.task.destY);
      // 0 is a safe "no quiet leg" sentinel: a real engageIdx is never 0.
      mixU32(u.task.engageIdx ?? 0);
    }
  }
  for (const b of world.buildings.values()) {
    mixU32(b.id);
    // F64 for the same reason as a unit's hp: BUILDING_DAMAGE_MULT lands
    // fractional blows on masonry, and a digest that truncates them calls
    // two walls the same until one falls a tick earlier.
    mixF64(b.hp);
    mixU32(b.owner);
    mix(b.state === BuildingState.built ? 1 : 0);
    mix(b.dead ? 1 : 0);
    for (const good of GOODS) {
      mix(b.stock[good] ?? 0);
      mix(b.inputs[good] ?? 0);
      // An ordered repair steers hauls for many ticks before it moves the
      // hp above; a save that lost the order must not hash as the same world.
      mix(b.repairNeeds?.[good] ?? 0);
    }
    mixF64(b.repairHpPerGood ?? 0);
    // ...and the masonry it has bought but not yet put on the walls.
    mixF64(b.repairPending ?? 0);
    // A tower's garrison is people and a weapon at once: it feeds the
    // population cap and decides what the walls shoot for. A save that
    // dropped it would play on as the same world until something walked
    // into range.
    mix(b.garrison ?? 0);
    // Who is up there: it decides what the walls shoot for, and a save that
    // dropped it would play on as the same world until something walked
    // into range. (Whether the tower is calling anyone up is `paused`,
    // which is mixed with the rest of the standing orders.)
    mix(b.garrisonKind === undefined ? 0 : b.garrisonKind);
    // ...and what each of them walked in with: a save that dropped their
    // wounds would play on as the same world until the tower stood down and
    // handed back men in better shape than the ones who went up.
    mix(b.garrisonHp?.length ?? 0);
    if (b.garrisonHp) for (const hp of b.garrisonHp) mixF64(hp);
    mix(b.attackCooldown ?? 0);
    // The forge's mind: standing order (255 = auto) and the queue ahead of
    // it steer batches for minutes — a save that dropped an order must not
    // hash as the same world.
    mix(b.recipeIndex ?? 255);
    mix(b.forgeQueue?.length ?? 0);
    if (b.forgeQueue) {
      for (const o of b.forgeQueue) {
        mix(o.recipeIndex);
        mix(o.started ? 1 : 0);
      }
    }
    // The rally flag steers every soldier that steps out of the door for as
    // long as it stands — a save that dropped it would march the next
    // recruit to the wrong ground. The presence bit keeps "no flag" apart
    // from "a flag on tile (0,0)".
    mix(b.rally ? 1 : 0);
    if (b.rally) {
      mixU32(b.rally.x);
      mixU32(b.rally.y);
    }
  }
  for (const j of world.jobs.values()) {
    mixU32(j.id);
    mixU32(j.from);
    mixU32(j.to);
    mix(j.priority);
  }
  for (const p of world.players) {
    mix(p.alive ? 1 : 0);
    mix(p.techs.researched.length);
  }

  const blocked = world.map.blocked;
  for (let i = 0; i < blocked.length; i++) mix(blocked[i]!);
  const wear = world.map.wear;
  for (let i = 0; i < wear.length; i++) {
    scratch.setFloat32(0, wear[i]!, true);
    mixU32(scratch.getUint32(0, true));
  }

  return h >>> 0;
}
