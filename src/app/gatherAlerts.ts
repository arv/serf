import type {BuildingSnap} from '../protocol/messages';
import * as BuildingState from '../sim/buildingStateEnum.ts';
import {buildingDef, gatherRecipeOf} from '../sim/defs/buildings';
import type {EntityId, Owner} from '../sim/entities.ts';
import * as TileResource from '../sim/tileResourceEnum.ts';
import {buildingName} from '../ui/names';

/**
 * The same building may announce trouble again this often. A quarry that
 * goes quiet stays quiet — the notice is about the moment it turns, not
 * about the silence after — so this only ever catches a hut flapping
 * across the line (a felled tile opening a way through, a grove growing
 * back into reach) and keeps it from nagging.
 */
const RETOAST_MS = 60_000;

/**
 * What a gatherer's ground has done to it. Two states, because they ask
 * the player for opposite moves — the same distinction the building card
 * already draws (ui/SelectionPanel.tsx reachTip).
 */
type Trouble = 'spent' | 'walledIn';

interface Watched {
  trouble: Trouble | null;
  /** When this hut last said something, for the cooldown. -Infinity is
   * "never", and it has to be: the clock this is measured against starts
   * at zero on a freshly loaded page (performance.now), so a zero here
   * would put the first notice of the match inside its own cooldown. */
  toastedAt: number;
}

/**
 * Notices for the one way a village starves without anything looking
 * wrong: a woodcutter, quarry or mine whose ground has run out from under
 * it, or whose last loads have been walled in by the grove that grew
 * around them.
 *
 * Both were already knowable — the card reports them the moment you select
 * the hut (`resourceLeft` / `resourceBlocked`, snapshot.ts reachStock) —
 * and that is exactly the problem: nothing carries the news to a player
 * who is looking somewhere else. The hut keeps its worker and its tool,
 * draws as a working building, and raises no shortage of its own; what
 * shows up, minutes later and half a village away, is construction sites
 * stalled at three quarters with a builder standing at them, because the
 * stone they are owed has no source any more.
 *
 * Client-side and derived: the numbers ride the roster already, so this
 * watches them across updates rather than adding anything to the sim. The
 * deterministic tick is untouched, and a replay of an older match raises
 * the same notices watching it that the live match did.
 */
export class GatherAlerts {
  #toast: (text: string, focus?: {x: number; y: number}) => void;
  #now: () => number;
  #watched = new Map<EntityId, Watched>();
  #viewer: Owner | undefined;

  constructor(opts: {
    toast: (text: string, focus?: {x: number; y: number}) => void;
    /** Injected for the tests; the clock is only ever used for the
     * re-notice cooldown. */
    now?: () => number;
  }) {
    this.#toast = opts.toast;
    this.#now = opts.now ?? (() => performance.now());
  }

  /**
   * Read the roster the frame just applied. Every gatherer the viewing
   * seat owns is measured against how it stood last time, and only a
   * building that CROSSED into trouble says so — a hut first seen already
   * spent (a loaded save, a replay joined in the middle, the frame a
   * match opens on) is recorded silently, because a notice is news and
   * that is history.
   */
  update(roster: readonly BuildingSnap[], viewer: Owner): void {
    // A different seat is a different village: the HUD can turn to any of
    // them in a replay (ui/store.ts viewerId), and what the last one's
    // quarries were doing says nothing about this one's.
    if (viewer !== this.#viewer) {
      this.#viewer = viewer;
      this.#watched.clear();
    }
    const now = this.#now();
    const present = new Set<EntityId>();
    for (const b of roster) {
      if (b.owner !== viewer || b.state !== BuildingState.built) continue;
      // Present only for the buildings that work the land, which is the
      // cheapest way to ask whether this is one of them.
      if (b.resourceLeft === undefined) continue;
      present.add(b.id);
      // A halted hut is not measured at all — its ground is not why it is
      // quiet, and the player who pulled the lever does not need telling.
      // Left as it stood rather than reset, so flipping the lever back on
      // over unchanged ground is not itself news.
      if (b.paused) continue;
      const trouble: Trouble | null =
        b.resourceLeft > 0
          ? null
          : (b.resourceBlocked ?? 0) > 0
            ? 'walledIn'
            : 'spent';
      const was = this.#watched.get(b.id);
      if (was === undefined) {
        this.#watched.set(b.id, {trouble, toastedAt: -Infinity});
        continue;
      }
      const turned = trouble !== null && trouble !== was.trouble;
      const quiet = now - was.toastedAt < RETOAST_MS;
      // The state is recorded whether or not it was announced: a notice
      // the cooldown swallowed must not be re-armed to fire later over
      // ground that never changed again.
      this.#watched.set(b.id, {
        trouble,
        toastedAt: turned && !quiet ? now : was.toastedAt,
      });
      if (turned && !quiet) this.#say(b, trouble);
    }
    // A hut that is gone — razed, sold, or out of this seat's sight — takes
    // its history with it, so the ground a rebuilt one stands on is read
    // fresh rather than against whatever stood there before.
    for (const id of this.#watched.keys()) {
      if (!present.has(id)) this.#watched.delete(id);
    }
  }

  #say(b: BuildingSnap, trouble: Trouble): void {
    const name = buildingName(b.type);
    const focus = {x: b.x, y: b.y};
    if (trouble === 'walledIn') {
      const shut = b.resourceBlocked ?? 0;
      this.#toast(
        `${name} is walled in. ${shut} load${shut === 1 ? '' : 's'} in its square with no way to walk to any of it.`,
        focus,
      );
      return;
    }
    // Trees are the one resource that comes back, so the worked-out
    // woodcutter is told it is finished HERE rather than finished.
    const renews =
      gatherRecipeOf(buildingDef(b.type))?.resource === TileResource.Wood;
    this.#toast(
      renews
        ? `${name} has felled everything in reach.`
        : `${name} has worked out its ground. Nothing left in reach.`,
      focus,
    );
  }

  /** Drop every watch: the match is over, or the seat being watched has
   * fallen and there is nothing left to manage. The next update starts
   * from a clean baseline, as it does on a fresh match. */
  clear(): void {
    this.#watched.clear();
    this.#viewer = undefined;
  }
}
