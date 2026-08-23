import { For, Show, type JSX } from 'solid-js';
import type { GoodId } from '../../../sim/defs/goods';
import { GoodIcon } from '../../../ui/icons';
import { buildingName, goodName, techName, unitName } from '../../../ui/names';
import {
  CONSUMED_BY,
  HIRE_SERF_COST,
  PRODUCED_BY,
  fmtPerMinute,
  startStockOf,
  type ConsumerRef,
} from '../data';
import { GOOD_DESC } from '../descriptions';
import { DocLink, Section } from '../components';
import { Prose } from '../prose';
import { buildingHref, goodHref, techHref, unitHref } from '../routes';

// `entry`, not `ref`: ref is a reserved prop in Solid (element forwarding),
// and a component that borrows the name never receives the value.
function ConsumerLine(props: { entry: ConsumerRef }): JSX.Element {
  const r = props.entry;
  switch (r.kind) {
    case 'recipe':
      return (
        <li>
          An ingredient at the{' '}
          <DocLink href={buildingHref(r.building)}>{buildingName(r.building)}</DocLink>
          <Show when={r.requiresTech}>
            {(tech) => (
              <>
                {' '}
                (with <DocLink href={techHref(tech())}>{techName(tech())}</DocLink>)
              </>
            )}
          </Show>
        </li>
      );
    case 'construction':
      return (
        <li>
          Building material for the{' '}
          <DocLink href={buildingHref(r.building)}>{buildingName(r.building)}</DocLink>
        </li>
      );
    case 'repair':
      return (
        <li>
          Mends the{' '}
          <DocLink href={buildingHref(r.building)}>{buildingName(r.building)}</DocLink>
        </li>
      );
    case 'training':
      return (
        <li>
          Spent training a <DocLink href={unitHref(r.unit)}>{unitName(r.unit)}</DocLink> at the{' '}
          <DocLink href={buildingHref(r.building)}>{buildingName(r.building)}</DocLink>
        </li>
      );
    case 'tech':
      return (
        <li>
          Pays for the <DocLink href={techHref(r.tech)}>{techName(r.tech)}</DocLink> research
        </li>
      );
    case 'tool':
      return (
        <li>
          The tool that staffs the{' '}
          <DocLink href={buildingHref(r.building)}>{buildingName(r.building)}</DocLink>
        </li>
      );
    case 'weapon':
      return (
        <li>
          The weapon a <DocLink href={unitHref(r.unit)}>{unitName(r.unit)}</DocLink> is trained
          with
        </li>
      );
    case 'festival':
      return (
        <li>
          Drunk at the{' '}
          <DocLink href={buildingHref('abbey')}>{buildingName('abbey')}</DocLink> to hold a
          festival, once <DocLink href={techHref('festivals')}>{techName('festivals')}</DocLink>{' '}
          is researched
        </li>
      );
    case 'ration':
      return (
        <li>
          Kept in the{' '}
          <DocLink href={buildingHref('barracks')}>{buildingName('barracks')}</DocLink> cask —
          with <DocLink href={techHref('aleRations')}>{techName('aleRations')}</DocLink> each
          recruit drinks one and trains faster
        </li>
      );
    case 'hire':
      return <li>Hires a serf ({HIRE_SERF_COST} silver each)</li>;
    case 'siteLoan':
      return <li>Loaned to every construction site, and handed back at the topping-out</li>;
  }
}

export function GoodPage(props: { id: GoodId }): JSX.Element {
  const producers = PRODUCED_BY.get(props.id) ?? [];
  const consumers = CONSUMED_BY.get(props.id) ?? [];
  const start = startStockOf(props.id);
  return (
    <>
      <p class="crumb">
        <DocLink href="/docs/goods">Goods</DocLink>
      </p>
      <h1>
        <GoodIcon good={props.id} size={26} /> {goodName(props.id)}
      </h1>
      <p class="lede">
        <Prose text={GOOD_DESC[props.id]} self={goodHref(props.id)} />
      </p>
      <Section title="Produced by">
        <Show when={producers.length > 0} fallback={<p class="lede">No building makes this.</p>}>
          <ul class="refs">
            <For each={producers}>
              {(p) => (
                <li>
                  <DocLink href={buildingHref(p.building)}>{buildingName(p.building)}</DocLink> ·{' '}
                  {fmtPerMinute(p.amount, p.durationTicks)}
                  <Show when={p.via === 'forge'}> · on the forge menu</Show>
                  <Show when={p.requiresTech}>
                    {(tech) => (
                      <>
                        {' '}
                        · needs <DocLink href={techHref(tech())}>{techName(tech())}</DocLink>
                      </>
                    )}
                  </Show>
                </li>
              )}
            </For>
          </ul>
        </Show>
      </Section>
      <Section title="Used by">
        <Show when={consumers.length > 0} fallback={<p class="lede">Nothing takes this.</p>}>
          <ul class="refs">
            <For each={consumers}>{(c) => <ConsumerLine entry={c} />}</For>
          </ul>
        </Show>
      </Section>
      <Show when={start > 0}>
        <Section title="Starting stock">
          <p class="lede">
            <Prose text={`The village opens with ${start} in the castle store.`} />
          </p>
        </Section>
      </Show>
    </>
  );
}
