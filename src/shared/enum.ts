/**
 * The value union of a "JS enum module".
 *
 * `erasableSyntaxOnly` rules out TypeScript's own `enum`, and a union of
 * string literals — readable as it is — pays for that readability at every
 * comparison, every object key and every byte that crosses a wire. A module
 * of numeric constants is the erasable stand-in: SMI values the engine
 * compares in one instruction, with a namespace import giving back the
 * `E.Member` spelling an enum had.
 *
 * The way to transition old TS enums to non TS enums is to do:
 *
 * ```
 * const enum E = {
 *   A = 1,
 *   B = 2,
 *   D = 4,
 * }
 * ```
 *
 * ```
 * // eEnum.ts
 * export const A = 1 as const;
 * export const B = 2 as const;
 * export const D = 4 as const;
 *
 * export type A = typeof A;
 * export type B = typeof B;
 * export type D = typeof D;
 * ```
 *
 * The `as const` is load-bearing, and the one part of this that is easy to
 * get wrong. A plain `export const A = 1` is typed `1` but as a *widening*
 * literal, and anything that infers through it hands back `number`: an
 * array literal of members, a destructuring swap, and — the one that
 * actually bit — Solid's `<Show>`, whose `Accessor<NonNullable<T>>` gave
 * every callback a plain number. The member reads the same either way at
 * the definition and only the far end of an inference tells you, so pin it
 * here.
 *
 * Then in the importer do:
 *
 * ```
 * import * as E from './eEnum.ts';
 * import type { Enum } from '../shared/enum.ts';
 *
 * type E = Enum<typeof E>;
 * ```
 *
 * Then you can use E and E.A as both a type and a value.
 *
 * An enum module holds nothing but its members: `Enum` reads every export,
 * so a helper or a name table living alongside them would widen the union
 * into nonsense. Tables that key off an enum belong with the code that
 * needs them, as arrays indexed by the member.
 */
export type Enum<T> = T[keyof T];
