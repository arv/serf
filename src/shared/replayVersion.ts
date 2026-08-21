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
 * 19: halting a tower is the whole stand-down — it stops villagers being
 * called up and sends the ones already up back to work, where before it
 * only did the first and left them there. Soldiers are untouched by it.
 *
 * 18: the levy is worked by the standing orders the game already had rather
 * than an order of its own. A tower comes off the scaffold with its levy
 * stood down (paused) and calls villagers up only while it is running;
 * soldiers man it either way. The seats start a tower when something
 * hostile comes into sight of it and halt it after, which moves both the
 * commands they issue and when villagers are on a wall at all.
 *
 * 17: the AI seats work the levy. A seat now rings a tower's bell when it
 * sees something hostile come into range of it and stands the villagers
 * down once the ground has been quiet, which moves both the commands the
 * seats issue and the hands their villages have on the job at any moment.
 *
 * 16: the guard tower takes a levy. Villagers can be called up to hold it
 * with stones until archers exist to relieve them, which changes who is in
 * a tower, what it shoots for, and how many hands the village has left to
 * haul with — and the AI's picture of a defended base along with it.
 *
 * 15: a guard tower's garrison no longer takes the counter table's
 * penalties, only its bonuses. Those penalties model closing on a shooter,
 * which a wall is precisely what prevents, and they had the tower at its
 * weakest against the light raiders every early wave is made of. It changes
 * what a tower kills and how fast, which re-times every raid it touches.
 *
 * 14: a batch of balance and content changes — the opening armory is one of
 * each weapon rather than two spears, every building's input and output
 * buffer holds five instead of four, and the guard tower exists: a new
 * building that swallows archers and shoots with them. Two playbooks then
 * learned to use it (the Abbot took up the bow line for it), which moves
 * the commands the AI seats issue for the same reason 13 did. Any one of these re-times a tick; together a replay
 * recorded before this build re-runs into a different world in seconds.
 *
 * 13: the AI brain gained a stall watchdog and a rewritten rival picture.
 * Both are brain-local memory that reaches the sim only through commands —
 * but the commands differ, so a replay recorded before this build no longer
 * re-runs faithfully.
 *
 * 12 was two sim fixes that shipped together: the pathfinder's
 * runaway-search cap (sim/path.ts, #93) and `unbindWorker` resetting the
 * freed hand to idle (#94).
 */
export const REPLAY_VERSION = 19;
