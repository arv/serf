import {Show, createEffect, createSignal, onCleanup, onMount} from 'solid-js';
import {render} from 'solid-js/web';
import {volumeToGain} from '../audio/settings';
import {
  releaseTheme,
  setThemeGain,
  setThemeHidden,
  startTheme,
  stopTheme,
} from '../audio/theme';
import {
  relayUrl,
  runLobby,
  type CouncilRequest,
  type LobbyResult,
} from '../net/lobbyClient';
import type {CouncilHooks} from './councilTypes';
import {Signpost} from './signpost/Signpost';
import {muted, volume} from './store';

/**
 * The pre-boot shell. The start screen is a signpost in front of the valley
 * (signpost/Signpost.tsx), and the War Council is the front of its
 * Multiplayer arrow — walking into a room, backing out of it and beginning
 * the match all happen without a navigation, so the valley keeps drifting
 * throughout.
 *
 * The shell owns what must outlive a room: the #menu root, the lobby's
 * socket, the theme music and the address bar. The signpost owns its canvas
 * and scene.
 *
 * The last of those matters more than it looks. The URL is what a reload
 * comes back to — a phone that loses its GPU process mid-match reloads
 * itself (see main.ts) — so the room code goes into it as soon as the relay
 * names it, and comes back out when the player leaves.
 */

export interface MenuHost {
  /** The match has begun and the menu is already torn down: the signpost's
   * WebGL context is released and the canvas is gone, so the caller is free
   * to take one of its own. */
  onBegin(lobby: LobbyResult): void;
  /** The relay refused, or could not be reached. */
  onError(message: string): void;
}

/** Where the shell opens: the start screen, or straight into a room (an
 * invite link, or a reload mid-lobby). */
export type MenuEntry = CouncilRequest | null;

/**
 * Write the room into the address bar, or take it back out — leaving every
 * other parameter where it is. What a reload comes back on is this URL, and
 * ?relay= is part of how it finds its way home: dropping it would send the
 * next connection to a different server than the one this room lives on.
 * The dev switches (?zoom=, ?wardrobe=) survive for the same reason.
 */
function setRoomInUrl(code: string | null): void {
  const params = new URLSearchParams(location.search);
  if (code === null) {
    params.delete('mp');
    // Visibility is a property of creating a room, not of being in one.
    params.delete('open');
  } else {
    params.set('mp', code);
  }
  const query = params.toString();
  history.replaceState(null, '', query ? `?${query}` : location.pathname);
}

