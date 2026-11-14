import { mulberry32 } from '../math/random.js';

// 銀河: どこまでも続く、毎回同じ宇宙。three.js には依存しない (テストしやすくするため)。
//
// 空間を一辺 SECTOR 光年の区画に分け、区画の番号から乱数の種を作って恒星を置く。
// 同じ区画からは必ず同じ恒星ができるので、保存しなくても宇宙は変わらない。

export const LY = 9.4607e15; // 1光年 (m)
export const AU = 1.496e11; // 1天文単位 (m)
export const LIGHT_SECOND = 2.998e8; // 1光秒 (m)
export const SECTOR = 10; // 区画の一辺 (光年)
export const MIN_SPACING = 1.5; // 恒星どうしの最小間隔 (光年)
const MARGIN = MIN_SPACING / 2; // 区画の端からこの距離には置かない (隣の区画の星と近づきすぎないように)
export const SUN_RADIUS = 6.96e8; // m

/** 恒星の種類。weight は出現率、lum は明るさ (太陽 = 1 を基準にした見た目用の値)。 */
export const STAR_CLASSES = [
  { cls: 'M', label: '赤色矮星', weight: 0.42, color: [1.0, 0.6, 0.4], radius: 0.45, lum: 0.6 },
  { cls: 'K', label: '橙色矮星', weight: 0.25, color: [1.0, 0.8, 0.58], radius: 0.75, lum: 0.8 },
  { cls: 'G', label: '黄色矮星', weight: 0.16, color: [1.0, 0.96, 0.86], radius: 1.0, lum: 1.0 },
  { cls: 'F', label: '黄白色星', weight: 0.09, color: [0.96, 0.97, 1.0], radius: 1.3, lum: 1.2 },
  { cls: 'A', label: '白色星', weight: 0.06, color: [0.8, 0.87, 1.0], radius: 1.8, lum: 1.45 },
  { cls: 'B', label: '青白色巨星', weight: 0.02, color: [0.66, 0.76, 1.0], radius: 3.2, lum: 1.8 },
];

const SYL_A = ['ve', 'ka', 'so', 'ar', 'ty', 'el', 'no', 'ri', 'ha', 'zu', 'mi', 'ce', 'do', 'ly', 'pa', 'qu', 'or', 'ta', 'is', 'um'];
const SYL_B = ['lar', 'den', 'mis', 'thos', 'ran', 'vik', 'nor', 'ria', 'kon', 'sae', 'bel', 'tur', 'nys', 'gan', 'rex', 'lia', 'mon', 'dra', 'phi', 'zen'];

/** 区画番号から乱数の種を作る。 */
export function sectorSeed(ix, iy, iz, salt = 0) {
  let h = Math.imul(ix | 0, 73856093) ^ Math.imul(iy | 0, 19349663) ^ Math.imul(iz | 0, 83492791) ^ Math.imul(salt + 1, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

function makeName(rand) {
  let s = SYL_A[Math.floor(rand() * SYL_A.length)] + SYL_B[Math.floor(rand() * SYL_B.length)];
  if (rand() < 0.3) s += SYL_A[Math.floor(rand() * SYL_A.length)];
  return s.toUpperCase();
}

function pickClass(r) {
  let acc = 0;
  for (const c of STAR_CLASSES) {
    acc += c.weight;
    if (r < acc) return c;
  }
  return STAR_CLASSES[0];
}

/** 出発地の恒星。配置は手で決めてある。 */
export const HOME_STAR = {
  id: '0,0,0,0', sector: [0, 0, 0], index: 0, pos: [5, 5, 5], seed: 2024, home: true,
  name: 'HELIA', cls: 'G', label: '黄色矮星', color: [1.0, 0.96, 0.86], radius: SUN_RADIUS, lum: 1,
};

const cache = new Map();

/**
 * 区画 (ix, iy, iz) にある恒星の一覧。
 * 恒星 = { id, sector, index, pos: [x,y,z] (銀河座標, 光年), seed, name, cls, label, color, radius (m), lum }
 */
export function sectorStars(ix, iy, iz) {
  const key = `${ix},${iy},${iz}`;
  let stars = cache.get(key);
  if (stars) return stars;

  const rand = mulberry32(sectorSeed(ix, iy, iz));
  stars = [];
  const isHome = ix === 0 && iy === 0 && iz === 0;
  if (isHome) stars.push(HOME_STAR);
  const r = rand();
  const count = r < 0.25 ? 0 : r < 0.65 ? 1 : r < 0.9 ? 2 : 3;
  for (let n = 0; n < count; n++) {
    let pos = null;
    // 他の星と近すぎない場所が見つかるまで試す (見つからなければその星は置かない)
    for (let tries = 0; tries < 8 && !pos; tries++) {
      const p = [
        (ix + (MARGIN + rand() * (SECTOR - 2 * MARGIN)) / SECTOR) * SECTOR,
        (iy + (MARGIN + rand() * (SECTOR - 2 * MARGIN)) / SECTOR) * SECTOR,
        (iz + (MARGIN + rand() * (SECTOR - 2 * MARGIN)) / SECTOR) * SECTOR,
      ];
      if (stars.every((s) => Math.hypot(s.pos[0] - p[0], s.pos[1] - p[1], s.pos[2] - p[2]) >= MIN_SPACING)) pos = p;
    }
    const c = pickClass(rand());
    const seed = Math.floor(rand() * 4294967296) >>> 0;
    const name = makeName(rand);
    const size = 0.85 + rand() * 0.3;
    if (!pos) continue;
    const index = stars.length;
    stars.push({
      id: `${key},${index}`, sector: [ix, iy, iz], index, pos, seed, name,
      cls: c.cls, label: c.label, color: c.color, radius: c.radius * size * SUN_RADIUS, lum: c.lum,
    });
  }
  if (cache.size > 4000) cache.clear(); // 遠くまで飛び続けてもメモリが増え続けないように
  cache.set(key, stars);
  return stars;
}

/**
 * 銀河座標 pos (光年) から radius 光年以内の恒星を、近い順に返す。
 * @returns [{ star, dist (光年) }]
 */
export function starsNear(pos, radius) {
  const out = [];
  const x0 = Math.floor((pos[0] - radius) / SECTOR), x1 = Math.floor((pos[0] + radius) / SECTOR);
  const y0 = Math.floor((pos[1] - radius) / SECTOR), y1 = Math.floor((pos[1] + radius) / SECTOR);
  const z0 = Math.floor((pos[2] - radius) / SECTOR), z1 = Math.floor((pos[2] + radius) / SECTOR);
  for (let ix = x0; ix <= x1; ix++) {
    for (let iy = y0; iy <= y1; iy++) {
      for (let iz = z0; iz <= z1; iz++) {
        for (const star of sectorStars(ix, iy, iz)) {
          const dist = Math.hypot(star.pos[0] - pos[0], star.pos[1] - pos[1], star.pos[2] - pos[2]);
          if (dist <= radius) out.push({ star, dist });
        }
      }
    }
  }
  return out.sort((a, b) => a.dist - b.dist);
}

/** いちばん近い恒星。近くに1つもなければ、見つかるまで範囲を広げる。 */
export function nearestStar(pos) {
  for (let radius = 8; radius <= 512; radius *= 2) {
    const list = starsNear(pos, radius);
    if (list.length) return list[0];
  }
  return null;
}

/** id (区画番号と通し番号) から恒星を引く。 */
export function starById(id) {
  const [ix, iy, iz, n] = id.split(',').map(Number);
  return sectorStars(ix, iy, iz)[n] || null;
}
