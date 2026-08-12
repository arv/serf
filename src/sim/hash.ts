import { GOODS } from './defs/goods.ts';
import type { World } from './world.ts';

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
    mixU32(u.hp);
    mixU32(u.owner);
    mix(u.dead ? 1 : 0);
    mixU32(u.pathIdx);
    for (let i = 0; i < u.task.t.length; i++) mix(u.task.t.charCodeAt(i)); // task tag
    if (u.task.t === 'attackMove') {
      // The stored destination steers behavior for many ticks — a clone or
      // save that garbled it must not hash as "the same world".
      mixU32(u.task.destX);
      mixU32(u.task.destY);
    }
  }
  for (const b of world.buildings.values()) {
    mixU32(b.id);
    mixU32(b.hp);
    mixU32(b.owner);
    mix(b.state === 'built' ? 1 : 0);
    mix(b.dead ? 1 : 0);
    for (const good of GOODS) {
      mix(b.stock[good] ?? 0);
      mix(b.inputs[good] ?? 0);
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
