import { fighterPmdSample, loadPmdSpecies, pmdSample, type PmdSample } from '../../apps/web/arena/directional-sprite';
import { pmdDirectionIndex, type PmdAnimation, type PmdAnchors, type PmdSpecies } from '../../packages/presentation/pmd-sprites.js';
import { stagePivotLift } from '../../packages/presentation/action-stage.js';
import { impactProfile, sampleRecoil } from '../../packages/presentation/battle-juice.js';
import { emissionPose } from '../visual-stage-p1/muzzle-anchors.js';
import type { FighterView, SnapFighter } from '../../apps/web/arena/types';
import { SOURCE_VIEW, worldToScreen } from './source-view';
import { pokemonModelSize } from './pokemon-model';
import type { CompanionAmbient } from './companion-behavior';

/** This adapter uses the existing PMD sheets, 60 Hz frame durations and action
 * selector for both companions and fighters. No combat state is advanced. */
export const loadFieldActor = loadPmdSpecies;
export type FieldFighter = SnapFighter & {
  groundY?: number;
  grapple?: { height?: number; role?: string; phase?: string } | null;
};
export type FieldActorOptions = {
  tickRate?: number;
  direction?: number;
  hurtTick?: number;
  recoilStrength?: number;
  /** Direction away from the hit source, in local battle XZ. */
  recoilDirection?: { x: number; z: number };
  faintedAtTick?: number;
  reduced?: boolean;
  boss?: boolean;
  /** Override when a camera differs from the Gamma source view. */
  projectDirection?: (x: number, z: number) => { x: number; z: number };
};
export type FieldActorSample = {
  image: HTMLImageElement;
  frame: { sx: number; sy: number; sw: number; sh: number; feet: [number, number] };
  sheetKey: string;
  displayHeight: number;
  worldHeight: number;
  pixelWorldScale: number;
  action: string;
  requestedAction: string;
  fallback: boolean;
  direction: number;
  lift: number;
  hidden: boolean;
  stage: NonNullable<ReturnType<typeof fighterPmdSample>>['stage'];
  pmdSample: PmdSample;
  facing: number;
  recoil: ReturnType<typeof sampleRecoil>;
  pose: FieldActorPose;
};
export type FieldActorPose = {
  stretchX: number; stretchY: number; rotation: number;
  pivotLift: number; digDrop: number; offsetX: number; offsetZ: number;
  flash: number; clipAtGround: boolean;
};

/** ArenaView's PMD compression/recoil and geometry.ts's ground-pivot correction.
 * These affect the painted body only; ground position, shadow and collision
 * radius remain authoritative. PMD Walk already supplies its own locomotion. */
export function fieldActorPose(sample: Omit<FieldActorSample, 'pose'>, facing = sample.facing): FieldActorPose {
  const { stage, recoil } = sample;
  const stretchX = recoil.stretchX * (1 + stage.compression * .5);
  const stretchY = recoil.stretchY * (1 - stage.compression);
  const rotation = stage.kind === 'dig' ? 0 : stage.pitch * (Math.sign(facing) || 1);
  const bounds = sample.pmdSample.frame.anchors.bounds;
  // PMD feet are not necessarily at the cell centre. Express the actual left
  // and right extents around that authored pivot as the width supplied to the
  // existing stagePivotLift, preserving both grounded lower corners.
  const left = (bounds?.[0] ?? 0) - sample.frame.feet[0];
  const right = (bounds?.[2] ?? sample.frame.sw) - sample.frame.feet[0];
  const width = Math.max(Math.abs(left), Math.abs(right)) * 2 * sample.pixelWorldScale * stretchX;
  return { stretchX, stretchY, rotation, pivotLift: stagePivotLift(stage, rotation, width),
    digDrop: stage.kind === 'dig' ? stage.dig * sample.worldHeight * 1.15 : 0,
    offsetX: -recoil.v, offsetZ: -recoil.u, flash: recoil.flash, clipAtGround: stage.kind === 'dig' && stage.dig > 0 };
}

/** Source-cell pixel -> mesh-local metres. px/py use the ORIGINAL cell origin,
 * not feet-relative coordinates. Apply to the four corners (0,0), (sw,0),
 * (0,sh), (sw,sh), and to muzzle pixels alike. The returned XYZ intentionally
 * excludes sample.lift; mesh.position stays at ground + .00232 + sample.lift.
 * Dig moves below the real terrain for depth clipping, never flattens pixels. */
