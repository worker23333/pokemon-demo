import { Fx } from '../../apps/web/arena/fx';
import { drawReferenceAttack } from '../visual-stage-p1/reference-effects.js';
import { drawSkillClash } from '../visual-stage-p1/skill-effects.js';
import { muzzlePoints, metadataEmissionPoints } from '../visual-stage-p1/muzzle-anchors.js';
import { impactProfile } from '../../packages/presentation/battle-juice.js';
import { fxFor } from '../../apps/web/arena/types';
import type { CompactFrame, SnapEvent, Snapshot } from '../../apps/web/arena/types';
import { fieldActorVertex, type FieldActorOptions, type FieldActorSample, type FieldFighter } from './field-actors';

export type FieldScreenPoint = { x: number; y: number };
export type FieldFxOptions = {
  tick: number;
  /** Interpolated authoritative frame. Defaults to the most recently ingested snapshot. */
  frame?: CompactFrame | Snapshot;
  samples: ReadonlyMap<string, FieldActorSample | null>;
  /** Local battle XZ and absolute world elevation -> the SAME world camera. */
  project: (x: number, z: number, worldY: number) => FieldScreenPoint;
  groundAt?: (x: number, z: number) => number;
  /** Optional exact source-pixel -> displayed Three plane projection. dx/up
   * are world metres relative to the feet, including the animation lift. */
  projectAnchor?: (f: FieldFighter, dx: number, up: number, sample: FieldActorSample) => FieldScreenPoint;
  layer?: 'back' | 'front';
  pixelsPerUnit?: number;
  reduced?: boolean;
};

const eventTick = (e: SnapEvent) => e.effectiveTick ?? e.tick + 1;
const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
type AnchorInput = { sample: FieldActorSample['pmdSample']; speciesId?: number; dir?: number; x: number; y: number; scale: number };
type AnchorPoint = { x: number; y: number; kind: string; layer: string };
type ActorTiming = Pick<FieldActorOptions, 'hurtTick' | 'faintedAtTick' | 'recoilStrength' | 'recoilDirection'>;
// The unchanged JS functions use destructuring defaults that omit required
// fields from TS inference; give this adapter their actual public signatures.
const calibratedAnchors = muzzlePoints as unknown as (args: AnchorInput) => AnchorPoint[];
const sourceAnchors = metadataEmissionPoints as unknown as (args: AnchorInput) => AnchorPoint[];

/** Existing P1 reference effects + arena Fx primitives, driven exclusively by
 * public combat events/geometry. It neither creates hits nor changes AI/HP.
 * A top canvas cannot depth-test against Three trees; server endpoint clipping
 * still prevents a beam continuing past an authoritative solid obstruction. */
export class FieldEffects {
  private snapshot?: Snapshot;
  private seen = new Set<string>();
  private pending: SnapEvent[] = [];
  private history: SnapEvent[] = [];
  private timing = new Map<string, ActorTiming>();
  private broken: string[] = [];
  private fx = new Fx();
  private painter = new Fx();
  private clock?: number;
  private rate = 20;
  readonly diagnostics = new Set<string>();

