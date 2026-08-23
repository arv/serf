import { Show, createEffect, createSignal, onCleanup, onMount, type JSX } from 'solid-js';
import type { AnimKey } from '../../../render/characters';
import type { BuildingTypeId } from '../../../sim/defs/buildings';
import type { UnitTypeId } from '../../../sim/defs/units';
import { registerCard, type CardHandle } from './hub';

/**
 * A live 3D preview of a building or unit, rendered from the game's own
 * models through the shared preview hub. While the models load the stage
 * shimmers at its final size (no reflow when the shot lands); if WebGL or
 * the fetch is refused, a drawn silhouette stands in and the page stays a
 * page.
 */

interface CommonProps {
  animated?: boolean;
  interactive?: boolean;
}

type ModelCardProps =
  | (CommonProps & { kind: 'building'; id: BuildingTypeId })
  | (CommonProps & { kind: 'unit'; id: UnitTypeId; anim?: AnimKey });

/** Hand-drawn monochrome stand-ins (never emoji — house rule). */
function SilhouetteIcon(props: { kind: 'building' | 'unit' }): JSX.Element {
  return (
    <svg width="42" height="42" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6">
      {props.kind === 'building' ? (
        <>
          <path d="M4 20v-8l8-7 8 7v8" />
          <path d="M4 20h16" />
          <path d="M10 20v-5h4v5" />
        </>
      ) : (
        <>
          <circle cx="12" cy="6.5" r="2.8" />
          <path d="M6.5 20c0-4 2.2-6.5 5.5-6.5s5.5 2.5 5.5 6.5" />
        </>
      )}
    </svg>
  );
}

/** Cheap per-card variation so a row of idle loops doesn't tick in unison. */
function seedFrom(id: string): number {
  let n = 0;
  for (let i = 0; i < id.length; i++) n = (n * 31 + id.charCodeAt(i)) % 997;
  return n / 997;
}

export function ModelCard(props: ModelCardProps): JSX.Element {
  const [state, setState] = createSignal<'loading' | 'ready' | 'fallback'>('loading');
  let stage!: HTMLDivElement;
  let canvas!: HTMLCanvasElement;
  let handle: CardHandle | undefined;

  onMount(() => {
    handle = registerCard({
      stage,
      canvas,
      kind: props.kind,
      id: props.id,
      animated: props.animated === true,
      interactive: props.interactive === true,
      seed: seedFrom(props.id),
      onState: setState,
    });
  });
  onCleanup(() => handle?.dispose());

  // Reads through `state` so it re-runs once the models land, not only
  // when the reader picks a different clip.
  createEffect(() => {
    const anim = props.kind === 'unit' ? props.anim : undefined;
    if (anim !== undefined && state() === 'ready') handle?.setAnim(anim);
  });

  return (
    <div
      ref={stage}
      class="stage"
      classList={{ loading: state() === 'loading', grabbable: props.interactive === true }}
    >
      <canvas ref={canvas} />
      <Show when={state() === 'fallback'}>
        <div class="fallback">
          <SilhouetteIcon kind={props.kind} />
        </div>
      </Show>
    </div>
  );
}
