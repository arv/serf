# Handoff: vendor the audio sample files

A task brief for a session running on a machine with open network access
(the cloud sandbox that built the audio layer cannot reach kenney.nl or
any mirror). Everything code-side is already in place — this task is
"fetch files, name them, flip the manifest, verify".

## Context

The game has a complete procedural audio layer (`src/audio/`). Every cue
is synthesized from a recipe in `src/audio/cues.ts`; a cue whose def also
names a `sample` path gets that file fetched and decoded after the
autoplay unlock, and the decoded buffer silently replaces the synth at
play time (`src/audio/samples.ts`). Failures — missing file, offline,
Safari refusing Ogg Vorbis — fall back to the synth, so nothing here can
break sound; it can only improve it. The service worker already treats
`/audio/` as a best-effort asset cache (`build/swPlugin.ts`), so these
files cannot endanger the all-or-nothing offline shell install.

## Sources (all CC0, no attribution required)

- https://kenney.nl/assets/impact-sounds
- https://kenney.nl/assets/rpg-audio
- https://kenney.nl/assets/interface-sounds
- https://kenney.nl/assets/music-jingles

Download and unzip; you will cherry-pick ~20 files and discard the rest.
Do NOT commit the full packs.

## Format

Safari's `decodeAudioData` does not decode Ogg Vorbis, so transcode the
chosen files to mono AAC (`.m4a`) — every engine decodes that — with
ffmpeg if available (`ffmpeg -i in.ogg -ac 1 -c:a aac -b:a 96k out.m4a`),
else keep `.ogg` (Safari then keeps the synth versions, which is fine).
Use the same extension for every file and in every manifest path.

## The mapping

Target files live in `public/audio/`, named after their cue id. Exact
source filenames vary between pack versions — pick by listening, using
the suggestions as a starting point. Prefer short, dry, tight-attack
takes; the game plays these dozens of times a minute.

| Target (`public/audio/`) | Cue | Pick from | Suggestion |
|---|---|---|---|
| `uiClick` | uiClick | Interface | `click_002` or similar light click |
| `uiOpen` | uiOpen | Interface | a rising `switch`/`open` pair |
| `uiClose` | uiClose | Interface | the falling counterpart |
| `uiSelect` | uiSelect | Interface | short `select`/`tick` |
| `uiOrder` | uiOrder | Interface | a firm `tap`/`click`, lower than uiClick |
| `uiPlace` | uiPlace | Impact | `impactWood_medium_00x` |
| `uiRefused` | uiRefused | Interface | an `error`/`minimize` buzz |
| `uiToast` | uiToast | Interface | `bookFlip`/paper rustle |
| `uiCoin` | uiCoin | RPG Audio | `handleCoins` |
| `chop` | chop | Impact | `impactWood_heavy_00x` |
| `pickaxe` | pickaxe | Impact | `impactMining_00x` |
| `hammer` | hammer | Impact | `impactWood_medium_00x` (a different take than uiPlace) |
| `footstep` | footstep | RPG Audio | `footstep0x` — pick a soft grassy one |
| `swordSwing` | swordSwing | RPG Audio | `knifeSlice` |
| `bowRelease` | bowRelease | RPG Audio | `bowRelease`/string twang |
| `unitDeath` | unitDeath | Impact | `impactSoft_heavy_00x` body thud |
| `buildingHit` | buildingHit | Impact | `impactMining_003`-ish deep stone crack |
| `buildingComplete` | buildingComplete | Music Jingles | a short bright 2-3 note jingle |
| `buildingCollapse` | buildingCollapse | Impact | heaviest wood/plate crash available |
| `objectiveDone` | objectiveDone | Music Jingles | short ascending jingle, distinct from buildingComplete |
| `distantBell` | distantBell | — | optional; skip if nothing fits (synth bell is fine) |
| `victory` | victory | Music Jingles | triumphant, under ~4s |
| `defeat` | defeat | Music Jingles | minor/descending, under ~4s |

Skipping a row is always fine — that cue keeps its synth.

## Steps

1. Branch `claude/sound-kaykit-plan-lrrnx2` (this file lives on it).
2. Copy the chosen, transcoded files into `public/audio/` under the
   target names above.
3. For each vendored file, add one line to its cue in
   `src/audio/cues.ts`, e.g. `sample: '/audio/chop.m4a',` — the manifest
   IS the CueDef field; there is no second list to maintain.
   (`cues.test.ts` validates the path shape.)
4. Add `public/audio/LICENSE.txt` crediting Kenney (kenney.nl), CC0 —
   mirror the tone of `public/models/kaykit/LICENSE.txt`.
5. README: add a line for Kenney audio next to the KayKit credit.
6. Verify: `pnpm test` (the cue-catalogue tests cover the new fields),
   `pnpm typecheck`, `pnpm build` (confirm the new files land in the
   ASSETS list inside `dist/sw.js`, not the shell list), then `pnpm dev`
   — click around, place a building, start a fight, and listen: vendored
   cues should sound recorded, skipped ones synthesized.
7. Total payload should stay well under 1 MB. Commit on this branch and
   push; mark this file's checklist done or delete it in that commit.

## What NOT to touch

- `src/audio/samples.ts`, `audio.ts`, the scheduler, the service worker —
  already wired; the CueDef `sample:` lines are the only code change.
- The synth recipes — they are the permanent fallback, never dead code.
