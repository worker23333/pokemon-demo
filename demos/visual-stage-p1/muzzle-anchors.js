// R3 demo only. These are inspected source-pixel locations, NOT combat coordinates.
// PMD source revision: 51eda301e151d3528466f3f65734bf7c70c373a6.
// All PNGs remain unmodified. Directions 2/6 keep the horizontal demo opponents
// facing one another; rotating to 3/5 just to reveal the far cannon is incorrect.

const alternating = (a, b, count = 10) => Array.from({ length: count }, (_, i) => i % 2 ? b : a);

// Coordinates are in one sheet cell, including the cell's transparent margin.
// For Blastoise the source LeftHand/RightHand markers actually mark its extended
// cannon muzzles. This was checked against Shoot f2's two baked muzzle flashes,
// and the visible silver tube in f0/f1 and Charge. The far cannon is occluded by
// the head in the side-on view: draw its water behind the body, not on the face.
// f3-f5 retract the cannons, so they intentionally have no firing anchors.
const CANNONS = {
  Shoot: {
    2: [ [[30.5, 16.5], [30.5, 25.5]], [[31.5, 16.5], [31.5, 25.5]], [[32.5, 16.5], [32.5, 25.5]] ],
    6: [ [[17.5, 16.5], [17.5, 25.5]], [[16.5, 16.5], [16.5, 25.5]], [[15.5, 16.5], [15.5, 25.5]] ],
  },
  Charge: {
    2: alternating([[26.5, 7.5], [26.5, 16.5]], [[26.5, 8.5], [26.5, 17.5]]),
    6: alternating([[13.5, 7.5], [13.5, 16.5]], [[13.5, 8.5], [13.5, 17.5]]),
  },
};

// Charizard's open jaw cavity, measured in Shoot f2-f9 and Charge. The source
// generic Head marker sits behind this cavity. Shoot f0/f1 face upward and f10
// is a recovery pose; do not keep a horizontal flame attached to those frames.
const MOUTHS = {
  Shoot: {
    2: [null, null, [44, 25], [47, 25], [50, 25], [50, 26], [50, 25], [50, 26], [50, 25], [50, 26]],
    6: [null, null, [10, 25], [7, 25], [4, 25], [4, 26], [4, 25], [4, 26], [4, 25], [4, 26]],
  },
  Charge: {
    2: alternating([38, 21], [38, 22]),
    6: alternating([9, 21], [9, 22]),
  },
};

// Pikachu: centre of the visible 2x2 red cheek patch, NOT the adjacent red mouth
// pixels. The hidden cheek is not fabricated. Shoot f0-f3 and f4-f10 have
// different poses, hence explicit per-frame measurements.
const CHEEKS = {
  Shoot: {
    2: [[21, 22], [20, 21], [19, 23], [22, 23], [28, 22], [28, 23], [28, 22], [28, 23], [28, 22], [28, 23], [28, 22]],
    6: [[19, 22], [20, 21], [21, 23], [18, 23], [12, 22], [12, 23], [12, 22], [12, 23], [12, 22], [12, 23], [12, 22]],
  },
  Charge: {
    2: alternating([25, 13], [25, 14]),
    6: alternating([15, 13], [15, 14]),
  },
};

export const MUZZLE_SUPPORT = Object.freeze({
  sourceRevision: '51eda301e151d3528466f3f65734bf7c70c373a6',
  directions: [2, 6],
  species: {
    9: { Shoot: [0, 1, 2], Charge: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], recommendedChannel: { action: 'Shoot', seconds: 5 / 60, loop: false } },
    6: { Shoot: [2, 3, 4, 5, 6, 7, 8, 9], Charge: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], recommendedChannel: { action: 'Charge', loop: true } },
    25: { Shoot: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10], Charge: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], recommendedChannel: { action: 'Charge', loop: true } },
  },
});

