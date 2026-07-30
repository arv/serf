import { GOODS } from './defs/goods';
import type { World } from './world';

/**
 * 32-bit FNV-1a digest of the outcome-relevant world state — the desync
 * detector. Every lockstep client hashes its confirmed world at the same
 * cadence; the relay compares. Fields mirror the determinism-test digest;
 * float coordinates hash by their f64 bit patterns (bit-exact or bust).
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
    mix(u.task.t.length); // cheap task-tag discriminator
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
    if (p.ai) mixU32(p.ai.lastAttackTick);
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
