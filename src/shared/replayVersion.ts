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
 * 13: the AI brain gained a stall watchdog and a rewritten rival picture.
 * Both are brain-local memory that reaches the sim only through commands —
 * but the commands differ, so a replay recorded before this build no longer
 * re-runs faithfully.
 *
 * 12 was two sim fixes that shipped together: the pathfinder's
 * runaway-search cap (sim/path.ts, #93) and `unbindWorker` resetting the
 * freed hand to idle (#94).
 */
export const REPLAY_VERSION = 13;
