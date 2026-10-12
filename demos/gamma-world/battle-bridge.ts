import { getGammaBattle, type GammaBattle, type GammaPlayerState } from '../gamma-battle/api-client';

export type GammaWorldFighter = Pick<GammaBattle['fighters'][number],
  'id' | 'speciesId' | 'name' | 'level' | 'hp' | 'maxHp' | 'energy' | 'status'> & {
    moves: { id: number; name?: string; nameEn?: string; type?: string; pp: number; remainingPp: number }[];
  };
export type GammaEncounterOptions = {
  encounterId: string;
  playerSpeciesId: number;
  opponentSpeciesId: number;
  level: number;
  seed?: number;
  playerState?: GammaPlayerState;
};
export type GammaEmbeddedOptions = GammaEncounterOptions & { bridgeSessionId: string };
export type GammaBattleResult = {
  type: 'gamma:battle-result';
  encounterId: string;
  bridgeSessionId: string;
  battleId: string;
  winner: string | null;
  playerFighter: GammaWorldFighter;
};

const integer = (value: unknown, min: number, max: number): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

function validate(options: GammaEmbeddedOptions): void {
  if (!integer(options.playerSpeciesId, 1, 151) || !integer(options.opponentSpeciesId, 1, 151) ||
      !integer(options.level, 1, 100) || options.seed !== undefined && !integer(options.seed, 1, 4294967295))
    throw new Error('探索对局的伙伴、等级或随机种子无效。');
  if (typeof options.encounterId !== 'string' || !options.encounterId.length || options.encounterId.length > 96 ||
      typeof options.bridgeSessionId !== 'string' || !/^[a-zA-Z0-9_-]{16,96}$/.test(options.bridgeSessionId))
    throw new Error('探索遭遇或桥接会话无效。');
  const state = options.playerState;
  if (state !== undefined && (!object(state) || typeof state.hp !== 'number' || !Number.isFinite(state.hp) || state.hp <= 0 ||
      !Array.isArray(state.movePp) || state.movePp.length < 1 || state.movePp.length > 4 ||
      state.movePp.some(row => !object(row) || !integer(row.moveId, 1, 165) || !integer(row.remainingPp, 0, 99))))
    throw new Error('伙伴当前体力或 PP 无效；无法战斗时请先回营地。');
}

/** Embedded mode accepts URL initialization only; it exposes no message command channel. */
export function readEmbeddedBattle(url: string): GammaEmbeddedOptions | undefined {
  const query = new URL(url).searchParams;
  if (query.get('embedded') !== '1') return;
  let playerState: GammaPlayerState | undefined;
  if (query.has('playerState')) {
    try { playerState = JSON.parse(query.get('playerState')!); }
    catch { throw new Error('无法读取探索伙伴状态。'); }
  }
  const options: GammaEmbeddedOptions = {
    encounterId: query.get('encounterId') ?? '', bridgeSessionId: query.get('bridgeSessionId') ?? '',
    playerSpeciesId: Number(query.get('player')), opponentSpeciesId: Number(query.get('opponent')),
    level: Number(query.get('level')), ...(query.has('seed') ? { seed: Number(query.get('seed')) } : {}),
    ...(playerState === undefined ? {} : { playerState }),
  };
  validate(options);
  return options;
}

export function playerStateFromResult(fighter: GammaWorldFighter): GammaPlayerState {
  return { hp: fighter.hp, movePp: fighter.moves.map(move => ({ moveId: move.id, remainingPp: move.remainingPp })) };
}

