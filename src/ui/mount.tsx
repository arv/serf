import { render } from 'solid-js/web';
import { Hud } from './Hud';
import { pushToast, setPlacing, setSpeed } from './store';
import type { SimHost } from '../app/simHost';

/** Selection actions the HUD needs from Controls (touch has no shift/drag). */
export interface SelectionActions {
  selectArmy(): void;
  deselect(): void;
}

/** Mount the Solid HUD into the overlay div. Solid never touches the canvas. */
export function mountHud(host: SimHost, actions: SelectionActions): void {
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
        onResearch={(tech) => host.sendCommands([{ kind: 'research', tech }])}
        onTrain={(buildingId, unit) =>
          host.sendCommands([{ kind: 'trainUnit', buildingId, unit }])
        }
        onSave={() => {
          void host.requestSave().then((data) => {
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
