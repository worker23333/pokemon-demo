import type { FieldArenaInput } from './field-types';
import type { Point, WorldTheme } from './types';

export type RoomPropKind = 'tree' | 'rock' | 'fence' | 'crate' | 'plant';
/** References original nearby actors; generated props have separate IDs. */
export type RoomPaletteItem = {
  sourceId: string; kind: RoomPropKind; radius: number; height: number;
  destructible: boolean; weight: number;
};
export type RoomContext = {
  mapId: string; mapName: string; theme: WorldTheme; position: Point;
  groundTexture: string; palette: RoomPaletteItem[];
};
export type RoomProp = {
  id: string; sourceId?: string; kind: RoomPropKind; x: number; z: number;
  radius: number; height: number; rotation: number; boundary: boolean;
};
export type BattleRoomLayout = {
  seed: number; templateId: string; templateName: string; quarterTurns: number;
  context: RoomContext; field: FieldArenaInput; props: RoomProp[];
  clearArea: { halfWidth: number; halfDepth: number };
};
