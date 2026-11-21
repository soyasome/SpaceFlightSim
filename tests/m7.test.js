import { test, assert, near } from './harness.js';
import { starsNear, HOME_STAR } from '../src/universe/galaxy.js';
import { generateSystem, CITY_CHANCE } from '../src/universe/system.js';
import { makeTerrain } from '../src/terrain/terrainFn.js';
import { faceDir, dirToFace } from '../src/terrain/chunkBuilder.js';
import { buildCell } from '../src/planet/scatter.js';
import { cityPlan, cityGrid, CITY_CELL, LOTS, SINK, KIND_TOWER } from '../src/planet/city.js';

const CITY = { type: 'city', land: 0.2, cAmp: 1600, mAmp: 1400, hAmp: 120 };

/** 球面上にほぼ均等に count 個の方向を並べて fn(x, y, z) を呼ぶ。 */
function sphere(count, fn) {
  const g = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < count; i++) {
    const y = 1 - (2 * (i + 0.5)) / count, r = Math.sqrt(1 - y * y);
    fn(Math.cos(g * i) * r, y, Math.sin(g * i) * r);
  }
}

test('都市惑星: 一部の星系にだけあり、必ず哨戒隊に守られている。出発地にはない', () => {
  let systems = 0, cities = 0;
  for (const { star } of starsNear([5, 5, 5], 60)) {
    const sys = generateSystem(star);
    systems++;
    sys.planets.forEach((p, i) => {
      if (p.type !== 'city') return;
      cities++;
      assert(p.parent === null && p.terrain.type === 'city', `${p.name}: 衛星か地形の種類が違う`);
      assert(p.atmosphere && p.atmosphere.surfaceDensity >= 1, `${p.name}: 大気が薄い`);
      assert(sys.zones.some((z) => z.kind === 'planet' && z.planet === i), `${p.name}: 哨戒隊がいない`);
    });
  }
  const ratio = cities / systems;
  assert(ratio > CITY_CHANCE * 0.4 && ratio < CITY_CHANCE * 1.3, `都市惑星の割合 ${ratio.toFixed(3)}`);
  assert(!generateSystem(HOME_STAR).planets.some((p) => p.type === 'city'), '出発地に都市惑星がある');
});

test('都市惑星: 陸は街に覆われ、海には街がなく、色の α は街の濃さの半分', () => {
  const t = makeTerrain({ seed: 31, radius: 400e3, terrain: CITY });
  const out = [0, 0, 0, 0];
  let land = 0, urbanSum = 0, parks = 0, cores = 0, sea = 0;
  sphere(3000, (x, y, z) => {
    const h = t.height(x, y, z, 200);
    const u = t.urban(h, x, y, z);
    t.color(out, h, 1, x, y, z);
    if (h <= 0) {
      sea++;
      assert(u === 0, '海に街がある');
      return;
    }
    land++;
    urbanSum += u;
    if (u < 0.25) parks++;
    if (u > 0.7) cores++;
    assert(out[3] >= 0 && out[3] <= 0.5 + 1e-9, `α が範囲外: ${out[3]}`);
    near(out[3], u * 0.5, 1e-9, 'α');
  });
  assert(land > sea, `陸が少ない (陸 ${land}, 海 ${sea})`);
  assert(urbanSum / land > 0.45, `街が薄い: ${(urbanSum / land).toFixed(2)}`);
  assert(parks > land * 0.03 && cores > land * 0.1, `公園 ${parks}, 都心 ${cores} / ${land}`);
  // 都市でない天体の街の濃さは 0
  const terran = makeTerrain({ seed: 31, radius: 400e3 });
  assert(terran.urban(500, 0, 1, 0) === 0, '海洋惑星に街がある');
});

