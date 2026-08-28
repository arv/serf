/**
 * Who is speaking in one prompt message, as a JS enum module (see
 * shared/enum.ts).
 *
 * CHAT_ROLE_KEYS carries the spelling, and it is not decoration: the engine
 * is handed these messages and llama.cpp renders them through the model's
 * own chat template, which is keyed on the words 'system' and 'user'. The
 * conversion happens once, where the messages cross into wllama.
 */
export const system = 1 as const;
export type system = typeof system;
export const user = 2 as const;
export type user = typeof user;
