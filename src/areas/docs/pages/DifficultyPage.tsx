import {For, type JSX} from 'solid-js';
import {
  AI_STRATEGIES,
  type AiStrategy,
} from '../../../sim/defs/aiStrategies.ts';
import * as AiStrategyId from '../../../sim/defs/aiStrategyIdEnum.ts';
import {RAID_CAP} from '../../../sim/defs/balance.ts';
import {
  applyDifficulty,
  DEFAULT_SCOUT_REFRESH,
  DIFFICULTIES,
  DIFFICULTY_ORDER,
  scaleDecisionInterval,
  scaleIntelTrust,
  scaleMinSighting,
  scaleRaidCap,
  scaleStanceClock,
  type Difficulty,
  type DifficultyId,
} from '../../../sim/defs/difficulty.ts';
import * as UnitTypeId from '../../../sim/defs/unitTypeIdEnum.ts';
import {AI_INTEL, AI_PACING, AI_STANCE} from '../../../sim/systems/ai.ts';
import {unitName} from '../../../ui/names';
import {Section} from '../components';
import {fmtSecs} from '../data';

/**
 * What the three settings actually change.
 *
 * Every number on this page is computed by the sim's own
 * `applyDifficulty`, run over one playbook, rather than written down
 * beside it: a guide that quotes a tier by hand is a guide that goes
 * quietly wrong the first time the table is tuned.
 *
 * The Steward is the playbook it is run over, for the reason
 * defs/aiStrategies.ts gives it: it is the campaign's original line and
 * the yardstick the other three were balanced against. A tier is a
 * transform, so the other lords land on different numbers — but they move
 * by the same rule and in the same direction, which is the part a reader
 * needs.
 */
const YARDSTICK = AI_STRATEGIES[AiStrategyId.steward];

/** One row of the comparison: what to call it, and what each tier makes of
 * it. `note` is the row's one line of why it matters. */
interface Row {
  label: string;
  note?: string;
  value: (s: AiStrategy, d: Difficulty, id: DifficultyId) => JSX.Element;
}

const WAR: Row[] = [
  {
    label: 'Marches when it has',
    note: 'Soldiers standing before the army leaves home.',
    value: s => `${s.armyAttackSize} soldiers`,
  },
  {
    label: 'Waits between marches',
    value: s => fmtSecs(s.attackCooldown),
  },
  {
    label: 'Wants odds of',
    note: 'How much of its own army a captain expects to survive before he will commit.',
    value: s =>
      s.marchConfidence > 0
        ? `${s.marchConfidence}%`
        : 'any — it marches on headcount',
  },
  {
    label: 'Raids your economy',
    note: 'Small parties sent at your outbuildings while the muster builds.',
    value: s =>
      s.harass
        ? `${s.harass.size} men, every ${fmtSecs(s.harass.cooldown)}`
        : 'never',
  },
  {
    label: 'Guards its own gate within',
    note: 'An army this close to home is recalled instead of pressing an attack.',
    value: s =>
      s.homeGuard > 0 ? `${s.homeGuard} tiles` : 'nothing — it stays out',
  },
  {
    label: 'Re-reads your yard every',
    note: 'How often it walks a scout to your doorstep to count what you have.',
    value: s => fmtSecs(s.scoutRefreshAfter ?? DEFAULT_SCOUT_REFRESH),
  },
  {
    label: 'Arms its soldiers with',
    note: 'What the forges make and the barracks trains. The spear is the cheapest weapon in the game, and it loses to the knight it will meet.',
    value: s =>
      s.trainPreference.map(u => unitName(u)).join(', ') +
      (s.trainPreference.length === 1 &&
      s.trainPreference[0] === UnitTypeId.spearman
        ? ' only'
        : ''),
  },
  {
    label: 'Musters for a siege at',
    note: 'Soldiers standing before it stops building and starts prosecuting a war on a castle it has found.',
    value: s =>
      s.stances.foundAfterArmy
        ? `${s.stances.foundAfterArmy} soldiers`
        : 'as soon as it finds you',
  },
  {
    label: 'Trusts a sighting for',
    note: 'How long what a scout saw still counts. It never changes what a lord can SEE — only how long it remembers, and a lord that forgets stops re-arming against what you field.',
    value: (_s, _d, id) => fmtSecs(scaleIntelTrust(AI_INTEL.trustFor, id)),
  },
  {
    label: 'Calls it an army at',
    note: 'Fighters seen at once before it believes there is a muster rather than a patrol.',
    value: (_s, _d, id) =>
      `${scaleMinSighting(AI_INTEL.minSighting, id)} soldiers`,
  },
  {
    label: 'Reconsiders its mood every',
    note: 'How soon it notices the situation has turned. A raid at its own gate always breaks in at once, whatever this says.',
    value: (_s, _d, id) => fmtSecs(scaleStanceClock(AI_STANCE.evalPeriod, id)),
  },
  {
    label: 'Thinks every',
    note: 'One decision beat. A slower lord is not worse at the game — it is late to it.',
    value: (_s, _d, id) =>
      fmtSecs(scaleDecisionInterval(AI_PACING.decisionInterval, id)),
  },
];

