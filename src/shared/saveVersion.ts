/**
 * The world save-format version. A save is world state read straight back
 * into the sim's records, so only a build whose records match can load one
 * — this number says which shape a file was written in, and loading
 * refuses anything else.
 *
 * Version 3 renamed every sim id (goods, buildings, units, techs) to its
 * medieval form. Version 4 made the grid size per-game data (and grew the
 * default world), so a v3 save's arrays no longer describe any world this
 * build can generate. Older saves are refused rather than silently
 * mis-loaded.
 *
 * A module of its own, next to REPLAY_VERSION and for the same reason: the
 * menu stamps it into every save's metadata head so the saves shelf can
 * mark a file it cannot open, and the shelf must be able to read the
 * number without pulling the whole serializer — a worker's worth of code —
 * into the main thread's bundle.
 */
export const WORLD_SAVE_VERSION = 4;
