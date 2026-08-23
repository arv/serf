import { For, Show, type JSX } from 'solid-js';
import { goto } from '../../app/router';
import type { GoodAmounts, GoodId } from '../../sim/defs/goods';
import type { Recipe } from '../../sim/defs/buildings';
import { GoodIcon } from '../../ui/icons';
import { goodName } from '../../ui/names';
import { fmtPerMinute, fmtSecs } from './data';
import { goodHref } from './routes';

/**
 * An internal wiki link: a real <a>, so middle-click and copy-link work,
 * that hands a plain left click to the router. The handler is what makes
 * links work under the pushState fallback, which intercepts nothing; under
 * the Navigation API it is merely the same trip taken explicitly.
 */
export function DocLink(props: {
  href: string;
  class?: string;
  /** Marks the nav entry for the section being read — the gold pill says
   * so visually, and this is how that reaches a screen reader. */
  current?: boolean;
  children: JSX.Element;
}): JSX.Element {
  return (
    <a
      href={props.href}
      class={props.class}
      aria-current={props.current === true ? 'location' : undefined}
      onClick={(e) => {
        if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        e.preventDefault();
        goto(props.href);
      }}
    >
      {props.children}
    </a>
  );
}

/** One good with its icon and amount, as a chip linking to the good's page. */
export function GoodChip(props: { good: GoodId; amount?: number }): JSX.Element {
  return (
    <DocLink href={goodHref(props.good)} class="chip">
      <GoodIcon good={props.good} size={13} />
      <Show when={props.amount !== undefined}>
        <span>{props.amount}</span>
      </Show>
      <span>{goodName(props.good)}</span>
    </DocLink>
  );
}

/** A GoodAmounts as a row of chips — build costs, recipe sides, tech bills. */
export function CostList(props: { amounts: GoodAmounts; freeLabel?: string }): JSX.Element {
  const entries = () => Object.entries(props.amounts) as [GoodId, number][];
  return (
    <span class="costs">
      <Show
        when={entries().length > 0}
        fallback={<span class="chip free">{props.freeLabel ?? 'free'}</span>}
      >
        <For each={entries()}>{([good, n]) => <GoodChip good={good} amount={n} />}</For>
      </Show>
    </span>
  );
}

export function Section(props: { title: string; children: JSX.Element }): JSX.Element {
  return (
    <section>
      <h2>{props.title}</h2>
      {props.children}
    </section>
  );
}

/** The def-list card the detail pages are built from. Rows render only when
 * they have something to say, so the card is exactly as long as the def. */
export function Stats(props: { children: JSX.Element }): JSX.Element {
  return <dl class="stats">{props.children}</dl>;
}

export function Stat(props: { label: string; children: JSX.Element }): JSX.Element {
  return (
    <div>
      <dt>{props.label}</dt>
      <dd>{props.children}</dd>
    </div>
  );
}

/**
 * A recipe, spelled the way the sim runs it: inputs -> outputs, the cycle
 * time, and the ideal rate. Gather recipes name the ground they work
 * instead of an input buffer.
 */
export function RecipeView(props: { recipe: Recipe }): JSX.Element {
  const r = props.recipe;
  if (r.kind === 'gather') {
    return (
      <span>
        works <b>{r.resource}</b> tiles within {r.radius} → <GoodChip good={r.output} amount={1} />{' '}
        · {fmtSecs(r.workTicks)} each · {fmtPerMinute(1, r.workTicks)}
      </span>
    );
  }
  const outputs = Object.entries(r.outputs) as [GoodId, number][];
  return (
    <span>
      <CostList amounts={r.inputs} freeLabel="nothing" /> → <CostList amounts={r.outputs} /> ·{' '}
      {fmtSecs(r.durationTicks)}
      <For each={outputs}>
        {([good, n]) => (
          <span>
            {' '}
            · {fmtPerMinute(n, r.durationTicks)} {goodName(good).toLowerCase()}
          </span>
        )}
      </For>
    </span>
  );
}
