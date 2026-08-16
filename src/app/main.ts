import { GameRenderer } from '../render/renderer';
import { TerrainMesh } from '../render/terrainMesh';
import { ScatterMesh } from '../render/scatterMesh';
import { HeightField } from '../render/heightField';
import { GrassField } from '../render/grassField';
import { RoadDecal } from '../render/roadDecal';
import { WaterMesh } from '../render/waterMesh';
import { Mist } from '../render/mist';
import { SceneSync } from '../render/sceneSync';
import { SelectionFx } from '../render/selectionFx';
import { BuildingSync } from '../render/buildingSync';
import { GhostPlacement } from '../render/ghost';
import { SelectedReach } from '../render/reachOutline';
import { FogOfWar } from '../render/fogOfWar';
import { batteryFramePacer } from '../render/framePacer';
import { HiddenSync } from './hiddenSync';
import { loadCharacterAssets } from '../render/characters';
import { loadGlbAssets } from '../render/assets';
import { Controls } from '../input/controls';
import { DamageAlerts } from './damageAlerts';
import { mountHud } from '../ui/mount';
import {
  myPlayerId,
  playersMeta,
  setLlmStatus,
  setMyPlayerId,
  setNetMode,
  setNetStatus,
  pushToast,
  selectedBuilding,
  setAdminState,
  setDebugJobs,
  setInvariantViolations,
  setOutcome,
  setPlayersMeta,
  setSelectedBuilding,
  setPopulation,
  setStock,
  setTechs,
  setReplayMode,
  setReplayOver,
  speed,
  setSpeed,
  fogEnabled,
  placing,
  setMission,
  briefingOpen,
  setBriefingOpen,
  resetMatchState,
  muted,
  volume,
} from '../ui/store';
import {
  audioFrame,
  initAudio,
  play,
  playAt,
  setAudioHidden,
  setAudioPaused,
  setAudioView,
} from '../audio/audio';
import { volumeToGain } from '../audio/settings';
import { markMissionComplete } from '../ui/campaign';
import { MISSION_DEFS } from '../sim/defs/missions';
import { Terrain } from '../sim/map';
import { inBounds, tileIdx } from '../shared/grid';
import { WorldMirror } from './mirror';
import { REPLAY_VERSION } from '../shared/replayVersion';
import { envelopeSave, packExplored, splitSave, unpackExplored } from './saveEnvelope';
import { parseReplay, replayName, type ReplayData } from './replay';
import { readReplayFile, saveReplayFile } from './replayStore';
import { WorkerSimHost } from './simHost';
import { mountMenu, unmountMenu } from '../ui/MenuApp';
import { armFullscreen } from '../ui/fullscreen';
import { startRouter } from './router';
import {
  holdServiceWorkerUpdates,
  registerServiceWorker,
  releaseServiceWorkerUpdates,
} from './serviceWorker';
import { configFromUrl, type GameConfig } from './gameConfig';
import { defaultLobbyConfig, sanitizeLobbyConfig, type LobbyConfig } from '../protocol/lobby';
import type { LobbyResult } from '../net/lobbyClient';
import type { NetInfo } from '../protocol/messages';

/**
 * Whether a screen is already up. The first failure is the one that knows
 * what happened; anything after it is that failure arriving a second time.
 * fatal() throws, so every one of these ends up at boot()'s catch as well —
 * and the plain screen that catch would draw used to replace the screen the
 * WebGL path had just put up, taking the Try again button with it and
 * leaving the player with a black page and no way out.
 */
let fatalShown = false;

function showFatal(message: string, opts?: { retry?: boolean }): void {
  if (fatalShown) return;
  fatalShown = true;
  const el = document.getElementById('fatal')!;
  el.style.display = 'grid';
  const card = document.createElement('div');
  const title = document.createElement('h1');
  title.textContent = 'Serf Valley cannot start';
  const body = document.createElement('p');
  // Text, never markup. Relay error messages land here (runLobby's fail
  // rejects with them and boot's catch brings them straight in), and the
  // relay is not an author this page may trust with an origin that holds
  // the saves and the seat token.
  body.textContent = message;
  card.append(title, body);
  if (opts?.retry) {
    const retry = document.createElement('button');
    retry.textContent = 'Try again';
    retry.style.cssText =
      'font:inherit;font-size:15px;padding:10px 26px;margin-top:10px;cursor:pointer;' +
      'color:#f7e9c0;background:rgba(229,196,105,0.13);border:1px solid rgba(229,196,105,0.5);' +
      'border-radius:11px;';
    retry.addEventListener('click', () => {
      // Asking by hand re-arms the automatic tries: the count exists to stop
      // a reload loop running on its own, and this one is not on its own.
      sessionStorage.removeItem('serf-gl-fails');
      location.reload();
    });
    card.append(retry);
  }
  el.replaceChildren(card);
}

