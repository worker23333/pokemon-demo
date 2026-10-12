// Particle + effect primitives for the arena. Units are world units; drawing
// converts through the camera. Two layers: "ground" (under fighters) and
// "top" (over fighters). Additive blending for energy effects.
import { clamp, rgba, Rand } from "./util";

export interface Cam {
  /** world → canvas pixels */
  x(u: number): number;
  y(v: number): number;
  /** canvas px per world unit */
  s: number;
  dpr: number;
}

export type PKind =
  | "sq" | "glow" | "smoke" | "spark" | "star" | "ring" | "leaf" | "bubble" | "flake"
  | "glyph" | "text" | "shard" | "ember" | "petal";

export type Particle = {
  kind: PKind;
  u: number; v: number; z: number;
  vu: number; vv: number; vz: number;
  life: number; max: number;
  size: number; grow: number;
  color: string; color2?: string;
  drag: number; grav: number;
  rot: number; vrot: number;
  add: boolean;
  text?: string;
  font?: number;
  ground?: boolean;
  delay?: number;
  tag?: string;
  opacity?: number;
};

export type Effect = {
  t: number;
  dur: number;
  layer: "ground" | "top";
  draw: (g: CanvasRenderingContext2D, cam: Cam, k: number, t: number) => void;
  update?: (dt: number, t: number) => void;
  delay?: number;
};

const R = new Rand(20261005);
export const rnd = (a = 0, b = 1) => R.range(a, b);

export class Fx {
  particles: Particle[] = [];
  effects: Effect[] = [];
  reduced = false;

  spawn(p: Partial<Particle> & { u: number; v: number }) {
    if (this.particles.length > 1600) this.particles.shift();
    const q: Particle = {
      kind: "sq", z: 0, vu: 0, vv: 0, vz: 0, life: 0, max: 0.6, size: 0.12, grow: 0,
      color: "#fff", drag: 1.5, grav: 0, rot: 0, vrot: 0, add: false, ...p,
    };
    this.particles.push(q);
    return q;
  }

  add(e: Omit<Effect, "t"> & { t?: number }) {
    this.effects.push({ t: 0, ...e } as Effect);
  }

  burst(u: number, v: number, n: number, opts: Partial<Particle> & { speed?: number; spread?: number; dir?: number; z?: number }) {
    const { speed = 4, spread = Math.PI * 2, dir = 0, ...rest } = opts;
    for (let i = 0; i < n; i++) {
      const a = dir + (rnd() - 0.5) * spread;
      const sp = speed * rnd(0.35, 1);
      this.spawn({ u, v, vu: Math.cos(a) * sp, vv: Math.sin(a) * sp, max: rnd(0.35, 0.8), ...rest, rot: rnd(0, 6.3) });
    }
  }

  text(u: number, v: number, text: string, color: string, font = 16, opts: Partial<Particle> = {}) {
    // A tagged label replaces the previous one with the same tag (e.g. combo counters).
    if (opts.tag) for (const p of this.particles) if (p.tag === opts.tag) p.life = Math.max(p.life, p.max);
    return this.spawn({ kind: "text", u, v, z: 1.6, vz: 1.4, text, color, font, max: 1.1, drag: 0, grav: 0, ...opts });
  }

  /** Update a rolling damage label in place, avoiding stacked channel ticks. */
  damage(u:number,v:number,total:number,color:string,font:number,key:string,continued:boolean) {
    const tag='damage-'+key;
    const existing=continued?this.particles.find(p=>p.tag===tag&&p.life<p.max):undefined;
    if(existing){existing.text=String(Math.round(total));existing.life=Math.min(existing.life,.13);existing.max=1.05;existing.u=u;existing.v=v;existing.z=1.65;existing.color=color;existing.font=font;return existing;}
    return this.text(u,v,String(Math.round(total)),color,font,{tag,z:1.65,max:1.05});
  }

