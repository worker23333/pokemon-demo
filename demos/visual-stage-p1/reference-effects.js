// P1 R3 demo-only authored Canvas2D art. Input anchors are already in screen pixels.
// No combat mutation, white melee flash, global steam, screen flash, or generic white orb.
// Reference: .runtime/visual-v3/r3-reference/{v2-hydropump,v2-clash,v1-melee}-sheet.jpg.
import moveFx from '../../packages/content/move-fx.json';
export { ATTACK_CATALOG, ATTACK_BY_ID, EFFECT_COVERAGE } from './move-catalog.js';

const PI = Math.PI, TAU = PI * 2;
const clamp = (n, a = 0, b = 1) => Math.max(a, Math.min(b, n));
const frac = n => n - Math.floor(n);
const noise = n => frac(Math.sin(n * 127.1 + 311.7) * 43758.5453);
const mix = (a, b, k) => a + (b - a) * k;
const PALETTES = {
  normal: ['#806d40', '#e1bc5b', '#f4da8c'], fighting: ['#743121', '#e0713b', '#f6b66b'],
  fire: ['#882523', '#ed5b20', '#ffd759'], water: ['#125bb5', '#36b6f0', '#ecfbff'],
  electric: ['#a87411', '#f5c736', '#fff4bb'], ice: ['#2966a0', '#75d9f2', '#edfaff'],
  grass: ['#2e7134', '#79c948', '#d1f087'], poison: ['#602a78', '#ab59c4', '#dea6e2'],
  bug: ['#43631a', '#99be35', '#d4e879'], flying: ['#4a7e8b', '#a1d6d6', '#e5eece'],
  psychic: ['#643375', '#d477c7', '#f4b8df'], ghost: ['#353055', '#8365b4', '#c3a4e3'],
  ground: ['#5a3c27', '#b58348', '#dfc18a'], rock: ['#4e493d', '#9b9782', '#d2c6a6'],
  dragon: ['#34418c', '#697cea', '#c8d5ff'],
};
function palette(fx) { return PALETTES[fx.type] || PALETTES.normal; }
function path(g, points, color, width, alpha = 1, close = false) {
  if (!points.length) return;
  g.globalAlpha = alpha; g.strokeStyle = color; g.lineWidth = width;
  g.beginPath(); points.forEach(([x, y], i) => i ? g.lineTo(x, y) : g.moveTo(x, y));
  if (close) g.closePath(); g.stroke();
}
function polygon(g, points, color, alpha = 1) {
  g.globalAlpha = alpha; g.fillStyle = color; g.beginPath();
  points.forEach(([x, y], i) => i ? g.lineTo(x, y) : g.moveTo(x, y)); g.closePath(); g.fill();
}
function ellipse(g, x, y, rx, ry, color, alpha = 1, rotation = 0) {
  g.globalAlpha = alpha; g.fillStyle = color; g.beginPath(); g.ellipse(x, y, Math.max(.01, rx), Math.max(.01, ry), rotation, 0, TAU); g.fill();
}
function ring(g, x, y, rx, ry, color, width = 1, alpha = 1, start = 0, end = TAU) {
  g.globalAlpha = alpha; g.strokeStyle = color; g.lineWidth = width; g.beginPath(); g.ellipse(x, y, Math.max(.01, rx), Math.max(.01, ry), 0, start, end); g.stroke();
}
function star(g, x, y, r, color, points = 5, rotation = 0, alpha = 1) {
  polygon(g, Array.from({ length: points * 2 }, (_, i) => { const a = rotation + i * PI / points - PI / 2; const rr = i % 2 ? r * .4 : r; return [x + Math.cos(a) * rr, y + Math.sin(a) * rr]; }), color, alpha);
}
function local(g, source, target, draw) {
  const dx = target.x - source.x, dy = target.y - source.y, length = Math.hypot(dx, dy);
  if (length < .1) return;
  g.save(); g.translate(source.x, source.y); g.rotate(Math.atan2(dy, dx)); draw(length); g.restore();
}
function streaks(g, x, y, s, age, color, count = 7, angle = 0, spread = PI * .8) {
  const k = clamp(age / .42), alpha = (1 - k) * .85;
  for (let i = 0; i < count; i++) {
    const a = angle + (noise(i + 1) - .5) * spread, r = s * (.07 + k * (.2 + noise(i + 9) * .45));
    path(g, [[x + Math.cos(a) * r, y + Math.sin(a) * r], [x + Math.cos(a) * (r + s * .07), y + Math.sin(a) * (r + s * .07)]], color, Math.max(1, s * .024), alpha);
  }
}
function drops(g, x, y, s, t, count = 10, direction = 0, reduced = false) {
  for (let i = 0; i < (reduced ? Math.ceil(count / 2) : count); i++) {
    const k = frac(t * 2.4 + i * .137), a = direction + (noise(i + 35) - .5) * PI * 1.3;
    const r = s * (.07 + k * .55);
    const px = x + Math.cos(a) * r, py = y + Math.sin(a) * r + k * k * s * .35;
    ellipse(g, px, py, s * (.016 + noise(i + 42) * .014), s * .016, i % 3 ? '#7be1fa' : '#dcf9ff', (1 - k) * .8, a);
  }
}

