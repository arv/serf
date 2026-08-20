/**
 * The replay compatibility version. A replay is a command log re-run
 * through the sim, so it only plays back faithfully on a build whose sim
 * ticks exactly like the one that recorded it — and this number is how a
 * build says which world of behavior it belongs to. Recorders stamp it
 * into every file; playback refuses a file stamped differently.
 *
 * One number for both axes on purpose: a change to the file format and a
 * change to the sim's behavior invalidate old replays the same way, so
 * they share a version rather than maintain two.
 *
 * Bumping it is enforced rather than remembered: replayVersion.test.ts
 * hashes every file this compatibility rests on (the sim, the shared
 * primitives it computes with, the replay format) and fails when the hash
 * drifts. Touching any of that means deciding — did replays just break?
 * bump this — and updating the pinned hash either way.
 *
 * Lives in shared/ because both recorders read it: the client bakes it
 * into its bundle, and the server (plain node, no bundler) imports it
 * directly.
 */
/**
 * 10: the pathfinder's runaway-search cap was raised from half the play
 * area to the whole of it (sim/path.ts) — it was smaller than the walkable
 * component on a 96 map, so a reachable goal across the valley returned
 * null and the order was dropped. Every replay containing a long walk ticks
 * differently now. `unbindWorker` also resets the freed hand to idle, which
 * changes what `dismissWorker` and `sellBuilding` do to a resident released
 * mid-trip (he used to be lost for good).
 */
export const REPLAY_VERSION = 10;
