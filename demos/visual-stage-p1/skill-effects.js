// P1 demo only: explicit move/interaction fixtures, not evidence of server collision events.
// No generic impact flash, white disc, white silhouette, or additive glow is generated here.
// A target's species/type never determines the visual reaction of two moves.

const REACTIONS = Object.freeze({
  98: Object.freeze({ id: 98, name: '电光一闪', type: 'normal', impact: 'dust-slash', stream: 'none', clash: 'none' }),
  53: Object.freeze({ id: 53, name: '喷射火焰', type: 'fire', impact: 'embers', stream: 'flame', clash: 'water-steam' }),
  55: Object.freeze({ id: 55, name: '水枪', type: 'water', impact: 'droplets', stream: 'water', clash: 'fire-steam' }),
  56: Object.freeze({ id: 56, name: '水炮', type: 'water', impact: 'heavy-droplets', stream: 'water-cannon', clash: 'fire-steam' }),
  85: Object.freeze({ id: 85, name: '十万伏特', type: 'electric', impact: 'sparks', stream: 'arc', clash: 'none' }),
});
const UNKNOWN = Object.freeze({ id: null, name: '未配置技能', type: 'neutral', impact: 'none', stream: 'none', clash: 'none' });
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

export const moveReaction = (moveId) => REACTIONS[Number(moveId)] || UNKNOWN;

/** core.js drawParticles/stepParticles compatible objects; callers own the particle clock. */
export function impactParticles(moveId, { u, side = 1, rand = () => 0.5, reduced = false }) {
  const kind = moveReaction(moveId).impact;
  if (kind === 'none') return [];
  const R = () => clamp(rand(), 0, 1), direction = Math.sign(side) || 1;
  const count = reduced ? 2 : kind === 'dust-slash' ? 6 : kind === 'heavy-droplets' ? 5 : 4;
  return Array.from({ length: count }, (_, i) => {
    const p = { u: u - direction * 0.14, v: 0, z: 0.6, vu: direction * (0.5 + R()), vz: 0.5 + R(),
      grav: 3, size: 0.035, max: 0.28, age: 0, alpha: reduced ? 0.5 : 0.85, add: false, kind: 'sq' };
    if (kind === 'dust-slash') {
      const dust = i % 2 === 0;
      return { ...p, z: dust ? 0.08 : 0.52 + R() * 0.16, color: dust ? '#9b7246' : '#72bd69',
        kind: dust ? 'dot' : 'sq', size: dust ? 0.045 : 0.03, alpha: dust ? 0.45 : p.alpha,
        vu: direction * (0.7 + R() * 1.5), vz: dust ? 0.2 + R() * 0.4 : 0.1 + R() * 0.7,
        grav: dust ? 2 : 0.5, max: dust ? 0.32 : 0.18 };
    }
    if (kind === 'embers') return { ...p, color: i % 2 ? '#ed682d' : '#c83c26',
      size: 0.025 + R() * 0.015, vz: 0.4 + R() * 0.8, grav: -0.1, max: 0.24 + R() * 0.12 };
    if (kind === 'droplets' || kind === 'heavy-droplets') return { ...p, color: i % 2 ? '#48aad5' : '#287cae',
      kind: 'dot', size: (kind === 'heavy-droplets' ? 0.033 : 0.026) + R() * 0.016,
      vz: 0.7 + R() * 0.8, grav: 5, max: 0.32 };
    return { ...p, color: i % 2 ? '#efbd38' : '#c88b24',
      vu: direction * (0.4 + R() * 1.2), vz: (R() - 0.5) * 2,
      grav: 0, size: 0.027, max: 0.09 + R() * 0.06 }; // electric: short gold sparks
  });
}

function streamSpace(cam, { fromU, toU, fromZ = 0.9, toZ = 0.65 }) {
  const sx = cam.x(fromU), sy = cam.y(0) - fromZ * cam.s;
  const ex = cam.x(toU), ey = cam.y(0) - toZ * cam.s;
  const length = Math.hypot(ex - sx, ey - sy);
  if (!Number.isFinite(length) || length < 0.01) return null;
  const dx = (ex - sx) / length, dy = (ey - sy) / length;
  return { length, angle: Math.atan2(dy, dx), point: (k, cross = 0) => [sx + (ex - sx) * k - dy * cross, sy + (ey - sy) * k + dx * cross] };
}

