// Source-art choreography only. Stages follow the existing public cast frame
// boundaries and never change hidden state, ground position or contact timing.
const clamp = (x,a=0,b=1) => Math.max(a,Math.min(b,x));
const smooth = x => { const p=clamp(x);return p*p*(3-2*p); };
const finite = (x,d=0) => Number.isFinite(x)?x:d;
const REST = Object.freeze({kind:'none',phase:'idle',progress:0,lift:0,pitch:0,compression:0,grounded:true,dig:0});
/** Rotate a falling sprite about its footprint without letting the lower
 * corner sink below the floor. Width and output use the caller's same units. */
export function stagePivotLift(stage,rotation,width) {
  return stage?.kind==='slam'?Math.abs(Math.sin(rotation))*Math.max(0,width)*.5:0;
}
export function sampleActionStage(fighter,tick,reduced=false) {
  const c=fighter.cast;
  if(!c)return REST;
  const start=finite(c.startTick,finite(c.start)+1),active=finite(c.activeTick,finite(c.active)+1);
  const end=finite(c.endTick,finite(c.end,active)+1),endActive=active+Math.max(1,finite(c.activeLen,1));
  if(tick<start||tick>end||!Number.isFinite(tick))return REST;
  const move=Number(c.moveId),wind=clamp((tick-start)/Math.max(1,active-start));
  const recover=1-smooth((tick-endActive)/Math.max(1,end-endActive));
  let kind='none',phase='idle',progress=wind,lift=0,pitch=0,compression=0,grounded=true,dig=0;
  if(move===91){
    kind='dig';
    if(tick<start+4){phase='enter';progress=clamp((tick-start)/4);dig=progress;pitch=.16*smooth(progress);}
    else if(tick<active){phase='hidden';progress=1;dig=1;}
    else if(tick<active+4){phase='emerge';progress=clamp((tick-active)/4);dig=.55*(1-progress);pitch=-.12*(1-progress);}
    else{phase='recover';progress=1-recover;}
  } else if(move===19||move===143){
    kind='air';
    if(tick<start+4){phase='takeoff';progress=clamp((tick-start)/4);lift=1.35*smooth(progress);pitch=-.15*Math.sin(progress*Math.PI);grounded=progress<.08;}
    else if(tick<active){phase='hidden';progress=1;grounded=false;}
    else if(tick<endActive+3){phase='land';progress=clamp((tick-active)/4);compression=.18*Math.sin((.2+progress*.8)*Math.PI);pitch=.1*(1-progress);}
    else{phase='recover';progress=1-recover;}
  } else if([34,26,27,136].includes(move)){
    kind='slam';
    if(wind<.22&&tick<active){phase='brace';progress=wind/.22;compression=.12*smooth(progress);}
    else if(tick<active){
      const flight=clamp((wind-.22)/.78);phase=flight<.5?'rise':'fall';progress=flight;
      lift=(move===34?.78:.5)*Math.sin(Math.PI*flight);grounded=false;
      pitch=move===34?.95*smooth(flight):.2*Math.sin(Math.PI*flight);
    }else if(tick<endActive+2){phase='contact';progress=clamp((tick-active)/(endActive+2-active));compression=.17*(1-smooth(progress));pitch=move===34?.95-.2*smooth(progress):.13*(1-progress);}
    else{phase='recover';progress=1-recover;pitch=move===34?.75*(1-smooth((tick-endActive-2)/Math.max(1,end-endActive-2))):0;}
  }else if(move===69){
    // There is no authoritative grapple in current combat. The caster can wind
    // up and release; a target is never lifted, attached or hit by this sampler.
    kind='throw';phase=tick<active?'windup':tick<endActive?'release':'recover';
    pitch=tick<active?-.13*smooth(wind):.18*recover;compression=tick<active?.065*wind:0;
  }else return REST;
  if(reduced){lift=0;pitch=0;compression*=.25;dig=0;}
  return Object.freeze({kind,phase,progress,lift,pitch,compression,grounded,dig});
}

/** Move existing pixel regions into/out of the ground head first. The head to
 * tail path comes from the visible source anatomy, so a serpent's segments
 * follow in order; the result is clipped at the original grounded baseline.
 * This is not replacement geometry: source UVs and colors are unchanged. */
export function stagePixelPoint(stage,anchors,x,y) {
  if(!stage||stage.kind!=='dig'||!(stage.dig>0))return {x,y};
  const head=anchors.find(a=>a.name==='head')||{x:.35,y:.3};
  const chain=[head,...anchors.filter(a=>/^segment\d+$/.test(a.name)).sort((a,b)=>Number(a.name.slice(7))-Number(b.name.slice(7))),
    anchors.find(a=>a.name==='tailTip')||anchors.find(a=>a.name==='tail')||{x:.6,y:.9}];
  let along=0,best=Infinity,length=0;
  const lengths=chain.slice(1).map((b,i)=>Math.hypot(b.x-chain[i].x,b.y-chain[i].y));
  const total=lengths.reduce((a,b)=>a+b,0)||1;
  for(let i=0;i<chain.length-1;i++){
    const a=chain[i],b=chain[i+1],dx=b.x-a.x,dy=b.y-a.y;
    const t=clamp(((x-a.x)*dx+(y-a.y)*dy)/Math.max(.0001,dx*dx+dy*dy));
    const distance=Math.hypot(x-a.x-t*dx,y-a.y-t*dy);
    if(distance<best){best=distance;along=(length+lengths[i]*t)/total;}
    length+=lengths[i];
  }
  // Enter head first, and expose that same head first when leaving the tunnel.
  const order=stage.phase==='emerge'?1-along:along;
  const drop=1.25*smooth((stage.dig-order*.3)/.7);
  return {x:x+(head.x-x)*Math.min(.16,drop*.13)*clamp((1-y)*4),y:Math.min(1,y+drop)};
}
