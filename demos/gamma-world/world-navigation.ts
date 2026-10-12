/** Navigation for the exploration map. The surface remains the authority for
 * collision and elevation; this module never manufactures walkable ground. */
export type WorldPathPoint = {x:number;z:number;y:number};
export type WorldPathPosition = {x:number;z:number};
export interface WorldNavigationSurface {
  canMove(point:WorldPathPosition,fromY:number):number|null;
  heightAt(point:WorldPathPosition,fromY?:number):number|null;
}
export interface WorldPathOptions {
  start:WorldPathPosition;
  startHeight:number;
  goal:WorldPathPosition&{y?:number};
  goalHeight?:number;
  /** Use a small tolerance for ground clicks; an NPC on a slope may allow the
   * same height difference as the existing nearby-interaction controller. */
  goalHeightTolerance?:number;
  goalRadius?:number;
  surface:WorldNavigationSurface;
  bounds?:{minX:number;maxX:number;minZ:number;maxZ:number};
  maxNodes?:number;
  /** Wall-clock budget, including yields. An exhausted search is never called a
   * proven blocked destination: inspect reason === 'budget'. */
  timeoutMs?:number;
  signal?:AbortSignal;
}
export interface WorldPathResult {
  status:'arrived'|'found'|'unreachable'|'cancelled';
  points:WorldPathPoint[];
  reason:'arrived'|'route'|'invalid-start'|'invalid-input'|'no-route'|'budget'|'cancelled';
  expanded:number;
  samples:number;
  surfaceCalls:number;
  durationMs:number;
  distance:number;
  nearestDistance:number;
}

const SAMPLE=.1,FINE=.16,HEIGHT_EPSILON=.08,CLEARANCE=.03;
const DIRECTIONS=[[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]] as const;
const distance=(a:WorldPathPosition,b:WorldPathPosition)=>Math.hypot(a.x-b.x,a.z-b.z);
const finitePoint=(p:WorldPathPosition)=>Number.isFinite(p.x)&&Number.isFinite(p.z);
const clock=()=>performance.now();

/** Check a complete segment, including its start and destination, with the same
 * collision/step rules as manual movement. A supplied destination height must
 * agree too, so smoothing cannot switch to another floor beneath a bridge. */
export function canTravelWorldSegment(surface:WorldNavigationSurface,from:WorldPathPoint,to:WorldPathPosition&{y?:number},sampleDistance=SAMPLE):WorldPathPoint|null {
  if(!finitePoint(from)||!finitePoint(to)||!Number.isFinite(from.y))return null;
  const spacing=Number.isFinite(sampleDistance)&&sampleDistance>0?Math.min(SAMPLE,sampleDistance):SAMPLE;
  const initial=surface.canMove(from,from.y);if(initial===null||!Number.isFinite(initial)||Math.abs(initial-from.y)>HEIGHT_EPSILON)return null;
  const count=Math.max(1,Math.ceil(distance(from,to)/spacing));let y=initial;
  for(let i=1;i<=count;i++){
    const p={x:from.x+(to.x-from.x)*i/count,z:from.z+(to.z-from.z)*i/count};
    const next=surface.canMove(p,y);if(next===null||!Number.isFinite(next))return null;y=next;
  }
  return to.y!==undefined&&(!Number.isFinite(to.y)||Math.abs(to.y-y)>HEIGHT_EPSILON)?null:{x:to.x,z:to.z,y};
}

