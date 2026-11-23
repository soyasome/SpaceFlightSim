// 本物の地球と月の下ごしらえ (docs/design-earth-moon.md)。本物のマップの代わりに、作り物の小さなマップで確かめる
import { test, assert, near } from './harness.js';
import { Vector3, Quaternion } from 'three';
import { geoToLocal, localToGeo, geoToLocalRad, localToGeoRad } from '../src/terrain/geo.js';
import {
  makeMap, parseMap, registerMap, unregisterMap, markMapFailed, requireMap, usableTerrain, mapNamesOf,
} from '../src/terrain/maps.js';
import { makeTerrain } from '../src/terrain/terrainFn.js';
import { generateSystem } from '../src/universe/system.js';
import { HOME_STAR } from '../src/universe/galaxy.js';
import { Planet } from '../src/planet/planet.js';
import { makeAtmosphereUniforms, cloudDefines } from '../src/planet/atmosphere.js';

const DEG = Math.PI / 180;

/** 緯度経度 (rad) の関数 f から、画素の中心で値を取った作り物のマップを作る。 */
function mapFrom(name, w, h, f, Type = Float32Array, opts) {
  const data = new Type(w * h);
  for (let j = 0; j < h; j++) {
    const lat = Math.PI / 2 - ((j + 0.5) / h) * Math.PI;
    for (let i = 0; i < w; i++) {
      const lon = -Math.PI + ((i + 0.5) / w) * 2 * Math.PI;
      data[j * w + i] = f(lat, lon);
    }
  }
  return makeMap(name, w, h, data, opts);
}

/** 自転だけを planet.js の updateRotation で計算する (Planet を丸ごと作ると地形の Worker まで動くため)。 */
function spinner(def) {
  const p = {
    tilt: new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), def.axialTilt),
    omega: def.tidalLock ? 0 : (2 * Math.PI) / def.rotationPeriod,
    rotationPhase: def.rotationPhase ?? 0,
    quat: new Quaternion(),
  };
  p.at = (t) => {
    Planet.prototype.updateRotation.call(p, t);
    return p.quat;
  };
  return p;
}

test('緯度経度: geoToLocal と localToGeo は互いに逆で、東経 90° は −Z、北極は +Y', () => {
  for (const [lat, lon] of [[0, 0], [35.7, 139.7], [-33.9, 151.2], [64.1, -21.9], [-80, 179.5], [10, -179.5]]) {
    const v = geoToLocal(lat, lon);
    near(Math.hypot(...v), 1, 1e-12, '長さ');
    const g = localToGeo(...v);
    near(g.lat, lat, 1e-9, '緯度');
    near(g.lon, lon, 1e-9, '経度');
  }
  const east = geoToLocal(0, 90);
  near(east[0], 0, 1e-12, 'x'); near(east[2], -1, 1e-12, '東経 90° は −Z');
  near(geoToLocal(90, 0)[1], 1, 1e-12, '北極は +Y');
  // 経度 ±180° の両側は同じ場所
  const a = geoToLocalRad(0.3, Math.PI - 1e-9), b = geoToLocalRad(0.3, -Math.PI + 1e-9);
  assert(Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) < 1e-8, '経度の継ぎ目で離れている');
  near(localToGeoRad(2, 0, 0).lat, 0, 1e-12, '長さによらない');
});

test('自転: 時間が進むと太陽の真下の経度が減る (太陽が東から昇り西へ沈む)', () => {
  const sys = generateSystem(HOME_STAR);
  const terra = spinner(sys.planets[0]);
  const sunWorld = new Vector3(1, 0.2, -0.4).normalize(); // 世界から見た太陽の向き (動かない)
  const subsolarLon = (t) => {
    const s = sunWorld.clone().applyQuaternion(terra.at(t).clone().invert());
    return localToGeoRad(s.x, s.y, s.z).lon;
  };
  let prev = subsolarLon(0);
  for (let i = 1; i <= 10; i++) {
    const lon = subsolarLon(i * 60);
    let d = lon - prev;
    d -= Math.round(d / (2 * Math.PI)) * 2 * Math.PI;
    assert(d < 0, `太陽の真下の経度が増えた (${(d / DEG).toFixed(3)}°)`);
    prev = lon;
  }
});