export function fieldActorVertex(sample: FieldActorSample, px: number, py: number, facing = sample.facing) {
  const pose = facing === sample.facing ? sample.pose : fieldActorPose(sample, facing);
  const sx = (px - sample.frame.feet[0]) * sample.pixelWorldScale * pose.stretchX;
  const sy = (py - sample.frame.feet[1]) * sample.pixelWorldScale * pose.stretchY;
  const c = Math.cos(pose.rotation), s = Math.sin(pose.rotation);
  const right = sx * c - sy * s, up = -(sx * s + sy * c);
  const tilt = SOURCE_VIEW.actorTilt * Math.PI / 180;
  return { x: up * Math.sin(tilt) + pose.offsetX,
    y: (up + pose.pivotLift) * Math.cos(tilt) - pose.digDrop,
    z: -right + pose.offsetZ };
}

/** `tick` is a public simulation/render tick, never performance.now(). The
 * default direction transform matches the unchanged Gamma source camera. */
export function sampleFieldActor(f: FieldFighter | FighterView, tick: number, options: FieldActorOptions = {}): FieldActorSample | null {
  const rate = options.tickRate && options.tickRate > 0 ? options.tickRate : 20;
  const clockScale = 20 / rate;
  const view = 'u' in f ? f : fieldFighterView(f, tick, options);
  const cast = view.cast;
  // Existing production sampler is expressed at 20 simulation ticks/second.
  const adapted: FighterView = { ...view, hurtTick: view.hurtTick == null ? undefined : view.hurtTick * clockScale,
    cast: cast ? { ...cast,
      startTick: (cast.startTick ?? cast.start + 1) * clockScale,
      activeTick: (cast.activeTick ?? cast.active + 1) * clockScale,
      endTick: (cast.endTick ?? cast.end + 1) * clockScale,
      activeLen: cast.activeLen * clockScale,
    } : cast };
  const sampled = fighterPmdSample(adapted, tick * clockScale, options.reduced ?? false);
  if (!sampled) return null;
  let pmd: PmdSample = sampled;
  // Reuse the already calibrated P1 channel pose so cannons do not retract
  // during a live stream. All eight source rows remain available.
  const channel = view.phase === 'active' && ['channel', 'stream', 'beam'].includes(cast?.shape ?? '');
  if (channel && view.hp > 0 && view.status !== 'sleep') {
    const elapsed = Math.max(0, tick - (cast!.activeTick ?? cast!.active + 1)) / rate;
    const pose = emissionPose(view.speciesId, elapsed, options.reduced ?? false);
    pmd = pmdSample(view.speciesId, pose.action, pose.seconds, sampled.frame.row, pose.loop) ?? sampled;
  }
  const { worldHeight, pixelWorldScale } = pokemonModelSize(view.speciesId, pmd.data);
  const source: Omit<FieldActorSample, 'pose'> = { image: pmd.sheet.image, frame: { sx: pmd.frame.sx, sy: pmd.frame.sy, sw: pmd.frame.sw, sh: pmd.frame.sh,
      feet: [...pmd.frame.anchors.feet] as [number, number] },
    sheetKey: pmd.animation.sheet, displayHeight: pmd.data.displayHeight, worldHeight,
    pixelWorldScale,
    action: pmd.animation.name, requestedAction: pmd.requested, fallback: pmd.fallback,
    direction: pmd.frame.row, lift: sampled.lift, hidden: view.hidden,
    stage: sampled.stage, pmdSample: pmd, facing: Math.sign(view.aimU ?? view.facing) || view.facing,
    recoil: sampleRecoil(view, tick / rate, options.reduced ?? false) };
  return { ...source, pose: fieldActorPose(source) };
}

export type CompanionActorOptions = {
  level?: number;
  facing?: { x: number; z: number };
  /** Exploration velocity is in world metres/second, unlike server snapshots. */
  velocity?: { x: number; z: number };
  direction?: number;
  /** Opt-in exploration attention; omitted calls remain identical to combat. */
  ambient?: CompanionAmbient;
};

