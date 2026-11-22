const KEY = 'starwake.settings.v1';

/** 設定項目の定義。メニューはこの一覧から自動で作られる。 */
export const SETTING_DEFS = [
  { key: 'mouseSensitivity', label: 'マウス感度', type: 'range', min: 0.3, max: 3, step: 0.1, def: 1,
    format: (v) => `×${v.toFixed(1)}` },
  { key: 'invertY', label: 'マウス上下反転', type: 'bool', def: false,
    hint: 'OFF: 手前に引くと機首上げ ／ ON: 奥へ押すと機首上げ' },
  { key: 'lookSensitivity', label: '見回し感度', type: 'range', min: 0.3, max: 3, step: 0.1, def: 1,
    format: (v) => `×${v.toFixed(1)}` },
  { key: 'fov', label: '画角', type: 'range', min: 55, max: 100, step: 1, def: 72,
    format: (v) => `${v.toFixed(0)}°` },
  { key: 'chaseDistance', label: '追従カメラの距離', type: 'range', min: 0.6, max: 2.5, step: 0.1, def: 1,
    format: (v) => `×${v.toFixed(1)}` },
  { key: 'cameraSway', label: '追従カメラの揺れ', type: 'range', min: 0, max: 1, step: 0.05, def: 0.4,
    format: (v) => `${Math.round(v * 100)}%`,
    hint: '加速や旋回でカメラが遅れて振れる大きさ。0 で機体にぴったり付いてくる' },
  { key: 'enemies', label: '敵の出現', type: 'bool', def: true,
    hint: 'OFF にすると敵が現れず、自由に飛べる' },
  { key: 'volume', label: '音量', type: 'range', min: 0, max: 1, step: 0.05, def: 0.6,
    format: (v) => `${Math.round(v * 100)}%` },
  { key: 'planetScale', label: '惑星の大きさ', type: 'select', def: 'game',
    options: [{ value: 'game', label: 'ゲーム用 (約 1/16)' }, { value: 'real', label: '実寸' }],
    hint: 'ゲーム用は惑星と衛星を約 1/16 に縮めてある。実寸は本物の大きさ・衛星までの距離・自転。変えると、メニューを閉じたときに出発地からやり直す' },
];

/** 設定値。ブラウザの localStorage に保存され、次回も引き継がれる。 */
export class Settings {
  constructor() {
    this.reset(false);
    try {
      const saved = JSON.parse(localStorage.getItem(KEY) || '{}');
      for (const d of SETTING_DEFS) {
        if (typeof saved[d.key] !== typeof d.def) continue;
        if (d.options && !d.options.some((o) => o.value === saved[d.key])) continue; // 今はない選択肢
        this[d.key] = saved[d.key];
      }
    } catch {
      // 保存領域が使えない環境では既定値のまま動かす
    }
  }

  set(key, value) {
    this[key] = value;
    this.save();
  }

  reset(save = true) {
    for (const d of SETTING_DEFS) this[d.key] = d.def;
    if (save) this.save();
  }

  save() {
    try {
      const out = {};
      for (const d of SETTING_DEFS) out[d.key] = this[d.key];
      localStorage.setItem(KEY, JSON.stringify(out));
    } catch {
      // 保存できなくても動作は続ける
    }
  }
}
