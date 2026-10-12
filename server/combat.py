"""Authoritative realtime arena v9 (ruleset kanto-realtime-v8).

Both fighters act independently every 20 Hz tick: they steer continuously,
start casts on their own timers, and react to telegraphed threats after a
per-fighter reaction delay. Every hit is decided by geometry in this file:
real positions, body radii, projectile trajectories (swept collision), locked
beam/area telegraphs, wind-up and active windows. There is no random miss roll
and no client-side outcome; leaving a trajectory or an area really avoids it.

Gen I names, types, PP, learnsets and the type chart are kept; shapes, timing
and hitbox sizes are the documented realtime adaptation in
packages/content/move-mechanics.json. Battles saved by the v2 engine are
restored with server/combat_legacy.py; v3/v4/v5/v6/v7/v8 battles use their frozen modules.
Old saves keep their own rules, including the original tactical controller.
"""
from __future__ import annotations

import copy
import hashlib
import json
import math
from functools import lru_cache
from .content import ROOT, max_hp, stat
from .personality import combat_personality, public_personality

TICK_RATE = 20
MAX_TICKS = 1800
ENGINE_VERSION = 9
RULESET = "kanto-realtime-v8"
BOUND_X, BOUND_Z = 7.0, 5.0
BODY = 0.55
DECISION_TICKS = 10  # per-fighter tactic commitment; fighters are deliberately NOT synchronised
ACTIONS = ("press", "kite", "strafe", "bait", "burst", "guard", "reposition")
TACTIC_ZH = {"press": "贴身追击", "kite": "保持距离", "strafe": "绕侧游走", "bait": "诱招反击",
             "burst": "抓住破绽", "guard": "稳守调息", "reposition": "脱离墙角"}
COMMAND_LABELS = {"attack": "进攻", "dodge": "躲避", "defend": "防守", "retreat": "拉开距离", "move": "使用技能",
                  "weaken": "控血", "hold": "停手保命"}
COMMAND_TICKS = 5 * TICK_RATE
COMMAND_COOLDOWN_TICKS = 2 * TICK_RATE
SPECIAL_TYPES = {"fire", "water", "grass", "electric", "ice", "psychic", "dragon"}
TYPE_ZH = {"一般": "normal", "火": "fire", "水": "water", "草": "grass", "电": "electric",
           "冰": "ice", "格斗": "fighting", "毒": "poison", "地面": "ground", "飞行": "flying",
           "超能力": "psychic", "虫": "bug", "岩石": "rock", "幽灵": "ghost", "龙": "dragon",
           "钢": "steel", "恶": "dark", "妖精": "fairy"}
STATUS_ZH = {"burn": "灼伤", "poison": "中毒", "paralysis": "麻痹", "slow": "迟缓", "sleep": "睡眠"}
# Style = trained preference: danger weight, reaction offset (ticks), attack threshold, risk aversion.
STYLE = {"balanced": (6.0, 0, .028, 1.0), "aggressive": (3.6, 1, .016, .55),
         "defensive": (7.0, 0, .036, 1.5), "evasive": (9.0, -1, .03, 1.25)}


def controller_style(f):
    """Innate tendencies compose with the trained style, never raw stats.

    Use the battle's frozen numeric profile, not the mutable catalog, so saved
    battles and replays keep exactly the parameters they started with.
    """
    style = STYLE.get(f["style"], STYLE["balanced"])
    innate = f.get("innateStyle")
    if not innate:
        return style
    danger, reaction, threshold, risk = style
    return (danger * innate["dangerMultiplier"], reaction + innate["reactionOffset"],
            threshold * innate["attackThresholdMultiplier"], risk * innate["riskMultiplier"])


def reaction_delay(f):
    # Perception history retains 12 ticks, so even slow reactions fit the buffer.
    return int(clamp(f["reaction"] + controller_style(f)[1], 1, 11))


def types_of(species):
    return [TYPE_ZH.get(t, str(t).lower()) for t in species.get("types", ["normal"])]


def effectiveness(attack_type, defending_types):
    value = 1.0
    for kind in defending_types:
        value *= battle_data()[1].get((attack_type, kind), 1)
    return value


@lru_cache(maxsize=1)
def battle_data():
    directory = ROOT / "packages" / "content"
    moves = {m["id"]: m for m in json.loads((directory / "moves.json").read_text())}
    chart = json.loads((directory / "type-chart.json").read_text())
    matchups = {(x["attack"], x["defense"]): x["multiplier"] for x in chart["matchups"]}
    return moves, matchups


@lru_cache(maxsize=1)
def mechanics_table():
    data = json.loads((ROOT / "packages" / "content" / "move-mechanics.json").read_text())
    return {int(k): v for k, v in data.items()}


def mechanics(move):
    return mechanics_table().get(move["id"]) or mechanics_table()[165]


def learned_moves(species, level):
    ids = list(species.get("initialMoves", []))
    for entry in species.get("learnset", []):
        if entry["level"] <= level and entry["moveId"] not in ids:
            ids.append(entry["moveId"])
    known = [copy.deepcopy(battle_data()[0][ident]) for ident in ids[-4:] if ident in battle_data()[0]]
    for move in known:
        move["remainingPp"] = move["pp"]
    return known


def equipped_moves(species, level, move_pp=None):
    """Legal level-up loadout with server-owned saved PP, matched by move ID.

    Missing records start full; unknown IDs cannot add moves. Malformed values
    are ignored, valid integers are bounded, and the first valid record wins.
    Training can call learned_moves or omit move_pp for a fresh episode.
    """
    saved = {}
    for row in move_pp if isinstance(move_pp, list) else []:
        if isinstance(row, dict) and type(row.get("moveId")) is int and type(row.get("remainingPp")) is int:
            saved.setdefault(row["moveId"], row["remainingPp"])
    moves = learned_moves(species, level)
    for move in moves:
        move["remainingPp"] = int(clamp(saved.get(move["id"], move["pp"]), 0, move["pp"]))
    return moves


def move_range(move):
    return mechanics(move).get("range", 2.9)


def seed_int(value):
    return int.from_bytes(hashlib.sha256(str(value).encode()).digest()[:4], "little") or 1


class RNG:
    def __init__(self, seed):
        self.state = int(seed) & 0xffffffff or 1

    def random(self):
        x = self.state
        x ^= (x << 13) & 0xffffffff
        x ^= x >> 17
        x ^= (x << 5) & 0xffffffff
        self.state = x & 0xffffffff
        return self.state / 4294967296

    def choice(self, values):
        return values[min(len(values)-1, int(self.random() * len(values)))]


def clamp(v, a, b):
    return a if v < a else b if v > b else v


def seg_dist(ax, az, bx, bz, px, pz):
    """Distance from point P to segment AB (swept-circle collision)."""
    dx, dz = bx-ax, bz-az
    length2 = dx*dx + dz*dz
    t = 0. if length2 < 1e-12 else clamp(((px-ax)*dx + (pz-az)*dz) / length2, 0., 1.)
    return math.hypot(ax + dx*t - px, az + dz*t - pz)


def seg_seg(a0x, a0z, a1x, a1z, b0x, b0z, b1x, b1z):
    """Closest points between segments A and B -> (distance, ax, az, bx, bz)."""
    d1x, d1z, d2x, d2z = a1x-a0x, a1z-a0z, b1x-b0x, b1z-b0z
    rx, rz = a0x-b0x, a0z-b0z
    a, e, f = d1x*d1x + d1z*d1z, d2x*d2x + d2z*d2z, d2x*rx + d2z*rz
    if a < 1e-9 and e < 1e-9:
        s = t = 0.
    elif a < 1e-9:
        s, t = 0., clamp(f / e, 0., 1.)
    else:
        c = d1x*rx + d1z*rz
        if e < 1e-9:
            t, s = 0., clamp(-c / a, 0., 1.)
        else:
            b = d1x*d2x + d1z*d2z
            denom = a*e - b*b
            s = clamp((b*f - c*e) / denom, 0., 1.) if denom > 1e-9 else 0.
            t = (b*s + f) / e
            if t < 0:
                t, s = 0., clamp(-c / a, 0., 1.)
            elif t > 1:
                t, s = 1., clamp((b - c) / a, 0., 1.)
    ax, az, bx, bz = a0x + d1x*s, a0z + d1z*s, b0x + d2x*t, b0z + d2z*t
    return math.hypot(ax-bx, az-bz), ax, az, bx, bz


def swept_toi(p0, p1, q0, q1, radius):
    """First overlap of two linearly moving discs during one tick, or None."""
    rx, rz = p0[0] - q0[0], p0[1] - q0[1]
    vx, vz = (p1[0] - p0[0]) - (q1[0] - q0[0]), (p1[1] - p0[1]) - (q1[1] - q0[1])
    cc = rx * rx + rz * rz - radius * radius
    if cc <= 0:
        return 0.
    aa = vx * vx + vz * vz
    if aa < 1e-18:
        return None
    bb = 2 * (rx * vx + rz * vz)
    disc = bb * bb - 4 * aa * cc
    if disc < -1e-12:
        return None
    t = (-bb - math.sqrt(max(0., disc))) / (2 * aa)
    return clamp(t, 0., 1.) if -1e-12 <= t <= 1 + 1e-12 else None


def swept_line_toi(p0, p1, h, radius):
    """Clip a moving disc against the same finite line/cone used by in_capsule."""
    length = h.get("reach", h["length"]) if h["kind"] == "channel" else h["length"]
    dx, dz = h["dirX"], h["dirZ"]
    ax, az = p0[0] - h["x"], p0[1] - h["z"]
    vx, vz = p1[0] - p0[0], p1[1] - p0[1]
    along, da = ax * dx + az * dz, vx * dx + vz * dz
    across, dc = -ax * dz + az * dx, -vx * dz + vz * dx
    spread = h.get("spread", 0)
    cuts = [0., 1.]
    if abs(da) > 1e-12 and 0 < -along / da < 1:
        cuts.insert(1, -along / da)
    for lo, hi in zip(cuts, cuts[1:]):
        growing = spread if along + da * ((lo + hi) / 2) >= 0 else 0.
        width = h["halfWidth"] + radius
        constraints = [(-along - radius, -da), (along - length - radius, da),
                       (across - width - growing * along, dc - growing * da),
                       (-across - width - growing * along, -dc - growing * da)]
        enter, leave = lo, hi
        for a, b in constraints:
            if abs(b) < 1e-12:
                if a > 1e-12:
                    leave = -1.
                    break
            elif b > 0:
                leave = min(leave, -a / b)
            else:
                enter = max(enter, -a / b)
        if enter <= leave + 1e-12:
            return clamp(enter, 0., 1.)
    return None


def wrap(a):
    return (a + math.pi) % (2 * math.pi) - math.pi


def in_capsule(ox, oz, dx, dz, length, half_width, spread, px, pz, radius):
    """Point (with radius) inside a locked line/cone of given length starting at O along unit D."""
    along = (px-ox)*dx + (pz-oz)*dz
    if along < -radius or along > length + radius:
        return False
    across = abs((px-ox)*(-dz) + (pz-oz)*dx)
    return across <= half_width + spread*max(0., along) + radius


FIXED_DAMAGE = {"special_damage_effect", "bide_effect", "super_fang_effect"}


def offensive(move):
    """Moves that deal damage (Night Shade/Bide are category=status in the data but still hit)."""
    return bool(move.get("power")) or move.get("effect") in FIXED_DAMAGE


def fixed_damage(move, user, target):
    effect = move.get("effect")
    if effect == "special_damage_effect":
        return round(user["level"] * .35 + 1, 2)
    if effect == "super_fang_effect":
        return round(max(1., target["hp"] * .5), 2)
    if effect == "bide_effect":
        return round(user["level"] * .5 + 2, 2)
    return None


def move_cost(move):
    if move.get("category") == "status" and not offensive(move):
        return 10
    power = move.get("power") or 0
    return 8 if power <= 45 else round(12 + power/10, 2)


def fighter(species, individual, side):
    level = int(individual.get("level", 5))
    hp = max_hp(species, level)
    speed_stat = min(150, stat(species, "speed"))
    supplied_personality = individual.get("personality")
    nature_id = individual.get("natureId") or (supplied_personality.get("id") if isinstance(supplied_personality, dict) else None)
    personality = public_personality(nature_id)
    return {"id": individual["id"], "speciesId": species["id"],
            **({"natureId": nature_id, "personality": personality,
                "innateStyle": combat_personality(nature_id)} if personality else {}),
            "name": individual.get("nickname", species["name"]), "level": level,
            "hp": hp, "maxHp": hp, "x": -4.0 if side == 0 else 4.0, "z": 0.0, "vx": 0., "vz": 0.,
            "facingX": 1. if side == 0 else -1., "facingZ": 0., "radius": BODY,
            "energy": 100.0, "action": "观察对手",
            "attack": 5 + stat(species, "attack") * level / 50,
            "defense": 5 + stat(species, "defense") * level / 50,
            "special": 5 + stat(species, "special") * level / 50,
            # world units per tick (≈2.0–3.1 units/s); acceleration-limited, so dodges take real time
            "speed": round(.07 + speed_stat / 1500, 4),
            "reaction": int(clamp(round(8 - speed_stat / 25), 2, 7)),
            "types": types_of(species), "cooldown": 0, "guardUntil": 0, "moveCooldowns": [0, 0, 0, 0],
            "moves": equipped_moves(species, level, individual.get("movePp")),
            "statModifiers": {key: 1. for key in ("attack", "defense", "special", "speed")},
            "accuracyMultiplier": 1., "evasionMultiplier": 1.,
            "status": None, "statusUntil": 0, "stunUntil": 0, "rootUntil": 0, "hidden": False,
            "cast": None, "kbX": 0., "kbZ": 0., "recoveries": 3,
            "tactic": "strafe", "nextDecision": side * 5,
            "style": individual.get("style", "balanced"), "bond": individual.get("bond", 20),
            "policyVersion": individual.get("policyVersion", 0),
            "policy": copy.deepcopy(individual.get("policy", {})), "intent": None, "intentUntil": 0,
            "activeCommand": None, "nextCommandTick": 0, "captureMode": None, "grapple": None,
            "dashUntil": 0,
            "ai": {"dirX": 0., "dirZ": 0., "strafe": 1 if side == 0 else -1, "flipAt": 0,
                   "dashX": 0., "dashZ": 0., "dashCd": 0}}


PRIVATE = {"policy", "attack", "defense", "special", "speed", "recoveries", "ai", "kbX", "kbZ", "statModifiers", "nextCommandTick", "innateStyle"}


# Obstacle layouts are part of the authoritative arena (they block, break and
# are collided with); the renderer only draws what the snapshot reports.
LAYOUT_SLOTS = [(0., 3.2), (0., -3.2), (-2.4, 3.6), (2.4, -3.6), (2.4, 3.6), (-2.4, -3.6),
                (-5.6, 3.4), (5.6, -3.4), (5.6, 3.4), (-5.6, -3.4), (-1.6, 0.), (1.6, 0.)]
THEME_OBSTACLES = {"grass": ("crate", "rock"), "dirt": ("crate", "rock"), "stone": ("crate", "pillar"),
                   "neon": ("crate",), "lava": ("rock",), "water": (), "crystal": ("crystal", "rock"),
                   "rocks": ("rock", "rock", "crate")}


def layout(theme, seed):
    """Deterministic obstacle layout for an arena theme (empty for water)."""
    kinds = THEME_OBSTACLES.get(theme, ("crate", "rock"))
    if not kinds:
        return []
    rng = RNG(seed_int(f"layout:{theme}:{seed}"))
    count = 2 + int(rng.random() * 3)
    slots = list(LAYOUT_SLOTS[:10])
    out = []
    for i in range(count):
        x, z = slots.pop(int(rng.random() * len(slots)))
        kind = kinds[int(rng.random() * len(kinds))]
        solid = kind != "crate"
        out.append({"id": f"o{i}", "kind": kind, "x": x, "z": z, "radius": .45 if not solid else .7,
                    "hp": 28 if not solid else None, "solid": solid})
    return out


# Movement multiplier while casting, by phase (melee/beam commit the body; streams turn slowly).
CAST_SPEED = {"melee": {"windup": 0., "active": 0., "recovery": .4},
              "projectile": {"windup": .35, "active": .35, "recovery": .6},
              "beam": {"windup": 0., "active": 0., "recovery": .45},
              "stream": {"windup": .2, "active": .45, "recovery": .6},
              "channel": {"windup": .3, "active": .45, "recovery": .6},
              "area": {"windup": .3, "active": .3, "recovery": .6},
              "burst": {"windup": 0., "active": 0., "recovery": .5},
              "burrow": {"windup": 0., "active": 0., "recovery": .5},
              "self": {"windup": .3, "active": .3, "recovery": .6},
              "rest": {"windup": 0., "active": 0., "recovery": .5}}


