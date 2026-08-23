import * as THREE from 'three';
import { GameRenderer } from '../render/renderer';
import {
  loadCharacterAssets,
  makeCharacter,
  playAnimation,
  setWorkTool,
  TOOL_STOWED,
  type AnimKey,
  type CharacterVisual,
} from '../render/characters';
import { worldToScreen } from '../input/picking';
import { grass } from '../render/palette';
import { UNIT_DEFS } from '../sim/defs/units';
import { WORK } from '../protocol/sabLayout';
import { unitName } from './names';
import { BANDIT } from '../sim/entities';
import { DEFAULT_MAP_SIZE as MAP_SIZE } from '../shared/grid';

/**
 * ?wardrobe — the costume fitting room. Every unit kind of every faction
 * stands in ranks on plain grass under the real game camera and lights,
 * with a label at their feet. No sim, no HUD; pan and zoom work.
 *
 * This page exists so wardrobe judgments are made against what the player
 * actually sees: the same tone mapping, the same sun, the same grass the
 * units must read against. Screenshots of this grid are how faction
 * coloring gets tuned.
 */

/** Grid spacing in tiles. Rows are factions, columns are unit kinds. */
const COL_SPACING = 2.4;
const ROW_SPACING = 3.4;

interface Column {
  code: number;
  profession: number;
  label: string;
  /** WORK.* this column performs in Work mode (tool + loop). */
  workKind?: number;
}

interface Row {
  owner: number;
  label: string;
}

function columns(): Column[] {
  const out: Column[] = [];
  for (const def of Object.values(UNIT_DEFS)) {
    if (def.id === 'worker') {
      // One column per trade: the profession looks (see PROF_LOOKS) plus
      // the work each performs in Work mode — tool in hand, proper loop.
      out.push({ code: def.kindCode, profession: 0, label: 'Builder', workKind: WORK.hammer });
      out.push({ code: def.kindCode, profession: 0, label: 'Woodcutter', workKind: WORK.chop });
      out.push({ code: def.kindCode, profession: 1, label: 'Farmer', workKind: WORK.dig });
      out.push({ code: def.kindCode, profession: 2, label: 'Miner', workKind: WORK.pickaxe });
      out.push({ code: def.kindCode, profession: 0, label: 'Fisher', workKind: WORK.fish });
    } else {
      out.push({ code: def.kindCode, profession: 0, label: unitName(def.id) });
    }
  }
  return out;
}

/** WORK.* byte -> tool loop, mirroring the game's own mapping (sceneSync). */
const WORK_ANIM: Record<number, AnimKey> = {
  [WORK.chop]: 'work',
  [WORK.pickaxe]: 'pickaxe',
  [WORK.hammer]: 'hammer',
  [WORK.dig]: 'dig',
  [WORK.tend]: 'tend',
  [WORK.draw]: 'draw',
  [WORK.fish]: 'fish',
};

type Mode = 'idle' | 'walk' | 'carry' | 'work' | 'death';
const MODES: Mode[] = ['idle', 'walk', 'carry', 'work', 'death'];

/** What this column performs in a given mode: villagers work their trade,
 * soldiers fight, serfs haul. */
function clipFor(mode: Mode, col: Column, v: CharacterVisual): AnimKey {
  switch (mode) {
    case 'walk':
      return v.gait;
    case 'work':
      if (col.workKind !== undefined) return WORK_ANIM[col.workKind] ?? 'work';
      if (col.code === 1) return 'carry'; // a serf's work is hauling
      return v.ranged ? 'shoot' : 'attack';
    default:
      return mode;
  }
}

const ROWS: Row[] = [
  { owner: 0, label: 'Player 1 · green' },
  { owner: 1, label: 'Player 2 · red' },
  { owner: 2, label: 'Player 3 · blue' },
  { owner: 3, label: 'Player 4 · gold' },
  { owner: BANDIT, label: 'Bandits · stock' },
];

function makeLabel(parent: HTMLElement, text: string, header = false): HTMLSpanElement {
  const el = document.createElement('span');
  el.textContent = text;
  el.style.position = 'absolute';
  el.style.transform = header ? 'translate(-100%, -50%)' : 'translate(-50%, 0)';
  el.style.font = `${header ? '600 13px' : '11px'} system-ui, sans-serif`;
  el.style.color = header ? '#f0ede4' : '#d8d4c8';
  el.style.textShadow = '0 1px 3px rgba(0,0,0,0.8)';
  el.style.whiteSpace = 'nowrap';
  parent.appendChild(el);
  return el;
}

