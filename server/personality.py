"""Permanent individual natures and this game's innate tactical preferences.

These use the familiar 25 nature names, but their tactical effects are our
realtime adaptation, not cartridge stat multipliers. Assignment depends only
on the individual ID and is persisted by the application. Battle constructors
snapshot the numeric profile so a running battle never changes underneath it.
"""
from __future__ import annotations

import copy
import hashlib


TACTICS = ("press", "kite", "strafe", "bait", "burst", "guard", "reposition")
TACTIC_NAMES = ("贴身追击", "保持距离", "绕侧游走", "诱招反击", "抓住破绽", "稳守调息", "脱离墙角")
MECHANICS_NOTE = "性格影响先天战术、避险、反应与交战距离；训练可改变决策，不改变性格。不套用原作能力值加减。"


def _nature(name, description, dialogue, battle_style, favored, danger=1., reaction=0,
            threshold=1., risk=1., distance=0.):
    bias = [0.] * len(TACTICS)
    for tactic, amount in favored:
        bias[TACTICS.index(tactic)] = amount
    return {"name": name, "description": description, "dialogueStyle": dialogue,
            "battleStyle": battle_style,
            "preferredTactics": [TACTIC_NAMES[TACTICS.index(t)] for t, _ in favored],
            "combat": {"version": 1, "tacticBias": bias, "dangerMultiplier": danger,
                       "reactionOffset": reaction, "attackThresholdMultiplier": threshold,
                       "riskMultiplier": risk, "distanceOffset": distance}}