  update(dt: number) {
    for (const p of this.particles) {
      if (p.delay && p.delay > 0) {
        p.delay -= dt;
        continue;
      }
      p.life += dt;
      const d = Math.exp(-p.drag * dt);
      p.vu *= d;
      p.vv *= d;
      if (p.kind !== "text") p.vz *= d;
      p.vz -= p.grav * dt;
      p.u += p.vu * dt;
      p.v += p.vv * dt;
      p.z += p.vz * dt;
      if (p.grav && p.z < 0) {
        p.z = 0;
        p.vz = -p.vz * 0.35;
        p.vu *= 0.6;
        p.vv *= 0.6;
      }
      p.size += p.grow * dt;
      p.rot += p.vrot * dt;
    }
    this.particles = this.particles.filter((p) => p.life < p.max);
    for (const e of this.effects) {
      if (e.delay && e.delay > 0) {
        e.delay -= dt;
        continue;
      }
      e.t += dt;
      e.update?.(dt, e.t);
    }
    this.effects = this.effects.filter((e) => e.t < e.dur);
  }

  drawEffects(g: CanvasRenderingContext2D, cam: Cam, layer: "ground" | "top") {
    for (const e of this.effects) {
      if (e.layer !== layer || (e.delay && e.delay > 0)) continue;
      g.save();
      e.draw(g, cam, clamp(e.t / e.dur, 0, 1), e.t);
      g.restore();
    }
  }

  drawParticles(g: CanvasRenderingContext2D, cam: Cam, ground: boolean) {
    for (const p of this.particles) {
      if (!!p.ground !== ground || (p.delay && p.delay > 0)) continue;
      const k = p.life / p.max;
      const x = cam.x(p.u), y = cam.y(p.v) - p.z * cam.s * 0.9;
      const s = Math.max(1, p.size * cam.s);
      const a = p.kind === "text" ? (k < 0.75 ? 1 : 1 - (k - 0.75) / 0.25) : 1 - k;
      g.globalAlpha = clamp(a * (p.opacity ?? 1), 0, 1);
      g.globalCompositeOperation = p.add ? "lighter" : "source-over";
      switch (p.kind) {
        case "sq":
        case "ember":
          g.fillStyle = p.color;
          g.fillRect(Math.round(x - s / 2), Math.round(y - s / 2), Math.ceil(s), Math.ceil(s));
          break;
        case "glow": {
          const grd = g.createRadialGradient(x, y, 0, x, y, s);
          grd.addColorStop(0, p.color2 || "#fff");
          grd.addColorStop(0.35, p.color);
          grd.addColorStop(1, rgba(p.color.startsWith("#") ? p.color : "#ffffff", 0));
          g.fillStyle = grd;
          g.beginPath();
          g.arc(x, y, s, 0, Math.PI * 2);
          g.fill();
          break;
        }
        case "smoke":
          g.globalAlpha = clamp(a * (p.opacity ?? .55), 0, 1);
          g.fillStyle = p.color;
          g.beginPath();
          g.arc(x, y, s, 0, Math.PI * 2);
          g.fill();
          break;
        case "spark": {
          const len = Math.hypot(p.vu, p.vv) * cam.s * 0.05 + s;
          const ang = Math.atan2(p.vv, p.vu);
          g.strokeStyle = p.color;
          g.lineWidth = Math.max(1, s * 0.5);
          g.beginPath();
          g.moveTo(x - Math.cos(ang) * len, y - Math.sin(ang) * len);
          g.lineTo(x, y);
          g.stroke();
          break;
        }
        case "star":
          drawStar(g, x, y, s, p.rot, p.color, 4);
          break;
        case "ring":
          g.strokeStyle = p.color;
          g.lineWidth = Math.max(1, cam.s * 0.08 * (1 - k) + 1);
          g.beginPath();
          g.ellipse(x, y, s, s * 0.8, 0, 0, Math.PI * 2);
          g.stroke();
          break;
        case "leaf":
        case "petal":
          g.save();
          g.translate(x, y);
          g.rotate(p.rot);
          g.fillStyle = p.color;
          g.beginPath();
          g.ellipse(0, 0, s, s * 0.45, 0, 0, Math.PI * 2);
          g.fill();
          if (p.kind === "leaf") {
            g.strokeStyle = p.color2 || "rgba(0,0,0,.3)";
            g.lineWidth = 1;
            g.beginPath();
            g.moveTo(-s, 0);
            g.lineTo(s, 0);
            g.stroke();
          }
          g.restore();
          break;
        case "bubble":
          g.strokeStyle = p.color;
          g.lineWidth = Math.max(1, s * 0.18);
          g.beginPath();
          g.arc(x, y, s, 0, Math.PI * 2);
          g.stroke();
          g.fillStyle = "rgba(255,255,255,.8)";
          g.fillRect(x - s * 0.45, y - s * 0.5, Math.max(1, s * 0.3), Math.max(1, s * 0.3));
          break;
        case "flake":
          g.fillStyle = p.color;
          g.fillRect(Math.round(x - s / 2), Math.round(y - s / 6), Math.ceil(s), Math.ceil(s / 3));
          g.fillRect(Math.round(x - s / 6), Math.round(y - s / 2), Math.ceil(s / 3), Math.ceil(s));
          break;
        case "shard":
          g.save();
          g.translate(x, y);
          g.rotate(p.rot);
          g.fillStyle = p.color;
          g.beginPath();
          g.moveTo(-s, -s * 0.4);
          g.lineTo(s * 0.8, -s * 0.6);
          g.lineTo(s, s * 0.5);
          g.lineTo(-s * 0.6, s * 0.6);
          g.fill();
          g.restore();
          break;
        case "glyph":
          g.font = `900 ${Math.round(s * 2)}px system-ui, sans-serif`;
          g.textAlign = "center";
          g.textBaseline = "middle";
          g.fillStyle = p.color;
          g.fillText(p.text || "", x, y);
          break;
        case "text": {
          const pop = k < 0.12 ? 0.6 + (k / 0.12) * 0.7 : k < 0.22 ? 1.3 - ((k - 0.12) / 0.1) * 0.3 : 1;
          const size = Math.round((p.font || 16) * cam.dpr * pop);
          g.font = `900 ${size}px "Arial Black", "Helvetica Neue", system-ui, sans-serif`;
          g.textAlign = "center";
          g.textBaseline = "middle";
          g.lineJoin = "round";
          g.lineWidth = Math.max(2, size * 0.22);
          g.strokeStyle = p.color2 || "#1a1020";
          g.strokeText(p.text || "", x, y);
          g.fillStyle = p.color;
          g.fillText(p.text || "", x, y);
          break;
        }
      }
    }
    g.globalAlpha = 1;
    g.globalCompositeOperation = "source-over";
  }
}

