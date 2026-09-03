import {For, Index, Show, createSignal, onCleanup, onMount} from 'solid-js';
import {createStore, reconcile} from 'solid-js/store';
import {BUILD_CHANNEL, BUILD_LABEL} from '../app/buildInfo';
import type {ImportResult, StoredFileInfo} from '../app/fileStore';
import {missionUrl} from '../app/gameConfig';
import {
  deleteReplayFile,
  importReplayFile,
  listReplayFiles,
  type ReplayFileInfo,
} from '../app/replayStore';
import {goto} from '../app/router';
import {
  deleteSaveFile,
  importSaveFile,
  listSaveFiles,
  type SaveFileInfo,
} from '../app/saveStore';
import {
  clearSeatStash,
  relayUrl,
  type CouncilRequest,
} from '../net/lobbyClient';
import {defaultLobbyConfig} from '../protocol/lobby';
import {REPLAY_VERSION} from '../shared/replayVersion';
import {WORLD_SAVE_VERSION, canReadSave} from '../shared/saveVersion';
import {DIFFICULTY_KEYS, type DifficultyId} from '../sim/defs/difficulty.ts';
import * as DifficultyIdNs from '../sim/defs/difficultyEnum.ts';
import {
  MISSION_DEFS,
  MISSION_ORDER,
  type MissionId,
  parseMissionId,
} from '../sim/defs/missions';
import {SHORT} from './breakpoints';
import {isMissionComplete, isMissionUnlocked} from './campaign';
import {DifficultyRow, difficultyHint} from './difficulty';
import {fullscreen} from './fullscreen';
import {LockIcon} from './icons';
import {releaseMenuBackdrop} from './menuBackdrop';
import {Glide, spotlight} from './menuChrome';
import {muted, toggleMuted} from './store';

/**
 * Pre-boot start screen — the first screen of the menu shell (MenuApp.tsx),
 * which owns the backdrop behind it and the #menu root under it.
 *
 * Multiplayer walks straight into the War Council from here, in place: the
 * two are screens of one page and the background never reloads. Single
 * player is still a navigation — it sets location.search and boot() comes
 * back up in the sim.
 *
 * Visual language matches the in-game HUD (glass panels, one gold accent,
 * Space Grotesk).
 */

/** Shipping set of options. The launch URL is a dev affordance — off for
 * players. */
const OPTIONS = {
  showBanditsRow: true,
  showLaunchUrl: false,
  maxOpponents: 3,
};

/**
 * A fresh valley for every skirmish. Rolled here rather than typed on the
 * screen: a seed is a number that means nothing to anyone until they have
 * played the map it makes, and a field showing 17 by default handed every
 * new player the same valley as the last one. The roll still travels in
 * the launch URL, so the match remains reproducible — a link, a reload and
 * "Play again" all come back to the same ground.
 *
 * Eight digits, matching the council's dice button; small enough to read
 * off an address bar and share.
 */
function rollSeed(): number {
  return Math.floor(Math.random() * 9e7) + 1e7;
}

const AI_SEATS = Array.from({length: OPTIONS.maxOpponents + 1}, (_, i) => i);

/** How often the join view asks the server for open rooms. */
const POLL_MS = 3000;

/** Whether drag-and-drop is worth words: a fine pointer is the desktop
 * tell (same matchMedia shape as edgeScroll.ts — jsdom ships without
 * one). The rows are draggable and the shelf catches drops regardless;
 * this gates only the hints — and the shelf button's empty-handed state,
 * which exists so there is somewhere to drop a first replay. */
const DRAG_OFFERED =
  typeof window !== 'undefined' &&
  (window.matchMedia?.('(any-pointer: fine)').matches ?? false);

/** Whether a row can be handed to the system share sheet: the Web Share
 * API, with files. This is the phone's half of what the drag above does
 * on a desktop — Android has nowhere to drop a replay, so without the
 * sheet a recording is stuck on the device that made it. The probe file
 * is a .txt because the real payload is too: Chromium shares only an
 * allowlist of file types, and .json is not on it, so a document rides
 * the sheet as text/plain and the import strips the wrapper back off. */
const SHARE_OFFERED =
  typeof navigator !== 'undefined' &&
  typeof navigator.canShare === 'function' &&
  navigator.canShare({
    files: [new File(['probe'], 'probe.txt', {type: 'text/plain'})],
  });

export type Mode = 'single' | 'campaign' | 'multi';
/** Tab order. The plaque is positioned by index, so this and the markup
 * must agree; --n is read from here rather than written down again. */
export const MODE_ORDER: readonly Mode[] = ['single', 'campaign', 'multi'];
export type MpMode = 'host' | 'join';
type Visibility = 'open' | 'private';

/** Which pane the screen opens on. The shell hands back what the player
 * had chosen when they walked into the council, so backing out of it does
 * not dump them on the pane they started from. */
export interface StartState {
  mode: Mode;
  mp: MpMode;
}

/** The pane a returning player picked last, kept apart from campaign
 * progress and the save slot: it is a preference about the menu, not a
 * fact about the valley. */
const PANE_KEY = 'serf-start-pane';

/**
 * Which tab a fresh visit opens on. The campaign is the front door — it is
 * where a player who has never seen the game should land — but anyone who
 * has since chosen another pane gets that one back.
 */
export function rememberedMode(): Mode {
  try {
    const raw = localStorage.getItem(PANE_KEY);
    if (raw === 'single' || raw === 'campaign' || raw === 'multi') return raw;
  } catch {
    // Storage denied reads as a player who has never chosen.
  }
  return 'campaign';
}

/** Where a player with no network belongs: the front door, which asks
 * nothing of the relay. */
const OFFLINE_PANE: Mode = 'campaign';

/** Remember a pane the player actually chose. Only the tab bar calls this:
 * the offline fallback below moves the pane without it being a choice. */
function rememberMode(mode: Mode): void {
  try {
    localStorage.setItem(PANE_KEY, mode);
  } catch {
    // Storage full or denied: the choice just doesn't outlive the session.
  }
}

export interface StartMenuProps {
  start: StartState;
  /** Multiplayer: take the shell to the War Council, no reload. */
  onCouncil(req: CouncilRequest): void;
}

/** One row of the room browser; the shape the server answers {t:'list'} with. */
interface OpenRoom {
  code: string;
  filled: number;
  total: number;
  ai: number;
  ageMs: number;
}

function ago(ms: number): string {
  const min = Math.floor(ms / 60000);
  return min < 1 ? 'just now' : `${min} min ago`;
}

/** Short-lived lobby socket: ask for the open-room list and hang up. */
function listRooms(): Promise<OpenRoom[]> {
  return new Promise(resolve => {
    let settled = false;
    const done = (rooms: OpenRoom[]): void => {
      if (settled) return;
      settled = true;
      try {
        ws.close();
      } catch {
        /* already closing */
      }
      resolve(rooms);
    };
    const ws = new WebSocket(relayUrl(location.search));
    ws.onerror = () => done([]);
    ws.onclose = () => done([]);
    ws.onopen = () => ws.send(JSON.stringify({t: 'list'}));
    ws.onmessage = (e: MessageEvent<string>) => {
      const msg = JSON.parse(e.data) as {t: string; rooms?: OpenRoom[]};
      if (msg.t === 'rooms') done(msg.rooms ?? []);
    };
    setTimeout(() => done([]), 4000);
  });
}

