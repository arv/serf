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
 * 34: the herald — a fifteenth command kind (a taunt with an address:
 * sender, structured note, optional strength boast) and a sixth game
 * event (heraldIncoming) it lands as. Pure format: nothing about how a
 * tick executes moved, and every command an old log holds still applies
 * exactly as it did. The bump is for the file — a log recorded on this
 * build can hold herald frames an older sanitizeCommand screens out, and
 * a replay that silently drops the taunts is not the match that was
 * played. (The AI seats send heralds before full assaults on rival
 * castles, so skirmish logs carry them routinely.)
 *
 * 33: every id in the sim is a number. Goods, buildings, units, techs,
 * task tags, job phases, building states, tile resources, command kinds,
 * admin actions, mission and playbook ids — all of them were unions of
 * string literals and are JS enum modules now (shared/enum.ts).
 *
 * Two things this breaks for an older log, either of which is the whole
 * reason for the bump. The command frames in the file name their kind as a
 * word, and sanitizeCommand reads a number — so every order in an old log
 * is screened out and the replay plays an empty match. And the sim ticks
 * differently: a GoodAmounts is keyed by number now, integer keys
 * enumerate in ascending order rather than in the order the goods were
 * authored or first arrived, and the logistics pass reads shelves in that
 * order. A cost written `{stone, wood}` is walked wood-first today, which
 * moves which demand is booked first and therefore which job takes which
 * id.
 *
 * Nothing about the *rules* moved — this is the same game — but "the same
 * seed re-runs the same world" is exactly what a replay rests on, and it
 * no longer holds across the change.
 */
/**
 * 32: the campaign's seven maps are composed rather than rolled. They
 * used to be worldgen output at pinned seeds, frozen to files; they are
 * recipes now (tools/mapAuthor/), each valley shaped around the lesson
 * its mission teaches — timber on one side of the town and stone on the
 * other, the river the bread chain is built along, the one gap a raid can
 * walk through, and a duel map authored as one half and mirrored. Every
 * tile of every mission map moved, so a mission replay recorded on an
 * older build is a log played on different ground. Nothing about how a
 * tick works moved.
 *
 * 31: the scenery ring comes in again, and this time the camera pays for
 * it twice over. VIEW_PAN_INSET charges 0.28 of the frame's footprint
 * against the play square where it charged a quarter, and the zoom-out cap
 * comes in from 0.5 to 0.35 — between them the frame hangs less far past
 * the boundary, and the ring that has to fill it is shallower: 28 tiles on
 * the default valley where it was 40, 36 on the largest where it was 52,
 * and affine in the play side now rather than a flat fraction of it.
 * Every generated world is a different world at the same seed, every tile
 * sits at a different index, and the seven authored mission maps were
 * cropped onto the new grid again (their playable ground is the same
 * ground, re-indexed, campSpots moved with it). Nothing about how a tick
 * works moved.
 *
 * 30: the scenery margin comes in to 0.42 of the playable side, from a
 * half, with the camera's zoom-out cap (the two size each other). Every
 * generated world is a different world at the same seed — the grid is
 * 1.83x the play square instead of 2x, so every tile sits at a different
 * index, worldgen's far-field profile runs a shorter distance, and the
 * seven authored mission maps were cropped to the new grid (their playable
 * ground is the same ground, re-indexed, and each mission's pinned
 * campSpot moved with it). Nothing about how a tick works moved, and
 * nothing had to: a log re-run against a world built from the same seed on
 * an older build is a log played on different ground.
 *
 * 29: metal seams are priced, not measured, and silver is priced higher.
 *
 * A generated valley used to give each faction its iron and silver as a
 * flat amount per tile over a small disc, which meant the seam was worth
 * whatever the ground allowed: a blob on open grass was six tiles and six
 * times the metal, one against a grove or a lake was a single tile. Across
 * four starts that ran to a tenfold spread — 20 silver against 200 — and
 * the seat dealt the thin end mined its whole birthright out mid-match and
 * sent a mine across the map onto a rival's seam. A seam now takes the
 * nearest open tiles it can find and splits a fixed budget over them, so
 * every start is worth the same however the terrain lies. Silver's budget
 * is set above the old best case as well: the tech tree costs 79 and every
 * hand taken off haulage for a post costs four more, so the old ceiling
 * bought the techs or the people and never both.
 *
 * Every generated multiplayer map reshapes — the seam pass draws from the
 * Rng differently, so every downstream draw shifts — and the AI seats then
 * play a different economy on it. The solo mid-ring layout is untouched,
 * deliberately: it has its own tuning and its own winnable coverage, and
 * a solo seat leaves most of its silver in the ground as it is.
 *
 * Riding with it, a change to what the seats do with a tower under attack.
 * A tower with something hostile in sight took the villager levy and
 * nothing else — the manning rule bailed out before it could walk an
 * archer up, and stayed bailed out for thirty seconds after the attacker
 * left. Since the levy throws rocks for about a quarter of what the same
 * two men do with bows, and exists to hold a wall UNTIL archers do, that
 * had it backwards: a seat with archers in the yard answered raids with
 * stones and marched the archers away. Towers now claim soldiers under
 * siege exactly as they do on quiet ground, with the levy as the fallback
 * it was written to be — so who is in a tower, who is left in the field,
 * and the commands the seats issue all move.
 *
 * 28: the campaign grew a fourth commission, Hammer and Haft, with an
 * authored map of its own. Nothing about how the sim ticks moved — but a
 * mission id is config, and an older build does not know this one:
 * sanitizeConfig drops the id it cannot parse and replays the log in a
 * bare seed-350 sandbox, with none of the mission's stock, techs,
 * prebuilt village or objectives. Version equality has to mean the world
 * rebuilds the same, so a new mission map is a bump — the rule
 * defs/maps/README.md states for any map that lands or is tweaked.
 *
 * 27: the tower's halt lever is the whole roof. Halting one used to stand
 * down its levy alone — soldiers were exempt, on the grounds that an idle
 * archer costs the village nothing to keep. What that bought was a tower
 * that read as halted while it stood manned and shooting, and a lever that
 * moved nobody ever again once archers reached it: a standing tower's
 * soldiers never came down, and no villager is let up beside one. Halting
 * now empties the roof whoever is on it, a halted tower calls nobody up and
 * turns arrivals away at the door, and starting it calls them back. The
 * seats keep their quiet-ground halt but hold it back from a tower their
 * soldiers hold, which would otherwise trade a wall for two men in the open
 * every time the ground went quiet. Who is in a tower, what a village has
 * left to haul and fight with, and the commands the seats issue all change
 * — a replay recorded before this build re-runs into a different world
 * within a raid or two.
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
export const REPLAY_VERSION = 34;
