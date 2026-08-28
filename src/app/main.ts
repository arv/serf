import { initAudio } from '../audio/audio';
import { volumeToGain } from '../audio/settings';
import { muted, resetMatchState, volume } from '../ui/store';
import { REPLAY_VERSION } from '../shared/replayVersion';
import { WORLD_SAVE_VERSION, canReadSave } from '../shared/saveVersion';
import { readSaveWorldVersion, splitSave } from './saveEnvelope';
import { parseReplay, type ReplayData } from './replay';
import { readReplayFile } from './replayStore';
import { migrateLegacySave, readSaveFile } from './saveStore';
import { mountMenu, unmountMenu } from '../ui/MenuApp';
import { armFullscreen } from '../ui/fullscreen';
import { startRouter } from './router';
import { registerServiceWorker, releaseServiceWorkerUpdates } from './serviceWorker';
import { configFromUrl, type GameConfig } from './gameConfig';
import { defaultLobbyConfig, sanitizeLobbyConfig, type LobbyConfig } from '../protocol/lobby';
import type { LobbyResult } from '../net/lobbyClient';
import type { NetInfo } from '../protocol/messages';
import type { Screen } from './screen';
import { clearFatal, fatal, fatalFrom, showFatal } from './fatalScreen';
import { stashGet, stashSet } from './stash';
import { playerKindFromKey } from '../sim/player';
import * as PlayerKind from '../sim/playerKindEnum.ts';

/**
 * The app's entry point: the boot handshake, and the router that decides
 * which screen a URL names.
 *
 * What it deliberately does NOT carry is any one screen's weight. Every
 * screen arrives as its own chunk — the match (matchScreen.ts, and with it
 * three.js, the render stack and the HUD), the map editor, the field guide,
 * the wardrobe — so what a cold visit must fetch before the start menu is
 * on the glass is this file, the menu, and little else.
 */

// The sim<->render hot path runs over SharedArrayBuffer, which requires
// cross-origin isolation. Fail loudly at boot rather than mysteriously later.
if (!crossOriginIsolated) {
  fatal(
    'This page is not cross-origin isolated, so SharedArrayBuffer is unavailable. ' +
      'The server must send "Cross-Origin-Opener-Policy: same-origin" and ' +
      '"Cross-Origin-Embedder-Policy: require-corp" (vite.config.ts does this for dev).',
  );
}

/**
 * Launch parameters. Any of these means the player has already chosen a
 * game — anything else (a bare '/') gets the menu. ?mp is the exception
 * that proves it: a room is chosen, but the choosing happens in the
 * council, which is a menu screen.
 */
const LAUNCH_PARAMS = [
  'mp',
  'ai',
  'players',
  'seed',
  'size',
  'skipMenu',
  'mission',
  'replay',
  'load',
];

/**
 * A room's opening settings, from the URL a link or a reload arrived on.
 * Only ever a starting point: the host tunes them in the council, and the
 * server builds the world from its own sanitized copy.
 */
function lobbyInitFromUrl(params: URLSearchParams): LobbyConfig {
  return sanitizeLobbyConfig(defaultLobbyConfig(), {
    ai: Number(params.get('ai') ?? '0') || 0,
    bandits: params.get('bandits') !== '0',
    seed: configFromUrl(location.search).seed,
    // Nobody named an opponent on the way in; the council is where a host
    // picks one, and until then the seed deals them.
    bots: [],
  });
}

/**
 * Has a game been chosen? A pending load counts: the GPU-loss rescue
 * stashes the name of the save it just wrote and reloads, and that handoff
 * must not bounce back to the menu. (The menu's own Load goes through
 * ?load=<name>, which is a launch param like any other.)
 */
function gameChosen(params: URLSearchParams): boolean {
  return (
    LAUNCH_PARAMS.some((k) => params.has(k)) || stashGet('session', 'serf-load-pending') !== null
  );
}

