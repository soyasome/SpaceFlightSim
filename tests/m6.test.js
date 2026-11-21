import { test, assert, near } from './harness.js';
import { Perlin } from '../src/terrain/noise.js';
import { makeTerrain } from '../src/terrain/terrainFn.js';
import { faceDir, dirToFace } from '../src/terrain/chunkBuilder.js';
import { buildCell } from '../src/planet/scatter.js';

test('ノイズ: noiseD の値は noise と同じで、勾配は差分と一致する', () => {
  const n = new Perlin(77);
  const out = [0, 0, 0, 0];
  const e = 1e-5;
  for (const [x, y, z] of [[0.3, 1.7, -2.2], [10.51, -3.49, 7.02], [-100.25, 42.9, 0.6], [5, 5.5, 5.25]]) {
    n.noiseD(x, y, z, out);
    near(out[0], n.noise(x, y, z), 1e-12, '値');
    near(out[1], (n.noise(x + e, y, z) - n.noise(x - e, y, z)) / (2 * e), 1e-5, '∂x');
    near(out[2], (n.noise(x, y + e, z) - n.noise(x, y - e, z)) / (2 * e), 1e-5, '∂y');
    near(out[3], (n.noise(x, y, z + e) - n.noise(x, y, z - e)) / (2 * e), 1e-5, '∂z');
  }
});

test('キューブ球: dirToFace は faceDir の逆になっている', () => {
  const d = [0, 0, 0], f = [0, 0, 0];
  for (let face = 0; face < 6; face++) {
    for (const [s, t] of [[0.1, 0.9], [0.5, 0.5], [0.73, 0.02]]) {
      faceDir(face, s, t, d);
      dirToFace(d[0], d[1], d[2], f);
      assert(f[0] === face, `面 ${face} が ${f[0]} になった`);
      near(f[1], s, 1e-12, 's');
      near(f[2], t, 1e-12, 't');
    }
  }
});

const sphere = (N, fn) => {
  for (let i = 0; i < N; i++) {
    const y = 1 - (2 * (i + 0.5)) / N, r = Math.sqrt(1 - y * y), a = i * 2.399963;
    fn(Math.cos(a) * r, y, Math.sin(a) * r);
  }
};

test('クレーター: 岩石天体にはあり、海洋惑星にはなく、深さは現実的な範囲', () => {
  const base = { type: 'rock', land: 0.3, cAmp: 2200, mAmp: 5000, hAmp: 520 };
  const cratered = makeTerrain({ seed: 31, radius: 200e3, terrain: base });
  const smooth = makeTerrain({ seed: 31, radius: 200e3, terrain: { ...base, craters: 0 } });
  let differ = 0, min = 0, max = 0;
  const N = 3000;
  sphere(N, (x, y, z) => {
    const d = cratered.height(x, y, z, 200) - smooth.height(x, y, z, 200);
    assert(Number.isFinite(d), 'NaN');
    if (Math.abs(d) > 1) differ++;
    min = Math.min(min, d); max = Math.max(max, d);
  });
  assert(differ > N * 0.15 && differ < N * 0.98, `クレーターのある割合: ${differ / N}`);
  assert(min < -100 && min > -4000, `最も深い所: ${min}`);
  assert(max > 5 && max < 1500, `縁の高さ: ${max}`);

  // 既定値: terran はクレーターなし (craters: 0 を明示しても同じ標高)
  const t = { type: 'terran', land: 0.05, cAmp: 2800, mAmp: 6500, hAmp: 320 };
  const a = makeTerrain({ seed: 31, radius: 200e3, terrain: t });
  const b = makeTerrain({ seed: 31, radius: 200e3, terrain: { ...t, craters: 0 } });
  assert(a.height(0.3, 0.5, -0.81) === b.height(0.3, 0.5, -0.81), 'terran にクレーターがある');
});

test('クレーター・侵食: 細部を省いても大きな形は変わらない (岩石天体)', () => {
  const t = makeTerrain({ seed: 5, radius: 200e3, terrain: { type: 'rock', land: 0.3, cAmp: 2200, mAmp: 5000, hAmp: 520 } });
  let worst = 0;
  sphere(400, (x, y, z) => {
    worst = Math.max(worst, Math.abs(t.height(x, y, z, 1) - t.height(x, y, z, 40)));
  });
  assert(worst < 60, `LOD 間の差が大きい: ${worst}`);
});

/** (x,y,z) から接線方向に m (m) ずらした点での標高の差。 */
const stepDiff = (t, R, x, y, z, m) => {
  let x2 = x + (m / R) * z, y2 = y, z2 = z - (m / R) * x;
  const inv = 1 / Math.hypot(x2, y2, z2);
  x2 *= inv; y2 *= inv; z2 *= inv;
  return Math.abs(t.height(x, y, z, 1) - t.height(x2, y2, z2, 1));
};

test('地形: 崖があっても標高は連続 (ずらす距離を縮めれば差も縮む)', () => {
  // 崖は急だが、本当の段差 (ずらす距離をいくら縮めても残る差) はない
  const R = 400e3;
  for (const type of ['terran', 'rock', 'desert', 'ice', 'lava']) {
    const t = makeTerrain({ seed: 12, radius: R, terrain: { type, land: 0.3, cAmp: 2400, mAmp: 6000, hAmp: 380 } });
    let worst1 = 0, worst01 = 0;
    sphere(2500, (x, y, z) => {
      worst1 = Math.max(worst1, stepDiff(t, R, x, y, z, 1));
      worst01 = Math.max(worst01, stepDiff(t, R, x, y, z, 0.1));
    });
    assert(worst1 < 25, `${type}: 1 m で ${worst1.toFixed(1)} m の段差`);
    assert(worst01 < 3, `${type}: 0.1 m で ${worst01.toFixed(2)} m の段差`);
  }
});

