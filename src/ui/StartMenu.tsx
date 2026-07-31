import { For, Show, createSignal, onCleanup, onMount } from 'solid-js';
import { render } from 'solid-js/web';
import { relayUrl } from '../net/lobbyClient';
import { startMenuBackdrop, type Backdrop } from './menuBackdrop';

/**
 * Pre-boot start screen. Mounted into #menu by main.ts when the URL carries
 * no launch params; it never coexists with the sim — picking a mode sets
 * location.search, which reloads into boot() proper.
 *
 * Visual language matches the in-game HUD (glass panels, one gold accent,
 * Space Grotesk). The background is the real game, framed on the castle and
 * blurred — see menuBackdrop.ts.
 */

const GOLD = '#e5c469';

/** Shipping set of options. The launch URL is a dev affordance — off for
 * players; the seed row ships on so players can share a valley. */
const OPTIONS = {
  showSeedRow: true,
  showBanditsRow: true,
  showLaunchUrl: false,
  maxOpponents: 3,
};

const AI_SEATS = Array.from({ length: OPTIONS.maxOpponents + 1 }, (_, i) => i);
/** The default valley, matching configFromUrl's fallback seed. */
const DEFAULT_SEED = 20260724;
/** How often the join view asks the server for open rooms. */
const POLL_MS = 3000;

type Mode = 'single' | 'multi';
type MpMode = 'host' | 'join';
type Visibility = 'open' | 'private';

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

