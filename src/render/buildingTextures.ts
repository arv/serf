import * as THREE from 'three';
import { canvasTexture } from './spriteTextures';

/**
 * Painted architecture textures, generated once at boot. The look is
 * hand-painted surfaces: scalloped tile roofs, weathered planks, mottled
 * plaster, straw thatch — chunky, saturated, no photorealism.
 */

const cache = new Map<string, THREE.Texture>();

function cached(key: string, make: () => THREE.Texture): THREE.Texture {
  let t = cache.get(key);
  if (!t) {
    t = make();
    t.wrapS = THREE.RepeatWrapping;
    t.wrapT = THREE.RepeatWrapping;
    t.anisotropy = 4;
    cache.set(key, t);
  }
  return t;
}

function shade(hex: string, f: number): string {
  const n = parseInt(hex.slice(1), 16);
  const r = Math.min(255, Math.round(((n >> 16) & 255) * f));
  const g = Math.min(255, Math.round(((n >> 8) & 255) * f));
  const b = Math.min(255, Math.round((n & 255) * f));
  return `rgb(${r},${g},${b})`;
}

/** Overlapping scalloped tile rows — the stylized roof signature. */
export function roofTiles(base: string): THREE.Texture {
  return cached(`roof:${base}`, () =>
    canvasTexture(128, (ctx) => {
      ctx.fillStyle = base;
      ctx.fillRect(0, 0, 128, 128);
      const rows = 6;
      const rowH = 128 / rows;
      for (let r = 0; r < rows; r++) {
        const y = r * rowH;
        const offset = (r % 2) * 10;
        for (let c = -1; c < 7; c++) {
          const x = c * 20 + offset;
          const tone = 0.82 + Math.random() * 0.4;
          ctx.fillStyle = shade(base, tone);
          ctx.fillRect(x + 1, y, 18, rowH - 1);
          // Scalloped lower edge of each tile.
          ctx.fillStyle = 'rgba(30, 14, 6, 0.5)';
          ctx.beginPath();
          ctx.ellipse(x + 10, y + rowH - 1, 9, 3.4, 0, 0, Math.PI);
          ctx.fill();
          // Highlight at the tile crown.
          ctx.fillStyle = 'rgba(255, 230, 180, 0.16)';
          ctx.fillRect(x + 2, y + 1, 16, 2);
        }
        // Row shadow line.
        ctx.fillStyle = 'rgba(25, 10, 5, 0.55)';
        ctx.fillRect(0, y + rowH - 1.5, 128, 1.5);
      }
    }),
  );
}

/** Vertical wood planks with seams, grain, and nail dots. */
export function planks(base: string): THREE.Texture {
  return cached(`planks:${base}`, () =>
    canvasTexture(128, (ctx) => {
      ctx.fillStyle = base;
      ctx.fillRect(0, 0, 128, 128);
      const plankW = 16;
      for (let p = 0; p < 8; p++) {
        const x = p * plankW;
        ctx.fillStyle = shade(base, 0.85 + Math.random() * 0.35);
        ctx.fillRect(x + 1, 0, plankW - 2, 128);
        // Seam.
        ctx.fillStyle = 'rgba(20, 10, 4, 0.6)';
        ctx.fillRect(x, 0, 1.5, 128);
        // Grain streaks.
        for (let g = 0; g < 5; g++) {
          const gx = x + 3 + Math.random() * (plankW - 6);
          ctx.strokeStyle = `rgba(30, 16, 6, ${0.12 + Math.random() * 0.15})`;
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(gx, Math.random() * 30);
          ctx.bezierCurveTo(gx + 2, 45, gx - 2, 80, gx + 1, 128);
          ctx.stroke();
        }
        // Nails at top and bottom.
        ctx.fillStyle = 'rgba(15, 8, 3, 0.8)';
        for (const ny of [8, 120]) {
          ctx.beginPath();
          ctx.arc(x + plankW / 2, ny, 1.6, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }),
  );
}

/** Mottled plaster with a faint horizontal timber shadow. */
export function plaster(base: string): THREE.Texture {
  return cached(`plaster:${base}`, () =>
    canvasTexture(128, (ctx) => {
      ctx.fillStyle = base;
      ctx.fillRect(0, 0, 128, 128);
      for (let i = 0; i < 260; i++) {
        const x = Math.random() * 128;
        const y = Math.random() * 128;
        const r = 2 + Math.random() * 7;
        const light = Math.random() < 0.5;
        ctx.fillStyle = light
          ? `rgba(255, 250, 235, ${0.04 + Math.random() * 0.05})`
          : `rgba(90, 70, 40, ${0.04 + Math.random() * 0.06})`;
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fill();
      }
      // Weather stains bleeding from the top.
      for (let i = 0; i < 8; i++) {
        const x = Math.random() * 128;
        ctx.fillStyle = 'rgba(96, 76, 46, 0.08)';
        ctx.fillRect(x, 0, 2 + Math.random() * 3, 24 + Math.random() * 40);
      }
    }),
  );
}

/** Straw thatch: dense vertical strokes with binding bands. */
export function thatch(base: string): THREE.Texture {
  return cached(`thatch:${base}`, () =>
    canvasTexture(128, (ctx) => {
      ctx.fillStyle = base;
      ctx.fillRect(0, 0, 128, 128);
      for (let i = 0; i < 900; i++) {
        const x = Math.random() * 128;
        const y = Math.random() * 128;
        const len = 6 + Math.random() * 14;
        const light = Math.random() < 0.45;
        ctx.strokeStyle = light
          ? `rgba(235, 210, 140, ${0.16 + Math.random() * 0.2})`
          : `rgba(70, 50, 20, ${0.14 + Math.random() * 0.18})`;
        ctx.lineWidth = 1 + Math.random();
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x + (Math.random() - 0.5) * 3, y + len);
        ctx.stroke();
      }
      // Horizontal binding bands.
      for (const y of [40, 88]) {
        ctx.fillStyle = 'rgba(60, 40, 16, 0.5)';
        ctx.fillRect(0, y, 128, 3);
        ctx.fillStyle = 'rgba(240, 215, 150, 0.25)';
        ctx.fillRect(0, y + 3, 128, 1);
      }
    }),
  );
}

/** Irregular stone blocks for plinths and wells. */
export function stoneBlocks(base: string): THREE.Texture {
  return cached(`stone:${base}`, () =>
    canvasTexture(128, (ctx) => {
      ctx.fillStyle = shade(base, 0.6);
      ctx.fillRect(0, 0, 128, 128);
      const rows = 4;
      const rowH = 128 / rows;
      for (let r = 0; r < rows; r++) {
        const offset = (r % 2) * 18;
        for (let c = -1; c < 5; c++) {
          const x = c * 34 + offset;
          const w = 30 + Math.random() * 4;
          const h = rowH - 3 - Math.random() * 2;
          ctx.fillStyle = shade(base, 0.85 + Math.random() * 0.35);
          ctx.beginPath();
          ctx.roundRect(x + 1, r * rowH + 1, w, h, 4);
          ctx.fill();
          ctx.fillStyle = 'rgba(255, 250, 235, 0.1)';
          ctx.fillRect(x + 3, r * rowH + 2, w - 6, 2);
        }
      }
    }),
  );
}

/** Texture clone with its own repeat (textures share images, not settings). */
export function repeated(texture: THREE.Texture, x: number, y: number): THREE.Texture {
  const key = `${texture.uuid}:${x}:${y}`;
  let t = cache.get(key);
  if (!t) {
    t = texture.clone();
    t.repeat.set(x, y);
    cache.set(key, t);
  }
  return t;
}
