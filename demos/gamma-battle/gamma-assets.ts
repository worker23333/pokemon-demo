// Actual Gamma Emerald Demo PNG frames, packed without pixel edits.
// Original front/back Idle, Hurt and Cry are available; realtime locomotion is an adaptation.
export type GammaView = 'front' | 'back';
export type GammaNativeAction = 'Idle' | 'Hurt' | 'Cry' | 'Faint' | 'IdleLowHP';
export type GammaFrame = { sx:number; sy:number; sw:number; sh:number; feet:[number,number]; filename:string; source:string; sha256:string; sourceSize:[number,number]; alphaBounds:[number,number,number,number]; pivotVerified:boolean; pixelsPerUnrealUnit:number; rawPivot:[number,number]; pivotSource:string };
export type GammaAnimation = { action:GammaNativeAction; view:GammaView; fps:number; loop:boolean; timingVerified:boolean; frameOrderVerified:boolean; timingSource:string; frames:GammaFrame[]; frameRuns?:{frameIndex:number;frameRun:number}[] };
export type GammaActorDescriptor = { id:number; name:string; nameZh:string; displayHeight:number; frameCount:number; metadataUrl:string; atlasUrl:string; appearanceOnly?:boolean; sourceVariant?:string };
export type GammaActorMetadata = { id:number; name:string; nameZh:string; atlas:string; atlasSize:[number,number]; atlasSha256:string; frameCount:number; displayHeight:number; viewFeet:Record<GammaView,[number,number]>; animations:Record<string,GammaAnimation> };
export type LoadedGammaActor = { descriptor:GammaActorDescriptor; data:GammaActorMetadata; image:HTMLImageElement };
export type GammaSample = { image:HTMLImageElement; frame:GammaFrame; displayHeight:number; sheetKey:string; animation:GammaAnimation; requestedAction:string; actionFallback:boolean; timingVerified:boolean; frameIndex:number; data:GammaActorMetadata };

export const GAMMA_ACTORS = new Map<number,GammaActorDescriptor>([
  [25,{id:25,name:"Pikachu",nameZh:"皮卡丘",displayHeight:47,frameCount:336,metadataUrl:new URL('./assets/actors/025-pikachu.json',import.meta.url).href,atlasUrl:new URL('./assets/actors/025-pikachu.png',import.meta.url).href}],
  [37,{id:37,name:"Vulpix",nameZh:"六尾",displayHeight:46,frameCount:268,metadataUrl:new URL('./assets/actors/037-vulpix.json',import.meta.url).href,atlasUrl:new URL('./assets/actors/037-vulpix.png',import.meta.url).href}],
  [54,{id:54,name:"Psyduck",nameZh:"可达鸭",displayHeight:45,frameCount:280,metadataUrl:new URL('./assets/actors/054-psyduck.json',import.meta.url).href,atlasUrl:new URL('./assets/actors/054-psyduck.png',import.meta.url).href}],
  [95,{id:95,appearanceOnly:true,sourceVariant:"CrystalOnix",name:"Crystal Onix",nameZh:"水晶大岩蛇",displayHeight:76,frameCount:288,metadataUrl:new URL('./assets/actors/095-onix.json',import.meta.url).href,atlasUrl:new URL('./assets/actors/095-onix.png',import.meta.url).href}],
  [111,{id:111,name:"Rhyhorn",nameZh:"独角犀牛",displayHeight:52,frameCount:268,metadataUrl:new URL('./assets/actors/111-rhyhorn.json',import.meta.url).href,atlasUrl:new URL('./assets/actors/111-rhyhorn.png',import.meta.url).href}],
  [112,{id:112,name:"Rhydon",nameZh:"钻角犀兽",displayHeight:64,frameCount:268,metadataUrl:new URL('./assets/actors/112-rhydon.json',import.meta.url).href,atlasUrl:new URL('./assets/actors/112-rhydon.png',import.meta.url).href}],
  [116,{id:116,name:"Horsea",nameZh:"墨海马",displayHeight:40,frameCount:268,metadataUrl:new URL('./assets/actors/116-horsea.json',import.meta.url).href,atlasUrl:new URL('./assets/actors/116-horsea.png',import.meta.url).href}],
  [117,{id:117,name:"Seadra",nameZh:"海刺龙",displayHeight:52,frameCount:268,metadataUrl:new URL('./assets/actors/117-seadra.json',import.meta.url).href,atlasUrl:new URL('./assets/actors/117-seadra.png',import.meta.url).href}],
  [149,{id:149,name:"Dragonite",nameZh:"快龙",displayHeight:83,frameCount:330,metadataUrl:new URL('./assets/actors/149-dragonite.json',import.meta.url).href,atlasUrl:new URL('./assets/actors/149-dragonite.png',import.meta.url).href}],
 ]);

