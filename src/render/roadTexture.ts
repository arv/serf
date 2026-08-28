import * as THREE from 'three';
import {stoneRoad} from './palette';

/** Stone courses across one texture repeat; a repeat spans two map tiles. */
const COURSES = 8;
const SIZE = 256;

/**
 * A tileable paving texture: irregular flagstones in running bond, set in
 * dark mortar, each stone its own shade of the road grey with a lit top edge
 * and a shaded bottom one. Hand-drawn on a canvas at boot like the rest of
 * the generated textures, so a paved road reads as laid masonry rather than
 * a grey stripe.
 */
export function makeCobbleTexture(): THREE.Texture {
  const canvas = document.createElement('canvas');
  canvas.width = SIZE;
  canvas.height = SIZE;
  const ctx = canvas.getContext('2d')!;
  const base = new THREE.Color(stoneRoad);

  // Mortar: the gaps between stones, and what shows through chipped corners.
  const mortar = base.clone().multiplyScalar(0.52);
  ctx.fillStyle = `#${mortar.getHexString()}`;
  ctx.fillRect(0, 0, SIZE, SIZE);

  const cell = SIZE / COURSES;
  const gap = cell * 0.09;
  const shade = new THREE.Color();

  /** One stone, drawn wrapped so the texture tiles seamlessly. */
  const stone = (
    cx: number,
    cy: number,
    w: number,
    h: number,
    tone: number,
    r: number,
  ): void => {
    for (const dx of [-SIZE, 0, SIZE]) {
      for (const dy of [-SIZE, 0, SIZE]) {
        const x = cx + dx;
        const y = cy + dy;
        if (
          x + w < -cell ||
          x > SIZE + cell ||
          y + h < -cell ||
          y > SIZE + cell
        )
          continue;
        // Body.
        shade.copy(base).multiplyScalar(tone);
        ctx.fillStyle = `#${shade.getHexString()}`;
        roundRect(ctx, x, y, w, h, r);
        ctx.fill();
        // Sun catches the top edge, the bottom sinks into its own shadow.
        ctx.strokeStyle = `rgba(255,255,255,0.16)`;
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        ctx.moveTo(x + r, y + 1);
        ctx.lineTo(x + w - r, y + 1);
        ctx.stroke();
        ctx.strokeStyle = `rgba(0,0,0,0.22)`;
        ctx.beginPath();
        ctx.moveTo(x + r, y + h - 1);
        ctx.lineTo(x + w - r, y + h - 1);
        ctx.stroke();
      }
    }
  };

  for (let row = 0; row < COURSES; row++) {
    // Running bond: every other course starts half a stone over, and the
    // courses themselves drift a little so nothing lines up perfectly.
    const offset =
      (row % 2 ? cell * 0.5 : 0) + (Math.random() - 0.5) * cell * 0.2;
    let x = offset - cell;
    while (x < SIZE + cell) {
      // Stone lengths vary; now and then two courses' worth of a long slab.
      const w = cell * (0.62 + Math.random() * 0.7);
      const y = row * cell;
      const tone = 0.86 + Math.random() * 0.3;
      stone(x + gap, y + gap, w - gap * 2, cell - gap * 2, tone, cell * 0.13);
      x += w;
    }
  }

  // Grit and wear over the whole surface, so the stones aren't glassy.
  for (let i = 0; i < 2600; i++) {
    const x = Math.random() * SIZE;
    const y = Math.random() * SIZE;
    const light = Math.random() < 0.4;
    ctx.fillStyle = light ? 'rgba(255,255,255,0.07)' : 'rgba(0,0,0,0.09)';
    ctx.fillRect(x, y, 1 + Math.random() * 1.6, 1 + Math.random() * 1.6);
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.anisotropy = 8;
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
