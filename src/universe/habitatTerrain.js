import { Perlin } from '../terrain/noise.js';

// オニール・シリンダーの中の地形。three.js には依存しない (当たり判定と描画の両方から使う)。
//
// 中の位置は (θ, y) で表す。θ は軸まわりの角度 (three.js の CylinderGeometry と同じく +Z から +X へ測る。
// 向き = (sin θ, 0, cos θ))、y は軸方向の位置。地面は軸から R − ground(θ, y) の所にある。
//
// 陸の帯は θ = 0°, 120°, 240° を中心とする幅 60° の帯。その間の帯は窓 (平らなガラス, ground = 0)。
// 陸の帯の中の位置は a ∈ [-1, 1] (帯の中心からの角度 ÷ 30°) で表す。
//
// 陸の帯には次のものがある:
//   丘     ゆるやかな起伏 (±40 m ほど)
//   川     帯に沿って蛇行する。谷底は水面 (標高 0) より低い
//   湖     ところどころのくぼみ
//   町     1.5 km 四方の区画の一部を、平らに造成した町にする (家が建つ)
//   段々畑 両端の蓋に近づくと、帯の中央が段々畑の山になって蓋の壁につながる (高さ 1,100 m)
//   土手   窓との境は少し盛り上がる
// 標高 0 より低い所は水 (湖と川)。水面は平らで、着陸もできる。

const HALF = Math.PI / 6; // 陸の帯の半分の幅 (rad)
const STRIP = (2 * Math.PI) / 3; // 陸の帯の間隔 (rad)
export const TOWN_CELL = 1500; // 町の区画の大きさ (m)
export const CAP_MOUNTAIN = 1100; // 蓋の前の段々畑の山の高さ (m)
const TERRACE = 110; // 段々畑の1段の高さ (m)
/**
 * 宇宙港: 陸の帯 0 の中央、影の側 (入港口のある側) の蓋から fromEnd (m) の所にある、平らな円形の着陸パッド。
 * radius: パッドの半径、apron: まわりのなだらかな造成の幅、height: 標高 (m)
 */
export const SPACEPORT = { fromEnd: 4200, radius: 320, apron: 180, height: 8 };