const loaded = new Map<number,LoadedGammaActor>();
const pending = new Map<number,Promise<LoadedGammaActor|null>>();
function imageFrom(url:string):Promise<HTMLImageElement> {
  return new Promise((resolve,reject)=>{const image=new Image();image.decoding='async';image.onload=()=>resolve(image);image.onerror=()=>reject(new Error(`Gamma atlas failed to load: ${url}`));image.src=url;});
}
/** Load one atlas on demand. Unsupported IDs return null; supported asset failures reject. */
export function loadGammaActor(id:number):Promise<LoadedGammaActor|null> {
  const cached=loaded.get(id);if(cached)return Promise.resolve(cached);
  const descriptor=GAMMA_ACTORS.get(id);if(!descriptor)return Promise.resolve(null);
  const inFlight=pending.get(id);if(inFlight)return inFlight;
  const promise=Promise.all([
    fetch(descriptor.metadataUrl).then(async response=>{if(!response.ok)throw new Error(`Gamma metadata failed (${response.status}): ${id}`);return await response.json() as GammaActorMetadata;}),
    imageFrom(descriptor.atlasUrl),
  ]).then(([data,image])=>{
    if(data.id!==id||data.atlasSize[0]!==image.width||data.atlasSize[1]!==image.height)throw new Error(`Gamma atlas metadata mismatch: ${id}`);
    const actor={descriptor,data,image};loaded.set(id,actor);pending.delete(id);return actor;
  }).catch(error=>{pending.delete(id);throw error;});
  pending.set(id,promise);return promise;
}
/** Fallback is explicit: locomotion uses Idle and attacks use Cry. */
export function gammaNativeAction(action:string):GammaNativeAction {
  if(action==='Idle'||action==='Hurt'||action==='Cry'||action==='Faint'||action==='IdleLowHP')return action;
  if(/^(Attack|Strike|Shoot|Cast|Special|Punch|Kick|Bite|Slam)$/i.test(action))return 'Cry';
  if(/^Damage$/i.test(action))return 'Hurt';
  return 'Idle';
}
/** Seconds are elapsed since action start. Idle loops; Cry/Hurt/Faint hold their last frame. */
export function sampleGammaActor(id:number,action:string,seconds:number,view:GammaView='front'):GammaSample|null {
  const actor=loaded.get(id);if(!actor)return null;
  let nativeAction=gammaNativeAction(action);
  if(!actor.data.animations[`${view}/${nativeAction}`])nativeAction=nativeAction==='Faint'?'Hurt':'Idle';
  const animation=actor.data.animations[`${view}/${nativeAction}`];
  if(!animation?.frames.length)return null;
  const elapsed=Number.isFinite(seconds)?Math.max(0,seconds):0;
  const runs=animation.frameRuns;const total=runs?.reduce((sum,item)=>sum+item.frameRun,0)??animation.frames.length;
  const raw=Math.floor(elapsed*animation.fps),position=animation.loop?raw%total:Math.min(total-1,raw);
  let frameIndex=position;
  if(runs){let consumed=0;for(const item of runs){if(position<consumed+item.frameRun){frameIndex=item.frameIndex;break;}consumed+=item.frameRun;}}
  const frame=animation.frames[frameIndex];if(!frame)return null;
  return {image:actor.image,frame,displayHeight:actor.data.displayHeight,sheetKey:actor.descriptor.atlasUrl,animation,requestedAction:action,actionFallback:nativeAction!==action,timingVerified:animation.timingVerified,frameIndex,data:actor.data};
}

