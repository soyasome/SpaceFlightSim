import { mulberry32 } from '../math/random.js';

// ダイソン・スウォーム: 恒星を取り巻く無数の集光パネル。three.js には依存しない。
//
// パネルは傾きの違う何本もの「帯」(リング) に並ぶ。帯ごとに半径を少しずつ変えてあるので、
// 帯どうしが交差する所でもパネルはぶつからず、上下にすれ違う。
// 1本の帯は数本の「列」(レーン) からなり、列ごとにパネルが等間隔に並ぶ (隣の列とは半分ずらす)。
// パネルは六角形の板で、表 (太陽電池) を恒星に向けている。裏は排熱板で、鈍く赤く光る。
// 位置はすべて星系座標 (恒星が原点, m)。

/** スウォームのある星系の割合。 */
export const SWARM_CHANCE = 0.12;
/** パネルの半径 (外接円) の、帯の半径に対する比。 */
export const PANEL_SIZE = 0.016;
/** 同じ列で隣り合うパネルの中心の間隔 (パネルの半径の倍数)。 */
const SPACING = 2.2;
/** 帯ごとの半径の違い (帯どうしが交差する所でパネルがぶつからないように)。 */
const RING_STEP = 0.035;
/** パネルの厚さ (パネルの半径に対する比)。 */
export const THICKNESS = 0.004;
/** 当たり判定に使う円の半径 (六角形の内接円より少し小さい。パネルの半径に対する比)。 */
export const HIT_RADIUS = 0.84;

/**
 * 恒星のスウォームの被覆率 (恒星の光をさえぎる割合の目安, 0 = スウォームなし)。
 * 星系を作らずに決まるので、遠くの恒星を描くとき (nearStars) にも使える。
 */
export function swarmCoverage(star) {
  if (star.home) return 0;
  const rand = mulberry32((star.seed ^ 0x2f6b4c1d) >>> 0);
  if (rand() >= SWARM_CHANCE) return 0;
  return 0.3 + 0.45 * rand();
}

/**
 * スウォームの定義を作る。なければ null。
 * @param inner いちばん内側の惑星の軌道半径 (m)。スウォームはその内側に置く
 * @returns { radius, panel, thickness, coverage, count, rings: [{ radius, u, v, w, lanes, perLane, offset }] }
 *   u, v は帯の面内の直交する2方向、w は帯の面の法線 (単位ベクトル)
 */
