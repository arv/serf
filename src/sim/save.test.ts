import {describe, expect, it} from 'vitest';
import * as CommandKind from './commandKindEnum.ts';
import type {SimCommand} from './commands.ts';
import {checkInvariants} from './debug/invariants.ts';
import {BUILDING_DEFS} from './defs/buildings.ts';
import * as BuildingTypeId from './defs/buildingTypeIdEnum.ts';
import {UNIT_DEFS} from './defs/units.ts';
import * as UnitTypeId from './defs/unitTypeIdEnum.ts';
import {BANDIT} from './entities.ts';
import * as PlayerKind from './playerKindEnum.ts';
import {deserializeWorld, serializeWorld} from './save.ts';
import {cmds} from './testUtils.ts';
import {tickWorld} from './tick.ts';
import {
  createWorld,
  placeBuiltBuilding,
  spawnUnit,
  startLayout,
  type World,
} from './world.ts';

function commandScript(tick: number): SimCommand[] {
  if (tick === 50)
    return [
      {
        kind: CommandKind.placeBuilding,
        building: BuildingTypeId.woodcutter,
        x: 26,
        y: 36,
      },
    ];
  if (tick === 60)
    return [
      {
        kind: CommandKind.placeBuilding,
        building: BuildingTypeId.well,
        x: 38,
        y: 36,
      },
    ];
  if (tick === 800)
    return [
      {
        kind: CommandKind.placeBuilding,
        building: BuildingTypeId.wheatFarm,
        x: 40,
        y: 30,
      },
    ];
  return [];
}

function digest(world: World) {
  return {
    tick: world.tick,
    rngState: world.rngState,
    nextId: world.nextId,
    units: [...world.units.values()],
    buildings: [...world.buildings.values()],
    jobs: [...world.jobs.values()],
    blocked: [...world.map.blocked],
    wear: [...world.map.wear],
    pathLevel: [...world.map.pathLevel],
    ledger: world.ledger,
    techs: world.players[0]!.techs,
  };
}