const OneIcon = (
  <svg
    width="14"
    height="14"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.8"
    stroke-linecap="round"
  >
    <circle cx="12" cy="8" r="3.6" />
    <path d="M4.5 20a7.5 7.5 0 0 1 15 0" />
  </svg>
);
const ManyIcon = (
  <svg
    width="15"
    height="15"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.8"
    stroke-linecap="round"
  >
    <circle cx="9" cy="8.5" r="3.1" />
    <path d="M2.5 20a6.5 6.5 0 0 1 13 0" />
    <path d="M16.5 6.2a3.1 3.1 0 0 1 0 5.9" />
    <path d="M18 15.2A6.5 6.5 0 0 1 21.5 20" />
  </svg>
);
const BannerIcon = (
  <svg
    width="14"
    height="14"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.8"
    stroke-linecap="round"
    stroke-linejoin="round"
  >
    <path d="M6 3v18" />
    <path d="M6 4h12l-3 4 3 4H6" />
  </svg>
);
/** Out of the shelf, back to the tab bar. */
const BackIcon = (
  <svg
    width="15"
    height="15"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.9"
    stroke-linecap="round"
    stroke-linejoin="round"
  >
    <path d="M19 12H5" />
    <path d="M11 6l-6 6 6 6" />
  </svg>
);
/** A wound scroll: matches watched back off the shelf. */
const ScrollIcon = (
  <svg
    width="14"
    height="14"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.8"
    stroke-linecap="round"
    stroke-linejoin="round"
  >
    <path d="M8 21h9a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2H8" />
    <path d="M8 3a2 2 0 0 0-2 2v14a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-2h4" />
    <path d="M11 8h5M11 12h5" />
  </svg>
);
/** The share sheet's glyph: one point handed on to two others. A
 * component, not a const — every visible row draws its own. */
function ShareIcon() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.8"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <circle cx="18" cy="5" r="2.5" />
      <circle cx="6" cy="12" r="2.5" />
      <circle cx="18" cy="19" r="2.5" />
      <path d="M8.2 10.9l7.6-4.3M8.2 13.1l7.6 4.3" />
    </svg>
  );
}
/** Which shelf is open. The two are one piece of UI — a list of files in
 * OPFS, newest first, with a pick, a delete and a drop target — and differ
 * only in the words below and where a picked row leads. */
type ShelfKind = 'replays' | 'saves';

interface ShelfSpec {
  title: string;
  /** "replay" / "saved game", and the two grammatical forms the notes need. */
  noun: string;
  article: string;
  plural: string;
  /** The call to action, with a row armed and without one. */
  ctaArmed: string;
  ctaIdle: string;
  emptyTitle: string;
  emptyBody: string;
  /** The standing line under the list. */
  hint: string;
  /** Added to both when a pointer that can drag is present. */
  dropHint: string;
  import(file: File): Promise<ImportResult>;
  remove(name: string): Promise<void>;
  /** The address a picked row launches. */
  url(name: string): string;
}

const SHELVES: Record<ShelfKind, ShelfSpec> = {
  replays: {
    title: 'Replays',
    noun: 'replay',
    article: 'a replay',
    plural: 'replays',
    ctaArmed: 'Watch replay',
    ctaIdle: 'Pick a replay',
    emptyTitle: 'No replays saved yet',
    emptyBody:
      'Choose “Save replay” from a match’s menu — any time in single player, once the ' +
      'match is decided in multiplayer — and it is filed here under the date it was saved.',
    hint:
      'A replay re-runs the match exactly as it was played, with an extra speed beyond ' +
      'fast forward.',
    dropHint:
      ' Drag one out of the list to save it as a file, or drop a replay file here to add it.',
    import: importReplayFile,
    remove: deleteReplayFile,
    url: name => '?replay=' + encodeURIComponent(name),
  },
  saves: {
    title: 'Saved games',
    noun: 'saved game',
    article: 'a saved game',
    plural: 'saved games',
    ctaArmed: 'Load save',
    ctaIdle: 'Pick a save',
    emptyTitle: 'No villages saved yet',
    emptyBody:
      'Choose “Save village” from a match’s menu and it is filed here under the date it ' +
      'was saved. Saving again files another one — the last save no longer paves over ' +
      'the one before it.',
    hint: 'Loading a save comes back into that village exactly as it stood, fog and all.',
    dropHint:
      ' Drag one out of the list to keep it as a file, or drop a saved game here to add it.',
    import: importSaveFile,
    remove: deleteSaveFile,
    url: name => '?load=' + encodeURIComponent(name),
  },
};

/** One row of an open shelf, in the terms the list draws. */
interface ShelfRow {
  name: string;
  /** The OPFS-backed file, for the outbound drag. */
  file: File;
  /** Whether this build can open it — a foreign version reads but does
   * not run, and the row says so rather than disappearing. */
  ok: boolean;
  /** The disabled row's title: why not. */
  why?: string;
  /** The small print under the name. */
  meta: string;
}

/** Marcellus draws '1' with serifs that read as an I, so the choice was
 * Roman numerals or a second face in the seal. Arabic past the table. */
const NUMERALS = [
  'I',
  'II',
  'III',
  'IV',
  'V',
  'VI',
  'VII',
  'VIII',
  'IX',
  'X',
  'XI',
  'XII',
];
const numeral = (n: number): string => NUMERALS[n - 1] ?? String(n);

