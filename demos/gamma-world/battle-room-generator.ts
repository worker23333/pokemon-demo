import { FIELD_BODY_RADIUS, fieldCanStand, fieldCanTravel } from './field-navigation';
import type { FieldArenaInput, FieldObstacle, FieldPoint } from './field-types';
import type { BattleRoomLayout, RoomContext, RoomPaletteItem, RoomProp, RoomPropKind } from './battle-room-types';

type Slot = readonly [number, number];
type Template = { id: string; name: string; slots: readonly Slot[] };

/** Authored room motifs, then seeded prop selection/mirroring/jitter. The shape
 * of a playable room is designed first; it is never an unrestricted scatter. */
const TEMPLATES: readonly Template[] = [
  { id: 'corner-pockets', name: '四角掩体', slots: [[-3.6,-2.3],[3.6,-2.3],[-3.6,2.3],[3.6,2.3]] },
  { id: 'twin-wings', name: '双翼阵地', slots: [[-3.6,-1.25],[-3.6,1.25],[3.6,-1.25],[3.6,1.25],[0,-2.3],[0,2.3]] },
  { id: 'staggered', name: '交错掩体', slots: [[-3.6,2.3],[-1.2,2.3],[1.2,-2.3],[3.6,-2.3],[-3.6,-1.25],[3.6,1.25]] },
  { id: 'side-passages', name: '侧路回廊', slots: [[-3.6,-1.25],[-3.6,1.25],[3.6,-1.25],[3.6,1.25],[-1.2,2.3],[1.2,-2.3]] },
  { id: 'perimeter-islands', name: '环周列岛', slots: [[-3.6,-2.3],[-1.2,-2.3],[1.2,-2.3],[3.6,-2.3],[-3.6,2.3],[-1.2,2.3],[1.2,2.3],[3.6,2.3]] },
  { id: 'split-groves', name: '对向疏林', slots: [[-2.6,-2.3],[0,-2.3],[2.6,-2.3],[-2.6,2.3],[0,2.3],[2.6,2.3]] },
];

const CLEAR_AREA = { halfWidth: 2.1, halfDepth: 1.5 };
const STARTS = [{ x: -4.8, z: 0 }, { x: 4.8, z: 0 }];
const RING = { halfWidth: 6.8, halfDepth: 4.8, radius: .74, columns: 15, rows: 11 };
// The full loop, plus the central crossing, remains walkable with a .55m body.
const BYPASS: readonly FieldPoint[] = [{ x: -5.1, z: -3.4 }, { x: 5.1, z: -3.4 }, { x: 5.1, z: 3.4 }, { x: -5.1, z: 3.4 }];
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));
const finite = (n: number, fallback: number) => Number.isFinite(n) ? n : fallback;
const rounded = (n: number) => Math.round(n * 10000) / 10000;

function randomSource(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let value = Math.imul(state ^ state >>> 15, state | 1);
    value ^= value + Math.imul(value ^ value >>> 7, value | 61);
    return ((value ^ value >>> 14) >>> 0) / 4294967296;
  };
}

function weighted(items: RoomPaletteItem[], random: () => number): RoomPaletteItem {
  const weights = items.map(p => clamp(finite(p.weight, 1), .001, 100000));
  let ticket = random() * weights.reduce((sum, weight) => sum + weight, 0);
  for (let i = 0; i < items.length; i++) if ((ticket -= weights[i]) <= 0) return items[i];
  return items[items.length - 1];
}

function fallback(context: RoomContext, breakable: boolean): RoomPaletteItem {
  const kind: RoomPropKind = breakable
    ? (context.theme === 'forest' || context.theme === 'meadow' ? 'plant' : 'crate')
    : (context.theme === 'forest' || context.theme === 'meadow' ? 'tree' : 'rock');
  return { sourceId: '', kind, radius: .4, height: kind === 'tree' ? 1.8 : kind === 'plant' ? .65 : .85, destructible: breakable, weight: 1 };
}

function paletteFor(context: RoomContext, role: 'boundary' | 'solid' | 'breakable') {
  const matches = context.palette.filter(p => role === 'boundary'
    ? p.kind === 'tree' || p.kind === 'rock'
    : role === 'solid' ? !p.destructible && (p.kind === 'tree' || p.kind === 'rock')
      : p.destructible && (p.kind === 'crate' || p.kind === 'plant'));
  return matches.length ? matches : [fallback(context, role === 'breakable')];
}

function circleTouchesClearArea(p: FieldPoint, radius: number) {
  const dx = Math.max(0, Math.abs(p.x) - CLEAR_AREA.halfWidth), dz = Math.max(0, Math.abs(p.z) - CLEAR_AREA.halfDepth);
  return Math.hypot(dx, dz) < radius + .05;
}

