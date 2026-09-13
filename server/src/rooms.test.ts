import {describe, expect, it} from 'vitest';
import {DEFAULT_MAP_SIZE} from '../../src/shared/grid.ts';
import {AI_STRATEGY_KEYS} from '../../src/sim/defs/aiStrategies.ts';
import {addSeat, createRoom, matchSummary, startMatch} from './rooms.ts';

const STRATEGIES = new Set(Object.values(AI_STRATEGY_KEYS));

describe('matchSummary', () => {
  it('reports the tier the world was built at, not the word asked for', () => {
    // sanitizeLobbyConfig screens shape only, so this reaches the room; the
    // world builder resolves the unknown name to normal, and the log must
    // say what is actually being played.
    const room = createRoom('closed', {
      ai: 1,
      bandits: false,
      seed: 11,
      size: DEFAULT_MAP_SIZE,
      bots: [],
      difficulty: 'nightmare',
    });
    addSeat(room, 'human', null);
    startMatch(room);

    expect(matchSummary(room).difficulty).toBe('normal');
  });

  it('carries a tier the sim does know', () => {
    const room = createRoom('closed', {
      ai: 0,
      bandits: false,
      seed: 11,
      size: DEFAULT_MAP_SIZE,
      bots: [],
      difficulty: 'hard',
    });
    addSeat(room, 'human', null);
    startMatch(room);

    expect(matchSummary(room).difficulty).toBe('hard');
  });

  it('names the playbook each computer seat was dealt', () => {
    // One named, one left to the seed — and one name no playbook answers
    // to. Every seat still reports a playbook it is really running.
    const room = createRoom('closed', {
      ai: 2,
      bandits: false,
      seed: 11,
      size: DEFAULT_MAP_SIZE,
      bots: ['warlord', 'not-a-playbook'],
    });
    addSeat(room, 'human', null);
    startMatch(room);

    const {bots} = matchSummary(room);
    expect(bots).toHaveLength(2);
    expect(bots[0]).toBe('warlord');
    for (const bot of bots) expect(STRATEGIES.has(bot)).toBe(true);
  });

  it('has nothing to report before the match is built', () => {
    const room = createRoom('closed', {
      ai: 1,
      bandits: false,
      seed: 11,
      size: DEFAULT_MAP_SIZE,
      bots: [],
      difficulty: 'hard',
    });
    expect(matchSummary(room)).toEqual({difficulty: 'normal', bots: []});
  });
});