/** The same screen, for the paths that must not carry on afterwards. */
function fatal(message: string, opts?: { retry?: boolean }): never {
  showFatal(message, opts);
  throw new Error(message);
}

function fatalFrom(err: unknown): void {
  showFatal(err instanceof Error ? err.message : String(err));
}

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
const LAUNCH_PARAMS = ['mp', 'ai', 'players', 'seed', 'skipMenu', 'mission', 'replay'];

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
 * What is on the page, and how to take it off again.
 *
 * Screens change in this document now (see app/router.ts), so exactly one
 * of these is mounted at a time and the previous one is disposed before the
 * next is built — the canvas, the WebGL context and the #ui overlay are
 * singular, and two screens cannot share them.
 */
interface Screen {
  /** Which screen this is; see screenKey(). */
  key: string;
  dispose(): void;
}
let current: Screen | null = null;

/**
 * Has a game been chosen? A pending load counts: the Load button stashes
 * the save and navigates, and that handoff must not bounce back to the
 * menu.
 */
function gameChosen(params: URLSearchParams): boolean {
  return (
    LAUNCH_PARAMS.some((k) => params.has(k)) ||
    sessionStorage.getItem('serf-load-pending') !== null
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
  const params = new URLSearchParams(location.search);
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
  const key = screenKey();
  // The same screen asking for itself is the menu moving its own address
  // bar, and tearing it down and rebuilding it would be visible. `force`
  // is how the two genuine exceptions say so: Play again and Watch again
  // both mean "this exact screen, from the top".
  if (!opts.force && current && current.key === key) return;
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
  if (launchParams.has('wardrobe')) {
    // The costume fitting room: every unit of every faction, labeled,
    // under the real camera and sun. Render-only — no sim, no HUD.
    const { mountWardrobe } = await import('../ui/wardrobe');
    await mountWardrobe(document.getElementById('canvas') as HTMLCanvasElement);
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
      fatal(`The replay "${replayParam}" could not be loaded — it may have been deleted.`);
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
      );
    }
    present(
      await runMatch(
        { ...replay.config, myPlayerId: replay.config.myPlayerId ?? 0, llmOpponent: false },
        {
          replay,
          // A replay that resumes from a save resumes its fog too, or the
          // playback would darken ground the player had already scouted.
          fogSeed: replay.explored ? unpackExplored(replay.explored) : undefined,
        },
        key,
      ),
    );
    return;
  }

  // A pending load (set by the Load button before its reload) boots the
  // worker straight into the saved world. sessionStorage on purpose: it is
  // per-tab, so a second open tab (e.g. the dev preview) can never steal or
  // duplicate the handoff the way a shared localStorage key could.
  let loadData = sessionStorage.getItem('serf-load-pending') ?? undefined;
  sessionStorage.removeItem('serf-load-pending');
  // Migrate away any stale handoff left by the old localStorage flow.
  localStorage.removeItem('serf-load-pending');
  // A solo save is an envelope: the worker's world string plus the fog's
  // memory. Split it here — the worker gets exactly the string it wrote,
  // and the explored grid waits for the fog to exist.
  let fogSeed: Uint8Array | undefined;
  if (loadData !== undefined) {
    const split = splitSave(loadData);
    loadData = split.world;
    fogSeed = split.explored;
  }
  present(await runMatch(configFromUrl(location.search), { loadData, fogSeed }, key));
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
  document.addEventListener('contextmenu', (e) => {
    if (!isTextEntry(e.target)) e.preventDefault();
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
  startRouter(route);
  await route();
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
      players: lobby.seats,
      myPlayerId: lobby.myPlayerId,
      adminEnabled: false,
    },
    { net: lobby.net },
    NET_MATCH_KEY,
  );
}

