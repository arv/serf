import { GameRenderer } from '../render/renderer';
import { TerrainMesh } from '../render/terrainMesh';
import { ScatterMesh } from '../render/scatterMesh';
import { GrassField } from '../render/grassField';
import { WaterMesh } from '../render/waterMesh';
import { MarginMesh } from '../render/marginMesh';
import { HeightField } from '../render/heightField';
import { loadGlbAssets } from '../render/assets';
import { disposeOwnedSubtree } from '../render/disposal';
import { goto } from '../app/router';
import { serializeWorld } from '../sim/save.ts';
import { DEFAULT_MAP_SIZE, tileX, tileY } from '../shared/grid.ts';
import { Terrain, TileResource, playEdgeDist, type StartSpot } from '../sim/map.ts';
import { HEIGHT_STEP, applyStroke, type Tool } from './brush.ts';
import { BrushCursor } from './brushCursor.ts';
import { EditorControls, type EditorSurface } from './editorControls.ts';
import {
  createBlankMap,
  startSpotLegal,
  validateForPlay,
  type EditorMapState,
} from './editorMap.ts';
import { serializeEditorMap } from './format.ts';
import { StartMarkers } from './markers.ts';
import { worldFromEditor, type EditorPlayConfig } from './playWorld.ts';
import { loadDraft, saveDraft } from './storage.ts';
import { rotateStart } from './symmetry.ts';
import {
  activeFolds,
  brushRadius,
  kaleido,
  mapName,
  resetEditorUiState,
  setDirtySinceSave,
  setProblems,
  setViewMode,
  showNotice,
  viewMode,
} from './uiState.ts';

/** Everything the Solid panel can ask the screen to do. */
export interface EditorActions {
  newMap(size: number, players: number): void;
  toggleView(): void;
  exportMap(): void;
  /** Swap in a parsed state (Import, Maps... load) and rebuild the scene. */
  replaceState(state: EditorMapState): void;
  /** The live state with panel-owned fields (name) folded in. */
  currentState(): EditorMapState;
  play(cfg: EditorPlayConfig): void;
}

/** How long after the last stamp the heavy foliage rebuild waits. */
const FOLIAGE_DEBOUNCE_MS = 400;
const DRAFT_DEBOUNCE_MS = 2000;

/**
 * ?editor — the map editor screen. The full game render stack over an
 * authored GameMap with no sim worker (menuBackdrop's trick: a GameMap
 * satisfies MapView), a top-down camera by default, and a Solid panel in
 * #ui. Painting flows: stroke -> map arrays -> per-frame incremental
 * repaint/reheight -> debounced foliage rebuild.
 */
