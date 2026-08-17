/**
 * The solo save as it sits in storage: the worker's world serialization
 * plus the renderer's fog memory. The world alone used to be the whole
 * save, and reloading one left everything the player had scouted dark —
 * the sim has no notion of what a seat has *seen* (solo fog is entirely
 * render-side), so the explored grid has to ride along here, at the one
 * layer that can see both halves.
 *
 * The envelope is assembled and split on the main thread only; the worker
 * keeps receiving exactly the world string it produced. Saves from before
 * the envelope are raw world strings, and splitSave passes them through
 * untouched, fog simply unseeded — precisely the old behavior.
 */

const FMT = 'serf-save-v2';

/** One byte per tile in, six bits per char out (packed + base64). Shared
 * with replays, which carry the same grid when one boots from a save —
 * and with the server, whose own packing (persist.ts) is bit-compatible. */
export function packExplored(explored: Uint8Array): string {
  const bytes = new Uint8Array(Math.ceil(explored.length / 8));
  for (let i = 0; i < explored.length; i++) {
    if (explored[i]) bytes[i >> 3] = bytes[i >> 3]! | (1 << (i & 7));
  }
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

export function unpackExplored(packed: string, tiles: number): Uint8Array | undefined {
  try {
    const bin = atob(packed);
    const out = new Uint8Array(tiles);
    for (let i = 0; i < tiles; i++) {
      const byte = bin.charCodeAt(i >> 3);
      if (Number.isNaN(byte)) break; // truncated: keep what decoded
      if (byte & (1 << (i & 7))) out[i] = 1;
    }
    return out;
  } catch {
    return undefined; // corrupt fog is no reason to lose the world
  }
}

export function envelopeSave(world: string, explored: Uint8Array): string {
  return JSON.stringify({ fmt: FMT, world, explored: packExplored(explored) });
}

/** Split the envelope without unpacking the fog: at load time the world's
 * grid size is not known yet (it only arrives with the init frame), so the
 * explored grid stays packed here and the caller unpacks it — via
 * `unpackExplored(str, tiles)` — once the size is in hand. */
export function splitSave(data: string): { world: string; explored?: string } {
  try {
    const parsed = JSON.parse(data) as { fmt?: string; world?: string; explored?: string };
    if (parsed?.fmt === FMT && typeof parsed.world === 'string') {
      return {
        world: parsed.world,
        explored: typeof parsed.explored === 'string' ? parsed.explored : undefined,
      };
    }
  } catch {
    // Not JSON at all — certainly not an envelope.
  }
  return { world: data };
}