function createLayout(context: RoomContext, seed: number, attempt: number): BattleRoomLayout {
  const random = randomSource((seed + Math.imul(attempt, 0x9e3779b9)) >>> 0);
  const template = TEMPLATES[Math.floor(random() * TEMPLATES.length)];
  // Quarter-turns of a rectangular room would exchange its axes and pinch the
  // bypass lanes. Use the two rotations that preserve this 14 × 10 footprint.
  const quarterTurns = random() < .5 ? 0 : 2, rotation = quarterTurns ? -1 : 1;
  const mirror = random() < .5 ? -1 : 1;
  const obstacles: FieldObstacle[] = [], props: RoomProp[] = [];
  const add = (source: RoomPaletteItem, x: number, z: number, radius: number, boundary: boolean, breakable: boolean) => {
    const id = `room:${seed}:${boundary ? 'boundary' : 'cover'}:${props.length}`;
    const kind = source.kind;
    const prop: RoomProp = { id, ...(source.sourceId ? { sourceId: source.sourceId } : {}), kind, x: rounded(x), z: rounded(z),
      radius: rounded(radius), height: rounded(clamp(finite(source.height, 1), boundary ? .8 : .45, boundary ? 1.45 : 2.1)),
      rotation: rounded(random() * Math.PI * 2), boundary };
    props.push(prop);
    obstacles.push({ id, kind, x: prop.x, z: prop.z, radius: prop.radius,
      solid: !breakable, hp: breakable ? kind === 'plant' ? 26 : 48 : null });
  };

  const boundaryPalette = paletteFor(context, 'boundary');
  const boundary = (x: number, z: number) => add(weighted(boundaryPalette, random), x, z, RING.radius, true, false);
  // Clockwise ordering makes continuity inspectable, including the final seam.
  for (let i = 0; i < RING.columns; i++) boundary(-RING.halfWidth + 2 * RING.halfWidth * i / RING.columns, -RING.halfDepth);
  for (let i = 0; i < RING.rows; i++) boundary(RING.halfWidth, -RING.halfDepth + 2 * RING.halfDepth * i / RING.rows);
  for (let i = 0; i < RING.columns; i++) boundary(RING.halfWidth - 2 * RING.halfWidth * i / RING.columns, RING.halfDepth);
  for (let i = 0; i < RING.rows; i++) boundary(-RING.halfWidth, RING.halfDepth - 2 * RING.halfDepth * i / RING.rows);

  const solidPalette = paletteFor(context, 'solid'), breakablePalette = paletteFor(context, 'breakable');
  const firstBreakable = Math.floor(random() * template.slots.length);
  for (let i = 0; i < template.slots.length; i++) {
    const [sx, sz] = template.slots[i], jitter = attempt < 4 ? .08 : 0;
    const x = sx * rotation * mirror + (random() - .5) * jitter * 2;
    const z = sz * rotation + (random() - .5) * jitter * 2;
    // Alternating authored slots guarantee both durable and breakable cover.
    const breakable = (i + firstBreakable) % 2 === 0;
    const source = weighted(breakable ? breakablePalette : solidPalette, random);
    add(source, x, z, clamp(finite(source.radius, .4), .32, .43), false, breakable);
  }
  const field: FieldArenaInput = { mapId: `${context.mapId.slice(0, 150)}:room`, origin: { x: 0, z: 0 },
    playerStart: { ...STARTS[quarterTurns ? 1 : 0] }, opponentStart: { ...STARTS[quarterTurns ? 0 : 1] }, obstacles,
    terrain: { x0: -7, z0: -5, cellSize: .4, cols: 36, rows: 26, heights: Array(36 * 26).fill(0), maxStep: .48 } };
  return { seed, templateId: template.id, templateName: template.name, quarterTurns,
    context: { ...context, position: { ...context.position }, palette: context.palette.map(p => ({ ...p })) },
    field, props, clearArea: { ...CLEAR_AREA } };
}

function isPlayable(layout: BattleRoomLayout) {
  const { terrain, obstacles, playerStart, opponentStart } = layout.field;
  if (obstacles.length > 256 || layout.props.some(p => circleTouchesClearArea(p, p.radius))) return false;
  if (!fieldCanStand(terrain, obstacles, playerStart, FIELD_BODY_RADIUS) || !fieldCanStand(terrain, obstacles, opponentStart, FIELD_BODY_RADIUS)) return false;
  if (!fieldCanTravel(terrain, obstacles, playerStart, opponentStart, FIELD_BODY_RADIUS)) return false;
  return BYPASS.every((point, i) => fieldCanTravel(terrain, obstacles, point, BYPASS[(i + 1) % BYPASS.length], FIELD_BODY_RADIUS));
}

/** Seeded, theme-aware arena geometry only. Existing authoritative combat and
 * navigation validate/use the resulting field without any rules changes. */
export function generateBattleRoom(context: RoomContext, seed: number): BattleRoomLayout {
  const normalizedSeed = finite(Math.trunc(seed), 1) >>> 0;
  for (let attempt = 0; attempt < 4; attempt++) {
    const layout = createLayout(context, normalizedSeed, attempt);
    if (isPlayable(layout)) return layout;
  }
  // No unbounded scatter retry: the last pass removes jitter from authored
  // safe slots. It still retains the seed/theme and the complete boundary.
  return createLayout(context, normalizedSeed, 4);
}
