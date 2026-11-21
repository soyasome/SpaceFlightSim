import { test, assert, near } from './harness.js';
import { starsNear, HOME_STAR } from '../src/universe/galaxy.js';
import { generateSystem, FRAME_EXIT } from '../src/universe/system.js';
import {
  swarmCoverage, swarmPanels, nearestPanel, SWARM_CHANCE, HIT_RADIUS,
} from '../src/universe/swarm.js';

/** 近くの星系から、スウォームのあるものを集める。 */
function swarmSystems() {
  const out = [];
  let total = 0;
  for (const { star } of starsNear([5, 5, 5], 60)) {
    total++;
    const sys = generateSystem(star);
    if (sys.swarm) out.push(sys);
  }
  return { out, total };
}

test('スウォーム: 一部の星系にだけあり、被覆率は星系を作らずに分かる。出発地にはない', () => {
  const { out, total } = swarmSystems();
  const ratio = out.length / total;
  assert(ratio > SWARM_CHANCE * 0.4 && ratio < SWARM_CHANCE * 1.4, `スウォームの割合 ${ratio.toFixed(3)}`);
  for (const sys of out) {
    near(swarmCoverage(sys.star), sys.swarm.coverage, 1e-12, '被覆率');
    assert(JSON.stringify(sys.swarm) === JSON.stringify(generateSystem(sys.star).swarm), '決定論的でない');
  }
  assert(swarmCoverage(HOME_STAR) === 0 && generateSystem(HOME_STAR).swarm === null, '出発地にスウォームがある');
});

test('スウォーム: いちばん内側の惑星より内側にあり、恒星や惑星の座標系に重ならない', () => {
  for (const sys of swarmSystems().out) {
    const sw = sys.swarm;
    const outer = Math.max(...sw.rings.map((r) => r.radius)) + sw.panel;
    const innerR = Math.min(...sw.rings.map((r) => r.radius)) - sw.panel;
    assert(innerR > sys.star.radius * 20, `${sys.star.name}: 恒星に近すぎる`);
    for (const p of sys.planets) {
      const r = Math.hypot(...p.position);
      assert(r - p.radius * FRAME_EXIT > outer, `${sys.star.name}: ${p.name} がスウォームに重なる`);
    }
    assert(sw.count > 2000 && sw.count < 30000, `パネルの数 ${sw.count}`);
  }
});

test('スウォーム: パネルの総面積はおよそ被覆率どおりで、パネルどうしは重ならない', () => {
  const sys = swarmSystems().out[0];
  const sw = sys.swarm;
  const panels = swarmPanels(sw);
  // 被覆率 = 全パネル (空きを含む) の面積 / 球の面積
  const area = 2.598 * sw.panel * sw.panel * sw.count;
  const cov = area / (4 * Math.PI * sw.radius * sw.radius);
  assert(Math.abs(cov - sw.coverage) < 0.1, `被覆率 ${cov.toFixed(2)} (定義 ${sw.coverage.toFixed(2)})`);
  // パネルは恒星から帯の半径の所にある
  let i = 0;
  for (const ring of sw.rings) {
    for (let k = 0; k < ring.lanes * ring.perLane; k++, i++) {
      near(Math.hypot(panels.pos[i * 3], panels.pos[i * 3 + 1], panels.pos[i * 3 + 2]), ring.radius, 1, '帯の半径');
    }
  }
  // 同じ帯の中で、パネルの中心どうしはパネルの直径より離れている (抜き取りで調べる)
  const ring = sw.rings[0];
  const n = ring.lanes * ring.perLane;
  let min = Infinity;
  for (let a = 0; a < n; a += 7) {
    for (let b = 0; b < n; b++) {
      if (a === b) continue;
      const d = Math.hypot(panels.pos[a * 3] - panels.pos[b * 3], panels.pos[a * 3 + 1] - panels.pos[b * 3 + 1],
        panels.pos[a * 3 + 2] - panels.pos[b * 3 + 2]);
      min = Math.min(min, d);
    }
  }
  assert(min > sw.panel * 1.7, `パネルが近すぎる: ${(min / sw.panel).toFixed(2)} × 半径`);
  assert(panels.present.some((v) => v === 0) && panels.present.filter((v) => v).length > sw.count * 0.7, '建設中の空き');
});

test('スウォーム: いちばん近いパネルの検索は総当たりと一致し、面からの距離が分かる', () => {
  const sys = swarmSystems().out[1];
  const sw = sys.swarm;
  const panels = swarmPanels(sw);
  let checked = 0;
  for (let i = 0; i < sw.count && checked < 40; i += 211) {
    if (!panels.present[i]) continue;
    const cx = panels.pos[i * 3], cy = panels.pos[i * 3 + 1], cz = panels.pos[i * 3 + 2];
    const r = Math.hypot(cx, cy, cz);
    // パネルの表 (恒星の側) に少し浮いた点と、面に沿って少しずれた点
    for (const [up, side] of [[2000e3, 0], [-500e3, 0.3], [30e3, 0.5]]) {
      const t = [panels.tan[i * 3], panels.tan[i * 3 + 1], panels.tan[i * 3 + 2]];
      const x = cx * (1 - up / r) + t[0] * side * sw.panel;
      const y = cy * (1 - up / r) + t[1] * side * sw.panel;
      const z = cz * (1 - up / r) + t[2] * side * sw.panel;
      const hit = nearestPanel(sw, panels, x, y, z);
      let best = -1, bestD = Infinity;
      for (let k = 0; k < sw.count; k++) {
        if (!panels.present[k]) continue;
        const d = Math.hypot(x - panels.pos[k * 3], y - panels.pos[k * 3 + 1], z - panels.pos[k * 3 + 2]);
        if (d < bestD) { bestD = d; best = k; }
      }
      assert(hit && hit.index === best, `検索結果が総当たりと違う (${hit && hit.index} / ${best})`);
      if (best === i) {
        near(hit.normal, up, 20, '面からの距離'); // 板は平らなので、横にずらすと球面より少し離れる
        assert(hit.lateral < sw.panel * HIT_RADIUS, 'パネルの外側と判定された');
        near(hit.surface, Math.max(0, Math.abs(up) - sw.thickness / 2), 20, '表面までの距離');
      }
      checked++;
    }
  }
  assert(checked > 20, `調べた数 ${checked}`);
});
