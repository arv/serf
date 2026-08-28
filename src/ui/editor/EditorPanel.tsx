import { For, Show, createSignal, onCleanup, onMount } from 'solid-js';
import { render } from 'solid-js/web';
import type { EditorActions } from '../../editor/editorScreen.ts';
import { parseEditorMap } from '../../editor/format.ts';
import { deleteMap, hasMap, listMaps, loadMap, saveBoundName } from '../../editor/storage.ts';
import {
  BRUSH_MAX,
  BRUSH_MIN,
  PALETTE,
  brushRadius,
  canRedo,
  canUndo,
  dialog,
  dirtySinceSave,
  folds,
  kaleido,
  mapName,
  mapPlayers,
  notice,
  problems,
  savedName,
  setBrushRadius,
  setDialog,
  setDirtySinceSave,
  setFolds,
  setKaleido,
  setMapName,
  setSavedName,
  setShowBounds,
  setTool,
  showBounds,
  showNotice,
  tool,
  viewMode,
} from '../../editor/uiState.ts';
import { DEFAULT_MAP_SIZE, MAX_MAP_SIZE, MIN_MAP_SIZE, marginFor } from '../../shared/grid.ts';
import * as PlayerKind from '../../sim/playerKindEnum.ts';
import * as ViewMode from '../../render/viewModeEnum.ts';

/**
 * The editor's whole DOM overlay: tool palette on the left, the session
 * bar up top, files/dialogs on the right, problems and notices at the
 * bottom. Mounted into #ui by the editor screen; the Hud never mounts
 * here, so this panel carries its own copy of the glass recipe (the
 * `#ui .panel` rules live inside Hud.tsx's style block).
 */
export function mountEditorUi(actions: EditorActions): () => void {
  const host = document.getElementById('ui');
  if (!host) return () => undefined;
  return render(() => <EditorUi actions={actions} />, host);
}

const GROUP_TITLES: Record<string, string> = {
  terrain: 'Terrain',
  resource: 'Resources',
  height: 'Elevation',
  start: 'Players',
};

