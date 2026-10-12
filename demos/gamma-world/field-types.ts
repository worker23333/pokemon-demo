/** FieldArena wire contract: planar positions are metres relative to origin.
 * Terrain heights retain absolute Three.js world Y. Geometry describes either a sampled source map or an isolated generated
 * encounter room; circular cover, HP and destruction are web adaptations.
 */
export type FieldPoint={x:number;z:number};
export type FieldObstacle={id:string;x:number;z:number;radius:number;hp:number|null;solid:boolean;kind:string};
export type FieldTerrain={x0:number;z0:number;cellSize:number;cols:number;rows:number;heights:(number|null)[];maxStep:number};
export type FieldArenaInput={mapId:string;origin:FieldPoint;playerStart:FieldPoint;opponentStart:FieldPoint;obstacles:FieldObstacle[];terrain:FieldTerrain};
export type FieldArenaState=FieldArenaInput&{destroyed:string[]};
export class EncounterFieldError extends Error {
  constructor(readonly code:'NO_GROUND'|'NO_PLAYER_SPACE'|'NO_OPPONENT_SPACE'|'TOO_MANY_OBSTACLES',message:string){super(message);this.name='EncounterFieldError';}
}