/**
 * Boot the LLM strategist beside a solo match: model in a worker via
 * WebLLM, summaries up from the sim worker, validated advice back down.
 * Every failure mode ends the same way — the AI seats keep playing their
 * playbooks and the player hears about it once.
 */
async function bootLlmStrategist(
  host: WorkerSimHost,
  hidden: HiddenSync,
  // Filled in as soon as the chunk resolves, so a match that ends while the
  // import is still in flight still gets to stop the download.
  handle: { dispose?: () => void },
): Promise<void> {
  const { LlmStrategist } = await import('../ai/strategist');
  const strategist = new LlmStrategist({
    sendAdvice: (playerId, override) => host.sendAiAdvice(playerId, override),
    onStatus: (status) => {
      if (status.state === 'failed') {
        // The badge would just be a standing shrug; say it once and move on.
        console.warn(`[strategist] ${status.reason}`);
        pushToast('The LLM strategist is unavailable — opponents use standard tactics');
        setLlmStatus(null);
        return;
      }
      setLlmStatus(status);
      // "On" has nothing more to report; linger long enough to be seen.
      if (status.state === 'ready') setTimeout(() => setLlmStatus(null), 10_000);
    },
  });
  handle.dispose = () => strategist.dispose();
  host.onAiSummary((playerId, summary) => strategist.onSummary(playerId, summary));
  // The frozen sim stops new summaries when the page hides; this stops the
  // consultation already chewing — a minute of wasm inference is exactly
  // the CPU a backgrounded phone cannot afford.
  hidden.add((h) => strategist.setHidden(h));
  await strategist.start();
}

/**
 * The match itself: worker, renderer, HUD and the frame loop. Reached
 * either from a launch URL or from the council handing over in place, and
 * once at a time either way — everything below assumes it owns the canvas.
 *
 * Returns the screen handle that gives all of it back. What has to be
 * released by hand is exactly what would otherwise outlive the world: the
 * sim worker (its timers are unthrottled on purpose, so a forgotten one
 * keeps simulating behind the menu), the listeners on window and document,
 * the Solid root, and the WebGL context. The scene graph is not on that
 * list — its buffers live in the context, and die with it.
 */
