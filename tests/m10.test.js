import { test, assert, near } from './harness.js';
import { starsNear, HOME_STAR, AU } from '../src/universe/galaxy.js';
import { generateSystem, FRAME_EXIT } from '../src/universe/system.js';
import { HABITAT, hullContact, lagrangePoint } from '../src/universe/habitat.js';

const dist3 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

test('オニール・シリンダー: SOL では TERRA の L5 に2本1組で、軸は恒星を向く', () => {
  const sys = generateSystem(HOME_STAR);
  const terra = sys.planets[0];
  const hs = sys.habitats;
  assert(hs.length === 2 && hs[0].name === 'INSULA I' && hs[1].name === 'INSULA II', '名前と数');
  const center = hs[0].pair.center;
  // L5 = TERRA と同じ距離で、恒星から見て 60° 離れた所
  near(Math.hypot(...center), Math.hypot(...terra.position), 1, '恒星からの距離');
  const cos = dot(center, terra.position) / (Math.hypot(...center) * Math.hypot(...terra.position));
  near(Math.acos(cos), Math.PI / 3, 1e-9, 'TERRA との角度');
  near(dist3(center, lagrangePoint(terra.position, -60)), 0, 1e-3, 'L5 の位置');
  for (const h of hs) {
    // 軸は恒星を向き、もう1本の方 (side) と直交する
    const toStar = h.position.map((v) => -v / Math.hypot(...h.position));
    assert(dot(h.axis, toStar) > 0.999999, '軸が恒星を向いていない');
    near(dot(h.axis, h.side), 0, 1e-12, '軸と横の向きが直交しない');
    near(h.radius, HABITAT.radius, 0, '半径');
    near(h.length, HABITAT.length, 0, '長さ');
  }
  near(dist3(hs[0].position, hs[1].position), HABITAT.gap * 2 * HABITAT.radius, 1e-3, '2本の間隔');
  // side は互いにもう1本の方を向く
  const d = hs[1].position.map((v, i) => v - hs[0].position[i]);
  assert(dot(d, hs[0].side) > 0 && dot(d, hs[1].side) < 0, 'side の向き');
  assert(hs[0].spin === 1 && hs[1].spin === -1, '逆向きに回らない');
  // 開始位置から約1天文単位 (巡航で行ける)
  const fromStart = dist3(center, sys.start) / AU;
  assert(fromStart > 0.8 && fromStart < 1.3, `開始位置からの距離 ${fromStart.toFixed(2)} AU`);
});

test('オニール・シリンダー: 都市惑星のある星系にだけあり、惑星の座標系に重ならない', () => {
  let withCity = 0;
  for (const { star } of starsNear([5, 5, 5], 60)) {
    if (star.home) continue; // SOL は都市惑星なしで INSULA がある (別のテスト)
    const sys = generateSystem(star);
    const city = sys.planets.find((p) => p.type === 'city');
    if (!city) {
      assert(sys.habitats.length === 0, `${star.name}: 都市惑星がないのにシリンダーがある`);
      continue;
    }
    withCity++;
    assert(sys.habitats.length === 2, `${star.name}: シリンダーの数 ${sys.habitats.length}`);
    const c = sys.habitats[0].pair.center;
    near(Math.hypot(...c), Math.hypot(...city.position), 1, '都市惑星と同じ軌道');
    for (const h of sys.habitats) {
      assert(h.name.startsWith(city.name), `${h.name}: 名前`);
      for (const p of sys.planets) {
        assert(dist3(p.position, h.position) > p.radius * FRAME_EXIT + h.length, `${h.name} が ${p.name} に近すぎる`);
      }
    }
    assert(JSON.stringify(sys.habitats) === JSON.stringify(generateSystem(star).habitats), '決定論的でない');
  }
  assert(withCity > 10, `都市惑星のある星系が少ない (${withCity})`);
});

test('オニール・シリンダー: 外壁の当たり判定は、近い面から外へ押し出す', () => {
  const def = { radius: 4000, length: 32000, hull: 60 };
  const R = 4060, H = 16000;
  // 外
  let c = hullContact(def, R + 500, 0, 0);
  assert(!c.inside, '外なのに中');
  near(c.distance, 500, 1e-9, '側面までの距離');
  c = hullContact(def, 0, H + 300, 0);
  near(c.distance, 300, 1e-9, '蓋までの距離');
  c = hullContact(def, R + 300, H + 400, 0);
  near(c.distance, 500, 1e-9, '角までの距離');
  // 側面の少し内側: 軸から外向きに押し出す
  c = hullContact(def, 0, 1000, -(R - 3));
  assert(c.inside, '中なのに外');
  near(c.depth, 3, 1e-9, '側面の深さ');
  near(c.normal[2], -1, 1e-12, '側面の向き');
  // 蓋の少し内側: 軸の向きに押し出す
  c = hullContact(def, 100, -(H - 5), 200);
  assert(c.inside && c.normal[1] === -1, '蓋の向き');
  near(c.depth, 5, 1e-9, '蓋の深さ');
});
