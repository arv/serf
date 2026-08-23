import { type JSX } from 'solid-js';
import { DocLink } from './components';
import { linkifyProse } from './linkify';

/**
 * Prose with the things it names turned into links — see linkify.ts for
 * which words count and why. `self` is the page being read, so a
 * description never links to itself.
 */
export function Prose(props: { text: string; self?: string }): JSX.Element {
  return (
    <>
      {linkifyProse(props.text, props.self).map((p) =>
        typeof p === 'string' ? p : <DocLink href={p.href}>{p.text}</DocLink>,
      )}
    </>
  );
}
