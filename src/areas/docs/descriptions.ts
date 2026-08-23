import type { BuildingTypeId } from '../../sim/defs/buildings';
import type { GoodId } from '../../sim/defs/goods';
import type { UnitTypeId } from '../../sim/defs/units';

/**
 * The one authored layer of the wiki: a sentence or two of flavor and
 * strategy per thing. Every number stays on the defs — these carry only
 * what a table cannot.
 *
 * Total Records on purpose: add a building, unit or good to the game and
 * this file refuses to compile until the wiki can say what it is. That is
 * the same completeness discipline BUILD_GROUPS keeps with its test, done
 * here by the type checker.
 */

export const BUILDING_DESC: Record<BuildingTypeId, string> = {
  storehouse:
    'The keep you start with: your store of every good, ten beds, and the building you lose the game by losing. It costs nothing to raise and real stone to mend.',
  banditCamp:
    'Where the raids muster. Worldgen places it, never a player — burn it down and the raids stop coming from it.',
  woodcutter:
    'The first roof in almost every opening. Its resident walks to nearby trees and carries the timber home, so site it against a forest, not a view.',
  quarry:
    'Works exposed rock into building stone. Like every gatherer it must be placed where its worker can already see something to cut.',
  house:
    'Ten beds of timber and a hearth. Housing is what the whole plan grows through: cheap on purpose, so the choice is when, not whether.',
  well: 'A shaft and a windlass, no keeper. Water is drawn by whoever comes for it, which makes the well free to run and slow to rush.',
  wheatFarm:
    'Turns water into standing wheat. The head of the bread chain and the brewery both drink from it, so one farm rarely stays enough.',
  mill: 'Grinds wheat to flour on the wind — no resident. Deliberately slower than the farm that feeds it: one mill is meant to serve two.',
  bakery:
    'Flour and water in, two loaves out. The far end of the bread chain and the best food rate in the game once the chain stands.',
  fishery:
    'One hut, one hand, and a pier that must touch water. Nothing goes in and food comes out slowly: the poor village’s food, ready long before the first loaf.',
  brewery:
    'Wheat and water into ale, for the Abbey’s festivals and the barracks’ cask. Wants Brewing researched before the roof goes up.',
  ironMine:
    'Cut into the hillside over an iron seam. Every weapon and most tools start here, which is why Ironworking gates it.',
  silverMine:
    'The treasury’s mine: silver pays for recruits and for every research. Ungated — a village can dig for coin from the start.',
  goldMine:
    'The deep seam, opened by Deep Mining. Gold buys nothing at market; it feeds the last and largest arms research.',
  weaponsmith:
    'The Smith: the village’s only source of tools, and of every weapon. The roof is ungated so no village can lock itself out of tools — what it may forge is gated recipe by recipe.',
  abbey:
    'Where research happens and where festival ale is drunk. No resident: the serf who raises it walks away a serf.',
  barracks:
    'Turns bread, a forged weapon and a walking serf into a soldier. The rally flag on its door is where fresh recruits march.',
  guardTower:
    'Stone that shoots back. Two archers on the wall hit harder and further than the same two on the grass — and until archers exist, the levy drops stones.',
  roadSite:
    'A single tile of paving, placed by the Masonry road pass rather than by hand. When it finishes, the trail beneath it is stone for good.',
};

export const UNIT_DESC: Record<UnitTypeId, string> = {
  serf: 'The village’s hands: hauls every good, raises every building, and becomes whatever the village needs next. No weapon, no fight.',
  worker:
    'A serf who took a post. Workers live at their building and work its trade; lose the building and the trade stops.',
  knight:
    'The heavy line. Slow to make — bread, a sword, the longest course at the barracks — and the unit that walks through spearmen.',
  spearman:
    'The fast, cheap soldier: first to any fight and the counter to archers. Melts against knights.',
  archer:
    'Range five and the pick of the tower garrison. Kites knights, dies to anything light that reaches it.',
  bandit: 'The raiders’ line infantry: light, quick, and fond of buildings that cannot fight back.',
  banditArcher: 'The raiders’ bow. Softer than yours, but a wave of them outranges a village with no answer.',
  marauder:
    'The raiders’ heavy: nearly a knight, and the sign a late wave means it. Bring spears and walls.',
};

export const GOOD_DESC: Record<GoodId, string> = {
  water: 'Drawn at the well by whoever needs it. Bread, ale and the farm all start here.',
  wheat: 'The crop. Grinds into flour, brews into ale, and pays for the early researches.',
  wood: 'Timber from the woodcutter: the first cost of nearly every roof and the whole of a bow.',
  stone: 'Quarried rock: walls, towers, millstones and roads.',
  iron: 'Ore from the iron mine. The Smith turns it into every serious weapon and tool.',
  silver: 'The coin: hires serfs and funds every research. The one good every plan runs short of.',
  gold: 'The deep metal. Exists to gild arms — the final warfare research is paid in it.',
  sword: 'The knight’s weapon, forged from two iron. No sword, no knight.',
  spear: 'The spearman’s arm: iron and wood, the cheapest way to put a soldier in the field.',
  bow: 'Three wood and no iron — the weapon a poor village can still field, once Archery is read.',
  ale: 'Brewed from wheat and water. The Abbey drinks it as festivals; the barracks as faster training.',
  flour: 'Milled wheat, halfway to bread.',
  food: 'What soldiers train on and the village fights for. Baked in twos, fished in ones.',
  axe: 'The woodcutter’s tool: no axe in store, no new woodcutter staffed.',
  pickaxe:
    'The miner’s tool — and deliberately forged without iron, so losing every pick can never lock the mines shut for good.',
  scythe: 'The farmer’s tool. One per farm, handed back if the post is ever dismissed.',
  hammer:
    'The builder’s tool, loaned rather than owned: every construction site borrows one and returns it at the topping-out. Hammers cap how many roofs rise at once.',
  cauldron: 'The tool of the bakery and the brewery both.',
  rod: 'The fisher’s rod: wood only, so the shore stays reachable for a village with no ore.',
};
