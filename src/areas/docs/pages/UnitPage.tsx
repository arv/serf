import { For, Show, createSignal, type JSX } from 'solid-js';
import type { AnimKey } from '../../../render/characters';
import { HIRE_SERF_COST, HIRE_SERF_TICKS } from '../../../sim/defs/balance';
import { BUILDING_DEFS } from '../../../sim/defs/buildings';
import { COUNTER_TABLE, UNIT_DEFS, WEAPON_OF } from '../../../sim/defs/units';
import { buildingName, techName, unitName } from '../../../ui/names';
import { ALL_BUILDINGS, TRAINED_AT, UNIT_UNLOCKED_BY, fmtSecs } from '../data';
import { UNIT_DESC } from '../descriptions';
import { CostList, DocLink, GoodChip, Section, Stat, Stats } from '../components';
import { ModelCard } from '../preview/ModelCard';
import { Prose } from '../prose';
import { buildingHref, techHref, unitHref } from '../routes';
import { UnitTypeId } from '../../../sim/defs/units';
import { BuildingTypeId } from '../../../sim/defs/buildings';
import { UnitClass } from '../../../sim/defs/units';

const CLASSES: UnitClass[] = [UnitClass.heavy, UnitClass.light, UnitClass.ranged];

/**
 * The clips worth watching, per kind of person. A soldier's third is the
 * one he fights with — the bow's loose is 'shoot', not 'attack' — and the
 * civilians get the work they actually do instead of a swing they never
 * take.
 */
function animOptions(unit: UnitTypeId): { key: AnimKey; label: string }[] {
  const combat = UNIT_DEFS[unit].combat;
  const walk: { key: AnimKey; label: string }[] = [
    { key: 'idle', label: 'Idle' },
    { key: 'walk', label: 'Walk' },
  ];
  if (!combat) {
    return [...walk, { key: 'carry', label: 'Carry' }, { key: 'work', label: 'Work' }];
  }
  return [
    ...walk,
    combat.class === UnitClass.ranged ? { key: 'shoot', label: 'Shoot' } : { key: 'attack', label: 'Attack' },
    { key: 'death', label: 'Fall' },
  ];
}

export function UnitPage(props: { id: UnitTypeId }): JSX.Element {
  const def = UNIT_DEFS[props.id];
  const training = TRAINED_AT.get(props.id);
  const weapon = WEAPON_OF[props.id];
  const gate = UNIT_UNLOCKED_BY.get(props.id);
  const employers = ALL_BUILDINGS.filter((b) => BUILDING_DEFS[b].workerKind === props.id);
  const anims = animOptions(props.id);
  const [anim, setAnim] = createSignal<AnimKey>('idle');
  return (
    <>
      <p class="crumb">
        <DocLink href="/docs/units">Units</DocLink>
      </p>
      <h1>{unitName(props.id)}</h1>
      <p class="lede">
        <Prose text={UNIT_DESC[props.id]} self={unitHref(props.id)} />
      </p>
      <div class="hero">
        <ModelCard kind="unit" id={props.id} animated interactive anim={anim()} />
        <div class="hint">drag to turn</div>
        <div class="anim-bar">
          <For each={anims}>
            {(option) => (
              <button
                type="button"
                // The gold fill says which clip is playing; aria-pressed is
                // how that reaches anyone not looking at it.
                aria-pressed={anim() === option.key}
                class={anim() === option.key ? 'on' : undefined}
                onClick={() => setAnim(option.key)}
              >
                {option.label}
              </button>
            )}
          </For>
        </div>
      </div>
      <Section title="Stats">
        <Stats>
          <Stat label="Hit points">{def.hp}</Stat>
          <Stat label="Speed">{def.speed} tiles/s</Stat>
          <Stat label="Sight">{def.sight} tiles</Stat>
          <Show when={def.combat}>
            {(c) => (
              <>
                <Stat label="Class">{c().class}</Stat>
                <Stat label="Damage">
                  {c().damage} every {fmtSecs(c().cooldownTicks)}
                </Stat>
                <Stat label="Range">{c().range} tiles</Stat>
                <Stat label="Picks fights within">{c().acquireRadius} tiles</Stat>
              </>
            )}
          </Show>
        </Stats>
      </Section>
      <Show when={def.combat}>
        {(c) => (
          <Section title="Counters">
            <div class="scroll-x">
              <table>
                <thead>
                  <tr>
                    <th></th>
                    <For each={CLASSES}>{(cls) => <th>vs {cls}</th>}</For>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td>Deals</td>
                    <For each={CLASSES}>{(cls) => <td>×{COUNTER_TABLE[c().class][cls]}</td>}</For>
                  </tr>
                  <tr>
                    <td>Takes</td>
                    <For each={CLASSES}>{(cls) => <td>×{COUNTER_TABLE[cls][c().class]}</td>}</For>
                  </tr>
                </tbody>
              </table>
            </div>
          </Section>
        )}
      </Show>
      <Show when={training}>
        {(t) => (
          <Section title="Training">
            <ul class="refs">
              <li>
                Trained at the{' '}
                <DocLink href={buildingHref(t().building)}>{buildingName(t().building)}</DocLink>{' '}
                for <CostList amounts={t().cost} /> in {fmtSecs(t().durationTicks)}
              </li>
              <Show when={weapon !== undefined}>
                <li>
                  Marches with a <GoodChip good={weapon!} /> — no weapon in store, no recruit
                </li>
              </Show>
              <Show when={gate}>
                {(tech) => (
                  <li>
                    Needs <DocLink href={techHref(tech())}>{techName(tech())}</DocLink> researched
                  </li>
                )}
              </Show>
            </ul>
          </Section>
        )}
      </Show>
      <Show when={props.id === UnitTypeId.serf}>
        <Section title="Hiring">
          <p class="lede">
            <Prose
              text={
                `Hired at the castle for ${HIRE_SERF_COST} silver; the recruit walks in ` +
                `after ${fmtSecs(HIRE_SERF_TICKS)}. Every serf needs a bed — the castle ` +
                `sleeps ${BUILDING_DEFS[BuildingTypeId.storehouse].housing}, houses add the rest.`
              }
              self={unitHref(props.id)}
            />
          </p>
        </Section>
      </Show>
      <Show when={employers.length > 0}>
        <Section title="Posts">
          <ul class="refs">
            <For each={employers}>
              {(b) => (
                <li>
                  <DocLink href={buildingHref(b)}>{buildingName(b)}</DocLink>
                </li>
              )}
            </For>
          </ul>
        </Section>
      </Show>
      <Show when={props.id === UnitTypeId.worker}>
        <p class="lede">
          A worker is a <DocLink href={unitHref(UnitTypeId.serf)}>serf</DocLink> who took one of the posts
          above; dismiss the post and he is a serf again.
        </p>
      </Show>
    </>
  );
}