type AmbientFrames = { neutral: number; gesture: PmdAnimation; frames: number[] };
const ambientFrames = new WeakMap<PmdSpecies, Map<number, AmbientFrames>>();
const anchorsFor = (animation: PmdAnimation, row: number) => animation.anchors[animation.directionCount === 1 ? 0 : row] ?? [];
const bottom = (anchors: PmdAnchors | undefined) => anchors?.bounds ? anchors.bounds[3] - anchors.feet[1] : null;
const frameTime = (animation: PmdAnimation, frame: number) => (animation.durations.slice(0, frame).reduce((sum, duration) => sum + duration, 0) + .0001) / 60;

/** Some authored Idle loops contain a hop: Pikachu moves its painted body up
 * 6–8 pixels every .88 seconds even when the mesh lift is zero. A neutral frame
 * is selected using foot-relative bounds, then longest grounded source hold.
 * Optional gestures use only small grounded Pose/Idle changes; pixels and the
 * original foot anchors remain untouched. No Hop sheet is sampled here. */
function companionFrames(data: PmdSpecies, row: number): AmbientFrames {
  let rows = ambientFrames.get(data);
  if (!rows) { rows = new Map(); ambientFrames.set(data, rows); }
  const cached = rows.get(row); if (cached) return cached;
  const idle = data.animations.Idle ?? data.animations.Walk;
  const anchors = anchorsFor(idle, row);
  const grounded = Math.max(...anchors.map(anchor => bottom(anchor) ?? -Infinity));
  let neutral = 0, hold = -1;
  for (let i = 0; i < idle.durations.length; i++) {
    const edge = bottom(anchors[i]);
    if ((edge === null || edge >= grounded - 2) && idle.durations[i] > hold) { neutral = i; hold = idle.durations[i]; }
  }
  const reference = anchors[neutral], referenceBottom = bottom(reference);
  const safeFrames = (animation: PmdAnimation) => anchorsFor(animation, row).flatMap((anchor, i) => {
    const edge = bottom(anchor);
    if (edge === null || referenceBottom === null || !reference?.bounds || !anchor.bounds) return [];
    const centerDifference = Math.abs((anchor.center[1] - anchor.feet[1]) - (reference.center[1] - reference.feet[1]));
    const width = anchor.bounds[2] - anchor.bounds[0], referenceWidth = reference.bounds[2] - reference.bounds[0];
    return Math.abs(edge - referenceBottom) <= 2 && centerDifference <= 3 && width <= referenceWidth * 1.45 + 2 ? [i] : [];
  });
  let gesture = data.animations.Pose ?? idle, frames = safeFrames(gesture);
  if (frames.length < 2) { gesture = idle; frames = safeFrames(idle); }
  const plan = { neutral, gesture, frames }; rows.set(row, plan);
  // Prime only a usable, occasional Pose sheet. Loading is asynchronous just
  // like the shared sampler; until ready the already-loaded neutral is shown.
  if (gesture !== idle && frames.length > 1) pmdSample(data.id, gesture.name, 0, row, false);
  return plan;
}

function sampleAmbientCompanion(base: FieldActorSample, ambient: CompanionAmbient): FieldActorSample {
  const data = base.pmdSample.data, idle = data.animations.Idle ?? data.animations.Walk;
  const plan = companionFrames(data, base.direction);
  let pmd = pmdSample(data.id, idle.name, frameTime(idle, plan.neutral), base.direction, false) ?? base.pmdSample;
  const progress = Number.isFinite(ambient.seconds) && Number.isFinite(ambient.duration) && ambient.duration > 0
    ? Math.max(0, Math.min(1, ambient.seconds / ambient.duration)) : 0;
  if (ambient.mode === 'gesture' && progress >= .12 && progress < .84 && plan.frames.length > 1) {
    // One forward-and-return gesture, with neutral holds at both ends. Sampling
    // is independent of total exploration time; an action never loops forever.
    const phase = (progress - .12) / .72;
    const position = (phase < .5 ? phase * 2 : (1 - phase) * 2) * (plan.frames.length - 1);
    const frame = plan.frames[Math.min(plan.frames.length - 1, Math.floor(position + .5))];
    pmd = pmdSample(data.id, plan.gesture.name, frameTime(plan.gesture, frame), base.direction, false) ?? pmd;
  }
  const source = { ...base, image: pmd.sheet.image, frame: { sx: pmd.frame.sx, sy: pmd.frame.sy, sw: pmd.frame.sw, sh: pmd.frame.sh,
    feet: [...pmd.frame.anchors.feet] as [number, number] }, sheetKey: pmd.animation.sheet,
    action: pmd.animation.name, requestedAction: pmd.requested, fallback: pmd.fallback,
    direction: pmd.frame.row, pmdSample: pmd, lift: 0 };
  return { ...source, pose: fieldActorPose(source) };
}