/**
 * What screen a URL names. Two URLs with the same key are the same screen,
 * and routing between them does nothing — which is what lets the menu edit
 * its own address bar freely. It does that a lot: the council writes the
 * room code in as soon as the relay says it, and both pushState and
 * replaceState announce themselves as navigations.
 *
 * A match's key carries its whole query string, so one match never
 * silently stands in for another: Play again on the same seed and Continue
 * into the next mission are both real screen changes.
 */
function screenKey(): string {
  // The field guide is the one screen named by its path rather than its
  // query string — /docs is a place a link can point at. Checked ahead of
  // everything else so a stale launch param riding along in the query
  // cannot turn a docs link into a match. One constant key for the whole
  // wiki: page turns inside it are same-key navigations (onRouteChange),
  // which is what lets it keep one preview renderer and its loaded model
  // caches across twenty clicks instead of rebuilding per page.
  if (location.pathname === '/docs' || location.pathname.startsWith('/docs/')) return 'docs';
  const params = new URLSearchParams(location.search);
  // The map editor is its own screen kind — and the check comes before
  // gameChosen, because a stale load-pending handoff (or a ?seed left in
  // the URL) must not turn ?editor into a match.
  if (params.has('editor')) return 'editor';
  // The wardrobe likewise — and likewise before gameChosen, so a stray
  // launch param cannot turn the fitting room into a match. Without a key
  // of its own it read as 'menu', and routing menu <-> wardrobe in one
  // document either did nothing or stacked one screen on the other.
  if (params.has('wardrobe')) return 'wardrobe';
  const chosen = gameChosen(params);
  // A room is chosen, but the choosing happens in the council — a menu
  // screen, and the one whose URL moves under it.
  if (!chosen || params.get('mp') !== null) return 'menu';
  return `match:${location.search}`;
}

/** The key a match handed over by the council wears. Its URL says 'menu'
 * (?mp=CODE is the council's own address), so it needs one of its own or
 * the next navigation would think the room was already on the glass. */
const NET_MATCH_KEY = 'match:net';

/** What is on the page right now; see app/screen.ts. */
let current: Screen | null = null;

/**
 * Build the playing screen.
 *
 * Its module is fetched here rather than imported at the top, because it is
 * everything the menu is not: three.js, the whole render stack, the HUD and
 * the input layer. Nothing on the way to the start menu needs a byte of it,
 * and a launch URL that does need it asks one navigation later — where the
 * editor, the field guide and the wardrobe already ask for theirs.
 *
 * The signature is spelled out rather than forwarded so a drift between the
 * two halves is a type error here, at the seam, rather than a runtime
 * surprise in a screen that only some URLs build.
 */
async function runMatch(
  config: GameConfig,
  opts: { loadData?: string; fogSeed?: string; net?: NetInfo; replay?: ReplayData },
  key: string,
): Promise<Screen> {
  const { runMatch: build } = await import('./matchScreen');
  return build(config, opts, key);
}

/**
 * Which routing attempt is the live one. Building a screen is asynchronous
 * — assets, a world, sometimes a socket — and the player can navigate again
 * inside that gap: Back out of a launch, or press Quit while a replay is
 * still being read off disk. The screen that arrives late has to notice
 * that the page moved on and take itself apart, or it would mount on top of
 * whatever replaced it and leak everything it built.
 */
let generation = 0;

/**
 * Put the screen the URL names on the page, taking down whatever is there.
 * Every screen change goes through here — the menu's launch, the end
 * card's buttons, and the browser's own back gesture alike.
 */
