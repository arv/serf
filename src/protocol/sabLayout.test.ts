import { describe, expect, it } from 'vitest';
import { AUX_STRIDE, SAB_BYTES, SabReader, SabWriter, type UnitSnapshot } from './sabLayout';

function unit(id: number, x: number, y: number): UnitSnapshot {
  return { id, x, y, kind: 1, owner: 0, hpPct: 255, carrying: 0, action: 0 };
}

describe('SAB slot protocol', () => {
  it('round-trips unit state through a publish', () => {
    const sab = new SharedArrayBuffer(SAB_BYTES);
    const writer = new SabWriter(sab);
    const reader = new SabReader(sab);

    writer.publish([unit(1, 1.5, 2.5), unit(2, 10.25, 20.75)]);
    expect(reader.poll(1000)).toBe(true);
    expect(reader.latest.count).toBe(2);
    const i1 = reader.latest.index.get(1)!;
    expect(reader.latest.xs[i1]).toBeCloseTo(1.5);
    expect(reader.latest.ys[i1]).toBeCloseTo(2.5);
    expect(reader.latest.aux[i1 * AUX_STRIDE]).toBe(1); // kind
  });

  it('keeps the previous publish for interpolation', () => {
    const sab = new SharedArrayBuffer(SAB_BYTES);
    const writer = new SabWriter(sab);
    const reader = new SabReader(sab);

    writer.publish([unit(1, 0, 0)]);
    reader.poll(0);
    writer.publish([unit(1, 1, 1)]);
    reader.poll(50);

    const pi = reader.prev.index.get(1)!;
    const li = reader.latest.index.get(1)!;
    expect(reader.prev.xs[pi]).toBe(0);
    expect(reader.latest.xs[li]).toBe(1);
    expect(reader.latestObservedAt).toBe(50);
  });

  it('recovers prev from the ring when publishes were skipped', () => {
    const sab = new SharedArrayBuffer(SAB_BYTES);
    const writer = new SabWriter(sab);
    const reader = new SabReader(sab);

    writer.publish([unit(1, 0, 0)]);
    writer.publish([unit(1, 1, 0)]);
    writer.publish([unit(1, 2, 0)]);
    reader.poll(0); // sees publish 3; prev must be publish 2, not garbage
    const pi = reader.prev.index.get(1)!;
    const li = reader.latest.index.get(1)!;
    expect(reader.prev.xs[pi]).toBe(1);
    expect(reader.latest.xs[li]).toBe(2);
  });

  it('poll is a no-op when nothing new was published', () => {
    const sab = new SharedArrayBuffer(SAB_BYTES);
    const writer = new SabWriter(sab);
    const reader = new SabReader(sab);
    writer.publish([unit(1, 0, 0)]);
    expect(reader.poll(0)).toBe(true);
    expect(reader.poll(16)).toBe(false);
    expect(reader.latestObservedAt).toBe(0);
  });

  it('units that vanish are absent from the next publish', () => {
    const sab = new SharedArrayBuffer(SAB_BYTES);
    const writer = new SabWriter(sab);
    const reader = new SabReader(sab);
    writer.publish([unit(1, 0, 0), unit(2, 5, 5)]);
    reader.poll(0);
    writer.publish([unit(2, 5, 5)]);
    reader.poll(50);
    expect(reader.latest.index.has(1)).toBe(false);
    expect(reader.latest.index.has(2)).toBe(true);
  });
});
