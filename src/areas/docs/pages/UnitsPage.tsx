import { For, type JSX } from 'solid-js';
import { UNIT_DEFS, type UnitTypeId } from '../../../sim/defs/units';
import { unitName } from '../../../ui/names';
import { ALL_UNITS, RAIDER_UNITS } from '../data';
import { DocLink } from '../components';
import { ModelCard } from '../preview/ModelCard';
import { unitHref } from '../routes';

function UnitTile(props: { id: UnitTypeId }): JSX.Element {
  const def = UNIT_DEFS[props.id];
  return (
    <DocLink href={unitHref(props.id)} class="tile">
      <ModelCard kind="unit" id={props.id} animated />
      <span class="t-name">{unitName(props.id)}</span>
      <span class="t-sub">
        {def.hp} hp · {def.speed} tiles/s
        {def.combat ? ` · ${def.combat.class}` : ' · civilian'}
      </span>
    </DocLink>
  );
}

export function UnitsPage(): JSX.Element {
  const raiders = new Set(RAIDER_UNITS);
  const yours = ALL_UNITS.filter((id) => !raiders.has(id));
  return (
    <>
      <h1>Units</h1>
      <p class="lede">
        Your people and the raiders’. Soldiers follow the triangle: heavy beats light, light catches
        ranged, ranged kites heavy.
      </p>
      <section>
        <h2>Your People</h2>
        <div class="tiles">
          <For each={yours}>{(id) => <UnitTile id={id} />}</For>
        </div>
      </section>
      <section>
        <h2>Raiders</h2>
        <div class="tiles">
          <For each={RAIDER_UNITS}>{(id) => <UnitTile id={id} />}</For>
        </div>
      </section>
    </>
  );
}
