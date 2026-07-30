/**
 * Sim-side logging valve. During rollback re-simulation the same warnings
 * would fire again for ticks that already ran — the netcode layer flips
 * `resimulating` around a re-sim burst and the sim keeps quiet.
 */
let resim = false;

export function setResimulating(v: boolean): void {
  resim = v;
}

export function isResimulating(): boolean {
  return resim;
}

export function simWarn(message: string): void {
  if (!resim) console.warn(message);
}
