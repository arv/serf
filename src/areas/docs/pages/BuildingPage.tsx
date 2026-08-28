import { For, Show, type JSX } from 'solid-js';
import { BUILDING_DEFS, TOOL_OF, BuildingTypeId } from '../../../sim/defs/buildings';
import { type GoodId, goodKeys } from '../../../sim/defs/goods';
import { buildKey } from '../../../ui/buildMenu';
import { buildingName, goodName, techName, unitName } from '../../../ui/names';
import { buildingTechGates, fmtSecs } from '../data';
import { BUILDING_DESC } from '../descriptions';
import { CostList, DocLink, GoodChip, RecipeView, Section, Stat, Stats } from '../components';
import { ModelCard } from '../preview/ModelCard';
import { Prose } from '../prose';
import { buildingHref, goodHref, techHref, unitHref } from '../routes';

export function BuildingPage(props: { id: BuildingTypeId }): JSX.Element {
  const def = BUILDING_DEFS[props.id];
  const tool = TOOL_OF[props.id];
  const gates = buildingTechGates(props.id);
  const hotkey = buildKey(props.id);
  return (
    <>
      <p class="crumb">
        <DocLink href="/docs/buildings">Buildings</DocLink>
      </p>
      <h1>{def.name}</h1>
      <p class="lede">
        <Prose text={BUILDING_DESC[props.id]} self={buildingHref(props.id)} />
      </p>
      <div class="hero">
        <ModelCard kind="building" id={props.id} interactive />
        <div class="hint">drag to turn</div>
      </div>
      <Section title="Stats">
        <Stats>
          <Stat label="Footprint">
            {def.w}×{def.h} tiles
          </Stat>
          <Stat label="Cost">
            <CostList amounts={def.cost} freeLabel="already standing" />
          </Stat>
          <Show when={def.buildTicks > 0}>
            <Stat label="Build time">{fmtSecs(def.buildTicks)}</Stat>
          </Show>
          <Stat label="Hit points">{def.hp}</Stat>
          <Stat label="Sight">{def.sight} tiles</Stat>
          <Show when={def.housing}>
            <Stat label="Housing">{def.housing} beds</Stat>
          </Show>
          <Show when={def.storage}>
            <Stat label="Storage">holds the village’s whole stock</Stat>
          </Show>
          <Show when={def.repairCost}>
            {(cost) => (
              <Stat label="Repairs billed against">
                <CostList amounts={cost()} />
              </Stat>
            )}
          </Show>
          <Show when={def.nearWater}>
            {(nw) => (
              <Stat label="Placement">
                open water within {nw().radius} tile{nw().radius === 1 ? '' : 's'}
              </Stat>
            )}
          </Show>
          <Show when={def.mine}>
            <Stat label="Ground">dug into the hillside — exempt from flat ground</Stat>
          </Show>
          <Show when={hotkey !== ''}>
            <Stat label="Hotkey">B → {hotkey}</Stat>
          </Show>
        </Stats>
      </Section>
      <Show when={def.workerKind !== undefined || tool !== undefined}>
        <Section title="Staffing">
          <ul class="refs">
            <Show when={def.workerKind !== undefined}>
              <li>
                Staffed by a{' '}
                <DocLink href={unitHref(def.workerKind!)}>{unitName(def.workerKind!)}</DocLink> when
                construction completes
              </li>
            </Show>
            <Show when={tool !== undefined}>
              <li>
                The post needs a <GoodChip good={tool!} /> from the{' '}
                <DocLink href={buildingHref(BuildingTypeId.weaponsmith)}>
                  {buildingName(BuildingTypeId.weaponsmith)}
                </DocLink>
              </li>
            </Show>
          </ul>
        </Section>
      </Show>
      <Show when={def.recipe}>
        {(recipe) => (
          <Section title="Production">
            <p class="lede">
              <RecipeView recipe={recipe()} />
            </p>
            <Show when={def.drawTicks}>
              {(ticks) => (
                <p class="lede">
                  No keeper: whoever comes for a good spends {fmtSecs(ticks())} drawing it.
                </p>
              )}
            </Show>
          </Section>
        )}
      </Show>
      <Show when={def.recipeOptions}>
        {(options) => (
          <Section title="Forge menu">
            <div class="scroll-x">
              <table>
                <thead>
                  <tr>
                    <th>Makes</th>
                    <th>Recipe</th>
                    <th>Needs</th>
                  </tr>
                </thead>
                <tbody>
                  <For each={options()}>
                    {(opt) => {
                      const output = goodKeys(opt.recipe.outputs)[0];
                      return (
                        <tr>
                          <td>
                            <Show when={output !== undefined} fallback="—">
                              <DocLink href={goodHref(output!)}>{goodName(output!)}</DocLink>
                            </Show>
                          </td>
                          <td>
                            <RecipeView recipe={opt.recipe} />
                          </td>
                          <td>
                            <Show when={opt.requiresTech !== undefined} fallback="—">
                              <DocLink href={techHref(opt.requiresTech!)}>
                                {techName(opt.requiresTech!)}
                              </DocLink>
                            </Show>
                          </td>
                        </tr>
                      );
                    }}
                  </For>
                </tbody>
              </table>
            </div>
          </Section>
        )}
      </Show>
      <Show when={def.trains}>
        {(trains) => (
          <Section title="Training">
            <div class="scroll-x">
              <table>
                <thead>
                  <tr>
                    <th>Unit</th>
                    <th>Cost</th>
                    <th>Course</th>
                  </tr>
                </thead>
                <tbody>
                  <For each={trains()}>
                    {(t) => (
                      <tr>
                        <td>
                          <DocLink href={unitHref(t.unit)}>{unitName(t.unit)}</DocLink>
                        </td>
                        <td>
                          <CostList amounts={t.cost} />
                        </td>
                        <td>{fmtSecs(t.durationTicks)}</td>
                      </tr>
                    )}
                  </For>
                </tbody>
              </table>
            </div>
          </Section>
        )}
      </Show>
      <Show when={def.garrison}>
        {(g) => (
          <Section title="Garrison">
            <Stats>
              <Stat label="Holds">
                up to {g().capacity}{' '}
                <DocLink href={unitHref(g().unit)}>{unitName(g().unit)}s</DocLink>
              </Stat>
              <Stat label="From the wall">
                ×{g().damageMult} damage, +{g().rangeBonus} tiles of range
              </Stat>
              <Stat label="Levy">
                {unitName(g().levy.unit)}s hold it until soldiers arrive: {g().levy.damage} damage
                every {fmtSecs(g().levy.cooldownTicks)}, range {g().levy.range}
              </Stat>
            </Stats>
          </Section>
        )}
      </Show>
      <Show when={gates.length > 0}>
        <Section title="Unlocked by">
          <ul class="refs">
            <For each={gates}>
              {(tech) => (
                <li>
                  Needs <DocLink href={techHref(tech)}>{techName(tech)}</DocLink> researched
                  {gates.length > 1 ? ' (any one suffices)' : ''}
                </li>
              )}
            </For>
          </ul>
        </Section>
      </Show>
      <Show when={def.systemOnly}>
        <Section title="Placement">
          <p class="lede">
            Never offered on the build ribbon —{' '}
            {def.isRoad ? 'the Masonry road pass places it' : 'the world places it'}.
          </p>
        </Section>
      </Show>
    </>
  );
}
