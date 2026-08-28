import {describe, expect, it} from 'vitest';
import {factionTint} from '../render/factionPalette';
import {background, grass, leafDark, rock, water} from '../render/palette';
import {BANDIT} from '../sim/entities';
import {playMin} from '../sim/map';
import * as PathLevel from '../sim/pathLevelEnum.ts';
import * as Terrain from '../sim/terrainEnum.ts';
import * as TileResource from '../sim/tileResourceEnum.ts';
import {ownerTint, paintBase, tileRgb, type MinimapTiles} from './minimapPaint';

const rgb = (c: number): [number, number, number] => [
  (c >> 16) & 255,
  (c >> 8) & 255,
  c & 255,
];

/** An 8-grid with a 4-play square centered in it, all lush meadow. */
function tinyMap(): MinimapTiles {
  const size = 8;
  return {
    size,
    play: 4,
    terrain: new Uint8Array(size * size).fill(Terrain.Grass),
    resource: new Uint8Array(size * size),
    pathLevel: new Uint8Array(size * size),
  };
}

describe('tileRgb', () => {
  it('reads terrain before what stands on it', () => {
    expect(tileRgb(Terrain.Water, TileResource.None, PathLevel.None)).toEqual(
      rgb(water),
    );
    // A mountain is the story even where a deposit shares the tile.
    expect(tileRgb(Terrain.Rock, TileResource.IronDep, PathLevel.None)).toEqual(
      rgb(rock),
    );
    expect(tileRgb(Terrain.Grass, TileResource.Wood, PathLevel.None)).toEqual(
      rgb(leafDark),
    );
    expect(tileRgb(Terrain.Grass, TileResource.None, PathLevel.None)).toEqual(
      rgb(grass),
    );
  });

  it('keeps trails off the chart', () => {
    // A trail is noise at one pixel per tile; a road is worth the pixel.
    expect(tileRgb(Terrain.Grass, TileResource.None, PathLevel.Trail)).toEqual(
      rgb(grass),
    );
    expect(
      tileRgb(Terrain.Grass, TileResource.None, PathLevel.Road),
    ).not.toEqual(rgb(grass));
  });
});

describe('ownerTint', () => {
  it('paints the viewer white, whatever seat they hold', () => {
    // White is nobody's faction color, so "the white banner is you" holds
    // from every seat — including seat 1, whose faction red a rival sees.
    expect(ownerTint(0, 0)).toBe(ownerTint(1, 1));
    expect(ownerTint(0, 0)).not.toBe(factionTint(0));
    // Rivals keep their faction tints; bandits their grey.
    expect(ownerTint(1, 0)).toBe(factionTint(1));
    expect(ownerTint(BANDIT, 0)).not.toBe(undefined);
  });
});

describe('paintBase', () => {
  it('paints the play square only, at one pixel per tile', () => {
    const map = tinyMap();
    const p0 = playMin(map);
    // A forest on the play square's first tile, and one on the scenery
    // ring that must not appear anywhere in the buffer.
    map.resource[p0 * map.size + p0] = TileResource.Wood;
    map.resource[0] = TileResource.Wood;
    const out = new Uint8ClampedArray(map.play * map.play * 4);
    paintBase(map, () => 1, out);
    expect([out[0], out[1], out[2], out[3]]).toEqual([...rgb(leafDark), 255]);
    // Every other pixel is meadow: the ring's forest was cropped out.
    for (let i = 1; i < map.play * map.play; i++) {
      expect([out[i * 4], out[i * 4 + 1], out[i * 4 + 2]]).toEqual(rgb(grass));
    }
  });

  it('shades toward the unknown color, in world coordinates', () => {
    const map = tinyMap();
    const p0 = playMin(map);
    const asked: [number, number][] = [];
    const out = new Uint8ClampedArray(map.play * map.play * 4);
    paintBase(
      map,
      (x, z) => {
        asked.push([x, z]);
        return 0;
      },
      out,
    );
    // Dark everywhere: the fog said nothing has been seen.
    expect([out[0], out[1], out[2]]).toEqual(rgb(background));
    // The shade callback speaks the fog's language — tile centers on the
    // full grid, not chart pixels.
    expect(asked[0]).toEqual([p0 + 0.5, p0 + 0.5]);
    expect(asked.at(-1)).toEqual([p0 + map.play - 0.5, p0 + map.play - 0.5]);
  });
});
