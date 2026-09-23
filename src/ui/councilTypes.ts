import type {Accessor} from 'solid-js';
import type {LobbyConfig} from '../protocol/lobby';
import type {Enum} from '../shared/enum.ts';
import type * as PlayerKind from '../sim/playerKindEnum.ts';
import type * as CouncilPhaseNs from './councilPhaseEnum.ts';

/**
 * What the War Council shows and what it can do — the contract between the
 * lobby client (net/lobbyClient.ts), which fills it from the relay, and the
 * council board on the signpost (signpost/CouncilBoard.tsx), which draws it.
 */

export type CouncilPhase = Enum<typeof CouncilPhaseNs>;

/** One line said at the table while it waits. `seat` is the chair it came
 * from, which is also its banner colour — the same colour that names the
 * seat in the list above, since the lobby has no names to give. */
export interface ChatLine {
  id: number;
  seat: number;
  text: string;
}

export interface CouncilView {
  /** One-line context from the journey here ('Your previous match has
   * ended.') — shown quietly above the lobby. */
  notice?: string;
  phase: CouncilPhase;
  code: string;
  yourSeat: number;
  seats: {kind: PlayerKind.human | 'ai'; connected: boolean}[];
  config: LobbyConfig;
  /** Listed in everyone's room browser, or found by its code only. */
  open: boolean;
  /** Table talk, oldest first, this seat's own lines included — the relay
   * echoes every line to everyone, so the log is the same on every seat. */
  chat: ChatLine[];
}

export interface CouncilHooks {
  view: Accessor<CouncilView>;
  /** Host-only settings change; the relay echoes it back to every seat. */
  onConfig(patch: Partial<LobbyConfig>): void;
  /** Host only: list the room in the browser, or take it off. */
  onListed(open: boolean): void;
  onStart(): void;
  /** Hand the invite link over; resolves with which route it took. */
  onShare(): Promise<'shared' | 'copied'>;
  /** Back out: the room is abandoned and the shell shows the start screen. */
  onLeave(): void;
  /** Say one line to the table; it comes back through `view().chat`. */
  onChat(text: string): void;
}
