import type {Enum} from '../shared/enum.ts';
import * as MissionId from '../sim/defs/missionIdEnum.ts';

type MissionId = Enum<typeof MissionId>;

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
  [MissionId.clearing]: [
    {
      text:
        'Arrow keys or a finger pan. Scroll or pinch to zoom. The big roof ' +
        'is your castle: your stores, your beds, and the building you ' +
        'cannot lose.',
    },
    {
      text:
        'Place a Woodcutter from the build card with trees inside its ' +
        'reach ring. Out of range of every trunk, it is refused.',
      objective: 0,
    },
    {
      text: 'Same rule for the Quarry. Rock inside the ring, or no deal.',
      objective: 1,
    },
    {
      text:
        'There are no roads to draw. The paths your serfs walk wear into ' +
        'trails on their own, and trails are faster.',
    },
    {
      text:
        'Everyone needs a bed. The castle sleeps ten, a house ten more. ' +
        'Raise one before you hire past ten.',
      objective: 2,
    },
    {
      text:
        'Select the castle and hire until eleven live here. Four silver a ' +
        'head, and each recruit walks in. If the purse runs dry, there is ' +
        'silver in the hills north-east.',
      objective: 3,
    },
    {
      text: 'Thirty wood in the castle fulfills the commission.',
      objective: 4,
    },
  ],

  [MissionId.breadAndWater]: [
    {
      text:
        'Bread is a chain: well → wheat farm → mill → bakery. Water goes ' +
        'in twice, at the farm and the bakery. Select any workshop to see ' +
        'its buffers.',
    },
    {
      text: 'Raise a Well. Nobody staffs it; whoever needs water draws it.',
      objective: 0,
    },
    {
      text: 'A Wheat Farm next, on flat grass near the castle.',
      objective: 1,
    },
    {
      text: 'Now the Mill. It grinds faster than a farm grows, so one serves two.',
      objective: 2,
    },
    {
      text: 'The Bakery closes the chain. Flour and water in, bread out.',
      objective: 3,
    },
    {
      text:
        'The speed buttons sit top right. A fishery is the cheaper larder ' +
        'if you need one: any shore, one hut, one hand, nothing going in.',
      objective: 4,
    },
  ],

  [MissionId.ledger]: [
    {
      text:
        'Research happens at the Abbey, paid in goods your serfs carry ' +
        'there. The study starts when the last load arrives. One at a ' +
        'time. Raise it near the castle.',
      objective: 0,
    },
    {
      text:
        'Mines stand on grass against the mountainside, seam in reach. ' +
        'Dig silver first: research and hiring share one purse.',
      objective: 1,
    },
    {
      text:
        'Open the tech tree and study Ironworking. It opens every iron ' +
        'recipe at the Smith.',
      objective: 2,
    },
    {text: 'Iron next. Another mine, another seam.', objective: 3},
    {
      text:
        'The Smith forges arms and tools from wood and iron. Left alone it ' +
        'makes whatever tool the village lacks; click a recipe to queue an ' +
        'order ahead of that. Spears are one iron, swords two.',
      objective: 4,
    },
    {
      text: 'Four spears in the castle settles the ledger.',
      objective: 5,
    },
  ],

  [MissionId.hammerAndHaft]: [
    {
      text:
        'Every hut here is empty because its tool is gone. No axe, no ' +
        'post. The Smith makes tools and needs none itself. Raise it with ' +
        'the hammer you brought.',
      objective: 0,
    },
    {
      text:
        'A pickaxe costs wood and stone, no iron. Forge that first and put ' +
        'it in the mine.',
      objective: 1,
    },
    {
      text:
        'An axe puts the woodcutter back among the trees. Left to itself the ' +
        'Smith forges whatever post stands open, in the order the village ' +
        'most feels it.',
      objective: 2,
    },
    {
      text:
        'Two tools stand between you and bread: a scythe for the field, a ' +
        'cauldron for the oven. The well and the mill staff nobody.',
      objective: 3,
    },
    {
      text:
        'A hammer is lent, not spent: every site borrows one and returns ' +
        'it when the roof goes on, so one hammer means one site at a time. ' +
        'With no site standing, the Smith will not forge more on its own. ' +
        'Select it and queue the other two yourself.',
      objective: 4,
    },
  ],

  [MissionId.levy]: [
    {
      text:
        'The barracks turns bread, a weapon and a villager into a soldier. ' +
        'Raise it now. The raid warning will name what is coming.',
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
        'March everyone at once; the camp guards do not chase far. ' +
        'Right-click the camp and your soldiers will raze it.',
      objective: 2,
    },
  ],

  [MissionId.gildedValley]: [
    {
      text:
        'This one does not end at a camp. Gold pays for the Monument and ' +
        'for Gilded Arms, and a finished Monument wins outright. The seam ' +
        'is at the far end of the valley.',
    },
    {
      text:
        'Deep Mining opens the Gold Mine. Study it at the abbey. Iron and ' +
        'silver are the price, both in the near hills.',
      objective: 0,
    },
    {
      text:
        'Cut the mine on the knap. Keep bread walking out there or the ' +
        'pick stops, and bring a spare pickaxe. An unstaffed mine looks ' +
        'exactly like a working one.',
      objective: 1,
    },
    {
      text:
        'Now the Monument, on the levelled shelf beside the seam. The ' +
        'bandits learn of it the moment the first cartload lands, and a ' +
        'frame stands at a fifth of its finished hit points.',
      objective: 2,
    },
  ],
};
