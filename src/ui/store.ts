import {createSignal} from 'solid-js';

// Module-level signals cannot survive a hot swap: components keep reading
// the old module's signals while new code writes the new ones, and buttons
// silently "stop working". Invalidate on any hot update so edits here (and
// to our importers) escalate to a full page reload instead.
if (import.meta.hot) {
  import.meta.hot.accept(() => import.meta.hot?.invalidate());
}
import {play, setAudioMuted, setAudioVolume} from '../audio/audio';
import {
  audioFromUrl,
  loadAudioPrefs,
  saveAudioPrefs,
  volumeToGain,
} from '../audio/settings';
import type {
  BuildingSnap,
  JobSnap,
  OutcomeSnap,
  PlayerSnap,
  TechSnap,
} from '../protocol/messages';
import type {Enum} from '../shared/enum.ts';
import type {BuildingTypeId} from '../sim/defs/buildings';
import type {GoodAmounts} from '../sim/defs/goods';
import * as OrderModeNs from './orderModeEnum.ts';
export type OrderMode = Enum<typeof OrderModeNs>;
import * as MatchState from '../sim/matchStateEnum.ts';
import * as HudPanelNs from './hudPanelEnum.ts';
export type HudPanel = Enum<typeof HudPanelNs>;

/**
 * Main-thread UI state. Worker structural updates write into this; Solid
 * components and the input layer read it reactively.
 */
export const [speed, setSpeed] = createSignal(1);
export const [selection, setSelection] = createSignal<ReadonlySet<number>>(
  new Set(),
);

/**
 * The control group the standing selection *is* — 1–9 or 0, or null when it
 * matches none of them. Only the badge on the selection card reads it, but
 * that badge is the whole feedback loop for control groups: without it,
 * Ctrl+1 is a keypress with no visible effect and the player has no way to
 * know the stamp took short of pressing 1 and hoping.
 *
 * The groups themselves live in `input/controls.ts` beside the selection —
 * they are lists of unit ids, and something has to weed the dead out of
 * them every frame. This is the one derived crumb the HUD needs.
 */
export const [selectionGroup, setSelectionGroup] = createSignal<number | null>(
  null,
);

/**
 * Whose people the standing selection is — null when nobody is selected,
 * and null again for the mixed set a shift-click across a battle can
 * build, since no one name would cover it.
 *
 * A live match never needs asking: the pointer reaches your own and
 * nothing else, so the answer is always myPlayerId() and no card bothers
 * printing it. A replay lets the pointer reach every seat, and there a
 * ring around the Warlord's knights and a ring around your own are the
 * same ring — this is what lets the card say which it is.
 *
 * Written by Controls beside the selection itself, because that is where
 * the ids and the owner lookup both are (see #soleOwner).
 */
export const [selectionOwner, setSelectionOwner] = createSignal<number | null>(
  null,
);

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

/** Open posts per tool (and sites owed hammers) — the strip's "wants" chip
 * and the ledger's task column. Computed in the sim's snapshot, since the
 * main thread holds no building roster to derive it from. */
export const [toolWants, setToolWants] = createSignal<GoodAmounts>({});

/**
 * Heads and beds — the HUD's population readout. `pop` is every living
 * person this seat owns (serfs, resident workers, soldiers alike); `cap` is
 * the castle's ten plus ten for every finished house.
 */
export const [population, setPopulation] = createSignal<{
  pop: number;
  cap: number;
}>({
  pop: 0,
  cap: 0,
});

/** Active build-menu placement mode (null = normal selection). */
export const [placing, setPlacing] = createSignal<BuildingTypeId | null>(null);

/**
 * The building the ribbon has last been aimed at — which is not the same
 * question as what is armed for placement, and the difference is the whole
 * reason this exists.
 *
 * A chord that names a mill the stores cannot pay for arms nothing, so a
 * ribbon following `placing` never moves: the player gets a toast about a
 * cost, and the button that spells that cost out sits greyed on a tab they
 * are not looking at. The aim is written before the two gates rather than
 * after them, so the tab comes along whether or not the placement does, and
 * the refusal has something on screen to point at.
 *
 * `equals: false` because the same building aimed at twice has to move the
 * tabs twice. Refused a Mill, tabbed over to Village to count the silver,
 * chorded the Mill again — under the default equality that second write is
 * the value already there and the ribbon never hears about it.
 */
export const [buildAim, setBuildAim] = createSignal<BuildingTypeId | null>(
  null,
  {
    equals: false,
  },
);

