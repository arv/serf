import {For, Show, createEffect, createMemo, createSignal} from 'solid-js';
import {MAX_CHAT_CHARS, sanitizeChatText} from '../../protocol/chat.ts';
import {MAX_SEATS, type LobbyConfig} from '../../protocol/lobby';
import {
  DIFFICULTY_KEYS,
  type DifficultyId,
  parseDifficultyId,
} from '../../sim/defs/difficulty.ts';
import * as DifficultyIdNs from '../../sim/defs/difficultyEnum.ts';
import * as CouncilPhaseNs from '../councilPhaseEnum.ts';
import type {CouncilHooks} from '../councilTypes';
import {DIFFICULTY_OPTIONS, Seg, type SegOption} from './boards';

/**
 * The War Council, on the front of the Multiplayer arrow: where hosting and
 * joining land. The room code with Invite, who can find the room, the seats
 * as friends take them, the settings every seat watches the host change, the
 * table talk, and Begin at the tip.
 *
 * Security note: everything shown that is not a literal here — the room
 * code, seat kinds, the settings, the chat — is written by the relay. It all
 * renders through Solid's JSX text interpolation, which inserts text nodes,
 * never markup. Keep it that way: no innerHTML, ever. (A crafted room code
 * once ran script in this origin, which holds the saves and the seat token.)
 */

/** Banner colors, matching factionTint's seats — the same green, red, blue
 * and gold the players' castles wear in the match. */
const SEAT_COLORS = ['#008454', '#d22227', '#257ebc', '#f9aa4e'];

const AI_CHOICES = Array.from({length: MAX_SEATS}, (_, i) => i);

const ON_OFF: readonly SegOption<boolean>[] = [
  {value: false, label: 'Off'},
  {value: true, label: 'On'},
];

/** Who can find the room: the host's to change while the council sits. */
const LISTING: readonly SegOption<boolean>[] = [
  {value: true, label: 'Listed'},
  {value: false, label: 'Invite only'},
];

interface SeatChip {
  color: string;
  who: string;
  open: boolean;
  away: boolean;
}