test('渓谷・台地: 砂漠には深い渓谷と高い台地があり、崖は切り立っている', () => {
  const R = 330e3;
  const base = { type: 'desert', land: 0.45, cAmp: 2400, mAmp: 7500, hAmp: 380 };
  const t = makeTerrain({ seed: 77, radius: R, terrain: base });
  const plain = makeTerrain({ seed: 77, radius: R, terrain: { ...base, canyons: 0, mesas: 0 } });
  let deepest = 0, highest = 0, steepest = 0, carved = 0;
  const N = 6000;
  sphere(N, (x, y, z) => {
    const d = t.height(x, y, z, 1) - plain.height(x, y, z, 1);
    deepest = Math.min(deepest, d);
    highest = Math.max(highest, d);
    if (d < -100) carved++;
    // 崖の上では 20 m ずらすと高さが大きく変わる
    steepest = Math.max(steepest, stepDiff(t, R, x, y, z, 20) / 20);
  });
  assert(deepest < -800, `渓谷が浅い: ${deepest.toFixed(0)} m`);
  assert(highest > 300, `台地が低い: ${highest.toFixed(0)} m`);
  assert(carved > N * 0.03 && carved < N * 0.6, `渓谷の割合: ${(carved / N).toFixed(3)}`);
  assert(steepest > 3, `崖がなだらか (最大の傾き ${steepest.toFixed(2)})`);

  // 0 を指定すれば消える。海洋惑星の海底は削られない
  const ocean = makeTerrain({ seed: 77, radius: R });
  const flat = makeTerrain({ seed: 77, radius: R, terrain: { type: 'terran', land: 0.05, cAmp: 2800, mAmp: 6500, hAmp: 320, canyons: 0 } });
  sphere(2000, (x, y, z) => {
    const a = flat.height(x, y, z, 50);
    if (a < -50) assert(ocean.height(x, y, z, 50) === a, '海底が削られた');
  });
});

test('渓谷・台地: 細部を省いても大きな形は変わらない', () => {
  for (const type of ['desert', 'ice', 'lava', 'terran']) {
    const t = makeTerrain({ seed: 9, radius: 300e3, terrain: { type, land: 0.3, cAmp: 2400, mAmp: 6000, hAmp: 380 } });
    let worst = 0;
    sphere(1500, (x, y, z) => {
      worst = Math.max(worst, Math.abs(t.height(x, y, z, 1) - t.height(x, y, z, 40)));
    });
    assert(worst < 60, `${type}: LOD 間の差が大きい: ${worst.toFixed(1)}`);
  }
});

test('散らばる岩と木: 同じ区画からは同じものが生え、地面の上に乗っている', () => {
  const R = 400e3;
  const terrain = makeTerrain({ seed: 2024, radius: R });
  const n = 2 ** Math.round(Math.log2((Math.PI / 2) * R / 96));
  // 木のある区画を探す
  let found = null;
  const f = [0, 0, 0];
  sphere(4000, (x, y, z) => {
    if (found) return;
    const h = terrain.height(x, y, z, 100);
    if (h < 40 || terrain.forest(h, x, y, z) < 0.6) return;
    dirToFace(x, y, z, f);
    const ix = Math.floor(f[1] * n), iy = Math.floor(f[2] * n);
    const cell = buildCell(terrain, 1, f[0], ix, iy, n);
    const total = Object.values(cell.lists).reduce((s, l) => s + l.count, 0);
    if (total > 5) found = { face: f[0], ix, iy, cell, total };
  });
  assert(found, '森の区画が見つからない');
  const again = buildCell(terrain, 1, found.face, found.ix, found.iy, n);
  for (const kind in found.cell.lists) {
    const a = found.cell.lists[kind], b = again.lists[kind];
    assert(b && a.count === b.count, '本数が違う');
    assert(a.matrices.every((v, i) => v === b.matrices[i]), '位置が違う');
    // 根元は地面のすぐ下 (0.4 m 埋めてある)
    for (let i = 0; i < a.count; i++) {
      const x = a.matrices[i * 16 + 12] + found.cell.center[0];
      const y = a.matrices[i * 16 + 13] + found.cell.center[1];
      const z = a.matrices[i * 16 + 14] + found.cell.center[2];
      const r = Math.hypot(x, y, z);
      const h = terrain.height(x / r, y / r, z / r, 1);
      near(r - R, h - 0.4, 0.2, '木の根元の高さ');
      assert(h > 0, '海の中に木がある');
    }
  }
});

test('散らばる岩と木: 岩はどの種類の天体にもあり、木は海洋惑星にしかない', () => {
  const R = 200e3;
  for (const type of ['rock', 'desert', 'ice', 'lava']) {
    const terrain = makeTerrain({ seed: 8, radius: R, terrain: { type, land: 0.4, cAmp: 2400, mAmp: 6000, hAmp: 380 } });
    const n = 2 ** Math.round(Math.log2((Math.PI / 2) * R / 48));
    let rocks = 0, trees = 0;
    for (let k = 0; k < 60; k++) {
      const ix = Math.floor(n / 2) + k * 37, iy = Math.floor(n / 3) + k * 53;
      const c = buildCell(terrain, 0, k % 6, ix % n, iy % n, n);
      rocks += c.lists[0] ? c.lists[0].count : 0;
      const tc = buildCell(terrain, 1, k % 6, ix % n, iy % n, n);
      trees += Object.values(tc.lists).reduce((s, l) => s + l.count, 0);
    }
    assert(rocks > 10, `${type}: 岩が少なすぎる (${rocks})`);
    assert(trees === 0, `${type}: 木が生えている`);
  }
});
