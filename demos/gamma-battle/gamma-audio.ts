import type { SnapEvent, SnapFighter } from '../../apps/web/arena/types';

// Original extracted Gamma audio, not synthesized. See evidence/web-audio.json.
const clips = {
  intro: new URL('./assets/audio/battle-intro.mp3', import.meta.url).href,
  loop: new URL('./assets/audio/battle-loop.mp3', import.meta.url).href,
  hover: new URL('./assets/audio/ui-hover.wav', import.meta.url).href,
  confirm: new URL('./assets/audio/ui-confirm.wav', import.meta.url).href,
  normal: new URL('./assets/audio/hit-normal.wav', import.meta.url).href,
  super: new URL('./assets/audio/hit-super.wav', import.meta.url).href,
  weak: new URL('./assets/audio/hit-weak.wav', import.meta.url).href,
  lost: new URL('./assets/audio/battle-lost.mp3', import.meta.url).href,
  victory: new URL('./assets/audio/battle-victory.mp3', import.meta.url).href,
  cry25: new URL('./assets/audio/cry-25.wav', import.meta.url).href,
  cry37: new URL('./assets/audio/cry-37.wav', import.meta.url).href,
  cry38: new URL('./assets/audio/cry-38.wav', import.meta.url).href,
  cry54: new URL('./assets/audio/cry-54.wav', import.meta.url).href,
  cry55: new URL('./assets/audio/cry-55.wav', import.meta.url).href,
  cry95: new URL('./assets/audio/cry-95.wav', import.meta.url).href,
  cry111: new URL('./assets/audio/cry-111.wav', import.meta.url).href,
  cry112: new URL('./assets/audio/cry-112.wav', import.meta.url).href,
  cry116: new URL('./assets/audio/cry-116.wav', import.meta.url).href,
  cry117: new URL('./assets/audio/cry-117.wav', import.meta.url).href,
  cry149: new URL('./assets/audio/cry-149.wav', import.meta.url).href,
  scratch: new URL('./assets/audio/moves/010-SND_Scratch.wav', import.meta.url).href,
  slam: new URL('./assets/audio/moves/021-SND_Slam.wav', import.meta.url).href,
  hornAttack: new URL('./assets/audio/moves/030-SND_Horn_Attack.wav', import.meta.url).href,
  tailWhip: new URL('./assets/audio/moves/039-SND_TailWhip.wav', import.meta.url).href,
  leer: new URL('./assets/audio/moves/043-SND_Leer.wav', import.meta.url).href,
  flamethrower: new URL('./assets/audio/moves/053-SND_Flamethrower.wav', import.meta.url).href,
  waterGun: new URL('./assets/audio/moves/055-SND_Water_Gun.wav', import.meta.url).href,
  agility: new URL('./assets/audio/moves/097-SND_Agility_part_1.wav', import.meta.url).href,
  quickAttack: new URL('./assets/audio/moves/098-SND_Quick_Attack.wav', import.meta.url).href,
  smokescreen: new URL('./assets/audio/moves/108-SND_Smokescreen.wav', import.meta.url).href,
  bubble: new URL('./assets/audio/moves/145-SND_Bubble.wav', import.meta.url).href,
  struggle: new URL('./assets/audio/moves/165-SND_Struggle.wav', import.meta.url).href,
};
type Clip = keyof typeof clips;
const cries: Partial<Record<number, Clip>> = {
  25: 'cry25', 37: 'cry37', 38: 'cry38', 54: 'cry54', 55: 'cry55', 95: 'cry95',
  111: 'cry111', 112: 'cry112', 116: 'cry116', 117: 'cry117', 149: 'cry149',
};
// Each title was read from the original Blueprint CDO, then its typed SoundWave
// import was followed. This is not a similar-filename match. See battle-effect-map.json.
const moveClips: Partial<Record<number, Clip>> = {
  10: 'scratch', 21: 'slam', 30: 'hornAttack', 39: 'tailWhip', 43: 'leer',
  53: 'flamethrower', 55: 'waterGun', 97: 'agility', 98: 'quickAttack',
  108: 'smokescreen', 145: 'bubble', 165: 'struggle',
};
const projectileMoves = new Set([39, 43, 108, 145]);
const activeFrameMoves = new Set([10, 21, 30, 53, 55, 98, 165]);

/** A demo event adapter; this does not claim to reproduce the game's audio Blueprint. */
export class GammaAudio {
  private enabled = false;
  private unlocked = false;
  private disposed = false;
  private context?: AudioContext;
  private master?: GainNode;
  private buffers = new Map<Clip, Promise<AudioBuffer>>();
  private sources = new Set<AudioBufferSourceNode>();
  private moveVoices = new Map<string, AudioBufferSourceNode>();
  private releases = new Set<string>();
  private music = new Set<AudioBufferSourceNode>();
  private musicEpoch = 0;
  private effectEpoch = 0;
  private musicStarted = false;
  private battleActive = false;
  private battleId = '';
  private recent = new Map<string, number>();
  private reported = new Set<string>();
  onError?: (message: string) => void;