const sat = (x) => Math.min(1, Math.max(0, x));
const smooth = (a, b, x) => {
  const t = sat((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};
const lerp = (a, b, t) => a + (b - a) * t;

function hash2(i, j, salt) {
  let h = Math.imul(i | 0, 0x27d4eb2d) ^ Math.imul(j | 0, 0x165667b1) ^ Math.imul(salt | 0, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** 角度 θ を、いちばん近い陸の帯 k (0..2) と、帯の中の位置 a (|a| ≦ 1 なら陸、それより外は窓) にする。 */
export function stripAt(theta) {
  const k = ((Math.round(theta / STRIP) % 3) + 3) % 3;
  let d = theta - k * STRIP;
  d -= Math.round(d / (2 * Math.PI)) * 2 * Math.PI;
  return { k, a: d / HALF };
}

/** 陸の帯 k の中の位置 a の角度 θ。 */
export function stripTheta(k, a) {
  return k * STRIP + a * HALF;
}

/**
 * 地形を作る。
 * @param def 円筒の定義 (radius, length, seed)
 */
export function makeInteriorTerrain(def) {
  const R = def.radius, H = def.length / 2;
  const n = new Perlin(def.seed >>> 0);
  const salt = def.seed | 0;

  function fbm(x, y, z, oct) {
    let a = 1, s = 0;
    for (let i = 0; i < oct; i++) {
      s += a * n.noise(x, y, z);
      x *= 2.03; y *= 2.03; z *= 2.03;
      a *= 0.5;
    }
    return s;
  }

  /** 川の中心の、帯の中の位置 a (y によって蛇行する)。 */
  function riverA(k, y) {
    return 0.32 * Math.sin(y / 2300 + k * 2.1) + 0.14 * Math.sin(y / 870 + k * 4.3);
  }

  /**
   * 町の区画の中か (0..1)。町の区画は 1.5 km 四方で、両端の山と川からは離す。
   * s: 帯の中の周方向の位置 (m, 帯の中心が 0)。区画は帯ごとに決める (帯 k を乱数に混ぜる)
   */
  function townAt(k, a, s, y) {
    const i = Math.floor(s / TOWN_CELL), j = Math.floor(y / TOWN_CELL);
    if (hash2(i + 1000 * k, j, salt) > 0.16) return 0;
    if (Math.abs(y) > H - 3200 || Math.abs(a) > 0.78) return 0;
    if (Math.abs(a - riverA(k, y)) * HALF * R < 220) return 0;
    // 区画の縁は道 (少し狭める)
    const u = s / TOWN_CELL - i, v = y / TOWN_CELL - j;
    return smooth(0.02, 0.1, Math.min(u, 1 - u)) * smooth(0.02, 0.1, Math.min(v, 1 - v));
  }

  /** 段々畑の段 (0..1 の傾きを、平らな棚と急な崖のくり返しにする)。 */
  function terrace(h) {
    const q = h / TERRACE;
    const i = Math.floor(q), f = q - i;
    return (i + smooth(0.0, 0.25, f)) * TERRACE;
  }

  /**
   * 地面の高さの内訳。height() と色・木・家の置き方で共通に使う。
   * @returns { land, a, k, h (標高, 水の所は負), town, river, mountain, forest }
   */
  function sample(theta, y) {
    const { k, a } = stripAt(theta);
    const out = { land: false, a, k, s: 0, h: 0, town: 0, river: 0, mountain: 0, forest: 0, pad: 0 };
    if (Math.abs(a) > 1 || Math.abs(y) > H) return out; // 窓 (または蓋の外)
    out.land = true;
    // 帯の中の周方向の位置 (m, 帯の中心が 0)。θ の測り方 (負か 0〜2π か) によらず同じ値になる
    const s = a * HALF * R;
    out.s = s;
    // ノイズは円筒の表面の3次元の位置で引く (θ = 0 と 2π の継ぎ目が出ない)
    const px = Math.sin(theta) * R, pz = Math.cos(theta) * R;

    // 丘と細かい起伏
    let h = fbm(px / 2200 + 3.1, y / 2200, pz / 2200 - 7.7, 4) * 38 + 14;
    h += fbm(px / 380, y / 380 + 11.3, pz / 380, 3) * 6;
    // 湖: ところどころのくぼみ
    const lake = fbm(px / 1500 - 5.3, y / 1500 + 2.2, pz / 1500 + 9.1, 2);
    h -= smooth(0.25, 0.55, lake) * 55;
    // 川: 谷を刻み、谷底は水面より低い
    const dr = Math.abs(a - riverA(k, y)) * HALF * R; // 川の中心からの距離 (m)
    out.river = 1 - smooth(25, 45, dr);
    const valley = 1 - smooth(30, 260, dr);
    h = lerp(h, Math.min(h, 2), valley * 0.85);
    h = Math.min(h, lerp(h, -6, out.river));
    // 町: 平らに造成する
    out.town = townAt(k, a, s, y);
    h = lerp(h, 6, out.town);
    // 両端の段々畑の山: 帯の中央ほど高い
    const end = smooth(H - 2600, H - 150, Math.abs(y));
    const ridge = smooth(0.95, 0.45, Math.abs(a));
    out.mountain = end * ridge;
    if (out.mountain > 0) h = Math.max(h, terrace(out.mountain * CAP_MOUNTAIN) + 4);
    // 宇宙港: パッドのまわりを平らに造成する (町・森・川より優先)
    if (k === 0) {
      const d = Math.hypot(s, y - (-H + SPACEPORT.fromEnd));
      const flat = 1 - smooth(SPACEPORT.radius, SPACEPORT.radius + SPACEPORT.apron, d);
      if (flat > 0) {
        h = lerp(h, SPACEPORT.height, flat);
        out.town *= 1 - flat;
        out.pad = 1 - smooth(SPACEPORT.radius - 4, SPACEPORT.radius, d);
      }
    }
    // 窓との境: 帯の縁で標高を 0 に落とし、少し盛り上げて土手にする
    const edge = smooth(1.0, 0.9, Math.abs(a));
    h = h * edge + 5 * smooth(0.86, 0.95, Math.abs(a)) * smooth(1.0, 0.97, Math.abs(a));
    out.h = h;
    // 森: 丘の上の、町でも川でもない所
    const f = fbm(px / 900 + 21.7, y / 900 - 4.4, pz / 900, 3);
    out.forest = smooth(0.05, 0.3, f) * (1 - out.town) * smooth(6, 14, h) * (1 - smooth(0.2, 0.6, out.mountain));
    if (k === 0) out.forest *= smooth(SPACEPORT.radius + SPACEPORT.apron, SPACEPORT.radius + SPACEPORT.apron + 100,
      Math.hypot(s, y - (-H + SPACEPORT.fromEnd))); // 宇宙港のまわりには木を生やさない
    return out;
  }

  /** 地面 (水面を含む) の標高 (m, 0 以上)。地面は軸から R − ground の所にある。 */
  function ground(theta, y) {
    return Math.max(0, sample(theta, y).h);
  }

  /**
   * 地表の色 [r, g, b] と面の種類 (0 = 地面, 0.5 = 町, 1 = 水) を out に入れる。slope: 1 = 水平
   * @param s sample(theta, y) の結果 (すでに求めてあれば渡す)
   */
  function color(out, theta, y, slope, s = sample(theta, y)) {
    if (!s.land) { // 窓 (描画では使わない)
      out[0] = out[1] = out[2] = 0.1; out[3] = 0;
      return out;
    }
    if (s.h <= 0) { // 湖と川
      const d = sat(-s.h / 30);
      out[0] = lerp(0.06, 0.02, d); out[1] = lerp(0.2, 0.08, d); out[2] = lerp(0.22, 0.14, d); out[3] = 1;
      return out;
    }
    // 畑: 240 m の区画ごとに作物の色 (区画は帯ごとに決める)
    const cell = hash2(Math.floor(s.s / 240) + 1000 * s.k, Math.floor(y / 240), salt + 7);
    let r, g, b;
    if (cell < 0.35) { r = 0.13; g = 0.25; b = 0.08; } // 牧草
    else if (cell < 0.6) { r = 0.22; g = 0.3; b = 0.1; } // 若い麦
    else if (cell < 0.78) { r = 0.42; g = 0.38; b = 0.18; } // 実った麦
    else { r = 0.3; g = 0.24; b = 0.14; } // 耕した畑
    // 森
    r = lerp(r, 0.06, s.forest); g = lerp(g, 0.15, s.forest); b = lerp(b, 0.05, s.forest);
    // 川べりと湖畔は砂
    const shore = smooth(4, 0.5, s.h);
    r = lerp(r, 0.5, shore); g = lerp(g, 0.46, shore); b = lerp(b, 0.34, shore);
    // 段々畑: 棚は緑、崖は土
    const steep = smooth(0.9, 0.6, slope);
    if (s.mountain > 0.01) {
      const band = hash2(Math.floor((s.h + 2) / TERRACE), s.k, salt + 3);
      const tr = band < 0.5 ? [0.2, 0.32, 0.12] : [0.34, 0.36, 0.16];
      r = lerp(r, tr[0], s.mountain); g = lerp(g, tr[1], s.mountain); b = lerp(b, tr[2], s.mountain);
    }
    r = lerp(r, 0.36, steep); g = lerp(g, 0.3, steep); b = lerp(b, 0.24, steep);
    // 町: 舗装と屋根
    r = lerp(r, 0.38, s.town); g = lerp(g, 0.37, s.town); b = lerp(b, 0.35, s.town);
    // 宇宙港のパッド: コンクリート (印と誘導灯はシェーダーが描く)
    r = lerp(r, 0.46, s.pad); g = lerp(g, 0.46, s.pad); b = lerp(b, 0.45, s.pad);
    out[0] = r; out[1] = g; out[2] = b;
    out[3] = s.town > 0.5 ? 0.5 : 0;
    return out;
  }

  /** 宇宙港のパッドの中心 (円筒ローカル座標) [x, y, z]。陸の帯 0 の中心 (θ = 0) にある */
  const spaceport = [0, -H + SPACEPORT.fromEnd, R - SPACEPORT.height];

  return { radius: R, length: def.length, seed: def.seed, sample, ground, color, riverA, townAt, spaceport };
}
