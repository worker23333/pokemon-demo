import { EncounterFieldError, type FieldPoint, type FieldTerrain, type FieldObstacle } from './field-types';

export const FIELD_BODY_RADIUS=.55;
const distance=(a:FieldPoint,b:FieldPoint)=>Math.hypot(a.x-b.x,a.z-b.z);
export function fieldHeightAt(t:FieldTerrain,p:FieldPoint):number|null {
  const gx=(p.x-t.x0)/t.cellSize,gz=(p.z-t.z0)/t.cellSize;
  if(gx<0||gz<0||gx>t.cols-1||gz>t.rows-1)return null;
  const col=Math.min(t.cols-2,Math.floor(gx)),row=Math.min(t.rows-2,Math.floor(gz)),fx=gx-col,fz=gz-row,i=row*t.cols+col;
  const h=[t.heights[i],t.heights[i+1],t.heights[i+t.cols],t.heights[i+t.cols+1]];
  if(h.some(y=>y===null)||Math.max(...h as number[])-Math.min(...h as number[])>t.maxStep+1e-8)return null;
  return (h[0]!*(1-fx)+h[1]!*fx)*(1-fz)+(h[2]!*(1-fx)+h[3]!*fx)*fz;
}
export function fieldCanStand(t:FieldTerrain,obstacles:FieldObstacle[],p:FieldPoint,radius=FIELD_BODY_RADIUS){
  if(Math.abs(p.x)>7-radius+1e-8||Math.abs(p.z)>5-radius+1e-8)return false;
  const y=fieldHeightAt(t,p);if(y===null)return false;
  for(let n=0;n<8;n++){const angle=n*Math.PI/4,h=fieldHeightAt(t,{x:p.x+Math.cos(angle)*radius,z:p.z+Math.sin(angle)*radius});if(h===null||Math.abs(h-y)>t.maxStep+1e-8)return false;}
  return !obstacles.some(o=>distance(o,p)<o.radius+radius-1e-7);
}
function segmentDistance(a:FieldPoint,b:FieldPoint,p:FieldPoint){const dx=b.x-a.x,dz=b.z-a.z,q=dx*dx+dz*dz,k=q?Math.max(0,Math.min(1,((p.x-a.x)*dx+(p.z-a.z)*dz)/q)):0;return Math.hypot(p.x-a.x-dx*k,p.z-a.z-dz*k);}
export function fieldCanTravel(t:FieldTerrain,obstacles:FieldObstacle[],a:FieldPoint,b:FieldPoint,radius=FIELD_BODY_RADIUS){
  if(obstacles.some(o=>segmentDistance(a,b,o)<o.radius+radius-1e-7))return false;
  const steps=Math.max(1,Math.ceil(distance(a,b)/Math.min(.1,t.cellSize*.5)));let previous=fieldHeightAt(t,a);if(previous===null)return false;
  for(let n=1;n<=steps;n++){const p={x:a.x+(b.x-a.x)*n/steps,z:a.z+(b.z-a.z)*n/steps},h=fieldHeightAt(t,p);if(h===null||Math.abs(h-previous)>t.maxStep+1e-8||!fieldCanStand(t,obstacles,p,radius))return false;previous=h;}
  return true;
}
/** Only return cells joined by fully sampled, obstacle-free .1m segments. */
export function fieldConnectedPoints(t:FieldTerrain,obstacles:FieldObstacle[],start:FieldPoint):FieldPoint[]{
  const points=Array.from({length:t.cols*t.rows},(_,i)=>({x:t.x0+i%t.cols*t.cellSize,z:t.z0+Math.floor(i/t.cols)*t.cellSize}));
  const legal=points.map(p=>fieldCanStand(t,obstacles,p));
  const anchors=points.map((p,i)=>({p,i,d:distance(p,start)})).filter(v=>legal[v.i]&&v.d<=1.15).sort((a,b)=>a.d-b.d);
  const anchor=anchors.find(a=>fieldCanTravel(t,obstacles,start,a.p));if(!anchor)return [];
  const queue=[anchor.i],seen=new Set(queue);
  for(let cursor=0;cursor<queue.length;cursor++){const i=queue[cursor],x=i%t.cols,z=Math.floor(i/t.cols);for(const [dx,dz] of [[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]]){
    const xx=x+dx,zz=z+dz,j=zz*t.cols+xx;if(xx<0||xx>=t.cols||zz<0||zz>=t.rows||seen.has(j)||!legal[j]||!fieldCanTravel(t,obstacles,points[i],points[j]))continue;seen.add(j);queue.push(j);
  }}
  return queue.map(i=>points[i]);
}
export function chooseFieldSpawns(t:FieldTerrain,obstacles:FieldObstacle[],player:FieldPoint,desiredOpponent?:FieldPoint,canReachFromPlayer?:(p:FieldPoint)=>boolean){
  const candidates=[player,...Array.from({length:t.cols*t.rows},(_,i)=>({x:t.x0+i%t.cols*t.cellSize,z:t.z0+Math.floor(i/t.cols)*t.cellSize}))]
    .filter(p=>distance(p,player)<=1.6&&fieldCanStand(t,obstacles,p)&&(!canReachFromPlayer||canReachFromPlayer(p))).sort((a,b)=>distance(a,player)-distance(b,player));
  for(const playerStart of candidates){
    const reachable=fieldConnectedPoints(t,obstacles,playerStart);
    const opponents=reachable.filter(p=>distance(p,playerStart)>=2.4).sort((a,b)=>desiredOpponent?distance(a,desiredOpponent)-distance(b,desiredOpponent):Math.abs(distance(a,playerStart)-4)-Math.abs(distance(b,playerStart)-4));
    if(opponents.length)return{playerStart,opponentStart:opponents[0]};
  }
  if(!candidates.length)throw new EncounterFieldError('NO_PLAYER_SPACE','脚下空间不足以容纳伙伴；请沿当前道路移动一小段后再开始交锋。');
  throw new EncounterFieldError('NO_OPPONENT_SPACE','附近没有与脚下连通、可容纳双方的地面；请在这片地图较开阔的位置开始交锋。');
}
