// オニール・シリンダー (円筒の宇宙居住地) の定義と、外壁の当たり判定。three.js には依存しない。
// 設計: docs/design-oneill-cylinder.md
//
// 2本1組で置く。2本は平行で、軸は恒星の方を向く。逆向きに回って見えるが、
// 物理の上では止まっている (回っているのは見た目だけ)。
//
// 「円筒ローカル座標」= 円筒の中心が原点、Y 軸 = 円筒の軸 (+Y が恒星の側)、
// X 軸 = 組のもう1本がある向き (2本目では反対向き)。

export const HABITAT = {
  radius: 4000, // m
  length: 32000, // m
  gap: 2.5, // 2本の軸の間隔 (直径の倍数)
  hull: 60, // 外壁の厚さ (m)。当たり判定はこの外側の面で行う
  spinPeriod: 2 * Math.PI * Math.sqrt(4000 / 9.81), // 見た目の回転の周期 (秒)。地面で 1 g になる速さ
  portRadius: 420, // 入港口の筒の内側の半径 (m)
  portLength: 1400, // 入港口の筒の長さ (m)。影の側の蓋から外へ突き出す
  gravity: 9.81, // 地面での重力 (m/s²)
  airDensity: 1.2, // 地面での空気の密度 (kg/m³)
};

const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => {
  const l = Math.hypot(a[0], a[1], a[2]);
  return [a[0] / l, a[1] / l, a[2] / l];
};

/**
 * 天体の位置 position を、恒星のまわりに deg 度回した位置。ラグランジュ点 L4 (+60°) / L5 (−60°) に使う。
 * 回す軸は、position に直交する向きのうち星系の上 (Y) にいちばん近いもの (= 傾いた軌道の面の法線)。
 * 恒星からの距離は変わらず、position との角度はちょうど deg 度になる。
 */
