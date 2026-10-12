"""Isolated, in-memory Gamma visual demo using the unmodified live combat engine.

Run from the repository root with server/.venv/bin/python demos/gamma-battle/server.py.
This module deliberately does not import server.app, server.db, or any save system.
"""
from __future__ import annotations

import asyncio
import contextlib
import math
from pathlib import Path
import sys
import time
import uuid
import hashlib
import importlib.util
from collections import deque
from functools import lru_cache

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) in sys.path:
    sys.path.remove(str(ROOT))
# This file is also named server.py; the repository package must win resolution.
sys.path.insert(0, str(ROOT))

from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import JSONResponse, FileResponse
from fastapi.exceptions import RequestValidationError
from pydantic import BaseModel, ConfigDict, Field
from typing import Literal

from server.combat import (Arena, COMMAND_COOLDOWN_TICKS, COMMAND_TICKS,
                           ENGINE_VERSION, RULESET, TICK_RATE, fighter, layout, seed_int)
from server.content import Content

field_spec = importlib.util.spec_from_file_location("gamma_demo_field", Path(__file__).with_name("field.py"))
field_module = importlib.util.module_from_spec(field_spec)
sys.modules[field_spec.name] = field_module
field_spec.loader.exec_module(field_module)
FieldInput, FieldPoint, FieldArena = field_module.FieldInput, field_module.FieldPoint, field_module.FieldArena

SOURCE = "authoritative-live-memory"
MAX_BATTLES = 16
FINISHED_RETENTION_SECONDS = 600
THEMES = Literal["grass", "dirt", "stone", "water", "rocks", "crystal", "lava", "neon"]


class Input(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)


class MovePpInput(Input):
    moveId: int = Field(strict=True, ge=1, le=165)
    remainingPp: int = Field(strict=True, ge=0)


class PlayerStateInput(Input):
    hp: float = Field(strict=True, gt=0)
    movePp: list[MovePpInput] = Field(min_length=1, max_length=4)


class BattleInput(Input):
    playerSpeciesId: int = Field(default=4, strict=True, ge=1, le=151)
    opponentSpeciesId: int = Field(default=25, strict=True, ge=1, le=151)
    level: int = Field(default=35, strict=True, ge=1, le=100)
    theme: THEMES = "grass"
    seed: int | None = Field(default=None, strict=True, ge=1, le=4294967295)
    playerState: PlayerStateInput | None = None
    encounterId: str | None = Field(default=None, min_length=1, max_length=96)
    bridgeSessionId: str | None = Field(default=None, pattern=r"^[a-zA-Z0-9_-]{16,96}$")
    field: FieldInput | None = None


class CommandInput(Input):
    command: Literal["attack", "dodge", "defend", "retreat", "move", "weaken", "hold", "navigate"]
    moveId: int | None = Field(default=None, strict=True, ge=1, le=165)
    target: FieldPoint | None = None


