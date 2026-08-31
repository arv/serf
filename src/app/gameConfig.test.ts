import {describe, expect, it} from 'vitest';
import * as AiStrategyId from '../sim/defs/aiStrategyIdEnum.ts';
import * as MissionId from '../sim/defs/missionIdEnum.ts';
import {MISSION_DEFS, MISSION_ORDER} from '../sim/defs/missions';
import * as PlayerKind from '../sim/playerKindEnum.ts';
import {configFromUrl, missionUrl} from './gameConfig';

/**
 * The start screen speaks to the game entirely through the query string, so
 * these are the contract between the menu and boot(). Every launch URL the
 * menu can produce is covered here.
 */
describe('configFromUrl', () => {
  it('defaults to a solo sandbox with bandits on', () => {
    const c = configFromUrl('');
    expect(c.players).toEqual([{kind: PlayerKind.human}]);
    expect(c.banditsEnabled).toBe(true);
    expect(c.seed).toBe(17);
  });

  it('reads ?bandits=0 — and only that exact value', () => {
    expect(configFromUrl('?bandits=0').banditsEnabled).toBe(false);
    expect(configFromUrl('?bandits=1').banditsEnabled).toBe(true);
    // Absent means on: the menu omits the param when the toggle is left alone.
    expect(configFromUrl('?ai=2&seed=5').banditsEnabled).toBe(true);
  });

  it('builds the skirmish the menu asks for', () => {
    const c = configFromUrl('?ai=2&seed=1234');
    expect(c.seed).toBe(1234);
    expect(c.players).toEqual([
      {kind: PlayerKind.human},
      {kind: PlayerKind.ai},
      {kind: PlayerKind.ai},
    ]);
    expect(c.myPlayerId).toBe(0);
  });

  it('caps computer opponents at the three the menu offers', () => {
    expect(configFromUrl('?ai=3').players).toHaveLength(4);
    expect(configFromUrl('?ai=9').players).toHaveLength(4);
    expect(configFromUrl('?ai=-1').players).toEqual([{kind: PlayerKind.human}]);
  });

  it('names the opponents ?bots asks for, seat by seat', () => {
    const c = configFromUrl('?ai=3&bots=warlord,,abbot');
    expect(c.players.map(p => p.strategy)).toEqual([
      undefined,
      AiStrategyId.warlord,
      undefined,
      AiStrategyId.abbot,
    ]);
    // No param at all: every opponent is left to the seed's deal.
    expect(configFromUrl('?ai=2').players.map(p => p.strategy)).toEqual([
      undefined,
      undefined,
      undefined,
    ]);
    // A playbook nobody has heard of names nothing — it never reaches the
    // world as a strategy id.
    expect(
      configFromUrl('?ai=1&bots=nonesuch').players[1]!.strategy,
    ).toBeUndefined();
  });

  it('ignores junk rather than booting a broken world', () => {
    expect(configFromUrl('?ai=abc').players).toEqual([
      {kind: PlayerKind.human},
    ]);
    // A NaN seed used to reach worldgen and produce nonsense.
    expect(configFromUrl('?seed=abc').seed).toBe(17);
    expect(configFromUrl('?seed=').seed).toBe(17);
  });

  it('boots a campaign mission from ?mission=, def over URL', () => {
    const c = configFromUrl('?mission=levy');
    expect(c.mission).toBe(MissionId.levy);
    // Off the def, not a literal: mission seeds are re-pinned data and this
    // test is about the def winning over the URL, not about which seed.
    expect(c.seed).toBe(MISSION_DEFS[MissionId.levy].seed);
    expect(c.banditsEnabled).toBe(true);
    expect(c.players).toEqual([{kind: PlayerKind.human}]);
    expect(c.myPlayerId).toBe(0);
    // The def is the whole recipe: a stray ?seed or ?ai does not perturb
    // the mission's pinned world.
    const pinned = configFromUrl('?mission=clearing&seed=999&ai=2');
    expect(pinned.seed).toBe(MISSION_DEFS[MissionId.clearing].seed);
    expect(pinned.players).toEqual([{kind: PlayerKind.human}]);
    expect(pinned.banditsEnabled).toBe(false);
    // The bonus mission carries its rival.
    expect(configFromUrl('?mission=rivalBanner').players).toEqual([
      {kind: PlayerKind.human},
      {kind: PlayerKind.ai, strategy: AiStrategyId.steward},
    ]);
  });

  // The two halves of ?mission, closed. The campaign list and the end
  // card's Continue both built '?mission=' + the id, and the id is a
  // number: parseMissionId's string branch knows only the spellings, so
  // every commission launched as an unknown mission — a default skirmish
  // with no briefing card and no objectives checklist.
  it('boots every commission missionUrl can launch', () => {
    for (const id of MISSION_ORDER) {
      expect(configFromUrl(missionUrl(id)).mission).toBe(id);
      // What the id alone would have named: nothing.
      expect(configFromUrl(`?mission=${id}`).mission).toBeUndefined();
    }
  });

  it('ignores a mission nobody has heard of', () => {
    expect(configFromUrl('?mission=nonesuch').mission).toBeUndefined();
    expect(configFromUrl('?mission=nonesuch').seed).toBe(17);
    expect(configFromUrl('?mission=constructor').mission).toBeUndefined();
    expect(configFromUrl('?mission=').mission).toBeUndefined();
  });
});
