import {describe, expect, it} from 'vitest';
import type {Enum} from '../shared/enum.ts';
import * as CommandKind from './commandKindEnum.ts';
import type {SimCommand} from './commands.ts';
import * as BuildingTypeId from './defs/buildingTypeIdEnum.ts';
import * as GoodId from './defs/goodIdEnum.ts';
import type {GoodAmounts} from './defs/goods.ts';
import * as EconomyRuleId from './economyRuleIdEnum.ts';
import {
  ALL_ECONOMY_RULES,
  ECONOMY_RULES,
  runEconomyRules,
  type EconomyRule,
  type RuleContext,
} from './economyRules.ts';
import * as RulePhase from './rulePhaseEnum.ts';
import {addResourceTile, addStorehouse, bareWorld} from './testUtils.ts';
import * as TileResource from './tileResourceEnum.ts';
import {placeBuiltBuilding, spawnSalvage, type World} from './world.ts';

type EconomyRuleId = Enum<typeof EconomyRuleId>;

/**
 * The rules themselves are covered where they can be seen working — against
 * a real world, in ai.test.ts. What is covered here is the runner, because
 * composition is the whole reason this layer exists and the two things that
 * keep composition honest (claims and groups) have no other home.
 *
 * One rule's CONDITION is pinned here too, at the bottom: resiteExtractor's,
 * because "the hut can no longer work anything" is a different sentence from
 * "there is nothing left in the square" and the gap between them is where a
 * seat's dead quarry used to live forever. Firing it directly is the only
 * way to say which sentence the rule is reading.
 */

const ctx = {} as RuleContext;
const all = new Set<EconomyRuleId>(ALL_ECONOMY_RULES);

/** Three real rule ids, standing in as 'a', 'b' and 'c' did while an id was
 * a free-form string. Which three does not matter — the table machinery
 * only ever compares them. */
const A = EconomyRuleId.resiteExtractor;
const B = EconomyRuleId.freeCappedHauler;
const C = EconomyRuleId.resumeDrainedPost;

/** A stand-in rule: fires unconditionally, claims what it is told to. */
function stub(
  id: EconomyRuleId,
  claims: number[],
  group?: string,
): EconomyRule {
  return {
    id,
    when: 'always, for the test',
    phase: RulePhase.recovery,
    ...(group !== undefined ? {group} : {}),
    fire: () => ({
      commands: [
        {
          kind: CommandKind.sellBuilding,
          buildingId: claims[0] ?? 0,
        } as SimCommand,
      ],
      claims,
    }),
  };
}

/** The real runner over a table of stand-ins — the point being that this
 * exercises `runEconomyRules` rather than a second copy of its logic. */
function runTable(table: EconomyRule[], enabled?: EconomyRuleId[]) {
  const on = new Set<EconomyRuleId>(
    (enabled ?? table.map(r => r.id)) as EconomyRuleId[],
  );
  return runEconomyRules(ctx, on, RulePhase.recovery, table);
}

describe('the rule table', () => {
  it('names every rule it can run, so nothing fires unablatable', () => {
    const byId = (a: number, b: number): number => a - b;
    expect([...ALL_ECONOMY_RULES].sort(byId)).toEqual(
      ECONOMY_RULES.map(r => r.id).sort(byId),
    );
  });

  it('has no duplicate ids — an id is how a sweep addresses a rule', () => {
    expect(new Set(ALL_ECONOMY_RULES).size).toBe(ALL_ECONOMY_RULES.length);
  });

  it('gives every rule a one-line situation', () => {
    for (const rule of ECONOMY_RULES) {
      expect(rule.when.length, `${rule.id} needs a when`).toBeGreaterThan(0);
    }
  });

  it('runs only the phase it is asked for', () => {
    // Phases exist because command order inside a tick is load-bearing, so a
    // rule leaking into the wrong one is a real bug, not a tidiness issue.
    const table = [
      stub(A, [1]),
      {...stub(B, [2]), phase: RulePhase.production},
    ];
    expect(runTable(table).fired).toEqual([A]);
  });
});

describe('composition', () => {
  it('lets rules in different groups answer the same beat', () => {
    // The point of the layer: a cascade would have run only the first.
    const {fired} = runTable([stub(A, [1]), stub(B, [2])]);
    expect(fired).toEqual([A, B]);
  });

  it('keeps one rule per group, so alternatives stay alternatives', () => {
    // How the two stall-recovery rules keep the first-wins behaviour they
    // were measured with.
    const {fired} = runTable([
      stub(A, [1], 'g'),
      stub(B, [2], 'g'),
      stub(C, [3]),
    ]);
    expect(fired).toEqual([A, C]);
  });

  it('will not let two rules order the same building in one beat', () => {
    const {fired} = runTable([stub(A, [7]), stub(B, [7])]);
    expect(fired).toEqual([A]);
  });

  it('yields only the conflicting rule, not the ones after it', () => {
    const {fired} = runTable([stub(A, [7]), stub(B, [7]), stub(C, [9])]);
    expect(fired).toEqual([A, C]);
  });

  it('orders commands by the table, not by when a rule happened to fire', () => {
    const {commands} = runTable([stub(A, [1]), stub(B, [2])]);
    expect(
      commands.map(c =>
        c.kind === CommandKind.sellBuilding ? c.buildingId : -1,
      ),
    ).toEqual([1, 2]);
  });
});