type Node=WorldPathPoint&{ix:number;iz:number;key:string;g:number;f:number;parent:Node|null};
class Heap {
  private values:Node[]=[];
  get length(){return this.values.length;}
  push(value:Node){let i=this.values.length;this.values.push(value);while(i){const parent=(i-1)>>1;if(this.values[parent].f<=value.f)break;this.values[i]=this.values[parent];i=parent;}this.values[i]=value;}
  pop(){const first=this.values[0],last=this.values.pop();if(this.values.length&&last){let i=0;while(true){let child=i*2+1;if(child>=this.values.length)break;if(child+1<this.values.length&&this.values[child+1].f<this.values[child].f)child++;if(this.values[child].f>=last.f)break;this.values[i]=this.values[child];i=child;}this.values[i]=last;}return first;}
}
type Context={options:WorldPathOptions;began:number;deadline:number;expanded:number;samples:number;surfaceCalls:number;stopped:'cancelled'|'budget'|null;nearest:number;maxNodes:number;edgeSample:number;forbidden:Set<string>};
const edgeKey=(from:WorldPathPoint,to:WorldPathPosition)=>`${from.x.toFixed(6)},${from.z.toFixed(6)},${from.y.toFixed(4)}>${to.x.toFixed(6)},${to.z.toFixed(6)}`;
function move(ctx:Context,p:WorldPathPosition,y:number){
  ctx.samples++;ctx.surfaceCalls++;return ctx.options.surface.canMove(p,y);
}
function interrupted(ctx:Context){
  if(ctx.options.signal?.aborted)ctx.stopped='cancelled';
  else if(clock()>=ctx.deadline)ctx.stopped='budget';
  return ctx.stopped!==null;
}
// A generator permits the browser and the synchronous CPU tests to execute the
// exact same search. Long direct/smoothing segments yield every 32 probes too.
function* travel(ctx:Context,from:WorldPathPoint,to:WorldPathPosition&{y?:number},margin=false,spacing=ctx.edgeSample):Generator<void,WorldPathPoint|null,void>{
  if(ctx.forbidden.has(edgeKey(from,to)))return null;
  const length=distance(from,to),count=Math.max(1,Math.ceil(length/spacing));let y=from.y;
  const sideX=length?-(to.z-from.z)/length*CLEARANCE:0,sideZ=length?(to.x-from.x)/length*CLEARANCE:0;
  for(let i=1;i<=count;i++){
    const p={x:from.x+(to.x-from.x)*i/count,z:from.z+(to.z-from.z)*i/count};
    const next=move(ctx,p,y);
    if(next===null||!Number.isFinite(next))return null;y=next;
    // Three centimetres of steering room prevents a mathematically tangent
    // shortcut from grazing a fence corner between different frame spacings.
    // This only adds conservative checks through the same native collision API.
    if(margin&&length)for(const sign of [-1,1]){
      const side=move(ctx,{x:p.x+sideX*sign,z:p.z+sideZ*sign},y);
      if(side===null||!Number.isFinite(side)||Math.abs(side-y)>.24)return null;
    }
    if(ctx.samples%32===0){yield;if(interrupted(ctx))return null;}
  }
  return to.y!==undefined&&Math.abs(to.y-y)>HEIGHT_EPSILON?null:{x:to.x,z:to.z,y};
}
function outcome(ctx:Context,status:WorldPathResult['status'],reason:WorldPathResult['reason'],points:WorldPathPoint[]=[]):WorldPathResult {
  return {status,reason,points,expanded:ctx.expanded,samples:ctx.samples,surfaceCalls:ctx.surfaceCalls,durationMs:clock()-ctx.began,distance:points.reduce((sum,p,i)=>sum+(i?distance(p,points[i-1]):0),0),nearestDistance:ctx.nearest};
}
function stopped(ctx:Context){return outcome(ctx,ctx.stopped==='cancelled'?'cancelled':'unreachable',ctx.stopped==='cancelled'?'cancelled':'budget');}
function* verifiedTravel(ctx:Context,from:WorldPathPoint,to:WorldPathPoint,margin:boolean):Generator<void,boolean,void>{
  if(margin&&!(yield*travel(ctx,from,to,true,.05)))return false;
  for(const spacing of [.02,.03,.08]){if(!(yield*travel(ctx,from,to,false,spacing)))return false;if(ctx.stopped)return false;}
  return true;
}
function* smooth(ctx:Context,path:WorldPathPoint[]):Generator<void,WorldPathPoint[],void>{
  const points=[path[0]];let i=0;
  // Limit lookahead to 12m: trying every distant vertex around a winding coast
  // would spend more time simplifying than finding the route. Every shortcut
  // still uses the original, fully sampled surface and checks its ending floor.
  while(i<path.length-1){
    let furthest=i+1,length=0;
    for(let n=i+1;n<path.length&&n<=i+48;n++){length+=distance(path[n-1],path[n]);if(length>12)break;furthest=n;}
    let next=i+1,verified=false;
    for(let n=furthest;n>i+1;n--){if(yield*verifiedTravel(ctx,path[i],path[n],true)){next=n;verified=true;break;}if(ctx.stopped)return [];}
    // A narrow authored ramp need not have the extra shortcut clearance. Keep
    // its original graph edge, then audit at several spacings (including the
    // movement controller's 8cm step), instead of cutting across its corner.
    if(!verified&&!(yield*verifiedTravel(ctx,path[i],path[next],false))){ctx.forbidden.add(edgeKey(path[i],path[next]));return [];}
    points.push(path[next]);i=next;yield;
  }
  return points;
}