export function drawStar(g: CanvasRenderingContext2D, x: number, y: number, r: number, rot: number, color: string, points = 5, inner = 0.42) {
  g.fillStyle = color;
  g.beginPath();
  for (let i = 0; i < points * 2; i++) {
    const a = rot + (i * Math.PI) / points - Math.PI / 2;
    const d = i % 2 ? r * inner : r;
    i ? g.lineTo(x + Math.cos(a) * d, y + Math.sin(a) * d) : g.moveTo(x + Math.cos(a) * d, y + Math.sin(a) * d);
  }
  g.closePath();
  g.fill();
}

/** Spiky comic impact burst (white star with coloured rim), as on every hit in the footage. */
export function impactStar(g: CanvasRenderingContext2D, x: number, y: number, r: number, k: number, color: string, spikes = 10) {
  const grow = r * (0.55 + 0.6 * Math.min(1, k * 3));
  g.globalAlpha = 1 - k;
  g.globalCompositeOperation = "lighter";
  const rng = new Rand(Math.floor(x * 13 + y * 7));
  g.fillStyle = color;
  g.beginPath();
  for (let i = 0; i < spikes * 2; i++) {
    const a = (i * Math.PI) / spikes;
    const d = i % 2 ? grow * 0.45 : grow * rng.range(0.85, 1.25);
    i ? g.lineTo(x + Math.cos(a) * d, y + Math.sin(a) * d) : g.moveTo(x + Math.cos(a) * d, y + Math.sin(a) * d);
  }
  g.closePath();
  g.fill();
  g.globalCompositeOperation = "source-over";
  drawStar(g, x, y, grow * 0.72, 0.2, "#ffffff", spikes, 0.5);
}