class Runtime:
    def __init__(self, clock=time.monotonic, max_battles=MAX_BATTLES):
        self.clock = clock
        self.content = Content()
        self.battles = {}
        self.max_battles = max_battles
        self.retired_sessions = deque(maxlen=256)

    def retire(self, battle):
        if battle.get("bridgeSessionId"):
            self.retired_sessions.append(battle["bridgeSessionId"])
        del self.battles[battle["id"]]

    def advance(self, battle, now=None):
        """Follow monotonic elapsed time, including when no client is polling."""
        now = self.clock() if now is None else now
        arena = battle["engine"]
        wanted_tick = math.floor(max(0, now - battle["started"]) * TICK_RATE + 1e-8)
        while arena.status == "active" and arena.tick < wanted_tick:
            arena.step()
        if arena.status != "active" and battle["finished"] is None:
            battle["finished"] = now

    def collect(self):
        now = self.clock()
        for battle in list(self.battles.values()):
            self.advance(battle, now)
            if battle["finished"] is not None and now - battle["finished"] >= FINISHED_RETENTION_SECONDS:
                self.retire(battle)

    def create(self, body):
        self.collect()
        if (body.encounterId is None) != (body.bridgeSessionId is None):
            raise HTTPException(422, "探索遭遇与桥接会话必须同时提供。")
        request = body.model_dump()
        if body.bridgeSessionId:
            existing = next((b for b in self.battles.values()
                             if b.get("bridgeSessionId") == body.bridgeSessionId), None)
            if existing:
                if existing["request"] != request:
                    raise HTTPException(409, "此探索会话已绑定其他对局参数。")
                return self.snapshot(existing)
            if body.bridgeSessionId in self.retired_sessions:
                raise HTTPException(410, "此探索战斗已清理，请返回世界重新确认伙伴状态。")
        ident = uuid.uuid4().hex
        seed = body.seed or seed_int(ident)
        # Stable fighter IDs make the same seed/options reproducible across sessions.
        models = [fighter(self.content.species_at(species_id), {
            "id": "player" if side == 0 else "opponent", "speciesId": species_id,
            "level": body.level, "style": "balanced", "bond": 20,
            "policyVersion": 0, "policy": {},
        }, side) for side, species_id in enumerate((body.playerSpeciesId, body.opponentSpeciesId))]
        if body.playerState is not None:
            me, state = models[0], body.playerState
            if state.hp > me["maxHp"]:
                raise HTTPException(422, "伙伴体力超过当前等级的最大体力。")
            supplied = {row.moveId: row.remainingPp for row in state.movePp}
            legal = {move["id"]: move for move in me["moves"]}
            if len(supplied) != len(state.movePp) or set(supplied) != set(legal):
                raise HTTPException(422, "探索 PP 必须完整且不重复地对应伙伴当前合法配招。")
            if any(pp > legal[move_id]["pp"] for move_id, pp in supplied.items()):
                raise HTTPException(422, "探索 PP 超过招式的最大 PP。")
            me["hp"] = state.hp
            for move in me["moves"]:
                move["remainingPp"] = supplied[move["id"]]
        # Validate native spawn/terrain before evicting or allocating a session.
        try:
            arena = FieldArena(models, body.field, seed) if body.field is not None else Arena(models, seed, obstacles=layout(body.theme, seed))
        except ValueError as exc:
            raise HTTPException(422, str(exc)) from exc
        # Invalid carried state must not evict a valid finished encounter.
        while len(self.battles) >= self.max_battles:
            completed = [b for b in self.battles.values() if b["finished"] is not None]
            if not completed:
                raise HTTPException(429, "演示对局已达上限，请等待现有对局结束后重试。")
            oldest = min(completed, key=lambda b: b["finished"])
            self.retire(oldest)
        arena.emit("双方准备完毕，精灵开始自主战斗。训练家可以使用固定战术与招式指令。", "start")
        battle = {"id": ident, "seed": seed, "theme": body.theme, "started": self.clock(),
                  "finished": None, "engine": arena, "request": request,
                  "encounterId": body.encounterId, "bridgeSessionId": body.bridgeSessionId}
        self.battles[ident] = battle
        return self.snapshot(battle)

    def get(self, ident):
        battle = self.battles.get(ident)
        if battle is None:
            raise HTTPException(404, "演示对局不存在或已清理，请开始新对局。")
        self.advance(battle)
        return battle

    def snapshot(self, battle):
        self.advance(battle)
        result = battle["engine"].snapshot(battle["id"])
        # Match the normal API's capture eligibility without inventing a capture mode.
        result["capture"] = None
        for model in result["fighters"]:
            for option in model.get("commandOptions", []):
                if option["command"] in ("weaken", "hold"):
                    option.update(disabled=True, reason="此独立演示不包含野生捕捉。")
        result.update(playerId="player", opponentId="opponent", source=SOURCE,
                      seed=battle["seed"], arena={"theme": battle["theme"], "seed": battle["seed"]},
                      persisted=False, playerSpeciesId=result["fighters"][0]["speciesId"],
                      opponentSpeciesId=result["fighters"][1]["speciesId"],
                      encounterId=battle["encounterId"], bridgeSessionId=battle["bridgeSessionId"])
        return result

    def command(self, ident, body):
        battle = self.get(ident)
        arena = battle["engine"]
        if arena.status != "active":
            raise HTTPException(409, "这场对战已经结束。")
        if body.command in ("weaken", "hold"):
            raise HTTPException(409, "此独立演示不包含野生捕捉。")
        if body.command == "navigate":
            if not isinstance(arena, FieldArena):
                raise HTTPException(409, "目标走位仅用于原地图内的对战。")
            if body.target is None or body.moveId is not None:
                raise HTTPException(422, "目标走位需要 target，不能同时指定招式。")
            error = arena.navigation_error(0, body.target.model_dump())
        else:
            if body.target is not None:
                raise HTTPException(422, "只有目标走位可以指定 target。")
            error = arena.command_error(0, body.command, body.moveId)
        # The same validation and command queue as server/app.py; only persistence is omitted.
        if error:
            raise HTTPException(400, error)
        remaining = arena.fighters[0].get("nextCommandTick", 0) - arena.tick
        if remaining > 0:
            raise HTTPException(429, "指令冷却中，请稍候再试。",
                                headers={"Retry-After": str(math.ceil(remaining / TICK_RATE))})
        response = arena.request_navigation(0, body.target.model_dump()) if body.command == "navigate" else arena.request_command(0, body.command, body.moveId)
        return {**response, "snapshot": self.snapshot(battle)}

    async def loop(self):
        while True:
            self.collect()
            await asyncio.sleep(1 / TICK_RATE)


