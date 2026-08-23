import { For, type JSX } from 'solid-js';
import { GOODS } from '../../../sim/defs/goods';
import { GoodIcon } from '../../../ui/icons';
import { goodName } from '../../../ui/names';
import { GOOD_DESC } from '../descriptions';
import { DocLink } from '../components';
import { Prose } from '../prose';
import { goodHref } from '../routes';

export function GoodsPage(): JSX.Element {
  return (
    <>
      <h1>Goods</h1>
      <p class="lede">
        <Prose text="Everything a serf can carry, in the order the game counts them. Each one links to who makes it and who takes it." />
      </p>
      <div class="tiles">
        <For each={[...GOODS]}>
          {(good) => (
            <DocLink href={goodHref(good)} class="tile">
              <GoodIcon good={good} size={28} decorative />
              <span class="t-name">{goodName(good)}</span>
              <span class="t-sub">{GOOD_DESC[good]}</span>
            </DocLink>
          )}
        </For>
      </div>
    </>
  );
}
