import type { BuildingSnap, MapSnapshot, StructuralUpdate } from '../protocol/messages';

export interface MirrorChanges {
  /** Tiles whose standing resource vanished (scatter must hide them). */
  resourceCleared: number[];
  /** Any terrain-color-relevant change (paths, deposits, footprints). */
  repaint: boolean;
}

/**
 * The main thread's read-only copy of slow-changing sim state: map arrays
 * (for picking + ghost validity) and the building list. Updated by applying
 * structural messages; never mutated locally.
 */
export class WorldMirror {
  map: MapSnapshot;
  buildings = new Map<number, BuildingSnap>();

  constructor(map: MapSnapshot, buildings: BuildingSnap[]) {
    this.map = map;
    for (const b of buildings) this.buildings.set(b.id, b);
  }

  apply(msg: StructuralUpdate): MirrorChanges {
    const changes: MirrorChanges = { resourceCleared: [], repaint: false };

    for (const d of msg.mapDeltas) {
      if (this.map.resource[d.idx] !== d.resource && d.resource === 0) {
        changes.resourceCleared.push(d.idx);
      }
      if (
        this.map.resource[d.idx] !== d.resource ||
        this.map.pathLevel[d.idx] !== d.pathLevel ||
        // Buildings trample the ground around them — repaint on placement.
        this.map.buildingAt[d.idx] !== d.buildingAt
      ) {
        changes.repaint = true;
      }
      this.map.resource[d.idx] = d.resource;
      this.map.blocked[d.idx] = d.blocked;
      this.map.pathLevel[d.idx] = d.pathLevel;
      this.map.buildingAt[d.idx] = d.buildingAt;
    }

    this.buildings.clear();
    for (const b of msg.buildings) this.buildings.set(b.id, b);
    return changes;
  }
}