describe('save/load', () => {
  it('round-trip at tick N + resume == uninterrupted run', () => {
    const a = createWorld(777);
    for (let t = 0; t < 1500; t++) tickWorld(a, cmds(...commandScript(t)));

    // Snapshot mid-flight (serfs mid-haul, workers mid-chop).
    const saved = serializeWorld(a);
    const b = deserializeWorld(saved);

    for (let t = 1500; t < 3000; t++) {
      tickWorld(a, cmds(...commandScript(t)));
      tickWorld(b, cmds(...commandScript(t)));
    }

    expect(digest(b)).toEqual(digest(a));
    expect(checkInvariants(b).violations).toEqual([]);
  });

  it('rejects unknown versions', () => {
    expect(() => deserializeWorld('{"version":99,"world":{}}')).toThrow();
  });

  it('refuses saves from before the medieval id rename', () => {
    expect(() => deserializeWorld('{"version":1,"world":{}}')).toThrow(
      /older version/,
    );
    expect(() => deserializeWorld('{"version":2,"world":{}}')).toThrow(
      /older version/,
    );
  });

  it('keeps bandits off through a round-trip', () => {
    // The flag lives on the world, not in any entity, so a save that omits
    // it silently resurrects the raiders in a no-bandits match on load.
    const world = createWorld({
      seed: 5,
      players: [{kind: PlayerKind.human}],
      adminEnabled: false,
      banditsEnabled: false,
    });
    expect(deserializeWorld(serializeWorld(world)).banditsEnabled).toBe(false);
  });

  it('save size stays localStorage-friendly', () => {
    const world = createWorld(1);
    for (let t = 0; t < 500; t++) tickWorld(world, cmds(...commandScript(t)));
    const size = serializeWorld(world).length;
    // Halved when the map's grids became base64 (the then-192² world went
    // from ~1.27 MB to ~0.62 MB), and cut again and again as the scenery
    // ring came in and took the grid with it: 176², 168², now 152² and
    // ~0.40 MB. The ceiling moves with the measurement each time, so the
    // next thing to print itself in digits per tile is still caught here.
    expect(size).toBeLessThan(510_000);
  });

  it('opens a save written before the seats were dealt their spots', () => {
    // World.starts arrived with the rolled deal (seatStarts in world.ts).
    // A file older than it sat on the fixed table in seat order — which is
    // a missing optional, not a new shape, so the format did not move for
    // it. What has to hold is the reading: the table, rebuilt, in the same
    // order the build that wrote the file used.
    const world = createWorld({
      seed: 5,
      players: [{kind: PlayerKind.human}, {kind: PlayerKind.ai}],
    });
    const file = JSON.parse(serializeWorld(world)) as {
      world: {starts?: unknown};
    };
    expect(file.world.starts).toBeDefined();
    delete file.world.starts; // as an older build wrote it

    const back = deserializeWorld(JSON.stringify(file));
    const play = back.map.play;
    const margin = (back.map.size - play) / 2;
    expect(back.starts).toEqual(
      startLayout(play, margin, 2)!.map(([x, y]) => ({x, y})),
    );
  });

  it('carries the dealt spots back through a round-trip', () => {
    // The deal is the world's, not the table's: a loaded four-seat match
    // has to put every castle back where its seat actually stood, or the
    // AI's scouts walk to an empty field.
    const world = createWorld({
      seed: 20260901,
      players: Array.from({length: 4}, () => ({kind: PlayerKind.human})),
    });
    const back = deserializeWorld(serializeWorld(world));
    expect(back.starts).toEqual(world.starts);
  });

  it('opens a save written before towers knew who was in them', () => {
    // The levy added Building.garrisonKind, so a file from any earlier build
    // has a manned tower and no word on who is manning it. That is not a new
    // shape — it is a missing optional — so the save format did not move
    // for it, and it called for no bump of its own. What has to hold is
    // the reading: an old garrison is archers, because archers were the
    // only thing that could ever be up there.
    const world = createWorld({seed: 5, players: [{kind: PlayerKind.human}]});
    const tower = placeBuiltBuilding(
      world,
      BuildingTypeId.guardTower,
      0,
      30,
      30,
    );
    tower.garrison = 2;
    tower.garrisonKind = undefined; // as an older build wrote it
    const saved = serializeWorld(world);
    expect(saved).not.toContain('garrisonKind');

    const back = deserializeWorld(saved);
    const loaded = back.buildings.get(tower.id)!;
    expect(loaded.garrison).toBe(2);
    expect(loaded.garrisonKind).toBeUndefined();

    // It shoots like the archers it always was, not like a levy.
    const raider = spawnUnit(back, UnitTypeId.bandit, BANDIT, 34.5, 31.5);
    const before = raider.hp;
    tickWorld(back, []);
    const combat = UNIT_DEFS[UnitTypeId.archer].combat!;
    const rule = BUILDING_DEFS[BuildingTypeId.guardTower].garrison!;
    expect(before - raider.hp).toBeCloseTo(
      combat.damage * rule.damageMult * 2,
      5,
    );

    // And hands archers back, not serfs, when it is emptied.
    tickWorld(
      back,
      cmds({kind: CommandKind.sellBuilding, buildingId: loaded.id}),
    );
    const out = [...back.units.values()].filter(
      u => !u.dead && u.kind === UnitTypeId.archer,
    );
    expect(out).toHaveLength(2);
  });

  it('opens a save written before a man carried his own full health', () => {
    // Unit.maxHp is the same kind of change as garrisonKind above: a missing
    // optional, not a new shape, so the format did not move for it. What has
    // to hold is the reading. Every man in an older file was spawned at his
    // kind's number and the file never said otherwise, so that is what he
    // comes back with — and it must be a number, because a unit loaded
    // without one divides his health by nothing and draws an empty bar.
    const world = createWorld({seed: 5, players: [{kind: PlayerKind.human}]});
    const knight = spawnUnit(world, UnitTypeId.knight, 0, 30.5, 30.5);
    const saved = JSON.parse(serializeWorld(world)) as {
      world: {units: Record<string, unknown>[]};
    };
    for (const u of saved.world.units) delete u.maxHp; // as an older build wrote it

    const back = deserializeWorld(JSON.stringify(saved));
    const loaded = back.units.get(knight.id)!;
    expect(loaded.maxHp).toBe(UNIT_DEFS[UnitTypeId.knight].hp);
    expect(loaded.hp).toBe(loaded.maxHp);
  });

  it('gives an older file’s armoured soldier back the health he stands in', () => {
    // Armour research is older than the field, so a file from before it
    // already holds men above their kind's number. Reading the kind for
    // them would hand a knight carrying 120 a maximum of 80 and put him
    // back in the saturation the field exists to end — whole to the eye
    // until a third of him is gone. What he is carrying is the floor.
    const world = createWorld({seed: 5, players: [{kind: PlayerKind.human}]});
    const knight = spawnUnit(world, UnitTypeId.knight, 0, 30.5, 30.5);
    knight.hp = 120; // Mail Armor and Gilded Arms, as an older barracks left him
    expect(knight.hp).toBeGreaterThan(UNIT_DEFS[UnitTypeId.knight].hp);
    const saved = JSON.parse(serializeWorld(world)) as {
      world: {units: Record<string, unknown>[]};
    };
    for (const u of saved.world.units) delete u.maxHp;

    const loaded = deserializeWorld(JSON.stringify(saved)).units.get(
      knight.id,
    )!;
    expect(loaded.maxHp).toBe(120);
    // ...and he publishes as the whole man he is, not as one at 150%.
    expect(loaded.hp).toBeLessThanOrEqual(loaded.maxHp);
  });
});

