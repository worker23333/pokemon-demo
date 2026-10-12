import species from '../../../packages/content/species.json';
import { pmdActionFor, pmdDirectionIndex, resolvePmdAnimation, samplePmdFrame, type PmdAnimation, type PmdSpecies } from '../../../packages/presentation/pmd-sprites.js';
import { sampleActionStage } from '../../../packages/presentation/action-stage.js';
import type { FighterView } from './types';

const heights=new Map(species.map(s=>[s.id,s.heightDm]));
export const battleSpeciesHeight=(id:number,boss=false)=>Math.min(3.2,Math.max(1.3,(1.05+Math.sqrt(heights.get(id)??7)*.23)*(boss?1.06:1)));
/** One source pixel has a fixed world size across actions and camera zoom.
 * Rounding the projected scale to an integer makes 2x -> 3x a 50% size jump. */
export const pmdWorldScale=(id:number,displayHeight:number,boss=false)=>battleSpeciesHeight(id,boss)/Math.max(1,displayHeight);
type Sheet={image:HTMLImageElement;white:HTMLCanvasElement};
const metadata=new Map<number,PmdSpecies>(),pending=new Map<number,Promise<PmdSpecies|null>>();
const sheets=new Map<string,Sheet>(),loading=new Map<string,Promise<Sheet|null>>();
function loadSheet(path:string):Promise<Sheet|null>{
  if(!loading.has(path))loading.set(path,new Promise<Sheet|null>(resolve=>{
    const image=new Image();image.decoding='async';
    image.onload=()=>{const white=document.createElement('canvas');white.width=image.width;white.height=image.height;
      const ctx=white.getContext('2d')!;ctx.drawImage(image,0,0);ctx.globalCompositeOperation='source-in';ctx.fillStyle='#fff';ctx.fillRect(0,0,white.width,white.height);
      const sheet={image,white};sheets.set(path,sheet);resolve(sheet);};
    image.onerror=()=>resolve(null);image.src=path;
  }));
  return loading.get(path)!;
}
export async function loadPmdSpecies(id:number):Promise<PmdSpecies|null>{
  if(typeof document==='undefined')return null;
  if(!pending.has(id))pending.set(id,(async()=>{
    try{const response=await fetch(`/assets/pokemon/pmd/${id}/metadata.json`);if(!response.ok)return null;
      const data=await response.json() as PmdSpecies;
      if(data.id!==id||!data.animations)return null;
      metadata.set(id,data);
      await Promise.all([...new Set(['Idle','Walk','Attack','Shoot','Strike','Charge','Hurt','Sleep','Faint'].map(a=>resolvePmdAnimation(data,a)?.sheet).filter((s):s is string=>!!s))].map(loadSheet));
      return data;
    }catch{return null;}
  })());
  return pending.get(id)!;
}
export function pmdMetadata(id:number){return metadata.get(id);}
export function pmdSample(id:number,requested:string,seconds:number,direction:number,loop=true){
  const data=metadata.get(id);if(!data){void loadPmdSpecies(id);return null;}
  const animation=resolvePmdAnimation(data,requested);if(!animation)return null;
  const sheet=sheets.get(animation.sheet);if(!sheet){void loadSheet(animation.sheet);return null;}
  const frame=samplePmdFrame(animation,seconds,direction,{loop});
  return frame?{data,animation,sheet,frame,requested,fallback:animation.name!==requested}:null;
}
export type PmdSample=NonNullable<ReturnType<typeof pmdSample>>;
export function fighterPmdSample(f:FighterView,tick:number,reduced=false){
  // A live channel keeps its actual shooting pose and muzzle. Hurt feedback is
  // supplied by flash/recoil; e.g. Blastoise's Hurt sheet withdraws into a shell.
  const channel=f.phase==='active'&&['channel','stream','beam'].includes(f.cast?.shape??'');
  const hurt=!channel&&f.hurtTick!=null&&tick>=f.hurtTick&&tick-f.hurtTick<4?1:0;
  const stage=sampleActionStage(f,tick,reduced);
  const action=pmdActionFor({...f,status:f.status??undefined,hurt});
  let seconds=tick/20;
  if(action==='Hurt')seconds=(tick-f.hurtTick!)/20;
  else if(action==='Faint')seconds=Math.max(0,(f.fainted-.0001)/1.1);
  else if(f.cast&&['Charge','Attack','Strike','Shoot'].includes(action))seconds=Math.max(0,tick-(f.phase==='windup'?(f.cast.startTick??f.cast.start+1):(f.cast.activeTick??f.cast.active+1)))/20;
  const dir=f.pmdDirection??pmdDirectionIndex(f.cast?f.aimU??0:f.speed>.4?f.velocityU??0:f.aimU??0,f.cast?f.aimV??0:f.speed>.4?f.velocityV??0:f.aimV??0);
  const sample=pmdSample(f.speciesId,action,reduced&&action==='Idle'?0:seconds,dir,['Idle','Walk','Sleep','Charge'].includes(action)||['channel','stream','beam'].includes(f.cast?.shape??''));
  return sample?{...sample,stage,lift:(Math.max(0,f.override?.alt??f.alt??0)+stage.lift)*.9}:null;
}

