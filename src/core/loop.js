/**
 * 固定ステップ物理 + 可変フレーム描画のゲームループ。
 * step(h) は常に同じ刻み幅で呼ばれるので、挙動がフレームレートに依存しない。
 * frame(alpha, dt) の alpha は「最後の物理ステップから次のステップまでの進み具合」(0..1)。
 */
export class Loop {
  constructor({ hz = 120, beginFrame, step, frame }) {
    this.h = 1 / hz;
    this.beginFrame = beginFrame;
    this.step = step;
    this.frame = frame;
    this.acc = 0;
    this.last = 0;
    this.running = false;
    this._tick = this._tick.bind(this);
  }

  start() {
    this.running = true;
    this.last = performance.now();
    requestAnimationFrame(this._tick);
  }

  _tick(now) {
    if (!this.running) return;
    const dt = Math.min((now - this.last) / 1000, 0.1); // タブ復帰時などの飛びを抑える
    this.last = now;

    this.beginFrame(dt);
    this.acc += dt;
    while (this.acc >= this.h) {
      this.step(this.h);
      this.acc -= this.h;
    }
    this.frame(this.acc / this.h, dt);
    requestAnimationFrame(this._tick);
  }
}
