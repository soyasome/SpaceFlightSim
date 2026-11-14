import { Perlin } from './noise.js';

const sat = (x) => Math.min(1, Math.max(0, x));
/** GLSL の smoothstep と同じ。a > b でも使える (向きが逆になる)。 */
const smooth = (a, b, x) => {
  const t = sat((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};
const lerp = (a, b, t) => a + (b - a) * t;

/** 地形の既定値 (海洋惑星 AURELIA)。 */
const DEFAULT_TERRAIN = { type: 'terran', land: 0.05, cAmp: 2800, mAmp: 6500, hAmp: 320, tint: null };

/** クレーターの深さの倍率 (種類ごとの既定値)。大気や水のある天体では風化して浅い。 */
const CRATER_DEFAULT = { rock: 1, ice: 0.3, desert: 0.35, lava: 0.2, terran: 0 };

/**
 * 惑星の地形を表す関数を作る。メインスレッド (接地判定) と Worker (メッシュ生成) の
 * 両方で同じ定義から作るので、見た目と当たり判定が一致する。
 *
 * def = { seed, radius, terrain? }
 * terrain = { type, land, cAmp, mAmp, hAmp, tint }
 *   type  'terran' 海洋 | 'desert' 砂漠 | 'ice' 氷 | 'lava' 溶岩 | 'rock' 岩石 (大気なし)
 *   land  大きいほど陸 (高地) が増える。標高 0 以下は平らな「低地」になり、
 *         種類によって海・乾いた盆地・氷原・溶岩の海として描かれる
 *   cAmp, mAmp, hAmp  大陸・山脈・丘の高さ (m)
 *   tint  色合い [r, g, b] (掛け算)
 *   craters  クレーターの深さの倍率 (省くと種類ごとの既定値。0 でなし)
 */
export function makeTerrain(def) {
  const R = def.radius;
  const n = new Perlin(def.seed);
  const T = { ...DEFAULT_TERRAIN, ...(def.terrain || {}) };
  const type = T.type;

  // 基本周波数 f0 のノイズを、波長 minWL (m) まで重ねるのに必要なオクターブ数。
  // 遠くの粗いメッシュでは細かい凹凸を計算しないので、生成が軽くなる。
  const oct = (f0, minWL, max) =>
    Math.max(1, Math.min(max, Math.floor(Math.log2(R / (f0 * minWL))) + 1));

  function fbm(x, y, z, octaves) {
    let a = 1, s = 0;
    for (let i = 0; i < octaves; i++) {
      s += a * n.noise(x, y, z);
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
  function ridged(x, y, z, octaves, ux, uy, uz) {
    // 尾根の線 (n = 0) をまたぐと勾配の向きが反転するので、ベクトルで足すと
    // そこに段差ができる。向きを捨てて、急さの2乗だけを積む。
    let a = 0.5, s = 0, w = 1, steep = 0, sw = 1;
    for (let i = 0; i < octaves; i++) {
      n.noiseD(x, y, z, _nd);
      let v = 1 - Math.abs(_nd[0]);
      v *= v * w;
      w = sat(v * 2);
      s += (v * a) / (1 + EROSION * steep);
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
  function fbmEroded(x, y, z, octaves, ux, uy, uz) {
    let a = 1, s = 0, sx = 0, sy = 0, sz = 0, sw = 1;
    for (let i = 0; i < octaves; i++) {
      n.noiseD(x, y, z, _nd);
      s += (a * _nd[0]) / (1 + EROSION * (sx * sx + sy * sy + sz * sz));
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
  const CRATER_LAYERS = 8;
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

  /**
   * 単位ベクトル (x,y,z) の方向の標高 (m)。0 が海面で、負は海底。
   * minWL: これより短い波長の凹凸は省く。1 を渡すと最も細かい。
   */
  function height(x, y, z, minWL = 1) {
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
      // 尾根の向きにも細かいうねりを足す
      const w2 = 0.03;
      const rx = X + w2 * fbm(x * 7 + 31.3, y * 7 - 2.6, z * 7 + 14.9, 2);
      const ry = Y + w2 * fbm(x * 7 - 19.1, y * 7 + 6.2, z * 7 - 27.4, 2);
      const rz = Z + w2 * fbm(x * 7 + 3.8, y * 7 + 24.5, z * 7 + 8.1, 2);
      h += mMask * ridged(rx * 9 + 1.9, ry * 9 - 4.2, rz * 9 + 8.8, oct(9, minWL, 14), x, y, z) * T.mAmp;
    }

    // 丘陵と細かい起伏 (海岸付近では弱める)
    const lowland = smooth(-0.1, 0.15, land);
    if (lowland > 0.001) {
      h += fbmEroded(x * 45 + 11, y * 45 + 23, z * 45 - 5, oct(45, minWL, 10), x, y, z) * T.hAmp * lowland * (0.4 + mMask);
      if (minWL < 150) {
        h += fbm(x * 2800 - 3, y * 2800 + 8, z * 2800 + 1, oct(2800, minWL, 8)) * 9 * lowland * (0.25 + mMask);
      }
    }

    if (craterAmount > 0) h += craters(x, y, z, minWL) * craterAmount;
    return h;
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
   * 木の生えやすさ (0..1)。海洋惑星の、湿っていて寒すぎない陸地にだけ森がある。
   * 地表の色 (colorTerran) の森の範囲と揃えてある。
   */
  function forest(h, x, y, z) {
    if (type !== 'terran' || h < 4) return 0;
    const m = sat(moisture(x, y, z) * 1.6 + 0.5);
    return smooth(0.42, 0.75, m) * smooth(0.3, 0.45, warmth(h, y)) * smooth(4, 30, h);
  }

  /** 海洋惑星の色。 */
  function colorTerran(out, h, slope, x, y, z) {
    const lat = Math.abs(y); // 自転軸は惑星ローカルの Y
    const moist = moisture(x, y, z);
    const vary = n.noise(x * 900 + 0.5, y * 900 + 0.5, z * 900 + 0.5) * 0.5;

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
    const m = sat(moist * 1.6 + 0.5);
    let r, g, b;
    if (m < 0.3) { // 砂漠 → 乾いた草地
      const t = m / 0.3;
      r = lerp(0.6, 0.36, t); g = lerp(0.48, 0.34, t); b = lerp(0.29, 0.15, t);
    } else { // 乾いた草地 → 森
      const t = (m - 0.3) / 0.7;
      r = lerp(0.36, 0.09, t); g = lerp(0.34, 0.24, t); b = lerp(0.15, 0.06, t);
    }
    const k = 1 + vary * 0.35;
    r *= k; g *= k; b *= k;

    let t = smooth(0.45, 0.2, temp); // 寒冷地は荒れ地
    r = lerp(r, 0.33, t); g = lerp(g, 0.31, t); b = lerp(b, 0.25, t);

    t = smooth(35, 3, h); // 砂浜
    r = lerp(r, 0.7, t); g = lerp(g, 0.64, t); b = lerp(b, 0.47, t);

    t = smooth(0.9, 0.72, slope); // 急斜面は岩
    r = lerp(r, 0.3 * k, t); g = lerp(g, 0.27 * k, t); b = lerp(b, 0.25 * k, t);

    t = smooth(0.22, 0.12, temp) * smooth(0.5, 0.75, slope); // 雪
    r = lerp(r, 0.92, t); g = lerp(g, 0.94, t); b = lerp(b, 0.97, t);

    out[0] = r; out[1] = g; out[2] = b; out[3] = 0;
  }

  /**
   * 海のない天体の色。out[3] は 0 = 普通の地面、0.5 = 自分で光る (溶岩)。
   */
  function colorDry(out, h, slope, x, y, z) {
    const lat = Math.abs(y);
    const patch = fbm(x * 4 + 9.1, y * 4 - 3.3, z * 4 + 6.6, 4); // 大きな色むら
    const vary = n.noise(x * 900 + 0.5, y * 900 + 0.5, z * 900 + 0.5) * 0.5;
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
        r = lerp(r, 0.34, steep); g = lerp(g, 0.22, steep); b = lerp(b, 0.16, steep);
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
        const crust = smooth(-0.1, 0.25, n.noise(x * 260 + 3.3, y * 260 - 1.1, z * 260 + 7.7) + patch * 0.4);
        r = lerp(0.85, 0.14, crust); g = lerp(0.22, 0.05, crust); b = lerp(0.03, 0.04, crust);
        glow = 1 - crust * 0.85;
      } else {
        r = lerp(0.1, 0.17, p); g = lerp(0.085, 0.13, p); b = lerp(0.08, 0.11, p); // 玄武岩と灰
        const t = smooth(120, 0, h); // 溶岩のそばは赤く照らされる
        r = lerp(r, 0.5, t * 0.6); g = lerp(g, 0.14, t * 0.6);
        r = lerp(r, 0.06, steep); g = lerp(g, 0.055, steep); b = lerp(b, 0.055, steep);
      }
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
   * (0 = 地面, 1 = 水面, 0.5 = 光る溶岩)。
   * slope: 法線と鉛直の内積 (1 = 水平, 0 = 垂直の崖)
   */
  function color(out, h, slope, x, y, z) {
    if (type === 'terran') colorTerran(out, h, slope, x, y, z);
    else colorDry(out, h, slope, x, y, z);
    if (T.tint) {
      out[0] *= T.tint[0]; out[1] *= T.tint[1]; out[2] *= T.tint[2];
    }
  }

  return {
    radius: R, type, seed: def.seed, height, color, forest, warmth,
    /** 生のノイズ (およそ -1..1)。岩の散らばり方などに使う。 */
    noise: (x, y, z) => n.noise(x, y, z),
  };
}