type SourceBounds={u0:number;u1:number;v0:number;v1:number};
const actionBounds=new WeakMap<PmdAnimation,SourceBounds|null>(),locomotionBounds=new WeakMap<PmdSpecies,SourceBounds|null>();
function unionBounds(a:SourceBounds|null,b:SourceBounds|null):SourceBounds|null{
  if(!a)return b;if(!b)return a;
  return {u0:Math.min(a.u0,b.u0),u1:Math.max(a.u1,b.u1),v0:Math.min(a.v0,b.v0),v1:Math.max(a.v1,b.v1)};
}
function sourceBounds(animation:PmdAnimation|null):SourceBounds|null{
  if(!animation)return null;
  if(actionBounds.has(animation))return actionBounds.get(animation)!;
  let bounds:SourceBounds|null=null;
  for(const row of animation.anchors)for(const anchors of row){
    const b=anchors.bounds;if(!b)continue;
    bounds=unionBounds(bounds,{u0:b[0]-anchors.feet[0],u1:b[2]-anchors.feet[0],v0:b[1]-anchors.feet[1],v1:b[3]-anchors.feet[1]});
  }
  actionBounds.set(animation,bounds);return bounds;
}

/** Idle and Walk share a stable envelope, so stopping cannot change the camera.
 * Union the current action as well: large attacks still fit, without making
 * every idle fighter reserve an explosive attack's maximum extent. */
export function pmdVisualBounds(f:FighterView,tick:number,reduced=false){
  const pmd=fighterPmdSample(f,tick,reduced);if(!pmd)return null;
  if(!locomotionBounds.has(pmd.data))locomotionBounds.set(pmd.data,unionBounds(
    sourceBounds(resolvePmdAnimation(pmd.data,'Idle')),sourceBounds(resolvePmdAnimation(pmd.data,'Walk'))));
  const bounds=unionBounds(locomotionBounds.get(pmd.data)!,sourceBounds(pmd.animation));if(!bounds)return null;
  const scale=pmdWorldScale(f.speciesId,pmd.data.displayHeight,f.boss);
  return {u0:f.u+bounds.u0*scale*1.25-.35,u1:f.u+bounds.u1*scale*1.25+.35,
    v0:Math.min(f.v+bounds.v0*scale-pmd.lift-.35,f.v-battleSpeciesHeight(f.speciesId,f.boss)-pmd.lift-.45),
    v1:f.v+bounds.v1*scale-pmd.lift+.35};
}
export function drawPmdSprite(g:CanvasRenderingContext2D,sample:PmdSample,x:number,y:number,scale:number,options:{alpha?:number;flash?:number;stretchX?:number;stretchY?:number;clipY?:number}={}){
  const {frame,sheet}=sample,[fx,fy]=frame.anchors.feet;
  g.save();g.imageSmoothingEnabled=false;
  if(options.clipY!=null){const pad=Math.max(frame.sw,frame.sh)*scale*3;g.beginPath();g.rect(x-pad,y-pad,pad*2,Math.max(0,options.clipY-y+pad));g.clip();}
  g.translate(Math.round(x),Math.round(y));g.scale(scale*(options.stretchX??1),scale*(options.stretchY??1));g.globalAlpha=options.alpha??1;
  g.drawImage(sheet.image,frame.sx,frame.sy,frame.sw,frame.sh,-fx,-fy,frame.sw,frame.sh);
  if(options.flash){g.globalAlpha=(options.alpha??1)*Math.min(1,options.flash);g.drawImage(sheet.white,frame.sx,frame.sy,frame.sw,frame.sh,-fx,-fy,frame.sw,frame.sh);}
  g.restore();
}
/** Visual muzzle only. The projectile and hazard end still come from the server. */
export function pmdEmissionPoints(f:FighterView,tick:number,reduced=false){
  const sample=fighterPmdSample(f,tick,reduced);if(!sample)return null;
  const anchor=sample.frame.anchors,transform=f.pmdRender,scale=transform?.scale??pmdWorldScale(f.speciesId,sample.data.displayHeight,f.boss);
  return [{u:f.u+(transform?.offsetU??0)+(anchor.head[0]-anchor.feet[0])*scale*(transform?.stretchX??1),v:f.v+(transform?.offsetV??0),
    height:Math.max(.05,(anchor.feet[1]-anchor.head[1])*scale*(transform?.stretchY??1)+(transform?.lift??sample.lift))}];
}
