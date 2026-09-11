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
 * 65: an age lapses with the last demand that was keeping it.
 *
 * A building's FIFO clock lives per (building, good) while its demands do
 * not, and until this build whoever finished with one had to guess whether
 * anybody else was still standing in that queue. 64 made the guess one
 * predicate (`stillWants`), but one that knew the bills and the standing
 * ale and nothing else — so a repair settling at a Smith still dropped the
 * clock its forge's wood was standing on, and a post's tool, a mine's
 * pantry or a training queue could lose theirs the same way.
 *
 * Now nobody guesses. The matcher already walks every demand of every
 * building each pass, so it marks which demands hold each clock
 * (Building.demandHeld) and settles the clocks itself (settleAges,
 * sim/systems/logistics.ts): held by nobody, a clock lapses; held by a
 * demand that held it last pass, it goes on; held only by demands that did
 * not, it starts over. A bill settling or called off just takes its own
 * mark off (releaseDemandHold, sim/world.ts), and the clock goes at the
 * next pass rather than on the spot.
 *
 * Ages decide which of two demands at the same tier a serf answers first,
 * so hauls sort differently wherever a clock used to be dropped out from
 * under a demand still keeping it, or carried over to one that opened
 * after its keeper had ended (a festival cap that reopens behind a settled
 * study now starts its own age). A log recorded on 64 re-runs through a
 * village that answers some of its errands in a different order.
 *
 * The new field is optional, so a save written before it still loads (the
 * banditsEnabled precedent in save.ts); its clocks read as held by nobody
 * and start over on the first pass.
 *
 * 64's note follows.
 */
/**
 * 64: a study can be called off.
 *
 * A nineteenth command kind, `cancelResearch` (sim/commandKindEnum.ts) —
 * format, the way the herald (34) and the focus order (39) were: no log
 * written before this build can hold one, and it is named here for those
 * two's reason — a log recorded on THIS build can carry an order an older
 * sanitizeCommand throws away, and a seat whose abandoned study was never
 * abandoned goes on studying it, never takes up the one it took up next,
 * and unlocks everything downstream on different ticks or not at all.
 *
 * And behavior, which those two were not. The order needed three things
 * around it that every match feels, cancelled study or no:
 *
 * - A good's FIFO clock is now dropped only by whoever was last to want
 *   it. The age of an unmet demand lives per (building, good) while the
 *   demands do not, and an Abbey can owe a repair, a study and the
 *   festival's ale in one key — so a repair settling, a study settling, a
 *   study called off and the matcher's own pass all ask one predicate
 *   (`stillWants`, sim/world.ts) before forgetting anything. Ages decide
 *   which of two demands at the same tier a serf answers first, so this
 *   moves which hand takes which job.
 * - A load gives up its reservation before it goes through the door
 *   rather than after (`releaseDest` ahead of `deliver`, every delivery in
 *   the game), because the threshold is where that question is now asked.
 * - AdminAction.finishResearch calls the study's hauls back instead of
 *   leaving them to the reconciler, and a load rehomed into a roof that
 *   is both mending and studying is marked for the bill it is actually
 *   walking into.
 *
 * A log recorded on 63 re-runs through a village that sorts some of its
 * hauls differently, which is a different village within a minute.
 *
 * What it fixes is the trap the credit rule (62) opened. Ordering a study
 * spends nothing and gates on nothing, so a seat can order one its village
 * has no way to supply — Gilded Arms is billed in gold, and a village with
 * no gold on the shelf and no Deep Mining to dig any will never carry that
 * bill in. One study at a time meant the whole tree waited behind it for
 * the rest of the match. The order can now be dropped: the bill goes off
 * the Abbey, the hauls walking it there are called back on that same tick
 * with their cargo kept for rehoming, and the slot opens (abandonResearch
 * in sim/systems/research.ts, cancelRepair's twin — leaving the jobs to
 * the haul reconciler would open a window up to a matcher interval wide in
 * which one can still be dispatched or delivered). Loads already carried
 * IN stay spent: they were consumed at the threshold, as a repair's stone
 * is.
 *
 * 63's note follows.
 */
