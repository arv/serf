import { GameRenderer } from '../render/renderer';
import { TerrainMesh } from '../render/terrainMesh';
import { ScatterMesh } from '../render/scatterMesh';
import { HeightField } from '../render/heightField';
import { GrassField } from '../render/grassField';
import { WaterMesh } from '../render/waterMesh';
import { Mist } from '../render/mist';
import { SceneSync } from '../render/sceneSync';
import { SelectionFx } from '../render/selectionFx';
import { BuildingSync } from '../render/buildingSync';
import { GhostPlacement } from '../render/ghost';
import { FogOfWar } from '../render/fogOfWar';
import { loadCharacterAssets } from '../render/characters';
import { loadGlbAssets } from '../render/assets';
import { Controls } from '../input/controls';
import { mountHud } from '../ui/mount';
import {
  myPlayerId,
  playersMeta,
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
  speed,
  fogEnabled,
} from '../ui/store';
import { WorldMirror } from './mirror';
import { envelopeSave, splitSave } from './saveEnvelope';
import { WorkerSimHost } from './simHost';
import { mountMenu } from '../ui/MenuApp';
import { holdServiceWorkerUpdates, registerServiceWorker } from './serviceWorker';
import { configFromUrl, type GameConfig } from './gameConfig';
import { defaultLobbyConfig, sanitizeLobbyConfig, type LobbyConfig } from '../protocol/lobby';
import type { LobbyResult } from '../net/lobbyClient';
import type { NetInfo } from '../protocol/messages';

