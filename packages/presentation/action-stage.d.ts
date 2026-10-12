import type { MotionFighter } from './battle-motion.js';
export type ActionStage={kind:'none'|'dig'|'air'|'slam'|'throw';phase:string;progress:number;lift:number;pitch:number;compression:number;grounded:boolean;dig:number};
export function sampleActionStage(fighter:MotionFighter,tick:number,reduced?:boolean):Readonly<ActionStage>;
export function stagePivotLift(stage:ActionStage|undefined,rotation:number,width:number):number;
export function stagePixelPoint(stage:ActionStage|undefined,anchors:ReadonlyArray<{name:string;x:number;y:number}>,x:number,y:number):{x:number;y:number};
