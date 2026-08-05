import { For, Index, Show, createSignal, onCleanup, onMount } from 'solid-js';
import { createStore, reconcile } from 'solid-js/store';
import { BUILD_LABEL } from '../app/buildInfo';
import { clearSeatStash, relayUrl, type CouncilRequest } from '../net/lobbyClient';
import { DiceIcon } from './menuChrome';
import { DEFAULT_SEED, defaultLobbyConfig } from '../protocol/lobby';
import {
  AI_STRATEGIES,
  AI_STRATEGY_ORDER,
  parseStrategyId,
  type AiStrategyId,
} from '../sim/defs/aiStrategies';

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
 * players; the seed row ships on so players can share a valley. */
const OPTIONS = {
  showSeedRow: true,
  showBanditsRow: true,
  showLaunchUrl: false,
  maxOpponents: 3,
};

const AI_SEATS = Array.from({ length: OPTIONS.maxOpponents + 1 }, (_, i) => i);

/**
 * What to say under the opponent pickers. A single named opponent gets its
 * whole character, since the player asked for that one by name; anything
 * with a Random seat in it gets the general rule instead.
 *
 * Deliberately says nothing about who Random turned up. The menu could
 * work it out — the deal is a pure function of the seed sitting two rows
 * down — but a roll you can read before the match is not a roll, it is a
 * lineup with extra steps. Finding out who you are up against is the
 * first thing the skirmish has to tell you.
 */
function opponentHint(picks: (AiStrategyId | undefined)[]): string {
  const only = picks.length === 1 ? picks[0] : undefined;
  if (only) return AI_STRATEGIES[only].blurb;
  return 'Random keeps it to itself until you meet them';
}
/** How often the join view asks the server for open rooms. */
const POLL_MS = 3000;

export type Mode = 'single' | 'multi';
export type MpMode = 'host' | 'join';
type Visibility = 'open' | 'private';

/** Which pane the screen opens on. The shell hands back what the player
 * had chosen when they walked into the council, so backing out of it does
 * not dump them on the single-player tab. */
export interface StartState {
  mode: Mode;
  mp: MpMode;
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
  return new Promise((resolve) => {
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
    ws.onopen = () => ws.send(JSON.stringify({ t: 'list' }));
    ws.onmessage = (e: MessageEvent<string>) => {
      const msg = JSON.parse(e.data) as { t: string; rooms?: OpenRoom[] };
      if (msg.t === 'rooms') done(msg.rooms ?? []);
    };
    setTimeout(() => done([]), 4000);
  });
}


