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
- **A sunny valley.** A blue sky dome with shader-drawn snow-capped
  ranges and drifting clouds (`sky.ts`); the menu's own sun behind the lens,
  off to its right, so the keep is lit and the signpost casts a shadow
  (`GameRenderer.setSun` / `aimShadow`); grass, flowers and reeds sway, the
  trees do not; two butterflies behind the pond.
- **War Council on the arrow's front.** Host flips 180° and zooms closer
  (the chat needs height); Leave flips back. Only the open arrow's board
  draws.

## Wire the boards to the game

- [x] Campaign **Play** launches the picked mission (`missionUrl`), giving
      the WebGL context back first.
- [x] Skirmish **Play** launches with the chosen rivals (None = sandbox),
      difficulty and bandits, and a seed rolled fresh per visit. The seed
      is not shown (decided 2026-09-24: random, not something to read). The
      lab's map-size row is gone: the old menu never offered one.
- [x] Room tickets come from the relay's open-room list, polled every 3s
      while the board is up and the tab visible; **Refresh** re-asks.
- [x] **Join** (picked ticket, double-click, or typed code) and **Host**
      walk into the council through the shell (`onCouncil`, `runLobby`).
- [x] The council is the real room: code, seats, chat, the host's settings
      reaching every seat, **Begin** starting the match, **Invite** sharing.
      Joiners see the settings disabled; the host's AI seats fill chairs.
- [x] **Listed / Invite only** from the council: the host's switch sends
      `visibility` to the relay, which lists or unlists the room and tells
      every seat (`open` in the room state). Joiners see it, disabled.

## Parity with the old menu

- [x] Campaign **difficulty** picker: a row under the mission, the same
      remembered tier as the skirmish board's (the old menu's one row). The
      campaign board lays out taller (`NEEDS` in `scene.ts`) to fit it.
- [x] Campaign **hide hints**: dropped (decided 2026-09-24). Hints are
      always on in the tutorial.
- [x] Mission **briefings**: the match opens on the long briefing, so the
      board's one-liner is enough.
- [x] War Council **map seed**: not shown, no re-roll (decided
      2026-09-24). A multiplayer valley is always random.
- [x] **Offline**: the Multiplayer board says so, Host and Join disable,
      and polling stops.
- [x] **Replays**: written on a face of a rock (the hexagon pack's
      `mountain_C`) standing in the valley; the footer's Replays flies the
      lens over to it. Pick and Watch, double-click, delete, share, drag
      out, drop in (`ShelfBoard.tsx`). The list and launch code are the
      old menu's, which worked; not re-tried with a real recording.
- [x] **Load save**: the same shelf for saved games, written on the
      keep's back wall under its window; the lens swings round to it on one
      arc over the trees. Not re-tried with a real save (as above). **Map
      editor** and **Field guide** work.
- [x] Reopen on the last board: not wanted (decided 2026-09-24). It
      always opens on the crossroads.

## Before it ships

- [ ] **Keyboard and screen readers**: visually hidden buttons stand in
      for the arrows and Esc closes a board; not yet walked through with
      Tab or VoiceOver.
- [ ] **Reduced motion**: turn, flip, zoom and the trip to the rock snap,
      and the pointer/tilt lean stops, under `prefers-reduced-motion`; not
      yet checked by eye.
- [x] **Frame rate**: capped at 30fps on every device (`MENU_FPS`), as
      the old backdrop was; full resolution.
- [ ] **Real devices**: everything so far is pane emulation. Check a real
      phone, including `:active` presses on iOS and the tilt lean (iOS asks
      permission on the first tap). Erik tests on staging once the branch
      is deployed there.
- [x] **Fonts**: Lilita One and Nunito are self-hosted in `public/fonts`
      (latin and latin-ext, OFL texts beside them) and credited; Marcellus,
      the old menu's wordmark, is gone.
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
