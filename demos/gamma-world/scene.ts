import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { SOURCE_VIEW, CAMERA_VIEW, clampCameraDistance, cameraArmForViewport, sourceProjection, sourceLitFacing, screenToWorld, worldToScreen } from './source-view';
import { WORLD_TEXTURES, WORLD_ACTORS, loadWorldTexture, loadWorldActor, sampleWorldActor, type WorldDirection, type WorldSample } from './world-assets';
import { canStand, moveOnMap } from './state';
import { NativeWorld } from './native-scene';
import { Timeline } from '../../apps/web/arena/timeline';
import type { GammaBattle } from '../gamma-battle/api-client';
import type { FieldArenaInput } from './field-types';
import type { BattleRoomLayout, RoomContext } from './battle-room-types';
import { generateBattleRoom } from './battle-room-generator';
import { GeneratedBattleRoom } from './battle-room-scene';
import { fieldHeightAt } from './field-navigation';
import { loadFieldActor, sampleFieldActor, sampleCompanionActor, fieldActorVertex, type FieldActorSample } from './field-actors';
import { FieldEffects } from './field-effects';
import { MODEL_PIXEL_WORLD_SCALE } from './model-scale';
import { findWorldPath, canTravelWorldSegment, type WorldPathPoint } from './world-navigation';
import { CompanionBehavior } from './companion-behavior';
import { CompanionTrail } from './companion-trail';
import { WORLD_MATERIALS } from './assets/models/materials';
import type { WorldMap, Point, WorldEntity, WorldSave, Prop } from './types';

