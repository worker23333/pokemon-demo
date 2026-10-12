"""Local-map geometry adapter. All attacks, AI planning, PP and damage are Arena's.

The client supplies sampled native-map geometry, not an authoritative UE runtime.
This isolated demo validates its bounds and traversability, never invents a layout.
"""
from __future__ import annotations

import copy
import heapq
import math
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator
from server.combat import (Arena, BODY, BOUND_X, BOUND_Z, COMMAND_COOLDOWN_TICKS,
                           COMMAND_TICKS, TICK_RATE, seg_dist)

MAX_STEP = .48


class GeometryInput(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)


class FieldPoint(GeometryInput):
    x: float = Field(strict=True, ge=-10000000, le=10000000)
    z: float = Field(strict=True, ge=-10000000, le=10000000)


class FieldObstacle(GeometryInput):
    id: str = Field(min_length=1, max_length=240)
    x: float = Field(strict=True, ge=-16, le=16)
    z: float = Field(strict=True, ge=-14, le=14)
    radius: float = Field(strict=True, ge=.03, le=8)
    hp: float | None = Field(default=None, strict=True, gt=0, le=10000)
    solid: bool = Field(strict=True)
    kind: str = Field(min_length=1, max_length=64)

    @model_validator(mode="after")
    def check_obstacle(self):
        if not self.solid and self.hp is None:
            raise ValueError("可破坏掩体必须提供 HP。")
        if math.hypot(max(0, abs(self.x)-BOUND_X), max(0, abs(self.z)-BOUND_Z)) > self.radius:
            raise ValueError("掩体必须与遭遇范围相交。")
        return self


class FieldTerrain(GeometryInput):
    cellSize: float = Field(strict=True, ge=.1, le=1)
    cols: int = Field(strict=True, ge=2, le=161)
    rows: int = Field(strict=True, ge=2, le=121)
    x0: float = Field(strict=True, ge=-9, le=-BOUND_X)
    z0: float = Field(strict=True, ge=-7, le=-BOUND_Z)
    heights: list[Annotated[float, Field(strict=True)] | None] = Field(min_length=4, max_length=19481)
    maxStep: Literal[.48] = .48

    @model_validator(mode="after")
    def check_grid(self):
        if len(self.heights) != self.cols*self.rows:
            raise ValueError("地形采样数量不匹配。")
        if any(v is not None and (not math.isfinite(v) or abs(v)>10000) for v in self.heights):
            raise ValueError("地表高度无效。")
        if self.x0+(self.cols-1)*self.cellSize < BOUND_X-1e-8 or self.z0+(self.rows-1)*self.cellSize < BOUND_Z-1e-8:
            raise ValueError("地形必须覆盖原引擎的 ±7 × ±5 米范围。")
        if (self.cols-1)*self.cellSize>18 or (self.rows-1)*self.cellSize>14:
            raise ValueError("地形采样范围过大。")
        return self


class FieldInput(GeometryInput):
    mapId: str = Field(min_length=1, max_length=160)
    origin: FieldPoint
    playerStart: FieldPoint
    opponentStart: FieldPoint
    obstacles: list[FieldObstacle] = Field(default_factory=list, max_length=256)
    terrain: FieldTerrain

    @model_validator(mode="after")
    def unique_obstacles(self):
        if len({o.id for o in self.obstacles}) != len(self.obstacles):
            raise ValueError("原地图障碍 ID 不得重复。")
        return self


