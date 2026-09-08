import {createMemo, createRoot, createSignal, onCleanup} from 'solid-js';
import {describe, expect, it} from 'vitest';

/**
 * The tooltip layer draws one panel for the whole HUD, and the thing it
 * draws is a closure written somewhere else — `tip={() => <TextTip …/>}`,
 * over whatever the trigger has in scope. The building card's buttons write
 * theirs over the card's `<Show>` accessor, so the closure only means
 * anything for as long as that block stands.
 *
 * It used to be drawn as part of the LAYER, which stands for the whole
 * match. Sell the building with the pointer resting on the card (a tip is
 * up 130ms after the mouse settles, and the sale reaches the screen a
 * frame or two later) and the card's block closed while the layer's copy of
 * the closure was still live: it re-ran on that same update, read an
 * accessor whose block was gone, and Solid threw its stale-read error out
 * of the setter — out of the structural frame handler that called it. What
 * the player saw was the tower's card still on screen after the tower was
 * gone, keeping its buttons, following no further selection, for the rest
 * of the match. Reported three times, as three different bugs.
 *
 * The fix is ownership: a tip is drawn under the owner that raised its
 * trigger, so it is torn down by the same disposal that used to strand it.
 * Both halves are checked here — the rule it leans on, and that the layer
 * still uses it.
 */
describe('a tip lives no longer than what it describes', () => {
  /**
   * The rule the fix rests on, in the smallest form that shows it: a
   * computation whose scope is dropped while an update is still walking the
   * queue is skipped, even though the signal it reads is what set the update
   * going. That is what lets the trigger's own tear-down — which runs first,
   * because the trigger is what the update is removing — take the tip's
   * reads out of the update before they happen. It is a promise of Solid's
   * rather than of ours, so it is worth a test of its own: a version bump
   * that broke it would put the frozen card back with nothing else failing.
   */
  it('skips a computation whose scope was dropped earlier in the same update', () => {
    createRoot(dispose => {
      const [n, setN] = createSignal(0);
      let strayRuns = 0;
      let orphanRuns = 0;
      let dropTip: (() => void) | null = null;

      // The card. Re-running it is the building going away, and the cleanup
      // it carries is the trigger's: hide the tip that stood on it.
      createMemo(() => {
        const v = n();
        if (v === 0) onCleanup(() => dropTip?.());
        return v;
      });
      // The tip, in the scope that cleanup drops.
      createRoot(drop => {
        dropTip = drop;
        createMemo(() => {
          if (n() > 0) strayRuns++;
          return n();
        });
      });
      // The tip as the layer used to draw it: no scope of its own, and so
      // nothing the card's tear-down can reach.
      createMemo(() => {
        if (n() > 0) orphanRuns++;
        return n();
      });

      setN(1);
      expect(strayRuns).toBe(0);
      // The control: the very same read, run against a card that is no
      // longer there. In the HUD that read throws.
      expect(orphanRuns).toBe(1);
      dispose();
    });
  });

  const SOURCE = Object.values(
    import.meta.glob('./tooltip.tsx', {
      query: '?raw',
      import: 'default',
      eager: true,
    }),
  )[0] as string;

  it('draws the layer’s tip in a scope of its own', () => {
    // The layer must not call a tip's content itself: that draws it as part
    // of the layer, which is the freeze.
    expect(SOURCE).toContain('<Show when={tip()}>{t => renderTip(t())}</Show>');
    expect(SOURCE).toMatch(
      /function renderTip[\s\S]*createRoot\(dispose => \{[\s\S]*t\.content\(\)/,
    );
    expect(SOURCE).toMatch(/const owner = getOwner\(\);/);
  });

  it('takes a tip down with the trigger that raised it', () => {
    // Both the tip that is up and the one still on its timer: 130ms is long
    // enough for the building to be sold, and a tip that popped up over a
    // card that had gone read the same stale accessor on its FIRST run.
    expect(SOURCE).toMatch(
      /onCleanup\(\(\) => \{\s*if \(tip\(\)\?\.content === content \|\| pendingContent === content\)\s*hideTip\(\);/,
    );
    expect(SOURCE).toContain('if (!t.target.isConnected) return null;');
  });
});