test('都市惑星: ビルの描画と当たり判定は同じ計画から作られ、一致する', () => {
  const R = 400e3;
  const terrain = makeTerrain({ seed: 31, radius: R, terrain: CITY });
  const plan = cityPlan(terrain);
  assert(cityPlan(terrain) === plan, '計画が使い回されていない');
  const { n, N } = cityGrid(R);
  assert(n === 2 ** Math.round(Math.log2((Math.PI / 2) * R / CITY_CELL)) && N === n * LOTS, '格子の大きさ');

  // ビルのある区画を探す (都心と郊外の両方)
  const f = [0, 0, 0];
  let blocks = 0, towers = 0, checked = 0, maxH = 0;
  sphere(400, (x, y, z) => {
    if (checked > 60) return;
    dirToFace(x, y, z, f);
    const ix = Math.floor(f[1] * n), iy = Math.floor(f[2] * n);
    const cell = buildCell(terrain, 2, f[0], ix, iy, n);
    const again = buildCell(terrain, 2, f[0], ix, iy, n);
    for (const kind in cell.lists) {
      const a = cell.lists[kind], b = again.lists[kind];
      assert(b && a.count === b.count && a.matrices.every((v, i) => v === b.matrices[i]), '同じ区画から違うビルができた');
      if (kind === '3') blocks += a.count; else towers += a.count;
      for (let i = 0; i < a.count; i++) {
        const m = a.matrices;
        const px = m[i * 16 + 12] + cell.center[0], py = m[i * 16 + 13] + cell.center[1], pz = m[i * 16 + 14] + cell.center[2];
        const r = Math.hypot(px, py, pz);
        const height = Math.hypot(m[i * 16 + 4], m[i * 16 + 5], m[i * 16 + 6]) - SINK; // Y 軸の長さ = 高さ + 埋めた深さ
        maxH = Math.max(maxH, height);
        // 底の中心の真上は屋上 (当たり判定) で、その高さは描いたビルの高さと同じ
        const roof = plan.roofAt(px / r, py / r, pz / r);
        near(R + roof, r + SINK + height, 0.5, '屋上の高さ');
        checked++;
      }
    }
  });
  assert(checked > 30, `ビルが少ない (${checked})`);
  assert(blocks > 0 && towers > 0, `低いビル ${blocks}, 塔 ${towers}`);
  assert(maxH > 120 && maxH < 700, `いちばん高いビル ${maxH.toFixed(0)} m`);

  // 道路 (敷地の縁) の上にはビルがない
  const d = [0, 0, 0];
  for (let k = 0; k < 200; k++) {
    const i = (k * 7919) % N, j = (k * 104729) % N;
    faceDir(k % 6, i / N + 1e-7, (j + 0.5) / N, d);
    assert(plan.roofAt(d[0], d[1], d[2]) === -Infinity, '道路の上にビルがある');
  }

  // 塔の上の段の外 (下の段の屋上) は低い
  let tiered = 0;
  for (let i = 0; i < N && tiered < 3; i += 97) {
    for (let j = 0; j < N && tiered < 3; j += 89) {
      const b = plan.lot(4, i, j);
      if (!b || b.kind !== KIND_TOWER) continue;
      const s = (i + b.cs + b.fw * 0.45) / N, t = (j + b.ct) / N;
      faceDir(4, s, t, d);
      near(plan.roofAt(d[0], d[1], d[2]), b.ground + b.height * 0.45, 1e-6, '下の段の屋上');
      tiered++;
    }
  }
  assert(tiered > 0, '塔が見つからない');
});

test('都市惑星: 公園の木はビルの中に生えない', () => {
  const R = 400e3;
  const terrain = makeTerrain({ seed: 31, radius: R, terrain: CITY });
  const plan = cityPlan(terrain);
  const n = 2 ** Math.round(Math.log2((Math.PI / 2) * R / 96));
  const f = [0, 0, 0];
  let trees = 0;
  sphere(3000, (x, y, z) => {
    if (trees > 50) return;
    const h = terrain.height(x, y, z, 100);
    if (terrain.forest(h, x, y, z) < 0.3) return;
    dirToFace(x, y, z, f);
    const cell = buildCell(terrain, 1, f[0], Math.floor(f[1] * n), Math.floor(f[2] * n), n);
    for (const list of Object.values(cell.lists)) {
      for (let i = 0; i < list.count; i++) {
        const px = list.matrices[i * 16 + 12] + cell.center[0];
        const py = list.matrices[i * 16 + 13] + cell.center[1];
        const pz = list.matrices[i * 16 + 14] + cell.center[2];
        const r = Math.hypot(px, py, pz);
        assert(plan.roofAt(px / r, py / r, pz / r) === -Infinity, '木がビルの中にある');
        trees++;
      }
    }
  });
  assert(trees > 20, `公園の木が少ない (${trees})`);
});
