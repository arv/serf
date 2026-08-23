import { For, type JSX } from 'solid-js';
import { BUILD_KEYS } from '../../../ui/buildMenu';
import { HIRE_KEY, RALLY_KEY, RESEARCH_KEY, TRAIN_KEYS } from '../../../ui/commands';
import type { BuildingTypeId } from '../../../sim/defs/buildings';
import type { UnitTypeId } from '../../../sim/defs/units';
import { buildingName, unitName } from '../../../ui/names';
import { ADMIN_DOCS, COMMAND_DOCS } from '../commandsDoc';
import { DocLink, Section } from '../components';
import { Prose } from '../prose';
import { buildingHref, unitHref } from '../routes';

export function CommandsPage(): JSX.Element {
  const buildKeys = Object.entries(BUILD_KEYS) as [BuildingTypeId, string][];
  const trainKeys = Object.entries(TRAIN_KEYS) as [UnitTypeId, string][];
  return (
    <>
      <h1>Commands</h1>
      <p class="lede">
        Every order the sim takes — the same list whether it comes from a click, a hotkey, the
        AI or the far end of a multiplayer socket. The sim revalidates everything; the UI’s
        checks are advisory.
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
                      <code>{kind}</code>
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
                      <code>{action}</code>
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
          Press <b>B</b>, then the building’s letter — the same letter the ribbon bolds in its
          name.
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
                      <DocLink href={buildingHref(building)}>{buildingName(building)}</DocLink>
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
                {([unit, key]) => (
                  <tr>
                    <td>
                      <b>{key}</b>
                    </td>
                    <td>Barracks</td>
                    <td>
                      Train a <DocLink href={unitHref(unit)}>{unitName(unit)}</DocLink>
                    </td>
                  </tr>
                )}
              </For>
              <tr>
                <td>
                  <b>{HIRE_KEY}</b>
                </td>
                <td>Castle</td>
                <td>Hire a serf</td>
              </tr>
              <tr>
                <td>
                  <b>{RALLY_KEY}</b>
                </td>
                <td>Barracks</td>
                <td>Arm the rally flag — the next map click plants it</td>
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
