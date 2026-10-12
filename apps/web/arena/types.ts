// Shared types for the broadcast arena renderer.
import moveFxData from "../../../packages/content/move-fx.json";

export type MoveFx = {
  fx: string;
  type: string;
  color: string;
  color2: string;
  callout: string;
  style?: string;
  shape?: string;
  hits?: number;
  width?: number;
  twin?: boolean;
  big?: boolean;
  rainbow?: boolean;
  rings?: boolean;
  snow?: boolean;
  cloud?: boolean;
  chain?: boolean;
  count?: number;
  size?: number;
  spin?: boolean;
  petals?: boolean;
};
export const MOVE_FX = moveFxData as Record<string, MoveFx>;
export const GENERIC_FX: MoveFx = { fx: "melee", type: "normal", color: "#f4f1e6", color2: "#ffffff", callout: "Attack!", style: "tackle" };
export const fxFor = (id?: number) => (id != null && MOVE_FX[String(id)]) || GENERIC_FX;

export type SnapFighter = {
  id: string;
  speciesId: number;
  name: string;
  hp: number;
  maxHp: number;
  x: number;
  z: number;
  action?: string;
  level: number;
  types?: string[];
  status?: string | null;
  guardUntil?: number;
  hidden?: boolean;
  radius?: number;
  vx?: number;
  vz?: number;
  facingX?: number;
  facingZ?: number;
  dashUntil?: number;
  phase?: string;
  cast?: SnapCast | null;
  moves?: SnapMove[];
  energy?: number;
};
export type SnapMove = { id: number; name?: string; nameEn?: string; type?: string; pp?: number; remainingPp?: number };
export type SnapCast = {
  moveId: number; moveType?: string; shape: string; phase?: string;
  start: number; active: number; activeLen: number; end: number;
  startTick?: number; activeTick?: number; endTick?: number;
  dirX?: number; dirZ?: number; aimX?: number; aimZ?: number;
  hazard?: string | null;
};
export type SnapProjectile = {
  id: string;
  side?: number;
  x: number;
  z: number;
  targetX?: number;
  targetZ?: number;
  type: string;
  move?: { id?: number };
  moveId?: number;
  vx?: number; vz?: number; radius?: number; born?: number; ttl?: number;
  [key: string]: any;
};
export type SnapHazard = {
  id: string; side: number; kind: string; moveId: number; moveType?: string;
  x: number; z: number; created?: number; active: number; activeLen?: number; end: number;
  dirX?: number; dirZ?: number; length?: number; reach?: number; halfWidth?: number;
  radius?: number; arc?: number; resolved?: boolean; clash?: string | null;
  startX?: number; startZ?: number; endX?: number; endZ?: number;
  startTick?: number; activeTick?: number; endTick?: number;
  [key: string]: any;
};
export type SnapObstacle = { id: string; kind: string; x: number; z: number; radius: number; hp?: number | null; solid?: boolean };
export type SnapClash = { id: string; x: number; z: number; a?: string; b?: string; start?: number; ticks?: number; [key: string]: any };
export type CompactFrame = {
  tick: number;
  fighters: (Partial<SnapFighter> & Pick<SnapFighter, "id" | "x" | "z" | "hp" | "maxHp">)[];
  projectiles: SnapProjectile[]; hazards?: SnapHazard[]; obstacles?: SnapObstacle[]; clashes?: SnapClash[];
};
export type SnapEvent = {
  tick: number;
  text: string;
  kind?: string;
  actor?: string | null;
  eventSeq?: number;
  effectiveTick?: number;
  [k: string]: any;
};
export type Snapshot = {
  id: string;
  status: string;
  tick: number;
  timeLeft?: number;
  winner?: string | null;
  fighters: SnapFighter[];
  events: SnapEvent[];
  projectiles?: SnapProjectile[];
  arena?: { theme: string; seed: number };
  engineVersion?: number; ruleset?: string; tickRate?: number; eventSeq?: number;
  frames?: CompactFrame[]; hazards?: SnapHazard[]; obstacles?: SnapObstacle[]; clashes?: SnapClash[];
};

export type FighterView = {
  id: string;
  side: number;
  speciesId: number;
  name: string;
  types: string[];
  level: number;
  boss: boolean;
  maxHp: number;
  hp: number;
  u: number;
  v: number;
  lastU: number;
  lastV: number;
  speed: number;
  velocityU?: number; velocityV?: number; aimU?: number; aimV?: number;
  facing: number;
  pmdDirection?: number;
  /** Cached display transform; never sent to the simulation. */
  pmdRender?: {scale:number;offsetU:number;offsetV:number;stretchX:number;stretchY:number;lift:number};
  bodyScreenBounds?: {left:number;right:number;top:number;bottom:number};
  visualFacing?: { view: 'front'|'back'; right: boolean };
  flash: number;
  hurtTick?: number;
  hurtStrength?: number;
  hurtDirection?: number;
  /** Cosmetic body displacement only; physics, shadows and HP labels stay anchored. */
  recoilAt?: number;
  recoilStrength?: number;
  recoilDirU?: number;
  recoilDirV?: number;
  alt: number;
  altV: number;
  hidden: boolean;
  /** Legacy cosmetic height only; never changes the authoritative ground anchor. */
  override?: { alt: number };
  status?: string | null;
  guard: boolean;
  fainted: number; // 0 alive .. 1 gone
  spawn: number; // 0..1 release animation
  ghosts: { u: number; v: number; a: number; flip: boolean }[];
  clones: number;
  animMs: number;
  bobT: number;
  dustT: number;
  hpShown: number;
  lifted: number;
  worldX?: number; worldZ?: number; radius?: number; cast?: SnapCast | null; phase?: string;
};

export type ProjView = {
  id: string;
  side: number;
  moveId?: number;
  fx: MoveFx;
  u: number;
  v: number;
  su: number;
  sv: number;
  tu: number;
  tv: number;
  age: number;
  ended: number; // 0 while live, >0 seconds since end
  seed: number;
  authoritative?: boolean;
  radius?: number;
};
