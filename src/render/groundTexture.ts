import * as THREE from 'three';

/**
 * A tileable grayscale detail texture, generated on a canvas at boot: fine
 * blade-like speckles over soft blotches. Multiplied with the terrain's
 * vertex colors it breaks up the flat "plastic" look the way hand-painted
 * ground textures do. Mean brightness sits near white so it darkens little.
 */
export function makeGroundTexture(mapSize: number): THREE.Texture {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;

  ctx.fillStyle = '#d8d8d8';
  ctx.fillRect(0, 0, size, size);

  // Soft large blotches (drawn wrapped so the tile seams disappear).
  const blot = (
    x: number,
    y: number,
    r: number,
    light: boolean,
    a: number,
  ): void => {
    const grad = ctx.createRadialGradient(x, y, 0, x, y, r);
    const c = light ? '255, 255, 255' : '0, 0, 0';
    grad.addColorStop(0, `rgba(${c}, ${a})`);
    grad.addColorStop(1, `rgba(${c}, 0)`);
    ctx.fillStyle = grad;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
  };
  for (let i = 0; i < 60; i++) {
    const x = Math.random() * size;
    const y = Math.random() * size;
    const r = 14 + Math.random() * 30;
    const light = Math.random() < 0.5;
    const a = 0.04 + Math.random() * 0.05;
    for (const dx of [-size, 0, size]) {
      for (const dy of [-size, 0, size]) blot(x + dx, y + dy, r, light, a);
    }
  }

  // Fine blade speckles: short strokes with slight rotational variety.
  for (let i = 0; i < 5200; i++) {
    const x = Math.random() * size;
    const y = Math.random() * size;
    const len = 1.5 + Math.random() * 3;
    const ang =
      -0.5 + Math.random() * 1.0 + (Math.random() < 0.5 ? Math.PI : 0);
    const light = Math.random() < 0.45;
    const a = 0.05 + Math.random() * 0.12;
    ctx.strokeStyle = light ? `rgba(255,255,255,${a})` : `rgba(10,14,6,${a})`;
    ctx.lineWidth = Math.random() < 0.8 ? 1 : 2;
    for (const dx of [-size, 0, size]) {
      for (const dy of [-size, 0, size]) {
        ctx.beginPath();
        ctx.moveTo(x + dx, y + dy);
        ctx.lineTo(x + dx + Math.cos(ang) * len, y + dy + Math.sin(ang) * len);
        ctx.stroke();
      }
    }
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(mapSize / 4, mapSize / 4); // ~4 tiles per repeat, whatever the map size
  texture.anisotropy = 8;
  texture.colorSpace = THREE.NoColorSpace;
  return texture;
}
