import moveData from "../../../packages/content/moves.json";
import type { CompactFrame, SnapFighter, SnapMove } from "./types";

const catalog = new Map<number, SnapMove>(moveData.map((m) => [m.id, m]));
export const TYPE_NAMES: Record<string, string> = { normal: "一般", fire: "火", water: "水", electric: "电", grass: "草", ice: "冰", fighting: "格斗", poison: "毒", ground: "地面", flying: "飞行", psychic: "超能力", bug: "虫", rock: "岩石", ghost: "幽灵", dragon: "龙" };
const PHASE_NAMES: Record<string, string> = { windup: "准备中", active: "施放中", recovery: "收招中" };

/** Static move labels may be hydrated from the latest packet; PP and energy may not. */
export function mergeFrameFighter(metadata: SnapFighter | undefined, frame: CompactFrame["fighters"][number]): SnapFighter {
  const labels = new Map((metadata?.moves || []).map((m) => [m.id, m]));
  const recorded = Array.isArray(frame.moves);
  const equipment = recorded ? frame.moves! : metadata?.moves;
  const moves = equipment?.slice(0, 4).map((m) => {
    const label = labels.get(m.id), fallback = catalog.get(m.id);
    return { id: m.id, name: m.name ?? label?.name ?? fallback?.name, nameEn: m.nameEn ?? label?.nameEn ?? fallback?.nameEn,
      type: m.type ?? label?.type ?? fallback?.type, pp: m.pp ?? label?.pp ?? fallback?.pp,
      remainingPp: recorded && Number.isFinite(m.remainingPp) ? m.remainingPp : undefined };
  });
  return { ...metadata, ...frame, moves, energy: Number.isFinite(frame.energy) ? frame.energy : undefined } as SnapFighter;
}

export type MoveSlot = { slot: number; name: string; type?: string; pp?: number; remainingPp?: number; phase?: string; empty: boolean; unknown: boolean; exhausted: boolean };
export type MovePanelState = { name: string; energy?: number; slots: MoveSlot[]; ppMissing: boolean; equipmentMissing: boolean; pending: boolean; extraAction?: string };

export function movePanelState(f: SnapFighter | undefined, index = 0, preview = false): MovePanelState {
  const equipmentMissing = !f || !Array.isArray(f.moves);
  const pending = preview && equipmentMissing;
  const activePhase = f?.cast ? PHASE_NAMES[f.cast.phase ?? f.phase ?? ""] : undefined;
  const slots = Array.from({ length: 4 }, (_, slot): MoveSlot => {
    const move = f?.moves?.[slot];
    if (!move) return { slot, name: pending ? "等待开赛" : equipmentMissing ? "未记录" : "未学会", empty: !equipmentMissing, unknown: equipmentMissing, exhausted: false };
    const fallback = catalog.get(move.id), pp = move.pp ?? fallback?.pp;
    const remainingPp = Number.isFinite(move.remainingPp) ? Math.max(0, move.remainingPp!) : undefined;
    return { slot, name: move.name ?? fallback?.name ?? `招式 #${move.id}`, type: move.type ?? fallback?.type, pp,
      remainingPp, phase: f?.cast?.moveId === move.id ? activePhase : undefined, empty: false,
      unknown: remainingPp === undefined, exhausted: remainingPp === 0 };
  });
  const extraMove = f?.cast && !f.moves?.some((m) => m.id === f.cast!.moveId) ? catalog.get(f.cast.moveId) : undefined;
  return { name: f?.name || `精灵 ${index + 1}`, energy: f?.energy, slots,
    ppMissing: slots.some((s) => s.unknown && !s.empty), equipmentMissing, pending,
    extraAction: extraMove && activePhase ? `${extraMove.name} · ${activePhase}` : undefined };
}
