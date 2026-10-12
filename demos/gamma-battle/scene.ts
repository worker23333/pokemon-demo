import * as THREE from 'three';
import { Timeline, eventKey, eventTick, hazardPhase } from '../../apps/web/arena/timeline';
import species from '../../packages/content/species.json';
import { loadGammaActor, sampleGammaActor, GAMMA_ENVIRONMENT } from './gamma-assets';
import { pmdActionFor } from '../../packages/presentation/pmd-sprites.js';
import { fxFor, type Snapshot, type SnapFighter, type SnapEvent } from '../../apps/web/arena/types';

// This scene is a web reconstruction from the public forest battle screenshot.
// Original extracted Gamma sprites and environment textures; layout, lighting and realtime movement are web adaptations.
type Actor = { mesh: THREE.Mesh; shadow: THREE.Mesh; geometry: THREE.PlaneGeometry; material: THREE.MeshBasicMaterial; hurtTick: number; faintAt?: number; sheet?: string };
const clamp = THREE.MathUtils.clamp;
const heights=new Map(species.map(s=>[s.id,s.heightDm]));
const battleSpeciesHeight=(id:number)=>Math.min(4.4,2.2+Math.sqrt(heights.get(id)??7)*.24);
function random(seed: number) { return () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; }; }
const palette = { fire: '#ff9a3b', water: '#61d6ec', electric: '#ffe15c', grass: '#90d56f', psychic: '#ed9aea', normal: '#d6d2b3', ground: '#b09160', rock: '#bcad8c', ice: '#b7eeef', poison: '#b579d0', fighting: '#ea9270', ghost: '#ae86d4', bug: '#b9d96c', flying: '#d3ebde', dragon: '#9a9ef5' };
const colorFor = (type: string) => palette[type as keyof typeof palette] || '#dadccb';
function canvasTexture(canvas: HTMLCanvasElement) { const t = new THREE.CanvasTexture(canvas); t.magFilter = THREE.NearestFilter; t.minFilter = THREE.NearestFilter; t.colorSpace = THREE.SRGBColorSpace; return t; }
function shadowTexture() { const c=document.createElement('canvas');c.width=c.height=64;const g=c.getContext('2d')!, grad=g.createRadialGradient(32,32,2,32,32,30);grad.addColorStop(0,'#0009');grad.addColorStop(1,'#0000');g.fillStyle=grad;g.fillRect(0,0,64,64);return canvasTexture(c); }

