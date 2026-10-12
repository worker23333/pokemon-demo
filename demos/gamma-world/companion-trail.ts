import type { Point } from './types';

export type TrailPoint = Point & { y:number };
type Surface = { canMove(point:Point,fromY:number):number|null };
const distance=(a:Point,b:Point)=>Math.hypot(a.x-b.x,a.z-b.z);

/** Follow the trainer's actual footsteps, including corners, with a ground check
 * on every step. The resting gap is measured along the trail, never through walls. */
export class CompanionTrail {
  position:TrailPoint={x:0,z:0,y:0};
  private points:TrailPoint[]=[];
  private speed=0;
  private lastLeader:TrailPoint={x:0,z:0,y:0};
  blocked=false;
  reset(position:TrailPoint,leader:TrailPoint){
    this.position={...position};this.lastLeader={...leader};
    this.points=distance(position,leader)>.001?[{...leader}]:[];
    this.speed=0;this.blocked=false;
  }
  record(leader:TrailPoint){
    if(distance(leader,this.lastLeader)<.0001)return;
    this.points.push({...leader});this.lastLeader={...leader};
  }
  get connectionTarget(){return this.points[0];}
  connect(path:TrailPoint[]){
    if(!this.points.length)return;
    this.points=[...path.filter(p=>distance(p,this.position)>.001),...this.points];
    this.blocked=false;
  }
  step(dt:number,surface:Surface){
    const previous={...this.position};this.blocked=false;
    let gap=0,last:Point=this.position;
    for(const p of this.points){gap+=distance(last,p);last=p;}
    const excess=Math.max(0,gap-1.15);
    const desired=Math.min(6.5,excess*4);
    this.speed+=(desired-this.speed)*(1-Math.exp(-9*Math.max(0,dt)));
    let remaining=Math.min(excess,this.speed*Math.max(0,dt));
    while(remaining>.00001&&this.points.length){
      const goal=this.points[0],length=distance(this.position,goal);
      if(length<.0001){this.points.shift();continue;}
      const amount=Math.min(remaining,length,.08);
      const next={x:this.position.x+(goal.x-this.position.x)*amount/length,z:this.position.z+(goal.z-this.position.z)*amount/length};
      const y=surface.canMove(next,this.position.y);
      if(y===null){this.blocked=true;this.speed=0;break;}
      this.position={...next,y};remaining-=amount;
      if(amount>=length-.00001)this.points.shift();
    }
    return {position:{...this.position},velocity:dt>0?{x:(this.position.x-previous.x)/dt,z:(this.position.z-previous.z)/dt}:{x:0,z:0},blocked:this.blocked};
  }
}
