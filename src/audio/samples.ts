/**
 * The sample side of the procedural-first bargain: any cue whose CueDef
 * names a `sample` path gets that file fetched and decoded after unlock,
 * and the decoded buffer wins over the synthesized one at play time.
 * Anything that fails — file missing, network gone, a decoder that does
 * not speak the format (Safari's decodeAudioData and Ogg Vorbis, most
 * notably) — is simply skipped, and the cue keeps its synth voice. Sound
 * can only ever be added by this module, never lost.
 *
 * Deliberately NOT part of the boot Promise.all: decodeAudioData needs a
 * live AudioContext, a live context needs the unlock gesture, and no part
 * of boot may wait on either. Fire-and-forget, like the LLM strategist —
 * cues upgrade from synth to sample as buffers land.
 */

import {type CueDef, type CueId, CUES} from './cues';

export async function loadSamples(
  ctx: AudioContext,
  out: Map<CueId, AudioBuffer>,
): Promise<void> {
  const jobs: Promise<void>[] = [];
  for (const id of Object.keys(CUES) as CueId[]) {
    // Through the interface, not the literal: not every entry names a
    // sample, so the narrowed const type would (rightly) call the field
    // absent on the union.
    const path = (CUES[id] as CueDef).sample;
    if (path === undefined) continue;
    jobs.push(
      fetch(path)
        .then(res => {
          if (!res.ok) throw new Error(String(res.status));
          return res.arrayBuffer();
        })
        .then(bytes => ctx.decodeAudioData(bytes))
        .then(buffer => {
          out.set(id, buffer);
        })
        .catch(() => undefined), // missing or undecodable: the synth stays
    );
  }
  await Promise.all(jobs);
}
