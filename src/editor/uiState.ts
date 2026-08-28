import type { Enum } from '../shared/enum.ts';
import { createSignal } from 'solid-js';
import type { Tool } from './brush.ts';
import * as Terrain from '../sim/terrainEnum.ts';
import * as TileResource from '../sim/tileResourceEnum.ts';
import * as ViewMode from '../render/viewModeEnum.ts';

type ViewMode = Enum<typeof ViewMode>;

/**
 * The editor's UI state as module-level signals — the store.ts pattern:
 * the Solid panel and the plain-DOM controls read the same accessors, so
 * a hotkey and a button press are indistinguishable.
 */

/** The palette's tools plus the start-mover (which paints nothing). */
export type EditorTool = Tool | { kind: 'start' };

export interface PaletteEntry {
  key: string;
  label: string;
  group: 'terrain' | 'resource' | 'height' | 'start';
  tool: EditorTool;
}

/**
 * One list drives the buttons AND the hotkeys, and every setTool passes
 * these exact objects — so the active-tool check is plain identity.
 */
export const PALETTE: PaletteEntry[] = [
  { key: '1', label: 'Grass', group: 'terrain', tool: { kind: 'terrain', terrain: Terrain.Grass } },
  { key: '2', label: 'Water', group: 'terrain', tool: { kind: 'terrain', terrain: Terrain.Water } },
  { key: '3', label: 'Rock', group: 'terrain', tool: { kind: 'terrain', terrain: Terrain.Rock } },
  {
    key: '4',
    label: 'Trees',
    group: 'resource',
    tool: { kind: 'resource', res: TileResource.Wood },
  },
  {
    key: '5',
    label: 'Stone',
    group: 'resource',
    tool: { kind: 'resource', res: TileResource.Rock },
  },
  {
    key: '6',
    label: 'Iron',
    group: 'resource',
    tool: { kind: 'resource', res: TileResource.IronDep },
  },
  {
    key: '7',
    label: 'Silver',
    group: 'resource',
    tool: { kind: 'resource', res: TileResource.SilverDep },
  },
  {
    key: '8',
    label: 'Gold',
    group: 'resource',
    tool: { kind: 'resource', res: TileResource.GoldDep },
  },
  {
    key: '9',
    label: 'Erase',
    group: 'resource',
    tool: { kind: 'resource', res: TileResource.None },
  },
  { key: 'r', label: 'Raise', group: 'height', tool: { kind: 'height', dir: 1 } },
  { key: 'f', label: 'Lower', group: 'height', tool: { kind: 'height', dir: -1 } },
  { key: 'n', label: 'Roughen', group: 'height', tool: { kind: 'noise' } },
  { key: 's', label: 'Starts', group: 'start', tool: { kind: 'start' } },
];

export const [tool, setTool] = createSignal<EditorTool>(PALETTE[0]!.tool);
export const [brushRadius, setBrushRadius] = createSignal(3);
export const BRUSH_MIN = 1;
export const BRUSH_MAX = 12;
export const [kaleido, setKaleido] = createSignal(true);
/** Fold count 1..4; New re-defaults it to the map's player count. */
export const [folds, setFolds] = createSignal(2);
export const [viewMode, setViewMode] = createSignal<ViewMode>(ViewMode.topDown);
/** The play-area boundary band + margin veil (B toggles it). */
export const [showBounds, setShowBounds] = createSignal(true);
/** History depth flags, kept fresh by the screen after every action. */
export const [canUndo, setCanUndo] = createSignal(false);
export const [canRedo, setCanRedo] = createSignal(false);
export const [dialog, setDialog] = createSignal<'new' | 'play' | 'open' | 'saveAs' | null>(null);
/** validateForPlay's output, refreshed after every stroke that could change it. */
export const [problems, setProblems] = createSignal<string[]>([]);
/** Editor-local toasts (the HUD's live in match state we never mount). */
export const [notice, setNoticeRaw] = createSignal<string | null>(null);
export const [mapName, setMapName] = createSignal('Untitled');
export const [mapPlayers, setMapPlayers] = createSignal(2);
export const [dirtySinceSave, setDirtySinceSave] = createSignal(false);
/**
 * The saved slot this map is bound to — what Save writes without asking.
 * Null for a map that has never been saved (Save then means "Save as").
 */
export const [savedName, setSavedName] = createSignal<string | null>(null);

let noticeTimer: ReturnType<typeof setTimeout> | undefined;
export function showNotice(text: string): void {
  setNoticeRaw(text);
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => setNoticeRaw(null), 3200);
}

/** The kaleidoscope replication the brush actually applies right now. */
export function activeFolds(): number {
  return kaleido() ? folds() : 1;
}

/**
 * Fresh-mount defaults (screens can remount within one page lifetime).
 * `boundName` is the saved slot this map came from, if any — opening one
 * binds Save to it; New and a file import leave it unbound.
 */
export function resetEditorUiState(
  state: { players: number; name: string },
  boundName: string | null = null,
): void {
  setDialog(null);
  setProblems([]);
  setNoticeRaw(null);
  setMapName(state.name);
  setMapPlayers(state.players);
  setFolds(Math.max(1, Math.min(4, state.players)));
  setKaleido(state.players > 1);
  setDirtySinceSave(false);
  setSavedName(boundName);
}