/** Each supplied cannon is a separate path, including near impact. No merged middle tube. */
function water(g, source, target, s, t, strong, reduced) {
  local(g, source, target, length => {
    const w = s * (strong ? .155 : .085), n = Math.max(12, Math.ceil(length / 9));
    const center = i => { const k = i / n; return [length * k, Math.sin(k * 15 - t * 16) * w * .15 * Math.sin(k * PI)]; };
    const coords = Array.from({ length: n + 1 }, (_, i) => center(i));
    // Source cap stays attached to the muzzle; a narrow luminous core belongs to the water, not a hit flash.
    path(g, coords, '#104ab6', w * 1.65, .9); path(g, coords, '#268be6', w * 1.22, 1);
    path(g, coords, '#7aeaff', w * .76, 1); path(g, coords, '#f1fdff', Math.max(1, w * .28), .98);
    for (let i = 0; i < (reduced ? 3 : 7); i++) {
      const k = frac(t * 1.8 + i / 7), x = k * length, side = i % 2 ? 1 : -1;
      path(g, [[x - w * .4, side * w * .5], [x, side * w * .8], [x + w * .6, side * w * .53]], '#b9f5ff', 1, .65);
      ellipse(g, x, side * w * (1.2 + noise(i) * .4), w * .22, w * .1, '#52ccf3', .7);
    }
    // Forward-opening splash fan, distinct from a white contact disc.
    for (let i = -3; i <= 3; i++) {
      const k = .55 + .45 * Math.sin(t * 21 + i * 2.1), reach = s * (.12 + k * .16);
      path(g, [[length - w * .2, 0], [length + reach * .5, i * w * .47], [length + reach, i * w * .74 + Math.abs(i) * w * .13]], i % 2 ? '#d5faff' : '#5acff2', Math.max(1, w * .16), .6);
    }
  });
  drops(g, target.x, target.y, s, t, strong ? 10 : 6, Math.atan2(target.y - source.y, target.x - source.x), reduced);
}
function flame(g, source, target, s, t, reduced) {
  local(g, source, target, length => {
    const n = Math.max(12, Math.ceil(length / 7));
    const side = (sign, scale) => Array.from({ length: n + 1 }, (_, i) => {
      const k = i / n, width = s * (.027 + .22 * k) * scale;
      const edge = 1 + .13 * Math.sin(k * 39 - t * 18) + .075 * Math.sin(k * 67 - t * 13);
      return [k * length, sign * width * edge + Math.sin(k * 23 - t * 12) * s * .026 * k];
    });
    // A narrow fire tongue joins every advancing billow to the mouth. The volume
    // comes from overlapping shaded lobes below, rather than a broad flat cone.
    for (const [scale, color] of [[1.1, '#a6341b'], [1, '#df4818'], [.58, '#ff8a22'], [.25, '#ffd653']]) {
      polygon(g, [...side(1, scale), ...side(-1, scale).reverse()], color, .94);
    }
    const count = reduced ? 11 : 17;
    const lobes = Array.from({ length: count }, (_, i) => {
      const k = frac(t * .92 + i / count);
      const radius = s * (.04 + Math.pow(k, .84) * .285) * (.96 + noise(i + 46) * .09);
      return { i, k, radius, x: k * length,
        y: Math.sin(k * 19 + i * 1.7 - t * 10) * radius * .13,
        stretch: 1.27 + noise(i + 81) * .22 };
    }).sort((a, b) => b.k - a.k);
    const contour = ({ i, x, y, radius, stretch }, scale, dx = 0, dy = 0) => Array.from({ length: 18 }, (_, j) => {
        const a = j * TAU / 18;
        const edge = 1 + Math.sin(a * 3 + i * .9) * .095 + Math.cos(a * 5 - i * 1.2) * .06;
        return [x + dx * radius + Math.cos(a) * radius * stretch * scale * edge,
          y + dy * radius + Math.sin(a) * radius * scale * edge];
      });
    // Paint entire colour layers across all overlapping lobes. Painting every
    // complete dark-rimmed ball separately produced a bead necklace; the red
    // silhouette now joins into one irregular volume, with bright pockets inside.
    for (const [scale, dx, dy, color] of [[1, 0, .025, '#d94818'], [.84, .025, -.035, '#f57618'], [.58, .07, -.08, '#ffa82b'], [.34, .12, -.1, '#ffd14c']]) {
      for (const lobe of lobes) polygon(g, contour(lobe, scale, dx, dy), color, .98);
    }
    for (const { i, radius, x, y, stretch } of lobes) {
      ellipse(g, x + radius * .16, y - radius * .13, radius * .18 * stretch, radius * .18, '#ffe17d', .84);
      // A few broken lower creases retain volume, never a full dark ring.
      if (i % 3 === 0 && !reduced) path(g, [[x - radius * .72, y + radius * .73], [x - radius * .08, y + radius * .89], [x + radius * .38, y + radius * .65]], '#b83e19', Math.max(1, radius * .065), .37);
    }
    for (let i = 0; i < (reduced ? 3 : 7); i++) {
      const k = frac(t * 1.4 + i * .177), x = k * length, y = (i % 2 ? 1 : -1) * s * (.05 + k * .25);
      ellipse(g, x, y, s * .025, s * .012, '#fa9b30', (1 - k) * .8, -.4);
    }
  });
}
function lightning(g, source, target, s, t, reduced, sky = false) {
  if (sky) source = { x: target.x - s * .25, y: target.y - s * 2.2 };
  local(g, source, target, length => {
    const n = 12, phase = Math.floor(t * (reduced ? 7 : 17));
    const points = Array.from({ length: n + 1 }, (_, i) => [i / n * length, i === 0 || i === n ? 0 : (noise(i * 9 + phase * 13) - .5) * s * .25]);
    path(g, points, '#997019', s * .074, .65); path(g, points, '#ffcb29', s * .043, .95); path(g, points, '#fff4b5', s * .014, 1);
    for (let i = 2; i < n - 1; i += reduced ? 5 : 3) {
      const [x, y] = points[i], side = i % 2 ? 1 : -1;
      path(g, [[x, y], [x + s * .08, y + s * .16 * side], [x + s * .18, y + s * .1 * side], [x + s * .24, y + s * .27 * side]], '#efbd37', s * .022, .85);
    }
  });
}
function beam(g, source, target, s, t, fx, moveId, reduced) {
  if (fx.type === 'water') return water(g, source, target, s, t, moveId === 56, reduced);
  const p = palette(fx);
  local(g, source, target, length => {
    const w = s * (moveId === 63 ? .15 : .085);
    const points = [[0, 0], [length, 0]];
    path(g, points, p[0], w * 1.9, .8); path(g, points, p[1], w, .95); path(g, points, p[2], w * .23, .98);
    if (fx.type === 'ice') {
      for (let i = 0; i < (reduced ? 4 : 8); i++) {
        const k = frac(t * 1.4 + i / 8), x = length * k, y = Math.sin(i * 7 + t) * s * .15;
        polygon(g, [[x, y - s * .075], [x + s * .04, y], [x, y + s * .075], [x - s * .04, y]], p[2], .7);
      }
    } else if (moveId === 161) {
      for (const [offset, color] of [[-.1, '#e86e43'], [0, '#f0ca32'], [.1, '#6fcdec']]) {
        path(g, Array.from({ length: 20 }, (_, i) => [length * i / 19, Math.sin(i * .6 - t * 9) * s * .035 + offset * s]), color, s * .04, .9);
      }
    } else if (fx.type === 'psychic' || moveId === 62) {
      for (let i = 0; i < 6; i++) { const k = frac(t * .9 + i / 6); ring(g, length * k, 0, s * .03, s * .14, p[2], 1.3, .65); }
    } else {
      for (let i = 0; i < 5; i++) { const k = frac(t * 1.6 + i / 5); path(g, [[length * k - s * .1, -w], [length * k + s * .1, -w]], p[2], 1, .6); }
    }
  });
}

