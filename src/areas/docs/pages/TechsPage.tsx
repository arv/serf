import { For, Show, type JSX } from 'solid-js';
import { TECH_BRANCHES, TECH_DEFS, type TechEffect } from '../../../sim/defs/techs';
import { buildingName, unitName } from '../../../ui/names';
import { ALL_TECHS, fmtSecs } from '../data';
import { CostList, DocLink } from '../components';
import { Prose } from '../prose';
import { buildingHref, techHref, unitHref } from '../routes';
import { ModifierKey } from '../../../sim/defs/techs';
import { TechBranch } from '../../../sim/defs/techs';
import { TechEffectKind } from '../../../sim/defs/techs';

const BRANCH_LABEL: Record<TechBranch, string> = {
  [TechBranch.agriculture]: 'Agriculture',
  [TechBranch.craft]: 'Craft',
  [TechBranch.warfare]: 'Warfare',
};

/** What each modifier key moves, in words. Total, so a new modifier cannot
 * ship showing its def key to the reader. */
const MODIFIER_LABEL: Record<ModifierKey, string> = {
  [ModifierKey.farmSpeed]: 'Farms work',
  [ModifierKey.foodSpeed]: 'The mill and the bakery work',
  [ModifierKey.forgeSpeed]: 'The Smith works',
  [ModifierKey.mineSpeed]: 'Mines work',
  [ModifierKey.serfSpeed]: 'Serfs and workers walk',
  [ModifierKey.workSpeed]: 'Everyone works',
  [ModifierKey.militaryHp]: 'Soldiers train with hit points',
};

function EffectLine(props: { effect: TechEffect; self: string }): JSX.Element {
  const e = props.effect;
  switch (e.kind) {
    case TechEffectKind.unlockBuilding:
      return (
        <>
          Unlocks the{' '}
          <DocLink href={buildingHref(e.building)}>{buildingName(e.building)}</DocLink>
        </>
      );
    case TechEffectKind.unlockUnit:
      return (
        <>
          Unlocks the <DocLink href={unitHref(e.unit)}>{unitName(e.unit)}</DocLink>
        </>
      );
    case TechEffectKind.modifier:
      return (
        <>
          <Prose text={MODIFIER_LABEL[e.key]} self={props.self} /> ×{e.multiplier}
        </>
      );
    case TechEffectKind.unlockPaving:
      return <Prose text="Trails pave into stone roads" self={props.self} />;
  }
}

export function TechsPage(): JSX.Element {
  return (
    <>
      <h1>Research</h1>
      <p class="lede">
        <Prose text="Studied at the Abbey, paid in goods and time. Three branches; a tech waits on its prerequisites and nothing else." />
      </p>
      <For each={TECH_BRANCHES}>
        {(branch) => (
          <section>
            <h2>{BRANCH_LABEL[branch]}</h2>
            <For each={ALL_TECHS.filter((id) => TECH_DEFS[id].branch === branch)}>
              {(id) => {
                const def = TECH_DEFS[id];
                return (
                  <article class="tech" id={`tech-${id}`}>
                    <div class="t-head">
                      <span class="name">{def.name}</span>
                      <span class="meta">{fmtSecs(def.durationTicks)}</span>
                      <CostList amounts={def.cost} />
                    </div>
                    <p>
                      <Prose text={def.desc} self={techHref(id)} />
                    </p>
                    <Show when={def.prereqs.length > 0}>
                      <p>
                        Needs{' '}
                        <For each={def.prereqs}>
                          {(pre, i) => (
                            <>
                              {i() > 0 && ', '}
                              <a href={`#tech-${pre}`}>{TECH_DEFS[pre].name}</a>
                            </>
                          )}
                        </For>
                      </p>
                    </Show>
                    <Show when={def.effects.length > 0}>
                      <p>
                        <For each={def.effects}>
                          {(effect, i) => (
                            <>
                              {i() > 0 && ' · '}
                              <EffectLine effect={effect} self={techHref(id)} />
                            </>
                          )}
                        </For>
                      </p>
                    </Show>
                  </article>
                );
              }}
            </For>
          </section>
        )}
      </For>
    </>
  );
}