/**
 * 63: the festival reaches the field, and the brewery is quarried.
 *
 * Ale used to buy the village a quarter more work and nothing else. A
 * festival now also divides every soldier's recovery between blows and
 * every tower's between volleys by the same FESTIVAL_SPEEDUP
 * (systems/combat.ts strikeCooldown, techHelpers.ts getModifier on
 * ModifierKey.fightSpeed): a knight under one swings every 16 ticks
 * rather than 20, an archer every 19 rather than 24, and the archer's
 * kite plant is measured off that shorter clock so the man is still
 * planted eight ticks of it. Every fight an owner with ale in the Abbey
 * takes lands its blows on different ticks with different men standing,
 * so a log recorded on 62 diverges at the first arrow of its first
 * festival.
 *
 * The brewery's bill moves in the same build, from ten wood and four stone
 * to twelve stone (defs/buildings.ts): a site raised on an old log asks
 * the matcher for different loads, and the hauls that answer it take
 * different hands off the board on different ticks.
 *
 * 62's note follows.
 */
/**
 * 62: a study is carried to the Abbey before it begins.
 *
 * The research command used to take a tech's goods off the storehouse
 * shelf and start its clock in the same tick. It writes the bill on the
 * Abbey instead (tick.ts), the matcher hauls it there like a site's
 * materials (systems/logistics.ts), each load is spent at the door, and
 * the clock starts when the last one lands (systems/research.ts). Every
 * tech's durationTicks was cut to 0.6 of what it was to pay for the walk.
 *
 * With the payment goes the gate: the command used to refuse an order the
 * storehouse could not cover that instant, and takes it on credit now, the
 * way a building site is pegged out on credit (buildUnlocked in
 * ui/buildMenu.ts says the same of the ribbon). So a log can also carry a
 * research order an older build simply threw away.
 *
 * Nothing about that replays: a log recorded before this build spends
 * goods on a tick this one does not, hauls that never existed take hands
 * off the board for a minute at a time, and every research lands on a
 * different tick — which moves every unlock, and with it every order that
 * waited on one.
 *
 * 62, written as 60: main took 60 for the Archery Range's footprint and
 * 61 for the repair pull while this branch was in review. Third number
 * for one change, and every note below this one says the same of itself
 * — the number is whatever is free on the day it lands.
 *
 * 61's note follows.
 */
/**
 * 61: an ordered repair pulls the loads already walking its way up to its
 * own tier (systems/logistics.ts, repairPull/tierOf). Which hand takes
 * which job, and in what order, decides where every good in the village is
 * a second later — this is as behavioral as a change gets, and a log
 * recorded before it re-runs into a different world within a few hundred
 * ticks.
 *
 * 61, written as 55: main took 55, then 56, 57, 58 and 59, and then 60 for
 * the Archery Range's footprint while this branch sat in review — six
 * numbers for one change. Every note below says the same of itself, which
 * by now is the pattern rather than the accident: the number is whatever
 * is free on the day it lands.
 *
 * What it fixes: the matcher books a repair at construction priority and
 * then nets what it asks for against `inbound`. At the storehouse — where
 * every producer in the village evacuates to, so inbound is permanently
 * thick with priority-3 hauls — that netting always came out at or below
 * zero, no tier-1 job was ever booked, and the order's priority was
 * silently discarded. A recorded match had the castle repaired at 60%
 * health and the order still reading "wants 3 wood, 2 stone" 3,700 ticks
 * later, when the building was destroyed under it. The same match now
 * settles the bill 711 ticks after it is ordered.
 *
 * A pull rather than a fresh booking, because the netting is right about
 * quantity: a load already walking in feeds the mend when it lands
 * (deliver puts any good arriving at a building with an outstanding
 * repairNeeds straight into the walls), so booking a second would haul a
 * plank nobody needed moved. Only the rank was wrong, and only the rank
 * moves.
 *
 * 60's note follows.
 */