function strokePath(g, coords, color, width, alpha = 1) {
  g.strokeStyle = color; g.lineWidth = width; g.globalAlpha = alpha;
  g.beginPath(); coords.forEach(([x, y], i) => i ? g.lineTo(x, y) : g.moveTo(x, y)); g.stroke();
}

/** Skill-specific stream art. It does not infer a collision or spawn steam at a victim. */
export function drawSkillStream(g, cam, { moveId, fromU, toU, fromZ, toZ, time = 0, reduced = false }) {
  const kind = moveReaction(moveId).stream;
  if (kind === 'none') return;
  const space = streamSpace(cam, { fromU, toU, fromZ, toZ });
  if (!space) return;
  const s = cam.s, t = time * (reduced ? 0.6 : 1);
  g.save(); g.globalCompositeOperation = 'source-over'; g.lineCap = 'round'; g.lineJoin = 'round';
  if (kind === 'flame') {
    const path = Array.from({ length: 15 }, (_, i) => space.point(i / 14, Math.sin(i * 1.5 - t * 9) * s * 0.018));
    strokePath(g, path, '#b83b24', s * 0.29, 0.75);
    strokePath(g, path, '#e76a26', s * 0.19, 0.88);
    strokePath(g, path, '#ebb444', s * 0.07, 0.88);
    const count = reduced ? 7 : 12;
    for (let i = 0; i < count; i++) {
      const k = (i / count + t * 0.8) % 1, [x, y] = space.point(k, Math.sin(k * 20 - t * 8) * s * 0.025);
      const radius = s * (0.06 + k * 0.14);
      g.globalAlpha = 0.65; g.fillStyle = i % 3 ? '#ef862a' : '#ce4c27';
      g.beginPath(); g.ellipse(x, y, radius * 1.6, radius, space.angle, 0, Math.PI * 2); g.fill();
    }
  } else if (kind === 'water' || kind === 'water-cannon') {
    const thickness = kind === 'water-cannon' ? 1.9 : 1;
    const path = Array.from({ length: 18 }, (_, i) => space.point(i / 17, Math.sin(i * 0.8 - t * 10) * s * 0.015));
    strokePath(g, path, '#235f98', s * 0.15 * thickness, 0.7);
    strokePath(g, path, '#399ed0', s * 0.09 * thickness, 0.9);
    strokePath(g, path, '#79c6dd', s * 0.025 * thickness, 0.75);
    for (let i = 0; i < (reduced ? 3 : 6); i++) {
      const k = (i / 6 + t * 0.9) % 1, [x, y] = space.point(k, Math.sin(i * 2 + t * 5) * s * 0.08);
      g.globalAlpha = 0.55; g.fillStyle = '#4baacf';
      g.beginPath(); g.ellipse(x, y, s * 0.036, s * 0.019, space.angle, 0, Math.PI * 2); g.fill();
    }
  } else if (kind === 'arc') {
    const phase = t * (reduced ? 4 : 8);
    const path = Array.from({ length: 14 }, (_, i) => space.point(i / 13,
      i === 0 || i === 13 ? 0 : Math.sin(i * 2.7 + phase) * s * (reduced ? 0.035 : 0.065)));
    strokePath(g, path, '#b97e21', s * 0.044, 0.72);
    strokePath(g, path, '#e9b83d', s * 0.024, 0.95);
    if (!reduced) {
      const branch = [space.point(0.5), space.point(0.6, s * 0.14), space.point(0.64, s * 0.08)];
      strokePath(g, branch, '#d99c2b', s * 0.019, 0.6);
    }
  }
  g.restore();
}

// Explicit interaction table: Flamethrower + Water Gun / Hydro Pump, in either order.
// Other fire/water moves require their own authored reaction; unknown pairs produce none.
const CLASHES = Object.freeze({ '53:55': 'steam', '55:53': 'steam', '53:56': 'steam', '56:53': 'steam' });
export const clashReaction = (firstMoveId, secondMoveId) => CLASHES[`${Number(firstMoveId)}:${Number(secondMoveId)}`] || 'none';