export function gammaBattleResult(battle: GammaBattle): GammaBattleResult {
  if (battle.status !== 'finished' || !battle.encounterId || !battle.bridgeSessionId)
    throw new Error('尚无可返回探索的完整战斗结果。');
  const f = battle.fighters.find(fighter => fighter.id === battle.playerId);
  if (!f) throw new Error('战斗结果缺少伙伴状态。');
  const moves = f.moves.map(move => {
    if (!integer(move.pp, 1, 99) || !integer(move.remainingPp, 0, move.pp))
      throw new Error('战斗结果缺少完整 PP，已拒绝保存伙伴状态。');
    return { ...move, pp: move.pp, remainingPp: move.remainingPp };
  });
  return {
    type: 'gamma:battle-result', encounterId: battle.encounterId, bridgeSessionId: battle.bridgeSessionId,
    battleId: battle.id, winner: battle.winner ?? null,
    playerFighter: { id: f.id, speciesId: f.speciesId, name: f.name, level: f.level, hp: f.hp, maxHp: f.maxHp,
      energy: f.energy, status: f.status, moves },
  };
}

/** The caller owns iframe removal and world persistence. Dispose never invents a result. */
export function openGammaBattle(iframe: HTMLIFrameElement, options: GammaEncounterOptions,
  onResult: (result: GammaBattleResult) => void | Promise<void>, onError?: (error: Error) => void) {
  const origin = window.location.origin;
  const embedded: GammaEmbeddedOptions = { ...options, bridgeSessionId: crypto.randomUUID() };
  validate(embedded);
  const url = new URL('/demos/gamma-battle/', origin);
  for (const [key, value] of Object.entries({ embedded: '1', player: options.playerSpeciesId,
    opponent: options.opponentSpeciesId, level: options.level, encounterId: options.encounterId,
    bridgeSessionId: embedded.bridgeSessionId, ...(options.seed === undefined ? {} : { seed: options.seed }),
    ...(options.playerState ? { playerState: JSON.stringify(options.playerState) } : {}) }))
    url.searchParams.set(key, String(value));
  let disposed = false, settled = false, verifying = false, boundBattleId: string | undefined;
  const check = (battle: GammaBattle) => {
    if (battle.encounterId !== embedded.encounterId || battle.bridgeSessionId !== embedded.bridgeSessionId ||
        battle.playerSpeciesId !== options.playerSpeciesId || battle.opponentSpeciesId !== options.opponentSpeciesId ||
        battle.fighters.find(f => f.id === battle.playerId)?.level !== options.level ||
        battle.source !== 'authoritative-live-memory' || battle.persisted !== false)
      throw new Error('探索对局绑定不一致，已拒绝采用此结果。');
  };
  const listener = async (event: MessageEvent) => {
    const data: unknown = event.data;
    if (disposed || settled || event.origin !== origin || event.source !== iframe.contentWindow || !object(data) ||
        data.encounterId !== embedded.encounterId || data.bridgeSessionId !== embedded.bridgeSessionId) return;
    if (data.type === 'gamma:battle-error') {
      onError?.(new Error(typeof data.message === 'string' ? data.message.slice(0, 500) : '探索对局无法继续。'));
      return;
    }
    if (data.type !== 'gamma:battle-started' && data.type !== 'gamma:battle-result') return;
    if (typeof data.battleId !== 'string' || !/^[a-f0-9]{32}$/.test(data.battleId)) return;
    if (boundBattleId && data.battleId !== boundBattleId) return;
    if (data.type === 'gamma:battle-started') { boundBattleId = data.battleId; return; }
    if (verifying) return;
    verifying = true;
    try {
      // Never save the HP/PP/winner supplied by postMessage: re-read the finished
      // authoritative in-memory battle and verify its server-side encounter binding.
      const battle = await getGammaBattle(data.battleId);
      if (disposed || settled) return;
      check(battle);
      const result = gammaBattleResult(battle);
      await onResult(result);
      settled = true;
    } catch (error) {
      if (!disposed) onError?.(error instanceof Error ? error : new Error(String(error)));
    } finally { verifying = false; }
  };
  window.addEventListener('message', listener);
  iframe.src = url.href;
  return {
    sessionId: embedded.bridgeSessionId, url: url.href,
    reload() { if (!disposed && !settled) iframe.src = url.href; },
    dispose() { disposed = true; window.removeEventListener('message', listener); },
  };
}