describe('the ablation handle', () => {
  it('runs nothing at all when the set is empty', () => {
    const out = runEconomyRules(
      {...ctx, stalled: true} as RuleContext,
      new Set(),
      RulePhase.recovery,
    );
    expect(out.commands).toEqual([]);
    expect(out.fired).toEqual([]);
  });

  it('runs only what it is given', () => {
    const {fired} = runTable([stub(A, [1]), stub(B, [2])], [B]);
    expect(fired).toEqual([B]);
  });

  it('reports which rules fired, so a null result is diagnosable', () => {
    // A rule that never fires and a rule that fires without helping produce
    // the same win rate — telling them apart is what this is for.
    const {fired} = runTable([stub(A, [1], 'g'), stub(B, [2], 'g')]);
    expect(fired).toEqual([A]);
  });
});

describe('the real rules stay quiet on a healthy seat', () => {
  /** A seat with its people, its buildings, and nothing wrong. */
  const healthy = {
    world: {units: new Map(), map: {}},
    owner: 0,
    mine: [],
    stock: {},
    serfCount: 3,
    // Empty hands, like every other field here: the brain fills this in
    // the same sweep it counts serfs in, so a context without it is a
    // context no rule ever really sees.
    carried: {},
    stalled: false,
    strategy: {survivalFloor: 3},
  } as unknown as RuleContext;

  it('fires nothing when the watchdog reads no stall', () => {
    // What keeps an unstalled game byte-identical to the one before this
    // layer existed. Two of the rules are not stall-gated any more — a
    // village short of hands is a dead end rather than evidence of one — so
    // the guard that has to hold here is theirs: a seat with its people is
    // never taken apart for a hauler, and its barracks is never stood down.
    // Which side of THAT gate a reading falls on is covered against a real
    // world in ai.test.ts, where there are buildings to order around.
    expect(runEconomyRules(healthy, all, RulePhase.recovery).fired).toEqual([]);
    expect(runEconomyRules(healthy, all, RulePhase.production).fired).toEqual(
      [],
    );
  });
});

/**
 * The re-siting rule's condition, which is the whole rule: everything after
 * it is a sell command.
 *
 * It used to ask `findResourcesNear` — is there anything of the kind inside
 * the radius — and a single tile the worker cannot walk to answers that yes
 * for the rest of the match. So the one rule that exists to move a hut off
 * dead ground was blind to the deadest ground there is: a quarry whose last
 * rock stood ringed by its own grove had no trips to make and no way to be
 * moved, and it sat there through eight minutes of a real match while the
 * barracks it fed waited on five stone.
 */
describe('resiteExtractor: what counts as dead ground', () => {
  const rule = ECONOMY_RULES.find(r => r.id === EconomyRuleId.resiteExtractor)!;

  /** The rule reads three fields, and `nearestClaimableResource` reads the
   * seat's ground off the world. The rest of the context is the runner's. */
  function contextFor(world: World): RuleContext {
    return {
      world,
      owner: 0,
      mine: [...world.buildings.values()].filter(b => b.owner === 0),
    } as RuleContext;
  }

  /** A quarry at (30,30) with one rock in reach, ringed by `wall`. */
  function quarryWithSealedRock(wall: boolean): World {
    const world = bareWorld();
    addStorehouse(world, 60, 60, {});
    placeBuiltBuilding(world, BuildingTypeId.quarry, 0, 30, 30);
    addResourceTile(world, 35, 31, TileResource.Rock);
    if (wall) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          addResourceTile(world, 35 + dx, 31 + dy, TileResource.Wood);
        }
      }
    }
    // Somewhere to go: the rule refuses to sell a hut with no better spot
    // on the seat's own side of the valley, so give it fresh rock.
    addResourceTile(world, 58, 58, TileResource.Rock);
    return world;
  }

  it('holds its hand while the hut can still work its ground', () => {
    expect(rule.fire(contextFor(quarryWithSealedRock(false)))).toBeNull();
  });

  it('sells a hut whose last ground it cannot reach', () => {
    const world = quarryWithSealedRock(true);
    const quarry = [...world.buildings.values()].find(
      b => b.type === BuildingTypeId.quarry,
    )!;
    const fired = rule.fire(contextFor(world));

    expect(fired?.claims).toEqual([quarry.id]);
    expect(fired?.commands).toEqual([
      {kind: CommandKind.sellBuilding, buildingId: quarry.id},
    ]);
  });
});