function fixturePositionAt(path, time) {
  if (!Array.isArray(path) || path.length === 0) return null;
  if (time <= path[0][0]) return path[0][1];
  for (let i = 1; i < path.length; i++) {
    const [t0, u0] = path[i - 1], [t1, u1] = path[i];
    if (time <= t1) return u0 + (u1 - u0) * (time - t0) / Math.max(1e-6, t1 - t0);
  }
  return path[path.length - 1][1];
}

/**
 * Only an authored intersection with two simultaneous, opposed casts is drawable.
 * A clash interval alone never creates steam. The returned cast identities let the
 * caller truncate only the two participating streams, not unrelated attacks.
 */
export function activeSkillClash(scenario, time) {
  if (!Number.isFinite(time)) return null;
  const casts = (scenario.casts || []).filter(c => c.shape !== 'melee' && time >= c.active && time < c.end);
  for (const clash of scenario.clashes || []) {
    if (!(time >= clash.start && time < clash.end) || !Number.isFinite(clash.u)
      || !Array.isArray(clash.moves) || clash.moves.length !== 2
      || clashReaction(clash.moves[0], clash.moves[1]) === 'none') continue;
    for (const first of casts.filter(c => Number(c.moveId) === Number(clash.moves[0]))) {
      const second = casts.find(c => Number(c.moveId) === Number(clash.moves[1])
        && c.actor !== first.actor && c.actor === first.target && c.target === first.actor);
      if (!second) continue;
      const firstFighter = scenario.fighters?.find(f => f.id === first.actor);
      const secondFighter = scenario.fighters?.find(f => f.id === second.actor);
      const u0 = fixturePositionAt(firstFighter?.path, time), u1 = fixturePositionAt(secondFighter?.path, time);
      if (!Number.isFinite(u0) || !Number.isFinite(u1)
        || !(clash.u > Math.min(u0, u1) && clash.u < Math.max(u0, u1))) continue;
      return { ...clash, casts: [first, second] };
    }
  }
  return null;
}

/**
 * Demo-only paired-cast fixture. Root scene calls this only where two authored streams meet.
 * A small orange/cyan contact and sparse translucent steam remain inside ±0.6 world units.
 * This function neither changes health/timing nor claims an authoritative server clash event.
 */
export function drawSkillClash(g, cam, { firstMoveId, secondMoveId, u, height = 0.7, time = 0, age = -1, reduced = false }) {
  if (clashReaction(firstMoveId, secondMoveId) !== 'steam' || !Number.isFinite(age) || age < 0) return;
  const s = cam.s, x = cam.x(u), y = cam.y(0) - s * height;
  const contactAlpha = Math.min(1, age / 0.1);
  g.save(); g.globalCompositeOperation = 'source-over';
  // Colored contact, not a white-hot disc: each half stays smaller than a caster's body.
  for (const [direction, color] of [[-1, '#da7b32'], [1, '#50aebd']]) {
    const fireOnLeft = Number(firstMoveId) === 53;
    const colorForSide = fireOnLeft ? color : direction < 0 ? '#50aebd' : '#da7b32';
    g.fillStyle = colorForSide; g.globalAlpha = contactAlpha * (reduced ? 0.45 : 0.62);
    g.beginPath(); g.ellipse(x + direction * s * 0.055, y, s * 0.075, s * 0.11, direction * 0.3, 0, Math.PI * 2); g.fill();
  }
  const cycle = 0.95, count = reduced ? 2 : 6;
  for (let i = 0; i < count; i++) {
    const offset = i * cycle / count;
    if (age < offset) continue;
    const progress = ((age - offset) % cycle) / cycle;
    const side = i % 2 ? 1 : -1;
    const drift = side * (0.08 + progress * 0.2) + Math.sin(time * 1.8 + i) * 0.04;
    const radius = 0.055 + progress * (reduced ? 0.09 : 0.115);
    // Normal drift + radius stays below 0.49u (reduced below 0.465u), away from the casters.
    g.fillStyle = '#c3c8c7'; g.globalAlpha = (reduced ? 0.13 : 0.27) * Math.sin(progress * Math.PI);
    g.beginPath(); g.ellipse(x + drift * s, y - (0.06 + progress * 0.52) * s,
      radius * s, radius * 0.75 * s, 0, 0, Math.PI * 2); g.fill();
  }
  g.restore();
}
