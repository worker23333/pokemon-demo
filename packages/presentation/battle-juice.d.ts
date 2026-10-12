export type ImpactTier = 'light' | 'medium' | 'heavy' | 'crit';
export type ImpactProfile = { tier: ImpactTier; hitstop: number; shake: number; zoom: number; recoil: number; continuous: boolean; bypassCooldown: boolean; flashDisc: boolean; rays: boolean; boom: boolean };
export function impactProfile(power:number,effectiveness?:number,delivery?:string,big?:boolean,guarded?:boolean):ImpactProfile;
export type RecoilState = { recoilAt?:number;recoilStrength?:number;recoilDirU?:number;recoilDirV?:number };
export function sampleRecoil(fighter:RecoilState,time:number,reduced?:boolean):{u:number;v:number;stretchX:number;stretchY:number;flash:number};
export class DamageAccumulator {
  constructor(window?:number);
  add(source:string|null|undefined,target:string,moveId:number|undefined,amount:number,time:number,continuous?:boolean):{key:string;total:number;continued:boolean};
  clear():void;
}
export class CalloutGate {
  allow(actor:string,moveId:number|undefined,time:number,supportive:boolean):boolean;
  clear():void;
}
