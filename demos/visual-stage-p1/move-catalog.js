// Isolated P1 R3 catalogue. Coverage is not a claim that the videos show every move.
import moves from '../../packages/content/moves.json';
import moveFx from '../../packages/content/move-fx.json';

const DIRECT = {
  53: '战斗效果2 25s HUD Flamethrower：口部橙红火焰团流；水火对冲段仅辅助束流视觉，不据其HUD混同大字爆炎。',
  56: '战斗效果2 9.0–9.7s：背部双炮口、两条独立蓝青水柱、细亮芯、末端扇形水花。',
  69: '战斗效果2 37–40s HUD Seismic Toss：抱起飞高后落地，坑裂、碎岩、扩散环；此图鉴只演示落地特效，不模拟完整抱摔位移。',
  83: '战斗效果2 19.2s HUD Fire Spin，战斗效果1 38.5–39s：环绕目标的螺旋火焰，独立于直喷火流。',
  85: '战斗效果2 13–15s HUD Thunderbolt：皮卡丘局部黄白分叉电弧；不混同旁边飞天螳螂刃光。',
  89: '战斗效果2 18.3–19.2s HUD Earthquake：碎岩上抛与裂地；图鉴按普通地面使用土色，未照搬场地熔岩。',
  91: '战斗效果2 17s及前后 HUD Dig：地洞、土尘与岩屑；图鉴演示地面特效，不改变真实坐标。',
  126: '战斗效果2 27.5–28s HUD Fire Blast，战斗效果1 39.5–40s：独立大字火焰；普通喷火龙使用橙焰，非Mega形态蓝焰。',
};
const TYPE_CASTER = { fire: 6, water: 9, electric: 25, ice: 9, grass: 123, bug: 123, flying: 6, fighting: 143, poison: 6, psychic: 25, ghost: 25, ground: 143, rock: 143, normal: 123, dragon: 6 };
export const ATTACK_CATALOG = Object.freeze(moves.filter(m => m.category !== 'status').map(m => {
  const f = moveFx[String(m.id)];
  return Object.freeze({ id: m.id, name: m.name, nameEn: m.nameEn, type: m.type, category: m.category,
    fx: f.fx, style: f.style || '', shape: f.shape || '', sourceEvidence: DIRECT[m.id] ? 'direct' : 'inferred',
    referenceNote: DIRECT[m.id] || '原片未明确展示此招式；按视频的轮廓、分层、方向、局部粒子语言推导，待逐招验收。',
    defaultCaster: TYPE_CASTER[m.type] || 123 });
}));
export const ATTACK_BY_ID = new Map(ATTACK_CATALOG.map(m => [m.id, m]));
export const EFFECT_COVERAGE = Object.freeze({ attacks: ATTACK_CATALOG.length,
  families: [...new Set(ATTACK_CATALOG.map(m => m.fx))],
  templates: [...new Set(ATTACK_CATALOG.map(m => [m.fx, m.style, m.shape].join(':')))],
  directIds: ATTACK_CATALOG.filter(m => m.sourceEvidence === 'direct').map(m => m.id) });
