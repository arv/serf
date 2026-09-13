# Serf Valley server

One process, one port: this Node server serves the built game over HTTP
(with the COOP/COEP headers SharedArrayBuffer needs) and speaks the
multiplayer protocol over WebSocket on the same origin.

**It owns the world.** Each room holds a `World`, ticks it at 20 Hz on the
server clock, and sends every seat a filtered view of it. Clients send
orders and render what they are told; they never simulate. That is what
makes information cheating impossible rather than merely inconvenient — a
player is not trusted to hide what they were given, they are never given
it. See `src/sync.ts` for the filter and `../src/sim/visibility.ts` for
what a seat can see.

The sim is loaded straight from `../src/sim` — no build step. Node strips
the types, and those files spell out `.ts` on their imports so it resolves.
`pnpm smoke` boots a world in this process and ticks it, which is the guard
on that arrangement.

## Run locally

```sh
pnpm build           # produce dist/ (the server serves it when present)
pnpm server          # from the repo root (node --watch, port 8787)
```

Open `http://localhost:8787/` — the production build, fully self-hosted.
`/?mp=new` hosts a room (share the link, or the code via `/?mp=CODE`),
`&ai=N` seats computer opponents, `/?ai=1` is a serverless solo skirmish
that runs entirely in the browser.

During development you can also run `pnpm dev` (vite) next to the server;
the dev client finds the server at `ws://localhost:8787`. In production the
client uses its own origin. Overrides: `?relay=` param or `VITE_RELAY_URL`
at build time.

## AI seats

AI brains run here, in-process, next to the world they play in — one
`AiBrain` per AI seat, called each tick alongside the players' orders.
Single player does the same thing inside its own worker. Neither holds a
replica world, and there is no AI-specific netcode.

## Deploy (Railway — one service)

Deploy the repo root as a single service:

- Build command: `pnpm install && pnpm --dir server install && pnpm build`
  (server deps first: `pnpm build` typechecks this package too, and that
  needs its `@types/node` and `ws` present)
- Start command: `node server/src/index.ts` (Node ≥ 23 strips the shared
  TypeScript natively — no server build step)
- Railway provides `PORT`; `/health` answers 200.
- Attach a **volume** so running matches survive deploys. Railway exposes
  its mount path as `RAILWAY_VOLUME_MOUNT_PATH`, which the server picks up
  by itself (see `src/persist.ts`). Without one the snapshot lands inside
  the image's filesystem, which the next deploy discards — every push is
  back to killing every match.

WebSockets are not subject to COEP/CORP, so no extra headers or services
are needed.

## Logs: who connected, which matches started

Beyond the human-readable `[serf] ...` lines, the server writes one JSON
object per line for the events an operator wants to count or look up
(`src/log.ts`). Railway's log explorer parses these: `level` and
`message` are the line, every other key is a filterable attribute — so
`@event:match_start` lists every multiplayer game that began, and
`@ip:203.0.113.7` is everything one address did.

| `event` | when | fields |
| --- | --- | --- |
| `page_view` | the game's document was served (a visit; solo play never opens a socket, so this is most visitors' only trace) | `path`, `ip`, `ua` |
| `connect` | a WebSocket client arrived | `conn`, `ip`, `ua` |
| `disconnect` | ...and left | `conn`, `ip`, `durationMs`, `room`, `playerId` |
| `room_create` | a room was made | `conn`, `ip`, `room`, `visibility`, `ai` |
| `room_join` | a human took a seat | `conn`, `ip`, `room`, `playerId`, `humans` |
| `rejoin` | a token came back | `conn`, `ip`, `found`, `room`, `playerId` |
| `match_start` | the host started a match | `room`, `humans`, `ai`, `seats`, `seed`, `size`, `bandits`, `difficulty`, `bots`, `matchesStarted` |

`conn` is a per-process socket number that ties one connection's lines
together. `ip` is the rightmost `X-Forwarded-For` entry (the one
Railway's edge appended; a client can prepend to that header but not
append after the proxy), or `X-Real-IP` when set, or the socket peer with
no proxy in front; `forwardedFor` carries the whole chain when there is
more than one hop. `matchesStarted` counts since the process booted and
resets with every deploy — the log lines are the durable record, within
Railway's retention window for your plan.

Railway's own **HTTP logs** (Observability → the service's HTTP Logs, for
a service with a public domain) record every request the edge proxied,
including the WebSocket upgrade, with the client address and user agent —
that is the raw per-request traffic view; the lines above are the
game-level one.

## Capacity

`/health` reports load, not just liveness:

```json
{ "ok": true, "rooms": 100, "running": 100, "seats": 200,
  "matchesStarted": 140, "pumpMsAvg": 0.057, "pumpMsPeak": 1.587 }
```

`pumpMsAvg` is the per-room cost of one pump — simulate, recompute
visibility, filter and encode for every seat. Measured on a dev machine at
100 concurrent 2-seat rooms: **0.057 ms per room**, about 0.1% of the 50 ms
tick budget, with all 200 seats holding full frame rate.

CPU is therefore not the first limit. **Bandwidth is**: ~10.7 KiB/s per
seat, so those 200 seats are ~17 Mbps of egress. Size the box for the
network before the processor.

Rooms are ticked sequentially on one thread. That is what makes the
pathfinder's shared scratch buffers safe (see the contract on
`../src/sim/path.ts`) — moving rooms onto worker threads needs per-room
scratch first.

## State & limits

Rooms live in memory while the process runs, and running matches survive a
restart: SIGTERM (which is what a deploy sends) serializes every running
room — world, seat tokens, per-seat fog — to a snapshot on disk, and the
next process restores them before it starts listening, so the rejoin
tokens clients are retrying with stay good across the gap. The clock is
rebased on restore: the downtime reads as a pause, not as minutes of
unattended simulation. The snapshot needs storage that outlives the image
— a Railway volume (`RAILWAY_VOLUME_MOUNT_PATH`, automatic) or
`SERF_STATE_DIR`; local dev falls back to `server/.data/`. Lobby rooms are
not persisted: their occupants never learned a token, so no one could
claim a restored lobby seat.

Disconnected players rejoin by token while the room lives; a room whose
humans have all been gone for 5 minutes is swept, and a restored room
starts that clock at boot — matches nobody comes back for clean
themselves up.

A room keeps ticking while its players are away, which is deliberate: the
tick is derived from wall-clock time since match start, so a room that
paused would have to catch up thousands of ticks on rejoin. Catching a
client up is one state frame regardless of how long the match has run —
there is no history to replay, and so no per-tick log to grow.