/**
 * 60: the Archery Range stands on the barracks' footprint, pays a mason
 * for it, and takes the hit points that go with both.
 *
 * Two by two to three by three, the stone bill two to six, and 150 hit
 * points to 200. Nothing else about the building moves — same ten wood,
 * same eighteen-second raising, same nine-second archer.
 *
 * 60 and not 57, which is the number this was cut as: main took 57 (the
 * fishery's own footprint, whose note reasons about a footprint in exactly
 * these terms), 58 (the load home) and now 59 (the armory's one of each,
 * below) while the branch was open. Fourth number for one change, and the
 * note below says the same of itself in the same words — by now the
 * pattern rather than the accident.
 *
 * The model is what started it. KayKit authors the range as the second
 * largest building in the pack — only the castle is bigger, and it
 * out-measures the barracks it was written as the small sibling of — and
 * the renderer sizes every model off min(w,h). At two the yard rendered a
 * third smaller than the hall beside it and read as a shed. The other two
 * numbers follow the ground: nine tiles bought for one token course of
 * masonry was the cheapest large footprint in the game, and 150 hit points
 * were written for a fence and a shed rather than for a building on the
 * barracks' plot at nearly the barracks' price.
 *
 * All three are sim, not costume, which is what earns the bump. Nine tiles
 * of flat ground instead of four is a placement an old log's `placeSite`
 * could have been given and this build refuses; the nine tiles block
 * movement, so haulers and soldiers walk around a wider obstacle and
 * arrive on different ticks; sight is measured from the footprint edge, so
 * a built range reveals a wider ring. The four extra stone are four more
 * hauls to the site before it rises, and a repair is billed as a share of
 * the build cost (REPAIR_COST_SHARE), so a burnt range mends dearer too.
 * The fifty hit points are swings: a raid that used to level a range
 * leaves it standing, and every tick of that fight lands somewhere else. A
 * replay recorded before this build re-runs into a different world within
 * seconds of the first range going down.
 *
 * (Riding it unbumped, because a rule inside a brain has never moved this
 * number: `sellForTheWoodcutter` in economyRules.ts, which is what the
 * standoff the footprint exposed turned out to need. Playback replays the
 * commands a seat issued, not the reasoning that issued them.)
 *
 * 59's note follows.
 */
/**
 * 59: the armory holds one of each arm.
 *
 * 59, cut as 56: main took 56 (the reachable ground rule), 57 (the
 * fishery's footprint) and 58 (the load home) while this branch was open.
 * Fourth number for one change, and the note below this one says the same
 * of itself in the same words — which is the pattern worth reading rather
 * than any one of the four.
 *
 * START_STOCK (defs/balance.ts) went from two spears and a sword to a
 * spear, a sword and a bow. A building's stores are read every tick a
 * hauler plans against them, and the opening army every seat can field
 * before its forges stand is one soldier smaller — so a log recorded
 * before this build musters men this one cannot, and every haul planned
 * around the missing spear walks somewhere else.
 *
 * The bow is the half that could not have been spent until now: the archer
 * waits on Archery and on a range, both of which arrived at 55. Under the
 * old tree it would have been a good nobody could reach without buying the
 * spear line first, which is why the same change measured badly before the
 * roof and measures +5 campaigns in 120 after it.
 *
 * Two playbooks moved with it and neither needed the number — playback
 * runs no brains (app/simWorker.ts): the Warlord buys ironworking second
 * now, because the rack no longer carries it to a raiding party and the
 * iron that replaces those spears has to arrive sooner; and the Fletcher's
 * notes stopped describing an armory with two spears in it.
 *
 * 58's note follows.
 */