class FieldArena(Arena):
    """Keep Arena's combat; constrain only the supplied field's ground and cover."""

    def __init__(self, fighters, field, seed=1, **kwargs):
        self.field = field.model_dump() if isinstance(field, FieldInput) else FieldInput.model_validate(field).model_dump()
        self.destroyed = []
        self._terrain_cache = {}
        self._routes = {}
        self._obstacle_revision = 0
        self.obstacles = copy.deepcopy(self.field["obstacles"])
        models = copy.deepcopy(fighters)
        for model, key in zip(models, ("playerStart", "opponentStart")):
            point = self.field[key]
            if not self.can_stand(point["x"], point["z"], model["radius"]):
                raise ValueError(f"{key} 不在可站立的原地图地表，不能生成战斗角色。")
            model.update(x=point["x"], z=point["z"], vx=0., vz=0., groundY=self.height_at(point["x"], point["z"]))
        if math.hypot(models[0]["x"]-models[1]["x"], models[0]["z"]-models[1]["z"]) < models[0]["radius"]+models[1]["radius"]:
            raise ValueError("双方生成点不得重叠。")
        super().__init__(models, seed, obstacles=self.obstacles, jitter=False, **kwargs)
        a,b=self.fighters
        if self.find_path((a["x"],a["z"]),(b["x"],b["z"]),max(a["radius"],b["radius"])) is None:
            raise ValueError("双方生成点之间没有可通行的原地图路径。")

    def height_at(self, x, z):
        t=self.field["terrain"];s=t["cellSize"]
        gx,gz=(x-t["x0"])/s,(z-t["z0"])/s
        if gx<0 or gz<0 or gx>t["cols"]-1 or gz>t["rows"]-1:return None
        col,row=min(t["cols"]-2,int(gx)),min(t["rows"]-2,int(gz))
        fx,fz=gx-col,gz-row;i=row*t["cols"]+col
        h=[t["heights"][n] for n in (i,i+1,i+t["cols"],i+t["cols"]+1)]
        if any(v is None for v in h) or max(h)-min(h)>MAX_STEP+1e-8:return None
        return (h[0]*(1-fx)+h[1]*fx)*(1-fz)+(h[2]*(1-fx)+h[3]*fx)*fz

    def ground_stand(self,x,z,radius=BODY):
        if abs(x)>BOUND_X-radius+1e-8 or abs(z)>BOUND_Z-radius+1e-8:return False
        h=self.height_at(x,z)
        if h is None:return False
        for n in range(8):
            angle=n*math.pi/4;edge=self.height_at(x+math.cos(angle)*radius,z+math.sin(angle)*radius)
            if edge is None or abs(edge-h)>MAX_STEP+1e-8:return False
        return True

    def can_stand(self,x,z,radius=BODY):
        return self.ground_stand(x,z,radius) and not any(math.hypot(x-o["x"],z-o["z"])<o["radius"]+radius-1e-7 for o in self.obstacles)

    def can_travel(self,start,end,radius=BODY):
        if any(seg_dist(*start,*end,o["x"],o["z"])<o["radius"]+radius-1e-7 for o in self.obstacles):return False
        distance=math.dist(start,end);steps=max(1,math.ceil(distance/min(.1,self.field["terrain"]["cellSize"]*.5)))
        old=self.height_at(*start)
        if old is None:return False
        for n in range(1,steps+1):
            x=start[0]+(end[0]-start[0])*n/steps;z=start[1]+(end[1]-start[1])*n/steps
            y=self.height_at(x,z)
            if y is None or abs(y-old)>MAX_STEP+1e-8 or not self.ground_stand(x,z,radius):return False
            old=y
        return True

    def find_path(self,start,target,radius=BODY):
        if not self.can_stand(*target,radius):return None
        if self.can_travel(start,target,radius):return [target]
        t=self.field["terrain"];s=t["cellSize"]
        def point(node):return(t["x0"]+node[0]*s,t["z0"]+node[1]*s)
        def legal(node):
            if not (0<=node[0]<t["cols"] and 0<=node[1]<t["rows"]):return False
            key=(*node,radius)
            if key not in self._terrain_cache:self._terrain_cache[key]=self.ground_stand(*point(node),radius)
            return self._terrain_cache[key] and not any(math.dist(point(node),(o["x"],o["z"]))<o["radius"]+radius-1e-7 for o in self.obstacles)
        def anchor(position):
            c=round((position[0]-t["x0"])/s);r=round((position[1]-t["z0"])/s)
            options=sorted(((c+dx,r+dz) for dx in range(-2,3) for dz in range(-2,3)),key=lambda n:math.dist(point(n),position))
            return next((n for n in options if legal(n) and self.can_travel(position,point(n),radius)),None)
        first,last=anchor(start),anchor(target)
        if first is None or last is None:return None
        queue=[(math.dist(point(first),target),0.,first)];costs={first:0.};parents={}
        while queue:
            _,cost,node=heapq.heappop(queue)
            if cost>costs[node]+1e-8:continue
            if node==last:
                route=[target,point(node)]
                while node!=first:node=parents[node];route.append(point(node))
                return list(reversed(route))
            for dx,dz in ((1,0),(-1,0),(0,1),(0,-1),(1,1),(1,-1),(-1,1),(-1,-1)):
                other=(node[0]+dx,node[1]+dz)
                new=cost+s*math.hypot(dx,dz)
                if new>=costs.get(other,math.inf)-1e-8 or not legal(other):continue
                if not self.can_travel(point(node),point(other),radius):continue
                costs[other]=new;parents[other]=node
                heapq.heappush(queue,(new+math.dist(point(other),target),new,other))
        return None

    def navigation_error(self,side,target):
        me=self.fighters[side]
        if self.status!="active" or me["hp"]<=0:return "这只精灵当前不能接受指令。"
        route=self.find_path((me["x"],me["z"]),(target["x"],target["z"]),me["radius"])
        return "目标不在可达的原地图地表。" if route is None else None

    def request_navigation(self,side,target):
        error=self.navigation_error(side,target)
        if error:raise ValueError(error)
        me=self.fighters[side]
        active={"command":"navigate","target":dict(target),"expiresTick":self.tick+COMMAND_TICKS}
        me["activeCommand"]=active;me["captureMode"]=None;me["nextCommandTick"]=self.tick+COMMAND_COOLDOWN_TICKS
        me["nextDecision"]=self.tick;me["intent"]=None;me["intentUntil"]=0
        self._routes[side] = (self._obstacle_revision,self.find_path((me["x"],me["z"]),(target["x"],target["z"]),me["radius"]))
        self.external_inputs.append({"type":"command","tick":self.tick,"side":side,**active})
        message=f"{me['name']}收到指令：前往指定位置。"
        self.emit(message,"command",me["id"],**active)
        return dict(active,accepted=True,message=message,cooldownMs=COMMAND_COOLDOWN_TICKS*1000//TICK_RATE)

    def steer(self,side,threats):
        direction,score=super().steer(side,threats)
        me=self.fighters[side];start=(me["x"],me["z"]);radius=me["radius"]
        command=self.current_command(side)
        if command and command["command"]=="navigate":
            target=(command["target"]["x"],command["target"]["z"])
            if math.dist(start,target)<=.12:
                self.finish_command(side,"executed");direction=(0.,0.)
            else:
                revision,route=self._routes.get(side,(-1,None))
                if revision!=self._obstacle_revision or not route or not self.can_travel(start,route[0],radius):
                    route=self.find_path(start,target,radius);self._routes[side]=(self._obstacle_revision,route)
                if route:
                    while len(route)>1 and math.dist(start,route[0])<=.15:route.pop(0)
                    while len(route)>1 and self.can_travel(start,route[1],radius):route.pop(0)
                    d=math.dist(start,route[0]);direction=((route[0][0]-start[0])/d,(route[0][1]-start[1])/d) if d>.001 else (0.,0.)
                else:direction=(0.,0.)
        distance=max(.15,self.move_speed(me)*4)
        end=(start[0]+direction[0]*distance,start[1]+direction[1]*distance)
        if not self.can_travel(start,end,radius):
            # Preserve Arena's desired direction and danger evaluation, rejecting
            # only directions that leave this map's traversable ground.
            candidates=[(0.,0.)]+[(math.cos(k*math.pi/6),math.sin(k*math.pi/6)) for k in range(12)]
            safe=[v for v in candidates if self.can_travel(start,(start[0]+v[0]*distance,start[1]+v[1]*distance),radius)]
            direction=max(safe,key=lambda v:v[0]*direction[0]+v[1]*direction[1]-self.danger_at(side,v[0]*self.move_speed(me),v[1]*self.move_speed(me),threats)) if safe else (0.,0.)
        me["ai"]["dirX"],me["ai"]["dirZ"]=direction
        return direction,score

    def advance_cast(self,side):
        me=self.fighters[side];old=(me["x"],me["z"])
        super().advance_cast(side)
        if not self.can_stand(me["x"],me["z"],me["radius"]):me["x"],me["z"]=old

    def integrate(self):
        previous=[(f["x"],f["z"]) for f in self.fighters]
        super().integrate()
        for me,start in zip(self.fighters,previous):
            end=(me["x"],me["z"])
            if not self.can_travel(start,end,me["radius"]):
                distance=math.dist(start,end);steps=max(1,math.ceil(distance/.08));point=start
                for n in range(1,steps+1):
                    target=(start[0]+(end[0]-start[0])*n/steps,start[1]+(end[1]-start[1])*n/steps)
                    if self.can_travel(point,target,me["radius"]):point=target;continue
                    # Slide along safe axes; never tunnel across null ground.
                    for candidate in ((target[0],point[1]),(point[0],target[1])):
                        if self.can_travel(point,candidate,me["radius"]):point=candidate
                me["x"],me["z"]=point;me.update(vx=0.,vz=0.,kbX=0.,kbZ=0.)
            me["groundY"]=self.height_at(me["x"],me["z"])

    def _cover_length(self,h,length):
        nearest=length
        for o in self.obstacles:
            dx,dz=o["x"]-h["x"],o["z"]-h["z"]
            along=dx*h["dirX"]+dz*h["dirZ"]
            across=abs(dx*-h["dirZ"]+dz*h["dirX"])
            radius=o["radius"]+h.get("halfWidth",0)*.5
            if across<radius and along+radius>0:
                nearest=min(nearest,max(0.,along-math.sqrt(max(0.,radius*radius-across*across))))
        return nearest

    def follow_hazards(self):
        super().follow_hazards()
        for h in self.hazards:
            if h["kind"] in ("beam","stream"):
                c=self.fighters[h["side"]]["cast"]
                nominal=c["mech"]["length"] if c and c.get("hazard")==h["id"] else h.get("_fieldLength",h["length"])
                h["_fieldLength"]=nominal;h["length"]=self._cover_length(h,nominal)

    def hazard_contains(self,h,x,z,r):
        if not super().hazard_contains(h,x,z,r):return False
        if h["kind"] in ("melee","beam","stream","channel"):
            return not any(seg_dist(h["x"],h["z"],x,z,o["x"],o["z"])<o["radius"] for o in self.obstacles)
        return True

    def break_obstacle(self,o,by):
        existed=o in self.obstacles
        super().break_obstacle(o,by)
        if existed and o not in self.obstacles:
            self.destroyed.append(o["id"]);self._obstacle_revision+=1

    def compact_frame(self):
        out=super().compact_frame()
        for row,model in zip(out["fighters"],self.fighters):row["groundY"]=self.height_at(model["x"],model["z"])
        out["destroyed"]=list(self.destroyed)
        return out

    def snapshot(self,battle_id):
        out=super().snapshot(battle_id)
        out["field"]={**copy.deepcopy(self.field),"destroyed":list(self.destroyed)}
        return out
