import {render} from 'solid-js/web';
import {saveGameNow} from '../app/saveStore';
import type {SimHost} from '../app/simHost';
import {play} from '../audio/audio';
import * as CommandKind from '../sim/commandKindEnum.ts';
import type {BuildingTypeId} from '../sim/defs/buildings';
import {Hud} from './Hud';
import type {MinimapSource} from './Minimap';
import {applySpeed} from './speedControl';
import {pushToast, replayMode, type OrderMode} from './store';

/** What the HUD needs from the app: selection actions from Controls (touch
 * has no shift/drag), and the save assembled where world and fog meet. */
export interface HudActions {
  selectArmy(): void;
  deselect(): void;
  /** A face on the selection card: pick that one out of the band, or —
   * with shift — drop him from it. Controls owns it for the same reason
   * the map's click is its: the selection and the building card are one
   * either/or, and only Controls holds both. */
  pickUnit(id: number, additive: boolean): void;
  /** Arm or disarm placement. Controls owns it, because dropping the mode
   * also has to take the ghost off the map. */
  place(type: BuildingTypeId | null): void;
  /** Arm or disarm an order waiting for its target — the A/M shortcuts'
   * other half. Controls owns it because arming one mode has to disarm the
   * others: placement and an order both claim the next click, and two
   * things claiming one click is one of them losing silently. */
  armOrder(mode: OrderMode | null): void;
  /** Hold ground: the selected soldiers stop where they stand. Sent on
   * the spot rather than armed — there is no click to wait for — and
   * Controls owns it because the selection is its, and because sending
   * it has to disarm an A or M still waiting for a target. */
  holdGround(): void;
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
  /**
   * An order off a card: the click's sound, then the command — or, while a
   * recording plays, neither. The cards already keep a replay's clicks
   * from landing (every order row is inert, and selectionOrders.lint.test
   * holds them to it; the tech tree declines its own), so this is the
   * second line: a click that somehow arrived would still make no sound
   * and post nothing. The worker drops a replay's commands regardless —
   * what this guards is the interface claiming an order was taken.
   */
  const order = (
    sound: 'uiClick' | 'uiCoin',
    commands: Parameters<SimHost['sendCommands']>[0],
  ): void => {
    if (replayMode()) return;
    play(sound);
    host.sendCommands(commands);
  };
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
        // The one action here with no play() of its own, and
        // deliberately: selecting people already has a sound, made where
        // the selection changes rather than where the click lands
        // (Controls' #setSel plays uiSelect for a band that grew). A
        // uiClick on top would make picking a knight off the card louder
        // than picking the same knight off the ground, for the same act.
        onPickUnit={(id, additive) => actions.pickUnit(id, additive)}
        // The one action not spelled out here, click sound and all: the
        // keyboard walks the same gears (+ and −), so the writes a speed
        // change makes live in ui/speedControl.ts, where the key handler
        // can reach them too.
        onSpeed={speed => applySpeed(host, speed)}
        onPlace={type => {
          play('uiClick');
          actions.place(type);
        }}
        onArmOrder={mode => {
          // The gate order() keeps, for the same reason: a recording arms
          // nothing, and a lit Rally button over it would say otherwise.
          if (replayMode()) return;
          play('uiClick');
          actions.armOrder(mode);
        }}
        // No uiClick here: the order itself confirms with the ring and
        // the order sound, the way a click on the map does — a click
        // sound on top would make the button louder than the key.
        onHold={() => actions.holdGround()}
        // No coordinates is the take-the-flag-down spelling; planting one
        // needs a map click and goes through Controls instead.
        onClearRally={buildingId =>
          order('uiClick', [{kind: CommandKind.setRallyPoint, buildingId}])
        }
        onHire={() => order('uiCoin', [{kind: CommandKind.hireSerf}])}
        // The coin sound both ways: the silver comes back.
        onCancelHire={index =>
          order('uiCoin', [{kind: CommandKind.cancelHire, index}])
        }
        onSell={buildingId =>
          order('uiCoin', [{kind: CommandKind.sellBuilding, buildingId}])
        }
        onRepair={(buildingId, repair) =>
          order('uiClick', [
            {kind: CommandKind.setBuildingRepair, buildingId, repair},
          ])
        }
        onTogglePause={(buildingId, paused) =>
          order('uiClick', [
            {kind: CommandKind.setBuildingPaused, buildingId, paused},
          ])
        }
        onSetRecipe={(buildingId, index) =>
          order('uiClick', [
            {kind: CommandKind.setBuildingRecipe, buildingId, index},
          ])
        }
        onEnqueueForge={(buildingId, recipeIndex) =>
          order('uiClick', [
            {kind: CommandKind.enqueueForge, buildingId, recipeIndex},
          ])
        }
        onCancelForge={(buildingId, index, recipeIndex) =>
          order('uiClick', [
            {kind: CommandKind.cancelForge, buildingId, index, recipeIndex},
          ])
        }
        onResearch={tech =>
          order('uiClick', [{kind: CommandKind.research, tech}])
        }
        onTrain={(buildingId, unit) =>
          order('uiClick', [{kind: CommandKind.trainUnit, buildingId, unit}])
        }
        onCancelTrain={(buildingId, index, unit) =>
          order('uiClick', [
            {kind: CommandKind.cancelTraining, buildingId, index, unit},
          ])
        }
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
