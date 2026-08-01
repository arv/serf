import { render } from 'solid-js/web';
import { Hud } from './Hud';
import { pushToast, setPlacing, setSpeed } from './store';
import type { SimHost } from '../app/simHost';

/** What the HUD needs from the app: selection actions from Controls (touch
 * has no shift/drag), and the save assembled where world and fog meet. */
export interface HudActions {
  selectArmy(): void;
  deselect(): void;
  /** The full save string — the worker's world plus the fog's memory. */
  save(): Promise<string>;
}

/** Mount the Solid HUD into the overlay div. Solid never touches the canvas. */
export function mountHud(host: SimHost, actions: HudActions): void {
  const root = document.getElementById('ui')!;
  render(
    () => (
      <Hud
        onSelectArmy={() => actions.selectArmy()}
        onDeselect={() => actions.deselect()}
        onSpeed={(speed) => {
          host.setSpeed(speed);
          setSpeed(speed);
        }}
        onPlace={(type) => setPlacing(type)}
        onHire={() => host.sendCommands([{ kind: 'hireSerf' }])}
        onDismiss={(buildingId) => host.sendCommands([{ kind: 'dismissWorker', buildingId }])}
        onSell={(buildingId) => host.sendCommands([{ kind: 'sellBuilding', buildingId }])}
        onResearch={(tech) => host.sendCommands([{ kind: 'research', tech }])}
        onTrain={(buildingId, unit) =>
          host.sendCommands([{ kind: 'trainUnit', buildingId, unit }])
        }
        onSave={() => {
          void actions.save().then((data) => {
            localStorage.setItem('serf-save', data);
            pushToast('Game saved');
          });
        }}
        onAdmin={(action) => host.sendCommands([{ kind: 'admin', action }])}
      />
    ),
    root,
  );
}