async function route(opts: { force?: boolean } = {}): Promise<void> {
  // Whatever went wrong belongs to the screen being left behind.
  clearFatal();
  const key = screenKey();
  // The same screen asking for itself is the menu moving its own address
  // bar, and tearing it down and rebuilding it would be visible. `force`
  // is how the two genuine exceptions say so: Play again and Watch again
  // both mean "this exact screen, from the top". A screen that navigates
  // within itself still hears about the move (see Screen.onRouteChange).
  if (!opts.force && current && current.key === key) {
    current.onRouteChange?.();
    return;
  }
  const gen = ++generation;
  /** Hand a freshly built screen the page, or take it apart if the page has
   * already gone somewhere else. */
  const present = (screen: Screen): void => {
    if (gen === generation) current = screen;
    else screen.dispose();
  };
  current?.dispose();
  current = null;
  // Between screens the page owns nothing: no world, no HUD state, no
  // stock from a village that has already fallen.
  resetMatchState();

  const launchParams = new URLSearchParams(location.search);
  if (key === 'wardrobe') {
    // The costume fitting room: every unit of every faction, labeled,
    // under the real camera and sun. Render-only — no sim, no HUD.
    // Keyed off `key`, not launchParams: screenKey() gives ?editor
    // precedence, and a branch that read the params directly would mount
    // the wardrobe while recording the screen as 'editor' — breaking the
    // same-key-same-screen invariant the router leans on.
    const { mountWardrobe } = await import('../ui/wardrobe');
    const wardrobe = await mountWardrobe(document.getElementById('canvas') as HTMLCanvasElement);
    present({ key, dispose: () => wardrobe.dispose() });
    return;
  }
  if (key === 'editor') {
    // The map editor: the game's render stack over an authored map, no
    // sim worker. Its chunk loads on demand — most sessions never edit.
    const { mountEditor } = await import('../editor/editorScreen');
    present(await mountEditor(document.getElementById('canvas') as HTMLCanvasElement));
    return;
  }
  if (key === 'docs') {
    // The field guide: every def in the game, cross-linked and read from
    // the same tables the sim plays by. Its chunk (and the three.js preview
    // code it carries) loads on demand — reading is rarer than playing.
    const { mountDocs } = await import('../areas/docs/docsScreen');
    const docs = mountDocs();
    present({
      key,
      dispose: () => docs.dispose(),
      onRouteChange: () => docs.onRouteChange(),
    });
    return;
  }
  const mp = launchParams.get('mp');
  if (key === 'menu') {
    // The pre-boot screens are one page. A bare '/' opens on the start
    // screen; ?mp=CODE (an invite link, or a reload) opens straight into
    // that room, and ?open=0 hosts an unlisted one — joinable by code,
    // absent from the start screen's browser. Either way the shell runs
    // the lobby and hands the match over in place, so the only reload
    // between the menu and a multiplayer match is the one nobody asked
    // for.
    // The menu is safe ground: nothing is at stake, so a service worker
    // that finished installing behind a match may take over now.
    releaseServiceWorkerUpdates();
    mountMenu(
      mp === null
        ? null
        : { mp, open: launchParams.get('open') !== '0', init: lobbyInitFromUrl(launchParams) },
      {
        onBegin: (lobby) => {
          // The shell has already torn itself down (the match needs the
          // canvas and the pointer events it was holding), so the menu
          // screen is gone whether or not this succeeds.
          current = null;
          void startNetMatch(lobby)
            .then((match) => {
              // Building a match takes a moment (assets, the world, a
              // socket), and the player can leave inside it — Back out of
              // the room, say. Whoever took the page in the meantime keeps
              // it; this one was born too late.
              if (current === null) current = match;
              else match.dispose();
            })
            .catch(fatalFrom);
        },
        // The relay refused or could not be reached. Offer the reload: it
        // lands back on this same URL, which is the room if one was named
        // and the start screen if the trouble came before that.
        onError: (message) => showFatal(message, { retry: true }),
      },
    );
    present({ key, dispose: unmountMenu });
    // The menu is a waiting room, and what the player is about to press is
    // known: fetch the match's chunk behind it, so Play does not start a
    // download. Unawaited and swallowed — this is a head start, not a
    // dependency, and the button's own import (runMatch above) is the one
    // that has to succeed.
    void import('./matchScreen').catch(() => undefined);
    return;
  }

  // ?replay=<name>: watch a saved replay from OPFS. The name is the menu's
  // pick (or a hand-edited URL — readReplayFile screens it); the log itself
  // carries the whole world recipe, so nothing else in the URL matters.
  const replayParam = launchParams.get('replay');
  if (replayParam !== null) {
    const raw = await readReplayFile(replayParam);
    const replay = raw !== null ? parseReplay(raw) : null;
    if (!replay) {
      fatal(`The replay "${replayParam}" could not be loaded — it may have been deleted.`, {
        menu: true,
      });
    }
    // Playback re-runs the sim, and the sim is version-bound: the same
    // commands against a retuned tick produce a different match. Refuse
    // rather than diverge silently — the menu greys these rows out, but
    // the URL is hand-editable.
    if (replay.replayVersion !== REPLAY_VERSION) {
      fatal(
        `The replay "${replayParam}" was recorded under replay version ` +
          `${replay.replayVersion}; this build plays version ${REPLAY_VERSION}, ` +
          `and the match would not come out the way it was played.`,
        { menu: true },
      );
    }
    present(
      await runMatch(
        { ...replay.config, myPlayerId: replay.config.myPlayerId ?? 0, llmOpponent: false },
        {
          replay,
          // A replay that resumes from a save resumes its fog too, or the
          // playback would darken ground the player had already scouted.
          // Kept packed: the world's size — and so the grid's length — is
          // only known once the init frame arrives.
          fogSeed: replay.explored,
        },
        key,
      ),
    );
    return;
  }

  // Which saved game this match boots from, if any. Two ways in, and the
  // in-tab one wins: the GPU-loss rescue writes a save and stashes its
  // name in sessionStorage (per-tab, so a second open tab can never steal
  // or duplicate the handoff), and that file is the world the player was
  // actually standing in — ?load=<name>, which the menu's shelf and every
  // ordinary reload of this URL carry, is the older intent.
  const pending = stashGet('session', 'serf-load-pending');
  stashSet('session', 'serf-load-pending', null);
  // Migrate away any stale handoff left by the old localStorage flow.
  stashSet('local', 'serf-load-pending', null);
  let raw: string | null = null;
  /** What to call the village in a message about it. */
  let loadName: string | null = null;
  // A handoff from before saves became files is the save itself, not a
  // name. Rare — it takes an upgrade landing between the stash and the
  // reload — but the world in it is somebody's village.
  if (pending !== null && pending.startsWith('{')) raw = pending;
  else {
    loadName = pending ?? launchParams.get('load');
    if (loadName !== null) {
      raw = await readSaveFile(loadName);
      if (raw === null) {
        fatal(`The saved game "${loadName}" could not be loaded — it may have been deleted.`, {
          menu: true,
        });
      }
    }
  }
  // A solo save is an envelope: the worker's world string plus the fog's
  // memory. Split it here — the worker gets exactly the string it wrote,
  // and the explored grid waits for the fog to exist.
  let loadData: string | undefined;
  let fogSeed: string | undefined;
  if (raw !== null) {
    const split = splitSave(raw);
    // The version the world was written in, checked here rather than left
    // to the worker. The worker does refuse an older one — but it refuses
    // by throwing, which reaches this side as "sim worker failed: …" and
    // says nothing a player can act on. The shelf greys these rows out;
    // the URL is hand-editable, a save can be dropped in from anywhere,
    // and the GPU-loss handoff carries a name rather than a version.
    const written = readSaveWorldVersion(split.world);
    if (written !== undefined && !canReadSave(written)) {
      fatal(
        `${loadName !== null ? `The saved game "${loadName}"` : 'That saved game'} was ` +
          `written in save format ${written}; this build reads format ` +
          `${WORLD_SAVE_VERSION} and cannot open that village.`,
        { menu: true },
      );
    }
    loadData = split.world;
    fogSeed = split.explored;
  }
  present(await runMatch(configFromUrl(location.search), { loadData, fogSeed }, key));
}

