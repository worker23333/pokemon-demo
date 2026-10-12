import { actorEntries } from './assets/actors/manifest';
import { textureEntries } from './assets/textures/manifest';

export type WorldDirection = 'up'|'down'|'left'|'right';
export type WorldAction = 'Idle'|'Walk'|'Run'|'WakeUp';
export type WorldFrame = {
  sx:number;sy:number;sw:number;sh:number;feet:[number,number];
  alphaBounds:[number,number,number,number];frameRun:number;
  sprite:string;sourceSprite:string;sourceSpriteSha256:string;
  sourceTexture:string;sourceTextureSha256:string;sourceSize:[number,number];sourceRegion:[number,number,number,number];
  pivotVerified:boolean;regionVerified:boolean;pixelsPerUnrealUnit:number;
};
export type WorldAnimation = {
  action:WorldAction;direction:WorldDirection;fps:number|null;timingVerified:boolean;loop:boolean;
  sourceFlipbook:string;sourceFlipbookFile:string;sourceFlipbookSha256:string;frames:WorldFrame[];
};
export type WorldActorDescriptor = {id:string;name:string;nameZh:string;displayHeight:number;frameCount:number;metadataUrl:string;atlasUrl:string};
export type WorldActorMetadata = {id:string;name:string;nameZh:string;atlas:string;atlasSize:[number,number];atlasSha256:string;displayHeight:number;frameCount:number;animations:Record<string,WorldAnimation>};
export type LoadedWorldActor = {descriptor:WorldActorDescriptor;data:WorldActorMetadata;image:HTMLImageElement};
export type WorldSample = {image:HTMLImageElement;frame:WorldFrame;displayHeight:number;fps:number|null;timingVerified:boolean;actionFallback:boolean;directionFallback:boolean;frameIndex:number;animation:WorldAnimation;data:WorldActorMetadata;sheetKey:string};
export type WorldTextureDescriptor = {
  id:string;kind:'ground'|'billboard'|'model-uv'|'tilesheet'|'material'|'reference';url:string;
  width:number;height:number;feet:number[];displayHeight:number;alphaBounds:number[];
  source:string;sha256:string;pixelIdentityVerified:boolean;pivotVerified:boolean;
  sourcePivot?:number[];compositionVerified?:boolean;usage:string;
};

/** Genuine original world actors; names retain package identity, not invented roles. */
export const WORLD_ACTORS = new Map(actorEntries.map(actor=>[actor.id,actor]));
/** model-uv and tilesheet entries require geometry/subregions, not full-image billboards. */
export const WORLD_TEXTURES = new Map(textureEntries.map(texture=>[texture.id,texture]));
const loadedActors=new Map<string,LoadedWorldActor>();
const actorRequests=new Map<string,Promise<LoadedWorldActor|null>>();
const textureRequests=new Map<string,Promise<{descriptor:WorldTextureDescriptor;image:HTMLImageElement}|null>>();
function imageFrom(url:string):Promise<HTMLImageElement>{return new Promise((resolve,reject)=>{const image=new Image();image.decoding='async';image.onload=()=>resolve(image);image.onerror=()=>reject(new Error(`Gamma world texture failed: ${url}`));image.src=url;});}

export function loadWorldActor(id:string):Promise<LoadedWorldActor|null>{
  const cached=loadedActors.get(id);if(cached)return Promise.resolve(cached);
  const descriptor=WORLD_ACTORS.get(id);if(!descriptor)return Promise.resolve(null);
  const pending=actorRequests.get(id);if(pending)return pending;
  const request=Promise.all([
    fetch(descriptor.metadataUrl).then(async response=>{if(!response.ok)throw new Error(`Gamma world actor metadata failed (${response.status}): ${id}`);return await response.json() as WorldActorMetadata;}),
    imageFrom(descriptor.atlasUrl),
  ]).then(([data,image])=>{
    if(data.id!==id||image.width!==data.atlasSize[0]||image.height!==data.atlasSize[1])throw new Error(`Gamma world atlas mismatch: ${id}`);
    const actor={descriptor,data,image};loadedActors.set(id,actor);actorRequests.delete(id);return actor;
  }).catch(error=>{actorRequests.delete(id);throw error;});
  actorRequests.set(id,request);return request;
}

/** Original PaperFlipbook sequence and FrameRun timing. Missing NPC Run uses Walk. */
export function sampleWorldActor(id:string,action:WorldAction,direction:WorldDirection,seconds:number):WorldSample|null{
  const actor=loadedActors.get(id);if(!actor)return null;
  const animations=actor.data.animations;
  const candidates=[`${action}/${direction}`,...(action==='Run'?[`Walk/${direction}`]:[]),`Idle/${direction}`,'Idle/down'];
  const animation=candidates.map(key=>animations[key]).find(Boolean);if(!animation?.frames.length)return null;
  const total=animation.frames.reduce((sum,frame)=>sum+frame.frameRun,0);
  const elapsed=Number.isFinite(seconds)?Math.max(0,seconds):0;
  // Unknown inherited FPS is preserved as unknown. Current unresolved entries
  // are one-frame NPC Idle; no guessed animation rate is necessary.
  const raw=animation.fps==null?0:Math.floor(elapsed*animation.fps);
  const position=animation.loop?raw%total:Math.min(total-1,raw);
  let accumulated=0,frameIndex=0;
  for(let i=0;i<animation.frames.length;i++){accumulated+=animation.frames[i].frameRun;if(position<accumulated){frameIndex=i;break;}}
  return{image:actor.image,frame:animation.frames[frameIndex],displayHeight:actor.data.displayHeight,fps:animation.fps,timingVerified:animation.timingVerified,actionFallback:animation.action!==action,directionFallback:animation.direction!==direction,frameIndex,animation,data:actor.data,sheetKey:actor.descriptor.atlasUrl};
}

export function loadWorldTexture(id:string):Promise<{descriptor:WorldTextureDescriptor;image:HTMLImageElement}|null>{
  const descriptor=WORLD_TEXTURES.get(id);if(!descriptor)return Promise.resolve(null);
  const pending=textureRequests.get(id);if(pending)return pending;
  const request=imageFrom(descriptor.url).then(image=>({descriptor,image})).catch(error=>{textureRequests.delete(id);throw error;});
  textureRequests.set(id,request);return request;
}
