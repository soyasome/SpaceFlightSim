// このフォルダ (terrain/) のファイルは Web Worker からも読み込むので、
// three.js など外部ライブラリに依存させないこと。

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);

function grad(hash, x, y, z) {
  const h = hash & 15;
  const u = h < 8 ? x : y;
  const v = h < 4 ? y : h === 12 || h === 14 ? x : z;
  return ((h & 1) === 0 ? u : -u) + ((h & 2) === 0 ? v : -v);
}

/** シード付きの3次元パーリンノイズ。値はおよそ -1..1。 */
export class Perlin {
  constructor(seed) {
    const rand = mulberry32(seed);
    const p = new Uint8Array(256);
    for (let i = 0; i < 256; i++) p[i] = i;
    for (let i = 255; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      const t = p[i]; p[i] = p[j]; p[j] = t;
    }
    this.perm = new Uint8Array(512);
    for (let i = 0; i < 512; i++) this.perm[i] = p[i & 255];
  }

  noise(x, y, z) {
    const p = this.perm;
    const fx = Math.floor(x), fy = Math.floor(y), fz = Math.floor(z);
    const X = fx & 255, Y = fy & 255, Z = fz & 255;
    x -= fx; y -= fy; z -= fz;
    const u = fade(x), v = fade(y), w = fade(z);
    const A = p[X] + Y, AA = p[A] + Z, AB = p[A + 1] + Z;
    const B = p[X + 1] + Y, BA = p[B] + Z, BB = p[B + 1] + Z;

    const x1 = grad(p[AA], x, y, z), x2 = grad(p[BA], x - 1, y, z);
    const x3 = grad(p[AB], x, y - 1, z), x4 = grad(p[BB], x - 1, y - 1, z);
    const x5 = grad(p[AA + 1], x, y, z - 1), x6 = grad(p[BA + 1], x - 1, y, z - 1);
    const x7 = grad(p[AB + 1], x, y - 1, z - 1), x8 = grad(p[BB + 1], x - 1, y - 1, z - 1);

    const a = x1 + u * (x2 - x1), b = x3 + u * (x4 - x3);
    const c = x5 + u * (x6 - x5), d = x7 + u * (x8 - x7);
    const e = a + v * (b - a), f = c + v * (d - c);
    return e + w * (f - e);
  }

  /**
   * ノイズの値と勾配。out[0] = 値 (noise と同じ)、out[1..3] = ∂/∂x, ∂/∂y, ∂/∂z。
   * 斜面の急さに応じて細部を弱める「侵食風」の重ね方に使う。
   */
  noiseD(x, y, z, out) {
    const p = this.perm;
    const fx = Math.floor(x), fy = Math.floor(y), fz = Math.floor(z);
    const X = fx & 255, Y = fy & 255, Z = fz & 255;
    x -= fx; y -= fy; z -= fz;
    const u = fade(x), v = fade(y), w = fade(z);
    const du = dfade(x), dv = dfade(y), dw = dfade(z);
    const A = p[X] + Y, AA = p[A] + Z, AB = p[A + 1] + Z;
    const B = p[X + 1] + Y, BA = p[B] + Z, BB = p[B + 1] + Z;
    const h0 = p[AA] & 15, h1 = p[BA] & 15, h2 = p[AB] & 15, h3 = p[BB] & 15;
    const h4 = p[AA + 1] & 15, h5 = p[BA + 1] & 15, h6 = p[AB + 1] & 15, h7 = p[BB + 1] & 15;
    const x1 = x - 1, y1 = y - 1, z1 = z - 1;

    // 8つの角での「勾配ベクトル · 角からの相対位置」
    const d0 = GX[h0] * x + GY[h0] * y + GZ[h0] * z;
    const d1 = GX[h1] * x1 + GY[h1] * y + GZ[h1] * z;
    const d2 = GX[h2] * x + GY[h2] * y1 + GZ[h2] * z;
    const d3 = GX[h3] * x1 + GY[h3] * y1 + GZ[h3] * z;
    const d4 = GX[h4] * x + GY[h4] * y + GZ[h4] * z1;
    const d5 = GX[h5] * x1 + GY[h5] * y + GZ[h5] * z1;
    const d6 = GX[h6] * x + GY[h6] * y1 + GZ[h6] * z1;
    const d7 = GX[h7] * x1 + GY[h7] * y1 + GZ[h7] * z1;

    const k1 = d1 - d0, k2 = d2 - d0, k3 = d4 - d0;
    const k4 = d0 - d1 - d2 + d3, k5 = d0 - d1 - d4 + d5, k6 = d0 - d2 - d4 + d6;
    const k7 = -d0 + d1 + d2 + d4 - d3 - d5 - d6 + d7;

    out[0] = d0 + u * k1 + v * k2 + w * k3 + u * v * k4 + u * w * k5 + v * w * k6 + u * v * w * k7;
    out[1] = tri(GX[h0], GX[h1], GX[h2], GX[h3], GX[h4], GX[h5], GX[h6], GX[h7], u, v, w)
      + du * (k1 + v * k4 + w * k5 + v * w * k7);
    out[2] = tri(GY[h0], GY[h1], GY[h2], GY[h3], GY[h4], GY[h5], GY[h6], GY[h7], u, v, w)
      + dv * (k2 + u * k4 + w * k6 + u * w * k7);
    out[3] = tri(GZ[h0], GZ[h1], GZ[h2], GZ[h3], GZ[h4], GZ[h5], GZ[h6], GZ[h7], u, v, w)
      + dw * (k3 + u * k5 + v * k6 + u * v * k7);
    return out;
  }
}

const dfade = (t) => 30 * t * t * (t - 1) * (t - 1);

// grad() が選ぶ16通りの勾配ベクトルを表にしたもの
const GX = new Float64Array(16), GY = new Float64Array(16), GZ = new Float64Array(16);
for (let h = 0; h < 16; h++) {
  const s1 = (h & 1) === 0 ? 1 : -1, s2 = (h & 2) === 0 ? 1 : -1;
  if (h < 8) GX[h] += s1; else GY[h] += s1;
  if (h < 4) GY[h] += s2;
  else if (h === 12 || h === 14) GX[h] += s2;
  else GZ[h] += s2;
}

/** 立方体の8つの角の値を (u, v, w) で補間する。 */
function tri(a0, a1, a2, a3, a4, a5, a6, a7, u, v, w) {
  const a = a0 + u * (a1 - a0), b = a2 + u * (a3 - a2);
  const c = a4 + u * (a5 - a4), d = a6 + u * (a7 - a6);
  const e = a + v * (b - a), f = c + v * (d - c);
  return e + w * (f - e);
}
