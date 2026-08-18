import * as THREE from 'three';

/**
 * Hand-"painted" vegetation sprites, drawn on canvases at boot. Alpha-tested
 * quads with these textures are the classic way stylized RTS games got lush
 * vegetation: chunky silhouettes, saturated gradients, zero photorealism.
 */

export function canvasTexture(
  size: number,
  draw: (ctx: CanvasRenderingContext2D) => void,
): THREE.Texture {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  draw(ctx);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}

/** A tapered blade painted as a filled bezier wedge with a lighter tip. */
function blade(
  ctx: CanvasRenderingContext2D,
  baseX: number,
  baseY: number,
  tipX: number,
  tipY: number,
  width: number,
  from: string,
  to: string,
): void {
  const grad = ctx.createLinearGradient(baseX, baseY, tipX, tipY);
  grad.addColorStop(0, from);
  grad.addColorStop(1, to);
  ctx.fillStyle = grad;
  const midX = (baseX + tipX) / 2 + (tipX - baseX) * 0.18;
  const midY = (baseY + tipY) / 2;
  ctx.beginPath();
  ctx.moveTo(baseX - width / 2, baseY);
  ctx.quadraticCurveTo(midX - width / 2, midY, tipX, tipY);
  ctx.quadraticCurveTo(midX + width / 2, midY, baseX + width / 2, baseY);
  ctx.closePath();
  ctx.fill();
}

/** A clump of grass blades fanning out from the bottom center. */
export function makeGrassSprite(): THREE.Texture {
  return canvasTexture(128, (ctx) => {
    const baseY = 126;
    for (let i = 0; i < 11; i++) {
      const t = i / 10;
      const baseX = 34 + t * 60 + (Math.random() - 0.5) * 10;
      const lean = (t - 0.5) * 70 + (Math.random() - 0.5) * 22;
      const h = 55 + Math.random() * 55;
      const dry = Math.random() < 0.3;
      blade(
        ctx,
        baseX,
        baseY,
        baseX + lean,
        baseY - h,
        7 + Math.random() * 5,
        dry ? '#77802f' : '#527c26',
        dry ? '#ddc665' : '#a8cc4d',
      );
    }
  });
}

/** A spray of slender drooping leaves around a node point. */
export function makeLeafSprite(): THREE.Texture {
  return canvasTexture(128, (ctx) => {
    const cx = 64;
    const cy = 78;
    for (let i = 0; i < 9; i++) {
      const ang = -Math.PI * 0.95 + (i / 8) * Math.PI * 0.9 + (Math.random() - 0.5) * 0.25;
      const len = 42 + Math.random() * 24;
      const droop = 14 + Math.random() * 16;
      const tipX = cx + Math.cos(ang) * len;
      const tipY = cy + Math.sin(ang) * len * 0.45 + droop;
      blade(
        ctx,
        cx,
        cy,
        tipX,
        tipY,
        9 + Math.random() * 4,
        Math.random() < 0.4 ? '#4f8a30' : '#5f9c34',
        Math.random() < 0.35 ? '#bcd46a' : '#93bf48',
      );
    }
    // Small stem nub anchoring the spray.
    ctx.fillStyle = '#7a8a4a';
    ctx.fillRect(cx - 2, cy - 4, 4, 10);
  });
}

/** Vertical stalk strip: jade gradient with darker node rings and streaks. */
export function makeStalkTexture(): THREE.Texture {
  return canvasTexture(64, (ctx) => {
    const grad = ctx.createLinearGradient(0, 0, 64, 0);
    grad.addColorStop(0, '#5f8a3e');
    grad.addColorStop(0.35, '#9cc45c');
    grad.addColorStop(0.65, '#aed06a');
    grad.addColorStop(1, '#5c823a');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 64, 64);
    // Node rings every "segment".
    for (const y of [10, 31, 52]) {
      ctx.fillStyle = 'rgba(30, 48, 18, 0.55)';
      ctx.fillRect(0, y, 64, 3);
      ctx.fillStyle = 'rgba(235, 240, 200, 0.35)';
      ctx.fillRect(0, y + 3, 64, 1);
    }
    // Faint vertical streaks.
    for (let i = 0; i < 26; i++) {
      const x = Math.random() * 64;
      ctx.fillStyle = Math.random() < 0.5 ? 'rgba(255,255,255,0.06)' : 'rgba(20,40,12,0.08)';
      ctx.fillRect(x, 0, 1 + Math.random(), 64);
    }
  });
}

