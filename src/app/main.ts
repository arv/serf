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
import { loadCharacterAssets } from '../render/characters';
import { THEME, loadMedievalAssets } from '../render/medieval';

// The daylight CSS grade keys off this class (see index.html).
if (THEME === 'medieval') document.documentElement.classList.add('day');
import { Controls } from '../input/controls';
import { mountHud } from '../ui/mount';
import {
  myPlayerId,
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
  setStock,
  setTechs,
  speed,
} from '../ui/store';
import { WorldMirror } from './mirror';
import { WorkerSimHost, type AiPortHandle } from './simHost';
import { configFromUrl } from './gameConfig';
import { relayUrl, runLobby } from '../net/lobbyClient';
import type { NetInfo } from '../protocol/messages';

function fatal(message: string): never {
  const el = document.getElementById('fatal')!;
  el.style.display = 'grid';
  el.innerHTML = `<div><h1>Serf cannot start</h1><p>${message}</p></div>`;
  throw new Error(message);
}

// The sim<->render hot path runs over SharedArrayBuffer, which requires
// cross-origin isolation. Fail loudly at boot rather than mysteriously later.
if (!crossOriginIsolated) {
  fatal(
    'This page is not cross-origin isolated, so SharedArrayBuffer is unavailable. ' +
      'The server must send <code>Cross-Origin-Opener-Policy: same-origin</code> and ' +
      '<code>Cross-Origin-Embedder-Policy: require-corp</code> (vite.config.ts does this for dev).',
  );
}

/** One dedicated worker per AI seat — the brain thinks off-thread and
 * speaks ordinary commands (SP: over a MessagePort tick feed from the sim
 * worker; MP: as a headless relay client with its own seat token). */
function spawnAiWorker(): Worker {
  return new Worker(new URL('../net/aiWorker.ts', import.meta.url), { type: 'module' });
}

async function boot(): Promise<void> {
  let config = configFromUrl(location.search);
  let loadData: string | undefined;
  let net: NetInfo | undefined;
  const aiPorts: AiPortHandle[] = [];

  const params = new URLSearchParams(location.search);
  const mp = params.get('mp');
  if (mp) {
    // Multiplayer: the lobby resolves seats, the world blob, and our seat
    // token; the worker's own socket does the rest.
    const aiSeats = Math.max(0, Math.min(3, Number(params.get('ai') ?? '0') || 0));
    const lobby = await runLobby(mp, aiSeats, config.seed, relayUrl(location.search));
    config = {
      ...config,
      players: lobby.seats,
      myPlayerId: lobby.myPlayerId,
      adminEnabled: false,
    };
    loadData = lobby.worldBlob;
    net = lobby.net;
    // The host runs one brain worker per AI seat; each plays through its
    // own relay socket like any remote client.
    for (const seat of lobby.aiSeats) {
      spawnAiWorker().postMessage({
        type: 'init',
        playerId: seat.playerId,
        loadData: lobby.worldBlob,
        net: { relayUrl: lobby.net.relayUrl, token: seat.token },
      });
    }
  } else {
    // A pending load (set by the Load button before its reload) boots the
    // worker straight into the saved world. sessionStorage on purpose: it is
    // per-tab, so a second open tab (e.g. the dev preview) can never steal or
    // duplicate the handoff the way a shared localStorage key could.
    loadData = sessionStorage.getItem('serf-load-pending') ?? undefined;
    sessionStorage.removeItem('serf-load-pending');
    // Migrate away any stale handoff left by the old localStorage flow.
    localStorage.removeItem('serf-load-pending');
  }
  setMyPlayerId(config.myPlayerId);
  setNetMode(net !== undefined);

  // Single-player AI seats: pair each brain worker with the sim worker via
  // a MessageChannel (executed ticks out, that seat's commands back).
  if (!net) {
    config.players.forEach((p, playerId) => {
      if (p.kind !== 'ai') return;
      const channel = new MessageChannel();
      spawnAiWorker().postMessage(
        { type: 'init', playerId, loadData, config, port: channel.port1 },
        [channel.port1],
      );
      aiPorts.push({ playerId, port: channel.port2 });
    });
  }

  const host = new WorkerSimHost();
  // Character/building GLBs load while the worker generates the world; if
  // they fail, the renderer falls back to the procedural models.
  const [init] = await Promise.all([
    host.start(config, loadData, net, aiPorts),
    loadCharacterAssets(),
    loadMedievalAssets(),
  ]);

  const canvas = document.getElementById('canvas') as HTMLCanvasElement;
  const renderer = new GameRenderer(canvas);
  // Dev-only handles for console debugging (scene graph + the SAB reader,
  // which is where render-vs-sim questions get settled).
  if (import.meta.env.DEV) {
    Object.assign(window as unknown as Record<string, unknown>, {
      __scene: renderer.scene,
      __reader: init.reader,
    });
  }

  const mirror = new WorldMirror(init.map, init.buildings);
  const heights = new HeightField(init.map.height);
  const terrain = new TerrainMesh(init.map, heights);
  renderer.scene.add(terrain.mesh);
  const scatter = new ScatterMesh(init.map, heights);
  renderer.scene.add(scatter.group);
  const grass = new GrassField(init.map, heights);
  renderer.scene.add(grass.mesh);
  const water = new WaterMesh();
  renderer.scene.add(water.mesh);
  const mist = new Mist(init.map);
  renderer.scene.add(mist.group);

  const buildingSync = new BuildingSync(renderer.scene, heights);
  buildingSync.update(init.buildings);

  const sync = new SceneSync(renderer.scene, init.reader, heights);
  // Where the well cranks are: drawing serfs stand beside them and their
  // hand is IK-glued to the grip.
  const feedWells = (): void => sync.setWells(buildingSync.wellCranks());
  feedWells();
  const selectionFx = new SelectionFx(renderer.scene, heights);
  const ghost = new GhostPlacement(renderer.scene, heights);
  const controls = new Controls(canvas, renderer.rig.camera, sync, host, mirror, ghost, heights);

  host.onNetStatus((status) => setNetStatus(status));
  host.onStructural((msg) => {
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
    if (changes.repaint) terrain.repaintAll();
    buildingSync.update(msg.buildings);
    feedWells();
    const mine = msg.players[myPlayerId()];
    if (mine) {
      setStock(mine.stock);
      setTechs(mine.techs);
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
  });

  mountHud(host);

  // The camera never rotates: hp bars copy its live orientation once to
  // sit parallel with the screen plane.
  sync.cameraQuaternion = renderer.rig.camera.quaternion;
  buildingSync.cameraQuaternion = renderer.rig.camera.quaternion;

  function loop(): void {
    const now = performance.now();
    sync.update(now, controls.hoverUnit, controls.selected, speed() === 0);
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
