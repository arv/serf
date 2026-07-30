# Serf server

One process, one port: this Node server serves the built game over HTTP
(with the COOP/COEP headers SharedArrayBuffer needs) and speaks the
multiplayer relay protocol over WebSocket on the same origin. It never
simulates the game — the world blob plus the closed turn history *is*
the authoritative state (that's what determinism buys).

## Run locally

```sh
pnpm build           # produce dist/ (the server serves it when present)
pnpm server          # from the repo root (node --watch, port 8787)
```

Open `http://localhost:8787/` — the production build, fully self-hosted.
`/?mp=new` hosts a room (share the code via `/?mp=CODE`), `&ai=N` seats
computer opponents, `/?ai=1` is a relayless solo skirmish.

During development you can also run `pnpm dev` (vite, port 5199) next to
the server; the dev client finds the relay at `ws://localhost:8787`. In
production the client uses its own origin. Overrides: `?relay=` param or
`VITE_RELAY_URL` at build time.

## AI seats

Every AI seat runs in its own dedicated Web Worker (spawned by the match
host's browser), holding a replica world and speaking ordinary commands —
in multiplayer it connects to the relay with its seat token like any
remote player, so its moves reach everyone as normal input.

## Deploy (Railway — one service)

Deploy the repo root as a single service:

- Build command: `pnpm install && pnpm build && pnpm --dir server install`
- Start command: `node server/src/index.ts` (Node ≥ 23 strips the shared
  TypeScript protocol file natively — no server build step)
- Railway provides `PORT`; `/health` answers 200.

The old Caddyfile static deploy is superseded by this; no extra headers
or services are needed (WebSockets are not subject to COEP/CORP).

## State & limits

Rooms live in memory: a server restart drops running matches (clients
show "connection lost" and their rejoin tokens die with the process).
Disconnected players can rejoin by token while the room lives; a room
whose humans have all been gone for 5 minutes is swept. History is one
encoded TURN frame per closed tick — roughly a megabyte per half hour.
