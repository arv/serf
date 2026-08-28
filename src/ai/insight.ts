import { TICK_MS } from '../sim/defs/balance.ts';
import type { StrategyAdvice } from './advice.ts';
import type { SeatKnobs } from './summary.ts';
import { UNIT_KEYS, UnitTypeId } from '../sim/defs/units.ts';

/**
 * Advice → English, for the dev overlay. The model speaks in knob JSON;
 * a human reading the ledger should not have to know that 700 is a
 * cooldown in ticks or that weaponMix 2 is a bow. One line per knob the
 * advice touches, each carrying the playbook's printed value when the
 * advice moved off it — the delta is the insight.
 *
 * Each line also says whether it IS a delta. A small model restates most
 * of the print on every reply (the knobs ride in its prompt, and it
 * copies them back), so "what did it actually change?" is the question
 * the overlay exists to answer — `moved` is how it tells a change from
 * an echo without parsing the text.
 *
 * Pure over (advice, knobs) so it can be tested like the prompt: no DOM,
 * no signals, just words. Never shown to the model and never in the sim —
 * this is the reader's side of the contract in advice.ts.
 */

export interface AdviceLine {
  text: string;
  /** Off the playbook print — a real change, not a restatement. Always
   * true when no playbook was given: there is nothing to call an echo. */
  moved: boolean;
}

/** Recipe indices as the forge knows them: 0 spear, 1 sword, 2 bow. */
const WEAPON_NAMES = ['spear', 'sword', 'bow'] as const;

/** A training preference in the words the overlay reads in. */
const unitList = (units: readonly UnitTypeId[]): string =>
  units.map((u) => UNIT_KEYS[u]).join(' > ');

const secs = (ticks: number): string => `${Math.round((ticks * TICK_MS) / 1000)}s`;
const weapons = (mix: readonly number[]): string =>
  mix.map((i) => WEAPON_NAMES[i] ?? `?${i}`).join(', ');

/**
 * One English line per knob present in the advice, in the contract's
 * order. `playbook` is the seat's printed values (summary.seat.knobs);
 * when given and the advice differs, the line says what it moved from.
 */
export function describeAdvice(advice: StrategyAdvice, playbook?: SeatKnobs): AdviceLine[] {
  const lines: AdviceLine[] = [];
  /** The line, plus "(playbook X)" when the advice moved off the print. */
  const put = (line: string, changed: boolean, printed: string): void => {
    lines.push(
      playbook && changed
        ? { text: `${line} (playbook ${printed})`, moved: true }
        : { text: line, moved: !playbook },
    );
  };

  if (advice.serfTarget !== undefined) {
    put(
      `serfs: hire toward ${advice.serfTarget}`,
      advice.serfTarget !== playbook?.serfTarget,
      `${playbook?.serfTarget}`,
    );
  }
  if (advice.armyAttackSize !== undefined) {
    put(
      `army: march at ${advice.armyAttackSize} soldiers`,
      advice.armyAttackSize !== playbook?.armyAttackSize,
      `${playbook?.armyAttackSize}`,
    );
  }
  if (advice.attackCooldown !== undefined) {
    put(
      `marches: every ${secs(advice.attackCooldown)}`,
      advice.attackCooldown !== playbook?.attackCooldown,
      secs(playbook?.attackCooldown ?? 0),
    );
  }
  if (advice.homeGuard !== undefined) {
    put(
      advice.homeGuard === 0
        ? 'home guard: never recall'
        : `home guard: recall within ${advice.homeGuard} tiles`,
      advice.homeGuard !== playbook?.homeGuard,
      playbook?.homeGuard === 0 ? 'never' : `${playbook?.homeGuard} tiles`,
    );
  }
  if (advice.prefersRivals !== undefined) {
    put(
      advice.prefersRivals
        ? 'targets: hold out for rival castles'
        : 'targets: nearest first, camps included',
      advice.prefersRivals !== playbook?.prefersRivals,
      playbook?.prefersRivals === true ? 'rivals' : 'nearest',
    );
  }
  if (advice.trainPreference !== undefined) {
    put(
      `training: ${unitList(advice.trainPreference)}`,
      advice.trainPreference.join() !== playbook?.trainPreference.join(),
      playbook === undefined ? '' : unitList(playbook.trainPreference),
    );
  }
  if (advice.weaponMix !== undefined) {
    put(
      `forges: ${weapons(advice.weaponMix)}`,
      advice.weaponMix.join() !== playbook?.weaponMix.join(),
      weapons(playbook?.weaponMix ?? []),
    );
  }
  if (advice.barracksQueueDepth !== undefined) {
    put(
      `barracks queue: ${advice.barracksQueueDepth} deep`,
      advice.barracksQueueDepth !== playbook?.barracksQueueDepth,
      `${playbook?.barracksQueueDepth}`,
    );
  }
  if (advice.houseLimit !== undefined) {
    put(
      `houses: up to ${advice.houseLimit}`,
      advice.houseLimit !== playbook?.houseLimit,
      `${playbook?.houseLimit}`,
    );
  }
  if (advice.housingHeadroom !== undefined) {
    put(
      `housing headroom: ${advice.housingHeadroom} beds`,
      advice.housingHeadroom !== playbook?.housingHeadroom,
      `${playbook?.housingHeadroom}`,
    );
  }
  if (advice.researchReserve !== undefined) {
    put(
      `research reserve: ${advice.researchReserve} silver`,
      advice.researchReserve !== playbook?.researchReserve,
      `${playbook?.researchReserve}`,
    );
  }
  if (advice.marchConfidence !== undefined) {
    // 0 is the printed value everywhere, and it means the march is decided
    // on headcount alone — so it reads as off rather than as a number.
    put(
      advice.marchConfidence > 0
        ? `marches only when it expects ${advice.marchConfidence}% of the army to survive`
        : 'marches on headcount alone',
      advice.marchConfidence !== playbook?.marchConfidence,
      `${playbook?.marchConfidence}`,
    );
  }
  return lines;
}
