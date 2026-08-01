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

/** Networked match: one shared clock (no pause/FF), no save, no cheats. */
export const [netMode, setNetMode] = createSignal(false);

/** Live connection health (netMode only). */
export const [netStatus, setNetStatus] = createSignal<
  import('../protocol/messages').NetStatus | null
>(null);

/** Storehouse stock — the HUD resource bar. */
export const [stock, setStock] = createSignal<GoodAmounts>({});

/** Active build-menu placement mode (null = normal selection). */
export const [placing, setPlacing] = createSignal<BuildingTypeId | null>(null);

/**
 * One-shot touch marquee: the HUD button arms it, and the next one-finger
 * drag draws a selection band instead of panning the camera (Controls
 * consumes the flag; CameraRig yields while it is set).
 */
export const [bandArm, setBandArm] = createSignal(false);

/** Tech tree state + panel visibility. */
export const [techs, setTechs] = createSignal<TechSnap>({
  researched: [],
  festivalTicksLeft: 0,
  pavingUnlocked: false,
  hasAbbey: false,
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

/**
 * Whether client-side cheats are allowed to work at all. Single player is
 * the only place they are harmless; against a live opponent every one of
 * them is an advantage they cannot see you taking. `?mp` is how main.ts
 * decides to enter multiplayer, so it decides this too — and it has to be
 * the URL rather than the netMode() signal below, because this is read at
 * module load, before the lobby has resolved.
 */
export const CHEATS_ALLOWED = !new URLSearchParams(location.search).has('mp');

/**
 * Fog of war. Unlike the switches above this one never reaches the sim:
 * fog is a view over the world, not part of it, so it stays a client
 * signal — nothing to keep deterministic, nothing to save. ?nofog starts
 * it off.
 *
 * That client-sidedness is exactly why it needs the cheat gate: turning
 * fog off does not merely brighten the picture, it makes visibleAt() and
 * exploredAt() answer true, which re-enables hovering, selecting and
 * reading the health of enemy units. In a match that is a maphack.
 */
export const [fogEnabled, setFogEnabled] = createSignal(
  !(CHEATS_ALLOWED && new URLSearchParams(location.search).has('nofog')),
);

/** Debug overlay (backquote). */
export const [debugOpen, setDebugOpen] = createSignal(false);
export const [debugJobs, setDebugJobs] = createSignal<JobSnap[]>([]);
export const [invariantViolations, setInvariantViolations] = createSignal<string[]>([]);
