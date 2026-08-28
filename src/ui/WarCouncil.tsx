import {For, Index, Show, createSignal, type Accessor} from 'solid-js';
import {MAX_SEATS, type LobbyConfig} from '../protocol/lobby';
import type {Enum} from '../shared/enum.ts';
import {
  AI_STRATEGIES,
  AI_STRATEGY_ORDER,
  parseStrategyId,
  type AiStrategyId,
} from '../sim/defs/aiStrategies';
import * as PlayerKind from '../sim/playerKindEnum.ts';
import * as CouncilPhaseNs from './councilPhaseEnum.ts';
import {DiceIcon} from './menuChrome';
export type CouncilPhase = Enum<typeof CouncilPhaseNs>;

/**
 * The multiplayer waiting room: the start screen's sibling, not its
 * successor. Both are screens of the menu shell (MenuApp.tsx), so walking
 * in here is a swap of the card in front of the same live backdrop — same
 * glass, same gold, no reload. The host tunes the match here — computer
 * seats, bandit raids, the map seed — and every seat watches the settings
 * change live; joiners see them read-only.
 *
 * Security note: everything shown that is not a literal here — the room
 * code, seat kinds, the settings — is written by the relay. It all renders
 * through Solid's JSX text interpolation, which inserts text nodes, never
 * markup. Keep it that way: no innerHTML, ever. (A crafted room code once
 * ran script in this origin, which holds the saves and the seat token.)
 */

export interface CouncilView {
  /** One-line context from the journey here ('Your previous match has
   * ended.') — shown quietly above the lobby. */
  notice?: string;
  phase: CouncilPhase;
  code: string;
  yourSeat: number;
  seats: {kind: PlayerKind.human | 'ai'; connected: boolean}[];
  config: LobbyConfig;
}

export interface CouncilHooks {
  view: Accessor<CouncilView>;
  /** Host-only settings change; the relay echoes it back to every seat. */
  onConfig(patch: Partial<LobbyConfig>): void;
  onStart(): void;
  /** Hand the invite link over; resolves with which route it took. */
  onShare(): Promise<'shared' | 'copied'>;
  /** Back out: the room is abandoned and the shell shows the start screen. */
  onLeave(): void;
}

/** Banner colors, matching factionTint's seats — the same green, red, blue
 * and gold the players' castles wear in the match. */
const SEAT_COLORS = ['#008454', '#d22227', '#257ebc', '#f9aa4e'];

const AI_CHOICES = Array.from({length: MAX_SEATS}, (_, i) => i);

const COUNCIL_STYLE = `
#menu .council-code { display: flex; align-items: center; justify-content: space-between; gap: 14px; padding: 14px 16px 3px; }
#menu .council-code .label { font-size: 11px; font-weight: 600; letter-spacing: 0.18em; text-transform: uppercase; color: #85857c; }
#menu .council-code .value { margin-top: 2px; font-size: 26px; font-weight: 600; letter-spacing: 0.3em; color: #f5e4b6; }
#menu .invite { cursor: pointer; display: flex; align-items: center; gap: 8px; padding: 9px 14px; font: inherit;
  font-size: 12.5px; font-weight: 600; color: #f2db9a; background: rgba(229,196,105,0.1);
  border: 1px solid rgba(229,196,105,0.45); border-radius: 10px; transition: background 0.15s, border-color 0.15s; }
#menu .invite:hover { background: rgba(229,196,105,0.2); border-color: rgba(229,196,105,0.75); }
#menu .seats { display: flex; flex-direction: column; gap: 6px; padding: 12px 16px 4px; }
#menu .seat { display: flex; align-items: center; gap: 10px; padding: 8px 11px; font-size: 13px; color: #cfccc2;
  background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.08); border-radius: 10px; }
#menu .seat.open { color: #7b7c73; border-style: dashed; background: transparent; }
#menu .seat .banner { width: 9px; height: 9px; border-radius: 2.5px; flex: none; box-shadow: 0 0 6px rgba(0,0,0,0.4); }
#menu .seat.open .banner { background: rgba(255,255,255,0.14); }
#menu .seat .who { flex: 1; }
#menu .seat .state { font-size: 11.5px; color: #85857c; }
#menu .seat .state.ready { color: #9fb56a; }
#menu .seat .state.away { color: #d9a06a; }
#menu .waiting { display: flex; align-items: center; justify-content: center; gap: 10px; padding: 13px 18px;
  font-size: 13px; color: #a9a698; border: 1px dashed rgba(255,255,255,0.14); border-radius: 11px; }
@keyframes council-pulse { 0%, 100% { opacity: 0.35; } 50% { opacity: 1; } }
#menu .waiting i { width: 7px; height: 7px; border-radius: 50%; background: #cbbd93; animation: council-pulse 1.6s ease-in-out infinite; }
#menu .locked { pointer-events: none; }
`;

