import { For, type JSX } from 'solid-js';
import { BUILDING_DEFS, type BuildingTypeId } from '../../../sim/defs/buildings';
import { BUILD_GROUPS } from '../../../ui/buildMenu';
import { buildingName } from '../../../ui/names';
import { ALL_BUILDINGS } from '../data';
import { BUILDING_DESC } from '../descriptions';
import { CostList, DocLink } from '../components';
import { ModelCard } from '../preview/ModelCard';
import { buildingHref } from '../routes';

/** The roofs no ribbon tab offers: worldgen's and the road pass's. Derived,
 * so a new system building cannot be silently missed — data.test.ts holds
 * the ribbon ∪ this = everything invariant. */
export function worldBuildings(): BuildingTypeId[] {
  const inMenu = new Set(BUILD_GROUPS.flatMap((g) => g.types));
  return ALL_BUILDINGS.filter((id) => !inMenu.has(id) && !BUILDING_DEFS[id].isRoad);
}

function BuildingTile(props: { id: BuildingTypeId }): JSX.Element {
  return (
    <DocLink href={buildingHref(props.id)} class="tile">
      <ModelCard kind="building" id={props.id} />
      <span class="t-name">{buildingName(props.id)}</span>
      <span class="t-sub">{BUILDING_DESC[props.id]}</span>
      <CostList amounts={BUILDING_DEFS[props.id].cost} freeLabel="already standing" />
    </DocLink>
  );
}

export function BuildingsPage(): JSX.Element {
  return (
    <>
      <h1>Buildings</h1>
      <p class="lede">
        Grouped the way the build ribbon groups them — the village first, then the food chain,
        the industry it feeds, and the war it pays for.
      </p>
      <For each={BUILD_GROUPS}>
        {(group) => (
          <section>
            <h2>{group.label}</h2>
            <div class="tiles">
              <For each={group.types}>{(id) => <BuildingTile id={id} />}</For>
            </div>
          </section>
        )}
      </For>
      <section>
        <h2>The World’s</h2>
        <div class="tiles">
          <For each={worldBuildings()}>{(id) => <BuildingTile id={id} />}</For>
        </div>
      </section>
    </>
  );
}