  /** Call directly from a click, tap or key event. Muted remains the default. */
  unlock(): void {
    if (this.disposed) return;
    // A programmatic page-load call cannot grant autoplay permission.
    if (navigator.userActivation && !navigator.userActivation.isActive) return;
    this.unlocked = true;
    try {
      if (!this.context) {
        this.context = new AudioContext();
        this.master = this.context.createGain();
        this.master.gain.value = this.enabled ? 1 : 0;
        // Conservative gains plus a compressor guard the mix when voices overlap.
        const compressor = this.context.createDynamicsCompressor();
        compressor.threshold.value = -6;
        compressor.knee.value = 0;
        compressor.ratio.value = 20;
        compressor.attack.value = .003;
        compressor.release.value = .1;
        this.master.connect(compressor);
        compressor.connect(this.context.destination);
      }
      void this.context.resume().then(() => {
        if (this.disposed || !this.enabled) return;
        for (const clip of ['hover', 'confirm', 'normal', 'super', 'weak'] as Clip[])
          void this.load(clip).catch(error => this.report(error));
        if (this.battleActive) void this.startMusic();
      }).catch(error => this.report(error));
    } catch (error) { this.report(error); }
  }

  setEnabled(value: boolean): void {
    if (this.disposed) return;
    this.enabled = value;
    if (this.context && this.master)
      this.master.gain.setTargetAtTime(value ? 1 : 0, this.context.currentTime, .02);
    if (!value) {
      this.effectEpoch++;
      this.stopMusic();
      this.stopSources();
    } else if (this.unlocked && this.battleActive) void this.startMusic();
  }

  ui(kind: 'hover' | 'confirm' = 'confirm'): void {
    this.play(kind, kind === 'hover' ? .22 : .3, `ui:${kind}`, 75);
  }

  /** Pass already deduplicated presentation events; optional speciesId enables exact cries. */
  onEvent(event: SnapEvent): void {
    if (this.disposed) return;
    const battleId = typeof event.battleId === 'string' ? event.battleId : '';
    if (battleId && battleId !== this.battleId) {
      this.battleId = battleId;
      this.effectEpoch++;
      this.recent.clear();
      this.releases.clear();
      this.stopMusic();
      this.stopSources();
    }
    if (event.kind === 'start') {
      this.battleActive = true;
      this.effectEpoch++;
      this.stopMusic();
      this.stopSources();
      this.recent.clear();
      this.releases.clear();
      void this.startMusic();
      return;
    }
    const moveId = Number(event.moveId), clip = moveClips[moveId];
    // Skill/hazardStart are windup events in engine 9. They may preload but must
    // never play a release cue: a cast can still be cancelled before activeTick.
    if (event.kind === 'skill' && clip && this.ready())
      void this.load(clip).catch(error => this.report(error));
    if (event.kind === 'fire' && projectileMoves.has(moveId))
      this.release(moveId, event.actor, `fire:${event.effectiveTick ?? event.tick}`);
    // resolve_self emits this after Agility actually applies its speed buff.
    if (event.kind === 'buff' && moveId === 97 && event.stat === 'speed' && event.up === true)
      this.release(moveId, event.actor, `buff:${event.effectiveTick ?? event.tick}`);
    if (event.kind === 'damage' && Number(event.amount) > 0) {
      const effectiveness = typeof event.effectiveness === 'number' ? event.effectiveness : 1;
      if (effectiveness <= 0) return;
      this.play(effectiveness > 1 ? 'super' : effectiveness < 1 ? 'weak' : 'normal',
        .4, `hit:${event.actor ?? ''}`, 90);
    }
    if (event.kind === 'ko' || event.kind === 'cry') {
      const clip = cries[Number(event.speciesId)];
      if (clip) this.play(clip, .36, `cry:${event.actor ?? event.speciesId}`, 250);
    }
    if (event.kind === 'result') {
      this.battleActive = false;
      this.stopMusic();
      // Stable IDs belong to the isolated demo API. A draw has no invented victory cue.
      if (event.winner === 'player') this.play('victory', .16, 'result', 500, 5000);
      else if (event.winner === 'opponent') this.play('lost', .2, 'result', 500, 5000);
    }
  }