function ShareIcon() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
    >
      <path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7L11 5" />
      <path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7L13 19" />
    </svg>
  );
}

interface SeatRow {
  color: string;
  who: string;
  state: string;
  stateClass: string;
  open: boolean;
}

export function WarCouncil(props: CouncilHooks) {
  const [shared, setShared] = createSignal(false);
  const v = props.view;
  const inRoom = (): boolean => v().phase === CouncilPhaseNs.lobby;
  // Seat 0 runs the council. Derived, not passed in: if the host leaves the
  // lobby the relay renumbers the seats, and whoever lands at 0 inherits
  // the controls without a reload.
  const isHost = (): boolean => inRoom() && v().yourSeat === 0;

  /**
   * One entry per computer chair: the playbook the host named for it, or
   * undefined for the ones left to the seed. Which opponent Random will
   * turn out to be is not shown — the council could derive it from the
   * seed, but a roll everyone can read before the march is not a roll.
   */
  const picks = (): (AiStrategyId | undefined)[] => {
    const {seats, config} = v();
    const aiFill = Math.max(0, Math.min(config.ai, MAX_SEATS - seats.length));
    return Array.from({length: aiFill}, (_, i) =>
      parseStrategyId(config.bots[i]),
    );
  };

  const setBot = (index: number, id: string): void => {
    const bots = [...v().config.bots];
    bots[index] = id === '' ? null : id;
    props.onConfig({bots});
  };

  /** The table, always MAX_SEATS chairs: humans, then the computer seats
   * the host asked for, then what is still open. */
  const rows = (): SeatRow[] => {
    const {seats, yourSeat, config} = v();
    const named = picks();
    const out: SeatRow[] = seats.map((s, i) => ({
      color: SEAT_COLORS[i % SEAT_COLORS.length]!,
      who: i === yourSeat ? 'You' : 'Ally',
      state: s.connected ? 'ready' : 'away',
      stateClass: s.connected ? 'ready' : 'away',
      open: false,
    }));
    const aiFill = Math.max(0, Math.min(config.ai, MAX_SEATS - out.length));
    for (let i = 0; i < aiFill; i++) {
      // A chair the host named says who is in it; one left on Random
      // stays 'Computer' until the match introduces them.
      out.push({
        color: SEAT_COLORS[out.length % SEAT_COLORS.length]!,
        who: named[i] ? AI_STRATEGIES[named[i]!].name : 'Computer',
        // The status column carries whichever fact the name did not: a
        // named chair is still a computer, an unnamed one is just ready.
        state: named[i] ? 'computer' : 'ready',
        stateClass: 'ready',
        open: false,
      });
    }
    while (out.length < MAX_SEATS) {
      out.push({
        color: '',
        who: 'Open seat',
        state: 'share the invite',
        stateClass: '',
        open: true,
      });
    }
    return out;
  };

  const share = (): void => {
    void props.onShare().then(how => {
      if (how === 'shared') return; // the share sheet is its own feedback
      setShared(true);
      setTimeout(() => setShared(false), 1600);
    });
  };

  // The locked class only stops the pointer; keyboard focus can still reach
  // the controls, and the relay drops non-host config on the floor — so a
  // joiner's stray Space must not send anything in the first place.
  const patch = (p: Partial<LobbyConfig>): void => {
    if (isHost()) props.onConfig(p);
  };

  const seedInput = (raw: string): void => {
    patch({seed: Number(raw.replace(/\D/g, '')) || 0});
  };

  return (
    <>
      {/* The shared sheet and the veils belong to the shell — this screen
          only adds what is its own. */}
      <style>{COUNCIL_STYLE}</style>

      <div class="shell">
        <div class="stack">
          <div class="title">
            <div class="kicker">
              <i />
              <span>Serf Valley · Multiplayer</span>
              <i class="r" />
            </div>
            <h1>WAR COUNCIL</h1>
            <Show when={props.view().notice}>
              <p
                style={{
                  'color': '#e5c469',
                  'font-size': '13px',
                  'margin': '2px 0 0',
                }}
              >
                {props.view().notice}
              </p>
            </Show>
            <p class="tagline">
              {inRoom()
                ? 'The march begins when the host gives the word.'
                : 'Reaching the relay…'}
            </p>
          </div>

          <Show when={inRoom()}>
            <div class="card">
              <div class="council-code">
                <div>
                  <div class="label">Room code</div>
                  <div class="value">{v().code}</div>
                </div>
                <button class="invite" onClick={share}>
                  <ShareIcon />
                  {shared() ? 'Copied!' : 'Invite'}
                </button>
              </div>

              <div class="seats">
                <For each={rows()}>
                  {r => (
                    <div class={`seat ${r.open ? 'open' : ''}`}>
                      <span
                        class="banner"
                        style={r.open ? '' : `background:${r.color}`}
                      />
                      <span class="who">{r.who}</span>
                      <span class={`state ${r.stateClass}`}>{r.state}</span>
                    </div>
                  )}
                </For>
              </div>

              <div class="rows" classList={{locked: !isHost()}}>
                <div class="row">
                  <div>
                    <div class="row-label">Computer seats</div>
                    <div class="row-hint">
                      {isHost()
                        ? 'Filling seats humans don’t take'
                        : 'Set by the host'}
                    </div>
                  </div>
                  <div class="pills">
                    <For each={AI_CHOICES}>
                      {n => (
                        <button
                          class={v().config.ai === n ? 'on' : ''}
                          onClick={() => patch({ai: n})}
                        >
                          {n}
                        </button>
                      )}
                    </For>
                  </div>
                </div>

                <Show when={picks().length > 0}>
                  <div class="row">
                    <div>
                      <div class="row-label">Who they are</div>
                      <div class="row-hint">
                        {isHost()
                          ? 'Random keeps it to itself until the march'
                          : 'Set by the host'}
                      </div>
                    </div>
                    <div class="opponents">
                      {/* Index, not For — see the same picker in StartMenu:
                          keying on the item makes two Random seats one. */}
                      <Index each={picks()}>
                        {(pick, i) => (
                          <select
                            disabled={!isHost()}
                            value={pick() ?? ''}
                            onChange={e => setBot(i, e.currentTarget.value)}
                          >
                            <option value="">Random</option>
                            <For each={AI_STRATEGY_ORDER}>
                              {id => (
                                <option value={id}>
                                  {AI_STRATEGIES[id].name}
                                </option>
                              )}
                            </For>
                          </select>
                        )}
                      </Index>
                    </div>
                  </div>
                </Show>

                <div class="row">
                  <div>
                    <div class="row-label">Bandit raids</div>
                    <div class="row-hint">
                      Neutral hostiles harass the roads
                    </div>
                  </div>
                  <button
                    class={`toggle ${v().config.bandits ? 'on' : ''}`}
                    role="switch"
                    aria-checked={v().config.bandits}
                    aria-label="Bandit raids"
                    onClick={() => patch({bandits: !v().config.bandits})}
                  >
                    <span />
                  </button>
                </div>

                <div class="row">
                  <div>
                    <div class="row-label">Map seed</div>
                    <div class="row-hint">Same seed, same valley</div>
                  </div>
                  <Show
                    when={isHost()}
                    fallback={
                      <span style="font-variant-numeric:tabular-nums;color:#b3b1a6">
                        {String(v().config.seed)}
                      </span>
                    }
                  >
                    <div style="display:flex;align-items:center;gap:6px">
                      <input
                        class="seed"
                        value={String(v().config.seed)}
                        onInput={e => seedInput(e.currentTarget.value)}
                      />
                      <button
                        class="icon-btn"
                        title="Random seed"
                        onClick={() =>
                          patch({seed: Math.floor(Math.random() * 9e7) + 1e7})
                        }
                      >
                        <DiceIcon />
                      </button>
                    </div>
                  </Show>
                </div>
              </div>

              <div class="cta-wrap">
                <Show
                  when={isHost()}
                  fallback={
                    <div class="waiting">
                      <i />
                      Waiting for the host to begin…
                    </div>
                  }
                >
                  <button class="cta" onClick={() => props.onStart()}>
                    <svg
                      width="14"
                      height="14"
                      viewBox="0 0 24 24"
                      fill="currentColor"
                    >
                      <path d="M8 5.5v13l11-6.5z" />
                    </svg>
                    Begin the match
                  </button>
                </Show>
              </div>
            </div>
          </Show>

          <div class="secondary">
            <button onClick={() => props.onLeave()}>Back to the menu</button>
          </div>
        </div>

        <div class="footer">
          <span>SERF VALLEY · war council</span>
        </div>
      </div>
    </>
  );
}