/**
 * The trap: every gatherer in the game is priced in wood, and the only
 * building that makes wood is the woodcutter. A seat whose last hut burns
 * on an empty shelf therefore cannot buy the one thing that would let it
 * buy anything — and nothing before this rule ever reached for the sale
 * that would break it. Found on seed 42 at four seats, where it froze an
 * Abbot sitting on bread, iron and stone for sixty thousand ticks with
 * three hundred tree tiles inside twenty of its castle, and left the match
 * with no possible ending.
 */
describe('sellForTheWoodcutter: paying for the axe with a roof', () => {
  const rule = ECONOMY_RULES.find(
    r => r.id === EconomyRuleId.sellForTheWoodcutter,
  )!;

  /** `mine` sorted, because RuleContext documents it as ascending id and
   * this rule's tie-break rides on that. A Map happens to hand back
   * insertion order, which happens to be id order — "happens to" twice is
   * not what a contract is worth testing against. `carried` is the loads
   * the seat's serfs are holding, which the rule counts as its own wood. */
  function contextFor(world: World, carried: GoodAmounts = {}): RuleContext {
    return {
      world,
      owner: 0,
      mine: [...world.buildings.values()]
        .filter(b => b.owner === 0)
        .sort((a, b) => a.id - b.id),
      carried,
    } as RuleContext;
  }

  /** A seat with trees in reach, a barracks to sell, and whatever wood the
   * caller says is on the shelf. */
  function strandedSeat(wood: number): World {
    const world = bareWorld();
    addStorehouse(world, 60, 60, {[GoodId.wood]: wood});
    placeBuiltBuilding(world, BuildingTypeId.barracks, 0, 30, 30);
    addResourceTile(world, 58, 58, TileResource.Wood);
    return world;
  }

  it('sells a roof when the last woodcutter is gone and the shelf is bare', () => {
    const world = strandedSeat(0);
    const barracks = [...world.buildings.values()].find(
      b => b.type === BuildingTypeId.barracks,
    )!;
    const fired = rule.fire(contextFor(world));

    expect(fired?.claims).toEqual([barracks.id]);
    expect(fired?.commands).toEqual([
      {kind: CommandKind.sellBuilding, buildingId: barracks.id},
    ]);
  });

  it('holds its hand while the seat can still afford the hut itself', () => {
    // Six wood is the woodcutter's price: a seat holding it is not
    // stranded, it is one build order away from cutting again.
    expect(rule.fire(contextFor(strandedSeat(6)))).toBeNull();
  });

  it('holds its hand while a woodcutter still stands, empty shelf or not', () => {
    const world = strandedSeat(0);
    placeBuiltBuilding(world, BuildingTypeId.woodcutter, 0, 40, 40);
    expect(rule.fire(contextFor(world))).toBeNull();
  });

  it('counts the wood on the ground, so one sale is not five', () => {
    // The salvage a sale leaves is the seat's wood as much as the shelf is,
    // and counting it is what makes the rule self-limiting: the pile lands
    // the instant the wreckers finish, and the next beat sees a seat that
    // can pay.
    const world = strandedSeat(0);
    spawnSalvage(world, 0, 50, 50, 1, 1, {[GoodId.wood]: 6});
    expect(rule.fire(contextFor(world))).toBeNull();
  });

  it("counts the planks already in a serf's hands", () => {
    // The window this closes: logistics takes a good off its source at
    // PICKUP and parks it on the carrier, so the salvage this rule just
    // bought reads as nothing at all while it walks home. A rule blind to
    // that watches its own rescue vanish and sells another roof to replace
    // it, every beat, until the village is gone — which is what the first
    // version of it did.
    const world = strandedSeat(0);
    expect(rule.fire(contextFor(world, {[GoodId.wood]: 6}))).toBeNull();
  });

  it('will not sell the bread out of the village to buy an axe', () => {
    // The first version of this rule took the biggest refund full stop and
    // sold the Abbot's bakery, trading a wood famine for a bread famine.
    // With nothing but the larder standing, it says nothing at all.
    const world = bareWorld();
    addStorehouse(world, 60, 60, {[GoodId.wood]: 0});
    placeBuiltBuilding(world, BuildingTypeId.bakery, 0, 30, 30);
    placeBuiltBuilding(world, BuildingTypeId.house, 0, 34, 30);
    addResourceTile(world, 58, 58, TileResource.Wood);
    expect(rule.fire(contextFor(world))).toBeNull();
  });

  it('holds its hand where there is no grove left to stand a hut by', () => {
    const world = bareWorld();
    addStorehouse(world, 60, 60, {[GoodId.wood]: 0});
    placeBuiltBuilding(world, BuildingTypeId.barracks, 0, 30, 30);
    expect(rule.fire(contextFor(world))).toBeNull();
  });
});
