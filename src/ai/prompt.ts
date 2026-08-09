import type { StrategyAdvice } from './advice.ts';
import type { AiWorldSummary } from './summary.ts';

/**
 * Summary → chat messages. Kept apart from the strategist so the whole
 * prompt is a pure function anyone can snapshot-test — and so tuning the
 * wording never touches the machinery around it.
 *
 * Written for a ~1B instruct model, which shapes everything: the system
 * message is a glossary rather than an essay, the user message is data
 * with a little arithmetic already done (deltas since last time), and the
 * asked-for reply is a handful of JSON keys. Budget is ~800 input tokens;
 * the summary is capped near 1.5 KB, so the total holds.
 */

/** OpenAI-style chat shape, structurally what WebLLM accepts — declared
 * here so nothing on this path imports the engine package. */
export interface ChatMessage {
  role: 'system' | 'user';
  content: string;
}

const SYSTEM = `You are the strategist for one AI lord in a medieval RTS. Serfs haul goods, buildings produce them, soldiers fight. Razing a rival's castle eliminates them; razing bandit camps stops raids. You steer high-level posture by adjusting knobs; a competent captain handles all execution.

Knobs you may set (integers unless noted):
- serfTarget (6-20): serfs to hire toward. More hands, more upkeep.
- armyAttackSize (3-16): soldiers mustered before marching.
- attackCooldown (200-2000): ticks between marches (20 ticks = 1s).
- homeGuard (0-20): recall army when an enemy comes this close to home; 0 never recalls.
- prefersRivals (boolean): true marches on rival castles even when a bandit camp is nearer.
- trainPreference (array from "knight","spearman","archer"): training priority. Knights are heavy and slow, spearmen fast and cheap, archers ranged. Heavy beats light, light catches ranged, ranged kites heavy.
- weaponMix (array of 0-2, one entry per forge): 0=spear, 1=sword, 2=bow. Swords cost double iron; bows cost only wood.
- barracksQueueDepth (1-4), houseLimit (2-8), housingHeadroom (1-6), researchReserve (0-20).

Reply with a single JSON object. Include ONLY knobs you want changed, plus a short "reason". {} means keep everything as it is. No text outside the JSON.`;

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
    if (before.alive && !rival.alive) lines.push(`- rival ${rival.id} was eliminated`);
    else if (rival.alive) {
      lines.push(`- rival ${rival.id} army went from ${before.army} to ${rival.army}`);
    }
  }
  return lines.join('\n');
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
    lastAdvice && Object.keys(lastAdvice).length > 0
      ? `Your current adjustments (already in effect): ${JSON.stringify(lastAdvice)}`
      : 'No adjustments in effect; the playbook runs at its printed values.',
    'Reply with only the JSON object of knob changes.',
  ];
  return [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: parts.join('\n\n') },
  ];
}
