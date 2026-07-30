# Serf relay

The multiplayer relay: rooms, the lockstep tick authority, and input
relaying. It never simulates the game — the world blob plus the closed
turn history *is* the authoritative state (that's what determinism buys).

## Run locally

```sh
pnpm server          # from the repo root (node --watch, port 8787)
```

The client resolves the relay as `?relay=` param → `VITE_RELAY_URL` →
`ws://<hostname>:8787`. So local play needs nothing: `pnpm dev`,
open `/?mp=new`, share the room code (`/?mp=CODE`), press Start.
`?mp=new&ai=2` seats two AI opponents alongside the humans.

## Deploy (Railway)

1. Add a second service on the same repo; set its Root Directory to
   `server/`. Start command: `pnpm start` (Node ≥ 23 strips the shared
   TypeScript protocol file natively — no build step). Railway provides
   `PORT`; `/health` answers 200.
2. On the static-site service, set the build-time variable
   `VITE_RELAY_URL=wss://<relay-domain>` so shipped clients find it.
   (WebSockets are not subject to COEP/CORP, so the game's cross-origin
   isolation headers need no changes.)

## State & limits

Rooms live in memory: a relay restart drops running matches (clients
show "connection lost" and their rejoin tokens die with the process).
Disconnected players can rejoin by token while the room lives; a room
whose humans have all been gone for 5 minutes is swept. History is one
encoded TURN frame per closed tick — roughly a megabyte per half hour.