/**
 * Put the screen on the page, and say so when it cannot be put there.
 *
 * Building a screen is fallible in ways that have nothing to do with the
 * player — a save the sim refuses, a mission chunk that will not fetch, a
 * worker that dies on the way up — and the router has nowhere to take a
 * rejection: a back gesture has no caller at all, and a click handler has
 * no more idea what to do with one than it does. It logged and stopped,
 * which left the page exactly as route() had already made it: torn down,
 * empty, and silent. A screen that fails puts the card up instead, with
 * the way back to the menu on it.
 *
 * Failures raised by fatal() have already drawn their own card by the time
 * they arrive here, and showFatal keeps the first one — so the specific
 * message wins over this general one.
 */
async function routeSafely(opts: { force?: boolean } = {}): Promise<void> {
  try {
    await route(opts);
  } catch (err) {
    console.error('[app] the screen failed to come up:', err);
    showFatal(err instanceof Error ? err.message : String(err), { menu: true });
  }
}

/**
 * Is this something the player types into? The context menu (and text
 * selection, handled in index.html's stylesheet) is suppressed everywhere
 * else. An <input> with no type attribute reports type 'text', so the
 * bare seed and room-code fields land in the list.
 */
function isTextEntry(target: EventTarget | null): boolean {
  if (target instanceof HTMLTextAreaElement) return true;
  if (target instanceof HTMLInputElement) {
    return ['text', 'search', 'password', 'email', 'url', 'number', 'tel'].includes(target.type);
  }
  return target instanceof HTMLElement && target.isContentEditable;
}

