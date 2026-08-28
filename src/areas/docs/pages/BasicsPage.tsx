import { For, type JSX } from 'solid-js';
import {
  ABBEY_ALE_CAP,
  ALE_TRAIN_SPEEDUP,
  BARRACKS_ALE_CAP,
  BUILDING_DAMAGE_MULT,
  FESTIVAL_DURATION,
  FORGE_QUEUE_CAP,
  HIRE_QUEUE_CAP,
  HIRE_SERF_COST,
  HIRE_SERF_TICKS,
  RAID_CAP,
  REPAIR_COST_SHARE,
  REPAIR_MEND_TICKS,
  START_SERFS,
  START_STOCK,
  TICKS_PER_SECOND,
  TRAIN_QUEUE_CAP,
  WORKER_RESPAWN_TICKS,
  firstRaidTickFor,
  raidIntervalFor,
} from '../../../sim/defs/balance';
import { BUILDING_DEFS, BuildingTypeId } from '../../../sim/defs/buildings';
import { fmtSecs } from '../data';
import { CostList, Section, Stat, Stats } from '../components';
import { Prose } from '../prose';
import { UnitClass } from '../../../sim/defs/units';

/** The map the raid clock is quoted against — the size every other number
 * in balance.ts was tuned on, and what firstRaidTickFor scales from. */
const CLASSIC_MAP = 64;

const CLASSES: UnitClass[] = [UnitClass.heavy, UnitClass.light, UnitClass.ranged];

export function BasicsPage(): JSX.Element {
  return (
    <>
      <h1>Basics</h1>
      <p class="lede">
        The cross-cutting numbers — what a village opens with, what people cost, and when the
        raiders come. Per-building and per-unit figures live on their own pages.
      </p>
      <Section title="Opening">
        <Stats>
          <Stat label="Serfs">{START_SERFS}</Stat>
          <Stat label="Beds">
            {BUILDING_DEFS[BuildingTypeId.storehouse].housing}, in the castle
          </Stat>
          <Stat label="Stock">
            <CostList amounts={START_STOCK} />
          </Stat>
        </Stats>
      </Section>
      <Section title="People">
        <Stats>
          <Stat label="A serf costs">{HIRE_SERF_COST} silver</Stat>
          <Stat label="…and walks in after">{fmtSecs(HIRE_SERF_TICKS)}</Stat>
          <Stat label="Hires waiting at once">{HIRE_QUEUE_CAP}</Stat>
          <Stat label="A lost worker returns after">{fmtSecs(WORKER_RESPAWN_TICKS)}</Stat>
          <Stat label="Barracks queue">{TRAIN_QUEUE_CAP}</Stat>
          <Stat label="Smith queue">{FORGE_QUEUE_CAP}</Stat>
        </Stats>
      </Section>
      <Section title="Raids">
        <p class="lede">
          <Prose
            text={
              `Quoted for the classic ${CLASSIC_MAP}-tile map. Both clocks stretch with ` +
              `the map, since every haul on a bigger one walks proportionally further.`
            }
          />
        </p>
        <Stats>
          <Stat label="First wave">{fmtSecs(firstRaidTickFor(CLASSIC_MAP))}</Stat>
          <Stat label="Then every">{fmtSecs(raidIntervalFor(CLASSIC_MAP))}</Stat>
          <Stat label="Raiders per wave, at most">{RAID_CAP}</Stat>
          <For each={CLASSES}>
            {(cls) => (
              <Stat label={`A ${cls} blow against a wall`}>
                ×{BUILDING_DAMAGE_MULT[cls]} of what it does to a man
              </Stat>
            )}
          </For>
        </Stats>
      </Section>
      <Section title="Repairs">
        <Stats>
          <Stat label="Materials">
            {REPAIR_COST_SHARE * 100}% of the build cost, scaled to the damage
          </Stat>
          <Stat label="A full rebuild's masonry">{fmtSecs(REPAIR_MEND_TICKS)}</Stat>
        </Stats>
      </Section>
      <Section title="Ale">
        <Stats>
          <Stat label="A festival lasts">{fmtSecs(FESTIVAL_DURATION)}</Stat>
          <Stat label="The abbey keeps">{ABBEY_ALE_CAP} ale</Stat>
          <Stat label="The barracks cask holds">{BARRACKS_ALE_CAP} ale</Stat>
          <Stat label="A soldier who drinks trains">×{ALE_TRAIN_SPEEDUP} faster</Stat>
        </Stats>
      </Section>
      <Section title="Time">
        <p class="lede">
          The game keeps time in ticks — {TICKS_PER_SECOND} to the second. Every duration in this
          guide is given in seconds.
        </p>
      </Section>
    </>
  );
}
