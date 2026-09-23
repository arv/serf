import {For, Show, createMemo, createSignal, onCleanup} from 'solid-js';
import {
  DIFFICULTIES,
  DIFFICULTY_ORDER,
  type DifficultyId,
} from '../../sim/defs/difficulty.ts';
import {
  MISSION_DEFS,
  MISSION_ORDER,
  type MissionId,
} from '../../sim/defs/missions';
import {isMissionComplete, isMissionUnlocked} from '../campaign';
import {roomAge, sortRooms, type OpenRoom} from './rooms';

/**
 * The boards on the backs of the signpost's arrows: Campaign, Skirmish and
 * Multiplayer. Each is rendered into its arrow's board element by the
 * screen (Signpost.tsx); the layout and the look are signpost/style.ts.
 *
 * Every string a board shows that is not a literal here comes through
 * Solid's text interpolation — never markup — which matters most on the
 * Multiplayer board, whose room codes come from the relay.
 */

export interface SegOption<T> {
  value: T;
  label: string;
  disabled?: boolean;
}

/** A segmented choice: one gold highlight that slides to the chosen
 * option (CSS, from aria-pressed). */
export function Seg<T>(props: {
  options: readonly SegOption<T>[];
  value: T;
  onPick(value: T): void;
  disabled?: boolean;
  label?: string;
}) {
  return (
    <div class="seg" role="group" aria-label={props.label}>
      <For each={props.options}>
        {o => (
          <button
            aria-pressed={props.value === o.value}
            disabled={props.disabled || o.disabled}
            onClick={() => props.onPick(o.value)}
          >
            {o.label}
          </button>
        )}
      </For>
    </div>
  );
}

/** The difficulty tiers, off the sim's own table. */
export const DIFFICULTY_OPTIONS: readonly SegOption<DifficultyId>[] =
  DIFFICULTY_ORDER.map(id => ({value: id, label: DIFFICULTIES[id].name}));

function BoardHead(props: {
  title: string;
  sub?: string;
  onBack(): void;
  back?: string;
}) {
  return (
    <header>
      <h2 class="comic">{props.title}</h2>
      <Show when={props.sub}>
        <span class="sub">{props.sub}</span>
      </Show>
      <button class="back" onClick={() => props.onBack()}>
        {props.back ?? 'Back'}
      </button>
    </header>
  );
}

const LockIcon = () => (
  <svg
    width="18"
    height="18"
    viewBox="0 0 16 16"
    fill="currentColor"
    aria-hidden="true"
  >
    <path d="M5 7V5a3 3 0 0 1 6 0v2h.5A1.5 1.5 0 0 1 13 8.5v5A1.5 1.5 0 0 1 11.5 15h-7A1.5 1.5 0 0 1 3 13.5v-5A1.5 1.5 0 0 1 4.5 7H5zm1.5 0h3V5a1.5 1.5 0 0 0-3 0v2z" />
  </svg>
);

const RefreshIcon = () => (
  <svg
    width="18"
    height="18"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="3"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <path d="M21 12a9 9 0 1 1-2.64-6.36" />
    <path d="M21 3v5h-5" />
  </svg>
);

// ----------------------------------------------------------------- Campaign

/**
 * The reeve's commissions as stops on a trail, one per mission, the first
 * open one picked. Played in order: a stop opens when the one before it is
 * fulfilled.
 */