function melee(g, source, target, s, age, fx, moveId, reduced) {
  if (age < 0 || age > .4) return;
  const k = clamp(age / .4), a = (1 - k) * (reduced ? .45 : .9), p = palette(fx);
  const angle = Math.atan2(target.y - source.y, target.x - source.x), r = s * (.25 + k * .23);
  const x = target.x, y = target.y;
  g.save(); g.translate(x, y); g.rotate(angle); g.globalAlpha = a;
  switch (fx.style) {
    case 'slash':
      for (const sign of [-1, 1]) {
        g.save(); g.rotate(sign * .64);
        polygon(g, [[-r, -r * .6], [-r * .1, -r * .24], [r * .9, r * .46], [r * .2, r * .24], [-r, -r * .3]], fx.type === 'normal' ? '#83c756' : p[1], a);
        path(g, [[-r * .9, -r * .52], [r * .55, r * .27]], fx.type === 'normal' ? '#d3e994' : p[2], 1.2, a); g.restore();
      } break;
    case 'punch':
      for (let i = -2; i <= 2; i++) path(g, [[-r * 1.35, i * r * .18], [-r * .3, i * r * .12]], p[1], i === 0 ? 3 : 1.4, a);
      path(g, [[-r * .25, -r * .4], [r * .12, -r * .33], [r * .3, 0], [r * .12, r * .33], [-r * .25, r * .4]], p[2], 2, a); break;
    case 'slap':
      for (let i = 0; i < 3; i++) { g.save(); g.rotate((i - 1) * .4); path(g, [[-r, -r * .1], [0, -r * .25], [r * .25, 0]], p[1], 2.2, a * (1 - i * .15)); g.restore(); } break;
    case 'kick':
      path(g, [[-r * 1.3, r * .55], [-r * .3, -r * .35], [r * .35, -r * .25]], p[1], 4, a);
      path(g, [[-r, r * .6], [-r * .15, -r * .14], [r * .4, -r * .08]], p[2], 1.6, a); break;
    case 'bite':
      for (const sign of [-1, 1]) {
        const gap = s * .12 * (1 - Math.sin(clamp(k * 2) * PI / 2));
        for (let i = -1; i <= 1; i++) polygon(g, [[i * r * .42 - r * .17, sign * (r * .65 + gap)], [i * r * .42 + r * .17, sign * (r * .65 + gap)], [i * r * .42, sign * (r * .13 + gap)]], '#dac999', a);
      } break;
    case 'peck':
      polygon(g, [[-r * 1.25, -r * .32], [r * .25, 0], [-r * 1.25, r * .32], [-r * .65, 0]], p[1], a);
      path(g, [[-r, 0], [r * .2, 0]], p[2], 1.5, a); break;
    case 'whip':
      g.restore();
      local(g, source, target, length => { const points = Array.from({ length: 20 }, (_, i) => [length * i / 19, Math.sin(i / 19 * PI * 2 - k * 4) * s * .16 * Math.sin(i / 19 * PI)]); path(g, points, '#376d2b', 4, a); path(g, points, '#84bb46', 1.5, a); });
      return;
    case 'splash':
      g.restore(); drops(g, x, y, s, age, reduced ? 5 : 10, angle, reduced); return;
    default: // tackle / fast approach: narrow pressure arcs and earth dust, never a white flash.
      for (let i = -2; i <= 2; i++) path(g, [[-r * 1.8, i * r * .17], [-r * .35, i * r * .12]], p[1], 1.2, a);
      ring(g, -r * .05, 0, r * .38, r * .6, p[1], 2, a, -PI * .47, PI * .47); break;
  }
  g.restore();
  streaks(g, x, y, s * .7, age, p[1], reduced ? 3 : 6, angle);
  // Elemental punches remain visibly distinct without filling the contact silhouette.
  if (fx.type === 'fire') for (let i = 0; i < 4; i++) ellipse(g, x + Math.sin(i * 2 + k) * r, y - k * s * .3 + Math.cos(i * 2) * r * .4, s * .025, s * .06, '#e9792e', a);
  if (fx.type === 'ice') for (let i = 0; i < 4; i++) { const dx = Math.cos(i * 1.7) * r, dy = Math.sin(i * 1.7) * r; polygon(g, [[x + dx, y + dy - 4], [x + dx + 2, y + dy], [x + dx, y + dy + 4], [x + dx - 2, y + dy]], '#80d4e7', a); }
  if (fx.type === 'electric') lightning(g, { x: x - r, y: y - r * .3 }, { x: x + r * .6, y: y + r * .4 }, s * .4, age, reduced);
}

