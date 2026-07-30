/// <reference lib="webworker" />
import { deserializeWorld } from '../sim/save';
import { createWorld, type World, type WorldConfig } from '../sim/world';
import { tickWorld, type PlayerCommand } from '../sim/tick';
import { AiBrain } from '../sim/systems/ai';
import { decodeFrame, encodeTurnSubmit } from '../protocol/net';
import type { SimCommand } from '../sim/commands';

/**
 * One AI seat, one worker. The brain never runs inside the sim tick —
 * it holds a REPLICA world and speaks ordinary commands, so the real sim
 * stays input-driven and AI thinking can never stall a tick or a rollback.
 *
 * Two transports, one shape:
 * - Single-player: the sim worker streams every executed tick's commands
 *   over a MessagePort; the replica ticks in lockstep and answers with
 *   its seat's commands, which the sim queues like any click.
 * - Multiplayer: the worker is a headless net client — it binds the AI
 *   seat's token to its own relay socket, replays/streams closed TURN
 *   frames into the replica, and submits command envelopes. Every human
 *   client then receives the AI's moves as normal remote input.
 */

export type AiWorkerInit =
  | { type: 'init'; playerId: number; loadData?: string; config?: WorldConfig; port: MessagePort }
  | {
      type: 'init';
      playerId: number;
      loadData: string;
      net: { relayUrl: string; token: string };
    };

interface TickFeed {
  type: 'tick';
  commands: PlayerCommand[];
}

let world: World | null = null;
let brain: AiBrain | null = null;

self.onmessage = (e: MessageEvent<AiWorkerInit>) => {
  const msg = e.data;
  if (msg.type !== 'init' || world) return;
  brain = new AiBrain(msg.playerId);
  if ('net' in msg) {
    world = deserializeWorld(msg.loadData);
    openSocket(msg.net, msg.loadData, msg.playerId);
  } else {
    world =
      msg.loadData !== undefined
        ? deserializeWorld(msg.loadData)
        : createWorld(msg.config!);
    const port = msg.port;
    port.onmessage = (ev: MessageEvent<TickFeed>) => {
      if (!world || !brain) return;
      // Think first (from the state the sim showed everyone at this tick),
      // then advance the replica with what actually ran.
      if (brain.shouldDecide(world.tick)) {
        const commands = brain.decide(world);
        if (commands.length > 0) port.postMessage({ type: 'aiCommands', commands });
      }
      tickWorld(world, ev.data.commands);
    };
  }
};

function openSocket(
  net: { relayUrl: string; token: string },
  blob: string,
  playerId: number,
): void {
  let seq = 0;
  const connect = (attempt: number): void => {
    const ws = new WebSocket(net.relayUrl);
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => {
      ws.send(JSON.stringify({ t: 'rejoin', token: net.token }));
    };
    ws.onmessage = (e: MessageEvent) => {
      if (typeof e.data === 'string' || !world || !brain) return;
      const frame = decodeFrame(new Uint8Array(e.data as ArrayBuffer));
      if (frame.kind !== 'turn') return;
      // Frames arrive in order on one socket; a reconnect replays from 0,
      // so skip anything the replica already lived through.
      if (frame.firstTick < world.tick) return;
      if (brain.shouldDecide(world.tick)) {
        const commands = brain.decide(world);
        if (commands.length > 0 && ws.readyState === WebSocket.OPEN) {
          ws.send(
            encodeTurnSubmit({
              desiredTick: world.tick + 1,
              seq: seq++,
              commands: commands as SimCommand[],
            }),
          );
        }
      }
      const sorted = [...frame.records].sort((a, z) => a.playerId - z.playerId || a.seq - z.seq);
      const flat: PlayerCommand[] = [];
      for (const r of sorted) for (const cmd of r.commands) flat.push({ playerId: r.playerId, cmd });
      tickWorld(world, flat);
    };
    ws.onclose = () => {
      // Rebuild from the blob and let the relay's history replay the
      // replica back to truth (brain pacing memory resets; harmless).
      setTimeout(() => {
        world = deserializeWorld(blob);
        brain = new AiBrain(playerId);
        connect(attempt + 1);
      }, Math.min(500 * 2 ** attempt, 8000));
    };
  };
  connect(0);
}
