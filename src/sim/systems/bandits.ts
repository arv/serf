import { RAID_CAP, RAID_INTERVAL } from '../defs/balance';
import { type UnitTypeId } from '../defs/units';
import { type Building } from '../entities';
import { spawnUnitNearby, type World } from '../world';
import { Rng } from '../../shared/rng';

/**
 * Escalating raids: waves grow and diversify (light -> +ranged -> +heavy) so
 * the player's counter-composition — which really means their weapon economy
 * — has to answer. The wave preview event lets the UI warn with composition.
 */
export function banditsSystem(world: World, rng: Rng): void {
  if (world.outcome !== 'playing' || !world.admin.raidsEnabled) return;
  if (world.tick < world.raidState.nextRaidTick) return;

  const camp = findCamp(world);
  if (!camp) return; // camp destroyed — no more raids

  world.raidState.wave++;
  world.raidState.nextRaidTick = world.tick + RAID_INTERVAL;
  const wave = world.raidState.wave;

  const roster: UnitTypeId[] = [];
  const bandits = Math.min(2 + wave, 5);
  for (let i = 0; i < bandits; i++) roster.push('bandit');
  for (let i = 0; i < wave - 2; i++) roster.push('banditArcher');
  for (let i = 0; i < wave - 4; i++) roster.push('ronin');
  roster.length = Math.min(roster.length, RAID_CAP);

  const target = pickTarget(world, rng);
  if (!target) return;

  for (let i = 0; i < roster.length; i++) {
    const kind = roster[i]!;
    const unit = spawnUnitNearby(
      world,
      kind,
      'bandit',
      camp.x + 1.5 + (i % 4) - 1.5,
      camp.y + camp.h + 1.5 + Math.floor(i / 4),
    );
    unit.task = { t: 'raid', buildingId: target.id };
  }

  const counts = new Map<string, number>();
  for (const kind of roster) counts.set(kind, (counts.get(kind) ?? 0) + 1);
  const names: Record<string, string> = {
    bandit: 'bandits',
    banditArcher: 'bandit archers',
    ronin: 'marauders', // theme-neutral read for the heavy raider
  };
  const text = [...counts.entries()].map(([k, n]) => `${n} ${names[k] ?? k}`).join(', ');
  world.pendingEvents.push({ kind: 'raidIncoming', text: `${text} approaching!` });
}

function findCamp(world: World): Building | undefined {
  for (const b of world.buildings.values()) {
    if (!b.dead && b.type === 'banditCamp') return b;
  }
  return undefined;
}

/** Storehouse-weighted target selection. */
function pickTarget(world: World, rng: Rng): Building | undefined {
  const player: Building[] = [];
  let storehouse: Building | undefined;
  for (const b of world.buildings.values()) {
    if (b.dead || b.owner !== 'player') continue;
    player.push(b);
    if (b.type === 'storehouse') storehouse = b;
  }
  if (player.length === 0) return undefined;
  if (storehouse && rng.next() < 0.6) return storehouse;
  return player[rng.int(player.length)];
}