type Visual={mesh:THREE.Mesh<THREE.PlaneGeometry,THREE.MeshStandardMaterial>;shadow:THREE.Mesh;sheet?:string};
const rng=(seed:number)=>()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};
const ease=(rate:number,dt:number)=>1-Math.exp(-rate*dt);
/** Decoded original world geometry and placements; movement and camera run in the Web framework. */
export class WorldScene {
  readonly canvas:HTMLCanvasElement;
  private renderer:THREE.WebGLRenderer;
  private composer:EffectComposer;
  private cameraDistance:number=CAMERA_VIEW.defaultDistance;
  private cameraArm:number=CAMERA_VIEW.defaultDistance;
  onCameraDistanceChange?:(distance:number)=>void;
  private scene=new THREE.Scene();
  private camera=new THREE.PerspectiveCamera(32,1,.1,240);
  private sun=new THREE.DirectionalLight('#f2d691',3.2);
  private sky=new THREE.HemisphereLight('#b1c8cd','#344433',.8);
  private mapGroup=new THREE.Group();
  private actors=new Map<string,Visual>();
  private textures=new Map<string,THREE.Texture>();
  private mapTextures:THREE.Texture[]=[];
  private observer:ResizeObserver;
  private map?:WorldMap;
  private native?:NativeWorld;
  private groundY=0;
  private field?:{input:FieldArenaInput;timeline:Timeline;snapshot?:GammaBattle;tick:number;received:number};
  private fieldEffects=new FieldEffects();
  private preparedRoom?:{layout:BattleRoomLayout;view:GeneratedBattleRoom};
  private battleRoom?:{layout:BattleRoomLayout;view:GeneratedBattleRoom;returnFollow:WorldPathPoint};
  private battleActors=new THREE.Group();
  private effectsCanvas:HTMLCanvasElement;
  onFieldTarget?:(point:Point)=>void;
  onDestroyed?:(ids:string[])=>void;
  onStatus?:(message:string)=>void;
  private state?:WorldSave;
  private keys=new Set<string>();
  private joystick:Point={x:0,z:0};
  private route:WorldPathPoint[]=[];
  private routeRequest?:AbortController;
  private routeLabel='';
  private routeDistance=-1;
  private routeLine=new THREE.Line(new THREE.BufferGeometry(),new THREE.LineBasicMaterial({color:'#f6e5a4',transparent:true,opacity:.65,depthWrite:false}));
  onNavigationChange?:(status:{active:boolean;label?:string;remaining?:number;message?:string})=>void;
  private pendingEntity?:WorldEntity;
  private near?:WorldEntity;
  private raycaster=new THREE.Raycaster();
  private floor=new THREE.Plane(new THREE.Vector3(0,1,0),0);
  private pointerStart?:{x:number;y:number};
  private target=new THREE.Vector3();
  private follow={x:0,z:0};
  private followFacing={x:-1,z:0};
  private companionBehavior=new CompanionBehavior(25);
  private companionTrail=new CompanionTrail();
  private followRequest?:AbortController;
  private followRetryAt=0;
  private direction:WorldDirection='down';
  private time=0;
  private last=0;
  private frame=0;
  private paused=true;
  private stopped=false;
  private loadingGeneration=0;
  private width=1;private height=1;
  private marker:THREE.Mesh;
  private markerAge=0;
  private waves?:THREE.Texture;
  private shadowTexture:THREE.Texture;
  onMove?:(p:Point,distance:number)=>void;
  onInteract?:(entity:WorldEntity)=>void;
  onNear?:(entity?:WorldEntity)=>void;
  onTick?:(seconds:number)=>void;
  constructor(private host:HTMLElement){
    try{const saved=localStorage.getItem('gamma.world.camera-distance.v1');if(saved!==null)this.cameraDistance=clampCameraDistance(Number(saved));}catch{}
    this.renderer=new THREE.WebGLRenderer({antialias:false,powerPreference:'high-performance'});this.renderer.setPixelRatio(Math.min(devicePixelRatio,1.5));
    this.renderer.outputColorSpace=THREE.SRGBColorSpace;this.renderer.toneMapping=THREE.ACESFilmicToneMapping;this.renderer.toneMappingExposure=.92;this.renderer.shadowMap.enabled=true;this.renderer.shadowMap.type=THREE.PCFSoftShadowMap;
    this.canvas=this.renderer.domElement;this.canvas.className='world-canvas';this.canvas.setAttribute('role','img');this.canvas.setAttribute('aria-label','Gamma 岛屿地图，方向键或 WASD 移动，Shift 奔跑，E 互动，点击地面自动寻路，按 M 选择目的地');this.canvas.tabIndex=0;host.append(this.canvas);this.effectsCanvas=document.createElement('canvas');this.effectsCanvas.className='field-effects-canvas';this.effectsCanvas.setAttribute('aria-hidden','true');host.append(this.effectsCanvas);
    this.composer=new EffectComposer(this.renderer);this.composer.addPass(new RenderPass(this.scene,this.camera));
    // Native masked foliage needs alpha-aware depth; the generic BokehPass
    // substitutes opaque depth rectangles and blurs sprite edges incorrectly.
    this.composer.addPass(new OutputPass());
    this.scene.background=new THREE.Color('#a3b992');this.scene.fog=new THREE.Fog('#a3b992',48,95);this.scene.add(this.sky,this.sun,this.sun.target,this.mapGroup,this.battleActors);
    this.sun.castShadow=true;this.sun.shadow.mapSize.set(2048,2048);Object.assign(this.sun.shadow.camera,{left:-12,right:12,top:12,bottom:-12,near:1,far:60});this.sun.shadow.bias=-.0003;this.sun.shadow.normalBias=.04;
    const c=document.createElement('canvas');c.width=c.height=48;const g=c.getContext('2d')!,gradient=g.createRadialGradient(24,24,0,24,24,22);gradient.addColorStop(0,'#0009');gradient.addColorStop(1,'#0000');g.fillStyle=gradient;g.fillRect(0,0,48,48);this.shadowTexture=new THREE.CanvasTexture(c);
    this.marker=new THREE.Mesh(new THREE.RingGeometry(.28,.34,24),new THREE.MeshBasicMaterial({color:'#f6e5a4',transparent:true,opacity:.9,depthWrite:false,side:THREE.DoubleSide}));this.marker.rotation.x=-Math.PI/2;this.marker.visible=false;this.routeLine.visible=false;this.scene.add(this.marker,this.routeLine);
    this.observer=new ResizeObserver(()=>this.resize());this.observer.observe(host);this.resize();
    this.canvas.addEventListener('wheel',this.wheel,{passive:false});this.canvas.addEventListener('pointerdown',this.pointerDown);this.canvas.addEventListener('pointerup',this.pointerUp);
    window.addEventListener('keydown',this.keyDown);window.addEventListener('keyup',this.keyUp);window.addEventListener('blur',this.clearInput);document.addEventListener('visibilitychange',this.clearInput);
    this.frame=requestAnimationFrame(this.animate);
  }
  private texture(image:HTMLImageElement,key:string){let t=this.textures.get(key);if(!t){t=new THREE.Texture(image);t.magFilter=THREE.NearestFilter;t.minFilter=THREE.NearestFilter;t.colorSpace=THREE.SRGBColorSpace;t.needsUpdate=true;this.textures.set(key,t);}return t;}
  private async tile(id:string,w:number,d:number,tileSize=2){
    const source=id==='island-sand'||id==='island-path'?'island-tilesheet':id;const loaded=await loadWorldTexture(source);if(!loaded)return null;
    let t:THREE.Texture;
    if(id==='island-sand'||id==='island-path'){
      // Crop only an observed opaque tile region of the unchanged source sheet.
      const canvas=document.createElement('canvas');canvas.width=canvas.height=64;const g=canvas.getContext('2d')!;g.imageSmoothingEnabled=false;g.drawImage(loaded.image,id==='island-sand'?272:32,id==='island-sand'?400:32,64,64,0,0,64,64);t=new THREE.CanvasTexture(canvas);
    }else t=this.texture(loaded.image,loaded.descriptor.url).clone();
    t.colorSpace=THREE.SRGBColorSpace;t.magFilter=THREE.NearestFilter;t.minFilter=THREE.NearestFilter;t.wrapS=t.wrapT=THREE.RepeatWrapping;t.repeat.set(w/tileSize,d/tileSize);t.needsUpdate=true;this.mapTextures.push(t);return t;
  }
  async load(map:WorldMap,state:WorldSave){
    const version=++this.loadingGeneration;this.paused=true;this.clearInput();this.followRequest?.abort();this.followRequest=undefined;this.near=undefined;this.onNear?.();
    const [,companion]=await Promise.all([loadWorldActor(state.trainer),loadFieldActor(state.partner),...map.entities.filter(e=>e.actor).map(e=>loadWorldActor(e.actor!))]);if(version!==this.loadingGeneration)return;
    if(!companion)throw new Error('伙伴动作资源未能载入，请检查本地服务后重试。');this.followFacing={x:-1,z:0};this.companionBehavior=new CompanionBehavior(state.partner);
    this.disposeMap();this.map=map;this.state=state;this.target.set(state.position.x,0,state.position.z);this.follow={x:state.position.x-.8,z:state.position.z+1};
    const dark=map.theme==='ash',flowers=map.theme==='forest';this.scene.background=new THREE.Color(dark?'#a99e89':'#a9c3b3');this.scene.fog=new THREE.Fog(dark?'#a99e89':'#a9c3b3',50,110);this.sky.intensity=dark?.64:.8;this.sky.color.set(dark?'#c8afa0':'#b1c8cd');this.sun.color.set(dark?'#efa86c':'#f2d691');this.sun.intensity=dark?2.5:3.2;
    if(map.native){
      this.onStatus?.('正在载入原关卡、地形和场景素材…');
      const native=await new NativeWorld(map.native).build();
      if(version!==this.loadingGeneration){native.dispose();return;}
      this.native=native;native.applyDestroyed(state.destroyed);this.mapGroup.add(native.group);native.group.traverse(node=>{if((node as THREE.Mesh).isMesh){const m=(node as THREE.Mesh).material;for(const mat of Array.isArray(m)?m:[m])sourceLitFacing(mat);}});
      const landing=this.findLanding(state.position)??this.findLanding(map.spawn);
      if(!landing)throw new Error('原关卡中未找到可站立的出生位置');
      state.position=landing;this.groundY=native.heightAt(landing)??0;
      this.follow={x:landing.x-.85,z:landing.z};
      this.target.set(landing.x,this.groundY,landing.z);
      const waterColor=WORLD_MATERIALS.get('/Game/MODELS/PROPS/Water/MI_WaterIsland')?.vectorParameters.Color??[0,.4409239888191223,1];
      const sea=new THREE.Mesh(new THREE.PlaneGeometry(map.bounds.w+140,map.bounds.d+140),new THREE.MeshBasicMaterial({color:new THREE.Color().setRGB(waterColor[0],waterColor[1],waterColor[2],THREE.LinearSRGBColorSpace),side:THREE.DoubleSide}));
      sea.rotation.x=-Math.PI/2;sea.position.set(map.bounds.x,-.62,map.bounds.z);this.mapGroup.add(sea);
      this.onStatus?.(`原关卡已载入 · ${native.stats.staticInstances} 个模型实例 · ${native.stats.spriteInstances} 个精灵实例`);
    }else{
    const waterTex=await this.tile('water-loop',map.bounds.w+90,map.bounds.d+90,3);if(version!==this.loadingGeneration)return;this.waves=waterTex??undefined;
    const water=new THREE.Mesh(new THREE.PlaneGeometry(map.bounds.w+90,map.bounds.d+90),new THREE.MeshStandardMaterial({map:waterTex,color:dark?'#526f6b':'#7bb0b1',roughness:.35,metalness:.05}));water.rotation.x=-Math.PI/2;water.position.set(map.bounds.x,-.55,map.bounds.z);water.receiveShadow=true;this.mapGroup.add(water);
    const groundId=map.theme==='beach'?'island-sand':dark?'red-sand':flowers?'blue-grass-tile2':'grass-tile2';
    const groundMat=new THREE.MeshStandardMaterial({map:await this.tile(groundId,2,2,2),roughness:1});
    const cliffMat=new THREE.MeshStandardMaterial({map:await this.tile(dark?'cave-cliff':'cliff-wall',2,2,2),roughness:1,color:'#d8d0ba'});
    for(const r of map.walkable){const topTex=groundMat.map!.clone();topTex.repeat.set(r.w/2,r.d/2);this.mapTextures.push(topTex);const mat=groundMat.clone();mat.map=topTex;
      const top=new THREE.Mesh(new THREE.PlaneGeometry(r.w,r.d),mat);top.rotation.x=-Math.PI/2;top.position.set(r.x,0,r.z);top.receiveShadow=true;this.mapGroup.add(top);
      const land=new THREE.Mesh(new THREE.BoxGeometry(r.w,.68,r.d),cliffMat);land.position.set(r.x,-.36,r.z);land.receiveShadow=true;land.castShadow=true;this.mapGroup.add(land);
    }
    groundMat.dispose();
    for(let i=0;i<map.terrain.length;i++){const r=map.terrain[i],id=r.texture??({path:'island-path',sand:'island-sand',grass:groundId,stone:'stone',flower:'blue-grass-tile1',ash:'red-sand',water:'water-loop'}[r.kind]);const tex=await this.tile(id,r.w,r.d,r.kind==='path'?1.8:2);const p=new THREE.Mesh(new THREE.PlaneGeometry(r.w,r.d),new THREE.MeshStandardMaterial({map:tex,roughness:1,color:r.kind==='ash'?'#d6c3b3':'#ffffff'}));p.rotation.x=-Math.PI/2;p.position.set(r.x,(r.y??.018)+i*.0003,r.z);p.receiveShadow=true;this.mapGroup.add(p);}
    await this.props(map.props);if(version!==this.loadingGeneration)return;
    }
    for(const e of map.entities){if(e.kind==='pickup'&&state.collected.includes(e.id))continue;if(e.asset)await this.props([{x:e.x,z:e.z,asset:e.asset,height:e.kind==='pickup'?.45:1.6}]);if(e.actor)this.visual(e.id);if(['portal','puzzle','heal','trainer'].includes(e.kind)){const ring=new THREE.Mesh(new THREE.RingGeometry(.45,.51,24),new THREE.MeshBasicMaterial({color:e.kind==='portal'?'#e9dd94':e.kind==='heal'?'#a2e5c7':'#e6b374',transparent:true,opacity:.65,side:THREE.DoubleSide,depthWrite:false}));ring.rotation.x=-Math.PI/2;ring.position.set(e.x,(this.native?.heightAt(e)??0)+.045,e.z);this.mapGroup.add(ring);}}
    this.resetCompanion();this.visual('player');this.visual('partner');this.direction='down';this.cameraAt(1);this.paused=false;
  }
  private async props(props:Prop[]){
    const groups=new Map<string,Prop[]>();for(const prop of props){if(prop.kind&&prop.kind!=='sprite'){await this.structure(prop);continue;}const group=groups.get(prop.asset)??[];group.push(prop);groups.set(prop.asset,group);}
    for(const [id,items] of groups){const loaded=await loadWorldTexture(id);if(!loaded||loaded.descriptor.kind!=='billboard')continue;const {descriptor:a,image}=loaded;const geometry=new THREE.PlaneGeometry(a.width/a.height,1);geometry.translate((a.width/2-a.feet[0])/a.height,(a.feet[1]-a.height/2)/a.height,0);
      const mesh=new THREE.InstancedMesh(geometry,new THREE.MeshStandardMaterial({map:this.texture(image,a.url),alphaTest:.45,side:THREE.DoubleSide,roughness:1}),items.length),matrix=new THREE.Matrix4(),q=new THREE.Quaternion();
      items.forEach((p,i)=>{q.setFromAxisAngle(new THREE.Vector3(0,1,0),p.rotation??0);matrix.compose(new THREE.Vector3(p.x,(this.native?.heightAt(p)??0)+.035,p.z),q,new THREE.Vector3(p.height,p.height,p.height));mesh.setMatrixAt(i,matrix);});mesh.instanceMatrix.needsUpdate=true;mesh.castShadow=true;mesh.receiveShadow=false;this.mapGroup.add(mesh);
    }
  }
  private async structure(prop:Prop){
    // These are web proxy shapes, never presented as decoded original StaticMeshes.
    const group=new THREE.Group();group.position.set(prop.x,0,prop.z);group.rotation.y=prop.rotation??0;
    const wood=new THREE.MeshStandardMaterial({color:prop.color??'#907457',roughness:1}),stone=new THREE.MeshStandardMaterial({map:await this.tile('stone',2,2),color:'#d2cdb9',roughness:1});
    const box=(w:number,h:number,d:number,x:number,y:number,z:number,mat:THREE.Material)=>{const m=new THREE.Mesh(new THREE.BoxGeometry(w,h,d),mat);m.position.set(x,y,z);m.castShadow=true;m.receiveShadow=true;group.add(m);return m;};
    if(prop.kind==='tent'){const material=new THREE.MeshStandardMaterial({color:prop.color??'#cfb685',roughness:1,side:THREE.DoubleSide});const roof=new THREE.Mesh(new THREE.CylinderGeometry(0,1,1,3,1),material);roof.rotation.z=Math.PI/2;roof.rotation.y=Math.PI/2;roof.scale.set(prop.height,prop.w??3,prop.d??3);roof.position.y=prop.height*.43;roof.castShadow=true;group.add(roof);box(.07,prop.height, .07,0,prop.height/2,(prop.d??3)*.3,wood);}
    else if(prop.kind==='arch'){for(const x of [-1,1])box(.7,prop.height,.85,x*(prop.w??3)/2,prop.height/2,0,stone);box((prop.w??3)+.8,.7,1,0,prop.height,0,stone);}
    else if(prop.kind==='boat'){box(prop.w??5,.45,prop.d??2.7,0,.15,0,wood);for(const z of [-1,1])box(prop.w??5,.75,.12,0,.7,z*(prop.d??2.7)/2,wood);box(.12,3,.12,0,1.8,0,wood);box(1.4,1.05,1.4,-1,.85,0,new THREE.MeshStandardMaterial({color:'#d2cfa6'}));}
    else if(prop.kind==='pillar')box(prop.w??.75,prop.height,prop.d??.75,0,prop.height/2,0,stone);
    else box(prop.w??1,prop.height,prop.d??1,0,prop.height/2,0,wood);
    this.mapGroup.add(group);
  }
  private visual(id:string){let v=this.actors.get(id);if(v)return v;const mesh=new THREE.Mesh(new THREE.PlaneGeometry(1,1),new THREE.MeshStandardMaterial({alphaTest:.4,side:THREE.DoubleSide,roughness:1}));mesh.geometry.setIndex([0,1,2,2,1,3]);mesh.frustumCulled=false;mesh.castShadow=true;mesh.receiveShadow=true;sourceLitFacing(mesh.material);const shadow=new THREE.Mesh(new THREE.PlaneGeometry(.7,.48),new THREE.MeshBasicMaterial({map:this.shadowTexture,transparent:true,opacity:.7,depthWrite:false,side:THREE.DoubleSide}));shadow.rotation.x=-Math.PI/2;v={mesh,shadow};this.actors.set(id,v);(this.battleRoom?this.battleActors:this.mapGroup).add(mesh,shadow);return v;}
  private renderActor(id:string,sample:WorldSample|FieldActorSample|null,p:Point,height:number,ground?:number,lift=0){if(!sample)return;const v=this.visual(id),frame=sample.frame,scale=height/sample.displayHeight,[fx,fy]=frame.feet;const pos=v.mesh.geometry.attributes.position as THREE.BufferAttribute;const tilt=THREE.MathUtils.degToRad(SOURCE_VIEW.actorTilt),points=[[-fx,fy],[frame.sw-fx,fy],[-fx,fy-frame.sh],[frame.sw-fx,fy-frame.sh]];points.forEach(([px,py],i)=>{if('pmdSample' in sample){const v=fieldActorVertex(sample,px+fx,fy-py);pos.setXYZ(i,v.x,v.y,v.z);}else pos.setXYZ(i,py*scale*Math.sin(tilt),py*scale*Math.cos(tilt),-px*scale);});pos.needsUpdate=true;v.mesh.geometry.computeVertexNormals();
    const uv=v.mesh.geometry.attributes.uv as THREE.BufferAttribute,w=sample.image.width,h=sample.image.height,u=frame.sx/w,r=(frame.sx+frame.sw)/w,t=1-frame.sy/h,b=1-(frame.sy+frame.sh)/h;uv.setXY(0,u,t);uv.setXY(1,r,t);uv.setXY(2,u,b);uv.setXY(3,r,b);uv.needsUpdate=true;
    if(v.sheet!==sample.sheetKey){v.mesh.material.map=this.texture(sample.image,sample.sheetKey);if('pmdSample' in sample){v.mesh.material.emissiveMap=v.mesh.material.map;v.mesh.material.emissive.set('#ffffff');v.mesh.material.emissiveIntensity=1;v.mesh.material.color.set('#000000');v.mesh.material.toneMapped=false;}v.mesh.material.needsUpdate=true;v.sheet=sample.sheetKey;}const y=ground??(id==='player'?this.groundY:(this.native?.heightAt(p)??this.groundY));v.mesh.position.set(p.x+(id==='partner'||id.startsWith('field-')?0:SOURCE_VIEW.actorOffsetX),y+.00232+lift,p.z);v.mesh.rotation.y=0;v.shadow.position.set(p.x,y+.026,p.z);v.shadow.scale.setScalar(height/1.5);if(id==='player'){this.canvas.dataset.modelSizing='source-pixels';this.canvas.dataset.playerWorldHeight=String(height);}if(id==='partner'&&'pmdSample' in sample){this.canvas.dataset.partnerModel='pmd';this.canvas.dataset.partnerSpecies=String(sample.pmdSample.data.id);this.canvas.dataset.partnerWorldHeight=String(sample.worldHeight);this.canvas.dataset.partnerPixelScale=String(sample.pixelWorldScale);this.canvas.dataset.partnerAction=sample.action;}
  }
  private findLanding(p:Point):Point|null{
    if(!this.native)return p;
    const y=this.native.heightAt(p);if(y!==null&&this.native.canMove(p,y)!==null)return {...p};
    for(let r=.4;r<=12;r+=.4)for(let a=0;a<24;a++){
      const q={x:p.x+Math.cos(a*Math.PI/12)*r,z:p.z+Math.sin(a*Math.PI/12)*r};
      const h=this.native.heightAt(q);if(h!==null&&this.native.canMove(q,h)!==null)return q;
    }
    return null;
  }
  private move(p:Point,dx:number,dz:number):Point{
    if(!this.native)return moveOnMap(this.map!,p,dx,dz);
    const steps=Math.max(1,Math.ceil(Math.hypot(dx,dz)/.1)),out={...p};
    for(let i=0;i<steps;i++)for(const axis of ['x','z'] as const){
      const q={...out,[axis]:out[axis]+(axis==='x'?dx:dz)/steps};
      const y=this.native.canMove(q,this.groundY);if(y!==null){out[axis]=q[axis];this.groundY=y;this.companionTrail.record({...out,y});}
    }
    return out;
  }
  private surface(){const native=this.native,map=this.map!;return native??{heightAt:(p:Point)=>canStand(map,p)?0:null,canMove:(p:Point,_y:number)=>canStand(map,p)?0:null};}
  private resetCompanion(position?:WorldPathPoint){
    if(!this.state)return;
    const leader={...this.state.position,y:this.groundY},surface=this.surface();let start=position??leader;
    if(!position)for(const [x,z] of [[-.85,0],[0,.85],[0,-.85],[.85,0]]){
      const candidate=canTravelWorldSegment(surface,leader,{x:leader.x+x,z:leader.z+z});
      if(candidate){start=candidate;break;}
    }
    this.followRequest?.abort();this.followRequest=undefined;this.followRetryAt=0;
    this.companionTrail.reset(start,leader);this.follow={x:start.x,z:start.z};
  }
  private reconnectCompanion(){
    const goal=this.companionTrail.connectionTarget;
    if(!goal||this.followRequest||this.time<this.followRetryAt)return;
    const controller=this.followRequest=new AbortController();this.followRetryAt=this.time+3;
    void findWorldPath({start:this.companionTrail.position,startHeight:this.companionTrail.position.y,goal,goalRadius:.03,surface:this.surface(),signal:controller.signal,timeoutMs:1000}).then(result=>{
      if(controller.signal.aborted||this.followRequest!==controller)return;
      this.followRequest=undefined;
      if(result.status==='found'||result.status==='arrived')this.companionTrail.connect(result.points);
    }).catch(()=>{if(this.followRequest===controller)this.followRequest=undefined;});
  }
  cancelNavigation(){this.stopNavigation();}
  private stopNavigation(message?:string){
    const active=!!this.routeRequest||this.route.length>0;
    this.routeRequest?.abort();this.routeRequest=undefined;this.route=[];this.pendingEntity=undefined;
    this.routeLine.visible=false;this.routeDistance=-1;this.markerAge=0;
    this.canvas.dataset.navigation='idle';
    if(active||message)this.onNavigationChange?.({active:false,message});
  }
  private async navigate(goal:Point&{y?:number},entity?:WorldEntity){
    if(this.paused||!this.state||!this.map)return;
    this.stopNavigation();this.keys.clear();this.joystick={x:0,z:0};const controller=this.routeRequest=new AbortController();
    this.pendingEntity=entity;this.routeLabel=entity?.name??'点击位置';
    this.canvas.dataset.navigation='planning';this.onNavigationChange?.({active:true,label:this.routeLabel,message:'正在规划路线…'});
    try{
      const b=this.map.bounds,bounds={minX:b.x-b.w/2-.5,maxX:b.x+b.w/2+.5,minZ:b.z-b.d/2-.5,maxZ:b.z+b.d/2+.5};
      const result=await findWorldPath({start:{...this.state.position},startHeight:this.groundY,goal,goalHeight:goal.y??this.native?.heightAt(goal)??undefined,goalHeightTolerance:entity ? .6 : .08,goalRadius:entity?1.6:.25,bounds,surface:this.surface(),signal:controller.signal,timeoutMs:6000});
      if(controller.signal.aborted||this.routeRequest!==controller||this.paused)return;
      this.routeRequest=undefined;
      if(result.status==='unreachable'||result.status==='cancelled'){this.stopNavigation(result.reason==='budget'?'这段路线较复杂，请先选择更近的路口。':'这里暂时无法到达，请选择附近的道路。');return;}
      this.route=result.points.filter(p=>Math.hypot(p.x-this.state!.position.x,p.z-this.state!.position.z)>.015);
      if(!this.route.length){this.arrive();return;}
      const endpoint=this.route[this.route.length-1];this.marker.position.set(endpoint.x,endpoint.y+.07,endpoint.z);
      this.canvas.dataset.navigation='walking';this.updateRoute();
    }catch(error){if(!controller.signal.aborted&&this.routeRequest===controller)this.stopNavigation('路线规划未完成，请重新选择目的地。');}
  }
  private arrive(){const entity=this.pendingEntity,label=this.routeLabel;this.stopNavigation(`已抵达${label==='点击位置'?'目的地':label}。`);if(entity&&!this.paused)this.onInteract?.(entity);}
  private updateRoute(){
    if(!this.state||!this.route.length)return;
    let remaining=0,last=this.state.position;for(const p of this.route){remaining+=Math.hypot(p.x-last.x,p.z-last.z);last=p;}
    const rounded=Math.ceil(remaining);
    if(rounded!==this.routeDistance){this.routeDistance=rounded;this.onNavigationChange?.({active:true,label:this.routeLabel,remaining});}
    const points=[new THREE.Vector3(this.state.position.x,this.groundY+.075,this.state.position.z),...this.route.map(p=>new THREE.Vector3(p.x,p.y+.075,p.z))];
    let positions=this.routeLine.geometry.getAttribute('position');
    if(!positions||positions.count!==points.length){this.routeLine.geometry.dispose();this.routeLine.geometry=new THREE.BufferGeometry().setFromPoints(points);}
    else{points.forEach((p,i)=>positions.setXYZ(i,p.x,p.y,p.z));positions.needsUpdate=true;this.routeLine.geometry.computeBoundingSphere();}
    this.routeLine.visible=true;this.markerAge=1;
  }
  private advanceRoute(dt:number,run:boolean){
    if(!this.state)return 0;
    let budget=(run?5.7:3.5)*dt,total=0;
    while(budget>.00001&&this.route.length&&!this.paused){
      const target=this.route[0],current=this.state.position,dx=target.x-current.x,dz=target.z-current.z,distance=Math.hypot(dx,dz);
      if(distance<.00001){this.route.shift();continue;}
      const amount=Math.min(distance,budget,.08),next={x:current.x+dx*amount/distance,z:current.z+dz*amount/distance};
      const y=this.surface().canMove(next,this.groundY);
      if(y===null){this.stopNavigation('前方道路受阻，请重新选择目的地。');break;}
      this.state.position=next;this.groundY=y;budget-=amount;total+=amount;
      const screen=worldToScreen(dx,dz);this.direction=Math.abs(screen.x)>Math.abs(screen.z)?screen.x>0?'right':'left':screen.z>0?'down':'up';
      this.companionTrail.record({...next,y});
      if(amount>=distance-.00001)this.route.shift();
      this.onMove?.(next,amount); // Natural encounters may synchronously pause/cancel the route.
    }
    if(this.route.length)this.updateRoute();else if(total&&!this.paused&&this.canvas.dataset.navigation==='walking')this.arrive();
    return total;
  }
  getCameraDistance(){return this.cameraDistance;}
  setCameraDistance(value:number){this.cameraDistance=clampCameraDistance(value);try{localStorage.setItem('gamma.world.camera-distance.v1',String(this.cameraDistance));}catch{}this.onCameraDistanceChange?.(this.cameraDistance);}
  resetCameraDistance(){this.setCameraDistance(CAMERA_VIEW.defaultDistance);}
  private wheel=(e:WheelEvent)=>{if(this.paused&&!this.field||e.ctrlKey||e.metaKey||!e.deltaY)return;e.preventDefault();this.setCameraDistance(this.cameraDistance+Math.sign(e.deltaY)*.5);};
  setPaused(paused:boolean){this.paused=paused;if(paused)this.clearInput();else this.onNear?.(this.near);}
  setJoystick(x:number,z:number){this.joystick={x,z};if(x||z)this.cancelNavigation();}
  interact(){if(!this.paused&&this.near)this.onInteract?.(this.near);}
  pointToEntity(id:string){const e=this.map?.entities.find(e=>e.id===id&&!this.state?.collected.includes(e.id));if(e)void this.navigate(e,e);}
  private keyDown=(e:KeyboardEvent)=>{if(e.ctrlKey||e.metaKey||e.altKey||e.target instanceof HTMLInputElement||e.target instanceof HTMLTextAreaElement||e.target instanceof HTMLSelectElement)return;const key=e.key.toLowerCase();if((!this.paused||this.field)&&['+','=','-','_','0'].includes(key)){e.preventDefault();if(key==='0')this.resetCameraDistance();else this.setCameraDistance(this.cameraDistance+(['-','_'].includes(key)?.5:-.5));return;}if(this.paused)return;if(['arrowup','arrowdown','arrowleft','arrowright','w','a','s','d','shift'].includes(key)){e.preventDefault();this.keys.add(key);if(key!=='shift')this.cancelNavigation();}if((key==='e'||key==='enter'||key===' ')&&!e.repeat){e.preventDefault();this.interact();}};
  private keyUp=(e:KeyboardEvent)=>this.keys.delete(e.key.toLowerCase());
  private clearInput=()=>{this.keys.clear();this.joystick={x:0,z:0};this.cancelNavigation();};
  private pointerDown=(e:PointerEvent)=>{this.pointerStart={x:e.clientX,y:e.clientY};};
  private pointerUp=(e:PointerEvent)=>{if((this.paused&&!this.field)||!this.map||!this.pointerStart||Math.hypot(e.clientX-this.pointerStart.x,e.clientY-this.pointerStart.y)>12)return;const r=this.canvas.getBoundingClientRect();this.raycaster.setFromCamera(new THREE.Vector2((e.clientX-r.left)/r.width*2-1,1-(e.clientY-r.top)/r.height*2),this.camera);const p=this.battleRoom?this.battleRoom.view.rayPoint(this.raycaster):this.native?this.native.rayPoint(this.raycaster):this.raycaster.ray.intersectPlane(this.floor,new THREE.Vector3());if(!p)return;
    if(this.field){const {origin}=this.field.input;this.onFieldTarget?.({x:p.x-origin.x,z:p.z-origin.z});this.marker.position.set(p.x,p.y+.07,p.z);this.markerAge=1.5;return;}
    const entity=this.map.entities.filter(e=>!this.state?.collected.includes(e.id)).find(e=>Math.hypot(e.x-p.x,e.z-p.z)<1.15);if(entity){this.pointToEntity(entity.id);return;}if(this.native?this.native.heightAt(p)===null:!canStand(this.map,{x:p.x,z:p.z}))return;void this.navigate({x:p.x,z:p.z,y:p.y});};
  private resize(){const r=this.host.getBoundingClientRect();this.width=Math.max(1,r.width);this.height=Math.max(1,r.height);this.renderer.setSize(this.width,this.height,false);this.composer.setSize(this.width,this.height);this.effectsCanvas.width=Math.round(this.width*devicePixelRatio);this.effectsCanvas.height=Math.round(this.height*devicePixelRatio);this.camera.aspect=this.width/this.height;this.roomProjection();this.cameraAt(1);}
  private roomProjection(){
    if(this.battleRoom)this.camera.setViewOffset(this.width,this.height,0,this.height*.15,this.width,this.height);
    else this.camera.clearViewOffset();
    sourceProjection(this.camera);
  }
  private cameraAt(f:number){
    if(!this.state)return;
    // A fixed room view keeps both spawn areas and the enclosing wall visible.
    const p=this.battleRoom?{x:0,z:0}:this.state.position;
    const y=this.battleRoom?0:this.groundY;
    this.target.lerp(new THREE.Vector3(p.x,y+SOURCE_VIEW.capsuleHeight,p.z),f);
    const pitch=THREE.MathUtils.degToRad(SOURCE_VIEW.pitch);
    const roomFit=7/(Math.tan(THREE.MathUtils.degToRad(this.camera.fov/2))*this.camera.aspect)+4;
    const distance=this.battleRoom?Math.max(16.5,roomFit,cameraArmForViewport(this.cameraDistance,this.camera.aspect)):cameraArmForViewport(this.cameraDistance,this.camera.aspect);
    this.cameraArm=THREE.MathUtils.lerp(this.cameraArm,distance,f);const arm=this.cameraArm;
    this.camera.position.set(this.target.x-Math.cos(pitch)*arm,this.target.y+Math.sin(pitch)*arm,this.target.z);
    this.camera.lookAt(this.target);this.camera.updateMatrixWorld();
    this.sun.position.set(this.target.x-13.74668,this.target.y+10.40276,this.target.z+10.13958);this.sun.target.position.copy(this.target);
  }