export function CampaignBoard(props: {
  onPlay(id: MissionId): void;
  onBack(): void;
}) {
  // The campaign opens on the frontier: the first commission not yet
  // fulfilled (everything done = the finale stays picked).
  const frontier =
    MISSION_ORDER.find(id => !isMissionComplete(id)) ?? MISSION_ORDER.at(-1)!;
  const [picked, setPicked] = createSignal<MissionId>(frontier);
  const done = MISSION_ORDER.filter(isMissionComplete).length;
  const mission = () => MISSION_DEFS[picked()];
  return (
    <>
      <button class="go" onClick={() => props.onPlay(picked())}>
        Play
      </button>
      <div class="main">
        <BoardHead
          title="Campaign"
          sub={`${done} of ${MISSION_ORDER.length} done`}
          onBack={() => props.onBack()}
        />
        <div class="path">
          <For each={MISSION_ORDER}>
            {(id, i) => {
              const open = isMissionUnlocked(id);
              return (
                <>
                  <Show when={i() > 0}>
                    <span class="trail" />
                  </Show>
                  <button
                    class="stop"
                    classList={{
                      sel: picked() === id,
                      locked: !open,
                      done: isMissionComplete(id),
                    }}
                    disabled={!open}
                    aria-pressed={picked() === id}
                    aria-label={`${i() + 1}. ${MISSION_DEFS[id].title}${
                      open
                        ? isMissionComplete(id)
                          ? ', done'
                          : ''
                        : ', locked'
                    }`}
                    onClick={() => setPicked(id)}
                  >
                    {open ? i() + 1 : <LockIcon />}
                  </button>
                </>
              );
            }}
          </For>
        </div>
        <div class="pick">
          <span class="t">{mission().title}</span>
          <span class="d">{mission().tagline}</span>
        </div>
      </div>
    </>
  );
}

// ----------------------------------------------------------------- Skirmish

const RIVALS: readonly SegOption<number>[] = [
  {value: 0, label: 'None'},
  {value: 1, label: '1'},
  {value: 2, label: '2'},
  {value: 3, label: '3'},
];
const ON_OFF: readonly SegOption<boolean>[] = [
  {value: false, label: 'Off'},
  {value: true, label: 'On'},
];

/**
 * A fresh valley against the computer. The rows are the player's own
 * remembered setup; the seed is rolled fresh every visit and shown, so the
 * valley can be shared.
 */
export function SkirmishBoard(props: {
  ai: number;
  difficulty: DifficultyId;
  bandits: boolean;
  seed: number;
  onAi(n: number): void;
  onDifficulty(id: DifficultyId): void;
  onBandits(on: boolean): void;
  onPlay(): void;
  onBack(): void;
}) {
  return (
    <>
      <button class="go" onClick={() => props.onPlay()}>
        Play
      </button>
      <div class="main">
        <BoardHead
          title="Skirmish"
          sub={
            props.ai > 0 ? 'A fresh valley vs the AI' : 'A valley to yourself'
          }
          onBack={() => props.onBack()}
        />
        <div class="grid">
          <div class="field">
            <label>Rivals</label>
            <Seg
              label="Rivals"
              options={RIVALS}
              value={props.ai}
              onPick={n => props.onAi(n)}
            />
          </div>
          <div class="field">
            <label>Difficulty</label>
            {/* A sandbox has no opponents for the dial to touch. */}
            <Seg
              label="Difficulty"
              options={DIFFICULTY_OPTIONS}
              value={props.difficulty}
              onPick={id => props.onDifficulty(id)}
              disabled={props.ai === 0}
            />
          </div>
          <div class="field">
            <label>Bandits</label>
            <Seg
              label="Bandits"
              options={ON_OFF}
              value={props.bandits}
              onPick={on => props.onBandits(on)}
            />
          </div>
          <div class="field">
            <label>Valley</label>
            <span class="seed">No. {props.seed}</span>
          </div>
        </div>
      </div>
    </>
  );
}

// -------------------------------------------------------------- Multiplayer

/**
 * Two choices, not one form. Host, at the tip, makes a room and goes
 * straight to the War Council, where its code and the Invite button are.
 * Everything else is joining: open rooms as tickets, and a code box that a
 * picked ticket fills in, so one Join serves listed and private rooms.
 */
