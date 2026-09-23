# Plan: the signpost start screen

Status: **designed and prototyped in a lab** (2026-09-23), not yet wired to
the game or in the shipping menu. The lab is `signpost.html` +
`src/ui/signpostLab.ts`, served by the dev server at `/signpost.html`
(`?open=campaign|skirmish|multi|council`, `?unlock=all`,
`?rooms=none|many`).

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

- [ ] Campaign **Play** launches the picked mission (`missionUrl`, with a
      difficulty — see below), releasing the backdrop first as
      `StartMenu.tsx` does.
- [ ] Skirmish **Play** launches with the chosen rivals, difficulty, map
      size and bandits, and a freshly rolled seed (`rollSeed`).
- [ ] Multiplayer room tickets come from the relay's open-room list
      (`listRooms` in `StartMenu.tsx`); **Refresh** re-asks.
- [ ] **Join** (picked ticket or typed code) and **Host** go through
      `onCouncil` / the lobby client, not the lab's stand-ins.
- [ ] War Council shows the real room: code, seats, chat, settings changes
      from every player; **Begin** starts the match; **Invite** uses the
      existing share/copy (`onShare`).
- [ ] Picking AI seats fills open seats (the council does this; the lab
      does not).
- [ ] **Listed / Invite only** changeable from the council — needs a relay
      message; today `open` is only sent with `create`
      (`src/net/lobbyClient.ts`).

## Parity with the old menu

- [ ] Campaign **difficulty** picker (the old menu's `DifficultyRow`).
- [ ] Campaign **hide hints** option (`hintsHidden` / `setHintsHidden`).
- [ ] Mission **briefings** — the long text, not just the one-liner.
- [ ] War Council **map seed** and its re-roll.
- [ ] **Offline**: Multiplayer disabled with a reason, as the old tab bar
      does (`online()`).
- [ ] **Load save** and **Replays**: their file lists (the old "shelf") need
      a place on the signpost; **Map editor** and **Field guide** need to
      go somewhere real.
- [ ] Reopen on the board the player used last (`rememberedMode`), or
      decide not to.

## Before it ships

- [ ] **Keyboard and screen readers**: the arrows are 3D and unreachable by
      Tab; add real buttons (visually hidden) that select them, and Esc /
      Back already close.
- [ ] **Reduced motion**: soften the turn, flip and zoom under
      `prefers-reduced-motion`.
- [ ] **Performance**: the lab renders the valley full-resolution every
      frame; the old backdrop was capped at 30fps and drawn soft. Measure on
      a laptop and a phone (see the GPU perf memory for the harness).
- [ ] **Real devices**: everything so far is pane emulation. Check a real
      phone, including `:active` presses on iOS.
- [ ] **Fonts**: self-host Lilita One and Nunito in `public/fonts` (the lab
      loads them from Google Fonts).
- [ ] **Renderer access**: `GameRenderer` should expose what the menu needs
      (the lab borrows the `WebGLRenderer` from the post's first draw to
      bake the studio light).

## Fold it in

- [ ] Move the lab into the menu shell (`MenuApp.tsx`), replacing the glass
      `StartMenu.tsx` screen and the old War Council screen.
- [ ] Chrome (title, corner Sound / Full screen, footer, build line) keeps
      the `--ui-scale` ladder from `index.html`.
- [ ] Delete `signpost.html` / `signpostLab.ts` once nothing reads them.

## Done in the lab

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
