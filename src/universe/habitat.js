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
 *   { key, name, position, axis, side, radius, length, hull, spin: ±1, pair: { center, gap }, seed }
 *   axis: 円筒の軸 (恒星の方を向く単位ベクトル)、side: ローカル X 軸 (もう1本の方)
 */
/** 文字列から乱数の種を作る (円筒ごとの地形に使う)。 */
function seedOf(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return h >>> 0;
}

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
    seed: seedOf(`${key}:${i}`), // 中の地形
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

/**
 * 中の点 (x,y,z) の真下の地面の、軸からの距離 (m)。
 * @param terrain 中の地形 (habitatTerrain.js の makeInteriorTerrain)。省くと平らな地面
 */
export function groundRadius(def, x, y, z, terrain = null) {
  if (y < -def.length / 2) return HABITAT.portRadius; // 入港口の筒の中は筒の壁
  if (!terrain) return def.radius;
  return def.radius - terrain.ground(Math.atan2(x, z), y);
}

/** 中の点 (x,y,z) の、地面からの高さ (m)。下は軸から外向き。 */
export function interiorHeight(def, x, y, z, terrain = null) {
  return groundRadius(def, x, y, z, terrain) - Math.hypot(x, z);
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

// ---------------------------------------------------------------- 外の部品 (描画と当たり判定で共通の寸法)

/**
 * 鏡: 窓の帯の外。影の側の端 (y = -H) に蝶番があり、恒星の方へ開く。
 * offset: 外壁 (半径 R + hull) からの距離、widthK: 窓の帯の幅に対する鏡の幅、thickness: 当たり判定の厚さ
 */
export const MIRROR = { angle: (30 * Math.PI) / 180, offset: 60, widthK: 1.05, thickness: 40 };

/**
 * 鏡 k (0..2) の、円筒ローカル座標での形 (見た目の回転 spinAngle と、開き open (rad) のとき)。
 * @returns { hinge: [x,y,z] 蝶番の中心, along: 長さの向き, across: 幅の向き, normal: 面の法線 (外向き), length, width }
 */
export function mirrorFrame(def, k, spinAngle, open) {
  const Rh = def.radius + def.hull, H = def.length / 2;
  const a = k * ((2 * Math.PI) / 3) + Math.PI / 3 + spinAngle; // 窓の帯の中心の向き
  const out = [Math.sin(a), 0, Math.cos(a)];
  const across = [Math.cos(a), 0, -Math.sin(a)];
  const c = Math.cos(open), s = Math.sin(open);
  return {
    hinge: [out[0] * (Rh + MIRROR.offset), -H, out[2] * (Rh + MIRROR.offset)],
    along: [out[0] * s, c, out[2] * s], // 上 (恒星側) の端ほど外へ倒れる
    across,
    normal: [out[0] * c, -s, out[2] * c],
    length: def.length,
    width: 2 * Rh * Math.sin(Math.PI / 6) * MIRROR.widthK,
  };
}

/**
 * 2本をつなぐ骨組み (組の1本目だけが持つ。もう1本はローカル X の +gap にある)。
 * 箱 { center: [x,y,z], size: [sx,sy,sz], round: 円柱として描くか } の配列 (円筒ローカル座標)。
 */
export function trussParts(def) {
  if (def.spin < 0) return [];
  const H = def.length / 2, gap = def.pair.gap, PR = HABITAT.portRadius;
  const parts = [];
  // 恒星側: 蓋の外の軸受けから骨組みへ
  const yy = H + 2600;
  parts.push({ center: [gap / 2, yy, 0], size: [gap, 260, 260] });
  for (const x of [0, gap]) parts.push({ center: [x, H + (yy - H) / 2, 0], size: [320, yy - H, 320], round: true });
  // 影の側: 入港口をふさがないよう、筒の脇を通す
  const z = PR + 400;
  parts.push({ center: [gap / 2, -H - 1000, z], size: [gap, 260, 260] });
  for (const x of [0, gap]) parts.push({ center: [x, -H - 1000, (z + PR + 100) / 2], size: [200, 260, z - PR - 100] });
  return parts;
}

/**
 * 外の点 (円筒ローカル座標) と、外壁・鏡・骨組み・入港口の筒の当たり判定。
 * 機体を margin (m) の大きさの球として扱う。
 * @param spinAngle 見た目の回転の角度、open 鏡の開き
 * @returns { depth, normal: [x,y,z] (押し出す向き), what } | null
 */
export function exteriorContact(def, spinAngle, open, x, y, z, margin = 6) {
  // 外壁 (閉じた円柱)
  const hc = hullContact(def, x, y, z);
  if (hc.inside) return { depth: hc.depth + margin, normal: hc.normal, what: '外壁' };
  if (hc.distance < margin) {
    // 表面のすぐ外: 近い方の面から押し出す
    const R = def.radius + def.hull, H = def.length / 2, r = Math.hypot(x, z);
    if (Math.abs(y) <= H && r > 1e-9) return { depth: margin - hc.distance, normal: [x / r, 0, z / r], what: '外壁' };
    if (r <= R) return { depth: margin - hc.distance, normal: [0, Math.sign(y), 0], what: '外壁' };
  }
  // 入港口の筒の殻 (内側の半径 PR、外側の半径 PR + 100、蓋から portLength)
  const H = def.length / 2, PR = HABITAT.portRadius, PL = HABITAT.portLength;
  const r = Math.hypot(x, z);
  if (y < -H && y > -H - PL - margin && r > PR - margin && r < PR + 100 + margin) {
    const cands = [
      { depth: r - (PR - margin), normal: r > 1e-9 ? [-x / r, 0, -z / r] : [1, 0, 0] }, // 筒の中へ
      { depth: PR + 100 + margin - r, normal: r > 1e-9 ? [x / r, 0, z / r] : [1, 0, 0] }, // 筒の外へ
      { depth: y - (-H - PL - margin), normal: [0, -1, 0] }, // 筒の口の前へ
    ];
    cands.sort((p, q) => p.depth - q.depth);
    return { ...cands[0], what: '入港口' };
  }
  // 鏡 (厚さのある板)
  for (let k = 0; k < 3; k++) {
    const m = mirrorFrame(def, k, spinAngle, open);
    const dx = x - m.hinge[0], dy = y - m.hinge[1], dz = z - m.hinge[2];
    const along = dx * m.along[0] + dy * m.along[1] + dz * m.along[2];
    const across = dx * m.across[0] + dy * m.across[1] + dz * m.across[2];
    const dist = dx * m.normal[0] + dy * m.normal[1] + dz * m.normal[2];
    const half = MIRROR.thickness / 2 + margin;
    if (along > -margin && along < m.length + margin && Math.abs(across) < m.width / 2 + margin && Math.abs(dist) < half) {
      const side = dist >= 0 ? 1 : -1;
      return { depth: half - Math.abs(dist), normal: m.normal.map((v) => v * side), what: '鏡' };
    }
  }
  // 骨組み (箱。円柱の軸受けも箱で近似する)
  for (const p of trussParts(def)) {
    const ex = p.size[0] / 2 + margin, ey = p.size[1] / 2 + margin, ez = p.size[2] / 2 + margin;
    const qx = x - p.center[0], qy = y - p.center[1], qz = z - p.center[2];
    if (Math.abs(qx) < ex && Math.abs(qy) < ey && Math.abs(qz) < ez) {
      const px = ex - Math.abs(qx), py = ey - Math.abs(qy), pz = ez - Math.abs(qz);
      if (px <= py && px <= pz) return { depth: px, normal: [Math.sign(qx) || 1, 0, 0], what: '骨組み' };
      if (py <= pz) return { depth: py, normal: [0, Math.sign(qy) || 1, 0], what: '骨組み' };
      return { depth: pz, normal: [0, 0, Math.sign(qz) || 1], what: '骨組み' };
    }
  }
  return null;
}