function projectileSymbol(g, shape, s, t, p, id) {
  switch (shape) {
    case 'needle': polygon(g, [[-s * .24, -s * .045], [s * .32, 0], [-s * .24, s * .045], [-s * .13, 0]], p[1]); path(g, [[-s * .16, 0], [s * .23, 0]], p[2], 1); break;
    case 'crescent':
      g.beginPath(); g.moveTo(s * .03, -s * .25); g.quadraticCurveTo(s * .34, 0, s * .03, s * .25); g.quadraticCurveTo(s * .16, 0, s * .03, -s * .25); g.fillStyle = p[1]; g.fill(); break;
    case 'ring': ring(g, 0, 0, s * .1, s * .22, p[1], 2, .9); ring(g, -s * .05, 0, s * .1, s * .22, p[2], 1, .5); break;
    case 'glob':
      polygon(g, Array.from({ length: 10 }, (_, i) => { const a = i * TAU / 10, r = s * (.1 + noise(i + id) * .04); return [Math.cos(a) * r, Math.sin(a) * r]; }), p[1], .9);
      ellipse(g, s * .025, -s * .04, s * .033, s * .023, p[2], .6); break;
    case 'fireball':
      if (id === 126) {
        // Fire Blast has its own 大 silhouette, verified in V2 27.5–28s.
        const strokes = [[[0, -.5], [0, -.06]], [[-.48, -.13], [.48, -.13]], [[0, -.12], [-.4, .47]], [[0, -.12], [.4, .47]]];
        for (const [width, color] of [[.17, '#a83221'], [.115, '#ef6c24'], [.045, '#ffd35f']]) {
          for (const stroke of strokes) path(g, stroke.map(([x, y]) => [x * s, y * s]), color, s * width, .96);
        }
        for (let i = 0; i < 5; i++) { const x = Math.sin(i * 2.4) * s * .35, y = Math.cos(i * 2.4) * s * .35; polygon(g, [[x, y], [x - s * .04, y - s * .17], [x + s * .035, y - s * .06]], '#f8992c', .8); }
        break;
      }
      polygon(g, [[s * .22, 0], [-s * .08, -s * .17], [-s * .32, -s * .09], [-s * .16, -.01 * s], [-s * .4, s * .12], [-s * .04, s * .16]], '#d54a22');
      ellipse(g, 0, 0, s * .13, s * .1, '#ffb42c'); ellipse(g, s * .035, 0, s * .07, s * .045, '#ffe38a');
      break;
    case 'bubble': ring(g, 0, 0, s * .14, s * .14, '#6ecced', 2, .85); ring(g, -s * .025, -s * .025, s * .08, s * .08, '#e3faff', 1, .9, PI, PI * 1.6); break;
    case 'drain': ellipse(g, 0, 0, s * .09, s * .04, p[1], .9); path(g, [[s * .12, 0], [s * .3, 0]], p[2], 1, .55); break;
    case 'leaf': polygon(g, [[s * .24, 0], [-s * .02, -s * .12], [-s * .22, 0], [-s * .01, s * .12]], '#80ba37'); path(g, [[-s * .18, 0], [s * .22, 0]], '#d5e78e', 1); break;
    case 'spark': path(g, [[-s * .24, 0], [-s * .08, -s * .06], [-s * .03, s * .09], [s * .09, -s * .1], [s * .24, 0]], '#f9cf36', 2); break;
    case 'rock': polygon(g, [[-s * .15, -s * .07], [-s * .07, -s * .18], [s * .12, -s * .13], [s * .19, s * .06], [0, s * .17], [-s * .17, s * .1]], '#726954'); polygon(g, [[-s * .07, -s * .18], [s * .12, -s * .13], [0, s * .035]], '#b6a789'); break;
    case 'egg': ellipse(g, 0, 0, s * .12, s * .16, '#d6caa0'); ellipse(g, s * .025, -s * .06, s * .04, s * .045, '#f2e9c9'); break;
    case 'bone': path(g, [[-s * .18, 0], [s * .18, 0]], '#d6c8a1', s * .065); for (const sign of [-1, 1]) for (const side of [-1, 1]) ellipse(g, sign * s * .18, side * s * .04, s * .055, s * .055, '#e1d3ad'); break;
    case 'star': star(g, 0, 0, s * .17, '#efcf48', 5, t * 4); star(g, 0, 0, s * .08, '#fff0a2', 5, t * 4); break;
  }
}
function projectile(g, source, target, s, t, progress, fx, moveId, reduced) {
  const p = palette(fx), count = Math.min(reduced ? 3 : 5, fx.count || (fx.hits || 1));
  local(g, source, target, length => {
    for (let i = 0; i < count; i++) {
      let k = clamp(progress - i * .085); if (fx.shape === 'drain') k = 1 - k;
      const arc = ['rock', 'egg', 'glob'].includes(fx.shape) ? -Math.sin(k * PI) * s * .7 : Math.sin(k * PI) * (i - (count - 1) / 2) * s * .08;
      const x = k * length, y = arc;
      for (let j = 3; j >= 1; j--) {
        const direction = fx.shape === 'drain' ? 1 : -1;
        path(g, [[x + direction * s * (.09 * j + .1), y], [x + direction * s * .09 * j, y]], p[1], Math.max(1, s * .015), .22 / j);
      }
      g.save(); g.translate(x, y); if (['leaf', 'bone', 'rock', 'egg'].includes(fx.shape)) g.rotate(t * (fx.shape === 'bone' ? 12 : 5) + i); projectileSymbol(g, fx.shape, s, t, p, moveId); g.restore();
    }
  });
}