const STYLE = `
#menu { position: fixed; inset: 0; overflow-y: auto; overflow-x: hidden; font-family: 'Space Grotesk', system-ui, sans-serif; }
#menu * { box-sizing: border-box; }
/* Both veils are fixed so they stay put while the screen scrolls; the
   background itself is the live canvas underneath (see menuBackdrop.ts). */
#menu .veil-a { position: fixed; inset: 0; background: radial-gradient(ellipse 80% 70% at 50% 42%, rgba(8,10,8,0.12) 0%, rgba(6,8,7,0.72) 100%); }
#menu .veil-b { position: fixed; inset: 0; background: linear-gradient(180deg, rgba(6,8,7,0.55) 0%, rgba(6,8,7,0) 26%, rgba(6,8,7,0) 62%, rgba(6,8,7,0.78) 100%); }
@keyframes menu-rise { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: none; } }
@media (prefers-reduced-motion: reduce) { #menu .stack { animation: none; } }

#menu .shell { position: relative; min-height: 100%; display: grid; grid-template-rows: 1fr auto; padding: 0 0 14px; }
/* 'safe' centering matters: plain centering makes the overflow unreachable
   on short windows, which is exactly when this screen needs to scroll. */
#menu .stack { min-height: 0; display: flex; flex-direction: column; align-items: center;
  justify-content: safe center; gap: 18px; animation: menu-rise 0.5s ease-out both;
  padding: calc(24px + env(safe-area-inset-top)) calc(20px + env(safe-area-inset-right)) 4px calc(20px + env(safe-area-inset-left)); }

#menu .kicker { display: flex; align-items: center; gap: 12px; font-size: 11px; font-weight: 600;
  letter-spacing: 0.34em; text-align: center; color: #cbbd93; text-transform: uppercase; }
#menu .kicker i { display: block; width: 46px; height: 1px; background: linear-gradient(90deg, rgba(229,196,105,0) 0%, rgba(229,196,105,0.7) 100%); }
#menu .kicker i.r { background: linear-gradient(90deg, rgba(229,196,105,0.7) 0%, rgba(229,196,105,0) 100%); }
#menu h1 { margin: 0; font-size: clamp(40px, 11vw, 62px); line-height: 0.94; font-weight: 500; letter-spacing: 0.16em;
  color: #f4f1e6; text-shadow: 0 2px 30px rgba(0,0,0,0.6); }
#menu .tagline { margin: 2px 0 0; font-size: clamp(12.5px, 3.6vw, 14.5px); color: #a9a698; letter-spacing: 0.01em; text-align: center; text-wrap: pretty; }
#menu .title { display: flex; flex-direction: column; align-items: center; gap: 8px; }

#menu .card { width: 100%; max-width: 486px; display: flex; flex-direction: column;
  background: rgba(14,16,15,0.74); backdrop-filter: blur(18px); -webkit-backdrop-filter: blur(18px);
  border: 1px solid rgba(255,255,255,0.09); border-radius: 16px; box-shadow: 0 18px 60px rgba(0,0,0,0.5); }
#menu .seg { display: flex; gap: 2px; padding: 4px; margin: 10px 10px 0; background: rgba(0,0,0,0.38); border-radius: 11px; }
#menu .seg button { flex: 1; cursor: pointer; display: flex; align-items: center; justify-content: center; gap: 7px;
  padding: 8px 10px; font: inherit; font-size: 12.5px; font-weight: 600; letter-spacing: 0.05em; text-transform: uppercase;
  color: #94958c; background: transparent; border: none; border-radius: 9px; transition: background 0.15s, color 0.15s; }
#menu .seg button:hover { color: #f0ede4; }
#menu .seg button.on { color: #f5e4b6; background: rgba(229,196,105,0.16); }

#menu .rows { display: flex; flex-direction: column; padding: 6px 16px 0; }
#menu .row { display: flex; align-items: center; justify-content: space-between; gap: 16px;
  padding: 11px 0; border-top: 1px solid rgba(255,255,255,0.07); }
#menu .row-label { font-size: 13.5px; color: #e4e1d6; }
#menu .row-hint { margin-top: 2px; font-size: 11.5px; color: #85857c; }

#menu .choices { display: flex; gap: 6px; padding: 14px 0 4px; }
#menu .choice { flex: 1; cursor: pointer; padding: 9px 10px; text-align: left; font: inherit; font-size: 13px;
  color: #b3b1a6; background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.1);
  border-radius: 10px; transition: border-color 0.15s, background 0.15s; }
#menu .choice:hover { border-color: rgba(229,196,105,0.4); }
#menu .choice.on { color: #f2efe4; background: rgba(229,196,105,0.10); border-color: rgba(229,196,105,0.5); }

#menu .pills { display: flex; gap: 2px; padding: 3px; background: rgba(0,0,0,0.34); border-radius: 9px; }
#menu .pills button { cursor: pointer; width: 34px; height: 27px; font: inherit; font-size: 13px; font-weight: 600;
  font-variant-numeric: tabular-nums; color: #94958c; background: transparent; border: none; border-radius: 7px;
  transition: background 0.15s, color 0.15s; }
#menu .pills button:hover { color: #f0ede4; }
#menu .pills button.on { color: #f5e4b6; background: rgba(229,196,105,0.16); }

#menu input { padding: 8px 10px; font: inherit; font-size: 13.5px; color: #f2efe4;
  background: rgba(0,0,0,0.34); border: 1px solid rgba(255,255,255,0.13); border-radius: 9px; }
#menu input.seed { width: 108px; text-align: right; font-variant-numeric: tabular-nums; }
#menu input.code { width: 124px; text-align: center; font-size: 15px; font-weight: 600; letter-spacing: 0.22em; text-transform: uppercase; }

#menu .icon-btn { cursor: pointer; width: 34px; height: 34px; display: grid; place-items: center; color: #cbc8bc;
  background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.11); border-radius: 9px; }
#menu .icon-btn:hover { background: rgba(229,196,105,0.14); border-color: rgba(229,196,105,0.42); color: #f2db9a; }

#menu .toggle { cursor: pointer; width: 46px; height: 26px; padding: 3px; display: flex; justify-content: flex-start;
  background: rgba(0,0,0,0.4); border: 1px solid rgba(255,255,255,0.13); border-radius: 999px;
  transition: background 0.18s, border-color 0.18s; }
#menu .toggle span { width: 18px; height: 18px; border-radius: 50%; background: #7d7f77; transition: background 0.18s; }
#menu .toggle.on { justify-content: flex-end; background: rgba(229,196,105,0.22); border-color: rgba(229,196,105,0.55); }
#menu .toggle.on span { background: ${GOLD}; }

#menu .browser { display: flex; flex-direction: column; gap: 8px; padding: 12px 0; border-top: 1px solid rgba(255,255,255,0.07); }
#menu .browser-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
#menu .browser-head .count { font-size: 11px; color: #85857c; font-variant-numeric: tabular-nums; }
#menu .room-list { display: flex; flex-direction: column; gap: 6px; max-height: 132px; overflow-y: auto; }
#menu .room { cursor: pointer; display: flex; align-items: center; justify-content: space-between; gap: 12px;
  padding: 9px 11px; text-align: left; font: inherit; color: #cfccc2; background: rgba(255,255,255,0.03);
  border: 1px solid rgba(255,255,255,0.1); border-radius: 10px; transition: background 0.15s, border-color 0.15s; }
#menu .room:hover { border-color: rgba(229,196,105,0.4); }
#menu .room.on { color: #f2efe4; background: rgba(229,196,105,0.10); border-color: rgba(229,196,105,0.5); }
#menu .room:disabled { opacity: 0.45; cursor: default; }
#menu .room:disabled:hover { border-color: rgba(255,255,255,0.1); }
#menu .room .code { display: block; font-size: 14px; font-weight: 600; letter-spacing: 0.16em; }
#menu .room .meta { display: block; margin-top: 2px; font-size: 11px; color: #85857c; font-variant-numeric: tabular-nums; }
#menu .pips { display: flex; align-items: center; gap: 4px; flex: none; }
#menu .pips span { width: 7px; height: 7px; border-radius: 50%; background: rgba(255,255,255,0.16); }
#menu .pips span.filled { background: #8fbb56; }
#menu .browser-none { padding: 18px 12px; text-align: center; border: 1px dashed rgba(255,255,255,0.12); border-radius: 10px; }
#menu .browser-none .t { font-size: 12.5px; color: #b3b1a6; }
#menu .browser-none .s { margin-top: 3px; font-size: 11.5px; color: #7b7c73; }
#menu .browser-load { padding: 22px 0; text-align: center; font-size: 12px; color: #85857c; }
#menu .code-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 9px 0;
  border-top: 1px solid rgba(255,255,255,0.07); }
#menu .code-row span { font-size: 12.5px; color: #85857c; }
#menu .vis { display: flex; gap: 6px; flex: none; }
#menu .vis button { cursor: pointer; padding: 7px 13px; font: inherit; font-size: 12.5px; color: #b3b1a6;
  background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.1); border-radius: 9px;
  transition: background 0.15s, border-color 0.15s; }
#menu .vis button:hover { border-color: rgba(229,196,105,0.4); }
#menu .vis button.on { color: #f2efe4; background: rgba(229,196,105,0.10); border-color: rgba(229,196,105,0.5); }

#menu .cta-wrap { display: flex; flex-direction: column; gap: 7px; padding: 13px 16px; margin-top: 2px;
  border-top: 1px solid rgba(255,255,255,0.07); }
#menu .cta { cursor: pointer; display: flex; align-items: center; justify-content: center; gap: 9px; padding: 13px 18px;
  font: inherit; font-size: 14px; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; color: #f7e9c0;
  background: rgba(229,196,105,0.13); border: 1px solid rgba(229,196,105,0.5); border-radius: 11px;
  transition: background 0.15s, border-color 0.15s, opacity 0.15s; }
#menu .cta:hover { background: rgba(229,196,105,0.22); border-color: rgba(229,196,105,0.8); color: #fdf4dc; }
#menu .cta.dim { opacity: 0.5; }
#menu .cta-url { display: flex; align-items: center; justify-content: center; flex-wrap: wrap; gap: 8px; font-size: 11px;
  color: #6f7169; font-variant-numeric: tabular-nums; word-break: break-all; text-align: center; }

#menu .secondary { display: flex; align-items: center; justify-content: center; flex-wrap: wrap; gap: 8px; padding-bottom: 4px; }
#menu .secondary button { cursor: pointer; display: flex; align-items: center; gap: 7px; padding: 9px 15px; font: inherit;
  font-size: 12.5px; color: #b8b5aa; background: rgba(14,16,15,0.6); backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px); border: 1px solid rgba(255,255,255,0.09); border-radius: 10px; }
#menu .secondary button:hover { color: #f0ede4; border-color: rgba(255,255,255,0.2); }
#menu .secondary button:disabled { opacity: 0.45; cursor: default; }

#menu .footer { display: flex; align-items: center; justify-content: space-between; gap: 12px;
  padding: 0 20px env(safe-area-inset-bottom); font-size: 11px; color: #5f6159; letter-spacing: 0.06em; }

/* Phones and short windows: same DOM, tighter stack, bigger touch targets. */
@media (max-width: 560px) {
  #menu .kicker i { display: none; }
  #menu .footer .tech { display: none; }
  #menu .footer { justify-content: center; }
  #menu .stack { gap: 14px; justify-content: flex-start; }
  #menu .pills button { width: 40px; height: 34px; }
  #menu .icon-btn { width: 40px; height: 40px; }
}
#menu button:focus-visible, #menu input:focus-visible { outline: 2px solid rgba(229,196,105,0.55); outline-offset: 2px; }
`;

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
const DiceIcon = (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
    <rect x="3" y="3" width="18" height="18" rx="3" />
    <circle cx="8.5" cy="8.5" r="1.1" fill="currentColor" />
    <circle cx="15.5" cy="15.5" r="1.1" fill="currentColor" />
    <circle cx="15.5" cy="8.5" r="1.1" fill="currentColor" />
    <circle cx="8.5" cy="15.5" r="1.1" fill="currentColor" />
  </svg>
);

