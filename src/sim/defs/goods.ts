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
] as const;

export type GoodId = (typeof GOODS)[number];

export type GoodAmounts = Partial<Record<GoodId, number>>;