export function lagrangePoint(position, deg) {
  const p = norm(position);
  let n = [-p[1] * p[0], 1 - p[1] * p[1], -p[1] * p[2]]; // Y − (Y·p) p
  if (Math.hypot(...n) < 1e-9) n = [1, 0, 0];
  n = norm(n);
  // ロドリゲスの回転: v cos a + (n × v) sin a  (n と v は直交するので最後の項はない)
  const a = (deg * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
  const nv = cross(n, position);
  return [position[0] * c + nv[0] * s, position[1] * c + nv[1] * s, position[2] * c + nv[2] * s];
}

/**
 * 2本1組の円筒を作る。
 * @param key 識別子の頭 (例 'home:L5')
 * @param names [1本目の名前, 2本目の名前]
 * @param center 組の中心 (星系座標, m)
 * @returns 2本の円筒の定義の配列。
 *   { key, name, position, axis, side, radius, length, hull, spin: ±1, pair: { center, gap } }
 *   axis: 円筒の軸 (恒星の方を向く単位ベクトル)、side: ローカル X 軸 (もう1本の方)
 */
export function makeHabitatPair(key, names, center) {
  const axis = norm([-center[0], -center[1], -center[2]]); // 恒星の方
  // 2本を並べる向き: 軸と恒星系の上 (Y) の両方に直交する向き (= 公転の向き)
  let side = cross(axis, [0, 1, 0]);
  if (Math.hypot(...side) < 1e-6) side = cross(axis, [1, 0, 0]);
  side = norm(side);
  const half = (HABITAT.gap * 2 * HABITAT.radius) / 2;
  return [1, -1].map((k, i) => ({
    key: `${key}:${i}`,
    name: names[i],
    position: [center[0] + side[0] * half * k, center[1] + side[1] * half * k, center[2] + side[2] * half * k],
    axis,
    side: [-side[0] * k, -side[1] * k, -side[2] * k], // もう1本の方
    radius: HABITAT.radius,
    length: HABITAT.length,
    hull: HABITAT.hull,
    spin: k, // 2本は逆向きに回る
    pair: { center, gap: half * 2 },
  }));
}

/**
 * 円筒ローカル座標の点 (x,y,z) と外壁の関係。外壁は、半径 R + hull、長さ L の閉じた円柱として扱う。
 * @returns { inside: 円柱の中にいるか, depth: 外の面までの距離 (中にいるとき正), normal: [x,y,z] 押し出す向き,
 *            distance: 円柱の表面までの距離 (外にいるとき。中では 0) }
 */
export function hullContact(def, x, y, z) {
  const R = def.radius + def.hull, H = def.length / 2;
  const r = Math.hypot(x, z);
  const dr = r - R; // 側面から外へ
  const dy = Math.abs(y) - H; // 蓋から外へ
  if (dr < 0 && dy < 0) {
    // 中: 近い方の面から押し出す
    if (-dr < -dy) {
      const k = r > 1e-9 ? 1 / r : 0;
      return { inside: true, depth: -dr, normal: r > 1e-9 ? [x * k, 0, z * k] : [1, 0, 0], distance: 0 };
    }
    return { inside: true, depth: -dy, normal: [0, Math.sign(y) || 1, 0], distance: 0 };
  }
  const distance = Math.hypot(Math.max(dr, 0), Math.max(dy, 0));
  return { inside: false, depth: 0, normal: null, distance };
}

// ---------------------------------------------------------------- 中 (円筒ローカル座標)
// 中の物理は回らない座標系で計算する (設計書のシンプル版)。重力は軸から外向きに g · r / R。
// 地面は円筒の内側の面 (半径 R)。入港口の筒の中では、筒の壁 (半径 portRadius) が地面になる。

/** 高さ y の所の地面の、軸からの距離 (m)。 */
export function groundRadius(def, y) {
  return y >= -def.length / 2 ? def.radius : HABITAT.portRadius;
}

/** 中の点 (x,y,z) の、地面からの高さ (m)。下は軸から外向き。 */
export function interiorHeight(def, x, y, z) {
  return groundRadius(def, y) - Math.hypot(x, z);
}

/** 中の点での重力加速度 (軸から外向き) の大きさ (m/s²)。 */
export function interiorGravity(def, r) {
  return (HABITAT.gravity * r) / def.radius;
}

/** 中の点での空気の密度 (kg/m³)。地面で airDensity、軸では約 0.79 倍 (気温 288 K の空気が重力で押しつけられる分)。 */
export function interiorAir(def, r) {
  const R = def.radius;
  return HABITAT.airDensity * Math.exp((HABITAT.gravity * (r * r - R * R)) / (2 * R * 287 * 288));
}

/** 入港口の筒の中にいるか (ここで円筒の座標系に入る)。 */
export function inPort(def, x, y, z) {
  const H = def.length / 2;
  return y < -H && y > -H - HABITAT.portLength && Math.hypot(x, z) < HABITAT.portRadius - 20;
}

/** まだ円筒の中か (出るのは、入港口の筒の外の端を抜けたときだけ)。 */
export function inInterior(def, x, y, z) {
  const H = def.length / 2;
  return y > -H - HABITAT.portLength - 30 && y < H + 300 && Math.hypot(x, z) < def.radius + 300;
}

/**
 * 両端の蓋 (中から見た壁) との当たり判定。機体の中心を、蓋から margin (m) 離しておく。
 * 恒星側の蓋は全面が壁。影の側の蓋は入港口の穴の外側だけが壁 (穴の縁と筒の壁は地面として ground.js が受け持つ)。
 * @returns { depth, normal: [0, ±1, 0] } | null
 */
export function capContact(def, x, y, z, margin) {
  const H = def.length / 2;
  if (y > H - margin) return { depth: y - (H - margin), normal: [0, -1, 0] };
  if (y < -H + margin && y > -H - 2 * margin && Math.hypot(x, z) > HABITAT.portRadius + margin) {
    return { depth: -H + margin - y, normal: [0, 1, 0] };
  }
  return null;
}
