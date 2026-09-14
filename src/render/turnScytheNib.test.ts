import * as THREE from 'three';
import {describe, expect, it} from 'vitest';
import {turnScytheNib} from './characters';

/**
 * The pack scythe is a reaper's: its grip peg lies in the blade's own
 * plane, which points it at the turf once the blade is swept flat, and out
 * of the farmer's reach. turnScytheNib brings the peg a quarter round the
 * snath, the way a real scythe's nibs are clamped and turned to fit.
 *
 * The risk it carries is tearing the model — the peg and the shaft share
 * one mesh, and the collar rings sit in the same band of the snath as the
 * peg does. What keeps it safe is that the fix-up moves whole connected
 * pieces and only ones that are peg-shaped, and leaves the model entirely
 * alone when it cannot find one. Both halves are pinned here.
 */

/** A box as a standalone connected piece of a mesh. */
function box(
  out: {pos: number[]; idx: number[]},
  min: THREE.Vector3,
  max: THREE.Vector3,
): void {
  const base = out.pos.length / 3;
  for (const x of [min.x, max.x]) {
    for (const y of [min.y, max.y]) {
      for (const z of [min.z, max.z]) out.pos.push(x, y, z);
    }
  }
  // Any triangles will do, so long as they tie all eight corners together.
  for (let i = 1; i < 8; i++)
    out.idx.push(base, base + i, base + ((i % 7) + 1));
}

function mesh(pieces: [THREE.Vector3, THREE.Vector3][]): THREE.Mesh {
  const out = {pos: [] as number[], idx: [] as number[]};
  for (const [min, max] of pieces) box(out, min, max);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute(
    'position',
    new THREE.Float32BufferAttribute(out.pos.slice(), 3),
  );
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(out.pos, 3));
  geo.setIndex(out.idx);
  return new THREE.Mesh(geo);
}

const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
/** The snath: one long piece straddling the band the peg sits in. */
const SHAFT: [THREE.Vector3, THREE.Vector3] = [
  V(-0.06, -0.8, -0.06),
  V(0.06, 1.2, 0.06),
];
/** The peg, as the pack files it: out along +Z at the top of the snath. */
const PEG: [THREE.Vector3, THREE.Vector3] = [
  V(0.0, 0.66, 0.0),
  V(0.12, 0.78, 0.45),
];

/** Float32 storage, so compare boxes to a hair rather than exactly. */
function expectBox(
  got: THREE.Box3,
  min: THREE.Vector3,
  max: THREE.Vector3,
): void {
  for (const k of ['x', 'y', 'z'] as const) {
    expect(got.min[k]).toBeCloseTo(min[k], 5);
    expect(got.max[k]).toBeCloseTo(max[k], 5);
  }
}

function cornersOf(m: THREE.Mesh, from: number): THREE.Vector3[] {
  const pos = m.geometry.getAttribute('position');
  const out: THREE.Vector3[] = [];
  for (let i = from; i < from + 8; i++) {
    out.push(new THREE.Vector3().fromBufferAttribute(pos, i));
  }
  return out;
}

describe('turnScytheNib', () => {
  it('turns the peg a quarter round the snath and leaves the shaft alone', () => {
    const m = mesh([SHAFT, PEG]);
    expect(turnScytheNib(m)).toBe(true);

    // The shaft is untouched, to the last corner.
    expectBox(new THREE.Box3().setFromPoints(cornersOf(m, 0)), ...SHAFT);

    // The peg ran out along +Z; it now runs out along +X, same length.
    const peg = new THREE.Box3().setFromPoints(cornersOf(m, 8));
    expect(peg.max.x - peg.min.x).toBeCloseTo(0.45, 6);
    expect(peg.max.z - peg.min.z).toBeCloseTo(0.12, 6);
    expect(peg.min.y).toBeCloseTo(0.66, 6); // and stays up the snath
    expect(peg.max.y).toBeCloseTo(0.78, 6);
  });

  it('leaves the model alone when nothing peg-shaped is there', () => {
    // A pack update that shortened the peg to a stub: not a peg, not ours.
    const stub: [THREE.Vector3, THREE.Vector3] = [
      V(0.0, 0.66, 0.0),
      V(0.12, 0.78, 0.1),
    ];
    const m = mesh([SHAFT, stub]);
    const before = Array.from(m.geometry.getAttribute('position').array);
    expect(turnScytheNib(m)).toBe(false);
    expect(Array.from(m.geometry.getAttribute('position').array)).toEqual(
      before,
    );
  });

  it('will not move a collar ring that merely shares the peg’s band', () => {
    // A ring around the shaft at the peg's height: inside the band, but it
    // wraps the snath rather than standing out from it.
    const ring: [THREE.Vector3, THREE.Vector3] = [
      V(-0.09, 0.7, -0.09),
      V(0.09, 0.76, 0.09),
    ];
    const m = mesh([SHAFT, ring, PEG]);
    expect(turnScytheNib(m)).toBe(true);
    expectBox(new THREE.Box3().setFromPoints(cornersOf(m, 8)), ...ring);
  });
});
