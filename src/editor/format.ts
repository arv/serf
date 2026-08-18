/**
 * The editor's map file IS the sim's serf-map file (src/sim/mapFile.ts):
 * one format, so an editor export, an editor slot, and a campaign mission
 * map in src/sim/defs/maps/ are the same bytes. The parse and serialize
 * moved to the sim when the campaign started building worlds from these
 * files — every host that owns a world needs them, and the editor is a
 * main-thread-only guest. These aliases keep the editor's vocabulary.
 */
export {
  parseMapJson as parseEditorMap,
  serializeMapFile as serializeEditorMap,
} from '../sim/mapFile.ts';
export type { MapFile as EditorMapFile } from '../sim/mapFile.ts';
