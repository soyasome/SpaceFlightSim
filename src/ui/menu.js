import { SETTING_DEFS } from '../core/settings.js';

/**
 * 操作方法と設定のメニュー。開いている間はゲームを一時停止する。
 * 開く: Tab キー / 右上のボタン / Esc でマウスを解放したとき
 */
export class Menu {
  constructor(game, settings) {
    this.game = game;
    this.settings = settings;
    this.overlay = document.getElementById('overlay');
    this.startBtn = document.getElementById('start');
    this.sub = document.getElementById('menuSub');
    this.isOpen = true;
    this.started = false;
    this.inputs = {};

    this._buildSettings(document.getElementById('settings'));

    this.startBtn.addEventListener('click', () => this.close());
    document.getElementById('menuBtn').addEventListener('click', () => this.toggle());
    document.getElementById('resetSettings').addEventListener('click', () => {
      settings.reset();
      this.refresh();
    });

    game.input.on('menu', () => { if (!this.game.mapOpen) this.toggle(); });
    game.input.on('menuClose', () => { if (this.isOpen && this.started) this.close(); });

    // Esc などでマウスが解放されたらメニューを出す
    document.addEventListener('pointerlockchange', () => {
      if (!document.pointerLockElement && this.started && !this.isOpen && !this.game.mapOpen) this.open();
    });

    game.paused = true;
    game.input.enabled = false;
  }

  _buildSettings(root) {
    for (const d of SETTING_DEFS) {
      const row = document.createElement('label');
      row.className = 'setting';
      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = d.label;
      row.appendChild(name);

      const input = document.createElement(d.type === 'select' ? 'select' : 'input');
      const value = document.createElement('span');
      value.className = 'value';
      if (d.type === 'select') {
        for (const o of d.options) input.appendChild(new Option(o.label, o.value));
        input.addEventListener('change', () => this.settings.set(d.key, input.value));
      } else if (d.type === 'range') {
        input.type = 'range';
        input.min = d.min;
        input.max = d.max;
        input.step = d.step;
        input.addEventListener('input', () => {
          this.settings.set(d.key, parseFloat(input.value));
          value.textContent = d.format(this.settings[d.key]);
        });
      } else {
        input.type = 'checkbox';
        input.addEventListener('change', () => {
          this.settings.set(d.key, input.checked);
          value.textContent = input.checked ? 'ON' : 'OFF';
        });
      }
      row.appendChild(input);
      if (d.type !== 'select') row.appendChild(value); // 選択式は選んだ文字が欄に出るので、値の表示は要らない
      root.appendChild(row);
      if (d.hint) {
        const hint = document.createElement('div');
        hint.className = 'hint';
        hint.textContent = d.hint;
        root.appendChild(hint);
      }
      this.inputs[d.key] = { input, value, def: d };
    }
    this.refresh();
  }

  /** 設定値を画面の部品に反映する。 */
  refresh() {
    for (const { input, value, def } of Object.values(this.inputs)) {
      const v = this.settings[def.key];
      if (def.type === 'select') {
        input.value = v;
      } else if (def.type === 'range') {
        input.value = v;
        value.textContent = def.format(v);
      } else {
        input.checked = v;
        value.textContent = v ? 'ON' : 'OFF';
      }
    }
  }

  toggle() {
    if (this.isOpen) this.close();
    else this.open();
  }

  open() {
    if (this.isOpen) return;
    this.isOpen = true;
    this.refresh(); // I キーなどで変わった値を反映
    this.game.paused = true;
    this.game.input.enabled = false;
    this.game.input.keys.clear();
    this.overlay.classList.remove('hidden');
    if (document.pointerLockElement) document.exitPointerLock();
  }

  close() {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.started = true;
    this.startBtn.textContent = '再開';
    this.sub.textContent = '一時停止中';
    this.game.paused = false;
    this.game.input.enabled = true;
    this.overlay.classList.add('hidden');
    this.game.setScale(this.settings.planetScale); // 惑星の大きさを変えていたら、出発地からやり直す
    this.game.input.lock();
  }
}
