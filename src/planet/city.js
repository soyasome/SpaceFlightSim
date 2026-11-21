import { faceDir, dirToFace } from '../terrain/chunkBuilder.js';
import { mulberry32 } from '../math/random.js';

// 都市惑星の街区。three.js には依存しない (当たり判定と描画の両方から使う)。
//
// キューブ球の各面を、一辺 N 個の「敷地」の格子に区切る。敷地のまわりは道路で、
// 敷地ごとにシード付き乱数でビルを1棟建てるかどうかと、その形を決める。
// 同じ敷地からは必ず同じビルができるので、描画 (scatter.js) と当たり判定 (planet.js) が一致する。
// 地表のシェーダーも同じ格子で道路と街灯を描く (atmosphere.js の uLotN)。

export const CITY_CELL = 200; // scatter.js でビルを生成する区画の大きさの目安 (m)
export const LOTS = 4; // 区画の一辺に並ぶ敷地の数
export const STREET = 0.18; // 敷地の幅のうち道路が占める割合 (両側の合計)
export const SINK = 4; // ビルを地面に埋める深さ (m)。坂でも土台が浮かないように
export const TIER = 0.45; // 塔の下の段の高さ (全体に対する割合)
export const UPPER = 0.62; // 塔の上の段の幅 (下の段に対する割合)
export const KIND_BLOCK = 0, KIND_TOWER = 1;

const sat = (x) => Math.min(1, Math.max(0, x));
const smooth = (a, b, x) => {
  const t = sat((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};
const lerp = (a, b, t) => a + (b - a) * t;

// 外壁の色: コンクリート、青いガラス、黒いガラス、砂岩、白
const PALETTE = [
  [0.42, 0.41, 0.39], [0.2, 0.27, 0.34], [0.13, 0.14, 0.16], [0.5, 0.44, 0.34], [0.6, 0.6, 0.58],
];

/** 面の一辺の区画数 n (scatter.js の区画と同じ決め方) と、敷地の数 N = n × LOTS。 */
export function cityGrid(radius) {
  const level = Math.max(0, Math.round(Math.log2((Math.PI / 2) * radius / CITY_CELL)));
  const n = 2 ** level;
  return { n, N: n * LOTS };
}

function lotSeed(seed, face, i, j) {
  let h = Math.imul(seed | 0, 0x9e3779b1) ^ Math.imul(face + 7, 0x85ebca6b);
  h = Math.imul(h ^ i, 0xc2b2ae35) ^ Math.imul(j, 0x27d4eb2d);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  return (h ^ (h >>> 13)) >>> 0;
}

const _d = [0, 0, 0], _f = [0, 0, 0];
const plans = new WeakMap();

/** 地形ごとに1つの街区の計画を返す (作ったものは使い回す)。 */
export function cityPlan(terrain) {
  let plan = plans.get(terrain);
  if (!plan) plans.set(terrain, (plan = new CityPlan(terrain)));
  return plan;
}

export class CityPlan {
  constructor(terrain) {
    this.terrain = terrain;
    const { n, N } = cityGrid(terrain.radius);
    this.n = n;
    this.N = N;
    this.cache = new Map();
  }

  /**
   * 敷地 (face, i, j) のビル。なければ null。
   * { ground: 敷地の中心の標高 (m), height: 地面からの高さ (m), cs, ct: 敷地の中での中心 (0..1),
   *   fw, fd: 敷地の幅に対する s 方向・t 方向の大きさ (0..1), kind, color: [r,g,b] }
   */
  lot(face, i, j) {
    const key = (face * this.N + i) * this.N + j;
    let b = this.cache.get(key);
    if (b !== undefined) return b;
    b = this._build(face, i, j);
    if (this.cache.size > 50000) this.cache.clear();
    this.cache.set(key, b);
    return b;
  }

  _build(face, i, j) {
    const T = this.terrain, N = this.N;
    const rand = mulberry32(lotSeed(T.seed, face, i, j));
    // 乱数は採否にかかわらず同じ数だけ引く
    const pick = rand(), a = rand(), b = rand(), c = rand(), e = rand(), f = rand(), g = rand(), col = rand(), k = rand();
    faceDir(face, (i + 0.5) / N, (j + 0.5) / N, _d);
    const ground = T.height(_d[0], _d[1], _d[2], 4);
    if (ground <= 2) return null;
    const u = T.urban(ground, _d[0], _d[1], _d[2]);
    if (pick > u * 1.2 - 0.1) return null; // 公園と空き地
    const room = 1 - STREET;
    const fw = room * (0.62 + 0.38 * a), fd = room * (0.62 + 0.38 * b);
    // 都心ほど高い。ところどころに飛び抜けた超高層ビル
    const core = smooth(0.5, 0.95, u);
    const low = 7 + 26 * e * e;
    const tall = 45 + 260 * f * f + (g < 0.06 ? 350 * g / 0.06 : 0);
    const height = lerp(low, tall, core * (g < 0.75 ? 1 : 0.25));
    const kind = height > 90 ? KIND_TOWER : KIND_BLOCK;
    const base = kind === KIND_TOWER ? (col < 0.7 ? 1 + Math.floor(col / 0.35) : 4) : Math.floor(col * PALETTE.length);
    const shade = 0.85 + 0.3 * k;
    return {
      ground, height, kind, fw, fd,
      cs: 0.5 + (room - fw) * (c - 0.5), ct: 0.5 + (room - fd) * (k - 0.5),
      color: PALETTE[base].map((v) => v * shade),
    };
  }

  /** 単位ベクトル (x,y,z) の方向にあるビルの屋上の標高 (m)。ビルがなければ -Infinity。 */
  roofAt(x, y, z) {
    const N = this.N;
    dirToFace(x, y, z, _f);
    const ps = _f[1] * N, pt = _f[2] * N;
    const i = Math.min(N - 1, Math.floor(ps)), j = Math.min(N - 1, Math.floor(pt));
    const b = this.lot(_f[0], i, j);
    if (!b) return -Infinity;
    const ds = Math.abs(ps - i - b.cs), dt = Math.abs(pt - j - b.ct);
    if (ds > b.fw / 2 || dt > b.fd / 2) return -Infinity;
    if (b.kind === KIND_TOWER && (ds > (b.fw * UPPER) / 2 || dt > (b.fd * UPPER) / 2)) {
      return b.ground + b.height * TIER;
    }
    return b.ground + b.height;
  }
}
