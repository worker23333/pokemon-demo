import { resolvePmdAnimation, type PmdSpecies } from '../../packages/presentation/pmd-sprites.js';
import { MODEL_PIXEL_WORLD_SCALE } from './model-scale';

/** Exploration and battle share the source artwork's pixel proportions. */
export type PokemonModelSize = Readonly<{
  worldHeight: number;
  worldWidth: number;
  pixelWorldScale: number;
  sourceHeight: number;
  sourceWidth: number;
}>;
const sizes = new WeakMap<PmdSpecies, { speciesId: number; size: PokemonModelSize }>();

/** One scale for a species, never one scale per frame/action/direction. Only
 * Idle/Walk bounds contribute: attack trails and extended action cells must
 * not enlarge or shrink the normal body. Feet-relative bounds also work when
 * different sheets have different transparent padding or pivot locations. */
export function pokemonModelSize(speciesId: number, data: PmdSpecies): PokemonModelSize {
  const cached = sizes.get(data);
  if (cached?.speciesId === speciesId) return cached.size;
  let left = Infinity, right = -Infinity, top = Infinity, bottom = -Infinity;
  for (const action of ['Idle', 'Walk']) {
    const animation = resolvePmdAnimation(data, action);
    for (const row of animation?.anchors ?? []) for (const anchors of row) {
      const bounds = anchors.bounds, feet = anchors.feet;
      if (!bounds || !feet || ![...bounds, ...feet].every(Number.isFinite) || bounds[2] <= bounds[0] || bounds[3] <= bounds[1]) continue;
      left = Math.min(left, bounds[0] - feet[0]); right = Math.max(right, bounds[2] - feet[0]);
      top = Math.min(top, bounds[1] - feet[1]); bottom = Math.max(bottom, bounds[3] - feet[1]);
    }
  }
  const fallback = Number.isFinite(data.displayHeight) && data.displayHeight > 0 ? data.displayHeight : 1;
  const sourceWidth = Number.isFinite(right - left) ? Math.max(1, right - left) : fallback;
  const sourceHeight = Number.isFinite(bottom - top) ? Math.max(1, bottom - top) : fallback;
  const pixelWorldScale = MODEL_PIXEL_WORLD_SCALE;
  const size = Object.freeze({ worldHeight: sourceHeight * pixelWorldScale,
    worldWidth: sourceWidth * pixelWorldScale, pixelWorldScale, sourceHeight, sourceWidth });
  sizes.set(data, { speciesId, size });
  return size;
}
