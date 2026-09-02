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
 * 41: soldiers take up room.
 *
 * Every soldier on the map — a player's, a rival's, a bandit's — now holds
 * every other soldier off at arm's length (systems/separation.ts, run
 * between movement and combat every tick): two closer than SEPARATION are
 * pushed apart, a man standing his ground is not budged by one walking
 * into him, and the walker is turned aside so he goes round. Against a
 * standing ENEMY the hold is absolute — a rank of knights is a wall; a
 * soldier held at it fights the man holding him (combat.ts fightTheWall)
 * rather than the archer behind, and a walker wedged at it for half a
 * second re-plans his route round it (Unit.heldTicks). Serfs and workers
 * are exempt both ways, so no errand ever jams behind a crowd.
 *
 * This is a tick change through and through. A squad that converged on one
 * enemy used to stop stacked on the first point of its route within reach;
 * it fans out into a ring now, so every soldier stands somewhere else,
 * strikes from somewhere else, and is acquired, chased and shot at from
 * somewhere else — and a column marching down one road arrives spread
 * along it rather than as the stack it left as. The same log re-run on
 * this build fights every battle from different ground, which is exactly
 * what version equality promises it will not do.
 */
/**
 * 40: silver goes home first.
 *
 * A producer's output rides to the storehouse as a priority-3 haul, the
 * bottom of the board — and for nearly every good that is right, since a
 * site pulls its planks from whichever shelf is nearest and the load only
 * has to go home eventually. Silver is the one good that is spent from
 * the STOREHOUSE alone: a hire, a tech and a re-tooled post are all
 * debited there (tick.ts, systems/ai.ts), so a load of it left at the
 * mine buys nothing, and on a busy board the load that would pay for the
 * next hand was one priority-3 job among forty. It now rides at 2
 * (defs/balance.ts EVAC_PRIORITY), level with the mill's wheat and the
 * smith's iron and still behind every site's materials.
 *
 * That is the sim, not a brain: systems/logistics.ts sorts demands and
 * open jobs by priority before age, so the serf who used to shoulder the
 * oldest plank now shoulders the silver instead, and every haul behind
 * him lands a beat later than it did. A log recorded on 39 re-runs with
 * different goods on different backs from the first silver the mine
 * turns out, which is a different game by the first hire.
 *
 * The faster purse found a hole in the bed count, and that is closed in
 * the same bump: a recruit the barracks has enlisted is marked dead and
 * lives on only as a started queue item, and populationOf (sim/population.ts)
 * never counted him — so a hire could land in the window between his
 * enlisting and his walking out a soldier, and the seat ended one head over
 * its cap. Trainees now count, as the garrison already did. That moves the
 * hire gate's answer on a tick where the old count was short, so the
 * recruit who used to be let in at the door now waits there for a bed.
 */