function MenuApp(props: {entry: MenuEntry; host: MenuHost}) {
  const [council, setCouncil] = createSignal<CouncilRequest | null>(
    props.entry,
  );
  // Set by runLobby the moment it has something to show. A stashed rejoin
  // never presents, which is what keeps a mid-match reload from flashing
  // the lobby — and, below, from paying for a backdrop it will not use.
  const [hooks, setHooks] = createSignal<CouncilHooks | null>(null);
  /** Is the menu actually on the glass? */
  const showing = (): boolean => council() === null || hooks() !== null;
  // The signpost stays up once it has been: a room has no hooks for a beat
  // while its socket opens, and taking the scene down for that beat would
  // throw the valley away with it.
  const [seen, setSeen] = createSignal(false);

  // Whether we own a history entry to pop. Entering the council from the
  // start screen pushes one so the phone's back gesture backs out of the
  // room; arriving on an invite link does not, and there Back leaves.
  let pushed = false;

  const enterCouncil = (req: CouncilRequest): void => {
    // Pushed with the URL unchanged: the room has no code yet, and the
    // effect below writes the real one in as soon as the relay says it.
    history.pushState(null, '', location.pathname + location.search);
    pushed = true;
    setCouncil(req);
  };

  const leaveCouncil = (): void => {
    setCouncil(null);
    setHooks(null);
    if (pushed) {
      // Drop our entry rather than replacing it, so Back from the start
      // screen still leaves the way it did before the room was entered.
      pushed = false;
      history.back();
    } else {
      setRoomInUrl(null);
    }
  };

  // The back gesture in a room means the same thing the button does. The
  // browser has already popped the entry, so this only has to close the
  // socket and put the start screen up.
  const onPop = (): void => {
    if (council() === null) return;
    pushed = false;
    const live = hooks();
    if (live) live.onLeave();
    else leaveCouncil();
  };
  window.addEventListener('popstate', onPop);
  onCleanup(() => window.removeEventListener('popstate', onPop));

  // The address bar follows the room: a reload — or the GPU-loss reload the
  // match arms — comes back to the same seat, and it is the same link the
  // Invite button hands out.
  createEffect(() => {
    const code = hooks()?.view().code;
    if (code) setRoomInUrl(code);
  });

  const root = document.getElementById('menu')!;
  // Seeded, not just subscribed: a menu can be raised in a tab that is
  // already hidden — opened in the background, or restored into one — and
  // no visibilitychange would follow to say so. Ahead of the effect below,
  // so the first startTheme already knows whether anyone is listening.
  const onVisibility = (): void => setThemeHidden(document.hidden);
  onVisibility();
  document.addEventListener('visibilitychange', onVisibility);

  createEffect(() => {
    const on = showing();
    root.style.display = on || seen() ? 'block' : 'none';
    if (on) {
      setSeen(true);
      startTheme();
    } else {
      // A silent rejoin shows no menu, so it should play none of its music.
      stopTheme();
    }
  });
  // The same volume and mute the cues use; the trim lives in theme.ts.
  createEffect(() => {
    setThemeGain(muted() ? 0 : volumeToGain(volume()));
  });
  // The single-player launch is a navigation, and a page parked in the
  // back/forward cache holding the theme's stream still holds it. Give it
  // back on the way out (the signpost does the same with its WebGL context)
  // and start it again on a restored page.
  const onHide = (): void => releaseTheme();
  const onShow = (e: PageTransitionEvent): void => {
    if (e.persisted && showing()) {
      // A restore is a second mount for the theme, so it needs the same
      // seeding: the tab it comes back into may not be the one it left.
      onVisibility();
      startTheme();
    }
  };
  window.addEventListener('pagehide', onHide);
  window.addEventListener('pageshow', onShow);

  onCleanup(() => {
    window.removeEventListener('pagehide', onHide);
    window.removeEventListener('pageshow', onShow);
    document.removeEventListener('visibilitychange', onVisibility);
    releaseTheme();
    root.style.display = 'none';
  });

  return (
    <>
      <Show when={seen()}>
        <Signpost
          council={council()}
          hooks={hooks}
          onCouncil={enterCouncil}
          onLeaveCouncil={leaveCouncil}
        />
      </Show>
      <Show when={council()} keyed>
        {req => (
          <Council
            req={req}
            host={props.host}
            present={setHooks}
            onLeave={leaveCouncil}
          />
        )}
      </Show>
    </>
  );
}

/**
 * One visit to a room: the socket, with nothing on screen of its own — the
 * signpost shows the council from the hooks it presents. Mounting opens the
 * socket; unmounting can only happen after the lobby has let go of it (the
 * match began, the player left, or the relay refused), so there is nothing
 * to close here.
 */
function Council(props: {
  req: CouncilRequest;
  host: MenuHost;
  present(hooks: CouncilHooks | null): void;
  onLeave(): void;
}) {
  onMount(() => {
    void runLobby(relayUrl(location.search), props.req, {
      present(hooks) {
        props.present(hooks);
        return () => props.present(null);
      },
      onLeave: () => props.onLeave(),
    }).then(
      lobby => {
        // The shell goes first: the match needs the canvas, the context and
        // the pointer events the menu is holding.
        unmountMenu();
        props.host.onBegin(lobby);
      },
      (err: unknown) =>
        props.host.onError(err instanceof Error ? err.message : String(err)),
    );
  });

  return null;
}

let dispose: (() => void) | null = null;

/** Put the menu up. `entry` is null for the start screen, or the room to
 * sit down in when the URL already names one. */
export function mountMenu(entry: MenuEntry, host: MenuHost): void {
  const root = document.getElementById('menu')!;
  dispose = render(() => <MenuApp entry={entry} host={host} />, root);
}

/** Take it down, releasing the signpost's WebGL context with it. */
export function unmountMenu(): void {
  dispose?.();
  dispose = null;
}
