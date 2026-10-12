// Small shared helpers for the broadcast arena renderer.
export type Vec = { u: number; v: number };

/** Deterministic xorshift RNG so stages/crowds look identical for a given battle. */
export class Rand {
  private s: number;
  constructor(seed: number) {
    this.s = seed >>> 0 || 0x9e3779b9;
  }
  next() {
    let x = this.s;
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    this.s = x >>> 0;
    return this.s / 4294967296;
  }
  range(a: number, b: number) {
    return a + (b - a) * this.next();
  }
  int(a: number, b: number) {
    return Math.floor(this.range(a, b + 1));
  }
  pick<T>(list: readonly T[]): T {
    return list[Math.min(list.length - 1, Math.floor(this.next() * list.length))];
  }
}

export const clamp = (x: number, a: number, b: number) => Math.max(a, Math.min(b, x));
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const ease = (t: number) => 1 - Math.pow(1 - clamp(t, 0, 1), 3);
export const easeInOut = (t: number) => {
  t = clamp(t, 0, 1);
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
};

/** Server arena is landscape (x -7..7, z -5..5). The broadcast stage is portrait:
 * screen-right = server z, screen-down = -server x (host side at the bottom). */
export const toWorld = (x: number, z: number): Vec => ({ u: z, v: -x });

export function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  const n = parseInt(h.length === 3 ? h.split("").map((c) => c + c).join("") : h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
export function rgba(hex: string, a: number) {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${r},${g},${b},${a})`;
}
export function shade(hex: string, amount: number) {
  const [r, g, b] = hexToRgb(hex);
  const f = (c: number) => clamp(Math.round(amount < 0 ? c * (1 + amount) : c + (255 - c) * amount), 0, 255);
  return `#${[f(r), f(g), f(b)].map((c) => c.toString(16).padStart(2, "0")).join("")}`;
}

export const TYPE_HUD: Record<string, string> = {
  normal: "#a8a77a",
  fire: "#ee8130",
  water: "#6390f0",
  electric: "#e8c51c",
  grass: "#5fbd3a",
  ice: "#66d1cc",
  fighting: "#c22e28",
  poison: "#a33ea1",
  ground: "#d6b55a",
  flying: "#8f7ff0",
  psychic: "#f95587",
  bug: "#a6b91a",
  rock: "#b6a136",
  ghost: "#735797",
  dragon: "#6f35fc",
};
