import * as THREE from 'three';
/** Decoded BP_Brendan source defaults. See data/native-camera-lighting.json. */
export const SOURCE_VIEW={horizontalFov:100,armLength:5,pitch:53.400000389529654,capsuleHeight:.6427484894,actorPixelMetres:.035,actorTilt:30.30139923,actorOffsetX:-.18950084};
/** Playable overview defaults; the decoded 5m source arm remains reference data. */
export const CAMERA_VIEW={defaultDistance:9,minDistance:6.5,maxDistance:14};
export function clampCameraDistance(value:number){
  return Number.isFinite(value)?THREE.MathUtils.clamp(value,CAMERA_VIEW.minDistance,CAMERA_VIEW.maxDistance):CAMERA_VIEW.defaultDistance;
}
const safeAspect=(aspect:number)=>Number.isFinite(aspect)&&aspect>0?aspect:16/9;
/** Portrait panels need more distance to compensate for their horizontal crop. */
export function cameraArmForViewport(distance:number,aspect:number){
  return clampCameraDistance(distance)*Math.max(1,Math.min(4/3,Math.sqrt((16/9)/safeAspect(aspect))));
}
export function verticalFov(horizontal:number,aspect:number){return THREE.MathUtils.radToDeg(2*Math.atan(Math.tan(THREE.MathUtils.degToRad(horizontal/2))/aspect));}
export function screenToWorld(x:number,down:number){return {x:-down,z:-x};}
export function worldToScreen(x:number,z:number){return {x:-z,z:-x};}
/** UE view-right is +Y, i.e. -Z here. Keep source placements; reflect projection. */
export function sourceProjection(camera:THREE.PerspectiveCamera){
  // The native composition is 16:9. Narrow web panels crop horizontally rather
  // than widening the vertical lens and shrinking the entire island/character.
  camera.aspect=safeAspect(camera.aspect);camera.fov=verticalFov(SOURCE_VIEW.horizontalFov,Math.max(camera.aspect,16/9));camera.updateProjectionMatrix();camera.projectionMatrix.elements[0]*=-1;camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
}
export function sourceLitFacing(material:THREE.Material){
  if(!(material as THREE.MeshStandardMaterial).isMeshStandardMaterial||material.userData.sourceProjectionFacing)return;
  material.userData.sourceProjectionFacing=true;
  const old=material.onBeforeCompile;
  material.onBeforeCompile=function(shader,renderer){old.call(this,shader,renderer);shader.fragmentShader=shader.fragmentShader.replace('#include <normal_fragment_begin>',THREE.ShaderChunk.normal_fragment_begin.replace(/gl_FrontFacing/g,'(!gl_FrontFacing)').replace('normalize( cross( fdx, fdy ) )','normalize( -cross( fdx, fdy ) )'));};
  material.customProgramCacheKey=()=> 'gamma-source-left-handed-view-r2';material.needsUpdate=true;
}