export class GammaScene {
  private renderer: THREE.WebGLRenderer;
  private world = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(39, 16/9, .1, 150);
  private timeline = new Timeline();
  private snapshot?: Snapshot;
  private received = 0;
  private frameId=0;
  private actors = new Map<string,Actor>();
  private textures = new Map<string,THREE.Texture>();
  private ownedTextures:THREE.Texture[]=[];
  private obstacles = new Map<string,THREE.Object3D>();
  private effectCanvas = document.createElement('canvas');
  private g:CanvasRenderingContext2D;
  private resizeObserver:ResizeObserver;
  private effects: SnapEvent[]=[];
  private seen = new Set<string>();
  private delivered = new Set<string>();
  private presentationTimes = new Map<string,number>();
  private reduced=false;
  private overhead=false;
  private width=1; private height=1;
  private arenaBounds={x:7,z:5};
  private actorEnvelope={side:2,top:4.4,bottom:0};
  private framingPending=false;
  private battleViewport={left:0,top:0,right:1,bottom:1};
  private environmentReady:Promise<void>;
  private time=0;
  private last=performance.now();
  private shadowMap=shadowTexture();
  private disposed=false;
  private leaves:THREE.Points;
  private currentTick=0;
  onFrame?: (fighters:SnapFighter[],tick:number)=>void;
  onEvent?: (event:SnapEvent)=>void;
  constructor(private host:HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({antialias:false,alpha:false,powerPreference:'high-performance'});
    this.renderer.setPixelRatio(1);this.renderer.outputColorSpace=THREE.SRGBColorSpace;this.renderer.shadowMap.enabled=true;this.renderer.shadowMap.type=THREE.PCFSoftShadowMap;
    this.renderer.setClearColor('#b7cfa2');this.renderer.domElement.className='world-canvas';this.renderer.domElement.setAttribute('aria-label','林间实时战斗场景');
    this.world.background=new THREE.Color('#b7cfa2');this.world.fog=new THREE.Fog('#83966a',30,77);
    this.effectCanvas.className='effect-canvas';this.effectCanvas.setAttribute('aria-hidden','true');this.g=this.effectCanvas.getContext('2d')!;
    this.host.append(this.renderer.domElement,this.effectCanvas);this.ownedTextures.push(this.shadowMap);
    this.environmentReady=this.buildForest();
    const r=random(75),positions=new Float32Array(65*3);
    for(let i=0;i<65;i++){positions[i*3]=r()*30-15;positions[i*3+1]=r()*9+.5;positions[i*3+2]=r()*23-13;}
    const leafGeometry=new THREE.BufferGeometry();leafGeometry.setAttribute('position',new THREE.BufferAttribute(positions,3));
    this.leaves=new THREE.Points(leafGeometry,new THREE.PointsMaterial({color:'#d5da8d',size:.06,transparent:true,opacity:.65}));this.world.add(this.leaves);
    this.resizeObserver=new ResizeObserver(()=>this.resize());this.resizeObserver.observe(host);this.resize();
    this.frameId=requestAnimationFrame(this.draw);
  }
  private async buildForest() {
    this.world.add(new THREE.HemisphereLight('#e9f5d1','#44552d',2.0));
    const sun=new THREE.DirectionalLight('#fff0b0',2.9);sun.position.set(-13,23,6);sun.castShadow=true;sun.shadow.mapSize.set(2048,2048);
    Object.assign(sun.shadow.camera,{left:-25,right:25,top:25,bottom:-25,near:.1,far:85});sun.shadow.bias=-.0003;sun.shadow.normalBias=.04;this.world.add(sun);
    const loader=new THREE.TextureLoader(),textures=new Map<string,THREE.Texture>();
    await Promise.all(GAMMA_ENVIRONMENT.map(async asset=>{const texture=await loader.loadAsync(asset.url);texture.magFilter=THREE.NearestFilter;texture.minFilter=THREE.NearestFilter;texture.colorSpace=THREE.SRGBColorSpace;this.ownedTextures.push(texture);textures.set(asset.id,texture);}));
    if(this.disposed)return;
    const ground=textures.get('ground-tile')!;ground.wrapS=ground.wrapT=THREE.RepeatWrapping;ground.repeat.set(35,35);
    const floor=new THREE.Mesh(new THREE.PlaneGeometry(140,140),new THREE.MeshStandardMaterial({map:ground,roughness:1,color:'#b1c77b'}));floor.rotation.x=-Math.PI/2;floor.receiveShadow=true;this.world.add(floor);
    const soilCanvas=document.createElement('canvas');soilCanvas.width=soilCanvas.height=256;const g=soilCanvas.getContext('2d')!,r=random(89);
    for(let i=0;i<22000;i++){const x=r()*256,y=r()*256,d=Math.hypot((x-128)/128,(y-128)/128);if(d>.85+r()*.15)continue;g.fillStyle=['#ae974f','#c1a25c','#b29b58','#ccad6a','#9e9549'][i%5];g.fillRect(x,y,2+r()*5,2+r()*3);}
    const soil=canvasTexture(soilCanvas);this.ownedTextures.push(soil);
    for(const x of [-4,4]){const patch=new THREE.Mesh(new THREE.PlaneGeometry(5.7,4.7),new THREE.MeshStandardMaterial({map:soil,transparent:true,alphaTest:.4,roughness:1}));patch.rotation.x=-Math.PI/2;patch.position.set(x,.018,0);patch.receiveShadow=true;this.world.add(patch);}
    const geometryCache=new Map<string,THREE.PlaneGeometry>(),materialCache=new Map<string,THREE.MeshStandardMaterial>();
    const sprite=(id:string,x:number,z:number,height:number,rotation=-.52)=>{
      const asset=GAMMA_ENVIRONMENT.find(a=>a.id===id)!;let geometry=geometryCache.get(id),material=materialCache.get(id);
      if(!geometry){geometry=new THREE.PlaneGeometry(asset.width/asset.height,1);geometry.translate((asset.width/2-asset.feet[0])/asset.height,(asset.feet[1]-asset.height/2)/asset.height,0);geometryCache.set(id,geometry);}
      if(!material){material=new THREE.MeshStandardMaterial({map:textures.get(id),transparent:true,alphaTest:.5,side:THREE.DoubleSide,roughness:1});materialCache.set(id,material);}
      const mesh=new THREE.Mesh(geometry,material);mesh.position.set(x,.025,z);mesh.scale.setScalar(height);mesh.rotation.y=rotation;mesh.castShadow=true;mesh.receiveShadow=true;this.world.add(mesh);return mesh;
    };
    for(let i=0;i<92;i++){const x=(r()-.5)*65,z=i<55?-9-r()*28:(r()-.5)*40;if(Math.abs(x)<10.5&&z>-8||z>3&&Math.abs(x)<16)continue;sprite(`tree-${i%3+1}`,x,z,7+r()*7,-.5+(r()-.5)*.25);}
    for(let i=0;i<550;i++){let x=(r()-.5)*40,z=(r()-.5)*32;if(Math.abs(x)<8.3&&Math.abs(z)<5.9)continue;if(z>5&&Math.abs(x)<14)continue;sprite(`grass-${i%2+1}`,x,z,.3+r()*.8,-.5+(r()-.5)*.4);}
    for(let i=0;i<35;i++){const x=(r()-.5)*40,z=-8-r()*15;sprite(`rock-${i%2+1}`,x,z,.45+r()*.8);}
  }
  private resize() { const box=this.host.getBoundingClientRect();this.width=Math.max(1,box.width);this.height=Math.max(1,box.height);
    // Subtle pixel resolution applies to the scene; the HUD remains crisp.
    const w=Math.min(1440,Math.round(this.width)),h=Math.round(w*this.height/this.width);
    this.renderer.setSize(w,Math.max(1,h),false);this.effectCanvas.width=Math.round(this.width*Math.min(2,devicePixelRatio));this.effectCanvas.height=Math.round(this.height*Math.min(2,devicePixelRatio));
    this.camera.aspect=this.width/this.height;this.camera.updateProjectionMatrix();this.cameraPose(); }
  private safeBattleViewport() {
    const box=this.host.getBoundingClientRect(),shell=this.host.parentElement!,pad=Math.max(10,this.width*.016);
    const rect=(selector:string)=>{const node=shell.querySelector<HTMLElement>(selector);if(!node||node.hidden)return null;const r=node.getBoundingClientRect();return{left:r.left-box.left,top:r.top-box.top,right:r.right-box.left,bottom:r.bottom-box.top,height:r.height,width:r.width,node};};
    const commands=rect('#commands'),player=rect('#player-hud'),enemy=rect('#enemy-hud'),label=rect('.battle-label');
    if(!commands)return{left:pad,top:this.height*.12,right:this.width-pad,bottom:this.height*.82};
    if(commands.width<this.width*.6){
      // Reserve the entire command column even while FIGHT is collapsed. The
      // fixed match framing cannot jump or hide a fighter when moves open.
      return{left:pad,top:Math.max(this.height*.19,(label?.bottom??0)+pad),right:Math.max(pad+40,commands.left-pad),bottom:Math.max(pad+60,(player?.top??this.height*.82)-pad)};
    }
    // Portrait commands share the width of the battlefield. Measure the same
    // four-move grid while it is hidden, without changing the DOM or user state.
    const css=(selector:string)=>{const node=shell.querySelector<HTMLElement>(selector);return node?getComputedStyle(node):null;};
    const px=(value:string|undefined)=>Number.parseFloat(value??'0')||0;
    const grid=css('#moves'),move=css('#moves .move'),feedback=rect('.feedback'),tactics=rect('.tactics');
    const rowHeight=Math.max(52,px(move?.height),px(move?.minHeight));
    const gridHeight=rowHeight*2+px(grid?.rowGap)+px(grid?.paddingTop)+px(grid?.paddingBottom)+px(grid?.borderTopWidth)+px(grid?.borderBottomWidth)+px(grid?.marginBottom);
    const expandedHeight=Math.max(48,feedback?.height??0)+7+gridHeight+22+(tactics?.height??40)+3;
    return{left:pad,top:Math.max(player?.bottom??0,enemy?.bottom??0,(label?.bottom??0))+pad,right:this.width-pad,bottom:Math.max(this.height*.4,commands.bottom-expandedHeight-pad)};
  }
  private cameraPose() {
    this.camera.clearViewOffset();this.camera.zoom=1;
    if(this.overhead){this.camera.position.set(1,22,17);this.camera.lookAt(0,0,0);}
    else{this.camera.position.set(-13.8,7.4,18.6);this.camera.lookAt(.5,.6,-.4);}
    this.camera.updateProjectionMatrix();this.camera.updateMatrixWorld();
    const safe=this.safeBattleViewport();this.battleViewport=safe;
    // Fit a fixed envelope around every legal ground position plus every
    // original animation's visible pixels. This changes only projection; all
    // actors, shadows, hazards and obstacles keep authoritative world positions.
    const {x,z}=this.arenaBounds,{side,top,bottom}=this.actorEnvelope,points:THREE.Vector3[]=[];
    for(const px of [-x-side,x+side])for(const pz of [-z-side,z+side])for(const py of [bottom,top])points.push(new THREE.Vector3(px,py,pz));
    const projectedBounds=()=>{let left=Infinity,right=-Infinity,upper=Infinity,lower=-Infinity;for(const p of points){const q=p.clone().project(this.camera),sx=(q.x+1)*this.width/2,sy=(1-q.y)*this.height/2;left=Math.min(left,sx);right=Math.max(right,sx);upper=Math.min(upper,sy);lower=Math.max(lower,sy);}return{left,right,top:upper,bottom:lower};};
    let bounds=projectedBounds();
    this.camera.zoom=Math.min((safe.right-safe.left)/(bounds.right-bounds.left),(safe.bottom-safe.top)/(bounds.bottom-bounds.top));
    this.camera.updateProjectionMatrix();bounds=projectedBounds();
    const dx=(safe.left+safe.right-bounds.left-bounds.right)/2,dy=(safe.top+safe.bottom-bounds.top-bounds.bottom)/2;
    this.camera.setViewOffset(this.width,this.height,-dx,-dy,this.width,this.height);
    this.camera.updateMatrixWorld();this.framingPending=false;
  }
  setReduced(value:boolean) {this.reduced=value;this.leaves.visible=!value;}
  setCamera(value:string) {this.overhead=value==='overview';this.cameraPose();}
  async prepare(ids:number[]) { await this.environmentReady;const data=await Promise.all(ids.map(loadGammaActor));if(data.some(x=>!x))throw new Error('所选角色缺少完整 Gamma 动作素材。');
    const envelope={side:0,top:0,bottom:0};
    for(const actor of data){if(!actor)continue;const scale=battleSpeciesHeight(actor.data.id)/actor.data.displayHeight;for(const animation of Object.values(actor.data.animations))for(const frame of animation.frames){const [x0,y0,x1,y1]=frame.alphaBounds,[fx,fy]=frame.feet;envelope.side=Math.max(envelope.side,Math.abs(x0-fx)*scale,Math.abs(x1-fx)*scale);envelope.top=Math.max(envelope.top,(fy-y0)*scale+.04);envelope.bottom=Math.min(envelope.bottom,(fy-y1)*scale+.04);}}
    this.actorEnvelope=envelope;this.framingPending=true;
  }
  update(snapshot:Snapshot) {if(this.snapshot && snapshot.id!==this.snapshot.id) this.reset();
    if(this.snapshot && (snapshot.tick<this.snapshot.tick || this.snapshot.status==='finished'&&snapshot.status!=='finished'))return;
    const first=!this.snapshot;
    const bounds=(snapshot as Snapshot&{bounds?:{x:number;z:number}}).bounds;
    if(bounds&&Number.isFinite(bounds.x)&&Number.isFinite(bounds.z)&&bounds.x>0&&bounds.z>0&&(bounds.x!==this.arenaBounds.x||bounds.z!==this.arenaBounds.z)){this.arenaBounds={...bounds};this.framingPending=true;}
    if(first)this.framingPending=true;
    this.snapshot=snapshot;this.received=performance.now();const ingested=this.timeline.ingest(snapshot);
    // A new match or missing history must not inherit another match's render clock.
    if(first||ingested.gap)this.currentTick=Math.max(ingested.first,snapshot.tick-3);
    for(const e of snapshot.events){const key=eventKey(e);if(!this.seen.has(key)){this.seen.add(key);this.effects.push(e);}}
  }
  private reset() {this.timeline=new Timeline();this.snapshot=undefined;this.currentTick=0;this.received=0;this.effects=[];this.seen.clear();this.delivered.clear();this.presentationTimes.clear();this.g.clearRect(0,0,this.width,this.height);for(const a of this.actors.values()){this.world.remove(a.mesh,a.shadow);a.geometry.dispose();a.material.dispose();a.shadow.geometry.dispose();(a.shadow.material as THREE.Material).dispose();}this.actors.clear();for(const o of this.obstacles.values())this.disposeObject(o);this.obstacles.clear();}
  private actor(f:SnapFighter):Actor {let a=this.actors.get(f.id);if(a)return a;
    const geometry=new THREE.PlaneGeometry(1,1),material=new THREE.MeshBasicMaterial({transparent:true,alphaTest:.3,side:THREE.DoubleSide});
    const mesh=new THREE.Mesh(geometry,material);mesh.frustumCulled=false;
    const shadow=new THREE.Mesh(new THREE.PlaneGeometry(1.8,1.3),new THREE.MeshBasicMaterial({map:this.shadowMap,transparent:true,depthWrite:false,opacity:.8}));shadow.rotation.x=-Math.PI/2;
    a={mesh,shadow,geometry,material,hurtTick:-999};this.actors.set(f.id,a);this.world.add(mesh,shadow);return a;}
  private updateActor(f:SnapFighter,tick:number) {
    const a=this.actor(f),rate=this.snapshot?.tickRate??20,moving=Math.hypot(f.vx??0,f.vz??0)*rate;
    const phase=f.phase??f.cast?.phase,casting=!!f.cast&&['windup','active'].includes(phase??'');
    const sustained=phase==='active'&&['channel','stream','beam'].includes(f.cast?.shape??'');
    const hurt=!sustained&&tick>=a.hurtTick&&tick-a.hurtTick<4;
    // Faint presentation needs its own elapsed time after the authoritative final tick freezes.
    if(f.hp<=0&&a.faintAt==null)a.faintAt=this.time;
    const faintSeconds=Math.max(0,this.time-(a.faintAt??this.time));
    const action=pmdActionFor({hp:f.hp,status:f.status??undefined,hurt:hurt?1:0,cast:f.cast,phase,speed:moving});
    const dirX=casting?f.cast?.dirX??f.facingX??1:moving>.4?f.vx??0:f.facingX??1;
    const dirZ=casting?f.cast?.dirZ??f.facingZ??0:moving>.4?f.vz??0:f.facingZ??0;
    const origin=this.project(f.x,0,f.z),aim=this.project(f.x+dirX,0,f.z+dirZ);
    const towardCamera=dirX*(this.camera.position.x-f.x)+dirZ*(this.camera.position.z-f.z);
    const view=towardCamera>0?'front':'back';
    const seconds=action==='Hurt'?(tick-a.hurtTick)/rate:action==='Faint'?faintSeconds:f.cast?Math.max(0,tick-(f.phase==='windup'?(f.cast.startTick??f.cast.start):(f.cast.activeTick??f.cast.active)))/rate:tick/rate;
    const sample=sampleGammaActor(f.speciesId,action,this.reduced&&action==='Idle'?0:seconds,view);
    if(!sample){a.mesh.visible=false;a.shadow.visible=false;return;}
    if(a.sheet!==sample.sheetKey){let texture=this.textures.get(sample.sheetKey);if(!texture){texture=new THREE.Texture(sample.image);texture.magFilter=THREE.NearestFilter;texture.minFilter=THREE.NearestFilter;texture.colorSpace=THREE.SRGBColorSpace;texture.needsUpdate=true;this.textures.set(sample.sheetKey,texture);}a.material.map=texture;a.material.needsUpdate=true;a.sheet=sample.sheetKey;}
    const {frame}=sample,scale=battleSpeciesHeight(f.speciesId)/sample.displayHeight,[fx,fy]=frame.feet;
    const vertices=a.geometry.attributes.position as THREE.BufferAttribute;
    const left=-fx*scale,right=(frame.sw-fx)*scale,top=fy*scale,bottom=(fy-frame.sh)*scale;
    vertices.setXYZ(0,left,top,0);vertices.setXYZ(1,right,top,0);vertices.setXYZ(2,left,bottom,0);vertices.setXYZ(3,right,bottom,0);vertices.needsUpdate=true;
    const uv=a.geometry.attributes.uv as THREE.BufferAttribute,w=sample.image.width,h=sample.image.height,u0=frame.sx/w,u1=(frame.sx+frame.sw)/w,v0=1-frame.sy/h,v1=1-(frame.sy+frame.sh)/h;
    uv.setXY(0,u0,v0);uv.setXY(1,u1,v0);uv.setXY(2,u0,v1);uv.setXY(3,u1,v1);uv.needsUpdate=true;
    a.mesh.scale.x=(view==='back'&&aim.x-origin.x<0)||(view==='front'&&aim.x-origin.x>0)?-1:1;
    a.mesh.position.set(f.x,.04,f.z);a.mesh.rotation.y=Math.atan2(this.camera.position.x-f.x,this.camera.position.z-f.z);
    a.mesh.visible=!f.hidden; a.material.opacity=f.hp<=0?clamp(1-(faintSeconds-.9),0,1):1;
    a.shadow.visible=!f.hidden;a.shadow.position.set(f.x,.028,f.z);a.shadow.scale.setScalar(battleSpeciesHeight(f.speciesId)/2);(a.shadow.material as THREE.MeshBasicMaterial).opacity=a.material.opacity*.8;
  }
  private updateObstacles(items:NonNullable<Snapshot['obstacles']>) {const live=new Set<string>();for(const o of items){if(o.hp!=null&&o.hp<=0)continue;live.add(o.id);let mesh=this.obstacles.get(o.id);if(!mesh){const rock=o.kind==='rock';const geometry=rock?new THREE.DodecahedronGeometry(o.radius,0):new THREE.BoxGeometry(o.radius*1.5,o.radius*1.8,o.radius*1.5);const m=new THREE.Mesh(geometry,new THREE.MeshStandardMaterial({color:rock?'#959678':'#80643a',roughness:1,flatShading:true}));m.castShadow=true;m.receiveShadow=true;mesh=m;this.world.add(mesh);this.obstacles.set(o.id,mesh);}mesh.position.set(o.x,o.radius*.65,o.z);}
    for(const [id,o] of this.obstacles)if(!live.has(id)){this.disposeObject(o);this.obstacles.delete(id);}}
  private project(x:number,y:number,z:number) {const v=new THREE.Vector3(x,y,z).project(this.camera);return{x:(v.x+1)*this.width/2,y:(1-v.y)*this.height/2};}
  private dispatchEvents(frame:NonNullable<ReturnType<Timeline['at']>>,tick:number) {
    this.effects=this.effects.filter(e=>{const shown=this.presentationTimes.get(eventKey(e));return eventTick(e)>tick-26&&(shown===undefined||this.time-shown<1.3);});
    for(const e of this.effects){const key=eventKey(e);if(eventTick(e)>tick||this.delivered.has(key))continue;
      this.delivered.add(key);
      this.presentationTimes.set(key,this.time-Math.max(0,tick-eventTick(e))/(this.snapshot?.tickRate??20));
      if(e.kind==='damage'){const f=frame.fighters.find(f=>f.id===e.actor);if(f)this.actor(f).hurtTick=eventTick(e);}
      this.onEvent?.(e);
    }
  }
  private ring(x:number,z:number,radius:number,color:string,alpha:number) {const g=this.g;g.save();g.globalAlpha=alpha;g.strokeStyle=color;g.lineWidth=2;g.beginPath();for(let i=0;i<=48;i++){const t=i/48*Math.PI*2,p=this.project(x+Math.cos(t)*radius,.04,z+Math.sin(t)*radius);if(i)g.lineTo(p.x,p.y);else g.moveTo(p.x,p.y);}g.closePath();g.stroke();g.restore();}
  private drawEffects(frame:ReturnType<Timeline['at']>,tick:number) {if(!frame)return;const g=this.g;g.clearRect(0,0,this.width,this.height);
    for(const h of frame.hazards??[]){const phase=hazardPhase(h,tick);if(phase==='ended')continue;const color=colorFor(h.moveType??fxFor(h.moveId).type),alpha=phase==='active'?.85:.35;
      if(['channel','beam','stream','melee','dash'].includes(h.kind)){const from=this.project(h.fromX??h.x,.85,h.fromZ??h.z),to=this.project(h.endX??h.x+(h.dirX??0)*(h.reach??h.length??2),.85,h.endZ??h.z+(h.dirZ??0)*(h.reach??h.length??2));
        g.save();g.strokeStyle=color;g.globalAlpha=alpha;g.lineCap='round';g.lineWidth=phase==='active'?Math.max(3,Math.min(15,(h.halfWidth??.3)*15)):2;if(phase==='windup')g.setLineDash([7,8]);g.beginPath();g.moveTo(from.x,from.y);
        if(h.moveType==='electric'){for(let i=1;i<12;i++)g.lineTo(from.x+(to.x-from.x)*i/12,from.y+(to.y-from.y)*i/12+Math.sin(i*11+Math.floor(tick/2))*7);}
        g.lineTo(to.x,to.y);g.stroke();if(phase==='active'){g.lineWidth=2;g.globalAlpha=.9;g.strokeStyle='#f2edbd';g.stroke();}g.restore();
      }else this.ring(h.x,h.z,h.radius??1,color,alpha);
    }
    for(const p of frame.projectiles){const q=this.project(p.x,.9,p.z),trail=this.project(p.x-(p.vx??0)*.06,.9,p.z-(p.vz??0)*.06);g.save();g.strokeStyle=colorFor(p.type);g.fillStyle=colorFor(p.type);g.lineWidth=5;g.lineCap='round';g.beginPath();g.moveTo(trail.x,trail.y);g.lineTo(q.x,q.y);g.stroke();g.fillRect(q.x-3,q.y-3,6,6);g.restore();}
    for(const clash of frame.clashes??[]){const q=this.project(clash.x,1,clash.z);g.save();g.fillStyle='#d9e6c7';g.globalAlpha=.7;for(let i=0;i<8;i++){const angle=i*Math.PI/4+tick*.1;g.fillRect(q.x+Math.cos(angle)*10,q.y+Math.sin(angle)*10,3,3);}g.restore();}
    for(const e of this.effects){const physicalAge=tick-eventTick(e);if(physicalAge<0)continue;
      const t=Math.max(physicalAge,(this.time-(this.presentationTimes.get(eventKey(e))??this.time))*(this.snapshot?.tickRate??20));
      if(e.kind!=='damage'||t>20)continue;const f=frame.fighters.find(f=>f.id===e.actor);if(!f)continue;const q=this.project(e.x??f.x,1.9,e.z??f.z);
      g.save();g.globalAlpha=clamp(1-t/20,0,1);g.font='700 20px system-ui';g.textAlign='center';g.lineWidth=3;g.strokeStyle='#213020';const text=`−${Math.max(1,Math.round(e.amount??0))}`;g.strokeText(text,q.x,q.y-t*1.4);g.fillStyle=e.effectiveness>1?'#ffcc71':'#fffde4';g.fillText(text,q.x,q.y-t*1.4);
      if(t<7&&!this.reduced){g.strokeStyle=colorFor(e.moveType??'normal');g.lineWidth=2;for(let i=0;i<5;i++){const angle=i*Math.PI*.4;g.beginPath();g.moveTo(q.x+Math.cos(angle)*(5+t),q.y+23+Math.sin(angle)*(5+t));g.lineTo(q.x+Math.cos(angle)*(13+t*2),q.y+23+Math.sin(angle)*(13+t*2));g.stroke();}}
      g.restore();}
  }
  private draw=(now:number)=>{if(this.disposed)return;const dt=Math.min(.05,(now-this.last)/1000);this.last=now;this.time+=dt;
    if(this.framingPending)this.cameraPose();
    const s=this.snapshot;if(s){const latest=this.timeline.frames.at(-1)?.tick??s.tick;const wanted=Math.min(latest,Math.max(0,s.tick-3+(now-this.received)/50));this.currentTick=Math.max(this.currentTick,wanted);
      const frame=this.timeline.at(this.currentTick);if(frame){this.dispatchEvents(frame,this.currentTick);for(const f of frame.fighters)this.updateActor(f,this.currentTick);this.updateObstacles(frame.obstacles??[]);this.onFrame?.(frame.fighters,this.currentTick);}
      this.renderer.render(this.world,this.camera);this.g.setTransform(this.effectCanvas.width/this.width,0,0,this.effectCanvas.height/this.height,0,0);this.drawEffects(frame,this.currentTick);
    }else this.renderer.render(this.world,this.camera);
    if(!this.reduced){this.leaves.position.x=Math.sin(this.time*.22)*.6;this.leaves.position.y=-this.time*.055%3;}
    this.frameId=requestAnimationFrame(this.draw);
  };
  private disposeObject(object:THREE.Object3D) {this.world.remove(object);object.traverse(child=>{if(child instanceof THREE.Mesh){child.geometry.dispose();for(const m of Array.isArray(child.material)?child.material:[child.material])m.dispose();}});}
  debug(){return{tick:this.currentTick,sourceTick:this.snapshot?.tick,engineVersion:this.snapshot?.engineVersion,actors:this.actors.size,textures:this.textures.size,camera:this.overhead?'overview':'gamma',battleViewport:this.battleViewport,framing:'fixed-arena-and-animation-envelope',sceneSource:'original-Gamma-textures-with-reconstructed-layout',actorSource:'original-Gamma-Emerald-Demo-atlases'};}
  dispose(){this.disposed=true;cancelAnimationFrame(this.frameId);this.resizeObserver.disconnect();this.world.traverse(o=>{if(o instanceof THREE.Mesh||o instanceof THREE.Points||o instanceof THREE.Line){o.geometry.dispose();for(const m of Array.isArray(o.material)?o.material:[o.material])m.dispose();}});for(const t of [...this.ownedTextures,...this.textures.values()])t.dispose();this.renderer.dispose();this.host.replaceChildren();}
}