/** Wavy energy beam with glow, core and white-hot centre. */
export function beam(
  g: CanvasRenderingContext2D,
  x0: number, y0: number, x1: number, y1: number,
  width: number, color: string, color2: string, t: number, wobble = 0.15, alpha = 1,
) {
  const len = Math.hypot(x1 - x0, y1 - y0);
  if (len < 2) return;
  const nx = -(y1 - y0) / len, ny = (x1 - x0) / len;
  const steps = Math.max(6, Math.round(len / 10));
  const path = (w: number, phase: number) => {
    g.beginPath();
    for (let i = 0; i <= steps; i++) {
      const f = i / steps;
      const off = Math.sin(f * 9 - t * 22 + phase) * width * wobble * Math.sin(f * Math.PI);
      const x = x0 + (x1 - x0) * f + nx * off, y = y0 + (y1 - y0) * f + ny * off;
      i ? g.lineTo(x, y) : g.moveTo(x, y);
    }
    g.lineWidth = w;
    g.stroke();
  };
  g.lineCap = "round";
  g.lineJoin = "round";
  g.globalCompositeOperation = "lighter";
  g.globalAlpha = 0.35 * alpha;
  g.strokeStyle = color;
  path(width * 2.2, 0);
  g.globalAlpha = 0.9 * alpha;
  path(width, 0.6);
  g.globalAlpha = alpha;
  g.strokeStyle = color2;
  path(width * 0.55, 1.2);
  g.strokeStyle = "#ffffff";
  path(Math.max(1, width * 0.22), 1.8);
  g.globalCompositeOperation = "source-over";
  g.globalAlpha = 1;
}

/** Jagged lightning polyline between two points. */
export function lightning(g: CanvasRenderingContext2D, x0: number, y0: number, x1: number, y1: number, width: number, color: string, seed: number, jag = 0.18) {
  const r = new Rand(seed);
  const len = Math.hypot(x1 - x0, y1 - y0);
  const nx = -(y1 - y0) / (len || 1), ny = (x1 - x0) / (len || 1);
  const n = Math.max(4, Math.round(len / 14));
  const pts: [number, number][] = [[x0, y0]];
  for (let i = 1; i < n; i++) {
    const f = i / n, off = r.range(-1, 1) * len * jag * Math.sin(f * Math.PI);
    pts.push([x0 + (x1 - x0) * f + nx * off, y0 + (y1 - y0) * f + ny * off]);
  }
  pts.push([x1, y1]);
  g.globalCompositeOperation = "lighter";
  g.lineJoin = "miter";
  for (const [w, c, a] of [[width * 3, color, 0.35], [width, color, 1], [Math.max(1, width * 0.4), "#ffffff", 1]] as [number, string, number][]) {
    g.globalAlpha = a;
    g.strokeStyle = c;
    g.lineWidth = w;
    g.beginPath();
    pts.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
    g.stroke();
  }
  g.globalCompositeOperation = "source-over";
  g.globalAlpha = 1;
}

/** Crescent slash arc. */
export function slashArc(g: CanvasRenderingContext2D, x: number, y: number, r: number, angle: number, k: number, color: string) {
  const sweep = Math.PI * 0.9;
  const head = Math.min(1, k * 2.4);
  const tail = Math.max(0, k * 2.4 - 0.9);
  g.globalCompositeOperation = "lighter";
  g.globalAlpha = 1 - Math.max(0, k - 0.5) * 2;
  g.strokeStyle = color;
  g.lineCap = "round";
  for (const [w, c] of [[r * 0.22, color], [r * 0.09, "#ffffff"]] as [number, string][]) {
    g.strokeStyle = c;
    g.lineWidth = w;
    g.beginPath();
    g.arc(x, y, r, angle - sweep / 2 + sweep * tail, angle - sweep / 2 + sweep * head);
    g.stroke();
  }
  g.globalCompositeOperation = "source-over";
  g.globalAlpha = 1;
}
