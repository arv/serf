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
 * 15: the guard tower learns to defend against a rush.
 *
 * Two changes to what it does with the men in it. Its garrison no longer
 * takes the counter table's penalties, only its bonuses — those penalties
 * model closing on a shooter, which a wall is precisely what prevents, and
 * they had the tower at its weakest against the light raiders every early
 * wave is made of. And a tower now takes a levy: villagers hold it with
 * stones until archers exist to relieve them, so the stone buys something
 * before Archery lands rather than three techs after a rush arrives.
 *
 * The levy is worked by the standing orders the game already had. A tower
 * comes off the scaffold with its levy stood down (paused) and calls
 * villagers up only while it is running; halting it sends the ones already
 * up back to work. Soldiers man it either way and are never sent down. The
 * AI seats start a tower when something hostile comes into sight of it and
 * halt it once the ground is quiet, and price a levied tower into their
 * picture of a defended base.
 *
 * Between them these change who is in a tower, what it shoots for and how
 * fast, how many hands the village has left to haul with, and the commands
 * the seats issue — so a replay recorded before this build re-runs into a
 * different world within a raid or two.
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
export const REPLAY_VERSION = 15;
