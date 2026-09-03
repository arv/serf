import {describe, expect, it} from 'vitest';
import {
  ADMIN_ACTION_NAMES,
  ADMIN_DOCS,
  COMMAND_DOCS,
  COMMAND_KIND_NAMES,
} from './commandsDoc';

/**
 * The commands page prints each order's enum member name beside its wire
 * number. The names come from the enum module's namespace at runtime, so
 * a doc keyed by a value with no member behind it would render a blank
 * name; hold the two tables to the same key set.
 */
describe('the command reference', () => {
  it('names every documented command kind', () => {
    for (const kind of Object.keys(COMMAND_DOCS)) {
      expect(COMMAND_KIND_NAMES.get(Number(kind)), `kind ${kind}`).toMatch(
        /^\w+$/,
      );
    }
    expect(Object.keys(COMMAND_DOCS)).toHaveLength(COMMAND_KIND_NAMES.size);
  });

  it('names every documented admin action', () => {
    for (const action of Object.keys(ADMIN_DOCS)) {
      expect(
        ADMIN_ACTION_NAMES.get(Number(action)),
        `action ${action}`,
      ).toMatch(/^\w+$/);
    }
    expect(Object.keys(ADMIN_DOCS)).toHaveLength(ADMIN_ACTION_NAMES.size);
  });

  it('spells the names the way the enum module does', () => {
    expect(COMMAND_KIND_NAMES.get(1)).toBe('moveUnits');
    expect(COMMAND_KIND_NAMES.get(17)).toBe('focusTarget');
    expect(ADMIN_ACTION_NAMES.get(6)).toBe('spawnParade');
  });
});
