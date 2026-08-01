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
] as const;

export type GoodId = (typeof GOODS)[number];

export type GoodAmounts = Partial<Record<GoodId, number>>;