function StartMenu() {
  const [mode, setMode] = createSignal<Mode>('single');
  const [mp, setMp] = createSignal<MpMode>('host');
  const [ai, setAi] = createSignal(2);
  const [seed, setSeed] = createSignal(DEFAULT_SEED);
  const [bandits, setBandits] = createSignal(true);
  const [room, setRoom] = createSignal('');
  const [vis, setVis] = createSignal<Visibility>('open');
  const [picked, setPicked] = createSignal<string | null>(null);
  const [rooms, setRooms] = createSignal<OpenRoom[]>([]);
  const [loadingRooms, setLoadingRooms] = createSignal(false);

  const isMulti = (): boolean => mode() === 'multi';
  const isJoin = (): boolean => isMulti() && mp() === 'join';

  let inFlight = false;
  const refresh = async (): Promise<void> => {
    if (inFlight) return; // a slow server must not stack up polls
    inFlight = true;
    setLoadingRooms(true);
    const found = await listRooms();
    setRooms(found);
    // A room that filled up or started while selected can no longer be joined.
    const still = found.find((r) => r.code === picked());
    if (picked() && (!still || still.filled >= still.total)) setPicked(null);
    setLoadingRooms(false);
    inFlight = false;
  };

  const poll = setInterval(() => {
    if (isJoin()) void refresh();
  }, POLL_MS);
  onCleanup(() => clearInterval(poll));

  // The live backdrop: the game itself, framed on the castle (menuBackdrop.ts).
  // Failure here is cosmetic — the veils alone still look deliberate.
  let backdrop: Backdrop | null = null;
  onMount(() => {
    const canvas = document.getElementById('canvas') as HTMLCanvasElement | null;
    if (!canvas) return;
    document.documentElement.classList.add('menu-bg');
    void startMenuBackdrop(canvas)
      .then((b) => {
        backdrop = b;
      })
      .catch((err: unknown) => {
        console.warn('[menu] no live backdrop:', err);
      });
  });
  onCleanup(() => backdrop?.stop());

  const hasSave = localStorage.getItem('serf-save') !== null;

  const search = (): string => {
    const p = new URLSearchParams();
    if (!isMulti()) {
      if (ai() > 0) p.set('ai', String(ai()));
      p.set('seed', String(seed()));
      if (!bandits()) p.set('bandits', '0');
    } else if (mp() === 'host') {
      p.set('mp', 'new');
      if (ai() > 0) p.set('ai', String(ai()));
      p.set('seed', String(seed()));
      if (vis() === 'private') p.set('open', '0');
    } else {
      p.set('mp', target().toUpperCase());
    }
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
      <style>{STYLE}</style>
      <div class="veil-a" />
      <div class="veil-b" />

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
                      <span class="count">{rooms().length} open</span>
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

                  <Show when={loadingRooms() && rooms().length === 0}>
                    <div class="browser-load">Looking for open rooms…</div>
                  </Show>

                  <Show when={rooms().length > 0}>
                    <div class="room-list">
                      <For each={rooms()}>
                        {(r) => {
                          const full = (): boolean => r.filled >= r.total;
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
                                <For each={Array.from({ length: r.total }, (_, i) => i < r.filled)}>
                                  {(on) => <span class={on ? 'filled' : ''} />}
                                </For>
                              </span>
                            </button>
                          );
                        }}
                      </For>
                    </div>
                  </Show>

                  <Show when={!loadingRooms() && rooms().length === 0}>
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
              </Show>

              <Show when={!isJoin()}>
                <div class="row">
                  <div>
                    <div class="row-label">{isMulti() ? 'Computer seats' : 'Computer opponents'}</div>
                    <div class="row-hint">
                      {isMulti() ? 'Filling seats humans don’t take' : 'They build and raid like you do'}
                    </div>
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
                        {DiceIcon}
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
              <Show when={OPTIONS.showLaunchUrl}>
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
          <span>SERF · build 0.4.2 · {isMulti() ? 'server lobby' : 'local sim'}</span>
          <span class="tech">Server-authoritative · SAB render feed</span>
        </div>
      </div>
    </>
  );
}

/** Called by main.ts instead of booting the sim when there are no launch params. */
export function mountStartMenu(): void {
  const root = document.getElementById('menu')!;
  root.style.display = 'block';
  render(() => <StartMenu />, root);
}
