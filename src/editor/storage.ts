import type { EditorMapState } from './editorMap.ts';
import { parseEditorMap, serializeEditorMap } from './format.ts';

/**
 * Editor persistence: one auto-saved draft (survives Play round-trips and
 * reloads) plus named slots. Everything is stored as the map file format,
 * so a slot and an exported file are the same bytes. localStorage failures
 * (quota, private mode) surface as a false/null return, never a throw —
 * losing autosave must not break painting.
 */

const DRAFT_KEY = 'serf-editor-draft';
const SLOTS_KEY = 'serf-editor-maps';

export function saveDraft(state: EditorMapState): boolean {
  try {
    localStorage.setItem(DRAFT_KEY, serializeEditorMap(state));
    return true;
  } catch {
    return false;
  }
}

export function loadDraft(): EditorMapState | null {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    return raw === null ? null : parseEditorMap(raw);
  } catch {
    return null; // corrupt draft: start fresh rather than refuse to open
  }
}

function readSlots(): Record<string, string> {
  try {
    const raw = localStorage.getItem(SLOTS_KEY);
    const parsed: unknown = raw === null ? {} : JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter(([, v]) => typeof v === 'string'),
    ) as Record<string, string>;
  } catch {
    return {};
  }
}

export function listMaps(): string[] {
  return Object.keys(readSlots()).sort((a, b) => a.localeCompare(b));
}

export function saveMapAs(name: string, state: EditorMapState): boolean {
  const slots = readSlots();
  slots[name] = serializeEditorMap({ ...state, name });
  try {
    localStorage.setItem(SLOTS_KEY, JSON.stringify(slots));
    return true;
  } catch {
    return false; // quota — the caller toasts
  }
}

export function loadMap(name: string): EditorMapState | null {
  const raw = readSlots()[name];
  if (raw === undefined) return null;
  try {
    return parseEditorMap(raw);
  } catch {
    return null;
  }
}

export function deleteMap(name: string): void {
  const slots = readSlots();
  if (!(name in slots)) return;
  delete slots[name];
  try {
    localStorage.setItem(SLOTS_KEY, JSON.stringify(slots));
  } catch {
    // deleting can only shrink; if even that fails there is nothing to do
  }
}
