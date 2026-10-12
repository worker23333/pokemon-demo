/// <reference types="vite/client" />
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { WORLD_MODELS } from './assets/models/manifest';
import { WORLD_MATERIALS } from './assets/models/materials';
import spriteSource from './data/native-sprites.json';
import collisionSource from './data/native-scenes/collision-shapes.json';
import spriteMaterialSource from './evidence/native-sprite-default-materials.json';
import type { WorldMap, Point } from './types';
import { EncounterFieldError, type FieldArenaInput, type FieldObstacle, type FieldTerrain } from './field-types';
import { chooseFieldSpawns } from './field-navigation';
import { sourceLitFacing } from './source-view';
import type { RoomPaletteItem } from './battle-room-types';

type MaterialRef = {package:string}|null;
type Instance = {componentId:number;actorId:number;actorName:string;kind:string;asset:string;matrix:number[];visible:boolean;materialOverrides?:MaterialRef[];sourceMapId?:string;actorClass?:string};
type Bounds = {min:number[];max:number[]};
type Hull = {bounds:Bounds;transform?:{quaternion:number[];translation:number[];scale:number[]}};
type Collision = {actorId:number;actorClass?:string;matrix:number[];componentTags?:string[];shape?:{kind:string;halfExtents?:number[]}|null;shapeId?:string;worldBounds?:Bounds};
type NativeData = {id:string;actors:{id:number;class:string;position:number[]}[];instances:Instance[];collisionComponents:Collision[]};
type Sprite = {texture:string;vertices:number[][]};
type NativeConfig = NonNullable<WorldMap['native']>;
type Block = {box:THREE.Box3;inverse:THREE.Matrix4;local:THREE.Box3;ownerId?:string};
type InstanceGroup = {asset:string;kind:string;instances:Instance[];overrides:MaterialRef[];horizontal:boolean};
type NativeActor = {id:string;actorClass:string;assets:Set<string>;slots:{mesh:THREE.InstancedMesh;index:number;kind:string}[];visualBounds:THREE.Box3;meshBounds:THREE.Box3;blocks:Block[];kind?:'tree'|'rock'|'fence'|'crate';destructible:boolean};
const sprites = spriteSource.sprites as Record<string,Sprite>;
const flipbooks = spriteSource.flipbooks as Record<string,{framesPerSecond:number|null;frames:{package:string;frameRun:number;blank?:boolean}[]}>;
const sourceTextures = spriteSource.textures as Record<string,{path:string;width:number;height:number}>;
const spriteDefaultMaterials=spriteMaterialSource.materials as Record<string,{package:string}>;
const shapes = collisionSource as Record<string,{kind:string;hulls:Hull[]}>;
const sceneUrls = import.meta.glob('./data/native-scenes/MAP_*.json',{eager:true,query:'?url',import:'default'}) as Record<string,string>;
const textureUrls = import.meta.glob('./data/sprite-textures/*.png',{eager:true,query:'?url',import:'default'}) as Record<string,string>;
const nativeRequests = new Map<string,Promise<NativeData>>();
const modelRequests = new Map<string,Promise<THREE.Group>>();
const textureRequests = new Map<string,Promise<THREE.Texture>>();
const loader = new GLTFLoader();
const B = new THREE.Matrix4().set(1,0,0,0, 0,0,1,0, 0,-1,0,0, 0,0,0,1);
const BI = B.clone().invert();
const STEP_HEIGHT = .48, PLAYER_RADIUS = .16, PLAYER_HEIGHT = 1.2;
const islandSceneIds=['MAP_DemoIsland_Beach','MAP_DemoIsland_R101','MAP_DemoIsland_R102','MAP_DemoIsland_R103','MAP_AshenForest','MAP_BloomingForest'];
const ignoredActorClass = /BP_Brendan|BP_May|PlayerStart|CaptainPeteWake|BP_MagmaGrunt|BP_Larry|BP_Sherry|BP_TA_Hero|BP_Yior|BP_RichBoy|BP_NPC_|BP_Mori|BP_Tako|BP_Lucious/;

/** Mesh vertices already use metres and the UE -> Three axis conversion. */
export function nativeMatrix(raw:number[],origin:number[]) {
  const result = B.clone().multiply(new THREE.Matrix4().fromArray(raw)).multiply(BI);
  result.elements[12] = (raw[12]-origin[0])/100;
  result.elements[13] = (raw[14]-origin[2])/100;
  result.elements[14] = -(raw[13]-origin[1])/100;
  return result;
}
function rawCollisionMatrix(raw:number[],origin:number[]) {
  return new THREE.Matrix4().set(.01,0,0,-origin[0]/100, 0,0,.01,-origin[2]/100, 0,-.01,0,origin[1]/100, 0,0,0,1)
    .multiply(new THREE.Matrix4().fromArray(raw));
}
/** Preserve the blend/lighting intent explicitly named by native sprite overrides.
 * The wind, custom normals and other UE shader graph effects remain adaptations.
 */
