import type {Enum} from '../../shared/enum.ts';
import * as AdminAction from '../../sim/adminActionEnum.ts';
import * as CommandKind from '../../sim/commandKindEnum.ts';
import {MAX_UNITS_PER_ORDER, type SimCommand} from '../../sim/commands';

type AdminAction = Enum<typeof AdminAction>;

/**
 * The command reference. SimCommand is a type — erased at runtime — so the
 * prose is hand-authored here; the Records are keyed by the union so the
 * compiler keeps them complete. Add a fifteenth command to the sim and this
 * file refuses to build until the wiki explains it.
 */

export interface CommandDoc {
  summary: string;
  /** The payload, described field by field the way sanitizeCommand reads it. */
  payload: string;
}

/**
 * The member name behind a JS enum value, for the wiki to print next to the
 * number. The namespace import is the only place the names survive to
 * runtime; the sim itself never pays for them, and this module is docs
 * only, so the materialised namespace object costs nothing that matters.
 */
function enumNames(ns: Record<string, number>): ReadonlyMap<number, string> {
  return new Map(Object.entries(ns).map(([name, value]) => [value, name]));
}

export const COMMAND_KIND_NAMES = enumNames(CommandKind);
export const ADMIN_ACTION_NAMES = enumNames(AdminAction);