const OneIcon = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round">
    <circle cx="12" cy="8" r="3.6" />
    <path d="M4.5 20a7.5 7.5 0 0 1 15 0" />
  </svg>
);
const ManyIcon = (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round">
    <circle cx="9" cy="8.5" r="3.1" />
    <path d="M2.5 20a6.5 6.5 0 0 1 13 0" />
    <path d="M16.5 6.2a3.1 3.1 0 0 1 0 5.9" />
    <path d="M18 15.2A6.5 6.5 0 0 1 21.5 20" />
  </svg>
);
export function StartMenu(props: StartMenuProps) {
  const [mode, setMode] = createSignal<Mode>(props.start.mode);
  const [mp, setMp] = createSignal<MpMode>(props.start.mp);
  const [ai, setAi] = createSignal(2);
  // One entry per opponent seat; undefined means 'let the seed deal it'.
  const [bots, setBots] = createSignal<(AiStrategyId | undefined)[]>([]);
  const [seed, setSeed] = createSignal(DEFAULT_SEED);
  const [bandits, setBandits] = createSignal(true);
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

  const isMulti = (): boolean => mode() === 'multi';
  const isJoin = (): boolean => isMulti() && mp() === 'join';

  /** One entry per opponent seat: the playbook the player named for it, or
   * undefined for the ones left to the seed. What the seed will actually
   * deal those is not the menu's business — see opponentHint. */
  const picks = (): (AiStrategyId | undefined)[] =>
    Array.from({ length: ai() }, (_, i) => bots()[i]);
  const setBot = (index: number, id: AiStrategyId | undefined): void => {
    const next = [...bots()];
    next[index] = id;
    setBots(next);
  };

  let inFlight = false;
  const refresh = async (): Promise<void> => {
    if (inFlight) return; // a slow server must not stack up polls
    inFlight = true;
    setLoadingRooms(true);
    const found = await listRooms();
    setRooms(reconcile(found, { key: 'code' }));
    // A room that filled up or started while selected can no longer be joined.
    const still = found.find((r) => r.code === picked());
    if (picked() && (!still || still.filled >= still.total)) setPicked(null);
    setLoadingRooms(false);
    inFlight = false;
  };

  const poll = setInterval(() => {
    if (isJoin() && online()) void refresh();
  }, POLL_MS);
  onCleanup(() => clearInterval(poll));

  const syncOnline = (): void => {
    setOnline(navigator.onLine);
    // Losing the connection mid-menu leaves the multiplayer pane pointing
    // at a relay that is not there; fall back to the half that still works.
    if (!navigator.onLine) setMode('single');
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
  });

  const hasSave = localStorage.getItem('serf-save') !== null;

  /** The single-player launch URL. Multiplayer has none: it walks into the
   * council in place, and the room's settings live on the relay. */
  const search = (): string => {
    const p = new URLSearchParams();
    if (ai() > 0) p.set('ai', String(ai()));
    // Only the named ones travel; a seat left on Random says nothing and
    // is dealt from the seed at the other end.
    const named = bots().slice(0, ai());
    if (named.some(Boolean)) p.set('bots', named.map((b) => b ?? '').join(','));
    p.set('seed', String(seed()));
    if (!bandits()) p.set('bandits', '0');
    return '?' + p.toString();
  };

  const target = (): string => picked() ?? room();
  const ctaLabel = (): string => {
    if (!isMulti()) return ai() > 0 ? 'Begin skirmish' : 'Begin sandbox';
    if (isJoin()) return target() ? 'Join ' + target() : 'Pick a room';
    return vis() === 'private' ? 'Create private room' : 'Create open room';
  };

  const launch = (): void => {
    if (isJoin() && !target()) return;
    clearSeatStash(); // a menu launch is fresh intent, never a reconnect
    if (isMulti()) {
      props.onCouncil({
        mp: isJoin() ? target().toUpperCase() : 'new',
        open: vis() === 'open',
        // Seats, seed and raids open at their defaults and are set in the
        // council, where every joiner watches them change.
        init: defaultLobbyConfig(),
      });
      return;
    }
    location.search = search();
  };
  const onEnter = (e: KeyboardEvent): void => {
    if (e.key === 'Enter') launch();
  };

  const loadSave = (): void => {
    const data = localStorage.getItem('serf-save');
    if (!data) return;
    sessionStorage.setItem('serf-load-pending', data);
    location.search = '?seed=' + seed();
  };

  return (
    <>
      <div class="shell">
        <div class="stack">
          <div class="title">
            <div class="kicker">
              <i />
              <span>Medieval Economy · RTS</span>
              <i class="r" />
            </div>
            <h1>SERF</h1>
            <p class="tagline">Settle the valley. Feed the levy. Hold the road.</p>
          </div>

          <div class="card">
            <div class="seg">
              <button class={mode() === 'single' ? 'on' : ''} onClick={() => setMode('single')}>
                {OneIcon}
                Single player
              </button>
              <button
                class={mode() === 'multi' ? 'on' : ''}
                disabled={!online()}
                title={online() ? undefined : 'Needs a connection to the relay'}
                onClick={() => {
                  setMode('multi');
                  if (mp() === 'join') void refresh();
                }}
              >
                {ManyIcon}
                Multiplayer
              </button>
            </div>

            <div class="rows">
              <Show when={!online()}>
                <div class="row">
                  <div>
                    <div class="row-label">Offline</div>
                    <div class="row-hint">
                      The valley runs on this device — skirmishes and saves are unaffected.
                      Multiplayer comes back with the connection.
                    </div>
                  </div>
                </div>
              </Show>

              <Show when={isMulti()}>
                <div class="choices">
                  <button class={`choice ${mp() === 'host' ? 'on' : ''}`} onClick={() => setMp('host')}>
                    <span>Host a room</span>
                    <span class="row-hint" style="display:block">You generate the valley</span>
                  </button>
                  <button
                    class={`choice ${mp() === 'join' ? 'on' : ''}`}
                    onClick={() => {
                      setMp('join');
                      void refresh();
                    }}
                  >
                    <span>Join a room</span>
                    <span class="row-hint" style="display:block">Pick one, or use a code</span>
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
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
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
                        {(r) => {
                          const full = (): boolean => r.filled >= r.total;
                          // Index, not For: a pip is a seat, and a seat
                          // being taken should light the pip already there
                          // rather than rebuild the row's dots.
                          const pips = (): boolean[] =>
                            Array.from({ length: r.total }, (_, i) => i < r.filled);
                          return (
                            <button
                              class={`room ${picked() === r.code ? 'on' : ''}`}
                              disabled={full()}
                              onClick={() => {
                                setPicked(picked() === r.code ? null : r.code);
                                setRoom('');
                              }}
                              onDblClick={launch}
                            >
                              <span style="min-width:0">
                                <span class="code">{r.code}</span>
                                <span class="meta">
                                  {r.filled}/{r.total} seats ·{' '}
                                  {r.ai ? `${r.ai} AI seat${r.ai > 1 ? 's' : ''}` : 'no AI'} ·{' '}
                                  {full() ? 'full' : ago(r.ageMs)}
                                </span>
                              </span>
                              <span class="pips">
                                <Index each={pips()}>
                                  {(on) => <span class={on() ? 'filled' : ''} />}
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
                      <div class="s">Host one, or join a private room with its code.</div>
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
                    onInput={(e) => {
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
                    <div class="row-hint">Open rooms appear in everyone’s browser</div>
                  </div>
                  <div class="vis">
                    <button class={vis() === 'open' ? 'on' : ''} title="Listed for anyone to join" onClick={() => setVis('open')}>
                      Open
                    </button>
                    <button class={vis() === 'private' ? 'on' : ''} title="Code only — unlisted" onClick={() => setVis('private')}>
                      Private
                    </button>
                  </div>
                </div>
                <div class="row">
                  <div>
                    <div class="row-label">Match settings</div>
                    <div class="row-hint">
                      Computer seats, map seed and bandit raids are chosen in the War Council,
                      where everyone sees them.
                    </div>
                  </div>
                </div>
              </Show>

              <Show when={!isMulti()}>
                <div class="row">
                  <div>
                    <div class="row-label">Computer opponents</div>
                    <div class="row-hint">They build and raid like you do</div>
                  </div>
                  <div class="pills">
                    <For each={AI_SEATS}>
                      {(n) => (
                        <button class={ai() === n ? 'on' : ''} onClick={() => setAi(n)}>
                          {n}
                        </button>
                      )}
                    </For>
                  </div>
                </div>

                <Show when={ai() > 0}>
                  <div class="row">
                    <div>
                      <div class="row-label">Who you face</div>
                      <div class="row-hint">{opponentHint(picks())}</div>
                    </div>
                    <div class="opponents">
                      {/* Index, not For: these are seats, and two of them
                          reading Random are not the same seat. For keys on
                          the item, so picking one opponent moved the select
                          instead of changing it. */}
                      <Index each={picks()}>
                        {(pick, i) => (
                          <select
                            value={pick() ?? ''}
                            onChange={(e) => setBot(i, parseStrategyId(e.currentTarget.value))}
                          >
                            <option value="">Random</option>
                            <For each={AI_STRATEGY_ORDER}>
                              {(id) => <option value={id}>{AI_STRATEGIES[id].name}</option>}
                            </For>
                          </select>
                        )}
                      </Index>
                    </div>
                  </div>
                </Show>

                <Show when={OPTIONS.showSeedRow}>
                  <div class="row">
                    <div>
                      <div class="row-label">Map seed</div>
                      <div class="row-hint">Same seed, same valley</div>
                    </div>
                    <div style="display:flex;align-items:center;gap:6px">
                      <input
                        class="seed"
                        value={String(seed())}
                        onKeyDown={onEnter}
                        onInput={(e) => setSeed(Number(e.currentTarget.value.replace(/\D/g, '')) || 0)}
                      />
                      <button
                        class="icon-btn"
                        title="Random seed"
                        onClick={() => setSeed(Math.floor(Math.random() * 9e7) + 1e7)}
                      >
                        <DiceIcon />
                      </button>
                    </div>
                  </div>
                </Show>
              </Show>

              <Show when={!isMulti() && OPTIONS.showBanditsRow}>
                <div class="row">
                  <div>
                    <div class="row-label">Bandit raids</div>
                    <div class="row-hint">Neutral hostiles harass the roads</div>
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
            </div>

            <div class="cta-wrap">
              <button class={`cta ${isJoin() && !target() ? 'dim' : ''}`} onClick={launch}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M8 5.5v13l11-6.5z" />
                </svg>
                {ctaLabel()}
              </button>
              <Show when={OPTIONS.showLaunchUrl && !isMulti()}>
                <div class="cta-url">
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7L11 5" />
                    <path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7L13 19" />
                  </svg>
                  <span>/{search()}</span>
                </div>
              </Show>
            </div>
          </div>

          <div class="secondary">
            <button
              disabled={!hasSave}
              title={hasSave ? 'Resume the saved village' : 'No save on this device'}
              onClick={loadSave}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <path d="M7 10l5 5 5-5" />
                <path d="M12 15V3" />
              </svg>
              Load save
            </button>
          </div>
        </div>

        <div class="footer">
          <span>
            SERF · build {BUILD_LABEL} ·{' '}
            {isMulti() ? 'server lobby' : online() ? 'local sim' : 'local sim · offline'}
          </span>
        </div>
      </div>
    </>
  );
}