# Order is an assignment contract: append/version a future catalog, do not reorder.
NATURES = {
    "hardy": _nature("勤奋", "踏实耐心，愿意反复练习。", "朴实认真，重视努力与进步。", "稳步接近，持续施压", [("press", .65), ("strafe", .45)], .95, 0, .9, .95, -.15),
    "lonely": _nature("怕寂寞", "珍惜陪伴，被关注时更有勇气。", "温柔黏人，会表达想一起行动。", "主动贴近，寻找反击", [("press", 1.05), ("bait", .5)], .85, 1, .85, .8, -.4),
    "brave": _nature("勇敢", "迎难而上，愿意承担风险。", "坚定直接，遇到困难先鼓励行动。", "近身压迫，敢于抢攻", [("press", 1.35), ("burst", .75)], .65, 1, .65, .55, -.6),
    "adamant": _nature("固执", "认定目标后不轻易退缩。", "简短坚定，有主见但接受训练。", "持续追击，压住破绽", [("press", 1.25), ("burst", .6)], .75, 1, .7, .65, -.45),
    "naughty": _nature("顽皮", "喜欢出其不意，把挑战当游戏。", "俏皮活泼，爱开轻松的小玩笑。", "绕侧突袭，冒险抢攻", [("strafe", .95), ("burst", .8)], .75, -1, .75, .7, -.15),
    "bold": _nature("大胆", "临危镇定，愿意正面迎接挑战。", "爽朗自信，鼓励尝试。", "稳住阵脚，正面反击", [("guard", .85), ("burst", .95)], 1.15, 0, .95, 1.05, .15),
    "docile": _nature("坦率", "真诚随和，愿意沟通和配合。", "直接友善，不掩饰感受。", "稳定游走，兼顾攻守", [("strafe", .7), ("guard", .35)], 1.05, 0, 1., 1.05, .1),
    "relaxed": _nature("悠闲", "从容自在，不急着争先。", "舒缓随和，提醒适当休息。", "留出距离，耐心调息", [("guard", 1.15), ("kite", .6)], 1.3, 2, 1.35, 1.35, .65),
    "impish": _nature("淘气", "爱试探对方，善于制造小惊喜。", "机灵爱笑，会用轻松语气回应。", "诱招走位，绕侧反击", [("bait", 1.15), ("strafe", .75)], 1.1, -1, .95, 1., .25),
    "lax": _nature("乐天", "乐观自在，挫折后很快恢复心情。", "轻松乐观，不夸大胜负。", "随势游走，放手进攻", [("strafe", .8), ("burst", .55)], .8, 2, .85, .8, .1),
    "timid": _nature("胆小", "对危险敏感，熟悉环境后才放松。", "谨慎轻声，表达担心也珍惜鼓励。", "优先避险，远距周旋", [("kite", 1.35), ("guard", .75)], 1.65, -2, 1.4, 1.7, .8),
    "hasty": _nature("急躁", "行动迅速，常想立即试一试。", "短句活跃，容易迫不及待。", "快速切入，抢抓窗口", [("burst", 1.15), ("press", .8)], .7, -2, .65, .65, -.4),
    "serious": _nature("认真", "专注细节，对约定和训练很上心。", "清楚认真，喜欢具体目标。", "审慎游走，确认后反击", [("strafe", .65), ("bait", .65)], 1.15, 0, 1.1, 1.15, .15),
    "jolly": _nature("爽朗", "精力充沛，喜欢和伙伴一起挑战。", "明快热情，主动分享喜悦。", "灵活绕侧，积极追击", [("strafe", 1.2), ("press", .6)], .95, -2, .85, .85, -.15),
    "naive": _nature("天真", "好奇开放，容易被新事物吸引。", "自然好奇，乐于询问和尝试。", "大胆试探，见机抢攻", [("burst", .95), ("strafe", .7)], .7, -1, .7, .7, -.2),
    "modest": _nature("内敛", "含蓄稳重，用行动表达信任。", "简洁含蓄，温和表达关心。", "保持射程，等待好机会", [("kite", 1.05), ("bait", .65)], 1.2, 0, 1.15, 1.25, .5),
    "mild": _nature("慢吞吞", "温和不争，愿意按自己的节奏行动。", "语气柔和，回应从容。", "守住距离，从容恢复", [("guard", 1.), ("kite", .55)], 1.25, 2, 1.25, 1.3, .5),
    "quiet": _nature("冷静", "善于观察，关键时刻很沉着。", "话少而清晰，先观察再判断。", "预留空间，诱招反击", [("bait", 1.3), ("kite", .55)], 1.25, 1, 1.15, 1.3, .45),
    "bashful": _nature("害羞", "慢热细腻，信任建立后更愿意表达。", "温柔含蓄，逐渐表达亲近。", "谨慎守备，留出余地", [("guard", 1.25), ("kite", .85)], 1.5, 0, 1.35, 1.5, .7),
    "rash": _nature("马虎", "热情大胆，容易先做再想。", "随性直接，会坦然承认疏忽。", "放手突击，偏爱抢攻", [("burst", 1.25), ("press", .85)], .6, 1, .6, .55, -.55),
    "calm": _nature("温和", "沉着包容，重视伙伴的感受。", "安稳温柔，鼓励循序渐进。", "稳守调息，减少冒险", [("guard", .55), ("bait", .35)], 1.5, 0, .8, 1.05, .6),
    "gentle": _nature("温顺", "体贴亲和，珍视合作与陪伴。", "柔和体贴，会关心训练家的感受。", "保持余地，稳定防守", [("kite", .85), ("guard", 1.)], 1.35, 1, 1.25, 1.4, .6),
    "sassy": _nature("自大", "自信强烈，喜欢用表现证明自己。", "带一点得意，尊重事实和伙伴。", "诱敌露招，再强势反击", [("bait", 1.05), ("burst", .95)], .85, 1, .8, .8, -.05),
    "careful": _nature("慎重", "仔细衡量风险，喜欢有准备的行动。", "审慎清晰，先确认已知事实。", "看清威胁，远距反击", [("bait", 1.2), ("kite", 1.)], 1.6, -1, 1.4, 1.65, .75),
    "quirky": _nature("浮躁", "想法活跃，喜欢不断调整行动。", "灵动好奇，表达简洁多变。", "积极换位，寻找新角度", [("strafe", 1.), ("reposition", 1.)], 1., -1, .9, .95, .3),
}
NATURE_IDS = tuple(NATURES)


def nature_from_id(individual_id):
    """Stable across process restarts, species evolution and Python hash seeds."""
    digest = hashlib.sha256(("kanto-nature-v1:" + str(individual_id)).encode("utf-8")).digest()
    return NATURE_IDS[int.from_bytes(digest[:8], "big") % len(NATURE_IDS)]


def public_personality(nature_id):
    """Return a fresh display/prompt object; unknown IDs have no invented nature."""
    nature = NATURES.get(nature_id) if isinstance(nature_id, str) else None
    if nature is None:
        return None
    return {"id": nature_id, **copy.deepcopy({k: v for k, v in nature.items() if k != "combat"}),
            "mechanicsNote": MECHANICS_NOTE}


def combat_personality(nature_id):
    nature = NATURES.get(nature_id) if isinstance(nature_id, str) else None
    return copy.deepcopy(nature["combat"]) if nature else {}
