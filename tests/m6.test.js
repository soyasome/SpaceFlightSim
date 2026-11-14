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

test('地形: ワープと侵食を入れても標高は連続 (1 m 動いて段差ができない)', () => {
  const R = 400e3;
  for (const type of ['terran', 'rock', 'desert']) {
    const t = makeTerrain({ seed: 12, radius: R, terrain: { type, land: 0.3, cAmp: 2400, mAmp: 6000, hAmp: 380 } });
    let worst = 0;
    sphere(1500, (x, y, z) => {
      // 接線方向に 1 m ずらす
      let x2 = x + (1 / R) * z, y2 = y, z2 = z - (1 / R) * x;
      const inv = 1 / Math.hypot(x2, y2, z2);
      x2 *= inv; y2 *= inv; z2 *= inv;
      worst = Math.max(worst, Math.abs(t.height(x, y, z, 1) - t.height(x2, y2, z2, 1)));
    });
    assert(worst < 8, `${type}: 1 m で ${worst} m の段差`);
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