function EditorUi(props: { actions: EditorActions }) {
  const groups = ['terrain', 'resource', 'height', 'start'] as const;

  let filePick: HTMLInputElement | undefined;
  const importFile = (file: File): void => {
    file
      .text()
      .then((text) => {
        const state = parseEditorMap(text);
        // A file is not a slot: the map opens unbound, so the first Save
        // asks where it should live rather than overwriting whatever was
        // open before.
        props.actions.replaceState(state, null);
        setDialog(null);
        showNotice(`Opened "${state.name}" — Save to keep it in the browser`);
      })
      .catch((err: unknown) => {
        showNotice(err instanceof Error ? err.message : 'could not read that file');
      });
  };

  const confirmDiscard = (): boolean =>
    !dirtySinceSave() || window.confirm('Discard unsaved changes to this map?');

  /** Does Save write without asking? (Bound, and still under that name.) */
  const savesStraightBack = (): boolean => savedName() !== null && mapName().trim() === savedName();

  return (
    <div class="ed-root">
      <style>{STYLE}</style>

      {/* ——— left: tool palette ——— */}
      <div class="ed-tools panel">
        <For each={[...groups]}>
          {(group) => (
            <div class="ed-group">
              <h4>{GROUP_TITLES[group]}</h4>
              <For each={PALETTE.filter((p) => p.group === group)}>
                {(entry) => (
                  <button
                    classList={{ active: tool() === entry.tool }}
                    title={`${entry.label} (${entry.key.toUpperCase()})`}
                    onClick={() => setTool(entry.tool)}
                  >
                    <span class="kbd">{entry.key.toUpperCase()}</span> {entry.label}
                  </button>
                )}
              </For>
            </div>
          )}
        </For>
      </div>

      {/* ——— top: session bar ——— */}
      <div class="ed-top panel">
        <input
          class="ed-name"
          aria-label="Map name"
          title="The map’s name — rename it and the next Save asks where to keep it"
          value={mapName()}
          maxLength={40}
          onInput={(e) => {
            setMapName(e.currentTarget.value);
            setDirtySinceSave(true);
          }}
        />
        <button
          class="ed-hist"
          disabled={!canUndo()}
          title="Undo (Ctrl+Z)"
          onClick={() => props.actions.undo()}
        >
          ↶
        </button>
        <button
          class="ed-hist"
          disabled={!canRedo()}
          title="Redo (Ctrl+Shift+Z)"
          onClick={() => props.actions.redo()}
        >
          ↷
        </button>
        <label class="ed-brush">
          Brush {brushRadius()}
          <input
            type="range"
            min={BRUSH_MIN}
            max={BRUSH_MAX}
            value={brushRadius()}
            onInput={(e) => setBrushRadius(Number(e.currentTarget.value))}
          />
        </label>
        <div class="ed-kaleido">
          <button
            classList={{ active: kaleido() }}
            title="Kaleidoscope (K): every stroke paints once per fold, rotated around the map's center"
            onClick={() => setKaleido(!kaleido())}
          >
            ❋ Kaleidoscope
          </button>
          <Show when={kaleido()}>
            <For each={[1, 2, 3, 4]}>
              {(n) => (
                <button
                  class="ed-fold"
                  classList={{ active: folds() === n }}
                  title={
                    n === mapPlayers()
                      ? `${String(n)}× — matches this map's seats`
                      : `${String(n)}×`
                  }
                  onClick={() => setFolds(n)}
                >
                  {n}×
                </button>
              )}
            </For>
          </Show>
        </div>
        <button
          title="Toggle perspective (V): straight-down plan view or the game's own camera"
          onClick={() => props.actions.toggleView()}
        >
          {viewMode() === ViewMode.topDown ? 'View: top-down' : 'View: game'}
        </button>
        <button
          classList={{ active: showBounds() }}
          title="Play area (B): outline the playable square and press the scenery ring back"
          onClick={() => setShowBounds(!showBounds())}
        >
          ⬚ Play area
        </button>
      </div>

      {/* ——— right: files & play ——— */}
      <div class="ed-files panel">
        <button
          title="Start a blank map — unsaved changes are confirmed first"
          onClick={() => {
            if (confirmDiscard()) setDialog('new');
          }}
        >
          New…
        </button>
        <button title="Open a saved map, or a map file (Ctrl+O)" onClick={() => setDialog('open')}>
          Open…
        </button>
        <button
          title={
            savesStraightBack()
              ? `Save over “${savedName() ?? ''}” (Ctrl+S)`
              : 'Save this map in the browser — asks for a name (Ctrl+S)'
          }
          onClick={() => props.actions.save()}
        >
          Save
          <Show when={dirtySinceSave()}>
            <span class="ed-dot" aria-label="unsaved changes">
              {' '}
              •
            </span>
          </Show>
        </button>
        <button title="Save under a new name (Ctrl+Shift+S)" onClick={() => setDialog('saveAs')}>
          Save as…
        </button>
        <button
          title="Download this map as a .serfmap.json file"
          onClick={() => props.actions.exportMap()}
        >
          Export…
        </button>
        <button
          title="Re-derive heights from the painted terrain the way worldgen shapes its own maps: lake beds shelve, meadows ease toward shores, gentle hills roll in. One undoable step."
          onClick={() => props.actions.naturalize()}
        >
          ✦ Naturalize
        </button>
        <button
          class="ed-play"
          classList={{ active: problems().length === 0 }}
          disabled={problems().length > 0}
          title={problems().length > 0 ? problems().join('\n') : 'Launch a match on this map'}
          onClick={() => setDialog('play')}
        >
          ▶ Play…
        </button>
        <input
          ref={filePick}
          type="file"
          accept=".json,application/json"
          style="display:none"
          onChange={(e) => {
            const file = e.currentTarget.files?.[0];
            e.currentTarget.value = '';
            if (file) importFile(file);
          }}
        />
      </div>

      {/* ——— bottom: problems + notice ——— */}
      <Show when={problems().length > 0}>
        <div class="ed-problems panel">
          <For each={problems()}>{(p) => <div>⚠ {p}</div>}</For>
        </div>
      </Show>
      <Show when={notice()}>
        <div class="ed-notice panel">{notice()}</div>
      </Show>

      <Show when={dialog() === 'new'}>
        <NewMapDialog actions={props.actions} />
      </Show>
      <Show when={dialog() === 'open'}>
        <OpenDialog
          actions={props.actions}
          confirmDiscard={confirmDiscard}
          pickFile={() => filePick?.click()}
        />
      </Show>
      <Show when={dialog() === 'saveAs'}>
        <SaveAsDialog actions={props.actions} />
      </Show>
      <Show when={dialog() === 'play'}>
        <PlayDialog actions={props.actions} />
      </Show>
    </div>
  );
}

