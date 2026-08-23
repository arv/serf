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
 * 27: the campaign grew a fourth commission, Hammer and Haft, with an
 * authored map of its own. Nothing about how the sim ticks moved — but a
 * mission id is config, and an older build does not know this one:
 * sanitizeConfig drops the id it cannot parse and replays the log in a
 * bare seed-350 sandbox, with none of the mission's stock, techs,
 * prebuilt village or objectives. Version equality has to mean the world
 * rebuilds the same, so a new mission map is a bump — the rule
 * defs/maps/README.md states for any map that lands or is tweaked.
 *
 * 26: villagers slow to a walk — serf 1.8 -> 1.5 tiles/sec, worker 1.7 ->
 * 1.4. Purely a pacing change asked for by eye: the village read as
 * everyone sprinting between errands, and the renderer's gait work could
 * only paper over so much (the legs are honest now; the ground speed was
 * not). Soldiers, bandits, and the raid clock keep their tuning, so every
 * haul, commute, and construction staffing re-times while combat does not
 * — a replay recorded before this build diverges within the first errand.
 *
 * 25: a sold Smith loses its forged hammers with the rest of its stock.
 * The sale's rescue set carried 'hammer' unconditionally — meant for the
 * hammer a half-built site borrows — so a built Smith's forged hammers
 * walked to the storehouse for free while the axes on the same shelf
 * were lost. The hammer now rides the rescue only for a site. Any log
 * that sells a Smith holding hammers banks fewer tools from that tick
 * on.
 *
 * 24: a garrisoned tower fires on the field archer's own period. The
 * tower's cooldown gate continued on the tick the count reached zero,
 * stretching every volley to cooldownTicks + 1 — two archers on the
 * roof shot ~2.4% slower than the same two men on the grass, and the
 * levy's 30-tick clock was really 31. Every tower volley after the
 * first now lands a tick sooner, and every fight in reach of one
 * re-times with it.
 *
 * 23: the between-waves raid clock scales by the playable span, as the
 * opening peace always did. banditsSystem was passing the full grid side
 * (2x the playable side on every generated map) to raidIntervalFor, so
 * every wave after the first arrived at half the tuned pressure — 540s
 * apart on the default valley instead of 270s. Waves land on different
 * ticks now, and everything after the second wave re-times with them.
 *
 * 22: pausing a guard-tower construction site sticks. The staffing
 * exemption that keeps a BUILT tower's door open to soldiers while it is
 * halted also matched the tower's site, so a paused scaffold kept
 * summoning and re-binding the builder the order had just released — the
 * pause silently undone, one hand bound doing nothing. The exemption now
 * asks for a built tower. Any log in which a tower site sat paused staffs
 * differently from that order on.
 *
 * 21: trails come sooner and linger — the trail pass (which runs every
 * TRAILS_INTERVAL ticks, checking each tile after its wear decay) now
 * turns worn grass into a dirt trail at 10 wear instead of 12, and
 * reverts an unused trail below 0.75 wear instead of 1.5. Trail tiles
 * are faster and preferred by A*, so earlier trails re-time every walk
 * that crosses them.
 *
 * 20: the barracks learns a rally point. A new command (setRallyPoint)
 * plants or strikes a muster flag on any building that trains, and every
 * soldier that finishes training marches from the door to the flag as a
 * plain move. Old logs never carry the command and a flag never stands
 * unasked, so their play is untouched — the bump is for the format: a log
 * recorded on this build can carry an order older builds drop, and a
 * dropped order is a different army standing in a different place.
 *
 * 19: sieges slow down and the castle hardens — damage against buildings
 * lands at a fraction set by the attacker's arm (BUILDING_DAMAGE_MULT:
 * three quarters for melee, half for the bow — ten archers were leveling
 * the castle in twenty seconds), and the castle stands on 750 hp instead
 * of 500. Besiegers also learn to answer a blow: a unit struck
 * while hammering a wall turns on its attacker instead of dying without
 * reply — building targets never drop on their own, so a besieging army
 * used to be carved up by a handful of guards it outnumbered three to one. With them rides a pathfinder repair the new siege
 * pace uncovered: the A* heap's lazy decrease-key rewrote a per-tile key
 * under entries already in the heap, and the out-of-order pops that
 * followed could push a reachable march over the runaway cap — an army
 * frozen mid-map. Per-entry keys and an expanded-tile stamp fix the order,
 * which also re-times every walk a corrupted pop ever steered.
 *
 * 18: the tools economy (#103) — nine posts need a tool to work and the
 * Smith makes them all. Recorded here after the fact: that change moved
 * the number without leaving a line, and a gap in this list reads like a
 * lost version rather than a documented one.
 *
 * 17: one lever where there were two — pausing a building now empties it.
 *
 * The dismiss order is gone, and halting a building does what it did: the
 * resident (or a site's builder) walks off a serf again, a recruit already
 * on his way is turned away at the door, and a halted post calls nobody up
 * for as long as it stands halted — so the restaffing backoff the dismiss
 * order needed is gone too. Starting the place again is what asks for a
 * worker back. On a tower the lever was already the whole levy; it is now
 * the whole of every other post as well.
 *
 * That moves the seats' commands (the stall watchdog's hauler rule halts a
 * capped post instead of dismissing it, and starts it again once the pile
 * has shipped) and it moves the sim: a command kind no longer exists, and
 * the one that replaced it releases hands the old one left in place. A
 * replay recorded before this build re-runs into a different village within
 * a stall or two.
 *
 * 16: the opening armory goes back to two spears and a sword. Version 14
 * traded the second spear for a bow that had to wait on Archery to be
 * spent; the rack now holds only what a Soldiery rush can field on day
 * one. The first recruits differ, so every tick after the first barracks
 * order does too.
 *
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
export const REPLAY_VERSION = 27;
