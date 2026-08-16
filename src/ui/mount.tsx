import { render } from 'solid-js/web';
import { Hud } from './Hud';
import { pushToast, setSpeed } from './store';
import { play } from '../audio/audio';
import type { BuildingTypeId } from '../sim/defs/buildings';
import type { SimHost } from '../app/simHost';

/** What the HUD needs from the app: selection actions from Controls (touch
 * has no shift/drag), and the save assembled where world and fog meet. */
export interface HudActions {
  selectArmy(): void;
  deselect(): void;
  /** Arm or disarm placement. Controls owns it, because dropping the mode
   * also has to take the ghost off the map. */
  place(type: BuildingTypeId | null): void;
  /** The full save string — the worker's world plus the fog's memory. */
  save(): Promise<string>;
  /** Write the match's replay log to OPFS; the saved name, or null when
   * there is nothing to save yet (the match is still undecided) or the
   * browser has no OPFS to write into. */
  saveReplay(): Promise<string | null>;
  /** Pan the camera to a tile — clickable toasts' "take me there". Sim
   * tile coords; the rig call maps tile y onto world z. */
  focus(x: number, y: number): void;
}

/**
 * Mount the Solid HUD into the overlay div. Solid never touches the canvas.
 * Returns the teardown: a match that ends in place has to take its HUD off
 * the glass, or the menu behind it would come up under a resource bar.
 *
 * Every HUD action funnels through this one file, which is why the click
 * sounds live here and not on 60-odd onClick handlers in the components:
 * one wrapper per action, and a new action cannot forget its sound.
 */
export function mountHud(host: SimHost, actions: HudActions): () => void {
  const root = document.getElementById('ui')!;
  return render(
    () => (
      <Hud
        onSelectArmy={() => {
          play('uiClick');
          actions.selectArmy();
        }}
        onDeselect={() => {
          play('uiClick');
          actions.deselect();
        }}
        onSpeed={(speed) => {
          play('uiClick');
          host.setSpeed(speed);
          setSpeed(speed);
        }}
        onPlace={(type) => {
          play('uiClick');
          actions.place(type);
        }}
        onHire={() => {
          play('uiCoin');
          host.sendCommands([{ kind: 'hireSerf' }]);
        }}
        onDismiss={(buildingId) => {
          play('uiClick');
          host.sendCommands([{ kind: 'dismissWorker', buildingId }]);
        }}
        onSell={(buildingId) => {
          play('uiCoin');
          host.sendCommands([{ kind: 'sellBuilding', buildingId }]);
        }}
        onRepair={(buildingId, repair) => {
          play('uiClick');
          host.sendCommands([{ kind: 'setBuildingRepair', buildingId, repair }]);
        }}
        onTogglePause={(buildingId, paused) => {
          play('uiClick');
          host.sendCommands([{ kind: 'setBuildingPaused', buildingId, paused }]);
        }}
        onSetRecipe={(buildingId, index) => {
          play('uiClick');
          host.sendCommands([{ kind: 'setBuildingRecipe', buildingId, index }]);
        }}
        onResearch={(tech) => {
          play('uiClick');
          host.sendCommands([{ kind: 'research', tech }]);
        }}
        onTrain={(buildingId, unit) => {
          play('uiClick');
          host.sendCommands([{ kind: 'trainUnit', buildingId, unit }]);
        }}
        onCancelTrain={(buildingId, index, unit) => {
          play('uiClick');
          host.sendCommands([{ kind: 'cancelTraining', buildingId, index, unit }]);
        }}
        onSave={() => {
          play('uiClick');
          void actions.save().then((data) => {
            localStorage.setItem('serf-save', data);
            pushToast('Game saved');
          });
        }}
        onSaveReplay={() => {
          play('uiClick');
          void actions.saveReplay().then((name) => {
            pushToast(name !== null ? `Replay saved — ${name}` : 'Replay could not be saved');
          });
        }}
        onAdmin={(action) => {
          play('uiClick');
          host.sendCommands([{ kind: 'admin', action }]);
        }}
        onFocus={(x, y) => {
          play('uiClick');
          actions.focus(x, y);
        }}
      />
    ),
    root,
  );
}
