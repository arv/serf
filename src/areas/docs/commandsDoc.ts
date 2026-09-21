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
      'Send selected units to a tile. Mixed squads form with knights in front and archers behind, then move at the slowest unit’s pace. A fight breaks the formation. Plain movement ignores enemies, while attack-move engages them. The attack flag also makes serfs fight until the order is replaced.',
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
      'Halt or restart a building. Halting releases its worker or builder, and sends a tower’s levy back to work.',
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
      'Order a study at the Abbey. The cost is billed to the Abbey, serfs carry it there, and the study starts when the last load lands.',
    payload: 'tech',
  },
  [CommandKind.cancelResearch]: {
    summary:
      'Call off the study in hand. Loads already carried to the Abbey are spent, and loads still on the road return to storage.',
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
      'Hold ground with H. The soldiers named stop where they stand and fight only what comes within weapon reach. They do not chase, and any other order releases them. Civilians are skipped.',
    payload: `unitIds (up to ${MAX_UNITS_PER_ORDER})`,
  },
  [CommandKind.stopUnits]: {
    summary:
      'Stop with S. Everyone named stops walking, including units on a march, attack-move or chase. Hauling, gathering and walking to a post continue. A stopped soldier still answers enemies nearby, while Hold prevents pursuit.',
    payload: `unitIds (up to ${MAX_UNITS_PER_ORDER})`,
  },
  [CommandKind.focusTarget]: {
    summary:
      'Focus the named squad on one enemy. The order lasts until the target dies or outruns the squad.',
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
