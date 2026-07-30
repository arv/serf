import { createSignal } from 'solid-js';

// Module-level signals cannot survive a hot swap: components keep reading
// the old module's signals while new code writes the new ones, and buttons
// silently "stop working". Invalidate on any hot update so edits here (and
// to our importers) escalate to a full page reload instead.
if (import.meta.hot) {
  import.meta.hot.accept(() => import.meta.hot?.invalidate());
}
import type { GoodAmounts } from '../sim/defs/goods';
import type { BuildingTypeId } from '../sim/defs/buildings';
import type { BuildingSnap, JobSnap, OutcomeSnap, PlayerSnap, TechSnap } from '../protocol/messages';

/**
 * Main-thread UI state. Worker structural updates write into this; Solid
 * components and the input layer read it reactively.
 */
export const [speed, setSpeed] = createSignal(1);
export const [selection, setSelection] = createSignal<ReadonlySet<number>>(new Set());

/** The seat this client plays (0 until lobbies land). Everything the HUD
 * shows — stock, techs, outcome copy, selection filters — is this player's
 * perspective. */
export const [myPlayerId, setMyPlayerId] = createSignal(0);

/** All seats' faction blocks (for elimination toasts, future score UI). */
export const [playersMeta, setPlayersMeta] = createSignal<PlayerSnap[]>([]);

/** Storehouse stock — the HUD resource bar. */
export const [stock, setStock] = createSignal<GoodAmounts>({});

/** Active build-menu placement mode (null = normal selection). */
export const [placing, setPlacing] = createSignal<BuildingTypeId | null>(null);

/** Tech tree state + panel visibility. */
export const [techs, setTechs] = createSignal<TechSnap>({
  researched: [],
  festivalTicksLeft: 0,
  pavingUnlocked: false,
  hasTerakoya: false,
});
/** At most one HUD popup at a time — opening any closes the others. */
export type HudPanel = 'build' | 'menu' | 'tech';
export const [openPanel, setOpenPanel] = createSignal<HudPanel | null>(null);
export const techPanelOpen = (): boolean => openPanel() === 'tech';
export const setTechPanelOpen = (open: boolean): void => {
  setOpenPanel(open ? 'tech' : null);
};

/** Selected building (mutually exclusive with unit selection). */
export const [selectedBuilding, setSelectedBuilding] = createSignal<BuildingSnap | null>(null);

/** Toast messages (raid warnings etc.), newest last. */
export const [toasts, setToasts] = createSignal<{ id: number; text: string }[]>([]);
let toastId = 0;
export function pushToast(text: string): void {
  const id = ++toastId;
  setToasts([...toasts(), { id, text }]);
  setTimeout(() => setToasts(toasts().filter((t) => t.id !== id)), 8000);
}

/** Match outcome (drives the end screen). */
export const [outcome, setOutcome] = createSignal<OutcomeSnap>({ state: 'playing' });

/** Sandbox switches, mirrored from the sim (?admin panel). */
export const [adminState, setAdminState] = createSignal({
  enabled: true,
  raidsEnabled: true,
  instantBuild: false,
});

/** Debug overlay (backquote). */
export const [debugOpen, setDebugOpen] = createSignal(false);
export const [debugJobs, setDebugJobs] = createSignal<JobSnap[]>([]);
export const [invariantViolations, setInvariantViolations] = createSignal<string[]>([]);
