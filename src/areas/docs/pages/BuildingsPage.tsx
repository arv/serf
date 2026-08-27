import { For, type JSX } from 'solid-js';
import { BUILDING_DEFS, type BuildingTypeId } from '../../../sim/defs/buildings';
import { BUILD_GROUPS } from '../../../ui/buildMenu';
import { buildingName } from '../../../ui/names';
import { worldBuildings } from '../data';
import { BUILDING_DESC } from '../descriptions';
import { CostList, DocLink } from '../components';
import { ModelCard } from '../preview/ModelCard';
import { buildingHref } from '../routes';

/**
 * A wrapper, not one big link: the cost chips are links of their own, and
 * an anchor inside an anchor is an invalid tree that no amount of
 * stopPropagation repairs (the replay shelf keeps its row and its delete
 * button siblings for the same reason). The name's link is stretched over
 * the whole card instead, so the tile still clicks through as one target,
 * and the chips sit above it.
 */
function BuildingTile(props: { id: BuildingTypeId }): JSX.Element {
  return (
    <div class="tile">
      <ModelCard kind="building" id={props.id} />
      <DocLink href={buildingHref(props.id)} class="t-name stretch">
        {buildingName(props.id)}
      </DocLink>
      <span class="t-sub">{BUILDING_DESC[props.id]}</span>
      <CostList amounts={BUILDING_DEFS[props.id].cost} freeLabel="already standing" />
    </div>
  );
}

export function BuildingsPage(): JSX.Element {
  return (
    <>
      <h1>Buildings</h1>
      <p class="lede">
        Grouped the way the build ribbon groups them — what the village is built from and paid
        for with, what it eats and drinks, and what it fights with.
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
