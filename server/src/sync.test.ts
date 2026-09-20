import {describe, expect, it} from 'vitest';
import type {WebSocket} from 'ws';
import {DEFAULT_MAP_SIZE, tileIdx} from '../../src/shared/grid.ts';
import * as BuildingTypeId from '../../src/sim/defs/buildingTypeIdEnum.ts';
import * as UnitTypeId from '../../src/sim/defs/unitTypeIdEnum.ts';
import {bindWorker} from '../../src/sim/systems/production.ts';
import {placeSite, spawnUnit} from '../../src/sim/world.ts';
import {
  addSeat,
  createRoom,
  startMatch,
  type Room,
  type Seat,
} from './rooms.ts';
import {facedPoint, sendHot} from './sync.ts';

/**
 * What the hot feed may say about an enemy. A unit's facing and range bytes
 * reconstruct the point it is turned toward — the man it is striking, or
 * the site, tile or post it is working — so the pair carries a location as
 * surely as a coordinate pair does. `buildingsFor` holds an enemy building
 * back until its own center is seen, and a bearing handing the same ground
 * over would walk straight around that.
 */
describe('sendHot: a bearing is a location too', () => {
  const row = {
    id: 1,
    x: 30.5,
    y: 31,
    kind: 0,
    owner: 1,
    hpPct: 255,
    maxHp: 80,
    carrying: 0,
    action: 0,
  };

  it('reconstructs the point a bearing and a range name', () => {
    // A quarter turn (64 of 256) is due east in the renderer's convention;
    // twenty eighth-tiles is two and a half tiles.
    const at = facedPoint({...row, facing: 64, targetDist: 20})!;
    expect(at.x).toBeCloseTo(33);
    expect(at.y).toBeCloseTo(31);
  });

  it('reads “nothing to face” out of a zero range', () => {
    expect(facedPoint({...row, facing: 64, targetDist: 0})).toBeUndefined();
    expect(facedPoint(row)).toBeUndefined();
  });

  /** A socket that keeps what was written to it. */
  const wire = (): {ws: WebSocket; frames: Uint8Array[]} => {
    const frames: Uint8Array[] = [];
    return {
      ws: {
        bufferedAmount: 0,
        send: (f: Uint8Array) => frames.push(f),
        terminate: () => {},
      } as unknown as WebSocket,
      frames,
    };
  };

  /**
   * A rival's builder at (30.5, 31), hammering a site whose center is two
   * and a half tiles due east — the real bearing the sim publishes for him
   * — and one human seat with a hand-built sliver of vision: his own tile
   * lit, the ground his site stands on dark.
   */
  const rig = (): {
    room: Room;
    seat: Seat;
    builderId: number;
    frames: Uint8Array[];
  } => {
    const room = createRoom('closed', {
      ai: 1,
      bandits: false,
      seed: 7,
      size: DEFAULT_MAP_SIZE,
      bots: [],
    });
    const {ws, frames} = wire();
    const seat = addSeat(room, 'human', ws);
    startMatch(room);
    const world = room.world!;
    const site = placeSite(world, BuildingTypeId.woodcutter, 1, 32, 30);
    site.siteNeeds = {}; // every load in: he is hammering, not waiting
    const builder = spawnUnit(world, UnitTypeId.worker, 1, 30.5, 31);
    bindWorker(site, builder);
    const vision = seat.view!.vision;
    vision.visible.fill(0);
    vision.visible[tileIdx(30, 31, world.map.size)] = 1;
    return {room, seat, builderId: builder.id, frames};
  };

  /** That builder's facing + range pair, as the newest frame carries it. */
  const pairFor = (
    frames: Uint8Array[],
    id: number,
  ): {facing: number; dist: number} => {
    const f = frames.at(-1)!;
    const view = new DataView(f.buffer, f.byteOffset, f.byteLength);
    const rows = view.getUint16(5, true);
    const stride = 12 + 11; // id + x + y, then the aux bytes
    for (let i = 0; i < rows; i++) {
      const off = 7 + i * stride;
      if (view.getInt32(off, true) !== id) continue;
      return {facing: f[off + 12 + 7]!, dist: f[off + 12 + 8]!};
    }
    throw new Error(`unit ${id} is not in the frame`);
  };

  it('drops an enemy’s pair when the point it names is unseen', () => {
    const {room, seat, builderId, frames} = rig();
    sendHot(room);
    // He is in the frame at all because his own tile is lit...
    expect(seat.view!.vision.canSee(30.5, 31)).toBe(true);
    // ...and the site he is turned toward stands on ground that is not.
    expect(seat.view!.vision.canSee(33, 31)).toBe(false);
    expect(pairFor(frames, builderId)).toEqual({facing: 0, dist: 0});
  });

  it('keeps the pair when that ground is lit as well', () => {
    const {room, seat, builderId, frames} = rig();
    seat.view!.vision.visible[tileIdx(33, 31, room.world!.map.size)] = 1;
    sendHot(room);
    expect(pairFor(frames, builderId)).toEqual({facing: 64, dist: 20});
  });

  it('puts a bearing that lands on a tile line back on it', () => {
    // cos(3π/2) is -1.8e-16 rather than 0, so a point due west of a man
    // whose own y is a whole number lands a hair below the tile line and
    // floors into the tile before it. Near the top of the map that hair is
    // bigger than the gap between doubles, and the pair was redacted for
    // ground the seat could see perfectly well.
    const at = facedPoint({...row, y: 3, facing: 192, targetDist: 20})!;
    expect(at.x).toBeCloseTo(28);
    expect(Math.floor(at.y)).toBe(3); // not 2
  });

  it('keeps an enemy’s pair when his work lies due west on lit ground', () => {
    const {room, seat, builderId, frames} = rig();
    const world = room.world!;
    const builder = world.units.get(builderId)!;
    const site = world.buildings.get(builder.homeId!)!;
    // Move his site due west of him instead: center (30, 3), which is a
    // tile line in y, and stand him at (32.5, 3) — the floating-point case.
    site.x = 29;
    site.y = 2;
    builder.x = 32.5;
    builder.y = 3;
    const vision = seat.view!.vision;
    vision.visible.fill(0);
    vision.visible[tileIdx(32, 3, world.map.size)] = 1; // his own tile
    vision.visible[tileIdx(30, 3, world.map.size)] = 1; // the site's center
    sendHot(room);
    expect(pairFor(frames, builderId)).toEqual({facing: 192, dist: 20});
  });

  it('never redacts the seat’s own men', () => {
    const {room, seat, builderId, frames} = rig();
    const builder = room.world!.units.get(builderId)!;
    builder.owner = seat.playerId;
    room.world!.buildings.get(builder.homeId!)!.owner = seat.playerId;
    sendHot(room);
    expect(pairFor(frames, builderId)).toEqual({facing: 64, dist: 20});
  });
});