export function makeSwarm(star, inner) {
  const coverage = swarmCoverage(star);
  if (!coverage) return null;
  const rand = mulberry32((star.seed ^ 0x7a3d91b5) >>> 0);
  const perLane = Math.floor((2 * Math.PI) / (SPACING * PANEL_SIZE));
  // 被覆率 ≒ パネルの総面積 / 球の面積 になるよう、列の総数を決める (半径によらない)
  const hexArea = 2.598 * PANEL_SIZE * PANEL_SIZE;
  const lanesTotal = Math.max(4, Math.round((coverage * 4 * Math.PI) / (hexArea * perLane)));
  const ringCount = Math.min(9, Math.max(3, Math.round(lanesTotal / 6)));
  // いちばん外側の帯 (半径 × RING_STEP 倍ずつ広がる) とパネルが、内側の惑星に届かないようにする
  const spread = 1 + RING_STEP * (ringCount - 1) + PANEL_SIZE;
  const radius = Math.max(star.radius * 25, (inner * (0.5 + 0.2 * rand())) / spread);
  const panel = radius * PANEL_SIZE;
  const rings = [];
  let left = lanesTotal;
  for (let k = 0; k < ringCount; k++) {
    const lanes = Math.max(1, Math.round(left / (ringCount - k)));
    left -= lanes;
    // 帯の面の向き: 最初の帯は恒星の赤道付近、残りはさまざまな傾き
    const tilt = k === 0 ? rand() * 0.15 : 0.25 + rand() * 1.3;
    const node = rand() * Math.PI * 2;
    const w = [Math.sin(tilt) * Math.cos(node), Math.cos(tilt), Math.sin(tilt) * Math.sin(node)];
    // w に直交する u, v
    const a = Math.abs(w[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
    const u = norm(cross(a, w));
    const v = cross(w, u);
    rings.push({ radius: radius * (1 + RING_STEP * k), u, v, w, lanes, perLane, offset: rand() * Math.PI * 2 });
  }
  const count = rings.reduce((s, r) => s + r.lanes * r.perLane, 0);
  return { radius, panel, thickness: panel * THICKNESS, coverage, count, rings, seed: (star.seed ^ 0x5d1c) >>> 0 };
}

const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => {
  const l = Math.hypot(a[0], a[1], a[2]);
  return [a[0] / l, a[1] / l, a[2] / l];
};

/** 列 l の、帯の面からの角度 (rad)。 */
function laneLat(ring, l, panel) {
  return (l - (ring.lanes - 1) / 2) * ((SPACING * 0.87 * panel) / ring.radius);
}

/** 列 l のパネル j の、帯に沿った角度 (rad)。奇数の列は半分ずらす。 */
function laneLon(ring, l, j) {
  return ring.offset + ((j + 0.5 * (l & 1)) * 2 * Math.PI) / ring.perLane;
}

/**
 * パネルを並べる。
 * @returns { pos: Float64Array (中心, 星系座標), tan: Float32Array (帯に沿った向き), present: Uint8Array (1 = ある, 0 = 建設中の空き) }
 */
export function swarmPanels(def) {
  const n = def.count;
  const pos = new Float64Array(n * 3), tan = new Float32Array(n * 3), present = new Uint8Array(n);
  const rand = mulberry32(def.seed);
  let i = 0;
  for (const ring of def.rings) {
    const { u, v, w, radius } = ring;
    for (let l = 0; l < ring.lanes; l++) {
      const lat = laneLat(ring, l, def.panel);
      const cl = Math.cos(lat), sl = Math.sin(lat);
      for (let j = 0; j < ring.perLane; j++, i++) {
        const lon = laneLon(ring, l, j);
        const c = Math.cos(lon), s = Math.sin(lon);
        pos[i * 3] = radius * (cl * (c * u[0] + s * v[0]) + sl * w[0]);
        pos[i * 3 + 1] = radius * (cl * (c * u[1] + s * v[1]) + sl * w[1]);
        pos[i * 3 + 2] = radius * (cl * (c * u[2] + s * v[2]) + sl * w[2]);
        tan[i * 3] = -s * u[0] + c * v[0];
        tan[i * 3 + 1] = -s * u[1] + c * v[1];
        tan[i * 3 + 2] = -s * u[2] + c * v[2];
        // ところどころ抜けている (建設中)。帯の端の列ほど抜けが多い
        const edge = Math.abs(l - (ring.lanes - 1) / 2) / Math.max(1, ring.lanes / 2);
        present[i] = rand() < 0.06 + 0.25 * edge * edge ? 0 : 1;
      }
    }
  }
  return { pos, tan, present };
}

/**
 * 点 (x,y,z) にいちばん近いパネル。帯ごとに、角度から近くの列とパネルを数個に絞って調べる。
 * @returns { index, normal: パネルの面からの距離 (符号付き, 恒星の側が正), lateral: 面に沿った中心からの距離,
 *            surface: パネルの表面までのおおよその距離 } | null
 */
export function nearestPanel(def, panels, x, y, z) {
  const r = Math.hypot(x, y, z);
  if (r < 1) return null;
  let best = null, bestD = Infinity;
  let base = 0;
  for (const ring of def.rings) {
    const { u, v, w } = ring;
    const pu = x * u[0] + y * u[1] + z * u[2];
    const pv = x * v[0] + y * v[1] + z * v[2];
    const pw = x * w[0] + y * w[1] + z * w[2];
    const lon = Math.atan2(pv, pu);
    const lat = Math.asin(Math.max(-1, Math.min(1, pw / r)));
    const dLat = (SPACING * 0.87 * def.panel) / ring.radius;
    const l0 = Math.round(lat / dLat + (ring.lanes - 1) / 2);
    for (let l = Math.max(0, l0 - 1); l <= Math.min(ring.lanes - 1, l0 + 1); l++) {
      const jf = ((lon - ring.offset) * ring.perLane) / (2 * Math.PI) - 0.5 * (l & 1);
      const j0 = Math.round(jf);
      for (let dj = -1; dj <= 1; dj++) {
        const j = (((j0 + dj) % ring.perLane) + ring.perLane) % ring.perLane;
        const i = base + l * ring.perLane + j;
        if (!panels.present[i]) continue;
        const cx = panels.pos[i * 3], cy = panels.pos[i * 3 + 1], cz = panels.pos[i * 3 + 2];
        const d = Math.hypot(x - cx, y - cy, z - cz);
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      }
    }
    base += ring.lanes * ring.perLane;
  }
  if (best === null) return null;
  const cx = panels.pos[best * 3], cy = panels.pos[best * 3 + 1], cz = panels.pos[best * 3 + 2];
  const cr = Math.hypot(cx, cy, cz);
  // 法線は恒星の方 (中心から恒星へ)
  const nx = -cx / cr, ny = -cy / cr, nz = -cz / cr;
  const dx = x - cx, dy = y - cy, dz = z - cz;
  const normal = dx * nx + dy * ny + dz * nz;
  const lateral = Math.sqrt(Math.max(0, dx * dx + dy * dy + dz * dz - normal * normal));
  const half = def.thickness / 2;
  const edge = Math.max(0, lateral - def.panel * HIT_RADIUS);
  const surface = Math.hypot(Math.max(0, Math.abs(normal) - half), edge);
  return { index: best, normal, lateral, surface };
}
