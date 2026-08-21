import type { MissionId } from '../sim/defs/missions';

/**
 * Tutorial hint scripts, one per teaching mission. UI-side on purpose: a
 * hint speaks presentation language ("the build card", "the reach ring")
 * and the sim must not know those exist.
 *
 * A step either watches an objective latch (`objective` = its index in the
 * mission def) or is a piece of lore the player acknowledges by hand. Both
 * are stateless against the world: a loaded save fast-forwards past every
 * latched step with nothing persisted, and only the "Got it" acks live (in
 * memory) on the main thread.
 */
export interface HintStep {
  text: string;
  /** Advance when this objective (index into the mission's list) latches;
   * absent = a lore step, advanced by its Got-it button. */
  objective?: number;
}

export const MISSION_HINTS: Partial<Record<MissionId, HintStep[]>> = {
  clearing: [
    {
      text:
        'Push the cursor to a screen edge — or drag with a finger — to pan, ' +
        'and scroll or pinch to zoom. The big roof is your ' +
        'castle: your stores, your beds, and the one building you cannot lose.',
    },
    {
      text:
        'Pick the Woodcutter from the build card and set it where its reach ' +
        'ring covers trees — a hut out of range of every trunk is refused.',
      objective: 0,
    },
    {
      text: 'The Quarry answers the same rule: rock in reach, or no deal.',
      objective: 1,
    },
    {
      text:
        'There are no roads to draw here. Watch your serfs — the paths they ' +
        'walk wear into trails on their own, and the trails walk faster.',
    },
    {
      text:
        'Everyone needs a bed. The castle sleeps ten; a house sleeps ten ' +
        'more. Raise one before you hire past the castle.',
      objective: 2,
    },
    {
      text:
        'Select the castle and hire until eleven live here — four silver a ' +
        'head, and each recruit takes a moment to walk in.',
      objective: 3,
    },
    {
      text: 'Now let the axe work: thirty wood in the castle fulfills the commission.',
      objective: 4,
    },
  ],

  breadAndWater: [
    {
      text:
        'Bread is a chain: well → wheat farm → mill → bakery. Water twice — ' +
        'the bakery drinks too. Select any workshop to watch its buffers.',
    },
    { text: 'Raise a Well. Drawing water is a chore serfs run, not a post anyone holds.', objective: 0 },
    { text: 'A Wheat Farm next — flat grass near the castle serves fine.', objective: 1 },
    {
      text: 'Now the Mill. One mill serves two farms: it grinds faster than they grow.',
      objective: 2,
    },
    { text: 'The Bakery closes the chain: flour and water in, bread out.', objective: 3 },
    {
      text:
        'Waiting on an oven is what fast forward is for — the speed buttons ' +
        'sit top right. (In a hurry and poor? A fishery feeds from any shore ' +
        'with one hut and one hand. Fish while you are poor, bake once you are not.)',
      objective: 4,
    },
  ],

  ledger: [
    {
      text:
        'Learning happens at the Abbey and is paid in goods — one study at a ' +
        'time. Raise it first.',
      objective: 0,
    },
    {
      text:
        'Mines stand on grass against the mountainside, their seam in reach. ' +
        'Dig silver first: research, hiring and weapons all drain the same purse.',
      objective: 1,
    },
    {
      text:
        'Open the tech tree and study Ironworking — a root of the Craft ' +
        'branch, and the door to every iron recipe at the Smith.',
      objective: 2,
    },
    { text: 'Iron next: another mine, another seam.', objective: 3 },
    {
      text:
        'The Smith turns wood and iron into arms and tools alike. Left to ' +
        'itself it forges whatever tool the village lacks — click a recipe ' +
        'to queue an order ahead of that. Spears are one iron, swords two.',
      objective: 4,
    },
    { text: 'Let the forge run: four spears in the castle settles the ledger.', objective: 5 },
  ],

  levy: [
    {
      text:
        'The barracks turns bread, a weapon and a villager into a soldier. ' +
        'Raise it now — the pass is not quiet, and the raid warning will ' +
        'name what is coming.',
      objective: 0,
    },
    {
      text:
        'Knights break spearmen, spearmen skewer archers, archers feather ' +
        'knights. Train against what the warning names, and keep six standing.',
      objective: 1,
    },
    {
      text:
        'March everyone at once — the camp guards do not chase far. ' +
        'Right-click the camp itself and your soldiers will raze it.',
      objective: 2,
    },
  ],
};