test('マップ: 画素の中心では値がそのまま出て、経度の継ぎ目と縮小版がつながっている', () => {
  const f = (lat, lon) => 1000 * Math.sin(lat) + 300 * Math.cos(lon) + 50 * Math.sin(3 * lon);
  const m = mapFrom('t-smooth', 64, 32, f);
  for (const [i, j] of [[0, 0], [5, 7], [63, 31], [31, 16]]) {
    const lat = Math.PI / 2 - ((j + 0.5) / 32) * Math.PI, lon = -Math.PI + ((i + 0.5) / 64) * 2 * Math.PI;
    const v = f(lat, lon);
    near(m.nearest(lat, lon), v, 1e-3, '最も近い画素');
    near(m.linear(lat, lon), v, 1e-3, '直線補間');
    near(m.cubic(lat, lon), v, 1e-3, '双三次補間');
  }
  // 継ぎ目の両側
  near(m.cubic(0.2, Math.PI - 1e-7), m.cubic(0.2, -Math.PI + 1e-7), 1e-2, '経度の継ぎ目');
  // 滑らかな関数なら、画素の間でもおよそ元の値になる
  let worst = 0;
  for (let k = 0; k < 200; k++) {
    const lat = (Math.random() - 0.5) * 2.6, lon = (Math.random() - 0.5) * 2 * Math.PI;
    worst = Math.max(worst, Math.abs(m.cubic(lat, lon) - f(lat, lon)));
  }
  assert(worst < 40, `双三次補間の誤差が大きい: ${worst.toFixed(1)}`);
  // 縮小版は 2×2 の平均
  const L0 = m.levels[0], L1 = m.levels[1];
  near(L1.data[0], (L0.data[0] + L0.data[1] + L0.data[64] + L0.data[65]) / 4, 1e-3, '縮小版');
  assert(m.levelFor(0) === 0 && m.levelFor(m.pixelAngle * 4.5) === 2, '細かさに合う縮小版');
});

test('マップ: ファイルの形 (見出し + 画素) を読める', () => {
  const w = 16, h = 8;
  const buf = new ArrayBuffer(32 + w * h * 2);
  const dv = new DataView(buf);
  'SFMP'.split('').forEach((c, i) => dv.setUint8(i, c.charCodeAt(0)));
  dv.setUint16(4, 1, true); dv.setUint16(6, 1, true);
  dv.setUint32(8, w, true); dv.setUint32(12, h, true);
  dv.setFloat32(16, 2, true); dv.setFloat32(20, -100, true);
  for (let k = 0; k < w * h; k++) dv.setInt16(32 + k * 2, k - 50, true);
  const m = parseMap('t-file', buf);
  assert(m.width === w && m.height === h, '大きさ');
  // 左上の画素 (北西の端) の値 = (0 − 50) × 2 − 100
  near(m.nearest(Math.PI / 2 - 0.5 * (Math.PI / h), -Math.PI + 0.5 * (2 * Math.PI / w)), -200, 1e-6, '倍率と足す値');
});

// 作り物の大陸: 東半球の中緯度に高さ 3,000 m の陸、ほかは深さ 3,000 m の海
const continent = (lat, lon) => 3000 * Math.tanh(4 * (Math.cos(lat - 0.5) * Math.cos(lon - 1) - 0.6));

