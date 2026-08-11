import { MISSION_ORDER, type MissionId } from '../sim/defs/missions';

/**
 * Campaign progress — a profile, not a world. Deliberately separate from
 * the save slot (`serf-save`): finishing a mission is a fact about the
 * player and survives every world they abandon. Sequential unlock is
 * enforced here (UI-side); the ?mission= URL honors any id regardless — a
 * deliberate pressure valve for testers and the impatient.
 */

const KEY = 'serf-campaign';

interface CampaignProgress {
  v: 1;
  completed: MissionId[];
  hintsHidden?: boolean;
}

function load(): CampaignProgress {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as CampaignProgress;
      if (parsed.v === 1 && Array.isArray(parsed.completed)) return parsed;
    }
  } catch {
    // Corrupt or unavailable storage reads as a fresh campaign.
  }
  return { v: 1, completed: [] };
}

function store(progress: CampaignProgress): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(progress));
  } catch {
    // Storage full or denied: progress just doesn't persist this session.
  }
}

export function isMissionComplete(id: MissionId): boolean {
  return load().completed.includes(id);
}

/** Mission k is open once k-1 is complete; the first is always open. */
export function isMissionUnlocked(id: MissionId): boolean {
  const i = MISSION_ORDER.indexOf(id);
  return i <= 0 || isMissionComplete(MISSION_ORDER[i - 1]!);
}

export function markMissionComplete(id: MissionId): void {
  const progress = load();
  if (progress.completed.includes(id)) return;
  progress.completed.push(id);
  store(progress);
}

export function hintsHidden(): boolean {
  return load().hintsHidden === true;
}

export function setHintsHidden(hidden: boolean): void {
  const progress = load();
  progress.hintsHidden = hidden || undefined;
  store(progress);
}