export function nativeSpriteMaterial(overrides:MaterialRef[]=[],map:THREE.Texture|null=null,asset='',horizontal=false):THREE.MeshBasicMaterial|THREE.MeshStandardMaterial {
  const sourceMaterial=overrides.find(m=>m?.package)?.package??spriteDefaultMaterials[asset]?.package??'';
  const translucent=/Translucent/i.test(sourceMaterial);
  const lit=/LitSpriteMaterial/i.test(sourceMaterial)&&!/Unlit/i.test(sourceMaterial);
  const parameters={map,side:THREE.DoubleSide,transparent:translucent,depthWrite:!translucent,alphaTest:translucent?0:.45};
  const material=lit?new THREE.MeshStandardMaterial({...parameters,roughness:1,metalness:0}):new THREE.MeshBasicMaterial(parameters);
  material.userData={sourceMaterial,shaderAdaptation:true,nativeBlendIntent:translucent?'translucent':'masked',nativeLightingIntent:lit?'lit':'unresolved'};
  // Flat cutout decals sit millimetres from the original floor. Resolve their
  // depth ordering without changing source vertices or walkable ground height.
  if(horizontal&&!translucent){material.polygonOffset=true;material.polygonOffsetFactor=0;material.polygonOffsetUnits=-1;}
  // Patch every flipbook frame, including frames not attached to a mesh yet.
  sourceLitFacing(material);
  return material;
}
export function nativeHorizontalSprite(matrix:number[]){
  // PaperSprite local X/Z span its plane in the original UE coordinate system.
  const normal=new THREE.Vector3(matrix[0],matrix[1],matrix[2]).cross(new THREE.Vector3(matrix[8],matrix[9],matrix[10])).normalize();
  return Math.abs(normal.z)>.999;
}
/** Separate hull boxes preserve the opening of an original hollow volume. */
export function nativeCollisionBlocks(c:Collision,origin:number[]):Block[] {
  const parts:{bounds:Bounds;matrix:THREE.Matrix4}[] = [], matrix = rawCollisionMatrix(c.matrix,origin);
  if (c.shape?.kind==='box' && c.shape.halfExtents) {
    const half=c.shape.halfExtents;parts.push({bounds:{min:half.map(v=>-v),max:half},matrix});
  } else if (c.shapeId && shapes[c.shapeId]) {
    for (const hull of shapes[c.shapeId].hulls) {
      const local=new THREE.Matrix4(),t=hull.transform;
      if(t)local.compose(new THREE.Vector3().fromArray(t.translation),new THREE.Quaternion().fromArray(t.quaternion),new THREE.Vector3().fromArray(t.scale));
      parts.push({bounds:hull.bounds,matrix:matrix.clone().multiply(local)});
    }
  }
  if(!parts.length&&c.worldBounds)parts.push({bounds:c.worldBounds,matrix:rawCollisionMatrix(new THREE.Matrix4().toArray(),origin)});
  return parts.filter(p=>Math.abs(p.matrix.determinant())>1e-14).map(p=>{
    const local=new THREE.Box3(new THREE.Vector3().fromArray(p.bounds.min),new THREE.Vector3().fromArray(p.bounds.max));
    return {local,box:local.clone().applyMatrix4(p.matrix),inverse:p.matrix.clone().invert()};
  });
}
const isTerrain=(asset:string)=>/\/SM_GammaIsland_(?:Beach|R101|R102|R103|AshenForest(?:_Mound[^/]*)?|BloomingForest)$|\/(?:LANDPieces\/SM_Land_|Stairs\/SM_Stair)|\/SM_(?:Bridge|Petelburg_Woods_Floor|Route101_floor|LostGlades|RuinsPalace)/i.test(asset);
function boxInRegion(box:THREE.Box3,config:NativeConfig) {
  const {origin,ueBounds:b}=config,pad=3.84;
  return box.max.x>=(b.min[0]-origin[0])/100-pad&&box.min.x<=(b.max[0]-origin[0])/100+pad
    &&box.max.z>=-(b.max[1]-origin[1])/100-pad&&box.min.z<=-(b.min[1]-origin[1])/100+pad;
}
function instanceInRegion(i:Instance,config:NativeConfig) {
  const model=i.kind==='StaticMesh'?WORLD_MODELS.get(i.asset):undefined;
  if(model){const b=new THREE.Box3(new THREE.Vector3().fromArray(model.bounds.min),new THREE.Vector3().fromArray(model.bounds.max));return boxInRegion(b.applyMatrix4(nativeMatrix(i.matrix,config.origin)),config);}
  const fb=flipbooks[i.asset],sprite=sprites[i.asset]??(fb&&sprites[fb.frames.find(f=>!f.blank)?.package??'']);
  if(sprite){const points=sprite.vertices.map(([x,z])=>new THREE.Vector3(x/100,z/100,0));return boxInRegion(new THREE.Box3().setFromPoints(points).applyMatrix4(nativeMatrix(i.matrix,config.origin)),config);}
  const p=new THREE.Vector3().setFromMatrixPosition(nativeMatrix(i.matrix,config.origin));return boxInRegion(new THREE.Box3(p.clone(),p.clone()),config);
}
/** Actor export IDs are local to each map package. */
export function nativeInstanceGroups(all:NativeData[],config:NativeConfig) {
  const groups=new Map<string,InstanceGroup>();
  for(const data of all){
    const ignored=new Set(data.actors.filter(a=>ignoredActorClass.test(a.class)).map(a=>a.id));
    const classes=new Map(data.actors.map(a=>[a.id,a.class]));
    for(const i of data.instances){
      if(!i.visible||ignored.has(i.actorId)||/SkySphere|Skybox|WaterPlane|Camera|PP_|Collision/.test(i.asset)||!instanceInRegion(i,config))continue;
      const overrides=i.materialOverrides??[],horizontal=i.kind!=='StaticMesh'&&nativeHorizontalSprite(i.matrix),key=JSON.stringify([i.kind,i.asset,overrides.map(m=>m?.package??null),horizontal]);
      const group=groups.get(key)??{asset:i.asset,kind:i.kind,instances:[],overrides,horizontal};group.instances.push({...i,sourceMapId:data.id,actorClass:classes.get(i.actorId)});groups.set(key,group);
    }
  }
  return [...groups.values()];
}
/** Neighboring streamed levels are scenery only until the portal changes maps.
 * Their terrain, collisions and actors never enter exploration/battle queries.
 */
