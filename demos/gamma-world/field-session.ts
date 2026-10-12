import { createGammaBattle, getGammaBattle, sendGammaCommand, sendGammaNavigate, asBattle, GammaApiError, type GammaBattle, type GammaBattleOptions } from '../gamma-battle/api-client';
import { beginCommand, commandFeedback, type CommandAttempt, type CommandFeedback } from '../../apps/web/command-feedback';
import type { BattleCommand } from '../../apps/web/api';
import { GammaAudio } from '../gamma-battle/gamma-audio';
import type { Point } from './types';

const esc=(v:unknown)=>String(v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
const labels:Record<string,string>={windup:'蓄力',active:'出招',recovery:'收招',sleep:'睡眠',burn:'灼伤',poison:'中毒',paralysis:'麻痹'};
type Callbacks={onSnapshot:(battle:GammaBattle)=>void;onFinish:(battle:GammaBattle)=>void|Promise<void>;onLeave:()=>void;onError?:(error:Error)=>void};
type NavigationAttempt={baseline:number;target:Point;expires?:number;message:string;delivery:'sending'|'accepted'|'failed'|'uncertain';confirmed?:CommandFeedback};
const samePoint=(a:Point|undefined,b:Point|undefined)=>!!a&&!!b&&a.x===b.x&&a.z===b.z;
const definiteRejection=(error:unknown)=>error instanceof GammaApiError&&error.status>=400&&error.status<500;
function frozenRequest(options:GammaBattleOptions){
  const copy=structuredClone(options);
  const freeze=(value:unknown)=>{if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}};
  freeze(copy);return copy;
}

/** Verify the immutable request before any renderer or settlement sees a reply. */
export function validateFieldBattle(data:GammaBattle,options:GammaBattleOptions,boundId?:string){
  const expected=options.field,actual=data.field;
  if(!expected||!actual||!/^[a-f0-9]{32}$/.test(data.id)||boundId&&data.id!==boundId||
    data.source!=='authoritative-live-memory'||data.persisted!==false||!['active','finished'].includes(data.status)||
    !Number.isSafeInteger(data.tick)||data.tick<0||!Number.isSafeInteger(data.eventSeq)||(data.eventSeq??-1)<0||
    data.encounterId!==options.encounterId||data.bridgeSessionId!==options.bridgeSessionId||
    data.playerSpeciesId!==options.playerSpeciesId||data.opponentSpeciesId!==options.opponentSpeciesId||
    options.seed!==undefined&&data.seed!==options.seed||
    actual.mapId!==expected.mapId||!samePoint(actual.origin,expected.origin)||
    !samePoint(actual.playerStart,expected.playerStart)||!samePoint(actual.opponentStart,expected.opponentStart))
    throw new Error('当前遭遇、战斗场地或服务端绑定不匹配。');
  const terrain=actual.terrain,wanted=expected.terrain;
  if(!terrain||['cellSize','cols','rows','x0','z0'].some(key=>terrain[key as keyof typeof terrain]!==wanted[key as keyof typeof wanted])||
    (terrain.maxStep??.48)!==(wanted.maxStep??.48)||!Array.isArray(terrain.heights)||terrain.heights.length!==wanted.heights.length||
    terrain.heights.some((value,index)=>value!==wanted.heights[index]))throw new Error('服务端采用的地形与本次战斗场地不一致。');
  const originals=new Map(expected.obstacles.map(o=>[o.id,o]));
  if(!Array.isArray(actual.obstacles)||actual.obstacles.length!==originals.size||new Set(actual.obstacles.map(o=>o.id)).size!==originals.size||
    actual.obstacles.some(o=>{const original=originals.get(o.id);return !original||['x','z','radius','hp','solid','kind'].some(key=>o[key as keyof typeof o]!==original[key as keyof typeof original]);})||
    !Array.isArray(actual.destroyed)||new Set(actual.destroyed).size!==actual.destroyed.length||actual.destroyed.some(id=>!originals.has(id)||originals.get(id)!.solid))
    throw new Error('服务端掩体状态与本次房间对象不一致。');
  if(!Array.isArray(data.fighters)||data.fighters.length!==2||data.playerId===data.opponentId||
    data.fighters.filter(f=>f.id===data.playerId).length!==1||data.fighters.filter(f=>f.id===data.opponentId).length!==1)
    throw new Error('服务端缺少本场交锋的双方状态。');
  for(const f of data.fighters){
    if(f.level!==options.level||f.speciesId!==(f.id===data.playerId?options.playerSpeciesId:options.opponentSpeciesId)||
      !Number.isFinite(f.hp)||!Number.isFinite(f.maxHp)||f.maxHp<=0||f.hp<0||f.hp>f.maxHp||
      !Array.isArray(f.moves)||f.moves.length<1||f.moves.length>4||new Set(f.moves.map(m=>m.id)).size!==f.moves.length||
      f.moves.some(m=>!Number.isInteger(m.id)||m.id<1||m.id>165||typeof m.pp!=='number'||!Number.isInteger(m.pp)||m.pp<1||typeof m.remainingPp!=='number'||!Number.isInteger(m.remainingPp)||m.remainingPp<0||m.remainingPp>m.pp))
      throw new Error('伙伴等级、体力或 PP 与本场交锋不匹配。');
  }
  if(data.status==='finished'&&data.winner!==null&&data.winner!==data.playerId&&data.winner!==data.opponentId)
    throw new Error('战斗结果没有可核验的胜负归属。');
}

