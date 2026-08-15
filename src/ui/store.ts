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

/** Watching a saved replay: the sim feeds itself from the log, orders are
 * ignored, and the HUD trades its command surfaces for an extra speed. */
export const [replayMode, setReplayMode] = createSignal(false);

/** Playback walked off the end of the recording (the sim paused itself). */
export const [replayOver, setReplayOver] = createSignal(false);

/** Live connection health (netMode only). */
export const [netStatus, setNetStatus] = createSignal<
  import('../protocol/messages').NetStatus | null
>(null);

/** Storehouse stock — the HUD resource bar. */
export const [stock, setStock] = createSignal<GoodAmounts>({});

/**
 * Heads and beds — the HUD's population readout. `pop` is every living
 * person this seat owns (serfs, resident workers, soldiers alike); `cap` is
 * the castle's ten plus ten for every finished house.
 */
export const [population, setPopulation] = createSignal<{ pop: number; cap: number }>({
  pop: 0,
  cap: 0,
});

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

/**
 * Campaign mission riding this match, latch bits included — the worker's
 * structural updates keep it fresh (the world, not the URL, is the source
 * of truth, so a loaded save still knows its mission). Null = free play.
 */
export const [mission, setMission] = createSignal<{
  id: import('../sim/defs/missions').MissionId;
  done: boolean[];
} | null>(null);

/** The mission briefing card: shown at boot for mission matches, dismissed
 * by its Begin button, reopenable from the objectives panel. */
export const [briefingOpen, setBriefingOpen] = createSignal(false);

/** Selected building (mutually exclusive with unit selection). */
export const [selectedBuilding, setSelectedBuilding] = createSignal<BuildingSnap | null>(null);

/** Toast messages (raid warnings etc.), newest last. A toast with a focus
 * target is clickable and pans the camera there. */
export const [toasts, setToasts] = createSignal<
  { id: number; text: string; focus?: { x: number; y: number } }[]
>([]);
let toastId = 0;
export function pushToast(text: string, focus?: { x: number; y: number }): void {
  const id = ++toastId;
  setToasts([...toasts(), { id, text, focus }]);
  setTimeout(() => setToasts(toasts().filter((t) => t.id !== id)), 8000);
}
export function dismissToast(id: number): void {
  setToasts(toasts().filter((t) => t.id !== id));
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

/**
 * The LLM strategist's health, when one was asked for (?llm=1): download
 * progress while the model fetches, a short-lived "on", null when there is
 * nothing to show. Failures surface as a toast instead — the seats keep
 * playing their playbooks either way.
 */
export const [llmStatus, setLlmStatus] = createSignal<
  import('../ai/strategist').LlmStatus | null
>(null);

/** Debug overlay (backquote). */
export const [debugOpen, setDebugOpen] = createSignal(false);
export const [debugJobs, setDebugJobs] = createSignal<JobSnap[]>([]);
export const [invariantViolations, setInvariantViolations] = createSignal<string[]>([]);

/**
 * Put every match-scoped signal back where it starts.
 *
 * A page used to hold exactly one match, so these were as good as constants
 * — the document died with the world. Now a match ends in place and the
 * menu comes back up over the same signals, so anything not reset here
 * outlives its world: a resource bar still showing the fallen village's
 * grain, an end card over the next match, a selection pointing at units
 * that no longer exist.
 *
 * Deliberately not reset: the fullscreen preference and the campaign
 * profile (they belong to the player, not the match), and CHEATS_ALLOWED,
 * which is a const read once at module load.
 */
export function resetMatchState(): void {
  setSpeed(1);
  setSelection(new Set<number>());
  setMyPlayerId(0);
  setPlayersMeta([]);
  setNetMode(false);
  setReplayMode(false);
  setReplayOver(false);
  setNetStatus(null);
  setStock({});
  setPopulation({ pop: 0, cap: 0 });
  setPlacing(null);
  setBandArm(false);
  setTechs({ researched: [], festivalTicksLeft: 0, pavingUnlocked: false, hasAbbey: false });
  setOpenPanel(null);
  setMission(null);
  setBriefingOpen(false);
  setSelectedBuilding(null);
  setToasts([]);
  setOutcome({ state: 'playing' });
  setAdminState({ enabled: true, raidsEnabled: true, instantBuild: false });
  setLlmStatus(null);
  setDebugOpen(false);
  setDebugJobs([]);
  setInvariantViolations([]);
  // Read afresh rather than restored: ?nofog belongs to the match being
  // started, and the URL has already become the next one by here.
  setFogEnabled(!(CHEATS_ALLOWED && new URLSearchParams(location.search).has('nofog')));
}