/** Exploration and portraits use the exact fighter sheets, pivots and size.
 * Seconds only choose authored frames; entering combat cannot resize a body. */
export function sampleCompanionActor(speciesId: number, seconds: number, options: CompanionActorOptions = {}): FieldActorSample | null {
  const facing = worldToScreen(options.facing?.x ?? 0, options.facing?.z ?? -1);
  const direction = options.direction ?? (options.ambient ? pmdDirectionIndex(facing.x, facing.z) : undefined);
  const sampled = sampleFieldActor({ id: 'companion', speciesId, name: '', level: options.level ?? 1,
    hp: 1, maxHp: 1, x: 0, z: 0, vx: (options.velocity?.x ?? 0) / 20, vz: (options.velocity?.z ?? 0) / 20,
    facingX: options.facing?.x ?? 0, facingZ: options.facing?.z ?? -1 }, Math.max(0, seconds) * 20,
  { direction });
  if (!sampled || !options.ambient || Math.hypot(options.velocity?.x ?? 0, options.velocity?.z ?? 0) > .4) return sampled;
  return sampleAmbientCompanion(sampled, options.ambient);
}

/** Public for focused tests and integrations with the existing arena renderer. */
export function fieldFighterView(f: FieldFighter, tick: number, options: FieldActorOptions = {}): FighterView {
  const rate = options.tickRate && options.tickRate > 0 ? options.tickRate : 20;
  const project = options.projectDirection ?? worldToScreen;
  // Snapshot velocity is metres per combat tick; the established action
  // selector expects metres/second (threshold .4), just like authoritativeMotion.
  const velocity = project((f.vx ?? 0) * rate, (f.vz ?? 0) * rate);
  const aim = project(f.cast?.dirX ?? f.facingX ?? 0, f.cast?.dirZ ?? f.facingZ ?? 0);
  const speed = Math.hypot(f.vx ?? 0, f.vz ?? 0) * rate;
  const facing = f.cast || speed <= .4 ? aim : velocity;
  const deadAge = Math.max(0, tick - (options.faintedAtTick ?? tick)) / rate;
  const recoilDirection = options.recoilDirection ? project(options.recoilDirection.x, options.recoilDirection.z) : { x: -aim.x, z: -aim.z };
  return { id: f.id, side: 0, speciesId: f.speciesId, name: f.name, types: f.types ?? [], level: f.level,
    boss: options.boss ?? false, hp: f.hp, maxHp: f.maxHp, hpShown: f.hp,
    u: f.x, v: f.z, lastU: f.x, lastV: f.z, worldX: f.x, worldZ: f.z,
    speed, velocityU: velocity.x, velocityV: velocity.z, aimU: aim.x, aimV: aim.z,
    facing: facing.x < 0 ? -1 : 1, pmdDirection: options.direction ?? pmdDirectionIndex(facing.x, facing.z),
    hurtTick: options.hurtTick, flash: 0, hidden: f.hidden ?? false,
    // This field scene does not pause the authoritative clock for hitstop. The
    // existing .22-second recoil envelope starts at the actual visible hit.
    recoilAt: options.hurtTick != null && options.hurtTick <= tick ? options.hurtTick / rate : undefined,
    recoilStrength: options.recoilStrength ?? impactProfile(.01).recoil,
    recoilDirU: recoilDirection.x, recoilDirV: recoilDirection.z,
    // Authoritative grapple height is already world metres; sampler multiplies
    // cosmetic alt by .9, so cancel that legacy presentation factor here.
    alt: Math.max(0, f.grapple?.height ?? 0) / .9, altV: 0,
    status: f.status, guard: (f.guardUntil ?? 0) > tick,
    fainted: f.hp <= 0 ? deadAge * 1.1 + .0001 : 0,
    spawn: 1, ghosts: [], clones: 0, animMs: tick / rate * 1000, bobT: 0, dustT: 0, lifted: 0,
    radius: f.radius, cast: f.cast, phase: f.phase ?? f.cast?.phase ?? (speed > .4 ? 'move' : 'idle') };
}
