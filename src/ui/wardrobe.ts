import * as THREE from 'three';
import { GameRenderer } from '../render/renderer';
import {
  loadCharacterAssets,
  makeCharacter,
  playAnimation,
  type CharacterVisual,
} from '../render/characters';
import { worldToScreen } from '../input/picking';
import { palette } from '../render/palette';
import { UNIT_DEFS } from '../sim/defs/units';
import { unitName } from './names';
import { BANDIT } from '../sim/entities';
import { MAP_SIZE } from '../shared/grid';

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
}

interface Row {
  owner: number;
  label: string;
}

function columns(): Column[] {
  const out: Column[] = [];
  for (const def of Object.values(UNIT_DEFS)) {
    out.push({ code: def.kindCode, profession: 0, label: unitName(def.id) });
    if (def.id === 'worker') {
      // The workplace looks layered over the worker kind (see PROF_LOOKS).
      out.push({ code: def.kindCode, profession: 1, label: 'Farmer' });
      out.push({ code: def.kindCode, profession: 2, label: 'Miner' });
    }
  }
  return out;
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

export async function mountWardrobe(canvas: HTMLCanvasElement): Promise<void> {
  await loadCharacterAssets();
  const renderer = new GameRenderer(canvas);
  // Same console handle the game exposes — texture forensics happen here.
  if (import.meta.env.DEV) {
    Object.assign(window as unknown as Record<string, unknown>, { __scene: renderer.scene });
  }

  // Plain valley grass underfoot — the exact background the tints must
  // survive against in play.
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(MAP_SIZE * 2, MAP_SIZE * 2),
    new THREE.MeshLambertMaterial({ color: palette.grass }),
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

  const visuals: CharacterVisual[] = [];
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
      playAnimation(made.visual, 'idle', r * 1.7 + c * 0.6);
      visuals.push(made.visual);
      if (r === 0) {
        labels.push({ el: makeLabel(overlay, col.label), x, y: 0, z: z - 1.1 });
      }
    });
  });

  renderer.rig.focusOn(MAP_SIZE / 2, MAP_SIZE / 2);

  const loop = (): void => {
    const dt = renderer.frame();
    for (const v of visuals) v.mixer.update(dt);
    for (const l of labels) {
      const p = worldToScreen(renderer.rig.camera, canvas, l.x, l.y, l.z);
      l.el.style.left = `${p.x}px`;
      l.el.style.top = `${p.y}px`;
    }
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}
