// 立方体の6面を球に投影した「キューブ球」の一区画 (チャンク) のメッシュを作る。
// Worker から使うので外部ライブラリに依存させないこと。

export const GRID = 32; // チャンク一辺の分割数
const V = GRID + 1; // 一辺の頂点数
const B = GRID + 3; // 法線計算用に外周を1周ぶん余分に計算する

/** 立方体の6面。axis が面の向き、u/v が面内の2方向。 */
export const FACES = [
  { axis: [1, 0, 0], u: [0, 0, -1], v: [0, 1, 0] },
  { axis: [-1, 0, 0], u: [0, 0, 1], v: [0, 1, 0] },
  { axis: [0, 1, 0], u: [1, 0, 0], v: [0, 0, -1] },
  { axis: [0, -1, 0], u: [1, 0, 0], v: [0, 0, 1] },
  { axis: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] },
  { axis: [0, 0, -1], u: [-1, 0, 0], v: [0, 1, 0] },
];

/** 面 face 上の位置 (s,t ∈ 0..1) を球面上の単位ベクトルにして out[0..2] に入れる。 */
export function faceDir(face, s, t, out) {
  const f = FACES[face];
  const a = 2 * s - 1, b = 2 * t - 1;
  const x = f.axis[0] + f.u[0] * a + f.v[0] * b;
  const y = f.axis[1] + f.u[1] * a + f.v[1] * b;
  const z = f.axis[2] + f.u[2] * a + f.v[2] * b;
  const inv = 1 / Math.sqrt(x * x + y * y + z * z);
  out[0] = x * inv; out[1] = y * inv; out[2] = z * inv;
  return out;
}

/**
 * faceDir の逆。単位ベクトル (x,y,z) がどの面のどこにあるかを out = [face, s, t] に入れる。
 */
export function dirToFace(x, y, z, out) {
  const ax = Math.abs(x), ay = Math.abs(y), az = Math.abs(z);
  let face;
  if (ax >= ay && ax >= az) face = x > 0 ? 0 : 1;
  else if (ay >= az) face = y > 0 ? 2 : 3;
  else face = z > 0 ? 4 : 5;
  const f = FACES[face];
  const m = x * f.axis[0] + y * f.axis[1] + z * f.axis[2];
  out[0] = face;
  out[1] = ((x * f.u[0] + y * f.u[1] + z * f.u[2]) / m + 1) / 2;
  out[2] = ((x * f.v[0] + y * f.v[1] + z * f.v[2]) / m + 1) / 2;
  return out;
}

/** レベル level のチャンクの一辺の長さ (m, 球面上の弧長)。 */
export function chunkSize(radius, level) {
  return (Math.PI / 2) * radius / (1 << level);
}

/** 頂点数 (本体 + スカート)。 */
export const VERTEX_COUNT = V * V + 4 * V;

/** 全チャンク共通のインデックス配列を作る。 */
export function buildIndices() {
  const idx = [];
  for (let j = 0; j < GRID; j++) {
    for (let i = 0; i < GRID; i++) {
      const a = j * V + i, b = a + 1, c = a + V, d = c + 1;
      idx.push(a, b, c, b, d, c);
    }
  }
  // スカート: 縁の頂点を下に垂らした帯。隣とLODが違っても隙間が見えないようにする
  const base = V * V;
  const edge = [
    (i) => i, // t = 0 の辺
    (i) => GRID * V + i, // t = 1
    (i) => i * V, // s = 0
    (i) => i * V + GRID, // s = 1
  ];
  for (let e = 0; e < 4; e++) {
    for (let i = 0; i < GRID; i++) {
      const a = edge[e](i), b = edge[e](i + 1);
      const c = base + e * V + i, d = c + 1;
      idx.push(a, b, c, b, d, c);
    }
  }
  return new Uint16Array(idx);
}

/**
 * チャンクのメッシュを作る。
 * 位置はチャンク中心からの相対座標 (float32 で十分な精度になる)。中心は倍精度で返す。
 */