test('地形: 標高はマップの値に細かい模様を足したもので、細かい模様は大きな形を変えない', () => {
  registerMap(mapFrom('t-height', 256, 128, continent));
  const R = 400e3;
  const def = { seed: 7, radius: R, terrain: { type: 'terran', maps: { height: 't-height' } } };
  const t = makeTerrain(def);
  const m = requireMap('t-height');
  const cut = 2 * m.pixelAngle * R;
  let diff = 0, lod = 0, count = 0, worst = 0;
  for (let k = 0; k < 400; k++) {
    const lat = Math.asin(Math.random() * 2 - 1), lon = (Math.random() - 0.5) * 2 * Math.PI;
    const [x, y, z] = geoToLocalRad(lat, lon);
    // 粗いメッシュでも、マップより細かい丘 (波長 約 9 km) の最初のオクターブだけは残る (起伏の高さ 320 m の 1.4 倍まで)
    const coarse = t.height(x, y, z, cut) - m.cubic(lat, lon, cut / R);
    assert(Math.abs(coarse) < 500, `粗い細かさで、マップとの差が大きい: ${coarse.toFixed(0)} m`);
    const fine = t.height(x, y, z, 1);
    if (m.cubic(lat, lon) <= 0) near(fine, m.cubic(lat, lon), 1e-6, '海底には細かい模様を足さない');
    const d = Math.abs(fine - m.cubic(lat, lon));
    diff += d; worst = Math.max(worst, d);
    lod += Math.abs(fine - t.height(x, y, z, 2000));
    count++;
  }
  assert(diff / count < 150, `細かい模様が大きい: 平均 ${(diff / count).toFixed(0)} m`);
  assert(worst < 1500, `細かい模様が大きい: 最大 ${worst.toFixed(0)} m`);
  assert(lod / count < 150, `細部を省くと形が変わる: ${(lod / count).toFixed(0)} m`);
  // 倍率 (細かい模様を足さない海底で確かめる)
  const half = makeTerrain({ ...def, terrain: { ...def.terrain, heightScale: 0.5 } });
  const [x, y, z] = geoToLocalRad(-1, -2);
  assert(m.cubic(-1, -2) < 0, '海底でない');
  near(half.height(x, y, z, 1), t.height(x, y, z, 1) * 0.5, 1e-6, 'heightScale');
  unregisterMap('t-height');
});

test('地形: 実寸 (半径 16 倍・細かさ 16 倍) でも、同じ地点の標高はマップの値のまわりに収まる', () => {
  // どこも標高 200 m の低地 (山脈の尾根は足されない)。足されるのは m 単位の大きさを保った丘と細かい起伏だけ
  registerMap(mapFrom('t-low', 512, 256, () => 200));
  const terrain = { type: 'terran', maps: { height: 't-low' } };
  const game = makeTerrain({ seed: 7, radius: 400e3, terrain });
  const real = makeTerrain({ seed: 7, radius: 6400e3, detailScale: 16, terrain });
  let sg = 0, sr = 0;
  for (let k = 0; k < 300; k++) {
    const [x, y, z] = geoToLocalRad(Math.asin(Math.random() * 2 - 1), (Math.random() - 0.5) * 2 * Math.PI);
    const g = game.height(x, y, z, 1) - 200, r = real.height(x, y, z, 1) - 200;
    assert(Math.abs(g) < 250 && Math.abs(r) < 250, `マップとの差が大きい: ${g.toFixed(0)} / ${r.toFixed(0)} m`);
    sg += Math.abs(g); sr += Math.abs(r);
  }
  // 丘の大きさ (m) は縮尺によらず同じなので、起伏の大きさも同じくらい
  assert(sr / sg > 0.6 && sr / sg < 1.6, `縮尺で起伏の大きさが変わる: ${(sg / 300).toFixed(0)} / ${(sr / 300).toFixed(0)} m`);
  unregisterMap('t-low');
});

test('地形: 土地被覆で地表の色と木が決まり、明るさのマップで月の海が暗くなる', () => {
  registerMap(mapFrom('t-land', 128, 64, () => 500)); // どこも標高 500 m の陸
  // 北半球は砂漠 (16)、南半球は熱帯の森 (2)
  registerMap(mapFrom('t-cover', 128, 64, (lat) => (lat > 0 ? 16 : 2), Uint8Array, { mips: false }));
  const t = makeTerrain({ seed: 3, radius: 400e3, terrain: { type: 'terran', maps: { height: 't-land', cover: 't-cover' } } });
  const c = [0, 0, 0, 0];
  const north = geoToLocal(20, 30), south = geoToLocal(-20, 30);
  const hN = t.height(...north, 1), hS = t.height(...south, 1);
  t.color(c, hN, 0.98, ...north);
  assert(c[0] > c[1] && c[1] > c[2] && c[0] > 0.4, `砂漠の色でない: ${c.map((v) => v.toFixed(2))}`);
  t.color(c, hS, 0.98, ...south);
  assert(c[1] > c[0] && c[1] < 0.3, `森の色でない: ${c.map((v) => v.toFixed(2))}`);
  assert(t.forest(hN, ...north) === 0, '砂漠に木が生える');
  assert(t.forest(hS, ...south) > 0.5, '熱帯の森に木が少ない');
  unregisterMap('t-cover');

  // 月: 東半球が暗い海 (明るさ 0.1)、西半球が明るい高地 (0.9)
  registerMap(mapFrom('t-albedo', 128, 64, (lat, lon) => (lon > 0 ? 0.1 : 0.9)));
  const moon = makeTerrain({ seed: 5, radius: 110e3, terrain: { type: 'rock', maps: { height: 't-land', albedo: 't-albedo' } } });
  const mare = geoToLocal(10, 90), high = geoToLocal(10, -90);
  moon.color(c, moon.height(...mare, 1), 0.98, ...mare);
  const dark = c[0];
  moon.color(c, moon.height(...high, 1), 0.98, ...high);
  assert(c[0] > dark * 2, `海が高地より暗くない: ${dark.toFixed(2)} / ${c[0].toFixed(2)}`);
  unregisterMap('t-land');
  unregisterMap('t-albedo');
});