/** Keep the muzzle open throughout the cast, without replaying recovery frames. */
export function emissionPose(speciesId, elapsed, reduced = false) {
  if (speciesId === 9) return { action: 'Shoot', seconds: 5 / 60, loop: false };
  // Both Charge sheets were inspected: Charizard is leaning forward with its
  // jaw open; Pikachu exposes the red cheek. Their 10-frame breathing loops keep
  // the emitter attached and avoid baked whole-body flashes from Shock.
  if (speciesId === 6 || speciesId === 25) return { action: 'Charge', seconds: reduced ? 0 : Math.max(0, elapsed), loop: true };
  return { action: 'Shoot', seconds: Math.max(0, elapsed), loop: false };
}

/**
 * Return screen-space emission points for the EXACT sample that was painted.
 * x/y = sprite feet origin supplied to drawPmdSprite; scale = source pixel scale.
 * Pass the same stretchX/Y and an origin already adjusted for recoil/lift. The
 * rounding below matches drawPmdSprite's Math.round(x/y) before its transform.
 * Unsupported species, rows, frames or poses return [] rather than inventing a
 * body-centre origin. Never use these points as authoritative projectile data.
 */
export function muzzlePoints({ sample, speciesId = sample?.data?.id, dir = sample?.frame?.row, x, y, scale, stretchX = 1, stretchY = 1 } = {}) {
  if (!sample?.frame?.anchors?.feet || ![x, y, scale, stretchX, stretchY].every(Number.isFinite)) return [];
  const row = sample.frame.row ?? dir;
  if (dir != null && row !== dir) return []; // the anchor row must match the visible sprite
  const frame = sample.frame.frame ?? sample.frame.index;
  const action = sample.animation?.sourceName ?? sample.animation?.name;
  const cell = { 9: { Shoot: [48, 56], Charge: [40, 40] }, 6: { Shoot: [56, 56], Charge: [48, 48] }, 25: { Shoot: [40, 56], Charge: [40, 40] } }[speciesId]?.[action];
  if (!cell || (sample.frame.sw != null && sample.frame.sw !== cell[0]) || (sample.frame.sh != null && sample.frame.sh !== cell[1])) return [];
  const [feetX, feetY] = sample.frame.anchors.feet;
  const transform = (xy, kind, layer, occluded = false) => ({
    x: Math.round(x) + (xy[0] - feetX) * scale * stretchX,
    y: Math.round(y) + (xy[1] - feetY) * scale * stretchY,
    kind, layer, occluded,
  });
  if (speciesId === 9) {
    const points = CANNONS[action]?.[row]?.[frame];
    return points ? [transform(points[0], 'cannon-far', 'back', true), transform(points[1], 'cannon-near', 'front')] : [];
  }
  const xy = (speciesId === 6 ? MOUTHS : speciesId === 25 ? CHEEKS : {})[action]?.[row]?.[frame];
  return xy ? [transform(xy, speciesId === 6 ? 'mouth' : 'cheek-near', 'front')] : [];
}

/**
 * Explicitly UNCALIBRATED catalog preview fallback. A PMD Head/Center marker is
 * a source-authored attachment, but it is not evidence of a species' mouth,
 * cannon or limb. Callers must show “发射点未逐帧标定” whenever this is used.
 * Check the actual metadata row, not samplePmdFrame's synthetic centre fallback.
 */
export function metadataEmissionPoints({ sample, anchor = 'head', x, y, scale, stretchX = 1, stretchY = 1 } = {}) {
  if (!sample || !['head', 'center'].includes(anchor) || ![x, y, scale, stretchX, stretchY].every(Number.isFinite)) return [];
  const frame = sample.frame?.frame ?? sample.frame?.index;
  const row = sample.frame?.row;
  const source = sample.animation?.anchors?.[row]?.[frame];
  if (!source?.feet || !source[anchor]) return [];
  const [fx, fy] = source.feet, [px, py] = source[anchor];
  return [{ x: Math.round(x) + (px - fx) * scale * stretchX,
    y: Math.round(y) + (py - fy) * scale * stretchY,
    kind: `unverified-${anchor}`, layer: 'front', calibrated: false, source: 'pmd-generic-anchor' }];
}
