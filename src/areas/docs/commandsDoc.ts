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

export const COMMAND_DOCS: Record<SimCommand['kind'], CommandDoc> = {
  [CommandKind.moveUnits]: {
    summary:
      'Send selected units to a tile. A mixed squad forms up — knights front, archers rear — and marches at its slowest member’s pace; the first fight dissolves both the formation and the shared pace, and every unit runs at its own speed again. Plain by default; attack-move engages what it meets, and the mobile half-and-half walks the first half of the route peacefully before going live.',
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
  [CommandKind.sellBuilding]: {
    summary: 'Tear a building down for half its materials back.',
    payload: 'buildingId',
  },
  [CommandKind.setBuildingPaused]: {
    summary:
      'Halt or restart a building. Halting also empties the post — the resident (or a site’s builder) rejoins the serf pool, and a tower sends its levy back to work — so it is both “stop eating my wood” and “give me the hands back”.',
    payload: 'buildingId, paused',
  },
  [CommandKind.setBuildingRepair]: {
    summary:
      'Order (or cancel) a mend: materials are billed pro rata to the damage.',
    payload: 'buildingId, repair',
  },
  [CommandKind.setBuildingRecipe]: {
    summary:
      'Give the Smith a standing order from its forge menu — or index −1 for auto, forging whatever tool the village most lacks.',
    payload: 'buildingId, index',
  },
  [CommandKind.enqueueForge]: {
    summary: 'Queue one forge order at the Smith, ahead of the standing order.',
    payload: 'buildingId, recipeIndex',
  },
  [CommandKind.cancelForge]: {
    summary:
      'Cancel a queued forge order. Names both the slot and the recipe so a stale click misses rather than cancels a neighbour.',
    payload: 'buildingId, index, recipeIndex',
  },
  [CommandKind.research]: {
    summary: 'Start a research at the Abbey, paying its cost up front.',
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
      'Plant the barracks’ rally flag — fresh soldiers march there — or take it down by sending no coordinates.',
    payload: 'buildingId, x?, y?',
  },
  [CommandKind.admin]: {
    summary: 'Sandbox tweaks from the admin panel (single-player only).',
    payload: 'action',
  },
};

export const ADMIN_DOCS: Record<AdminAction, string> = {
  [AdminAction.toggleRaids]: 'Switch the raid clock off and on.',
  [AdminAction.clearBandits]: 'Remove every raider on the map.',
  [AdminAction.grantGoods]: 'Drop a bundle of goods into the store.',
  [AdminAction.toggleInstantBuild]:
    'Construction completes the moment materials land.',
  [AdminAction.finishResearch]: 'Complete the research in progress.',
  [AdminAction.spawnParade]: 'March one of every unit past the castle.',
};