function field(g, source, target, s, t, age, fx, moveId, reduced, layer = 'back', targetHeight = 1.8) {
  const p = palette(fx), x = target.x, y = target.y, k = frac(age / 1.2), count = reduced ? 6 : 12;
  const near = layer === 'front', height = clamp(targetHeight, 1.2, 3.2);
  const visibleHalf = angle => (Math.sin(angle) >= 0) === near;
  switch (fx.fx) {
    case 'vortex':
      if (moveId === 83) {
        const spiral = Array.from({ length: 96 }, (_, i) => { const lift = i / 95, angle = lift * PI * 5 - t * 4.5, radius = s * (.61 - lift * .12); return { point: [x + Math.cos(angle) * radius, y + Math.sin(angle) * radius * .27 - lift * s * Math.max(1.6, height * .95)], visible: visibleHalf(angle) }; });
        const segments = []; let segment = [];
        for (const point of spiral) { if (point.visible) segment.push(point.point); else if (segment.length) { segments.push(segment); segment = []; } } if (segment.length) segments.push(segment);
        // Far coils go behind the body; only the near half crosses the foreground.
        for (const points of segments) if (points.length > 1) {
          path(g, points, '#a23b24', s * .084, near ? .59 : .76);
          path(g, points, '#e96b24', s * .047, near ? .8 : .93);
          path(g, points, '#ffbf49', s * .016, near ? .7 : .83);
        }
      }
      for (let i = 0; i < count; i++) {
        const a = i * TAU / count + t * 5, lift = frac(i / count + t * .5), r = s * (moveId === 83 ? .61 - lift * .12 : .38 + lift * .26);
        if (!visibleHalf(a)) continue;
        const px = x + Math.cos(a) * r, py = y - lift * s * Math.max(1.4, height * .95) + Math.sin(a) * r * .27;
        if (moveId === 80) { g.save(); g.translate(px, py); g.rotate(a); ellipse(g, 0, 0, s * .06, s * .025, i % 2 ? '#d696c6' : '#eabece', .8); g.restore(); }
        else if (moveId === 83) { ellipse(g, px, py, s * .055, s * .085, i % 2 ? '#f3982c' : '#ca4b24', near ? .57 : .75, a); }
        else path(g, [[px - s * .09, py + s * .03], [px, py], [px + s * .1, py + s * .01]], '#b4d2c9', 1.5, .7);
      } break;
    case 'bind':
      for (let i = 0; i < 4; i++) {
        const yy = y - s * height * (.18 + i * .17), stretch = 1 + Math.sin(t * 7 + i) * .06;
        ring(g, x, yy, s * .44 * stretch, s * .12, moveId === 132 ? '#698a49' : '#b29960', 2.5, near ? .59 : .82, near ? 0 : PI, near ? PI : TAU);
      }
      if (moveId === 128 && near) for (const side of [-1, 1]) { polygon(g, [[x + side * s * .46, y - s * height * .8], [x + side * s * .28, y - s * height * .45], [x + side * s * .46, y - s * height * .1]], '#c2a6b8', .72); } break;
    case 'orb':
      for (let i = 0; i < 3; i++) { const radius = s * (.33 + i * .13 + Math.sin(t * 3 + i) * .025); ring(g, x, y - i * s * .08, radius, radius * .46, p[1], 1.7, near ? .44 : .6, near ? 0 : PI, near ? PI : TAU); }
      for (let i = 0; i < 5; i++) { const a = i * TAU / 5 + t * 2; if (visibleHalf(a)) star(g, x + Math.cos(a) * s * .57, y + Math.sin(a) * s * .27, s * .04, p[2], 4, a, .65); }
      if (moveId === 138 && !near) local(g, target, source, length => { for (let i = 0; i < 4; i++) { const at = frac(t * .8 + i / 4); ellipse(g, at * length, -Math.sin(at * PI) * s * .25, s * .045, s * .025, '#b880ca', .7); } }); break;
    case 'quake':
      for (let j = 0; j < (moveId === 90 ? 1 : 5); j++) {
        const angle = j * TAU / 5, radius = s * (moveId === 90 ? 1.25 : .95);
        const points = Array.from({ length: 8 }, (_, i) => { const r = radius * i / 7; return [x + Math.cos(angle) * r + (noise(i * 3 + j) - .5) * s * .12, y + Math.sin(angle) * r * .28 + (noise(i + j * 7) - .5) * s * .09]; });
        path(g, points, '#423526', moveId === 90 ? 5 : 2.5, .9); path(g, points.map(([xx, yy]) => [xx, yy - 1.5]), '#c8a467', 1, .8);
      }
      for (let i = 0; i < count; i++) { const a = i * 2.4, rr = s * (.3 + noise(i) * .55), lift = Math.sin(frac(t * 2 + i * .17) * PI) * s * .12; ellipse(g, x + Math.cos(a) * rr, y + Math.sin(a) * rr * .3 - lift, 2.5, 1.7, '#8c714f', .7); } break;
    case 'dig':
      ellipse(g, x, y, s * .35, s * .11, '#413221', .85); ring(g, x, y, s * .4, s * .14, '#ac8a57', 3, .8);
      for (let i = 0; i < count; i++) { const progress = frac(age * 1.4 + i / count), a = i * 2.7, r = progress * s * .65; ellipse(g, x + Math.cos(a) * r, y + Math.sin(a) * r * .3 - Math.sin(progress * PI) * s * .3, s * .04, s * .026, i % 2 ? '#a18555' : '#655039', 1 - progress); } break;
    case 'wave':
      local(g, source, target, length => {
        const at = frac(age / 1.1), xx = length * at;
        const top = Array.from({ length: 18 }, (_, i) => { const yy = (i / 17 - .5) * s * 1.15; return [xx + Math.sin(i * .8 - t * 8) * s * .07, yy]; });
        path(g, top, '#1b6fab', s * .28, .7); path(g, top.map(([a, b]) => [a + s * .05, b]), '#6acfea', s * .1, .9);
        for (let i = 0; i < 9; i++) ellipse(g, xx + s * .09, (i / 8 - .5) * s * 1.1, s * .06, s * .024, '#d2f4f4', .85);
      }); break;
    case 'explode': {
      const progress = clamp(age / .75), r = s * (.2 + progress * 1.15), opacity = (1 - progress) * .88;
      ring(g, x, y, r, r * .35, '#a75d32', 3, opacity); ring(g, x, y, r * .8, r * .28, '#deb35c', 1.5, opacity);
      for (let i = 0; i < count; i++) { const a = i * TAU / count, rr = r * (.25 + noise(i) * .55); ellipse(g, x + Math.cos(a) * rr, y + Math.sin(a) * rr * .6, s * (.07 + noise(i + 6) * .07), s * .08, i % 2 ? '#e4782e' : '#bc4327', opacity); }
      streaks(g, x, y, s * 1.6, progress * .4, '#ecaf43', count, 0, TAU); break;
    }
    case 'rain':
      for (let i = 0; i < (reduced ? 3 : 6); i++) { const at = frac(age * 1.25 + i / 6), xx = x + (noise(i + 31) - .5) * s * 1.2, yy = y - (1 - at) * s * 2; g.save(); g.translate(xx, yy); g.rotate(i); projectileSymbol(g, 'rock', s * (.6 + noise(i) * .5), t, p, moveId); g.restore(); path(g, [[xx, yy - s * .25], [xx, yy - s * .5]], '#a99a7f', 1, .35); } break;
    case 'dive':
      for (let i = -2; i <= 2; i++) path(g, [[x - s * .35 + i * s * .12, y - s * 1.25], [x + i * s * .07, y - s * .12]], '#a8cbc6', 1.6, .65);
      ring(g, x, y, s * (.2 + k * .7), s * (.06 + k * .15), p[1], 2, 1 - k); break;
    case 'slam':
      if (moveId === 69) {
        ellipse(g, x, y, s * .37, s * .13, '#56432e', .65);
        for (let i = 0; i < 6; i++) { const a = i * TAU / 6, rr = s * (.45 + k * .24); path(g, [[x, y], [x + Math.cos(a) * rr * .6, y + Math.sin(a) * rr * .22], [x + Math.cos(a + .1) * rr, y + Math.sin(a + .1) * rr * .34]], '#50402b', 1.7, .75); }
        for (let i = 0; i < (reduced ? 4 : 8); i++) { const a = i * 2.4, rr = s * (.15 + k * .55); g.save(); g.translate(x + Math.cos(a) * rr, y + Math.sin(a) * rr * .3 - Math.sin(k * PI) * s * .5); g.rotate(i + k * 3); projectileSymbol(g, 'rock', s * .32, t, p, moveId); g.restore(); }
      }
      for (let i = 0; i < 3; i++) { const r = s * (.25 + i * .17 + k * .3); ring(g, x, y, r, r * .28, p[1], 2, (1 - k) * .7); }
      streaks(g, x, y, s, k * .4, '#bc9354', count, -PI / 2, PI); break;
  }
}