function NewMapDialog(props: { actions: EditorActions }) {
  const [size, setSize] = createSignal(DEFAULT_MAP_SIZE);
  const [players, setPlayers] = createSignal(mapPlayers());
  return (
    <Dialog title="New map">
      <label class="ed-row">
        Playable {size()}×{size()}
        <input
          type="range"
          min={MIN_MAP_SIZE}
          max={MAX_MAP_SIZE}
          step={2}
          value={size()}
          onInput={(e) => setSize(Number(e.currentTarget.value))}
        />
      </label>
      <div class="ed-dim">
        A scenery ring {marginFor(size())} tiles deep surrounds it — paintable, unwalkable.
      </div>
      <div class="ed-row">
        Players
        <div class="ed-seg">
          <For each={[1, 2, 3, 4]}>
            {(n) => (
              <button classList={{ active: players() === n }} onClick={() => setPlayers(n)}>
                {n}
              </button>
            )}
          </For>
        </div>
      </div>
      <div class="ed-row ed-actions">
        <button onClick={() => setDialog(null)}>Cancel</button>
        <button
          class="active"
          onClick={() => {
            setDialog(null);
            props.actions.newMap(size(), players());
          }}
        >
          Create
        </button>
      </div>
    </Dialog>
  );
}

function OpenDialog(props: {
  actions: EditorActions;
  confirmDiscard: () => boolean;
  pickFile: () => void;
}) {
  const [names, setNames] = createSignal(listMaps());
  return (
    <Dialog title="Open a map">
      <Show when={names().length === 0}>
        <div class="ed-dim">Nothing saved in this browser yet — “Save” keeps a map here.</div>
      </Show>
      <For each={names()}>
        {(name) => (
          <div class="ed-row ed-slot">
            <span class="ed-slot-name" classList={{ current: name === savedName() }}>
              {name}
            </span>
            <button
              onClick={() => {
                if (!props.confirmDiscard()) return;
                const loaded = loadMap(name);
                if (!loaded) {
                  showNotice(`could not open "${name}"`);
                  return;
                }
                setDialog(null);
                props.actions.replaceState(loaded, name);
                showNotice(`Opened "${name}"`);
              }}
            >
              Open
            </button>
            <button
              onClick={() => {
                if (!window.confirm(`Delete "${name}"?`)) return;
                deleteMap(name);
                // The map on screen just lost its slot: unbind it so Save
                // asks for a name instead of silently re-creating what was
                // deleted.
                if (savedName() === name) {
                  setSavedName(null);
                  saveBoundName(null);
                  setDirtySinceSave(true);
                }
                setNames(listMaps());
              }}
            >
              Delete
            </button>
          </div>
        )}
      </For>
      <div class="ed-row ed-actions">
        <button onClick={() => setDialog(null)}>Cancel</button>
        <button
          onClick={() => {
            if (props.confirmDiscard()) props.pickFile();
          }}
        >
          Open file…
        </button>
      </div>
    </Dialog>
  );
}

function SaveAsDialog(props: { actions: EditorActions }) {
  const [name, setName] = createSignal(mapName().trim() || 'Untitled');
  // Read the slot list once, on open: it feeds a per-keystroke check.
  const existing = listMaps();
  let field: HTMLInputElement | undefined;
  onMount(() => {
    field?.focus();
    field?.select();
  });
  const taken = (): boolean => {
    const n = name().trim();
    return n !== '' && n !== savedName() && existing.includes(n);
  };
  const commit = (): void => {
    const n = name().trim();
    if (n === '') {
      showNotice('A map needs a name');
      return;
    }
    // Asked of storage, not of the list read when the dialog opened: a
    // name free a minute ago can have been taken by another tab since.
    if (n !== savedName() && hasMap(n) && !window.confirm(`Replace the saved map “${n}”?`)) {
      return;
    }
    // Only close on a save that landed — a full quota leaves the dialog
    // standing (with the name still typed in it) to try again.
    if (props.actions.saveToSlot(n)) setDialog(null);
  };
  return (
    <Dialog title="Save map as">
      <label class="ed-row">
        Name
        <input
          ref={field}
          class="ed-seed ed-save-name"
          aria-label="Save as name"
          value={name()}
          maxLength={40}
          onInput={(e) => setName(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit();
          }}
        />
      </label>
      <Show when={taken()}>
        <div class="ed-dim">“{name().trim()}” already exists — saving replaces it.</div>
      </Show>
      <Show when={existing.length > 0}>
        <div class="ed-dim ed-existing">Already saved: {existing.join(', ')}</div>
      </Show>
      <div class="ed-row ed-actions">
        <button onClick={() => setDialog(null)}>Cancel</button>
        <button class="active" onClick={commit}>
          Save
        </button>
      </div>
    </Dialog>
  );
}

