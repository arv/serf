/**
 * Print a serf-map file as ASCII — the fastest way to see whether an
 * authored valley says what its recipe meant. The map editor is the tool
 * for painting; this is the tool for reading a diff.
 *
 *   node --experimental-strip-types tools/mapPreview.ts <map.json> [--camp x,y] [--step n]
 *
 * Legend: `~` water, `^` rim rock, `T` timber, `o` stone, `I`/`S`/`G` iron,
 * silver and gold seams, `C` a start's keep, `B` the bandit camp, and the
 * bare ground shaded by height — ` ` meadow, `.` slope, `:` highland.
 * Only the playable square is drawn; the scenery ring is not somewhere a
 * mission happens.
 */
import {readFileSync} from 'node:fs';
import {tileIdx} from '../src/shared/grid.ts';
import {playMin} from '../src/sim/map.ts';
import {parseMapJson} from '../src/sim/mapFile.ts';
import * as Terrain from '../src/sim/terrainEnum.ts';
import * as TileResource from '../src/sim/tileResourceEnum.ts';

const args = process.argv.slice(2);
const file = args.find(a => !a.startsWith('--'));
if (!file) {
  console.error(
    'usage: node tools/mapPreview.ts <map.json> [--camp x,y] [--step n]',
  );
  process.exit(1);
}
const flag = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const step = Number(flag('step') ?? 1);
const authored = parseMapJson(readFileSync(file, 'utf8'));
const {map} = authored;
const marks = new Map<number, string>();
for (const s of authored.starts) {
  for (let dy = 0; dy < 3; dy++) {
    for (let dx = 0; dx < 3; dx++)
      marks.set(tileIdx(s.x + dx, s.y + dy, map.size), 'C');
  }
}
const camp = flag('camp');
if (camp) {
  const [cx, cy] = camp.split(',').map(Number) as [number, number];
  for (let dy = 0; dy < 3; dy++) {
    for (let dx = 0; dx < 3; dx++)
      marks.set(tileIdx(cx + dx, cy + dy, map.size), 'B');
  }
}
const glyph = (i: number): string => {
  const mark = marks.get(i);
  if (mark) return mark;
  if (map.terrain[i] === Terrain.Water) return '~';
  if (map.terrain[i] === Terrain.Rock) return '^';
  switch (map.resource[i]) {
    case TileResource.Wood:
      return 'T';
    case TileResource.Rock:
      return 'o';
    case TileResource.IronDep:
      return 'I';
    case TileResource.SilverDep:
      return 'S';
    case TileResource.GoldDep:
      return 'G';
  }
  const h = map.height[i]!;
  return h > 1.4 ? ':' : h > 0.7 ? '.' : ' ';
};
const lo = playMin(map);
const hi = lo + map.play;
console.log(
  `${authored.name} — ${map.play}x${map.play} playable, ${authored.players} seat(s)`,
);
for (let y = lo; y < hi; y += step) {
  let row = '';
  for (let x = lo; x < hi; x += step) row += glyph(tileIdx(x, y, map.size));
  console.log(row);
}
