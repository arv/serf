import * as THREE from 'three';

/**
 * Hand-"painted" vegetation sprites, drawn on canvases at boot. Alpha-tested
 * quads with these textures are the classic way stylized RTS games (Battle
 * Realms included) got lush vegetation: chunky silhouettes, saturated
 * gradients, zero photorealism.
 */

function canvasTexture(size: number, draw: (ctx: CanvasRenderingContext2D) => void): THREE.Texture {
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

/** A spray of slender drooping bamboo leaves around a node point. */
export function makeBambooLeafSprite(): THREE.Texture {
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

/** Vertical culm strip: jade gradient with darker node rings and streaks. */
export function makeBambooCulmTexture(): THREE.Texture {
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
