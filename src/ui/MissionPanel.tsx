import { For, Show, createSignal } from 'solid-js';
import { MISSION_DEFS, nextMissionId } from '../sim/defs/missions';
import { MISSION_HINTS } from './hints';
import { hintsHidden, setHintsHidden } from './campaign';
import { briefingOpen, mission, setBriefingOpen, speed } from './store';

/**
 * The campaign's HUD: the briefing card a mission opens on, the standing
 * objectives checklist (top left, under the resource strip), and the
 * current tutorial hint. Hints are a separate, dismissable layer — the
 * checklist alone is enough to play by, and the Hide-hints toggle is
 * remembered across missions (campaign store).
 */

/** Lore steps acknowledged this session, keyed mission:index. In memory on
 * purpose: objective-watching steps skip themselves after a load, and
 * re-reading a lore line after one is no burden. */
const [acked, setAcked] = createSignal<ReadonlySet<string>>(new Set());
const [hideHints, setHideHints] = createSignal(hintsHidden());

export function MissionPanel(props: { onSpeed: (speed: number) => void }) {
  const def = () => {
    const m = mission();
    return m ? MISSION_DEFS[m.id] : undefined;
  };
  const currentHint = () => {
    const m = mission();
    const d = def();
    if (!m || !d || hideHints()) return undefined;
    const steps = MISSION_HINTS[m.id];
    if (!steps) return undefined;
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i]!;
      if (step.objective !== undefined) {
        if (!m.done[step.objective]) return { step, key: `${m.id}:${i}` };
      } else if (!acked().has(`${m.id}:${i}`)) {
        return { step, key: `${m.id}:${i}` };
      }
    }
    return undefined;
  };
  const toggleHints = (): void => {
    const hidden = !hideHints();
    setHideHints(hidden);
    setHintsHidden(hidden);
  };

  return (
    <>
      <style>{`
        .hud-mission {
          position: absolute; top: 56px; left: 12px; width: 232px;
          padding: 10px 12px; pointer-events: auto;
          display: flex; flex-direction: column; gap: 6px;
        }
        @media (max-width: 760px) { .hud-mission { top: 96px; width: 200px; } }
        .hud-mission .mission-head {
          display: flex; justify-content: space-between; align-items: baseline; gap: 8px;
          font-weight: 600; color: #f0ede4;
        }
        #ui .hud-mission .mission-head button {
          border: none; background: transparent; color: #b6b3a6;
          font-size: 11.5px; padding: 0;
        }
        #ui .hud-mission .mission-head button:hover { color: #e5c469; background: transparent; }
        .hud-mission .objective {
          display: flex; align-items: baseline; gap: 8px;
          font-size: 12.5px; color: #cfccc2;
        }
        .hud-mission .objective .tick { width: 13px; flex: none; color: #6d6f68; }
        .hud-mission .objective.done { color: #8b8d84; text-decoration: line-through; }
        .hud-mission .objective.done .tick { color: #e5c469; text-decoration: none; }
        .hud-mission .hint {
          margin-top: 4px; padding-top: 8px;
          border-top: 1px solid rgba(255, 255, 255, 0.12);
          font-size: 12px; line-height: 1.45; color: #d8d4c6;
        }
        .hud-mission .hint-actions {
          display: flex; justify-content: space-between; align-items: center; gap: 8px;
        }
        #ui .hud-mission .hint-actions button { font-size: 11.5px; padding: 3px 10px; }
        #ui .hud-mission .hint-actions .mute {
          border: none; background: transparent; color: #8b8d84; padding: 3px 0;
        }
        #ui .hud-mission .hint-actions .mute:hover { color: #e5c469; background: transparent; }

        .hud-briefing p { white-space: pre-wrap; }
        .hud-briefing .mission-no { color: #b6b3a6; font-size: 12px; margin: 0 0 2px; }
      `}</style>

      {/* The commission, over a still valley: main.ts boots a fresh mission
          paused, and Begin starts the clock. Reopening it later (the ⟲ in
          the checklist head) leaves a running clock alone. */}
      <Show when={briefingOpen() && def()}>
        {(d) => (
          <div class="hud-end hud-briefing">
            <div class="panel end-card">
              <p class="mission-no">A commission from the crown</p>
              <h1>{d().title}</h1>
              <p>{d().briefing}</p>
              <button
                onClick={() => {
                  setBriefingOpen(false);
                  if (speed() === 0) props.onSpeed(1);
                }}
              >
                Begin
              </button>
            </div>
          </div>
        )}
      </Show>

      <Show when={def() && !briefingOpen()}>
        {(_) => (
          <div class="hud-mission panel">
            <div class="mission-head">
              <span>{def()!.title}</span>
              <button
                title="Read the commission again"
                onClick={() => setBriefingOpen(true)}
              >
                brief
              </button>
            </div>
            <For each={def()!.objectives}>
              {(o, i) => (
                <div class="objective" classList={{ done: mission()!.done[i()] === true }}>
                  <span class="tick">{mission()!.done[i()] ? '✓' : '○'}</span>
                  <span>{o.label}</span>
                </div>
              )}
            </For>
            <Show when={currentHint()}>
              {(hint) => (
                <div class="hint">
                  <div>{hint().step.text}</div>
                  <div class="hint-actions">
                    <Show when={hint().step.objective === undefined} fallback={<span />}>
                      <button onClick={() => setAcked(new Set([...acked(), hint().key]))}>
                        Got it
                      </button>
                    </Show>
                    <button class="mute" onClick={toggleHints}>
                      Hide hints
                    </button>
                  </div>
                </div>
              )}
            </Show>
          </div>
        )}
      </Show>
    </>
  );
}

/** The next commission, for the end card. */
export function continueTarget(): { id: string; title: string } | undefined {
  const m = mission();
  if (!m) return undefined;
  const next = nextMissionId(m.id);
  return next ? { id: next, title: MISSION_DEFS[next].title } : undefined;
}
