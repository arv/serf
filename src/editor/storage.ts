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
/**
 * Which named slot the draft belongs to, so a reload comes back with Save
 * still pointed at the map you were saving. Kept beside the draft rather
 * than inside it: the draft is a map FILE, and which slot it came from is
 * session bookkeeping no other host of the format cares about.
 */
const BOUND_KEY = 'serf-editor-draft-slot';

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

/** Remember (or forget, with null) the slot the draft is saving into. */
export function saveBoundName(name: string | null): void {
  try {
    if (name === null) localStorage.removeItem(BOUND_KEY);
    else localStorage.setItem(BOUND_KEY, name);
  } catch {
    // Losing the binding costs one "Save as" prompt, nothing more.
  }
}

/**
 * The remembered slot — but only while that slot still exists. A map
 * deleted from another tab (or last session) must not leave Save writing
 * a name the Open list no longer shows.
 */
export function loadBoundName(): string | null {
  try {
    const name = localStorage.getItem(BOUND_KEY);
    return name !== null && name in readSlots() ? name : null;
  } catch {
    return null;
  }
}

function readSlots(): Record<string, string> {
  // Null-prototype on purpose: slot names are user text, and assigning
  // into a plain object would let the perfectly legal map name
  // "__proto__" hit the prototype setter — reporting a save that
  // JSON.stringify then silently drops.
  const slots: Record<string, string> = Object.create(null) as Record<string, string>;
  try {
    const raw = localStorage.getItem(SLOTS_KEY);
    const parsed: unknown = raw === null ? {} : JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return slots;
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === 'string') slots[k] = v;
    }
    return slots;
  } catch {
    return slots;
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