export async function mountWardrobe(canvas: HTMLCanvasElement): Promise<{ dispose(): void }> {
  await loadCharacterAssets();
  const renderer = new GameRenderer(canvas);
  // Same console handles the game exposes — texture forensics and scripted
  // camera jumps (screenshot tooling) happen here.
  if (import.meta.env.DEV) {
    Object.assign(window as unknown as Record<string, unknown>, {
      __scene: renderer.scene,
      __rig: renderer.rig,
    });
  }

  // Plain valley grass underfoot — the exact background the tints must
  // survive against in play.
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(MAP_SIZE * 2, MAP_SIZE * 2),
    new THREE.MeshLambertMaterial({ color: grass }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.set(MAP_SIZE / 2, 0, MAP_SIZE / 2);
  ground.receiveShadow = true;
  renderer.scene.add(ground);

  const cols = columns();
  const startX = MAP_SIZE / 2 - ((cols.length - 1) * COL_SPACING) / 2;
  const startZ = MAP_SIZE / 2 - ((ROWS.length - 1) * ROW_SPACING) / 2;

  const overlay = document.createElement('div');
  overlay.style.position = 'absolute';
  overlay.style.inset = '0';
  overlay.style.overflow = 'hidden';
  overlay.style.pointerEvents = 'none';
  document.body.appendChild(overlay);

  const cast: { visual: CharacterVisual; col: Column; offset: number }[] = [];
  const labels: { el: HTMLSpanElement; x: number; y: number; z: number }[] = [];

  ROWS.forEach((row, r) => {
    const z = startZ + r * ROW_SPACING;
    labels.push({
      el: makeLabel(overlay, row.label, true),
      x: startX - 1.6,
      y: 0.6,
      z,
    });
    cols.forEach((col, c) => {
      const x = startX + c * COL_SPACING;
      const made = makeCharacter(col.code, col.profession, row.owner);
      if (!made) return;
      // Quarter-turn toward the fixed camera so faces and tabards show.
      made.group.rotation.y = Math.PI * 0.25;
      made.group.position.set(x, 0, z);
      renderer.scene.add(made.group);
      const offset = r * 1.7 + c * 0.6;
      playAnimation(made.visual, 'idle', offset);
      cast.push({ visual: made.visual, col, offset });
      if (r === 0) {
        labels.push({ el: makeLabel(overlay, col.label), x, y: 0, z: z - 1.1 });
      }
    });
  });

  renderer.rig.focusOn(MAP_SIZE / 2, MAP_SIZE / 2);

  // The move bar: play the whole cast through one animation at a time.
  const bar = document.createElement('div');
  bar.style.cssText =
    'position:absolute;left:50%;bottom:14px;transform:translateX(-50%);' +
    'display:flex;gap:6px;pointer-events:auto;background:rgba(20,16,10,0.75);' +
    'padding:6px 8px;border-radius:8px';
  overlay.appendChild(bar);
  const setMode = (mode: Mode): void => {
    for (const { visual, col, offset } of cast) {
      // Work and the walk to it carry the trade's tool (matching the
      // game's rule), carrying stows everything — the hands are full —
      // and idle shows the standing kit.
      setWorkTool(
        visual,
        mode === 'work' || mode === 'walk'
          ? (col.workKind ?? 0)
          : mode === 'carry'
            ? TOOL_STOWED
            : 0,
      );
      playAnimation(visual, clipFor(mode, col, visual), offset);
    }
    for (const b of bar.children as HTMLCollectionOf<HTMLButtonElement>) {
      b.style.background = b.textContent === mode ? '#e5c469' : 'transparent';
      b.style.color = b.textContent === mode ? '#241d12' : '#f0ede4';
    }
  };
  for (const mode of MODES) {
    const b = document.createElement('button');
    b.textContent = mode;
    b.style.cssText =
      'font:600 12px system-ui;border:none;border-radius:5px;padding:5px 12px;' +
      'cursor:pointer;background:transparent;color:#f0ede4;text-transform:capitalize';
    b.onclick = () => setMode(mode);
    bar.appendChild(b);
  }
  setMode('idle');

  // `over` guards the re-schedule, not just the pending handle: a dispose
  // that runs re-entrantly while a frame is executing would otherwise be
  // followed by that frame scheduling one more tick against a disposed
  // renderer — the same reason the match's teardown carries its own flag.
  let over = false;
  let raf = 0;
  const loop = (): void => {
    if (over) return;
    const dt = renderer.frame();
    for (const { visual } of cast) visual.mixer.update(dt);
    for (const l of labels) {
      const p = worldToScreen(renderer.rig.camera, canvas, l.x, l.y, l.z);
      l.el.style.left = `${p.x}px`;
      l.el.style.top = `${p.y}px`;
    }
    if (!over) raf = requestAnimationFrame(loop);
  };
  raf = requestAnimationFrame(loop);

  // The router navigates in one document, so this screen ends by being
  // taken apart, not by the page dying: without a dispose, the rAF loop
  // rendered on, the overlay (and its click-taking move bar) sat over
  // whatever screen came next, and the canvas's one-per-lifetime WebGL
  // context stayed spent — the next match would build a renderer against
  // a dead context. Same order as the editor's teardown: the renderer
  // lets go (context loss included), then the canvas element is replaced
  // so the next screen gets a fresh context. Each step wears its own
  // guard, as the match teardown does: the canvas swap is what keeps the
  // next screen off this spent context, and it must run even if the
  // renderer refuses to die quietly.
  return {
    dispose(): void {
      over = true;
      cancelAnimationFrame(raf);
      for (const step of [
        (): void => overlay.remove(),
        (): void => renderer.dispose(),
        (): void => canvas.replaceWith(canvas.cloneNode(false)),
      ]) {
        try {
          step();
        } catch (err) {
          console.warn('[wardrobe] teardown step failed:', err);
        }
      }
    },
  };
}