async function runMatch(
  config: GameConfig,
  opts: { loadData?: string; fogSeed?: Uint8Array; net?: NetInfo; replay?: ReplayData },
  key: string,
): Promise<Screen> {
  const { loadData, fogSeed, net, replay } = opts;
  // Run in reverse at teardown, so each entry can assume everything pushed
  // before it is still standing.
  const teardown: (() => void)[] = [];
  /**
   * Set before the first teardown step, and read by the handlers that
   * outlive their own removal. Taking a match apart is itself eventful —
   * releasing the WebGL context announces itself as context loss — and a
   * handler that answers those events is answering about a match that no
   * longer exists.
   */
  let over = false;
  const screen: Screen = {
    key,
    dispose: () => {
      over = true;
      while (teardown.length > 0) {
        try {
          teardown.pop()!();
        } catch (err) {
          // One stubborn resource must not strand the rest — the next
          // screen is already on its way in.
          console.warn('[match] teardown step failed:', err);
        }
      }
    },
  };
  // From here on the page is a match, not a menu: a service worker that
  // finishes installing must not swap the shell out from under it.
  holdServiceWorkerUpdates();
  setMyPlayerId(config.myPlayerId);
  setNetMode(net !== undefined);
  setReplayMode(replay !== undefined);

  // The LLM strategist runs on the CPU (llama.cpp wasm), so it exists
  // wherever the browser owns the world — solo only. Its wasm threads
  // want the same cross-origin isolation the SAB hot path already made a
  // boot requirement, so there is no capability to probe. The worker is
  // told only when a strategist will actually listen, so it never builds
  // summaries for nobody.
  const llm = config.llmOpponent === true && net === undefined && replay === undefined;
  config = { ...config, llmOpponent: llm };

  const canvas = document.getElementById('canvas') as HTMLCanvasElement;
  /**
   * Every listener this function registers, on one signal.
   *
   * Taking them off matters even for the ones on the canvas, which is
   * replaced below and might therefore look self-cleaning. It is not:
   * three.js keeps a match's GPU buffers in WeakMaps keyed by its own
   * module-level geometries, and those live as long as the page, so a
   * detached canvas stays reachable through them — with every closure
   * hanging off it, and through those the worker, the scene and the
   * megabytes behind them.
   */
  const off = new AbortController();
  teardown.push(() => off.abort());
  // A canvas hands out one WebGL context in its life and no more, so the
  // match after this one cannot have this element. Swapping it for a clean
  // copy also releases what the GPU is holding: every buffer, texture and
  // program this match uploaded belongs to the context that goes with it.
  teardown.push(() => canvas.replaceWith(canvas.cloneNode(false)));
  // The context comes first, before the world is built and the models are
  // fetched. Two reasons, both about the phone this fails on: asking while
  // the page is at its lightest is the ask most likely to be granted, and
  // when it is refused anyway, failing here costs nothing — no worker, no
  // map, nothing to tear down before the reload below.
  //
  // Android Chrome kills the GPU process under memory pressure, and for a
  // while afterwards a WebGL context simply isn't granted. A dead-end error
  // screen made that read as "the game is broken"; the process usually
  // comes back within a breath, so try again on our own — twice, giving it
  // longer the second time — and leave a button for when it needs longer
  // still.
  let renderer: GameRenderer;
  try {
    renderer = new GameRenderer(canvas);
    teardown.push(() => renderer.dispose());
    sessionStorage.removeItem('serf-gl-fails');
  } catch (err) {
    const fails = Number(sessionStorage.getItem('serf-gl-fails') ?? '0') + 1;
    sessionStorage.setItem('serf-gl-fails', String(fails));
    if (fails <= 2) setTimeout(() => location.reload(), fails * 1500);
    fatal(
      'The browser refused a WebGL context — this usually passes in a moment. ' +
        `(${err instanceof Error ? err.message : String(err)})`,
      { retry: true },
    );
  }

  // WebGL context loss. three.js prevents the default and resumes if the
  // browser restores the context — but when Android kills the GPU process
  // under memory pressure, restoration often never comes and the canvas
  // stays a white sad-face while the HUD (and the sim, in its worker)
  // carry on. Give restoration a grace window; failing that, save through
  // the same sessionStorage handoff the Load button uses and reload — the
  // player comes back into the same world. Multiplayer skips the save
  // (the server owns the world; the rejoin token survives the reload).
  //
  // Armed the moment the context exists, which is before the world is
  // built: generating a map is the heaviest thing this page does, and a
  // phone that loses the GPU while it happens must still find its way to
  // the reload rather than sit on a dead canvas.
  let restoreTimer: ReturnType<typeof setTimeout> | undefined;
  // Assigned once the world is up, further down. Until then a loss has
  // nothing worth keeping and the reload is the whole recovery.
  let rescue: (() => Promise<string>) | undefined;
  canvas.addEventListener(
    'webglcontextlost',
    () => {
      // Not while the match is being taken down. Giving the context back is
      // how a match ends now, and three's dispose() does it by *losing* the
      // context — so this fires on the way out, every time. Unguarded it
      // armed the recovery: four seconds after quitting to the menu, the
      // page would save a world nobody was playing and reload itself.
      if (over) return;
      restoreTimer = setTimeout(() => {
        if (net || !rescue) {
          location.reload();
          return;
        }
        void rescue()
          .then((data) => sessionStorage.setItem('serf-load-pending', data))
          .finally(() => location.reload());
      }, 4000);
    },
    { signal: off.signal },
  );
  canvas.addEventListener('webglcontextrestored', () => clearTimeout(restoreTimer), {
    signal: off.signal,
  });
  // A match ending on its own terms must not leave a reload armed behind it.
  teardown.push(() => clearTimeout(restoreTimer));

  // Single player owns a World in a worker; multiplayer owns a socket and
  // renders what the server sends. Both speak the same worker protocol, so
  // nothing below this line knows the difference.
  const host = new WorkerSimHost(net ? 'net' : 'sim');
  teardown.push(() => host.dispose());
  // Switching apps (or the screen going dark) freezes the solo sim: the
  // worker's timers are deliberately unthrottled, so without this a
  // backgrounded phone keeps simulating — and draining — a valley nobody
  // is watching. The net worker can't pause a shared world, but it goes
  // quiet the same way: the relay stops streaming to a hidden seat and
  // catches it up on return. Sent through the host so this line, too,
  // needn't know which. HiddenSync rather than the raw event, because the
  // return-to-visible event is the one mobile browsers sometimes drop —
  // and a dropped return left the sim frozen under a live screen until
  // the player minimized and came back a second time. The frame loop
  // below reports its rAF ticks to the sync, whose gap watchdog wakes the
  // workers even when the event never arrives.
  const hidden = new HiddenSync(document.hidden);
  hidden.add((h) => host.setHidden(h));
  // Audio holds its breath with the sim: a suspended AudioContext is what
  // lets the device's audio hardware sleep — the same battery argument as
  // the worker freeze above, one line down. Inherits the gap watchdog too.
  hidden.add((h) => setAudioHidden(h));
  document.addEventListener('visibilitychange', () => hidden.set(document.hidden), {
    signal: off.signal,
  });
  // Fire-and-forget beside the match: the model downloads while the game
  // already runs on plain playbooks, and the first advice lands whenever it
  // lands. Dynamic import, so no strategist means none of its code either.
  if (llm) {
    const strategist: { dispose?: () => void } = {};
    teardown.push(() => strategist.dispose?.());
    void bootLlmStrategist(host, hidden, strategist);
  }
  // Character/building GLBs load while the world is prepared; if they fail,
  // the renderer falls back to the procedural models.
  const [init] = await Promise.all([
    host.start(config, loadData, net, replay),
    loadCharacterAssets(),
    loadGlbAssets(),
  ]);
  // Dev-only handles for console debugging (scene graph + the SAB reader,
  // which is where render-vs-sim questions get settled).
  if (import.meta.env.DEV) {
    Object.assign(window as unknown as Record<string, unknown>, {
      __scene: renderer.scene,
      __reader: init.reader,
    });
  }

  const mirror = new WorldMirror(init.map, init.buildings);
  if (import.meta.env.DEV) {
    Object.assign(window as unknown as Record<string, unknown>, { __mirror: mirror });
  }
  const heights = new HeightField(init.map.height);
  const terrain = new TerrainMesh(init.map, heights);
  renderer.scene.add(terrain.mesh);
  const roads = new RoadDecal(init.map, heights);
  renderer.scene.add(roads.mesh);
  if (import.meta.env.DEV) {
    // Ground-paint experiments: poke __mirror.map.pathLevel, then
    // __terrain.repaintAll() and __roads.rebuild(__mirror.map).
    Object.assign(window as unknown as Record<string, unknown>, {
      __terrain: terrain,
      __roads: roads,
    });
  }
  const scatter = new ScatterMesh(init.map, heights);
  renderer.scene.add(scatter.group);
  const grass = new GrassField(init.map, heights);
  renderer.scene.add(grass.mesh);
  const water = new WaterMesh(init.map);
  renderer.scene.add(water.mesh);
  const mist = new Mist(init.map);
  renderer.scene.add(mist.group);

  const buildingSync = new BuildingSync(renderer.scene, heights, config.myPlayerId);
  // Terrain feed for the pier measurement: on a corner-only shore the
  // fishery's deck swings 45 degrees toward the wet diagonal.
  buildingSync.setWater(
    (tx, tz) => inBounds(tx, tz) && mirror.map.terrain[tileIdx(tx, tz)] === Terrain.Water,
  );
  // Presentation cues flow render -> audio, injected like the fog: the
  // sync knows when and where, the audio layer knows whether and how loud.
  buildingSync.onCue = (cue, x, z) => playAt(cue, x, z);
  buildingSync.update(init.buildings);

  const sync = new SceneSync(renderer.scene, init.reader, heights, config.myPlayerId);
  sync.onCue = (cue, x, z, delaySec) => playAt(cue, x, z, 1, delaySec);
  // Where the well cranks are (drawing serfs stand beside them, hand
  // IK-glued to the grip) and where the fishery piers run (fishermen walk
  // out and cast off the end).
  const feedWells = (): void => {
    sync.setWells(buildingSync.wellCranks());
    sync.setPiers(buildingSync.fisheryPiers());
  };
  feedWells();
  const fog = new FogOfWar(config.myPlayerId);
  // Ahead of everything else at teardown: the materials it patched are
  // cached for the whole document, so they outlive this match and meet the
  // next one.
  teardown.push(() => fog.dispose());
  // The fog's memory across sessions: multiplayer seats get the server's
  // authoritative explored grid; a loaded solo game gets the one its save
  // carried. Never both — solo has no server, multiplayer has no save.
  if (init.explored) fog.seedExplored(init.explored);
  else if (fogSeed) fog.seedExplored(fogSeed);
  // One save string for every writer — the menu button and the GPU-crash
  // handoff alike: the world from the worker, the fog's memory from here.
  const saveGame = async (): Promise<string> =>
    envelopeSave(await host.requestSave(), fog.exportExplored());
  // Not while watching a replay: a GPU-loss reload comes back on the same
  // ?replay= URL and restarts playback — there is no world of ours to keep.
  if (!replay) rescue = saveGame;
  const damageAlerts = new DamageAlerts({
    scene: renderer.scene,
    heights,
    camera: renderer.rig.camera,
    canvas,
  });
  // Its haze layer is a child of document.body, so nothing else takes it
  // down: not the canvas swap, not the HUD's Solid root.
  teardown.push(() => damageAlerts.dispose());
  if (import.meta.env.DEV) {
    // Console handles for forensics and screenshot tooling: the fog for
    // visibility checks, the rig and heights for scripted camera jumps and
    // world->screen math (the wardrobe exposes its own pair).
    Object.assign(window as unknown as Record<string, unknown>, {
      __fog: fog,
      __rig: renderer.rig,
      __heights: heights,
      __damageAlerts: damageAlerts,
    });
  }
  sync.setFog(fog);
  buildingSync.setFog(fog);
  // Latest building roster, for the fog's sight sources.
  let roster = init.buildings;

  // Open on your own keep, not the map's middle. Solo they coincide, but a
  // multiplayer start sits on a ring — the first thing a player sees must
  // be their storehouse, not the bandits' hill.
  const home = init.buildings.find(
    (b) => b.type === 'storehouse' && b.owner === config.myPlayerId,
  );
  if (home) renderer.rig.focusOn(home.x + home.w / 2, home.y + home.h / 2);

  const selectionFx = new SelectionFx(renderer.scene, heights);
  const ghost = new GhostPlacement(renderer.scene, heights, config.myPlayerId);
  const selectedReach = new SelectedReach(renderer.scene, heights);
  const controls = new Controls(
    canvas,
    renderer.rig.camera,
    sync,
    host,
    mirror,
    ghost,
    heights,
    renderer.rig,
  );
  teardown.push(() => controls.dispose());
  // Placement consults the fog: unscouted ground is not buildable, which is
  // what stops the build ghost being used to probe the dark.
  controls.setFog(fog);

  // A fresh mission opens on its briefing card over a still valley; the
  // card's Begin button starts the clock. A loaded mission save skips the
  // ceremony — the player has read it before. The mission signal is seeded
  // from the config rather than awaited from the worker: the match is about
  // to be paused, so the next structural frame may be a Begin-press away.
  // Seeded before onStructural registers — real frames (latch bits and all)
  // replay at registration and must win over this all-false stand-in.
  // A replayed mission skips the ceremony too: the briefing's pause is an
  // invitation to read before playing, and nobody is playing.
  if (config.mission && loadData === undefined && !replay) {
    setMission({
      id: config.mission,
      done: MISSION_DEFS[config.mission].objectives.map(() => false),
    });
    setBriefingOpen(true);
    setSpeed(0);
    host.setSpeed(0);
  }

  // Playback pauses itself at the recording's end; tell the HUD both halves
  // of that (the pause, and why) so it can show the replay-over card.
  host.onReplayEnded(() => {
    setSpeed(0);
    setReplayOver(true);
  });

  host.onNetStatus((status) => setNetStatus(status));
  host.onStructural((msg) => {
    // A reconnect resync carries the seat's ever-seen grid afresh.
    if (msg.explored) fog.seedExplored(msg.explored);
    // HUD state first, scene sync second. These signal writes cannot
    // throw, while the render sync below can — and when it does, the
    // damage must stay on the canvas. With the old order an exception
    // there silently froze stock, outcome and the selection panel for the
    // rest of the match while the sim ran on.
    // Rosters are optional: a frame that carries only map news leaves the
    // HUD's signals (and their subscribers) untouched.
    const mine = msg.players?.[myPlayerId()];
    if (mine) {
      setStock(mine.stock);
      setTechs(mine.techs);
      setPopulation({ pop: mine.pop, cap: mine.popCap });
    }
    if (msg.players) setPlayersMeta(msg.players);
    if (msg.jobs) setDebugJobs(msg.jobs);
    setInvariantViolations(msg.invariantViolations);
    setOutcome(msg.outcome);
    if (msg.outcome.state === 'over') damageAlerts.clear();
    setAdminState(msg.admin);
    // The worker, not the URL, says which mission this is: a loaded save
    // reboots on ?seed=…, but the world remembers. Synced both ways — a
    // frame without a mission block clears the signal (and any briefing),
    // so no mission UI can outlive its world.
    setMission(msg.mission ?? null);
    if (msg.mission) {
      // Finishing writes the profile. Idempotent, so every structural frame
      // after the win may say it again.
      if (msg.outcome.state === 'over' && msg.outcome.winner === myPlayerId()) {
        markMissionComplete(msg.mission.id);
      }
    } else if (briefingOpen()) {
      setBriefingOpen(false);
    }
    for (const event of msg.events) {
      if (event.kind === 'raidIncoming' && event.player === myPlayerId()) {
        // Non-positional on purpose: a warning must be heard wherever the
        // camera happens to be looking.
        play('raidHorn');
        pushToast(event.text);
      } else if (event.kind === 'playerEliminated' && event.player !== myPlayerId()) {
        play('distantBell');
        pushToast('A rival banner has fallen!');
      } else if (event.kind === 'damage' && event.player === myPlayerId()) {
        // The solo worker delivers every seat's events; filter like raids.
        // Only struck *buildings* sound from here — this event exists for
        // player-owned damage alone (combat.ts filters at the source), so
        // it is an alarm bell, not the battle's soundtrack. Unit combat
        // sounds come from the animation layer, which sees every side.
        if (event.building) playAt('buildingHit', event.x, event.y);
        damageAlerts.report(event);
      } else if (event.kind === 'objectiveComplete' && event.player === myPlayerId()) {
        play('objectiveDone');
        const label = msg.mission
          ? MISSION_DEFS[msg.mission.id].objectives[event.index]?.label
          : undefined;
        pushToast(label ? `Objective complete: ${label}` : 'Objective complete');
      } else if (event.kind === 'gameOver') {
        play(event.winner === myPlayerId() ? 'victory' : 'defeat');
      }
    }
    // Keep the selected building's panel fresh (or clear it if destroyed).
    const sel = selectedBuilding();
    if (sel && msg.buildings) {
      const fresh = msg.buildings.find((b) => b.id === sel.id);
      setSelectedBuilding(fresh ?? null);
    }

    // Grass and shore rocks make way for buildings (checked against the
    // mirror's pre-update state, so compare before applying).
    for (const d of msg.mapDeltas) {
      if (d.buildingAt >= 0) {
        grass.removeTile(d.idx);
        scatter.removeTile(d.idx);
      }
    }
    const wornTiles = msg.mapDeltas.filter((d) => d.pathLevel !== 0).map((d) => d.idx);
    const paved = msg.mapDeltas.some(
      (d) => (d.pathLevel === 2) !== (mirror.map.pathLevel[d.idx] === 2),
    );
    const changes = mirror.apply(msg);
    // Trails thread between tiles, so which clumps they trample is only
    // knowable once the new path levels are in the mirror.
    if (wornTiles.length > 0) grass.clearUnderPaths(mirror.map, wornTiles);
    if (paved || changes.refreshAll) roads.rebuild(mirror.map);
    for (const tile of changes.resourceCleared) scatter.removeTile(tile);
    if (changes.refreshAll) scatter.resyncAll(mirror.map);
    if (changes.refreshAll) terrain.repaintAll();
    else if (changes.repaintTiles.length > 0) terrain.repaintTiles(changes.repaintTiles);
    if (msg.buildings) {
      buildingSync.update(msg.buildings);
      roster = msg.buildings;
      feedWells();
    }
  });

  const unmountHud = mountHud(host, {
    selectArmy: () => controls.selectArmy(),
    deselect: () => controls.deselectAll(),
    place: (type) => controls.setPlacement(type),
    armOrder: (mode) => controls.armOrder(mode),
    save: saveGame,
    saveReplay: async () => {
      // Empty means there is nothing to save: both recorders decline while
      // the match is still undecided for any human — the server until the
      // room's outcome is over, the solo worker until its own is.
      // The fog this match booted with — not the fog now: it belongs to
      // the world the recording starts from, which for a loaded save is
      // the moment that save was written.
      const data = await host.requestReplay(fogSeed ? packExplored(fogSeed) : undefined);
      if (data === '') return null;
      // The store may suffix the name ("… (2)") when two saves land in the
      // same second; what it returns is what the file is actually called.
      return saveReplayFile(replayName(new Date()), data);
    },
    // Tile y is world z — the same straight mapping as the home focusOn.
    focus: (x, y) => renderer.rig.glideTo(x, y),
  });
  teardown.push(unmountHud);

  // The camera never rotates: hp bars copy its live orientation once to
  // sit parallel with the screen plane.
  sync.cameraQuaternion = renderer.rig.camera.quaternion;
  buildingSync.cameraQuaternion = renderer.rig.camera.quaternion;

  let fogLast = performance.now();
  // Reused every frame — viewBounds writes into it instead of allocating.
  const boundsScratch = { minX: 0, maxX: 0, minZ: 0, maxZ: 0 };
  // Phones cap the loop at 30 fps: a 90 Hz panel otherwise renders the
  // whole valley 90 times a second, and the GPU is where the battery goes.
  // A skipped frame does nothing at all — every update below is time-based,
  // so play continues at full speed, drawn less often.
  const pacer = batteryFramePacer();
  // The loop renders through a context the teardown is about to drop, so it
  // has to be the first thing that stops — one more frame after dispose
  // would be drawing into nothing.
  let frame = 0;
  let running = true;
  teardown.push(() => {
    running = false;
    cancelAnimationFrame(frame);
  });
  function loop(): void {
    if (!running) return;
    const now = performance.now();
    // Every rAF callback is proof the page is visible — before the pacer,
    // so a skipped frame still counts. A long gap since the last one means
    // we were away and are back, and wakes the workers even when the
    // visibilitychange that should have said so was dropped.
    hidden.frame(now);
    if (!pacer.due(now)) {
      frame = requestAnimationFrame(loop);
      return;
    }
    // Fog first: the entity syncs below ask it what may be drawn, so it
    // has to reflect this frame's positions, not the last one's.
    // Death lifts the fog: an eliminated seat is a spectator, and the
    // server has already stopped filtering what it sends us.
    const fallen = playersMeta()[myPlayerId()]?.alive === false;
    fog.setEnabled(fogEnabled() && !fallen);
    fog.update(Math.min((now - fogLast) / 1000, 0.25), init.reader, roster, renderer.scene);
    fogLast = now;
    // Hover picking is deferred from pointermove (which can fire at
    // hundreds of Hz) to at most once per frame, here.
    controls.updateHoverIfDirty();
    // The view rect reaches the audio layer before the sync runs: the sync
    // is what files this frame's positional cues, and they pan and fade
    // against the rect of the frame they were heard in.
    const bounds = renderer.rig.viewBounds(3, boundsScratch);
    setAudioView(bounds);
    setAudioPaused(speed() === 0);
    sync.update(now, controls.hoverUnit, controls.selected, speed() === 0, bounds);
    buildingSync.highlight(controls.hoverBuilding, selectedBuilding()?.id ?? -1);
    // While a new hut is being aimed, the ghost's own outline is the one
    // that answers the question — two squares over the same ground, in two
    // colors, would only be read as a conflict.
    selectedReach.update(placing() ? null : selectedBuilding());
    controls.prune();
    selectionFx.update(controls.selected, sync, now);
    damageAlerts.update(now);
    water.update(now);
    mist.update(now);
    const dt = renderer.frame();
    buildingSync.frame(speed() === 0 ? 0 : dt);
    // Last: the frame's queued cues become at most a couple dozen voices.
    audioFrame(now);
    frame = requestAnimationFrame(loop);
  }
  frame = requestAnimationFrame(loop);
  return screen;
}

void boot().catch((err: unknown) => fatal(err instanceof Error ? err.message : String(err)));