/**
 * 58: the load home. A serf standing at a building now takes that
 * building's own open haul before the board deals anything that needs a
 * walk (systems/logistics.ts) — the man who carried bread into the mine
 * leaves with its silver instead of walking back to the castle empty and
 * being sent out again for it.
 *
 * 58, cut as 55: main took 55, 56 and 57 while this branch was in review.
 * Fourth number, same reason the three notes below give for their own
 * renumbering, and by now the pattern is the note worth reading.
 *
 * Which serf claims which job changes on the first delivery of a match,
 * and every haul after it is re-timed, so a log recorded before this build
 * diverges within seconds of the opening.
 *
 * 57's note follows.
 */
/**
 * 57: the fishery stands on 2x2.
 *
 * 57 and not 55, which is the number this was cut as: main took 55 (the
 * Archery Range) and 56 (the reachable-ground rule) while the branch was
 * open, and two builds cannot share a number — the same renumbering the
 * two notes below record about themselves.
 *
 * A footprint is sim, not decoration. `canPlace` measures the flat ground
 * under it and the water within a tile of it, `placeBuilding` blocks the
 * tiles it covers, and every serf walking past one paths around what it
 * blocked. A shoreline that had to give nine tiles of buildable bank gives
 * four now — on seed 1 that is 416 legal fishery sites where there were
 * 379 — so a log recorded before this re-runs into a valley whose shores
 * take fisheries the old one refused, and where one already stands it
 * stands on different ground with different tiles walkable around it.
 *
 * (The hut drawn on that footprint got smaller with it, and its jetty was
 * re-authored in tiles so the planks still reach the water. That half is
 * render only — assets.ts — and nothing in a tick can see it.)
 *
 * 56's note follows.
 */