async function boot(): Promise<void> {
  // The context menu is the browser talking over the game: right-click
  // gives orders in a match (the canvas has its own guard in
  // input/controls.ts, but the HUD, the menu and the end card are just as
  // much game surface) and long-press is a command gesture on phones.
  // Text fields keep theirs — copy and paste are how room codes travel.
  //
  // So does the field guide, which is a document rather than game surface:
  // it hands text selection back deliberately and its links are real
  // anchors, and neither is worth much if right-click cannot copy them.
  document.addEventListener('contextmenu', (e) => {
    if (isTextEntry(e.target)) return;
    if (e.target instanceof Element && e.target.closest('#docs')) return;
    e.preventDefault();
  });
  // Before anything else takes a click: a player who asked for fullscreen
  // gets it back on their first gesture (see ui/fullscreen.ts). It survives
  // a screen change on its own now — nothing unloads — but a real reload
  // still lands here, and so does a cold start.
  armFullscreen();
  // Same posture for sound: autoplay policy keys the AudioContext to a
  // user gesture, and a launch URL can boot a match without one, so the
  // audio layer arms capture-phase listeners now and unlocks on whatever
  // the first real click turns out to be. The store's signals carry the
  // persisted (or ?mute=1/?vol=) starting point.
  initAudio({ gain: volumeToGain(volume()), muted: muted() });
  // Single player is a local sim, so with the shell and the models on disk
  // it plays with the network off entirely. A pending update only takes
  // over on the menu — never behind a live match — and route() hands the
  // hold back every time the menu comes up again.
  //
  // Not screenKey() here, close as it looks: ?mp=CODE is a menu screen by
  // that reckoning, but arriving on one may be a match reloading itself
  // back into its seat (see MenuApp's silent rejoin), and a worker swap
  // under that is exactly what this handshake exists to prevent.
  registerServiceWorker({ applyUpdates: !gameChosen(new URLSearchParams(location.search)) });
  // The village from before saves were files, if this device has one:
  // filed on the shelf, once, ahead of the first screen that could list
  // it. A no-op — one localStorage read — on every launch after that.
  await migrateLegacySave();
  startRouter(routeSafely);
  await routeSafely();
}

/**
 * Take over from the council. The lobby resolved seats and our seat token,
 * and that is all that crossed. No world blob — the server holds the world
 * and sends this seat only what it may see.
 *
 * The menu is already gone by here (the shell tears itself down before
 * calling), so the canvas, the pointer events and a WebGL context are all
 * free to take.
 */
async function startNetMatch(lobby: LobbyResult): Promise<Screen> {
  return runMatch(
    {
      ...configFromUrl(location.search),
      players: lobby.seats.map((s) => ({ kind: playerKindFromKey(s.kind) ?? PlayerKind.human })),
      myPlayerId: lobby.myPlayerId,
      adminEnabled: false,
    },
    { net: lobby.net },
    NET_MATCH_KEY,
  );
}

void boot().catch((err: unknown) => fatal(err instanceof Error ? err.message : String(err)));
