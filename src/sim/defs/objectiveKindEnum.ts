/**
 * The win requirements a mission can ask for, as a JS enum module — the
 * discriminant of ObjectiveSpec. Every one is a stateless predicate over
 * the world.
 */
export const building = 1 as const;
export type building = typeof building;
export const stock = 2 as const;
export type stock = typeof stock;
export const research = 3 as const;
export type research = typeof research;
export const population = 4 as const;
export type population = typeof population;
export const soldiers = 5 as const;
export type soldiers = typeof soldiers;
export const razeCamp = 6 as const;
export type razeCamp = typeof razeCamp;