/**
 * 56: a gatherer answers only for ground it can walk to.
 *
 * 56 and not 54, which is the number this was cut as: main took 54 (the
 * Monument's bread) and then 55 (the Archery Range) while the branch was
 * open, and two builds cannot share a number. Nothing about the change is
 * different for it — the same reasoning the 55 note below records about
 * itself.
 *
 * Every question this game asked about the ground under a hut was the same
 * question — is there anything of the kind inside the search square? — and
 * none of them was the question that matters, which is whether the worker
 * can get to it. A quarry in a real match found its last rock ringed by its
 * own grove and stood dead for eight minutes in front of it: the trip-start
 * pathed at that tile, failed, and idled forty ticks; the card read "in
 * reach: 10"; the seat's re-siting rule saw ground still standing and held
 * its hand; and the placement rule would have raised the next quarry on the
 * same spot. The barracks it fed waited on five stone that were never
 * coming.
 *
 * There is one answer now (map.ts `canWorkResourceNear`): a bounded flood
 * of the walkable ground around the hut, seeded from its own doorstep and
 * stepping exactly as the pathfinder steps. One thing a tick does with it
 * is sim behavior:
 *
 * - `canPlace` refuses a gatherer whose only resource is walled in, so a
 *   placeSite command that used to raise a hut can now be refused, and a
 *   valley full of AI seats lays its foundations somewhere else.
 *
 * The gather loop asks it too, but only as a guard on its own search: a hut
 * that can reach anything picks its trip in the ring order it always did
 * and paths to it exactly as before, so a working village is untouched. A
 * hut that can reach nothing idles without paying for the eight failed A*
 * searches it used to run every forty ticks forever — the same outcome, at
 * a bounded price. The one place that changes an outcome is the hut whose
 * only reachable ground lies past a detour longer than its whole search
 * radius, which the flood's bound gives up on and the old search would have
 * walked to.
 *
 * 55's note follows.
 *
 * 55: the bow gets its own roof — the Archery Range.
 *
 * 55 and not 54 because main took 54 while this branch was open (the
 * Monument's bread, halved; its note follows below). Two builds cannot
 * share a number — the whole point of it is that a file stamped 54 names
 * one world of behavior — so the later of the two to land moves up.
 * Nothing about the change below is different for it.
 *
 * The archer left the barracks' roster for a building of his own (2x2, 10
 * wood and 2 stone, unlocked by Archery rather than by a gate of its own)
 * and trains there in nine seconds instead of twelve. Three things move at
 * once because of it. A barracks that used to answer `trainUnit archer`
 * now refuses it, which is a command whose meaning changed. The AI's
 * `keepTheQueueWarm` reads every hall a seat owns instead of the first
 * building whose type is `barracks`, and warms each against that hall's own
 * roster — so the orders two of the five playbooks issue differ from the
 * first beat their range stands, and their build orders carry a roof that
 * did not exist. And the range itself is a building id no earlier build
 * ever wrote, which is format as much as behavior.
 *
 * The rule layer is brain-side and a replay stores commands rather than
 * re-deriving them, so on its own that half would not have bumped this
 * (see the "Still 49 after the Mason" entry in replayVersion.test.ts). The
 * roster change is not brain-side: a log recorded before this build carries
 * archer orders aimed at a barracks, and this build drops every one of
 * them — the army that log musters never exists here.
 *
 * The save format is untouched: a building id is already a number in a
 * save, and no file written before this can contain a 22, so
 * WORLD_SAVE_VERSION stays at 9 and old saves still open.
 *
 * 54's note follows.
 *
 * 54: the Monument's bread halved, twenty loaves to ten
 * (defs/buildings.ts). A building's cost is consumed as its site rises, so
 * every tick after the first delivery carries different stores — a balance
 * number in the plainest sense, and a replay recorded before that build
 * spends a larder it no longer has.
 *
 * The same commit lets the Monument be PLACED before its price is banked,
 * and that half needed no number: nothing in the sim ever asked a
 * placement to be paid for, so what moved there was two policies deciding
 * when to send a command — a lord's build order and a player's button —
 * and a logged command still executes as it did. The bread is why that is
 * 54.
 *
 * 53's note follows.
 *
 * 53: the kite costs the archer something.
 *
 * A ranged unit backing away from a closing melee man used to loose an
 * arrow and re-path in the same tick, every tick, for nothing. Since an
 * archer (2.0 tiles/sec) outruns a knight (1.6), the chaser only ever
 * gained ground while the archer stood still — and he never stood still,
 * so the chaser never landed a blow. Eight archers beat eight knights
 * without losing a man; sixteen knights lost to seven archers. Now a shot
 * plants the man who fires it for KITE_PLANT_TICKS (systems/combat.ts),
 * which is the leak that lets a chaser close, and the archer is down to 32
 * hit points from 35.
 *
 * Every engagement in the game re-times off this: soldiers die on different
 * ticks, in different places, and every serf whose haul was re-planned
 * around a fight walks somewhere else. A log recorded before this diverges
 * at the first arrow.
 *
 * 52's note follows.
 *
 * 52: a haul is offered to the nearest idle serf who can actually reach the
 * pickup, not simply the nearest. A man who cannot path there is passed over
 * and the next is tried; the job is only backed off when nobody tried can
 * walk it. Which serf claims which haul decides where every man in the
 * village is a tick later, so a log recorded before this re-runs into a
 * different valley almost at once.
 *
 * 51's note follows.
 *
 * 51: a site rises as it is paid for.
 *
 * Construction used to be all or nothing: `constructionSystem` refused a
 * single tick of progress until every good on the bill had landed, so a
 * building was a long silence followed by a sudden roof. Now a frame may be
 * raised as far as its bill has been settled — two thirds of the planks buys
 * two thirds of the frame — with the borrowed hammer a precondition rather
 * than a share of it, since it is a loan the site hands back rather than
 * something the building is made of.
 *
 * Completion still needs the whole bill and nothing is banked: a site that
 * falls is gone, part-raised or not. What moved is WHEN the work happens,
 * and that is enough. Every building in the game tops out on a different
 * tick now, hit points climb from the first delivery rather than from the
 * last, and the staffing system recruits a builder as soon as there is work
 * the deliveries have bought — a hand out of the haul pool at a different
 * moment, which re-times every haul behind it. A log recorded before this
 * re-runs into a different valley inside the first minute.
 *
 * 50's note is further down rather than here: the footprint shove claimed
 * that number while this was in review. Both were cut from 49, and this is
 * the one that landed second.
 */