export type GammaEnvironmentLayer = {role:string;url:string;width:number;height:number;pivot:[number,number];offset:[number,number];pivotVerified:boolean};
export type GammaEnvironmentAsset = {id:string;kind:'tree'|'grass'|'rock'|'ground';url:string;width:number;height:number;feet:[number,number];sourcePivot?:[number,number];pivotVerified:boolean;compositionVerified:boolean;sourceFiles:string[];layerUrls?:{trunk:string;foliage:string};layers?:GammaEnvironmentLayer[]};
// Environment feet are the web ground-contact anchor. sourcePivot/layers[].pivot are the
// original PaperSprite origin. Tree layers retain original pivots but their relative placement
// is still a web reconstruction until the original scene transforms are decoded.
export const GAMMA_ENVIRONMENT:GammaEnvironmentAsset[] = [
  {id:"tree-1",kind:"tree",url:new URL('./assets/environment/tree-1.png',import.meta.url).href,width:132,height:211,feet:[66.0, 211.0],pivotVerified:true,compositionVerified:false,sourceFiles:[".runtime/gamma-emerald/png/PokemonEmerald/Content/SPRITES/MAPS/TREES/Tree1/SPR_Tree1.png", ".runtime/gamma-emerald/png/PokemonEmerald/Content/SPRITES/MAPS/TREES/Tree1/SPR_Tree1_Leafs.png"],layerUrls:{trunk:new URL('./assets/environment/tree-1-trunk.png',import.meta.url).href,foliage:new URL('./assets/environment/tree-1-foliage.png',import.meta.url).href},layers:[{role:"trunk",url:new URL('./assets/environment/tree-1-trunk.png',import.meta.url).href,width:97,height:141,pivot:[49.0, 141.0],offset:[17, 70],pivotVerified:true},{role:"foliage",url:new URL('./assets/environment/tree-1-foliage.png',import.meta.url).href,width:132,height:164,pivot:[66.0, 82.0],offset:[0, 0],pivotVerified:true},]},
  {id:"tree-2",kind:"tree",url:new URL('./assets/environment/tree-2.png',import.meta.url).href,width:170,height:211,feet:[85.0, 211.0],pivotVerified:true,compositionVerified:false,sourceFiles:[".runtime/gamma-emerald/png/PokemonEmerald/Content/SPRITES/MAPS/TREES/Tree2/SPR_Tree2.png", ".runtime/gamma-emerald/png/PokemonEmerald/Content/SPRITES/MAPS/TREES/Tree2/SPR_TreeLeafs2.png"],layerUrls:{trunk:new URL('./assets/environment/tree-2-trunk.png',import.meta.url).href,foliage:new URL('./assets/environment/tree-2-foliage.png',import.meta.url).href},layers:[{role:"trunk",url:new URL('./assets/environment/tree-2-trunk.png',import.meta.url).href,width:97,height:141,pivot:[49.0, 141.0],offset:[36, 70],pivotVerified:true},{role:"foliage",url:new URL('./assets/environment/tree-2-foliage.png',import.meta.url).href,width:170,height:164,pivot:[85.0, 82.0],offset:[0, 0],pivotVerified:true},]},
  {id:"tree-3",kind:"tree",url:new URL('./assets/environment/tree-3.png',import.meta.url).href,width:170,height:211,feet:[85.0, 211.0],pivotVerified:true,compositionVerified:false,sourceFiles:[".runtime/gamma-emerald/png/PokemonEmerald/Content/SPRITES/MAPS/TREES/Tree3/SPR_Tree3.png", ".runtime/gamma-emerald/png/PokemonEmerald/Content/SPRITES/MAPS/TREES/Tree3/SPR_Tree3_Leafs.png"],layerUrls:{trunk:new URL('./assets/environment/tree-3-trunk.png',import.meta.url).href,foliage:new URL('./assets/environment/tree-3-foliage.png',import.meta.url).href},layers:[{role:"trunk",url:new URL('./assets/environment/tree-3-trunk.png',import.meta.url).href,width:97,height:141,pivot:[49.0, 141.0],offset:[36, 70],pivotVerified:true},{role:"foliage",url:new URL('./assets/environment/tree-3-foliage.png',import.meta.url).href,width:170,height:164,pivot:[85.0, 82.0],offset:[0, 0],pivotVerified:true},]},
  {id:"grass-1",kind:"grass",url:new URL('./assets/environment/grass-1.png',import.meta.url).href,width:15,height:13,feet:[7.5, 13],pivotVerified:true,compositionVerified:true,sourceFiles:[".runtime/gamma-emerald/png/PokemonEmerald/Content/SPRITES/MAPS/TREES/ROCKSandGRASS/SPR_BattleScene_Grass1.png"],sourcePivot:[8.0, 7.0]},
  {id:"grass-2",kind:"grass",url:new URL('./assets/environment/grass-2.png',import.meta.url).href,width:43,height:16,feet:[21.5, 16],pivotVerified:true,compositionVerified:true,sourceFiles:[".runtime/gamma-emerald/png/PokemonEmerald/Content/SPRITES/MAPS/TREES/ROCKSandGRASS/SPR_BattleScene_Grass2.png"],sourcePivot:[22.0, 8.0]},
  {id:"rock-1",kind:"rock",url:new URL('./assets/environment/rock-1.png',import.meta.url).href,width:19,height:16,feet:[9.5, 16],pivotVerified:true,compositionVerified:true,sourceFiles:[".runtime/gamma-emerald/png/PokemonEmerald/Content/SPRITES/MAPS/TREES/ROCKSandGRASS/SPR_BattleScene_Rock1.png"],sourcePivot:[10.0, 8.0]},
  {id:"rock-2",kind:"rock",url:new URL('./assets/environment/rock-2.png',import.meta.url).href,width:24,height:9,feet:[12.0, 9],pivotVerified:true,compositionVerified:true,sourceFiles:[".runtime/gamma-emerald/png/PokemonEmerald/Content/SPRITES/MAPS/TREES/ROCKSandGRASS/SPR_BattleScene_Rock2.png"],sourcePivot:[12.0, 5.0]},
  {id:"ground-grass",kind:"ground",url:new URL('./assets/environment/ground-grass.png',import.meta.url).href,width:480,height:480,feet:[240.0, 480],pivotVerified:false,compositionVerified:true,sourceFiles:[".runtime/gamma-emerald/png/PokemonEmerald/Content/SPRITES/MAPS/GrassTiles/T_Grass.png"]},
  {id:"ground-tile",kind:"ground",url:new URL('./assets/environment/ground-tile.png',import.meta.url).href,width:128,height:128,feet:[64.0, 128],pivotVerified:false,compositionVerified:true,sourceFiles:[".runtime/gamma-emerald/png/PokemonEmerald/Content/SPRITES/MAPS/GrassTiles/T_NewGrassTile.png"]},
];