/** A little cluster of wildflowers: thin stems topped with chunky painted
 * blossoms — meadow doodads, drawn in the same hand as the grass. */
export function makeFlowerSprite(): THREE.Texture {
  return canvasTexture(128, (ctx) => {
    const baseY = 126;
    const blooms: [string, string][] = [
      ['#f5f0dc', '#e8ddb0'], // oxeye white
      ['#f0c342', '#d89c2a'], // buttercup gold
      ['#d96a5a', '#b84a42'], // poppy red
    ];
    for (let i = 0; i < 6; i++) {
      const t = i / 5;
      const baseX = 34 + t * 60 + (Math.random() - 0.5) * 12;
      const lean = (t - 0.5) * 34 + (Math.random() - 0.5) * 16;
      const h = 52 + Math.random() * 46;
      const tipX = baseX + lean;
      const tipY = baseY - h;
      // Stem, thinner than a grass blade.
      blade(ctx, baseX, baseY, tipX, tipY, 4, '#4f7c2a', '#7ba03c');
      // Blossom: a ring of petal blobs around a bright heart.
      const [petal, shade] = blooms[i % blooms.length]!;
      const r = 7 + Math.random() * 4;
      for (let p = 0; p < 5; p++) {
        const a = (p / 5) * Math.PI * 2 + Math.random() * 0.4;
        ctx.fillStyle = p % 2 === 0 ? petal : shade;
        ctx.beginPath();
        ctx.arc(tipX + Math.cos(a) * r * 0.8, tipY + Math.sin(a) * r * 0.7, r * 0.55, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.fillStyle = '#8a5a20';
      ctx.beginPath();
      ctx.arc(tipX, tipY, r * 0.32, 0, Math.PI * 2);
      ctx.fill();
    }
  });
}

/** A butterfly seen from above: two wing pairs around a dark body. */
export function makeButterflySprite(): THREE.Texture {
  return canvasTexture(64, (ctx) => {
    const wing = (sx: number): void => {
      ctx.save();
      ctx.translate(32, 32);
      ctx.scale(sx, 1);
      // Fore wing.
      ctx.beginPath();
      ctx.ellipse(13, -7, 12, 9, -0.5, 0, Math.PI * 2);
      ctx.fill();
      // Hind wing, smaller.
      ctx.beginPath();
      ctx.ellipse(10, 8, 9, 7, 0.4, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    };
    ctx.fillStyle = '#f2ead2';
    wing(1);
    wing(-1);
    // Wing spots.
    ctx.fillStyle = 'rgba(90, 60, 20, 0.55)';
    for (const [x, y] of [
      [18, 24],
      [46, 24],
      [21, 41],
      [43, 41],
    ] as const) {
      ctx.beginPath();
      ctx.arc(x, y, 3.4, 0, Math.PI * 2);
      ctx.fill();
    }
    // Body.
    ctx.fillStyle = '#3a3226';
    ctx.beginPath();
    ctx.ellipse(32, 32, 2.6, 10, 0, 0, Math.PI * 2);
    ctx.fill();
  });
}

/**
 * Shared material factory for alpha-tested painted foliage quads. FrontSide
 * only — the crossed-quad geometry carries its own back-to-back faces so
 * two-sided lighting never flips the up-facing normals into darkness.
 */
export function foliageMaterial(map: THREE.Texture): THREE.MeshLambertMaterial {
  return new THREE.MeshLambertMaterial({
    map,
    alphaTest: 0.5,
  });
}
