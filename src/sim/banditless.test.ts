import {describe, expect, it} from 'vitest';
import * as BuildingTypeId from './defs/buildingTypeIdEnum.ts';
import * as UnitTypeId from './defs/unitTypeIdEnum.ts';
import * as MatchState from './matchStateEnum.ts';
import * as PlayerKind from './playerKindEnum.ts';
import {tickWorld} from './tick.ts';
import {createWorld} from './world.ts';

/**
 * A world generated without bandits has no camp, no guards, and no
 * objective clock: solo becomes a sandbox that only ends if the
 * storehouse falls — not an instant raze-the-camp victory over a camp
 * that never existed.
 */
describe('a banditless world', () => {
  it('places no camp and never auto-wins the solo campaign', () => {
    const world = createWorld({
      seed: 20260724,
      players: [{kind: PlayerKind.human}],
      banditsEnabled: false,
    });
    const camps = [...world.buildings.values()].filter(
      b => b.type === BuildingTypeId.banditCamp,
    );
    expect(camps).toEqual([]);
    const bandits = [...world.units.values()].filter(
      u => u.kind === UnitTypeId.bandit,
    );
    expect(bandits).toEqual([]);

    for (let i = 0; i < 600; i++) tickWorld(world, []);
    expect(world.outcome.state).toBe(MatchState.playing);
  });

  it('with bandits on, the camp still spawns and razing it still wins', () => {
    const world = createWorld({
      seed: 20260724,
      players: [{kind: PlayerKind.human}],
    });
    const camp = [...world.buildings.values()].find(
      b => b.type === BuildingTypeId.banditCamp,
    );
    expect(camp).toBeDefined();
  });
});
