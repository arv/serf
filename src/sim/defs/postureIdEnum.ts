/**
 * The named stances a seat can hold, as a JS enum module.
 *
 * Born as the LLM strategist's answer vocabulary — the menu was quoted into
 * a prompt in words and the model answered with a word — which is why
 * POSTURE_KEYS (defs/aiPostures.ts) still carries a spelling per id: the
 * lab's `--engine posture:<word>` flag and the advice wire format both
 * speak it. Inside the seat a posture is a number like anything else, and
 * since the stance engine moved into the brain (systems/ai.ts) the ids are
 * sim data proper: a playbook names its stances by these.
 */
export const expand = 1 as const;
export type expand = typeof expand;
export const fortify = 2 as const;
export type fortify = typeof fortify;
export const raid = 3 as const;
export type raid = typeof raid;
export const muster = 4 as const;
export type muster = typeof muster;
export const siege = 5 as const;
export type siege = typeof siege;
export const pounce = 6 as const;
export type pounce = typeof pounce;
