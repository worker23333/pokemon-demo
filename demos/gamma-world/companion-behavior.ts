export type CompanionFacing = { x: number; z: number };
export type CompanionAmbient = {
  mode: 'rest' | 'look' | 'gesture';
  seconds: number;
  duration: number;
  action: 'Idle' | 'Pose';
  stillFrame: boolean;
  /** Increments when an occasional action starts, never once per render. */
  event: number;
};
export type CompanionBehaviorSample = {
  moving: boolean;
  facing: CompanionFacing;
  ambient: CompanionAmbient;
};

const turnDelta = (a: number, b: number) => Math.atan2(Math.sin(b - a), Math.cos(b - a));
const smooth = (t: number) => { const v = Math.max(0, Math.min(1, t)); return v * v * (3 - 2 * v); };
function facingAngle(facing: CompanionFacing, fallback: number) {
  return Number.isFinite(facing.x) && Number.isFinite(facing.z) && Math.hypot(facing.x, facing.z) > .0001
    ? Math.atan2(facing.z, facing.x) : fallback;
}
function seedValue(seed: number | string) {
  if (typeof seed === 'number') return (Number.isFinite(seed) ? seed >>> 0 : 1) || 1;
  let hash = 2166136261;
  for (const char of seed) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return hash >>> 0 || 1;
}

/** Exploration-only attention. This changes facing and authored frame selection;
 * it never changes the follower's ground position, body scale or elevation.
 * Randomness is consumed only at scheduled transitions, not every frame. */
export class CompanionBehavior {
  private randomState: number;
  private draws = 0;
  private initialized = false;
  private wasMoving = false;
  private angle = -Math.PI / 2;
  private baseAngle = this.angle;
  private mode: CompanionAmbient['mode'] = 'rest';
  private elapsed = 0;
  private duration = 0;
  private excursion = 0;
  private event = 0;

  constructor(seed: number | string = 1) {
    this.randomState = seedValue(seed);
    this.rest();
  }

  get randomDraws() { return this.draws; }

  private random() {
    let x = this.randomState;
    x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
    this.randomState = x >>> 0;
    this.draws++;
    return this.randomState / 4294967296;
  }

  private rest() {
    this.mode = 'rest'; this.elapsed = 0;
    this.duration = 3.5 + this.random() * 3.5;
    this.excursion = 0;
  }

  private startAction() {
    this.mode = this.random() < .3 ? 'gesture' : 'look';
    this.duration = this.mode === 'look' ? 1.6 + this.random() * .7 : .65 + this.random() * .25;
    this.excursion = (this.random() < .5 ? -1 : 1) * (this.mode === 'look' ? .8 + this.random() * .3 : .18);
    this.elapsed = 0; this.event++;
  }

  private turnToward(target: number, dt: number) {
    this.angle += turnDelta(this.angle, target) * (1 - Math.exp(-9 * dt));
    this.angle = Math.atan2(Math.sin(this.angle), Math.cos(this.angle));
  }

  step(dt: number, input: { moving: boolean; facing: CompanionFacing }): CompanionBehaviorSample {
    // A hidden-tab pause can advance scheduling, but invalid/negative clocks
    // cannot poison direction. Sixty seconds also bounds catch-up work.
    let remaining = Number.isFinite(dt) ? Math.max(0, Math.min(60, dt)) : 0;
    const moving = !!input.moving;
    const desired = facingAngle(input.facing, this.baseAngle);
    if (!this.initialized) { this.angle = this.baseAngle = desired; this.initialized = true; }
    if (moving) {
      if (!this.wasMoving && this.mode !== 'rest') this.rest();
      this.mode = 'rest'; this.elapsed = 0; this.baseAngle = desired;
      this.turnToward(desired, remaining);
    } else {
      if (this.wasMoving) { this.baseAngle = desired; this.rest(); }
      while (remaining > 0) {
        const chunk = Math.min(remaining, this.duration - this.elapsed);
        this.elapsed += chunk; remaining -= chunk;
        const progress = this.elapsed / this.duration;
        const envelope = smooth(progress / .25) * (1 - smooth((progress - .6) / .4));
        this.turnToward(this.baseAngle + this.excursion * envelope, chunk);
        if (this.elapsed >= this.duration - 1e-10) {
          if (this.mode === 'rest') this.startAction(); else this.rest();
        }
      }
    }
    this.wasMoving = moving;
    return { moving, facing: { x: Math.cos(this.angle), z: Math.sin(this.angle) }, ambient: {
      mode: this.mode, seconds: this.elapsed, duration: this.duration,
      action: this.mode === 'gesture' ? 'Pose' : 'Idle', stillFrame: this.mode !== 'gesture', event: this.event,
    } };
  }
}