  private animate=(now:number)=>{if(this.stopped)return;const elapsed=this.last?Math.max(0,(now-this.last)/1000):0,dt=Math.min(.045,elapsed);this.last=now;this.time+=dt;
    const s=this.state,map=this.map;let moving=false,run=false;
    if(s&&map){if(!this.paused&&!document.hidden){const inputX=Number(this.keys.has('d')||this.keys.has('arrowright'))-Number(this.keys.has('a')||this.keys.has('arrowleft'))+this.joystick.x,inputZ=Number(this.keys.has('s')||this.keys.has('arrowdown'))-Number(this.keys.has('w')||this.keys.has('arrowup'))+this.joystick.z;let {x,z}=screenToWorld(inputX,inputZ);
      run=this.keys.has('shift');
      if(!x&&!z&&this.route.length)moving=this.advanceRoute(dt,run)>.0001;
      const n=Math.hypot(x,z);if(n>.06&&!this.paused){const speed=run?5.7:3.5,next=this.move(s.position,x/n*speed*dt,z/n*speed*dt),dist=Math.hypot(next.x-s.position.x,next.z-s.position.z);moving=dist>.0001;if(moving){s.position=next;this.companionTrail.record({...next,y:this.groundY});const screen=worldToScreen(x,z);this.direction=Math.abs(screen.x)>Math.abs(screen.z)?screen.x>0?'right':'left':screen.z>0?'down':'up';this.onMove?.(next,dist);}}
      const nearest=map.entities.filter(e=>!s.collected.includes(e.id)).map(e=>({e,d:Math.hypot(e.x-s.position.x,e.z-s.position.z)})).filter(p=>p.d<1.85).sort((a,b)=>a.d-b.d)[0]?.e;
      if(nearest?.id!==this.near?.id){this.near=nearest;this.onNear?.(nearest);}this.onTick?.(dt);
    }
    this.renderActor('player',sampleWorldActor(s.trainer,moving?run?'Run':'Walk':'Idle',this.direction,this.time),s.position,MODEL_PIXEL_WORLD_SCALE*(WORLD_ACTORS.get(s.trainer)?.displayHeight??31));
    if(!this.field){
      const followStep=this.companionTrail.step(this.paused?0:dt,this.surface());this.follow=followStep.position;
      if(followStep.blocked&&!this.paused)this.reconnectCompanion();
      const velocity=followStep.velocity,walking=Math.hypot(velocity.x,velocity.z)>.05;
      if(walking)this.followFacing={...velocity};
      // Attention uses real elapsed time; a slow GPU must not turn a five-second
      // glance interval into a minute. Physical travel keeps its capped step.
      const behavior=this.companionBehavior.step(this.paused||document.hidden?0:Math.min(1,elapsed),{moving:walking,facing:this.followFacing});
      const companion=sampleCompanionActor(s.partner,this.time,{level:s.level,velocity,facing:behavior.facing,ambient:behavior.ambient});
      this.canvas.dataset.partnerAmbient=walking?'walking':behavior.ambient.mode;
      this.canvas.dataset.partnerAmbientEvent=String(behavior.ambient.event);
      this.canvas.dataset.partnerAmbientSeconds=behavior.ambient.seconds.toFixed(2);
      if(companion){this.renderActor('partner',companion,this.follow,companion.worldHeight,followStep.position.y,companion.lift);this.canvas.dataset.partnerDirection=String(companion.direction);this.canvas.dataset.partnerLift=String(companion.lift);}
    }
    for(const entity of map.entities)if(entity.actor)this.renderActor(entity.id,sampleWorldActor(entity.actor,'Idle',entity.facing??'down',this.time),entity,(WORLD_ACTORS.get(entity.actor)?.displayHeight??31)*.04);
    if(this.field)this.animateField(dt,now);this.cameraAt(ease(7,dt));}
    this.native?.tick(this.time);if(this.waves&&!this.paused)this.waves.offset.x=this.time*.012;this.markerAge=Math.max(0,this.markerAge-dt);this.marker.visible=this.markerAge>0;this.composer.render();this.drawFieldEffects();this.frame=requestAnimationFrame(this.animate);
  };
  async prepareEncounter(opponent:number,seed:number):Promise<BattleRoomLayout>{
    if(!this.native||!this.state||!this.map)throw new Error('请等待地图载入后再开始交锋。');
    const version=this.loadingGeneration;
    this.preparedRoom?.view.dispose();this.preparedRoom=undefined;
    const assets=await Promise.all([loadFieldActor(this.state.partner),loadFieldActor(opponent)]);
    if(assets.some(asset=>!asset))throw new Error('战斗动作资源未能载入，请检查本地服务后重试。');
    const map=this.map,position={...this.state.position};
    const patch=map.terrain.filter(p=>Math.abs(position.x-p.x)<=p.w/2&&Math.abs(position.z-p.z)<=p.d/2).sort((a,b)=>a.w*a.d-b.w*b.d)[0];
    const themeTexture={beach:'island-sand',meadow:'grass-tile2',forest:'blue-grass-tile2',ash:'red-sand',ruins:'stone'};
    const patchTexture:Record<string,string>={path:'island-path',sand:'island-sand',grass:'grass-tile2',stone:'stone',flower:'blue-grass-tile2',ash:'red-sand'};
    const context:RoomContext={mapId:map.id,mapName:map.name,theme:map.theme,position,
      groundTexture:patch?.texture??patchTexture[patch?.kind??'']??themeTexture[map.theme],palette:this.native.encounterPalette(position)};
    const layout=generateBattleRoom(context,seed),view=new GeneratedBattleRoom(layout,this.native);
    try{await view.build();if(version!==this.loadingGeneration||this.stopped)throw new Error('探索地图已变化，请重新发起遭遇。');}
    catch(error){view.dispose();throw error;}
    this.preparedRoom={layout,view};return layout;
  }
  startFieldBattle(layout:BattleRoomLayout){
    const prepared=this.preparedRoom;
    if(!prepared||prepared.layout!==layout)throw new Error('本次战斗房间尚未准备完成。');
    this.preparedRoom=undefined;this.endFieldBattle();this.setPaused(true);
    this.followRequest?.abort();this.followRequest=undefined;
    this.battleRoom={...prepared,returnFollow:{...this.follow,y:this.companionTrail.position.y}};
    this.field={input:layout.field,timeline:new Timeline(),tick:0,received:performance.now()};
    this.mapGroup.visible=false;this.scene.add(prepared.view.group);this.battleActors.visible=true;
    const partner=this.actors.get('partner');if(partner)this.battleActors.add(partner.mesh,partner.shadow);
    const sample=this.state&&sampleCompanionActor(this.state.partner,0);
    if(sample)this.renderActor('partner',sample,layout.field.playerStart,sample.worldHeight,0);
    this.markerAge=0;this.fieldEffects.reset();this.roomProjection();this.cameraAt(1);
    this.canvas.dataset.battleScene='generated-room';this.canvas.dataset.roomSeed=String(layout.seed);this.canvas.dataset.roomTemplate=layout.templateId;
    this.canvas.dataset.roomSource=layout.context.mapId;this.canvas.dataset.roomNearbyProps=String(layout.context.palette.length);
    this.canvas.setAttribute('aria-label','随机环境战斗房间，中央空地交锋，点击地面指挥走位，外围岩石和树木不可破坏');
  }
  updateFieldBattle(snapshot:GammaBattle){
    const field=this.field;if(!field)return;const range=field.timeline.ingest(snapshot);
    if(!field.snapshot||range.gap)field.tick=Math.max(range.first,snapshot.tick-2);
    field.snapshot=snapshot;field.received=performance.now();this.fieldEffects.ingest(snapshot);
  }
  private fieldGround(x:number,z:number){
    const f=this.field;if(!f)return this.groundY;const t=f.input.terrain;
    return fieldHeightAt(t,{x,z})??0;
  }
  private animateField(dt:number,now:number){
    const f=this.field;if(!f?.snapshot)return;
    const latest=f.snapshot.tick,desired=Math.min(latest,latest-2+(now-f.received)/1000*f.snapshot.tickRate);
    f.tick=Math.min(latest,Math.max(f.tick,Math.min(desired,f.tick+dt*f.snapshot.tickRate*1.2)));
    this.fieldEffects.advance(f.tick);
    const broken=this.fieldEffects.consumeBrokenObstacleIds();
    // The complete authoritative list also recovers destruction after a missed event window.
    if(f.tick>=latest-.01)broken.push(...(f.snapshot.field?.destroyed??[]));
    if(broken.length)this.battleRoom?.view.applyDestroyed(broken);
    const frame=f.timeline.at(f.tick);if(!frame)return;
    for(const actor of frame.fighters){const sample=sampleFieldActor(actor,f.tick,{...this.fieldEffects.actorTiming(actor.id),tickRate:f.snapshot.tickRate});if(!sample)continue;
      const p={x:actor.x+f.input.origin.x,z:actor.z+f.input.origin.z},id=actor.id===f.snapshot.playerId?'partner':'field-'+actor.id;
      this.renderActor(id,sample,p,sample.worldHeight,this.fieldGround(actor.x,actor.z),sample.lift);
      const visual=this.actors.get(id)!;visual.mesh.visible=!sample.hidden;visual.shadow.visible=!sample.hidden;
      visual.mesh.userData.action=sample.action;
    }
  }
  private drawFieldEffects(){
    const canvas=this.effectsCanvas,g=canvas.getContext('2d')!;g.setTransform(1,0,0,1,0,0);g.clearRect(0,0,canvas.width,canvas.height);
    const field=this.field,frame=field?.timeline.at(field.tick);if(!field?.snapshot||!frame)return;
    g.setTransform(devicePixelRatio,0,0,devicePixelRatio,0,0);
    const samples=new Map(frame.fighters.map(f=>[f.id,sampleFieldActor(f,field.tick,{...this.fieldEffects.actorTiming(f.id),tickRate:field.snapshot!.tickRate})]));
    const project=(x:number,z:number,worldY:number)=>{const v=new THREE.Vector3(x+field.input.origin.x,worldY,z+field.input.origin.z).project(this.camera);return{x:(v.x+1)*this.width/2,y:(1-v.y)*this.height/2};};
    const options={tick:field.tick,frame,samples,project,groundAt:(x:number,z:number)=>this.fieldGround(x,z),reduced:matchMedia('(prefers-reduced-motion: reduce)').matches};
    this.fieldEffects.render(g,{...options,layer:'back'});this.fieldEffects.render(g,{...options,layer:'front'});
  }
  endFieldBattle(){
    const room=this.battleRoom;this.battleRoom=undefined;
    this.preparedRoom?.view.dispose();this.preparedRoom=undefined;
    if(room){this.scene.remove(room.view.group);room.view.dispose();this.resetCompanion(room.returnFollow);}
    this.field=undefined;this.fieldEffects.reset();this.mapGroup.visible=true;
    for(const [id,visual] of this.actors)if(id.startsWith('field-')){visual.mesh.removeFromParent();visual.shadow.removeFromParent();visual.mesh.geometry.dispose();visual.mesh.material.dispose();visual.shadow.geometry.dispose();(visual.shadow.material as THREE.Material).dispose();this.actors.delete(id);}
    const partner=this.actors.get('partner');if(partner){this.mapGroup.add(partner.mesh,partner.shadow);partner.mesh.visible=true;partner.shadow.visible=true;}
    this.markerAge=0;this.effectsCanvas.getContext('2d')?.clearRect(0,0,this.effectsCanvas.width,this.effectsCanvas.height);
    this.canvas.dataset.battleScene='exploration';delete this.canvas.dataset.roomSeed;delete this.canvas.dataset.roomTemplate;delete this.canvas.dataset.roomSource;delete this.canvas.dataset.roomNearbyProps;
    this.roomProjection();if(room)this.cameraAt(1);
    this.canvas.setAttribute('aria-label','Gamma 岛屿地图，方向键或 WASD 移动，Shift 奔跑，E 互动，点击地面自动寻路，按 M 选择目的地');
  }
  minimap(){return this.native?.createMinimap();}
  project(p:Point){const v=new THREE.Vector3(p.x,(this.native?.heightAt(p)??0)+1.5,p.z).project(this.camera);return{x:(v.x+1)*this.width/2,y:(1-v.y)*this.height/2};}
  private disposeMap(){this.followRequest?.abort();this.followRequest=undefined;this.endFieldBattle();if(this.native){this.mapGroup.remove(this.native.group);this.native.dispose();this.native=undefined;}this.actors.clear();this.mapGroup.traverse(o=>{if(o instanceof THREE.Mesh){o.geometry.dispose();for(const m of Array.isArray(o.material)?o.material:[o.material])m.dispose();}});this.mapGroup.clear();for(const t of this.mapTextures)t.dispose();this.mapTextures=[];this.waves=undefined;}
  dispose(){this.stopped=true;++this.loadingGeneration;cancelAnimationFrame(this.frame);this.observer.disconnect();this.clearInput();this.disposeMap();this.shadowTexture.dispose();this.routeLine.geometry.dispose();this.routeLine.material.dispose();for(const t of this.textures.values())t.dispose();this.composer.dispose();this.renderer.dispose();this.canvas.removeEventListener('wheel',this.wheel);this.canvas.removeEventListener('pointerdown',this.pointerDown);this.canvas.removeEventListener('pointerup',this.pointerUp);window.removeEventListener('keydown',this.keyDown);window.removeEventListener('keyup',this.keyUp);window.removeEventListener('blur',this.clearInput);document.removeEventListener('visibilitychange',this.clearInput);this.host.replaceChildren();}
}
