import { beforeEach, describe, expect, it } from 'vitest';
import { MIN_MAP_SIZE } from '../shared/grid.ts';
import { createBlankMap } from './editorMap.ts';
import {
  deleteMap,
  listMaps,
  loadBoundName,
  loadDraft,
  loadMap,
  saveBoundName,
  saveDraft,
  saveMapAs,
} from './storage.ts';

/**
 * The suite runs headless node, so the editor's slots need a localStorage
 * to live in. Everything storage.ts touches is here — and `full` flips it
 * into the quota failure every one of those calls has to survive.
 */
function stubStorage(): { full: () => void } {
  const data = new Map<string, string>();
  let full = false;
  const store = {
    getItem: (k: string): string | null => data.get(k) ?? null,
    setItem: (k: string, v: string): void => {
      if (full) throw new Error('QuotaExceededError');
      data.set(k, v);
    },
    removeItem: (k: string): void => {
      data.delete(k);
    },
  };
  Object.defineProperty(globalThis, 'localStorage', { value: store, configurable: true });
  return {
    full: () => {
      full = true;
    },
  };
}

const sample = (name: string) => ({
  ...createBlankMap({ size: MIN_MAP_SIZE, players: 2 }),
  name,
});

describe('editor slots', () => {
  let storage: ReturnType<typeof stubStorage>;
  beforeEach(() => {
    storage = stubStorage();
  });

  it('saves under the name it was given, whatever the state carried', () => {
    expect(saveMapAs('Crossroads', sample('Untitled'))).toBe(true);
    expect(listMaps()).toEqual(['Crossroads']);
    expect(loadMap('Crossroads')?.name).toBe('Crossroads');
    expect(loadMap('nothing here')).toBeNull();
  });

  it('reports a full quota instead of throwing', () => {
    storage.full();
    expect(saveMapAs('Crossroads', sample('Crossroads'))).toBe(false);
    expect(saveDraft(sample('Crossroads'))).toBe(false);
    expect(() => saveBoundName('Crossroads')).not.toThrow();
    expect(loadDraft()).toBeNull();
  });
});

describe('the slot Save writes back into', () => {
  beforeEach(() => {
    stubStorage();
  });

  it('survives a reload', () => {
    saveMapAs('Crossroads', sample('Crossroads'));
    saveBoundName('Crossroads');
    expect(loadBoundName()).toBe('Crossroads');
  });

  it('is forgotten once that slot is gone', () => {
    saveMapAs('Crossroads', sample('Crossroads'));
    saveBoundName('Crossroads');
    deleteMap('Crossroads');
    // Otherwise Save would silently re-create a map the author deleted.
    expect(loadBoundName()).toBeNull();
  });

  it('clears on request', () => {
    saveMapAs('Crossroads', sample('Crossroads'));
    saveBoundName('Crossroads');
    saveBoundName(null);
    expect(loadBoundName()).toBeNull();
  });
});