  /** Completed authoritative Timeline frames, not predicted cast deadlines. */
  onFrame(fighters: SnapFighter[], tick: number): void {
    if (this.disposed || !this.battleActive || !Number.isFinite(tick)) return;
    for (const fighter of fighters) {
      const cast = fighter.cast;
      if (!cast || !activeFrameMoves.has(cast.moveId) || fighter.hp <= 0 ||
          (fighter.phase ?? cast.phase) !== 'active') continue;
      const start = cast.startTick ?? cast.start + 1;
      const active = cast.activeTick ?? cast.active + 1;
      if (!Number.isFinite(start) || tick < active || tick >= active + cast.activeLen) continue;
      this.release(cast.moveId, fighter.id, `cast:${start}`);
    }
  }

  private release(moveId: number, actor: string | null | undefined, instance: string): void {
    const clip = moveClips[moveId];
    if (!clip || !actor || !this.battleActive) return;
    const key = `${actor}:${moveId}:${instance}`;
    if (this.releases.has(key)) return;
    this.releases.add(key);
    if (this.releases.size > 256) this.releases.delete(this.releases.values().next().value!);
    // One primary source per release. No guessed impact cues or generic fallback.
    this.play(clip, .22, `move:${actor}`, 180, 450, actor);
  }

  private ready(): boolean {
    return !this.disposed && this.enabled && this.unlocked && this.context?.state === 'running';
  }

  private load(clip: Clip): Promise<AudioBuffer> {
    const cached = this.buffers.get(clip);
    if (cached) return cached;
    const context = this.context;
    if (!context) return Promise.reject(new Error('音频尚未通过用户操作启用。'));
    const pending = fetch(clips[clip]).then(async response => {
      if (!response.ok) throw new Error(`Gamma 原音频加载失败：${clip} (${response.status})`);
      return context.decodeAudioData(await response.arrayBuffer());
    });
    this.buffers.set(clip, pending);
    return pending;
  }

  private source(buffer: AudioBuffer, volume: number, when: number, loop = false,
    music = false, actor?: string): AudioBufferSourceNode {
    const context = this.context!, source = context.createBufferSource(), gain = context.createGain();
    source.buffer = buffer;
    source.loop = loop;
    gain.gain.value = Math.max(0, Math.min(.4, volume));
    source.connect(gain);
    gain.connect(this.master!);
    this.sources.add(source);
    if (music) this.music.add(source);
    if (actor) this.moveVoices.set(actor, source);
    source.onended = () => {
      this.sources.delete(source);
      this.music.delete(source);
      if (actor && this.moveVoices.get(actor) === source) this.moveVoices.delete(actor);
      source.disconnect();
      gain.disconnect();
    };
    source.start(when);
    return source;
  }

  private play(clip: Clip, volume: number, key: string, interval: number, maxDelay = 650,
    actor?: string): void {
    if (!this.ready()) return;
    const now = performance.now();
    if (now - (this.recent.get(key) ?? -Infinity) < interval) return;
    this.recent.set(key, now);
    const epoch = this.effectEpoch;
    void this.load(clip).then(buffer => {
      if (!this.ready() || epoch !== this.effectEpoch || performance.now() - now > maxDelay) return;
      if (actor && !this.battleActive) return;
      const effects = [...this.sources].filter(source => !this.music.has(source));
      if (effects.length >= 8) effects[0].stop();
      if (actor) this.moveVoices.get(actor)?.stop();
      this.source(buffer, volume, this.context!.currentTime, false, false, actor);
    }).catch(error => this.report(error));
  }

  private async startMusic(): Promise<void> {
    if (!this.ready() || !this.battleActive || this.musicStarted) return;
    this.musicStarted = true;
    const epoch = ++this.musicEpoch;
    try {
      const [intro, loop] = await Promise.all([this.load('intro'), this.load('loop')]);
      if (!this.ready() || !this.battleActive || epoch !== this.musicEpoch) return;
      const start = this.context!.currentTime + .015;
      this.source(intro, .15, start, false, true);
      // Schedule on one audio clock instead of an ended event to avoid a JS-timer gap.
      this.source(loop, .15, start + intro.duration, true, true);
    } catch (error) {
      if (epoch === this.musicEpoch) this.musicStarted = false;
      this.report(error);
    }
  }

  private stopMusic(): void {
    this.musicEpoch++;
    this.musicStarted = false;
    for (const source of this.music) source.stop();
    this.music.clear();
  }

  private stopSources(): void {
    for (const source of this.sources) source.stop();
    this.sources.clear();
    this.moveVoices.clear();
  }

  private report(error: unknown): void {
    if (this.disposed) return;
    const message = error instanceof Error ? error.message : String(error);
    if (this.reported.has(message)) return;
    this.reported.add(message);
    console.warn('[GammaAudio]', message);
    this.onError?.(message);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.effectEpoch++;
    this.stopMusic();
    this.stopSources();
    this.buffers.clear();
    this.releases.clear();
    if (this.context) void this.context.close();
  }
}