/**
 * 47: a seam you can find.
 *
 * A home seam is drawn from a center with a clearing around it now
 * (map.ts seamFor, SEAM_CLEARING_SHARE), and no seam settles for a stub
 * while there is still a center in the band that can hold a whole one
 * (placeSeam's `minTiles`). Both answer a fairness bug the worth audit
 * could not see: a birthright that fitted three tiles between the trees
 * carried the same 180 silver at twice the metal per tile and read, from
 * the castle, as an empty wood — one seat prospecting for its own opening
 * while its rivals had mines up in the first seconds.
 *
 * The bump is the ground. Ore lies on different tiles on every generated
 * seed, and the extra draws a rejected center costs re-roll everything
 * drawn after it — so a replay recorded before this re-runs in a different
 * valley from its first order. Nothing about the format moved, and no tick
 * system did either; the world under them did, which is the half of this
 * version's promise that worldgen has always carried (see 36 and 43, the
 * reserve seams).
 */
/**
 * 46: the patrol.
 *
 * A move order carries a `patrol` flag (commands.ts), and a waypoint can
 * be a beat's leg (Waypoint.patrol): taken, it goes back to the end of
 * the route instead of being spent, so soldiers walk the click and the
 * spot they set out from round and round, fighting what they meet, until
 * a fresh order drops the route (tick.ts orderPatrol, takeLeg). Shift-P
 * adds a spot to the beat. A new field on the wire is pure format — no
 * older log holds one, and a log without one plays back exactly, since a
 * route without a beat leg is spent leg by leg as before. The bump is
 * for the other direction: a build without the order screens the flag
 * off a newer log and walks a single attack-move where the recording
 * patrolled.
 */
/**
 * 45: the Shift-click route.
 *
 * A move order carries a `queue` flag now (commands.ts), and a unit carries
 * the legs lined up behind the one it is walking (Unit.orders): Shift-click
 * queues a waypoint instead of replacing the order, and the tick's waypoint
 * step (tick.ts waypointSystem, after combat) hands each man his next leg
 * the moment the last one ends. A new field on the wire is pure format —
 * no older log holds one, and a log without one plays back exactly, since
 * the new step touches only units with a queue. On top of 44, which is
 * why this is 45: the two shipped in different PRs.
 */
/**
 * 44: soldiers can hold ground.
 *
 * An eighteenth command kind (`holdGround`, commands.ts) and the stance it
 * puts a soldier in (UnitTaskKind.hold, served by systems/combat.ts
 * holdGround): stand where you are and strike only what comes within
 * reach — no chase, no kite, no walk to the wall. Warcraft's Hold
 * Position, on H.
 *
 * The bump is for the same reason focusTarget's was (39): an older
 * build's sanitizeCommand screens a kind it has never heard of out of the
 * log, so a recording with a hold in it re-runs there with the squad
 * still marching — and every strike from the tick they were told to stop
 * lands from different ground. A log recorded before this plays back
 * unchanged: nothing an older log can say takes a different branch. It
 * sits on top of main's own 43 (the reserve iron seam), which is why this
 * is 44 and not 43: the two shipped in different PRs.
 */