function showFatal(message: string, opts?: { retry?: boolean }): void {
  const el = document.getElementById('fatal')!;
  el.style.display = 'grid';
  const card = document.createElement('div');
  const title = document.createElement('h1');
  title.textContent = 'Serf cannot start';
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
    retry.addEventListener('click', () => location.reload());
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
const LAUNCH_PARAMS = ['mp', 'ai', 'players', 'seed', 'skipMenu'];

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

async function boot(): Promise<void> {
  const launchParams = new URLSearchParams(location.search);
  if (launchParams.has('wardrobe')) {
    // The costume fitting room: every unit of every faction, labeled,
    // under the real camera and sun. Render-only — no sim, no HUD.
    const { mountWardrobe } = await import('../ui/wardrobe');
    await mountWardrobe(document.getElementById('canvas') as HTMLCanvasElement);
    return;
  }
  // A pending load is a launch too: the Load button stashes the save and
  // reloads, and that handoff must not bounce back to the menu.
  const chosen =
    LAUNCH_PARAMS.some((k) => launchParams.has(k)) ||
    sessionStorage.getItem('serf-load-pending') !== null;
  // Single player is a local sim, so with the shell and the models on disk
  // it plays with the network off entirely. A pending update only takes
  // over on the menu — never behind a live match.
  registerServiceWorker({ applyUpdates: !chosen });

  const mp = launchParams.get('mp');
  if (!chosen || mp !== null) {
    // The pre-boot screens are one page. A bare '/' opens on the start
    // screen; ?mp=CODE (an invite link, or a reload) opens straight into
    // that room, and ?open=0 hosts an unlisted one — joinable by code,
    // absent from the start screen's browser. Either way the shell runs
    // the lobby and hands the match over in place, so the only reload
    // between the menu and a multiplayer match is the one nobody asked
    // for.
    mountMenu(
      mp === null
        ? null
        : { mp, open: launchParams.get('open') !== '0', init: lobbyInitFromUrl(launchParams) },
      {
        onBegin: (lobby) => void startNetMatch(lobby).catch(fatalFrom),
        // The relay refused or could not be reached. Offer the reload: it
        // lands back on this same URL, which is the room if one was named
        // and the start screen if the trouble came before that.
        onError: (message) => showFatal(message, { retry: true }),
      },
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
  await runMatch(configFromUrl(location.search), { loadData, fogSeed });
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
async function startNetMatch(lobby: LobbyResult): Promise<void> {
  await runMatch(
    {
      ...configFromUrl(location.search),
      players: lobby.seats,
      myPlayerId: lobby.myPlayerId,
      adminEnabled: false,
    },
    { net: lobby.net },
  );
}

/**
 * The match itself: worker, renderer, HUD and the frame loop. Reached
 * either from a launch URL or from the council handing over in place, and
 * exactly once per page either way — everything below assumes it owns the
 * canvas.
 */
async function runMatch(
  config: GameConfig,
  opts: { loadData?: string; fogSeed?: Uint8Array; net?: NetInfo },
): Promise<void> {
  const { loadData, fogSeed, net } = opts;
  // From here on the page is a match, not a menu: a service worker that
  // finishes installing must not swap the shell out from under it.
  holdServiceWorkerUpdates();
  setMyPlayerId(config.myPlayerId);
  setNetMode(net !== undefined);

  // Single player owns a World in a worker; multiplayer owns a socket and
  // renders what the server sends. Both speak the same worker protocol, so
  // nothing below this line knows the difference.
  const host = new WorkerSimHost(net ? 'net' : 'sim');
  // Character/building GLBs load while the world is prepared; if they fail,
  // the renderer falls back to the procedural models.
  const [init] = await Promise.all([
    host.start(config, loadData, net),
    loadCharacterAssets(),
    loadGlbAssets(),
  ]);

  const canvas = document.getElementById('canvas') as HTMLCanvasElement;
  // Android Chrome kills the GPU process under memory pressure, and for a
  // while afterwards a WebGL context simply isn't granted. A dead-end
  // error screen made that read as "the game is broken"; the process
  // usually comes back within a breath, so retry once on our own and put
  // a button on the screen for the times it needs longer.
  let renderer: GameRenderer;
  try {
    renderer = new GameRenderer(canvas);
    sessionStorage.removeItem('serf-gl-fails');
  } catch (err) {
    const fails = Number(sessionStorage.getItem('serf-gl-fails') ?? '0') + 1;
    sessionStorage.setItem('serf-gl-fails', String(fails));
    if (fails <= 1) setTimeout(() => location.reload(), 1500);
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
  let restoreTimer: ReturnType<typeof setTimeout> | undefined;
  canvas.addEventListener('webglcontextlost', () => {
    restoreTimer = setTimeout(() => {
      if (net) {
        location.reload();
        return;
      }
      // saveGame is declared further down, but this callback cannot run
      // before it exists: everything between here and there is synchronous,
      // and the timer gives it four seconds besides.
      void saveGame()
        .then((data) => sessionStorage.setItem('serf-load-pending', data))
        .finally(() => location.reload());
    }, 4000);
  });
  canvas.addEventListener('webglcontextrestored', () => clearTimeout(restoreTimer));
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
  const scatter = new ScatterMesh(init.map, heights);
  renderer.scene.add(scatter.group);
  const grass = new GrassField(init.map, heights);
  renderer.scene.add(grass.mesh);
  const water = new WaterMesh(init.map);
  renderer.scene.add(water.mesh);
  const mist = new Mist(init.map);
  renderer.scene.add(mist.group);

  const buildingSync = new BuildingSync(renderer.scene, heights, config.myPlayerId);
  buildingSync.update(init.buildings);

  const sync = new SceneSync(renderer.scene, init.reader, heights, config.myPlayerId);
  // Where the well cranks are: drawing serfs stand beside them and their
  // hand is IK-glued to the grip.
  const feedWells = (): void => sync.setWells(buildingSync.wellCranks());
  feedWells();
  const fog = new FogOfWar(config.myPlayerId);
  // The fog's memory across sessions: multiplayer seats get the server's
  // authoritative explored grid; a loaded solo game gets the one its save
  // carried. Never both — solo has no server, multiplayer has no save.
  if (init.explored) fog.seedExplored(init.explored);
  else if (fogSeed) fog.seedExplored(fogSeed);
  // One save string for every writer — the menu button and the GPU-crash
  // handoff alike: the world from the worker, the fog's memory from here.
  const saveGame = async (): Promise<string> =>
    envelopeSave(await host.requestSave(), fog.exportExplored());
  if (import.meta.env.DEV) {
    Object.assign(window as unknown as Record<string, unknown>, { __fog: fog });
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
  // Placement consults the fog: unscouted ground is not buildable, which is
  // what stops the build ghost being used to probe the dark.
  controls.setFog(fog);

  host.onNetStatus((status) => setNetStatus(status));
  host.onStructural((msg) => {
    // A reconnect resync carries the seat's ever-seen grid afresh.
    if (msg.explored) fog.seedExplored(msg.explored);
    // HUD state first, scene sync second. These signal writes cannot
    // throw, while the render sync below can — and when it does, the
    // damage must stay on the canvas. With the old order an exception
    // there silently froze stock, outcome and the selection panel for the
    // rest of the match while the sim ran on.
    const mine = msg.players[myPlayerId()];
    if (mine) {
      setStock(mine.stock);
      setTechs(mine.techs);
      setPopulation({ pop: mine.pop, cap: mine.popCap });
    }
    setPlayersMeta(msg.players);
    setDebugJobs(msg.jobs);
    setInvariantViolations(msg.invariantViolations);
    setOutcome(msg.outcome);
    setAdminState(msg.admin);
    for (const event of msg.events) {
      if (event.kind === 'raidIncoming' && event.player === myPlayerId()) {
        pushToast(event.text);
      } else if (event.kind === 'playerEliminated' && event.player !== myPlayerId()) {
        pushToast('A rival banner has fallen!');
      }
    }
    // Keep the selected building's panel fresh (or clear it if destroyed).
    const sel = selectedBuilding();
    if (sel) {
      const fresh = msg.buildings.find((b) => b.id === sel.id);
      setSelectedBuilding(fresh ?? null);
    }

    // Grass and shore rocks make way for buildings and worn trails (checked
    // against the mirror's pre-update state, so compare before applying).
    for (const d of msg.mapDeltas) {
      if (d.buildingAt >= 0 || d.pathLevel !== 0) {
        grass.removeTile(d.idx);
        if (d.buildingAt >= 0) scatter.removeTile(d.idx);
      }
    }
    const changes = mirror.apply(msg);
    for (const tile of changes.resourceCleared) scatter.removeTile(tile);
    if (changes.refreshAll) scatter.resyncAll(mirror.map);
    if (changes.refreshAll) terrain.repaintAll();
    else if (changes.repaintTiles.length > 0) terrain.repaintTiles(changes.repaintTiles);
    buildingSync.update(msg.buildings);
    roster = msg.buildings;
    feedWells();
  });

  mountHud(host, {
    selectArmy: () => controls.selectArmy(),
    deselect: () => controls.deselectAll(),
    save: saveGame,
  });

  // The camera never rotates: hp bars copy its live orientation once to
  // sit parallel with the screen plane.
  sync.cameraQuaternion = renderer.rig.camera.quaternion;
  buildingSync.cameraQuaternion = renderer.rig.camera.quaternion;

  let fogLast = performance.now();
  function loop(): void {
    const now = performance.now();
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
    sync.update(now, controls.hoverUnit, controls.selected, speed() === 0, renderer.rig.viewBounds());
    buildingSync.highlight(controls.hoverBuilding, selectedBuilding()?.id ?? -1);
    controls.prune();
    selectionFx.update(controls.selected, sync, now);
    water.update(now);
    mist.update(now);
    const dt = renderer.frame();
    buildingSync.frame(speed() === 0 ? 0 : dt);
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);
}

void boot().catch((err: unknown) => fatal(err instanceof Error ? err.message : String(err)));