/** Rules only this screen needs; the shared vocabulary is menuChrome. */
const START_STYLE = `
/* ——— The reeve's ledger ———
   Was .room rows, the multiplayer lobby's component — a lobby list is a
   set of interchangeable choices, a campaign is a sequence with a
   history. The seal carries the number, the thread the order, and the
   thread's colour how far along you are. */
#menu .ledger-head { display: flex; align-items: baseline; gap: 11px; padding: 4px 2px 8px; }
#menu .ledger-head .t { font-family: 'Marcellus', Georgia, serif; font-size: 15px; color: #ded7c3; }
#menu .ledger-head .rule { flex: 1; height: 1px; min-width: 12px;
  background: linear-gradient(90deg, rgba(229,196,105,0.34) 0%, rgba(229,196,105,0) 100%); }
#menu .ledger-head .n { flex: none; font-size: 11px; color: #85857c; letter-spacing: 0.04em;
  font-variant-numeric: tabular-nums; }

#menu .ledger { display: flex; flex-direction: column; max-height: 246px; overflow-y: auto;
  overscroll-behavior: contain; scrollbar-width: thin;
  scrollbar-color: rgba(229,196,105,0.3) transparent; }

#menu .commission { position: relative; cursor: pointer; display: flex; align-items: center; gap: 13px;
  padding: 9px 12px; text-align: left; font: inherit; color: #cfccc2;
  background: transparent; border: 1px solid transparent; border-radius: 11px;
  transition: background var(--press-out), border-color var(--press-out), transform var(--press-out); }
/* Each entry carries the thread reaching the one above, so the chain
   scrolls with the list. The -1px is not a nudge: a row has a 1px
   transparent border and a positioned pseudo lays out against the
   padding box, so 0 leaves a two-pixel break at every boundary. */
#menu .commission::before { content: ''; position: absolute; left: 25px; top: -1px; bottom: -1px; width: 2px;
  background: rgba(229,196,105,0.14); }
/* 50%, not a measured offset: the seals are centred, so half a row is
   the seal's centre however tall the row grows. */
#menu .commission:first-child::before { top: 50%; }
#menu .commission:last-child::before { bottom: 50%; }
/* Gold as far as the player has come. */
#menu .commission.done::before { background: rgba(229,196,105,0.42); }

#menu .commission .seal { position: relative; z-index: 1; flex: none; width: 28px; height: 28px;
  display: grid; place-items: center; border-radius: 50%;
  font-family: 'Marcellus', Georgia, serif; font-size: 11.5px; line-height: 1; letter-spacing: 0.02em;
  color: #d8cba6;
  background: linear-gradient(180deg, #322d21 0%, #221f17 100%);
  border: 1px solid rgba(229,196,105,0.26);
  box-shadow: inset 0 1px 0 rgba(255,255,255,0.12), 0 1px 0 rgba(0,0,0,0.45);
  transition: border-color var(--press-out), box-shadow var(--press-out); }

#menu .commission .what { min-width: 0; }
#menu .commission .name { display: block; font-family: 'Marcellus', Georgia, serif;
  font-size: 15.5px; letter-spacing: 0.012em; color: #e9e3d1; }
#menu .commission .charge { display: block; margin-top: 2px; font-size: 11.5px; color: #85857c;
  text-wrap: pretty; }

#menu .commission:hover { background: rgba(255,255,255,0.04); }
#menu .commission:hover .seal { border-color: rgba(229,196,105,0.5); }
#menu .commission:active { transform: translateY(1px); transition-duration: var(--press-in); }

/* Filled rather than ticked, so the list stays numbered as it fills;
   the aria-label carries the state for anyone the colour misses. */
#menu .commission.done .seal { color: #241a10; border-color: rgba(229,196,105,0.68);
  background: radial-gradient(circle at 36% 28%, var(--brass-lit) 0%, var(--gold) 55%, var(--brass) 100%);
  box-shadow: inset 0 1px 0 rgba(255,255,255,0.45), 0 1px 2px rgba(0,0,0,0.45); }

/* A warm wash fading right, the way ink sits on a page. */
#menu .commission.on { border-color: rgba(229,196,105,0.4);
  background: linear-gradient(90deg, rgba(229,196,105,0.15) 0%, rgba(229,196,105,0.035) 76%, rgba(229,196,105,0) 100%); }
#menu .commission.on .name { color: #f8f0d9; }
#menu .commission.on .seal { border-color: rgba(229,196,105,0.85);
  box-shadow: inset 0 1px 0 rgba(255,255,255,0.14), 0 0 0 2px rgba(229,196,105,0.15),
    0 0 10px rgba(229,196,105,0.22); }

/* Sunk rather than faded: what is waiting should look shut, and
   colouring the parts keeps the type legible while it waits. */
#menu .commission.sealed { cursor: default; }
#menu .commission.sealed .name { color: #8b8880; }
/* NOT dimmed further: it is 4.9:1 open, so anything dimmer fails 4.5.
   The shut seal, grey thread and quieter name carry the state. */
#menu .commission.sealed .seal { color: #8a8880; border-color: rgba(255,255,255,0.08);
  background: rgba(0,0,0,0.36); box-shadow: inset 0 1px 3px rgba(0,0,0,0.55); }
#menu .commission.sealed:hover { background: transparent; }
#menu .commission.sealed:hover .seal { border-color: rgba(255,255,255,0.08); }
#menu .commission.sealed:active { transform: none; }

@media (max-width: 560px) {
  /* As the room list: a flick settles, a deliberate nudge still lands. */
  #menu .ledger { scroll-snap-type: y proximity; }
  #menu .commission { scroll-snap-align: start; }
}
@media (max-width: 560px) and (min-height: 720px) {
  #menu .ledger { max-height: 40vh; max-height: 40svh; }
}
`;

