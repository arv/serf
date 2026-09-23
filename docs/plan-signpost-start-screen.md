# Plan: the signpost start screen

Status: **the start screen** (2026-09-23), on branch
`arv/start-screen-3d-signpost`. It replaced the glass menu outright — no
flag — so everything under "Parity" and "Before it ships" is to be done
before the branch merges. The code is `src/ui/signpost/` (the screen, the
3D, the boards, the council board, the styles), mounted by
`src/ui/MenuApp.tsx`.

The start screen stops looking like a web app. A KayKit-style signpost
stands in front of the valley with three arrows — Campaign, Skirmish,
Multiplayer. Clicking one turns the whole signpost round and zooms in: the
arrow's back is the board with that mode's options on it. Hosting flips the
Multiplayer arrow over to its front, where the War Council is.

Decisions that are settled, so they are not relitigated:

- **KayKit look.** Pieces are coloured from `hexagons_medieval.png` atlas
  cells, fat rounded bevels, smooth normals; soft carved grain as a bump +
  AO map on the sign only (colour untouched). Lilita One with a thick dark
  outline for lettering; gold buttons with an ink outline and a ledge that
  the button sinks onto without moving its foot.
- **One canvas.** The signpost hangs off the valley camera in the game's own
  scene. No second WebGL context and no CSS blur — together they made the
  backdrop stutter.
- **Progressive layout.** One rule for every window (`frameFor`): how much
  arrow is in view follows the window width, capped by its height; the
  post side is cropped first, then the head. Board layout scale follows the
  on-screen size. Per-board narrow cutoffs (640 boards / 960 council) are
  decided in code and set `.narrow`.
- **War Council on the arrow's front.** Host flips 180° and zooms closer
  (the chat needs height); Leave flips back. Only the open arrow's board
  draws.

## Wire the boards to the game

- [x] Campaign **Play** launches the picked mission (`missionUrl`), giving
      the WebGL context back first.
- [x] Skirmish **Play** launches with the chosen rivals (None = sandbox),
      difficulty and bandits, and a seed rolled fresh per visit and shown
      as "Valley No.". The lab's map-size row is gone: the old menu never
      offered one.
- [x] Room tickets come from the relay's open-room list, polled every 3s
      while the board is up and the tab visible; **Refresh** re-asks.
- [x] **Join** (picked ticket, double-click, or typed code) and **Host**
      walk into the council through the shell (`onCouncil`, `runLobby`).
- [x] The council is the real room: code, seats, chat, the host's settings
      reaching every seat, **Begin** starting the match, **Invite** sharing.
      Joiners see the settings disabled; the host's AI seats fill chairs.
- [ ] **Listed / Invite only** changeable from the council — needs a relay
      message; today `open` is only sent with `create`
      (`src/net/lobbyClient.ts`). Shown disabled until then.

## Parity with the old menu

- [ ] Campaign **difficulty** picker. The campaign launches with the
      skirmish board's remembered tier, as the old menu's shared row did,
      but nothing on the Campaign board shows or sets it.
- [ ] Campaign **hide hints** option (`hintsHidden` / `setHintsHidden`).
- [x] Mission **briefings**: the match opens on the long briefing, so the
      board's one-liner is enough.
- [ ] War Council **map seed** and its re-roll.
- [x] **Offline**: the Multiplayer board says so, Host and Join disable,
      and polling stops.
- [ ] **Load save** and **Replays**: the player's file lists (import, drag,
      share — the old `SHELVES`) need a place. Their footer buttons are
      disabled until then. **Map editor** and **Field guide** work.
- [ ] Reopen on the board the player used last (`rememberedMode`), or
      decide not to. Today it always opens on the crossroads.

## Before it ships

- [ ] **Keyboard and screen readers**: visually hidden buttons stand in
      for the arrows and Esc closes a board; not yet walked through with
      Tab or VoiceOver.
- [ ] **Reduced motion**: turn, flip and zoom snap and the sway stops
      under `prefers-reduced-motion`; not yet checked by eye.
- [ ] **Performance**: the valley renders full-resolution every frame; the
      old backdrop was capped at 30fps and drawn soft. Measure on a laptop
      and a phone (see the GPU perf memory for the harness).
- [ ] **Real devices**: everything so far is pane emulation. Check a real
      phone, including `:active` presses on iOS.
- [ ] **Fonts**: self-host Lilita One and Nunito in `public/fonts`;
      `index.html` loads them from Google Fonts for now.
- [x] **Renderer access**: `GameRenderer.webgl` for the studio-light bake.

## Fold it in

- [x] The signpost is the menu shell's screen; the glass `StartMenu.tsx`,
      `WarCouncil.tsx`, the old backdrop and `menuChrome.tsx` are gone.
- [x] Chrome keeps the `--ui-scale` ladder from `index.html`; the grade
      layers are off while the menu canvas is up.
- [x] The lab (`signpost.html`, `signpostLab.ts`) is deleted.

## Done (designed in the lab)

- [x] Signpost, arrows, turn-and-zoom, boards on the arrows' backs.
- [x] Campaign board: mission stops with a dotted trail (a snake on narrow
      boards), stops press like buttons.
- [x] Skirmish board: segmented choices with a sliding CSS highlight and a
      pressed look on the chosen option.
- [x] Multiplayer board: Host half and Join half, room tickets that scroll
      (sideways on wide boards, a two-column grid on narrow ones).
- [x] War Council board on the front, flip and zoom, chat log.
- [x] Progressive layout across phone, tablet, tall and wide windows.
- [x] Corner Sound / Full screen (real store and fullscreen module), footer
      and build line scaling like the old menu.