export const COMMAND_DOCS: Record<SimCommand['kind'], CommandDoc> = {
  [CommandKind.moveUnits]: {
    summary:
      'Send selected units to a tile. Mixed squads form with knights in front and archers behind, then move at the slowest unit’s pace. The first fight dissolves both the formation and the shared pace, and every unit runs at its own speed again. A plain move ignores enemies and an attack-move engages them. The third mode, ‘half’, is the mobile tap default: it walks the front half of the route as a plain move and goes live only for the back half, so one gesture can send an army out and let it flee without reengaging. The attack flag is also what arms the villagers. A serf under it acquires, closes and strikes at about a fifth of a raider’s output, and takes up room on the field for as long as the order stands, where a serf on any other order answers only the man already cutting him down and is walked through by everybody, his own army included.',
    payload: `unitIds (up to ${MAX_UNITS_PER_ORDER}), x, y, attack?: true | ‘half’`,
  },
  [CommandKind.placeBuilding]: {
    summary:
      'Stake out a construction site. The sim revalidates ground, cost and tech gate.',
    payload: 'building, x, y',
  },
  [CommandKind.hireSerf]: {
    summary:
      'Pay silver for a recruit from the next village over; he walks in after a delay.',
    payload: 'no fields',
  },
  [CommandKind.cancelHire]: {
    summary:
      'Call a paid-for recruit back off the road. The silver is refunded in full, and the next recruit starts a fresh walk.',
    payload: 'index',
  },
  [CommandKind.sellBuilding]: {
    summary:
      'Tear a building down. Half its materials and everything it held become a salvage pile.',
    payload: 'buildingId',
  },
  [CommandKind.setBuildingPaused]: {
    summary:
      'Halt or restart a building. Halting stops production and the deliveries that feed it, and it empties the post: the resident, or a site’s builder, rejoins the serf pool, and a tower empties its roof, sending trained archers back out as soldiers and a villager levy back to work. A paused site stops calling for its materials too, but an ordered repair and a study already paid for sit outside the pause gate and keep calling for theirs. It is both “stop eating my wood” and “give me the hands back”.',
    payload: 'buildingId, paused',
  },
  [CommandKind.setBuildingRepair]: {
    summary:
      'Order (or cancel) a mend: materials are billed pro rata to the damage.',
    payload: 'buildingId, repair',
  },
  [CommandKind.setBuildingRecipe]: {
    summary:
      'Give the Smith a standing order from its forge menu. Index −1 enables auto-forging for the tool the village most lacks.',
    payload: 'buildingId, index',
  },
  [CommandKind.enqueueForge]: {
    summary: 'Queue one forge order at the Smith, ahead of the standing order.',
    payload: 'buildingId, recipeIndex',
  },
  [CommandKind.cancelForge]: {
    summary:
      'Cancel a queued forge order. Names both the slot and the recipe, so a stale click misses and leaves the neighboring order alone.',
    payload: 'buildingId, index, recipeIndex',
  },
  [CommandKind.research]: {
    summary:
      'Order a study at the Abbey. Nothing is spent up front and the stores are not a gate: like a building site, the cost is billed to the Abbey, serfs carry it there as the village can, and the study starts when the last load lands.',
    payload: 'tech',
  },
  [CommandKind.cancelResearch]: {
    summary:
      'Call off the study in hand, which is the way out of a bill the village cannot carry, such as gold ordered with no mine to dig it. Names the tech, for cancelForge’s stale-click reason. Loads already carried to the Abbey are spent. A load still in a serf’s hands is offered to whatever else wants that good, and only walks to the castle if nothing does.',
    payload: 'tech',
  },
  [CommandKind.trainUnit]: {
    summary:
      'Queue a soldier at the barracks. Ingredients are spent when training starts, not when queued.',
    payload: 'buildingId, unit',
  },
  [CommandKind.cancelTraining]: {
    summary:
      'Cancel a queued recruit. Slot and unit both named, for the same stale-click reason as cancelForge.',
    payload: 'buildingId, index, unit',
  },
  [CommandKind.setRallyPoint]: {
    summary:
      'Plant the barracks’ rally flag so fresh soldiers march there. Send no coordinates to take it down.',
    payload: 'buildingId, x?, y?',
  },
  [CommandKind.admin]: {
    summary: 'Sandbox tweaks from the admin panel (single-player only).',
    payload: 'action',
  },
  [CommandKind.herald]: {
    summary:
      'A taunt with an address: announce a coming march (or vengeance) to one rival. The AI seats send these before a full assault; the note is a number the screen turns into words, never free text.',
    payload: 'target, note (marchComing · retribution · finalAssault), count?',
  },
  [CommandKind.holdGround]: {
    summary:
      'Hold ground, on H. Warcraft’s Hold Position: the soldiers named stop where they stand and fight only what comes within weapon reach. No chasing, no kiting, no walking to a wall, and a target that steps out of reach is let go rather than followed. A movement or attack order releases them. Stop does not, so S cannot quietly undo H. Civilians in the list are skipped.',
    payload: `unitIds (up to ${MAX_UNITS_PER_ORDER})`,
  },
  [CommandKind.stopUnits]: {
    summary:
      'Stop, on S. Everyone named drops the order he is walking and the route queued behind it, and stands where his feet are: a march, an attack-move, an assault on a building, and the chase or siege a soldier walks for a target. Serfs included, because a walk is a walk. An errand is the exception, since it cannot be halted mid-step without stranding what it carries, so hauling, a worker’s gather loop and a walk to a post to take it up all survive a stop, as does a hold. It is not the hold’s quieter cousin. A stopped soldier is an idle soldier, so he still answers an enemy that walks into his acquire radius. Stop calls a charge off, and hold draws a line.',
    payload: `unitIds (up to ${MAX_UNITS_PER_ORDER})`,
  },
  [CommandKind.focusTarget]: {
    summary:
      'Put a squad on one enemy, which is focus fire and the only way a caller names a target at all. Every other order leaves targeting to the sim, which sends each soldier at the nearest enemy it counters. This overrides that for the units named, until the target dies or outruns them. It is worth having because damage here is flat: a soldier at a sliver of health hits exactly as hard as a fresh one, so killing one outright removes its whole output where spreading the same damage over three removes none. A standing enemy building is a legal target too, and means the same thing: hit that one rather than the wall the squad happens to be standing next to.',
    payload:
      'unitIds, targetId (a living enemy unit, or a standing enemy building with building: true)',
  },
};

export const ADMIN_DOCS: Record<AdminAction, string> = {
  [AdminAction.toggleRaids]: 'Switch the raid clock off and on.',
  [AdminAction.clearBandits]: 'Remove every raider on the map.',
  [AdminAction.grantGoods]: 'Drop a bundle of goods into the store.',
  [AdminAction.toggleInstantBuild]:
    'Construction completes the moment materials land.',
  [AdminAction.finishResearch]:
    'Complete the research in progress. Goods still on the road to the Abbey are settled.',
  [AdminAction.spawnParade]: 'March one of every unit past the castle.',
};
