/**
 * Every animation a character can be playing, as a JS enum module (see
 * shared/enum.ts). Read for every visible person every frame, which is why
 * it is a number; the clip names the packs ship live in KK_CLIP_NAMES.
 */
export const idle = 1 as const;
export type idle = typeof idle;
export const walk = 2 as const;
export type walk = typeof walk;
export const jog = 3 as const;
export type jog = typeof jog;
export const attack = 4 as const;
export type attack = typeof attack;
export const shoot = 5 as const;
export type shoot = typeof shoot;
/** Named `throwing` rather than `throw`: a member is a `const` binding, and
 * `throw` is a keyword. The clip it names is unchanged. */
export const throwing = 6 as const;
export type throwing = typeof throwing;
export const work = 7 as const;
export type work = typeof work;
export const pickaxe = 8 as const;
export type pickaxe = typeof pickaxe;
export const hammer = 9 as const;
export type hammer = typeof hammer;
export const dig = 10 as const;
export type dig = typeof dig;
export const tend = 11 as const;
export type tend = typeof tend;
export const draw = 12 as const;
export type draw = typeof draw;
export const fish = 13 as const;
export type fish = typeof fish;
export const carry = 14 as const;
export type carry = typeof carry;
export const carryIdle = 15 as const;
export type carryIdle = typeof carryIdle;
export const death = 16 as const;
export type death = typeof death;
export const mow = 17 as const;
export type mow = typeof mow;
