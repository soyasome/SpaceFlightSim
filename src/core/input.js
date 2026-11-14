import { makeControls } from '../flight/ship.js';

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const deadzone = (v, dz) => (Math.abs(v) < dz ? 0 : (v - Math.sign(v) * dz) / (1 - dz));

/**
 * キーボード・マウス・ゲームパッドをまとめて操縦入力 (controls) にする。
 * マウスは「仮想スティック」: 動かした分だけスティックが倒れ、戻さない限り倒れたまま。
 */
export class Input {
  constructor(element, settings) {
    this.element = element;
    this.settings = settings;
    this.enabled = true; // false の間 (メニュー表示中) は操縦入力を受け付けない
    this.controls = makeControls();
    this.keys = new Set();
    this.stick = { x: 0, y: 0 }; // マウス仮想スティック -1..1
    this.look = { yaw: 0, pitch: 0 }; // 見回し角 (rad)
    this.looking = false;
    this.throttle = 0;
    this.handlers = {}; // 'view' | 'assist' などの単発イベント
    this.locked = false;
    this.firing = false; // 機関砲の引き金 (左クリックを押している間)
    this._padFire = false;
    // マウスを固定 (ポインターロック) できない環境では、画面中央からの距離で操縦する
    this.absolute = false;
    this._padPrev = [];

    window.addEventListener('keydown', (e) => this._onKey(e, true));
    window.addEventListener('keyup', (e) => this._onKey(e, false));
    window.addEventListener('blur', () => { this.keys.clear(); this.firing = false; });
    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === this.element;
      if (!this.locked) this.looking = false;
    });
    document.addEventListener('mousemove', (e) => this._onMouseMove(e));
    element.addEventListener('mousedown', (e) => {
      if (!this.enabled) return;
      if (!this.mouseActive) this.lock();
      else if (e.button === 0) this.firing = true;
      else if (e.button === 2) this.looking = true;
      else if (e.button === 1) this.centerStick();
    });
    window.addEventListener('mouseup', (e) => {
      if (e.button === 2) this.looking = false;
      if (e.button === 0) this.firing = false;
    });
    element.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  on(name, fn) {
    this.handlers[name] = fn;
  }

  emit(name) {
    this.handlers[name]?.();
  }

  lock() {
    if (this.absolute) return;
    try {
      const p = this.element.requestPointerLock?.();
      p?.catch?.(() => { this.absolute = true; });
    } catch {
      this.absolute = true;
    }
  }

  /** マウス操縦が有効か。 */
  get mouseActive() {
    return this.locked || this.absolute;
  }

  centerStick() {
    this.stick.x = 0;
    this.stick.y = 0;
  }

  _onKey(e, down) {
    if (e.code.startsWith('Arrow') || e.code === 'Space' || e.code === 'Tab') e.preventDefault();
    if (down && !e.repeat) {
      if (e.code === 'Tab') this.emit('menu');
      if (e.code === 'Escape') this.emit('menuClose');
      if (e.code === 'KeyM') this.emit('map');
    }
    if (!this.enabled) return;
    if (down) {
      if (!e.repeat) {
        if (e.code === 'KeyV') this.emit('view');
        if (e.code === 'KeyZ') this.emit('assist');
        if (e.code === 'KeyJ') this.emit('cruise');
        if (e.code === 'KeyG') this.emit('gear');
        if (e.code === 'Space') this.emit('missile');
        if (e.code === 'KeyT') this.emit('target');
        if (e.code === 'KeyY') this.emit('targetNext');
        if (e.code === 'KeyN') this.emit('reinforce');
        if (e.code === 'KeyB') this.emit('nav');
        if (e.code === 'KeyK') this.emit('jump');
        if (e.code === 'KeyH') this.emit('hover');
        if (e.code === 'KeyX') this.throttle = 0;
        if (e.code === 'KeyC') this.centerStick();
        if (e.code === 'KeyI') this.settings.set('invertY', !this.settings.invertY);
      }
      this.keys.add(e.code);
    } else {
      this.keys.delete(e.code);
    }
  }

  _onMouseMove(e) {
    if (!this.mouseActive || !this.enabled) return;
    if (this.absolute && !this.looking) {
      // 画面中央からの位置をそのままスティックの倒れ量にする
      const r = Math.min(window.innerWidth, window.innerHeight) * 0.38 / this.settings.mouseSensitivity;
      this.stick.x = (e.clientX - window.innerWidth / 2) / r;
      this.stick.y = (e.clientY - window.innerHeight / 2) / r;
      const len = Math.hypot(this.stick.x, this.stick.y);
      if (len > 1) {
        this.stick.x /= len;
        this.stick.y /= len;
      }
      return;
    }
    if (this.looking) {
      const k = 0.003 * this.settings.lookSensitivity;
      this.look.yaw = clamp(this.look.yaw - e.movementX * k, -2.6, 2.6);
      this.look.pitch = clamp(this.look.pitch - e.movementY * k, -1.2, 1.3);
      return;
    }
    const s = this.settings.mouseSensitivity / 260; // 感度×1 なら 260px でスティック全倒し
    this.stick.x += e.movementX * s;
    this.stick.y += e.movementY * s;
    const len = Math.hypot(this.stick.x, this.stick.y);
    if (len > 1) {
      this.stick.x /= len;
      this.stick.y /= len;
    }
  }

  _axis(neg, pos) {
    return (this.keys.has(pos) ? 1 : 0) - (this.keys.has(neg) ? 1 : 0);
  }

  /** 毎フレーム1回呼ぶ。controls を更新する。 */
  update(dt) {
    const c = this.controls;

    // 見回しは離すと正面に戻る
    if (!this.looking) {
      const k = Math.exp(-dt * 8);
      this.look.yaw *= k;
      this.look.pitch *= k;
    }

    // スロットル (保持式)
    this.throttle = clamp(this.throttle + this._axis('KeyS', 'KeyW') * dt * 0.7, -1, 1);

    const stickPitch = (this.settings.invertY ? -1 : 1) * deadzone(this.stick.y, 0.06);
    let pitch = stickPitch + this._axis('ArrowUp', 'ArrowDown');
    let yaw = deadzone(this.stick.x, 0.06) + this._axis('ArrowLeft', 'ArrowRight');
    let roll = this._axis('KeyQ', 'KeyE');
    let strafeX = this._axis('KeyA', 'KeyD');
    let strafeY = this._axis('KeyF', 'KeyR');
    let boost = this.keys.has('ShiftLeft') || this.keys.has('ShiftRight') ? 1 : 0;

    // ゲームパッド (標準配置): 左スティック=ロール/ピッチ, 右スティック=ヨー/上下,
    // RT/LT=スロットル, A=ブースト, X=アシスト, Y=視点, B=着陸装置, LB=ホバー,
    // RB=機関砲, 左スティック押し込み=的を選ぶ, 右スティック押し込み=ミサイル
    const pad = navigator.getGamepads?.().find((g) => g && g.mapping === 'standard');
    if (pad) {
      roll += deadzone(pad.axes[0], 0.15);
      pitch += deadzone(pad.axes[1], 0.15);
      yaw += deadzone(pad.axes[2], 0.15);
      strafeY += -deadzone(pad.axes[3], 0.15);
      this.throttle = clamp(
        this.throttle + (pad.buttons[7].value - pad.buttons[6].value) * dt * 0.7, -1, 1);
      if (pad.buttons[0].pressed) boost = 1;
      const pressed = (i) => pad.buttons[i].pressed && !this._padPrev[i];
      if (pressed(2)) this.emit('assist');
      if (pressed(3)) this.emit('view');
      if (pressed(1)) this.emit('gear');
      if (pressed(4)) this.emit('hover');
      if (pressed(10)) this.emit('target');
      if (pressed(11)) this.emit('missile');
      // RB を押している間は機関砲
      if (pad.buttons[5].pressed) this.firing = true;
      else if (this._padFire) this.firing = false;
      this._padFire = pad.buttons[5].pressed;
      this._padPrev = pad.buttons.map((b) => b.pressed);
    }

    c.pitch = clamp(pitch, -1, 1);
    c.yaw = clamp(yaw, -1, 1);
    c.roll = clamp(roll, -1, 1);
    c.strafeX = clamp(strafeX, -1, 1);
    c.strafeY = clamp(strafeY, -1, 1);
    c.throttle = this.throttle;
    c.boost = boost;
  }
}