export function MultiplayerBoard(props: {
  rooms: readonly OpenRoom[];
  online: boolean;
  onRefresh(): void;
  onJoin(code: string): void;
  onHost(): void;
  onBack(): void;
}) {
  const [code, setCode] = createSignal('');
  const rooms = createMemo(() => sortRooms(props.rooms));
  const open = () => rooms().filter(r => r.filled < r.total).length;
  const join = (c = code()): void => {
    if (props.online && c.length > 0) props.onJoin(c);
  };

  // The ticket row: one row however many rooms there are. It scrolls
  // sideways (a mouse wheel too — nobody has a sideways wheel), snaps to
  // whole tickets, and fades whichever end still has more past it; laid out
  // narrow it is a two-column grid scrolling up and down instead.
  let tickets: HTMLDivElement | undefined;
  const [edge, setEdge] = createSignal({before: false, after: false});
  const edges = (): void => {
    const el = tickets;
    if (!el) return;
    const across = el.scrollWidth > el.clientWidth + 1;
    const [pos, room] = across
      ? [el.scrollLeft, el.scrollWidth - el.clientWidth]
      : [el.scrollTop, el.scrollHeight - el.clientHeight];
    setEdge({before: room > 1 && pos > 1, after: room > 1 && pos < room - 1});
  };
  const onWheel = (e: WheelEvent): void => {
    const el = tickets;
    if (!el || el.scrollWidth <= el.clientWidth + 1) return;
    if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
    e.preventDefault();
    el.scrollBy({left: e.deltaY, behavior: 'smooth'});
  };
  const watch = new ResizeObserver(edges);
  onCleanup(() => watch.disconnect());

  let spin: HTMLButtonElement | undefined;
  const refresh = (): void => {
    spin?.classList.remove('spin');
    void spin?.offsetWidth;
    spin?.classList.add('spin');
    props.onRefresh();
  };

  return (
    <>
      <div class="tipcol">
        <button
          class="go"
          disabled={!props.online}
          onClick={() => props.onHost()}
        >
          Host
        </button>
        <span class="hint">Makes a room with a code to share</span>
      </div>
      <div class="main">
        <BoardHead
          title="Multiplayer"
          sub="Play with friends"
          onBack={() => props.onBack()}
        />
        <div class="rooms">
          <span class="lbl">
            Open rooms
            <Show when={props.rooms.length > 0}>
              <span class="n"> · {open()}</span>
            </Show>
          </span>
          <div
            class="tickets"
            classList={{
              'more-before': edge().before,
              'more-after': edge().after,
            }}
            ref={el => {
              tickets = el;
              watch.observe(el);
            }}
            onScroll={edges}
            onWheel={onWheel}
          >
            <Show
              when={props.online}
              fallback={<span class="none">Offline: no rooms to show.</span>}
            >
              <Show
                when={rooms().length > 0}
                fallback={<span class="none">None right now. Host one!</span>}
              >
                <For each={rooms()}>
                  {r => {
                    const full = () => r.filled >= r.total;
                    return (
                      <button
                        class="ticket"
                        classList={{sel: code() === r.code}}
                        disabled={full()}
                        aria-label={`Room ${r.code}, ${r.filled} of ${r.total} seats`}
                        onClick={() => setCode(code() === r.code ? '' : r.code)}
                        onDblClick={() => join(r.code)}
                      >
                        <span class="code">{r.code}</span>
                        <span class="pips">
                          <For
                            each={Array.from(
                              {length: r.total},
                              (_, i) => i < r.filled,
                            )}
                          >
                            {on => <i classList={{on}} />}
                          </For>
                        </span>
                        <span class="meta">
                          {full()
                            ? 'full'
                            : r.ai
                              ? `${r.ai} AI`
                              : roomAge(r.ageMs)}
                        </span>
                      </button>
                    );
                  }}
                </For>
              </Show>
            </Show>
          </div>
          <button
            class="refresh"
            title="Refresh"
            aria-label="Refresh the rooms"
            ref={spin}
            onClick={refresh}
          >
            <RefreshIcon />
          </button>
        </div>
        <div class="join">
          <label for="sp-room-code">Have a code?</label>
          <input
            id="sp-room-code"
            maxLength={6}
            placeholder="ABCDE"
            spellcheck={false}
            autocomplete="off"
            value={code()}
            disabled={!props.online}
            onInput={e => {
              const v = e.currentTarget.value
                .replace(/[^a-zA-Z0-9]/g, '')
                .toUpperCase()
                .slice(0, 6);
              e.currentTarget.value = v;
              setCode(v);
            }}
            onKeyDown={e => {
              if (e.key === 'Enter') join();
            }}
          />
          <button
            class="go small"
            disabled={!props.online || code().length === 0}
            onClick={() => join()}
          >
            Join
          </button>
        </div>
      </div>
    </>
  );
}