export function nativeBackgroundGroups(all:NativeData[],config:NativeConfig){
  const expanded:NativeConfig={...config,ueBounds:{min:config.ueBounds.min.map((v,i)=>i<2?v-2000:v),max:config.ueBounds.max.map((v,i)=>i<2?v+2000:v)}};
  return nativeInstanceGroups(all,expanded).map(group=>({...group,instances:group.instances.filter(i=>
    i.sourceMapId!==config.sceneId&&(i.sourceMapId!=='MAP_Overworld'||!instanceInRegion(i,config))
  )})).filter(group=>group.instances.length>0);
}
export async function readNative(id:string) {
  let r=nativeRequests.get(id);
  if(!r){
    const url=sceneUrls[`./data/native-scenes/${id}.json`];if(!url)throw new Error(`原关卡数据缺失：${id}`);
    r=fetch(url).then(response=>{if(!response.ok)throw new Error(`原关卡载入失败：${id}`);return response.json() as Promise<NativeData>;});
    nativeRequests.set(id,r);r.catch(()=>nativeRequests.delete(id));
  }
  return r;
}
async function modelFor(asset:string) {
  let r=modelRequests.get(asset);
  if(!r){
    const desc=WORLD_MODELS.get(asset);if(!desc)return null;
    r=loader.loadAsync(desc.url).then(gltf=>{
      gltf.scene.traverse(node=>{
        if(!(node as THREE.Mesh).isMesh)return;
        const mesh=node as THREE.Mesh;
        for(const material of Array.isArray(mesh.material)?mesh.material:[mesh.material]){
          const association=gltf.parser.associations.get(material);material.userData.nativeMaterialSlot=association?.materials;
          if((material as THREE.MeshStandardMaterial).isMeshStandardMaterial){
            const m=material as THREE.MeshStandardMaterial;m.roughness=1;m.metalness=0;m.side=THREE.DoubleSide;
            for(const t of [m.map,m.normalMap,m.emissiveMap])if(t){t.magFilter=THREE.NearestFilter;t.minFilter=THREE.NearestFilter;}
          }
        }
      });
      gltf.scene.updateMatrixWorld(true);return gltf.scene;
    });modelRequests.set(asset,r);r.catch(()=>modelRequests.delete(asset));
  }
  return r;
}
async function imageTexture(url:string,flipY:boolean) {
  const key=`${flipY?'sprite':'gltf'}:${url}`;let r=textureRequests.get(key);
  if(!r){r=new THREE.TextureLoader().loadAsync(url).then(t=>{t.colorSpace=THREE.SRGBColorSpace;t.magFilter=THREE.NearestFilter;t.minFilter=THREE.NearestFilter;t.wrapS=t.wrapT=THREE.RepeatWrapping;t.flipY=flipY;return t;});textureRequests.set(key,r);r.catch(()=>textureRequests.delete(key));}
  return r;
}
async function textureFor(asset:string) {
  const source=sourceTextures[asset],url=source&&textureUrls[source.path];if(!url)throw new Error(`原地图纹理未导出：${asset}`);return imageTexture(url,true);
}