export function buildChunk(terrain, face, level, ix, iy) {
  const R = terrain.radius;
  const cell = 1 / (1 << level);
  const step = cell / GRID;
  const spacing = chunkSize(R, level) / GRID; // 頂点間隔 (m)
  const minWL = spacing * 2; // これより細かい凹凸はメッシュで表せない

  const px = new Float64Array(B * B), py = new Float64Array(B * B), pz = new Float64Array(B * B);
  const dx = new Float64Array(B * B), dy = new Float64Array(B * B), dz = new Float64Array(B * B);
  const hh = new Float64Array(B * B);
  const dir = [0, 0, 0];

  for (let j = 0; j < B; j++) {
    for (let i = 0; i < B; i++) {
      faceDir(face, (ix + 0) * cell + (i - 1) * step, iy * cell + (j - 1) * step, dir);
      const k = j * B + i;
      const h = terrain.height(dir[0], dir[1], dir[2], minWL);
      const r = R + Math.max(h, 0); // 海面より下は水面として平らにする
      hh[k] = h;
      dx[k] = dir[0]; dy[k] = dir[1]; dz[k] = dir[2];
      px[k] = dir[0] * r; py[k] = dir[1] * r; pz[k] = dir[2] * r;
    }
  }

  const mid = (GRID / 2 + 1) * B + (GRID / 2 + 1);
  const cx = px[mid], cy = py[mid], cz = pz[mid];

  const positions = new Float32Array(VERTEX_COUNT * 3);
  const normals = new Float32Array(VERTEX_COUNT * 3);
  const colors = new Uint8Array(VERTEX_COUNT * 4);
  const col = [0, 0, 0, 0];
  let radius2 = 0;
  let minH = Infinity, maxH = -Infinity;

  for (let j = 0; j < V; j++) {
    for (let i = 0; i < V; i++) {
      const k = (j + 1) * B + (i + 1);
      const o = j * V + i;
      const x = px[k] - cx, y = py[k] - cy, z = pz[k] - cz;
      positions[o * 3] = x; positions[o * 3 + 1] = y; positions[o * 3 + 2] = z;
      radius2 = Math.max(radius2, x * x + y * y + z * z);

      // 隣の頂点との差から法線を求める
      let nx, ny, nz;
      const h = hh[k];
      if (h <= 0) {
        nx = dx[k]; ny = dy[k]; nz = dz[k];
      } else {
        const ax = px[k + 1] - px[k - 1], ay = py[k + 1] - py[k - 1], az = pz[k + 1] - pz[k - 1];
        const bx = px[k + B] - px[k - B], by = py[k + B] - py[k - B], bz = pz[k + B] - pz[k - B];
        nx = ay * bz - az * by; ny = az * bx - ax * bz; nz = ax * by - ay * bx;
        const inv = 1 / Math.sqrt(nx * nx + ny * ny + nz * nz);
        nx *= inv; ny *= inv; nz *= inv;
        if (nx * dx[k] + ny * dy[k] + nz * dz[k] < 0) { nx = -nx; ny = -ny; nz = -nz; }
      }
      normals[o * 3] = nx; normals[o * 3 + 1] = ny; normals[o * 3 + 2] = nz;

      const slope = nx * dx[k] + ny * dy[k] + nz * dz[k];
      terrain.color(col, h, slope, dx[k], dy[k], dz[k]);
      colors[o * 4] = Math.round(Math.min(1, col[0]) * 255);
      colors[o * 4 + 1] = Math.round(Math.min(1, col[1]) * 255);
      colors[o * 4 + 2] = Math.round(Math.min(1, col[2]) * 255);
      colors[o * 4 + 3] = col[3] * 255;

      if (h < minH) minH = h;
      if (h > maxH) maxH = h;
    }
  }

  // スカート
  const depth = Math.max(2, spacing * GRID * 0.05);
  const src = [
    (i) => i, (i) => GRID * V + i, (i) => i * V, (i) => i * V + GRID,
  ];
  const srcGrid = [
    (i) => 1 * B + (i + 1), (i) => (GRID + 1) * B + (i + 1),
    (i) => (i + 1) * B + 1, (i) => (i + 1) * B + (GRID + 1),
  ];
  for (let e = 0; e < 4; e++) {
    for (let i = 0; i < V; i++) {
      const s = src[e](i), k = srcGrid[e](i);
      const o = V * V + e * V + i;
      positions[o * 3] = positions[s * 3] - dx[k] * depth;
      positions[o * 3 + 1] = positions[s * 3 + 1] - dy[k] * depth;
      positions[o * 3 + 2] = positions[s * 3 + 2] - dz[k] * depth;
      normals[o * 3] = normals[s * 3]; normals[o * 3 + 1] = normals[s * 3 + 1]; normals[o * 3 + 2] = normals[s * 3 + 2];
      colors[o * 4] = colors[s * 4]; colors[o * 4 + 1] = colors[s * 4 + 1];
      colors[o * 4 + 2] = colors[s * 4 + 2]; colors[o * 4 + 3] = colors[s * 4 + 3];
    }
  }

  return {
    positions, normals, colors,
    center: [cx, cy, cz],
    boundRadius: Math.sqrt(radius2) + depth,
    minH, maxH,
  };
}