/**
 * The build chord is half-typed: B has been pressed and the next letter
 * picks the building. A signal rather than a local in Controls because the
 * build card has to say so — a mode nothing on screen acknowledges reads as
 * a swallowed keystroke, and the player presses B again.
 */
export const [buildChord, setBuildChord] = createSignal(false);

/**
 * An order armed and waiting for its target: A or M pressed (or the
 * selection card's buttons tapped) with people selected, and the next click
 * on the map says where. `'attack'` is the attack-move that engages what it
 * meets, `'move'` the plain walk that ignores it. `'rally'` is the odd one
 * out — armed from a selected barracks rather than a squad, and the click
 * plants its muster flag instead of moving anyone.
 *
 * Controls owns the writing — see armOrder there — because leaving the mode
 * also has to put the cursor back.
 */
export const [orderMode, setOrderMode] = createSignal<OrderMode | null>(null);

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
export const [openPanel, setOpenPanel] = createSignal<HudPanel | null>(null);
export const techPanelOpen = (): boolean => openPanel() === HudPanelNs.tech;
export const setTechPanelOpen = (open: boolean): void => {
  setOpenPanel(open ? HudPanelNs.tech : null);
};
export const economyPanelOpen = (): boolean =>
  openPanel() === HudPanelNs.economy;
export const setEconomyPanelOpen = (open: boolean): void => {
  setOpenPanel(open ? HudPanelNs.economy : null);
};
/** The minimap sheet (small screens only — the desktop card just stands).
 * In the panel family so opening it closes the menu and Esc closes it. */
export const minimapOpen = (): boolean => openPanel() === HudPanelNs.map;
export const setMinimapOpen = (open: boolean): void => {
  setOpenPanel(open ? HudPanelNs.map : null);
};

/** The "leave the match?" question, asked by the HUD's own <dialog>
 * rather than a native confirm(): the browser drops out of fullscreen to
 * show its own dialog, and quitting is exactly when the player may still
 * say no. */
export const [quitConfirm, setQuitConfirm] = createSignal(false);

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
export const [selectedBuilding, setSelectedBuilding] =
  createSignal<BuildingSnap | null>(null);

/**
 * The sim tick as of the last structural frame — the HUD's "now" for any
 * readout that measures against a tick the roster carries (the card's
 * hauler wait reads it against BuildingSnap.outWaitingSince). Only as
 * fresh as the frames: a village with no news posts none and this holds
 * still, which suits a wait fine — the alarm stands, the seconds catch up
 * with the next frame.
 */
export const [simTick, setSimTick] = createSignal(0);

/** Toast messages (raid warnings etc.), newest last. A toast with a focus
 * target is clickable and pans the camera there. */
export const [toasts, setToasts] = createSignal<
  {id: number; text: string; focus?: {x: number; y: number}}[]
>([]);
let toastId = 0;

/**
 * Where the last thing worth looking at happened — what Space jumps to, the
 * way both Warcraft III and StarCraft II jump to the last alert.
 *
 * Separate from the toasts themselves because it has to outlive them. A
 * toast is gone in eight seconds; the raid it announced is still going on,
 * and a player who was mid-build when it landed is exactly the one who
 * needs to be taken there afterwards.
 */
export const [lastAlert, setLastAlert] = createSignal<{
  x: number;
  y: number;
} | null>(null);

export function pushToast(text: string, focus?: {x: number; y: number}): void {
  // Every notification passes through here, so this is where they rustle.
  play('uiToast');
  if (focus) setLastAlert(focus);
  const id = ++toastId;
  setToasts([...toasts(), {id, text, focus}]);
  setTimeout(() => setToasts(toasts().filter(t => t.id !== id)), 8000);
}
export function dismissToast(id: number): void {
  setToasts(toasts().filter(t => t.id !== id));
}

/** Match outcome (drives the end screen). */
export const [outcome, setOutcome] = createSignal<OutcomeSnap>({
  state: MatchState.playing,
});

/** Sandbox switches, mirrored from the sim (?admin panel). */
export const [adminState, setAdminState] = createSignal({
  enabled: true,
  raidsEnabled: true,
  instantBuild: false,
});

/**
 * Whether client-side cheats are allowed to work at all. Single player is
 * the only place they are harmless; against a live opponent every one of
 * them is an advantage they cannot see you taking.
 *
 * A function over two tells, not a module-load constant, because
 * multiplayer is reached two ways. `?mp` is how main.ts decides to enter
 * it from a URL; netMode() is a running match saying so itself. The menu
 * walks into the council and the match IN PLACE — no reload — so a
 * constant read before the lobby resolved stayed true for the whole
 * networked match, and ?nofog / ?admin rode straight into live games.
 */
