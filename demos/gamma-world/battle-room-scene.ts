import * as THREE from 'three';
import type { BattleRoomLayout, RoomProp } from './battle-room-types';
import type { NativeWorld } from './native-scene';
import { loadWorldTexture } from './world-assets';
import { sourceLitFacing } from './source-view';

const PALETTES={
  beach:{ground:'#efe2b8',edge:'#c8be9c',rock:'#bab5a0',wood:'#ab8253',leaf:'#6e9f66'},
  meadow:{ground:'#bad5a0',edge:'#849e66',rock:'#a7af91',wood:'#937347',leaf:'#5f8d51'},
  forest:{ground:'#a9c1ae',edge:'#718b74',rock:'#a1afa1',wood:'#7f7054',leaf:'#4e7869'},
  ash:{ground:'#c4b29a',edge:'#847e6d',rock:'#a79b88',wood:'#786449',leaf:'#76785b'},
  ruins:{ground:'#c8c7af',edge:'#959b80',rock:'#b3b6a1',wood:'#8b7858',leaf:'#748a62'},
} as const;
const random=(seed:number)=>{let n=seed>>>0;return()=>{n=(Math.imul(n,1664525)+1013904223)>>>0;return n/4294967296;};};

/** An isolated room made from local source props and authored room slots.
 * Source clones borrow geometry/materials; all procedural resources belong to
 * this view, so ending a battle cannot corrupt the still-loaded world. */