/**
 * 43: a reserve iron seam in every valley.
 *
 * Worldgen deals every start a second iron seam out past its home ring,
 * the way it has dealt a second silver seam since 36 (IRON_RESERVE_WORTH,
 * map.ts). Drawn last of all and from a stream of its own, so a seed's
 * valley lies exactly as it did with the iron added to it and the match
 * on it rolls the same dice — but the tiles are there now, mines stand on
 * them and ore comes out of them, so a replay recorded before this build
 * re-runs into a different world from the first beat that goes looking
 * for iron. (The seats keeping
 * to their own side of the valley and off ground their foundations were
 * razed on is brain work, which playback never runs.)
 *
 * 42: a haul tier is a share of the hands, not a claim on all of them.
 *
 * The dispatcher used to hand every idle serf the lowest-numbered open job
 * on the board, so tier 3 — every producer's output going home — was
 * served only while tiers 1 and 2 were both empty. That was fine while
 * everything at 2 was a bounded pull that drained (an input cap of five,
 * one tool, one cask). 40 put silver at 2, and a mine never drains: one
 * load every four seconds, so on a seat with two or three free hands the
 * woodcutter's shelf sat full and reserved while every serf walked past it
 * for silver, and sites waited on planks that were ten tiles away.
 *
 * Now the hands are shared (defs/balance.ts HAUL_SHARE, 4:2:1): the next
 * idle serf goes to whichever tier is furthest below its share of the
 * serfs already carrying, oldest job first within the tier, and a tier
 * with no work gives its share away. Lower priority means served less
 * often, never not at all. The matcher's own strict rank — which demand
 * books scarce supply first — is untouched; only who carries changed.
 *
 * Every dispatch decision is the sim, so a log recorded on 41 re-runs with
 * different serfs on different errands from the first tick two tiers have
 * work at once.
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
 * 50: a building raised over somebody moves him out instead of sealing him
 * in. occupyFootprint now shoves anyone standing inside a new footprint to
 * the nearest walkable tile (sim/world.ts), and re-plans the walk of anyone
 * it interrupted under a plain move order rather than leaving him with a
 * task no system drives. The same command on the same tick therefore leaves
 * units standing somewhere else, and everything downstream of where a serf
 * is — who claims which haul first, which tile a path runs through — moves
 * with it. Unlike 49's run of "still 49" notes there is a build in the wild
 * holding the old rule, because 49 shipped with the Monument.
 *
 * 49's note follows.
 *
 * 49: the Monument, and the economy's own way to win. A new building type
 * (buildingTypeIdEnum, defs/buildings) with a placement rule no other
 * building has — it must stand within reach of a gold seam — and a victory
 * rule to match: finish it and the match ends in its owner's favour. The
 * contest is the raising, not anything after it, so a monument SITE stamps
 * its footprint into every rival's explored grid the moment it takes its
 * first delivery (visibility.ts) — which changes what the AI brain knows
 * and therefore what it does. A match can now end on a tick and for a
 * reason no earlier build had, so a log recorded before this re-runs into a
 * different outcome, not merely a different valley.
 *
 * The checklist latches before either win is declared, so a commission
 * that asks for a Monument ends with its last line ticked rather than
 * unticked — the monument win used to return out of victorySystem before
 * the objective pass ran.
 *
 * And the ground remembers a seam it no longer holds: a gold tile worked
 * dry becomes TileResource.GoldSpoil rather than None (depleteResourceTile),
 * spoil takes a footprint the way bare ground does (map.ts resourceOccupies),
 * and the monument's rule counts it. Without that, digging the gold — the
 * thing the mission asks for — deleted every legal monument site on the map,
 * permanently and with nothing on screen to say so. It is a byte in
 * map.resource that no earlier build ever wrote, which is format as well as
 * behavior; authored map files still may not carry one (TILE_RESOURCE_KINDS).
 *
 * 48's note follows.
 *
 * 48: the mines eat. Every gather recipe may now carry a ration (the iron,
 * silver and gold mines each spend one food per MINE_RATION_PER loads), the
 * mines raise a standing demand for it, and a mine with an empty pantry
 * stops producing until bread reaches it. Ore rates, haul boards and every
 * downstream clock move with it, so a log recorded before this build re-runs
 * into a different valley within the first minute. Two things ride along in
 * the same build because the ration is what made them true: the playbooks no
 * longer gate the mill and the bakery behind the barracks (bread has a
 * second customer now, so the gate's own reason is gone), and the opening
 * peace stretches 540s -> 610s to give the slower ramp back the share of
 * quiet the housing gate was given in its turn.
 *
 * 47's note follows.
 *
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
export const REPLAY_VERSION = 65;
