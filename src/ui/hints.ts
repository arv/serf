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
        'Arrow keys pan, and so does a finger. Scroll or pinch to zoom, and ' +
        'in full screen the screen edges pan too. The big roof is your ' +
        'castle, which holds your stores and your beds and must not fall.',
    },
    {
      text:
        'Pick the Woodcutter from the build card and set it where its reach ' +
        'ring covers trees. A hut out of range of every trunk is refused.',
      objective: 0,
    },
    {
      text: 'The Quarry answers the same rule. Rock in reach, or no deal.',
      objective: 1,
    },
    {
      text:
        'There are no roads to draw here. Watch your serfs, because the ' +
        'paths they walk wear into trails, and the trails walk faster.',
    },
    {
      text:
        'Everyone needs a bed. The castle sleeps ten and a house sleeps ten ' +
        'more, so raise one before you hire past the castle.',
      objective: 2,
    },
    {
      text:
        'Select the castle and hire until eleven live here. Each recruit ' +
        'costs four silver and takes a moment to walk in. If the purse runs ' +
        'dry first, there is silver in the hills north-east, and a mine out ' +
        'there pays for the rest of them.',
      objective: 3,
    },
    {
      text: 'Now let the axe work. Thirty wood in the castle fulfills the commission.',
      objective: 4,
    },
  ],

  [MissionId.breadAndWater]: [
    {
      text:
        'Bread is a chain: well → wheat farm → mill → bakery. Water goes in ' +
        'twice, since the bakery drinks too. Select any workshop to watch ' +
        'its buffers.',
    },
    {
      text: 'Raise a Well. Nobody staffs it, and whoever needs water draws it.',
      objective: 0,
    },
    {
      text: 'A Wheat Farm next. Flat grass near the castle serves fine.',
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
        'Waiting on an oven is what fast forward is for, and the speed ' +
        'buttons sit top right. A fishery is the cheaper larder if you need ' +
        'one: any shore, one hut, one hand, and nothing going in.',
      objective: 4,
    },
  ],

  [MissionId.ledger]: [
    {
      text:
        'Learning happens at the Abbey, paid in goods your serfs carry there. ' +
        'The study starts when the last load arrives, and only one runs at a ' +
        'time. Raise it near the castle.',
      objective: 0,
    },
    {
      text:
        'Mines stand on grass against the mountainside, their seam in reach. ' +
        'Dig silver first, because research and hiring drain the same purse.',
      objective: 1,
    },
    {
      text:
        'Open the tech tree and study Ironworking. It is a root of the Craft ' +
        'branch, and it opens every iron recipe at the Smith.',
      objective: 2,
    },
    {text: 'Iron next. Another mine, another seam.', objective: 3},
    {
      text:
        'The Smith turns wood and iron into arms and tools alike. Left to ' +
        'itself it forges whatever tool the village lacks, so click a recipe ' +
        'to queue an order ahead of that. Spears are one iron, swords two.',
      objective: 4,
    },
    {
      text: 'Let the forge run. Four spears in the castle settles the ledger.',
      objective: 5,
    },
  ],

  [MissionId.hammerAndHaft]: [
    {
      text:
        'Every hut here is empty because its tool is gone. No axe, no post. ' +
        'The Smith is where tools come from, and the one post that needs ' +
        'none. Raise it with the hammer you brought.',
      objective: 0,
    },
    {
      text:
        'A pickaxe costs wood and stone and no iron at all. Forge that ' +
        'first, put it in the mine, and the hill pays for every tool after it.',
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
        'Two tools stand between you and bread: a scythe for the field and a ' +
        'cauldron for the oven. The well and the mill keep nobody, so they ' +
        'never wanted one.',
      objective: 3,
    },
    {
      text:
        'A hammer is lent, not spent. Every site borrows one and gives it ' +
        'back when the roof goes on, which is why yours could raise only ' +
        'one thing at a time and why it is on the shelf again now. With no ' +
        'site standing, no post wants a hammer and the Smith will never ' +
        'think of it. Select it and queue the other two yourself.',
      objective: 4,
    },
  ],

  [MissionId.levy]: [
    {
      text:
        'The barracks turns bread, a weapon and a villager into a soldier. ' +
        'Raise it now. The pass is not quiet, and the raid warning will ' +
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
        'March everyone at once, since the camp guards do not chase far. ' +
        'Right-click the camp itself and your soldiers will raze it.',
      objective: 2,
    },
  ],

  [MissionId.gildedValley]: [
    {
      text:
        'This one does not end at a camp. Gold buys nothing you can eat or ' +
        'fight with, only the Monument, and a finished Monument wins ' +
        'outright. The seam is at the far end of the valley, and everything ' +
        'else you need is close to home.',
    },
    {
      text:
        'Deep Mining opens the Gold Mine. Select the abbey and study it. ' +
        'Iron and silver are the price, and both are in the near hills.',
      objective: 0,
    },
    {
      text:
        'Cut the mine on the knap. Mines eat, so keep bread walking out ' +
        'there or the pick stops, and bring a spare pickaxe. An unstaffed ' +
        'mine looks exactly like a working one.',
      objective: 1,
    },
    {
      text:
        'Now the Monument, on the levelled shelf beside the seam. The ' +
        'bandits learn of it the moment the first cartload lands, and a ' +
        'frame stands at a fifth of its finished hit points. The raising is ' +
        'what you have to defend.',
      objective: 2,
    },
  ],
};