export class GeneratedBattleRoom {
  readonly group=new THREE.Group();
  private ownedGeometries=new Set<THREE.BufferGeometry>();
  private ownedMaterials=new Set<THREE.Material>();
  private ownedTextures=new Set<THREE.Texture>();
  private objects=new Map<string,{group:THREE.Group;boundary:boolean}>();
  private floor?:THREE.Mesh;
  private disposed=false;
  private built=false;
  constructor(readonly layout:BattleRoomLayout,private readonly native?:NativeWorld){
    this.group.name=`encounter-room:${layout.seed}`;
    this.group.userData={seed:layout.seed,templateId:layout.templateId,mapId:layout.context.mapId,groundTexture:layout.context.groundTexture,sourcePropCount:0,fallbackPropCount:0,textureWarnings:[]};
  }
  private material(parameters:THREE.MeshStandardMaterialParameters){
    const material=new THREE.MeshStandardMaterial({roughness:1,metalness:0,side:THREE.DoubleSide,...parameters});
    sourceLitFacing(material);this.ownedMaterials.add(material);return material;
  }
  private mesh(geometry:THREE.BufferGeometry,material:THREE.Material,parent:THREE.Object3D=this.group){
    this.ownedGeometries.add(geometry);const mesh=new THREE.Mesh(geometry,material);mesh.castShadow=true;mesh.receiveShadow=true;parent.add(mesh);return mesh;
  }
  private async tile(id:string,width:number,depth:number,tileSize=2):Promise<THREE.Texture|null>{
    const atlas=id==='island-sand'||id==='island-path';
    let source;
    try{source=await loadWorldTexture(atlas?'island-tilesheet':id);}catch{this.group.userData.textureWarnings.push(id);return null;}
    if(!source||this.disposed||(!atlas&&source.descriptor.kind!=='ground'))return null;
    let texture:THREE.Texture;
    if(atlas){
      const canvas=document.createElement('canvas');canvas.width=canvas.height=64;const context=canvas.getContext('2d');if(!context)return null;
      context.imageSmoothingEnabled=false;context.drawImage(source.image,id==='island-sand'?272:32,id==='island-sand'?400:32,64,64,0,0,64,64);texture=new THREE.CanvasTexture(canvas);
    }else texture=new THREE.Texture(source.image);
    texture.colorSpace=THREE.SRGBColorSpace;texture.magFilter=THREE.NearestFilter;texture.minFilter=THREE.NearestFilter;
    texture.wrapS=texture.wrapT=THREE.RepeatWrapping;texture.repeat.set(width/tileSize,depth/tileSize);texture.needsUpdate=true;this.ownedTextures.add(texture);return texture;
  }
  async build():Promise<this>{
    if(this.built||this.disposed)return this;this.built=true;
    const {context}=this.layout,palette=PALETTES[context.theme];
    const [ground,outer,stone]=await Promise.all([this.tile(context.groundTexture,14,10),this.tile(context.groundTexture,80,70),this.tile('stone',2,2)]);
    if(this.disposed)return this;
    // A broad, opaque continuation avoids a black void outside the battle wall.
    const exterior=this.mesh(new THREE.PlaneGeometry(80,70),this.material({map:outer,color:outer?'#b8c1ac':palette.edge}));
    exterior.rotation.x=-Math.PI/2;exterior.position.y=-.025;exterior.castShadow=false;
    this.floor=this.mesh(new THREE.PlaneGeometry(14,10),this.material({map:ground,color:ground?'#ffffff':palette.ground}));
    this.floor.rotation.x=-Math.PI/2;this.floor.castShadow=false;this.floor.name='battle-room-ground';
    const rock=this.material({map:stone,color:palette.rock}),wood=this.material({color:palette.wood}),leaf=this.material({color:palette.leaf});
    const rng=random(this.layout.seed^0x57414c4c);
    for(const prop of this.layout.props){
      const object=new THREE.Group();object.name=prop.id;object.position.set(prop.x,0,prop.z);object.userData={obstacleId:prop.id,boundary:prop.boundary,sourceId:prop.sourceId??null};
      this.group.add(object);this.objects.set(prop.id,{group:object,boundary:prop.boundary});
      // Each outer collider gets a matching solid stone foot. Neighboring feet
      // overlap exactly as their collision circles do: trees never imply gaps.
      if(prop.boundary)this.boundaryFoot(prop,rock,rng,object);
      const clone=prop.sourceId?this.native?.cloneEncounterProp(prop.sourceId,prop.radius,prop.height,prop.rotation):null;
      if(clone){
        // Very tall source trees need a smaller uniform scale. A low root/rock
        // foot makes the full authored cover footprint visible in that case.
        if(!prop.boundary&&clone.userData.sourceRadius*clone.userData.uniformScale<prop.radius*.8){
          const foot=this.mesh(new THREE.CylinderGeometry(prop.radius*.92,prop.radius,.16,9),rock,object);foot.position.y=.065;
        }
        object.add(clone);this.group.userData.sourcePropCount++;
      }
      else{this.fallback(prop,rock,wood,leaf,object);this.group.userData.fallbackPropCount++;}
    }
    this.group.updateMatrixWorld(true);return this;
  }
  private boundaryFoot(prop:RoomProp,material:THREE.Material,rng:()=>number,parent:THREE.Group){
    const height=.37+rng()*.13,geometry=new THREE.CylinderGeometry(prop.radius,prop.radius,height,12,1);
    // Only vertical roughness changes. The footprint always reaches the exact
    // collision radius so the outer wall remains visibly continuous.
    const positions=geometry.getAttribute('position');for(let i=0;i<positions.count;i++)if(positions.getY(i)>0)positions.setY(i,positions.getY(i)+rng()*.07);
    positions.needsUpdate=true;geometry.computeVertexNormals();const mesh=this.mesh(geometry,material,parent);mesh.position.y=height/2-.015;mesh.rotation.y=prop.rotation;
  }
  private fallback(prop:RoomProp,rock:THREE.Material,wood:THREE.Material,leaf:THREE.Material,parent:THREE.Group){
    const content=new THREE.Group();content.rotation.y=prop.rotation;parent.add(content);const radius=prop.radius,height=prop.height;
    if(prop.kind==='crate'){
      const size=radius*Math.SQRT2,body=this.mesh(new THREE.BoxGeometry(size,height,size),wood,content);body.position.y=height/2;
      for(const y of [height*.15,height*.85]){const band=this.mesh(new THREE.BoxGeometry(size*1.025,.075,size*1.025),rock,content);band.position.y=y;}
      for(const z of [-1,1]){const brace=this.mesh(new THREE.BoxGeometry(size*.11,Math.hypot(size*.7,height*.7),.035),wood,content);brace.position.set(0,height/2,z*size*.52);brace.rotation.z=-Math.atan2(size*.7,height*.7);}
    }else if(prop.kind==='fence'){
      for(const x of [-1,1]){const post=this.mesh(new THREE.BoxGeometry(.11,height,.13),wood,content);post.position.set(x*radius*.72,height/2,0);}
      for(const y of [.34,.72]){const rail=this.mesh(new THREE.BoxGeometry(radius*1.75,.13,.1),wood,content);rail.position.y=height*y;}
    }else if(prop.kind==='tree'||prop.kind==='plant'){
      const trunkHeight=height*.62,trunk=this.mesh(new THREE.CylinderGeometry(radius*.25,radius*.38,trunkHeight,6),wood,content);trunk.position.y=trunkHeight/2;
      for(let n=0;n<2;n++){const crown=this.mesh(new THREE.DodecahedronGeometry(1,0),leaf,content);crown.scale.set(radius*(1.12-n*.25),height*(.32-n*.055),radius*(1.05-n*.2));crown.position.y=height*(.61+n*.17);crown.rotation.y=n*1.2;}
    }else{
      const geometry=new THREE.DodecahedronGeometry(1,0);geometry.computeBoundingBox();const size=geometry.boundingBox!.getSize(new THREE.Vector3());
      geometry.scale(radius*2/size.x,height/size.y,radius*2/size.z);geometry.computeBoundingBox();geometry.translate(0,-geometry.boundingBox!.min.y,0);this.mesh(geometry,rock,content);
    }
  }
  applyDestroyed(ids:string[]):void{
    for(const id of ids){const object=this.objects.get(id);if(object&&!object.boundary)object.group.visible=false;}
  }
  rayPoint(ray:THREE.Raycaster):THREE.Vector3|null{
    if(!this.floor||this.disposed)return null;
    const hit=ray.intersectObject(this.floor,false)[0];if(!hit||Math.abs(hit.point.x)>7||Math.abs(hit.point.z)>5)return null;
    return hit.point;
  }
  dispose():void{
    if(this.disposed)return;this.disposed=true;
    for(const geometry of this.ownedGeometries)geometry.dispose();for(const material of this.ownedMaterials)material.dispose();for(const texture of this.ownedTextures)texture.dispose();
    this.ownedGeometries.clear();this.ownedMaterials.clear();this.ownedTextures.clear();this.objects.clear();this.group.clear();this.floor=undefined;
  }
}
