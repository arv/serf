import type { AdminAction } from '../sim/commands';
import { TextTip, tooltip } from './tooltip';
import { adminState, techs } from './store';

/**
 * Sandbox controls for tweaking the game, shown only with ?admin in the URL.
 * Every button is an ordinary sim command, so effects are saved like
 * everything else.
 */
export function AdminPanel(props: { onAdmin: (action: AdminAction) => void }) {
  return (
    <div class="admin-panel panel">
      <style>{`
        .admin-panel {
          position: absolute; top: 10px; left: 10px; padding: 8px 10px 10px;
          pointer-events: auto; display: flex; flex-direction: column; gap: 5px;
          border-color: #c8735a;
        }
        .admin-panel h4 {
          margin: 0 0 2px; font-size: 12px; color: #d98a6a;
          font-family: Georgia, 'Times New Roman', serif;
          font-variant: small-caps; letter-spacing: 0.1em;
        }
        .admin-panel button { text-align: left; font-size: 11px; padding: 4px 8px; }
        .admin-panel .on { color: #9fb06a; }
        .admin-panel .off { color: #c86a5a; }
      `}</style>
      <h4>Admin</h4>
      <button
        {...tooltip(() => (
          <TextTip title="Raids" body="Turn bandit waves on or off. Off = peaceful sandbox." />
        ))}
        onClick={() => props.onAdmin('toggleRaids')}
      >
        Raids: <span class={adminState().raidsEnabled ? 'on' : 'off'}>
          {adminState().raidsEnabled ? 'on' : 'off'}
        </span>
      </button>
      <button
        {...tooltip(() => (
          <TextTip title="Clear bandits" body="Kill every bandit on the map right now (the camp stays)." />
        ))}
        onClick={() => props.onAdmin('clearBandits')}
      >
        Clear bandits
      </button>
      <button
        {...tooltip(() => (
          <TextTip title="Grant goods" body="+25 of every good into the storehouse." />
        ))}
        onClick={() => props.onAdmin('grantGoods')}
      >
        +25 all goods
      </button>
      <button
        {...tooltip(() => (
          <TextTip
            title="Instant build"
            body="Sites need no materials and finish immediately."
          />
        ))}
        onClick={() => props.onAdmin('toggleInstantBuild')}
      >
        Instant build: <span class={adminState().instantBuild ? 'on' : 'off'}>
          {adminState().instantBuild ? 'on' : 'off'}
        </span>
      </button>
      <button
        {...tooltip(() => (
          <TextTip title="Finish research" body="Complete the tech currently being researched." />
        ))}
        disabled={!techs().active}
        onClick={() => props.onAdmin('finishResearch')}
      >
        Finish research
      </button>
    </div>
  );
}
