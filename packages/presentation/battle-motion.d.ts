export type Locomotion = 'biped' | 'quadruped' | 'fly' | 'hover' | 'serpent' | 'aquatic' | 'crawl' | 'burrow' | 'blob' | 'roll' | 'plant';
export type MotionProfile = {
  name: string; locomotion: Locomotion; grounded: boolean;
  stride: number; bob: number; sway: number; lean: number; elasticity: number;
  inertia: number; lift: number; phaseSeed: number; emission: {x:number;y:number};
};
export type MoveChoreography = {name:string;family:string;gesture:string;intensity:number;pulses:number};
export type MotionFighter = {
  speciesId: number; speed?: number; velocityU?: number; velocityV?: number;
  aimU?: number; aimV?: number; facing?: number; side?: number;
  phase?: string; status?: string | null; hurtTick?: number;
  hurtStrength?: number; hurtDirection?: number;
  cast?: {moveId:number;phase?:string;start:number;active:number;activeLen:number;end:number;startTick?:number;activeTick?:number;endTick?:number} | null;
};
export type BattlePose = {
  hop:number; squash:number; stretchX:number; rot:number; shear:number; frameTime:number;
  emission:{x:number;y:number}; phase:string; gesture:string|null; locomotion:Locomotion;
  grounded:boolean; hurt:number;
};
export function motionProfile(speciesId?:number): MotionProfile;
export function moveChoreography(moveId?:number): MoveChoreography;
export function hurtAt(events:ReadonlyArray<{kind?:string;actor?:string|null;amount?:number;tick:number;effectiveTick?:number}>, fighterId:string, tick:number): number | undefined;
export function sampleBattleMotion(fighter:MotionFighter, tick:number, time?:number, reduced?:boolean): BattlePose;
export { stagePivotLift } from './action-stage.js';