export function navigationFeedback(b:GammaBattle,attempt:NavigationAttempt):CommandFeedback{
  if(attempt.delivery==='failed')return{phase:'failed',title:'走位未被接收',detail:attempt.message};
  if(attempt.confirmed)return attempt.confirmed;
  const events=b.events.filter(e=>e.actor===b.playerId&&(e.eventSeq??0)>attempt.baseline).sort((a,c)=>(a.eventSeq??0)-(c.eventSeq??0));
  const receipt=events.find(e=>e.kind==='command'&&e.command==='navigate'&&samePoint(e.target as unknown as Point|undefined,attempt.target)&&(attempt.expires===undefined||e.expiresTick===attempt.expires));
  const active=b.fighters.find(f=>f.id===b.playerId)?.activeCommand;
  const matchingActive=active?.command==='navigate'&&samePoint(active.target,attempt.target)&&(attempt.expires===undefined||active.expiresTick===attempt.expires);
  const following=receipt?events.slice(events.indexOf(receipt)+1):[];
  const replacement=following.findIndex(e=>e.kind==='command');
  const end=(replacement<0?following:following.slice(0,replacement)).find(e=>e.kind==='commandEnd'&&e.command==='navigate');
  if(end?.reason==='executed')return{phase:'executed',title:'已抵达指定位置',detail:'伙伴已完成这次走位。'};
  if(end?.reason==='expired')return{phase:'expired',title:'走位有效期已结束',detail:'伙伴未在五秒内抵达；当前继续自主行动。'};
  if(b.status==='finished')return{phase:'ended',title:'对战已结束',detail:'本次走位已停止，未确认抵达。'};
  if(replacement>=0)return{phase:'superseded',title:'走位已被新指令替换',detail:'伙伴正在执行后续指令。'};
  const accepted=receipt||matchingActive||attempt.delivery==='accepted';
  const expires=receipt?.expiresTick??attempt.expires;
  if(typeof expires==='number'&&b.tick>=expires)return{phase:'uncertain',title:'走位结果待确认',detail:'有效期已结束，当前战况中未保留抵达回执。'};
  if(!accepted)return{phase:attempt.delivery==='sending'?'sending':'uncertain',title:attempt.delivery==='sending'?'正在发送走位':'走位送达待确认',detail:attempt.message};
  return{phase:'tactic',title:'正在前往指定位置',detail:'伙伴会绕开房间内的障碍；抵达以服务端回执为准。'};
}
/** Network and command UI for the existing engine. Owns no combat simulation. */
export class FieldSession {
  private battle?:GammaBattle;
  private timer=0;
  private resultTimer=0;
  private disposed=false;
  private pending=false;
  private failures=0;
  private connecting=false;
  private attempt?:CommandAttempt;
  private confirmed?:CommandFeedback;
  private navigation?:NavigationAttempt;
  private moveKey='';
  private lastEventSeq=0;
  private completed=false;
  private sounds=false;
  private audio=new GammaAudio();
  private node:HTMLElement;
  constructor(private host:HTMLElement,readonly options:GammaBattleOptions,private callbacks:Callbacks,mapName:string){
    this.options=frozenRequest(options);
    if(!this.options.field||!this.options.encounterId||!this.options.bridgeSessionId||this.options.level===undefined||this.options.playerSpeciesId===undefined||this.options.opponentSpeciesId===undefined)
      throw new Error('交锋缺少战斗场地、伙伴或会话参数。');
    this.node=document.createElement('div');this.node.className='field-ui';
    this.node.innerHTML=`<div class="field-top"><div><small>ENCOUNTER ROOM · 环境战场</small><strong>${esc(mapName)}</strong><span id="field-clock">连接中</span></div><div class="field-tools"><button id="field-sound">音效 关</button><button id="field-leave">撤退回营地</button></div></div>
    <div class="field-fighter field-enemy"><div><b id="field-enemy-name">野生精灵</b><span id="field-enemy-state"></span></div><div class="field-hp-track"><i id="field-enemy-fill"></i></div><small id="field-enemy-hp"></small></div>
    <div class="field-fighter field-player"><div><b id="field-player-name">你的伙伴</b><span id="field-player-state"></span></div><div class="field-hp-track"><i id="field-player-fill"></i></div><small id="field-player-hp"></small><div class="field-energy"><i id="field-energy-fill"></i></div></div>
    <div class="field-notice" id="field-notice" role="status">正在连接现有实时战斗系统…</div><div class="field-error" id="field-error" hidden><span id="field-error-message"></span><button id="field-retry">重新连接</button></div>
    <div class="field-commands"><div class="field-feedback"><strong id="field-feedback-title">准备交锋</strong><span id="field-feedback-detail">点击空地走位，利用内部掩体避开攻击；外围不可破坏。</span><b id="field-cooldown"></b></div><div class="field-moves" id="field-moves"></div><div class="field-tactics">${[['attack','进攻','A'],['dodge','躲避','S'],['defend','防守','D'],['retreat','拉开','F']].map(([command,name,key])=>`<button data-field-command="${command}">${name}<kbd>${key}</kbd></button>`).join('')}</div><p>点击地面走位 · 1–4 招式 · 中央空地交锋 · 外围岩石与树木不可破坏</p></div>
    <div class="field-result" id="field-result" hidden><small>ENCOUNTER COMPLETE</small><h2 id="field-result-title"></h2><p id="field-result-detail"></p><button id="field-finish">继续探索 →</button></div>`;
    host.replaceChildren(this.node);host.hidden=false;
    this.el('field-retry').onclick=()=>void this.reconnect();
    this.el('field-leave').onclick=()=>{if(!this.completed)callbacks.onLeave();};
    this.el('field-finish').onclick=()=>void this.finish();
    this.el('field-sound').onclick=()=>{this.audio.unlock();this.sounds=!this.sounds;this.audio.setEnabled(this.sounds);this.el('field-sound').textContent=`音效 ${this.sounds?'开':'关'}`;if(this.sounds&&this.battle?.status==='active')this.audio.onEvent({kind:'start',tick:this.battle.tick,text:''});};
    this.node.querySelectorAll<HTMLButtonElement>('[data-field-command]').forEach(b=>b.onclick=()=>void this.command(b.dataset.fieldCommand as BattleCommand));
    window.addEventListener('keydown',this.keyDown);
  }
  private el<T extends HTMLElement=HTMLElement>(id:string){return this.node.querySelector('#'+id) as T;}
  async start(){await this.reconnect();}
  private async reconnect(){if(this.disposed||this.connecting)return;this.connecting=true;clearTimeout(this.timer);try{const data=this.battle?await getGammaBattle(this.battle.id):await createGammaBattle(this.options);if(this.disposed)return;this.failures=0;this.el('field-error').hidden=true;this.apply(data);this.schedule();}catch(error){this.fail(error);}finally{this.connecting=false;}}
  private fail(error:unknown){if(this.disposed)return;this.failures++;this.el('field-error').hidden=false;const e=error instanceof Error?error:new Error(String(error));this.el('field-error-message').textContent=e.message;this.el('field-notice').textContent='连接暂时中断，正在保留当前地图和战斗状态。';this.renderCommands();this.callbacks.onError?.(e);}
  private schedule(){clearTimeout(this.timer);if(this.disposed||this.battle?.status!=='active')return;this.timer=window.setTimeout(()=>void this.poll(),this.failures?1000:100);}
  private async poll(){if(this.disposed||!this.battle)return;try{const data=await getGammaBattle(this.battle.id);if(this.disposed)return;this.failures=0;this.el('field-error').hidden=true;this.apply(data);}catch(error){this.fail(error);}this.schedule();}
  private apply(data:GammaBattle){
    if(this.disposed)return false;
    validateFieldBattle(data,this.options,this.battle?.id);
    if(this.battle?.status==='finished'&&data.status!=='finished')throw new Error('已结束的交锋不能恢复为进行中状态。');
    if(this.battle&&(data.tick<this.battle.tick||data.tick===this.battle.tick&&(data.eventSeq??0)<(this.battle.eventSeq??0)))return false;
    const wasFinished=this.battle?.status==='finished';this.battle=data;this.callbacks.onSnapshot(data);
    for(const f of data.fighters){const side=f.id===data.playerId?'player':'enemy',pct=Math.max(0,f.hp/f.maxHp*100);this.el(`field-${side}-name`).textContent=`${f.name} · Lv.${f.level}`;this.el(`field-${side}-hp`).textContent=`${Math.ceil(f.hp)} / ${Math.ceil(f.maxHp)} HP`;this.el(`field-${side}-fill`).style.width=pct+'%';this.el(`field-${side}-fill`).style.background=pct<20?'#d87965':pct<50?'#d9b968':'#a4cc83';this.el(`field-${side}-state`).textContent=f.hp<=0?'无法战斗':labels[f.status??'']??labels[f.phase??'']??'自主行动';if(side==='player')this.el('field-energy-fill').style.width=Math.max(0,Math.min(100,f.energy??0))+'%';}
    this.el('field-clock').textContent=`${data.status==='active'?'实时交锋':'战斗结束'} · ${(data.tick/(data.tickRate||20)).toFixed(1)}s`;
    for(const e of data.events){if((e.eventSeq??0)<=this.lastEventSeq)continue;this.lastEventSeq=Math.max(this.lastEventSeq,e.eventSeq??0);if(['start','cast','break','clash','clashBurst','ko','commandEnd','terrainBlock','obstacleHit'].includes(e.kind??'')&&e.text)this.el('field-notice').textContent=e.kind==='break'?'掩体已被击碎，原来的遮挡位置现在可以通行。':e.text;this.audio.onEvent({...e,battleId:data.id,speciesId:data.fighters.find(f=>f.id===e.actor)?.speciesId});}
    this.audio.onFrame(data.fighters,data.tick);this.renderCommands();
    if(data.status==='finished'&&!wasFinished){clearTimeout(this.timer);this.audio.onEvent({kind:'result',tick:data.tick,text:'',winner:data.winner??null,playerId:data.playerId});this.resultTimer=window.setTimeout(()=>{if(this.disposed)return;this.el('field-result-title').textContent=data.winner===data.playerId?'赢下了这场交锋。':data.winner===data.opponentId?'伙伴需要休息。':'这场交锋结束了。';const destroyed=(data.field?.destroyed??[]).length;this.el('field-result-detail').textContent=`交锋 ${(data.tick/(data.tickRate||20)).toFixed(1)} 秒${destroyed?` · 本场击碎 ${destroyed} 处掩体`:''}`;this.el('field-finish').textContent=data.winner===data.playerId?'返回遭遇地点 →':'返回营地休息 →';this.el('field-result').hidden=false;},900);}
    return true;
  }
  private renderCommands(){const b=this.battle,f=b?.fighters.find(f=>f.id===b.playerId);if(!b||!f)return;
    let feedback:CommandFeedback;
    if(this.navigation){feedback=navigationFeedback(b,this.navigation);if(['executed','expired','superseded'].includes(feedback.phase))this.navigation.confirmed=feedback;}
    else{const observed=commandFeedback(asBattle(b),b.playerId,this.attempt);if(this.attempt&&['executed','expired'].includes(observed.phase))this.confirmed=observed;feedback=this.confirmed??observed;}
    this.el('field-feedback-title').textContent=feedback.title;this.el('field-feedback-detail').textContent=feedback.detail;this.el('field-cooldown').textContent=f.commandCooldownMs>0?`${(f.commandCooldownMs/1000).toFixed(1)}s`:'';
    const key=f.moves.map(m=>`${m.id}:${m.remainingPp}:${m.pp}`).join('|');if(key!==this.moveKey){this.moveKey=key;this.el('field-moves').innerHTML=f.moves.map((m,i)=>`<button data-field-move="${m.id}"><kbd>${i+1}</kbd><strong>${esc(m.name)}</strong><small>PP ${m.remainingPp}/${m.pp}</small></button>`).join('');this.node.querySelectorAll<HTMLButtonElement>('[data-field-move]').forEach(button=>button.onclick=()=>void this.command('move',Number(button.dataset.fieldMove)));}
    this.node.querySelectorAll<HTMLButtonElement>('[data-field-command],[data-field-move]').forEach(button=>{const command=button.dataset.fieldCommand??'move',moveId=Number(button.dataset.fieldMove),option=f.commandOptions.find(o=>o.command===command&&(command!=='move'||o.moveId===moveId));button.disabled=this.pending||this.failures>0||b.status!=='active'||f.commandCooldownMs>0||!!option?.disabled;button.title=option?.reason??'';});
  }
  private async command(command:BattleCommand,moveId?:number){
    const b=this.battle,f=b?.fighters.find(f=>f.id===b.playerId);
    if(!b||!f||b.status!=='active'||this.pending||this.failures||f.commandCooldownMs>0)return;
    const option=f.commandOptions.find(o=>o.command===command&&(command!=='move'||o.moveId===moveId));if(!option||option.disabled)return;
    this.navigation=undefined;this.confirmed=undefined;this.attempt=beginCommand(asBattle(b),b.playerId,{command,moveId,label:option.label});this.pending=true;this.renderCommands();
    try{
      const response=await sendGammaCommand(b.id,command,moveId);if(this.disposed)return;
      validateFieldBattle(response.snapshot,this.options,b.id);
      if(response.accepted!==true||response.command!==command||command==='move'&&response.moveId!==moveId||!Number.isSafeInteger(response.expiresTick))throw new Error('指令回执与本次请求不一致。');
      this.attempt={...this.attempt,delivery:'accepted',expiresTick:response.expiresTick};this.apply(response.snapshot);
    }catch(error){if(this.disposed)return;this.attempt={...this.attempt,delivery:definiteRejection(error)?'failed':'uncertain',message:error instanceof Error?error.message:'指令送达待确认'};}
    finally{this.pending=false;if(!this.disposed)this.renderCommands();}
  }
  async navigate(target:Point){
    const b=this.battle,f=b?.fighters.find(f=>f.id===b.playerId);if(!b||!f||b.status!=='active'||this.pending||this.failures)return;
    if(!Number.isFinite(target.x)||!Number.isFinite(target.z)){this.el('field-notice').textContent='请选择地图中的有效位置。';return;}
    if(f.commandCooldownMs>0){this.el('field-notice').textContent='请等待指令间隔结束，再指定走位。';return;}
    const requested={...target};this.pending=true;this.navigation={baseline:b.eventSeq??0,target:requested,delivery:'sending',message:'正在传达指定位置…'};this.attempt=undefined;this.confirmed=undefined;this.renderCommands();
    try{
      const response=await sendGammaNavigate(b.id,requested);if(this.disposed)return;
      validateFieldBattle(response.snapshot,this.options,b.id);
      if(response.accepted!==true||response.command!=='navigate'||!samePoint(response.target,requested)||!Number.isSafeInteger(response.expiresTick))throw new Error('走位回执与本次指定位置不一致。');
      this.navigation={...this.navigation,delivery:'accepted',expires:response.expiresTick,message:'伙伴正在前往指定位置；地形与障碍物仍参与碰撞。'};this.apply(response.snapshot);
    }catch(error){if(!this.disposed){this.navigation.delivery=definiteRejection(error)?'failed':'uncertain';this.navigation.message=error instanceof Error?error.message:'走位送达待确认';this.el('field-notice').textContent=this.navigation.delivery==='uncertain'?'连接未能确认这次走位，正在根据战况核对。':this.navigation.message;}}
    finally{this.pending=false;if(!this.disposed)this.renderCommands();}
  }
  private async finish(){
    if(this.disposed||this.completed||this.battle?.status!=='finished')return;
    this.completed=true;this.el<HTMLButtonElement>('field-finish').disabled=true;this.el<HTMLButtonElement>('field-leave').disabled=true;
    try{
      const verified=await getGammaBattle(this.battle.id);if(this.disposed)return;
      validateFieldBattle(verified,this.options,this.battle.id);
      if(verified.status!=='finished'||!this.apply(verified))throw new Error('未取得本场最新的已结束战斗结果，请重新连接后重试。');
      await this.callbacks.onFinish(verified);
    }catch(error){if(this.disposed)return;this.completed=false;this.el<HTMLButtonElement>('field-finish').disabled=false;this.el<HTMLButtonElement>('field-leave').disabled=false;this.fail(error);}
  }
  private keyDown=(event:KeyboardEvent)=>{if(event.repeat||event.ctrlKey||event.metaKey||event.altKey||event.target instanceof HTMLInputElement||event.target instanceof HTMLSelectElement||event.target instanceof HTMLTextAreaElement||(event.target instanceof HTMLElement&&event.target.isContentEditable))return;const command=({a:'attack',s:'dodge',d:'defend',f:'retreat'} as Record<string,BattleCommand>)[event.key.toLowerCase()];if(command){event.preventDefault();void this.command(command);}else if(/^[1-4]$/.test(event.key)&&this.battle){const f=this.battle.fighters.find(f=>f.id===this.battle!.playerId),m=f?.moves[Number(event.key)-1];if(m){event.preventDefault();void this.command('move',m.id);}}};
  get snapshot(){return this.battle;}
  dispose(){this.disposed=true;clearTimeout(this.timer);clearTimeout(this.resultTimer);window.removeEventListener('keydown',this.keyDown);this.audio.dispose();this.node.remove();this.host.hidden=true;}
}
