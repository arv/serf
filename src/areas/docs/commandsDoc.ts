import type { AdminAction, SimCommand } from '../../sim/commands';

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
  moveUnits: {
    summary:
      'Send selected units to a tile. Plain by default; attack-move engages what it meets, and the mobile half-and-half walks the first half of the route peacefully before going live.',
    payload: 'unitIds (up to 1024), x, y, attack?: true | ‘half’',
  },
  placeBuilding: {
    summary: 'Stake out a construction site. The sim revalidates ground, cost and tech gate.',
    payload: 'building, x, y',
  },
  hireSerf: {
    summary: 'Pay silver for a recruit from the next village over; he walks in after a delay.',
    payload: 'no fields',
  },
  sellBuilding: {
    summary: 'Tear a building down for half its materials back.',
    payload: 'buildingId',
  },
  setBuildingPaused: {
    summary: 'Stop or resume a building’s production without dismissing its worker.',
    payload: 'buildingId, paused',
  },
  setBuildingRepair: {
    summary: 'Order (or cancel) a mend: materials are billed pro rata to the damage.',
    payload: 'buildingId, repair',
  },
  setBuildingRecipe: {
    summary:
      'Give the Smith a standing order from its forge menu — or index −1 for auto, forging whatever tool the village most lacks.',
    payload: 'buildingId, index',
  },
  enqueueForge: {
    summary: 'Queue one forge order at the Smith, ahead of the standing order.',
    payload: 'buildingId, recipeIndex',
  },
  cancelForge: {
    summary: 'Cancel a queued forge order. Names both the slot and the recipe so a stale click misses rather than cancels a neighbour.',
    payload: 'buildingId, index, recipeIndex',
  },
  research: {
    summary: 'Start a research at the Abbey, paying its cost up front.',
    payload: 'tech',
  },
  trainUnit: {
    summary: 'Queue a soldier at the barracks. Ingredients are spent when training starts, not when queued.',
    payload: 'buildingId, unit',
  },
  cancelTraining: {
    summary: 'Cancel a queued recruit. Slot and unit both named, for the same stale-click reason as cancelForge.',
    payload: 'buildingId, index, unit',
  },
  setRallyPoint: {
    summary: 'Plant the barracks’ rally flag — fresh soldiers march there — or take it down by sending no coordinates.',
    payload: 'buildingId, x?, y?',
  },
  admin: {
    summary: 'Sandbox tweaks from the admin panel (single-player only).',
    payload: 'action',
  },
};

export const ADMIN_DOCS: Record<AdminAction, string> = {
  toggleRaids: 'Switch the raid clock off and on.',
  clearBandits: 'Remove every raider on the map.',
  grantGoods: 'Drop a bundle of goods into the store.',
  toggleInstantBuild: 'Construction completes the moment materials land.',
  finishResearch: 'Complete the research in progress.',
  spawnParade: 'March one of every unit past the castle.',
};
