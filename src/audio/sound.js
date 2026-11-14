const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

/**
 * 効果音。音声ファイルは使わず、すべて Web Audio で合成する。
 * ブラウザの決まりで、音はユーザーが最初に操作した後でしか鳴らせない (resume() を呼ぶ)。
 */
export class Sound {
  constructor(settings) {
    this.settings = settings;
    this.ctx = null;
    this.ready = false;
    const resume = () => this.resume();
    window.addEventListener('pointerdown', resume);
    window.addEventListener('keydown', resume);
  }

  resume() {
    try {
      if (!this.ctx) this._build();
      if (this.ctx.state === 'suspended') this.ctx.resume();
    } catch {
      this.ctx = null; // 音が使えない環境では無音で続ける
    }
  }

  _build() {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    const ctx = new Ctx();
    this.ctx = ctx;

    // 2秒分の白色雑音を使い回す
    const len = ctx.sampleRate * 2;
    this.noiseBuffer = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = this.noiseBuffer.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;

    this.master = ctx.createGain();
    this.master.gain.value = 0;
    this.master.connect(ctx.destination);

    const noise = (type, freq, q = 0.7) => {
      const src = ctx.createBufferSource();
      src.buffer = this.noiseBuffer;
      src.loop = true;
      const filter = ctx.createBiquadFilter();
      filter.type = type;
      filter.frequency.value = freq;
      filter.Q.value = q;
      const gain = ctx.createGain();
      gain.gain.value = 0;
      src.connect(filter).connect(gain).connect(this.master);
      src.start();
      return { filter, gain };
    };
    const tone = (type, freq) => {
      const osc = ctx.createOscillator();
      osc.type = type;
      osc.frequency.value = freq;
      const gain = ctx.createGain();
      gain.gain.value = 0;
      osc.connect(gain).connect(this.master);
      osc.start();
      return { osc, gain };
    };

    this.engine = noise('lowpass', 300); // 主エンジンの噴射音
    this.engineHum = tone('sawtooth', 55); // 低いうなり
    this.thruster = noise('bandpass', 1400, 1.2); // 姿勢制御スラスター
    this.wind = noise('bandpass', 500, 0.5); // 風切り音
    this.rumble = noise('lowpass', 90); // 空力加熱・地上滑走の振動
    this.warn = tone('square', 560); // 失速警報・ミサイル警報
    this.lockTone = tone('sine', 900); // ロックオンの音
    this.ready = true;
  }

  _set(param, value, tau = 0.08) {
    param.setTargetAtTime(value, this.ctx.currentTime, tau);
  }

  /**
   * 毎フレーム呼ぶ。
   * s = { paused, thrust, boosting, lift, q, speed, heat, stall, roll, time }
   */
  update(s) {
    if (!this.ready) return;
    const vol = this.settings.volume ?? 0.6;
    this._set(this.master.gain, s.paused ? 0 : vol, 0.15);

    const thrust = clamp(s.thrust, 0, 1);
    this._set(this.engine.gain.gain, 0.05 + thrust * (s.boosting ? 0.55 : 0.5));
    this._set(this.engine.filter.frequency, 180 + thrust * (s.boosting ? 2000 : 1500));
    this._set(this.engineHum.gain.gain, 0.03 + thrust * 0.06);
    this._set(this.engineHum.osc.frequency, 48 + thrust * 50);

    this._set(this.thruster.gain.gain, clamp(s.lift, 0, 1) * 0.16);

    // 風: 動圧が大きいほど強く、速いほど高い音
    const wind = clamp(Math.sqrt(s.q) / 500, 0, 1);
    this._set(this.wind.gain.gain, wind * 0.55, 0.2);
    this._set(this.wind.filter.frequency, 250 + clamp(s.speed, 0, 1200) * 1.6, 0.2);

    this._set(this.rumble.gain.gain, clamp(s.heat * 0.9 + s.roll * 0.5, 0, 1.2), 0.15);

    // 警報: ミサイル接近 (速く高い) を失速 (遅く低い) より優先する
    const rate = s.missileWarn ? 9 : 4;
    const beep = (s.missileWarn || s.stall) && Math.sin(s.time * 2 * Math.PI * rate) > 0;
    this._set(this.warn.osc.frequency, s.missileWarn ? 980 : 560, 0.01);
    this._set(this.warn.gain.gain, beep ? 0.05 : 0, 0.01);

    // ロックオン: 進行中は断続音、完了すると高い連続音
    const locking = s.lock === 1 && Math.sin(s.time * 2 * Math.PI * 6) > 0;
    this._set(this.lockTone.osc.frequency, s.lock === 2 ? 1400 : 900, 0.01);
    this._set(this.lockTone.gain.gain, s.lock === 2 ? 0.02 : locking ? 0.03 : 0, 0.01);
  }

  /** 雑音を短く鳴らす (衝撃・爆発など)。 */
  _burst(freq, gain, decay, type = 'lowpass') {
    if (!this.ready) return;
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    const filter = ctx.createBiquadFilter();
    filter.type = type;
    filter.frequency.value = freq;
    const g = ctx.createGain();
    const t = ctx.currentTime;
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + decay);
    src.connect(filter).connect(g).connect(this.master);
    src.start(t, Math.random());
    src.stop(t + decay + 0.05);
  }

  /** 接地・衝突。speed は地面へ向かう速さ (m/s)。 */
  thump(speed) {
    this._burst(140 + speed * 12, clamp(0.25 + speed * 0.08, 0, 1.4), 0.25 + clamp(speed * 0.02, 0, 0.5));
  }

  /** 着陸装置の作動音。 */
  gear() {
    this._burst(900, 0.25, 0.18, 'bandpass');
    if (this.ready) setTimeout(() => this._burst(260, 0.4, 0.12), 1500);
  }

  /** volume: 0..1 (遠い爆発は小さく)。 */
  explosion(volume = 1) {
    if (volume < 0.02) return;
    this._burst(220, 1.6 * volume, 2.2);
    this._burst(1800, 0.7 * volume, 0.5, 'bandpass');
  }

  /** 高さが変わる短い音。 */
  _tone(f0, f1, gain, decay, type = 'square') {
    if (!this.ready) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(f0, t);
    osc.frequency.exponentialRampToValueAtTime(f1, t + decay);
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + decay);
    osc.connect(g).connect(this.master);
    osc.start(t);
    osc.stop(t + decay + 0.02);
  }

  /** 機関砲の発射音。 */
  gun() {
    this._tone(1100, 260, 0.07, 0.09);
    this._burst(2200, 0.12, 0.05, 'bandpass');
  }

  /** 自分の弾が当たった。hull = 機体まで届いた (シールドを抜けた)。 */
  hit(hull) {
    this._tone(hull ? 520 : 1700, hull ? 260 : 1200, 0.06, 0.07, 'triangle');
  }

  /** 自機のシールドが弾を受けた。 */
  shieldHit() {
    this._burst(2800, 0.3, 0.16, 'bandpass');
    this._tone(700, 350, 0.05, 0.15, 'sine');
  }

  /** ミサイルの発射音。 */
  missile(volume = 1) {
    if (volume < 0.02) return;
    this._burst(800, 0.8 * volume, 1.0, 'bandpass');
    this._tone(300, 90, 0.08 * volume, 0.5, 'sawtooth');
  }

  /** 操作の確認音 (モード切り替え)。 */
  click() {
    this._burst(2400, 0.12, 0.05, 'bandpass');
  }
}
