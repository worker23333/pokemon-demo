// Pure snapshot playback: no animation, DOM, collision decisions or predicted outcomes.
import type { Snapshot, CompactFrame, SnapFighter, SnapEvent, SnapHazard } from "./types";
import { mergeFrameFighter } from "./moves";

export type Frame = Omit<CompactFrame, "fighters"> & { fighters: SnapFighter[] };
export const isAuthoritative = (b: Snapshot) => (b.engineVersion ?? 0) >= 3 || b.ruleset === "kanto-realtime-v2";
export const eventTick = (e: SnapEvent) => e.effectiveTick ?? e.tick;
export const eventKey = (e: SnapEvent) => e.eventSeq != null ? `seq:${e.eventSeq}` : `${e.tick}|${e.kind}|${e.actor}|${e.text}|${e.amount ?? ""}|${e.projectileId ?? ""}`;

/** Raw v3 hazard times name the step; public frame n is the state after step n-1. */
export function hazardPhase(h: SnapHazard, tick: number): "windup" | "active" | "ended" {
  const active = h.activeTick ?? h.active + 1, end = h.endTick ?? h.end + 1;
  return tick < active ? "windup" : tick < end ? "active" : "ended";
}

const lerp = (a: number, b: number, k: number) => a + (b - a) * k;
function geometry<T extends { id: string; x: number; z: number }>(a: T[], b: T[], k: number, canInterpolate: (a: T, b: T) => boolean = () => true): T[] {
  const next = new Map(b.map((item) => [item.id, item]));
  return a.map((item) => {
    const later = next.get(item.id);
    if (!later || !canInterpolate(item, later)) return { ...item }; // never fly a removed entity toward its intended target
    const out: any = { ...item };
    for (const key of ["x", "z", "fromX", "fromZ", "startX", "startZ", "endX", "endZ", "dirX", "dirZ", "length", "reach", "halfWidth"]) {
      const n = (item as any)[key], m = (later as any)[key];
      if (typeof n === "number" && typeof m === "number") out[key] = lerp(n, m, k);
    }
    return out as T;
  });
}

export class Timeline {
  frames: Frame[] = [];
  authoritative = false;
  private terminals = new Map<string, SnapEvent>();
  private legacyHpEvents = new Map<string, SnapEvent>();

  ingest(b: Snapshot): { gap: boolean; first: number; last: number } {
    this.authoritative = isAuthoritative(b);
    const metadata = new Map(b.fighters.map((f) => [f.id, f]));
    const incoming: CompactFrame[] = b.frames?.length ? b.frames : [{ tick: b.tick, fighters: b.fighters, projectiles: b.projectiles || [], hazards: b.hazards, obstacles: b.obstacles, clashes: b.clashes }];
    const ordered = [...incoming].sort((a, c) => a.tick - c.tick);
    const previous = this.frames.at(-1)?.tick;
    const newer = ordered.filter((f) => previous == null || f.tick > previous);
    const gap = this.authoritative && previous != null && newer.length > 0 && newer[0].tick > previous + 1;
    if (gap) this.frames = []; // missing history is a resync, never an invented motion path
    const unique = new Map(this.frames.map((f) => [f.tick, f]));
    for (const frame of ordered) {
      if (frame.tick > b.tick) continue;
      unique.set(frame.tick, { ...frame, fighters: frame.fighters.map((f) => mergeFrameFighter(metadata.get(f.id), f)),
        projectiles: frame.projectiles || [], hazards: frame.hazards || [], obstacles: frame.obstacles || [], clashes: frame.clashes || [] });
    }
    this.frames = [...unique.values()].sort((a, c) => a.tick - c.tick).slice(-100);
    for (const e of b.events || []) if (e.kind === "projectileEnd" && e.projectileId) this.terminals.set(e.projectileId, e);
    if (!this.authoritative) for (const e of b.events || []) if (e.actor && typeof e.hpAfter === "number") this.legacyHpEvents.set(eventKey(e), e);
    const first = this.frames[0]?.tick ?? b.tick;
    for (const [id, e] of this.terminals) if (eventTick(e) < first) this.terminals.delete(id);
    for (const [id, e] of this.legacyHpEvents) if (eventTick(e) < first) this.legacyHpEvents.delete(id);
    return { gap, first, last: this.frames.at(-1)?.tick ?? b.tick };
  }

  at(tick: number): Frame | undefined {
    if (!this.frames.length) return;
    let i = this.frames.length - 1;
    while (i > 0 && this.frames[i].tick > tick) i--;
    const a = this.frames[i], b = this.frames[Math.min(i + 1, this.frames.length - 1)];
    const span = b.tick - a.tick;
    const k = span > 0 && (!this.authoritative || span === 1) ? Math.max(0, Math.min(1, (tick - a.tick) / span)) : 0;
    const next = new Map(b.fighters.map((f) => [f.id, f]));
    const fighters = a.fighters.map((f) => {
      const later = next.get(f.id);
      // HP, phase, status and visibility switch on the completed tick, never interpolate.
      if (!later || !!f.hidden !== !!later.hidden) return { ...f };
      return { ...f, x: lerp(f.x, later.x, k), z: lerp(f.z, later.z, k) };
    });
    if (!this.authoritative) {
      for (const event of [...this.legacyHpEvents.values()].sort((x, y) => eventTick(x) - eventTick(y))) {
        if (eventTick(event) < a.tick || eventTick(event) > tick) continue;
        const fighter = fighters.find((f) => f.id === event.actor);
        if (fighter) fighter.hp = event.hpAfter;
      }
    }
    const projectiles = geometry(a.projectiles, b.projectiles, k);
    const present = new Set(b.projectiles.map((p) => p.id));
    for (const p of projectiles) {
      const end = this.terminals.get(p.id);
      if (!present.has(p.id) && end && eventTick(end) === b.tick && Number.isFinite(end.x) && Number.isFinite(end.z)) {
        p.x = lerp(p.x, end.x, k); p.z = lerp(p.z, end.z, k);
      }
    }
    return { tick: a.tick, fighters, projectiles,
      // A new/ended/reassigned clash changes the physical clip boundary. Do
      // not shrink or extend a beam toward that future state before its tick.
      hazards: geometry(a.hazards || [], b.hazards || [], k, (h, next) =>
        hazardPhase(h, a.tick) === hazardPhase(next, b.tick) && (h.clash ?? null) === (next.clash ?? null)),
      obstacles: (a.obstacles || []).map((o) => ({ ...o })),
      clashes: geometry(a.clashes || [], b.clashes || [], k) };
  }
}
