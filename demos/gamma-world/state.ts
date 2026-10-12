import type { WorldSave, WorldMap, Point, Rect, BattleReturn, PartnerVitals } from './types';
export const SAVE_KEY='gamma-world-v1';
export const BACKUP_KEY='gamma-world-v1-previous';
export const PLAYABLE=[25,37,54,111,112,116,117,149];
export const inside=(p:Point,r:Rect,margin=0)=>p.x>=r.x-r.w/2+margin&&p.x<=r.x+r.w/2-margin&&p.z>=r.z-r.d/2+margin&&p.z<=r.z+r.d/2-margin;
export function canStand(map:WorldMap,p:Point,radius=.24) {return Number.isFinite(p.x)&&Number.isFinite(p.z)&&map.walkable.some(r=>inside(p,r,radius))&&!map.blockers.some(r=>inside(p,r,-radius));}
export function moveOnMap(map:WorldMap,p:Point,dx:number,dz:number):Point {
  // Substeps prevent a fast frame or pointer move from crossing a narrow wall.
  const n=Math.max(1,Math.ceil(Math.hypot(dx,dz)/.12));let q={...p};
  for(let i=0;i<n;i++){const next={x:q.x+dx/n,z:q.z+dz/n};if(canStand(map,next))q=next;else{const x={x:next.x,z:q.z};if(canStand(map,x))q=x;const z={x:q.x,z:next.z};if(canStand(map,z))q=z;}}
  return q;
}
export function newGame(trainer:WorldSave['trainer'],partner:number,firstMap:WorldMap):WorldSave {
  if(!PLAYABLE.includes(partner))throw new Error('伙伴没有可用的原版动作与当前战斗规则。');
  return{version:1,trainer,partner,level:35,mapId:firstMap.id,position:{...firstMap.spawn},lastCamp:{mapId:firstMap.id,position:{...(firstMap.camp??firstMap.spawn)}},flags:[],collected:[],defeated:[],completedBattles:[],visited:[firstMap.id],bag:{potion:3,ether:1},vitals:null,encounters:0,steps:0,playSeconds:0,lastSaved:new Date().toISOString(),activeEncounter:null,chapterComplete:false,destroyed:[]};
}
export function giveFlag(save:WorldSave,flag:string){if(!save.flags.includes(flag))save.flags.push(flag);}
function validVitals(v:PartnerVitals) {
  if(!v||!Number.isFinite(v.hp)||!Number.isFinite(v.maxHp)||v.hp<0||v.maxHp<=0||v.hp>v.maxHp||!Array.isArray(v.moves)||v.moves.length<1||v.moves.length>4)return false;
  const ids=new Set<number>();
  for(const m of v.moves){if(!m||!Number.isSafeInteger(m.id)||m.id<1||m.id>165||ids.has(m.id)||!Number.isSafeInteger(m.pp)||m.pp<1||!Number.isSafeInteger(m.remainingPp)||m.remainingPp<0||m.remainingPp>m.pp||typeof m.name!=='string'||typeof m.type!=='string')return false;ids.add(m.id);}
  return true;
}
export function heal(save:WorldSave){save.vitals=null;save.activeEncounter=null;}
export function useItem(save:WorldSave,item:'potion'|'ether'):string {
  if(save.bag[item]<=0)return '背包里已经没有了。';
  if(!save.vitals)return '伙伴现在状态很好，不需要使用。';
  if(item==='potion') {if(save.vitals.hp>=save.vitals.maxHp)return 'HP 已经恢复满了。';save.vitals.hp=Math.min(save.vitals.maxHp,save.vitals.hp+Math.ceil(save.vitals.maxHp*.5));save.bag.potion--;return '伙伴恢复了 50% 的最大 HP。';}
  if(save.vitals.moves.every(m=>m.remainingPp>=m.pp))return '所有招式的 PP 都是满的。';
  save.vitals.moves.forEach(m=>m.remainingPp=Math.min(m.pp,m.remainingPp+10));save.bag.ether--;return '所有招式恢复了 10 点 PP。';
}
export function applyBattleResult(save:WorldSave,result:BattleReturn,storyFlag?:string):'won'|'lost'|'duplicate' {
  if(save.completedBattles.includes(result.battleId))return 'duplicate';
  if(save.activeEncounter!==result.encounterId||result.playerFighter.speciesId!==save.partner||result.playerFighter.level!==save.level)throw new Error('这场战斗不属于当前探索进度。');
  if(!validVitals(result.playerFighter))throw new Error('战后状态无效。');
  save.completedBattles.push(result.battleId);save.completedBattles=save.completedBattles.slice(-128);save.activeEncounter=null;
  save.vitals={hp:result.playerFighter.hp,maxHp:result.playerFighter.maxHp,moves:result.playerFighter.moves.map(m=>({...m}))};
  if(result.winner==='player'){if(storyFlag)giveFlag(save,storyFlag);if(!save.defeated.includes(result.encounterId)&&storyFlag){save.defeated.push(result.encounterId);save.bag.potion++;}return 'won';}
  save.mapId=save.lastCamp.mapId;save.position={...save.lastCamp.position};heal(save);return 'lost';
}
export function restoreSave(raw:string|null,maps:WorldMap[]):WorldSave|null {
  if(!raw)return null;
  try {const s=JSON.parse(raw) as WorldSave;const map=maps.find(m=>m.id===s.mapId),camp=maps.find(m=>m.id===s.lastCamp?.mapId);
    if(s.version!==1||!['brendan','may'].includes(s.trainer)||!PLAYABLE.includes(s.partner)||s.level!==35||!map||!camp||!s.position||!s.lastCamp?.position)return null;
    for(const key of ['flags','collected','defeated','completedBattles','visited'] as const)if(!Array.isArray(s[key])||s[key].length>1000||s[key].some(v=>typeof v!=='string'||v.length>160))return null;
    if(!s.bag||!Number.isSafeInteger(s.bag.potion)||!Number.isSafeInteger(s.bag.ether)||s.bag.potion<0||s.bag.ether<0||s.bag.potion>999||s.bag.ether>999)return null;
    if(s.vitals!==null&&!validVitals(s.vitals))return null;
    for(const key of ['encounters','steps','playSeconds'] as const)if(!Number.isFinite(s[key])||s[key]<0)return null;
    if(!canStand(map,s.position))s.position={...map.spawn};if(!canStand(camp,s.lastCamp.position))s.lastCamp.position={...(camp.camp??camp.spawn)};
    if(typeof s.activeEncounter!=='string'&&s.activeEncounter!==null)return null;
    if(s.destroyed===undefined)s.destroyed=[];if(!Array.isArray(s.destroyed)||s.destroyed.length>8000||s.destroyed.some(id=>typeof id!=='string'||id.length>160))return null;s.destroyed=[...new Set(s.destroyed)];s.chapterComplete=!!s.chapterComplete;return s;
  }catch{return null;}
}
export function saveGame(storage:Pick<Storage,'setItem'>,save:WorldSave) {save.lastSaved=new Date().toISOString();storage.setItem(SAVE_KEY,JSON.stringify(save));}
export function recoverInterrupted(save:WorldSave) {if(!save.activeEncounter)return false;save.mapId=save.lastCamp.mapId;save.position={...save.lastCamp.position};heal(save);return true;}