/**
 * moveId: one of 108 authored attack entries. sources: [{x,y,kind,layer}].
 * layer='back' draws rear source paths, ground and area effects; layer='front' draws
 * foreground source paths and small contact marks. No state or random stream is mutated.
 * Optional groundSource/groundTarget are foot anchors for ground art (never guessed from mouths).
 * age is time since cast active; impactAge is time since hit (<0 or omitted = no hit).
 * active=false disables the cast but permits the short per-skill impact to finish.
 */
export function drawReferenceAttack(g, cam, opts = {}) {
  const { moveId, sources = [], target, groundSource, groundTarget, targetHeight = 1.8, time = 0, age = 0, impactAge = -1, travelProgress = frac(Math.max(0, age) / .65), active = true, reduced = false, layer = 'back' } = opts;
  const fx = moveFx[String(moveId)];
  if (!fx || !target || !Number.isFinite(target.x) || !Number.isFinite(target.y)) return;
  const all = sources.filter(p => Number.isFinite(p.x) && Number.isFinite(p.y));
  if (!all.length) return;
  const selected = all.filter(p => (p.layer || 'back') === layer), s = Math.max(1, cam?.s || 58), t = time * (reduced ? .75 : 1);
  g.save(); g.globalCompositeOperation = 'source-over'; g.lineCap = 'round'; g.lineJoin = 'round';
  // Field geometry must not be painted twice when one caster has two anchors.
  const surroundsBody = ['vortex', 'bind', 'orb'].includes(fx.fx);
  if (active && (layer === 'back' || surroundsBody) && ['vortex', 'bind', 'orb', 'quake', 'dig', 'wave', 'explode', 'rain', 'dive', 'slam'].includes(fx.fx)) {
    const ground = ['vortex', 'bind', 'quake', 'dig', 'wave', 'explode', 'rain', 'dive', 'slam'].includes(fx.fx);
    const origin = ground ? (groundSource || all[0]) : all[0];
    // Self-Destruct / Explosion originate at the caster, as does Earthquake's
    // ground shock. Fissure, Dig emergence and aimed fields remain at the victim.
    const selfOrigin = [120, 153, 89].includes(Number(moveId));
    const destination = selfOrigin ? origin : ground ? (groundTarget || target) : target;
    field(g, origin, destination, s, t, Math.max(0, age), fx, Number(moveId), reduced, layer, targetHeight);
  }
  if (active) for (const source of selected) {
    const end = { ...target };
    if (Number(moveId) === 56 && all.length > 1) {
      // Preserve separation almost to impact. Both independent endpoints sit inside the splash fan.
      const center = all.reduce((a, p) => ({ x: a.x + p.x / all.length, y: a.y + p.y / all.length }), { x: 0, y: 0 });
      end.x += (source.x - center.x) * .38; end.y += (source.y - center.y) * .38;
    }
    if (fx.fx === 'stream') {
      if (Number(moveId) === 53) flame(g, source, end, s, t, reduced);
      else if (fx.type === 'ice') {
        beam(g, source, end, s, t, fx, moveId, reduced);
        local(g, source, end, length => { for (let i = 0; i < (reduced ? 5 : 12); i++) { const k = frac(t * 1.5 + i / 12); star(g, length * k, Math.sin(i * 2 + t) * s * .18, s * .035, '#a6e3f3', 4, i + t, .75); } });
      } else {
        local(g, source, end, length => { for (let i = 0; i < (reduced ? 4 : 8); i++) { const k = frac(t * .7 + i / 8); ellipse(g, length * k, Math.sin(i * 3 + t) * s * .12 * k, s * (.035 + k * .16), s * (.04 + k * .11), i % 2 ? '#916493' : '#b08bad', .22); } });
      }
    } else if (fx.fx === 'beam') beam(g, source, end, s, t, fx, Number(moveId), reduced);
    else if (fx.fx === 'bolt') lightning(g, source, end, s, t, reduced, Number(moveId) === 87);
    else if (fx.fx === 'projectile') projectile(g, source, end, s, t, clamp(travelProgress), fx, Number(moveId), reduced);
  }
  if (layer === 'front' && impactAge >= 0 && impactAge < .42) {
    if (fx.fx === 'melee') melee(g, all[0], target, s, impactAge, fx, Number(moveId), reduced);
    else if (!['beam', 'stream', 'bolt'].includes(fx.fx)) {
      const p = palette(fx), angle = Math.atan2(target.y - all[0].y, target.x - all[0].x);
      if (fx.type === 'water') drops(g, target.x, target.y, s * .7, impactAge, 6, angle, reduced);
      else streaks(g, target.x, target.y, s * .75, impactAge, p[1], reduced ? 3 : 6, angle, PI * 1.2);
    }
  }
  g.restore();
}
