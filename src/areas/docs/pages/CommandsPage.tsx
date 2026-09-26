import {For, type JSX} from 'solid-js';
import type {Enum} from '../../../shared/enum.ts';
import {BUILDING_DEFS, BUILDING_TYPES} from '../../../sim/defs/buildings';
import * as BuildingTypeId from '../../../sim/defs/buildingTypeIdEnum.ts';
import {type UnitTypeId, UNIT_TYPES} from '../../../sim/defs/units';
import {BUILD_KEYS} from '../../../ui/buildMenu';
import {
  HIRE_KEY,
  RALLY_KEY,
  RESEARCH_KEY,
  TRAIN_KEYS,
} from '../../../ui/commands';
import {buildingName, unitName} from '../../../ui/names';
import {
  ADMIN_ACTION_NAMES,
  ADMIN_DOCS,
  COMMAND_DOCS,
  COMMAND_KIND_NAMES,
} from '../commandsDoc';
import {DocLink, Section} from '../components';
import {TRAINED_AT} from '../data';
import {Prose} from '../prose';
import {buildingHref, unitHref} from '../routes';

type BuildingTypeId = Enum<typeof BuildingTypeId>;

export function CommandsPage(): JSX.Element {
  const buildKeys = BUILDING_TYPES.flatMap((b): [BuildingTypeId, string][] =>
    BUILD_KEYS[b] === undefined ? [] : [[b, BUILD_KEYS[b]]],
  );
  // Where each recruit drills is read off the defs rather than written out:
  // the bow moved from the barracks to its own range once, and a
  // hard-coded column said otherwise.
  const trainKeys = UNIT_TYPES.flatMap(
    (u): [UnitTypeId, string, BuildingTypeId][] => {
      const at = TRAINED_AT.get(u);
      const key = TRAIN_KEYS[u];
      return at === undefined || key === undefined
        ? []
        : [[u, key, at.building]];
    },
  );
  // The type-level half of canRally: any building that trains takes a flag.
  const rallyAt = BUILDING_TYPES.filter(
    b => BUILDING_DEFS[b].trains !== undefined,
  );
  return (
    <>
      <h1>Commands</h1>
      <p class="lede">
        Every order the sim takes. The list is the same whether it comes from a
        click, a hotkey, the AI or the far end of a multiplayer socket. The sim
        revalidates everything; the UI’s checks are advisory.
      </p>
      <Section title="Orders">
        <div class="scroll-x">
          <table>
            <thead>
              <tr>
                <th>Command</th>
                <th>What it does</th>
                <th>Payload</th>
              </tr>
            </thead>
            <tbody>
              <For each={Object.entries(COMMAND_DOCS)}>
                {([kind, doc]) => (
                  <tr>
                    <td>
                      <code>{COMMAND_KIND_NAMES.get(Number(kind))}</code>
                      <div class="row-note">kind {kind}</div>
                    </td>
                    <td>
                      <Prose text={doc.summary} />
                    </td>
                    <td>{doc.payload}</td>
                  </tr>
                )}
              </For>
            </tbody>
          </table>
        </div>
      </Section>
      <Section title="Admin actions">
        <div class="scroll-x">
          <table>
            <thead>
              <tr>
                <th>Action</th>
                <th>What it does</th>
              </tr>
            </thead>
            <tbody>
              <For each={Object.entries(ADMIN_DOCS)}>
                {([action, desc]) => (
                  <tr>
                    <td>
                      <code>{ADMIN_ACTION_NAMES.get(Number(action))}</code>
                      <div class="row-note">action {action}</div>
                    </td>
                    <td>
                      <Prose text={desc} />
                    </td>
                  </tr>
                )}
              </For>
            </tbody>
          </table>
        </div>
      </Section>
      <Section title="Build chord">
        <p class="lede">
          Press <b>B</b>, then the building’s letter. It is the same letter the
          ribbon bolds in its name. The ribbon turns to that building’s tab
          either way: if the research is missing, nothing is armed, but the
          button is in front of you with the lock on it. Short stores stop
          nothing. Everything is built on credit, and the cost under the button
          is what finishes the building, not what you must be holding to peg it
          out.
        </p>
        <div class="scroll-x">
          <table>
            <thead>
              <tr>
                <th>Key</th>
                <th>Building</th>
              </tr>
            </thead>
            <tbody>
              <For each={buildKeys}>
                {([building, key]) => (
                  <tr>
                    <td>
                      <b>B</b> → <b>{key}</b>
                    </td>
                    <td>
                      <BuildingLink building={building} />
                    </td>
                  </tr>
                )}
              </For>
            </tbody>
          </table>
        </div>
      </Section>
      <Section title="Selection keys">
        <div class="scroll-x">
          <table>
            <thead>
              <tr>
                <th>Key</th>
                <th>With what selected</th>
                <th>Order</th>
              </tr>
            </thead>
            <tbody>
              <For each={trainKeys}>
                {([unit, key, building]) => (
                  <tr>
                    <td>
                      <b>{key}</b>
                    </td>
                    <td>
                      <BuildingLink building={building} />
                    </td>
                    <td>
                      Train {/^[AEIOU]/.test(unitName(unit)) ? 'an' : 'a'}{' '}
                      <DocLink href={unitHref(unit)}>{unitName(unit)}</DocLink>
                    </td>
                  </tr>
                )}
              </For>
              <tr>
                <td>
                  <b>{HIRE_KEY}</b>
                </td>
                <td>
                  <BuildingLink building={BuildingTypeId.storehouse} />
                </td>
                <td>Hire a serf</td>
              </tr>
              <tr>
                <td>
                  <b>{RALLY_KEY}</b>
                </td>
                <td>
                  <For each={rallyAt}>
                    {(building, i) => (
                      <>
                        {i() > 0 && ' or '}
                        <BuildingLink building={building} />
                      </>
                    )}
                  </For>
                </td>
                <td>
                  Arm the rally flag, then plant it with the next map click
                </td>
              </tr>
              <tr>
                <td>
                  <b>{RESEARCH_KEY}</b>
                </td>
                <td>Anything</td>
                <td>Open the research tree</td>
              </tr>
            </tbody>
          </table>
        </div>
      </Section>
    </>
  );
}

function BuildingLink(props: {building: BuildingTypeId}): JSX.Element {
  return (
    <DocLink href={buildingHref(props.building)}>
      {buildingName(props.building)}
    </DocLink>
  );
}