export function cheatsAllowed(): boolean {
  return !netMode() && !new URLSearchParams(location.search).has('mp');
}

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
  !(cheatsAllowed() && new URLSearchParams(location.search).has('nofog')),
);

/**
 * Sound preferences — player-scoped like the campaign profile, so
 * deliberately absent from resetMatchState(). The signals are the single
 * source of truth for the UI; every write also lands on the audio engine
 * and (for real choices) in the `serf-audio` record. URL flags (?mute=1,
 * ?vol=) seed the signals for this visit without persisting — a flag is a
 * visit, not a choice — though touching the controls afterwards persists
 * what the player then sees, which is what they'd expect it to mean.
 */
const audioBoot = ((): {volume: number; muted: boolean} => {
  const prefs = loadAudioPrefs();
  const url = audioFromUrl(location.search);
  return {
    volume: url.volume ?? prefs.volume,
    muted: url.mute === true || prefs.muted,
  };
})();
export const [volume, setVolumeSignal] = createSignal(audioBoot.volume);
export const [muted, setMutedSignal] = createSignal(audioBoot.muted);

/**
 * The slider drives setVolumePref from `input`, so a single drag lands
 * dozens of calls, and localStorage.setItem is synchronous. The signal and
 * the mixer still move on every one of them — only the write is deferred,
 * to at most one per window. The timer reads the signal when it fires, so
 * whatever the drag ended on is what gets stored.
 */
const PREFS_WRITE_MS = 300;
let prefsTimer = 0;
let flushHooked = false;

function writeAudioPrefs(): void {
  saveAudioPrefs({v: 1, volume: volume(), muted: muted()});
}

function cancelPendingWrite(): void {
  if (prefsTimer === 0) return;
  clearTimeout(prefsTimer);
  prefsTimer = 0;
}

/** Write anything still pending — the drag that ends by closing the tab. */
function flushAudioPrefs(): void {
  if (prefsTimer === 0) return;
  cancelPendingWrite();
  writeAudioPrefs();
}

function writeAudioPrefsSoon(): void {
  if (!flushHooked) {
    // Hooked on first use, never at module scope: importing this store must
    // stay free of side effects for the screens that never touch sound.
    flushHooked = true;
    window.addEventListener('pagehide', flushAudioPrefs);
  }
  if (prefsTimer !== 0) return;
  prefsTimer = window.setTimeout(() => {
    prefsTimer = 0;
    writeAudioPrefs();
  }, PREFS_WRITE_MS);
}

export function setVolumePref(v: number): void {
  setVolumeSignal(v);
  setAudioVolume(volumeToGain(v));
  writeAudioPrefsSoon();
}

export function toggleMuted(): void {
  const m = !muted();
  setMutedSignal(m);
  setAudioMuted(m);
  // A discrete choice, not a drag: store it now. The write carries the
  // live volume, so a pending one has nothing left to say.
  cancelPendingWrite();
  writeAudioPrefs();
}

/** Debug overlay (backquote). */
export const [debugOpen, setDebugOpen] = createSignal(false);
export const [debugJobs, setDebugJobs] = createSignal<JobSnap[]>([]);
export const [invariantViolations, setInvariantViolations] = createSignal<
  string[]
>([]);

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
 * profile (they belong to the player, not the match).
 */
export function resetMatchState(): void {
  setSpeed(1);
  setSelection(new Set<number>());
  setSelectionGroup(null);
  setSelectionOwner(null);
  setMyPlayerId(0);
  setPlayersMeta([]);
  setNetMode(false);
  setReplayMode(false);
  setReplayOver(false);
  setNetStatus(null);
  setStock({});
  setPopulation({pop: 0, cap: 0});
  setPlacing(null);
  setBuildAim(null);
  setBuildChord(false);
  setOrderMode(null);
  setBandArm(false);
  setTechs({
    researched: [],
    festivalTicksLeft: 0,
    pavingUnlocked: false,
    hasAbbey: false,
  });
  setOpenPanel(null);
  setQuitConfirm(false);
  setMission(null);
  setBriefingOpen(false);
  setSelectedBuilding(null);
  setSimTick(0);
  setToasts([]);
  setLastAlert(null);
  setOutcome({state: MatchState.playing});
  setAdminState({enabled: true, raidsEnabled: true, instantBuild: false});
  setDebugOpen(false);
  setDebugJobs([]);
  setInvariantViolations([]);
  // Read afresh rather than restored: ?nofog belongs to the match being
  // started, and the URL has already become the next one by here.
  setFogEnabled(
    !(cheatsAllowed() && new URLSearchParams(location.search).has('nofog')),
  );
}
