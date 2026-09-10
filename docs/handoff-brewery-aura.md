# Handoff: the brewery path, the festival aura, and the dev autosave

Branch `arv/eloquent-hypatia-tasprp` on top of main `f2866d5`. Ten commits,
all pushed. No PR opened. Delete this file before opening one.

## What is on the branch

1. `feat(sim)`: a festival also divides every soldier's and tower's attack
   cooldown by 1.25 (`ModifierKey.fightSpeed`, `FESTIVAL_SPEEDUP` in
   `defs/balance.ts`, `strikeCooldown` in `systems/combat.ts`). The archer's
   kite plant stays 8 ticks of the shorter cycle. Replay 62 → 63, app 0.15.0.
2. `feat(sim)`: the brewery costs 12 stone, no wood (two forges emptied the
   Abbot's wood shelf; stone sat above 12 on every beat).
3. `fix(ai)`: the research walker skips a study priced in a research-gated
   good (ale, gold, iron) the seat neither holds, makes, nor has an open
   build step for. Two broader cuts were measured and rejected (see the
   commit).
4. `feat(aiLab)`: `pnpm balance N --no-bandits`, plus `brewery` and `ale`
   columns.
5. `feat(ai)`: Abbot adds Ale Rations; Warlord takes Irrigation → Brewing →
   Festivals before Gilded Arms, with a brewery and a second field and well
   gated on Deep Mining.
6. `docs`: README, in-game docs, tooltips, HUD banner, plan doc.
7. `feat(render,protocol)`: a new per-unit aux byte `buffs`
   (`AUX_STRIDE` 10 → 11, `BUFF.festival`), written by `unitSnapshots`, carried
   by the multiplayer hot frame, read by `SceneSync`.
8. `feat(render)`: the mark is an aura under the feet.
9. `feat(render,protocol)`: the aura is a soft six-ray star; serfs and workers
   wear it too, bandits never.
10. `feat(app)`: dev-only rolling autosave named `hot`, every 10 s in a solo
    match, so `?load=hot` resumes after a Vite full reload.

## Measured (all in commit messages)

- Campaign sweeps: 140/160 (range 101) and 152/160 (range 1000), every
  playbook's wins and median identical to base.
- Peaceful sweeps, Abbot: brewery on 9/12 seeds, 188–202 ale drunk (was 0).
  Warlord: 2/12 on range 101, 0/12 on range 1000 (a pre-existing one-farm
  wheat stall past Cobbled Boots on most seeds).
- Mass archers is not an AI-vs-AI problem: Fletcher 47%/41%/23% vs
  Steward/Warlord/Abbot over 16 mirrored seeds.

## How to see the aura

```
pnpm dev
http://localhost:5173/?seed=37&ai=0&bandits=0&admin
```

Admin panel: **+25 all goods** ×3, **Instant build**; press **B** then **A**
and click ground to place an Abbey; **R** opens research — click
Irrigation, close, **Finish research**; same for Brewing, then Festivals.
The abbey pulls ale within seconds and the banner appears. **Spawn
parade** puts a row of your soldiers by the castle door.

Then switch to `http://localhost:5173/?load=hot&admin`: every Vite reload
resumes within 10 s of where you were.

## Aura tuning knobs (`src/render/sceneSync.ts`, near `makeAuraTexture`)

`AURA_SIZE` (1.35 tiles), the `glow` and `ray` strengths and `RAYS` inside
the texture, the material `opacity`, the spin (`AURA_SPIN`, one turn per
8 s) and the breath (`festivalPulse`, 6% over 2.5 s). Color is
`goldOre` from `palette.ts`.

## Open items

- The aura's look is judged from headless screenshots only; you wanted it
  more like a Warcraft aura. Tune in the running game via `?load=hot`.
- Once, right after a `?load=hot` reload of a match with admin-spawned
  units, the HUD showed "19 invariant violation(s) — see console". A
  second reload of the same save showed none. Not root-caused. Repro: the
  admin steps above, wait 12 s, reload on `?load=hot&admin`, read the
  console. Suspects: the parade (units spawned outside the ledger) or the
  delete-then-write window of the rolling save.
- The Warlord's long-game tail lands only where it gets past Cobbled
  Boots on one farm; that stall predates this branch and also kills its
  gold line. Not addressed.
- The human-vs-AI "mass archers is an easy win" is not measured by any
  instrument here; the festival is a general answer, not an archer counter.
- README mentions the ring over the head in one line (the "gold ring"
  wording); it is an aura under the feet now — fix the sentence.