const VILLAGE: Row[] = [
  {
    label: 'Hires up to',
    value: s => `${s.serfTarget} hands`,
  },
  {
    label: 'Builds up to',
    value: s => `${s.houseLimit} houses`,
  },
  {
    label: 'Keeps beds spare',
    note: 'Empty beds kept standing, so a soldier trained is never a hire refused.',
    value: s => `${s.housingHeadroom}`,
  },
  {
    label: 'Trains ahead',
    value: s => `${s.barracksQueueDepth} in the barracks queue`,
  },
  {
    label: 'Holds back for research',
    note: 'Silver kept out of the hiring purse while a tech is still pending.',
    value: s => `${s.researchReserve} silver`,
  },
];

/** The campaign half. Multipliers rather than amounts on purpose: each
 * commission has its own authored opening (see the Basics page), and the
 * tier scales whatever that commission grants. */
const COMMISSION: {
  label: string;
  note?: string;
  value: (d: Difficulty) => string;
}[] = [
  {
    label: 'Opening larder',
    value: d => pctLabel(d.startStockPct),
  },
  {
    label: 'Hands in the yard',
    value: d =>
      d.startSerfs === 0
        ? 'as written'
        : `${d.startSerfs > 0 ? '+' : ''}${d.startSerfs}`,
  },
  {
    label: 'Peace before the first raid',
    value: d => pctLabel(d.firstRaidTickPct),
  },
  {
    label: 'Gap between waves after it',
    note: 'The number that decides a commission: whether the village gets to rebuild between raids.',
    value: d => pctLabel(d.raidIntervalPct),
  },
  {
    label: 'Raiders in a wave, at most',
    value: d => `${scaleRaidCap(RAID_CAP, d.id)}`,
  },
];

function pctLabel(percent: number): string {
  return percent === 100 ? 'as written' : `×${percent / 100}`;
}

function Grid(props: {rows: Row[]}): JSX.Element {
  return (
    <div class="scroll-x">
      <table>
        <thead>
          <tr>
            <th />
            <For each={DIFFICULTY_ORDER}>
              {id => <th>{DIFFICULTIES[id].name}</th>}
            </For>
          </tr>
        </thead>
        <tbody>
          <For each={props.rows}>
            {row => (
              <tr>
                <td>
                  {row.label}
                  {row.note ? <div class="row-note">{row.note}</div> : null}
                </td>
                <For each={DIFFICULTY_ORDER}>
                  {id => (
                    <td>
                      {row.value(
                        applyDifficulty(YARDSTICK, id),
                        DIFFICULTIES[id],
                        id,
                      )}
                    </td>
                  )}
                </For>
              </tr>
            )}
          </For>
        </tbody>
      </table>
    </div>
  );
}

export function DifficultyPage(): JSX.Element {
  return (
    <>
      <h1>Difficulty</h1>
      <p class="lede">
        One setting doing two jobs: how well the computer opponents play, and —
        in the campaign only — how generous the commission you are given is. Set
        it on the start screen, or in the war council for a multiplayer room.
      </p>

      <Section title="How the computer plays">
        <p class="lede">
          The numbers below are the Steward’s line, since it is the one every
          other playbook was balanced against. The other lords start from
          different numbers and move by the same rule, so read the columns
          against each other rather than as absolutes.
        </p>
        <Grid rows={WAR} />
      </Section>

      <Section title="…and how it grows">
        <Grid rows={VILLAGE} />
      </Section>

      <Section title="What a commission grants you">
        <p class="lede">
          The campaign half, and the only place the setting touches anything but
          the computer’s own decisions. Each commission has its own authored
          opening; the tier scales it. The valley, the objectives and any
          village already standing are the same at every setting — a commission
          teaches the same lesson however hard it is set, it just leaves you
          less room to learn it in.
        </p>
        <div class="scroll-x">
          <table>
            <thead>
              <tr>
                <th />
                <For each={DIFFICULTY_ORDER}>
                  {id => <th>{DIFFICULTIES[id].name}</th>}
                </For>
              </tr>
            </thead>
            <tbody>
              <For each={COMMISSION}>
                {row => (
                  <tr>
                    <td>
                      {row.label}
                      {row.note ? <div class="row-note">{row.note}</div> : null}
                    </td>
                    <For each={DIFFICULTY_ORDER}>
                      {id => <td>{row.value(DIFFICULTIES[id])}</td>}
                    </For>
                  </tr>
                )}
              </For>
            </tbody>
          </table>
        </div>
      </Section>

      <Section title="What it never does">
        <ul class="refs">
          <li>
            <strong>It does not hand the computer anything.</strong> Every seat
            — yours and theirs — opens a skirmish with the same larder, the same
            hands and the same castle at every setting. A hard opponent is one
            that plays its own resources better, not one that was given more of
            them.
          </li>
          <li>
            <strong>It does not lift the fog.</strong> The opponents see what
            their people can see, and remember what their scouts wrote down, at
            every setting. Hard scouts you sooner; it does not scout you for
            free.
          </li>
          <li>
            <strong>It does not flatten the four lords into one.</strong> Half
            of what a playbook is is what it refuses to do — the Abbot never
            raids, the Steward turns a losing march for home — so the hardest
            setting sharpens what a lord already does and is never allowed to
            grant it somebody else’s habits: at Hard every opponent keeps its
            own arms, its own refusals and its own cascade, and only the
            magnitudes move. Easy is under no such duty. It may talk a lord out
            of raiding and hand it all spears, because a lord playing badly is
            what was asked for.
          </li>
        </ul>
      </Section>
    </>
  );
}