export function CouncilBoard(props: {
  hooks: CouncilHooks | null;
  /** Back out while there is no room yet to back out of. */
  onLeave(): void;
}) {
  const view = () => props.hooks?.view();
  const inRoom = (): boolean => view()?.phase === CouncilPhaseNs.lobby;
  // Seat 0 runs the council. Derived, not passed in: if the host leaves the
  // lobby the relay renumbers the seats, and whoever lands at 0 inherits the
  // controls without a reload.
  const isHost = (): boolean => inRoom() && view()!.yourSeat === 0;
  /** Chairs the humans have not taken — the ceiling on computer seats. */
  const seatsLeft = (): number => MAX_SEATS - (view()?.seats.length ?? 0);
  /** Computer chairs the march will actually field: the host's number can
   * outrun the table (it was set before the humans arrived, and is kept so
   * the seats come back if they leave), so everything here reads this. */
  const aiFill = (): number =>
    Math.max(0, Math.min(view()?.config.ai ?? 0, seatsLeft()));
  /** The tier the host has set, or `normal` for a room that names none. */
  const tier = (): DifficultyId =>
    parseDifficultyId(view()?.config.difficulty) ?? DifficultyIdNs.normal;

  /** What a human seat is called at this table. Every banner plays for
   * itself — there are no teams — so the others are rivals, not allies;
   * the one running the council is the host. */
  const whoAt = (seat: number): string =>
    seat === view()?.yourSeat ? 'You' : seat === 0 ? 'Host' : 'Rival';
  /** The table, always MAX_SEATS chairs: humans, then the computer seats
   * the host asked for, then what is still open. */
  const seats = (): SeatChip[] => {
    const v = view();
    if (!v) return [];
    const out: SeatChip[] = v.seats.map((s, i) => ({
      color: SEAT_COLORS[i % SEAT_COLORS.length]!,
      who: whoAt(i),
      open: false,
      away: !s.connected,
    }));
    // 'Computer', never a playbook's name: the march is where you find out
    // who you are up against.
    for (let i = 0; i < aiFill(); i++)
      out.push({
        color: SEAT_COLORS[out.length % SEAT_COLORS.length]!,
        who: 'Computer',
        open: false,
        away: false,
      });
    while (out.length < MAX_SEATS)
      out.push({color: '', who: 'Open', open: true, away: false});
    return out;
  };

  // The relay drops non-host config on the floor; a joiner's controls are
  // disabled, and this guard keeps a stray keypress from sending anything.
  const patch = (p: Partial<LobbyConfig>): void => {
    if (isHost()) props.hooks?.onConfig(p);
  };

  const [shared, setShared] = createSignal(false);
  const share = (): void => {
    void props.hooks?.onShare().then(how => {
      if (how === 'shared') return; // the share sheet is its own feedback
      setShared(true);
      setTimeout(() => setShared(false), 1600);
    });
  };

  const banner = (seat: number): string =>
    SEAT_COLORS[seat % SEAT_COLORS.length]!;

  let say: HTMLInputElement | undefined;
  let log: HTMLDivElement | undefined;
  const send = (): void => {
    if (!say) return;
    const text = sanitizeChatText(say.value);
    say.value = '';
    if (text !== null) props.hooks?.onChat(text);
  };
  // Keep the newest line in view as lines arrive — through a memo of its
  // id, so a settings echo does not drag a player who scrolled up back
  // down to the foot.
  const newest = createMemo(() => view()?.chat.at(-1)?.id ?? 0);
  createEffect(() => {
    if (newest() > 0 && log) log.scrollTop = log.scrollHeight;
  });

  const leave = (): void => {
    if (props.hooks) props.hooks.onLeave();
    else props.onLeave();
  };

  return (
    <>
      <div class="tipcol">
        <button
          class="go"
          disabled={!isHost()}
          title={isHost() ? undefined : 'The host begins the match'}
          onClick={() => props.hooks?.onStart()}
        >
          Begin
        </button>
      </div>
      <div class="main">
        <header>
          <h2 class="comic">War Council</h2>
          <button class="back" onClick={leave}>
            Leave
          </button>
        </header>
        <Show
          when={inRoom()}
          fallback={
            <>
              <div class="code-row">
                <span class="lbl">Reaching the relay…</span>
              </div>
              <div class="log">
                <Show when={view()?.notice}>
                  {n => <div class="line note">{n()}</div>}
                </Show>
              </div>
            </>
          }
        >
          <div class="code-row">
            <span class="lbl">Room</span>
            <span class="code">{view()!.code}</span>
            <button class="invite" onClick={share}>
              {shared() ? 'Copied!' : 'Invite'}
            </button>
            <Seg
              label="Who can find the room"
              options={LISTING}
              value={view()?.open ?? true}
              onPick={open => props.hooks?.onListed(open)}
              disabled={!isHost()}
            />
          </div>
          <div class="seats">
            <For each={seats()}>
              {s => (
                <span class="seat" classList={{open: s.open, away: s.away}}>
                  <i style={s.open ? undefined : {background: s.color}} />
                  {s.open ? (
                    <>
                      Open<span class="w"> seat</span>
                    </>
                  ) : (
                    s.who
                  )}
                </span>
              )}
            </For>
          </div>
          <div class="settings">
            <label>AI seats</label>
            <Seg
              label="Computer seats"
              options={AI_CHOICES.map(n => ({
                value: n,
                label: String(n),
                // The table is full at this count; offering it would promise
                // a seat no human could leave.
                disabled: n > seatsLeft(),
              }))}
              value={aiFill()}
              onPick={n => patch({ai: n})}
              disabled={!isHost()}
            />
            <Seg
              label="Difficulty"
              options={DIFFICULTY_OPTIONS}
              value={tier()}
              onPick={id => patch({difficulty: DIFFICULTY_KEYS[id]})}
              disabled={!isHost()}
            />
            <label>Raids</label>
            <Seg
              label="Bandit raids"
              options={ON_OFF}
              value={view()!.config.bandits}
              onPick={on => patch({bandits: on})}
              disabled={!isHost()}
            />
          </div>
          <div class="log" ref={log} aria-live="polite">
            <Show when={view()!.notice}>
              {n => <div class="line note">{n()}</div>}
            </Show>
            <Show when={view()!.chat.length === 0 && !view()!.notice}>
              <div class="line note">
                {isHost()
                  ? 'Invite a friend, or add AI seats. Begin when the table is set.'
                  : 'The host begins the match.'}
              </div>
            </Show>
            <For each={view()!.chat}>
              {line => (
                <div class="line">
                  <b style={{'--c': banner(line.seat)}}>{whoAt(line.seat)}</b>{' '}
                  {line.text}
                </div>
              )}
            </For>
          </div>
          <input
            class="chat"
            ref={say}
            placeholder="Say to the table…"
            maxLength={MAX_CHAT_CHARS}
            aria-label="Say to the table"
            onKeyDown={e => {
              // Enter that commits an IME composition is not a send.
              if (e.key === 'Enter' && !e.isComposing) send();
            }}
          />
        </Show>
      </div>
    </>
  );
}
