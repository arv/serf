/**
 * The world save-format version. A save is world state read straight back
 * into the sim's records, so only a build whose records match can load one
 * — this number says which shape a file was written in, and loading
 * refuses anything else.
 *
 * Version 3 renamed every sim id (goods, buildings, units, techs) to its
 * medieval form. Version 4 made the grid size per-game data (and grew the
 * default world), so a v3 save's arrays no longer describe any world this
 * build can generate. Version 5 spells the map's tile grids as base64
 * instead of JSON number arrays, which halves a save. Older saves are
 * refused rather than silently mis-loaded — except a version 4 one, whose
 * records are these records (see canReadSave).
 *
 * A module of its own, next to REPLAY_VERSION and for the same reason: the
 * menu stamps it into every save's metadata head so the saves shelf can
 * mark a file it cannot open, and the shelf must be able to read the
 * number without pulling the whole serializer — a worker's worth of code —
 * into the main thread's bundle.
 */
export const WORLD_SAVE_VERSION = 6;

/**
 * Can this build open a file written in that format? Version 5 changed how
 * the map's grids are spelled, not what the world is made of, and so read
 * a 4 quite happily. Six is the other kind of change: tools gate nine of
 * the ten posts now, and every building in an older file was raised under
 * rules where they did not exist — its huts hold no tools, its sites never
 * borrowed a hammer, and its castle has none to send. Such a village loads
 * into a standstill it cannot explain, which is worse than being turned
 * away. So this one really is the floor.
 *
 * The gate every surface asks: the sim on the way in, and the menu twice
 * over — the shelf greys a row it cannot open, and the boot path says so
 * in words when a save arrives by URL or by drag.
 */
export function canReadSave(version: number): boolean {
  return version === WORLD_SAVE_VERSION;
}
