import * as THREE from 'three';
import {describe, expect, it} from 'vitest';
import {attachXrayOutline, occludedBy, type OccluderBox} from './xrayOutline';

/** A hut two tiles square standing on flat ground, four units tall. */
function hut(cx = 0, cz = 0, top = 4): OccluderBox {
  return {
    minX: cx - 1,
    maxX: cx + 1,
    minZ: cz - 1,
    maxZ: cz + 1,
    baseY: 0,
    topY: top,
  };
}

/** The match rig's own line, near enough: south-east and well up. */
const VIEW = new THREE.Vector3(1, 1.6, 1).normalize();

const MAN = 0.85;

describe('occludedBy', () => {
  it('hides a man standing on the far side of the hut', () => {
    // Two tiles beyond the wall, so the line to the camera climbs about
    // 4.8 over the 3 it travels — under a four-unit roof.
    expect(occludedBy([hut()], -3, 0, -3, MAN, VIEW)).toBe(true);
  });

  it('leaves the man in front of it alone', () => {
    expect(occludedBy([hut()], 3, 0, 3, MAN, VIEW)).toBe(false);
  });

  it('leaves a man beside it alone', () => {
    expect(occludedBy([hut()], -3, 0, 3, MAN, VIEW)).toBe(false);
  });

  it('lets the line clear a roof it has climbed past', () => {
    // Far enough back that the same line is over the roof by the time it
    // reaches the hut.
    expect(occludedBy([hut()], -9, 0, -9, MAN, VIEW)).toBe(false);
  });

  it('counts a man whose head alone is behind it', () => {
    // A hut on a crag above him: the line from his boots passes under its
    // floor and out the far side, and only the line from his head runs
    // into it. He is a standing man and not a point, so that counts.
    const onACrag: OccluderBox = {...hut(), baseY: 3.5, topY: 4.5};
    expect(occludedBy([onACrag], -1.05, 0, -1.05, MAN, VIEW)).toBe(true);
    expect(occludedBy([onACrag], -1.05, 0, -1.05, 0.05, VIEW)).toBe(false);
  });

  it('is false with nothing standing', () => {
    expect(occludedBy([], -3, 0, -3, MAN, VIEW)).toBe(false);
  });

  it('answers for the whole roster, not just the first hut', () => {
    expect(occludedBy([hut(20, 20), hut()], -3, 0, -3, MAN, VIEW)).toBe(true);
  });
});

/** A skinned man and a prop in his hand, as a character group is shaped. */
function character(): {root: THREE.Group; body: THREE.SkinnedMesh} {
  const root = new THREE.Group();
  const bone = new THREE.Bone();
  const skeleton = new THREE.Skeleton([bone]);
  const geo = new THREE.BoxGeometry(0.3, 0.85, 0.2);
  geo.setAttribute(
    'skinIndex',
    new THREE.BufferAttribute(
      new Uint16Array(geo.getAttribute('position').count * 4),
      4,
    ),
  );
  geo.setAttribute(
    'skinWeight',
    new THREE.BufferAttribute(
      new Float32Array(geo.getAttribute('position').count * 4).fill(1),
      4,
    ),
  );
  const body = new THREE.SkinnedMesh(geo, new THREE.MeshLambertMaterial());
  body.add(bone);
  body.bind(skeleton);
  const prop = new THREE.Mesh(
    new THREE.BoxGeometry(0.05, 0.4, 0.05),
    new THREE.MeshLambertMaterial(),
  );
  root.add(body, prop);
  return {root, body};
}

/** Every mesh the outline hung on the character, and nothing else. */
function twins(root: THREE.Object3D): THREE.Mesh[] {
  const out: THREE.Mesh[] = [];
  root.traverse(o => {
    if (o instanceof THREE.Mesh && o.parent instanceof THREE.Mesh) out.push(o);
  });
  return out;
}

describe('attachXrayOutline', () => {
  it('hangs a mask and a hull on every mesh, hidden until asked', () => {
    const {root} = character();
    const outline = attachXrayOutline(root, 0);
    const hung = twins(root);
    expect(hung).toHaveLength(4); // two meshes, two passes apiece
    expect(hung.every(m => !m.visible)).toBe(true);
    outline.setVisible(true);
    expect(hung.every(m => m.visible)).toBe(true);
    outline.setVisible(false);
    expect(hung.every(m => m.visible)).toBe(false);
  });

  it('copies the meshes rather than the work: shared geometry and skeleton', () => {
    const {root, body} = character();
    attachXrayOutline(root, 0);
    for (const t of body.children.filter(c => c instanceof THREE.SkinnedMesh)) {
      expect(t.geometry).toBe(body.geometry);
      expect(t.skeleton).toBe(body.skeleton);
    }
  });

  it('casts no shadow — the sun knows nothing about an outline', () => {
    const {root} = character();
    attachXrayOutline(root, 0);
    expect(twins(root).every(m => !m.castShadow)).toBe(true);
  });

  it('draws the mask before the hull, and both under the overlays', () => {
    const {root} = character();
    attachXrayOutline(root, 0);
    const orders = [...new Set(twins(root).map(m => m.renderOrder))].sort(
      (a, b) => a - b,
    );
    expect(orders).toHaveLength(2);
    expect(orders[0]).toBeLessThan(orders[1]!);
    // Over the world, which is renderOrder 0...
    expect(orders[0]).toBeGreaterThan(0);
    // ...and under the hp bars, which are 10 and draw with no depth test:
    // a hull painted across a man's own bar is the overlay contract
    // broken (sceneSync.ts, #hpBars.renderOrder).
    expect(orders[1]).toBeLessThan(10);
  });

  it('paints a rival in their own color and a bandit in the alarm red', () => {
    const hullOf = (owner: number): THREE.Color => {
      const {root} = character();
      attachXrayOutline(root, owner);
      const hull = twins(root).reduce((a, b) =>
        a.renderOrder > b.renderOrder ? a : b,
      );
      return (hull.material as THREE.ShaderMaterial).uniforms.uColor!
        .value as THREE.Color;
    };
    expect(hullOf(1).getHex(THREE.LinearSRGBColorSpace)).toBe(0xd22227);
    expect(hullOf(255).getHex(THREE.LinearSRGBColorSpace)).toBe(0xbf4342);
  });

  it('sews the split normals of a hard-edged body back together', () => {
    const {root, body} = character();
    attachXrayOutline(root, 0);
    const smoothed = body.geometry.getAttribute('outlineNormal');
    expect(smoothed).toBeDefined();
    // A box corner carries three face normals; averaged, it points out
    // along the diagonal rather than along any one face.
    const n = new THREE.Vector3(
      smoothed.getX(0),
      smoothed.getY(0),
      smoothed.getZ(0),
    );
    expect(n.length()).toBeCloseTo(1, 5);
    expect(Math.abs(n.x)).toBeCloseTo(Math.abs(n.y), 5);
    expect(Math.abs(n.y)).toBeCloseTo(Math.abs(n.z), 5);
  });
});
