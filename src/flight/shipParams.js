import { Vector3 } from 'three';

/**
 * 機体の調整値。操作感を変えたいときはここだけ触ればよい。
 * 加速度は m/s²、角速度は rad/s、角加速度は rad/s²。
 */
export const FIGHTER = {
  mass: 12000, // kg
  inertia: new Vector3(60000, 90000, 30000), // ピッチ, ヨー, ロール軸まわり

  // 並進
  mainAccel: 45, // 主エンジン
  retroAccel: 30, // 逆噴射
  strafeAccel: 22, // 上下左右スラスター (アシストOFF時)
  boostMultiplier: 2.6,

  // フライトアシストON時の挙動
  assistMaxSpeed: 400, // スロットル100%での目標速度
  assistBoostSpeed: 1100,
  assistReverseSpeed: 120,
  assistStrafeSpeed: 80,
  assistLateralAccel: 150, // 横滑りを打ち消す力。宇宙で進行方向を曲げる速さ (= この値 ÷ 速さ) を決める
  assistLinearGain: 3.0, // 速度誤差 → 加速度 (1/s)
  assistAngularGain: 9.0, // 角速度誤差 → 角加速度 (1/s)

  // 回転 (x: ピッチ, y: ヨー, z: ロール)
  maxAngRate: new Vector3(1.25, 0.7, 2.2),
  maxAngAccel: new Vector3(4.5, 3.0, 7.0),

  // 巡航モード
  cruiseBrakeTime: 0.5, // 巡航中の減速の強さ: 速さ ÷ この秒数 (m/s²) まで出せる
  cruiseExitTime: 2.5, // 巡航をやめてから通常の速度に落ちるまでの時間 (秒)

  // ホバー (VTOL) を大気中で使うときの目標速度
  vtolSpeed: 80,
  vtolBoostSpeed: 200,
  vtolReverseSpeed: 30,
  vtolStrafeSpeed: 30,

  // 空力 (大気中)。失速速度は海面で約 70 m/s
  aero: {
    wingArea: 40, // m²
    cl0: 0, // 迎角0での揚力係数
    clAlpha: 3.5, // 揚力傾斜 (1/rad)
    stallAngle: 0.31, // 失速し始める迎角 (rad, 約18°)
    stallWidth: 0.14, // 失速が完了するまでの幅 (rad)
    plateLift: 0.9, // 失速後の揚力係数の大きさ
    cd0: 0.025, // 最小抗力係数
    // 造波抵抗 (音速付近で抗力が跳ね上がる)。海面での最高速度は約 400 m/s、ブーストで約 730 m/s
    soundSpeed: 340, // 音速 (m/s)
    machCrit: 0.85, // 造波抵抗が出始めるマッハ数
    machPeak: 1.15, // 造波抵抗が最大になるマッハ数
    waveCd: 0.11, // 造波抵抗係数の最大値
    inducedK: 0.12, // 揚力による抗力の増え方
    plateDrag: 1.3, // 失速後の抗力係数の大きさ
    sideCoef: 1.0, // 横滑りを打ち消す力
    gearDrag: 0.03, // 着陸装置の抗力
    pitchStiffness: 18, // 機首を進行方向へ戻す強さ (m³)。小さいほど大きな迎角を引ける (高速での旋回 G の上限が上がる)
    yawStiffness: 30,
    damping: new Vector3(500, 800, 400), // 回転の減衰 (ピッチは旋回の妨げにならないよう弱め)。この組み合わせで高速旋回は約 13G
    maxMomentQ: 3e6, // トルク計算に使う動圧の上限 (数値安定のため)
  },

  // 空力加熱。熱 = sqrt(密度比) × 速度³ ÷ ref。1 を超えると機体が損傷する
  heat: { ref: 3e9, tau: 2.5, damageRate: 12 },
  gearTime: 1.6, // 着陸装置の出し入れにかかる時間 (秒)

  // 耐久
  hullMax: 100,
  shieldMax: 100,
  shieldRegen: 12, // 毎秒の回復量
  shieldDelay: 4, // 被弾してから回復が始まるまで (秒)
  radius: 7, // 当たり判定の球の半径 (m)

  // 武器
  weapons: {
    gunRate: 10, // 毎秒の発射数
    gunSpeed: 1800, // 弾速 (m/s)。機体の速度に上乗せされる
    gunLife: 1.4, // 弾が消えるまでの時間 (秒)。射程 = 弾速 × この時間
    gunDamage: 6,
    gunEnergy: 2.2, // 1発で使うエネルギー
    energyMax: 100,
    energyRegen: 14, // 毎秒の回復量
    gunGimbal: 2, // 機関砲がロック中の敵の見越し点へ自動で向く最大角 (度)。0 で無効
    missiles: 6,
    missileDamage: 70,
    missileCooldown: 1.0, // 次を撃てるまで (秒)
    lockTime: 1.5, // ロックオンにかかる時間 (秒)
    lockRange: 5000, // m
    lockCone: 25, // 機首からこの角度以内に捉え続けるとロックが進む (度)
  },
};

const variant = (over) => ({ ...FIGHTER, ...over, weapons: { ...FIGHTER.weapons, ...(over.weapons || {}) } });

/** 敵: 軽戦闘機。自機と同じ飛び方で、守りが薄い。 */
export const RAIDER = variant({
  name: 'RAIDER',
  hullMax: 60,
  shieldMax: 50,
  weapons: { missiles: 0, gunDamage: 4, gunRate: 6 },
});

/** 敵: 重戦闘機。遅くて曲がりにくいが硬く、ミサイルを撃つ。 */
export const GUNSHIP = variant({
  name: 'GUNSHIP',
  hullMax: 170,
  shieldMax: 120,
  radius: 10,
  mainAccel: 30,
  assistMaxSpeed: 320,
  assistBoostSpeed: 700,
  maxAngRate: new Vector3(0.85, 0.5, 1.4),
  maxAngAccel: new Vector3(3.0, 2.0, 4.5),
  weapons: { missiles: 4, gunDamage: 7, gunRate: 5, missileCooldown: 10, missileDamage: 55 },
});