function PlayDialog(props: { actions: EditorActions }) {
  const [seed, setSeed] = createSignal(String(Math.floor(Math.random() * 1_000_000)));
  const [bandits, setBandits] = createSignal(true);
  const seats = mapPlayers();
  return (
    <Dialog title="Playtest this map">
      <div class="ed-dim">
        You take seat 1{seats > 1 ? `; seats 2–${String(seats)} play as AI rivals.` : '.'}
      </div>
      <label class="ed-row">
        Seed
        <input
          class="ed-seed"
          value={seed()}
          inputmode="numeric"
          onInput={(e) => setSeed(e.currentTarget.value)}
        />
      </label>
      <div class="ed-row">
        Bandits
        <div class="ed-seg">
          <button classList={{ active: bandits() }} onClick={() => setBandits(true)}>
            on
          </button>
          <button classList={{ active: !bandits() }} onClick={() => setBandits(false)}>
            off
          </button>
        </div>
      </div>
      <div class="ed-row ed-actions">
        <button onClick={() => setDialog(null)}>Cancel</button>
        <button
          class="active"
          onClick={() => {
            const parsed = Number(seed());
            props.actions.play({
              seed: Number.isFinite(parsed) ? parsed : 1,
              players: Array.from({ length: seats }, (_, i) =>
                i === 0 ? { kind: PlayerKind.human } : { kind: PlayerKind.ai },
              ),
              banditsEnabled: bandits(),
            });
          }}
        >
          Launch
        </button>
      </div>
    </Dialog>
  );
}

function Dialog(props: { title: string; children?: unknown }) {
  let card: HTMLDivElement | undefined;
  // Escape closes, and focus lands inside so keyboard users are IN the
  // dialog rather than tabbing the panel behind the scrim. (Not a full
  // focus trap; the scrim blocks pointer access to everything else.)
  onMount(() => {
    // Unless a child already claimed focus (Save as puts the caret in its
    // name field, and stealing it back would make the dialog untypeable).
    if (!card?.contains(document.activeElement)) card?.focus();
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setDialog(null);
    };
    window.addEventListener('keydown', onKey);
    onCleanup(() => window.removeEventListener('keydown', onKey));
  });
  return (
    <>
      <div class="ed-scrim" onClick={() => setDialog(null)} />
      <div
        class="ed-dialog panel"
        role="dialog"
        aria-modal="true"
        aria-label={props.title}
        tabindex="-1"
        ref={card}
      >
        <h3>{props.title}</h3>
        {props.children as never}
      </div>
    </>
  );
}

