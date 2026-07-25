export const GOODS = [
  'water',
  'rice',
  'bamboo',
  'stone',
  'iron',
  'silver',
  'gold',
  'katana',
  'yari',
  'yumi',
  'sake',
] as const;

export type GoodId = (typeof GOODS)[number];

export type GoodAmounts = Partial<Record<GoodId, number>>;
