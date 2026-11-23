import { Perlin } from './noise.js';
import { makeGasColor } from './gasBands.js';
import { requireMap } from './maps.js';
import { localToGeoRad } from './geo.js';

const sat = (x) => Math.min(1, Math.max(0, x));
/** GLSL の smoothstep と同じ。a > b でも使える (向きが逆になる)。 */
const smooth = (a, b, x) => {
  const t = sat((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};
const lerp = (a, b, t) => a + (b - a) * t;

/** 地形の既定値 (海洋惑星 TERRA)。 */
const DEFAULT_TERRAIN = { type: 'terran', land: 0.05, cAmp: 2800, mAmp: 6500, hAmp: 320, tint: null };

/** クレーターの深さの倍率 (種類ごとの既定値)。大気や水のある天体では風化して浅い。 */
const CRATER_DEFAULT = { rock: 1, ice: 0.3, desert: 0.35, lava: 0.2, terran: 0, city: 0 };

/**
 * 土地被覆の区分 (MODIS の IGBP 区分の番号) ごとの地表の色と木の生えやすさ。本物の地球 (TERRA) の色に使う。
 * 0 (水)・17・255 (分類なし) など表にない番号の陸は、今のノイズで決める色にする。docs/design-earth-moon.md の 3.5
 */
const COVER = {
  1: { color: [0.05, 0.14, 0.05], forest: 1 }, // 常緑針葉樹林
  2: { color: [0.06, 0.2, 0.05], forest: 1 }, // 常緑広葉樹林 (熱帯の森)
  3: { color: [0.08, 0.16, 0.06], forest: 0.9 }, // 落葉針葉樹林
  4: { color: [0.09, 0.22, 0.06], forest: 0.9 }, // 落葉広葉樹林
  5: { color: [0.08, 0.19, 0.06], forest: 0.9 }, // 混交林
  6: { color: [0.25, 0.26, 0.12], forest: 0.25 }, // 密な低木地
  7: { color: [0.45, 0.38, 0.22], forest: 0.05 }, // まばらな低木地
  8: { color: [0.2, 0.26, 0.09], forest: 0.45 }, // 木の多いサバンナ
  9: { color: [0.36, 0.34, 0.15], forest: 0.15 }, // サバンナ
  10: { color: [0.3, 0.33, 0.13], forest: 0.03 }, // 草原
  11: { color: [0.12, 0.2, 0.1], forest: 0.3 }, // 湿地
  12: { color: [0.3, 0.32, 0.14], forest: 0.02 }, // 農地
  13: { color: [0.3, 0.29, 0.27], forest: 0 }, // 都市
  14: { color: [0.22, 0.28, 0.11], forest: 0.3 }, // 農地と自然のまだら
  15: { color: [0.85, 0.88, 0.92], forest: 0 }, // 雪と氷
  16: { color: [0.6, 0.48, 0.3], forest: 0 }, // 裸地・砂漠
};

/**
 * 渓谷と段丘 (メサ) の種類ごとの設定。
 * canyon: 渓谷の網
 *   freq   網目の細かさ (大きいほど渓谷どうしの間隔が狭い)
 *   depth  深さ (m)
 *   floor  谷底の半幅 (m)
 *   wall   壁の水平方向の幅 (m)
 *   steps  壁の段の数。段ごとに「崖 → 平らな棚」をくり返す
 *   riser  段のうち崖が占める割合 (小さいほど崖が切り立つ)
 *   cover  渓谷のある地域の広さ (0..1)
 * mesa: 崖で囲まれた台地の重なり
 *   freq   台地の大きさ (大きいほど小さな台地がたくさん)
 *   tiers  段の数
 *   tier   1段の高さ (m)
 *   edge   崖の水平方向の半幅 (m)
 *   cover  台地のある地域の広さ (0..1)
 */
const CLIFFS = {
  desert: {
    canyon: { freq: 5, depth: 1700, floor: 900, wall: 1800, steps: 4, riser: 0.3, cover: 0.65 },
    mesa: { freq: 7, tiers: 3, tier: 260, edge: 40, cover: 0.55 },
  },
  rock: {
    canyon: { freq: 4, depth: 650, floor: 300, wall: 600, steps: 1, riser: 0.35, cover: 0.4 },
  },
  ice: { // 細く深い割れ目
    canyon: { freq: 6, depth: 1500, floor: 120, wall: 350, steps: 1, riser: 0.4, cover: 0.55 },
  },
  lava: {
    canyon: { freq: 5, depth: 900, floor: 400, wall: 700, steps: 2, riser: 0.3, cover: 0.5 },
    mesa: { freq: 6, tiers: 2, tier: 220, edge: 40, cover: 0.4 },
  },
  terran: { // 陸だけ。高緯度では谷底が海面より下まで削られてフィヨルドになる
    canyon: { freq: 4.5, depth: 900, floor: 250, wall: 1000, steps: 3, riser: 0.3, cover: 0.45 },
  },
};

/**
 * 惑星の地形を表す関数を作る。メインスレッド (接地判定) と Worker (メッシュ生成) の
 * 両方で同じ定義から作るので、見た目と当たり判定が一致する。
 *
 * def = { seed, radius, terrain?, detailScale? }
 *   detailScale  細かい模様の周波数に掛ける倍率 (省くと 1)。実寸の惑星 (半径がゲーム用の 16 倍) では 16 にする。
 *                ノイズは単位球の上で引くので、そのままでは半径に比例して模様が引き伸ばされる。
 *                大陸・山脈の分布・湿り気のような大きな模様は球に合わせて広げ、尾根・丘・細かい起伏・渓谷・台地・
 *                色むら・街は周波数をこの倍率だけ上げて、m 単位の大きさを保つ (docs/design-real-scale.md の3章)
 * terrain = { type, land, cAmp, mAmp, hAmp, tint }
 *   type  'terran' 海洋 | 'desert' 砂漠 | 'ice' 氷 | 'lava' 溶岩 | 'rock' 岩石 (大気なし) | 'city' 都市
 *   land  大きいほど陸 (高地) が増える。標高 0 以下は平らな「低地」になり、
 *         種類によって海・乾いた盆地・氷原・溶岩の海として描かれる
 *   cAmp, mAmp, hAmp  大陸・山脈・丘の高さ (m)
 *   tint  色合い [r, g, b] (掛け算)
 *   craters  クレーターの深さの倍率 (省くと種類ごとの既定値。0 でなし)
 *   canyons, mesas  渓谷・台地の倍率 (省くと 1。0 でなし。設定は種類ごとに CLIFFS)
 *   maps  本物の地形のマップの名前 { height?, cover?, albedo? } (src/terrain/maps.js。先に読み込んでおく)。
 *         height があると、大きな模様 (大陸・山脈の分布) をマップの標高に置き換え、
 *         マップの画素より細かい波長のノイズだけを足す。渓谷と台地は作らない。docs/design-earth-moon.md の 3章
 *   heightScale  マップの標高に掛ける倍率 (省くと 1)
 */
export function makeTerrain(def) {
  if (def.gas) return makeGasTerrain(def);
  const R = def.radius;
  const S = def.detailScale ?? 1; // 細かい模様の周波数の倍率
  const F_VARY = 900 * S; // 地表の色の細かいむら (ゲーム用の大きさで波長 約 450 m)
  const n = new Perlin(def.seed);
  const T = { ...DEFAULT_TERRAIN, ...(def.terrain || {}) };
  const type = T.type;

  // 本物の地形のマップ (docs/design-earth-moon.md の 3.3)
  const MAPS = T.maps || {};
  const hMap = MAPS.height ? requireMap(MAPS.height) : null;
  const coverMap = MAPS.cover ? requireMap(MAPS.cover) : null;
  const albedoMap = MAPS.albedo ? requireMap(MAPS.albedo) : null;
  const heightScale = T.heightScale ?? 1;
  // ノイズを足す波長の上限 (m)。これより長い波長はマップにすでにある
  const CUT = hMap ? 2 * hMap.pixelAngle * R : 0;
  // 基本周波数 f0・周波数の倍率 lac のノイズで、波長 (R / 周波数) が CUT より短くなる最初のオクターブ
  const firstOct = (f0, lac) => (hMap ? Math.max(0, Math.ceil(Math.log(R / (f0 * CUT)) / Math.log(lac))) : 0);

  // 基本周波数 f0 のノイズを、波長 minWL (m) まで重ねるのに必要なオクターブ数。
  // 遠くの粗いメッシュでは細かい凹凸を計算しないので、生成が軽くなる。
  const oct = (f0, minWL, max) =>
    Math.max(1, Math.min(max, Math.floor(Math.log2(R / (f0 * minWL))) + 1));

  // start: これより前のオクターブは足さない (マップのある天体で、マップより粗い波長を省くため)
  function fbm(x, y, z, octaves, start = 0) {
    let a = 1, s = 0;
    for (let i = 0; i < octaves; i++) {
      if (i >= start) s += a * n.noise(x, y, z);
      x *= 2.03; y *= 2.03; z *= 2.03;
      a *= 0.5;
    }
    return s;
  }

  // --- 侵食風のノイズ ---
  // オクターブを重ねるとき、それまでに積もった「斜面の急さ」に応じて細部を弱める。
  // 急斜面はなめらかに、尾根の上と谷底には細部が残り、水に削られたような形になる。
  // 各オクターブの弱め方は、それより粗いオクターブだけで決まるので、
  // 細部を省いた粗いメッシュでも大きな形は変わらない。
  const _nd = [0, 0, 0, 0];
  const EROSION = 0.7; // 大きいほど斜面がなめらかになる
  const SLOPE_DECAY = 0.75; // 細かいオクターブほど「斜面の急さ」への寄与を小さくする

  // 尾根が鋭く立つノイズ (0..1)。山脈に使う。(ux,uy,uz) は鉛直方向 (勾配から鉛直成分を除く)。
  function ridged(x, y, z, octaves, ux, uy, uz, start = 0) {
    // 尾根の線 (n = 0) をまたぐと勾配の向きが反転するので、ベクトルで足すと
    // そこに段差ができる。向きを捨てて、急さの2乗だけを積む。
    let a = 0.5, s = 0, w = 1, steep = 0, sw = 1;
    for (let i = 0; i < octaves; i++) {
      n.noiseD(x, y, z, _nd);
      let v = 1 - Math.abs(_nd[0]);
      v *= v * w;
      w = sat(v * 2);
      if (i >= start) s += (v * a) / (1 + EROSION * steep);
      let gx = _nd[1], gy = _nd[2], gz = _nd[3];
      const r = gx * ux + gy * uy + gz * uz;
      gx -= r * ux; gy -= r * uy; gz -= r * uz;
      steep += (gx * gx + gy * gy + gz * gz) * sw;
      sw *= SLOPE_DECAY;
      x *= 2.07; y *= 2.07; z *= 2.07;
      a *= 0.5;
    }
    return s;
  }

  // 侵食風の fbm。丘陵に使う。
  function fbmEroded(x, y, z, octaves, ux, uy, uz, start = 0) {
    let a = 1, s = 0, sx = 0, sy = 0, sz = 0, sw = 1;
    for (let i = 0; i < octaves; i++) {
      n.noiseD(x, y, z, _nd);
      if (i >= start) s += (a * _nd[0]) / (1 + EROSION * (sx * sx + sy * sy + sz * sz));
      let gx = _nd[1] * sw, gy = _nd[2] * sw, gz = _nd[3] * sw;
      const r = gx * ux + gy * uy + gz * uz;
      gx -= r * ux; gy -= r * uy; gz -= r * uz;
      sx += gx; sy += gy; sz += gz;
      sw *= SLOPE_DECAY;
      x *= 2.03; y *= 2.03; z *= 2.03;
      a *= 0.5;
    }
    return s;
  }

  // --- クレーター ---
  // 空間を格子に区切り、球面の近くにある区画ごとに乱数でクレーターを1つ置く。
  // 区画の大きさを変えて何層も重ねることで、大小さまざまなクレーターになる。
  // 最も大きい層は球に合わせて広げ (実寸では大きな盆地になる)、層を足して最も小さいクレーターの大きさ (m) を保つ。
  const CRATER_LAYERS = 8 + Math.max(0, Math.round(Math.log(S) / Math.log(2.6)));
  const CRATER_F0 = 4; // 最も大きい層の格子の細かさ (区画の一辺 = 半径 / これ)
  const CRATER_STEP = 2.6;
  const craterAmount = T.craters ?? CRATER_DEFAULT[type] ?? 0;
  const craterSalt = Math.imul(def.seed | 0, 0x2545f491);

  function hashCell(ix, iy, iz, salt) {
    let h = Math.imul(ix, 0x27d4eb2d) ^ Math.imul(iy, 0x165667b1) ^ Math.imul(iz, 0x9e3779b1) ^ salt;
    h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
    h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
    return (h ^ (h >>> 16)) >>> 0;
  }

  /** クレーターによる標高の変化 (m)。 */
  function craters(x, y, z, minWL) {
    let sum = 0;
    let F = CRATER_F0;
    for (let l = 0; l < CRATER_LAYERS; l++, F *= CRATER_STEP) {
      const cell = R / F; // 区画の一辺 (m)
      if (cell * 0.3 < minWL) break; // この層の最大のクレーターでもメッシュで表せない
      if (hMap && cell * 0.6 > CUT) continue; // この層の大きなクレーターはマップにすでにある
      const salt = craterSalt + l * 0x632be5ab;
      const px = x * F, py = y * F, pz = z * F;
      const cx = Math.floor(px), cy = Math.floor(py), cz = Math.floor(pz);
      for (let k = -1; k <= 1; k++) {
        for (let j = -1; j <= 1; j++) {
          for (let i = -1; i <= 1; i++) {
            const ix = cx + i, iy = cy + j, iz = cz + k;
            // 球面から遠い区画は調べるまでもない
            const mx = ix + 0.5, my = iy + 0.5, mz = iz + 0.5;
            if (Math.abs(Math.sqrt(mx * mx + my * my + mz * mz) - F) > 1.37) continue;
            const h1 = hashCell(ix, iy, iz, salt);
            if (h1 >>> 24 > 190) continue; // 約 3/4 の区画にクレーターがある
            // 区画内のずらした点を球面に下ろした所が中心。球面の近くの点だけを採用する
            const jx = ix + (h1 & 255) / 256, jy = iy + ((h1 >>> 8) & 255) / 256, jz = iz + ((h1 >>> 16) & 255) / 256;
            const jr = Math.sqrt(jx * jx + jy * jy + jz * jz);
            if (Math.abs(jr - F) > 0.5) continue;
            const s = F / jr;
            const ex = px - jx * s, ey = py - jy * s, ez = pz - jz * s;
            const h2 = hashCell(ix, iy, iz, salt ^ 0x5bd1e995);
            const u = (h2 & 0xffff) / 65536;
            const rad = 0.08 + 0.22 * u * u; // 半径 (区画の一辺を1として)。小さいものが多い
            const t2 = (ex * ex + ey * ey + ez * ez) / (rad * rad);
            if (t2 >= 2.56) continue; // 縁の外側の盛り上がりは半径の 1.6 倍まで
            const t = Math.sqrt(t2);
            const rm = rad * cell; // 半径 (m)
            const age = 0.35 + 0.65 * ((h2 >>> 16) / 65536); // 古いものほど浅く崩れている
            const depth = ((0.22 * rm) / (1 + rm / 6000)) * age;
            const rim = depth * 0.3;
            if (t < 1) {
              // 小さいものはお椀形、大きいものは底が平らで壁が急になる
              const e = 2 + 3 * smooth(2000, 12000, rm);
              sum += (depth + rim) * Math.pow(t, e) - depth;
              if (rm > 8000 && t < 0.22) { // 中央丘
                const q = 1 - t / 0.22;
                sum += depth * 0.35 * q * q;
              }
            } else {
              const q = (1.6 - t) / 0.6;
              sum += rim * q * q;
            }
          }
        }
      }
    }
    return sum;
  }

  // --- 渓谷と台地 ---
  // どちらも「なめらかなノイズの等値線」に沿って崖を立てる。
  // 等値線までの距離を (値 ÷ 勾配の大きさ) で m 単位に直すので、ノイズがゆるやかな所でも
  // 急な所でも、崖の幅 (= 急さ) を m で指定どおりにできる。
  // 崖の幅は minWL より細くしない。粗いメッシュでは崖がなだらかになるが、形はずれない。
  const CL = CLIFFS[type] || {};
  const canyonCfg = CL.canyon && !hMap && (T.canyons ?? 1) > 0 ? { ...CL.canyon, depth: CL.canyon.depth * (T.canyons ?? 1) } : null;
  const mesaCfg = CL.mesa && !hMap && (T.mesas ?? 1) > 0 ? { ...CL.mesa, tier: CL.mesa.tier * (T.mesas ?? 1) } : null;
  const _fd = [0, 0, 0, 0];

  /** fbm の値と勾配 (入力座標についての偏微分) を out = [値, ∂x, ∂y, ∂z] に入れる。 */
  function fbmD(x, y, z, octaves, out) {
    let a = 1, f = 1, s = 0, gx = 0, gy = 0, gz = 0;
    for (let i = 0; i < octaves; i++) {
      n.noiseD(x * f, y * f, z * f, _nd);
      s += a * _nd[0];
      gx += a * f * _nd[1]; gy += a * f * _nd[2]; gz += a * f * _nd[3];
      f *= 2.03;
      a *= 0.5;
    }
    out[0] = s; out[1] = gx; out[2] = gy; out[3] = gz;
    return out;
  }

  /**
   * 周波数 freq で引いたノイズ out (fbmD の結果) の等値線 (値 = level) までの
   * 符号付きのおおよその距離 (m)。(x,y,z) は鉛直方向。
   */
  function isoDist(out, freq, level, x, y, z) {
    let gx = out[1] * freq, gy = out[2] * freq, gz = out[3] * freq;
    const r = gx * x + gy * y + gz * z;
    gx -= r * x; gy -= r * y; gz -= r * z;
    // 勾配がほぼ 0 の所 (ノイズの山頂や鞍部) で距離が発散しないよう、下限を設ける
    const g = Math.max(Math.sqrt(gx * gx + gy * gy + gz * gz), 0.35 * freq);
    return ((out[0] - level) / g) * R;
  }

  /**
   * 段のある壁の高さの割合 (0 = 谷底, 1 = 縁)。u: 壁の中での位置 (0 = 谷底側, 1 = 縁)。
   * 段ごとに、内側で崖が立ち上がり、外側は少し傾いた棚になる。
   */
  function stairs(u, steps, riser, segW, minWL) {
    if (u <= 0) return 0;
    if (u >= 1) return 1;
    const q = u * steps;
    const i = Math.floor(q), f = q - i;
    // 崖は minWL の2倍 (頂点4つぶん) より細くしない。それより細いと、崖が頂点の格子を
    // ジグザグに横切って櫛のような縞が出る。(代わりに、細かさの違うチャンクの境目で
    // 崖の形が少し食い違う)
    const r = Math.min(1, Math.max(riser, (2 * minWL) / segW));
    const s = lerp(smooth(0, r, f), f, 0.15);
    const stepped = (i + s) / steps;
    // 段そのものがメッシュより細かいときは、ただの斜面にする
    const blend = smooth(0.25, 0.5, minWL / segW);
    return lerp(stepped, smooth(0, 1, u), blend);
  }

  /** 1つの渓谷の網が削る深さ (m, 0 以上)。 */
  function canyonNet(px, py, pz, x, y, z, freq, depth, floor, wall, steps, riser, minWL) {
    fbmD(px * freq, py * freq, pz * freq, 3, _fd);
    const d = Math.abs(isoDist(_fd, freq, 0, x, y, z));
    if (d >= floor + wall) return 0;
    if (d <= floor) return depth;
    const u = (d - floor) / wall;
    return depth * (1 - stairs(u, steps, riser, wall / steps, minWL));
  }

  /** 渓谷が削る深さ (m, 0 以上)。 */
  function canyons(x, y, z, minWL) {
    const C = canyonCfg;
    // 渓谷のある地域
    const t = 0.6 * (0.5 - C.cover); // ノイズがこれを超える割合がおよそ cover
    const region = smooth(t - 0.1, t + 0.1, fbm(x * 1.3 + 41.7, y * 1.3 - 12.3, z * 1.3 + 6.1, 2));
    if (region < 0.001) return 0;
    // 渓谷を蛇行させる (うねりの大きさも m 単位で保つ)
    const W = 0.06 / S, f3 = 3 * S;
    const px = x + W * fbm(x * f3 + 7.7, y * f3 + 1.4, z * f3 - 9.2, 2);
    const py = y + W * fbm(x * f3 - 3.3, y * f3 + 8.8, z * f3 + 2.6, 2);
    const pz = z + W * fbm(x * f3 + 5.1, y * f3 - 6.4, z * f3 + 13.9, 2);
    // 場所ごとに深さと幅を変える
    const f9 = 9 * S, f11 = 11 * S;
    const v1 = 0.5 + 0.5 * n.noise(x * f9 + 2.2, y * f9 + 17.5, z * f9 - 4.4);
    const v2 = 0.5 + 0.5 * n.noise(x * f11 - 8.1, y * f11 + 3.9, z * f11 + 12.7);
    const depth = C.depth * (0.55 + 0.7 * v1);
    const floor = C.floor * (0.5 + 0.9 * v2);
    const wall = C.wall * (0.7 + 0.6 * v1);
    // 本流と、その半分ほどの深さの支流。重なった所は深い方を取る
    const main = canyonNet(px + 3.7, py - 1.9, pz + 8.3, x, y, z, C.freq * S, depth, floor, wall, C.steps, C.riser, minWL);
    const side = canyonNet(px - 6.1, py + 4.4, pz - 2.8, x, y, z, C.freq * 2.6 * S, depth * 0.5, floor * 0.4, wall * 0.6,
      Math.max(1, C.steps - 1), C.riser, minWL);
    return Math.max(main, side) * region;
  }

  /** 台地が持ち上げる高さ (m, 0 以上)。 */
  function mesas(x, y, z, minWL) {
    const M = mesaCfg;
    const t = 0.6 * (0.5 - M.cover);
    const region = smooth(t - 0.1, t + 0.1, fbm(x * 1.7 - 23.4, y * 1.7 + 9.6, z * 1.7 + 31.2, 2));
    if (region < 0.001) return 0;
    const f = M.freq * S;
    fbmD(x * f + 17.3, y * f - 5.5, z * f + 2.9, 3, _fd);
    const w = Math.max(M.edge, minWL); // 崖の幅 2w は頂点4つぶん以上 (渓谷の段と同じ理由)
    let sum = 0;
    for (let k = 0; k < M.tiers; k++) {
      const d = isoDist(_fd, f, -0.05 + k * 0.17, x, y, z);
      // 上は切り立った崖、下は崩れた岩のなだらかな裾 (崖錐)
      sum += 0.75 * smooth(-w, w, d) + 0.25 * smooth(-6 * w, w, d);
    }
    return sum * M.tier * region;
  }

  /**
   * 単位ベクトル (x,y,z) の方向の標高 (m)。0 が海面で、負は海底。
   * minWL: これより短い波長の凹凸は省く。1 を渡すと最も細かい。
   */
  function height(x, y, z, minWL = 1) {
    if (hMap) return mapHeight(x, y, z, minWL);
    // ドメインワープ: ノイズを引く位置を別のノイズでずらす。
    // 海岸線や山脈が、まっすぐな塊ではなくうねった形になる。
    const W = 0.2;
    const X = x + W * fbm(x * 2.1 + 13.7, y * 2.1 - 8.2, z * 2.1 + 4.4, 3);
    const Y = y + W * fbm(x * 2.1 - 5.9, y * 2.1 + 17.3, z * 2.1 - 11.6, 3);
    const Z = z + W * fbm(x * 2.1 + 9.4, y * 2.1 + 2.8, z * 2.1 + 21.1, 3);

    // 大陸の形
    const c = fbm(X * 1.5 + 3.1, Y * 1.5 + 1.7, Z * 1.5 + 5.3, oct(1.5, minWL, 9));
    const land = c * 1.1 + T.land;
    let h = land * T.cAmp;

    // 山脈: 陸地の内側で、さらに低周波のマスクがかかった所にだけ立つ
    const m1 = fbm(X * 3.1 - 7.3, Y * 3.1 + 2.9, Z * 3.1 + 0.7, 3);
    const mMask = smooth(0.02, 0.4, land) * smooth(-0.25, 0.25, m1);
    if (mMask > 0.001) {
      // 尾根の向きにも細かいうねりを足す。尾根とうねりは m 単位の大きさを保つ
      const w2 = 0.03 / S, f7 = 7 * S, f9 = 9 * S;
      const rx = X + w2 * fbm(x * f7 + 31.3, y * f7 - 2.6, z * f7 + 14.9, 2);
      const ry = Y + w2 * fbm(x * f7 - 19.1, y * f7 + 6.2, z * f7 - 27.4, 2);
      const rz = Z + w2 * fbm(x * f7 + 3.8, y * f7 + 24.5, z * f7 + 8.1, 2);
      h += mMask * ridged(rx * f9 + 1.9, ry * f9 - 4.2, rz * f9 + 8.8, oct(f9, minWL, 14), x, y, z) * T.mAmp;
    }

    // 丘陵と細かい起伏 (海岸付近では弱める)
    const lowland = smooth(-0.1, 0.15, land);
    if (lowland > 0.001) {
      const f45 = 45 * S, f2800 = 2800 * S;
      h += fbmEroded(x * f45 + 11, y * f45 + 23, z * f45 - 5, oct(f45, minWL, 10), x, y, z) * T.hAmp * lowland * (0.4 + mMask);
      if (minWL < 150) {
        h += fbm(x * f2800 - 3, y * f2800 + 8, z * f2800 + 1, oct(f2800, minWL, 8)) * 9 * lowland * (0.25 + mMask);
      }
    }

    if (mesaCfg) h += mesas(x, y, z, minWL);
    if (canyonCfg) {
      let carve = canyons(x, y, z, minWL);
      if (type === 'terran') carve *= smooth(0.03, 0.2, land); // 海底は削らない
      if (carve > 0) {
        const cut = h - carve;
        if (type === 'terran') {
          // 谷底が海面より下になるのは高緯度 (フィヨルド) だけ。それ以外は乾いた谷にする
          const lat = Math.abs(y);
          const lowest = lerp(8, -450, smooth(0.6, 0.78, lat));
          h = Math.max(cut, Math.min(h, lowest));
        } else {
          h = cut;
        }
      }
    }
    if (craterAmount > 0) h += craters(x, y, z, minWL) * craterAmount;
    return h;
  }

  /**
   * マップのある天体の標高 (m)。マップの標高 × heightScale に、マップの画素より細かい波長のノイズを足す。
   * 海のある天体では、海岸の近く (マップの標高 0〜60 m) で細かい模様を弱め、海底には足さない
   * (小さな島や池が散らばらないように)。陸がノイズで深く削られて湖にならないよう、下げる量はもとの高さの 8 割まで。
   */
  function mapHeight(x, y, z, minWL) {
    const geo = localToGeoRad(x, y, z);
    const base = hMap.cubic(geo.lat, geo.lon, minWL / R) * heightScale;
    const sea = type === 'terran';
    const coast = sea ? smooth(0, 60, base) : 1;
    let detail = 0;
    if (coast > 0.001) {
      // 尾根は高い所 (山脈) にだけ足す。月 (岩石天体) には足さない
      const mMask = sea ? smooth(300, 2500, base) : 0;
      if (mMask > 0.001) {
        const f9 = 9 * S;
        detail += mMask * T.mAmp
          * ridged(x * f9 + 1.9, y * f9 - 4.2, z * f9 + 8.8, oct(f9, minWL, 14), x, y, z, firstOct(f9, 2.07));
      }
      const f45 = 45 * S, f2800 = 2800 * S;
      detail += fbmEroded(x * f45 + 11, y * f45 + 23, z * f45 - 5, oct(f45, minWL, 10), x, y, z, firstOct(f45, 2.03))
        * T.hAmp * (0.4 + mMask);
      if (minWL < 150) {
        detail += fbm(x * f2800 - 3, y * f2800 + 8, z * f2800 + 1, oct(f2800, minWL, 8), firstOct(f2800, 2.03))
          * 9 * (0.25 + mMask);
      }
      detail *= coast;
      if (sea && base > 0) detail = Math.max(detail, -0.8 * base);
    }
    let h = base + detail;
    if (craterAmount > 0) h += craters(x, y, z, minWL) * craterAmount;
    return h;
  }

  /**
   * 土地被覆の区分 (COVER の要素)。表にない番号なら null。
   * 区分の境目が画素の形 (カクカクした段) に見えないよう、読む位置を 1.5 画素ほどノイズでずらす。
   */
  function coverAt(x, y, z) {
    const geo = localToGeoRad(x, y, z);
    const w = coverMap.pixelAngle * 1.5;
    const fq = 1 / (coverMap.pixelAngle * 3); // ずらし方の模様の大きさは約 3 画素
    const dLat = n.noise(x * fq + 7.1, y * fq - 3.7, z * fq + 1.3) * w;
    const dLon = n.noise(x * fq - 5.3, y * fq + 9.9, z * fq - 2.2) * w / Math.max(Math.cos(geo.lat), 0.05);
    return COVER[coverMap.nearest(geo.lat + dLat, geo.lon + dLon)] || null;
  }

  /** 湿り気 (およそ -1..1)。色と植生の両方で使う。 */
  function moisture(x, y, z) {
    return fbm(x * 4 + 9.1, y * 4 - 3.3, z * 4 + 6.6, 4);
  }

  /** 暖かさ (1 = 暖かい)。緯度と標高で決まる。 */
  function warmth(h, y) {
    const lat = Math.abs(y);
    return 1 - lat * lat * lat - h / 9000;
  }

  /**
   * 街の濃さ (0..1)。都市惑星の陸地だけ。0.25 を下回る所は公園、0.7 を超える所は高層ビルの立つ都心。
   * 地表の色・夜の街明かり・ビルの置き方 (city.js) がこれを使う。
   */
  function urban(h, x, y, z) {
    if (type !== 'city' || h <= 1) return 0;
    const f6 = 6 * S, f22 = 22 * S;
    const district = fbm(x * f6 + 21.1, y * f6 - 7.7, z * f6 + 3.9, 3); // 地区ごとの濃さ (数十 km)
    const core = fbm(x * f22 - 4.2, y * f22 + 9.3, z * f22 + 12.6, 2); // 都心 (数 km)
    const u = 0.5 + district * 0.7 + core * 0.45;
    return sat(u) * smooth(1, 20, h); // 波打ち際には建てない
  }

  /**
   * 木の生えやすさ (0..1)。海洋惑星の、湿っていて寒すぎない陸地にだけ森がある。
   * 地表の色 (colorTerran) の森の範囲と揃えてある。都市惑星では公園にだけ木がある。
   */
  function forest(h, x, y, z) {
    if (type === 'city') return h < 4 ? 0 : smooth(0.3, 0.1, urban(h, x, y, z)) * smooth(4, 30, h);
    if (type !== 'terran' || h < 4) return 0;
    if (coverMap) { // 土地被覆の区分で決める (colorTerran の色と揃える)
      const c = coverAt(x, y, z);
      if (c) return c.forest * smooth(0.3, 0.45, warmth(h, y)) * smooth(4, 30, h);
    }
    const m = sat(moisture(x, y, z) * 1.6 + 0.5);
    return smooth(0.42, 0.75, m) * smooth(0.3, 0.45, warmth(h, y)) * smooth(4, 30, h);
  }

  /** 海洋惑星の色。 */
  function colorTerran(out, h, slope, x, y, z) {
    const lat = Math.abs(y); // 自転軸は惑星ローカルの Y
    const moist = moisture(x, y, z);
    const vary = n.noise(x * F_VARY + 0.5, y * F_VARY + 0.5, z * F_VARY + 0.5) * 0.5;

    if (h <= 0) {
      if (lat > 0.93 + moist * 0.04) { // 極の海氷
        out[0] = 0.8; out[1] = 0.85; out[2] = 0.9; out[3] = 0;
        return;
      }
      const d = sat(-h / 1200);
      out[0] = lerp(0.04, 0.005, d);
      out[1] = lerp(0.2, 0.03, d);
      out[2] = lerp(0.26, 0.1, d);
      // 浅瀬は底の砂が透けて明るい青緑になる (暖かい海ほどはっきり)
      const shallow = smooth(-45, 0, h) * (0.3 + 0.5 * smooth(0.95, 0.5, lat));
      out[0] = lerp(out[0], 0.035, shallow);
      out[1] = lerp(out[1], 0.25, shallow);
      out[2] = lerp(out[2], 0.24, shallow);
      out[3] = 1;
      return;
    }

    const temp = warmth(h, y); // 1 = 暖かい
    const k = 1 + vary * 0.35;
    let r, g, b, t;
    const cover = coverMap ? coverAt(x, y, z) : null;
    if (cover) { // 本物の土地被覆 (寒さによる荒れ地はすでに区分に入っている)
      r = cover.color[0] * k; g = cover.color[1] * k; b = cover.color[2] * k;
    } else {
      const m = sat(moist * 1.6 + 0.5);
      if (m < 0.3) { // 砂漠 → 乾いた草地
        t = m / 0.3;
        r = lerp(0.6, 0.36, t); g = lerp(0.48, 0.34, t); b = lerp(0.29, 0.15, t);
      } else { // 乾いた草地 → 森
        t = (m - 0.3) / 0.7;
        r = lerp(0.36, 0.09, t); g = lerp(0.34, 0.24, t); b = lerp(0.15, 0.06, t);
      }
      r *= k; g *= k; b *= k;

      t = smooth(0.45, 0.2, temp); // 寒冷地は荒れ地
      r = lerp(r, 0.33, t); g = lerp(g, 0.31, t); b = lerp(b, 0.25, t);
    }

    t = smooth(35, 3, h); // 砂浜
    r = lerp(r, 0.7, t); g = lerp(g, 0.64, t); b = lerp(b, 0.47, t);

    t = smooth(0.9, 0.72, slope); // 急斜面は岩
    r = lerp(r, 0.3 * k, t); g = lerp(g, 0.27 * k, t); b = lerp(b, 0.25 * k, t);

    t = smooth(0.22, 0.12, temp) * smooth(0.5, 0.75, slope); // 雪
    r = lerp(r, 0.92, t); g = lerp(g, 0.94, t); b = lerp(b, 0.97, t);

    out[0] = r; out[1] = g; out[2] = b; out[3] = 0;
  }

  /** 都市惑星の色。out[3] には街の濃さの半分を入れる (シェーダーが夜の街明かりに使う)。 */
  function colorCity(out, h, slope, x, y, z) {
    if (h <= 0) {
      colorTerran(out, h, slope, x, y, z);
      return;
    }
    const u = urban(h, x, y, z);
    const vary = n.noise(x * F_VARY + 0.5, y * F_VARY + 0.5, z * F_VARY + 0.5) * 0.5;
    const k = 1 + vary * 0.4;
    // 公園 → 郊外 (明るいコンクリート) → 都心 (暗いアスファルトと屋上)
    let r = 0.08, g = 0.17, b = 0.055;
    let t = smooth(0.12, 0.35, u);
    r = lerp(r, 0.34, t); g = lerp(g, 0.33, t); b = lerp(b, 0.31, t);
    t = smooth(0.55, 1, u);
    r = lerp(r, 0.2, t); g = lerp(g, 0.2, t); b = lerp(b, 0.22, t);
    t = smooth(14, 2, h); // 護岸
    r = lerp(r, 0.42, t); g = lerp(g, 0.41, t); b = lerp(b, 0.4, t);
    out[0] = r * k; out[1] = g * k; out[2] = b * k;
    out[3] = u * 0.5;
  }

  /**
   * 海のない天体の色。out[3] は 0 = 普通の地面、0.5 = 自分で光る (溶岩)。
   */
  function colorDry(out, h, slope, x, y, z) {
    const lat = Math.abs(y);
    const patch = fbm(x * 4 + 9.1, y * 4 - 3.3, z * 4 + 6.6, 4); // 大きな色むら
    const vary = n.noise(x * F_VARY + 0.5, y * F_VARY + 0.5, z * F_VARY + 0.5) * 0.5;
    const k = 1 + vary * 0.3;
    const p = sat(patch * 1.4 + 0.5);
    const steep = smooth(0.9, 0.7, slope);
    let r, g, b, glow = 0;

    if (type === 'desert') {
      if (h <= 0) { // 干上がった盆地 (塩の平原)
        r = 0.66; g = 0.6; b = 0.48;
      } else {
        r = lerp(0.64, 0.46, p); g = lerp(0.47, 0.27, p); b = lerp(0.28, 0.16, p); // 砂 → 赤い岩
        const t = smooth(60, 5, h); // 盆地の縁
        r = lerp(r, 0.62, t); g = lerp(g, 0.55, t); b = lerp(b, 0.42, t);
        // 崖の岩肌。地層の縞はシェーダーで描く
        // (頂点色に入れると、崖では頂点ごとに縞の別の所を拾って、櫛のような模様になる)
        r = lerp(r, 0.4, steep); g = lerp(g, 0.27, steep); b = lerp(b, 0.19, steep);
      }
      const frost = smooth(0.9, 0.97, lat + patch * 0.03); // 極の霜
      r = lerp(r, 0.85, frost); g = lerp(g, 0.84, frost); b = lerp(b, 0.82, frost);
    } else if (type === 'ice') {
      if (h <= 0) { // 凍った海
        r = lerp(0.62, 0.78, p); g = lerp(0.76, 0.87, p); b = lerp(0.86, 0.93, p);
      } else {
        r = lerp(0.84, 0.94, p); g = lerp(0.88, 0.96, p); b = lerp(0.93, 0.98, p); // 雪原
        r = lerp(r, 0.34, steep); g = lerp(g, 0.4, steep); b = lerp(b, 0.48, steep); // 青みのある岩
      }
    } else if (type === 'lava') {
      if (h <= 0) { // 溶岩の海。冷えて固まった黒い皮が浮いている
        const crust = smooth(-0.1, 0.25, n.noise(x * (260 * S) + 3.3, y * (260 * S) - 1.1, z * (260 * S) + 7.7) + patch * 0.4);
        r = lerp(0.85, 0.14, crust); g = lerp(0.22, 0.05, crust); b = lerp(0.03, 0.04, crust);
        glow = 1 - crust * 0.85;
      } else {
        r = lerp(0.1, 0.17, p); g = lerp(0.085, 0.13, p); b = lerp(0.08, 0.11, p); // 玄武岩と灰
        const t = smooth(120, 0, h); // 溶岩のそばは赤く照らされる
        r = lerp(r, 0.5, t * 0.6); g = lerp(g, 0.14, t * 0.6);
        r = lerp(r, 0.06, steep); g = lerp(g, 0.055, steep); b = lerp(b, 0.055, steep);
      }
    } else if (albedoMap) { // 明るさのマップのある岩石天体 (本物の月)。暗い海と明るい高地はマップで決める
      const geo = localToGeoRad(x, y, z);
      // マップの値は、暗い海が 0.35〜0.45、明るい高地が 0.75 前後 (sRGB の画像の明るさ)。
      // そのままでは海が目立たないので、0.3〜0.9 を広げて、海と高地の明るさの比を 3 倍ほどにする
      const v = lerp(0.08, 0.5, sat((albedoMap.linear(geo.lat, geo.lon) - 0.3) / 0.6)) * (1 - 0.2 * steep);
      r = v; g = v; b = v * 1.02;
    } else { // rock
      if (h <= 0) { // 暗い平原 (月の海)
        r = 0.17; g = 0.17; b = 0.18;
      } else {
        r = lerp(0.36, 0.5, p); g = lerp(0.35, 0.48, p); b = lerp(0.34, 0.45, p);
        const t = smooth(80, 5, h);
        r = lerp(r, 0.22, t); g = lerp(g, 0.22, t); b = lerp(b, 0.23, t);
        r = lerp(r, 0.28, steep); g = lerp(g, 0.27, steep); b = lerp(b, 0.26, steep);
      }
    }
    const dim = glow > 0 ? 1 : k;
    out[0] = r * dim; out[1] = g * dim; out[2] = b * dim;
    out[3] = glow > 0.3 ? 0.5 : 0;
  }

  /**
   * 地表の色 (リニアRGB) を out[0..2] に、面の種類を out[3] に入れる
   * (0 = 地面, 1 = 水面, 0.5 = 光る溶岩。都市惑星の陸では 0..0.5 = 街の濃さの半分)。
   * slope: 法線と鉛直の内積 (1 = 水平, 0 = 垂直の崖)
   */
  function color(out, h, slope, x, y, z) {
    if (type === 'terran') colorTerran(out, h, slope, x, y, z);
    else if (type === 'city') colorCity(out, h, slope, x, y, z);
    else colorDry(out, h, slope, x, y, z);
    if (T.tint) {
      out[0] *= T.tint[0]; out[1] *= T.tint[1]; out[2] *= T.tint[2];
    }
  }

  return {
    radius: R, type, seed: def.seed, height, color, forest, warmth, urban,
    /** 生のノイズ (およそ -1..1)。岩の散らばり方などに使う。 */
    noise: (x, y, z) => n.noise(x, y, z),
  };
}

/**
 * ガス巨星の「地形」。降りられる地面はなく、標高はどこでも 0 (雲の頂き)。色は緯度ごとの縞 (gasBands.js)。
 * 岩の惑星と同じ LOD のチャンクで描くので、近づいても球が多角形に見えない。
 */
function makeGasTerrain(def) {
  const n = new Perlin(def.seed);
  const gasColor = makeGasColor(def);
  return {
    radius: def.radius, type: 'gas', seed: def.seed,
    height: () => 0,
    color: (out, h, slope, x, y, z) => gasColor(out, x, y, z),
    forest: () => 0,
    warmth: () => 1,
    urban: () => 0,
    noise: (x, y, z) => n.noise(x, y, z),
  };
}
