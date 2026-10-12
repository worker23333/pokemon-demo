// PMD sheet rows, verified against PMDCollab/SpriteBot Constants.py.
// Screen-space u points right and v points down. No simulation state is changed.
export const PMD_DIRECTIONS = Object.freeze(['Down', 'DownRight', 'Right', 'UpRight', 'Up', 'UpLeft', 'Left', 'DownLeft']);
export const PMD_ACTIONS = Object.freeze(['Idle', 'Walk', 'Attack', 'Strike', 'Shoot', 'Charge', 'Hurt', 'Sleep', 'Hop', 'Faint']);
export const PMD_FALLBACKS = Object.freeze({
  Idle: ['Idle', 'Walk'], Walk: ['Walk', 'Idle'], Attack: ['Attack', 'Strike', 'Idle'],
  Strike: ['Strike', 'Attack', 'Idle'], Shoot: ['Shoot', 'SpAttack', 'Attack', 'Idle'],
  Charge: ['Charge', 'SpAttack', 'Idle'], Hurt: ['Hurt', 'Pain', 'Idle'],
  Sleep: ['Sleep', 'EventSleep', 'Idle'], Hop: ['Hop', 'Walk', 'Idle'], Faint: ['Faint', 'Laying', 'Hurt', 'Idle'],
});

export function pmdDirectionIndex(u, v, previous = 0) {
  if (!Number.isFinite(u) || !Number.isFinite(v) || Math.hypot(u, v) < .001) return ((previous % 8) + 8) % 8;
  return (Math.round(Math.atan2(u, v) / (Math.PI / 4)) + 8) % 8;
}

// Rebuild direction changes from recorded ticks, so seeking/rewinding is stable.
export function samplePmdDirection(samples, tick, holdTicks = 1.6) {
  let row = 0, pending = null, since = 0, initialized = false;
  for (const sample of (samples || []).filter(s => Number.isFinite(s.tick) && s.tick <= tick).sort((a, b) => a.tick - b.tick)) {
    if (pending !== null && sample.tick - since >= holdTicks) { row = pending; pending = null; }
    const candidate = pmdDirectionIndex(sample.u, sample.v, row);
    if (!initialized) { row = candidate; initialized = true; continue; }
    if (candidate === row) { pending = null; continue; }
    if (candidate !== pending) { pending = candidate; since = sample.tick; }
    if (sample.tick - since >= holdTicks) { row = candidate; pending = null; }
  }
  if (pending !== null && tick - since >= holdTicks) row = pending;
  return row;
}

export function pmdActionFor(f) {
  if (f.fainted > 0 || f.hp === 0) return 'Faint';
  if (f.hurt > 0) return 'Hurt';
  if (f.status === 'sleep') return 'Sleep';
  if (f.cast && f.phase === 'windup') return 'Charge';
  if (f.cast && f.phase === 'active') return f.cast.shape === 'melee' ? 'Attack'
    : ['beam', 'channel', 'stream', 'projectile', 'ball'].includes(f.cast.shape) ? 'Shoot' : 'Strike';
  return f.speed > .4 ? 'Walk' : 'Idle';
}

export function resolvePmdAnimation(metadata, requested) {
  if (!metadata?.animations) return null;
  for (const name of PMD_FALLBACKS[requested] || [requested, 'Idle', 'Walk']) {
    const animation = metadata.animations[name];
    if (animation?.sheet && animation.durations?.length) return animation;
  }
  return null;
}

// Durations are integer 60 Hz source frames; they are NOT simulation ticks.
export function samplePmdFrame(animation, elapsedSeconds, direction, options = {}) {
  if (!animation?.durations?.length) return null;
  const total = animation.durations.reduce((a, b) => a + b, 0);
  if (!(total > 0)) return null;
  const sourceTick = Math.max(0, Number.isFinite(elapsedSeconds) ? elapsedSeconds * 60 : 0);
  let left = options.loop === false ? Math.min(sourceTick, total - .000001) : sourceTick % total;
  let frame = 0;
  while (frame < animation.durations.length - 1 && left >= animation.durations[frame]) left -= animation.durations[frame++];
  const row = animation.directionCount === 1 ? 0 : ((Math.round(direction || 0) % 8) + 8) % 8;
  const sw = animation.frameWidth, sh = animation.frameHeight;
  return { frame, row, sx: frame * sw, sy: row * sh, sw, sh,
    anchors: animation.anchors?.[row]?.[frame] || { center: [sw / 2, sh / 2], head: [sw / 2, sh / 2], feet: [sw / 2, sh / 2] } };
}