export class NativeWorld {
  readonly group=new THREE.Group();
  readonly stats={staticInstances:0,spriteInstances:0,backgroundStaticInstances:0,backgroundSpriteInstances:0,missingModels:new Set<string>(),missingSprites:new Set<string>(),unresolvedMaterials:new Set<string>(),blockingVolumes:0,ignoredUnresolvedVolumes:0,treeBoxes:0,navMeshes:0,navTriangles:0};
  private ownedGeometries:THREE.BufferGeometry[]=[];
  private ownedMaterials:THREE.Material[]=[];
  private instances:THREE.InstancedMesh[]=[];
  private materialRequests=new Map<string,Promise<THREE.Material>>();
  private nav:{mesh:THREE.Mesh;box:THREE.Box3}[]=[];
  private navTop=0;
  private blocks:Block[]=[];
  private unresolvedVolumes:Block[]=[];
  private nativeActors=new Map<string,NativeActor>();
  private destroyedActors=new Set<string>();
  private ray=new THREE.Raycaster();
  private animations:{mesh:THREE.InstancedMesh;frames:{geometry:THREE.BufferGeometry;material:THREE.Material;run:number;blank?:boolean}[];fps:number;total:number;index:number}[]=[];
  private heights=new Map<string,number[]>();
  private minimaps=new Map<string,HTMLCanvasElement>();
  private groundSprites:{mesh:THREE.InstancedMesh;materials:THREE.Material[]}[]=[];
  private navBins?:Map<string,{mesh:THREE.Mesh;box:THREE.Box3}[]>;
  private blockBins?:Map<string,Block[]>;
  constructor(readonly config:NativeConfig){}
  async build(options:{background?:boolean}={}){
    const primary=await readNative(this.config.sceneId),all=[primary];if(this.config.includeOverworld&&primary.id!=='MAP_Overworld')all.push(await readNative('MAP_Overworld'));
    const renderBackground=options.background!==false;
    const neighbors=renderBackground&&islandSceneIds.includes(this.config.sceneId)?await Promise.all(islandSceneIds.filter(id=>id!==this.config.sceneId).map(readNative)):[];
    const background=renderBackground?nativeBackgroundGroups([...neighbors,...all.filter(d=>d.id==='MAP_Overworld')],this.config):[];
    const queue=[...nativeInstanceGroups(all,this.config).map(g=>({...g,background:false})),...background.map(g=>({...g,background:true}))];let cursor=0;
    await Promise.all(Array.from({length:8},async()=>{while(cursor<queue.length){const {asset,kind,instances,overrides,background,horizontal}=queue[cursor++];if(kind==='StaticMesh')await this.addModel(asset,instances,overrides,background);else await this.addSprites(asset,kind,instances,overrides,background,horizontal);}}));
    this.partitionNavigation();this.navBins=this.spatialBins(this.nav,.001);
    // Preserve authored underlay ordering instead of pulling a grass rectangle
    // through nearby tent floors or roads. Only resolve millimetre-scale gaps.
    for(const {mesh,materials} of this.groundSprites){
      const matrix=new THREE.Matrix4(),p=new THREE.Vector3(),g=mesh.geometry;g.computeBoundingBox();const bounds=g.boundingBox;let below=0,above=0;
      const samples=bounds?[bounds.getCenter(new THREE.Vector3()),new THREE.Vector3(bounds.min.x,bounds.min.y,0),new THREE.Vector3(bounds.min.x,bounds.max.y,0),new THREE.Vector3(bounds.max.x,bounds.min.y,0),new THREE.Vector3(bounds.max.x,bounds.max.y,0)]:[new THREE.Vector3()];
      for(let i=0;i<mesh.count;i++){mesh.getMatrixAt(i,matrix);for(const sample of samples){p.copy(sample).applyMatrix4(matrix);const height=this.heightAt(p);if(height===null||Math.abs(height-p.y)>.02)continue;if(height-p.y>.001)below++;else if(p.y-height>.001)above++;}}
      if(below&&!above)for(const material of materials)if(material.polygonOffset){material.polygonOffsetFactor=1;material.polygonOffsetUnits=1;}
    }
    for(const data of all){
      const classes=new Map(data.actors.map(a=>[a.id,a.class]));
      for(const c of data.collisionComponents){
        if(!Array.isArray(c.matrix))continue;
        const cls=classes.get(c.actorId)??c.actorClass??'',wall=(c.componentTags??[]).includes('WALL'),volume=cls==='BlockingVolume';if(!wall&&!volume)continue;
        const blocks=nativeCollisionBlocks(c,this.config.origin).filter(b=>boxInRegion(b.box,this.config));if(!blocks.length)continue;
        // Generic volume runtime responses/story activation remain undecoded.
        // Retain their shapes, but only explicit WALL boxes block this web mode.
        if(volume){this.stats.blockingVolumes++;this.stats.ignoredUnresolvedVolumes++;this.unresolvedVolumes.push(...blocks);}
        else{const id=`${data.id}:${c.actorId}`;for(const b of blocks)b.ownerId=id;this.blocks.push(...blocks);this.nativeActors.get(id)?.blocks.push(...blocks);this.stats.treeBoxes++;}
      }
    }
    this.preparePhysicalActors();this.blockBins=this.spatialBins(this.blocks,PLAYER_RADIUS);this.group.updateMatrixWorld(true);return this;
  }
  private spatialBins<T extends {box:THREE.Box3}>(items:T[],pad:number){
    const bins=new Map<string,T[]>();for(const item of items){const b=item.box;for(let x=Math.floor((b.min.x-pad)/4);x<=Math.floor((b.max.x+pad)/4);x++)for(let z=Math.floor((b.min.z-pad)/4);z<=Math.floor((b.max.z+pad)/4);z++){const key=`${x},${z}`,list=bins.get(key)??[];list.push(item);bins.set(key,list);}}return bins;
  }
  /** CPU navigation only: exact original triangles in four-metre buckets. */
  private partitionNavigation(){
    const partitioned:typeof this.nav=[];
    for(const entry of this.nav){
      const source=entry.mesh,g=source.geometry,index=g.index,position=g.getAttribute('position');if(!index||index.count<288){partitioned.push(entry);continue;}
      const chunks=new Map<string,number[]>(),a=new THREE.Vector3(),b=new THREE.Vector3(),c=new THREE.Vector3();
      for(let i=0;i<index.count;i+=3){const ids=[index.getX(i),index.getX(i+1),index.getX(i+2)];a.fromBufferAttribute(position,ids[0]).applyMatrix4(source.matrixWorld);b.fromBufferAttribute(position,ids[1]).applyMatrix4(source.matrixWorld);c.fromBufferAttribute(position,ids[2]).applyMatrix4(source.matrixWorld);const key=`${Math.floor((a.x+b.x+c.x)/12)},${Math.floor((a.z+b.z+c.z)/12)}`,indices=chunks.get(key)??[];indices.push(...ids);chunks.set(key,indices);}
      for(const indices of chunks.values()){
        const geometry=new THREE.BufferGeometry();for(const [name,attribute] of Object.entries(g.attributes))geometry.setAttribute(name,attribute);geometry.setIndex(indices);
        const local=new THREE.Box3();for(const id of indices)local.expandByPoint(a.fromBufferAttribute(position,id));geometry.boundingBox=local;geometry.boundingSphere=local.getBoundingSphere(new THREE.Sphere());this.ownedGeometries.push(geometry);
        const mesh=new THREE.Mesh(geometry,source.material);mesh.matrixAutoUpdate=false;mesh.matrix.copy(source.matrix);mesh.updateMatrixWorld(true);partitioned.push({mesh,box:local.clone().applyMatrix4(mesh.matrixWorld)});
      }
    }
    this.nav=partitioned;
  }
  private registerInstance(i:Instance,mesh:THREE.InstancedMesh,index:number,matrix:THREE.Matrix4,geometry:THREE.BufferGeometry){
    const id=`${i.sourceMapId??this.config.sceneId}:${i.actorId}`;
    let actor=this.nativeActors.get(id);if(!actor){actor={id,actorClass:i.actorClass??'',assets:new Set(),slots:[],visualBounds:new THREE.Box3(),meshBounds:new THREE.Box3(),blocks:[],destructible:false};this.nativeActors.set(id,actor);}
    actor.assets.add(i.asset);actor.slots.push({mesh,index,kind:i.kind});geometry.computeBoundingBox();if(geometry.boundingBox){const box=geometry.boundingBox.clone().applyMatrix4(matrix);actor.visualBounds.union(box);if(i.kind==='StaticMesh')actor.meshBounds.union(box);}
  }
  /** Source WALL shapes describe trunks, avoiding the foliage mesh's canopy.
   * Other props use their source model bounds. Cover circles and break HP are
   * explicit web physics; the original static meshes have no break animation.
   */
  private preparePhysicalActors(){
    for(const actor of this.nativeActors.values()){
      const names=[actor.actorClass,...actor.assets].join(' ');
      actor.kind=/SM_BirchBox|SM_.*Crate/i.test(names)?'crate':/WoodenFence|WoodFence/i.test(names)?'fence':/SM_Rock\d|SM_Boulder/i.test(names)?'rock':/BP_Tree|SM_Pixel_Tree|\/SM_Tree(?:\s|$)/i.test(names)?'tree':undefined;
      if(!actor.kind)continue;
      if(!actor.blocks.length&&actor.kind!=='tree'&&!actor.meshBounds.isEmpty()){
        const box=actor.meshBounds.clone(),block={box,local:box.clone(),inverse:new THREE.Matrix4(),ownerId:actor.id};actor.blocks.push(block);this.blocks.push(block);
      }
      const size=actor.visualBounds.getSize(new THREE.Vector3());
      actor.destructible=actor.kind==='crate'||actor.kind==='fence'||(actor.kind==='tree'&&size.y<=2.4&&actor.blocks.every(b=>Math.max(b.box.max.x-b.box.min.x,b.box.max.z-b.box.min.z)<=1.5));
    }
  }
  /** IDs can be stored verbatim and replayed after build(). Actor scope removes
   * every submesh, leaves, shadow and WALL component without touching neighbors.
   */
  applyDestroyed(ids:string[]):string[]{
    const accepted:string[]=[],dirty=new Set<THREE.InstancedMesh>(),hidden=new THREE.Matrix4().makeScale(0,0,0);
    for(const id of ids){const actor=this.nativeActors.get(id);if(!actor?.destructible)continue;accepted.push(id);if(this.destroyedActors.has(id))continue;this.destroyedActors.add(id);for(const slot of actor.slots){slot.mesh.setMatrixAt(slot.index,hidden);dirty.add(slot.mesh);}}
    for(const mesh of dirty){mesh.instanceMatrix.needsUpdate=true;mesh.computeBoundingSphere();}
    if(dirty.size){this.blocks=this.blocks.filter(b=>!b.ownerId||!this.destroyedActors.has(b.ownerId));this.blockBins=this.spatialBins(this.blocks,PLAYER_RADIUS);}
    return accepted;
  }
  /** Only the currently loaded, surviving actors near the encounter may seed
   * a generated room. An empty local patch expands once, never to the map. */
  encounterPalette(center:Point,radius=18):RoomPaletteItem[]{
    const range=Math.max(1,Math.min(30,Number.isFinite(radius)?radius:18));
    const candidates:{item:RoomPaletteItem;distance:number}[]=[];
    for(const actor of this.nativeActors.values()){
      if(!actor.kind||this.destroyedActors.has(actor.id)||actor.visualBounds.isEmpty()||!actor.slots.length)continue;
      const visual=actor.visualBounds,size=visual.getSize(new THREE.Vector3()),at=visual.getCenter(new THREE.Vector3());
      const distance=Math.hypot(at.x-center.x,at.z-center.z);if(distance>30||size.y<.06)continue;
      const footprint=new THREE.Box3();for(const block of actor.blocks)footprint.union(block.box);
      const physical=footprint.isEmpty()?size:footprint.getSize(new THREE.Vector3());
      const r=Math.hypot(physical.x,physical.z)/2;if(!Number.isFinite(r)||r<.025||r>8)continue;
      candidates.push({distance,item:{sourceId:actor.id,kind:actor.kind,radius:r,height:size.y,destructible:actor.destructible,weight:1/(1+distance*.16)}});
    }
    const nearby=candidates.filter(candidate=>candidate.distance<=range);
    return(nearby.length?nearby:candidates).sort((a,b)=>a.distance-b.distance||a.item.sourceId.localeCompare(b.item.sourceId)).map(candidate=>candidate.item);
  }
  /** Detached meshes share source geometry and materials. The caller must not
   * dispose those resources; only this wrapper's transform belongs to it. */
  cloneEncounterProp(sourceId:string,radius:number,height:number,rotation:number):THREE.Group|null{
    const actor=this.nativeActors.get(sourceId);
    if(!actor?.kind||this.destroyedActors.has(sourceId)||actor.visualBounds.isEmpty()||!Number.isFinite(radius)||radius<=0||!Number.isFinite(height)||height<=0)return null;
    const group=new THREE.Group(),content=new THREE.Group(),bounds=actor.visualBounds,size=bounds.getSize(new THREE.Vector3());
    const physical=new THREE.Box3();for(const block of actor.blocks)physical.union(block.box);
    const center=(physical.isEmpty()?bounds:physical).getCenter(new THREE.Vector3());
    const footprint=physical.isEmpty()?size:physical.getSize(new THREE.Vector3());
    // Uniform scaling preserves the source silhouette. Height is an upper
    // limit, while the requested radius matches its original physical body.
    const sourceRadius=Math.max(.025,Math.hypot(footprint.x,footprint.z)/2),scale=Math.min(radius/sourceRadius,height/Math.max(.06,size.y));
    const translate=new THREE.Matrix4().makeTranslation(-center.x,-bounds.min.y,-center.z),matrix=new THREE.Matrix4();
    for(const slot of actor.slots){
      slot.mesh.getMatrixAt(slot.index,matrix);if(Math.abs(matrix.determinant())<1e-12)continue;
      const mesh=new THREE.Mesh(slot.mesh.geometry,slot.mesh.material);mesh.matrixAutoUpdate=false;mesh.matrix.copy(translate).multiply(matrix);mesh.castShadow=slot.mesh.castShadow;mesh.receiveShadow=slot.mesh.receiveShadow;mesh.userData.encounterSharedSource=true;content.add(mesh);
    }
    if(!content.children.length)return null;
    // PaperSprite/Flipbook foliage is an authored flat plane. Keep the whole
    // actor's original orientation (including any static trunk) so random yaw
    // cannot turn its canopy edge-on to the unchanged source camera.
    const sourcePlane=actor.slots.some(slot=>slot.kind==='PaperSprite'||slot.kind==='PaperFlipbook');
    content.scale.setScalar(scale);group.add(content);group.rotation.y=!sourcePlane&&Number.isFinite(rotation)?rotation:0;
    group.userData={sourceId,encounterSharedSource:true,sourceRadius,sourceHeight:size.y,uniformScale:scale,sourcePlane};group.updateMatrixWorld(true);return group;
  }
  private async surfaceMaterial(source:THREE.Material,packageName:string|null){
    if(!packageName)return source;const key=source.uuid+'|'+packageName;let pending=this.materialRequests.get(key);
    if(!pending){pending=(async()=>{
      const info=WORLD_MATERIALS.get(packageName);if(!info){this.stats.unresolvedMaterials.add(packageName);return source;}
      const map=info.textureUrl&&info.textureUsage!=='shader-atlas'?await imageTexture(info.textureUrl,false):null,color=info.vectorParameters.Color;
      if(!map&&!color){this.stats.unresolvedMaterials.add(packageName);return source;}
      // Keep the loaded surface lighting and shadow response when substituting
      // an original material's texture. MeshBasicMaterial made every restored
      // terrain/tree surface ignore both the sun and its received shadows.
      const material=new THREE.MeshStandardMaterial({map,side:THREE.DoubleSide,roughness:1,metalness:0,alphaTest:map&&info.hasAlpha ? .5 : 0});
      if(!map&&color)material.color.setRGB(color[0],color[1],color[2],THREE.LinearSRGBColorSpace);
      material.userData={...source.userData,sourceMaterial:packageName,shaderAdaptation:true};this.ownedMaterials.push(material);return material;
    })();this.materialRequests.set(key,pending);}return pending;
  }
  private async addModel(asset:string,instances:Instance[],overrides:MaterialRef[],background=false){
    const source=await modelFor(asset);if(!source){this.stats.missingModels.add(asset);return;}
    const children:THREE.Mesh[]=[];source.traverse(child=>{if((child as THREE.Mesh).isMesh)children.push(child as THREE.Mesh);});
    for(const child of children){
      const originals=Array.isArray(child.material)?child.material:[child.material];
      const materials=await Promise.all(originals.map(m=>{const slot=m.userData.nativeMaterialSlot as number|undefined,base=m.userData.sourceMaterial as string|undefined;return this.surfaceMaterial(m,(slot!==undefined?overrides[slot]?.package:undefined)??base??null);}));
      const material=Array.isArray(child.material)?materials:materials[0],group=new THREE.InstancedMesh(child.geometry,material,instances.length);
      const navigable=!background&&isTerrain(asset)&&!originals.some(m=>/\/Water\/|WaterIsland/i.test(String(m.userData.sourceMaterial)));
      instances.forEach((i,index)=>{const matrix=nativeMatrix(i.matrix,this.config.origin).multiply(child.matrixWorld);group.setMatrixAt(index,matrix);
        if(!background)this.registerInstance(i,group,index,matrix,child.geometry);
        if(navigable){const mesh=new THREE.Mesh(child.geometry,material);mesh.matrixAutoUpdate=false;mesh.matrix.copy(matrix);mesh.updateMatrixWorld(true);const box=new THREE.Box3().setFromObject(mesh);this.nav.push({mesh,box});this.navTop=Math.max(this.navTop,box.max.y);this.stats.navMeshes++;this.stats.navTriangles+=(child.geometry.index?.count??child.geometry.attributes.position.count)/3;}
      });
      group.userData.visualBackground=background;group.instanceMatrix.needsUpdate=true;group.castShadow=true;group.receiveShadow=true;group.computeBoundingSphere();this.instances.push(group);this.group.add(group);
    }
    this.stats.staticInstances+=instances.length;if(background)this.stats.backgroundStaticInstances+=instances.length;
  }
  private async spritePart(asset:string,overrides:MaterialRef[],horizontal=false){
    const sprite=sprites[asset];if(!sprite)return null;const g=new THREE.BufferGeometry(),positions:number[]=[],uv:number[]=[];
    for(const [x,z,u,v] of sprite.vertices){positions.push(x/100,z/100,0);uv.push(u,1-v);}
    g.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));g.setAttribute('uv',new THREE.Float32BufferAttribute(uv,2));g.computeVertexNormals();g.computeBoundingSphere();this.ownedGeometries.push(g);
    const t=await textureFor(sprite.texture),material=nativeSpriteMaterial(overrides,t,asset,horizontal);this.ownedMaterials.push(material);return{geometry:g,material};
  }
  private async addSprites(asset:string,kind:string,instances:Instance[],overrides:MaterialRef[],background=false,horizontal=false){
    const fb=kind==='PaperFlipbook'?flipbooks[asset]:null,frames=fb?.frames??[{package:asset,frameRun:1}];
    const parts:{geometry:THREE.BufferGeometry;material:THREE.Material;run:number;blank?:boolean}[]=[];
    let blank:{geometry:THREE.BufferGeometry;material:THREE.Material}|undefined;
    for(const f of frames){if(f.blank){if(!blank){blank={geometry:new THREE.BufferGeometry(),material:new THREE.MeshBasicMaterial({visible:false})};this.ownedGeometries.push(blank.geometry);this.ownedMaterials.push(blank.material);}parts.push({...blank,run:f.frameRun,blank:true});}else{const p=await this.spritePart(f.package,overrides,horizontal);if(p)parts.push({...p,run:f.frameRun});}}
    if(!parts.length){this.stats.missingSprites.add(asset);return;}
    const mesh=new THREE.InstancedMesh(parts[0].geometry,parts[0].material,instances.length);instances.forEach((i,n)=>{const matrix=nativeMatrix(i.matrix,this.config.origin);mesh.setMatrixAt(n,matrix);if(!background)this.registerInstance(i,mesh,n,matrix,parts[0].geometry);});mesh.userData.visualBackground=background;mesh.instanceMatrix.needsUpdate=true;mesh.castShadow=false;mesh.receiveShadow=parts[0].material instanceof THREE.MeshStandardMaterial;mesh.frustumCulled=false;this.instances.push(mesh);this.group.add(mesh);this.stats.spriteInstances+=instances.length;if(background)this.stats.backgroundSpriteInstances+=instances.length;
    if(parts.length>1&&fb?.framesPerSecond)this.animations.push({mesh,frames:parts,fps:fb.framesPerSecond,total:parts.reduce((n,f)=>n+f.run,0),index:0});
    if(horizontal&&!background)this.groundSprites.push({mesh,materials:parts.map(p=>p.material)});
  }
  tick(seconds:number){for(const a of this.animations){let at=((Math.floor(seconds*a.fps)%a.total)+a.total)%a.total,index=0;while(index<a.frames.length-1&&at>=a.frames[index].run){at-=a.frames[index].run;index++;}if(index!==a.index){a.index=index;a.mesh.geometry=a.frames[index].geometry;a.mesh.material=a.frames[index].material;}}}
  private walkableHit(hit:THREE.Intersection){if(!hit.face)return false;const normal=hit.face.normal.clone().applyNormalMatrix(new THREE.Matrix3().getNormalMatrix(hit.object.matrixWorld));return normal.y>.45;}
  heightAt(p:Point,fromY?:number){
    const key=`${p.x.toFixed(4)},${p.z.toFixed(4)}`;let levels=this.heights.get(key);
    if(!levels){this.ray.set(new THREE.Vector3(p.x,this.navTop+2,p.z),new THREE.Vector3(0,-1,0));const candidates=this.navBins?(this.navBins.get(`${Math.floor(p.x/4)},${Math.floor(p.z/4)}`)??[]):this.nav;const objects=candidates.filter(n=>p.x>=n.box.min.x-.001&&p.x<=n.box.max.x+.001&&p.z>=n.box.min.z-.001&&p.z<=n.box.max.z+.001).map(n=>n.mesh);levels=this.ray.intersectObjects(objects,false).filter(h=>this.walkableHit(h)).map(h=>h.point.y);if(this.heights.size>18000)this.heights.clear();this.heights.set(key,levels);}
    if(!levels.length)return null;if(fromY===undefined)return levels[0];
    // Climb reachable steps overlapping a lower floor; nearest-height selection
    // would stick to that floor until its edge and create an artificial jump.
    const reachable=levels.find(y=>Math.abs(y-fromY)<=STEP_HEIGHT+1e-6);
    if(reachable!==undefined)return reachable;
    return levels.reduce((best,y)=>Math.abs(y-fromY)<Math.abs(best-fromY)?y:best,levels[0]);
  }
  private blockedAt(p:Point,y:number){
    const start=new THREE.Vector3(p.x,y+.12,p.z),end=new THREE.Vector3(p.x,y+PLAYER_HEIGHT,p.z);
    const candidates=this.blockBins?(this.blockBins.get(`${Math.floor(p.x/4)},${Math.floor(p.z/4)}`)??[]):this.blocks;
    for(const b of candidates){
      if(p.x<b.box.min.x-PLAYER_RADIUS||p.x>b.box.max.x+PLAYER_RADIUS||p.z<b.box.min.z-PLAYER_RADIUS||p.z>b.box.max.z+PLAYER_RADIUS||end.y<=b.box.min.y||start.y>=b.box.max.y)continue;
      // A circular footprint can pass outside a box corner even when both
      // expanded axes overlap. Exact for world AABBs; safe rejection for OBBs.
      const dx=Math.max(b.box.min.x-p.x,0,p.x-b.box.max.x),dz=Math.max(b.box.min.z-p.z,0,p.z-b.box.max.z);
      if(dx*dx+dz*dz>PLAYER_RADIUS*PLAYER_RADIUS)continue;
      const a=start.clone().applyMatrix4(b.inverse),z=end.clone().applyMatrix4(b.inverse),delta=z.sub(a),e=b.inverse.elements;
      // Conservative local-box capsule test, an explicit web physics adaptation.
      const margin=[Math.hypot(e[0],e[8]),Math.hypot(e[1],e[9]),Math.hypot(e[2],e[10])].map(v=>v*PLAYER_RADIUS);
      const mins=b.local.min.toArray(),maxs=b.local.max.toArray(),point=a.toArray(),dir=delta.toArray();let low=0,high=1;
      for(let axis=0;axis<3&&low<=high;axis++){const min=mins[axis]-margin[axis],max=maxs[axis]+margin[axis];if(Math.abs(dir[axis])<1e-12){if(point[axis]<min||point[axis]>max){low=1;high=0;}}else{let t0=(min-point[axis])/dir[axis],t1=(max-point[axis])/dir[axis];if(t0>t1)[t0,t1]=[t1,t0];low=Math.max(low,t0);high=Math.min(high,t1);}}
      if(low<=high)return true;
    }
    return false;
  }
  canMove(p:Point,fromY:number){const y=this.heightAt(p,fromY);if(y===null||Math.abs(y-fromY)>STEP_HEIGHT||this.blockedAt(p,y))return null;return y;}
  private sampleGroundSegment(a:Point,b:Point,startY:number,checkBlocks=false):number|null {
    const count=Math.max(1,Math.ceil(Math.hypot(a.x-b.x,a.z-b.z)/.1));let previous=startY;
    for(let n=1;n<=count;n++){const p={x:a.x+(b.x-a.x)*n/count,z:a.z+(b.z-a.z)*n/count},y=this.heightAt(p,previous);if(y===null||Math.abs(y-previous)>STEP_HEIGHT+1e-6||(checkBlocks&&this.blockedAt(p,y)))return null;previous=y;}
    return previous;
  }
  private encounterTerrain(origin:Point,player:Point,groundY:number):FieldTerrain {
    const terrain:FieldTerrain={x0:-7,z0:-5,cellSize:.4,cols:36,rows:26,heights:Array(36*26).fill(null),maxStep:STEP_HEIGHT};
    const points=terrain.heights.map((_,i)=>({x:origin.x-7+i%36*.4,z:origin.z-5+Math.floor(i/36)*.4}));
    const candidates=points.map((p,i)=>({p,i,d:Math.hypot(p.x-player.x,p.z-player.z)})).filter(p=>p.d<.8).sort((a,b)=>a.d-b.d);
    const start=candidates.map(a=>({...a,y:this.sampleGroundSegment(player,a.p,groundY)})).find(a=>a.y!==null);
    if(!start)throw new EncounterFieldError('NO_GROUND','脚下没有可连续采样的原地图地面。');
    const queue=[start.i];terrain.heights[start.i]=start.y;
    // Ground-only flood: props and WALL occupancy must not become null terrain,
    // otherwise breaking a prop would leave an invisible permanent barrier.
    for(let cursor=0;cursor<queue.length;cursor++){const i=queue[cursor],col=i%36,row=Math.floor(i/36);for(const [dc,dr] of [[1,0],[-1,0],[0,1],[0,-1]]){
      const c=col+dc,r=row+dr,j=r*36+c;if(c<0||c>=36||r<0||r>=26||terrain.heights[j]!==null)continue;
      const y=this.sampleGroundSegment(points[i],points[j],terrain.heights[i]!);if(y!==null){terrain.heights[j]=y;queue.push(j);}
    }}
    return terrain;
  }
  private encounterObstacles(origin:Point,groundY:number):FieldObstacle[]{
    const out:FieldObstacle[]=[];
    for(const actor of this.nativeActors.values()){
      if(!actor.kind||this.destroyedActors.has(actor.id)||!actor.blocks.length)continue;
      const bounds=new THREE.Box3();for(const b of actor.blocks)bounds.union(b.box);
      const center=bounds.getCenter(new THREE.Vector3()),x=center.x-origin.x,z=center.z-origin.z;
      if(bounds.max.x<origin.x-7||bounds.min.x>origin.x+7||bounds.max.z<origin.z-5||bounds.min.z>origin.z+5)continue;
      const floor=this.heightAt({x:center.x,z:center.z},groundY);
      if(floor===null||bounds.max.y<=floor+.12||bounds.min.y>floor+.65)continue;
      const radius=Math.max(.03,Math.hypot(bounds.max.x-bounds.min.x,bounds.max.z-bounds.min.z)/2);
      if(radius>8)throw new EncounterFieldError('TOO_MANY_OBSTACLES','这处原场景对象超出局部碰撞范围；请在附近较开阔处交锋。');
      if(Math.hypot(Math.max(0,Math.abs(x)-7),Math.max(0,Math.abs(z)-5))>radius)continue;
      out.push({id:actor.id,x,z,radius,kind:actor.kind,solid:!actor.destructible,hp:actor.destructible?(actor.kind==='fence'?24:actor.kind==='crate'?28:60):null});
    }
    if(out.length>256)throw new EncounterFieldError('TOO_MANY_OBSTACLES','附近原场景对象过于密集；请沿当前道路寻找较开阔的位置。');
    return out;
  }
  /** Build a battle on this map, without a generated layout or camera switch.
   * Every output position except terrain Y is local to the returned origin.
   */
  buildEncounterField(center:Point,player:Point,desiredOpponent?:Point,destroyedIds:string[]=[]):FieldArenaInput {
    this.applyDestroyed(destroyedIds);
    const groundY=this.heightAt(player);if(groundY===null)throw new EncounterFieldError('NO_GROUND','伙伴脚下没有可交锋的原地图地面。');
    const origin={...center};
    if(Math.abs(player.x-origin.x)>5.8||Math.abs(player.z-origin.z)>3.8){
      const adjusted={x:player.x+THREE.MathUtils.clamp(origin.x-player.x,-5.8,5.8),z:player.z+THREE.MathUtils.clamp(origin.z-player.z,-3.8,3.8)};
      if(Math.hypot(adjusted.x-origin.x,adjusted.z-origin.z)>1.6)throw new EncounterFieldError('NO_PLAYER_SPACE','目标距离当前位置太远，请靠近后在原地开始交锋。');Object.assign(origin,adjusted);
    }
    const terrain=this.encounterTerrain(origin,player,groundY),obstacles=this.encounterObstacles(origin,groundY),localPlayer={x:player.x-origin.x,z:player.z-origin.z};
    const localOpponent=desiredOpponent?{x:desiredOpponent.x-origin.x,z:desiredOpponent.z-origin.z}:undefined;
    const starts=chooseFieldSpawns(terrain,obstacles,localPlayer,localOpponent,p=>this.sampleGroundSegment(player,{x:p.x+origin.x,z:p.z+origin.z},groundY,true)!==null);
    return{mapId:this.config.sceneId,origin,...starts,obstacles,terrain};
  }
  rayPoint(ray:THREE.Raycaster){return ray.intersectObjects(this.nav.map(n=>n.mesh),false).find(h=>this.walkableHit(h)&&!this.blockedAt(h.point,h.point.y))?.point;}
  /** Overhead silhouette of actual upward terrain faces, excluding water. */
  createMinimap(width=308,height=224):HTMLCanvasElement {
    width=Math.max(27,Math.round(width));height=Math.max(27,Math.round(height));
    const key=`${width}x${height}`,cached=this.minimaps.get(key);if(cached)return cached;
    const canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;
    const ctx=canvas.getContext('2d');if(!ctx)throw new Error('无法绘制原地形小地图');
    const {origin,ueBounds}=this.config,pad=13;
    const minX=(ueBounds.min[0]-origin[0])/100,maxX=(ueBounds.max[0]-origin[0])/100;
    const minZ=-(ueBounds.max[1]-origin[1])/100,maxZ=-(ueBounds.min[1]-origin[1])/100;
    const sx=(width-pad*2)/Math.max(.001,maxX-minX),sz=(height-pad*2)/Math.max(.001,maxZ-minZ);
    const triangles:{points:number[];y:number}[]=[],a=new THREE.Vector3(),b=new THREE.Vector3(),c=new THREE.Vector3(),normal=new THREE.Vector3();
    for(const {mesh} of this.nav){
      const g=mesh.geometry,position=g.getAttribute('position'),index=g.index;
      const normals=new THREE.Matrix3().getNormalMatrix(mesh.matrixWorld),count=index?.count??position.count;
      for(let n=0;n<count;n+=3){
        a.fromBufferAttribute(position,index?index.getX(n):n);b.fromBufferAttribute(position,index?index.getX(n+1):n+1);c.fromBufferAttribute(position,index?index.getX(n+2):n+2);
        normal.subVectors(c,b).cross(new THREE.Vector3().subVectors(a,b)).normalize().applyNormalMatrix(normals);
        if(normal.y<=.45)continue;
        a.applyMatrix4(mesh.matrixWorld);b.applyMatrix4(mesh.matrixWorld);c.applyMatrix4(mesh.matrixWorld);
        triangles.push({points:[pad+(a.x-minX)*sx,pad+(a.z-minZ)*sz,pad+(b.x-minX)*sx,pad+(b.z-minZ)*sz,pad+(c.x-minX)*sx,pad+(c.z-minZ)*sz],y:(a.y+b.y+c.y)/3});
      }
    }
    const minY=Math.min(...triangles.map(t=>t.y)),maxY=Math.max(...triangles.map(t=>t.y));
    ctx.save();ctx.beginPath();ctx.rect(pad,pad,width-pad*2,height-pad*2);ctx.clip();
    for(const triangle of triangles.sort((a,b)=>a.y-b.y)){
      const light=Math.round(22*(triangle.y-minY)/Math.max(.01,maxY-minY)),p=triangle.points;
      ctx.fillStyle=`rgb(${115+light},${146+light},${106+light})`;
      ctx.beginPath();ctx.moveTo(p[0],p[1]);ctx.lineTo(p[2],p[3]);ctx.lineTo(p[4],p[5]);ctx.closePath();ctx.fill();
    }
    ctx.restore();this.minimaps.set(key,canvas);return canvas;
  }
  dispose(){for(const mesh of this.instances)mesh.dispose();for(const g of this.ownedGeometries)g.dispose();for(const m of this.ownedMaterials)m.dispose();this.group.clear();this.instances=[];this.ownedGeometries=[];this.ownedMaterials=[];this.materialRequests.clear();this.animations=[];this.nav=[];this.blocks=[];this.unresolvedVolumes=[];this.nativeActors.clear();this.destroyedActors.clear();this.heights.clear();this.minimaps.clear();this.groundSprites=[];this.navBins=undefined;this.blockBins=undefined;}
}
