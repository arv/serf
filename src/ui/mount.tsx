import {render} from 'solid-js/web';
import {saveGameNow} from '../app/saveStore';
import type {SimHost} from '../app/simHost';
import {play} from '../audio/audio';
import * as CommandKind from '../sim/commandKindEnum.ts';
import type {BuildingTypeId} from '../sim/defs/buildings';
import {Hud} from './Hud';
import type {MinimapSource} from './Minimap';
import {pushToast, setSpeed, type OrderMode} from './store';

/** What the HUD needs from the app: selection actions from Controls (touch
 * has no shift/drag), and the save assembled where world and fog meet. */
export interface HudActions {
  selectArmy(): void;
  deselect(): void;
  /** Arm or disarm placement. Controls owns it, because dropping the mode
   * also has to take the ghost off the map. */
  place(type: BuildingTypeId | null): void;
  /** Arm or disarm an order waiting for its target — the A/M shortcuts'
   * other half. Controls owns it because arming one mode has to disarm the
   * others: placement and an order both claim the next click, and two
   * things claiming one click is one of them losing silently. */
  armOrder(mode: OrderMode | null): void;
  /** The full save string — the worker's world plus the fog's memory,
   * under the metadata head the saves shelf lists it by. */
  save(): Promise<string>;
  /** Write the match's replay log to OPFS; the saved name, or null when
   * there is nothing to save yet (the match is still undecided) or the
   * browser has no OPFS to write into. */
  saveReplay(): Promise<string | null>;
  /** Pan the camera to a tile — clickable toasts' "take me there". Sim
   * tile coords; the rig call maps tile y onto world z. */
  focus(x: number, y: number): void;
  /** The minimap's live handles — mirror, fog, units, camera — bundled
   * where they all exist. Not an action, but it travels the same road:
   * this is the one door the app hands things to the HUD through. */
  minimap: MinimapSource;
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
        onSpeed={speed => {
          play('uiClick');
          host.setSpeed(speed);
          setSpeed(speed);
        }}
        onPlace={type => {
          play('uiClick');
          actions.place(type);
        }}
        onArmOrder={mode => {
          play('uiClick');
          actions.armOrder(mode);
        }}
        onClearRally={buildingId => {
          play('uiClick');
          // No coordinates is the take-the-flag-down spelling; planting one
          // needs a map click and goes through Controls instead.
          host.sendCommands([{kind: CommandKind.setRallyPoint, buildingId}]);
        }}
        onHire={() => {
          play('uiCoin');
          host.sendCommands([{kind: CommandKind.hireSerf}]);
        }}
        onSell={buildingId => {
          play('uiCoin');
          host.sendCommands([{kind: CommandKind.sellBuilding, buildingId}]);
        }}
        onRepair={(buildingId, repair) => {
          play('uiClick');
          host.sendCommands([
            {kind: CommandKind.setBuildingRepair, buildingId, repair},
          ]);
        }}
        onTogglePause={(buildingId, paused) => {
          play('uiClick');
          host.sendCommands([
            {kind: CommandKind.setBuildingPaused, buildingId, paused},
          ]);
        }}
        onSetRecipe={(buildingId, index) => {
          play('uiClick');
          host.sendCommands([
            {kind: CommandKind.setBuildingRecipe, buildingId, index},
          ]);
        }}
        onEnqueueForge={(buildingId, recipeIndex) => {
          play('uiClick');
          host.sendCommands([
            {kind: CommandKind.enqueueForge, buildingId, recipeIndex},
          ]);
        }}
        onCancelForge={(buildingId, index, recipeIndex) => {
          play('uiClick');
          host.sendCommands([
            {kind: CommandKind.cancelForge, buildingId, index, recipeIndex},
          ]);
        }}
        onResearch={tech => {
          play('uiClick');
          host.sendCommands([{kind: CommandKind.research, tech}]);
        }}
        onTrain={(buildingId, unit) => {
          play('uiClick');
          host.sendCommands([{kind: CommandKind.trainUnit, buildingId, unit}]);
        }}
        onCancelTrain={(buildingId, index, unit) => {
          play('uiClick');
          host.sendCommands([
            {kind: CommandKind.cancelTraining, buildingId, index, unit},
          ]);
        }}
        onSave={() => {
          play('uiClick');
          // A file per save, named by the clock, exactly like a replay:
          // saving no longer overwrites the one slot there used to be, and
          // the start menu's shelf is where they are picked from again.
          // Every path ends in a toast, the thrown one included: a save
          // is a promise the player made to themselves, and silence is
          // the one answer that leaves them thinking the village is
          // filed when it is not.
          void actions
            .save()
            .then(data => saveGameNow(data))
            .then(name => {
              pushToast(
                name !== null
                  ? `Village saved — ${name}`
                  : 'The village could not be saved',
              );
            })
            .catch(() => pushToast('The village could not be saved'));
        }}
        onSaveReplay={() => {
          play('uiClick');
          void actions
            .saveReplay()
            .then(name => {
              pushToast(
                name !== null
                  ? `Replay saved — ${name}`
                  : 'Replay could not be saved',
              );
            })
            .catch(() => pushToast('Replay could not be saved'));
        }}
        onAdmin={action => {
          play('uiClick');
          host.sendCommands([{kind: CommandKind.admin, action}]);
        }}
        onFocus={(x, y) => {
          play('uiClick');
          actions.focus(x, y);
        }}
        minimap={actions.minimap}
      />
    ),
    root,
  );
}