export async function mountEditor(canvas: HTMLCanvasElement): Promise<{
  key: string;
  dispose(): void;
}> {
  await loadGlbAssets();

  const teardown: (() => void)[] = [];
  let over = false;
  const screen = {
    key: 'editor',
    dispose(): void {
      over = true;
      while (teardown.length > 0) {
        try {
          teardown.pop()!();
        } catch (err) {
          console.warn('[editor] teardown step failed:', err);
        }
      }
    },
  };

  let state = loadDraft() ?? createBlankMap({ size: DEFAULT_MAP_SIZE, players: 2 });
  resetEditorUiState(state);

  const off = new AbortController();
  teardown.push(() => off.abort());
  // Same context discipline as a match: the canvas hands out one WebGL
  // context ever, so the next screen needs a fresh element.
  teardown.push(() => canvas.replaceWith(canvas.cloneNode(false)));
  const renderer = new GameRenderer(canvas, true);
  teardown.push(() => renderer.dispose());
  // The editor's zoom bounds cover the whole grid (setPlayBounds below
  // widens the pan box to match), so the entire world fits in one frame.
  renderer.rig.setMaxViewFraction(1.0);
  renderer.rig.setViewMode(viewMode());

  // Editing survives a lost context: the draft is saved on every pause
  // anyway, so the recovery is simply a reload back into ?editor.
  let restoreTimer: ReturnType<typeof setTimeout> | undefined;
  canvas.addEventListener(
    'webglcontextlost',
    () => {
      if (over) return;
      saveDraft(currentState());
      restoreTimer = setTimeout(() => location.reload(), 3000);
    },
    { signal: off.signal },
  );
  canvas.addEventListener('webglcontextrestored', () => clearTimeout(restoreTimer), {
    signal: off.signal,
  });
  teardown.push(() => clearTimeout(restoreTimer));

  // Floating DOM labels (seat names) ride above the canvas, wardrobe-style.
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:absolute;inset:0;overflow:hidden;pointer-events:none';
  document.body.appendChild(overlay);
  teardown.push(() => overlay.remove());

  /** The scene content for one map; rebuilt whole on New/Import. */
  interface SceneBundle {
    heights: HeightField;
    terrain: TerrainMesh;
    water: WaterMesh;
    margin: MarginMesh;
    scatter: ScatterMesh;
    grass: GrassField;
    markers: StartMarkers;
    cursor: BrushCursor;
    controls: EditorControls;
  }
  let sc: SceneBundle | null = null;

  // ---- painting pipeline ---------------------------------------------------

  const pendingRepaint = new Set<number>();
  const pendingReheight = new Set<number>();
  let marginTouched = false;
  let foliageTimer: ReturnType<typeof setTimeout> | undefined;
  let draftTimer: ReturnType<typeof setTimeout> | undefined;
  teardown.push(() => clearTimeout(foliageTimer));
  teardown.push(() => clearTimeout(draftTimer));

  const scheduleFoliage = (): void => {
    clearTimeout(foliageTimer);
    foliageTimer = setTimeout(() => {
      if (over || !sc) return;
      rebuildFoliage();
    }, FOLIAGE_DEBOUNCE_MS);
  };
  // (marginTouched rides the same debounce: rebuildFoliage folds it in.)

  const markDirty = (): void => {
    setDirtySinceSave(true);
    clearTimeout(draftTimer);
    draftTimer = setTimeout(() => {
      if (!over) saveDraft(currentState());
    }, DRAFT_DEBOUNCE_MS);
  };

  const refreshProblems = (): void => {
    setProblems(validateForPlay(currentState()));
  };

  function rebuildFoliage(): void {
    if (!sc) return;
    disposeOwnedSubtree(sc.scatter.group);
    disposeOwnedSubtree(sc.grass.mesh);
    sc.scatter = new ScatterMesh(state.map, sc.heights);
    sc.grass = new GrassField(state.map, sc.heights);
    renderer.scene.add(sc.scatter.group, sc.grass.mesh);
    if (marginTouched) {
      // The margin mesh is static by design (nothing changes it in a
      // match); the editor is the one place it needs rebuilding — one
      // coarse vertex per tile, cheap at this cadence.
      marginTouched = false;
      disposeOwnedSubtree(sc.margin.mesh);
      sc.margin = new MarginMesh(state.map, sc.heights);
      renderer.scene.add(sc.margin.mesh);
    }
    sc.markers.refreshHeights();
  }

  const surface: EditorSurface = {
    state: () => state,
    stroke(t: Tool, x0, y0, x1, y1): void {
      if (!sc) return;
      const dirty = applyStroke(state, t, x0, y0, x1, y1, {
        radius: brushRadius(),
        folds: activeFolds(),
        strength: HEIGHT_STEP,
      });
      if (dirty.length === 0) return;
      const wantsReheight = t.kind !== 'resource';
      for (const i of dirty) {
        (wantsReheight ? pendingReheight : pendingRepaint).add(i);
        // A stroke in the scenery ring — or near enough that the margin
        // mesh's boundary tuck reads it — re-bakes the coarse mesh.
        if (playEdgeDist(state.map, tileX(i, state.map.size), tileY(i, state.map.size)) < 3) {
          marginTouched = true;
        }
        // Standing props react immediately where something vanished; what
        // GREW waits for the debounced rebuild.
        if (state.map.resource[i] === TileResource.None) sc.scatter.removeTile(i);
        if (state.map.terrain[i] !== Terrain.Grass) sc.grass.removeTile(i);
      }
      scheduleFoliage();
      markDirty();
    },
    strokeEnd(): void {
      sc?.terrain.refreshBounds();
      refreshProblems();
    },
    moveStart(seat: number, spot: StartSpot): void {
      if (!sc) return;
      const players = state.players;
      if (kaleido() && players > 1 && activeFolds() === players) {
        // The dragged seat leads; every other seat is its rotation image.
        for (let k = 0; k < players; k++) {
          const target = (seat + k) % players;
          const s = rotateStart(spot, state.map.size, k, players);
          state.starts[target] = s;
          sc.markers.moveSeat(target, s, startSpotLegal(state.map, s));
        }
      } else {
        state.starts[seat] = { ...spot };
        sc.markers.moveSeat(seat, spot, startSpotLegal(state.map, spot));
      }
      markDirty();
    },
    startDragEnd(): void {
      if (!sc) return;
      for (let p = 0; p < state.players; p++) sc.markers.clearTint(p);
      refreshProblems();
    },
    toggleView(): void {
      const next = viewMode() === 'topDown' ? 'game' : 'topDown';
      setViewMode(next);
      renderer.rig.setViewMode(next);
    },
  };

  // ---- scene lifecycle -----------------------------------------------------

  function buildScene(): void {
    const map = state.map;
    renderer.setWorldExtent(map.play, map.size);
    // The game bounds its camera to the play square; an author needs to
    // reach the scenery ring too — it is real, paintable ground here.
    renderer.rig.setPlayBounds(0, map.size);
    const heights = new HeightField(map.height, map.size);
    const terrain = new TerrainMesh(map, heights);
    const water = new WaterMesh(map);
    const margin = new MarginMesh(map, heights);
    const scatter = new ScatterMesh(map, heights);
    const grass = new GrassField(map, heights);
    renderer.scene.add(
      terrain.mesh,
      water.mesh,
      margin.mesh,
      scatter.group,
      grass.mesh,
    );
    const markers = new StartMarkers(renderer.scene, heights, overlay);
    markers.set(state.starts);
    const cursor = new BrushCursor(renderer.scene, heights);
    const controls = new EditorControls(canvas, renderer.rig, heights, cursor, markers, surface);
    sc = { heights, terrain, water, margin, scatter, grass, markers, cursor, controls };
    // Open framing the play square plus a strip of scenery.
    renderer.rig.focusOn(map.size / 2, map.size / 2, Math.round(map.play * 1.1));
    refreshProblems();
  }

  function tearDownScene(): void {
    if (!sc) return;
    sc.controls.dispose();
    sc.cursor.dispose();
    sc.markers.clear();
    disposeOwnedSubtree(sc.scatter.group);
    disposeOwnedSubtree(sc.grass.mesh);
    disposeOwnedSubtree(sc.margin.mesh);
    disposeOwnedSubtree(sc.terrain.mesh);
    sc.water.dispose();
    sc = null;
  }
  teardown.push(tearDownScene);

  /** The live state with panel-owned fields (name) folded in. */
  function currentState(): EditorMapState {
    state.name = mapName();
    return state;
  }

  function replaceState(next: EditorMapState): void {
    clearTimeout(foliageTimer);
    pendingRepaint.clear();
    pendingReheight.clear();
    marginTouched = false;
    tearDownScene();
    state = next;
    resetEditorUiState(state);
    buildScene();
    saveDraft(state);
  }

  // ---- actions for the panel ----------------------------------------------

  const actions: EditorActions = {
    newMap(size, players): void {
      replaceState(createBlankMap({ size, players }));
      showNotice(
        `New map: ${String(state.map.play)}×${String(state.map.play)} playable for ${String(state.players)} player(s)`,
      );
    },
    toggleView: () => surface.toggleView(),
    exportMap(): void {
      const json = serializeEditorMap(currentState());
      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      const safe = mapName().trim().replace(/[^\w-]+/g, '_') || 'map';
      a.download = `${safe}.serfmap.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      setDirtySinceSave(false);
      showNotice('Map exported');
    },
    replaceState,
    currentState,
    play(cfg): void {
      const problems = validateForPlay(currentState());
      if (problems.length > 0) {
        setProblems(problems);
        showNotice(problems[0]!);
        return;
      }
      saveDraft(currentState());
      try {
        const world = worldFromEditor(currentState(), cfg);
        sessionStorage.setItem('serf-load-pending', serializeWorld(world));
      } catch (err) {
        showNotice(err instanceof Error ? err.message : String(err));
        return;
      }
      goto(`?seed=${String(cfg.seed)}&size=${String(state.map.play)}`);
    },
  };

  // Solid panel into #ui (dynamic import keeps solid's editor chunk lazy).
  const { mountEditorUi } = await import('../ui/editor/EditorPanel');
  const unmountUi = mountEditorUi(actions);
  teardown.push(unmountUi);

  buildScene();

  // ---- frame loop ----------------------------------------------------------

  let raf = 0;
  const loop = (): void => {
    if (over) return;
    if (sc) {
      if (pendingReheight.size > 0) {
        sc.terrain.reheightTiles([...pendingReheight]);
        sc.water.refreshBed();
        pendingReheight.clear();
      }
      if (pendingRepaint.size > 0) {
        sc.terrain.repaintTiles([...pendingRepaint]);
        pendingRepaint.clear();
      }
      sc.water.update(performance.now());
      renderer.frame();
      sc.markers.updateLabels(renderer.rig.camera, canvas);
    }
    raf = requestAnimationFrame(loop);
  };
  raf = requestAnimationFrame(loop);
  teardown.push(() => cancelAnimationFrame(raf));
  // The freshest strokes still reach storage when the page closes.
  teardown.push(() => saveDraft(currentState()));

  return screen;
}