  reset() {
    this.snapshot = undefined; this.seen.clear(); this.pending = []; this.history = [];
    this.timing.clear(); this.broken = []; this.fx = new Fx(); this.clock = undefined;
    this.diagnostics.clear();
  }
  ingest(snapshot: Snapshot) {
    if (this.snapshot && (this.snapshot.id !== snapshot.id || snapshot.tick < this.snapshot.tick)) this.reset();
    this.snapshot = snapshot; this.rate = snapshot.tickRate || 20;
    for (const e of snapshot.events) {
      const key = e.eventSeq != null ? `seq:${e.eventSeq}` : JSON.stringify([e.tick, e.kind, e.actor, e.moveId, e.hazardId, e.projectileId, e.obstacleId, e.amount, e.text]);
      if (this.seen.has(key)) continue;
      this.seen.add(key); this.pending.push(e);
    }
    this.pending.sort((a, b) => eventTick(a) - eventTick(b) || (a.eventSeq ?? 0) - (b.eventSeq ?? 0));
  }
  /** Call once before sampling actors; render() also calls this safely. */
  advance(tick: number) {
    if (!finite(tick)) return;
    if (this.clock == null) this.clock = Math.max(0, Math.min(tick, this.pending[0] ? eventTick(this.pending[0]) : tick));
    if (tick < this.clock) return; // ordinary interpolation never rewinds effects
    while (this.pending.length && eventTick(this.pending[0]) <= tick) {
      const e = this.pending.shift()!;
      const next = Math.max(this.clock, eventTick(e));
      this.fx.update((next - this.clock) / this.rate); this.clock = next;
      this.apply(e);
    }
    this.fx.update((tick - this.clock) / this.rate); this.clock = tick;
    this.history = this.history.filter(e => tick - eventTick(e) < this.rate * 1.5);
  }
  actorTiming(id: string, tick?: number): ActorTiming {
    if (tick != null) this.advance(tick);
    return this.timing.get(id) ?? {};
  }
  /** Root removes only the corresponding destructible world instances. */
  consumeBrokenObstacleIds(tick?: number) {
    if (tick != null) this.advance(tick);
    const ids = this.broken; this.broken = []; return ids;
  }
  private apply(e: SnapEvent) {
    const when = eventTick(e), actor = e.actor ?? undefined;
    if (actor && (e.kind === 'ko' || (['damage', 'recoil', 'dot'].includes(e.kind ?? '') && e.amount > 0))) {
      const old = this.timing.get(actor) ?? {};
      const target = this.snapshot?.fighters.find(f => f.id === actor), source = this.snapshot?.fighters.find(f => f.id === e.source);
      // Prefer the event's completed physics frame over a later HTTP snapshot.
      const frame = this.snapshot?.frames?.find(f => f.tick === when);
      const targetPoint = frame?.fighters.find(f => f.id === actor) ?? target;
      const sourcePoint = frame?.fighters.find(f => f.id === e.source) ?? source;
      const art = fxFor(e.moveId), profile = impactProfile(Number(e.amount) / Math.max(1, target?.maxHp ?? 1),
        Number(e.effectiveness ?? 1), e.delivery ?? sourcePoint?.cast?.shape ?? art.fx, !!art.big, !!e.guarded);
      this.timing.set(actor, e.kind === 'ko' ? { ...old, faintedAtTick: when } : { ...old, hurtTick: when,
        recoilStrength: profile.recoil,
        recoilDirection: targetPoint && sourcePoint ? { x: targetPoint.x - sourcePoint.x, z: targetPoint.z - sourcePoint.z } : undefined });
    }
    if (e.kind === 'damage' || e.kind === 'hit') {
      this.history.push(e);
      if (e.kind === 'damage' && finite(e.x) && finite(e.z) && finite(e.amount)) {
        // Existing rolling label avoids a pile of labels for a live channel.
        const key = `${actor}:${e.hazardId ?? e.moveId ?? ''}`;
        const previous = this.fx.particles.find(p => p.tag === `damage-${key}` && p.life < .4);
        const total = e.amount + (previous ? Number(previous.text) || 0 : 0);
        this.fx.damage(e.x, e.z, total, '#f6e6b9', 13, key, !!previous);
      }
    }
    if (e.kind === 'break' && typeof e.obstacleId === 'string') {
      this.broken.push(e.obstacleId);
      if (finite(e.x) && finite(e.z)) {
        // Exact established ArenaView.syncObstacles debris primitives.
        this.fx.burst(e.x, e.z, 18, { kind: 'shard', color: '#9c713b', size: .12, speed: 4, grav: 14, vz: 5, max: .9 });
        this.fx.burst(e.x, e.z, 10, { kind: 'smoke', color: '#a69070', size: .3, grow: .8, speed: 2, max: .8 });
      }
    }
  }
  render(g: CanvasRenderingContext2D, options: FieldFxOptions) {
    this.advance(options.tick);
    const state = options.frame ?? this.snapshot;
    if (!state || !this.snapshot) return;
    const layer = options.layer ?? 'back', time = options.tick / this.rate;
    const fighters = state.fighters.map(f => ({ ...this.snapshot!.fighters.find(s => s.id === f.id), ...f })) as FieldFighter[];
    const ground = (x: number, z: number) => options.groundAt?.(x, z) ?? fighters.find(f => f.x === x && f.z === z)?.groundY ?? 0;
    const project = options.project;
    const unitAt = (x: number, z: number) => {
      if (options.pixelsPerUnit != null) return Math.max(1, options.pixelsPerUnit);
      const y = ground(x, z), a = project(x, z, y), b = project(x, z, y + 1);
      return Math.max(1, Math.hypot(a.x - b.x, a.y - b.y));
    };
    const sourcesFor = (f?: FieldFighter) => {
      const sample = f && options.samples.get(f.id);
      if (!f || !sample) return [];
      let points = calibratedAnchors({ sample: sample.pmdSample, speciesId: f.speciesId, dir: sample.direction, x: 0, y: 0, scale: 1 });
      if (!points.length) {
        points = sourceAnchors({ sample: sample.pmdSample, x: 0, y: 0, scale: 1 });
        this.diagnostics.add('发射点未逐帧标定：部分物种/方向使用 PMD 原 Head 锚点');
      }
      return points.map(p => {
        const dx = p.x * sample.pixelWorldScale, up = -p.y * sample.pixelWorldScale + sample.lift;
        // Exact same source-pixel deformation as the displayed mesh vertices.
        const vertex = fieldActorVertex(sample, p.x + sample.frame.feet[0], p.y + sample.frame.feet[1]);
        const screen = options.projectAnchor?.(f, dx, up, sample) ?? project(f.x + vertex.x, f.z + vertex.z, ground(f.x, f.z) + .00232 + vertex.y + sample.lift);
        return { ...screen, kind: p.kind, layer: p.layer };
      });
    };
    const draw = (moveId: number, f: FieldFighter | undefined, x: number, z: number, age: number,
      extra: { active?: boolean; impactAge?: number; travelProgress?: number; height?: number } = {}) => {
      const sources = sourcesFor(f);
      if (!sources.length) return;
      drawReferenceAttack(g, { s: unitAt(x, z) }, { moveId, sources,
        target: project(x, z, ground(x, z) + (extra.height ?? .7)),
        groundSource: f ? project(f.x, f.z, ground(f.x, f.z)) : undefined,
        groundTarget: project(x, z, ground(x, z)),
        targetHeight: fighters.find(a => a.id !== f?.id) ? options.samples.get(fighters.find(a => a.id !== f?.id)!.id)?.worldHeight ?? 1.8 : 1.8,
        time, age, layer, reduced: options.reduced ?? false, ...extra });
    };
    for (const h of state.hazards ?? []) {
      const active = h.activeTick ?? h.active + 1, end = h.endTick ?? h.end + 1;
      if (options.tick < active || options.tick >= end) continue;
      // Public endX/endZ already includes reach shortened by cover and clashes.
      // Radial fields have a zero-length endpoint at their authoritative origin.
      const x = finite(h.endX) ? h.endX : h.x, z = finite(h.endZ) ? h.endZ : h.z;
      draw(h.moveId, fighters[h.side], x, z, (options.tick - active) / this.rate);
    }
    for (const p of state.projectiles ?? []) {
      const moveId = p.moveId ?? p.move?.id;
      if (moveId == null) continue;
      // Existing projectile ornament is placed at the actual server position.
      // Progress=1 removes the fixture's independent travel interpolation/arc.
      draw(moveId, p.side == null ? undefined : fighters[p.side], p.x, p.z,
        Math.max(0, options.tick - (p.born ?? options.tick)) / this.rate,
        { travelProgress: 1, height: finite(p.height) ? p.height : .7 });
    }
    if (layer === 'front') {
      for (const e of this.history) {
        if (!finite(e.moveId) || !finite(e.x) || !finite(e.z)) continue;
        const age = (options.tick - eventTick(e)) / this.rate;
        if (age < 0 || age >= .42) continue;
        draw(e.moveId, fighters.find(f => f.id === e.source), e.x, e.z, age, { active: false, impactAge: age });
      }
      for (const cl of state.clashes ?? []) {
        const a = state.hazards?.find(h => h.id === cl.a), b = state.hazards?.find(h => h.id === cl.b);
        if (!a || !b) continue;
        const at = project(cl.x, cl.z, ground(cl.x, cl.z) + .7), s = unitAt(cl.x, cl.z);
        drawSkillClash(g, { s, x: () => at.x, y: () => at.y }, {
          firstMoveId: a.moveId, secondMoveId: b.moveId, u: 0, height: 0,
          time, age: Math.max(0, options.tick - (cl.start ?? options.tick)) / this.rate, reduced: options.reduced ?? false });
      }
      // Reuse Fx.drawParticles itself; only adapt its 2D camera input after
      // projecting each existing particle through the world camera.
      for (const p of this.fx.particles) {
        const at = project(p.u, p.v, ground(p.u, p.v) + p.z * .9);
        this.painter.particles = [{ ...p, u: 0, v: 0, z: 0 }];
        this.painter.drawParticles(g, { s: unitAt(p.u, p.v), dpr: 1, x: () => at.x, y: () => at.y }, !!p.ground);
      }
      this.painter.particles = [];
    }
  }
}

/** Minimal integration: effects.ingest(snapshot); effects.advance(renderTick);
 * samples.set(f.id, sampleFieldActor(f, renderTick, effects.actorTiming(f.id)));
 * render Three actors using frame.feet and pixelWorldScale, then call render()
 * for back and front. A composited top overlay retains this explicit depth
 * limitation; it is not claimed to be native Three per-pixel occlusion. */