const STYLE = `
  /* The Hud's glass recipe, carried by the editor itself: this screen
     mounts into #ui without the Hud (whose style block owns these rules
     in a match). */
  #ui { font-family: 'Space Grotesk', system-ui, sans-serif; }
  #ui .panel {
    background: rgba(14, 16, 15, 0.72);
    -webkit-backdrop-filter: blur(14px);
    backdrop-filter: blur(14px);
    border: 1px solid rgba(255, 255, 255, 0.09);
    border-radius: 14px;
    box-shadow: 0 4px 24px rgba(0, 0, 0, 0.35);
    color: #eceade;
    font-size: 13px;
  }
  #ui button {
    font-family: inherit;
    font-size: 13px;
    font-weight: 500;
    color: #eceade;
    background: rgba(255, 255, 255, 0.06);
    border: 1px solid rgba(255, 255, 255, 0.14);
    border-radius: 10px;
    padding: 7px 12px;
    cursor: pointer;
    transition: background 0.15s, border-color 0.15s, color 0.15s;
  }
  #ui button:hover:not(:disabled) {
    background: rgba(229, 196, 105, 0.14);
    border-color: rgba(229, 196, 105, 0.45);
  }
  #ui button:disabled {
    cursor: default;
    color: #6d6f68;
    background: rgba(255, 255, 255, 0.025);
    border-style: dashed;
    border-color: rgba(255, 255, 255, 0.12);
  }
  #ui button.active,
  #ui button.active:hover:not(:disabled) {
    background: rgba(229, 196, 105, 0.3);
    border-color: #e5c469;
  }
  #ui button:focus-visible { outline: 2px solid #e5c469; outline-offset: 2px; }
  #ui .kbd { font-weight: 700; color: #e5c469; }

  .ed-tools {
    position: absolute; top: 64px; left: 10px; padding: 10px;
    pointer-events: auto; display: flex; flex-direction: column; gap: 8px;
    max-height: calc(100vh - 84px); overflow-y: auto;
  }
  .ed-group { display: flex; flex-direction: column; gap: 4px; }
  .ed-group h4 {
    margin: 2px 0; font-size: 11px; color: #b6b3a6;
    font-variant: small-caps; letter-spacing: 0.08em; font-weight: 600;
  }
  .ed-group button { text-align: left; font-size: 12px; padding: 5px 9px; }

  .ed-top {
    position: absolute; top: 10px; left: 50%; transform: translateX(-50%);
    padding: 8px 12px; pointer-events: auto;
    display: flex; align-items: center; gap: 12px; white-space: nowrap;
  }
  .ed-name {
    font-family: inherit; font-size: 13px; font-weight: 600; color: #eceade;
    background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.14);
    border-radius: 8px; padding: 5px 9px; width: 150px;
  }
  .ed-hist { padding: 5px 9px; font-size: 14px; line-height: 1; }
  .ed-brush { display: flex; align-items: center; gap: 8px; font-size: 12px; color: #b6b3a6; }
  .ed-brush input { accent-color: #e5c469; width: 110px; }
  .ed-kaleido { display: flex; align-items: center; gap: 4px; }
  .ed-fold { padding: 5px 8px; font-size: 12px; }

  .ed-files {
    position: absolute; top: 10px; right: 10px; padding: 8px;
    pointer-events: auto; display: flex; flex-direction: column; gap: 6px; min-width: 110px;
  }
  /* Unsaved-changes pip on the Save button. */
  .ed-dot { color: #e5c469; font-weight: 700; }
  .ed-play { font-weight: 700; }

  .ed-problems {
    position: absolute; left: 10px; bottom: 12px; padding: 8px 12px;
    pointer-events: auto; display: flex; flex-direction: column; gap: 3px;
    font-size: 12px; color: #e8b46a; border-color: rgba(232, 180, 106, 0.5);
  }
  .ed-notice {
    position: absolute; left: 50%; bottom: 18px; transform: translateX(-50%);
    padding: 9px 16px; pointer-events: none; font-size: 13px; z-index: 36;
  }

  .ed-scrim {
    position: absolute; inset: 0; background: rgba(8, 9, 8, 0.55);
    pointer-events: auto; z-index: 19;
  }
  .ed-dialog {
    position: absolute; left: 50%; top: 46%; transform: translate(-50%, -50%);
    padding: 16px 18px; pointer-events: auto; z-index: 20;
    display: flex; flex-direction: column; gap: 12px; min-width: 300px;
  }
  .ed-dialog h3 {
    margin: 0; font-size: 15px; color: #e5c469;
    font-family: Georgia, 'Times New Roman', serif;
    font-variant: small-caps; letter-spacing: 0.08em;
  }
  .ed-row { display: flex; align-items: center; gap: 10px; justify-content: space-between; font-size: 13px; }
  .ed-row input[type=range] { accent-color: #e5c469; flex: 1; }
  .ed-seg { display: flex; gap: 4px; }
  .ed-actions { justify-content: flex-end; }
  .ed-dim { font-size: 12px; color: #b6b3a6; }
  .ed-existing { max-width: 320px; }
  .ed-slot { justify-content: flex-start; }
  .ed-slot-name { flex: 1; overflow: hidden; text-overflow: ellipsis; }
  .ed-slot-name.current { color: #e5c469; }
  .ed-save-name { width: 170px; }
  .ed-seed {
    font-family: inherit; font-size: 13px; color: #eceade;
    background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.14);
    border-radius: 8px; padding: 5px 9px; width: 120px;
  }
`;
