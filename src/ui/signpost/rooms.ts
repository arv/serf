import {relayUrl} from '../../net/lobbyClient';

/** One row of the room browser; the shape the server answers {t:'list'} with. */
export interface OpenRoom {
  code: string;
  filled: number;
  total: number;
  ai: number;
  ageMs: number;
}

/** How often the join board asks the server for open rooms. */
export const POLL_MS = 3000;

/** Short-lived lobby socket: ask for the open-room list and hang up. */
export function listRooms(): Promise<OpenRoom[]> {
  return new Promise(resolve => {
    let settled = false;
    const done = (rooms: OpenRoom[]): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
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
      let msg: {t?: string; rooms?: OpenRoom[]};
      try {
        msg = JSON.parse(e.data) as typeof msg;
      } catch {
        return done([]); // not the relay talking: no list, no throw
      }
      if (msg.t === 'rooms') done(msg.rooms ?? []);
    };
    const timer = setTimeout(() => done([]), 4000);
  });
}

/** The order a player wants them in: rooms with a free seat first, the
 * newest of those first; full rooms last. */
export function sortRooms(rooms: readonly OpenRoom[]): OpenRoom[] {
  return [...rooms].sort((a, b) => {
    const fa = a.filled >= a.total ? 1 : 0;
    const fb = b.filled >= b.total ? 1 : 0;
    return fa - fb || a.ageMs - b.ageMs;
  });
}

/** A room's age, as short as a ticket has room for. */
export function roomAge(ms: number): string {
  const min = Math.floor(ms / 60000);
  return min < 1 ? 'new' : `${min} min`;
}