class Arena:
    engine_version = ENGINE_VERSION
    ruleset = RULESET

    def __init__(self, fighters, seed=1, max_ticks=MAX_TICKS, record=True, obstacles=None, jitter=True):
        self.fighters = copy.deepcopy(fighters)
        for f in self.fighters:
            f.setdefault("captureMode", None)
            f.setdefault("grapple", None)
        self.rng = RNG(seed)
        if jitter and all(f["z"] == 0 and abs(f["x"]) == 4 for f in self.fighters):
            # seeded entry positions so equal matchups do not open identically
            for f in self.fighters:
                f["z"] = round((self.rng.random() - .5) * 3.2, 3)
                f["x"] = round(f["x"] + (self.rng.random() - .5) * 1.2, 3)
        self.tick = 0
        self.max_ticks = max_ticks
        self.events = []
        self.event_seq = 0
        self.frames = []
        self._previous_positions = None
        self.perception = []
        self.projectiles = []
        self.hazards = []
        self.pending_hazards = []
        self.hits = []
        self.selfko = []
        self.clashes = {}
        self.grapple = None
        self.obstacles = copy.deepcopy(obstacles or [])
        self.decisions = []
        self.external_inputs = []
        self.record = record
        self.status = "active"
        self.winner = None
        self.outcome = None
        self.serial = 0
        self.stats = {"dodged": [0, 0], "hits": [0, 0], "missed": [0, 0], "casts": [0, 0], "clashes": 0}
        self.remember_perception(-1)
        self.capture_frame()

    # ------------------------------------------------------------------ basics
    def emit(self, text, kind="action", actor=None, **data):
        if self.record:
            self.event_seq += 1
            event_tick = max(0, self.tick - 1) if hasattr(self, "_event_boundary") else self.tick
            event = {"tick": event_tick, "effectiveTick": getattr(self, "_event_boundary", self.tick + 1),
                     "eventSeq": self.event_seq, "text": text, "kind": kind, "actor": actor}
            event.update({k: (round(v, 3) if isinstance(v, float) else v) for k, v in data.items() if v is not None})
            self.events.append(event)

    def next_id(self, prefix):
        self.serial += 1
        return f"{prefix}{self.serial}"

    def distance(self):
        a, b = self.fighters
        return math.hypot(a["x"]-b["x"], a["z"]-b["z"])

    def busy_until(self, f):
        """Tick until which a fighter cannot start dodging (stagger, sleep, committed cast)."""
        until = f["stunUntil"]
        c = f["cast"]
        if c and c["shape"] not in ("projectile", "channel"):  # a channelling caster can still walk
            until = max(until, c["active"] + c.get("activeLen", 1))
        if f["status"] == "sleep":
            until = max(until, f["statusUntil"])
        return until

    def hurt_radius(self, f):
        return f["radius"] / math.sqrt(max(.5, f["evasionMultiplier"]))

    def blocked(self, ax, az, bx, bz):
        for o in self.obstacles:
            if o["solid"] and seg_dist(ax, az, bx, bz, o["x"], o["z"]) < o["radius"] * .8:
                return True
        return False

    # ------------------------------------------------------- tactical state
    def reaction_ticks(self, side):
        return reaction_delay(self.fighters[side])

    def remember_perception(self, tick):
        # Decision-relevant physics only, no private policy. This history is simulation
        # state even for record=False; presentation frames are independently optional.
        observed = [{k: copy.deepcopy(v) for k, v in f.items() if k not in ("policy", "ai")}
                    for f in self.fighters]
        self.perception.append({"tick": tick, "fighters": observed})
        self.perception = self.perception[-12:]

    def observed_foe(self, side):
        cutoff = self.tick - self.reaction_ticks(side)
        history = [item for item in self.perception if item["tick"] <= cutoff]
        if self.tick == 0:
            # Before the first tick, positions may be configured by a fixture or room.
            # A just-started cast still cannot become a zero-latency tactical signal.
            out = dict(self.fighters[1 - side])
            out["cast"] = None
            out["moveCooldowns"] = [0] * len(out["moveCooldowns"])
            return out
        return (history[-1] if history else self.perception[0])["fighters"][1 - side]

    def observed_distance(self, side):
        me, foe = self.fighters[side], self.observed_foe(side)
        return math.hypot(me["x"] - foe["x"], me["z"] - foe["z"])

    def state_key(self, side):
        me, other = self.fighters[side], self.observed_foe(side)
        h = min(2, int(me["hp"] / me["maxHp"] * 3))
        enemy_h = min(2, int(other["hp"] / other["maxHp"] * 3))
        d = self.observed_distance(side)
        distance = 0 if d <= 2.2 else 1 if d <= 4.2 else 2 if d <= 6.5 else 3
        threats = self.threats(side, perceived=True)
        threat = 0 if not threats else 2 if min(t["eta"] for t in threats) <= 6 else 1
        c = other["cast"]
        phase = 0 if not c else 1 if self.tick < c["active"] else 2
        ready = self.readiness(side)
        energy = int(me["energy"] >= 40)
        wall = int(abs(me["x"]) > BOUND_X - 1.3 or abs(me["z"]) > BOUND_Z - 1.3)
        return f"v3|{h}|{enemy_h}|{distance}|{threat}|{phase}|{ready}|{energy}|{wall}"

    def readiness(self, side):
        me = self.fighters[side]
        best = 1 if self.all_pp_exhausted(me) else 0
        for i, move in enumerate(me["moves"]):
            if move["remainingPp"] > 0 and me["moveCooldowns"][i] <= self.tick and offensive(move):
                best = max(best, 1 if mechanics(move)["shape"] == "melee" else 2)
        return best

    def legal(self, side):
        legal = [0, 1, 2, 3, 5, 6]
        if self.readiness(side):
            legal.append(4)
        return sorted(legal)

    def prior(self, side):
        me, foe = self.fighters[side], self.observed_foe(side)
        melee = sum(1 for m in me["moves"] if offensive(m) and m["remainingPp"] > 0 and mechanics(m)["shape"] == "melee")
        ranged = sum(1 for m in me["moves"] if offensive(m) and m["remainingPp"] > 0 and mechanics(m)["shape"] != "melee")
        if self.all_pp_exhausted(me):
            melee = 1  # The low-priority Struggle option still needs a real contact window.
        foe_melee = sum(1 for m in foe["moves"] if offensive(m) and mechanics(m)["shape"] == "melee")
        hp = me["hp"] / me["maxHp"]
        c = foe["cast"]
        foe_busy = bool(c) or foe["stunUntil"] > self.tick
        wall = abs(me["x"]) > BOUND_X - 1.3 or abs(me["z"]) > BOUND_Z - 1.3
        scores = [1.0 + .35*melee - .2*ranged + (.4 if foe["hp"] < foe["maxHp"]*.3 else 0),
                  .9 + .3*ranged - .15*melee + .2*foe_melee + (.3 if hp < .35 else 0),
                  1.15,
                  .85 + (.35 if foe_melee and ranged else 0),
                  .8 + (.9 if foe_busy else 0),
                  .55 + (.9 if hp < .35 and me["recoveries"] else 0),
                  .4 + (1.3 if wall else 0)]
        # Q-learning initializes unseen states from these substantial innate
        # priors. Learned values replace them rather than adding the same bias
        # again forever, so sustained experience can overcome the initial habit.
        bias = me.get("innateStyle", {}).get("tacticBias", [0.] * len(ACTIONS))
        return [round(s + bias[i], 4) for i, s in enumerate(scores)]

    def choose(self, side, epsilon=0):
        me = self.fighters[side]
        if me.get("captureMode"):
            return 1  # persistent evasive spacing; safe approach is decided in preferred()
        command = self.current_command(side)
        if command and command["command"] in ("attack", "defend", "retreat"):
            return {"attack": 0, "defend": 5, "retreat": 1}[command["command"]]
        legal = self.legal(side)
        if epsilon and self.rng.random() < epsilon:
            return self.rng.choice(legal)
        prior = self.prior(side)
        scores = list(me["policy"].get(self.state_key(side), prior))
        scores += prior[len(scores):]
        style = me["style"]
        if style == "aggressive":
            scores[0] += .25; scores[4] += .25
        elif style == "defensive":
            scores[5] += .35; scores[1] += .15
        elif style == "evasive":
            scores[2] += .3; scores[1] += .2; scores[3] += .2
        if me["intent"] and me["intentUntil"] > self.tick:
            for i in {"attack": [0, 4], "defend": [5], "retreat": [1, 6], "encourage": [4, 0]}.get(me["intent"], []):
                scores[i] += .65 + me["bond"] / 200
        return max(legal, key=lambda action: (scores[action], -action))

    def set_tactic(self, side, action):
        me = self.fighters[side]
        action = int(action)
        if action not in self.legal(side):
            action = 2
        if self.record:
            self.decisions.append({"tick": self.tick, "side": side, "action": action, "state": self.state_key(side)})
        me["tactic"] = ACTIONS[action]
        if not me["cast"]:
            me["action"] = TACTIC_ZH[me["tactic"]]
        me["nextDecision"] = self.tick + DECISION_TICKS

    def wake(self, side, delay):
        me = self.fighters[side]
        me["nextDecision"] = min(me["nextDecision"], self.tick + max(1, delay))

    # Fixed trainer commands are simulator inputs, never language-model output.
    def current_command(self, side):
        command = self.fighters[side].get("activeCommand")
        return command if command and self.tick < command["expiresTick"] else None

    def command_error(self, side, command, move_id=None):
        me = self.fighters[side]
        if self.status != "active" or me["hp"] <= 0:
            return "这只精灵当前不能接受指令"
        if command not in COMMAND_LABELS:
            return "未知战斗指令"
        if command != "move" and move_id is not None:
            return "只有技能指令可以指定招式"
        if command == "move":
            move = next((m for m in me["moves"] if m["id"] == move_id), None)
            if move is None:
                return "只能选择这只精灵本场已装备的招式"
            if move["remainingPp"] <= 0:
                return "这个招式的PP已耗尽"
        return None

    def request_command(self, side, command, move_id=None):
        error = self.command_error(side, command, move_id)
        if error:
            raise ValueError(error)
        me = self.fighters[side]
        active = {"command": command, "expiresTick": self.tick + COMMAND_TICKS}
        if command == "move":
            active["moveId"] = move_id
        me["activeCommand"] = active
        if command in ("weaken", "hold"):
            me["captureMode"] = command
            # This changes future decisions, never refunds PP or erases a fired shot.
            self.stop_capture_attack(side)
        elif command in ("attack", "defend", "retreat", "move"):
            me["captureMode"] = None
        me["nextCommandTick"] = self.tick + COMMAND_COOLDOWN_TICKS
        me["nextDecision"] = self.tick
        # A new fixed command supersedes both a previous command and legacy intent.
        me["intent"] = None
        me["intentUntil"] = 0
        label = next(m["name"] for m in me["moves"] if m["id"] == move_id) if command == "move" else COMMAND_LABELS[command]
        message = f"{me['name']}收到指令：{label}。"
        self.external_inputs.append({"type": "command", "tick": self.tick, "side": side,
                                     "command": command, "moveId": move_id})
        self.emit(message, "command", me["id"], command=command, moveId=move_id,
                  expiresTick=active["expiresTick"])
        return dict(active, accepted=True, message=message, captureMode=me.get("captureMode"),
                    cooldownMs=COMMAND_COOLDOWN_TICKS * 1000 // TICK_RATE)

    def stop_capture_attack(self, side):
        """Withdraw controllable output; projectiles already in flight remain physical."""
        me = self.fighters[side]
        if me.get("cast") and me["cast"]["shape"] not in ("self", "rest"):
            self.cancel_cast(side, "cancel")
        for h in self.hazards + self.pending_hazards:
            if h["side"] == side:
                self.end_hazard(h, "cancel")
        self.hazards = [h for h in self.hazards if not (h["side"] == side and h.get("_endReason") == "cancel")]
        self.pending_hazards = [h for h in self.pending_hazards if not (h["side"] == side and h.get("_endReason") == "cancel")]

    # Seismic Toss is a confirmed contact followed by a server-owned paired
    # action. Public stage times use the same completed-step boundary as events.
    # Ground anchors remain the two actual contact positions; only their
    # authoritative height changes. There is no homing teleport or capture roll.
    def grapple_locked(self, side):
        return bool(self.grapple and self.tick < self.grapple["endTick"] - 1)

    def start_grapple(self, side, hazard):
        if self.grapple:
            return False
        me, target = self.fighters[side], self.fighters[1 - side]
        c = me["cast"]
        if not c or c["moveId"] != 69 or target["hidden"] or min(me["hp"], target["hp"]) <= 0:
            return False
        # The normal locked melee arc is necessary but a grab also requires
        # actual arm's reach and a clear segment between the two bodies.
        if self.distance() > me["radius"] + self.hurt_radius(target) + .65 or \
                self.blocked(me["x"], me["z"], target["x"], target["z"]):
            return False
        if effectiveness(c["move"]["type"], target["types"]) <= 0:
            return False
        if target["cast"]:
            self.cancel_cast(1 - side, "grapple")
        start = self.tick + 1
        g = {"id": self.next_id("g"), "side": side, "actor": me["id"], "target": target["id"], "moveId": 69,
             "grabTick": start, "liftTick": start + 4, "apexTick": start + 16,
             "releaseTick": start + 28, "impactTick": start + 42, "endTick": start + 54,
             "phase": "grab", "height": 0., "landed": False, "hazardId": hazard["id"],
             "anchors": [[me["x"], me["z"]], [target["x"], target["z"]]],
             "dirX": c["dirX"], "dirZ": c["dirZ"], "move": copy.deepcopy(c["move"])}
        self.grapple = g
        c["grappleId"] = g["id"]
        c["end"] = g["endTick"] - 1
        me["cooldown"] = c["end"]
        for f in self.fighters:
            f.update(vx=0., vz=0., kbX=0., kbZ=0., dashUntil=self.tick)
        self.publish_grapple()
        self.end_hazard(hazard, "grapple")
        self.emit(f"{me['name']}抓住了{target['name']}", "grappleStart", me["id"],
                  target=target["id"], moveId=69, grappleId=g["id"], x=target["x"], z=target["z"],
                  grapple=copy.deepcopy(me["grapple"]))
        return True

    def publish_grapple(self):
        g = self.grapple
        if not g:
            return
        common = {key: g[key] for key in ("id", "moveId", "phase", "grabTick", "liftTick", "apexTick",
                                         "releaseTick", "impactTick", "endTick", "height")}
        for side, f in enumerate(self.fighters):
            f["grapple"] = dict(common, role="caster" if side == g["side"] else "target",
                                peer=self.fighters[1 - side]["id"])

    def end_grapple(self, reason, cancel_owner=False):
        g = self.grapple
        if not g:
            return
        self.grapple = None  # clear first: cancel_cast can call back here
        for f in self.fighters:
            f.update(grapple=None, hidden=False, vx=0., vz=0., kbX=0., kbZ=0.)
        if cancel_owner and self.fighters[g["side"]]["cast"]:
            self.cancel_cast(g["side"], reason)
        self.emit("", "grappleEnd", g["actor"], target=g["target"], moveId=69,
                  grappleId=g["id"], reason=reason, x=self.fighters[1 - g["side"]]["x"],
                  z=self.fighters[1 - g["side"]]["z"])

    def advance_grapple(self):
        g = self.grapple
        if not g:
            return
        me, target = self.fighters[g["side"]], self.fighters[1 - g["side"]]
        if min(me["hp"], target["hp"]) <= 0 or not me["cast"] or me["cast"].get("grappleId") != g["id"]:
            self.end_grapple("interrupted", cancel_owner=True)
            return
        now = self.tick + 1
        if now >= g["endTick"]:
            self.end_grapple("complete")
            return
        if now < g["liftTick"]:
            g.update(phase="grab", height=0.)
        elif now < g["apexTick"]:
            p = (now - g["liftTick"]) / (g["apexTick"] - g["liftTick"])
            g.update(phase="rise", height=round(3.2 * p * p * (3 - 2 * p), 4))
        elif now < g["releaseTick"]:
            g.update(phase="hold", height=3.2)
        elif now < g["impactTick"]:
            p = (now - g["releaseTick"]) / (g["impactTick"] - g["releaseTick"])
            g.update(phase="fall", height=round(3.2 * (1 - p * p), 4))
        else:
            g.update(phase="impact" if now == g["impactTick"] else "recover", height=0.)
        for f in self.fighters:
            f["hidden"] = g["liftTick"] <= now < g["impactTick"]
        if now == g["releaseTick"]:
            self.emit("", "grappleRelease", me["id"], target=target["id"], moveId=69,
                      grappleId=g["id"], impactTick=g["impactTick"], x=target["x"], z=target["z"])
        if now == g["impactTick"] and not g["landed"]:
            g["landed"] = True
            self.emit("抓举落地", "grappleImpact", me["id"], target=target["id"], moveId=69,
                      grappleId=g["id"], x=target["x"], z=target["z"], radius=1.3)
            self.hits.append({"by": g["side"], "to": 1 - g["side"], "move": g["move"], "kind": "grapple",
                              "dirX": g["dirX"], "dirZ": g["dirZ"], "scale": 1., "grappleId": g["id"],
                              "x": target["x"], "z": target["z"]})
        self.publish_grapple()

    def capture_damage_ceiling(self, side, move):
        """Conservative current-rules estimate, not a promise that either fighter
        survives. Opponent recoil, existing poison and fired attacks remain live.
        Ignores guard reduction and uses the maximum random damage multiplier.
        """
        me, foe = self.fighters[side], self.fighters[1 - side]
        mech, effect = mechanics(move), move.get("effect") or ""
        if not offensive(move) or any(word in effect for word in
                ("burn", "poison", "leech_seed", "recoil", "jump_kick", "explode", "ohko", "trapping")) \
                or mech.get("selfKO") or mech["shape"] in ("channel", "stream", "self"):
            return None
        multiplier = effectiveness(move["type"], foe["types"])
        if multiplier <= 0:
            return None
        fixed = fixed_damage(move, me, foe)
        if fixed is not None:
            # Fixed damage ignores hit scales in apply_hits; every possible pellet counts.
            amount = fixed * max(1, mech.get("count", 1))
        else:
            special = move["type"] in SPECIAL_TYPES
            attack, defense = me["special"] if special else me["attack"], foe["special"] if special else foe["defense"]
            amount = max(1, (2.3 + attack * .5) * 10 / (8 + defense))
            amount *= max(.3, (move.get("power") or 40) / 40) * multiplier * 1.1
            if move["type"] in me["types"]:
                amount *= 1.5
            if mech["shape"] == "melee":
                amount *= max(1, mech.get("pulses", 1))
        # Cover individual hit rounding too; a strict positive reserve remains.
        return math.ceil(amount * 100) / 100 + .01 * max(1, mech.get("count", 1))

    def capture_pending(self, side):
        return bool(self.grapple and self.grapple["side"] == side and not self.grapple["landed"]) or \
            any(p["side"] == side for p in self.projectiles) or any(
            h["side"] == side and not h.get("resolved") and not h.get("_endReason")
            for h in self.hazards + self.pending_hazards)

    def capture_safe_moves(self, side):
        me, foe = self.fighters[side], self.fighters[1 - side]
        if me.get("captureMode") != "weaken" or foe["hp"] <= foe["maxHp"] * .25 or me["hp"] <= me["maxHp"] * .2 \
                or foe["status"] in ("burn", "poison"):
            return []
        reserve = max(1., foe["maxHp"] * .05)
        out = []
        for index, move in enumerate(me["moves"]):
            ceiling = self.capture_damage_ceiling(side, move)
            if move["remainingPp"] > 0 and ceiling is not None and 0 < ceiling < foe["hp"] - reserve:
                out.append((index, move, mechanics(move), ceiling))
        return out

    def pick_capture_attack(self, side, threats):
        me, foe = self.fighters[side], self.observed_foe(side)
        if me["cast"] or self.capture_pending(side) or foe["hidden"]:
            return None
        imminent = [t for t in threats if t["eta"] <= 9]
        if imminent and self.danger_at(side, 0., 0., imminent) > .3:
            return None  # preserve time/energy for a real dodge or guard
        distance, choices = self.observed_distance(side), []
        for index, move, mech, ceiling in self.capture_safe_moves(side):
            if me["moveCooldowns"][index] > self.tick or me["energy"] < move_cost(move) or distance > mech["range"]:
                continue
            if mech["shape"] in ("projectile", "beam", "area") and self.blocked(me["x"], me["z"], foe["x"], foe["z"]):
                continue
            duration = self.hit_window(me, foe, mech, distance)[0]
            goal = self.fighters[1 - side]["hp"] - self.fighters[1 - side]["maxHp"] * .2
            score = -abs(ceiling - goal) - duration * .015
            choices.append((score, index, move, mech, duration))
        return max(choices, key=lambda item: (item[0], -item[1])) if choices else None

    def finish_capture(self, side):
        """Terminal external input, accepted only while both participants are alive."""
        if type(side) is not int or side not in (0, 1):
            return False, "无效的捕捉方"
        if self.status != "active" or any(f["hp"] <= 0 for f in self.fighters):
            return False, "只有双方仍存活、对战尚未结束时才能捕捉"
        self.external_inputs.append({"type": "capture", "tick": self.tick, "side": side})
        self._event_boundary = self.tick
        for p in self.projectiles:
            self.end_projectile(p, "capture")
        for h in self.hazards + self.pending_hazards:
            self.end_hazard(h, "capture")
        for clash in self.clashes.values():
            self.emit("对波随捕捉结束", "clashEnd", clashId=clash["id"], x=clash["x"], z=clash["z"])
        self.end_grapple("capture", cancel_owner=True)
        self.projectiles, self.hazards, self.pending_hazards, self.hits, self.selfko = [], [], [], [], []
        self.clashes = {}
        for f in self.fighters:
            if f["cast"]:
                self.emit("", "cancel", f["id"], moveId=f["cast"].get("moveId"), reason="capture")
            f.update(cast=None, hidden=False, activeCommand=None, captureMode=None, intent=None, intentUntil=0,
                     vx=0., vz=0., kbX=0., kbZ=0., dashUntil=self.tick, guardUntil=self.tick, action="捕捉结束")
        self.status, self.winner, self.outcome = "finished", None, "captured"
        target = self.fighters[1 - side]
        self.emit(f"成功捕捉了{target['name']}", "capture", self.fighters[side]["id"], target=target["id"], outcome="captured")
        self.emit("捕捉成功，对战结束", "result", outcome="captured")
        # Replace this boundary, rather than retaining an old same-tick attack frame.
        self.frames = [frame for frame in self.frames if frame["tick"] != self.tick]
        self.capture_frame()
        del self._event_boundary
        return True, f"成功捕捉了{target['name']}"

    def command_options(self, side):
        me = self.fighters[side]
        options = [{"command": key, "label": label} for key, label in COMMAND_LABELS.items() if key != "move"]
        options += [{"command": "move", "moveId": move["id"], "label": move["name"]} for move in me["moves"]]
        for option in options:
            reason = self.command_error(side, option["command"], option.get("moveId"))
            if not reason and me.get("nextCommandTick", 0) > self.tick:
                reason = "指令冷却中"
            option["disabled"] = bool(reason)
            if reason:
                option["reason"] = reason
        return options

    def finish_command(self, side, reason):
        me = self.fighters[side]
        command = me.get("activeCommand")
        if command:
            self.emit("指令已执行" if reason == "executed" else "指令已过期", "commandEnd", me["id"],
                      command=command["command"], moveId=command.get("moveId"), reason=reason)
            me["activeCommand"] = None
            me["nextDecision"] = min(me["nextDecision"], self.tick + 1)

    def commanded_attack(self, side):
        command = self.current_command(side)
        if not command or command["command"] != "move":
            return None
        me, foe = self.fighters[side], self.observed_foe(side)
        for index, move in enumerate(me["moves"]):
            if move["id"] != command["moveId"]:
                continue
            mech = mechanics(move)
            if move["remainingPp"] <= 0 or me["moveCooldowns"][index] > self.tick or me["energy"] < move_cost(move):
                return None
            distance = self.observed_distance(side)
            if mech["shape"] != "self":
                if foe["hidden"] or distance > mech["range"]:
                    return None
                if mech["shape"] in ("projectile", "beam", "stream", "area", "channel") and self.blocked(me["x"], me["z"], foe["x"], foe["z"]):
                    return None
            duration = mech["windup"] if mech["shape"] == "self" else self.hit_window(me, foe, mech, distance)[0]
            return (0., index, move, mech, duration)
        return None

    def commanded_dodge(self, side, threats):
        me, foe = self.fighters[side], self.observed_foe(side)
        if me["ai"]["dashCd"] > self.tick or me["energy"] < 12 or me["rootUntil"] > self.tick:
            return None
        away = math.atan2(me["z"] - foe["z"], me["x"] - foe["x"])
        candidates = []
        for k in range(12):
            angle = away + math.pi / 2 + k * math.pi / 6
            x, z = math.cos(angle), math.sin(angle)
            px, pz = me["x"] + x * me["speed"] * 2.2 * 5, me["z"] + z * me["speed"] * 2.2 * 5
            if abs(px) > BOUND_X - me["radius"] or abs(pz) > BOUND_Z - me["radius"]:
                continue
            if any(seg_dist(me["x"], me["z"], px, pz, o["x"], o["z"]) < o["radius"] + me["radius"] for o in self.obstacles):
                continue
            risk = self.danger_at(side, x * me["speed"] * 1.75, z * me["speed"] * 1.75, threats)
            candidates.append((risk, k, x, z))
        if not candidates:
            return None
        _, _, x, z = min(candidates)
        return x, z

    # ------------------------------------------------------------ perception
    def threats(self, side, perceived=True):
        """Enemy threats with geometry, as this fighter can see them after its reaction delay."""
        me, foe = self.fighters[side], self.fighters[1-side]
        react = reaction_delay(me)
        out = []
        for p in self.projectiles:
            if p["side"] == side or (perceived and self.tick - p["born"] < react - p.get("seenEarly", 0)):
                continue
            remaining = p["maxRange"] - p["traveled"]
            out.append({"kind": "projectile", "x": p["x"], "z": p["z"], "vx": p["vx"], "vz": p["vz"],
                        "t0": 0, "t1": remaining / max(.01, p["speed"]), "r": p["radius"],
                        "eta": self.projectile_eta(p, me), "w": p["threat"], "seen": p["born"] - p.get("seenEarly", 0)})
        for h in self.hazards:
            if h["side"] == side or (perceived and self.tick - h["created"] < react):
                continue
            eta = h["active"] - self.tick
            if eta < -h.get("activeLen", 1):
                continue
            out.append(dict(h, eta=max(0, eta), w=h["threat"], seen=h["created"]))
        c = foe["cast"]
        if c and c["shape"] == "projectile" and self.tick < c["active"] and (not perceived or self.tick - c["start"] >= react):
            mech = c["mech"]
            sx, sz = foe["x"] + c["dirX"] * (foe["radius"] + .2), foe["z"] + c["dirZ"] * (foe["radius"] + .2)
            t0 = c["active"] - self.tick
            out.append({"kind": "projectile", "x": sx - c["dirX"]*mech["speed"]*t0, "z": sz - c["dirZ"]*mech["speed"]*t0,
                        "vx": c["dirX"]*mech["speed"], "vz": c["dirZ"]*mech["speed"], "t0": t0,
                        "t1": t0 + mech["maxRange"]/mech["speed"], "r": mech["radius"], "eta": t0 + 4, "w": c["threat"],
                        "seen": c["start"]})
        return out

    def projectile_eta(self, p, me):
        dx, dz = me["x"]-p["x"], me["z"]-p["z"]
        along = (dx*p["vx"] + dz*p["vz"]) / max(1e-6, p["speed"])
        return max(0, along / max(.01, p["speed"]))

    def danger_at(self, side, vx, vz, threats):
        """Weighted hits this fighter would take if it moved with velocity (vx,vz) from now."""
        me = self.fighters[side]
        r = self.hurt_radius(me) + .18
        total = 0.
        for t in threats:
            k = t["kind"]
            if k == "projectile":
                # closest approach of two linear motions inside the projectile's life window
                px, pz = t["x"] - me["x"], t["z"] - me["z"]
                rvx, rvz = t["vx"] - vx, t["vz"] - vz
                rv2 = rvx*rvx + rvz*rvz
                tt = clamp(-(px*rvx + pz*rvz) / rv2, t["t0"], t["t1"]) if rv2 > 1e-9 else t["t0"]
                d = math.hypot(px + rvx*tt, pz + rvz*tt)
                limit = t["r"] + r
                if d < limit + .45:
                    total += t["w"] * (1. if d < limit else (limit + .45 - d) / .45 * .5)
                continue
            eta = max(0, t["eta"])
            if k in ("channel", "stream"):
                eta = max(eta, 5)  # sustained: judge where this velocity takes me a few ticks from now
            fx, fz = me["x"] + vx*eta, me["z"] + vz*eta
            fx, fz = clamp(fx, -BOUND_X + me["radius"], BOUND_X - me["radius"]), clamp(fz, -BOUND_Z + me["radius"], BOUND_Z - me["radius"])
            if k in ("area", "burst", "emerge"):
                d = math.hypot(fx - t["x"], fz - t["z"])
                limit = t["radius"] + r * .5
                if d < limit + .45:
                    total += t["w"] * (1. if d < limit else (limit + .45 - d) / .45 * .5)
            elif k == "channel":
                # the jet turns toward me at most `turn` rad/tick: out-running its turn rate escapes it
                cur = math.atan2(t["dirZ"], t["dirX"])
                rot = clamp(wrap(math.atan2(fz - t["z"], fx - t["x"]) - cur), -t["turn"]*eta, t["turn"]*eta)
                dx, dz = math.cos(cur + rot), math.sin(cur + rot)
                if in_capsule(t["x"], t["z"], dx, dz, t["length"], t["halfWidth"], t.get("spread", 0), fx, fz, r):
                    total += t["w"]
                elif in_capsule(t["x"], t["z"], dx, dz, t["length"], t["halfWidth"] + .45, t.get("spread", 0), fx, fz, r):
                    total += t["w"] * .4
            elif k in ("beam", "stream"):
                if in_capsule(t["x"], t["z"], t["dirX"], t["dirZ"], t["length"], t["halfWidth"], t.get("spread", 0), fx, fz, r):
                    total += t["w"]
                elif in_capsule(t["x"], t["z"], t["dirX"], t["dirZ"], t["length"], t["halfWidth"] + .45, t.get("spread", 0), fx, fz, r):
                    total += t["w"] * .4
            elif k == "melee":
                reach = t["reach"] + t["casterRadius"] + r
                cx, cz = t["x"] + t["dirX"] * t["lungeLeft"], t["z"] + t["dirZ"] * t["lungeLeft"]
                d = math.hypot(fx - cx, fz - cz)
                if d < reach + .3:
                    total += t["w"] * (1. if d < reach else .5)
        return total

    # -------------------------------------------------------------- movement
    def move_speed(self, f):
        if f["hp"] <= 0 or f["stunUntil"] > self.tick or f["status"] == "sleep" or f["rootUntil"] > self.tick:
            return 0.
        s = f["speed"] * (.5 if f["status"] == "paralysis" else .6 if f["status"] == "slow" else 1.)
        if f["guardUntil"] > self.tick:
            s *= .35
        c = f["cast"]
        if c:
            phase = "windup" if self.tick < c["active"] else "active" if self.tick < c["active"] + c["activeLen"] else "recovery"
            s *= CAST_SPEED.get(c["shape"], {}).get(phase, .5)
        return s

    def preferred(self, side):
        me = self.fighters[side]
        base = self.preferred_base(side)
        # Explicit trainer instructions, capture safety and committed casts
        # keep their exact spacing. Nature governs autonomous choices only.
        if self.current_command(side) or me.get("captureMode") or me["cast"]:
            return base
        offset = me.get("innateStyle", {}).get("distanceOffset", 0.)
        if not offset:
            return base
        contact = me["radius"] + self.observed_foe(side)["radius"]
        # Do not put a contact-only fighter outside its actionable reach merely
        # because its temperament is cautious; it can still choose to kite.
        if base <= contact + .65:
            offset = min(.2, offset)
        return clamp(base + offset, contact + .1, 8.)

    def preferred_base(self, side):
        me, foe = self.fighters[side], self.observed_foe(side)
        contact = me["radius"] + foe["radius"]
        if me.get("captureMode"):
            safe = self.capture_safe_moves(side)
            if not safe or self.capture_pending(side):
                return 6.2
            # A safe short-range move may approach; never chase using a dangerous
            # move's nominal range simply because it is also in the loadout.
            mech = max(safe, key=lambda option: option[2]["range"])[2]
            return min(contact + .6, mech["range"] * .75) if mech["shape"] == "melee" else clamp(mech["range"] * .65, 2.4, 5.8)
        command = self.current_command(side)
        if command and command["command"] == "move":
            requested = next((m for m in me["moves"] if m["id"] == command["moveId"]), None)
            if requested and mechanics(requested)["shape"] != "self":
                mech = mechanics(requested)
                return min(mech["range"] * .75, contact + .6) if mech["shape"] == "melee" else mech["range"] * .7
        ranges = [mechanics(m) for m in me["moves"] if offensive(m) and m["remainingPp"] > 0]
        if not ranges:
            return contact + .6 if self.all_pp_exhausted(me) else 3.6
        melee = [x for x in ranges if x["shape"] == "melee"]
        ranged = [x for x in ranges if x["shape"] not in ("melee", "self")]
        foe_reach = max([mechanics(m)["range"] for m in foe["moves"] if offensive(m) and mechanics(m)["shape"] == "melee"] or [0])
        tactic = me["tactic"]
        c = me["cast"]
        if c and c["shape"] == "channel":  # keep the target inside the jet while holding it
            return min(c["mech"]["length"] * .7, max(contact + 1.2, self.observed_distance(side)))
        if tactic == "burst":
            return self.counter_range(side)
        if tactic == "press":
            return contact + .6 if melee else max(2.5, min(x["range"] for x in ranged) * .55)
        if tactic == "kite":
            return clamp(max([x["range"] for x in ranged] or [5.]) * .7, 4.6, 7.2)
        if tactic == "bait":
            return max(3.2, foe_reach + 1.1) if foe_reach else 4.4
        if tactic == "guard":
            return 5.8
        if tactic == "reposition":
            return 4.5
        return 3.6 if ranged else contact + 1.4

    def steer(self, side, threats):
        me, foe = self.fighters[side], self.observed_foe(side)
        ai = me["ai"]
        speed = max(.04, self.move_speed(me) or me["speed"])
        w_danger = controller_style(me)[0]
        if me.get("captureMode"):
            w_danger = max(9., w_danger)
        d = max(.01, self.observed_distance(side))
        ux, uz = (foe["x"]-me["x"])/d, (foe["z"]-me["z"])/d
        pref = self.preferred(side)
        horizon = 8
        fx, fz = foe["x"] + foe["vx"]*horizon, foe["z"] + foe["vz"]*horizon
        tactic = me["tactic"]
        if not threats and (self.tick + side*17) % 57 == 0:
            ai["strafe"] = -ai["strafe"]
        best, best_score = (0., 0.), -1e9
        for k in range(13):
            if k == 12:
                cx = cz = 0.
            else:
                a = k * math.pi / 6
                ca, sa = math.cos(a), math.sin(a)
                cx, cz = ux*ca - uz*sa, ux*sa + uz*ca
            vx, vz = cx*speed, cz*speed
            px = clamp(me["x"] + vx*horizon, -BOUND_X + me["radius"], BOUND_X - me["radius"])
            pz = clamp(me["z"] + vz*horizon, -BOUND_Z + me["radius"], BOUND_Z - me["radius"])
            dist_pred = math.hypot(fx - px, fz - pz)
            score = -abs(dist_pred - pref)
            perp = cx*(-uz) + cz*ux
            if tactic in ("strafe", "bait", "kite", "guard"):
                score += .38 * perp * ai["strafe"]
            if tactic == "press" and d > pref:
                score += .35 * (cx*ux + cz*uz)
            if tactic == "reposition":
                score -= .25 * math.hypot(px, pz)
            mx, mz = BOUND_X - abs(px), BOUND_Z - abs(pz)
            score -= 1.1 * (max(0., 1.5 - mx) + max(0., 1.5 - mz)) + (1. if mx < 1.5 and mz < 1.5 else 0.)
            for o in self.obstacles:
                gap = math.hypot(px - o["x"], pz - o["z"]) - o["radius"] - me["radius"]
                if gap < .35:
                    score -= (.35 - gap) * 2.
            if threats:
                score -= w_danger * self.danger_at(side, vx, vz, threats)
            score += .22 * (cx*ai["dirX"] + cz*ai["dirZ"])
            if k == 12:
                score -= .04
            if score > best_score + 1e-9:
                best, best_score = (cx, cz), score
        # flip strafing direction when it runs into a wall instead of jittering against it
        sx, sz = -uz*ai["strafe"], ux*ai["strafe"]
        if abs(me["x"] + sx*1.5) > BOUND_X - .9 or abs(me["z"] + sz*1.5) > BOUND_Z - .9:
            ai["strafe"] = -ai["strafe"]
        ai["dirX"], ai["dirZ"] = best
        return best, best_score

    # --------------------------------------------------------------- attacks
    def estimate(self, side, move):
        me, foe = self.fighters[side], self.observed_foe(side)
        power = max(.3, (move.get("power") or 40) / 40)
        special = move["type"] in SPECIAL_TYPES
        attack = me["special"] if special else me["attack"]
        defense = foe["special"] if special else foe["defense"]
        amount = max(1, (2.3 + attack*.5) * (10 / (8 + defense))) * power * effectiveness(move["type"], foe["types"])
        if move["type"] in me["types"]:
            amount *= 1.5
        fixed = fixed_damage(move, me, foe)
        return fixed if fixed is not None else amount

    def hit_window(self, me, foe, mech, d):
        hurt = self.hurt_radius(foe)
        shape = mech["shape"]
        if shape == "melee":
            return mech["windup"] + 1, mech["reach"] * .7 + hurt * .5 + .25
        if shape == "projectile":
            return mech["windup"] + max(0., d - me["radius"]) / mech["speed"], mech["radius"] + hurt
        if shape == "beam":
            return mech["windup"], mech["halfWidth"] + hurt
        if shape == "channel":  # tracking jet: turn rate widens the effective hitbox
            return mech["windup"] + d / mech["head"], mech["halfWidth"] + hurt + math.radians(mech["turn"]) * d * 6
        if shape == "stream":
            return mech["windup"] + 4, (mech["halfWidth"] + mech["spread"]*d + hurt) * 1.5
        if shape == "area":
            return mech["windup"], mech["radius"] + hurt * .5
        if shape == "burst":
            return mech["windup"], max(.05, mech["radius"] + hurt*.5 - d)
        if shape == "burrow":
            return mech["warn"], mech["radius"] + hurt * .5
        return 1, 1

    def self_value(self, me, move, mech, foe=None):
        effect = move["effect"]
        hp = me["hp"] / me["maxHp"]
        own_attacks = [m for m in me["moves"] if offensive(m) and m["remainingPp"] > 0]
        enemy_attacks = [m for m in (foe or {}).get("moves", []) if offensive(m) and m["remainingPp"] > 0]
        own_scaled = [m for m in own_attacks if m.get("effect") not in FIXED_DAMAGE]
        enemy_scaled = [m for m in enemy_attacks if m.get("effect") not in FIXED_DAMAGE]
        if effect == "heal_effect":
            return .45 * (1 - hp) if hp < .55 else 0
        if mech.get("blink"):
            return 0
        if "_up" in effect:
            key = effect.split("_")[0]
            if key == "evasion":
                return .06 if enemy_attacks and me["evasionMultiplier"] < 1.5 else 0
            if key in ("attack", "special", "defense", "speed"):
                modifier = me.get("statModifiers", {}).get(key, 1.)
                useful = {"attack": any(m["type"] not in SPECIAL_TYPES for m in own_scaled),
                          "defense": any(m["type"] not in SPECIAL_TYPES for m in enemy_scaled),
                          "special": any(m["type"] in SPECIAL_TYPES for m in own_scaled + enemy_scaled),
                          "speed": bool(own_attacks or enemy_attacks) and me["speed"] < .2}[key]
                return .055 / max(1., modifier) if useful and hp > .55 and modifier < 1.15**3 - 1e-6 else 0
        if effect in ("reflect_effect", "light_screen_effect", "substitute_effect") and enemy_attacks and me["guardUntil"] <= self.tick:
            return .04
        return 0

    def support_value(self, me, foe, move):
        """Value only effects this engine implements and the present kits can use.

        Repeating a stat effect after its useful opening has passed is not a
        reason to consume PP just to make the move sequence look varied.
        """
        effect = move.get("effect") or ""
        own = [m for m in me["moves"] if offensive(m) and m["remainingPp"] > 0]
        enemy = [m for m in foe["moves"] if offensive(m) and m["remainingPp"] > 0]
        own_scaled = [m for m in own if m.get("effect") not in FIXED_DAMAGE]
        enemy_scaled = [m for m in enemy if m.get("effect") not in FIXED_DAMAGE]
        if any(w in effect for w in ("sleep", "paralyze", "poison")):
            if "poison" in effect and "poison" in foe["types"]:
                return 0.
            return .16 if not foe["status"] else 0.
        if effect.startswith(("attack_down", "defense_down", "special_down", "speed_down")):
            key = effect.split("_")[0]
            modifier = foe.get("statModifiers", {}).get(key, 1.)
            useful = {"attack": any(m["type"] not in SPECIAL_TYPES for m in enemy_scaled),
                      "defense": any(m["type"] not in SPECIAL_TYPES for m in own_scaled),
                      "special": any(m["type"] in SPECIAL_TYPES for m in own_scaled + enemy_scaled),
                      "speed": bool(own or enemy)}[key]
            return .07 * min(1., modifier) if useful and modifier > .62 else 0.
        if effect == "accuracy_down1_effect":
            return .07 * foe["accuracyMultiplier"] if enemy and foe["accuracyMultiplier"] > .6 else 0.
        return 0.

    @staticmethod
    def offense_exhausted(me):
        """Offensive PP availability, not permission to use Struggle."""
        return not any(offensive(m) and m["remainingPp"] > 0 for m in me["moves"])

    @staticmethod
    def all_pp_exhausted(me):
        """Struggle is available only once every equipped move has zero PP."""
        return not any(m["remainingPp"] > 0 for m in me["moves"])

    def attack_options(self, side):
        me = self.fighters[side]
        options = list(enumerate(me["moves"]))
        if self.all_pp_exhausted(me):
            options.append((-1, dict(battle_data()[0][165], remainingPp=1)))
        return options

    def move_score(self, side, move, mech, d, threats):
        """Shared utility estimate for casting and selecting a counterattack window.

        Uses only delayed opponent observations and already-perceived threats.
        A prospective approach distance is a planning estimate, not a future hit.
        """
        me, foe = self.fighters[side], self.observed_foe(side)
        _, _, _, risk_aversion = controller_style(me)
        foe_speed = foe["speed"]
        foe_react = reaction_delay(foe)
        busy = max(0, self.busy_until(foe) - self.tick)
        imminent = [t for t in threats if t["eta"] <= 7]
        under_fire = imminent and self.danger_at(side, 0., 0., imminent) > .3
        foe_ready = any(m["remainingPp"] > 0 and foe["moveCooldowns"][i] <= self.tick and offensive(m)
                        and mechanics(m)["range"] >= d for i, m in enumerate(foe["moves"]))
        tactic = me["tactic"]
        fc = foe["cast"]
        foe_jet = bool(fc and fc["shape"] == "channel" and self.tick < fc["active"] + fc["activeLen"])
        shape = mech["shape"]
        if shape == "self":
            value = self.self_value(me, move, mech, foe)
            T = mech["windup"]
        else:
            T, need = self.hit_window(me, foe, mech, d)
            escape = foe_speed * max(0., T - foe_react - busy)
            p = clamp(need / (need + escape * .8), .08, 1.)
            estimated = self.estimate(side, move)
            value = min(estimated, foe["hp"]) / foe["maxHp"] * p
            if offensive(move) and estimated >= foe["hp"] > 0:
                value += .18 * p  # A reliable finish matters; overkill itself has no extra value.
            if move.get("category") == "status" and not offensive(move):
                value = self.support_value(me, foe, move) * p
            if shape == "melee":
                value *= 1.3 if tactic == "press" else .6 if tactic == "kite" else 1.
            else:
                value *= 1.3 if tactic == "kite" else .85 if tactic == "press" else 1.
        if tactic == "bait" and not busy and shape != "self":
            value *= .35
        if tactic == "burst":
            value *= 1.25
        if tactic in ("guard", "reposition"):
            value *= .6
        if shape == "channel" and foe_jet:
            value *= 2.2
        if under_fire and shape != "self" and tactic != "burst" and not (shape == "channel" and foe_jet):
            value *= .25
        risk = (.028 * (mech["windup"] + mech.get("recovery", 0)) / 20 * risk_aversion) if foe_ready and not busy else 0
        pp_reserve = .018 / max(1, move["remainingPp"]) if move["id"] != 165 else 0.
        energy_reserve = .012 * move_cost(move) / max(10., me["energy"]) * max(0., 1 - me["energy"] / 100)
        return value - risk - pp_reserve - energy_reserve, T

    def counter_range(self, side):
        """Keep or approach an actionable attack window; never back out merely
        because a mixed kit also contains a longer-ranged move. Danger scoring
        in steer remains free to override this range preference.
        """
        me, foe = self.fighters[side], self.observed_foe(side)
        d = self.observed_distance(side)
        contact = me["radius"] + foe["radius"]

        def window(mech):
            reach = contact + .6 if mech["shape"] == "melee" else clamp(mech["range"] * .6, 2.4, 5.5)
            return min(d, reach, mech["range"])

        if me["cast"]:
            return d if me["cast"]["shape"] in ("self", "rest") else window(me["cast"]["mech"])
        if me["cooldown"] > self.tick or me["stunUntil"] > self.tick or me["status"] == "sleep" or foe["hidden"]:
            return d
        threats = self.threats(side)
        immediate, approach = [], []
        threshold = controller_style(me)[2]
        for i, move in self.attack_options(side):
            if not offensive(move) or move["remainingPp"] <= 0 or (i >= 0 and me["moveCooldowns"][i] > self.tick) or me["energy"] < move_cost(move):
                continue
            mech = mechanics(move)
            if mech["shape"] == "self" or self.estimate(side, move) <= 0:
                continue
            if mech["shape"] in ("projectile", "beam", "stream", "area", "channel") and self.blocked(me["x"], me["z"], foe["x"], foe["z"]):
                continue
            target = window(mech)
            net, _ = self.move_score(side, move, mech, d, threats)
            floor = 0 if i == -1 else threshold
            if d <= mech["range"] and net > floor:
                immediate.append((net, target))
            else:
                net, _ = self.move_score(side, move, mech, target, threats)
                if net > floor:
                    travel = max(0., d - target) / max(.01, self.move_speed(me))
                    approach.append((net / (1 + travel / TICK_RATE), target))
        options = immediate or approach
        return max(options, key=lambda option: option[0])[1] if options else d

    def pick_attack(self, side, threats):
        me, foe = self.fighters[side], self.observed_foe(side)
        if foe["hp"] <= 0 or me["cast"] or me["stunUntil"] > self.tick or me["status"] == "sleep":
            return None
        if me.get("captureMode"):
            return self.pick_capture_attack(side, threats) if me["captureMode"] == "weaken" else None
        threshold = controller_style(me)[2]
        d = self.observed_distance(side)
        best = fallback = remaining_support = None
        for i, move in self.attack_options(side):
            if move["remainingPp"] <= 0 or (i >= 0 and me["moveCooldowns"][i] > self.tick) or me["energy"] < move_cost(move):
                continue
            mech = mechanics(move)
            shape = mech["shape"]
            if shape != "self":
                if d > mech["range"] or foe["hidden"]:
                    continue
                if shape in ("projectile", "beam", "stream", "area", "channel") and self.blocked(me["x"], me["z"], foe["x"], foe["z"]):
                    continue
            net, T = self.move_score(side, move, mech, d, threats)
            if i == -1:
                # A useful support move wins. Struggle is a risky last offensive
                # option, still subject to energy, geometry, threat and recoil.
                if net > 0:
                    fallback = (net, i, move, mech, T)
            elif net > threshold and (best is None or net > best[0]):
                best = (net, i, move, mech, T)
            elif not offensive(move) and self.offense_exhausted(me) and (remaining_support is None or net > remaining_support[0]):
                # With no offensive PP left, using the remaining legal support
                # moves is still preferable to permanent inaction. They really
                # cast and spend PP; this does not grant early Struggle, invent
                # an effect, or force ordinary mixed kits to rotate attacks.
                remaining_support = (net, i, move, mech, T)
        return best or fallback or remaining_support

    def start_cast(self, side, index, move, mech, T):
        me, foe = self.fighters[side], self.fighters[1-side]
        if self.grapple_locked(side) or me["hp"] <= 0 or foe["hp"] <= 0 or me["cast"] or me["stunUntil"] > self.tick or me["status"] == "sleep" \
                or me["cooldown"] > self.tick or me["dashUntil"] > self.tick:
            return None
        if me.get("captureMode") and (me["captureMode"] == "hold" or self.capture_pending(side)
                or not any(i == index and safe["id"] == move["id"] for i, safe, _, _ in self.capture_safe_moves(side))):
            return None
        if index >= 0:
            if index >= len(me["moves"]):
                return None
            equipped = me["moves"][index]
            if equipped["id"] != move["id"] or equipped["remainingPp"] <= 0 or me["moveCooldowns"][index] > self.tick:
                return None
            move = equipped
        elif index != -1 or move["id"] != 165 or not self.all_pp_exhausted(me):
            return None
        if me["energy"] < move_cost(move):
            return None
        pp_before = move["remainingPp"] if index >= 0 else None
        if index >= 0:
            move["remainingPp"] -= 1
            me["moveCooldowns"][index] = self.tick + mech["windup"] + mech["cooldown"]
        me["energy"] = round(me["energy"] - move_cost(move), 3)
        lead = .55 + me["bond"] / 500
        ax, az = foe["x"] + foe["vx"]*T*lead, foe["z"] + foe["vz"]*T*lead
        if mech["shape"] == "self":
            ax, az = me["x"], me["z"]
        dx, dz = ax - me["x"], az - me["z"]
        length = math.hypot(dx, dz)
        dx, dz = (dx/length, dz/length) if length > 1e-6 else (me["facingX"], me["facingZ"])
        active_len = mech.get("active", 1)
        c = {"moveIndex": index, "moveId": move["id"], "name": move["name"], "shape": mech["shape"],
             "start": self.tick, "active": self.tick + mech["windup"], "activeLen": active_len,
             "end": self.tick + mech["windup"] + active_len + mech.get("recovery", 0),
             "dirX": round(dx, 4), "dirZ": round(dz, 4), "aimX": round(ax, 3), "aimZ": round(az, 3),
             "targetX": round(foe["x"], 3), "targetZ": round(foe["z"], 3), "hazard": None, "hits": 0,
             "threat": round(clamp(self.estimate(side, move) / max(1, foe["hp"]) * 3, .2, 3.), 3) if offensive(move) else .6,
             "mech": mech, "move": {k: move.get(k) for k in ("id", "name", "type", "power", "category", "effect", "accuracy")}}
        me["cast"] = c
        me["cooldown"] = c["end"]
        me["facingX"], me["facingZ"] = c["dirX"], c["dirZ"]
        me["action"] = move["name"]
        self.stats["casts"][side] += 1
        delivery = "status" if not offensive(move) else "melee" if mech["shape"] == "melee" else "ranged"
        hazard = self.make_hazard(side, c, mech, move)
        self.emit(f"{me['name']}使用了{move['name']}", "skill", me["id"], moveId=move["id"], moveType=move["type"],
                  ppBefore=pp_before, remainingPp=move["remainingPp"] if index >= 0 else None, energyAfter=me["energy"],
                  target=foe["id"], delivery=delivery, shape=mech["shape"], fromX=me["x"], fromZ=me["z"],
                  toX=foe["x"], toZ=foe["z"], aimX=c["aimX"], aimZ=c["aimZ"], dirX=c["dirX"], dirZ=c["dirZ"],
                  windupTicks=mech["windup"], impactTick=c["active"], hazardId=hazard["id"] if hazard else None,
                  geometry=self.public_hazard(hazard) if hazard else dict(mech, x=me["x"], z=me["z"], dirX=c["dirX"], dirZ=c["dirZ"]),
                  startTick=c["start"] + 1, activeTick=c["active"] + 1, endTick=c["end"] + 1)
        self.wake(1 - side, reaction_delay(foe) if foe.get("innateStyle") else foe["reaction"])
        return hazard

    def make_hazard(self, side, c, mech, move):
        me = self.fighters[side]
        shape = mech["shape"]
        if shape not in ("melee", "beam", "stream", "area", "burst", "channel"):
            return None
        h = {"id": self.next_id("h"), "side": side, "kind": shape, "moveId": move["id"], "moveType": move["type"],
             "created": self.tick, "active": c["active"], "activeLen": c["activeLen"], "end": c["active"] + c["activeLen"],
             "x": me["x"], "z": me["z"], "dirX": c["dirX"], "dirZ": c["dirZ"], "threat": c["threat"],
             "targetX": c["targetX"], "targetZ": c["targetZ"], "hit": False, "resolved": False}
        if shape == "melee":
            h.update(reach=mech["reach"], arc=mech["arc"], casterRadius=me["radius"], lungeLeft=mech["lunge"],
                     pulses=mech.get("pulses", 1), root=mech.get("root"))
        elif shape == "channel":
            h.update(length=mech["length"], halfWidth=round(mech["halfWidth"] * me["accuracyMultiplier"], 3),
                     spread=mech.get("spread", 0), reach=0., head=mech["head"], turn=round(math.radians(mech["turn"]), 5),
                     pulses=mech["pulses"], pulseGap=mech["pulseGap"], clash=None)
        elif shape in ("beam", "stream"):
            length = mech["length"]
            for o in self.obstacles:  # solid cover truncates the line at cast time
                if o["solid"]:
                    along = (o["x"]-me["x"])*c["dirX"] + (o["z"]-me["z"])*c["dirZ"]
                    if 0 < along < length and seg_dist(me["x"], me["z"], me["x"]+c["dirX"]*length, me["z"]+c["dirZ"]*length, o["x"], o["z"]) < o["radius"]:
                        length = along
            h.update(length=round(length, 3), halfWidth=mech["halfWidth"] * me["accuracyMultiplier"], spread=mech.get("spread", 0),
                     pulses=mech.get("pulses", 1), pulseGap=4 if shape == "stream" else 0)
        elif shape == "area":
            h.update(x=c["aimX"], z=c["aimZ"], radius=mech["radius"] * me["accuracyMultiplier"])
        elif shape == "burst":
            h.update(radius=mech["radius"])
        c["hazard"] = h["id"]
        self.pending_hazards.append(h)
        self.hazard_started(h)
        return h

    # ------------------------------------------------------------- thinking
    def plan(self, side):
        """Decide this tick's intent from the pre-tick state (both sides plan before either acts)."""
        me, foe = self.fighters[side], self.fighters[1-side]
        p = {"attack": None, "dash": None, "guard": False, "rest": False}
        if self.grapple_locked(side) or me["hp"] <= 0 or foe["hp"] <= 0 or me["status"] == "sleep" or me["stunUntil"] > self.tick:
            return p
        threats = self.threats(side)
        ai = me["ai"]
        c = me["cast"]
        dashing = me["dashUntil"] > self.tick
        in_recovery = c and c["shape"] not in ("burrow", "rest") and self.tick >= c["active"] + c["activeLen"]
        holding = c and c["shape"] == "channel" and self.tick >= c["active"]
        free = (not c or in_recovery or holding) and not me["hidden"] and not dashing
        command = self.current_command(side)
        if command and command["command"] == "dodge" and free:
            p["dash"] = self.commanded_dodge(side, threats)
            if p["dash"]:
                p["command"] = "dodge"
                return p
        imminent = [t for t in threats if t["eta"] <= 9]
        if imminent and free and me["rootUntil"] <= self.tick:
            here = self.danger_at(side, 0., 0., imminent)
            if here >= .5:
                s = max(.03, self.move_speed(me) if not in_recovery else me["speed"])
                dirs = [(math.cos(k*math.pi/6), math.sin(k*math.pi/6)) for k in range(12)]
                walk = min(self.danger_at(side, x*s, z*s, imminent) for x, z in dirs)
                if walk > here * .35:
                    boost = me["speed"] * 1.75  # 5 ticks at 2.2x, then walking: average over the threat horizon
                    scored = []
                    for x, z in dirs:
                        px, pz = me["x"] + x*1.5, me["z"] + z*1.5
                        edge = max(0., abs(px) - (BOUND_X - me["radius"])) + max(0., abs(pz) - (BOUND_Z - me["radius"]))
                        scored.append((self.danger_at(side, x*boost, z*boost, imminent) + edge*2, x, z))
                    best = min(scored)
                    min_eta = min(t["eta"] for t in imminent)
                    if best[0] < walk - .3 and ai["dashCd"] <= self.tick and me["energy"] >= 12:
                        p["dash"] = (best[1], best[2])
                        p["seen"] = min(t.get("seen", self.tick) for t in imminent)
                        return p
                    if min_eta <= 6 and me["energy"] >= 10 and me["guardUntil"] <= self.tick and not c:
                        p["guard"] = True
        if not c and not dashing and not p["guard"] and me["cooldown"] <= self.tick:
            if command and command["command"] == "move":
                p["attack"] = self.commanded_attack(side)
                if p["attack"]:
                    p["command"] = "move"
            elif not command or command["command"] != "dodge":
                p["attack"] = self.pick_attack(side, threats)
            if not p["attack"] and me["tactic"] == "guard" and not threats and self.distance() > 4.5 \
                    and me["hp"] < me["maxHp"] * .7 and me["recoveries"] and me["energy"] >= 30 \
                    and (not command or command["command"] not in ("move", "dodge")):
                p["rest"] = True
        if not me["hidden"]:
            self.steer(side, threats)
        return p

    def execute(self, side, p):
        me = self.fighters[side]
        ai = me["ai"]
        if p["dash"]:
            dx, dz = p["dash"]
            if me["cast"]:  # a recovery or a held jet can be abandoned to dodge
                self.cancel_cast(side, "cancel", quiet=me["cast"]["shape"] != "channel")
            me["dashUntil"] = self.tick + 5
            ai["dashX"], ai["dashZ"] = dx, dz
            ai["dashCd"] = self.tick + {"evasive": 32, "aggressive": 48}.get(me["style"], 40)
            me["energy"] = round(me["energy"] - 12, 3)
            me["action"] = "闪身"
            self.emit(f"{me['name']}闪身躲避", "dash", me["id"], fromX=me["x"], fromZ=me["z"], dirX=dx, dirZ=dz,
                      threatTick=p.get("seen"), reactionTicks=reaction_delay(me))
            if p.get("command") == "dodge":
                self.finish_command(side, "executed")
            return
        if p["guard"]:
            me["guardUntil"] = self.tick + 12
            me["energy"] = round(me["energy"] - 10, 3)
            me["action"] = "架势防御"
            self.emit(f"{me['name']}摆出防御架势", "guard", me["id"], x=me["x"], z=me["z"])
        if p["attack"]:
            _, index, move, mech, T = p["attack"]
            self.start_cast(side, index, move, mech, T)
            if p.get("command") == "move" and me["cast"] and me["cast"]["moveId"] == move["id"] and me["cast"]["start"] == self.tick:
                self.finish_command(side, "executed")
        elif p["rest"]:
            me["energy"] = round(me["energy"] - 30, 3)
            me["cast"] = {"moveIndex": None, "moveId": None, "name": "调整呼吸", "shape": "rest", "start": self.tick,
                          "active": self.tick + 16, "activeLen": 1, "end": self.tick + 20, "dirX": me["facingX"],
                          "dirZ": me["facingZ"], "hazard": None, "hits": 0, "threat": 0}
            me["cooldown"] = self.tick + 20
            me["action"] = "调整呼吸"
            self.emit(f"{me['name']}拉开距离调整呼吸", "rest", me["id"], x=me["x"], z=me["z"], impactTick=self.tick + 16)

    # ---------------------------------------------------------------- casts
    def advance_cast(self, side):
        me, foe = self.fighters[side], self.fighters[1-side]
        c = me["cast"]
        if not c or me["hp"] <= 0:
            return
        shape = c["shape"]
        if shape == "burrow":
            mech = c["mech"]
            if self.tick == c["start"] + 4:
                me["hidden"] = True
                self.emit(f"{me['name']}钻入地下", "burrow", me["id"], x=me["x"], z=me["z"])
            if self.tick == c["active"] - mech["warn"]:
                ex = clamp(foe["x"], -BOUND_X + 1, BOUND_X - 1)
                ez = clamp(foe["z"], -BOUND_Z + 1, BOUND_Z - 1)
                h = {"id": self.next_id("h"), "side": side, "kind": "emerge", "moveId": c["moveId"],
                     "moveType": c["move"]["type"], "created": self.tick, "active": c["active"], "activeLen": 1,
                     "end": c["active"] + 1, "x": round(ex, 3), "z": round(ez, 3), "dirX": c["dirX"], "dirZ": c["dirZ"],
                     "radius": mech["radius"], "threat": c["threat"], "targetX": foe["x"], "targetZ": foe["z"],
                     "hit": False, "resolved": False}
                c["hazard"] = h["id"]
                c["emergeX"], c["emergeZ"] = h["x"], h["z"]
                self.hazards.append(h)
                self.hazard_started(h)
                self.emit("地面开始隆起", "warn", me["id"], hazardId=h["id"], x=h["x"], z=h["z"], radius=h["radius"],
                          impactTick=c["active"], geometry=self.public_hazard(h), startTick=h["created"] + 1,
                          activeTick=h["active"] + 1, endTick=h["end"] + 1)
            if self.tick == c["active"]:
                me["hidden"] = False
        if self.tick != c["active"]:
            return
        if shape == "projectile":
            self.fire(side, c)
        elif shape == "self":
            self.resolve_self(side, c)
        elif shape == "rest":
            amount = round(me["maxHp"] * .12, 2)
            me["hp"] = min(me["maxHp"], round(me["hp"] + amount, 2))
            me["recoveries"] -= 1
            self.emit(f"{me['name']}调整呼吸，恢复了{amount:g}点体力", "heal", me["id"], amount=amount, hpAfter=me["hp"])

    def fire(self, side, c):
        me, foe = self.fighters[side], self.fighters[1-side]
        mech = c["mech"]
        count = max(1, int(mech.get("count", 1)))
        base = math.atan2(c["dirZ"], c["dirX"])
        react = reaction_delay(foe)
        for i in range(count):
            a = base + math.radians(mech.get("spread", 8)) * (i - (count - 1) / 2)
            dx, dz = math.cos(a), math.sin(a)
            x, z = me["x"] + dx * (me["radius"] + .2), me["z"] + dz * (me["radius"] + .2)
            proj = {"id": self.next_id("p"), "side": side, "moveId": c["moveId"], "type": c["move"]["type"],
                    "x": round(x, 4), "z": round(z, 4), "vx": round(dx * mech["speed"], 4), "vz": round(dz * mech["speed"], 4),
                    "speed": mech["speed"], "radius": mech["radius"], "maxRange": mech["maxRange"], "traveled": 0.,
                    "born": self.tick, "seenEarly": mech["windup"] if self.tick - c["start"] >= react else 0,
                    "threat": c["threat"], "move": c["move"], "push": mech.get("push"), "scale": 1. / count if count > 1 else 1.,
                    "spawnTargetX": round(foe["x"], 3), "spawnTargetZ": round(foe["z"], 3), "minDist": 99.}
            self.projectiles.append(proj)
            self.emit(f"{c['name']}飞出", "fire", me["id"], projectileId=proj["id"], moveId=c["moveId"], moveType=proj["type"],
                      x=proj["x"], z=proj["z"], vx=proj["vx"], vz=proj["vz"], radius=proj["radius"],
                      ttl=int(mech["maxRange"] / mech["speed"]), projectile=self.public_projectile(proj))

    def resolve_self(self, side, c):
        me, foe = self.fighters[side], self.fighters[1-side]
        mech = c["mech"]
        if mech.get("blink"):
            threats = self.threats(side, perceived=False)
            best = None
            for k in range(8):
                a = k * math.pi / 4
                x = clamp(me["x"] + math.cos(a) * mech["blink"], -BOUND_X + me["radius"], BOUND_X - me["radius"])
                z = clamp(me["z"] + math.sin(a) * mech["blink"], -BOUND_Z + me["radius"], BOUND_Z - me["radius"])
                score = -math.hypot(x - foe["x"], z - foe["z"]) * .2
                old = (me["x"], me["z"])
                me["x"], me["z"] = x, z
                score += self.danger_at(side, 0., 0., threats)
                me["x"], me["z"] = old
                if best is None or score < best[0]:
                    best = (score, x, z)
            self.emit(f"{me['name']}瞬间移动", "blink", me["id"], fromX=me["x"], fromZ=me["z"], x=best[1], z=best[2])
            me["x"], me["z"] = round(best[1], 4), round(best[2], 4)
            return
        self.move_effect(side, side if c["move"]["category"] == "status" else 1 - side, c["move"], 0, self_cast=True)

    # --------------------------------------------------------------- motion
    def integrate(self):
        previous = [(f["x"], f["z"]) for f in self.fighters]
        self._previous_positions = previous
        for side, me in enumerate(self.fighters):
            ai = me["ai"]
            c = me["cast"]
            foe = self.fighters[1-side]
            if self.grapple_locked(side):
                me.update(vx=0., vz=0., kbX=0., kbZ=0.)
            elif me["hp"] <= 0:
                me["vx"] = me["vz"] = 0.
            elif me["dashUntil"] > self.tick and me["stunUntil"] <= self.tick:
                me["vx"], me["vz"] = ai["dashX"] * me["speed"] * 2.2, ai["dashZ"] * me["speed"] * 2.2
            elif c and c["shape"] == "melee" and c["active"] <= self.tick < c["active"] + c["activeLen"] and me["stunUntil"] <= self.tick:
                step = c["mech"]["lunge"] / max(1, c["activeLen"])
                ox, oz = previous[1 - side]
                mx, mz = previous[side]
                gap = math.hypot(ox - mx, oz - mz) - me["radius"] - foe["radius"]
                ahead = (ox - mx) * c["dirX"] + (oz - mz) * c["dirZ"] > 0
                if ahead and gap < step:
                    step = max(0., gap - .02)
                me["vx"], me["vz"] = c["dirX"] * step, c["dirZ"] * step
            elif me["hidden"] and c and c["shape"] == "burrow":
                tx, tz = (c["emergeX"], c["emergeZ"]) if "emergeX" in c else (foe["x"], foe["z"])
                dx, dz = tx - me["x"], tz - me["z"]
                dist = math.hypot(dx, dz)
                left = max(1, c["active"] - self.tick)
                v = min(dist, max(me["speed"] * 1.3, dist / left if "emergeX" in c else 0.))
                me["vx"], me["vz"] = (dx / dist * v, dz / dist * v) if dist > 1e-6 else (0., 0.)
            else:
                want = self.move_speed(me)
                tx, tz = ai["dirX"] * want, ai["dirZ"] * want
                accel = max(.012, me["speed"] / 3)
                dvx, dvz = tx - me["vx"], tz - me["vz"]
                mag = math.hypot(dvx, dvz)
                if mag > accel:
                    dvx, dvz = dvx / mag * accel, dvz / mag * accel
                me["vx"], me["vz"] = me["vx"] + dvx, me["vz"] + dvz
        for me, (old_x, old_z) in zip(self.fighters, previous):
            me["x"] = old_x + me["vx"] + me["kbX"]
            me["z"] = old_z + me["vz"] + me["kbZ"]
        # collisions: walls, bodies, obstacles (hidden fighters are underground)
        a, b = self.fighters
        if not self.grapple_locked(0) and not a["hidden"] and not b["hidden"] and a["hp"] > 0 and b["hp"] > 0:
            dx, dz = b["x"] - a["x"], b["z"] - a["z"]
            dist = math.hypot(dx, dz)
            need = a["radius"] + b["radius"]
            if dist < need:
                if dist < 1e-6:
                    dx, dz, dist = (1., 0., 1.) if a["x"] <= b["x"] else (-1., 0., 1.)
                push = (need - dist) / 2
                a["x"] -= dx / dist * push; a["z"] -= dz / dist * push
                b["x"] += dx / dist * push; b["z"] += dz / dist * push
        for me in self.fighters:
            kb = math.hypot(me["kbX"], me["kbZ"])
            if not me["hidden"]:
                for o in list(self.obstacles):
                    dx, dz = me["x"] - o["x"], me["z"] - o["z"]
                    dist = math.hypot(dx, dz)
                    need = me["radius"] + o["radius"]
                    if dist < need:
                        if not o["solid"] and kb > .12:
                            self.break_obstacle(o, me["id"])
                            continue
                        if dist < 1e-6:
                            dx, dz, dist = 0., 1., 1.
                        me["x"] = o["x"] + dx / dist * need
                        me["z"] = o["z"] + dz / dist * need
                        if not o["solid"] and kb > .05:
                            self.damage_obstacle(o, kb * 60, me["id"])
            lim_x, lim_z = BOUND_X - me["radius"], BOUND_Z - me["radius"]
            if abs(me["x"]) > lim_x:
                me["vx"] = 0.; me["kbX"] = 0.
            if abs(me["z"]) > lim_z:
                me["vz"] = 0.; me["kbZ"] = 0.
            me["x"] = round(clamp(me["x"], -lim_x, lim_x), 4)
            me["z"] = round(clamp(me["z"], -lim_z, lim_z), 4)
            me["vx"], me["vz"] = round(me["vx"], 4), round(me["vz"], 4)
            me["kbX"] = round(me["kbX"] * .7, 4) if abs(me["kbX"]) > .01 else 0.
            me["kbZ"] = round(me["kbZ"] * .7, 4) if abs(me["kbZ"]) > .01 else 0.
        for side, me in enumerate(self.fighters):
            foe = self.fighters[1-side]
            if me["cast"]:
                me["facingX"], me["facingZ"] = me["cast"]["dirX"], me["cast"]["dirZ"]
            else:
                dx, dz = foe["x"] - me["x"], foe["z"] - me["z"]
                d = math.hypot(dx, dz)
                if d > 1e-6:
                    me["facingX"], me["facingZ"] = round(dx / d, 4), round(dz / d, 4)

    def damage_obstacle(self, o, amount, by):
        if o["solid"] or o not in self.obstacles:
            return
        o["hp"] = round(o["hp"] - amount, 2)
        if o["hp"] <= 0:
            self.break_obstacle(o, by)

    def break_obstacle(self, o, by):
        if o in self.obstacles:
            self.obstacles.remove(o)
            self.emit("木箱被撞碎了", "break", by, obstacleId=o["id"], x=o["x"], z=o["z"])

    # ------------------------------------------------------------ resolution
    def follow_hazards(self):
        for h in self.hazards:
            if h["kind"] not in ("melee", "beam", "stream", "burst", "channel"):
                continue
            caster = self.fighters[h["side"]]
            if h["kind"] == "channel":
                self.follow_channel(h, caster)
                continue
            if h["kind"] == "stream" and self.tick >= h["active"]:
                foe = self.fighters[1 - h["side"]]
                want = math.atan2(foe["z"] - caster["z"], foe["x"] - caster["x"])
                cur = math.atan2(h["dirZ"], h["dirX"])
                diff = (want - cur + math.pi) % (2 * math.pi) - math.pi
                cur += clamp(diff, -math.radians(3.5), math.radians(3.5))
                h["dirX"], h["dirZ"] = round(math.cos(cur), 4), round(math.sin(cur), 4)
                caster["facingX"], caster["facingZ"] = h["dirX"], h["dirZ"]
                if caster["cast"]:
                    caster["cast"]["dirX"], caster["cast"]["dirZ"] = h["dirX"], h["dirZ"]
            h["x"], h["z"] = caster["x"], caster["z"]
            if h["kind"] == "melee":
                c = caster["cast"]
                if c and self.tick >= c["active"]:
                    h["lungeLeft"] = 0.

    def follow_channel(self, h, caster):
        """Sustained jet: origin rides the (moving) caster, aim turns at a limited rate, head extends."""
        foe = self.fighters[1 - h["side"]]
        h["x"], h["z"] = caster["x"], caster["z"]
        if self.tick >= h["end"]:
            return
        if not foe["hidden"]:
            cur = math.atan2(h["dirZ"], h["dirX"])
            cur += clamp(wrap(math.atan2(foe["z"] - caster["z"], foe["x"] - caster["x"]) - cur), -h["turn"], h["turn"])
            h["dirX"], h["dirZ"] = round(math.cos(cur), 4), round(math.sin(cur), 4)
        caster["facingX"], caster["facingZ"] = h["dirX"], h["dirZ"]
        if caster["cast"]:
            caster["cast"]["dirX"], caster["cast"]["dirZ"] = h["dirX"], h["dirZ"]
        if self.tick >= h["active"]:
            reach = min(h["length"], h["reach"] + h["head"])
            for o in self.obstacles:  # solid cover stops the jet; crates soak it
                along = (o["x"] - h["x"]) * h["dirX"] + (o["z"] - h["z"]) * h["dirZ"]
                if 0 < along < reach + o["radius"] and abs((o["x"] - h["x"]) * -h["dirZ"] + (o["z"] - h["z"]) * h["dirX"]) < o["radius"] + h["halfWidth"] * .5:
                    reach = min(reach, max(0., along - o["radius"] * .6))
                    if not o["solid"] and (self.tick - h["active"]) % h["pulseGap"] == 0:
                        self.damage_obstacle(o, 5, caster["id"])
            h["reach"] = round(reach, 3)

    def channel_contact(self, A, B):
        """Do the two jet heads touch right now? -> meeting point or None."""
        d, ax, az, bx, bz = seg_seg(A["x"], A["z"], A["x"] + A["dirX"] * A["reach"], A["z"] + A["dirZ"] * A["reach"],
                                    B["x"], B["z"], B["x"] + B["dirX"] * B["reach"], B["z"] + B["dirZ"] * B["reach"])
        if d > A["halfWidth"] + B["halfWidth"]:
            return None
        return (ax + bx) / 2, (az + bz) / 2

    def channel_meet(self, A, B, share):
        """Meeting point held at fraction `share` of the caster-to-caster line; None once either jet no longer covers it."""
        mx, mz = A["x"] + (B["x"] - A["x"]) * share, A["z"] + (B["z"] - A["z"]) * share
        alongs = []
        for h in (A, B):
            along = (mx - h["x"]) * h["dirX"] + (mz - h["z"]) * h["dirZ"]
            across = abs((mx - h["x"]) * -h["dirZ"] + (mz - h["z"]) * h["dirX"])
            if along < 0 or along > h["length"] + .3 or across > h["halfWidth"] + .45:
                return None
            alongs.append(along)
        return mx, mz, alongs[0], alongs[1]

    def jet_strength(self, h):
        me, foe = self.fighters[h["side"]], self.fighters[1 - h["side"]]
        move = battle_data()[0].get(h["moveId"], {})
        value = (move.get("power") or 40) * (1.5 if h["moveType"] in me["types"] else 1.) * me["special"]
        other = next((g for g in self.hazards if g["id"] == self.clashes.get(h.get("clash"), {}).get("b" if self.clashes.get(h.get("clash"), {}).get("a") == h["id"] else "a")), None)
        if other:
            value *= effectiveness(h["moveType"], [other["moveType"]])
        return max(1., value)

    def resolve_channels(self):
        """Opposing jets that meet stop each other's pulses; the meeting point is pushed toward the weaker
        jet. Breaking alignment just ends the clash; a side that is pushed back to its body is overpowered;
        when either jet stops (or after 3 s) the stored energy bursts back along both jets as real projectiles."""
        chans = {h["id"]: h for h in self.hazards if h["kind"] == "channel" and h["active"] <= self.tick < h["end"]}
        for key, cl in list(self.clashes.items()):
            A, B = chans.get(cl["a"]), chans.get(cl["b"])
            if not A or not B:
                self.clash_burst(cl)
                continue
            meet = self.channel_meet(A, B, cl["share"])
            if meet is None:
                self.emit("对波错开了", "clashEnd", None, clashId=key, x=cl["x"], z=cl["z"])
                A["clash"] = B["clash"] = None
                del self.clashes[key]
                continue
            sa, sb = self.jet_strength(A), self.jet_strength(B)
            gap = max(.5, math.hypot(B["x"] - A["x"], B["z"] - A["z"]))
            cl["share"] = round(clamp(cl["share"] + .035 * (sa - sb) / (sa + sb) / gap, 0., 1.), 5)
            meet = self.channel_meet(A, B, cl["share"]) or meet
            mx, mz, along_a, along_b = meet
            cl["x"], cl["z"] = round(mx, 3), round(mz, 3)
            A["reach"], B["reach"] = round(max(0., min(A["length"], along_a)), 3), round(max(0., min(B["length"], along_b)), 3)
            cl["ticks"] += 1
            for h in (A, B):
                if (self.tick - h["active"]) % h["pulseGap"] == 0:
                    cl["stored"][h["id"]] += 1
            for strong, weak in ((A, B), (B, A)):
                body = self.fighters[weak["side"]]
                if math.hypot(mx - body["x"], mz - body["z"]) < body["radius"] + .35:
                    self.emit(f"{self.fighters[strong['side']]['name']}压过了对波", "overpower", self.fighters[strong["side"]]["id"],
                              clashId=key, x=cl["x"], z=cl["z"])
                    self.clash_burst(cl, only=weak["side"])
                    if self.fighters[weak["side"]]["cast"] and self.fighters[weak["side"]]["cast"].get("hazard") == weak["id"]:
                        self.cancel_cast(weak["side"], "cancel", quiet=True)  # the overpowered jet is extinguished
                    break
            else:
                if cl["ticks"] >= 60:
                    self.clash_burst(cl)
                    for h in (A, B):
                        if self.fighters[h["side"]]["cast"] and self.fighters[h["side"]]["cast"].get("hazard") == h["id"]:
                            self.cancel_cast(h["side"], "cancel", quiet=True)
        live = [h for h in chans.values() if not h.get("clash") and h["reach"] > 0]
        for i, A in enumerate(live):
            for B in live[i + 1:]:
                if A["side"] == B["side"] or A["dirX"] * B["dirX"] + A["dirZ"] * B["dirZ"] > -.2:
                    continue
                meet = self.channel_contact(A, B)
                if meet and all(math.hypot(meet[0] - f["x"], meet[1] - f["z"]) > f["radius"] + .5
                                for f in (self.fighters[A["side"]], self.fighters[B["side"]])):
                    key = f"c{A['id']}-{B['id']}"
                    gap = max(.5, math.hypot(B["x"] - A["x"], B["z"] - A["z"]))
                    share = clamp(math.hypot(meet[0] - A["x"], meet[1] - A["z"]) / gap, .05, .95)
                    self.clashes[key] = {"id": key, "a": A["id"], "b": B["id"], "sides": [A["side"], B["side"]], "x": round(meet[0], 3),
                                         "z": round(meet[1], 3), "share": round(share, 5), "ticks": 0, "start": self.tick, "stored": {A["id"]: 0, B["id"]: 0}}
                    A["clash"] = B["clash"] = key
                    self.stats["clashes"] += 1
                    self.emit("双方的招式正面对冲", "clash", None, clashId=key, hazardId=A["id"], otherId=B["id"], x=meet[0], z=meet[1])

    def clash_burst(self, cl, only=None):
        key = cl["id"]
        self.clashes.pop(key, None)
        hz = {h["id"]: h for h in self.hazards}
        for hid in (cl["a"], cl["b"]):
            if hid in hz:
                hz[hid]["clash"] = None
        radius = round(min(2.6, 1.2 + .03 * cl["ticks"]), 2)
        self.emit("对波积蓄的能量爆开了", "clashBurst", None, clashId=key, x=cl["x"], z=cl["z"], radius=radius,
                  clashTicks=cl["ticks"], stored=dict(cl["stored"]))
        for o in list(self.obstacles):
            if not o["solid"] and math.hypot(o["x"] - cl["x"], o["z"] - cl["z"]) <= radius + o["radius"]:
                self.break_obstacle(o, None)
        moves = battle_data()[0]
        for owner_hid, victim_side in ((cl["a"], cl["sides"][1]), (cl["b"], cl["sides"][0])):
            if only is not None and victim_side != only:
                continue
            owner = hz.get(owner_hid)
            move_id = owner["moveId"] if owner else None
            if move_id is None:
                continue
            victim = self.fighters[victim_side]
            dx, dz = victim["x"] - cl["x"], victim["z"] - cl["z"]
            n = math.hypot(dx, dz) or 1.
            mech = mechanics(moves[move_id])
            scale = round(.25 + cl["stored"][owner_hid] * 1.3 / max(1, mech.get("pulses", 6)) * .8, 3)
            m = moves[move_id]
            proj = {"id": self.next_id("p"), "side": 1 - victim_side, "moveId": move_id, "type": m["type"],
                    "x": cl["x"], "z": cl["z"], "vx": round(dx / n * .55, 4), "vz": round(dz / n * .55, 4), "speed": .55,
                    "radius": .6, "maxRange": round(n + 2.5, 2), "traveled": 0., "born": self.tick, "seenEarly": 0,
                    "threat": 2., "move": {k: m.get(k) for k in ("id", "name", "type", "power", "category", "effect", "accuracy")},
                    "push": None, "scale": scale, "spawnTargetX": victim["x"], "spawnTargetZ": victim["z"], "minDist": 99.,
                    "burst": key}
            self.projectiles.append(proj)
            self.emit("能量沿水火流反冲", "fire", self.fighters[1 - victim_side]["id"], projectileId=proj["id"], moveId=move_id,
                      moveType=m["type"], x=proj["x"], z=proj["z"], vx=proj["vx"], vz=proj["vz"], radius=proj["radius"],
                      ttl=int(proj["maxRange"] / .55), clashId=key, projectile=self.public_projectile(proj))

    def end_projectile(self, p, reason, **data):
        self.emit("", "projectileEnd", self.fighters[p["side"]]["id"], projectileId=p["id"],
                  moveId=p["moveId"], reason=reason, x=p["x"], z=p["z"], **data)

    def step_projectiles(self):
        # All candidate contacts use the same pre/post-tick paths. Resolve globally by
        # first time of impact, not by target/obstacle/list order. Ties favour cover.
        projectiles = {p["id"]: p for p in self.projectiles}
        paths, limits, candidates = {}, {}, []
        old_positions = self._previous_positions or [(f["x"], f["z"]) for f in self.fighters]
        def add(t, priority, pid, kind, other):
            if t is not None and t <= limits[pid] + 1e-10:
                candidates.append((round(t, 12), priority, pid, kind, other))
        for pid, p in projectiles.items():
            p0 = (p["x"], p["z"])
            p1 = (p["x"] + p["vx"], p["z"] + p["vz"])
            paths[pid] = (p0, p1)
            limit = clamp((p["maxRange"] - p["traveled"]) / max(1e-9, p["speed"]), 0., 1.)
            reason = "range"
            for axis, bound in ((0, BOUND_X + 1), (1, BOUND_Z + 1)):
                delta = p1[axis] - p0[axis]
                if abs(p0[axis]) > bound:
                    limit, reason = 0., "bounds"
                elif delta and abs(p1[axis]) > bound:
                    t = ((bound if delta > 0 else -bound) - p0[axis]) / delta
                    if t < limit:
                        limit, reason = max(0., t), "bounds"
            limits[pid] = limit
            if limit < 1 or p["traveled"] + p["speed"] >= p["maxRange"]:
                add(limit, 3, pid, "expire", reason)
            side = 1 - p["side"]
            target = self.fighters[side]
            q0, q1 = old_positions[side], (target["x"], target["z"])
            if not target["hidden"] and target["hp"] > 0:
                relative0 = (p0[0] - q0[0], p0[1] - q0[1])
                relative1 = (p1[0] - q1[0], p1[1] - q1[1])
                p["minDist"] = round(min(p.get("minDist", 99.), seg_dist(*relative0, *relative1, 0., 0.)), 3)
                add(swept_toi(p0, p1, q0, q1, p["radius"] + self.hurt_radius(target)), 2, pid, "target", side)
            for o in self.obstacles:
                point = (o["x"], o["z"])
                add(swept_toi(p0, p1, point, point, o["radius"] + p["radius"] * .6), 0, pid, "obstacle", o["id"])
            if not p.get("burst"):
                for h in self.hazards:
                    if h["side"] != p["side"] and h["kind"] in ("beam", "stream", "channel") and h["active"] <= self.tick < h["end"]:
                        add(swept_line_toi(p0, p1, h, p["radius"]), 1, pid, "hazard", h["id"])
        ids = sorted(projectiles)
        for i, pid in enumerate(ids):
            p = projectiles[pid]
            for qid in ids[i + 1:]:
                q = projectiles[qid]
                if p["side"] != q["side"] and not (p.get("burst") and p.get("burst") == q.get("burst")):
                    # Counterflow released by one clash shares an origin but travels
                    # toward opposite fighters; sibling fragments are one explosion.
                    t = swept_toi(*paths[pid], *paths[qid], p["radius"] + q["radius"])
                    if t is not None and t <= min(limits[pid], limits[qid]) + 1e-10:
                        add(t, 1, pid, "projectile", qid)
        dead = set()
        def place(pid, t):
            p = projectiles[pid]
            a, b = paths[pid]
            p["x"], p["z"] = round(a[0] + (b[0] - a[0]) * t, 4), round(a[1] + (b[1] - a[1]) * t, 4)
            return p
        for t, _, pid, kind, other in sorted(candidates):
            if pid in dead:
                continue
            p = projectiles[pid]
            if kind == "projectile" and other in dead:
                continue
            if kind == "obstacle":
                o = next((o for o in self.obstacles if o["id"] == other), None)
                if o is None:
                    continue
            p = place(pid, t)
            if kind == "target":
                target = self.fighters[other]
                self.hits.append({"by": p["side"], "to": other, "move": p["move"], "kind": "projectile",
                                  "dirX": p["vx"] / p["speed"], "dirZ": p["vz"] / p["speed"], "scale": p["scale"],
                                  "push": p.get("push"), "projectileId": pid, "x": p["x"], "z": p["z"]})
                self.end_projectile(p, "hit", targetId=target["id"], toi=t)
            elif kind == "obstacle":
                self.emit("招式被障碍挡住", "blocked", None, projectileId=pid, obstacleId=other, x=p["x"], z=p["z"])
                if not o["solid"]:
                    self.damage_obstacle(o, 6 + (p["move"].get("power") or 40) / 4, self.fighters[p["side"]]["id"])
                self.stats["missed"][p["side"]] += 1
                self.end_projectile(p, "obstacle", obstacleId=other, toi=t)
            elif kind == "projectile":
                q = place(other, t)
                dead.add(other)
                self.stats["clashes"] += 1
                self.emit("招式相互抵消", "clash", None, projectileId=pid, otherId=other,
                          x=(p["x"] + q["x"]) / 2, z=(p["z"] + q["z"]) / 2)
                self.end_projectile(p, "projectile_clash", otherProjectileId=other, toi=t)
                self.end_projectile(q, "projectile_clash", otherProjectileId=pid, toi=t)
            elif kind == "hazard":
                self.stats["clashes"] += 1
                self.emit("招式相互抵消", "clash", None, projectileId=pid, hazardId=other, x=p["x"], z=p["z"])
                self.end_projectile(p, "hazard_clash", hazardId=other, toi=t)
            else:
                p["traveled"] = round(p["traveled"] + p["speed"] * t, 4)
                start_x = p["x"] - p["vx"] / p["speed"] * p["traveled"]
                start_z = p["z"] - p["vz"] / p["speed"] * p["traveled"]
                target = self.fighters[1 - p["side"]]
                would = seg_dist(start_x, start_z, p["x"], p["z"], p["spawnTargetX"], p["spawnTargetZ"]) <= p["radius"] + self.hurt_radius(target)
                self.whiff(p["side"], would, p["move"], projectileId=pid, x=p["x"], z=p["z"], minDist=p["minDist"])
                self.end_projectile(p, other, toi=t)
            dead.add(pid)
        for pid, p in projectiles.items():
            if pid not in dead:
                place(pid, 1.)
                p["traveled"] = round(p["traveled"] + p["speed"], 4)
        self.projectiles = [p for pid, p in projectiles.items() if pid not in dead]
        self._previous_positions = None

    def whiff(self, side, dodged, move, **data):
        me, target = self.fighters[side], self.fighters[1 - side]
        if dodged:
            self.stats["dodged"][1 - side] += 1
            self.emit(f"{target['name']}躲开了{move.get('name') or '招式'}", "evade", target["id"], source=me["id"],
                      moveId=move.get("id"), **data)
            self.wake(1 - side, 1)  # a clean dodge is the moment to punish
        else:
            self.stats["missed"][side] += 1
            self.emit(f"{me['name']}的{move.get('name') or '招式'}落空了", "miss", me["id"], target=target["id"],
                      moveId=move.get("id"), **data)

    def hazard_contains(self, h, x, z, r):
        k = h["kind"]
        if k in ("area", "burst", "emerge"):
            return math.hypot(x - h["x"], z - h["z"]) <= h["radius"] + r * .5
        if k in ("beam", "stream"):
            return in_capsule(h["x"], h["z"], h["dirX"], h["dirZ"], h["length"], h["halfWidth"], h.get("spread", 0), x, z, r)
        if k == "channel":
            return h["reach"] > 0 and in_capsule(h["x"], h["z"], h["dirX"], h["dirZ"], h["reach"], h["halfWidth"], h.get("spread", 0), x, z, r)
        if k == "melee":
            dx, dz = x - h["x"], z - h["z"]
            d = math.hypot(dx, dz)
            if d > h["reach"] + h["casterRadius"] + r:
                return False
            if d < h["casterRadius"] + r + .15:
                return True
            return (dx * h["dirX"] + dz * h["dirZ"]) / d >= math.cos(math.radians(h["arc"] / 2))
        return False

    def resolve_hazards(self):
        # opposed beams/streams meeting head-on cancel each other this tick (V1 62.5–67.5 s)
        clashing = set()
        live = [h for h in self.hazards if h["kind"] in ("beam", "stream", "channel") and h["active"] <= self.tick < h["end"]]
        for i, h in enumerate(live):
            for g in live[i+1:]:
                if h["kind"] == g["kind"] == "channel":
                    continue  # jet-vs-jet clashes are resolved in resolve_channels
                if h["side"] != g["side"] and h["dirX"] * g["dirX"] + h["dirZ"] * g["dirZ"] < -.5:
                    hl, gl = h.get("reach", h["length"]), g.get("reach", g["length"])
                    hx, hz = h["x"] + h["dirX"] * hl, h["z"] + h["dirZ"] * hl
                    gx, gz = g["x"] + g["dirX"] * gl, g["z"] + g["dirZ"] * gl
                    d, ax, az, bx, bz = seg_seg(h["x"], h["z"], hx, hz, g["x"], g["z"], gx, gz)
                    if d <= h["halfWidth"] + g["halfWidth"]:
                        clashing.update((h["id"], g["id"]))
                        if (self.tick - h["active"]) % 4 == 0:
                            self.stats["clashes"] += 1
                            self.emit("双方招式正面相撞", "clash", None, hazardId=h["id"], otherId=g["id"],
                                      x=(ax + bx) / 2, z=(az + bz) / 2)
        for h in self.hazards:
            if self.tick < h["active"] or self.tick >= h["end"] or h["resolved"] or h.get("_endReason"):
                continue
            caster, target = self.fighters[h["side"]], self.fighters[1 - h["side"]]
            if caster["hp"] <= 0 and h["kind"] not in ("area",):
                h["resolved"] = True
                continue
            k = h["kind"]
            if k == "area":
                for o in list(self.obstacles):
                    if not o["solid"] and math.hypot(o["x"] - h["x"], o["z"] - h["z"]) <= h["radius"] + o["radius"]:
                        self.break_obstacle(o, caster["id"])
            last = self.tick == h["end"] - 1
            pulse = True
            if k == "stream":
                pulse = (self.tick - h["active"]) % 4 == 0
            elif k == "channel":  # every pulse is judged on the jet's geometry at that tick
                pulse = (self.tick - h["active"]) % h["pulseGap"] == 0 and not h.get("clash")
            if h["id"] in clashing:
                pulse = False
            hit = pulse and not target["hidden"] and target["hp"] > 0 and \
                self.hazard_contains(h, target["x"], target["z"], self.hurt_radius(target))
            if hit and h["moveId"] == 69:
                if effectiveness(h["moveType"], target["types"]) <= 0:
                    h["resolved"] = True
                    self.end_hazard(h, "immune")
                    self.emit(f"{target['name']}不受地球上投影响", "immune", target["id"],
                              source=caster["id"], moveId=69, hazardId=h["id"], x=target["x"], z=target["z"])
                    continue
                if self.start_grapple(h["side"], h):
                    h["hit"], h["resolved"] = True, True
                # Contact is a grab attempt, never an immediate damage pulse.
                # A failed close-range/cover/immunity check can retry only
                # during the remaining original two-tick active window.
                hit = False
            if hit:
                move = caster["cast"]["move"] if caster["cast"] and caster["cast"].get("hazard") == h["id"] else \
                    dict(battle_data()[0].get(h["moveId"], battle_data()[0][165]))
                scale = 1.3 / h["pulses"] if k == "channel" else 1. / h.get("pulses", 1) if k == "stream" else float(h.get("pulses", 1)) if k == "melee" else 1.
                if k == "melee":
                    dx, dz = target["x"] - caster["x"], target["z"] - caster["z"]
                elif k in ("beam", "stream", "channel"):
                    dx, dz = h["dirX"], h["dirZ"]
                else:
                    dx, dz = target["x"] - h["x"], target["z"] - h["z"]
                    if math.hypot(dx, dz) < .1:
                        dx, dz = target["x"] - caster["x"], target["z"] - caster["z"]
                n = math.hypot(dx, dz) or 1.
                self.hits.append({"by": h["side"], "to": 1 - h["side"], "move": move, "kind": k, "dirX": dx / n, "dirZ": dz / n,
                                  "scale": scale, "hazardId": h["id"], "root": h.get("root"), "hits": h.get("pulses", 1) if k == "melee" else None,
                                  "x": target["x"], "z": target["z"]})
                h["hit"] = True
                if k not in ("stream", "channel"):
                    h["resolved"] = True
            if k == "burst" and caster["cast"] and caster["cast"]["mech"].get("selfKO") and self.tick == h["active"]:
                self.selfko.append(h["side"])
            if last and not h["hit"]:
                h["resolved"] = True
                would = self.hazard_contains(dict(h, x=h["x"], z=h["z"]), h["targetX"], h["targetZ"], self.hurt_radius(target)) \
                    if k not in ("melee",) else math.hypot(h["targetX"] - caster["x"], h["targetZ"] - caster["z"]) <= h["reach"] + h["casterRadius"] + target["radius"]
                move = {"id": h["moveId"], "name": battle_data()[0].get(h["moveId"], {}).get("name")}
                self.whiff(h["side"], would, move, hazardId=h["id"], x=target["x"], z=target["z"])

    # ------------------------------------------------------------ hits
    def damage(self, side, other_side, attack_type, power, move_id=None, fixed=None, **extra):
        me, target = self.fighters[side], self.fighters[other_side]
        scale = effectiveness(attack_type, target["types"])
        if fixed is not None:  # level-based / half-HP moves ignore stats and multipliers except immunity
            amount = fixed if scale > 0 else 0
            scale = 1. if scale > 0 else 0.
        else:
            attack = me["special"] if attack_type in SPECIAL_TYPES else me["attack"]
            defense = target["special"] if attack_type in SPECIAL_TYPES else target["defense"]
            amount = max(1, (2.3 + attack * .5) * (10 / (8 + defense)))
            amount *= power * scale * (.9 + .2 * self.rng.random())
            if attack_type in me["types"]:
                amount *= 1.5
        guarded = target["guardUntil"] > self.tick
        if guarded:
            amount *= .45
        amount = round(amount, 2)
        target["hp"] = max(0, round(target["hp"] - amount, 2))
        note = "，效果绝佳" if scale > 1 else "，效果有限" if scale < 1 else ""
        self.emit(f"{target['name']}受到{amount:g}点伤害{note}", "damage", target["id"], source=me["id"], moveId=move_id,
                  moveType=attack_type, amount=amount, effectiveness=scale, guarded=guarded or None, hpAfter=target["hp"],
                  x=target["x"], z=target["z"], **extra)
        return amount

    def apply_hits(self):
        # every hit collected this tick lands together, so contact trades damage both fighters on the same tick
        for h in self.hits:
            a, t = h["by"], h["to"]
            target = self.fighters[t]
            move = h["move"]
            self.stats["hits"][a] += 1
            if not offensive(move):
                self.emit(f"{target['name']}被{move.get('name')}命中", "hit", target["id"], source=self.fighters[a]["id"],
                          moveId=move.get("id"), projectileId=h.get("projectileId"), hazardId=h.get("hazardId"), x=h["x"], z=h["z"])
                self.move_effect(a, t, move, 0, hit=h)
                self.wake(t, 1)
                continue
            power = max(.3, (move.get("power") or 40) / 40) * h.get("scale", 1.)
            guarded = target["guardUntil"] > self.tick
            amount = self.damage(a, t, move["type"], power, move.get("id"), fixed=fixed_damage(move, self.fighters[a], target),
                                 delivery=h["kind"],
                                 projectileId=h.get("projectileId"), hazardId=h.get("hazardId"), hits=h.get("hits"), grappleId=h.get("grappleId"))
            ratio = amount / target["maxHp"]
            kb = (.1 + .5 * ratio) * (1.3 if h["kind"] == "melee" else 1.) * (.5 if guarded else 1.)
            if h.get("push"):
                kb = h["push"] * .3
            if h["kind"] == "channel":
                kb = .045  # a held jet shoves but does not stun-lock: the target keeps moving (V2 9.5–11.5 s)
            target["kbX"] = round(target["kbX"] + h["dirX"] * kb, 4)
            target["kbZ"] = round(target["kbZ"] + h["dirZ"] * kb, 4)
            if h["kind"] != "channel":
                stagger = int((3 + min(9, ratio * 40)) * (.5 if guarded else 1))
                target["stunUntil"] = max(target["stunUntil"], self.tick + stagger)
                target["dashUntil"] = min(target["dashUntil"], self.tick)
            c = target["cast"]
            if c and self.tick < c["active"] and not guarded and (ratio >= .06 or c["shape"] == "rest"):
                self.cancel_cast(t, "interrupt")
            elif c and c["shape"] == "channel" and self.tick < c["active"] + c["activeLen"] and not guarded and ratio >= .12:
                self.cancel_cast(t, "interrupt")
            self.move_effect(a, t, move, amount, hit=h)
            self.wake(t, 1)
        self.hits = []
        for side in self.selfko:
            me = self.fighters[side]
            me["hp"] = 0
            self.emit(f"{me['name']}发生了爆炸", "explode", me["id"], x=me["x"], z=me["z"])
        self.selfko = []

    def cancel_cast(self, side, why, quiet=False):
        me = self.fighters[side]
        c = me["cast"]
        if not c:
            return
        if self.grapple and self.grapple["side"] == side:
            self.end_grapple(why)
        for h in self.hazards + self.pending_hazards:
            if h["id"] == c.get("hazard"):
                self.end_hazard(h, why)
        self.hazards = [h for h in self.hazards if h["id"] != c.get("hazard")]
        self.pending_hazards = [h for h in self.pending_hazards if h["id"] != c.get("hazard")]
        self.emit("", "cancel", me["id"], moveId=c.get("moveId"), hazardId=c.get("hazard"), reason=why)
        me["cast"] = None
        me["hidden"] = False
        if quiet:
            return
        me["action"] = "被打断" if why == "interrupt" else "收招"
        if why != "cancel":  # the canonical cancel lifecycle event was already emitted above
            self.emit(f"{me['name']}的{c['name']}被打断了", why, me["id"], moveId=c.get("moveId"), hazardId=c.get("hazard"))

    def move_effect(self, side, other_side, move, damage, hit=None, self_cast=False):
        me, target = self.fighters[side], self.fighters[other_side]
        effect = move.get("effect") or ""
        if hit and hit.get("root"):
            target["rootUntil"] = max(target["rootUntil"], self.tick + int(hit["root"]))
        if effect == "splash_effect":
            self.emit("但是没有产生效果。", "status", me["id"], moveId=move.get("id"))
        elif "drain" in effect or effect == "dream_eater_effect":
            me["hp"] = min(me["maxHp"], round(me["hp"] + damage * .5, 2))
            self.emit(f"{me['name']}吸取了体力", "heal", me["id"], amount=round(damage * .5, 2), hpAfter=me["hp"], moveId=move.get("id"))
        elif effect in ("recoil_effect", "jump_kick_effect"):
            # Gen I Struggle: half damage, minimum one. Other recoil stays a
            # quarter. Float HP is the arena adaptation; misses/immune hits
            # with zero damage never manufacture recoil.
            recoil = max(1., round(damage * .5, 2)) if move.get("id") == 165 and damage > 0 else round(damage * .25, 2)
            me["hp"] = max(0, round(me["hp"] - recoil, 2))
            self.emit(f"{me['name']}受到了反作用力", "recoil", me["id"], amount=recoil, hpAfter=me["hp"], moveId=move.get("id"))
        elif effect == "heal_effect":
            before = me["hp"]
            me["hp"] = min(me["maxHp"], round(before + me["maxHp"] * .3, 2))
            healed = round(me["hp"] - before, 2)
            self.emit(f"{me['name']}恢复了体力" if healed else f"{me['name']}的体力已经充足", "heal", me["id"],
                      amount=healed, hpAfter=me["hp"], moveId=move.get("id"))
        elif effect == "explode_effect":
            pass  # handled geometrically: the burst resolves, then the user faints
        elif effect.startswith(("attack_", "defense_", "special_", "speed_")):
            key = effect.split("_")[0]
            up = "up" in effect
            receiver = me if up else target
            factor = 1.15 if up else .85
            before = receiver[key]
            if key == "speed":
                receiver["speed"] = round(clamp(receiver["speed"] * factor, .05, .2), 4)
            else:
                receiver[key] = max(.02, receiver[key] * factor)
            modifiers = receiver.setdefault("statModifiers", {})
            modifiers[key] = modifiers.get(key, 1.) * receiver[key] / max(.00001, before)
            if up:
                receiver["buffs"] = receiver.get("buffs", 0) + 1
            if move.get("category") == "status":
                label = {"attack": "攻击", "defense": "防御", "special": "特殊", "speed": "速度"}[key]
                self.emit(f"{receiver['name']}的{label}{'提高' if up else '降低'}了", "buff", receiver["id"],
                          stat=key, up=up, moveId=move.get("id"))
        elif effect == "accuracy_down1_effect":
            target["accuracyMultiplier"] = max(.4, target["accuracyMultiplier"] * .85)
            self.emit(f"{target['name']}的命中率降低了", "buff", target["id"], stat="accuracy", up=False, moveId=move.get("id"))
        elif effect == "evasion_up1_effect":
            me["evasionMultiplier"] = min(1.8, me["evasionMultiplier"] * 1.15)
            self.emit(f"{me['name']}的闪避率提高了", "buff", me["id"], stat="evasion", up=True, moveId=move.get("id"))
        elif effect in ("reflect_effect", "light_screen_effect", "mist_effect", "substitute_effect"):
            me["guardUntil"] = self.tick + 60
            self.emit(f"{me['name']}展开了防护", "buff", me["id"], stat="guard", up=True, moveId=move.get("id"))
        elif not self_cast and any(word in effect for word in ("burn", "poison", "paralyze", "freeze", "sleep", "confusion", "leech_seed")):
            chance = .2 if "side" in effect else 1
            if self.rng.random() < chance:
                status = "burn" if "burn" in effect else "poison" if "poison" in effect or "leech" in effect else \
                    "sleep" if "sleep" in effect else "paralysis" if "paralyze" in effect else "slow"
                if (status == "poison" and "poison" in target["types"]) or (status == "burn" and "fire" in target["types"]):
                    return
                target["status"] = status
                target["statusUntil"] = self.tick + (40 if status == "sleep" else 100)
                if status == "sleep":
                    self.cancel_cast(other_side, "interrupt") if target["cast"] else None
                self.emit(f"{target['name']}进入{STATUS_ZH[status]}状态", "status", target["id"], status=status, moveId=move.get("id"))
        elif not offensive(move):
            self.emit(f"{move.get('name', '这招')}的特殊效果尚未实现", "unsupportedEffect", me["id"],
                      moveId=move.get("id"), effect=effect)

    # ------------------------------------------------------------------ step
    def step(self, actions=None):
        """Advance one 20 Hz tick. `actions` = {side: tactic index} overrides the policy (learning/replay)."""
        if self.status != "active":
            return
        if self.grapple and any(f["hp"] <= 0 for f in self.fighters):
            self.end_grapple("ko", cancel_owner=True)
        for side, me in enumerate(self.fighters):
            c = me.get("cast")
            if me.get("captureMode") and c and offensive(c.get("move") or {}):
                foe = self.fighters[1 - side]
                ceiling = self.capture_damage_ceiling(side, c["move"])
                # A cast already paid its PP; having just spent its last PP is
                # not a reason to cancel an otherwise safe committed attack.
                safe = me["captureMode"] == "weaken" and foe["hp"] > foe["maxHp"] * .25 \
                    and me["hp"] > me["maxHp"] * .2 and ceiling is not None \
                    and foe["status"] not in ("burn", "poison") \
                    and ceiling < foe["hp"] - max(1., foe["maxHp"] * .05)
                if not safe:
                    self.stop_capture_attack(side)
            if me.get("activeCommand") and not self.current_command(side):
                self.finish_command(side, "expired")
            if me["hp"] > 0 and me["nextDecision"] <= self.tick:
                chosen = actions.get(side) if actions and side in actions else self.choose(side)
                self.set_tactic(side, chosen)
        plans = [self.plan(0), self.plan(1)]
        for side in (0, 1):
            self.execute(side, plans[side])
        self.hazards.extend(self.pending_hazards)
        self.pending_hazards = []
        for side in (0, 1):
            self.advance_cast(side)
        self.advance_grapple()
        self.integrate()
        self.follow_hazards()
        self.resolve_channels()
        self.step_projectiles()
        self.resolve_hazards()
        self.apply_hits()
        # History carries short-lived entities across slow polls; lifecycle events are exact.
        for h in self.hazards:
            if h["resolved"] or self.tick >= h["end"] - 1:
                self.end_hazard(h, "hit" if h.get("hit") else "expired")
        self.hazards = [h for h in self.hazards if self.tick < h["end"] + 2]
        for side, me in enumerate(self.fighters):
            c = me["cast"]
            if c and self.tick >= c["end"]:
                me["cast"] = None
                me["hidden"] = False
            if not me["cast"] and me["dashUntil"] <= self.tick and me["stunUntil"] <= self.tick:
                me["action"] = (COMMAND_LABELS[me["captureMode"]] if me.get("captureMode") else
                                TACTIC_ZH.get(me["tactic"], "观察对手")) if me["hp"] > 0 else "倒下"
            me["energy"] = min(100, round(me["energy"] + .4, 3))
            if me["status"] and me["statusUntil"] <= self.tick:
                me["status"] = None
            if me["status"] in ("burn", "poison") and self.tick % 20 == 0 and me["hp"] > 0:
                amount = round(max(1, me["maxHp"] * .025), 2)
                me["hp"] = max(0, round(me["hp"] - amount, 2))
                self.emit(f"{me['name']}受到{'灼伤' if me['status'] == 'burn' else '毒素'}伤害", "dot", me["id"],
                          status=me["status"], amount=amount, hpAfter=me["hp"])
        if self.grapple and any(f["hp"] <= 0 for f in self.fighters):
            self.end_grapple("ko", cancel_owner=True)
        self.remember_perception(self.tick)
        self.tick += 1
        self._event_boundary = self.tick
        if any(f["hp"] <= 0 for f in self.fighters) or self.tick >= self.max_ticks:
            self.end_grapple("battle_end", cancel_owner=True)
            ratios = [f["hp"] / f["maxHp"] for f in self.fighters]
            self.winner = None if abs(ratios[0] - ratios[1]) < .0001 else self.fighters[0 if ratios[0] > ratios[1] else 1]["id"]
            self.status = "finished"
            for f in self.fighters:
                if f["hp"] <= 0:
                    self.emit(f"{f['name']}倒下了", "ko", f["id"], x=f["x"], z=f["z"])
            if not any(f["hp"] <= 0 for f in self.fighters):
                self.emit("时间到！", "timeout")
            for p in self.projectiles:
                self.end_projectile(p, "battle_end")
            self.projectiles = []
            for h in self.hazards:
                self.end_hazard(h, "battle_end")
            self.clashes = {}
            # End every visual entity at this boundary before the final result sentinel.
            self.emit("对战结束：" + ("平局" if self.winner is None else next(f["name"] for f in self.fighters if f["id"] == self.winner) + "获胜"),
                      "result", winner=self.winner)
        self.capture_frame()
        del self._event_boundary

    def public_cast(self, c, at=None):
        if not c:
            return None
        at = max(0, self.tick - 1) if at is None else at
        out = {k: copy.deepcopy(v) for k, v in c.items() if k not in ("mech", "move", "name", "threat")}
        out["moveType"] = (c.get("move") or {}).get("type")
        out["phase"] = "windup" if at < c["active"] else "active" if at < c["active"] + c["activeLen"] else "recovery"
        out.update(startTick=c["start"] + 1, activeTick=c["active"] + 1, endTick=c["end"] + 1)
        return out

    def public_projectile(self, p):
        left = max(0., p["maxRange"] - p["traveled"])
        return {"id": p["id"], "side": p["side"], "moveId": p["moveId"], "type": p["type"],
                "x": p["x"], "z": p["z"], "vx": p["vx"], "vz": p["vz"], "radius": p["radius"],
                "speed": p["speed"], "born": p["born"], "ttl": max(0, math.ceil(left / p["speed"])),
                "targetX": round(p["x"] + p["vx"] / p["speed"] * left, 3),
                "targetZ": round(p["z"] + p["vz"] / p["speed"] * left, 3)}

    def public_hazard(self, h):
        out = {k: copy.deepcopy(v) for k, v in h.items() if k != "threat" and not k.startswith("_")}
        reach = h.get("reach", 0.) if h["kind"] == "channel" else h.get("length", h.get("reach", 0.))
        if h["kind"] == "channel":
            clash = self.clashes.get(h.get("clash"))
            if clash and h["id"] in (clash["a"], clash["b"]):
                # A newly formed clash already suppresses both jets' pulses,
                # before the next physics tick shortens their stored reach.
                # Publish that authoritative contact boundary immediately,
                # without mutating the simulation or bending/extending a jet.
                dx, dz = h["dirX"], h["dirZ"]
                along = ((clash["x"] - h["x"]) * dx + (clash["z"] - h["z"]) * dz) / max(1e-9, dx*dx + dz*dz)
                reach = min(reach, max(0., along))
                out["reach"] = reach
        out.update(fromX=h["x"], fromZ=h["z"], endX=round(h["x"] + h.get("dirX", 0) * reach, 4),
                   endZ=round(h["z"] + h.get("dirZ", 0) * reach, 4),
                   startTick=h["created"] + 1, activeTick=h["active"] + 1, endTick=h["end"] + 1)
        return out

    def hazard_started(self, h):
        self.emit("", "hazardStart", self.fighters[h["side"]]["id"], hazardId=h["id"], moveId=h["moveId"],
                  geometry=self.public_hazard(h), startTick=h["created"] + 1, activeTick=h["active"] + 1, endTick=h["end"] + 1)

    def end_hazard(self, h, reason):
        if h.get("_endReason"):
            return
        h["_endReason"] = reason
        self.emit("", "hazardEnd", self.fighters[h["side"]]["id"], hazardId=h["id"], moveId=h["moveId"],
                  reason=reason, x=h["x"], z=h["z"])

    def compact_frame(self):
        fields = ("id", "speciesId", "x", "z", "vx", "vz", "facingX", "facingZ", "hp", "maxHp",
                  "radius", "hidden", "status", "guardUntil", "dashUntil", "energy", "captureMode", "grapple")
        fighters = []
        for f in self.fighters:
            out = {key: copy.deepcopy(f[key]) for key in fields}
            out["moves"] = [{key: move[key] for key in ("id", "pp", "remainingPp")} for move in f["moves"]]
            out["cast"] = self.public_cast(f["cast"])
            out["phase"] = "hidden" if f["hidden"] else out["cast"]["phase"] if out["cast"] else \
                "move" if abs(f["vx"]) + abs(f["vz"]) > .001 else "idle"
            fighters.append(out)
        return {"tick": self.tick, "fighters": fighters,
                "projectiles": [self.public_projectile(p) for p in self.projectiles],
                "hazards": [self.public_hazard(h) for h in self.hazards if not h.get("_endReason")],
                "clashes": copy.deepcopy(list(self.clashes.values())), "obstacles": copy.deepcopy(self.obstacles)}

    def capture_frame(self):
        if self.record:
            self.frames.append(self.compact_frame())
            self.frames = self.frames[-24:]

    # ----------------------------------------------------------- persistence
    def export(self):
        return {"engineVersion": ENGINE_VERSION, "ruleset": RULESET, "fighters": self.fighters, "rng": self.rng.state,
                "tick": self.tick, "maxTicks": self.max_ticks, "events": self.events, "projectiles": self.projectiles,
                "hazards": self.hazards, "obstacles": self.obstacles, "serial": self.serial, "decisions": self.decisions,
                "status": self.status, "winner": self.winner, "outcome": self.outcome, "externalInputs": self.external_inputs, "stats": self.stats,
                "clashes": self.clashes, "grapple": self.grapple, "eventSeq": self.event_seq, "frames": self.frames,
                "perception": self.perception}

    @classmethod
    def restore(cls, data):
        data = copy.deepcopy(data)  # never alias the caller's saved lists (the old restore did)
        if data.get("engineVersion", 1) < ENGINE_VERSION:
            if data.get("engineVersion", 1) == 8:
                from . import combat_v8
                return combat_v8.Arena.restore(data)
            if data.get("engineVersion", 1) == 7:
                from . import combat_v7
                return combat_v7.Arena.restore(data)
            if data.get("engineVersion", 1) == 6:
                from . import combat_v6
                return combat_v6.Arena.restore(data)
            if data.get("engineVersion", 1) == 5:
                from . import combat_v5
                return combat_v5.Arena.restore(data)
            if data.get("engineVersion", 1) == 4:
                from . import combat_v4
                return combat_v4.Arena.restore(data)
            if data.get("engineVersion", 1) == 3:
                from . import combat_v3
                return combat_v3.Arena.restore(data)
            # Saved before the v3 rework: finish it under the rules it started with.
            from . import combat_legacy
            return combat_legacy.Arena.restore(data)
        obj = cls(data["fighters"], data["rng"], data.get("maxTicks", MAX_TICKS), obstacles=data.get("obstacles"), jitter=False)
        obj.rng.state = data["rng"]
        obj.tick = data["tick"]; obj.events = data["events"]; obj.projectiles = data.get("projectiles", [])
        obj.event_seq = data.get("eventSeq", max((e.get("eventSeq", 0) for e in obj.events), default=0))
        obj.frames = copy.deepcopy(data.get("frames", []))
        obj.perception = data.get("perception", obj.perception)
        obj.hazards = data.get("hazards", []); obj.serial = data.get("serial", 0)
        obj.decisions = data.get("decisions", []); obj.status = data["status"]; obj.winner = data.get("winner")
        obj.outcome = data.get("outcome")
        obj.external_inputs = data.get("externalInputs", [])
        obj.stats = data.get("stats", obj.stats)
        obj.clashes = data.get("clashes", {})
        obj.grapple = data.get("grapple")
        return obj

    def checksum(self):
        state = {"fighters": self.fighters, "tick": self.tick, "rng": self.rng.state, "projectiles": self.projectiles,
                 "hazards": self.hazards, "obstacles": self.obstacles, "clashes": self.clashes, "grapple": self.grapple,
                 "status": self.status, "winner": self.winner, "outcome": self.outcome,
                 "perception": self.perception}
        return hashlib.sha256(json.dumps(state, sort_keys=True, separators=(",", ":")).encode()).hexdigest()

    @classmethod
    def replay(cls, initial, actions, inputs, until_tick):
        if initial.get("engineVersion", 1) < ENGINE_VERSION:
            if initial.get("engineVersion", 1) == 8:
                from . import combat_v8
                return combat_v8.Arena.replay(initial, actions, inputs, until_tick)
            if initial.get("engineVersion", 1) == 7:
                from . import combat_v7
                return combat_v7.Arena.replay(initial, actions, inputs, until_tick)
            if initial.get("engineVersion", 1) == 6:
                from . import combat_v6
                return combat_v6.Arena.replay(initial, actions, inputs, until_tick)
            if initial.get("engineVersion", 1) == 5:
                from . import combat_v5
                return combat_v5.Arena.replay(initial, actions, inputs, until_tick)
            if initial.get("engineVersion", 1) == 4:
                from . import combat_v4
                return combat_v4.Arena.replay(initial, actions, inputs, until_tick)
            if initial.get("engineVersion", 1) == 3:
                from . import combat_v3
                return combat_v3.Arena.replay(initial, actions, inputs, until_tick)
            from . import combat_legacy
            return combat_legacy.Arena.replay(initial, actions, inputs, until_tick)
        arena = cls.restore(copy.deepcopy(initial))
        decisions = {}
        for item in actions:
            decisions.setdefault(item["tick"], {})[item["side"]] = item["action"]
        external = {}
        for item in inputs:
            external.setdefault(item["tick"], []).append(item)

        def apply_inputs():
            for item in external.get(arena.tick, []):
                if item.get("type") == "capture":
                    arena.finish_capture(item["side"])
                    continue
                if item.get("type") == "command":
                    arena.request_command(item["side"], item["command"], item.get("moveId"))
                    continue
                arena.rng.state = item["rngState"]
                me = arena.fighters[item["side"]]
                if item["adopted"]:
                    me["intent"] = item["intent"]
                    me["intentUntil"] = item["intentUntil"]

        while arena.tick < until_tick and arena.status == "active":
            apply_inputs()
            arena.step(decisions.get(arena.tick))
        # A command is persisted between ticks. Reproduce an accepted command
        # even when the replay ends at that exact boundary before the next step.
        if arena.tick == until_tick and arena.status == "active":
            apply_inputs()
        return arena

    def snapshot(self, battle_id):
        fighters = []
        for side, f in enumerate(self.fighters):
            out = {k: v for k, v in f.items() if k not in PRIVATE}
            out["activeCommand"] = copy.deepcopy(self.current_command(side)) if self.status == "active" else None
            out["commandOptions"] = self.command_options(side)
            out["commandCooldownMs"] = max(0, f.get("nextCommandTick", 0) - self.tick) * 1000 // TICK_RATE
            if f["cast"]:
                out["cast"] = self.public_cast(f["cast"])
            fighters.append(out)
        projectiles = []
        for p in self.projectiles:
            left = max(0., p["maxRange"] - p["traveled"])
            projectiles.append({"id": p["id"], "side": p["side"], "moveId": p["moveId"], "type": p["type"],
                                "x": p["x"], "z": p["z"], "vx": p["vx"], "vz": p["vz"], "radius": p["radius"],
                                "born": p["born"], "ttl": int(left / p["speed"]),
                                "targetX": round(p["x"] + p["vx"] / p["speed"] * left, 3),
                                "targetZ": round(p["z"] + p["vz"] / p["speed"] * left, 3),
                                "move": {"id": p["move"].get("id"), "name": p["move"].get("name"), "type": p["type"]}})
        hazards = [self.public_hazard(h) for h in self.hazards if not h.get("_endReason")]
        return {"id": battle_id, "status": self.status, "tick": self.tick,
                "timeLeft": max(0, round((self.max_ticks - self.tick) / TICK_RATE, 1)), "winner": self.winner, "outcome": self.outcome,
                "fighters": fighters, "events": self.events[-160:], "projectiles": projectiles,
                "eventSeq": self.event_seq, "frames": copy.deepcopy(self.frames),
                "frameBoundary": "tick n is state after n completed steps; event effectiveTick aligns to this boundary",
                "hazards": hazards, "obstacles": self.obstacles, "clashes": list(self.clashes.values()), "stats": self.stats,
                "ruleset": RULESET, "engineVersion": ENGINE_VERSION, "tickRate": TICK_RATE,
                "bounds": {"x": BOUND_X, "z": BOUND_Z},
                "aiAlgorithm": "innate nature priors + tabular-q-learning tactics + geometric threat-aware steering",
                "moveEffectCoverage": "Gen I names/types/PP/learnsets and chart; realtime shapes/timing adapted in move-mechanics.json, several special effects not yet modeled"}