test('地形: マップを読み込んでいなければ例外、読み込めなかったマップは外して今のノイズの地形になる', () => {
  const terrain = { type: 'terran', maps: { height: 't-missing' }, heightScale: 1 };
  let threw = false;
  try { makeTerrain({ seed: 2024, radius: 400e3, terrain }); } catch { threw = true; }
  assert(threw, '読み込んでいないのに作れてしまう');
  assert(usableTerrain(terrain) === terrain, 'まだ失敗していないのに外した');
  markMapFailed('t-missing');
  const plain = usableTerrain(terrain);
  assert(!plain.maps && mapNamesOf(plain).length === 0, 'マップの名前が残っている');
  const a = makeTerrain({ seed: 2024, radius: 400e3, terrain: plain });
  const b = makeTerrain({ seed: 2024, radius: 400e3, terrain: { type: 'terran' } });
  const [x, y, z] = geoToLocal(12, 34);
  near(a.height(x, y, z, 1), b.height(x, y, z, 1), 1e-9, 'ノイズの地形と同じ');
  unregisterMap('t-missing');
});

test('潮汐ロック: LUNA はどの時刻でも表側 (緯度 0°・経度 0°) を TERRA に向けている (両方の縮尺)', () => {
  for (const scale of ['game', 'real']) {
    const sys = generateSystem(HOME_STAR, { scale });
    const terra = sys.planets[0], luna = sys.planets.find((p) => p.name === 'LUNA');
    assert(luna.tidalLock, `${scale}: 潮汐ロックでない`);
    const toTerra = new Vector3(...terra.position).sub(new Vector3(...luna.position)).normalize();
    const s = spinner(luna);
    for (const t of [0, 3600, 1e6]) {
      const front = new Vector3(...geoToLocal(0, 0)).applyQuaternion(s.at(t));
      assert(front.dot(toTerra) > 0.999999, `${scale}: 時刻 ${t} で表側が TERRA を向いていない (${front.dot(toTerra)})`);
    }
  }
});

test('雲: TERRA だけが雲の層を持ち、実寸ではオクターブを足していちばん小さな雲の大きさを保つ', () => {
  for (const scale of ['game', 'real']) {
    const sys = generateSystem(HOME_STAR, { scale });
    const withClouds = sys.planets.filter((p) => p.clouds).map((p) => p.name);
    assert(JSON.stringify(withClouds) === '["TERRA"]', `${scale}: 雲のある天体 ${withClouds}`);
    const terra = sys.planets[0];
    const u = makeAtmosphereUniforms(terra);
    near(u.uCloudR.value, terra.radius + terra.clouds.altitude, 1e-6, '雲の層の半径');
    assert(u.uCloudOct.value === (scale === 'real' ? 11 : 7), `${scale}: オクターブ ${u.uCloudOct.value}`);
    assert(cloudDefines(u).CLOUDS === 1, 'CLOUDS が付かない');
  }
  const mars = generateSystem(HOME_STAR).planets.find((p) => p.name === 'MARS');
  const u = makeAtmosphereUniforms(mars);
  assert(!u.uCloudR && !cloudDefines(u).CLOUDS, '雲のない天体に雲の uniform がある');
});
