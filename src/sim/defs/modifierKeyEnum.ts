/**
 * The multipliers research can move, as a JS enum module (see
 * shared/enum.ts). Read every production tick through getModifier, which is
 * why they are numbers.
 */
/** wheat farm batch speed */
export const farmSpeed = 1 as const;
export type farmSpeed = typeof farmSpeed;
/** mill + bakery batch speed */
export const foodSpeed = 2 as const;
export type foodSpeed = typeof foodSpeed;
/** Smith batch speed */
export const forgeSpeed = 3 as const;
export type forgeSpeed = typeof forgeSpeed;
/** mine gather speed */
export const mineSpeed = 4 as const;
export type mineSpeed = typeof mineSpeed;
/** serf + worker walk speed */
export const serfSpeed = 5 as const;
export type serfSpeed = typeof serfSpeed;
/** all production speed (festival buff) */
export const workSpeed = 6 as const;
export type workSpeed = typeof workSpeed;
/** military max hp at training time */
export const militaryHp = 7 as const;
export type militaryHp = typeof militaryHp;
