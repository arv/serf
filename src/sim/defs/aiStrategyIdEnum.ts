/**
 * The AI playbooks, as a JS enum module. The id rides in WorldConfig — so
 * in saves, in lobby state and in the ?bots URL parameter — and
 * AI_STRATEGY_KEYS carries its spelling for those.
 */
export const steward = 1 as const;
export type steward = typeof steward;
export const warlord = 2 as const;
export type warlord = typeof warlord;
export const abbot = 3 as const;
export type abbot = typeof abbot;
export const fletcher = 4 as const;
export type fletcher = typeof fletcher;
export const mason = 5 as const;
export type mason = typeof mason;
