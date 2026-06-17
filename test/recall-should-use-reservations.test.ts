/**
 * #357 — the single source of truth for "should type-reservations apply?".
 *
 * The rule: reservations are on by default for the no-task constitution pipeline
 * and off by default for task-focused recall, but an explicit caller choice
 * (`--reservations` / `--no-reservations`, i.e. `no_reservations === false/true`)
 * always wins. `shouldUseReservations(hasTask, explicit)` is the one place that
 * rule lives; `getTypeReservations` calls it so the engine and any future caller
 * cannot drift.
 */
import { describe, it, expect } from 'vitest';
import { shouldUseReservations } from '../src/recall.js';

describe('shouldUseReservations', () => {
  it('auto: reservations ON for the no-task path', () => {
    expect(shouldUseReservations(false, undefined)).toBe(true);
  });

  it('auto: reservations OFF for the task path', () => {
    expect(shouldUseReservations(true, undefined)).toBe(false);
  });

  it('explicit on (--reservations) overrides task auto-disable', () => {
    expect(shouldUseReservations(true, true)).toBe(true);
    expect(shouldUseReservations(false, true)).toBe(true);
  });

  it('explicit off (--no-reservations) wins regardless of task', () => {
    expect(shouldUseReservations(true, false)).toBe(false);
    expect(shouldUseReservations(false, false)).toBe(false);
  });
});
