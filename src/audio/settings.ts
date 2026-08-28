/**
 * Audio preferences: one `serf-*` localStorage record and the pure
 * parsing around it, in the mould of ui/campaign.ts — corrupt or
 * unavailable storage reads as defaults, a failed write just doesn't
 * persist this session. The parse/convert functions take strings and
 * return data so they test under node with no DOM at all.
 */

import {clamp} from '../shared/math';

const KEY = 'serf-audio';

export interface AudioPrefs {
  v: 1;
  /** Player-facing 0..1 slider position — not the gain (see volumeToGain). */
  volume: number;
  muted: boolean;
}

export const DEFAULT_PREFS: AudioPrefs = {v: 1, volume: 0.8, muted: false};

/** Raw storage string -> prefs; anything questionable reads as defaults. */
export function parseAudioPrefs(raw: string | null): AudioPrefs {
  if (raw !== null) {
    try {
      const parsed = JSON.parse(raw) as AudioPrefs;
      if (
        parsed.v === 1 &&
        typeof parsed.volume === 'number' &&
        Number.isFinite(parsed.volume)
      ) {
        return {
          v: 1,
          volume: clamp(parsed.volume, 0, 1),
          muted: parsed.muted === true,
        };
      }
    } catch {
      // Fall through to defaults.
    }
  }
  return {...DEFAULT_PREFS};
}

/**
 * Slider position -> master gain. Squared, because loudness perception is
 * roughly logarithmic and a linear slider spends half its travel between
 * "loud" and "slightly less loud".
 */
export function volumeToGain(v: number): number {
  const c = clamp(v, 0, 1);
  return c * c;
}

/**
 * Session-only URL overrides, in the house style of configFromUrl:
 * ?mute=1 silences a playtest or a stream capture, ?vol=0.4 pins a level.
 * Neither persists — mirroring ?nofog, a flag is a visit, not a choice.
 */
export function audioFromUrl(search: string): {
  mute?: boolean;
  volume?: number;
} {
  const params = new URLSearchParams(search);
  const out: {mute?: boolean; volume?: number} = {};
  if (params.get('mute') === '1') out.mute = true;
  const vol = Number(params.get('vol'));
  if (params.has('vol') && Number.isFinite(vol)) out.volume = clamp(vol, 0, 1);
  return out;
}

export function loadAudioPrefs(): AudioPrefs {
  try {
    return parseAudioPrefs(localStorage.getItem(KEY));
  } catch {
    return {...DEFAULT_PREFS};
  }
}

export function saveAudioPrefs(prefs: AudioPrefs): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(prefs));
  } catch {
    // Storage full or denied: the choice just doesn't survive the session.
  }
}