const GRIDS = [
  'terrain',
  'resource',
  'resourceAmt',
  'blocked',
  'buildingAt',
  'wear',
  'pathLevel',
  'height',
] as const;

describe('the map grids', () => {
  function savedWorld() {
    const world = createWorld(31);
    for (let t = 0; t < 200; t++) tickWorld(world, cmds(...commandScript(t)));
    return world;
  }

  it('come back exactly — a resumed match ticks on these numbers', () => {
    const world = savedWorld();
    const back = deserializeWorld(serializeWorld(world));
    for (const key of GRIDS) expect(back.map[key]).toEqual(world.map[key]);
  });

  // The reader still takes the old number-array spelling as well as base64.
  // Nothing writes one now — the version that did is below the floor since
  // tools (see canReadSave) — so this is the reader's tolerance under test,
  // not a file anyone has: written at the current version so the gate lets
  // it through to the decoder that is the point of the exercise.
  it('open with grids spelled as number arrays, not base64', () => {
    const world = savedWorld();
    const doc = JSON.parse(serializeWorld(world)) as {
      version: number;
      world: {map: Record<string, unknown>};
    };
    for (const key of GRIDS) doc.world.map[key] = [...world.map[key]];
    const back = deserializeWorld(JSON.stringify(doc));
    for (const key of GRIDS) expect(back.map[key]).toEqual(world.map[key]);
  });

  it('are refused when they are older than the tool economy', () => {
    const doc = JSON.parse(serializeWorld(savedWorld())) as {version: number};
    doc.version = 5;
    expect(() => deserializeWorld(JSON.stringify(doc))).toThrow(
      /older version/,
    );
  });

  it('are refused when they are garbage or the wrong length', () => {
    const doc = JSON.parse(serializeWorld(savedWorld())) as {
      world: {map: Record<string, unknown>};
    };
    const withGrid = (key: string, value: unknown) =>
      JSON.stringify({
        ...doc,
        world: {...doc.world, map: {...doc.world.map, [key]: value}},
      });
    expect(() =>
      deserializeWorld(withGrid('terrain', '~~ not base64 ~~')),
    ).toThrow(/unreadable/);
    // Base64, decodes fine, and describes a world of a different size.
    const short = (doc.world.map.height as string).slice(0, 64);
    expect(() => deserializeWorld(withGrid('height', short))).toThrow(
      /bad map size/,
    );
  });
});