function* search(options:WorldPathOptions,edgeSample=SAMPLE,mode:'coarse'|'adaptive'='coarse',forbidden=new Set<string>(),repairs=0):Generator<void,WorldPathResult,void>{
  const began=clock(),timeout=Number.isFinite(options.timeoutMs)?Math.max(1,options.timeoutMs!):2000;
  const ctx:Context={options,began,deadline:began+timeout,expanded:0,samples:0,surfaceCalls:0,stopped:null,nearest:distance(options.start,options.goal),maxNodes:Number.isFinite(options.maxNodes)?Math.max(1,Math.floor(options.maxNodes!)):30000,edgeSample,forbidden};
  // Do not abandon an open coarse search too early: a long detour around the
  // Route 101 forest is several thousand coarse nodes, but many more fine ones.
  const phaseDeadline=mode==='coarse'?began+timeout*.75:ctx.deadline;
  const radius=options.goalRadius??.25,start={...options.start,y:options.startHeight},goalHeight=options.goalHeight??options.goal.y,goalTolerance=options.goalHeightTolerance??.24;
  if(!finitePoint(start)||!finitePoint(options.goal)||!Number.isFinite(start.y)||!Number.isFinite(radius)||radius<0||!Number.isFinite(goalTolerance)||goalTolerance<0||(goalHeight!==undefined&&!Number.isFinite(goalHeight)))return outcome(ctx,'unreachable','invalid-input');
  const atGoal=(p:WorldPathPoint)=>distance(p,options.goal)<=radius+1e-8&&(goalHeight===undefined||Math.abs(p.y-goalHeight)<=goalTolerance);
  const b=options.bounds;
  if(b&&(![b.minX,b.maxX,b.minZ,b.maxZ].every(Number.isFinite)||b.minX>b.maxX||b.minZ>b.maxZ))return outcome(ctx,'unreachable','invalid-input');
  if(interrupted(ctx))return stopped(ctx);
  const initial=move(ctx,start,start.y);
  if(initial===null||!Number.isFinite(initial)||Math.abs(initial-start.y)>HEIGHT_EPSILON)return outcome(ctx,'unreachable','invalid-start');
  start.y=initial;
  if(atGoal(start))return outcome(ctx,'arrived','arrived',[start]);
  const inside=(p:WorldPathPosition)=>!b||(p.x>=b.minX&&p.x<=b.maxX&&p.z>=b.minZ&&p.z<=b.maxZ);
  const endpoint=(from:WorldPathPosition)=>{
    const d=distance(from,options.goal),r=Math.min(radius*.95,d);
    return {x:options.goal.x+(d?(from.x-options.goal.x)*r/d:0),z:options.goal.z+(d?(from.z-options.goal.z)*r/d:0)};
  };
  // Most ordinary clicks need no graph at all.
  const directTarget=endpoint(start);
  const direct=inside(directTarget)?yield*travel(ctx,start,directTarget,true,.05):null;
  if(ctx.stopped)return stopped(ctx);
  if(direct&&atGoal(direct)){const verified=yield*smooth(ctx,[start,direct]);if(ctx.stopped)return stopped(ctx);if(verified.length){ctx.nearest=distance(direct,options.goal);return outcome(ctx,'found','route',verified);}}

  const open=new Heap(),best=new Map<string,number>();
  // A small fixed offset avoids mapping every grid sample to a GLB triangle seam.
  const offset={x:.00173,z:-.00371};
  const point=(ix:number,iz:number)=>({x:ix*FINE+offset.x,z:iz*FINE+offset.z});
  const key=(ix:number,iz:number,y:number)=>`${ix},${iz},${Math.round(y/.12)}`;
  const heuristic=(p:WorldPathPosition)=>Math.max(0,distance(p,options.goal)-radius);
  const put=(ix:number,iz:number,p:WorldPathPoint,g:number,parent:Node|null)=>{
    const k=key(ix,iz,p.y);if(g>=(best.get(k)??Infinity)-1e-8)return;
    const n:Node={...p,ix,iz,key:k,g,f:g+heuristic(p)*1.12,parent};best.set(k,g);open.push(n);
  };
  const sx=Math.round((start.x-offset.x)/FINE),sz=Math.round((start.z-offset.z)/FINE);
  for(const [dx,dz]of[[0,0],...DIRECTIONS]){
    const ix=sx+dx,iz=sz+dz,p=point(ix,iz);if(!inside(p))continue;
    const hit=yield*travel(ctx,start,p);if(ctx.stopped)return stopped(ctx);if(hit)put(ix,iz,hit,distance(start,p),null);
  }
  let end:Node|null=null,lastPoint:WorldPathPoint|null=null;
  while(open.length){
    if(interrupted(ctx))return stopped(ctx);
    if(ctx.expanded>=ctx.maxNodes){ctx.stopped='budget';return stopped(ctx);}
    if(mode==='coarse'&&(clock()>=phaseDeadline||ctx.expanded>=5000))break;
    const n=open.pop();if(n.g!==(best.get(n.key)??Infinity))continue;ctx.expanded++;
    const d=distance(n,options.goal);ctx.nearest=Math.min(ctx.nearest,d);
    if(atGoal(n)){end=n;break;}
    // Connect the continuous destination circle, not just coincident grid nodes.
    if(d<=Math.max(1.1,radius+.8)){
      let hit:WorldPathPoint|null=null;
      for(const p of [endpoint(n),{x:options.goal.x,z:options.goal.z}]){
        if(inside(p))hit=yield*travel(ctx,n,p);if(ctx.stopped)return stopped(ctx);if(hit&&atGoal(hit))break;
      }
      if(hit&&atGoal(hit)){end=n;lastPoint=hit;break;}
    }
    // Open areas use one canonical 64cm lattice. Fine nodes reconnect to that
    // lattice once clear of a wall, rather than spreading sixteen differently
    // offset coarse grids across the same open field.
    let refine=true;
    const coarse=n.ix%4===0&&n.iz%4===0;
    if(!coarse){
      refine=false;
      const x0=Math.floor(n.ix/4)*4,z0=Math.floor(n.iz/4)*4;
      for(const ix of [x0,x0+4])for(const iz of [z0,z0+4]){
        const p=point(ix,iz);if(!inside(p)){refine=true;continue;}
        const hit=yield*travel(ctx,n,p);if(ctx.stopped)return stopped(ctx);
        if(!hit){refine=true;continue;}put(ix,iz,hit,n.g+distance(n,p),n);
      }
    }
    // Blocked edges introduce 32cm and then 16cm neighbors, retaining narrow
    // ramps without a second full-map search. Even coarse edges use <=10cm.
    for(const stride of mode==='coarse'?(coarse?[4]:[]):(coarse?[4,2,1]:[2,1])){
      if(!refine)break;refine=false;
      for(const [dx,dz]of DIRECTIONS){
        const ix=n.ix+dx*stride,iz=n.iz+dz*stride,p=point(ix,iz);
        if(!inside(p)){refine=true;continue;}
        const lowerBound=n.g+FINE*stride*Math.hypot(dx,dz);
        // Endpoint height is discovered by walking, never sampled in isolation.
        const hit=yield*travel(ctx,n,p);if(ctx.stopped)return stopped(ctx);
        if(!hit){refine=true;continue;}put(ix,iz,hit,lowerBound,n);
      }
    }
    yield;
  }
  if(!end){
    if(ctx.expanded>=ctx.maxNodes){ctx.stopped='budget';return stopped(ctx);}
    if(mode==='coarse'){const retry=yield*search({...options,timeoutMs:Math.max(1,ctx.deadline-clock()),maxNodes:Math.max(1,ctx.maxNodes-ctx.expanded)},edgeSample,'adaptive',forbidden,repairs);return {...retry,expanded:retry.expanded+ctx.expanded,samples:retry.samples+ctx.samples,surfaceCalls:retry.surfaceCalls+ctx.surfaceCalls,durationMs:clock()-began};}
    return outcome(ctx,'unreachable','no-route');
  }
  const path:WorldPathPoint[]=[];for(let n:Node|null=end;n;n=n.parent)path.push({x:n.x,z:n.z,y:n.y});path.push(start);path.reverse();if(lastPoint)path.push(lastPoint);
  const points=yield*smooth(ctx,path);if(ctx.stopped)return stopped(ctx);
  if(!points.length){
    if(ctx.expanded>=ctx.maxNodes||interrupted(ctx)){ctx.stopped=ctx.stopped??'budget';return stopped(ctx);}
    // A coarse probe can miss a very thin original mesh seam. Reject that exact
    // directed edge and search again; never return the unsafe partial route.
    if(repairs<12){const retry=yield*search({...options,timeoutMs:Math.max(1,ctx.deadline-clock()),maxNodes:Math.max(1,ctx.maxNodes-ctx.expanded)},edgeSample,mode,forbidden,repairs+1);return {...retry,expanded:retry.expanded+ctx.expanded,samples:retry.samples+ctx.samples,surfaceCalls:retry.surfaceCalls+ctx.surfaceCalls,durationMs:clock()-began};}
    return outcome(ctx,'unreachable','no-route');
  }
  ctx.nearest=distance(points[points.length-1],options.goal);
  return outcome(ctx,'found','route',points);
}

/** Production entry point. Let input, animation and cancellation run at least
 * once per ~6ms of search work instead of blocking a frame for the whole map. */
export async function findWorldPath(options:WorldPathOptions):Promise<WorldPathResult>{
  const work=search(options);let slice=clock();
  while(true){const next=work.next();if(next.done)return next.value;if(clock()-slice>=6){await new Promise<void>(resolve=>setTimeout(resolve,0));slice=clock();}}
}
/** Identical algorithm without event-loop yields, intended for CPU tests/tools. */
export function findWorldPathSync(options:WorldPathOptions):WorldPathResult{
  const work=search(options);while(true){const next=work.next();if(next.done)return next.value;}
}