ASSET_ROOT = ROOT / '.runtime' / 'gamma-emerald'

@lru_cache(maxsize=1)
def asset_catalog():
    # Enumerate only exported game media; never expose arbitrary workspace files.
    entries = []
    for directory, suffix, kind in [('png', '.png', 'texture'), ('audio-wav', '.wav', 'audio'), ('fonts-all', '.ttf', 'font')]:
        base = ASSET_ROOT / directory
        if not base.is_dir():
            continue
        for path in sorted(base.rglob('*' + suffix)):
            if not path.resolve().is_relative_to(base.resolve()):
                continue
            relative = path.relative_to(ASSET_ROOT).as_posix()
            ident = hashlib.sha256(relative.encode()).hexdigest()[:24]
            entries.append({'id': ident, 'name': path.stem, 'path': relative, 'kind': kind,
                            'bytes': path.stat().st_size, 'url': '/api/gamma/assets/file/' + ident})
    return entries, {entry['id']: entry for entry in entries}


def create_app(clock=time.monotonic, max_battles=MAX_BATTLES):
    @contextlib.asynccontextmanager
    async def lifespan(app):
        app.state.gamma = Runtime(clock, max_battles)
        task = asyncio.create_task(app.state.gamma.loop())
        yield
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await task

    app = FastAPI(title="Gamma isolated live battle demo", lifespan=lifespan)

    @app.exception_handler(RequestValidationError)
    async def invalid_input(request, exc):
        fields = ", ".join(".".join(map(str, error["loc"][1:])) for error in exc.errors())
        return JSONResponse(status_code=422, content={"detail": "请求参数无效：" + fields})

    @app.get("/api/gamma/health")
    async def health():
        rt = app.state.gamma
        rt.collect()
        return {"ok": True, "source": SOURCE, "engineVersion": ENGINE_VERSION,
                "ruleset": RULESET, "tickRate": TICK_RATE, "persisted": False,
                "activeBattles": sum(b["engine"].status == "active" for b in rt.battles.values()),
                "maxBattles": rt.max_battles, "commandCooldownMs": COMMAND_COOLDOWN_TICKS * 1000 // TICK_RATE,
                "commandDurationMs": COMMAND_TICKS * 1000 // TICK_RATE}

    @app.post("/api/gamma/battles")
    async def create_battle(body: BattleInput):
        return app.state.gamma.create(body)

    @app.get("/api/gamma/battles/{battle_id}")
    async def get_battle(battle_id: str):
        return app.state.gamma.snapshot(app.state.gamma.get(battle_id))

    @app.post("/api/gamma/battles/{battle_id}/command")
    async def command(battle_id: str, body: CommandInput):
        return app.state.gamma.command(battle_id, body)

    @app.get('/api/gamma/assets')
    def assets(q: str = Query('', max_length=160), kind: Literal['all', 'texture', 'audio', 'font'] = 'all',
               offset: int = Query(0, ge=0), limit: int = Query(60, ge=1, le=120)):
        catalog, _ = asset_catalog()
        terms = q.casefold().split()
        filtered = [entry for entry in catalog if (kind == 'all' or entry['kind'] == kind)
                    and all(term in entry['path'].casefold() for term in terms)]
        return {'total': len(filtered), 'all': len(catalog), 'offset': offset,
                'counts': {k: sum(e['kind'] == k for e in catalog) for k in ['texture', 'audio', 'font']},
                'items': filtered[offset:offset + limit]}

    @app.get('/api/gamma/assets/file/{asset_id}')
    def asset_file(asset_id: str):
        _, index = asset_catalog()
        entry = index.get(asset_id)
        if entry is None:
            raise HTTPException(404, '素材不存在。')
        path = (ASSET_ROOT / entry['path']).resolve()
        if not path.is_relative_to(ASSET_ROOT.resolve()) or not path.is_file():
            raise HTTPException(404, '素材不存在。')
        return FileResponse(path, headers={'Cache-Control': 'public, max-age=86400'})

    return app


app = create_app()

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=8791, workers=1)
