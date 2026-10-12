import type { Battle, BattleCommand, BattleCommandOption, KnownMove } from "../../apps/web/api";
import type { Snapshot, SnapFighter } from "../../apps/web/arena/types";

export type GammaFieldPoint = { x: number; z: number };
export type GammaField = {
  mapId: string; origin: GammaFieldPoint; playerStart: GammaFieldPoint; opponentStart: GammaFieldPoint;
  obstacles: { id: string; x: number; z: number; radius: number; hp: number | null; solid: boolean; kind: string }[];
  terrain: { cellSize: number; cols: number; rows: number; x0: number; z0: number; heights: (number | null)[]; maxStep?: number };
};
export type GammaCommand = BattleCommand | "navigate";
export type GammaCommandInput = { command: BattleCommand; moveId?: number } | { command: "navigate"; target: GammaFieldPoint };

export type GammaBattle = Omit<Snapshot, "fighters"> & {
  fighters: (SnapFighter & { moves: KnownMove[]; commandOptions: BattleCommandOption[];
    groundY?: number; commandCooldownMs: number; activeCommand?: { command: GammaCommand; moveId?: number; target?: GammaFieldPoint; expiresTick: number } | null })[];
  playerId: string;
  opponentId: string;
  playerSpeciesId: number;
  opponentSpeciesId: number;
  timeLeft: number;
  engineVersion: number;
  ruleset: string;
  tickRate: number;
  source: "authoritative-live-memory";
  seed: number;
  persisted: false;
  capture: null;
  encounterId: string | null;
  bridgeSessionId: string | null;
  bounds?: { x: number; z: number };
  field?: GammaField & { destroyed: string[] };
  stats?: { dodged: number[]; hits: number[]; missed: number[]; casts: number[]; clashes: number };
};

export type GammaBattleOptions = {
  playerSpeciesId?: number;
  opponentSpeciesId?: number;
  level?: number;
  theme?: "grass" | "dirt" | "stone" | "water" | "rocks" | "crystal" | "lava" | "neon";
  seed?: number;
  playerState?: GammaPlayerState;
  encounterId?: string;
  bridgeSessionId?: string;
  field?: GammaField;
};

export type GammaPlayerState = {
  hp: number;
  movePp: { moveId: number; remainingPp: number }[];
};

export type GammaHealth = {
  ok: boolean; source: "authoritative-live-memory"; engineVersion: number; ruleset: string;
  tickRate: number; persisted: false; activeBattles: number; maxBattles: number;
  commandCooldownMs: number; commandDurationMs: number;
};

export type GammaCommandResponse = {
  accepted: boolean; command: GammaCommand; moveId?: number; target?: GammaFieldPoint; expiresTick: number;
  message: string; cooldownMs: number; snapshot: GammaBattle;
};

export class GammaApiError extends Error {
  constructor(message: string, public status: number, public retryAfterMs = 0) {
    super(message);
    this.name = "GammaApiError";
  }
}

async function request<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`/api/gamma${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  let data: unknown;
  try { data = await response.json(); }
  catch { throw new GammaApiError("演示服务返回了无法读取的数据。", response.status); }
  if (!response.ok) {
    const detail = (data as { detail?: unknown })?.detail;
    throw new GammaApiError(typeof detail === "string" ? detail : `演示请求失败 (${response.status})`,
      response.status, Math.max(0, Number(response.headers.get("Retry-After")) || 0) * 1000);
  }
  return data as T;
}

export const getGammaHealth = () => request<GammaHealth>("/health");
export const createGammaBattle = (options: GammaBattleOptions = {}) => request<GammaBattle>("/battles", options);
export const getGammaBattle = (id: string) => request<GammaBattle>(`/battles/${encodeURIComponent(id)}`);
export const sendGammaCommand = (id: string, command: BattleCommand, moveId?: number) =>
  request<GammaCommandResponse>(`/battles/${encodeURIComponent(id)}/command`,
    { command, ...(moveId === undefined ? {} : { moveId }) });
export const sendGammaNavigate = (id: string, target: GammaFieldPoint) =>
  request<GammaCommandResponse>(`/battles/${encodeURIComponent(id)}/command`, { command: "navigate", target });

/** Use with the shared command/feedback helpers without importing the production token store. */
export const asBattle = (snapshot: GammaBattle): Battle => snapshot as unknown as Battle;
