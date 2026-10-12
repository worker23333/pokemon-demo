export type Species = {
  id: number;
  name: string;
  nameEn: string;
  types: string[];
  stats: {
    hp: number;
    attack: number;
    defense: number;
    speed: number;
    special: number;
  };
  color: string;
  habitat: string;
  evolvesTo: number[];
  sprite: string;
};
export type Region = {
  id: string;
  name: string;
  kind: string;
  description: string;
  connections: string[];
  species: number[];
  x: number;
  y: number;
  unlockBadge?: number | string;
};
export type KnownMove = { id: number; name: string; type: string; pp: number; remainingPp: number };
export type BattleCommand = "attack" | "dodge" | "defend" | "retreat" | "move" | "weaken" | "hold";
export type BattleCommandOption = { command: BattleCommand; moveId?: number; label: string; disabled: boolean; reason?: string };
export type Individual = {
  id: string;
  speciesId: number;
  nickname: string;
  level: number;
  xp: number;
  bond: number;
  hp: number;
  maxHp: number;
  style: string;
  natureId?: string;
  personality?: {
    id: string;
    name: string;
    description: string;
    dialogueStyle: string;
    preferredTactics: string[];
    battleStyle: string;
    mechanicsNote: string;
  };
  trainingEpisodes: number;
  policyVersion: number;
  moves?: KnownMove[];
  movePp?: { moveId: number; remainingPp: number }[];
};
export type MemoryFactKey = "trainer_name" | "likes" | "dislikes" | "promise";
export type MemoryProfile = {
  facts: { key: MemoryFactKey; value: string; sourceMemoryId: string; updated: number }[];
  overview: { battles: number; trainingSessions: number };
  archivedCount: number;
};
export type PlayerState = {
  user: { id: string; username: string };
  party: Individual[];
  inventory: { pokeball: number; potion: number };
  coins: number;
  regionId: string;
  badges: any[];
  history: any[];
  activeBattleId?: string | null;
  recovery?: { available: boolean; label: string };
};
export type Encounter = {
  id: string;
  speciesId: number;
  level: number;
  mood: string;
  captured?: boolean;
  defeated?: boolean;
};
export type Battle = {
  id: string;
  engineVersion?: number;
  status: string;
  tick: number;
  timeLeft: number;
  winner?: string | null;
  outcome?: "captured";
  capture?: { encounterId: string; canThrow: boolean; reason?: string; ownHp: number; targetHp: number; targetMaxHp: number; healthBonus: number } | null;
  fighters: {
    id: string;
    speciesId: number;
    name: string;
    hp: number;
    maxHp: number;
    x: number;
    z: number;
    action: string;
    level: number;
    side?: number;
    types?: string[];
    status?: string | null;
    guardUntil?: number;
    energy?: number;
    moves?: KnownMove[];
    commandOptions?: BattleCommandOption[];
    commandCooldownMs?: number;
    activeCommand?: { command: BattleCommand; moveId?: number; expiresTick: number } | null;
    captureMode?: "weaken" | "hold" | null;
  }[];
  /** Presentation events; structured fields are additive (see CONTRACT.md). */
  events: { tick: number; text: string; kind?: string; actor?: string; [key: string]: any }[];
  projectiles?: { id: string; x: number; z: number; type: string; side?: number; targetX?: number; targetZ?: number; move?: { id: number; [key: string]: any } }[];
  arena?: { theme: string; seed: number };
  result?: any;
};
export let token = localStorage.getItem("kanto-token") || "";
export function setToken(value: string) {
  token = value;
  localStorage.setItem("kanto-token", value);
}
export class ApiError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}
export async function api<T = any>(path: string, body?: unknown, method?: string): Promise<T> {
  const response = await fetch("/api" + path, {
    method: method || (body === undefined ? "GET" : "POST"),
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await response
    .json()
    .catch(() => ({ detail: "服务返回了无法读取的数据" }));
  if (!response.ok)
    throw new ApiError(
      typeof data.detail === "string"
        ? data.detail
        : JSON.stringify(data.detail || "请求失败"), response.status,
    );
  return data;
}
export const esc = (value: unknown) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
export const pad = (id: number) => String(id).padStart(3, "0");
export function requestId() {
  // getRandomValues is also available on local HTTP phone previews.
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
export const sprite = (id: number) => `/assets/pokemon/${id}.png`;
export const typeNames: Record<string, string> = {
  normal: "一般",
  fire: "火",
  water: "水",
  electric: "电",
  grass: "草",
  ice: "冰",
  fighting: "格斗",
  poison: "毒",
  ground: "地面",
  flying: "飞行",
  psychic: "超能",
  bug: "虫",
  rock: "岩石",
  ghost: "幽灵",
  dragon: "龙",
};
export const typeColors: Record<string, string> = {
  normal: "#a29782",
  fire: "#db7855",
  water: "#6b9eb5",
  electric: "#caa84d",
  grass: "#79a16b",
  ice: "#6fb8b4",
  fighting: "#b2785e",
  poison: "#a487b0",
  ground: "#ba9a6b",
  flying: "#a0adbc",
  psychic: "#c48f9f",
  bug: "#939c56",
  rock: "#9d9579",
  ghost: "#91819d",
  dragon: "#708594",
};