/**
 * 39: a match can be set to a difficulty.
 *
 * Two halves, and only one of them is the reason for the bump. The
 * computer seats play harder or easier — a transform over the knobs a
 * brain has already composed (defs/difficulty.ts), plus a slower decision
 * beat on `easy` — and that is brain only: playback never runs a brain,
 * so it moves no recorded tick, exactly as the road techs (36) and the
 * reserve seam's second mine did not.
 *
 * The half that bumps is the campaign. A commission now scales the human
 * seat's opening by the tier — the storehouse's larder, the hands standing
 * in the yard at the first tick, and the peace before the first raid — so
 * `difficulty` is config that the world is BUILT from, like a mission id
 * (28). An older build's sanitizeConfig drops the field it has never heard
 * of and rebuilds the commission at its printed opening, which is a
 * different world from the first tick: different stock on the shelf,
 * different serfs on the grass, a different raid clock. Version equality
 * has to mean the world rebuilds the same.
 *
 * The beat stagger moved with it — from a fixed 5-tick stride to slots
 * spread across whatever interval a seat thinks on, so that "no two brains
 * on one tick" survives a tier stretching the interval. At the printed
 * cadence it is arithmetically the same offsets (0, 5, 10, 15), and it is
 * brain pacing either way.
 *
 * A seventeenth command kind rides along: `focusTarget`, which puts a
 * named squad on one enemy — a unit, or a building with `building: true`. It is the only order in the game that
 * names a target — everything else leaves that to `acquireUnit` — and the
 * `hard` tier's brain issues it for its ARCHERS (warBehaviorIdEnum
 * `focusFire`: a bow can choose whom to shoot without moving, which a
 * spearman already swinging at the man in front of him cannot), and so
 * does the player: a right-click or an A-click on something hostile now
 * sends an attack-move and this, where before it could only name the
 * ground. Pure format on its own, exactly as the rally point (20) and the herald
 * (34) were: no log written before this build can hold one, and the tick
 * that executes every older order is untouched. It is named here for the
 * reason those two were — a log recorded on this build can carry an order
 * an older sanitizeCommand screens out, and an army that never got its
 * focus order is a different army.
 *
 * The commission's raid pressure scales with it too — the gap between
 * waves after the first, and how many raiders one wave may hold
 * (systems/bandits.ts). Those are ticks, not decisions: the wave lands on
 * a different tick and arrives a different size, so they belong to this
 * bump for the same reason the larder does.
 *
 * A skirmish or a multiplayer match scales nothing — every seat there
 * opens with the larder it always had, and faces the raids it always did,
 * since there the bandits are a neutral third party every seat shares —
 * and a match that names no tier is `normal`, which is the printed game
 * byte for byte. So every log recorded
 * before this build describes a world this build still rebuilds exactly;
 * the bump is for the logs recorded after it.
 */
/**
 * 38: the seats are dealt their start spots.
 *
 * The start table (startLayout in sim/world.ts) is a fixed function of the
 * map size and seat count, so every skirmish opened with the human on the
 * same plateau and the first opponent diagonally opposite it. The valley
 * changed with the seed; where you stood in it never did. seatStarts now
 * shuffles the assignment on its own Rng stream, and the world carries the
 * result (World.starts) rather than recomputing the table.
 *
 * The ground itself is untouched — worldgen still carves the spots in
 * table order, off the same draws, so a seed's map is the map it always
 * was. What moved is which castle stands on which of them: the storehouses
 * and the starting serfs are planted for a different seat, so a log
 * recorded on 37 re-runs against a different opening on this build.
 *
 * (The brain also stopped being told which rival drew which spot — it
 * learns a rival's castle by seeing it now, RivalPicture.home — but a
 * brain change is never the reason for a bump: playback runs the log, not
 * the brain.)
 *
 * The save format takes `starts` as an optional field (the banditsEnabled
 * precedent, no save-version bump): a file written before the deal existed
 * sat on the table in seat order, which is exactly what the fallback in
 * sim/save.ts rebuilds.
 */
/**
 * 37: a hire can be called back. cancelHire (command kind 16) strikes one
 * recruit from the castle's queue and returns his silver in full, so the
 * castle's card can carry the barracks' row of cancellable slots instead
 * of a tally with a "×3" on it. A new command kind is pure format — no
 * log written before it can hold one, and the tick that executes every
 * older order is untouched — which is the half of this version's promise
 * the herald bumped for (34).
 *
 * The one behavior it adds is the leader's clock: striking the man at the
 * head of the queue restarts the walk for the man behind him, because the
 * eight seconds already spent were the cancelled man's. Reachable only
 * through the new command, so nothing recorded on 36 replays differently.
 */
