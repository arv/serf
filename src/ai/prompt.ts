import { POSTURES, POSTURE_ORDER, POSTURE_KEYS } from './posture.ts';
import type { StrategyAdvice } from './advice.ts';
import type { AiWorldSummary } from './summary.ts';
import type { Enum } from '../shared/enum.ts';
import * as ChatRoleNs from './chatRoleEnum.ts';

export type ChatRole = Enum<typeof ChatRoleNs>;

/**
 * The spelling each role is rendered as. llama.cpp applies the model's own
 * chat template to these words, so they are the engine's vocabulary rather
 * than ours — the one place they are needed is the hand-off in
 * strategist.ts.
 */
export const CHAT_ROLE_KEYS: Readonly<Record<ChatRole, 'system' | 'user'>> = {
  [ChatRoleNs.system]: 'system',
  [ChatRoleNs.user]: 'user',
};

/**
 * Summary → chat messages. Kept apart from the strategist so the whole
 * prompt is a pure function anyone can snapshot-test — and so tuning the
 * wording never touches the machinery around it.
 *
 * Written for a ~1B instruct model, which shapes everything: the system
 * message is a glossary rather than an essay, the user message is data
 * with a little arithmetic already done (deltas since last time), and the
 * asked-for reply is one word. Budget is ~900 input tokens; the summary is
 * capped near 1.5 KB, so the total holds.
 *
 * The reply used to be a JSON object of knob values, and the bake-off
 * showed what models this size do with that: qwen2.5-0.5b landed below the
 * random noise floor, and lfm2.5-350m answered 862 consultations with two
 * distinct strings. Both failures are the same failure — authoring numbers
 * is generation, and these models cannot generate. So the menu below asks
 * them to *recognise a situation* instead, and posture.ts owns the numbers.
 * Every line of the menu is phrased as the condition to pick it under, for
 * the same reason.
 */

/** OpenAI-style chat shape, structurally what WebLLM accepts — declared
 * here so nothing on this path imports the engine package. */
export interface ChatMessage {
  role: ChatRole;
  content: string;
}

const SYSTEM = `You are the strategist for one AI lord in a medieval RTS. Serfs haul goods, buildings produce them, soldiers fight. Most production posts also need a tool from the Smith (axe, pickaxe, scythe, cauldron, fishing rod) before a worker will take them, and construction borrows hammers — a stock of zero tools with open posts means the economy is stalling, not resting. Razing a rival's castle eliminates them; razing bandit camps stops raids. You choose the seat's posture; a competent captain handles all execution.

Fog of war: you know only what your seat has scouted ("explored" is your map coverage, 0-1). A rival with found=false has not been located yet — your captain scouts automatically, and the army cannot march on a castle nobody has found. A rival's "intel" is your scout's last look at their army composition (heavy/light/ranged) with its age; old intel may be wrong, null intel means never sighted. Your captain already re-scouts stale rivals and counter-forges against sighted compositions on his own — steer posture, not unit micro.

Your one job is posture: how the seat spends the next minute and a half.

Choose exactly one posture:
${POSTURE_ORDER.map((id) => `- ${POSTURE_KEYS[id]}: ${POSTURES[id].when}`).join('\n')}

Reply with a single JSON object: {"posture": "<one of the postures above>", "reason": "<a few words citing a specific fact from the match state>"}. Nothing else.`;

/** The differences a small model would otherwise have to compute itself. */
function deltas(current: AiWorldSummary, prev: AiWorldSummary | null): string {
  if (!prev) return 'This is your first consultation of the match.';
  const myArmy = (s: AiWorldSummary): number =>
    s.me.army.knight + s.me.army.spearman + s.me.army.archer;
  const lines = [
    `Since last consultation (${current.minutes - prev.minutes} min ago):`,
    `- your army ${myArmy(current) - myArmy(prev) >= 0 ? 'grew' : 'shrank'} from ${myArmy(prev)} to ${myArmy(current)}`,
  ];
  for (const rival of current.rivals) {
    const before = prev.rivals.find((r) => r.id === rival.id);
    if (!before) continue;
    if (before.alive && !rival.alive) {
      lines.push(`- rival ${rival.id} was eliminated`);
      continue;
    }
    if (!rival.alive) continue;
    if (!before.found && rival.found) {
      lines.push(`- rival ${rival.id}'s castle was FOUND, ${rival.distance} tiles away`);
    }
    if (rival.intel && !before.intel) {
      lines.push(`- first sighting of rival ${rival.id}'s army: ${intelLine(rival.intel)}`);
    } else if (rival.intel && before.intel && rival.intel.ageTicks < before.intel.ageTicks) {
      lines.push(`- fresh look at rival ${rival.id}'s army: ${intelLine(rival.intel)}`);
    }
  }
  return lines.join('\n');
}

function intelLine(intel: { heavy: number; light: number; ranged: number; total: number }): string {
  return `${intel.total} soldiers (${intel.heavy} heavy, ${intel.light} light, ${intel.ranged} ranged)`;
}

/**
 * The summary back out of a built prompt, or null if it is not in there.
 *
 * Exists for engines that reason over the state rather than over the
 * words — the lab's rule-based `posture` opponent, which has to see the
 * same valley a model would. Reading it back out of the prompt keeps that
 * engine on the ChatEngine seam every other engine uses, so it runs the
 * genuine pipeline instead of a private side channel into the sim.
 */
export function extractSummary(messages: readonly ChatMessage[]): AiWorldSummary | null {
  const user = messages.find((m) => m.role === ChatRoleNs.user);
  if (!user) return null;
  // Second block of buildMessages' `parts`, which are joined on a blank
  // line and never contain one internally.
  const block = user.content.split('\n\n')[1];
  if (block === undefined) return null;
  try {
    const parsed: unknown = JSON.parse(block);
    return typeof parsed === 'object' && parsed !== null ? (parsed as AiWorldSummary) : null;
  } catch {
    return null;
  }
}

export function buildMessages(
  summary: AiWorldSummary,
  lastAdvice: StrategyAdvice | null,
  prevSummary: AiWorldSummary | null,
): ChatMessage[] {
  const parts = [
    `Match state, minute ${summary.minutes}:`,
    JSON.stringify(summary),
    deltas(summary, prevSummary),
    // The standing posture's *name* and nothing else. The knob values it
    // expanded into are deliberately not quoted back: a model this size
    // copies whatever numbers are in front of it — that is exactly how
    // lfm2.5-350m spent a whole sweep replying with the playbook's own
    // trainPreference — and it has no decision to make about them anyway.
    lastAdvice?.posture
      ? `Your standing posture is "${POSTURE_KEYS[lastAdvice.posture]}". Keep it or change it, as the state warrants.`
      : 'You have not set a posture yet; the playbook runs at its printed values.',
    'Reply with only the JSON object naming your posture.',
  ];
  return [
    { role: ChatRoleNs.system, content: SYSTEM },
    { role: ChatRoleNs.user, content: parts.join('\n\n') },
  ];
}