export function StartMenu(props: StartMenuProps) {
  // Multiplayer with no connection is a dead pane — the tab is disabled and
  // the relay out of reach — so a screen asked to open there while offline
  // opens on the campaign instead. Same fallback the offline event takes
  // below, taken at the moment the screen first appears; what the player
  // chose stays written down for the next launch that has a network.
  const [mode, setMode] = createSignal<Mode>(
    props.start.mode === 'multi' && !navigator.onLine
      ? OFFLINE_PANE
      : props.start.mode,
  );
  /** The card, for the height it travels when a pane swaps. */
  let cardEl: HTMLDivElement | undefined;
  /** The pane area, so a swap fades rather than cuts. */
  let rowsEl: HTMLDivElement | undefined;
  /**
   * Carry the card between pane heights. `from` is read before the signal
   * and `to` after — Solid sets synchronously, so the new pane is already
   * laid out. WAAPI because both ends are measurements, not stylesheet
   * values. Sits out reduced motion, and SHORT where the cap rules.
   */
  const carryCardHeight = (from: number | undefined): void => {
    const el = cardEl;
    if (el === undefined || from === undefined) return;
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    if (matchMedia(SHORT).matches) return;
    const to = el.offsetHeight;
    if (to === from) return;
    el.animate([{height: `${from}px`}, {height: `${to}px`}], {
      duration: 280,
      easing: 'cubic-bezier(0.32, 0.9, 0.36, 1)',
    });
    // The pane arrives rather than appears, over the same beat.
    rowsEl?.animate([{opacity: '0.3'}, {opacity: '1'}], {
      duration: 240,
      easing: 'ease-out',
    });
  };

  /** Switch panes the way the tab bar does: the choice is remembered. */
  const pickMode = (next: Mode): void => {
    if (next === mode()) return;
    const from = cardEl?.offsetHeight;
    setMode(next);
    rememberMode(next);
    carryCardHeight(from);
  };
  const [mp, setMp] = createSignal<MpMode>(props.start.mp);
  const [ai, setAi] = createSignal(2);
  // One roll per visit to this screen, which is one roll per launch:
  // launching leaves the menu, and coming back builds it again.
  const seed = rollSeed();
  const [bandits, setBandits] = createSignal(true);
  // One tier for the whole table. The sim stores it per seat (a future
  // picker could field one hard lord and two easy ones); nothing here has
  // ever wanted to ask a player for three answers to one question.
  const [difficulty, setDifficulty] = createSignal<DifficultyId>(
    DifficultyIdNs.normal,
  );
  const [room, setRoom] = createSignal('');
  const [vis, setVis] = createSignal<Visibility>('open');
  const [picked, setPicked] = createSignal<string | null>(null);
  /**
   * The open rooms, as a store rather than a signal. The poll answers with
   * a whole new list every three seconds, and a plain signal made every one
   * of those a fresh array of fresh objects — so <For>, which keys on
   * identity, rebuilt every row. Rows that rebuild under the cursor cannot
   * be clicked reliably, lose keyboard focus, and drop the list's scroll
   * position; the visible flicker was only the symptom.
   *
   * reconcile keyed on the room code diffs the answer against what is
   * already there: an unchanged room keeps its DOM node, a room whose seats
   * filled updates that text in place, and only rooms that actually came or
   * went touch the list.
   */
  const [rooms, setRooms] = createStore<OpenRoom[]>([]);
  const [loadingRooms, setLoadingRooms] = createSignal(false);
  // The service worker keeps the shell and the models on disk, so a cold
  // launch with no network still reaches this menu — and single player,
  // being a local sim, still plays. Only the relay-backed half of the
  // screen has to stand down. navigator.onLine overstates connectivity
  // (a captive portal reads as online) but never understates it, which is
  // the direction that matters here: false means definitely not hosting.
  const [online, setOnline] = createSignal(navigator.onLine);

  // A shelf is not a fourth way to set up a match — it is somewhere you go
  // and look — so the two of them hang off the secondary row rather than
  // the tab bar, and cover the card while one is open. Keeping them out of
  // `.seg` is also what keeps three tabs inside a phone-width card: four
  // could not shrink below "MULTIPLAYER" and pushed the whole screen wide.
  const [shelf, setShelf] = createSignal<ShelfKind | null>(null);
  const isMulti = (): boolean => shelf() === null && mode() === 'multi';
  const isSingle = (): boolean => shelf() === null && mode() === 'single';
  const isCampaign = (): boolean => shelf() === null && mode() === 'campaign';
  const isJoin = (): boolean => isMulti() && mp() === 'join';

  // The shelves: what OPFS holds under /replays and /saves, newest first.
  // Both are read on arrival — the secondary buttons report their counts
  // and stand down without one — and again after a delete or an import.
  // Nothing else changes them: recordings and saves are written from
  // inside a match, which is a navigation away.
  const [replays, setReplays] = createSignal<ReplayFileInfo[]>([]);
  const [saves, setSaves] = createSignal<SaveFileInfo[]>([]);
  const [replaysLoaded, setReplaysLoaded] = createSignal(false);
  const [savesLoaded, setSavesLoaded] = createSignal(false);
  /** Which row is armed on the open shelf. One signal for both: only one
   * shelf is open at a time, and closing one disarms it. */
  const [pickedFile, setPickedFile] = createSignal<string | null>(null);
  const refreshReplays = async (): Promise<void> => {
    const found = await listReplayFiles();
    setReplays(found);
    setReplaysLoaded(true);
    dropStalePick(found);
  };
  const refreshSaves = async (): Promise<void> => {
    const found = await listSaveFiles();
    setSaves(found);
    setSavesLoaded(true);
    dropStalePick(found);
  };
  const refreshShelf = (kind: ShelfKind): Promise<void> =>
    kind === 'replays' ? refreshReplays() : refreshSaves();
  /** A row that was armed and is no longer there (deleted, or listed away
   * by another tab) must not stay armed behind the CTA. */
  const dropStalePick = (found: StoredFileInfo[]): void => {
    if (pickedFile() !== null && !found.some(f => f.name === pickedFile()))
      setPickedFile(null);
  };
  /** What the last drop came to — filed, refused, or a mix. Stands until
   * the next drop or the shelf closes; a timer would take it away
   * mid-read. */
  const [importNote, setImportNote] = createSignal<string | null>(null);
  /** Leave the shelf empty-handed: a pick left armed would sit behind the
   * tab bar with nothing on screen naming it, and still read as "Watch
   * replay" on the button. */
  const closeShelf = (): void => {
    setPickedFile(null);
    setImportNote(null);
    setShelf(null);
  };
  const openShelf = (kind: ShelfKind): void => {
    setPickedFile(null);
    setImportNote(null);
    setShelf(kind);
    void refreshShelf(kind);
  };
  /** True while one of the shelf's own rows is the thing in flight: the
   * list must not catch its outbound drag and file a duplicate. */
  let dragOut = false;
  /** Depth of dragenter minus dragleave over the shelf. Crossing into a
   * row fires both, so a plain boolean would flicker the highlight. */
  const [dropDepth, setDropDepth] = createSignal(0);
  /** A drag the shelf wants: someone else's files, not its own row. */
  const fileDrag = (e: DragEvent): boolean =>
    !dragOut && (e.dataTransfer?.types.includes('Files') ?? false);
  const onShelfDrop = (e: DragEvent): void => {
    e.preventDefault();
    setDropDepth(0);
    const kind = shelf();
    const files = Array.from(e.dataTransfer?.files ?? []);
    if (kind === null || dragOut || files.length === 0) return;
    const spec = SHELVES[kind];
    void (async () => {
      // One at a time: parallel imports of same-named files would race
      // the free-name check where Web Locks is absent.
      const results: ImportResult[] = [];
      for (const f of files) results.push(await spec.import(f));
      const filed = results.flatMap(r => (r.ok ? [r.name] : []));
      const bad = results.length - filed.length;
      await refreshShelf(kind);
      const last = filed.at(-1);
      // Arm the newcomer, so drop-then-open is one click — but only one
      // this build can open: an import from another build lands on a row
      // the shelf shows disabled, and the pick must not outrun the row.
      if (last !== undefined && rows().find(r => r.name === last)?.ok)
        setPickedFile(last);
      setImportNote(
        filed.length === 0
          ? results.some(r => !r.ok && r.reason === 'storage')
            ? `Import failed — ${spec.noun} storage is unavailable here`
            : files.length === 1
              ? `That file is not ${spec.article}`
              : `None of those files are ${spec.plural}`
          : bad === 0
            ? filed.length === 1
              ? `Filed as “${last}”`
              : `Filed ${filed.length} ${spec.plural}`
            : `Filed ${filed.length} — the other ` +
              (bad === 1
                ? `file is not ${spec.article}`
                : `${bad} are not ${spec.plural}`),
      );
    })();
  };
  /** Hand one row's document to the system share sheet. The bytes travel
   * as text/plain under a .txt name — the type Chromium's allowlist
   * lets through where application/json is refused — and both imports
   * strip that wrapper, so a shared file refiles under its own name. */
  const shareRow = (r: ShelfRow): void => {
    const file = new File([r.file], `${r.name}.txt`, {type: 'text/plain'});
    void navigator.share({files: [file]}).catch(() => {
      // Dismissed, or this sheet refused the payload — either way the
      // sheet has already answered the click; nothing to add here.
    });
  };
  // A file drop that misses the shelf must not become a navigation: the
  // browser's default for a dropped file is to open it, replacing the
  // game with a screenful of JSON. Only drags carrying files are
  // swallowed — preventing everything here would also cancel the default
  // a text drag relies on to land in the room-code input — and
  // at the window rather than the card so the whole viewport is covered;
  // the shelf's own drop handler has already run by the time these fire.
  const swallowDrop = (e: DragEvent): void => {
    if (e.dataTransfer?.types.includes('Files')) e.preventDefault();
  };
  window.addEventListener('dragover', swallowDrop);
  window.addEventListener('drop', swallowDrop);
  onCleanup(() => {
    window.removeEventListener('dragover', swallowDrop);
    window.removeEventListener('drop', swallowDrop);
  });
  const fmtSize = (bytes: number): string =>
    bytes >= 1048576
      ? `${(bytes / 1048576).toFixed(1)} MB`
      : `${Math.max(1, Math.round(bytes / 1024))} KB`;

  /** Playback re-runs the sim, so only this build's own recordings play. */
  const replayRow = (r: ReplayFileInfo): ShelfRow => {
    const ok = r.replayVersion === REPLAY_VERSION;
    return {
      name: r.name,
      file: r.file,
      ok,
      ...(ok
        ? {}
        : {
            why:
              `Recorded under replay version ${r.replayVersion ?? 'unknown'} — ` +
              `this build plays version ${REPLAY_VERSION} and cannot play it back`,
          }),
      meta: fmtSize(r.size) + (ok ? '' : ' · from an older build'),
    };
  };

  /** A save is world state read straight back into the sim's records, so a
   * file written in another shape cannot be loaded — the same story as a
   * replay's version, told in the same place. The format version is read
   * from the file itself rather than from the metadata head: a save from an
   * older build predates the head, and it is precisely the file this row
   * has to be able to refuse. One that says nothing at all is offered, and
   * the load path screens it again before a match is built. */
  const saveRow = (f: SaveFileInfo): ShelfRow => {
    const ok = f.world === undefined || canReadSave(f.world);
    const missionId = parseMissionId(f.meta?.mission);
    const mission =
      missionId !== undefined ? MISSION_DEFS[missionId] : undefined;
    const opponents = f.meta?.opponents ?? 0;
    const what =
      mission?.title ??
      (f.meta === undefined
        ? undefined
        : opponents > 0
          ? `${opponents} opponent${opponents === 1 ? '' : 's'}`
          : 'Sandbox');
    return {
      name: f.name,
      file: f.file,
      ok,
      ...(ok
        ? {}
        : {
            why:
              `Written in save format ${f.world ?? 'unknown'} — this build reads ` +
              `format ${WORLD_SAVE_VERSION} and cannot open that village`,
          }),
      meta: [what, fmtSize(f.size), ok ? undefined : 'from an older build']
        .filter(part => part !== undefined)
        .join(' · '),
    };
  };

  /** The open shelf's rows; empty when no shelf is open. */
  const rows = (): ShelfRow[] => {
    const kind = shelf();
    if (kind === 'replays') return replays().map(replayRow);
    if (kind === 'saves') return saves().map(saveRow);
    return [];
  };
  const shelfSpec = (): ShelfSpec | null => {
    const kind = shelf();
    return kind === null ? null : SHELVES[kind];
  };
  const shelfLoaded = (): boolean =>
    shelf() === 'saves' ? savesLoaded() : replaysLoaded();

  // The campaign pane opens on the frontier: the first commission not yet
  // fulfilled (everything done = the finale stays selected).
  const frontier = (): MissionId =>
    MISSION_ORDER.find(id => !isMissionComplete(id)) ??
    MISSION_ORDER[MISSION_ORDER.length - 1]!;
  const [pickedMission, setPickedMission] = createSignal<MissionId>(frontier());

  let inFlight = false;
  const refresh = async (): Promise<void> => {
    if (inFlight) return; // a slow server must not stack up polls
    inFlight = true;
    setLoadingRooms(true);
    const found = await listRooms();
    setRooms(reconcile(found, {key: 'code'}));
    // A room that filled up or started while selected can no longer be joined.
    const still = found.find(r => r.code === picked());
    if (picked() && (!still || still.filled >= still.total)) setPicked(null);
    setLoadingRooms(false);
    inFlight = false;
  };

  const poll = setInterval(() => {
    // Not while hidden: a backgrounded menu owes the relay no traffic.
    if (isJoin() && online() && !document.hidden) void refresh();
  }, POLL_MS);
  onCleanup(() => clearInterval(poll));

  // Back from the background: the poll skipped every beat while hidden, so
  // the room list is stale the moment the page is looked at again.
  const syncVisible = (): void => {
    if (!document.hidden && isJoin() && online()) void refresh();
  };
  document.addEventListener('visibilitychange', syncVisible);
  onCleanup(() =>
    document.removeEventListener('visibilitychange', syncVisible),
  );

  const syncOnline = (): void => {
    setOnline(navigator.onLine);
    // Losing the connection mid-menu leaves the multiplayer pane pointing
    // at a relay that is not there; fall back to the half that still works.
    if (!navigator.onLine) setMode(OFFLINE_PANE);
    else if (isJoin()) void refresh();
  };
  window.addEventListener('online', syncOnline);
  window.addEventListener('offline', syncOnline);
  onCleanup(() => {
    window.removeEventListener('online', syncOnline);
    window.removeEventListener('offline', syncOnline);
  });

  // Coming back from the council on the join pane: the room list is stale
  // by definition, and the poll is up to three seconds away.
  onMount(() => {
    if (isJoin() && online()) void refresh();
    // Each shelf button reports its own count and stands down at zero, so
    // both shelves have to be read before anyone opens one.
    void refreshReplays();
    void refreshSaves();
  });

  // Full screen is offered here rather than imposed: no browser grants it
  // outside a gesture, so the switch below is the only thing that can ask
  // for it. It carries into the match on its own — launching no longer
  // costs a document (app/router.ts) — and the answer is remembered for
  // the reloads that still happen (see fullscreen.ts).
  const fs = fullscreen();

  /** The single-player launch URL. Multiplayer has none: it walks into the
   * council in place, and the room's settings live on the relay. */
  const search = (): string => {
    const p = new URLSearchParams();
    if (ai() > 0) p.set('ai', String(ai()));
    // No ?bots: who the opponents are is the seed's to deal, and finding
    // out is the first thing the match has to tell you. (The parameter
    // still reads at the other end — it is how the dev testbed pins a
    // playbook — the menu just never writes one.)
    p.set('seed', String(seed));
    if (!bandits()) p.set('bandits', '0');
    // Only a tier that is not the printed game travels: a normal launch
    // URL is the URL it has always been.
    if (difficulty() !== DifficultyIdNs.normal)
      p.set('difficulty', DIFFICULTY_KEYS[difficulty()]);
    return '?' + p.toString();
  };

  const target = (): string => picked() ?? room();
  const ctaLabel = (): string => {
    const spec = shelfSpec();
    if (spec) return pickedFile() !== null ? spec.ctaArmed : spec.ctaIdle;
    if (isCampaign()) return `Begin: ${MISSION_DEFS[pickedMission()].title}`;
    if (!isMulti()) return ai() > 0 ? 'Begin skirmish' : 'Begin sandbox';
    if (isJoin()) return target() ? 'Join ' + target() : 'Pick a room';
    return vis() === 'private' ? 'Create private room' : 'Create open room';
  };

  /** Open one row of the shelf — watch a replay, load a village. A
   * navigation like any single-player launch: the name is the whole query
   * string, the document itself lives in OPFS. */
  const launchFile = (name: string): void => {
    const spec = shelfSpec();
    if (!spec) return;
    releaseMenuBackdrop();
    goto(spec.url(name));
  };

  const launch = (): void => {
    if (isJoin() && !target()) return;
    if (shelfSpec()) {
      const name = pickedFile();
      if (name !== null) launchFile(name);
      return;
    }
    clearSeatStash(); // a menu launch is fresh intent, never a reconnect
    if (isCampaign()) {
      // A mission is a navigation like any single-player launch: the def's
      // name is the whole query string, the recipe lives in the sim's
      // table. Spelled by missionUrl rather than here — interpolating the
      // id read as an unknown mission, and the launch quietly became a
      // default skirmish with no briefing and no checklist.
      releaseMenuBackdrop();
      goto(missionUrl(pickedMission(), difficulty()));
      return;
    }
    if (isMulti()) {
      props.onCouncil({
        mp: isJoin() ? target().toUpperCase() : 'new',
        open: vis() === 'open',
        // Seats, seed, raids and the difficulty open at their defaults and
        // are set in the council, where every joiner watches them change.
        // Deliberately not the pick from this screen: that picker is not
        // shown on the multiplayer tab, so carrying it would set the room
        // from a control the host cannot see.
        init: defaultLobbyConfig(),
      });
      return;
    }
    // The sim's first act is to ask for a WebGL context. Give the
    // backdrop's back before leaving: multiplayer's handover already does
    // (the shell unmounts first), and a phone that has to hold two at once
    // is a phone that grants neither.
    releaseMenuBackdrop();
    goto(search());
  };
  const onEnter = (e: KeyboardEvent): void => {
    if (e.key === 'Enter') launch();
  };

  return (
    <>
      {/* The shared sheet and veils belong to the shell. */}
      <style>{START_STYLE}</style>

      <div class="shell">
        <div class="stack">
          <div class="title">
            <div class="kicker">
              <i />
              <span>Medieval Economy · RTS</span>
              <i class="r" />
            </div>
            <h1>SERF VALLEY</h1>
            {/* The staging deploy says so on its face. Installed to a home
                screen the tab title and the manifest name are out of sight,
                and the footer that spells the branch out is the first thing
                a short window drops. */}
            <Show when={BUILD_CHANNEL === 'staging'}>
              <span class="channel">Staging</span>
            </Show>
            <p class="tagline">
              Settle the valley. Feed the levy. Hold the road.
            </p>
          </div>

          <div class="card" ref={cardEl}>
            {/* The shelf takes the tab bar's slot rather than sitting under
                it: a highlighted "Single player" above a list of replays
                would be a lie, and swapping in place keeps the card from
                jumping. */}
            <Show
              when={shelfSpec() === null}
              fallback={
                <div class="pane-head">
                  <button
                    class="icon-btn"
                    aria-label="Back to the menu"
                    onClick={closeShelf}
                  >
                    {BackIcon}
                  </button>
                  <span class="title">{shelfSpec()?.title}</span>
                  <span class="count">{rows().length} saved</span>
                </div>
              }
            >
              <div class="seg" style={{'--n': MODE_ORDER.length}}>
                <Glide index={MODE_ORDER.indexOf(mode())} />
                <button
                  class={mode() === 'single' ? 'on' : ''}
                  onClick={() => pickMode('single')}
                >
                  {OneIcon}
                  Single player
                </button>
                <button
                  class={mode() === 'campaign' ? 'on' : ''}
                  onClick={() => pickMode('campaign')}
                >
                  {BannerIcon}
                  Campaign
                </button>
                <button
                  class={mode() === 'multi' ? 'on' : ''}
                  disabled={!online()}
                  title={
                    online() ? undefined : 'Needs a connection to the relay'
                  }
                  onClick={() => {
                    pickMode('multi');
                    if (mp() === 'join') void refresh();
                  }}
                >
                  {ManyIcon}
                  Multiplayer
                </button>
              </div>
            </Show>

            <div class="rows" ref={rowsEl}>
              <Show when={!online() && shelfSpec() === null}>
                <div class="row">
                  <div>
                    <div class="row-label">Offline</div>
                    <div class="row-hint">
                      The valley runs on this device — skirmishes and saves are
                      unaffected. Multiplayer comes back with the connection.
                    </div>
                  </div>
                </div>
              </Show>

              <Show when={isMulti()}>
                <div class="choices">
                  <button
                    class={`choice ${mp() === 'host' ? 'on' : ''}`}
                    onClick={() => setMp('host')}
                  >
                    <span>Host a room</span>
                    <span class="row-hint" style="display:block">
                      You generate the valley
                    </span>
                  </button>
                  <button
                    class={`choice ${mp() === 'join' ? 'on' : ''}`}
                    onClick={() => {
                      setMp('join');
                      void refresh();
                    }}
                  >
                    <span>Join a room</span>
                    <span class="row-hint" style="display:block">
                      Pick one, or use a code
                    </span>
                  </button>
                </div>
              </Show>

              <Show when={isJoin()}>
                <div class="browser">
                  <div class="browser-head">
                    <div style="display:flex;align-items:baseline;gap:8px">
                      <span class="row-label">Open rooms</span>
                      <span class="count">{rooms.length} open</span>
                    </div>
                    <button
                      class="icon-btn"
                      title="Refresh"
                      style="width:30px;height:30px;border-radius:8px"
                      onClick={() => void refresh()}
                    >
                      <svg
                        width="13"
                        height="13"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="2"
                        stroke-linecap="round"
                      >
                        <path d="M21 12a9 9 0 1 1-2.64-6.36" />
                        <path d="M21 3v5h-5" />
                      </svg>
                    </button>
                  </div>

                  <Show when={loadingRooms() && rooms.length === 0}>
                    <div class="browser-load">Looking for open rooms…</div>
                  </Show>

                  <Show when={rooms.length > 0}>
                    <div class="room-list">
                      <For each={rooms}>
                        {r => {
                          const full = (): boolean => r.filled >= r.total;
                          // Index, not For: a pip is a seat, and a seat
                          // being taken should light the pip already there
                          // rather than rebuild the row's dots.
                          const pips = (): boolean[] =>
                            Array.from(
                              {length: r.total},
                              (_, i) => i < r.filled,
                            );
                          return (
                            <button
                              class={`room ${picked() === r.code ? 'on' : ''}`}
                              disabled={full()}
                              onClick={() => {
                                setPicked(picked() === r.code ? null : r.code);
                                setRoom('');
                              }}
                              // This row's own code, not the selection: the
                              // two clicks a double-click is made of have
                              // already toggled the pick back off by the
                              // time this fires, and launch() on an empty
                              // target is a silent nothing. (The shelf rows
                              // below dodge the same pitfall.)
                              onDblClick={() => {
                                setPicked(r.code);
                                setRoom('');
                                launch();
                              }}
                            >
                              <span style="min-width:0">
                                <span class="code">{r.code}</span>
                                <span class="meta">
                                  {r.filled}/{r.total} seats ·{' '}
                                  {r.ai
                                    ? `${r.ai} AI seat${r.ai > 1 ? 's' : ''}`
                                    : 'no AI'}{' '}
                                  · {full() ? 'full' : ago(r.ageMs)}
                                </span>
                              </span>
                              <span class="pips">
                                <Index each={pips()}>
                                  {on => <span class={on() ? 'filled' : ''} />}
                                </Index>
                              </span>
                            </button>
                          );
                        }}
                      </For>
                    </div>
                  </Show>

                  <Show when={!loadingRooms() && rooms.length === 0}>
                    <div class="browser-none">
                      <div class="t">No open rooms right now</div>
                      <div class="s">
                        Host one, or join a private room with its code.
                      </div>
                    </div>
                  </Show>
                </div>

                <div class="code-row">
                  <span>Room not listed? Use its code</span>
                  <input
                    class="code"
                    placeholder="ABCDE"
                    maxLength={6}
                    value={room()}
                    onKeyDown={onEnter}
                    onInput={e => {
                      setPicked(null);
                      setRoom(
                        e.currentTarget.value
                          .replace(/[^a-zA-Z0-9]/g, '')
                          .toUpperCase()
                          .slice(0, 6),
                      );
                    }}
                  />
                </div>
              </Show>

              <Show when={isMulti() && mp() === 'host'}>
                <div class="row">
                  <div>
                    <div class="row-label">Room visibility</div>
                    <div class="row-hint">
                      Open rooms appear in everyone’s browser
                    </div>
                  </div>
                  <div class="vis">
                    <Glide index={vis() === 'open' ? 0 : 1} />
                    <button
                      class={vis() === 'open' ? 'on' : ''}
                      title="Listed for anyone to join"
                      onClick={() => setVis('open')}
                    >
                      Open
                    </button>
                    <button
                      class={vis() === 'private' ? 'on' : ''}
                      title="Code only — unlisted"
                      onClick={() => setVis('private')}
                    >
                      Private
                    </button>
                  </div>
                </div>
                <div class="row">
                  <div>
                    <div class="row-label">Match settings</div>
                    <div class="row-hint">
                      Computer seats, map seed and bandit raids are chosen in
                      the War Council, where everyone sees them.
                    </div>
                  </div>
                </div>
              </Show>

              <Show when={isCampaign()}>
                <div class="browser">
                  <div class="ledger-head">
                    <span class="t">The reeve’s commissions</span>
                    <i class="rule" />
                    <span class="n">
                      {MISSION_ORDER.filter(id => isMissionComplete(id)).length}{' '}
                      of {MISSION_ORDER.length} fulfilled
                    </span>
                  </div>
                  <div class="ledger">
                    <For each={MISSION_ORDER}>
                      {(id, i) => {
                        const def = MISSION_DEFS[id];
                        const locked = (): boolean => !isMissionUnlocked(id);
                        const done = (): boolean => isMissionComplete(id);
                        return (
                          <button
                            class="commission"
                            classList={{
                              on: pickedMission() === id,
                              done: done(),
                              sealed: locked(),
                            }}
                            disabled={locked()}
                            /* Colour and the thread carry the state; a
                               screen reader sees neither. */
                            aria-label={`Commission ${i() + 1}, ${def.title}. ${
                              done()
                                ? 'Fulfilled.'
                                : locked()
                                  ? 'Sealed until the one before it is fulfilled.'
                                  : 'Open.'
                            }`}
                            title={
                              locked()
                                ? 'Fulfill the commission before it'
                                : undefined
                            }
                            onClick={() => setPickedMission(id)}
                            onDblClick={launch}
                          >
                            <span class="seal" aria-hidden="true">
                              {locked() ? (
                                <LockIcon size={12} />
                              ) : (
                                numeral(i() + 1)
                              )}
                            </span>
                            <span class="what">
                              <span class="name">{def.title}</span>
                              <span class="charge">{def.tagline}</span>
                            </span>
                          </button>
                        );
                      }}
                    </For>
                  </div>
                  <div class="row-hint">
                    A tutorial in seven commissions. Hints can be hidden in the
                    first minute. Finishing one unseals the next.
                  </div>
                </div>
                <DifficultyRow
                  value={difficulty()}
                  onChange={setDifficulty}
                  hint={difficultyHint('campaign')}
                />
              </Show>

              <Show when={shelfSpec() !== null}>
                <div
                  class="browser"
                  classList={{dropping: dropDepth() > 0}}
                  onDragEnter={e => {
                    if (!fileDrag(e)) return;
                    e.preventDefault();
                    setDropDepth(d => d + 1);
                  }}
                  onDragLeave={() => setDropDepth(d => Math.max(0, d - 1))}
                  onDragOver={e => {
                    // preventDefault is how a drop target says yes; the
                    // default answer is no.
                    if (!fileDrag(e) || !e.dataTransfer) return;
                    e.preventDefault();
                    e.dataTransfer.dropEffect = 'copy';
                  }}
                  onDrop={onShelfDrop}
                >
                  <Show when={rows().length > 0}>
                    <div class="room-list" style="max-height:236px">
                      <For each={rows()}>
                        {r => {
                          // The file's blob URL, minted with the row and
                          // revoked with it. A drag must hand this over
                          // synchronously at dragstart, and dragend is too
                          // soon to revoke — the desktop drop may still be
                          // streaming from it. One URL per visible row is
                          // a registry entry, not a copy of the file.
                          const dragUrl = URL.createObjectURL(r.file);
                          onCleanup(() => URL.revokeObjectURL(dragUrl));
                          return (
                            // Row and delete are siblings, not nested: an
                            // interactive control inside a button is an
                            // invalid a11y tree, and the wrapper is what
                            // lets both be real buttons.
                            <div
                              class="replay-row"
                              draggable={true}
                              onDragEnd={() => {
                                dragOut = false;
                              }}
                              onDragStart={e => {
                                // Flagged before anything else: the shelf
                                // is a drop target now, and must not
                                // catch its own row on the way out.
                                dragOut = true;
                                const dt = e.dataTransfer;
                                if (!dt) return;
                                // Two spellings of "this file": the item is
                                // what a web drop target (an upload box,
                                // another tab) reads, and DownloadURL is
                                // Chromium's contract for a drop onto the
                                // desktop. Colons delimit its triple; the
                                // store's name rule keeps names clear of
                                // them.
                                dt.items.add(r.file);
                                dt.setData(
                                  'DownloadURL',
                                  `application/json:${r.file.name}:${dragUrl}`,
                                );
                                dt.effectAllowed = 'copy';
                              }}
                            >
                              <button
                                class={`room ${pickedFile() === r.name ? 'on' : ''}`}
                                // Disabled, not hidden — a file this build
                                // cannot open is exactly the one worth
                                // deleting, and the row still has to read.
                                disabled={!r.ok}
                                title={r.why}
                                onClick={() =>
                                  setPickedFile(
                                    pickedFile() === r.name ? null : r.name,
                                  )
                                }
                                // This row's own name, not the selection:
                                // the two clicks a double-click is made of
                                // have already toggled the pick back off by
                                // the time this fires.
                                onDblClick={() => launchFile(r.name)}
                              >
                                <span style="min-width:0">
                                  <span
                                    class="code"
                                    style="letter-spacing:0.02em"
                                  >
                                    {r.name}
                                  </span>
                                  <span class="meta">{r.meta}</span>
                                </span>
                              </button>
                              <Show when={SHARE_OFFERED}>
                                {/* Enabled even on a row this build cannot
                                    play: sharing moves bytes, and the
                                    friend's build may be the right one. */}
                                <button
                                  class="icon-btn"
                                  title={`Share this ${shelfSpec()?.noun}`}
                                  aria-label={`Share ${shelfSpec()?.noun} ${r.name}`}
                                  onClick={() => shareRow(r)}
                                >
                                  <ShareIcon />
                                </button>
                              </Show>
                              <button
                                class="icon-btn"
                                title={`Delete this ${shelfSpec()?.noun}`}
                                aria-label={`Delete ${shelfSpec()?.noun} ${r.name}`}
                                onClick={() => {
                                  const kind = shelf();
                                  if (kind === null) return;
                                  void SHELVES[kind]
                                    .remove(r.name)
                                    .then(() => refreshShelf(kind));
                                }}
                              >
                                ✕
                              </button>
                            </div>
                          );
                        }}
                      </For>
                    </div>
                  </Show>

                  <Show when={shelfLoaded() && rows().length === 0}>
                    <div class="browser-none">
                      <div class="t">{shelfSpec()?.emptyTitle}</div>
                      <div class="s">
                        {shelfSpec()?.emptyBody}
                        {DRAG_OFFERED
                          ? ` A ${shelfSpec()?.noun} someone shared with you can be dropped ` +
                            'anywhere on this panel.'
                          : ''}
                      </div>
                    </div>
                  </Show>

                  <Show when={importNote() !== null}>
                    <div class="row-hint" style="color:#d9c37a">
                      {importNote()}
                    </div>
                  </Show>

                  <div class="row-hint">
                    {shelfSpec()?.hint}
                    {DRAG_OFFERED ? shelfSpec()?.dropHint : ''}
                    {SHARE_OFFERED
                      ? ` The share button hands a ${shelfSpec()?.noun} to another app or device.`
                      : ''}
                  </div>
                </div>
              </Show>

              <Show when={isSingle()}>
                <div class="row">
                  <div>
                    <div class="row-label">Computer opponents</div>
                    <div class="row-hint">They build and raid like you do</div>
                  </div>
                  <div class="pills" style={{'--n': AI_SEATS.length}}>
                    <Glide index={ai()} />
                    <For each={AI_SEATS}>
                      {n => (
                        <button
                          class={ai() === n ? 'on' : ''}
                          onClick={() => setAi(n)}
                        >
                          {n}
                        </button>
                      )}
                    </For>
                  </div>
                </div>

                <DifficultyRow
                  value={difficulty()}
                  onChange={setDifficulty}
                  hint={difficultyHint(ai() === 0 ? 'sandbox' : 'skirmish')}
                />
              </Show>

              <Show when={isSingle() && OPTIONS.showBanditsRow}>
                <div class="row">
                  <div>
                    <div class="row-label">Bandit raids</div>
                    <div class="row-hint">
                      Neutral hostiles harass the roads
                    </div>
                  </div>
                  <button
                    class={`toggle ${bandits() ? 'on' : ''}`}
                    role="switch"
                    aria-checked={bandits()}
                    aria-label="Bandit raids"
                    onClick={() => setBandits(!bandits())}
                  >
                    <span />
                  </button>
                </div>
              </Show>

              {/* Player properties, not match settings — outside every
                  mode's Show, like fullscreen below: a player muting the
                  game wants it muted before the first match sound, not
                  after. */}
              <div class="row">
                <div class="row-label">Sound</div>
                <button
                  class={`toggle ${!muted() ? 'on' : ''}`}
                  role="switch"
                  aria-checked={!muted()}
                  aria-label="Sound"
                  onClick={() => toggleMuted()}
                >
                  <span />
                </button>
              </div>

              {/* The only other row outside every mode's Show: this
                  is not a match setting but a property of the window, and
                  it belongs to a replay and a multiplayer room as much as
                  to a skirmish. Switched here rather than merely armed — a
                  toggle is a gesture, and a gesture is the only thing a
                  browser takes a fullscreen request from.

                  One switch, three behaviours: the screen, the pointer
                  captured inside it (input/mouseCapture.ts), and the map
                  following that pointer at the edges (input/edgeScroll.ts).
                  They were three rows once. They are one because they are
                  one decision — a player asking for the whole screen is
                  asking to play with the whole screen, and the two that
                  used to be separate only ever made sense together. */}
              <Show when={fs.offerable()}>
                <div class="row">
                  <div>
                    <div class="row-label">Full screen</div>
                    <div class="row-hint">
                      The pointer plays inside it, and the edges pan the map
                    </div>
                  </div>
                  <button
                    class={`toggle ${fs.active() ? 'on' : ''}`}
                    role="switch"
                    aria-checked={fs.active()}
                    aria-label="Full screen"
                    onClick={() => fs.toggle()}
                  >
                    <span />
                  </button>
                </div>
              </Show>
            </div>

            <div class="cta-wrap">
              <button
                class={`cta ${(isJoin() && !target()) || (shelfSpec() !== null && pickedFile() === null) ? 'dim' : ''}`}
                onClick={launch}
                ref={spotlight}
              >
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="currentColor"
                >
                  <path d="M8 5.5v13l11-6.5z" />
                </svg>
                {ctaLabel()}
              </button>
              <Show when={OPTIONS.showLaunchUrl && !isMulti()}>
                <div class="cta-url">
                  <svg
                    width="11"
                    height="11"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                  >
                    <path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7L11 5" />
                    <path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7L13 19" />
                  </svg>
                  <span>/{search()}</span>
                </div>
              </Show>
            </div>
          </div>

          <div class="secondary">
            {/* Two shelves, side by side: saved villages and recorded
                matches are both ways back into a match that already
                happened, and neither is a way to set a new one up. */}
            <button
              disabled={saves().length === 0 && !DRAG_OFFERED}
              title={
                saves().length > 0
                  ? 'Resume a saved village'
                  : DRAG_OFFERED
                    ? 'No saves on this device — a dropped save file is filed here'
                    : 'No saves on this device'
              }
              onClick={() => openShelf('saves')}
            >
              <svg
                width="13"
                height="13"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="1.8"
                stroke-linecap="round"
              >
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <path d="M7 10l5 5 5-5" />
                <path d="M12 15V3" />
              </svg>
              Load save{saves().length > 0 ? ` (${saves().length})` : ''}
            </button>
            <button
              disabled={replays().length === 0 && !DRAG_OFFERED}
              title={
                replays().length > 0
                  ? 'Watch a recorded match'
                  : DRAG_OFFERED
                    ? 'No replays saved — a dropped replay file is filed here'
                    : 'No replays on this device'
              }
              onClick={() => openShelf('replays')}
            >
              {ScrollIcon}
              Replays{replays().length > 0 ? ` (${replays().length})` : ''}
            </button>
            <button
              title="Author a map of your own — kaleidoscope brushes, then play it"
              onClick={() => {
                releaseMenuBackdrop();
                goto('?editor');
              }}
            >
              <svg
                width="13"
                height="13"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="1.8"
                stroke-linecap="round"
              >
                <path d="M12 19l7-7 3 3-7 7-3-3z" />
                <path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z" />
                <path d="M2 2l7.586 7.586" />
              </svg>
              Map editor
            </button>
            {/* The field guide is a place to read rather than a way into a
                match, so it sits at the end of the shelf row. A path, not a
                query param — it is the one screen worth linking to. */}
            <button
              title="Every building, unit, good and research, cross-referenced"
              onClick={() => {
                releaseMenuBackdrop();
                goto('/docs');
              }}
            >
              <svg
                width="13"
                height="13"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="1.8"
                stroke-linecap="round"
                stroke-linejoin="round"
              >
                <path d="M3 4.5A1.5 1.5 0 0 1 4.5 3H9a3 3 0 0 1 3 3v14a2.5 2.5 0 0 0-2.5-2.5H3z" />
                <path d="M21 4.5A1.5 1.5 0 0 0 19.5 3H15a3 3 0 0 0-3 3v14a2.5 2.5 0 0 1 2.5-2.5H21z" />
              </svg>
              Field guide
            </button>
          </div>
        </div>

        <div class="footer">
          <span>
            SERF VALLEY · build {BUILD_LABEL} ·{' '}
            {isMulti()
              ? 'server lobby'
              : online()
                ? 'local sim'
                : 'local sim · offline'}{' '}
            ·{' '}
            {/* A real anchor with the DocLink handshake: middle-click and
                copy-link work, a plain click stays in the document. */}
            <a
              href="/docs/credits"
              onClick={e => {
                if (
                  e.button !== 0 ||
                  e.metaKey ||
                  e.ctrlKey ||
                  e.shiftKey ||
                  e.altKey
                )
                  return;
                e.preventDefault();
                releaseMenuBackdrop();
                goto('/docs/credits');
              }}
            >
              Credits
            </a>
          </span>
        </div>
      </div>
    </>
  );
}