/**
 * 36: every valley has a second silver seam in it.
 *
 * One seam is a finite number of loads, and a match that outlived its
 * silver could not hire a hand, finish a tech or re-tool a post ever
 * again — the village went on looking healthy while it quietly went
 * broke. Worldgen now lays a reserve seam for every start, out past
 * everybody's home ring (map.ts RESERVE_SEAM_BAND, 120 against the home
 * seam's 180) and drawn to be unambiguously that seat's: on generated
 * maps at every seat count, solo included, and on the campaign's
 * authored ground, where four of the five maps that teach silver at all
 * grew one (Hold the Valley already had its pair).
 *
 * Both halves of that are replay surface. Generated worlds re-roll from
 * the same seed: the reserve is drawn last, so the classic mid-ring and
 * every home seam land exactly where they always did, but the draws
 * after it — the stone-in-sight repair among them — walk a different rng,
 * and any log on a generated map plays out on different ground. The
 * mission maps' tiles moved outright.
 *
 * The seat that digs it is a brain change and therefore NOT the reason
 * for the bump (playback never runs a brain): `openReserveMine`
 * (sim/economyRules.ts) sites a second mine on the reserve while the
 * first still has ore in reach, rather than waiting for the stall
 * watchdog to notice a hole in the ground with nothing left in it — and
 * once it is walking that road, the research queue sends for the boots
 * and then the paving ahead of whatever the playbook had printed next
 * (systems/ai.ts AI_HAUL). Both are decisions; a log holds the orders
 * they produced, and the tick that executes those did not move.
 */
/**
 * 35: a sale leaves salvage on the field — nothing teleports. Selling
 * used to destroy everything the building held (the goods the render
 * piles against its front wall went down with walls they were never
 * inside) and mint the half-cost refund straight into the storehouse.
 * Both halves are physical now: the refund and everything the building
 * held — piled output, unspent inputs, the post's tool, a site's
 * borrowed hammer — are left as a salvage pile (a new system building
 * type, id 20) standing on the wreck's own footprint. Serfs cart it home
 * through the ordinary evacuation hauls, nearby sites may draw from it
 * as a supply, the ground stays claimed until the last good leaves, and
 * the pile then clears itself. Combat ignores piles (neither raids nor
 * idle soldiers besiege one), and razing a real building still burns its
 * goods — a sacking is not a sale. This retires version 25's rescue set
 * (tool + a site's hammer), which teleported those two goods home.
 *
 * Death drops ride the same bump: what the fallen held no longer dies
 * with them. A serf killed mid-haul drops the good on his shoulders, and
 * a killed resident worker drops the tool he took up at binding (until
 * now "the raid's second bite of damage") — each as a salvage pile on
 * the tile where he fell, merged into a neighbouring pile when one
 * stands, burned (ledgered) only when no clear tile is in reach or the
 * owner has no economy (bandits). Denying the village its axes now takes
 * holding the ground they fell on, not one arrow.
 *
 * Any log that sells a building or loses a serf re-runs differently from
 * that tick on: refunds and drops arrive by carrier instead of instantly
 * or never, ground stays occupied while piles stand on it, and every
 * haul near a wreck or a battlefield re-times around the new jobs.
 */
/**
 * 34: two changes, developed apart, that never shipped apart — one bump
 * covers both because no replay was ever recorded under either half
 * alone.
 *
 * A mixed squad's move order is dealt out in battle order, and the
 * squad marches as one. The spread tiles a group move fans out over used
 * to go to whichever ids happened to come first in the command; they now
 * go by arm — knights on the edge facing the march, spearmen behind them,
 * archers behind both, civilians at the very rear (tick.ts
 * orderFormation). And the column holds on the way: a group order writes
 * the squad's slowest speed onto its faster members (Unit.marchSpeed), so
 * the arms arrive together instead of trickling in by tuning — the cap
 * lifts on arrival and the moment a fight starts, because the counter
 * table prices every chase at true speeds. Uniform squads are dealt their
 * tiles exactly as before and set their own pace. Any log that ever moved
 * a mixed group — every AI seat's army does — puts its soldiers on
 * different tiles on a different clock from that order on, and every
 * fight they walk into re-runs differently.
 *
 * And the herald — a fifteenth command kind (a taunt with an address:
 * sender, structured note, optional strength boast) and a sixth game
 * event (heraldIncoming) it lands as. Pure format: nothing about how a
 * tick executes moved, and every command an old log holds still applies
 * exactly as it did. The bump is for the file — a log recorded on this
 * build can hold herald frames an older sanitizeCommand screens out, and
 * a replay that silently drops the taunts is not the match that was
 * played. (The AI seats send heralds before full assaults on rival
 * castles, so skirmish logs carry them routinely.)
 */
/**
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
export const REPLAY_VERSION = 41;
