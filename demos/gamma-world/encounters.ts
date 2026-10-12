import sourceZones from './data/encounter-zones.json';
import type { Point, Rect, WorldMap } from './types';

export type EncounterHabitat='grass'|'coast'|null;
type ZoneRecord={actorCount:number;source:string;sourceSha256:string;rectangles:number[][]};
export const ENCOUNTER_SOURCE=sourceZones;
const zones=sourceZones.maps as Record<string,ZoneRecord>;
export function sourceGrassAreas(sceneId:string):Rect[]{return(zones[sceneId]?.rectangles??[]).map(([x,z,w,d])=>({x,z,w,d}));}
const distance=(a:Point,b:Point)=>Math.hypot(a.x-b.x,a.z-b.z);
/** Calm space around conversations, camps and transitions is a Web adaptation. */
export function isEncounterSafe(map:WorldMap,p:Point){
  if(distance(p,map.spawn)<3||(map.camp&&distance(p,map.camp)<4))return true;
  return map.entities.some(e=>distance(p,e)<(e.kind==='heal'?4:e.kind==='portal'?3:e.kind==='trainer'?2.4:e.kind==='pickup'?1.5:1.8));
}
export function encounterHabitat(map:WorldMap,p:Point):EncounterHabitat {
  if(!map.wild.length||isEncounterSafe(map,p))return null;
  if(map.grass.some(r=>Math.abs(p.x-r.x)<=r.w/2+1e-7&&Math.abs(p.z-r.z)<=r.d/2+1e-7))return 'grass';
  // The source Beach contains no BP_GrassTile actors. Walking its native ground
  // outside calm areas allows coastal encounters without painting invented grass.
  return map.id==='beach'?'coast':null;
}

/** Distance-based Web encounter pacing; source encounter blueprints are not run.
 * A failed field placement stays pending, so stepping out of dense grass can
 * find room. Only successful encounters/travel reset accumulated progress.
 */
export class EncounterDirector {
  private charge=0;
  private grace=8;
  private retry=0;
  private pending=false;
  private attempting=false;
  private failures=0;
  reset(grace=8){this.charge=0;this.grace=grace;this.retry=0;this.pending=false;this.attempting=false;this.failures=0;}
  advance(distance:number,habitat:EncounterHabitat,safe=false):boolean {
    if(!Number.isFinite(distance)||distance<=0||this.attempting)return false;
    const usable=Math.max(0,distance-this.grace);this.grace=Math.max(0,this.grace-distance);this.retry=Math.max(0,this.retry-distance);
    if(safe||usable<=0)return false;
    if(!this.pending&&habitat)this.charge+=usable/(habitat==='grass'?3.2:12);
    if(this.charge>=1-1e-8)this.pending=true;
    if(!this.pending||this.retry>1e-8)return false;
    this.attempting=true;return true;
  }
  /** False after the first geometry failure avoids a repeating error toast. */
  failed(){this.pending=true;this.attempting=false;this.retry=1.5;return this.failures++===0;}
  get status(){return{charge:this.charge,grace:this.grace,retry:this.retry,pending:this.pending,attempting:this.attempting,failures:this.failures};}
}
