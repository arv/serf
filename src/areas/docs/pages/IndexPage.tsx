import type {JSX} from 'solid-js';
import {DocLink} from '../components';
import {ALL_BUILDINGS, ALL_TECHS, ALL_UNITS, GOODS} from '../data';

export function IndexPage(): JSX.Element {
  return (
    <>
      <h1>Field Guide</h1>
      <p class="lede">
        Every building, unit, good and research in Serf Valley: what it costs,
        what it makes, and what it needs first.
      </p>
      <div class="tiles">
        <DocLink href="/docs/buildings" class="tile">
          <span class="t-name">Buildings</span>
          <span class="t-sub">
            {ALL_BUILDINGS.length} roofs, from the Castle to the road
          </span>
        </DocLink>
        <DocLink href="/docs/units" class="tile">
          <span class="t-name">Units</span>
          <span class="t-sub">
            {ALL_UNITS.length} kinds, yours and the raiders’
          </span>
        </DocLink>
        <DocLink href="/docs/goods" class="tile">
          <span class="t-name">Goods</span>
          <span class="t-sub">{GOODS.length} things a serf can carry</span>
        </DocLink>
        <DocLink href="/docs/techs" class="tile">
          <span class="t-name">Research</span>
          <span class="t-sub">{ALL_TECHS.length} techs in three branches</span>
        </DocLink>
        <DocLink href="/docs/commands" class="tile">
          <span class="t-name">Commands</span>
          <span class="t-sub">Every order the sim takes, and its hotkey</span>
        </DocLink>
        <DocLink href="/docs/basics" class="tile">
          <span class="t-name">Basics</span>
          <span class="t-sub">
            Opening stock, hiring, repairs and the raid clock
          </span>
        </DocLink>
        <DocLink href="/docs/credits" class="tile">
          <span class="t-name">Credits</span>
          <span class="t-sub">
            The models, sounds and code the valley is built on
          </span>
        </DocLink>
      </div>
    </>
  );
}
