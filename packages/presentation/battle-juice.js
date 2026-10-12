// Pure presentation policy shared by Web and WeChat. No combat state is changed.
const TIERS = {
  light:  { hitstop: .06, shake: .15, zoom: 0, recoil: .08 },
  medium: { hitstop: .08, shake: .30, zoom: .04, recoil: .16 },
  heavy:  { hitstop: .12, shake: .55, zoom: .075, recoil: .26 },
  crit:   { hitstop: .16, shake: .90, zoom: .12, recoil: .35 },
};
export function impactProfile(power, effectiveness = 1, delivery = '', big = false, guarded = false) {
  power = Math.max(0, Math.min(1, Number(power) || 0));
  const continuous = ['channel', 'beam', 'stream'].includes(delivery);
  const tier = guarded ? 'light' : power >= .35 || (big && power >= .2) ? 'crit'
    : power >= .18 || (effectiveness > 1 && power >= .07) ? 'heavy' : power >= .07 ? 'medium' : 'light';
  return { tier, ...TIERS[tier], continuous, bypassCooldown: tier === 'heavy' || tier === 'crit',
    flashDisc: tier !== 'light', rays: tier === 'heavy' || tier === 'crit', boom: tier === 'crit' };
}

/** Offset only the painted body; callers keep physics, shadow and labels anchored. */
export function sampleRecoil(fighter, time, reduced = false) {
  const neutral = { u: 0, v: 0, stretchX: 1, stretchY: 1, flash: 0 };
  if (reduced || !Number.isFinite(fighter.recoilAt)) return neutral;
  const age = Math.max(0, time - fighter.recoilAt), duration = .22;
  if (age >= duration) return neutral;
  const magnitude = Math.min(.35, Math.max(0, fighter.recoilStrength || 0));
  const len = Math.hypot(fighter.recoilDirU || 0, fighter.recoilDirV || 0) || 1;
  const envelope = Math.pow(1 - age / duration, 2) * Math.cos(age / duration * Math.PI * .65);
  const compression = Math.max(0, 1 - age / .08);
  return { u: (fighter.recoilDirU || 0) / len * magnitude * envelope,
    v: (fighter.recoilDirV || 0) / len * magnitude * envelope,
    stretchX: 1 + compression * .25, stretchY: 1 - compression * .2,
    flash: age < 1 / 30 ? 1 : Math.max(0, 1 - (age - 1 / 30) / .085) };
}

/** A sliding window keeps a continuous channel in one readable rolling number. */
export class DamageAccumulator {
  constructor(window = .6) { this.window = window; this.entries = new Map(); }
  add(source, target, moveId, amount, time, continuous = true) {
    const key = `${source || ''}:${target}:${moveId || 0}`;
    const previous = this.entries.get(key);
    const continued = continuous && !!previous && time >= previous.time && time - previous.time <= this.window;
    const total = Math.max(0, Number(amount) || 0) + (continued ? previous.total : 0);
    this.entries.set(key, { total, time });
    for (const [id, entry] of this.entries) if (time - entry.time > this.window + 2) this.entries.delete(id);
    return { key, total, continued };
  }
  clear() { this.entries.clear(); }
}

export class CalloutGate {
  constructor() { this.last = new Map(); }
  allow(actor, moveId, time, supportive) {
    if (!supportive) return true;
    const key = `${actor}:${moveId}`, last = this.last.get(key);
    if (last != null && time >= last && time - last < 4) return false;
    this.last.set(key, time);
    return true;
  }
  clear() { this.last.clear(); }
}
