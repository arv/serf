export const GOODS = [
  'water',
  'wheat',
  'wood',
  'stone',
  'iron',
  'silver',
  'gold',
  'sword',
  'spear',
  'bow',
  'ale',
  // The food chain, appended rather than slotted in beside wheat: this
  // array's order is the SAB carry code and the last tiebreak in the job
  // sort, so inserting in the middle would renumber every carried good in
  // flight and rewrite saves for nothing.
  'flour',
  'food',
  // The tools, appended for the same reason the food chain was: index is
  // identity here. Six of them gate nine of the ten resident-worker posts
  // (TOOL_OF in buildings.ts); the Smith that forges them is deliberately
  // the one post that needs none, since it is the only source.
  'axe',
  'pickaxe',
  'scythe',
  'hammer',
  'cauldron',
  'rod',
] as const;

export type GoodId = (typeof GOODS)[number];

export type GoodAmounts = Partial<Record<GoodId, number>>;
