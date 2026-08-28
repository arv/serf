import type {Enum} from '../shared/enum.ts';
import * as AdminAction from '../sim/adminActionEnum.ts';
import {adminState, fogEnabled, setFogEnabled, techs} from './store';
import {TextTip, tooltip} from './tooltip';

type AdminAction = Enum<typeof AdminAction>;

/**
 * Sandbox controls for tweaking the game, shown only with ?admin in the URL.
 * Nearly every button is an ordinary sim command, so effects are saved like
 * everything else; fog of war is the exception, being a view over the world
 * rather than part of it (see the store).
 */
export function AdminPanel(props: {onAdmin: (action: AdminAction) => void}) {
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
          <TextTip
            title="Raids"
            body="Turn bandit waves on or off. Off = peaceful sandbox."
          />
        ))}
        onClick={() => props.onAdmin(AdminAction.toggleRaids)}
      >
        Raids:{' '}
        <span class={adminState().raidsEnabled ? 'on' : 'off'}>
          {adminState().raidsEnabled ? 'on' : 'off'}
        </span>
      </button>
      <button
        {...tooltip(() => (
          <TextTip
            title="Clear bandits"
            body="Kill every bandit on the map right now (the camp stays)."
          />
        ))}
        onClick={() => props.onAdmin(AdminAction.clearBandits)}
      >
        Clear bandits
      </button>
      <button
        {...tooltip(() => (
          <TextTip
            title="Grant goods"
            body="+25 of every good into the storehouse."
          />
        ))}
        onClick={() => props.onAdmin(AdminAction.grantGoods)}
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
        onClick={() => props.onAdmin(AdminAction.toggleInstantBuild)}
      >
        Instant build:{' '}
        <span class={adminState().instantBuild ? 'on' : 'off'}>
          {adminState().instantBuild ? 'on' : 'off'}
        </span>
      </button>
      <button
        {...tooltip(() => (
          <TextTip
            title="Fog of war"
            body="Off reveals the whole map. Render-only — what you have explored is remembered while it is off."
          />
        ))}
        onClick={() => setFogEnabled(!fogEnabled())}
      >
        Fog of war:{' '}
        <span class={fogEnabled() ? 'on' : 'off'}>
          {fogEnabled() ? 'on' : 'off'}
        </span>
      </button>
      <button
        {...tooltip(() => (
          <TextTip
            title="Finish research"
            body="Complete the tech currently being researched."
          />
        ))}
        disabled={!techs().active}
        onClick={() => props.onAdmin(AdminAction.finishResearch)}
      >
        Finish research
      </button>
      <button
        {...tooltip(() => (
          <TextTip
            title="Spawn parade"
            body="One of each unit kind by the storehouse — for eyeballing models and animations."
          />
        ))}
        onClick={() => props.onAdmin(AdminAction.spawnParade)}
      >
        Spawn parade
      </button>
    </div>
  );
}
