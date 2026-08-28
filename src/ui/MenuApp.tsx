import {Show, createEffect, createSignal, onCleanup, onMount} from 'solid-js';
import {render} from 'solid-js/web';
import {
  relayUrl,
  runLobby,
  type CouncilRequest,
  type LobbyResult,
} from '../net/lobbyClient';
import {releaseMenuBackdrop, startMenuBackdrop} from './menuBackdrop';
import {MENU_STYLE} from './menuChrome';
import {StartMenu, rememberedMode, type StartState} from './StartMenu';
import {WarCouncil, type CouncilHooks} from './WarCouncil';

/**
 * The pre-boot shell: one page, two screens. The start screen and the War
 * Council are cards swapped in front of the same live backdrop — walking
 * into a room, backing out of it and beginning the match all happen without
 * a navigation, so the valley behind the glass keeps drifting throughout.
 *
 * The shell owns the three things that must outlive a screen: the #menu
 * root, the backdrop's canvas and renderer, and the address bar. Screens
 * own their own card and nothing else.
 *
 * The last of those matters more than it looks. The URL is what a reload
 * comes back to — a phone that loses its GPU process mid-match reloads
 * itself (see main.ts) — so the room code goes into it as soon as the relay
 * names it, and comes back out when the player leaves.
 */

export interface MenuHost {
  /** The match has begun and the menu is already torn down: the backdrop's
   * WebGL context is released and the canvas is gone, so the caller is free
   * to take one of its own. */
  onBegin(lobby: LobbyResult): void;
  /** The relay refused, or could not be reached. */
  onError(message: string): void;
}

/** Where the shell opens: the start screen, or straight into a room (an
 * invite link, or a reload mid-lobby). */
export type MenuEntry = CouncilRequest | null;

/** The start-screen pane a room belongs to: hosting one came from Host,
 * everything else from the room browser. */
function paneFor(req: CouncilRequest | null): StartState | null {
  return req === null
    ? null
    : {mode: 'multi', mp: req.mp === 'new' ? 'host' : 'join'};
}

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
  // Which pane the start screen wears when it appears. Backing out of a
  // room means backing out to the pane that room came from — including for
  // someone who arrived on an invite link and never saw the menu, who
  // belongs in the browser next to the room they just declined.
  const [resume, setResume] = createSignal<StartState>(
    paneFor(props.entry) ?? {mode: rememberedMode(), mp: 'host'},
  );

  /** Is either screen actually on the glass? */
  const showing = (): boolean => council() === null || hooks() !== null;

  // Whether we own a history entry to pop. Entering the council from the
  // start screen pushes one so the phone's back gesture backs out of the
  // room; arriving on an invite link does not, and there Back leaves.
  let pushed = false;

  const enterCouncil = (req: CouncilRequest): void => {
    setResume(paneFor(req)!);
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

  // The live backdrop (menuBackdrop.ts) on its own canvas, over the game's
  // and under the grade layers. Started once, on the first screen that
  // actually appears — a silent rejoin shows nothing and must not pay for a
  // world it will throw away a moment later. Failure is cosmetic: the veils
  // alone still look deliberate.
  const root = document.getElementById('menu')!;
  let canvas: HTMLCanvasElement | null = null;
  const raise = (): void => {
    if (canvas) return;
    canvas = document.createElement('canvas');
    canvas.id = 'menu-canvas';
    document
      .getElementById('canvas')!
      .insertAdjacentElement('afterend', canvas);
    void startMenuBackdrop(canvas).catch((err: unknown) => {
      console.warn('[menu] no live backdrop:', err);
    });
  };
  const drop = (): void => {
    releaseMenuBackdrop();
    canvas?.remove();
    canvas = null;
  };
  createEffect(() => {
    const on = showing();
    root.style.display = on ? 'block' : 'none';
    if (on) raise();
  });

  // A page that leaves while holding a context can be parked in the
  // back/forward cache still holding it, and the single-player launch is a
  // navigation — so the match on the far side would be asking a phone for a
  // second context. Hand this one back on the way out, and build a fresh one
  // if the player comes back to a restored page.
  const onHide = (): void => drop();
  const onShow = (e: PageTransitionEvent): void => {
    if (e.persisted && showing()) raise();
  };
  window.addEventListener('pagehide', onHide);
  window.addEventListener('pageshow', onShow);

  onCleanup(() => {
    window.removeEventListener('pagehide', onHide);
    window.removeEventListener('pageshow', onShow);
    drop();
    root.style.display = 'none';
  });

  return (
    <>
      <style>{MENU_STYLE}</style>
      {/* Fixed and outside the screens: the veils belong to the background,
          and swapping the card in front of them must not blink. */}
      <div class="veil-a" />
      <div class="veil-b" />
      <Show
        when={council()}
        keyed
        fallback={<StartMenu start={resume()} onCouncil={enterCouncil} />}
      >
        {req => (
          <Council
            req={req}
            host={props.host}
            hooks={hooks}
            present={setHooks}
            onLeave={leaveCouncil}
          />
        )}
      </Show>
    </>
  );
}

/**
 * One visit to a room. Mounting opens the socket; unmounting can only
 * happen after the lobby has let go of it (the match began, the player
 * left, or the relay refused), so there is nothing to close here.
 */
function Council(props: {
  req: CouncilRequest;
  host: MenuHost;
  hooks: () => CouncilHooks | null;
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

  // Keyed on the hooks object, not merely on its presence: a stale rejoin
  // falls back to knocking on a fresh socket, and the council that comes
  // back is a different room with a different view behind it.
  return (
    <Show when={props.hooks()} keyed>
      {hooks => <WarCouncil {...hooks} />}
    </Show>
  );
}

let dispose: (() => void) | null = null;

/** Put the menu up. `entry` is null for the start screen, or the room to
 * sit down in when the URL already names one. */
export function mountMenu(entry: MenuEntry, host: MenuHost): void {
  const root = document.getElementById('menu')!;
  dispose = render(() => <MenuApp entry={entry} host={host} />, root);
}

/** Take it down, releasing the backdrop's WebGL context with it. */
export function unmountMenu(): void {
  dispose?.();
  dispose = null;
}
