/**
 * What a herald says, as a JS enum module. Structured on purpose: the note
 * rides the command log and the wire, so it is a number the client turns
 * into words — never free text, which would be a chat system wearing a
 * taunt's clothes. The client owns the phrasing (and can localize it); the
 * sim owns only which of the three things is being announced.
 */
export const marchComing = 1 as const;
export type marchComing = typeof marchComing;
export const retribution = 2 as const;
export type retribution = typeof retribution;
export const finalAssault = 3 as const;
export type finalAssault = typeof finalAssault;
